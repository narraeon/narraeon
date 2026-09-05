import type { AppLocale } from "../../protocol/appPreferences.ts";
import { emptyAggregatedModelUsage } from "../../protocol/modelUsage.ts";
import type {
  V1SettingAuthoringDiff,
  V1SettingConversationTurn,
  V1SettingImprovementHistoryItem,
  V1SettingImprovementOverview,
  V1SettingImprovementRollbackResult,
  V1SettingImprovementStatus,
  V1SettingImprovementView,
} from "../../protocol/v1.ts";
import {
  InvalidContentTreeError,
  type ContentWorkspace,
} from "../content/ContentWorkspace.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
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
import type { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import {
  appendAuthoringUserMessage,
  ModelToolConversation,
  rememberAuthoringRequest,
} from "../authoring/ModelToolConversation.ts";
import {
  summarizeStoredSettingImprovementSession,
  type FileNativeSettingImprovementStore,
  type StoredSettingImprovementSession,
  type StoredSettingPreparedPublication,
  type StoredSettingImprovementSummary,
} from "./FileNativeSettingImprovementStore.ts";
import {
  SettingAuthoringTransaction,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "./SettingAuthoringTransaction.ts";

export type SettingImprovementView = V1SettingImprovementView;
export type SettingImprovementContinuation =
  { kind: "fresh_context" } | { kind: "continue_context"; sessionId: string };

interface ActiveTransaction {
  revision: string;
  transaction: SettingAuthoringTransaction;
}

class RecoveryWriteConflictError extends Error {}

export class SettingImprovementRollbackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingImprovementRollbackError";
  }
}

export class SettingImprovementSession {
  readonly #store: FileNativeSettingImprovementStore;
  readonly #content: ContentWorkspace;
  readonly #compiler: FileNativePromptCompiler;
  readonly #locale: () => AppLocale;
  readonly #bindModelHost: () => Promise<ModelHost>;
  readonly #bindExistingModelHost: (
    binding: ModelHostBinding,
  ) => Promise<ModelHost>;
  readonly #bindPlayPreset: () => Promise<PlayPresetBinding>;
  readonly #preview: (
    snapshot: WorldDocumentStore,
    modelBinding: ModelHostBinding,
    playPreset: PlayPresetBinding | undefined,
  ) => PromptPreview;
  readonly #conversation = new ModelToolConversation<
    StoredSettingImprovementSession,
    SettingImprovementView
  >();
  readonly #changed: (id: string, durable: boolean) => void;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    changed?: (id: string, durable: boolean) => void;
    store: FileNativeSettingImprovementStore;
    content: ContentWorkspace;
    compiler: FileNativePromptCompiler;
    locale: () => AppLocale;
    bindModelHost: () => Promise<ModelHost>;
    bindExistingModelHost?: (binding: ModelHostBinding) => Promise<ModelHost>;
    bindPlayPreset: () => Promise<PlayPresetBinding>;
    preview: (
      snapshot: WorldDocumentStore,
      modelBinding: ModelHostBinding,
      playPreset: PlayPresetBinding | undefined,
    ) => PromptPreview;
  }) {
    this.#changed =
      input.changed ??
      (() => {
        /* No observers attached. */
      });
    this.#store = input.store;
    this.#content = input.content;
    this.#compiler = input.compiler;
    this.#locale = input.locale;
    this.#bindModelHost = input.bindModelHost;
    this.#bindExistingModelHost =
      input.bindExistingModelHost ??
      (async (binding) => {
        const host = await input.bindModelHost();
        if (!equalModelHostBinding(binding, host.binding()))
          throw new Error(
            "The enabled model connection no longer matches this setting-improvement conversation",
          );
        return host;
      });
    this.#bindPlayPreset = input.bindPlayPreset;
    this.#preview = input.preview;
  }

  /** Latest conversation for compatibility with the original read endpoint. */
  async read(packageId: string): Promise<SettingImprovementView | null> {
    return this.#mutate(async () => {
      const session = await this.#store.findLatestByPackage(packageId);
      return session === null
        ? null
        : this.#view(await this.#recoverIfNeeded(session));
    });
  }

  async overview(packageId: string): Promise<V1SettingImprovementOverview> {
    return this.#mutate(async () => {
      let summaries = await this.#store.listSummariesByPackage(packageId);
      const latestSummary = summaries[0];
      const latest =
        latestSummary === undefined
          ? null
          : await this.#recoverIfNeeded(
              await this.#store.read(latestSummary.sessionId),
            );
      if (latest !== null) {
        const index = summaries.findIndex(
          ({ sessionId }) => sessionId === latest.sessionId,
        );
        if (index >= 0)
          summaries[index] = summarizeStoredSettingImprovementSession(latest);
        summaries = summaries.sort(compareStoredSummaries);
      }
      return {
        latest: latest === null ? null : this.#view(latest),
        history: summaries.map(settingImprovementHistoryItem),
      };
    });
  }

  observeProgress(
    status: V1SettingImprovementStatus,
  ): V1SettingImprovementStatus {
    const selected = status.selected;
    if (selected === null) return status;
    return {
      ...status,
      selected: {
        ...selected,
        progress: {
          ...selected.progress,
          streaming: this.#conversation.streaming(selected.sessionId),
        },
      },
    };
  }

  async status(
    packageId: string,
    sessionId?: string,
  ): Promise<V1SettingImprovementStatus> {
    return this.#mutate(async () => {
      let status = await this.#store.summaryStatusByPackage(
        packageId,
        sessionId,
      );
      let selected = status.selected;
      if (
        selected?.needsRecovery === true &&
        !this.#conversation.isRunning(selected.sessionId)
      ) {
        const recovered = await this.#recoverIfNeeded(
          await this.#store.read(selected.sessionId),
        );
        selected = summarizeStoredSettingImprovementSession(recovered);
        status = await this.#store.summaryStatusByPackage(packageId, sessionId);
      }
      return {
        revision: status.revision,
        selected: selected === null ? null : this.#statusView(selected),
      };
    });
  }

  async readSession(
    packageId: string,
    sessionId: string,
  ): Promise<SettingImprovementView> {
    return this.#mutate(async () => {
      const stored = await this.#store.read(sessionId);
      assertPackage(stored, packageId);
      return this.#view(await this.#recoverIfNeeded(stored));
    });
  }

  async deleteSession(
    packageId: string,
    sessionId: string,
  ): Promise<V1SettingImprovementOverview> {
    await this.#mutate(async () => {
      if (this.#conversation.isRunning(sessionId))
        throw new Error(
          "A running setting-improvement conversation cannot be deleted",
        );
      const stored = await this.#store.read(sessionId);
      assertPackage(stored, packageId);
      await this.#recoverIfNeeded(stored);
      await this.#store.deleteSession(packageId, sessionId);
    });
    return this.overview(packageId);
  }

  /**
   * Restore one selected file from a historical AI tool call. The explicit
   * rollback wins over the file's current contents; the transcript remains
   * append-only.
   */
  async rollback(input: {
    packageId: string;
    sessionId: string;
    changeSetId: string;
    path: string;
  }): Promise<V1SettingImprovementRollbackResult> {
    return this.#mutate(async () => {
      if (this.#conversation.isRunning(input.sessionId))
        throw new SettingImprovementRollbackError(
          "A running setting-improvement conversation cannot be rolled back",
        );
      let session = await this.#store.read(input.sessionId);
      if (session.packageId !== input.packageId)
        throw new SettingImprovementRollbackError(
          "The setting-improvement conversation does not belong to this content package",
        );
      session = await this.#recoverIfNeeded(session);
      const change = rollbackChangeFor(session, input.changeSetId, input.path);
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        input.packageId,
      );
      try {
        if (treeMatchesChangeBefore(lease.package.files, change))
          return {
            status: "already_rolled_back",
            changeSetId: input.changeSetId,
            path: input.path,
            changes: [],
          };
        const rollbackDiff = diffForRollback(lease.package.files, change);
        const restoredFiles = restoreChangeBefore(lease.package.files, change);
        try {
          this.#content.validateCurrentTreeContentPackage(restoredFiles);
          await lease.replace(restoredFiles);
        } catch (error: unknown) {
          if (!(error instanceof InvalidContentTreeError)) throw error;
          throw new SettingImprovementRollbackError(
            "The recorded previous files no longer satisfy the current storage boundary",
            { cause: error },
          );
        }
        return {
          status: "rolled_back",
          changeSetId: input.changeSetId,
          path: input.path,
          changes: [rollbackDiff],
        };
      } finally {
        lease.release();
      }
    });
  }

  async send(input: {
    packageId: string;
    requestId: string;
    message: string;
    continuation: SettingImprovementContinuation;
  }): Promise<SettingImprovementView> {
    const message = requiredMessage(input.message);
    const requestId = requiredRequestId(input.requestId);
    const prepared = await this.#mutate(async () => {
      let session: StoredSettingImprovementSession;
      if (input.continuation.kind === "fresh_context") {
        session =
          (await this.#store.findByCreationRequest(
            input.packageId,
            requestId,
          )) ?? (await this.#create(input.packageId, requestId));
      } else {
        session = await this.#store.read(input.continuation.sessionId);
        assertPackage(session, input.packageId);
      }
      session = await this.#recoverIfNeeded(session);
      if (session.completedRequestIds.includes(requestId))
        return { session, run: null as Promise<SettingImprovementView> | null };
      const running = this.#conversation.running(session.sessionId);
      if (running !== null) {
        if (running.requestId !== requestId)
          throw new Error(
            "Another message in this setting-improvement conversation is still running",
          );
        return { session, run: running.promise };
      }
      const host = await this.#bindExistingModelHost(session.modelBinding);
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "No saved model connection matches this setting-improvement conversation",
        );
      appendAuthoringUserMessage(session, message, requestId);
      await this.#store.save(session);
      return { session, run: this.#startRun(session, host, requestId) };
    });
    return prepared.run ?? this.#view(prepared.session);
  }

  async cancel(sessionId: string): Promise<SettingImprovementView> {
    const running = this.#conversation.cancel(sessionId);
    if (running !== null) return running;
    return this.#mutate(async () =>
      this.#view(
        await this.#recoverIfNeeded(await this.#store.read(sessionId)),
      ),
    );
  }

  async #create(
    packageId: string,
    creationRequestId: string,
  ): Promise<StoredSettingImprovementSession> {
    const [package_, host, playPreset] = await Promise.all([
      this.#content.readCurrentTreeContentPackage(packageId),
      this.#bindModelHost(),
      this.#bindPlayPreset(),
    ]);
    const locale = this.#locale();
    const modelBinding = host.binding();
    const tools = settingImprovementToolDefinitions(locale);
    const bootstrap = this.#compiler.compileSettingImprovement({
      contentPackageTitle: package_.title,
      runtimeContract: settingImprovementRuntimeContract(locale),
      authorPrompt: settingImprovementPromptForBinding(playPreset, locale),
      playPreset,
      modelBinding,
      tools,
    });
    const now = Date.now();
    const session: StoredSettingImprovementSession = {
      schemaVersion: 2,
      sessionId: this.#store.createId(),
      packageId,
      contentPackageTitle: package_.title,
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
      legacyDraft: null,
    };
    await this.#store.save(session);
    return session;
  }

  #startRun(
    session: StoredSettingImprovementSession,
    host: ModelHost,
    requestId: string,
  ): Promise<SettingImprovementView> {
    let activeTransaction: ActiveTransaction | null = null;
    return this.#conversation.run({
      changed: (durable) => this.#changed(session.packageId, durable),
      session,
      host,
      requestId,
      save: (next) => this.#store.save(next),
      settleToolResponse: async (next, assistantItemIndex, toolCalls) => {
        activeTransaction = await this.#settleToolResponse(
          next,
          assistantItemIndex,
          toolCalls,
          activeTransaction,
        );
      },
      view: (next) => this.#view(next),
      failure: {
        emptyResponse:
          "The model returned an empty tool-free authoring response",
        exchangeLimit:
          "Setting improvement exceeded 64 model exchanges for one user message",
        cancelled:
          "The setting-improvement response was cancelled. Complete tool responses already published to the current tree were retained.",
        interrupted: "The setting-improvement response was interrupted",
      },
    });
  }

  async #settleToolResponse(
    session: StoredSettingImprovementSession,
    assistantItemIndex: number,
    calls: readonly ModelHostToolCall[],
    active: ActiveTransaction | null,
  ): Promise<ActiveTransaction> {
    const lease = await this.#content.beginCurrentTreeContentPackageOperation(
      session.packageId,
    );
    try {
      const beforeFingerprint = contentTreeFingerprint(lease.package.files);
      session.pendingSettlement = {
        phase: "response_confirmed",
        assistantItemIndex,
        beforeFingerprint,
      };
      session.updatedAt = Date.now();
      // Persist the complete Provider-native assistant item together with the
      // exact tree revision it may settle against before executing any call.
      await this.#store.save(session);
      const transaction =
        active?.revision === beforeFingerprint
          ? active.transaction
          : this.#openTransaction(
              session,
              lease.package.files,
              beforeFingerprint,
            );
      const results = transaction.execute(calls);
      const afterFiles = transaction.files();
      const afterFingerprint = contentTreeFingerprint(afterFiles);
      const prepared: StoredSettingPreparedPublication = {
        phase: "publication_prepared",
        assistantItemIndex,
        beforeFingerprint,
        afterFingerprint,
        toolResults: structuredClone(results),
        authorization: transaction.authorization(afterFingerprint),
      };
      session.pendingSettlement = prepared;
      session.updatedAt = Date.now();
      await this.#store.save(session);
      if (afterFingerprint !== beforeFingerprint) {
        try {
          await lease.replace(afterFiles);
        } catch (error: unknown) {
          if (!(error instanceof InvalidContentTreeError)) throw error;
          throw new Error(
            "A current-tree transaction passed per-call validation but publication rejected it",
            { cause: error },
          );
        }
      }
      this.#finalizeSettlement(session, prepared);
      session.updatedAt = Date.now();
      await this.#store.save(session);
      return { revision: afterFingerprint, transaction };
    } finally {
      lease.release();
    }
  }

  #openTransaction(
    session: StoredSettingImprovementSession,
    files: readonly ContentTreeFile[],
    revision: string,
  ): SettingAuthoringTransaction {
    return new SettingAuthoringTransaction({
      baseFiles: files,
      locale: session.locale,
      revision,
      authorization: session.authorization,
      validateFiles: (files) =>
        this.#content.validateCurrentTreeContentPackage(files),
      preview: (snapshot) =>
        this.#preview(snapshot, session.modelBinding, session.playPreset),
    });
  }

  #finalizeSettlement(
    session: StoredSettingImprovementSession,
    pending: StoredSettingPreparedPublication,
  ): void {
    for (const result of pending.toolResults)
      session.modelItems.push({
        kind: "tool",
        toolCallId: result.toolCallId,
        markdown: result.markdown,
        ...(result.isError ? { isError: true } : {}),
        changes: structuredClone(result.changes),
      });
    session.authorization = structuredClone(pending.authorization);
    session.toolCalls += pending.toolResults.length;
    session.pendingSettlement = null;
  }

  async #recoverIfNeeded(
    original: StoredSettingImprovementSession,
  ): Promise<StoredSettingImprovementSession> {
    if (this.#conversation.isRunning(original.sessionId)) return original;
    let expected = original;
    const session = structuredClone(original);
    const pendingAssistant = lastPendingAssistant(session);
    if (session.pendingSettlement === null && pendingAssistant !== null) {
      this.#finalizeUnconfirmedToolResponse(
        session,
        pendingAssistant.itemIndex,
        "Runtime found a complete tool response without the persisted current-tree revision that authorized it. The calls were not replayed against a newer tree; read the current tree again before editing.",
      );
      markInterruptedAfterRestart(session);
      session.updatedAt = Date.now();
      if (await this.#store.saveIfUnchanged(expected, session)) return session;
      return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
    }

    if (session.pendingSettlement !== null) {
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        session.packageId,
      );
      let retry = false;
      try {
        try {
          let fingerprint = contentTreeFingerprint(lease.package.files);
          const pending = session.pendingSettlement;
          let prepared: StoredSettingPreparedPublication | null =
            pending.phase === "publication_prepared" ? pending : null;
          if (fingerprint === pending.beforeFingerprint) {
            const assistant = assistantAt(session, pending.assistantItemIndex);
            const transaction = this.#openTransaction(
              session,
              lease.package.files,
              fingerprint,
            );
            const results = transaction.execute(assistant.toolCalls);
            const afterFiles = transaction.files();
            const afterFingerprint = contentTreeFingerprint(afterFiles);
            prepared = {
              phase: "publication_prepared",
              assistantItemIndex: pending.assistantItemIndex,
              beforeFingerprint: fingerprint,
              afterFingerprint,
              toolResults: structuredClone(results),
              authorization: transaction.authorization(afterFingerprint),
            };
            session.pendingSettlement = prepared;
            session.updatedAt = Date.now();
            if (!(await this.#store.saveIfUnchanged(expected, session)))
              throw new RecoveryWriteConflictError();
            expected = structuredClone(session);
            if (afterFingerprint !== fingerprint) {
              await lease.replace(afterFiles);
              fingerprint = afterFingerprint;
            }
          }

          if (prepared === null) {
            this.#finalizeUnconfirmedToolResponse(
              session,
              pending.assistantItemIndex,
              "The content package changed after Runtime confirmed this tool response but before it could prepare publication. The calls were not replayed against the different tree; read the current tree again before editing.",
            );
          } else if (fingerprint === prepared.afterFingerprint) {
            this.#finalizeSettlement(session, prepared);
          } else {
            this.#finalizeUnconfirmedToolResponse(
              session,
              prepared.assistantItemIndex,
              "The content package no longer matches either the original or prepared revision for this tool response. No claimed change is being treated as authoritative; read the current tree again before editing.",
            );
          }
          markInterruptedAfterRestart(session);
          session.updatedAt = Date.now();
          if (!(await this.#store.saveIfUnchanged(expected, session)))
            throw new RecoveryWriteConflictError();
        } catch (error: unknown) {
          if (error instanceof RecoveryWriteConflictError) retry = true;
          else throw error;
        }
      } finally {
        lease.release();
      }
      if (retry)
        return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
      return session;
    }

    if (session.runStatus === "running") {
      markInterruptedAfterRestart(session);
      session.updatedAt = Date.now();
    } else {
      return session;
    }
    if (await this.#store.saveIfUnchanged(expected, session)) return session;
    return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
  }

  #finalizeUnconfirmedToolResponse(
    session: StoredSettingImprovementSession,
    assistantItemIndex: number,
    message: string,
  ): void {
    const assistant = assistantAt(session, assistantItemIndex);
    for (const call of assistant.toolCalls)
      session.modelItems.push({
        kind: "tool",
        toolCallId: call.id,
        markdown: `# Current-tree settlement could not be confirmed\n\n${message}`,
        isError: true,
        changes: [],
      });
    session.authorization = null;
    session.toolCalls += assistant.toolCalls.length;
    session.pendingSettlement = null;
  }

  #statusView(
    summary: StoredSettingImprovementSummary,
  ): NonNullable<V1SettingImprovementStatus["selected"]> {
    const streaming = this.#conversation.streaming(summary.sessionId);
    return {
      sessionId: summary.sessionId,
      runStatus: streaming === null ? summary.runStatus : "running",
      progress: {
        exchange: summary.exchange,
        toolCalls: summary.toolCalls,
        streaming,
        updatedAt: summary.updatedAt,
      },
    };
  }

  #view(session: StoredSettingImprovementSession): SettingImprovementView {
    const streaming =
      session.runStatus === "running"
        ? this.#conversation.streaming(session.sessionId)
        : null;
    return {
      sessionId: session.sessionId,
      packageId: session.packageId,
      runStatus: streaming === null ? session.runStatus : "running",
      messages: structuredClone(session.messages),
      turns: settingConversationTurns(session),
      legacyDraft:
        session.legacyDraft === null
          ? null
          : structuredClone(session.legacyDraft),
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

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function assertPackage(
  session: StoredSettingImprovementSession,
  packageId: string,
): void {
  if (session.packageId !== packageId)
    throw new Error(
      "The setting-improvement conversation does not belong to this content package",
    );
}

function assistantAt(
  session: StoredSettingImprovementSession,
  itemIndex: number,
): Extract<
  StoredSettingImprovementSession["modelItems"][number],
  { kind: "assistant" }
> {
  const item = session.modelItems[itemIndex];
  if (item?.kind !== "assistant" || item.toolCalls.length === 0)
    throw new Error("Pending setting-improvement settlement is damaged");
  return item;
}

function lastPendingAssistant(
  session: StoredSettingImprovementSession,
): { itemIndex: number; toolCalls: ModelHostToolCall[] } | null {
  const itemIndex = session.modelItems.length - 1;
  const item = session.modelItems[itemIndex];
  return item?.kind === "assistant" && item.toolCalls.length > 0
    ? { itemIndex, toolCalls: item.toolCalls }
    : null;
}

function markInterruptedAfterRestart(
  session: StoredSettingImprovementSession,
): void {
  const requestId = session.activeRequestId;
  session.runStatus = "interrupted";
  session.activeRequestId = null;
  if (requestId !== null)
    session.completedRequestIds = rememberAuthoringRequest(
      session.completedRequestIds,
      requestId,
    );
  session.lastFailure =
    "The previous model request stopped before its next complete response. Every settled current-tree change and complete tool result was retained; continue this conversation when ready.";
}

function requiredMessage(message: string): string {
  if (message.trim().length === 0)
    throw new Error("A setting-improvement message cannot be empty");
  if (message.length > 64 * 1024)
    throw new Error("The setting-improvement message is too large");
  return message;
}

function requiredRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId))
    throw new Error("Invalid setting-improvement request ID");
  return requestId;
}

function settingConversationTurns(
  session: StoredSettingImprovementSession,
): V1SettingConversationTurn[] {
  const userMessages = session.messages.filter(({ role }) => role === "user");
  const turns: V1SettingConversationTurn[] = [];
  let userIndex = 0;
  let exchange = 0;
  let current: V1SettingConversationTurn | null = null;
  let pendingToolCalls = new Map<
    string,
    V1SettingConversationTurn["exchanges"][number]["toolCalls"][number]
  >();

  for (const [itemIndex, item] of session.modelItems.entries()) {
    if (item.kind === "user") {
      const persisted = userMessages[userIndex];
      userIndex += 1;
      current = {
        id: persisted?.id ?? `${session.sessionId}:turn:${itemIndex}`,
        user:
          persisted === undefined
            ? {
                id: `${session.sessionId}:user:${itemIndex}`,
                role: "user",
                text: item.text,
                createdAt: session.createdAt,
              }
            : structuredClone(persisted),
        exchanges: [],
      };
      turns.push(current);
      pendingToolCalls = new Map();
      continue;
    }
    if (item.kind === "assistant") {
      if (current === null) continue;
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
      pendingToolCalls = new Map(
        toolCalls.map((call) => [call.callId, call] as const),
      );
      continue;
    }
    if (item.kind === "tool") {
      const call = pendingToolCalls.get(item.toolCallId);
      if (call?.result === null)
        call.result = {
          markdown: item.markdown,
          isError: item.isError === true,
          changes: structuredClone(item.changes),
          changeSetId:
            item.isError === true || item.changes.length === 0
              ? null
              : changeSetIdForItem(itemIndex),
        };
    }
  }
  return turns;
}

function changeSetIdForItem(itemIndex: number): string {
  return `change-set:${itemIndex}`;
}

function rollbackChangeFor(
  session: StoredSettingImprovementSession,
  changeSetId: string,
  path: string,
): V1SettingAuthoringDiff {
  const result = settingConversationTurns(session)
    .flatMap(({ exchanges }) => exchanges)
    .flatMap(({ toolCalls }) => toolCalls)
    .map(({ result }) => result)
    .find((candidate) => candidate?.changeSetId === changeSetId);
  if (
    result === undefined ||
    result === null ||
    result.isError ||
    result.changes.length === 0
  )
    throw new SettingImprovementRollbackError(
      "The requested AI change set does not exist in this conversation",
    );

  const matches = result.changes.filter((change) => change.path === path);
  const change = matches[0];
  if (
    matches.length !== 1 ||
    change === undefined ||
    (change.kind === "create" &&
      (change.before !== null || change.after === null)) ||
    (change.kind === "modify" &&
      (change.before === null ||
        change.after === null ||
        change.before === change.after)) ||
    (change.kind === "delete" &&
      (change.before === null || change.after !== null))
  )
    throw new SettingImprovementRollbackError(
      "The requested file does not exist in this AI change set",
    );
  return structuredClone(change);
}

function treeMatchesChangeBefore(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): boolean {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const expected = change.before;
  const current = byPath.get(change.path);
  if (expected === null) return current === undefined;
  return (
    current !== undefined &&
    current.encoding === undefined &&
    current.contents === expected
  );
}

function restoreChangeBefore(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): ContentTreeFile[] {
  const restored = new Map(
    files.map((file) => [file.path, structuredClone(file)] as const),
  );
  if (change.before === null) restored.delete(change.path);
  else
    restored.set(change.path, { path: change.path, contents: change.before });
  return [...restored.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function diffForRollback(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): V1SettingAuthoringDiff {
  const current = files.find(({ path }) => path === change.path);
  const before = current?.contents ?? null;
  const after = change.before;
  return {
    path: change.path,
    kind: before === null ? "create" : after === null ? "delete" : "modify",
    before,
    after,
  };
}

function settingImprovementHistoryItem(
  summary: StoredSettingImprovementSummary,
): V1SettingImprovementHistoryItem {
  return {
    sessionId: summary.sessionId,
    runStatus: summary.runStatus,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    excerpt: summary.excerpt,
    turnCount: summary.turnCount,
    exchangeCount: summary.exchangeCount,
    toolCallCount: summary.toolCallCount,
    changedFileCount: summary.changedFileCount,
  };
}

function compareStoredSummaries(
  left: StoredSettingImprovementSummary,
  right: StoredSettingImprovementSummary,
): number {
  return (
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    right.sessionId.localeCompare(left.sessionId)
  );
}
