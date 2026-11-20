import type { ReactNode } from "react";

/** Superseded failures are absent from the public model; legacy inputs keep only the latest. */
export function ModelCallAttempts<T>({
  attempts,
  render,
}: {
  attempts: readonly T[];
  render: (item: T) => ReactNode;
}) {
  const current = attempts.at(-1);
  return current === undefined ? null : render(current);
}
