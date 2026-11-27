import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  WorldDocumentStore,
  type WorldDocumentRevisionEdit,
} from "../../src/runtime/world/WorldDocumentStore.ts";

const boxYaml = stringify({
  $document: {
    id: "thing.box",
    ref: "box",
    title: "箱子",
    summary: "一个箱子。",
    aliases: [],
  },
  items: ["alpha"],
  status: "open",
});

const loreMarkdown = `---
$document:
  id: rule.lore
  ref: lore
  title: 世界规则
  summary: 一份规则文档。
  aliases: []
---
# 世界规则

## 魔法

施法需要媒介。

## 地理

北境。
`;

function revise(
  path: string,
  contents: string,
  shortRef: string,
  edits: readonly WorldDocumentRevisionEdit[],
) {
  const store = WorldDocumentStore.open({
    layout: "content_package",
    files: [{ path, contents }],
  });
  return store.revise({
    commands: [{ kind: "patch", document: { shortRef }, edits }],
  });
}

function parseRecord(contents: string): Record<string, unknown> {
  return parse(contents) as Record<string, unknown>;
}

function reviseBox(edits: readonly WorldDocumentRevisionEdit[]) {
  const revised = revise("world/box.yaml", boxYaml, "box", edits);
  if (!revised.ok) throw new Error("box patch unexpectedly failed");
  const change = revised.changes[0];
  return {
    revised,
    value: parseRecord(change?.after.contents ?? boxYaml),
  };
}

describe("world_patch YAML upsert", () => {
  test("replace past the end of a one-item array appends instead of failing", () => {
    const { value } = reviseBox([
      { op: "replace", locator: { yaml: ["items", 1] }, value: "beta" },
      { op: "replace", locator: { yaml: ["items", 2] }, value: "gamma" },
    ]);

    expect(value).toMatchObject({ items: ["alpha", "beta", "gamma"] });
  });

  test("add past the end of an array appends without leaving null holes", () => {
    const { value } = reviseBox([
      { op: "add", locator: { yaml: ["items", 5] }, value: "beta" },
    ]);

    expect(value).toMatchObject({ items: ["alpha", "beta"] });
    expect(value.items).not.toContain(null);
  });

  test("add writes an existing map key and replace creates a missing parent map", () => {
    const { value } = reviseBox([
      { op: "add", locator: { yaml: ["status"] }, value: "locked" },
      { op: "replace", locator: { yaml: ["stats", "hp"] }, value: 3 },
    ]);

    expect(value).toMatchObject({ status: "locked", stats: { hp: 3 } });
  });

  test("remove of a missing target is a successful no-op that the outcome reports", () => {
    const { revised, value } = reviseBox([
      { op: "remove", locator: { yaml: ["nope"] } },
      { op: "remove", locator: { yaml: ["items", 9] } },
    ]);

    expect(revised.changes).toEqual([]);
    expect(value).toEqual(parseRecord(boxYaml));
    expect(revised.editOutcomes).toEqual([
      expect.objectContaining({ editIndex: 0, status: "no_op" }),
      expect.objectContaining({ editIndex: 1, status: "no_op" }),
    ]);
  });

  test("a failing edit is skipped alone and the rest of the batch still applies", () => {
    const revised = revise("world/box.yaml", boxYaml, "box", [
      { op: "replace", locator: { yaml: ["items", 1] }, value: "beta" },
      { op: "append", locator: { yaml: ["status"] }, value: "x" },
      { op: "add", locator: { yaml: ["color"] }, value: "red" },
      { op: "remove", locator: { yaml: ["nope"] } },
      { op: "replace", locator: { yaml: ["status"] }, value: "closed" },
    ]);

    if (!revised.ok) throw new Error("partial batch unexpectedly failed");
    expect(parseRecord(revised.changes[0]!.after.contents)).toMatchObject({
      items: ["alpha", "beta"],
      status: "closed",
      color: "red",
    });
    expect(
      revised.editOutcomes.map(({ editIndex, status }) => [editIndex, status]),
    ).toEqual([
      [0, "applied"],
      [1, "failed"],
      [2, "applied"],
      [3, "no_op"],
      [4, "applied"],
    ]);
    expect(revised.editOutcomes[1]?.diagnostic).toMatchObject({
      code: "locator_invalid",
      locator: { yaml: ["status"] },
      message: "YAML append target must be a sequence",
      logicalPath: "world/box.yaml",
      documentId: "thing.box",
    });
  });

  test("a batch where every edit fails is rejected with each edit's outcome", () => {
    const revised = revise("world/box.yaml", boxYaml, "box", [
      { op: "append", locator: { yaml: ["status"] }, value: "x" },
      { op: "append", locator: { yaml: ["nope"] }, value: "y" },
    ]);

    expect(revised).toMatchObject({ kind: "error", ok: false });
    expect(
      revised.editOutcomes.map(({ editIndex, status }) => [editIndex, status]),
    ).toEqual([
      [0, "failed"],
      [1, "failed"],
    ]);
  });
});

describe("world_patch Markdown upsert and section addressing", () => {
  test("replace_section adds a missing heading at the end of its parent", () => {
    const revised = revise("world/rules/lore.md", loreMarkdown, "lore", [
      {
        op: "replace_section",
        locator: { markdown: ["魔法", "代价"] },
        markdown: "### 代价\n\n媒介会损耗。",
      },
    ]);

    if (!revised.ok) throw new Error("Markdown add unexpectedly failed");
    const contents = revised.changes[0]!.after.contents;
    expect(contents.indexOf("### 代价")).toBeGreaterThan(
      contents.indexOf("施法需要媒介。"),
    );
    expect(contents.indexOf("### 代价")).toBeLessThan(
      contents.indexOf("## 地理"),
    );
  });

  test("replace_section with a missing top-level heading appends it to the body", () => {
    const revised = revise("world/rules/lore.md", loreMarkdown, "lore", [
      {
        op: "replace_section",
        locator: { markdown: ["历史"] },
        markdown: "## 历史\n\n旧日。",
      },
    ]);

    if (!revised.ok) throw new Error("Markdown add unexpectedly failed");
    expect(revised.changes[0]!.after.contents.trimEnd()).toMatch(
      /## 历史\n\n旧日。$/u,
    );
  });

  test("add_section with an empty locator adds a new top-level section at the end", () => {
    const revised = revise("world/rules/lore.md", loreMarkdown, "lore", [
      {
        op: "add_section",
        locator: { markdown: [] },
        markdown: "## 历史\n\n旧日。",
      },
    ]);

    if (!revised.ok) throw new Error("top-level add unexpectedly failed");
    expect(revised.changes[0]!.after.contents.trimEnd()).toMatch(
      /## 地理\n\n北境。\n\n## 历史\n\n旧日。$/u,
    );
  });

  test("add_section with an empty locator rejects a child-level heading", () => {
    const revised = revise("world/rules/lore.md", loreMarkdown, "lore", [
      {
        op: "add_section",
        locator: { markdown: [] },
        markdown: "### 历史\n\n旧日。",
      },
    ]);

    expect(revised).toMatchObject({ kind: "error", ok: false });
  });

  test("a missing heading and an ambiguous heading report different reasons", () => {
    const duplicated = loreMarkdown.replace(
      "## 地理",
      "## 魔法\n\n重复。\n\n## 地理",
    );

    const missing = revise("world/rules/lore.md", loreMarkdown, "lore", [
      { op: "remove_section", locator: { markdown: ["废弃"] } },
      { op: "rename_section", locator: { markdown: ["废弃"] }, title: "新" },
    ]);
    const ambiguous = revise("world/rules/lore.md", duplicated, "lore", [
      { op: "rename_section", locator: { markdown: ["魔法"] }, title: "新" },
    ]);

    expect(missing.editOutcomes.map(({ status }) => status)).toEqual([
      "no_op",
      "failed",
    ]);
    expect(missing.editOutcomes[1]?.diagnostic).toMatchObject({
      code: "locator_not_found",
      message: "Markdown heading path was not found",
    });
    expect(ambiguous).toMatchObject({ kind: "error", ok: false });
    expect(ambiguous.diagnostics[0]).toMatchObject({
      code: "locator_ambiguous",
      message: "Markdown heading path matches more than one section",
    });
  });
});

function playFiles() {
  return {
    ...Object.fromEntries(
      minimalFileNativeContentScaffold("en")
        .filter(({ path }) => path !== "opening.md")
        .map(({ path, contents }) => [
          path.replace(/^world\//u, "state/"),
          contents,
        ]),
    ),
    "state/characters/qin.yaml": stringify({
      $document: {
        id: "person.qin",
        ref: "qin",
        title: "Qin",
        summary: "A courier.",
        aliases: [],
      },
      relationship: "Just met",
      knowledge: "A private suspicion",
      location: "Ferry",
    }),
  };
}

function compileBootstrap(documents: FileNativePlayDocuments) {
  const preset = builtinDefaultPlayPresetBinding();
  return new FileNativePromptCompiler().compilePlayCallChain(
    {
      endpoint: { id: "test", commit: "commit:0" },
      hostBinding: presetHostBinding(preset),
      modelBinding: {
        provider: "chat_completions",
        modelId: "test",
        contextWindowTokens: 64000,
        maxOutputTokens: 2000,
      },
      playerInput: "Continue",
      playerInputPlacement: "append",
      world: {
        documentSnapshot: documents.snapshot,
        controlFingerprint: "test",
        additionalMaterials: [],
        history: {},
      },
    },
    preset,
  ).bootstrap;
}

function readyDocuments(files = playFiles()) {
  const documents = new FileNativePlayDocuments(files);
  documents.bindBootstrap(compileBootstrap(documents));
  expect(
    documents.execute(
      { id: "read", name: "context_read", arguments: { ref: "@qin" } },
      [],
    ).ok,
  ).toBe(true);
  return documents;
}

function patchQin(
  documents: FileNativePlayDocuments,
  edits: readonly unknown[],
) {
  return documents.execute(
    {
      id: "patch",
      name: "world_patch",
      arguments: { target: "@qin", edits },
    },
    [],
  );
}

describe("world_patch YAML style", () => {
  test("filling the first child of an empty flow map expands only that map", () => {
    const files = playFiles();
    const path = "state/characters/qin.yaml";
    const untouched = [
      "",
      "# 保持作者的空格和引号",
      "现有映射: {状态: '关闭',  方向: 北}  # 原格式",
      "现有引用: {$ref: person.qin}",
      "仍然为空: {}",
      "",
    ].join("\n");
    const empty = "未了事项: {}  # 留给后续情节\n";
    const before = files[path] + empty + untouched;
    files[path] = before;
    const documents = readyDocuments(files);
    const details = "撤退时落在遗迹里的灯还亮着，必须在下次涨潮前取回。";

    const result = patchQin(documents, [
      {
        op: "add",
        locator: { yaml: ["未了事项", "找回遗迹的灯"] },
        value: { 描述: details, 信使: { $ref: "@qin" } },
      },
    ]);

    expect(result).toMatchObject({
      ok: true,
      candidateWrite: { changed: true },
    });
    expect(
      documents.snapshot.files.find((file) => file.path === path)?.contents,
    ).toBe(
      before.replace(
        empty,
        [
          "未了事项:  # 留给后续情节",
          "  找回遗迹的灯:",
          `    描述: ${details}`,
          "    信使: { $ref: person.qin }",
          "",
        ].join("\n"),
      ),
    );
  });

  test("replacing an empty map inside a block sequence keeps adjacent text and multiline values", () => {
    const files = playFiles();
    const path = "state/characters/qin.yaml";
    const empty = "    - { # 边记\n        } # 后记\n";
    const after = "\n         # 作者原有的注释\n    - 保留\n";
    const prefix = `${files[path]}行程:\n`;
    files[path] = prefix + empty + after;
    const documents = readyDocuments(files);
    const details = "找到灯。\n\n";

    expect(
      patchQin(documents, [
        {
          op: "replace",
          locator: { yaml: ["行程", 0] },
          value: { 描述: details },
        },
      ]).ok,
    ).toBe(true);

    const contents = documents.snapshot.files.find(
      (file) => file.path === path,
    )!.contents;
    expect(contents).toBe(
      prefix +
        "    -\n      # 边记\n      # 后记\n      描述: " +
        '"找到灯。\\n\\n"\n' +
        after,
    );
    expect(parseRecord(contents).行程).toEqual([{ 描述: details }, "保留"]);
  });

  test("fills a separately indented map without changing its siblings", () => {
    const files = playFiles();
    const path = "state/characters/qin.yaml";
    const before = `${files[path]}线索:\n    已登记: 先前\n    待补:\n        {} # 后续\n    现有: {方向: 北}\n`;
    files[path] = before;
    const documents = readyDocuments(files);

    expect(
      patchQin(documents, [
        {
          op: "replace",
          locator: { yaml: ["线索", "待补", "地点"] },
          value: "遗迹",
        },
      ]).ok,
    ).toBe(true);

    const contents = documents.snapshot.files.find(
      (file) => file.path === path,
    )!.contents;
    expect(contents).toBe(
      before.replace("        {} # 后续", "        # 后续\n        地点: 遗迹"),
    );
    expect(parseRecord(contents).线索).toEqual({
      已登记: "先前",
      待补: { 地点: "遗迹" },
      现有: { 方向: "北" },
    });
    expect(
      patchQin(documents, [
        {
          op: "replace",
          locator: { yaml: ["线索", "现有", "方向"] },
          value: "南",
        },
      ]).ok,
    ).toBe(true);
    const updated = documents.snapshot.files.find(
      (file) => file.path === path,
    )!.contents;
    expect(parseRecord(updated).线索).toEqual({
      已登记: "先前",
      待补: { 地点: "遗迹" },
      现有: { 方向: "南" },
    });
  });

  test("keeps reference-only replacements and maps inside an existing flow collection inline", () => {
    const files = playFiles();
    const path = "state/characters/qin.yaml";
    files[path] += "潜在引用: {}\n已有映射: { 待补: {}, 状态: 已记录 }\n";
    const documents = readyDocuments(files);

    expect(
      patchQin(documents, [
        { op: "add", locator: { yaml: ["潜在引用"] }, value: { $ref: "@qin" } },
        {
          op: "add",
          locator: { yaml: ["已有映射", "待补", "描述"] },
          value: "线索",
        },
      ]).ok,
    ).toBe(true);

    expect(
      documents.snapshot.files.find((file) => file.path === path)?.contents,
    ).toBe(
      files[path]
        .replace("潜在引用: {}", "潜在引用: { $ref: person.qin }")
        .replace("待补: {}", "待补: { 描述: 线索 }"),
    );
  });

  test("leaves a CRLF-authored document untouched when the restricted codec rejects it", () => {
    const files = playFiles();
    const path = "state/characters/qin.yaml";
    const before = `${files[path]}未了事项: {}\n`.replaceAll("\n", "\r\n");
    files[path] = before;
    const documents = new FileNativePlayDocuments(files);

    expect(documents.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        logicalPath: path,
        code: "yaml_invalid",
        message: "YAML contains a NUL or carriage return",
      }),
    );
    expect(
      patchQin(documents, [
        { op: "add", locator: { yaml: ["未了事项", "灯"] }, value: "遗迹" },
      ]).ok,
    ).toBe(false);
    expect(
      documents.snapshot.files.find((file) => file.path === path)?.contents,
    ).toBe(before);
  });
});

describe("world_patch receipt", () => {
  test("a full success keeps the one-line receipt", () => {
    const documents = readyDocuments();
    const result = patchQin(documents, [
      { op: "replace", locator: { yaml: ["relationship"] }, value: "Friends" },
    ]);

    expect(result).toMatchObject({ ok: true, markdown: "@qin pending write" });
  });

  test("a partial batch lists only the failed and no-op edits and says not to resend the rest", () => {
    const documents = readyDocuments();
    const result = patchQin(documents, [
      { op: "replace", locator: { yaml: ["relationship"] }, value: "Friends" },
      { op: "append", locator: { yaml: ["relationship"] }, value: "x" },
      { op: "remove", locator: { yaml: ["nope"] } },
      { op: "add", locator: { yaml: ["trust"] }, value: 2 },
      { op: "replace", locator: { yaml: ["stats", "hp"] }, value: 3 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("@qin pending write");
    expect(result.markdown).toContain("3/5 edits applied");
    expect(result.markdown).toContain(
      "edit #2 (relationship): YAML append target must be a sequence",
    );
    expect(result.markdown).toContain("edit #3 no-op: target absent");
    expect(result.markdown).toContain("Resend only rejected edits");
    expect(result.markdown).not.toContain("edit #1");
    expect(result.markdown).not.toContain("edit #4");
    expect(result.markdown).not.toContain("edit #5");
    expect(result.candidateWrite).toMatchObject({
      shortRef: "qin",
      changed: true,
    });
  });

  test("a batch where no edit applies is a tool failure that names each edit", () => {
    const documents = readyDocuments();
    const result = patchQin(documents, [
      { op: "append", locator: { yaml: ["relationship"] }, value: "x" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.markdown).toContain("edit #1 (relationship)");
  });
});
