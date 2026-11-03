// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";
import {
  aggregateModelUsage,
  emptyAggregatedModelUsage,
  type ModelUsage,
} from "../../src/protocol/modelUsage.ts";
import { ModelUsageBreakdown } from "../../src/web/ModelUsageBreakdown.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

test("Google 的 Provider 计量和聚合不声称思考包含于输出", () => {
  const usage: ModelUsage = {
    accounting: "google_interactions",
    inputTokens: 11,
    uncachedInputTokens: null,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: 245,
    outputTokens: 90,
    totalTokens: 346,
    provenance: {
      inputTokens: "provider",
      uncachedInputTokens: "unavailable",
      cacheReadTokens: "provider",
      cacheWriteTokens: "unavailable",
      reasoningTokens: "provider",
      outputTokens: "provider",
      totalTokens: "provider",
    },
  };
  setWebLocale("en");
  render(
    createElement(ModelUsageBreakdown, {
      usage: aggregateModelUsage(emptyAggregatedModelUsage(), usage),
      showProvenance: true,
    }),
  );
  expect(screen.getByText("Reasoning")).toBeTruthy();
  expect(screen.getByText("Output")).toBeTruthy();
  expect(screen.queryByText("Output (includes reasoning)")).toBeNull();
  expect(screen.getByText(/relationships are not inferred/)).toBeTruthy();
});
