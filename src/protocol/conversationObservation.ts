import type {
  V1PlayCallChainView,
  V1PlayRunProgress,
  V1SettingImprovementStatus,
  V1WorldRevisionStatus,
} from "./v1.ts";

export type ConversationTarget =
  | { kind: "play"; id: string }
  | { kind: "setting" | "revision"; id: string; sessionId?: string };

export type ConversationState =
  | { kind: "play"; value: V1PlayCallChainView | null }
  | { kind: "setting"; value: V1SettingImprovementStatus }
  | { kind: "revision"; value: V1WorldRevisionStatus };

export type ConversationUpdate =
  | { kind: "snapshot"; value: ConversationState }
  | {
      kind: "play_delta";
      chainId: string;
      updatedAt: number;
      progress: V1PlayRunProgress | null;
      deltas: {
        eventId: number;
        field: "text" | "reasoning" | "toolFragment";
        text: string;
      }[];
    };

/** Only append-only live text uses deltas. Every other transition resets from
 * the Runtime projection, including settlement, context changes and recovery. */
export function conversationUpdate(
  previous: ConversationState | null,
  next: ConversationState,
): ConversationUpdate {
  if (
    previous?.kind === "play" &&
    next.kind === "play" &&
    previous.value !== null &&
    next.value !== null &&
    previous.value.chainId === next.value.chainId
  ) {
    const candidate = structuredClone(previous.value);
    const deltas: Extract<
      ConversationUpdate,
      { kind: "play_delta" }
    >["deltas"] = [];
    for (const event of next.value.events) {
      const old = candidate.events.find((item) => item.id === event.id);
      if (
        event.kind !== "assistant" ||
        event.status !== "streaming" ||
        old?.kind !== "assistant"
      )
        continue;
      for (const field of ["text", "reasoning", "toolFragment"] as const) {
        const before = old[field] ?? "";
        const after = event[field];
        if (!after?.startsWith(before)) continue;
        if (after !== before)
          deltas.push({
            eventId: event.id,
            field,
            text: after.slice(before.length),
          });
        old[field] = after;
      }
    }
    candidate.updatedAt = next.value.updatedAt;
    if (next.value.activeInvocation === undefined)
      delete candidate.activeInvocation;
    else candidate.activeInvocation = next.value.activeInvocation;
    if (JSON.stringify(candidate) === JSON.stringify(next.value)) {
      return {
        kind: "play_delta",
        chainId: candidate.chainId,
        updatedAt: candidate.updatedAt,
        progress: candidate.activeInvocation ?? null,
        deltas,
      };
    }
  }
  return { kind: "snapshot", value: next };
}

export function applyConversationUpdate(
  previous: ConversationState | null,
  update: ConversationUpdate,
): ConversationState {
  if (update.kind === "snapshot") return update.value;
  if (previous?.kind !== "play" || previous.value?.chainId !== update.chainId)
    throw new Error("Conversation observation needs a fresh snapshot");
  const value = structuredClone(previous.value);
  for (const delta of update.deltas) {
    const event = value.events.find((item) => item.id === delta.eventId);
    if (event?.kind !== "assistant" || event.status !== "streaming")
      throw new Error("Conversation observation has an unknown live event");
    event[delta.field] = `${event[delta.field] ?? ""}${delta.text}`;
  }
  value.updatedAt = update.updatedAt;
  if (update.progress === null) delete value.activeInvocation;
  else value.activeInvocation = update.progress;
  return { kind: "play", value };
}
