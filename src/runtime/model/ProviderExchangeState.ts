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

export type ProviderExchangeState =
  OpenAIResponsesState | ChatCompletionsState | AnthropicMessagesState;
