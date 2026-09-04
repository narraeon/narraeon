import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ModelUsage } from "../../protocol/modelUsage.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { contentTreeFingerprint } from "../content/ContentTreeFingerprint.ts";
import type {
  ModelHostAppendItem,
  ModelHostBinding,
} from "../model/ModelHost.ts";
import {
  isPlayPresetBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import type {
  SettingAuthoringAuthorization,
  SettingAuthoringDiff,
  SettingAuthoringToolResult,
} from "../setting/SettingAuthoringTransaction.ts";

export type WorldRevisionChangeSource = "manual" | "ai" | "rollback";

export interface StoredWorldRevisionChangeSet {
  changeSetId: string;
  source: WorldRevisionChangeSource;
  createdAt: number;
  changes: SettingAuthoringDiff[];
}

export interface StoredWorldRevisionApply {
  operationId: string;
  expectedRevision: string;
  phase: "prepared" | "state_committed" | "control_published";
  committedHead: string | null;
}

export interface StoredWorldRevisionEpoch {
  schemaVersion: 1;
  epochId: string;
  worldId: string;
  lifecycle: "active" | "applying" | "applied" | "discarded";
  baseHead: string;
  baseControlFingerprint: string;
  baseFiles: ContentTreeFile[];
  files: ContentTreeFile[];
  revision: string;
  changes: StoredWorldRevisionChangeSet[];
  apply: StoredWorldRevisionApply | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type StoredWorldRevisionModelItem =
  | Exclude<ModelHostAppendItem, { kind: "tool" }>
  | (Extract<ModelHostAppendItem, { kind: "tool" }> & {
      changes: SettingAuthoringDiff[];
      changeSetId: string | null;
    });

export interface StoredWorldRevisionToolResult extends SettingAuthoringToolResult {
  changeSetId: string | null;
}

export type StoredWorldRevisionPendingSettlement =
  | {
      phase: "response_confirmed";
      assistantItemIndex: number;
      epochId: string;
      beforeRevision: string;
    }
  | {
      phase: "publication_prepared";
      assistantItemIndex: number;
      epochId: string;
      beforeRevision: string;
      afterRevision: string;
      afterFiles: ContentTreeFile[];
      toolResults: StoredWorldRevisionToolResult[];
      authorization: SettingAuthoringAuthorization;
    };

export interface StoredWorldRevisionSession {
  schemaVersion: 1;
  sessionId: string;
  worldId: string;
  worldTitle: string;
  epochId: string;
  locale: AppLocale;
  runStatus: "ready" | "running" | "interrupted";
  createdAt: number;
  updatedAt: number;
  creationRequestId: string;
  bootstrap: PromptCompilation;
  modelBinding: ModelHostBinding;
  playPreset: PlayPresetBinding;
  modelItems: StoredWorldRevisionModelItem[];
  messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
  }[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
  authorization: SettingAuthoringAuthorization | null;
  pendingSettlement: StoredWorldRevisionPendingSettlement | null;
}

const uuidV4Pattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const epochIdPattern = new RegExp(`^revision-${uuidV4Pattern}$`, "u");
const sessionIdPattern = new RegExp(`^world-session-${uuidV4Pattern}$`, "u");
const changeSetIdPattern = new RegExp(`^change-set:${uuidV4Pattern}$`, "u");
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/u;
const treeRevisionPattern = /^[0-9a-f]{64}$/u;
const epochName = new RegExp(`^revision-${uuidV4Pattern}\\.json$`, "u");
const sessionName = new RegExp(`^world-session-${uuidV4Pattern}\\.json$`, "u");

/** File-native persistence for revision worktrees and their conversations. */
export class FileNativeWorldRevisionStore {
  readonly #epochsRoot: string;
  readonly #sessionsRoot: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    const root = join(resolve(dataRoot), "world-revisions");
    this.#epochsRoot = join(root, "epochs");
    this.#sessionsRoot = join(root, "sessions");
  }

  createEpochId(): string {
    return `revision-${randomUUID()}`;
  }

  createSessionId(): string {
    return `world-session-${randomUUID()}`;
  }

  createChangeSetId(): string {
    return `change-set:${randomUUID()}`;
  }

  readEpoch(epochId: string): Promise<StoredWorldRevisionEpoch> {
    return this.#afterMutations(() => this.#readEpoch(epochId));
  }

  async readEpochIfPresent(
    epochId: string,
  ): Promise<StoredWorldRevisionEpoch | null> {
    try {
      return await this.readEpoch(epochId);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  saveEpoch(epoch: StoredWorldRevisionEpoch): Promise<void> {
    return this.#mutate(async () => {
      validateEpoch(epoch);
      await publishJson(this.#epochPath(epoch.epochId), epoch);
    });
  }

  async listEpochs(worldId: string): Promise<StoredWorldRevisionEpoch[]> {
    return this.#afterMutations(async () => {
      const entries = await readdir(this.#epochsRoot, {
        withFileTypes: true,
      }).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      });
      const epochs: StoredWorldRevisionEpoch[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !epochName.test(entry.name)) continue;
        const epoch = await this.#readEpoch(entry.name.slice(0, -5));
        if (epoch.worldId === worldId) epochs.push(epoch);
      }
      return epochs.sort(compareUpdated);
    });
  }

  readSession(sessionId: string): Promise<StoredWorldRevisionSession> {
    return this.#afterMutations(() => this.#readSession(sessionId));
  }

  saveSession(session: StoredWorldRevisionSession): Promise<void> {
    return this.#mutate(async () => {
      validateSession(session);
      await publishJson(this.#sessionPath(session.sessionId), session);
    });
  }

  async listSessions(worldId: string): Promise<StoredWorldRevisionSession[]> {
    return this.#afterMutations(async () => {
      const entries = await readdir(this.#sessionsRoot, {
        withFileTypes: true,
      }).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      });
      const sessions: StoredWorldRevisionSession[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !sessionName.test(entry.name)) continue;
        const session = await this.#readSession(entry.name.slice(0, -5));
        if (session.worldId === worldId) sessions.push(session);
      }
      return sessions.sort(compareUpdated);
    });
  }

  async findByCreationRequest(
    worldId: string,
    requestId: string,
  ): Promise<StoredWorldRevisionSession | null> {
    return (
      (await this.listSessions(worldId)).find(
        ({ creationRequestId }) => creationRequestId === requestId,
      ) ?? null
    );
  }

  deleteSession(worldId: string, sessionId: string): Promise<void> {
    return this.#mutate(async () => {
      const session = await this.#readSession(sessionId);
      if (session.worldId !== worldId)
        throw new Error("World-revision conversation belongs to another world");
      await rm(this.#sessionPath(sessionId));
      await syncDirectory(this.#sessionsRoot);
    });
  }

  async #readEpoch(epochId: string): Promise<StoredWorldRevisionEpoch> {
    assertEpochId(epochId);
    const value = JSON.parse(
      await readFile(this.#epochPath(epochId), "utf8"),
    ) as unknown;
    const epoch = validateEpoch(value);
    if (epoch.epochId !== epochId)
      throw new Error("World-revision epoch identity does not match its file");
    return epoch;
  }

  async #readSession(sessionId: string): Promise<StoredWorldRevisionSession> {
    assertSessionId(sessionId);
    const value = JSON.parse(
      await readFile(this.#sessionPath(sessionId), "utf8"),
    ) as unknown;
    const session = validateSession(value);
    if (session.sessionId !== sessionId)
      throw new Error(
        "World-revision conversation identity does not match its file",
      );
    return session;
  }

  async #afterMutations<T>(read: () => Promise<T>): Promise<T> {
    await this.#mutationTail;
    return read();
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
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

  #epochPath(epochId: string): string {
    assertEpochId(epochId);
    return join(this.#epochsRoot, `${epochId}.json`);
  }

  #sessionPath(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.#sessionsRoot, `${sessionId}.json`);
  }
}

function validateEpoch(value: unknown): StoredWorldRevisionEpoch {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "epochId",
      "worldId",
      "lifecycle",
      "baseHead",
      "baseControlFingerprint",
      "baseFiles",
      "files",
      "revision",
      "changes",
      "apply",
      "createdAt",
      "updatedAt",
      "finishedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.epochId !== "string" ||
    !nonEmptyString(value.worldId) ||
    !["active", "applying", "applied", "discarded"].includes(
      String(value.lifecycle),
    ) ||
    !nonEmptyString(value.baseHead) ||
    typeof value.baseControlFingerprint !== "string" ||
    !fingerprintPattern.test(value.baseControlFingerprint) ||
    !validFiles(value.baseFiles) ||
    revisionControlFingerprint(value.baseFiles) !==
      value.baseControlFingerprint ||
    !validFiles(value.files) ||
    typeof value.revision !== "string" ||
    !treeRevisionPattern.test(value.revision) ||
    contentTreeFingerprint(value.files) !== value.revision ||
    !Array.isArray(value.changes) ||
    !value.changes.every(validChangeSet) ||
    new Set(
      value.changes.flatMap((change) =>
        isRecord(change) && typeof change.changeSetId === "string"
          ? [change.changeSetId]
          : [],
      ),
    ).size !== value.changes.length ||
    !validApply(value.apply) ||
    !finite(value.createdAt) ||
    !finite(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.finishedAt !== null &&
      (!finite(value.finishedAt) || value.finishedAt < value.createdAt)) ||
    !validEpochLifecycle(value)
  )
    throw new Error("World-revision epoch does not match its durable schema");
  assertEpochId(value.epochId);
  return structuredClone(value) as unknown as StoredWorldRevisionEpoch;
}

function validateSession(value: unknown): StoredWorldRevisionSession {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "sessionId",
      "worldId",
      "worldTitle",
      "epochId",
      "locale",
      "runStatus",
      "createdAt",
      "updatedAt",
      "creationRequestId",
      "bootstrap",
      "modelBinding",
      "playPreset",
      "modelItems",
      "messages",
      "usage",
      "exchange",
      "toolCalls",
      "activeRequestId",
      "completedRequestIds",
      "lastFailure",
      "authorization",
      "pendingSettlement",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    !nonEmptyString(value.worldId) ||
    typeof value.worldTitle !== "string" ||
    value.worldTitle.trim().length === 0 ||
    /[\r\n\0]/u.test(value.worldTitle) ||
    typeof value.epochId !== "string" ||
    (value.locale !== "en" && value.locale !== "zh-CN") ||
    !["ready", "running", "interrupted"].includes(String(value.runStatus)) ||
    !finite(value.createdAt) ||
    !finite(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !nonEmptyString(value.creationRequestId) ||
    !validPromptCompilation(value.bootstrap) ||
    !validModelBinding(value.modelBinding) ||
    !isPlayPresetBinding(value.playPreset) ||
    !Array.isArray(value.modelItems) ||
    !value.modelItems.every(validModelItem) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(validMessage) ||
    !validModelUsage(value.usage) ||
    !count(value.exchange) ||
    !count(value.toolCalls) ||
    (value.activeRequestId !== null &&
      typeof value.activeRequestId !== "string") ||
    (value.runStatus === "running") !== (value.activeRequestId !== null) ||
    !Array.isArray(value.completedRequestIds) ||
    !value.completedRequestIds.every((item) => typeof item === "string") ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    !validAuthorization(value.authorization) ||
    !validPendingSettlement(value.pendingSettlement) ||
    !validPendingForSession(
      value.pendingSettlement,
      value.epochId,
      value.runStatus,
    ) ||
    !validPendingAssistant(value.pendingSettlement, value.modelItems)
  )
    throw new Error(
      "World-revision conversation does not match its durable schema",
    );
  assertSessionId(value.sessionId);
  assertEpochId(value.epochId);
  return structuredClone(value) as unknown as StoredWorldRevisionSession;
}

function validFiles(value: unknown): value is ContentTreeFile[] {
  if (!Array.isArray(value)) return false;
  const paths = new Set<string>();
  for (const file of value) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["path", "contents"], ["encoding"]) ||
      typeof file.path !== "string" ||
      !validRevisionPath(file.path) ||
      typeof file.contents !== "string" ||
      file.encoding !== undefined
    )
      return false;
    const portablePath = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(portablePath)) return false;
    paths.add(portablePath);
  }
  return true;
}

function validChangeSet(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["changeSetId", "source", "createdAt", "changes"]) &&
    typeof value.changeSetId === "string" &&
    changeSetIdPattern.test(value.changeSetId) &&
    (value.source === "manual" ||
      value.source === "ai" ||
      value.source === "rollback") &&
    finite(value.createdAt) &&
    Array.isArray(value.changes) &&
    value.changes.length > 0 &&
    value.changes.every(validDiff)
  );
}

function validApply(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        "operationId",
        "expectedRevision",
        "phase",
        "committedHead",
      ]) &&
      nonEmptyString(value.operationId) &&
      typeof value.expectedRevision === "string" &&
      treeRevisionPattern.test(value.expectedRevision) &&
      (value.phase === "prepared" ||
        value.phase === "state_committed" ||
        value.phase === "control_published") &&
      (value.phase === "prepared"
        ? value.committedHead === null
        : nonEmptyString(value.committedHead)))
  );
}

function validEpochLifecycle(value: Record<string, unknown>): boolean {
  if (value.lifecycle === "active")
    return value.apply === null && value.finishedAt === null;
  if (value.lifecycle === "applying")
    return (
      value.apply !== null &&
      value.finishedAt === null &&
      isRecord(value.apply) &&
      value.apply.expectedRevision === value.revision
    );
  if (value.lifecycle === "applied")
    return (
      isRecord(value.apply) &&
      value.apply.phase === "control_published" &&
      value.apply.expectedRevision === value.revision &&
      value.finishedAt !== null
    );
  return (
    value.lifecycle === "discarded" &&
    value.apply === null &&
    value.finishedAt !== null
  );
}

function validDiff(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["path", "kind", "before", "after"]) ||
    typeof value.path !== "string" ||
    !validRevisionPath(value.path) ||
    (value.before !== null && typeof value.before !== "string") ||
    (value.after !== null && typeof value.after !== "string")
  )
    return false;
  if (value.kind === "create")
    return value.before === null && typeof value.after === "string";
  if (value.kind === "delete")
    return typeof value.before === "string" && value.after === null;
  return (
    value.kind === "modify" &&
    typeof value.before === "string" &&
    typeof value.after === "string" &&
    value.before !== value.after
  );
}

function validMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "role", "text", "createdAt"]) &&
    nonEmptyString(value.id) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    finite(value.createdAt)
  );
}

function validModelItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "prompt_delta")
    return (
      hasExactKeys(value, ["kind", "logicalMessages"]) &&
      validLogicalMessages(value.logicalMessages)
    );
  if (value.kind === "player" || value.kind === "user")
    return (
      hasExactKeys(value, ["kind", "text"]) && typeof value.text === "string"
    );
  if (value.kind === "assistant")
    return (
      hasExactKeys(
        value,
        ["kind", "text", "providerState", "toolCalls"],
        ["reasoningContent"],
      ) &&
      typeof value.text === "string" &&
      (value.reasoningContent === undefined ||
        typeof value.reasoningContent === "string") &&
      validProviderState(value.providerState) &&
      Array.isArray(value.toolCalls) &&
      value.toolCalls.every(validModelToolCall)
    );
  return (
    value.kind === "tool" &&
    hasExactKeys(
      value,
      ["kind", "toolCallId", "markdown", "changes", "changeSetId"],
      ["isError"],
    ) &&
    nonEmptyString(value.toolCallId) &&
    typeof value.markdown === "string" &&
    (value.isError === undefined || typeof value.isError === "boolean") &&
    Array.isArray(value.changes) &&
    value.changes.every(validDiff) &&
    (value.changeSetId === null ||
      (typeof value.changeSetId === "string" &&
        changeSetIdPattern.test(value.changeSetId))) &&
    (value.isError === true
      ? value.changes.length === 0 && value.changeSetId === null
      : value.changes.length === 0
        ? value.changeSetId === null
        : typeof value.changeSetId === "string")
  );
}

function validModelToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "name", "arguments"]) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.name)
  );
}

function validProviderState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.protocol === "chat_completions")
    return hasExactKeys(value, ["protocol", "assistantMessage"]);
  if (value.protocol === "openai_responses")
    return (
      hasExactKeys(value, ["protocol", "output"], ["responseId"]) &&
      Array.isArray(value.output) &&
      (value.responseId === undefined || typeof value.responseId === "string")
    );
  return (
    value.protocol === "anthropic_messages" &&
    hasExactKeys(
      value,
      ["protocol", "content"],
      ["responseId", "model", "stopReason"],
    ) &&
    Array.isArray(value.content) &&
    (value.responseId === undefined || typeof value.responseId === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.stopReason === undefined ||
      value.stopReason === null ||
      typeof value.stopReason === "string")
  );
}

function validPromptCompilation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "logicalMessages",
      "provider",
      "tools",
      "toolUniverse",
      "toolStrategy",
      "coverage",
      "budget",
      "cache",
    ]) &&
    validLogicalMessages(value.logicalMessages) &&
    isRecord(value.provider) &&
    validToolDefinitions(value.tools) &&
    validToolDefinitions(value.toolUniverse) &&
    (value.toolStrategy === "native_allowed_subset" ||
      value.toolStrategy === "runtime_gate") &&
    Array.isArray(value.coverage) &&
    isRecord(value.budget) &&
    isRecord(value.cache)
  );
}

function validLogicalMessages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        isRecord(message) &&
        hasExactKeys(message, ["role", "markdown", "blocks"]) &&
        [
          "runtime_system",
          "author_instruction",
          "world_context",
          "player_input",
          "assistant",
          "tool",
        ].includes(String(message.role)) &&
        typeof message.markdown === "string" &&
        Array.isArray(message.blocks) &&
        message.blocks.every(
          (block) =>
            isRecord(block) &&
            hasExactKeys(block, ["source", "markdown"]) &&
            typeof block.source === "string" &&
            typeof block.markdown === "string",
        ),
    )
  );
}

function validToolDefinitions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        hasExactKeys(tool, ["name", "description", "inputSchema"]) &&
        nonEmptyString(tool.name) &&
        typeof tool.description === "string" &&
        isRecord(tool.inputSchema),
    )
  );
}

function validModelBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "provider",
        "endpointFingerprint",
        "modelId",
        "contextWindowTokens",
        "maxOutputTokens",
        "protocolConfigFingerprint",
      ],
      ["cacheStrategy"],
    ) &&
    (value.provider === "chat_completions" ||
      value.provider === "openai_responses" ||
      value.provider === "anthropic_messages") &&
    typeof value.endpointFingerprint === "string" &&
    typeof value.modelId === "string" &&
    count(value.contextWindowTokens) &&
    count(value.maxOutputTokens) &&
    typeof value.protocolConfigFingerprint === "string" &&
    (value.cacheStrategy === undefined ||
      value.cacheStrategy === "explicit_anthropic_blocks" ||
      value.cacheStrategy === "explicit_cliproxyapi_message" ||
      value.cacheStrategy === "provider_managed")
  );
}

function validModelUsage(value: unknown): boolean {
  const fields = [
    "inputTokens",
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "outputTokens",
    "totalTokens",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...fields, "provenance"]) ||
    !fields.every((field) => value[field] === null || count(value[field])) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, fields)
  )
    return false;
  return fields.every((field) =>
    ["provider", "unavailable", "derived_provider_fields"].includes(
      String((value.provenance as Record<string, unknown>)[field]),
    ),
  );
}

function validAuthorization(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        "revision",
        "readWorldDocumentIds",
        "readableDamagedWorldPaths",
        "readOpaquePaths",
      ]) &&
      typeof value.revision === "string" &&
      treeRevisionPattern.test(value.revision) &&
      validStringArray(value.readWorldDocumentIds) &&
      validStringArray(value.readableDamagedWorldPaths) &&
      validStringArray(value.readOpaquePaths))
  );
}

function validPendingSettlement(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !count(value.assistantItemIndex) ||
    typeof value.epochId !== "string" ||
    !epochIdPattern.test(value.epochId) ||
    typeof value.beforeRevision !== "string" ||
    !treeRevisionPattern.test(value.beforeRevision)
  )
    return false;
  if (value.phase === "response_confirmed")
    return hasExactKeys(value, [
      "phase",
      "assistantItemIndex",
      "epochId",
      "beforeRevision",
    ]);
  return (
    value.phase === "publication_prepared" &&
    hasExactKeys(value, [
      "phase",
      "assistantItemIndex",
      "epochId",
      "beforeRevision",
      "afterRevision",
      "afterFiles",
      "toolResults",
      "authorization",
    ]) &&
    typeof value.afterRevision === "string" &&
    treeRevisionPattern.test(value.afterRevision) &&
    validFiles(value.afterFiles) &&
    contentTreeFingerprint(value.afterFiles) === value.afterRevision &&
    Array.isArray(value.toolResults) &&
    value.toolResults.every(validToolResult) &&
    validAuthorization(value.authorization) &&
    isRecord(value.authorization) &&
    value.authorization.revision === value.afterRevision
  );
}

function validPendingForSession(
  pending: unknown,
  epochId: string,
  runStatus: unknown,
): boolean {
  return (
    pending === null ||
    (isRecord(pending) &&
      runStatus === "running" &&
      pending.epochId === epochId)
  );
}

function validToolResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "toolCallId",
      "markdown",
      "isError",
      "changes",
      "changeSetId",
    ]) &&
    nonEmptyString(value.toolCallId) &&
    typeof value.markdown === "string" &&
    typeof value.isError === "boolean" &&
    Array.isArray(value.changes) &&
    value.changes.every(validDiff) &&
    (value.changeSetId === null ||
      (typeof value.changeSetId === "string" &&
        changeSetIdPattern.test(value.changeSetId))) &&
    (value.isError
      ? value.changes.length === 0 && value.changeSetId === null
      : value.changes.length === 0
        ? value.changeSetId === null
        : typeof value.changeSetId === "string")
  );
}

function validPendingAssistant(pending: unknown, items: unknown[]): boolean {
  if (pending === null || !isRecord(pending)) return true;
  const index = pending.assistantItemIndex;
  if (!count(index)) return false;
  const assistant = items[index];
  return (
    isRecord(assistant) &&
    assistant.kind === "assistant" &&
    Array.isArray(assistant.toolCalls) &&
    assistant.toolCalls.length > 0
  );
}

function validStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validRevisionPath(path: string): boolean {
  const safe =
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      );
  return (
    safe &&
    (/^state\/.+\.(?:ya?ml|md)$/u.test(path) ||
      path === "control/frame.yaml" ||
      path === "control/player-views.yaml" ||
      /^control\/blocks\/.+\.md$/u.test(path))
  );
}

function revisionControlFingerprint(files: readonly ContentTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of files
    .filter(({ path }) => path.startsWith("control/"))
    .map((file) => ({ ...file, path: file.path.slice("control/".length) }))
    .sort((left, right) => left.path.localeCompare(right.path)))
    hash.update(file.path).update("\0").update(file.contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function compareUpdated(
  left: { updatedAt: number; createdAt: number },
  right: { updatedAt: number; createdAt: number },
): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt;
}

function assertEpochId(value: string): void {
  if (!epochIdPattern.test(value))
    throw new Error("Invalid world-revision epoch ID");
}

function assertSessionId(value: string): void {
  if (!sessionIdPattern.test(value))
    throw new Error("Invalid world-revision conversation ID");
}

async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
