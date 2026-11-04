export interface OpenAIResponsesState {
  protocol: "openai_responses";
  output: unknown[];
  responseId?: string;
}

export interface ChatCompletionsState {
  protocol: "chat_completions";
  /** Raw assistant message, including provider-specific reasoning fields. */
  assistantMessage: unknown;
}

export interface AnthropicMessagesState {
  protocol: "anthropic_messages";
  /** Raw content blocks, including thinking/redacted/signature fields. */
  content: unknown[];
  responseId?: string;
  model?: string;
  stopReason?: string | null;
}

export interface GoogleInteractionsState {
  protocol: "google_interactions";
  /** Complete native steps, including opaque signatures and extensions. */
  steps: unknown[];
}

/** Check known structural requirements without removing unknown fields. */
export function validGoogleInteractionsSteps(
  value: unknown,
): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((step: unknown) => {
    if (
      !isRecord(step) ||
      typeof step.type !== "string" ||
      step.type.length === 0
    )
      return false;
    if (step.type === "function_call") {
      if (
        typeof step.id !== "string" ||
        step.id.length === 0 ||
        ids.has(step.id) ||
        typeof step.name !== "string" ||
        step.name.length === 0 ||
        !isRecord(step.arguments)
      )
        return false;
      ids.add(step.id);
    }
    if (step.type === "model_output" && !validContent(step.content))
      return false;
    if (
      step.type === "thought" &&
      (typeof step.signature !== "string" ||
        step.signature.length === 0 ||
        (step.summary !== undefined && !validContent(step.summary)))
    )
      return false;
    return true;
  });
}

/** Empty terminal results are valid, but an assistant history item must replay steps. */
export function validGoogleInteractionsContinuation(
  value: unknown,
): value is Record<string, unknown>[] {
  return validGoogleInteractionsSteps(value) && value.length > 0;
}

function validContent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (part: unknown) =>
        isRecord(part) &&
        typeof part.type === "string" &&
        part.type.length > 0 &&
        (part.type !== "text" || typeof part.text === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ProviderExchangeState =
  | OpenAIResponsesState
  | ChatCompletionsState
  | AnthropicMessagesState
  | GoogleInteractionsState;
