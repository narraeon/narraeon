import type {
  FreshContextReason,
  PlayFailureKind,
} from "../../protocol/playFailure.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  isModelHostTokenLimitFailure,
} from "../model/ModelHost.ts";

export function playFreshContextReason(context: {
  status: string;
  canRetry: boolean;
  lastFailureKind?: PlayFailureKind;
  lastRequest: unknown;
  freshContextReason?: FreshContextReason;
  importedFromArchive?: boolean;
}): FreshContextReason | undefined {
  if (context.status !== "interrupted") return undefined;
  if (context.freshContextReason) return context.freshContextReason;
  if (context.importedFromArchive) return "continuation_unavailable";
  if (context.lastRequest === null) return "snapshot_missing";
  if (context.canRetry) return undefined;
  if (context.lastFailureKind === "context_unavailable")
    return "continuation_unavailable";
  // An accepted response or player write that could not settle may have advanced Authority.
  return "world_changed";
}

/** Classification does not grant permission to replay a request. */
export function classifyPlayFailure(
  error: unknown,
  canRetry: boolean,
): PlayFailureKind {
  if (error instanceof ModelHostOutcomeUnknownError) return "outcome_unknown";
  if (
    error instanceof ModelHostContinuationError ||
    error instanceof ModelHostBindingMismatchError
  )
    return "context_unavailable";
  if (error instanceof ModelHostFailureError) {
    if (
      typeof error.details === "object" &&
      error.details !== null &&
      "chatgptPlanFailure" in error.details
    ) {
      if (error.details.chatgptPlanFailure === "quota")
        return "chatgpt_plan_quota";
      if (error.details.chatgptPlanFailure === "authentication")
        return "chatgpt_plan_authorization";
    }
    if (
      typeof error.details === "object" &&
      error.details !== null &&
      "code" in error.details &&
      error.details.code === "model_output_limit"
    )
      return "output_limit";
    if (isModelHostTokenLimitFailure(error)) return "context_limit";
    return canRetry ? "retryable" : "provider_error";
  }
  return canRetry ? "retryable" : "other";
}
