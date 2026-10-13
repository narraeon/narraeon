import type { PlayFailureKind } from "../../protocol/playFailure.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  modelHostFailureRequiresFreshContext,
} from "../model/ModelHost.ts";

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
      "code" in error.details &&
      error.details.code === "model_output_limit"
    )
      return "output_limit";
    if (modelHostFailureRequiresFreshContext(error)) return "context_limit";
    return canRetry ? "retryable" : "provider_error";
  }
  return canRetry ? "retryable" : "other";
}
