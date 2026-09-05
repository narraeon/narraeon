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
import type { CorrectionPreviewView } from "./FileNativeCorrectionPanel.tsx";
import { worldDocumentPresentation } from "./worldDocumentPresentation.ts";
import {
  AiReadingRail,
  ReadingPreferencesPopover,
  WorldDocumentRail,
  WorldManagementDialog,
  WorldRevisionDialog,
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
  activePlayExchangeId,
  createPlayRunProgress,
  progressAfterFrame,
  progressFromCallChain,
  type PlayRunProgressValue,
} from "./PlayRunProgressState.ts";

type RightRailTab = "documents" | "ai-reading";
type WorldDialog = "revision" | "manage" | null;
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
  | "correction-preview"
  | "correction-apply"
  | "correction-cancel"
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
  request(request: V1Request): Promise<unknown>;
  streamPlayCallChain?: (
    request: Extract<
      V1Request,
      { type: "play.chain.start" | "play.chain.append" }
    >,
    onFrame: (frame: V1PlayCallChainStreamFrame) => void,
  ) => Promise<V1PlayCallChainView>;
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
  const [revisionTab, setRevisionTab] = useState<"manual" | "ai-reading">(
    "manual",
  );
  const [readingPreferences, setReadingPreferences] = useState(
    initialReadingPreferences,
  );
  const [readingPreferencesSaving, setReadingPreferencesSaving] =
    useState(false);
  const [playerText, setPlayerText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
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
  const [correction, setCorrection] = useState<{
    candidateId: string;
    version: number;
  } | null>(null);
  const [correctionPreview, setCorrectionPreview] =
    useState<CorrectionPreviewView | null>(null);
  const [correctionBaseFiles, setCorrectionBaseFiles] = useState<
    ContentTreeFile[]
  >([]);
  const [correctionFiles, setCorrectionFiles] = useState<ContentTreeFile[]>([]);
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
  const correctionDirty = !sameTextFiles(correctionBaseFiles, correctionFiles);

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
    const chainPending = pending === "play-fresh" || pending === "play-append";
    if (chainPending && client.streamPlayCallChain !== undefined) return;
    if (
      !chainPending &&
      (playCallChain?.status ?? playTimeline?.activeStatus) !== "running"
    )
      return;
    let active = true;
    const poll = async (): Promise<void> => {
      try {
        const next = await requestRuntime<V1PlayCallChainView | null>(client, {
          type: "play.chain.inspect",
          worldId,
        });
        if (!active || next === null) return;
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
          cancelledExchangeRef.current = null;
          setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
        }
      } catch {
        // Inspection is observational. The initiating request remains the
        // source of truth and the last visible call-chain snapshot stays put.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    client,
    pending,
    playCallChain?.status,
    playTimeline?.activeStatus,
    worldId,
  ]);

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
        if (!correctionDirty) {
          setCorrectionBaseFiles(cloneTextFiles(state));
          setCorrectionFiles(cloneTextFiles(state));
        }
        if (!controlDirty) setControlFiles(JSON.stringify(control, null, 2));
      } catch (reason: unknown) {
        if (active) setFeedback({ kind: "error", text: errorMessage(reason) });
      }
    };
    void loadSurfaces();
    return () => {
      active = false;
    };
  }, [
    client,
    controlDirty,
    correctionDirty,
    dialog,
    rightRailOpen,
    world,
    worldId,
  ]);

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
  const activeChainStale =
    forceFreshContext ||
    (world !== null &&
      playCallChain !== null &&
      playCallChain.parentHead !== world.head);
  const playProgressActive = playProgress !== null;
  const hasPlayerText = playerText.trim().length > 0;
  const playIdle = pending === null && activeStatus !== "running";
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
      const next = await requestPlayCallChain(client, request, (frame) => {
        applyPlayCallChainFrame(frame, setPlayCallChain);
        applyPlayTimelineFrame(frame, setPlayTimeline);
        setPlayProgress((current) =>
          progressAfterFrame(current, frame, chainId, exchangeId),
        );
      });
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

  async function previewCorrection(): Promise<void> {
    const changed = changedTextFiles(correctionBaseFiles, correctionFiles);
    if (changed.length === 0 || activeStatus === "running") return;
    setPending("correction-preview");
    let activeCandidate: { candidateId: string; version: number } | null = null;
    try {
      if (correction !== null)
        await client.request({
          type: "correction.cancel",
          candidateId: correction.candidateId,
          expectedVersion: correction.version,
        });
      const started = await requestRuntime<{
        candidateId: string;
        version: number;
        parentHead: string;
      }>(client, {
        type: "correction.begin",
        worldId,
        operationId: createClientId("correction"),
      });
      activeCandidate = {
        candidateId: started.candidateId,
        version: started.version,
      };
      setCorrection(activeCandidate);
      for (const nextFile of changed) {
        const baseFile = correctionBaseFiles.find(
          ({ path }) => path === nextFile.path,
        );
        if (baseFile === undefined)
          throw new Error("World correction cannot create a new document.");
        const handle = `@${worldDocumentPresentation(baseFile).ref}`;
        const read = await requestRuntime<{
          hash: string;
          contents: string;
        }>(client, {
          type: "correction.read",
          candidateId: activeCandidate.candidateId,
          document: handle,
        });
        if (read.contents !== baseFile.contents)
          throw new Error(
            "The current world changed after this editor opened. Reopen the revision workbench before applying edits.",
          );
        const replaced: { version: number } = await requestRuntime<{
          version: number;
        }>(client, {
          type: "correction.replace",
          candidateId: activeCandidate.candidateId,
          expectedVersion: activeCandidate.version,
          target: handle,
          expectedHash: read.hash,
          contents: nextFile.contents,
        });
        activeCandidate = {
          candidateId: activeCandidate.candidateId,
          version: replaced.version,
        };
        setCorrection(activeCandidate);
      }
      const preview = await requestRuntime<CorrectionPreviewView>(client, {
        type: "correction.preview",
        candidateId: activeCandidate.candidateId,
        expectedVersion: activeCandidate.version,
      });
      setCorrectionPreview(preview);
      setFeedback({
        kind: "status",
        text: uiText("修订草稿已预览；应用前当前世界没有变化。"),
      });
    } catch (reason: unknown) {
      if (activeCandidate !== null)
        await client
          .request({
            type: "correction.cancel",
            candidateId: activeCandidate.candidateId,
            expectedVersion: activeCandidate.version,
          })
          .catch(() => undefined);
      setCorrection(null);
      setCorrectionPreview(null);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function applyCorrection(): Promise<void> {
    if (correction === null || correctionPreview === null) return;
    setPending("correction-apply");
    try {
      await client.request({
        type: "correction.apply",
        candidateId: correction.candidateId,
        expectedVersion: correction.version,
      });
      setCorrection(null);
      setCorrectionPreview(null);
      setCorrectionBaseFiles([]);
      setCorrectionFiles([]);
      setDialog(null);
      setRightRailTab("documents");
      setRightRailOpen(true);
      setForceFreshContext(true);
      const refreshed = await refreshWorld();
      if (refreshed.state.length > 0) {
        setCorrectionBaseFiles(cloneTextFiles(refreshed.state));
        setCorrectionFiles(cloneTextFiles(refreshed.state));
      }
      setFeedback({
        kind: "status",
        text: uiText(
          "世界修订已提交。现有追加上下文已过期，下一次行动会自动使用全新上下文。",
        ),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function cancelCorrection(): Promise<void> {
    if (correction === null) {
      setCorrectionPreview(null);
      setCorrectionFiles(cloneTextFiles(correctionBaseFiles));
      setDialog(null);
      return;
    }
    setPending("correction-cancel");
    try {
      await client.request({
        type: "correction.cancel",
        candidateId: correction.candidateId,
        expectedVersion: correction.version,
      });
      setCorrection(null);
      setCorrectionPreview(null);
      setCorrectionFiles(cloneTextFiles(correctionBaseFiles));
      setDialog(null);
      setFeedback({
        kind: "status",
        text: uiText("修订草稿已放弃，世界端点没有推进。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function returnToCorrectionEditor(): Promise<void> {
    if (correction === null) {
      setCorrectionPreview(null);
      return;
    }
    setPending("correction-cancel");
    try {
      await client.request({
        type: "correction.cancel",
        candidateId: correction.candidateId,
        expectedVersion: correction.version,
      });
      setCorrection(null);
      setCorrectionPreview(null);
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
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
      const continued = await requestPlayCallChain(
        client,
        {
          type: "play.chain.append",
          worldId: world.worldId,
          chainId: revised.playCallChain.chainId,
          exchangeId: createClientId("play-exchange"),
          playerText: "",
        },
        (frame) => {
          applyPlayCallChainFrame(frame, setPlayCallChain);
          applyPlayTimelineFrame(frame, setPlayTimeline);
        },
      );
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

  function submitCurrentMode(): void {
    void submitPlayChain(activeChainStale ? "fresh" : "append");
  }

  function openRevision(tab: "manual" | "ai-reading", path?: string): void {
    if (path !== undefined) setSelectedDocument(path);
    if (
      tab === "manual" &&
      correction === null &&
      !correctionDirty &&
      documents.length > 0
    ) {
      setCorrectionBaseFiles(cloneTextFiles(documents));
      setCorrectionFiles(cloneTextFiles(documents));
    }
    setRevisionTab(tab);
    setDialog("revision");
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
        interactionDisabled={pending !== null}
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
                  restartDisabled={pending !== null}
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
                  restartDisabled={pending !== null}
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
            {!modelConfigured ? (
              <div className="model-required-callout">
                <p>{uiText("需要先配置模型连接才能游玩。")}</p>
                <button type="button" onClick={onConfigureModel}>
                  {uiText("配置模型")}
                </button>
              </div>
            ) : null}
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
                    activeStatus === "running"
                  }
                  onChange={(event) => setPlayerText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      submitCurrentMode();
                    }
                  }}
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
                onClick={submitCurrentMode}
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
                  onRevise={(path) => openRevision("manual", path)}
                />
              ) : (
                <AiReadingRail
                  reading={aiReading}
                  loading={aiReadingLoading}
                  documents={documents}
                  onOpenFull={() => openRevision("ai-reading")}
                />
              )}
            </div>
            <footer>
              <button type="button" onClick={() => openRevision("manual")}>
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

          {dialog === "revision" ? (
            <WorldRevisionDialog
              files={revisionTab === "ai-reading" ? documents : correctionFiles}
              selectedPath={selectedDocument}
              dirty={correctionDirty}
              preview={correctionPreview}
              reading={aiReading}
              tab={revisionTab}
              pending={pending !== null}
              onFilesChange={setCorrectionFiles}
              onSelectedPathChange={setSelectedDocument}
              onTab={setRevisionTab}
              onPreview={() => void previewCorrection()}
              onApply={() => void applyCorrection()}
              onBack={() => void returnToCorrectionEditor()}
              onDiscard={() => void cancelCorrection()}
              onClose={() => {
                if (correction !== null)
                  void returnToCorrectionEditor().then(() => setDialog(null));
                else setDialog(null);
              }}
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

function changedTextFiles(
  before: readonly ContentTreeFile[],
  after: readonly ContentTreeFile[],
): ContentTreeFile[] {
  return after.filter((file) => {
    const previous = before.find(({ path }) => path === file.path);
    return previous?.contents !== file.contents;
  });
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

function requestPlayCallChain(
  client: WorldPageClient,
  request: Extract<
    V1Request,
    { type: "play.chain.start" | "play.chain.append" }
  >,
  onFrame: (frame: V1PlayCallChainStreamFrame) => void,
): Promise<V1PlayCallChainView> {
  return client.streamPlayCallChain === undefined
    ? requestRuntime<V1PlayCallChainView>(client, request)
    : client.streamPlayCallChain(request, onFrame);
}

function applyPlayCallChainFrame(
  frame: V1PlayCallChainStreamFrame,
  setChain: Dispatch<SetStateAction<V1PlayCallChainView | null>>,
): void {
  if (frame.kind === "snapshot") {
    setChain(frame.value);
    return;
  }
  if (frame.kind !== "assistant_delta") return;
  setChain((current) => {
    if (current === null) return current;
    return {
      ...current,
      updatedAt: frame.updatedAt,
      events: current.events.map((event) => {
        if (event.kind !== "assistant" || event.id !== frame.eventId)
          return event;
        if (frame.deltaKind === "text")
          return { ...event, text: event.text + frame.text };
        if (frame.deltaKind === "reasoning")
          return {
            ...event,
            reasoning: `${event.reasoning ?? ""}${frame.text}`,
          };
        return {
          ...event,
          toolFragment: `${event.toolFragment ?? ""}${frame.text}`,
        };
      }),
    };
  });
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
      for (const event of chain.events) {
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
        else items[index] = next;
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
