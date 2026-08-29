import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  PlayerViewRenderer,
  type PlayerViewRenderInput,
} from "../../src/runtime/world/PlayerViewRenderer.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

function worldState(): Record<string, string> {
  return {
    "characters/alex.yaml": `$document:
  id: character.alex
  ref: alex
  title: Alex
  summary: 篮球队前锋。
  aliases: []
衣着: 白色背心
关系:
  Jordan:
    好感: 75
    标签: [队友, 室友]
装备:
  - 名称: 球鞋
    主人: { $ref: character.alex }
未展示: 不应被局部 selector 猜测加入
`,
    "rules/cultivation.md": `---
$document:
  id: rule.cultivation
  ref: cultivation
  title: 修炼
  summary: 修炼规则。
  aliases: []
---
# 修炼

## 金丹

金丹之后才可尝试元婴。
`,
  };
}

function playerViewControl(): string {
  return `format: narraeon.player-views/v1
views:
  - id: status
    title: 当前状态
    items:
      - id: whole-character
        label: Alex
        select: { document: character.alex }
      - id: clothes
        label: 衣着
        select: { document: character.alex, locator: { yaml: [衣着] } }
      - id: relations
        label: 关系
        select: { document: character.alex, locator: { yaml: [关系] } }
      - id: equipment
        label: 装备
        select: { document: character.alex, locator: { yaml: [装备] } }
      - id: rule
        label: 金丹
        select: { document: rule.cultivation, locator: { markdown: [金丹] } }
      - id: whole-rule
        label: 修炼规则
        select: { document: rule.cultivation, locator: { markdown: [] } }
`;
}

function input(
  options: { state?: Record<string, string>; control?: string } = {},
): PlayerViewRenderInput {
  const state = options.state ?? worldState();
  return {
    snapshot: WorldDocumentStore.open({
      layout: "world_state",
      files: Object.entries(state).map(([path, contents]) => ({
        path: `state/${path}`,
        contents,
      })),
    }),
    control: options.control ?? playerViewControl(),
  };
}

describe("玩家视图读取当前文件树", () => {
  test("从快照显示整文档、scalar、完整容器和 Markdown 子树，引用只显示链接", () => {
    const result = new PlayerViewRenderer().render(input());

    expect(result.diagnostics).toEqual([]);
    expect(result.views[0]?.items.map(({ value }) => value)).toEqual([
      {
        衣着: "白色背心",
        关系: { Jordan: { 好感: 75, 标签: ["队友", "室友"] } },
        装备: [
          {
            名称: "球鞋",
            主人: {
              $ref: "character.alex",
              title: "Alex",
              ref: "alex",
            },
          },
        ],
        未展示: "不应被局部 selector 猜测加入",
      },
      "白色背心",
      { Jordan: { 好感: 75, 标签: ["队友", "室友"] } },
      [
        {
          名称: "球鞋",
          主人: { $ref: "character.alex", title: "Alex", ref: "alex" },
        },
      ],
      "## 金丹\n\n金丹之后才可尝试元婴。",
      "# 修炼\n\n## 金丹\n\n金丹之后才可尝试元婴。",
    ]);
  });

  // Runtime assigns random document identities while authors see only short
  // @references. The prompt compiler accepts them, and player views must too.
  test("select.document 接受 @短引用，与提示编译器一致", () => {
    const result = new PlayerViewRenderer().render(
      input({
        control: `format: narraeon.player-views/v1
views:
  - id: status
    title: 状态
    items:
      - id: clothes
        label: 衣着
        select: { document: "@alex", locator: { yaml: [衣着] } }
      - id: jindan
        label: 金丹
        select: { document: "@cultivation", locator: { markdown: [金丹] } }
`,
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.views[0]?.items.map(({ value }) => value)).toEqual([
      "白色背心",
      "## 金丹\n\n金丹之后才可尝试元婴。",
    ]);
  });

  test("指向不存在的短引用报出作者写下的原文，而不是内部身份", () => {
    const result = new PlayerViewRenderer().render(
      input({
        control: `format: narraeon.player-views/v1
views:
  - id: status
    title: 状态
    items:
      - id: ghost
        label: 幽灵
        select: { document: "@nobody", locator: { yaml: [衣着] } }
`,
      }),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "unresolved_selector",
        message: "Document not found: @nobody",
      }),
    ]);
  });

  test("容器动态子节点自然出现，失效 selector 明确诊断且不阻断其他项", () => {
    const state = worldState();
    state["characters/alex.yaml"] = state["characters/alex.yaml"]!.replace(
      "    标签: [队友, 室友]",
      "    标签: [队友, 室友]\n    最近承诺: 晚上训练",
    ).replace("衣着: 白色背心", "服装: 白色背心");
    const result = new PlayerViewRenderer().render(input({ state }));

    const relations = result.views[0]?.items.find(
      ({ id }) => id === "relations",
    )?.value;
    expect(relations).toMatchObject({
      Jordan: { 最近承诺: "晚上训练" },
    });
    expect(relations).not.toHaveProperty("服装");
    expect(relations).not.toHaveProperty("未展示");
    expect(result.views[0]?.items.some(({ id }) => id === "clothes")).toBe(
      false,
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "unresolved_selector",
        itemId: "clothes",
      }),
    ]);
  });

  test("沿用快照的 Markdown 标题语义并忽略 fenced code 中的伪标题", () => {
    const state = worldState();
    state["rules/cultivation.md"] = state["rules/cultivation.md"]!.replace(
      "金丹之后才可尝试元婴。",
      "金丹之后才可尝试元婴。\n\n## Ａrcane\n\n全角标题仍可精确选择。\n\n```md\n## 伪标题\n```",
    );
    const control = `format: narraeon.player-views/v1
views:
  - id: rules
    title: 规则
    items:
      - id: normalized
        label: Arcane
        select: { document: rule.cultivation, locator: { markdown: [Arcane] } }
      - id: fenced
        label: 伪标题
        select: { document: rule.cultivation, locator: { markdown: [伪标题] } }
`;

    const result = new PlayerViewRenderer().render(input({ state, control }));

    expect(result.views[0]?.items).toEqual([
      {
        id: "normalized",
        label: "Arcane",
        value: "## Ａrcane\n\n全角标题仍可精确选择。\n\n```md\n## 伪标题\n```",
      },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "unresolved_selector",
        itemId: "fenced",
      }),
    ]);
  });

  test("整份 Markdown 在 trim 后再计算玩家视图容量", () => {
    const state = worldState();
    state["rules/cultivation.md"] =
      `${state["rules/cultivation.md"]!}${" ".repeat(70 * 1024)}`;
    const control = `format: narraeon.player-views/v1
views:
  - id: status
    title: 当前状态
    items:
      - id: whole-rule
        label: 修炼规则
        select: { document: rule.cultivation, locator: { markdown: [] } }
      - id: clothes
        label: 衣着
        select: { document: character.alex, locator: { yaml: [衣着] } }
`;

    const result = new PlayerViewRenderer().render(input({ state, control }));

    expect(result.diagnostics).toEqual([]);
    expect(result.views[0]?.items).toEqual([
      {
        id: "whole-rule",
        label: "修炼规则",
        value: "# 修炼\n\n## 金丹\n\n金丹之后才可尝试元婴。",
      },
      { id: "clothes", label: "衣着", value: "白色背心" },
    ]);
  });

  test("缺失引用、codec 不匹配、locator 和文档失效都返回稳定 unresolved 诊断", () => {
    const state = worldState();
    state["characters/alex.yaml"] = state["characters/alex.yaml"]!.replace(
      "character.alex }",
      "character.missing }",
    );
    const control = `format: narraeon.player-views/v1
views:
  - id: status
    title: 当前状态
    items:
      - id: relations
        label: 关系
        select: { document: character.alex, locator: { yaml: [关系] } }
      - id: dangling
        label: 装备
        select: { document: character.alex, locator: { yaml: [装备] } }
      - id: wrong-codec
        label: 错误 codec
        select: { document: character.alex, locator: { markdown: [衣着] } }
      - id: empty-markdown-wrong-codec
        label: 空 Markdown locator 错误 codec
        select: { document: character.alex, locator: { markdown: [] } }
      - id: missing-node
        label: 缺失节点
        select: { document: character.alex, locator: { yaml: [不存在] } }
      - id: missing-document
        label: 缺失文档
        select: { document: character.unknown, locator: { yaml: [衣着] } }
`;

    const result = new PlayerViewRenderer().render(input({ state, control }));

    expect(result.views[0]?.items).toEqual([
      {
        id: "relations",
        label: "关系",
        value: { Jordan: { 好感: 75, 标签: ["队友", "室友"] } },
      },
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: "unresolved_selector",
        viewId: "status",
        itemId: "dangling",
        message: "The explicit document reference cannot currently be resolved",
      },
      {
        code: "unresolved_selector",
        viewId: "status",
        itemId: "wrong-codec",
        message: "The selector codec does not match the target document",
      },
      {
        code: "unresolved_selector",
        viewId: "status",
        itemId: "empty-markdown-wrong-codec",
        message: "The selector codec does not match the target document",
      },
      {
        code: "unresolved_selector",
        viewId: "status",
        itemId: "missing-node",
        message: "The exact selector cannot currently be resolved",
      },
      {
        code: "unresolved_selector",
        viewId: "status",
        itemId: "missing-document",
        message: "Document not found: character.unknown",
      },
    ]);
  });

  test("最大深度、项目数和 64 KiB 渲染容量仍由玩家视图控制", () => {
    const state = worldState();
    const nested = Array.from(
      { length: 18 },
      (_, index) => `${"  ".repeat(index + 1)}第${index + 1}层:`,
    ).join("\n");
    state["characters/alex.yaml"] =
      `${state["characters/alex.yaml"]!}深层:\n${nested}\n${"  ".repeat(19)}值: 到达\n巨大: ${"x".repeat(70 * 1024)}\n`;
    state["rules/cultivation.md"] = state["rules/cultivation.md"]!.replace(
      "金丹之后才可尝试元婴。",
      "长篇规则。".repeat(24 * 1024),
    );
    const repeatedItems = Array.from(
      { length: 129 },
      (_, index) => `      - id: item-${index}
        label: 项目 ${index}
        select: { document: character.alex, locator: { yaml: [衣着] } }`,
    ).join("\n");
    const control = `format: narraeon.player-views/v1
views:
  - id: depth
    title: 深度
    items:
      - id: deep
        label: 深层
        select: { document: character.alex, locator: { yaml: [深层] } }
  - id: count
    title: 数量
    items:
${repeatedItems}
  - id: bytes
    title: 大小
    items:
      - id: huge
        label: 巨大
        select: { document: character.alex, locator: { yaml: [巨大] } }
      - id: after-huge
        label: 不应继续
        select: { document: character.alex, locator: { yaml: [衣着] } }
  - id: markdown-bytes
    title: Markdown 大小
    items:
      - id: huge-markdown
        label: 长篇规则
        select: { document: rule.cultivation, locator: { markdown: [] } }
      - id: after-markdown
        label: 不应继续
        select: { document: character.alex, locator: { yaml: [衣着] } }
`;

    const result = new PlayerViewRenderer().render(input({ state, control }));

    expect(
      JSON.stringify(result.views.find(({ id }) => id === "depth")),
    ).toContain("[UI depth limit reached]");
    expect(result.views.find(({ id }) => id === "count")?.items).toHaveLength(
      128,
    );
    expect(result.views.find(({ id }) => id === "bytes")?.items).toEqual([]);
    expect(
      result.views.find(({ id }) => id === "markdown-bytes")?.items,
    ).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "capacity_exceeded",
        viewId: "count",
      }),
      expect.objectContaining({
        code: "capacity_exceeded",
        viewId: "bytes",
        itemId: "huge",
      }),
      expect.objectContaining({
        code: "capacity_exceeded",
        viewId: "markdown-bytes",
        itemId: "huge-markdown",
      }),
    ]);
  });
});

describe("世界外控制草稿", () => {
  test("草稿先经真实 Preview，运行冻结时拒绝应用，释放后整批替换", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-control-draft-"));
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage({
      operationId: "create-control-world",
      sourcePackageId: "package-control-world",
      packageFiles: packageFiles(),
      prompt: prompt(),
    });
    const draft = packageFiles()
      .filter(({ path }) => path.startsWith("control/"))
      .map(({ path, contents }) => ({
        path: path.slice("control/".length),
        contents:
          path === "control/blocks/world.md"
            ? "# World Narration Rules\n\nKeep future narration concise.\n"
            : contents,
      }));
    await store.saveControlDraft(created.world.worldId, draft);
    const preview = await store.previewControlDraft(
      created.world.worldId,
      prompt(),
    );
    expect(
      preview.compilation.logicalMessages
        .map(({ markdown }) => markdown)
        .join("\n"),
    ).toContain("Keep future narration concise.");
    expect(
      (await store.readSurface(created.world.worldId, "control")).find(
        ({ path }) => path === "blocks/world.md",
      )?.contents,
    ).toContain("Write durable outcomes back to their natural owner.");

    store.freezeControl(created.world.worldId, "play-1");
    await expect(
      store.applyControlDraft(created.world.worldId, prompt()),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    store.releaseControl(created.world.worldId, "play-1");
    await store.applyControlDraft(created.world.worldId, prompt());
    expect(
      (await store.readSurface(created.world.worldId, "control")).find(
        ({ path }) => path === "blocks/world.md",
      )?.contents,
    ).toContain("Keep future narration concise.");
    expect(await store.renderPlayerViews(created.world.worldId)).toMatchObject({
      views: [
        {
          id: "status",
          items: [{ id: "situation", label: "情况", value: "安静" }],
        },
      ],
      diagnostics: [],
    });
  });
});

test("玩家视图按精确 Authority head 渲染，不读取落后的 materialized state", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-player-view-authority-"));
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: "create-authority-view-world",
    sourcePackageId: "package-authority-view-world",
    packageFiles: packageFiles(),
    prompt: prompt(),
  });
  const worldId = created.world.worldId;
  const stateFile = (await store.readSurface(worldId, "state")).find(
    ({ contents }) => contents.includes("情况: 安静"),
  )!;
  const before = stateFile.contents;
  const after = before.replace("情况: 安静", "情况: 已提交新状态");
  await store.commitPlayStep({
    operationId: "authority-view-play",
    worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "I change the situation." },
      { role: "narrator", exactText: "The situation has changed." },
    ],
    nextMaterials: [],
    stateChanges: [
      {
        kind: "replace",
        documentId: "situation.current",
        stableShortRef: "current-situation",
        relativePath: stateFile.path,
        codec: "yaml",
        expectedPreviousHash: hash(before),
        nextHash: hash(after),
        canonicalNextBytes: after,
      },
    ],
  });
  const worldRoot = join(root, "worlds-file-native", worldId);
  await writeFile(join(worldRoot, "state", stateFile.path), before);
  await rm(join(worldRoot, "runtime/materialized-head.json"), {
    force: true,
  });
  expect(await readFile(join(worldRoot, "state", stateFile.path), "utf8")).toBe(
    before,
  );
  const renderedAtHead = await store.renderPlayerViewsAtHead(
    worldId,
    "commit:1",
  );
  expect(renderedAtHead.views[0]?.items).toEqual([
    { id: "situation", label: "情况", value: "已提交新状态" },
  ]);
  await expect(store.renderPlayerViews(worldId)).resolves.toEqual(
    renderedAtHead,
  );
});

function prompt() {
  return {
    hostBinding: {
      hostPresetId: "host-test",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
      },
    },
    modelBinding: {
      provider: "chat_completions" as const,
      modelId: "test-model",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
  };
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function packageFiles() {
  return [
    {
      path: "opening.md",
      contents:
        "The room falls quiet, leaving the present situation for your response.\n",
    },
    {
      path: "world/current.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 当前状态\n    items:\n      - id: situation\n        label: 情况\n        select: { document: situation.current, locator: { yaml: [情况] } }\n`,
    },
  ];
}
