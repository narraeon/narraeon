import { expect, test } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingImprovementDraft.ts";

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
    const bootstrap = compiler.compileSettingImprovement({
      runtimeContract: settingImprovementRuntimeContract("zh-CN"),
      authorPrompt: "保留已有事实，只按用户当前消息行动。",
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
    for (const name of [
      "setting_list",
      "setting_search",
      "setting_read",
      "setting_write_file",
      "setting_patch",
      "setting_move",
    ])
      expect(serialized).toContain(name);
    expect(serialized).not.toContain("setting_preview_candidate");
    expect(serialized).not.toContain("setting_finish_candidate");
  },
);
