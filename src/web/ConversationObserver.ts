import {
  applyConversationUpdate,
  type ConversationState,
  type ConversationTarget,
  type ConversationUpdate,
} from "../protocol/conversationObservation.ts";
import { v1Protocol } from "../protocol/v1Version.ts";
import { uiText } from "./i18n.ts";
import { runtimeErrorText } from "./RuntimeErrorText.ts";

export type ConversationConnection =
  | "connected"
  | "reconnecting"
  | "failed"
  | "projection_failed"
  | "synchronized";
export type ObserveConversation = (
  target: ConversationTarget,
  receive: (
    state: ConversationState,
    durableChanged: boolean,
    isCurrent?: () => boolean,
  ) => void | Promise<void>,
  connection?: (state: ConversationConnection, message?: string) => void,
) => () => void;

const initialSnapshotRetryDelay = 200;
const maxSnapshotRetryDelay = 5_000;

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
  let snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotRetryDelay = initialSnapshotRetryDelay;
  let state: ConversationState | null = null;
  let pending: ConversationState | null = null;
  let delivering = false;
  let hydratedRevision: string | undefined;
  let deliveryVersion = 0;
  let projectionFailure: string | null = null;
  const invalidateDelivery = (): void => {
    deliveryVersion++;
    pending = null;
    hydratedRevision = undefined;
  };
  let epoch = "";
  let sequence = 0;
  const deliver = async (): Promise<void> => {
    if (delivering) return;
    delivering = true;
    try {
      while (pending !== null && !disposed) {
        const next = pending;
        pending = null;
        const version = deliveryVersion;
        const isCurrent = () => !disposed && version === deliveryVersion;
        try {
          const revision =
            next.kind === "play" ? undefined : next.value.revision;
          await receive(
            next,
            revision === undefined || revision !== hydratedRevision,
            isCurrent,
          );
          if (!isCurrent()) continue;
          hydratedRevision = revision;
          if (projectionFailure !== null) {
            projectionFailure = null;
            connection?.("synchronized");
          }
        } catch (error: unknown) {
          if (isCurrent()) {
            hydratedRevision = undefined;
            projectionFailure =
              error instanceof Error
                ? error.message
                : "Conversation could not be displayed";
            connection?.("projection_failed", projectionFailure);
          }
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
    let closed = false;
    const alive = () => !disposed && !closed && source === current;
    const closeSource = () => {
      closed = true;
      current.close();
      invalidateDelivery();
    };
    current.onopen = () => {
      if (!alive()) return;
      invalidateDelivery();
      connection?.("connected");
      if (projectionFailure !== null)
        connection?.("projection_failed", projectionFailure);
    };
    current.onerror = () => {
      if (!alive()) return;
      invalidateDelivery();
      closed = current.readyState === EventSource.CLOSED;
      connection?.(closed ? "failed" : "reconnecting");
    };
    current.addEventListener("failure", (event) => {
      if (!alive()) return;
      closeSource();
      connection?.(
        "failed",
        observationFailureMessage((event as MessageEvent<string>).data),
      );
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
          closeSource();
          state = null;
          epoch = "";
          sequence = 0;
          snapshotRetryTimer = setTimeout(() => {
            snapshotRetryTimer = undefined;
            if (!disposed) connect();
          }, snapshotRetryDelay);
          snapshotRetryDelay = Math.min(
            snapshotRetryDelay * 2,
            maxSnapshotRetryDelay,
          );
          return;
        }
        if (nextEpoch !== epoch) invalidateDelivery();
        state = applyConversationUpdate(state, payload.update);
        if (state.kind !== target.kind)
          throw new Error("Conversation target changed unexpectedly");
        if (payload.update.kind === "snapshot")
          snapshotRetryDelay = initialSnapshotRetryDelay;
        epoch = nextEpoch;
        sequence = nextSequence;
        pending = state;
        void deliver();
      } catch (error: unknown) {
        closeSource();
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
    clearTimeout(snapshotRetryTimer);
    pending = null;
    source.close();
  };
};

/** Player-facing status line for an observed conversation's connection. */
export function conversationConnectionText(
  state: ConversationConnection,
  message?: string,
): string | null {
  if (state === "connected" || state === "synchronized") return null;
  if (state === "projection_failed")
    return uiText("无法刷新对话内容：{message}", { message: message ?? "" });
  if (state === "reconnecting") return uiText("对话连接已断开，正在重新连接…");
  return message === undefined || message.trim() === ""
    ? uiText("对话同步失败，请重新打开此页面。")
    : uiText("对话同步失败：{message}　请重新打开此页面。", { message });
}

function observationFailureMessage(data: string): string | undefined {
  try {
    const payload = JSON.parse(data) as { message?: unknown };
    return typeof payload.message === "string"
      ? runtimeErrorText(payload.message)
      : undefined;
  } catch {
    return undefined;
  }
}
