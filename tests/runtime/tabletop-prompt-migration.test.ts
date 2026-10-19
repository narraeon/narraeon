import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDocument, stringify } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import { gameplayFile } from "../../src/protocol/gameplay.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  FileNativePlayPresetStore,
  defaultPlayPresetFilesForLocale,
  revisionForPlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";

const roots: string[] = [];
const libraryName = "file-native-play-presets.json";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

/** A v2 preset as the release before tabletop builtins saved it. */
function releasedFiles(): Record<string, string> {
  const files = { ...defaultPlayPresetFilesForLocale("en") };
  const preset = parseDocument(files["preset.yaml"]!);
  const withoutTabletop = (key: string, id: string) => {
    const items = (preset.get(key) as { items: unknown[] }).items;
    const kept = items.filter(
      (item) => (item as { get(k: string): unknown }).get("id") !== id,
    );
    preset.set(key, kept);
  };
  withoutTabletop("playPrompts", "play.tabletop");
  withoutTabletop("authorPrompts", "author.tabletop");
  files["preset.yaml"] = stringify(preset.toJS());
  return files;
}

interface PromptEntry {
  id: string;
  kind: string;
  builtin?: string;
  enabled?: boolean;
}

function presetRecord(files: Record<string, string>): {
  name: string;
  playPrompts: PromptEntry[];
  authorPrompts: PromptEntry[];
} {
  return parseDocument(files["preset.yaml"]!).toJS() as never;
}

function currentPlayList(files: Record<string, string>): PromptEntry[] {
  return presetRecord(files).playPrompts;
}

async function writeLibrary(
  root: string,
  presets: {
    id: string;
    name: string;
    files: Record<string, string>;
    draft?: Record<string, string>;
  }[],
): Promise<void> {
  const stored = presets.map(({ id, name, files, draft }) => {
    const currentRevision = revisionForPlayPresetFiles(files);
    const revisions: Record<string, Record<string, string>> = {
      [currentRevision]: files,
    };
    let draftRevision: string | undefined;
    if (draft !== undefined) {
      draftRevision = revisionForPlayPresetFiles(draft);
      revisions[draftRevision] = draft;
    }
    return {
      id,
      name,
      currentRevision,
      revisions,
      ...(draftRevision === undefined ? {} : { draftRevision }),
      enabled: true,
      scriptsEnabled: true,
    };
  });
  await writeFile(
    join(root, libraryName),
    `${JSON.stringify({ schemaVersion: 1, currentPresetId: presets[0]!.id, presets: stored }, null, 2)}\n`,
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tabletop-prompt-migration-"));
  roots.push(root);
  return root;
}

function fictionInput() {
  return createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "migration-model",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    playerInput: "我推门。",
    playerInputPlacement: "append",
  });
}

function compiledFiction(binding: PlayPresetBinding) {
  const compiler = new FileNativePromptCompiler();
  return compiler.compilePlayCallChain(fictionInput(), binding);
}

describe("tabletop builtin migration for ordered presets", () => {
  test("initialization inserts the builtins once, in a new revision, and keeps every other entry", async () => {
    const root = await temporaryRoot();
    const files = releasedFiles();
    await writeLibrary(root, [{ id: "mine", name: "Mine", files }]);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();

    const bound = await store.bindCurrent();
    expect(bound.revision).not.toBe(revisionForPlayPresetFiles(files));
    const before = currentPlayList(files);
    const after = currentPlayList(bound.files);
    expect(
      after.filter(({ id }) => before.some((old) => old.id === id)),
    ).toEqual(before);
    const worldIndex = after.findIndex(({ kind }) => kind === "world");
    expect(after[worldIndex - 1]).toMatchObject({
      id: "play.tabletop",
      kind: "builtin",
      builtin: "play.tabletop",
      enabled: true,
    });
    expect(after.filter(({ id }) => id === "play.tabletop")).toHaveLength(1);
    const authors = presetRecord(bound.files).authorPrompts;
    const guidance = authors.findIndex(({ id }) => id === "author.guidance");
    expect(authors[guidance + 1]).toMatchObject({ id: "author.tabletop" });

    // The original revision remains available for frozen requests.
    expect(
      (await store.bindRevision("mine", revisionForPlayPresetFiles(files)))
        .files,
    ).toEqual(files);
  });

  test("a second initialization is idempotent and writes nothing", async () => {
    const root = await temporaryRoot();
    await writeLibrary(root, [
      { id: "mine", name: "Mine", files: releasedFiles() },
    ]);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const migrated = await readFile(join(root, libraryName), "utf8");
    const revision = (await store.bindCurrent()).revision;
    await store.initialize();
    expect(await readFile(join(root, libraryName), "utf8")).toBe(migrated);
    expect((await store.bindCurrent()).revision).toBe(revision);
  });

  test("user entries, order, disabled entries and enabled flags survive exactly", async () => {
    const root = await temporaryRoot();
    const files = releasedFiles();
    const preset = parseDocument(files["preset.yaml"]!);
    const playPrompts = preset.get("playPrompts") as { items: unknown[] };
    playPrompts.items.splice(playPrompts.items.length - 1, 0, {
      id: "custom-one",
      kind: "user",
      name: "Custom one",
      enabled: false,
      body: "# Custom one\n\nKept exactly.",
    });
    files["preset.yaml"] = preset.toString();
    await writeLibrary(root, [{ id: "mine", name: "Mine", files }]);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const after = currentPlayList((await store.bindCurrent()).files);
    expect(
      after
        .filter(({ id }) => id !== "play.tabletop" && id !== "author.tabletop")
        .map(({ id, enabled }) => [id, enabled]),
    ).toEqual(currentPlayList(files).map(({ id, enabled }) => [id, enabled]));
    expect(after.find(({ id }) => id === "custom-one")).toMatchObject({
      enabled: false,
    });
  });

  test("a pending draft is migrated the same way so its save still passes the builtin rule", async () => {
    const root = await temporaryRoot();
    const current = releasedFiles();
    const draft = releasedFiles();
    const draftPreset = parseDocument(draft["preset.yaml"]!);
    draftPreset.set("name", "Draft name");
    draft["preset.yaml"] = draftPreset.toString();
    await writeLibrary(root, [
      { id: "mine", name: "Mine", files: current, draft },
    ]);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();

    const view = (await store.list()).presets[0]!;
    expect(view.draft).toBeDefined();
    const draftPlay = currentPlayList(view.draft!.files);
    expect(draftPlay.some(({ id }) => id === "play.tabletop")).toBe(true);
    expect(presetRecord(view.draft!.files).name).toBe("Draft name");
    // Saving the migrated draft as-is is accepted.
    await expect(
      store.save({
        presetId: "mine",
        name: "Mine",
        files: view.draft!.files,
      }),
    ).resolves.toBeDefined();
  });

  test("a preset that already carries the builtins is left untouched", async () => {
    const root = await temporaryRoot();
    const current = defaultPlayPresetFilesForLocale("en");
    await writeLibrary(root, [{ id: "fresh", name: "Fresh", files: current }]);
    const bytes = await readFile(join(root, libraryName), "utf8");
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    expect(await readFile(join(root, libraryName), "utf8")).toBe(bytes);
  });

  test("a failed write leaves the released library intact and the next initialization completes the migration", async () => {
    const root = await temporaryRoot();
    const released = releasedFiles();
    await writeLibrary(root, [{ id: "mine", name: "Mine", files: released }]);
    const original = await readFile(join(root, libraryName), "utf8");
    const store = new FileNativePlayPresetStore(root);
    // Refuse the temporary file in the commit step, as a crash before rename would.
    await chmod(root, 0o500);
    await expect(store.initialize()).rejects.toThrow();
    await chmod(root, 0o700);
    expect(await readFile(join(root, libraryName), "utf8")).toBe(original);

    const retried = new FileNativePlayPresetStore(root);
    await retried.initialize();
    expect(
      currentPlayList((await retried.bindCurrent()).files).map(({ id }) => id),
    ).toContain("play.tabletop");
  });

  test("read paths never write, even on an unmigrated library", async () => {
    const root = await temporaryRoot();
    await writeLibrary(root, [
      { id: "mine", name: "Mine", files: releasedFiles() },
    ]);
    const original = await readFile(join(root, libraryName), "utf8");
    const store = new FileNativePlayPresetStore(root);
    await store.list();
    await store.bindCurrent();
    await store.freeze();
    expect(await readFile(join(root, libraryName), "utf8")).toBe(original);
  });

  test("the migrated preset compiles fiction requests exactly as the released preset did", async () => {
    const root = await temporaryRoot();
    const released = releasedFiles();
    await writeLibrary(root, [{ id: "mine", name: "Mine", files: released }]);
    const store = new FileNativePlayPresetStore(root);
    const before = JSON.stringify(
      compiledFiction({
        id: "mine",
        name: "Mine",
        revision: revisionForPlayPresetFiles(released),
        definition: (await store.bindRevision("mine")).definition,
        files: released,
        scriptsEnabled: true,
      }),
    );
    await store.initialize();
    const after = JSON.stringify(compiledFiction(await store.bindCurrent()));
    expect(after).toBe(before);
  });

  test("a portable import of a released preset gains the builtins", async () => {
    const root = await temporaryRoot();
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const imported = await store.importPortable({
      name: "Imported",
      files: releasedFiles(),
    });
    expect(
      currentPlayList((await store.bindRevision(imported.preset.id)).files).map(
        ({ id }) => id,
      ),
    ).toContain("play.tabletop");
  });

  test("saving cannot delete the builtins but can disable them", async () => {
    const root = await temporaryRoot();
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const current = await store.list();
    const presetId = current.currentPresetId;
    const files = (await store.bindCurrent()).files;

    const withoutTabletop = { ...files };
    const doc = parseDocument(files["preset.yaml"]!);
    const playPrompts = doc.get("playPrompts") as { items: unknown[] };
    playPrompts.items = playPrompts.items.filter(
      (item) =>
        (item as { get(k: string): unknown }).get("id") !== "play.tabletop",
    );
    withoutTabletop["preset.yaml"] = doc.toString();
    await expect(
      store.save({ presetId, name: "default", files: withoutTabletop }),
    ).rejects.toMatchObject({ code: "readonly_prompt_removed" });

    const disabled = parseDocument(files["preset.yaml"]!);
    const entries = disabled.get("playPrompts") as {
      items: { get(k: string): unknown; set(k: string, v: unknown): void }[];
    };
    for (const item of entries.items)
      if (item.get("id") === "play.tabletop") item.set("enabled", false);
    await store.save({
      presetId,
      name: "default",
      files: { ...files, "preset.yaml": disabled.toString() },
    });
    const draftView = (await store.list()).presets[0]!;
    const saved = draftView.draft ?? draftView;
    expect(
      currentPlayList(saved.files).find(({ id }) => id === "play.tabletop"),
    ).toMatchObject({ enabled: false });
  });

  test("a tabletop world still sees its builtin after the migration", async () => {
    const root = await temporaryRoot();
    await writeLibrary(root, [
      { id: "mine", name: "Mine", files: releasedFiles() },
    ]);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const compiler = new FileNativePromptCompiler();
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "migration-model",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      playerInput: "我推门。",
      playerInputPlacement: "append",
    });
    const tabletop = {
      ...input,
      world: {
        ...input.world,
        documentSnapshot: (
          await import("../../src/runtime/world/WorldDocumentStore.ts")
        ).WorldDocumentStore.open({
          layout: "world_state",
          files: [
            ...input.world.documentSnapshot.files.map(({ path, contents }) => ({
              path,
              contents,
            })),
            gameplayFile({ mode: "tabletop", scheme: "d20" }),
          ],
        }),
      },
    };
    const sources = compiler
      .compilePlayCallChain(tabletop, await store.bindCurrent())
      .bootstrap.logicalMessages.flatMap(({ blocks }) =>
        blocks.map(({ source }) => source),
      );
    expect(sources).toContain("runtime:ordered/play.tabletop");
  });
});
