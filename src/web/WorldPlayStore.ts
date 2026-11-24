import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ContentTreeFile,
  V1PlayCallChainEvent,
  V1PlayCallChainStreamFrame,
  V1PlayCallChainView,
  V1PlayTimelineEventSummary,
  V1PlayTimelineItem,
  V1PlayTimelinePage,
  V1Request,
  V1WorldRevisionEpochView,
} from "../protocol/v1.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../protocol/playerViews.ts";
import type { WorldExtensionsView } from "../protocol/worldExtensions.ts";
import type {
  FrontendArtifactProjection,
  FrontendPlayerViewPanelProjection,
} from "./ArtifactExtensionHost.tsx";
import type {
  FrontendArtifactDebugRecord,
  FrontendArtifactExtensionSummary,
} from "./ArtifactDebugger.tsx";
import type { ObserveConversation } from "./ConversationObserver.ts";
import { uiText } from "./i18n.ts";
import {
  progressFromCallChain,
  type PlayRunProgressValue,
} from "./PlayRunProgressState.ts";
import { isResponseRecord } from "./RuntimeResponse.ts";
import { useReadTarget } from "./useReadTarget.ts";

type PlayContextUsageProjection = Pick<
  V1PlayCallChainView,
  "worldId" | "chainId" | "contextWindowTokens" | "latestCompletedResponse"
>;
export type PlayerRevisionContinuation = Extract<
  V1Request,
  { type: "play.chain.revise-player" }
>["continuation"];
export interface WorldMessage {
  role: "player" | "narrator";
  exactText: string;
  messageId?: string;
  head?: string;
}

export interface WorldReadView {
  archiveNeedsFreshContext?: boolean;
  extensionControls?: WorldExtensionsView;
  suppressedPlayerViewIds?: string[];
  worldId: string;
  head: string;
  state: ContentTreeFile[];
  control: ContentTreeFile[];
  history: ContentTreeFile[];
  runtime: unknown;
  playerViews: {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  };
  artifacts?: FrontendArtifactProjection[];
  playerViewPanels?: FrontendPlayerViewPanelProjection[];
  artifactDebug?: FrontendArtifactDebugRecord[];
  extensions?: FrontendArtifactExtensionSummary[];
  committedMessages: WorldMessage[];
  playCallChain: V1PlayCallChainView | null;
  playTimeline?: V1PlayTimelinePage;
  worldRevision?: V1WorldRevisionEpochView | null;
}

interface WorldPlayDecorationsView {
  extensionControls?: WorldExtensionsView;
  suppressedPlayerViewIds?: string[];
  playerViewPanels?: FrontendPlayerViewPanelProjection[];
  playerViews?: WorldReadView["playerViews"];
  head: string;
  artifacts: FrontendArtifactProjection[];
  extensions: FrontendArtifactExtensionSummary[];
  artifactDebug: FrontendArtifactDebugRecord[];
}

export interface WorldPageClient {
  observeConversation?: ObserveConversation;
  request(request: V1Request): Promise<unknown>;
}

export function useWorldPlayStore({
  client,
  worldId,
  onWorldRead,
  onCancellationObserved,
}: {
  client: WorldPageClient;
  worldId: string;
  onWorldRead: (view: WorldReadView, preserveControlDraft: boolean) => void;
  onCancellationObserved: () => void;
}) {
  const [world, setWorld] = useState<WorldReadView | null>(null);
  const [stateHead, setStateHead] = useState<string | null>(null);
  const [controlHead, setControlHead] = useState<string | null>(null);
  const [runtimeHead, setRuntimeHead] = useState<string | null>(null);
  // Decorations have their own lifetime: lightweight world reads intentionally
  // contain empty artifact arrays and must not replace this loaded projection.
  const [decorations, setDecorations] = useState<
    (WorldPlayDecorationsView & { worldId: string }) | null
  >(null);
  const [decorationRevision, setDecorationRevision] = useState(0);
  const worldProjectionVersion = useRef(0);
  const initializedWorldId = useRef<string | null>(null);
  const reconcileObservedPlay = useRef<((world: WorldReadView) => void) | null>(
    null,
  );
  const observedPlayForRecovery = useRef<{
    worldId: string;
    chain: V1PlayCallChainView;
    isCurrent: (() => boolean) | undefined;
  } | null>(null);
  const [observationStopped, setObservationStopped] = useState(false);
  const [observationRevision, setObservationRevision] = useState(0);
  const [playProgress, setPlayProgress] = useState<PlayRunProgressValue | null>(
    null,
  );
  const [playProgressNow, setPlayProgressNow] = useState(0);
  const [playCallChain, setPlayCallChain] =
    useState<V1PlayCallChainView | null>(null);
  const [playContextUsage, setPlayContextUsage] =
    useState<PlayContextUsageProjection | null>(null);
  const [playTimeline, setPlayTimeline] = useState<V1PlayTimelinePage | null>(
    null,
  );
  const worldHead = world?.head;
  const openedWorldId = world?.worldId;
  const applyWorld = useCallback(
    (
      next: WorldReadView,
      preserveControlDraft: boolean,
      mergeTimeline = false,
    ): void => {
      worldProjectionVersion.current++;
      const nextChain = next.playCallChain;
      const nextTimeline = next.playTimeline ?? legacyTimelinePage(next);
      setWorld((current) =>
        current?.worldId === next.worldId &&
        next.state.length === 0 &&
        next.control.length === 0
          ? {
              ...next,
              state: current.state,
              control: current.control,
              runtime: current.runtime,
            }
          : next,
      );
      if (next.state.length > 0) setStateHead(next.head);
      if (next.control.length > 0) setControlHead(next.head);
      if (!isResponseRecord(next.runtime) || next.runtime.surfaces !== "lazy")
        setRuntimeHead(next.head);
      onWorldRead(next, preserveControlDraft);
      // Retain only usage metadata across lightweight reads, never the old
      // endpoint or running/retry state that would override the new timeline.
      setPlayCallChain(nextChain);
      setPlayContextUsage((current) =>
        nextChain !== null
          ? projectPlayContextUsage(nextChain)
          : current?.worldId === next.worldId &&
              current.chainId === nextTimeline.activeChainId
            ? current
            : null,
      );
      setPlayTimeline((current) =>
        mergeTimeline && next.playTimeline !== undefined
          ? mergePlayTimelinePage(current, nextTimeline)
          : nextTimeline,
      );
      const runningChainId = nextChain?.chainId ?? nextTimeline.activeChainId;
      if (
        (nextChain?.status ?? nextTimeline.activeStatus) === "running" &&
        runningChainId !== null
      ) {
        setPlayProgress((current) => {
          const exchangeId =
            nextTimeline.activeInvocationExchangeId !== undefined
              ? nextTimeline.activeInvocationExchangeId
              : (nextChain?.activeInvocation?.exchangeId ??
                (current?.chainId === runningChainId
                  ? current.exchangeId
                  : null));
          return exchangeId === null
            ? null
            : progressFromCallChain(
                runningChainId,
                exchangeId,
                nextChain,
                current,
              );
        });
        setPlayProgressNow(Date.now());
      } else setPlayProgress(null);
    },
    [onWorldRead],
  );

  function applyPlayCallChain(next: V1PlayCallChainView): void {
    worldProjectionVersion.current++;
    setPlayCallChain(next);
    setPlayContextUsage(projectPlayContextUsage(next));
  }

  const loadWorld = useCallback(
    () =>
      requestRuntime<WorldReadView>(client, { type: "world.read", worldId }),
    [client, worldId],
  );
  const applyReadWorld = useCallback(
    (next: WorldReadView) => {
      const initialized = initializedWorldId.current === next.worldId;
      initializedWorldId.current = next.worldId;
      applyWorld(next, initialized, true);
      reconcileObservedPlay.current?.(next);
    },
    [applyWorld],
  );
  const {
    target: worldTarget,
    syncFailed,
    syncError: worldSyncError,
  } = useReadTarget(loadWorld, applyReadWorld);
  useEffect(() => {
    void worldTarget.read();
  }, [worldTarget]);

  const {
    target: decorationTarget,
    syncFailed: decorationFailed,
    syncError: decorationError,
  } = useReadTarget(
    useCallback(
      () =>
        requestRuntime<WorldPlayDecorationsView>(client, {
          type: "world.play-decorations.read",
          worldId,
        }),
      [client, worldId],
    ),
    useCallback(
      (next: WorldPlayDecorationsView) => {
        if (next.head === worldHead) setDecorations({ ...next, worldId });
      },
      [worldId, worldHead],
    ),
  );
  useEffect(() => {
    if (openedWorldId === worldId)
      void (decorationRevision > 0
        ? decorationTarget.recover()
        : decorationTarget.read());
  }, [decorationTarget, openedWorldId, worldId, decorationRevision]);

  const displayedDecorations =
    decorations?.worldId === worldId && decorations.head === worldHead
      ? decorations
      : null;

  const observationNeedsVerification = useEffectEvent(
    (chain: V1PlayCallChainView | null) =>
      playTimeline?.worldId === worldId &&
      playTimeline.activeChainId !== null &&
      (chain === null || timelineHasNewerActivity(playTimeline, chain)),
  );
  useEffect(() => {
    if (client.observeConversation === undefined || openedWorldId !== worldId)
      return;
    interface PlayObservation {
      key: string | null;
      verification: string | undefined;
      chain: V1PlayCallChainView | null;
      isCurrent: (() => boolean) | undefined;
    }
    type Hydration = Omit<PlayObservation, "chain">;
    let pendingHydration: { observation: PlayObservation } | undefined;
    let hydrated: Hydration | undefined;
    let visibleObservation: PlayObservation | undefined;
    let active = true;
    let observedDecorations: string | undefined;
    let observedExtensions: number | undefined;
    let outage = false;
    const showObservation = (observation: PlayObservation) => {
      const { chain } = observation;
      if (chain === null) return;
      visibleObservation = observation;
      observedPlayForRecovery.current = {
        worldId,
        chain,
        isCurrent: observation.isCurrent,
      };
      applyPlayCallChain(chain);
      if (chain.status === "running") {
        setPlayProgress((current) =>
          progressFromCallChain(
            chain.chainId,
            chain.activeInvocation?.exchangeId ??
              (current?.chainId === chain.chainId ? current.exchangeId : null),
            chain,
            current,
          ),
        );
        setPlayProgressNow(Date.now());
      } else setPlayProgress(null);
      applyPlayTimelineFrame(
        { kind: "snapshot", value: chain, final: chain.status !== "running" },
        setPlayTimeline,
      );
      if (
        chain.lastCancelled === true ||
        chain.events.at(-1)?.kind === "cancellation"
      )
        onCancellationObserved();
    };
    reconcileObservedPlay.current = (projection) => {
      const observation = pendingHydration?.observation;
      if (observation === undefined || observation.isCurrent?.() === false)
        return;
      const { key, verification, isCurrent } = observation;
      hydrated = { key, verification, isCurrent };
      const page = projection.playTimeline ?? legacyTimelinePage(projection);
      // A durable read can trail live events in the same invocation. An
      // older frame being verified cannot replace a newer frame already shown.
      const latest =
        verification !== undefined &&
        visibleObservation?.key === key &&
        visibleObservation.isCurrent?.() !== false &&
        visibleObservation.chain !== null &&
        !timelineHasNewerActivity(page, visibleObservation.chain)
          ? visibleObservation
          : observation;
      // Apply the newest compatible live text after the durable timeline, in
      // the same update as the read so an older streaming prefix cannot flash.
      if (
        latest.chain !== null &&
        !timelineHasNewerActivity(page, latest.chain)
      )
        showObservation(latest);
    };
    const unsubscribe = client.observeConversation(
      { kind: "play", id: worldId },
      (observation, _changed, isCurrent) => {
        if (!active || observation.kind !== "play") return;
        setObservationStopped(false);
        if (observation.extensionsRevision !== observedExtensions) {
          observedExtensions = observation.extensionsRevision;
          setDecorationRevision((current) => current + 1);
        }
        const next = observation.value;
        const verifyFirst = observationNeedsVerification(next);
        if (next === null || verifyFirst)
          observedPlayForRecovery.current = null;
        const key =
          next === null
            ? null
            : JSON.stringify([
                next.chainId,
                next.parentHead,
                next.status,
                next.activeInvocation?.exchangeId,
              ]);
        if (next !== null) {
          // Follow-up outcomes can update decorations without changing the world endpoint.
          const revision = JSON.stringify([
            key,
            next.events
              .filter((event) => event.kind === "followup")
              .map((event) => event.id),
          ]);
          if (observedDecorations !== revision) {
            observedDecorations = revision;
            setDecorationRevision((current) => current + 1);
          }
        }
        const lastEvent = next?.events.at(-1);
        const verification = verifyFirst
          ? JSON.stringify([
              lastEvent?.id,
              lastEvent?.kind,
              lastEvent?.kind === "assistant" ? lastEvent.status : undefined,
            ])
          : undefined;
        const latest = { key, verification, chain: next, isCurrent };
        const matches = (read: Hydration | undefined) =>
          read?.key === key &&
          read.isCurrent?.() !== false &&
          (verification === undefined || read.verification === verification);
        const needsHydration =
          (verifyFirst || next !== null) && !matches(hydrated);
        const shared = matches(pendingHydration?.observation)
          ? pendingHydration
          : undefined;
        // A revision can legitimately shorten a chain. Verify an older-looking
        // snapshot before exposing it in place of a newer visible event.
        if (!verifyFirst && next !== null) {
          if (shared === undefined)
            worldTarget.accept({ complete: !needsHydration });
          showObservation(latest);
        }
        if (shared !== undefined) {
          shared.observation = latest;
          return;
        }
        if (!needsHydration) {
          pendingHydration = undefined;
          return;
        }
        if (verifyFirst && pendingHydration !== undefined)
          worldTarget.accept({ complete: false });
        const requested = { observation: latest };
        hydrated = undefined;
        pendingHydration = requested;
        // Keep receiving live frames while the world read is in flight.
        void worldTarget.read().then(() => {
          if (pendingHydration === requested) pendingHydration = undefined;
        });
      },
      (connection) => {
        if (!active) return;
        if (connection !== "synchronized")
          observedPlayForRecovery.current = null;
        if (connection === "connected" || connection === "synchronized") {
          outage = false;
          hydrated = undefined;
          pendingHydration = undefined;
          observedDecorations = undefined;
          setDecorationRevision((current) => current + 1);
        } else {
          if (connection === "failed") setObservationStopped(true);
          if (!outage) {
            outage = true;
            if (pendingHydration !== undefined) {
              pendingHydration = undefined;
              worldTarget.accept({ complete: false });
            }
            void worldTarget.recover();
          }
        }
      },
    );
    return () => {
      active = false;
      observedPlayForRecovery.current = null;
      reconcileObservedPlay.current = null;
      unsubscribe();
    };
  }, [
    client,
    worldId,
    openedWorldId,
    worldTarget,
    observationRevision,
    onCancellationObserved,
  ]);

  async function refreshWorld(
    preserveControlDraft = true,
  ): Promise<WorldReadView> {
    const next = await worldTarget.read();
    if (next === null) throw new Error(uiText("暂时无法同步"));
    if (!preserveControlDraft) applyWorld(next, false);
    return next;
  }

  function recoverPlay(): void {
    void worldTarget.recover();
    if (observationStopped) setObservationRevision((current) => current + 1);
  }

  function confirmedObservedChain(): V1PlayCallChainView | null {
    const observation = observedPlayForRecovery.current;
    return observation?.worldId === worldId &&
      observation.isCurrent?.() !== false
      ? observation.chain
      : null;
  }

  return {
    world,
    setWorld,
    worldHead,
    openedWorldId,
    worldTarget,
    syncFailed,
    worldSyncError,
    worldProjectionVersion,
    observationStopped,
    refreshWorld,
    recoverPlay,
    confirmedObservedChain,
    stateHead,
    setStateHead,
    controlHead,
    setControlHead,
    runtimeHead,
    setRuntimeHead,
    displayedDecorations,
    setDecorations,
    invalidateDecorations: () =>
      setDecorationRevision((current) => current + 1),
    decorationTarget,
    decorationFailed,
    decorationError,
    playCallChain,
    setPlayCallChain,
    playContextUsage,
    setPlayContextUsage,
    playTimeline,
    setPlayTimeline,
    applyPlayCallChain,
    playProgress,
    setPlayProgress,
    playProgressNow,
    setPlayProgressNow,
  };
}

export function requestRuntime<T>(
  client: WorldPageClient,
  request: V1Request,
): Promise<T> {
  return client.request(request) as Promise<T>;
}

function timelineHasNewerActivity(
  page: V1PlayTimelinePage,
  chain: V1PlayCallChainView,
): boolean {
  if (page.activeChainId !== chain.chainId) return true;

  const item = page.items.findLast(
    (item) => item.kind === "event" && item.chainId === chain.chainId,
  );
  if (item?.kind !== "event") return false;
  const event = chain.events.at(-1);
  if (event === undefined || item.event.id > event.id) return true;
  if (item.event.id !== event.id) return false;
  if (
    item.event.kind === "assistant" &&
    item.event.status !== "completed" &&
    event.kind === "assistant" &&
    event.status === "completed"
  )
    return false;
  if (
    page.activeStatus === "running" &&
    page.activeInvocationExchangeId !== undefined &&
    page.activeInvocationExchangeId !==
      (chain.activeInvocation?.exchangeId ?? null)
  )
    return true;
  return (
    (chain.status === "running" && page.activeStatus !== "running") ||
    (item.event.kind === "assistant" &&
      item.event.status === "completed" &&
      event.kind === "assistant" &&
      event.status !== "completed")
  );
}

export function projectPlayContextUsage(
  next: V1PlayCallChainView,
): PlayContextUsageProjection {
  return {
    worldId: next.worldId,
    chainId: next.chainId,
    ...(next.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: next.contextWindowTokens }),
    ...(next.latestCompletedResponse === undefined
      ? {}
      : { latestCompletedResponse: next.latestCompletedResponse }),
  };
}

function mergePlayTimelinePage(
  current: V1PlayTimelinePage | null,
  page: V1PlayTimelinePage,
): V1PlayTimelinePage {
  if (current?.generation !== page.generation) return page;
  const key = (item: V1PlayTimelineItem): string =>
    item.kind === "genesis"
      ? `genesis:${item.messageId}`
      : item.kind === "context_boundary"
        ? `context:${item.chainId}`
        : `event:${item.chainId}:${item.event.id}`;
  const incoming = new Map(page.items.map((item) => [key(item), item]));
  const items = current.items
    .filter(
      (item) =>
        item.kind !== "event" ||
        !page.supersededEvents?.some(
          (entry) =>
            entry.chainId === item.chainId &&
            entry.eventIds.includes(item.event.id),
        ),
    )
    .map((item) => {
      const replacement = incoming.get(key(item));
      incoming.delete(key(item));
      return (
        replacement ??
        (item.kind === "genesis"
          ? item
          : { ...item, current: item.chainId === page.activeChainId })
      );
    });
  return {
    ...page,
    items: [...items, ...incoming.values()],
    nextCursor: current.nextCursor,
  };
}

export function applyPlayTimelineFrame(
  frame: V1PlayCallChainStreamFrame,
  setTimeline: Dispatch<SetStateAction<V1PlayTimelinePage | null>>,
): void {
  if (frame.kind === "snapshot") {
    setTimeline((current) => {
      if (current === null) return current;
      const chain = frame.value;
      const previousActiveChainId = current.activeChainId;
      const items = current.items
        .filter(
          (item) =>
            item.kind !== "event" ||
            item.chainId !== chain.chainId ||
            !chain.supersededEventIds?.includes(item.event.id),
        )
        .map((item) => {
          if (item.kind === "genesis") return item;
          if (item.kind === "context_boundary")
            return item.chainId === chain.chainId
              ? {
                  ...item,
                  playPreset: structuredClone(chain.playPreset),
                  changedDocuments: structuredClone(chain.changedDocuments),
                  current: true,
                }
              : { ...item, current: false };
          return { ...item, current: item.chainId === chain.chainId };
        });
      if (
        previousActiveChainId !== chain.chainId &&
        !items.some(
          (item) =>
            item.kind === "context_boundary" && item.chainId === chain.chainId,
        )
      )
        items.push({
          kind: "context_boundary",
          chainId: chain.chainId,
          playPreset: structuredClone(chain.playPreset),
          changedDocuments: structuredClone(chain.changedDocuments),
          current: true,
        });
      const loadedIds = items.flatMap((item) =>
        item.kind === "event" && item.chainId === chain.chainId
          ? [item.event.id]
          : [],
      );
      const earliestLoadedId =
        loadedIds.length === 0 ? 0 : Math.min(...loadedIds);
      for (const event of chain.events) {
        if (event.id < earliestLoadedId) continue;
        const summary = summarizeTimelineEvent(event);
        const index = items.findIndex(
          (item) =>
            item.kind === "event" &&
            item.chainId === chain.chainId &&
            item.event.id === event.id,
        );
        const next: V1PlayTimelineItem = {
          kind: "event",
          chainId: chain.chainId,
          current: true,
          event: summary,
          ...(chain.requiresFreshContext ? { requiresFreshContext: true } : {}),
        };
        if (index < 0) items.push(next);
        else {
          const existing = items[index]!;
          if (
            existing.kind === "event" &&
            existing.event.kind === "assistant" &&
            summary.kind === "assistant"
          ) {
            summary.hasReasoning ||= existing.event.hasReasoning;
            summary.hasToolFragment ||= existing.event.hasToolFragment;
            summary.hasUsage ||= existing.event.hasUsage;
            summary.detailsAvailable ||= existing.event.detailsAvailable;
          }
          items[index] = next;
        }
      }
      return {
        ...current,
        activeChainId: chain.chainId,
        activeStatus: chain.status,
        activeInvocationExchangeId: chain.activeInvocation?.exchangeId ?? null,
        activeCanRetry: chain.canRetry,
        activeCanContinuePartial: chain.canContinuePartial ?? false,
        activeFreshContextReason: chain.freshContextReason,
        activeLastFailure: chain.lastFailure,
        activeLastFailureKind: chain.lastFailureKind,
        items,
      };
    });
    return;
  }
  if (frame.kind !== "assistant_delta") return;
  setTimeline((current) => {
    if (current?.activeChainId == null) return current;
    const activeChainId = current.activeChainId;
    return {
      ...current,
      items: current.items.map((item) => {
        if (
          item.kind !== "event" ||
          item.chainId !== activeChainId ||
          item.event.kind !== "assistant" ||
          item.event.id !== frame.eventId
        )
          return item;
        if (frame.deltaKind === "text")
          return {
            ...item,
            event: { ...item.event, text: item.event.text + frame.text },
          };
        if (frame.deltaKind === "reasoning")
          return {
            ...item,
            event: {
              ...item.event,
              hasReasoning: true,
              detailsAvailable: true,
            },
          };
        return {
          ...item,
          event: {
            ...item.event,
            hasToolFragment: true,
            detailsAvailable: true,
          },
        };
      }),
    };
  });
}

function summarizeTimelineEvent(
  event: V1PlayCallChainEvent,
): V1PlayTimelineEventSummary {
  if (
    event.kind === "player" ||
    event.kind === "failure" ||
    event.kind === "cancellation"
  )
    return structuredClone(event);
  if (event.kind === "assistant") {
    const { reasoning, toolFragment, ...summary } = event;
    const hasReasoning = event.reasoningRecorded === true || Boolean(reasoning);
    return {
      ...summary,
      hasReasoning,
      hasToolFragment: toolFragment !== undefined && toolFragment.length > 0,
      hasUsage: event.usage !== undefined,
      detailsAvailable:
        hasReasoning ||
        (toolFragment !== undefined && toolFragment.length > 0) ||
        event.usage !== undefined ||
        event.stopReason !== undefined ||
        event.continuation !== undefined,
    };
  }
  if (event.kind === "tool_call") {
    const { arguments: _arguments, ...summary } = event;
    void _arguments;
    return { ...summary, detailsAvailable: true };
  }
  if (event.kind === "tool_result") {
    const { markdown: _markdown, ...summary } = event;
    void _markdown;
    return { ...summary, detailsAvailable: true };
  }
  return {
    id: event.id,
    kind: "followup",
    followupId: event.followupId,
    displayName: event.displayName,
    toolCallCount: event.toolCalls.length,
    hasReasoning: event.reasoningRecorded === true || Boolean(event.reasoning),
    ...(event.replyEventId === undefined
      ? {}
      : { replyEventId: event.replyEventId }),
    ...(event.status === undefined ? {} : { status: event.status }),
    failed: event.failure !== undefined,
    ...(event.usage === undefined
      ? {}
      : { usage: structuredClone(event.usage) }),
    detailsAvailable: true,
  };
}

export function legacyTimelinePage(world: WorldReadView): V1PlayTimelinePage {
  const chain = world.playCallChain;
  if (chain === null)
    return {
      worldId: world.worldId,
      generation: `legacy:${world.worldId}`,
      activeChainId: null,
      activeStatus: null,
      activeCanRetry: false,
      activeLastFailure: null,
      items: [],
      nextCursor: null,
    };
  const contexts = [...chain.previousContexts, chain];
  const firstPlayerHead = contexts[0]?.events.find(
    (
      event,
    ): event is Extract<V1PlayCallChainEvent, { kind: "player" }> & {
      committedHead: string;
    } => event.kind === "player" && event.committedHead !== undefined,
  )?.committedHead;
  const inferredBaseline =
    firstPlayerHead === undefined
      ? 0
      : world.committedMessages.findIndex(
          ({ head }) => head === firstPlayerHead,
        );
  const baselineHistoryLength =
    contexts[0]?.baselineHistoryLength ?? Math.max(0, inferredBaseline);
  const baseline: V1PlayTimelineItem[] = world.committedMessages
    .slice(0, baselineHistoryLength)
    .map((message, index) => ({
      kind: "genesis",
      messageId: message.messageId ?? `legacy-message-${index + 1}`,
      role: message.role,
      exactText: message.exactText,
    }));
  return {
    worldId: world.worldId,
    generation: `legacy:${world.worldId}:${chain.chainId}`,
    activeChainId: chain.chainId,
    activeStatus: chain.status,
    activeCanRetry: chain.canRetry,
    activeCanContinuePartial: chain.canContinuePartial ?? false,
    activeFreshContextReason: chain.freshContextReason,
    activeLastFailure: chain.lastFailure,
    activeLastFailureKind: chain.lastFailureKind,
    items: [
      ...baseline,
      ...contexts.flatMap((context) => [
        {
          kind: "context_boundary" as const,
          chainId: context.chainId,
          playPreset: structuredClone(context.playPreset),
          changedDocuments: structuredClone(context.changedDocuments),
          current: context.chainId === chain.chainId,
        },
        ...context.events.map((event): V1PlayTimelineItem => ({
          kind: "event",
          chainId: context.chainId,
          current: context.chainId === chain.chainId,
          event: summarizeTimelineEvent(event),
          ...(context.requiresFreshContext
            ? { requiresFreshContext: true }
            : {}),
        })),
      ]),
    ],
    nextCursor: null,
  };
}

export function assistantResponseKind(
  event: Extract<V1PlayTimelineEventSummary, { kind: "assistant" }>,
): NonNullable<
  Extract<V1PlayCallChainEvent, { kind: "assistant" }>["responseKind"]
> {
  if (event.responseKind !== undefined) return event.responseKind;
  if (event.status === "streaming" || event.status === "interrupted")
    return "pending";
  if (event.text.trim().length === 0) return "empty";
  return event.committedHead === undefined ? "tool_step" : "narrative";
}

export function useWorldSurfaceRead<Value>(
  client: WorldPageClient,
  worldId: string,
  surface: Extract<V1Request, { type: "world.surface.read" }>["surface"],
  head: string | undefined,
  visible: boolean,
  apply: (value: Value | null) => void,
) {
  return useReadTarget(
    useCallback(
      () =>
        visible && head !== undefined
          ? requestRuntime<Value>(client, {
              type: "world.surface.read",
              worldId,
              surface,
              head,
            })
          : Promise.resolve(null),
      [client, worldId, surface, head, visible],
    ),
    apply,
  );
}
