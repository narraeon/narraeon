import type { PlayFailureKind } from "../../protocol/playFailure.ts";
import type {
  V1PlayCallChainEvent,
  V1PlayCallChainStatus,
} from "../../protocol/v1.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostCancelledError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  modelHostFailureRequiresFreshContext,
  type ModelHostExchange,
} from "../model/ModelHost.ts";
import type { PlayAdvanceBase } from "./FileNativePlayAdvanceStore.ts";
import { classifyPlayFailure } from "./PlayFailure.ts";

/**
 * The durable fields a play advance's ending writes. A play call chain session
 * satisfies this structurally; nothing else on the session is an ending's concern.
 */
export interface PlayAdvanceLedger {
  status: V1PlayCallChainStatus;
  canRetry: boolean;
  lastRequest: ModelHostExchange | null;
  lastRequestAttempt: number;
  lastFailure: string | null;
  lastFailureKind?: PlayFailureKind;
  events: V1PlayCallChainEvent[];
  nextEventId: number;
}

/**
 * How one play advance ends (ADR-0030, ADR-0044, ADR-0048). `end` is the only
 * writer of the status, retry, failure and event fields an ending sets, and
 * the only place that clears the in-progress advance marker.
 */
export type PlayAdvanceEnding =
  /** The narrative is committed. A cancelled follow-up is recorded without interrupting the chain. */
  | { kind: "ready"; followupsCancelled?: boolean }
  /** Settled, with a frozen request the player continues without replaying a result. */
  | {
      kind: "resumable";
      reason: "player_committed" | "tool_step_settled";
      request: ModelHostExchange;
    }
  /** Cancelled before a Provider dispatch: the frozen request can be resumed (ADR-0030). */
  | {
      kind: "cancelled_before_dispatch";
      request: ModelHostExchange;
      attempt: number;
      streamingEventId?: number | undefined;
    }
  /** Cancelled after a dispatch: the result cannot be replayed (ADR-0030). */
  | {
      kind: "cancelled_after_dispatch";
      message: string;
      streamingEventId?: number | undefined;
    }
  /** Failed or abandoned. `canRetry` says whether the player may retry the frozen request. */
  | {
      kind: "failed";
      message: string;
      failureKind: PlayFailureKind;
      canRetry: boolean;
      streamingEventId?: number | undefined;
    };

/** Storage and presentation the lifecycle writes through; supplied by the call chain. */
export interface PlayAdvanceLifecyclePorts<Session extends PlayAdvanceLedger> {
  /** Durable write of the session. It runs before the marker is cleared. */
  persist(session: Session): Promise<void>;
  /** Clears the in-progress marker of the advance this ending settles (ADR-0044). */
  clearMarker(advance: PlayAdvanceBase): Promise<void>;
}

const messages = {
  playerCommitted:
    "The player message is committed; the frozen model request is ready to continue.",
  toolStepSettled:
    "The completed tool response is settled; its frozen continuation request is ready.",
  cancelledBeforeDispatch:
    "The player cancelled before the next Provider dispatch; the frozen request can be resumed without replaying a completed model result.",
  followupsCancelled:
    "The player cancelled the remaining follow-up generation after the narrative was committed.",
  noContinuation:
    "The complete model response has no provider-native continuation payload; use a fresh context.",
  noOutput: "The model returned neither text nor a complete tool call.",
  serviceStoppedAfterHead:
    "The service stopped after the world was updated; use a fresh context.",
  serviceStoppedSavingPlayer:
    "The service stopped while saving the player message; use a fresh context.",
  serviceStoppedRetryable:
    "The service stopped while the model request was in progress; retry to call the model again.",
  serviceStoppedNoRequest:
    "The service stopped before preparing a model request; use a fresh context.",
  dispatchInterrupted: "The model request was interrupted.",
};

export class PlayAdvanceLifecycle<Session extends PlayAdvanceLedger> {
  readonly #ports: PlayAdvanceLifecyclePorts<Session>;

  constructor(ports: PlayAdvanceLifecyclePorts<Session>) {
    this.#ports = ports;
  }

  /**
   * Marks a Provider dispatch as in progress. `running` is not an ending: it is
   * the state that every dispatch replaces with an ending before it returns.
   */
  beginDispatch(session: Session, request: ModelHostExchange, attempt: number) {
    session.status = "running";
    session.canRetry = false;
    session.lastFailure = null;
    delete session.lastFailureKind;
    session.lastRequest = structuredClone(request);
    session.lastRequestAttempt = attempt;
  }

  /**
   * Applies an ending, persists the session, then clears the advance marker
   * and notifies. Every ending of an advance goes through here, so no path
   * can persist without clearing the marker it settles.
   */
  async end(
    session: Session,
    ending: PlayAdvanceEnding,
    advance: PlayAdvanceBase | null,
    notify?: () => void,
  ): Promise<void> {
    applyEnding(session, ending);
    await this.#ports.persist(session);
    if (advance !== null) await this.#ports.clearMarker(advance);
    notify?.();
  }

  /**
   * Ends an advance that a process exit cut off (ADR-0044). Nothing is
   * replayed: the exchange is interrupted, and only the chain's own frozen
   * request can be retried, and only while the world has not moved on.
   */
  async recoverAbandoned(
    session: Session,
    advance: PlayAdvanceBase | null,
    headMoved: boolean,
  ): Promise<void> {
    const playerPhase = advance?.advanceKind === "player";
    const streaming = playerPhase
      ? undefined
      : session.events.findLast(
          (event) =>
            event.kind === "assistant" &&
            event.status === "streaming" &&
            (advance === null || event.id === advance.eventId),
        );
    const canRetry = !headMoved && !playerPhase && session.lastRequest !== null;
    const message = headMoved
      ? messages.serviceStoppedAfterHead
      : playerPhase
        ? messages.serviceStoppedSavingPlayer
        : canRetry
          ? messages.serviceStoppedRetryable
          : messages.serviceStoppedNoRequest;
    await this.end(
      session,
      {
        kind: "failed",
        message,
        failureKind: canRetry ? "retryable" : "other",
        canRetry,
        streamingEventId: streaming?.id,
      },
      advance,
    );
  }
}

/**
 * The ending of an exchange that raised an error before its response was
 * settled. Cancellation after dispatch is named explicitly here and is never
 * a retry, even though `ModelHostCancelledError` is also an outcome-unknown
 * error (ADR-0030).
 */
export function dispatchFailureEnding(
  error: unknown,
  streamingEventId: number,
): PlayAdvanceEnding {
  const message = errorMessage(error, messages.dispatchInterrupted);
  if (error instanceof ModelHostCancelledError)
    return { kind: "cancelled_after_dispatch", message, streamingEventId };
  const requiresFreshContext =
    error instanceof ModelHostBindingMismatchError ||
    error instanceof ModelHostContinuationError ||
    error instanceof ModelHostOutcomeUnknownError ||
    modelHostFailureRequiresFreshContext(error);
  const canRetry =
    !requiresFreshContext && error instanceof ModelHostFailureError;
  return {
    kind: "failed",
    message,
    failureKind: classifyPlayFailure(error, canRetry),
    canRetry,
    streamingEventId,
  };
}

/**
 * The ending of an error raised after a response was read or a player message
 * was written. These failures never grant a retry: Authority may already have
 * moved past the frozen request.
 */
export function settlementFailureEnding(
  error: unknown,
  fallbackMessage: string,
): Extract<PlayAdvanceEnding, { kind: "failed" }> {
  return {
    kind: "failed",
    message: errorMessage(error, fallbackMessage),
    failureKind: classifyPlayFailure(error, false),
    canRetry: false,
  };
}

/** A settled response with no provider-native continuation payload (ADR-0035). */
export function noContinuationEnding(): Extract<
  PlayAdvanceEnding,
  { kind: "failed" }
> {
  return {
    kind: "failed",
    message: messages.noContinuation,
    failureKind: "context_unavailable",
    canRetry: false,
  };
}

/** A settled response with neither text nor a complete tool call. */
export function emptyResponseEnding(): Extract<
  PlayAdvanceEnding,
  { kind: "failed" }
> {
  return {
    kind: "failed",
    message: messages.noOutput,
    failureKind: "other",
    canRetry: false,
  };
}

/**
 * Whether a chain's last ending was the player's cancellation. Every
 * cancellation ending writes its event last, so the tail identifies it; callers
 * read the projected flag instead of the event list.
 */
export function lastEndingCancelled(
  session: Pick<PlayAdvanceLedger, "events">,
): boolean {
  return session.events.at(-1)?.kind === "cancellation";
}

function applyEnding(session: PlayAdvanceLedger, ending: PlayAdvanceEnding) {
  switch (ending.kind) {
    case "ready":
      if (ending.followupsCancelled === true)
        session.events.push({
          id: session.nextEventId++,
          kind: "cancellation",
          message: messages.followupsCancelled,
        });
      session.status = "ready";
      session.canRetry = false;
      session.lastFailure = null;
      delete session.lastFailureKind;
      return;
    case "resumable":
      session.lastRequest = structuredClone(ending.request);
      session.lastRequestAttempt = 0;
      session.status = "interrupted";
      session.canRetry = true;
      session.lastFailure =
        ending.reason === "player_committed"
          ? messages.playerCommitted
          : messages.toolStepSettled;
      session.lastFailureKind = "retryable";
      return;
    case "cancelled_before_dispatch":
      interruptStreamingEvent(session, ending.streamingEventId);
      session.events.push({
        id: session.nextEventId++,
        kind: "cancellation",
        message: messages.cancelledBeforeDispatch,
      });
      session.status = "interrupted";
      session.canRetry = true;
      session.lastRequest = structuredClone(ending.request);
      session.lastRequestAttempt = Math.max(0, ending.attempt - 1);
      session.lastFailure = messages.cancelledBeforeDispatch;
      delete session.lastFailureKind;
      return;
    case "cancelled_after_dispatch":
      interruptStreamingEvent(session, ending.streamingEventId);
      session.status = "interrupted";
      session.canRetry = false;
      session.lastFailure = ending.message;
      delete session.lastFailureKind;
      session.events.push({
        id: session.nextEventId++,
        kind: "cancellation",
        message: ending.message,
      });
      return;
    case "failed":
      interruptStreamingEvent(session, ending.streamingEventId);
      session.status = "interrupted";
      session.canRetry = ending.canRetry;
      session.lastFailure = ending.message;
      session.lastFailureKind = ending.failureKind;
      session.events.push({
        id: session.nextEventId++,
        kind: "failure",
        message: ending.message,
        failureKind: ending.failureKind,
      });
      return;
  }
}

function interruptStreamingEvent(
  session: PlayAdvanceLedger,
  eventId: number | undefined,
): void {
  if (eventId === undefined) return;
  const event = session.events.find(({ id }) => id === eventId);
  if (event?.kind === "assistant") event.status = "interrupted";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
