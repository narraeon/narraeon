import type { HistoryBackground } from "../history/HistoryBackground.ts";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { MaterialSelection } from "../prompt/FileNativePromptCompiler.ts";
import {
  authorityV3Directory,
  continuityHeadFile,
  LegacyAuthorityV3Reader,
  staleV3WorldFiles,
  type FileNativeAuthorityCommitV3,
} from "./LegacyAuthorityV3Reader.ts";
import {
  projectFileNativeHistorySurface,
  projectHistoryBackgrounds,
} from "./FileNativeHistoryProjection.ts";
import type { WorldTurnCommit } from "./WorldLedgerAuthority.ts";
import { WorldLedgerAuthority } from "./WorldLedgerAuthority.ts";
import type {
  WorldTurnFileBefore,
  WorldTurnRecord,
} from "./WorldTurnLedger.ts";

export interface FileNativeWorldStorageMigrationResult {
  outcome: "already_current" | "migrated";
  authorityCommits: number;
}

/** A world written by v0.2.0 or earlier: no ledger and no Authority V3 chain. */
export class UnsupportedLegacyStorageError extends Error {
  readonly code = "unsupported_legacy_storage";

  constructor(worldId: string) {
    super(
      `World ${worldId} uses a storage format that is no longer supported; open it once with v0.3.0–v0.6.0 first`,
    );
    this.name = "UnsupportedLegacyStorageError";
  }
}

/**
 * One-way upgrade seam from the Authority V3 chain to the current-files-plus-
 * turn-ledger layout. Callers serialize this module per world. Formats older
 * than V3 are rejected with UnsupportedLegacyStorageError.
 */
export class FileNativeWorldStorageMigrator {
  readonly #worldsRoot: string;

  constructor(dataRoot: string) {
    this.#worldsRoot = join(resolve(dataRoot), "worlds-file-native");
  }

  async migrate(
    worldId: string,
  ): Promise<FileNativeWorldStorageMigrationResult> {
    assertIdentity(worldId, "World ID");
    const worldRoot = join(this.#worldsRoot, worldId);
    const runtimeRoot = join(worldRoot, "runtime");
    const ledger = new WorldLedgerAuthority(worldRoot);
    if (await ledger.exists()) {
      // V3 迁移在写完 head.json 后、删除旧目录前若中断，会留下只读不写的残留。
      // 账本已经是端点，残留目录不再被读取，这里一并清理。
      for (const residue of [
        join(runtimeRoot, authorityV3Directory),
        join(runtimeRoot, ".authority-v3-migration"),
      ])
        await rm(residue, { recursive: true, force: true });
      const head = await ledger.readHead();
      return { outcome: "already_current", authorityCommits: head.sequence };
    }
    const authority = new LegacyAuthorityV3Reader(worldRoot);
    if (await authority.exists()) {
      const { commits } = await convertAuthorityV3ToLedger(worldRoot);
      return { outcome: "migrated", authorityCommits: commits };
    }
    throw new UnsupportedLegacyStorageError(worldId);
  }
}

/** One endpoint as the ledger sees it: the current files a position must reproduce. */
interface LedgerEndpointInput {
  head: string;
  state: { path: string; contents: string }[];
  history: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
    background?: HistoryBackground;
  }[];
  additionalMaterials: MaterialSelection[];
}

/** One committed turn: the basis endpoint it is computed from and its payload. */
interface LedgerStepInput {
  sequence: number;
  basisSequence: number;
  restoresSequence?: number;
  mode: "play" | "correction";
  payload: WorldTurnCommit;
}

const retiredAuthorityPaths = [
  join("runtime", authorityV3Directory),
  join("runtime", continuityHeadFile),
  join("runtime", ".authority-v3-migration"),
  ...staleV3WorldFiles,
];

/**
 * Write the current-files-plus-turn-ledger layout for a migrated world.
 * Each turn's before-images come from its basis endpoint; a timeline revision
 * folds into one turn that restores its logical parent, so committed numbering
 * is unchanged. The result is verified by reverse replay before anything is
 * published, and head.json is written last: an interrupted migration simply
 * runs again.
 */
async function writeTurnLedger(
  worldRoot: string,
  input: {
    endpoints: ReadonlyMap<number, LedgerEndpointInput>;
    steps: readonly LedgerStepInput[];
    headSequence: number;
  },
): Promise<void> {
  const filesOf = new Map<number, Map<string, string>>();
  const filesAt = (sequence: number): Map<string, string> => {
    const cached = filesOf.get(sequence);
    if (cached !== undefined) return cached;
    const endpoint = input.endpoints.get(sequence);
    if (endpoint === undefined)
      throw new Error(`Migrated world has no endpoint at ${String(sequence)}`);
    const files = endpointFiles(endpoint);
    filesOf.set(sequence, files);
    return files;
  };
  const finalFiles = filesAt(input.headSequence);

  let records: WorldTurnRecord[] = [];
  const basisOf = new Map<number, number>();
  for (const step of input.steps) {
    basisOf.set(step.sequence, step.basisSequence);
    if (step.restoresSequence !== undefined)
      records = records.filter(
        (record) => record.sequence <= step.restoresSequence!,
      );
    records.push({
      sequence: step.sequence,
      mode: step.mode,
      createdAt: new Date().toISOString(),
      ...(step.restoresSequence === undefined
        ? {}
        : { restoresSequence: step.restoresSequence }),
      payload: step.payload,
      files: diffEndpoints(filesAt(step.basisSequence), filesAt(step.sequence)),
    });
  }

  // 逆向回放：从最终端点倒推每一轮，必须逐轮复现它的基底端点。
  const current = new Map(finalFiles);
  for (const record of [...records].reverse()) {
    for (const file of record.files) {
      if (file.before === null) current.delete(file.path);
      else current.set(file.path, file.before);
    }
    const expected = filesAt(basisOf.get(record.sequence) ?? -1);
    if (!sameFiles(current, expected))
      throw new Error(
        `World ledger migration cannot reproduce the endpoint before commit ${String(record.sequence)}`,
      );
  }

  for (const directory of [
    "state",
    "history",
    join("runtime", "history-backgrounds"),
  ])
    await replaceDirectoryFiles(worldRoot, directory, finalFiles);
  await publishText(
    join(worldRoot, "runtime", "additional-materials.json"),
    finalFiles.get(join("runtime", "additional-materials.json")) ?? "",
  );
  await rm(join(worldRoot, "runtime", "turns"), {
    recursive: true,
    force: true,
  });
  for (const record of records)
    await publishJson(
      join(
        worldRoot,
        "runtime",
        "turns",
        `${String(record.sequence).padStart(8, "0")}.json`,
      ),
      record,
    );
  await publishJson(join(worldRoot, "runtime", "head.json"), {
    sequence: input.headSequence,
  });
  // 账本已经发布：旧的 V3 与物化文件不再被读取，移除它们。
  for (const retired of retiredAuthorityPaths)
    await rm(join(worldRoot, retired), { recursive: true, force: true });
}

/**
 * Convert an Authority V3 fact chain into the current layout. Every endpoint is
 * recovered from V3 and handed to the shared writer.
 */
export async function convertAuthorityV3ToLedger(
  worldRoot: string,
): Promise<{ commits: number }> {
  const authority = new LegacyAuthorityV3Reader(worldRoot);
  const head = await authority.readHead();
  const { commits } = await authority.readHistory();
  const endpoints = new Map<number, LedgerEndpointInput>();
  endpoints.set(0, await authority.recover("genesis"));
  const steps: LedgerStepInput[] = [];
  for (const commit of commits) {
    const revision = commit.timelineRevision;
    const basisHead = revision?.restoresHead ?? commit.auditParent.head;
    const basisSequence = headPositionOf(basisHead);
    endpoints.set(commit.sequence, await authority.recover(commit.head));
    steps.push({
      sequence: commit.sequence,
      basisSequence,
      ...(revision === undefined ? {} : { restoresSequence: basisSequence }),
      mode: commit.mode === "correction" ? "correction" : "play",
      payload: payloadOf(
        commit,
        basisHead,
        commit.sequence === head.sequence ? head.operationId : null,
      ),
    });
  }
  await writeTurnLedger(worldRoot, {
    endpoints,
    steps,
    headSequence: head.sequence,
  });
  return { commits: commits.length };
}

function headPositionOf(head: string): number {
  if (head === "genesis") return 0;
  const match = /^commit:([1-9][0-9]*)$/u.exec(head);
  if (match === null) throw new Error(`Authority endpoint is invalid: ${head}`);
  return Number.parseInt(match[1]!, 10);
}

function endpointFiles(endpoint: LedgerEndpointInput): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of endpoint.state)
    files.set(`state/${file.path}`, file.contents);
  for (const file of projectFileNativeHistorySurface(
    endpoint.history,
    (messageId) => {
      throw new Error(
        `History-message identity cannot form a path: ${messageId}`,
      );
    },
  ))
    files.set(`history/${file.path}`, file.contents);
  for (const file of projectHistoryBackgrounds(endpoint.history))
    files.set(`runtime/history-backgrounds/${file.path}`, file.contents);
  files.set(
    join("runtime", "additional-materials.json"),
    `${JSON.stringify({ head: endpoint.head, items: endpoint.additionalMaterials }, null, 2)}\n`,
  );
  return files;
}

function diffEndpoints(
  basis: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): WorldTurnFileBefore[] {
  const paths = new Set([...basis.keys(), ...target.keys()]);
  const changed: WorldTurnFileBefore[] = [];
  for (const path of [...paths].sort()) {
    const before = basis.get(path) ?? null;
    if ((target.get(path) ?? null) !== before) changed.push({ path, before });
  }
  return changed;
}

function sameFiles(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, contents] of left)
    if (right.get(path) !== contents) return false;
  return true;
}

function payloadOf(
  commit: FileNativeAuthorityCommitV3,
  parentHead: string,
  operationId: string | null,
): WorldTurnCommit {
  return {
    sequence: commit.sequence,
    head: commit.head,
    operationId,
    parentHead,
    mode: commit.mode === "correction" ? "correction" : "play",
    ...(commit.playContext === undefined
      ? {}
      : { playContext: commit.playContext }),
    ...(commit.worldClock === undefined
      ? {}
      : { worldClock: commit.worldClock }),
    historyAppend: structuredClone([...commit.historyAppend]),
    stateChanges: commit.stateChanges.map(({ nextBlob, ...stored }) => {
      void nextBlob;
      return structuredClone(stored);
    }),
    nextAdditionalMaterials: structuredClone([
      ...commit.nextAdditionalMaterials,
    ]),
    ...(commit.correctionTargets === undefined
      ? {}
      : { correctionTargets: [...commit.correctionTargets] }),
    ...(commit.corrects === undefined ? {} : { corrects: commit.corrects }),
    ...(commit.narrativeCheckpoint === undefined
      ? {}
      : { narrativeCheckpoint: structuredClone(commit.narrativeCheckpoint) }),
  };
}

async function replaceDirectoryFiles(
  worldRoot: string,
  directory: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const prefix = `${directory}/`;
  await rm(join(worldRoot, directory), { recursive: true, force: true });
  for (const [path, contents] of files) {
    if (!path.startsWith(prefix)) continue;
    await publishText(join(worldRoot, path), contents);
  }
}

async function publishText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value))
    throw new TypeError(`${label} is invalid`);
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
