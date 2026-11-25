import { retargetRequestForRetry } from "../../src/runtime/model/AssistantPrefill.ts";
import { playerInputText } from "../../src/shared/turn-guide.ts";
import { projectRequestContext } from "../../src/runtime/play/PlayRequestContext.ts";
import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  isSafeGoogleWireRequest,
  withGoogleHop,
} from "../../src/runtime/model/GoogleRequestPreview.ts";
import {
  assertModelOutputComplete,
  equalModelHostBinding,
  ModelHostFailureError,
  ModelHostCancelledError,
  ModelHostOutcomeUnknownError,
  isModelHostTokenLimitFailure,
  ScriptedModelHost,
  type ModelHostBinding,
  type ModelHostExchange,
  type GoogleHopEvidence,
} from "../../src/runtime/model/ModelHost.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  renderPromptDeltaMessage,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const binding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "sha256:endpoint",
  modelId: "scripted-model",
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "sha256:protocol",
};

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)("%s 仅在同一来源重定向模型请求", async (provider) => {
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.redirect("https://provider.invalid/proxy", 307),
    )
    .mockResolvedValueOnce(
      Response.redirect("https://other.invalid/new-service", 307),
    );
  const host = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "synthetic-key",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    fetch_,
  );
  await expect(
    host.exchange(
      exchangeFor(provider, "manual-model", host.binding().cacheStrategy),
    ),
  ).rejects.toThrow("redirect");
  expect(fetch_).toHaveBeenCalledTimes(2);
  const [, first] = fetch_.mock.calls[0]!;
  expect(fetch_).toHaveBeenNthCalledWith(
    2,
    new URL("https://provider.invalid/proxy"),
    expect.objectContaining({
      body: first?.body,
      headers: first?.headers,
      method: "POST",
      redirect: "manual",
    }),
  );
});

test.each([
  {
    baseUrl: "https://api.openai.com/v1",
    modelId: "o3",
    dialect: "standard",
    outputLimitField: "max_completion_tokens",
  },
  {
    baseUrl: "https://api.openai.com/v1/chat/completions/",
    modelId: "o4-mini-2025-04-16",
    dialect: "standard",
    outputLimitField: "max_completion_tokens",
  },
  {
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o-mini",
    dialect: "standard",
    outputLimitField: "max_tokens",
  },
  {
    baseUrl: "https://api.openai.com.proxy.invalid/v1",
    modelId: "o3",
    dialect: "standard",
    outputLimitField: "max_tokens",
  },
  {
    baseUrl: "https://provider.invalid/v1",
    modelId: "o3",
    dialect: "cliproxyapi",
    outputLimitField: "max_tokens",
  },
] as const)(
  "Chat Completions 输出上限：$baseUrl $modelId ($dialect) 使用 $outputLimitField",
  async ({ baseUrl, modelId, dialect, outputLimitField }) => {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const maxOutputTokens = 2_048;
    const host = new FileNativeModelHost(
      {
        provider: "chat_completions",
        baseUrl,
        apiKey: "synthetic-key",
        modelId,
        dialect,
        contextWindowTokens: 64_000,
        maxOutputTokens,
      },
      fetch_,
    );
    const request = exchangeFor(
      "chat_completions",
      modelId,
      host.binding().cacheStrategy,
    );

    await host.exchange(request);

    expect(fetch_).toHaveBeenCalledTimes(1);
    const [url, init] = fetch_.mock.calls[0]!;
    if (!(url instanceof URL) || typeof init?.body !== "string")
      throw new Error("Expected a URL and a JSON request body");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toHaveProperty(outputLimitField, maxOutputTokens);
    expect(
      Object.keys(body).filter(
        (field) => field === "max_tokens" || field === "max_completion_tokens",
      ),
    ).toHaveLength(1);
    const preview = host.previewRequest(request);
    expect(preview).toMatchObject({
      endpointPath: url.pathname,
      method: init.method,
    });
    expect(preview.body).toEqual(body);
  },
);

test("Google 诊断接受根端点并遮蔽 URL 路径中的凭据", () => {
  const request = exchangeFor(
    "google_interactions",
    "manual-model",
    "provider_managed",
  );
  const makeHost = (baseUrl: string) =>
    new FileNativeModelHost({
      provider: "google_interactions",
      baseUrl,
      apiKey: "key-sentinel",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    });
  const root = makeHost("https://provider.invalid").previewRequest(request);
  expect(root.endpointPath).toBe("/interactions");
  expect(isSafeGoogleWireRequest(root)).toBe(true);
  const secretPath = makeHost(
    "https://provider.invalid/key-sentinel",
  ).previewRequest(request);
  expect(secretPath.endpointPath).toBe("");
  expect(isSafeGoogleWireRequest(secretPath)).toBe(true);
  const encoded = new FileNativeModelHost({
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/A%2fb",
    apiKey: "A/b",
    modelId: "manual-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).previewRequest(request);
  expect(encoded.endpointPath).toBe("");
  const suffixKey = new FileNativeModelHost({
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/v1beta",
    apiKey: "interactions",
    modelId: "manual-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  }).previewRequest(request);
  expect(suffixKey.endpointPath).toBe("");
  expect(isSafeGoogleWireRequest(suffixKey)).toBe(true);
});

test("Google 预览使用无状态 Interactions 与原序 System 前缀", () => {
  const host = new FileNativeModelHost({
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/v1beta",
    apiKey: "synthetic-secret",
    modelId: "manual-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });
  const request = exchangeFor(
    "google_interactions",
    "manual-model",
    "provider_managed",
  );
  request.bootstrap.provider.messages = [
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "question" },
  ];
  request.bootstrap.logicalMessages = [
    {
      role: "author_instruction",
      messageRole: "system",
      promptId: "p-first",
      markdown: "first",
      blocks: [{ source: "preset:first", markdown: "first" }],
    },
    {
      role: "author_instruction",
      messageRole: "system",
      promptId: "p-second",
      markdown: "second",
      blocks: [{ source: "preset:second", markdown: "second" }],
    },
    {
      role: "author_instruction",
      messageRole: "user",
      promptId: "p-user",
      markdown: "question",
      blocks: [{ source: "preset:user", markdown: "question" }],
    },
  ];
  const preview = host.previewRequest(request);
  expect(preview).toMatchObject({
    provider: "google_interactions",
    endpointPath: "/v1beta/interactions",
    headerNames: ["Accept", "x-goog-api-key", "Content-Type"],
    body: {
      model: "manual-model",
      store: false,
      stream: true,
      system_instruction: "first\n\nsecond",
    },
    systemInstructionSources: [
      { promptId: "p-first", sources: ["preset:first"] },
      { promptId: "p-second", sources: ["preset:second"] },
    ],
  });
  expect(JSON.stringify(preview)).not.toContain("synthetic-secret");
  request.bootstrap.provider.messages.push({ role: "system", content: "late" });
  request.bootstrap.logicalMessages.push({
    role: "author_instruction",
    messageRole: "system",
    promptId: "p-late",
    markdown: "late",
    blocks: [{ source: "preset:late", markdown: "late" }],
  });
  expect(() => host.previewRequest(request)).toThrow(
    /System.*4.*p-late.*preset:late/,
  );
  request.bootstrap.provider.messages.pop();
  request.bootstrap.logicalMessages.pop();
  request.appended.push({
    kind: "prompt_delta",
    logicalMessages: [
      {
        role: "runtime_system",
        markdown: "Untrusted instruction",
        blocks: [
          { source: "author:untrusted", markdown: "Untrusted instruction" },
        ],
      },
    ],
  });
  expect(() => host.previewRequest(request)).toThrow(/invalid appended role/iu);
});

test.each([
  { dialect: "standard", settings: {}, expected: {} },
  {
    dialect: "standard",
    settings: { reasoningEffort: "minimal", reasoningSummary: "auto" },
    expected: { thinking_level: "minimal", thinking_summaries: "auto" },
  },
  {
    dialect: "standard",
    settings: { thinkingMode: "enabled", thinkingBudgetTokens: 32 },
    expected: { thinking: { thinking_budget: 32 } },
  },
  {
    dialect: "standard",
    settings: { thinkingMode: "adaptive" },
    expected: { thinking: { thinking_budget: -1 } },
  },
  {
    dialect: "cliproxyapi",
    settings: { thinkingMode: "disabled", reasoningSummary: "none" },
    expected: { thinking_budget: 0, thinking_summaries: "none" },
  },
  {
    dialect: "cliproxyapi",
    settings: { thinkingMode: "enabled", thinkingBudgetTokens: 32 },
    expected: { thinking_budget: 32 },
  },
] as const)(
  "Google $dialect 将 $settings 一致用于预览、诊断和派发",
  async ({ dialect, settings, expected }) => {
    const dispatched: Headers[] = [];
    const bodies: unknown[] = [];
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        dialect,
        modelId: "unknown-model",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "credential",
        contextWindowTokens: 64000,
        maxOutputTokens: 2048,
        ...settings,
      },
      (_url, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Missing Google body");
        bodies.push(JSON.parse(init.body));
        dispatched.push(new Headers(init?.headers));
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: 400,
                message: "model rejected this configuration",
                status: "INVALID_ARGUMENT",
              },
            },
            { status: 400 },
          ),
        );
      },
    );
    expect(host.binding().cacheStrategy).toBe("provider_managed");
    const request = exchangeFor(
      "google_interactions",
      "unknown-model",
      "provider_managed",
    );
    request.operationId = "play";
    const preview = host.previewRequest(request);
    expect(isSafeGoogleWireRequest(preview)).toBe(true);
    const config = (
      preview.body as { generation_config: Record<string, unknown> }
    ).generation_config;
    const { max_output_tokens, ...thinking } = config;
    expect(max_output_tokens).toBe(2048);
    expect(thinking).toEqual(expected);
    await expect(host.exchange(request)).rejects.toThrow();
    expect(bodies[0]).toEqual(preview.body);
    expect(dispatched[0]?.get("x-goog-api-key")).toBe("credential");
    if (dialect === "cliproxyapi") {
      expect(preview.headerNames).toContain("X-Session-Id");
      const key = dispatched[0]?.get("X-Session-Id");
      expect(key).toMatch(/^[0-9a-f]{64}$/u);
      await expect(
        host.exchange({ ...request, operationId: "followup" }),
      ).rejects.toThrow();
      expect(dispatched[1]?.get("X-Session-Id")).not.toBe(key);
    } else {
      expect(dispatched[0]?.has("X-Session-Id")).toBe(false);
    }
  },
);
test("Google 无状态续接保留各跳正文和原生步骤", async () => {
  const bodies: Record<string, unknown>[] = [];
  const hops: GoogleHopEvidence[] = [];
  const hop = (text: string, status: string, token?: string) =>
    [
      { event_type: "interaction.created", interaction: { id: "synthetic" } },
      { event_type: "step.start", index: 0, step: { type: "model_output" } },
      { event_type: "step.delta", index: 0, delta: { type: "text", text } },
      { event_type: "step.stop", index: 0 },
      {
        event_type: "interaction.completed",
        interaction: {
          status,
          ...(token === undefined ? {} : { continuation_token: token }),
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Missing request body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          bodies.length === 1
            ? hop("first", "requires_continuation", "token-one")
            : hop(" second", "completed"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  const response = await host.exchange(
    exchangeFor("google_interactions", "manual-model", "provider_managed"),
    {
      onGoogleHop: (hop) => {
        hops.push(hop);
      },
    },
  );
  expect(response.text).toBe("first second");
  expect(response.providerState).toEqual({
    protocol: "google_interactions",
    steps: [
      { type: "model_output", content: [{ type: "text", text: "first" }] },
      { type: "model_output", content: [{ type: "text", text: " second" }] },
    ],
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual({ ...bodies[0], continuation_token: "token-one" });
  expect(hops).toMatchObject([
    { hop: 1, tokenSupplied: false, status: "attempted" },
    {
      hop: 1,
      tokenSupplied: false,
      status: "requires_continuation",
      httpStatus: 200,
    },
    { hop: 2, tokenSupplied: true, status: "attempted" },
    { hop: 2, tokenSupplied: true, status: "completed", httpStatus: 200 },
  ]);
  expect(JSON.stringify(hops)).not.toContain("token-one");
  expect(JSON.stringify(hops)).not.toContain("secret");
});

test("Google 后置请求取消后可保留迟到的完整单跳，但不发下一跳", async () => {
  for (const status of ["completed", "requires_continuation"]) {
    const abort = new AbortController();
    let resolveFetch!: (response: Response) => void;
    let count = 0;
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () => {
        count++;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    );
    const pending = host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
      { signal: abort.signal, retainLateExtensionResponse: true },
    );
    await vi.waitFor(() => expect(count).toBe(1));
    abort.abort();
    resolveFetch(
      new Response(
        [
          { event_type: "interaction.created" },
          {
            event_type: "interaction.completed",
            interaction: { status, continuation_token: "private" },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    if (status === "completed")
      await expect(pending).resolves.toMatchObject({ stopReason: "completed" });
    else await expect(pending).rejects.toBeInstanceOf(ModelHostCancelledError);
    expect(count).toBe(1);
  }
});

test("Google 续接 usage 对每跳最终值求和且保留缺失", async () => {
  let count = 0;
  const hops: GoogleHopEvidence[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      count++;
      const events = [
        { event_type: "interaction.created", interaction: { id: "synthetic" } },
        {
          event_type: "interaction.status_update",
          usage: { total_input_tokens: 1 },
        },
        {
          event_type: "interaction.completed",
          interaction:
            count === 1
              ? {
                  status: "requires_continuation",
                  continuation_token: "token",
                  usage: {
                    total_input_tokens: 7,
                    total_output_tokens: 2,
                    total_tool_use_tokens: 3,
                    unsafe_extension: "usage-secret",
                  },
                }
              : {
                  status: "completed",
                  usage: { total_input_tokens: 9, total_tokens: 12 },
                },
        },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  const response = await host.exchange(
    exchangeFor("google_interactions", "manual-model", "provider_managed"),
    {
      onGoogleHop: (hop) => {
        hops.push(hop);
      },
    },
  );
  expect(response.usage).toMatchObject({
    inputTokens: 16,
    outputTokens: null,
    totalTokens: null,
    providerRaw: {
      hops: [
        {
          total_input_tokens: 7,
          total_output_tokens: 2,
          total_tool_use_tokens: 3,
        },
        { total_input_tokens: 9, total_tokens: 12 },
      ],
    },
  });
  expect(
    hops.find((hop) => hop.hop === 1 && hop.status === "requires_continuation")
      ?.usage,
  ).toEqual({
    total_input_tokens: 7,
    total_output_tokens: 2,
    total_tool_use_tokens: 3,
  });
  expect(
    hops.find((hop) => hop.hop === 2 && hop.status === "completed")?.usage,
  ).toEqual({ total_input_tokens: 9, total_tokens: 12 });
  const recorded = hops.find(
    (hop) => hop.hop === 1 && hop.status === "requires_continuation",
  )!;
  expect(
    isSafeGoogleWireRequest(
      withGoogleHop(
        host.previewRequest(
          exchangeFor(
            "google_interactions",
            "manual-model",
            "provider_managed",
          ),
        ),
        recorded,
      ),
    ),
  ).toBe(true);
  expect(JSON.stringify(response.usage)).not.toContain("usage-secret");
});

test.each([-1, 2.5, "4"])(
  "Google 忽略无效 tool usage 数值 %s",
  async (value) => {
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ event_type: "interaction.completed", interaction: { status: "completed", usage: { total_tool_use_tokens: value } } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    );
    const result = await host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    );
    expect(result.usage?.providerRaw).toEqual({});
  },
);

test("Google 单跳保留安全 tool usage 并丢弃不安全的数值与扩展", async () => {
  const hops: GoogleHopEvidence[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ event_type: "interaction.completed", interaction: { status: "completed", usage: { total_tool_use_tokens: 4, total_tokens: 8, unsafe_extension: "usage-secret" } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  const response = await host.exchange(
    exchangeFor("google_interactions", "manual-model", "provider_managed"),
    {
      onGoogleHop: (hop) => {
        hops.push(hop);
      },
    },
  );
  expect(response.usage?.providerRaw).toEqual({
    total_tool_use_tokens: 4,
    total_tokens: 8,
  });
  expect(response.usage?.totalTokens).toBe(8);
  expect(hops.at(-1)?.usage).toEqual({
    total_tool_use_tokens: 4,
    total_tokens: 8,
  });
  expect(
    isSafeGoogleWireRequest(
      withGoogleHop(
        host.previewRequest(
          exchangeFor(
            "google_interactions",
            "manual-model",
            "provider_managed",
          ),
        ),
        hops.at(-1)!,
      ),
    ),
  ).toBe(true);
  expect(JSON.stringify({ response: response.usage, hops })).not.toContain(
    "usage-secret",
  );
});

test("Google 首跳上下文超限经完整适配器后要求新上下文且不回显秘密", async () => {
  const captured: unknown[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "key-sentinel",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message:
                "maximum context length exceeded; key-sentinel token-sentinel signature-sentinel",
            },
          }),
          { status: 400 },
        ),
      ),
    {
      recordFailure: (value) => {
        captured.push(value);
        return Promise.resolve();
      },
      recordExchangeIfActive: () => Promise.resolve(),
      resolve: () => Promise.resolve(),
    },
  );
  const error: unknown = await host
    .exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    )
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ModelHostFailureError);
  expect(isModelHostTokenLimitFailure(error)).toBe(true);
  expect(
    JSON.stringify({
      error: {
        message: (error as Error).message,
        details: (error as ModelHostFailureError).details,
      },
      captured,
    }),
  ).not.toMatch(/key-sentinel|token-sentinel|signature-sentinel/u);
});

test.each([
  {
    name: "ordinary rejection",
    status: 400,
    body: "invalid request",
    unknown: false,
  },
  {
    name: "context phrase only in echoed input",
    status: 400,
    body: JSON.stringify({
      error: {
        message: "Invalid argument",
        details: { echoed_input: "maximum context length" },
      },
    }),
    unknown: false,
  },
  {
    name: "context reason only in echoed details",
    status: 400,
    body: JSON.stringify({
      error: {
        message: "Invalid argument",
        details: [{ reason: "CONTEXT_LENGTH_EXCEEDED" }],
      },
    }),
    unknown: false,
  },
  { name: "empty body", status: 400, body: "", unknown: true },
  { name: "empty object", status: 400, body: "{}", unknown: true },
  { name: "null error body", status: 400, body: "null", unknown: true },
  { name: "array error body", status: 400, body: "[]", unknown: true },
  { name: "timeout", status: 408, body: "request timed out", unknown: true },
  {
    name: "in progress",
    status: 409,
    body: "request is still being processed",
    unknown: true,
  },
  {
    name: "connection closed",
    status: 499,
    body: "client closed request",
    unknown: true,
  },
  {
    name: "server failure",
    status: 503,
    body: "backend failure",
    unknown: true,
  },
  {
    name: "oversized error",
    status: 400,
    body: "x".repeat(65537),
    unknown: true,
  },
])(
  "Google 首跳 $name 保持拒绝与未知结果边界",
  async ({ status, body, unknown }) => {
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () => Promise.resolve(new Response(body, { status })),
    );
    const error: unknown = await host
      .exchange(
        exchangeFor("google_interactions", "manual-model", "provider_managed"),
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(
      unknown ? ModelHostOutcomeUnknownError : ModelHostFailureError,
    );
    expect(isModelHostTokenLimitFailure(error)).toBe(false);
  },
);

test.each(['"unterminated', "nullX"])(
  "Google 损坏的 JSON 拒绝体不授予重试：%s",
  async (body) => {
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () =>
        Promise.resolve(
          new Response(body, {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(
      host.exchange(
        exchangeFor("google_interactions", "manual-model", "provider_managed"),
      ),
    ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  },
);

test("Google 拒绝体包含无效 UTF-8 时不授予重试", async () => {
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          Buffer.concat([Buffer.from("invalid request"), Buffer.from([0xff])]),
          { status: 400 },
        ),
      ),
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
});

test.each([307, 308])(
  "Google 在首跳和续跳均拒绝 HTTP %s 跨源重定向",
  async (status) => {
    let leakedRequests = 0;
    const target = createServer((request, response) => {
      leakedRequests++;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\n\n',
      );
    });
    await new Promise<void>((resolve, reject) =>
      target.listen(0, "127.0.0.1", resolve).once("error", reject),
    );
    const targetPort = (target.address() as AddressInfo).port;
    let mode: "first" | "continuation" = "first";
    let sourceRequests = 0;
    const source = createServer((request, response) => {
      request.resume();
      sourceRequests++;
      if (mode === "continuation" && sourceRequests === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            { event_type: "interaction.created" },
            {
              event_type: "interaction.completed",
              interaction: {
                status: "requires_continuation",
                continuation_token: "loopback-token-sentinel",
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      } else {
        response.writeHead(status, {
          location: `http://127.0.0.1:${targetPort}/capture`,
        });
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) =>
      source.listen(0, "127.0.0.1", resolve).once("error", reject),
    );
    try {
      const sourcePort = (source.address() as AddressInfo).port;
      const host = new FileNativeModelHost({
        provider: "google_interactions",
        baseUrl: `http://127.0.0.1:${sourcePort}/v1beta`,
        apiKey: "loopback-key-sentinel",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      });
      await expect(
        host.exchange(
          exchangeFor(
            "google_interactions",
            "manual-model",
            "provider_managed",
          ),
        ),
      ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
      expect(sourceRequests).toBe(1);
      expect(leakedRequests).toBe(0);
      mode = "continuation";
      sourceRequests = 0;
      await expect(
        host.exchange(
          exchangeFor(
            "google_interactions",
            "manual-model",
            "provider_managed",
          ),
        ),
      ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
      expect(sourceRequests).toBe(2);
      expect(leakedRequests).toBe(0);
    } finally {
      source.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  },
);

test.each(["first", "continuation", "nonstream"] as const)(
  "Google %s 跳未知 HTTP 错误会非阻塞丢弃响应体",
  async (stage) => {
    let calls = 0;
    let cancelled = 0;
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () => {
        calls++;
        if (stage === "continuation" && calls === 1)
          return Promise.resolve(
            new Response(
              [
                { event_type: "interaction.created" },
                {
                  event_type: "interaction.completed",
                  interaction: {
                    status: "requires_continuation",
                    continuation_token: "token",
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled++;
                return new Promise<void>(() => {
                  /* intentionally hangs */
                });
              },
            }),
            {
              status:
                stage === "first" ? 503 : stage === "nonstream" ? 200 : 400,
            },
          ),
        );
      },
    );
    await expect(
      host.exchange(
        exchangeFor("google_interactions", "manual-model", "provider_managed"),
      ),
    ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
    expect(cancelled).toBe(1);
  },
);

test("Google 后续 HTTP 拒绝只记录脱敏逐跳证据", async () => {
  const captured: unknown[] = [];
  const hops: GoogleHopEvidence[] = [];
  let count = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://key-sentinel.example.invalid/v1beta",
      apiKey: "key-sentinel",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      count++;
      if (count === 2)
        return Promise.resolve(
          new Response(
            "error echo token-sentinel key-sentinel signature-sentinel",
            { status: 400 },
          ),
        );
      return Promise.resolve(
        new Response(
          [
            { event_type: "interaction.created" },
            {
              event_type: "interaction.completed",
              interaction: {
                status: "requires_continuation",
                continuation_token: "token-sentinel",
                usage: {
                  total_input_tokens: 4,
                  extension: "signature-sentinel",
                },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
    {
      recordFailure: (value) => {
        captured.push(value);
        return Promise.resolve();
      },
      recordExchangeIfActive: () => Promise.resolve(),
      resolve: () => Promise.resolve(),
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
      {
        onGoogleHop: (hop) => {
          hops.push(hop);
        },
      },
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(hops.at(-1)).toMatchObject({
    hop: 2,
    tokenSupplied: true,
    status: "rejected",
    httpStatus: 400,
  });
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({
    exchange: {
      googleHops: [
        { usage: { total_input_tokens: 4 } },
        { status: "rejected", httpStatus: 400 },
      ],
    },
  });
  const diagnostics = JSON.stringify({ hops, captured });
  for (const sentinel of [
    "key-sentinel",
    "token-sentinel",
    "signature-sentinel",
    "error echo",
  ])
    expect(diagnostics).not.toContain(sentinel);
});

test("Google 诊断观察器挂起不会阻断模型响应或续接", async () => {
  let calls = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      calls++;
      const events = [
        { event_type: "interaction.created" },
        {
          event_type: "interaction.completed",
          interaction:
            calls === 1
              ? { status: "requires_continuation", continuation_token: "next" }
              : { status: "completed" },
        },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  const result = await host.exchange(
    exchangeFor("google_interactions", "manual-model", "provider_managed"),
    {
      onGoogleHop: () =>
        new Promise<void>(() => {
          /* intentionally hangs */
        }),
    },
  );
  expect(result.stopReason).toBe("completed");
  expect(calls).toBe(2);
});

test("Google 非法 UTF-8 不能伪装成完整原生签名并触发续接", async () => {
  let calls = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      calls++;
      const before =
        'data: {"event_type":"interaction.created"}\n\ndata: {"event_type":"step.start","index":0,"step":{"type":"thought","summary":[],"signature":"';
      const after =
        '"}}\n\ndata: {"event_type":"step.stop","index":0}\n\ndata: {"event_type":"interaction.completed","interaction":{"status":"requires_continuation","continuation_token":"token"}}\n\n';
      return Promise.resolve(
        new Response(
          Buffer.concat([
            Buffer.from(before),
            Buffer.from([0xff]),
            Buffer.from(after),
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(calls).toBe(1);
});

test("Google 重复旧续接 token 时停止，不能返回部分结果", async () => {
  let count = 0;
  const tokens = ["one", "two", "one"];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      const token = tokens[count++];
      return Promise.resolve(
        new Response(
          [
            {
              event_type: "interaction.created",
              interaction: { id: "synthetic" },
            },
            {
              event_type: "interaction.completed",
              interaction: {
                status: "requires_continuation",
                continuation_token: token,
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(count).toBe(3);
});

test("Google 续接首跳缺 created 时不发下一跳", async () => {
  let count = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      count++;
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ event_type: "interaction.completed", interaction: { status: "requires_continuation", continuation_token: "token" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(count).toBe(1);
});

test("Google 最终续接跳缺 created 时不结算", async () => {
  let count = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      count++;
      const events =
        count === 1
          ? [
              { event_type: "interaction.created" },
              {
                event_type: "interaction.completed",
                interaction: {
                  status: "requires_continuation",
                  continuation_token: "token",
                },
              },
            ]
          : [
              {
                event_type: "interaction.completed",
                interaction: { status: "completed" },
              },
            ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(count).toBe(2);
});

test("Google 总时限终止挂起的 fetch", async () => {
  vi.useFakeTimers();
  try {
    const failures: unknown[] = [];
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () =>
        new Promise<Response>(() => {
          /* intentionally hangs */
        }),
      {
        recordFailure: (failure) => {
          failures.push(failure);
          return Promise.resolve();
        },
        recordExchangeIfActive: () => Promise.resolve(),
        resolve: () => Promise.resolve(),
      },
    );
    const result = host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      ModelHostOutcomeUnknownError,
    );
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await assertion;
    expect(failures).toMatchObject([
      {
        exchange: { googleHops: [{ hop: 1, status: "interrupted" }] },
        failures: [{ kind: "provider_transport" }],
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("Google 总时限终止挂起的流读取", async () => {
  vi.useFakeTimers();
  try {
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                /* intentionally hangs */
              },
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        ),
    );
    const result = host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      ModelHostOutcomeUnknownError,
    );
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

test("Google 后续 hop 明确拒绝也不能重放原始请求", async () => {
  let count = 0;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () => {
      count++;
      if (count > 1)
        return Promise.resolve(new Response("denied", { status: 400 }));
      const events = [
        { event_type: "interaction.created", interaction: { id: "one" } },
        {
          event_type: "interaction.completed",
          interaction: {
            status: "requires_continuation",
            continuation_token: "opaque",
          },
        },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(count).toBe(2);
});

test("Google 流完整聚合工具参数与签名并在下次请求重放原生 steps", async () => {
  const events = [
    {
      event_type: "step.start",
      index: 0,
      step: {
        type: "thought",
        signature: "",
        summary: [{ type: "text", text: "initial" }],
        extension: "opaque",
      },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "thought_signature", signature: "synthetic-signature" },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "step.start",
      index: 1,
      step: {
        type: "function_call",
        id: "c1",
        name: "read_document",
        arguments: {},
        extra: "opaque",
      },
    },
    {
      event_type: "step.delta",
      index: 1,
      delta: { type: "arguments_delta", arguments: '{"ref":' },
    },
    {
      event_type: "step.delta",
      index: 1,
      delta: { type: "arguments_delta", arguments: '"@scene"}' },
    },
    { event_type: "step.stop", index: 1 },
    {
      event_type: "interaction.completed",
      interaction: {
        status: "requires_action",
        usage: { total_input_tokens: 7, total_tokens: 12 },
      },
    },
  ];
  const bodies: unknown[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    (_url, init) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret");
      if (typeof init?.body !== "string")
        throw new Error("Missing request body");
      bodies.push(JSON.parse(init.body) as unknown);
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  const request = exchangeFor(
    "google_interactions",
    "manual-model",
    "provider_managed",
  );
  const response = await host.exchange(request);
  expect(response.toolCalls).toEqual([
    { id: "c1", name: "read_document", arguments: { ref: "@scene" } },
  ]);
  expect(response.providerState).toEqual({
    protocol: "google_interactions",
    steps: [
      {
        type: "thought",
        signature: "synthetic-signature",
        summary: [{ type: "text", text: "initial" }],
        extension: "opaque",
      },
      {
        type: "function_call",
        id: "c1",
        name: "read_document",
        arguments: { ref: "@scene" },
        extra: "opaque",
      },
    ],
  });
  expect(response.usage).toMatchObject({
    inputTokens: 7,
    totalTokens: 12,
    outputTokens: null,
    providerRaw: { total_input_tokens: 7, total_tokens: 12 },
  });
  request.appended.push(
    {
      kind: "assistant",
      text: "",
      toolCalls: response.toolCalls!,
      providerState: response.providerState!,
    },
    { kind: "tool", toolCallId: "c1", markdown: "result" },
  );
  await host.exchange(request);
  expect(bodies[1]).toMatchObject({
    input: expect.arrayContaining([
      {
        type: "thought",
        signature: "synthetic-signature",
        summary: [{ type: "text", text: "initial" }],
        extension: "opaque",
      },
      {
        type: "function_result",
        name: "read_document",
        call_id: "c1",
        result: [{ type: "text", text: "result" }],
      },
    ]) as unknown,
  });
});

test.each([
  [
    {
      event_type: "step.start",
      index: 0,
      step: {
        type: "function_call",
        id: "c",
        name: "read",
        arguments: "unreconciled",
      },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: "{}" },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "requires_action" },
    },
  ],
  [
    {
      event_type: "step.start",
      index: 0,
      step: { type: "function_call", id: "c", name: "read", arguments: {} },
    },
    {
      event_type: "interaction.completed",
      interaction: { status: "requires_action" },
    },
  ],
  [
    {
      event_type: "step.start",
      index: 0,
      step: { type: "function_call", id: "c", name: "read", arguments: {} },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: '{"x":' },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "requires_action" },
    },
  ],
  [
    { event_type: "step.start", index: 0, step: { type: "thought" } },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "unknown_extension", data: "do not drop" },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "completed" },
    },
  ],
  [
    {
      event_type: "step.start",
      index: 0,
      step: { type: "function_call", id: "c", name: "read", arguments: {} },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: '{"x":9007199254740993}' },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "requires_action" },
    },
  ],
])("Google 不结算不完整或无法无损回放的流 %#", async (...events) => {
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
});

test("Google 空终态有效，但空 steps 不能回放为 assistant 历史", async () => {
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "synthetic-secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          'data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  const request = exchangeFor(
    "google_interactions",
    "manual-model",
    "provider_managed",
  );
  const response = await host.exchange(request);
  expect(response).toMatchObject({
    stopReason: "completed",
    toolCalls: [],
    providerState: { protocol: "google_interactions", steps: [] },
  });
  request.appended.push({
    kind: "assistant",
    text: "already committed",
    toolCalls: [],
    providerState: { protocol: "google_interactions", steps: [] },
  });
  expect(() => host.previewRequest(request)).toThrow(/continuation/i);
});

test("Google 派发前拒绝损坏的原生续传", () => {
  const host = new FileNativeModelHost({
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/v1beta",
    apiKey: "secret",
    modelId: "manual-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  });
  const request = exchangeFor(
    "google_interactions",
    "manual-model",
    "provider_managed",
  );
  request.appended.push({
    kind: "assistant",
    text: "",
    toolCalls: [],
    providerState: {
      protocol: "google_interactions",
      steps: [
        { type: "function_call", id: "x", name: "read", arguments: "broken" },
      ],
    },
  });
  expect(() => host.previewRequest(request)).toThrow(/continuation/i);
});

test("Google 流中取消即使紧接终态也不返回可结算结果", async () => {
  const controller = new AbortController();
  const events = [
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "partial" },
    },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "completed" },
    },
  ];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    },
    () =>
      Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
      { signal: controller.signal, onDelta: () => controller.abort() },
    ),
  ).rejects.toBeInstanceOf(ModelHostCancelledError);
});

test.each(["requires_continuation", "incomplete", "failed", "cancelled"])(
  "Google 终态 %s 不结算工具",
  async (status) => {
    const events = [
      {
        event_type: "step.start",
        index: 0,
        step: {
          type: "function_call",
          id: "c",
          name: "read_document",
          arguments: {},
        },
      },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { status } },
    ];
    const host = new FileNativeModelHost(
      {
        provider: "google_interactions",
        baseUrl: "https://provider.invalid/v1beta",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 2_048,
      },
      () =>
        Promise.resolve(
          new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    );
    await expect(
      host.exchange(
        exchangeFor("google_interactions", "manual-model", "provider_managed"),
      ),
    ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  },
);

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
    if (dialect === "cliproxyapi" && provider === "openai_responses") {
      expect(preview.body).toHaveProperty(
        "prompt_cache_key",
        expect.any(String),
      );
      expect(JSON.stringify(preview.body)).not.toContain("cache_control");
    }
    if (dialect === "cliproxyapi" && provider === "chat_completions") {
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
  const names = tools.map((tool) =>
    provider === "chat_completions"
      ? (tool.function as { name?: unknown } | undefined)?.name
      : tool.name,
  );
  expect(names).toContain("state_list");
  expect(names).toContain("history_list");
  expect(names).not.toContain("context_list");
  for (const tool of tools) {
    if (provider === "openai_responses") expect(tool.strict).toBe(false);
    const schema =
      provider === "chat_completions"
        ? (tool.function as { parameters?: unknown } | undefined)?.parameters
        : provider === "openai_responses"
          ? tool.parameters
          : tool.input_schema;
    expect(schema).toMatchObject({ type: "object" });
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("allOf");
    expect(schema).not.toHaveProperty("anyOf");
  }
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
  request.toolUniverse = [
    {
      name: "context_list",
      description: "Legacy frozen list tool.",
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
    },
    ...(request.toolUniverse ?? request.tools).filter(
      ({ name }) => name !== "state_list" && name !== "history_list",
    ),
  ];

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

test("Provider 上下文溢出只由明确错误证据分类", () => {
  expect(
    isModelHostTokenLimitFailure(
      new ModelHostFailureError("Provider request failed: 400", {
        details: { error: { code: "context_length_exceeded" } },
      }),
    ),
  ).toBe(true);
  expect(
    isModelHostTokenLimitFailure(
      new ModelHostFailureError(
        "This model's maximum context length has been reached.",
      ),
    ),
  ).toBe(true);
  expect(
    isModelHostTokenLimitFailure(
      new ModelHostFailureError("Provider 在生成前拒绝了请求。"),
    ),
  ).toBe(false);
  expect(
    isModelHostTokenLimitFailure(
      new ModelHostOutcomeUnknownError("maximum context length"),
    ),
  ).toBe(false);
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

test.each([
  {
    provider: "chat_completions" as const,
    payload: {
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            content: "partial",
            tool_calls: [
              {
                id: "call",
                type: "function",
                function: { name: "state_read", arguments: '{"ref":' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    provider: "openai_responses" as const,
    payload: {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          call_id: "call",
          name: "state_read",
          arguments: '{"ref":',
        },
      ],
    },
  },
  {
    provider: "anthropic_messages" as const,
    payload: {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
    },
  },
])(
  "$provider reports output exhaustion before parsing partial output",
  async ({ provider, payload }) => {
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "test",
        modelId: "model",
        contextWindowTokens: 64000,
        maxOutputTokens: 2048,
      },
      () =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(
      host.exchange(
        exchangeFor(provider, "model", host.binding().cacheStrategy),
      ),
    ).rejects.toMatchObject({
      kind: "failed",
      message:
        "The model response reached the output token limit before completion. The request can be resent with a larger output budget.",
    });
  },
);

test.each([
  {
    provider: "chat_completions" as const,
    events: [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call",
                  type: "function",
                  function: { name: "state_read", arguments: '{"ref":' },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
      },
      "[DONE]",
    ],
  },
  {
    provider: "openai_responses" as const,
    events: [
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "function_call",
              call_id: "call",
              name: "state_read",
              arguments: '{"ref":',
            },
          ],
        },
      },
    ],
  },
  {
    provider: "anthropic_messages" as const,
    events: [
      {
        type: "message_start",
        message: { id: "message", role: "assistant", content: [] },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call",
          name: "state_read",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"ref":' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      { type: "message_stop" },
    ],
  },
])(
  "$provider streaming truncation preserves an actionable error with partial tool JSON",
  async ({ provider, events }) => {
    const body = events
      .map(
        (event) =>
          `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
      )
      .join("");
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "test",
        modelId: "model",
        contextWindowTokens: 64000,
        maxOutputTokens: 2048,
      },
      () =>
        Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    await expect(
      host.exchange(
        exchangeFor(provider, "model", host.binding().cacheStrategy),
      ),
    ).rejects.toMatchObject({
      kind: "failed",
      message:
        "The model response reached the output token limit before completion. The request can be resent with a larger output budget.",
      details: { code: "model_output_limit" },
    });
  },
);

test("output limit requires a fresh context while other stop reasons stay unchanged", () => {
  for (const reason of [
    "length",
    "max_tokens",
    "max_output_tokens",
    "incomplete:max_output_tokens",
  ]) {
    try {
      assertModelOutputComplete(reason);
      throw new Error("expected limit failure");
    } catch (error) {
      expect(isModelHostTokenLimitFailure(error)).toBe(true);
    }
  }
  for (const reason of [
    undefined,
    "stop",
    "tool_calls",
    "end_turn",
    "tool_use",
    "completed",
    "incomplete:content_filter",
  ])
    expect(() => assertModelOutputComplete(reason)).not.toThrow();
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
  "google_interactions",
] as const)(
  "请求快照保持 %s 的模型与推理参数，正常新请求使用新配置",
  (provider) => {
    const connection = {
      provider,
      baseUrl: "https://old.invalid/v1",
      apiKey: "old-secret",
      modelId: "original-model",
      reasoningEffort: "high" as const,
      contextWindowTokens: 64000,
      maxOutputTokens: 2048,
    };
    const original = new FileNativeModelHost(connection);
    const changed = new FileNativeModelHost({
      ...connection,
      baseUrl: "https://new.invalid/v1",
      apiKey: "new-secret",
      modelId: "new-model",
      reasoningEffort: "low",
      maxOutputTokens: 1024,
    });
    const request = exchangeFor(
      provider,
      connection.modelId,
      original.binding().cacheStrategy,
    );
    const saved = JSON.parse(
      JSON.stringify(original.freezeRequest(request)),
    ) as ModelHostExchange;
    expect(JSON.stringify(saved)).not.toContain("old-secret");
    expect(JSON.stringify(saved)).not.toContain("https://old.invalid");
    expect(changed.previewRequest(changed.freezeRequest(saved))).toEqual(
      original.previewRequest(saved),
    );
    const next = changed.freezeRequest({ ...request, maxOutputTokens: 1024 });
    expect(changed.previewRequest(next).body).toMatchObject({
      model: "new-model",
    });
    expect(next.modelConfig?.reasoningEffort).toBe("low");
    expect(saved.modelConfig?.reasoningEffort).toBe("high");
  },
);

const turnGuideSuffix = {
  kind: "runtime_notice" as const,
  notice: "turn_guide" as const,
  text: "[Runtime 本轮提示]\n- Keep the narration in second person.",
};

/** Two transcript items followed by the request-level turn guide, as a play dispatch appends them. */
function transcriptWithTurnGuide(
  provider: ModelHostBinding["provider"],
  modelId: string,
  cacheStrategy: ModelHostBinding["cacheStrategy"],
): ModelHostExchange {
  return {
    ...exchangeFor(provider, modelId, cacheStrategy),
    appended: [
      { kind: "player", text: "First" },
      { kind: "user", text: "Second" },
      turnGuideSuffix,
    ],
  };
}

function anthropicWireHost(cacheSuffixBreakpoint?: boolean) {
  return new FileNativeModelHost({
    provider: "anthropic_messages",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "must-not-appear",
    modelId: "claude-tail",
    reasoningEffort: "provider_default",
    reasoningSummary: "provider_default",
    thinkingMode: "disabled",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
    ...(cacheSuffixBreakpoint === undefined ? {} : { cacheSuffixBreakpoint }),
  });
}

test("Anthropic 把对话尾部断点放在请求级后缀之前的最后一个 transcript 块上", () => {
  const host = anthropicWireHost();
  const exchange = transcriptWithTurnGuide(
    "anthropic_messages",
    "claude-tail",
    host.binding().cacheStrategy,
  );
  const on = host.previewRequest(exchange).body as {
    system: unknown;
    messages: unknown[];
  };
  const off = anthropicWireHost(false).previewRequest(exchange).body as {
    system: unknown;
    messages: unknown[];
  };

  // The suffix stays unmarked; the marker lands on the last transcript block.
  expect(on.messages.at(-1)).toEqual({
    role: "user",
    content: turnGuideSuffix.text,
  });
  expect(on.messages.at(-2)).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Second", cache_control: { type: "ephemeral" } },
    ],
  });
  // Existing breakpoints and everything before the transcript tail are unchanged.
  expect(on.system).toEqual(off.system);
  expect(on.messages.slice(0, -2)).toEqual(off.messages.slice(0, -2));
  expect(off.messages.at(-2)).toEqual({ role: "user", content: "Second" });
});

test("Anthropic 对话尾部断点跳过 thinking 块，落在可携带 cache_control 的最后块上", () => {
  const host = anthropicWireHost();
  const exchange = transcriptWithTurnGuide(
    "anthropic_messages",
    "claude-tail",
    host.binding().cacheStrategy,
  );
  exchange.appended = [
    { kind: "player", text: "First" },
    {
      kind: "assistant",
      text: "Looks up.",
      toolCalls: [],
      providerState: {
        protocol: "anthropic_messages",
        content: [
          { type: "thinking", thinking: "Check", signature: "sig" },
          { type: "text", text: "Looks up." },
        ],
      } as never,
    },
    turnGuideSuffix,
  ];
  const messages = host.previewRequest(exchange).body as {
    messages: { content: unknown }[];
  };
  expect(messages.messages.at(-2)).toEqual({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Check", signature: "sig" },
      {
        type: "text",
        text: "Looks up.",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
});

test.each([
  { provider: "chat_completions" as const, title: "Chat Completions" },
  { provider: "openai_responses" as const, title: "OpenAI Responses" },
])(
  "CLIProxyAPI $title 方言把尾部断点写在请求级后缀之前的最后一条 transcript 消息上",
  ({ provider }) => {
    const host = new FileNativeModelHost({
      provider,
      dialect: "cliproxyapi",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "must-not-appear",
      ...(provider === "openai_responses"
        ? { responsesCacheControl: true }
        : {}),
      modelId: "cliproxy-tail",
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "provider_default",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    });
    const exchange = transcriptWithTurnGuide(
      provider,
      "cliproxy-tail",
      host.binding().cacheStrategy,
    );
    const body = host.previewRequest(exchange).body as Record<string, unknown>;
    const items = (body.messages ?? body.input) as Record<string, unknown>[];
    expect(items.at(-1)).not.toHaveProperty("cache_control");
    expect(items.at(-1)).toMatchObject({ content: turnGuideSuffix.text });
    expect(items.at(-2)).toMatchObject({
      role: "user",
      content: "Second",
      cache_control: { type: "ephemeral" },
    });
    expect(items.at(-3)).not.toHaveProperty("cache_control");
  },
);

test.each([
  { provider: "chat_completions" as const, dialect: "standard" as const },
  { provider: "openai_responses" as const, dialect: "standard" as const },
  { provider: "google_interactions" as const, dialect: "standard" as const },
])(
  "$provider 标准方言的编码不因请求级后缀增加 cache_control",
  ({ provider, dialect }) => {
    const host = new FileNativeModelHost({
      provider,
      dialect,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "must-not-appear",
      modelId: "standard-tail",
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "provider_default",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    });
    const request = host.freezeRequest(
      transcriptWithTurnGuide(
        provider,
        "standard-tail",
        host.binding().cacheStrategy,
      ),
    );
    expect(request.modelConfig).not.toHaveProperty("anthropicPromptCacheTtl");
    const body = host.previewRequest(request).body;
    expect(JSON.stringify(body)).not.toMatch(
      /"cache_control"|"anthropicPromptCacheTtl"|"ttl"/u,
    );
  },
);

test("没有请求级后缀时所有显式断点协议的编码与改动前逐字节一致", () => {
  const exchanges: [
    ModelHostExchange,
    () => FileNativeModelHost,
    () => FileNativeModelHost,
  ][] = [];
  const cases = [
    { provider: "anthropic_messages" as const, dialect: "standard" as const },
    { provider: "chat_completions" as const, dialect: "cliproxyapi" as const },
    { provider: "openai_responses" as const, dialect: "cliproxyapi" as const },
  ];
  for (const { provider, dialect } of cases) {
    const config = {
      provider,
      dialect,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "must-not-appear",
      modelId: "no-suffix",
      reasoningEffort: "provider_default" as const,
      reasoningSummary: "provider_default" as const,
      thinkingMode: "provider_default" as const,
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    };
    const host = new FileNativeModelHost(config);
    const exchange: ModelHostExchange = {
      ...exchangeFor(provider, "no-suffix", host.binding().cacheStrategy),
      appended: [
        { kind: "player", text: "First" },
        { kind: "user", text: "Second" },
      ],
    };
    exchanges.push([
      exchange,
      () => new FileNativeModelHost(config),
      () =>
        new FileNativeModelHost({ ...config, cacheSuffixBreakpoint: false }),
    ]);
  }
  for (const [exchange, current, previous] of exchanges)
    expect(JSON.stringify(current().previewRequest(exchange))).toBe(
      JSON.stringify(previous().previewRequest(exchange)),
    );
});

test("冻结请求保留编码时的断点选择：旧冻结请求原样重发，新派发才加尾部断点", () => {
  const host = anthropicWireHost();
  const exchange = transcriptWithTurnGuide(
    "anthropic_messages",
    "claude-tail",
    host.binding().cacheStrategy,
  );
  const frozen = host.freezeRequest(exchange);
  expect(frozen.modelConfig).toMatchObject({ cacheSuffixBreakpoint: true });

  // A request frozen before the breakpoint existed records no choice at all.
  const predatesConfig = { ...frozen.modelConfig! };
  delete predatesConfig.cacheSuffixBreakpoint;
  const predates = { ...frozen, modelConfig: predatesConfig };
  const previousEncoding = anthropicWireHost(false).previewRequest(exchange);
  expect(JSON.stringify(host.previewRequest(predates))).toBe(
    JSON.stringify(previousEncoding),
  );
  expect(JSON.stringify(host.previewRequest(frozen))).not.toBe(
    JSON.stringify(previousEncoding),
  );
});

test("对话尾部断点超过 Anthropic 上限时明确报错而不是丢弃", () => {
  const host = anthropicWireHost();
  const exchange = transcriptWithTurnGuide(
    "anthropic_messages",
    "claude-tail",
    host.binding().cacheStrategy,
  );
  exchange.bootstrap.provider.system = Array.from(
    { length: 4 },
    (_, index) => ({
      type: "text" as const,
      text: `Stable block ${index}`,
      cache_control: { type: "ephemeral" as const },
    }),
  );
  expect(() => host.previewRequest(exchange)).toThrow(
    /cache breakpoints; the Anthropic limit is 4/,
  );
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
  "google_interactions",
] as const)(
  "%s: new player inputs have localized boundaries and frozen legacy inputs retain their bytes",
  (provider) => {
    const host = new FileNativeModelHost({
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "boundary-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2048,
    });
    const request = exchangeFor(
      provider,
      "boundary-model",
      host.binding().cacheStrategy,
    );
    const original = "  I ask Alex.\n你好！\n";
    request.appended = [{ kind: "player", text: original }];
    const legacy = host.freezeRequest(request);
    const legacyWire = host.previewRequest(legacy);
    for (const locale of ["en", "zh-CN"] as const) {
      const input = {
        kind: "player" as const,
        text: original,
        inputBoundary: locale,
      };
      const marked = host.freezeRequest({ ...request, appended: [input] });
      const expected = playerInputText(locale, original);
      const wire = JSON.stringify(host.previewRequest(marked).body);
      expect(wire).toContain(JSON.stringify(expected).slice(1, -1));
      expect(
        projectRequestContext(marked.bootstrap, marked.appended),
      ).toContainEqual({ role: "user", text: expected });
      expect(marked.appended[0]).toEqual(input);
      const restored = JSON.parse(JSON.stringify(marked)) as ModelHostExchange;
      expect(host.previewRequest(restored)).toEqual(
        host.previewRequest(marked),
      );
    }
    expect(
      host.previewRequest(
        JSON.parse(JSON.stringify(legacy)) as ModelHostExchange,
      ),
    ).toEqual(legacyWire);
    expect(JSON.stringify(legacyWire.body)).not.toContain(
      "<current_player_input>",
    );
    expect(JSON.stringify(legacyWire.body)).not.toContain("<本轮玩家输入>");
  },
);

test.each(["standard", "cliproxyapi"] as const)(
  "%s Responses projects a request-local guide without changing conversation history",
  async (dialect) => {
    const connection = {
      provider: "openai_responses" as const,
      dialect,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "aliased-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    };
    const fixed = "本轮固定指导\n使用第二人称。";
    const player = "玩家本轮要求：不要跳过开门。";
    const guide = (fixed: string, player: string) => ({
      ...turnGuideSuffix,
      text: [fixed, player].filter(Boolean).join("\n"),
      responsesInstructions: { fixed, player },
    });
    const output = [
      { type: "reasoning", id: "r", encrypted_content: "opaque" },
      { type: "function_call", call_id: "load", name: "read", arguments: "{}" },
    ];
    for (const active of [false, true]) {
      let sent: unknown;
      const host = new FileNativeModelHost(
        { ...connection, responsesTurnInstructions: active },
        (_url, init) => {
          if (typeof init?.body !== "string")
            throw new Error("Expected a JSON request body");
          sent = JSON.parse(init.body) as unknown;
          return Promise.resolve(
            Response.json({
              id: "r",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "ok" }],
                },
              ],
            }),
          );
        },
      );
      const request = exchangeFor(
        connection.provider,
        connection.modelId,
        host.binding().cacheStrategy,
      );
      request.operationId = "play";
      request.appended.push(
        {
          kind: "assistant",
          text: "",
          toolCalls: [],
          providerState: { protocol: "openai_responses", output },
        },
        { kind: "tool", toolCallId: "load", markdown: "material" },
      );
      const prefix = (host.previewRequest(request).body as { input: unknown[] })
        .input;
      expect(prefix[0]).toMatchObject({ role: "developer" });
      expect(prefix.slice(-3)).toEqual([
        ...output,
        { type: "function_call_output", call_id: "load", output: "material" },
      ]);
      for (const [rule, note] of [
        [fixed, player],
        [fixed, "玩家本轮要求：换一条。"],
        [fixed, ""],
        ["", player],
        ["", ""],
      ] as const) {
        const current = guide(rule, note);
        const frozen = host.freezeRequest({
          ...request,
          appended: [...request.appended, ...(current.text ? [current] : [])],
        });
        const wire = host.previewRequest(frozen).body as {
          input: unknown[];
          instructions?: string;
        };
        expect(wire.instructions).toBe(
          (active ? current.text : rule) || undefined,
        );
        expect(wire.input).toEqual(
          !active && note
            ? [...prefix, { role: "user", content: note }]
            : prefix,
        );
        expect(JSON.stringify(wire)).not.toContain("cache_control");
        await host.exchange(frozen);
        expect(sent).toEqual(wire);
      }
      const corrected = host.previewRequest({
        ...request,
        appended: [
          ...request.appended,
          guide(fixed, player),
          {
            kind: "runtime_notice",
            notice: "response_correction",
            text: "Please correct the malformed response.",
          },
        ],
      }).body as { input: unknown[]; instructions: string };
      expect(corrected.instructions).toBe(
        active ? guide(fixed, player).text : fixed,
      );
      expect(corrected.input.at(-1)).toEqual({
        role: "user",
        content: "Please correct the malformed response.",
      });
    }
  },
);

test("Responses scopes a followup task to its dispatch and keeps world revision boundaries in sequence", () => {
  const connection = {
    provider: "openai_responses" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "alias",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  };
  const epoch = {
    role: "runtime_system" as const,
    markdown: "Older revision boundary",
    blocks: [
      {
        source: "runtime:world-revision-epoch:old",
        markdown: "Older revision boundary",
      },
    ],
  };
  const task = {
    role: "author_instruction" as const,
    markdown: "Summarize this chapter.",
    blocks: [
      { source: "followup:summary", markdown: "Summarize this chapter." },
    ],
  };
  for (const active of [false, true]) {
    const host = new FileNativeModelHost({
      ...connection,
      responsesTurnInstructions: active,
    });
    const request = exchangeFor(
      connection.provider,
      connection.modelId,
      host.binding().cacheStrategy,
    );
    request.appended = [
      { kind: "prompt_delta", logicalMessages: [epoch] },
      { kind: "user", text: "New edit" },
    ];
    const revision = host.previewAuthoringRequest(request).body as {
      input: unknown[];
    };
    expect(revision).not.toHaveProperty("instructions");
    expect(revision.input.slice(-2)).toEqual([
      { role: "developer", content: epoch.markdown },
      { role: "user", content: "New edit" },
    ]);
    const followup = host.previewRequest({
      ...request,
      appended: [
        ...request.appended,
        { kind: "prompt_delta", requestScoped: true, logicalMessages: [task] },
      ],
    }).body as { instructions?: string; input: unknown[] };
    if (active) {
      expect(followup.input).toEqual(revision.input);
      expect(followup.instructions).toContain(task.markdown);
    } else {
      expect(followup).not.toHaveProperty("instructions");
      expect(followup.input).toEqual([
        ...revision.input,
        {
          role: "developer",
          content: renderPromptDeltaMessage(task.role, task.markdown),
        },
      ]);
    }
  }
});

test("Responses replays the historical CLIProxyAPI encoder and records independent capabilities on new requests", () => {
  const connection = {
    provider: "openai_responses" as const,
    dialect: "cliproxyapi" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "alias",
    contextWindowTokens: 64_000,
    maxOutputTokens: 2_048,
  };
  const host = new FileNativeModelHost(connection);
  const enabled = new FileNativeModelHost({
    ...connection,
    responsesTurnInstructions: true,
    responsesCacheControl: true,
  });
  expect(host.binding().cacheStrategy).toBe("provider_managed");
  expect(enabled.binding().cacheStrategy).toBe("explicit_cliproxyapi_message");
  const initial = transcriptWithTurnGuide(
    connection.provider,
    connection.modelId,
    enabled.binding().cacheStrategy,
  );
  const frozen = enabled.freezeRequest(initial);
  expect(frozen.modelConfig).toMatchObject({
    responsesTurnInstructions: true,
    responsesCacheControl: true,
  });
  expect(host.previewRequest(frozen)).toEqual(enabled.previewRequest(frozen));
  const historical = structuredClone(frozen);
  delete historical.modelConfig!.responsesTurnInstructions;
  delete historical.modelConfig!.responsesCacheControl;
  const prior = host.previewRequest(historical).body as { input: unknown[] };
  expect(prior).not.toHaveProperty("instructions");
  expect(prior.input[0]).toMatchObject({
    role: "system",
    cache_control: { type: "ephemeral" },
  });
  expect(prior.input.slice(-2)).toEqual([
    { role: "user", content: "Second", cache_control: { type: "ephemeral" } },
    { role: "user", content: turnGuideSuffix.text },
  ]);
  const resent = retargetRequestForRetry(historical, host);
  const repaired = host.previewRequest(resent).body as { input: unknown[] };
  expect(repaired.input[0]).toMatchObject({ role: "developer" });
  expect(repaired.input.at(-1)).toEqual({
    role: "user",
    content: turnGuideSuffix.text,
  });
  expect(repaired).not.toHaveProperty("instructions");
  expect(JSON.stringify(repaired)).not.toContain("cache_control");
  const oldGuideOnModern = enabled.previewRequest(
    retargetRequestForRetry(historical, enabled),
  ).body as { input: unknown[] };
  expect(oldGuideOnModern).not.toHaveProperty("instructions");
  expect(oldGuideOnModern.input.at(-1)).toEqual({
    role: "user",
    content: turnGuideSuffix.text,
  });
  const next = retargetRequestForRetry(frozen, host);
  expect(next.modelConfig).toMatchObject({
    responsesTurnInstructions: false,
    responsesCacheControl: false,
  });
  expect(JSON.stringify(host.previewRequest(next).body)).not.toContain(
    "cache_control",
  );
  expect(host.binding().protocolConfigFingerprint).not.toEqual(
    new FileNativeModelHost({
      ...connection,
      responsesTurnInstructions: true,
    }).binding().protocolConfigFingerprint,
  );
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
  "google_interactions",
] as const)(
  "%s retries two 429 rejections with identical native requests",
  async (provider) => {
    vi.useFakeTimers();
    try {
      const bodies: unknown[] = [];
      const host = new FileNativeModelHost(
        {
          provider,
          baseUrl: "https://provider.invalid/v1",
          apiKey: "secret",
          modelId: "manual-model",
          contextWindowTokens: 64000,
          maxOutputTokens: 2048,
        },
        async (_url, init) => {
          await Promise.resolve();
          bodies.push(init?.body);
          if (bodies.length < 3)
            return new Response(
              JSON.stringify({
                error: {
                  code: "rate_limit_exceeded",
                  message: "Temporary rate limit; see billing help",
                },
              }),
              { status: 429, headers: { "content-type": "application/json" } },
            );
          if (provider === "google_interactions")
            return new Response(
              [
                {
                  event_type: "step.start",
                  index: 0,
                  step: { type: "model_output" },
                },
                {
                  event_type: "step.delta",
                  index: 0,
                  delta: { type: "text", text: "Recovered." },
                },
                { event_type: "step.stop", index: 0 },
                {
                  event_type: "interaction.completed",
                  interaction: { status: "completed" },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          return Response.json(
            provider === "chat_completions"
              ? {
                  choices: [
                    {
                      message: { role: "assistant", content: "Recovered." },
                      finish_reason: "stop",
                    },
                  ],
                }
              : provider === "openai_responses"
                ? {
                    id: "response",
                    status: "completed",
                    output: [
                      {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "Recovered." }],
                      },
                    ],
                  }
                : {
                    id: "response",
                    role: "assistant",
                    content: [{ type: "text", text: "Recovered." }],
                    stop_reason: "end_turn",
                  },
          );
        },
      );
      const receipts: unknown[] = [];
      const pending = host.exchange(
        exchangeFor(provider, "manual-model", host.binding().cacheStrategy),
        {
          onRetry: (receipt) => {
            receipts.push(receipt);
          },
        },
      );
      const checked = expect(pending).resolves.toMatchObject({
        text: "Recovered.",
      });
      await vi.runAllTimersAsync();
      await checked;
      expect(bodies).toHaveLength(3);
      expect(new Set(bodies).size).toBe(1);
      expect(receipts).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each([
  {
    provider: "chat_completions",
    body: '{"error":{"code":"minute_limit","message":"Account quota; key-sentinel"},"signature":"hidden"}',
    diagnostic:
      'Provider request failed: 429 {"error":{"code":"minute_limit","message":"Account quota; [redacted]"},"signature":"[redacted]"}',
  },
  {
    provider: "anthropic_messages",
    body: "[gateway] capacity unavailable for key-sentinel",
    diagnostic:
      "Provider request failed: 429 [gateway] capacity unavailable for [redacted]",
  },
  {
    provider: "openai_responses",
    body: '{"error":"heavy_traffic"}',
    diagnostic: 'Provider request failed: 429 {"error":"heavy_traffic"}',
  },
  {
    provider: "openai_responses",
    body: "",
    diagnostic: "Provider temporarily rate limited the request",
  },
  {
    provider: "google_interactions",
    body: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"key-sentinel hidden"}}',
    diagnostic: "Google Interactions HTTP 429: RESOURCE_EXHAUSTED",
  },
] as const)(
  "surfaces only the latest permitted $provider rejection ($body)",
  async ({ provider, body, diagnostic }) => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const host = new FileNativeModelHost(
        {
          provider,
          baseUrl: "https://provider.invalid/v1",
          apiKey: "key-sentinel",
          modelId: "manual-model",
          contextWindowTokens: 64000,
          maxOutputTokens: 2048,
        },
        () => {
          attempts++;
          return Promise.resolve(
            new Response(attempts < 4 ? "first rejection" : body, {
              status: 429,
            }),
          );
        },
      );
      const error = host
        .exchange(
          exchangeFor(provider, "manual-model", host.binding().cacheStrategy),
        )
        .catch((reason: unknown) => reason);
      await vi.runAllTimersAsync();
      expect(await error).toMatchObject({ message: diagnostic });
      expect(attempts).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
  "google_interactions",
] as const)(
  "%s never retries explicit hard balance failures and retains safe evidence",
  async (provider) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "insufficient_balance",
              message: "Your credit balance is too low. private-echo",
            },
          },
          { status: 429 },
        ),
      ),
    );
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 2048,
      },
      fetchMock,
    );
    const error: unknown = await host
      .exchange(
        exchangeFor(provider, "manual-model", host.binding().cacheStrategy),
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ModelHostFailureError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as ModelHostFailureError).details).toEqual({
      code: "hard_quota_exhausted",
      httpStatus: 429,
    });
    expect((error as Error).message).not.toContain("private-echo");
  },
);

test.each(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"])(
  "unproven timeout %s is never replayed",
  async (code) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("timeout"), { code }),
        }),
      ),
    );
    const host = new FileNativeModelHost(
      {
        provider: "chat_completions",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "manual-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 2048,
      },
      fetchMock,
    );
    await expect(
      host.exchange(
        exchangeFor("chat_completions", "manual-model", "provider_managed"),
      ),
    ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test("Google connection timeout after continuation progress is unknown and records interrupted evidence without retry", async () => {
  const hops: GoogleHopEvidence[] = [];
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        [
          { event_type: "interaction.created", interaction: { id: "first" } },
          {
            event_type: "interaction.completed",
            interaction: {
              status: "requires_continuation",
              continuation_token: "private-token",
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    .mockRejectedValueOnce(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    );
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2048,
    },
    fetchMock,
  );
  const retry = vi.fn();
  await expect(
    host.exchange(
      exchangeFor("google_interactions", "manual-model", "provider_managed"),
      {
        onRetry: retry,
        onGoogleHop: (hop) => {
          hops.push(structuredClone(hop));
        },
      },
    ),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(retry).not.toHaveBeenCalled();
  expect(hops.at(-1)).toMatchObject({
    hop: 2,
    tokenSupplied: true,
    status: "interrupted",
  });
});
