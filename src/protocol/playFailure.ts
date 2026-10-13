export const playFailureKinds = [
  "outcome_unknown",
  "context_limit",
  "output_limit",
  "context_unavailable",
  "retryable",
  "provider_error",
  "other",
  "configuration_mismatch",
] as const;

export type PlayFailureKind = (typeof playFailureKinds)[number];

export function isPlayFailureKind(value: unknown): value is PlayFailureKind {
  return playFailureKinds.some((kind) => kind === value);
}
