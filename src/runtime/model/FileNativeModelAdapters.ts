import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  hasCLIProxyThinkingSuffix,
  modelReasoningPolicyIssue,
  type ModelProviderDialect,
  type ModelReasoningEffort,
  type ModelReasoningSummary,
  type ModelThinkingMode,
} from "../../protocol/modelConnections.ts";

import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostCacheStrategy,
  ModelHostExchangeObserver,
  ModelHostExchange,
  ModelHostToolCall,
  ModelHostUsage,
  ModelHostWireRequest,
  ModelHostResponse,
  GoogleHopEvidence,
} from "./ModelHost.ts";
import {
  assertModelOutputComplete,
  ModelHostBindingMismatchError,
  ModelHostCancelledError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "./ModelHost.ts";
import {
  renderPromptDeltaMessage,
  type FileNativePromptInput,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  validGoogleInteractionsContinuation,
  type ProviderExchangeState,
} from "./ProviderExchangeState.ts";
import {
  aggregateGoogleInteractions,
  projectGoogleInteractions,
} from "./GoogleInteractionsStream.ts";
import {
  aggregateAnthropicModelStream,
  aggregateChatModelStream,
  aggregateResponsesModelStream,
  type ModelHostDeltaSink,
} from "./ModelHostStream.ts";
import {
  defaultRuntimeToolDefinitionStrategy,
  portableRuntimeToolInputSchema,
  type RuntimeToolDefinitionStrategy,
} from "../prompt/FileNativeToolRegistry.ts";
import {
  AiExchangeCapture,
  errorDescription,
  type AiExchangeDiagnostics,
  type AiFailureDescription,
  type AiFailureRecorder,
} from "./AiFailureLog.ts";

export interface FileNativeModelConnection {
  provider: FileNativePromptInput["modelBinding"]["provider"];
  dialect?: ModelProviderDialect;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  reasoningEffort?: ModelReasoningEffort;
  reasoningSummary?: ModelReasoningSummary;
  thinkingMode?: ModelThinkingMode;
  thinkingBudgetTokens?: number | null;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /**
   * Places the transcript breakpoint before the request-level suffix. Live
   * connections default to on; frozen requests record their own choice.
   */
  cacheSuffixBreakpoint?: boolean;
}

interface ResolvedFileNativeModelConnection extends Omit<
  FileNativeModelConnection,
  | "dialect"
  | "reasoningEffort"
  | "reasoningSummary"
  | "thinkingMode"
  | "thinkingBudgetTokens"
  | "cacheSuffixBreakpoint"
> {
  dialect: ModelProviderDialect;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  thinkingMode: ModelThinkingMode;
  thinkingBudgetTokens: number | null;
  cacheSuffixBreakpoint: boolean;
}

/** Anthropic allows four cache_control breakpoints per request. */
const explicitCacheBreakpointLimit = 4;

const providerContinuationCodecVersion = 1;

function resolveConnection(
  connection: FileNativeModelConnection,
): ResolvedFileNativeModelConnection {
  const resolved = structuredClone({
    ...connection,
    dialect: connection.dialect ?? "standard",
    reasoningEffort: connection.reasoningEffort ?? "provider_default",
    reasoningSummary: connection.reasoningSummary ?? "provider_default",
    thinkingMode: connection.thinkingMode ?? "provider_default",
    thinkingBudgetTokens: connection.thinkingBudgetTokens ?? null,
    cacheSuffixBreakpoint: connection.cacheSuffixBreakpoint ?? true,
  });
  const issue = modelReasoningPolicyIssue({
    provider: resolved.provider,
    dialect: resolved.dialect,
    modelId: resolved.modelId,
    effort: resolved.reasoningEffort,
    summary: resolved.reasoningSummary,
    thinking: resolved.thinkingMode,
    thinkingBudgetTokens: resolved.thinkingBudgetTokens,
    maxOutputTokens: resolved.maxOutputTokens,
  });
  if (issue !== null) throw new Error(issue);
  return resolved;
}

function modelCacheStrategy(
  connection: ResolvedFileNativeModelConnection,
): ModelHostCacheStrategy {
  if (connection.provider === "anthropic_messages")
    return "explicit_anthropic_blocks";
  if (connection.dialect === "cliproxyapi")
    return "explicit_cliproxyapi_message";
  return "provider_managed";
}

export class FileNativeModelHost implements ModelHost {
  readonly #connection: ResolvedFileNativeModelConnection;
  readonly #fetch: typeof fetch;
  readonly #failureLog: AiFailureRecorder | undefined;

  constructor(
    connection: FileNativeModelConnection,
    fetchImplementation: typeof fetch = fetch,
    failureLog?: AiFailureRecorder,
  ) {
    this.#connection = resolveConnection(connection);
    this.#fetch = fetchImplementation;
    this.#failureLog = failureLog;
  }

  binding(): ModelHostBinding {
    const { provider, modelId, contextWindowTokens, maxOutputTokens } =
      this.#connection;
    return {
      provider,
      modelId,
      contextWindowTokens,
      maxOutputTokens,
      cacheStrategy: modelCacheStrategy(this.#connection),
      endpointFingerprint: createHash("sha256")
        .update(`${provider}\0${this.#connection.baseUrl}`)
        .digest("hex"),
      protocolConfigFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            provider,
            stream: true,
            toolChoice: "runtime_strategy",
            responseStorage:
              provider === "openai_responses" ? "disabled" : "provider_default",
            encryptedReasoningContinuation:
              provider === "openai_responses" ? "included" : "not_requested",
            anthropicVersion:
              provider === "anthropic_messages" ? "2023-06-01" : null,
            ...(provider === "google_interactions"
              ? {
                  interactionsEndpoint: providerUrl(this.#connection).pathname,
                  apiRevision: null,
                  store: false,
                }
              : {}),
            dialect: this.#connection.dialect,
            reasoningEffort: this.#connection.reasoningEffort,
            reasoningSummary: this.#connection.reasoningSummary,
            thinkingMode: this.#connection.thinkingMode,
            thinkingBudgetTokens: this.#connection.thinkingBudgetTokens,
            cachePolicy: modelCacheStrategy(this.#connection),
            providerContinuationCodecVersion,
          }),
        )
        .digest("hex"),
    };
  }

  freezeRequest(request: ModelHostExchange): ModelHostExchange {
    const frozen = structuredClone(request);
    if (frozen.modelConfig === undefined) {
      const {
        baseUrl: _baseUrl,
        apiKey: _apiKey,
        ...config
      } = this.#connection;
      void _baseUrl;
      void _apiKey;
      frozen.modelConfig = config;
    }
    return frozen;
  }

  #requestHost(request: ModelHostExchange): FileNativeModelHost {
    if (request.modelConfig === undefined) return this;
    if (request.modelConfig.provider !== this.#connection.provider)
      throw new ModelHostBindingMismatchError(
        "The request protocol does not match the selected model host",
      );
    return new FileNativeModelHost(
      {
        ...request.modelConfig,
        // A frozen request without this choice predates the transcript breakpoint.
        cacheSuffixBreakpoint:
          request.modelConfig.cacheSuffixBreakpoint === true,
        baseUrl: this.#connection.baseUrl,
        apiKey: this.#connection.apiKey,
      },
      this.#fetch,
      this.#failureLog,
    );
  }

  exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    return this.#requestHost(request).#exchange(request, observer);
  }

  async #exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    assertExchangeCompatibility(this.#connection, request);
    await trace("model_host_exchange", modelHostTrace(request));
    const signal = observer?.signal;
    if (signalWasAborted(signal)) throw cancelledModelRequest();
    try {
      if (this.#connection.provider === "chat_completions")
        return await this.#chat(request, observer?.onDelta, signal);
      if (this.#connection.provider === "openai_responses")
        return await this.#responses(request, observer?.onDelta, signal);
      if (this.#connection.provider === "google_interactions")
        return await this.#google(
          request,
          observer?.onDelta,
          signal,
          observer?.retainLateExtensionResponse === true,
          observer?.onGoogleHop,
          observer?.diagnosticAttempt,
        );
      return await this.#anthropic(request, observer?.onDelta, signal);
    } catch (error: unknown) {
      if (
        signalWasAborted(signal) &&
        !(error instanceof ModelHostCancelledError)
      )
        throw cancelledModelRequest(error);
      throw error;
    }
  }

  /** Uses the production encoders and deliberately omits credentials. */
  previewRequest(request: ModelHostExchange): ModelHostWireRequest {
    return this.#requestHost(request).#previewRequest(
      request,
      this.#connection.provider === "google_interactions",
    );
  }

  previewAuthoringRequest(request: ModelHostExchange): ModelHostWireRequest {
    return this.#requestHost(request).#previewRequest(request, true);
  }

  #previewRequest(
    request: ModelHostExchange,
    redactContinuation = false,
  ): ModelHostWireRequest {
    assertExchangeCompatibility(this.#connection, request);
    const provider = this.#connection.provider;
    const body =
      provider === "chat_completions"
        ? chatRequestBody(this.#connection, request)
        : provider === "openai_responses"
          ? responsesRequestBody(
              responsesRequestInput(this.#connection, request),
            )
          : provider === "google_interactions"
            ? googleRequestBody(this.#connection, request, redactContinuation)
            : anthropicRequestBody(this.#connection, request);
    return {
      provider,
      method: "POST",
      endpointPath:
        provider === "google_interactions"
          ? googleDiagnosticPath(this.#connection)
          : providerUrl(this.#connection).pathname,
      headerNames:
        provider === "anthropic_messages"
          ? ["Accept", "anthropic-version", "x-api-key", "Content-Type"]
          : provider === "google_interactions"
            ? ["Accept", "x-goog-api-key", "Content-Type"]
            : ["Accept", "Authorization", "Content-Type"],
      body: cloneProviderValue(body),
      ...(provider === "google_interactions" && redactContinuation
        ? { redactedProviderContinuation: true as const }
        : {}),
      ...(provider === "google_interactions"
        ? { systemInstructionSources: googleSystemSources(request) }
        : {}),
    };
  }

  async #responses(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
    signal?: AbortSignal,
  ): Promise<ModelHostResponse> {
    return openAIResponsesRequest({
      ...responsesRequestInput(this.#connection, request),
      fetchImplementation: this.#fetch,
      tracePrefix: "responses",
      ...(this.#failureLog === undefined
        ? {}
        : { failureLog: this.#failureLog }),
      diagnosticContext: modelDiagnosticContext(request),
      ...(onDelta === undefined ? {} : { onDelta }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #google(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
    signal?: AbortSignal,
    retainLateExtensionResponse = false,
    onGoogleHop?: ModelHostExchangeObserver["onGoogleHop"],
    diagnosticAttempt?: number,
  ): Promise<ModelHostResponse> {
    const controller = new AbortController();
    const capture = providerCapture(
      this.#failureLog,
      this.#connection.provider,
      providerUrl(this.#connection),
      {
        ...modelDiagnosticContext(request),
        ...(diagnosticAttempt === undefined
          ? {}
          : { requestAttempt: diagnosticAttempt }),
      },
      JSON.stringify(googleRequestBody(this.#connection, request, true)),
      googleDiagnosticEndpoint(this.#connection),
    );
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#googleWithinDeadline(
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
              if (capture !== undefined && this.#failureLog !== undefined) {
                void this.#failureLog
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
            60 * 60 * 1000,
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

  async #googleWithinDeadline(
    request: ModelHostExchange,
    onDelta: ModelHostDeltaSink | undefined,
    signal: AbortSignal,
    retainLateExtensionResponse: boolean,
    onGoogleHop?: ModelHostExchangeObserver["onGoogleHop"],
    diagnosticAttempt?: number,
    capture?: AiExchangeCapture,
  ): Promise<ModelHostResponse> {
    const bodyJson = JSON.stringify(
      googleRequestBody(this.#connection, request),
    );
    const frozenBody = JSON.parse(bodyJson) as Record<string, unknown>;
    const url = providerUrl(this.#connection);
    const preview = this.#previewRequest(request, true);
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
      this.#failureLog,
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
              this.#fetch,
              url,
              {
                method: "POST",
                headers: {
                  Accept: "text/event-stream",
                  "x-goog-api-key": this.#connection.apiKey,
                  "Content-Type": "application/json",
                },
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
              if (token !== undefined)
                throw new ModelHostOutcomeUnknownError(
                  "A later Google Interactions continuation request failed after earlier progress",
                );
              throw new ModelHostFailureError(
                `Google Interactions request failed: HTTP ${response.status}`,
              );
            }
            if (!isProviderEventStream(response))
              throw unknownProviderResponse("Google Interactions");
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
      true,
    );
  }

  async #chat(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
    signal?: AbortSignal,
  ): Promise<ModelHostResponse> {
    const body = chatRequestBody(this.#connection, request);
    const bodyJson = JSON.stringify(body);
    await trace("chat_request", body);
    const url = providerUrl(this.#connection);
    const capture = providerCapture(
      this.#failureLog,
      this.#connection.provider,
      url,
      modelDiagnosticContext(request),
      bodyJson,
    );
    const diagnosticDelta = captureDelta(capture, onDelta);
    return capturedProviderOperation(
      this.#failureLog,
      capture,
      async (observe) => {
        const response = observe(
          await dispatchProviderRequest(
            this.#fetch,
            url,
            {
              method: "POST",
              headers: {
                Accept: "text/event-stream",
                Authorization: `Bearer ${this.#connection.apiKey}`,
                "Content-Type": "application/json",
              },
              body: bodyJson,
              ...(signal === undefined ? {} : { signal }),
            },
            "Chat Completions",
          ),
        );
        if (!response.ok) throw await providerError(response);
        if (isProviderEventStream(response)) {
          const streamed = await providerStreamResult(
            response,
            "Chat Completions",
            (body) => aggregateChatModelStream(body, diagnosticDelta),
            signal,
          );
          capture?.setReasoning(streamed.reasoningContent);
          await trace("chat_response", streamed);
          return {
            ...(streamed.content === "" ? {} : { text: streamed.content }),
            ...(streamed.reasoningContent === ""
              ? {}
              : { reasoningContent: streamed.reasoningContent }),
            providerState: {
              protocol: "chat_completions" as const,
              assistantMessage: cloneProviderValue(streamed.assistantMessage),
            },
            usage: normalizeChatUsage(streamed.usage),
            ...(streamed.stopReason === undefined
              ? {}
              : { stopReason: streamed.stopReason }),
            toolCalls: streamed.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: parseArguments(call.arguments),
            })),
          };
        }
        const rawPayload = await providerJson(response, "Chat Completions");
        if (
          !isRecord(rawPayload) ||
          !Array.isArray(rawPayload.choices) ||
          !isRecord(rawPayload.choices[0]) ||
          !isRecord(rawPayload.choices[0].message)
        )
          throw unknownProviderResponse("Chat Completions");
        const payload = rawPayload as {
          choices?: {
            finish_reason?: string | null;
            message?: {
              role?: string;
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: {
                id: string;
                function: { name: string; arguments: string };
              }[];
            };
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
              cache_write_tokens?: number;
              cached_creation_tokens?: number;
            };
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        await trace("chat_response", payload);
        const message = payload.choices?.[0]?.message;
        const finishReason = payload.choices?.[0]?.finish_reason;
        assertModelOutputComplete(finishReason);
        if (message === undefined)
          throw unknownProviderResponse("Chat Completions");
        if (
          finishReason !== undefined &&
          finishReason !== null &&
          typeof finishReason !== "string"
        )
          throw unknownProviderResponse("Chat Completions");
        if (!validChatAssistantMessage(message))
          throw unknownProviderResponse("Chat Completions");
        capture?.setReasoning(message.reasoning_content ?? undefined);
        return {
          ...(message.content == null ? {} : { text: message.content }),
          ...(message.reasoning_content == null
            ? {}
            : { reasoningContent: message.reasoning_content }),
          providerState: {
            protocol: "chat_completions" as const,
            assistantMessage: cloneProviderValue(message),
          },
          usage: normalizeChatUsage(payload.usage),
          ...(typeof finishReason === "string"
            ? { stopReason: finishReason }
            : {}),
          toolCalls: (message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          })),
        };
      },
    );
  }

  async #anthropic(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
    signal?: AbortSignal,
  ): Promise<ModelHostResponse> {
    const body = anthropicRequestBody(this.#connection, request);
    const bodyJson = JSON.stringify(body);
    await trace("anthropic_request", body);
    const url = providerUrl(this.#connection);
    const capture = providerCapture(
      this.#failureLog,
      this.#connection.provider,
      url,
      modelDiagnosticContext(request),
      bodyJson,
    );
    const diagnosticDelta = captureDelta(capture, onDelta);
    return capturedProviderOperation(
      this.#failureLog,
      capture,
      async (observe) => {
        const response = observe(
          await dispatchProviderRequest(
            this.#fetch,
            url,
            {
              method: "POST",
              headers: {
                Accept: "text/event-stream",
                "anthropic-version": "2023-06-01",
                "x-api-key": this.#connection.apiKey,
                "Content-Type": "application/json",
              },
              body: bodyJson,
              ...(signal === undefined ? {} : { signal }),
            },
            "Anthropic Messages",
          ),
        );
        if (!response.ok) throw await providerError(response);
        if (isProviderEventStream(response)) {
          const streamed = await providerStreamResult(
            response,
            "Anthropic Messages",
            (body) => aggregateAnthropicModelStream(body, diagnosticDelta),
            signal,
          );
          capture?.setReasoning(streamed.reasoningContent);
          await trace("anthropic_response", streamed);
          return {
            ...(streamed.text === "" ? {} : { text: streamed.text }),
            ...(streamed.reasoningContent === ""
              ? {}
              : { reasoningContent: streamed.reasoningContent }),
            toolCalls: streamed.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: structuredClone(call.arguments),
            })),
            providerState: {
              protocol: "anthropic_messages" as const,
              content: cloneProviderValue(streamed.content),
              ...(streamed.responseId === undefined
                ? {}
                : { responseId: streamed.responseId }),
              ...(streamed.model === undefined
                ? {}
                : { model: streamed.model }),
              ...(streamed.stopReason === undefined
                ? {}
                : { stopReason: streamed.stopReason }),
            },
            usage: normalizeAnthropicUsage(streamed.usage),
            ...(typeof streamed.stopReason === "string"
              ? { stopReason: streamed.stopReason }
              : {}),
          };
        }
        const rawPayload = await providerJson(response, "Anthropic Messages");
        if (!isRecord(rawPayload) || !Array.isArray(rawPayload.content))
          throw unknownProviderResponse("Anthropic Messages");
        const payload = rawPayload as {
          content?: (
            | { type: "text"; text: string }
            | { type: "thinking"; thinking: string }
            | { type: "tool_use"; id: string; name: string; input: unknown }
            | Record<string, unknown>
          )[];
          id?: string;
          model?: string;
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        assertModelOutputComplete(payload.stop_reason);
        const content = payload.content!;
        if (!validAnthropicContent(content))
          throw unknownProviderResponse("Anthropic Messages");
        await trace("anthropic_response", payload);
        const reasoningContent = content
          .filter(
            (item): item is { type: "thinking"; thinking: string } =>
              item.type === "thinking",
          )
          .map(({ thinking }) => thinking)
          .join("");
        capture?.setReasoning(reasoningContent);
        return {
          text: content
            .filter(
              (item): item is { type: "text"; text: string } =>
                item.type === "text",
            )
            .map(({ text }) => text)
            .join(""),
          ...(reasoningContent === "" ? {} : { reasoningContent }),
          toolCalls: content
            .filter(
              (
                item,
              ): item is {
                type: "tool_use";
                id: string;
                name: string;
                input: unknown;
              } => item.type === "tool_use",
            )
            .map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.input,
            })),
          providerState: {
            protocol: "anthropic_messages" as const,
            content: cloneProviderValue(content),
            ...(payload.id === undefined ? {} : { responseId: payload.id }),
            ...(payload.model === undefined ? {} : { model: payload.model }),
            ...(payload.stop_reason === undefined
              ? {}
              : { stopReason: payload.stop_reason }),
          },
          usage: normalizeAnthropicUsage(payload.usage),
          ...(typeof payload.stop_reason === "string"
            ? { stopReason: payload.stop_reason }
            : {}),
        };
      },
    );
  }
}

function assertExchangeCompatibility(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): void {
  if (request.bootstrap.provider.protocol !== connection.provider)
    throw new ModelHostBindingMismatchError(
      "The compiled prompt protocol does not match the selected model host",
    );
  if (request.bootstrap.cache.strategy !== modelCacheStrategy(connection))
    throw new ModelHostBindingMismatchError(
      "The compiled prompt cache policy does not match the selected model host",
    );
  if (request.maxOutputTokens > connection.maxOutputTokens)
    throw new ModelHostBindingMismatchError(
      "The request output limit exceeds the selected model host binding",
    );
}

function modelHostTrace(request: ModelHostExchange) {
  return {
    requestId: request.requestId,
    operationId: request.operationId,
    requestAttempt: request.requestAttempt,
    exchange: request.exchange,
    bootstrap: structuredClone(request.bootstrap),
    appended: request.appended.map((item) =>
      item.kind !== "assistant"
        ? structuredClone(item)
        : {
            kind: item.kind,
            text: item.text,
            toolCalls: structuredClone(item.toolCalls),
            reasoningContentAvailable: item.reasoningContent !== undefined,
            providerStateAvailable: item.providerState !== undefined,
          },
    ),
    tools: request.tools.map(({ name }) => name),
    toolUniverse: request.toolUniverse?.map(({ name }) => name),
    allowedTools: structuredClone(request.allowedTools),
    toolStrategy: structuredClone(request.toolStrategy),
    maxOutputTokens: request.maxOutputTokens,
  };
}

function modelDiagnosticContext(
  request: ModelHostExchange,
): AiExchangeDiagnostics["context"] {
  return {
    scope:
      request.requestId === "play_call_chain"
        ? "play_call_chain"
        : request.operationId?.startsWith("setting-") === true
          ? "setting_improvement"
          : request.operationId?.includes(":followup:") === true
            ? "play_followup"
            : "model_host",
    ...(request.requestId === undefined
      ? {}
      : { requestId: request.requestId }),
    ...(request.operationId === undefined
      ? {}
      : { operationId: request.operationId }),
    ...(request.requestAttempt === undefined
      ? {}
      : { requestAttempt: request.requestAttempt }),
    ...(request.exchange === undefined ? {} : { exchange: request.exchange }),
  };
}

function providerCapture(
  failureLog: AiFailureRecorder | undefined,
  provider: FileNativeModelConnection["provider"],
  endpoint: URL,
  context: AiExchangeDiagnostics["context"],
  requestBody: string,
  endpointLabel?: string,
): AiExchangeCapture | undefined {
  return failureLog === undefined
    ? undefined
    : new AiExchangeCapture({
        provider,
        endpoint,
        context,
        requestBody,
        ...(endpointLabel === undefined ? {} : { endpointLabel }),
      });
}

function captureDelta(
  capture: AiExchangeCapture | undefined,
  downstream: ModelHostDeltaSink | undefined,
): ModelHostDeltaSink | undefined {
  if (capture === undefined) return downstream;
  return (delta) => {
    if (delta.kind === "reasoning") capture.observeReasoning(delta.text);
    downstream?.(delta);
  };
}

async function capturedProviderOperation<Value extends object>(
  failureLog: AiFailureRecorder | undefined,
  capture: AiExchangeCapture | undefined,
  operation: (
    observeResponse: (response: Response) => Response,
  ) => Promise<Value>,
  sanitizeGoogleErrors = false,
): Promise<Value & { diagnostics?: AiExchangeDiagnostics }> {
  const observeResponse = (response: Response): Response =>
    capture?.captureResponse(response) ?? response;
  try {
    const value = await operation(observeResponse);
    if (capture === undefined) return value;
    return { ...value, diagnostics: capture.snapshot() };
  } catch (error: unknown) {
    if (error instanceof ModelHostCancelledError) throw error;
    const reportedError = sanitizeGoogleErrors
      ? error instanceof ModelHostFailureError
        ? new ModelHostFailureError("Google Interactions request was rejected")
        : new ModelHostOutcomeUnknownError(
            "Google Interactions request outcome could not be confirmed",
          )
      : error;
    if (capture !== undefined && failureLog !== undefined) {
      const exchange = capture.snapshot();
      const failure: AiFailureDescription = {
        kind:
          exchange.response === undefined
            ? "provider_transport"
            : reportedError instanceof ModelHostFailureError
              ? "provider_rejection"
              : "provider_response_format",
        message:
          reportedError instanceof Error
            ? reportedError.message
            : "Provider request processing failed.",
        ...(reportedError instanceof ModelHostFailureError &&
        reportedError.details !== undefined
          ? { details: reportedError.details }
          : {}),
        error: errorDescription(reportedError),
      };
      await failureLog.recordFailure({ exchange, failures: [failure] });
    }
    throw reportedError;
  }
}

async function trace(kind: string, value: unknown): Promise<void> {
  const path = process.env.NARRAEON_PROVIDER_TRACE_PATH;
  if (path === undefined) return;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const size = await stat(path).then(
      ({ size }) => size,
      () => 0,
    );
    if (size > 0) await chmod(path, 0o600);
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024 - size) return;
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Explicit acceptance diagnostics must never change provider semantics.
  }
}

type ProviderRequest = ModelHostExchange;

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
  const firstConversation = logical.findIndex(
    (message) => (message.messageRole ?? "system") !== "system",
  );
  const leading = ordered
    ? logical.slice(
        0,
        firstConversation < 0 ? logical.length : firstConversation,
      )
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
  let conversation = false;
  for (const message of request.bootstrap.logicalMessages) {
    if (
      message.role === "player_input" ||
      (request.bootstrap.provider.preload !== undefined &&
        message.role === "world_context")
    )
      continue;
    if ((message.messageRole ?? "system") !== "system") conversation = true;
    else if (conversation)
      return [message.promptId, ...message.blocks.map(({ source }) => source)]
        .filter((item) => item !== undefined)
        .join(", ");
  }
  return "";
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
  const preload = request.bootstrap.provider.preload;
  const appendPreload = () => {
    if (preload !== undefined)
      input.push(
        {
          type: "user_input",
          content: text(
            "Runtime preload: initial world materials, not a player action or model response.",
          ),
        },
        {
          type: "function_call",
          id: preload.callId,
          name: "runtime_load_context",
          arguments: {},
        },
        {
          type: "function_result",
          call_id: preload.callId,
          name: "runtime_load_context",
          result: text(preload.markdown),
        },
      );
  };
  for (const [index, message] of messages.entries()) {
    if (index === bootstrapPrefixEnd(request)) appendPreload();
    if (message.role === "system") {
      if (conversationStarted)
        throw new Error(
          `Google Interactions cannot encode System message ${index + 1} after User/Assistant${googleLateSystemSource(request) ? `: ${googleLateSystemSource(request)}` : ""}`,
        );
      system.push(contentText(message.content));
    } else {
      conversationStarted = true;
      input.push({
        type: message.role === "user" ? "user_input" : "model_output",
        content: text(contentText(message.content)),
      });
    }
  }
  if (bootstrapPrefixEnd(request) === messages.length) appendPreload();
  const calls = new Map<string, string>();
  const boundaries = request.worldRevisionBoundaries;
  const currentBoundary = boundaries?.entries.findLast(
    ({ epochId }) => epochId === boundaries.currentEpochId,
  );
  if (currentBoundary !== undefined)
    system.push(
      `# Runtime world-revision epoch boundary\n\nThe current epoch is ${currentBoundary.epochId}, based on ${currentBoundary.baseHead}. All prior search cursors and read authorizations are invalid. Re-read before writing, except for materials legitimately preloaded in the current revision.`,
    );
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
          content: text(
            `# Runtime notice: world-revision epoch transition\n\n${boundary.markdown}`,
          ),
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
    } else input.push({ type: "user_input", content: text(item.text) });
  }
  const tools = providerToolDefinitions(request);
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
      ...(hasFrozenToolPolicy(request) &&
      providerAllowedTools(request).length === 0
        ? { tool_choice: "none" }
        : {}),
    },
  };
}

type FrozenModelHostExchange = ModelHostExchange & {
  toolUniverse: NonNullable<ModelHostExchange["toolUniverse"]>;
};

function chatRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): Record<string, unknown> {
  const tools = providerToolDefinitions(request);
  const allowedTools = providerAllowedTools(request);
  const hasPolicy = hasFrozenToolPolicy(request);
  return checkedCacheBreakpoints({
    model: connection.modelId,
    ...chatReasoningRequest(connection),
    messages: [
      ...chatBootstrapMessages(connection, request),
      ...chatAppend(connection, request),
    ],
    ...(connection.dialect === "cliproxyapi"
      ? { prompt_cache_key: promptCacheKey(connection, request) }
      : {}),
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...(hasPolicy && allowedTools.length === 0
      ? { tool_choice: "none" }
      : tools.length === 0
        ? {}
        : { tool_choice: "auto" }),
    max_tokens: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  });
}

function anthropicRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): Record<string, unknown> {
  const tools = providerToolDefinitions(request);
  return checkedCacheBreakpoints({
    model: connection.modelId,
    ...anthropicReasoningRequest(connection),
    system: request.bootstrap.provider.system,
    messages: [
      ...anthropicBootstrapMessages(request),
      ...anthropicAppend(connection, request),
    ],
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
    ...(hasFrozenToolPolicy(request) &&
    providerAllowedTools(request).length === 0
      ? { tool_choice: { type: "none" } }
      : {}),
    max_tokens: request.maxOutputTokens,
    stream: true,
  });
}

interface ResponsesRequestBodyInput {
  connection: FileNativeModelConnection;
  input: unknown[];
  tools: { name: string; description: string; parameters: object }[];
  allowedTools?: string[];
  toolStrategy?: RuntimeToolDefinitionStrategy;
  hasFrozenToolPolicy?: boolean;
  maxOutputTokens: number;
  promptCacheKey?: string;
}

function responsesRequestInput(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): ResponsesRequestBodyInput {
  return {
    connection,
    input: [
      ...responsesBootstrapMessages(connection, request),
      ...responsesAppend(connection, request),
    ],
    tools: providerToolDefinitions(request).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
    allowedTools: providerAllowedTools(request),
    toolStrategy: providerToolStrategy(request, connection.provider),
    hasFrozenToolPolicy: hasFrozenToolPolicy(request),
    maxOutputTokens: request.maxOutputTokens,
    promptCacheKey: promptCacheKey(connection, request),
  };
}

function responsesRequestBody(
  input: ResponsesRequestBodyInput,
): Record<string, unknown> {
  const allowedTools =
    input.allowedTools ?? input.tools.map((tool) => tool.name);
  const toolChoice =
    input.hasFrozenToolPolicy === true && allowedTools.length === 0
      ? "none"
      : input.hasFrozenToolPolicy === true &&
          input.toolStrategy === "native_allowed_subset"
        ? {
            type: "allowed_tools",
            mode: "auto",
            tools: allowedTools.map((name) => ({ type: "function", name })),
          }
        : "auto";
  return checkedCacheBreakpoints({
    model: input.connection.modelId,
    ...responsesReasoningRequest(resolveConnection(input.connection)),
    input: input.input,
    ...(input.tools.length === 0
      ? input.hasFrozenToolPolicy === true && allowedTools.length === 0
        ? { tool_choice: "none" }
        : {}
      : {
          tools: input.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            // Runtime schemas distinguish absent options from supplied values.
            // Responses otherwise normalizes compatible schemas to strict mode.
            strict: false,
          })),
          tool_choice: toolChoice,
        }),
    max_output_tokens: input.maxOutputTokens,
    ...(input.promptCacheKey === undefined
      ? {}
      : { prompt_cache_key: input.promptCacheKey }),
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: true,
  });
}

/**
 * A frozen policy is present when the caller supplies the logical operation's
 * complete tool universe. All play lifecycles share this one ModelHost seam.
 */
function hasFrozenToolPolicy(request: ProviderRequest): boolean {
  return frozenToolPolicy(request) !== null;
}

function frozenToolPolicy(
  request: ProviderRequest,
): FrozenModelHostExchange | null {
  if (!("toolUniverse" in request && request.toolUniverse !== undefined))
    return null;
  return request as FrozenModelHostExchange;
}

function providerToolDefinitions(
  request: ProviderRequest,
): PromptCompilation["tools"] {
  const policy = frozenToolPolicy(request);
  return (policy?.toolUniverse ?? request.tools).map((tool) => {
    if (!hasUnsupportedProviderToolSchemaRoot(tool.inputSchema)) return tool;
    const portableInputSchema = portableRuntimeToolInputSchema(tool.name);
    if (portableInputSchema === null)
      throw new Error(
        `Provider tool ${tool.name} uses oneOf, allOf, or anyOf at the input schema root`,
      );
    if (hasUnsupportedProviderToolSchemaRoot(portableInputSchema))
      throw new Error(
        `Provider tool ${tool.name} has no portable root-object input schema`,
      );
    // Released play contexts freeze their logical tool universe. Migrate only
    // the Provider wire projection of the old root-union schema; Runtime keeps
    // validating the original source-specific contract and the persisted
    // transcript remains untouched.
    return {
      ...tool,
      inputSchema: portableInputSchema,
    };
  });
}

function hasUnsupportedProviderToolSchemaRoot(schema: object): boolean {
  return ["oneOf", "allOf", "anyOf"].some((keyword) =>
    Object.prototype.hasOwnProperty.call(schema, keyword),
  );
}

function providerAllowedTools(request: ProviderRequest): string[] {
  const policy = frozenToolPolicy(request);
  if (policy !== null) return [...(policy.allowedTools ?? [])];
  return request.tools.map((tool) => tool.name);
}

function providerToolStrategy(
  request: ProviderRequest,
  provider: FileNativeModelConnection["provider"],
): RuntimeToolDefinitionStrategy {
  const policy = frozenToolPolicy(request);
  if (policy?.toolStrategy !== undefined) return policy.toolStrategy;
  return defaultRuntimeToolDefinitionStrategy(provider);
}

function chatBootstrapMessages(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) => cloneProviderValue(message),
  );
  const prefixEnd = bootstrapPrefixEnd(request);
  messages.splice(
    prefixEnd,
    0,
    ...initialWorldContext(request, "chat_completions"),
  );
  return connection.dialect === "cliproxyapi"
    ? attachCacheControlToLastRole(
        messages,
        request.bootstrap.provider.preload === undefined ? "system" : "tool",
      )
    : messages;
}

function responsesBootstrapMessages(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) =>
      responsesBootstrapMessage(message, connection.dialect === "cliproxyapi"),
  );
  const prefixEnd = bootstrapPrefixEnd(request);
  // Legacy material arrays already mark their stable blocks, and may also contain
  // player input. Only mark whole messages for the plain-text instruction prefix.
  const cacheMessageIndex = request.bootstrap.provider.messages
    .slice(0, prefixEnd)
    .findLastIndex((message) => typeof message.content === "string");
  const prefix = messages.map((message, index) =>
    connection.dialect === "cliproxyapi" &&
    index === cacheMessageIndex &&
    isRecord(message)
      ? { ...message, cache_control: { type: "ephemeral" } }
      : message,
  );
  prefix.splice(
    prefixEnd,
    0,
    ...initialWorldContext(request, "openai_responses"),
  );
  return prefix;
}

/** Configured User prompts are part of the prefix, not the player's first input. */
function bootstrapPrefixEnd(request: ModelHostExchange): number {
  return (
    request.bootstrap.provider.messages.length -
    request.bootstrap.logicalMessages.filter(
      ({ role }) => role === "player_input",
    ).length
  );
}

function anthropicBootstrapMessages(request: ModelHostExchange): unknown[] {
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) => cloneProviderValue(message),
  );
  messages.splice(
    bootstrapPrefixEnd(request),
    0,
    ...initialWorldContext(request, "anthropic_messages"),
  );
  return messages.filter(
    (message) => !isRecord(message) || message.role !== "system",
  );
}

/** Synthetic bootstrap only: never manufacture a provider continuation or a story event. */
function initialWorldContext(
  request: ModelHostExchange,
  protocol: PromptCompilation["provider"]["protocol"],
): unknown[] {
  const preload = request.bootstrap.provider.preload;
  if (preload === undefined) return [];
  const name = "runtime_load_context";
  const notice = {
    role: "user",
    content:
      "Runtime preload: supply the initial world materials selected by the frame. This bootstrap-only read is not a player action or a callable tool. Later successful tool results update these initial values.",
  };
  if (protocol === "chat_completions")
    return [
      notice,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: preload.callId,
            type: "function",
            function: { name, arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: preload.callId, content: preload.markdown },
    ];
  if (protocol === "openai_responses")
    return [
      notice,
      { type: "function_call", call_id: preload.callId, name, arguments: "{}" },
      {
        type: "function_call_output",
        call_id: preload.callId,
        output: preload.markdown,
      },
    ];
  return [
    notice,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: preload.callId, name, input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: preload.callId,
          content: preload.markdown,
          ...(request.bootstrap.cache.strategy === "explicit_anthropic_blocks"
            ? { cache_control: { type: "ephemeral" } }
            : {}),
        },
      ],
    },
  ];
}

function attachCacheControlToLastRole(
  messages: unknown[],
  role: string,
): unknown[] {
  const result = cloneProviderValue(messages);
  let target = -1;
  for (const [index, message] of result.entries())
    if (isRecord(message) && message.role === role) target = index;
  if (target < 0) return result;
  const message = result[target];
  if (!isRecord(message)) return result;
  result[target] = {
    ...message,
    cache_control: { type: "ephemeral" },
  };
  return result;
}

function promptCacheKey(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): string {
  const stablePrefixScope =
    request.bootstrap.cache.stablePrefixFingerprint ??
    createHash("sha256")
      .update(
        JSON.stringify({
          provider: request.bootstrap.provider,
          tools: request.toolUniverse ?? request.tools,
          toolStrategy: request.toolStrategy,
        }),
      )
      .digest("hex");
  // OpenAI uses this as a cache-routing hint, so equal frozen prefixes should
  // share it. CLIProxyAPI additionally treats it as execution-session identity;
  // there it must stay stable within one chain and isolated across chains.
  const scope =
    connection.dialect === "cliproxyapi"
      ? (request.operationId ?? stablePrefixScope)
      : stablePrefixScope;
  return createHash("sha256")
    .update(
      `${connection.provider}\0${connection.dialect}\0${connection.modelId}\0${scope}`,
    )
    .digest("hex");
}

/**
 * Explicit-breakpoint encodings mark the last transcript item before the
 * request-level suffix, so the next dispatch reads back the transcript it sent.
 * A request without a suffix keeps its request end as the transcript's entry,
 * so it is encoded exactly as before.
 */
function appendWithSuffixBreakpoint(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
  encode: (items: readonly ModelHostAppendItem[]) => unknown[],
  markLast: (encoded: unknown[]) => unknown[],
): unknown[] {
  const { transcript, suffix } = splitRequestSuffix(request.appended);
  const encoded = encode(transcript);
  const breakpoint =
    suffix.length > 0 &&
    encoded.length > 0 &&
    connection.cacheSuffixBreakpoint &&
    modelCacheStrategy(connection) !== "provider_managed";
  return [...(breakpoint ? markLast(encoded) : encoded), ...encode(suffix)];
}

/** Request-level suffix items are recompiled for every dispatch and never stored. */
function splitRequestSuffix(appended: readonly ModelHostAppendItem[]): {
  transcript: ModelHostAppendItem[];
  suffix: ModelHostAppendItem[];
} {
  let end = appended.length;
  while (end > 0 && isRequestSuffix(appended[end - 1]!)) end -= 1;
  return { transcript: appended.slice(0, end), suffix: appended.slice(end) };
}

function isRequestSuffix(item: ModelHostAppendItem): boolean {
  return item.kind === "runtime_notice" && item.notice === "turn_guide";
}

/** Message-level cache_control, the form the CLIProxyAPI prefix breakpoints use. */
function markLastMessage(messages: unknown[]): unknown[] {
  const last = messages.at(-1);
  if (!isRecord(last))
    throw new Error("The transcript tail cannot carry a cache breakpoint.");
  return [
    ...messages.slice(0, -1),
    { ...last, cache_control: { type: "ephemeral" } },
  ];
}

/** Thinking blocks reject cache_control, so the breakpoint lands on the last block that accepts it. */
function markLastAnthropicBlock(messages: unknown[]): unknown[] {
  const last = messages.at(-1);
  if (!isRecord(last))
    throw new Error("The transcript tail cannot carry a cache breakpoint.");
  const content: unknown[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : Array.isArray(last.content)
        ? last.content
        : [];
  const index = content.findLastIndex(
    (block) =>
      isRecord(block) &&
      block.type !== "thinking" &&
      block.type !== "redacted_thinking",
  );
  if (index < 0)
    throw new Error(
      "The Anthropic transcript tail has no block that can carry a cache breakpoint.",
    );
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: content.map((block, position) =>
        position === index
          ? {
              ...(block as Record<string, unknown>),
              cache_control: { type: "ephemeral" },
            }
          : block,
      ),
    },
  ];
}

/** Refuses a request over the breakpoint limit instead of silently dropping one. */
function checkedCacheBreakpoints<Body>(body: Body): Body {
  const count = countCacheBreakpoints(body);
  if (count > explicitCacheBreakpointLimit)
    throw new Error(
      `The request has ${count} cache breakpoints; the Anthropic limit is ${explicitCacheBreakpointLimit}.`,
    );
  return body;
}

function countCacheBreakpoints(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce(
      (total: number, item) => total + countCacheBreakpoints(item),
      0,
    );
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total + (key === "cache_control" ? 1 : 0) + countCacheBreakpoints(item),
    0,
  );
}

function chatAppend(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  return appendWithSuffixBreakpoint(
    connection,
    request,
    chatItems,
    markLastMessage,
  );
}

function chatItems(items: readonly ModelHostAppendItem[]): unknown[] {
  return items.flatMap((item): unknown[] => {
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    )
      return [{ role: "user", content: item.text }];
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return [
        {
          role: "tool",
          tool_call_id: item.toolCallId,
          content: item.markdown,
        },
      ];
    if (item.providerState?.protocol === "chat_completions") {
      const message = item.providerState.assistantMessage;
      if (validChatAssistantMessage(message))
        return [cloneProviderValue(message)];
    }
    throw continuationError("Chat Completions");
  });
}

function anthropicAppend(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  return appendWithSuffixBreakpoint(
    connection,
    request,
    anthropicItems,
    markLastAnthropicBlock,
  );
}

function anthropicItems(items: readonly ModelHostAppendItem[]): unknown[] {
  const messages: unknown[] = [];
  let toolResults: Record<string, unknown>[] = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: item.markdown,
        ...(item.isError === true ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    ) {
      messages.push({ role: "user", content: item.text });
      continue;
    }
    if (item.kind === "prompt_delta") {
      messages.push(...promptDeltaProviderMessages(item.logicalMessages));
      continue;
    }
    if (
      item.providerState?.protocol === "anthropic_messages" &&
      validAnthropicContent(item.providerState.content)
    ) {
      messages.push({
        role: "assistant",
        content: cloneProviderValue(item.providerState.content),
      });
      continue;
    }
    throw continuationError("Anthropic Messages");
  }
  flushToolResults();
  return messages;
}

function responsesAppend(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  return appendWithSuffixBreakpoint(
    connection,
    request,
    responsesItems,
    markLastMessage,
  );
}

function responsesItems(items: readonly ModelHostAppendItem[]): unknown[] {
  return items.flatMap((item) => {
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    )
      return [{ role: "user", content: item.text }];
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return [
        {
          type: "function_call_output",
          call_id: item.toolCallId,
          output: item.markdown,
        },
      ];
    if (
      item.providerState?.protocol === "openai_responses" &&
      validResponsesOutput(item.providerState.output)
    )
      return cloneResponseOutput(item.providerState.output);
    throw continuationError("OpenAI Responses");
  });
}

function promptDeltaProviderMessages(
  messages: PromptCompilation["logicalMessages"],
) {
  return messages.map((message) => ({
    role: "user" as const,
    content: renderPromptDeltaMessage(message.role, message.markdown),
  }));
}

function chatReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  return {
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { reasoning_effort: connection.reasoningEffort }),
    ...(connection.dialect !== "cliproxyapi" ||
    connection.reasoningSummary === "provider_default"
      ? {}
      : {
          // Chat Completions has no standard summary switch. CLIProxyAPI
          // deliberately accepts the OpenRouter-compatible visibility bit and
          // maps it to the target protocol without changing effort.
          reasoning: {
            exclude: connection.reasoningSummary === "none",
          },
        }),
  };
}

function responsesReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  const reasoning = {
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { effort: connection.reasoningEffort }),
    ...(connection.reasoningSummary === "provider_default" ||
    (connection.reasoningSummary === "none" &&
      connection.dialect === "standard")
      ? {}
      : {
          summary:
            connection.reasoningSummary === "none"
              ? null
              : connection.reasoningSummary,
        }),
  };
  return Object.keys(reasoning).length === 0 ? {} : { reasoning };
}

function anthropicReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  const display =
    connection.reasoningSummary === "provider_default"
      ? {}
      : {
          display:
            connection.reasoningSummary === "auto" ? "summarized" : "omitted",
        };
  const thinking =
    connection.thinkingMode === "provider_default"
      ? connection.dialect === "cliproxyapi" &&
        hasCLIProxyThinkingSuffix(connection.modelId) &&
        connection.reasoningSummary !== "provider_default"
        ? {
            // CLIProxyAPI extracts visibility from a valid source thinking
            // block before the model suffix replaces its mode. The suffix is
            // still the sole mode/effort authority; adaptive is only the
            // proxy's protocol-valid summary carrier.
            thinking: { type: "adaptive", ...display },
          }
        : {}
      : connection.thinkingMode === "disabled"
        ? { thinking: { type: "disabled" } }
        : connection.thinkingMode === "adaptive"
          ? { thinking: { type: "adaptive", ...display } }
          : {
              thinking: {
                type: "enabled",
                budget_tokens: connection.thinkingBudgetTokens,
                ...display,
              },
            };
  return {
    ...thinking,
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { output_config: { effort: connection.reasoningEffort } }),
  };
}

function providerUrl(connection: FileNativeModelConnection): URL {
  const url = new URL(connection.baseUrl);
  const suffix =
    connection.provider === "chat_completions"
      ? "/chat/completions"
      : connection.provider === "openai_responses"
        ? "/responses"
        : connection.provider === "google_interactions"
          ? "/interactions"
          : "/messages";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
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

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { $invalidToolArgumentsJson: value };
  }
}

async function providerError(response: Response): Promise<Error> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 4096);
  } catch {
    // A non-2xx response is already a confirmed remote rejection. Preserve
    // that deterministic classification even if its error body is unreadable.
  }
  await trace("provider_error", {
    status: response.status,
    statusText: response.statusText,
    body: text,
  });
  return new ModelHostFailureError(
    `Provider request failed: ${response.status} ${text}`,
  );
}

function responsesBootstrapMessage(
  message: PromptCompilation["provider"]["messages"][number],
  preserveCacheControl = false,
) {
  return {
    role: message.role,
    content:
      preserveCacheControl && Array.isArray(message.content)
        ? message.content.flatMap((item) => {
            if (!isRecord(item) || typeof item.text !== "string") return [];
            return [
              {
                type:
                  message.role === "assistant" ? "output_text" : "input_text",
                text: item.text,
                ...(isRecord(item.cache_control)
                  ? { cache_control: cloneProviderValue(item.cache_control) }
                  : {}),
              },
            ];
          })
        : providerText(message.content),
  };
}

function providerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const items: unknown[] = content;
    return items
      .flatMap((item) =>
        isRecord(item) && typeof item.text === "string" ? [item.text] : [],
      )
      .join("\n\n");
  }
  return JSON.stringify(content) ?? "";
}

function validChatAssistantMessage(value: unknown): value is Record<
  string,
  unknown
> & {
  role: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
  }[];
} {
  if (!isRecord(value) || value.role !== "assistant") return false;
  if (
    value.content !== undefined &&
    value.content !== null &&
    typeof value.content !== "string"
  )
    return false;
  if (
    value.reasoning_content !== undefined &&
    value.reasoning_content !== null &&
    typeof value.reasoning_content !== "string"
  )
    return false;
  return (
    value.tool_calls === undefined ||
    (Array.isArray(value.tool_calls) &&
      value.tool_calls.every(
        (call) =>
          isRecord(call) &&
          typeof call.id === "string" &&
          isRecord(call.function) &&
          typeof call.function.name === "string" &&
          typeof call.function.arguments === "string",
      ))
  );
}

function validAnthropicContent(
  value: unknown,
): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item) || typeof item.type !== "string") return false;
      if (item.type === "text") return typeof item.text === "string";
      if (item.type === "thinking")
        return (
          typeof item.thinking === "string" &&
          (item.signature === undefined || typeof item.signature === "string")
        );
      if (item.type === "redacted_thinking")
        return typeof item.data === "string";
      if (item.type === "tool_use")
        return (
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          isRecord(item.input)
        );
      return true;
    })
  );
}

function validResponsesOutput(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item) || typeof item.type !== "string") return false;
      if (item.type === "message") return Array.isArray(item.content);
      if (item.type === "function_call")
        return (
          typeof item.call_id === "string" &&
          typeof item.name === "string" &&
          typeof item.arguments === "string"
        );
      if (item.type === "reasoning")
        return (
          (item.summary === undefined || Array.isArray(item.summary)) &&
          (item.content === undefined ||
            item.content === null ||
            Array.isArray(item.content)) &&
          (item.encrypted_content === undefined ||
            item.encrypted_content === null ||
            typeof item.encrypted_content === "string")
        );
      return true;
    })
  );
}

function continuationError(protocol: string): ModelHostContinuationError {
  return new ModelHostContinuationError(
    `${protocol} continuation payload is missing or incompatible; start a fresh model context instead of rebuilding it from parsed text, reasoning, or tool calls`,
  );
}

async function openAIResponsesRequest(
  input: ResponsesRequestBodyInput & {
    fetchImplementation: typeof fetch;
    tracePrefix: string;
    failureLog?: AiFailureRecorder;
    diagnosticContext: AiExchangeDiagnostics["context"];
    onDelta?: ModelHostDeltaSink;
    signal?: AbortSignal;
  },
): Promise<{
  text?: string;
  reasoningContent?: string;
  usage?: ModelHostUsage;
  providerState: ProviderExchangeState;
  toolCalls?: ModelHostToolCall[];
  diagnostics?: AiExchangeDiagnostics;
}> {
  const body = responsesRequestBody(input);
  await trace(`${input.tracePrefix}_request`, body);
  const bodyJson = JSON.stringify(body);
  const url = providerUrl(input.connection);
  const capture = providerCapture(
    input.failureLog,
    input.connection.provider,
    url,
    input.diagnosticContext,
    bodyJson,
  );
  const diagnosticDelta = captureDelta(capture, input.onDelta);
  return capturedProviderOperation(
    input.failureLog,
    capture,
    async (observe) => {
      const response = observe(
        await dispatchProviderRequest(
          input.fetchImplementation,
          url,
          {
            method: "POST",
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${input.connection.apiKey}`,
              "Content-Type": "application/json",
            },
            body: bodyJson,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
          "OpenAI Responses",
        ),
      );
      if (!response.ok) throw await providerError(response);
      const payload = isProviderEventStream(response)
        ? await providerStreamResult(
            response,
            "Responses API",
            (body) => aggregateResponsesModelStream(body, diagnosticDelta),
            input.signal,
          )
        : await providerJson(response, "Responses API");
      await trace(`${input.tracePrefix}_response`, payload);
      if (!isRecord(payload) || !Array.isArray(payload.output))
        throw unknownProviderResponse("Responses API");
      assertModelOutputComplete(responsesStopReason(payload));
      const output = cloneResponseOutput(payload.output);
      if (!validResponsesOutput(output))
        throw unknownProviderResponse("Responses API");
      const text = output
        .flatMap((item) => {
          if (
            !isRecord(item) ||
            item.type !== "message" ||
            !Array.isArray(item.content)
          )
            return [];
          return item.content.flatMap((part) =>
            isRecord(part) &&
            part.type === "output_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          );
        })
        .join("");
      const reasoningContent = responsesReturnedReasoning(output);
      const toolCalls = output.flatMap((item): ModelHostToolCall[] => {
        if (
          !isRecord(item) ||
          item.type !== "function_call" ||
          typeof item.call_id !== "string" ||
          typeof item.name !== "string" ||
          typeof item.arguments !== "string"
        )
          return [];
        return [
          {
            id: item.call_id,
            name: item.name,
            arguments: parseArguments(item.arguments),
          },
        ];
      });
      const stopReason = responsesStopReason(payload);
      return {
        ...(text.length === 0 ? {} : { text }),
        ...(reasoningContent.length === 0 ? {} : { reasoningContent }),
        providerState: {
          protocol: "openai_responses" as const,
          output,
          ...(typeof payload.id === "string" ? { responseId: payload.id } : {}),
        },
        usage: normalizeResponsesUsage(payload.usage),
        ...(stopReason === undefined ? {} : { stopReason }),
        toolCalls,
      };
    },
  );
}

function responsesStopReason(
  payload: Record<string, unknown>,
): string | undefined {
  const status =
    typeof payload.status === "string" && payload.status !== ""
      ? payload.status
      : undefined;
  const details = isRecord(payload.incomplete_details)
    ? payload.incomplete_details
    : undefined;
  const reason =
    details !== undefined &&
    typeof details.reason === "string" &&
    details.reason !== ""
      ? details.reason
      : undefined;
  if (status !== undefined && reason !== undefined)
    return `${status}:${reason}`;
  return reason ?? status;
}

function responsesReturnedReasoning(output: readonly unknown[]): string {
  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "reasoning") return [];
      const summary = Array.isArray(item.summary)
        ? item.summary.flatMap((part) =>
            isRecord(part) &&
            part.type === "summary_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
        : [];
      if (summary.length > 0) return summary;
      return Array.isArray(item.content)
        ? item.content.flatMap((part) =>
            isRecord(part) &&
            part.type === "reasoning_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
        : [];
    })
    .join("");
}

function cloneResponseOutput(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Responses output must be an array");
  const source = JSON.stringify(value);
  return JSON.parse(source) as unknown[];
}

/** Clone provider-owned state before it enters the logical transcript. */
function cloneProviderValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  const source = JSON.stringify(value);
  if (typeof source !== "string") return value;
  return JSON.parse(source) as T;
}

function normalizeChatUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const inputTokens = providerNumber(usage.prompt_tokens);
  const cacheReadTokens = providerNumber(promptDetails.cached_tokens);
  const cacheWriteTokens =
    providerNumber(promptDetails.cache_write_tokens) ??
    providerNumber(promptDetails.cached_creation_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens: subtractCachedInput(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: providerNumber(completionDetails.reasoning_tokens),
      outputTokens: providerNumber(usage.completion_tokens),
      totalTokens: providerNumber(usage.total_tokens),
    },
    ["uncachedInputTokens"],
  );
}

function normalizeAnthropicUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
  const uncachedInputTokens = providerNumber(usage.input_tokens);
  const cacheReadTokens = providerNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = providerNumber(usage.cache_creation_input_tokens);
  const inputTokens = sumInputTokens(
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  );
  const outputTokens = providerNumber(usage.output_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens:
        providerNumber(outputDetails.thinking_tokens) ??
        providerNumber(usage.thinking_tokens),
      outputTokens,
      totalTokens:
        inputTokens === null || outputTokens === null
          ? null
          : inputTokens + outputTokens,
    },
    ["inputTokens", "totalTokens"],
  );
}

function normalizeResponsesUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
  const inputTokens = providerNumber(usage.input_tokens);
  const cacheReadTokens = providerNumber(inputDetails.cached_tokens);
  const cacheWriteTokens =
    providerNumber(inputDetails.cache_write_tokens) ??
    providerNumber(inputDetails.cached_creation_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens: subtractCachedInput(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: providerNumber(outputDetails.reasoning_tokens),
      outputTokens: providerNumber(usage.output_tokens),
      totalTokens: providerNumber(usage.total_tokens),
    },
    ["uncachedInputTokens"],
  );
}

function safeGoogleUsage(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const field of [
    "total_input_tokens",
    "total_cached_tokens",
    "total_thought_tokens",
    "total_output_tokens",
    "total_tokens",
  ]) {
    const count = value[field];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      result[field] = count;
  }
  return result;
}

function providerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageRecord(
  values: {
    inputTokens: number | null;
    uncachedInputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  },
  derivedFields: (keyof typeof values)[] = [],
): ModelHostUsage {
  const derived = new Set(derivedFields);
  const provenance = (
    key: keyof typeof values,
    value: number | null,
  ): ModelHostUsage["provenance"]["inputTokens"] =>
    value === null
      ? "unavailable"
      : derived.has(key)
        ? "derived_provider_fields"
        : "provider";
  return {
    ...values,
    provenance: {
      inputTokens: provenance("inputTokens", values.inputTokens),
      uncachedInputTokens: provenance(
        "uncachedInputTokens",
        values.uncachedInputTokens,
      ),
      cacheReadTokens: provenance("cacheReadTokens", values.cacheReadTokens),
      cacheWriteTokens: provenance("cacheWriteTokens", values.cacheWriteTokens),
      reasoningTokens: provenance("reasoningTokens", values.reasoningTokens),
      outputTokens: provenance("outputTokens", values.outputTokens),
      totalTokens: provenance("totalTokens", values.totalTokens),
    },
  };
}

function subtractCachedInput(
  inputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
): number | null {
  if (
    inputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    cacheReadTokens + cacheWriteTokens > inputTokens
  )
    return null;
  return inputTokens - cacheReadTokens - cacheWriteTokens;
}

function sumInputTokens(
  uncachedInputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
): number | null {
  if (
    uncachedInputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null
  )
    return null;
  return uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
}

async function parseProviderJson(
  response: Response,
  label: string,
): Promise<unknown> {
  const source = await response.text();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

async function providerJson(
  response: Response,
  label: string,
): Promise<unknown> {
  try {
    return await parseProviderJson(response, label);
  } catch (error: unknown) {
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its response could not be confirmed`,
      {
        cause: error,
      },
    );
  }
}

function isProviderEventStream(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") === true
  );
}

async function providerStreamResult<Value>(
  response: Response,
  label: string,
  read: (body: ReadableStream<Uint8Array>) => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (response.body === null)
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its streaming response has no body`,
    );
  try {
    return await read(response.body);
  } catch (error: unknown) {
    if (signal?.aborted === true) throw cancelledModelRequest(error);
    if (
      error instanceof ModelHostFailureError ||
      error instanceof ModelHostOutcomeUnknownError
    )
      throw error;
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its streaming response could not be confirmed`,
      { cause: error },
    );
  }
}

async function dispatchProviderRequest(
  fetchImplementation: typeof fetch,
  url: URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetchImplementation(url, init);
  } catch (error: unknown) {
    if (init.signal?.aborted === true) throw cancelledModelRequest(error);
    throw new ModelHostOutcomeUnknownError(
      `${label} request was dispatched but its outcome is unknown`,
      {
        cause: error,
      },
    );
  }
}

function cancelledModelRequest(cause?: unknown): ModelHostCancelledError {
  return new ModelHostCancelledError(
    "The player cancelled the dispatched model request; its partial response was not committed and cannot be replayed.",
    cause === undefined ? undefined : { cause },
  );
}

function signalWasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function unknownProviderResponse(label: string): ModelHostOutcomeUnknownError {
  return new ModelHostOutcomeUnknownError(
    `${label} was dispatched but its response shape could not be confirmed`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
