import type { OrchestrationSessionRequest } from "../protocol/orchestrationSession.ts";

export interface OrchestrationAiWorkbenchDraft {
  presetId: string;
  message: string;
}

export type OrchestrationPendingRequest = Extract<
  OrchestrationSessionRequest,
  { type: "orchestration.message" | "orchestration.resume" }
>;

const workbenchKey = "narraeon:orchestration-editor";

export function readOrchestrationAiWorkbench(): OrchestrationAiWorkbenchDraft | null {
  const value = read(
    workbenchKey,
  ) as Partial<OrchestrationAiWorkbenchDraft> | null;
  if (typeof value?.presetId !== "string" || typeof value.message !== "string")
    return null;
  return { presetId: value.presetId, message: value.message };
}

export function saveOrchestrationAiWorkbench(
  value: OrchestrationAiWorkbenchDraft | null,
): void {
  write(workbenchKey, value);
}

export function readOrchestrationPendingRequest(
  presetId: string,
): OrchestrationPendingRequest | null {
  const value = read(
    `${workbenchKey}:${presetId}:request`,
  ) as OrchestrationPendingRequest | null;
  if (value?.presetId !== presetId || typeof value.requestId !== "string")
    return null;
  if (
    (value.type === "orchestration.resume" &&
      typeof value.sessionId === "string") ||
    (value.type === "orchestration.message" &&
      typeof value.message === "string" &&
      (value.continuation?.kind === "fresh_context" ||
        (value.continuation?.kind === "continue_context" &&
          typeof value.continuation.sessionId === "string")))
  )
    return value;
  return null;
}

export function saveOrchestrationPendingRequest(
  presetId: string,
  request: OrchestrationPendingRequest | null,
): void {
  write(`${workbenchKey}:${presetId}:request`, request);
}

function read(key: string): unknown {
  try {
    return JSON.parse(window.sessionStorage.getItem(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}

function write(key: string, value: object | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional. Durable Runtime sessions remain readable.
  }
}
