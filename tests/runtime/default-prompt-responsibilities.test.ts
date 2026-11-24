import { rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import {
  builtinDefaultPlayPresetBinding as orderedDefaultPlayPresetBinding,
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
import { authoringMechanics } from "../../src/shared/ordered-author-prompts.ts";
import {
  defaultSettingImprovementPrompt,
  defaultSettingImprovementPromptEn,
  defaultSettingImprovementPromptForLocale,
  defaultSettingImprovementPromptPath,
  defaultSettingImprovementPromptZhCN,
  revisionSettingImprovementPromptForLocale,
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
  test("旧默认正文保持已发布语义，第一方模板引用当前应用目录", () => {
    expect(defaultPlayPresetFiles["prompts/narrate.md"]).toBe(
      defaultNarrationPrompt,
    );
    expect(defaultPlayPresetFiles[defaultSettingImprovementPromptPath]).toBe(
      defaultSettingImprovementPrompt,
    );
    for (const files of [
      firstPartyActionChoicesPresetFiles,
      firstPartyGenericPanelsPresetFiles,
      firstPartyStatusPanelPresetFiles,
    ]) {
      const parsed = parsePlayPresetFiles(files);
      if (parsed.kind !== "valid") throw parsed.error;
      expect(parsed.definition.format).toBe("narraeon.orchestration/v1");
      expect(parsed.definition.narrativePrompts).toEqual([]);
    }
  });

  test("世界修订机械说明允许删除与移动既有状态文档，但仍要求无引用阻挡", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const mechanics = authoringMechanics(locale, "world-revision");
      expect(mechanics).not.toMatch(
        /不可删除或移动|cannot be deleted or moved/u,
      );
      expect(mechanics).toMatch(/可以删除或移动|can be deleted or moved/u);
    }
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

  test("运行中世界修订指导省略内容包专属段落，内容包指导保留它们", () => {
    const contentPackageOnly = {
      "zh-CN": "仅在编辑内容包时检查 `opening.md`",
      en: "Inspect `opening.md` only in content packages",
    } as const;
    const worldStart = {
      "zh-CN": "内容包设定用来确定“开场结束那一刻”的世界起点",
      en: "Content-package authoring defines the world at the exact moment the opening ends",
    } as const;
    for (const locale of ["zh-CN", "en"] as const) {
      const contentPackage = defaultSettingImprovementPromptForLocale(locale);
      const revision = revisionSettingImprovementPromptForLocale(locale);
      expect(contentPackage).toContain(contentPackageOnly[locale]);
      expect(contentPackage).toContain(worldStart[locale]);
      expect(revision).not.toContain(contentPackageOnly[locale]);
      expect(revision).not.toContain(worldStart[locale]);
      expect(revision).not.toContain("opening.md");
    }
  });

  test("默认 frame 保留职责顺序，世界 scaffold 不复制通用状态流程", () => {
    const frame = defaultPresetHostFiles["frame.yaml"]!;
    expect(frame.indexOf("blocks/prose.md")).toBeLessThan(
      frame.indexOf("blocks/agency-default.md"),
    );
    expect(frame.indexOf("blocks/agency-default.md")).toBeLessThan(
      frame.indexOf("blocks/save-timing.md"),
    );
    expect(frame.indexOf("blocks/save-timing.md")).toBeLessThan(
      frame.indexOf("blocks/checkpoint-policy.md"),
    );
    expect(frame.indexOf("blocks/checkpoint-policy.md")).toBeLessThan(
      frame.indexOf("world.instructions"),
    );
    const files = minimalFileNativeContentScaffold();
    const world = files.find(
      ({ path }) => path === "control/blocks/world.md",
    )?.contents;
    expect(world).toContain("World documents and where changes belong");
    expect(world).not.toContain(
      defaultPresetHostFiles["blocks/save-timing.md"]!,
    );
    expect(inspectContentPackageCurrentTree(files).status).toBe("usable");
  });

  test("生产提示区分随时整理与事件间隙检查点，Runtime 说明重放机制", () => {
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
          "其余能从玩家原文和故事正文还原的变化",
          "`world_checkpoint` 只用于事件之间的自然空档",
          "随时可以整理文档，但整理不等于检查点",
          "活动还在进行、或眼前正等着玩家表态和做决定时",
          "按“事情”建档而非按回合记流水账",
          "先按停笔规则确定本轮故事写到哪里",
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
          "Other durable outcomes recoverable from the player's text and final prose",
          "Use `world_checkpoint` only at natural gaps between events",
          "Whenever a multi-turn activity builds up real progress",
          "Consolidation can happen anytime and is not a checkpoint",
          "While an activity is still underway",
          "organized by what happened—not turn by turn",
          "Decide how far this turn's story advances first",
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
        patch: ["只传有变化的元数据字段", "至少传一项", "省略的字段原样保留"],
        read: ["YAML 正文不含 $document 头"],
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
          "only changed metadata fields",
          "at least one of title, summary, or aliases",
          "Omitted fields are preserved",
        ],
        read: ["YAML bodies omit $document"],
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
      );
      const read = compilation.tools.find(
        ({ name }) => name === "context_read",
      )?.description;
      const completeContract = [
        runtimePrompt,
        worldPrompt,
        JSON.stringify(patch),
        read,
      ].join("\n");

      for (const phrase of scenario.coverage)
        expect(worldPrompt).toContain(phrase);
      for (const phrase of scenario.patch)
        expect(patch?.inputSchema).toHaveProperty(
          "properties.edits.items.oneOf.6.properties.op.description",
          expect.stringContaining(phrase),
        );
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
        "    - markdown: blocks/prose.md\n",
        "    - markdown: blocks/prose.md\n    - markdown: blocks/style-noir.md\n",
      ),
    };
    expect(authorBlockSources(bothEnabled)).toEqual([
      "host:blocks/prose.md",
      "host:blocks/style-noir.md",
      ...defaultPolicySources.slice(1),
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);

    // Removing a block from the frame excludes its text but keeps the file.
    const disabled: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "frame.yaml": defaultPlayPresetFiles["frame.yaml"]!.replace(
        "    - markdown: blocks/npc.md\n",
        "",
      ),
    };
    expect(authorBlockSources(disabled)).not.toContain("host:blocks/npc.md");
    expect(disabled["blocks/npc.md"]).toContain("NPCs have lives of their own");
  });
});

/** The host blocks the v1 frame lists, in frame order. */
const defaultPolicySources = [
  "host:blocks/prose.md",
  "host:blocks/scene.md",
  "host:blocks/agency-default.md",
  "host:blocks/facts.md",
  "host:blocks/npc.md",
  "host:blocks/save-timing.md",
  "host:blocks/ownership.md",
  "host:blocks/situation.md",
  "host:blocks/checkpoint-policy.md",
];

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
    const prose = defaultPresetHostFiles["blocks/prose.md"]!;
    // The prose block requires detail where it matters, not only anti-padding.
    expect(prose).toContain("Slow down where it matters");
    expect(prose).toContain("Raising a hand can take three lines");
    expect(prose).toContain("never pad by repeating known facts");
    // Sensation lives with the agency rule it must not override.
    expect(defaultPresetHostFiles["blocks/agency-default.md"]).toContain(
      "objective sensory details and involuntary physical reactions grounded in the scene",
    );
    expect(defaultNarrationPrompt).toContain(
      "Match length to the weight of the scene",
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

    // Shipped does not mean enabled: frame.yaml lists only the policy blocks.
    const frame = defaultPresetHostFiles["frame.yaml"]!;
    expect(frame).toContain("markdown: blocks/prose.md");
    for (const path of styles) expect(frame).not.toContain(path);
    expect(authorBlockSources(defaultPlayPresetFiles)).toEqual([
      ...defaultPolicySources,
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });

  test("情感文风详写已有触感且不凭空添加接触，可以和别的文风叠加", () => {
    const intimate = defaultPresetHostFiles["blocks/style-intimate.md"]!;
    expect(intimate).toContain(
      "Do not skip the process and state only the conclusion",
    );
    expect(intimate).toContain("Without contact");
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
        "    - markdown: blocks/prose.md\n",
        "    - markdown: blocks/prose.md\n    - markdown: blocks/style-intimate.md\n    - markdown: blocks/style-wuxia.md\n",
      ),
    };
    expect(authorBlockSources(stacked)).toEqual([
      "host:blocks/prose.md",
      "host:blocks/style-intimate.md",
      "host:blocks/style-wuxia.md",
      ...defaultPolicySources.slice(1),
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });
});

test("new shipped templates persist app references instead of editable copies of app prompt bodies", () => {
  for (const files of [
    firstPartyActionChoicesPresetFiles,
    firstPartyGenericPanelsPresetFiles,
    firstPartyStatusPanelPresetFiles,
  ]) {
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    expect(parsed.definition.format).toBe("narraeon.orchestration/v1");
    expect(parsed.definition.narrativePrompts).toEqual([]);
    expect(
      parsed.definition.playPrompts!.find((e) => e.id === "play.prose"),
    ).toMatchObject({ kind: "builtin", enabled: true });
    expect(Object.keys(files).some((path) => path.startsWith("blocks/"))).toBe(
      false,
    );
    expect(files["prompts/narrate.md"]).toBeUndefined();
    expect(files["prompts/setting-improvement.md"]).toBeUndefined();
  }
});

describe("Default policy block independence with adjacent blocks disabled", () => {
  test.each(["zh-CN", "en"] as const)(
    "%s each policy retains its guidance when adjacent optional blocks are disabled or swapped",
    (locale) => {
      const compiler = new FileNativePromptCompiler({ locale });
      const compileBlock = (
        targetId: string,
        disabled: readonly string[],
        enabled: readonly string[] = [],
      ) => {
        const binding = orderedDefaultPlayPresetBinding(locale);
        binding.definition.playPrompts = binding.definition.playPrompts!.map(
          (entry) => {
            if (entry.kind !== "builtin") return entry;
            if (disabled.includes(entry.builtin))
              return { ...entry, enabled: false };
            if (enabled.includes(entry.builtin))
              return { ...entry, enabled: true };
            return entry;
          },
        );
        const compiled = compiler.compilePlayCallChain(
          createMinimalFileNativePreviewInput({
            provider: "chat_completions",
            modelId: `b3b-${locale}-${targetId}`,
            contextWindowTokens: 128_000,
            maxOutputTokens: 4096,
            playerInput:
              locale === "zh-CN"
                ? "我推门看看院子。"
                : "I open the door to check the yard.",
            playerInputPlacement: "append",
            locale,
          }),
          binding,
        ).bootstrap;
        const block = compiled.logicalMessages
          .flatMap(({ blocks }) => blocks)
          .find(({ source }) => source === `runtime:ordered/${targetId}`);
        expect(block, `missing ${targetId} block`).toBeDefined();
        return block!.markdown;
      };

      const saveTiming = compileBlock("play.save-timing", [
        "play.ownership",
        "play.situation",
        "play.checkpoint-policy",
      ]);
      const checkpoint = compileBlock(
        "play.checkpoint-policy",
        ["play.save-timing", "play.stop-beat"],
        ["play.stop-scene"],
      );
      const output = compileBlock(
        "play.output",
        ["play.save-timing", "play.situation", "play.stop-beat"],
        ["play.stop-scene"],
      );
      const facts = compileBlock("play.facts", [
        "play.output",
        "play.ownership",
        "play.save-timing",
      ]);
      const ownership = compileBlock("play.ownership", [
        "play.save-timing",
        "play.situation",
        "play.agency-default",
        "play.agency-strict",
        "play.agency-open",
      ]);
      const prose = compileBlock("play.prose", ["play.output", "play.scene"]);

      const situation = compileBlock("play.situation", [
        "play.ownership",
        "play.save-timing",
      ]);

      expect(saveTiming).toContain("`背景`");
      expect(saveTiming).toContain("`background`");

      const policies =
        locale === "zh-CN"
          ? ([
              [
                saveTiming,
                [
                  "当轮必写（在写完本轮正文前完成）",
                  "玩家界面常驻显示的数值发生变化时",
                  "当前情境已使用顶层 `背景`（或 `background`）记录时间/地点且本轮发生变化时，直接更新该节点",
                  "故事正文和玩家原文里没写出来的必要信息",
                  "可以在事件收尾或合适的中间节点一起整理",
                  "随时可以在当轮直接整理进去",
                  "角色暂时离场不算退场",
                ],
              ],
              [
                checkpoint,
                [
                  "`world_checkpoint` 只用于事件之间的自然空档",
                  "追逐穿过两条街仍属于同一场活动",
                  "不要仅仅因为普通停笔或刚整理完文档就登记检查点",
                  "随时可以整理文档，但整理不等于检查点",
                ],
              ],
              [
                output,
                [
                  "世界内叙事只写故事正文",
                  "不要求把允许写的部分写得潦草",
                  "界面数值不能代替场面描写",
                  "补录旧事、去重或整理文档时不要重演已经发生过的场景",
                  "不要出现“没搜到资料”之类的话",
                  "直接简洁作答，不推进剧情或时间",
                ],
              ],
              [
                facts,
                [
                  "缺少裁决所需事实时，先通过目录、搜索和读取核实",
                  "角色的声称和猜测不等于事实",
                  "把行动所需的前提说清楚",
                  "后台文档和工具读取不算“已经告诉玩家”",
                  "角色不知道的幕后真相留待发现，不提前剧透，也不硬造任务",
                ],
              ],
              [
                ownership,
                [
                  "当前状态归对应主体",
                  "玩家角色的感情只写玩家自己表达过的部分",
                  "按“事情”建档而非按回合记流水账",
                  "当时的结果",
                  "不要在每份人物文档里重复抄一遍经过",
                  "`summary` 只用来在目录里快速识别",
                ],
              ],
              [
                prose,
                [
                  "给出证据能支撑的结论，保持对应的确定程度",
                  "除非玩家表示要说出口，不写成台词",
                  "赶路、例行公事和已知背景一两句带过",
                  "一个抬手可以写三行，两小时赶路也可以写一句",
                ],
              ],
            ] as const)
          : ([
              [
                saveTiming,
                [
                  "Write before final prose (required this turn)",
                  "Any changed value displayed in player views",
                  "tracks time/place under a top-level `background` (or `背景`) node and those values changed, update that node directly",
                  "Necessary facts absent from the player's message and final prose",
                  "may be saved at scene closure or any natural pause",
                  "without waiting for the event to finish or recording unrealized outcomes early",
                  "Temporary absence is not retirement",
                ],
              ],
              [
                checkpoint,
                [
                  "Use `world_checkpoint` only at natural gaps between events",
                  "a chase spilling into the next street is still one event",
                  "do not register a checkpoint just because you paused or finished tidying notes",
                  "Consolidation can happen anytime and is not a checkpoint",
                ],
              ],
              [
                output,
                [
                  "In-world replies contain story prose only",
                  "stopping rules limit how far you advance, not the care you give the moment",
                  "UI stats never replace a scene",
                  "Backfilling, deduplicating, or tidying records never replays past events",
                  'Never write phrases like "nothing turned up in the records" in prose',
                  "answer briefly without advancing time or story",
                ],
              ],
              [
                facts,
                [
                  "When key facts are missing, look them up through catalogs, search, and reads",
                  "a character's claim is not a fact",
                  "surface the actionable premise through dialogue, an observable object, or grounded memory",
                  "Backend files and tool reads do not count as disclosure",
                  "Keep unknown backstage truths discoverable without spoiling solutions or inventing tasks",
                ],
              ],
              [
                ownership,
                [
                  "Current state lives with its owner",
                  "Record only feelings the player has actually expressed",
                  "organized by what happened—not turn by turn",
                  "outcomes at that time",
                  "copying the account across every character sheet",
                  "Use `summary` only as a short catalog label",
                ],
              ],
              [
                prose,
                [
                  "Deliver what the evidence supports",
                  "Turn it into spoken dialogue only if the player means to say it aloud",
                  "travel and routine can take a sentence",
                  "Raising a hand can take three lines",
                ],
              ],
            ] as const);
      for (const [body, phrases] of policies) {
        for (const phrase of phrases) expect(body).toContain(phrase);
      }

      if (locale === "zh-CN") {
        expect(situation.split("\n\n")[2]?.split("\n")).toEqual([
          expect.stringMatching(/^- \*\*写什么\*\*：/u),
          expect.stringMatching(
            /^- \*\*改写时什么不能丢\*\*：.*就必须原意保留.*不要擅自改窄范围.*覆盖客观事实。$/u,
          ),
          expect.stringMatching(/^- \*\*移出什么\*\*：/u),
        ]);
      } else {
        expect(
          situation
            .split("\n\n")[1]
            ?.endsWith(
              "When updating the current situation, keep explicit negative facts and unmet conditions that still hold—never overwrite an established objective boundary just because a character makes a new claim.",
            ),
        ).toBe(true);
      }
    },
  );
});
