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
    !dispatchRequiresFreshContext(error, false)
      ? "retryable"
      : "blocked";
}

export function recoverAuthoringDispatch(session: RetryState): void {
  if (session.retryDispatch?.state === "dispatching")
    session.retryDispatch.state = "retryable";
}

export function canRetryAuthoringDispatch(session: RetryState): boolean {
  return (
    session.runStatus === "interrupted" &&
    session.googleOutcomeUnknown !== true &&
    session.pendingSettlement === null &&
    session.retryDispatch?.state === "retryable" &&
    validAuthoringNativeContinuation(
      session.modelItems,
      session.modelBinding.provider,
    )
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
