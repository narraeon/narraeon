import type {
  V1PlayCallChainEvent,
  V1PlayTimelineEventSummary,
} from "../../protocol/v1.ts";

export const legacyModelBindingFailure =
  "The selected model connection does not match the frozen model binding; start a fresh context.";

/** Presentation only: immutable historical events remain unchanged on disk. */
export function projectLegacyModelBindingFailure<
  T extends V1PlayCallChainEvent | V1PlayTimelineEventSummary,
>(event: T): T {
  if (
    event.kind === "failure" &&
    event.message === legacyModelBindingFailure &&
    (event.failureKind === undefined ||
      event.failureKind === "context_unavailable")
  )
    return { ...event, failureKind: "configuration_mismatch" };
  return event;
}
