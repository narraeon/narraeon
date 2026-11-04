import { validGoogleInteractionsContinuation } from "../model/ProviderExchangeState.ts";

export function hasDamagedGoogleSteps(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.modelBinding) &&
    value.modelBinding.provider === "google_interactions" &&
    Array.isArray(value.modelItems) &&
    value.modelItems.some(
      (item: unknown) =>
        isRecord(item) &&
        item.kind === "assistant" &&
        damagedGoogleState(item.providerState),
    )
  );
}

/** A disposable copy for discovery only. Callers must still validate the complete schema. */
export function withoutDamagedGoogleSteps(
  value: unknown,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !isRecord(value.modelBinding) ||
    value.modelBinding.provider !== "google_interactions" ||
    value.pendingSettlement !== null ||
    value.googleOutcomeUnknown === true ||
    value.activeRequestId !== null ||
    (value.runStatus !== "ready" && value.runStatus !== "interrupted") ||
    !Array.isArray(value.modelItems)
  )
    return null;
  const copy = structuredClone(value);
  if (!Array.isArray(copy.modelItems)) return null;
  const items: unknown[] = copy.modelItems;
  for (const [index, item] of items.entries()) {
    if (
      isRecord(item) &&
      item.kind === "assistant" &&
      isRecord(item.providerState) &&
      item.providerState.protocol !== "google_interactions"
    )
      return null;
    if (
      !isRecord(item) ||
      item.kind !== "assistant" ||
      !Array.isArray(item.toolCalls)
    )
      continue;
    for (const [offset, call] of item.toolCalls.entries()) {
      const result = items[index + offset + 1];
      if (
        !isRecord(call) ||
        typeof call.id !== "string" ||
        !isRecord(result) ||
        result.kind !== "tool" ||
        result.toolCallId !== call.id
      )
        return null;
    }
  }
  let damaged = false;
  for (const item of items) {
    if (
      !isRecord(item) ||
      item.kind !== "assistant" ||
      !damagedGoogleState(item.providerState)
    )
      continue;
    if (isRecord(item.providerState)) item.providerState.steps = [];
    else item.providerState = { protocol: "google_interactions", steps: [] };
    damaged = true;
  }
  return damaged ? copy : null;
}

function damagedGoogleState(value: unknown): boolean {
  return (
    value == null ||
    (isRecord(value) &&
      value.protocol === "google_interactions" &&
      !validGoogleInteractionsContinuation(value.steps))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
