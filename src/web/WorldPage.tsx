import styles from "./PlayTimeline.module.css";
import {
  applyPlayTimelineFrame,
  assistantResponseKind,
  legacyTimelinePage,
  projectPlayContextUsage,
  requestRuntime,
  useWorldPlayStore,
  useWorldSurfaceRead,
  type PlayerRevisionContinuation,
  type WorldMessage,
  type WorldPageClient,
  type WorldReadView,
} from "./WorldPlayStore.ts";
import { PlayTimeline, Transcript } from "./PlayTimeline.tsx";
import { PlayComposer } from "./PlayComposer.tsx";
import {
  WorldHeaderChrome,
  type WorldReadingRail,
} from "./WorldHeaderChrome.tsx";
import {
  idleWorkspaceNavigation,
  type WorkspaceNavigationProtection,
} from "./WorkspaceLocation.ts";
import {
  RuntimeRequestError,
  isResponseRecord,
  unreadableResponse,
} from "./RuntimeResponse.ts";
import { readAfterCommit } from "./RequestOutcome.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import {
  recordedPlaySubmission,
  submitPlay,
  type PlayCommand,
} from "./PlaySubmission.ts";
import { playFailureDescription } from "./PlayFailureText.ts";
import { ModelRecoveryActions } from "./ModelRecoveryActions.tsx";
import {
  PlayFailureNotice,
  type PlayFailureRecovery,
} from "./PlayFailureNotice.tsx";
import { WorldBackupExportButton } from "./WorldArchiveControls.tsx";
import { WorldExtensionMenu } from "./WorldExtensionMenu.tsx";
import type { WorldExtensionsView } from "../protocol/worldExtensions.ts";
import { PackageScriptPermissionControl } from "./PackageScriptPermissionControl.tsx";
import { Entry } from "./PlayerViewValue.tsx";
import { FoldToggle } from "./PlayerViewFold.tsx";
import {
  PlayerViewFoldProvider,
  useFold,
  usePlayerViewFoldController,
} from "./PlayerViewFoldState.ts";
import { useConversationComposer } from "./useConversationComposer.ts";
import { useAutosizeTextarea } from "./useAutosizeTextarea.ts";
import {
  authoringConversationActions,
  useAuthoringWorkspace,
} from "./useAuthoringWorkspace.ts";
import { saveFile, useAndroidBack } from "./androidBridge.ts";
import { uiText } from "./i18n.ts";
import {
  hasHandledCheckpoint,
  rememberHandledCheckpoint,
} from "./CheckpointContextPreferences.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import type {
  ContentTreeFile,
  V1PlayCallChainView,
  V1PlayContextReadingView,
  V1PlayTimelinePage,
  V1Request,
  V1StoryExport,
  V1StoryExportFormat,
  V1WorldRevisionEpochView,
} from "../protocol/v1.ts";
import {
  defaultAppReadingPreferences,
  type AppPreferences,
  type AppReadingPreferences,
} from "../protocol/appPreferences.ts";
import type { ModelProviderKind } from "../protocol/modelConnections.ts";
import type { RenderedPlayerView } from "../protocol/playerViews.ts";
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
} from "./ArtifactExtensionHost.tsx";
import { ArtifactDebugger } from "./ArtifactDebugger.tsx";
import { projectUncoveredPlayerViews } from "./PlayerViewFallback.ts";
import { PlayContextUsage } from "./PlayContextUsage.tsx";
import { ProtagonistConfirmationCard } from "./ProtagonistConfirmationCard.tsx";
import {
  readProtagonistCustomization,
  saveProtagonistCustomization,
  type ProtagonistCustomization,
} from "./ProtagonistCustomization.ts";
import { PlayRunProgress } from "./PlayRunProgress.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import type { PromptRoleOrderTarget } from "../protocol/promptRoleOrder.ts";
import type { OrchestrationSurface } from "../protocol/orchestrationSession.ts";
import {
  modelSendRecovery,
  promptRoleOrderRule,
  type ModelSendRecovery,
} from "./ModelSendRecovery.ts";
import {
  createPlayRunProgress,
  progressFromCallChain,
} from "./PlayRunProgressState.ts";

type WorldDialog = "revision" | "reading" | "manage" | null;
type PendingAction =
  | "play-fresh"
  | "play-append"
  | "control-preview"
  | "control-apply"
  | "rename"
  | "story-export"
  | "revise"
  | "derive"
  | "archive-export";

function captureTimelineAnchor(
  reader: HTMLElement,
): { id: string; top: number } | null {
  const headerInset =
    parseFloat(getComputedStyle(reader).scrollPaddingTop) || 0;
  const visibleTop = reader.getBoundingClientRect().top + headerInset;
  let anchor: { id: string; top: number } | null = null;
  for (const item of reader.querySelectorAll<HTMLElement>(
    "[data-timeline-item]",
  )) {
    const bounds = item.getBoundingClientRect();
    if (bounds.height === 0) continue;
    anchor = { id: item.dataset.timelineItem!, top: bounds.top };
    if (bounds.bottom > visibleTop) break;
  }
  return anchor;
}

interface Feedback {
  kind: "status" | "error";
  text: string;
  technical?: boolean;
  submission?: string;
}

export interface WorldComposerDraft {
  worldId: string;
  playerText: string;
  turnNote: string;
  turnNoteOpen: boolean;
}

interface ControlPreviewAttempt {
  files: ContentTreeFile[];
  fingerprint?: string;
}

export function WorldPage({
  client,
  worldId,
  worldTitle,
  modelConfigured,
  activeModelProtocol,
  onBack,
  showWorkspaceBack = true,
  onConfigureModel,
  onViewPromptOrder,
  initialComposerDraft,
  onComposerDraftChange,
  onRenameWorld,
  onOpenWorld,
  onRecoverWorkspace,
  onNavigationProtectionChange,
  onReadingPreferencesChange,
  initialReadingPreferences = defaultAppReadingPreferences,
  initialProtagonistCustomization,
  onProtagonistCustomizationFinished,
}: {
  client: WorldPageClient;
  worldId: string;
  worldTitle: string;
  modelConfigured: boolean;
  activeModelProtocol?: ModelProviderKind | undefined;
  onBack: () => void;
  showWorkspaceBack?: boolean;
  onConfigureModel: () => void;
  onViewPromptOrder?:
    | ((surface: OrchestrationSurface, target?: PromptRoleOrderTarget) => void)
    | undefined;
  initialComposerDraft?: WorldComposerDraft | null;
  onComposerDraftChange?: (draft: WorldComposerDraft) => void;
  onRenameWorld: (name: string) => Promise<void>;
  onOpenWorld: (worldId: string) => Promise<void>;
  onRecoverWorkspace?: () => Promise<unknown>;
  onNavigationProtectionChange?: (
    protection: WorkspaceNavigationProtection,
  ) => void;
  onReadingPreferencesChange?: (value: AppReadingPreferences) => void;
  initialReadingPreferences?: AppReadingPreferences;
  initialProtagonistCustomization?: ProtagonistCustomization;
  onProtagonistCustomizationFinished?: () => void;
}): React.JSX.Element {
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [leftRailWidth, setLeftRailWidth] = useState(320);
  const playerViewFold = usePlayerViewFoldController();
  const leftRailDrag = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  function resizeLeftRail(width: number): void {
    setLeftRailWidth(
      Math.max(240, Math.min(720, window.innerWidth - 24, width)),
    );
  }
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [rightRailTab, setRightRailTab] =
    useState<WorldReadingRail>("documents");
  const [readingOpen, setReadingOpen] = useState(false);
  useAndroidBack(leftRailOpen || rightRailOpen, () => {
    setLeftRailOpen(false);
    setRightRailOpen(false);
  });
  const [dialog, setDialog] = useState<WorldDialog>(null);
  const [protagonistCustomization, setProtagonistCustomization] = useState(
    () =>
      readProtagonistCustomization(worldId) ??
      initialProtagonistCustomization ??
      null,
  );
  const [protagonistBusy, setProtagonistBusy] = useState(false);
  const [readingPreferences, setReadingPreferences] = useState(
    initialReadingPreferences,
  );
  const [readingPreferencesSaving, setReadingPreferencesSaving] =
    useState(false);
  const [playerText, setPlayerText] = useState(
    initialComposerDraft?.playerText ?? "",
  );
  // One-turn request: cleared once a dispatch settles ready, kept on interrupt or cancel.
  const [turnNote, setTurnNote] = useState(
    initialComposerDraft?.turnNote ?? "",
  );
  const [pendingAction, setPending] = useState<PendingAction | null>(null);
  const [earlierTimelineLoading, setEarlierTimelineLoading] = useState(false);
  const pending =
    pendingAction ?? (earlierTimelineLoading ? "timeline-page" : null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [playRequestRecovery, setPlayRequestRecovery] =
    useState<ModelSendRecovery | null>(null);
  const [supersededFailure, setSupersededFailure] = useState<{
    worldId: string;
    chainId: string;
    eventId: number;
  } | null>(null);
  const [retryRejection, setRetryRejection] = useState<string | null>(null);
  const [regenerationFallback, setRegenerationFallback] = useState<{
    worldId: string;
    chainId: string;
    eventId: number;
    originalText: string;
  } | null>(null);
  const cancelledExchangeRef = useRef<string | null>(null);
  const playSubmissionInFlight = useRef(false);
  const unconfirmedSubmission = useRef<PlayCommand | null>(null);
  const [worldNameDraft, setWorldNameDraft] = useState(worldTitle);
  const [lastWorldTitle, setLastWorldTitle] = useState(worldTitle);
  if (lastWorldTitle !== worldTitle) {
    setLastWorldTitle(worldTitle);
    setWorldNameDraft((current) =>
      current === lastWorldTitle ? worldTitle : current,
    );
  }
  const [forceFreshContext, setForceFreshContext] = useState(false);
  const [checkpointPreference, setCheckpointPreference] = useState<{
    worldId: string;
    head: string;
    fresh: boolean;
  } | null>(null);
  const [manualFreshContext, setManualFreshContext] = useState(false);
  const preferFreshContext =
    manualFreshContext ||
    (checkpointPreference?.worldId === worldId && checkpointPreference.fresh);
  const [observedCheckpoints, setObservedCheckpoints] = useState<string[]>([]);
  const [selectedDocument, setSelectedDocument] = useState("");
  const [controlEditorOpen, setControlEditorOpen] = useState(false);
  const [controlFiles, setControlFiles] = useState<ContentTreeFile[]>([]);
  const [authoringNavigation, setAuthoringNavigation] = useState(
    idleWorkspaceNavigation,
  );
  const [controlDirty, setControlDirty] = useState(false);
  const controlDirtyRef = useRef(false);
  useLayoutEffect(() => {
    controlDirtyRef.current = controlDirty;
  }, [controlDirty]);
  const controlPreviewAttempt = useRef<ControlPreviewAttempt | null>(null);
  const [previewedControl, setPreviewedControl] = useState<{
    attempt: ControlPreviewAttempt;
    payload: Record<string, unknown>;
  } | null>(null);
  const controlPreview =
    previewedControl?.attempt.files === controlFiles ? previewedControl : null;
  const {
    workspace: revisionWorkspace,
    state: authoring,
    conversation,
  } = useAuthoringWorkspace(
    client,
    "revision",
    worldId,
    dialog === "revision" || protagonistCustomization !== null,
  );
  const revisionOverview =
    dialog === "revision" || protagonistCustomization !== null
      ? (authoring.target?.revision ?? null)
      : null;
  const changeProtagonistCustomization = useCallback(
    (next: ProtagonistCustomization | null) => {
      saveProtagonistCustomization(worldId, next);
      setProtagonistCustomization(next);
      if (next === null) onProtagonistCustomizationFinished?.();
    },
    [worldId, onProtagonistCustomizationFinished],
  );
  const finishingProtagonistEpoch = protagonistCustomization?.epochId;
  useEffect(() => {
    if (finishingProtagonistEpoch === undefined) return;
    return revisionWorkspace.subscribe(() => {
      const overview = revisionWorkspace.getSnapshot().target?.revision;
      if (
        overview?.sealedEpochs.some(
          ({ epochId }) => epochId === finishingProtagonistEpoch,
        )
      )
        changeProtagonistCustomization(null);
    });
  }, [
    revisionWorkspace,
    finishingProtagonistEpoch,
    changeProtagonistCustomization,
  ]);
  const revisionFiles = authoring.files;
  const revisionDirty = dialog === "revision" && authoring.dirty;
  const [aiReading, setAiReading] = useState<V1PlayContextReadingView | null>(
    null,
  );
  const [aiReadingLoading, setAiReadingLoading] = useState(false);
  const [bridgeEvents, setBridgeEvents] = useState<Record<string, string[]>>(
    {},
  );
  const readerRef = useRef<HTMLElement>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const { ref: composerTextareaAttach, textareaRef: composerTextareaRef } =
    useAutosizeTextarea(playerText);
  const turnNoteInputRef = useRef<HTMLInputElement>(null);
  const [turnNoteOpen, setTurnNoteOpen] = useState(
    initialComposerDraft?.turnNoteOpen ?? false,
  );
  useLayoutEffect(() => {
    onComposerDraftChange?.({ worldId, playerText, turnNote, turnNoteOpen });
  }, [onComposerDraftChange, worldId, playerText, turnNote, turnNoteOpen]);
  const [composerHeight, setComposerHeight] = useState(72);
  useEffect(() => {
    if (turnNoteOpen) turnNoteInputRef.current?.focus();
  }, [turnNoteOpen]);
  const navigationDirty =
    revisionDirty || controlDirty || authoringNavigation.dirty;
  const navigationBusy =
    authoringNavigation.busy ||
    protagonistBusy ||
    (protagonistCustomization !== null &&
      authoring.view?.runStatus === "running") ||
    pending === "control-apply";
  useLayoutEffect(() => {
    onNavigationProtectionChange?.({
      dirty: navigationDirty,
      busy: navigationBusy,
    });
    return () => onNavigationProtectionChange?.(idleWorkspaceNavigation);
  }, [onNavigationProtectionChange, navigationDirty, navigationBusy]);

  const onWorldRead = useCallback(
    (next: WorldReadView, preserveControlDraft: boolean) => {
      const submission = unconfirmedSubmission.current;
      if (
        submission?.worldId === next.worldId &&
        recordedPlaySubmission(
          submission,
          next.playCallChain,
          next.playTimeline,
        )
      ) {
        unconfirmedSubmission.current = null;
        setPlayerText((current) =>
          current === submission.playerText ? "" : current,
        );
        setFeedback((current) =>
          current?.submission === submission.exchangeId ? null : current,
        );
      }
      if (!preserveControlDraft && next.control.length > 0) {
        setControlFiles(next.control);
        setControlDirty(false);
        controlPreviewAttempt.current = null;
        setPreviewedControl(null);
      }
      if (next.state.length > 0)
        setSelectedDocument((current) =>
          selectedStateDocument(next.state, current),
        );
    },
    [],
  );
  const onCancellationObserved = useCallback(() => {
    if (cancelledExchangeRef.current !== null)
      setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
  }, []);
  const {
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
    invalidateDecorations,
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
  } = useWorldPlayStore({
    client,
    worldId,
    onWorldRead,
    onCancellationObserved,
  });

  const readingChange = useRef(onReadingPreferencesChange);
  useEffect(() => {
    readingChange.current = onReadingPreferencesChange;
  }, [onReadingPreferencesChange]);
  const applyReadingPreferences = useCallback(
    (reading: AppReadingPreferences) => {
      setReadingPreferences(reading);
    },
    [],
  );
  const { target: readingTarget, syncFailed: readingSyncFailed } =
    useReadTarget(
      useCallback(
        () =>
          requestRuntime<AppPreferences>(client, { type: "preferences.read" }),
        [client],
      ),
      useCallback(
        (preferences: AppPreferences) => {
          applyReadingPreferences(preferences.reading);
          readingChange.current?.(preferences.reading);
        },
        [applyReadingPreferences],
      ),
    );
  const observedReading = useRef(initialReadingPreferences);
  useEffect(() => {
    if (initialReadingPreferences === observedReading.current) return;
    observedReading.current = initialReadingPreferences;
    readingTarget.accept();
    applyReadingPreferences(initialReadingPreferences);
  }, [initialReadingPreferences, readingTarget, applyReadingPreferences]);
  useEffect(() => {
    if (openedWorldId === undefined) return;
    historyEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openedWorldId]);

  const managementVisible = dialog === "manage";
  const controlEditorVisible = managementVisible && controlEditorOpen;
  const stateVisible =
    world !== null &&
    (rightRailOpen || dialog === "reading" || controlEditorVisible);
  const {
    target: stateTarget,
    syncFailed: stateFailed,
    syncError: stateError,
  } = useWorldSurfaceRead<ContentTreeFile[]>(
    client,
    worldId,
    "state",
    worldHead,
    stateVisible,
    useCallback(
      (state: ContentTreeFile[] | null) => {
        if (state === null) return;
        setWorld((current) =>
          current !== null && current.head === worldHead
            ? { ...current, state }
            : current,
        );
        setStateHead(worldHead ?? null);
        setSelectedDocument((current) => selectedStateDocument(state, current));
      },
      [worldHead, setStateHead, setWorld],
    ),
  );
  const {
    target: controlTarget,
    syncFailed: controlFailed,
    syncError: controlError,
  } = useWorldSurfaceRead<ContentTreeFile[]>(
    client,
    worldId,
    "control",
    worldHead,
    controlEditorVisible,
    useCallback(
      (control: ContentTreeFile[] | null) => {
        if (control === null) return;
        setWorld((current) =>
          current !== null && current.head === worldHead
            ? { ...current, control }
            : current,
        );
        setControlHead(worldHead ?? null);
        if (!controlDirtyRef.current)
          setControlFiles((previous) =>
            sameControlFiles(previous, control) ? previous : control,
          );
      },
      [worldHead, setControlHead, setWorld],
    ),
  );
  const {
    target: runtimeTarget,
    syncFailed: runtimeFailed,
    syncError: runtimeError,
  } = useWorldSurfaceRead<unknown>(
    client,
    worldId,
    "runtime",
    worldHead,
    managementVisible,
    useCallback(
      (runtime: unknown) => {
        if (runtime === null) return;
        setWorld((current) =>
          current !== null && current.head === worldHead
            ? { ...current, runtime }
            : current,
        );
        setRuntimeHead(worldHead ?? null);
      },
      [worldHead, setRuntimeHead, setWorld],
    ),
  );
  useEffect(() => {
    if (stateVisible && stateHead !== worldHead) void stateTarget.read();
  }, [stateTarget, stateVisible, stateHead, worldHead]);
  useEffect(() => {
    if (controlEditorVisible && controlHead !== worldHead)
      void controlTarget.read();
  }, [controlTarget, controlEditorVisible, controlHead, worldHead]);
  useEffect(() => {
    if (managementVisible && runtimeHead !== worldHead)
      void runtimeTarget.read();
  }, [runtimeTarget, managementVisible, runtimeHead, worldHead]);

  const aiReadingVisible =
    (rightRailOpen && rightRailTab === "ai-reading") || dialog === "reading";
  const {
    target: aiReadingTarget,
    syncFailed: aiReadingFailed,
    syncError: aiReadingError,
  } = useReadTarget(
    useCallback(
      () =>
        aiReadingVisible && worldHead !== undefined
          ? requestRuntime<V1PlayContextReadingView>(client, {
              type: "world.play-context.read",
              worldId,
            })
          : Promise.resolve(null),
      [client, worldId, worldHead, aiReadingVisible],
    ),
    useCallback((reading: V1PlayContextReadingView | null) => {
      if (reading !== null) setAiReading(reading);
    }, []),
  );
  useEffect(() => {
    if (!aiReadingVisible || worldHead === undefined) return;
    const timer = window.setTimeout(() => setAiReadingLoading(true), 0);
    void aiReadingTarget.read().finally(() => {
      window.clearTimeout(timer);
      setAiReadingLoading(false);
    });
    return () => window.clearTimeout(timer);
  }, [aiReadingTarget, aiReadingVisible, worldHead, playCallChain?.updatedAt]);

  useEffect(() => {
    let previous = revisionWorkspace.getSnapshot().target?.revision;
    return revisionWorkspace.subscribe(() => {
      const overview = revisionWorkspace.getSnapshot().target?.revision;
      if (overview === undefined || overview === previous) return;
      previous = overview;
      setWorld((current) =>
        current === null
          ? null
          : {
              ...current,
              worldRevision:
                overview.epoch?.locked === true ? overview.epoch : null,
            },
      );
    });
  }, [revisionWorkspace, setWorld]);

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
  }, [openedWorldId, dialog]);

  useEffect(() => {
    if (feedback?.kind !== "status") return;
    const timer = window.setTimeout(() => setFeedback(null), 3200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const documents = world?.state ?? [];
  const playerViewFallback = projectUncoveredPlayerViews(
    displayedDecorations?.playerViews ??
      world?.playerViews ?? { views: [], diagnostics: [] },
    displayedDecorations?.playerViewPanels ?? world?.playerViewPanels ?? [],
    displayedDecorations?.suppressedPlayerViewIds ??
      world?.suppressedPlayerViewIds ??
      [],
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
  const latestNarrative = playTimeline?.items.findLast(
    (item) =>
      item.kind === "event" &&
      item.event.kind === "assistant" &&
      item.event.status === "completed" &&
      item.event.committedHead !== undefined &&
      assistantResponseKind(item.event) === "narrative",
  );
  if (
    world?.worldId === worldId &&
    latestNarrative?.kind === "event" &&
    latestNarrative.event.kind === "assistant" &&
    latestNarrative.event.checkpoint === true &&
    latestNarrative.event.committedHead !== undefined
  ) {
    const checkpointKey = `${worldId}:${latestNarrative.event.committedHead}`;
    if (!observedCheckpoints.includes(checkpointKey)) {
      // Remember the identity, rather than the tail page, so paging, mode
      // changes and cancellation cannot reselect an already handled checkpoint.
      setObservedCheckpoints([...observedCheckpoints, checkpointKey]);
      setCheckpointPreference({
        worldId,
        head: latestNarrative.event.committedHead,
        fresh: !hasHandledCheckpoint(
          worldId,
          latestNarrative.event.committedHead,
        ),
      });
    }
  }
  const reportedCanRetry =
    playCallChain?.canRetry ?? playTimeline?.activeCanRetry ?? false;
  const lastActiveEvent = playTimeline?.items.findLast(
    (item) => item.kind === "event" && item.chainId === activeChainId,
  );
  const activeFailureKind =
    playCallChain?.lastFailureKind ??
    playTimeline?.activeLastFailureKind ??
    (lastActiveEvent?.kind === "event" &&
    lastActiveEvent.event.kind === "failure"
      ? lastActiveEvent.event.failureKind
      : undefined);
  const failureWasSuperseded =
    supersededFailure?.worldId === worldId &&
    supersededFailure.chainId === activeChainId &&
    lastActiveEvent?.kind === "event" &&
    lastActiveEvent.event.id <= supersededFailure.eventId;
  const currentPlayFailure =
    activeStatus === "interrupted" &&
    !playCallChain?.lastCancelled &&
    !(
      lastActiveEvent?.kind === "event" &&
      lastActiveEvent.event.kind === "cancellation"
    )
      ? (playCallChain?.lastFailure ?? playTimeline?.activeLastFailure ?? null)
      : null;
  const visiblePlayFailure =
    activeStatus === "interrupted" && failureWasSuperseded
      ? retryRejection
      : currentPlayFailure;
  const liveRetryCall = playCallChain?.events.findLast(
    (event) =>
      (event.kind === "assistant" || event.kind === "followup") &&
      event.status === "streaming",
  );
  const liveRetryItem = playTimeline?.items.findLast(
    (item) =>
      item.kind === "event" &&
      item.chainId === activeChainId &&
      (item.event.kind === "assistant" || item.event.kind === "followup") &&
      item.event.status === "streaming",
  );
  const activeModelRetries =
    liveRetryCall?.kind === "assistant" || liveRetryCall?.kind === "followup"
      ? liveRetryCall.retries
      : liveRetryItem?.kind === "event" &&
          (liveRetryItem.event.kind === "assistant" ||
            liveRetryItem.event.kind === "followup")
        ? liveRetryItem.event.retries
        : undefined;
  const activeFailureVisible =
    !failureWasSuperseded &&
    activeStatus === "interrupted" &&
    lastActiveEvent?.kind === "event" &&
    lastActiveEvent.event.kind === "failure";
  const activeRevisionEpoch =
    revisionOverview?.epoch?.locked === true
      ? revisionOverview.epoch
      : (world?.worldRevision ?? null);
  const worldRevisionLocked = activeRevisionEpoch?.locked === true;
  const reportedFreshContextReason =
    playCallChain !== null
      ? playCallChain.freshContextReason
      : playTimeline?.activeFreshContextReason;
  const activeParentHead =
    playCallChain?.parentHead ?? playTimeline?.activeParentHead;
  const activeChainStale =
    reportedFreshContextReason === "world_changed" ||
    forceFreshContext ||
    world?.archiveNeedsFreshContext === true ||
    (world !== null &&
      activeParentHead !== undefined &&
      activeParentHead !== world.head);
  const freshContextReason = activeChainStale
    ? world?.archiveNeedsFreshContext
      ? "imported_world"
      : "world_changed"
    : reportedFreshContextReason;
  const activeCanContinuePartial =
    freshContextReason === undefined &&
    (playCallChain?.canContinuePartial ??
      playTimeline?.activeCanContinuePartial ??
      false);
  const activeCanRetry = freshContextReason === undefined && reportedCanRetry;
  const contextModelProtocol =
    playCallChain === null
      ? playTimeline?.activeModelProtocol
      : playCallChain.modelProtocol;
  const modelProtocolMismatch =
    modelConfigured &&
    freshContextReason === undefined &&
    activeModelProtocol !== undefined &&
    contextModelProtocol !== undefined &&
    activeModelProtocol !== contextModelProtocol &&
    (activeStatus === "ready" || activeCanRetry || activeCanContinuePartial);
  const playProgressActive = playProgress !== null;
  const hasPlayerText = playerText.trim().length > 0;
  const playIdle =
    pending === null && activeStatus !== "running" && !worldRevisionLocked;
  const canStartFresh = hasPlayerText && playIdle;
  const currentRecovery =
    activeStatus === "interrupted" && activeCanRetry
      ? activeFailureKind === "dispatch_budget"
        ? "resume"
        : "retry"
      : null;
  const canAppend =
    playIdle &&
    !modelProtocolMismatch &&
    freshContextReason === undefined &&
    (activeChainId === null
      ? hasPlayerText
      : activeStatus === "ready" || (!hasPlayerText && activeCanRetry));
  const defaultSubmitFresh =
    preferFreshContext || activeChainId === null || activeChainStale;
  const defaultSubmitEnabled = defaultSubmitFresh ? canStartFresh : canAppend;
  const primaryAction = defaultSubmitFresh
    ? "fresh"
    : hasPlayerText
      ? "append"
      : (currentRecovery ?? (activeStatus === "ready" ? "continue" : "append"));

  useEffect(() => {
    if (!playProgressActive) return;
    const timer = setInterval(() => setPlayProgressNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playProgressActive, setPlayProgressNow]);

  function consumeCheckpointPreference(): void {
    setManualFreshContext(false);
    if (checkpointPreference?.worldId !== worldId) return;
    rememberHandledCheckpoint(worldId, checkpointPreference.head);
    setCheckpointPreference({ ...checkpointPreference, fresh: false });
  }

  async function submitPlayChain(
    context: "fresh" | "append",
    submittedText = playerText,
    recovery?: "continue_partial",
  ): Promise<void> {
    if (!modelConfigured || !playIdle || playSubmissionInFlight.current) return;
    const fresh = context === "fresh" || activeChainId === null;
    const hasSubmittedText = submittedText.trim().length > 0;
    if (
      fresh
        ? !hasSubmittedText
        : modelProtocolMismatch ||
          freshContextReason !== undefined ||
          (activeStatus !== "ready" &&
            (hasSubmittedText ||
              !(recovery === "continue_partial"
                ? activeCanContinuePartial
                : activeCanRetry)))
    )
      return;
    setRegenerationFallback(null);
    setPlayRequestRecovery(null);
    playSubmissionInFlight.current = true;
    consumeCheckpointPreference();
    const chainId = fresh ? createClientId("play-chain") : activeChainId;
    const exchangeId = createClientId("play-exchange");
    const startedAt = Date.now();
    cancelledExchangeRef.current = null;
    setRetryRejection(null);
    if (activeChainId !== null && lastActiveEvent?.kind === "event")
      setSupersededFailure({
        worldId,
        chainId: activeChainId,
        eventId: lastActiveEvent.event.id,
      });
    setPlayProgressNow(startedAt);
    setPlayProgress(createPlayRunProgress(chainId, exchangeId, startedAt));
    setPending(context === "fresh" ? "play-fresh" : "play-append");
    setFeedback({
      kind: "status",
      technical: true,
      text: fresh
        ? uiText("正在从当前世界重新拼接上下文…")
        : hasSubmittedText
          ? uiText("正在把玩家输入追加到现有上下文…")
          : activeStatus === "interrupted" &&
              activeFailureKind !== "dispatch_budget"
            ? recovery === "continue_partial"
              ? uiText("正在续写上次未完成的回复…")
              : uiText("正在原样发送上次未完成的模型请求…")
            : uiText("正在沿现有上下文继续生成…"),
    });
    try {
      const request = fresh
        ? ({
            type: "play.chain.start",
            worldId,
            chainId,
            exchangeId,
            playerText: submittedText,
            ...turnNoteField(turnNote),
          } satisfies Extract<V1Request, { type: "play.chain.start" }>)
        : ({
            type: "play.chain.append",
            ...(recovery === undefined ? {} : { recovery }),
            worldId,
            chainId,
            exchangeId,
            playerText: submittedText,
            ...turnNoteField(turnNote),
          } satisfies Extract<V1Request, { type: "play.chain.append" }>);
      unconfirmedSubmission.current = request;
      let submissionVersion = worldProjectionVersion.current;
      const {
        world: projection,
        chain,
        timeline,
        outcome,
        playerAccepted,
      } = await submitPlay(
        client,
        request,
        (recover) => (recover ? worldTarget.recover() : worldTarget.read()),
        (receipt) => {
          worldTarget.accept({ complete: false });
          applyPlayCallChain(receipt);
          submissionVersion = worldProjectionVersion.current;
          applyPlayTimelineFrame(
            {
              kind: "snapshot",
              value: receipt,
              final: receipt.status !== "running",
            },
            setPlayTimeline,
          );
        },
        confirmedObservedChain,
      );
      // The read target already applied valid projections. Fallback evidence must
      // not overwrite a newer observation that arrived while reconciling.
      if (
        projection === null &&
        worldProjectionVersion.current === submissionVersion
      ) {
        if (timeline !== undefined) {
          setPlayTimeline(timeline);
          setPlayCallChain(null);
        } else if (chain !== null) {
          applyPlayCallChain(chain);
          applyPlayTimelineFrame(
            {
              kind: "snapshot",
              value: chain,
              final: chain.status !== "running",
            },
            setPlayTimeline,
          );
        }
      }
      if (outcome.kind === "cancelled") {
        setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
      } else if (outcome.kind === "unconfirmed") {
        const recovery = modelSendRecovery(outcome.error);
        const message = errorMessage(outcome.error);

        if (recovery !== null) {
          setPlayRequestRecovery(recovery);
          setFeedback(null);
        } else if (outcome.retryRejected) {
          setRetryRejection(message);
          setFeedback(null);
        } else {
          setFeedback({
            kind: "error",
            text: message,
            ...(outcome.error instanceof RuntimeRequestError &&
            outcome.error.kind === "runtime"
              ? {}
              : { submission: exchangeId }),
          });
        }
      } else if (outcome.kind === "interrupted") {
        const { lastFailure, lastFailureKind, canRetry } = outcome.failure;
        const description = playFailureDescription(
          lastFailureKind,
          canRetry,
          outcome.failure.canContinuePartial,
        );
        setRetryRejection(lastFailure ?? description);

        setFeedback(null);
      } else if (outcome.kind === "running") {
        setFeedback(null);
      } else {
        setFeedback({
          kind: "status",
          technical: true,
          text:
            !fresh && !hasSubmittedText
              ? uiText("AI 已沿现有上下文继续生成，没有追加玩家指令。")
              : uiText("调用链已返回；模型完成的叙事和世界变化已经分别提交。"),
        });
      }
      if (outcome.kind !== "unconfirmed" && fresh) setForceFreshContext(false);
      if (hasSubmittedText && playerAccepted) {
        unconfirmedSubmission.current = null;
        setPlayerText((current) => (current === submittedText ? "" : current));
      }
      if (outcome.kind === "ready") {
        setTurnNote("");
        setTurnNoteOpen(false);
      }
      if (outcome.kind === "running") {
        setPlayProgress((current) =>
          progressFromCallChain(
            chainId,
            exchangeId,
            chain?.status === "running" ? chain : null,
            current,
          ),
        );
      } else {
        setPlayProgress((current) =>
          current?.exchangeId === exchangeId ? null : current,
        );
      }
    } finally {
      if (cancelledExchangeRef.current === exchangeId)
        cancelledExchangeRef.current = null;
      playSubmissionInFlight.current = false;
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
      const result = await worldTarget.command(() =>
        requestRuntime<{
          outcome: "cancellation_requested" | "not_running";
        }>(client, {
          type: "play.chain.cancel",
          worldId,
          chainId,
          exchangeId,
        }),
      );
      worldTarget.accept({ complete: false });
      if (result.outcome === "not_running") {
        if (cancelledExchangeRef.current === exchangeId)
          cancelledExchangeRef.current = null;
        setFeedback({
          kind: "status",
          text: uiText("模型调用已经结束，正在刷新结果…"),
        });
        setPlayProgress(null);
        await refreshWorld().catch((error: unknown) =>
          setFeedback({ kind: "error", text: errorMessage(error) }),
        );
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

  const timelineCursor = playTimeline?.nextCursor ?? null;
  const displayedTimeline = useRef(playTimeline);
  useLayoutEffect(() => {
    displayedTimeline.current = playTimeline;
  }, [playTimeline]);
  const earlierTimelineDisabled =
    earlierTimelineLoading ||
    (pendingAction !== null &&
      pendingAction !== "play-fresh" &&
      pendingAction !== "play-append");
  const {
    target: earlierTimelineTarget,
    syncFailed: earlierTimelineFailed,
    syncError: earlierTimelineError,
  } = useReadTarget(
    useCallback(
      () =>
        timelineCursor === null
          ? Promise.resolve(null)
          : requestRuntime<V1PlayTimelinePage>(client, {
              type: "play.timeline.page",
              worldId,
              limit: 40,
              cursor: timelineCursor,
            }),
      [client, worldId, timelineCursor],
    ),
    useCallback(
      (earlier: V1PlayTimelinePage | null) => {
        if (earlier?.worldId !== worldId) return;
        const canPrepend = (
          current: V1PlayTimelinePage | null,
        ): current is V1PlayTimelinePage =>
          current?.worldId === worldId &&
          current.generation === earlier.generation &&
          current.nextCursor === timelineCursor;
        if (!canPrepend(displayedTimeline.current)) return;

        // Capture just before inserting the page so scrolling while it loads
        // sets the new reading position.
        const reader = readerRef.current;
        const anchor = reader === null ? null : captureTimelineAnchor(reader);
        flushSync(() =>
          setPlayTimeline((current) =>
            canPrepend(current)
              ? {
                  ...current,
                  items: [...earlier.items, ...current.items],
                  nextCursor: earlier.nextCursor,
                }
              : current,
          ),
        );
        const updated = displayedTimeline.current;
        if (
          reader === null ||
          anchor === null ||
          updated?.generation !== earlier.generation ||
          updated.nextCursor !== earlier.nextCursor
        )
          return;

        const item = reader.querySelector<HTMLElement>(
          `[data-timeline-item="${CSS.escape(anchor.id)}"]`,
        );
        if (item === null) return;
        // Measuring the remaining drift accounts for any browser anchoring.
        const drift = item.getBoundingClientRect().top - anchor.top;
        if (Math.abs(drift) >= 0.5)
          reader.scrollBy({ top: drift, behavior: "instant" });
      },
      [setPlayTimeline, timelineCursor, worldId],
    ),
  );
  async function loadEarlierTimeline(recover = false): Promise<void> {
    if (timelineCursor === null || earlierTimelineDisabled) return;
    setEarlierTimelineLoading(true);
    try {
      await (recover
        ? earlierTimelineTarget.recover()
        : earlierTimelineTarget.read());
    } finally {
      setEarlierTimelineLoading(false);
    }
  }

  const {
    target: controlPreviewTarget,
    syncFailed: controlPreviewFailed,
    syncError: controlPreviewError,
  } = useReadTarget(
    useCallback(async () => {
      const attempt = controlPreviewAttempt.current;
      const expectedFingerprint = attempt?.fingerprint;
      if (
        !managementVisible ||
        attempt === null ||
        expectedFingerprint === undefined
      )
        return null;
      try {
        const preview = await client.request({
          type: "world.control-draft.preview",
          worldId,
          expectedFingerprint,
        });
        return {
          attempt,
          preview:
            isResponseRecord(preview) &&
            isResponseRecord(preview.diagnosticBinding) &&
            preview.diagnosticBinding.controlFingerprint === expectedFingerprint
              ? preview
              : null,
        };
      } catch (reason: unknown) {
        if (isControlDraftConflict(reason)) return { attempt, preview: null };
        throw reason;
      }
    }, [client, worldId, managementVisible]),
    useCallback(
      (
        result: {
          attempt: ControlPreviewAttempt;
          preview: Record<string, unknown> | null;
        } | null,
      ) => {
        if (result?.attempt !== controlPreviewAttempt.current) return;
        if (result.preview === null) {
          controlPreviewAttempt.current = null;
          setPreviewedControl(null);
          setFeedback({
            kind: "error",
            text: uiText(
              "这份控制草稿已被其他操作替换或移除。你的修改仍在，请重新预览。",
            ),
          });
          return;
        }
        setPreviewedControl({
          attempt: result.attempt,
          payload: result.preview,
        });
        setFeedback({
          kind: "status",
          text: uiText("世界控制修改已预览，可以一次性应用。"),
        });
      },
      [],
    ),
  );
  useEffect(() => {
    if (controlPreviewAttempt.current?.files !== controlFiles) {
      controlPreviewAttempt.current = null;
      controlPreviewTarget.accept();
    }
  }, [controlPreviewTarget, controlFiles]);

  function invalidateControlPreview(): void {
    controlPreviewAttempt.current = null;
    setPreviewedControl(null);
    controlPreviewTarget.accept();
  }

  function acceptWorldChange(): void {
    worldTarget.accept({ complete: false });
    stateTarget.accept({ complete: false });
    controlTarget.accept({ complete: false });
    runtimeTarget.accept({ complete: false });
    aiReadingTarget.accept({ complete: false });
    decorationTarget.accept({ complete: false });
    // Old timeline cursors and previews no longer describe the committed world.
    earlierTimelineTarget.accept();
    controlPreviewTarget.accept();
  }

  async function previewControl(): Promise<void> {
    invalidateControlPreview();
    const attempt: ControlPreviewAttempt = { files: controlFiles };
    controlPreviewAttempt.current = attempt;
    setFeedback(null);
    setPending("control-preview");
    try {
      const receipt = await worldTarget.command(() =>
        client.request({
          type: "world.control-draft.save",
          worldId,
          files: attempt.files,
        }),
      );
      if (controlPreviewAttempt.current !== attempt) return;
      if (!isResponseRecord(receipt) || typeof receipt.fingerprint !== "string")
        throw unreadableResponse(200);
      attempt.fingerprint = receipt.fingerprint;
      controlPreviewTarget.accept({ complete: false });
      await controlPreviewTarget.read();
    } catch (reason: unknown) {
      if (controlPreviewAttempt.current === attempt) {
        invalidateControlPreview();
        setFeedback({ kind: "error", text: errorMessage(reason) });
      }
    } finally {
      setPending(null);
    }
  }

  async function applyControl(): Promise<void> {
    const attempt = controlPreview?.attempt;
    const expectedFingerprint = attempt?.fingerprint;
    if (
      expectedFingerprint === undefined ||
      controlPreviewAttempt.current !== attempt ||
      activeStatus === "running"
    )
      return;
    setPending("control-apply");
    try {
      await worldTarget.command(() =>
        client.request({
          type: "world.control-draft.apply",
          worldId,
          expectedFingerprint,
        }),
      );
      acceptWorldChange();
      if (controlPreviewAttempt.current === attempt) {
        invalidateControlPreview();
        setControlDirty(false);
      }
      await readAfterCommit(() => refreshWorld());
      setFeedback({ kind: "status", text: uiText("世界控制已整批应用。") });
    } catch (reason: unknown) {
      if (
        isControlDraftConflict(reason) &&
        controlPreviewAttempt.current === attempt
      )
        invalidateControlPreview();
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  function openRevision(path?: string): void {
    if (path !== undefined) setSelectedDocument(path);
    setDialog("revision");
    setRightRailOpen(false);
    setReadingOpen(false);
  }

  function openPlayDialog(
    next: "reading" | "manage",
    opener: HTMLButtonElement,
  ): void {
    // showModal restores its previous focus. Some browsers leave pointer-clicked
    // buttons unfocused, so use the actual opener consistently.
    opener.focus({ preventScroll: true });
    setReadingOpen(false);
    if (next === "manage") setControlEditorOpen(false);
    setDialog(next);
  }

  function rememberProtagonistFinish(epochId: string): void {
    if (protagonistCustomization !== null)
      changeProtagonistCustomization({ ...protagonistCustomization, epochId });
  }

  async function applyRevision(): Promise<void> {
    if (activeRevisionEpoch?.locked === true)
      rememberProtagonistFinish(activeRevisionEpoch.epochId);
    const result = await revisionWorkspace.finish("apply");
    if (result === null) return;
    acceptWorldChange();
    revisionWorkspace.close();
    if (protagonistCustomization !== null) changeProtagonistCustomization(null);
    setDialog(null);
    if (result.changed) setForceFreshContext(true);
    try {
      await refreshWorld(false);
      setFeedback({
        kind: "status",
        text: uiText(
          "世界修订已应用并解锁。再次继续原对话时，AI 会先重新读取当前世界。",
        ),
      });
    } catch (reason: unknown) {
      setFeedback({
        kind: "error",
        text: uiText(
          "世界修订已应用并解锁，但刷新世界失败。请重新打开世界：{message}",
          { message: errorMessage(reason) },
        ),
      });
    }
  }

  async function discardRevision(
    epoch: Pick<V1WorldRevisionEpochView, "epochId" | "revision">,
  ): Promise<void> {
    rememberProtagonistFinish(epoch.epochId);
    const result = await revisionWorkspace.finish("discard", epoch);
    if (result === null) return;
    worldTarget.accept({ complete: false });
    revisionWorkspace.close();
    if (protagonistCustomization !== null) changeProtagonistCustomization(null);
    setDialog(null);
    try {
      await refreshWorld(false);
      setFeedback({
        kind: "status",
        text: uiText("这次世界修订已放弃，原世界保持不变并已解锁。"),
      });
    } catch (reason: unknown) {
      setFeedback({
        kind: "error",
        text: uiText(
          "这次世界修订已放弃，原世界保持不变并已解锁，但刷新世界失败。请重新打开世界：{message}",
          { message: errorMessage(reason) },
        ),
      });
    }
  }
  async function deriveWorld(sourceHead = world?.head): Promise<void> {
    if (world === null) return;
    if (sourceHead === undefined) return;
    setPending("derive");
    try {
      const derived = await worldTarget.command(() =>
        requestRuntime<{ world: { worldId: string } }>(client, {
          type: "world.derive",
          operationId: createClientId("derive"),
          sourceWorldId: world.worldId,
          sourceHead,
        }),
      );
      await readAfterCommit(() => onOpenWorld(derived.world.worldId));
    } catch (reason: unknown) {
      await onRecoverWorkspace?.();
      setFeedback({ kind: "error", text: errorMessage(reason) });
      setPending(null);
    }
  }

  async function refreshRevisedTimeline(
    chain: V1PlayCallChainView,
    previous: WorldReadView,
  ): Promise<void> {
    acceptWorldChange();
    // Regeneration replaces history. Reusing the old tail as an append would keep removed replies.
    setPlayContextUsage(projectPlayContextUsage(chain));
    setPlayCallChain(null);
    setPlayTimeline(legacyTimelinePage({ ...previous, playCallChain: chain }));
    await readAfterCommit(() => refreshWorld());
  }

  async function regenerateNarrative(
    chainId: string,
    eventId: number,
  ): Promise<void> {
    if (
      world === null ||
      pending !== null ||
      activeStatus === "running" ||
      worldRevisionLocked
    )
      return;
    setPending("play-append");
    setFeedback({ kind: "status", text: uiText("正在重新生成叙事…") });
    try {
      const result = await worldTarget.command(() =>
        requestRuntime<V1PlayCallChainView>(client, {
          type: "play.chain.regenerate-narrative",
          operationId: createClientId("regenerate-narrative"),
          worldId: world.worldId,
          chainId,
          eventId,
        }),
      );
      await refreshRevisedTimeline(result, world);
      setFeedback({
        kind: result.status === "interrupted" ? "error" : "status",
        text:
          result.status === "interrupted"
            ? playFailureDescription(
                result.lastFailureKind,
                result.canRetry,
                result.canContinuePartial,
              )
            : uiText("已重新生成叙事。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function reviseEditedPlayer(
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
    regenerate = false,
  ): Promise<void> {
    if (
      world === null ||
      pending !== null ||
      activeStatus === "running" ||
      worldRevisionLocked
    )
      return;
    if (editedText.trim().length === 0) {
      setFeedback({
        kind: "error",
        text: uiText("修改后的玩家提交不能为空。"),
      });
      return;
    }
    setRegenerationFallback(null);
    let regenerationTarget = {
      worldId,
      chainId,
      eventId,
      originalText: editedText,
    };
    const replacementExchangeId = createClientId("play-exchange");
    setPending("revise");
    setFeedback({
      kind: "status",
      text: regenerate
        ? uiText("正在重新生成…")
        : uiText("正在当前世界中保存修改，并舍弃这条消息之后的当前时间线…"),
    });
    try {
      const revised = await worldTarget.command(() =>
        requestRuntime<{
          outcome: "revised";
          worldId: string;
          playCallChain: V1PlayCallChainView;
          sentAfterRevision?: boolean;
          continuation: Exclude<PlayerRevisionContinuation, "auto">;
        }>(client, {
          type: "play.chain.revise-player",
          operationId: createClientId("revise-player"),
          worldId: world.worldId,
          chainId,
          eventId,
          replacementExchangeId,
          replacementText: editedText,
          ...turnNoteField(turnNote),
          continuation,
          requireCompatible:
            modelConfigured && continuation === "continue_context",
          sendAfterRevision: modelConfigured,
        }),
      );
      // The revised chain is bound to the revision's own head.
      setForceFreshContext(false);
      if (revised.continuation === "fresh_context")
        consumeCheckpointPreference();
      const revisedPlayer = revised.playCallChain.events.find(
        (event) =>
          event.kind === "player" && event.exchangeId === replacementExchangeId,
      );
      if (revisedPlayer !== undefined)
        regenerationTarget = {
          ...regenerationTarget,
          chainId: revised.playCallChain.chainId,
          eventId: revisedPlayer.id,
        };
      if (revised.sentAfterRevision !== true) {
        await refreshRevisedTimeline(revised.playCallChain, world);
        setFeedback({
          kind: "status",
          text: uiText(
            regenerate
              ? "原回复已从当前故事移除。配置模型后，将输入框留空，在「{menu}」中选择「{action}」即可重新生成。"
              : "修改已保存。配置模型后，将输入框留空，在「{menu}」中选择「{action}」即可继续生成。",
            {
              menu: uiText("更多"),
              action: uiText("接着当前对话继续"),
            },
          ),
        });
        return;
      }

      const continued = revised.playCallChain;
      if (continued.status === "ready") {
        setTurnNote("");
        setTurnNoteOpen(false);
      }
      if (
        regenerate &&
        continuation === "continue_context" &&
        continued.status === "interrupted" &&
        !continued.canRetry &&
        !continued.canContinuePartial
      )
        setRegenerationFallback(regenerationTarget);
      await refreshRevisedTimeline(continued, world);
      const openedNewConversation =
        continuation === "auto" && revised.continuation === "fresh_context";
      const message =
        continued.status === "interrupted"
          ? continued.canRetry
            ? uiText("修改已保存；模型请求中断，可以重新发送已保存的请求。")
            : continued.canContinuePartial
              ? uiText("修改已保存，可以续写中断的回复。")
              : uiText("修改已保存，但模型请求失败。")
          : regenerate
            ? uiText("已重新生成；原回复已离开当前时间线")
            : revised.continuation === "fresh_context"
              ? uiText("修改已保存在当前世界，并已用新对话继续。")
              : uiText("修改已保存在当前世界，并已从修改稿继续。");
      setFeedback({
        kind:
          continued.status === "interrupted" &&
          !continued.canRetry &&
          !continued.canContinuePartial
            ? "error"
            : "status",
        text: openedNewConversation
          ? uiText("原对话无法继续，已开启新对话。{message}", {
              message: continued.status === "interrupted" ? ` ${message}` : "",
            })
          : message,
      });
    } catch (reason: unknown) {
      // A refresh error or generic rejection cannot establish a context incompatibility.
      if (
        regenerate &&
        continuation === "continue_context" &&
        reason instanceof RuntimeRequestError &&
        (reason.protocolCode === "model_protocol_mismatch" ||
          (isResponseRecord(reason.details) &&
            reason.details.recovery === "fresh_context"))
      )
        setRegenerationFallback(regenerationTarget);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  function submitCurrentMode(): Promise<void> {
    return submitPlayChain(defaultSubmitFresh ? "fresh" : "append");
  }

  async function saveReadingPreferences(
    next: AppReadingPreferences,
  ): Promise<void> {
    setReadingPreferences(next);
    setReadingPreferencesSaving(true);
    try {
      const preferences = await readingTarget.command(() =>
        requestRuntime<AppPreferences>(client, {
          type: "preferences.save",
          reading: next,
        }),
      );
      readingTarget.accept();
      setReadingPreferences(preferences.reading);
      onReadingPreferencesChange?.(preferences.reading);
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setReadingPreferencesSaving(false);
    }
  }

  async function downloadStory(format: V1StoryExportFormat): Promise<void> {
    if (pending !== null) return;
    setPending("story-export");
    setFeedback(null);
    try {
      const exported = (await client.request({
        type: "world.story.export",
        worldId,
        format,
      })) as V1StoryExport;
      const outcome = await saveFile(exported.fileName, {
        blob: new Blob([exported.content], {
          type:
            format === "markdown"
              ? "text/markdown;charset=utf-8"
              : "text/plain;charset=utf-8",
        }),
      });
      if (outcome !== "cancelled")
        setFeedback({ kind: "status", text: uiText("故事已导出。") });
    } catch (reason: unknown) {
      await worldTarget.recover();
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
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
      await worldTarget.recover();
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  function openFreshComposer(): void {
    if (playRequestRecovery?.kind === "protocol_mismatch")
      setPlayRequestRecovery(null);
    setManualFreshContext(true);
    composerTextareaRef.current?.focus();
  }

  const failureRecovery: PlayFailureRecovery = {
    freshContextReason,
    onFreshContext: openFreshComposer,
    canRetry: activeCanRetry,
    canContinuePartial: activeCanContinuePartial,
    onContinuePartial: () =>
      void submitPlayChain("append", "", "continue_partial"),
    playDisabled: !modelConfigured || !playIdle || modelProtocolMismatch,
    configureDisabled: !playIdle || navigationBusy,
    onRetry: () => void submitPlayChain("append", ""),
    onConfigureModel,
  };

  const composer = useConversationComposer(
    modelConfigured && defaultSubmitEnabled,
    submitCurrentMode,
  );

  if (world?.worldId !== worldId)
    return (
      <main className="world-reader-page world-page-loading">
        {showWorkspaceBack && (
          <button
            className="world-back-button secondary-button"
            onClick={onBack}
          >
            {uiText("← 返回工作区")}
          </button>
        )}
        <SyncNotice
          failed={syncFailed}
          reason={worldSyncError}
          onRead={recoverPlay}
        />
        {feedback?.kind === "error" ? (
          <p role="alert">{feedback.text}</p>
        ) : !syncFailed ? (
          <p role="status">{uiText("正在打开世界…")}</p>
        ) : null}
      </main>
    );

  if (dialog === "revision") {
    const epoch = activeRevisionEpoch;
    return (
      <SettingImprovementPanel
        onNavigationProtectionChange={setAuthoringNavigation}
        key={worldId}
        target="world-revision"
        {...(protagonistCustomization === null
          ? {}
          : { backLabel: uiText("返回主角确认") })}
        packageName={worldTitle}
        modelConfigured={modelConfigured}
        hasUnsavedFileDraft={revisionDirty}
        loading={authoring.loading}
        conversation={conversation}
        conversationActions={authoringConversationActions(revisionWorkspace)}
        onViewPromptOrder={
          onViewPromptOrder &&
          ((target) => onViewPromptOrder("authorPrompts", target))
        }
        notice={authoring.notice}
        contentEditor={{
          mode: "world-revision",
          files: revisionFiles,
          revisionBase: epoch?.locked
            ? epoch
            : { files: authoring.serverFiles },
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
          dirty: revisionDirty,
          saving: authoring.savingFiles,
          onFilesChange: (files) => revisionWorkspace.editFiles(files),
          onSave: () => void revisionWorkspace.saveFiles(),
          onReset: () => revisionWorkspace.resetFiles(),
          onCopy: () => undefined,
          onExport: () => undefined,
          onDelete: () => undefined,
          title: worldTitle,
          onRename: () => undefined,
        }}
        onConfigureModel={onConfigureModel}
        onBack={() => {
          if (protagonistCustomization !== null) {
            const latestSessionId = revisionOverview?.latest?.sessionId;
            if (
              latestSessionId !== undefined &&
              latestSessionId !== authoring.view?.sessionId
            )
              void revisionWorkspace.selectSession(latestSessionId);
            setDialog(null);
            return;
          }
          revisionWorkspace.close();
          setDialog(null);
          void refreshWorld(false).catch((reason: unknown) =>
            setFeedback({ kind: "error", text: errorMessage(reason) }),
          );
        }}
        {...(protagonistCustomization !== null ||
        epoch?.locked === true ||
        (revisionOverview?.sealedEpochs.length ?? 0) > 0
          ? {
              revisionActions: {
                discardTarget:
                  epoch?.locked === true
                    ? { epochId: epoch.epochId, revision: epoch.revision }
                    : null,
                ...(protagonistCustomization === null
                  ? {}
                  : { applyLabel: uiText("应用并开始游玩") }),
                changedFileCount: epoch?.diff.length ?? 0,
                canApply:
                  epoch?.locked === true &&
                  (modelConfigured || protagonistCustomization !== null) &&
                  epoch.diagnostics.length === 0,
                applying: authoring.applying,
                changes: epoch?.changes ?? [],
                sealedEpochs: revisionOverview?.sealedEpochs ?? [],
                onApply: applyRevision,
                onDiscard: discardRevision,
              },
            }
          : {})}
      />
    );
  }

  if (protagonistCustomization !== null) {
    return (
      <ProtagonistConfirmationCard
        worldTitle={worldTitle}
        customization={protagonistCustomization}
        onChange={changeProtagonistCustomization}
        workspace={revisionWorkspace}
        authoring={authoring}
        modelConfigured={modelConfigured}
        onConfigureModel={onConfigureModel}
        onAdvanced={() => openRevision()}
        onApply={applyRevision}
        onDiscard={async () => {
          if (activeRevisionEpoch !== null)
            await discardRevision(activeRevisionEpoch);
          else changeProtagonistCustomization(null);
        }}
        onBusyChange={setProtagonistBusy}
      />
    );
  }

  const feedbackNotice =
    feedback === null ||
    (feedback.technical === true &&
      !readingPreferences.showTechnicalInfo) ? null : (
      <p
        className={"world-feedback " + feedback.kind}
        role={feedback.kind === "error" ? "alert" : "status"}
      >
        {feedback.text}
      </p>
    );

  return (
    <main
      className={`world-reader-page ${readingPreferences.showTechnicalInfo ? "is-detailed-mode" : "is-story-mode"}`}
      style={
        {
          "--world-left-rail-width": leftRailWidth + "px",
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
        artifacts={displayedDecorations?.artifacts ?? []}
        playerViewPanels={
          displayedDecorations?.playerViewPanels ?? world.playerViewPanels ?? []
        }
        extensions={displayedDecorations?.extensions ?? []}
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
          <WorldHeaderChrome
            worldTitle={worldTitle}
            leftRailOpen={leftRailOpen}
            rightRail={rightRailOpen ? rightRailTab : null}
            readingOpen={readingOpen}
            onBack={showWorkspaceBack ? onBack : undefined}
            onToggleNow={() => setLeftRailOpen((open) => !open)}
            onOpenRail={(tab) => {
              setRightRailTab(tab);
              setRightRailOpen(true);
              setReadingOpen(false);
            }}
            onToggleReading={() => {
              setReadingOpen((open) => !open);
              setRightRailOpen(false);
            }}
            onManage={(opener) => openPlayDialog("manage", opener)}
          />

          <section
            ref={readerRef}
            className="world-reader-scroll"
            aria-label={uiText("世界游玩")}
          >
            <article
              className={`world-story-column ${styles.column}`}
              aria-busy={pending !== null || activeStatus === "running"}
              aria-label={uiText("故事时间线")}
            >
              <ArtifactExtensionMount mount="story" />
              {timelineCursor === null ? null : (
                <>
                  <SyncNotice
                    failed={earlierTimelineFailed}
                    reason={earlierTimelineError}
                    onRead={() => void loadEarlierTimeline(true)}
                  />
                  <button
                    type="button"
                    className="secondary-button timeline-load-earlier"
                    disabled={earlierTimelineDisabled}
                    onClick={() => void loadEarlierTimeline()}
                  >
                    {earlierTimelineLoading
                      ? uiText("正在加载…")
                      : uiText("加载更早的故事")}
                  </button>
                </>
              )}
              {playTimeline !== null && playTimeline.items.length > 0 ? (
                <PlayTimeline
                  client={client}
                  worldId={worldId}
                  items={playTimeline.items}
                  liveChain={playCallChain}
                  activeFailure={
                    activeFailureVisible && lastActiveEvent?.kind === "event"
                      ? {
                          chainId: lastActiveEvent.chainId,
                          eventId: lastActiveEvent.event.id,
                        }
                      : undefined
                  }
                  failureRecovery={
                    activeFailureVisible && activeChainId !== null
                      ? { ...failureRecovery, chainId: activeChainId }
                      : undefined
                  }
                  restartDisabled={
                    pending !== null ||
                    activeStatus === "running" ||
                    worldRevisionLocked
                  }
                  freshContextDisabled={!modelConfigured}
                  showTechnicalInfo={readingPreferences.showTechnicalInfo}
                  onRestartFrom={(head) => void deriveWorld(head)}
                  onEditPlayer={(chainId, eventId, editedText, continuation) =>
                    void reviseEditedPlayer(
                      chainId,
                      eventId,
                      editedText,
                      continuation,
                    )
                  }
                  onRegenerateNarrative={(chainId, eventId) =>
                    void regenerateNarrative(chainId, eventId)
                  }
                  onRegeneratePlayer={(
                    chainId,
                    eventId,
                    originalText,
                    requiresFreshContext,
                  ) => {
                    // A world that only moved ahead of the chain is restored
                    // to this message's parent by the revision itself.
                    if (
                      requiresFreshContext ||
                      world?.archiveNeedsFreshContext === true ||
                      (activeStatus === "interrupted" && !activeCanRetry)
                    ) {
                      setRegenerationFallback({
                        worldId,
                        chainId,
                        eventId,
                        originalText,
                      });
                      return;
                    }
                    void reviseEditedPlayer(
                      chainId,
                      eventId,
                      originalText,
                      "continue_context",
                      true,
                    );
                  }}
                />
              ) : committedMessages.length === 0 ? (
                <div className="story-empty-state">
                  <span aria-hidden="true">✦</span>
                  <h3>{uiText("故事还没有开始")}</h3>
                  <p>{uiText("写下你的第一个行动。")}</p>
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
                  retries={activeModelRetries}
                  progress={playProgress}
                  now={playProgressNow}
                  onCancel={() => void cancelPlayGeneration()}
                />
              )}
              <div ref={historyEndRef} />
              {readingPreferences.showTechnicalInfo && (
                <ArtifactDebugger
                  records={displayedDecorations?.artifactDebug ?? []}
                  extensions={displayedDecorations?.extensions ?? []}
                  playerViewPanels={
                    displayedDecorations?.playerViewPanels ??
                    world.playerViewPanels ??
                    []
                  }
                  bridgeEvents={bridgeEvents}
                />
              )}
            </article>
          </section>

          <PlayComposer
            dockRef={composerRef}
            action={{
              text: playerText,
              onChange: setPlayerText,
              attach: composerTextareaAttach,
              ref: composerTextareaRef,
            }}
            note={{
              text: turnNote,
              setText: setTurnNote,
              open: turnNoteOpen,
              setOpen: setTurnNoteOpen,
              ref: turnNoteInputRef,
            }}
            submission={{
              composer,
              canAppend: canAppend && modelConfigured,
              canStartFresh: canStartFresh && modelConfigured,
              primaryAction,
              currentAction:
                activeChainId === null
                  ? "first"
                  : (currentRecovery ?? "current"),
              defaultSubmitEnabled: defaultSubmitEnabled && modelConfigured,
              submitting: pending === "play-fresh" || pending === "play-append",
              onSubmitAlternate: submitPlayChain,
            }}
            disabled={!playIdle}
            showTechnicalInfo={readingPreferences.showTechnicalInfo}
          >
            <SyncNotice
              failed={decorationFailed}
              reason={decorationError}
              onRead={() => void decorationTarget.recover()}
            />
            {(displayedDecorations?.extensionControls ??
              world.extensionControls) === undefined ? null : (
              <WorldExtensionMenu
                view={
                  (displayedDecorations?.extensionControls ??
                    world.extensionControls)!
                }
                onChange={async (key, value) => {
                  const receipt = await decorationTarget.command(() =>
                    requestRuntime<WorldExtensionsView>(client, {
                      type: "world.extensions.set",
                      worldId,
                      key,
                      value,
                    }),
                  );
                  decorationTarget.accept({ complete: false });
                  setDecorations((current) =>
                    current?.worldId === worldId
                      ? { ...current, extensionControls: receipt }
                      : current,
                  );
                  setWorld((current) =>
                    current === null
                      ? null
                      : { ...current, extensionControls: receipt },
                  );
                  await decorationTarget.read();
                }}
              />
            )}
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
                <p>
                  {uiText("你可以先写下行动。配置模型连接后，再由你发送。")}
                </p>
                <button type="button" onClick={onConfigureModel}>
                  {uiText("配置模型")}
                </button>
              </div>
            ) : null}
            <SyncNotice
              reason={worldSyncError}
              failed={
                dialog === null &&
                (syncFailed ||
                  (observationStopped && activeStatus === "running"))
              }
              onRead={recoverPlay}
            />
            {visiblePlayFailure === null || activeFailureVisible ? null : (
              <div
                className={
                  activeFailureKind === "dispatch_budget"
                    ? "play-retry-note"
                    : "play-call-failure"
                }
                role={
                  activeFailureKind === "dispatch_budget" ? "status" : "alert"
                }
                aria-label={uiText(
                  activeFailureKind === "dispatch_budget"
                    ? "游玩生成已暂停"
                    : "模型调用失败",
                )}
              >
                <PlayFailureNotice
                  failureKind={activeFailureKind}
                  canRetry={failureRecovery.canRetry}
                  message={
                    failureWasSuperseded
                      ? visiblePlayFailure
                      : (playCallChain?.lastFailure ??
                        playTimeline?.activeLastFailure ??
                        visiblePlayFailure)
                  }
                  recovery={failureRecovery}
                />
              </div>
            )}
            {(!freshContextReason &&
              !activeCanRetry &&
              !activeCanContinuePartial) ||
            !playIdle ||
            activeFailureVisible ||
            visiblePlayFailure !== null ||
            (failureWasSuperseded && activeStatus === "interrupted") ? null : (
              <div className="play-retry-note" role="status">
                {freshContextReason === undefined && (
                  <p>
                    {playFailureDescription(
                      activeFailureKind,
                      activeCanRetry,
                      activeCanContinuePartial,
                    )}
                  </p>
                )}
                <ModelRecoveryActions
                  disabled={failureRecovery.playDisabled}
                  freshContextReason={freshContextReason}
                  onFreshContext={openFreshComposer}
                  onContinue={
                    activeCanContinuePartial
                      ? failureRecovery.onContinuePartial
                      : undefined
                  }
                  onResend={
                    activeCanRetry ? failureRecovery.onRetry : undefined
                  }
                />
              </div>
            )}
            {playRequestRecovery?.kind === "prompt_role_order" && playIdle ? (
              <div className="play-call-failure" role="alert">
                <p>{promptRoleOrderRule()}</p>
                {onViewPromptOrder && (
                  <button
                    type="button"
                    onClick={() =>
                      onViewPromptOrder(
                        "playPrompts",
                        playRequestRecovery.target,
                      )
                    }
                  >
                    {uiText("查看编排")}
                  </button>
                )}
              </div>
            ) : null}
            {(modelProtocolMismatch ||
              playRequestRecovery?.kind === "protocol_mismatch") &&
            playIdle ? (
              <div className="play-call-failure" role="status">
                <p>
                  {uiText(
                    "当前模型协议与此上下文不同。切回原协议即可继续；使用新协议请开启全新上下文。",
                  )}
                </p>
                {!preferFreshContext && (
                  <div>
                    <button type="button" onClick={openFreshComposer}>
                      {uiText("选择新对话（保留故事进度）")}
                    </button>
                  </div>
                )}
              </div>
            ) : null}
            {preferFreshContext && !activeChainStale && playIdle ? (
              <div className="world-fresh-context-note" role="note">
                <span>{uiText("下一条消息将开启全新上下文")}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    consumeCheckpointPreference();
                    composerTextareaRef.current?.focus();
                  }}
                >
                  {uiText("取消全新上下文")}
                </button>
              </div>
            ) : null}
            {regenerationFallback?.worldId === worldId ? (
              <div className="play-retry-note" role="status">
                <p>
                  {uiText(
                    "原上下文无法用于这次重新生成。可使用当前模型和编排方案，从同一条玩家输入开启全新上下文。",
                  )}
                </p>
                <button
                  type="button"
                  disabled={!playIdle || !modelConfigured}
                  onClick={() =>
                    void reviseEditedPlayer(
                      regenerationFallback.chainId,
                      regenerationFallback.eventId,
                      regenerationFallback.originalText,
                      "fresh_context",
                      true,
                    )
                  }
                >
                  {uiText("用全新上下文重新生成")}
                </button>
                <button
                  type="button"
                  disabled={!playIdle}
                  onClick={() => setRegenerationFallback(null)}
                >
                  {uiText("取消")}
                </button>
              </div>
            ) : null}
            <PlayContextUsage
              chain={
                playContextUsage?.worldId === worldId ? playContextUsage : null
              }
              timeline={playTimeline}
              freshContextSelected={
                preferFreshContext ||
                activeChainStale ||
                pending === "play-fresh"
              }
              freshContextDisabled={!playIdle || !modelConfigured}
              onUseFreshContext={openFreshComposer}
            />
          </PlayComposer>

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
            <div
              className="world-rail-resize-handle"
              role="separator"
              aria-label={uiText("调整此刻面板宽度")}
              aria-orientation="vertical"
              aria-valuemin={240}
              aria-valuemax={720}
              aria-valuenow={leftRailWidth}
              tabIndex={leftRailOpen ? 0 : -1}
              title={uiText("拖拽调整宽度，双击恢复默认")}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                leftRailDrag.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  width:
                    event.currentTarget.parentElement!.getBoundingClientRect()
                      .width,
                };
              }}
              onPointerMove={(event) => {
                const drag = leftRailDrag.current;
                if (drag?.pointerId !== event.pointerId) return;
                resizeLeftRail(drag.width + event.clientX - drag.x);
              }}
              onPointerUp={(event) => {
                leftRailDrag.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                leftRailDrag.current = null;
              }}
              onLostPointerCapture={() => {
                leftRailDrag.current = null;
              }}
              onDoubleClick={() => setLeftRailWidth(320)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  resizeLeftRail(
                    leftRailWidth + (event.key === "ArrowRight" ? 20 : -20),
                  );
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  resizeLeftRail(event.key === "Home" ? 240 : 720);
                }
              }}
            />
            <header>
              <div>
                <strong>{uiText("此刻")}</strong>
              </div>
              <div className="world-rail-header-actions">
                <div className="world-rail-fold-actions">
                  <button type="button" onClick={playerViewFold.expandAll}>
                    {uiText("全部展开")}
                  </button>
                  <button type="button" onClick={playerViewFold.collapseAll}>
                    {uiText("全部收起")}
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={uiText("收起状态栏")}
                  onClick={() => setLeftRailOpen(false)}
                >
                  ×
                </button>
              </div>
            </header>
            <PlayerViewFoldProvider value={playerViewFold.fold}>
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
                      {playerViewFallback.diagnostics.map(
                        (diagnostic, index) => (
                          <li key={diagnostic.code + "-" + index}>
                            {diagnostic.message}
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                )}
              </div>
            </PlayerViewFoldProvider>
          </aside>

          <aside
            className={
              rightRailOpen
                ? "world-overlay-rail world-overlay-rail-right is-open"
                : "world-overlay-rail world-overlay-rail-right"
            }
            aria-hidden={!rightRailOpen}
            inert={!rightRailOpen}
            aria-label={
              rightRailTab === "documents"
                ? uiText("当前世界")
                : uiText("AI 如何读取")
            }
          >
            <header>
              <div>
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
              <SyncNotice
                failed={
                  stateFailed ||
                  (rightRailTab === "ai-reading" && aiReadingFailed)
                }
                reason={aiReadingError ?? stateError}
                onRead={() => {
                  if (stateFailed) void stateTarget.recover();
                  if (rightRailTab === "ai-reading" && aiReadingFailed)
                    void aiReadingTarget.recover();
                }}
              />
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
                  onOpenFull={(event) =>
                    openPlayDialog("reading", event.currentTarget)
                  }
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
              <button
                type="button"
                onClick={(event) =>
                  openPlayDialog("manage", event.currentTarget)
                }
              >
                {uiText("世界管理")}
              </button>
            </footer>
          </aside>

          {readingOpen ? (
            <>
              <SyncNotice
                failed={readingSyncFailed}
                onRead={() => void readingTarget.recover()}
              />
              <ReadingPreferencesPopover
                value={readingPreferences}
                saving={readingPreferencesSaving}
                onChange={(next) => void saveReadingPreferences(next)}
                onClose={() => setReadingOpen(false)}
              />
            </>
          ) : null}

          {dialog === "reading" ? (
            <AiReadingDialog
              syncNotice={
                <SyncNotice
                  failed={aiReadingFailed || stateFailed || syncFailed}
                  reason={aiReadingError ?? stateError ?? worldSyncError}
                  onRead={() => {
                    if (aiReadingFailed) void aiReadingTarget.recover();
                    if (stateFailed) void stateTarget.recover();
                    if (syncFailed) recoverPlay();
                  }}
                />
              }
              reading={aiReading}
              documents={documents}
              feedback={feedbackNotice}
              onClose={() => setDialog(null)}
            />
          ) : null}

          {dialog === "manage" ? (
            <WorldManagementDialog
              syncNotice={
                <SyncNotice
                  failed={
                    controlFailed ||
                    (controlEditorVisible && stateFailed) ||
                    runtimeFailed ||
                    controlPreviewFailed ||
                    syncFailed
                  }
                  reason={
                    controlPreviewError ??
                    controlError ??
                    (controlEditorVisible ? stateError : undefined) ??
                    runtimeError ??
                    worldSyncError
                  }
                  onRead={() => {
                    if (controlFailed) void controlTarget.recover();
                    if (controlEditorVisible && stateFailed)
                      void stateTarget.recover();
                    if (runtimeFailed) void runtimeTarget.recover();
                    if (controlPreviewFailed)
                      void controlPreviewTarget.recover();
                    if (syncFailed) recoverPlay();
                  }}
                />
              }
              worldBackupExport={
                <WorldBackupExportButton
                  client={client}
                  worldId={worldId}
                  onFailure={() => worldTarget.recover()}
                  disabled={
                    pending !== null ||
                    activeStatus === "running" ||
                    worldRevisionLocked
                  }
                  onBusyChange={(busy) =>
                    setPending(busy ? "archive-export" : null)
                  }
                />
              }
              packageScriptPermission={
                <PackageScriptPermissionControl
                  key={worldId}
                  client={client}
                  kind="world"
                  id={worldId}
                  dirty={controlDirty}
                  onChange={() => invalidateDecorations()}
                />
              }
              feedback={feedbackNotice}
              world={world}
              worldTitle={worldTitle}
              worldNameDraft={worldNameDraft}
              setWorldNameDraft={setWorldNameDraft}
              pending={pending}
              activeStatus={activeStatus}
              controlEditorOpen={controlEditorOpen}
              onControlEditorOpenChange={setControlEditorOpen}
              controlFiles={
                controlDirty || controlHead === worldHead ? controlFiles : null
              }
              controlState={stateHead === worldHead ? world.state : null}
              controlDirty={controlDirty}
              controlPreview={controlPreview?.payload ?? null}
              onControlFiles={(value) => {
                setControlFiles(value);
                setControlDirty(true);
                invalidateControlPreview();
              }}
              onResetControl={
                controlHead !== worldHead
                  ? undefined
                  : () => {
                      setControlFiles(world.control);
                      setControlDirty(false);
                      invalidateControlPreview();
                    }
              }
              onRename={() => void renameCurrentWorld()}
              onExportStory={(format) => void downloadStory(format)}
              onDerive={() => void deriveWorld(world.head)}
              onPreviewControl={() => void previewControl()}
              onApplyControl={() => void applyControl()}
              onClose={() => setDialog(null)}
              modelConfigured={modelConfigured}
              revisionLocked={worldRevisionLocked}
            />
          ) : null}

          {dialog === null ? feedbackNotice : null}

          <ArtifactExtensionMount mount="overlay" />
          {readingPreferences.showTechnicalInfo && (
            <ArtifactExtensionMount mount="debug" />
          )}
        </div>
      </ArtifactExtensionHost>
    </main>
  );
}

function PlayerViewCard({
  view,
}: {
  view: RenderedPlayerView;
}): React.JSX.Element {
  const { open, toggle } = useFold(view.id, true);
  return (
    <article className="player-view-card">
      <h3>
        <FoldToggle
          open={open}
          onToggle={toggle}
          label={view.title}
          hint={uiText("{count} 项", { count: view.items.length })}
        />
      </h3>
      {view.items.length === 0 ? (
        <p className="player-view-empty-value player-fold-body" hidden={!open}>
          {uiText("当前没有可显示项目。")}
        </p>
      ) : (
        <dl className="player-fold-body" hidden={!open}>
          {view.items.map((item) => (
            <Entry
              key={item.id}
              path={view.id + "/" + item.id}
              label={item.label}
              value={item.value}
              defaultOpen
            />
          ))}
        </dl>
      )}
    </article>
  );
}

function selectedStateDocument(
  state: readonly ContentTreeFile[],
  current: string,
): string {
  return state.some(({ path }) => path === current)
    ? current
    : (state[0]?.path ?? "");
}

/** The one-turn request as a request field; a blank box sends none. */
function turnNoteField(turnNote: string): { turnNote?: string } {
  const trimmed = turnNote.trim();
  return trimmed === "" ? {} : { turnNote: trimmed };
}

function sameControlFiles(
  previous: readonly ContentTreeFile[],
  next: readonly ContentTreeFile[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((file, index) => {
      const other = next[index];
      return (
        file.path === other?.path &&
        file.contents === other.contents &&
        file.encoding === other.encoding
      );
    })
  );
}

function isControlDraftConflict(reason: unknown): boolean {
  return (
    reason instanceof RuntimeRequestError &&
    reason.protocolCode === "operation_conflict" &&
    isResponseRecord(reason.details) &&
    reason.details.reason === "control_draft_changed"
  );
}

function errorMessage(reason: unknown): string {
  if (
    reason instanceof RuntimeRequestError &&
    reason.protocolCode === "model_protocol_mismatch"
  )
    return uiText(
      "当前模型协议与此上下文不同。切回原协议即可继续；使用新协议请开启全新上下文。",
    );
  return reason instanceof Error ? reason.message : uiText("操作失败");
}
