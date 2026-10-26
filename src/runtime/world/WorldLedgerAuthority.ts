import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ContentTreeFile } from "../content/ContentWorkspace.ts";
import type { HistoryBackground } from "../history/HistoryBackground.ts";
import type { MaterialSelection } from "../prompt/MaterialSelection.ts";
import type {
  NarrativeCheckpoint,
  NarrativeCheckpointDeclaration,
} from "../play/PlayContinuity.ts";
import {
  projectFileNativeHistorySurface,
  projectHistoryBackgrounds,
} from "./FileNativeHistoryProjection.ts";
import {
  appendTurn,
  initializeLedger,
  listTurns,
  readEndpoint,
  readFileAt,
  readHead as readLedgerHead,
  readTreeAt,
  readTurnDigest,
  resolveEndpoint,
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
  additionalMaterials: MaterialSelection[];
  narrativeCheckpoint?: NarrativeCheckpoint;
}

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
const materialsFile = join("runtime", "additional-materials.json");

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

  async #positionOf(head?: string): Promise<number> {
    if (head === undefined) return (await this.readHead()).sequence;
    return resolveEndpoint(this.#root, parsePosition(head));
  }

  async #commitAtPosition(position: number): Promise<WorldTurnCommit> {
    const turn = (await listTurns(this.#root)).find(
      (candidate) => candidate.sequence === position,
    );
    const commit = turn?.payload as WorldTurnCommit | undefined;
    if (commit?.sequence !== position)
      throw new WorldAuthorityError(
        "corrupt",
        `第 ${position} 轮缺少提交元数据`,
      );
    return commit;
  }

  /** 端点位置处可见的全部提交（按轮号），不含 genesis 与回退轮。 */
  async #commitsUpTo(position: number): Promise<WorldTurnCommit[]> {
    const turns: WorldTurnRecord[] = await listTurns(this.#root);
    return turns
      .filter((turn) => turn.sequence <= position && turn.payload !== undefined)
      .map((turn) => turn.payload as WorldTurnCommit);
  }

  async #genesisHistory(): Promise<WorldHistoryMessage[]> {
    const genesis = await readJsonOrNull<{ history?: WorldHistoryMessage[] }>(
      join(this.#root, genesisFile),
    );
    return structuredClone(genesis?.history ?? []);
  }

  async #materialsAt(position: number): Promise<MaterialSelection[]> {
    const text = await readFileAt(this.#root, position, materialsFile);
    if (text === null) return [];
    const parsed = JSON.parse(text) as { items?: MaterialSelection[] };
    return structuredClone(parsed.items ?? []);
  }

  async #stateAt(position: number): Promise<ContentTreeFile[]> {
    return this.#surfaceAt(position, "state");
  }

  async #controlAt(position: number): Promise<ContentTreeFile[]> {
    return this.#surfaceAt(position, "control");
  }

  async #surfaceAt(
    position: number,
    surface: "state" | "control",
  ): Promise<ContentTreeFile[]> {
    const prefix = `${surface}/`;
    const tree = await readTreeAt(this.#root, position, [surface]);
    return [...tree]
      .map(([path, contents]) => ({
        path: path.slice(prefix.length),
        contents,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /** 端点的控制文件：与状态同一账本视图，回退与分叉随端点恢复。 */
  async recoverControl(head?: string): Promise<ContentTreeFile[]> {
    return this.#controlAt(await this.#positionOf(head));
  }

  /** 把当前端点的控制文件替换为 next 所需的逐文件改动（写入或删除，未变化的不记录）。 */
  async #controlChanges(
    position: number,
    next: readonly ContentTreeFile[],
  ): Promise<WorldTurnFileChange[]> {
    const current = await readTreeAt(this.#root, position, ["control"]);
    const wanted = new Map<string, string>(
      next.map((file) => [`control/${file.path}`, file.contents]),
    );
    const changes: WorldTurnFileChange[] = [];
    for (const path of current.keys())
      if (!wanted.has(path)) changes.push({ path, content: null });
    for (const [path, contents] of wanted)
      if (current.get(path) !== contents)
        changes.push({ path, content: contents });
    return changes;
  }

  #checkpointAt(
    commits: readonly WorldTurnCommit[],
  ): NarrativeCheckpoint | undefined {
    for (let index = commits.length - 1; index >= 0; index -= 1) {
      const commit = commits[index]!;
      if (commit.narrativeCheckpoint === undefined) continue;
      return {
        ...commit.narrativeCheckpoint,
        head: commit.head,
        historyMessageId: commit.historyAppend.at(-1)?.messageId ?? "",
      };
    }
    return undefined;
  }

  async recover(head?: string): Promise<WorldRecoveredEndpoint> {
    const position = await this.#positionOf(head);
    const commits = await this.#commitsUpTo(position);
    const history = [
      ...(await this.#genesisHistory()),
      ...commits.flatMap((commit) => commit.historyAppend),
    ];
    const checkpoint = this.#checkpointAt(commits);
    return {
      head: headName(position),
      state: await this.#stateAt(position),
      history: structuredClone(history),
      additionalMaterials: await this.#materialsAt(position),
      ...(checkpoint === undefined
        ? {}
        : { narrativeCheckpoint: structuredClone(checkpoint) }),
    };
  }

  async recoverHeadResult(): Promise<WorldRecoveredEndpoint> {
    return this.recover();
  }

  async readNarrativeCheckpoint(
    head?: string,
  ): Promise<NarrativeCheckpoint | undefined> {
    const position = await this.#positionOf(head);
    return this.#checkpointAt(await this.#commitsUpTo(position));
  }

  async recoverState(head?: string): Promise<ContentTreeFile[]> {
    return this.#stateAt(await this.#positionOf(head));
  }

  async recoverMaterials(head?: string): Promise<MaterialSelection[]> {
    return this.#materialsAt(await this.#positionOf(head));
  }

  async readHistory(): Promise<{ head: string; commits: WorldTurnCommit[] }> {
    const position = await this.#positionOf();
    return {
      head: headName(position),
      commits: await this.#commitsUpTo(position),
    };
  }

  /** 已提交的一轮；genesis 没有提交，返回 null。 */
  async commitAt(head: string): Promise<WorldTurnCommit | null> {
    const position = await this.#positionOf(head);
    if (position === 0) return null;
    return this.#commitAtPosition(position);
  }

  /** 某一轮修改的状态文件内容：即该轮结束时的文件，并校验哈希。 */
  async readStateChangeContents(
    commit: WorldTurnCommit,
    change: WorldStateChangeStored,
  ): Promise<string | null> {
    const contents = await readFileAt(
      this.#root,
      commit.sequence,
      `state/${change.relativePath}`,
    );
    if (change.kind === "delete") {
      if (contents !== null)
        throw new WorldAuthorityError(
          "corrupt",
          `Deleted state document still exists in its commit: ${change.relativePath}`,
        );
      return null;
    }
    if (
      change.nextHash === null ||
      contents === null ||
      sha256Hex(contents) !== change.nextHash
    )
      throw new WorldAuthorityError(
        "corrupt",
        `State change content conflicts with its commit: ${change.relativePath}`,
      );
    return contents;
  }

  /**
   * 结构校验（归档导入使用）：头、轮记录与 genesis 可读，轮序号与路径合法。
   * 当前文件本身不在账本里，因此这里不尝试从账本复算内容。
   */
  async verifyStructure(): Promise<void> {
    await this.readHead();
    const turns = await listTurns(this.#root);
    for (const turn of turns) {
      for (const file of turn.files) {
        if (
          file.path.startsWith("runtime/turns/") ||
          file.path === "runtime/head.json"
        )
          throw new WorldAuthorityError(
            "corrupt",
            "轮记录引用了账本自身的文件",
          );
      }
      if (turn.payload !== undefined) {
        const commit = turn.payload as WorldTurnCommit;
        if (commit.sequence !== turn.sequence)
          throw new WorldAuthorityError(
            "corrupt",
            `第 ${turn.sequence} 轮的提交序号不一致`,
          );
      }
    }
    const genesis = await readJsonOrNull<{ state?: unknown }>(
      join(this.#root, genesisFile),
    );
    if (genesis === null || !Array.isArray(genesis.state))
      throw new WorldAuthorityError("corrupt", "genesis.json 缺少状态");
  }

  /**
   * 以账本端点重建当前文件（状态、历史投影、历史背景与材料清单）。
   * 只用于尚未发布的 staging 世界：它先删除投影目录再写入，中途失败由调用方丢弃整个 staging。
   */
  async materializeCurrentFiles(): Promise<void> {
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
    writes.set(
      materialsFile,
      `${JSON.stringify({ head: endpoint.head, items: endpoint.additionalMaterials }, null, 2)}\n`,
    );
    for (const directory of [
      "state",
      "history",
      join("runtime", "history-backgrounds"),
    ])
      await rm(join(this.#root, directory), { recursive: true, force: true });
    for (const [path, contents] of writes)
      await writeTextAtomic(join(this.#root, path), contents);
  }

  async authorityFactAt(head: string): Promise<{
    commit: WorldTurnCommit;
    digest: string;
  }> {
    const position = await this.#positionOf(head);
    if (position === 0)
      throw new WorldAuthorityError("conflict", "Genesis is not a commit");
    const commit = await this.#commitAtPosition(position);
    const digest = await readTurnDigest(this.#root, position);
    if (digest === null)
      throw new WorldAuthorityError("corrupt", `第 ${position} 轮缺少记录`);
    return { commit, digest };
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

    const currentState = new Map(
      (await this.#stateAt(current.sequence)).map((file) => [
        file.path,
        file.contents,
      ]),
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
    const record = await appendTurn(this.#root, {
      mode: input.mode,
      changes,
      payload: commit,
    });
    const commitDigest = await readTurnDigest(this.#root, record.sequence);
    if (commitDigest === null)
      throw new WorldAuthorityError("corrupt", "新提交缺少轮记录");
    return { commit, commitDigest };
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
