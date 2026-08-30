import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { MaterialSelection } from "../prompt/FileNativePromptCompiler.ts";
import type { FileNativePlayTimelineStore } from "../play/FileNativePlayTimelineStore.ts";

const currentAuthorityHeadFile = "play-authority-head.json";
const releasedAuthorityFile = "play-authority.json";
const releasedCallChainFile = "play-call-chain.json";

interface ReleasedHistoryMessage {
  messageId: string;
  role: "player" | "narrator";
  exactText: string;
}

interface ReleasedStateChange {
  kind: "create" | "replace";
  documentId: string;
  stableShortRef: string;
  relativePath: string;
  codec: "yaml" | "markdown";
  expectedPreviousHash: string | null;
  nextHash: string;
  canonicalNextBytes: string;
}

interface ReleasedTimelineRevision {
  restoresHead: string;
  replacesHead: string;
  requestFingerprint: string;
  replacementState: {
    path: string;
    sha256: string;
    canonicalBytes: string;
  }[];
  replacementHistory: ReleasedHistoryMessage[];
}

interface ReleasedPlayCommit {
  schemaVersion: 1;
  operationId: string;
  parentHead: string;
  head: string;
  mode: "play" | "correction" | "timeline_revision";
  historyAppend: ReleasedHistoryMessage[];
  stateChanges: ReleasedStateChange[];
  nextAdditionalMaterials: MaterialSelection[];
  correctionTargets?: string[];
  corrects?: string;
  timelineRevision?: ReleasedTimelineRevision;
}

interface ReleasedPlayAuthority {
  schemaVersion: 1;
  head: string;
  commits: ReleasedPlayCommit[];
}

interface CurrentPlayCommit extends Omit<ReleasedPlayCommit, "schemaVersion"> {
  schemaVersion: 2;
  sequence: number;
  parentCommitDigest: string | null;
}

interface CurrentAuthorityHead {
  schemaVersion: 2;
  head: string;
  sequence: number;
  commitDigest: string | null;
  operationId: string | null;
}

interface CurrentMaterializedCheckpoint {
  schemaVersion: 2;
  head: string;
  sequence: number;
  commitDigest: string | null;
}

export interface FileNativeWorldStorageMigrationResult {
  outcome: "already_current" | "migrated";
  authorityCommits: number;
  callChainContexts: number;
}

/**
 * One-way upgrade seam for every cumulative storage shape shipped through
 * v0.1.1. Callers serialize this module per world. It writes all new facts and
 * projections first and publishes the small Authority head last, so that head
 * is also the durable marker for the whole current layout.
 */
export class FileNativeWorldStorageMigrator {
  readonly #worldsRoot: string;
  readonly #operationsRoot: string;
  readonly #timeline: FileNativePlayTimelineStore;

  constructor(dataRoot: string, timeline: FileNativePlayTimelineStore) {
    const root = resolve(dataRoot);
    this.#worldsRoot = join(root, "worlds-file-native");
    this.#operationsRoot = join(root, "operations");
    this.#timeline = timeline;
  }

  async migrate(
    worldId: string,
  ): Promise<FileNativeWorldStorageMigrationResult> {
    assertIdentity(worldId, "World ID");
    const worldRoot = join(this.#worldsRoot, worldId);
    const runtimeRoot = join(worldRoot, "runtime");
    const current = await readOptionalJson<unknown>(
      join(runtimeRoot, currentAuthorityHeadFile),
    );
    if (current !== null) {
      assertCurrentAuthorityHead(current);
      return {
        outcome: "already_current",
        authorityCommits: current.sequence,
        callChainContexts: 0,
      };
    }

    const publication = await readJson<unknown>(
      join(worldRoot, "publication.json"),
    );
    if (
      !isRecord(publication) ||
      publication.schemaVersion !== 1 ||
      publication.worldId !== worldId
    )
      throw new Error("Released world publication has an invalid identity");
    const genesis = await readJson<unknown>(join(runtimeRoot, "genesis.json"));
    const genesisHistory = releasedGenesisHistory(genesis, worldId);
    const releasedAuthority = await readReleasedAuthority(worldRoot);
    const currentCommits = convertReleasedCommits(releasedAuthority.commits);

    await publishJson(join(runtimeRoot, "play-genesis-timeline.json"), {
      schemaVersion: 1,
      worldId,
      history: genesisHistory,
    });

    const callChainSource = await readOptionalText(
      join(runtimeRoot, releasedCallChainFile),
    );
    let callChainContexts = 0;
    if (callChainSource !== null) {
      const value = parseJson(callChainSource, "Released play call chain");
      callChainContexts =
        isRecord(value) && Array.isArray(value.previousContexts)
          ? value.previousContexts.length + 1
          : 1;
      await this.#timeline.migrateReleasedRecord(
        worldId,
        value,
        sha256Hex(callChainSource),
      );
    }
    crashAtStorageMigrationEdge("after_timeline");

    for (const commit of currentCommits)
      await publishImmutableJson(
        join(
          runtimeRoot,
          "play-commits",
          `${currentCommitDigest(commit)}.json`,
        ),
        commit,
      );

    const checkpoint = await migrateMaterializedCheckpoint(
      runtimeRoot,
      currentCommits,
    );
    await publishJson(join(runtimeRoot, "materialized-head.json"), checkpoint);
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    for (const commit of currentCommits) {
      const outcome = {
        outcome:
          checkpoint.sequence >= commit.sequence
            ? ("committed" as const)
            : ("committed_materialization_pending" as const),
        worldId,
        parentHead: commit.parentHead,
        head: commit.head,
        commitDigest: currentCommitDigest(commit),
        historyAppend: commit.historyAppend.map(({ role, exactText }) => ({
          role,
          exactText,
        })),
        nextAdditionalMaterials: structuredClone(
          commit.nextAdditionalMaterials,
        ),
        mode: commit.mode,
      };
      await publishJson(
        operationOutcomePath(this.#operationsRoot, commit.operationId),
        outcome,
      );
    }
    crashAtStorageMigrationEdge("after_current_facts");

    await verifyCurrentFacts(runtimeRoot, currentCommits, checkpoint);
    crashAtStorageMigrationEdge("before_current_head");
    const tip = currentCommits.at(-1);
    const head: CurrentAuthorityHead =
      tip === undefined
        ? {
            schemaVersion: 2,
            head: "genesis",
            sequence: 0,
            commitDigest: null,
            operationId: null,
          }
        : {
            schemaVersion: 2,
            head: tip.head,
            sequence: tip.sequence,
            commitDigest: currentCommitDigest(tip),
            operationId: tip.operationId,
          };
    await publishJson(join(runtimeRoot, currentAuthorityHeadFile), head);
    crashAtStorageMigrationEdge("after_current_head");
    return {
      outcome: "migrated",
      authorityCommits: currentCommits.length,
      callChainContexts,
    };
  }
}

async function readReleasedAuthority(
  worldRoot: string,
): Promise<ReleasedPlayAuthority> {
  const runtimeRoot = join(worldRoot, "runtime");
  const published = await readOptionalJson<unknown>(
    join(runtimeRoot, releasedAuthorityFile),
  );
  if (published !== null) {
    assertReleasedAuthority(published);
    for (const commit of published.commits) {
      const digest = releasedCommitDigest(commit);
      const immutable = await readJson<unknown>(
        join(runtimeRoot, "play-commits", `${digest}.json`),
      );
      assertReleasedCommit(immutable);
      if (!isDeepStrictEqual(immutable, commit))
        throw new Error(
          `Released Authority endpoint does not match immutable commit ${commit.head}`,
        );
    }
    return structuredClone(published);
  }

  const names = await readDirectoryFileNames(join(runtimeRoot, "play-commits"));
  const remaining: ReleasedPlayCommit[] = [];
  for (const name of names) {
    const value = await readJson<unknown>(
      join(runtimeRoot, "play-commits", name),
    );
    if (isRecord(value) && value.schemaVersion === 2) continue;
    assertReleasedCommit(value);
    if (name !== `${releasedCommitDigest(value)}.json`)
      throw new Error(
        "Released immutable commit does not match its durable identity",
      );
    remaining.push(value);
  }
  if (remaining.length === 0)
    return { schemaVersion: 1, head: "genesis", commits: [] };
  const commits: ReleasedPlayCommit[] = [];
  let parent = "genesis";
  while (remaining.length > 0) {
    const matches = remaining.filter((commit) => commit.parentHead === parent);
    if (matches.length !== 1)
      throw new Error(
        "Released immutable commits cannot rebuild one unique Authority chain",
      );
    const next = matches[0]!;
    commits.push(next);
    remaining.splice(remaining.indexOf(next), 1);
    parent = next.head;
  }
  const rebuilt: ReleasedPlayAuthority = {
    schemaVersion: 1,
    head: parent,
    commits,
  };
  assertReleasedAuthority(rebuilt);
  return rebuilt;
}

function convertReleasedCommits(
  commits: readonly ReleasedPlayCommit[],
): CurrentPlayCommit[] {
  const converted: CurrentPlayCommit[] = [];
  let parentCommitDigest: string | null = null;
  for (const [index, source] of commits.entries()) {
    const commit: CurrentPlayCommit = {
      schemaVersion: 2,
      sequence: index + 1,
      operationId: source.operationId,
      parentHead: source.parentHead,
      parentCommitDigest,
      head: source.head,
      mode: source.mode,
      historyAppend: structuredClone(source.historyAppend),
      stateChanges: structuredClone(source.stateChanges),
      nextAdditionalMaterials: structuredClone(source.nextAdditionalMaterials),
      ...(source.correctionTargets === undefined
        ? {}
        : { correctionTargets: structuredClone(source.correctionTargets) }),
      ...(source.corrects === undefined ? {} : { corrects: source.corrects }),
      ...(source.timelineRevision === undefined
        ? {}
        : { timelineRevision: structuredClone(source.timelineRevision) }),
    };
    converted.push(commit);
    parentCommitDigest = currentCommitDigest(commit);
  }
  return converted;
}

async function migrateMaterializedCheckpoint(
  runtimeRoot: string,
  commits: readonly CurrentPlayCommit[],
): Promise<CurrentMaterializedCheckpoint> {
  const value = await readOptionalJson<unknown>(
    join(runtimeRoot, "materialized-head.json"),
  );
  if (value === null)
    return {
      schemaVersion: 2,
      head: "genesis",
      sequence: 0,
      commitDigest: null,
    };
  if (isCurrentMaterializedCheckpoint(value)) {
    const expected =
      value.sequence === 0 ? undefined : commits[value.sequence - 1];
    if (
      (value.sequence === 0 &&
        (value.head !== "genesis" || value.commitDigest !== null)) ||
      (value.sequence > 0 &&
        (expected?.head !== value.head ||
          currentCommitDigest(expected) !== value.commitDigest))
    )
      throw new Error(
        "Partially migrated materialized checkpoint is not in released Authority",
      );
    return structuredClone(value);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["head"]) ||
    typeof value.head !== "string"
  )
    throw new Error("Released materialized checkpoint has an invalid shape");
  if (value.head === "genesis")
    return {
      schemaVersion: 2,
      head: "genesis",
      sequence: 0,
      commitDigest: null,
    };
  const commit = commits.find(({ head }) => head === value.head);
  if (commit === undefined)
    throw new Error(
      "Released materialized checkpoint is not in accepted Authority",
    );
  return {
    schemaVersion: 2,
    head: commit.head,
    sequence: commit.sequence,
    commitDigest: currentCommitDigest(commit),
  };
}

async function verifyCurrentFacts(
  runtimeRoot: string,
  commits: readonly CurrentPlayCommit[],
  checkpoint: CurrentMaterializedCheckpoint,
): Promise<void> {
  let parentDigest: string | null = null;
  for (const commit of commits) {
    if (commit.parentCommitDigest !== parentDigest)
      throw new Error("Migrated Authority parent digest is inconsistent");
    const digest = currentCommitDigest(commit);
    const durable = await readJson<unknown>(
      join(runtimeRoot, "play-commits", `${digest}.json`),
    );
    if (!isDeepStrictEqual(durable, commit))
      throw new Error("Migrated Authority commit verification failed");
    parentDigest = digest;
  }
  const durableCheckpoint = await readJson<unknown>(
    join(runtimeRoot, "materialized-head.json"),
  );
  if (!isDeepStrictEqual(durableCheckpoint, checkpoint))
    throw new Error("Migrated materialized checkpoint verification failed");
}

function releasedGenesisHistory(
  value: unknown,
  worldId: string,
): ReleasedHistoryMessage[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.type !== "file_native_genesis" ||
    value.worldId !== worldId ||
    !Array.isArray(value.history) ||
    !value.history.every(isReleasedHistoryMessage)
  )
    throw new Error("Released world genesis has an invalid identity");
  return structuredClone(value.history);
}

function assertReleasedAuthority(
  value: unknown,
): asserts value is ReleasedPlayAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "head", "commits"]) ||
    value.schemaVersion !== 1 ||
    typeof value.head !== "string" ||
    !Array.isArray(value.commits)
  )
    throw new Error("Released Play Authority has an invalid shape");
  const operationIds = new Set<string>();
  const heads = new Set<string>();
  const commitsByHead = new Map<string, ReleasedPlayCommit>();
  let parent = "genesis";
  for (const [index, commit] of value.commits.entries()) {
    assertReleasedCommit(commit);
    const revision = commit.timelineRevision;
    const replaced =
      revision === undefined
        ? undefined
        : commitsByHead.get(revision.replacesHead);
    const replacedLogicalParent =
      replaced?.mode === "timeline_revision"
        ? replaced.timelineRevision!.restoresHead
        : replaced?.parentHead;
    if (
      commit.parentHead !== parent ||
      commit.head !== `commit:${index + 1}` ||
      operationIds.has(commit.operationId) ||
      heads.has(commit.head) ||
      (commit.mode === "timeline_revision" &&
        ((revision!.restoresHead !== "genesis" &&
          !heads.has(revision!.restoresHead)) ||
          replaced === undefined ||
          !replaced.historyAppend.some(({ role }) => role === "player") ||
          replacedLogicalParent !== revision!.restoresHead))
    )
      throw new Error("Released Play Authority commit chain is invalid");
    operationIds.add(commit.operationId);
    heads.add(commit.head);
    commitsByHead.set(commit.head, commit);
    parent = commit.head;
  }
  if (value.head !== parent)
    throw new Error("Released Play Authority head is invalid");
}

function assertReleasedCommit(
  value: unknown,
): asserts value is ReleasedPlayCommit {
  if (!isRecord(value))
    throw new Error("Released play commit has an invalid shape");
  const correction = value.mode === "correction";
  const timelineRevision = value.mode === "timeline_revision";
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "operationId",
      "parentHead",
      "head",
      "mode",
      "historyAppend",
      "stateChanges",
      "nextAdditionalMaterials",
      ...(correction ? ["correctionTargets", "corrects"] : []),
      ...(timelineRevision ? ["timelineRevision"] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.trim() === "" ||
    typeof value.parentHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.parentHead) ||
    typeof value.head !== "string" ||
    !/^commit:[1-9][0-9]*$/u.test(value.head) ||
    (value.mode !== "play" &&
      value.mode !== "correction" &&
      value.mode !== "timeline_revision") ||
    !Array.isArray(value.historyAppend) ||
    (correction
      ? value.historyAppend.length !== 0
      : timelineRevision
        ? value.historyAppend.length !== 1 ||
          !isRecord(value.historyAppend[0]) ||
          value.historyAppend[0].role !== "player"
        : value.historyAppend.length === 0 &&
          (!Array.isArray(value.stateChanges) ||
            value.stateChanges.length === 0)) ||
    !value.historyAppend.every(isReleasedHistoryMessage) ||
    !Array.isArray(value.stateChanges) ||
    !value.stateChanges.every(isReleasedStateChange) ||
    !Array.isArray(value.nextAdditionalMaterials) ||
    !value.nextAdditionalMaterials.every(isMaterialSelection)
  )
    throw new Error("Released play commit has an invalid shape");
  if (
    correction &&
    (!Array.isArray(value.correctionTargets) ||
      !value.correctionTargets.every(
        (target) => typeof target === "string" && target.trim() !== "",
      ) ||
      typeof value.corrects !== "string" ||
      value.corrects !== value.parentHead)
  )
    throw new Error("Released correction commit has an invalid shape");
  if (
    timelineRevision &&
    (value.stateChanges.length !== 0 ||
      !isReleasedTimelineRevision(value.timelineRevision))
  )
    throw new Error("Released timeline-revision commit has an invalid shape");
}

function isReleasedTimelineRevision(
  value: unknown,
): value is ReleasedTimelineRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "restoresHead",
      "replacesHead",
      "requestFingerprint",
      "replacementState",
      "replacementHistory",
    ]) ||
    typeof value.restoresHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.restoresHead) ||
    typeof value.replacesHead !== "string" ||
    !/^commit:[1-9][0-9]*$/u.test(value.replacesHead) ||
    typeof value.requestFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.requestFingerprint) ||
    !Array.isArray(value.replacementState) ||
    !Array.isArray(value.replacementHistory) ||
    !value.replacementHistory.every(isReleasedHistoryMessage)
  )
    return false;
  return value.replacementState.every(
    (file) =>
      isRecord(file) &&
      hasExactKeys(file, ["path", "sha256", "canonicalBytes"]) &&
      typeof file.path === "string" &&
      validRelativePath(file.path) &&
      typeof file.sha256 === "string" &&
      typeof file.canonicalBytes === "string" &&
      `sha256:${sha256Hex(file.canonicalBytes)}` === file.sha256,
  );
}

function isReleasedHistoryMessage(
  value: unknown,
): value is ReleasedHistoryMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["messageId", "role", "exactText"]) &&
    typeof value.messageId === "string" &&
    value.messageId.trim() !== "" &&
    (value.role === "player" || value.role === "narrator") &&
    typeof value.exactText === "string"
  );
}

function isReleasedStateChange(value: unknown): value is ReleasedStateChange {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "kind",
      "documentId",
      "stableShortRef",
      "relativePath",
      "codec",
      "expectedPreviousHash",
      "nextHash",
      "canonicalNextBytes",
    ]) &&
    (value.kind === "create" || value.kind === "replace") &&
    typeof value.documentId === "string" &&
    value.documentId.trim() !== "" &&
    typeof value.stableShortRef === "string" &&
    value.stableShortRef.trim() !== "" &&
    typeof value.relativePath === "string" &&
    validRelativePath(value.relativePath) &&
    (value.codec === "yaml" || value.codec === "markdown") &&
    (value.expectedPreviousHash === null ||
      (typeof value.expectedPreviousHash === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(value.expectedPreviousHash))) &&
    typeof value.nextHash === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.nextHash) &&
    typeof value.canonicalNextBytes === "string" &&
    `sha256:${sha256Hex(value.canonicalNextBytes)}` === value.nextHash
  );
}

function isMaterialSelection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "document")
    return (
      hasExactKeys(value, ["kind", "document"]) &&
      typeof value.document === "string"
    );
  if (value.kind === "node")
    return (
      hasExactKeys(value, ["kind", "document", "locator"]) &&
      typeof value.document === "string" &&
      isMaterialLocator(value.locator)
    );
  if (value.kind === "history_message")
    return (
      hasExactKeys(value, ["kind", "message"]) &&
      typeof value.message === "string"
    );
  return (
    value.kind === "history_commit" &&
    hasExactKeys(value, ["kind", "commit"]) &&
    typeof value.commit === "string"
  );
}

function isMaterialLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasRequiredAndOptionalKeys(value, [], ["yaml", "markdown"]) &&
    (value.yaml === undefined ||
      (Array.isArray(value.yaml) &&
        value.yaml.every(
          (segment) =>
            typeof segment === "string" || Number.isSafeInteger(segment),
        ))) &&
    (value.markdown === undefined ||
      (Array.isArray(value.markdown) &&
        value.markdown.every((segment) => typeof segment === "string")))
  );
}

function assertCurrentAuthorityHead(
  value: unknown,
): asserts value is CurrentAuthorityHead {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "head",
      "sequence",
      "commitDigest",
      "operationId",
    ]) ||
    value.schemaVersion !== 2 ||
    typeof value.head !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.commitDigest !== null &&
      (typeof value.commitDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.commitDigest))) ||
    (value.operationId !== null && typeof value.operationId !== "string") ||
    (Number(value.sequence) === 0
      ? value.head !== "genesis" ||
        value.commitDigest !== null ||
        value.operationId !== null
      : value.head !== `commit:${String(value.sequence)}` ||
        value.commitDigest === null ||
        value.operationId === null)
  )
    throw new Error("Current Authority head has an invalid shape");
}

function isCurrentMaterializedCheckpoint(
  value: unknown,
): value is CurrentMaterializedCheckpoint {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "head",
      "sequence",
      "commitDigest",
    ]) &&
    value.schemaVersion === 2 &&
    typeof value.head === "string" &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    (value.commitDigest === null ||
      (typeof value.commitDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(value.commitDigest)))
  );
}

function currentCommitDigest(commit: CurrentPlayCommit): string {
  return sha256Hex(JSON.stringify(commit));
}

function releasedCommitDigest(commit: ReleasedPlayCommit): string {
  return sha256Hex(JSON.stringify(commit));
}

function operationOutcomePath(root: string, operationId: string): string {
  return join(root, `outcome-${sha256Hex(operationId)}.json`);
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value))
    throw new TypeError(`${label} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function readJson<T>(path: string): Promise<T> {
  return parseJson(await readFile(path, "utf8"), path) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readDirectoryFileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(({ name }) => name)
      .sort();
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function publishImmutableJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(temporary);
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== contents)
        throw new Error(
          "Migrated immutable file conflicts with existing data",
          {
            cause: error,
          },
        );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "EINVAL") throw error;
  } finally {
    await handle?.close();
  }
}

function crashAtStorageMigrationEdge(edge: string): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_STORAGE_MIGRATION_EDGE === edge
  )
    process.kill(process.pid, "SIGKILL");
}
