import { expect, test } from "vitest";
import {
  FileNativeModelHost,
  type FileNativeModelConnection,
} from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  assistantPrefillDelta,
  assistantPrefillMode,
  completeAssistantPrefill,
  playAssistantPrefill,
  prefillFor,
} from "../../src/runtime/model/AssistantPrefill.ts";
import type {
  ModelHostDelta,
  ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import {
  aggregateAnthropicModelStream,
  aggregateChatModelStream,
  aggregateResponsesModelStream,
} from "../../src/runtime/model/ModelHostStream.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const exactPrefix = "  前缀🙂\r\n代码未完：\n ";

function requestFor(host: FileNativeModelHost): ModelHostExchange {
  const binding = host.binding();
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: binding.provider,
      modelId: binding.modelId,
      contextWindowTokens: binding.contextWindowTokens,
      maxOutputTokens: binding.maxOutputTokens,
      cacheStrategy: binding.cacheStrategy!,
      playerInput: "保留这份请求",
      playerInputPlacement: "append",
    }),
  );
  return host.freezeRequest({
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.tools.map(({ name }) => name),
    toolStrategy: bootstrap.toolStrategy,
    appended: [{ kind: "player", text: "保留这份请求" }],
    requestId: "request-original",
    exchange: 1,
    requestAttempt: 1,
    maxOutputTokens: binding.maxOutputTokens,
  });
}

function connection(
  provider: FileNativeModelConnection["provider"] = "chat_completions",
  assistantPrefillMode: FileNativeModelConnection["assistantPrefillMode"] = "prefix",
): FileNativeModelConnection {
  return {
    provider,
    assistantPrefillMode,
    baseUrl: "https://provider.invalid/beta",
    apiKey: "synthetic-key",
    modelId: provider === "anthropic_messages" ? "claude-sonnet-4-5" : "model",
    thinkingMode:
      provider === "anthropic_messages" ? "disabled" : "provider_default",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  };
}

const modes = [
  ["chat_completions", "assistant"],
  ["chat_completions", "prefix"],
  ["chat_completions", "partial"],
  ["chat_completions", "mistral_prefix"],
  ["openai_responses", "assistant"],
  ["openai_responses", "partial"],
  ["anthropic_messages", "assistant"],
] as const;

test.each(modes)(
  "%s %s 预览与派发只追加精确 assistant 前缀，结算和原生历史只保留一份全文",
  async (provider, mode) => {
    // Anthropic does not accept trailing whitespace; never silently trim it.
    const prefix =
      provider === "anthropic_messages" ? "  前缀🙂\r\n正文" : exactPrefix;
    const suffix = "续写成功";
    const returnedText = mode === "mistral_prefix" ? prefix + suffix : suffix;
    const payload =
      provider === "chat_completions"
        ? {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: returnedText,
                  opaque: { signature: "keep" },
                },
              },
            ],
          }
        : provider === "openai_responses"
          ? {
              id: "response",
              status: "completed",
              output: [
                {
                  id: "message",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: returnedText,
                      annotations: [],
                    },
                  ],
                  opaque: "keep",
                },
              ],
            }
          : {
              id: "response",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text: returnedText, opaque: "keep" }],
              usage: { input_tokens: 1, output_tokens: 2 },
            };
    let dispatched: unknown;
    const host = new FileNativeModelHost(
      connection(provider, mode),
      (_url, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request body");
        dispatched = JSON.parse(init.body);
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    );
    const original = requestFor(host);
    const originalCopy = structuredClone(original);
    const before = host.previewRequest(original).body as Record<
      string,
      unknown
    >;
    const continued = {
      ...original,
      assistantPrefill: prefillFor(original, prefix)!,
    };
    const preview = host.previewRequest(continued).body as Record<
      string,
      unknown
    >;
    const {
      [provider === "openai_responses" ? "input" : "messages"]: previous,
      ...beforeSettings
    } = before;
    const {
      [provider === "openai_responses" ? "input" : "messages"]: actual,
      ...afterSettings
    } = preview;
    expect(afterSettings).toEqual(beforeSettings);
    expect(Array.isArray(previous)).toBe(true);
    expect(actual).toEqual([
      ...(previous as unknown[]),
      {
        role: "assistant",
        content:
          provider === "anthropic_messages"
            ? [{ type: "text", text: prefix }]
            : prefix,
        ...(mode === "prefix" || mode === "mistral_prefix"
          ? { prefix: true }
          : {}),
        ...(mode === "partial" ? { partial: true } : {}),
      },
    ]);
    const completed = await host.exchange(continued);
    expect(dispatched).toEqual(preview);
    expect(original).toEqual(originalCopy);
    expect(completed.text).toBe(prefix + suffix);
    expect(JSON.stringify(completed.providerState)).toContain(
      JSON.stringify(prefix + suffix).slice(1, -1),
    );
    expect(JSON.stringify(completed.providerState)).toContain("keep");
    expect(JSON.stringify(completed.providerState)).not.toContain(
      JSON.stringify(prefix + prefix).slice(1, -1),
    );
  },
);

test("Mistral 的回显跨增量边界时只扣除一次前缀，后续同文仍保留", () => {
  const host = new FileNativeModelHost(
    connection("chat_completions", "mistral_prefix"),
  );
  const request = requestFor(host);
  request.assistantPrefill = prefillFor(request, exactPrefix)!;
  const deltas: ModelHostDelta[] = [];
  const sink = assistantPrefillDelta(request, (delta) => deltas.push(delta));
  sink({ kind: "text", text: exactPrefix.slice(0, 4) });
  sink({ kind: "text", text: exactPrefix.slice(4, -1) });
  sink({ kind: "text", text: exactPrefix.slice(-1) + "新增" });
  sink({ kind: "text", text: exactPrefix });
  expect(deltas.map(({ text }) => text).join("")).toBe("新增" + exactPrefix);
  const bad = assistantPrefillDelta(request, undefined);
  expect(() => bad({ kind: "text", text: "被改写的前缀" })).toThrow(/prefix/u);
});

test("服务未回显精确前缀时不能把 Mistral 响应当作成功", async () => {
  const host = new FileNativeModelHost(
    connection("chat_completions", "mistral_prefix"),
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "只返回后缀" },
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
  );
  const request = requestFor(host);
  request.assistantPrefill = prefillFor(request, exactPrefix)!;
  await expect(host.exchange(request)).rejects.toThrow(/prefix/u);
});

test("Anthropic 仅已知旧模型且显式关闭 Thinking 可继续，尾随空白不得裁剪", () => {
  const request = requestFor(
    new FileNativeModelHost(connection("anthropic_messages", "assistant")),
  );
  expect(prefillFor(request, "正文")).toEqual({
    mode: "assistant",
    text: "正文",
  });
  expect(prefillFor(request, "正文\n")).toBeNull();
  for (const modelId of [
    "claude-sonnet-4-6",
    "claude-opus-5",
    "claude-mythos-preview",
    "unknown",
  ])
    expect(assistantPrefillMode({ ...request.modelConfig!, modelId })).toBe(
      "disabled",
    );
  for (const thinkingMode of [
    "provider_default",
    "adaptive",
    "enabled",
  ] as const)
    expect(
      assistantPrefillMode({ ...request.modelConfig!, thinkingMode }),
    ).toBe("disabled");
});

test("普通协议兼容性不自动授权预填充，Google 及错误 Responses 扩展关闭", () => {
  const request = requestFor(new FileNativeModelHost(connection()));
  const config = request.modelConfig!;
  expect(assistantPrefillMode(undefined)).toBe("disabled");
  expect(
    assistantPrefillMode({ ...config, assistantPrefillMode: "disabled" }),
  ).toBe("disabled");
  expect(
    assistantPrefillMode({ ...config, provider: "google_interactions" }),
  ).toBe("disabled");
  expect(
    assistantPrefillMode({
      ...config,
      provider: "openai_responses",
      assistantPrefillMode: "prefix",
    }),
  ).toBe("disabled");
});

test("即使没有工具参数文本，已收到工具起始或推理也不能继续正文", () => {
  const request = requestFor(new FileNativeModelHost(connection()));
  const context = {
    status: "interrupted",
    lastRequest: request,
    lastRequestAttempt: 1,
    events: [
      {
        id: 1,
        kind: "assistant" as const,
        text: exactPrefix,
        status: "interrupted" as const,
        responseKind: "pending" as const,
        exchange: 1,
        attempt: 1,
      },
    ],
  };
  expect(playAssistantPrefill(context)).toEqual({
    text: exactPrefix,
    mode: "prefix",
  });
  expect(
    playAssistantPrefill({
      ...context,
      events: [{ ...context.events[0]!, toolFragment: "" }],
    }),
  ).toBeNull();
  expect(
    playAssistantPrefill({
      ...context,
      events: [{ ...context.events[0]!, reasoning: "" }],
    }),
  ).toBeNull();
  expect(
    playAssistantPrefill({
      ...context,
      events: [{ ...context.events[0]!, attempt: 2 }],
    }),
  ).toBeNull();
  expect(
    playAssistantPrefill({
      ...context,
      events: [{ ...context.events[0]!, text: "" }],
    }),
  ).toBeNull();
});

test("真实流式工具起始即使尚无参数也必须使正文续写失效", async () => {
  const body = new Response(
    [
      { choices: [{ delta: { content: exactPrefix } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read", arguments: "" },
                },
              ],
            },
          },
        ],
      },
    ]
      .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
      .join(""),
  ).body!;
  const deltas: ModelHostDelta[] = [];
  await expect(
    aggregateChatModelStream(body, (delta) => deltas.push(delta)),
  ).rejects.toThrow(/complete/u);
  expect(deltas).toEqual([
    { kind: "text", text: exactPrefix },
    { kind: "tool", text: "" },
  ]);
});

test("Anthropic 流中断保留起始块已有文字及后续增量", async () => {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "起始🙂\n" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "后续 " },
    },
  ];
  const body = new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
      )
      .join(""),
  ).body!;
  const deltas: ModelHostDelta[] = [];
  await expect(
    aggregateAnthropicModelStream(body, (delta) => deltas.push(delta)),
  ).rejects.toThrow();
  expect(deltas).toEqual([
    { kind: "text", text: "起始🙂\n" },
    { kind: "text", text: "后续 " },
  ]);
});

test.each([false, true])(
  "Responses 截断终态补齐正文且不重复已收增量：%s",
  async (hasDelta) => {
    const frames = [
      ...(hasDelta
        ? [
            {
              type: "response.output_text.delta",
              delta: exactPrefix.slice(0, 5),
            },
          ]
        : []),
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: exactPrefix }],
            },
          ],
        },
      },
    ];
    const body = new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    ).body!;
    const deltas: ModelHostDelta[] = [];
    await expect(
      aggregateResponsesModelStream(body, (delta) => deltas.push(delta)),
    ).rejects.toMatchObject({ details: { code: "model_output_limit" } });
    expect(deltas.every(({ kind }) => kind === "text")).toBe(true);
    expect(deltas.map(({ text }) => text).join("")).toBe(exactPrefix);
  },
);

test("Responses 截断终态暴露的工具起始也须禁止正文预填充", async () => {
  const frame = {
    type: "response.incomplete",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: exactPrefix }],
        },
        {
          type: "function_call",
          call_id: "tool",
          name: "read",
          arguments: "{",
        },
      ],
    },
  };
  const body = new Response(`data: ${JSON.stringify(frame)}\n\n`).body!;
  const deltas: ModelHostDelta[] = [];
  await expect(
    aggregateResponsesModelStream(body, (delta) => deltas.push(delta)),
  ).rejects.toMatchObject({ details: { code: "model_output_limit" } });
  expect(deltas).toContainEqual({ kind: "tool", text: "" });
});

test("Anthropic 前缀必须位于新工具块之前，不改写工具和不透明字段", () => {
  const request = requestFor(
    new FileNativeModelHost(connection("anthropic_messages", "assistant")),
  );
  request.assistantPrefill = prefillFor(request, "前缀")!;
  const content = [
    { type: "tool_use", id: "tool", name: "read", input: {}, opaque: "keep" },
    { type: "text", text: "后缀" },
  ];
  const combined = completeAssistantPrefill(request, {
    text: "后缀",
    providerState: { protocol: "anthropic_messages", content },
  });
  expect(combined.providerState).toMatchObject({
    content: [{ type: "text", text: "前缀" }, ...content],
  });
  expect(content[1]).toEqual({ type: "text", text: "后缀" });
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)("%s 非流式输出上限保留完整正文但不结算半响应", async (provider) => {
  const payload =
    provider === "chat_completions"
      ? {
          choices: [
            {
              finish_reason: "length",
              message: { role: "assistant", content: exactPrefix },
            },
          ],
        }
      : provider === "openai_responses"
        ? {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: exactPrefix, annotations: [] },
                ],
              },
            ],
          }
        : {
            type: "message",
            role: "assistant",
            stop_reason: "max_tokens",
            content: [{ type: "text", text: exactPrefix }],
          };
  const host = new FileNativeModelHost(connection(provider, "assistant"), () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const deltas: ModelHostDelta[] = [];
  await expect(
    host.exchange(requestFor(host), { onDelta: (delta) => deltas.push(delta) }),
  ).rejects.toMatchObject({ details: { code: "model_output_limit" } });
  expect(deltas).toEqual([{ kind: "text", text: exactPrefix }]);
});
