import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * One service process owns a data directory (ADR-0044). The lock is a pid
 * file: a live owner refuses startup, and a dead owner's file is replaced.
 */
const lockFileName = "server.pid";

/** Persistent lock directories left by the retired cross-process world locks. */
const legacyLockPaths = [
  "runtime-locks",
  join("operations", "world-locks"),
  join("operations", "authority-locks"),
  join("operations", "correction-claims"),
] as const;

export class DataRootBusyError extends Error {
  readonly ownerPid: number;

  constructor(ownerPid: number) {
    super(
      `Another Narraeon server (pid ${ownerPid}) is already using this data directory`,
    );
    this.name = "DataRootBusyError";
    this.ownerPid = ownerPid;
  }
}

export interface DataRootLock {
  release(): Promise<void>;
}

export async function acquireDataRootLock(
  dataRoot: string,
): Promise<DataRootLock> {
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, lockFileName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await removeLegacyLocks(root);
      return {
        release: async () => {
          if ((await readOwnerPid(path)) === process.pid)
            await rm(path, { force: true });
        },
      };
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const owner = await readOwnerPid(path);
      if (owner !== null && processIsAlive(owner))
        throw new DataRootBusyError(owner);
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the data-directory startup lock");
}

async function readOwnerPid(path: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

async function removeLegacyLocks(root: string): Promise<void> {
  for (const relative of legacyLockPaths)
    await rm(join(root, relative), { recursive: true, force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
