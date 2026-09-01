import { expect, test } from "vitest";

import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import { settingAuthorContractExamples } from "../../src/runtime/setting/SettingImprovementDraft.ts";

test("slot 多带参数时报出参数名而不是 kind，避免作者去删整个 slot", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame(
      "  - slot: { kind: document, document: character.alex, maxEntries: 4 }",
    ),
  });

  expect(messages).toContain(
    "Slot document does not accept parameters maxEntries; it accepts only kind, document, required",
  );
  // The old message named the kind, which made a valid slot look nonexistent.
  expect(messages.join("\n")).not.toContain(
    "Unknown slot or parameter: document",
  );
});

// Self-check must predict the real Prompt Preview. history_message used to be
// valid only here, so candidates passed self-check and failed compilation.
test("自检拒绝提示编译器不支持的 history_message slot", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame(
      '  - slot: { kind: history_message, message: "m-1" }',
    ),
  });

  expect(messages.join("\n")).toContain(
    "The world frame contains unknown slot kind history_message",
  );
});

test("真正未知的 kind 会被列出可用取值", () => {
  const messages = controlIssues({
    "control/frame.yaml": frame("  - slot: { kind: made_up }"),
  });

  expect(messages.join("\n")).toContain(
    "The world frame contains unknown slot kind made_up",
  );
  expect(messages.join("\n")).toContain("catalog");
});

test("玩家视图逐条指出哪个视图、哪个条目、哪里不对", () => {
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: relations
    title: Relationships
    extra: unexpected
    items:
      - id: no-label
        select: { document: character.alex }
      - id: wrong-codec
        label: Training rules
        select:
          document: rule.cultivation
          locator: { yaml: [level] }
`,
  });

  expect(messages).toContain("View 1 does not accept fields extra");
  expect(messages).toContain("View relations item 1 is missing a string label");
  expect(messages).toContain(
    "View relations item 2 uses a yaml locator for markdown document rule.cultivation",
  );
});

test("指向不存在文档的选择器不再被说成必须存在文档", () => {
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: ghost
    title: Ghost
    items:
      - id: missing
        label: Missing document
        select: { document: character.nobody, locator: { yaml: [status] } }
`,
  });

  // Missing documents are allowed here; diagnostics must not contradict that.
  expect(messages.filter((line) => line.includes("Ghost"))).toEqual([]);
  expect(messages.join("\n")).not.toContain("existing document");
});

test("问题过多时截断并说明还有多少处未列出", () => {
  const items = Array.from(
    { length: 12 },
    (_, index) =>
      `      - id: item-${String(index)}\n        label: Missing select`,
  ).join("\n");
  const messages = controlIssues({
    "control/player-views.yaml": `format: narraeon.player-views/v1
views:
  - id: many
    title: Many issues
    items:
${items}
`,
  });

  expect(
    messages.filter((line) => line.includes("is missing a select object")),
  ).toHaveLength(8);
  expect(messages.join("\n")).toContain(
    "4 more player-view issues were omitted",
  );
});

// Prompt compilation resolves document slots by @short-ref or ID. The author
// sees short refs, so self-check must accept the same identifiers.
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
  - slot: { kind: node, document: "@alex", locator: { yaml: [relationships] } }
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

// These contract examples teach both control-file shapes, so they must satisfy
// the same validator the generated candidate will face.
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
    { path: "opening.md", contents: "The dormitory door closes behind you.\n" },
    {
      path: "world/characters/alex.yaml",
      contents: `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: A basketball forward.\n  aliases: []\nrelationships: {}\n`,
    },
    {
      path: "world/rules/cultivation.md",
      contents: `---\n$document:\n  id: rule.cultivation\n  ref: cultivation\n  title: Training rules\n  summary: Rules expressed in natural language.\n  aliases: []\n---\n# Training rules\n\nThe story explains each level.\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: Current situation\n  summary: The situation in the dormitory.\n  aliases: []\ncharacters:\n  - $ref: character.alex\n`,
    },
    { path: "control/frame.yaml", contents: frame("") },
    {
      path: "control/blocks/world.md",
      contents:
        "# World hosting rules\n\nWrite durable results back to their natural owners.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews: []\n`,
    },
  ];
}
