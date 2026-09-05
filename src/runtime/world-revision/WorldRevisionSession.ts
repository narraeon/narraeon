import { createHash } from "node:crypto";

import type { AppLocale } from "../../protocol/appPreferences.ts";
import { emptyAggregatedModelUsage } from "../../protocol/modelUsage.ts";
import type {
  V1SettingConversationTurn,
  V1WorldRevisionHistoryItem,
  V1WorldRevisionEpochView,
  V1WorldRevisionOverview,
  V1WorldRevisionStatus,
  V1WorldRevisionView,
} from "../../protocol/v1.ts";
import {
  appendAuthoringUserMessage,
  ModelToolConversation,
  rememberAuthoringRequest,
} from "../authoring/ModelToolConversation.ts";
import { contentTreeFingerprint } from "../content/ContentTreeFingerprint.ts";
import type {
  ModelHost,
  ModelHostBinding,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import { equalModelHostBinding } from "../model/ModelHost.ts";
import {
  settingImprovementPromptForBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type {
  FileNativePromptCompiler,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativePlayBinding,
  FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import type {
  FileNativeWorldRevisionStore,
  StoredWorldRevisionEpoch,
  StoredWorldRevisionPendingSettlement,
  StoredWorldRevisionSession,
  StoredWorldRevisionToolResult,
} from "./FileNativeWorldRevisionStore.ts";
import {
  WorldRevisionAuthoringTransaction,
  worldRevisionRuntimeContract,
  worldRevisionToolDefinitions,
} from "./WorldRevisionAuthoringTransaction.ts";
import type { WorldRevisionWorkspace } from "./WorldRevisionWorkspace.ts";
import { WorldRevisionWorkspaceError } from "./WorldRevisionWorkspace.ts";

export type WorldRevisionContinuation =
  { kind: "fresh_context" } | { kind: "continue_context"; sessionId: string };

interface ActiveTransaction {
  revision: string;
  transaction: WorldRevisionAuthoringTransaction;
}

interface WorldRevisionPreviewInput {
  snapshot: WorldDocumentStore;
  modelBinding: ModelHostBinding;
  playPreset: PlayPresetBinding;
  binding: FileNativePlayBinding;
  epoch: StoredWorldRevisionEpoch;
  maintenance: Awaited<
    ReturnType<FileNativeWorldStore["inspectDocumentMaintenance"]>
  >;
}

/** Conversation orchestration over the shared locked revision worktree. */
export class WorldRevisionSession {
  readonly #store: FileNativeWorldRevisionStore;
  readonly #workspace: WorldRevisionWorkspace;
  readonly #worlds: FileNativeWorldStore;
  readonly #compiler: FileNativePromptCompiler;
  readonly #locale: () => AppLocale;
  readonly #bindModelHost: () => Promise<ModelHost>;
  readonly #bindExistingModelHost: (
    binding: ModelHostBinding,
  ) => Promise<ModelHost>;
  readonly #bindPlayPreset: () => Promise<PlayPresetBinding>;
  readonly #preview: (input: WorldRevisionPreviewInput) => PromptPreview;
  readonly #conversation = new ModelToolConversation<
    StoredWorldRevisionSession,
    V1WorldRevisionView
  >();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    store: FileNativeWorldRevisionStore;
    workspace: WorldRevisionWorkspace;
    worlds: FileNativeWorldStore;
    compiler: FileNativePromptCompiler;
    locale: () => AppLocale;
    bindModelHost: () => Promise<ModelHost>;
    bindExistingModelHost: (binding: ModelHostBinding) => Promise<ModelHost>;
    bindPlayPreset: () => Promise<PlayPresetBinding>;
    preview: (input: WorldRevisionPreviewInput) => PromptPreview;
  }) {
    this.#store = input.store;
    this.#workspace = input.workspace;
    this.#worlds = input.worlds;
    this.#compiler = input.compiler;
    this.#locale = input.locale;
    this.#bindModelHost = input.bindModelHost;
    this.#bindExistingModelHost = input.bindExistingModelHost;
    this.#bindPlayPreset = input.bindPlayPreset;
    this.#preview = input.preview;
  }

  async open(worldId: string): Promise<V1WorldRevisionOverview> {
    await this.#mutate(async () => {
      await this.#recoverWorldSessions(worldId);
      await this.#workspace.open(worldId);
    });
    return this.overview(worldId);
  }

  async activeEpoch(worldId: string): Promise<V1WorldRevisionEpochView | null> {
    return this.#mutate(async () => {
      const epoch = await this.#workspace.active(worldId);
      return epoch === null ? null : this.#workspace.view(epoch, true);
    });
  }

  async overview(worldId: string): Promise<V1WorldRevisionOverview> {
    return this.#mutate(async () => {
      const activeEpoch = await this.#workspace.active(worldId);
      const [sessions, sealedEpochs] = await Promise.all([
        this.#recoverWorldSessions(worldId),
        this.#workspace.sealed(worldId),
      ]);
      const latest = sessions[0] ?? null;
      const shownEpoch = activeEpoch ?? (await this.#workspace.latest(worldId));
      return {
        epoch:
          shownEpoch === null
            ? null
            : this.#workspace.view(
                shownEpoch,
                activeEpoch?.epochId === shownEpoch.epochId,
              ),
        sealedEpochs,
        latest: latest === null ? null : this.#view(latest),
        history: sessions.map(historyItem),
      };
    });
  }

  async status(
    worldId: string,
    sessionId?: string,
  ): Promise<V1WorldRevisionStatus> {
    return this.#mutate(async () => {
      const sessions = await this.#store.listSessions(worldId);
      const selectedIndex =
        sessionId === undefined
          ? sessions.length === 0
            ? -1
            : 0
          : sessions.findIndex((session) => session.sessionId === sessionId);
      let selected = selectedIndex < 0 ? null : sessions[selectedIndex]!;
      if (
        selected !== null &&
        !this.#conversation.isRunning(selected.sessionId) &&
        (selected.runStatus === "running" ||
          selected.pendingSettlement !== null)
      ) {
        selected = await this.#recoverIfNeeded(selected);
        sessions[selectedIndex] = selected;
      }
      const active = await this.#workspace.active(worldId);
      const epoch = active ?? (await this.#workspace.latest(worldId));
      return {
        revision: statusFingerprint(epoch, sessions),
        selected: selected === null ? null : this.#statusView(selected),
      };
    });
  }

  async readSession(
    worldId: string,
    sessionId: string,
  ): Promise<V1WorldRevisionView> {
    return this.#mutate(async () => {
      const session = await this.#store.readSession(sessionId);
      assertWorld(session, worldId);
      return this.#view(await this.#recoverIfNeeded(session));
    });
  }

  async deleteSession(
    worldId: string,
    sessionId: string,
  ): Promise<V1WorldRevisionOverview> {
    await this.#mutate(async () => {
      if (this.#conversation.isRunning(sessionId))
        throw new WorldRevisionWorkspaceError(
          "A running world-revision conversation cannot be deleted",
        );
      const session = await this.#store.readSession(sessionId);
      assertWorld(session, worldId);
      await this.#recoverIfNeeded(session);
      await this.#store.deleteSession(worldId, sessionId);
    });
    return this.overview(worldId);
  }

  async replaceFiles(input: {
    worldId: string;
    epochId: string;
    expectedRevision: string;
    files: readonly { path: string; contents: string; encoding?: "base64" }[];
  }): Promise<V1WorldRevisionOverview> {
    await this.#mutate(async () => {
      await this.#assertNoRunningConversation(input.worldId);
      await this.#workspace.replace(input);
    });
    return this.overview(input.worldId);
  }

  async rollback(input: {
    worldId: string;
    epochId: string;
    changeSetId: string;
    path: string;
  }) {
    const result = await this.#mutate(async () => {
      await this.#assertNoRunningConversation(input.worldId);
      return this.#workspace.rollback(input);
    });
    return {
      status: result.status,
      changeSetId: result.changeSetId,
      path: result.path,
      changes: result.changes,
    };
  }

  async apply(input: {
    worldId: string;
    epochId: string;
    expectedRevision: string;
  }): Promise<V1WorldRevisionOverview> {
    await this.#mutate(async () => {
      await this.#assertNoRunningConversation(input.worldId);
      const epoch = await this.#workspace.active(input.worldId);
      if (epoch?.epochId !== input.epochId)
        throw new WorldRevisionWorkspaceError(
          "The world-revision epoch is no longer active",
        );
      await this.#validateApply(epoch);
      await this.#workspace.apply(input);
    });
    return this.overview(input.worldId);
  }

  async discard(input: {
    worldId: string;
    epochId: string;
  }): Promise<V1WorldRevisionOverview> {
    await this.#mutate(async () => {
      await this.#assertNoRunningConversation(input.worldId);
      await this.#workspace.discard(input);
    });
    return this.overview(input.worldId);
  }

  async send(input: {
    worldId: string;
    requestId: string;
    message: string;
    continuation: WorldRevisionContinuation;
  }): Promise<V1WorldRevisionView> {
    const message = requiredMessage(input.message);
    const requestId = requiredRequestId(input.requestId);
    const prepared = await this.#mutate(async () => {
      let session: StoredWorldRevisionSession | null;
      if (input.continuation.kind === "fresh_context") {
        session = await this.#store.findByCreationRequest(
          input.worldId,
          requestId,
        );
      } else {
        session = await this.#store.readSession(input.continuation.sessionId);
        assertWorld(session, input.worldId);
      }
      if (session !== null) {
        session = await this.#recoverIfNeeded(session);
        if (session.completedRequestIds.includes(requestId))
          return { session, run: null as Promise<V1WorldRevisionView> | null };
        const running = this.#conversation.running(session.sessionId);
        if (running !== null) {
          if (running.requestId !== requestId)
            throw new Error(
              "Another message in this world-revision conversation is still running",
            );
          return { session, run: running.promise };
        }
      }
      await this.#assertNoRunningConversation(
        input.worldId,
        session?.sessionId,
      );
      const epoch = await this.#workspace.open(input.worldId);
      session ??= await this.#create(input.worldId, epoch, requestId);
      if (session.epochId !== epoch.epochId) {
        retargetSession(session, epoch, this.#locale());
        await this.#store.saveSession(session);
      }
      const host = await this.#bindExistingModelHost(session.modelBinding);
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "No saved model connection matches this world-revision conversation",
        );
      appendAuthoringUserMessage(session, message, requestId);
      await this.#store.saveSession(session);
      return {
        session,
        run: this.#startRun(session, host, requestId),
      };
    });
    return prepared.run ?? this.#view(prepared.session);
  }

  async cancel(sessionId: string): Promise<V1WorldRevisionView> {
    const running = this.#conversation.cancel(sessionId);
    if (running !== null) return running;
    return this.#mutate(async () =>
      this.#view(
        await this.#recoverIfNeeded(await this.#store.readSession(sessionId)),
      ),
    );
  }

  async #create(
    worldId: string,
    epoch: StoredWorldRevisionEpoch,
    creationRequestId: string,
  ): Promise<StoredWorldRevisionSession> {
    const [host, playPreset, worlds] = await Promise.all([
      this.#bindModelHost(),
      this.#bindPlayPreset(),
      this.#worlds.listWorlds(),
    ]);
    const worldTitle =
      worlds.find((world) => world.worldId === worldId)?.title ?? worldId;
    const locale = this.#locale();
    const modelBinding = host.binding();
    const tools = worldRevisionToolDefinitions(locale);
    const bootstrap = this.#compiler.compileWorldRevision({
      worldTitle,
      runtimeContract: worldRevisionRuntimeContract(locale),
      authorPrompt: settingImprovementPromptForBinding(playPreset, locale),
      playPreset,
      modelBinding,
      tools,
    });
    const now = Date.now();
    const session: StoredWorldRevisionSession = {
      schemaVersion: 1,
      sessionId: this.#store.createSessionId(),
      worldId,
      worldTitle,
      epochId: epoch.epochId,
      locale,
      runStatus: "ready",
      createdAt: now,
      updatedAt: now,
      creationRequestId,
      bootstrap,
      modelBinding,
      playPreset: structuredClone(playPreset),
      modelItems: [],
      messages: [],
      usage: emptyAggregatedModelUsage(),
      exchange: 0,
      toolCalls: 0,
      activeRequestId: null,
      completedRequestIds: [],
      lastFailure: null,
      authorization: null,
      pendingSettlement: null,
    };
    await this.#store.saveSession(session);
    return session;
  }

  #startRun(
    session: StoredWorldRevisionSession,
    host: ModelHost,
    requestId: string,
  ): Promise<V1WorldRevisionView> {
    let activeTransaction: ActiveTransaction | null = null;
    return this.#conversation.run({
      session,
      host,
      requestId,
      save: (next) => this.#store.saveSession(next),
      settleToolResponse: async (next, assistantItemIndex, calls) => {
        activeTransaction = await this.#settleToolResponse(
          next,
          assistantItemIndex,
          calls,
          activeTransaction,
        );
      },
      view: (next) => this.#view(next),
      failure: {
        exchangeLimit:
          "World revision exceeded 64 model exchanges for one user message",
        cancelled:
          "The world-revision response was cancelled. Settled worktree changes were retained.",
        interrupted: "The world-revision response was interrupted",
      },
    });
  }

  async #settleToolResponse(
    session: StoredWorldRevisionSession,
    assistantItemIndex: number,
    calls: readonly ModelHostToolCall[],
    active: ActiveTransaction | null,
  ): Promise<ActiveTransaction> {
    const epoch = await this.#requiredActiveEpoch(session);
    const beforeRevision = epoch.revision;
    session.pendingSettlement = {
      phase: "response_confirmed",
      assistantItemIndex,
      epochId: epoch.epochId,
      beforeRevision,
    };
    session.updatedAt = Date.now();
    await this.#store.saveSession(session);
    const binding = await this.#worlds.bindWorldRevision({
      worldId: epoch.worldId,
      epochId: epoch.epochId,
    });
    const transaction =
      active?.revision === beforeRevision
        ? active.transaction
        : await this.#openTransaction(session, epoch, binding);
    const rawResults = transaction.execute(calls);
    const files = transaction.files();
    const afterRevision = contentTreeFingerprint(files);
    const toolResults = rawResults.map(
      (result): StoredWorldRevisionToolResult => ({
        ...structuredClone(result),
        changeSetId:
          result.isError || result.changes.length === 0
            ? null
            : this.#store.createChangeSetId(),
      }),
    );
    const prepared: Extract<
      StoredWorldRevisionPendingSettlement,
      { phase: "publication_prepared" }
    > = {
      phase: "publication_prepared",
      assistantItemIndex,
      epochId: epoch.epochId,
      beforeRevision,
      afterRevision,
      afterFiles: files,
      toolResults,
      authorization: transaction.authorization(afterRevision),
    };
    session.pendingSettlement = prepared;
    session.updatedAt = Date.now();
    await this.#store.saveSession(session);
    await this.#workspace.publishAi({
      worldId: epoch.worldId,
      epochId: epoch.epochId,
      expectedRevision: beforeRevision,
      afterRevision,
      files,
      toolResults,
    });
    finalizeSettlement(session, prepared);
    session.updatedAt = Date.now();
    await this.#store.saveSession(session);
    return { revision: afterRevision, transaction };
  }

  async #openTransaction(
    session: StoredWorldRevisionSession,
    epoch: StoredWorldRevisionEpoch,
    binding: FileNativePlayBinding,
  ): Promise<WorldRevisionAuthoringTransaction> {
    const maintenance = await this.#worlds.inspectDocumentMaintenance(
      epoch.worldId,
      epoch.baseHead,
    );
    return new WorldRevisionAuthoringTransaction({
      baseFiles: epoch.files,
      immutableBaseFiles: epoch.baseFiles,
      locale: session.locale,
      revision: epoch.revision,
      authorization: session.authorization,
      preview: (snapshot) =>
        this.#preview({
          snapshot,
          modelBinding: session.modelBinding,
          playPreset: session.playPreset,
          binding,
          epoch,
          maintenance,
        }),
    });
  }

  async #validateApply(epoch: StoredWorldRevisionEpoch): Promise<void> {
    const [host, playPreset, binding, maintenance] = await Promise.all([
      this.#bindModelHost(),
      this.#bindPlayPreset(),
      this.#worlds.bindWorldRevision({
        worldId: epoch.worldId,
        epochId: epoch.epochId,
      }),
      this.#worlds.inspectDocumentMaintenance(epoch.worldId, epoch.baseHead),
    ]);
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: epoch.files,
    });
    if (snapshot.status !== "usable")
      throw new WorldRevisionWorkspaceError(
        "Only a usable world-revision worktree can be applied",
      );
    try {
      this.#preview({
        snapshot,
        modelBinding: host.binding(),
        playPreset,
        binding,
        epoch,
        maintenance,
      });
    } catch (error: unknown) {
      throw new WorldRevisionWorkspaceError(
        `World-revision Prompt Preview failed: ${
          error instanceof Error ? error.message : "unknown preview failure"
        }`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async #recoverIfNeeded(
    session: StoredWorldRevisionSession,
  ): Promise<StoredWorldRevisionSession> {
    if (this.#conversation.isRunning(session.sessionId)) return session;
    if (session.pendingSettlement !== null) {
      const pending = session.pendingSettlement;
      if (pending.phase === "publication_prepared") {
        const active = await this.#workspace.active(session.worldId);
        if (active?.epochId === pending.epochId) {
          try {
            await this.#workspace.publishAi({
              worldId: session.worldId,
              epochId: pending.epochId,
              expectedRevision: pending.beforeRevision,
              afterRevision: pending.afterRevision,
              files: pending.afterFiles,
              toolResults: pending.toolResults,
            });
            finalizeSettlement(session, pending);
          } catch (error: unknown) {
            finalizeUnconfirmed(session, pending.assistantItemIndex, error);
          }
        } else
          finalizeUnconfirmed(
            session,
            pending.assistantItemIndex,
            new Error(
              "The revision epoch ended before tool publication recovered",
            ),
          );
      } else
        finalizeUnconfirmed(
          session,
          pending.assistantItemIndex,
          new Error(
            "Runtime restarted before the complete tool response was prepared",
          ),
        );
    }
    if (session.runStatus !== "running" && session.pendingSettlement === null)
      return session;
    const requestId = session.activeRequestId;
    session.runStatus = "interrupted";
    session.activeRequestId = null;
    if (requestId !== null)
      session.completedRequestIds = rememberAuthoringRequest(
        session.completedRequestIds,
        requestId,
      );
    session.lastFailure =
      "The previous model request stopped after its last settled worktree change. Continue this conversation when ready.";
    session.updatedAt = Date.now();
    await this.#store.saveSession(session);
    return session;
  }

  async #requiredActiveEpoch(
    session: StoredWorldRevisionSession,
  ): Promise<StoredWorldRevisionEpoch> {
    const epoch = await this.#workspace.active(session.worldId);
    if (epoch?.epochId !== session.epochId)
      throw new WorldRevisionWorkspaceError(
        "The conversation's revision epoch is no longer active",
      );
    return epoch;
  }

  async #recoverWorldSessions(
    worldId: string,
  ): Promise<StoredWorldRevisionSession[]> {
    const sessions: StoredWorldRevisionSession[] = [];
    for (const stored of await this.#store.listSessions(worldId))
      sessions.push(await this.#recoverIfNeeded(stored));
    return sessions;
  }

  async #assertNoRunningConversation(
    worldId: string,
    exceptSessionId?: string,
  ): Promise<void> {
    const sessions = await this.#recoverWorldSessions(worldId);
    if (
      sessions.some(
        ({ sessionId }) =>
          sessionId !== exceptSessionId &&
          this.#conversation.isRunning(sessionId),
      )
    )
      throw new WorldRevisionWorkspaceError(
        "Wait for or cancel the running AI response before changing the revision",
      );
  }

  #view(session: StoredWorldRevisionSession): V1WorldRevisionView {
    const streaming =
      session.runStatus === "running"
        ? this.#conversation.streaming(session.sessionId)
        : null;
    return {
      sessionId: session.sessionId,
      worldId: session.worldId,
      epochId: session.epochId,
      runStatus: streaming === null ? session.runStatus : "running",
      messages: structuredClone(session.messages),
      turns: conversationTurns(session),
      usage: structuredClone(session.usage),
      progress: {
        exchange: session.exchange,
        toolCalls: session.toolCalls,
        streaming,
        updatedAt: session.updatedAt,
      },
      lastFailure: session.lastFailure,
    };
  }

  #statusView(
    session: StoredWorldRevisionSession,
  ): NonNullable<V1WorldRevisionStatus["selected"]> {
    const streaming =
      session.runStatus === "running"
        ? this.#conversation.streaming(session.sessionId)
        : null;
    return {
      sessionId: session.sessionId,
      runStatus: streaming === null ? session.runStatus : "running",
      progress: {
        exchange: session.exchange,
        toolCalls: session.toolCalls,
        streaming,
        updatedAt: session.updatedAt,
      },
    };
  }

  async #mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function retargetSession(
  session: StoredWorldRevisionSession,
  epoch: StoredWorldRevisionEpoch,
  locale: AppLocale,
): void {
  const markdown =
    locale === "zh-CN"
      ? `# 新的世界修订 epoch\n\n上一轮修订已经应用或放弃。当前工作树是 ${epoch.epochId}，从世界端点 ${epoch.baseHead} 重新建立。此前全部 list/search cursor 和 read 写授权已失效；修改前必须重新读取。`
      : `# New world-revision epoch\n\nThe previous revision was applied or discarded. Worktree ${epoch.epochId} was rebuilt from world endpoint ${epoch.baseHead}. Every prior list/search cursor and read authorization is invalid; re-read before writing.`;
  session.modelItems.push({
    kind: "prompt_delta",
    logicalMessages: [
      {
        role: "runtime_system",
        markdown,
        blocks: [
          {
            source: `runtime:world-revision-epoch:${epoch.epochId}`,
            markdown,
          },
        ],
      },
    ],
  });
  session.epochId = epoch.epochId;
  session.authorization = null;
  session.pendingSettlement = null;
  session.lastFailure = null;
  session.updatedAt = Date.now();
}

function finalizeSettlement(
  session: StoredWorldRevisionSession,
  pending: Extract<
    StoredWorldRevisionPendingSettlement,
    { phase: "publication_prepared" }
  >,
): void {
  for (const result of pending.toolResults)
    session.modelItems.push({
      kind: "tool",
      toolCallId: result.toolCallId,
      markdown: result.markdown,
      ...(result.isError ? { isError: true } : {}),
      changes: structuredClone(result.changes),
      changeSetId: result.changeSetId,
    });
  session.authorization = structuredClone(pending.authorization);
  session.toolCalls += pending.toolResults.length;
  session.pendingSettlement = null;
}

function finalizeUnconfirmed(
  session: StoredWorldRevisionSession,
  assistantItemIndex: number,
  error: unknown,
): void {
  const assistant = assistantAt(session, assistantItemIndex);
  const message = error instanceof Error ? error.message : "unknown failure";
  for (const call of assistant.toolCalls)
    session.modelItems.push({
      kind: "tool",
      toolCallId: call.id,
      markdown: `# Revision settlement could not be confirmed\n\n${message}. Re-read the active worktree before editing.`,
      isError: true,
      changes: [],
      changeSetId: null,
    });
  session.authorization = null;
  session.toolCalls += assistant.toolCalls.length;
  session.pendingSettlement = null;
}

function assistantAt(
  session: StoredWorldRevisionSession,
  itemIndex: number,
): Extract<
  StoredWorldRevisionSession["modelItems"][number],
  { kind: "assistant" }
> {
  const item = session.modelItems[itemIndex];
  if (item?.kind !== "assistant" || item.toolCalls.length === 0)
    throw new Error("Pending world-revision settlement is damaged");
  return item;
}

function conversationTurns(
  session: StoredWorldRevisionSession,
): V1SettingConversationTurn[] {
  const userMessages = session.messages.filter(({ role }) => role === "user");
  const turns: V1SettingConversationTurn[] = [];
  let userIndex = 0;
  let exchange = 0;
  let current: V1SettingConversationTurn | null = null;
  let pending = new Map<
    string,
    V1SettingConversationTurn["exchanges"][number]["toolCalls"][number]
  >();
  for (const [itemIndex, item] of session.modelItems.entries()) {
    if (item.kind === "user") {
      const persisted = userMessages[userIndex++];
      current = {
        id: persisted?.id ?? `${session.sessionId}:turn:${itemIndex}`,
        user:
          persisted ??
          ({
            id: `${session.sessionId}:user:${itemIndex}`,
            role: "user",
            text: item.text,
            createdAt: session.createdAt,
          } as const),
        exchanges: [],
      };
      turns.push(current);
      pending = new Map();
    } else if (item.kind === "assistant" && current !== null) {
      exchange += 1;
      const toolCalls = item.toolCalls.map((call) => ({
        callId: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
        result: null,
      }));
      current.exchanges.push({
        id: `${session.sessionId}:exchange:${itemIndex}`,
        exchange,
        text: item.text,
        ...(item.reasoningContent === undefined
          ? {}
          : { reasoning: item.reasoningContent }),
        toolCalls,
      });
      pending = new Map(toolCalls.map((call) => [call.callId, call] as const));
    } else if (item.kind === "tool") {
      const call = pending.get(item.toolCallId);
      if (call?.result === null)
        call.result = {
          markdown: item.markdown,
          isError: item.isError === true,
          changes: structuredClone(item.changes),
          changeSetId: item.changeSetId,
        };
    }
  }
  return turns;
}

function historyItem(
  session: StoredWorldRevisionSession,
): V1WorldRevisionHistoryItem {
  const assistants = session.modelItems.filter(
    (item) => item.kind === "assistant",
  );
  const changed = new Set(
    session.modelItems.flatMap((item) =>
      item.kind === "tool" ? item.changes.map(({ path }) => path) : [],
    ),
  );
  return {
    sessionId: session.sessionId,
    epochId: session.epochId,
    runStatus: session.runStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    excerpt: Array.from(
      (session.messages.find(({ role }) => role === "user")?.text ?? "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
      .slice(0, 120)
      .join(""),
    turnCount: session.modelItems.filter((item) => item.kind === "user").length,
    exchangeCount: assistants.length,
    toolCallCount: assistants.reduce(
      (count, item) => count + item.toolCalls.length,
      0,
    ),
    changedFileCount: changed.size,
  };
}

function statusFingerprint(
  epoch: StoredWorldRevisionEpoch | null,
  sessions: readonly StoredWorldRevisionSession[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        epoch:
          epoch === null
            ? null
            : {
                epochId: epoch.epochId,
                lifecycle: epoch.lifecycle,
                revision: epoch.revision,
                updatedAt: epoch.updatedAt,
              },
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          epochId: session.epochId,
          runStatus: session.runStatus,
          updatedAt: session.updatedAt,
          exchange: session.exchange,
          toolCalls: session.toolCalls,
        })),
      }),
    )
    .digest("hex");
}

function assertWorld(
  session: StoredWorldRevisionSession,
  worldId: string,
): void {
  if (session.worldId !== worldId)
    throw new WorldRevisionWorkspaceError(
      "World-revision conversation belongs to another world",
    );
}

function requiredMessage(message: string): string {
  if (message.trim().length === 0)
    throw new WorldRevisionWorkspaceError(
      "A world-revision message cannot be empty",
    );
  if (message.length > 64 * 1024)
    throw new WorldRevisionWorkspaceError(
      "World-revision message is too large",
    );
  return message;
}

function requiredRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId))
    throw new WorldRevisionWorkspaceError("Invalid world-revision request ID");
  return requestId;
}
