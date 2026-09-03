import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  FileNativeAiFailureLog,
  type AiExchangeDiagnostics,
} from "../../src/runtime/model/AiFailureLog.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Provider 流格式失败会自动保存原始 request、response 与已返回 reasoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ai-failure-log-"));
  roots.push(root);
  const logRoot = join(root, "logs");
  const rawResponse = [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "Check the tool arguments first.",
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: "invalid" })}\n\n`,
  ].join("");
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(rawResponse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const host = new FileNativeModelHost(
    {
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1?secret=must-not-be-logged",
      apiKey: "top-secret-api-key",
      modelId: "failure-log-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
    new FileNativeAiFailureLog(logRoot),
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "failure-log-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "Check the failure log.",
      playerInputPlacement: "bootstrap",
    }),
  );

  await expect(
    host.exchange({
      bootstrap,
      tools: bootstrap.tools,
      appended: [],
      requestId: "failure-log-request",
      operationId: "failure-log-operation",
      requestAttempt: 1,
      exchange: 3,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow(
    "Chat Completions was dispatched but its streaming response could not be confirmed",
  );

  const entries = await readOnlyFailure(logRoot);
  expect(entries[0]).toMatchObject({
    type: "incident",
    format: "narraeon.ai-failure-log/v1",
  });
  expect(entries[1]).toMatchObject({
    type: "exchange",
    exchange: {
      provider: "chat_completions",
      endpoint: "https://provider.invalid/v1/chat/completions",
      context: {
        scope: "model_host",
        requestId: "failure-log-request",
        operationId: "failure-log-operation",
        requestAttempt: 1,
        exchange: 3,
      },
      request: { method: "POST", contentType: "application/json" },
      response: {
        status: 200,
        contentType: "text/event-stream",
        body: rawResponse,
      },
      reasoning: "Check the tool arguments first.",
    },
  });
  expect(entries[2]).toMatchObject({
    type: "failure",
    failures: [
      {
        kind: "provider_response_format",
        message:
          "Chat Completions was dispatched but its streaming response could not be confirmed",
      },
    ],
  });
  const request = JSON.parse(
    (
      entries[1] as {
        exchange: { request: { body: string } };
      }
    ).exchange.request.body,
  ) as { messages: unknown };
  expect(JSON.stringify(request.messages)).toContain("Check the failure log.");
  const serialized = JSON.stringify(entries);
  expect(serialized).not.toContain("top-secret-api-key");
  expect(serialized).not.toContain("must-not-be-logged");

  const [name] = (await readdir(logRoot)).filter((value) =>
    value.endsWith(".jsonl"),
  );
  expect((await stat(join(logRoot, name!))).mode & 0o777).toBe(0o600);
});

test("Provider SSE 明确拒绝会保存可读消息与结构化错误详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ai-sse-rejection-"));
  roots.push(root);
  const logRoot = join(root, "logs");
  const rawResponse = [
    "event: error\n",
    `data: ${JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Provider capacity is exhausted",
      },
      request_id: "req-failure-log",
    })}\n\n`,
  ].join("");
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(rawResponse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const host = new FileNativeModelHost(
    {
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "top-secret-api-key",
      modelId: "failure-log-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    fetch_,
    new FileNativeAiFailureLog(logRoot),
  );
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "anthropic_messages",
      modelId: "failure-log-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "Check the explicit SSE failure.",
      playerInputPlacement: "bootstrap",
    }),
  );

  await expect(
    host.exchange({
      bootstrap,
      tools: bootstrap.tools,
      appended: [],
      requestId: "failure-log-request",
      operationId: "failure-log-operation",
      requestAttempt: 1,
      exchange: 1,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow(
    "Anthropic SSE error: overloaded_error: Provider capacity is exhausted (request_id: req-failure-log)",
  );

  const entries = await readOnlyFailure(logRoot);
  expect(entries[1]).toMatchObject({
    type: "exchange",
    exchange: {
      provider: "anthropic_messages",
      response: { body: rawResponse, bodyComplete: true },
    },
  });
  expect(entries[2]).toMatchObject({
    type: "failure",
    failures: [
      {
        kind: "provider_rejection",
        message:
          "Anthropic SSE error: overloaded_error: Provider capacity is exhausted (request_id: req-failure-log)",
        details: {
          provider: "anthropic_messages",
          eventType: "error",
          type: "overloaded_error",
          message: "Provider capacity is exhausted",
          requestId: "req-failure-log",
        },
      },
    ],
  });
});

test("错误后的记录窗口跨 Runtime 重建继续，修复成功后才关闭", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ai-failure-window-"));
  roots.push(root);
  const first = new FileNativeAiFailureLog(root);
  await first.recordFailure({
    exchange: exchange("capture-before-error", 1, "错误响应"),
    failures: [
      {
        kind: "tool_execution",
        message: "工具参数未通过检查。",
      },
    ],
  });

  const recovered = new FileNativeAiFailureLog(root);
  const repaired = exchange("capture-after-error", 2, "修复响应");
  await recovered.recordExchangeIfActive(repaired);
  await recovered.resolve({
    exchange: repaired,
    message: "后续交换已经修复。",
  });

  const entries = await readOnlyFailure(root);
  expect(
    entries
      .filter(({ type }) => type === "exchange")
      .map(
        ({ exchange: value }) =>
          (value as AiExchangeDiagnostics).response?.body,
      ),
  ).toEqual(["错误响应", "修复响应"]);
  expect(entries.at(-1)).toMatchObject({
    type: "resolved",
    message: "后续交换已经修复。",
  });
});

test("没有错误的成功交换不会创建诊断日志", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ai-success-log-"));
  roots.push(root);
  const logRoot = join(root, "ai-failures");

  await new FileNativeAiFailureLog(logRoot).recordExchangeIfActive(
    exchange("capture-success-only", 1, "成功响应"),
  );

  await expect(readdir(logRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

async function readOnlyFailure(
  root: string,
): Promise<Record<string, unknown>[]> {
  const names = (await readdir(root)).filter((value) =>
    value.endsWith(".jsonl"),
  );
  expect(names).toHaveLength(1);
  return (await readFile(join(root, names[0]!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function exchange(
  captureId: string,
  sequence: number,
  responseBody: string,
): AiExchangeDiagnostics {
  return {
    captureId,
    provider: "chat_completions",
    endpoint: "https://provider.invalid/v1/chat/completions",
    context: {
      scope: "play_call_chain",
      requestId: "play_call_chain",
      operationId: "persistent-failure-window",
      requestAttempt: 1,
      exchange: sequence,
    },
    request: {
      method: "POST",
      contentType: "application/json",
      body: `{"exchange":${String(sequence)}}`,
    },
    response: {
      status: 200,
      statusText: "OK",
      contentType: "text/event-stream",
      body: responseBody,
      bodyComplete: true,
    },
  };
}
