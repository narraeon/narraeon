import { expect, test, vi } from "vitest";

import {
  FileNativeModelHost,
  FileNativeSettingAuthorProvider,
} from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  type ModelHostAppendItem,
} from "../../src/runtime/model/ModelHost.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  fileNativeToolsForNames,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { documentCandidateSettingTools } from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";

test.each([
  "chat_completions",
  "anthropic_messages",
  "openai_responses",
] as const)("%s 对追加提示使用编译器拥有的逻辑 role 署名", async (provider) => {
  const responseBody =
    provider === "chat_completions"
      ? { choices: [{ message: { content: "完成", tool_calls: [] } }] }
      : provider === "anthropic_messages"
        ? { content: [{ type: "text", text: "完成" }] }
        : {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "完成" }],
              },
            ],
          };
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );
  const adapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "delta-role-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider,
      modelId: "delta-role-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查追加提示署名。",
      playerInputPlacement: "bootstrap",
    }),
  );

  await adapter.exchange({
    bootstrap,
    tools: bootstrap.tools,
    appended: [
      {
        kind: "prompt_delta",
        logicalMessages: [
          {
            role: "author_instruction",
            blocks: [{ source: "author:test", markdown: "作者正文" }],
            markdown: "作者正文",
          },
        ],
      },
    ],
    maxOutputTokens: 2_000,
  });

  const serialized = JSON.stringify(
    JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string),
  );
  expect(serialized).toContain("# 作者提示");
});

test("OpenAI Responses 使用扁平工具定义并逐次原样重放 output items", async () => {
  const firstOutput = [
    {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "opaque-provider-state",
      summary: [],
    },
    {
      type: "function_call",
      id: "function-1",
      call_id: "call-1",
      name: "context_read",
      arguments: '{"ref":"@current-situation"}',
    },
  ];
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ output: firstOutput }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              id: "message-2",
              role: "assistant",
              content: [{ type: "output_text", text: "继续裁决。" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
  const adapter = new FileNativeModelHost(
    {
      provider: "openai_responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      modelId: "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "openai_responses",
      modelId: "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查 Responses。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const first = await adapter.exchange({
    bootstrap,
    tools: bootstrap.tools,
    appended: [],
    maxOutputTokens: 2_000,
  });
  expect(first).toMatchObject({
    toolCalls: [
      {
        id: "call-1",
        name: "context_read",
        arguments: { ref: "@current-situation" },
      },
    ],
    providerState: { protocol: "openai_responses", output: firstOutput },
  });
  const firstRequest = JSON.parse(
    fetch_.mock.calls[0]?.[1]?.body as string,
  ) as {
    input: unknown[];
    tools: Record<string, unknown>[];
    store: boolean;
    include: string[];
  };
  expect((fetch_.mock.calls[0]?.[0] as URL).toString()).toBe(
    "https://api.openai.com/v1/responses",
  );
  expect(firstRequest.store).toBe(false);
  expect(firstRequest.include).toEqual(["reasoning.encrypted_content"]);
  expect(JSON.stringify(firstRequest).split("检查 Responses。")).toHaveLength(
    2,
  );
  expect(firstRequest.tools[0]).toMatchObject({
    type: "function",
    name: "context_list",
  });
  expect(firstRequest.tools[0]).not.toHaveProperty("function");

  const second = await adapter.exchange({
    bootstrap,
    tools: bootstrap.tools,
    appended: [
      {
        kind: "assistant",
        text: "",
        providerState: first.providerState!,
        toolCalls: first.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "call-1",
        markdown: "# 精确读取\n\n当前情境原文",
      },
    ],
    maxOutputTokens: 2_000,
  });
  expect(second.text).toBe("继续裁决。");
  const secondRequest = JSON.parse(
    fetch_.mock.calls[1]?.[1]?.body as string,
  ) as { input: unknown[] };
  expect(secondRequest.input.slice(-3)).toEqual([
    ...firstOutput,
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "# 精确读取\n\n当前情境原文",
    },
  ]);
});

test("OpenAI Responses 冻结全集并用 native allowed subset，usage 与 encrypted reasoning 私有续传", async () => {
  const output = [
    {
      type: "reasoning",
      id: "reasoning-private",
      encrypted_content: "encrypted-private",
      summary: [],
    },
    {
      type: "function_call",
      id: "call-private",
      call_id: "call-private",
      name: "context_read",
      arguments: '{"ref":"@current-situation"}',
    },
  ];
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "resp-1",
          output,
          usage: {
            input_tokens: 120,
            input_tokens_details: {
              cached_tokens: 80,
              cache_write_tokens: 20,
            },
            output_tokens: 24,
            output_tokens_details: { reasoning_tokens: 16 },
            total_tokens: 144,
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "resp-2",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "已读取。" }],
            },
          ],
          usage: { input_tokens: 160, output_tokens: 4, total_tokens: 164 },
        }),
        { status: 200 },
      ),
    );
  const adapter = new FileNativeModelHost(
    {
      provider: "openai_responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      modelId: "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "openai_responses",
      modelId: "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查冻结全集。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const base = {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.tools,
    allowedTools: ["context_read"],
    toolStrategy: "native_allowed_subset" as const,
    requestId: "read",
    operationId: "operation-tool-cache",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  };
  const first = await adapter.exchange({ ...base, appended: [] });
  expect(first.providerState).toEqual({
    protocol: "openai_responses",
    output,
    responseId: "resp-1",
  });
  expect(first.usage).toMatchObject({
    inputTokens: 120,
    uncachedInputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 20,
    reasoningTokens: 16,
    outputTokens: 24,
    totalTokens: 144,
    provenance: {
      inputTokens: "provider",
      uncachedInputTokens: "derived_provider_fields",
      cacheReadTokens: "provider",
      cacheWriteTokens: "provider",
    },
  });
  const firstBody = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
    tools: unknown[];
    tool_choice: unknown;
  };
  expect(firstBody.tool_choice).toEqual({
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "context_read" }],
  });
  expect(
    firstBody.tools.map((tool) => (tool as { name: string }).name),
  ).toEqual(bootstrap.tools.map(({ name }) => name));

  const second = await adapter.exchange({
    ...base,
    exchange: 2,
    appended: [
      {
        kind: "assistant",
        text: "",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "call-private",
        markdown: "# 读取结果\n\n私有续传测试",
      },
    ],
  });
  expect(second.usage).toMatchObject({
    inputTokens: 160,
    uncachedInputTokens: null,
    provenance: {
      uncachedInputTokens: "unavailable",
    },
  });
  const secondBody = JSON.parse(fetch_.mock.calls[1]?.[1]?.body as string) as {
    tools: unknown[];
    input: unknown[];
  };
  expect(secondBody.tools).toEqual(firstBody.tools);
  expect(secondBody.input.slice(-3)).toEqual([
    ...output,
    {
      type: "function_call_output",
      call_id: "call-private",
      output: "# 读取结果\n\n私有续传测试",
    },
  ]);
});

test("OpenAI Responses 设定完善保留 provider output 并回送工具结果", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "完成" }],
          },
        ],
      }),
      { status: 200 },
    ),
  );
  const adapter = new FileNativeSettingAuthorProvider(
    {
      provider: "openai_responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      modelId: "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const previousOutput = [
    {
      type: "function_call",
      call_id: "setting-read-1",
      name: "setting_read",
      arguments: '{"path":"world/current-situation.yaml"}',
    },
  ];
  const output = await adapter.next({
    messages: [
      { role: "system", content: "只编辑候选" },
      { role: "user", content: "完善设定" },
      {
        role: "assistant",
        content: "",
        providerState: {
          protocol: "openai_responses",
          output: previousOutput,
        },
        toolCalls: [
          {
            id: "setting-read-1",
            name: "setting_read",
            arguments: { path: "world/current-situation.yaml" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "setting-read-1",
        content: "# 文件原文",
      },
    ],
    tools: documentCandidateSettingTools,
    maxOutputTokens: 1_024,
  });
  expect(output).toMatchObject({
    content: "完成",
    providerState: { protocol: "openai_responses" },
  });
  const body = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
    input: unknown[];
    tools: Record<string, unknown>[];
  };
  expect(body.input).toEqual(
    expect.arrayContaining([
      ...previousOutput,
      {
        type: "function_call_output",
        call_id: "setting-read-1",
        output: "# 文件原文",
      },
    ]),
  );
  expect(body.tools[0]).toHaveProperty("name");
  expect(body.tools[0]).not.toHaveProperty("function");
});

test("Chat Completions 保留 reasoning_content、usage 与原始 assistant message 续传", async () => {
  const rawMessage = {
    role: "assistant",
    content: null,
    reasoning_content: "private-chat-reasoning",
    tool_calls: [
      {
        id: "chat-read",
        type: "function",
        function: {
          name: "context_read",
          arguments: '{"ref":"@current-situation"}',
        },
      },
    ],
  };
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: rawMessage }],
          usage: {
            prompt_tokens: 50,
            prompt_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 10,
            },
            completion_tokens: 12,
            completion_tokens_details: { reasoning_tokens: 8 },
            total_tokens: 62,
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "继续。", tool_calls: [] } }],
        }),
        { status: 200 },
      ),
    );
  const adapter = new FileNativeModelHost(
    {
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "chat-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "chat-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查 Chat 续传。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const base = {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.tools,
    allowedTools: ["context_read"],
    toolStrategy: "runtime_gate" as const,
    requestId: "read",
    operationId: "operation-chat-state",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  };
  const first = await adapter.exchange({ ...base, appended: [] });
  expect(first.providerState).toEqual({
    protocol: "chat_completions",
    assistantMessage: rawMessage,
  });
  expect(first.usage).toMatchObject({
    inputTokens: 50,
    uncachedInputTokens: 20,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 8,
    outputTokens: 12,
    totalTokens: 62,
    provenance: { uncachedInputTokens: "derived_provider_fields" },
  });
  await adapter.exchange({
    ...base,
    exchange: 2,
    appended: [
      {
        kind: "assistant",
        text: "",
        reasoningContent: "private-chat-reasoning",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      { kind: "tool", toolCallId: "chat-read", markdown: "读取结果" },
    ],
  });
  const secondBody = JSON.parse(fetch_.mock.calls[1]?.[1]?.body as string) as {
    messages: unknown[];
  };
  expect(secondBody.messages.at(-2)).toEqual(rawMessage);
});

test("Anthropic Messages 保留 thinking/redacted/signature block、usage 与原始 assistant content 续传", async () => {
  const rawContent = [
    { type: "thinking", thinking: "private-anthropic-thinking" },
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "signature", signature: "opaque-signature" },
    {
      type: "tool_use",
      id: "anthropic-read",
      name: "context_read",
      input: { ref: "@current-situation" },
    },
  ];
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "msg-1",
          model: "claude-test",
          stop_reason: "tool_use",
          content: rawContent,
          usage: {
            input_tokens: 70,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 5,
            output_tokens: 18,
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "继续。" }],
          usage: { input_tokens: 80, output_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
  const adapter = new FileNativeModelHost(
    {
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "anthropic_messages",
      modelId: "claude-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查 Anthropic 续传。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const base = {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.tools,
    allowedTools: ["context_read"],
    toolStrategy: "runtime_gate" as const,
    requestId: "read",
    operationId: "operation-anthropic-state",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  };
  const first = await adapter.exchange({ ...base, appended: [] });
  expect(first.providerState).toEqual({
    protocol: "anthropic_messages",
    content: rawContent,
    responseId: "msg-1",
    model: "claude-test",
    stopReason: "tool_use",
  });
  expect(first.usage).toMatchObject({
    inputTokens: 105,
    uncachedInputTokens: 70,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    outputTokens: 18,
    totalTokens: 123,
    provenance: {
      inputTokens: "derived_provider_fields",
      uncachedInputTokens: "provider",
      totalTokens: "derived_provider_fields",
    },
  });
  await adapter.exchange({
    ...base,
    exchange: 2,
    appended: [
      {
        kind: "assistant",
        text: "",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "anthropic-read",
        markdown: "读取结果",
      },
    ],
  });
  const secondBody = JSON.parse(fetch_.mock.calls[1]?.[1]?.body as string) as {
    messages: unknown[];
  };
  expect(secondBody.messages.at(-2)).toEqual({
    role: "assistant",
    content: rawContent,
  });
});

test.each([
  "openai_responses",
  "chat_completions",
  "anthropic_messages",
] as const)("%s 对空请求 allowlist 保持工具定义策略", async (provider) => {
  const responseBody =
    provider === "openai_responses"
      ? {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "无工具" }],
            },
          ],
        }
      : provider === "chat_completions"
        ? { choices: [{ message: { content: "无工具" } }] }
        : { content: [{ type: "text", text: "无工具" }] };
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );
  const adapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "none-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider,
      modelId: "none-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "空 allowlist。",
      playerInputPlacement: "bootstrap",
    }),
  );
  await adapter.exchange({
    bootstrap,
    tools: [],
    toolUniverse: bootstrap.tools,
    allowedTools: [],
    toolStrategy: "runtime_gate",
    appended: [],
    requestId: "none",
    operationId: "operation-none",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  });
  const body = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as Record<
    string,
    unknown
  >;
  if (provider === "openai_responses" || provider === "chat_completions") {
    expect(body.tool_choice).toBe("none");
    expect(body.tools).toBeDefined();
  } else {
    expect(body.tools).toBeDefined();
  }
});

test("Anthropic runtime_gate 在空/非空 allowlist 间保持稳定全集 definitions", async () => {
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
          { status: 200 },
        ),
      ),
    );
  const adapter = new FileNativeModelHost(
    {
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "anthropic_messages",
      modelId: "claude-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查 Anthropic tool gate。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const request = {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.tools,
    toolStrategy: "runtime_gate" as const,
    requestId: "request-none",
    operationId: "anthropic-tool-gate",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
    appended: [],
  };
  await adapter.exchange({ ...request, allowedTools: ["context_read"] });
  await adapter.exchange({
    ...request,
    allowedTools: [],
    exchange: 2,
  });
  const firstBody = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
    tools: unknown[];
  };
  const secondBody = JSON.parse(fetch_.mock.calls[1]?.[1]?.body as string) as {
    tools: unknown[];
  };
  expect(secondBody.tools).toEqual(firstBody.tools);
});

test.each([
  "openai_responses",
  "chat_completions",
  "anthropic_messages",
] as const)("%s 派发后未知与确认拒绝分类不依赖错误文字", async (provider) => {
  const input = createMinimalFileNativePreviewInput({
    provider,
    modelId: "classification-model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
    playerInput: "分类测试。",
    playerInputPlacement: "bootstrap",
  });
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(input);
  const request = {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.tools,
    allowedTools: ["context_read"],
    toolStrategy: "runtime_gate" as const,
    appended: [],
    requestId: "request",
    operationId: "classification",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  };
  const unknownAdapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "classification-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")),
  );
  await expect(unknownAdapter.exchange(request)).rejects.toBeInstanceOf(
    ModelHostOutcomeUnknownError,
  );

  const malformedBody =
    provider === "openai_responses"
      ? JSON.stringify({ output: "not-array" })
      : provider === "chat_completions"
        ? JSON.stringify({ choices: [] })
        : JSON.stringify({ content: "not-array" });
  const malformedAdapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "classification-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(malformedBody, { status: 200 })),
  );
  await expect(malformedAdapter.exchange(request)).rejects.toBeInstanceOf(
    ModelHostOutcomeUnknownError,
  );

  const malformedJsonAdapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "classification-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{not-json", { status: 200 })),
  );
  await expect(malformedJsonAdapter.exchange(request)).rejects.toBeInstanceOf(
    ModelHostOutcomeUnknownError,
  );

  const rejectedAdapter = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "classification-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("rate limited", { status: 429 })),
  );
  await expect(rejectedAdapter.exchange(request)).rejects.toBeInstanceOf(
    ModelHostFailureError,
  );
});

test.each([
  { field: "content", value: {} },
  { field: "reasoning_content", value: 42 },
] as const)(
  "Chat 200 响应的 $field 不是 string|null 时在 Adapter 边界分类为 outcome unknown",
  async ({ field, value }) => {
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "malformed-chat-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查畸形响应。",
      playerInputPlacement: "bootstrap",
    });
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(input);
    const adapter = new FileNativeModelHost(
      {
        provider: "chat_completions",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "malformed-chat-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: null,
                  [field]: value,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.exchange({
        bootstrap,
        tools: bootstrap.tools,
        appended: [],
        maxOutputTokens: 2_000,
      }),
    ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  },
);

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s request trace 保持 Markdown role、工具交换和 append-only 前缀",
  async (provider) => {
    const responseBody =
      provider === "chat_completions"
        ? {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "finish",
                      function: {
                        name: "world_patch",
                        arguments: '{"nextMaterials":[]}',
                      },
                    },
                  ],
                },
              },
            ],
          }
        : {
            content: [
              {
                type: "tool_use",
                id: "finish",
                name: "world_patch",
                input: { nextMaterials: [] },
              },
            ],
          };
    const fetch_ = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const adapter = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const input = createMinimalFileNativePreviewInput({
      provider,
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查请求。",
      playerInputPlacement: "bootstrap",
    });
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(input);
    const output = await adapter.exchange({
      bootstrap,
      tools: bootstrap.tools,
      appended: [
        {
          kind: "prompt_delta",
          logicalMessages: [
            {
              role: "author_instruction",
              blocks: [{ source: "author:next", markdown: "继续裁决。" }],
              markdown: "继续裁决。",
            },
          ],
        },
      ],
      maxOutputTokens: 2_000,
    });
    expect(output.toolCalls).toEqual([
      {
        id: "finish",
        name: "world_patch",
        arguments: { nextMaterials: [] },
      },
    ]);
    const init = fetch_.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("继续裁决。");
    expect(serialized).toContain("world_patch");
    expect(body.tool_choice).toBe(
      provider === "chat_completions" ? "auto" : undefined,
    );
    expect(serialized).not.toMatch(
      /hostPresetId|materialId|recordId|schemaId|operationId|\/home\//u,
    );
    expect((fetch_.mock.calls[0]?.[0] as URL).toString()).toMatch(
      provider === "chat_completions" ? /chat\/completions$/u : /messages$/u,
    );
    await adapter.exchange({
      bootstrap,
      tools: bootstrap.tools,
      appended: [
        {
          kind: "assistant",
          text: "",
          toolCalls: [
            {
              id: "read-1",
              name: "context_read",
              arguments: { ref: "@current-situation" },
            },
          ],
        },
        {
          kind: "tool",
          toolCallId: "read-1",
          markdown: "# 精确读取\n\n原始结果",
        },
        {
          kind: "prompt_delta",
          logicalMessages: [
            {
              role: "author_instruction",
              blocks: [{ source: "author:next", markdown: "下一步" }],
              markdown: "下一步",
            },
          ],
        },
      ],
      maxOutputTokens: 2_000,
    });
    const second = JSON.parse(
      fetch_.mock.calls[1]?.[1]?.body as string,
    ) as unknown;
    const secondSerialized = JSON.stringify(second);
    expect(secondSerialized).toContain("context_read");
    expect(secondSerialized).toContain("原始结果");
    expect(secondSerialized).toContain("下一步");
  },
);

test.each([
  ["chat_completions", "bootstrap"],
  ["chat_completions", "append"],
  ["anthropic_messages", "bootstrap"],
  ["anthropic_messages", "append"],
] as const)(
  "%s 的 %s 玩家输入各只进入首次请求一次",
  async (provider, playerInputPlacement) => {
    const responseBody =
      provider === "chat_completions"
        ? { choices: [{ message: { content: "可见回复" } }] }
        : { content: [{ type: "text", text: "可见回复" }] };
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const opening = "唯一开场原文：铜铃在紧闭的门后响了第三次。";
    const player = "唯一玩家原文：我先侧耳听门后的动静。";
    const input = createMinimalFileNativePreviewInput({
      provider,
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: player,
      playerInputPlacement,
    });
    input.world.history = { "world.message.genesis.narrator": opening };
    input.world.additionalMaterials = [
      {
        kind: "history_message",
        message: "world.message.genesis.narrator",
      },
    ];
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(input);

    const appendedTools = fileNativeToolsForNames([
      "context_list",
      "context_search",
      "context_read",
    ]);
    const exchangeBase = {
      bootstrap,
      tools:
        playerInputPlacement === "append" ? appendedTools : bootstrap.tools,
      maxOutputTokens: 2_000,
    };
    if (playerInputPlacement === "append")
      await adapter.exchange({
        ...exchangeBase,
        toolUniverse: bootstrap.toolUniverse,
        allowedTools: appendedTools.map(({ name }) => name),
        toolStrategy: bootstrap.toolStrategy,
        appended: [{ kind: "player", text: player }],
        requestId: "play_append",
        operationId: "play-request-trace",
        requestAttempt: 1,
      });
    else
      await adapter.exchange({
        ...exchangeBase,
        appended: [],
      });

    const serialized = fetch_.mock.calls[0]?.[1]?.body as string;
    expect(serialized.split(opening)).toHaveLength(
      playerInputPlacement === "append" ? 1 : 2,
    );
    expect(serialized.split(player)).toHaveLength(2);
  },
);

test("Chat Completions 续传 reasoning_content，空工具数组不进入请求，畸形参数留在可修复协议内", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: "继续思考",
              tool_calls: [
                {
                  id: "bad",
                  function: { name: "world_patch", arguments: "{bad" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const adapter = new FileNativeModelHost(
    {
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "thinking-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "thinking-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "检查续传。",
      playerInputPlacement: "bootstrap",
    }),
  );
  const output = await adapter.exchange({
    bootstrap,
    tools: bootstrap.tools,
    appended: [
      {
        kind: "assistant",
        text: "上轮可见文本",
        reasoningContent: "上轮思考",
        toolCalls: [],
      },
    ],
    maxOutputTokens: 2_000,
  });
  const request = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
    messages: { reasoning_content?: string; tool_calls?: unknown[] }[];
  };
  expect(request.messages.at(-1)).toMatchObject({
    reasoning_content: "上轮思考",
  });
  expect(request.messages.at(-1)).not.toHaveProperty("tool_calls");
  expect(output).toMatchObject({
    reasoningContent: "继续思考",
    toolCalls: [
      {
        id: "bad",
        name: "world_patch",
        arguments: { $invalidToolArgumentsJson: "{bad" },
      },
    ],
  });
});

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s 连续首条玩家原文只在 append 中出现一次",
  async (provider) => {
    const responseBody =
      provider === "chat_completions"
        ? { choices: [{ message: { content: "继续。" } }] }
        : { content: [{ type: "text", text: "继续。" }] };
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider,
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
        playerInput: "连续首句唯一标记",
        playerInputPlacement: "append",
      }),
    );

    const continuousPlayTools = fileNativeToolsForNames([
      "context_list",
      "context_search",
      "context_read",
    ]);
    await adapter.exchange({
      bootstrap,
      tools: continuousPlayTools,
      toolUniverse: bootstrap.toolUniverse,
      allowedTools: continuousPlayTools.map(({ name }) => name),
      toolStrategy: bootstrap.toolStrategy,
      appended: [{ kind: "player", text: "连续首句唯一标记" }],
      requestId: "continuous_play",
      operationId: "continuous-first-message",
      requestAttempt: 1,
      maxOutputTokens: 2_000,
    });

    const serialized = fetch_.mock.calls[0]?.[1]?.body as string;
    expect(serialized.split("连续首句唯一标记")).toHaveLength(2);
    const body = JSON.parse(serialized) as {
      tools: { function?: { name: string }; name?: string }[];
      tool_choice?: unknown;
      messages?: { content?: unknown }[];
    };
    expect(body.tools.map((tool) => tool.function?.name ?? tool.name)).toEqual([
      "context_list",
      "context_search",
      "context_read",
      "world_patch",
      "world_create",
      "artifact_emit",
      "artifact_clear",
    ]);
    expect(body.tool_choice).toBe(
      provider === "chat_completions" ? "auto" : undefined,
    );
    const bootstrapUser = body.messages?.find(
      ({ content }) => Array.isArray(content) && content.length > 0,
    );
    expect(Array.isArray(bootstrapUser?.content)).toBe(true);
    const parts = bootstrapUser?.content as unknown[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(typeof (parts[0] as { text?: unknown }).text).toBe("string");
  },
);

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s 连续追加按原顺序重放持久逻辑 transcript 与 Provider state",
  async (provider) => {
    const narrator = "唯一已确认主持原文：秦龙朝楼梯口偏了偏头。";
    const response = (text: string) =>
      provider === "chat_completions"
        ? { choices: [{ message: { content: text } }] }
        : { content: [{ type: "text", text }] };
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response(narrator)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response("第二条回复。")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const adapter = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "rotated-secret",
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const firstPlayer = "唯一第一条玩家原文：我贴着门边等他示意。";
    const secondPlayer = "唯一第二条玩家原文：我示意他继续说。";
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider,
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
        playerInput: firstPlayer,
        playerInputPlacement: "append",
      }),
    );
    const continuousPlayTools = fileNativeToolsForNames([
      "context_list",
      "context_search",
      "context_read",
    ]);
    const base = {
      bootstrap,
      tools: continuousPlayTools,
      toolUniverse: bootstrap.toolUniverse,
      allowedTools: continuousPlayTools.map(({ name }) => name),
      toolStrategy: bootstrap.toolStrategy,
      requestId: "continuous_play" as const,
      operationId: "continuous-append-trace",
      requestAttempt: 1,
      maxOutputTokens: 2_000,
    };
    const first = await adapter.exchange({
      ...base,
      appended: [{ kind: "player", text: firstPlayer }],
    });
    if (first.providerState === undefined)
      throw new Error("生产 Adapter 没有返回可持久化的 Provider state");
    const transcript: ModelHostAppendItem[] = [
      { kind: "player", text: firstPlayer },
      {
        kind: "assistant",
        text: narrator,
        providerState: first.providerState,
        toolCalls: [],
      },
      { kind: "player", text: secondPlayer },
    ];
    await adapter.exchange({ ...base, appended: transcript });

    const serialized = fetch_.mock.calls[1]?.[1]?.body as string;
    for (const marker of [firstPlayer, narrator, secondPlayer])
      expect(serialized.split(marker)).toHaveLength(2);
    expect(serialized.indexOf(firstPlayer)).toBeLessThan(
      serialized.indexOf(narrator),
    );
    expect(serialized.indexOf(narrator)).toBeLessThan(
      serialized.indexOf(secondPlayer),
    );
  },
);

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s 设定完善逐轮重放 assistant tool call 与对应 tool result",
  async (provider) => {
    const responseBody =
      provider === "chat_completions"
        ? { choices: [{ message: { content: "完成", tool_calls: [] } }] }
        : { content: [{ type: "text", text: "完成" }] };
    const fetch_ = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const adapter = new FileNativeSettingAuthorProvider(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    await adapter.next({
      messages: [
        { role: "user", content: "完善设定" },
        {
          role: "assistant",
          content: "",
          reasoningContent: "先读取",
          toolCalls: [
            {
              id: "setting-read-1",
              name: "setting_read",
              arguments: { path: "world/current-situation.yaml" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "setting-read-1",
          content: "# 文件原文",
        },
      ],
      tools: documentCandidateSettingTools,
      maxOutputTokens: 1_024,
    });
    const body = JSON.parse(
      fetch_.mock.calls[0]?.[1]?.body as string,
    ) as unknown;
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("setting-read-1");
    expect(serialized).toContain("setting_read");
    expect(serialized).toContain("# 文件原文");
    expect(serialized).toContain('"additionalProperties":false');
    for (const field of [
      "path",
      "contents",
      "from",
      "to",
      "document",
      "op",
      "locator",
    ])
      expect(serialized).toContain(`"${field}"`);
    if (provider === "chat_completions")
      expect(serialized).toContain("reasoning_content");
    else expect(serialized).toContain("tool_use");
  },
);

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s 设定计划把宿主契约放在 system 且不发送编辑工具",
  async (provider) => {
    const responseBody =
      provider === "chat_completions"
        ? { choices: [{ message: { content: "# 创作计划\n\n简洁计划" } }] }
        : { content: [{ type: "text", text: "# 创作计划\n\n简洁计划" }] };
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new FileNativeSettingAuthorProvider(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "model",
        contextWindowTokens: 128_000,
        maxOutputTokens: 100_000,
      },
      fetch_,
    );

    await adapter.next({
      messages: [
        { role: "system", content: "# 固定创作契约" },
        { role: "user", content: "创建一个小世界" },
      ],
      tools: [],
      maxOutputTokens: 4_096,
    });

    const body = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
      system?: string;
      messages: { role: string; content: unknown }[];
      tools?: unknown;
      max_tokens: number;
    };
    expect(body).not.toHaveProperty("tools");
    expect(body.max_tokens).toBe(4_096);
    if (provider === "chat_completions") {
      expect(body.messages[0]).toMatchObject({
        role: "system",
        content: "# 固定创作契约",
      });
    } else {
      expect(body.system).toBe("# 固定创作契约");
      expect(body.messages).toEqual([
        { role: "user", content: "创建一个小世界" },
      ]);
    }
  },
);
