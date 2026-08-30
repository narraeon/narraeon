export type ModelUsageField =
  "provider" | "unavailable" | "derived_provider_fields";

/** Provider-reported usage only; Runtime does not estimate token usage. */
export interface ModelUsage {
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  provenance: {
    inputTokens: ModelUsageField;
    uncachedInputTokens: ModelUsageField;
    cacheReadTokens: ModelUsageField;
    cacheWriteTokens: ModelUsageField;
    reasoningTokens: ModelUsageField;
    outputTokens: ModelUsageField;
    totalTokens: ModelUsageField;
  };
}
