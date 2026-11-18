import {
  isModelHostTokenLimitFailure,
  ModelHostFailureError,
} from "../model/ModelHost.ts";
import type { FreshContextReason } from "../../protocol/playFailure.ts";
import { canContinueAuthoringPartial } from "../model/AssistantPrefill.ts";
import { validAuthoringNativeContinuation } from "../model/FileNativeModelAdapters.ts";
import { dispatchRequiresFreshContext } from "../model/DispatchFailure.ts";
import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostExchange,
} from "../model/ModelHost.ts";
import type { ModelToolConversationState } from "./ModelToolConversation.ts";

type RetryState = ModelToolConversationState;

export function prepareAuthoringDispatch(
  session: RetryState,
  request: ModelHostExchange,
): ModelHostExchange {
  const retry = session.retryDispatch;
  if (retry?.state === "retryable") {
    session.retryDispatch = { ...retry, state: "dispatching" };
    return { ...request, requestId: retry.requestId, exchange: retry.exchange };
  }
  session.retryDispatch = {
    requestId: request.requestId!,
    exchange: request.exchange!,
    modelItemCount: session.modelItems.length,
    state: "dispatching",
  };
  return request;
}

export function checkpointNextAuthoringDispatch(
  session: RetryState,
  state: "dispatching" | "retryable",
): void {
  const request = session.requests?.at(-1);
  if (request !== undefined)
    session.retryDispatch = {
      requestId: request.requestId,
      exchange: session.exchange + 1,
      modelItemCount: session.modelItems.length,
      state,
    };
}

export type AuthoringDispatchPhase =
  "preparing" | "dispatched" | "validating" | "settling";

export function failAuthoringDispatch(
  session: RetryState,
  error: unknown,
  phase: AuthoringDispatchPhase,
): void {
  const checkpoint = session.retryDispatch;
  if (checkpoint === undefined) return;
  // Acceptance clears the previous checkpoint. During settlement only a
  // completed tool receipt can create the next one, before its final save.
  const settledNextRequest =
    phase === "settling" &&
    session.pendingSettlement === null &&
    checkpoint.state === "dispatching" &&
    checkpoint.modelItemCount === session.modelItems.length;
  checkpoint.state =
    (phase === "preparing" || phase === "dispatched" || settledNextRequest) &&
    !dispatchRequiresFreshContext(error)
      ? "retryable"
      : "blocked";
}

export function recoverAuthoringDispatch(session: RetryState): void {
  if (session.retryDispatch?.state === "dispatching")
    session.retryDispatch.state = "retryable";
}

/** Releases before #195 kept length failures blocked even with a complete dispatch checkpoint. */
export function recoverLegacyLengthLimit(session: RetryState): boolean {
  const saved = session.retryDispatch;
  if (
    session.runStatus !== "interrupted" ||
    saved?.state !== "blocked" ||
    session.pendingSettlement !== null ||
    session.settlementConflict ||
    !session.lastFailure ||
    saved.modelItemCount !== session.modelItems.length ||
    saved.requestId !== session.requests?.at(-1)?.requestId
  )
    return false;
  const message = session.lastFailure;
  if (
    !isModelHostTokenLimitFailure(new ModelHostFailureError(message)) &&
    !message.startsWith(
      "The model response reached the output token limit before completion.",
    ) &&
    !message.startsWith("Google Interactions context limit exceeded")
  )
    return false;
  saved.state = "retryable";
  if (session.modelBinding.provider === "google_interactions")
    session.googleOutcomeUnknown = false;
  return true;
}

export function canRetryAuthoringDispatch(session: RetryState): boolean {
  return (
    session.runStatus === "interrupted" &&
    session.googleOutcomeUnknown !== true &&
    !session.settlementConflict &&
    session.requests?.at(-1) !== undefined &&
    session.pendingSettlement === null &&
    session.retryDispatch?.state === "retryable" &&
    validAuthoringNativeContinuation(
      session.modelItems,
      session.modelBinding.provider,
    )
  );
}

/** The view and both action endpoints use the same saved publication and request evidence. */
export function authoringRecovery(
  session: RetryState & { authorization: { revision: string } | null },
  revisionClosed = false,
  currentRevision?: string,
): {
  canRetry: boolean;
  canContinuePartial: boolean;
  freshContextReason?: FreshContextReason;
} {
  const unavailable = (freshContextReason: FreshContextReason) => ({
    canRetry: false,
    canContinuePartial: false,
    freshContextReason,
  });
  if (
    revisionClosed &&
    (session.runStatus === "interrupted" || session.runStatus === "paused")
  )
    return unavailable("revision_closed");
  if (session.runStatus !== "interrupted")
    return { canRetry: false, canContinuePartial: false };
  const savedRevision =
    session.authorization?.revision ??
    session.requests?.at(-1)?.preload?.revision;
  if (
    session.settlementConflict ||
    session.pendingSettlement !== null ||
    (currentRevision !== undefined &&
      savedRevision !== undefined &&
      currentRevision !== savedRevision)
  )
    return unavailable("files_changed");
  if (!session.requests?.at(-1)) return unavailable("snapshot_missing");
  if (
    !validAuthoringNativeContinuation(
      session.modelItems,
      session.modelBinding.provider,
    )
  )
    return unavailable("continuation_unavailable");
  const canRetry = canRetryAuthoringDispatch(session);
  const canContinuePartial = canContinueAuthoringPartial(session);
  if (canRetry || canContinuePartial) return { canRetry, canContinuePartial };
  return unavailable(
    session.retryDispatch === undefined
      ? "snapshot_missing"
      : "continuation_unavailable",
  );
}

export function assertCompatibleAuthoring(
  binding: ModelHostBinding,
  items: readonly ModelHostAppendItem[],
  host: ModelHost,
): void {
  if (
    binding.provider !== host.binding().provider ||
    !validAuthoringNativeContinuation(items, host.binding().provider)
  )
    throw new Error(
      "The selected model protocol is incompatible with this conversation; switch back or start a fresh model context.",
    );
}
