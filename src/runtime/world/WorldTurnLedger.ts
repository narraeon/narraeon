import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

// 世界轮账本：当前文件就是当前端点；每轮只记录它改动过的文件的修改前像。
// 回退只追加一轮 rewind，它在读取时被视为逻辑上的空操作，被丢弃的轮不再可达。

export type WorldTurnMode =
  "genesis" | "play" | "correction" | "revision_apply" | "rewind";

export interface WorldTurnFileChange {
  path: string;
  content: string | null;
}

export interface WorldTurnFileBefore {
  path: string;
  before: string | null;
}

export interface WorldTurnRecord {
  sequence: number;
  mode: WorldTurnMode;
  createdAt: string;
  restoresSequence?: number;
  payload?: unknown;
  files: WorldTurnFileBefore[];
}

export class WorldTurnLedgerError extends Error {
  readonly code:
    "no_head" | "unreachable" | "corrupt" | "invalid_path" | "missing_record";

  constructor(code: WorldTurnLedgerError["code"], message: string) {
    super(message);
    this.name = "WorldTurnLedgerError";
    this.code = code;
  }
}

const headFile = join("runtime", "head.json");
const turnsDirectory = join("runtime", "turns");

function turnFileName(sequence: number): string {
  return join(turnsDirectory, `${String(sequence).padStart(8, "0")}.json`);
}

function assertSafePath(relativePath: string): void {
  const normalized = normalize(relativePath);
  if (
    isAbsolute(relativePath) ||
    normalized.startsWith(`..${sep}`) ||
    normalized === ".." ||
    normalized.length === 0 ||
    normalized === headFile ||
    normalized === turnsDirectory ||
    normalized.startsWith(turnsDirectory + sep)
  ) {
    throw new WorldTurnLedgerError(
      "invalid_path",
      `世界文件路径不合法：${relativePath}`,
    );
  }
}

async function writeFileAtomic(
  absolute: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, absolute);
}

async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function initializeLedger(root: string): Promise<void> {
  forgetLedger(root);
  await writeFileAtomic(
    join(root, headFile),
    `${JSON.stringify({ sequence: 0 }, null, 2)}\n`,
  );
}

export async function readHead(root: string): Promise<number> {
  const text = await readTextOrNull(join(root, headFile));
  if (text === null) {
    throw new WorldTurnLedgerError("no_head", "世界缺少轮账本端点");
  }
  const parsed = JSON.parse(text) as { sequence?: unknown };
  if (
    typeof parsed.sequence !== "number" ||
    !Number.isInteger(parsed.sequence) ||
    parsed.sequence < 0
  ) {
    throw new WorldTurnLedgerError("corrupt", "世界轮账本端点格式不正确");
  }
  return parsed.sequence;
}

async function publishHead(root: string, sequence: number): Promise<void> {
  await writeFileAtomic(
    join(root, headFile),
    `${JSON.stringify({ sequence }, null, 2)}\n`,
  );
}

async function readAllRecords(root: string): Promise<WorldTurnRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(root, turnsDirectory));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: WorldTurnRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = await readFile(join(root, turnsDirectory, name), "utf8");
    records.push(JSON.parse(text) as WorldTurnRecord);
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

interface LedgerView {
  head: number;
  byPosition: Map<number, WorldTurnRecord>;
  discarded: Set<number>;
}

// 被某个 rewind 丢弃的轮是 (restores, rewind) 之间的位置；它们可能仍在磁盘上，
// 直到清理完成，但读取时一律忽略。
function viewOf(head: number, records: WorldTurnRecord[]): LedgerView {
  const byPosition = new Map<number, WorldTurnRecord>();
  for (const record of records) {
    if (record.sequence <= head) byPosition.set(record.sequence, record);
  }
  const discarded = new Set<number>();
  for (const record of byPosition.values()) {
    if (record.restoresSequence === undefined) continue;
    for (
      let position = record.restoresSequence + 1;
      position < record.sequence;
      position += 1
    ) {
      discarded.add(position);
    }
  }
  return { head, byPosition, discarded };
}

// 进程内视图缓存，按端点失效。一个数据目录只被一个进程操作（ADR-0044），
// 所以 head 相同即记录相同：任何改变可见记录的写入都会先推进 head。
// 只有 beginTurn 与 recoverIncomplete 会在 head 之上写入或删除记录，它们不影响视图
// （视图只包含序号不大于 head 的记录，且 recoverIncomplete 本身会在结束时失效缓存）。
const viewCache = new Map<string, LedgerView>();

async function loadView(root: string): Promise<LedgerView> {
  const head = await readHead(root);
  const cached = viewCache.get(resolve(root));
  if (cached?.head === head) return cached;
  const view = viewOf(head, await readAllRecords(root));
  viewCache.set(resolve(root), view);
  return view;
}

// 世界目录被删除、归档导入或分叉发布到已存在路径之前调用：下一次读取从磁盘重建视图。
export function forgetLedger(root: string): void {
  viewCache.delete(resolve(root));
}

// 把一个端点解析到它的逻辑位置：rewind 位置等价于它所恢复的位置。
function resolvePosition(view: LedgerView, sequence: number): number {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > view.head) {
    throw new WorldTurnLedgerError(
      "unreachable",
      `端点 ${sequence} 不在当前账本范围内`,
    );
  }
  let position = sequence;
  for (;;) {
    if (position === 0) return 0;
    if (view.discarded.has(position)) {
      throw new WorldTurnLedgerError(
        "unreachable",
        `端点 ${sequence} 已被回退丢弃`,
      );
    }
    const record = view.byPosition.get(position);
    if (!record) {
      throw new WorldTurnLedgerError(
        "missing_record",
        `缺少第 ${position} 轮记录`,
      );
    }
    if (record.mode !== "rewind") return position;
    if (record.restoresSequence === undefined) {
      throw new WorldTurnLedgerError(
        "corrupt",
        `第 ${position} 轮缺少回退目标`,
      );
    }
    position = record.restoresSequence;
  }
}

// 从 sequence 之后的全部可见改动倒推：每个路径取最早一次修改前像。
function overlayAfter(
  view: LedgerView,
  sequence: number,
): Map<string, string | null> {
  const overlay = new Map<string, string | null>();
  for (let position = sequence + 1; position <= view.head; position += 1) {
    if (view.discarded.has(position)) continue;
    const record = view.byPosition.get(position);
    if (!record) {
      throw new WorldTurnLedgerError(
        "missing_record",
        `缺少第 ${position} 轮记录`,
      );
    }
    if (record.mode === "rewind") continue;
    for (const file of record.files) {
      if (!overlay.has(file.path)) overlay.set(file.path, file.before);
    }
  }
  return overlay;
}

async function captureBefore(
  root: string,
  paths: readonly string[],
): Promise<WorldTurnFileBefore[]> {
  const files: WorldTurnFileBefore[] = [];
  for (const path of paths) {
    assertSafePath(path);
    files.push({ path, before: await readTextOrNull(join(root, path)) });
  }
  return files;
}

// 第一步：写入本轮记录（序号为 head + 1）。记录原子落盘，之后任何一步崩溃都可由 recoverIncomplete 回滚。
export async function beginTurn(
  root: string,
  input: {
    mode: WorldTurnMode;
    changes: readonly WorldTurnFileChange[];
    restoresSequence?: number;
    payload?: unknown;
    createdAt?: string;
  },
): Promise<WorldTurnRecord> {
  const head = await readHead(root);
  const record: WorldTurnRecord = {
    sequence: head + 1,
    mode: input.mode,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.restoresSequence === undefined
      ? {}
      : { restoresSequence: input.restoresSequence }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    files: await captureBefore(
      root,
      input.changes.map((change) => change.path),
    ),
  };
  await writeFileAtomic(
    join(root, turnFileName(record.sequence)),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

// 第二步：逐文件原子替换（写临时文件后 rename；删除即 rm）。
export async function applyChanges(
  root: string,
  changes: readonly WorldTurnFileChange[],
): Promise<void> {
  for (const change of changes) {
    assertSafePath(change.path);
    const absolute = join(root, change.path);
    if (change.content === null) {
      await rm(absolute, { force: true });
    } else {
      await writeFileAtomic(absolute, change.content);
    }
  }
}

// 第三步：发布端点。只有这一步之后，本轮才算完成。
export async function commitTurnHead(
  root: string,
  record: WorldTurnRecord,
): Promise<void> {
  await publishHead(root, record.sequence);
}

export async function appendTurn(
  root: string,
  input: {
    mode: WorldTurnMode;
    changes: readonly WorldTurnFileChange[];
    restoresSequence?: number;
    payload?: unknown;
  },
): Promise<WorldTurnRecord> {
  const record = await beginTurn(root, input);
  await applyChanges(root, input.changes);
  await commitTurnHead(root, record);
  return record;
}

// 启动时调用：序号大于 head 的记录说明上一次推进未完成，逆序恢复其修改前像。
// 被丢弃的轮记录（读取时已忽略）在这里清理。返回是否回滚了未完成的轮。
export async function recoverIncomplete(root: string): Promise<boolean> {
  const head = await readHead(root);
  const records = await readAllRecords(root);
  const incomplete = records
    .filter((record) => record.sequence > head)
    .sort((left, right) => right.sequence - left.sequence);
  for (const record of incomplete) {
    for (const file of [...record.files].reverse()) {
      assertSafePath(file.path);
      const absolute = join(root, file.path);
      if (file.before === null) {
        await rm(absolute, { force: true });
      } else {
        await writeFileAtomic(absolute, file.before);
      }
    }
    await rm(join(root, turnFileName(record.sequence)), { force: true });
  }
  const view = viewOf(head, records);
  for (const position of view.discarded) {
    await rm(join(root, turnFileName(position)), { force: true });
  }
  forgetLedger(root);
  return incomplete.length > 0;
}

export async function listTurns(root: string): Promise<WorldTurnRecord[]> {
  const view = await loadView(root);
  const turns: WorldTurnRecord[] = [];
  for (let position = 1; position <= view.head; position += 1) {
    if (view.discarded.has(position)) continue;
    const record = view.byPosition.get(position);
    if (!record) {
      throw new WorldTurnLedgerError(
        "missing_record",
        `缺少第 ${position} 轮记录`,
      );
    }
    turns.push(record);
  }
  return turns;
}

// 把端点解析为它所表示的逻辑位置（rewind 位置等价于它恢复的位置）。
export async function resolveEndpoint(
  root: string,
  sequence: number,
): Promise<number> {
  return resolvePosition(await loadView(root), sequence);
}

// 第 sequence 轮记录文件的 sha256；0 轮没有记录，返回 null。
export async function readTurnDigest(
  root: string,
  sequence: number,
): Promise<string | null> {
  if (sequence === 0) return null;
  const text = await readFile(join(root, turnFileName(sequence)), "utf8");
  return createHash("sha256").update(text).digest("hex");
}

// 读取端点 sequence 处某个文件的内容；不存在返回 null。
export async function readFileAt(
  root: string,
  sequence: number,
  relativePath: string,
): Promise<string | null> {
  assertSafePath(relativePath);
  const view = await loadView(root);
  const position = resolvePosition(view, sequence);
  const overlay = overlayAfter(view, position);
  if (overlay.has(relativePath)) return overlay.get(relativePath) ?? null;
  return readTextOrNull(join(root, relativePath));
}

// 读取端点 sequence 处 dirs 下的全部文件（相对路径 → 内容）。
export async function readTreeAt(
  root: string,
  sequence: number,
  dirs: readonly string[],
): Promise<Map<string, string>> {
  const view = await loadView(root);
  const position = resolvePosition(view, sequence);
  const overlay = overlayAfter(view, position);
  const tree = new Map<string, string>();
  for (const dir of dirs) {
    assertSafePath(dir);
    for (const path of await listFiles(root, dir)) {
      if (!overlay.has(path)) {
        const text = await readTextOrNull(join(root, path));
        if (text !== null) tree.set(path, text);
      }
    }
  }
  for (const [path, before] of overlay) {
    const inDir = dirs.some(
      (dir) => path === dir || path.startsWith(dir + "/"),
    );
    if (!inDir || before === null) continue;
    tree.set(path, before);
  }
  return tree;
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        found.push(child);
      }
    }
  };
  await visit(dir);
  return found;
}

// 回退到端点 sequence：追加一轮 rewind（前像为回退前的文件），之后丢弃 (sequence, head] 的记录。
// 已经处于 sequence 的端点是空操作。返回新轮记录，或 null。
export async function rewindTo(
  root: string,
  sequence: number,
): Promise<WorldTurnRecord | null> {
  const view = await loadView(root);
  const target = resolvePosition(view, sequence);
  if (target === view.head) return null;
  const overlay = overlayAfter(view, target);
  const changes: WorldTurnFileChange[] = [];
  for (const [path, before] of overlay) {
    const current = await readTextOrNull(join(root, path));
    if (current === before) continue;
    changes.push({ path, content: before });
  }
  const record = await appendTurn(root, {
    mode: "rewind",
    changes,
    restoresSequence: sequence,
  });
  // 端点已发布，丢弃的记录即可删除；失败可忽略，读取已把它们当作不可达，下次回退或恢复会再清理。
  for (let position = target + 1; position <= view.head; position += 1) {
    await rm(join(root, turnFileName(position)), { force: true }).catch(
      () => undefined,
    );
  }
  return record;
}
