import type { HistoryBackground } from "../history/HistoryBackground.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { MaterialSelection } from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativePlayTimelineStore,
  PersistedPlayCallChainContext,
} from "../play/FileNativePlayTimelineStore.ts";
import {
  authorityV3Directory,
  continuityHeadFile,
  LegacyAuthorityV3Reader,
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
  readonly #timeline: FileNativePlayTimelineStore;

  constructor(dataRoot: string, timeline: FileNativePlayTimelineStore) {
    const root = resolve(dataRoot);
    this.#worldsRoot = join(root, "worlds-file-native");
    this.#timeline = timeline;
  }

  async migrate(
    worldId: string,
  ): Promise<FileNativeWorldStorageMigrationResult> {
    assertIdentity(worldId, "World ID");
    const worldRoot = join(this.#worldsRoot, worldId);
    const runtimeRoot = join(worldRoot, "runtime");
    const ledger = new WorldLedgerAuthority(worldRoot);
    if (await ledger.exists()) {
      const head = await ledger.readHead();
      return {
        outcome: "already_current",
        authorityCommits: head.sequence,
        callChainContexts: 0,
      };
    }
    const currentAuthority = new LegacyAuthorityV3Reader(worldRoot);
    if (await currentAuthority.exists()) {
      const { commits } = await convertAuthorityV3ToLedger(worldRoot);
      return {
        outcome: "migrated",
        authorityCommits: commits,
        callChainContexts: 0,
      };
    }
    const current = await readOptionalJson<unknown>(
      join(runtimeRoot, currentAuthorityHeadFile),
    );
    if (current !== null) {
      assertCurrentAuthorityHead(current);
      const commits = await readCurrentAuthority(worldRoot, current);
      if ((commits.at(-1)?.operationId ?? null) !== current.operationId)
        throw new Error(
          "Current Authority head operation does not match its immutable tip",
        );
      const contexts = await this.#timeline.readAllContexts(worldId);
      assertCurrentTimelineAuthorityRefs(contexts, commits);
      const checkpoint = await migrateMaterializedCheckpoint(
        runtimeRoot,
        commits,
      );
      return this.#migrateCurrentAuthority({
        worldId,
        worldRoot,
        commits,
        checkpoint,
        callChainContexts: contexts.length,
      });
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
    const migratedContexts = await this.#timeline.readAllContexts(worldId);
    if (migratedContexts.length !== callChainContexts)
      throw new Error(
        "Released play timeline migration changed its context closure",
      );
    assertCurrentTimelineAuthorityRefs(migratedContexts, currentCommits);

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

    await verifyCurrentFacts(runtimeRoot, currentCommits, checkpoint);
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
    return this.#migrateCurrentAuthority({
      worldId,
      worldRoot,
      commits: currentCommits,
      checkpoint,
      callChainContexts,
    });
  }

  async #migrateCurrentAuthority(input: {
    worldId: string;
    worldRoot: string;
    commits: readonly CurrentPlayCommit[];
    checkpoint: CurrentMaterializedCheckpoint;
    callChainContexts: number;
  }): Promise<FileNativeWorldStorageMigrationResult> {
    return migrateCurrentAuthorityToLedger({ ...input });
  }
}

async function migrateCurrentAuthorityToLedger(input: {
  worldId: string;
  worldRoot: string;
  commits: readonly CurrentPlayCommit[];
  checkpoint: CurrentMaterializedCheckpoint;
  callChainContexts: number;
}): Promise<FileNativeWorldStorageMigrationResult> {
  const runtimeRoot = join(input.worldRoot, "runtime");
  const genesis = await readCurrentGenesis(input.worldRoot, input.worldId);
  const normalized = normalizeAuthorityIdentity(genesis.history, input.commits);
  const genesisMaterials = normalizeMaterials(
    genesis.additionalMaterials,
    normalized.messageIds,
    input.worldId,
  );
  const expectedByHead = new Map<string, MigratedEndpointExpectation>([
    [
      "genesis",
      {
        state: structuredClone(genesis.state),
        history: structuredClone(normalized.genesisHistory),
        additionalMaterials: structuredClone(genesisMaterials),
      },
    ],
  ]);
  const endpoints = new Map<number, LedgerEndpointInput>([
    [
      0,
      { head: "genesis", ...structuredClone(expectedByHead.get("genesis")!) },
    ],
  ]);
  const steps: LedgerStepInput[] = [];
  for (const [index, source] of input.commits.entries()) {
    const sequence = index + 1;
    if (headPositionOf(source.head) !== sequence)
      throw new Error("Released Authority commits are not sequential");
    const historyAppend = source.historyAppend.map((message) =>
      normalizeHistoryMessage(message, normalized.messageIds),
    );
    const nextMaterials = normalizeMaterials(
      source.nextAdditionalMaterials,
      normalized.messageIds,
      input.worldId,
    );
    const basisHead =
      source.timelineRevision?.restoresHead ?? source.parentHead;
    const basis = expectedByHead.get(basisHead);
    if (basis === undefined)
      throw new Error(
        "Released Authority transition references an unknown result basis",
      );
    if (source.timelineRevision !== undefined) {
      const expectedHistory = source.timelineRevision.replacementHistory.map(
        (message) => normalizeHistoryMessage(message, normalized.messageIds),
      );
      if (
        !isDeepStrictEqual(
          canonicalState(basis.state),
          canonicalLegacyState(source.timelineRevision.replacementState),
        ) ||
        !isDeepStrictEqual(basis.history, expectedHistory) ||
        !isDeepStrictEqual(basis.additionalMaterials, nextMaterials)
      )
        throw new Error(
          "Released timeline revision does not exactly restore its logical parent",
        );
    }
    const expected = applyReleasedTransition(
      basis,
      source,
      historyAppend,
      nextMaterials,
    );
    expectedByHead.set(source.head, expected);
    endpoints.set(sequence, { head: source.head, ...expected });
    const basisSequence = headPositionOf(basisHead);
    steps.push({
      sequence,
      basisSequence,
      ...(source.timelineRevision === undefined
        ? {}
        : { restoresSequence: basisSequence }),
      mode: source.mode === "correction" ? "correction" : "play",
      payload: {
        sequence,
        head: source.head,
        operationId:
          sequence === input.commits.length
            ? (source.operationId ?? null)
            : null,
        parentHead: basisHead,
        mode: source.mode === "correction" ? "correction" : "play",
        historyAppend,
        stateChanges: source.stateChanges.map((change) => {
          const { canonicalNextBytes, ...stored } = change;
          void canonicalNextBytes;
          return structuredClone(stored);
        }),
        nextAdditionalMaterials: structuredClone([...nextMaterials]),
        ...(source.correctionTargets === undefined
          ? {}
          : { correctionTargets: [...source.correctionTargets] }),
        ...(source.corrects === undefined ? {} : { corrects: source.corrects }),
      },
    });
  }
  const checkpointHead = input.checkpoint.head;
  if (
    (input.checkpoint.sequence === 0 && checkpointHead !== "genesis") ||
    (input.checkpoint.sequence > 0 &&
      input.commits[input.checkpoint.sequence - 1]?.head !== checkpointHead)
  )
    throw new Error(
      "Released materialized checkpoint is not in migrated Authority",
    );
  await publishJson(join(runtimeRoot, "play-genesis-timeline.json"), {
    schemaVersion: 1,
    worldId: input.worldId,
    history: normalized.genesisHistory,
  });
  await writeTurnLedger(input.worldRoot, {
    endpoints,
    steps,
    headSequence: input.commits.length,
  });
  return {
    outcome: "migrated",
    authorityCommits: input.commits.length,
    callChainContexts: input.callChainContexts,
  };
}

interface MigratedEndpointExpectation {
  state: { path: string; contents: string }[];
  history: ReleasedHistoryMessage[];
  additionalMaterials: MaterialSelection[];
}

function applyReleasedTransition(
  basis: MigratedEndpointExpectation,
  source: CurrentPlayCommit,
  historyAppend: readonly ReleasedHistoryMessage[],
  nextMaterials: readonly MaterialSelection[],
): MigratedEndpointExpectation {
  const state = new Map(
    basis.state.map(({ path, contents }) => [path, contents]),
  );
  for (const change of source.stateChanges) {
    const previous = state.get(change.relativePath);
    if (
      (previous === undefined ? null : `sha256:${sha256Hex(previous)}`) !==
        change.expectedPreviousHash ||
      `sha256:${sha256Hex(change.canonicalNextBytes)}` !== change.nextHash
    )
      throw new Error(
        `Released state transition hash conflicts: ${change.relativePath}`,
      );
    state.set(change.relativePath, change.canonicalNextBytes);
  }
  return {
    state: [...state].map(([path, contents]) => ({ path, contents })),
    history: [
      ...structuredClone(basis.history),
      ...structuredClone(historyAppend),
    ],
    additionalMaterials: structuredClone([...nextMaterials]),
  };
}

function assertCurrentTimelineAuthorityRefs(
  contexts: readonly PersistedPlayCallChainContext[],
  commits: readonly CurrentPlayCommit[],
): void {
  // Released clone-and-remap forks retained their inherited page/model trace
  // prefix while absorbing the selected source history into the target
  // genesis. Older contexts can therefore carry source-world commit aliases
  // that never belonged to the target Authority. They are immutable display
  // history; only the current context is a continuation boundary owned by the
  // target world and must resolve against its Authority.
  const context = contexts.at(-1);
  if (context === undefined) return;
  const heads = new Set(["genesis", ...commits.map(({ head }) => head)]);
  if (!heads.has(context.baselineHead) || !heads.has(context.parentHead))
    throw new Error(
      "Released play timeline references an unknown Authority endpoint",
    );
  for (const event of context.events) {
    if (
      "committedHead" in event &&
      event.committedHead !== undefined &&
      !heads.has(event.committedHead)
    )
      throw new Error(
        "Released play event references an unknown Authority endpoint",
      );
  }
}

async function readCurrentAuthority(
  worldRoot: string,
  head: CurrentAuthorityHead,
): Promise<CurrentPlayCommit[]> {
  const reverse: CurrentPlayCommit[] = [];
  let digest = head.commitDigest;
  let expectedHead = head.head;
  let expectedSequence = head.sequence;
  while (digest !== null) {
    const value = await readJson<unknown>(
      join(worldRoot, "runtime", "play-commits", `${digest}.json`),
    );
    assertCurrentPlayCommit(value);
    if (
      currentCommitDigest(value) !== digest ||
      value.head !== expectedHead ||
      value.sequence !== expectedSequence
    )
      throw new Error("Current Authority endpoint does not match its commit");
    reverse.push(value);
    digest = value.parentCommitDigest;
    expectedHead = value.parentHead;
    expectedSequence -= 1;
  }
  if (expectedHead !== "genesis" || expectedSequence !== 0)
    throw new Error("Current Authority chain does not terminate at genesis");
  return reverse.reverse();
}

async function readCurrentGenesis(
  worldRoot: string,
  worldId: string,
): Promise<{
  operationId: string | null;
  state: { path: string; contents: string }[];
  history: ReleasedHistoryMessage[];
  additionalMaterials: MaterialSelection[];
}> {
  const value = await readJson<unknown>(
    join(worldRoot, "runtime", "genesis.json"),
  );
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.type !== "file_native_genesis" ||
    value.worldId !== worldId ||
    (typeof value.operationId !== "string" && value.operationId !== null) ||
    !Array.isArray(value.state) ||
    !Array.isArray(value.history) ||
    !value.history.every(isReleasedHistoryMessage) ||
    !Array.isArray(value.additionalMaterials) ||
    !value.additionalMaterials.every(isMaterialSelection)
  )
    throw new Error("Current world genesis has an invalid shape");
  const state = value.state.map((file) => {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !validRelativePath(file.path) ||
      typeof file.sha256 !== "string" ||
      typeof file.canonicalBytes !== "string" ||
      `sha256:${sha256Hex(file.canonicalBytes)}` !== file.sha256
    )
      throw new Error("Current world genesis state is corrupt");
    return { path: file.path, contents: file.canonicalBytes };
  });
  return {
    operationId: value.operationId,
    state,
    history: structuredClone(value.history),
    additionalMaterials: structuredClone(value.additionalMaterials),
  };
}

function normalizeAuthorityIdentity(
  genesis: readonly ReleasedHistoryMessage[],
  commits: readonly CurrentPlayCommit[],
): {
  genesisHistory: ReleasedHistoryMessage[];
  messageIds: ReadonlyMap<string, string>;
} {
  const messageIds = new Map<string, string>();
  const bind = (source: string, target: string) => {
    if (messageIds.has(source) && messageIds.get(source) !== target)
      throw new Error("Released Authority reuses one message identity");
    messageIds.set(source, target);
    messageIds.set(target, target);
  };
  for (const [index, message] of genesis.entries())
    bind(
      message.messageId,
      index === 0 && message.role === "narrator"
        ? "message.genesis.narrator"
        : `message.genesis.${index + 1}.${message.role}`,
    );
  for (const commit of commits)
    for (const [index, message] of commit.historyAppend.entries())
      bind(
        message.messageId,
        `message.${commit.sequence}.${index + 1}.${message.role}`,
      );
  return {
    genesisHistory: genesis.map((message) =>
      normalizeHistoryMessage(message, messageIds),
    ),
    messageIds,
  };
}

function normalizeHistoryMessage(
  message: ReleasedHistoryMessage,
  messageIds: ReadonlyMap<string, string>,
): ReleasedHistoryMessage {
  const messageId = messageIds.get(message.messageId);
  if (messageId === undefined)
    throw new Error(
      `Released Authority references an unknown history message: ${message.messageId}`,
    );
  return { ...structuredClone(message), messageId };
}

function normalizeMaterials(
  materials: readonly MaterialSelection[],
  messageIds: ReadonlyMap<string, string>,
  worldId: string,
): MaterialSelection[] {
  return materials.map((material) => {
    if (material.kind === "history_message") {
      const message = messageIds.get(material.message);
      if (message === undefined)
        throw new Error(
          `Released material references an unknown history message: ${material.message}`,
        );
      return { ...material, message };
    }
    if (material.kind === "history_commit") {
      const prefix = `${worldId}.`;
      const commit = material.commit.startsWith(prefix)
        ? material.commit.slice(prefix.length)
        : material.commit;
      if (!/^(?:genesis|commit:[1-9][0-9]*)$/u.test(commit))
        throw new Error(
          `Released material references a foreign Authority endpoint: ${material.commit}`,
        );
      return {
        ...material,
        commit,
      };
    }
    return structuredClone(material);
  });
}

function canonicalState(
  files: readonly { path: string; contents: string }[],
): { path: string; sha256: string; canonicalBytes: string }[] {
  return files
    .map(({ path, contents }) => ({
      path,
      sha256: `sha256:${sha256Hex(contents)}`,
      canonicalBytes: contents,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalLegacyState(
  files: readonly {
    path: string;
    sha256: string;
    canonicalBytes: string;
  }[],
): { path: string; sha256: string; canonicalBytes: string }[] {
  return [...structuredClone(files)].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
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
  if (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "head",
      "sequence",
      "commitDigest",
    ]) &&
    value.schemaVersion === 3 &&
    typeof value.head === "string" &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    (value.commitDigest === null ||
      (typeof value.commitDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(value.commitDigest)))
  ) {
    const sequence = Number(value.sequence);
    const expected = sequence === 0 ? undefined : commits[sequence - 1];
    if (
      (sequence === 0 &&
        (value.head !== "genesis" || value.commitDigest !== null)) ||
      (sequence > 0 && expected?.head !== value.head)
    )
      throw new Error(
        "Unmarked V3 materialized checkpoint is not in released Authority",
      );
    return {
      schemaVersion: 2,
      head: value.head,
      sequence,
      commitDigest:
        expected === undefined ? null : currentCommitDigest(expected),
    };
  }
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

function isMaterialSelection(value: unknown): value is MaterialSelection {
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

function assertCurrentPlayCommit(
  value: unknown,
): asserts value is CurrentPlayCommit {
  if (!isRecord(value))
    throw new Error("Current play commit has an invalid shape");
  const correction = value.mode === "correction";
  const timelineRevision = value.mode === "timeline_revision";
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "sequence",
      "operationId",
      "parentHead",
      "parentCommitDigest",
      "head",
      "mode",
      "historyAppend",
      "stateChanges",
      "nextAdditionalMaterials",
      ...(correction ? ["correctionTargets", "corrects"] : []),
      ...(timelineRevision ? ["timelineRevision"] : []),
    ]) ||
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.trim() === "" ||
    typeof value.parentHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.parentHead) ||
    (value.parentCommitDigest !== null &&
      (typeof value.parentCommitDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.parentCommitDigest))) ||
    typeof value.head !== "string" ||
    value.head !== `commit:${String(value.sequence)}` ||
    (value.mode !== "play" &&
      value.mode !== "correction" &&
      value.mode !== "timeline_revision") ||
    !Array.isArray(value.historyAppend) ||
    !value.historyAppend.every(isReleasedHistoryMessage) ||
    !Array.isArray(value.stateChanges) ||
    !value.stateChanges.every(isReleasedStateChange) ||
    !Array.isArray(value.nextAdditionalMaterials) ||
    !value.nextAdditionalMaterials.every(isMaterialSelection)
  )
    throw new Error("Current play commit has an invalid shape");
  if (
    correction &&
    (!Array.isArray(value.correctionTargets) ||
      !value.correctionTargets.every(
        (target) => typeof target === "string" && target.trim() !== "",
      ) ||
      typeof value.corrects !== "string" ||
      value.corrects !== value.parentHead)
  )
    throw new Error("Current correction commit has an invalid shape");
  if (
    timelineRevision &&
    (value.stateChanges.length !== 0 ||
      !isReleasedTimelineRevision(value.timelineRevision))
  )
    throw new Error("Current timeline revision has an invalid shape");
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
  await rename(temporary, path);
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
    try {
      await link(temporary, path);
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
  join("runtime", "materialized-head.json"),
  join("runtime", "play-commits"),
  join("runtime", ".authority-v3-migration"),
  join("runtime", "play-authority-head.json"),
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
