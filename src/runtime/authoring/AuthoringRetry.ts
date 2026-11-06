import { validAuthoringNativeContinuation } from "../model/FileNativeModelAdapters.ts";
import { dispatchRequiresFreshContext } from "../model/DispatchFailure.ts";
import type { ModelHostExchange } from "../model/ModelHost.ts";
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
  if (
    session.modelBinding.provider !== "google_interactions" &&
    request !== undefined
  )
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
    session.modelBinding.provider !== "google_interactions" &&
    (phase === "preparing" || phase === "dispatched" || settledNextRequest) &&
    !dispatchRequiresFreshContext(error, false)
      ? "retryable"
      : "blocked";
}

export function recoverAuthoringDispatch(session: RetryState): void {
  if (session.retryDispatch?.state === "dispatching")
    session.retryDispatch.state =
      session.modelBinding.provider === "google_interactions"
        ? "blocked"
        : "retryable";
}

export function canRetryAuthoringDispatch(session: RetryState): boolean {
  return (
    session.runStatus === "interrupted" &&
    session.modelBinding.provider !== "google_interactions" &&
    session.googleOutcomeUnknown !== true &&
    session.pendingSettlement === null &&
    session.retryDispatch?.state === "retryable" &&
    validAuthoringNativeContinuation(
      session.modelItems,
      session.modelBinding.provider,
    )
  );
}
