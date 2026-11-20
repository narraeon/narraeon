import { expect, test } from "vitest";
import {
  currentRetryEvidence,
  latestAuthoringCalls,
  supersededPlayEvents,
} from "../../src/shared/latest-model-attempts.ts";
import type { V1PlayCallChainEvent } from "../../src/protocol/v1.ts";

test("legacy play attempts discard only superseded failures and preserve settled independent steps", () => {
  const events: V1PlayCallChainEvent[] = [
    { id: 1, kind: "player", text: "Go", context: "fresh", exchangeId: "send" },
    {
      id: 2,
      kind: "assistant",
      text: "settled tool step",
      status: "completed",
      exchange: 1,
      attempt: 1,
    },
    {
      id: 3,
      kind: "tool_result",
      callId: "write",
      name: "world_patch",
      ok: true,
      markdown: "Changed once",
      replayed: false,
    },
    {
      id: 4,
      kind: "assistant",
      text: "partial",
      status: "interrupted",
      exchange: 2,
      attempt: 1,
    },
    { id: 5, kind: "failure", message: "old failure" },
    {
      id: 6,
      kind: "assistant",
      text: "",
      status: "interrupted",
      exchange: 9,
      attempt: 2,
    },
    { id: 7, kind: "cancellation", message: "stopped" },
    {
      id: 8,
      kind: "assistant",
      text: "",
      status: "streaming",
      exchange: 20,
      attempt: 3,
    },
  ];
  expect(supersededPlayEvents(events)).toEqual([4, 5, 6, 7]);
  events.push({
    id: 9,
    kind: "player",
    text: "Another send",
    context: "append",
    exchangeId: "next",
  });
  events.push({
    id: 10,
    kind: "assistant",
    text: "",
    status: "streaming",
    exchange: 21,
    attempt: 2,
  });
  expect(supersededPlayEvents(events)).toEqual([4, 5, 6, 7]);
});

test("author public model preserves a completed tool result even if a later retry references it", () => {
  const calls = [
    { id: "settled", status: "completed", assistantItemIndex: 1 },
    { id: "failed", status: "interrupted", retryOf: "settled" },
    { id: "cancelled", status: "cancelled", retryOf: "failed" },
    { id: "live", status: "attempted", retryOf: "cancelled" },
  ];
  expect(latestAuthoringCalls(calls).map(({ id }) => id)).toEqual([
    "settled",
    "live",
  ]);
});

test("automatic retry projection keeps only its current waiting notice, never completed rows", () => {
  const retries = [
    {
      retry: 1,
      reason: "rate_limit" as const,
      waitMs: 1000,
      retryAt: 1000,
      status: "dispatching" as const,
    },
    {
      retry: 2,
      reason: "rate_limit" as const,
      waitMs: 2000,
      retryAt: 3000,
      status: "waiting" as const,
    },
  ];
  expect(currentRetryEvidence(retries, true)).toEqual([retries[1]]);
  expect(currentRetryEvidence(retries, false)).toBeUndefined();
  expect(
    currentRetryEvidence([{ ...retries[1]!, status: "dispatching" }], true),
  ).toBeUndefined();
});
