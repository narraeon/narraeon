import { expect, test, vi } from "vitest";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  chatGptPlanBaseUrl,
  type FileNativeModelConnection,
} from "../../src/runtime/model/FileNativeModelConnection.ts";
import { testModelConnection } from "../../src/runtime/model/ModelConnectionTest.ts";
import type { ModelHostExchange } from "../../src/runtime/model/ModelHost.ts";
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
  const bodies: unknown[] = [];
  const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${fixtureToken}`,
    );
    bodies.push(await new Response(init?.body).json());
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
  expect(bodies[1]).toMatchObject({
    store: false,
    stream: true,
    input: expect.arrayContaining([
      customCall,
      {
        type: "custom_tool_call_output",
        namespace: "narraeon",
        name: "context_read",
        call_id: "call-custom",
        output: JSON.stringify({ content: "Rejected receipt", success: false }),
      },
    ]),
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
    message: expect.stringContaining("authorize plan usage again"),
    details: {
      chatgptPlanFailure: "authentication",
      providerCode: "invalid_token",
      httpStatus: 401,
      requestId: "req-revoke",
    },
  });
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
