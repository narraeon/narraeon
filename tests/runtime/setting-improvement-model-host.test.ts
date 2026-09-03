import { expect, test } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

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
    expect(serialized).toContain(
      "当前情境的职责只由 control/frame.yaml 的 bindings.currentSituation 精确绑定决定",
    );
    expect(serialized).toContain("不必保留“当前情境”字样");
    expect(serialized).toContain("内容包在游玩中的生命周期");
    expect(serialized).toContain("内容包当前树写入边界");
    expect(serialized).toContain("当前冻结预设的只读创作参考");
    expect(serialized).toContain("按 control/frame.yaml 的声明顺序");
    expect(serialized).toContain("通用状态维护判据");
    expect(serialized).toContain("玩家可见叙事规则");
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
