import { randomUUID } from "node:crypto";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { TestModelConnectionResult } from "../../protocol/modelConnections.ts";
import { defaultRuntimeToolDefinitionStrategy } from "../prompt/FileNativeToolRegistry.ts";
import {
  FileNativeModelHost,
  type FileNativeModelConnection,
} from "./FileNativeModelAdapters.ts";
import { ModelHostFailureError, type ModelHostExchange } from "./ModelHost.ts";
import { RetryableModelFailure } from "./ModelRetry.ts";
import { isRecord } from "./ProviderValues.ts";

const timeoutMs = 15_000;
const testOutputTokens = 256;
const maxResponseBytes = 1024 * 1024;

type Outcome = TestModelConnectionResult["outcome"];

export async function testModelConnection(
  connection: FileNativeModelConnection,
  locale: AppLocale,
  fetchImplementation: typeof fetch,
): Promise<TestModelConnectionResult> {
  const thinkingBudget = connection.thinkingBudgetTokens ?? 0;
  const chatgptPlan = connection.chatgptPlan !== undefined;
  if (!chatgptPlan && thinkingBudget >= testOutputTokens)
    return { outcome: "thinking_budget_too_large" };
  // Google reports explicit thinking separately from max_output_tokens.
  const maxOutputTokens = chatgptPlan
    ? connection.maxOutputTokens
    : Math.min(
        connection.maxOutputTokens,
        testOutputTokens -
          (connection.provider === "google_interactions" ? thinkingBudget : 0),
      );
  const signal = AbortSignal.timeout(timeoutMs);
  let dispatched = false;
  let status: number | undefined;
  let outputLimit = false;
  let thinkingReceived = false;
  let textReceived = false;
  let googleTerminalStatus: "incomplete" | "requires_continuation" | undefined;
  const fetchOnce: typeof fetch = async (url, init) => {
    if (dispatched) throw new Error("The connection test already dispatched");
    signal.throwIfAborted();
    let options = init;
    if (!chatgptPlan) {
      if (typeof init?.body !== "string")
        throw new Error("The connection test requires an encoded request body");
      const payload = new TextEncoder().encode(init.body);
      const headers = new Headers(init.headers);
      headers.set("Content-Length", String(payload.byteLength));
      // A replayable string lets Node fetch resend a POST after HTTP 421.
      const singleRequest: RequestInit & { duplex: "half" } = {
        ...init,
        headers,
        body: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(payload);
            stream.close();
          },
        }),
        duplex: "half",
        redirect: "manual",
      };
      options = singleRequest;
    }
    dispatched = true;
    const response = await fetchImplementation(url, options);
    status = response.status;
    if (status >= 300 && status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("The connection test does not follow redirects");
    }
    if (!response.ok || response.body === null) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          bytes += chunk.byteLength;
          if (bytes > maxResponseBytes) {
            outputLimit = true;
            stream.error(
              new Error("The connection test response is too large"),
            );
            return;
          }
          stream.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  try {
    const host = new FileNativeModelHost(connection, fetchOnce);
    const response = await host.exchangeOnce(
      testRequest(host, locale, maxOutputTokens),
      {
        signal,
        onDelta(delta) {
          if (delta.text.trim() === "") return;
          if (delta.kind === "reasoning") thinkingReceived = true;
          if (delta.kind === "text") textReceived = true;
        },
        onGoogleHop(hop) {
          if (
            hop.status === "requires_continuation" ||
            hop.status === "incomplete"
          )
            googleTerminalStatus = hop.status;
        },
      },
    );
    if (response.text?.trim()) return { outcome: "success" };
    return {
      outcome:
        thinkingReceived || Boolean(response.reasoningContent?.trim())
          ? "reasoning_only"
          : "no_text",
    };
  } catch (error: unknown) {
    let outcome: Outcome;
    const planFailure =
      chatgptPlan &&
      error instanceof ModelHostFailureError &&
      isRecord(error.details)
        ? error.details.chatgptPlanFailure
        : undefined;
    if (
      error instanceof ModelHostFailureError &&
      isRecord(error.details) &&
      error.details.code === "model_output_limit"
    )
      outcome = textReceived
        ? "success"
        : thinkingReceived
          ? "reasoning_only"
          : "output_limit";
    else if (outputLimit) outcome = "output_limit";
    else if (
      signal.aborted ||
      status === 408 ||
      status === 504 ||
      (error instanceof RetryableModelFailure &&
        error.reason === "connect_timeout")
    )
      outcome = "timeout";
    else if (
      planFailure === "quota" ||
      planFailure === "authentication" ||
      planFailure === "parameters"
    )
      outcome = planFailure;
    else if (planFailure === "unavailable") outcome = "failed";
    else if (googleTerminalStatus === "requires_continuation")
      outcome = "continuation_required";
    else if (googleTerminalStatus === "incomplete")
      outcome = textReceived
        ? "success"
        : thinkingReceived
          ? "reasoning_only"
          : "no_text";
    else if (status === 401 || status === 403) outcome = "authentication";
    else if (status === 404) outcome = "not_found";
    else if (status === 402) outcome = "quota";
    else if (status === 429) outcome = "rate_limit";
    else if (status !== undefined && status >= 300 && status < 400)
      outcome = "redirect";
    else if (status !== undefined && [400, 405, 413, 415, 422].includes(status))
      outcome = "parameters";
    else outcome = dispatched ? "failed" : "invalid_settings";
    return { outcome };
  }
}

function testRequest(
  host: FileNativeModelHost,
  locale: AppLocale,
  maxOutputTokens: number,
): ModelHostExchange {
  const { provider, contextWindowTokens, cacheStrategy } = host.binding();
  return {
    // CLIProxyAPI treats its cache key as an execution-session identity.
    operationId: randomUUID(),
    bootstrap: {
      locale,
      logicalMessages: [],
      provider: { protocol: provider, messages: [] },
      tools: [],
      toolUniverse: [],
      toolStrategy: defaultRuntimeToolDefinitionStrategy(provider),
      coverage: [],
      budget: {
        estimator: "disabled",
        messageTokens: 0,
        toolTokens: 0,
        outputReserveTokens: maxOutputTokens,
        forcedTailReserveTokens: 0,
        safetyMarginTokens: 0,
        requiredTokens: 0,
        contextWindowTokens,
        status: "not_checked",
      },
      cache: {
        strategy: cacheStrategy ?? "provider_managed",
        stablePrefixFingerprint: "model-connection-test",
        breakpoints: [],
        estimatedCacheableBytes: 0,
        firstDynamicByte: 0,
      },
    },
    tools: [],
    appended: [
      {
        kind: "user",
        text: locale === "zh-CN" ? "请简短回复。" : "Reply briefly.",
      },
    ],
    maxOutputTokens,
  };
}
