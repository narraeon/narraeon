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
    validateIdentity(input.chainId, "调用链 ID");
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
      throw new PlayCallChainError("这个世界的模型请求仍在进行。");

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
        throw new PlayCallChainError("模型请求仍在进行。");
      if (session.status === "interrupted") {
        if (!session.canRetry || session.lastRequest === null)
          throw new PlayCallChainError(
            "调用链处理失败，当前没有可继续的模型上下文。",
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
          ? "调用链存在未完整返回的模型请求；请清空输入后追加续写，或使用全新上下文。"
          : "调用链已中断；请使用全新上下文。",
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
        ? "服务在模型请求完成前中断；可以原样重发该请求。"
        : "服务在模型请求派发前中断；请使用全新上下文。";
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
      sourceWorldId: input.sourceWorldId,
      sourceContexts,
      selectedContextIndex,
      sourceEvents,
      sourceHead: input.sourceHead,
      targetWorldId: input.targetWorldId,
      branchIdentity: input.sourceHead,
    });
  }

  /**
   * Creates an independent world immediately before one committed player
   * message. The caller never has to infer the previous Authority head from
   * display events, and the source world remains untouched.
   */
  async branchBeforePlayer(input: {
    operationId: string;
    sourceWorldId: string;
    sourceChainId: string;
    sourceEventId: number;
    hostPresetId: string;
  }): Promise<{
    outcome: "derived";
    world: FileNativeWorldSummary;
    playCallChain: V1PlayCallChainView;
  }> {
    validateIdentity(input.operationId, "分支 operation ID");
    validateIdentity(input.sourceWorldId, "来源世界 ID");
    validateIdentity(input.sourceChainId, "来源调用链 ID");
    validateIdentity(input.hostPresetId, "主持预设 ID");
    if (!Number.isSafeInteger(input.sourceEventId) || input.sourceEventId < 1)
      throw new PlayCallChainError("来源玩家事件 ID 无效。");

    const activeId = this.#worldChains.get(input.sourceWorldId);
    const active =
      activeId === undefined ? undefined : this.#active.get(activeId);
    if (active?.status === "running")
      throw new PlayCallChainError(
        "模型请求仍在进行；返回后才能修改历史提交。",
      );

    const source = await this.#readPersisted(input.sourceWorldId);
    if (source === null)
      throw new PlayCallChainError("来源世界没有可分支的模型调用链。");
    const sourceContexts = persistedContexts(source);
    const selectedContextIndex = sourceContexts.findIndex(
      ({ chainId }) => chainId === input.sourceChainId,
    );
    if (selectedContextIndex < 0)
      throw new PlayCallChainError("来源模型上下文不存在。");
    const sourceContext = sourceContexts[selectedContextIndex]!;
    const selectedEventIndex = sourceContext.events.findIndex(
      (event) => event.id === input.sourceEventId,
    );
    const selectedEvent = sourceContext.events[selectedEventIndex];
    if (
      selectedEventIndex < 0 ||
      selectedEvent?.kind !== "player" ||
      selectedEvent.committedHead === undefined
    )
      throw new PlayCallChainError("所选事件不是已提交的玩家消息。");
    if (selectedEvent.committedHead === "genesis")
      throw new PlayCallChainError(
        "这条玩家消息已经成为派生世界起点；请回到仍保留其父端点的来源世界修改。",
      );

    let sourceHead = sourceContext.baselineHead;
    for (const event of sourceContext.events.slice(0, selectedEventIndex))
      if (
        (event.kind === "player" || event.kind === "assistant") &&
        event.committedHead !== undefined
      )
        sourceHead = event.committedHead;

    const result = await this.#worlds.deriveWorld({
      operationId: input.operationId,
      sourceWorldId: input.sourceWorldId,
      sourceHead,
      hostPresetId: input.hostPresetId,
    });
    const playCallChain = await this.#forkSelectionToDerivedWorld({
      sourceWorldId: input.sourceWorldId,
      sourceContexts,
      selectedContextIndex,
      sourceEvents: structuredClone(
        sourceContext.events.slice(0, selectedEventIndex),
      ),
      sourceHead,
      targetWorldId: result.world.worldId,
      branchIdentity: `before-player:${input.sourceChainId}:${input.sourceEventId}:${sourceHead}`,
      branchedBeforePlayer: {
        worldId: input.sourceWorldId,
        chainId: input.sourceChainId,
        eventId: input.sourceEventId,
      },
    });
    return { ...result, playCallChain };
  }

  async #forkSelectionToDerivedWorld(input: {
    sourceWorldId: string;
    sourceContexts: PersistedPlayCallChainContext[];
    selectedContextIndex: number;
    sourceEvents: V1PlayCallChainEvent[];
    sourceHead: string;
    targetWorldId: string;
    branchIdentity: string;
    branchedBeforePlayer?: {
      worldId: string;
      chainId: string;
      eventId: number;
    };
  }): Promise<V1PlayCallChainView> {
    const existing = await this.#readPersisted(input.targetWorldId);
    if (existing !== null) {
      if (
        input.branchedBeforePlayer !== undefined &&
        !samePlayerBranch(
          existing.branchedBeforePlayer,
          input.branchedBeforePlayer,
        )
      )
        throw new PlayCallChainError("派生世界已经绑定另一条历史玩家提交。");
      return projectView(existing);
    }

    const sourceContext = input.sourceContexts[input.selectedContextIndex]!;
    if ((await this.#worlds.currentHead(input.targetWorldId)) !== "genesis")
      throw new PlayCallChainError("派生世界已经推进，不能再补写来源调用链。");

    const [baseline, selected] = await Promise.all([
      this.#worlds.recoverEndpoint(
        input.sourceWorldId,
        sourceContext.baselineHead,
      ),
      this.#worlds.recoverEndpoint(input.sourceWorldId, input.sourceHead),
    ]);
    const transcript = transcriptThroughEvents(
      sourceContext.transcript,
      input.sourceEvents,
    );
    const completedKeys = completedToolKeys(input.sourceEvents);
    const events = input.sourceEvents.map((event) => {
      const copy = structuredClone(event);
      if (copy.kind !== "player" && copy.kind !== "assistant") return copy;
      if (copy.committedHead === input.sourceHead)
        copy.committedHead = "genesis";
      else delete copy.committedHead;
      return copy;
    });
    const derivedBinding = await this.#worlds.bindPlayCallChain(
      input.targetWorldId,
    );
    const derivedDocuments = restorePlayDocuments(
      derivedBinding.files,
      sourceContext,
      input.sourceEvents,
    );
    const authorizationEventId = Math.max(0, ...events.map(({ id }) => id));
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
        .map((context) => historicalContextForDerivedWorld(context)),
      baselineHead: "genesis",
      baselineHistoryLength:
        sourceContext.baselineHistoryLength ?? baseline.history.length,
      parentHead: "genesis",
      derivedFrom: {
        worldId: input.sourceWorldId,
        chainId: sourceContext.chainId,
        head: input.sourceHead,
      },
      ...(input.branchedBeforePlayer === undefined
        ? {}
        : {
            branchedBeforePlayer: structuredClone(input.branchedBeforePlayer),
          }),
      playPreset: structuredClone(sourceContext.playPreset),
      status: "ready",
      canRetry: false,
      bootstrap: structuredClone(sourceContext.bootstrap),
      tools: structuredClone(sourceContext.tools),
      transcript,
      events,
      completedTools: sourceContext.completedTools
        .filter(({ key }) => completedKeys.has(key))
        .map((item) => structuredClone(item)),
      documentAuthorizationCheckpoints: [
        {
          afterEventId: authorizationEventId,
          authorization: derivedDocuments.authorizationCheckpoint(),
        },
      ],
      changedDocuments: changedDocumentsAtHead(
        sourceContext.changedDocuments,
        baseline.state,
        selected.state,
      ),
      nextMaterials: [],
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
      throw new PlayCallChainError("模型请求仍在进行；返回后才能删除世界。");
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
      throw new PlayCallChainError("调用链正在等待模型返回。");

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
        error instanceof Error ? error.message : "玩家原文写入失败。";
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
          error instanceof Error ? error.message : "模型请求中断。";
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
                message: "AI 调用的 Runtime 工具未被接受。",
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
            for (const item of prepared) {
              if (
                item.result.ok &&
                (item.call.name === "world_patch" ||
                  item.call.name === "world_create")
              ) {
                const suffix = `\n\n# Runtime 写入\n\n本次响应中的世界变化已写入端点 ${committed.head}。`;
                item.result.markdown += suffix;
                item.event.markdown += suffix;
                item.transcript.markdown += suffix;
                const completed = workingTools.get(item.key);
                if (completed !== undefined)
                  completed.result = structuredClone(item.result);
              }
            }
          }
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
            const message = "模型没有返回文本或完整工具调用。";
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
              message: "游玩调用链已在后续模型交换中恢复并完整结束。",
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
          error instanceof Error ? error.message : "调用链处理失败。";
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
            ? `后置请求失败：${error.message}`
            : "后置请求失败。",
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
    validateIdentity(chainId, "调用链 ID");
    const active = this.#active.get(chainId);
    if (active !== undefined) {
      if (active.worldId !== worldId)
        throw new PlayCallChainError("调用链不属于这个世界。");
      return active;
    }
    const persisted = await this.#readPersisted(worldId);
    if (persisted?.chainId !== chainId)
      throw new PlayCallChainError("调用链不存在；请从最新世界状态开始。");
    if (persisted.status === "running") {
      persisted.status = "interrupted";
      persisted.canRetry = persisted.lastRequest !== null;
      persisted.lastFailure = persisted.canRetry
        ? "服务在模型请求完成前中断；可以原样重发该请求。"
        : "服务在模型请求派发前中断；请使用全新上下文。";
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
        "调用链记录与当前世界端点不同；请使用全新上下文。",
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
        "当前世界已由另一项操作推进；请使用全新上下文。",
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
              "# Runtime 工具拒绝\n\n同一 tool-call ID 已绑定另一组工具名称或参数。",
          };
  } else if (!callChainToolNames.has(call.name)) {
    result = {
      ok: false,
      failureKind: "protocol",
      markdown: `# Runtime 工具拒绝\n\n当前调用链没有提供 ${call.name}。`,
    };
  } else {
    try {
      result = session.documents.execute(call, session.history);
    } catch (error: unknown) {
      result = {
        ok: false,
        failureKind: "protocol",
        markdown: `# Runtime 工具失败\n\n${error instanceof Error ? error.message : "工具执行失败。"}`,
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
      "同一 exchange ID 已绑定另一份玩家原文或上下文方式。",
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
      `调用链文档授权无法恢复：${
        error instanceof Error ? error.message : "checkpoint 无效"
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
    throw new PlayCallChainError("调用链文档授权 checkpoint 顺序无效。");
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

function historicalContextForDerivedWorld(
  source: PersistedPlayCallChainContext,
): PersistedPlayCallChainContext {
  const context = structuredClone(source);
  for (const event of context.events)
    if (event.kind === "player" || event.kind === "assistant")
      delete event.committedHead;
  return context;
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
          "来源调用链事件与模型 transcript 不一致，不能安全派生。",
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
          "来源调用链响应与模型 transcript 不一致，不能安全派生。",
        );
      result.push(structuredClone(item));
      cursor += 1;
      continue;
    }
    if (event.kind === "tool_result") {
      const item = transcript[cursor];
      if (item?.kind !== "tool" || item.toolCallId !== event.callId)
        throw new PlayCallChainError(
          "来源调用链工具结果与模型 transcript 不一致，不能安全派生。",
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

function samePlayerBranch(
  left: { worldId: string; chainId: string; eventId: number } | undefined,
  right: { worldId: string; chainId: string; eventId: number },
): boolean {
  return (
    left?.worldId === right.worldId &&
    left.chainId === right.chainId &&
    left.eventId === right.eventId
  );
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
    throw new PlayCallChainError("调用链持久记录不符合当前格式，无法读取。");
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
    throw new PlayCallChainError(`${label} 无效。`);
}

function validatePlayerText(value: string): void {
  if (value.trim().length === 0)
    throw new PlayCallChainError("玩家原文不能为空。");
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
