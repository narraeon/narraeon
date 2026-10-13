const keyPrefix = "narraeon.checkpoint-context.v1";

/** Browser UI choices are scoped to this origin and world, never Authority. */
export function hasHandledCheckpoint(worldId: string, head: string): boolean {
  try {
    return (
      window.localStorage.getItem(preferenceKey(worldId, head)) === "handled"
    );
  } catch {
    return false;
  }
}

export function rememberHandledCheckpoint(worldId: string, head: string): void {
  try {
    window.localStorage.setItem(preferenceKey(worldId, head), "handled");
  } catch {
    // When browser storage is unavailable the mounted page still remembers
    // the choice. Persistence failure must not block play or change Authority.
  }
}

function preferenceKey(worldId: string, head: string): string {
  return `${keyPrefix}:${encodeURIComponent(worldId)}:${encodeURIComponent(head)}`;
}
