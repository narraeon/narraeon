const freshContextReasons = [
  "snapshot_missing",
  "continuation_unavailable",
  "files_changed",
  "world_changed",
  "revision_closed",
] as const;
export type FreshContextReason = (typeof freshContextReasons)[number];
export function isFreshContextReason(
  value: unknown,
): value is FreshContextReason {
  return freshContextReasons.some((reason) => reason === value);
}

export const playFailureKinds = [
  "outcome_unknown",
  "context_limit",
  "output_limit",
  "context_unavailable",
  "retryable",
  "provider_error",
  "other",
  "configuration_mismatch",
  "dispatch_budget",
] as const;

export type PlayFailureKind = (typeof playFailureKinds)[number];

export function isPlayFailureKind(value: unknown): value is PlayFailureKind {
  return playFailureKinds.some((kind) => kind === value);
}
