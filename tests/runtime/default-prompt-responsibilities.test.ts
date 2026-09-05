import { rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import {
  builtinDefaultPlayPresetBinding,
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
  defaultSettingImprovementPromptEn,
  defaultSettingImprovementPromptPath,
  defaultSettingImprovementPromptZhCN,
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
    // Interface values accompany prose; perceivable changes still need staging.
    expect(defaultNarrationPrompt).toContain("must be dramatized here");
    expect(defaultNarrationPrompt).toContain(
      "Player views may also display document fields",
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

  test("设定完善同时约束覆盖、权重、语句职责与审计模式", () => {
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "两把尺子：覆盖与权重",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain("同时决定六件事");
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "审计范围本身就是“目标真正涉及的部分”",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "同一语义只保留一个权威所有者",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "不要笼统假设所有世界文档都会每回合全文注入",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "本节只约束 opening.md",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "control/blocks/ 作者材料回答主持者应该怎样",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "不要预写阶段、进度条、时间表",
    );
    expect(defaultSettingImprovementPromptZhCN).toContain(
      "审计时先按概念、再按句子检查",
    );
    expect(defaultSettingImprovementPromptZhCN).not.toContain(
      "setting_write_file",
    );

    expect(defaultSettingImprovementPromptEn).toContain(
      "Two measures: coverage and weight",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "decide six things together",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "the audit scope itself is what the goal affects",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "Keep one authoritative owner for each meaning",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "Do not assume that every world document is injected in full",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "This section governs opening.md only",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "Author material under control/blocks/ tells the host how",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "Do not prewrite stages, progress tracks, timetables",
    );
    expect(defaultSettingImprovementPromptEn).toContain(
      "Audit concepts before sentences",
    );
    expect(defaultSettingImprovementPromptEn).not.toContain(
      "setting_write_file",
    );
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
    expect(state).toContain(
      "The player reads the narrative and can also see state fields",
    );
    expect(state).toContain("Interface values do not replace dramatization");
    expect(state).toContain(
      "Persisted values must not contradict the narrative",
    );
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

  test("生产提示区分即时保存与检查点归并，Runtime 只说明重放机制", () => {
    const locales = [
      {
        locale: "zh-CN" as const,
        playerInput: "我和新认识的同学约好明天继续见面。",
        runtime: [
          "结束本次玩家提交触发的模型／工具循环",
          "下一次玩家提交可以选择“全新上下文”",
          "旧模型 transcript 不会进入那个请求",
          "全部已提交玩家原文与最终叙事",
          "具体保存时机由作者提示规定",
        ],
        state: [
          "其余可从这些原文恢复的持续结果",
          "检查点",
          "不值得单独建文档，不等于不值得记录",
          "最小充分信息",
          "按上述保存时机本轮必须完成的写入",
          "不要为了防遗忘把每个新名字或刚完成的动作再复制成流水历史",
        ],
        stateAbsent: ["先写文档还是先写叙事都可以"],
      },
      {
        locale: "en" as const,
        playerInput: "I arrange to meet a newly introduced classmate again.",
        runtime: [
          "ends the model/tool loop started by the current player submission",
          "The player's next submission may choose a fresh context",
          "the old model transcript will not enter that request",
          "all committed original player inputs and final narratives",
          "Author instructions decide save timing",
        ],
        state: [
          "Other durable results recoverable from those originals",
          "Before a checkpoint",
          "Not worth a standalone document does not mean not worth recording",
          "minimum sufficient information",
          "actual call sequence must complete writes due this turn under the saving policy before the terminal narrative",
          "Do not duplicate every new name or completed action into a chronological log just in case",
        ],
        stateAbsent: ["Documents or narrative may be written first"],
      },
    ];

    for (const scenario of locales) {
      const binding = builtinDefaultPlayPresetBinding(scenario.locale);
      const input = createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: `continuity-contract-${scenario.locale}`,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        playerInput: scenario.playerInput,
        playerInputPlacement: "append",
        locale: scenario.locale,
      });
      input.hostBinding = presetHostBinding(binding);
      const compilation = new FileNativePromptCompiler({
        locale: scenario.locale,
      }).compilePlayCallChain(input, binding).bootstrap;
      const runtimePrompt = compilation.logicalMessages
        .filter(({ role }) => role === "runtime_system")
        .map(({ markdown }) => markdown)
        .join("\n");
      const authorPrompt = compilation.logicalMessages
        .filter(({ role }) => role === "author_instruction")
        .map(({ markdown }) => markdown)
        .join("\n");

      for (const phrase of scenario.runtime)
        expect(runtimePrompt).toContain(phrase);
      for (const phrase of scenario.state)
        expect(authorPrompt).toContain(phrase);
      for (const phrase of scenario.stateAbsent)
        expect(authorPrompt).not.toContain(phrase);
    }
  });

  test("生产提示允许部分 metadata 更新且不谎称精确读取只会重复正文", () => {
    const scenarios = [
      {
        locale: "zh-CN" as const,
        playerInput: "夜深了，我回到宿舍。",
        coverage: [
          "已注入完整正文",
          "会返回同一正文，并额外显示当前 title、summary 和 aliases",
          "未提供的元数据字段",
          "不要只为照抄未改变的元数据而读取",
        ],
        patch: [
          "只提供需要改变的 title、summary 或 aliases",
          "至少提供一项",
          "未提供的字段由 Runtime 从当前候选文档保留",
        ],
        read: ["set_metadata 可以只提交需要改变的字段"],
        absent: [
          "已注入全文",
          "context_read 只会原样返回你已经看到的字节",
          "整组更新，未改项照抄读取结果",
        ],
      },
      {
        locale: "en" as const,
        playerInput: "Night falls, and I return to the dorm.",
        coverage: [
          "full body injected",
          "returns that same body and additionally exposes the current title, summary, and aliases",
          "preserves metadata fields omitted from",
          "do not read merely to copy unchanged metadata",
        ],
        patch: [
          "include only the title, summary, or aliases that must change",
          "At least one is required",
          "Runtime preserves omitted fields from the current candidate document",
        ],
        read: ["set_metadata may include only the fields that must change"],
        absent: [
          "full text injected",
          "context_read would return the same bytes",
          "update all three",
        ],
      },
    ];

    for (const scenario of scenarios) {
      const binding = builtinDefaultPlayPresetBinding(scenario.locale);
      const input = createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: `partial-metadata-contract-${scenario.locale}`,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        playerInput: scenario.playerInput,
        playerInputPlacement: "append",
        locale: scenario.locale,
      });
      input.hostBinding = presetHostBinding(binding);
      const compilation = new FileNativePromptCompiler({
        locale: scenario.locale,
      }).compilePlayCallChain(input, binding).bootstrap;
      const runtimePrompt = compilation.logicalMessages
        .filter(({ role }) => role === "runtime_system")
        .map(({ markdown }) => markdown)
        .join("\n");
      const worldPrompt = compilation.logicalMessages
        .filter(({ role }) => role === "world_context")
        .map(({ markdown }) => markdown)
        .join("\n");
      const patch = compilation.tools.find(
        ({ name }) => name === "world_patch",
      )?.description;
      const read = compilation.tools.find(
        ({ name }) => name === "context_read",
      )?.description;
      const completeContract = [runtimePrompt, worldPrompt, patch, read].join(
        "\n",
      );

      for (const phrase of scenario.coverage)
        expect(worldPrompt).toContain(phrase);
      for (const phrase of scenario.patch) expect(patch).toContain(phrase);
      for (const phrase of scenario.read) expect(read).toContain(phrase);
      for (const phrase of scenario.absent)
        expect(completeContract).not.toContain(phrase);
    }
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
