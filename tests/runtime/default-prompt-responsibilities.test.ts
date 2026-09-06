import { rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import {
  legacyDefaultPlayPresetFilesForLocale,
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

// Released v1 fixtures retain their original compiler path for historical recovery.
const defaultPlayPresetFiles = legacyDefaultPlayPresetFilesForLocale("en");
function builtinDefaultPlayPresetBinding(locale: "en" | "zh-CN" = "en") {
  const files = legacyDefaultPlayPresetFilesForLocale(locale);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "legacy-default",
    name: "Legacy default",
    revision: "legacy-v1",
    files,
    definition: parsed.definition,
    scriptsEnabled: true,
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("旧格式默认提示词职责", () => {
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

    // Shared defaults must not acquire tool authority through editable prose.
    expect(defaultNarrationPrompt).not.toContain("artifact_emit");
    expect(defaultSettingImprovementPrompt).not.toContain("setting_write_file");
    expect(
      firstPartyActionChoicesPresetFiles["prompts/options.md"],
    ).not.toContain("artifact_emit");
    expect(
      firstPartyGenericPanelsPresetFiles["prompts/panels.md"],
    ).not.toContain("artifact_emit");
  });

  test("创作建议提供两个目标分支而不再将运行中世界限制为创建时状态", () => {
    expect(defaultSettingImprovementPromptZhCN).toContain("运行中世界修订");
    expect(defaultSettingImprovementPromptEn).toContain(
      "Running-world revision",
    );
    expect(defaultSettingImprovementPromptZhCN).not.toContain(
      "世界文档只写创建世界时已经成立的事实",
    );
    expect(defaultSettingImprovementPromptEn).not.toContain(
      "World documents contain only facts and stable rules that already hold when the world is created",
    );
  });

  test("默认 frame 保留职责顺序，世界 scaffold 不复制通用状态流程", () => {
    const frame = defaultPresetHostFiles["frame.yaml"]!;
    expect(frame.indexOf("blocks/style.md")).toBeLessThan(
      frame.indexOf("blocks/adjudication.md"),
    );
    expect(frame.indexOf("blocks/adjudication.md")).toBeLessThan(
      frame.indexOf("blocks/state.md"),
    );
    expect(frame.indexOf("blocks/state.md")).toBeLessThan(
      frame.indexOf("world.instructions"),
    );
    const files = minimalFileNativeContentScaffold();
    const world = files.find(
      ({ path }) => path === "control/blocks/world.md",
    )?.contents;
    expect(world).toContain("World documents and where changes belong");
    expect(world).not.toContain(defaultPresetHostFiles["blocks/state.md"]!);
    expect(inspectContentPackageCurrentTree(files).status).toBe("usable");
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
          "其余可从玩家原文和最终叙事恢复的持续结果",
          "检查点",
          "未达到独立建档门槛的信息仍可嵌入自然所有者",
          "足够维持连续性与意义的信息",
          "先完成本轮必须保存的写入",
          "不必再造一份逐轮日志",
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
          "Other durable outcomes recoverable from player originals and final narrative",
          "Before a checkpoint",
          "Information below the independent-document threshold",
          "Save enough to preserve continuity and meaning",
          "Complete this turn's required writes before registering the checkpoint",
          "do not create a second turn-by-turn log",
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

describe("旧格式提示块启用清单", () => {
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

describe("旧格式文风块库", () => {
  test("通用块讲变速，六种文风预置在库里但默认不启用", () => {
    const style = defaultPresetHostFiles["blocks/style.md"]!;
    // The general style requires detail where it matters, not only anti-padding.
    expect(style).toContain("Slow down where it matters");
    expect(style).toContain("Raising a hand may take three lines");
    expect(style).toContain("Padding repeats the same fact in different words");
    // The player character's natural sensory and bodily experience may be stated directly.
    expect(style).toContain(
      "player character's natural sensory and bodily experience may be stated directly",
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
