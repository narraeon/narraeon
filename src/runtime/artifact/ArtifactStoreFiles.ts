import type { WorldExtensionControl } from "../../protocol/worldExtensions.ts";
import { isWorldExtensionControl } from "../../protocol/worldExtensions.ts";
import type { FrozenArtifactPresentation } from "../play/FileNativePlayPresetStore.ts";
import type { PlayPresetArtifactDeclaration } from "../play/FileNativePlayPresetStore.ts";
import { isFrozenArtifactPresentation } from "../play/FileNativePlayPresetStore.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ArtifactAttachment,
  ArtifactOperationContext,
  ArtifactPayload,
  ArtifactRecordStatus,
} from "./FileNativeArtifactStore.ts";

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

/** One artifact on disk. Its status and head are current, not replayed from events. */
export interface ArtifactRawRecord {
  extensionControl?: WorldExtensionControl;
  frozenPresentation?: FrozenArtifactPresentation;
  schemaVersion: 1;
  recordId: string;
  sequence: number;
  worldId: string;
  parentHead: string;
  /** Core head this record is bound to once its operation has committed. */
  head: string | null;
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
  projection: PlayPresetArtifactDeclaration["strategy"];
  invalidation: PlayPresetArtifactDeclaration["invalidation"];
  toolCallId: string;
  toolName: "artifact_emit";
  callFingerprint: string;
  payloadFingerprint: string;
  recordFingerprint: string;
  status: ArtifactRecordStatus;
  /**
   * Set when a clear marked this record cleared. A later attempt of the same
   * request restores it, so a failed attempt's clear does not persist.
   */
  clearedBy?: ArtifactClearedBy;
}

export interface ArtifactClearedBy {
  operationId: string;
  requestId: string;
  requestAttempt: number;
  priorStatus: "pending" | "active";
}

export interface ArtifactRequestProgressFile {
  requestId: string;
  displayName: string;
  mounts: string[];
  status: "running" | "completed" | "failed";
}

/** One operation's lifecycle, kept beside the records of its world. */
export interface ArtifactOperationFile {
  requests?: ArtifactRequestProgressFile[];
  schemaVersion: 1;
  context: ArtifactOperationContext;
  status: "running" | "core_failed" | "core_committed" | "completed";
  extensionStatus:
    | "not_started"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exceeded"
    | "unknown"
    | "recovery_required"
    | "superseded";
  message?: string;
  completedRequests: string[];
  head?: string;
  artifactProjectionStatus: "active" | "superseded";
  /** Latest registered attempt per request; a retry of the same request supersedes older attempts. */
  requestAttempts: Record<string, number>;
}

export function artifactSequenceFileName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

export function identityHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function rawRecordFingerprint(record: object): string {
  const content: Partial<ArtifactRawRecord> = { ...record };
  delete content.recordFingerprint;
  return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

export function payloadFingerprint(
  output: string,
  payload: ArtifactPayload,
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ output, payload })).digest("hex")}`;
}

export function stableSerialize(value: unknown): string {
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

/** Heads are linear: genesis is round 0 and commit:N is round N. */
export function headOrdinal(head: string): number {
  if (head === "genesis") return 0;
  const match = /^commit:([1-9][0-9]*)$/u.exec(head);
  if (match === null)
    throw new ArtifactStoreInvariantError("Artifact head is invalid");
  return Number(match[1]);
}

/**
 * Writes a JSON file by temporary file and rename. The temporary name is
 * unique, so an interrupted write never leaves a partial file under `path`.
 */
export async function writeArtifactJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(target, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.close();
    handle = undefined;
    await rename(target, path);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseArtifactJson<Value>(bytes: string, label: string): Value {
  try {
    return JSON.parse(bytes) as Value;
  } catch (error: unknown) {
    throw new ArtifactStoreCorruptionError(
      `${label} JSON is corrupt`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
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

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function isJsonValue(value: unknown): value is ArtifactPayload {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

export function validAttachment(value: unknown): value is ArtifactAttachment {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["contextId", "eventId", "runId", "head"]) &&
    isNonEmptyString(value.head) &&
    isNonEmptyString(value.contextId) &&
    isNonEmptyString(value.runId) &&
    typeof value.eventId === "number" &&
    Number.isSafeInteger(value.eventId) &&
    value.eventId > 0
  );
}

export function assertRawRecord(record: ArtifactRawRecord): void {
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
        "head",
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
      [
        "key",
        "renderer",
        "rendererRevision",
        "frozenPresentation",
        "extensionControl",
        "clearedBy",
      ],
    ) ||
    (record.clearedBy !== undefined &&
      !isClearedBy(record.clearedBy, record.status)) ||
    (record.extensionControl !== undefined &&
      !isWorldExtensionControl(record.extensionControl)) ||
    (record.frozenPresentation !== undefined &&
      !isFrozenArtifactPresentation(record.frozenPresentation)) ||
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
    (record.head !== null && !isNonEmptyString(record.head)) ||
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
    !["pending", "active", "superseded", "cleared"].includes(record.status) ||
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
      : record.key !== undefined)
  )
    throw new ArtifactStoreCorruptionError("Artifact raw record is corrupt");
  if (!isJsonValue(record.payload))
    throw new ArtifactStoreCorruptionError(
      "Artifact payload is not a JSON value",
    );
  if (
    record.payloadFingerprint !==
    payloadFingerprint(record.output, record.payload)
  )
    throw new ArtifactStoreCorruptionError(
      "Artifact payload fingerprint does not match",
    );
  if (record.recordFingerprint !== rawRecordFingerprint(record))
    throw new ArtifactStoreCorruptionError(
      "Artifact raw-record fingerprint does not match",
    );
}

function isClearedBy(value: unknown, status: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "operationId",
      "requestId",
      "requestAttempt",
      "priorStatus",
    ]) &&
    status === "cleared" &&
    isNonEmptyString(value.operationId) &&
    isNonEmptyString(value.requestId) &&
    Number.isSafeInteger(value.requestAttempt) &&
    (value.requestAttempt as number) >= 1 &&
    (value.priorStatus === "pending" || value.priorStatus === "active")
  );
}

export function assertOperation(operation: ArtifactOperationFile): void {
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
      ["message", "head", "requests"],
    ) ||
    (operation.requests !== undefined &&
      (!Array.isArray(operation.requests) ||
        !operation.requests.every(
          (item) =>
            isRecord(item) &&
            hasExactKeys(item, [
              "requestId",
              "displayName",
              "mounts",
              "status",
            ]) &&
            isNonEmptyString(item.requestId) &&
            isNonEmptyString(item.displayName) &&
            Array.isArray(item.mounts) &&
            item.mounts.every(
              (mount) =>
                typeof mount === "string" &&
                [
                  "story",
                  "sidebar",
                  "composer_above",
                  "composer_below",
                  "overlay",
                  "debug",
                ].includes(mount),
            ) &&
            ["running", "completed", "failed"].includes(item.status),
        ))) ||
    operation.schemaVersion !== 1 ||
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
    ) ||
    (context.attachment !== undefined &&
      !validAttachment(context.attachment)) ||
    !isNonEmptyString(context.worldId) ||
    !isNonEmptyString(context.parentHead) ||
    !isNonEmptyString(context.operationId) ||
    !isNonEmptyString(context.playPresetId) ||
    !isNonEmptyString(context.playPresetRevision) ||
    typeof context.playPresetScriptsEnabled !== "boolean" ||
    !["running", "core_failed", "core_committed", "completed"].includes(
      operation.status,
    ) ||
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
    throw new ArtifactStoreCorruptionError(
      "Artifact operation state is corrupt",
    );
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
