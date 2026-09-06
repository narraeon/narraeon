import { expect, test } from "vitest";
import { stringify } from "yaml";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

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
