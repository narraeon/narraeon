import { expect, test } from "vitest";

import {
  aggregateModelUsage,
  emptyAggregatedModelUsage,
  type ModelUsage,
} from "../../src/protocol/modelUsage.ts";

test("usage 聚合逐字段求和且不会把 Provider 未报告伪装成零", () => {
  const first = aggregateModelUsage(
    emptyAggregatedModelUsage(),
    usage({
      inputTokens: 1_000,
      uncachedInputTokens: 600,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      reasoningTokens: 40,
      outputTokens: 120,
      totalTokens: 1_120,
    }),
  );
  const total = aggregateModelUsage(
    first,
    usage({
      inputTokens: 2_000,
      uncachedInputTokens: 1_500,
      cacheReadTokens: 500,
      cacheWriteTokens: null,
      reasoningTokens: 60,
      outputTokens: 180,
      totalTokens: 2_180,
    }),
  );

  expect(total).toMatchObject({
    inputTokens: 3_000,
    uncachedInputTokens: 2_100,
    cacheReadTokens: 800,
    cacheWriteTokens: null,
    reasoningTokens: 100,
    outputTokens: 300,
    totalTokens: 3_300,
  });
  expect(total.provenance).toEqual({
    inputTokens: "derived_provider_fields",
    uncachedInputTokens: "derived_provider_fields",
    cacheReadTokens: "derived_provider_fields",
    cacheWriteTokens: "unavailable",
    reasoningTokens: "derived_provider_fields",
    outputTokens: "derived_provider_fields",
    totalTokens: "derived_provider_fields",
  });
});

function usage(values: Omit<ModelUsage, "provenance">): ModelUsage {
  const provenance = Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      field,
      value === null ? "unavailable" : "provider",
    ]),
  ) as ModelUsage["provenance"];
  return { ...values, provenance };
}
