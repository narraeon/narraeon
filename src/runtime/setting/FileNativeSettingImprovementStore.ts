import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ModelUsage } from "../../protocol/modelUsage.ts";
import { ContentWorkspace } from "../content/ContentWorkspace.ts";
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
import {
  compileSettingImprovementLegacyCurrentTreeBootstrap,
  type PromptCompilation,
  type PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  settingImprovementToolDefinitions,
  type SettingAuthoringReview,
  type SettingAuthoringAuthorization,
  type SettingAuthoringDiff,
  type SettingAuthoringToolResult,
} from "./SettingAuthoringTransaction.ts";

export interface SettingConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export type StoredSettingModelItem =
  | Exclude<ModelHostAppendItem, { kind: "tool" }>
  | (Extract<ModelHostAppendItem, { kind: "tool" }> & {
      /** Accepted current-tree changes caused by this exact tool call. */
      changes: SettingAuthoringDiff[];
    });

export interface StoredSettingConfirmedToolResponse {
  phase: "response_confirmed";
  assistantItemIndex: number;
  beforeFingerprint: string;
}

export interface StoredSettingPreparedPublication {
  phase: "publication_prepared";
  assistantItemIndex: number;
  beforeFingerprint: string;
  afterFingerprint: string;
  toolResults: SettingAuthoringToolResult[];
  authorization: SettingAuthoringAuthorization;
}

export type StoredSettingPendingSettlement =
  StoredSettingConfirmedToolResponse | StoredSettingPreparedPublication;

export interface StoredLegacySettingDraft {
  outcome:
    "applied" | "discarded" | "unapplied_dropped" | "apply_outcome_unknown";
  changes: SettingAuthoringDiff[];
}

interface LegacySettingDraftState {
  files: ContentTreeFile[];
  readWorldDocumentIds: string[];
  readableDamagedWorldPaths: string[];
  readOpaquePaths: string[];
}

type LegacySettingApplyRequest = null | {
  expectedDraftVersion: number;
  draftFingerprint: string;
};

interface LegacySettingImprovementSession {
  schemaVersion: 1;
  sessionId: string;
  packageId: string;
  contentPackageTitle?: string;
  locale: AppLocale;
  lifecycle: "open" | "applied" | "discarded";
  runStatus: "ready" | "running" | "interrupted";
  createdAt: number;
  updatedAt: number;
  baseFingerprint: string;
  baseFiles: ContentTreeFile[];
  draftVersion: number;
  draft: LegacySettingDraftState;
  review: SettingAuthoringReview;
  bootstrap: PromptCompilation;
  modelBinding: ModelHostBinding;
  playPreset?: PlayPresetBinding;
  modelItems: ModelHostAppendItem[];
  messages: SettingConversationMessage[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
  applyRequest: LegacySettingApplyRequest;
  appliedAt: number | null;
}

/**
 * Durable conversation state. Content files deliberately do not live here:
 * the content package current tree is the sole authoring authority.
 */
export interface StoredSettingImprovementSession {
  schemaVersion: 2;
  sessionId: string;
  packageId: string;
  contentPackageTitle?: string;
  locale: AppLocale;
  runStatus: "ready" | "running" | "interrupted";
  createdAt: number;
  updatedAt: number;
  /** Idempotency key used only when this conversation was first created. */
  creationRequestId: string;
  bootstrap: PromptCompilation;
  modelBinding: ModelHostBinding;
  playPreset?: PlayPresetBinding;
  modelItems: StoredSettingModelItem[];
  messages: SettingConversationMessage[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
  /** Full-read capability, valid only for the exact current-tree revision. */
  authorization: SettingAuthoringAuthorization | null;
  /** Crash boundary between a complete Provider tool step and its publication. */
  pendingSettlement: StoredSettingPendingSettlement | null;
  /** Audit-only projection retained when a schema-v1 isolated draft is read. */
  legacyDraft: StoredLegacySettingDraft | null;
}

export interface StoredSettingImprovementSummary {
  sessionId: string;
  packageId: string;
  runStatus: StoredSettingImprovementSession["runStatus"];
  createdAt: number;
  updatedAt: number;
  creationRequestId: string;
  excerpt: string;
  turnCount: number;
  exchangeCount: number;
  toolCallCount: number;
  changedFileCount: number;
  exchange: number;
  toolCalls: number;
  needsRecovery: boolean;
}

const sessionFilePattern = /^setting-[0-9a-f-]{36}\.json$/u;

export class FileNativeSettingImprovementStore {
  readonly #content: Pick<
    ContentWorkspace,
    "beginCurrentTreeContentPackageOperation"
  >;
  readonly #sessionsRoot: string;
  #mutationTail: Promise<void> = Promise.resolve();
  #summaryIndex: Map<string, StoredSettingImprovementSummary> | null = null;
  #summaryIndexRevision: string | null | undefined;
  #summariesByPackage = new Map<
    string,
    Map<string, StoredSettingImprovementSummary>
  >();
  #latestByPackage = new Map<string, StoredSettingImprovementSummary>();
  #packageRevisions = new Map<string, string>();

  constructor(
    dataRoot: string,
    options: {
      content?: Pick<
        ContentWorkspace,
        "beginCurrentTreeContentPackageOperation"
      >;
    } = {},
  ) {
    this.#content = options.content ?? new ContentWorkspace(dataRoot);
    this.#sessionsRoot = join(dataRoot, "setting-improvements", "sessions");
  }

  createId(): string {
    return `setting-${randomUUID()}`;
  }

  async read(sessionId: string): Promise<StoredSettingImprovementSession> {
    await this.#mutationTail;
    return this.#read(sessionId);
  }

  async findLatestByPackage(
    packageId: string,
  ): Promise<StoredSettingImprovementSession | null> {
    const summaries = await this.listSummariesByPackage(packageId);
    return summaries[0] === undefined
      ? null
      : this.read(summaries[0].sessionId);
  }

  async findByCreationRequest(
    packageId: string,
    requestId: string,
  ): Promise<StoredSettingImprovementSession | null> {
    const summaries = await this.listSummariesByPackage(packageId);
    const match = summaries.find(
      ({ creationRequestId }) => creationRequestId === requestId,
    );
    return match === undefined ? null : this.read(match.sessionId);
  }

  async listSummariesByPackage(
    packageId: string,
  ): Promise<StoredSettingImprovementSummary[]> {
    await this.#mutationTail;
    await this.#refreshSummaryIndex();
    return [...(this.#summariesByPackage.get(packageId)?.values() ?? [])]
      .map((summary) => structuredClone(summary))
      .sort(compareSummaries);
  }

  async summaryStatusByPackage(
    packageId: string,
    sessionId?: string,
  ): Promise<{
    revision: string;
    selected: StoredSettingImprovementSummary | null;
  }> {
    await this.#mutationTail;
    await this.#refreshSummaryIndex();
    const summaries = this.#summariesByPackage.get(packageId);
    const selected =
      sessionId === undefined
        ? this.#latestByPackage.get(packageId)
        : summaries?.get(sessionId);
    return {
      revision: this.#packageRevisions.get(packageId) ?? "empty",
      selected: selected === undefined ? null : structuredClone(selected),
    };
  }

  save(session: StoredSettingImprovementSession): Promise<void> {
    return this.#mutate(async () => {
      validateStoredSession(session);
      await publishJson(this.#path(session.sessionId), session);
      await this.#recordSavedSession(session);
    });
  }

  saveIfUnchanged(
    expected: StoredSettingImprovementSession,
    replacement: StoredSettingImprovementSession,
  ): Promise<boolean> {
    return this.#mutate(async () => {
      if (expected.sessionId !== replacement.sessionId)
        throw new Error(
          "Cannot replace a different setting-improvement conversation",
        );
      validateStoredSession(replacement);
      const current = await this.#read(expected.sessionId);
      if (!isDeepStrictEqual(current, expected)) return false;
      await publishJson(this.#path(replacement.sessionId), replacement);
      await this.#recordSavedSession(replacement);
      return true;
    });
  }

  deleteSession(packageId: string, sessionId: string): Promise<void> {
    return this.#mutate(async () => {
      const session = await this.#read(sessionId);
      if (session.packageId !== packageId)
        throw new Error(
          "The setting-improvement conversation does not belong to this content package",
        );
      await rm(this.#path(sessionId));
      await rm(join(this.#sessionsRoot, `${sessionId}.schema-v1.json`), {
        force: true,
      });
      await this.#recordDeletedSession(session);
    });
  }

  async #refreshSummaryIndex(): Promise<void> {
    for (;;) {
      const revision = await directoryRevision(this.#sessionsRoot);
      if (
        this.#summaryIndex !== null &&
        this.#summaryIndexRevision === revision
      )
        return;
      let entries;
      try {
        entries = await readdir(this.#sessionsRoot, { withFileTypes: true });
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") {
          if ((await directoryRevision(this.#sessionsRoot)) !== null) continue;
          this.#replaceSummaryIndex(new Map(), null);
          return;
        }
        throw error;
      }
      const summaries = new Map<string, StoredSettingImprovementSummary>();
      for (const entry of entries) {
        if (!entry.isFile() || !sessionFilePattern.test(entry.name)) continue;
        const session = await this.#read(entry.name.slice(0, -5));
        summaries.set(
          session.sessionId,
          summarizeStoredSettingImprovementSession(session),
        );
      }
      const completedRevision = await directoryRevision(this.#sessionsRoot);
      if (completedRevision !== revision) continue;
      this.#replaceSummaryIndex(summaries, completedRevision);
      return;
    }
  }

  async #recordSavedSession(
    session: StoredSettingImprovementSession,
  ): Promise<void> {
    if (this.#summaryIndex !== null)
      this.#cacheSummary(summarizeStoredSettingImprovementSession(session));
    this.#summaryIndexRevision =
      this.#summaryIndex === null
        ? undefined
        : await directoryRevision(this.#sessionsRoot);
  }

  async #recordDeletedSession(
    session: StoredSettingImprovementSession,
  ): Promise<void> {
    if (this.#summaryIndex === null) return;
    const previous = this.#summaryIndex.get(session.sessionId);
    if (previous === undefined) {
      // The directory changed outside this instance after its last scan.
      this.#summaryIndex = null;
      this.#summaryIndexRevision = undefined;
      this.#summariesByPackage.clear();
      this.#latestByPackage.clear();
      this.#packageRevisions.clear();
      return;
    }
    this.#summaryIndex.delete(session.sessionId);
    removeFromNestedMap(
      this.#summariesByPackage,
      previous.packageId,
      previous.sessionId,
    );
    if (
      this.#latestByPackage.get(previous.packageId)?.sessionId ===
      previous.sessionId
    )
      this.#recomputeLatest(previous.packageId);
    this.#packageRevisions.set(previous.packageId, randomUUID());
    this.#summaryIndexRevision = await directoryRevision(this.#sessionsRoot);
  }

  #replaceSummaryIndex(
    summaries: Map<string, StoredSettingImprovementSummary>,
    revision: string | null,
  ): void {
    this.#summaryIndex = summaries;
    this.#summaryIndexRevision = revision;
    this.#summariesByPackage = new Map();
    this.#latestByPackage = new Map();
    this.#packageRevisions = new Map();
    for (const summary of summaries.values()) this.#insertSummary(summary);
    for (const packageId of this.#summariesByPackage.keys())
      this.#packageRevisions.set(packageId, randomUUID());
  }

  #cacheSummary(summary: StoredSettingImprovementSummary): void {
    const previous = this.#summaryIndex?.get(summary.sessionId);
    if (previous !== undefined)
      removeFromNestedMap(
        this.#summariesByPackage,
        previous.packageId,
        previous.sessionId,
      );
    if (
      previous !== undefined &&
      previous.packageId !== summary.packageId &&
      this.#latestByPackage.get(previous.packageId)?.sessionId ===
        previous.sessionId
    )
      this.#recomputeLatest(previous.packageId);
    this.#summaryIndex?.set(summary.sessionId, summary);
    this.#insertSummary(summary);
    if (previous !== undefined && previous.packageId !== summary.packageId)
      this.#packageRevisions.set(previous.packageId, randomUUID());
    this.#packageRevisions.set(summary.packageId, randomUUID());
  }

  #insertSummary(summary: StoredSettingImprovementSummary): void {
    mapFor(this.#summariesByPackage, summary.packageId).set(
      summary.sessionId,
      summary,
    );
    const latest = this.#latestByPackage.get(summary.packageId);
    if (
      latest === undefined ||
      latest.sessionId === summary.sessionId ||
      compareSummaries(summary, latest) < 0
    )
      this.#latestByPackage.set(summary.packageId, summary);
  }

  #recomputeLatest(packageId: string): void {
    const latest = [
      ...(this.#summariesByPackage.get(packageId)?.values() ?? []),
    ].sort(compareSummaries)[0];
    if (latest === undefined) this.#latestByPackage.delete(packageId);
    else this.#latestByPackage.set(packageId, latest);
  }

  async #read(sessionId: string): Promise<StoredSettingImprovementSession> {
    assertSessionId(sessionId);
    let source: string;
    let value: unknown;
    try {
      source = await readFile(this.#path(sessionId), "utf8");
      value = JSON.parse(source);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        throw new Error("Setting-improvement conversation does not exist", {
          cause: error,
        });
      throw error;
    }
    if (isRecord(value) && value.schemaVersion === 1)
      return this.#migrateLegacy(sessionId, source, value);
    const session = validateStoredSession(value);
    if (session.sessionId !== sessionId)
      throw new Error(
        "Setting-improvement conversation identity does not match its file",
      );
    return session;
  }

  async #migrateLegacy(
    sessionId: string,
    source: string,
    value: Record<string, unknown>,
  ): Promise<StoredSettingImprovementSession> {
    if (!validLegacySession(value))
      throw new Error("Legacy setting-improvement conversation is damaged");
    if (value.sessionId !== sessionId)
      throw new Error(
        "Legacy setting-improvement conversation identity does not match its file",
      );
    if (value.applyRequest === null)
      return this.#publishLegacyMigration(
        sessionId,
        source,
        migrateLegacySession(value),
      );

    const lease = await this.#content.beginCurrentTreeContentPackageOperation(
      value.packageId,
    );
    try {
      const currentFingerprint = contentTreeFingerprint(lease.package.files);
      const applyOutcome =
        currentFingerprint === value.applyRequest.draftFingerprint
          ? "applied"
          : currentFingerprint === value.baseFingerprint
            ? "unapplied_dropped"
            : "apply_outcome_unknown";
      return await this.#publishLegacyMigration(
        sessionId,
        source,
        migrateLegacySession(value, applyOutcome),
      );
    } finally {
      lease.release();
    }
  }

  async #publishLegacyMigration(
    sessionId: string,
    source: string,
    session: StoredSettingImprovementSession,
  ): Promise<StoredSettingImprovementSession> {
    await publishImmutableSource(
      join(this.#sessionsRoot, `${sessionId}.schema-v1.json`),
      source,
    );
    // This schema-v2 endpoint is the durable marker; the immutable source is
    // already synced, so an interrupted migration can restart from it.
    await publishJson(this.#path(sessionId), session);
    return session;
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

  #path(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.#sessionsRoot, `${sessionId}.json`);
  }
}

function compareSummaries(
  left: StoredSettingImprovementSummary,
  right: StoredSettingImprovementSummary,
): number {
  return (
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    right.sessionId.localeCompare(left.sessionId)
  );
}

function mapFor(
  packages: Map<string, Map<string, StoredSettingImprovementSummary>>,
  packageId: string,
): Map<string, StoredSettingImprovementSummary> {
  let summaries = packages.get(packageId);
  if (summaries === undefined) {
    summaries = new Map();
    packages.set(packageId, summaries);
  }
  return summaries;
}

function removeFromNestedMap(
  packages: Map<string, Map<string, StoredSettingImprovementSummary>>,
  packageId: string,
  sessionId: string,
): void {
  const summaries = packages.get(packageId);
  if (summaries === undefined) return;
  summaries.delete(sessionId);
  if (summaries.size === 0) packages.delete(packageId);
}

export function summarizeStoredSettingImprovementSession(
  session: StoredSettingImprovementSession,
): StoredSettingImprovementSummary {
  const assistants = session.modelItems.filter(
    ({ kind }) => kind === "assistant",
  );
  const changedPaths = new Set([
    ...session.modelItems.flatMap((item) =>
      item.kind === "tool" ? item.changes.map(({ path }) => path) : [],
    ),
    ...(session.legacyDraft?.changes.map(({ path }) => path) ?? []),
  ]);
  return {
    sessionId: session.sessionId,
    packageId: session.packageId,
    runStatus: session.runStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    creationRequestId: session.creationRequestId,
    excerpt: settingImprovementExcerpt(
      session.messages.find(({ role }) => role === "user")?.text ?? "",
    ),
    turnCount: session.modelItems.filter(({ kind }) => kind === "user").length,
    exchangeCount: assistants.length,
    toolCallCount: assistants.reduce(
      (total, item) =>
        total + (item.kind === "assistant" ? item.toolCalls.length : 0),
      0,
    ),
    changedFileCount: changedPaths.size,
    exchange: session.exchange,
    toolCalls: session.toolCalls,
    needsRecovery:
      session.pendingSettlement !== null ||
      session.runStatus === "running" ||
      hasPendingToolCalls(session),
  };
}

function settingImprovementExcerpt(message: string): string {
  return Array.from(message.replace(/\s+/gu, " ").trim())
    .slice(0, 120)
    .join("");
}

function hasPendingToolCalls(
  session: StoredSettingImprovementSession,
): boolean {
  const lastItem = session.modelItems.at(-1);
  return lastItem?.kind === "assistant" && lastItem.toolCalls.length > 0;
}

async function directoryRevision(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path, { bigint: true });
    return `${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertSessionId(sessionId: string): void {
  if (
    !/^setting-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      sessionId,
    )
  )
    throw new Error("Invalid setting-improvement conversation ID");
}

function validateStoredSession(
  value: unknown,
): StoredSettingImprovementSession {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "schemaVersion",
        "sessionId",
        "packageId",
        "locale",
        "runStatus",
        "createdAt",
        "updatedAt",
        "creationRequestId",
        "bootstrap",
        "modelBinding",
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
        "legacyDraft",
      ],
      ["contentPackageTitle", "playPreset"],
    ) ||
    value.schemaVersion !== 2 ||
    typeof value.sessionId !== "string" ||
    typeof value.packageId !== "string" ||
    !validOptionalTitle(value.contentPackageTitle) ||
    (value.locale !== "en" && value.locale !== "zh-CN") ||
    !validRunStatus(value.runStatus) ||
    !validFiniteNumber(value.createdAt) ||
    !validFiniteNumber(value.updatedAt) ||
    typeof value.creationRequestId !== "string" ||
    !validPromptCompilation(value.bootstrap) ||
    !validModelBinding(value.modelBinding) ||
    (value.playPreset !== undefined &&
      !isPlayPresetBinding(value.playPreset)) ||
    !Array.isArray(value.modelItems) ||
    !Array.isArray(value.messages) ||
    !validModelUsage(value.usage) ||
    !validCount(value.exchange) ||
    !validCount(value.toolCalls) ||
    (value.activeRequestId !== null &&
      typeof value.activeRequestId !== "string") ||
    !Array.isArray(value.completedRequestIds) ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    !validAuthorization(value.authorization) ||
    !validPendingSettlement(value.pendingSettlement) ||
    !validPendingSettlementForTranscript(
      value.pendingSettlement,
      value.modelItems,
      value.runStatus,
    ) ||
    !validLegacyDraft(value.legacyDraft)
  )
    throw new Error(
      "Setting-improvement conversation does not match its durable schema",
    );
  assertSessionId(value.sessionId);
  if (
    !value.completedRequestIds.every((id) => typeof id === "string") ||
    !value.messages.every(validMessage) ||
    !value.modelItems.every(validModelItem)
  )
    throw new Error("Setting-improvement transcript is damaged");
  return structuredClone(value) as unknown as StoredSettingImprovementSession;
}

function migrateLegacySession(
  value: Record<string, unknown>,
  applyOutcome?: "applied" | "unapplied_dropped" | "apply_outcome_unknown",
): StoredSettingImprovementSession {
  if (!validLegacySession(value))
    throw new Error("Legacy setting-improvement conversation is damaged");
  assertSessionId(value.sessionId);
  if (value.applyRequest !== null && applyOutcome === undefined)
    throw new Error("Legacy Apply migration requires a current-tree outcome");
  const legacyChanges = value.review.diff.map((diff) => structuredClone(diff));
  const modelItems = value.modelItems.map((item) => {
    const cloned = structuredClone(item);
    return cloned.kind === "tool" ? { ...cloned, changes: [] } : cloned;
  }) as StoredSettingModelItem[];
  const last = modelItems.at(-1);
  const pendingLegacyTools =
    last?.kind === "assistant" && last.toolCalls.length > 0;
  if (pendingLegacyTools && last.kind === "assistant") {
    for (const call of last.toolCalls)
      modelItems.push({
        kind: "tool",
        toolCallId: call.id,
        markdown:
          "# Legacy tool step not replayed\n\nThe isolated draft tool step was not applied during migration. The content package current tree was left unchanged; read the current tree again before editing.",
        isError: true,
        changes: [],
      });
  }
  const interruptedRequestId = value.activeRequestId;
  const completedRequestIds = [...value.completedRequestIds];
  if (
    (pendingLegacyTools || value.runStatus === "running") &&
    interruptedRequestId !== null &&
    !completedRequestIds.includes(interruptedRequestId)
  )
    completedRequestIds.push(interruptedRequestId);
  return {
    schemaVersion: 2,
    sessionId: value.sessionId,
    packageId: value.packageId,
    ...(value.contentPackageTitle === undefined
      ? {}
      : { contentPackageTitle: value.contentPackageTitle }),
    locale: value.locale,
    runStatus:
      pendingLegacyTools ||
      value.runStatus === "running" ||
      applyOutcome === "apply_outcome_unknown"
        ? "interrupted"
        : value.runStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    creationRequestId: `legacy:${value.sessionId}`,
    bootstrap: compileSettingImprovementLegacyCurrentTreeBootstrap(
      structuredClone(value.bootstrap),
      value.locale,
      settingImprovementToolDefinitions(value.locale),
    ),
    modelBinding: structuredClone(value.modelBinding),
    ...(value.playPreset === undefined
      ? {}
      : { playPreset: structuredClone(value.playPreset) }),
    modelItems,
    messages: structuredClone(value.messages),
    usage: structuredClone(value.usage),
    exchange: value.exchange,
    toolCalls: value.toolCalls,
    activeRequestId: null,
    completedRequestIds,
    lastFailure:
      pendingLegacyTools || value.runStatus === "running"
        ? "This conversation was interrupted while its legacy isolated draft was being processed. That pending step was not applied; continue from the content package current tree."
        : applyOutcome === "apply_outcome_unknown"
          ? "The legacy Apply receipt was preserved, but the current tree matches neither its base nor its draft. Whether that old draft was once applied cannot be proven; no content was changed during migration."
          : value.lastFailure,
    authorization: null,
    pendingSettlement: null,
    legacyDraft: {
      outcome:
        value.lifecycle === "applied"
          ? "applied"
          : value.lifecycle === "discarded"
            ? "discarded"
            : (applyOutcome ?? "unapplied_dropped"),
      changes: legacyChanges,
    },
  };
}

function validOptionalTitle(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      !/[\r\n]/u.test(value))
  );
}

function validRunStatus(value: unknown): boolean {
  return value === "ready" || value === "running" || value === "interrupted";
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "role", "text", "createdAt"]) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    validFiniteNumber(value.createdAt)
  );
}

function validLegacyModelItem(value: unknown): value is ModelHostAppendItem {
  return validModelItemShape(value, false);
}

function validModelItem(value: unknown): boolean {
  return validModelItemShape(value, true);
}

function validModelItemShape(
  value: unknown,
  storedToolChanges: boolean,
): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "runtime_notice")
    return (
      hasExactKeys(value, ["kind", "notice", "text"]) &&
      value.notice === "checkpoint_rounds" &&
      typeof value.text === "string"
    );
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
        ["kind", "text", "toolCalls"],
        ["reasoningContent", "providerState"],
      ) &&
      typeof value.text === "string" &&
      (value.reasoningContent === undefined ||
        typeof value.reasoningContent === "string") &&
      (value.providerState === undefined ||
        validProviderState(value.providerState)) &&
      Array.isArray(value.toolCalls) &&
      value.toolCalls.every(validModelToolCall)
    );
  if (value.kind !== "tool") return false;
  const required = storedToolChanges
    ? ["kind", "toolCallId", "markdown", "changes"]
    : ["kind", "toolCallId", "markdown"];
  return (
    hasExactKeys(value, required, ["isError"]) &&
    typeof value.toolCallId === "string" &&
    typeof value.markdown === "string" &&
    (value.isError === undefined || typeof value.isError === "boolean") &&
    (!storedToolChanges ||
      (Array.isArray(value.changes) && value.changes.every(validDiff)))
  );
}

function validLegacySession(
  value: unknown,
): value is LegacySettingImprovementSession {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "schemaVersion",
        "sessionId",
        "packageId",
        "locale",
        "lifecycle",
        "runStatus",
        "createdAt",
        "updatedAt",
        "baseFingerprint",
        "baseFiles",
        "draftVersion",
        "draft",
        "review",
        "bootstrap",
        "modelBinding",
        "modelItems",
        "messages",
        "usage",
        "exchange",
        "toolCalls",
        "activeRequestId",
        "completedRequestIds",
        "lastFailure",
        "applyRequest",
        "appliedAt",
      ],
      ["contentPackageTitle", "playPreset"],
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.packageId !== "string" ||
    !validOptionalTitle(value.contentPackageTitle) ||
    (value.locale !== "en" && value.locale !== "zh-CN") ||
    (value.lifecycle !== "open" &&
      value.lifecycle !== "applied" &&
      value.lifecycle !== "discarded") ||
    !validRunStatus(value.runStatus) ||
    !validFiniteNumber(value.createdAt) ||
    !validFiniteNumber(value.updatedAt) ||
    typeof value.baseFingerprint !== "string" ||
    !validContentTreeFiles(value.baseFiles) ||
    !validCount(value.draftVersion) ||
    !validLegacyDraftState(value.draft) ||
    !validSettingReview(value.review) ||
    !validPromptCompilation(value.bootstrap) ||
    !validModelBinding(value.modelBinding) ||
    (value.playPreset !== undefined &&
      !isPlayPresetBinding(value.playPreset)) ||
    !Array.isArray(value.modelItems) ||
    !value.modelItems.every(validLegacyModelItem) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(validMessage) ||
    !validModelUsage(value.usage) ||
    !validCount(value.exchange) ||
    !validCount(value.toolCalls) ||
    (value.activeRequestId !== null &&
      typeof value.activeRequestId !== "string") ||
    !validStringArray(value.completedRequestIds) ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    !validLegacyApplyRequest(value.applyRequest) ||
    (value.appliedAt !== null && !validFiniteNumber(value.appliedAt))
  )
    return false;
  if (value.baseFingerprint !== contentTreeFingerprint(value.baseFiles))
    return false;
  if (
    value.applyRequest !== null &&
    (value.lifecycle !== "open" ||
      value.applyRequest.expectedDraftVersion !== value.draftVersion ||
      value.applyRequest.draftFingerprint !==
        contentTreeFingerprint(value.draft.files))
  )
    return false;
  return true;
}

function validLegacyDraftState(
  value: unknown,
): value is LegacySettingDraftState {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "files",
      "readWorldDocumentIds",
      "readableDamagedWorldPaths",
      "readOpaquePaths",
    ]) &&
    validContentTreeFiles(value.files) &&
    validStringArray(value.readWorldDocumentIds) &&
    validStringArray(value.readableDamagedWorldPaths) &&
    validStringArray(value.readOpaquePaths)
  );
}

function validContentTreeFiles(value: unknown): value is ContentTreeFile[] {
  return Array.isArray(value) && value.every(validContentTreeFile);
}

function validContentTreeFile(value: unknown): value is ContentTreeFile {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["path", "contents"], ["encoding"]) &&
    typeof value.path === "string" &&
    typeof value.contents === "string" &&
    (value.encoding === undefined || value.encoding === "base64")
  );
}

function validSettingReview(value: unknown): value is SettingAuthoringReview {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["status", "diff", "diagnostics", "preview"],
      ["playCoverage"],
    ) &&
    (value.status === "usable" || value.status === "needs_repair") &&
    Array.isArray(value.diff) &&
    value.diff.every(validDiff) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(validSettingDiagnostic) &&
    (value.preview === null || validPromptPreview(value.preview)) &&
    (value.playCoverage === undefined ||
      value.playCoverage === null ||
      validSettingPlayCoverage(value.playCoverage))
  );
}

function validSettingDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "path", "message"]) &&
    typeof value.code === "string" &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

function validSettingPlayCoverage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["totals", "changed"]) ||
    !isRecord(value.totals) ||
    !hasExactKeys(value.totals, [
      "fullInjected",
      "nodeInjected",
      "catalogSummary",
      "referencedFromInjected",
      "onDemand",
    ]) ||
    !Object.values(value.totals).every(validCount) ||
    !Array.isArray(value.changed)
  )
    return false;
  return value.changed.every(
    (change) =>
      isRecord(change) &&
      hasExactKeys(change, ["path", "access", "detail"]) &&
      typeof change.path === "string" &&
      validSettingPlayAccess(change.access) &&
      typeof change.detail === "string",
  );
}

function validSettingPlayAccess(value: unknown): boolean {
  return [
    "full_injected",
    "node_injected",
    "catalog_summary",
    "referenced_from_injected",
    "on_demand",
    "opening_genesis",
    "play_control",
    "unused_control",
    "player_view",
    "removed",
  ].includes(String(value));
}

function validPromptPreview(value: unknown): value is PromptPreview {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["diagnosticBinding", "compilation", "leakage"],
      ["initialAppend", "playPreset"],
    ) &&
    validDiagnosticBinding(value.diagnosticBinding) &&
    validPromptCompilation(value.compilation) &&
    (value.initialAppend === undefined ||
      validInitialAppend(value.initialAppend)) &&
    (value.playPreset === undefined ||
      validPlayPresetPreview(value.playPreset)) &&
    isRecord(value.leakage) &&
    hasExactKeys(value.leakage, ["status", "checkedFields"]) &&
    value.leakage.status === "clean" &&
    validStringArray(value.leakage.checkedFields)
  );
}

function validDiagnosticBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["endpoint", "commit", "hostPresetId", "controlFingerprint", "modelId"],
      ["playPresetId", "playPresetRevision"],
    ) &&
    typeof value.endpoint === "string" &&
    typeof value.commit === "string" &&
    typeof value.hostPresetId === "string" &&
    typeof value.controlFingerprint === "string" &&
    typeof value.modelId === "string" &&
    (value.playPresetId === undefined ||
      typeof value.playPresetId === "string") &&
    (value.playPresetRevision === undefined ||
      typeof value.playPresetRevision === "string")
  );
}

function validInitialAppend(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["logical", "provider"], ["beforePlayer"]) &&
    (value.beforePlayer === undefined ||
      (isRecord(value.beforePlayer) &&
        hasExactKeys(value.beforePlayer, ["logical", "provider"]) &&
        validLegacyModelItem(value.beforePlayer.logical) &&
        isRecord(value.beforePlayer.provider) &&
        hasExactKeys(value.beforePlayer.provider, ["role", "content"]) &&
        value.beforePlayer.provider.role === "user" &&
        typeof value.beforePlayer.provider.content === "string")) &&
    isRecord(value.logical) &&
    hasExactKeys(value.logical, ["kind", "text"]) &&
    value.logical.kind === "player" &&
    typeof value.logical.text === "string" &&
    isRecord(value.provider) &&
    hasExactKeys(value.provider, ["role", "content"]) &&
    value.provider.role === "user" &&
    typeof value.provider.content === "string"
  );
}

function validPlayPresetPreview(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "name",
      "revision",
      "callChainPath",
      "mounts",
      "extensionRefs",
      "toolUniverse",
      "toolStrategy",
      "bootstrap",
      "followups",
      "cache",
    ]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.revision === "string" &&
    typeof value.callChainPath === "string" &&
    Array.isArray(value.mounts) &&
    value.mounts.every(validPlayPresetMount) &&
    validStringArray(value.extensionRefs) &&
    validPromptTools(value.toolUniverse) &&
    validToolStrategy(value.toolStrategy) &&
    validPromptCompilation(value.bootstrap) &&
    Array.isArray(value.followups) &&
    value.followups.every(validPlayFollowup) &&
    isRecord(value.cache) &&
    hasExactKeys(value.cache, [
      "stablePrefixFingerprint",
      "toolDefinitionBoundary",
    ]) &&
    typeof value.cache.stablePrefixFingerprint === "string" &&
    value.cache.toolDefinitionBoundary === "stable"
  );
}

function validPlayPresetMount(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["channel", "mount"]) &&
    typeof value.channel === "string" &&
    [
      "story",
      "sidebar",
      "composer_above",
      "composer_below",
      "overlay",
      "debug",
    ].includes(String(value.mount))
  );
}

function validPlayFollowup(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "displayName",
      "logicalMessages",
      "tools",
      "allowedTools",
      "artifacts",
      "maxArtifactBytes",
    ]) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    validLogicalMessages(value.logicalMessages) &&
    validPromptTools(value.tools) &&
    validStringArray(value.allowedTools) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(validPlayArtifact) &&
    validCount(value.maxArtifactBytes)
  );
}

function validPlayArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "name",
        "channel",
        "strategy",
        "contentType",
        "save",
        "invalidation",
        "required",
        "maxEmits",
      ],
      [
        "key",
        "renderer",
        "rendererRevision",
        "rendererMode",
        "regex",
        "scripts",
        "assets",
        "payloadContract",
      ],
    ) &&
    typeof value.name === "string" &&
    typeof value.channel === "string" &&
    ["append", "replace", "upsert", "transient", "hidden"].includes(
      String(value.strategy),
    ) &&
    ["text/plain", "text/markdown", "application/json", "text/html"].includes(
      String(value.contentType),
    ) &&
    (value.key === undefined || typeof value.key === "string") &&
    (value.renderer === undefined || typeof value.renderer === "string") &&
    (value.rendererRevision === undefined ||
      typeof value.rendererRevision === "string") &&
    (value.rendererMode === undefined ||
      value.rendererMode === "document" ||
      value.rendererMode === "app") &&
    (value.regex === undefined || typeof value.regex === "string") &&
    (value.scripts === undefined || validStringArray(value.scripts)) &&
    (value.assets === undefined || validStringArray(value.assets)) &&
    ["none", "operation", "commit"].includes(String(value.save)) &&
    [
      "new_operation",
      "head_change",
      "operation_end",
      "explicit_clear",
      "never",
    ].includes(String(value.invalidation)) &&
    typeof value.required === "boolean" &&
    validCount(value.maxEmits) &&
    (value.payloadContract === undefined ||
      validArtifactPayloadContract(value.payloadContract))
  );
}

function validArtifactPayloadContract(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["type"],
      [
        "properties",
        "required",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "uniqueBy",
        "maxBytes",
      ],
    ) ||
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(String(value.type)) ||
    (value.required !== undefined && !validStringArray(value.required)) ||
    (value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== "boolean") ||
    (value.items !== undefined && !validArtifactPayloadContract(value.items)) ||
    (value.uniqueBy !== undefined && typeof value.uniqueBy !== "string")
  )
    return false;
  for (const key of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "maxBytes",
  ])
    if (value[key] !== undefined && !validCount(value[key])) return false;
  if (value.properties === undefined) return true;
  return (
    isRecord(value.properties) &&
    Object.values(value.properties).every(validArtifactPayloadContract)
  );
}

function validPromptCompilation(value: unknown): value is PromptCompilation {
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
    validPromptProvider(value.provider) &&
    validPromptTools(value.tools) &&
    validPromptTools(value.toolUniverse) &&
    validToolStrategy(value.toolStrategy) &&
    Array.isArray(value.coverage) &&
    value.coverage.every(validPromptCoverage) &&
    validPromptBudget(value.budget) &&
    validPromptCache(value.cache)
  );
}

function validLogicalMessages(value: unknown): boolean {
  return Array.isArray(value) && value.every(validLogicalMessage);
}

function validLogicalMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "markdown", "blocks"]) &&
    [
      "runtime_system",
      "author_instruction",
      "world_context",
      "player_input",
      "assistant",
      "tool",
    ].includes(String(value.role)) &&
    typeof value.markdown === "string" &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) =>
        isRecord(block) &&
        hasExactKeys(block, ["source", "markdown"]) &&
        typeof block.source === "string" &&
        typeof block.markdown === "string",
    )
  );
}

function validPromptProvider(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["protocol", "messages"], ["system"]) &&
    validProviderKind(value.protocol) &&
    (value.system === undefined ||
      (Array.isArray(value.system) && value.system.every(validSystemBlock))) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        hasExactKeys(message, ["role", "content"]) &&
        (message.role === "system" || message.role === "user") &&
        Object.hasOwn(message, "content"),
    )
  );
}

function validSystemBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "text"], ["cache_control"]) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    (value.cache_control === undefined ||
      (isRecord(value.cache_control) &&
        hasExactKeys(value.cache_control, ["type"]) &&
        value.cache_control.type === "ephemeral"))
  );
}

function validPromptTools(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        hasExactKeys(tool, ["name", "description", "inputSchema"]) &&
        typeof tool.name === "string" &&
        typeof tool.description === "string" &&
        isRecord(tool.inputSchema),
    )
  );
}

function validPromptCoverage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["slot", "source", "status", "complete", "continuation"],
      ["readAuthorization", "catalogEntries"],
    ) &&
    typeof value.slot === "string" &&
    typeof value.source === "string" &&
    ["resolved", "optional_missing", "paged_catalog"].includes(
      String(value.status),
    ) &&
    typeof value.complete === "boolean" &&
    (value.continuation === null || typeof value.continuation === "string") &&
    (value.readAuthorization === undefined ||
      validPromptReadAuthorization(value.readAuthorization)) &&
    (value.catalogEntries === undefined ||
      validStringArray(value.catalogEntries))
  );
}

function validPromptReadAuthorization(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["shortRef", "locator"]) ||
    typeof value.shortRef !== "string"
  )
    return false;
  if (value.locator === null) return true;
  if (!isRecord(value.locator)) return false;
  if (hasExactKeys(value.locator, ["yaml"]))
    return (
      Array.isArray(value.locator.yaml) &&
      value.locator.yaml.every(
        (part) => typeof part === "string" || validFiniteNumber(part),
      )
    );
  return (
    hasExactKeys(value.locator, ["markdown"]) &&
    validStringArray(value.locator.markdown)
  );
}

function validPromptBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "estimator",
      "messageTokens",
      "toolTokens",
      "outputReserveTokens",
      "forcedTailReserveTokens",
      "safetyMarginTokens",
      "requiredTokens",
      "contextWindowTokens",
      "status",
    ]) &&
    (value.estimator === "conservative_utf8_bytes" ||
      value.estimator === "disabled") &&
    [
      value.messageTokens,
      value.toolTokens,
      value.outputReserveTokens,
      value.forcedTailReserveTokens,
      value.safetyMarginTokens,
      value.requiredTokens,
      value.contextWindowTokens,
    ].every(validCount) &&
    ["fits", "over_budget", "not_checked"].includes(String(value.status))
  );
}

function validPromptCache(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "strategy",
      "stablePrefixFingerprint",
      "breakpoints",
      "estimatedCacheableBytes",
      "firstDynamicByte",
    ]) &&
    validCacheStrategy(value.strategy) &&
    typeof value.stablePrefixFingerprint === "string" &&
    Array.isArray(value.breakpoints) &&
    value.breakpoints.every((role) =>
      [
        "runtime_system",
        "author_instruction",
        "world_context",
        "player_input",
        "assistant",
        "tool",
      ].includes(String(role)),
    ) &&
    validCount(value.estimatedCacheableBytes) &&
    validCount(value.firstDynamicByte)
  );
}

function validModelBinding(value: unknown): value is ModelHostBinding {
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
    validProviderKind(value.provider) &&
    typeof value.endpointFingerprint === "string" &&
    typeof value.modelId === "string" &&
    validCount(value.contextWindowTokens) &&
    validCount(value.maxOutputTokens) &&
    typeof value.protocolConfigFingerprint === "string" &&
    (value.cacheStrategy === undefined ||
      validCacheStrategy(value.cacheStrategy))
  );
}

function validProviderKind(value: unknown): boolean {
  return (
    value === "chat_completions" ||
    value === "openai_responses" ||
    value === "anthropic_messages"
  );
}

function validCacheStrategy(value: unknown): boolean {
  return (
    value === "explicit_anthropic_blocks" ||
    value === "explicit_cliproxyapi_message" ||
    value === "provider_managed"
  );
}

function validToolStrategy(value: unknown): boolean {
  return value === "native_allowed_subset" || value === "runtime_gate";
}

function validModelToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "name", "arguments"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Object.hasOwn(value, "arguments")
  );
}

function validProviderState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.protocol === "chat_completions")
    return (
      hasExactKeys(value, ["protocol", "assistantMessage"]) &&
      Object.hasOwn(value, "assistantMessage")
    );
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

function validModelUsage(value: unknown): value is ModelUsage {
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
    !fields.every((field) => validNullableCount(value[field])) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, fields)
  )
    return false;
  const provenance = value.provenance;
  return fields.every((field) =>
    ["provider", "unavailable", "derived_provider_fields"].includes(
      String(provenance[field]),
    ),
  );
}

function validLegacyApplyRequest(
  value: unknown,
): value is LegacySettingApplyRequest {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ["expectedDraftVersion", "draftFingerprint"]) &&
      validCount(value.expectedDraftVersion) &&
      typeof value.draftFingerprint === "string")
  );
}

function validNullableCount(value: unknown): boolean {
  return value === null || validCount(value);
}

function validFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
      validStringArray(value.readWorldDocumentIds) &&
      validStringArray(value.readableDamagedWorldPaths) &&
      validStringArray(value.readOpaquePaths))
  );
}

function validPendingSettlement(
  value: unknown,
): value is StoredSettingPendingSettlement | null {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !validCount(value.assistantItemIndex) ||
    typeof value.beforeFingerprint !== "string"
  )
    return false;
  if (value.phase === "response_confirmed")
    return hasExactKeys(value, [
      "phase",
      "assistantItemIndex",
      "beforeFingerprint",
    ]);
  return (
    value.phase === "publication_prepared" &&
    hasExactKeys(value, [
      "phase",
      "assistantItemIndex",
      "beforeFingerprint",
      "afterFingerprint",
      "toolResults",
      "authorization",
    ]) &&
    typeof value.afterFingerprint === "string" &&
    Array.isArray(value.toolResults) &&
    value.toolResults.every(validToolResult) &&
    validAuthorization(value.authorization) &&
    value.authorization !== null
  );
}

function validPendingSettlementForTranscript(
  pending: unknown,
  modelItems: unknown,
  runStatus: unknown,
): boolean {
  if (pending === null) return true;
  if (
    !validPendingSettlement(pending) ||
    !Array.isArray(modelItems) ||
    runStatus === "ready" ||
    pending.assistantItemIndex !== modelItems.length - 1
  )
    return false;
  const assistant: unknown = modelItems[pending.assistantItemIndex];
  if (
    !isRecord(assistant) ||
    assistant.kind !== "assistant" ||
    !Array.isArray(assistant.toolCalls) ||
    assistant.toolCalls.length === 0 ||
    assistant.providerState === undefined ||
    !assistant.toolCalls.every(validModelToolCall)
  )
    return false;
  const callIds = assistant.toolCalls.map((call) =>
    isRecord(call) ? call.id : undefined,
  );
  if (new Set(callIds).size !== callIds.length) return false;
  if (pending.phase === "response_confirmed") return true;
  return (
    pending.authorization.revision === pending.afterFingerprint &&
    pending.toolResults.length === callIds.length &&
    pending.toolResults.every(
      (result, index) => result.toolCallId === callIds[index],
    )
  );
}

function validLegacyDraft(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ["outcome", "changes"]) &&
      (value.outcome === "applied" ||
        value.outcome === "discarded" ||
        value.outcome === "unapplied_dropped" ||
        value.outcome === "apply_outcome_unknown") &&
      Array.isArray(value.changes) &&
      value.changes.every(validDiff))
  );
}

function validToolResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["toolCallId", "markdown", "isError", "changes"]) &&
    typeof value.toolCallId === "string" &&
    typeof value.markdown === "string" &&
    typeof value.isError === "boolean" &&
    Array.isArray(value.changes) &&
    value.changes.every(validDiff)
  );
}

function validDiff(value: unknown): value is SettingAuthoringDiff {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["path", "kind", "before", "after"]) &&
    typeof value.path === "string" &&
    (value.kind === "create" ||
      value.kind === "modify" ||
      value.kind === "delete") &&
    (value.before === null || typeof value.before === "string") &&
    (value.after === null || typeof value.after === "string")
  );
}

function validStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

async function publishJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

async function publishImmutableSource(
  path: string,
  contents: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== contents)
        throw new Error(
          "Legacy setting-improvement migration source does not match its preserved copy",
          { cause: error },
        );
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
