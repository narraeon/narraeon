import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GoogleHopEvidence, ModelHostWireRequest } from "./ModelHost.ts";
import { isSafeGoogleHop, withGoogleHop } from "./GoogleRequestPreview.ts";

const pendingWrites = new Map<string, Promise<void>>();
const pendingSnapshots = new Map<string, GoogleHopEvidence>();

function ownerDirectory(root: string, owner: string): string {
  return join(root, createHash("sha256").update(owner).digest("hex"));
}

/** A writer can discard its owner directory. Callers remove expired roots. */
export function writeGoogleHop(
  root: string,
  owner: string,
  hop: GoogleHopEvidence,
  retained: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<void> {
  if (!isSafeGoogleHop(hop)) throw new Error("Unsafe Google hop evidence");
  const directory = ownerDirectory(root, owner);
  const path = join(
    directory,
    `${hop.exchange}-${hop.attempt}-${hop.hop}.json`,
  );
  const snapshot = JSON.stringify(hop);
  pendingSnapshots.set(path, structuredClone(hop));
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      if (!(await retained())) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      let keepOwner = true;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
        keepOwner = await retained();
        if (keepOwner) await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
        if (!keepOwner || !(await retained())) {
          await rm(directory, { recursive: true, force: true });
          // Recursive mkdir may have recreated the root after caller cleanup.
          // Removing it only when empty preserves any sibling owner.
          await rmdir(root).catch(() => undefined);
        }
      }
    });
  pendingWrites.set(path, pending);
  void pending
    .finally(() => {
      if (pendingWrites.get(path) === pending) {
        pendingWrites.delete(path);
        pendingSnapshots.delete(path);
      }
    })
    .catch(() => undefined);
  return pending;
}

/** Corrupt optional evidence is omitted without affecting the underlying request. */
export async function readGoogleHops(
  root: string,
  owner: string,
  wire: ModelHostWireRequest,
): Promise<ModelHostWireRequest> {
  const directory = ownerDirectory(root, owner);
  const names = await readdir(directory).catch(() => []);
  let result = wire;
  for (const name of names
    .filter((name) => /^[1-9]\d*-[1-9]\d*-[1-9]\d*\.json$/u.test(name))
    .sort()) {
    try {
      const hop = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as GoogleHopEvidence;
      if (`${hop.exchange}-${hop.attempt}-${hop.hop}.json` !== name) continue;
      const existing = result.googleHops?.find(
        (item) =>
          item.exchange === hop.exchange &&
          item.attempt === hop.attempt &&
          item.hop === hop.hop,
      );
      if (existing !== undefined && existing.status !== "attempted") continue;
      result = withGoogleHop(result, hop);
    } catch {
      // A single damaged diagnostic cannot prevent the request from loading.
    }
  }
  for (const [path, hop] of pendingSnapshots)
    if (dirname(path) === directory) {
      try {
        const existing = wire.googleHops?.find(
          (item) =>
            item.exchange === hop.exchange &&
            item.attempt === hop.attempt &&
            item.hop === hop.hop,
        );
        if (existing === undefined || existing.status === "attempted")
          result = withGoogleHop(result, hop);
      } catch {
        // Invalid pending evidence is treated like a damaged diagnostic file.
      }
    }
  if (result.googleHops !== undefined)
    result.googleHops.sort(
      (a, b) =>
        a.exchange - b.exchange || a.attempt - b.attempt || a.hop - b.hop,
    );
  return result;
}
