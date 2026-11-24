import { planAuthoringRollback } from "../authoring/AuthoringRollback.ts";
import {
  AuthoringLiveScopes,
  AuthoringSessionBase,
  assertAuthoringFilePolicy,
  assertCanSendAuthoringMessage,
  assertKnownAuthoringOutcome,
  beginAuthoringRequest,
  captureAuthoringRequestPreview,
  finishInterruptedAuthoringRun,
  recoverLegacyGoogleDispatch,
  resumeAuthoringRequest,
  type AuthoringContinuation,
} from "../authoring/AuthoringSessionBase.ts";
import { RuntimeDomainError } from "../RuntimeDomainError.ts";
import type { GenerationActivity } from "../GenerationActivity.ts";
import { authoringConversationTurns } from "../authoring/AuthoringCallDetails.ts";
import {
  planAuthoringEdit,
  revertAuthoringChanges,
} from "../authoring/AuthoringEditPlan.ts";
import {
  assertCompatibleAuthoring,
  authoringRecovery,
  checkpointNextAuthoringDispatch,
  recoverAuthoringDispatch,
  recoverLegacyLengthLimit,
} from "../authoring/AuthoringRetry.ts";
import { authoringActiveBinding } from "../authoring/AuthoringRequestSnapshot.ts";
import { readGameplay } from "../../protocol/gameplay.ts";
import { isDeepStrictEqual } from "node:util";
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
import type { CurrentTreeContentPackageOperationLease } from "../content/CurrentTreeContentLibrary.ts";
import { contentTreeFingerprint } from "../content/ContentTreeFingerprint.ts";
import type {
  ModelConnectionPrompt,
  ModelHost,
  ModelHostBinding,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import type { PlayPresetBinding } from "../play/FileNativePlayPresetStore.ts";
import type {
  FileNativePromptCompiler,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import {
  recordAuthoringRetryPreview,
  ModelToolConversation,
  type ModelToolConversationStreaming,
  isResponseCorrection,
  recoverPausedAuthoringCorrection,
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
  settingImprovementToolDefinitions,
  authoringPreloadAuthorization,
  buildAuthoringPreload,
  contentPackageAuthoringSurface,
  type AuthoringPreload,
} from "./SettingAuthoringTransaction.ts";

export type SettingImprovementView = V1SettingImprovementView;
export type SettingImprovementContinuation = AuthoringContinuation;

interface ActiveTransaction {
  revision: string;
  transaction: SettingAuthoringTransaction;
}

class RecoveryWriteConflictError extends Error {}

type SettingConversation = ModelToolConversation<
  StoredSettingImprovementSession,
  SettingImprovementView
>;
const liveConversations = new AuthoringLiveScopes<SettingConversation>();

export class SettingImprovementRollbackError extends RuntimeDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, {
      ...options,
      receipt: {
        code: "invalid_request",
        commands: ["setting-improvement.rollback"],
      },
    });
    this.name = "SettingImprovementRollbackError";
  }
}

export class SettingMessageEditError extends RuntimeDomainError {
  readonly reason: "conflict" | "invalid_tree" | "unattributed";
  readonly paths: string[];
  constructor(
    reason: "conflict" | "invalid_tree" | "unattributed",
    paths: string[],
  ) {
    super(
      reason === "conflict"
        ? `Cannot revert changed files: ${paths.join(", ")}`
        : reason === "invalid_tree"
          ? `Reverting would make these files invalid: ${paths.join(", ")}`
          : `Cannot attribute older file changes to this message: ${paths.join(", ")}`,
      {
        receipt: {
          code: "invalid_request",
          commands: ["setting-improvement.message.edit"],
          details: { kind: "setting_message_edit", reason, paths },
        },
      },
    );
    this.name = "SettingMessageEditError";
    this.reason = reason;
    this.paths = paths;
  }
}

export class SettingImprovementSession {
  readonly #store: FileNativeSettingImprovementStore;
  readonly #content: ContentWorkspace;
  readonly #compiler: FileNativePromptCompiler;
  readonly #locale: () => AppLocale;
  readonly #bindModelHost: () => Promise<ModelHost>;
  readonly #bindPlayPreset: () => Promise<PlayPresetBinding>;
  readonly #preview: (
    snapshot: WorldDocumentStore,
    modelBinding: ModelHostBinding,
    playPreset: PlayPresetBinding | undefined,
    modelPrompt?: ModelConnectionPrompt,
  ) => PromptPreview;
  readonly #authoring: AuthoringSessionBase<
    StoredSettingImprovementSession,
    SettingImprovementView
  >;
  readonly #changed: (id: string, durable: boolean) => void;
  readonly #generationActivity: GenerationActivity | undefined;

  constructor(input: {
    changed?: (id: string, durable: boolean) => void;
    generationActivity?: GenerationActivity;
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
      modelPrompt?: ModelConnectionPrompt,
    ) => PromptPreview;
  }) {
    this.#generationActivity = input.generationActivity;
    this.#changed =
      input.changed ??
      (() => {
        /* No observers attached. */
      });
    this.#store = input.store;
    const conversation = liveConversations.get(
      input.store.sessionScope,
      () => new ModelToolConversation(),
    );
    this.#authoring = new AuthoringSessionBase(conversation, {
      name: "setting-improvement",
      inputError: Error,
      read: (id) => this.#store.read(id),
      assertOwner: assertPackage,
      bindModelHost: input.bindModelHost,
      compilePreview: async (targetId, host) => {
        const package_ =
          await this.#content.readCurrentTreeContentPackage(targetId);
        return (await this.#compilePackage(package_, host)).bootstrap;
      },
    });
    this.#content = input.content;
    this.#compiler = input.compiler;
    this.#locale = input.locale;
    this.#bindModelHost = input.bindModelHost;
    this.#bindPlayPreset = input.bindPlayPreset;
    this.#preview = input.preview;
  }

  /** Latest conversation for compatibility with the original read endpoint. */
  async read(packageId: string): Promise<SettingImprovementView | null> {
    return this.#authoring.mutate(async () => {
      const session = await this.#store.findLatestByPackage(packageId);
      return session === null
        ? null
        : this.#readView(await this.#recoverIfNeeded(session));
    });
  }

  async overview(packageId: string): Promise<V1SettingImprovementOverview> {
    return this.#authoring.mutate(async () => {
      let summaries = await this.#store.listSummariesByPackage(packageId);
      const latestSummary = summaries.find(
        (summary) => !summary.damagedContinuation,
      );
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
        latest: latest === null ? null : await this.#readView(latest),
        history: summaries.map(settingImprovementHistoryItem),
      };
    });
  }

  observeProgress(
    status: V1SettingImprovementStatus,
  ): V1SettingImprovementStatus {
    return this.#authoring.observeProgress(status);
  }

  async status(
    packageId: string,
    sessionId?: string,
  ): Promise<V1SettingImprovementStatus> {
    return this.#authoring.mutate(async () => {
      let status = await this.#store.summaryStatusByPackage(
        packageId,
        sessionId,
      );
      let selected = status.selected;
      if (
        selected?.needsRecovery === true &&
        !this.#authoring.conversation.isRunning(selected.sessionId)
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
    return this.#authoring.mutate(async () => {
      const stored = await this.#store.read(sessionId);
      assertPackage(stored, packageId);
      return this.#readView(await this.#recoverIfNeeded(stored));
    });
  }

  async deleteSession(
    packageId: string,
    sessionId: string,
  ): Promise<V1SettingImprovementOverview> {
    await this.#authoring.mutate(async () => {
      if (this.#authoring.conversation.isRunning(sessionId))
        throw new Error(
          "A running setting-improvement conversation cannot be deleted",
        );
      const stored = await this.#store.read(sessionId);
      assertPackage(stored, packageId);
      await this.#recoverIfNeeded(stored);
      const lease =
        await this.#content.beginCurrentTreeContentPackageOperation(packageId);
      try {
        await this.#store.deleteSession(packageId, sessionId);
      } finally {
        lease.release();
      }
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
    return this.#authoring.mutate(async () => {
      if (this.#authoring.conversation.isRunning(input.sessionId))
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
        const rollback = planAuthoringRollback(lease.package.files, change);
        if (rollback === null)
          return {
            status: "already_rolled_back",
            changeSetId: input.changeSetId,
            path: input.path,
            changes: [],
          };
        try {
          this.#content.validateCurrentTreeContentPackage(rollback.files);
          await lease.replace(rollback.files);
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
          changes: [rollback.diff],
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
    const message = this.#authoring.message(input.message);
    const requestId = this.#authoring.requestId(input.requestId);
    const prepared = await this.#authoring.mutate(async () => {
      let session: StoredSettingImprovementSession;
      let selectedHost: ModelHost | undefined;
      if (input.continuation.kind === "fresh_context") {
        const existing = await this.#store.findByCreationRequest(
          input.packageId,
          requestId,
        );
        if (existing !== null) session = existing;
        else {
          selectedHost = await this.#bindModelHost();
          session = await this.#create(
            input.packageId,
            requestId,
            selectedHost,
          );
        }
      } else {
        session = await this.#store.read(input.continuation.sessionId);
        assertPackage(session, input.packageId);
      }
      return this.#startRequest(
        session,
        requestId,
        async (next, lease, host) => {
          assertCanSendAuthoringMessage(next);
          const { playPreset, bootstrap, preload, modelPrompt } =
            await this.#compilePackage(lease.package, host);
          next.schemaVersion = 6;
          next.authorization = authoringPreloadAuthorization(
            next.authorization,
            preload.record,
          );
          beginAuthoringRequest(next, host, requestId, message, {
            bootstrap,
            playPreset,
            modelPrompt,
            preload: preload.record,
          });
        },
        selectedHost,
      );
    });
    return prepared.run ?? this.#readView(prepared.session);
  }

  async editMessage(input: {
    packageId: string;
    sessionId: string;
    requestId: string;
    messageId: string;
    message: string;
    filePolicy: "keep" | "revert";
  }): Promise<SettingImprovementView> {
    const message = this.#authoring.message(input.message);
    const requestId = this.#authoring.requestId(input.requestId);
    assertAuthoringFilePolicy(input.filePolicy);
    const prepared = await this.#authoring.mutate(async () => {
      let session = await this.#store.read(input.sessionId);
      assertPackage(session, input.packageId);
      session = await this.#recoverIfNeeded(session);
      const edit = {
        requestId,
        messageId: input.messageId,
        message,
        filePolicy: input.filePolicy,
      };
      const existing = this.#authoring.existingEdit(session, edit);
      if (existing !== null) return existing;
      assertKnownAuthoringOutcome(session);
      const host = await this.#bindModelHost();
      const { itemIndex, tail, next } = planAuthoringEdit(session, edit);
      assertCompatibleAuthoring(session.modelBinding, next.modelItems, host);
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        input.packageId,
      );
      try {
        if (
          !isDeepStrictEqual(await this.#store.read(session.sessionId), session)
        )
          throw new Error(
            "The authoring conversation changed; reload it before editing",
          );
        if (
          input.filePolicy === "revert" &&
          session.legacyDraft !== null &&
          (session.legacyDraft.outcome === "applied" ||
            session.legacyDraft.outcome === "apply_outcome_unknown") &&
          session.legacyDraft.changes.length > 0 &&
          !afterLegacyBoundary(session, itemIndex)
        )
          throw new SettingMessageEditError(
            "unattributed",
            [
              ...new Set(session.legacyDraft.changes.map(({ path }) => path)),
            ].sort(),
          );
        const beforeFiles = lease.package.files;
        const reverted =
          input.filePolicy === "revert"
            ? revertAuthoringChanges(beforeFiles, tail)
            : { files: beforeFiles, conflicts: [] };
        if (reverted.conflicts.length > 0)
          throw new SettingMessageEditError("conflict", reverted.conflicts);
        const afterFiles = reverted.files;
        this.#content.validateCurrentTreeContentPackage(afterFiles);
        if (input.filePolicy === "revert") {
          const existingIssues = new Set(
            this.#content
              .inspectCurrentTreeContentPackage(beforeFiles)
              .issues.map((issue) => JSON.stringify(issue)),
          );
          const newIssues = this.#content
            .inspectCurrentTreeContentPackage(afterFiles)
            .issues.filter(
              (issue) => !existingIssues.has(JSON.stringify(issue)),
            );
          if (newIssues.length > 0)
            throw new SettingMessageEditError(
              "invalid_tree",
              [...new Set(newIssues.map(({ path }) => path))].sort(),
            );
        }
        const { playPreset, bootstrap, preload, modelPrompt } =
          await this.#compilePackage(
            {
              ...lease.package,
              files: afterFiles,
              gameplay: readGameplay(afterFiles),
            },
            host,
          );
        next.schemaVersion = 6;
        delete next.pendingEdit;
        next.authorization = authoringPreloadAuthorization(
          null,
          preload.record,
        );
        beginAuthoringRequest(next, host, requestId, message, {
          bootstrap,
          playPreset,
          modelPrompt,
          preload: preload.record,
        });
        captureAuthoringRequestPreview(next, host, requestId);
        session.schemaVersion = 6;
        session.requests ??= [];
        session.pendingEdit = {
          beforeFingerprint: contentTreeFingerprint(beforeFiles),
          afterFingerprint: contentTreeFingerprint(afterFiles),
          afterFiles: structuredClone(afterFiles),
          next,
        };
        await this.#store.preparePendingEdit(session);
        this.#changed(input.packageId, true);
        const committed = await this.#store.finishPendingEdit(session, lease);
        this.#changed(input.packageId, true);
        return {
          session: committed,
          run: this.#startRun(committed, host, requestId),
        };
      } finally {
        lease.release();
      }
    });
    return prepared.run ?? this.#readView(prepared.session);
  }

  /** Continues a paused conversation with the frozen request it paused in. */
  async resume(input: {
    packageId: string;
    sessionId: string;
    requestId: string;
    recovery?: "continue_partial";
  }): Promise<SettingImprovementView> {
    const requestId = this.#authoring.requestId(input.requestId);
    const prepared = await this.#authoring.mutate(async () => {
      const session = await this.#store.read(input.sessionId);
      assertPackage(session, input.packageId);
      return this.#startRequest(session, requestId, (next, lease, host) => {
        const recovery = authoringRecovery(
          next,
          false,
          contentTreeFingerprint(lease.package.files),
        );
        if (recovery.freshContextReason)
          throw new Error(
            `The saved authoring request cannot be recovered (${recovery.freshContextReason}); use a new context.`,
          );
        resumeAuthoringRequest(next, host, input.recovery);
      });
    });
    return prepared.run ?? this.#readView(prepared.session);
  }

  async #startRequest(
    stored: StoredSettingImprovementSession,
    requestId: string,
    prepare: (
      session: StoredSettingImprovementSession,
      lease: CurrentTreeContentPackageOperationLease,
      host: ModelHost,
    ) => Promise<void> | void,
    selectedHost?: ModelHost,
  ): Promise<{
    session: StoredSettingImprovementSession;
    run: Promise<SettingImprovementView> | null;
  }> {
    const session = await this.#recoverIfNeeded(stored);
    const existing = this.#authoring.existingRequest(session, requestId, true);
    if (existing !== null) return existing;
    assertKnownAuthoringOutcome(session);
    const host = selectedHost ?? (await this.#bindModelHost());
    assertCompatibleAuthoring(session.modelBinding, session.modelItems, host);
    const lease = await this.#content.beginCurrentTreeContentPackageOperation(
      session.packageId,
    );
    try {
      if (
        !isDeepStrictEqual(await this.#store.read(session.sessionId), session)
      )
        throw new Error(
          "The authoring conversation changed; reload it before continuing",
        );
      if (session.schemaVersion !== 2) session.schemaVersion = 6;
      await prepare(session, lease, host);
      if (session.activeRequestId !== requestId)
        recordAuthoringRetryPreview(session, host, requestId);
      captureAuthoringRequestPreview(session, host, requestId);
      await this.#store.save(session);
      return { session, run: this.#startRun(session, host, requestId) };
    } finally {
      lease.release();
    }
  }

  async readCallContext(packageId: string, sessionId: string, callId: string) {
    return this.#authoring.readCallContext(packageId, sessionId, callId);
  }

  async readRequestPreviews(packageId: string, sessionId: string) {
    return this.#authoring.readRequestPreviews(packageId, sessionId);
  }

  async preview(packageId: string, sessionId?: string) {
    return this.#authoring.preview(packageId, sessionId);
  }

  async #compilePackage(
    package_: Awaited<
      ReturnType<ContentWorkspace["readCurrentTreeContentPackage"]>
    >,
    host: ModelHost,
  ) {
    const modelBinding = host.binding();
    const modelPrompt = host.modelPrompt?.();
    const playPreset = await this.#bindPlayPreset();
    const locale = this.#locale();
    const preload = this.#preload(
      package_.files,
      modelBinding,
      playPreset,
      locale,
      modelPrompt,
    );
    const bootstrap = this.#compiler.compileSettingImprovement({
      contentPackageTitle: package_.title,
      gameplay: package_.gameplay,
      playPreset,
      modelBinding,
      modelPrompt,
      tools: settingImprovementToolDefinitions(locale, package_.gameplay),
      preload: preload.blocks,
    });

    return { bootstrap, playPreset, preload, modelPrompt };
  }

  /**
   * Preloads the control documents and the documents the package frame injects.
   * A preview that cannot be built degrades to the directory and control files.
   */
  #preload(
    files: readonly ContentTreeFile[],
    modelBinding: ModelHostBinding,
    playPreset: PlayPresetBinding,
    locale: AppLocale,
    modelPrompt: ModelConnectionPrompt | undefined,
  ): AuthoringPreload {
    const revision = contentTreeFingerprint(files);
    const snapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: [...files],
    });
    let injected: { shortRef: string; slot: string }[] = [];
    let injectedUnavailable: string | undefined;
    try {
      const preview = this.#preview(
        snapshot,
        modelBinding,
        playPreset,
        modelPrompt,
      );
      injected = preview.compilation.coverage.flatMap(
        ({ slot, status, readAuthorization }) =>
          status === "resolved" && readAuthorization !== undefined
            ? [{ shortRef: readAuthorization.shortRef, slot }]
            : [],
      );
    } catch (error: unknown) {
      injectedUnavailable =
        error instanceof Error ? error.message : "unknown preview failure";
    }
    return buildAuthoringPreload({
      snapshot,
      surface: contentPackageAuthoringSurface,
      locale,
      revision,
      sourcePrefix: "content-package:preload",
      injected,
      ...(injectedUnavailable === undefined ? {} : { injectedUnavailable }),
    });
  }

  async cancel(sessionId: string): Promise<SettingImprovementView> {
    return this.#authoring.cancel(sessionId, async () =>
      this.#readView(
        await this.#recoverIfNeeded(await this.#store.read(sessionId)),
      ),
    );
  }

  async #create(
    packageId: string,
    creationRequestId: string,
    host: ModelHost,
  ): Promise<StoredSettingImprovementSession> {
    const [package_, playPreset] = await Promise.all([
      this.#content.readCurrentTreeContentPackage(packageId),
      this.#bindPlayPreset(),
    ]);
    const locale = this.#locale();
    const modelBinding = host.binding();
    const tools = settingImprovementToolDefinitions(locale, package_.gameplay);
    const bootstrap = this.#compiler.compileSettingImprovement({
      contentPackageTitle: package_.title,
      gameplay: package_.gameplay,
      playPreset,
      modelBinding,
      tools,
    });
    const now = Date.now();
    const sessionId = this.#store.createId();
    const session: StoredSettingImprovementSession = {
      schemaVersion: 6,
      requests: [],
      sessionId,
      packageId,
      contentPackageTitle: package_.title,
      locale,
      runStatus: "ready",
      createdAt: now,
      updatedAt: now,
      creationRequestId,
      ...(modelBinding.provider === "google_interactions"
        ? { googleIdentity: { sessionId, packageId, creationRequestId } }
        : {}),
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
    return this.#authoring.conversation.run({
      ...(this.#generationActivity === undefined
        ? {}
        : { generationActivity: this.#generationActivity }),
      changed: (durable) => this.#changed(session.packageId, durable),
      session,
      host,
      requestId,
      exchangeRequestId: session.activeRequestId ?? requestId,
      save: (next) => this.#store.save(next),
      recordGoogleHop: (id, hop) =>
        this.#store.recordGoogleHop(session.sessionId, id, hop),
      settleToolResponse: async (next, assistantItemIndex, toolCalls) => {
        activeTransaction = await this.#settleToolResponse(
          next,
          assistantItemIndex,
          toolCalls,
          activeTransaction,
          host.binding(),
        );
      },
      view: (next) => this.#view(next),
      failure: {
        emptyResponse:
          "The model returned an empty tool-free authoring response",
        cancelled:
          "The setting-improvement response was cancelled. Complete tool responses already published to the current tree were retained.",
        interrupted: "The setting-improvement response was interrupted",
      },
      retrySupported:
        session.schemaVersion === 4 ||
        session.schemaVersion === 5 ||
        session.schemaVersion === 6,
    });
  }

  async #settleToolResponse(
    session: StoredSettingImprovementSession,
    assistantItemIndex: number,
    calls: readonly ModelHostToolCall[],
    active: ActiveTransaction | null,
    modelBinding: ModelHostBinding,
  ): Promise<ActiveTransaction> {
    const lease = await this.#content.beginCurrentTreeContentPackageOperation(
      session.packageId,
      { wait: true },
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
              modelBinding,
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
      if (
        session.schemaVersion === 4 ||
        session.schemaVersion === 5 ||
        session.schemaVersion === 6
      )
        checkpointNextAuthoringDispatch(session, "dispatching");
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
    modelBinding: ModelHostBinding = authoringActiveBinding(session),
  ): SettingAuthoringTransaction {
    const request = session.requests?.at(-1);
    return new SettingAuthoringTransaction({
      baseFiles: files,
      locale: session.locale,
      revision,
      authorization: session.authorization,
      validateFiles: (files) =>
        this.#content.validateCurrentTreeContentPackage(files),
      preview: (snapshot) =>
        this.#preview(
          snapshot,
          modelBinding,
          request?.playPreset ?? session.playPreset,
          request?.modelPrompt,
        ),
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
    if (this.#authoring.conversation.isRunning(original.sessionId))
      return original;
    if (original.pendingEdit !== undefined) {
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        original.packageId,
      );
      lease.release();
      const recovered = await this.#store.read(original.sessionId);
      if (recovered.pendingEdit !== undefined)
        throw new Error(
          "The pending authoring edit has no valid package recovery marker",
        );
      return this.#recoverIfNeeded(recovered);
    }
    let expected = original;
    const session = structuredClone(original);
    if (
      recoverLegacyLengthLimit(session) ||
      recoverPausedAuthoringCorrection(session)
    ) {
      if (await this.#store.saveIfUnchanged(expected, session)) return session;
      return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
    }
    const pendingAssistant = lastPendingAssistant(session);
    if (
      session.runStatus === "running" &&
      session.pendingSettlement === null &&
      pendingAssistant === null
    ) {
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        session.packageId,
      );
      let latest: StoredSettingImprovementSession;
      try {
        latest = await this.#store.read(session.sessionId);
        if (this.#authoring.conversation.isRunning(session.sessionId))
          return latest;
        if (isDeepStrictEqual(latest, original)) {
          if (
            session.modelBinding.provider === "google_interactions" &&
            session.googleOutcomeUnknown !== false
          )
            session.googleOutcomeUnknown = true;
          const lastItem = session.modelItems.at(-1);
          if (
            session.retryDispatch === undefined &&
            session.requests?.at(-1) !== undefined &&
            (lastItem?.kind === "user" ||
              lastItem?.kind === "tool" ||
              isResponseCorrection(lastItem))
          ) {
            session.schemaVersion = 6;
            checkpointNextAuthoringDispatch(session, "retryable");
          }
          recoverAuthoringDispatch(session);
          markInterruptedAfterRestart(session);
          if (await this.#store.saveIfUnchanged(original, session))
            return session;
          latest = await this.#store.read(session.sessionId);
        }
      } finally {
        lease.release();
      }
      return this.#recoverIfNeeded(latest);
    }
    if (session.pendingSettlement === null && pendingAssistant !== null) {
      this.#finalizeUnconfirmedToolResponse(
        session,
        pendingAssistant.itemIndex,
        "Runtime found a complete tool response without the persisted current-tree revision that authorized it. The calls were not replayed against a newer tree; read the current tree again before editing.",
      );
      markInterruptedAfterRestart(session);
      if (await this.#store.saveIfUnchanged(expected, session)) return session;
      return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
    }

    if (session.pendingSettlement !== null) {
      if (session.modelBinding.provider === "google_interactions")
        session.googleOutcomeUnknown = false;
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
          let settled = false;
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
            settled = true;
          } else {
            this.#finalizeUnconfirmedToolResponse(
              session,
              prepared.assistantItemIndex,
              "The content package no longer matches either the original or prepared revision for this tool response. No claimed change is being treated as authoritative; read the current tree again before editing.",
            );
          }
          markInterruptedAfterRestart(session);
          const request = session.requests?.at(-1);
          if (settled && request !== undefined) {
            session.schemaVersion = 6;
            checkpointNextAuthoringDispatch(session, "retryable");
            session.runStatus = "interrupted";
          }
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

    if (
      !recoverLegacyGoogleDispatch(session, () => {
        session.schemaVersion = 6;
      })
    )
      return session;
    if (await this.#store.saveIfUnchanged(expected, session)) return session;
    return this.#recoverIfNeeded(await this.#store.read(session.sessionId));
  }

  #finalizeUnconfirmedToolResponse(
    session: StoredSettingImprovementSession,
    assistantItemIndex: number,
    message: string,
  ): void {
    session.settlementConflict = true;
    delete session.retryDispatch;
    delete session.partialResponse;
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
    return this.#authoring.progress(summary, true);
  }

  async #readView(
    session: StoredSettingImprovementSession,
  ): Promise<SettingImprovementView> {
    if (session.runStatus !== "interrupted") return this.#view(session);
    const current = await this.#content.readCurrentTreeContentPackage(
      session.packageId,
    );
    return this.#view(session, contentTreeFingerprint(current.files));
  }

  #view(
    session: StoredSettingImprovementSession,
    currentRevision?: string,
  ): SettingImprovementView {
    const view = this.#authoring.view(session);
    return {
      ...view,
      packageId: session.packageId,
      turns: settingConversationTurns(session, view.progress.streaming),
      legacyDraft:
        session.legacyDraft === null
          ? null
          : structuredClone(session.legacyDraft),
      ...authoringRecovery(session, false, currentRevision),
    };
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
  delete session.partialResponse;
  const paused =
    !session.settlementConflict &&
    session.modelBinding.provider === "google_interactions" &&
    session.googleOutcomeUnknown === false &&
    session.retryDispatch === undefined;
  finishInterruptedAuthoringRun(
    session,
    paused ? "paused" : "interrupted",
    "The previous model request stopped before its next complete response. Every settled current-tree change and complete tool result was retained; continue this conversation when ready.",
  );
}

function settingConversationTurns(
  session: StoredSettingImprovementSession,
  streaming: ModelToolConversationStreaming | null = null,
): V1SettingConversationTurn[] {
  return authoringConversationTurns(session, streaming, (item, index) =>
    item.isError === true || item.changes.length === 0
      ? null
      : changeSetIdForItem(index),
  );
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

function afterLegacyBoundary(
  session: StoredSettingImprovementSession,
  itemIndex: number,
): boolean {
  const first = session.requests?.[0];
  return (
    first !== undefined &&
    itemIndex >= first.modelItemStart &&
    (first.modelItemStart > 0 ||
      session.editReceipts?.some(
        (receipt) => receipt.requestId === first.requestId,
      ) === true)
  );
}

function settingImprovementHistoryItem(
  summary: StoredSettingImprovementSummary,
): V1SettingImprovementHistoryItem {
  return {
    sessionId: summary.sessionId,
    ...(summary.damagedContinuation
      ? {
          unavailableReason:
            "Google continuation is damaged; start a fresh model context.",
        }
      : {}),
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
