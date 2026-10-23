import { WorldExtensionRequests } from "../extension/WorldExtensionRequests.ts";
import {
  isWorldExtensionControl,
  type WorldExtensionControl,
} from "../../protocol/worldExtensions.ts";
import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { worldQueueFor } from "../world/WorldQueue.ts";

import {
  validatePlayPresetArtifactPayload,
  type FrozenArtifactPresentation,
  type PlayPresetArtifactDeclaration,
  type PlayPresetArtifactStrategy,
} from "../play/FileNativePlayPresetStore.ts";
import {
  ArtifactStoreCorruptionError,
  ArtifactStoreInvariantError,
  artifactSequenceFileName,
  assertOperation,
  assertRawRecord,
  hasExactKeys,
  identityHash,
  isJsonValue,
  isMissing,
  isRecord,
  parseArtifactJson,
  payloadFingerprint,
  rawRecordFingerprint,
  stableSerialize,
  validAttachment,
  headOrdinal,
  writeArtifactJson,
  type ArtifactOperationFile,
  type ArtifactRawRecord,
} from "./ArtifactStoreFiles.ts";
import {
  hasLegacyArtifactState,
  migrateLegacyArtifactStore,
} from "./LegacyArtifactStoreMigration.ts";

export { ArtifactStoreCorruptionError, ArtifactStoreInvariantError };

export type ArtifactPayload =
  | string
  | number
  | boolean
  | null
  | ArtifactPayload[]
  | { [key: string]: ArtifactPayload };

export type ArtifactRecordStatus =
  "pending" | "active" | "superseded" | "cleared";

export type ArtifactExtensionStatus =
  | "not_started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "unknown"
  | "recovery_required"
  | "superseded";

export interface ArtifactReplyTarget {
  head: string;
  contextId: string;
  eventId: number;
}

export interface ArtifactAttachment extends ArtifactReplyTarget {
  runId: string;
}

export interface ArtifactOperationContext {
  attachment?: ArtifactAttachment;
  worldId: string;
  parentHead: string;
  operationId: string;
  playPresetId: string;
  playPresetRevision: string;
  /** Frozen local renderer execution policy. */
  playPresetScriptsEnabled: boolean;
}

export interface ArtifactRequestContext extends ArtifactOperationContext {
  extensionControl?: WorldExtensionControl;
  displayName?: string;
  frozenPresentations?: Record<string, FrozenArtifactPresentation>;
  frozenResources?: Omit<FrozenArtifactPresentation, "declaration">;
  requestId: string;
  requestAttempt: number;
  maxArtifactBytes: number;
  declarations: PlayPresetArtifactDeclaration[];
}

export interface ArtifactEmitInput {
  context: ArtifactRequestContext;
  output: string;
  payload: unknown;
  toolCallId: string;
}

export interface ArtifactClearInput {
  context: ArtifactRequestContext;
  output: string;
  toolCallId: string;
}

export interface ArtifactToolResult {
  ok: boolean;
  markdown: string;
  recordId?: string;
  idempotent?: boolean;
}

export interface ArtifactProjectionItem {
  extensionControl?: WorldExtensionControl;
  attachment?: ArtifactAttachment;
  frozenPresentation?: FrozenArtifactPresentation;
  recordId: string;
  worldId: string;
  operationId: string;
  playPresetId: string;
  playPresetRevision: string;
  playPresetScriptsEnabled: boolean;
  requestId: string;
  requestAttempt: number;
  output: string;
  channel: string;
  key?: string;
  contentType: PlayPresetArtifactDeclaration["contentType"];
  renderer?: string;
  rendererRevision?: string;
  payload: ArtifactPayload;
  projection: PlayPresetArtifactStrategy;
  save: PlayPresetArtifactDeclaration["save"];
  sequence: number;
  head: string;
}

export interface ArtifactDebugRecord {
  extensionControl?: WorldExtensionControl;
  attachment?: ArtifactAttachment;
  frozenPresentation?: FrozenArtifactPresentation;
  recordId: string;
  sequence: number;
  operationId: string;
  worldId: string;
  playPresetId: string;
  playPresetRevision: string;
  playPresetScriptsEnabled: boolean;
  parentHead: string;
  newHead: string | null;
  requestId: string;
  requestAttempt: number;
  output: string;
  channel: string;
  key?: string;
  contentType: PlayPresetArtifactDeclaration["contentType"];
  renderer?: string;
  rendererRevision?: string;
  save: PlayPresetArtifactDeclaration["save"];
  projection: PlayPresetArtifactStrategy;
  payloadBytes: number;
  payload: ArtifactPayload;
  payloadFingerprint: string;
  status: ArtifactRecordStatus;
}

export interface ArtifactRequestProgress {
  requestId: string;
  displayName: string;
  mounts: string[];
  status: "running" | "completed" | "failed";
}

export interface ArtifactExtensionSummary {
  attachment?: ArtifactAttachment;
  requests?: ArtifactRequestProgress[];
  operationId: string;
  status: ArtifactExtensionStatus;
  message?: string;
  completedRequests: string[];
  /** Safe world-facing proof that the Authority core receipt was accepted. */
  coreCommitted: boolean;
  head?: string;
}

export interface ArtifactStore {
  finishRequest?(
    context: ArtifactRequestContext,
    failed: boolean,
  ): Promise<void>;
  beginOperation(context: ArtifactOperationContext): Promise<void>;
  /** Register the current monotonic attempt for one follow-up request. */
  beginRequestAttempt(context: ArtifactRequestContext): Promise<void>;
  /** Physically discard artifact state bound to heads after a rewind. */
  discardAfterHead(worldId: string, restoredHead: string): Promise<void>;
  /** Reconcile head-bound projections without exposing raw record mechanics. */
  reconcileHead(
    worldId: string,
    head: string,
    exceptOperationId?: string,
  ): Promise<void>;
  emit(input: ArtifactEmitInput): Promise<ArtifactToolResult>;
  clear(input: ArtifactClearInput): Promise<ArtifactToolResult>;
  markCoreCommitted(
    context: ArtifactOperationContext,
    head: string,
  ): Promise<void>;
  markCoreFailed(
    worldId: string,
    operationId: string,
    message?: string,
  ): Promise<void>;
  beginExtension(context: ArtifactOperationContext): Promise<void>;
  completeExtension(
    worldId: string,
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary>;
  failExtension(
    worldId: string,
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests?: string[],
  ): Promise<ArtifactExtensionSummary>;
  readExtension(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactExtensionSummary | null>;
  /** Read persisted extension lifecycle summaries without raw/provider data. */
  readExtensionSummaries(worldId: string): Promise<ArtifactExtensionSummary[]>;
  resumeExtension(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactExtensionSummary>;
  readActiveProjection(
    worldId: string,
    channel?: string,
    timeline?: readonly ArtifactReplyTarget[],
  ): Promise<ArtifactProjectionItem[]>;
  readDebug(
    worldId: string,
    operationId?: string,
  ): Promise<ArtifactDebugRecord[]>;
}

const maxPayloadBytes = 4 * 1024 * 1024;

/**
 * File-native artifact module. Artifacts live in the world directory as
 * `artifacts/records/<sequence>.json` and `artifacts/operations/<hash>.json`.
 * A record carries its own status and head and is updated in place; there is
 * no event log. Forks and archives copy the world directory and then rewrite
 * identities with {@link forkArtifactClosure}.
 */
export class FileNativeArtifactStore implements ArtifactStore {
  readonly #dataRoot: string;
  readonly #worldsRoot: string;
  readonly #extensionControls: WorldExtensionRequests;
  /**
   * Records with `save: "none"` are never written to disk. Superseded ones are
   * dropped at once, cleared ones once their clearing operation closes.
   */
  readonly #memoryRecords = new Map<string, ArtifactRawRecord[]>();
  /** Highest sequence handed out per world in this process, so removals never reuse one. */
  readonly #sequenceHighWater = new Map<string, number>();
  readonly #mutationContext = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(dataRoot: string) {
    this.#dataRoot = resolve(dataRoot);
    this.#worldsRoot = join(this.#dataRoot, "worlds-file-native");
    this.#extensionControls = new WorldExtensionRequests(this.#worldsRoot);
  }

  /** Control acceptance and artifact publication share the in-process world queue. */
  static withWorldControlsMutation<T>(
    dataRoot: string,
    worldId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return worldQueueFor(resolve(dataRoot)).run(worldId, action);
  }

  async finishRequest(
    context: ArtifactRequestContext,
    failed: boolean,
  ): Promise<void> {
    await this.#withWorldMutation(context.worldId, async () => {
      const operation = await this.#readOperation(
        context.worldId,
        context.operationId,
      );
      if (
        operation?.requestAttempts[context.requestId] !== context.requestAttempt
      )
        return;
      await this.#writeOperation({
        ...operation,
        requests: (operation.requests ?? []).map((item) =>
          item.requestId === context.requestId
            ? { ...item, status: failed ? "failed" : "completed" }
            : item,
        ),
      });
    });
  }

  async beginOperation(context: ArtifactOperationContext): Promise<void> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#beginOperation(context),
    );
  }

  async #beginOperation(context: ArtifactOperationContext): Promise<void> {
    assertContext(context);
    const existing = await this.#readOperation(
      context.worldId,
      context.operationId,
    );
    if (existing !== null && !sameContext(existing.context, context))
      throw new ArtifactStoreInvariantError(
        "Artifact operation is bound to a different frozen payload",
      );
    // A direct orchestrator/store caller must not rely on a later UI read to
    // invalidate artifacts bound to the parent head.
    await this.#reconcileHead(
      context.worldId,
      context.parentHead,
      context.operationId,
    );
    const priorOperations = await this.#operationsForWorld(context.worldId);
    if (existing === null)
      await this.#writeOperation({
        schemaVersion: 1,
        context: normalizeOperationContext(context),
        status: "running",
        extensionStatus: "not_started",
        completedRequests: [],
        artifactProjectionStatus: "active",
        requestAttempts: {},
      });

    // An open extension is superseded even when it has not emitted anything
    // yet; its execution status is kept unless it is actually open.
    const records = await this.#records(context.worldId);
    for (const priorOperation of priorOperations) {
      if (priorOperation.context.operationId === context.operationId) continue;
      const openExtension = isOpenExtension(priorOperation);
      const operationAlreadySuperseded =
        priorOperation.artifactProjectionStatus === "superseded";
      for (const record of records) {
        if (
          record.operationId !== priorOperation.context.operationId ||
          record.status !== "active"
        )
          continue;
        if (!(
          openExtension ||
          operationAlreadySuperseded ||
          record.invalidation === "new_operation"
        ))
          continue;
        await this.#putRecord({ ...record, status: "superseded" });
      }
      if (openExtension) {
        const next: ArtifactOperationFile = {
          ...priorOperation,
          artifactProjectionStatus: "superseded",
          extensionStatus: "superseded",
          message: "This extension was superseded by a newer operation",
        };
        await this.#writeOperation(next);
      }
    }
  }

  async beginRequestAttempt(context: ArtifactRequestContext): Promise<void> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#beginRequestAttempt(context),
    );
  }

  async #beginRequestAttempt(context: ArtifactRequestContext): Promise<void> {
    assertRequestContext(context);
    const operation = await this.#readOperation(
      context.worldId,
      context.operationId,
    );
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "Artifact request attempt is missing an operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "Artifact request attempt does not match the frozen operation",
      );
    if (isClosedOperation(operation)) return;

    const mounts = [
      ...new Set(
        Object.values(context.frozenPresentations ?? {})
          .map((item) => item.mount)
          .concat(
            context.frozenResources?.mount === undefined
              ? []
              : [context.frozenResources.mount],
          ),
      ),
    ];
    const requests = [
      ...(operation.requests ?? []).filter(
        (item) => item.requestId !== context.requestId,
      ),
      {
        requestId: context.requestId,
        displayName: context.displayName ?? context.requestId,
        mounts,
        status: "running" as const,
      },
    ];
    const current = operation.requestAttempts[context.requestId];
    if (current !== undefined && context.requestAttempt < current) return;

    if (current === undefined || context.requestAttempt > current)
      await this.#writeOperation({
        ...operation,
        requests,
        requestAttempts: {
          ...operation.requestAttempts,
          [context.requestId]: context.requestAttempt,
        },
      });

    // A clear made by an earlier attempt of this request is rolled back: that
    // attempt did not finish, and its retry decides again.
    const records = await this.#records(context.worldId);
    for (const record of records) {
      if (
        record.status === "cleared" &&
        record.clearedBy?.operationId === context.operationId &&
        record.clearedBy.requestId === context.requestId &&
        record.clearedBy.requestAttempt < context.requestAttempt
      ) {
        await this.#putRecord({
          ...record,
          status: record.clearedBy.priorStatus,
        });
      }
    }
    for (const record of records) {
      if (
        record.operationId !== context.operationId ||
        record.requestId !== context.requestId ||
        record.requestAttempt >= context.requestAttempt ||
        record.status === "superseded"
      )
        continue;
      await this.#putRecord({ ...record, status: "superseded" });
    }
  }

  /**
   * Remove the operations and records whose head is after restoredHead. A
   * rewind discards those rounds, and their replies, attachments and extension
   * results must not survive on disk (ADR-0045). Each artifact is one file, so
   * the discard deletes files.
   */
  async discardAfterHead(worldId: string, restoredHead: string): Promise<void> {
    return this.#withWorldMutation(worldId, () =>
      this.#discardAfterHead(worldId, restoredHead),
    );
  }

  async #discardAfterHead(
    worldId: string,
    restoredHead: string,
  ): Promise<void> {
    const limit = headOrdinal(restoredHead);
    const operations = await this.#operationsForWorld(worldId);
    const discardedOperations = new Set(
      operations
        .filter(
          (operation) =>
            headOrdinal(operation.head ?? operation.context.parentHead) > limit,
        )
        .map(({ context }) => context.operationId),
    );
    for (const record of await this.#records(worldId)) {
      if (
        !discardedOperations.has(record.operationId) &&
        headOrdinal(record.head ?? record.parentHead) <= limit
      )
        continue;
      await this.#removeRecord(record);
    }
    for (const operationId of discardedOperations) {
      await rm(this.#operationPath(worldId, operationId), { force: true });
      this.#memoryRecords.delete(operationId);
    }
  }

  async reconcileHead(
    worldId: string,
    head: string,
    exceptOperationId?: string,
  ): Promise<void> {
    return this.#withWorldMutation(worldId, () =>
      this.#reconcileHead(worldId, head, exceptOperationId),
    );
  }

  async #reconcileHead(
    worldId: string,
    head: string,
    exceptOperationId?: string,
  ): Promise<void> {
    if (worldId.trim() === "" || head.trim() === "")
      throw new ArtifactStoreInvariantError(
        "Artifact head-reconciliation arguments are invalid",
      );
    const operations = await this.#operationsForWorld(worldId);
    const records = await this.#records(worldId);
    const affected = new Set<string>();
    for (const record of records) {
      if (
        record.operationId === exceptOperationId ||
        record.status !== "active"
      )
        continue;
      if (record.invalidation !== "head_change") continue;
      if ((record.head ?? record.parentHead) === head) continue;
      await this.#putRecord({ ...record, status: "superseded" });
      affected.add(record.operationId);
    }
    for (const operation of operations) {
      const operationId = operation.context.operationId;
      if (operationId === exceptOperationId) continue;
      const boundHead = operation.head ?? operation.context.parentHead;
      if (boundHead === head) continue;
      const hasActiveHeadBoundRecord = records.some(
        (record) =>
          record.operationId === operationId &&
          record.status === "active" &&
          record.invalidation === "head_change" &&
          (record.head ?? record.parentHead) !== head,
      );
      if (!hasActiveHeadBoundRecord && !isOpenProjectionOperation(operation))
        continue;
      affected.add(operationId);
    }
    for (const operation of operations) {
      if (!affected.has(operation.context.operationId)) continue;
      if (!isOpenProjectionOperation(operation)) continue;
      const next: ArtifactOperationFile = {
        ...operation,
        artifactProjectionStatus: "superseded",
        ...(isOpenExtension(operation)
          ? {
              extensionStatus: "superseded" as const,
              message: "This extension was superseded by a newer head",
            }
          : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(operation))
        await this.#writeOperation(next);
    }
  }

  async emit(input: ArtifactEmitInput): Promise<ArtifactToolResult> {
    return this.#withWorldMutation(input.context.worldId, () =>
      this.#emit(input),
    );
  }

  async #emit(input: ArtifactEmitInput): Promise<ArtifactToolResult> {
    assertRequestContext(input.context);
    const declaration = findDeclaration(input.context, input.output);
    if (declaration === null)
      return artifactFailure(`Undeclared artifact output: ${input.output}`);
    const payload = normalizePayload(declaration, input.payload);
    if (!payload.ok) return artifactFailure(payload.message);
    if (input.toolCallId.trim() === "")
      return artifactFailure("Tool-call ID cannot be empty");
    const operation = await this.#readOperation(
      input.context.worldId,
      input.context.operationId,
    );
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "Artifact emit is missing an operation checkpoint",
      );
    if (!sameContext(operation.context, input.context))
      throw new ArtifactStoreInvariantError(
        "Artifact emit does not match the frozen operation",
      );
    const currentAttempt = operation.requestAttempts[input.context.requestId];
    if (currentAttempt === undefined)
      throw new ArtifactStoreInvariantError(
        "Artifact emit request attempt is not registered",
      );
    const fingerprint = payloadFingerprint(input.output, payload.value);
    const callFingerprint = artifactCallFingerprint(
      "artifact_emit",
      input.context,
      { output: declaration.name, payload: payload.value },
    );
    const prior = await this.#recordsForOperation(
      input.context.worldId,
      input.context.operationId,
    );
    // A tool-call ID is an identity only within one operation. A cold retry
    // re-calls the model and gets new IDs (ADR-0044), so no wider ledger exists.
    const previousByCall = prior.find(
      (record) => record.toolCallId === input.toolCallId,
    );
    if (previousByCall !== undefined) {
      if (previousByCall.callFingerprint !== callFingerprint)
        return artifactFailure(
          "The same artifact tool-call ID is bound to different arguments",
        );
      return {
        ok: true,
        idempotent: true,
        recordId: previousByCall.recordId,
        markdown: `# Runtime artifact already exists\n\noutput=${input.output}`,
      };
    }
    const staleAttempt = currentAttempt !== input.context.requestAttempt;
    const sameOutput = prior.filter(
      (record) =>
        record.requestId === input.context.requestId &&
        record.requestAttempt === input.context.requestAttempt &&
        record.output === input.output,
    );
    if (sameOutput.length >= declaration.maxEmits)
      return artifactFailure(`Artifact ${input.output} has reached maxEmits`);
    const payloadBytes = byteLength(payload.value, declaration.contentType);
    if (payloadBytes > maxPayloadBytes)
      return artifactFailure("Artifact exceeds the 4 MiB limit");
    const totalBytes = prior
      .filter(
        (record) =>
          record.requestId === input.context.requestId &&
          record.requestAttempt === input.context.requestAttempt,
      )
      .reduce(
        (total, record) =>
          total + byteLength(record.payload, record.contentType),
        0,
      );
    if (totalBytes + payloadBytes > input.context.maxArtifactBytes)
      return artifactFailure(
        "Follow-up request artifacts exceed maxArtifactBytes",
      );
    const sequence = await this.#nextSequence(input.context.worldId);
    const base = newRecord(input, declaration, payload.value, {
      sequence,
      fingerprint,
      callFingerprint,
    });
    const stale =
      isStaleOperation(operation) ||
      staleAttempt ||
      !(await this.#extensionControls.visible(base.worldId, base));
    const committed =
      !stale &&
      operation.status === "core_committed" &&
      operation.head !== undefined;
    // A stale result is kept as superseded. A live result is active when its
    // core committed or when it does not wait for the core; a commit-saved
    // result waits as pending until markCoreCommitted binds it.
    const status: ArtifactRecordStatus = stale
      ? "superseded"
      : committed || declaration.save !== "commit"
        ? "active"
        : "pending";
    const record = {
      ...base,
      status,
      head: committed ? (operation.head ?? null) : null,
    };
    await this.#putRecord(record);
    return {
      ok: true,
      recordId: record.recordId,
      markdown: `# Runtime artifact accepted\n\noutput=${input.output}`,
    };
  }

  async clear(input: ArtifactClearInput): Promise<ArtifactToolResult> {
    return this.#withWorldMutation(input.context.worldId, () =>
      this.#clear(input),
    );
  }

  async #clear(input: ArtifactClearInput): Promise<ArtifactToolResult> {
    assertRequestContext(input.context);
    const declaration = findDeclaration(input.context, input.output);
    if (declaration === null)
      return artifactFailure(`Undeclared artifact output: ${input.output}`);
    if (input.toolCallId.trim() === "")
      return artifactFailure("Tool-call ID cannot be empty");
    const operation = await this.#readOperation(
      input.context.worldId,
      input.context.operationId,
    );
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "Artifact clear is missing an operation checkpoint",
      );
    if (!sameContext(operation.context, input.context))
      throw new ArtifactStoreInvariantError(
        "Artifact clear does not match the frozen operation",
      );
    const currentAttempt = operation.requestAttempts[input.context.requestId];
    if (currentAttempt === undefined)
      throw new ArtifactStoreInvariantError(
        "Artifact clear request attempt is not registered",
      );
    const prior = await this.#recordsForOperation(
      input.context.worldId,
      input.context.operationId,
    );
    if (prior.some((record) => record.toolCallId === input.toolCallId))
      return artifactFailure(
        "The same artifact tool-call ID is bound to a different tool call",
      );
    const staleAttempt = currentAttempt !== input.context.requestAttempt;
    if (
      isStaleOperation(operation) ||
      staleAttempt ||
      !(await this.#extensionControls.visible(
        input.context.worldId,
        input.context,
      ))
    )
      return {
        ok: true,
        markdown: `# Runtime artifact clear ignored\n\noutput=${input.output}`,
      };
    // Projection clears are durable even for save:none records. Only the raw
    // payload is ephemeral, so a cold restart cannot resurrect an old panel.
    for (const record of await this.#records(input.context.worldId)) {
      if (
        record.status === "superseded" ||
        record.status === "cleared" ||
        record.channel !== declaration.channel ||
        record.output !== declaration.name ||
        (declaration.key !== undefined && record.key !== declaration.key)
      )
        continue;
      await this.#putRecord({
        ...record,
        status: "cleared",
        clearedBy: {
          operationId: input.context.operationId,
          requestId: input.context.requestId,
          requestAttempt: input.context.requestAttempt,
          priorStatus: record.status,
        },
      });
    }
    return {
      ok: true,
      markdown: `# Runtime artifact clear confirmed\n\noutput=${input.output}`,
    };
  }

  async markCoreCommitted(
    context: ArtifactOperationContext,
    head: string,
  ): Promise<void> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#markCoreCommitted(context, head),
    );
  }

  async #markCoreCommitted(
    context: ArtifactOperationContext,
    head: string,
  ): Promise<void> {
    assertContext(context);
    if (head.trim() === "")
      throw new ArtifactStoreInvariantError("Core commit head is invalid");
    const operation = await this.#readOperation(
      context.worldId,
      context.operationId,
    );
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "Core commit is missing an artifact-operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "Artifact operation is bound to a different frozen payload",
      );
    if (operation.status === "completed") {
      if (operation.head !== head)
        throw new ArtifactStoreInvariantError(
          "Completed artifact operation has a conflicting core head",
        );
      return;
    }
    if (operation.status === "core_failed")
      throw new ArtifactStoreInvariantError(
        "An artifact operation whose core failed cannot be committed again",
      );
    if (operation.status === "core_committed") {
      if (operation.head !== head)
        throw new ArtifactStoreInvariantError(
          "Committed artifact operation has a conflicting core head",
        );
      await this.#activateCommittedRecords(operation, head);
      return;
    }
    await this.#reconcileHead(context.worldId, head, context.operationId);
    const committed: ArtifactOperationFile = {
      ...operation,
      status: "core_committed",
      head,
    };
    // The head is persisted before records bind to it. A crash after this
    // write is repaired by the idempotent same-head path above.
    await this.#writeOperation(committed);
    await this.#activateCommittedRecords(committed, head);
  }

  async #activateCommittedRecords(
    operation: ArtifactOperationFile,
    head: string,
  ): Promise<void> {
    if (operation.artifactProjectionStatus === "superseded") return;
    const records = await this.#recordsForOperation(
      operation.context.worldId,
      operation.context.operationId,
    );
    for (const record of records) {
      if (record.status === "superseded" || record.status === "cleared")
        continue;
      if (record.head !== null && record.head !== head)
        throw new ArtifactStoreInvariantError(
          "Artifact record is bound to a different core head",
        );
      if (record.head === head && record.status !== "pending") continue;
      await this.#putRecord({
        ...record,
        head,
        status: record.status === "pending" ? "active" : record.status,
      });
    }
  }

  async markCoreFailed(
    worldId: string,
    operationId: string,
    message?: string,
  ): Promise<void> {
    return this.#withWorldMutation(worldId, () =>
      this.#markCoreFailed(worldId, operationId, message),
    );
  }

  async #markCoreFailed(
    worldId: string,
    operationId: string,
    message?: string,
  ): Promise<void> {
    const operation = await this.#readOperation(worldId, operationId);
    if (operation === null) return;
    if (operation.status !== "running") return;
    for (const record of await this.#recordsForOperation(worldId, operationId))
      if (record.status !== "superseded")
        await this.#putRecord({ ...record, status: "superseded" });
    await this.#writeOperation({
      ...operation,
      status: "core_failed",
      extensionStatus: "failed",
      artifactProjectionStatus: "superseded",
      ...(message === undefined ? {} : { message }),
    });
  }

  async beginExtension(context: ArtifactOperationContext): Promise<void> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#beginExtension(context),
    );
  }

  async #beginExtension(context: ArtifactOperationContext): Promise<void> {
    const operation = await this.#readOperation(
      context.worldId,
      context.operationId,
    );
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "Artifact extension is missing an operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "Artifact extension does not match the frozen operation",
      );
    if (
      operation.status !== "core_committed" ||
      operation.artifactProjectionStatus === "superseded"
    )
      return;
    if (operation.extensionStatus !== "not_started") return;
    await this.#writeOperation({ ...operation, extensionStatus: "running" });
  }

  async completeExtension(
    worldId: string,
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary> {
    return this.#withWorldMutation(worldId, () =>
      this.#completeExtension(worldId, operationId, requests),
    );
  }

  async #completeExtension(
    worldId: string,
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(worldId, operationId);
    if (operation === null) return recoveryRequired(operationId, [], undefined);
    if (operation.status === "running") return summary(operation);
    if (
      isTerminalExtensionStatus(operation.extensionStatus) ||
      operation.extensionStatus === "unknown" ||
      operation.extensionStatus === "recovery_required"
    )
      return summary(operation);
    if (operation.status !== "core_committed")
      throw new ArtifactStoreInvariantError(
        "Artifact extension cannot complete before the core is committed",
      );
    await this.#endOperationRecords(worldId, operationId);
    const next: ArtifactOperationFile = {
      ...operation,
      status: "completed",
      extensionStatus: "completed",
      completedRequests: [...requests],
    };
    delete next.message;
    await this.#writeOperation(next);
    return summary(next);
  }

  async failExtension(
    worldId: string,
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests: string[] = [],
  ): Promise<ArtifactExtensionSummary> {
    return this.#withWorldMutation(worldId, () =>
      this.#failExtension(worldId, operationId, status, message, requests),
    );
  }

  async #failExtension(
    worldId: string,
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(worldId, operationId);
    if (operation === null)
      return recoveryRequired(operationId, requests, message);
    if (
      isTerminalExtensionStatus(operation.extensionStatus) ||
      operation.extensionStatus === "unknown" ||
      operation.extensionStatus === "recovery_required"
    )
      return summary(operation);
    if (operation.status !== "core_committed")
      throw new ArtifactStoreInvariantError(
        "Artifact extension cannot fail before the core is committed",
      );
    await this.#endOperationRecords(worldId, operationId);
    const next: ArtifactOperationFile = {
      ...operation,
      extensionStatus: status,
      message,
      completedRequests: [...requests],
    };
    await this.#writeOperation(next);
    return summary(next);
  }

  /** Save-none and operation-end records do not survive the extension that produced them. */
  async #endOperationRecords(
    worldId: string,
    operationId: string,
  ): Promise<void> {
    for (const record of await this.#recordsForOperation(worldId, operationId))
      if (
        (record.save === "none" || record.invalidation === "operation_end") &&
        record.status !== "superseded"
      )
        await this.#putRecord({ ...record, status: "superseded" });
  }

  async readExtension(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactExtensionSummary | null> {
    await this.#ensureReadable(worldId);
    const operation = await this.#readOperation(worldId, operationId);
    return operation === null ? null : summary(operation);
  }

  async readExtensionSummaries(
    worldId: string,
  ): Promise<ArtifactExtensionSummary[]> {
    await this.#ensureReadable(worldId);
    return (await this.#operationsForWorld(worldId))
      .filter(
        (operation) =>
          operation.status !== "core_failed" &&
          !(
            operation.status === "completed" &&
            operation.extensionStatus === "completed" &&
            operation.completedRequests.length === 0
          ),
      )
      .sort((left, right) =>
        left.context.operationId.localeCompare(right.context.operationId),
      )
      .map(summary);
  }

  async resumeExtension(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactExtensionSummary> {
    return this.#withWorldMutation(worldId, async () => {
      const operation = await this.#readOperation(worldId, operationId);
      if (operation === null)
        return {
          operationId,
          status: "recovery_required",
          completedRequests: [],
          message: "No recoverable extension checkpoint was found",
          coreCommitted: false,
        };
      if (operation.status === "running") return summary(operation);
      if (
        isTerminalExtensionStatus(operation.extensionStatus) ||
        operation.extensionStatus === "recovery_required"
      )
        return summary(operation);
      const next = {
        ...operation,
        extensionStatus: "recovery_required" as const,
        message:
          "Extension dispatch state cannot be replayed safely; the original request attempt requires explicit manual recovery",
      };
      await this.#writeOperation(next);
      return summary(next);
    });
  }

  async readActiveProjection(
    worldId: string,
    channel?: string,
    timeline?: readonly ArtifactReplyTarget[],
  ): Promise<ArtifactProjectionItem[]> {
    await this.#ensureReadable(worldId);
    const operations = new Map(
      (await this.#operationsForWorld(worldId)).map((operation) => [
        operation.context.operationId,
        operation,
      ]),
    );
    const active = (await this.#records(worldId)).filter((record) => {
      if (record.status !== "active" || record.projection === "hidden")
        return false;
      if (channel !== undefined && record.channel !== channel) return false;
      const operation = operations.get(record.operationId);
      if (
        operation === undefined ||
        operation.artifactProjectionStatus === "superseded"
      )
        return false;
      if (
        timeline !== undefined &&
        operation.context.attachment !== undefined &&
        !timeline.some(
          (target) =>
            target.contextId === operation.context.attachment?.contextId &&
            target.eventId === operation.context.attachment?.eventId &&
            target.head === operation.context.attachment?.head,
        )
      )
        return false;
      if (record.projection === "transient" && !isActiveInteraction(operation))
        return false;
      if (record.save === "operation" && operation.status === "completed")
        return false;
      if (record.save === "commit" && record.head === null) return false;
      return true;
    });
    const visible = await Promise.all(
      active.map(async (record) =>
        (await this.#extensionControls.visible(worldId, record))
          ? record
          : null,
      ),
    );
    const selected = selectProjection(visible.filter((item) => item !== null));
    return selected.map((record) => ({
      ...(operations.get(record.operationId)?.context.attachment === undefined
        ? {}
        : {
            attachment: structuredClone(
              operations.get(record.operationId)!.context.attachment!,
            ),
          }),
      recordId: record.recordId,
      worldId: record.worldId,
      operationId: record.operationId,
      playPresetId: record.playPresetId,
      playPresetRevision: record.playPresetRevision,
      playPresetScriptsEnabled: record.playPresetScriptsEnabled,
      requestId: record.requestId,
      requestAttempt: record.requestAttempt,
      output: record.output,
      channel: record.channel,
      ...(record.key === undefined ? {} : { key: record.key }),
      contentType: record.contentType,
      ...(record.renderer === undefined ? {} : { renderer: record.renderer }),
      ...(record.rendererRevision === undefined
        ? {}
        : { rendererRevision: record.rendererRevision }),
      ...(record.extensionControl === undefined
        ? {}
        : { extensionControl: structuredClone(record.extensionControl) }),
      ...(record.frozenPresentation === undefined
        ? {}
        : { frozenPresentation: structuredClone(record.frozenPresentation) }),
      payload: structuredClone(record.payload),
      projection: record.projection,
      save: record.save,
      sequence: record.sequence,
      head: record.head ?? record.parentHead,
    }));
  }

  async readDebug(
    worldId: string,
    operationId?: string,
  ): Promise<ArtifactDebugRecord[]> {
    await this.#ensureReadable(worldId);
    const operations = new Map(
      (await this.#operationsForWorld(worldId)).map((operation) => [
        operation.context.operationId,
        operation,
      ]),
    );
    return (await this.#records(worldId))
      .filter(
        (record) =>
          operationId === undefined || record.operationId === operationId,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => ({
        ...(operations.get(record.operationId)?.context.attachment === undefined
          ? {}
          : {
              attachment: structuredClone(
                operations.get(record.operationId)!.context.attachment!,
              ),
            }),
        recordId: record.recordId,
        sequence: record.sequence,
        operationId: record.operationId,
        worldId: record.worldId,
        playPresetId: record.playPresetId,
        playPresetRevision: record.playPresetRevision,
        playPresetScriptsEnabled: record.playPresetScriptsEnabled,
        parentHead: record.parentHead,
        newHead: record.head,
        requestId: record.requestId,
        requestAttempt: record.requestAttempt,
        output: record.output,
        channel: record.channel,
        ...(record.key === undefined ? {} : { key: record.key }),
        contentType: record.contentType,
        ...(record.renderer === undefined ? {} : { renderer: record.renderer }),
        ...(record.rendererRevision === undefined
          ? {}
          : { rendererRevision: record.rendererRevision }),
        save: record.save,
        projection: record.projection,
        payloadBytes: byteLength(record.payload, record.contentType),
        ...(record.extensionControl === undefined
          ? {}
          : { extensionControl: structuredClone(record.extensionControl) }),
        ...(record.frozenPresentation === undefined
          ? {}
          : { frozenPresentation: structuredClone(record.frozenPresentation) }),
        payload: structuredClone(record.payload),
        payloadFingerprint: record.payloadFingerprint,
        status: record.status,
      }));
  }

  /** Records and operations of a world, read from its directory; memory-only records are included. */
  async #records(worldId: string): Promise<ArtifactRawRecord[]> {
    const raw = [
      ...(await readRecordFiles(this.#artifactsRoot(worldId))),
      ...[...this.#memoryRecords.values()]
        .flat()
        .filter((record) => record.worldId === worldId),
    ];
    raw.sort((left, right) => left.sequence - right.sequence);
    const recordIds = new Set<string>();
    const sequences = new Set<number>();
    const operations = new Map(
      (await this.#operationsForWorld(worldId)).map((operation) => [
        operation.context.operationId,
        operation,
      ]),
    );
    for (const record of raw) {
      if (recordIds.has(record.recordId))
        throw new ArtifactStoreCorruptionError(
          "Artifact raw-record ID is duplicated",
        );
      if (sequences.has(record.sequence))
        throw new ArtifactStoreCorruptionError(
          "Artifact world sequence is duplicated",
        );
      recordIds.add(record.recordId);
      sequences.add(record.sequence);
      const operation = operations.get(record.operationId);
      if (
        operation?.context.worldId !== record.worldId ||
        operation.context.parentHead !== record.parentHead ||
        operation.context.playPresetId !== record.playPresetId ||
        operation.context.playPresetRevision !== record.playPresetRevision ||
        operation.context.playPresetScriptsEnabled !==
          record.playPresetScriptsEnabled
      )
        throw new ArtifactStoreCorruptionError(
          "Artifact raw record does not match the operation identity",
        );
    }
    return raw;
  }

  async #recordsForOperation(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactRawRecord[]> {
    return (await this.#records(worldId)).filter(
      (record) => record.operationId === operationId,
    );
  }

  /** Writes or replaces one record; save:none records stay in memory only. */
  async #putRecord(
    input: Omit<ArtifactRawRecord, "recordFingerprint">,
  ): Promise<void> {
    // Only a cleared record keeps the clear that made it so.
    const record = input.status === "cleared" ? input : withoutClearedBy(input);
    const finalized: ArtifactRawRecord = {
      ...record,
      recordFingerprint: rawRecordFingerprint(record),
    };
    assertRawRecord(finalized);
    if (record.save === "none") {
      // A superseded record has no reader left: the debug listing shows only
      // records that still exist, so it is not kept.
      if (record.status === "superseded") {
        await this.#removeRecord(finalized);
        return;
      }
      const records = this.#memoryRecords.get(record.operationId) ?? [];
      const index = records.findIndex(
        (candidate) => candidate.recordId === record.recordId,
      );
      if (index < 0) records.push(finalized);
      else records[index] = finalized;
      this.#memoryRecords.set(record.operationId, records);
      return;
    }
    await writeArtifactJson(
      join(
        this.#artifactsRoot(record.worldId),
        "records",
        artifactSequenceFileName(record.sequence),
      ),
      finalized,
    );
  }

  async #removeRecord(record: ArtifactRawRecord): Promise<void> {
    if (record.save === "none") {
      const records = (
        this.#memoryRecords.get(record.operationId) ?? []
      ).filter((candidate) => candidate.recordId !== record.recordId);
      if (records.length === 0) this.#memoryRecords.delete(record.operationId);
      else this.#memoryRecords.set(record.operationId, records);
      return;
    }
    await rm(
      join(
        this.#artifactsRoot(record.worldId),
        "records",
        artifactSequenceFileName(record.sequence),
      ),
      { force: true },
    );
  }

  /**
   * A cleared save:none record stays only while its clearing operation can still
   * roll the clear back (see beginRequestAttempt). Once that operation is closed
   * nothing reads the record, so it leaves memory.
   */
  async #releaseClosedClears(worldId: string): Promise<void> {
    const cleared = [...this.#memoryRecords.values()]
      .flat()
      .filter(
        (record) => record.worldId === worldId && record.status === "cleared",
      );
    if (cleared.length === 0) return;
    const operations = new Map(
      (await this.#operationsForWorld(worldId)).map((operation) => [
        operation.context.operationId,
        operation,
      ]),
    );
    for (const record of cleared) {
      const clearing =
        record.clearedBy === undefined
          ? undefined
          : operations.get(record.clearedBy.operationId);
      if (clearing !== undefined && !isClosedOperation(clearing)) continue;
      await this.#removeRecord(record);
    }
  }

  async #operationsForWorld(worldId: string): Promise<ArtifactOperationFile[]> {
    return [
      ...(await readOperationFiles(this.#artifactsRoot(worldId))).values(),
    ].filter((operation) => operation.context.worldId === worldId);
  }

  /**
   * The next sequence is one past the largest on disk or handed out in this
   * process. The high-water mark outlives removed save:none records, so their
   * sequences are never reused.
   */
  async #nextSequence(worldId: string): Promise<number> {
    let maximum = this.#sequenceHighWater.get(worldId) ?? 0;
    try {
      for (const name of await readdir(
        join(this.#artifactsRoot(worldId), "records"),
      )) {
        if (!name.endsWith(".json")) continue;
        const value = Number.parseInt(name.slice(0, -5), 10);
        if (
          !Number.isSafeInteger(value) ||
          value < 1 ||
          name !== artifactSequenceFileName(value)
        )
          throw new ArtifactStoreCorruptionError(
            "Artifact sequence file name is invalid",
          );
        maximum = Math.max(maximum, value);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const next = maximum + 1;
    this.#sequenceHighWater.set(worldId, next);
    return next;
  }

  async #readOperation(
    worldId: string,
    operationId: string,
  ): Promise<ArtifactOperationFile | null> {
    try {
      const operation = parseArtifactJson<ArtifactOperationFile>(
        await readFile(this.#operationPath(worldId, operationId), "utf8"),
        "artifact operation",
      );
      assertOperation(operation);
      if (operation.context.operationId !== operationId)
        throw new ArtifactStoreCorruptionError(
          "Artifact operation does not match the request identity",
        );
      return operation;
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #writeOperation(operation: ArtifactOperationFile): Promise<void> {
    assertOperation(operation);
    await writeArtifactJson(
      this.#operationPath(
        operation.context.worldId,
        operation.context.operationId,
      ),
      operation,
    );
  }

  /** Reads of a world whose artifacts are still in the legacy layout migrate it first. */
  async #ensureReadable(worldId: string): Promise<void> {
    if (await hasLegacyArtifactState(this.#dataRoot, worldId))
      await this.#withWorldMutation(worldId, () => Promise.resolve());
  }

  async #withWorldMutation<T>(
    worldId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const active = this.#mutationContext.getStore();
    if (active?.has(worldId) === true) return action();
    return worldQueueFor(this.#dataRoot).run(worldId, () =>
      this.#mutationContext.run(
        new Set([...(active ?? []), worldId]),
        async () => {
          await migrateLegacyArtifactStore(this.#dataRoot, worldId);
          const result = await action();
          await this.#releaseClosedClears(worldId);
          return result;
        },
      ),
    );
  }

  #artifactsRoot(worldId: string): string {
    assertWorldDirectoryId(worldId);
    return join(this.#worldsRoot, worldId, "artifacts");
  }

  #operationPath(worldId: string, operationId: string): string {
    return join(
      this.#artifactsRoot(worldId),
      "operations",
      `${identityHash(operationId)}.json`,
    );
  }
}

/**
 * Rewrites a copied world directory into a fork target: records and operations
 * are kept only when they are committed, active, attached to a reply and bound
 * at or before the restored head. Everything else is deleted file by file, and
 * the survivors take the target identity. Runs on an unpublished staging copy.
 */
export async function forkArtifactClosure(
  worldRoot: string,
  input: { sourceWorldId: string; targetWorldId: string; restoredHead: string },
): Promise<void> {
  const artifactsRoot = join(worldRoot, "artifacts");
  const limit = headOrdinal(input.restoredHead);
  const records = await readRecordFiles(artifactsRoot);
  const operations = await readOperationFiles(artifactsRoot);
  for (const record of records)
    if (record.worldId !== input.sourceWorldId)
      throw new ArtifactStoreCorruptionError(
        "Artifact fork record belongs to another world",
      );
  // A fork keeps what the source's projection would show at that head: the
  // committed, attached, selected records. Superseded or unselected records
  // stay behind with the source.
  const candidates = records.filter((record) => {
    const operation = operations.get(record.operationId);
    return (
      record.save === "commit" &&
      record.status === "active" &&
      record.projection !== "hidden" &&
      (record.projection !== "transient" || isActiveInteraction(operation)) &&
      operation !== undefined &&
      operation.artifactProjectionStatus !== "superseded" &&
      operation.context.attachment !== undefined &&
      headOrdinal(record.head ?? record.parentHead) <= limit
    );
  });
  const retained = selectProjection(candidates);
  const retainedRecordIds = new Set(retained.map((record) => record.recordId));
  for (const record of records)
    if (!retainedRecordIds.has(record.recordId))
      await rm(
        join(
          artifactsRoot,
          "records",
          artifactSequenceFileName(record.sequence),
        ),
        { force: true },
      );
  const retainedOperations = new Set(
    retained.map((record) => record.operationId),
  );
  for (const operationId of operations.keys())
    if (!retainedOperations.has(operationId))
      await rm(
        join(artifactsRoot, "operations", `${identityHash(operationId)}.json`),
        {
          force: true,
        },
      );
  for (const record of retained) {
    const next = {
      ...record,
      worldId: input.targetWorldId,
      operationId: forkOperationId(input.targetWorldId, record.operationId),
    };
    await writeArtifactJson(
      join(artifactsRoot, "records", artifactSequenceFileName(record.sequence)),
      { ...next, recordFingerprint: rawRecordFingerprint(next) },
    );
  }
  for (const operationId of retainedOperations) {
    const operation = operations.get(operationId)!;
    const nextId = forkOperationId(input.targetWorldId, operationId);
    const next: ArtifactOperationFile = {
      ...operation,
      context: {
        ...operation.context,
        worldId: input.targetWorldId,
        operationId: nextId,
      },
    };
    await writeArtifactJson(
      join(artifactsRoot, "operations", `${identityHash(nextId)}.json`),
      next,
    );
    await rm(
      join(artifactsRoot, "operations", `${identityHash(operationId)}.json`),
      {
        force: true,
      },
    );
  }
}

function withoutClearedBy(
  record: Omit<ArtifactRawRecord, "recordFingerprint">,
): Omit<ArtifactRawRecord, "recordFingerprint"> {
  const copy = { ...record };
  delete copy.clearedBy;
  return copy;
}

function forkOperationId(targetWorldId: string, operationId: string): string {
  return `artifact-fork:${targetWorldId}:${identityHash(operationId)}`;
}

async function readRecordFiles(
  artifactsRoot: string,
): Promise<ArtifactRawRecord[]> {
  const directory = join(artifactsRoot, "records");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: ArtifactRawRecord[] = [];
  for (const name of names.sort()) {
    const parsed = parseArtifactJson<ArtifactRawRecord>(
      await readFile(join(directory, name), "utf8"),
      "artifact raw record",
    );
    assertRawRecord(parsed);
    if (name !== artifactSequenceFileName(parsed.sequence))
      throw new ArtifactStoreCorruptionError(
        "Artifact raw-record file name does not match its sequence",
      );
    records.push(parsed);
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

async function readOperationFiles(
  artifactsRoot: string,
): Promise<Map<string, ArtifactOperationFile>> {
  const directory = join(artifactsRoot, "operations");
  const byId = new Map<string, ArtifactOperationFile>();
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error: unknown) {
    if (isMissing(error)) return byId;
    throw error;
  }
  for (const name of names.sort()) {
    const operation = parseArtifactJson<ArtifactOperationFile>(
      await readFile(join(directory, name), "utf8"),
      "artifact operation",
    );
    assertOperation(operation);
    if (name !== `${identityHash(operation.context.operationId)}.json`)
      throw new ArtifactStoreCorruptionError(
        "Artifact operation does not match the file-path identity",
      );
    byId.set(operation.context.operationId, operation);
  }
  return byId;
}

function assertWorldDirectoryId(worldId: string): void {
  if (
    worldId === "" ||
    worldId === "." ||
    worldId === ".." ||
    worldId.includes("/") ||
    worldId.includes("\\")
  )
    throw new ArtifactStoreInvariantError("Artifact world ID is not a path");
}

export class InMemoryArtifactStore extends FileNativeArtifactStore {
  constructor() {
    super(join(tmpdir(), "narraeon-ephemeral-artifacts", randomUUID()));
  }
}

function newRecord(
  input: ArtifactEmitInput,
  declaration: PlayPresetArtifactDeclaration,
  payload: ArtifactPayload,
  identity: { sequence: number; fingerprint: string; callFingerprint: string },
): Omit<ArtifactRawRecord, "status" | "head" | "recordFingerprint"> {
  const record = {
    schemaVersion: 1 as const,
    recordId: `artifact:${identity.sequence}:${identity.fingerprint.slice(7, 23)}`,
    sequence: identity.sequence,
    worldId: input.context.worldId,
    parentHead: input.context.parentHead,
    operationId: input.context.operationId,
    playPresetId: input.context.playPresetId,
    playPresetRevision: input.context.playPresetRevision,
    playPresetScriptsEnabled: input.context.playPresetScriptsEnabled,
    requestId: input.context.requestId,
    requestAttempt: input.context.requestAttempt,
    output: declaration.name,
    channel: declaration.channel,
    ...(declaration.key === undefined ? {} : { key: declaration.key }),
    contentType: declaration.contentType,
    ...(declaration.renderer === undefined
      ? {}
      : { renderer: declaration.renderer }),
    ...(declaration.rendererRevision === undefined
      ? {}
      : { rendererRevision: declaration.rendererRevision }),
    ...(input.context.extensionControl === undefined
      ? {}
      : {
          extensionControl: structuredClone(input.context.extensionControl),
        }),
    ...(input.context.frozenPresentations?.[declaration.name] !== undefined
      ? {
          frozenPresentation: structuredClone(
            input.context.frozenPresentations[declaration.name],
          ),
        }
      : input.context.frozenResources === undefined
        ? {}
        : {
            frozenPresentation: {
              ...structuredClone(input.context.frozenResources),
              declaration: structuredClone(declaration),
            },
          }),
    payload: structuredClone(payload),
    save: declaration.save,
    projection: declaration.strategy,
    invalidation: declaration.invalidation,
    toolCallId: input.toolCallId,
    toolName: "artifact_emit" as const,
    callFingerprint: identity.callFingerprint,
    payloadFingerprint: identity.fingerprint,
  };
  return record;
}

function findDeclaration(
  context: ArtifactRequestContext,
  output: string,
): PlayPresetArtifactDeclaration | null {
  return context.declarations.find(({ name }) => name === output) ?? null;
}

function normalizePayload(
  declaration: PlayPresetArtifactDeclaration,
  input: unknown,
): { ok: true; value: ArtifactPayload } | { ok: false; message: string } {
  if (declaration.contentType !== "application/json") {
    if (typeof input !== "string")
      return {
        ok: false,
        message: `${declaration.name} ${declaration.contentType} payload must be a string`,
      };
    return { ok: true, value: input };
  }
  if (!isJsonValue(input))
    return {
      ok: false,
      message: "JSON artifact payload must be a valid JSON value",
    };
  try {
    JSON.stringify(input);
  } catch {
    return { ok: false, message: "JSON artifact payload cannot be serialized" };
  }
  const contract = validatePlayPresetArtifactPayload(
    declaration.payloadContract,
    input,
  );
  if (!contract.ok) return contract;
  return { ok: true, value: structuredClone(input) };
}

function byteLength(payload: ArtifactPayload, contentType: string): number {
  return Buffer.byteLength(payloadText(payload, contentType), "utf8");
}

function payloadText(payload: ArtifactPayload, contentType: string): string {
  if (contentType === "application/json") return JSON.stringify(payload);
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function artifactCallFingerprint(
  toolName: "artifact_emit",
  context: ArtifactRequestContext,
  parameters: { output: string; payload?: ArtifactPayload },
): string {
  return `sha256:${createHash("sha256")
    .update(
      stableSerialize({
        toolName,
        operationId: context.operationId,
        worldId: context.worldId,
        parentHead: context.parentHead,
        playPresetId: context.playPresetId,
        playPresetRevision: context.playPresetRevision,
        playPresetScriptsEnabled: context.playPresetScriptsEnabled,
        ...(context.extensionControl === undefined
          ? {}
          : { extensionControl: context.extensionControl }),
        requestId: context.requestId,
        requestAttempt: context.requestAttempt,
        parameters,
      }),
    )
    .digest("hex")}`;
}

function artifactFailure(message: string): ArtifactToolResult {
  return { ok: false, markdown: `# Runtime artifact rejected\n\n${message}` };
}

function recoveryRequired(
  operationId: string,
  completedRequests: string[],
  message: string | undefined,
): ArtifactExtensionSummary {
  return {
    operationId,
    status: "recovery_required",
    completedRequests,
    ...(message === undefined ? {} : { message }),
    coreCommitted: false,
  };
}

function isOpenExtension(operation: ArtifactOperationFile): boolean {
  return (
    operation.status === "core_committed" &&
    ["not_started", "running", "unknown", "recovery_required"].includes(
      operation.extensionStatus,
    )
  );
}

function isOpenProjectionOperation(operation: ArtifactOperationFile): boolean {
  return operation.status === "running" || isOpenExtension(operation);
}

function isTerminalExtensionStatus(status: ArtifactExtensionStatus): boolean {
  return [
    "completed",
    "failed",
    "cancelled",
    "budget_exceeded",
    "superseded",
  ].includes(status);
}

/** A closed operation registers no further request attempts, so its clears are final. */
function isClosedOperation(operation: ArtifactOperationFile): boolean {
  return (
    operation.status === "core_failed" ||
    operation.status === "completed" ||
    operation.artifactProjectionStatus === "superseded"
  );
}

function isStaleOperation(operation: ArtifactOperationFile | null): boolean {
  return (
    operation === null ||
    operation.artifactProjectionStatus === "superseded" ||
    operation.status === "core_failed" ||
    operation.status === "completed" ||
    operation.extensionStatus === "superseded" ||
    operation.extensionStatus === "unknown" ||
    operation.extensionStatus === "recovery_required" ||
    operation.extensionStatus === "failed" ||
    operation.extensionStatus === "cancelled" ||
    operation.extensionStatus === "budget_exceeded"
  );
}

function isActiveInteraction(
  operation: ArtifactOperationFile | undefined,
): boolean {
  return (
    operation !== undefined &&
    (operation.status === "running" ||
      (operation.status === "core_committed" &&
        operation.extensionStatus === "running"))
  );
}

function summary(operation: ArtifactOperationFile): ArtifactExtensionSummary {
  return {
    ...(operation.context.attachment === undefined
      ? {}
      : { attachment: structuredClone(operation.context.attachment) }),
    ...(operation.requests === undefined
      ? {}
      : { requests: structuredClone(operation.requests) }),
    operationId: operation.context.operationId,
    status: operation.extensionStatus,
    ...(operation.message === undefined ? {} : { message: operation.message }),
    completedRequests: [...operation.completedRequests],
    coreCommitted:
      operation.status === "core_committed" || operation.status === "completed",
    ...(operation.head === undefined ? {} : { head: operation.head }),
  };
}

function selectProjection(active: ArtifactRawRecord[]): ArtifactRawRecord[] {
  const append: ArtifactRawRecord[] = [];
  const replace = new Map<string, ArtifactRawRecord>();
  const upsert = new Map<string, ArtifactRawRecord>();
  for (const record of [...active].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (record.projection === "append" || record.projection === "transient")
      append.push(record);
    else if (record.projection === "replace")
      replace.set(record.channel, record);
    else if (record.projection === "upsert")
      upsert.set(`${record.channel}\0${record.key ?? ""}`, record);
  }
  return [...append, ...replace.values(), ...upsert.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function assertContext(context: ArtifactOperationContext): void {
  if (
    !isRecord(context) ||
    !hasExactKeys(
      context,
      [
        "worldId",
        "parentHead",
        "operationId",
        "playPresetId",
        "playPresetRevision",
        "playPresetScriptsEnabled",
      ],
      ["attachment"],
    )
  )
    throw new ArtifactStoreInvariantError(
      "Artifact operation context has an invalid structure",
    );
  if (context.attachment !== undefined && !validAttachment(context.attachment))
    throw new ArtifactStoreInvariantError(
      "Artifact reply attachment is invalid",
    );
  for (const [key, value] of Object.entries({
    worldId: context.worldId,
    parentHead: context.parentHead,
    operationId: context.operationId,
    playPresetId: context.playPresetId,
    playPresetRevision: context.playPresetRevision,
  }))
    if (typeof value !== "string" || value.trim() === "")
      throw new ArtifactStoreInvariantError(`Artifact ${key} is invalid`);
  if (typeof context.playPresetScriptsEnabled !== "boolean")
    throw new ArtifactStoreInvariantError(
      "Artifact playPresetScriptsEnabled is invalid",
    );
}

function normalizeOperationContext(
  context: ArtifactOperationContext,
): ArtifactOperationContext {
  return structuredClone(context);
}

function assertRequestContext(context: ArtifactRequestContext): void {
  assertContext({
    worldId: context.worldId,
    parentHead: context.parentHead,
    operationId: context.operationId,
    playPresetId: context.playPresetId,
    playPresetRevision: context.playPresetRevision,
    playPresetScriptsEnabled: context.playPresetScriptsEnabled,
    ...(context.attachment === undefined
      ? {}
      : { attachment: context.attachment }),
  });
  if (
    context.extensionControl !== undefined &&
    !isWorldExtensionControl(context.extensionControl)
  )
    throw new ArtifactStoreInvariantError(
      "Invalid extension control generation",
    );
  if (
    context.requestId.trim() === "" ||
    !Number.isInteger(context.requestAttempt)
  )
    throw new ArtifactStoreInvariantError(
      "Artifact request attempt is invalid",
    );
  if (context.requestAttempt < 1 || context.maxArtifactBytes < 0)
    throw new ArtifactStoreInvariantError(
      "Artifact request-attempt budget is invalid",
    );
}

function sameContext(
  left: ArtifactOperationContext,
  right: ArtifactOperationContext,
): boolean {
  return (
    stableSerialize(left.attachment ?? null) ===
      stableSerialize(right.attachment ?? null) &&
    left.worldId === right.worldId &&
    left.parentHead === right.parentHead &&
    left.operationId === right.operationId &&
    left.playPresetId === right.playPresetId &&
    left.playPresetRevision === right.playPresetRevision &&
    left.playPresetScriptsEnabled === right.playPresetScriptsEnabled
  );
}
