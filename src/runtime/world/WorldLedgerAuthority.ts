import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type { ContentTreeFile } from "../content/ContentWorkspace.ts";
import type { HistoryBackground } from "../history/HistoryBackground.ts";
import { historyInputs } from "../history/HistoryQuery.ts";
import { appendHistoryVersion } from "../history/HistorySnapshotVersion.ts";
import type { MaterialSelection } from "../prompt/MaterialSelection.ts";
import type {
  NarrativeCheckpoint,
  NarrativeCheckpointDeclaration,
} from "../play/PlayContinuity.ts";
import {
  committedHistoryEntries,
  projectFileNativeHistorySurface,
  projectHistoryBackgrounds,
} from "./FileNativeHistoryProjection.ts";
import {
  appendTurnWithDigest,
  initializeLedger,
  readControlFilesAt,
  readEndpoint,
  readHead as readLedgerHead,
  readLedgerFiles,
  readLedgerProjection,
  readTreeAt,
  readTurnHistory,
  type WorldTurnFileChange,
  type WorldTurnRecord,
} from "./WorldTurnLedger.ts";

// 当前端点由账本头与轮记录给出：状态、历史与附加材料都是当前文件，
// 轮记录只保存本轮的元数据（payload）与修改前像；回退后端点名称指向被恢复的轮。

export interface WorldHistoryMessage {
  messageId: string;
  role: "player" | "narrator";
  exactText: string;
  background?: HistoryBackground;
}

export interface WorldStateChangeStored {
  /** `delete` 只由世界修订应用产生：前像必须存在，且没有下一份内容。 */
  kind: "create" | "replace" | "delete";
  documentId: string;
  stableShortRef: string;
  relativePath: string;
  codec: "yaml" | "markdown";
  expectedPreviousHash: string | null;
  nextHash: string | null;
}

export interface WorldStateChangeInput extends WorldStateChangeStored {
  canonicalNextBytes: string | null;
}

/** 提交轮的模式；`genesis` 与 `rewind` 不是提交，没有提交元数据。 */
export type WorldCommitMode =
  "play" | "correction" | "revision_apply" | "control_apply";

/**
 * 世界修订应用与连续性修正同属修订谱系：它们记录 `corrects` 与 `correctionTargets`，
 * 维护报告与修订追溯按此归类。
 */
export function isCorrectionCommit(mode: WorldCommitMode): boolean {
  return mode === "correction" || mode === "revision_apply";
}

export interface WorldTurnCommit {
  sequence: number;
  head: string;
  /** Migrated intermediate commits do not carry an operation identity. */
  operationId: string | null;
  parentHead: string;
  mode: WorldCommitMode;
  playContext?: string;
  worldClock?: string;
  historyAppend: WorldHistoryMessage[];
  stateChanges: WorldStateChangeStored[];
  nextAdditionalMaterials: MaterialSelection[];
  correctionTargets?: string[];
  corrects?: string;
  narrativeCheckpoint?: NarrativeCheckpointDeclaration;
}

export interface WorldRecoveredEndpoint {
  head: string;
  state: ContentTreeFile[];
  history: WorldHistoryMessage[];
  historyVersion: string;
  additionalMaterials: MaterialSelection[];
  narrativeCheckpoint?: NarrativeCheckpoint;
}

type CommittedHistory = Pick<
  WorldRecoveredEndpoint,
  "history" | "historyVersion"
>;

export interface WorldHeadState {
  head: string;
  sequence: number;
  operationId: string | null;
  commitDigest: string | null;
}

export class WorldAuthorityError extends Error {
  readonly code: "corrupt" | "stale" | "conflict";

  constructor(code: WorldAuthorityError["code"], message: string) {
    super(message);
    this.name = "WorldAuthorityError";
    this.code = code;
  }
}

const genesisFile = join("runtime", "genesis.json");
const materialsFile = "runtime/additional-materials.json";

function headName(position: number): string {
  return position === 0 ? "genesis" : `commit:${String(position)}`;
}

function parsePosition(head: string): number {
  if (head === "genesis") return 0;
  const match = /^commit:([1-9][0-9]*)$/u.exec(head);
  if (match === null)
    throw new WorldAuthorityError("corrupt", `端点名称不合法：${head}`);
  return Number.parseInt(match[1]!, 10);
}

async function readJsonOrNull<Value>(path: string): Promise<Value | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export class WorldLedgerAuthority {
  readonly #root: string;

  constructor(worldRoot: string) {
    this.#root = worldRoot;
  }

  async exists(): Promise<boolean> {
    try {
      await stat(join(this.#root, "runtime", "head.json"));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await initializeLedger(this.#root);
  }

  /** 当前端点：逻辑位置（回退后即被恢复的轮）及其元数据，三者取自同一份账本视图。 */
  async readHead(): Promise<WorldHeadState> {
    const endpoint = await readEndpoint(this.#root);
    const { sequence } = endpoint;
    return {
      head: headName(sequence),
      sequence,
      operationId: await this.#operationIdAt(sequence, endpoint.record),
      commitDigest: endpoint.digest,
    };
  }

  async currentOperationId(): Promise<string | null> {
    return (await this.readHead()).operationId;
  }

  async #operationIdAt(
    position: number,
    record: WorldTurnRecord | null,
  ): Promise<string | null> {
    if (position === 0) {
      const genesis = await readJsonOrNull<{ operationId?: unknown }>(
        join(this.#root, genesisFile),
      );
      return typeof genesis?.operationId === "string"
        ? genesis.operationId
        : null;
    }
    const commit = record?.payload as WorldTurnCommit | undefined;
    if (commit?.sequence !== position)
      throw new WorldAuthorityError(
        "corrupt",
        `第 ${position} 轮缺少提交元数据`,
      );
    return commit.operationId;
  }

  #commitFromRecord(
    position: number,
    turn: WorldTurnRecord | null,
  ): WorldTurnCommit {
    const commit = turn?.payload as WorldTurnCommit | undefined;
    if (commit?.sequence !== position)
      throw new WorldAuthorityError(
        "corrupt",
        `第 ${position} 轮缺少提交元数据`,
      );
    return commit;
  }

  async #genesisHistory(): Promise<WorldHistoryMessage[]> {
    const genesis = await readJsonOrNull<{ history?: WorldHistoryMessage[] }>(
      join(this.#root, genesisFile),
    );
    return genesis?.history ?? [];
  }

  #materialsFrom(text: string | undefined): MaterialSelection[] {
    if (text === undefined) return [];
    const parsed = JSON.parse(text) as { items?: MaterialSelection[] };
    return parsed.items ?? [];
  }

  async recoverSurface(
    surface: "state" | "control" | "history",
    head?: string,
  ): Promise<ContentTreeFile[]> {
    const position = head === undefined ? undefined : parsePosition(head);
    if (surface === "control") return readControlFilesAt(this.#root, position);
    return surfaceFiles(
      await readTreeAt(this.#root, position, [surface]),
      surface,
    );
  }

  async recoverRevisionFiles(head?: string): Promise<ContentTreeFile[]> {
    const position = head === undefined ? undefined : parsePosition(head);
    const tree = await readTreeAt(this.#root, position, ["state", "control"]);
    return [...tree]
      .map(([path, contents]) => ({ path, contents }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Text projection used by the compiler and existing revision workspace. */
  async recoverControl(head?: string): Promise<ContentTreeFile[]> {
    const position = head === undefined ? undefined : parsePosition(head);
    return surfaceFiles(
      await readTreeAt(this.#root, position, ["control"]),
      "control",
    );
  }

  /** 把当前端点的控制文件替换为 next 所需的逐文件改动（写入或删除，未变化的不记录）。 */
  async #controlChanges(
    position: number,
    next: readonly ContentTreeFile[],
  ): Promise<WorldTurnFileChange[]> {
    const current = await readTreeAt(this.#root, position, ["control"]);
    const wanted = new Map(next.map((file) => [`control/${file.path}`, file]));
    const changes: WorldTurnFileChange[] = [];
    for (const path of current.keys())
      if (!wanted.has(path)) changes.push({ path, content: null });
    // The advanced editor checks opaque resources against the published bytes.
    // They are carried through its whole-tree draft without creating ledger writes.
    for (const [path, { contents, encoding }] of wanted)
      if (encoding === undefined && current.get(path) !== contents)
        changes.push({ path, content: contents });
    return changes;
  }

  #checkpointAt(
    commits: readonly WorldTurnCommit[],
  ): NarrativeCheckpoint | undefined {
    for (let index = commits.length - 1; index >= 0; index -= 1) {
      const commit = commits[index]!;
      if (commit.narrativeCheckpoint === undefined) continue;
      return structuredClone({
        ...commit.narrativeCheckpoint,
        head: commit.head,
        historyMessageId: commit.historyAppend.at(-1)?.messageId ?? "",
      });
    }
    return undefined;
  }

  async recover(head?: string): Promise<WorldRecoveredEndpoint> {
    const { sequence, files, turns } = await readLedgerFiles(
      this.#root,
      head === undefined ? undefined : parsePosition(head),
      { dirs: ["state"], paths: [materialsFile], includeTurns: true },
    );
    const commits = commitsFromTurns(turns);
    const checkpoint = this.#checkpointAt(commits);
    return {
      head: headName(sequence),
      state: surfaceFiles(files, "state"),
      ...(await this.#recoverCommittedHistory(commits)),
      additionalMaterials: this.#materialsFrom(files.get(materialsFile)),
      ...(checkpoint === undefined ? {} : { narrativeCheckpoint: checkpoint }),
    };
  }

  /** Read the history through a published endpoint without reading world documents. */
  async recoverCommittedHistory(head?: string): Promise<CommittedHistory> {
    const { turns } = await readTurnHistory(
      this.#root,
      head === undefined ? undefined : parsePosition(head),
    );
    return this.#recoverCommittedHistory(commitsFromTurns(turns));
  }

  async #recoverCommittedHistory(
    commits: readonly WorldTurnCommit[],
  ): Promise<CommittedHistory> {
    const genesis = await this.#genesisHistory();
    let historyVersion = appendHistoryVersion(
      "",
      historyInputs(committedHistoryEntries(genesis)),
    );
    for (const { historyAppend } of commits) {
      if (historyAppend.length !== 0)
        historyVersion = versionAfterCommit(historyVersion, historyAppend);
    }
    return {
      // Committed messages are borrowed from the cached ledger view.
      history: [
        ...genesis,
        ...structuredClone(commits.flatMap((commit) => commit.historyAppend)),
      ],
      historyVersion,
    };
  }

  async recoverHeadResult(): Promise<WorldRecoveredEndpoint> {
    return this.recover();
  }

  async readNarrativeCheckpoint(
    head?: string,
  ): Promise<NarrativeCheckpoint | undefined> {
    const { turns } = await readTurnHistory(
      this.#root,
      head === undefined ? undefined : parsePosition(head),
    );
    return this.#checkpointAt(commitsFromTurns(turns));
  }

  async recoverState(head?: string): Promise<ContentTreeFile[]> {
    return this.recoverSurface("state", head);
  }

  async recoverMaterials(head?: string): Promise<MaterialSelection[]> {
    const { files } = await readLedgerFiles(
      this.#root,
      head === undefined ? undefined : parsePosition(head),
      { paths: [materialsFile] },
    );
    return this.#materialsFrom(files.get(materialsFile));
  }

  async readHistory(): Promise<{ head: string; commits: WorldTurnCommit[] }> {
    const { sequence, turns } = await readTurnHistory(this.#root);
    return {
      head: headName(sequence),
      commits: structuredClone(commitsFromTurns(turns)),
    };
  }

  /** 已提交的一轮；genesis 没有提交，返回 null。 */
  async commitAt(head: string): Promise<WorldTurnCommit | null> {
    const { sequence, record } = await readEndpoint(
      this.#root,
      parsePosition(head),
    );
    if (sequence === 0) return null;
    return structuredClone(this.#commitFromRecord(sequence, record));
  }

  /** Recover the state versions needed to extend a cached maintenance prefix. */
  async readStateHistory(
    head: string | undefined,
    hasPrefix: (head: string) => boolean,
  ): Promise<{
    head: string;
    prefixHead: string;
    genesisState: ContentTreeFile[];
    commits: {
      mode: WorldCommitMode;
      playContext: string | undefined;
      worldClock: string | undefined;
      historyAppend: Pick<WorldHistoryMessage, "role" | "exactText">[];
      changes: (Pick<
        WorldStateChangeStored,
        "kind" | "relativePath" | "stableShortRef"
      > & {
        contents: string | null;
      })[];
    }[];
  }> {
    const { sequence, files, projection } = await readLedgerProjection(
      this.#root,
      head === undefined ? undefined : parsePosition(head),
      (position, turnsBack) => {
        let prefixHead = headName(position);
        const suffix: { record: WorldTurnRecord; commit: WorldTurnCommit }[] =
          [];
        const paths = new Set<string>();
        let hasCachedPrefix = hasPrefix(prefixHead);
        if (!hasCachedPrefix) {
          for (const record of turnsBack()) {
            if (record.mode === "rewind") continue;
            const commit = this.#commitFromRecord(record.sequence, record);
            if (commit.head !== prefixHead)
              throw new Error("Document maintenance history is not reachable");
            if (hasPrefix(prefixHead)) {
              hasCachedPrefix = true;
              break;
            }
            suffix.push({ record, commit });
            for (const change of commit.stateChanges)
              if (change.kind !== "delete")
                paths.add(`state/${change.relativePath}`);
            prefixHead = commit.parentHead;
          }
        }
        if (!hasCachedPrefix && prefixHead !== "genesis")
          throw new Error("Document maintenance history is not reachable");
        const readGenesis = !hasCachedPrefix && !hasPrefix("genesis");
        return {
          dirs: readGenesis ? ["state"] : [],
          paths: [...paths],
          projection: { prefixHead, suffix, readGenesis },
        };
      },
    );

    // An after-image is the next visible turn's before-image for that path,
    // or the selected endpoint's file when no later turn changed it.
    const commits = projection.suffix.map(({ record, commit }) => {
      const changes = commit.stateChanges.map((change) => {
        const contents =
          change.kind === "delete"
            ? null
            : (files.get(`state/${change.relativePath}`) ?? null);
        if (
          change.kind !== "delete" &&
          (contents === null || sha256Hex(contents) !== change.nextHash)
        )
          throw new WorldAuthorityError(
            "corrupt",
            `State change content conflicts with its commit: ${change.relativePath}`,
          );
        return {
          kind: change.kind,
          relativePath: change.relativePath,
          stableShortRef: change.stableShortRef,
          contents,
        };
      });
      for (const { path, before } of record.files) {
        if (!path.startsWith("state/")) continue;
        if (before === null) files.delete(path);
        else files.set(path, before);
      }
      return {
        mode: commit.mode,
        playContext: commit.playContext,
        worldClock: commit.worldClock,
        historyAppend: commit.historyAppend.map(({ role, exactText }) => ({
          role,
          exactText,
        })),
        changes,
      };
    });
    return {
      head: headName(sequence),
      prefixHead: projection.prefixHead,
      genesisState: projection.readGenesis ? surfaceFiles(files, "state") : [],
      commits: commits.reverse(),
    };
  }

  /**
   * 结构校验（归档导入使用）：头、轮记录与 genesis 可读，轮序号与路径合法。
   * 当前文件本身不在账本里，因此这里不尝试从账本复算内容。
   */
  async verifyStructure(): Promise<void> {
    await this.readHead();
    const genesis = await readJsonOrNull<{ state?: unknown }>(
      join(this.#root, genesisFile),
    );
    if (genesis === null || !Array.isArray(genesis.state))
      throw new WorldAuthorityError("corrupt", "genesis.json 缺少状态");
  }

  /**
   * 在未发布的暂存区校验当前文件，并修复不符合账本端点的投影。
   * 返回同一个端点供分叉使用，中途失败由调用方丢弃整个暂存区。
   */
  async reconcileCurrentFiles(): Promise<WorldRecoveredEndpoint> {
    const endpoint = await this.recover();
    const writes = new Map<string, string>();
    for (const file of endpoint.state)
      writes.set(`state/${file.path}`, file.contents);
    for (const file of projectFileNativeHistorySurface(
      endpoint.history,
      (messageId) => {
        throw new WorldAuthorityError(
          "corrupt",
          `History-message identity cannot form a file path: ${messageId}`,
        );
      },
    ))
      writes.set(`history/${file.path}`, file.contents);
    for (const file of projectHistoryBackgrounds(endpoint.history))
      writes.set(`runtime/history-backgrounds/${file.path}`, file.contents);
    for (const directory of ["state", "history", "runtime/history-backgrounds"])
      await pruneProjectionTree(this.#root, directory, writes);
    for (const [path, contents] of writes)
      await writeTextAtomic(join(this.#root, path), contents);
    const materials = `${JSON.stringify({ head: endpoint.head, items: endpoint.additionalMaterials }, null, 2)}\n`;
    const path = join(this.#root, materialsFile);
    const entry = await lstatOrNull(path);
    if (
      entry === null ||
      !entry.isFile() ||
      !(await fileEquals(path, materials))
    )
      await writeTextAtomic(path, materials);
    return endpoint;
  }

  async authorityFactAt(head: string): Promise<{
    commit: WorldTurnCommit;
    digest: string;
  }> {
    const { sequence, record, digest } = await readEndpoint(
      this.#root,
      parsePosition(head),
    );
    if (sequence === 0)
      throw new WorldAuthorityError("conflict", "Genesis is not a commit");
    const commit = this.#commitFromRecord(sequence, record);
    if (digest === null)
      throw new WorldAuthorityError("corrupt", `第 ${sequence} 轮缺少记录`);
    return { commit: structuredClone(commit), digest };
  }

  /**
   * 在当前端点之上追加一轮。调用方先校验内容；这里校验状态的前像哈希，
   * 并一次性计算本轮需要替换的全部文件（状态、控制、历史、历史背景与材料清单）。
   * `control` 是提交后的完整控制文件集合：与端点的差异作为本轮改动，逐文件记录前像。
   */
  async appendCommit(input: {
    operationId: string;
    parentHead: string;
    mode: WorldCommitMode;
    playContext?: string;
    worldClock?: string;
    historyAppend: readonly {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
    stateChanges: readonly WorldStateChangeInput[];
    nextMaterials: readonly MaterialSelection[];
    control?: readonly ContentTreeFile[];
    narrativeCheckpoint?: NarrativeCheckpointDeclaration;
    correctionTargets?: readonly string[];
    corrects?: string;
  }): Promise<{ commit: WorldTurnCommit; commitDigest: string }> {
    const current = await this.readHead();
    if (current.head !== input.parentHead)
      throw new WorldAuthorityError(
        "stale",
        "The parent endpoint of the Authority operation has changed",
      );
    const physical = await readLedgerHead(this.#root);
    const sequence = physical + 1;
    const head = `commit:${String(sequence)}`;

    const stateFiles =
      input.stateChanges.length === 0
        ? []
        : await this.recoverState(current.head);
    const currentState = new Map(
      stateFiles.map(({ path, contents }) => [path, contents]),
    );
    const changes: WorldTurnFileChange[] = [];
    for (const change of input.stateChanges) {
      const previous = currentState.get(change.relativePath);
      if (
        (previous === undefined ? null : sha256Hex(previous)) !==
        change.expectedPreviousHash
      )
        throw new WorldAuthorityError(
          "conflict",
          `State-change previous hash conflicts: ${change.relativePath}`,
        );
      if (change.kind === "delete") {
        if (
          previous === undefined ||
          change.nextHash !== null ||
          change.canonicalNextBytes !== null
        )
          throw new WorldAuthorityError(
            "conflict",
            `State-change delete conflicts: ${change.relativePath}`,
          );
        changes.push({ path: `state/${change.relativePath}`, content: null });
        continue;
      }
      if (
        change.canonicalNextBytes === null ||
        sha256Hex(change.canonicalNextBytes) !== change.nextHash
      )
        throw new WorldAuthorityError(
          "conflict",
          `State-change next hash conflicts: ${change.relativePath}`,
        );
      changes.push({
        path: `state/${change.relativePath}`,
        content: change.canonicalNextBytes,
      });
    }

    const messages: WorldHistoryMessage[] = input.historyAppend.map(
      (message, index) => ({
        messageId: `message.${String(sequence)}.${String(index + 1)}.${message.role}`,
        role: message.role,
        exactText: message.exactText,
        ...(message.background === undefined
          ? {}
          : { background: structuredClone(message.background) }),
      }),
    );
    for (const file of projectFileNativeHistorySurface(
      messages,
      (messageId) => {
        throw new WorldAuthorityError(
          "corrupt",
          `History-message identity cannot form a file path: ${messageId}`,
        );
      },
    ))
      changes.push({ path: `history/${file.path}`, content: file.contents });
    for (const file of projectHistoryBackgrounds(messages))
      changes.push({
        path: `runtime/history-backgrounds/${file.path}`,
        content: file.contents,
      });

    if (input.control !== undefined)
      changes.push(
        ...(await this.#controlChanges(current.sequence, input.control)),
      );

    changes.push({
      path: materialsFile,
      content: `${JSON.stringify({ head, items: input.nextMaterials }, null, 2)}\n`,
    });

    const commit: WorldTurnCommit = {
      sequence,
      head,
      operationId: input.operationId,
      parentHead: input.parentHead,
      mode: input.mode,
      ...(input.playContext === undefined
        ? {}
        : { playContext: input.playContext }),
      ...(input.worldClock === undefined
        ? {}
        : { worldClock: input.worldClock }),
      historyAppend: messages,
      stateChanges: input.stateChanges.map((change) => {
        const { canonicalNextBytes, ...stored } = change;
        void canonicalNextBytes;
        return structuredClone(stored);
      }),
      nextAdditionalMaterials: structuredClone([...input.nextMaterials]),
      ...(input.correctionTargets === undefined
        ? {}
        : { correctionTargets: [...input.correctionTargets] }),
      ...(input.corrects === undefined ? {} : { corrects: input.corrects }),
      ...(input.narrativeCheckpoint === undefined
        ? {}
        : { narrativeCheckpoint: structuredClone(input.narrativeCheckpoint) }),
    };
    const { digest: commitDigest } = await appendTurnWithDigest(this.#root, {
      mode: input.mode,
      changes,
      payload: commit,
    });
    return { commit, commitDigest };
  }
}

// Turn payloads are immutable and reused by the ledger view. The prefix check
// also covers a newly opened or replaced genesis. Eviction follows the ledger.
const turnHistoryVersions = new WeakMap<
  readonly WorldHistoryMessage[],
  { previous: string; version: string }
>();

function versionAfterCommit(
  previous: string,
  messages: readonly WorldHistoryMessage[],
): string {
  const cached = turnHistoryVersions.get(messages);
  if (cached?.previous === previous) return cached.version;
  const version = appendHistoryVersion(
    previous,
    historyInputs(committedHistoryEntries(messages)),
  );
  turnHistoryVersions.set(messages, { previous, version });
  return version;
}

function commitsFromTurns(
  turns: readonly WorldTurnRecord[],
): WorldTurnCommit[] {
  return turns.flatMap(({ payload }) =>
    payload === undefined ? [] : [payload as WorldTurnCommit],
  );
}

function surfaceFiles(
  tree: ReadonlyMap<string, string>,
  surface: string,
): ContentTreeFile[] {
  const prefix = `${surface}/`;
  const files: ContentTreeFile[] = [];
  for (const [path, contents] of tree)
    if (path.startsWith(prefix))
      files.push({ path: path.slice(prefix.length), contents });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

// Remove paths outside the projection and leave byte-identical regular files in place.
// A symlink or a directory in place of a file is removed before a replacement is written.
async function pruneProjectionTree(
  root: string,
  directory: string,
  writes: Map<string, string>,
): Promise<void> {
  const directories = new Set<string>();
  for (const path of writes.keys()) {
    if (!path.startsWith(`${directory}/`)) continue;
    for (
      let parent = posix.dirname(path);
      !directories.has(parent);
      parent = posix.dirname(parent)
    ) {
      directories.add(parent);
      if (parent === directory) break;
    }
  }
  const absolute = join(root, directory);
  const top = await lstatOrNull(absolute);
  if (top === null) return;
  if (!top.isDirectory() || !directories.has(directory)) {
    await rm(absolute, { recursive: true, force: true });
    return;
  }

  const candidates: string[] = [];
  const visit = async (parent: string): Promise<void> => {
    for (const entry of await readdir(join(root, parent), {
      withFileTypes: true,
    })) {
      const path = `${parent}/${entry.name}`;
      const child = join(root, path);
      if (entry.isDirectory() && directories.has(path)) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && writes.has(path)) candidates.push(path);
      else {
        await rm(child, { recursive: true, force: true });
      }
    }
  };
  await visit(directory);
  const batchSize = 8;
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    await Promise.all(
      candidates.slice(offset, offset + batchSize).map(async (path) => {
        if (await fileEquals(join(root, path), writes.get(path)!))
          writes.delete(path);
      }),
    );
  }
}

async function fileEquals(path: string, contents: string): Promise<boolean> {
  return (await readFile(path)).equals(Buffer.from(contents, "utf8"));
}

async function lstatOrNull(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

// 与状态前像哈希保持同一格式（sha256:<hex>）。
async function writeTextAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
