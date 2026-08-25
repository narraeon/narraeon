import { expect, test } from "vitest";

import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import { settingAuthorContractExamples } from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";

test("slot 多带参数时报出参数名而不是 kind，避免作者去删整个 slot", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame(
      "  - slot: { kind: document, document: character.qinlong, maxEntries: 4 }",
    ),
  });

  expect(messages).toContain(
    "slot document 不接受参数 maxEntries；它只接受 kind、document、required",
  );
  // 旧消息把 kind 当成问题所在，读起来像是这个 slot 不存在。
  expect(messages.join("\n")).not.toContain("未知 slot 或参数：document");
});

// 自检存在的意义是预测真实 Prompt Preview。history_message 曾经只在这里合法，
// 于是候选能通过自检，却在它本该预测的编译步骤失败。
test("自检拒绝提示编译器不支持的 history_message slot", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame(
      '  - slot: { kind: history_message, message: "m-1" }',
    ),
  });

  expect(messages.join("\n")).toContain(
    "世界框架包含未知 slot kind：history_message",
  );
});

test("真正未知的 kind 会被列出可用取值", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame("  - slot: { kind: 随便写的 }"),
  });

  expect(messages.join("\n")).toContain("世界框架包含未知 slot kind：随便写的");
  expect(messages.join("\n")).toContain("catalog");
});

test("玩家视图逐条指出哪个视图、哪个条目、哪里不对", () => {
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: relations
    title: 人物关系
    extra: 不该有的字段
    items:
      - id: no-label
        select: { document: character.qinlong }
      - id: wrong-codec
        label: 修炼规则
        select:
          document: rule.cultivation
          locator: { yaml: [境界] }
`,
  });

  expect(messages).toContain("第 1 个视图不接受字段 extra");
  expect(messages).toContain("视图 relations 的第 1 个条目缺少字符串 label");
  expect(messages).toContain(
    "视图 relations 的第 2 个条目对 markdown 文档 rule.cultivation 使用了 yaml locator",
  );
});

test("指向不存在文档的选择器不再被说成必须存在文档", () => {
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: ghost
    title: 幽灵
    items:
      - id: missing
        label: 不存在的文档
        select: { document: character.nobody, locator: { yaml: [状态] } }
`,
  });

  // 实现对不存在的文档是放行的，诊断不该反过来指责作者。
  expect(messages.filter((line) => line.includes("幽灵"))).toEqual([]);
  expect(messages.join("\n")).not.toContain("存在文档");
});

test("问题过多时截断并说明还有多少处未列出", () => {
  const items = Array.from(
    { length: 12 },
    (_, index) =>
      `      - id: item-${String(index)}\n        label: 缺少 select`,
  ).join("\n");
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: many
    title: 很多问题
    items:
${items}
`,
  });

  expect(
    messages.filter((line) => line.includes("缺少 select 对象")),
  ).toHaveLength(8);
  expect(messages.join("\n")).toContain("另有 4 处玩家视图问题未列出");
});

// 提示编译器一直用 @短引用 或 id 解析 slot 的 document，而作者只见得到短引用。
// 自检层曾经只认 id，把能正常编译运行的 frame 判成错误。
test("frame 用 @短引用 指向文档，与提示编译器一致", () => {
  expect(
    controlIssues({
      "control/frame.yaml": `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
  - slot: { kind: document, document: "@cultivation" }
  - slot: { kind: node, document: "@qinlong", locator: { yaml: [关系] } }
`,
    }),
  ).toEqual([]);
});

test("@ 是 YAML 保留字符，漏引号的短引用整份文件都不安全", () => {
  const messages = inspectContentPackageCurrentTree(
    baseFiles().map((file) =>
      file.path === "control/frame.yaml"
        ? {
            ...file,
            contents: frame(
              "  - slot: { kind: document, document: @cultivation }",
            ),
          }
        : file,
    ),
  ).issues.map(({ code }) => code);

  expect(messages).toContain("unsafe_yaml");
});

// 作者只能从契约范例学会这两份控制文件的形状；范例一旦偏离校验器，
// 作者就会照着写出自检必然拒绝的候选。
test("作者契约给出的 frame 与玩家视图范例本身通过校验", () => {
  expect(
    controlIssues({
      "control/frame.yaml": settingAuthorContractExamples.frame,
      "control/player-views.yaml": settingAuthorContractExamples.playerViews,
    }),
  ).toEqual([]);
  expect(
    controlIssues({
      "control/player-views.yaml":
        settingAuthorContractExamples.emptyPlayerViews,
    }),
  ).toEqual([]);
});

function controlIssues(overrides: Record<string, string>): string[] {
  const files = baseFiles().map((file) => {
    const override = overrides[file.path];
    return override === undefined ? file : { ...file, contents: override };
  });
  return inspectContentPackageCurrentTree(files)
    .issues.filter(
      ({ code }) =>
        code === "invalid_player_view" || code === "invalid_world_frame",
    )
    .map(({ message }) => message);
}

function frame(slot: string): string {
  return `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
${slot}
`;
}

function baseFiles() {
  return [
    { path: "opening.md", contents: "宿舍门在你面前合上。\n" },
    {
      path: "world/characters/qinlong.yaml",
      contents: `$document:\n  id: character.qinlong\n  ref: qinlong\n  title: 秦龙\n  summary: 篮球队前锋。\n  aliases: []\n关系: {}\n`,
    },
    {
      path: "world/rules/cultivation.md",
      contents: `---\n$document:\n  id: rule.cultivation\n  ref: cultivation\n  title: 修炼规则\n  summary: 自然语言规则。\n  aliases: []\n---\n# 修炼规则\n\n境界由故事解释。\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 宿舍中的局面。\n  aliases: []\n人物:\n  - $ref: character.qinlong\n`,
    },
    { path: "control/frame.yaml", contents: frame("") },
    {
      path: "control/blocks/world.md",
      contents: "# 世界主持规则\n\n持续结果写回自然所有者。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews: []\n`,
    },
  ];
}
