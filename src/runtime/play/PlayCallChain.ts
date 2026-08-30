import { createHash } from "node:crypto";

import type {
  V1PlayCallChainContextView,
  V1PlayCallChainEvent,
  V1PlayCallChainView,
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
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "../model/ModelHost.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativePlayBinding,
  FileNativeStateChange,
  FileNativeWorldSummary,
  FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";
import type { ArtifactStore } from "../artifact/FileNativeArtifactStore.ts";
import type { PlayPresetBinding } from "./FileNativePlayPresetStore.ts";
import {
  runPlayFollowupRequests,
  type PlayFollowupOutcome,
} from "./PlayFollowupRequests.ts";
import {
  FileNativePlayDocuments,
  fingerprintControl,
  type PlayDocumentAuthorizationCheckpoint,
  type PlayDocumentToolResult,
} from "./PlayDocumentTools.ts";
import type { AiFailureRecorder } from "../model/AiFailureLog.ts";
import type {
  PersistedCompletedToolCall,
  PersistedDocumentAuthorizationCheckpoint,
  PersistedPlayCallChain,
  PersistedPlayCallChainContext,
  PlayContextPersistenceCursor,
} from "./FileNativePlayTimelineStore.ts";
import type {
  DurableModelHostResponse,
  LoadedPlayAdvance,
  PlayAdvanceBase,
  PreparedPlayResponseSettlement,
} from "./FileNativePlayAdvanceStore.ts";

const callChainToolNames = new Set([
  "state_list",
  "history_list",
  // Kept executable only for contexts whose frozen tool universe contains it.
  "context_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
]);
const projectedEventTail = 40;

type CompletedToolCall = PersistedCompletedToolCall;

interface PlayCallChainSession extends PersistedPlayCallChain {
  documentAuthorizationCheckpoints: PersistedDocumentAuthorizationCheckpoint[];
  documents: FileNativePlayDocuments;
  history: { path: string; contents: string }[];
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

export class PlayCallChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayCallChainError";
  }
}

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
  readonly #worlds: FileNativeWorldStore;
  readonly #compiler: FileNativePromptCompiler;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #active = new Map<string, PlayCallChainSession>();
  readonly #worldChains = new Map<string, string>();
  readonly #loadedCursors = new Map<string, PlayContextPersistenceCursor>();

  constructor(
    worlds: FileNativeWorldStore,
    compiler: FileNativePromptCompiler = new FileNativePromptCompiler(),
    artifacts?: ArtifactStore,
    failureLog?: AiFailureRecorder,
  ) {
    this.#worlds = worlds;
    this.#compiler = compiler;
    this.#artifacts = artifacts;
    this.#failureLog = failureLog;
  }

  async start(input: {
    worldId: string;
    chainId: string;
    exchangeId: string;
    playerText: string;
    hostBinding: FileNativePromptInput["hostBinding"];
    playPreset: PlayPresetBinding;
    modelBinding: ModelHostBinding;
    modelHost: ModelHost;
    observer?: PlayCallChainObserver;
  }): Promise<V1PlayCallChainView> {
    validateIdentity(input.chainId, "call-chain ID");
    validateIdentity(input.exchangeId, "exchange ID");
    validatePlayerText(input.playerText);
    assertModelHostBinding(input.modelBinding, input.modelHost);

    const existing = await this.#readPersisted(input.worldId);
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
    const documents = new FileNativePlayDocuments(binding.files);
    const compilation = this.#compiler.compilePlayCallChain(
      {
        endpoint: {
          id: `${input.worldId}:${binding.parentHead}`,
          commit: binding.parentHead,
        },
        hostBinding: structuredClone(input.hostBinding),
        world: {
          controlFingerprint: fingerprintControl(binding.files),
          documentSnapshot: documents.snapshot,
          additionalMaterials: structuredClone(binding.additionalMaterials),
          history: structuredClone(binding.history),
        },
        playerInputPlacement: "append",
        playerInput: input.playerText,
        modelBinding: structuredClone(input.modelBinding),
      },
      input.playPreset,
    );
    const tools = structuredClone(compilation.toolUniverse);
    const bootstrap: PromptCompilation = structuredClone(compilation.bootstrap);
    documents.bindBootstrap(bootstrap);
    const now = Date.now();
    const session: PlayCallChainSession = {
      schemaVersion: 3,
      kind: "play_call_chain",
      chainId: input.chainId,
      worldId: input.worldId,
      previousContexts: [],
      previousChainId: existing?.chainId ?? null,
      timelineGeneration:
        existing?.timelineGeneration ??
        this.#worlds.playTimeline.newGeneration(),
      baselineHead: binding.parentHead,
      baselineHistoryLength: Object.keys(binding.history).length,
      parentHead: binding.parentHead,
      playPreset: {
        id: input.playPreset.id,
        name: input.playPreset.name,
        revision: input.playPreset.revision,
      },
      followups: structuredClone(compilation.followups ?? []),
      playPresetScriptsEnabled: input.playPreset.scriptsEnabled,
      modelBinding: structuredClone(input.modelBinding),
      status: "ready",
      canRetry: false,
      bootstrap,
      tools: structuredClone(tools),
      transcript: [],
      events: [],
      completedTools: [],
      documentAuthorizationCheckpoints: [
        {
          afterEventId: 0,
          authorization: documents.authorizationCheckpoint(),
        },
      ],
      changedDocuments: [],
      nextMaterials: structuredClone(binding.additionalMaterials),
      nextEventId: 1,
      exchange: 0,
      lastRequest: null,
      lastRequestAttempt: 0,
      lastFailure: null,
      updatedAt: now,
      documents,
      history: historyEntries(binding.history),
      completedToolMap: new Map(),
      persistenceCursor: {
        eventCount: 0,
        transcriptCount: 0,
        completedToolCount: 0,
        authorizationCheckpointCount: 0,
      },
    };
    if (activeId !== undefined) this.#active.delete(activeId);
    this.#active.set(session.chainId, session);
    this.#worldChains.set(session.worldId, session.chainId);
    await this.#persist(session);
    return this.#submitPlayer(
      session,
      input.exchangeId,
      input.playerText,
      "fresh",
      input.modelHost,
      input.observer,
    );
  }

  async append(input: {
    worldId: string;
    chainId: string;
    exchangeId: string;
    playerText: string;
    modelHost: ModelHost;
    observer?: PlayCallChainObserver;
  }): Promise<V1PlayCallChainView> {
    validateIdentity(input.exchangeId, "exchange ID");
    const session = await this.#requireChain(input.worldId, input.chainId);
    await this.#assertCurrentHead(session);
    assertSessionModelHostBinding(session, input.modelHost);
    if (input.playerText.trim().length === 0) {
      if (session.status === "running")
        throw new PlayCallChainError("A model request is still running.");
      if (session.status === "interrupted") {
        if (!session.canRetry || session.lastRequest === null)
          throw new PlayCallChainError(
            "Call-chain processing failed, and there is no model context to continue.",
          );
        return this.#dispatch(
          session,
          input.modelHost,
          structuredClone(session.lastRequest),
          session.lastRequestAttempt + 1,
          input.observer,
        );
      }
      session.exchange += 1;
      return this.#dispatch(
        session,
        input.modelHost,
        createRequest(session, input.modelHost, session.exchange),
        1,
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
    return this.#submitPlayer(
      session,
      input.exchangeId,
      input.playerText,
      "append",
      input.modelHost,
      input.observer,
    );
  }

  async inspectWorld(worldId: string): Promise<V1PlayCallChainView | null> {
    const activeId = this.#worldChains.get(worldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active !== undefined) {
      await this.#reconcileSessionAdvance(active);
      return projectView(active);
    }
    const persisted = await this.#readPersisted(worldId);
    if (persisted === null) return null;
    const advance = await this.#worlds.playAdvances.readCurrent(
      worldId,
      persisted.chainId,
    );
    const session = await this.#hydrateSession(persisted, advance);
    this.#active.set(session.chainId, session);
    this.#worldChains.set(worldId, session.chainId);
    await this.#reconcileSessionAdvance(session, advance);
    if (session.status === "running")
      await this.#interruptAbandonedDispatch(session);
    return projectView(session);
  }

  async deriveWorld(input: {
    operationId: string;
    sourceWorldId: string;
    sourceHead: string;
    hostPresetId: string;
  }): Promise<{ outcome: "derived"; world: FileNativeWorldSummary }> {
    const result = await this.#worlds.deriveWorld({
      ...input,
      stageTarget: async ({ targetWorldRoot, targetWorldId, binding }) => {
        await this.stageForkToDerivedWorld({
          sourceWorldId: input.sourceWorldId,
          sourceHead: input.sourceHead,
          targetWorldId,
          targetWorldRoot,
          targetBinding: binding,
        });
      },
    });
    if ((await this.inspectWorld(result.world.worldId)) === null)
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
    const source = await this.#readPersisted(input.sourceWorldId);
    if (source === null) return null;
    const sourceContexts = await this.#worlds.playTimeline.readAllContexts(
      input.sourceWorldId,
    );
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
  }): Promise<V1PlayCallChainView | null> {
    const source = await this.#readPersisted(input.sourceWorldId);
    if (source === null) return null;
    const sourceContexts = await this.#worlds.playTimeline.readAllContexts(
      input.sourceWorldId,
    );
    const selectedContextIndex = sourceContexts.findIndex(
      ({ events }) => eventsThroughHead(events, input.sourceHead) !== null,
    );
    if (selectedContextIndex < 0) return null;
    const sourceEvents = eventsThroughHead(
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
    });
  }

  /**
   * Revise one committed player message in place. Authority remains
   * append-only: one timeline-revision commit restores the player's logical
   * parent snapshot and appends the replacement text atomically.
   */
  async revisePlayer(input: {
    operationId: string;
    worldId: string;
    chainId: string;
    eventId: number;
    replacementExchangeId: string;
    replacementText: string;
  }): Promise<{
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

    const source = await this.#readPersisted(input.worldId);
    if (source === null)
      throw new PlayCallChainError(
        "The current world has no model call chain to revise.",
      );
    const sourceContexts = await this.#worlds.playTimeline.readAllContexts(
      input.worldId,
    );
    const appliedEvent = sourceContexts
      .flatMap(({ events }) => events)
      .find(
        (
          event,
        ): event is Extract<V1PlayCallChainEvent, { kind: "player" }> & {
          committedHead: string;
        } =>
          event.kind === "player" &&
          event.exchangeId === input.replacementExchangeId &&
          event.committedHead !== undefined,
      );
    if (appliedEvent !== undefined) {
      if (appliedEvent.text !== input.replacementText)
        throw new PlayCallChainError(
          "The same replacement exchange ID is already bound to different player text.",
        );
      const authority = await this.#worlds.readAuthorityHistory(input.worldId);
      const commit = authority.commits.find(
        ({ head }) => head === appliedEvent.committedHead,
      );
      const operation = await this.#worlds.getOperationOutcome(
        input.operationId,
      );
      if (
        commit?.mode !== "timeline_revision" ||
        (operation.outcome !== "committed" &&
          operation.outcome !== "committed_materialization_pending") ||
        operation.worldId !== input.worldId ||
        operation.head !== appliedEvent.committedHead
      )
        throw new PlayCallChainError(
          "The replacement exchange ID is already used by another commit.",
        );
      return {
        outcome: "revised",
        worldId: input.worldId,
        playCallChain: projectView(source),
      };
    }
    const selectedContextIndex = sourceContexts.findIndex(
      ({ chainId }) => chainId === input.chainId,
    );
    if (selectedContextIndex < 0)
      throw new PlayCallChainError(
        "The model context to revise does not exist.",
      );
    const sourceContext = sourceContexts[selectedContextIndex]!;
    const selectedEventIndex = sourceContext.events.findIndex(
      (event) => event.id === input.eventId,
    );
    const selectedEvent = sourceContext.events[selectedEventIndex];
    if (
      selectedEventIndex < 0 ||
      selectedEvent?.kind !== "player" ||
      selectedEvent.committedHead === undefined
    )
      throw new PlayCallChainError(
        "The selected event is not a committed player message.",
      );

    return this.#applyPlayerRevision({
      request: input,
      source,
      sourceContexts,
      selectedContextIndex,
      selectedEventIndex,
      selectedEvent: {
        ...selectedEvent,
        committedHead: selectedEvent.committedHead,
      },
    });
  }

  async #applyPlayerRevision(input: {
    request: {
      operationId: string;
      worldId: string;
      chainId: string;
      eventId: number;
      replacementExchangeId: string;
      replacementText: string;
    };
    source: PersistedPlayCallChain;
    sourceContexts: PersistedPlayCallChainContext[];
    selectedContextIndex: number;
    selectedEventIndex: number;
    selectedEvent: Extract<V1PlayCallChainEvent, { kind: "player" }> & {
      committedHead: string;
    };
  }): Promise<{
    outcome: "revised";
    worldId: string;
    playCallChain: V1PlayCallChainView;
  }> {
    const request = input.request;
    const sourceContext = input.sourceContexts[input.selectedContextIndex]!;
    let restoresHead = sourceContext.baselineHead;
    for (const event of sourceContext.events.slice(0, input.selectedEventIndex))
      if (
        (event.kind === "player" || event.kind === "assistant") &&
        event.committedHead !== undefined
      )
        restoresHead = event.committedHead;

    const requestFingerprint =
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify({
            schema: "narraeon.timeline-revision-request/v1",
            chainId: request.chainId,
            eventId: request.eventId,
            selectedHead: input.selectedEvent.committedHead,
            restoresHead,
            replacementExchangeId: request.replacementExchangeId,
            replacementText: request.replacementText,
          }),
        )
        .digest("hex");
    const outcome = await this.#worlds.reviseTimeline({
      operationId: request.operationId,
      worldId: request.worldId,
      expectedCurrentHead: input.source.parentHead,
      restoresHead,
      replacesHead: input.selectedEvent.committedHead,
      replacementText: request.replacementText,
      requestFingerprint,
    });

    const prefixEvents = structuredClone(
      sourceContext.events.slice(0, input.selectedEventIndex),
    );
    const transcript = transcriptThroughEvents(
      sourceContext.transcript,
      prefixEvents,
    );
    transcript.push({ kind: "player", text: request.replacementText });
    const events: V1PlayCallChainEvent[] = [
      ...prefixEvents,
      {
        id: input.selectedEvent.id,
        kind: "player",
        exchangeId: request.replacementExchangeId,
        text: request.replacementText,
        context: input.selectedEvent.context,
        committedHead: outcome.head,
      },
    ];
    const completedKeys = completedToolKeys(prefixEvents);
    const [baseline, selected, binding] = await Promise.all([
      this.#worlds.recoverEndpoint(request.worldId, sourceContext.baselineHead),
      this.#worlds.recoverEndpoint(request.worldId, restoresHead),
      this.#worlds.bindPlayCallChain(request.worldId),
    ]);
    if (binding.parentHead !== outcome.head)
      throw new PlayCallChainError(
        "The timeline revision was committed, but current-world materialization has not reached the new endpoint.",
      );
    const documents = restorePlayDocuments(
      binding.files,
      sourceContext,
      prefixEvents,
    );
    const revised: PersistedPlayCallChain = {
      schemaVersion: 3,
      kind: "play_call_chain",
      chainId: derivedChainId(
        sourceContext.chainId,
        "timeline-revision:" + request.operationId,
        request.worldId,
      ),
      worldId: request.worldId,
      previousContexts: [],
      previousChainId:
        input.selectedContextIndex === 0
          ? null
          : input.sourceContexts[input.selectedContextIndex - 1]!.chainId,
      timelineGeneration: this.#worlds.playTimeline.newGeneration(),
      baselineHead: sourceContext.baselineHead,
      baselineHistoryLength:
        sourceContext.baselineHistoryLength ?? baseline.history.length,
      parentHead: outcome.head,
      playPreset: structuredClone(sourceContext.playPreset),
      ...(sourceContext.followups === undefined
        ? {}
        : { followups: structuredClone(sourceContext.followups) }),
      ...(sourceContext.playPresetScriptsEnabled === undefined
        ? {}
        : {
            playPresetScriptsEnabled: sourceContext.playPresetScriptsEnabled,
          }),
      ...(sourceContext.modelBinding === undefined
        ? {}
        : { modelBinding: structuredClone(sourceContext.modelBinding) }),
      status: "ready",
      canRetry: false,
      bootstrap: structuredClone(sourceContext.bootstrap),
      tools: structuredClone(sourceContext.tools),
      transcript,
      events,
      completedTools: sourceContext.completedTools
        .filter(({ key }) => completedKeys.has(key))
        .map((item) => structuredClone(item)),
      documentAuthorizationCheckpoints: authorizationCheckpointsThroughEvents(
        sourceContext,
        events,
        documents.authorizationCheckpoint(),
      ),
      changedDocuments: changedDocumentsAtHead(
        sourceContext.changedDocuments,
        baseline.state,
        selected.state,
      ),
      nextMaterials: structuredClone(binding.additionalMaterials),
      nextEventId: Math.max(0, ...events.map(({ id }) => id)) + 1,
      exchange: Math.max(
        0,
        ...prefixEvents
          .filter(
            (
              event,
            ): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
              event.kind === "assistant" && event.status === "completed",
          )
          .map(({ exchange }) => exchange),
      ),
      lastRequest: null,
      lastRequestAttempt: 0,
      lastFailure: null,
      updatedAt: Date.now(),
    };
    await this.#worlds.playTimeline.persist(structuredClone(revised));
    const activeId = this.#worldChains.get(request.worldId);
    if (activeId !== undefined) this.#active.delete(activeId);
    this.#active.delete(sourceContext.chainId);
    this.#worldChains.delete(request.worldId);
    return {
      outcome: "revised",
      worldId: request.worldId,
      playCallChain: projectView(revised),
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
    const transcript = transcriptThroughEvents(
      sourceContext.transcript,
      input.sourceEvents,
    );
    const completedKeys = completedToolKeys(input.sourceEvents);
    const events = structuredClone(input.sourceEvents);
    const derivedBinding =
      input.targetBinding ??
      (await this.#worlds.bindPlayCallChain(input.targetWorldId));
    const derivedDocuments = restorePlayDocuments(
      derivedBinding.files,
      sourceContext,
      input.sourceEvents,
    );
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
      baselineHead: sourceContext.baselineHead,
      baselineHistoryLength:
        sourceContext.baselineHistoryLength ?? baseline.history.length,
      parentHead: input.sourceHead,
      playPreset: structuredClone(sourceContext.playPreset),
      ...(sourceContext.followups === undefined
        ? {}
        : { followups: structuredClone(sourceContext.followups) }),
      ...(sourceContext.playPresetScriptsEnabled === undefined
        ? {}
        : {
            playPresetScriptsEnabled: sourceContext.playPresetScriptsEnabled,
          }),
      ...(sourceContext.modelBinding === undefined
        ? {}
        : { modelBinding: structuredClone(sourceContext.modelBinding) }),
      status: "ready",
      canRetry: false,
      bootstrap: structuredClone(sourceContext.bootstrap),
      tools: structuredClone(sourceContext.tools),
      transcript,
      events,
      completedTools: sourceContext.completedTools
        .filter(({ key }) => completedKeys.has(key))
        .map((item) => structuredClone(item)),
      documentAuthorizationCheckpoints: authorizationCheckpointsThroughEvents(
        sourceContext,
        events,
        derivedDocuments.authorizationCheckpoint(),
      ),
      changedDocuments: changedDocumentsAtHead(
        sourceContext.changedDocuments,
        baseline.state,
        selected.state,
      ),
      nextMaterials: structuredClone(derivedBinding.additionalMaterials),
      nextEventId: Math.max(0, ...events.map(({ id }) => id)) + 1,
      exchange: Math.max(
        0,
        ...events
          .filter(
            (
              event,
            ): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
              event.kind === "assistant" && event.status === "completed",
          )
          .map(({ exchange }) => exchange),
      ),
      lastRequest: null,
      lastRequestAttempt: 0,
      lastFailure: null,
      updatedAt: now,
    };
    if (input.targetWorldRoot === undefined)
      await this.#worlds.playTimeline.persist(structuredClone(derived));
    else
      await this.#worlds.playTimeline.cloneContextPrefixToStaging({
        sourceWorldId: input.sourceWorldId,
        targetWorldRoot: input.targetWorldRoot,
        source: sourceContext,
        target: structuredClone(derived),
      });
    return projectView(derived);
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
  }

  async #submitPlayer(
    session: PlayCallChainSession,
    exchangeId: string,
    playerText: string,
    context: "fresh" | "append",
    modelHost: ModelHost,
    observer?: PlayCallChainObserver,
  ): Promise<V1PlayCallChainView> {
    if (duplicatePlayerExchange(session, exchangeId, playerText, context))
      return projectView(session);
    if (session.status === "running")
      throw new PlayCallChainError(
        "The call chain is waiting for the model to return.",
      );

    const exchange = session.exchange + 1;
    const nextRequest = createRequest(session, modelHost, exchange, [
      ...session.transcript,
      { kind: "player", text: playerText },
    ]);
    const operationKey = `player:${exchangeId}`;
    const playerOperationId = operationId(session.chainId, operationKey);
    const advance = {
      schemaVersion: 1,
      kind: "play_advance",
      advanceKind: "player",
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
    } satisfies Extract<PlayAdvanceBase, { advanceKind: "player" }>;
    await this.#worlds.playAdvances.begin(advance);
    try {
      await this.#settlePlayerAdvance(session, advance);
    } catch (error: unknown) {
      const accepted = await this.#worlds
        .getOperationOutcome(advance.operationId)
        .catch(() => ({ outcome: "not_started" as const }));
      if (
        accepted.outcome === "committed" ||
        accepted.outcome === "committed_materialization_pending"
      ) {
        await this.#settlePlayerAdvance(session, advance);
        return this.#dispatch(
          session,
          modelHost,
          structuredClone(nextRequest),
          1,
          observer,
        );
      }
      const message =
        error instanceof Error
          ? error.message
          : "Failed to write the original player text.";
      session.events.push({
        id: session.nextEventId++,
        kind: "failure",
        message,
      });
      session.status = "interrupted";
      session.canRetry = false;
      session.lastFailure = message;
      await this.#persist(session);
      await this.#worlds.playAdvances.markSettled(advance, session.parentHead);
      throw new PlayCallChainError(message);
    }
    return this.#dispatch(
      session,
      modelHost,
      structuredClone(nextRequest),
      1,
      observer,
    );
  }

  async #settlePlayerAdvance(
    session: PlayCallChainSession,
    advance: Extract<PlayAdvanceBase, { advanceKind: "player" }>,
  ): Promise<void> {
    const outcome = await this.#worlds.commitPlayStep({
      operationId: advance.operationId,
      worldId: session.worldId,
      parentHead: advance.parentHead,
      historyAppend: [{ role: "player", exactText: advance.playerText }],
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
    if (session.transcript.length < advance.transcriptStart)
      throw new PlayCallChainError(
        "The recovered call-chain transcript is shorter than its player prefix.",
      );
    session.transcript = [
      ...session.transcript.slice(0, advance.transcriptStart),
      { kind: "player", text: advance.playerText },
    ];
    session.nextEventId = advance.eventId + 1;
    session.parentHead = outcome.head;
    appendCommittedHistory(session, outcome.head, outcome.historyAppend);
    session.exchange = advance.exchange;
    session.lastRequest = structuredClone(advance.nextRequest);
    session.lastRequestAttempt = 0;
    session.status = "interrupted";
    session.canRetry = true;
    session.lastFailure =
      "The player message is committed; the frozen model request is ready to continue.";
    await this.#persist(session);
    crashAtPlayAdvanceEdge("after_timeline_settled");
    await this.#worlds.playAdvances.markSettled(advance, outcome.head);
  }

  #prepareResponseSettlement(
    session: PlayCallChainSession,
    advance: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
    response: DurableModelHostResponse,
  ): PreparedPlayResponseSettlement {
    const existing = session.events.find(({ id }) => id === advance.eventId);
    if (existing?.kind !== "assistant")
      throw new PlayCallChainError(
        "The durable Provider result no longer matches its assistant event.",
      );
    const calls = response.toolCalls ?? [];
    const text = response.text ?? existing.text;
    const hasText = text.trim().length > 0;
    const responseKind =
      calls.length > 0 ? "tool_step" : hasText ? "narrative" : "empty";
    const assistantEvent: Extract<V1PlayCallChainEvent, { kind: "assistant" }> =
      {
        id: advance.eventId,
        kind: "assistant",
        text,
        status: "completed",
        responseKind,
        exchange: advance.exchange,
        attempt: advance.attempt,
        ...(response.reasoningContent === undefined
          ? existing.reasoning === undefined
            ? {}
            : { reasoning: existing.reasoning }
          : { reasoning: response.reasoningContent }),
        ...(response.usage === undefined
          ? {}
          : { usage: structuredClone(response.usage) }),
        ...(response.stopReason === undefined
          ? {}
          : { stopReason: response.stopReason }),
        continuation:
          response.providerState === undefined ? "unavailable" : "available",
      };
    const workingTools = new Map(session.completedToolMap);
    const prepared: PreparedToolResult[] = [];
    const trailingEvents: V1PlayCallChainEvent[] = [];
    let nextEventId = advance.eventId + 1;
    for (const call of calls) {
      const item = prepareTool(session, workingTools, advance.exchange, call);
      prepared.push(item);
      trailingEvents.push({
        id: nextEventId++,
        kind: "tool_call",
        callId: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
        replayed: item.replayed,
      });
      item.event.id = nextEventId++;
      trailingEvents.push(structuredClone(item.event));
    }
    const stateChanges = session.documents.stateChanges();
    const visibleText = responseKind === "narrative";
    const assistantItem: Extract<ModelHostAppendItem, { kind: "assistant" }> = {
      kind: "assistant",
      text,
      ...(response.reasoningContent === undefined
        ? {}
        : { reasoningContent: response.reasoningContent }),
      ...(response.providerState === undefined
        ? {}
        : { providerState: response.providerState }),
      toolCalls: structuredClone(calls),
    };
    return {
      assistantEvent,
      trailingEvents,
      transcriptStart: session.transcript.length,
      transcriptAppend: [
        ...(calls.length > 0 ||
        visibleText ||
        response.providerState !== undefined
          ? [assistantItem]
          : []),
        ...prepared.map(({ transcript }) => structuredClone(transcript)),
      ],
      completedTools: [...workingTools.values()].map((item) =>
        structuredClone(item),
      ),
      authorizationCheckpoint: session.documents.authorizationCheckpoint(),
      stateChanges: structuredClone(stateChanges),
      visibleText,
    };
  }

  async #settleResponseAdvance(
    session: PlayCallChainSession,
    advance: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
    prepared: PreparedPlayResponseSettlement,
  ): Promise<
    | { kind: "terminal"; status: "ready" | "interrupted" }
    | { kind: "continue"; nextRequest: ModelHostExchange }
  > {
    const settlement = structuredClone(prepared);
    const hasToolCalls = settlement.trailingEvents.some(
      ({ kind }) => kind === "tool_call",
    );
    // A legacy prepared fact has no responseKind. Its visibleText decision is
    // already part of an immutable recovery operation and must be replayed as
    // recorded; every newly prepared fact is checked against the current rule.
    if (settlement.assistantEvent.responseKind !== undefined) {
      const expectedResponseKind = hasToolCalls
        ? "tool_step"
        : settlement.assistantEvent.text.trim().length > 0
          ? "narrative"
          : "empty";
      if (
        settlement.assistantEvent.responseKind !== expectedResponseKind ||
        settlement.visibleText !== (expectedResponseKind === "narrative")
      )
        throw new PlayCallChainError(
          "The prepared response settlement has an inconsistent narrative classification.",
        );
    }
    let committedHead: string | undefined;
    if (settlement.visibleText || settlement.stateChanges.length > 0) {
      const outcome = await this.#worlds.commitPlayStep({
        operationId: advance.operationId,
        worldId: session.worldId,
        parentHead: advance.parentHead,
        historyAppend: settlement.visibleText
          ? [
              {
                role: "narrator",
                exactText: settlement.assistantEvent.text,
              },
            ]
          : [],
        nextMaterials: structuredClone(session.nextMaterials),
        stateChanges: structuredClone(settlement.stateChanges),
      });
      committedHead = outcome.head;
      settlement.assistantEvent.committedHead = outcome.head;
      crashAtPlayAdvanceEdge("after_authority_accepted");
      appendCommittedHistory(session, outcome.head, outcome.historyAppend);
    }

    finalizePreparedReceipts(settlement);
    session.events = [
      ...session.events.filter(({ id }) => id < advance.eventId),
      structuredClone(settlement.assistantEvent),
      ...structuredClone(settlement.trailingEvents),
    ];
    session.nextEventId =
      Math.max(
        advance.eventId,
        ...settlement.trailingEvents.map(({ id }) => id),
      ) + 1;
    if (session.transcript.length < settlement.transcriptStart)
      throw new PlayCallChainError(
        "The recovered call-chain transcript is shorter than its settlement prefix.",
      );
    session.transcript = [
      ...session.transcript.slice(0, settlement.transcriptStart),
      ...structuredClone(settlement.transcriptAppend),
    ];
    session.completedTools = structuredClone(settlement.completedTools);
    session.completedToolMap = new Map(
      settlement.completedTools.map((item) => [
        item.key,
        structuredClone(item),
      ]),
    );
    const lastToolEventId = settlement.trailingEvents.findLast(
      ({ kind }) => kind === "tool_result",
    )?.id;
    if (lastToolEventId !== undefined) {
      session.documentAuthorizationCheckpoints =
        session.documentAuthorizationCheckpoints.filter(
          ({ afterEventId }) => afterEventId < advance.eventId,
        );
      session.documentAuthorizationCheckpoints.push({
        afterEventId: lastToolEventId,
        authorization: structuredClone(settlement.authorizationCheckpoint),
      });
    }
    if (committedHead !== undefined) session.parentHead = committedHead;
    if (settlement.stateChanges.length > 0) {
      const currentAuthorization = session.documents.authorizationCheckpoint();
      if (
        currentAuthorization.stateFingerprint ===
        settlement.authorizationCheckpoint.stateFingerprint
      )
        session.documents.acceptCommittedState();
      else {
        const binding = await this.#worlds.bindPlayCallChain(session.worldId);
        session.documents = new FileNativePlayDocuments(binding.files);
        session.documents.restoreAuthorizationCheckpoint(
          settlement.authorizationCheckpoint,
        );
        session.history = historyEntries(binding.history);
        session.nextMaterials = structuredClone(binding.additionalMaterials);
      }
      mergeChangedDocuments(session, settlement.stateChanges);
    }

    session.exchange = Math.max(session.exchange, advance.exchange);
    session.canRetry = false;
    session.lastFailure = null;
    let result:
      | { kind: "terminal"; status: "ready" | "interrupted" }
      | { kind: "continue"; nextRequest: ModelHostExchange };
    if (settlement.assistantEvent.continuation !== "available") {
      const message =
        "The complete model response has no provider-native continuation payload; use a fresh context.";
      session.events.push({
        id: session.nextEventId++,
        kind: "failure",
        message,
      });
      session.status = "interrupted";
      session.lastFailure = message;
      result = { kind: "terminal", status: "interrupted" };
    } else if (hasToolCalls) {
      session.exchange += 1;
      const nextRequest = createRequestWithMaxOutputTokens(
        session,
        session.lastRequest?.maxOutputTokens ?? 1,
        session.exchange,
      );
      session.lastRequest = structuredClone(nextRequest);
      session.lastRequestAttempt = 0;
      session.status = "interrupted";
      session.canRetry = true;
      session.lastFailure =
        "The completed tool response is settled; its frozen continuation request is ready.";
      result = { kind: "continue", nextRequest };
    } else {
      session.status = settlement.visibleText ? "ready" : "interrupted";
      if (!settlement.visibleText) {
        const message =
          "The model returned neither text nor a complete tool call.";
        session.events.push({
          id: session.nextEventId++,
          kind: "failure",
          message,
        });
        session.lastFailure = message;
      }
      result = { kind: "terminal", status: session.status };
    }
    await this.#persist(session);
    crashAtPlayAdvanceEdge("after_timeline_settled");
    await this.#worlds.playAdvances.markSettled(
      advance,
      committedHead ?? session.parentHead,
    );
    return result;
  }

  async #recoverAcceptedResponseAdvance(
    session: PlayCallChainSession,
    advance: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
  ): Promise<
    | { kind: "terminal"; status: "ready" | "interrupted" }
    | { kind: "continue"; nextRequest: ModelHostExchange }
    | null
  > {
    const outcome = await this.#worlds
      .getOperationOutcome(advance.operationId)
      .catch(() => ({ outcome: "not_started" as const }));
    if (
      outcome.outcome !== "committed" &&
      outcome.outcome !== "committed_materialization_pending"
    )
      return null;
    const current = await this.#worlds.playAdvances.readCurrent(
      advance.worldId,
      advance.chainId,
    );
    if (
      current?.base.advanceKind !== "response" ||
      current.base.advanceId !== advance.advanceId ||
      current.settlementPrepared === null
    )
      throw new PlayCallChainError(
        "Authority accepted a response whose durable settlement is missing.",
      );
    return this.#settleResponseAdvance(
      session,
      advance,
      current.settlementPrepared.settlement,
    );
  }

  async #dispatch(
    session: PlayCallChainSession,
    modelHost: ModelHost,
    firstRequest: ModelHostExchange,
    firstAttempt: number,
    observer?: PlayCallChainObserver,
  ): Promise<V1PlayCallChainView> {
    let request = structuredClone(firstRequest);
    let attempt = firstAttempt;
    for (;;) {
      session.status = "running";
      session.canRetry = false;
      session.lastFailure = null;
      session.lastRequest = structuredClone(request);
      session.lastRequestAttempt = attempt;
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
      crashAtPlayAdvanceEdge("after_response_advance_began");
      notifySnapshot(observer, session);

      let response: Awaited<ReturnType<ModelHost["exchange"]>>;
      try {
        response = await modelHost.exchange(request, {
          onDelta: (delta) => {
            if (delta.kind === "text") event.text += delta.text;
            else if (delta.kind === "reasoning")
              event.reasoning = `${event.reasoning ?? ""}${delta.text}`;
            else if (delta.kind === "tool")
              event.toolFragment = `${event.toolFragment ?? ""}${delta.text}`;
            touch(session);
            notifyAssistantDelta(observer, {
              eventId: event.id,
              kind: delta.kind,
              text: delta.text,
              updatedAt: session.updatedAt,
            });
          },
        });
        if (response.diagnostics !== undefined)
          await this.#failureLog?.recordExchangeIfActive(response.diagnostics);
      } catch (error: unknown) {
        event.status = "interrupted";
        const message =
          error instanceof Error
            ? error.message
            : "The model request was interrupted.";
        session.events.push({
          id: session.nextEventId++,
          kind: "failure",
          message,
        });
        session.status = "interrupted";
        const requiresFreshContext =
          error instanceof ModelHostContinuationError ||
          error instanceof ModelHostOutcomeUnknownError;
        session.canRetry =
          !requiresFreshContext && error instanceof ModelHostFailureError;
        session.lastFailure = message;
        await this.#persist(session);
        await this.#worlds.playAdvances.markSettled(
          advance,
          session.parentHead,
        );
        notifySnapshot(observer, session);
        return projectView(session);
      }

      const durableResponse = durableModelResponse(response);
      try {
        await this.#worlds.playAdvances.recordProviderCompleted(
          advance,
          durableResponse,
        );
        crashAtPlayAdvanceEdge("after_provider_completed");
        const settlement = this.#prepareResponseSettlement(
          session,
          advance,
          durableResponse,
        );
        await this.#worlds.playAdvances.recordSettlementPrepared(
          advance,
          settlement,
        );
        crashAtPlayAdvanceEdge("after_settlement_prepared");

        const failedTools = settlement.trailingEvents.filter(
          (
            candidate,
          ): candidate is Extract<
            V1PlayCallChainEvent,
            { kind: "tool_result" }
          > => candidate.kind === "tool_result" && !candidate.ok,
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
        const settled = await this.#settleResponseAdvance(
          session,
          advance,
          settlement,
        );

        if (settled.kind === "terminal") {
          if (!settlement.visibleText) {
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
            notifySnapshot(observer, session);
            return projectView(session);
          }
          if (settled.status !== "ready") {
            notifySnapshot(observer, session);
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
          await this.#runFollowups(session, modelHost, observer);
          session.status = "ready";
          await this.#persist(session);
          notifySnapshot(observer, session);
          return projectView(session);
        }
        notifySnapshot(observer, session);
        request = settled.nextRequest;
        attempt = 1;
      } catch (error: unknown) {
        const recovered = await this.#recoverAcceptedResponseAdvance(
          session,
          advance,
        );
        if (recovered !== null) {
          if (recovered.kind === "continue") {
            request = recovered.nextRequest;
            attempt = 1;
            notifySnapshot(observer, session);
            continue;
          }
          notifySnapshot(observer, session);
          return projectView(session);
        }
        const message =
          error instanceof Error
            ? error.message
            : "Call-chain processing failed.";
        if (response.diagnostics !== undefined)
          await this.#failureLog?.recordFailure({
            exchange: response.diagnostics,
            failures: [
              {
                kind: "runtime_post_processing",
                message,
              },
            ],
          });
        session.events.push({
          id: session.nextEventId++,
          kind: "failure",
          message,
        });
        session.status = "interrupted";
        session.canRetry = false;
        session.lastFailure = message;
        await this.#persist(session);
        notifySnapshot(observer, session);
        return projectView(session);
      }
    }
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
    observer?: PlayCallChainObserver,
  ): Promise<void> {
    const followups = session.followups ?? [];
    if (this.#artifacts === undefined || followups.length === 0) return;
    const record = (outcome: PlayFollowupOutcome): void => {
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
      notifySnapshot(observer, session);
    };
    try {
      await runPlayFollowupRequests({
        artifacts: this.#artifacts,
        modelHost,
        followups,
        bootstrap: session.bootstrap,
        // Captured once: every followup is dispatched against this exact
        // prefix, so none of them observes another one's prompt or output.
        prefix: structuredClone(session.transcript),
        toolStrategy: session.bootstrap.toolStrategy,
        context: {
          // A follow-up produces no world endpoint of its own, so it starts and
          // ends on the settled exchange's head. Reconciliation keeps panels
          // bound to this endpoint and retires ones bound to the previous head.
          worldId: session.worldId,
          parentHead: session.parentHead,
          operationId: followupOperationId(session),
          playPresetId: session.playPreset.id,
          playPresetRevision: session.playPreset.revision,
          playPresetScriptsEnabled: session.playPresetScriptsEnabled ?? true,
        },
        head: session.parentHead,
        maxOutputTokens: modelHost.binding().maxOutputTokens,
        ...(this.#failureLog === undefined
          ? {}
          : { failureLog: this.#failureLog }),
        observer: { onOutcome: record },
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
      return active;
    }
    const persisted = await this.#readPersisted(worldId);
    if (persisted?.chainId !== chainId)
      throw new PlayCallChainError(
        "The call chain does not exist; start from the latest world state.",
      );
    const advance = await this.#worlds.playAdvances.readCurrent(
      worldId,
      chainId,
    );
    const session = await this.#hydrateSession(persisted, advance);
    this.#active.set(chainId, session);
    this.#worldChains.set(worldId, chainId);
    await this.#reconcileSessionAdvance(session, advance);
    if (session.status === "running")
      await this.#interruptAbandonedDispatch(session);
    const currentHead = await this.#worlds.currentHead(worldId);
    if (currentHead !== session.parentHead)
      throw new PlayCallChainError(
        "The call-chain record differs from the current world endpoint; use a fresh context.",
      );
    return session;
  }

  async #hydrateSession(
    persisted: PersistedPlayCallChain,
    advance: LoadedPlayAdvance | null,
  ): Promise<PlayCallChainSession> {
    const binding = await this.#worlds.bindPlayCallChain(persisted.worldId);
    let documents: FileNativePlayDocuments;
    try {
      documents = restorePlayDocuments(
        binding.files,
        persisted,
        persisted.events,
      );
    } catch (error: unknown) {
      const prepared = advance?.settlementPrepared?.settlement;
      if (prepared === undefined) throw error;
      documents = new FileNativePlayDocuments(binding.files);
      documents.restoreAuthorizationCheckpoint(
        prepared.authorizationCheckpoint,
      );
    }
    return {
      ...structuredClone(persisted),
      documentAuthorizationCheckpoints:
        persisted.documentAuthorizationCheckpoints?.map((checkpoint) =>
          structuredClone(checkpoint),
        ) ?? [],
      nextMaterials: structuredClone(binding.additionalMaterials),
      documents,
      history: historyEntries(binding.history),
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
        authorizationCheckpointCount: 0,
      },
    };
  }

  async #reconcileSessionAdvance(
    session: PlayCallChainSession,
    loaded?: LoadedPlayAdvance | null,
  ): Promise<void> {
    const current =
      loaded ??
      (await this.#worlds.playAdvances.readCurrent(
        session.worldId,
        session.chainId,
      ));
    if (current?.settled !== null) return;
    if (current.base.advanceKind === "player") {
      await this.#settlePlayerAdvance(session, current.base);
      return;
    }
    if (current.providerCompleted === null) {
      await this.#interruptAbandonedDispatch(session, current.base);
      await this.#worlds.playAdvances.markSettled(
        current.base,
        session.parentHead,
      );
      return;
    }
    let settlement = current.settlementPrepared?.settlement;
    if (settlement === undefined) {
      settlement = this.#prepareResponseSettlement(
        session,
        current.base,
        current.providerCompleted.response,
      );
      await this.#worlds.playAdvances.recordSettlementPrepared(
        current.base,
        settlement,
      );
    }
    await this.#settleResponseAdvance(session, current.base, settlement);
  }

  async #interruptAbandonedDispatch(
    session: PlayCallChainSession,
    advance?: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
  ): Promise<void> {
    const streaming = session.events.findLast(
      (event): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
        event.kind === "assistant" &&
        event.status === "streaming" &&
        (advance === undefined || event.id === advance.eventId),
    );
    if (streaming !== undefined) streaming.status = "interrupted";
    const dispatchMayHaveStarted = advance !== undefined;
    const canRetry = !dispatchMayHaveStarted && session.lastRequest !== null;
    const message = dispatchMayHaveStarted
      ? "The service stopped after model dispatch may have started; the outcome is unknown and the request cannot be replayed. Use a fresh context."
      : canRetry
        ? "The service stopped before model dispatch; the frozen request can be retried."
        : "The service stopped before preparing a model request; use a fresh context.";
    session.events.push({
      id: session.nextEventId++,
      kind: "failure",
      message,
    });
    session.status = "interrupted";
    session.canRetry = canRetry;
    session.lastFailure = message;
    await this.#persist(session);
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
    return structuredClone(loaded.value);
  }

  async #persist(session: PlayCallChainSession): Promise<void> {
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
      structuredClone(persisted),
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
  appended: readonly ModelHostAppendItem[] = session.transcript,
): ModelHostExchange {
  return createRequestWithMaxOutputTokens(
    session,
    modelHost.binding().maxOutputTokens,
    exchange,
    appended,
  );
}

function createRequestWithMaxOutputTokens(
  session: Pick<
    PlayCallChainSession,
    "bootstrap" | "tools" | "transcript" | "chainId"
  >,
  maxOutputTokens: number,
  exchange: number,
  appended: readonly ModelHostAppendItem[] = session.transcript,
): ModelHostExchange {
  return {
    bootstrap: structuredClone(session.bootstrap),
    tools: structuredClone(session.tools),
    toolUniverse: structuredClone(session.tools),
    allowedTools: session.tools.map(({ name }) => name),
    toolStrategy: session.bootstrap.toolStrategy,
    appended: structuredClone([...appended]),
    requestId: "play_call_chain",
    operationId: session.chainId,
    requestAttempt: 1,
    exchange,
    maxOutputTokens,
  };
}

function durableModelResponse(
  response: ModelHostResponse,
): DurableModelHostResponse {
  const { diagnostics: _diagnostics, ...durable } = response;
  void _diagnostics;
  return structuredClone(durable);
}

function finalizePreparedReceipts(
  settlement: PreparedPlayResponseSettlement,
): void {
  const committedWriteRefs = new Set(
    settlement.stateChanges.map(({ stableShortRef }) => stableShortRef),
  );
  const markdownByCall = new Map<string, string>();
  for (const completed of settlement.completedTools) {
    const candidateWrite = completed.result.candidateWrite;
    if (!completed.result.ok || candidateWrite === undefined) continue;
    const markdown =
      candidateWrite.changed && committedWriteRefs.has(candidateWrite.shortRef)
        ? `@${candidateWrite.shortRef} write succeeded`
        : `@${candidateWrite.shortRef} unchanged`;
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
  messages: readonly { role: "player" | "narrator"; exactText: string }[],
): void {
  const sequence = Number(head.slice("commit:".length));
  for (const [index, message] of messages.entries()) {
    const path = `message.${sequence}.${index + 1}.${message.role}`;
    const existing = session.history.find((item) => item.path === path);
    if (existing !== undefined) {
      if (existing.contents !== message.exactText)
        throw new PlayCallChainError(
          "Recovered Authority history conflicts with the call-chain history.",
        );
      continue;
    }
    session.history.push({ path, contents: message.exactText });
  }
}

function prepareTool(
  session: PlayCallChainSession,
  working: Map<string, CompletedToolCall>,
  exchange: number,
  call: ModelHostToolCall,
): PreparedToolResult {
  const key = `${exchange}:${call.id}`;
  const signature = JSON.stringify(call.arguments);
  const completed = working.get(key);
  let result: PlayDocumentToolResult;
  let replayed = false;
  if (completed !== undefined) {
    replayed = true;
    result =
      completed.name === call.name && completed.signature === signature
        ? structuredClone(completed.result)
        : {
            ok: false,
            failureKind: "protocol",
            markdown:
              "# Runtime tool rejected\n\nThe same tool-call ID is already bound to another tool name or argument set.",
          };
  } else if (
    !callChainToolNames.has(call.name) ||
    !session.tools.some(({ name }) => name === call.name)
  ) {
    result = {
      ok: false,
      failureKind: "protocol",
      markdown: `# Runtime tool rejected\n\nThe current call chain does not provide ${call.name}.`,
    };
  } else {
    try {
      result = session.documents.execute(call, session.history);
    } catch (error: unknown) {
      result = {
        ok: false,
        failureKind: "protocol",
        markdown: `# Runtime tool failed\n\n${error instanceof Error ? error.message : "Tool execution failed."}`,
      };
    }
    working.set(key, {
      key,
      name: call.name,
      signature,
      result: structuredClone(result),
    });
  }
  const event: Extract<V1PlayCallChainEvent, { kind: "tool_result" }> = {
    id: 0,
    kind: "tool_result",
    callId: call.id,
    name: call.name,
    ok: result.ok,
    markdown: result.markdown,
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

function restorePlayDocuments(
  files: Readonly<Record<string, string>>,
  context: Pick<
    PersistedPlayCallChainContext,
    "bootstrap" | "documentAuthorizationCheckpoints"
  >,
  events: readonly V1PlayCallChainEvent[],
): FileNativePlayDocuments {
  const documents = new FileNativePlayDocuments(files);
  try {
    const checkpoint = documentAuthorizationThroughEvents(context, events);
    if (checkpoint === undefined) documents.bindBootstrap(context.bootstrap);
    else documents.restoreAuthorizationCheckpoint(checkpoint.authorization);
  } catch (error: unknown) {
    throw new PlayCallChainError(
      `Call-chain document authorization could not be restored: ${
        error instanceof Error ? error.message : "invalid checkpoint"
      }。`,
    );
  }
  return documents;
}

function documentAuthorizationThroughEvents(
  context: Pick<
    PersistedPlayCallChainContext,
    "documentAuthorizationCheckpoints"
  >,
  events: readonly V1PlayCallChainEvent[],
): PersistedDocumentAuthorizationCheckpoint | undefined {
  const checkpoints = context.documentAuthorizationCheckpoints;
  if (checkpoints === undefined || checkpoints.length === 0) return undefined;
  const selectedEventIds = new Set(events.map(({ id }) => id));
  const selected = checkpoints.findLast(
    ({ afterEventId }) =>
      afterEventId === 0 || selectedEventIds.has(afterEventId),
  );
  // Legacy V1 records had no durable dynamic authorization. If the selected
  // prefix predates their first lazily-written checkpoint, retain the exact
  // old recovery behavior and rebuild only bootstrap authorization.
  return selected === undefined ? undefined : structuredClone(selected);
}

function independentContextCopy(
  source: PersistedPlayCallChainContext,
): PersistedPlayCallChainContext {
  const context = structuredClone(source);
  delete context.derivedFrom;
  delete context.branchedBeforePlayer;
  return context;
}

function authorizationCheckpointsThroughEvents(
  context: PersistedPlayCallChainContext,
  events: readonly V1PlayCallChainEvent[],
  fallback: PlayDocumentAuthorizationCheckpoint,
): PersistedDocumentAuthorizationCheckpoint[] {
  const eventIds = new Set(events.map(({ id }) => id));
  const selected = (context.documentAuthorizationCheckpoints ?? [])
    .filter(
      ({ afterEventId }) => afterEventId === 0 || eventIds.has(afterEventId),
    )
    .map((checkpoint) => structuredClone(checkpoint));
  if (selected.length > 0) return selected;
  return [
    {
      afterEventId: Math.max(0, ...events.map(({ id }) => id)),
      authorization: structuredClone(fallback),
    },
  ];
}

function projectContext(
  context: PersistedPlayCallChainContext,
): V1PlayCallChainContextView {
  return {
    chainId: context.chainId,
    baselineHead: context.baselineHead,
    ...(context.baselineHistoryLength === undefined
      ? {}
      : { baselineHistoryLength: context.baselineHistoryLength }),
    parentHead: context.parentHead,
    playPreset: structuredClone(context.playPreset),
    status: context.status,
    canRetry: context.canRetry,
    events: context.events
      .slice(-projectedEventTail)
      .map((event) => projectActivityEvent(event)),
    changedDocuments: structuredClone(context.changedDocuments),
    lastFailure: context.lastFailure,
    updatedAt: context.updatedAt,
  };
}

function projectActivityEvent(
  event: V1PlayCallChainEvent,
): V1PlayCallChainEvent {
  if (event.kind === "player" || event.kind === "failure")
    return structuredClone(event);
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
  };
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

function transcriptThroughEvents(
  transcript: readonly ModelHostAppendItem[],
  events: readonly V1PlayCallChainEvent[],
): ModelHostAppendItem[] {
  const result: ModelHostAppendItem[] = [];
  let cursor = 0;
  for (const [index, event] of events.entries()) {
    if (event.kind === "player") {
      const item = transcript[cursor];
      if (item?.kind !== "player" || item.text !== event.text)
        throw new PlayCallChainError(
          "Source call-chain events do not match the model transcript, so a fork cannot be created safely.",
        );
      result.push(structuredClone(item));
      cursor += 1;
      continue;
    }
    if (event.kind === "assistant" && event.status === "completed") {
      const hasToolCall = events
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.kind === "player" ||
            candidate.kind === "assistant" ||
            candidate.kind === "tool_call",
        );
      const recorded =
        event.text.trim().length > 0 ||
        hasToolCall?.kind === "tool_call" ||
        transcript[cursor]?.kind === "assistant";
      if (!recorded) continue;
      const item = transcript[cursor];
      if (item?.kind !== "assistant" || item.text !== event.text)
        throw new PlayCallChainError(
          "Source call-chain responses do not match the model transcript, so a fork cannot be created safely.",
        );
      result.push(structuredClone(item));
      cursor += 1;
      continue;
    }
    if (event.kind === "tool_result") {
      const item = transcript[cursor];
      if (item?.kind !== "tool" || item.toolCallId !== event.callId)
        throw new PlayCallChainError(
          "Source call-chain tool results do not match the model transcript, so a fork cannot be created safely.",
        );
      result.push(structuredClone(item));
      cursor += 1;
    }
  }
  return result;
}

function completedToolKeys(
  events: readonly V1PlayCallChainEvent[],
): Set<string> {
  const keys = new Set<string>();
  let exchange: number | null = null;
  for (const event of events) {
    if (event.kind === "player") exchange = null;
    else if (event.kind === "assistant") exchange = event.exchange;
    else if (event.kind === "tool_call" && exchange !== null)
      keys.add(`${exchange}:${event.callId}`);
  }
  return keys;
}

function changedDocumentsAtHead(
  changes: readonly V1PlayCallChainView["changedDocuments"][number][],
  baseline: readonly { path: string; contents: string }[],
  selected: readonly { path: string; contents: string }[],
): V1PlayCallChainView["changedDocuments"] {
  const before = new Map(baseline.map((file) => [file.path, file.contents]));
  const after = new Map(selected.map((file) => [file.path, file.contents]));
  return changes
    .filter(
      ({ path }) => after.has(path) && before.get(path) !== after.get(path),
    )
    .map((change) => structuredClone(change));
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

function historyEntries(
  history: Readonly<Record<string, string>>,
): { path: string; contents: string }[] {
  return Object.entries(history).map(([path, contents]) => ({
    path,
    contents,
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
  assertModelHostBinding(session.modelBinding, modelHost);
}

function validateIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value))
    throw new PlayCallChainError(`${label} is invalid.`);
}

function validatePlayerText(value: string): void {
  if (value.trim().length === 0)
    throw new PlayCallChainError("Player text must not be empty.");
}

function touch(session: Pick<PersistedPlayCallChain, "updatedAt">): void {
  session.updatedAt = Date.now();
}

function notifySnapshot(
  observer: PlayCallChainObserver | undefined,
  session: PersistedPlayCallChain,
): void {
  try {
    observer?.onSnapshot?.(projectView(session));
  } catch {
    // A browser stream may disconnect while the durable model request keeps
    // running. Presentation failure never cancels or changes play Authority.
  }
}

function notifyAssistantDelta(
  observer: PlayCallChainObserver | undefined,
  delta: Parameters<NonNullable<PlayCallChainObserver["onAssistantDelta"]>>[0],
): void {
  try {
    observer?.onAssistantDelta?.(structuredClone(delta));
  } catch {
    // See notifySnapshot: the Provider exchange outlives its browser stream.
  }
}

function crashAtPlayAdvanceEdge(edge: string): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE === edge
  )
    throw new Error(`Simulated process exit at play advance edge: ${edge}`);
}
