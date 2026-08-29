import { expect, test } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  equalModelHostBinding,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  ScriptedModelHost,
  type ModelHostBinding,
  type ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const binding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "sha256:endpoint",
  modelId: "scripted-model",
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "sha256:protocol",
};

test("ModelHost binding 比较覆盖端点、模型、预算与协议配置", () => {
  expect(equalModelHostBinding(binding, structuredClone(binding))).toBe(true);
  expect(
    equalModelHostBinding(binding, {
      ...binding,
      endpointFingerprint: "sha256:other-endpoint",
    }),
  ).toBe(false);
  expect(
    equalModelHostBinding(binding, {
      ...binding,
      protocolConfigFingerprint: "sha256:other-protocol",
    }),
  ).toBe(false);
});

test("FileNativeModelHost 暴露不含凭据且稳定的完整绑定", () => {
  const left = new FileNativeModelHost({
    provider: "chat_completions",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret-a",
    modelId: "model-a",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();
  const rotatedSecret = new FileNativeModelHost({
    provider: "chat_completions",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret-b",
    modelId: "model-a",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();
  const movedEndpoint = new FileNativeModelHost({
    provider: "chat_completions",
    baseUrl: "https://other.invalid/v1",
    apiKey: "secret-b",
    modelId: "model-a",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();

  expect(left).toEqual(rotatedSecret);
  expect(movedEndpoint.endpointFingerprint).not.toBe(left.endpointFingerprint);
  expect(left).not.toHaveProperty("apiKey");
  expect(left).not.toHaveProperty("baseUrl");
});

test("ScriptedModelHost 记录真实 exchange 并返回确定性 Provider 状态", async () => {
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        continuation: "available",
        text: "Continue.",
        toolCalls: [],
      },
    ],
  });
  const request = exchange();

  const response = await host.exchange(request);

  expect(host.binding()).toEqual(binding);
  expect(host.requests).toEqual([request]);
  expect(response.text).toBe("Continue.");
  expect(response.providerState?.protocol).toBe("chat_completions");
  expect(host.requests[0]?.maxOutputTokens).toBe(request.maxOutputTokens);
});

test("ScriptedModelHost 区分确定失败与结果未知", async () => {
  const failed = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "failure", message: "provider rejected" }],
  });
  const unknown = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "unknown", message: "connection lost" }],
  });

  await expect(failed.exchange(exchange())).rejects.toBeInstanceOf(
    ModelHostFailureError,
  );
  await expect(unknown.exchange(exchange())).rejects.toBeInstanceOf(
    ModelHostOutcomeUnknownError,
  );
});

function exchange(): ModelHostExchange {
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: binding.provider,
      modelId: binding.modelId,
      contextWindowTokens: binding.contextWindowTokens,
      maxOutputTokens: binding.maxOutputTokens,
      playerInput: "I push the door open.",
      playerInputPlacement: "bootstrap",
    }),
  );
  return {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.tools.map(({ name }) => name),
    toolStrategy: bootstrap.toolStrategy,
    appended: [],
    requestId: "adjudicate",
    operationId: "op-scripted",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 1_024,
  };
}
