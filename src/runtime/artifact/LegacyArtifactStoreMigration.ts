import { readdir, readFile, rm, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactStoreCorruptionError,
  artifactSequenceFileName,
  assertOperation,
  assertRawRecord,
  identityHash,
  isMissing,
  isNonEmptyString,
  isRecord,
  parseArtifactJson,
  payloadFingerprint,
  rawRecordFingerprint,
  writeArtifactJson,
  type ArtifactOperationFile,
  type ArtifactRawRecord,
} from "./ArtifactStoreFiles.ts";

/**
 * One-way migration from the released `artifact-store/` layout (v0.6.0,
 * ADR-0036) to per-world `artifacts/`. The legacy layout kept immutable
 * records, a projection-event log, and operation files outside the world
 * directory. Its statuses were derived by replaying events, and that replay
 * is performed here once; the records written out carry the result.
 *
 * A world can also still hold an unexpanded fork snapshot
 * (`runtime/artifact-fork.json`) from before the fork change. It is treated as
 * the source when no `fork-restored.json` marker exists.
 *
 * Migration is idempotent and restartable: the sources are deleted only after
 * the complete output is written. A crash before that leaves the sources in
 * place, and the next run rebuilds the output from them.
 */

interface LegacyRecord extends Omit<ArtifactRawRecord, "status" | "head"> {
  newHead?: null;
  status: "pending";
}

type LegacyEvent =
  | {
      schemaVersion: 1;
      kind: "activate";
      sequence: number;
      operationId: string;
      recordId: string;
    }
  | {
      schemaVersion: 1;
      kind: "supersede";
      sequence: number;
      operationId: string;
      recordId: string;
    }
  | {
      schemaVersion: 1;
      kind: "bind_head";
      sequence: number;
      operationId: string;
      recordId: string;
      head: string;
    }
  | {
      schemaVersion: 1;
      kind: "clear";
      sequence: number;
      operationId: string;
      output: string;
      channel: string;
      key?: string;
      requestId: string;
      requestAttempt: number;
    }
  | {
      schemaVersion: 1;
      kind: "ignored_call";
      sequence: number;
      operationId: string;
    };

interface LegacyFork {
  schemaVersion: 1;
  worldId: string;
  operations: ArtifactOperationFile[];
  records: LegacyRecord[];
  events: LegacyEvent[];
}

interface LegacySource {
  records: LegacyRecord[];
  events: LegacyEvent[];
  operations: ArtifactOperationFile[];
  /** Legacy operations for this world, deleted once folded. */
  legacyOperationPaths: string[];
}

/** Whether this world still has artifact state in the released layout. */
export async function hasLegacyArtifactState(
  dataRoot: string,
  worldId: string,
): Promise<boolean> {
  if (await exists(legacyWorldRoot(dataRoot, worldId))) return true;
  return (
    (await exists(forkSnapshotPath(dataRoot, worldId))) &&
    !(await exists(forkRestoredMarker(dataRoot, worldId)))
  );
}

/** Folds one world's released artifact state into `artifacts/`, then deletes the released copies. */
export async function migrateLegacyArtifactStore(
  dataRoot: string,
  worldId: string,
): Promise<void> {
  if (!(await hasLegacyArtifactState(dataRoot, worldId))) return;
  const source = await readLegacySource(dataRoot, worldId);
  const folded = foldLegacy(source);
  await writeFolded(dataRoot, worldId, folded);
  await rm(forkSnapshotPath(dataRoot, worldId), { force: true });
  await rm(forkRestoredMarker(dataRoot, worldId), { force: true });
  await rm(legacyWorldRoot(dataRoot, worldId), {
    recursive: true,
    force: true,
  });
  for (const path of source.legacyOperationPaths)
    await rm(path, { force: true });
  await removeEmptyLegacyRoot(dataRoot);
}

async function readLegacySource(
  dataRoot: string,
  worldId: string,
): Promise<LegacySource> {
  const legacyOperationPaths = await legacyOperationPathsFor(dataRoot, worldId);
  const pending = await readPendingFork(dataRoot, worldId);
  if (pending !== null)
    return {
      records: pending.records,
      events: pending.events,
      operations: pending.operations,
      legacyOperationPaths,
    };
  const worldRoot = legacyWorldRoot(dataRoot, worldId);
  const operations: ArtifactOperationFile[] = [];
  for (const path of legacyOperationPaths)
    operations.push(
      parseArtifactJson<ArtifactOperationFile>(
        await readFile(path, "utf8"),
        "legacy artifact operation",
      ),
    );
  return {
    records: await readJsonDirectory<LegacyRecord>(
      join(worldRoot, "records"),
      "legacy artifact raw record",
    ),
    events: await readJsonDirectory<LegacyEvent>(
      join(worldRoot, "events"),
      "legacy artifact projection event",
    ),
    operations,
    legacyOperationPaths,
  };
}

async function readPendingFork(
  dataRoot: string,
  worldId: string,
): Promise<LegacyFork | null> {
  if (await exists(forkRestoredMarker(dataRoot, worldId))) return null;
  let bytes: string;
  try {
    bytes = await readFile(forkSnapshotPath(dataRoot, worldId), "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  const snapshot = parseArtifactJson<LegacyFork>(bytes, "legacy artifact fork");
  if (
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== 1 ||
    snapshot.worldId !== worldId ||
    !Array.isArray(snapshot.operations) ||
    !Array.isArray(snapshot.records) ||
    !Array.isArray(snapshot.events)
  )
    throw new ArtifactStoreCorruptionError("Artifact fork snapshot is invalid");
  for (const operation of snapshot.operations) {
    assertLegacyOperation(operation);
    if (operation.context.worldId !== worldId)
      throw new ArtifactStoreCorruptionError("Artifact fork world mismatch");
  }
  return snapshot;
}

function assertLegacyOperation(operation: ArtifactOperationFile): void {
  if ((operation.status as string) === "core_materialization_pending")
    throw new ArtifactStoreCorruptionError(
      "Artifact operation awaits a materialization that no longer exists",
    );
  assertOperation(operation);
}

/**
 * Replays the released event log exactly as the released reader did, then
 * writes each record's resulting status and head. A record's own fingerprint
 * must still match its released content, so a damaged source is rejected.
 */
function foldLegacy(source: LegacySource): {
  records: ArtifactRawRecord[];
  operations: ArtifactOperationFile[];
} {
  const operations = new Map(
    source.operations.map((operation) => {
      assertLegacyOperation(operation);
      return [operation.context.operationId, operation] as const;
    }),
  );
  const raw = [...source.records].sort((a, b) => a.sequence - b.sequence);
  const sequences = new Set<number>();
  const recordIds = new Set<string>();
  for (const record of raw) {
    if (
      record.newHead !== null ||
      record.status !== "pending" ||
      record.recordFingerprint !== rawRecordFingerprint(record) ||
      record.payloadFingerprint !==
        payloadFingerprint(record.output, record.payload) ||
      recordIds.has(record.recordId) ||
      sequences.has(record.sequence) ||
      !isNonEmptyString(record.recordId)
    )
      throw new ArtifactStoreCorruptionError(
        "Legacy artifact raw record is corrupt",
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
        "Legacy artifact raw record does not match the operation identity",
      );
  }
  const events = [...source.events].sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    if (sequences.has(event.sequence))
      throw new ArtifactStoreCorruptionError(
        "Artifact world sequence is duplicated",
      );
    sequences.add(event.sequence);
  }

  const state = new Map<
    string,
    {
      status: "pending" | "active" | "superseded" | "cleared";
      head: string | null;
    }
  >();
  for (const record of raw)
    state.set(record.recordId, { status: "pending", head: null });
  for (const event of events) {
    const eventOperation = operations.get(event.operationId);
    if (eventOperation === undefined)
      throw new ArtifactStoreCorruptionError(
        "Artifact projection-event operation does not exist",
      );
    if (event.kind === "ignored_call") continue;
    if (event.kind === "clear") {
      if (
        eventOperation.artifactProjectionStatus === "superseded" ||
        (eventOperation.requestAttempts[event.requestId] !== undefined &&
          eventOperation.requestAttempts[event.requestId] !==
            event.requestAttempt)
      )
        continue;
      for (const record of raw) {
        const current = state.get(record.recordId)!;
        if (
          current.status !== "superseded" &&
          current.status !== "cleared" &&
          record.sequence < event.sequence &&
          record.channel === event.channel &&
          record.output === event.output &&
          (event.key === undefined || record.key === event.key)
        )
          current.status = "cleared";
      }
      continue;
    }
    const record = raw.find(({ recordId }) => recordId === event.recordId);
    if (record?.operationId !== event.operationId)
      throw new ArtifactStoreCorruptionError(
        "Artifact projection event does not match the record identity",
      );
    const current = state.get(record.recordId)!;
    if (event.kind === "activate") {
      if (current.status === "pending") current.status = "active";
    } else if (event.kind === "supersede") {
      current.status = "superseded";
    } else {
      if (
        (eventOperation.status !== "core_committed" &&
          eventOperation.status !== "completed") ||
        eventOperation.head !== event.head
      )
        throw new ArtifactStoreCorruptionError(
          "Artifact bind_head event does not match the operation core head",
        );
      current.head = event.head;
    }
  }

  const records = raw.map((record) => {
    const current = state.get(record.recordId)!;
    const operation = operations.get(record.operationId);
    const currentAttempt = operation?.requestAttempts[record.requestId];
    const superseded =
      (currentAttempt !== undefined &&
        currentAttempt !== record.requestAttempt) ||
      operation?.artifactProjectionStatus === "superseded";
    const next: Omit<ArtifactRawRecord, "recordFingerprint"> & {
      newHead?: null;
    } = {
      ...record,
      status: superseded ? "superseded" : current.status,
      head: current.head,
    };
    delete next.newHead;
    const folded = { ...next, recordFingerprint: rawRecordFingerprint(next) };
    assertRawRecord(folded);
    return folded;
  });
  return {
    records,
    operations: [...operations.values()],
  };
}

async function writeFolded(
  dataRoot: string,
  worldId: string,
  folded: { records: ArtifactRawRecord[]; operations: ArtifactOperationFile[] },
): Promise<void> {
  const artifacts = join(worldsRoot(dataRoot), worldId, "artifacts");
  await rm(join(artifacts, "records"), { recursive: true, force: true });
  await rm(join(artifacts, "operations"), { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  for (const record of folded.records)
    await writeArtifactJson(
      join(artifacts, "records", artifactSequenceFileName(record.sequence)),
      record,
    );
  for (const operation of folded.operations) {
    assertOperation(operation);
    await writeArtifactJson(
      join(
        artifacts,
        "operations",
        `${identityHash(operation.context.operationId)}.json`,
      ),
      operation,
    );
  }
}

async function removeEmptyLegacyRoot(dataRoot: string): Promise<void> {
  const root = join(dataRoot, "artifact-store");
  if (
    (await entries(join(root, "worlds"))).length === 0 &&
    (await entries(join(root, "operations"))).length === 0
  )
    await rm(root, { recursive: true, force: true });
}

async function legacyOperationPathsFor(
  dataRoot: string,
  worldId: string,
): Promise<string[]> {
  const directory = join(dataRoot, "artifact-store", "operations");
  const paths: string[] = [];
  for (const name of await entries(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const operation = parseArtifactJson<ArtifactOperationFile>(
      await readFile(path, "utf8"),
      "legacy artifact operation",
    );
    if (operation.context?.worldId === worldId) paths.push(path);
  }
  return paths;
}

async function readJsonDirectory<Value>(
  directory: string,
  label: string,
): Promise<Value[]> {
  const values: Value[] = [];
  for (const name of (await entries(directory))
    .filter((item) => item.endsWith(".json"))
    .sort())
    values.push(
      parseArtifactJson<Value>(
        await readFile(join(directory, name), "utf8"),
        label,
      ),
    );
  return values;
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function worldsRoot(dataRoot: string): string {
  return join(dataRoot, "worlds-file-native");
}

function legacyWorldRoot(dataRoot: string, worldId: string): string {
  return join(dataRoot, "artifact-store", "worlds", identityHash(worldId));
}

function forkSnapshotPath(dataRoot: string, worldId: string): string {
  return join(worldsRoot(dataRoot), worldId, "runtime", "artifact-fork.json");
}

function forkRestoredMarker(dataRoot: string, worldId: string): string {
  return join(worldsRoot(dataRoot), worldId, "fork-restored.json");
}
