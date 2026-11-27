import { expect, test, vi } from "vitest";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  chatGptPlanBaseUrl,
  type FileNativeModelConnection,
} from "../../src/runtime/model/FileNativeModelConnection.ts";
import { testModelConnection } from "../../src/runtime/model/ModelConnectionTest.ts";
import type { ModelHostExchange } from "../../src/runtime/model/ModelHost.ts";
import type { AiFailureRecorder } from "../../src/runtime/model/AiFailureLog.ts";
import { aggregateResponsesModelStream } from "../../src/runtime/model/ModelHostStream.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const fixtureToken = "fixture-bearer-authorization";

function planConnection(
  overrides: Partial<
    NonNullable<FileNativeModelConnection["chatgptPlan"]>
  > = {},
): FileNativeModelConnection {
  return {
    provider: "openai_responses",
    baseUrl: chatGptPlanBaseUrl,
    apiKey: "",
    modelId: "account-model",
    maxOutputTokens: 3000,
    contextWindowTokens: 64000,
    chatgptPlan: {
      accountId: "local-account-one",
      allowFollowups: false,
      accessToken: () => Promise.resolve(fixtureToken),
      ...overrides,
    },
  };
}

function requestFor(host: FileNativeModelHost): ModelHostExchange {
  const binding = host.binding();
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      ...binding,
      playerInput: "",
      playerInputPlacement: "append",
    }),
  );
  return {
    bootstrap,
    tools: bootstrap.tools,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.tools.map(({ name }) => name),
    appended: [{ kind: "player", text: "Read and reply." }],
    maxOutputTokens: binding.maxOutputTokens,
  };
}

function completed(output: unknown[]) {
  return {
    type: "response.completed",
    response: { id: "resp-completed", status: "completed", output },
  };
}

function stream(...events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req-plan",
      },
    },
  );
}

test("ChatGPT plan retains native custom tool calls and wraps the matching Runtime result", async () => {
  const customCall = {
    type: "custom_tool_call",
    namespace: "narraeon",
    name: "context_read",
    call_id: "call-custom",
    input: '{"ref":"@current-situation"}',
    encrypted_content: "opaque-continuation",
  };
  const bodies: Record<string, unknown>[] = [];
  const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toEqual(new URL("https://api.openai.com/v1/responses"));
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${fixtureToken}`,
    );
    bodies.push(
      (await new Response(init?.body).json()) as Record<string, unknown>,
    );
    return stream(
      completed(
        bodies.length === 1
          ? [customCall]
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Complete." }],
              },
            ],
      ),
    );
  });
  const host = new FileNativeModelHost(planConnection(), fetch_);
  const first = host.freezeRequest(requestFor(host));
  const received = await host.exchange(first);
  if (received.providerState === undefined)
    throw new Error("missing native continuation");
  expect(received.toolCalls).toEqual([
    {
      id: "call-custom",
      name: "context_read",
      arguments: { ref: "@current-situation" },
    },
  ]);
  const next: ModelHostExchange = {
    ...first,
    allowedTools: [],
    appended: [
      ...first.appended,
      {
        kind: "assistant",
        text: "",
        providerState: received.providerState,
        toolCalls: received.toolCalls ?? [],
      },
      {
        kind: "tool",
        toolCallId: "call-custom",
        markdown: "Rejected receipt",
        isError: true,
      },
    ],
  };
  const preview = host.previewRequest(next);
  expect(preview.headerNames).toContain("Authorization");
  expect(JSON.stringify([first, preview, host.binding()])).not.toMatch(
    /fixture-bearer-authorization|local-account-one|accessToken/u,
  );
  const response = await host.exchange(next);
  expect(response.text).toBe("Complete.");
  expect(bodies[1]).toEqual(preview.body);
  expect(bodies[1]).toMatchObject({ store: false, stream: true });
  expect(bodies[1]?.input).toContainEqual(customCall);
  expect(bodies[1]?.input).toContainEqual({
    type: "custom_tool_call_output",
    namespace: "narraeon",
    name: "context_read",
    call_id: "call-custom",
    output: JSON.stringify({ content: "Rejected receipt", success: false }),
  });
  expect(bodies[1]).not.toHaveProperty("tools");
  expect(bodies[1]).not.toHaveProperty("previous_response_id");
  expect(bodies[1]).not.toHaveProperty("max_output_tokens");
});

test.each([
  {
    name: "delta with no completion",
    response: () =>
      stream({ type: "response.output_text.delta", delta: "Partial" }),
  },
  {
    name: "ordinary JSON",
    response: () => Response.json(completed([]).response),
  },
  {
    name: "provider length interruption",
    response: () =>
      stream(
        { type: "response.output_text.delta", delta: "Partial" },
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ),
  },
])("the ChatGPT plan does not accept $name", async ({ response }) => {
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(response()));
  const host = new FileNativeModelHost(planConnection(), fetch_);
  await expect(host.exchange(requestFor(host))).rejects.toThrow();
  expect(fetch_).toHaveBeenCalledTimes(1);
});

test("a ChatGPT plan probe sends one request and counts a stream usage error as quota", async () => {
  const fetch_ = vi.fn<typeof fetch>(async (_url, init) => {
    const request: unknown = await new Response(init?.body).json();
    expect(request).toMatchObject({
      input: [{ role: "user", content: "请简短回复。" }],
      stream: true,
      store: false,
    });
    expect(request).not.toHaveProperty("max_output_tokens");
    return stream(
      { type: "response.output_text.delta", delta: "Partial" },
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "subscription_sharing_usage_limit_exceeded",
            message: fixtureToken,
          },
        },
      },
    );
  });
  const connection = planConnection();
  await expect(
    testModelConnection(connection, "zh-CN", fetch_),
  ).resolves.toEqual({
    outcome: "quota",
  });
  expect(fetch_).toHaveBeenCalledTimes(1);
});

test("a rejected ChatGPT token is invalidated once and upstream secrets are excluded from diagnostics", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: {
          code: "invalid_token",
          message: fixtureToken,
          param: fixtureToken,
        },
      },
      { status: 401, headers: { "x-request-id": "req-revoke" } },
    ),
  );
  const invalidate = vi
    .fn<(token: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const host = new FileNativeModelHost(planConnection({ invalidate }), fetch_);
  const failure = await host
    .exchange(requestFor(host))
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    details: {
      chatgptPlanFailure: "authentication",
      providerCode: "invalid_token",
      httpStatus: 401,
      requestId: "req-revoke",
    },
  });
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error)
    expect(failure.message).toContain("authorize plan usage again");
  expect(JSON.stringify(failure)).not.toContain(fixtureToken);
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(fixtureToken);
  expect(fetch_).toHaveBeenCalledTimes(1);
});

test("a frozen plan request cannot be resent on a different account or with an API key", () => {
  const connection = planConnection();
  const host = new FileNativeModelHost(connection);
  const otherAccount = new FileNativeModelHost(
    planConnection({ accountId: "another-account" }),
  );
  const { chatgptPlan: _plan, ...apiKeyOptions } = connection;
  void _plan;
  const apiKey = new FileNativeModelHost({
    ...apiKeyOptions,
    apiKey: "api-key",
  });
  const request = host.freezeRequest(requestFor(host));
  expect(() => otherAccount.previewRequest(request)).toThrow(
    /different ChatGPT plan connection/u,
  );
  expect(() => apiKey.previewRequest(request)).toThrow(
    /different ChatGPT plan connection/u,
  );
  expect(
    () =>
      new FileNativeModelHost({
        ...connection,
        baseUrl: "https://proxy.invalid/v1",
      }),
  ).toThrow(/public OpenAI Responses endpoint/u);
});

test("cancelling while acquiring authorization prevents a late paid dispatch", async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const fetch_ = vi.fn<typeof fetch>();
  const accessToken = vi.fn(() => promise);
  const host = new FileNativeModelHost(planConnection({ accessToken }), fetch_);
  const controller = new AbortController();
  const completion = host.exchange(requestFor(host), {
    signal: controller.signal,
  });
  const cancelled = expect(completion).rejects.toThrow(/cancelled/u);
  await vi.waitFor(() => expect(accessToken).toHaveBeenCalledTimes(1));
  controller.abort();
  await cancelled;
  resolve(fixtureToken);
  await Promise.resolve();
  expect(fetch_).not.toHaveBeenCalled();
});

test.each([307, 421, 429])(
  "a ChatGPT plan POST does not redirect or retry status %s",
  async (status) => {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: {
          location: "https://api.openai.com/v1/elsewhere",
          "retry-after": "0",
        },
      }),
    );
    const host = new FileNativeModelHost(planConnection(), fetch_);
    await expect(host.exchange(requestFor(host))).rejects.toThrow(
      /ChatGPT plan/u,
    );
    expect(fetch_).toHaveBeenCalledTimes(1);
  },
);

test.each([
  undefined,
  "application/octet-stream",
  "text/plain",
  "application/x-openai-stream",
  "text/event-stream; charset=utf-8",
])(
  "ChatGPT plan accepts completed SSE with response MIME %s and optional status omitted",
  async (media) => {
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Settled answer" }],
      },
    ];
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          new TextEncoder().encode(
            ": keepalive comment\r\n\r\n" +
              "event: ping\ndata: {}\n\n" +
              "event: keepalive\ndata: heartbeat\n\n" +
              "data: \n\n" +
              `event: message\ndata: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n` +
              "data: [DONE]\n\n",
          ),
          media === undefined ? {} : { headers: { "content-type": media } },
        ),
      );
    const host = new FileNativeModelHost(planConnection(), fetch_);
    await expect(host.exchange(requestFor(host))).resolves.toMatchObject({
      text: "Settled answer",
      providerState: { protocol: "openai_responses", output },
    });
    expect(fetch_).toHaveBeenCalledTimes(1);
  },
);

test.each([
  {
    stage: "response_media",
    media: "json",
    response: () => Response.json({ text: fixtureToken }),
  },
  {
    stage: "response_media",
    media: "html",
    response: () =>
      new Response(`<!doctype html><p>${fixtureToken}</p>`, {
        headers: { "content-type": "text/html" },
      }),
  },
  {
    stage: "sse_frame",
    media: "plain_text",
    response: () =>
      new Response(
        `<!doctype html><p>${fixtureToken}</p>\n\ndata: ${JSON.stringify(completed([]))}\n\n`,
        { headers: { "content-type": "text/plain" } },
      ),
  },
  {
    stage: "sse_frame",
    media: "octet_stream",
    response: () =>
      new Response(JSON.stringify(completed([])), {
        headers: { "content-type": "application/octet-stream" },
      }),
  },
  {
    stage: "response_body",
    media: "event_stream",
    response: () =>
      new Response(null, { headers: { "content-type": "text/event-stream" } }),
  },
  {
    stage: "sse_event_json",
    media: "event_stream",
    response: () =>
      new Response(`data: invalid ${fixtureToken}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  },
  {
    stage: "sse_event_type",
    media: "event_stream",
    response: () => stream({ credential: fixtureToken }),
  },
  {
    stage: "sse_completed_output",
    media: "event_stream",
    response: () =>
      stream({ type: "response.completed", response: { status: "completed" } }),
  },
  {
    stage: "sse_end_before_completed",
    media: "event_stream",
    response: () =>
      new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  },
])(
  "ChatGPT plan records only safe $stage evidence and preserves unknown settlement",
  async ({ stage, media, response }) => {
    const recordFailure = vi
      .fn<AiFailureRecorder["recordFailure"]>()
      .mockResolvedValue(undefined);
    const failureLog: AiFailureRecorder = {
      recordFailure,
      recordExchangeIfActive: () => Promise.resolve(),
      resolve: () => Promise.resolve(),
    };
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    const host = new FileNativeModelHost(planConnection(), fetch_, failureLog);
    await expect(host.exchange(requestFor(host))).rejects.toMatchObject({
      kind: "unknown",
      details: { stage, httpStatus: 200, media },
    });
    expect(recordFailure).toHaveBeenCalledTimes(1);
    const report = recordFailure.mock.calls[0]?.[0];
    expect(report?.exchange.request.body).toBe("");
    expect(report?.exchange.response).toBeUndefined();
    expect(report?.failures[0]?.details).toMatchObject({
      stage,
      httpStatus: 200,
      media,
    });
    expect(JSON.stringify(report)).not.toContain(fixtureToken);
    expect(fetch_).toHaveBeenCalledTimes(1);
  },
);

test("strict ChatGPT plan framing bounds bytes and rejects an unterminated terminal frame", async () => {
  const validData = `data: ${JSON.stringify(completed([]))}`;
  const completeBody = new Response(`${validData}\n\n`).body!;
  await expect(
    aggregateResponsesModelStream(completeBody, undefined, {
      strictMaxBytes: 16,
    }),
  ).rejects.toMatchObject({ stage: "sse_size" });
  const incompleteBody = new Response(`${validData}\n`).body!;
  await expect(
    aggregateResponsesModelStream(incompleteBody, undefined, {
      strictMaxBytes: 4096,
    }),
  ).rejects.toMatchObject({ stage: "sse_frame" });
});

test("ChatGPT plan classifies transport failure without retaining the underlying error", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockRejectedValue(
    new TypeError(fixtureToken, {
      cause: Object.assign(new Error(fixtureToken), { code: "UND_ERR_SOCKET" }),
    }),
  );
  const host = new FileNativeModelHost(planConnection(), fetch_);
  const error = await host
    .exchange(requestFor(host))
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    kind: "unknown",
    details: { stage: "transport", transport: "socket" },
  });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain(fixtureToken);
  expect(fetch_).toHaveBeenCalledTimes(1);
});

test("ChatGPT plan recognizes a named error with an untyped JSON error envelope", async () => {
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      `event: error\ndata: ${JSON.stringify({
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          message: fixtureToken,
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const host = new FileNativeModelHost(planConnection(), fetch_);
  await expect(host.exchange(requestFor(host))).rejects.toMatchObject({
    kind: "failed",
    details: { stage: "sse_terminal_failure", chatgptPlanFailure: "quota" },
  });
  expect(fetch_).toHaveBeenCalledTimes(1);
});
