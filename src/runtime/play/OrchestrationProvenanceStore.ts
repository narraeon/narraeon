import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  isOrchestrationProvenanceRecord,
  type OrchestrationEntrySource,
} from "../../protocol/orchestrationProvenance.ts";

const directoryPattern = /^[0-9a-f]{64}$/u;
const revisionFile = /^rev-([0-9a-f]{64})\.json(?:\.[0-9a-f-]{36}\.tmp)?$/u;

/** Local metadata. The orchestration library decides which revisions exist. */
export class OrchestrationProvenanceStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = join(root, "orchestration-provenance");
  }

  async read(
    presetId: string,
    revision: string,
  ): Promise<OrchestrationEntrySource[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path(presetId, revision), "utf8");
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(isEntry))
      throw new Error("The local orchestration provenance could not be read");
    return value;
  }

  async write(
    presetId: string,
    revision: string,
    source: OrchestrationEntrySource[],
  ): Promise<void> {
    const directory = join(this.#root, presetDirectory(presetId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.#path(presetId, revision);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(source), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(presetId: string, revision: string): Promise<void> {
    await rm(this.#path(presetId, revision), { force: true });
  }

  async removeOrphans(
    presets: { id: string; revisions: string[] }[],
  ): Promise<void> {
    const live = new Map(
      presets.map(({ id, revisions }) => [
        presetDirectory(id),
        new Set(revisions.map((revision) => `${revision}.json`)),
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
      for (const filename of await names(path))
        if (revisionFile.test(filename) && !revisions.has(filename))
          await rm(join(path, filename), { force: true });
    }
  }

  #path(presetId: string, revision: string): string {
    if (!/^rev-[0-9a-f]{64}$/u.test(revision))
      throw new Error("Invalid orchestration revision");
    return join(this.#root, presetDirectory(presetId), `${revision}.json`);
  }
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
