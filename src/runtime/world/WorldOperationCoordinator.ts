import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ContinuityCorrectionWorldClaimHandle {
  worldId: string;
  operationId: string;
  owner: string;
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

interface CorrectionClaimRecord extends ContinuityCorrectionWorldClaimHandle {
  schemaVersion: 1;
  kind: "continuity_correction_claim";
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  renewalCount: number;
}

interface WorldLockOwnerRecord {
  schemaVersion: 1;
  kind: "world_operation_lock_owner";
  token: string;
  pid: number;
  processIdentity: string;
}

const worldLockHeartbeatIntervalMilliseconds = 5_000;
const worldLockHeartbeatStaleMilliseconds = 30_000;

/**
 * Coordinates current world mutations across processes.
 *
 * Short mutations hold a persistent world lock for their full duration.
 * Continuity correction also owns a renewable claim while the user reviews a
 * candidate, so another process cannot change the bound world in between.
 */
export class FileNativeWorldOperationCoordinator {
  readonly #correctionClaimsRoot: string;
  readonly #locksRoot: string;
  readonly #authorityLocksRoot: string;
  readonly #now: () => number;
  readonly #claimDurationMs: number;
  readonly #owner: () => string;

  constructor(
    dataRoot: string,
    options: {
      now?: () => number;
      claimDurationMs?: number;
      owner?: () => string;
    } = {},
  ) {
    const root = join(resolve(dataRoot), "operations");
    this.#correctionClaimsRoot = join(root, "correction-claims");
    this.#locksRoot = join(root, "world-locks");
    this.#authorityLocksRoot = join(root, "authority-locks");
    this.#now = options.now ?? Date.now;
    this.#claimDurationMs = options.claimDurationMs ?? 60_000;
    this.#owner = options.owner ?? randomUUID;
    if (
      !Number.isSafeInteger(this.#claimDurationMs) ||
      this.#claimDurationMs < 100
    )
      throw new TypeError("world operation claim duration is invalid");
  }

  async claimCorrectionWorld<Value>(
    worldId: string,
    operationId: string,
    action: () => Promise<Value>,
  ): Promise<
    | {
        kind: "claimed";
        handle: ContinuityCorrectionWorldClaimHandle;
        value: Value;
      }
    | { kind: "busy" }
  > {
    assertNonEmptyIdentity(worldId, "world ID");
    assertNonEmptyIdentity(operationId, "correction operation ID");
    return this.#withWorldLock(worldId, async () => {
      if ((await this.#reconcileCorrectionClaim(worldId)) !== null)
        return { kind: "busy" };
      const now = this.#now();
      const record: CorrectionClaimRecord = {
        schemaVersion: 1,
        kind: "continuity_correction_claim",
        worldId,
        operationId,
        owner: this.#owner(),
        acquiredAt: now,
        renewedAt: now,
        expiresAt: now + this.#claimDurationMs,
        renewalCount: 0,
      };
      await publishJson(this.#correctionClaimPath(worldId), record);
      try {
        return {
          kind: "claimed",
          handle: correctionClaimHandle(record),
          value: await action(),
        };
      } catch (error: unknown) {
        await this.#removeCorrectionClaim(record);
        throw error;
      }
    });
  }

  async renewCorrectionWorld(
    handle: ContinuityCorrectionWorldClaimHandle,
  ): Promise<void> {
    assertCorrectionClaimHandle(handle);
    await this.#withWorldLock(handle.worldId, async () => {
      const current = await this.#readCorrectionClaim(handle.worldId);
      if (!sameCorrectionClaimOwner(current, handle))
        throw new WorldOperationClaimLostError();
      if (current.expiresAt <= this.#now()) {
        await this.#removeCorrectionClaim(current);
        throw new WorldOperationClaimLostError();
      }
      const renewedAt = Math.max(current.renewedAt, this.#now());
      await publishJson(this.#correctionClaimPath(handle.worldId), {
        ...current,
        renewedAt,
        expiresAt: renewedAt + this.#claimDurationMs,
        renewalCount: current.renewalCount + 1,
      } satisfies CorrectionClaimRecord);
    });
  }

  async withCorrectionWorldClaim<Value>(
    handle: ContinuityCorrectionWorldClaimHandle,
    action: () => Promise<Value>,
  ): Promise<Value> {
    await this.renewCorrectionWorld(handle);
    return action();
  }

  async releaseCorrectionWorld(
    handle: ContinuityCorrectionWorldClaimHandle,
  ): Promise<void> {
    assertCorrectionClaimHandle(handle);
    await this.#withWorldLock(handle.worldId, async () => {
      const current = await this.#readCorrectionClaim(handle.worldId);
      if (sameCorrectionClaimOwner(current, handle))
        await this.#removeCorrectionClaim(current);
    });
  }

  async withExclusiveWorldStateMutation<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#withWorldLock(worldId, async () => {
      if ((await this.#reconcileCorrectionClaim(worldId)) !== null)
        throw new WorldOperationBusyError();
      return action();
    });
  }

  async withWorldLocalMetadataMutation<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#withWorldLock(worldId, action);
  }

  async withWorldAuthorityLock<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    assertNonEmptyIdentity(worldId, "world ID");
    return this.#withPersistentWorldLock(
      this.#authorityLocksRoot,
      worldId,
      6_000,
      action,
    );
  }

  async #readCorrectionClaim(
    worldId: string,
  ): Promise<CorrectionClaimRecord | null> {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(this.#correctionClaimPath(worldId), "utf8"),
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (!isCorrectionClaimRecord(value) || value.worldId !== worldId)
      throw new Error("invalid continuity correction claim");
    return value;
  }

  async #reconcileCorrectionClaim(
    worldId: string,
  ): Promise<CorrectionClaimRecord | null> {
    const claim = await this.#readCorrectionClaim(worldId);
    if (claim === null) return null;
    if (claim.expiresAt > this.#now()) return claim;
    await this.#removeCorrectionClaim(claim);
    return null;
  }

  async #removeCorrectionClaim(claim: CorrectionClaimRecord): Promise<void> {
    const current = await this.#readCorrectionClaim(claim.worldId);
    if (
      current?.operationId !== claim.operationId ||
      current.owner !== claim.owner
    )
      return;
    await rm(this.#correctionClaimPath(claim.worldId), { force: true });
    await syncDirectory(this.#correctionClaimsRoot);
  }

  async #withWorldLock<Value>(
    worldId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    return this.#withPersistentWorldLock(this.#locksRoot, worldId, 200, action);
  }

  async #withPersistentWorldLock<Value>(
    locksRoot: string,
    worldId: string,
    maxAttempts: number,
    action: () => Promise<Value>,
  ): Promise<Value> {
    await mkdir(locksRoot, { recursive: true, mode: 0o700 });
    const path = join(locksRoot, digest(worldId));
    const token = randomUUID();
    const ownerRecord: WorldLockOwnerRecord = {
      schemaVersion: 1,
      kind: "world_operation_lock_owner",
      token,
      pid: process.pid,
      processIdentity: await localProcessIdentity(),
    };
    let acquired = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await publishWorldLock(path, ownerRecord, locksRoot)) {
        acquired = true;
        break;
      }
      const owner = await readWorldLockOwner(path);
      if (owner !== null && (await worldLockOwnerIsAlive(owner, path))) {
        await delay(5);
        continue;
      }
      const metadata = await stat(path).catch(() => null);
      if (
        owner !== null ||
        (metadata !== null && Date.now() - metadata.mtimeMs > 30_000)
      )
        await retireWorldLock(path, owner, metadata, locksRoot);
      await delay(5);
    }
    if (!acquired) throw new WorldOperationBusyError();
    const heartbeatHandle = await open(join(path, "heartbeat"), "r+");
    let heartbeatStopped = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: Promise<void> = Promise.resolve();
    const scheduleHeartbeat = (): void => {
      heartbeatTimer = setTimeout(() => {
        const now = new Date();
        heartbeat = heartbeatHandle
          .utimes(now, now)
          .catch(() => undefined)
          .finally(() => {
            if (!heartbeatStopped) scheduleHeartbeat();
          });
      }, worldLockHeartbeatIntervalMilliseconds);
    };
    scheduleHeartbeat();
    try {
      return await action();
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      await heartbeat;
      await heartbeatHandle.close();
      await releaseWorldLock(path, token, locksRoot);
    }
  }

  #correctionClaimPath(worldId: string): string {
    return join(this.#correctionClaimsRoot, `${digest(worldId)}.json`);
  }
}

function isCorrectionClaimRecord(
  value: unknown,
): value is CorrectionClaimRecord {
  return (
    record(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "worldId",
      "operationId",
      "owner",
      "acquiredAt",
      "renewedAt",
      "expiresAt",
      "renewalCount",
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === "continuity_correction_claim" &&
    nonEmptyString(value.worldId) &&
    nonEmptyString(value.operationId) &&
    nonEmptyString(value.owner) &&
    finiteNumber(value.acquiredAt) &&
    finiteNumber(value.renewedAt) &&
    finiteNumber(value.expiresAt) &&
    Number(value.acquiredAt) <= Number(value.renewedAt) &&
    Number(value.renewedAt) < Number(value.expiresAt) &&
    Number.isSafeInteger(value.renewalCount) &&
    Number(value.renewalCount) >= 0
  );
}

function assertCorrectionClaimHandle(
  handle: ContinuityCorrectionWorldClaimHandle,
): void {
  assertNonEmptyIdentity(handle.worldId, "world ID");
  assertNonEmptyIdentity(handle.operationId, "correction operation ID");
  assertNonEmptyIdentity(handle.owner, "correction claim owner");
}

function correctionClaimHandle(
  record: CorrectionClaimRecord,
): ContinuityCorrectionWorldClaimHandle {
  return {
    worldId: record.worldId,
    operationId: record.operationId,
    owner: record.owner,
  };
}

function sameCorrectionClaimOwner(
  record: CorrectionClaimRecord | null,
  handle: ContinuityCorrectionWorldClaimHandle,
): record is CorrectionClaimRecord {
  return (
    record !== null &&
    record.worldId === handle.worldId &&
    record.operationId === handle.operationId &&
    record.owner === handle.owner
  );
}

async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function publishWorldLock(
  path: string,
  owner: WorldLockOwnerRecord,
  locksRoot: string,
): Promise<boolean> {
  const temporary = `${path}.${owner.token}.tmp`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const ownerPath = join(temporary, "owner.json");
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const heartbeatPath = join(temporary, "heartbeat");
    await writeFile(heartbeatPath, "", { encoding: "utf8", mode: 0o600 });
    await syncFile(ownerPath);
    await syncFile(heartbeatPath);
    await syncDirectory(temporary);
    try {
      await rename(temporary, path);
    } catch (error: unknown) {
      if (await renameWasFencedByExistingDestination(error, path)) return false;
      throw error;
    }
    await syncDirectory(locksRoot);
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function retireWorldLock(
  path: string,
  observedOwner: WorldLockOwnerRecord | null,
  observedMetadata: { dev: number; ino: number; mtimeMs: number } | null,
  locksRoot: string,
): Promise<void> {
  if (observedOwner === null && observedMetadata === null) return;
  const currentOwner = await readWorldLockOwner(path);
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
    (await worldLockOwnerIsAlive(currentOwner, path))
  )
    return;
  if (
    currentOwner === null &&
    (currentMetadata === null || Date.now() - currentMetadata.mtimeMs <= 30_000)
  )
    return;
  const generation =
    observedOwner === null
      ? `inode-${observedMetadata!.dev}-${observedMetadata!.ino}`
      : observedOwner.token;
  const retired = `${path}.${digest(generation)}.retired`;
  try {
    await rename(path, retired);
    await syncDirectory(locksRoot);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (await renameWasFencedByExistingDestination(error, retired)) return;
    throw error;
  }
}

async function releaseWorldLock(
  path: string,
  token: string,
  locksRoot: string,
): Promise<void> {
  const owner = await readWorldLockOwner(path);
  if (owner?.token !== token) return;
  const retired = `${path}.${digest(token)}.retired`;
  try {
    await rename(path, retired);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (await renameWasFencedByExistingDestination(error, retired)) return;
    throw error;
  }
  await syncDirectory(locksRoot);
}

async function renameWasFencedByExistingDestination(
  error: unknown,
  destination: string,
): Promise<boolean> {
  if (!isNodeError(error)) return false;
  if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return true;
  if (error.code !== "EACCES" && error.code !== "EPERM") return false;
  return (await stat(destination).catch(() => null)) !== null;
}

async function readWorldLockOwner(
  lockPath: string,
): Promise<WorldLockOwnerRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !record(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "token",
      "pid",
      "processIdentity",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "world_operation_lock_owner" ||
    !nonEmptyString(value.token) ||
    !positiveInteger(value.pid) ||
    !nonEmptyString(value.processIdentity)
  )
    throw new Error("invalid world operation lock owner");
  return {
    schemaVersion: 1,
    kind: "world_operation_lock_owner",
    token: value.token,
    pid: value.pid,
    processIdentity: value.processIdentity,
  };
}

let cachedLocalProcessIdentity: Promise<string> | undefined;

function localProcessIdentity(): Promise<string> {
  cachedLocalProcessIdentity ??= operatingSystemProcessIdentity(
    process.pid,
  ).then((identity) => identity ?? `fallback:${process.pid}:${randomUUID()}`);
  return cachedLocalProcessIdentity;
}

async function worldLockOwnerIsAlive(
  owner: WorldLockOwnerRecord,
  lockPath: string,
): Promise<boolean> {
  const identity = await operatingSystemProcessIdentity(owner.pid);
  if (identity === owner.processIdentity) return true;
  if (identity !== null) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
  }
  const heartbeat = await stat(join(lockPath, "heartbeat")).catch(() => null);
  return (
    heartbeat !== null &&
    Date.now() - heartbeat.mtimeMs <= worldLockHeartbeatStaleMilliseconds
  );
}

async function operatingSystemProcessIdentity(
  pid: number,
): Promise<string | null> {
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

function assertNonEmptyIdentity(value: string, label: string): void {
  if (value.trim() === "") throw new TypeError(`${label} is invalid`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
