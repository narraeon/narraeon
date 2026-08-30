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

const modelUsageKeys = [
  "inputTokens",
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "outputTokens",
  "totalTokens",
] as const;

/** A zero baseline used only before any Provider exchange has completed. */
export function emptyAggregatedModelUsage(): ModelUsage {
  return usageWithValue(0, "derived_provider_fields");
}

/**
 * Sum complete Provider usage records without treating an unreported field as
 * zero. Once any exchange lacks a field, that aggregate remains unavailable.
 */
export function aggregateModelUsage(
  current: ModelUsage,
  next: ModelUsage | undefined,
): ModelUsage {
  const result = {} as Record<(typeof modelUsageKeys)[number], number | null>;
  for (const key of modelUsageKeys) {
    const right = next?.[key] ?? null;
    result[key] =
      current[key] === null || right === null ? null : current[key] + right;
  }
  return {
    ...result,
    provenance: Object.fromEntries(
      modelUsageKeys.map((key) => [
        key,
        result[key] === null ? "unavailable" : "derived_provider_fields",
      ]),
    ) as ModelUsage["provenance"],
  };
}

function usageWithValue(value: number, source: ModelUsageField): ModelUsage {
  const values = Object.fromEntries(
    modelUsageKeys.map((key) => [key, value]),
  ) as unknown as Omit<ModelUsage, "provenance">;
  return {
    ...values,
    provenance: Object.fromEntries(
      modelUsageKeys.map((key) => [key, source]),
    ) as ModelUsage["provenance"],
  };
}
