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

function readyDocuments() {
  const documents = new FileNativePlayDocuments(playFiles());
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
    expect(result.markdown).toContain("4/5 edits applied");
    expect(result.markdown).toContain(
      "edit #2 (relationship): YAML append target must be a sequence",
    );
    expect(result.markdown).toContain("edit #3 no-op: target absent");
    expect(result.markdown).toContain("applied edits are not resent");
    expect(result.markdown).not.toContain("edit #1");
    expect(result.markdown).not.toContain("edit #4");
    expect(result.markdown).not.toContain("edit #5");
    expect(result.candidateWrite).toEqual({ shortRef: "qin", changed: true });
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
