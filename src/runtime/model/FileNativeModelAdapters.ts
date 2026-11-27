import { createHash } from "node:crypto";
import type { AiFailureRecorder } from "./AiFailureLog.ts";
import {
  assertAssistantPrefill,
  assistantPrefillDelta,
  completeAssistantPrefill,
} from "./AssistantPrefill.ts";
import {
  modelCacheStrategy,
  resolveConnection,
  type FileNativeModelConnection,
  type ResolvedFileNativeModelConnection,
} from "./FileNativeModelConnection.ts";
import {
  equalModelHostBinding,
  ModelHostBindingMismatchError,
  ModelHostCancelledError,
  ModelHostFailureError,
  type ModelConnectionPrompt,
  type ModelHost,
  type ModelHostAppendItem,
  type ModelHostBinding,
  type ModelHostExchange,
  type ModelHostExchangeObserver,
  type ModelHostResponse,
  type ModelHostWireRequest,
} from "./ModelHost.ts";
import { withModelRetry } from "./ModelRetry.ts";
import { modelHostTrace, trace } from "./ProviderDiagnostics.ts";
import { validGoogleInteractionsContinuation } from "./ProviderExchangeState.ts";
import {
  cancelledModelRequest,
  providerUrl,
  signalWasAborted,
  type ProviderDispatch,
} from "./ProviderTransport.ts";
import {
  exchangeAnthropic,
  previewAnthropic,
  validAnthropicContent,
} from "./anthropic.ts";
import {
  exchangeGoogle,
  googleExchangeTimeoutMs,
  previewGoogle,
} from "./google-interactions.ts";
import {
  exchangeChat,
  previewChat,
  validChatAssistantMessage,
} from "./openai-chat.ts";
import {
  exchangeResponses,
  previewResponses,
  validResponsesOutput,
} from "./openai-responses.ts";

export type { FileNativeModelConnection } from "./FileNativeModelConnection.ts";

interface ProviderAdapter {
  exchange(
    dispatch: ProviderDispatch,
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
    deadline?: number,
  ): Promise<ModelHostResponse>;
  preview(
    connection: ResolvedFileNativeModelConnection,
    request: ModelHostExchange,
    redactContinuation: boolean,
  ): ModelHostWireRequest;
}

const providers: Record<ModelHostBinding["provider"], ProviderAdapter> = {
  chat_completions: { exchange: exchangeChat, preview: previewChat },
  openai_responses: { exchange: exchangeResponses, preview: previewResponses },
  anthropic_messages: {
    exchange: exchangeAnthropic,
    preview: previewAnthropic,
  },
  google_interactions: { exchange: exchangeGoogle, preview: previewGoogle },
};

const providerContinuationCodecVersion = 1;

export class FileNativeModelHost implements ModelHost {
  readonly #modelPrompt: ModelConnectionPrompt | undefined;
  readonly #connection: ResolvedFileNativeModelConnection;
  readonly #fetch: typeof fetch;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #chatgptPlanAccountFingerprint: string | undefined;

  constructor(
    { modelPrompt, ...connection }: FileNativeModelConnection,
    fetchImplementation: typeof fetch = fetch,
    failureLog?: AiFailureRecorder,
    legacyResponses = false,
  ) {
    this.#modelPrompt = structuredClone(modelPrompt);
    this.#connection = resolveConnection(connection, legacyResponses);
    this.#chatgptPlanAccountFingerprint =
      connection.chatgptPlan === undefined
        ? undefined
        : createHash("sha256")
            .update(`chatgpt-plan\0${connection.chatgptPlan.accountId}`)
            .digest("hex");
    this.#fetch = fetchImplementation;
    this.#failureLog = failureLog;
  }

  modelPrompt(): ModelConnectionPrompt | undefined {
    return this.#modelPrompt;
  }

  allowsAutomaticFollowups(): boolean {
    return this.#connection.chatgptPlan?.allowFollowups ?? true;
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
      ...(this.#chatgptPlanAccountFingerprint === undefined
        ? {}
        : {
            chatgptPlanAccountFingerprint: this.#chatgptPlanAccountFingerprint,
          }),
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
            ...(this.#connection.responsesTurnInstructions === undefined
              ? {}
              : {
                  responsesTurnInstructions:
                    this.#connection.responsesTurnInstructions,
                }),
            cachePolicy: modelCacheStrategy(this.#connection),
            providerContinuationCodecVersion,
          }),
        )
        .digest("hex"),
    };
  }

  /** Existing operations can refer to a binding fingerprint frozen before Responses capabilities existed. */
  matchesBinding(binding: ModelHostBinding): boolean {
    if (equalModelHostBinding(this.binding(), binding)) return true;
    if (
      this.#connection.provider !== "openai_responses" ||
      this.#connection.chatgptPlan !== undefined
    )
      return false;
    const legacy = new FileNativeModelHost(
      this.#connection,
      this.#fetch,
      this.#failureLog,
      true,
    );
    return equalModelHostBinding(legacy.binding(), binding);
  }

  freezeRequest(request: ModelHostExchange): ModelHostExchange {
    const frozen = structuredClone(request);
    if (frozen.modelConfig === undefined) {
      const {
        baseUrl: _baseUrl,
        authMode: _authMode,
        apiKey: _apiKey,
        chatgptPlan: _chatgptPlan,
        ...config
      } = this.#connection;
      void _baseUrl;
      void _authMode;
      void _apiKey;
      void _chatgptPlan;
      frozen.modelConfig = {
        ...config,
        ...(this.#chatgptPlanAccountFingerprint === undefined
          ? {}
          : {
              chatgptPlanAccountFingerprint:
                this.#chatgptPlanAccountFingerprint,
            }),
      };
    }
    return frozen;
  }

  #requestHost(request: ModelHostExchange): FileNativeModelHost {
    if (request.modelConfig === undefined) return this;
    if (request.modelConfig.provider !== this.#connection.provider)
      throw new ModelHostBindingMismatchError(
        "The request protocol does not match the selected model host",
      );
    const { chatgptPlanAccountFingerprint, ...config } = request.modelConfig;
    if (chatgptPlanAccountFingerprint !== this.#chatgptPlanAccountFingerprint)
      throw new ModelHostBindingMismatchError(
        "The frozen request belongs to a different ChatGPT plan connection",
      );
    return new FileNativeModelHost(
      {
        ...config,
        ...(this.#connection.chatgptPlan === undefined
          ? {}
          : { chatgptPlan: this.#connection.chatgptPlan }),
        supportsAllowedTools:
          request.modelConfig.supportsAllowedTools ??
          this.#connection.supportsAllowedTools,
        // A frozen request without this choice predates the transcript breakpoint.
        cacheSuffixBreakpoint:
          request.modelConfig.cacheSuffixBreakpoint === true,
        baseUrl: this.#connection.baseUrl,
        ...(this.#connection.authMode === undefined
          ? {}
          : { authMode: this.#connection.authMode }),
        apiKey: this.#connection.apiKey,
      },
      this.#fetch,
      this.#failureLog,
      request.modelConfig.provider === "openai_responses" &&
        request.modelConfig.responsesTurnInstructions === undefined,
    );
  }

  exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    const host = this.#requestHost(request);
    request = structuredClone(request);
    assertAssistantPrefill(host.freezeRequest(request));
    const deadline =
      host.#connection.provider === "google_interactions"
        ? Date.now() + googleExchangeTimeoutMs
        : undefined;
    const dispatch = () =>
      host.#exchange(
        request,
        {
          ...observer,
          onDelta: assistantPrefillDelta(request, observer?.onDelta),
        },
        deadline,
      );
    const result =
      host.#connection.chatgptPlan === undefined
        ? withModelRetry(dispatch, {
            signal: observer?.signal,
            onRetry: observer?.onRetry,
            deadline,
          })
        : dispatch();
    return result.then((response) => {
      try {
        return completeAssistantPrefill(request, response);
      } catch (error) {
        observer?.onDelta?.({ kind: "tool", text: "" });
        throw new ModelHostFailureError(
          error instanceof Error
            ? error.message
            : "Invalid assistant prefix response",
          { cause: error },
        );
      }
    });
  }

  /** A connection test uses the adapters without retries, continuation or local traces. */
  exchangeOnce(
    request: ModelHostExchange,
    observer: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    return this.#exchange(request, observer, undefined, true);
  }

  async #exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
    deadline?: number,
    singleRequest = false,
  ): Promise<ModelHostResponse> {
    assertExchangeCompatibility(this.#connection, request);
    if (!singleRequest)
      await trace("model_host_exchange", modelHostTrace(request));
    const signal = observer?.signal;
    if (signalWasAborted(signal)) throw cancelledModelRequest();
    const dispatch = {
      connection: this.#connection,
      fetchImplementation: this.#fetch,
      failureLog: singleRequest ? undefined : this.#failureLog,
      trace: singleRequest ? undefined : trace,
      singleRequest,
    };
    try {
      return await providers[this.#connection.provider].exchange(
        dispatch,
        request,
        observer,
        deadline,
      );
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
    redactContinuation: boolean,
  ): ModelHostWireRequest {
    assertExchangeCompatibility(this.#connection, request);
    return providers[this.#connection.provider].preview(
      this.#connection,
      request,
      redactContinuation,
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

/** Uses the same native payload checks as the production request encoders. */
export function validAuthoringNativeContinuation(
  items: readonly ModelHostAppendItem[],
  provider: ModelHostBinding["provider"],
): boolean {
  return items.every((item) => {
    if (item.kind !== "assistant") return true;
    const state = item.providerState;
    if (state?.protocol !== provider) return false;
    if (state.protocol === "chat_completions")
      return validChatAssistantMessage(state.assistantMessage);
    if (state.protocol === "openai_responses")
      return validResponsesOutput(state.output);
    if (state.protocol === "anthropic_messages")
      return validAnthropicContent(state.content);
    return validGoogleInteractionsContinuation(state.steps);
  });
}
