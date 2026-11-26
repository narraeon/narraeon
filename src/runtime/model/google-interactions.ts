import { modelReasoningPolicyIssue } from "../../protocol/modelConnections.ts";
import {
  bootstrapPrefixEnd,
  leadingSystemOrder,
  renderPromptDeltaMessage,
} from "../prompt/FileNativePromptCompiler.ts";
import { PromptRoleOrderError } from "../prompt/PromptRoleOrderError.ts";
import { RuntimeRequestRejection } from "../RuntimeRequestRejection.ts";
import type { AiExchangeCapture } from "./AiFailureLog.ts";
import { continuationPrompt } from "./AssistantPrefill.ts";
import type {
  FileNativeModelConnection,
  ResolvedFileNativeModelConnection,
} from "./FileNativeModelConnection.ts";
import {
  aggregateGoogleInteractions,
  projectGoogleInteractions,
} from "./GoogleInteractionsStream.ts";
import {
  isModelHostTokenLimitFailure,
  ModelHostFailureError,
  modelHostInputText,
  ModelHostOutcomeUnknownError,
  worldRevisionSystemBoundaryText,
  worldRevisionTransitionText,
  type GoogleHopEvidence,
  type ModelHostExchange,
  type ModelHostExchangeObserver,
  type ModelHostResponse,
  type ModelHostWireRequest,
} from "./ModelHost.ts";
import type { ModelHostDeltaSink } from "./ModelHostStream.ts";
import { ModelResponseFormatError } from "./ModelResponseCorrection.ts";
import {
  hardQuotaFailure,
  RetryableModelFailure,
  retryAfterMs,
} from "./ModelRetry.ts";
import { promptCacheKey } from "./ProviderCache.ts";
import {
  capturedProviderOperation,
  modelDiagnosticContext,
  providerCapture,
} from "./ProviderDiagnostics.ts";
import { validGoogleInteractionsContinuation } from "./ProviderExchangeState.ts";
import { readProviderRejectionBody } from "./ProviderRejection.ts";
import {
  continuationError,
  continuationInput,
  hasFrozenToolPolicy,
  initialWorldContext,
  isProperToolSubset,
  providerAllowedTools,
  providerToolDefinitions,
} from "./ProviderRequest.ts";
import {
  cancelledModelRequest,
  dispatchProviderRequest,
  isProviderEventStream,
  providerRequestPreview,
  providerStreamResult,
  providerUrl,
  signalWasAborted,
  unknownProviderResponse,
  type ProviderDispatch,
} from "./ProviderTransport.ts";
import {
  cloneProviderValue,
  isRecord,
  providerNumber,
  usageRecord,
} from "./ProviderValues.ts";

export const googleExchangeTimeoutMs = 60 * 60 * 1000;

function googleSystemSources(
  request: ModelHostExchange,
): { promptId?: string; sources: string[] }[] {
  const logical = request.bootstrap.logicalMessages.filter(
    (message) =>
      message.role !== "player_input" &&
      (request.bootstrap.provider.preload === undefined ||
        message.role !== "world_context"),
  );
  const ordered = logical.some((message) => message.messageRole !== undefined);
  const { split } = leadingSystemOrder(
    logical.map((message) => ({ role: message.messageRole ?? "system" })),
  );
  const leading = ordered
    ? logical.slice(0, split)
    : logical.filter(
        (message) =>
          message.role === "runtime_system" ||
          message.role === "author_instruction",
      );
  const sources = leading.map((message) => ({
    ...(message.promptId === undefined ? {} : { promptId: message.promptId }),
    sources: message.blocks.map(({ source }) => source),
  }));
  const current = request.worldRevisionBoundaries?.entries.findLast(
    ({ epochId }) =>
      epochId === request.worldRevisionBoundaries?.currentEpochId,
  );
  if (current !== undefined)
    sources.push({
      sources: [
        `runtime:world-revision-epoch:${current.epochId}:system-boundary`,
      ],
    });
  return sources;
}

function googleLateSystemSource(request: ModelHostExchange): string {
  const logical = request.bootstrap.logicalMessages.flatMap((message) =>
    message.role === "player_input" ||
    (request.bootstrap.provider.preload !== undefined &&
      message.role === "world_context")
      ? []
      : [{ message, role: message.messageRole ?? "system" }],
  );
  const first = leadingSystemOrder(logical).conflicts[0]?.message;
  return first === undefined
    ? ""
    : [first.promptId, ...first.blocks.map(({ source }) => source)]
        .filter((item) => item !== undefined)
        .join(", ");
}

function googleRequestHeaders(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "x-goog-api-key": connection.apiKey,
    "Content-Type": "application/json",
    ...(connection.dialect === "cliproxyapi"
      ? { "X-Session-Id": promptCacheKey(connection, request) }
      : {}),
  };
}

function googleThinkingConfig(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  const issue = modelReasoningPolicyIssue({
    provider: connection.provider,
    dialect: connection.dialect,
    modelId: connection.modelId,
    effort: connection.reasoningEffort,
    summary: connection.reasoningSummary,
    thinking: connection.thinkingMode,
    thinkingBudgetTokens: connection.thinkingBudgetTokens,
  });
  if (issue !== null) throw new RuntimeRequestRejection(issue);
  const config: Record<string, unknown> = {};
  if (connection.reasoningEffort !== "provider_default")
    config.thinking_level = connection.reasoningEffort;
  if (connection.reasoningSummary !== "provider_default")
    config.thinking_summaries = connection.reasoningSummary;
  if (connection.thinkingMode !== "provider_default") {
    config.thinking_budget =
      connection.thinkingMode === "adaptive"
        ? -1
        : connection.thinkingMode === "disabled"
          ? 0
          : connection.thinkingBudgetTokens;
  }
  return config;
}

function googleRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
  redactContinuation = false,
): Record<string, unknown> {
  const messages = request.bootstrap.provider.messages;
  const system: string[] = [];
  const input: unknown[] = [];
  let conversationStarted = false;
  const text = (value: string) => [{ type: "text", text: value }];
  const contentText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (
      Array.isArray(value) &&
      value.every(
        (part) =>
          isRecord(part) &&
          part.type === "text" &&
          typeof part.text === "string",
      )
    )
      return value.map((part: { text: string }) => part.text).join("\n\n");
    throw new Error(
      "Google Interactions cannot encode non-text bootstrap content",
    );
  };
  const preload = initialWorldContext(request);
  const appendPreload = () => {
    if (preload !== undefined)
      input.push(
        {
          type: "user_input",
          content: text(preload.notice.content),
        },
        {
          type: "function_call",
          id: preload.callId,
          name: preload.name,
          arguments: {},
        },
        {
          type: "function_result",
          call_id: preload.callId,
          name: preload.name,
          result: text(preload.markdown),
        },
      );
  };
  for (const [index, message] of messages.entries()) {
    if (index === bootstrapPrefixEnd(request.bootstrap)) appendPreload();
    if (message.role === "system") {
      if (conversationStarted) {
        const source = googleLateSystemSource(request);
        throw new PromptRoleOrderError(
          { provider: "google_interactions" },
          `Google Interactions cannot encode System message ${index + 1} after User/Assistant${source ? `: ${source}` : ""}`,
        );
      }
      system.push(contentText(message.content));
    } else {
      conversationStarted = true;
      input.push({
        type: message.role === "user" ? "user_input" : "model_output",
        content: text(contentText(message.content)),
      });
    }
  }
  if (bootstrapPrefixEnd(request.bootstrap) === messages.length)
    appendPreload();
  const calls = new Map<string, string>();
  const boundaries = request.worldRevisionBoundaries;
  const currentBoundary = boundaries?.entries.findLast(
    ({ epochId }) => epochId === boundaries.currentEpochId,
  );
  if (currentBoundary !== undefined)
    system.push(worldRevisionSystemBoundaryText(currentBoundary));
  for (const [itemIndex, item] of request.appended.entries()) {
    if (item.kind === "assistant") {
      if (
        item.providerState?.protocol !== "google_interactions" ||
        !validGoogleInteractionsContinuation(item.providerState.steps)
      )
        throw continuationError("Google Interactions");
      for (const step of item.providerState.steps) {
        if (
          isRecord(step) &&
          step.type === "function_call" &&
          typeof step.id === "string" &&
          typeof step.name === "string"
        )
          calls.set(step.id, step.name);
      }
      for (const message of continuationInput(item))
        input.push({ type: "user_input", content: text(message.content) });
      input.push(
        ...(redactContinuation
          ? item.providerState.steps.map(() => ({
              type: "runtime_redacted_provider_step",
            }))
          : cloneProviderValue(item.providerState.steps)),
      );
    } else if (item.kind === "tool") {
      const name = calls.get(item.toolCallId);
      if (name === undefined)
        throw continuationError("Google Interactions tool result");
      input.push({
        type: "function_result",
        name,
        call_id: item.toolCallId,
        result: text(item.markdown),
        ...(item.isError === true ? { is_error: true } : {}),
      });
    } else if (item.kind === "prompt_delta") {
      const boundary = boundaries?.entries.find(
        (entry) => entry.itemIndex === itemIndex,
      );
      if (boundary !== undefined) {
        const message = item.logicalMessages[0];
        if (
          item.logicalMessages.length !== 1 ||
          message?.role !== "runtime_system" ||
          message.markdown !== boundary.markdown ||
          message.blocks.length !== 1 ||
          message.blocks[0]?.source !==
            `runtime:world-revision-epoch:${boundary.epochId}` ||
          message.blocks[0]?.markdown !== boundary.markdown
        )
          throw new Error("Invalid Runtime world-revision epoch boundary");
        input.push({
          type: "user_input",
          content: text(worldRevisionTransitionText(boundary.markdown)),
        });
        continue;
      }
      for (const message of item.logicalMessages)
        input.push({
          type: "user_input",
          content: text(
            renderPromptDeltaMessage(message.role, message.markdown),
          ),
        });
    } else
      input.push({
        type: "user_input",
        content: text(modelHostInputText(item)),
      });
  }
  if (request.assistantPrefill?.mode === "prompt")
    input.push({
      type: "user_input",
      content: text(
        continuationPrompt(
          request.assistantPrefill.text,
          request.assistantPrefill.instruction,
        ),
      ),
    });
  const tools = providerToolDefinitions(request);
  const allowedTools = providerAllowedTools(request);
  let toolChoice: unknown;
  if (hasFrozenToolPolicy(request)) {
    if (allowedTools.length === 0) toolChoice = "none";
    else if (isProperToolSubset(allowedTools, tools))
      toolChoice = { allowed_tools: { mode: "auto", tools: allowedTools } };
  }
  return {
    model: connection.modelId,
    store: false,
    stream: true,
    ...(system.length === 0 ? {} : { system_instruction: system.join("\n\n") }),
    input,
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }),
    generation_config: {
      max_output_tokens: request.maxOutputTokens,
      ...googleThinkingConfig(connection),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    },
  };
}

function googleDiagnosticPath(connection: FileNativeModelConnection): string {
  const url = providerUrl(connection);
  return containsGoogleCredential(url.pathname, connection.apiKey)
    ? ""
    : url.pathname;
}

function googleDiagnosticEndpoint(
  connection: FileNativeModelConnection,
): string {
  const url = providerUrl(connection);
  const endpoint = `${url.protocol}//${url.host}${googleDiagnosticPath(connection)}`;
  return containsGoogleCredential(endpoint, connection.apiKey) ? "" : endpoint;
}

function containsGoogleCredential(value: string, key: string): boolean {
  if (key === "") return false;
  const needle = key.toLowerCase();
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    if (
      current.toLowerCase().includes(needle) ||
      current.toLowerCase().includes(encodeURIComponent(key).toLowerCase())
    )
      return true;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      return true;
    }
  }
  return false;
}

/** Classify a first-hop rejection in memory; never retain the provider's echo. */
async function googleInitialRejection(response: Response): Promise<Error> {
  if (
    ![400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)
  ) {
    discardGoogleErrorBody(response);
    return new ModelHostOutcomeUnknownError(
      "Google Interactions request outcome could not be confirmed",
    );
  }
  const body = await readProviderRejectionBody(response);
  if (body === null)
    return new ModelHostOutcomeUnknownError(
      "Google Interactions request outcome could not be confirmed",
    );
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const rejection = googleRejectionEvidence(
    body,
    contentType === "application/json" ||
      contentType?.endsWith("+json") === true,
  );
  if (rejection === null)
    return new ModelHostOutcomeUnknownError(
      "Google Interactions request outcome could not be confirmed",
    );
  const { evidence } = rejection;
  if (response.status === 429 && hardQuotaFailure(evidence))
    return new ModelHostFailureError(
      "Google Interactions hard quota exhausted",
      { details: { code: "hard_quota_exhausted", httpStatus: 429 } },
    );
  if (
    response.status === 429 &&
    !isModelHostTokenLimitFailure(new ModelHostFailureError(evidence))
  )
    return new RetryableModelFailure(
      "rate_limit",
      retryAfterMs(response.headers.get("retry-after")),
      rejection.googleStatus === undefined
        ? undefined
        : `Google Interactions HTTP 429: ${rejection.googleStatus}`,
    );
  return isModelHostTokenLimitFailure(new ModelHostFailureError(evidence))
    ? new ModelHostFailureError("Google Interactions context limit exceeded", {
        details: { code: "context_length_exceeded" },
      })
    : new ModelHostFailureError("Google Interactions request was rejected");
}

function discardGoogleErrorBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Discarding an optional error body must not alter the request outcome.
  }
}

function googleRejectionEvidence(
  body: string,
  requireJson: boolean,
): { evidence: string; googleStatus?: string } | null {
  if (body.trim() === "") return null;
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload === "string")
      return payload.trim() === "" ? null : { evidence: payload };
    if (!isRecord(payload)) return null;
    const error = isRecord(payload.error) ? payload.error : {};
    const evidence = [
      error.message,
      error.code,
      error.reason,
      payload.message,
      payload.code,
      payload.error,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (evidence.trim() === "") return null;
    // Google can echo opaque input in error.message. Only its recognized
    // structured rate-limit status can leave this classification boundary.
    return error.status === "RESOURCE_EXHAUSTED"
      ? { evidence, googleStatus: error.status }
      : { evidence };
  } catch {
    const trimmed = body.trimStart();
    return requireJson || trimmed.startsWith("{") || trimmed.startsWith("[")
      ? null
      : { evidence: body };
  }
}

function safeGoogleUsage(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const field of [
    "total_input_tokens",
    "total_cached_tokens",
    "total_thought_tokens",
    "total_output_tokens",
    "total_tool_use_tokens",
    "total_tokens",
  ]) {
    const count = value[field];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      result[field] = count;
  }
  return result;
}

export async function exchangeGoogle(
  dispatch: ProviderDispatch,
  request: ModelHostExchange,
  observer?: ModelHostExchangeObserver,
  deadline = Date.now() + googleExchangeTimeoutMs,
): Promise<ModelHostResponse> {
  const onDelta = observer?.onDelta;
  const signal = observer?.signal;
  const { connection, failureLog } = dispatch;
  const retainLateExtensionResponse =
    observer?.retainLateExtensionResponse === true;
  const onGoogleHop = observer?.onGoogleHop;
  const diagnosticAttempt = observer?.diagnosticAttempt;
  const controller = new AbortController();
  const capture = providerCapture(
    failureLog,
    connection.provider,
    providerUrl(connection),
    {
      ...modelDiagnosticContext(request),
      ...(diagnosticAttempt === undefined
        ? {}
        : { requestAttempt: diagnosticAttempt }),
    },
    JSON.stringify(googleRequestBody(connection, request, true)),
    googleDiagnosticEndpoint(connection),
  );
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      googleWithinDeadline(
        dispatch,
        request,
        (delta) => {
          if (!controller.signal.aborted) onDelta?.(delta);
        },
        controller.signal,
        retainLateExtensionResponse,
        onGoogleHop,
        diagnosticAttempt,
        capture,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            if (capture !== undefined && failureLog !== undefined) {
              void failureLog
                .recordFailure({
                  exchange: capture.snapshot(),
                  failures: [
                    {
                      kind: "provider_transport",
                      message:
                        "Google Interactions exceeded its total time limit",
                    },
                  ],
                })
                .catch(() => {
                  // Failure logging is best effort and cannot delay the timeout.
                });
            }
            reject(
              new ModelHostOutcomeUnknownError(
                "Google Interactions exceeded its total time limit",
              ),
            );
          },
          Math.max(0, deadline - Date.now()),
        );
      }),
      new Promise<never>((_, reject) => {
        abort = () => {
          controller.abort();
          if (!retainLateExtensionResponse) reject(cancelledModelRequest());
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function googleWithinDeadline(
  {
    connection,
    fetchImplementation,
    failureLog,
    singleRequest,
  }: ProviderDispatch,
  request: ModelHostExchange,
  onDelta: ModelHostDeltaSink | undefined,
  signal: AbortSignal,
  retainLateExtensionResponse: boolean,
  onGoogleHop?: ModelHostExchangeObserver["onGoogleHop"],
  diagnosticAttempt?: number,
  capture?: AiExchangeCapture,
): Promise<ModelHostResponse> {
  const bodyJson = JSON.stringify(googleRequestBody(connection, request));
  const frozenBody = JSON.parse(bodyJson) as Record<string, unknown>;
  const url = providerUrl(connection);
  const preview = previewGoogle(connection, request, true);
  const evidence: GoogleHopEvidence[] = [];
  const report = (hop: GoogleHopEvidence) => {
    capture?.setGoogleHops(evidence);
    const snapshot = structuredClone(hop);
    try {
      void Promise.resolve(onGoogleHop?.(snapshot)).catch(() => {
        // Optional diagnostics cannot affect the model request.
      });
    } catch {
      // Synchronous observers are optional diagnostics too.
    }
  };
  signal.addEventListener(
    "abort",
    () => {
      const hop = evidence.at(-1);
      if (hop?.status === "attempted") {
        hop.status = "interrupted";
        void report(hop);
      }
    },
    { once: true },
  );
  return capturedProviderOperation(
    failureLog,
    capture,
    async (observe) => {
      const steps: Record<string, unknown>[] = [];
      const usages: unknown[] = [];
      const seenTokens = new Set<string>();
      let token: string | undefined;
      let payload: Awaited<ReturnType<typeof aggregateGoogleInteractions>>;
      do {
        if (signal.aborted) throw cancelledModelRequest();
        const hop: GoogleHopEvidence = {
          exchange: request.exchange ?? 1,
          attempt: diagnosticAttempt ?? request.requestAttempt ?? 1,
          hop: evidence.length + 1,
          tokenSupplied: token !== undefined,
          status: "attempted",
          ...(token === undefined ? { request: preview } : {}),
        };
        evidence.push(hop);
        try {
          const dispatched = dispatchProviderRequest(
            fetchImplementation,
            url,
            {
              method: "POST",
              headers: googleRequestHeaders(connection, request),
              redirect: "error",
              body:
                token === undefined
                  ? bodyJson
                  : JSON.stringify({
                      ...frozenBody,
                      continuation_token: token,
                    }),
              ...(signal === undefined ? {} : { signal }),
            },
            "Google Interactions",
          );
          void dispatched.catch(() => {
            // The same rejection is classified after the diagnostic write.
          });
          void report(hop);
          const response = await dispatched;
          hop.httpStatus = response.status;
          observe(new Response(null, { status: response.status }));
          if (signal.aborted && !retainLateExtensionResponse)
            throw cancelledModelRequest();
          if (!response.ok) {
            hop.status = "rejected";
            void report(hop);
            if (token !== undefined) {
              discardGoogleErrorBody(response);
              throw new ModelHostOutcomeUnknownError(
                "A later Google Interactions continuation request failed after earlier progress",
              );
            }
            throw await googleInitialRejection(response);
          }
          if (!isProviderEventStream(response)) {
            discardGoogleErrorBody(response);
            throw unknownProviderResponse("Google Interactions");
          }
          payload = await providerStreamResult(
            response,
            "Google Interactions",
            (body) =>
              aggregateGoogleInteractions(body, onDelta, (raw) => {
                const usage = safeGoogleUsage(raw);
                if (usage !== null) {
                  hop.usage = usage;
                  void report(hop);
                }
              }),
            signal,
          );
          const safeUsage = safeGoogleUsage(payload.usage);
          if (safeUsage !== null) hop.usage = safeUsage;
          if (
            (token !== undefined ||
              payload.status === "requires_continuation") &&
            !payload.completeLifecycle
          )
            throw new ModelHostOutcomeUnknownError(
              "Google Interactions continuation stream lifecycle is incomplete",
            );
          steps.push(...payload.steps);
          usages.push(safeUsage);
          hop.status =
            payload.status === "completed" ||
            payload.status === "requires_action" ||
            payload.status === "requires_continuation" ||
            payload.status === "failed" ||
            payload.status === "cancelled" ||
            payload.status === "incomplete"
              ? payload.status
              : "interrupted";
          void report(hop);
          if (payload.status === "requires_continuation") {
            if (singleRequest)
              throw new ModelHostOutcomeUnknownError(
                "Google Interactions requested a continuation after the connection test",
              );
            if (signal.aborted) throw cancelledModelRequest();
            if (
              typeof payload.continuationToken !== "string" ||
              !payload.continuationToken ||
              seenTokens.has(payload.continuationToken) ||
              usages.length >= 16
            )
              throw new ModelHostOutcomeUnknownError(
                "Google Interactions continuation cannot proceed safely",
              );
            token = payload.continuationToken;
            seenTokens.add(token);
          }
        } catch (error: unknown) {
          if (hop.status === "attempted") {
            hop.status = "interrupted";
            void report(hop);
          }
          if (token !== undefined && error instanceof RetryableModelFailure)
            throw new ModelHostOutcomeUnknownError(
              "Google continuation failed after progress",
            );
          throw error;
        }
      } while (payload.status === "requires_continuation");
      payload.steps = steps;
      if (signalWasAborted(signal) && !retainLateExtensionResponse)
        throw cancelledModelRequest();
      const projection = projectGoogleInteractions(payload);
      const total = (field: string): number | null => {
        let sum = 0;
        for (const raw of usages) {
          const value = isRecord(raw) ? providerNumber(raw[field]) : null;
          if (value === null) return null;
          sum += value;
        }
        return Number.isSafeInteger(sum) ? sum : null;
      };
      return {
        ...projection,
        usage: {
          ...usageRecord(
            {
              inputTokens: total("total_input_tokens"),
              uncachedInputTokens: null,
              cacheReadTokens: total("total_cached_tokens"),
              cacheWriteTokens: null,
              reasoningTokens: total("total_thought_tokens"),
              outputTokens: total("total_output_tokens"),
              totalTokens: total("total_tokens"),
            },
            usages.length > 1
              ? [
                  "inputTokens",
                  "cacheReadTokens",
                  "reasoningTokens",
                  "outputTokens",
                  "totalTokens",
                ]
              : [],
          ),
          accounting: "google_interactions" as const,
          ...(usages.length > 1
            ? {
                providerRaw: {
                  hops: usages.map((usage) =>
                    isRecord(usage) ? structuredClone(usage) : null,
                  ),
                },
              }
            : isRecord(usages[0])
              ? { providerRaw: structuredClone(usages[0]) }
              : {}),
        },
      };
    },
    sanitizeGoogleError,
  );
}

function sanitizeGoogleError(error: unknown): unknown {
  if (
    error instanceof ModelResponseFormatError ||
    error instanceof RetryableModelFailure
  )
    return error;
  if (error instanceof ModelHostFailureError) {
    if (hardQuotaFailure(error.message))
      return new ModelHostFailureError(
        "Google Interactions hard quota exhausted",
        { details: { code: "hard_quota_exhausted", httpStatus: 429 } },
      );
    if (isModelHostTokenLimitFailure(error))
      return new ModelHostFailureError(
        "Google Interactions context limit exceeded",
        { details: { code: "context_length_exceeded" } },
      );
    return new ModelHostFailureError(
      "Google Interactions request was rejected",
    );
  }
  return new ModelHostOutcomeUnknownError(
    "Google Interactions request outcome could not be confirmed",
  );
}

export function previewGoogle(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
  redactContinuation: boolean,
): ModelHostWireRequest {
  const body = googleRequestBody(connection, request, redactContinuation);
  return {
    ...providerRequestPreview(
      connection,
      googleRequestHeaders(connection, request),
      body,
      googleDiagnosticPath(connection),
    ),
    ...(redactContinuation
      ? { redactedProviderContinuation: true as const }
      : {}),
    systemInstructionSources: googleSystemSources(request),
  };
}
