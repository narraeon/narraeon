import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";
import type {
  ModelConnectionLibraryView,
  ModelProviderKind,
  TestModelConnectionInput,
  TestModelConnectionResult,
} from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { v1Protocol } from "../../src/protocol/v1Version.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

const apiKey = "fixture-private-test-key";
const replyText = "A real reply from the local fixture.";

test.use({ runtimeScope: "model-connection-test" });

const protocols = [
  { provider: "chat_completions", locale: "zh-CN", path: "chat/completions" },
  { provider: "openai_responses", locale: "en", path: "responses" },
  { provider: "anthropic_messages", locale: "en", path: "messages" },
  { provider: "google_interactions", locale: "zh-CN", path: "interactions" },
] as const;

for (const { provider, locale, path } of protocols) {
  test(`tests the unsaved ${provider} form in ${locale}`, async ({ page }) => {
    const zh = locale === "zh-CN";
    const t = (chinese: string, english: string) => (zh ? chinese : english);
    const fixture = await startProvider((request, response) => {
      writeModelStream(response, provider, request);
    });
    try {
      await runtime(page, { type: "preferences.save", locale });
      const before = await modelLibrary(page);
      await page.goto("/#/models");
      const form = page.locator("form.config-form");
      await form
        .getByText(t("高级协议选项", "Advanced protocol options"), {
          exact: true,
        })
        .click();
      await form.locator("#model-provider").selectOption(provider);
      await form.getByLabel("Base URL", { exact: true }).fill(fixture.baseUrl);
      await form
        .getByLabel(t("模型 ID", "Model ID"), { exact: true })
        .fill(`unsaved-${provider}`);
      await form
        .getByLabel(t("模型提示词（可选）", "Model prompt (optional)"))
        .fill("This connection prompt must stay out of the probe");
      await form
        .getByLabel(t("最大输出 tokens", "Maximum output tokens"))
        .fill("8192");
      if (provider === "chat_completions")
        await form.locator("#model-auth-mode").selectOption("none");
      else {
        await form.getByLabel("API Key", { exact: true }).fill(apiKey);
        await form.locator("#model-reasoning-effort").selectOption("low");
      }
      const send = form.getByRole("button", {
        name: t("试发一条消息", "Send a test message"),
        exact: true,
      });
      await expect(send).toHaveAccessibleDescription(
        t(
          "试发会用当前表单向模型发送一条短消息，服务商可能计费。",
          "The test sends one short message using this form. Your provider may charge for it.",
        ),
      );
      expect(fixture.requests).toHaveLength(0);
      await send.click();
      const status = form.getByRole("status");
      await expect(status).toHaveText(
        t(
          "试发成功，已收到模型回复。",
          "Test succeeded. The model returned a reply.",
        ),
      );
      await expect(
        form.getByLabel(t("模型 ID", "Model ID"), { exact: true }),
      ).toHaveValue(`unsaved-${provider}`);
      expect(await modelLibrary(page)).toEqual(before);
      expect(fixture.requests).toHaveLength(1);
      const request = fixture.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.path).toBe(`/v1/${path}`);
      expect(request.headers.accept).toBe("text/event-stream");
      const prompt = t("请简短回复。", "Reply briefly.");
      const body = request.body;
      expect(body).toMatchObject({
        model: `unsaved-${provider}`,
        stream: true,
      });
      for (const key of [
        "tools",
        "tool_choice",
        "instructions",
        "system_instruction",
        "system",
        "continuation_token",
        "previous_response_id",
      ])
        expect(body).not.toHaveProperty(key);

      if (provider === "chat_completions") {
        expect(request.headers.authorization).toBeUndefined();
        expect(body).toMatchObject({
          messages: [{ role: "user", content: prompt }],
          max_tokens: 256,
        });
      } else if (provider === "openai_responses") {
        expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
        expect(body).toMatchObject({
          input: [{ role: "user", content: prompt }],
          reasoning: { effort: "low" },
          max_output_tokens: 256,
          store: false,
        });
      } else if (provider === "anthropic_messages") {
        expect(request.headers["x-api-key"]).toBe(apiKey);
        expect(body).toMatchObject({
          messages: [{ role: "user", content: prompt }],
          output_config: { effort: "low" },
          max_tokens: 256,
        });
      } else {
        expect(request.headers["x-goog-api-key"]).toBe(apiKey);
        expect(body).toMatchObject({
          input: [
            { type: "user_input", content: [{ type: "text", text: prompt }] },
          ],
          generation_config: { max_output_tokens: 256, thinking_level: "low" },
          store: false,
        });
      }
    } finally {
      await fixture.close();
    }
  });
}

test("keeps saved credentials on their origin and the active connection unchanged", async ({
  page,
}) => {
  const source = await startProvider((request, response) =>
    writeModelStream(response, "chat_completions", request),
  );
  const other = await startProvider((request, response) =>
    writeModelStream(response, "chat_completions", request),
  );
  const savedName = "Saved key for this origin";
  const activeName = "Active connection";
  const draft = settings(source.baseUrl, "chat_completions", "saved-model");
  try {
    await runtime(page, { type: "preferences.save", locale: "en" });
    const first = await runtime<ModelConnectionLibraryView>(page, {
      type: "model.save",
      connection: { ...draft, name: savedName, presetId: "custom" },
    });
    const savedId = first.activeConnectionId!;
    const second = await runtime<ModelConnectionLibraryView>(page, {
      type: "model.save",
      connection: {
        ...draft,
        name: activeName,
        presetId: "custom",
        apiKey: "active-other-key",
      },
    });
    await runtime(page, { type: "model.select", connectionId: savedId });
    await runtime(page, {
      type: "model.select",
      connectionId: second.activeConnectionId!,
    });

    await page.goto("/#/models");
    await page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: savedName, exact: true }),
      })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const form = page.locator("form.config-form");
    const send = form.getByRole("button", {
      name: "Send a test message",
      exact: true,
    });
    const base = form.getByLabel("Base URL", { exact: true });
    const status = form.getByRole("status");

    expect(source.requests).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
    await base.fill(`${source.baseUrl}/unsaved-path`);
    await send.click();
    await expect(status).toHaveText(
      "Test succeeded. The model returned a reply.",
    );
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]!.headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(source.requests[0]!.path).toBe("/v1/unsaved-path/chat/completions");
    await expect(page.locator(".model-active-summary strong")).toHaveText(
      activeName,
    );
    expect(await modelLibrary(page)).toEqual(second);

    await base.fill(other.baseUrl);
    await expect(send).toBeDisabled();
    const crossOrigin = await runtime<TestModelConnectionResult>(page, {
      type: "model.test",
      connection: {
        ...draft,
        baseUrl: other.baseUrl,
        connectionId: savedId,
        apiKey: "",
      },
    });
    expect(crossOrigin).toEqual({ outcome: "invalid_settings" });
    expect(other.requests).toHaveLength(0);
    await form
      .getByLabel("API Key", { exact: true })
      .fill("new-key-for-other-origin");
    await send.click();
    await expect(status).toHaveText(
      "Test succeeded. The model returned a reply.",
    );
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.headers.authorization).toBe(
      "Bearer new-key-for-other-origin",
    );
    expect(await modelLibrary(page)).toEqual(second);
  } finally {
    await runtime(page, {
      type: "model.delete",
      connectionId: (await modelLibrary(page)).connections.find(
        ({ name }) => name === savedName,
      )!.id,
    });
    await runtime(page, {
      type: "model.delete",
      connectionId: (await modelLibrary(page)).activeConnectionId!,
    });
    await Promise.all([source.close(), other.close()]);
  }
});

test("reports a bounded outcome without retrying, redirecting, or disclosing provider output", async ({
  page,
}) => {
  const fixture = await startProvider((request, response) => {
    const model = String(request.body.model);
    if (/^http-\d+$/u.test(model)) {
      const status = Number(model.slice(5));
      response
        .writeHead(status, {
          "Content-Type": "application/json",
          ...(status === 307
            ? { Location: "/redirected/chat/completions" }
            : {}),
          ...(status === 429 ? { "Retry-After": "0" } : {}),
        })
        .end(JSON.stringify({ error: { message: apiKey } }));
    } else if (model === "response-too-large") {
      response
        .writeHead(200, { "Content-Type": "text/event-stream" })
        .end(" ".repeat(1024 * 1024 + 1));
    } else {
      const provider = request.path?.endsWith("/interactions")
        ? "google_interactions"
        : "chat_completions";
      writeModelStream(response, provider, request);
    }
  });
  try {
    await runtime(page, { type: "preferences.save", locale: "en" });
    await page.goto("/#/models");
    const form = page.locator("form.config-form");
    await form.getByLabel("Base URL", { exact: true }).fill(fixture.baseUrl);
    await form.getByLabel("API Key", { exact: true }).fill(apiKey);
    await form.getByLabel("Model ID", { exact: true }).fill("http-429");
    await form
      .getByRole("button", { name: "Send a test message", exact: true })
      .click();
    await expect(form.getByRole("status")).toHaveText(
      "The provider rejected the request (HTTP 429). Check rate limits, quota, or balance.",
    );
    expect(fixture.requests).toHaveLength(1);
    await expect(form.getByRole("status")).not.toContainText(apiKey);

    const cases = [
      ["http-401", "authentication"],
      ["http-402", "quota"],
      ["http-400", "parameters"],
      ["http-404", "not_found"],
      ["http-307", "redirect"],
      ["reasoning-only", "reasoning_only"],
      ["blank-text", "no_text"],
      ["length-blank", "output_limit"],
      ["length-text", "success"],
      ["response-too-large", "output_limit"],
      ["continuation", "continuation_required"],
    ] as const;
    for (const [model, outcome] of cases) {
      const count = fixture.requests.length;
      expect(
        await runtime<TestModelConnectionResult>(page, {
          type: "model.test",
          connection: settings(
            fixture.baseUrl,
            model === "continuation"
              ? "google_interactions"
              : "chat_completions",
            model,
          ),
        }),
      ).toEqual({ outcome });
      expect(fixture.requests).toHaveLength(count + 1);
    }

    const count = fixture.requests.length;
    expect(
      await runtime<TestModelConnectionResult>(page, {
        type: "model.test",
        connection: {
          ...settings(fixture.baseUrl, "anthropic_messages", "large-budget"),
          thinkingMode: "enabled",
          thinkingBudgetTokens: 1024,
        },
      }),
    ).toEqual({ outcome: "thinking_budget_too_large" });
    expect(fixture.requests).toHaveLength(count);
    expect(
      await runtime<TestModelConnectionResult>(page, {
        type: "model.test",
        connection: {
          ...settings(
            fixture.baseUrl,
            "google_interactions",
            "budgeted-google",
          ),
          dialect: "cliproxyapi",
          thinkingMode: "enabled",
          thinkingBudgetTokens: 128,
        },
      }),
    ).toEqual({ outcome: "success" });
    expect(fixture.requests).toHaveLength(count + 1);
    expect(fixture.requests.at(-1)?.body.generation_config).toMatchObject({
      thinking_budget: 128,
      max_output_tokens: 128,
    });
  } finally {
    await fixture.close();
  }
});

test("aborts a stalled stream after the test deadline", async ({ page }) => {
  const fixture = await startProvider((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": waiting\n\n");
  });
  try {
    await runtime(page, { type: "preferences.save", locale: "zh-CN" });
    await page.goto("/#/models");
    const form = page.locator("form.config-form");
    await form.getByLabel("Base URL", { exact: true }).fill(fixture.baseUrl);
    await form.getByLabel("API Key", { exact: true }).fill(apiKey);
    await form.getByLabel("模型 ID", { exact: true }).fill("stalling-model");
    const send = form.getByRole("button", {
      name: "试发一条消息",
      exact: true,
    });
    await send.click();
    await expect(send).toBeDisabled();
    await expect(form.getByRole("status")).toHaveText("正在试发…");
    await expect(form.getByRole("status")).toHaveText(
      "试发超时，未能确认模型回复。",
      { timeout: 20_000 },
    );
    await expect(send).toBeEnabled();
    expect(fixture.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

function settings(
  baseUrl: string,
  provider: ModelProviderKind,
  modelId: string,
): TestModelConnectionInput {
  return {
    baseUrl,
    provider,
    modelId,
    apiKey,
    contextWindowTokens: 64_000,
    maxOutputTokens: 8192,
  };
}

async function modelLibrary(page: Page): Promise<ModelConnectionLibraryView> {
  return runtime(page, { type: "model.read" });
}

async function runtime<Value = unknown>(
  page: Page,
  request: V1Request,
): Promise<Value> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: v1Protocol, request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: Value }).result;
}

interface ProviderRequest {
  method: string | undefined;
  path: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function startProvider(
  respond: (request: ProviderRequest, response: ServerResponse) => void,
) {
  const requests: ProviderRequest[] = [];
  const server = createServer((event, response) => {
    event.setEncoding("utf8");
    let payload = "";
    event.on("data", (chunk: string) => {
      payload += chunk;
    });
    event.on("end", () => {
      const request = {
        method: event.method,
        path: event.url,
        headers: event.headers,
        body: JSON.parse(payload || "{}") as Record<string, unknown>,
      };
      requests.push(request);
      respond(request, response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string")
    throw new Error("Fixture port missing");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function writeModelStream(
  response: ServerResponse,
  provider: ModelProviderKind,
  request: ProviderRequest,
): void {
  let events: unknown[];
  switch (provider) {
    case "chat_completions": {
      const model = String(request.body.model);
      const delta =
        model === "reasoning-only"
          ? { reasoning_content: "private reasoning" }
          : model === "blank-text" || model === "length-blank"
            ? { content: " " }
            : { content: replyText };
      events = [
        { choices: [{ delta: { role: "assistant", ...delta } }] },
        {
          choices: [
            {
              delta: {},
              finish_reason: model.startsWith("length-") ? "length" : "stop",
            },
          ],
        },
        "[DONE]",
      ];
      break;
    }
    case "openai_responses":
      events = [
        {
          type: "response.completed",
          response: {
            id: "fixture-response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: replyText }],
              },
            ],
          },
        },
      ];
      break;
    case "anthropic_messages":
      events = [
        {
          type: "message_start",
          message: { id: "fixture", role: "assistant", content: [] },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: replyText },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ];
      break;
    case "google_interactions":
      events = [
        { event_type: "interaction.created", interaction: { id: "fixture" } },
        ...(request.body.model === "continuation"
          ? []
          : [
              {
                event_type: "step.start",
                index: 0,
                step: { type: "model_output" },
              },
              {
                event_type: "step.delta",
                index: 0,
                delta: { type: "text", text: replyText },
              },
              { event_type: "step.stop", index: 0 },
            ]),
        {
          event_type: "interaction.completed",
          interaction:
            request.body.model === "continuation"
              ? {
                  status: "requires_continuation",
                  continuation_token: "another-request",
                }
              : { status: "completed" },
        },
      ];
      break;
  }
  response
    .writeHead(200, { "Content-Type": "text/event-stream" })
    .end(
      events
        .map(
          (event) =>
            `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
}
