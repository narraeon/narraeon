import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// 世界轮账本：当前文件就是当前端点；每轮只记录它改动过的文件的修改前像。
// 回退只追加一轮 rewind，它在读取时被视为逻辑上的空操作，被丢弃的轮不再可达。

export type WorldTurnMode =
  | "genesis"
  | "play"
  | "correction"
  | "revision_apply"
  | "control_apply"
  | "rewind";

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
    | "no_head"
    | "unreachable"
    | "discarded"
    | "corrupt"
    | "invalid_path"
    | "missing_record"
    | "read_conflict";

  constructor(code: WorldTurnLedgerError["code"], message: string) {
    super(message);
    this.name = "WorldTurnLedgerError";
    this.code = code;
  }
}

const headFile = join("runtime", "head.json");
const turnsDirectory = join("runtime", "turns");
const turnReadBatchSize = 8;
const maxCachedWorlds = 8;

function turnFileName(sequence: number): string {
  return join(turnsDirectory, `${String(sequence).padStart(8, "0")}.json`);
}

function assertSafePath(relativePath: string): void {
  if (!isWorldPath(relativePath)) {
    throw new WorldTurnLedgerError(
      "invalid_path",
      `世界文件路径不合法：${relativePath}`,
    );
  }
}

function isWorldPath(path: string): boolean {
  return (
    (path === "runtime/additional-materials.json" ||
      /^(?:state|control|history|runtime\/history-backgrounds)(?:\/|$)/u.test(
        path,
      )) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    (process.platform !== "win32" || !path.includes(":")) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isWorldFilePath(path: string): boolean {
  return (
    isWorldPath(path) &&
    path.includes("/") &&
    path !== "runtime/history-backgrounds"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseLedgerJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorldTurnLedgerError(
      "corrupt",
      `世界轮账本 JSON 格式不正确：${file}`,
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
  const parsed = parseLedgerJson(text, headFile);
  if (!isObject(parsed) || !isSequence(parsed.sequence)) {
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

interface StoredTurn {
  record: WorldTurnRecord;
  digest: string;
}

const turnModes = new Set<unknown>([
  "genesis",
  "play",
  "correction",
  "revision_apply",
  "control_apply",
  "rewind",
] satisfies WorldTurnMode[]);

function isStateChange(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.kind === "create" ||
      value.kind === "replace" ||
      value.kind === "delete") &&
    typeof value.documentId === "string" &&
    typeof value.stableShortRef === "string" &&
    typeof value.relativePath === "string" &&
    isWorldFilePath(`state/${value.relativePath}`) &&
    (value.codec === "yaml" || value.codec === "markdown") &&
    (value.expectedPreviousHash === null ||
      typeof value.expectedPreviousHash === "string") &&
    (value.nextHash === null || typeof value.nextHash === "string")
  );
}

function isStoredMaterial(value: unknown): boolean {
  return (
    isObject(value) &&
    ((value.kind === "document" && typeof value.document === "string") ||
      (value.kind === "node" &&
        typeof value.document === "string" &&
        isObject(value.locator)) ||
      (value.kind === "history_message" && typeof value.message === "string") ||
      (value.kind === "history_commit" && typeof value.commit === "string"))
  );
}

function isCommitPayload(
  payload: unknown,
  sequence: number,
  mode: unknown,
): payload is Record<string, unknown> {
  return (
    isObject(payload) &&
    payload.sequence === sequence &&
    payload.head === `commit:${sequence}` &&
    payload.mode === mode &&
    typeof payload.parentHead === "string" &&
    /^(?:genesis|commit:[1-9][0-9]*)$/u.test(payload.parentHead) &&
    (payload.operationId === null || typeof payload.operationId === "string") &&
    Array.isArray(payload.historyAppend) &&
    payload.historyAppend.every(
      (message: unknown) =>
        isObject(message) &&
        typeof message.messageId === "string" &&
        (message.role === "player" || message.role === "narrator") &&
        typeof message.exactText === "string",
    ) &&
    Array.isArray(payload.stateChanges) &&
    payload.stateChanges.every(isStateChange) &&
    Array.isArray(payload.nextAdditionalMaterials) &&
    payload.nextAdditionalMaterials.every(isStoredMaterial)
  );
}

function parseTurn(text: string, name: string): WorldTurnRecord {
  const value = parseLedgerJson(text, name);
  if (
    !isObject(value) ||
    !isSequence(value.sequence) ||
    value.sequence === 0 ||
    name !== `${String(value.sequence).padStart(8, "0")}.json` ||
    !turnModes.has(value.mode) ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new WorldTurnLedgerError("corrupt", `世界轮记录格式不正确：${name}`);
  }
  const { sequence, restoresSequence, payload } = value;
  if (
    restoresSequence !== undefined &&
    (!isSequence(restoresSequence) || restoresSequence >= sequence)
  )
    throw new WorldTurnLedgerError(
      "corrupt",
      `第 ${sequence} 轮的回退目标不在更早的轮中`,
    );
  if (payload !== undefined && !isCommitPayload(payload, sequence, value.mode))
    throw new WorldTurnLedgerError(
      "corrupt",
      `第 ${sequence} 轮的提交元数据格式不正确`,
    );
  if (
    value.mode === "rewind"
      ? restoresSequence === undefined || payload !== undefined
      : restoresSequence !== undefined &&
        // Authority V3 migrations fold a timeline replacement into a play or correction turn.
        ((value.mode !== "play" && value.mode !== "correction") ||
          !isObject(payload) ||
          payload.parentHead !==
            (restoresSequence === 0
              ? "genesis"
              : `commit:${String(restoresSequence)}`))
  ) {
    throw new WorldTurnLedgerError(
      "corrupt",
      `第 ${sequence} 轮的回退记录格式不正确`,
    );
  }
  const files: WorldTurnFileBefore[] = [];
  const beforeByPath = new Map<string, string | null>();
  for (const file of value.files as unknown[]) {
    if (
      !isObject(file) ||
      typeof file.path !== "string" ||
      (file.before !== null && typeof file.before !== "string")
    )
      throw new WorldTurnLedgerError(
        "corrupt",
        `第 ${sequence} 轮的文件前像格式不正确`,
      );
    // Older Windows writers used node:path.join for this one ledger path.
    const path =
      file.path === "runtime\\additional-materials.json"
        ? "runtime/additional-materials.json"
        : file.path;
    if (
      !isWorldFilePath(path) ||
      (beforeByPath.has(path) && beforeByPath.get(path) !== file.before)
    )
      throw new WorldTurnLedgerError(
        "corrupt",
        `第 ${sequence} 轮含无效或冲突的世界文件前像`,
      );
    if (beforeByPath.has(path)) continue;
    beforeByPath.set(path, file.before);
    files.push({ path, before: file.before });
  }
  return {
    sequence,
    mode: value.mode as WorldTurnMode,
    createdAt: value.createdAt,
    ...(restoresSequence === undefined ? {} : { restoresSequence }),
    ...(payload === undefined ? {} : { payload }),
    files,
  };
}

async function readAllRecords(root: string): Promise<StoredTurn[]> {
  const directory = join(root, turnsDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const turns: StoredTurn[] = [];
  for (let start = 0; start < names.length; start += turnReadBatchSize) {
    // 等本批读取全部结束，再按目录顺序处理结果或抛出错误。
    const batch = await Promise.allSettled(
      names.slice(start, start + turnReadBatchSize).map(async (name) => {
        // 回退发布端点后才删除丢弃的轮。跳过已经消失的记录，端点变化由 loadView 重试。
        const text = await readTextOrNull(join(directory, name));
        if (text === null) return null;
        return parseStoredTurn(text, name);
      }),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      if (result.value !== null) turns.push(result.value);
    }
  }
  return turns;
}

interface LedgerView {
  head: number;
  /** In descending sequence order, starting at the physical head. */
  turns: Map<number, StoredTurn>;
}

// 沿当前端点回溯已发布的链。回退跳过被丢弃的轮，即使这些记录还未清理。
// 遍历量取决于实际记录数，与被跳过的轮号间距无关。
function viewOf(head: number, turns: readonly StoredTurn[]): LedgerView {
  const stored = new Map(turns.map((turn) => [turn.record.sequence, turn]));
  const visible = new Map<number, StoredTurn>();
  let position = head;
  while (position > 0) {
    const turn = stored.get(position);
    if (turn === undefined)
      throw new WorldTurnLedgerError(
        "missing_record",
        `缺少第 ${position} 轮记录`,
      );
    visible.set(position, turn);
    position = turn.record.restoresSequence ?? position - 1;
  }
  for (const { record } of turns) {
    if (record.sequence <= head) continue;
    if (
      record.sequence !== head + 1 ||
      (record.restoresSequence !== undefined &&
        record.restoresSequence !== 0 &&
        !visible.has(record.restoresSequence))
    )
      throw new WorldTurnLedgerError(
        "corrupt",
        `第 ${record.sequence} 轮的未完成记录与当前端点不一致`,
      );
  }
  return { head, turns: visible };
}

// 进程内视图缓存，按端点失效。一个数据目录只被一个进程操作（ADR-0044），
// 所以 head 相同即记录相同：任何改变可见记录的写入都会先推进 head。
// beginTurn 与 recoverIncomplete 会在 head 之上写入或删除记录，它们不改变已发布的视图。
const viewCache = new Map<string, LedgerView>();

function rememberView(key: string, view: LedgerView): void {
  viewCache.delete(key);
  viewCache.set(key, view);
  if (viewCache.size > maxCachedWorlds) {
    const oldest = viewCache.keys().next();
    if (!oldest.done) viewCache.delete(oldest.value);
  }
}

// An unpublished turn can start and be rolled back without advancing head.
// Track overlapping writes for as long as a reader can observe them.
const activeReaders = new Map<string, { generation: number; count: number }>();

function noteFileWrite(root: string): void {
  const readers = activeReaders.get(resolve(root));
  if (readers !== undefined) readers.generation += 1;
}

// 一次读取只解析一个视图。回退先发布新端点、再删除被丢弃的轮记录：读完记录后端点仍未变化，
// 说明读到的记录与这个端点一致；端点变了就用新端点重新读取。
async function loadView(root: string): Promise<LedgerView> {
  const key = resolve(root);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await readHead(root);
    const cached = viewCache.get(key);
    if (cached?.head === head) {
      rememberView(key, cached);
      return cached;
    }
    const turns = await readAllRecords(root);
    if ((await readHead(root)) !== head) continue;
    const view = viewOf(head, turns);
    rememberView(key, view);
    return view;
  }
  throw new WorldTurnLedgerError(
    "read_conflict",
    "读取期间世界端点持续变化，请重试",
  );
}

// 世界目录被删除、归档导入或分叉发布到已存在路径之前调用：下一次读取从磁盘重建视图。
export function forgetLedger(root: string): void {
  viewCache.delete(resolve(root));
}

// 把一个端点解析到它的逻辑位置：rewind 位置等价于它所恢复的位置。
function resolvePosition(view: LedgerView, sequence: number): number {
  if (!isSequence(sequence) || sequence > view.head) {
    throw new WorldTurnLedgerError(
      "unreachable",
      `端点 ${sequence} 不在当前账本范围内`,
    );
  }
  let position = sequence;
  for (;;) {
    if (position === 0) return 0;
    const turn = view.turns.get(position);
    if (turn === undefined) {
      throw new WorldTurnLedgerError(
        "discarded",
        `端点 ${sequence} 已被回退丢弃`,
      );
    }
    const { record } = turn;
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
  for (const [position, { record }] of view.turns) {
    if (position <= sequence) break;
    if (record.mode === "rewind") continue;
    for (const file of record.files) {
      overlay.set(file.path, file.before);
    }
  }
  return overlay;
}

/** Plan the ledger files for a private fork staging directory under the source lock. */
export async function planForkLedger(
  root: string,
  sequence: number,
): Promise<{
  shouldCopy: (path: string) => boolean;
  finish: (staging: string) => Promise<void>;
}> {
  const view = await loadView(root);
  const target = resolvePosition(view, sequence);
  const rewinds = target !== resolvePosition(view, view.head);
  const retainedTurns = new Set<string>();
  for (const position of view.turns.keys()) {
    if (!rewinds || position <= target)
      retainedTurns.add(ledgerPath(turnFileName(position)));
  }
  const pendingPath = turnFileName(view.head + 1);
  const pendingText = await readTextOrNull(join(root, pendingPath));
  const pending =
    pendingText === null
      ? undefined
      : parseTurn(pendingText, basename(pendingPath));
  const overlay = new Map(
    pending?.files.map(({ path, before }) => [path, before]),
  );
  for (const [path, before] of overlayAfter(view, target))
    overlay.set(path, before);

  return {
    shouldCopy: (path) =>
      path.startsWith("runtime/turns/")
        ? retainedTurns.has(path)
        : !overlay.has(path),
    finish: async (staging) => {
      const checkedDirectories = new Set([staging]);
      const checkParent = async (directory: string): Promise<void> => {
        if (checkedDirectories.has(directory)) return;
        await checkParent(dirname(directory));
        const entry = await lstat(directory).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (entry !== null && !entry.isDirectory())
          throw new WorldTurnLedgerError(
            "invalid_path",
            `分叉暂存区的父路径不是目录：${directory}`,
          );
        checkedDirectories.add(directory);
      };
      for (const [path, before] of overlay) {
        if (before === null) continue;
        const destination = join(staging, path);
        await checkParent(dirname(destination));
        await writeFileAtomic(destination, before);
      }
      if (!rewinds) return;

      // Keep the physical sequence so a continuation cannot reuse a discarded
      // turn number. An unpublished fork is discarded on failure, so it does
      // not need a rollback journal containing the source's discarded bytes.
      const record: WorldTurnRecord = {
        sequence: view.head + 1,
        mode: "rewind",
        restoresSequence: target,
        createdAt: new Date().toISOString(),
        files: [],
      };
      await writeTurnRecord(staging, record);
      await publishHead(staging, record.sequence);
    },
  };
}

function ledgerPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function writeTurnRecord(
  root: string,
  record: WorldTurnRecord,
): Promise<{ record: WorldTurnRecord; text: string }> {
  const path = turnFileName(record.sequence);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  // Validate the serialized form and keep its detached, normalized record.
  const parsed = parseTurn(text, basename(path));
  await writeFileAtomic(join(root, path), text);
  return { record: parsed, text };
}

function parseStoredTurn(text: string, name: string): StoredTurn {
  return {
    record: parseTurn(text, name),
    digest: turnDigest(text),
  };
}

function turnDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

interface TurnInput {
  mode: WorldTurnMode;
  changes: readonly WorldTurnFileChange[];
  restoresSequence?: number;
  payload?: unknown;
}

async function recoverPendingTurn(
  root: string,
  head: number,
): Promise<boolean> {
  // A journal at head + 1 marks an interrupted turn. Recover before capturing
  // before-images so a partial write cannot become the next turn's baseline.
  if ((await readTextOrNull(join(root, turnFileName(head + 1)))) === null)
    return false;
  await recoverIncomplete(root);
  return true;
}

async function prepareTurn(
  root: string,
  head: number,
  input: TurnInput & { createdAt?: string },
): Promise<WorldTurnRecord> {
  return {
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
}

// 第一步：写入本轮记录（序号为 head + 1）。记录原子落盘，之后任何一步崩溃都可由 recoverIncomplete 回滚。
export async function beginTurn(
  root: string,
  input: TurnInput & { createdAt?: string },
): Promise<WorldTurnRecord> {
  const head = await readHead(root);
  await recoverPendingTurn(root, head);
  const record = await prepareTurn(root, head, input);
  await writeTurnRecord(root, record);
  return record;
}

// 第二步：逐文件原子替换（写临时文件后 rename；删除即 rm）。
export async function applyChanges(
  root: string,
  changes: readonly WorldTurnFileChange[],
): Promise<void> {
  noteFileWrite(root);
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
  const previous = await loadView(root);
  if (record.sequence !== previous.head + 1)
    throw new WorldTurnLedgerError("corrupt", "要发布的轮与当前端点不一致");
  const path = turnFileName(record.sequence);
  const text = await readFile(join(root, path), "utf8");
  // A split caller supplies a sequence only. The journal on disk is authoritative.
  await publishTurn(root, previous, parseStoredTurn(text, basename(path)));
}

async function publishTurn(
  root: string,
  previous: LedgerView,
  stored: StoredTurn,
): Promise<void> {
  const { sequence } = stored.record;
  const next = viewOf(sequence, [...previous.turns.values(), stored]);
  await publishHead(root, sequence);
  rememberView(resolve(root), next);
}

export async function appendTurn(
  root: string,
  input: TurnInput,
): Promise<WorldTurnRecord> {
  return (await appendTurnWithDigest(root, input)).record;
}

export async function appendTurnWithDigest(
  root: string,
  input: TurnInput,
): Promise<StoredTurn> {
  // The caller serializes writes for this world. Load the parent before
  // writing so even a cold or evicted view never re-parses our new journal.
  let previous = await loadView(root);
  if (await recoverPendingTurn(root, previous.head))
    previous = await loadView(root);
  const record = await prepareTurn(root, previous.head, input);
  const written = await writeTurnRecord(root, record);
  const digest = turnDigest(written.text);
  try {
    await applyChanges(root, input.changes);
    if ((await readHead(root)) !== previous.head)
      throw new WorldTurnLedgerError("corrupt", "要发布的轮与当前端点不一致");
    await publishTurn(root, previous, { record: written.record, digest });
  } catch (error: unknown) {
    // 本轮未发布：用启动恢复的同一规则回滚。回滚本身失败时保留原始错误；
    // 残留的记录留在 head + 1 上，下一次推进开始前会先恢复（见 beginTurn）。
    await recoverIncomplete(root).catch(() => undefined);
    throw error;
  }
  // The caller gets its own input record. Only the parsed copy enters the view.
  return { record, digest };
}

// 世界首次打开时调用（FileNativeWorldStore），进程内推进失败时也调用：序号大于 head 的记录
// 说明对应推进未完成，逆序恢复其修改前像。被丢弃的轮记录（读取时已忽略）在这里清理。
// 返回是否回滚了未完成的轮。
export async function recoverIncomplete(
  root: string,
  requireCommitMetadata = false,
): Promise<boolean> {
  const head = await readHead(root);
  const turns = await readAllRecords(root);
  const view = viewOf(head, turns);
  if (requireCommitMetadata) {
    for (const { record } of view.turns.values()) {
      if (record.mode !== "rewind" && record.payload === undefined)
        throw new WorldTurnLedgerError(
          "corrupt",
          `第 ${record.sequence} 轮缺少提交元数据`,
        );
    }
  }
  const incomplete = turns
    .map(({ record }) => record)
    .filter((record) => record.sequence > head)
    .sort((left, right) => right.sequence - left.sequence);
  if (incomplete.length > 0) noteFileWrite(root);
  for (const record of incomplete) {
    for (const file of [...record.files].reverse()) {
      const absolute = join(root, file.path);
      if (file.before === null) {
        await rm(absolute, { force: true });
      } else {
        await writeFileAtomic(absolute, file.before);
      }
    }
    await rm(join(root, turnFileName(record.sequence)), { force: true });
  }
  for (const { record } of turns) {
    if (record.sequence <= head && !view.turns.has(record.sequence))
      await rm(join(root, turnFileName(record.sequence)), { force: true });
  }
  rememberView(resolve(root), view);
  return incomplete.length > 0;
}

export async function listTurns(root: string): Promise<WorldTurnRecord[]> {
  const view = await loadView(root);
  return structuredClone(turnsThrough(view, view.head));
}

function* turnsBackFrom(
  view: LedgerView,
  position: number,
): IterableIterator<WorldTurnRecord> {
  while (position > 0) {
    const record = view.turns.get(position)!.record;
    yield record;
    position = record.restoresSequence ?? position - 1;
  }
}

function turnsThrough(view: LedgerView, position: number): WorldTurnRecord[] {
  return [...turnsBackFrom(view, position)].reverse();
}

/** Internal reader. Returned records are borrowed from the cached view. */
export async function readTurnHistory(
  root: string,
  requested?: number,
): Promise<{
  sequence: number;
  turns: WorldTurnRecord[];
}> {
  const view = await loadView(root);
  const sequence = resolvePosition(view, requested ?? view.head);
  return { sequence, turns: turnsThrough(view, sequence) };
}

/** The logical position, borrowed record and digest all come from one view. */
export async function readEndpoint(
  root: string,
  requested?: number,
): Promise<{
  sequence: number;
  record: WorldTurnRecord | null;
  digest: string | null;
}> {
  const view = await loadView(root);
  const sequence = resolvePosition(view, requested ?? view.head);
  const turn = view.turns.get(sequence);
  return {
    sequence,
    record: turn?.record ?? null,
    digest: turn?.digest ?? null,
  };
}

// 读取端点 sequence 处某个文件的内容；不存在返回 null。
export async function readFileAt(
  root: string,
  sequence: number,
  relativePath: string,
): Promise<string | null> {
  const { files } = await readLedgerFiles(root, sequence, {
    paths: [relativePath],
  });
  return files.get(relativePath) ?? null;
}

// 读取端点 sequence 处 dirs 下的全部文件（相对路径 → 内容）。
export async function readTreeAt(
  root: string,
  sequence: number | undefined,
  dirs: readonly string[],
): Promise<Map<string, string>> {
  return (await readLedgerFiles(root, sequence, { dirs })).files;
}

/** Read files and borrowed turn records from one published endpoint. */
export async function readLedgerFiles(
  root: string,
  sequence: number | undefined,
  selection: {
    dirs?: readonly string[];
    paths?: readonly string[];
    includeTurns?: boolean;
  },
): Promise<{
  sequence: number;
  files: Map<string, string>;
  turns: WorldTurnRecord[];
}> {
  const {
    sequence: position,
    files,
    projection: turns,
  } = await readLedgerProjection(root, sequence, (_position, turnsBack) => ({
    ...selection,
    projection: selection.includeTurns ? [...turnsBack()].reverse() : [],
  }));
  return { sequence: position, files, turns };
}

/** Choose the files for a projection from the same view used to recover them. */
export async function readLedgerProjection<Projection>(
  root: string,
  sequence: number | undefined,
  select: (
    position: number,
    turnsBack: () => IterableIterator<WorldTurnRecord>,
  ) => {
    dirs?: readonly string[];
    paths?: readonly string[];
    projection: Projection;
  },
): Promise<{
  sequence: number;
  files: Map<string, string>;
  projection: Projection;
}> {
  const key = resolve(root);
  const readers = activeReaders.get(key) ?? { generation: 0, count: 0 };
  activeReaders.set(key, readers);
  readers.count += 1;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generation = readers.generation;
      const view = await loadView(root);
      const position = resolvePosition(view, sequence ?? view.head);
      const {
        dirs = [],
        paths = [],
        projection,
      } = select(position, () => turnsBackFrom(view, position));
      if (dirs.length === 0 && paths.length === 0)
        return { sequence: position, files: new Map(), projection };
      for (const path of [...dirs, ...paths]) assertSafePath(path);
      const stable = async () =>
        (await readHead(root)) === view.head &&
        readers.generation === generation;
      let files: Map<string, string>;
      try {
        const pendingPath = turnFileName(view.head + 1);
        const pendingText = await readTextOrNull(join(root, pendingPath));
        const pending =
          pendingText === null
            ? undefined
            : parseTurn(pendingText, basename(pendingPath));
        // The journal is written before replacement starts. Its before-images
        // recover the published files even if the writer is paused mid-turn.
        const overlay = new Map(
          pending?.files.map(({ path, before }) => [path, before]),
        );
        for (const [path, before] of overlayAfter(view, position))
          overlay.set(path, before);
        files = await collectFiles(root, dirs, paths, overlay);
      } catch (error: unknown) {
        if (await stable()) throw error;
        continue;
      }
      if (!(await stable())) continue;
      return { sequence: position, files, projection };
    }
    throw new WorldTurnLedgerError(
      "read_conflict",
      "读取期间世界端点持续变化，请重试",
    );
  } finally {
    readers.count -= 1;
    if (readers.count === 0) activeReaders.delete(key);
  }
}

async function collectFiles(
  root: string,
  dirs: readonly string[],
  paths: readonly string[],
  overlay: ReadonlyMap<string, string | null>,
): Promise<Map<string, string>> {
  const wanted = new Set(paths);
  for (const dir of dirs)
    for (const path of await listFiles(root, dir)) wanted.add(path);
  const files = new Map<string, string>();
  for (const [path, before] of overlay) {
    if (wanted.has(path) || dirs.some((dir) => path.startsWith(`${dir}/`))) {
      wanted.delete(path);
      if (before !== null) files.set(path, before);
    }
  }
  for (const path of wanted) {
    const text = await readTextOrNull(join(root, path));
    if (text !== null) files.set(path, text);
  }
  return files;
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
      } else if (
        entry.isFile() &&
        !/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(
          entry.name,
        )
      ) {
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
  if (target === resolvePosition(view, view.head)) return null;
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
    restoresSequence: target,
  });
  // 端点已发布，丢弃的记录即可删除；失败可忽略，读取已把它们当作不可达，重新打开时会再清理。
  for (const position of view.turns.keys()) {
    if (position <= target) break;
    await rm(join(root, turnFileName(position)), { force: true }).catch(
      () => undefined,
    );
  }
  return record;
}
