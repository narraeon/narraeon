import { expect, test, vi } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  type ModelHostAppendItem,
} from "../../src/runtime/model/ModelHost.ts";
import {
  compileSettingImprovementLegacyCurrentTreeBootstrap,
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  fileNativeToolsForNames,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { settingImprovementToolDefinitions } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
test.each([
  "chat_completions",
  "anthropic_messages",
  "openai_responses",
] as const)("%s 对追加提示使用编译器拥有的逻辑 role 署名", async (provider) => {
  const responseBody =
    provider === "chat_completions"
      ? {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Complete",
                tool_calls: [],
              },
            },
          ],
        }
      : provider === "anthropic_messages"
        ? { content: [{ type: "text", text: "Complete" }] }
        : {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Complete" }],
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
      playerInput: "Check appended prompt attribution.",
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
            blocks: [{ source: "author:test", markdown: "Author text" }],
            markdown: "Author text",
          },
        ],
      },
    ],
    maxOutputTokens: 2_000,
  });

  const serialized = JSON.stringify(
    JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string),
  );
  expect(serialized).toContain("# Author instruction");
});

test.each([
  "chat_completions",
  "anthropic_messages",
  "openai_responses",
] as const)("%s 把旧设定会话写入契约以系统层级发送", async (provider) => {
  const responseBody =
    provider === "chat_completions"
      ? {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Complete",
                tool_calls: [],
              },
            },
          ],
        }
      : provider === "anthropic_messages"
        ? { content: [{ type: "text", text: "Complete" }] }
        : {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Complete" }],
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
      modelId: "legacy-setting-system-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
  const legacy = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider,
      modelId: "legacy-setting-system-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "Legacy context.",
      playerInputPlacement: "bootstrap",
    }),
  );
  const oldSystem =
    "# Legacy isolated draft\n\nAll writes enter an isolated draft and require Apply.";
  const logicalSystem = legacy.logicalMessages.find(
    ({ role }) => role === "runtime_system",
  )!;
  logicalSystem.markdown = oldSystem;
  logicalSystem.blocks = [
    { source: "runtime:setting-draft-boundary", markdown: oldSystem },
  ];
  if (provider === "anthropic_messages") {
    legacy.provider.system = [{ type: "text", text: oldSystem }];
  } else {
    legacy.provider.messages = [
      { role: "system", content: oldSystem },
      ...legacy.provider.messages.filter(({ role }) => role !== "system"),
    ];
  }
  const bootstrap = compileSettingImprovementLegacyCurrentTreeBootstrap(
    legacy,
    "en",
    settingImprovementToolDefinitions("en"),
  );

  await adapter.exchange({
    bootstrap,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.toolUniverse.map(({ name }) => name),
    toolStrategy: bootstrap.toolStrategy,
    tools: bootstrap.tools,
    appended: [{ kind: "user", text: "Continue this conversation." }],
    maxOutputTokens: 2_000,
  });

  const body = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as Record<
    string,
    unknown
  >;
  const systemEntries =
    provider === "anthropic_messages"
      ? (body.system as unknown[])
      : (
          (provider === "openai_responses" ? body.input : body.messages) as {
            role?: string;
          }[]
        ).filter(({ role }) => role === "system");
  expect(JSON.stringify(systemEntries[0])).toContain("Legacy isolated draft");
  expect(JSON.stringify(systemEntries.at(-1))).toContain(
    "Runtime system contract replaces",
  );
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
      new Response(
        JSON.stringify({
          id: "resp-envelope-1",
          output: firstOutput,
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              id: "message-2",
              role: "assistant",
              content: [
                { type: "output_text", text: "Continue adjudicating." },
              ],
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
      playerInput: "Check Responses.",
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
  expect(JSON.stringify(firstRequest).split("Check Responses.")).toHaveLength(
    2,
  );
  expect(firstRequest.tools[0]).toMatchObject({
    type: "function",
    name: "state_list",
  });
  expect(firstRequest.tools[1]).toMatchObject({
    type: "function",
    name: "history_list",
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
        markdown: "# Exact read\n\nCurrent-situation source",
      },
    ],
    maxOutputTokens: 2_000,
  });
  expect(second.text).toBe("Continue adjudicating.");
  const secondRequest = JSON.parse(
    fetch_.mock.calls[1]?.[1]?.body as string,
  ) as { input: unknown[] };
  expect(secondRequest.input.slice(-3)).toEqual([
    ...firstOutput,
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "# Exact read\n\nCurrent-situation source",
    },
  ]);
  expect(JSON.stringify(secondRequest.input)).not.toContain("resp-envelope-1");
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
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "I will inspect the record before answering.",
        },
      ],
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
          status: "completed",
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
              content: [{ type: "output_text", text: "Read complete." }],
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
      playerInput: "Check the frozen tool universe.",
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
  expect(first.text).toBe("I will inspect the record before answering.");
  expect(first.stopReason).toBe("completed");
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
        text: first.text ?? "",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "call-private",
        markdown: "# Read result\n\nPrivate continuation test",
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
  expect(secondBody.input.slice(-(output.length + 1))).toEqual([
    ...output,
    {
      type: "function_call_output",
      call_id: "call-private",
      output: "# Read result\n\nPrivate continuation test",
    },
  ]);
});

test("Chat Completions 保留 reasoning_content、usage 与原始 assistant message 续传", async () => {
  const rawMessage = {
    role: "assistant",
    content: "I will inspect the record before answering.",
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
          choices: [{ message: rawMessage, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 50,
            prompt_tokens_details: {
              cached_tokens: 20,
              cached_creation_tokens: 10,
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
          choices: [
            {
              message: {
                role: "assistant",
                content: "Continue.",
                tool_calls: [],
              },
            },
          ],
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
      playerInput: "Check Chat continuation.",
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
  expect(first.text).toBe("I will inspect the record before answering.");
  expect(first.stopReason).toBe("tool_calls");
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
        text: first.text ?? "",
        reasoningContent: "private-chat-reasoning",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      { kind: "tool", toolCallId: "chat-read", markdown: "Read result" },
    ],
  });
  const secondBody = JSON.parse(fetch_.mock.calls[1]?.[1]?.body as string) as {
    messages: unknown[];
  };
  expect(secondBody.messages.at(-2)).toEqual(rawMessage);
});

test("Anthropic Messages 保留 thinking/redacted/signature block、usage、原始 assistant content 与并行工具结果", async () => {
  const rawContent = [
    {
      type: "thinking",
      thinking: "private-anthropic-thinking",
      signature: "opaque-signature",
    },
    { type: "redacted_thinking", data: "opaque-redacted" },
    {
      type: "text",
      text: "I will inspect the record before answering.",
    },
    {
      type: "tool_use",
      id: "anthropic-read",
      name: "context_read",
      input: { ref: "@current-situation" },
    },
    {
      type: "tool_use",
      id: "anthropic-search",
      name: "context_search",
      input: { query: "missing" },
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
            output_tokens_details: { thinking_tokens: 7 },
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Continue." }],
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
      playerInput: "Check Anthropic continuation.",
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
  expect(first.text).toBe("I will inspect the record before answering.");
  expect(first.stopReason).toBe("tool_use");
  expect(first.usage).toMatchObject({
    inputTokens: 105,
    uncachedInputTokens: 70,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
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
        text: first.text ?? "",
        ...(first.providerState === undefined
          ? {}
          : { providerState: first.providerState }),
        toolCalls: first.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "anthropic-read",
        markdown: "Read result",
      },
      {
        kind: "tool",
        toolCallId: "anthropic-search",
        markdown: "Search failed",
        isError: true,
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
  expect(secondBody.messages.at(-1)).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "anthropic-read",
        content: "Read result",
      },
      {
        type: "tool_result",
        tool_use_id: "anthropic-search",
        content: "Search failed",
        is_error: true,
      },
    ],
  });
  expect(JSON.stringify(secondBody.messages)).not.toContain("msg-1");
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
              content: [{ type: "output_text", text: "No tools" }],
            },
          ],
        }
      : provider === "chat_completions"
        ? {
            choices: [{ message: { role: "assistant", content: "No tools" } }],
          }
        : { content: [{ type: "text", text: "No tools" }] };
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
      playerInput: "Empty allowlist.",
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
      playerInput: "Check the Anthropic tool gate.",
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
    playerInput: "Classification test.",
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
      playerInput: "Check a malformed response.",
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
                  role: "assistant",
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
                  role: "assistant",
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
      playerInput: "Check the request.",
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
              blocks: [
                { source: "author:next", markdown: "Continue adjudicating." },
              ],
              markdown: "Continue adjudicating.",
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
    expect(serialized).toContain("Continue adjudicating.");
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
          ...(output.providerState === undefined
            ? {}
            : { providerState: output.providerState }),
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
          markdown: "# Exact read\n\nOriginal result",
        },
        {
          kind: "prompt_delta",
          logicalMessages: [
            {
              role: "author_instruction",
              blocks: [{ source: "author:next", markdown: "Next step" }],
              markdown: "Next step",
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
    expect(secondSerialized).toContain("Original result");
    expect(secondSerialized).toContain("Next step");
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
        ? {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Visible response",
                },
              },
            ],
          }
        : { content: [{ type: "text", text: "Visible response" }] };
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
    const opening =
      "Unique opening source: The brass bell rings behind the closed door for the third time.";
    const player =
      "Unique player source: I listen carefully for movement behind the door.";
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
      "state_list",
      "history_list",
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

test("Chat Completions 只原样续传原生 assistant message，缺失载荷时不从投影重建", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "Continue reasoning",
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
      playerInput: "Check continuation.",
      playerInputPlacement: "bootstrap",
    }),
  );
  const request = {
    bootstrap,
    tools: bootstrap.tools,
    appended: [
      {
        kind: "assistant" as const,
        text: "Previous-turn visible text",
        reasoningContent: "Previous-turn reasoning",
        toolCalls: [],
      },
    ],
    maxOutputTokens: 2_000,
  };
  await expect(adapter.exchange(request)).rejects.toBeInstanceOf(
    ModelHostContinuationError,
  );
  expect(fetch_).not.toHaveBeenCalled();

  const previousMessage = {
    role: "assistant",
    content: "Previous-turn visible text",
    reasoning_content: "Previous-turn reasoning",
  };
  const output = await adapter.exchange({
    ...request,
    appended: [
      {
        ...request.appended[0]!,
        providerState: {
          protocol: "chat_completions",
          assistantMessage: previousMessage,
        },
      },
    ],
  });
  const sent = JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as {
    messages: { reasoning_content?: string; tool_calls?: unknown[] }[];
  };
  expect(sent.messages.at(-1)).toEqual(previousMessage);
  expect(output).toMatchObject({
    reasoningContent: "Continue reasoning",
    toolCalls: [
      {
        id: "bad",
        name: "world_patch",
        arguments: { $invalidToolArgumentsJson: "{bad" },
      },
    ],
  });
});

test.each([
  {
    provider: "chat_completions" as const,
    providerState: {
      protocol: "chat_completions" as const,
      assistantMessage: { role: "assistant", content: { corrupt: true } },
    },
  },
  {
    provider: "openai_responses" as const,
    providerState: {
      protocol: "openai_responses" as const,
      output: [{ type: "message", content: "corrupt" }],
    },
  },
  {
    provider: "anthropic_messages" as const,
    providerState: {
      protocol: "anthropic_messages" as const,
      content: [{ type: "thinking", signature: "missing-thinking" }],
    },
  },
])(
  "$provider 的损坏原生续传载荷在派发前 fail closed",
  async ({ provider, providerState }) => {
    const fetch_ = vi.fn<typeof fetch>();
    const adapter = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "continuation-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider,
        modelId: "continuation-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
        playerInput: "Check corrupt continuation.",
        playerInputPlacement: "bootstrap",
      }),
    );

    await expect(
      adapter.exchange({
        bootstrap,
        tools: bootstrap.tools,
        appended: [
          {
            kind: "assistant",
            text: "Projection must not be used.",
            reasoningContent: "Nor this projection.",
            providerState,
            toolCalls: [],
          },
        ],
        maxOutputTokens: 2_000,
      }),
    ).rejects.toBeInstanceOf(ModelHostContinuationError);
    expect(fetch_).not.toHaveBeenCalled();
  },
);

test.each(["chat_completions", "anthropic_messages"] as const)(
  "%s 连续首条玩家原文只在 append 中出现一次",
  async (provider) => {
    const responseBody =
      provider === "chat_completions"
        ? {
            choices: [{ message: { role: "assistant", content: "Continue." } }],
          }
        : { content: [{ type: "text", text: "Continue." }] };
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
        playerInput: "Unique continuous-opening marker",
        playerInputPlacement: "append",
      }),
    );

    const continuousPlayTools = fileNativeToolsForNames([
      "state_list",
      "history_list",
      "context_search",
      "context_read",
    ]);
    await adapter.exchange({
      bootstrap,
      tools: continuousPlayTools,
      toolUniverse: bootstrap.toolUniverse,
      allowedTools: continuousPlayTools.map(({ name }) => name),
      toolStrategy: bootstrap.toolStrategy,
      appended: [{ kind: "player", text: "Unique continuous-opening marker" }],
      requestId: "continuous_play",
      operationId: "continuous-first-message",
      requestAttempt: 1,
      maxOutputTokens: 2_000,
    });

    const serialized = fetch_.mock.calls[0]?.[1]?.body as string;
    expect(serialized.split("Unique continuous-opening marker")).toHaveLength(
      2,
    );
    const body = JSON.parse(serialized) as {
      tools: { function?: { name: string }; name?: string }[];
      tool_choice?: unknown;
      messages?: { content?: unknown }[];
    };
    expect(body.tools.map((tool) => tool.function?.name ?? tool.name)).toEqual([
      "state_list",
      "history_list",
      "context_search",
      "context_read",
      "world_patch",
      "world_create",
      "world_retire",
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
    const narrator =
      "Unique committed narrator source: Alex tilts his head toward the stairs.";
    const response = (text: string) =>
      provider === "chat_completions"
        ? {
            choices: [{ message: { role: "assistant", content: text } }],
          }
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
        new Response(JSON.stringify(response("Second response.")), {
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
    const firstPlayer =
      "Unique first player source: I wait beside the door for his signal.";
    const secondPlayer =
      "Unique second player source: I signal for him to continue.";
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
      "state_list",
      "history_list",
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
      throw new Error(
        "The production Adapter did not return persistable Provider state",
      );
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
