import { authoringRequestPreviews } from "../authoring/AuthoringRequestSnapshot.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
  authoringExchange,
  ModelToolConversation,
  rememberAuthoringRequest,
  resumePausedAuthoringConversation,
} from "../authoring/ModelToolConversation.ts";
import { contentTreeFingerprint } from "../content/ContentTreeFingerprint.ts";
import type {
  ModelHost,
  ModelHostBinding,
  ModelHostExchange,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import {
  equalModelHostBinding,
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  modelHostFailureRequiresFreshContext,
} from "../model/ModelHost.ts";
import { validAuthoringNativeContinuation } from "../model/FileNativeModelAdapters.ts";
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
import {
  authoringPreloadAuthorization,
  buildAuthoringPreload,
  worldRevisionAuthoringSurface,
  type AuthoringPreload,
} from "../setting/SettingAuthoringTransaction.ts";
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
  inspectWorldRevisionFiles,
  worldRevisionRuntimeContract,
  worldRevisionToolDefinitions,
} from "./WorldRevisionAuthoringTransaction.ts";
import type { WorldRevisionWorkspace } from "./WorldRevisionWorkspace.ts";
import { WorldRevisionWorkspaceError } from "./WorldRevisionWorkspace.ts";
import { historyEntries } from "../history/HistoryTools.ts";

export type WorldRevisionContinuation =
  { kind: "fresh_context" } | { kind: "continue_context"; sessionId: string };

export class WorldRevisionMessageEditError extends Error {
  readonly reason: "conflict" | "sealed" | "invalid_tree";
  readonly paths: string[];
  constructor(
    reason: "conflict" | "sealed" | "invalid_tree",
    paths: string[] = [],
  ) {
    super(
      reason === "sealed"
        ? "Changes in a sealed revision cannot be reverted; keep current files to continue"
        : reason === "conflict"
          ? `Cannot revert changed files: ${paths.join(", ")}`
          : `Reverting would make the revision invalid: ${paths.join(", ")}`,
    );
    this.name = "WorldRevisionMessageEditError";
    this.reason = reason;
    this.paths = paths;
  }
}

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

interface WorldRevisionLiveScope {
  conversation: ModelToolConversation<
    StoredWorldRevisionSession,
    V1WorldRevisionView
  >;
  mutationTail: Promise<void>;
}
const liveScopes = new Map<string, WeakRef<WorldRevisionLiveScope>>();
const releaseScope = new FinalizationRegistry<{
  scope: string;
  reference: WeakRef<WorldRevisionLiveScope>;
}>(({ scope, reference }) => {
  if (liveScopes.get(scope) === reference) liveScopes.delete(scope);
});

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
  readonly #live: WorldRevisionLiveScope;
  readonly #conversation: WorldRevisionLiveScope["conversation"];
  readonly #changed: (id: string, durable: boolean) => void;

  constructor(input: {
    changed?: (id: string, durable: boolean) => void;
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
    this.#changed =
      input.changed ??
      (() => {
        /* No observers attached. */
      });
    this.#store = input.store;
    let live = liveScopes.get(input.store.sessionScope)?.deref();
    if (live === undefined) {
      live = {
        conversation: new ModelToolConversation(),
        mutationTail: Promise.resolve(),
      };
      const reference = new WeakRef(live);
      liveScopes.set(input.store.sessionScope, reference);
      releaseScope.register(live, {
        scope: input.store.sessionScope,
        reference,
      });
    }
    this.#live = live;
    this.#conversation = live.conversation;
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
      const sessions = await this.#recoverWorldSessions(worldId);
      const [activeEpoch, sealedEpochs] = await Promise.all([
        this.#workspace.active(worldId),
        this.#workspace.sealed(worldId),
      ]);
      const latest =
        sessions.find((session) => !session.damagedContinuation) ?? null;
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
        latest:
          latest === null
            ? null
            : this.#view(latest, activeEpoch?.epochId ?? null),
        history: sessions.map(historyItem),
      };
    });
  }

  observeProgress(status: V1WorldRevisionStatus): V1WorldRevisionStatus {
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
    worldId: string,
    sessionId?: string,
  ): Promise<V1WorldRevisionStatus> {
    return this.#mutate(async () => {
      await this.#workspace.active(worldId);
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
      const recovered = await this.#recoverIfNeeded(session);
      return this.#view(
        recovered,
        (await this.#workspace.active(worldId))?.epochId ?? null,
      );
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
        if (session.googleOutcomeUnknown)
          throw new Error(
            "The Google request outcome is unknown; start a fresh model context.",
          );
        if (session.runStatus === "paused")
          throw new Error(
            "Resume the paused authoring request before sending another message",
          );
      }
      await this.#assertNoRunningConversation(
        input.worldId,
        session?.sessionId,
      );
      let host: ModelHost | undefined;
      if (session !== null) {
        host = await this.#bindExistingModelHost(session.modelBinding);
        if (!equalModelHostBinding(session.modelBinding, host.binding()))
          throw new Error(
            "No saved model connection matches this world-revision conversation",
          );
      }
      const epoch = await this.#workspace.open(input.worldId);
      session ??= await this.#create(input.worldId, epoch, requestId);
      if (session.epochId !== epoch.epochId) {
        retargetSession(session, epoch, this.#locale());
        await this.#store.saveSession(session);
      }
      host ??= await this.#bindExistingModelHost(session.modelBinding);
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "No saved model connection matches this world-revision conversation",
        );
      const { playPreset, bootstrap, preload } = await this.#compileCurrent(
        input.worldId,
        session.modelBinding,
      );
      session.schemaVersion = 3;
      delete session.retryDispatch;
      session.requests ??= [];
      session.requests.push({
        requestId,
        modelItemStart: session.modelItems.length,
        bootstrap,
        playPreset: structuredClone(playPreset),
        ...(preload === null
          ? {}
          : { preload: structuredClone(preload.record) }),
      });
      if (preload !== null)
        session.authorization = authoringPreloadAuthorization(
          session.authorization,
          preload.record,
        );
      appendAuthoringUserMessage(session, message, requestId);
      if (session.modelBinding.provider !== "google_interactions")
        session.retryDispatch = {
          requestId,
          exchange: session.exchange + 1,
          modelItemCount: session.modelItems.length,
          state: "dispatching",
        };
      if (session.modelBinding.provider === "google_interactions")
        session.googleOutcomeUnknown = false;
      const boundaries =
        host.binding().provider === "google_interactions"
          ? await this.#validatedEpochBoundaries(session)
          : undefined;
      if (
        boundaries !== undefined &&
        host.previewAuthoringRequest !== undefined
      )
        session.requests.at(-1)!.wireRequest = host.previewAuthoringRequest(
          authoringExchange(session, requestId, boundaries),
        );
      await this.#store.saveSession(session);
      return {
        session,
        run: this.#startRun(session, host, requestId, boundaries),
      };
    });
    return (
      prepared.run ??
      this.#view(
        prepared.session,
        (await this.#workspace.active(input.worldId))?.epochId ?? null,
      )
    );
  }

  async editMessage(input: {
    worldId: string;
    sessionId: string;
    requestId: string;
    messageId: string;
    message: string;
    filePolicy: "keep" | "revert";
  }): Promise<V1WorldRevisionView> {
    const message = requiredMessage(input.message);
    const requestId = requiredRequestId(input.requestId);
    if (input.filePolicy !== "keep" && input.filePolicy !== "revert")
      throw new Error("Invalid file policy");
    const prepared = await this.#mutate(async () => {
      // Recover the epoch intent before reading the conversation it may replace.
      let epoch = await this.#workspace.active(input.worldId);
      let session = await this.#store.readSession(input.sessionId);
      assertWorld(session, input.worldId);
      session = await this.#recoverIfNeeded(session);
      const prior = session.editReceipts?.find(
        (receipt) => receipt.requestId === requestId,
      );
      if (
        prior !== undefined &&
        (prior.messageId !== input.messageId ||
          prior.message !== message ||
          prior.filePolicy !== input.filePolicy)
      )
        throw new Error(
          "This edit request ID was already used for different content",
        );
      if (session.completedRequestIds.includes(requestId)) {
        if (prior === undefined)
          throw new Error(
            "This request ID was already used for another authoring operation",
          );
        return { session, run: null };
      }
      const running = this.#conversation.running(session.sessionId);
      if (running !== null) {
        if (running.requestId !== requestId)
          throw new Error(
            "Another message in this world-revision conversation is still running",
          );
        return { session, run: running.promise };
      }
      if (session.googleOutcomeUnknown)
        throw new Error(
          "The Google request outcome is unknown; start a fresh model context.",
        );
      await this.#assertNoRunningConversation(input.worldId, session.sessionId);
      const host = await this.#bindExistingModelHost(session.modelBinding);
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "No saved model connection matches this world-revision conversation",
        );
      const messageIndex = session.messages.findIndex(
        (entry) => entry.role === "user" && entry.id === input.messageId,
      );
      if (messageIndex < 0)
        throw new Error("The selected authoring message no longer exists");
      const userIndex = session.messages
        .slice(0, messageIndex)
        .filter((entry) => entry.role === "user").length;
      const itemIndex = session.modelItems
        .map((item, index) => (item.kind === "user" ? index : -1))
        .filter((index) => index >= 0)[userIndex];
      if (
        itemIndex === undefined ||
        session.modelItems[itemIndex]?.kind !== "user" ||
        session.modelItems[itemIndex].text !==
          session.messages[messageIndex]!.text
      )
        throw new Error(
          "The selected authoring message cannot be matched to the native transcript",
        );
      const prefix = session.modelItems.slice(0, itemIndex);
      if (
        !validAuthoringNativeContinuation(prefix, session.modelBinding.provider)
      )
        throw new Error(
          "The native continuation before this message is damaged; start a fresh context",
        );
      const tail = session.modelItems.slice(itemIndex);
      if (input.filePolicy === "revert") {
        const activeChangeIds = new Set(
          epoch?.changes.map(({ changeSetId }) => changeSetId) ?? [],
        );
        if (
          tail.some(
            (item) =>
              item.kind === "tool" &&
              !item.isError &&
              item.changes.length > 0 &&
              (item.changeSetId === null ||
                !activeChangeIds.has(item.changeSetId)),
          )
        )
          throw new WorldRevisionMessageEditError("sealed");
      }
      epoch ??= await this.#workspace.open(input.worldId);
      const afterFiles =
        input.filePolicy === "revert"
          ? revertWorldRevisionChanges(epoch.files, tail)
          : epoch.files;
      if (input.filePolicy === "revert") {
        const inspection = inspectWorldRevisionFiles(
          afterFiles,
          epoch.baseFiles,
        );
        if (inspection.status !== "usable")
          throw new WorldRevisionMessageEditError(
            "invalid_tree",
            [...new Set(inspection.diagnostics.map(({ path }) => path))].sort(),
          );
      }
      const candidate = {
        ...epoch,
        files: afterFiles,
        revision: contentTreeFingerprint(afterFiles),
      };
      const { playPreset, bootstrap, preload } = await this.#compileCurrent(
        input.worldId,
        session.modelBinding,
        candidate,
      );
      const next = structuredClone(session);
      next.schemaVersion = 3;
      next.editReceipts = [
        ...(next.editReceipts ?? []),
        {
          requestId,
          messageId: input.messageId,
          message,
          filePolicy: input.filePolicy,
        },
      ];
      delete next.retryDispatch;
      next.modelItems = prefix;
      next.messages = next.messages.slice(0, messageIndex);
      next.requests = (next.requests ?? []).filter(
        (entry) => entry.modelItemStart < itemIndex,
      );
      if (
        session.epochId !== epoch.epochId ||
        tail.some(
          (item) =>
            item.kind === "prompt_delta" &&
            item.logicalMessages.some((entry) =>
              entry.blocks.some((block) =>
                block.source.startsWith("runtime:world-revision-epoch:"),
              ),
            ),
        )
      )
        retargetSession(next, epoch, this.#locale());
      next.epochId = epoch.epochId;
      next.requests.push({
        requestId,
        modelItemStart: next.modelItems.length,
        bootstrap,
        playPreset: structuredClone(playPreset),
        ...(preload === null
          ? {}
          : { preload: structuredClone(preload.record) }),
      });
      next.authorization =
        preload === null
          ? null
          : authoringPreloadAuthorization(null, preload.record);
      appendAuthoringUserMessage(next, message, requestId);
      if (next.modelBinding.provider === "google_interactions")
        next.googleOutcomeUnknown = false;
      else
        next.retryDispatch = {
          requestId,
          exchange: next.exchange + 1,
          modelItemCount: next.modelItems.length,
          state: "dispatching",
        };
      const boundaries =
        host.binding().provider === "google_interactions"
          ? await this.#validatedEpochBoundaries(next)
          : undefined;
      if (
        boundaries !== undefined &&
        host.previewAuthoringRequest !== undefined
      )
        next.requests.at(-1)!.wireRequest = host.previewAuthoringRequest(
          authoringExchange(next, requestId, boundaries),
        );
      await this.#workspace.publishEdit({
        worldId: input.worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
        files: afterFiles,
        session: next,
      });
      this.#changed(input.worldId, true);
      return {
        session: next,
        run: this.#startRun(next, host, requestId, boundaries),
      };
    });
    return (
      prepared.run ??
      this.#view(
        prepared.session,
        (await this.#workspace.active(input.worldId))?.epochId ?? null,
      )
    );
  }

  /** Continues a paused conversation within the revision it paused in. */
  async resume(input: {
    worldId: string;
    sessionId: string;
    requestId: string;
  }): Promise<V1WorldRevisionView> {
    const requestId = requiredRequestId(input.requestId);
    const prepared = await this.#mutate(async () => {
      let session = await this.#store.readSession(input.sessionId);
      assertWorld(session, input.worldId);
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
      await this.#assertNoRunningConversation(input.worldId, session.sessionId);
      const epoch = await this.#workspace.active(input.worldId);
      if (epoch?.epochId !== session.epochId)
        throw new WorldRevisionWorkspaceError(
          "The paused conversation belongs to a revision that is no longer active; send a new message instead",
        );
      const host = await this.#bindExistingModelHost(session.modelBinding);
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "No saved model connection matches this world-revision conversation",
        );
      if (canRetryWorldRevisionRequest(session)) {
        session.runStatus = "running";
        session.activeRequestId = session.requests?.at(-1)?.requestId ?? null;
        session.lastFailure = null;
        session.updatedAt = Date.now();
      } else resumePausedAuthoringConversation(session);
      const boundaries =
        host.binding().provider === "google_interactions"
          ? await this.#validatedEpochBoundaries(session)
          : undefined;
      await this.#store.saveSession(session);
      return {
        session,
        run: this.#startRun(session, host, requestId, boundaries),
      };
    });
    return (
      prepared.run ??
      this.#view(
        prepared.session,
        (await this.#workspace.active(input.worldId))?.epochId ?? null,
      )
    );
  }

  async preview(worldId: string, sessionId?: string) {
    const session =
      sessionId === undefined ? null : await this.#store.readSession(sessionId);
    if (session !== null) assertWorld(session, worldId);
    const host =
      session === null
        ? await this.#bindModelHost()
        : await this.#bindExistingModelHost(session.modelBinding);
    if (
      session !== null &&
      !equalModelHostBinding(session.modelBinding, host.binding())
    )
      throw new Error(
        "No compatible saved model connection matches this authoring conversation",
      );
    const { bootstrap } = await this.#compileCurrent(worldId, host.binding());
    return bootstrap;
  }

  async #compileCurrent(
    worldId: string,
    modelBinding: ModelHostBinding,
    overrideEpoch?: StoredWorldRevisionEpoch,
  ) {
    const epoch = overrideEpoch ?? (await this.#workspace.active(worldId));
    const worlds = await this.#worlds.listWorlds();
    const playPreset = await this.#bindPlayPreset();
    const locale = this.#locale();
    const gameplay = await this.#worlds.gameplay(worldId);
    const preload =
      epoch === null
        ? null
        : await this.#preload(epoch, modelBinding, playPreset, locale);
    const bootstrap = this.#compiler.compileWorldRevision({
      ...(epoch === null
        ? {}
        : { epoch: { id: epoch.epochId, baseHead: epoch.baseHead } }),
      worldTitle:
        worlds.find((world) => world.worldId === worldId)?.title ?? worldId,
      gameplay,
      runtimeContract: worldRevisionRuntimeContract(locale, gameplay),
      authorPrompt: settingImprovementPromptForBinding(playPreset, locale),
      playPreset,
      modelBinding: modelBinding,
      tools: worldRevisionToolDefinitions(locale, gameplay),
      ...(preload === null ? {} : { preload: preload.blocks }),
    });

    return { bootstrap, playPreset, preload };
  }

  /**
   * Preloads the control documents and the documents the world frame injects.
   * A preview that cannot be built degrades to the directory and control files.
   */
  async #preload(
    epoch: StoredWorldRevisionEpoch,
    modelBinding: ModelHostBinding,
    playPreset: PlayPresetBinding,
    locale: AppLocale,
  ): Promise<AuthoringPreload> {
    const [binding, maintenance] = await Promise.all([
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
    let injected: { shortRef: string; slot: string }[] = [];
    let injectedUnavailable: string | undefined;
    try {
      const preview = this.#preview({
        snapshot,
        modelBinding,
        playPreset,
        binding,
        epoch,
        maintenance,
      });
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
      surface: worldRevisionAuthoringSurface,
      locale,
      revision: epoch.revision,
      sourcePrefix: "world-revision:preload",
      injected,
      ...(injectedUnavailable === undefined ? {} : { injectedUnavailable }),
    });
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
    const [host, playPreset, worlds, gameplay] = await Promise.all([
      this.#bindModelHost(),
      this.#bindPlayPreset(),
      this.#worlds.listWorlds(),
      this.#worlds.gameplay(worldId),
    ]);
    const worldTitle =
      worlds.find((world) => world.worldId === worldId)?.title ?? worldId;
    const locale = this.#locale();
    const modelBinding = host.binding();
    const tools = worldRevisionToolDefinitions(locale, gameplay);
    const bootstrap = this.#compiler.compileWorldRevision({
      epoch: { id: epoch.epochId, baseHead: epoch.baseHead },
      worldTitle,
      gameplay,
      runtimeContract: worldRevisionRuntimeContract(locale, gameplay),
      authorPrompt: settingImprovementPromptForBinding(playPreset, locale),
      playPreset,
      modelBinding,
      tools,
    });
    const now = Date.now();
    const session: StoredWorldRevisionSession = {
      schemaVersion: 3,
      requests: [],
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
    return session;
  }

  #startRun(
    session: StoredWorldRevisionSession,
    host: ModelHost,
    requestId: string,
    worldRevisionBoundaries?: ModelHostExchange["worldRevisionBoundaries"],
  ): Promise<V1WorldRevisionView> {
    let activeTransaction: ActiveTransaction | null = null;
    return this.#conversation.run({
      changed: (durable) => this.#changed(session.worldId, durable),
      session,
      host,
      requestId,
      exchangeRequestId: session.activeRequestId ?? requestId,
      ...(worldRevisionBoundaries === undefined
        ? {}
        : { worldRevisionBoundaries }),
      save: (next) => this.#store.saveSession(next),
      recordGoogleHop: (id, hop) =>
        this.#store.recordGoogleHop(session.sessionId, id, hop),
      settleToolResponse: async (next, assistantItemIndex, calls) => {
        activeTransaction = await this.#settleToolResponse(
          next,
          assistantItemIndex,
          calls,
          activeTransaction,
        );
      },
      view: (next) => this.#view(next),
      dispatch: {
        request: (next, request) => {
          if (next.schemaVersion !== 3) return request;
          const retry = next.retryDispatch;
          if (retry?.state === "retryable") {
            next.retryDispatch = { ...retry, state: "dispatching" };
            return {
              ...request,
              requestId: retry.requestId,
              exchange: retry.exchange,
            };
          }
          next.retryDispatch = {
            requestId: request.requestId!,
            exchange: request.exchange!,
            modelItemCount: next.modelItems.length,
            state: "dispatching",
          };
          return request;
        },
        accepted: (next) => {
          delete next.retryDispatch;
        },
        paused: (next) => {
          delete next.retryDispatch;
        },
        failed: (next, error, duringDispatch) => {
          if (next.retryDispatch === undefined) return;
          next.retryDispatch.state =
            duringDispatch &&
            next.modelBinding.provider !== "google_interactions" &&
            !(error instanceof ModelHostBindingMismatchError) &&
            !(error instanceof ModelHostContinuationError) &&
            !modelHostFailureRequiresFreshContext(error)
              ? "retryable"
              : "blocked";
        },
      },
      failure: {
        cancelled:
          "The world-revision response was cancelled. Settled worktree changes were retained.",
        interrupted: "The world-revision response was interrupted",
      },
    });
  }

  async #validatedEpochBoundaries(session: StoredWorldRevisionSession) {
    const entries: {
      itemIndex: number;
      epochId: string;
      baseHead: string;
      markdown: string;
    }[] = [];
    for (const [itemIndex, item] of session.modelItems.entries()) {
      if (item.kind !== "prompt_delta") continue;
      const source = item.logicalMessages[0]?.blocks[0]?.source;
      if (source?.startsWith("runtime:world-revision-epoch:") !== true)
        continue;
      const epochId = source.slice("runtime:world-revision-epoch:".length);
      const epoch = await this.#store.readEpoch(epochId);
      if (epoch.worldId !== session.worldId)
        throw new Error(
          "World-revision epoch boundary belongs to another world",
        );
      const valid = (["en", "zh-CN"] as const).some((locale) =>
        isDeepStrictEqual(item, epochBoundaryItem(epoch, locale)),
      );
      if (!valid) throw new Error("World-revision epoch boundary is damaged");
      entries.push({
        itemIndex,
        epochId,
        baseHead: epoch.baseHead,
        markdown: item.logicalMessages[0]!.markdown,
      });
    }
    if (entries.length > 0 && entries.at(-1)?.epochId !== session.epochId)
      throw new Error(
        "World-revision epoch boundary does not match the current epoch",
      );
    return { currentEpochId: session.epochId, entries };
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
    const frozenRequest = session.requests?.at(-1);
    if (
      session.schemaVersion === 3 &&
      session.modelBinding.provider !== "google_interactions" &&
      frozenRequest !== undefined
    )
      session.retryDispatch = {
        requestId: frozenRequest.requestId,
        exchange: session.exchange + 1,
        modelItemCount: session.modelItems.length,
        state: "dispatching",
      };
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
      history: {
        scope: epoch.worldId,
        entries: historyEntries(binding.history, binding.historyBackgrounds),
      },
      locale: session.locale,
      revision: epoch.revision,
      authorization: session.authorization,
      preview: (snapshot) =>
        this.#preview({
          snapshot,
          modelBinding: session.modelBinding,
          playPreset:
            session.requests?.at(-1)?.playPreset ?? session.playPreset,
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
    if (session.damagedContinuation) return session;
    if (this.#conversation.isRunning(session.sessionId)) return session;
    await this.#workspace.active(session.worldId);
    session = await this.#store.readSession(session.sessionId);
    const lastItem = session.modelItems.at(-1);
    if (
      session.pendingSettlement === null &&
      session.modelBinding.provider === "google_interactions" &&
      session.runStatus === "interrupted" &&
      session.googleOutcomeUnknown === undefined &&
      (lastItem?.kind === "user" || lastItem?.kind === "tool")
    ) {
      session.googleOutcomeUnknown = true;
      session.lastFailure =
        "The Google request outcome is unknown; start a fresh model context.";
      session.updatedAt = Date.now();
      await this.#store.saveSession(session);
      return session;
    }
    if (
      session.pendingSettlement === null &&
      lastItem?.kind === "assistant" &&
      lastItem.toolCalls.length > 0
    ) {
      finalizeUnconfirmed(
        session,
        session.modelItems.length - 1,
        new Error(
          "Runtime found a complete tool response without a persisted worktree settlement intent",
        ),
      );
      if (session.modelBinding.provider === "google_interactions")
        session.googleOutcomeUnknown = false;
      const requestId = session.activeRequestId;
      session.runStatus = "interrupted";
      session.activeRequestId = null;
      if (requestId !== null)
        session.completedRequestIds = rememberAuthoringRequest(
          session.completedRequestIds,
          requestId,
        );
      session.lastFailure =
        "The complete tool response could not be settled; its calls received failure receipts. Re-read the worktree before editing.";
      session.updatedAt = Date.now();
      await this.#store.saveSession(session);
      return session;
    }
    if (
      session.runStatus === "running" &&
      session.pendingSettlement === null &&
      session.modelBinding.provider === "google_interactions" &&
      session.googleOutcomeUnknown !== false
    )
      session.googleOutcomeUnknown = true;
    const recoveringSettlement = session.pendingSettlement !== null;
    let settlementPublished = false;
    if (session.pendingSettlement !== null) {
      if (session.modelBinding.provider === "google_interactions")
        session.googleOutcomeUnknown = false;
      const pending = session.pendingSettlement;
      if (pending.phase === "publication_prepared") {
        const active = await this.#workspace.active(session.worldId);
        if (active?.epochId === pending.epochId) {
          await this.#workspace.publishAi({
            worldId: session.worldId,
            epochId: pending.epochId,
            expectedRevision: pending.beforeRevision,
            afterRevision: pending.afterRevision,
            files: pending.afterFiles,
            toolResults: pending.toolResults,
          });
          finalizeSettlement(session, pending);
          settlementPublished = true;
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
    if (session.runStatus !== "running" && !recoveringSettlement)
      return session;
    const requestId = session.activeRequestId;
    if (
      settlementPublished &&
      session.modelBinding.provider !== "google_interactions" &&
      session.requests?.at(-1) !== undefined
    ) {
      session.schemaVersion = 3;
      session.retryDispatch = {
        requestId: session.requests.at(-1)!.requestId,
        exchange: session.exchange + 1,
        modelItemCount: session.modelItems.length,
        state: "retryable",
      };
    }
    if (session.retryDispatch?.state === "dispatching")
      session.retryDispatch.state =
        session.modelBinding.provider === "google_interactions"
          ? "blocked"
          : "retryable";
    session.runStatus =
      session.modelBinding.provider === "google_interactions" &&
      session.googleOutcomeUnknown === false
        ? "paused"
        : "interrupted";
    session.activeRequestId = null;
    if (requestId !== null)
      session.completedRequestIds = rememberAuthoringRequest(
        session.completedRequestIds,
        requestId,
      );
    session.lastFailure = session.googleOutcomeUnknown
      ? "The Google request outcome is unknown; start a fresh model context."
      : "The previous model request stopped after its last settled worktree change. Continue this conversation when ready.";
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

  #view(
    session: StoredWorldRevisionSession,
    activeEpochId: string | null = session.epochId,
  ): V1WorldRevisionView {
    const streaming =
      session.runStatus === "running"
        ? this.#conversation.streaming(session.sessionId)
        : null;
    return {
      requestPreviews: authoringRequestPreviews(session),
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
      canRetry:
        activeEpochId === session.epochId &&
        canRetryWorldRevisionRequest(session),
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
    const previous = this.#live.mutationTail;
    let release: () => void = () => undefined;
    this.#live.mutationTail = new Promise<void>((resolveMutation) => {
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
  session.modelItems.push(epochBoundaryItem(epoch, locale));
  session.epochId = epoch.epochId;
  session.authorization = null;
  session.pendingSettlement = null;
  session.lastFailure = null;
  session.updatedAt = Date.now();
}

function epochBoundaryItem(
  epoch: StoredWorldRevisionEpoch,
  locale: AppLocale,
): Extract<
  StoredWorldRevisionSession["modelItems"][number],
  { kind: "prompt_delta" }
> {
  const markdown =
    locale === "zh-CN"
      ? `# 新的世界修订 epoch\n\n上一轮修订已经应用或放弃。当前工作树是 ${epoch.epochId}，从世界端点 ${epoch.baseHead} 重新建立。此前全部 search cursor 和 read 写授权已失效；修改前必须重新读取。`
      : `# New world-revision epoch\n\nThe previous revision was applied or discarded. Worktree ${epoch.epochId} was rebuilt from world endpoint ${epoch.baseHead}. Every prior search cursor and read authorization is invalid; re-read before writing.`;
  return {
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
  };
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
    ...(session.damagedContinuation
      ? {
          unavailableReason:
            "Google continuation is damaged; start a fresh model context.",
        }
      : {}),
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

function canRetryWorldRevisionRequest(
  session: StoredWorldRevisionSession,
): boolean {
  return (
    session.runStatus === "interrupted" &&
    session.modelBinding.provider !== "google_interactions" &&
    session.googleOutcomeUnknown !== true &&
    session.pendingSettlement === null &&
    session.retryDispatch?.state === "retryable" &&
    validAuthoringNativeContinuation(
      session.modelItems,
      session.modelBinding.provider,
    )
  );
}

function revertWorldRevisionChanges(
  files: StoredWorldRevisionEpoch["files"],
  items: StoredWorldRevisionSession["modelItems"],
): StoredWorldRevisionEpoch["files"] {
  const result = new Map(
    files.map((file) => [file.path, structuredClone(file)]),
  );
  const conflicts = new Set<string>();
  const changes = items
    .flatMap((item) =>
      item.kind === "tool" && !item.isError ? item.changes : [],
    )
    .reverse();
  for (const change of changes) {
    if (conflicts.has(change.path)) continue;
    const current = result.get(change.path);
    if (
      change.after === null
        ? current !== undefined
        : current?.contents !== change.after || current.encoding !== undefined
    ) {
      conflicts.add(change.path);
      continue;
    }
    if (change.before === null) result.delete(change.path);
    else
      result.set(change.path, { path: change.path, contents: change.before });
  }
  if (conflicts.size > 0)
    throw new WorldRevisionMessageEditError("conflict", [...conflicts].sort());
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}
