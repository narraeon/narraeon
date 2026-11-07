import { expect, test } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { builtinPlayPrompts } from "../../src/shared/ordered-play-prompts.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
  SettingAuthoringTransaction,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const contracts = {
  "zh-CN": {
    author: [
      "新建内容包或用户要求完善玩法方向时",
      "实际由 control/frame.yaml 的 instructions 引用的世界主持块",
      "定向修改一个道具不需要顺手重写世界方向",
      "仅完善已有世界的玩法方向时，只需补或改该块里的一两句",
      "这段写给主持，不复制开场原文、当前事实、谜底或人物秘密",
    ],
    focus: "在这个世界提供的玩法中，跟随玩家此刻投入的事",
    selection: [
      "本轮明确意图优先",
      "近几轮行为",
      "自然、可观察的反馈",
      "直接告诉玩家可知的结果，保持证据支持的确定程度",
      "只有玩家表示要说出口时",
      "当场可感知的重要后果",
    ],
  },
  en: {
    author: [
      "When creating a content package or asked to develop its play direction",
      "world GM block actually referenced by control/frame.yaml instructions",
      "a targeted prop edit need not rewrite the world's direction",
      "When only developing an existing world's play direction, just add or revise those one or two sentences",
      "This paragraph addresses the GM: do not copy opening prose, current facts, solutions or character secrets into it",
    ],
    focus:
      "Within the play this world offers, follow what the player is engaged in now",
    selection: [
      "Prioritize this turn's explicit intent",
      "recent turns",
      "natural, observable feedback",
      "tell the player what can be known at the certainty supported by the evidence",
      "Only turn that inference into character dialogue when the player expresses an intent to say it aloud",
      "important consequences perceptible on the spot",
    ],
  },
};

test.each(["en", "zh-CN"] as const)(
  "%s authoring and fresh play compile world direction and current-focus guidance at their own layer",
  (locale: AppLocale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const preset = builtinDefaultPlayPresetBinding(locale);
    const input = createMinimalFileNativePreviewInput({
      locale,
      provider: "chat_completions",
      modelId: "play-focus-acceptance",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4096,
      playerInput: "I wait for her answer.",
      playerInputPlacement: "append",
    });
    const author = compiler.compileSettingImprovement({
      contentPackageTitle: "Two paths",
      gameplay: fictionGameplay,
      runtimeContract: settingImprovementRuntimeContract(
        locale,
        fictionGameplay,
      ),
      authorPrompt: "Author the world.",
      playPreset: preset,
      modelBinding: input.modelBinding,
      tools: settingImprovementToolDefinitions(locale, fictionGameplay),
    });
    const authorText = author.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n");
    for (const phrase of contracts[locale].author)
      expect(authorText).toContain(phrase);

    const preview = compiler.preview(input, preset);
    const blocks = preview.compilation.logicalMessages.flatMap(
      ({ blocks }) => blocks,
    );
    const prose = blocks.find(
      ({ source }) => source === "runtime:ordered/play.prose",
    )!.markdown;
    expect(prose).toContain(contracts[locale].focus);
    for (const phrase of contracts[locale].selection)
      expect(prose).toContain(phrase);
    expect(
      blocks.filter(({ markdown }) =>
        markdown.includes(contracts[locale].focus),
      ),
    ).toHaveLength(1);
  },
);

test.each(["en", "zh-CN"] as const)(
  "%s an authored, frame-referenced world block reaches real play Preview once; disabling the generic policy has no fallback",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const preset = builtinDefaultPlayPresetBinding(locale);
    const input = createMinimalFileNativePreviewInput({
      locale,
      provider: "chat_completions",
      modelId: "author-to-play-focus",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4096,
      playerInput:
        locale === "zh-CN"
          ? "我把纸推回去，等她自己开口。"
          : "I push the paper back and wait for her to speak.",
      playerInputPlacement: "append",
    });
    input.hostBinding = presetHostBinding(preset);
    const preview = (snapshot: WorldDocumentStore) =>
      compiler.preview(
        {
          ...input,
          world: { ...input.world, documentSnapshot: snapshot },
        },
        preset,
      );
    const files = minimalFileNativeContentScaffold(locale);
    files.push({
      path: "control/blocks/unused.md",
      contents: "UNREFERENCED_WORLD_DIRECTION",
    });
    const transaction = new SettingAuthoringTransaction({
      baseFiles: files,
      locale,
      preview,
    });
    // These props and play threads are acceptance data, never shipped prompt rules.
    const worldDirection =
      locale === "zh-CN"
        ? "# 城堡里的玩法\n\n玩家可以观察证物、对照证言调查城堡谜案，也可以和证人共同办事、等待她自己开口来发展彼此关系。证物与人物动机由相应世界文档维护。\n"
        : "# Play in the castle\n\nThe player can inspect evidence and compare testimony to investigate the castle mystery, or develop a relationship with the witness by working together and letting her speak for herself. World documents hold evidence and character motives.\n";
    const frame = files.find(
      ({ path }) => path === "control/frame.yaml",
    )!.contents;
    const results = transaction.execute([
      {
        id: "read-frame",
        name: "setting_read",
        arguments: { path: "control/frame.yaml" },
      },
      {
        id: "write-direction",
        name: "setting_write_file",
        arguments: {
          path: "control/blocks/play-opportunities.md",
          contents: worldDirection,
        },
      },
      {
        id: "bind-direction",
        name: "setting_write_file",
        arguments: {
          path: "control/frame.yaml",
          contents: frame.replace(
            "blocks/world.md",
            "blocks/play-opportunities.md",
          ),
        },
      },
    ]);
    expect(results.every(({ isError }) => !isError)).toBe(true);
    const snapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: transaction.files(),
    });
    const enabled = preview(snapshot);
    expect(enabled.leakage.status).toBe("clean");
    const blocks = enabled.compilation.logicalMessages.flatMap(
      ({ blocks }) => blocks,
    );
    expect(
      blocks.filter(({ markdown }) => markdown.includes(worldDirection.trim())),
    ).toEqual([
      {
        source: "world:control/blocks/play-opportunities.md",
        markdown: worldDirection.trim(),
      },
    ]);
    const all = enabled.compilation.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n");
    expect(all).not.toContain("UNREFERENCED_WORLD_DIRECTION");
    expect(all.split(contracts[locale].focus)).toHaveLength(2);

    // The user's policy switch removes its body and any tail contribution.
    preset.definition.playPrompts = preset.definition.playPrompts!.map(
      (entry) =>
        entry.kind === "builtin" && entry.builtin === "play.prose"
          ? { ...entry, enabled: false }
          : entry,
    );
    const disabled = preview(snapshot);
    const disabledText = JSON.stringify(disabled);
    expect(disabledText).toContain(worldDirection.split("\n")[0]);
    expect(disabledText).not.toContain(contracts[locale].focus);
    expect(
      disabled.compilation.turnGuide?.lines.some(({ source }) =>
        source.includes("play.prose"),
      ),
    ).toBe(false);
    const author = compiler.compileSettingImprovement({
      contentPackageTitle: "Two paths",
      gameplay: fictionGameplay,
      runtimeContract: settingImprovementRuntimeContract(
        locale,
        fictionGameplay,
      ),
      authorPrompt: "Edit this prop only.",
      playPreset: preset,
      modelBinding: input.modelBinding,
      tools: settingImprovementToolDefinitions(locale, fictionGameplay),
    });
    expect(JSON.stringify(author)).not.toContain(contracts[locale].focus);

    // Old packages do not need a new field or a core-play paragraph to compile.
    const old = WorldDocumentStore.open({
      layout: "content_package",
      files: minimalFileNativeContentScaffold(locale),
    });
    expect(
      preview(old).compilation.logicalMessages.some(
        ({ role }) => role === "world_context",
      ),
    ).toBe(true);
  },
);

test.each(["en", "zh-CN"] as const)(
  "%s continuation, agency, stopping, styles and state policies compile independently without contradictory tails",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const input = createMinimalFileNativePreviewInput({
      locale,
      provider: "chat_completions",
      modelId: "play-focus-options",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4096,
      playerInput: 'I hand her the letter and ask, "Did you write it?"',
      playerInputPlacement: "append",
    });
    const phrases =
      locale === "zh-CN"
        ? {
            "continue-stage": [
              "本轮有新的角色行动或台词时",
              "两者在首个世界回应前都要出现",
              "条件未成立的后续行为按尝试或条件呈现",
              "特意写出的动作或话要演出来",
            ],
            "continue-advance": [
              "实际结果或回应起笔",
              "保留输入中的尝试与条件",
            ],
            "agency-default": ["走过走廊、敲门", "我把信交给他"],
            "agency-strict": ["可补写的玩家行为", "NPC 可以当轮接信并回应"],
            "agency-open": ["推进到何处由停笔块决定"],
            "stop-beat": [
              "明确要求略过的普通反馈",
              "新出现的关键条件",
              "不因一次停顿或一个新细节自动停笔",
            ],
            "stop-scene": [
              "明确留给自己的判断或回应前停",
              "不因一次停顿或一个新细节自动停笔",
            ],
            "style-intimate": ["距离和已经发生的触感", "没有接触时"],
            "style-noir": ["可感知的细节"],
            "style-action": ["已经成立的代价"],
            "style-literary": ["实际经过的时间"],
            "save-timing": ["下面各项分别规定保存时机"],
            situation: ["移出当前待办或标为过去", "不推测玩家的长期偏好"],
            "person-third": ["直接引语保留说话者的人称"],
          }
        : {
            "continue-stage": [
              "When this turn introduces new character action or dialogue",
              "both must appear before the first world response",
              "Conditional follow-through whose condition is unmet remains an attempt or condition",
              "deliberately written actions or words must be staged",
            ],
            "continue-advance": [
              "actual result or response",
              "Preserve attempts and conditions in the input",
            ],
            "agency-default": [
              "walking the corridor and knocking",
              "I hand him the letter",
            ],
            "agency-strict": [
              "player behavior you may fill in",
              "NPCs may take the letter and reply in this turn",
            ],
            "agency-open": ["The stopping block determines how far to advance"],
            "stop-beat": [
              "ordinary feedback the player explicitly asked to skip",
              "new consequential condition",
              "A pause or new detail alone does not require stopping",
            ],
            "stop-scene": [
              "judgment or response the player explicitly reserved",
              "A pause or new detail alone does not require stopping",
            ],
            "style-intimate": [
              "distance and touch that has already occurred",
              "Without contact",
            ],
            "style-noir": ["perceptible details"],
            "style-action": ["established costs"],
            "style-literary": ["time that actually elapsed"],
            "save-timing": [
              "The items below each specify their own save timing",
            ],
            situation: [
              "remove them from current pending work or mark them as past",
              "do not infer enduring player preferences",
            ],
            "person-third": ["Direct quotations retain the speaker's person"],
          };

    for (const [name, expected] of Object.entries(phrases)) {
      const preset = builtinDefaultPlayPresetBinding(locale);
      preset.definition.playPrompts = preset.definition.playPrompts!.map(
        (entry) =>
          entry.kind === "builtin"
            ? {
                ...entry,
                enabled: ["play.mechanics", `play.${name}`].includes(
                  entry.builtin,
                ),
              }
            : entry,
      );
      const preview = compiler.preview(input, preset);
      const body = preview.compilation.logicalMessages
        .flatMap(({ blocks }) => blocks)
        .find(
          ({ source }) => source === `runtime:ordered/play.${name}`,
        )!.markdown;
      for (const phrase of expected) expect(body).toContain(phrase);
      expect(preview.compilation.turnGuide?.text ?? "").not.toMatch(
        /触觉先于视觉|touch before sight|只在归玩家的决定|stop only at a decision|“我”“你”转为第三人称|“I” and “you” in the player's text become third person/u,
      );
      if (name === "continue-stage")
        expect(preview.compilation.turnGuide?.text).toContain(
          locale === "zh-CN" ? "同次已发起" : "newly initiated",
        );
      expect(
        builtinPlayPrompts(locale).find(({ id }) => id === `play.${name}`)
          ?.required,
      ).toBe(false);
      preset.definition.playPrompts = preset.definition.playPrompts.map(
        (entry) =>
          entry.kind === "builtin" && entry.builtin === `play.${name}`
            ? { ...entry, enabled: false }
            : entry,
      );
      const disabled = compiler.preview(input, preset).compilation;
      expect(
        disabled.logicalMessages
          .flatMap(({ blocks }) => blocks)
          .some(({ source }) => source === `runtime:ordered/play.${name}`),
      ).toBe(false);
      expect(
        disabled.turnGuide?.lines.some(
          ({ source }) => source === `preset:builtin/play.${name}`,
        ) ?? false,
      ).toBe(false);
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "%s tabletop keeps strict + scene and open + beat independent of continuation and the generic focus policy",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    for (const selected of [
      ["continue-stage", "agency-strict", "stop-scene"],
      ["continue-advance", "agency-open", "stop-beat"],
    ]) {
      const input = previewInputWithGameplay(
        { mode: "tabletop", scheme: "d20" },
        { locale, playerInputPlacement: "append" },
      );
      input.playerInput = 'I hand her the letter and ask, "Did you write it?"';
      const preset = builtinDefaultPlayPresetBinding(locale);
      preset.definition.playPrompts = preset.definition.playPrompts!.map(
        (entry) =>
          entry.kind === "builtin"
            ? {
                ...entry,
                enabled: [
                  "play.mechanics",
                  "play.tabletop",
                  "play.ending",
                  ...selected.map((name) => `play.${name}`),
                ].includes(entry.builtin),
              }
            : entry,
      );
      const preview = compiler.preview(input, preset);
      const blocks = preview.compilation.logicalMessages.flatMap(
        ({ blocks }) => blocks,
      );
      const optionSources = blocks
        .map(({ source }) => source)
        .filter((source) =>
          /runtime:ordered\/play\.(?:continue|agency|stop)-/u.test(source),
        );
      expect(optionSources).toEqual(
        selected.map((name) => `runtime:ordered/play.${name}`),
      );
      expect(
        preview.compilation
          .turnGuide!.lines.filter(({ source }) =>
            /preset:builtin\/play\.(?:continue|agency|stop)-/u.test(source),
          )
          .map(({ source }) => source),
      ).toEqual(selected.map((name) => `preset:builtin/play.${name}`));
      const tabletop = blocks.find(
        ({ source }) => source === "runtime:ordered/play.tabletop",
      )!.markdown;
      expect(tabletop).toContain(
        locale === "zh-CN"
          ? "叙事沿用选定的承接、停笔与结尾规则"
          : "Follow the selected continuation, stopping and ending rules",
      );
      expect(tabletop).toContain(
        locale === "zh-CN"
          ? "照约定目标交付可用的成果"
          : "Deliver usable accomplishments",
      );
      expect(tabletop).not.toMatch(
        /可以提示眼前可行的办法|Suggested approaches are possibilities|不替玩家补行动和台词|or invent the player's actions and dialogue/u,
      );
      expect(JSON.stringify(preview)).not.toContain(contracts[locale].focus);
      expect(
        preview.compilation.tools.some(({ name }) => name === "d20_check"),
      ).toBe(true);
    }
  },
);
