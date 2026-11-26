import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  isOrchestrationProvenanceRecord,
  type OrchestrationEntrySource,
} from "../../protocol/orchestrationProvenance.ts";

const directoryPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^[0-9a-f]{64}$/u;
const revisionFile =
  /^(rev-[0-9a-f]{64})(?:\.[0-9a-f]{64})?\.json(?:\.[0-9a-f-]{36}\.tmp)?$/u;

export function provenanceVersion(source: OrchestrationEntrySource[]): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** Local metadata. The orchestration library decides which revisions exist. */
export class OrchestrationProvenanceStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = join(root, "orchestration-provenance");
  }

  async read(
    presetId: string,
    revision: string,
    version?: string,
  ): Promise<OrchestrationEntrySource[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path(presetId, revision, version), "utf8");
    } catch (error) {
      if (missing(error) && version === undefined) return [];
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      !value.every(isEntry) ||
      (version !== undefined && provenanceVersion(value) !== version)
    )
      throw new Error("The local orchestration provenance could not be read");
    return value;
  }

  async write(
    presetId: string,
    revision: string,
    version: string,
    source: OrchestrationEntrySource[],
  ): Promise<boolean> {
    const directory = join(this.#root, presetDirectory(presetId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.#path(presetId, revision, version);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(source), {
        flag: "wx",
        mode: 0o600,
      });
      // Atomically publish a new immutable variant without replacing a live one.
      await link(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await this.read(presetId, revision, version);
        return false;
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async remove(
    presetId: string,
    revision: string,
    version: string,
  ): Promise<void> {
    await rm(this.#path(presetId, revision, version), { force: true });
  }

  async removeOrphans(
    presets: {
      id: string;
      active: { revision: string; version?: string | undefined }[];
    }[],
    archive: (
      presetId: string,
      revision: string,
    ) => Promise<{ provenance?: string } | undefined>,
  ): Promise<void> {
    const live = new Map(
      presets.map(({ id, active }) => [
        presetDirectory(id),
        {
          active: new Set(
            active.map(({ revision, version }) => filename(revision, version)),
          ),
          id,
        },
      ]),
    );
    for (const directory of await names(this.#root)) {
      if (!directoryPattern.test(directory)) continue;
      const path = join(this.#root, directory);
      const revisions = live.get(directory);
      if (revisions === undefined) {
        await rm(path, { force: true, recursive: true });
        continue;
      }
      const retained = new Map<string, string | undefined>();
      for (const name of await names(path)) {
        const match = revisionFile.exec(name);
        if (match === null || revisions.active.has(name)) continue;
        if (!name.endsWith(".tmp")) {
          const revision = match[1]!;
          if (!retained.has(revision)) {
            const stored = await archive(revisions.id, revision);
            retained.set(
              revision,
              stored === undefined
                ? undefined
                : filename(revision, stored.provenance),
            );
          }
          if (retained.get(revision) === name) continue;
        }
        await rm(join(path, name), { force: true });
      }
    }
  }

  #path(presetId: string, revision: string, version?: string): string {
    if (
      !/^rev-[0-9a-f]{64}$/u.test(revision) ||
      (version !== undefined && !versionPattern.test(version))
    )
      throw new Error("Invalid orchestration revision");
    return join(
      this.#root,
      presetDirectory(presetId),
      filename(revision, version),
    );
  }
}

function filename(revision: string, version?: string): string {
  return version === undefined
    ? `${revision}.json`
    : `${revision}.${version}.json`;
}

function presetDirectory(presetId: string): string {
  return createHash("sha256").update(presetId).digest("hex");
}

async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isEntry(value: unknown): value is OrchestrationEntrySource {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    (item.surface === "playPrompts" || item.surface === "authorPrompts") &&
    typeof item.entryId === "string" &&
    isOrchestrationProvenanceRecord(item.source)
  );
}
