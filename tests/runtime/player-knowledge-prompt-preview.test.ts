import { expect, test } from "vitest";

import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  retargetFrozenCompilation,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { settingImprovementToolDefinitions } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const contracts = {
  "zh-CN": {
    opening: [
      "新建内容包、完善开场或改动起始知情时",
      "让首次游玩的玩家单读开场",
      "主角是谁、眼前发生什么",
      "当前选择所需而角色已知的前提",
      "以及交接或请求",
      "足以采取第一步的信息",
      "独处、安静和等待也可开场，无任务不造任务",
      "已有合适内容就沿用",
      "定向修改无关道具不需重写开场",
      "私下真相、谜底、未来安排和待发现事项",
    ],
    knowledge: [
      "约定/交接，而玩家此前在故事里从未读到过",
      "即使玩家没问",
      "人物台词、眼前物件或自然回忆",
      "要做什么、找谁、条件是什么",
      "不要只含糊暗示或说“你当然记得”",
      "世界客观事实、角色知道什么、玩家实际读到过什么，三者各自独立",
      "后台文档和工具读取不算“已经告诉玩家”",
      "只有开场白、已提交故事、玩家自己的话和界面公开信息才算",
      "角色不知道的幕后真相留待发现，不提前剧透，也不硬造任务",
    ],
    tail: "已有材料明确写出的角色已知前提影响眼下行动而玩家未读到时，写进正文。",
  },
  en: {
    opening: [
      "When creating a package, developing its opening or changing starting knowledge",
      "let a first-time player understand from the opening alone",
      "who the protagonist is, what is happening",
      "premises the character knows that the current choice requires",
      "any handover or request",
      "enough to take a first step",
      "Solitude, quiet and waiting can also open a story; do not invent tasks",
      "Reuse suitable existing content",
      "a targeted edit to an unrelated prop need not rewrite the opening",
      "Private truths, solutions, future plans and matters meant to be discovered",
    ],
    knowledge: [
      "a deadline, handover, or request known to the character is about to come due",
      "the player has never seen it in play",
      "surface the actionable premise through dialogue, an observable object, or grounded memory",
      "what needs doing, who, where, and conditions",
      'Do not merely hint or say "of course you remember."',
      "World truth, character knowledge, and what the player has actually been shown are distinct",
      "Backend files and tool reads do not count as disclosure",
      "only the opening, committed story, player statements, and visible public UI do",
      "Keep unknown backstage truths discoverable without spoiling solutions or inventing tasks",
    ],
    tail: "State established character-known premises needed now if still unread.",
  },
} as const;

test.each(["en", "zh-CN"] as const)(
  "%s authoring and play compile actionable character knowledge at their editable layers",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const preset = builtinDefaultPlayPresetBinding(locale);
    const input = createMinimalFileNativePreviewInput({
      locale,
      provider: "chat_completions",
      modelId: "player-knowledge-acceptance",
      contextWindowTokens: 128_000,
      maxOutputTokens: 4096,
      playerInput: "I put down my luggage and look at the sky.",
      playerInputPlacement: "append",
    });
    const authorInput = {
      gameplay: fictionGameplay,
      playPreset: preset,
      modelBinding: input.modelBinding,
      tools: settingImprovementToolDefinitions(locale, fictionGameplay),
    };
    const author = compiler.compileSettingImprovement({
      ...authorInput,
      contentPackageTitle: "Night shift at the inn",
    });
    const authorText = author.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n");
    for (const phrase of contracts[locale].opening)
      expect(authorText).toContain(phrase);

    const revision = compiler.compileWorldRevision({
      ...authorInput,
      worldTitle: "A running inn",
      epoch: { id: "knowledge-epoch", baseHead: "knowledge-head" },
    });
    const revisionText = revision.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .find(
        ({ source }) => source === "play-preset:author/author.guidance",
      )!.markdown;
    for (const phrase of contracts[locale].opening)
      expect(revisionText).not.toContain(phrase);

    const preview = compiler.preview(input, preset);
    const blocks = preview.compilation.logicalMessages.flatMap(
      ({ blocks }) => blocks,
    );
    const facts = blocks.find(
      ({ source }) => source === "runtime:ordered/play.facts",
    )!.markdown;
    for (const phrase of contracts[locale].knowledge) {
      expect(facts).toContain(phrase);
      expect(
        blocks.filter(({ markdown }) => markdown.includes(phrase)),
      ).toHaveLength(1);
    }
    expect(preview.compilation.turnGuide?.text).toContain(
      contracts[locale].tail,
    );
  },
);

test.each(["en", "zh-CN"] as const)(
  "%s knowledge policy and its tail remain independent of tabletop and style switches, with no disabled fallback",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    for (const mode of ["interactive-fiction", "tabletop"] as const) {
      for (const stylesEnabled of [false, true]) {
        const input = previewInputWithGameplay(
          mode === "tabletop" ? { mode, scheme: "d20" } : fictionGameplay,
          { locale, playerInputPlacement: "append" },
        );
        const preset = builtinDefaultPlayPresetBinding(locale);
        preset.definition.playPrompts = preset.definition.playPrompts!.map(
          (entry) =>
            entry.kind === "builtin" && entry.builtin.startsWith("play.style-")
              ? { ...entry, enabled: stylesEnabled }
              : entry,
        );
        const enabled = compiler.compilePlayCallChain(input, preset).bootstrap;
        const enabledBlocks = enabled.logicalMessages.flatMap(
          ({ blocks }) => blocks,
        );
        const phrase = contracts[locale].knowledge[0];
        expect(
          enabledBlocks.filter(({ markdown }) => markdown.includes(phrase)),
        ).toHaveLength(1);
        const tail = enabled.turnGuide!.lines.find(
          ({ source }) => source === "preset:builtin/play.facts",
        )!;
        expect(tail.text).toContain(contracts[locale].tail);
        expect([...tail.text].length).toBeLessThanOrEqual(120);

        preset.definition.playPrompts = preset.definition.playPrompts.map(
          (entry) =>
            entry.kind === "builtin" && entry.builtin === "play.facts"
              ? { ...entry, enabled: false }
              : entry,
        );
        const disabled = compiler.compilePlayCallChain(input, preset).bootstrap;
        expect(JSON.stringify(disabled)).not.toContain(phrase);
        expect(JSON.stringify(disabled)).not.toContain(contracts[locale].tail);
        // Disabling the policy changes no world materials, tools or history selection.
        expect(
          disabled.logicalMessages.filter(
            ({ role }) => role === "world_context",
          ),
        ).toEqual(
          enabled.logicalMessages.filter(
            ({ role }) => role === "world_context",
          ),
        );
        expect(disabled.toolUniverse).toEqual(enabled.toolUniverse);
        const author = compiler.compileSettingImprovement({
          contentPackageTitle: "An existing package",
          gameplay:
            mode === "tabletop" ? { mode, scheme: "d20" } : fictionGameplay,
          playPreset: preset,
          modelBinding: input.modelBinding,
          tools: [],
        });
        expect(JSON.stringify(author)).not.toContain(phrase);
        expect(JSON.stringify(author)).not.toContain(contracts[locale].tail);
      }
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "%s user-owned copies and frozen requests retain their wording rather than acquiring current disclosure policy",
  (locale) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const preset = builtinDefaultPlayPresetBinding(locale);
    preset.definition.playPrompts = preset.definition.playPrompts!.map(
      (entry) =>
        entry.kind === "builtin" && entry.builtin === "play.facts"
          ? {
              id: "copied-facts",
              kind: "user",
              name: "My facts",
              body: "AUTHOR_OWNED_FACTS",
              enabled: true,
            }
          : entry,
    );
    preset.definition.authorPrompts = preset.definition.authorPrompts!.map(
      (entry) =>
        entry.kind === "builtin" && entry.builtin === "author.guidance"
          ? {
              id: "copied-guidance",
              kind: "user",
              name: "My method",
              body: "AUTHOR_OWNED_GUIDANCE",
              enabled: true,
            }
          : entry,
    );
    // A clone replaces the built-in policy; explicitly keep that application policy disabled.
    preset.definition.playPrompts.push({
      id: "play.facts",
      kind: "builtin",
      builtin: "play.facts",
      enabled: false,
    });
    preset.definition.authorPrompts.push({
      id: "author.guidance",
      kind: "builtin",
      builtin: "author.guidance",
      enabled: false,
    });
    const input = previewInputWithGameplay(fictionGameplay, { locale });
    const frozen = compiler.compilePlayCallChain(input, preset).bootstrap;
    const frozenBytes = JSON.stringify(frozen);
    const retried = retargetFrozenCompilation(frozen, {
      ...input.modelBinding,
      contextWindowTokens: 64_000,
      maxOutputTokens: 2048,
    });
    expect(retried.logicalMessages).toEqual(frozen.logicalMessages);
    expect(JSON.stringify(frozen)).toBe(frozenBytes);
    expect(JSON.stringify(retried)).toContain("AUTHOR_OWNED_FACTS");
    expect(JSON.stringify(retried)).not.toContain(
      contracts[locale].knowledge[0],
    );
    expect(JSON.stringify(retried)).not.toContain(contracts[locale].tail);
    const author = compiler.compileSettingImprovement({
      contentPackageTitle: "My package",
      gameplay: fictionGameplay,
      playPreset: preset,
      modelBinding: input.modelBinding,
      tools: [],
    });
    expect(JSON.stringify(author)).toContain("AUTHOR_OWNED_GUIDANCE");
    expect(JSON.stringify(author)).not.toContain(contracts[locale].opening[0]);
    expect(JSON.stringify(author)).not.toContain(
      contracts[locale].knowledge[0],
    );
  },
);
