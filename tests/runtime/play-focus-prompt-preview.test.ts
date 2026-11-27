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
  settingImprovementToolDefinitions,
  SettingAuthoringTransaction,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const contracts = {
  "zh-CN": {
    author: [
      "新建内容包或调整玩法方向时",
      "用一两句话把核心体验写进 `control/frame.yaml` 实际引用的世界主持块里",
      "可以多线并行，也可以只是日常相处，不规定必经路线或结局",
      "这里只写给主持人看，不复制开场原文、当前事实、谜底或秘密",
    ],
    focus: "顺着玩家此刻最投入的事推进",
    selection: [
      "明确要求优先",
      "结合近几轮上下文",
      "自然、可观察的现场反馈",
      "给出证据能支撑的结论，保持对应的确定程度",
      "除非玩家表示要说出口，不写成台词",
      "当场可见的后果",
    ],
  },
  en: {
    author: [
      "When creating a package or refining its play direction",
      "state the core experience in one or two sentences inside a world GM block referenced by `control/frame.yaml`",
      "Multiple threads or quiet everyday companionship are equally valid, with no forced routes or endings",
      "Address the GM only—do not copy opening prose, current facts, solutions, or secrets into this note",
    ],
    focus: "Follow what the player is invested in right now",
    selection: [
      "Honor explicit pacing",
      "recent turns",
      "natural, observable feedback",
      "Deliver what the evidence supports",
      "Turn it into spoken dialogue only if the player means to say it aloud",
      "visible consequences",
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
              "未要求传达的保留用来约束行动",
              "没有引号也照做明确的发问、拒绝或转告",
              "本轮只要有新的角色行动或台词",
              "两者都要出现在首个世界回应之前",
              "条件尚未满足的后续打算仍按尝试或条件写",
              "玩家特意写出的动作或话要认真演出来",
            ],
            "continue-advance": [
              "真实结果或回应起笔",
              "保留输入里的尝试与条件",
            ],
            "agency-default": [
              "“我去找他”可以顺带写过走廊、敲门",
              "我把信交给他",
            ],
            "agency-strict": ["可替玩家写出的行为", "NPC 当轮可以接信并回应"],
            "agency-open": ["具体推进到哪里由停笔规则决定"],
            "stop-beat": [
              "明确要求略过的普通来回",
              "一旦出现新条件",
              "不必每遇到一个停顿就强行收手",
            ],
            "stop-scene": [
              "玩家特意留给自己的判断",
              "不必因为一个小停顿或新细节就过早切停",
            ],
            "style-intimate": ["距离和已经发生的触感", "没有接触时"],
            "style-noir": ["可感知的细节"],
            "style-action": ["已经成立的代价"],
            "style-literary": ["实际经过的时间"],
            "save-timing": ["其余能从玩家原文和故事正文还原的变化"],
            situation: ["移出当前待办或标为过去", "臆测玩家的长期偏好"],
            "person-third": ["台词保留说话人原本的人称"],
          }
        : {
            "continue-stage": [
              "an unspoken reservation",
              "clearly directed questions, refusals, and messages even without quotation marks",
              "Whenever this turn introduces new action or dialogue",
              "show both before the first NPC reply",
              "Keep conditional follow-ups as attempts or conditions until met",
              "deliberate actions or lines get staged properly",
            ],
            "continue-advance": [
              "actual result or reaction",
              "Keep attempts and conditions intact",
            ],
            "agency-default": [
              "walking down the hall and knocking",
              "I hand him the letter",
            ],
            "agency-strict": [
              "Limit the player character's behavior strictly",
              "NPCs may take the letter and answer in the same turn",
            ],
            "agency-open": ["advancing as far as the stopping rule allows"],
            "stop-beat": [
              "Skip routine back-and-forth when the player asks to compress it",
              "hand back new conditions or consequential choices",
              "do not cut off on an empty pause",
            ],
            "stop-scene": [
              "stop before a judgment the player reserved",
              "Do not cut off early over a small pause or minor detail",
            ],
            "style-intimate": [
              "distance and touch that has already occurred",
              "Without contact",
            ],
            "style-noir": ["perceptible details"],
            "style-action": ["established costs"],
            "style-literary": ["time that actually elapsed"],
            "save-timing": [
              "Other durable outcomes recoverable from the player's text and final prose",
            ],
            situation: [
              "remove or mark past anything resolved this turn",
              "a guess at the player's long-term preferences",
            ],
            "person-third": [
              "keep direct dialogue in each speaker's own voice",
            ],
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
      if (name === "continue-stage") {
        expect(preview.compilation.turnGuide?.text).toContain(
          locale === "zh-CN"
            ? "在首个世界回应前演出本轮新动作和玩家要传达的话"
            : "Stage new action and intended speech before the world responds",
        );
        expect(preview.compilation.turnGuide?.text).toContain(
          locale === "zh-CN"
            ? "只约束行动的保留意见留在话外"
            : "Keep private limits unspoken",
        );
      }
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
          ? "承接、停笔与结尾遵循已启用的叙事规则"
          : "Follow the enabled continuation, stopping, and ending rules",
      );
      expect(tabletop).toContain(
        locale === "zh-CN"
          ? "按约定目标交付可用的成果"
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
