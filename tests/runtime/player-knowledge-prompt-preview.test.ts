import { expect, test } from "vitest";

import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  retargetFrozenCompilation,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
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
      "角色已知的交接、请求等到了需要履行或临近错过的时刻",
      "即使玩家没主动问",
      "人物的话、可观察物或有依据的记忆",
      "区分世界事实、角色已知与玩家实际被告知的内容",
      "状态正文、工具读取与写回回执本身不算交代",
      "已提交开场与故事、玩家明确表达及实际展示的公开信息",
      "要做什么及必要的对象、去处或条件",
      "不能只暗示方向或说“你当然记得”",
      "也不替玩家选择",
      "剧情中相关新信息经可见场景给出获知入口",
      "角色未知的幕后事实仍须发现，不直接揭露谜底与无关秘密",
      "无任务不造任务",
      "已交代且未变的内容不逐轮提醒，也不为此逐轮翻查历史",
    ],
    tail: "把玩家尚未读到的必要内容写进正文。其余场景按玩家当前行动自然推进。",
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
      "When a character-known handover, request or similar matter comes due or is about to be missed",
      "even if the player did not ask",
      "visible prose through speech, observable objects or grounded memories",
      "Distinguish world facts, character knowledge and what the player has actually been told",
      "state bodies, tool reads and write receipts alone are not disclosure",
      "committed openings and story, explicit player statements and public information actually displayed",
      "what can be done and the necessary person, place or conditions",
      "Do not merely hint at a direction, say “of course you remember” or choose for the player",
      "Give relevant new information an observable entry point during the story",
      "backstage facts unknown to the character still require discovery",
      "without directly revealing solutions or unrelated secrets",
      "Do not invent tasks",
      "Do not repeat unchanged information already disclosed or routinely search history for it each turn",
    ],
    tail: "If a prior instruction is established and matters now, tell what is new.",
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
      runtimeContract: settingImprovementRuntimeContract(
        locale,
        fictionGameplay,
      ),
      authorPrompt: "Develop the opening without revealing the hidden secret.",
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
          runtimeContract: "Current authoring tools.",
          authorPrompt: "Change an unrelated prop only.",
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
      runtimeContract: "Current authoring tools.",
      authorPrompt: "Edit one prop.",
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
