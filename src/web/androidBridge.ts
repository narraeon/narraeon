import { useEffect, useEffectEvent } from "react";

// The Android app injects `NarraeonAndroid` into the backend page only (see
// android/.../MainActivity.kt). In a regular browser it is absent.
type AndroidMessageListener = (event: { data: unknown }) => void;

interface AndroidBridge {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: AndroidMessageListener): void;
  removeEventListener(type: "message", listener: AndroidMessageListener): void;
}

function androidBridge(): AndroidBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { NarraeonAndroid?: AndroidBridge }).NarraeonAndroid;
}

export async function readAndroidCheckpointPreferences(): Promise<
  Set<string> | undefined
> {
  const bridge = androidBridge();
  if (bridge === undefined) return undefined;

  return new Promise((resolve) => {
    const prefix = "checkpoint-preferences:";
    function receive({ data }: { data: unknown }): void {
      if (typeof data !== "string" || !data.startsWith(prefix)) return;
      try {
        const keys: unknown = JSON.parse(data.slice(prefix.length));
        if (Array.isArray(keys) && keys.every((key) => typeof key === "string"))
          finish(new Set(keys));
      } catch {
        // An unreadable response falls back to local storage.
        finish();
      }
    }
    function finish(keys?: Set<string>): void {
      clearTimeout(timeout);
      bridge?.removeEventListener("message", receive);
      resolve(keys);
    }

    // Keep the page usable if the native side goes away before replying.
    const timeout = setTimeout(finish, 2_000);
    try {
      bridge.addEventListener("message", receive);
      bridge.postMessage("read-checkpoint-preferences");
    } catch {
      finish();
    }
  });
}

export function rememberAndroidCheckpoint(key: string): void {
  try {
    androidBridge()?.postMessage(`remember-checkpoint:${key}`);
  } catch {
    // The page still remembers the choice if the native bridge goes away.
  }
}

export function canExportAndroidLogs(): boolean {
  return androidBridge() !== undefined;
}

/** Asks the Android shell to zip its diagnostic logs and open the share sheet. */
export function exportAndroidLogs(): void {
  androidBridge()?.postMessage("export-logs");
}

export function openAndroidStoryLink(url: string): boolean {
  const bridge = androidBridge();
  if (bridge === undefined) return false;
  try {
    bridge.postMessage(`open-story-link:${url}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Back handlers of the overlays that are open now, oldest first. A handler
 * returns false when it had nothing to close; any other result counts as handled.
 */
const backHandlers: (() => boolean)[] = [];

/**
 * Called by the Android shell when the Back key is pressed, before it walks page
 * history. Offers Back to the most recently opened overlay first and returns
 * whether one handled it.
 */
export function handleAndroidBack(): boolean {
  for (let index = backHandlers.length - 1; index >= 0; index -= 1)
    if (backHandlers[index]?.()) return true;
  return false;
}

if (typeof window !== "undefined")
  (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack =
    handleAndroidBack;

/**
 * While `active`, the Android Back key goes to `onBack` instead of page history.
 * An overlay that should stay open (a pending create, an unsaved draft) still
 * handles Back, so Back does not leave the page behind it.
 */
export function useAndroidBack(
  active: boolean,
  onBack: () => boolean | void,
): void {
  const handle = useEffectEvent(() => onBack() !== false);
  useEffect(() => {
    if (!active) return;
    const handler = () => handle();
    backHandlers.push(handler);
    return () => {
      backHandlers.splice(backHandlers.indexOf(handler), 1);
    };
  }, [active]);
}

export type SaveFileSource =
  | { blob: Blob }
  /** A same-origin path the file can be fetched from once. */
  | { path: string };

/**
 * "started": a browser download began. "saved" / "cancelled": the Android save
 * dialog finished. Throws when the Android shell could not write the file.
 */
export type SaveFileOutcome = "started" | "saved" | "cancelled";

/**
 * Saves a file for the user. Browsers use an `<a download>` link. The Android
 * WebView ignores those, so inside the app the file goes to the native side,
 * which opens the system save dialog.
 */
export async function saveFile(
  fileName: string,
  source: SaveFileSource,
): Promise<SaveFileOutcome> {
  const bridge = androidBridge();
  if (bridge === undefined) {
    downloadInBrowser(fileName, source);
    return "started";
  }
  const id = `save-${(nextSaveId += 1)}`;
  const message =
    "blob" in source
      ? {
          type: "save-file",
          id,
          fileName,
          mimeType: source.blob.type || "application/octet-stream",
          base64: await blobToBase64(source.blob),
        }
      : {
          type: "save-file",
          id,
          fileName,
          mimeType: "application/octet-stream",
          path: source.path,
        };
  listenForReplies(bridge);
  return new Promise<SaveFileOutcome>((resolve, reject) => {
    pendingSaves.set(id, { resolve, reject });
    try {
      bridge.postMessage(JSON.stringify(message));
    } catch (cause) {
      pendingSaves.delete(id);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}

let nextSaveId = 0;
let listening = false;
const pendingSaves = new Map<
  string,
  {
    resolve: (outcome: SaveFileOutcome) => void;
    reject: (error: Error) => void;
  }
>();

function listenForReplies(bridge: AndroidBridge): void {
  if (listening) return;
  bridge.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let reply: unknown;
    try {
      reply = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("id" in reply) ||
      typeof reply.id !== "string" ||
      !("outcome" in reply) ||
      (reply.outcome !== "saved" &&
        reply.outcome !== "cancelled" &&
        reply.outcome !== "failed")
    )
      return;
    const pending = pendingSaves.get(reply.id);
    if (pending === undefined) return;
    pendingSaves.delete(reply.id);
    if (reply.outcome === "saved" || reply.outcome === "cancelled")
      pending.resolve(reply.outcome);
    else
      pending.reject(
        new Error(
          "error" in reply && typeof reply.error === "string"
            ? reply.error
            : "Save failed",
        ),
      );
  });
  listening = true;
}

function downloadInBrowser(fileName: string, source: SaveFileSource): void {
  const url = "blob" in source ? URL.createObjectURL(source.blob) : source.path;
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    if ("blob" in source) URL.revokeObjectURL(url);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
