import {
  applyConversationUpdate,
  type ConversationState,
  type ConversationTarget,
  type ConversationUpdate,
} from "../protocol/conversationObservation.ts";
import { v1Protocol } from "../protocol/v1.ts";

export type ConversationConnection = "connected" | "reconnecting" | "failed";
export type ObserveConversation = (
  target: ConversationTarget,
  receive: (
    state: ConversationState,
    durableChanged: boolean,
  ) => void | Promise<void>,
  connection?: (state: ConversationConnection, message?: string) => void,
) => () => void;

/** Owns transport identity, reset/delta reconciliation, and serial delivery.
 * A slow projection keeps the newest observation instead of losing updates
 * while an overview request is in flight. Disposal invalidates every callback. */
export const observeConversation: ObserveConversation = (
  target,
  receive,
  connection,
) => {
  let disposed = false;
  let source: EventSource;
  let state: ConversationState | null = null;
  let pending: ConversationState | null = null;
  let delivering = false;
  let hydratedRevision: string | undefined;
  let epoch = "";
  let sequence = 0;
  const deliver = async (): Promise<void> => {
    if (delivering) return;
    delivering = true;
    try {
      while (pending !== null && !disposed) {
        const next = pending;
        pending = null;
        try {
          const revision =
            next.kind === "play" ? undefined : next.value.revision;
          await receive(
            next,
            revision === undefined || revision !== hydratedRevision,
          );
          hydratedRevision = revision;
        } catch (error: unknown) {
          if (!disposed)
            connection?.(
              "failed",
              error instanceof Error
                ? error.message
                : "Conversation could not be displayed",
            );
        }
      }
    } finally {
      delivering = false;
    }
  };
  const connect = (): void => {
    const query = new URLSearchParams({ kind: target.kind, id: target.id });
    if ("sessionId" in target && target.sessionId !== undefined)
      query.set("sessionId", target.sessionId);
    const current = new EventSource(`/api/runtime/v1/events?${query}`);
    source = current;
    const alive = () => !disposed && source === current;
    current.onopen = () => {
      if (alive()) connection?.("connected");
    };
    current.onerror = () => {
      if (alive())
        connection?.(
          current.readyState === EventSource.CLOSED ? "failed" : "reconnecting",
        );
    };
    current.addEventListener("failure", (event) => {
      if (!alive()) return;
      current.close();
      connection?.("failed", (event as MessageEvent<string>).data);
    });
    current.addEventListener("observation", (event) => {
      if (!alive()) return;
      try {
        const message = event as MessageEvent<string>;
        const match = /^(.*):(\d+)$/.exec(message.lastEventId);
        const payload = JSON.parse(message.data) as {
          protocol: string;
          update: ConversationUpdate;
        };
        if (
          match === null ||
          payload.protocol !== v1Protocol ||
          !payload.update
        )
          throw new Error("Incompatible conversation observation");
        const nextEpoch = match[1]!;
        const nextSequence = Number(match[2]);
        if (nextEpoch === epoch && nextSequence <= sequence) return;
        if (
          (nextEpoch !== epoch || nextSequence !== sequence + 1) &&
          payload.update.kind !== "snapshot"
        ) {
          current.close();
          state = null;
          epoch = "";
          sequence = 0;
          connect();
          return;
        }
        state = applyConversationUpdate(state, payload.update);
        if (state.kind !== target.kind)
          throw new Error("Conversation target changed unexpectedly");
        epoch = nextEpoch;
        sequence = nextSequence;
        pending = state;
        void deliver();
      } catch (error: unknown) {
        current.close();
        connection?.(
          "failed",
          error instanceof Error
            ? error.message
            : "Invalid conversation observation",
        );
      }
    });
  };
  connect();
  return () => {
    disposed = true;
    pending = null;
    source.close();
  };
};
