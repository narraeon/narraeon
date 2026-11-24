import {
  readAndroidCheckpointPreferences,
  rememberAndroidCheckpoint,
} from "./androidBridge.ts";

const keyPrefix = "narraeon.checkpoint-context.v1";
let androidHandled: Set<string> | undefined;

export async function loadCheckpointPreferences(): Promise<void> {
  androidHandled = await readAndroidCheckpointPreferences();
}

/** Browser choices are scoped to the origin. Android keeps them across local port changes. */
export function hasHandledCheckpoint(worldId: string, head: string): boolean {
  const key = preferenceKey(worldId, head);
  if (androidHandled !== undefined) return androidHandled.has(key);
  try {
    return window.localStorage.getItem(key) === "handled";
  } catch {
    return false;
  }
}

export function rememberHandledCheckpoint(worldId: string, head: string): void {
  const key = preferenceKey(worldId, head);
  rememberAndroidCheckpoint(key);
  if (androidHandled !== undefined) {
    androidHandled.add(key);
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
