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
} from "./ModelHost.ts";
import {
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
import type { ProviderExchangeState } from "./ProviderExchangeState.ts";
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
    const signal = observer?.signal;
    if (signalWasAborted(signal)) throw cancelledModelRequest();
    try {
      if (this.#connection.provider === "chat_completions")
        return await this.#chat(request, observer?.onDelta, signal);
      if (this.#connection.provider === "openai_responses")
        return await this.#responses(request, observer?.onDelta, signal);
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
    if (error instanceof ModelHostCancelledError) throw error;
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
        ...(error instanceof ModelHostFailureError &&
        error.details !== undefined
          ? { details: error.details }
          : {}),
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

function chatAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item): unknown[] => {
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

function responsesAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item) => {
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
