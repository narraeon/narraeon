import { createHash, randomUUID } from "node:crypto";

import {
  aggregateModelUsage,
  emptyAggregatedModelUsage,
} from "../../protocol/modelUsage.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { V1SettingImprovementView } from "../../protocol/v1.ts";
import type { ContentWorkspace } from "../content/ContentWorkspace.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import type {
  ModelHost,
  ModelHostDelta,
  ModelHostResponse,
} from "../model/ModelHost.ts";
import {
  equalModelHostBinding,
  ModelHostCancelledError,
} from "../model/ModelHost.ts";
import {
  FileNativePromptCompiler,
  type PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementPromptForBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import {
  type FileNativeSettingImprovementStore,
  type StoredSettingImprovementSession,
} from "./FileNativeSettingImprovementStore.ts";
import {
  SettingImprovementDraft,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "./SettingImprovementDraft.ts";

const maximumExchangesPerMessage = 64;
const maximumStreamTailCharacters = 240;

export type SettingImprovementView = V1SettingImprovementView;

interface LiveRun {
  requestId: string;
  controller: AbortController;
  promise: Promise<SettingImprovementView>;
  streaming: NonNullable<SettingImprovementView["progress"]["streaming"]>;
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
    modelBinding: ReturnType<ModelHost["binding"]>,
    playPreset: PlayPresetBinding | undefined,
  ) => PromptPreview;
  readonly #runs = new Map<string, LiveRun>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    store: FileNativeSettingImprovementStore;
    content: ContentWorkspace;
    compiler: FileNativePromptCompiler;
    locale: () => AppLocale;
    bindModelHost: () => Promise<ModelHost>;
    bindPlayPreset: () => Promise<PlayPresetBinding>;
    preview: (
      snapshot: WorldDocumentStore,
      modelBinding: ReturnType<ModelHost["binding"]>,
      playPreset: PlayPresetBinding | undefined,
    ) => PromptPreview;
  }) {
    this.#store = input.store;
    this.#content = input.content;
    this.#compiler = input.compiler;
    this.#locale = input.locale;
    this.#bindModelHost = input.bindModelHost;
    this.#bindPlayPreset = input.bindPlayPreset;
    this.#preview = input.preview;
  }

  async read(packageId: string): Promise<SettingImprovementView | null> {
    const session = await this.#store.findOpenByPackage(packageId);
    if (session === null) return null;
    const recovered = await this.#recoverIfNeeded(session);
    return this.#view(recovered);
  }

  async send(input: {
    packageId: string;
    requestId: string;
    message: string;
  }): Promise<SettingImprovementView> {
    const message = requiredMessage(input.message);
    const requestId = requiredRequestId(input.requestId);
    const prepared = await this.#mutate(async () => {
      let session = await this.#store.findOpenByPackage(input.packageId);
      session ??= await this.#create(input.packageId);
      session = await this.#recoverIfNeeded(session);
      if (session.completedRequestIds.includes(requestId))
        return { session, run: null as LiveRun | null };
      const running = this.#runs.get(session.sessionId);
      if (running !== undefined) {
        if (running.requestId !== requestId)
          throw new Error(
            "Another setting-improvement message is still running",
          );
        return { session, run: running };
      }
      if (session.lifecycle !== "open")
        throw new Error("The setting-improvement conversation is closed");
      const host = await this.#bindModelHost();
      if (!equalModelHostBinding(session.modelBinding, host.binding()))
        throw new Error(
          "The enabled model connection no longer matches this setting-improvement conversation",
        );
      const now = Date.now();
      session.messages.push({
        id: `message-${randomUUID()}`,
        role: "user",
        text: message,
        createdAt: now,
      });
      session.modelItems.push({ kind: "user", text: message });
      session.runStatus = "running";
      session.activeRequestId = requestId;
      session.lastFailure = null;
      session.updatedAt = now;
      await this.#store.save(session);
      const controller = new AbortController();
      const live = {
        requestId,
        controller,
        promise: Promise.resolve(
          undefined as unknown as SettingImprovementView,
        ),
        streaming: emptyStreaming(),
      } satisfies LiveRun;
      live.promise = this.#run(session, host, live).finally(() => {
        if (this.#runs.get(session.sessionId) === live)
          this.#runs.delete(session.sessionId);
      });
      this.#runs.set(session.sessionId, live);
      return { session, run: live };
    });
    return prepared.run === null
      ? this.#view(prepared.session)
      : prepared.run.promise;
  }

  async cancel(sessionId: string): Promise<SettingImprovementView> {
    const running = this.#runs.get(sessionId);
    if (running !== undefined) {
      running.controller.abort();
      return running.promise;
    }
    const session = await this.#recoverIfNeeded(
      await this.#store.read(sessionId),
    );
    return this.#view(session);
  }

  async apply(
    sessionId: string,
    expectedDraftVersion: number,
  ): Promise<SettingImprovementView> {
    return this.#mutate(async () => {
      const session = await this.#recoverIfNeeded(
        await this.#store.read(sessionId),
      );
      if (this.#runs.has(sessionId) || session.runStatus === "running")
        throw new Error("Wait for the current model response before applying");
      if (session.lifecycle === "applied") return this.#view(session);
      if (session.lifecycle !== "open")
        throw new Error("The setting-improvement conversation is closed");
      if (session.draftVersion !== expectedDraftVersion)
        throw new Error(
          "The isolated draft changed; review the latest version before applying",
        );

      // Apply never trusts a cached review. Re-open the exact persisted draft
      // and run the mechanical inspection plus real Prompt Preview again while
      // the requested version is settled.
      const recheckedDraft = this.#openDraft(session);
      session.draft = recheckedDraft.persist();
      session.review = recheckedDraft.review();
      if (
        session.review.status !== "usable" ||
        session.review.diff.length === 0
      ) {
        session.lastFailure =
          "Only a changed draft that passes automatic checks can be applied";
        session.updatedAt = Date.now();
        await this.#store.save(session);
        throw new Error(session.lastFailure);
      }

      const draftFingerprint = contentFingerprint(session.draft.files);
      session.applyRequest = { expectedDraftVersion, draftFingerprint };
      session.updatedAt = Date.now();
      await this.#store.save(session);
      const lease = await this.#content.beginCurrentTreeContentPackageOperation(
        session.packageId,
      );
      try {
        const liveFingerprint = contentFingerprint(lease.package.files);
        if (liveFingerprint === session.baseFingerprint) {
          await lease.replace(session.draft.files);
        } else {
          session.applyRequest = null;
          session.lastFailure =
            "The content package changed after this conversation started; the draft was not applied.";
          session.updatedAt = Date.now();
          await this.#store.save(session);
          throw new Error(session.lastFailure);
        }
      } finally {
        lease.release();
      }
      session.lifecycle = "applied";
      session.runStatus = "ready";
      session.applyRequest = null;
      session.appliedAt = Date.now();
      session.updatedAt = session.appliedAt;
      session.lastFailure = null;
      await this.#store.save(session);
      return this.#view(session, "current");
    });
  }

  async discard(sessionId: string): Promise<SettingImprovementView> {
    return this.#mutate(async () => {
      const session = await this.#recoverIfNeeded(
        await this.#store.read(sessionId),
      );
      if (this.#runs.has(sessionId) || session.runStatus === "running")
        throw new Error(
          "Cancel or wait for the current response before discarding",
        );
      if (session.lifecycle === "applied")
        throw new Error("An applied setting draft cannot be discarded");
      session.lifecycle = "discarded";
      session.runStatus = "ready";
      session.updatedAt = Date.now();
      session.lastFailure = null;
      await this.#store.save(session);
      return this.#view(session);
    });
  }

  async #create(packageId: string): Promise<StoredSettingImprovementSession> {
    const [package_, host, playPreset] = await Promise.all([
      this.#content.readCurrentTreeContentPackage(packageId),
      this.#bindModelHost(),
      this.#bindPlayPreset(),
    ]);
    const locale = this.#locale();
    const modelBinding = host.binding();
    const authorPrompt = settingImprovementPromptForBinding(playPreset, locale);
    const draft = new SettingImprovementDraft({
      baseFiles: package_.files,
      locale,
      preview: (snapshot) => this.#preview(snapshot, modelBinding, playPreset),
    });
    const tools = settingImprovementToolDefinitions(locale);
    const bootstrap = this.#compiler.compileSettingImprovement({
      contentPackageTitle: package_.title,
      runtimeContract: settingImprovementRuntimeContract(locale),
      authorPrompt,
      playPreset,
      modelBinding,
      tools,
    });
    const now = Date.now();
    const session: StoredSettingImprovementSession = {
      schemaVersion: 1,
      sessionId: this.#store.createId(),
      packageId,
      contentPackageTitle: package_.title,
      locale,
      lifecycle: "open",
      runStatus: "ready",
      createdAt: now,
      updatedAt: now,
      baseFingerprint: contentFingerprint(package_.files),
      baseFiles: cloneFiles(package_.files),
      draftVersion: 0,
      draft: draft.persist(),
      review: draft.review(),
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
      applyRequest: null,
      appliedAt: null,
    };
    await this.#store.save(session);
    return session;
  }

  async #run(
    session: StoredSettingImprovementSession,
    host: ModelHost,
    live: LiveRun,
  ): Promise<SettingImprovementView> {
    try {
      let draft: SettingImprovementDraft | null = null;
      for (let round = 0; round < maximumExchangesPerMessage; round += 1) {
        session.exchange += 1;
        live.streaming = emptyStreaming();
        session.updatedAt = Date.now();
        await this.#store.save(session);
        const response = await host.exchange(
          {
            bootstrap: session.bootstrap,
            toolUniverse: session.bootstrap.toolUniverse,
            allowedTools: session.bootstrap.toolUniverse.map(
              ({ name }) => name,
            ),
            toolStrategy: session.bootstrap.toolStrategy,
            tools: session.bootstrap.tools,
            appended: session.modelItems,
            requestId: live.requestId,
            operationId: session.sessionId,
            requestAttempt: 1,
            exchange: session.exchange,
            maxOutputTokens: session.modelBinding.maxOutputTokens,
          },
          {
            signal: live.controller.signal,
            onDelta: (delta) => recordDelta(live, delta),
          },
        );
        assertCompleteResponse(response);
        const toolCalls = response.toolCalls ?? [];
        assertUniqueToolCallIds(toolCalls);
        const visibleText = response.text ?? "";
        if (toolCalls.length === 0 && visibleText.trim().length === 0)
          throw new Error(
            "The model returned an empty tool-free authoring response",
          );
        session.usage = aggregateModelUsage(session.usage, response.usage);
        session.modelItems.push({
          kind: "assistant",
          text: response.text ?? "",
          ...(response.reasoningContent === undefined
            ? {}
            : { reasoningContent: response.reasoningContent }),
          providerState: response.providerState!,
          toolCalls: structuredClone(toolCalls),
        });
        session.updatedAt = Date.now();
        if (toolCalls.length === 0) {
          session.messages.push({
            id: `message-${randomUUID()}`,
            role: "assistant",
            text: visibleText,
            createdAt: session.updatedAt,
          });
          session.runStatus = "ready";
          session.activeRequestId = null;
          session.completedRequestIds = rememberRequest(
            session.completedRequestIds,
            live.requestId,
          );
          session.lastFailure = null;
          await this.#store.save(session);
          return this.#view(session);
        }

        // The complete provider response and native continuation are durable
        // before any draft tool can run.
        await this.#store.save(session);
        draft ??= this.#openDraft(session);
        const before = contentFingerprint(draft.files());
        const results = draft.execute(toolCalls);
        const after = contentFingerprint(draft.files());
        session.draft = draft.persist();
        session.review = draft.review();
        if (before !== after) session.draftVersion += 1;
        session.toolCalls += toolCalls.length;
        for (const result of results)
          session.modelItems.push({
            kind: "tool",
            toolCallId: result.toolCallId,
            markdown: result.markdown,
            ...(result.isError ? { isError: true } : {}),
          });
        session.updatedAt = Date.now();
        await this.#store.save(session);
      }
      throw new Error(
        `Setting improvement exceeded ${maximumExchangesPerMessage} model exchanges for one user message`,
      );
    } catch (error: unknown) {
      session.runStatus = "interrupted";
      session.activeRequestId = null;
      session.completedRequestIds = rememberRequest(
        session.completedRequestIds,
        live.requestId,
      );
      session.lastFailure = describeFailure(error);
      session.updatedAt = Date.now();
      await this.#store.save(session);
      return this.#view(session);
    }
  }

  async #recoverIfNeeded(
    original: StoredSettingImprovementSession,
  ): Promise<StoredSettingImprovementSession> {
    if (this.#runs.has(original.sessionId)) return original;
    const session = structuredClone(original);
    const currentPackage = await this.#content.readCurrentTreeContentPackage(
      session.packageId,
    );
    const runtimeContractUpgraded = this.#upgradeRuntimeContract(
      session,
      currentPackage.title,
    );
    if (session.applyRequest !== null) {
      const currentFingerprint = contentFingerprint(currentPackage.files);
      if (currentFingerprint === session.applyRequest.draftFingerprint) {
        session.lifecycle = "applied";
        session.appliedAt = Date.now();
        session.applyRequest = null;
        session.lastFailure = null;
        session.updatedAt = session.appliedAt;
        await this.#store.save(session);
        return session;
      }
      session.applyRequest = null;
      if (currentFingerprint !== session.baseFingerprint)
        session.lastFailure =
          "The content package changed while a previous Apply was incomplete; the draft was not applied.";
      session.updatedAt = Date.now();
      await this.#store.save(session);
    }
    const lastAssistantIndex = session.modelItems.findLastIndex(
      (item) => item.kind === "assistant",
    );
    const lastAssistant =
      lastAssistantIndex < 0
        ? undefined
        : session.modelItems[lastAssistantIndex];
    const pendingTools =
      lastAssistant?.kind === "assistant" &&
      lastAssistantIndex === session.modelItems.length - 1 &&
      lastAssistant.toolCalls.length > 0;
    if (session.runStatus !== "running" && !pendingTools) {
      if (runtimeContractUpgraded) {
        session.updatedAt = Date.now();
        await this.#store.save(session);
      }
      return session;
    }
    if (pendingTools && lastAssistant?.kind === "assistant") {
      const draft = this.#openDraft(session);
      const before = contentFingerprint(draft.files());
      const results = draft.execute(lastAssistant.toolCalls);
      const after = contentFingerprint(draft.files());
      session.draft = draft.persist();
      session.review = draft.review();
      if (before !== after) session.draftVersion += 1;
      session.toolCalls += lastAssistant.toolCalls.length;
      for (const result of results)
        session.modelItems.push({
          kind: "tool",
          toolCallId: result.toolCallId,
          markdown: result.markdown,
          ...(result.isError ? { isError: true } : {}),
        });
    }
    const interruptedRequestId = session.activeRequestId;
    session.runStatus = "interrupted";
    session.activeRequestId = null;
    if (interruptedRequestId !== null)
      session.completedRequestIds = rememberRequest(
        session.completedRequestIds,
        interruptedRequestId,
      );
    session.lastFailure =
      "The previous model request did not finish before Runtime stopped. The last complete draft was retained; send another message to continue.";
    session.updatedAt = Date.now();
    await this.#store.save(session);
    return session;
  }

  #upgradeRuntimeContract(
    session: StoredSettingImprovementSession,
    contentPackageTitle: string,
  ): boolean {
    if (session.lifecycle !== "open" || session.playPreset === undefined)
      return false;
    const tools = settingImprovementToolDefinitions(session.locale);
    const runtimeContract = settingImprovementRuntimeContract(session.locale);
    const currentRuntimeContract = session.bootstrap.logicalMessages.find(
      ({ role }) => role === "runtime_system",
    )?.markdown;
    if (
      session.contentPackageTitle === contentPackageTitle &&
      currentRuntimeContract === runtimeContract &&
      JSON.stringify(session.bootstrap.toolUniverse) === JSON.stringify(tools)
    )
      return false;
    const authorPrompt = session.bootstrap.logicalMessages.find(
      ({ role }) => role === "author_instruction",
    )?.markdown;
    if (authorPrompt === undefined) return false;
    const compiler = new FileNativePromptCompiler({
      locale: session.locale,
      toolStrategy: session.bootstrap.toolStrategy,
    });
    session.bootstrap = compiler.compileSettingImprovement({
      contentPackageTitle,
      runtimeContract,
      authorPrompt,
      playPreset: session.playPreset,
      modelBinding: session.modelBinding,
      tools,
    });
    session.contentPackageTitle = contentPackageTitle;
    return true;
  }

  #openDraft(
    session: StoredSettingImprovementSession,
  ): SettingImprovementDraft {
    return new SettingImprovementDraft({
      baseFiles: session.baseFiles,
      locale: session.locale,
      preview: (snapshot) =>
        this.#preview(snapshot, session.modelBinding, session.playPreset),
      persisted: session.draft,
    });
  }

  async #view(
    session: StoredSettingImprovementSession,
    knownBaseStatus?: "current" | "stale",
  ): Promise<SettingImprovementView> {
    const live =
      session.runStatus === "running"
        ? this.#runs.get(session.sessionId)
        : undefined;
    const currentFingerprint =
      knownBaseStatus === undefined
        ? contentFingerprint(
            (
              await this.#content.readCurrentTreeContentPackage(
                session.packageId,
              )
            ).files,
          )
        : null;
    const baseStatus =
      knownBaseStatus ??
      (currentFingerprint === session.baseFingerprint ||
      (session.lifecycle === "applied" &&
        currentFingerprint === contentFingerprint(session.draft.files))
        ? "current"
        : "stale");
    return {
      sessionId: session.sessionId,
      packageId: session.packageId,
      lifecycle: session.lifecycle,
      runStatus: live === undefined ? session.runStatus : "running",
      baseStatus,
      draftVersion: session.draftVersion,
      messages: structuredClone(session.messages),
      review: structuredClone(session.review),
      usage: structuredClone(session.usage),
      progress: {
        exchange: session.exchange,
        toolCalls: session.toolCalls,
        streaming: live === undefined ? null : structuredClone(live.streaming),
        updatedAt: session.updatedAt,
      },
      lastFailure: session.lastFailure,
      canApply:
        session.lifecycle === "open" &&
        live === undefined &&
        session.runStatus !== "running" &&
        baseStatus === "current" &&
        session.review.status === "usable" &&
        session.review.diff.length > 0,
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

function assertCompleteResponse(response: ModelHostResponse): void {
  if (response.providerState === undefined)
    throw new Error(
      "The complete authoring response is missing provider continuation state",
    );
}

function assertUniqueToolCallIds(
  calls: readonly { id: string; name: string }[],
): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (call.id.length === 0 || call.name.length === 0 || ids.has(call.id))
      throw new Error("The model returned invalid or duplicate tool-call IDs");
    ids.add(call.id);
  }
}

function emptyStreaming(): NonNullable<
  SettingImprovementView["progress"]["streaming"]
> {
  return {
    reasoningChars: 0,
    textChars: 0,
    toolChars: 0,
    tail: "",
    receivedAt: Date.now(),
  };
}

function recordDelta(live: LiveRun, delta: ModelHostDelta): void {
  if (delta.kind === "reasoning")
    live.streaming.reasoningChars += delta.text.length;
  else if (delta.kind === "text") live.streaming.textChars += delta.text.length;
  else live.streaming.toolChars += delta.text.length;
  if (delta.kind === "text")
    live.streaming.tail = `${live.streaming.tail}${delta.text}`.slice(
      -maximumStreamTailCharacters,
    );
  live.streaming.receivedAt = Date.now();
}

function describeFailure(error: unknown): string {
  if (error instanceof ModelHostCancelledError)
    return "The setting-improvement response was cancelled. The last complete draft was retained.";
  return error instanceof Error
    ? error.message
    : "The setting-improvement response was interrupted";
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

function rememberRequest(
  existing: readonly string[],
  requestId: string,
): string[] {
  return [
    ...existing.filter((candidate) => candidate !== requestId),
    requestId,
  ];
}

export function contentFingerprint(files: readonly ContentTreeFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .map(({ path, contents, encoding }) => ({
            path,
            contents,
            ...(encoding === undefined ? {} : { encoding }),
          }))
          .sort((left, right) =>
            left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
          ),
      ),
    )
    .digest("hex");
}

function cloneFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files.map((file) => structuredClone(file));
}
