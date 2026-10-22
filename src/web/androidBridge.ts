import { useEffect, useEffectEvent } from "react";

// The Android app injects `NarraeonAndroid` into the backend page only (see
// android/.../MainActivity.kt). In a regular browser it is absent.
interface AndroidBridge {
  postMessage(message: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

function androidBridge(): AndroidBridge | undefined {
  return (window as { NarraeonAndroid?: AndroidBridge }).NarraeonAndroid;
}

export function canExportAndroidLogs(): boolean {
  return androidBridge() !== undefined;
}

/** Asks the Android shell to zip its diagnostic logs and open the share sheet. */
export function exportAndroidLogs(): void {
  androidBridge()?.postMessage("export-logs");
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
  const reply = new Promise<SaveFileOutcome>((resolve, reject) => {
    pendingSaves.set(id, { resolve, reject });
  });
  listenForReplies(bridge);
  bridge.postMessage(JSON.stringify(message));
  return reply;
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
  listening = true;
  bridge.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let reply: { id?: unknown; outcome?: unknown; error?: unknown };
    try {
      reply = JSON.parse(event.data) as typeof reply;
    } catch {
      return;
    }
    if (typeof reply.id !== "string") return;
    const pending = pendingSaves.get(reply.id);
    if (pending === undefined) return;
    pendingSaves.delete(reply.id);
    if (reply.outcome === "saved" || reply.outcome === "cancelled")
      pending.resolve(reply.outcome);
    else
      pending.reject(
        new Error(
          typeof reply.error === "string" ? reply.error : "Save failed",
        ),
      );
  });
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
