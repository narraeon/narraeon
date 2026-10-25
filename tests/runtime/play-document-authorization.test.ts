import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import type { WorldDocumentRevisionEdit } from "../../src/runtime/world/WorldDocumentStore.ts";

function files() {
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

function compile(documents: FileNativePlayDocuments) {
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

function patch(documents: FileNativePlayDocuments, key: string, value: string) {
  return documents.execute(
    {
      id: `patch-${key}`,
      name: "world_patch",
      arguments: {
        target: "@qin",
        edits: [{ op: "replace", locator: { yaml: [key] }, value }],
      },
    },
    [],
  );
}

test("a refreshed prefix merges exact old scopes with new material without granting siblings or old directories", () => {
  const original = new FileNativePlayDocuments(files());
  original.bindBootstrap(compile(original));
  expect(
    original.execute(
      {
        id: "read",
        name: "context_read",
        arguments: { ref: "@qin#/relationship" },
      },
      [],
    ).ok,
  ).toBe(true);
  expect(patch(original, "relationship", "Lent an umbrella").ok).toBe(true);
  original.acceptCommittedState();
  const current = Object.fromEntries(
    original.snapshot.files.map(({ path, contents }) => [path, contents]),
  );
  current["control/frame.yaml"] = current["control/frame.yaml"]!.replace(
    "  - slot: { kind: catalog, directory: items, maxEntries: 24, required: false }\n",
    "",
  ).replace(
    "context:\n",
    "context:\n  - slot: { kind: node, document: '@qin', locator: { yaml: [location] } }\n",
  );
  const refreshed = new FileNativePlayDocuments(current);
  refreshed.bindBootstrap(compile(refreshed));
  // A refreshed prefix does not carry the old read proof; the read is repeated.
  expect(
    patch(refreshed, "relationship", "Trust after keeping a promise").ok,
  ).toBe(false);
  expect(
    refreshed.execute(
      {
        id: "reread",
        name: "context_read",
        arguments: { ref: "@qin#/relationship" },
      },
      [],
    ).ok,
  ).toBe(true);
  expect(
    patch(refreshed, "relationship", "Trust after keeping a promise").ok,
  ).toBe(true);
  expect(patch(refreshed, "location", "Clinic").ok).toBe(true);
  expect(patch(refreshed, "knowledge", "Forged knowledge").ok).toBe(false);
  expect(
    refreshed.execute(
      {
        id: "create",
        name: "world_create",
        arguments: {
          parent: "@dir-/items",
          codec: "yaml",
          refHint: "umbrella",
          title: "Umbrella",
          summary: "An umbrella",
          aliases: [],
          body: "owner: player",
        },
      },
      [],
    ).ok,
  ).toBe(false);
});

test("a changed state tree or a fresh context cannot reuse an old read authorization", () => {
  const original = new FileNativePlayDocuments(files());
  original.bindBootstrap(compile(original));
  expect(
    original.execute(
      { id: "read", name: "context_read", arguments: { ref: "@qin" } },
      [],
    ).ok,
  ).toBe(true);
  const changed = files();
  changed["state/characters/qin.yaml"] = changed[
    "state/characters/qin.yaml"
  ].replace("Just met", "Explicitly revised");
  const refreshed = new FileNativePlayDocuments(changed);
  refreshed.bindBootstrap(compile(refreshed));
  expect(patch(refreshed, "relationship", "Stale overwrite").ok).toBe(false);
  const fresh = new FileNativePlayDocuments(files());
  fresh.bindBootstrap(compile(fresh));
  expect(patch(fresh, "relationship", "Unauthorized").ok).toBe(false);
});

test.each([
  {
    name: "removed map node",
    contents: "pending: Clinic visit\n",
    ref: "@qin#/pending",
    edit: { op: "remove", locator: { yaml: ["pending"] } },
  },
  {
    name: "removed array item",
    contents: "tasks: [Clinic visit, Private delivery]\n",
    ref: "@qin#/tasks/0",
    edit: { op: "remove", locator: { yaml: ["tasks", 0] } },
  },
  {
    name: "renamed Markdown section",
    contents: "# Qin\n\n## Pending\nClinic visit\n\n## Private\nDelivery\n",
    ref: "@qin#/Pending",
    edit: {
      op: "rename_section",
      locator: { markdown: ["Pending"] },
      title: "Done",
    },
  },
] satisfies {
  name: string;
  contents: string;
  ref: string;
  edit: WorldDocumentRevisionEdit;
}[])("$name cannot leave a stale scope in a read authorization", (scenario) => {
  const current: Record<string, string> = files();
  const header =
    current["state/characters/qin.yaml"]!.split("relationship:")[0]!;
  if (scenario.name === "renamed Markdown section") {
    delete current["state/characters/qin.yaml"];
    current["state/characters/qin.md"] =
      `---\n${header}---\n${scenario.contents}`;
  } else current["state/characters/qin.yaml"] += scenario.contents;
  const original = new FileNativePlayDocuments(current);
  original.bindBootstrap(compile(original));
  expect(
    original.execute(
      { id: "read", name: "context_read", arguments: { ref: scenario.ref } },
      [],
    ).ok,
  ).toBe(true);
  expect(
    original.execute(
      {
        id: "remove",
        name: "world_patch",
        arguments: { target: "@qin", edits: [scenario.edit] },
      },
      [],
    ).ok,
  ).toBe(true);
  const refreshed = new FileNativePlayDocuments(
    Object.fromEntries(
      original.snapshot.files.map(({ path, contents }) => [path, contents]),
    ),
  );
  expect(() => refreshed.bindBootstrap(compile(refreshed))).not.toThrow();
  expect(patch(refreshed, "knowledge", "Unseen").ok).toBe(false);
  if (scenario.name === "removed array item") {
    expect(
      refreshed.execute(
        {
          id: "shifted",
          name: "world_patch",
          arguments: {
            target: "@qin",
            edits: [
              {
                op: "replace",
                locator: { yaml: ["tasks", 0] },
                value: "Overwritten",
              },
            ],
          },
        },
        [],
      ).ok,
    ).toBe(false);
  }
});

test("a batch cannot use a removed array scope to overwrite its unread successor", () => {
  const current = files();
  current["state/characters/qin.yaml"] +=
    "tasks: [Clinic visit, Private delivery]\n";
  const documents = new FileNativePlayDocuments(current);
  expect(
    documents.execute(
      { id: "read", name: "context_read", arguments: { ref: "@qin#/tasks/0" } },
      [],
    ).ok,
  ).toBe(true);
  expect(
    documents.execute(
      {
        id: "batch",
        name: "world_patch",
        arguments: {
          target: "@qin",
          edits: [
            { op: "remove", locator: { yaml: ["tasks", 0] } },
            {
              op: "replace",
              locator: { yaml: ["tasks", 0] },
              value: "Overwritten",
            },
          ],
        },
      },
      [],
    ).ok,
  ).toBe(false);
  expect(
    documents.snapshot.files.find(({ path }) => path.endsWith("qin.yaml"))!
      .contents,
  ).toContain("[Clinic visit, Private delivery]");
});

function patchCall(edits: unknown) {
  return {
    id: "patch-string-edits",
    name: "world_patch",
    arguments: { target: "@qin", edits },
  };
}

function storedQin(documents: FileNativePlayDocuments) {
  documents.acceptCommittedState();
  const file = documents.snapshot.files.find(
    ({ path }) => path === "state/characters/qin.yaml",
  );
  return parse(file!.contents) as Record<string, unknown>;
}

test("world_patch executes edits sent as a JSON string and notes the repair", () => {
  const documents = new FileNativePlayDocuments(files());
  documents.bindBootstrap(compile(documents));
  expect(
    documents.execute(
      { id: "read", name: "context_read", arguments: { ref: "@qin" } },
      [],
    ).ok,
  ).toBe(true);
  const call = patchCall(
    '[{"op":"replace","locator":{"yaml":["relationship"]},"value":"Lent an umbrella"}]',
  );
  const result = documents.execute(call, []);
  expect(result.ok).toBe(true);
  expect(result.markdown).toMatch(/Runtime note[^\n]*"edits"/u);
  expect(call.arguments.edits).toBe(
    '[{"op":"replace","locator":{"yaml":["relationship"]},"value":"Lent an umbrella"}]',
  );
  expect(storedQin(documents).relationship).toBe("Lent an umbrella");
});

test("a value that looks like JSON inside an edit stays a string", () => {
  const documents = new FileNativePlayDocuments(files());
  documents.bindBootstrap(compile(documents));
  expect(
    documents.execute(
      { id: "read", name: "context_read", arguments: { ref: "@qin" } },
      [],
    ).ok,
  ).toBe(true);
  const result = documents.execute(
    patchCall([
      { op: "replace", locator: { yaml: ["relationship"] }, value: "[1,2]" },
    ]),
    [],
  );
  expect(result.ok).toBe(true);
  expect(result.markdown ?? "").not.toContain("Runtime note");
  expect(storedQin(documents).relationship).toBe("[1,2]");
});

test("world_patch names the JSON-array requirement when edits cannot be parsed", () => {
  const documents = new FileNativePlayDocuments(files());
  documents.bindBootstrap(compile(documents));
  for (const edits of ["not json", '{"op":"replace"}']) {
    const result = documents.execute(patchCall(edits), []);
    expect(result.ok).toBe(false);
    expect(result.markdown).toContain(
      "world_patch.edits must be a JSON array of 1 to 32 edits, not a string.",
    );
  }
});

test("world_create names the JSON-array requirement for a non-parseable aliases string", () => {
  const documents = new FileNativePlayDocuments(files());
  documents.bindBootstrap(compile(documents));
  const result = documents.execute(
    {
      id: "create-bad-aliases",
      name: "world_create",
      arguments: {
        parent: "@dir-/items",
        codec: "yaml",
        refHint: "umbrella",
        title: "Umbrella",
        summary: "An umbrella",
        aliases: "brolly",
        body: "owner: player",
      },
    },
    [],
  );
  expect(result.ok).toBe(false);
  expect(result.markdown).toContain(
    "world_create.aliases must be a JSON array of strings, not a string",
  );
});

test("history tools are not repaired and never gain a Runtime note", () => {
  const documents = new FileNativePlayDocuments(files());
  documents.bindBootstrap(compile(documents));
  const result = documents.execute(
    { id: "history", name: "history_list", arguments: {} },
    [],
  );
  expect(result.markdown ?? "").not.toContain("Runtime note");
});
