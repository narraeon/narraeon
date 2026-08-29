import { expect, test, vi } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  ModelHostOutcomeUnknownError,
  type ModelHostDelta,
  type ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import type { ModelProviderKind } from "../../src/protocol/modelConnections.ts";

test("Chat Completions 游玩请求用 SSE 聚合正文、reasoning、工具与 usage", async () => {
  const deltas: ModelHostDelta[] = [];
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    sseResponse(
      [
        data({
          id: "chat-stream-1",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", reasoning_content: "Analysis" },
            },
          ],
        }),
        data({
          id: "chat-stream-1",
          choices: [{ index: 0, delta: { content: "The door creaks." } }],
        }),
        data({
          id: "chat-stream-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-stream-1",
                    type: "function",
                    function: {
                      name: "context_read",
                      arguments: '{"ref":',
                    },
                  },
                ],
              },
            },
          ],
        }),
        data({
          id: "chat-stream-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"@scene"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        data({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 18,
            total_tokens: 138,
          },
        }),
        "data: [DONE]\n\n",
      ],
      true,
    ),
  );
  const host = modelHost("chat_completions", fetch_);

  const response = await host.exchange(exchange("chat_completions"), {
    onDelta: (delta) => deltas.push(structuredClone(delta)),
  });

  expect(requestBody(fetch_)).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(deltas).toEqual([
    { kind: "reasoning", text: "Analysis" },
    { kind: "text", text: "The door creaks." },
    { kind: "tool", text: '{"ref":' },
    { kind: "tool", text: '"@scene"}' },
  ]);
  expect(response).toMatchObject({
    text: "The door creaks.",
    reasoningContent: "Analysis",
    toolCalls: [
      {
        id: "call-stream-1",
        name: "context_read",
        arguments: { ref: "@scene" },
      },
    ],
    usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
    providerState: {
      protocol: "chat_completions",
      assistantMessage: {
        role: "assistant",
        content: "The door creaks.",
        reasoning_content: "Analysis",
        tool_calls: [
          {
            id: "call-stream-1",
            type: "function",
            function: {
              name: "context_read",
              arguments: '{"ref":"@scene"}',
            },
          },
        ],
      },
    },
  });
});

test("Chat Completions 流把工具分片里的 null 字段当作未提供", async () => {
  const deltas: ModelHostDelta[] = [];
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    sseResponse(
      [
        data({
          choices: [{ index: 0, delta: { role: "assistant" } }],
          usage: null,
        }),
        data({
          choices: [{ index: 0, delta: { content: "", tool_calls: null } }],
          usage: null,
        }),
        data({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-gateway-1",
                    type: "function",
                    function: { name: "context_read", arguments: "" },
                  },
                ],
              },
            },
          ],
          usage: null,
        }),
        data({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: null,
                    type: null,
                    function: {
                      name: null,
                      arguments: '{"ref":"@history"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 309, completion_tokens: 471 },
        }),
        "data: [DONE]\n\n",
      ],
      true,
    ),
  );
  const host = modelHost("chat_completions", fetch_);

  const response = await host.exchange(exchange("chat_completions"), {
    onDelta: (delta) => deltas.push(structuredClone(delta)),
  });

  expect(deltas).toEqual([{ kind: "tool", text: '{"ref":"@history"}' }]);
  expect(response).toMatchObject({
    toolCalls: [
      {
        id: "call-gateway-1",
        name: "context_read",
        arguments: { ref: "@history" },
      },
    ],
    usage: { inputTokens: 309, outputTokens: 471 },
  });
});

test("OpenAI Responses 游玩请求从 response.completed 取得完整 continuation", async () => {
  const output = [
    {
      type: "reasoning",
      id: "reasoning-stream-1",
      encrypted_content: "opaque-reasoning",
      summary: [],
    },
    {
      type: "function_call",
      id: "function-stream-1",
      call_id: "call-responses-stream-1",
      name: "context_read",
      arguments: '{"ref":"@scene"}',
    },
    {
      type: "message",
      id: "message-stream-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The wind stops." }],
    },
  ];
  const completed = {
    id: "response-stream-1",
    status: "completed",
    output,
    usage: { input_tokens: 210, output_tokens: 34, total_tokens: 244 },
  };
  const deltas: ModelHostDelta[] = [];
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    sseResponse(
      [
        namedData("response.reasoning_text.delta", {
          type: "response.reasoning_text.delta",
          delta: "Check",
        }),
        namedData("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: '{"ref":"@scene"}',
        }),
        namedData("response.output_text.delta", {
          type: "response.output_text.delta",
          delta: "The wind stops.",
        }),
        namedData("response.completed", {
          type: "response.completed",
          response: completed,
        }),
      ],
      true,
    ),
  );
  const host = modelHost("openai_responses", fetch_);

  const response = await host.exchange(exchange("openai_responses"), {
    onDelta: (delta) => deltas.push(structuredClone(delta)),
  });

  expect(requestBody(fetch_)).toMatchObject({ stream: true, store: false });
  expect(deltas).toEqual([
    { kind: "reasoning", text: "Check" },
    { kind: "tool", text: '{"ref":"@scene"}' },
    { kind: "text", text: "The wind stops." },
  ]);
  expect(response).toMatchObject({
    text: "The wind stops.",
    toolCalls: [
      {
        id: "call-responses-stream-1",
        name: "context_read",
        arguments: { ref: "@scene" },
      },
    ],
    usage: { inputTokens: 210, outputTokens: 34, totalTokens: 244 },
    providerState: {
      protocol: "openai_responses",
      responseId: "response-stream-1",
      output,
    },
  });
});

test("Anthropic Messages 游玩请求用 SSE 保留 thinking 签名与完整 content blocks", async () => {
  const deltas: ModelHostDelta[] = [];
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    sseResponse(
      [
        namedData("message_start", {
          type: "message_start",
          message: {
            id: "message-anthropic-stream-1",
            role: "assistant",
            model: "claude-test",
            content: [],
            usage: { input_tokens: 310, output_tokens: 1 },
          },
        }),
        namedData("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        namedData("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Check first" },
        }),
        namedData("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "opaque-signature" },
        }),
        namedData("content_block_stop", {
          type: "content_block_stop",
          index: 0,
        }),
        namedData("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
        namedData("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "The light comes on." },
        }),
        namedData("content_block_stop", {
          type: "content_block_stop",
          index: 1,
        }),
        namedData("content_block_start", {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "tool-anthropic-stream-1",
            name: "context_read",
            input: {},
          },
        }),
        namedData("content_block_delta", {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"ref":' },
        }),
        namedData("content_block_delta", {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"@scene"}' },
        }),
        namedData("content_block_stop", {
          type: "content_block_stop",
          index: 2,
        }),
        namedData("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 41 },
        }),
        namedData("message_stop", { type: "message_stop" }),
      ],
      true,
    ),
  );
  const host = modelHost("anthropic_messages", fetch_);

  const response = await host.exchange(exchange("anthropic_messages"), {
    onDelta: (delta) => deltas.push(structuredClone(delta)),
  });

  expect(requestBody(fetch_)).toMatchObject({ stream: true });
  expect(deltas).toEqual([
    { kind: "reasoning", text: "Check first" },
    { kind: "text", text: "The light comes on." },
    { kind: "tool", text: '{"ref":' },
    { kind: "tool", text: '"@scene"}' },
  ]);
  expect(response).toMatchObject({
    text: "The light comes on.",
    reasoningContent: "Check first",
    toolCalls: [
      {
        id: "tool-anthropic-stream-1",
        name: "context_read",
        arguments: { ref: "@scene" },
      },
    ],
    usage: {
      inputTokens: null,
      uncachedInputTokens: 310,
      outputTokens: 41,
    },
    providerState: {
      protocol: "anthropic_messages",
      responseId: "message-anthropic-stream-1",
      model: "claude-test",
      stopReason: "tool_use",
      content: [
        {
          type: "thinking",
          thinking: "Check first",
          signature: "opaque-signature",
        },
        { type: "text", text: "The light comes on." },
        {
          type: "tool_use",
          id: "tool-anthropic-stream-1",
          name: "context_read",
          input: { ref: "@scene" },
        },
      ],
    },
  });
});

test.each([
  [
    "chat_completions",
    data({ choices: [{ delta: { content: "Incomplete" } }] }),
  ],
  [
    "openai_responses",
    namedData("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "Incomplete",
    }),
  ],
  [
    "anthropic_messages",
    namedData("message_start", {
      type: "message_start",
      message: {
        id: "truncated-anthropic",
        role: "assistant",
        model: "claude-test",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  ],
] as const)("%s 的 2xx SSE 中途结束归类为结果未知", async (provider, body) => {
  const host = modelHost(
    provider,
    vi.fn<typeof fetch>().mockResolvedValue(sseResponse([body])),
  );

  await expect(host.exchange(exchange(provider))).rejects.toBeInstanceOf(
    ModelHostOutcomeUnknownError,
  );
});

function modelHost(provider: ModelProviderKind, fetch_: typeof fetch) {
  return new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: provider === "anthropic_messages" ? "claude-test" : "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
  );
}

function exchange(provider: ModelProviderKind): ModelHostExchange {
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider,
      modelId: provider === "anthropic_messages" ? "claude-test" : "gpt-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "Check streaming play.",
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
    operationId: "stream-operation",
    requestAttempt: 1,
    exchange: 1,
    maxOutputTokens: 2_000,
  };
}

function sseResponse(frames: readonly string[], keepOpen = false): Response {
  const bytes = new TextEncoder().encode(frames.join(""));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (!keepOpen) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function namedData(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function requestBody(fetch_: ReturnType<typeof vi.fn<typeof fetch>>) {
  return JSON.parse(fetch_.mock.calls[0]?.[1]?.body as string) as Record<
    string,
    unknown
  >;
}
