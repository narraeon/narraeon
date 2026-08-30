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
      cacheStrategy: "provider_managed",
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

  const changedReasoningPolicy = new FileNativeModelHost({
    provider: "chat_completions",
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret-b",
    modelId: "model-a",
    reasoningEffort: "high",
    reasoningSummary: "none",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();
  expect(changedReasoningPolicy.protocolConfigFingerprint).not.toBe(
    left.protocolConfigFingerprint,
  );

  const changedThinkingPolicy = new FileNativeModelHost({
    provider: "anthropic_messages",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret-b",
    modelId: "claude-a",
    thinkingMode: "enabled",
    thinkingBudgetTokens: 1_024,
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();
  const defaultThinkingPolicy = new FileNativeModelHost({
    provider: "anthropic_messages",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret-b",
    modelId: "claude-a",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).binding();
  expect(changedThinkingPolicy.protocolConfigFingerprint).not.toBe(
    defaultThinkingPolicy.protocolConfigFingerprint,
  );
});

test("wire adapter 自身拒绝无效推理策略，不依赖配置存储层兜底", () => {
  expect(
    () =>
      new FileNativeModelHost({
        provider: "anthropic_messages",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "claude",
        reasoningEffort: "minimal",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      }),
  ).toThrow("effort supports low, medium, high, xhigh, and max");
  expect(
    () =>
      new FileNativeModelHost({
        provider: "chat_completions",
        dialect: "standard",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "chat-model",
        reasoningSummary: "auto",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      }),
  ).toThrow("has no reasoning-summary parameter");
  expect(
    () =>
      new FileNativeModelHost({
        provider: "anthropic_messages",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "claude",
        thinkingMode: "disabled",
        reasoningSummary: "auto",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      }),
  ).toThrow("can be configured only when Thinking is adaptive");
});

test.each([
  {
    provider: "chat_completions" as const,
    dialect: "cliproxyapi" as const,
    effort: "high" as const,
    summary: "none" as const,
    thinking: "provider_default" as const,
    thinkingBudgetTokens: null,
    expected: {
      reasoning_effort: "high",
      reasoning: { exclude: true },
      stream_options: { include_usage: true },
    },
  },
  {
    provider: "openai_responses" as const,
    dialect: "cliproxyapi" as const,
    effort: "max" as const,
    summary: "detailed" as const,
    thinking: "provider_default" as const,
    thinkingBudgetTokens: null,
    expected: {
      reasoning: { effort: "max", summary: "detailed" },
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  },
  {
    provider: "openai_responses" as const,
    dialect: "standard" as const,
    effort: "high" as const,
    summary: "none" as const,
    thinking: "provider_default" as const,
    thinkingBudgetTokens: null,
    expected: {
      reasoning: { effort: "high" },
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  },
  {
    provider: "openai_responses" as const,
    dialect: "cliproxyapi" as const,
    effort: "high" as const,
    summary: "none" as const,
    thinking: "provider_default" as const,
    thinkingBudgetTokens: null,
    expected: {
      reasoning: { effort: "high", summary: null },
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  },
  {
    provider: "anthropic_messages" as const,
    dialect: "cliproxyapi" as const,
    effort: "high" as const,
    summary: "auto" as const,
    thinking: "adaptive" as const,
    thinkingBudgetTokens: null,
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  {
    provider: "anthropic_messages" as const,
    dialect: "standard" as const,
    effort: "low" as const,
    summary: "provider_default" as const,
    thinking: "provider_default" as const,
    thinkingBudgetTokens: null,
    expected: {
      output_config: { effort: "low" },
    },
  },
  {
    provider: "anthropic_messages" as const,
    dialect: "standard" as const,
    effort: "medium" as const,
    summary: "none" as const,
    thinking: "enabled" as const,
    thinkingBudgetTokens: 1_024,
    expected: {
      thinking: {
        type: "enabled",
        budget_tokens: 1_024,
        display: "omitted",
      },
      output_config: { effort: "medium" },
    },
  },
])(
  "$provider 的 wire preview 与生产编码器共享 reasoning 请求合同",
  ({
    provider,
    dialect,
    effort,
    summary,
    thinking,
    thinkingBudgetTokens,
    expected,
  }) => {
    const host = new FileNativeModelHost({
      provider,
      dialect,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "must-not-appear",
      modelId: "reasoning-model",
      reasoningEffort: effort,
      reasoningSummary: summary,
      thinkingMode: thinking,
      thinkingBudgetTokens,
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    });
    const request = exchangeFor(
      provider,
      "reasoning-model",
      host.binding().cacheStrategy,
    );

    const preview = host.previewRequest(request);

    expect(preview).toMatchObject({
      provider,
      method: "POST",
      body: expected,
    });
    if (dialect === "cliproxyapi" && provider !== "anthropic_messages") {
      const body = preview.body as {
        messages?: unknown[];
        input?: unknown[];
        prompt_cache_key?: unknown;
      };
      expect(body.prompt_cache_key).toEqual(expect.any(String));
      const items = body.messages ?? body.input ?? [];
      expect(items.find(isSystemMessage)).toMatchObject({
        role: "system",
        cache_control: { type: "ephemeral" },
      });
      const userMessage = items.find(isUserMessage) as
        { role: "user"; content: unknown[] } | undefined;
      expect(userMessage?.role).toBe("user");
      expect(userMessage?.content[0]).toMatchObject({
        cache_control: { type: "ephemeral" },
      });
    }
    expect(JSON.stringify(preview)).not.toContain("must-not-appear");
  },
);

test("CLIProxyAPI 模型后缀保持 Thinking 唯一权威，同时独立传递返回内容", () => {
  const host = new FileNativeModelHost({
    provider: "anthropic_messages",
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "must-not-appear",
    modelId: "claude-sonnet(high)",
    reasoningEffort: "provider_default",
    reasoningSummary: "auto",
    thinkingMode: "provider_default",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });

  const preview = host.previewRequest(
    exchangeFor(
      "anthropic_messages",
      "claude-sonnet(high)",
      host.binding().cacheStrategy,
    ),
  );

  expect(preview.body).toMatchObject({
    thinking: { type: "adaptive", display: "summarized" },
  });
  expect(preview.body).not.toHaveProperty("output_config.effort");
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)("$provider 不向 Provider 发送顶层组合工具 schema", (provider) => {
  const host = new FileNativeModelHost({
    provider,
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "must-not-appear",
    modelId: "claude-through-proxy",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });

  const preview = host.previewRequest(
    exchangeFor(provider, "claude-through-proxy", host.binding().cacheStrategy),
  );
  const tools = (preview.body as { tools: Record<string, unknown>[] }).tools;
  const contextList = tools.find((tool) =>
    provider === "chat_completions"
      ? (tool.function as { name?: unknown } | undefined)?.name ===
        "context_list"
      : tool.name === "context_list",
  );
  const schema =
    provider === "chat_completions"
      ? (contextList?.function as { parameters?: unknown } | undefined)
          ?.parameters
      : provider === "openai_responses"
        ? contextList?.parameters
        : contextList?.input_schema;

  expect(contextList).toBeDefined();
  expect(schema).toMatchObject({ type: "object" });
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("allOf");
  expect(schema).not.toHaveProperty("anyOf");
});

test("历史调用链中的旧 context_list schema 也会在 Anthropic wire 边界迁移", () => {
  const host = new FileNativeModelHost({
    provider: "anthropic_messages",
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "must-not-appear",
    modelId: "claude-through-proxy",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });
  const request = exchangeFor(
    "anthropic_messages",
    "claude-through-proxy",
    host.binding().cacheStrategy,
  );
  request.toolUniverse = (request.toolUniverse ?? request.tools).map((tool) =>
    tool.name === "context_list"
      ? {
          ...tool,
          inputSchema: {
            type: "object",
            oneOf: [
              {
                type: "object",
                properties: {
                  source: { const: "state" },
                  parent: { type: "string" },
                },
                required: ["source", "parent"],
              },
              {
                type: "object",
                properties: {
                  source: { const: "history" },
                  order: { enum: ["newest_first", "oldest_first"] },
                },
                required: ["source", "order"],
              },
            ],
          },
        }
      : tool,
  );

  const tools = (
    host.previewRequest(request).body as {
      tools: { name: string; input_schema: object }[];
    }
  ).tools;
  const schema = tools.find(
    ({ name }) => name === "context_list",
  )?.input_schema;

  expect(schema).toMatchObject({
    type: "object",
    required: ["source"],
  });
  expect(schema).not.toHaveProperty("oneOf");
});

test("prompt_cache_key 在同一冻结调用链稳定，并隔离不同 CLIProxy 会话", () => {
  const host = new FileNativeModelHost({
    provider: "openai_responses",
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "claude-through-proxy",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });
  const base = exchangeFor(
    "openai_responses",
    "claude-through-proxy",
    host.binding().cacheStrategy,
  );
  const key = (request: ModelHostExchange): unknown =>
    (host.previewRequest(request).body as Record<string, unknown>)
      .prompt_cache_key;

  const first = key({ ...base, operationId: "chain-a" });
  const continued = key({
    ...base,
    operationId: "chain-a",
    appended: [...base.appended, { kind: "player", text: "Continue." }],
  });
  const other = key({ ...base, operationId: "chain-b" });

  expect(first).toEqual(expect.any(String));
  expect(continued).toBe(first);
  expect(other).not.toBe(first);
  expect(first).not.toBe("chain-a");
});

test("标准 Responses 用稳定前缀而不是内部调用链身份分组缓存", () => {
  const host = new FileNativeModelHost({
    provider: "openai_responses",
    dialect: "standard",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "openai-reasoning-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });
  const request = exchangeFor(
    "openai_responses",
    "openai-reasoning-model",
    host.binding().cacheStrategy,
  );
  const key = (operationId: string) =>
    (
      host.previewRequest({ ...request, operationId }).body as {
        prompt_cache_key: string;
      }
    ).prompt_cache_key;

  expect(key("chain-a")).toBe(key("chain-b"));
  expect(key("chain-a")).not.toBe("chain-a");
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

function exchangeFor(
  provider: ModelHostBinding["provider"],
  modelId: string,
  cacheStrategy: ModelHostBinding["cacheStrategy"],
): ModelHostExchange {
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider,
      modelId,
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
      ...(cacheStrategy === undefined ? {} : { cacheStrategy }),
      playerInput: "Inspect the actual request body.",
      playerInputPlacement: "append",
    }),
  );
  return {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.tools.map(({ name }) => name),
    toolStrategy: bootstrap.toolStrategy,
    appended: [{ kind: "player", text: "Inspect the actual request body." }],
    maxOutputTokens: 2_048,
  };
}

function isSystemMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "system"
  );
}

function isUserMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "user"
  );
}
