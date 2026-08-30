import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";
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
} from "./ModelHost.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "./ModelHost.ts";
import {
  renderPromptDeltaMessage,
  type FileNativePromptInput,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  documentCandidateSettingTools,
  SettingAuthorAdapter,
  SettingAuthorDelta,
  SettingAuthorMessage,
  SettingAuthorUsage,
} from "../setting/DocumentCandidateSettingImprovement.ts";
import type { ProviderExchangeState } from "./ProviderExchangeState.ts";
import {
  aggregateAnthropicSettingStream,
  aggregateChatSettingStream,
} from "./SettingAuthorStream.ts";
import {
  aggregateAnthropicModelStream,
  aggregateChatModelStream,
  aggregateResponsesModelStream,
  type ModelHostDeltaSink,
} from "./ModelHostStream.ts";
import {
  defaultRuntimeToolDefinitionStrategy,
  isRegisteredRuntimeToolName,
  runtimeToolsForNames,
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
}

interface ResolvedFileNativeModelConnection extends Omit<
  FileNativeModelConnection,
  | "dialect"
  | "reasoningEffort"
  | "reasoningSummary"
  | "thinkingMode"
  | "thinkingBudgetTokens"
> {
  dialect: ModelProviderDialect;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  thinkingMode: ModelThinkingMode;
  thinkingBudgetTokens: number | null;
}

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

  async exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    assertExchangeCompatibility(this.#connection, request);
    await trace("model_host_exchange", modelHostTrace(request));
    if (this.#connection.provider === "chat_completions")
      return this.#chat(request, observer?.onDelta);
    if (this.#connection.provider === "openai_responses")
      return this.#responses(request, observer?.onDelta);
    return this.#anthropic(request, observer?.onDelta);
  }

  /** Uses the production encoders and deliberately omits credentials. */
  previewRequest(request: ModelHostExchange): ModelHostWireRequest {
    assertExchangeCompatibility(this.#connection, request);
    const provider = this.#connection.provider;
    const body =
      provider === "chat_completions"
        ? chatRequestBody(this.#connection, request)
        : provider === "openai_responses"
          ? responsesRequestBody(
              responsesRequestInput(this.#connection, request),
            )
          : anthropicRequestBody(this.#connection, request);
    return {
      provider,
      method: "POST",
      endpointPath: providerUrl(this.#connection).pathname,
      headerNames:
        provider === "anthropic_messages"
          ? ["Accept", "anthropic-version", "x-api-key", "Content-Type"]
          : ["Accept", "Authorization", "Content-Type"],
      body: cloneProviderValue(body),
    };
  }

  async #responses(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
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
    });
  }

  async #chat(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
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
): AiExchangeCapture | undefined {
  return failureLog === undefined
    ? undefined
    : new AiExchangeCapture({ provider, endpoint, context, requestBody });
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

function captureSettingDelta(
  capture: AiExchangeCapture | undefined,
  downstream: ((delta: SettingAuthorDelta) => void) | undefined,
): ((delta: SettingAuthorDelta) => void) | undefined {
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
): Promise<Value & { diagnostics?: AiExchangeDiagnostics }> {
  const observeResponse = (response: Response): Response =>
    capture?.captureResponse(response) ?? response;
  try {
    const value = await operation(observeResponse);
    if (capture === undefined) return value;
    return { ...value, diagnostics: capture.snapshot() };
  } catch (error: unknown) {
    if (capture !== undefined && failureLog !== undefined) {
      const exchange = capture.snapshot();
      const failure: AiFailureDescription = {
        kind:
          exchange.response === undefined
            ? "provider_transport"
            : error instanceof ModelHostFailureError
              ? "provider_rejection"
              : "provider_response_format",
        message:
          error instanceof Error
            ? error.message
            : "Provider request processing failed.",
        error: errorDescription(error),
      };
      await failureLog.recordFailure({ exchange, failures: [failure] });
    }
    throw error;
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

export class FileNativeSettingAuthorProvider implements SettingAuthorAdapter {
  readonly #connection: ResolvedFileNativeModelConnection;
  readonly #fetch: typeof fetch;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #operationId: string | undefined;
  readonly #locale: AppLocale;
  #exchange = 0;

  constructor(
    connection: FileNativeModelConnection,
    fetchImplementation: typeof fetch = fetch,
    diagnostics?: {
      failureLog?: AiFailureRecorder;
      operationId?: string;
      locale?: AppLocale;
    },
  ) {
    this.#connection = resolveConnection(connection);
    this.#fetch = fetchImplementation;
    this.#failureLog = diagnostics?.failureLog;
    this.#operationId = diagnostics?.operationId;
    this.#locale = diagnostics?.locale ?? defaultAppLocale;
  }

  async next(request: Parameters<SettingAuthorAdapter["next"]>[0]) {
    this.#exchange += 1;
    const diagnosticContext: AiExchangeDiagnostics["context"] = {
      scope: "setting_improvement",
      requestId: "setting_improvement",
      ...(this.#operationId === undefined
        ? {}
        : { operationId: this.#operationId }),
      requestAttempt: 1,
      exchange: this.#exchange,
    };
    const tools = request.tools.map((name) =>
      settingToolDefinition(name, this.#locale),
    );
    if (this.#connection.provider === "chat_completions") {
      const body = {
        model: this.#connection.modelId,
        ...chatReasoningRequest(this.#connection),
        messages: chatSettingMessages(this.#connection, request.messages),
        ...(this.#connection.dialect === "cliproxyapi"
          ? {
              prompt_cache_key: settingPromptCacheKey(
                this.#connection,
                request.messages,
                this.#operationId,
              ),
            }
          : {}),
        ...(tools.length === 0
          ? {}
          : {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.schema,
                },
              })),
            }),
        max_tokens: Math.min(
          request.maxOutputTokens,
          this.#connection.maxOutputTokens,
        ),
        stream: true,
        stream_options: { include_usage: true },
      };
      await trace("setting_chat_request", body);
      const bodyJson = JSON.stringify(body);
      const url = providerUrl(this.#connection);
      const capture = providerCapture(
        this.#failureLog,
        this.#connection.provider,
        url,
        diagnosticContext,
        bodyJson,
      );
      const diagnosticDelta = captureSettingDelta(capture, request.onDelta);
      return capturedProviderOperation(
        this.#failureLog,
        capture,
        async (observe) => {
          const response = observe(
            await this.#fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.#connection.apiKey}`,
                "Content-Type": "application/json",
              },
              body: bodyJson,
            }),
          );
          if (!response.ok) throw await providerError(response);
          if (response.body === null)
            throw new Error(
              "The authoring response is missing a streaming body",
            );
          const streamed = await aggregateChatSettingStream(
            response.body,
            diagnosticDelta,
          );
          capture?.setReasoning(streamed.reasoningContent);
          await trace("setting_chat_response", streamed);
          return {
            role: "assistant" as const,
            content: streamed.content,
            ...(streamed.reasoningContent === ""
              ? {}
              : { reasoningContent: streamed.reasoningContent }),
            providerState: {
              protocol: "chat_completions" as const,
              assistantMessage: cloneProviderValue(streamed.assistantMessage),
            },
            toolCalls: streamed.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: asArguments(parseArguments(call.arguments)),
            })),
            usage: settingAuthorUsage(normalizeChatUsage(streamed.usage)),
          };
        },
      );
    }
    if (this.#connection.provider === "openai_responses") {
      const response = await openAIResponsesRequest({
        connection: this.#connection,
        fetchImplementation: this.#fetch,
        input: responsesSettingInput(this.#connection, request.messages),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        })),
        maxOutputTokens: Math.min(
          request.maxOutputTokens,
          this.#connection.maxOutputTokens,
        ),
        promptCacheKey: settingPromptCacheKey(
          this.#connection,
          request.messages,
          this.#operationId,
        ),
        tracePrefix: "setting_responses",
        ...(this.#failureLog === undefined
          ? {}
          : { failureLog: this.#failureLog }),
        diagnosticContext,
        ...(request.onDelta === undefined ? {} : { onDelta: request.onDelta }),
      });
      return {
        role: "assistant" as const,
        content: response.text ?? "",
        ...(response.reasoningContent === undefined
          ? {}
          : { reasoningContent: response.reasoningContent }),
        providerState: response.providerState,
        toolCalls: (response.toolCalls ?? []).map((call) => ({
          ...call,
          arguments: asArguments(call.arguments),
        })),
        usage: settingAuthorUsage(response.usage),
        ...(response.diagnostics === undefined
          ? {}
          : { diagnostics: response.diagnostics }),
      };
    }
    const system = request.messages
      .filter(({ role }) => role === "system")
      .map(({ content }, index, messages) => ({
        type: "text",
        text: content,
        ...(index === messages.length - 1
          ? { cache_control: { type: "ephemeral" } }
          : {}),
      }));
    const body = {
      model: this.#connection.modelId,
      ...anthropicReasoningRequest(this.#connection),
      ...(system.length === 0 ? {} : { system }),
      messages: anthropicSettingMessages(request.messages),
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.schema,
            })),
          }),
      max_tokens: Math.min(
        request.maxOutputTokens,
        this.#connection.maxOutputTokens,
      ),
      stream: true,
    };
    await trace("setting_anthropic_request", body);
    const bodyJson = JSON.stringify(body);
    const url = providerUrl(this.#connection);
    const capture = providerCapture(
      this.#failureLog,
      this.#connection.provider,
      url,
      diagnosticContext,
      bodyJson,
    );
    const diagnosticDelta = captureSettingDelta(capture, request.onDelta);
    return capturedProviderOperation(
      this.#failureLog,
      capture,
      async (observe) => {
        const response = observe(
          await this.#fetch(url, {
            method: "POST",
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": this.#connection.apiKey,
              "Content-Type": "application/json",
            },
            body: bodyJson,
          }),
        );
        if (!response.ok) throw await providerError(response);
        if (response.body === null)
          throw new Error("The authoring response is missing a streaming body");
        const streamed = await aggregateAnthropicSettingStream(
          response.body,
          diagnosticDelta,
        );
        capture?.setReasoning(streamed.reasoningContent);
        await trace("setting_anthropic_response", streamed);
        return {
          role: "assistant" as const,
          content: streamed.content,
          ...(streamed.reasoningContent === ""
            ? {}
            : { reasoningContent: streamed.reasoningContent }),
          providerState: {
            protocol: "anthropic_messages" as const,
            content: cloneProviderValue(streamed.providerContent),
            ...(streamed.responseId === undefined
              ? {}
              : { responseId: streamed.responseId }),
            ...(streamed.model === undefined ? {} : { model: streamed.model }),
            ...(streamed.stopReason === undefined
              ? {}
              : { stopReason: streamed.stopReason }),
          },
          toolCalls: streamed.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: asArguments(structuredClone(call.arguments)),
          })),
          usage: settingAuthorUsage(normalizeAnthropicUsage(streamed.usage)),
        };
      },
    );
  }
}

// Setting authoring uses the same complete usage projection as play. Missing
// Provider usage stays unavailable instead of being counted as zero.
function settingAuthorUsage(
  usage: ModelHostUsage | undefined,
): SettingAuthorUsage {
  if (usage !== undefined) return structuredClone(usage);
  return usageRecord({
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
}

function settingToolDefinition(
  name: (typeof documentCandidateSettingTools)[number],
  locale: AppLocale = defaultAppLocale,
) {
  const descriptions = settingToolDescriptions[locale];
  const schema = (properties: Record<string, object>, required: string[]) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  const text = { type: "string", minLength: 1 };
  const path = { type: "string", minLength: 1 };
  const cursor = { type: "string", minLength: 1 };
  const limit = { type: "integer", minimum: 1, maximum: 100 };
  const definitions = {
    setting_list: {
      description: descriptions.setting_list,
      schema: schema(
        {
          // World document paths accept any segment that is not "."/".."; an
          // ASCII-only pattern here made directories the author had just
          // created impossible to list back.
          directory: {
            type: "string",
            pattern: "^world(?:/[^\\\\]+)?$",
          },
          limit,
          cursor,
        },
        [],
      ),
    },
    setting_search: {
      description: descriptions.setting_search,
      schema: schema(
        {
          query: { type: "string", minLength: 1, maxLength: 256 },
          within: path,
          caseSensitive: { type: "boolean" },
          limit,
          cursor,
        },
        ["query"],
      ),
    },
    setting_read: {
      description: descriptions.setting_read,
      schema: schema(
        {
          path,
          maxBytes: { type: "integer", minimum: 4, maximum: 65_536 },
          cursor,
        },
        ["path"],
      ),
    },
    setting_write_file: {
      description: descriptions.setting_write_file,
      schema: schema({ path, contents: text }, ["path", "contents"]),
    },
    setting_patch: {
      description: descriptions.setting_patch,
      schema: schema(
        {
          document: text,
          op: { type: "string", enum: ["add", "replace"] },
          locator: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          value: {},
        },
        ["document", "op", "locator", "value"],
      ),
    },
    setting_move: {
      description: descriptions.setting_move,
      schema: schema({ from: text, to: path }, ["from", "to"]),
    },
    setting_preview_candidate: {
      description: descriptions.setting_preview_candidate,
      schema: schema({}, []),
    },
    setting_finish_candidate: {
      description: descriptions.setting_finish_candidate,
      schema: schema({}, []),
    },
  } satisfies Record<
    (typeof documentCandidateSettingTools)[number],
    { description: string; schema: object }
  >;
  return { name, ...definitions[name] };
}

const settingToolDescriptions: Record<
  AppLocale,
  Record<(typeof documentCandidateSettingTools)[number], string>
> = {
  en: {
    setting_list:
      "List the world root or a world/ subdirectory from the current candidate-document snapshot. The root also lists specialized opening and control files. A pagination cursor is valid only for the same query against the candidate snapshot that produced it.",
    setting_search:
      "Search literal source text in world documents from the current candidate snapshot. within may be a world/ directory, world/ document path, @short-ref, or document identity.",
    setting_read:
      "Precisely read a world-document body from the current candidate snapshot by world/ path, @short-ref, or document identity. Read opening and control files through their exact dedicated paths. Write authorization is granted only after every page has been read; later candidate changes do not revoke it.",
    setting_write_file:
      "Create or replace one complete candidate file. path is always a full logical path: a .yaml or .md world document under world/, control/frame.yaml, control/player-views.yaml, control/blocks/*.md, or the root opening.md. A new world document must include a complete body with its $document technical header. When replacing an existing world document, you may omit $document and write back the body returned by setting_read; Runtime preserves the existing title, summary, and aliases. Runtime always decides id and ref: it allocates them for a new document and preserves them for an existing one, regardless of values you supply. Existing world documents and an existing opening.md must be read completely before replacement.",
    setting_patch:
      'Patch one YAML map node by document id, @short-ref, or world/ logical path and revision. op must explicitly be add or replace. locator is a stable array of map keys, for example ["relationships","player","trust"]. The existing document must already have been read completely. Rewrite Markdown documents in full with setting_write_file.',
    setting_move:
      "Move a completely read world document to a new world/ logical path by revision. Use this to repair catalog-directory association while preserving document content and identity.",
    setting_preview_candidate:
      "Run mechanical content-tree checks and the real Prompt Preview against the isolated candidate, returning diagnostics for path association, slots, references, and material coverage. Call this after all final changes; the candidate may finish only after it passes. A failed preview is a normal iteration: repair the diagnostics and call it again.",
    setting_finish_candidate:
      "Call only after setting_preview_candidate has passed for the final changes. It may immediately follow the passing preview in the same model response. It must be the last call in that response and takes no arguments.",
  },
  "zh-CN": {
    setting_list:
      "通过当前候选文档快照列出 world 或 world/ 子目录；根目录同时显示 opening／control 等专用文件。分页 cursor 只能用于产生它的同一候选快照和相同查询。",
    setting_search:
      "通过当前候选文档快照原文字面搜索 world 文档；within 可取 world/ 目录、world/ 文档路径、@短引用或文档身份。",
    setting_read:
      "通过当前候选文档快照按 world/ 路径、@短引用或文档身份精确读取世界文档正文；opening／control 使用精确路径专用读取。只有读完全部分页才获得写授权，此后不因其他修改失效。",
    setting_write_file:
      "创建或整份写入一个候选文件，path 一律是完整逻辑路径：world/ 下的 .yaml 或 .md 世界文档、control/frame.yaml、control/player-views.yaml、control/blocks/*.md，或根级 opening.md。新建世界文档写完整原文并带 $document 技术头；覆盖既有世界文档可以省略 $document，直接写回 setting_read 返回的正文，Runtime 会沿用原有 title、summary 和 aliases。id 和 ref 始终由 Runtime 决定——新建时分配，覆盖时保留原值，你写什么都不会报错。既有 world 文档和既有 opening.md 必须先完整读取。",
    setting_patch:
      '通过 revision 按文档 ID、@短引用或 world/ 逻辑路径 patch 一个 YAML map 节点；op 必须明确选择 add（新增）或 replace（替换），locator 是稳定 map-key 数组，例如 ["关系","对玩家","信任"]。既有文档必须已完整读取。Markdown 文档请用 setting_write_file 整份重写。',
    setting_move:
      "通过 revision 把已完整读取的 world 文档移动到新的 world/ 逻辑路径；用于修复 catalog 目录关联，保留文档内容和身份。",
    setting_preview_candidate:
      "对当前隔离候选运行内容树机械检查和真实 Prompt Preview，并返回路径关联、slot、引用和材料覆盖诊断；所有最终修改后调用，通过后才可结束候选。未通过属于正常迭代，修复后重新调用即可。",
    setting_finish_candidate:
      "setting_preview_candidate 已对最终修改返回自检通过后调用，可以紧接在同一模型响应的自检之后；必须是当前响应的最后一个调用，且不得携带参数。",
  },
};

function items(request: ModelHostExchange): ModelHostAppendItem[] {
  return request.appended;
}

type ProviderRequest = ModelHostExchange;

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
  return {
    model: connection.modelId,
    ...chatReasoningRequest(connection),
    messages: [
      ...chatBootstrapMessages(connection, request),
      ...chatAppend(request),
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
  };
}

function anthropicRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): Record<string, unknown> {
  const tools = providerToolDefinitions(request);
  return {
    model: connection.modelId,
    ...anthropicReasoningRequest(connection),
    system: request.bootstrap.provider.system,
    messages: [
      ...request.bootstrap.provider.messages.filter(
        ({ role }) => role !== "system",
      ),
      ...anthropicAppend(request),
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
  };
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
      ...responsesAppend(request),
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
  return {
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
  };
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
    if (!isRegisteredRuntimeToolName(tool.name))
      throw new Error(
        `Provider tool ${tool.name} uses oneOf, allOf, or anyOf at the input schema root`,
      );
    const current = runtimeToolsForNames([tool.name])[0];
    if (
      current === undefined ||
      hasUnsupportedProviderToolSchemaRoot(current.inputSchema)
    )
      throw new Error(
        `Provider tool ${tool.name} has no portable root-object input schema`,
      );
    // Released play contexts freeze their logical tool universe. Migrate only
    // the Provider wire projection of the old root-union schema; Runtime keeps
    // validating the original source-specific contract and the persisted
    // transcript remains untouched.
    return {
      ...tool,
      inputSchema: structuredClone(current.inputSchema),
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
  const messages = request.bootstrap.provider.messages.map((message) =>
    cloneProviderValue(message),
  );
  return connection.dialect === "cliproxyapi"
    ? attachCacheControlToLastRole(messages, "system")
    : messages;
}

function responsesBootstrapMessages(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  const messages = request.bootstrap.provider.messages.map((message) =>
    responsesBootstrapMessage(message, connection.dialect === "cliproxyapi"),
  );
  return connection.dialect === "cliproxyapi"
    ? attachCacheControlToLastRole(messages, "system")
    : messages;
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

function settingPromptCacheKey(
  connection: ResolvedFileNativeModelConnection,
  messages: readonly SettingAuthorMessage[],
  operationId?: string,
): string {
  const firstAssistant = messages.findIndex(({ role }) => role === "assistant");
  const initialPrefix = messages.slice(
    0,
    firstAssistant < 0 ? messages.length : firstAssistant,
  );
  const stablePrefixScope = JSON.stringify(initialPrefix);
  const scope =
    connection.dialect === "cliproxyapi"
      ? (operationId ?? stablePrefixScope)
      : stablePrefixScope;
  return createHash("sha256")
    .update(
      `${connection.provider}\0${connection.dialect}\0${connection.modelId}\0${scope}`,
    )
    .digest("hex");
}

function chatAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item): unknown[] => {
    if (item.kind === "player") return [{ role: "user", content: item.text }];
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

function anthropicAppend(request: ModelHostExchange): unknown[] {
  const messages: unknown[] = [];
  let toolResults: Record<string, unknown>[] = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const item of items(request)) {
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
    if (item.kind === "player") {
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

function responsesAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item) => {
    if (item.kind === "player") return [{ role: "user", content: item.text }];
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
        : "/messages";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
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

function chatSettingMessages(
  connection: ResolvedFileNativeModelConnection,
  messages: readonly SettingAuthorMessage[],
): unknown[] {
  const translated = messages.map(chatSettingMessage);
  if (connection.dialect !== "cliproxyapi") return translated;
  return attachCacheControlAtIndex(
    attachCacheControlToLastRole(translated, "system"),
    settingPrefixUserIndex(messages),
  );
}

function chatSettingMessage(message: SettingAuthorMessage) {
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  if (message.role === "assistant") {
    const state = message.providerState;
    if (
      state?.protocol === "chat_completions" &&
      validChatAssistantMessage(state.assistantMessage)
    )
      return cloneProviderValue(state.assistantMessage);
    throw continuationError("Chat Completions setting improvement");
  }
  return {
    role: message.role === "system" ? "system" : "user",
    content: message.content,
  };
}

function anthropicSettingMessages(
  source: readonly SettingAuthorMessage[],
): unknown[] {
  const messages: unknown[] = [];
  const cacheableUserIndex = settingPrefixUserIndex(source);
  let toolResults: Record<string, unknown>[] = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const [index, message] of source.entries()) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError === true ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (message.role === "assistant") {
      if (
        message.providerState?.protocol !== "anthropic_messages" ||
        !validAnthropicContent(message.providerState.content)
      )
        throw continuationError("Anthropic Messages setting improvement");
      messages.push({
        role: "assistant",
        content: cloneProviderValue(message.providerState.content),
      });
      continue;
    }
    messages.push({
      role: "user",
      content:
        index === cacheableUserIndex
          ? [
              {
                type: "text",
                text: message.content,
                cache_control: { type: "ephemeral" },
              },
            ]
          : message.content,
    });
  }
  flushToolResults();
  return messages;
}

function responsesSettingInput(
  connection: ResolvedFileNativeModelConnection,
  messages: readonly SettingAuthorMessage[],
): unknown[] {
  const translated = messages.flatMap(responsesSettingMessage);
  if (connection.dialect !== "cliproxyapi") return translated;
  return attachCacheControlAtIndex(
    attachCacheControlToLastRole(translated, "system"),
    settingPrefixUserIndex(messages),
  );
}

function settingPrefixUserIndex(
  messages: readonly SettingAuthorMessage[],
): number {
  const firstAssistant = messages.findIndex(({ role }) => role === "assistant");
  const end = firstAssistant < 0 ? messages.length : firstAssistant;
  let target = -1;
  for (let index = 0; index < end; index += 1)
    if (messages[index]?.role === "user") target = index;
  return target;
}

function attachCacheControlAtIndex(
  messages: unknown[],
  index: number,
): unknown[] {
  const result = cloneProviderValue(messages);
  if (index < 0 || !isRecord(result[index])) return result;
  result[index] = {
    ...result[index],
    cache_control: { type: "ephemeral" },
  };
  return result;
}

function responsesSettingMessage(message: SettingAuthorMessage): unknown[] {
  if (message.role === "tool")
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  if (
    message.role === "assistant" &&
    message.providerState?.protocol === "openai_responses" &&
    validResponsesOutput(message.providerState.output)
  )
    return cloneResponseOutput(message.providerState.output);
  if (message.role === "assistant")
    throw continuationError("OpenAI Responses setting improvement");
  return [{ role: message.role, content: message.content }];
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
                type: "input_text",
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
          },
          "OpenAI Responses",
        ),
      );
      if (!response.ok) throw await providerError(response);
      const payload = isProviderEventStream(response)
        ? await providerStreamResult(response, "Responses API", (body) =>
            aggregateResponsesModelStream(body, diagnosticDelta),
          )
        : await providerJson(response, "Responses API");
      await trace(`${input.tracePrefix}_response`, payload);
      if (!isRecord(payload) || !Array.isArray(payload.output))
        throw unknownProviderResponse("Responses API");
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
): Promise<Value> {
  if (response.body === null)
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its streaming response has no body`,
    );
  try {
    return await read(response.body);
  } catch (error: unknown) {
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
    throw new ModelHostOutcomeUnknownError(
      `${label} request was dispatched but its outcome is unknown`,
      {
        cause: error,
      },
    );
  }
}

function unknownProviderResponse(label: string): ModelHostOutcomeUnknownError {
  return new ModelHostOutcomeUnknownError(
    `${label} was dispatched but its response shape could not be confirmed`,
  );
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Authoring tool arguments must be an object");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
