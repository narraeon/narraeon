import { useEffect, useMemo, useState } from "react";
import { ReadTarget } from "./ReadTarget.ts";

/** Stable load/apply callbacks define a visible target's lifetime. Drafts stay page-owned. */
export function useReadTarget<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
): { target: ReadTarget<T>; syncFailed: boolean } {
  const [failure, setFailure] = useState<ReadTarget<T> | null>(null);
  const target = useMemo(() => {
    const boundary = new ReadTarget<T>({
      load,
      apply,
      onSyncFailure: (failed) => setFailure(failed ? boundary : null),
    });
    return boundary;
  }, [load, apply]);
  useEffect(() => {
    target.activate();
    return () => target.dispose();
  }, [target]);
  return { target, syncFailed: failure === target };
}
