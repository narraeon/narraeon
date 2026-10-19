import { parseDocument, stringify } from "yaml";
import { describe, expect, test } from "vitest";

import type { Gameplay } from "../../src/protocol/gameplay.ts";
import {
  builtinAuthorPrompts,
  defaultOrderedAuthorPrompts,
} from "../../src/shared/ordered-author-prompts.ts";
import {
  builtinPlayPrompts,
  defaultOrderedPlayPrompts,
  type OrderedPlayPrompt,
} from "../../src/shared/ordered-play-prompts.ts";
import {
  tabletopAuthorBody,
  tabletopPlayBody,
} from "../../src/shared/tabletop-guidance.ts";
import { parseOrderedPlayPrompts } from "../../src/runtime/play/OrderedPlayPrompts.ts";
import {
  builtinDefaultPlayPresetBinding,
  defaultPlayPresetFilesForLocale,
  legacyDefaultPlayPresetFilesForLocale,
  parseOrderedAuthorPrompts,
  parsePlayPresetFiles,
  toPlayPresetStructuredEditor,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  type PromptCompilation,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const fiction: Gameplay = { mode: "interactive-fiction" };
const tabletop: Gameplay = { mode: "tabletop", scheme: "d20" };
const tabletopSource = "runtime:ordered/play.tabletop";

/** Preset files with the given ordered lists; everything else stays default. */
function presetBinding(options: {
  playPrompts?: OrderedPlayPrompt[];
  authorPrompts?: OrderedPlayPrompt[];
}): PlayPresetBinding {
  const files = { ...defaultPlayPresetFilesForLocale("en") };
  const preset = parseDocument(files["preset.yaml"]!);
  if (options.playPrompts !== undefined)
    preset.set("playPrompts", options.playPrompts);
  if (options.authorPrompts !== undefined)
    preset.set("authorPrompts", options.authorPrompts);
  files["preset.yaml"] = stringify(preset.toJS());
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "scope",
    name: "scope",
    revision: "rev-scope",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function defaultPlayList(): OrderedPlayPrompt[] {
  return structuredClone(defaultOrderedPlayPrompts());
}

function defaultAuthorList(): OrderedPlayPrompt[] {
  return structuredClone(defaultOrderedAuthorPrompts());
}

/** Playing messages without the tabletop builtin: the released fiction shape. */
function withoutTabletopBuiltins(): OrderedPlayPrompt[] {
  return defaultPlayList().filter(
    (entry) => !(entry.kind === "builtin" && entry.builtin === "play.tabletop"),
  );
}

function sources(compilation: PromptCompilation): string[] {
  return compilation.logicalMessages.flatMap(({ blocks }) =>
    blocks.map(({ source }) => source),
  );
}

describe("tabletop builtins and defaults", () => {
  test("play.tabletop and author.tabletop are optional, tabletop-scoped builtins", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const play = builtinPlayPrompts(locale).find(
        ({ id }) => id === "play.tabletop",
      )!;
      expect(play).toMatchObject({
        required: false,
        gameplay: "tabletop",
        body: tabletopPlayBody(locale),
      });
      const author = builtinAuthorPrompts(locale).find(
        ({ id }) => id === "author.tabletop",
      )!;
      expect(author).toMatchObject({
        required: false,
        gameplay: "tabletop",
        body: tabletopAuthorBody(locale),
      });
    }
    expect(builtinAuthorPrompts("en").map(({ id }) => id)).toEqual([
      "author.mechanics",
      "author.guidance",
      "author.tabletop",
      "author.target",
      "author.play-reference",
    ]);
  });

  test("defaults enable play.tabletop before the world placeholder and author.tabletop after author.guidance", () => {
    const play = defaultOrderedPlayPrompts();
    expect(play.at(-2)).toEqual({
      id: "play.tabletop",
      kind: "builtin",
      builtin: "play.tabletop",
      enabled: true,
    });
    expect(play.at(-1)).toEqual({ id: "world", kind: "world" });
    const author = defaultOrderedAuthorPrompts();
    const index = author.findIndex(({ id }) => id === "author.tabletop");
    expect(author[index]).toMatchObject({ enabled: true });
    expect(author[index - 1]).toMatchObject({ id: "author.guidance" });
  });

  test("user entries accept an optional tabletop scope and reject other scopes", () => {
    const mechanics = {
      id: "play.mechanics",
      kind: "builtin",
      builtin: "play.mechanics",
      enabled: true,
    };
    const world = { id: "world", kind: "world" };
    const base = {
      id: "custom",
      kind: "user",
      name: "Custom",
      enabled: true,
      body: "text",
    };
    const entryOf = (entry: object) =>
      parseOrderedPlayPrompts([mechanics, entry, world])[1];
    expect(entryOf(base)).toEqual(base);
    expect(entryOf({ ...base, gameplay: "tabletop" })).toEqual({
      ...base,
      gameplay: "tabletop",
    });
    expect(() => entryOf({ ...base, gameplay: "fiction" })).toThrow(
      /Invalid ordered play prompts/u,
    );
    expect(() =>
      parseOrderedPlayPrompts([{ ...mechanics, gameplay: "tabletop" }, world]),
    ).toThrow(/Invalid ordered play prompts/u);
    const authorMechanics = {
      id: "author.mechanics",
      kind: "builtin",
      builtin: "author.mechanics",
      enabled: true,
    };
    expect(
      parseOrderedAuthorPrompts([
        authorMechanics,
        { ...base, gameplay: "tabletop" },
        {
          id: "author.target",
          kind: "builtin",
          builtin: "author.target",
          enabled: true,
        },
      ])[1],
    ).toEqual({ ...base, gameplay: "tabletop" });
  });

  test("a legacy v1 preset converts with play.tabletop before the world and author.tabletop in author order", () => {
    const parsed = parsePlayPresetFiles(
      legacyDefaultPlayPresetFilesForLocale("en"),
    );
    if (parsed.kind !== "valid") throw parsed.error;
    const editor = toPlayPresetStructuredEditor(parsed.definition);
    const playPrompts = editor.playPrompts!;
    const worldIndex = playPrompts.findIndex(({ kind }) => kind === "world");
    expect(playPrompts[worldIndex - 1]).toMatchObject({
      kind: "builtin",
      builtin: "play.tabletop",
      enabled: true,
    });
    expect(
      editor.authorPrompts!.map((entry) =>
        entry.kind === "builtin" ? entry.builtin : entry.kind,
      ),
    ).toContain("author.tabletop");
  });
});

describe("tabletop-scoped prompts in play compilation", () => {
  test("play.tabletop compiles for tabletop worlds and disappears for fiction without changing fiction output", () => {
    const compiler = new FileNativePromptCompiler();
    const withTabletop = presetBinding({ playPrompts: defaultPlayList() });
    const released = presetBinding({
      playPrompts: withoutTabletopBuiltins(),
    });

    const onTabletop = compiler.compilePlayCallChain(
      previewInputWithGameplay(tabletop),
      withTabletop,
    ).bootstrap;
    expect(sources(onTabletop)).toContain(tabletopSource);
    const tabletopMessage = onTabletop.logicalMessages.find(({ blocks }) =>
      blocks.some(({ source }) => source === tabletopSource),
    )!;
    expect(tabletopMessage.promptId).toBe("play.tabletop");
    expect(tabletopMessage.messageRole).toBe("system");

    const fictionWith = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction),
      withTabletop,
    ).bootstrap;
    const fictionReleased = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction),
      released,
    ).bootstrap;
    expect(sources(fictionWith)).not.toContain(tabletopSource);
    expect(JSON.stringify(fictionWith)).toEqual(
      JSON.stringify(fictionReleased),
    );
  });

  test("tabletop user entries compile only for tabletop worlds", () => {
    const compiler = new FileNativePromptCompiler();
    const list = defaultPlayList();
    list.splice(list.length - 1, 0, {
      id: "my-tabletop-rule",
      kind: "user",
      name: "Mine",
      enabled: true,
      body: "# 我的跑团规则\n\n只在跑团世界生效。",
      gameplay: "tabletop",
    });
    const binding = presetBinding({ playPrompts: list });
    const released = presetBinding({
      playPrompts: list.filter(({ id }) => id !== "my-tabletop-rule"),
    });
    const tabletopSources = sources(
      compiler.compilePlayCallChain(previewInputWithGameplay(tabletop), binding)
        .bootstrap,
    );
    expect(tabletopSources).toContain("preset:prompt/my-tabletop-rule");
    const fictionCompiled = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction),
      binding,
    ).bootstrap;
    expect(sources(fictionCompiled)).not.toContain(
      "preset:prompt/my-tabletop-rule",
    );
    expect(JSON.stringify(fictionCompiled)).toEqual(
      JSON.stringify(
        compiler.compilePlayCallChain(
          previewInputWithGameplay(fiction),
          released,
        ).bootstrap,
      ),
    );
  });
});

describe("tabletop-scoped prompts in authoring compilation", () => {
  function authoring(gameplay: Gameplay, binding: PlayPresetBinding) {
    const compiler = new FileNativePromptCompiler();
    const input = previewInputWithGameplay(gameplay);
    return compiler.compileSettingImprovement({
      contentPackageTitle: "Scope package",
      runtimeContract: settingImprovementRuntimeContract("en", gameplay),
      authorPrompt: "author",
      playPreset: binding,
      modelBinding: input.modelBinding,
      tools: settingImprovementToolDefinitions("en", gameplay),
      gameplay,
    });
  }

  test("author.tabletop and the play-reference expansion include tabletop prompts only for tabletop packages", () => {
    const binding = presetBinding({
      playPrompts: defaultPlayList(),
      authorPrompts: defaultAuthorList(),
    });
    const onTabletop = authoring(tabletop, binding);
    expect(sources(onTabletop)).toContain("play-preset:author/author.tabletop");
    const reference = onTabletop.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .find(({ source }) => source === "play-preset:author-reference")!;
    expect(reference.markdown).toContain("### preset:builtin/play.tabletop");

    const onFiction = authoring(fiction, binding);
    expect(sources(onFiction)).not.toContain(
      "play-preset:author/author.tabletop",
    );
    const fictionReference = onFiction.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .find(({ source }) => source === "play-preset:author-reference")!;
    expect(fictionReference.markdown).not.toContain("play.tabletop");
  });

  test("fiction authoring output equals the output of a preset without tabletop entries", () => {
    const withEntries = presetBinding({
      playPrompts: defaultPlayList(),
      authorPrompts: defaultAuthorList(),
    });
    const released = presetBinding({
      playPrompts: withoutTabletopBuiltins(),
      authorPrompts: defaultAuthorList().filter(
        ({ id }) => id !== "author.tabletop",
      ),
    });
    expect(JSON.stringify(authoring(fiction, withEntries))).toEqual(
      JSON.stringify(authoring(fiction, released)),
    );
  });

  test("the builtin default binding keeps working for direct authoring compilation", () => {
    expect(
      sources(authoring(tabletop, builtinDefaultPlayPresetBinding("en"))),
    ).toContain("play-preset:author/author.tabletop");
  });
});
