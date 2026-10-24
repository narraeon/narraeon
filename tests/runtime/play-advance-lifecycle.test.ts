import { describe, expect, test } from "vitest";
import type { PlayAdvanceBase } from "../../src/runtime/play/FileNativePlayAdvanceStore.ts";
import {
  dispatchFailureEnding,
  emptyResponseEnding,
  lastEndingCancelled,
  noContinuationEnding,
  PlayAdvanceLifecycle,
  settlementFailureEnding,
  type PlayAdvanceLedger,
} from "../../src/runtime/play/PlayAdvanceLifecycle.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostCancelledError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  type ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";

const request = {
  exchange: 2,
  messages: [{ role: "user", text: "进入房间。" }],
} as unknown as ModelHostExchange;

const responseAdvance = {
  schemaVersion: 1,
  kind: "play_advance",
  advanceKind: "response",
  worldId: "world-a",
  chainId: "chain-a",
  advanceId: "response:1",
  operationId: "response:1",
  parentHead: "commit:1",
  eventId: 3,
  exchange: 1,
  attempt: 1,
  createdAt: 0,
} satisfies PlayAdvanceBase;

const playerAdvance = {
  schemaVersion: 1,
  kind: "play_advance",
  advanceKind: "player",
  worldId: "world-a",
  chainId: "chain-a",
  advanceId: "player:start",
  operationId: "player:start",
  parentHead: "commit:1",
  eventId: 2,
  exchangeId: "start",
  playerText: "进入房间。",
  context: "fresh",
  transcriptStart: 0,
  exchange: 1,
  createdAt: 0,
} satisfies PlayAdvanceBase;

function ledger(overrides: Partial<PlayAdvanceLedger> = {}): PlayAdvanceLedger {
  return {
    status: "running",
    canRetry: false,
    lastRequest: null,
    lastRequestAttempt: 0,
    lastFailure: null,
    events: [],
    nextEventId: 1,
    ...overrides,
  };
}

/** In-memory ports: records what was persisted and which markers were cleared. */
function harness() {
  const persisted: PlayAdvanceLedger[] = [];
  const cleared: PlayAdvanceBase[] = [];
  const lifecycle = new PlayAdvanceLifecycle<PlayAdvanceLedger>({
    persist: (session) => {
      persisted.push(structuredClone(session));
      return Promise.resolve();
    },
    clearMarker: (advance) => {
      cleared.push(advance);
      return Promise.resolve();
    },
  });
  return { lifecycle, persisted, cleared };
}

describe("play advance endings", () => {
  test("a completed narrative leaves the chain ready with no failure and clears its marker", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({
      canRetry: false,
      lastFailure: null,
      lastFailureKind: "retryable",
    });
    let notified = 0;

    await lifecycle.end(
      session,
      { kind: "ready" },
      responseAdvance,
      () => notified++,
    );

    expect(session).toMatchObject({
      status: "ready",
      canRetry: false,
      lastFailure: null,
    });
    expect(session).not.toHaveProperty("lastFailureKind");
    expect(session.events).toEqual([]);
    expect(cleared).toEqual([responseAdvance]);
    expect(notified).toBe(1);
  });

  test("a follow-up cancelled after the narrative records the cancellation and stays ready", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger();

    await lifecycle.end(
      session,
      { kind: "ready", followupsCancelled: true },
      null,
    );

    expect(session).toMatchObject({ status: "ready", canRetry: false });
    expect(session.events).toEqual([
      {
        id: 1,
        kind: "cancellation",
        message:
          "The player cancelled the remaining follow-up generation after the narrative was committed.",
      },
    ]);
    expect(lastEndingCancelled(session)).toBe(true);
    expect(cleared).toEqual([]);
  });

  test("a committed player message is interrupted with its frozen request ready to continue", async () => {
    const { lifecycle, persisted, cleared } = harness();
    const session = ledger({ lastRequestAttempt: 4 });

    await lifecycle.end(
      session,
      { kind: "resumable", reason: "player_committed", request },
      playerAdvance,
    );

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: true,
      lastRequestAttempt: 0,
      lastFailure:
        "The player message is committed; the frozen model request is ready to continue.",
      lastFailureKind: "retryable",
    });
    expect(session.lastRequest).toEqual(request);
    expect(session.lastRequest).not.toBe(request);
    expect(persisted).toHaveLength(1);
    expect(cleared).toEqual([playerAdvance]);
  });

  test("a settled tool step is interrupted with the continuation request ready", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger();

    await lifecycle.end(
      session,
      { kind: "resumable", reason: "tool_step_settled", request },
      responseAdvance,
    );

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: true,
      lastFailure:
        "The completed tool response is settled; its frozen continuation request is ready.",
      lastFailureKind: "retryable",
    });
    expect(cleared).toEqual([responseAdvance]);
  });

  test("a cancellation before dispatch keeps the frozen request resumable and interrupts the streaming event", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({
      events: [
        {
          id: 3,
          kind: "assistant",
          text: "",
          status: "streaming",
          responseKind: "pending",
          exchange: 1,
          attempt: 2,
        },
      ],
      nextEventId: 4,
    });

    await lifecycle.end(
      session,
      {
        kind: "cancelled_before_dispatch",
        request,
        attempt: 2,
        streamingEventId: 3,
      },
      responseAdvance,
    );

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: true,
      lastRequestAttempt: 1,
      lastFailure:
        "The player cancelled before the next Provider dispatch; the frozen request can be resumed without replaying a completed model result.",
    });
    expect(session).not.toHaveProperty("lastFailureKind");
    expect(session.lastRequest).toEqual(request);
    expect(session.events[0]).toMatchObject({ status: "interrupted" });
    expect(session.events.at(-1)).toMatchObject({ kind: "cancellation" });
    expect(lastEndingCancelled(session)).toBe(true);
    expect(cleared).toEqual([responseAdvance]);
  });

  test("a cancellation before the first dispatch never goes below attempt zero", async () => {
    const { lifecycle } = harness();
    const session = ledger();

    await lifecycle.end(
      session,
      { kind: "cancelled_before_dispatch", request, attempt: 1 },
      null,
    );

    expect(session.lastRequestAttempt).toBe(0);
    expect(session.canRetry).toBe(true);
  });

  test("a cancellation after dispatch is not replayable", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({
      status: "running",
      events: [
        {
          id: 3,
          kind: "assistant",
          text: "",
          status: "streaming",
          responseKind: "pending",
          exchange: 1,
          attempt: 1,
        },
      ],
      nextEventId: 4,
      lastRequest: request,
      lastRequestAttempt: 1,
    });

    await lifecycle.end(
      session,
      {
        kind: "cancelled_after_dispatch",
        message: "The player cancelled the dispatched model request.",
        streamingEventId: 3,
      },
      responseAdvance,
    );

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: false,
      lastFailure: "The player cancelled the dispatched model request.",
      lastRequest: request,
    });
    expect(session).not.toHaveProperty("lastFailureKind");
    expect(session.events[0]).toMatchObject({ status: "interrupted" });
    expect(session.events.at(-1)).toEqual({
      id: 4,
      kind: "cancellation",
      message: "The player cancelled the dispatched model request.",
    });
    expect(cleared).toEqual([responseAdvance]);
  });

  test("a failure records its kind and whether the player may retry, and clears its marker", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({
      events: [
        {
          id: 3,
          kind: "assistant",
          text: "",
          status: "streaming",
          responseKind: "pending",
          exchange: 1,
          attempt: 1,
        },
      ],
      nextEventId: 4,
    });

    await lifecycle.end(
      session,
      {
        kind: "failed",
        message: "provider rejected",
        failureKind: "provider_error",
        canRetry: false,
        streamingEventId: 3,
      },
      responseAdvance,
    );

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: false,
      lastFailure: "provider rejected",
      lastFailureKind: "provider_error",
    });
    expect(session.events[0]).toMatchObject({ status: "interrupted" });
    expect(session.events.at(-1)).toEqual({
      id: 4,
      kind: "failure",
      message: "provider rejected",
      failureKind: "provider_error",
    });
    expect(lastEndingCancelled(session)).toBe(false);
    expect(cleared).toEqual([responseAdvance]);
  });

  test("a response without a continuation payload is a context failure that cannot retry", async () => {
    const { lifecycle } = harness();
    const session = ledger({ lastRequest: request, lastRequestAttempt: 0 });

    await lifecycle.end(session, noContinuationEnding(), responseAdvance);

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: false,
      lastFailure:
        "The complete model response has no provider-native continuation payload; use a fresh context.",
      lastFailureKind: "context_unavailable",
    });
    expect(session.lastRequest).toEqual(request);
  });

  test("a response with neither text nor a tool call fails as other and cannot retry", async () => {
    const { lifecycle } = harness();
    const session = ledger();

    await lifecycle.end(session, emptyResponseEnding(), responseAdvance);

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: false,
      lastFailure: "The model returned neither text nor a complete tool call.",
      lastFailureKind: "other",
    });
  });

  test("a notify callback runs only when the caller supplies one", async () => {
    const { lifecycle } = harness();
    let notified = 0;

    await lifecycle.end(ledger(), { kind: "ready" }, null);
    await lifecycle.end(ledger(), { kind: "ready" }, null, () => notified++);

    expect(notified).toBe(1);
  });
});

describe("error to ending mapping", () => {
  test.each([
    [
      "a cancelled dispatch is not replayable",
      new ModelHostCancelledError("cancelled by player"),
      { kind: "cancelled_after_dispatch", message: "cancelled by player" },
    ],
    [
      "an outcome-unknown dispatch needs a fresh context",
      new ModelHostOutcomeUnknownError("stream ended early"),
      {
        kind: "failed",
        failureKind: "outcome_unknown",
        canRetry: false,
        message: "stream ended early",
      },
    ],
    [
      "a continuation that no longer binds needs a fresh context",
      new ModelHostContinuationError("continuation gone"),
      {
        kind: "failed",
        failureKind: "context_unavailable",
        canRetry: false,
      },
    ],
    [
      "a binding mismatch needs a fresh context",
      new ModelHostBindingMismatchError("binding changed"),
      {
        kind: "failed",
        failureKind: "context_unavailable",
        canRetry: false,
      },
    ],
    [
      "a plain provider failure may be retried by the player",
      new ModelHostFailureError("rate limited"),
      { kind: "failed", failureKind: "retryable", canRetry: true },
    ],
    [
      "a provider output limit needs a fresh context",
      new ModelHostFailureError("output limit", {
        details: { code: "model_output_limit" },
      }),
      { kind: "failed", failureKind: "output_limit", canRetry: false },
    ],
    [
      "an unexpected error is other and cannot retry",
      new Error("boom"),
      {
        kind: "failed",
        failureKind: "other",
        canRetry: false,
        message: "boom",
      },
    ],
  ])("%s", (_name, error, expected) => {
    expect(dispatchFailureEnding(error, 7)).toMatchObject({
      ...expected,
      ...(expected.kind === "failed" ? { streamingEventId: 7 } : {}),
    });
  });

  test("a non-error dispatch failure falls back to the interruption message", () => {
    expect(dispatchFailureEnding("boom", 7)).toMatchObject({
      kind: "failed",
      message: "The model request was interrupted.",
      failureKind: "other",
      canRetry: false,
    });
  });

  test("a settlement failure never grants a retry, even for a provider failure", () => {
    expect(
      settlementFailureEnding(
        new ModelHostFailureError("rate limited"),
        "Call-chain processing failed.",
      ),
    ).toEqual({
      kind: "failed",
      message: "rate limited",
      failureKind: "provider_error",
      canRetry: false,
    });
    expect(
      settlementFailureEnding(
        new ModelHostContinuationError("gone"),
        "Call-chain processing failed.",
      ),
    ).toMatchObject({ failureKind: "context_unavailable", canRetry: false });
  });

  test("a settlement failure without an error message uses its own fallback", () => {
    expect(
      settlementFailureEnding(
        undefined,
        "Failed to write the original player text.",
      ),
    ).toMatchObject({
      message: "Failed to write the original player text.",
      failureKind: "other",
    });
  });
});

describe("recovery of an advance a process exit cut off", () => {
  const streamingChain = ledger({
    lastRequest: request,
    events: [
      {
        id: 3,
        kind: "assistant",
        text: "",
        status: "streaming",
        responseKind: "pending",
        exchange: 1,
        attempt: 1,
      },
    ],
    nextEventId: 4,
  });

  test("an interrupted model request that can still resume is retryable", async () => {
    const { lifecycle, cleared } = harness();
    const session = structuredClone(streamingChain);

    await lifecycle.recoverAbandoned(session, responseAdvance, false);

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: true,
      lastFailure:
        "The service stopped while the model request was in progress; retry to call the model again.",
      lastFailureKind: "retryable",
    });
    expect(session.events[0]).toMatchObject({ status: "interrupted" });
    expect(session.events.at(-1)).toMatchObject({
      kind: "failure",
      failureKind: "retryable",
    });
    expect(cleared).toEqual([responseAdvance]);
  });

  test("a world that moved past the persisted head requires a fresh context", async () => {
    const { lifecycle } = harness();
    const session = structuredClone(streamingChain);

    await lifecycle.recoverAbandoned(session, responseAdvance, true);

    expect(session).toMatchObject({
      canRetry: false,
      lastFailure:
        "The service stopped after the world was updated; use a fresh context.",
      lastFailureKind: "other",
    });
  });

  test("an interrupted player message requires a fresh context", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({ lastRequest: request });

    await lifecycle.recoverAbandoned(session, playerAdvance, false);

    expect(session).toMatchObject({
      canRetry: false,
      lastFailure:
        "The service stopped while saving the player message; use a fresh context.",
      lastFailureKind: "other",
    });
    expect(cleared).toEqual([playerAdvance]);
  });

  test("a chain with no frozen request cannot be retried", async () => {
    const { lifecycle, cleared } = harness();
    const session = ledger({ status: "running" });

    await lifecycle.recoverAbandoned(session, null, false);

    expect(session).toMatchObject({
      status: "interrupted",
      canRetry: false,
      lastFailure:
        "The service stopped before preparing a model request; use a fresh context.",
      lastFailureKind: "other",
    });
    expect(cleared).toEqual([]);
  });
});

describe("beginning a dispatch", () => {
  test("a dispatch clears the previous failure and freezes its request", () => {
    const { lifecycle } = harness();
    const session = ledger({
      status: "interrupted",
      canRetry: true,
      lastFailure: "earlier failure",
      lastFailureKind: "retryable",
    });

    lifecycle.beginDispatch(session, request, 3);

    expect(session).toMatchObject({
      status: "running",
      canRetry: false,
      lastFailure: null,
      lastRequestAttempt: 3,
    });
    expect(session).not.toHaveProperty("lastFailureKind");
    expect(session.lastRequest).toEqual(request);
    expect(session.lastRequest).not.toBe(request);
  });
});
