import {
  androidHandledCheckpoints,
  rememberAndroidCheckpoint,
} from "./androidBridge.ts";

const keyPrefix = "narraeon.checkpoint-context.v1";

/** Browser choices are scoped to the origin. Android keeps them across local port changes. */
export function hasHandledCheckpoint(worldId: string, head: string): boolean {
  const key = preferenceKey(worldId, head);
  const android = androidHandledCheckpoints();
  if (android !== undefined) return android.has(key);
  try {
    return window.localStorage.getItem(key) === "handled";
  } catch {
    return false;
  }
}

export function rememberHandledCheckpoint(worldId: string, head: string): void {
  const key = preferenceKey(worldId, head);
  const android = androidHandledCheckpoints();
  if (android !== undefined) {
    android.add(key);
    rememberAndroidCheckpoint(key);
    return;
  }
  try {
    window.localStorage.setItem(key, "handled");
  } catch {
    // When browser storage is unavailable the mounted page still remembers
    // the choice. Persistence failure must not block play or change Authority.
  }
}

function preferenceKey(worldId: string, head: string): string {
  return `${keyPrefix}:${encodeURIComponent(worldId)}:${encodeURIComponent(head)}`;
}
