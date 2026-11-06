import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  ModelHostOutcomeUnknownError,
  modelHostFailureRequiresFreshContext,
} from "./ModelHost.ts";

/** Protocol facts only; each lifecycle decides which failures permit replay. */
export function dispatchRequiresFreshContext(
  error: unknown,
  googleDispatched: boolean,
): boolean {
  return (
    error instanceof ModelHostBindingMismatchError ||
    error instanceof ModelHostContinuationError ||
    (googleDispatched && error instanceof ModelHostOutcomeUnknownError) ||
    modelHostFailureRequiresFreshContext(error)
  );
}
