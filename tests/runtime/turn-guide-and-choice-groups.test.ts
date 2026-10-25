import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDocument, stringify } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import {
  FileNativePlayPresetStore,
  defaultPlayPresetFilesForLocale,
  isPlayPresetBinding,
  parsePlayPresetFiles,
  revisionForPlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  retiredPlayBuiltins,
  withCurrentPromptBuiltins,
  withRestructuredPromptBuiltins,
} from "../../src/runtime/play/OrderedPlayPrompts.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import {
  builtinPlayPrompts,
  promptGroups,
  turnGuideLineSoftLimit,
  turnGuideLinesSoftLimit,
  type PromptGroup,
} from "../../src/shared/ordered-play-prompts.ts";
import {
  turnGuideHeader,
  turnGuideText,
  turnGuideWarnings,
} from "../../src/shared/turn-guide.ts";

interface Entry {
  id: string;
  kind: string;
  builtin?: string;
  enabled?: boolean;
  name?: string;
  body?: string;
  turnGuide?: string;
  messageRole?: string;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function members(group: PromptGroup): string[] {
  return builtinPlayPrompts("en")
    .filter((item) => item.group === group)
    .map(({ id }) => id);
}

function playList(files: Record<string, string>): Entry[] {
  return (
    parseDocument(files["preset.yaml"]!).toJS() as { playPrompts: Entry[] }
  ).playPrompts;
}

function filesWith(
  locale: AppLocale,
  edit: (items: Entry[]) => Entry[],
): Record<string, string> {
  const files = { ...defaultPlayPresetFilesForLocale(locale) };
  const preset = parseDocument(files["preset.yaml"]!);
  preset.set("playPrompts", edit(playList(files)));
  files["preset.yaml"] = stringify(preset.toJS());
  return files;
}

function bindingFrom(files: Record<string, string>): PlayPresetBinding {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "turn-guide-preset",
    name: parsed.definition.name,
    revision: "rev-turn-guide",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function compile(
  locale: AppLocale,
  binding: PlayPresetBinding,
  worldFrame?: string,
) {
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "turn-guide-model",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    playerInput: "I nod to Alex.",
    playerInputPlacement: "append",
    locale,
  });
  if (worldFrame !== undefined)
    input.world.documentSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: input.world.documentSnapshot.files.map((file) =>
        file.path === "control/frame.yaml"
          ? { ...file, contents: worldFrame }
          : file,
      ),
    });
  return new FileNativePromptCompiler({ locale }).compilePlayCallChain(
    input,
    binding,
  ).bootstrap;
}

function cartesian(groups: string[][]): string[][] {
  return groups.reduce<string[][]>(
    (combos, group) =>
      combos.flatMap((combo) => group.map((id) => [...combo, id])),
    [[]],
  );
}

describe("choice groups", () => {
  test("every combination of the four groups sends exactly one block and one turn-guide line per group", () => {
    const combos = cartesian(promptGroups.map(members));
    expect(combos).toHaveLength(36);
    const catalog = builtinPlayPrompts("en");
    for (const choice of combos) {
      const binding = bindingFrom(
        filesWith("en", (items) =>
          items.map((entry) =>
            entry.kind === "builtin" &&
            catalog.find((item) => item.id === entry.builtin)?.group !==
              undefined
              ? { ...entry, enabled: choice.includes(entry.builtin!) }
              : entry,
          ),
        ),
      );
      const bootstrap = compile("en", binding);
      const sources = bootstrap.logicalMessages.flatMap(({ blocks }) =>
        blocks.map(({ source }) => source),
      );
      const lines = bootstrap.turnGuide!.lines;
      for (const [index, group] of promptGroups.entries()) {
        const ids = members(group);
        expect(
          sources.filter((source) =>
            ids.some((id) => source === `runtime:ordered/${id}`),
          ),
        ).toEqual([`runtime:ordered/${choice[index]}`]);
        expect(
          lines.filter(({ source }) =>
            ids.some((id) => source === `preset:builtin/${id}`),
          ),
        ).toEqual([
          {
            source: `preset:builtin/${choice[index]}`,
            text: catalog.find((item) => item.id === choice[index])!.turnGuide,
          },
        ]);
      }
    }
  });

  test.each(["en", "zh-CN"] as const)(
    "%s: the default preset's turn guide lists the enabled lines in list order under the fixed header",
    (locale) => {
      const bootstrap = compile(
        locale,
        bindingFrom(defaultPlayPresetFilesForLocale(locale)),
      );
      const catalog = builtinPlayPrompts(locale);
      const expected = [
        "play.person-second",
        "play.continue-stage",
        "play.agency-default",
        "play.stop-beat",
        "play.ending",
        "play.output",
        "play.facts",
        "play.save-timing",
      ];
      expect(bootstrap.turnGuide?.lines).toEqual(
        expected.map((id) => ({
          source: `preset:builtin/${id}`,
          text: catalog.find((item) => item.id === id)!.turnGuide,
        })),
      );
      expect(bootstrap.turnGuide?.text).toBe(
        turnGuideText(locale, bootstrap.turnGuide!.lines),
      );
      expect(
        bootstrap.turnGuide?.text.startsWith(turnGuideHeader(locale)),
      ).toBe(true);
      expect(turnGuideWarnings(bootstrap.turnGuide!.lines)).toEqual([]);
      // The suffix is not a logical message: the prefix carries only blocks.
      expect(
        bootstrap.logicalMessages.some(({ markdown }) =>
          markdown.includes(turnGuideHeader(locale)),
        ),
      ).toBe(false);
    },
  );
});

describe("turn guide composition", () => {
  const worldFrame = `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world-style.md
    turnGuide: "  Alex never speaks first in the dorm.  "
  - turnGuide: Keep the corridor lamp lit.
  - turnGuide: ""
context:
  - slot: { kind: current_situation }
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: additional_materials }
`;

  test("tail entries, user lines, builtin overrides and world frame lines compose in list order", () => {
    const binding = bindingFrom(
      filesWith("en", (items) =>
        items.flatMap((entry) => {
          if (entry.builtin === "play.ending")
            return [{ ...entry, turnGuide: "Custom ending line." }];
          if (entry.builtin === "play.facts")
            return [{ ...entry, turnGuide: "" }];
          if (entry.builtin === "play.output")
            return [
              entry,
              {
                id: "tail-lamp",
                kind: "tail",
                name: "Lamp",
                enabled: true,
                body: " Keep the lamp lit. ",
              },
              {
                id: "tail-off",
                kind: "tail",
                name: "Off",
                enabled: false,
                body: "Never sent.",
              },
            ];
          if (entry.kind === "world")
            return [
              {
                id: "user-mine",
                kind: "user",
                name: "Mine",
                enabled: true,
                body: "My rule.",
                turnGuide: "My line.",
              },
              {
                id: "user-plain",
                kind: "user",
                name: "Plain",
                enabled: true,
                body: "No line.",
              },
              entry,
            ];
          return [entry];
        }),
      ),
    );
    const bootstrap = compile("en", binding, worldFrame);
    const catalog = builtinPlayPrompts("en");
    const line = (id: string) => ({
      source: `preset:builtin/${id}`,
      text: catalog.find((item) => item.id === id)!.turnGuide,
    });
    expect(bootstrap.turnGuide?.lines).toEqual([
      line("play.person-second"),
      line("play.continue-stage"),
      line("play.agency-default"),
      line("play.stop-beat"),
      { source: "preset:builtin/play.ending", text: "Custom ending line." },
      line("play.output"),
      { source: "preset:prompt/tail-lamp", text: "Keep the lamp lit." },
      line("play.save-timing"),
      { source: "preset:prompt/user-mine", text: "My line." },
      {
        source: "world:control/frame.yaml#instructions[0]",
        text: "Alex never speaks first in the dorm.",
      },
      {
        source: "world:control/frame.yaml#instructions[1]",
        text: "Keep the corridor lamp lit.",
      },
    ]);
    expect(bootstrap.turnGuide?.text).toBe(
      [
        turnGuideHeader("en"),
        ...bootstrap.turnGuide!.lines.map(({ text }) => `- ${text}`),
      ].join("\n"),
    );
    // Tail entries never become prefix messages; user bodies still do.
    const sources = bootstrap.logicalMessages.flatMap(({ blocks }) =>
      blocks.map(({ source }) => source),
    );
    expect(sources).not.toContain("preset:prompt/tail-lamp");
    expect(sources).toContain("preset:prompt/user-mine");
    expect(sources).toContain("preset:prompt/user-plain");
    // The world frame's block still joins the prefix at the world placeholder.
    expect(sources).toContain("world:control/blocks/world-style.md");
  });

  test("the player's one-turn request is the last preview line from source player:turn, and only the preview carries it", () => {
    const binding = bindingFrom(filesWith("en", (items) => items));
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "turn-guide-model",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      playerInput: "I nod to Alex.",
      playerInputPlacement: "append",
      locale: "en",
    });
    const compiler = new FileNativePromptCompiler({ locale: "en" });
    const plain = compiler.compilePlayCallChain(input, binding).bootstrap;
    const withNote = compiler.compilePlayCallChain(
      { ...input, turnNote: "Write the fight in short beats." },
      binding,
    ).bootstrap;
    expect(withNote.turnGuide?.lines.at(-1)).toEqual({
      source: "player:turn",
      text: "Player's request for this turn: Write the fight in short beats.",
    });
    expect(withNote.turnGuide?.text).toBe(
      turnGuideText("en", withNote.turnGuide!.lines),
    );
    expect(withNote.turnGuide?.lines.slice(0, -1)).toEqual(
      plain.turnGuide?.lines,
    );
    // The request line counts toward the soft limits like any other line.
    expect(turnGuideWarnings(withNote.turnGuide!.lines)).toEqual([]);

    // Preview shows the same suffix as the request it would send.
    const preview = compiler.preview(
      { ...input, turnNote: "Write the fight in short beats." },
      binding,
    );
    expect(preview.initialAppend?.afterPlayer?.logical).toEqual({
      kind: "runtime_notice",
      notice: "turn_guide",
      text: withNote.turnGuide!.text,
    });

    // With no preset or world line, the request alone still forms a suffix.
    const quiet = bindingFrom(
      filesWith("en", (items) =>
        items.map((entry) =>
          entry.kind === "builtin" ? { ...entry, turnGuide: "" } : entry,
        ),
      ),
    );
    const alone = compiler.compilePlayCallChain(
      { ...input, turnNote: "Keep it brief." },
      quiet,
    ).bootstrap;
    expect(alone.turnGuide?.lines).toEqual([
      {
        source: "player:turn",
        text: "Player's request for this turn: Keep it brief.",
      },
    ]);
    expect(alone.turnGuide?.text.startsWith(turnGuideHeader("en"))).toBe(true);
  });

  test("the Runtime header names only the source of the suffix, in both locales", () => {
    expect(turnGuideHeader("zh-CN")).toBe(
      "[Runtime 本轮提示]\n以下是对这一轮正文的提示，来自预设、世界设定和玩家的临时要求。不要回应本提示，直接写正文。",
    );
    expect(turnGuideHeader("en")).toBe(
      "[Runtime turn guide]\nThese are notes for this turn's prose, from the preset, the world, and the player's requests for this turn. Do not reply to this notice; write the prose.",
    );
  });

  test("a preset without any line sends no suffix", () => {
    const binding = bindingFrom(
      filesWith("en", (items) =>
        items.map((entry) =>
          entry.kind === "builtin" ? { ...entry, turnGuide: "" } : entry,
        ),
      ),
    );
    expect(compile("en", binding).turnGuide).toBeUndefined();
  });

  test("multi-line tail bodies and turn-guide lines are rejected by the preset parser", () => {
    for (const edit of [
      (items: Entry[]) => [
        {
          id: "tail-bad",
          kind: "tail",
          name: "Bad",
          enabled: true,
          body: "two\nlines",
        },
        ...items,
      ],
      (items: Entry[]) =>
        items.map((entry) =>
          entry.builtin === "play.ending"
            ? { ...entry, turnGuide: "two\nlines" }
            : entry,
        ),
      (items: Entry[]) => [
        {
          id: "tail-role",
          kind: "tail",
          name: "Role",
          enabled: true,
          body: "fine",
          messageRole: "user",
        },
        ...items,
      ],
    ])
      expect(parsePlayPresetFiles(filesWith("en", edit)).kind).toBe("invalid");
  });

  test("soft limits warn without blocking compilation", () => {
    const long = "x".repeat(turnGuideLineSoftLimit + 1);
    expect(turnGuideWarnings([{ text: "fine" }, { text: long }])).toEqual([
      { kind: "line_length", index: 1 },
    ]);
    expect(
      turnGuideWarnings(
        Array.from({ length: turnGuideLinesSoftLimit + 1 }, () => ({
          text: "fine",
        })),
      ),
    ).toEqual([{ kind: "line_count" }]);
    const binding = bindingFrom(
      filesWith("en", (items) => [
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `tail-${index}`,
          kind: "tail",
          name: `Tail ${index}`,
          enabled: true,
          body: index === 0 ? long : `Line ${index}`,
        })),
        ...items,
      ]),
    );
    const bootstrap = compile("en", binding);
    expect(bootstrap.turnGuide?.lines).toHaveLength(12);
    expect(turnGuideWarnings(bootstrap.turnGuide!.lines)).toEqual([
      { kind: "line_length", index: 0 },
      { kind: "line_count" },
    ]);
  });
});

describe("restructure migration", () => {
  /** A v2 preset as the release before the one-rule blocks saved it. */
  function composedFiles(extra: Entry[] = []): Record<string, string> {
    return filesWith("en", () => [
      {
        id: "play.mechanics",
        kind: "builtin",
        builtin: "play.mechanics",
        enabled: true,
      },
      ...extra,
      {
        id: "play.style",
        kind: "builtin",
        builtin: "play.style",
        enabled: true,
        messageRole: "user",
      },
      {
        id: "play.person-second",
        kind: "builtin",
        builtin: "play.person-second",
        enabled: true,
      },
      {
        id: "play.person-first",
        kind: "builtin",
        builtin: "play.person-first",
        enabled: false,
      },
      {
        id: "play.person-third",
        kind: "builtin",
        builtin: "play.person-third",
        enabled: false,
      },
      {
        id: "play.adjudication",
        kind: "builtin",
        builtin: "play.adjudication",
        enabled: false,
      },
      {
        id: "play.narrative",
        kind: "builtin",
        builtin: "play.narrative",
        enabled: true,
      },
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
      {
        id: "play.state",
        kind: "builtin",
        builtin: "play.state",
        enabled: true,
      },
      {
        id: "play.tabletop",
        kind: "builtin",
        builtin: "play.tabletop",
        enabled: true,
      },
      { id: "world", kind: "world" },
    ]);
  }

  test("retired composite blocks are replaced in place, inheriting enabled state and message role", () => {
    const files = composedFiles();
    const migrated = withRestructuredPromptBuiltins(files);
    const list = playList(migrated);
    expect(list.map(({ id }) => id)).toEqual([
      "play.mechanics",
      "play.prose",
      "play.scene",
      "play.person-second",
      "play.person-first",
      "play.person-third",
      "play.agency-default",
      "play.agency-strict",
      "play.agency-open",
      "play.facts",
      "play.npc",
      "play.stop-beat",
      "play.stop-scene",
      "play.ending",
      "play.output",
      "play.continue-stage",
      "play.continue-advance",
      "play.save-timing",
      "play.ownership",
      "play.situation",
      "play.checkpoint-policy",
      "play.tabletop",
      "world",
    ]);
    const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
    expect(byId["play.prose"]).toEqual({
      id: "play.prose",
      kind: "builtin",
      builtin: "play.prose",
      enabled: true,
      messageRole: "user",
    });
    expect(byId["play.scene"]).toMatchObject({
      enabled: true,
      messageRole: "user",
    });
    // A disabled composite leaves every successor off, including the
    // alternatives that would otherwise start disabled anyway.
    for (const id of [
      "play.agency-default",
      "play.agency-strict",
      "play.agency-open",
      "play.facts",
      "play.npc",
    ])
      expect(byId[id]).toMatchObject({ enabled: false });
    expect(byId[id("play.agency-default")]).not.toHaveProperty("messageRole");
    expect(byId["play.stop-beat"]).toMatchObject({ enabled: true });
    expect(byId["play.stop-scene"]).toMatchObject({ enabled: false });
    expect(byId["play.ending"]).toMatchObject({ enabled: true });
    for (const retired of retiredPlayBuiltins)
      expect(byId[retired]).toBeUndefined();
    // Idempotent, and a successor already listed is not duplicated.
    expect(withRestructuredPromptBuiltins(migrated)).toBe(migrated);
    const withProse = composedFiles([
      {
        id: "play.prose",
        kind: "builtin",
        builtin: "play.prose",
        enabled: false,
      },
    ]);
    const ids = playList(withRestructuredPromptBuiltins(withProse)).map(
      ({ id }) => id,
    );
    expect(ids.filter((entry) => entry === "play.prose")).toHaveLength(1);
    expect(ids.slice(0, 3)).toEqual([
      "play.mechanics",
      "play.prose",
      "play.scene",
    ]);

    // The combined migration yields a valid preset that compiles without
    // any retired source.
    const current = withCurrentPromptBuiltins(files);
    const binding = bindingFrom(current);
    const sources = compile("en", binding).logicalMessages.flatMap(
      ({ blocks }) => blocks.map(({ source }) => source),
    );
    for (const retired of retiredPlayBuiltins)
      expect(sources).not.toContain(`runtime:ordered/${retired}`);
    expect(sources).toContain("runtime:ordered/play.prose");
    expect(sources).toContain("runtime:ordered/play.stop-beat");
    expect(sources).not.toContain("runtime:ordered/play.agency-default");
  });

  test("a frozen binding captured before the restructure still validates and compiles as its successors", () => {
    const files = composedFiles();
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    // The parser reads retired entries as the blocks that replaced them.
    expect(
      parsed.definition.playPrompts?.map(({ id }) => id).slice(0, 3),
    ).toEqual(["play.mechanics", "play.prose", "play.scene"]);
    const stale = structuredClone(parsed.definition);
    // A session stored before the restructure froze the old list verbatim.
    stale.playPrompts = playList(files) as NonNullable<
      typeof stale.playPrompts
    >;
    const binding = {
      id: "frozen",
      name: "frozen",
      revision: revisionForPlayPresetFiles(files),
      definition: stale,
      files,
      scriptsEnabled: true,
    };
    expect(isPlayPresetBinding(binding)).toBe(true);
    const sources = compile("en", binding).logicalMessages.flatMap(
      ({ blocks }) => blocks.map(({ source }) => source),
    );
    expect(sources).toContain("runtime:ordered/play.prose");
    for (const retired of retiredPlayBuiltins)
      expect(sources).not.toContain(`runtime:ordered/${retired}`);
  });

  test("the store migrates a stored composed preset on load and keeps the original revision", async () => {
    const files = composedFiles();
    const root = await mkdtemp(join(tmpdir(), "restructure-migration-"));
    roots.push(root);
    const currentRevision = revisionForPlayPresetFiles(files);
    await writeFile(
      join(root, "file-native-play-presets.json"),
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
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    // The library is neither quarantined nor replaced by the seed preset.
    expect(store.recovery).toBeNull();
    const bound = await store.bindCurrent();
    expect(bound.id).toBe("mine");
    expect(bound.revision).not.toBe(currentRevision);
    const ids = playList(bound.files).map(({ id }) => id);
    for (const retired of retiredPlayBuiltins)
      expect(ids).not.toContain(retired);
    expect(ids.slice(0, 3)).toEqual([
      "play.mechanics",
      "play.prose",
      "play.scene",
    ]);
    expect(bound.files).toEqual(withCurrentPromptBuiltins(files));
    // The old revision stays readable for frozen requests: its bytes are kept
    // as written and its retired entries parse as their successors.
    const old = await store.bindRevision("mine", currentRevision);
    expect(old.revision).toBe(currentRevision);
    expect(old.files).toEqual(files);
    expect(
      old.definition.playPrompts?.map((entry) => entry.id).slice(0, 3),
    ).toEqual(["play.mechanics", "play.prose", "play.scene"]);
  });
});

function id(value: string): string {
  return value;
}
