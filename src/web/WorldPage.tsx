import { useConversationComposer } from "./useConversationComposer.ts";
import type { ObserveConversation } from "./ConversationObserver.ts";
import { uiText } from "./i18n.ts";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
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
  V1PlayContextReadingView,
  V1PlayTimelineEventSummary,
  V1PlayTimelineItem,
  V1PlayTimelinePage,
  V1Request,
  V1SettingImprovementRollbackResult,
  V1WorldRevisionEpochView,
  V1WorldRevisionOverview,
  V1WorldRevisionView,
} from "../protocol/v1.ts";
import {
  defaultAppReadingPreferences,
  type AppReadingPreferences,
} from "../protocol/appPreferences.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../protocol/playerViews.ts";
import { createClientId } from "./ClientId.ts";
import {
  AiReadingDialog,
  AiReadingRail,
  ReadingPreferencesPopover,
  WorldDocumentRail,
  WorldManagementDialog,
} from "./WorldPlayWorkspacePanels.tsx";
import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  type FrontendArtifactProjection,
  type FrontendPlayerViewPanelProjection,
} from "./ArtifactExtensionHost.tsx";
import {
  ArtifactDebugger,
  type FrontendArtifactExtensionSummary,
  type FrontendArtifactDebugRecord,
} from "./ArtifactDebugger.tsx";
import { projectUncoveredPlayerViews } from "./PlayerViewFallback.ts";
import { ModelUsageBreakdown } from "./ModelUsageBreakdown.tsx";
import { PlayRunProgress } from "./PlayRunProgress.tsx";
import {
  SettingImprovementPanel,
  type SettingImprovementView,
} from "./SettingImprovementPanel.tsx";
import {
  activePlayExchangeId,
  createPlayRunProgress,
  progressFromCallChain,
  type PlayRunProgressValue,
} from "./PlayRunProgressState.ts";

type RightRailTab = "documents" | "ai-reading";
type WorldDialog = "revision" | "reading" | "manage" | null;
type PlayerRevisionContinuation = Extract<
  V1Request,
  { type: "play.chain.revise-player" }
>["continuation"];
type PendingAction =
  | "play-fresh"
  | "play-append"
  | "timeline-page"
  | "control-preview"
  | "control-apply"
  | "rename"
  | "revise"
  | "derive";

interface WorldMessage {
  role: "player" | "narrator";
  exactText: string;
  messageId?: string;
  head?: string;
}

interface WorldReadView {
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
  head: string;
  artifacts: FrontendArtifactProjection[];
  extensions: FrontendArtifactExtensionSummary[];
  artifactDebug: FrontendArtifactDebugRecord[];
}

interface Feedback {
  kind: "status" | "error";
  text: string;
}

interface WorldPageClient {
  observeConversation?: ObserveConversation;
  request(request: V1Request): Promise<unknown>;
}

export function WorldPage({
  client,
  worldId,
  worldTitle,
  modelConfigured,
  onBack,
  onConfigureModel,
  onRenameWorld,
  onOpenWorld,
  initialReadingPreferences = defaultAppReadingPreferences,
}: {
  client: WorldPageClient;
  worldId: string;
  worldTitle: string;
  modelConfigured: boolean;
  onBack: () => void;
  onConfigureModel: () => void;
  onRenameWorld: (name: string) => Promise<void>;
  onOpenWorld: (worldId: string) => Promise<void>;
  initialReadingPreferences?: AppReadingPreferences;
}): React.JSX.Element {
  const [world, setWorld] = useState<WorldReadView | null>(null);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [rightRailTab, setRightRailTab] = useState<RightRailTab>("documents");
  const [readingOpen, setReadingOpen] = useState(false);
  const [dialog, setDialog] = useState<WorldDialog>(null);
  const [readingPreferences, setReadingPreferences] = useState(
    initialReadingPreferences,
  );
  const [readingPreferencesSaving, setReadingPreferencesSaving] =
    useState(false);
  const [playerText, setPlayerText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [playObservationFailure, setPlayObservationFailure] = useState<
    string | null
  >(null);
  const [playFailure, setPlayFailure] = useState<string | null>(null);
  const [playProgress, setPlayProgress] = useState<PlayRunProgressValue | null>(
    null,
  );
  const [playProgressNow, setPlayProgressNow] = useState(0);
  const cancelledExchangeRef = useRef<string | null>(null);
  const [worldNameDraft, setWorldNameDraft] = useState(worldTitle);
  const [lastWorldTitle, setLastWorldTitle] = useState(worldTitle);
  if (lastWorldTitle !== worldTitle) {
    setLastWorldTitle(worldTitle);
    setWorldNameDraft(worldTitle);
  }
  const [playCallChain, setPlayCallChain] =
    useState<V1PlayCallChainView | null>(null);
  const [forceFreshContext, setForceFreshContext] = useState(false);
  const [playTimeline, setPlayTimeline] = useState<V1PlayTimelinePage | null>(
    null,
  );
  const [selectedDocument, setSelectedDocument] = useState("");
  const [controlFiles, setControlFiles] = useState("[]");
  const [controlDirty, setControlDirty] = useState(false);
  const [controlPreview, setControlPreview] = useState<unknown>(null);
  const [revisionOverview, setRevisionOverview] =
    useState<V1WorldRevisionOverview | null>(null);
  const [revisionView, setRevisionView] = useState<V1WorldRevisionView | null>(
    null,
  );
  const [revisionFiles, setRevisionFiles] = useState<ContentTreeFile[]>([]);
  const [savedRevisionFiles, setSavedRevisionFiles] = useState<
    ContentTreeFile[]
  >([]);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionStartingFresh, setRevisionStartingFresh] = useState(false);
  const [revisionRequestFailure, setRevisionRequestFailure] = useState<
    string | null
  >(null);
  const [revisionNotice, setRevisionNotice] = useState("");
  const [revisionApplying, setRevisionApplying] = useState(false);
  const [revisionNow, setRevisionNow] = useState(Date.now());
  const revisionDirtyRef = useRef(false);
  const revisionSelectionVersion = useRef(0);
  const [revisionObservationFailure, setRevisionObservationFailure] = useState<
    string | null
  >(null);
  const revisionFreshRequest = useRef<{
    previousSessionId: string | null;
  } | null>(null);
  const [aiReading, setAiReading] = useState<V1PlayContextReadingView | null>(
    null,
  );
  const [aiReadingLoading, setAiReadingLoading] = useState(false);
  const [bridgeEvents, setBridgeEvents] = useState<Record<string, string[]>>(
    {},
  );
  const historyEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [composerHeight, setComposerHeight] = useState(72);
  const worldHead = world?.head;
  const openedWorldId = world?.worldId;
  const revisionDirty = !sameTextFiles(savedRevisionFiles, revisionFiles);
  revisionDirtyRef.current = revisionDirty;

  useEffect(() => {
    let active = true;
    const open = async (): Promise<void> => {
      try {
        const next = await requestRuntime<WorldReadView>(client, {
          type: "world.read",
          worldId,
        });
        if (!active) return;
        applyWorld(next, false);
      } catch (reason: unknown) {
        if (!active) return;
        setFeedback({ kind: "error", text: errorMessage(reason) });
      } finally {
        if (active) setPending(null);
      }
    };
    void open();
    return () => {
      active = false;
    };
  }, [client, worldId]);

  useEffect(() => {
    if (worldHead === undefined) return;
    let active = true;
    const expectedHead = worldHead;
    void requestPlayDecorations(client, worldId).then((decorations) => {
      if (!active) return;
      setWorld((current) =>
        current?.head !== expectedHead || decorations?.head !== expectedHead
          ? current
          : { ...current, ...decorations },
      );
    });
    return () => {
      active = false;
    };
  }, [client, worldHead, worldId]);

  useEffect(() => {
    if (client.observeConversation === undefined || openedWorldId !== worldId)
      return;
    let active = true;
    let hydratedHead: string | undefined;
    const unsubscribe = client.observeConversation(
      { kind: "play", id: worldId },
      async (observation) => {
        if (!active || observation.kind !== "play") return;
        const next = observation.value;
        if (next === null) return;
        setPlayCallChain(next);
        setPlayFailure(playCallFailureMessage(next));
        if (next.status === "running") {
          setPlayProgress((current) =>
            progressFromCallChain(
              next.chainId,
              activePlayExchangeId(next, null, next.chainId),
              next,
              current,
            ),
          );
          setPlayProgressNow(Date.now());
        } else setPlayProgress(null);
        applyPlayTimelineFrame(
          { kind: "snapshot", value: next, final: next.status !== "running" },
          setPlayTimeline,
        );
        if (
          cancelledExchangeRef.current !== null &&
          next.status !== "running"
        ) {
          setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
        }
        if (hydratedHead !== `${next.parentHead}:${next.status}`) {
          const projection = await requestRuntime<WorldReadView>(client, {
            type: "world.read",
            worldId,
          });
          if (!active) return;
          hydratedHead = `${next.parentHead}:${next.status}`;
          setWorld(projection);
          const page = projection.playTimeline;
          if (page !== undefined)
            setPlayTimeline((current) =>
              current === null
                ? page
                : {
                    ...current,
                    items: current.items.map((item) =>
                      item.kind !== "event"
                        ? item
                        : (page.items.find(
                            (candidate) =>
                              candidate.kind === "event" &&
                              candidate.chainId === item.chainId &&
                              candidate.event.id === item.event.id,
                          ) ?? item),
                    ),
                  },
            );
        }
      },
      (connection) => {
        if (active)
          setPlayObservationFailure(
            connection === "connected"
              ? null
              : uiText(
                  connection === "reconnecting"
                    ? "对话连接已断开，正在重新连接…"
                    : "对话同步失败，请重新打开此页面。",
                ),
          );
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, worldId, openedWorldId]);

  useEffect(() => {
    if (openedWorldId === undefined) return;
    historyEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openedWorldId]);

  useEffect(() => {
    if (world === null || (!rightRailOpen && dialog === null)) return;
    if (world.state.length > 0 && world.control.length > 0) return;
    let active = true;
    const loadSurfaces = async (): Promise<void> => {
      try {
        const [state, control, runtime] = await Promise.all([
          requestRuntime<ContentTreeFile[]>(client, {
            type: "world.surface.read",
            worldId,
            surface: "state",
          }),
          requestRuntime<ContentTreeFile[]>(client, {
            type: "world.surface.read",
            worldId,
            surface: "control",
          }),
          requestRuntime<unknown>(client, {
            type: "world.surface.read",
            worldId,
            surface: "runtime",
          }),
        ]);
        if (!active) return;
        setWorld((current) =>
          current === null ? null : { ...current, state, control, runtime },
        );
        setSelectedDocument((current) => selectedStateDocument(state, current));
        if (!controlDirty) setControlFiles(JSON.stringify(control, null, 2));
      } catch (reason: unknown) {
        if (active) setFeedback({ kind: "error", text: errorMessage(reason) });
      }
    };
    void loadSurfaces();
    return () => {
      active = false;
    };
  }, [client, controlDirty, dialog, rightRailOpen, world, worldId]);

  useEffect(() => {
    if (
      !rightRailOpen ||
      rightRailTab !== "ai-reading" ||
      worldHead === undefined
    )
      return;
    let active = true;
    const loadingTimer = window.setTimeout(() => {
      if (active) setAiReadingLoading(true);
    }, 0);
    void requestRuntime<V1PlayContextReadingView>(client, {
      type: "world.play-context.read",
      worldId,
    })
      .then((reading) => {
        if (active) setAiReading(reading);
      })
      .catch((reason: unknown) => {
        if (active) setFeedback({ kind: "error", text: errorMessage(reason) });
      })
      .finally(() => {
        if (active) setAiReadingLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
    };
  }, [
    client,
    playCallChain?.updatedAt,
    rightRailOpen,
    rightRailTab,
    worldHead,
    worldId,
  ]);

  useEffect(() => {
    if (dialog !== "revision") return;
    let active = true;
    const selectedSessionId = revisionStartingFresh
      ? undefined
      : revisionView?.sessionId;
    if (client.observeConversation === undefined) return;
    const unsubscribe = client.observeConversation(
      {
        kind: "revision",
        id: worldId,
        ...(selectedSessionId === undefined
          ? {}
          : { sessionId: selectedSessionId }),
      },
      async (observation, durableChanged) => {
        if (observation.kind !== "revision") return;
        const status = observation.value;
        try {
          if (!active) return;
          const selectedStatus = status.selected;
          if (!revisionStartingFresh && selectedStatus !== null) {
            setRevisionView((current) =>
              current?.sessionId !== selectedStatus.sessionId
                ? current
                : {
                    ...current,
                    runStatus: selectedStatus.runStatus,
                    progress: selectedStatus.progress,
                  },
            );
          }
          setRevisionNow(Date.now());
          if (!durableChanged) return;
          const next = await requestRuntime<V1WorldRevisionOverview>(client, {
            type: "world.revision.overview",
            worldId,
          });
          if (!active) return;
          setRevisionOverview(next);
          const selectedView =
            selectedSessionId !== undefined &&
            selectedSessionId !== next.latest?.sessionId
              ? await requestRuntime<V1WorldRevisionView>(client, {
                  type: "world.revision.session.read",
                  worldId,
                  sessionId: selectedSessionId,
                })
              : next.latest;
          if (!active) return;
          const fresh = revisionFreshRequest.current;
          if (
            fresh !== null &&
            next.latest !== null &&
            next.latest.sessionId !== fresh.previousSessionId
          ) {
            revisionFreshRequest.current = null;
            setRevisionStartingFresh(false);
            setRevisionView(next.latest);
          } else if (!revisionStartingFresh && fresh === null)
            setRevisionView(selectedView);
          if (!revisionDirtyRef.current && next.epoch !== null) {
            setRevisionFiles(cloneTextFiles(next.epoch.files));
            setSavedRevisionFiles(cloneTextFiles(next.epoch.files));
          }
          setWorld((current) =>
            current === null
              ? null
              : {
                  ...current,
                  worldRevision:
                    next.epoch?.locked === true ? next.epoch : null,
                },
          );
        } catch (error: unknown) {
          if (active) throw error;
        }
      },
      (connection) => {
        if (active)
          setRevisionObservationFailure(
            connection === "connected"
              ? null
              : uiText(
                  connection === "reconnecting"
                    ? "对话连接已断开，正在重新连接…"
                    : "对话同步失败，请重新打开此页面。",
                ),
          );
      },
    );
    const timer = window.setInterval(() => setRevisionNow(Date.now()), 1000);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [client, dialog, revisionStartingFresh, revisionView?.sessionId, worldId]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "0px";
    const height = Math.min(textarea.scrollHeight, 152);
    textarea.style.height = `${Math.max(height, 24)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 152 ? "auto" : "hidden";
  }, [playerText]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer === null) return;
    const publish = (): void =>
      setComposerHeight(composer.getBoundingClientRect().height);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (feedback?.kind !== "status") return;
    const timer = window.setTimeout(() => setFeedback(null), 3200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const documents = world?.state ?? [];
  const playerViewFallback = projectUncoveredPlayerViews(
    world?.playerViews ?? { views: [], diagnostics: [] },
    world?.playerViewPanels ?? [],
  );
  const timelineCommittedMessages: WorldMessage[] =
    playTimeline?.items.flatMap((item) => {
      if (item.kind === "genesis")
        return [
          {
            messageId: item.messageId,
            role: item.role,
            exactText: item.exactText,
            head: "genesis",
          },
        ];
      if (
        item.kind !== "event" ||
        (item.event.kind !== "player" && item.event.kind !== "assistant") ||
        item.event.committedHead === undefined ||
        (item.event.kind === "assistant" &&
          (item.event.text.length === 0 ||
            assistantResponseKind(item.event) !== "narrative"))
      )
        return [];
      return [
        {
          messageId: `${item.chainId}:${item.event.id}`,
          role: item.event.kind === "player" ? "player" : "narrator",
          exactText: item.event.text,
          head: item.event.committedHead,
        },
      ];
    }) ?? [];
  const committedMessages =
    (world?.committedMessages.length ?? 0) > 0
      ? world!.committedMessages
      : timelineCommittedMessages;
  const activeStatus = playCallChain?.status ?? playTimeline?.activeStatus;
  const activeChainId =
    playCallChain?.chainId ?? playTimeline?.activeChainId ?? null;
  const activeCanRetry =
    playCallChain?.canRetry ?? playTimeline?.activeCanRetry ?? false;
  const activeRevisionEpoch =
    revisionOverview?.epoch?.locked === true
      ? revisionOverview.epoch
      : (world?.worldRevision ?? null);
  const worldRevisionLocked = activeRevisionEpoch?.locked === true;
  const activeChainStale =
    forceFreshContext ||
    (world !== null &&
      playCallChain !== null &&
      playCallChain.parentHead !== world.head);
  const playProgressActive = playProgress !== null;
  const hasPlayerText = playerText.trim().length > 0;
  const playIdle =
    pending === null && activeStatus !== "running" && !worldRevisionLocked;
  const canStartFresh = hasPlayerText && playIdle;
  const canAppend =
    playIdle &&
    !activeChainStale &&
    (activeChainId === null
      ? hasPlayerText
      : activeStatus === "ready" || (!hasPlayerText && activeCanRetry));

  useEffect(() => {
    if (!playProgressActive) return;
    const timer = setInterval(() => setPlayProgressNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playProgressActive]);

  function applyWorld(
    next: WorldReadView,
    preserveControlDraft: boolean,
  ): void {
    const nextChain = next.playCallChain;
    const nextTimeline = next.playTimeline ?? legacyTimelinePage(next);
    setWorld(next);
    if (!preserveControlDraft) {
      setControlFiles(JSON.stringify(next.control, null, 2));
      setControlDirty(false);
      setControlPreview(null);
    }
    setPlayCallChain(nextChain);
    setPlayTimeline(nextTimeline);
    setPlayFailure(playCallFailureMessage(nextChain));
    if (nextChain?.status === "running") {
      setPlayProgress((current) =>
        progressFromCallChain(
          nextChain.chainId,
          activePlayExchangeId(nextChain, nextTimeline, nextChain.chainId),
          nextChain,
          current,
        ),
      );
      setPlayProgressNow(Date.now());
    } else setPlayProgress(null);
    setSelectedDocument((current) =>
      selectedStateDocument(next.state, current),
    );
  }

  async function refreshWorld(
    preserveControlDraft = true,
  ): Promise<WorldReadView> {
    const next = await requestRuntime<WorldReadView>(client, {
      type: "world.read",
      worldId,
    });
    applyWorld(next, preserveControlDraft);
    return next;
  }

  async function submitPlayChain(context: "fresh" | "append"): Promise<void> {
    if (!modelConfigured) return;
    const fresh = context === "fresh" || activeChainId === null;
    if ((fresh && !canStartFresh) || (!fresh && !canAppend)) return;
    const chainId = fresh ? createClientId("play-chain") : activeChainId;
    const exchangeId = createClientId("play-exchange");
    const startedAt = Date.now();
    cancelledExchangeRef.current = null;
    setPlayFailure(null);
    setPlayProgressNow(startedAt);
    setPlayProgress(createPlayRunProgress(chainId, exchangeId, startedAt));
    setPending(context === "fresh" ? "play-fresh" : "play-append");
    setFeedback({
      kind: "status",
      text: fresh
        ? uiText("正在从当前世界重新拼接上下文…")
        : hasPlayerText
          ? uiText("正在把玩家输入追加到现有上下文…")
          : activeStatus === "interrupted"
            ? uiText("正在原样发送上次未完成的模型请求…")
            : uiText("正在沿现有上下文继续生成…"),
    });
    try {
      const request = fresh
        ? ({
            type: "play.chain.start",
            worldId,
            chainId,
            exchangeId,
            playerText,
          } satisfies Extract<V1Request, { type: "play.chain.start" }>)
        : ({
            type: "play.chain.append",
            worldId,
            chainId,
            exchangeId,
            playerText,
          } satisfies Extract<V1Request, { type: "play.chain.append" }>);
      const next = await requestRuntime<V1PlayCallChainView>(client, request);
      setPlayCallChain(next);
      if (fresh) setForceFreshContext(false);
      if (hasPlayerText) setPlayerText("");
      await refreshWorld();
      const wasCancelled = cancelledExchangeRef.current === exchangeId;
      if (wasCancelled) {
        setPlayFailure(null);
        setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
      } else if (next.status === "interrupted") {
        setPlayFailure(
          playCallFailureMessage(next) ??
            (next.canRetry
              ? uiText(
                  "模型请求中断；清空输入后点击追加上下文即可原样发送上次请求。",
                )
              : uiText("调用链处理失败；旧请求不能重发，请使用全新上下文。")),
        );
        setFeedback(null);
      } else {
        setPlayFailure(null);
        setFeedback({
          kind: "status",
          text:
            !fresh && !hasPlayerText
              ? uiText("AI 已沿现有上下文继续生成，没有追加玩家指令。")
              : uiText("调用链已返回；模型完成的叙事和世界变化已经分别提交。"),
        });
      }
    } catch (reason: unknown) {
      const inspected = await requestRuntime<V1PlayCallChainView | null>(
        client,
        { type: "play.chain.inspect", worldId },
      ).catch(() => null);
      if (inspected !== null) {
        setPlayCallChain(inspected);
        if (fresh && inspected.chainId === chainId) setForceFreshContext(false);
        if (
          hasPlayerText &&
          inspected.events.some(
            (event) =>
              event.kind === "player" && event.exchangeId === exchangeId,
          )
        )
          setPlayerText("");
      }
      const timeline = await requestRuntime<V1PlayTimelinePage>(client, {
        type: "play.timeline.page",
        worldId,
        limit: 40,
      }).catch(() => null);
      if (timeline !== null) setPlayTimeline(timeline);
      if (cancelledExchangeRef.current === exchangeId) {
        setPlayFailure(null);
        setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
      } else {
        setPlayFailure(
          playCallFailureMessage(inspected) ?? errorMessage(reason),
        );
        setFeedback(null);
      }
    } finally {
      if (cancelledExchangeRef.current === exchangeId)
        cancelledExchangeRef.current = null;
      setPlayProgress((current) =>
        current?.exchangeId === exchangeId ? null : current,
      );
      setPending(null);
    }
  }

  async function cancelPlayGeneration(): Promise<void> {
    if (playProgress === null || playProgress.phase === "cancelling") return;
    const { chainId, exchangeId } = playProgress;
    cancelledExchangeRef.current = exchangeId;
    setPlayProgress((current) =>
      current?.chainId === chainId && current.exchangeId === exchangeId
        ? { ...current, phase: "cancelling" }
        : current,
    );
    setFeedback({ kind: "status", text: uiText("正在取消模型生成…") });
    try {
      const result = await requestRuntime<{
        outcome: "cancellation_requested" | "not_running";
      }>(client, {
        type: "play.chain.cancel",
        worldId,
        chainId,
        exchangeId,
      });
      if (result.outcome === "not_running") {
        if (cancelledExchangeRef.current === exchangeId)
          cancelledExchangeRef.current = null;
        setFeedback({
          kind: "status",
          text: uiText("模型调用已经结束，正在刷新结果…"),
        });
        await refreshWorld();
      }
    } catch (reason: unknown) {
      if (cancelledExchangeRef.current === exchangeId)
        cancelledExchangeRef.current = null;
      setPlayProgress((current) =>
        current?.chainId === chainId && current.exchangeId === exchangeId
          ? { ...current, phase: "waiting" }
          : current,
      );
      setFeedback({ kind: "error", text: errorMessage(reason) });
    }
  }

  async function loadEarlierTimeline(): Promise<void> {
    if (playTimeline?.nextCursor === null || playTimeline === null) return;
    setPending("timeline-page");
    try {
      const earlier = await requestRuntime<V1PlayTimelinePage>(client, {
        type: "play.timeline.page",
        worldId,
        limit: 40,
        cursor: playTimeline.nextCursor,
      });
      setPlayTimeline((current) =>
        current === null
          ? earlier
          : current.generation !== earlier.generation
            ? current
            : {
                ...current,
                items: [...earlier.items, ...current.items],
                nextCursor: earlier.nextCursor,
              },
      );
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function previewControl(): Promise<void> {
    setPending("control-preview");
    try {
      const files = JSON.parse(controlFiles) as ContentTreeFile[];
      await client.request({
        type: "world.control-draft.save",
        worldId,
        files,
      });
      const preview = await client.request({
        type: "world.control-draft.preview",
        worldId,
      });
      setControlPreview(preview);
      setFeedback({
        kind: "status",
        text: uiText("控制草稿已通过真实提示词预览；确认后才会整批应用。"),
      });
    } catch (reason: unknown) {
      setControlPreview(null);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function applyControl(): Promise<void> {
    if (controlPreview === null || activeStatus === "running") return;
    setPending("control-apply");
    try {
      await client.request({ type: "world.control-draft.apply", worldId });
      await refreshWorld(false);
      setFeedback({ kind: "status", text: uiText("世界控制已整批应用。") });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function openRevision(path?: string): Promise<void> {
    if (path !== undefined) setSelectedDocument(path);
    setDialog("revision");
    setRightRailOpen(false);
    setReadingOpen(false);
    setRevisionLoading(true);
    setRevisionRequestFailure(null);
    try {
      const next = await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.open",
        worldId,
      });
      setRevisionOverview(next);
      setRevisionView(next.latest);
      setRevisionStartingFresh(next.latest === null);
      if (next.epoch !== null) {
        setRevisionFiles(cloneTextFiles(next.epoch.files));
        setSavedRevisionFiles(cloneTextFiles(next.epoch.files));
      }
      setWorld((current) =>
        current === null
          ? null
          : {
              ...current,
              worldRevision: next.epoch?.locked === true ? next.epoch : null,
            },
      );
      setRevisionNotice(
        uiText("世界已锁定到这份修订；关闭页面也会保留工作树。"),
      );
    } catch (reason: unknown) {
      setDialog(null);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setRevisionLoading(false);
    }
  }

  async function saveRevisionFiles(): Promise<void> {
    const epoch = revisionOverview?.epoch;
    if (
      epoch === null ||
      epoch === undefined ||
      !epoch.locked ||
      !revisionDirty
    )
      return;
    setRevisionLoading(true);
    setRevisionRequestFailure(null);
    try {
      const next = await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.files.replace",
        worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
        files: revisionFiles,
      });
      setRevisionOverview(next);
      if (next.epoch !== null) {
        setRevisionFiles(cloneTextFiles(next.epoch.files));
        setSavedRevisionFiles(cloneTextFiles(next.epoch.files));
      }
      setRevisionNotice(
        uiText("手动修改已保存到修订工作树，可以继续编辑或回滚。"),
      );
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
      throw reason;
    } finally {
      setRevisionLoading(false);
    }
  }

  async function sendRevisionMessage(message: string): Promise<void> {
    if (revisionDirty) return;
    const selectionVersion = revisionSelectionVersion.current;
    const selected = revisionStartingFresh ? null : revisionView;
    if (selected === null)
      revisionFreshRequest.current = {
        previousSessionId: revisionOverview?.latest?.sessionId ?? null,
      };
    setRevisionRequestFailure(null);
    setRevisionNotice("");
    try {
      const nextView = await requestRuntime<V1WorldRevisionView>(client, {
        type: "world.revision.message",
        worldId,
        requestId: createClientId("world-revision-message"),
        message,
        continuation:
          selected === null
            ? { kind: "fresh_context" }
            : {
                kind: "continue_context",
                sessionId: selected.sessionId,
              },
      });
      if (revisionSelectionVersion.current === selectionVersion) {
        revisionFreshRequest.current = null;
        setRevisionStartingFresh(false);
        setRevisionView(nextView);
      }
      const next = await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.overview",
        worldId,
      });
      setRevisionOverview(next);
      if (next.epoch !== null && !revisionDirtyRef.current) {
        setRevisionFiles(cloneTextFiles(next.epoch.files));
        setSavedRevisionFiles(cloneTextFiles(next.epoch.files));
      }
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
      throw reason;
    }
  }

  async function cancelRevisionMessage(): Promise<void> {
    if (revisionView === null) return;
    try {
      setRevisionView(
        await requestRuntime<V1WorldRevisionView>(client, {
          type: "world.revision.cancel",
          sessionId: revisionView.sessionId,
        }),
      );
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
    }
  }

  async function selectRevisionSession(sessionId: string): Promise<void> {
    const selectionVersion = ++revisionSelectionVersion.current;
    revisionFreshRequest.current = null;
    setRevisionLoading(true);
    setRevisionRequestFailure(null);
    try {
      const selected = await requestRuntime<V1WorldRevisionView>(client, {
        type: "world.revision.session.read",
        worldId,
        sessionId,
      });
      if (revisionSelectionVersion.current !== selectionVersion) return;
      setRevisionView(selected);
      setRevisionStartingFresh(false);
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
    } finally {
      setRevisionLoading(false);
    }
  }

  async function deleteRevisionSession(sessionId: string): Promise<void> {
    setRevisionLoading(true);
    setRevisionRequestFailure(null);
    try {
      const next = await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.session.delete",
        worldId,
        sessionId,
      });
      setRevisionOverview(next);
      if (revisionView?.sessionId === sessionId) setRevisionView(next.latest);
      setRevisionStartingFresh(next.latest === null);
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
    } finally {
      setRevisionLoading(false);
    }
  }

  async function rollbackRevisionFile(
    _sessionId: string,
    changeSetId: string,
    path: string,
  ): Promise<V1SettingImprovementRollbackResult> {
    const epoch = revisionOverview?.epoch;
    if (!epoch?.locked)
      throw new Error("The world-revision epoch is no longer active");
    setRevisionRequestFailure(null);
    try {
      const result = await requestRuntime<V1SettingImprovementRollbackResult>(
        client,
        {
          type: "world.revision.rollback",
          worldId,
          epochId: epoch.epochId,
          changeSetId,
          path,
        },
      );
      const next = await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.overview",
        worldId,
      });
      setRevisionOverview(next);
      if (next.epoch !== null) {
        setRevisionFiles(cloneTextFiles(next.epoch.files));
        setSavedRevisionFiles(cloneTextFiles(next.epoch.files));
      }
      setRevisionNotice(
        result.status === "already_rolled_back"
          ? uiText("这个文件已经是该次修改前的版本。")
          : uiText("已回滚所选文件；其他修订保持不变。"),
      );
      return result;
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
      throw reason;
    }
  }

  async function applyRevision(): Promise<void> {
    const epoch = revisionOverview?.epoch;
    if (
      epoch === null ||
      epoch === undefined ||
      !epoch.locked ||
      revisionDirty ||
      epoch.diagnostics.length > 0
    )
      return;
    setRevisionApplying(true);
    setRevisionRequestFailure(null);
    try {
      await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.apply",
        worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
      });
      setDialog(null);
      setRevisionOverview(null);
      setRevisionFiles([]);
      setSavedRevisionFiles([]);
      if (epoch.diff.length > 0) setForceFreshContext(true);
      await refreshWorld(false);
      setFeedback({
        kind: "status",
        text: uiText(
          "世界修订已应用并解锁。再次继续原对话时，AI 会先重新读取当前世界。",
        ),
      });
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
    } finally {
      setRevisionApplying(false);
    }
  }

  async function discardRevision(): Promise<void> {
    const epoch = revisionOverview?.epoch;
    if (
      epoch === null ||
      epoch === undefined ||
      !epoch.locked ||
      !globalThis.confirm(
        uiText("放弃这次世界修订？所有尚未应用的手动和 AI 修改都会丢失。"),
      )
    )
      return;
    setRevisionApplying(true);
    setRevisionRequestFailure(null);
    try {
      await requestRuntime<V1WorldRevisionOverview>(client, {
        type: "world.revision.discard",
        worldId,
        epochId: epoch.epochId,
      });
      setDialog(null);
      setRevisionOverview(null);
      setRevisionFiles([]);
      setSavedRevisionFiles([]);
      await refreshWorld(false);
      setFeedback({
        kind: "status",
        text: uiText("这次世界修订已放弃，原世界保持不变并已解锁。"),
      });
    } catch (reason: unknown) {
      setRevisionRequestFailure(errorMessage(reason));
    } finally {
      setRevisionApplying(false);
    }
  }
  async function deriveWorld(sourceHead = world?.head): Promise<void> {
    if (world === null) return;
    if (sourceHead === undefined) return;
    setPending("derive");
    try {
      const derived = await requestRuntime<{ world: { worldId: string } }>(
        client,
        {
          type: "world.derive",
          operationId: createClientId("derive"),
          sourceWorldId: world.worldId,
          sourceHead,
        },
      );
      await onOpenWorld(derived.world.worldId);
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
      setPending(null);
    }
  }

  async function reviseEditedPlayer(
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ): Promise<void> {
    if (world === null) return;
    if (editedText.trim().length === 0) {
      setFeedback({
        kind: "error",
        text: uiText("修改后的玩家提交不能为空。"),
      });
      return;
    }
    const replacementExchangeId = createClientId("play-exchange");
    setPending("revise");
    setFeedback({
      kind: "status",
      text: uiText("正在当前世界中保存修改，并舍弃这条消息之后的当前时间线…"),
    });
    try {
      const revised = await requestRuntime<{
        outcome: "revised";
        worldId: string;
        playCallChain: V1PlayCallChainView;
      }>(client, {
        type: "play.chain.revise-player",
        operationId: createClientId("revise-player"),
        worldId: world.worldId,
        chainId,
        eventId,
        replacementExchangeId,
        replacementText: editedText,
        continuation,
      });
      setPlayCallChain(revised.playCallChain);
      await refreshWorld();
      if (!modelConfigured) {
        setFeedback({
          kind: "status",
          text: uiText(
            "修改已保存在当前世界；配置模型后点击“追加上下文”即可继续生成。",
          ),
        });
        return;
      }

      setPending("play-append");
      setFeedback({
        kind: "status",
        text:
          continuation === "fresh_context"
            ? uiText("修改已保存，正在从全新上下文继续生成…")
            : uiText("修改已保存，正在从修改稿继续生成…"),
      });
      const continued = await requestRuntime<V1PlayCallChainView>(client, {
        type: "play.chain.append",
        worldId: world.worldId,
        chainId: revised.playCallChain.chainId,
        exchangeId: createClientId("play-exchange"),
        playerText: "",
      });
      setPlayCallChain(continued);
      await refreshWorld();
      setFeedback({
        kind: continued.status === "interrupted" ? "error" : "status",
        text:
          continued.status === "interrupted"
            ? continued.canRetry
              ? uiText(
                  "修改已保存，但模型请求中断；点击“追加上下文”即可原样重发。",
                )
              : uiText("修改已保存，但模型请求失败；请使用全新上下文继续。")
            : continuation === "fresh_context"
              ? uiText("修改已保存在当前世界，并已作为全新上下文继续。")
              : uiText("修改已保存在当前世界，并已从修改稿继续。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  function submitCurrentMode(): Promise<void> {
    return submitPlayChain(activeChainStale ? "fresh" : "append");
  }

  async function saveReadingPreferences(
    next: AppReadingPreferences,
  ): Promise<void> {
    setReadingPreferences(next);
    setReadingPreferencesSaving(true);
    try {
      await client.request({ type: "preferences.save", reading: next });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setReadingPreferencesSaving(false);
    }
  }

  async function renameCurrentWorld(): Promise<void> {
    const name = worldNameDraft.trim();
    if (name === "" || name === worldTitle) return;
    setPending("rename");
    setFeedback(null);
    try {
      await onRenameWorld(name);
      setFeedback({ kind: "status", text: uiText("世界名称已保存。") });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  const composer = useConversationComposer(
    modelConfigured &&
      (activeChainId === null || activeChainStale ? canStartFresh : canAppend),
    submitCurrentMode,
  );

  if (world === null)
    return (
      <main className="world-reader-page world-page-loading">
        <button className="world-back-button secondary-button" onClick={onBack}>
          {uiText("← 返回工作区")}
        </button>
        {feedback?.kind === "error" ? (
          <p role="alert">{feedback.text}</p>
        ) : (
          <p role="status">{uiText("正在打开世界…")}</p>
        )}
      </main>
    );

  if (dialog === "revision") {
    const epoch = revisionOverview?.epoch ?? activeRevisionEpoch;
    const panelView: SettingImprovementView | null =
      revisionStartingFresh || revisionView === null
        ? null
        : {
            ...revisionView,
            packageId: worldId,
            legacyDraft: null,
          };
    return (
      <SettingImprovementPanel
        target="world-revision"
        packageName={worldTitle}
        modelConfigured={modelConfigured}
        hasUnsavedFileDraft={revisionDirty}
        loading={revisionLoading}
        view={panelView}
        history={revisionOverview?.history ?? []}
        latestSessionId={revisionOverview?.latest?.sessionId ?? null}
        notice={revisionNotice}
        requestFailure={revisionRequestFailure ?? revisionObservationFailure}
        now={revisionNow}
        contentEditor={{
          mode: "world-revision",
          files: revisionFiles,
          ...(selectedDocument === ""
            ? {}
            : {
                selectedPath: selectedDocument.startsWith("state/")
                  ? selectedDocument
                  : `state/${selectedDocument}`,
              }),
          status:
            (epoch?.diagnostics.length ?? 0) === 0 ? "usable" : "needs_repair",
          issues: epoch?.diagnostics ?? [],
          immutablePaths:
            epoch?.files
              .filter(
                ({ path }) =>
                  path.startsWith("state/") &&
                  !epoch.diff.some(
                    (change) =>
                      change.path === path && change.kind === "create",
                  ),
              )
              .map(({ path }) => path) ?? [],
          dirty: revisionDirty,
          onFilesChange: setRevisionFiles,
          onSave: () => void saveRevisionFiles(),
          onReset: () => setRevisionFiles(cloneTextFiles(savedRevisionFiles)),
          onCopy: () => undefined,
          onExport: () => undefined,
          onDelete: () => undefined,
          title: worldTitle,
          onRename: () => undefined,
        }}
        onSend={sendRevisionMessage}
        onCancel={cancelRevisionMessage}
        onFreshContext={() => {
          revisionSelectionVersion.current += 1;
          revisionFreshRequest.current = null;
          setRevisionStartingFresh(true);
          setRevisionView(null);
          setRevisionRequestFailure(null);
        }}
        onSelectSession={selectRevisionSession}
        onDeleteSession={deleteRevisionSession}
        onRollbackFile={rollbackRevisionFile}
        onConfigureModel={onConfigureModel}
        onBack={() => {
          revisionSelectionVersion.current += 1;
          revisionFreshRequest.current = null;
          setDialog(null);
          setRevisionRequestFailure(null);
          void refreshWorld(false);
        }}
        {...(epoch?.locked === true
          ? {
              revisionActions: {
                changedFileCount: epoch.diff.length,
                canApply: modelConfigured && epoch.diagnostics.length === 0,
                applying: revisionApplying,
                changes: epoch.changes,
                sealedEpochs: revisionOverview?.sealedEpochs ?? [],
                onApply: applyRevision,
                onDiscard: discardRevision,
              },
            }
          : {})}
      />
    );
  }

  const defaultSubmitFresh = activeChainId === null || activeChainStale;
  const defaultSubmitEnabled = defaultSubmitFresh ? canStartFresh : canAppend;

  return (
    <main
      className="world-reader-page"
      style={
        {
          "--world-story-size": readingPreferences.fontSize + "px",
          "--world-story-leading": readingPreferences.lineHeight,
          "--world-story-tracking": readingPreferences.letterSpacing + "em",
          "--world-story-measure": readingPreferences.measure + "rem",
          "--world-composer-height": composerHeight + "px",
          "--world-story-paragraph-gap":
            readingPreferences.density === "compact"
              ? "0.5em"
              : readingPreferences.density === "standard"
                ? "0.8em"
                : "1.1em",
          "--world-story-block-gap":
            readingPreferences.density === "compact"
              ? "1.3em"
              : readingPreferences.density === "standard"
                ? "1.85em"
                : "2.4em",
        } as React.CSSProperties
      }
    >
      <ArtifactExtensionHost
        worldId={world.worldId}
        artifacts={world.artifacts ?? []}
        playerViewPanels={world.playerViewPanels ?? []}
        playerViews={world.playerViews}
        interactionDisabled={pending !== null || worldRevisionLocked}
        onSetComposerDraft={setPlayerText}
        onRefresh={async () => {
          await refreshWorld();
        }}
        onBridgeEvent={(recordId, event) =>
          setBridgeEvents((current) => ({
            ...current,
            [recordId]: [...(current[recordId] ?? []), event],
          }))
        }
      >
        <div className="world-reader-shell">
          <nav
            className="world-floating-chrome world-floating-chrome-left"
            aria-label={uiText("世界与状态")}
          >
            <button
              type="button"
              onClick={onBack}
              aria-label={uiText("返回工作区")}
            >
              ←
            </button>
            <button
              type="button"
              className={leftRailOpen ? "is-current" : ""}
              aria-pressed={leftRailOpen}
              onClick={() => setLeftRailOpen((open) => !open)}
            >
              {uiText("此刻")}
            </button>
          </nav>

          <h1 className="world-floating-title" title={worldTitle}>
            {worldTitle}
          </h1>

          <nav
            className="world-floating-chrome world-floating-chrome-right"
            aria-label={uiText("世界阅读工具")}
          >
            <button
              type="button"
              className={
                rightRailOpen && rightRailTab === "documents"
                  ? "is-current"
                  : ""
              }
              onClick={() => {
                setRightRailTab("documents");
                setRightRailOpen(true);
                setReadingOpen(false);
              }}
            >
              {uiText("世界")}
            </button>
            <button
              type="button"
              className={
                rightRailOpen && rightRailTab === "ai-reading"
                  ? "is-current"
                  : ""
              }
              onClick={() => {
                setRightRailTab("ai-reading");
                setRightRailOpen(true);
                setReadingOpen(false);
              }}
            >
              {uiText("AI 读取")}
            </button>
            <button
              type="button"
              className={readingOpen ? "is-current" : ""}
              aria-label={uiText("阅读设置")}
              onClick={() => {
                setReadingOpen((open) => !open);
                setRightRailOpen(false);
              }}
            >
              Aa
            </button>
            <button
              type="button"
              aria-label={uiText("世界管理")}
              onClick={() => {
                setDialog("manage");
                setReadingOpen(false);
              }}
            >
              ···
            </button>
          </nav>

          <section
            className="world-reader-scroll"
            aria-label={uiText("世界游玩")}
          >
            <article
              className="world-story-column"
              aria-busy={pending !== null || activeStatus === "running"}
              aria-label={uiText("故事时间线")}
            >
              <ArtifactExtensionMount mount="story" />
              {playTimeline?.nextCursor === null ? null : (
                <button
                  type="button"
                  className="secondary-button timeline-load-earlier"
                  disabled={pending !== null}
                  onClick={() => void loadEarlierTimeline()}
                >
                  {pending === "timeline-page"
                    ? uiText("正在加载…")
                    : uiText("加载更早的故事")}
                </button>
              )}
              {playTimeline !== null && playTimeline.items.length > 0 ? (
                <PlayTimeline
                  client={client}
                  worldId={worldId}
                  items={playTimeline.items}
                  restartDisabled={pending !== null || worldRevisionLocked}
                  freshContextDisabled={!modelConfigured}
                  onUseFreshContext={() => {
                    setForceFreshContext(true);
                    composerRef.current?.querySelector("textarea")?.focus();
                  }}
                  onRestartFrom={(head) => void deriveWorld(head)}
                  onEditPlayer={(chainId, eventId, editedText, continuation) =>
                    void reviseEditedPlayer(
                      chainId,
                      eventId,
                      editedText,
                      continuation,
                    )
                  }
                />
              ) : committedMessages.length === 0 ? (
                <div className="story-empty-state">
                  <span aria-hidden="true">✦</span>
                  <h3>{uiText("故事还没有开始")}</h3>
                  <p>{uiText("描述你的行动，从当前世界开始一条调用链。")}</p>
                </div>
              ) : (
                <Transcript
                  messages={committedMessages.map((message) => ({
                    ...message,
                    pending: false,
                  }))}
                  restartDisabled={pending !== null || worldRevisionLocked}
                  onRestartFrom={(head) => void deriveWorld(head)}
                />
              )}
              {playProgress === null ? null : (
                <PlayRunProgress
                  progress={playProgress}
                  now={playProgressNow}
                  onCancel={() => void cancelPlayGeneration()}
                />
              )}
              <div ref={historyEndRef} />
            </article>
          </section>

          <footer ref={composerRef} className="world-composer-dock">
            <ArtifactExtensionMount mount="composer_above" />
            {worldRevisionLocked ? (
              <div className="model-required-callout" role="status">
                <p>
                  {uiText(
                    "世界正在修订，游玩和其他世界修改已锁定；应用或放弃后会解锁。",
                  )}
                </p>
                <button type="button" onClick={() => void openRevision()}>
                  {uiText("继续修订")}
                </button>
              </div>
            ) : null}
            {!modelConfigured ? (
              <div className="model-required-callout">
                <p>{uiText("需要先配置模型连接才能游玩。")}</p>
                <button type="button" onClick={onConfigureModel}>
                  {uiText("配置模型")}
                </button>
              </div>
            ) : null}
            {playObservationFailure === null ? null : (
              <p role="status">{playObservationFailure}</p>
            )}
            {playFailure === null ? null : (
              <div
                className="play-call-failure"
                role="alert"
                aria-label={uiText("模型调用失败")}
              >
                <strong>{uiText("模型调用失败")}</strong>
                <p>{playFailure}</p>
              </div>
            )}
            {!activeCanRetry ? null : (
              <div className="play-retry-note" role="alert">
                <span aria-hidden="true">!</span>
                <p>
                  {uiText(
                    "上次模型请求没有完整返回。保持输入为空并重试，会原样发送保存的请求。",
                  )}
                </p>
              </div>
            )}
            {activeChainStale && playIdle ? (
              <div className="world-fresh-context-note" role="note">
                {uiText("世界已在故事外修订；下一次行动会从新上下文开始。")}
              </div>
            ) : null}
            <div className="world-composer-row">
              <details className="world-composer-mode">
                <summary aria-label={uiText("选择提交方式")}>＋</summary>
                <div>
                  <button
                    type="button"
                    aria-label={uiText("追加上下文")}
                    disabled={!canAppend || !modelConfigured}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void submitPlayChain("append");
                    }}
                  >
                    <strong>{uiText("追加当前上下文")}</strong>
                    <span>{uiText("保留这条调用链已经看到的内容")}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={uiText("全新上下文")}
                    disabled={!canStartFresh || !modelConfigured}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void submitPlayChain("fresh");
                    }}
                  >
                    <strong>{uiText("使用全新上下文")}</strong>
                    <span>{uiText("从当前世界重新编译材料")}</span>
                  </button>
                </div>
              </details>
              <label>
                <span className="visually-hidden">{uiText("你的行动")}</span>
                <textarea
                  ref={composerTextareaRef}
                  aria-label={uiText("你的行动")}
                  rows={1}
                  placeholder={uiText("接下来，你要做什么？")}
                  value={playerText}
                  disabled={
                    pending !== null ||
                    !modelConfigured ||
                    activeStatus === "running" ||
                    worldRevisionLocked
                  }
                  onChange={(event) => setPlayerText(event.target.value)}
                  onKeyDown={composer.onKeyDown}
                  title={uiText("Enter 发送，Shift + Enter 换行")}
                />
              </label>
              <button
                type="button"
                className="world-composer-send"
                aria-label={
                  defaultSubmitFresh
                    ? uiText("从全新上下文发送行动")
                    : uiText("追加行动")
                }
                disabled={!defaultSubmitEnabled || !modelConfigured}
                onClick={() => void composer.submit()}
              >
                {pending === "play-fresh" || pending === "play-append"
                  ? "…"
                  : "↑"}
              </button>
            </div>
            <ArtifactExtensionMount mount="composer_below" />
          </footer>

          <button
            type="button"
            className={
              leftRailOpen || rightRailOpen
                ? "world-panel-scrim is-visible"
                : "world-panel-scrim"
            }
            aria-label={uiText("收起侧栏")}
            onClick={() => {
              setLeftRailOpen(false);
              setRightRailOpen(false);
            }}
          />

          <aside
            className={
              leftRailOpen
                ? "world-overlay-rail world-overlay-rail-left is-open"
                : "world-overlay-rail world-overlay-rail-left"
            }
            aria-hidden={!leftRailOpen}
            aria-label={uiText("当前情景")}
          >
            <header>
              <div>
                <span>PLAYER VIEW</span>
                <strong>{uiText("此刻")}</strong>
              </div>
              <button
                type="button"
                aria-label={uiText("收起状态栏")}
                onClick={() => setLeftRailOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="world-overlay-rail-body">
              <ArtifactExtensionMount mount="sidebar" />
              {playerViewFallback.views.length === 0 ? (
                playerViewFallback.coveredViewIds.size > 0 ? null : (
                  <div className="player-view-empty">
                    <p>{uiText("这个世界还没有配置常驻玩家视图。")}</p>
                    <small>
                      {uiText("你仍然可以正常游玩；未显示不代表秘密。")}
                    </small>
                  </div>
                )
              ) : (
                playerViewFallback.views.map((view) => (
                  <PlayerViewCard key={view.id} view={view} />
                ))
              )}
              {playerViewFallback.diagnostics.length === 0 ? null : (
                <details className="player-view-diagnostics">
                  <summary>
                    {playerViewFallback.diagnostics.length}{" "}
                    {uiText("项视图诊断")}
                  </summary>
                  <ul>
                    {playerViewFallback.diagnostics.map((diagnostic, index) => (
                      <li key={diagnostic.code + "-" + index}>
                        {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </aside>

          <aside
            className={
              rightRailOpen
                ? "world-overlay-rail world-overlay-rail-right is-open"
                : "world-overlay-rail world-overlay-rail-right"
            }
            aria-hidden={!rightRailOpen}
            aria-label={
              rightRailTab === "documents"
                ? uiText("当前世界")
                : uiText("AI 如何读取")
            }
          >
            <header>
              <div>
                <span>WORLD CONTEXT</span>
                <strong>
                  {rightRailTab === "documents"
                    ? uiText("当前世界")
                    : uiText("AI 如何读取")}
                </strong>
              </div>
              <button
                type="button"
                aria-label={uiText("收起世界栏")}
                onClick={() => setRightRailOpen(false)}
              >
                ×
              </button>
            </header>
            <nav aria-label={uiText("世界侧栏")}>
              <button
                type="button"
                className={rightRailTab === "documents" ? "is-current" : ""}
                onClick={() => setRightRailTab("documents")}
              >
                {uiText("世界")}
              </button>
              <button
                type="button"
                className={rightRailTab === "ai-reading" ? "is-current" : ""}
                onClick={() => setRightRailTab("ai-reading")}
              >
                {uiText("AI 读取")}
              </button>
            </nav>
            <div className="world-overlay-rail-body">
              {rightRailTab === "documents" ? (
                <WorldDocumentRail
                  documents={documents}
                  selectedPath={selectedDocument}
                  onSelect={setSelectedDocument}
                  onRevise={(path) => void openRevision(path)}
                  revisionDisabled={
                    pending !== null || activeStatus === "running"
                  }
                />
              ) : (
                <AiReadingRail
                  reading={aiReading}
                  loading={aiReadingLoading}
                  documents={documents}
                  onOpenFull={() => setDialog("reading")}
                />
              )}
            </div>
            <footer>
              <button
                type="button"
                disabled={pending !== null || activeStatus === "running"}
                onClick={() => void openRevision()}
              >
                {uiText("修订当前世界")}
              </button>
              <button type="button" onClick={() => setDialog("manage")}>
                {uiText("世界管理")}
              </button>
            </footer>
          </aside>

          {readingOpen ? (
            <ReadingPreferencesPopover
              value={readingPreferences}
              saving={readingPreferencesSaving}
              onChange={(next) => void saveReadingPreferences(next)}
              onClose={() => setReadingOpen(false)}
            />
          ) : null}

          {dialog === "reading" ? (
            <AiReadingDialog
              reading={aiReading}
              documents={documents}
              onClose={() => setDialog(null)}
            />
          ) : null}

          {dialog === "manage" ? (
            <WorldManagementDialog
              world={world}
              worldTitle={worldTitle}
              worldNameDraft={worldNameDraft}
              setWorldNameDraft={setWorldNameDraft}
              pending={pending}
              activeStatus={activeStatus}
              controlFiles={controlFiles}
              controlDirty={controlDirty}
              controlPreview={controlPreview}
              onControlFiles={(value) => {
                setControlFiles(value);
                setControlDirty(true);
                setControlPreview(null);
              }}
              onRename={() => void renameCurrentWorld()}
              onDerive={() => void deriveWorld(world.head)}
              onPreviewControl={() => void previewControl()}
              onApplyControl={() => void applyControl()}
              onClose={() => setDialog(null)}
              modelConfigured={modelConfigured}
              revisionLocked={worldRevisionLocked}
            />
          ) : null}

          {feedback === null ? null : (
            <p
              className={"world-feedback " + feedback.kind}
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.text}
            </p>
          )}

          <ArtifactExtensionMount mount="overlay" />
          <ArtifactExtensionMount mount="debug" />
          <ArtifactDebugger
            records={world.artifactDebug ?? []}
            extensions={world.extensions ?? []}
            playerViewPanels={world.playerViewPanels ?? []}
            bridgeEvents={bridgeEvents}
          />
        </div>
      </ArtifactExtensionHost>
    </main>
  );
}

function PlayTimeline({
  client,
  worldId,
  items,
  restartDisabled,
  freshContextDisabled,
  onRestartFrom,
  onEditPlayer,
  onUseFreshContext,
}: {
  client: WorldPageClient;
  worldId: string;
  items: readonly V1PlayTimelineItem[];
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  onUseFreshContext: () => void;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
}): React.JSX.Element {
  const groups = groupPlayTimelineItems(items);
  return (
    <ol
      className="call-chain-events play-timeline-events"
      aria-label={uiText("模型调用链")}
    >
      {groups.map((group) => {
        if (group.kind === "turn") {
          const traceEvents = group.items.filter(({ event }) =>
            timelineEventHasTrace(event),
          );
          return (
            <Fragment key={group.key}>
              {group.items.map((item) =>
                timelineEventBelongsInStory(item.event) ? (
                  <TimelineEvent
                    key={`${item.chainId}:${item.event.id}`}
                    client={client}
                    worldId={worldId}
                    chainId={item.chainId}
                    event={item.event}
                    restartDisabled={restartDisabled}
                    freshContextDisabled={freshContextDisabled}
                    onRestartFrom={onRestartFrom}
                    onEditPlayer={onEditPlayer}
                    presentation="story"
                    onUseFreshContext={onUseFreshContext}
                  />
                ) : null,
              )}
              {traceEvents.length === 0 ? null : (
                <li className="world-timeline-trace">
                  <details>
                    <summary>
                      <span>{uiText("本段调用详情")}</span>
                      <small>
                        {uiText("{count} 项记录", {
                          count: traceEvents.length,
                        })}
                      </small>
                    </summary>
                    <ol
                      className="world-timeline-trace-events"
                      aria-label={uiText("本段模型调用详情")}
                    >
                      {traceEvents.map((item) => (
                        <TimelineEvent
                          key={`trace:${item.chainId}:${item.event.id}`}
                          client={client}
                          worldId={worldId}
                          chainId={item.chainId}
                          event={item.event}
                          restartDisabled={restartDisabled}
                          freshContextDisabled={freshContextDisabled}
                          onRestartFrom={onRestartFrom}
                          onEditPlayer={onEditPlayer}
                          presentation="trace"
                          onUseFreshContext={onUseFreshContext}
                        />
                      ))}
                    </ol>
                  </details>
                </li>
              )}
            </Fragment>
          );
        }
        const item = group.item;
        if (item.kind === "context_boundary")
          return (
            <li
              key={group.key}
              className="story-context-boundary"
              role="separator"
              aria-label={uiText("全新上下文从这里开始")}
            >
              <span>{uiText("全新上下文从这里开始")}</span>
              <small>{item.playPreset.name}</small>
              <details className="call-chain-summary">
                <summary>{uiText("本上下文已提交的世界变化")}</summary>
                {item.changedDocuments.length === 0 ? (
                  <span>{uiText("没有文档变化")}</span>
                ) : (
                  <ul>
                    {item.changedDocuments.map((change) => (
                      <li key={`${change.kind}:${change.path}`}>
                        {change.kind === "create"
                          ? uiText("新建")
                          : uiText("更新")}{" "}
                        {change.ref} · {change.path}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          );
        if (item.kind === "genesis")
          return (
            <li key={group.key} className={`${item.role}-message`}>
              <article>
                <header>
                  <strong>
                    {item.role === "player" ? uiText("你") : uiText("主持")}
                  </strong>
                </header>
                <p>{item.exactText}</p>
              </article>
            </li>
          );
        return null;
      })}
    </ol>
  );
}

type PlayTimelineEventItem = Extract<V1PlayTimelineItem, { kind: "event" }>;
type PlayTimelineStandaloneItem = Exclude<
  V1PlayTimelineItem,
  { kind: "event" }
>;
type PlayTimelineGroup =
  | {
      kind: "standalone";
      key: string;
      item: PlayTimelineStandaloneItem;
    }
  | {
      kind: "turn";
      key: string;
      items: PlayTimelineEventItem[];
    };

function groupPlayTimelineItems(
  items: readonly V1PlayTimelineItem[],
): PlayTimelineGroup[] {
  const groups: PlayTimelineGroup[] = [];
  let turn: PlayTimelineEventItem[] = [];
  const flushTurn = (): void => {
    const first = turn[0];
    if (first === undefined) return;
    groups.push({
      kind: "turn",
      key: `turn:${first.chainId}:${first.event.id}`,
      items: turn,
    });
    turn = [];
  };

  for (const item of items) {
    if (item.kind !== "event") {
      flushTurn();
      groups.push({
        kind: "standalone",
        key:
          item.kind === "context_boundary"
            ? `context:${item.chainId}`
            : `genesis:${item.messageId}`,
        item,
      });
      continue;
    }
    const beginsTurn =
      item.event.kind === "player" ||
      (item.event.kind === "assistant" && turnHasCompletedNarrative(turn));
    if (beginsTurn) flushTurn();
    turn.push(item);
  }
  flushTurn();
  return groups;
}

function turnHasCompletedNarrative(
  items: readonly PlayTimelineEventItem[],
): boolean {
  return items.some(
    ({ event }) =>
      event.kind === "assistant" &&
      event.status === "completed" &&
      assistantResponseKind(event) === "narrative",
  );
}

function timelineEventBelongsInStory(
  event: V1PlayTimelineEventSummary,
): boolean {
  if (
    event.kind === "player" ||
    event.kind === "failure" ||
    event.kind === "cancellation"
  )
    return true;
  if (event.kind === "followup") return event.failed;
  if (event.kind !== "assistant") return false;
  return (
    event.status === "streaming" || assistantResponseKind(event) === "narrative"
  );
}

function timelineEventHasTrace(event: V1PlayTimelineEventSummary): boolean {
  if (
    event.kind === "tool_call" ||
    event.kind === "tool_result" ||
    event.kind === "followup"
  )
    return true;
  if (event.kind !== "assistant" || event.status === "streaming") return false;
  return (
    assistantResponseKind(event) !== "narrative" ||
    event.usage !== undefined ||
    event.detailsAvailable
  );
}

function TimelineEvent({
  client,
  worldId,
  chainId,
  event,
  restartDisabled,
  freshContextDisabled,
  onRestartFrom,
  onEditPlayer,
  presentation,
  onUseFreshContext,
}: {
  client: WorldPageClient;
  worldId: string;
  chainId: string;
  event: V1PlayTimelineEventSummary;
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
  presentation: "story" | "trace";
  onUseFreshContext: () => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<V1PlayCallChainEvent | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [revisionContinuation, setRevisionContinuation] =
    useState<PlayerRevisionContinuation>("continue_context");
  const loadDetail = async (): Promise<void> => {
    if (detail !== null || detailPending) return;
    setDetailPending(true);
    setDetailError(null);
    try {
      setDetail(
        await requestRuntime<V1PlayCallChainEvent>(client, {
          type: "play.timeline.detail",
          worldId,
          chainId,
          eventId: event.id,
        }),
      );
    } catch (reason: unknown) {
      setDetailError(errorMessage(reason));
    } finally {
      setDetailPending(false);
    }
  };

  if (event.kind === "player")
    return (
      <li className="call-chain-player">
        <article>
          <header>
            <strong>{uiText("玩家")}</strong>
            <span>
              {event.context === "fresh"
                ? uiText("全新上下文")
                : uiText("追加上下文")}
            </span>
            {event.committedHead === undefined ? null : (
              <span className="history-message-actions">
                {event.committedHead === "genesis" ? null : (
                  <button
                    type="button"
                    className="history-restart-button"
                    disabled={restartDisabled}
                    onClick={() => {
                      setEditedText(event.text);
                      setRevisionContinuation("continue_context");
                    }}
                  >
                    {uiText("修改")}
                  </button>
                )}
                <button
                  type="button"
                  className="history-restart-button"
                  disabled={restartDisabled}
                  onClick={() => onRestartFrom(event.committedHead!)}
                >
                  {uiText("创建分叉")}
                </button>
              </span>
            )}
          </header>
          {editedText === null ? (
            <p>{event.text}</p>
          ) : (
            <div className="history-player-edit">
              <label>
                <span>{uiText("修改后的行动")}</span>
                <textarea
                  aria-label={uiText("修改后的行动")}
                  rows={3}
                  value={editedText}
                  disabled={restartDisabled}
                  onChange={(change) => setEditedText(change.target.value)}
                />
              </label>
              <p>
                {uiText(
                  "修改会直接保存在当前世界；这条原提交及其后的内容会离开当前时间线，但旧 Authority 记录仍可恢复。",
                )}
              </p>
              <fieldset className="history-player-edit-continuation">
                <legend>{uiText("修改后如何继续")}</legend>
                <label>
                  <input
                    type="radio"
                    name={`revision-continuation-${chainId}-${event.id}`}
                    value="continue_context"
                    checked={revisionContinuation === "continue_context"}
                    disabled={restartDisabled}
                    onChange={() => setRevisionContinuation("continue_context")}
                  />
                  <span>
                    <strong>{uiText("沿原上下文继续")}</strong>
                    <small>
                      {uiText("保留修改点以前的模型对话和原生续传。")}
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`revision-continuation-${chainId}-${event.id}`}
                    value="fresh_context"
                    checked={revisionContinuation === "fresh_context"}
                    disabled={restartDisabled || freshContextDisabled}
                    onChange={() => setRevisionContinuation("fresh_context")}
                  />
                  <span>
                    <strong>{uiText("作为全新上下文保存")}</strong>
                    <small>
                      {uiText(
                        "不继承旧模型对话；修改稿会成为全新上下文的第一条消息。",
                      )}
                    </small>
                  </span>
                </label>
              </fieldset>
              <div className="button-row">
                <button
                  type="button"
                  disabled={
                    restartDisabled ||
                    editedText.trim().length === 0 ||
                    (revisionContinuation === "fresh_context" &&
                      freshContextDisabled)
                  }
                  onClick={() =>
                    onEditPlayer(
                      chainId,
                      event.id,
                      editedText,
                      revisionContinuation,
                    )
                  }
                >
                  {revisionContinuation === "fresh_context"
                    ? uiText("保存为全新上下文并继续")
                    : uiText("保存修改并继续")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={restartDisabled}
                  onClick={() => setEditedText(null)}
                >
                  {uiText("取消")}
                </button>
              </div>
            </div>
          )}
        </article>
      </li>
    );

  if (event.kind === "assistant") {
    const full = detail?.kind === "assistant" ? detail : null;
    const responseKind = assistantResponseKind(event);
    const responseClass =
      responseKind === "tool_step" ? "tool-step" : responseKind;
    const diagnostics = (
      <>
        {event.usage === undefined ? null : (
          <ModelUsageBreakdown usage={event.usage} compact />
        )}
        {!event.detailsAvailable ? null : event.status === "streaming" ? (
          <small>{uiText("响应完成后可查看模型诊断详情")}</small>
        ) : (
          <details
            onToggle={(change) =>
              change.currentTarget.open && void loadDetail()
            }
          >
            <summary>{uiText("查看模型诊断详情")}</summary>
            {detailPending ? <p>{uiText("正在加载…")}</p> : null}
            {detailError === null ? null : <p role="alert">{detailError}</p>}
            {full?.reasoning === undefined ? null : (
              <>
                <p>
                  <strong>
                    {uiText("Provider 返回推理（不等同隐藏思维链）")}
                  </strong>
                </p>
                <pre>{full.reasoning}</pre>
              </>
            )}
            {full?.toolFragment === undefined ? null : (
              <pre>{full.toolFragment}</pre>
            )}
            {full?.stopReason === undefined &&
            full?.continuation === undefined ? null : (
              <dl className="prompt-budget-breakdown">
                {full.stopReason === undefined ? null : (
                  <div>
                    <dt>{uiText("完成原因")}</dt>
                    <dd>{full.stopReason}</dd>
                  </div>
                )}
                {full.continuation === undefined ? null : (
                  <div>
                    <dt>{uiText("原生续传载荷")}</dt>
                    <dd>
                      {full.continuation === "available"
                        ? uiText("可用")
                        : uiText("不可用")}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {full?.usage === undefined ? null : (
              <ModelUsageBreakdown usage={full.usage} showProvenance />
            )}
          </details>
        )}
      </>
    );
    if (presentation === "trace" && responseKind === "narrative")
      return (
        <li className="call-chain-assistant-diagnostics">
          <article>
            <header>
              <strong>{uiText("AI 响应诊断")}</strong>
              <span>
                {uiText("{status} · 第 {attempt} 次派发", {
                  status: callChainAssistantStatusLabel(event.status),
                  attempt: event.attempt,
                })}
              </span>
            </header>
            {diagnostics}
          </article>
        </li>
      );
    return (
      <li
        className={`call-chain-assistant is-${event.status} is-${responseClass}`}
      >
        <article>
          <header>
            <strong>
              {event.status === "streaming"
                ? uiText("模型响应中")
                : responseKind === "tool_step"
                  ? uiText("模型工具步骤")
                  : responseKind === "empty"
                    ? uiText("空模型响应")
                    : uiText("AI 响应")}
            </strong>
            <span>
              {uiText("{status} · 第 {attempt} 次派发", {
                status: callChainAssistantStatusLabel(event.status),
                attempt: event.attempt,
              })}
            </span>
            {event.committedHead === undefined ? null : (
              <button
                type="button"
                className="history-restart-button"
                disabled={restartDisabled}
                onClick={() => onRestartFrom(event.committedHead!)}
              >
                {uiText("创建分叉")}
              </button>
            )}
          </header>
          {responseKind === "tool_step" && event.text.length > 0 ? (
            <details className="call-chain-tool-step-text">
              <summary>{uiText("查看工具步骤文本（未进入故事）")}</summary>
              <p>{event.text}</p>
            </details>
          ) : (
            <p>
              {event.text.length > 0
                ? event.text
                : event.status === "streaming"
                  ? uiText("正在接收模型输出…")
                  : responseKind === "tool_step"
                    ? uiText("（本次响应只调用了工具）")
                    : uiText("（本次响应没有文本）")}
            </p>
          )}
          {responseKind === "pending" ? (
            <small>{uiText("待定输出；响应完成前不会进入故事")}</small>
          ) : null}
          {event.checkpoint === true &&
          event.status === "completed" &&
          responseKind === "narrative" ? (
            <aside className="play-checkpoint-note">
              <p>{uiText("AI 建议在此开启全新上下文")}</p>
              <button
                type="button"
                className="secondary-button"
                disabled={restartDisabled || freshContextDisabled}
                onClick={onUseFreshContext}
              >
                {uiText("下一条消息使用全新上下文")}
              </button>
            </aside>
          ) : null}
          {presentation === "trace" ? (
            diagnostics
          ) : event.status === "streaming" && event.detailsAvailable ? (
            <small>{uiText("响应完成后可查看模型诊断详情")}</small>
          ) : null}
        </article>
      </li>
    );
  }

  if (event.kind === "tool_call") {
    const full = detail?.kind === "tool_call" ? detail : null;
    return (
      <li className="call-chain-tool">
        <details
          onToggle={(change) => change.currentTarget.open && void loadDetail()}
        >
          <summary>
            <strong>{uiText("调用 {tool}", { tool: event.name })}</strong>
            <span>
              {event.replayed ? uiText("复用同 ID 结果") : event.callId}
            </span>
          </summary>
          {detailPending ? <p>{uiText("正在加载…")}</p> : null}
          {detailError === null ? null : <p role="alert">{detailError}</p>}
          {full === null ? null : <pre>{safeJson(full.arguments)}</pre>}
        </details>
      </li>
    );
  }

  if (event.kind === "tool_result") {
    const full = detail?.kind === "tool_result" ? detail : null;
    return (
      <li
        className={`call-chain-tool-result ${event.ok ? "is-ok" : "is-error"}`}
      >
        <details
          onToggle={(change) => change.currentTarget.open && void loadDetail()}
        >
          <summary>
            <strong>
              {event.name} {uiText("返回")}
            </strong>
            <span>{event.ok ? uiText("成功") : uiText("拒绝／失败")}</span>
          </summary>
          {detailPending ? <p>{uiText("正在加载…")}</p> : null}
          {detailError === null ? null : <p role="alert">{detailError}</p>}
          {full === null ? null : <pre>{full.markdown}</pre>}
        </details>
      </li>
    );
  }

  if (event.kind === "followup") {
    const full = detail?.kind === "followup" ? detail : null;
    return (
      <li
        className={`call-chain-followup ${event.failed ? "is-error" : "is-ok"}`}
      >
        <details
          onToggle={(change) => change.currentTarget.open && void loadDetail()}
        >
          <summary>
            <strong>
              {uiText("后置请求 ·")}
              {event.displayName}
            </strong>
            <span>
              {event.failed
                ? uiText("未完成")
                : uiText("{count} 项产物", { count: event.toolCallCount })}
            </span>
          </summary>
          {detailPending ? <p>{uiText("正在加载…")}</p> : null}
          {detailError === null ? null : <p role="alert">{detailError}</p>}
          {full === null ? null : <pre>{safeJson(full)}</pre>}
        </details>
        {event.usage === undefined ? null : (
          <ModelUsageBreakdown usage={event.usage} compact />
        )}
      </li>
    );
  }

  if (event.kind === "cancellation")
    return (
      <li className="call-chain-cancellation" role="status">
        <strong>{uiText("生成已取消")}</strong>
        <p>
          {uiText(
            "本轮生成已停止；已提交的玩家原文保留，未完成的模型输出不会进入故事。",
          )}
        </p>
      </li>
    );

  return (
    <li className="call-chain-failure" role="alert">
      <strong>{uiText("调用链中断")}</strong>
      <p>{event.message}</p>
    </li>
  );
}

function Transcript({
  messages,
  restartDisabled = false,
  onRestartFrom,
}: {
  messages: readonly (WorldMessage & { pending: boolean })[];
  restartDisabled?: boolean;
  onRestartFrom?: (head: string) => void;
}): React.JSX.Element {
  return (
    <ol className="narrative-list">
      {messages.map((message, index) => (
        <li
          key={message.messageId ?? `${index}-${message.role}`}
          className={`${message.role}-message ${message.pending ? "pending-message" : ""}`}
        >
          <article>
            <header>
              <strong>
                {message.role === "player" ? uiText("你") : uiText("主持")}
              </strong>
              {message.pending ? <span>{uiText("未结算")}</span> : null}
              {message.head === undefined ||
              onRestartFrom === undefined ? null : (
                <button
                  type="button"
                  className="history-restart-button"
                  disabled={restartDisabled}
                  onClick={() => onRestartFrom(message.head!)}
                >
                  {uiText("创建分叉")}
                </button>
              )}
            </header>
            <p>{message.exactText}</p>
          </article>
        </li>
      ))}
    </ol>
  );
}

function callChainAssistantStatusLabel(
  status: Extract<V1PlayCallChainEvent, { kind: "assistant" }>["status"],
): string {
  if (status === "streaming") return uiText("接收中");
  if (status === "interrupted") return uiText("中断片段");
  return uiText("已完成");
}

function assistantResponseKind(
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return uiText("[参数无法序列化]");
  }
}

function PlayerViewCard({
  view,
}: {
  view: RenderedPlayerView;
}): React.JSX.Element {
  return (
    <article className="player-view-card">
      <h3>{view.title}</h3>
      {view.items.length === 0 ? (
        <p className="player-view-empty-value">
          {uiText("当前没有可显示项目。")}
        </p>
      ) : (
        <dl>
          {view.items.map((item) => (
            <div key={item.id}>
              <dt>{item.label}</dt>
              <dd>
                <PlayerValue value={item.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function PlayerValue({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="empty-value">—</span>;
  if (typeof value === "string")
    return <span className="text-value">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    const entries = value as unknown[];
    return (
      <ul className="player-value-list">
        {entries.map((entry, index) => (
          <li key={index}>
            <PlayerValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    if (typeof value.$ref === "string")
      return (
        <span className="document-reference">
          {typeof value.title === "string" ? value.title : value.$ref}
          {typeof value.ref === "string" ? ` · @${value.ref}` : ""}
        </span>
      );
    return (
      <dl className="player-value-map">
        {Object.entries(value).map(([key, child]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <PlayerValue value={child} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === "bigint") return <span>{value.toString()}</span>;
  if (typeof value === "symbol")
    return <span>{value.description ?? "Symbol"}</span>;
  return <span className="empty-value">{uiText("[无法显示]")}</span>;
}

function selectedStateDocument(
  state: readonly ContentTreeFile[],
  current: string,
): string {
  return state.some(({ path }) => path === current)
    ? current
    : (state[0]?.path ?? "");
}

function cloneTextFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files.map((file) => ({ ...file }));
}

function sameTextFiles(
  left: readonly ContentTreeFile[],
  right: readonly ContentTreeFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const candidate = right[index];
      return (
        candidate?.path === file.path &&
        candidate.contents === file.contents &&
        candidate.encoding === file.encoding
      );
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : uiText("操作失败");
}

function playCallFailureMessage(
  chain: V1PlayCallChainView | null,
): string | null {
  if (
    chain?.status !== "interrupted" ||
    chain.events.at(-1)?.kind === "cancellation"
  )
    return null;
  const event = chain.events.findLast(
    (
      candidate,
    ): candidate is Extract<V1PlayCallChainEvent, { kind: "failure" }> =>
      candidate.kind === "failure",
  );
  const detail = chain.lastFailure ?? event?.message ?? null;
  const guidance = chain.canRetry
    ? uiText("模型请求中断；清空输入后点击追加上下文即可原样发送上次请求。")
    : uiText("调用链处理失败；旧请求不能重发，请使用全新上下文。");
  return detail === null || detail.includes(guidance)
    ? (detail ?? guidance)
    : `${detail} ${guidance}`;
}

function requestRuntime<T>(
  client: WorldPageClient,
  request: V1Request,
): Promise<T> {
  return client.request(request) as Promise<T>;
}

function applyPlayTimelineFrame(
  frame: V1PlayCallChainStreamFrame,
  setTimeline: Dispatch<SetStateAction<V1PlayTimelinePage | null>>,
): void {
  if (frame.kind === "snapshot") {
    setTimeline((current) => {
      if (current === null) return current;
      const chain = frame.value;
      const previousActiveChainId = current.activeChainId;
      const items = current.items.map((item) => {
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
        activeCanRetry: chain.canRetry,
        activeLastFailure: chain.lastFailure,
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
    return {
      ...summary,
      hasReasoning: reasoning !== undefined && reasoning.length > 0,
      hasToolFragment: toolFragment !== undefined && toolFragment.length > 0,
      hasUsage: event.usage !== undefined,
      detailsAvailable:
        (reasoning !== undefined && reasoning.length > 0) ||
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
    failed: event.failure !== undefined,
    ...(event.usage === undefined
      ? {}
      : { usage: structuredClone(event.usage) }),
    detailsAvailable: true,
  };
}

function legacyTimelinePage(world: WorldReadView): V1PlayTimelinePage {
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
    activeLastFailure: chain.lastFailure,
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
        })),
      ]),
    ],
    nextCursor: null,
  };
}

async function requestPlayDecorations(
  client: WorldPageClient,
  worldId: string,
): Promise<WorldPlayDecorationsView | null> {
  try {
    const result = await client.request({
      type: "world.play-decorations.read",
      worldId,
    });
    return result as WorldPlayDecorationsView;
  } catch {
    return null;
  }
}
