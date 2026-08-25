import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  validatePlayPresetArtifactPayload,
  type PlayPresetArtifactDeclaration,
  type PlayPresetArtifactStrategy,
} from "../play/FileNativePlayPresetStore.ts";

export type ArtifactPayload =
  | string
  | number
  | boolean
  | null
  | ArtifactPayload[]
  | { [key: string]: ArtifactPayload };

export type ArtifactRecordStatus =
  "pending" | "active" | "superseded" | "failed" | "cleared";

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

export class ArtifactStoreInvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactStoreInvariantError";
  }
}

export class ArtifactStoreCorruptionError extends ArtifactStoreInvariantError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactStoreCorruptionError";
  }
}

export interface ArtifactOperationContext {
  worldId: string;
  parentHead: string;
  operationId: string;
  playPresetId: string;
  playPresetRevision: string;
  /** Frozen local renderer execution policy. */
  playPresetScriptsEnabled: boolean;
}

export interface ArtifactRequestContext extends ArtifactOperationContext {
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

export interface ArtifactExtensionSummary {
  operationId: string;
  status: ArtifactExtensionStatus;
  message?: string;
  completedRequests: string[];
  /** Safe world-facing proof that the Authority core receipt was accepted. */
  coreCommitted: boolean;
  head?: string;
}

export interface ArtifactStore {
  beginOperation(context: ArtifactOperationContext): Promise<void>;
  /** Register the current monotonic attempt for one follow-up request. */
  beginRequestAttempt(context: ArtifactRequestContext): Promise<void>;
  /** Reconcile head-bound projections without exposing raw event mechanics. */
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
  markCoreMaterializationPending(
    context: ArtifactOperationContext,
    head: string,
    message: string,
  ): Promise<ArtifactExtensionSummary>;
  markCoreFailed(operationId: string, message?: string): Promise<void>;
  beginExtension(context: ArtifactOperationContext): Promise<void>;
  completeExtension(
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary>;
  failExtension(
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests?: string[],
  ): Promise<ArtifactExtensionSummary>;
  readExtension(operationId: string): Promise<ArtifactExtensionSummary | null>;
  /** Read persisted extension lifecycle summaries without raw/provider data. */
  readExtensionSummaries(worldId: string): Promise<ArtifactExtensionSummary[]>;
  resumeExtension(operationId: string): Promise<ArtifactExtensionSummary>;
  readActiveProjection(
    worldId: string,
    channel?: string,
  ): Promise<ArtifactProjectionItem[]>;
  readDebug(
    worldId: string,
    operationId?: string,
  ): Promise<ArtifactDebugRecord[]>;
}

interface ArtifactRawRecord {
  schemaVersion: 1;
  recordId: string;
  sequence: number;
  worldId: string;
  parentHead: string;
  newHead: string | null;
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
  save: PlayPresetArtifactDeclaration["save"];
  projection: PlayPresetArtifactStrategy;
  invalidation: PlayPresetArtifactDeclaration["invalidation"];
  toolCallId: string;
  toolName: "artifact_emit";
  callFingerprint: string;
  payloadFingerprint: string;
  recordFingerprint: string;
  status: "pending";
}

interface ArtifactEvent {
  schemaVersion: 1;
  kind: "activate" | "supersede" | "clear" | "bind_head" | "ignored_call";
  sequence: number;
  recordId?: string;
  operationId: string;
  output?: string;
  channel?: string;
  key?: string;
  head?: string;
  requestId?: string;
  requestAttempt?: number;
  reason?: string;
  toolCallId?: string;
  toolName?: "artifact_emit" | "artifact_clear";
  callFingerprint?: string;
}

interface ArtifactOperationFile {
  schemaVersion: 1;
  context: ArtifactOperationContext;
  status:
    | "running"
    | "core_failed"
    | "core_materialization_pending"
    | "core_committed"
    | "completed";
  extensionStatus: ArtifactExtensionStatus;
  message?: string;
  completedRequests: string[];
  head?: string;
  artifactProjectionStatus: "active" | "superseded";
  /** Latest registered attempt per request; persisted for cold projection rebuild. */
  requestAttempts: Record<string, number>;
}

interface EffectiveRecord {
  record: ArtifactRawRecord;
  status: ArtifactRecordStatus;
  head: string | null;
}

const maxPayloadBytes = 4 * 1024 * 1024;

/**
 * File-native artifact module. Raw records never change after publication;
 * projection events and operation state are the only mutable layers. The
 * public interface deliberately exposes no filesystem paths or provider
 * transcript and is the seam used by the play-call-chain coordinator and tests.
 */
export class FileNativeArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #memoryRecords = new Map<string, ArtifactRawRecord[]>();
  readonly #memoryEvents = new Map<string, ArtifactEvent[]>();
  readonly #mutationContext = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(dataRoot: string) {
    this.#root = join(resolve(dataRoot), "artifact-store");
  }

  async beginOperation(context: ArtifactOperationContext): Promise<void> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#beginOperation(context),
    );
  }

  async #beginOperation(context: ArtifactOperationContext): Promise<void> {
    assertContext(context);
    const existing = await this.#readOperation(context.operationId);
    if (existing !== null && !sameContext(existing.context, context))
      throw new ArtifactStoreInvariantError(
        "artifact operation 已绑定另一份冻结载荷",
      );
    // A direct orchestrator/store caller must not rely on a later UI read to
    // invalidate artifacts bound to the parent head. This call is safe on a
    // retry because projection events are appended idempotently below.
    await this.reconcileHead(
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

    // Operation state is indexed independently of raw records. This closes the
    // no-artifact gap: a running/unknown extension is superseded even when it
    // has not emitted anything yet. Its execution status is retained unless it
    // is an actually open extension, while projection invalidation is tracked
    // separately for late raw results.
    const prior = await this.#effectiveRecords(context.worldId);
    for (const priorOperation of priorOperations) {
      if (priorOperation.context.operationId === context.operationId) continue;
      const openExtension = isOpenExtension(priorOperation);
      const operationAlreadySuperseded =
        priorOperation.artifactProjectionStatus === "superseded";
      const priorRecords = prior.filter(
        ({ record, status }) =>
          record.operationId === priorOperation.context.operationId &&
          status === "active",
      );
      const invalidatedRecords = priorRecords.filter(
        ({ record }) =>
          openExtension ||
          operationAlreadySuperseded ||
          record.invalidation === "new_operation",
      );
      for (const item of invalidatedRecords)
        await this.#appendEventOnce({
          schemaVersion: 1,
          kind: "supersede",
          operationId: item.record.operationId,
          recordId: item.record.recordId,
          reason: "new_operation",
          sequence: await this.#nextSequence(context.worldId),
        });
      if (openExtension) {
        const next: ArtifactOperationFile = {
          ...priorOperation,
          artifactProjectionStatus: "superseded",
          extensionStatus: "superseded",
          message: "该扩展已被新 operation 取代",
        };
        if (JSON.stringify(next) !== JSON.stringify(priorOperation))
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
    const operation = await this.#readOperation(context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "artifact request attempt 缺少 operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "artifact request attempt 与冻结 operation 不匹配",
      );
    if (
      operation.status === "core_failed" ||
      operation.status === "completed" ||
      operation.artifactProjectionStatus === "superseded"
    )
      return;

    const current = operation.requestAttempts[context.requestId];
    if (current !== undefined && context.requestAttempt < current) return;

    // Persist the monotonic marker before projection events. If a process dies
    // between these writes, cold rebuild still treats the old attempt as
    // stale, and a retry below completes the missing supersede events.
    if (current === undefined || context.requestAttempt > current) {
      await this.#writeOperation({
        ...operation,
        requestAttempts: {
          ...operation.requestAttempts,
          [context.requestId]: context.requestAttempt,
        },
      });
    }

    const records = await this.#recordsForOperation(context.operationId);
    for (const record of records) {
      if (
        record.requestId !== context.requestId ||
        record.requestAttempt >= context.requestAttempt
      )
        continue;
      const event: ArtifactEvent = {
        schemaVersion: 1,
        kind: "supersede",
        operationId: context.operationId,
        recordId: record.recordId,
        requestId: record.requestId,
        requestAttempt: record.requestAttempt,
        reason: "request_attempt_superseded",
        sequence: await this.#nextSequence(context.worldId),
      };
      await this.#appendRecordEvent(record, event);
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
        "artifact head reconciliation 参数无效",
      );
    const operations = await this.#operationsForWorld(worldId);
    const effective = await this.#effectiveRecords(worldId);
    const affected = new Set<string>();
    for (const item of effective) {
      const operationId = item.record.operationId;
      if (operationId === exceptOperationId || item.status !== "active")
        continue;
      if (item.record.invalidation !== "head_change") continue;
      const boundHead = item.head ?? item.record.parentHead;
      if (boundHead === head) continue;
      await this.#appendEventOnce({
        schemaVersion: 1,
        kind: "supersede",
        operationId,
        recordId: item.record.recordId,
        reason: "head_change",
        sequence: await this.#nextSequence(worldId),
      });
      affected.add(operationId);
    }
    for (const operation of operations) {
      const operationId = operation.context.operationId;
      if (operationId === exceptOperationId) continue;
      const boundHead = operation.head ?? operation.context.parentHead;
      if (boundHead === head) continue;
      const hasActiveHeadBoundRecord = effective.some(
        ({ record, status, head: recordHead }) =>
          record.operationId === operationId &&
          status === "active" &&
          record.invalidation === "head_change" &&
          (recordHead ?? record.parentHead) !== head,
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
              message: "该扩展已被新 head 取代",
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
      return artifactFailure(`未声明产物 output：${input.output}`);
    const payload = normalizePayload(declaration, input.payload);
    if (!payload.ok) return artifactFailure(payload.message);
    if (input.toolCallId.trim() === "")
      return artifactFailure("tool-call ID 不能为空");
    const operation = await this.#readOperation(input.context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "artifact emit 缺少 operation checkpoint",
      );
    if (!sameContext(operation.context, input.context))
      throw new ArtifactStoreInvariantError(
        "artifact emit 与冻结 operation 不匹配",
      );
    const currentAttempt = operation.requestAttempts[input.context.requestId];
    if (currentAttempt === undefined)
      throw new ArtifactStoreInvariantError(
        "artifact emit request attempt 尚未登记",
      );
    const fingerprint = payloadFingerprint(input.output, payload.value);
    const callFingerprint = artifactCallFingerprint(
      "artifact_emit",
      input.context,
      { output: declaration.name, payload: payload.value },
    );
    const prior = await this.#recordsForOperation(input.context.operationId);
    const previousByCall = prior.find(
      (record) => record.toolCallId === input.toolCallId,
    );
    if (previousByCall !== undefined) {
      if (previousByCall.callFingerprint !== callFingerprint)
        return artifactFailure("同一 artifact tool-call ID 已绑定另一组参数");
      await this.#repairRecordPublication(
        previousByCall,
        operation,
        currentAttempt,
      );
      return {
        ok: true,
        idempotent: true,
        recordId: previousByCall.recordId,
        markdown: `# Runtime 产物已存在\n\noutput=${input.output}`,
      };
    }
    const previousEvent = (await this.#events(input.context.worldId)).find(
      (event) =>
        event.operationId === input.context.operationId &&
        event.toolCallId === input.toolCallId,
    );
    if (previousEvent !== undefined)
      return artifactFailure("同一 artifact tool-call ID 已绑定另一种工具调用");
    const staleAttempt = currentAttempt !== input.context.requestAttempt;
    const sameOutput = prior.filter(
      (record) =>
        record.requestId === input.context.requestId &&
        record.requestAttempt === input.context.requestAttempt &&
        record.output === input.output,
    );
    if (sameOutput.length >= declaration.maxEmits)
      return artifactFailure(`产物 ${input.output} 已达到 maxEmits`);
    const payloadBytes = byteLength(payload.value, declaration.contentType);
    if (payloadBytes > maxPayloadBytes)
      return artifactFailure("产物超过 4 MiB 上限");
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
      return artifactFailure("后置请求产物超过 maxArtifactBytes");
    const record = await this.#newRecord(
      input,
      declaration,
      payload.value,
      fingerprint,
      callFingerprint,
    );
    const stale = isStaleOperation(operation) || staleAttempt;
    if (declaration.save === "none") {
      const records = this.#memoryRecords.get(input.context.operationId) ?? [];
      records.push(record);
      this.#memoryRecords.set(input.context.operationId, records);
      await this.#appendRecordEvent(record, {
        schemaVersion: 1,
        kind: stale ? "supersede" : "activate",
        sequence: await this.#nextSequence(input.context.worldId),
        operationId: input.context.operationId,
        recordId: record.recordId,
        requestId: record.requestId,
        requestAttempt: record.requestAttempt,
        ...(stale ? { reason: "late_superseded_operation_result" } : {}),
      });
      if (
        !stale &&
        operation?.status === "core_committed" &&
        operation.head !== undefined
      ) {
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "bind_head",
          sequence: await this.#nextSequence(input.context.worldId),
          operationId: input.context.operationId,
          recordId: record.recordId,
          head: operation.head,
        });
      }
    } else {
      await this.#appendRaw(record);
      if (stale)
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "supersede",
          sequence: await this.#nextSequence(input.context.worldId),
          operationId: input.context.operationId,
          recordId: record.recordId,
          requestId: record.requestId,
          requestAttempt: record.requestAttempt,
          reason: "late_superseded_operation_result",
        });
      else if (
        operation?.status === "core_committed" &&
        operation.head !== undefined
      ) {
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "bind_head",
          sequence: await this.#nextSequence(input.context.worldId),
          operationId: input.context.operationId,
          recordId: record.recordId,
          head: operation.head,
        });
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "activate",
          sequence: await this.#nextSequence(input.context.worldId),
          operationId: input.context.operationId,
          recordId: record.recordId,
        });
      } else if (declaration.save === "operation")
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "activate",
          sequence: await this.#nextSequence(input.context.worldId),
          operationId: input.context.operationId,
          recordId: record.recordId,
        });
    }
    return {
      ok: true,
      recordId: record.recordId,
      markdown: `# Runtime 产物已接收\n\noutput=${input.output}`,
    };
  }

  async #repairRecordPublication(
    record: ArtifactRawRecord,
    operation: ArtifactOperationFile,
    currentAttempt: number,
  ): Promise<void> {
    const events = await this.#events(record.worldId);
    const hasEvent = (kind: ArtifactEvent["kind"], head?: string): boolean =>
      events.some(
        (event) =>
          event.kind === kind &&
          event.operationId === record.operationId &&
          event.recordId === record.recordId &&
          (head === undefined || event.head === head),
      );
    const stale =
      isStaleOperation(operation) || currentAttempt !== record.requestAttempt;
    if (stale) {
      if (!hasEvent("supersede"))
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "supersede",
          sequence: await this.#nextSequence(record.worldId),
          operationId: record.operationId,
          recordId: record.recordId,
          requestId: record.requestId,
          requestAttempt: record.requestAttempt,
          reason: "late_superseded_operation_result",
        });
      return;
    }
    if (operation.status === "core_committed" && operation.head !== undefined) {
      if (!hasEvent("bind_head", operation.head))
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "bind_head",
          sequence: await this.#nextSequence(record.worldId),
          operationId: record.operationId,
          recordId: record.recordId,
          head: operation.head,
        });
      if (!hasEvent("activate"))
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "activate",
          sequence: await this.#nextSequence(record.worldId),
          operationId: record.operationId,
          recordId: record.recordId,
        });
      return;
    }
    if (record.save === "operation" && !hasEvent("activate"))
      await this.#appendRecordEvent(record, {
        schemaVersion: 1,
        kind: "activate",
        sequence: await this.#nextSequence(record.worldId),
        operationId: record.operationId,
        recordId: record.recordId,
      });
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
      return artifactFailure(`未声明产物 output：${input.output}`);
    if (input.toolCallId.trim() === "")
      return artifactFailure("tool-call ID 不能为空");
    const operation = await this.#readOperation(input.context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "artifact clear 缺少 operation checkpoint",
      );
    if (!sameContext(operation.context, input.context))
      throw new ArtifactStoreInvariantError(
        "artifact clear 与冻结 operation 不匹配",
      );
    const currentAttempt = operation.requestAttempts[input.context.requestId];
    if (currentAttempt === undefined)
      throw new ArtifactStoreInvariantError(
        "artifact clear request attempt 尚未登记",
      );
    const clearFingerprint = artifactCallFingerprint(
      "artifact_clear",
      input.context,
      { output: declaration.name },
    );
    const records = await this.#recordsForOperation(input.context.operationId);
    const prior = records.find(
      (record) => record.toolCallId === input.toolCallId,
    );
    if (prior !== undefined)
      return artifactFailure("同一 artifact tool-call ID 已绑定另一种工具调用");
    const priorCall = (await this.#events(input.context.worldId)).find(
      (event) =>
        event.operationId === input.context.operationId &&
        event.toolCallId === input.toolCallId,
    );
    if (priorCall !== undefined) {
      if (priorCall.callFingerprint !== clearFingerprint)
        return artifactFailure("同一 artifact tool-call ID 已绑定另一组参数");
      return {
        ok: true,
        idempotent: true,
        markdown: `# Runtime 产物清除已确认\n\noutput=${input.output}`,
      };
    }
    const staleAttempt = currentAttempt !== input.context.requestAttempt;
    if (isStaleOperation(operation) || staleAttempt) {
      const event: ArtifactEvent = {
        schemaVersion: 1,
        kind: "ignored_call",
        operationId: input.context.operationId,
        output: declaration.name,
        channel: declaration.channel,
        ...(declaration.key === undefined ? {} : { key: declaration.key }),
        reason: "stale_clear_ignored",
        sequence: await this.#nextSequence(input.context.worldId),
        toolCallId: input.toolCallId,
        toolName: "artifact_clear",
        callFingerprint: clearFingerprint,
        requestId: input.context.requestId,
        requestAttempt: input.context.requestAttempt,
      };
      // An ignored stale call is a durable identity ledger even for save:none:
      // no raw payload is persisted, but a cold retry must distinguish the
      // exact same call from a changed request/attempt/parameter.
      await this.#appendEventOnce(event);
      return {
        ok: true,
        markdown: `# Runtime 产物清除已忽略\n\noutput=${input.output}`,
      };
    }
    const event: ArtifactEvent = {
      schemaVersion: 1,
      kind: "clear",
      operationId: input.context.operationId,
      output: declaration.name,
      channel: declaration.channel,
      ...(declaration.key === undefined ? {} : { key: declaration.key }),
      reason: "explicit_clear",
      sequence: await this.#nextSequence(input.context.worldId),
      toolCallId: input.toolCallId,
      toolName: "artifact_clear",
      callFingerprint: clearFingerprint,
      requestId: input.context.requestId,
      requestAttempt: input.context.requestAttempt,
    };
    // Projection clears are durable even for save:none. Only the raw payload
    // is ephemeral; otherwise a cold restart would resurrect an old panel.
    await this.#appendEventOnce(event);
    return {
      ok: true,
      markdown: `# Runtime 产物清除已确认\n\noutput=${input.output}`,
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
      throw new ArtifactStoreInvariantError("核心提交 head 无效");
    const operation = await this.#readOperation(context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "核心提交缺少 artifact operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "artifact operation 已绑定另一份冻结载荷",
      );
    if (operation.status === "completed") {
      if (operation.head !== head)
        throw new ArtifactStoreInvariantError(
          "已完成 artifact operation 的核心 head 冲突",
        );
      return;
    }
    if (operation.status === "core_failed")
      throw new ArtifactStoreInvariantError(
        "核心失败的 artifact operation 不能再次提交",
      );
    if (operation.status === "core_committed") {
      if (operation.head !== head)
        throw new ArtifactStoreInvariantError(
          "已提交 artifact operation 的核心 head 冲突",
        );
      await this.#activateCommittedRecords(operation, context, head);
      return;
    }
    const recoveredFromMaterializationPending =
      operation.status === "core_materialization_pending";
    if (recoveredFromMaterializationPending && operation.head !== head)
      throw new ArtifactStoreInvariantError(
        "待物化 artifact operation 的核心 head 冲突",
      );
    await this.reconcileHead(context.worldId, head, context.operationId);
    const committed: ArtifactOperationFile = {
      ...operation,
      status: "core_committed",
      extensionStatus: recoveredFromMaterializationPending
        ? "not_started"
        : operation.extensionStatus,
      ...(recoveredFromMaterializationPending ? { completedRequests: [] } : {}),
      head,
    };
    if (recoveredFromMaterializationPending) delete committed.message;
    // Persist the receipt/head before projection events. A crash after this
    // write is repaired by the idempotent same-head path above.
    await this.#writeOperation(committed);
    await this.#activateCommittedRecords(committed, context, head);
  }

  async markCoreMaterializationPending(
    context: ArtifactOperationContext,
    head: string,
    message: string,
  ): Promise<ArtifactExtensionSummary> {
    return this.#withWorldMutation(context.worldId, () =>
      this.#markCoreMaterializationPending(context, head, message),
    );
  }

  async #markCoreMaterializationPending(
    context: ArtifactOperationContext,
    head: string,
    message: string,
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError("待物化 artifact operation 不存在");
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "待物化 artifact operation 与冻结 operation 不匹配",
      );
    if (operation.status === "core_failed")
      throw new ArtifactStoreInvariantError(
        "核心失败的 artifact operation 不能等待物化",
      );
    if (
      operation.status === "core_committed" ||
      operation.status === "completed"
    )
      return summary(operation);
    if (
      operation.status === "core_materialization_pending" &&
      operation.head !== head
    )
      throw new ArtifactStoreInvariantError(
        "待物化 artifact operation 的核心 head 冲突",
      );
    const pending: ArtifactOperationFile = {
      ...operation,
      status: "core_materialization_pending",
      extensionStatus: "recovery_required",
      message,
      completedRequests: [],
      head,
    };
    await this.#writeOperation(pending);
    return summary(pending);
  }

  async #activateCommittedRecords(
    operation: ArtifactOperationFile,
    context: ArtifactOperationContext,
    head: string,
  ): Promise<void> {
    if (operation.artifactProjectionStatus === "superseded") return;
    const effective = await this.#effectiveRecords(context.worldId);
    for (const item of effective) {
      const { record, status, head: boundHead } = item;
      if (record.operationId !== context.operationId) continue;
      if (
        status === "superseded" ||
        status === "cleared" ||
        status === "failed"
      )
        continue;
      if (boundHead !== null && boundHead !== head)
        throw new ArtifactStoreInvariantError(
          "artifact record 已绑定另一份核心 head",
        );
      if (boundHead !== head)
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "bind_head",
          operationId: context.operationId,
          recordId: record.recordId,
          head,
          sequence: await this.#nextSequence(context.worldId),
        });
      if (status === "pending")
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "activate",
          operationId: context.operationId,
          recordId: record.recordId,
          sequence: await this.#nextSequence(context.worldId),
        });
    }
  }

  async markCoreFailed(operationId: string, message?: string): Promise<void> {
    const worldId = await this.#worldForOperation(operationId);
    if (worldId === null) return;
    return this.#withWorldMutation(worldId, () =>
      this.#markCoreFailed(operationId, message),
    );
  }

  async #markCoreFailed(operationId: string, message?: string): Promise<void> {
    const operation = await this.#readOperation(operationId);
    if (operation === null) return;
    if (operation.status !== "running") return;
    const records = await this.#recordsForOperation(operationId);
    for (const record of records)
      await this.#appendEventOnce({
        schemaVersion: 1,
        kind: "supersede",
        operationId,
        recordId: record.recordId,
        reason: "core_failed",
        sequence: await this.#nextSequence(operation.context.worldId),
      });
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
    const operation = await this.#readOperation(context.operationId);
    if (operation === null)
      throw new ArtifactStoreInvariantError(
        "artifact extension 缺少 operation checkpoint",
      );
    if (!sameContext(operation.context, context))
      throw new ArtifactStoreInvariantError(
        "artifact extension 与冻结 operation 不匹配",
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
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary> {
    const worldId = await this.#worldForOperation(operationId);
    if (worldId === null) return this.#completeExtension(operationId, requests);
    return this.#withWorldMutation(worldId, () =>
      this.#completeExtension(operationId, requests),
    );
  }

  async #completeExtension(
    operationId: string,
    requests: string[],
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(operationId);
    if (operation === null)
      return {
        operationId,
        status: "recovery_required",
        completedRequests: [],
        coreCommitted: false,
      };
    if (operation.status === "running") return summary(operation);
    if (
      isTerminalExtensionStatus(operation.extensionStatus) ||
      operation.extensionStatus === "unknown" ||
      operation.extensionStatus === "recovery_required"
    )
      return summary(operation);
    if (operation.status !== "core_committed")
      throw new ArtifactStoreInvariantError(
        "核心尚未提交，不能完成 artifact extension",
      );
    const records = await this.#recordsForOperation(operationId);
    for (const record of records)
      if (record.save === "none" || record.invalidation === "operation_end")
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "supersede",
          operationId,
          recordId: record.recordId,
          reason: "operation_end",
          sequence: await this.#nextSequence(operation.context.worldId),
        });
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
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests: string[] = [],
  ): Promise<ArtifactExtensionSummary> {
    const worldId = await this.#worldForOperation(operationId);
    if (worldId === null)
      return this.#failExtension(operationId, status, message, requests);
    return this.#withWorldMutation(worldId, () =>
      this.#failExtension(operationId, status, message, requests),
    );
  }

  async #failExtension(
    operationId: string,
    status: Exclude<
      ArtifactExtensionStatus,
      "not_started" | "running" | "completed"
    >,
    message: string,
    requests: string[] = [],
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(operationId);
    if (operation === null)
      return {
        operationId,
        status: "recovery_required",
        completedRequests: requests,
        message,
        coreCommitted: false,
      };
    if (
      isTerminalExtensionStatus(operation.extensionStatus) ||
      operation.extensionStatus === "unknown" ||
      operation.extensionStatus === "recovery_required"
    )
      return summary(operation);
    if (operation.status !== "core_committed")
      throw new ArtifactStoreInvariantError(
        "核心尚未提交，不能失败 artifact extension",
      );
    const records = await this.#recordsForOperation(operationId);
    for (const record of records)
      if (record.save === "none" || record.invalidation === "operation_end")
        await this.#appendRecordEvent(record, {
          schemaVersion: 1,
          kind: "supersede",
          operationId,
          recordId: record.recordId,
          reason: "extension_failed",
          sequence: await this.#nextSequence(operation.context.worldId),
        });
    const next = {
      ...operation,
      extensionStatus: status,
      message,
      completedRequests: [...requests],
    } satisfies ArtifactOperationFile;
    await this.#writeOperation(next);
    return summary(next);
  }

  async readExtension(
    operationId: string,
  ): Promise<ArtifactExtensionSummary | null> {
    const operation = await this.#readOperation(operationId);
    return operation === null ? null : summary(operation);
  }

  async readExtensionSummaries(
    worldId: string,
  ): Promise<ArtifactExtensionSummary[]> {
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
    operationId: string,
  ): Promise<ArtifactExtensionSummary> {
    const worldId = await this.#worldForOperation(operationId);
    if (worldId === null) return this.#resumeExtension(operationId);
    return this.#withWorldMutation(worldId, () =>
      this.#resumeExtension(operationId),
    );
  }

  async #resumeExtension(
    operationId: string,
  ): Promise<ArtifactExtensionSummary> {
    const operation = await this.#readOperation(operationId);
    if (operation === null)
      return {
        operationId,
        status: "recovery_required",
        completedRequests: [],
        message: "未找到可恢复的扩展 checkpoint",
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
      message: "扩展派发状态不能安全重放；需要显式人工恢复原 request attempt",
    };
    await this.#writeOperation(next);
    return summary(next);
  }

  async readActiveProjection(
    worldId: string,
    channel?: string,
  ): Promise<ArtifactProjectionItem[]> {
    const effective = await this.#effectiveRecords(worldId);
    const operationStates = new Map<string, ArtifactOperationFile>();
    for (const item of effective)
      if (!operationStates.has(item.record.operationId)) {
        const operation = await this.#readOperation(item.record.operationId);
        if (operation !== null)
          operationStates.set(item.record.operationId, operation);
      }
    const active = effective.filter(({ record, status, head }) => {
      if (status !== "active" || record.projection === "hidden") return false;
      if (channel !== undefined && record.channel !== channel) return false;
      const operation = operationStates.get(record.operationId);
      if (
        operation === undefined ||
        operation.artifactProjectionStatus === "superseded"
      )
        return false;
      if (record.projection === "transient" && !isActiveInteraction(operation))
        return false;
      if (record.save === "operation" && operation?.status === "completed")
        return false;
      if (record.save === "commit" && head === null) return false;
      return true;
    });
    const selected = selectProjection(active);
    return selected.map(({ record, head }) => ({
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
      payload: structuredClone(record.payload),
      projection: record.projection,
      save: record.save,
      sequence: record.sequence,
      head: head ?? record.parentHead,
    }));
  }

  async readDebug(
    worldId: string,
    operationId?: string,
  ): Promise<ArtifactDebugRecord[]> {
    const effective = await this.#effectiveRecords(worldId);
    return effective
      .filter(
        ({ record }) =>
          operationId === undefined || record.operationId === operationId,
      )
      .sort((left, right) => left.record.sequence - right.record.sequence)
      .map(({ record, status, head }) => ({
        recordId: record.recordId,
        sequence: record.sequence,
        operationId: record.operationId,
        worldId: record.worldId,
        playPresetId: record.playPresetId,
        playPresetRevision: record.playPresetRevision,
        playPresetScriptsEnabled: record.playPresetScriptsEnabled,
        parentHead: record.parentHead,
        newHead: head,
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
        payload: structuredClone(record.payload),
        payloadFingerprint: record.payloadFingerprint,
        status,
      }));
  }

  async #newRecord(
    input: ArtifactEmitInput,
    declaration: PlayPresetArtifactDeclaration,
    payload: ArtifactPayload,
    fingerprint: string,
    callFingerprint: string,
  ): Promise<ArtifactRawRecord> {
    const sequence = await this.#nextSequence(input.context.worldId);
    const recordId = `artifact:${sequence}:${fingerprint.slice(7, 23)}`;
    const record = {
      schemaVersion: 1,
      recordId,
      sequence,
      worldId: input.context.worldId,
      parentHead: input.context.parentHead,
      newHead: null,
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
      payload: structuredClone(payload),
      save: declaration.save,
      projection: declaration.strategy,
      invalidation: declaration.invalidation,
      toolCallId: input.toolCallId,
      toolName: "artifact_emit",
      callFingerprint,
      payloadFingerprint: fingerprint,
      status: "pending",
    } satisfies Omit<ArtifactRawRecord, "recordFingerprint">;
    return {
      ...record,
      recordFingerprint: rawRecordFingerprint(record),
    };
  }

  async #appendRaw(record: ArtifactRawRecord): Promise<void> {
    const directory = join(this.#worldRoot(record.worldId), "records");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeDurableJson(
      join(directory, `${String(record.sequence).padStart(12, "0")}.json`),
      record,
      true,
    );
  }

  async #appendRecordEvent(
    record: ArtifactRawRecord,
    event: ArtifactEvent,
  ): Promise<void> {
    await this.#appendCallEvent(
      {
        worldId: record.worldId,
        parentHead: record.parentHead,
        operationId: record.operationId,
        playPresetId: record.playPresetId,
        playPresetRevision: record.playPresetRevision,
        playPresetScriptsEnabled: record.playPresetScriptsEnabled,
        requestId: record.requestId,
        requestAttempt: record.requestAttempt,
        maxArtifactBytes: maxPayloadBytes,
        declarations: [],
      },
      record.save,
      event,
    );
  }

  async #appendCallEvent(
    context: ArtifactRequestContext,
    save: PlayPresetArtifactDeclaration["save"],
    event: ArtifactEvent,
  ): Promise<void> {
    if (save === "none") {
      const events = this.#memoryEvents.get(context.operationId) ?? [];
      if (!events.some((candidate) => sameEventIdentity(candidate, event))) {
        events.push(event);
        this.#memoryEvents.set(context.operationId, events);
      }
      return;
    }
    await this.#appendEventOnce(event);
  }

  async #appendEvent(event: ArtifactEvent): Promise<void> {
    const worldId = await this.#worldForOperation(event.operationId);
    if (worldId === null) {
      const memory = this.#memoryEvents.get(event.operationId) ?? [];
      memory.push(event);
      this.#memoryEvents.set(event.operationId, memory);
      return;
    }
    const path = join(
      this.#worldRoot(worldId),
      "events",
      `${String(event.sequence).padStart(12, "0")}.json`,
    );
    await mkdir(join(this.#worldRoot(worldId), "events"), {
      recursive: true,
      mode: 0o700,
    });
    await writeDurableJson(path, event, true);
  }

  async #appendEventOnce(event: ArtifactEvent): Promise<void> {
    const worldId = await this.#worldForOperation(event.operationId);
    if (worldId !== null) {
      const existing = await this.#events(worldId);
      if (existing.some((candidate) => sameEventIdentity(candidate, event)))
        return;
    } else {
      const existing = this.#memoryEvents.get(event.operationId) ?? [];
      if (existing.some((candidate) => sameEventIdentity(candidate, event)))
        return;
    }
    await this.#appendEvent(event);
  }

  async #effectiveRecords(worldId: string): Promise<EffectiveRecord[]> {
    const raw: ArtifactRawRecord[] = [];
    const memory = this.#memoryRecords;
    const recordsDirectory = join(this.#worldRoot(worldId), "records");
    try {
      const names = (await readdir(recordsDirectory))
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of names) {
        const parsed = parseArtifactJson<ArtifactRawRecord>(
          await readFile(join(recordsDirectory, name), "utf8"),
          "artifact raw record",
        );
        assertRawRecord(parsed);
        if (name !== artifactSequenceFileName(parsed.sequence))
          throw new ArtifactStoreCorruptionError(
            "artifact raw record 文件名与 sequence 不匹配",
          );
        if (parsed.worldId !== worldId)
          throw new ArtifactStoreCorruptionError(
            "artifact raw record 与 world 路径不匹配",
          );
        raw.push(parsed);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    for (const records of memory.values())
      for (const record of records)
        if (record.worldId === worldId) raw.push(record);
    raw.sort((left, right) => left.sequence - right.sequence);
    const recordIds = new Set<string>();
    const sequences = new Set<number>();
    for (const record of raw) {
      if (recordIds.has(record.recordId))
        throw new ArtifactStoreCorruptionError("artifact raw record ID 重复");
      if (sequences.has(record.sequence))
        throw new ArtifactStoreCorruptionError("artifact world sequence 重复");
      recordIds.add(record.recordId);
      sequences.add(record.sequence);
    }
    const state = new Map<
      string,
      { status: ArtifactRecordStatus; head: string | null }
    >();
    for (const record of raw)
      state.set(record.recordId, { status: "pending", head: null });
    const operationStates = new Map<string, ArtifactOperationFile>();
    for (const operation of await this.#operationsForWorld(worldId))
      operationStates.set(operation.context.operationId, operation);
    for (const record of raw) {
      const operation = operationStates.get(record.operationId);
      if (
        operation?.context.worldId !== record.worldId ||
        operation.context.parentHead !== record.parentHead ||
        operation.context.playPresetId !== record.playPresetId ||
        operation.context.playPresetRevision !== record.playPresetRevision ||
        operation.context.playPresetScriptsEnabled !==
          record.playPresetScriptsEnabled
      )
        throw new ArtifactStoreCorruptionError(
          "artifact raw record 与 operation 身份不匹配",
        );
    }
    const events = await this.#events(worldId);
    for (const event of events) {
      if (sequences.has(event.sequence))
        throw new ArtifactStoreCorruptionError("artifact world sequence 重复");
      sequences.add(event.sequence);
      const eventOperation = operationStates.get(event.operationId);
      if (eventOperation === undefined)
        throw new ArtifactStoreCorruptionError(
          "artifact projection event operation 不存在",
        );
      if (event.recordId !== undefined) {
        const record = raw.find(({ recordId }) => recordId === event.recordId);
        if (record?.operationId !== event.operationId)
          throw new ArtifactStoreCorruptionError(
            "artifact projection event 与 record 身份不匹配",
          );
      }
      if (event.kind === "activate" && event.recordId !== undefined) {
        const current = state.get(event.recordId);
        if (current?.status === "pending") current.status = "active";
      } else if (event.kind === "supersede" && event.recordId !== undefined) {
        const current = state.get(event.recordId);
        if (current !== undefined) current.status = "superseded";
      } else if (event.kind === "bind_head" && event.recordId !== undefined) {
        if (
          (eventOperation.status !== "core_committed" &&
            eventOperation.status !== "completed") ||
          eventOperation.head !== event.head
        )
          throw new ArtifactStoreCorruptionError(
            "artifact bind_head event 与 operation 核心 head 不匹配",
          );
        const current = state.get(event.recordId);
        if (current !== undefined) current.head = event.head ?? null;
      } else if (event.kind === "clear") {
        const initiator = operationStates.get(event.operationId);
        if (
          initiator === undefined ||
          initiator.artifactProjectionStatus === "superseded" ||
          (initiator.requestAttempts[event.requestId!] !== undefined &&
            initiator.requestAttempts[event.requestId!] !==
              event.requestAttempt)
        )
          continue;
        for (const record of raw) {
          const current = state.get(record.recordId);
          if (
            current !== undefined &&
            current.status !== "superseded" &&
            current.status !== "cleared" &&
            record.sequence < event.sequence &&
            record.channel === event.channel &&
            record.output === event.output &&
            (event.key === undefined || record.key === event.key)
          )
            current.status = "cleared";
        }
      }
    }
    return raw.map((record) => {
      const current = state.get(record.recordId);
      let status = current?.status ?? "failed";
      const operation = operationStates.get(record.operationId);
      const currentAttempt = operation?.requestAttempts[record.requestId];
      if (
        currentAttempt !== undefined &&
        currentAttempt !== record.requestAttempt &&
        status !== "failed"
      )
        status = "superseded";
      if (
        operation?.artifactProjectionStatus === "superseded" &&
        status !== "failed"
      )
        status = "superseded";
      return {
        record,
        status,
        head: current?.head ?? null,
      };
    });
  }

  async #events(worldId: string): Promise<ArtifactEvent[]> {
    const result: ArtifactEvent[] = [];
    const directory = join(this.#worldRoot(worldId), "events");
    try {
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of names) {
        const event = parseArtifactJson<ArtifactEvent>(
          await readFile(join(directory, name), "utf8"),
          "artifact projection event",
        );
        assertEvent(event);
        if (name !== artifactSequenceFileName(event.sequence))
          throw new ArtifactStoreCorruptionError(
            "artifact projection event 文件名与 sequence 不匹配",
          );
        result.push(event);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    for (const [operationId, events] of this.#memoryEvents) {
      const operation = await this.#readOperation(operationId);
      if (operation?.context.worldId === worldId) result.push(...events);
    }
    return result.sort((left, right) => left.sequence - right.sequence);
  }

  async #recordsForOperation(
    operationId: string,
  ): Promise<ArtifactRawRecord[]> {
    const operation = await this.#readOperation(operationId);
    if (operation === null) return this.#memoryRecords.get(operationId) ?? [];
    const records = await this.#effectiveRecords(operation.context.worldId);
    return records
      .filter(({ record }) => record.operationId === operationId)
      .map(({ record }) => record);
  }

  async #operationsForWorld(worldId: string): Promise<ArtifactOperationFile[]> {
    const byId = new Map<string, ArtifactOperationFile>();
    const directory = join(this.#root, "operations");
    try {
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of names) {
        const operation = parseArtifactJson<ArtifactOperationFile>(
          await readFile(join(directory, name), "utf8"),
          "artifact operation",
        );
        assertOperation(operation);
        if (name !== `${identityHash(operation.context.operationId)}.json`)
          throw new ArtifactStoreCorruptionError(
            "artifact operation 与文件路径身份不匹配",
          );
        if (byId.has(operation.context.operationId))
          throw new ArtifactStoreCorruptionError("artifact operation ID 重复");
        if (operation.context.worldId === worldId)
          byId.set(operation.context.operationId, structuredClone(operation));
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    return [...byId.values()];
  }

  async #nextSequence(worldId: string): Promise<number> {
    let maximum = 0;
    const directories = [
      join(this.#worldRoot(worldId), "records"),
      join(this.#worldRoot(worldId), "events"),
    ];
    for (const directory of directories) {
      try {
        const names = (await readdir(directory)).filter((name) =>
          name.endsWith(".json"),
        );
        for (const name of names) {
          const value = Number.parseInt(name.slice(0, -5), 10);
          if (
            !Number.isSafeInteger(value) ||
            value < 1 ||
            name !== artifactSequenceFileName(value)
          )
            throw new ArtifactStoreCorruptionError(
              "artifact sequence 文件名无效",
            );
          maximum = Math.max(maximum, value);
        }
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
    }
    for (const records of this.#memoryRecords.values())
      for (const record of records)
        if (record.worldId === worldId)
          maximum = Math.max(maximum, record.sequence);
    for (const [operationId, events] of this.#memoryEvents) {
      const operation = await this.#readOperation(operationId);
      if (operation?.context.worldId !== worldId) continue;
      for (const event of events) maximum = Math.max(maximum, event.sequence);
    }
    return maximum + 1;
  }

  async #readOperation(
    operationId: string,
  ): Promise<ArtifactOperationFile | null> {
    const path = join(
      this.#root,
      "operations",
      `${identityHash(operationId)}.json`,
    );
    try {
      const operation = parseArtifactJson<ArtifactOperationFile>(
        await readFile(path, "utf8"),
        "artifact operation",
      );
      assertOperation(operation);
      if (operation.context.operationId !== operationId)
        throw new ArtifactStoreCorruptionError(
          "artifact operation 与请求身份不匹配",
        );
      return operation;
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #writeOperation(operation: ArtifactOperationFile): Promise<void> {
    assertOperation(operation);
    const directory = join(this.#root, "operations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(
      directory,
      `${identityHash(operation.context.operationId)}.json`,
    );
    await writeDurableJson(path, operation, false);
  }

  async #worldForOperation(operationId: string): Promise<string | null> {
    const operation = await this.#readOperation(operationId);
    return operation?.context.worldId ?? null;
  }

  async #withWorldMutation<T>(
    worldId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const active = this.#mutationContext.getStore();
    if (active?.has(worldId) === true) return action();
    return withArtifactWorldLock(
      join(this.#root, "locks", identityHash(worldId)),
      () =>
        this.#mutationContext.run(
          new Set([...(active ?? []), worldId]),
          action,
        ),
    );
  }

  #worldRoot(worldId: string): string {
    return join(this.#root, "worlds", identityHash(worldId));
  }
}

const artifactWorldLockStaleMilliseconds = 30_000;
const artifactWorldLockWaitMilliseconds = 30_000;

async function withArtifactWorldLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const processIdentity = await artifactLocalProcessIdentity();
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + artifactWorldLockWaitMilliseconds;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const owner = await readArtifactLockOwner(path);
      if (owner !== null && (await artifactLockOwnerIsAlive(owner, path))) {
        if (Date.now() >= deadline)
          throw new Error("artifact world mutation lock is busy", {
            cause: error,
          });
        await artifactLockDelay(5);
        continue;
      }
      const metadata = await stat(path).catch(() => null);
      if (
        owner !== null ||
        (metadata !== null &&
          Date.now() - metadata.mtimeMs > artifactWorldLockStaleMilliseconds)
      )
        await retireArtifactWorldLock(path, owner, metadata, parent);
      if (Date.now() >= deadline)
        throw new Error("artifact world mutation lock is busy", {
          cause: error,
        });
      await artifactLockDelay(5);
    }
  }

  const ownerPath = join(path, "owner.json");
  const heartbeatPath = join(path, "heartbeat");
  let heartbeatHandle: Awaited<ReturnType<typeof open>> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    const handle = heartbeatHandle;
    if (handle === undefined)
      throw new ArtifactStoreInvariantError(
        "artifact world lock heartbeat 尚未初始化",
      );
    timer = setTimeout(() => {
      const now = new Date();
      heartbeat = handle
        .utimes(now, now)
        .catch(() => undefined)
        .finally(() => {
          if (!stopped) schedule();
        });
    }, 5_000);
  };
  try {
    await writeDurableJson(
      ownerPath,
      { token, pid: process.pid, processIdentity },
      true,
    );
    if (
      process.env.NARRAEON_INTERNAL_TEST_FAIL_AT_ARTIFACT_LOCK_EDGE ===
        "after_owner" &&
      process.env.NODE_ENV === "test"
    )
      throw new Error("simulated artifact lock setup failure");
    await writeDurableJson(heartbeatPath, { token }, true);
    heartbeatHandle = await open(heartbeatPath, "r+");
    schedule();
    return await action();
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await heartbeat;
    await heartbeatHandle?.close();
    await releaseArtifactWorldLock(path, token, parent);
  }
}

interface ArtifactLockOwner {
  token: string;
  pid: number;
  processIdentity: string;
}

async function readArtifactLockOwner(
  path: string,
): Promise<ArtifactLockOwner | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["token", "pid", "processIdentity"]) ||
    !isNonEmptyString(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !isNonEmptyString(value.processIdentity)
  )
    throw new ArtifactStoreCorruptionError(
      "artifact world mutation lock owner 损坏",
    );
  return value as unknown as ArtifactLockOwner;
}

async function retireArtifactWorldLock(
  path: string,
  observedOwner: ArtifactLockOwner | null,
  observedMetadata: { dev: number; ino: number; mtimeMs: number } | null,
  locksRoot: string,
): Promise<void> {
  if (observedOwner === null && observedMetadata === null) return;
  const currentOwner = await readArtifactLockOwner(path);
  const currentMetadata = await stat(path).catch(() => null);
  const sameGeneration =
    observedOwner === null
      ? currentOwner === null &&
        observedMetadata !== null &&
        currentMetadata !== null &&
        observedMetadata.dev === currentMetadata.dev &&
        observedMetadata.ino === currentMetadata.ino
      : currentOwner?.token === observedOwner.token;
  if (!sameGeneration) return;
  if (
    currentOwner !== null &&
    (await artifactLockOwnerIsAlive(currentOwner, path))
  )
    return;
  if (
    currentOwner === null &&
    (currentMetadata === null ||
      Date.now() - currentMetadata.mtimeMs <=
        artifactWorldLockStaleMilliseconds)
  )
    return;
  const generation =
    currentOwner?.token ??
    `inode-${currentMetadata?.dev ?? "missing"}-${currentMetadata?.ino ?? "missing"}`;
  const retired = `${path}.${identityHash(generation)}.${randomUUID()}.retired`;
  try {
    await rename(path, retired);
    await syncArtifactDirectory(locksRoot);
    await rm(retired, { recursive: true, force: true });
  } catch (error: unknown) {
    if (isMissing(error) || isAlreadyExists(error)) return;
    throw error;
  }
}

async function releaseArtifactWorldLock(
  path: string,
  token: string,
  locksRoot: string,
): Promise<void> {
  const owner = await readArtifactLockOwner(path);
  if (owner?.token !== token) return;
  const retired = `${path}.${identityHash(token)}.${randomUUID()}.retired`;
  try {
    await rename(path, retired);
    await syncArtifactDirectory(locksRoot);
    await rm(retired, { recursive: true, force: true });
  } catch (error: unknown) {
    if (isMissing(error) || isAlreadyExists(error)) return;
    throw error;
  }
}

let cachedArtifactProcessIdentity: Promise<string> | undefined;

function artifactLocalProcessIdentity(): Promise<string> {
  cachedArtifactProcessIdentity ??= artifactProcessIdentity(process.pid).then(
    (identity) => identity ?? `fallback:${process.pid}:${randomUUID()}`,
  );
  return cachedArtifactProcessIdentity;
}

async function artifactLockOwnerIsAlive(
  owner: ArtifactLockOwner,
  path: string,
): Promise<boolean> {
  const identity = await artifactProcessIdentity(owner.pid);
  if (identity === owner.processIdentity) return true;
  if (identity === null) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") return false;
      // Fall through to the heartbeat for non-Linux or inaccessible processes.
    }
  }
  const heartbeat = await stat(join(path, "heartbeat")).catch(() => null);
  return (
    heartbeat !== null &&
    Date.now() - heartbeat.mtimeMs <= artifactWorldLockStaleMilliseconds
  );
}

async function artifactProcessIdentity(pid: number): Promise<string | null> {
  try {
    const [bootId, namespace, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink(`/proc/${pid}/ns/pid`),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = processStat.lastIndexOf(") ");
    if (commandEnd < 0) return null;
    const fields = processStat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) return null;
    return `linux:${bootId.trim()}:${namespace}:${startTicks}`;
  } catch {
    return null;
  }
}

async function writeDurableJson(
  path: string,
  value: unknown,
  exclusive: boolean,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(target, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!exclusive) await rename(target, path);
    await syncArtifactDirectory(directory);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseArtifactJson<Value>(bytes: string, label: string): Value {
  try {
    return JSON.parse(bytes) as Value;
  } catch (error: unknown) {
    throw new ArtifactStoreCorruptionError(
      `${label} JSON 损坏`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function syncArtifactDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function artifactLockDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class InMemoryArtifactStore extends FileNativeArtifactStore {
  constructor() {
    super(join(tmpdir(), "narraeon-ephemeral-artifacts", randomUUID()));
  }
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
        message: `${declaration.name} 的 ${declaration.contentType} payload 必须是字符串`,
      };
    return { ok: true, value: input };
  }
  if (!isJsonValue(input))
    return {
      ok: false,
      message: "JSON artifact payload 必须是合法 JSON value",
    };
  try {
    JSON.stringify(input);
  } catch {
    return { ok: false, message: "JSON artifact payload 无法序列化" };
  }
  const contract = validatePlayPresetArtifactPayload(
    declaration.payloadContract,
    input,
  );
  if (!contract.ok) return contract;
  return { ok: true, value: structuredClone(input) };
}

function isJsonValue(value: unknown): value is ArtifactPayload {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function byteLength(payload: ArtifactPayload, contentType: string): number {
  return Buffer.byteLength(payloadText(payload, contentType), "utf8");
}

function payloadText(payload: ArtifactPayload, contentType: string): string {
  if (contentType === "application/json") return JSON.stringify(payload);
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function payloadFingerprint(output: string, payload: ArtifactPayload): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ output, payload })).digest("hex")}`;
}

function artifactCallFingerprint(
  toolName: "artifact_emit" | "artifact_clear",
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
        requestId: context.requestId,
        requestAttempt: context.requestAttempt,
        parameters,
      }),
    )
    .digest("hex")}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function rawRecordFingerprint(
  record: Omit<ArtifactRawRecord, "recordFingerprint"> | ArtifactRawRecord,
): string {
  const content: Partial<ArtifactRawRecord> = { ...record };
  delete content.recordFingerprint;
  return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

function sameEventIdentity(left: ArtifactEvent, right: ArtifactEvent): boolean {
  return (
    left.kind === right.kind &&
    left.operationId === right.operationId &&
    left.recordId === right.recordId &&
    left.output === right.output &&
    left.channel === right.channel &&
    left.key === right.key &&
    left.head === right.head &&
    left.requestId === right.requestId &&
    left.requestAttempt === right.requestAttempt &&
    left.reason === right.reason &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName &&
    left.callFingerprint === right.callFingerprint
  );
}

function artifactFailure(message: string): ArtifactToolResult {
  return { ok: false, markdown: `# Runtime 产物拒绝\n\n${message}` };
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

function identityHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifactSequenceFileName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

function summary(operation: ArtifactOperationFile): ArtifactExtensionSummary {
  return {
    operationId: operation.context.operationId,
    status: operation.extensionStatus,
    ...(operation.message === undefined ? {} : { message: operation.message }),
    completedRequests: [...operation.completedRequests],
    coreCommitted:
      operation.status === "core_materialization_pending" ||
      operation.status === "core_committed" ||
      operation.status === "completed",
    ...(operation.head === undefined ? {} : { head: operation.head }),
  };
}

function selectProjection(active: EffectiveRecord[]): EffectiveRecord[] {
  const append: EffectiveRecord[] = [];
  const replace = new Map<string, EffectiveRecord>();
  const upsert = new Map<string, EffectiveRecord>();
  for (const item of active.sort(
    (left, right) => left.record.sequence - right.record.sequence,
  )) {
    if (
      item.record.projection === "append" ||
      item.record.projection === "transient"
    )
      append.push(item);
    else if (item.record.projection === "replace")
      replace.set(item.record.channel, item);
    else if (item.record.projection === "upsert")
      upsert.set(`${item.record.channel}\0${item.record.key ?? ""}`, item);
  }
  return [...append, ...replace.values(), ...upsert.values()].sort(
    (left, right) => left.record.sequence - right.record.sequence,
  );
}

function assertContext(context: ArtifactOperationContext): void {
  if (
    !isRecord(context) ||
    !hasExactKeys(context, [
      "worldId",
      "parentHead",
      "operationId",
      "playPresetId",
      "playPresetRevision",
      "playPresetScriptsEnabled",
    ])
  )
    throw new ArtifactStoreInvariantError(
      "artifact operation context 结构无效",
    );
  for (const [key, value] of Object.entries({
    worldId: context.worldId,
    parentHead: context.parentHead,
    operationId: context.operationId,
    playPresetId: context.playPresetId,
    playPresetRevision: context.playPresetRevision,
  }))
    if (typeof value !== "string" || value.trim() === "")
      throw new ArtifactStoreInvariantError(`artifact ${key} 无效`);
  if (typeof context.playPresetScriptsEnabled !== "boolean")
    throw new ArtifactStoreInvariantError(
      "artifact playPresetScriptsEnabled 无效",
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
  });
  if (
    context.requestId.trim() === "" ||
    !Number.isInteger(context.requestAttempt)
  )
    throw new ArtifactStoreInvariantError("artifact request attempt 无效");
  if (context.requestAttempt < 1 || context.maxArtifactBytes < 0)
    throw new ArtifactStoreInvariantError(
      "artifact request attempt budget 无效",
    );
}

function sameContext(
  left: ArtifactOperationContext,
  right: ArtifactOperationContext,
): boolean {
  return (
    left.worldId === right.worldId &&
    left.parentHead === right.parentHead &&
    left.operationId === right.operationId &&
    left.playPresetId === right.playPresetId &&
    left.playPresetRevision === right.playPresetRevision &&
    left.playPresetScriptsEnabled === right.playPresetScriptsEnabled
  );
}

function assertRawRecord(record: ArtifactRawRecord): void {
  if (
    !isRecord(record) ||
    !hasExactKeys(
      record,
      [
        "schemaVersion",
        "recordId",
        "sequence",
        "worldId",
        "parentHead",
        "newHead",
        "operationId",
        "playPresetId",
        "playPresetRevision",
        "playPresetScriptsEnabled",
        "requestId",
        "requestAttempt",
        "output",
        "channel",
        "contentType",
        "payload",
        "save",
        "projection",
        "invalidation",
        "toolCallId",
        "toolName",
        "callFingerprint",
        "payloadFingerprint",
        "recordFingerprint",
        "status",
      ],
      ["key", "renderer", "rendererRevision"],
    ) ||
    record.schemaVersion !== 1 ||
    !isNonEmptyString(record.recordId) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    !isNonEmptyString(record.worldId) ||
    !isNonEmptyString(record.operationId) ||
    !isNonEmptyString(record.output) ||
    !isNonEmptyString(record.channel) ||
    !isNonEmptyString(record.parentHead) ||
    !isNonEmptyString(record.playPresetId) ||
    !isNonEmptyString(record.playPresetRevision) ||
    !isNonEmptyString(record.requestId) ||
    !Number.isSafeInteger(record.requestAttempt) ||
    record.requestAttempt < 1 ||
    record.newHead !== null ||
    typeof record.playPresetScriptsEnabled !== "boolean" ||
    !["text/plain", "text/markdown", "application/json", "text/html"].includes(
      record.contentType,
    ) ||
    !["none", "operation", "commit"].includes(record.save) ||
    !["append", "replace", "upsert", "transient", "hidden"].includes(
      record.projection,
    ) ||
    ![
      "new_operation",
      "head_change",
      "operation_end",
      "explicit_clear",
      "never",
    ].includes(record.invalidation) ||
    typeof record.toolCallId !== "string" ||
    record.toolName !== "artifact_emit" ||
    !isSha256(record.callFingerprint) ||
    !isSha256(record.payloadFingerprint) ||
    !isSha256(record.recordFingerprint) ||
    (record.renderer === undefined) !==
      (record.rendererRevision === undefined) ||
    (record.renderer !== undefined && !isNonEmptyString(record.renderer)) ||
    (record.rendererRevision !== undefined &&
      !isNonEmptyString(record.rendererRevision)) ||
    (record.projection === "upsert"
      ? !isNonEmptyString(record.key)
      : record.key !== undefined) ||
    record.status !== "pending"
  )
    throw new ArtifactStoreCorruptionError("artifact raw record 损坏");
  if (!isJsonValue(record.payload))
    throw new ArtifactStoreCorruptionError("artifact payload 不是 JSON value");
  if (
    record.payloadFingerprint !==
    payloadFingerprint(record.output, record.payload)
  )
    throw new ArtifactStoreCorruptionError(
      "artifact payload fingerprint 不匹配",
    );
  if (record.recordFingerprint !== rawRecordFingerprint(record))
    throw new ArtifactStoreCorruptionError(
      "artifact raw record fingerprint 不匹配",
    );
}

function assertOperation(operation: ArtifactOperationFile): void {
  const context = operation.context;
  if (
    !isRecord(operation) ||
    !hasExactKeys(
      operation,
      [
        "schemaVersion",
        "context",
        "status",
        "extensionStatus",
        "completedRequests",
        "artifactProjectionStatus",
        "requestAttempts",
      ],
      ["message", "head"],
    ) ||
    operation.schemaVersion !== 1 ||
    !isRecord(context) ||
    !hasExactKeys(context, [
      "worldId",
      "parentHead",
      "operationId",
      "playPresetId",
      "playPresetRevision",
      "playPresetScriptsEnabled",
    ]) ||
    !isNonEmptyString(context.worldId) ||
    !isNonEmptyString(context.parentHead) ||
    !isNonEmptyString(context.operationId) ||
    !isNonEmptyString(context.playPresetId) ||
    !isNonEmptyString(context.playPresetRevision) ||
    typeof context.playPresetScriptsEnabled !== "boolean" ||
    ![
      "running",
      "core_failed",
      "core_materialization_pending",
      "core_committed",
      "completed",
    ].includes(operation.status) ||
    ![
      "not_started",
      "running",
      "completed",
      "failed",
      "cancelled",
      "budget_exceeded",
      "unknown",
      "recovery_required",
      "superseded",
    ].includes(operation.extensionStatus) ||
    !Array.isArray(operation.completedRequests) ||
    !operation.completedRequests.every(isNonEmptyString) ||
    (operation.message !== undefined &&
      typeof operation.message !== "string") ||
    !validArtifactOperationState(operation) ||
    !["active", "superseded"].includes(operation.artifactProjectionStatus) ||
    !isRecord(operation.requestAttempts) ||
    !Object.entries(operation.requestAttempts).every(
      ([request, attempt]) =>
        request.trim() !== "" &&
        typeof attempt === "number" &&
        Number.isSafeInteger(attempt) &&
        attempt >= 1,
    )
  )
    throw new ArtifactStoreCorruptionError("artifact operation state 损坏");
}

function validArtifactOperationState(
  operation: ArtifactOperationFile,
): boolean {
  if (operation.status === "running")
    return (
      operation.extensionStatus === "not_started" &&
      operation.completedRequests.length === 0 &&
      operation.message === undefined &&
      operation.head === undefined
    );
  if (operation.status === "core_failed")
    return (
      operation.extensionStatus === "failed" &&
      operation.completedRequests.length === 0 &&
      operation.artifactProjectionStatus === "superseded" &&
      operation.head === undefined
    );
  if (operation.status === "core_materialization_pending")
    return (
      operation.extensionStatus === "recovery_required" &&
      operation.completedRequests.length === 0 &&
      operation.artifactProjectionStatus === "active" &&
      isNonEmptyString(operation.head) &&
      isNonEmptyString(operation.message)
    );
  if (operation.status === "completed")
    return (
      operation.extensionStatus === "completed" &&
      isNonEmptyString(operation.head) &&
      operation.message === undefined
    );
  if (!isNonEmptyString(operation.head)) return false;
  if (operation.extensionStatus === "completed") return false;
  if (
    operation.extensionStatus === "not_started" ||
    operation.extensionStatus === "running"
  )
    return (
      operation.completedRequests.length === 0 &&
      operation.message === undefined
    );
  return (
    isNonEmptyString(operation.message) &&
    (operation.extensionStatus !== "superseded" ||
      operation.artifactProjectionStatus === "superseded")
  );
}

function assertEvent(event: ArtifactEvent): void {
  if (
    !isRecord(event) ||
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !isNonEmptyString(event.operationId)
  )
    throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
  const requestPair =
    event.requestId === undefined && event.requestAttempt === undefined
      ? true
      : isNonEmptyString(event.requestId) &&
        Number.isSafeInteger(event.requestAttempt) &&
        Number(event.requestAttempt) >= 1;
  if (event.kind === "activate") {
    if (
      !hasExactKeys(
        event,
        ["schemaVersion", "kind", "sequence", "operationId", "recordId"],
        ["requestId", "requestAttempt"],
      ) ||
      !isNonEmptyString(event.recordId) ||
      !requestPair
    )
      throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
    return;
  }
  if (event.kind === "bind_head") {
    if (
      !hasExactKeys(event, [
        "schemaVersion",
        "kind",
        "sequence",
        "operationId",
        "recordId",
        "head",
      ]) ||
      !isNonEmptyString(event.recordId) ||
      !isNonEmptyString(event.head)
    )
      throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
    return;
  }
  if (event.kind === "supersede") {
    if (
      !hasExactKeys(
        event,
        [
          "schemaVersion",
          "kind",
          "sequence",
          "operationId",
          "recordId",
          "reason",
        ],
        ["requestId", "requestAttempt"],
      ) ||
      !isNonEmptyString(event.recordId) ||
      !isNonEmptyString(event.reason) ||
      !requestPair
    )
      throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
    return;
  }
  if (event.kind === "clear" || event.kind === "ignored_call") {
    if (
      !hasExactKeys(
        event,
        [
          "schemaVersion",
          "kind",
          "sequence",
          "operationId",
          "output",
          "channel",
          "reason",
          "toolCallId",
          "toolName",
          "callFingerprint",
          "requestId",
          "requestAttempt",
        ],
        ["key"],
      ) ||
      !isNonEmptyString(event.output) ||
      !isNonEmptyString(event.channel) ||
      !isNonEmptyString(event.reason) ||
      !isNonEmptyString(event.toolCallId) ||
      event.toolName !== "artifact_clear" ||
      !isSha256(event.callFingerprint) ||
      !isNonEmptyString(event.requestId) ||
      !Number.isSafeInteger(event.requestAttempt) ||
      Number(event.requestAttempt) < 1 ||
      (event.key !== undefined && !isNonEmptyString(event.key))
    )
      throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
    return;
  }
  throw new ArtifactStoreCorruptionError("artifact projection event 损坏");
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
