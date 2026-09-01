import { rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  presetHostBinding,
  validatePlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { defaultPresetHostFiles } from "../../src/shared/default-preset-host.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { defaultNarrationPrompt } from "../../src/shared/default-play-prompts.ts";
import {
  defaultSettingImprovementPrompt,
  defaultSettingImprovementPromptPath,
} from "../../src/shared/default-setting-improvement-prompt.ts";
import { firstPartyGenericPanelsPresetFiles } from "../../src/shared/first-party-generic-panels.ts";
import { firstPartyStatusPanelPresetFiles } from "../../src/shared/first-party-player-view.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("默认提示词职责", () => {
  test("默认与第一方玩法模板逐字共用调用链叙事语义", () => {
    const presets = [
      defaultPlayPresetFiles,
      firstPartyActionChoicesPresetFiles,
      firstPartyStatusPanelPresetFiles,
      firstPartyGenericPanelsPresetFiles,
    ];

    for (const files of presets) {
      expect(files["prompts/narrate.md"]).toBe(defaultNarrationPrompt);
      expect(files[defaultSettingImprovementPromptPath]).toBe(
        defaultSettingImprovementPrompt,
      );
      expect(files["preset.yaml"]).toContain(
        `markdown: ${defaultSettingImprovementPromptPath}`,
      );
      expect(files).not.toHaveProperty("prompts/policy.md");
      expect(files["call-chain.yaml"]).not.toContain("prompts/policy.md");
    }

    expect(defaultNarrationPrompt).toContain("Do not alter settled results");
    // A document-only change is invisible to the player, so prose must stage it.
    expect(defaultNarrationPrompt).toContain("must be dramatized here");
    expect(defaultNarrationPrompt).toContain(
      "effectively did not happen for them",
    );
    expect(defaultNarrationPrompt).toContain(
      "available to later model requests",
    );
    expect(defaultNarrationPrompt).toContain(
      "Whenever you produce player-visible story text",
    );
    // Player-visible prose is novel text, not a line-by-line process report.
    expect(defaultNarrationPrompt).toContain(
      "body of an interactive novel, not a process report",
    );
    expect(defaultNarrationPrompt).toContain("several natural paragraphs");
    expect(defaultNarrationPrompt).not.toContain("length covers only");
    // The final sentence must be a concrete event, not host voice in disguise.
    expect(defaultNarrationPrompt).toContain(
      "Make the final sentence a specific action someone takes",
    );
    expect(defaultNarrationPrompt).toContain("Silence is not an event");
    expect(defaultNarrationPrompt).toContain("two pairs of eyes return to you");
    expect(defaultNarrationPrompt).toContain("dressed in prose");
    expect(defaultNarrationPrompt).not.toContain(
      "someone waits for his answer",
    );
    // Agency protects consequential decisions while allowing supporting action.
    expect(defaultNarrationPrompt).toContain("belongs to the player");
    expect(defaultNarrationPrompt).toContain("do not take agency away");
    expect(defaultNarrationPrompt).not.toContain("second person");
    expect(defaultSettingImprovementPrompt).toContain(
      "Recommended setting-improvement method",
    );
    expect(defaultSettingImprovementPrompt).toContain(
      "first page of this interactive novel",
    );
    expect(defaultSettingImprovementPrompt).toContain(
      "read control/frame.yaml",
    );
    expect(defaultSettingImprovementPrompt).toContain("discovery path");
    expect(defaultSettingImprovementPrompt).toContain("future update path");
    expect(defaultSettingImprovementPrompt).not.toContain("setting_write_file");
    expect(defaultSettingImprovementPrompt).not.toContain("参数 schema");
    expect(
      firstPartyActionChoicesPresetFiles["prompts/options.md"],
    ).not.toContain("artifact_emit");
    expect(
      firstPartyGenericPanelsPresetFiles["prompts/panels.md"],
    ).not.toContain("artifact_emit");
  });

  test("主持层承担通用状态判据，世界 scaffold 只承担世界特有语义", () => {
    const style = defaultPresetHostFiles["blocks/style.md"]!;
    const agency = defaultPresetHostFiles["blocks/adjudication.md"]!;
    const state = defaultPresetHostFiles["blocks/state.md"]!;
    const frame = defaultPresetHostFiles["frame.yaml"]!;

    expect(style).toContain("Address the player character as “you”");
    expect(style).not.toContain("the world prompt frame explicitly states");
    expect(style).not.toContain("length covers only");
    expect(style).not.toContain("Runtime");
    // Cross-world prose guidance belongs to the host preset.
    expect(style).toContain("This is an interactive novel");
    expect(style).toContain("Begin with the player's input");
    expect(style).toContain("Give the prose the texture of a novel");
    // Rich prose still must not become padding.
    expect(style).toContain("not repeating known background");
    // Inventorying everyone is a list with different punctuation, not prose.
    expect(style).toContain("Do not inventory everyone by name");
    expect(style).toContain("Once a name is known, use it");
    expect(agency).toContain(
      "explicit expression in the player's current input",
    );
    expect(agency).not.toContain(
      "once the situation again needs a player choice",
    );
    // Agency is divided by consequential choice, not by who performs a movement.
    expect(agency).toContain("What may be performed for the player");
    expect(agency).not.toContain("apparently convenient follow-up action");
    // NPCs are not devices that react only after the player moves.
    expect(agency).toContain("NPCs have lives of their own");
    expect(agency).not.toContain("reactions to actions already carried out");
    // The host handles autonomous NPC results and offstage progress.
    expect(agency).toContain(
      "same kind of results as those created by the player",
    );
    expect(agency).toContain("People offstage still move forward");
    expect(agency).toContain("not that they are paused");
    expect(agency).toContain(
      "do not need to simulate everyone after every action",
    );
    expect(state).toContain("Gather material before adjudicating");
    expect(state).toContain(
      "even if the directory already shows a matching entry",
    );
    expect(state).toContain(
      "A call chain may legitimately change no documents",
    );
    expect(state).toContain("experience of failure itself");
    expect(state).toContain("A promise that has been made may be saved");
    expect(state).toContain("Where to save results");
    expect(state).toContain("Converging the current situation");
    // Perceivable document changes must also appear in player-visible prose.
    expect(state).toContain("The player can read only the narrative");
    expect(state).toContain("A change left only in a document did not happen");
    expect(state).toContain("both describe the same events");
    // Autonomous NPC actions and offstage progress use the same persistence test.
    expect(state).toContain(
      "not only direct consequences of the player's action",
    );
    // Removing presence must not delete a person's ongoing state.
    expect(state).toContain(
      "the scene is losing their presence, not the person",
    );
    expect(state).not.toMatch(
      /character document|place document|item document/u,
    );
    expect(frame.indexOf("blocks/style.md")).toBeLessThan(
      frame.indexOf("blocks/adjudication.md"),
    );
    expect(frame.indexOf("blocks/adjudication.md")).toBeLessThan(
      frame.indexOf("blocks/state.md"),
    );
    expect(frame.indexOf("blocks/state.md")).toBeLessThan(
      frame.indexOf("world.instructions"),
    );

    // The shipped scaffold is a prose example and must not use host voice.
    const opening = minimalFileNativeContentScaffold().find(
      ({ path }) => path === "opening.md",
    )?.contents;
    expect(opening).not.toMatch(
      /what do you do|what will you do|you can choose/iu,
    );

    const world = minimalFileNativeContentScaffold().find(
      ({ path }) => path === "control/blocks/world.md",
    )?.contents;
    expect(world).toContain("Keep only rules unique to this world");
    expect(world).toContain("World documents and where changes belong");
    expect(world).toContain("Special rules");
    expect(world).not.toContain("If the next action began without it");
    expect(
      inspectContentPackageCurrentTree(minimalFileNativeContentScaffold())
        .status,
    ).toBe("usable");
  });

  test("后置请求携带自己的 Runtime 契约，主链只拿到读写工具", () => {
    const files = structuredClone(firstPartyActionChoicesPresetFiles);
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    const binding = {
      id: "first-party-action-choices",
      name: "action-choices-recommended",
      revision: "v1",
      definition: parsed.definition,
      files,
      scriptsEnabled: true,
    };
    const preview = new FileNativePromptCompiler().previewPlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "prompt-contract-test",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        playerInput: "I try to push the door open.",
        playerInputPlacement: "append",
      }),
      binding,
    );

    const followups = preview.playPreset!.followups;
    expect(followups.map(({ id }) => id)).toEqual(["player_options"]);
    const contract = followups[0]!.logicalMessages[0]!.markdown;
    // A follow-up states that it runs once after commit and may emit artifacts only.
    expect(contract).toContain(
      "core narrative and world state have already been committed",
    );
    expect(contract).toContain("dispatched once and has no later round trip");
    expect(contract).toContain("output=player_options");
    expect(contract).toContain("channel=player.options");
    expect(followups[0]!.allowedTools).toEqual([
      "artifact_emit",
      "artifact_clear",
    ]);
  });
});

describe("提示块启用清单", () => {
  test("frame.yaml 决定哪些块进入模型，未列出的块留在树里", () => {
    const withExtraStyle: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "blocks/style-noir.md": "# Noir\n\nShort sentences. No explanations.\n",
    };

    // An unreferenced block remains valid but does not enter the prompt.
    expect(validatePlayPresetFiles(withExtraStyle)).toEqual({
      status: "valid",
    });
    expect(authorBlockSources(withExtraStyle)).not.toContain(
      "host:blocks/style-noir.md",
    );

    // Listing a block enables it, and style blocks may be stacked.
    const bothEnabled: Record<string, string> = {
      ...withExtraStyle,
      "frame.yaml": withExtraStyle["frame.yaml"]!.replace(
        "    - markdown: blocks/style.md\n",
        "    - markdown: blocks/style.md\n    - markdown: blocks/style-noir.md\n",
      ),
    };
    expect(authorBlockSources(bothEnabled)).toEqual([
      "host:blocks/style.md",
      "host:blocks/style-noir.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);

    // Removing a block from the frame excludes its text but keeps the file.
    const disabled: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "frame.yaml": defaultPlayPresetFiles["frame.yaml"]!.replace(
        "    - markdown: blocks/adjudication.md\n",
        "",
      ),
    };
    expect(authorBlockSources(disabled)).not.toContain(
      "host:blocks/adjudication.md",
    );
    expect(disabled["blocks/adjudication.md"]).toContain(
      "NPCs have lives of their own",
    );
  });
});

function authorBlockSources(files: Record<string, string>): string[] {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  const binding = {
    id: "enable-list-preset",
    name: parsed.definition.name,
    revision: "rev-enable-list",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "enable-list-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    playerInput: "I push through the door.",
    playerInputPlacement: "append",
  });
  input.hostBinding = presetHostBinding(binding);
  return (
    new FileNativePromptCompiler()
      .compilePlayCallChain(input, binding)
      .bootstrap.logicalMessages.find(
        ({ role }) => role === "author_instruction",
      )
      ?.blocks.map(({ source }) => source) ?? []
  );
}

describe("文风块库", () => {
  test("通用块讲变速，六种文风预置在库里但默认不启用", () => {
    const style = defaultPresetHostFiles["blocks/style.md"]!;
    // The general style requires detail where it matters, not only anti-padding.
    expect(style).toContain("Slow down where it matters");
    expect(style).toContain("Raising a hand may take three lines");
    expect(style).toContain("Padding repeats the same fact in different words");
    // The player character's own bodily experience may be stated directly.
    expect(style).toContain(
      "player character's own bodily experience may be stated directly",
    );
    expect(defaultNarrationPrompt).toContain(
      "weight of the moment determine length",
    );

    const styles = Object.keys(defaultPresetHostFiles)
      .filter((path) => path.startsWith("blocks/style-"))
      .sort();
    expect(styles).toEqual([
      "blocks/style-action.md",
      "blocks/style-horror.md",
      "blocks/style-intimate.md",
      "blocks/style-literary.md",
      "blocks/style-noir.md",
      "blocks/style-wuxia.md",
    ]);

    // Shipped does not mean enabled: frame.yaml lists only the general block.
    const frame = defaultPresetHostFiles["frame.yaml"]!;
    expect(frame).toContain("markdown: blocks/style.md");
    for (const path of styles) expect(frame).not.toContain(path);
    expect(authorBlockSources(defaultPlayPresetFiles)).toEqual([
      "host:blocks/style.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });

  test("情感文风要求把动作拆开并让触觉打头，且可以和别的文风叠加", () => {
    const intimate = defaultPresetHostFiles["blocks/style-intimate.md"]!;
    expect(intimate).toContain(
      "Do not skip the process and state only the conclusion",
    );
    expect(intimate).toContain("Put touch first");
    expect(intimate).toContain("One action may take three or four lines");
    // Familiar metaphors must return to a concrete location instead of replacing detail.
    expect(intimate).toContain(
      "it replaces description instead of completing it",
    );
    // Intimate scenes preserve both player agency and NPC autonomy.
    expect(intimate).toContain(
      "Do not make them agree merely because the mood is right",
    );

    const stacked: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "frame.yaml": defaultPresetHostFiles["frame.yaml"]!.replace(
        "    - markdown: blocks/style.md\n",
        "    - markdown: blocks/style.md\n    - markdown: blocks/style-intimate.md\n    - markdown: blocks/style-wuxia.md\n",
      ),
    };
    expect(authorBlockSources(stacked)).toEqual([
      "host:blocks/style.md",
      "host:blocks/style-intimate.md",
      "host:blocks/style-wuxia.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });
});
