import type {
  V1PlayCallChainEvent,
  V1PlayCallChainStreamFrame,
  V1PlayCallChainView,
  V1PlayRunProgress,
  V1PlayTimelineItem,
  V1PlayTimelinePage,
} from "../protocol/v1.ts";

export type PlayRunProgressValue = V1PlayRunProgress;

export function createPlayRunProgress(
  chainId: string,
  exchangeId: string,
  startedAt = Date.now(),
): PlayRunProgressValue {
  return {
    chainId,
    exchangeId,
    phase: "preparing",
    startedAt,
    lastActivityAt: startedAt,
    reasoningChars: 0,
    textChars: 0,
    toolChars: 0,
    toolCalls: 0,
    dispatches: 0,
  };
}

export function activePlayExchangeId(
  chain: V1PlayCallChainView | null,
  timeline: V1PlayTimelinePage | null,
  activeChainId: string | null,
): string | null {
  if (chain?.activeInvocation !== undefined)
    return chain.activeInvocation.exchangeId;
  const chainPlayer = chain?.events.findLast(
    (event): event is Extract<V1PlayCallChainEvent, { kind: "player" }> =>
      event.kind === "player",
  );
  if (chainPlayer !== undefined) return chainPlayer.exchangeId;
  if (activeChainId === null) return null;
  const timelinePlayer = timeline?.items.findLast(
    (
      item,
    ): item is Extract<V1PlayTimelineItem, { kind: "event" }> & {
      event: Extract<V1PlayCallChainEvent, { kind: "player" }>;
    } =>
      item.kind === "event" &&
      item.chainId === activeChainId &&
      item.event.kind === "player",
  );
  return timelinePlayer?.event.exchangeId ?? null;
}

export function progressFromCallChain(
  chainId: string,
  exchangeId: string | null,
  chain: V1PlayCallChainView | null,
  current: PlayRunProgressValue | null,
): PlayRunProgressValue | null {
  if (chain?.activeInvocation !== undefined)
    return structuredClone(chain.activeInvocation);
  if (chain !== null && chain.status !== "running") return null;
  if (exchangeId === null) return current?.chainId === chainId ? current : null;
  const existing =
    current?.chainId === chainId && current.exchangeId === exchangeId
      ? current
      : null;
  const startedAt = existing?.startedAt ?? Date.now();
  const activeAssistant = chain?.events.findLast(
    (event): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
      event.kind === "assistant" && event.status === "streaming",
  );
  let phase = existing?.phase ?? "waiting";
  if (phase !== "cancelling") {
    if ((activeAssistant?.toolFragment?.length ?? 0) > 0) phase = "tool";
    else if ((activeAssistant?.text.length ?? 0) > 0) phase = "text";
    else if ((activeAssistant?.reasoning?.length ?? 0) > 0) phase = "reasoning";
    else if (chain?.events.at(-1)?.kind === "followup") phase = "followup";
    else if (
      chain?.events.at(-1)?.kind === "tool_call" ||
      chain?.events.at(-1)?.kind === "tool_result"
    )
      phase = "tool";
    else phase = "waiting";
  }
  return {
    chainId,
    exchangeId,
    phase,
    startedAt,
    lastActivityAt:
      chain === null
        ? (existing?.lastActivityAt ?? startedAt)
        : Math.max(existing?.lastActivityAt ?? 0, chain.updatedAt),
    reasoningChars: Math.max(
      existing?.reasoningChars ?? 0,
      activeAssistant?.reasoning?.length ?? 0,
    ),
    textChars: Math.max(
      existing?.textChars ?? 0,
      activeAssistant?.text.length ?? 0,
    ),
    toolChars: Math.max(
      existing?.toolChars ?? 0,
      activeAssistant?.toolFragment?.length ?? 0,
    ),
    toolCalls: Math.max(
      existing?.toolCalls ?? 0,
      chain?.events.filter(({ kind }) => kind === "tool_call").length ?? 0,
    ),
    dispatches: Math.max(
      existing?.dispatches ?? 0,
      chain?.events.filter(({ kind }) => kind === "assistant").length ?? 0,
    ),
  };
}

export function progressAfterFrame(
  current: PlayRunProgressValue | null,
  frame: V1PlayCallChainStreamFrame,
  chainId: string,
  exchangeId: string,
): PlayRunProgressValue | null {
  if (frame.kind === "snapshot")
    return progressFromCallChain(chainId, exchangeId, frame.value, current);
  if (
    frame.kind !== "assistant_delta" ||
    current?.chainId !== chainId ||
    current?.exchangeId !== exchangeId ||
    current?.phase === "cancelling"
  )
    return current;
  return {
    ...current,
    phase: frame.deltaKind,
    lastActivityAt: frame.updatedAt,
    reasoningChars:
      current.reasoningChars +
      (frame.deltaKind === "reasoning" ? frame.text.length : 0),
    textChars:
      current.textChars + (frame.deltaKind === "text" ? frame.text.length : 0),
    toolChars:
      current.toolChars + (frame.deltaKind === "tool" ? frame.text.length : 0),
  };
}
