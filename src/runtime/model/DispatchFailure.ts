import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
} from "./ModelHost.ts";

/** Only an incompatible or unavailable native context prevents replay of a saved request. */
export function dispatchRequiresFreshContext(error: unknown): boolean {
  return (
    error instanceof ModelHostBindingMismatchError ||
    error instanceof ModelHostContinuationError
  );
}
