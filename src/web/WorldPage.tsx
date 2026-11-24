import { ModelRetryStatus } from "./ModelRetryStatus.tsx";
import { PlayTurnCallDetails } from "./PlayTurnCallDetails.tsx";
import { RuntimeRequestError, isResponseRecord } from "./RuntimeResponse.ts";
import { readAfterCommit } from "./RequestOutcome.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import {
  recordedPlaySubmission,
  submitPlay,
  type PlayCommand,
} from "./PlaySubmission.ts";
import { turnGuideLineSoftLimit } from "../shared/ordered-play-prompts.ts";
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
import { type ObserveConversation } from "./ConversationObserver.ts";
import { useAuthoringWorkspace } from "./useAuthoringWorkspace.ts";
import { saveFile, useAndroidBack } from "./androidBridge.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import {
  hasHandledCheckpoint,
  rememberHandledCheckpoint,
} from "./CheckpointContextPreferences.ts";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
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
  V1StoryExport,
  V1StoryExportFormat,
  V1WorldRevisionEpochView,
} from "../protocol/v1.ts";
import {
  defaultAppReadingPreferences,
  type AppPreferences,
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
import { PlayContextUsage } from "./PlayContextUsage.tsx";
import { PlayRunProgress } from "./PlayRunProgress.tsx";
import { ResolutionCard } from "./ResolutionCard.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import {
  createPlayRunProgress,
  progressFromCallChain,
  type PlayRunProgressValue,
} from "./PlayRunProgressState.ts";

type RightRailTab = "documents" | "ai-reading";
type PlayContextUsageProjection = Pick<
  V1PlayCallChainView,
  "worldId" | "chainId" | "contextWindowTokens" | "latestCompletedResponse"
>;
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
  | "story-export"
  | "revise"
  | "derive"
  | "archive-export";

interface WorldMessage {
  role: "player" | "narrator";
  exactText: string;
  messageId?: string;
  head?: string;
}

interface WorldReadView {
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

interface Feedback {
  kind: "status" | "error";
  text: string;
  technical?: boolean;
  submission?: string;
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
  showWorkspaceBack = true,
  onConfigureModel,
  onRenameWorld,
  onOpenWorld,
  onRecoverWorkspace,
  onNavigationLockChange,
  onReadingPreferencesChange,
  initialReadingPreferences = defaultAppReadingPreferences,
  protagonistRevision,
  onProtagonistRevisionStarted,
  onProtagonistRevisionFinished,
}: {
  client: WorldPageClient;
  worldId: string;
  worldTitle: string;
  modelConfigured: boolean;
  onBack: () => void;
  showWorkspaceBack?: boolean;
  onConfigureModel: () => void;
  onRenameWorld: (name: string) => Promise<void>;
  onOpenWorld: (worldId: string) => Promise<void>;
  onRecoverWorkspace?: () => Promise<unknown>;
  onNavigationLockChange?: (locked: boolean) => void;
  onReadingPreferencesChange?: (value: AppReadingPreferences) => void;
  initialReadingPreferences?: AppReadingPreferences;
  protagonistRevision?: { message: string; started: boolean };
  onProtagonistRevisionStarted?: () => void;
  onProtagonistRevisionFinished?: () => void;
}): React.JSX.Element {
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
  const [rightRailTab, setRightRailTab] = useState<RightRailTab>("documents");
  const [readingOpen, setReadingOpen] = useState(false);
  useAndroidBack(leftRailOpen || rightRailOpen, () => {
    setLeftRailOpen(false);
    setRightRailOpen(false);
  });
  const [dialog, setDialog] = useState<WorldDialog>(
    protagonistRevision === undefined ? null : "revision",
  );
  const [readingPreferences, setReadingPreferences] = useState(
    initialReadingPreferences,
  );
  const [readingPreferencesSaving, setReadingPreferencesSaving] =
    useState(false);
  const [playerText, setPlayerText] = useState("");
  // One-turn request: cleared once a dispatch settles ready, kept on interrupt or cancel.
  const [turnNote, setTurnNote] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const worldProjectionVersion = useRef(0);
  const initializedWorldId = useRef<string | null>(null);
  const reconcileObservedPlay = useRef<((world: WorldReadView) => void) | null>(
    null,
  );
  const [observationStopped, setObservationStopped] = useState(false);
  const [observationRevision, setObservationRevision] = useState(0);
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
  const [playProgress, setPlayProgress] = useState<PlayRunProgressValue | null>(
    null,
  );
  const [playProgressNow, setPlayProgressNow] = useState(0);
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
  const [playCallChain, setPlayCallChain] =
    useState<V1PlayCallChainView | null>(null);
  const [playContextUsage, setPlayContextUsage] =
    useState<PlayContextUsageProjection | null>(null);
  const [forceFreshContext, setForceFreshContext] = useState(false);
  const submissionModeId = useId();
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
  const [playTimeline, setPlayTimeline] = useState<V1PlayTimelinePage | null>(
    null,
  );
  const [selectedDocument, setSelectedDocument] = useState("");
  const [controlFiles, setControlFiles] = useState("[]");
  const [authoringLocked, setAuthoringLocked] = useState(false);
  const [controlDirty, setControlDirty] = useState(false);
  const controlDirtyRef = useRef(false);
  useLayoutEffect(() => {
    controlDirtyRef.current = controlDirty;
  }, [controlDirty]);
  const [controlPreview, setControlPreview] = useState<unknown>(null);
  const { workspace: revisionWorkspace, state: authoring } =
    useAuthoringWorkspace(client, "revision", worldId, dialog === "revision");
  const revisionOverview =
    dialog === "revision" ? (authoring.target?.revision ?? null) : null;
  const revisionFiles = authoring.files;
  const revisionDirty = authoring.dirty;
  const [aiReading, setAiReading] = useState<V1PlayContextReadingView | null>(
    null,
  );
  const [aiReadingLoading, setAiReadingLoading] = useState(false);
  const [bridgeEvents, setBridgeEvents] = useState<Record<string, string[]>>(
    {},
  );
  const historyEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const { ref: composerTextareaAttach, textareaRef: composerTextareaRef } =
    useAutosizeTextarea(playerText);
  const turnNoteInputRef = useRef<HTMLInputElement>(null);
  const [turnNoteOpen, setTurnNoteOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(72);
  useEffect(() => {
    if (turnNoteOpen) turnNoteInputRef.current?.focus();
  }, [turnNoteOpen]);
  const worldHead = world?.head;
  const openedWorldId = world?.worldId;
  useEffect(() => {
    onNavigationLockChange?.(revisionDirty || controlDirty || authoringLocked);
    return () => onNavigationLockChange?.(false);
  }, [onNavigationLockChange, revisionDirty, controlDirty, authoringLocked]);

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
      const submission = unconfirmedSubmission.current;
      if (
        submission?.worldId === next.worldId &&
        recordedPlaySubmission(submission, nextChain, next.playTimeline)
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
        setControlFiles(JSON.stringify(next.control, null, 2));
        setControlDirty(false);
        setControlPreview(null);
      }
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
      if (next.state.length > 0)
        setSelectedDocument((current) =>
          selectedStateDocument(next.state, current),
        );
    },
    [],
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
    void worldTarget.read();
  }, [worldTarget]);

  const {
    target: decorationTarget,
    syncFailed: decorationFailed,
    syncError: decorationError,
  } = useReadTarget(
    useCallback(
      () => requestPlayDecorations(client, worldId),
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
        cancelledExchangeRef.current !== null &&
        (chain.lastCancelled === true ||
          chain.events.at(-1)?.kind === "cancellation")
      ) {
        setFeedback({ kind: "status", text: uiText("模型生成已取消。") });
      }
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
      reconcileObservedPlay.current = null;
      unsubscribe();
    };
  }, [client, worldId, openedWorldId, worldTarget, observationRevision]);

  useEffect(() => {
    if (openedWorldId === undefined) return;
    historyEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openedWorldId]);

  const stateVisible =
    world !== null && (rightRailOpen || dialog === "reading");
  const managementVisible = dialog === "manage";
  const {
    target: stateTarget,
    syncFailed: stateFailed,
    syncError: stateError,
  } = useReadTarget(
    useCallback(
      () =>
        stateVisible && worldHead !== undefined
          ? requestRuntime<ContentTreeFile[]>(client, {
              type: "world.surface.read",
              worldId,
              surface: "state",
              head: worldHead,
            })
          : Promise.resolve(null),
      [client, worldId, worldHead, stateVisible],
    ),
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
      [worldHead],
    ),
  );
  const {
    target: controlTarget,
    syncFailed: controlFailed,
    syncError: controlError,
  } = useReadTarget(
    useCallback(
      () =>
        managementVisible && worldHead !== undefined
          ? requestRuntime<ContentTreeFile[]>(client, {
              type: "world.surface.read",
              worldId,
              surface: "control",
              head: worldHead,
            })
          : Promise.resolve(null),
      [client, worldId, worldHead, managementVisible],
    ),
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
          setControlFiles(JSON.stringify(control, null, 2));
      },
      [worldHead],
    ),
  );
  const {
    target: runtimeTarget,
    syncFailed: runtimeFailed,
    syncError: runtimeError,
  } = useReadTarget(
    useCallback(
      () =>
        managementVisible && worldHead !== undefined
          ? requestRuntime<unknown>(client, {
              type: "world.surface.read",
              worldId,
              surface: "runtime",
              head: worldHead,
            })
          : Promise.resolve(null),
      [client, worldId, worldHead, managementVisible],
    ),
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
      [worldHead],
    ),
  );
  useEffect(() => {
    if (stateVisible && stateHead !== worldHead) void stateTarget.read();
  }, [stateTarget, stateVisible, stateHead, worldHead]);
  useEffect(() => {
    if (managementVisible && controlHead !== worldHead)
      void controlTarget.read();
  }, [controlTarget, managementVisible, controlHead, worldHead]);
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
  }, [revisionWorkspace]);

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
  const activeChainStale =
    reportedFreshContextReason === "world_changed" ||
    forceFreshContext ||
    world?.archiveNeedsFreshContext === true ||
    (world !== null &&
      playCallChain !== null &&
      playCallChain.parentHead !== world.head);
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
  const playProgressActive = playProgress !== null;
  const hasPlayerText = playerText.trim().length > 0;
  const playIdle =
    pending === null && activeStatus !== "running" && !worldRevisionLocked;
  const canStartFresh = hasPlayerText && playIdle;
  const canAppend =
    playIdle &&
    freshContextReason === undefined &&
    (activeChainId === null
      ? hasPlayerText
      : activeStatus === "ready" || (!hasPlayerText && activeCanRetry));

  useEffect(() => {
    if (!playProgressActive) return;
    const timer = setInterval(() => setPlayProgressNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playProgressActive]);

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
        : freshContextReason !== undefined ||
          (activeStatus !== "ready" &&
            (hasSubmittedText ||
              !(recovery === "continue_partial"
                ? activeCanContinuePartial
                : activeCanRetry)))
    )
      return;
    setRegenerationFallback(null);
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
        const message = errorMessage(outcome.error);

        if (outcome.retryRejected) {
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
    useCallback((earlier: V1PlayTimelinePage | null) => {
      if (earlier === null) return;
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
    }, []),
  );
  async function loadEarlierTimeline(): Promise<void> {
    if (timelineCursor === null) return;
    setPending("timeline-page");
    await earlierTimelineTarget.read();
    setPending(null);
  }

  const {
    target: controlPreviewTarget,
    syncFailed: controlPreviewFailed,
    syncError: controlPreviewError,
  } = useReadTarget(
    useCallback(
      () =>
        managementVisible
          ? client.request({ type: "world.control-draft.preview", worldId })
          : Promise.resolve(null),
      [client, worldId, managementVisible],
    ),
    useCallback((preview: unknown) => setControlPreview(preview), []),
  );
  useEffect(() => {
    controlPreviewTarget.accept();
  }, [controlPreviewTarget, controlFiles]);

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
    setPending("control-preview");
    try {
      const files = JSON.parse(controlFiles) as ContentTreeFile[];
      await worldTarget.command(() =>
        client.request({ type: "world.control-draft.save", worldId, files }),
      );
      controlPreviewTarget.accept({ complete: false });
      const preview = await controlPreviewTarget.read();
      if (preview === null) return;
      setFeedback({
        kind: "status",
        text: uiText("世界控制修改已预览，可以一次性应用。"),
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
      await worldTarget.command(() =>
        client.request({ type: "world.control-draft.apply", worldId }),
      );
      acceptWorldChange();
      setControlPreview(null);
      setControlDirty(false);
      await readAfterCommit(() => refreshWorld(false));
      setFeedback({ kind: "status", text: uiText("世界控制已整批应用。") });
    } catch (reason: unknown) {
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
    setDialog(next);
  }

  async function applyRevision(): Promise<void> {
    const result = await revisionWorkspace.finish("apply");
    if (result === null) return;
    acceptWorldChange();
    revisionWorkspace.close();
    onProtagonistRevisionFinished?.();
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

  async function discardRevision(): Promise<void> {
    if (
      !globalThis.confirm(
        uiText("放弃这次世界修订？所有尚未应用的手动和 AI 修改都会丢失。"),
      )
    )
      return;
    const result = await revisionWorkspace.finish("discard");
    if (result === null) return;
    worldTarget.accept({ complete: false });
    revisionWorkspace.close();
    onProtagonistRevisionFinished?.();
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
      if (continuation === "fresh_context") consumeCheckpointPreference();
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
      if (!modelConfigured) {
        await refreshRevisedTimeline(revised.playCallChain, world);
        setFeedback({
          kind: "status",
          text: uiText(
            regenerate
              ? "原回复已从当前故事移除。配置模型后，将输入框留空，在「{menu}」（＋）中选择「{action}」即可重新生成。"
              : "修改已保存。配置模型后，将输入框留空，在「{menu}」（＋）中选择「{action}」即可继续生成。",
            {
              menu: uiText("选择提交方式"),
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
      setFeedback({
        kind:
          continued.status === "interrupted" &&
          !continued.canRetry &&
          !continued.canContinuePartial
            ? "error"
            : "status",
        text:
          continued.status === "interrupted"
            ? continued.canRetry
              ? uiText("修改已保存；模型请求中断，可以重新发送已保存的请求。")
              : continued.canContinuePartial
                ? getWebLocale() === "en"
                  ? "Edit saved. Continue the interrupted response."
                  : "修改已保存，可以续写中断的回复。"
                : uiText("修改已保存，但模型请求失败。")
            : regenerate
              ? uiText("已重新生成；原回复已离开当前时间线")
              : continuation === "fresh_context"
                ? uiText("修改已保存在当前世界，并已用新对话继续。")
                : uiText("修改已保存在当前世界，并已从修改稿继续。"),
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
    playDisabled: !modelConfigured || !playIdle,
    configureDisabled:
      !playIdle || revisionDirty || controlDirty || authoringLocked,
    onRetry: () => void submitPlayChain("append", ""),
    onConfigureModel,
  };

  const defaultSubmitFresh =
    preferFreshContext || activeChainId === null || activeChainStale;
  const defaultSubmitEnabled = defaultSubmitFresh ? canStartFresh : canAppend;
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
    const panelView = authoring.view;
    return (
      <SettingImprovementPanel
        onNavigationLockChange={setAuthoringLocked}
        key={worldId}
        onPreview={() => revisionWorkspace.preview()}
        onCallContext={(sessionId, callId) =>
          revisionWorkspace.callContext(sessionId, callId)
        }
        onRequestPreview={(sessionId, requestId) =>
          revisionWorkspace.requestPreview(sessionId, requestId)
        }
        target="world-revision"
        packageName={worldTitle}
        modelConfigured={modelConfigured}
        hasUnsavedFileDraft={revisionDirty}
        loading={authoring.loading}
        view={panelView}
        history={revisionOverview?.history ?? []}
        latestSessionId={revisionOverview?.latest?.sessionId ?? null}
        notice={authoring.notice}
        requestFailure={authoring.requestFailure}
        syncFailed={authoring.syncFailed}
        syncError={authoring.syncError}
        onRead={() => void revisionWorkspace.reread()}
        now={authoring.now}
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
          dirty: revisionDirty,
          onFilesChange: (files) => revisionWorkspace.editFiles(files),
          onSave: () => void revisionWorkspace.saveFiles(),
          onReset: () => revisionWorkspace.resetFiles(),
          onCopy: () => undefined,
          onExport: () => undefined,
          onDelete: () => undefined,
          title: worldTitle,
          onRename: () => undefined,
        }}
        {...(authoring.target === null ||
        protagonistRevision === undefined ||
        protagonistRevision.started
          ? {}
          : {
              initialMessage: protagonistRevision.message,
              onInitialMessageStarted: () => {
                onProtagonistRevisionStarted?.();
                revisionWorkspace.startFresh();
              },
            })}
        onSend={(message, requestId) =>
          revisionWorkspace.send(message, requestId)
        }
        onEditMessage={(messageId, message, filePolicy, requestId) =>
          revisionWorkspace.editMessage(
            messageId,
            message,
            filePolicy,
            requestId,
          )
        }
        onCancel={() => revisionWorkspace.cancel()}
        onResume={(recovery) => revisionWorkspace.resume(recovery)}
        onFreshContext={() => revisionWorkspace.startFresh()}
        onSelectSession={(id) => revisionWorkspace.selectSession(id)}
        onDeleteSession={(id) => revisionWorkspace.deleteSession(id)}
        onRollbackFile={(id, change, path) =>
          revisionWorkspace.rollbackFile(id, change, path)
        }
        onConfigureModel={onConfigureModel}
        onBack={() => {
          revisionWorkspace.close();
          setDialog(null);
          void refreshWorld(false).catch((reason: unknown) =>
            setFeedback({ kind: "error", text: errorMessage(reason) }),
          );
        }}
        {...(protagonistRevision !== undefined ||
        epoch?.locked === true ||
        (revisionOverview?.sealedEpochs.length ?? 0) > 0
          ? {
              revisionActions: {
                active: epoch?.locked === true,
                ...(protagonistRevision === undefined
                  ? {}
                  : { applyLabel: uiText("应用并开始游玩") }),
                changedFileCount: epoch?.diff.length ?? 0,
                canApply:
                  epoch?.locked === true &&
                  modelConfigured &&
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
          <nav
            className="world-floating-chrome world-floating-chrome-left"
            aria-label={uiText("世界与状态")}
          >
            {showWorkspaceBack && (
              <button
                type="button"
                onClick={onBack}
                aria-label={uiText("返回工作区")}
              >
                ←
              </button>
            )}
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
              onClick={(event) => openPlayDialog("manage", event.currentTarget)}
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
                <>
                  <SyncNotice
                    failed={earlierTimelineFailed}
                    reason={earlierTimelineError}
                    onRead={() => void earlierTimelineTarget.recover()}
                  />
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
                  retries={activeModelRetries}
                  progress={playProgress}
                  now={playProgressNow}
                  onCancel={() => void cancelPlayGeneration()}
                />
              )}
              <div ref={historyEndRef} />
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
            </article>
          </section>

          <footer ref={composerRef} className="world-composer-dock">
            <ArtifactExtensionMount mount="composer_above" />
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
                <p>{uiText("需要先配置模型连接才能游玩。")}</p>
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
            {turnNoteOpen ? (
              <div className="world-turn-note">
                <div className="world-turn-note-field">
                  <span>{uiText("本轮")}</span>
                  <input
                    ref={turnNoteInputRef}
                    type="text"
                    aria-label={uiText("本轮临时要求内容")}
                    value={turnNote}
                    placeholder={uiText("只对这一轮生效，不进入故事")}
                    disabled={
                      pending !== null ||
                      !modelConfigured ||
                      activeStatus === "running" ||
                      worldRevisionLocked
                    }
                    onChange={(event) =>
                      setTurnNote(
                        event.currentTarget.value.replace(/[\r\n]/gu, ""),
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        composerTextareaRef.current?.focus();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setTurnNoteOpen(false);
                        composerTextareaRef.current?.focus();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="world-turn-note-clear"
                    aria-label={uiText("清空并收起本轮临时要求")}
                    disabled={
                      pending !== null ||
                      !modelConfigured ||
                      activeStatus === "running" ||
                      worldRevisionLocked
                    }
                    onClick={() => {
                      setTurnNote("");
                      setTurnNoteOpen(false);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {turnNote.length > turnGuideLineSoftLimit ? (
                  <span className="field-note" role="status">
                    {uiText("超过 120 字；仍会发送，但请尽量简短。")}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="world-composer-row">
              <details className="world-composer-mode">
                <summary aria-label={uiText("选择提交方式")}>＋</summary>
                <div>
                  <button
                    type="button"
                    aria-labelledby={submissionModeId + "-append"}
                    aria-describedby={submissionModeId + "-append-description"}
                    disabled={!canAppend || !modelConfigured}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void submitPlayChain("append");
                    }}
                  >
                    <strong id={submissionModeId + "-append"}>
                      {uiText("接着当前对话继续")}
                    </strong>
                    <span id={submissionModeId + "-append-description"}>
                      {uiText("保留原生对话，重新编译当前提示和材料")}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-labelledby={submissionModeId + "-fresh"}
                    aria-describedby={submissionModeId + "-fresh-description"}
                    disabled={!canStartFresh || !modelConfigured}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void submitPlayChain("fresh");
                    }}
                  >
                    <strong id={submissionModeId + "-fresh"}>
                      {uiText("用新对话继续（保留故事进度）")}
                    </strong>
                    <span id={submissionModeId + "-fresh-description"}>
                      {uiText("从当前世界重新编译材料")}
                    </span>
                  </button>
                </div>
              </details>
              <button
                type="button"
                className={
                  turnNote === ""
                    ? "world-turn-note-toggle"
                    : "world-turn-note-toggle has-text"
                }
                aria-label={uiText("本轮临时要求")}
                aria-pressed={turnNoteOpen}
                title={uiText("只对这一轮生效，不进入故事")}
                disabled={
                  pending !== null ||
                  !modelConfigured ||
                  activeStatus === "running" ||
                  worldRevisionLocked
                }
                onClick={() => setTurnNoteOpen((open) => !open)}
              >
                ✎
              </button>
              <button
                type="button"
                className="world-turn-note-shortcut"
                disabled={!playIdle || !modelConfigured}
                onClick={() => {
                  const note = uiText(
                    "这段就在这里收尾，保存后续需要的信息，并登记检查点。",
                  );
                  setTurnNote((current) =>
                    current.includes(note)
                      ? current
                      : current.trim() === ""
                        ? note
                        : `${current} ${note}`,
                  );
                  setTurnNoteOpen(true);
                  turnNoteInputRef.current?.focus();
                }}
              >
                {uiText("在此收尾")}
              </button>
              <label>
                <span className="visually-hidden">{uiText("你的行动")}</span>
                <textarea
                  ref={composerTextareaAttach}
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
                  enterKeyHint="enter"
                  title={uiText(
                    composer.enterInsertsNewline
                      ? "回车换行，点击发送按钮发送"
                      : "Enter 发送，Shift + Enter 换行",
                  )}
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
            {readingPreferences.showTechnicalInfo ? (
              <p className="world-composer-hint">
                {uiText(
                  activeCanRetry
                    ? "原样重试使用已保存请求，不采用新编排方案。"
                    : "正常发送和空输入续写使用最新编排方案；本轮工具执行期间保持不变。",
                )}
              </p>
            ) : null}
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
                    runtimeFailed ||
                    controlPreviewFailed ||
                    syncFailed
                  }
                  reason={
                    controlPreviewError ??
                    controlError ??
                    runtimeError ??
                    worldSyncError
                  }
                  onRead={() => {
                    if (controlFailed) void controlTarget.recover();
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
                  onChange={() =>
                    setDecorationRevision((current) => current + 1)
                  }
                />
              }
              feedback={feedbackNotice}
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
              onResetControl={() => {
                setControlFiles(JSON.stringify(world.control, null, 2));
                setControlDirty(false);
                setControlPreview(null);
              }}
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
          <ArtifactExtensionMount mount="debug" />
        </div>
      </ArtifactExtensionHost>
    </main>
  );
}

function PlayTimeline({
  activeFailure,
  liveChain,
  failureRecovery,
  client,
  worldId,
  items,
  restartDisabled,
  freshContextDisabled,
  showTechnicalInfo,
  onRestartFrom,
  onEditPlayer,
  onRegeneratePlayer,
  onRegenerateNarrative,
}: {
  client: WorldPageClient;
  worldId: string;
  items: readonly V1PlayTimelineItem[];
  liveChain: V1PlayCallChainView | null;
  activeFailure?: { chainId: string; eventId: number } | undefined;
  failureRecovery?: (PlayFailureRecovery & { chainId: string }) | undefined;
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  showTechnicalInfo: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
  onRegenerateNarrative: (chainId: string, eventId: number) => void;
  onRegeneratePlayer: (
    chainId: string,
    eventId: number,
    originalText: string,
    requiresFreshContext: boolean,
  ) => void;
}): React.JSX.Element {
  const groups = groupPlayTimelineItems(items);
  const latestNarrativeIndex = items.findLastIndex(
    (item) =>
      item.kind === "event" &&
      item.event.kind === "assistant" &&
      item.event.status === "completed" &&
      assistantResponseKind(item.event) === "narrative" &&
      item.event.committedHead !== undefined,
  );
  const latestNarrative = items[latestNarrativeIndex];
  const previousStory =
    latestNarrative?.kind === "event"
      ? items
          .slice(0, latestNarrativeIndex)
          .findLast(
            (item) =>
              item.kind === "event" &&
              item.chainId === latestNarrative.chainId &&
              timelineEventBelongsInStory(item.event),
          )
      : undefined;
  const regeneratePlayer =
    previousStory?.kind === "event" &&
    previousStory.event.kind === "player" &&
    previousStory.event.committedHead !== undefined &&
    previousStory.event.committedHead !== "genesis"
      ? {
          chainId: previousStory.chainId,
          event: previousStory.event,
          requiresFreshContext: previousStory.requiresFreshContext,
        }
      : undefined;
  const lastActiveItem = items.findLast(
    (item) =>
      item.kind === "event" && item.chainId === failureRecovery?.chainId,
  );
  return (
    <ol
      className="call-chain-events play-timeline-events"
      aria-label={uiText("模型调用链")}
    >
      {groups.map((group) => {
        if (group.kind === "turn") {
          return (
            <Fragment key={group.key}>
              {group.items.map((item) =>
                item.event.kind !== "followup" &&
                timelineEventBelongsInStory(item.event) &&
                (item.event.kind !== "failure" ||
                  (activeFailure?.chainId === item.chainId &&
                    activeFailure.eventId === item.event.id)) ? (
                  <TimelineEvent
                    key={`${item.chainId}:${item.event.id}`}
                    client={client}
                    worldId={worldId}
                    chainId={item.chainId}
                    event={item.event}
                    requiresFreshContext={item.requiresFreshContext}
                    restartDisabled={restartDisabled}
                    freshContextDisabled={freshContextDisabled}
                    showTechnicalInfo={showTechnicalInfo}
                    onRestartFrom={onRestartFrom}
                    onEditPlayer={onEditPlayer}
                    onRegenerateNarrative={
                      item === latestNarrative
                        ? () =>
                            onRegenerateNarrative(item.chainId, item.event.id)
                        : undefined
                    }
                    onRegenerate={
                      item === latestNarrative && regeneratePlayer !== undefined
                        ? () =>
                            onRegeneratePlayer(
                              regeneratePlayer.chainId,
                              regeneratePlayer.event.id,
                              regeneratePlayer.event.text,
                              item.requiresFreshContext === true ||
                                regeneratePlayer.requiresFreshContext ===
                                  true ||
                                (item.event.kind === "assistant" &&
                                  item.event.continuation === "unavailable"),
                            )
                        : undefined
                    }
                    failureRecovery={
                      lastActiveItem === item ? failureRecovery : undefined
                    }
                  />
                ) : null,
              )}
              {Array.from(
                new Set(
                  group.items
                    .filter(
                      (item) =>
                        item.event.kind === "followup" && item.event.failed,
                    )
                    .map((item) =>
                      item.event.kind === "followup"
                        ? `${item.chainId}:${item.event.replyEventId ?? "legacy"}`
                        : "",
                    ),
                ),
              ).map((key) => {
                const failed = group.items.filter(
                  (item) =>
                    item.event.kind === "followup" &&
                    item.event.failed &&
                    `${item.chainId}:${item.event.replyEventId ?? "legacy"}` ===
                      key,
                );
                return (
                  <li
                    key={`failed-followups:${key}`}
                    className="call-chain-followup-summary"
                  >
                    <details>
                      <summary>
                        {uiText("{count} 个后置请求未完成", {
                          count: failed.length,
                        })}
                      </summary>
                      <ol>
                        {failed.map((item) => (
                          <TimelineEvent
                            key={`${item.chainId}:${item.event.id}`}
                            client={client}
                            worldId={worldId}
                            chainId={item.chainId}
                            event={item.event}
                            restartDisabled={restartDisabled}
                            freshContextDisabled={freshContextDisabled}
                            showTechnicalInfo={showTechnicalInfo}
                            onRestartFrom={onRestartFrom}
                            onEditPlayer={onEditPlayer}
                          />
                        ))}
                      </ol>
                    </details>
                  </li>
                );
              })}
              {showTechnicalInfo ? (
                <PlayTurnCallDetails
                  items={group.items}
                  worldId={worldId}
                  liveChain={liveChain}
                  request={(request) => requestRuntime(client, request)}
                />
              ) : null}
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
              {showTechnicalInfo ? (
                <>
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
                </>
              ) : null}
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
  // Only tabletop resolutions are story material; other tool results stay in the trace.
  if (event.kind === "tool_result") return event.resolution !== undefined;
  if (event.kind !== "assistant") return false;
  return (
    event.status === "streaming" || assistantResponseKind(event) === "narrative"
  );
}

function TimelineEvent({
  failureRecovery,
  client,
  worldId,
  chainId,
  event,
  requiresFreshContext = false,
  restartDisabled,
  freshContextDisabled,
  showTechnicalInfo,
  onRestartFrom,
  onEditPlayer,
  onRegenerate,
  onRegenerateNarrative,
}: {
  client: WorldPageClient;
  worldId: string;
  chainId: string;
  event: V1PlayTimelineEventSummary;
  requiresFreshContext?: boolean | undefined;
  failureRecovery?: PlayFailureRecovery | undefined;
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  showTechnicalInfo: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
  onRegenerate?: (() => void) | undefined;
  onRegenerateNarrative?: (() => void) | undefined;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<V1PlayCallChainEvent | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [revisionContinuation, setRevisionContinuation] =
    useState<PlayerRevisionContinuation>("continue_context");
  const eventId = event.id;
  const {
    target: detailTarget,
    syncFailed: detailFailed,
    syncError: detailError,
  } = useReadTarget(
    useCallback(
      () =>
        requestRuntime<V1PlayCallChainEvent>(client, {
          type: "play.timeline.detail",
          worldId,
          chainId,
          eventId,
        }),
      [client, worldId, chainId, eventId],
    ),
    useCallback((value: V1PlayCallChainEvent) => setDetail(value), []),
  );
  const loadDetail = async (): Promise<void> => {
    if (detail !== null || detailPending) return;
    setDetailPending(true);
    await detailTarget.read();
    setDetailPending(false);
  };

  if (event.kind === "player")
    return (
      <li className="call-chain-player">
        <article>
          <header>
            <strong>{uiText("玩家")}</strong>
            {showTechnicalInfo ? (
              <span>
                {event.context === "fresh"
                  ? uiText("全新上下文")
                  : uiText("追加上下文")}
              </span>
            ) : null}
            {event.committedHead === undefined ? null : (
              <span className="history-message-actions">
                {event.committedHead === "genesis" ? null : (
                  <button
                    type="button"
                    className="history-restart-button"
                    disabled={restartDisabled}
                    onClick={() => {
                      setEditedText(event.text);
                      setRevisionContinuation(
                        requiresFreshContext
                          ? "fresh_context"
                          : "continue_context",
                      );
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
                  "保存修改会永久删除这条原消息及之后的故事、模型对话和产物，并撤销从这条消息起的世界改动。此前的历史会保留。",
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
                    disabled={restartDisabled || requiresFreshContext}
                    onChange={() => setRevisionContinuation("continue_context")}
                  />
                  <span>
                    <strong>{uiText("接着原对话继续")}</strong>
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
                    <strong>{uiText("用新对话继续")}</strong>
                    <small>
                      {uiText("修改稿会成为新对话的第一条玩家消息。")}
                    </small>
                  </span>
                </label>
                {requiresFreshContext ? (
                  <p>
                    {uiText(
                      "此上下文来自备份；修改后须以本机选择开启全新上下文。",
                    )}
                  </p>
                ) : null}
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
                    ? uiText("保存修改并用新对话继续")
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
    const responseKind = assistantResponseKind(event);
    const responseClass =
      responseKind === "tool_step" ? "tool-step" : responseKind;
    return (
      <li
        className={`call-chain-assistant is-${event.status} is-${responseClass}`}
      >
        <article>
          <header>
            {showTechnicalInfo ? (
              <>
                <strong>
                  {event.status === "streaming"
                    ? uiText("模型响应中")
                    : responseKind === "tool_step"
                      ? uiText("模型工具步骤")
                      : responseKind === "empty"
                        ? uiText("空模型响应")
                        : uiText("AI 响应")}
                </strong>
                <span>{callChainAssistantStatusLabel(event.status)}</span>
              </>
            ) : event.status === "interrupted" ? (
              <strong>{uiText("中断片段")}</strong>
            ) : null}
            {event.committedHead === undefined ? null : (
              <span className="history-message-actions">
                {onRegenerateNarrative === undefined ? null : (
                  <button
                    type="button"
                    className="history-restart-button"
                    disabled={restartDisabled || freshContextDisabled}
                    onClick={onRegenerateNarrative}
                  >
                    {uiText("只重新生成叙事")}
                  </button>
                )}
                {onRegenerate === undefined ? null : (
                  <button
                    type="button"
                    className="history-restart-button"
                    disabled={restartDisabled}
                    onClick={onRegenerate}
                  >
                    {uiText("重新生成")}
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
          {event.committedHead !== undefined ? (
            <ArtifactExtensionMount
              mount="story"
              reply={{ chainId, eventId: event.id }}
            />
          ) : null}
          {responseKind === "pending" ? (
            <small>{uiText("待定输出；响应完成前不会进入故事")}</small>
          ) : null}
          {showTechnicalInfo &&
          event.checkpoint === true &&
          event.status === "completed" &&
          responseKind === "narrative" ? (
            <small className="play-checkpoint-marker">{uiText("检查点")}</small>
          ) : null}
        </article>
      </li>
    );
  }

  if (event.kind === "tool_call") return null;
  if (event.kind === "tool_result")
    return event.resolution === undefined ? null : (
      <li className="call-chain-resolution">
        <ResolutionCard receipt={event.resolution} />
      </li>
    );

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
          <SyncNotice
            failed={detailFailed}
            reason={detailError}
            onRead={() => void detailTarget.recover()}
          />
          {full?.failure === undefined ? null : <p>{full.failure}</p>}
          <ModelRetryStatus
            retries={full?.retries ?? event.retries}
            active={event.status === "streaming"}
          />
        </details>
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
      <PlayFailureNotice
        failureKind={event.failureKind}
        canRetry={failureRecovery?.canRetry ?? false}
        message={event.message}
        recovery={failureRecovery}
      />
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

function requestRuntime<T>(
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

function projectPlayContextUsage(
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

function applyPlayTimelineFrame(
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

async function requestPlayDecorations(
  client: WorldPageClient,
  worldId: string,
): Promise<WorldPlayDecorationsView> {
  const result = await client.request({
    type: "world.play-decorations.read",
    worldId,
  });
  return result as WorldPlayDecorationsView;
}
