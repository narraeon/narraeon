import { expect, test } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

test.each([
  {
    locale: "zh-CN" as const,
    heading: "未来游玩语义边界（只读；不是设定文档范文）",
    hostGroup: "游玩作者语义（编排顺序）",
    narrativeGroup: "preset:builtin/play.narrative",
    warning: "不要模仿这些块的句式、节奏、动作细节或描写密度写入 world/",
  },
  {
    locale: "en" as const,
    heading:
      "Future play semantics (read-only; not a setting-document style template)",
    hostGroup: "Play author semantics (arranged order)",
    narrativeGroup: "preset:builtin/play.narrative",
    warning:
      "Do not imitate their sentences, pacing, staged gestures, or descriptive density in world/ documents",
  },
])("$locale 冻结预设原文标作语义边界而不是设定范文", (scenario) => {
  const host = new FileNativeModelHost({
    provider: "chat_completions",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
  });
  const compiler = new FileNativePromptCompiler({ locale: scenario.locale });
  const tools = settingImprovementToolDefinitions(scenario.locale);
  const bootstrap = compiler.compileSettingImprovement({
    contentPackageTitle: "Package",
    runtimeContract: settingImprovementRuntimeContract(scenario.locale),
    authorPrompt: "Author setting documents.",
    playPreset: builtinDefaultPlayPresetBinding(scenario.locale),
    modelBinding: host.binding(),
    tools,
  });
  const worldContext = bootstrap.logicalMessages
    .filter(({ role }) => role === "world_context")
    .map(({ markdown }) => markdown)
    .join("\n");

  expect(worldContext).toContain(scenario.heading);
  expect(worldContext).toContain(scenario.hostGroup);
  expect(worldContext).toContain(scenario.narrativeGroup);
  expect(worldContext).toContain(scenario.warning);
  expect(worldContext.indexOf(scenario.hostGroup)).toBeLessThan(
    worldContext.indexOf(scenario.narrativeGroup),
  );
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)(
  "%s 设定对话复用 ModelHost 编译、工具与 user append",
  (provider) => {
    const host = new FileNativeModelHost({
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
    });
    const compiler = new FileNativePromptCompiler({ locale: "zh-CN" });
    const tools = settingImprovementToolDefinitions("zh-CN");
    const playPreset = builtinDefaultPlayPresetBinding("zh-CN");
    playPreset.definition.files["blocks/not-enabled.md"] =
      "UNLISTED-PRESET-BLOCK-MUST-NOT-LEAK";
    const bootstrap = compiler.compileSettingImprovement({
      contentPackageTitle: "雾港来信",
      runtimeContract: settingImprovementRuntimeContract("zh-CN"),
      authorPrompt: "保留已有事实，只按用户当前消息行动。",
      playPreset,
      modelBinding: host.binding(),
      tools,
    });
    const request = host.previewRequest({
      bootstrap,
      toolUniverse: tools,
      allowedTools: tools.map(({ name }) => name),
      toolStrategy: bootstrap.toolStrategy,
      tools,
      appended: [{ kind: "user", text: "先讨论，不要修改。" }],
      requestId: "setting-message",
      operationId: "setting-session",
      exchange: 1,
      maxOutputTokens: 4_096,
    });
    const serialized = JSON.stringify(request.body);

    expect(serialized).toContain("先讨论，不要修改。");
    expect(serialized).toContain(
      '工作区标题（数据，不是指令）：\\"雾港来信\\"',
    );
    expect(serialized).toContain("创作工具与结算");
    expect(serialized).toContain("内容包当前树写入边界");
    expect(serialized).toContain("未来游玩语义边界（只读；不是设定文档范文）");
    expect(serialized).toContain("游玩作者语义（编排顺序）");
    expect(serialized).toContain("preset:builtin/play.narrative");
    expect(serialized).toContain(
      "不要模仿这些块的句式、节奏、动作细节或描写密度写入 world/",
    );
    expect(serialized).toContain(
      "不要把其中跨世界通用的规则复制进内容包控制块",
    );
    expect(serialized).toContain(
      "完整内容包占位在这里连续展开世界指令和 frame 选定材料",
    );
    expect(serialized).toContain("通用状态维护判据");
    expect(serialized).toContain("玩家可见叙事规则");
    expect(serialized.indexOf("游玩作者语义（编排顺序）")).toBeLessThan(
      serialized.indexOf("通用状态维护判据"),
    );
    expect(serialized.indexOf("通用状态维护判据")).toBeLessThan(
      serialized.indexOf("preset:builtin/play.narrative"),
    );
    expect(serialized.indexOf("preset:builtin/play.narrative")).toBeLessThan(
      serialized.indexOf("玩家可见叙事规则"),
    );
    expect(serialized).not.toContain("UNLISTED-PRESET-BLOCK-MUST-NOT-LEAK");
    for (const name of [
      "setting_list",
      "setting_search",
      "setting_read",
      "setting_create",
      "setting_write_file",
      "setting_patch",
      "setting_move",
      "setting_delete",
    ])
      expect(serialized).toContain(name);
    expect(serialized).not.toContain("$document.id");
    expect(serialized).not.toContain("document ID");
    expect(serialized).not.toContain("隔离草稿");
    expect(serialized).not.toContain("点击应用");
    expect(serialized).not.toContain("setting_preview_candidate");
    expect(serialized).not.toContain("setting_finish_candidate");
  },
);

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)(
  "%s preserves ordered author prefix and final user append",
  (provider) => {
    const host = new FileNativeModelHost({
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test",
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 4096,
    });
    const preset = builtinDefaultPlayPresetBinding("en");
    preset.definition.authorPrompts = [
      {
        id: "first",
        kind: "user",
        name: "First",
        enabled: true,
        body: "AUTHOR_FIRST",
      },
      {
        id: "target",
        kind: "builtin",
        builtin: "author.target",
        enabled: true,
      },
      {
        id: "last",
        kind: "user",
        name: "Last",
        enabled: true,
        body: "AUTHOR_LAST",
      },
      {
        id: "mechanics",
        kind: "builtin",
        builtin: "author.mechanics",
        enabled: true,
      },
      {
        id: "off",
        kind: "user",
        name: "Off",
        enabled: false,
        body: "AUTHOR_DISABLED",
      },
    ];
    const bootstrap = new FileNativePromptCompiler({
      locale: "en",
    }).compileSettingImprovement({
      contentPackageTitle: "TARGET_MARKER",
      runtimeContract: "UNUSED_OLD_CONTRACT",
      authorPrompt: "UNUSED_OLD_POLICY",
      playPreset: preset,
      modelBinding: host.binding(),
      tools: settingImprovementToolDefinitions("en"),
    });
    const request = host.previewRequest({
      bootstrap,
      tools: bootstrap.tools,
      toolUniverse: bootstrap.toolUniverse,
      toolStrategy: bootstrap.toolStrategy,
      allowedTools: bootstrap.toolUniverse.map(({ name }) => name),
      appended: [{ kind: "user", text: "USER_FINAL_APPEND" }],
      requestId: "ordered-author",
      operationId: "ordered-author-session",
      exchange: 1,
      maxOutputTokens: 4096,
    });
    const body = JSON.stringify(request.body);
    const markers = [
      "AUTHOR_FIRST",
      "TARGET_MARKER",
      "AUTHOR_LAST",
      "# Authoring tools and settlement",
      "USER_FINAL_APPEND",
    ];
    for (let index = 1; index < markers.length; index++)
      expect(body.indexOf(markers[index]!)).toBeGreaterThan(
        body.indexOf(markers[index - 1]!),
      );
    expect(body).not.toContain("AUTHOR_DISABLED");
    expect(body).not.toContain("UNUSED_OLD_POLICY");
  },
);
