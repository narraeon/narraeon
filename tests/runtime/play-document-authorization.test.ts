import { expect, test } from "vitest";
import { stringify } from "yaml";
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
  refreshed.bindBootstrap(
    compile(refreshed),
    original.authorizationCheckpoint(),
  );
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

test("a changed state tree or a fresh context cannot reuse an old read proof", () => {
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
  refreshed.bindBootstrap(
    compile(refreshed),
    original.authorizationCheckpoint(),
  );
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
}[])("$name cannot leave a stale scope in a durable read proof", (scenario) => {
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
  const proof = original.authorizationCheckpoint();
  expect(
    proof.documents.find(({ shortRef }) => shortRef === "qin"),
  ).toBeUndefined();
  const refreshed = new FileNativePlayDocuments(
    Object.fromEntries(
      original.snapshot.files.map(({ path, contents }) => [path, contents]),
    ),
  );
  expect(() =>
    refreshed.bindBootstrap(compile(refreshed), proof),
  ).not.toThrow();
  expect(() => refreshed.restoreAuthorizationCheckpoint(proof)).not.toThrow();
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
