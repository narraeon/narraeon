import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDocument, stringify } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  FileNativePlayPresetStore,
  defaultPlayPresetFilesForLocale,
  revisionForPlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { withContinuationPromptBuiltins } from "../../src/runtime/play/OrderedPlayPrompts.ts";
import {
  builtinPlayPrompts,
  defaultOrderedPlayPrompts,
} from "../../src/shared/ordered-play-prompts.ts";
import { defaultNarrationPromptForLocale } from "../../src/shared/default-play-prompts.ts";

const roots: string[] = [];
const libraryName = "file-native-play-presets.json";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface PromptEntry {
  id: string;
  kind: string;
  builtin?: string;
  enabled?: boolean;
}

function playList(files: Record<string, string>): PromptEntry[] {
  return (
    parseDocument(files["preset.yaml"]!).toJS() as {
      playPrompts: PromptEntry[];
    }
  ).playPrompts;
}

/** A v2 preset as the release before the continuation builtins saved it. */
function releasedFiles(
  edit: (items: PromptEntry[]) => PromptEntry[] = (items) => items,
): Record<string, string> {
  const files = { ...defaultPlayPresetFilesForLocale("en") };
  const preset = parseDocument(files["preset.yaml"]!);
  const items = (preset.toJS() as { playPrompts: PromptEntry[] }).playPrompts;
  preset.set(
    "playPrompts",
    edit(items.filter(({ id }) => !id.startsWith("play.continue-"))),
  );
  files["preset.yaml"] = stringify(preset.toJS());
  return files;
}

async function libraryWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "continuation-migration-"));
  roots.push(root);
  const currentRevision = revisionForPlayPresetFiles(files);
  await writeFile(
    join(root, libraryName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        currentPresetId: "mine",
        presets: [
          {
            id: "mine",
            name: "Mine",
            currentRevision,
            revisions: { [currentRevision]: files },
            enabled: true,
            scriptsEnabled: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("continuation blocks", () => {
  test("the catalog offers staging and direct advancement after the narrative block, staging on by default", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const ids = builtinPlayPrompts(locale).map(({ id }) => id);
      const narrative = ids.indexOf("play.narrative");
      expect(ids.slice(narrative, narrative + 3)).toEqual([
        "play.narrative",
        "play.continue-stage",
        "play.continue-advance",
      ]);
      // The narrative block no longer carries the staging rule itself; it
      // defers to whichever continuation block is enabled.
      const narration = defaultNarrationPromptForLocale(locale);
      expect(narration).not.toContain(
        locale === "zh-CN"
          ? "自然接入场景"
          : "naturally stage its explicit action",
      );
      expect(narration).toContain(
        locale === "zh-CN" ? "承接规则" : "continuation rules",
      );
    }
    const enabled = Object.fromEntries(
      defaultOrderedPlayPrompts().flatMap((entry) =>
        entry.kind === "builtin" ? [[entry.builtin, entry.enabled]] : [],
      ),
    );
    expect(enabled["play.continue-stage"]).toBe(true);
    expect(enabled["play.continue-advance"]).toBe(false);
  });

  test("a stored preset without the blocks gains both after the narrative block, staging enabled", async () => {
    const files = releasedFiles();
    const root = await libraryWith(files);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const bound = await store.bindCurrent();
    expect(bound.revision).not.toBe(revisionForPlayPresetFiles(files));
    const before = playList(files);
    const after = playList(bound.files);
    expect(
      after.filter(({ id }) => before.some((old) => old.id === id)),
    ).toEqual(before);
    const narrative = after.findIndex(({ id }) => id === "play.narrative");
    expect(after.slice(narrative + 1, narrative + 3)).toEqual([
      {
        id: "play.continue-stage",
        kind: "builtin",
        builtin: "play.continue-stage",
        enabled: true,
      },
      {
        id: "play.continue-advance",
        kind: "builtin",
        builtin: "play.continue-advance",
        enabled: false,
      },
    ]);
    // The original revision remains available for frozen requests.
    expect(
      (await store.bindRevision("mine", revisionForPlayPresetFiles(files)))
        .files,
    ).toEqual(files);
  });

  test("a preset that already lists either block, or has no narrative block, is handled without duplicates", () => {
    const swapped = releasedFiles((items) => {
      const world = items.findIndex(({ kind }) => kind === "world");
      items.splice(world, 0, {
        id: "play.continue-advance",
        kind: "builtin",
        builtin: "play.continue-advance",
        enabled: true,
      });
      return items;
    });
    expect(withContinuationPromptBuiltins(swapped)).toBe(swapped);

    const noNarrative = releasedFiles((items) =>
      items.filter(({ id }) => id !== "play.narrative"),
    );
    const migrated = playList(withContinuationPromptBuiltins(noNarrative));
    // Without a narrative block they stay ahead of the tabletop builtin, which
    // sits just before the world placeholder.
    const tabletop = migrated.findIndex(({ id }) => id === "play.tabletop");
    expect(
      migrated.slice(tabletop - 2, tabletop + 2).map(({ id }) => id),
    ).toEqual([
      "play.continue-stage",
      "play.continue-advance",
      "play.tabletop",
      "world",
    ]);
    expect(
      migrated.filter(({ id }) => id.startsWith("play.continue-")),
    ).toHaveLength(2);
  });

  test("only the enabled continuation block reaches a fiction request, and swapping them swaps the prose rule", async () => {
    const root = await libraryWith(releasedFiles());
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const compiler = new FileNativePromptCompiler({ locale: "en" });
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "migration-model",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      playerInput: "I push the door.",
      playerInputPlacement: "append",
    });
    const sources = (files: Awaited<ReturnType<typeof store.bindCurrent>>) =>
      compiler
        .compilePlayCallChain(input, files)
        .bootstrap.logicalMessages.flatMap(({ blocks }) =>
          blocks.map(({ source }) => source),
        );
    const staged = sources(await store.bindCurrent());
    expect(staged).toContain("runtime:ordered/play.continue-stage");
    expect(staged).not.toContain("runtime:ordered/play.continue-advance");

    const preset = (await store.list()).presets[0]!;
    const structure = preset.structure!;
    for (const entry of structure.playPrompts!) {
      if (entry.kind !== "builtin") continue;
      if (entry.builtin === "play.continue-stage") entry.enabled = false;
      if (entry.builtin === "play.continue-advance") entry.enabled = true;
    }
    await store.save({
      presetId: preset.id,
      name: preset.name,
      files: preset.files,
      structure,
    });
    await store.select(preset.id);
    const advanced = sources(await store.bindCurrent());
    expect(advanced).toContain("runtime:ordered/play.continue-advance");
    expect(advanced).not.toContain("runtime:ordered/play.continue-stage");
  });
});
