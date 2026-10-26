import { projectLegacyModelBindingFailure } from "./LegacyModelBindingFailure.ts";
import {
  dispatchFailureEnding,
  emptyResponseEnding,
  lastEndingCancelled,
  noContinuationEnding,
  PlayAdvanceLifecycle,
  settlementFailureEnding,
} from "./PlayAdvanceLifecycle.ts";
import {
  isResolutionTool,
  resolutionMarkdown,
  resolutionToolNames,
  resolveTabletop,
  seededRandom,
  type ResolutionToolName,
} from "./TabletopResolution.ts";
import {
  captureNarrativeOrigin,
  snapshotBackground,
  narrativeBackground,
  type HistoryBackground,
} from "../history/HistoryBackground.ts";
import { isDeepStrictEqual } from "node:util";
import { hasLegacyHistoryTools } from "../prompt/FileNativeToolRegistry.ts";
import {
  renderToolAliasNote,
  resolveToolName,
} from "../prompt/ToolNameAlias.ts";
import { PlayCallChainError } from "./PlayCallChainError.ts";
import {
  preparePlayerRevisionTrace,
  prepareForkTrace,
  restorePlayDocuments,
  independentContextCopy,
} from "./PlayTraceRetention.ts";
import {
  cloneSharingPromptRuns,
  currentPlayPrompt,
  recordedPlayPrompt,
  playPromptRunsThroughEvents,
  promptRunStrings,
  sharePromptRun,
} from "./PlayPromptRun.ts";
import { comparePromptPrefixes } from "../prompt/WorldPromptDiagnostics.ts";
import { createHash, randomBytes } from "node:crypto";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import { isTurnGuideLine } from "../../shared/ordered-play-prompts.ts";
import { turnGuideWithTurnNote } from "../../shared/turn-guide.ts";
import {
  completedPlayerRounds,
  continuationNotice,
  playerInputAppend,
  toolStepNotice,
  turnGuideNotice,
  type NarrativeCheckpoint,
} from "./PlayContinuity.ts";
import {
  renderWriteSizeAdvice,
  readDeclaredWorldClock,
} from "../prompt/WorldMaintenanceReport.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";

import type {
  V1PlayCallChainContextView,
  V1PlayCallChainEvent,
  V1PlayCallChainView,
  V1PlayContextReadingView,
  V1PlayRunProgress,
} from "../../protocol/v1.ts";
import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostExchange,
  ModelHostResponse,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import {
  equalModelHostBinding,
  ModelHostCancelledError,
} from "../model/ModelHost.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
  type PlayPresetCompilation,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativePlayBinding,
  FileNativeRecoveredEndpoint,
  FileNativeStateChange,
  FileNativeWorldSummary,
  FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";
import type { ArtifactStore } from "../artifact/FileNativeArtifactStore.ts";
import {
  parsePlayPresetFiles,
  type PlayPresetBinding,
  type FrozenArtifactPresentation,
} from "./FileNativePlayPresetStore.ts";
import {
  runPlayFollowupRequests,
  type PlayFollowupObserver,
  type PlayFollowupOutcome,
} from "./PlayFollowupRequests.ts";
import {
  FileNativePlayDocuments,
  fingerprintControl,
  type PlayDocumentToolResult,
} from "./PlayDocumentTools.ts";
import type { AiFailureRecorder } from "../model/AiFailureLog.ts";
import type {
  PersistedCompletedToolCall,
  PersistedPlayCallChain,
  PersistedPlayCallChainContext,
  PlayContextPersistenceCursor,
} from "./FileNativePlayTimelineStore.ts";
import type {
  PlayAdvanceBase,
  PlayerAdvance,
} from "./FileNativePlayAdvanceStore.ts";

const callChainToolNames = new Set([
  ...resolutionToolNames,
  "state_list",
  "history_list",
  "history_search",
  "history_read",
  // Kept executable only for contexts whose frozen tool universe contains it.
  "context_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
  "world_retire",
  "world_checkpoint",
]);
const projectedEventTail = 40;

type CompletedToolCall = PersistedCompletedToolCall;

interface PlayCallChainSession extends PersistedPlayCallChain {
  narrativeCheckpoint?: NarrativeCheckpoint | undefined;
  documents: FileNativePlayDocuments;
  history: { path: string; contents: string; background?: HistoryBackground }[];
  completedToolMap: Map<string, CompletedToolCall>;
  persistenceCursor: PlayContextPersistenceCursor;
}

interface PreparedToolResult {
  call: ModelHostToolCall;
  key: string;
  result: PlayDocumentToolResult;
  replayed: boolean;
  event: Extract<V1PlayCallChainEvent, { kind: "tool_result" }>;
  transcript: Extract<ModelHostAppendItem, { kind: "tool" }>;
}

/** How a settled response leaves its exchange: finished, or continued by a frozen tool-step request. */
type ResponseSettlement =
  | { kind: "terminal"; status: "ready" | "interrupted"; narrative: boolean }
  | { kind: "continue"; nextRequest: ModelHostExchange };

interface PlayCallChainStartInput {
  worldId: string;
  chainId: string;
  exchangeId: string;
  playerText: string;
  /** The player's one-turn request line; never part of the bootstrap or transcript. */
  turnNote?: string;
  hostBinding: FileNativePromptInput["hostBinding"];
  playPreset: PlayPresetBinding;
  modelBinding: ModelHostBinding;
  modelHost: ModelHost;
  observer?: PlayCallChainObserver;
}

interface PlayCallChainAppendInput {
  resolvePrompt?: () => Promise<
    Pick<PlayCallChainStartInput, "hostBinding" | "playPreset">
  >;
  worldId: string;
  chainId: string;
  exchangeId: string;
  playerText: string;
  turnNote?: string;
  modelHost: ModelHost;
  observer?: PlayCallChainObserver;
}

interface PlayCallChainRevisionBaseInput {
  operationId: string;
  worldId: string;
  chainId: string;
  eventId: number;
  replacementExchangeId: string;
  replacementText: string;
  turnNote?: string;
}

type PlayCallChainRevisionInput = PlayCallChainRevisionBaseInput &
  (
    | { continuation: "continue_context" }
    | {
        continuation: "fresh_context";
        freshContext: Pick<
          PlayCallChainStartInput,
          "hostBinding" | "playPreset" | "modelBinding"
        >;
      }
  );

/** A compiled fresh context, with its documents bound to the bootstrap. */
interface FreshContextCompilation {
  documents: FileNativePlayDocuments;
  bootstrap: PromptCompilation;
  tools: PromptCompilation["tools"];
  followups: PlayPresetCompilation["followups"];
}

interface PreparedFreshPlayerRevision {
  binding: FileNativePlayBinding;
  bootstrap: PromptCompilation;
  tools: PromptCompilation["tools"];
  followups: PlayPresetCompilation["followups"];
}

type PlayerRevisionFreshContext = Pick<
  PlayCallChainStartInput,
  "hostBinding" | "playPreset" | "modelBinding"
>;

/**
 * The durable record of an edit in progress, written before the first world
 * change so an interrupted edit resumes through the same steps (ADR-0044).
 */
interface PlayerRevisionIntent {
  schemaVersion: 1;
  kind: "player_revision_intent";
  operationId: string;
  worldId: string;
  chainId: string;
  eventId: number;
  replacementExchangeId: string;
  replacementText: string;
  turnNote?: string;
  continuation: PlayCallChainRevisionInput["continuation"];
  restoresHead: string;
  /** Contexts from the edited one onward; a rewind discards them from disk. */
  discardChainIds: string[];
  freshContext?: PlayerRevisionFreshContext;
}

function isPlayerRevisionIntent(value: unknown): value is PlayerRevisionIntent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    record.kind === "player_revision_intent" &&
    typeof record.operationId === "string" &&
    typeof record.worldId === "string" &&
    typeof record.chainId === "string" &&
    Number.isSafeInteger(record.eventId) &&
    typeof record.replacementExchangeId === "string" &&
    typeof record.replacementText === "string" &&
    (record.continuation === "continue_context" ||
      record.continuation === "fresh_context") &&
    typeof record.restoresHead === "string" &&
    (record.continuation === "continue_context" ||
      typeof record.freshContext === "object")
  );
}

/**
 * Play sessions kept in memory at once, one per most recently used world. An
 * idle session beyond this is released and reloaded from disk on next use,
 * which behaves like a process restart (ADR-0044). Not a user setting.
 */
const residentWorldLimit = 3;

interface ActivePlayInvocation extends V1PlayRunProgress {
  worldId: string;
  controller: AbortController;
  /** False once a complete Provider result has entered durable settlement. */
  abortable: boolean;
}

export { PlayCallChainError } from "./PlayCallChainError.ts";

export interface PlayCallChainObserver {
  onSnapshot?: (view: V1PlayCallChainView) => void;
  onAssistantDelta?: (delta: {
    eventId: number;
    kind: "reasoning" | "text" | "tool";
    text: string;
    updatedAt: number;
  }) => void;
}

/**
 * The production play loop: one durable logical context, no Runtime-authored
 * adjudication/narration phases. Responses with tool calls are intermediate
 * tool steps: their Provider-native payload remains appendable, while only
 * their world changes may advance Authority. A tool-free response is the sole
 * response shape whose non-empty text can become committed narrative.
 */
export class PlayCallChain {
  readonly changed: (worldId: string) => void;
  readonly #worlds: FileNativeWorldStore;
  readonly #compiler: FileNativePromptCompiler;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #active = new Map<string, PlayCallChainSession>();
  readonly #worldChains = new Map<string, string>();
  /** One in-flight disk hydration per world; concurrent callers share it. */
  readonly #hydrating = new Map<
    string,
    { token: symbol; session: Promise<PlayCallChainSession | null> }
  >();
  readonly #loadedCursors = new Map<string, PlayContextPersistenceCursor>();
  readonly #activeInvocations = new Map<string, ActivePlayInvocation>();
  /** Resolves when the matching invocation has left the active table. */
  readonly #invocationSettled = new Map<string, Promise<void>>();
  /** Worlds whose release is queued in their WorldQueue slot. */
  readonly #releasing = new Set<string>();
  readonly #advances: PlayAdvanceLifecycle<PlayCallChainSession>;

  constructor(
    worlds: FileNativeWorldStore,
    compiler: FileNativePromptCompiler = new FileNativePromptCompiler(),
    artifacts?: ArtifactStore,
    failureLog?: AiFailureRecorder,
    changed: (worldId: string) => void = () => {
      /* No observers attached. */
    },
  ) {
    this.changed = changed;
    this.#worlds = worlds;
    this.#compiler = compiler;
    this.#artifacts = artifacts;
    this.#failureLog = failureLog;
    this.#advances = new PlayAdvanceLifecycle<PlayCallChainSession>({
      persist: (session) => this.#persist(session),
      clearMarker: (advance) => this.#worlds.playAdvances.markSettled(advance),
    });
  }

  async start(input: PlayCallChainStartInput): Promise<V1PlayCallChainView> {
    return this.#runInvocation(input, (signal) => this.#start(input, signal));
  }

  async #start(
    input: PlayCallChainStartInput,
    signal: AbortSignal,
  ): Promise<V1PlayCallChainView> {
    validateIdentity(input.chainId, "call-chain ID");
    validateIdentity(input.exchangeId, "exchange ID");
    validatePlayerText(input.playerText);
    validTurnNote(input.turnNote);
    assertModelHostBinding(input.modelBinding, input.modelHost);

    // Only a resubmission to the current context needs that context loaded.
    await this.#worlds.ensureCurrentStorage(input.worldId);
    const outline = await this.#worlds.playTimeline.readTimelineOutline(
      input.worldId,
    );
    const existing =
      outline?.chainIds.at(-1) === input.chainId
        ? await this.#readPersisted(input.worldId)
        : null;
    if (existing?.chainId === input.chainId) {
      const duplicate = duplicatePlayerExchange(
        existing,
        input.exchangeId,
        input.playerText,
        "fresh",
      );
      if (duplicate) return projectView(existing);
    }
    const activeId = this.#worldChains.get(input.worldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active?.status === "running")
      throw new PlayCallChainError(
        "A model request is still running for this world.",
      );

    const binding = await this.#worlds.bindPlayCallChain(input.worldId);
    const fresh = await this.#compileFreshContext(input.worldId, binding, {
      hostBinding: input.hostBinding,
      playPreset: input.playPreset,
      modelBinding: input.modelBinding,
      playerText: input.playerText,
    });
    const now = Date.now();
    const session: PlayCallChainSession = {
      schemaVersion: 3,
      kind: "play_call_chain",
      chainId: input.chainId,
      continuityContextId: input.chainId,
      worldId: input.worldId,
      previousContexts: [],
      previousChainId: outline?.chainIds.at(-1) ?? null,
      timelineGeneration:
        outline?.generation ?? this.#worlds.playTimeline.newGeneration(),
      baselineHead: binding.parentHead,
      baselineHistoryLength: Object.keys(binding.history).length,
      parentHead: binding.parentHead,
      playPreset: {
        id: input.playPreset.id,
        name: input.playPreset.name,
        revision: input.playPreset.revision,
      },
      followups: fresh.followups,
      playPresetScriptsEnabled: input.playPreset.scriptsEnabled,
      presetFiles: structuredClone(input.playPreset.files),
      modelBinding: structuredClone(input.modelBinding),
      status: "ready",
      canRetry: false,
      bootstrap: fresh.bootstrap,
      tools: fresh.tools,
      ...turnNoteField(validTurnNote(input.turnNote)),
      transcript: [],
      events: [],
      completedTools: [],
      changedDocuments: [],
      nextMaterials: structuredClone(binding.additionalMaterials),
      nextEventId: 1,
      exchange: 0,
      lastRequest: null,
      lastRequestAttempt: 0,
      lastFailure: null,
      updatedAt: now,
      documents: fresh.documents,
      history: historyEntries(binding.history, binding.historyBackgrounds),
      narrativeCheckpoint: binding.narrativeCheckpoint,
      completedToolMap: new Map(),
      persistenceCursor: {
        eventCount: 0,
        transcriptCount: 0,
        completedToolCount: 0,
      },
    };
    if (activeId !== undefined) this.#active.delete(activeId);
    this.#registerResident(session);
    await this.#persist(session);
    await this.#worlds.completeArchiveFreshContext(session.worldId);
    return this.#submitPlayer(
      session,
      input.exchangeId,
      input.playerText,
      "fresh",
      input.modelHost,
      signal,
      input.observer,
    );
  }

  /**
   * Compiles a fresh context's input and binds its documents to the bootstrap.
   * Starting a context and a player revision that begins one both come through
   * here; they differ only in the world binding they read. A continuing context
   * compiles against its frozen world context instead (`#refreshPrompt`).
   */
  async #compileFreshContext(
    worldId: string,
    binding: FileNativePlayBinding,
    input: {
      hostBinding: FileNativePromptInput["hostBinding"];
      playPreset: PlayPresetBinding;
      modelBinding: ModelHostBinding;
      playerText: string;
    },
  ): Promise<FreshContextCompilation> {
    const documents = new FileNativePlayDocuments(binding.files);
    const documentMaintenance = await this.#bindDocumentMaintenance(
      documents,
      worldId,
      binding.parentHead,
    );
    const compilation = this.#compiler.compilePlayCallChain(
      {
        extensionControls: await this.#worlds.extensionControls(
          worldId,
          input.playPreset,
          this.#compiler.locale,
        ),
        endpoint: {
          id: `${worldId}:${binding.parentHead}`,
          commit: binding.parentHead,
        },
        hostBinding: structuredClone(input.hostBinding),
        world: {
          controlFingerprint: fingerprintControl(binding.files),
          documentSnapshot: documents.snapshot,
          additionalMaterials: structuredClone(binding.additionalMaterials),
          history: structuredClone(binding.history),
          historyBackgrounds: structuredClone(binding.historyBackgrounds ?? {}),
          narrativeCheckpoint: binding.narrativeCheckpoint,
          documentMaintenance,
          documentMaintenanceUnavailableReason: documents.maintenanceWarning,
        },
        playerInputPlacement: "append",
        playerInput: input.playerText,
        modelBinding: structuredClone(input.modelBinding),
      },
      input.playPreset,
    );
    const bootstrap: PromptCompilation = structuredClone(compilation.bootstrap);
    documents.bindBootstrap(bootstrap);
    return {
      documents,
      bootstrap,
      tools: structuredClone(compilation.toolUniverse),
      followups: structuredClone(compilation.followups ?? []),
    };
  }

  async append(input: PlayCallChainAppendInput): Promise<V1PlayCallChainView> {
    return this.#runInvocation(input, (signal) => this.#append(input, signal));
  }

  async #append(
    input: PlayCallChainAppendInput,
    signal: AbortSignal,
  ): Promise<V1PlayCallChainView> {
    validateIdentity(input.exchangeId, "exchange ID");
    if (await this.#worlds.archiveNeedsFreshContext(input.worldId))
      throw new PlayCallChainError(
        "This world was imported from a backup; start a fresh context before continuing.",
      );
    const session = await this.#requireChain(input.worldId, input.chainId);
    await this.#assertCurrentHead(session);
    assertSessionModelHostBinding(session, input.modelHost);
    if (input.playerText.trim().length === 0) {
      if (session.status === "running")
        throw new PlayCallChainError("A model request is still running.");
      if (session.status === "interrupted") {
        if (!session.canRetry || session.lastRequest === null)
          throw new PlayCallChainError(
            "The current model context cannot continue; use a fresh context.",
          );
        // Pre-snapshot requests have only a binding fingerprint. Do not invent
        // their original encoding settings from a newly selected connection.
        if (
          session.lastRequest.modelConfig === undefined &&
          !equalModelHostBinding(
            session.modelBinding!,
            input.modelHost.binding(),
          )
        )
          throw new PlayCallChainError(
            "This older saved request has no model configuration snapshot. Restore its original settings to retry it, or start a fresh context.",
          );
        return this.#dispatch(
          session,
          input.modelHost,
          structuredClone(session.lastRequest),
          session.lastRequestAttempt + 1,
          signal,
          input.observer,
        );
      }
      await this.#refreshPrompt(session, input);
      // Each dispatch carries exactly the request the client sent with it; a
      // continuation without one must not inherit the previous turn's line.
      setTurnNote(session, validTurnNote(input.turnNote));
      session.exchange += 1;
      const last = session.transcript.at(-1);
      if (
        last?.kind === "assistant" &&
        last.toolCalls.length === 0 &&
        last.text.trim().length > 0
      ) {
        session.narrativeOrigin = await this.#captureOrigin(session);
        session.transcript.push(continuationNotice(this.#compiler.locale));
      }
      return this.#dispatch(
        session,
        input.modelHost,
        createRequest(
          session,
          input.modelHost,
          session.exchange,
          this.#compiler.locale,
        ),
        1,
        signal,
        input.observer,
      );
    }
    if (
      duplicatePlayerExchange(
        session,
        input.exchangeId,
        input.playerText,
        "append",
      )
    )
      return projectView(session);
    if (session.status !== "ready")
      throw new PlayCallChainError(
        session.canRetry
          ? "The call chain has an incomplete model response; clear the input and append a continuation, or use a fresh context."
          : "The call chain was interrupted; use a fresh context.",
      );
    await this.#refreshPrompt(session, input);
    setTurnNote(session, validTurnNote(input.turnNote));
    return this.#submitPlayer(
      session,
      input.exchangeId,
      input.playerText,
      "append",
      input.modelHost,
      signal,
      input.observer,
    );
  }

  async #refreshPrompt(
    session: PlayCallChainSession,
    input: PlayCallChainAppendInput,
  ): Promise<void> {
    if (input.resolvePrompt === undefined) return;
    const { hostBinding, playPreset } = await input.resolvePrompt();
    const binding = await this.#worlds.bindPlayCallChain(input.worldId);
    const compilation = this.#compiler.compilePlayCallChain(
      {
        frozenWorldContext: currentPlayPrompt(session).bootstrap,
        extensionControls: await this.#worlds.extensionControls(
          input.worldId,
          playPreset,
          this.#compiler.locale,
        ),
        endpoint: {
          id: `${input.worldId}:${binding.parentHead}`,
          commit: binding.parentHead,
        },
        hostBinding,
        world: {
          controlFingerprint: fingerprintControl(binding.files),
          documentSnapshot: session.documents.snapshot,
          additionalMaterials: structuredClone(binding.additionalMaterials),
          history: structuredClone(binding.history),
          historyBackgrounds: structuredClone(binding.historyBackgrounds ?? {}),
          narrativeCheckpoint: binding.narrativeCheckpoint,
        },
        playerInputPlacement: "append",
        playerInput: input.playerText,
        modelBinding: input.modelHost.binding(),
      },
      playPreset,
    );
    // The native conversation already contains successful writes and exact reads.
    // Rebinding initial coverage here would incorrectly reauthorize stale scopes.
    session.history = historyEntries(
      binding.history,
      binding.historyBackgrounds,
    );
    session.narrativeCheckpoint = binding.narrativeCheckpoint;
    session.nextMaterials = structuredClone(binding.additionalMaterials);
    const previousRun = session.promptRuns?.at(-1);
    (session.promptRuns ??= []).push(
      sharePromptRun(
        {
          schemaVersion: 1,
          firstEventId: session.nextEventId,
          head: binding.parentHead,
          exchange: session.exchange + 1,
          playPreset: {
            id: playPreset.id,
            name: playPreset.name,
            revision: playPreset.revision,
          },
          bootstrap: structuredClone(compilation.bootstrap),
          tools: structuredClone(compilation.toolUniverse),
          followups: structuredClone(compilation.followups ?? []),
          playPresetScriptsEnabled: playPreset.scriptsEnabled,
          presetFiles: structuredClone(playPreset.files),
        },
        promptRunStrings(previousRun),
      ),
    );
    await this.#persist(session);
  }

  cancel(input: { worldId: string; chainId: string; exchangeId: string }): {
    outcome: "cancellation_requested" | "not_running";
  } {
    validateIdentity(input.worldId, "world ID");
    validateIdentity(input.chainId, "call-chain ID");
    validateIdentity(input.exchangeId, "exchange ID");
    const active = this.#activeInvocations.get(input.chainId);
    if (
      active?.worldId !== input.worldId ||
      active?.exchangeId !== input.exchangeId ||
      active?.abortable !== true
    )
      return { outcome: "not_running" };
    if (!active.controller.signal.aborted) {
      active.phase = "cancelling";
      active.lastActivityAt = Date.now();
      active.controller.abort();
    }
    return { outcome: "cancellation_requested" };
  }

  async #runInvocation(
    input: {
      worldId: string;
      chainId: string;
      exchangeId: string;
    },
    run: (signal: AbortSignal) => Promise<V1PlayCallChainView>,
  ): Promise<V1PlayCallChainView> {
    validateIdentity(input.worldId, "world ID");
    validateIdentity(input.chainId, "call-chain ID");
    validateIdentity(input.exchangeId, "exchange ID");
    if (
      this.#activeInvocations.has(input.chainId) ||
      [...this.#activeInvocations.values()].some(
        ({ worldId }) => worldId === input.worldId,
      )
    )
      throw new PlayCallChainError(
        "A model request is already running for this world or call chain.",
      );
    const startedAt = Date.now();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const invocation: ActivePlayInvocation = {
      worldId: input.worldId,
      chainId: input.chainId,
      exchangeId: input.exchangeId,
      phase: "preparing",
      startedAt,
      lastActivityAt: startedAt,
      reasoningChars: 0,
      textChars: 0,
      toolChars: 0,
      toolCalls: 0,
      dispatches: 0,
      controller: new AbortController(),
      abortable: true,
    };
    const controlUseId = operationId(
      input.chainId,
      `control-use:${input.exchangeId}`,
    );
    this.#worlds.freezeControl(input.worldId, controlUseId);
    this.#activeInvocations.set(input.chainId, invocation);
    this.#invocationSettled.set(input.chainId, settled);
    this.#touchWorld(input.worldId);
    this.changed(input.worldId);
    try {
      await this.#worlds.assertWorldRevisionUnlocked(input.worldId);
      return await run(invocation.controller.signal);
    } finally {
      if (this.#activeInvocations.get(input.chainId) === invocation)
        this.#activeInvocations.delete(input.chainId);
      this.#enforceResidentLimit();
      this.#worlds.releaseControl(input.worldId, controlUseId);
      this.changed(input.worldId);
      this.#invocationSettled.delete(input.chainId);
      markSettled();
    }
  }

  #observeInvocation(
    chainId: string,
    phase: Exclude<V1PlayRunProgress["phase"], "cancelling">,
    increments: Partial<
      Pick<
        V1PlayRunProgress,
        | "reasoningChars"
        | "textChars"
        | "toolChars"
        | "toolCalls"
        | "dispatches"
      >
    > = {},
  ): void {
    const active = this.#activeInvocations.get(chainId);
    if (active === undefined || active.phase === "cancelling") return;
    active.phase = phase;
    active.lastActivityAt = Date.now();
    active.reasoningChars += increments.reasoningChars ?? 0;
    active.textChars += increments.textChars ?? 0;
    active.toolChars += increments.toolChars ?? 0;
    active.toolCalls += increments.toolCalls ?? 0;
    active.dispatches += increments.dispatches ?? 0;
    this.changed(active.worldId);
  }

  #setInvocationAbortable(chainId: string, abortable: boolean): void {
    const active = this.#activeInvocations.get(chainId);
    if (active !== undefined) active.abortable = abortable;
  }

  #projectActiveView(session: PersistedPlayCallChain): V1PlayCallChainView {
    const view = projectView(session);
    const active = this.#activeInvocations.get(session.chainId);
    if (active?.worldId !== session.worldId) return view;
    const {
      controller: _controller,
      worldId: _worldId,
      abortable: _abortable,
      ...progress
    } = active;
    void _controller;
    void _worldId;
    void _abortable;
    return { ...view, activeInvocation: structuredClone(progress) };
  }

  #notifySnapshot(
    observer: PlayCallChainObserver | undefined,
    session: PersistedPlayCallChain,
  ): void {
    try {
      this.changed(session.worldId);
      observer?.onSnapshot?.(this.#projectActiveView(session));
    } catch {
      // A browser stream may disconnect while the durable model request keeps
      // running. Presentation failure never cancels or changes play Authority.
    }
  }

  /** Worlds whose play session is held in memory, least recently used first. */
  residentWorldIds(): string[] {
    return [...this.#worldChains.keys()];
  }

  async inspectWorld(worldId: string): Promise<V1PlayCallChainView | null> {
    const session = await this.#worldSession(worldId);
    return session === null ? null : this.#projectActiveView(session);
  }

  /** Browser observation never traverses old contexts. History and completed
   * diagnostics remain behind the paged timeline/detail Interface. */
  async observeWorld(worldId: string): Promise<V1PlayCallChainView | null> {
    const session = await this.#worldSession(worldId);
    if (session === null) return null;
    const view = this.#projectActiveView({ ...session, previousContexts: [] });
    const live = new Map(
      session.events
        .slice(-projectedEventTail)
        .map((event) => [event.id, event]),
    );
    view.events = view.events.map((event) =>
      event.kind === "assistant" && event.status === "streaming"
        ? structuredClone(live.get(event.id)!)
        : event,
    );
    return view;
  }

  /** The live context's frozen binding and transcript, without reloading it. */
  async currentContinuation(worldId: string): Promise<{
    modelBinding: ModelHostBinding | undefined;
    transcript: ModelHostAppendItem[];
  } | null> {
    const session = await this.#worldSession(worldId);
    return session === null
      ? null
      : {
          modelBinding: session.modelBinding,
          transcript: structuredClone(session.transcript),
        };
  }

  async #worldSession(worldId: string): Promise<PlayCallChainSession | null> {
    return this.#loadWorldSession(worldId);
  }

  /**
   * Returns the live session for a world, hydrating it from disk at most once
   * at a time. Concurrent callers share one hydration, so a session object is
   * never replaced by a stale copy that finished hydrating later.
   */
  async #loadWorldSession(
    worldId: string,
  ): Promise<PlayCallChainSession | null> {
    const activeId = this.#worldChains.get(worldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active !== undefined) {
      this.#touchWorld(worldId);
      if (
        this.#activeInvocations.get(active.chainId)?.worldId !== active.worldId
      )
        await this.#reconcileSessionAdvance(active);
      // Released while reconciling: load the current session, not this copy.
      if (this.#active.get(active.chainId) === active) return active;
      return this.#loadWorldSession(worldId);
    }
    const pending = this.#hydrating.get(worldId);
    if (pending !== undefined) return pending.session;
    const token = Symbol(worldId);
    const session = this.#hydrateWorldSession(worldId, token);
    this.#hydrating.set(worldId, { token, session });
    try {
      return await session;
    } finally {
      if (this.#hydrating.get(worldId)?.token === token)
        this.#hydrating.delete(worldId);
    }
  }

  async #hydrateWorldSession(
    worldId: string,
    token: symbol,
  ): Promise<PlayCallChainSession | null> {
    await this.#recoverPlayerRevision(worldId);
    const persisted = await this.#readPersisted(worldId);
    if (persisted === null) return null;
    const advance = await this.#worlds.playAdvances.readCurrent(
      worldId,
      persisted.chainId,
    );
    const hydrated = await this.#hydrateSession(persisted, advance);
    // A live session registered while this disk read was in flight wins.
    const live = this.#active.get(hydrated.chainId);
    if (live !== undefined) return live;
    // forgetWorld ran during hydration; do not resurrect the old session.
    if (this.#hydrating.get(worldId)?.token !== token) return null;
    this.#registerResident(hydrated);
    await this.#reconcileSessionAdvance(hydrated, advance);
    return hydrated;
  }

  async inspectReading(
    worldId: string,
    worldHead: string,
  ): Promise<V1PlayContextReadingView["currentContext"]> {
    const view = await this.inspectWorld(worldId);
    if (view === null) return null;
    const session = this.#active.get(view.chainId);
    if (session === undefined)
      throw new PlayCallChainError(
        "The current play context could not be inspected.",
      );
    const runs = playPromptRunsThroughEvents(session, session.events);
    const latestRun = runs.at(-1);
    const priorRun = runs.at(-2);
    const previousContext =
      latestRun !== undefined || session.previousChainId === null
        ? null
        : await this.#worlds.playTimeline.readContext(
            worldId,
            session.previousChainId,
          );
    const previousContextRun =
      previousContext === null
        ? undefined
        : playPromptRunsThroughEvents(
            previousContext.value,
            previousContext.value.events,
          ).at(-1);
    const previous =
      latestRun !== undefined
        ? (priorRun ?? session)
        : (previousContextRun ?? previousContext?.value ?? null);
    const currentExchange = latestRun?.exchange ?? 1;
    const previousExchange =
      priorRun?.exchange ?? previousContextRun?.exchange ?? 1;
    const [currentEncoding, previousEncoding] = await Promise.all([
      this.#worlds.playTimeline
        .readInitialEncoding(worldId, session.chainId, currentExchange)
        .catch(() => null),
      previous === null
        ? null
        : this.#worlds.playTimeline
            .readInitialEncoding(
              worldId,
              latestRun !== undefined
                ? session.chainId
                : previousContext!.value.chainId,
              previousExchange,
            )
            .catch(() => null),
    ]);
    const usageAt = (events: V1PlayCallChainEvent[], exchange: number) =>
      events.findLast(
        (event) =>
          event.kind === "assistant" &&
          event.status === "completed" &&
          event.exchange === exchange,
      );
    const currentResponse = usageAt(session.events, currentExchange);
    const previousResponse = usageAt(
      previousContext?.value.events ?? session.events,
      previousExchange,
    );
    const prefixDiagnostics = comparePromptPrefixes(
      previous === null
        ? null
        : {
            bootstrap: previous.bootstrap,
            encoding: previousEncoding,
            ...(previousResponse?.kind === "assistant" &&
            previousResponse.usage !== undefined
              ? { usage: previousResponse.usage }
              : {}),
          },
      {
        bootstrap: recordedPlayPrompt(session).bootstrap,
        encoding: currentEncoding,
        ...(currentResponse?.kind === "assistant" &&
        currentResponse.usage !== undefined
          ? { usage: currentResponse.usage }
          : {}),
      },
    );
    return {
      prefixDiagnostics,
      promptHistory: [
        {
          exchange: 1,
          head: session.baselineHead,
          playPreset: session.playPreset,
          bootstrap: session.bootstrap,
        },
        ...runs,
      ].map(({ exchange, head, playPreset, bootstrap }) => ({
        exchange,
        head,
        playPreset: structuredClone(playPreset),
        bootstrap: {
          logicalMessages: structuredClone(bootstrap.logicalMessages),
          coverage: structuredClone(bootstrap.coverage),
        },
      })),
      requestExchange: currentExchange,
      requestHead: latestRun?.head ?? session.baselineHead,
      chainId: session.chainId,
      baselineHead: session.baselineHead,
      parentHead: session.parentHead,
      stale:
        session.parentHead !== worldHead ||
        (await this.#worlds.archiveNeedsFreshContext(worldId)),
      playPreset: structuredClone(recordedPlayPrompt(session).playPreset),
      updatedAt: session.updatedAt,
      bootstrap: {
        logicalMessages: structuredClone(
          recordedPlayPrompt(session).bootstrap.logicalMessages,
        ),
        coverage: structuredClone(
          recordedPlayPrompt(session).bootstrap.coverage,
        ),
      },
      reads: projectContextReads(session),
    };
  }

  async deriveWorld(input: {
    operationId: string;
    sourceWorldId: string;
    sourceHead: string;
    hostPresetId: string;
    targetDataRoot?: string;
    targetName?: string;
    publish?: false;
    targetWorldRoot?: string;
    identityPrefix?: "import";
    resetPackageScriptPermissions?: boolean;
    retainCompleteTimeline?: true;
  }): Promise<{
    outcome: "derived";
    world: FileNativeWorldSummary;
    worldRoot: string;
  }> {
    const result = await this.#worlds.deriveWorld({
      ...input,
      stageTarget: async ({
        targetWorldRoot,
        targetWorldId,
        binding,
        sourceHead,
      }) => {
        await this.stageForkToDerivedWorld({
          sourceWorldId: input.sourceWorldId,
          sourceHead,
          targetWorldId,
          targetWorldRoot,
          targetBinding: binding,
          ...(input.retainCompleteTimeline
            ? { retainCompleteTimeline: true }
            : {}),
          ...(input.identityPrefix === "import"
            ? { markImportedContexts: true }
            : {}),
        });
      },
    });
    if (
      input.targetDataRoot === undefined &&
      input.publish !== false &&
      (await this.inspectWorld(result.world.worldId)) === null
    )
      await this.forkToDerivedWorld({
        sourceWorldId: input.sourceWorldId,
        sourceHead: input.sourceHead,
        targetWorldId: result.world.worldId,
      });
    return result;
  }

  async forkToDerivedWorld(input: {
    sourceWorldId: string;
    sourceHead: string;
    targetWorldId: string;
  }): Promise<V1PlayCallChainView | null> {
    const existing = await this.#readPersisted(input.targetWorldId);
    if (existing !== null) return projectView(existing);
    await this.#worlds.ensureCurrentStorage(input.sourceWorldId);
    const sourceContexts = await this.#worlds.playTimeline.readAllContexts(
      input.sourceWorldId,
    );
    if (sourceContexts.length === 0) return null;
    const selectedContextIndex = sourceContexts.findIndex(
      ({ events }) => eventsThroughHead(events, input.sourceHead) !== null,
    );
    if (selectedContextIndex < 0) return null;
    const sourceContext = sourceContexts[selectedContextIndex]!;
    const sourceEvents = eventsThroughHead(
      sourceContext.events,
      input.sourceHead,
    )!;
    return this.#forkSelectionToDerivedWorld({
      sourceWorldId: input.sourceWorldId,
      sourceContexts,
      selectedContextIndex,
      sourceEvents,
      sourceHead: input.sourceHead,
      targetWorldId: input.targetWorldId,
      branchIdentity: input.sourceHead,
    });
  }

  async stageForkToDerivedWorld(input: {
    sourceWorldId: string;
    sourceHead: string;
    targetWorldId: string;
    targetWorldRoot: string;
    targetBinding: FileNativePlayBinding;
    retainCompleteTimeline?: true;
    markImportedContexts?: true;
  }): Promise<V1PlayCallChainView | null> {
    await this.#worlds.ensureCurrentStorage(input.sourceWorldId);
    const sourceContexts = await this.#worlds.playTimeline.readAllContexts(
      input.sourceWorldId,
    );
    if (sourceContexts.length === 0) return null;
    const selectedContextIndex = input.retainCompleteTimeline
      ? sourceContexts.length - 1
      : sourceContexts.findIndex(
          ({ events }) => eventsThroughHead(events, input.sourceHead) !== null,
        );
    if (selectedContextIndex < 0) return null;
    const sourceEvents = input.retainCompleteTimeline
      ? sourceContexts[selectedContextIndex]!.events
      : eventsThroughHead(
          sourceContexts[selectedContextIndex]!.events,
          input.sourceHead,
        )!;
    return this.#forkSelectionToDerivedWorld({
      sourceWorldId: input.sourceWorldId,
      sourceContexts,
      selectedContextIndex,
      sourceEvents,
      sourceHead: input.sourceHead,
      targetWorldId: input.targetWorldId,
      branchIdentity: input.sourceHead,
      targetWorldRoot: input.targetWorldRoot,
      targetBinding: input.targetBinding,
      ...(input.retainCompleteTimeline ? { retainCompleteTimeline: true } : {}),
      ...(input.markImportedContexts ? { markImportedContexts: true } : {}),
    });
  }

  /**
   * Edit one committed player message as a rewind followed by an ordinary
   * submission (ADR-0044, ADR-0045). The intent is written before the first
   * world change; every later step is repeatable, so an exit at any point is
   * completed by the same path on the next load.
   */
  async revisePlayer(input: PlayCallChainRevisionInput): Promise<{
    outcome: "revised";
    worldId: string;
    playCallChain: V1PlayCallChainView;
  }> {
    validateIdentity(input.operationId, "timeline-revision operation ID");
    validateIdentity(input.worldId, "world ID");
    validateIdentity(input.chainId, "call-chain ID");
    validateIdentity(input.replacementExchangeId, "replacement exchange ID");
    validatePlayerText(input.replacementText);
    if (!Number.isSafeInteger(input.eventId) || input.eventId < 1)
      throw new PlayCallChainError("The player-event ID is invalid.");

    const activeId = this.#worldChains.get(input.worldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active?.status === "running")
      throw new PlayCallChainError(
        "A model request is still running; wait for it to return before revising committed history.",
      );

    await this.#recoverPlayerRevision(input.worldId);
    // The plan's fully loaded contexts are out of scope once it returns, so
    // completion does not hold a second copy of a long timeline.
    const plan = await this.#planPlayerRevision(input);
    if (plan.kind === "applied") {
      const current = await this.#readPersisted(input.worldId);
      if (current === null)
        throw new PlayCallChainError(
          "The current world has no model call chain to revise.",
        );
      return {
        outcome: "revised",
        worldId: input.worldId,
        playCallChain: projectView(current),
      };
    }
    await this.#worlds.writePlayerRevisionIntent(input.worldId, plan.intent);
    const revised = await this.#completePlayerRevision(plan.intent);
    return {
      outcome: "revised",
      worldId: input.worldId,
      playCallChain: projectView(revised),
    };
  }

  async #planPlayerRevision(
    input: PlayCallChainRevisionInput,
  ): Promise<
    { kind: "applied" } | { kind: "intent"; intent: PlayerRevisionIntent }
  > {
    await this.#worlds.ensureCurrentStorage(input.worldId);
    const contexts = await this.#worlds.playTimeline.readAllContexts(
      input.worldId,
    );
    if (contexts.length === 0)
      throw new PlayCallChainError(
        "The current world has no model call chain to revise.",
      );
    // A replacement exchange that already reached the timeline is a repeat of
    // the same request: answer with the current view and do not redo it.
    const applied = contexts
      .flatMap(({ events }) => events)
      .find(
        (event) =>
          event.kind === "player" &&
          event.exchangeId === input.replacementExchangeId &&
          event.committedHead !== undefined,
      );
    if (applied !== undefined) {
      if (applied.kind === "player" && applied.text !== input.replacementText)
        throw new PlayCallChainError(
          "The same replacement exchange ID is already bound to different player text.",
        );
      return { kind: "applied" };
    }

    const contextIndex = contexts.findIndex(
      ({ chainId }) => chainId === input.chainId,
    );
    if (contextIndex < 0)
      throw new PlayCallChainError(
        "The model context to revise does not exist.",
      );
    const sourceContext = contexts[contextIndex]!;
    if (
      input.continuation === "continue_context" &&
      sourceContext.importedFromArchive
    )
      throw new PlayCallChainError(
        "This model context was imported from a backup; start a fresh context before continuing.",
      );
    const eventIndex = sourceContext.events.findIndex(
      (event) => event.id === input.eventId,
    );
    const selectedEvent = sourceContext.events[eventIndex];
    if (
      eventIndex < 0 ||
      selectedEvent?.kind !== "player" ||
      selectedEvent.committedHead === undefined
    )
      throw new PlayCallChainError(
        "The selected event is not a committed player message.",
      );

    const intent: PlayerRevisionIntent = {
      schemaVersion: 1,
      kind: "player_revision_intent",
      operationId: input.operationId,
      worldId: input.worldId,
      chainId: input.chainId,
      eventId: input.eventId,
      replacementExchangeId: input.replacementExchangeId,
      replacementText: input.replacementText,
      ...turnNoteField(validTurnNote(input.turnNote)),
      continuation: input.continuation,
      restoresHead: playerRevisionRestoresHead(sourceContext, eventIndex),
      discardChainIds: contexts
        .slice(contextIndex)
        .map(({ chainId }) => chainId),
      ...(input.continuation === "fresh_context"
        ? { freshContext: structuredClone(input.freshContext) }
        : {}),
    };
    return { kind: "intent", intent };
  }

  /** Complete an interrupted revision recorded by a previous process. */
  async #recoverPlayerRevision(worldId: string): Promise<void> {
    await this.#worlds.operations.withExclusiveWorldStateMutation(
      worldId,
      async () => {
        const intent = await this.#worlds.readPlayerRevisionIntent(worldId);
        if (intent === null) return;
        if (!isPlayerRevisionIntent(intent) || intent.worldId !== worldId)
          throw new PlayCallChainError(
            "The interrupted player revision record is invalid.",
          );
        await this.#completePlayerRevision(intent);
      },
    );
  }

  /**
   * Run the revision steps in order. Each step either checks whether it is
   * already done or repeats harmlessly: rewinding to the restored endpoint is a
   * no-op at that endpoint, the commit uses the intent's operation ID, and the
   * context is published last, so it is the only step that changes what the
   * next load sees.
   */
  async #completePlayerRevision(
    intent: PlayerRevisionIntent,
  ): Promise<PersistedPlayCallChain> {
    return this.#worlds.operations.withExclusiveWorldStateMutation(
      intent.worldId,
      () => this.#completePlayerRevisionQueued(intent),
    );
  }

  async #completePlayerRevisionQueued(
    intent: PlayerRevisionIntent,
  ): Promise<PersistedPlayCallChain> {
    const worldId = intent.worldId;
    const resultChainId = revisionChainId(
      intent.chainId,
      intent.operationId,
      worldId,
      intent.continuation,
    );
    await this.#worlds.ensureCurrentStorage(worldId);
    // Only the edited context is loaded in full; a long timeline's prompt runs
    // would otherwise be held several times over.
    const outline =
      await this.#worlds.playTimeline.readTimelineOutline(worldId);
    if (outline?.chainIds.at(-1) === resultChainId) {
      const current = await this.#readPersisted(worldId);
      if (current === null)
        throw new PlayCallChainError(
          "The revised model context could not be read.",
        );
      await this.#discardRevisedContexts(intent, resultChainId);
      await this.#worlds.clearPlayerRevisionIntent(worldId);
      return current;
    }

    const sourceIndex =
      outline?.chainIds.findIndex((chainId) => chainId === intent.chainId) ??
      -1;
    const sourceContext =
      sourceIndex < 0
        ? undefined
        : (await this.#worlds.playTimeline.readContext(worldId, intent.chainId))
            ?.value;
    if (outline === null || sourceContext === undefined)
      throw new PlayCallChainError(
        "The model context to revise does not exist.",
      );
    const eventIndex = sourceContext.events.findIndex(
      ({ id }) => id === intent.eventId,
    );
    if (eventIndex < 0)
      throw new PlayCallChainError(
        "The selected event is no longer in its model context.",
      );

    // Fresh-context bootstrap is compiled before any world change.
    const fresh =
      intent.continuation === "fresh_context" && intent.freshContext
        ? await this.#prepareFreshPlayerRevision(
            worldId,
            intent.freshContext,
            intent.restoresHead,
            intent.replacementText,
          )
        : null;
    const head = await this.#commitPlayerRevision(intent);

    const [baseline, selected, binding] = await Promise.all([
      this.#worlds.recoverEndpoint(worldId, sourceContext.baselineHead),
      this.#worlds.recoverEndpoint(worldId, intent.restoresHead),
      this.#worlds.bindPlayCallChain(worldId),
    ]);
    if (binding.parentHead !== head)
      throw new PlayCallChainError(
        "The player revision was committed, but current-world materialization has not reached the new endpoint.",
      );
    const timelineGeneration = revisionTimelineGeneration(
      outline.generation,
      intent.operationId,
      worldId,
      intent.continuation,
    );
    const previousChainId =
      sourceIndex === 0 ? null : outline.chainIds[sourceIndex - 1]!;
    const traceRetention = preparePlayerRevisionTrace(
      sourceContext,
      eventIndex,
    );

    let revised: PersistedPlayCallChain;
    if (intent.continuation === "fresh_context") {
      if (fresh === null || intent.freshContext === undefined)
        throw new PlayCallChainError(
          "The fresh model context was not prepared before committing the player revision.",
        );
      revised = await this.#buildFreshPlayerRevision({
        intent,
        freshContext: intent.freshContext,
        sourceContext,
        traceRetention,
        baseline,
        selected,
        binding,
        head,
        chainId: resultChainId,
        previousChainId,
        timelineGeneration,
        fresh,
      });
    } else {
      revised = {
        ...traceRetention
          .withReplacement({
            head,
            exchangeId: intent.replacementExchangeId,
            text: intent.replacementText,
          })
          .atEndpoint({ baseline, selected, binding }),
        schemaVersion: 3,
        kind: "play_call_chain",
        chainId: resultChainId,
        worldId,
        previousContexts: [],
        previousChainId,
        timelineGeneration,
        ...turnNoteField(intent.turnNote),
        parentHead: head,
        updatedAt: Date.now(),
      };
    }

    await this.#worlds.playTimeline.persist(revised);
    if (intent.continuation === "fresh_context")
      await this.#worlds.completeArchiveFreshContext(worldId);
    await this.#discardRevisedContexts(intent, resultChainId);
    const activeId = this.#worldChains.get(worldId);
    if (activeId !== undefined) this.#active.delete(activeId);
    this.#active.delete(sourceContext.chainId);
    this.#worldChains.delete(worldId);
    await this.#worlds.clearPlayerRevisionIntent(worldId);
    return revised;
  }

  /**
   * Delete the segments of the edited context and every later one. Their
   * surviving content has been copied into the revised context, so only the
   * discarded rounds and their in-progress markers are removed from disk.
   */
  async #discardRevisedContexts(
    intent: PlayerRevisionIntent,
    keepChainId: string,
  ): Promise<void> {
    const discarded = intent.discardChainIds.filter(
      (chainId) => chainId !== keepChainId,
    );
    await this.#worlds.playTimeline.discardContexts(intent.worldId, discarded);
    for (const chainId of discarded)
      await this.#worlds.playAdvances.discardChain(intent.worldId, chainId);
  }

  /**
   * Rewind the world to the message's logical parent and commit the replacement
   * as an ordinary player step. Returns the committed head. A commit already
   * made in this process is reused rather than rewound and repeated.
   */
  async #commitPlayerRevision(intent: PlayerRevisionIntent): Promise<string> {
    const done = await this.#worlds.getOperationOutcome(intent.operationId);
    if (done.outcome === "committed") return done.head;
    await this.#worlds.rewindPlayerRevision(
      intent.worldId,
      intent.restoresHead,
    );
    await this.#artifacts?.discardAfterHead(
      intent.worldId,
      intent.restoresHead,
    );
    const binding = await this.#worlds.bindPlayCallChainAt(
      intent.worldId,
      intent.restoresHead,
    );
    const origin = captureNarrativeOrigin(
      WorldDocumentStore.open({
        layout: "world_state",
        files: Object.entries(binding.files).map(([path, contents]) => ({
          path,
          contents,
        })),
      }),
      intent.eventId,
    );
    const outcome = await this.#worlds.commitPlayStep({
      operationId: intent.operationId,
      worldId: intent.worldId,
      parentHead: intent.restoresHead,
      historyAppend: [
        {
          role: "player",
          exactText: intent.replacementText,
          ...(origin.value == null
            ? {}
            : { background: snapshotBackground(origin.value)! }),
        },
      ],
      nextMaterials: structuredClone(binding.additionalMaterials),
      stateChanges: [],
    });
    return outcome.head;
  }

  async #prepareFreshPlayerRevision(
    worldId: string,
    freshContext: PlayerRevisionFreshContext,
    restoresHead: string,
    replacementText: string,
  ): Promise<PreparedFreshPlayerRevision> {
    const binding = await this.#worlds.bindPlayCallChainAt(
      worldId,
      restoresHead,
    );
    const fresh = await this.#compileFreshContext(worldId, binding, {
      hostBinding: freshContext.hostBinding,
      playPreset: freshContext.playPreset,
      modelBinding: freshContext.modelBinding,
      playerText: replacementText,
    });
    return {
      binding,
      bootstrap: fresh.bootstrap,
      tools: fresh.tools,
      followups: fresh.followups,
    };
  }

  async #buildFreshPlayerRevision(input: {
    intent: PlayerRevisionIntent;
    freshContext: PlayerRevisionFreshContext;
    sourceContext: PersistedPlayCallChainContext;
    traceRetention: ReturnType<typeof preparePlayerRevisionTrace>;
    baseline: FileNativeRecoveredEndpoint;
    selected: FileNativeRecoveredEndpoint;
    binding: FileNativePlayBinding;
    head: string;
    chainId: string;
    previousChainId: string | null;
    timelineGeneration: string;
    fresh: PreparedFreshPlayerRevision;
  }): Promise<PersistedPlayCallChain> {
    const { intent, sourceContext, fresh } = input;
    let previousChainId = input.previousChainId;
    const retainedPrefix = input.traceRetention.pagePrefixAtEndpoint({
      baseline: input.baseline,
      selected: input.selected,
      binding: input.binding,
    });
    if (retainedPrefix !== null) {
      const prefix: PersistedPlayCallChain = {
        ...retainedPrefix,
        schemaVersion: 3,
        kind: "play_call_chain",
        chainId: derivedChainId(
          sourceContext.chainId,
          "timeline-revision-prefix:" + intent.operationId,
          intent.worldId,
        ),
        worldId: intent.worldId,
        previousContexts: [],
        previousChainId,
        timelineGeneration: input.timelineGeneration,
        parentHead: intent.restoresHead,
        updatedAt: Date.now(),
      };
      await this.#worlds.playTimeline.persistDetached(structuredClone(prefix));
      previousChainId = prefix.chainId;
    }

    return {
      schemaVersion: 3,
      kind: "play_call_chain",
      chainId: input.chainId,
      worldId: intent.worldId,
      previousContexts: [],
      previousChainId,
      timelineGeneration: input.timelineGeneration,
      baselineHead: intent.restoresHead,
      baselineHistoryLength: Object.keys(fresh.binding.history).length,
      parentHead: input.head,
      playPreset: {
        id: input.freshContext.playPreset.id,
        name: input.freshContext.playPreset.name,
        revision: input.freshContext.playPreset.revision,
      },
      followups: structuredClone(fresh.followups),
      ...turnNoteField(input.intent.turnNote),
      playPresetScriptsEnabled: input.freshContext.playPreset.scriptsEnabled,
      presetFiles: structuredClone(input.freshContext.playPreset.files),
      modelBinding: structuredClone(input.freshContext.modelBinding),
      status: "ready",
      canRetry: false,
      bootstrap: structuredClone(fresh.bootstrap),
      tools: structuredClone(fresh.tools),
      narrativeOrigin: captureNarrativeOrigin(
        WorldDocumentStore.open({
          layout: "world_state",
          files: Object.entries(input.binding.files).map(
            ([path, contents]) => ({ path, contents }),
          ),
        }),
        1,
      ),
      transcript: playerInputAppend(intent.replacementText),
      events: [
        {
          id: 1,
          kind: "player",
          exchangeId: intent.replacementExchangeId,
          text: intent.replacementText,
          context: "fresh",
          committedHead: input.head,
        },
      ],
      completedTools: [],
      changedDocuments: [],
      nextMaterials: structuredClone(input.binding.additionalMaterials),
      nextEventId: 2,
      exchange: 0,
      lastRequest: null,
      lastRequestAttempt: 0,
      lastFailure: null,
      updatedAt: Date.now(),
    };
  }

  async #forkSelectionToDerivedWorld(input: {
    sourceWorldId: string;
    sourceContexts: PersistedPlayCallChainContext[];
    selectedContextIndex: number;
    sourceEvents: V1PlayCallChainEvent[];
    sourceHead: string;
    targetWorldId: string;
    branchIdentity: string;
    targetWorldRoot?: string;
    targetBinding?: FileNativePlayBinding;
    retainCompleteTimeline?: true;
    markImportedContexts?: true;
  }): Promise<V1PlayCallChainView> {
    if (input.targetWorldRoot === undefined) {
      const existing = await this.#readPersisted(input.targetWorldId);
      if (existing !== null) return projectView(existing);
    }

    const sourceContext = input.sourceContexts[input.selectedContextIndex]!;
    if (
      input.targetWorldRoot === undefined &&
      (await this.#worlds.currentHead(input.targetWorldId)) !== input.sourceHead
    )
      throw new PlayCallChainError(
        "The forked world's Authority does not match the selected history endpoint, so the call chain cannot be written.",
      );

    let retainedTrace: Omit<
      PersistedPlayCallChainContext,
      "chainId" | "parentHead" | "updatedAt"
    >;
    if (input.retainCompleteTimeline) {
      // A backup retains the current page closure, even when its last context
      // precedes a correction or contains an uncommitted response diagnostic.
      retainedTrace = independentContextCopy(sourceContext);
    } else {
      const [baseline, selected] = await Promise.all([
        this.#worlds.recoverEndpoint(
          input.targetWorldRoot === undefined
            ? input.targetWorldId
            : input.sourceWorldId,
          sourceContext.baselineHead,
        ),
        this.#worlds.recoverEndpoint(
          input.targetWorldRoot === undefined
            ? input.targetWorldId
            : input.sourceWorldId,
          input.sourceHead,
        ),
      ]);
      const traceRetention = prepareForkTrace(
        sourceContext,
        input.sourceEvents,
      );
      const derivedBinding =
        input.targetBinding ??
        (await this.#worlds.bindPlayCallChain(input.targetWorldId));
      retainedTrace = traceRetention.atEndpoint({
        baseline,
        selected,
        binding: derivedBinding,
      });
    }
    const now = Date.now();
    const timelineGeneration = this.#worlds.playTimeline.newGeneration();
    let previousChainId: string | null = null;
    for (const [index, context] of input.sourceContexts
      .slice(0, input.selectedContextIndex)
      .entries()) {
      const chainId = derivedChainId(
        context.chainId,
        `prefix:${input.branchIdentity}:${index}`,
        input.targetWorldId,
      );
      const previousContext = {
        ...independentContextCopy(context),
        ...(input.markImportedContexts ? { importedFromArchive: true } : {}),
        schemaVersion: 3,
        kind: "play_call_chain",
        worldId: input.targetWorldId,
        chainId,
        previousContexts: [],
        previousChainId,
        timelineGeneration,
      } satisfies PersistedPlayCallChain;
      if (input.targetWorldRoot === undefined)
        await this.#worlds.playTimeline.persist(previousContext);
      else
        await this.#worlds.playTimeline.cloneContextPrefixToStaging({
          sourceWorldId: input.sourceWorldId,
          targetWorldRoot: input.targetWorldRoot,
          source: context,
          target: previousContext,
        });
      previousChainId = chainId;
    }
    const derived: PersistedPlayCallChain = {
      ...retainedTrace,
      ...(input.markImportedContexts ? { importedFromArchive: true } : {}),
      schemaVersion: 3,
      kind: "play_call_chain",
      chainId: derivedChainId(
        sourceContext.chainId,
        input.branchIdentity,
        input.targetWorldId,
      ),
      worldId: input.targetWorldId,
      previousContexts: [],
      previousChainId,
      timelineGeneration,
      parentHead: input.retainCompleteTimeline
        ? sourceContext.parentHead
        : input.sourceHead,
      updatedAt: now,
    };
    if (input.targetWorldRoot === undefined)
      await this.#worlds.playTimeline.persist(cloneSharingPromptRuns(derived));
    else
      await this.#worlds.playTimeline.cloneContextPrefixToStaging({
        sourceWorldId: input.sourceWorldId,
        targetWorldRoot: input.targetWorldRoot,
        source: sourceContext,
        target: cloneSharingPromptRuns(derived),
      });
    return projectView(derived);
  }

  /**
   * Stops every in-flight model request for a world and waits until each has
   * left the active table, so deletion never races a play write.
   */
  async abortWorld(worldId: string): Promise<void> {
    validateIdentity(worldId, "world ID");
    const invocations = [...this.#activeInvocations.values()].filter(
      (invocation) => invocation.worldId === worldId,
    );
    for (const invocation of invocations) {
      if (invocation.abortable && !invocation.controller.signal.aborted) {
        invocation.phase = "cancelling";
        invocation.lastActivityAt = Date.now();
        invocation.controller.abort();
      }
    }
    await Promise.all(
      invocations.map(
        (invocation) =>
          this.#invocationSettled.get(invocation.chainId) ?? Promise.resolve(),
      ),
    );
  }

  forgetWorld(worldId: string): void {
    const activeId = this.#worldChains.get(worldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active?.status === "running")
      throw new PlayCallChainError(
        "A model request is still running; wait for it to return before deleting the world.",
      );
    if (activeId !== undefined) this.#active.delete(activeId);
    this.#worldChains.delete(worldId);
    this.#hydrating.delete(worldId);
  }

  async #captureOrigin(session: PlayCallChainSession) {
    const binding = await this.#worlds.bindPlayCallChain(session.worldId);
    if (binding.parentHead !== session.parentHead)
      throw new PlayCallChainError(
        "World advanced before background capture; use a fresh context.",
      );
    return captureNarrativeOrigin(
      WorldDocumentStore.open({
        layout: "world_state",
        files: Object.entries(binding.files).map(([path, contents]) => ({
          path,
          contents,
        })),
      }),
      session.nextEventId,
    );
  }

  async #submitPlayer(
    session: PlayCallChainSession,
    exchangeId: string,
    playerText: string,
    context: "fresh" | "append",
    modelHost: ModelHost,
    signal: AbortSignal,
    observer?: PlayCallChainObserver,
  ): Promise<V1PlayCallChainView> {
    if (duplicatePlayerExchange(session, exchangeId, playerText, context))
      return projectView(session);
    if (session.status === "running")
      throw new PlayCallChainError(
        "The call chain is waiting for the model to return.",
      );

    session.narrativeOrigin = await this.#captureOrigin(session);
    const exchange = session.exchange + 1;
    const nextRequest = createRequest(
      session,
      modelHost,
      exchange,
      this.#compiler.locale,
      [...session.transcript, ...playerInputAppend(playerText)],
    );
    const operationKey = `player:${exchangeId}`;
    const playerOperationId = operationId(session.chainId, operationKey);
    const advance = {
      schemaVersion: 1,
      kind: "play_advance",
      advanceKind: "player",
      narrativeOrigin: structuredClone(session.narrativeOrigin),
      playContext: session.continuityContextId ?? session.chainId,
      worldId: session.worldId,
      chainId: session.chainId,
      advanceId: playerOperationId,
      operationId: playerOperationId,
      parentHead: session.parentHead,
      eventId: session.nextEventId,
      exchangeId,
      playerText,
      context,
      transcriptStart: session.transcript.length,
      exchange,
      nextRequest: structuredClone(nextRequest),
      createdAt: Date.now(),
    } satisfies PlayerAdvance;
    await this.#worlds.playAdvances.begin(advance);
    try {
      await this.#settlePlayerAdvance(session, advance);
    } catch (error: unknown) {
      const ending = settlementFailureEnding(
        error,
        "Failed to write the original player text.",
      );
      await this.#advances.end(session, ending, advance);
      throw new PlayCallChainError(ending.message);
    }
    return this.#dispatch(
      session,
      modelHost,
      structuredClone(nextRequest),
      1,
      signal,
      observer,
    );
  }

  async #settlePlayerAdvance(
    session: PlayCallChainSession,
    advance: PlayerAdvance,
  ): Promise<void> {
    const outcome = await this.#worlds.commitPlayStep({
      ...(advance.playContext === undefined
        ? {}
        : { playContext: advance.playContext }),
      operationId: advance.operationId,
      worldId: session.worldId,
      parentHead: advance.parentHead,
      historyAppend: [
        {
          role: "player",
          exactText: advance.playerText,
          ...(advance.narrativeOrigin?.value == null
            ? {}
            : {
                background: snapshotBackground(advance.narrativeOrigin.value)!,
              }),
        },
      ],
      nextMaterials: structuredClone(session.nextMaterials),
      stateChanges: [],
    });
    if (
      outcome.worldId !== session.worldId ||
      outcome.parentHead !== advance.parentHead
    )
      throw new PlayCallChainError(
        "The recovered player advance belongs to a different world endpoint.",
      );

    const playerEvent = {
      id: advance.eventId,
      kind: "player",
      exchangeId: advance.exchangeId,
      text: advance.playerText,
      context: advance.context,
      committedHead: outcome.head,
    } satisfies Extract<V1PlayCallChainEvent, { kind: "player" }>;
    session.events = [
      ...session.events.filter(({ id }) => id < advance.eventId),
      playerEvent,
    ];
    session.transcript = [
      ...session.transcript.slice(0, advance.transcriptStart),
      ...structuredClone(
        transcriptAppendOf(advance.nextRequest).slice(advance.transcriptStart),
      ),
    ];
    session.nextEventId = advance.eventId + 1;
    session.parentHead = outcome.head;
    appendCommittedHistory(session, outcome.head, outcome.historyAppend);
    if (advance.narrativeOrigin === undefined) delete session.narrativeOrigin;
    else session.narrativeOrigin = structuredClone(advance.narrativeOrigin);
    session.exchange = advance.exchange;
    await this.#advances.end(
      session,
      {
        kind: "resumable",
        reason: "player_committed",
        request: advance.nextRequest,
      },
      advance,
    );
  }

  /**
   * Settles one complete model response in this process. The tool batch, the
   * narrative and state commit, and the transcript and event tail advance
   * together. Nothing is kept for a replay: a process that stops before this
   * returns is recovered as an interrupted exchange (ADR-0044).
   */
  async #settleResponse(
    session: PlayCallChainSession,
    advance: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
    response: Awaited<ReturnType<ModelHost["exchange"]>>,
  ): Promise<ResponseSettlement> {
    const durable = durableModelResponse(response);
    const existing = session.events.find(({ id }) => id === advance.eventId);
    if (existing?.kind !== "assistant")
      throw new PlayCallChainError(
        "The durable Provider result no longer matches its assistant event.",
      );
    const calls = durable.toolCalls ?? [];
    const text = durable.text ?? existing.text;
    const hasText = text.trim().length > 0;
    const responseKind =
      calls.length > 0 ? "tool_step" : hasText ? "narrative" : "empty";
    const narrative = responseKind === "narrative";
    const assistantEvent: Extract<V1PlayCallChainEvent, { kind: "assistant" }> =
      {
        id: advance.eventId,
        kind: "assistant",
        text,
        status: "completed",
        responseKind,
        exchange: advance.exchange,
        attempt: advance.attempt,
        ...(durable.reasoningContent === undefined
          ? existing.reasoning === undefined
            ? {}
            : { reasoning: existing.reasoning }
          : { reasoning: durable.reasoningContent }),
        ...(durable.usage === undefined
          ? {}
          : { usage: structuredClone(durable.usage) }),
        ...(durable.stopReason === undefined
          ? {}
          : { stopReason: durable.stopReason }),
        continuation:
          durable.providerState === undefined ? "unavailable" : "available",
      };
    const workingTools = new Map(session.completedToolMap);
    const prepared: PreparedToolResult[] = [];
    const trailingEvents: V1PlayCallChainEvent[] = [];
    let nextEventId = advance.eventId + 1;
    // Fresh in-memory seed per settlement. It is never persisted: a crashed
    // exchange is retried by the player and re-rolls (ADR-0044).
    const providedToolNames = currentPlayPrompt(session).tools.map(
      ({ name }) => name,
    );
    const resolutionSeed = calls.some(({ name }) => {
      const resolved = resolveToolName(name, providedToolNames);
      return resolved.kind !== "rejected" && isResolutionTool(resolved.name);
    })
      ? randomBytes(32).toString("hex")
      : undefined;
    for (const call of calls) {
      const item = prepareTool(
        session,
        workingTools,
        advance.exchange,
        call,
        this.#compiler.locale,
        resolutionSeed,
      );
      prepared.push(item);
      trailingEvents.push({
        id: nextEventId++,
        kind: "tool_call",
        callId: call.id,
        name: call.name,
        ...(item.event.executedName === undefined
          ? {}
          : { executedName: item.event.executedName }),
        arguments: structuredClone(call.arguments),
        replayed: item.replayed,
      });
      item.event.id = nextEventId++;
      trailingEvents.push(structuredClone(item.event));
    }
    const stateChanges = session.documents.stateChanges();
    // Resolve once after the entire tool batch, so every write result reports
    // the prediction that the commit below makes true.
    const writes = [...workingTools.values()].filter(
      ({ result }) => result.candidateWrite !== undefined,
    );
    let worldClock: string | undefined;
    if (writes.length > 0) {
      try {
        // Author controls may change while an existing Provider context stays
        // frozen. Predictions and clock capture use the controls active now.
        const binding = await this.#worlds.bindPlayCallChain(session.worldId);
        const snapshot = WorldDocumentStore.open({
          layout: "world_state",
          files: [
            ...session.documents.snapshot.files.filter(({ path }) =>
              path.startsWith("state/"),
            ),
            ...Object.entries(binding.files)
              .filter(([path]) => path.startsWith("control/"))
              .map(([path, contents]) => ({ path, contents })),
          ],
        });
        worldClock = readDeclaredWorldClock(snapshot);
        const { maintenance } = this.#compiler.inspectWorldMaterials({
          controlFingerprint: "receipt",
          documentSnapshot: snapshot,
          history: Object.fromEntries(
            session.history.map(({ path, contents }) => [path, contents]),
          ),
          additionalMaterials: session.nextMaterials,
        });
        for (const { result } of writes) {
          const write = result.candidateWrite!;
          const previous = session.documents.committedSnapshot.query({
            kind: "read_document",
            document: { shortRef: write.shortRef },
          });
          write.sizeAdvice = renderWriteSizeAdvice(
            maintenance,
            write.shortRef,
            previous.kind === "read_document"
              ? Buffer.byteLength(previous.body, "utf8")
              : null,
            this.#compiler.locale,
          );
        }
      } catch {
        // Maintenance advice is diagnostic: a failure omits it and never
        // rejects or undoes an accepted write.
      }
    }
    const previousNarrative = session.events.findLast(
      (event) =>
        event.kind === "assistant" &&
        event.committedHead !== undefined &&
        event.responseKind === "narrative",
    );
    const previousPlayer = session.events.findLast(
      (event) => event.kind === "player",
    );
    const checkpointRequested =
      narrative &&
      session.events.some(
        (event) =>
          event.id >
            Math.max(previousNarrative?.id ?? 0, previousPlayer?.id ?? 0) &&
          event.kind === "tool_result" &&
          (event.executedName ?? event.name) === "world_checkpoint" &&
          event.ok,
      );
    const narrativeCheckpoint = checkpointRequested
      ? {
          contextId: session.chainId,
          completedPlayerRounds: completedPlayerRounds({
            ...Object.fromEntries(
              session.history.map(({ path, contents }) => [path, contents]),
            ),
            "message.pending.narrator": text,
          }),
        }
      : undefined;
    const assistantItem: Extract<ModelHostAppendItem, { kind: "assistant" }> = {
      kind: "assistant",
      text,
      ...(durable.reasoningContent === undefined
        ? {}
        : { reasoningContent: durable.reasoningContent }),
      ...(durable.providerState === undefined
        ? {}
        : { providerState: durable.providerState }),
      toolCalls: structuredClone(calls),
    };
    const background = narrative
      ? narrativeBackground(advance.narrativeOrigin, session.documents.snapshot)
      : undefined;
    const transcriptStart = session.transcript.length;
    const transcriptAppend: ModelHostAppendItem[] = [
      ...(calls.length > 0 || narrative || durable.providerState !== undefined
        ? [assistantItem]
        : []),
      ...prepared.map(({ transcript }) => structuredClone(transcript)),
      ...(calls.length > 0 && hasText
        ? [toolStepNotice(this.#compiler.locale)]
        : []),
    ];
    const completedTools = [...workingTools.values()].map((item) =>
      structuredClone(item),
    );
    const failedTools = trailingEvents.filter(
      (
        candidate,
      ): candidate is Extract<V1PlayCallChainEvent, { kind: "tool_result" }> =>
        candidate.kind === "tool_result" && !candidate.ok,
    );
    if (failedTools.length > 0 && response.diagnostics !== undefined)
      await this.#failureLog?.recordFailure({
        exchange: response.diagnostics,
        failures: [
          {
            kind: "tool_execution",
            message: "A Runtime tool call from the model was rejected.",
            details: {
              calls: failedTools.map((result) => ({
                id: result.callId,
                name: result.name,
                ok: result.ok,
                markdown: result.markdown,
                replayed: result.replayed,
              })),
            },
          },
        ],
      });

    let committedHead: string | undefined;
    if (narrative || stateChanges.length > 0) {
      const outcome = await this.#worlds.commitPlayStep({
        playContext: session.continuityContextId ?? session.chainId,
        ...(worldClock === undefined || stateChanges.length === 0
          ? {}
          : { worldClock }),
        operationId: advance.operationId,
        worldId: session.worldId,
        parentHead: advance.parentHead,
        historyAppend: narrative
          ? [
              {
                role: "narrator",
                exactText: text,
                ...(background === undefined ? {} : { background }),
              },
            ]
          : [],
        nextMaterials: structuredClone(session.nextMaterials),
        stateChanges: structuredClone(stateChanges),
        ...(narrativeCheckpoint === undefined ? {} : { narrativeCheckpoint }),
      });
      committedHead = outcome.head;
      assistantEvent.committedHead = outcome.head;
      if (narrativeCheckpoint !== undefined) {
        assistantEvent.checkpoint = true;
        session.narrativeCheckpoint = {
          ...narrativeCheckpoint,
          head: outcome.head,
          historyMessageId: `message.${outcome.head.slice("commit:".length)}.1.narrator`,
        };
      }
      appendCommittedHistory(session, outcome.head, outcome.historyAppend);
    }

    finalizeWriteReceipts({
      stateChanges,
      completedTools,
      trailingEvents,
      transcriptAppend,
    });
    session.events = [
      ...session.events.filter(({ id }) => id < advance.eventId),
      structuredClone(assistantEvent),
      ...structuredClone(trailingEvents),
    ];
    session.nextEventId =
      Math.max(advance.eventId, ...trailingEvents.map(({ id }) => id)) + 1;
    session.transcript = [
      ...session.transcript.slice(0, transcriptStart),
      ...structuredClone(transcriptAppend),
    ];
    session.completedTools = structuredClone(completedTools);
    session.completedToolMap = new Map(
      completedTools.map((item) => [item.key, structuredClone(item)]),
    );
    if (committedHead !== undefined) session.parentHead = committedHead;
    if (stateChanges.length > 0) {
      session.documents.acceptCommittedState();
      mergeChangedDocuments(session, stateChanges);
      await this.#bindDocumentMaintenance(
        session.documents,
        session.worldId,
        session.parentHead,
      );
    }

    const hasToolCalls = calls.length > 0;
    session.exchange = Math.max(session.exchange, advance.exchange);
    // The chain has been `running` since its dispatch began, so its failure
    // fields are already clear; the ending below replaces them.
    if (assistantEvent.continuation !== "available") {
      await this.#advances.end(session, noContinuationEnding(), advance);
      return { kind: "terminal", status: "interrupted", narrative };
    }
    if (hasToolCalls) {
      session.exchange += 1;
      const nextRequest = createRequestWithMaxOutputTokens(
        session,
        session.lastRequest?.maxOutputTokens ?? 1,
        session.exchange,
        this.#compiler.locale,
      );
      if (session.lastRequest?.modelConfig !== undefined)
        nextRequest.modelConfig = structuredClone(
          session.lastRequest.modelConfig,
        );
      await this.#advances.end(
        session,
        {
          kind: "resumable",
          reason: "tool_step_settled",
          request: nextRequest,
        },
        advance,
      );
      return { kind: "continue", nextRequest };
    }
    if (!narrative) {
      await this.#advances.end(session, emptyResponseEnding(), advance);
      return { kind: "terminal", status: "interrupted", narrative };
    }
    await this.#advances.end(session, { kind: "ready" }, advance);
    return { kind: "terminal", status: "ready", narrative };
  }

  async #dispatch(
    session: PlayCallChainSession,
    modelHost: ModelHost,
    firstRequest: ModelHostExchange,
    firstAttempt: number,
    signal: AbortSignal,
    observer?: PlayCallChainObserver,
  ): Promise<V1PlayCallChainView> {
    let request =
      modelHost.freezeRequest?.(firstRequest) ?? structuredClone(firstRequest);
    let attempt = firstAttempt;
    for (;;) {
      this.#setInvocationAbortable(session.chainId, true);
      if (signal.aborted)
        return this.#cancelBeforeProviderDispatch(
          session,
          request,
          attempt,
          observer,
        );
      this.#observeInvocation(session.chainId, "waiting");
      this.#advances.beginDispatch(session, request, attempt);
      const responseExchange = request.exchange ?? session.exchange;
      const event: Extract<V1PlayCallChainEvent, { kind: "assistant" }> = {
        id: session.nextEventId++,
        kind: "assistant",
        text: "",
        status: "streaming",
        responseKind: "pending",
        exchange: responseExchange,
        attempt,
      };
      session.events.push(event);
      await this.#persist(session);
      const responseOperationId = operationId(
        session.chainId,
        `response:${responseExchange}:attempt:${attempt}`,
      );
      const advance = {
        schemaVersion: 1,
        kind: "play_advance",
        advanceKind: "response",
        ...(session.narrativeOrigin === undefined
          ? {}
          : { narrativeOrigin: structuredClone(session.narrativeOrigin) }),
        worldId: session.worldId,
        chainId: session.chainId,
        advanceId: responseOperationId,
        operationId: responseOperationId,
        parentHead: session.parentHead,
        eventId: event.id,
        exchange: responseExchange,
        attempt,
        createdAt: Date.now(),
      } satisfies Extract<PlayAdvanceBase, { advanceKind: "response" }>;
      await this.#worlds.playAdvances.begin(advance);
      this.#notifySnapshot(observer, session);
      if (signal.aborted)
        return this.#cancelBeforeProviderDispatch(
          session,
          request,
          attempt,
          observer,
          advance,
        );

      let response: Awaited<ReturnType<ModelHost["exchange"]>>;
      try {
        this.#observeInvocation(session.chainId, "waiting", { dispatches: 1 });
        if (
          modelHost.previewRequest !== undefined &&
          (request.exchange === 1 ||
            request.exchange === session.promptRuns?.at(-1)?.exchange)
        ) {
          try {
            await this.#worlds.playTimeline.recordInitialEncoding(
              session.worldId,
              session.chainId,
              modelHost.previewRequest(request),
              request.exchange,
            );
          } catch {
            // Optional diagnostics never interrupt a model request or alter its cache key.
          }
        }
        response = await modelHost.exchange(request, {
          signal,
          onDelta: (delta) => {
            this.#observeInvocation(session.chainId, delta.kind, {
              ...(delta.kind === "reasoning"
                ? { reasoningChars: delta.text.length }
                : delta.kind === "text"
                  ? { textChars: delta.text.length }
                  : { toolChars: delta.text.length }),
            });
            if (delta.kind === "text") event.text += delta.text;
            else if (delta.kind === "reasoning")
              event.reasoning = `${event.reasoning ?? ""}${delta.text}`;
            else if (delta.kind === "tool")
              event.toolFragment = `${event.toolFragment ?? ""}${delta.text}`;
            touch(session);
            this.changed(session.worldId);
            notifyAssistantDelta(observer, {
              eventId: event.id,
              kind: delta.kind,
              text: delta.text,
              updatedAt: session.updatedAt,
            });
          },
        });
        if (signal.aborted)
          throw new ModelHostCancelledError(
            "The player cancelled the dispatched model request; its response was not committed and cannot be replayed.",
          );
        this.#setInvocationAbortable(session.chainId, false);
        if ((response.toolCalls?.length ?? 0) > 0)
          this.#observeInvocation(session.chainId, "tool", {
            toolCalls: response.toolCalls?.length ?? 0,
          });
        if (response.diagnostics !== undefined)
          await this.#failureLog?.recordExchangeIfActive(response.diagnostics);
      } catch (error: unknown) {
        await this.#advances.end(
          session,
          dispatchFailureEnding(error, event.id),
          advance,
          () => this.#notifySnapshot(observer, session),
        );
        return projectView(session);
      }

      try {
        const settled = await this.#settleResponse(session, advance, response);

        if (settled.kind === "terminal") {
          if (!settled.narrative) {
            const message =
              "The model returned neither text nor a complete tool call.";
            if (response.diagnostics !== undefined)
              await this.#failureLog?.recordFailure({
                exchange: response.diagnostics,
                failures: [
                  {
                    kind: "format_validation",
                    message,
                  },
                ],
              });
            this.#notifySnapshot(observer, session);
            return projectView(session);
          }
          if (settled.status !== "ready") {
            this.#notifySnapshot(observer, session);
            return projectView(session);
          }
          // The exchange has settled: no tool call is pending and the narrative
          // is committed. Followups run here, while the chain still reads as
          // running, so the player only regains the composer once the panels
          // they are about to act on are in place.
          if (response.diagnostics !== undefined)
            await this.#failureLog?.resolve({
              exchange: response.diagnostics,
              message:
                "The play call chain recovered during a later model exchange and completed.",
              details: { parentHead: session.parentHead },
            });
          if ((currentPlayPrompt(session).followups?.length ?? 0) > 0) {
            // Follow-up artifacts are part of this player-visible invocation.
            // Keep `running` ephemeral: the settled main response remains the
            // durable recovery point if this Runtime process stops here.
            session.status = "running";
            this.#observeInvocation(session.chainId, "followup");
            this.#setInvocationAbortable(session.chainId, true);
            this.#notifySnapshot(observer, session);
          }
          await this.#runFollowups(session, modelHost, signal, observer);
          this.#setInvocationAbortable(session.chainId, false);
          await this.#advances.end(
            session,
            { kind: "ready", followupsCancelled: signal.aborted },
            null,
            () => this.#notifySnapshot(observer, session),
          );
          return projectView(session);
        }
        this.#notifySnapshot(observer, session);
        request = settled.nextRequest;
        attempt = 1;
      } catch (error: unknown) {
        const ending = settlementFailureEnding(
          error,
          "Call-chain processing failed.",
        );
        if (response.diagnostics !== undefined)
          await this.#failureLog?.recordFailure({
            exchange: response.diagnostics,
            failures: [
              {
                kind: "runtime_post_processing",
                message: ending.message,
              },
            ],
          });
        await this.#advances.end(session, ending, advance, () =>
          this.#notifySnapshot(observer, session),
        );
        return projectView(session);
      }
    }
  }

  async #cancelBeforeProviderDispatch(
    session: PlayCallChainSession,
    request: ModelHostExchange,
    attempt: number,
    observer?: PlayCallChainObserver,
    advance?: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
  ): Promise<V1PlayCallChainView> {
    await this.#advances.end(
      session,
      {
        kind: "cancelled_before_dispatch",
        request,
        attempt,
        ...(advance === undefined ? {} : { streamingEventId: advance.eventId }),
      },
      advance ?? null,
      () => this.#notifySnapshot(observer, session),
    );
    return projectView(session);
  }

  /**
   * Dispatch the frozen follow-ups once against the settled exchange.
   *
   * Everything here is best-effort by construction: Authority already accepted
   * the narrative and the world changes, so a failing panel must cost the
   * player nothing more than a missing panel. Failures are recorded in the
   * trace and the chain still returns to `ready`.
   */
  async #runFollowups(
    session: PlayCallChainSession,
    modelHost: ModelHost,
    signal: AbortSignal,
    observer?: PlayCallChainObserver,
  ): Promise<void> {
    const followups = currentPlayPrompt(session).followups ?? [];
    if (this.#artifacts === undefined || followups.length === 0) return;
    const reply = session.events.findLast(
      (event) =>
        event.kind === "assistant" &&
        event.committedHead === session.parentHead,
    );
    if (reply === undefined)
      throw new PlayCallChainError("Follow-up reply is not committed");
    const observeFollowupDelta = (
      delta: Parameters<
        NonNullable<PlayFollowupObserver["onProviderDelta"]>
      >[0],
    ): void => {
      this.#observeInvocation(session.chainId, "followup", {
        ...(delta.kind === "reasoning"
          ? { reasoningChars: delta.text.length }
          : delta.kind === "text"
            ? { textChars: delta.text.length }
            : { toolChars: delta.text.length }),
      });
      this.#notifySnapshot(observer, session);
    };
    const record = (outcome: PlayFollowupOutcome): void => {
      this.#observeInvocation(session.chainId, "followup", {
        toolCalls: outcome.toolCalls.length,
      });
      session.events.push({
        id: session.nextEventId++,
        kind: "followup",
        followupId: outcome.id,
        displayName: outcome.displayName,
        text: outcome.text,
        ...(outcome.reasoning === undefined
          ? {}
          : { reasoning: outcome.reasoning }),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        toolCalls: structuredClone(outcome.toolCalls),
        ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      });
      touch(session);
      this.#notifySnapshot(observer, session);
    };
    try {
      await runPlayFollowupRequests({
        artifacts: this.#artifacts,
        controls: this.#worlds.extensionRequests,
        presentations: frozenFollowupPresentations(session),
        modelHost,
        followups,
        bootstrap: currentPlayPrompt(session).bootstrap,
        // Captured once: every followup is dispatched against this exact
        // prefix, so none of them observes another one's prompt or output.
        prefix: structuredClone(session.transcript),
        toolStrategy: currentPlayPrompt(session).bootstrap.toolStrategy,
        context: {
          // A follow-up produces no world endpoint of its own, so it starts and
          // ends on the settled exchange's head. Reconciliation keeps panels
          // bound to this endpoint and retires ones bound to the previous head.
          worldId: session.worldId,
          parentHead: session.parentHead,
          operationId: followupOperationId(session),
          attachment: {
            contextId: session.continuityContextId ?? session.chainId,
            eventId: reply.id,
            head: session.parentHead,
            runId: `${session.chainId}:send:${session.promptRuns?.at(-1)?.firstEventId ?? reply.id}`,
          },
          playPresetId: currentPlayPrompt(session).playPreset.id,
          playPresetRevision: currentPlayPrompt(session).playPreset.revision,
          playPresetScriptsEnabled:
            currentPlayPrompt(session).playPresetScriptsEnabled ?? true,
        },
        head: session.parentHead,
        maxOutputTokens: modelHost.binding().maxOutputTokens,
        signal,
        ...(this.#failureLog === undefined
          ? {}
          : { failureLog: this.#failureLog }),
        observer: {
          onProviderDispatch: () => {
            this.#setInvocationAbortable(session.chainId, true);
            this.#observeInvocation(session.chainId, "followup", {
              dispatches: 1,
            });
            this.#notifySnapshot(observer, session);
          },
          onProviderDelta: observeFollowupDelta,
          onProviderSettled: () =>
            this.#setInvocationAbortable(session.chainId, false),
          onOutcome: record,
        },
      });
    } catch (error: unknown) {
      session.events.push({
        id: session.nextEventId++,
        kind: "failure",
        message:
          error instanceof Error
            ? `Follow-up request failed: ${error.message}`
            : "The follow-up request failed.",
      });
      touch(session);
    }
  }

  async #requireChain(
    worldId: string,
    chainId: string,
  ): Promise<PlayCallChainSession> {
    validateIdentity(chainId, "call-chain ID");
    const active = this.#active.get(chainId);
    if (active !== undefined) {
      if (active.worldId !== worldId)
        throw new PlayCallChainError(
          "The call chain does not belong to this world.",
        );
      await this.#reconcileSessionAdvance(active);
      if (this.#active.get(chainId) === active) return active;
    }
    const session = await this.#loadWorldSession(worldId);
    if (session?.chainId !== chainId)
      throw new PlayCallChainError(
        "The call chain does not exist; start from the latest world state.",
      );
    const currentHead = await this.#worlds.currentHead(worldId);
    if (currentHead !== session.parentHead)
      throw new PlayCallChainError(
        "The call-chain record differs from the current world endpoint; use a fresh context.",
      );
    return session;
  }

  async #bindDocumentMaintenance(
    documents: FileNativePlayDocuments,
    worldId: string,
    head: string,
  ) {
    const inspection = await this.#worlds.inspectDocumentMaintenance(
      worldId,
      head,
    );
    if (inspection.documentMaintenanceUnavailableReason === undefined)
      documents.bindMaintenance(
        inspection.documentMaintenance,
        this.#compiler.locale,
      );
    else
      documents.bindMaintenanceUnavailable(
        inspection.documentMaintenanceUnavailableReason,
        this.#compiler.locale,
      );
    return inspection.documentMaintenance;
  }

  async #hydrateSession(
    persisted: PersistedPlayCallChain,
    advance: PlayAdvanceBase | null,
  ): Promise<PlayCallChainSession> {
    const currentBinding = await this.#worlds.bindPlayCallChain(
      persisted.worldId,
    );
    // A completed chain still describes its own immutable endpoint after a
    // world revision. Restore its reads against that state, not the revised
    // current tree. An in-progress advance reads the current tree; it is
    // interrupted on load and retried against that tree.
    const binding =
      currentBinding.parentHead !== persisted.parentHead && advance === null
        ? await this.#worlds.bindPlayCallChainAt(
            persisted.worldId,
            persisted.parentHead,
          )
        : currentBinding;
    const documents = restorePlayDocuments(
      binding.files,
      persisted,
      persisted.events,
    );
    await this.#bindDocumentMaintenance(
      documents,
      persisted.worldId,
      binding.parentHead,
    );
    return {
      ...cloneSharingPromptRuns(persisted),
      nextMaterials: structuredClone(binding.additionalMaterials),
      documents,
      history: historyEntries(binding.history, binding.historyBackgrounds),
      narrativeCheckpoint: binding.narrativeCheckpoint,
      completedToolMap: new Map(
        persisted.completedTools.map((item) => [
          item.key,
          structuredClone(item),
        ]),
      ),
      persistenceCursor: this.#loadedCursors.get(persisted.chainId) ?? {
        eventCount: 0,
        transcriptCount: 0,
        completedToolCount: 0,
      },
    };
  }

  /**
   * An in-progress advance, or a session still marked running, means a model
   * dispatch or settlement was cut off by a process exit. Nothing is replayed:
   * the exchange is interrupted and the player retries (ADR-0044).
   */
  async #reconcileSessionAdvance(
    session: PlayCallChainSession,
    loaded?: PlayAdvanceBase | null,
  ): Promise<void> {
    const advance =
      loaded === undefined
        ? await this.#worlds.playAdvances.readCurrent(
            session.worldId,
            session.chainId,
          )
        : loaded;
    if (advance === null && session.status !== "running") return;
    // Authority already moved past the persisted parent head: the world cannot
    // be replayed onto that head, so the recovery requires a fresh context.
    const headMoved =
      (await this.#worlds.currentHead(session.worldId)) !== session.parentHead;
    await this.#advances.recoverAbandoned(session, advance, headMoved);
  }

  async #assertCurrentHead(session: PlayCallChainSession): Promise<void> {
    if (
      (await this.#worlds.currentHead(session.worldId)) !== session.parentHead
    )
      throw new PlayCallChainError(
        "Another operation has advanced the current world; use a fresh context.",
      );
  }

  async #readPersisted(
    worldId: string,
  ): Promise<PersistedPlayCallChain | null> {
    await this.#worlds.ensureCurrentStorage(worldId);
    const loaded = await this.#worlds.playTimeline.readCurrent(worldId);
    if (loaded === null) return null;
    this.#loadedCursors.set(loaded.value.chainId, loaded.cursor);
    // A fresh read shares nothing, so it needs no defensive copy.
    return loaded.value;
  }

  /** Makes a session the live one for its world, then trims idle worlds. */
  #registerResident(session: PlayCallChainSession): void {
    this.#active.set(session.chainId, session);
    this.#worldChains.delete(session.worldId);
    this.#worldChains.set(session.worldId, session.chainId);
    this.#enforceResidentLimit();
  }

  #touchWorld(worldId: string): void {
    const chainId = this.#worldChains.get(worldId);
    if (chainId === undefined) return;
    this.#worldChains.delete(worldId);
    this.#worldChains.set(worldId, chainId);
  }

  /**
   * Schedules release of least recently used idle worlds until at most
   * residentWorldLimit remain. The most recently used world is never a
   * candidate. A busy or queued world is skipped, and a later call trims it
   * once it has gone idle.
   */
  #enforceResidentLimit(): void {
    const worldIds = [...this.#worldChains.keys()];
    let excess = worldIds.length - residentWorldLimit - this.#releasing.size;
    for (const worldId of worldIds.slice(0, -1)) {
      if (excess <= 0) return;
      if (this.#releasing.has(worldId)) continue;
      if (
        this.#worlds.operations.pendingWorldOperations(worldId) > 0 ||
        !this.#isIdle(worldId)
      )
        continue;
      excess -= 1;
      this.#releasing.add(worldId);
      void this.#worlds.operations.withWorldAuthorityLock(worldId, () => {
        this.#releaseIfIdle(worldId);
        return Promise.resolve();
      });
    }
  }

  /**
   * Runs in the world's queue slot, so no world operation can hold this
   * session while it is released. An operation queued after the release was
   * scheduled is counted, and the release waits for a later call.
   */
  #releaseIfIdle(worldId: string): void {
    this.#releasing.delete(worldId);
    if (
      this.#worlds.operations.pendingWorldOperations(worldId) > 1 ||
      !this.#isIdle(worldId)
    )
      return;
    const chainId = this.#worldChains.get(worldId);
    if (chainId === undefined) return;
    this.#active.delete(chainId);
    this.#worldChains.delete(worldId);
    this.#loadedCursors.delete(chainId);
  }

  /** No call, hydration, or running request holds this world's session. */
  #isIdle(worldId: string): boolean {
    const chainId = this.#worldChains.get(worldId);
    const session =
      chainId === undefined ? undefined : this.#active.get(chainId);
    if (session === undefined || session.status === "running") return false;
    if (this.#hydrating.has(worldId)) return false;
    return ![...this.#activeInvocations.values()].some(
      (invocation) => invocation.worldId === worldId,
    );
  }

  async #persist(session: PlayCallChainSession): Promise<void> {
    // Only the live session may write. A copy released from memory would fork
    // the world's session; readers that hold one reload on their next step.
    if (this.#active.get(session.chainId) !== session)
      throw new PlayCallChainError(
        "The play context was released from memory; reload it before writing.",
      );
    touch(session);
    session.completedTools = [...session.completedToolMap.values()].map(
      (item) => structuredClone(item),
    );
    const {
      documents: _documents,
      history: _history,
      completedToolMap: _completedToolMap,
      persistenceCursor: _persistenceCursor,
      ...persisted
    } = session;
    void _documents;
    void _history;
    void _completedToolMap;
    void _persistenceCursor;
    session.persistenceCursor = await this.#worlds.playTimeline.persist(
      cloneSharingPromptRuns(persisted),
      session.persistenceCursor,
    );
  }
}

/**
 * One operation per settled exchange. A fresh id makes the artifact store
 * supersede the previous exchange's `new_operation` panels, so it advances with
 * the committed endpoint rather than staying stable for the chain.
 */
function followupOperationId(session: PlayCallChainSession): string {
  return `${session.chainId}:followup:${session.parentHead}`;
}

function createRequest(
  session: PlayCallChainSession,
  modelHost: ModelHost,
  exchange: number,
  locale: AppLocale,
  appended: readonly ModelHostAppendItem[] = session.transcript,
): ModelHostExchange {
  const request = createRequestWithMaxOutputTokens(
    session,
    modelHost.binding().maxOutputTokens,
    exchange,
    locale,
    appended,
  );
  return modelHost.freezeRequest?.(request) ?? request;
}

function createRequestWithMaxOutputTokens(
  session: Pick<
    PlayCallChainSession,
    | "bootstrap"
    | "tools"
    | "transcript"
    | "chainId"
    | "promptRuns"
    | "playPreset"
    | "followups"
    | "playPresetScriptsEnabled"
    | "turnNote"
  >,
  maxOutputTokens: number,
  exchange: number,
  locale: AppLocale,
  appended: readonly ModelHostAppendItem[] = session.transcript,
): ModelHostExchange {
  // The turn guide is a request-level suffix: it follows whatever this
  // dispatch appends and is never part of the transcript it is built on. The
  // player's one-turn request joins the suffix here, not in the bootstrap, so
  // the bootstrap snapshot stays shared by every dispatch of the turn.
  const turnGuide = turnGuideWithTurnNote(
    locale,
    currentPlayPrompt(session).bootstrap.turnGuide,
    session.turnNote,
  );
  return {
    bootstrap: structuredClone(currentPlayPrompt(session).bootstrap),
    tools: structuredClone(currentPlayPrompt(session).tools),
    toolUniverse: structuredClone(currentPlayPrompt(session).tools),
    allowedTools: currentPlayPrompt(session).tools.map(({ name }) => name),
    toolStrategy: currentPlayPrompt(session).bootstrap.toolStrategy,
    appended: structuredClone([
      ...appended,
      ...(turnGuide === undefined ? [] : [turnGuideNotice(turnGuide.text)]),
    ]),
    requestId: "play_call_chain",
    operationId: session.chainId,
    requestAttempt: 1,
    exchange,
    maxOutputTokens,
  };
}

/**
 * The items a frozen request contributes to the transcript: everything it
 * appended except the request-level turn-guide suffix, which is re-attached to
 * every dispatch and never stored.
 */
function transcriptAppendOf(
  request: Pick<ModelHostExchange, "appended">,
): readonly ModelHostAppendItem[] {
  const last = request.appended.at(-1);
  return last?.kind === "runtime_notice" && last.notice === "turn_guide"
    ? request.appended.slice(0, -1)
    : request.appended;
}

type DurableModelHostResponse = Omit<ModelHostResponse, "diagnostics">;

function durableModelResponse(
  response: ModelHostResponse,
): DurableModelHostResponse {
  const { diagnostics: _diagnostics, ...durable } = response;
  void _diagnostics;
  return structuredClone(durable);
}

/**
 * Copies each committed write's receipt into the tool results that report it,
 * then drops the candidate write. Receipts state what the commit made true.
 */
function finalizeWriteReceipts(settlement: {
  stateChanges: FileNativeStateChange[];
  completedTools: PersistedCompletedToolCall[];
  trailingEvents: V1PlayCallChainEvent[];
  transcriptAppend: ModelHostAppendItem[];
}): void {
  const committedWriteRefs = new Set(
    settlement.stateChanges.map(({ stableShortRef }) => stableShortRef),
  );
  const markdownByCall = new Map<string, string>();
  for (const completed of settlement.completedTools) {
    const candidateWrite = completed.result.candidateWrite;
    if (!completed.result.ok || candidateWrite === undefined) continue;
    const status =
      candidateWrite.changed && committedWriteRefs.has(candidateWrite.shortRef)
        ? `@${candidateWrite.shortRef} write succeeded`
        : `@${candidateWrite.shortRef} unchanged`;
    const markdown = [status, candidateWrite.sizeAdvice]
      .filter(Boolean)
      .join("\n");
    completed.result.markdown = markdown;
    delete completed.result.candidateWrite;
    const callId = completed.key.slice(completed.key.indexOf(":") + 1);
    markdownByCall.set(callId, markdown);
  }
  for (const event of settlement.trailingEvents) {
    if (event.kind !== "tool_result") continue;
    const markdown = markdownByCall.get(event.callId);
    if (markdown !== undefined) event.markdown = markdown;
  }
  for (const item of settlement.transcriptAppend) {
    if (item.kind !== "tool") continue;
    const markdown = markdownByCall.get(item.toolCallId);
    if (markdown !== undefined) item.markdown = markdown;
  }
}

function appendCommittedHistory(
  session: Pick<PlayCallChainSession, "history">,
  head: string,
  messages: readonly {
    role: "player" | "narrator";
    exactText: string;
    background?: HistoryBackground;
  }[],
): void {
  const sequence = Number(head.slice("commit:".length));
  for (const [index, message] of messages.entries()) {
    const path = `message.${sequence}.${index + 1}.${message.role}`;
    const existing = session.history.find((item) => item.path === path);
    if (existing !== undefined) {
      if (
        existing.contents !== message.exactText ||
        !isDeepStrictEqual(existing.background, message.background)
      )
        throw new PlayCallChainError(
          "Recovered Authority history conflicts with the call-chain history.",
        );
      continue;
    }
    session.history.push({
      path,
      contents: message.exactText,
      ...(message.background === undefined
        ? {}
        : { background: structuredClone(message.background) }),
    });
  }
}

function prepareTool(
  session: PlayCallChainSession,
  working: Map<string, CompletedToolCall>,
  exchange: number,
  call: ModelHostToolCall,
  locale: AppLocale,
  resolutionSeed: string | undefined,
): PreparedToolResult {
  const key = `${exchange}:${call.id}`;
  const signature = JSON.stringify(call.arguments);
  const provided = currentPlayPrompt(session).tools.map(({ name }) => name);
  const resolved = resolveToolName(call.name, provided);
  // The executed name, not the model's spelling, decides replay identity.
  const executedName = resolved.kind === "rejected" ? call.name : resolved.name;
  const completed = working.get(key);
  let result: PlayDocumentToolResult;
  let replayed = false;
  if (completed !== undefined) {
    replayed = true;
    result =
      completed.name === executedName && completed.signature === signature
        ? structuredClone(completed.result)
        : {
            ok: false,
            failureKind: "protocol",
            markdown:
              "# Runtime tool rejected\n\nThe same tool-call ID is already bound to another tool name or argument set.",
          };
  } else if (
    resolved.kind === "rejected" ||
    !callChainToolNames.has(executedName)
  ) {
    result = {
      ok: false,
      failureKind: "protocol",
      markdown: `# Runtime tool rejected\n\nThe current call chain does not provide ${call.name}. Available tools: ${provided.join(", ")}.`,
    };
  } else {
    try {
      result = isResolutionTool(executedName)
        ? resolutionToolResult(
            executedName,
            call.arguments,
            resolutionSeed,
            key,
            locale,
          )
        : executedName === "world_checkpoint"
          ? typeof call.arguments === "object" &&
            call.arguments !== null &&
            !Array.isArray(call.arguments) &&
            Object.keys(call.arguments).length === 0
            ? {
                ok: true,
                markdown:
                  locale === "zh-CN"
                    ? "检查点已登记；随后非空且无工具调用的最终正文成功提交后生效，边界包含该正文。它仅标记历史重放边界，不结束世界内事件；登记后仍可继续调用工具。玩家随后可自行选择全新上下文。"
                    : "Checkpoint registered. It takes effect after the subsequent nonempty tool-free final prose successfully commits, including that prose in its boundary. It marks a history-replay boundary without ending an in-world event; further tool calls may follow registration. The player may then choose a fresh context.",
              }
            : {
                ok: false,
                failureKind: "protocol",
                markdown: "world_checkpoint requires an empty argument object.",
              }
          : session.documents.execute(
              { ...call, name: executedName },
              session.history,
              {
                historyScope: session.worldId,
                locale,
                legacyHistoryTools: hasLegacyHistoryTools(
                  currentPlayPrompt(session).tools,
                ),
              },
            );
    } catch (error: unknown) {
      result = {
        ok: false,
        failureKind: "protocol",
        markdown: `# Runtime tool failed\n\n${error instanceof Error ? error.message : "Tool execution failed."}`,
      };
    }
    if (resolved.kind === "alias")
      result = {
        ...result,
        markdown: `${result.markdown}\n\n${renderToolAliasNote(
          call.name,
          executedName,
          locale,
        )}`,
      };
    working.set(key, {
      key,
      name: executedName,
      signature,
      result: structuredClone(result),
    });
  }
  const event: Extract<V1PlayCallChainEvent, { kind: "tool_result" }> = {
    id: 0,
    kind: "tool_result",
    callId: call.id,
    name: call.name,
    ...(executedName === call.name ? {} : { executedName }),
    ok: result.ok,
    markdown: result.markdown,
    ...(result.resolution === undefined
      ? {}
      : { resolution: structuredClone(result.resolution) }),
    replayed,
  };
  return {
    call,
    key,
    result,
    replayed,
    event,
    transcript: {
      kind: "tool",
      toolCallId: call.id,
      markdown: result.markdown,
      ...(result.ok ? {} : { isError: true }),
    },
  };
}

function duplicatePlayerExchange(
  session: Pick<PersistedPlayCallChain, "events">,
  exchangeId: string,
  playerText: string,
  context: "fresh" | "append",
): boolean {
  const existing = session.events.find(
    (event): event is Extract<V1PlayCallChainEvent, { kind: "player" }> =>
      event.kind === "player" && event.exchangeId === exchangeId,
  );
  if (existing === undefined) return false;
  if (existing.text !== playerText || existing.context !== context)
    throw new PlayCallChainError(
      "The same exchange ID is already bound to different player text or a different context mode.",
    );
  return true;
}

function mergeChangedDocuments(
  session: PlayCallChainSession,
  changes: readonly FileNativeStateChange[],
): void {
  for (const change of changes) {
    const projected = {
      kind: change.kind,
      ref: `@${change.stableShortRef}`,
      path: change.relativePath,
    } as const;
    const index = session.changedDocuments.findIndex(
      ({ path }) => path === projected.path,
    );
    if (index < 0) session.changedDocuments.push(projected);
    else session.changedDocuments[index] = projected;
  }
}

function projectContext(
  context: PersistedPlayCallChainContext,
): V1PlayCallChainContextView {
  const response = context.events.findLast(
    (event) => event.kind === "assistant" && event.status === "completed",
  );
  return {
    ...(context.importedFromArchive ? { requiresFreshContext: true } : {}),
    chainId: context.chainId,
    baselineHead: context.baselineHead,
    ...(context.baselineHistoryLength === undefined
      ? {}
      : { baselineHistoryLength: context.baselineHistoryLength }),
    parentHead: context.parentHead,
    playPreset: structuredClone(recordedPlayPrompt(context).playPreset),
    ...(context.modelBinding === undefined
      ? {}
      : {
          contextWindowTokens:
            context.lastRequest?.modelConfig?.contextWindowTokens ??
            context.modelBinding.contextWindowTokens,
        }),
    ...(response?.kind !== "assistant"
      ? {}
      : {
          latestCompletedResponse: {
            id: response.id,
            ...(response.usage === undefined
              ? {}
              : { usage: structuredClone(response.usage) }),
          },
        }),
    status: context.status,
    canRetry: context.canRetry,
    events: context.events
      .slice(-projectedEventTail)
      .map((event) => projectActivityEvent(event)),
    changedDocuments: structuredClone(context.changedDocuments),
    lastFailure: context.lastFailure,
    ...(context.lastFailureKind === undefined
      ? {}
      : { lastFailureKind: context.lastFailureKind }),
    updatedAt: context.updatedAt,
  };
}

function projectActivityEvent(
  event: V1PlayCallChainEvent,
): V1PlayCallChainEvent {
  if (
    event.kind === "player" ||
    event.kind === "failure" ||
    event.kind === "cancellation"
  )
    return structuredClone(projectLegacyModelBindingFailure(event));
  if (event.kind === "assistant") {
    const { reasoning, toolFragment, usage, ...summary } = event;
    void reasoning;
    void toolFragment;
    void usage;
    return structuredClone(summary);
  }
  if (event.kind === "tool_call")
    return { ...structuredClone(event), arguments: null };
  if (event.kind === "tool_result")
    return { ...structuredClone(event), markdown: "" };
  const { reasoning, usage, ...summary } = event;
  void reasoning;
  void usage;
  return {
    ...structuredClone(summary),
    text: "",
    toolCalls: event.toolCalls.map((call) => ({
      ...structuredClone(call),
      arguments: null,
      markdown: "",
    })),
  };
}

function projectView(session: PersistedPlayCallChain): V1PlayCallChainView {
  return {
    ...projectContext(session),
    worldId: session.worldId,
    previousContexts: (session.previousContexts ?? []).map((context) =>
      projectContext(context),
    ),
    ...(lastEndingCancelled(session) ? { lastCancelled: true as const } : {}),
  };
}

function projectContextReads(
  session: PersistedPlayCallChain,
): NonNullable<V1PlayContextReadingView["currentContext"]>["reads"] {
  const completed = new Map(
    session.completedTools.map((tool) => [tool.key, tool.result]),
  );
  let exchange = 0;
  const calls = new Map<string, { key: string; ref: string }>();
  const reads: NonNullable<
    V1PlayContextReadingView["currentContext"]
  >["reads"] = [];
  for (const event of session.events) {
    if (event.kind === "assistant") {
      exchange = event.exchange;
      continue;
    }
    if (
      event.kind === "tool_call" &&
      (event.executedName ?? event.name) === "context_read"
    ) {
      const ref =
        isRecord(event.arguments) && typeof event.arguments.ref === "string"
          ? event.arguments.ref
          : "(invalid ref)";
      calls.set(event.callId, {
        key: `${exchange}:${event.callId}`,
        ref,
      });
      continue;
    }
    if (
      event.kind !== "tool_result" ||
      (event.executedName ?? event.name) !== "context_read"
    )
      continue;
    const call = calls.get(event.callId);
    if (call === undefined) continue;
    const result = completed.get(call.key);
    reads.push({
      eventId: event.id,
      callId: event.callId,
      ref: call.ref,
      ok: event.ok,
      complete:
        result === undefined ? null : completedContextReadIsComplete(result),
      markdown: result?.markdown ?? null,
      locator: result?.readAuthorization?.locator ?? null,
    });
  }
  return reads;
}

function completedContextReadIsComplete(
  result: PersistedPlayCallChain["completedTools"][number]["result"],
): boolean {
  if (result.readAuthorization === undefined)
    return /(?:^|\n)Complete: yes(?:\n|$)/u.test(result.markdown);
  const legacyAuthorization: unknown = result.readAuthorization;
  if (!isRecord(legacyAuthorization) || !isRecord(legacyAuthorization.page))
    return true;
  return (
    typeof legacyAuthorization.page.end === "number" &&
    typeof legacyAuthorization.page.total === "number" &&
    legacyAuthorization.page.end === legacyAuthorization.page.total
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventsThroughHead(
  events: readonly V1PlayCallChainEvent[],
  head: string,
): V1PlayCallChainEvent[] | null {
  const selectedIndex = events.findIndex(
    (event) =>
      (event.kind === "player" || event.kind === "assistant") &&
      event.committedHead === head,
  );
  if (selectedIndex < 0) return null;
  let end = selectedIndex + 1;
  if (events[selectedIndex]?.kind === "assistant")
    while (
      events[end]?.kind === "tool_call" ||
      events[end]?.kind === "tool_result"
    )
      end += 1;
  return structuredClone(events.slice(0, end));
}

function derivedChainId(
  sourceChainId: string,
  branchIdentity: string,
  targetWorldId: string,
): string {
  return `play-branch-${createHash("sha256")
    .update(`${sourceChainId}\0${branchIdentity}\0${targetWorldId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function playerRevisionRestoresHead(
  source: Pick<PersistedPlayCallChainContext, "baselineHead" | "events">,
  selectedEventIndex: number,
): string {
  let restoresHead = source.baselineHead;
  for (const event of source.events.slice(0, selectedEventIndex))
    if (
      (event.kind === "player" || event.kind === "assistant") &&
      event.committedHead !== undefined
    )
      restoresHead = event.committedHead;
  return restoresHead;
}

function revisionChainId(
  sourceChainId: string,
  operationId: string,
  worldId: string,
  continuation: PlayCallChainRevisionInput["continuation"],
): string {
  return derivedChainId(
    sourceChainId,
    `${continuation === "fresh_context" ? "timeline-revision-fresh" : "timeline-revision"}:${operationId}`,
    worldId,
  );
}

function revisionTimelineGeneration(
  sourceGeneration: string,
  operationId: string,
  worldId: string,
  continuation: PlayCallChainRevisionInput["continuation"],
): string {
  return `timeline:${createHash("sha256")
    .update(
      JSON.stringify({
        schema: "narraeon.player-revision-timeline-generation/v1",
        sourceGeneration,
        operationId,
        worldId,
        continuation,
      }),
    )
    .digest("hex")
    .slice(0, 40)}`;
}

function historyEntries(
  history: Readonly<Record<string, string>>,
  backgrounds: Readonly<Record<string, HistoryBackground>> = {},
): { path: string; contents: string; background?: HistoryBackground }[] {
  return Object.entries(history).map(([path, contents]) => ({
    path,
    contents,
    ...(backgrounds[path] === undefined
      ? {}
      : { background: structuredClone(backgrounds[path]) }),
  }));
}

function operationId(chainId: string, key: string): string {
  return `play-${createHash("sha256")
    .update(`${chainId}\0${key}`)
    .digest("hex")}`;
}

function assertModelHostBinding(
  frozen: ModelHostBinding,
  modelHost: ModelHost,
): void {
  if (!equalModelHostBinding(frozen, modelHost.binding()))
    throw new PlayCallChainError(
      "The selected model connection does not match the frozen model binding; start a fresh context.",
    );
}

function assertSessionModelHostBinding(
  session: PersistedPlayCallChain,
  modelHost: ModelHost,
): void {
  if (session.modelBinding === undefined)
    throw new PlayCallChainError(
      "This model context predates durable provider continuation bindings; start a fresh context.",
    );
  if (session.modelBinding.provider !== modelHost.binding().provider)
    throw new PlayCallChainError(
      "The selected model protocol differs from this context. Switch back to its original protocol to continue, or start a fresh context.",
      "model_protocol_mismatch",
    );
}

function validateIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value))
    throw new PlayCallChainError(`${label} is invalid.`);
}

function validatePlayerText(value: string): void {
  if (value.trim().length === 0)
    throw new PlayCallChainError("Player text must not be empty.");
}

/**
 * The player's one-turn request: one line, bounded like a turn-guide line.
 * Blank input means no request. Length beyond the soft limit is only warned
 * about by the client and Prompt Preview, never rejected here.
 */
function validTurnNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isTurnGuideLine(value))
    throw new PlayCallChainError(
      "The turn request must be a single line of at most 1000 characters.",
    );
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function setTurnNote(
  session: { turnNote?: string },
  turnNote: string | undefined,
): void {
  if (turnNote === undefined) delete session.turnNote;
  else session.turnNote = turnNote;
}

function turnNoteField(turnNote: string | undefined): { turnNote?: string } {
  return turnNote === undefined ? {} : { turnNote };
}

function touch(session: Pick<PersistedPlayCallChain, "updatedAt">): void {
  session.updatedAt = Date.now();
}

function notifyAssistantDelta(
  observer: PlayCallChainObserver | undefined,
  delta: Parameters<NonNullable<PlayCallChainObserver["onAssistantDelta"]>>[0],
): void {
  try {
    observer?.onAssistantDelta?.(structuredClone(delta));
  } catch {
    // Like snapshot projection, the Provider exchange outlives its browser stream.
  }
}

function resolutionToolResult(
  name: ResolutionToolName,
  args: unknown,
  seed: string | undefined,
  identity: string,
  locale: AppLocale,
): PlayDocumentToolResult {
  if (seed === undefined)
    throw new Error("The resolution seed for this advance is unavailable.");
  const resolution = resolveTabletop(name, args, seededRandom(seed, identity));
  return {
    ok: true,
    markdown: resolutionMarkdown(resolution, locale),
    resolution,
  };
}

function frozenFollowupPresentations(
  session: PlayCallChainSession,
): Record<string, Record<string, FrozenArtifactPresentation>> {
  const files = session.promptRuns?.at(-1)?.presetFiles ?? session.presetFiles;
  if (files === undefined) return {};
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  const definition = parsed.definition;
  return Object.fromEntries(
    (currentPlayPrompt(session).followups ?? []).map((followup) => [
      followup.id,
      Object.fromEntries(
        followup.artifacts.flatMap((declaration) => {
          const resources = followup.frozenResources;
          const mount =
            resources?.mount ??
            definition.mounts.find(
              (item) => item.channel === declaration.channel,
            )?.mount;
          return mount === undefined
            ? []
            : [
                [
                  declaration.name,
                  {
                    ...resources,
                    declaration: structuredClone(declaration),
                    files:
                      resources?.files ??
                      Object.fromEntries(
                        [
                          declaration.renderer,
                          declaration.regex,
                          ...(declaration.scripts ?? []),
                          ...(declaration.assets ?? []),
                        ].flatMap((path) =>
                          path === undefined
                            ? []
                            : [[path, (resources?.files ?? files)[path]!]],
                        ),
                      ),
                    mount,
                  },
                ],
              ];
        }),
      ),
    ]),
  );
}
