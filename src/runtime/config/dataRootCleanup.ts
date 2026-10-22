import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Persistent lock files and directories left by retired lock mechanisms. */
const legacyLockPaths = [
  "server.pid",
  "runtime-locks",
  join("operations", "world-locks"),
  join("operations", "authority-locks"),
  join("operations", "correction-claims"),
] as const;

/**
 * Startup housekeeping for a data directory. One service process per data
 * directory is a product premise (ADR-0044), not something startup enforces:
 * a pid lock cannot tell a crashed container's pid 1 from the restarted one.
 */
export async function prepareDataRoot(dataRoot: string): Promise<void> {
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await removeLegacyLocks(root);
}

async function removeLegacyLocks(root: string): Promise<void> {
  for (const relative of legacyLockPaths)
    await rm(join(root, relative), { recursive: true, force: true });
  await removeLegacyOperationReceipts(root);
}

/**
 * Operation receipts written before #76 (including archive import receipts) have
 * no readers. The world-revision epoch markers in the same directory are kept.
 */
async function removeLegacyOperationReceipts(root: string): Promise<void> {
  const directory = join(root, "operations");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (entries === null) return;
  for (const entry of entries)
    if (entry.isFile() && entry.name.endsWith(".json"))
      await rm(join(directory, entry.name), { force: true });
  try {
    await rmdir(directory);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOTEMPTY") throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
