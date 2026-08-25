import type { ModelProviderKind } from "../../protocol/modelConnections.ts";
import type { ProviderExchangeState } from "./ProviderExchangeState.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import type { RuntimeToolDefinitionStrategy } from "../prompt/FileNativeToolRegistry.ts";

/**
 * Runtime's provider port for an append-only model operation.
 *
 * The compiler owns the bootstrap and prompt-delta contents. A host only
 * transports those already compiled messages and returns provider protocol
 * state; it must not parse play-preset files or invent Runtime tools.
 */
export interface ModelHostToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * The protocol identity frozen for one logical model operation. Credentials
 * are deliberately absent; rotating a secret does not change this binding.
 */
export interface ModelHostBinding {
  provider: ModelProviderKind;
  endpointFingerprint: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  protocolConfigFingerprint: string;
}

export function equalModelHostBinding(
  left: ModelHostBinding,
  right: ModelHostBinding,
): boolean {
  return (
    left.provider === right.provider &&
    left.endpointFingerprint === right.endpointFingerprint &&
    left.modelId === right.modelId &&
    left.contextWindowTokens === right.contextWindowTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.protocolConfigFingerprint === right.protocolConfigFingerprint
  );
}

export type ModelHostAppendItem =
  | {
      kind: "prompt_delta";
      logicalMessages: PromptCompilation["logicalMessages"];
    }
  | {
      kind: "player";
      text: string;
    }
  | {
      kind: "assistant";
      text: string;
      reasoningContent?: string;
      providerState?: ProviderExchangeState;
      toolCalls: ModelHostToolCall[];
    }
  | {
      kind: "tool";
      toolCallId: string;
      markdown: string;
    };

export interface ModelHostExchange {
  bootstrap: PromptCompilation;
  /** Stable definitions for the complete logical operation. */
  toolUniverse?: PromptCompilation["tools"];
  /** Current Runtime execution gate; providers must not own this decision. */
  allowedTools?: string[];
  toolStrategy?: RuntimeToolDefinitionStrategy;
  tools: PromptCompilation["tools"];
  appended: ModelHostAppendItem[];
  /** Stable request identity for traces and scripted hosts. */
  requestId?: string;
  operationId?: string;
  requestAttempt?: number;
  exchange?: number;
  maxOutputTokens: number;
}

export type ModelHostUsageField =
  "provider" | "unavailable" | "derived_provider_fields";

/** Provider-reported usage only; Runtime does not estimate token usage. */
export interface ModelHostUsage {
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  provenance: {
    inputTokens: ModelHostUsageField;
    uncachedInputTokens: ModelHostUsageField;
    cacheReadTokens: ModelHostUsageField;
    cacheWriteTokens: ModelHostUsageField;
    reasoningTokens: ModelHostUsageField;
    outputTokens: ModelHostUsageField;
    totalTokens: ModelHostUsageField;
  };
}

export interface ModelHostResponse {
  text?: string;
  reasoningContent?: string;
  providerState?: ProviderExchangeState;
  usage?: ModelHostUsage;
  toolCalls?: ModelHostToolCall[];
}

/**
 * One fragment received from a streaming Provider response. It never becomes
 * world Authority or committed narrative by itself; the production play call
 * chain may project it into its explicit model-call trace.
 */
export interface ModelHostDelta {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

export interface ModelHostExchangeObserver {
  onDelta?: (delta: ModelHostDelta) => void;
}

export interface ModelHost {
  binding(): ModelHostBinding;
  exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse>;
}

/** The persisted operation binding is unavailable in the current Runtime. */
export class ModelHostBindingMismatchError extends Error {
  readonly kind = "binding_mismatch" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelHostBindingMismatchError";
  }
}

/** A deterministic provider failure: the operation may be failed safely. */
export class ModelHostFailureError extends Error {
  readonly kind = "failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelHostFailureError";
  }
}

/** The provider outcome cannot be replayed without risking a duplicate response. */
export class ModelHostOutcomeUnknownError extends Error {
  readonly kind = "unknown" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelHostOutcomeUnknownError";
  }
}

export type ScriptedModelHostStep =
  | ({ outcome: "response"; continuation?: "available" | "lost" } & Omit<
      ModelHostResponse,
      "providerState"
    > & {
        providerState?: ProviderExchangeState;
        deltas?: ModelHostDelta[];
      })
  | { outcome: "failure"; message: string }
  | { outcome: "unknown"; message: string };

/** Deterministic adapter for exercising the true external ModelHost port. */
export class ScriptedModelHost implements ModelHost {
  readonly requests: ModelHostExchange[] = [];
  readonly #binding: ModelHostBinding;
  readonly #steps: ScriptedModelHostStep[];
  #responseIndex = 0;

  constructor(input: {
    binding: ModelHostBinding;
    steps: ScriptedModelHostStep[];
  }) {
    this.#binding = structuredClone(input.binding);
    this.#steps = structuredClone(input.steps);
  }

  binding(): ModelHostBinding {
    return structuredClone(this.#binding);
  }

  exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    this.requests.push(structuredClone(request));
    const step = this.#steps.shift();
    if (step === undefined)
      return Promise.reject(new Error("scripted ModelHost steps exhausted"));
    if (step.outcome === "failure")
      return Promise.reject(new ModelHostFailureError(step.message));
    if (step.outcome === "unknown")
      return Promise.reject(new ModelHostOutcomeUnknownError(step.message));
    const { outcome: _outcome, continuation, deltas, ...response } = step;
    void _outcome;
    for (const delta of deltas ?? [])
      observer?.onDelta?.(structuredClone(delta));
    const providerState =
      response.providerState ??
      (continuation === "available"
        ? scriptedProviderState(this.#binding.provider, this.#responseIndex)
        : undefined);
    this.#responseIndex += 1;
    return Promise.resolve({
      ...structuredClone(response),
      ...(providerState === undefined
        ? {}
        : { providerState: structuredClone(providerState) }),
    });
  }
}

function scriptedProviderState(
  provider: ModelProviderKind,
  responseIndex: number,
): ProviderExchangeState {
  if (provider === "openai_responses")
    return {
      protocol: "openai_responses",
      output: [],
      responseId: `scripted-${responseIndex}`,
    };
  if (provider === "anthropic_messages")
    return {
      protocol: "anthropic_messages",
      content: [],
      responseId: `scripted-${responseIndex}`,
    };
  return {
    protocol: "chat_completions",
    assistantMessage: { role: "assistant", content: null },
  };
}
