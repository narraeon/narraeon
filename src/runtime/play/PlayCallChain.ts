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
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
  type MaterialSelection,
  type PlayFollowupCompilation,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativeStateChange,
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
  isPlayDocumentAuthorizationCheckpoint,
  type PlayDocumentAuthorizationCheckpoint,
  type PlayDocumentToolResult,
} from "./PlayDocumentTools.ts";
import type { AiFailureRecorder } from "../model/AiFailureLog.ts";

const callChainToolNames = new Set([
  "context_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
]);

interface CompletedToolCall {
  key: string;
  name: string;
  signature: string;
  result: PlayDocumentToolResult;
}

interface PersistedDocumentAuthorizationCheckpoint {
  afterEventId: number;
  authorization: PlayDocumentAuthorizationCheckpoint;
}

interface PersistedPlayCallChainContext {
  chainId: string;
  baselineHead: string;
  baselineHistoryLength?: number;
  parentHead: string;
  derivedFrom?: { worldId: string; chainId: string; head: string };
  branchedBeforePlayer?: {
    worldId: string;
    chainId: string;
    eventId: number;
  };
  playPreset: V1PlayCallChainView["playPreset"];
  /** Frozen derived requests run once after each settled model exchange. */
  followups?: PlayFollowupCompilation[];
  playPresetScriptsEnabled?: boolean;
  status: V1PlayCallChainView["status"];
  canRetry: boolean;
  bootstrap: PromptCompilation;
  tools: PromptCompilation["tools"];
  transcript: ModelHostAppendItem[];
  events: V1PlayCallChainEvent[];
  completedTools: CompletedToolCall[];
  /** Absent on legacy V1 records created before authorizations were durable. */
  documentAuthorizationCheckpoints?: PersistedDocumentAuthorizationCheckpoint[];
  changedDocuments: V1PlayCallChainView["changedDocuments"];
  nextMaterials: MaterialSelection[];
  nextEventId: number;
  exchange: number;
  lastRequest: ModelHostExchange | null;
  lastRequestAttempt: number;
  lastFailure: string | null;
  updatedAt: number;
}

interface PersistedPlayCallChain extends PersistedPlayCallChainContext {
  schemaVersion: 1;
  kind: "play_call_chain";
  worldId: string;
  /** Frozen model contexts retained only for display and historical forks. */
  previousContexts?: PersistedPlayCallChainContext[];
}

type ReadablePersistedPlayCallChain = Omit<
  PersistedPlayCallChain,
  "schemaVersion"
> & {
  /** Version 2 was briefly written with the same compatible representation. */
  schemaVersion: 1 | 2;
};

interface PlayCallChainSession extends PersistedPlayCallChain {
  documentAuthorizationCheckpoints: PersistedDocumentAuthorizationCheckpoint[];
  documents: FileNativePlayDocuments;
  history: { path: string; contents: string }[];
  completedToolMap: Map<string, CompletedToolCall>;
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
 * adjudication/narration phases, and immediate Authority commits after every
 * completed model response that contains visible text or world changes.
 */
export class PlayCallChain {
  readonly #worlds: FileNativeWorldStore;
  readonly #compiler: FileNativePromptCompiler;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #active = new Map<string, PlayCallChainSession>();
  readonly #worldChains = new Map<string, string>();

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
      schemaVersion: 1,
      kind: "play_call_chain",
      chainId: input.chainId,
      worldId: input.worldId,
      previousContexts:
        existing === null
          ? []
          : [
              ...(existing.previousContexts ?? []).map((context) =>
                structuredClone(context),
              ),
              snapshotCurrentContext(existing),
            ],
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
    if (active !== undefined) return projectView(active);
    const persisted = await this.#readPersisted(worldId);
    if (persisted === null) return null;
    if (persisted.status === "running") {
      const streaming = persisted.events.findLast(
        (
          event,
        ): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
          event.kind === "assistant" && event.status === "streaming",
      );
      if (streaming !== undefined) streaming.status = "interrupted";
      const canRetry = persisted.lastRequest !== null;
      const message = canRetry
        ? "The service stopped before the model request completed; the same request can be retried."
        : "The service stopped before dispatching the model request; use a fresh context.";
      persisted.events.push({
        id: persisted.nextEventId++,
        kind: "failure",
        message,
      });
      persisted.status = "interrupted";
      persisted.canRetry = canRetry;
      persisted.lastFailure = message;
      persisted.updatedAt = Date.now();
      await this.#worlds.writePlayCallChain(worldId, persisted);
    }
    return projectView(persisted);
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
    const sourceContexts = persistedContexts(source);
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
      sourceContexts,
      selectedContextIndex,
      sourceEvents,
      sourceHead: input.sourceHead,
      targetWorldId: input.targetWorldId,
      branchIdentity: input.sourceHead,
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
    const sourceContexts = persistedContexts(source);
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
      if (
        commit?.operationId !== input.operationId ||
        commit.mode !== "timeline_revision"
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
      schemaVersion: 1,
      kind: "play_call_chain",
      chainId: derivedChainId(
        sourceContext.chainId,
        "timeline-revision:" + request.operationId,
        request.worldId,
      ),
      worldId: request.worldId,
      previousContexts: input.sourceContexts
        .slice(0, input.selectedContextIndex)
        .map((context) => independentContextCopy(context)),
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
    await this.#worlds.writePlayCallChain(
      request.worldId,
      structuredClone(revised),
    );
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
    sourceContexts: PersistedPlayCallChainContext[];
    selectedContextIndex: number;
    sourceEvents: V1PlayCallChainEvent[];
    sourceHead: string;
    targetWorldId: string;
    branchIdentity: string;
  }): Promise<V1PlayCallChainView> {
    const existing = await this.#readPersisted(input.targetWorldId);
    if (existing !== null) return projectView(existing);

    const sourceContext = input.sourceContexts[input.selectedContextIndex]!;
    if (
      (await this.#worlds.currentHead(input.targetWorldId)) !== input.sourceHead
    )
      throw new PlayCallChainError(
        "The forked world's Authority does not match the selected history endpoint, so the call chain cannot be written.",
      );

    const [baseline, selected] = await Promise.all([
      this.#worlds.recoverEndpoint(
        input.targetWorldId,
        sourceContext.baselineHead,
      ),
      this.#worlds.recoverEndpoint(input.targetWorldId, input.sourceHead),
    ]);
    const transcript = transcriptThroughEvents(
      sourceContext.transcript,
      input.sourceEvents,
    );
    const completedKeys = completedToolKeys(input.sourceEvents);
    const events = structuredClone(input.sourceEvents);
    const derivedBinding = await this.#worlds.bindPlayCallChain(
      input.targetWorldId,
    );
    const derivedDocuments = restorePlayDocuments(
      derivedBinding.files,
      sourceContext,
      input.sourceEvents,
    );
    const now = Date.now();
    const derived: PersistedPlayCallChain = {
      schemaVersion: 1,
      kind: "play_call_chain",
      chainId: derivedChainId(
        sourceContext.chainId,
        input.branchIdentity,
        input.targetWorldId,
      ),
      worldId: input.targetWorldId,
      previousContexts: input.sourceContexts
        .slice(0, input.selectedContextIndex)
        .map((context) => independentContextCopy(context)),
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
    await this.#worlds.writePlayCallChain(
      input.targetWorldId,
      structuredClone(derived),
    );
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

    session.status = "running";
    session.lastFailure = null;
    let committed: { head: string };
    try {
      committed = await this.#commitStep(session, {
        operationKey: `player:${exchangeId}`,
        historyAppend: [{ role: "player", exactText: playerText }],
        stateChanges: [],
      });
    } catch (error: unknown) {
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
      throw new PlayCallChainError(message);
    }
    session.transcript.push({ kind: "player", text: playerText });
    session.events.push({
      id: session.nextEventId++,
      kind: "player",
      exchangeId,
      text: playerText,
      context,
      committedHead: committed.head,
    });
    await this.#persist(session);
    notifySnapshot(observer, session);

    session.exchange += 1;
    const request = createRequest(session, modelHost, session.exchange);
    return this.#dispatch(session, modelHost, request, 1, observer);
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
        exchange: responseExchange,
        attempt,
      };
      session.events.push(event);
      await this.#persist(session);
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
        session.canRetry = true;
        session.lastFailure = message;
        await this.#persist(session);
        notifySnapshot(observer, session);
        return projectView(session);
      }

      event.status = "completed";
      session.canRetry = false;
      event.text = response.text ?? event.text;
      if (response.reasoningContent !== undefined)
        event.reasoning = response.reasoningContent;
      delete event.toolFragment;
      if (response.usage !== undefined)
        event.usage = {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
      const calls = response.toolCalls ?? [];
      const assistantItem: Extract<ModelHostAppendItem, { kind: "assistant" }> =
        {
          kind: "assistant",
          text: response.text ?? "",
          ...(response.reasoningContent === undefined
            ? {}
            : { reasoningContent: response.reasoningContent }),
          ...(response.providerState === undefined
            ? {}
            : { providerState: response.providerState }),
          toolCalls: structuredClone(calls),
        };

      try {
        const workingTools = new Map(session.completedToolMap);
        const prepared: PreparedToolResult[] = [];
        for (const call of calls) {
          const item = prepareTool(
            session,
            workingTools,
            responseExchange,
            call,
          );
          prepared.push(item);
          session.events.push({
            id: session.nextEventId++,
            kind: "tool_call",
            callId: call.id,
            name: call.name,
            arguments: structuredClone(call.arguments),
            replayed: item.replayed,
          });
          item.event.id = session.nextEventId++;
          session.events.push(item.event);
        }

        const failedTools = prepared.filter(({ result }) => !result.ok);
        if (failedTools.length > 0 && response.diagnostics !== undefined)
          await this.#failureLog?.recordFailure({
            exchange: response.diagnostics,
            failures: [
              {
                kind: "tool_execution",
                message: "A Runtime tool call from the model was rejected.",
                details: {
                  calls: failedTools.map(({ call, result, replayed }) => ({
                    id: call.id,
                    name: call.name,
                    arguments: structuredClone(call.arguments),
                    ok: result.ok,
                    failureKind: result.failureKind,
                    markdown: result.markdown,
                    replayed,
                  })),
                },
              },
            ],
          });

        const stateChanges = session.documents.stateChanges();
        const visibleText = (response.text ?? "").trim().length > 0;
        let committedHead: string | undefined;
        if (visibleText || stateChanges.length > 0) {
          const committed = await this.#commitStep(session, {
            operationKey: `response:${responseExchange}:attempt:${attempt}`,
            historyAppend: visibleText
              ? [{ role: "narrator", exactText: response.text ?? "" }]
              : [],
            stateChanges,
          });
          committedHead = committed.head;
          event.committedHead = committed.head;
          if (stateChanges.length > 0) {
            session.documents.acceptCommittedState();
            mergeChangedDocuments(session, stateChanges);
          }
        }

        const committedWriteRefs = new Set(
          stateChanges.map(({ stableShortRef }) => stableShortRef),
        );
        for (const item of prepared) {
          const candidateWrite = item.result.candidateWrite;
          if (!item.result.ok || candidateWrite === undefined) continue;
          const markdown =
            candidateWrite.changed &&
            committedWriteRefs.has(candidateWrite.shortRef)
              ? `@${candidateWrite.shortRef} write succeeded`
              : `@${candidateWrite.shortRef} unchanged`;
          item.result.markdown = markdown;
          delete item.result.candidateWrite;
          item.event.markdown = markdown;
          item.transcript.markdown = markdown;
          const completed = workingTools.get(item.key);
          if (completed !== undefined)
            completed.result = structuredClone(item.result);
        }

        if (calls.length > 0 || visibleText)
          session.transcript.push(assistantItem);
        session.transcript.push(
          ...prepared.map(({ transcript }) => transcript),
        );
        session.completedToolMap = workingTools;
        session.completedTools = [...workingTools.values()].map((item) =>
          structuredClone(item),
        );
        const lastToolEventId = prepared.at(-1)?.event.id;
        if (lastToolEventId !== undefined)
          recordDocumentAuthorizationCheckpoint(session, lastToolEventId);
        if (committedHead !== undefined) session.parentHead = committedHead;

        if (calls.length === 0) {
          if (!visibleText) {
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

        await this.#persist(session);
        notifySnapshot(observer, session);
        session.exchange = Math.max(session.exchange, responseExchange) + 1;
        request = createRequest(session, modelHost, session.exchange);
        attempt = 1;
      } catch (error: unknown) {
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

  async #commitStep(
    session: PlayCallChainSession,
    input: {
      operationKey: string;
      historyAppend: { role: "player" | "narrator"; exactText: string }[];
      stateChanges: FileNativeStateChange[];
    },
  ) {
    const parentHead = session.parentHead;
    const outcome = await this.#worlds.commitPlayStep({
      operationId: operationId(session.chainId, input.operationKey),
      worldId: session.worldId,
      parentHead,
      historyAppend: structuredClone(input.historyAppend),
      nextMaterials: structuredClone(session.nextMaterials),
      stateChanges: structuredClone(input.stateChanges),
    });
    session.parentHead = outcome.head;
    const sequence = Number(outcome.head.slice("commit:".length));
    for (const [index, message] of input.historyAppend.entries())
      session.history.push({
        path: `${session.worldId}.message.${sequence}.${index + 1}.${message.role}`,
        contents: message.exactText,
      });
    return outcome;
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
      return active;
    }
    const persisted = await this.#readPersisted(worldId);
    if (persisted?.chainId !== chainId)
      throw new PlayCallChainError(
        "The call chain does not exist; start from the latest world state.",
      );
    if (persisted.status === "running") {
      persisted.status = "interrupted";
      persisted.canRetry = persisted.lastRequest !== null;
      persisted.lastFailure = persisted.canRetry
        ? "The service stopped before the model request completed; the same request can be retried."
        : "The service stopped before dispatching the model request; use a fresh context.";
      const streaming = persisted.events.findLast(
        (
          event,
        ): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
          event.kind === "assistant" && event.status === "streaming",
      );
      if (streaming !== undefined) streaming.status = "interrupted";
      persisted.events.push({
        id: persisted.nextEventId++,
        kind: "failure",
        message: persisted.lastFailure,
      });
    }
    const binding = await this.#worlds.bindPlayCallChain(worldId);
    if (binding.parentHead !== persisted.parentHead)
      throw new PlayCallChainError(
        "The call-chain record differs from the current world endpoint; use a fresh context.",
      );
    const documents = restorePlayDocuments(
      binding.files,
      persisted,
      persisted.events,
    );
    const session: PlayCallChainSession = {
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
    };
    this.#active.set(chainId, session);
    this.#worldChains.set(worldId, chainId);
    if (persisted.status === "interrupted") await this.#persist(session);
    return session;
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
    const value = await this.#worlds.readPlayCallChain<unknown>(worldId);
    if (value === null) return null;
    assertPersistedPlayCallChain(value, worldId);
    return { ...structuredClone(value), schemaVersion: 1 };
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
      ...persisted
    } = session;
    void _documents;
    void _history;
    void _completedToolMap;
    await this.#worlds.writePlayCallChain(
      session.worldId,
      structuredClone(persisted),
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
): ModelHostExchange {
  return {
    bootstrap: structuredClone(session.bootstrap),
    tools: structuredClone(session.tools),
    toolUniverse: structuredClone(session.tools),
    allowedTools: session.tools.map(({ name }) => name),
    toolStrategy: session.bootstrap.toolStrategy,
    appended: structuredClone(session.transcript),
    requestId: "play_call_chain",
    operationId: session.chainId,
    requestAttempt: 1,
    exchange,
    maxOutputTokens: modelHost.binding().maxOutputTokens,
  };
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
  } else if (!callChainToolNames.has(call.name)) {
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

function recordDocumentAuthorizationCheckpoint(
  session: PlayCallChainSession,
  afterEventId: number,
): void {
  const authorization = session.documents.authorizationCheckpoint();
  const previous = session.documentAuthorizationCheckpoints.at(-1);
  if (
    previous !== undefined &&
    JSON.stringify(previous.authorization) === JSON.stringify(authorization)
  )
    return;
  if (previous !== undefined && afterEventId <= previous.afterEventId)
    throw new PlayCallChainError(
      "Call-chain document authorization checkpoints are out of order.",
    );
  session.documentAuthorizationCheckpoints.push({
    afterEventId,
    authorization,
  });
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

function snapshotCurrentContext(
  session: PersistedPlayCallChain,
): PersistedPlayCallChainContext {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    worldId: _worldId,
    previousContexts: _previousContexts,
    ...context
  } = session;
  void _schemaVersion;
  void _kind;
  void _worldId;
  void _previousContexts;
  return structuredClone(context);
}

function persistedContexts(
  session: PersistedPlayCallChain,
): PersistedPlayCallChainContext[] {
  return [
    ...(session.previousContexts ?? []).map((context) =>
      structuredClone(context),
    ),
    snapshotCurrentContext(session),
  ];
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
    events: structuredClone(context.events),
    changedDocuments: structuredClone(context.changedDocuments),
    lastFailure: context.lastFailure,
    updatedAt: context.updatedAt,
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
        event.text.trim().length > 0 || hasToolCall?.kind === "tool_call";
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

function assertPersistedPlayCallChain(
  value: unknown,
  worldId: string,
): asserts value is ReadablePersistedPlayCallChain {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== "play_call_chain" ||
    value.worldId !== worldId ||
    !isPersistedPlayCallChainContext(value) ||
    (value.previousContexts !== undefined &&
      (!Array.isArray(value.previousContexts) ||
        value.previousContexts.some(
          (context) => !isPersistedPlayCallChainContext(context),
        )))
  )
    throw new PlayCallChainError(
      "The persisted call-chain record does not match the current format and cannot be read.",
    );
}

function isPersistedPlayCallChainContext(
  value: unknown,
): value is PersistedPlayCallChainContext {
  if (!isRecord(value)) return false;
  return (
    typeof value.chainId === "string" &&
    typeof value.baselineHead === "string" &&
    (value.baselineHistoryLength === undefined ||
      (typeof value.baselineHistoryLength === "number" &&
        Number.isSafeInteger(value.baselineHistoryLength) &&
        value.baselineHistoryLength >= 0)) &&
    typeof value.parentHead === "string" &&
    (value.derivedFrom === undefined ||
      (isRecord(value.derivedFrom) &&
        typeof value.derivedFrom.worldId === "string" &&
        typeof value.derivedFrom.chainId === "string" &&
        typeof value.derivedFrom.head === "string")) &&
    (value.branchedBeforePlayer === undefined ||
      (isRecord(value.branchedBeforePlayer) &&
        typeof value.branchedBeforePlayer.worldId === "string" &&
        typeof value.branchedBeforePlayer.chainId === "string" &&
        Number.isSafeInteger(value.branchedBeforePlayer.eventId) &&
        (value.branchedBeforePlayer.eventId as number) > 0)) &&
    isRecord(value.playPreset) &&
    (value.followups === undefined || Array.isArray(value.followups)) &&
    (value.playPresetScriptsEnabled === undefined ||
      typeof value.playPresetScriptsEnabled === "boolean") &&
    (value.status === "ready" ||
      value.status === "running" ||
      value.status === "interrupted") &&
    typeof value.canRetry === "boolean" &&
    isRecord(value.bootstrap) &&
    Array.isArray(value.tools) &&
    Array.isArray(value.transcript) &&
    Array.isArray(value.events) &&
    Array.isArray(value.completedTools) &&
    (value.documentAuthorizationCheckpoints === undefined ||
      isPersistedDocumentAuthorizationHistory(
        value.documentAuthorizationCheckpoints,
        value.events,
      )) &&
    Array.isArray(value.changedDocuments) &&
    Array.isArray(value.nextMaterials) &&
    Number.isSafeInteger(value.nextEventId) &&
    Number.isSafeInteger(value.exchange) &&
    (value.lastRequest === null || isRecord(value.lastRequest)) &&
    Number.isSafeInteger(value.lastRequestAttempt) &&
    (value.lastFailure === null || typeof value.lastFailure === "string") &&
    typeof value.updatedAt === "number"
  );
}

function isPersistedDocumentAuthorizationHistory(
  value: unknown,
  events: unknown[],
): value is PersistedDocumentAuthorizationCheckpoint[] {
  if (!Array.isArray(value) || value.length > 100_000) return false;
  const eventIds = new Set(
    events.flatMap((event) =>
      isRecord(event) && Number.isSafeInteger(event.id) && Number(event.id) > 0
        ? [Number(event.id)]
        : [],
    ),
  );
  let previousEventId = -1;
  for (const checkpoint of value) {
    if (
      !isRecord(checkpoint) ||
      Object.keys(checkpoint).length !== 2 ||
      !Object.hasOwn(checkpoint, "afterEventId") ||
      !Object.hasOwn(checkpoint, "authorization") ||
      !Number.isSafeInteger(checkpoint.afterEventId) ||
      Number(checkpoint.afterEventId) < 0 ||
      Number(checkpoint.afterEventId) <= previousEventId ||
      (Number(checkpoint.afterEventId) !== 0 &&
        !eventIds.has(Number(checkpoint.afterEventId))) ||
      !isPlayDocumentAuthorizationCheckpoint(checkpoint.authorization)
    )
      return false;
    previousEventId = Number(checkpoint.afterEventId);
  }
  return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
