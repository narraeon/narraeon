import type { ModelHostUsage } from "./ModelHost.ts";

export function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { $invalidToolArgumentsJson: value };
  }
}

/** Clone provider-owned state before it enters the logical transcript. */
export function cloneProviderValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  const source = JSON.stringify(value);
  if (typeof source !== "string") return value;
  return JSON.parse(source) as T;
}

export function providerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function usageRecord(
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

export function subtractCachedInput(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
