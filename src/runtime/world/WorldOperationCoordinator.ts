import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type WorldQueue, worldQueueFor } from "./WorldQueue.ts";

/** Durable, non-expiring ownership of one world-revision epoch. */
export interface WorldRevisionLockHandle {
  worldId: string;
  epochId: string;
}

export class WorldOperationClaimLostError extends Error {
  constructor() {
    super("world operation claim was lost");
    this.name = "WorldOperationClaimLostError";
  }
}

export class WorldOperationBusyError extends Error {
  constructor() {
    super("world operation lock is busy");
    this.name = "WorldOperationBusyError";
  }
}

interface WorldRevisionLockRecord extends WorldRevisionLockHandle {
  schemaVersion: 1;
  kind: "world_revision_lock";
  acquiredAt: number;
}

/**
 * Coordinates world mutations inside the single service process.
 *
 * Every world-changing operation runs through the data root's `WorldQueue`,
 * so no cross-process lock files exist. A world-revision epoch persists
 * because its edit-mode state survives restarts.
 */
export class FileNativeWorldOperationCoordinator {
  readonly #revisionLocksRoot: string;
  readonly #queue: WorldQueue;

  constructor(dataRoot: string) {
    const root = resolve(dataRoot);
    this.#revisionLocksRoot = join(root, "operations", "world-revision-locks");
    this.#queue = worldQueueFor(root);
  }

  async withExclusiveWorldStateMutation<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#queue.run(worldId, async () => {
      if ((await this.#readRevisionLock(worldId)) !== null)
        throw new WorldOperationBusyError();
      return action();
    });
  }

  /**
   * Acquire or resume a persistent revision lock. The lock deliberately has no
   * lease timeout: only Apply or Discard may release its epoch.
   */
  async acquireWorldRevision(
    worldId: string,
    epochId: string,
  ): Promise<
    | { kind: "acquired"; handle: WorldRevisionLockHandle }
    | { kind: "busy"; epochId?: string }
  > {
    assertNonEmptyIdentity(worldId, "world ID");
    assertNonEmptyIdentity(epochId, "world-revision epoch ID");
    return this.#queue.run(worldId, async () => {
      const existing = await this.#readRevisionLock(worldId);
      if (existing !== null)
        return existing.epochId === epochId
          ? {
              kind: "acquired",
              handle: revisionLockHandle(existing),
            }
          : { kind: "busy", epochId: existing.epochId };
      const record: WorldRevisionLockRecord = {
        schemaVersion: 1,
        kind: "world_revision_lock",
        worldId,
        epochId,
        acquiredAt: Date.now(),
      };
      await publishJson(this.#revisionLockPath(worldId), record);
      return { kind: "acquired", handle: revisionLockHandle(record) };
    });
  }

  async readWorldRevisionLock(
    worldId: string,
  ): Promise<WorldRevisionLockHandle | null> {
    assertNonEmptyIdentity(worldId, "world ID");
    const record = await this.#queue.run(worldId, () =>
      this.#readRevisionLock(worldId),
    );
    return record === null ? null : revisionLockHandle(record);
  }

  async assertWorldRevisionUnlocked(worldId: string): Promise<void> {
    assertNonEmptyIdentity(worldId, "world ID");
    const record = await this.#queue.run(worldId, () =>
      this.#readRevisionLock(worldId),
    );
    if (record !== null) throw new WorldOperationBusyError();
  }

  async withWorldRevisionLock<Value>(
    handle: WorldRevisionLockHandle,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertWorldRevisionLockHandle(handle);
    return this.#queue.run(handle.worldId, async () => {
      const current = await this.#readRevisionLock(handle.worldId);
      if (current?.epochId !== handle.epochId)
        throw new WorldOperationClaimLostError();
      return action();
    });
  }

  async releaseWorldRevision(handle: WorldRevisionLockHandle): Promise<void> {
    assertWorldRevisionLockHandle(handle);
    await this.#queue.run(handle.worldId, async () => {
      const current = await this.#readRevisionLock(handle.worldId);
      if (current?.epochId !== handle.epochId) return;
      await rm(this.#revisionLockPath(handle.worldId), { force: true });
    });
  }

  async withWorldLocalMetadataMutation<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#queue.run(worldId, action);
  }

  /** Runs a world-changing action in the world's in-process queue. */
  async withWorldAuthorityLock<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#queue.run(worldId, action);
  }

  /** True while the current async context already holds this world's queue slot. */
  isWorldHeld(worldId: string): boolean {
    return this.#queue.isHeld(worldId);
  }

  /** World operations for this world that are running or waiting for their turn. */
  pendingWorldOperations(worldId: string): number {
    return this.#queue.pendingCount(worldId);
  }

  async #readRevisionLock(
    worldId: string,
  ): Promise<WorldRevisionLockRecord | null> {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(this.#revisionLockPath(worldId), "utf8"),
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (!isWorldRevisionLockRecord(value) || value.worldId !== worldId)
      throw new Error("invalid world revision lock");
    return value;
  }

  #revisionLockPath(worldId: string): string {
    return join(this.#revisionLocksRoot, `${digest(worldId)}.json`);
  }
}

function isWorldRevisionLockRecord(
  value: unknown,
): value is WorldRevisionLockRecord {
  return (
    record(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "worldId",
      "epochId",
      "acquiredAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === "world_revision_lock" &&
    nonEmptyString(value.worldId) &&
    nonEmptyString(value.epochId) &&
    finiteNumber(value.acquiredAt)
  );
}

function assertWorldRevisionLockHandle(handle: WorldRevisionLockHandle): void {
  assertNonEmptyIdentity(handle.worldId, "world ID");
  assertNonEmptyIdentity(handle.epochId, "world-revision epoch ID");
}

function revisionLockHandle(
  record: WorldRevisionLockRecord,
): WorldRevisionLockHandle {
  return { worldId: record.worldId, epochId: record.epochId };
}

async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function assertNonEmptyIdentity(value: string, label: string): void {
  if (value.trim() === "") throw new TypeError(`${label} is invalid`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
