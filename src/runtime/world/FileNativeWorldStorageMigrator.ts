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
import type {
  FileNativePlayTimelineStore,
  PersistedPlayCallChainContext,
} from "../play/FileNativePlayTimelineStore.ts";
import {
  authorityV3Directory,
  continuityHeadFile,
  FileNativeAuthorityV3,
  type FileNativeAuthorityCommitV3,
} from "./FileNativeAuthorityV3.ts";

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
    const currentAuthority = new FileNativeAuthorityV3(worldRoot);
    if (await currentAuthority.exists()) {
      const head = await currentAuthority.readHead();
      return {
        outcome: "already_current",
        authorityCommits: head.sequence,
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
      assertTimelineAuthorityRefs(contexts, commits);
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
    crashAtStorageMigrationEdge("after_timeline");
    const migratedContexts = await this.#timeline.readAllContexts(worldId);
    if (migratedContexts.length !== callChainContexts)
      throw new Error(
        "Released play timeline migration changed its context closure",
      );
    assertTimelineAuthorityRefs(migratedContexts, currentCommits);

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
    return migrateCurrentAuthorityToV3({
      ...input,
      operationsRoot: this.#operationsRoot,
    });
  }
}

async function migrateCurrentAuthorityToV3(input: {
  worldId: string;
  worldRoot: string;
  operationsRoot: string;
  commits: readonly CurrentPlayCommit[];
  checkpoint: CurrentMaterializedCheckpoint;
  callChainContexts: number;
}): Promise<FileNativeWorldStorageMigrationResult> {
  const runtimeRoot = join(input.worldRoot, "runtime");
  const genesis = await readCurrentGenesis(input.worldRoot, input.worldId);
  const normalized = normalizeAuthorityIdentity(genesis.history, input.commits);
  const stagingWorld = join(runtimeRoot, ".authority-v3-migration");
  const stagedRuntime = join(stagingWorld, "runtime");
  const targetAuthority = join(runtimeRoot, authorityV3Directory);
  await rm(stagingWorld, { recursive: true, force: true });
  const staged = new FileNativeAuthorityV3(stagingWorld);
  try {
    const genesisMaterials = normalizeMaterials(
      genesis.additionalMaterials,
      normalized.messageIds,
      input.worldId,
    );
    await staged.initialize({
      operationId: genesis.operationId,
      state: genesis.state,
      history: normalized.genesisHistory,
      additionalMaterials: genesisMaterials,
    });
    const expectedEndpoints = new Map<string, MigratedEndpointExpectation>([
      [
        "genesis",
        {
          state: structuredClone(genesis.state),
          history: structuredClone(normalized.genesisHistory),
          additionalMaterials: structuredClone(genesisMaterials),
        },
      ],
    ]);
    const migrated: {
      source: CurrentPlayCommit;
      fact: FileNativeAuthorityCommitV3;
      digest: string;
    }[] = [];
    for (const source of input.commits) {
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
      const basis = expectedEndpoints.get(basisHead);
      if (basis === undefined)
        throw new Error(
          "Released Authority transition references an unknown result basis",
        );
      if (source.timelineRevision !== undefined) {
        const restored = await staged.recover(
          source.timelineRevision.restoresHead,
        );
        const expectedHistory = source.timelineRevision.replacementHistory.map(
          (message) => normalizeHistoryMessage(message, normalized.messageIds),
        );
        if (
          !isDeepStrictEqual(
            canonicalState(restored.state),
            canonicalLegacyState(source.timelineRevision.replacementState),
          ) ||
          !isDeepStrictEqual(restored.history, expectedHistory) ||
          !isDeepStrictEqual(restored.additionalMaterials, nextMaterials)
        )
          throw new Error(
            "Released timeline revision does not exactly restore its logical parent",
          );
      }
      const prepared = await staged.prepareAppend({
        operationId: source.operationId,
        parentHead: source.parentHead,
        ...(source.timelineRevision === undefined
          ? {}
          : { timelineParentHead: source.timelineRevision.restoresHead }),
        mode: source.mode,
        historyAppend: historyAppend.map(({ role, exactText }) => ({
          role,
          exactText,
        })),
        stateChanges: source.stateChanges,
        nextMaterials,
        ...(source.correctionTargets === undefined
          ? {}
          : { correctionTargets: source.correctionTargets }),
        ...(source.corrects === undefined ? {} : { corrects: source.corrects }),
        ...(source.timelineRevision === undefined
          ? {}
          : {
              timelineRevision: {
                restoresHead: source.timelineRevision.restoresHead,
                replacesHead: source.timelineRevision.replacesHead,
                requestFingerprint: source.timelineRevision.requestFingerprint,
              },
            }),
      });
      if (
        !isDeepStrictEqual(prepared.commit.historyAppend, historyAppend) ||
        prepared.commit.head !== source.head
      )
        throw new Error("Migrated Authority fact changed released semantics");
      await staged.publishPrepared(prepared);
      const expected = applyReleasedTransition(
        basis,
        source,
        historyAppend,
        nextMaterials,
      );
      const recovered = await staged.recover(source.head);
      if (
        !isDeepStrictEqual(
          canonicalState(recovered.state),
          canonicalState(expected.state),
        ) ||
        !isDeepStrictEqual(recovered.history, expected.history) ||
        !isDeepStrictEqual(
          recovered.additionalMaterials,
          expected.additionalMaterials,
        )
      )
        throw new Error(
          `Migrated Authority endpoint changed released semantics: ${source.head}`,
        );
      expectedEndpoints.set(source.head, expected);
      migrated.push({
        source,
        fact: prepared.commit,
        digest: prepared.commitDigest,
      });
    }

    const finalHead = await staged.readHead();
    if (
      finalHead.sequence !== input.commits.length ||
      finalHead.head !== (input.commits.at(-1)?.head ?? "genesis")
    )
      throw new Error(
        "Migrated Authority head does not match released history",
      );
    await staged.readHistory();
    const checkpointFact =
      input.checkpoint.sequence === 0
        ? null
        : migrated[input.checkpoint.sequence - 1];
    if (
      (input.checkpoint.sequence === 0 &&
        input.checkpoint.head !== "genesis") ||
      (input.checkpoint.sequence > 0 &&
        checkpointFact?.fact.head !== input.checkpoint.head)
    )
      throw new Error(
        "Released materialized checkpoint is not in migrated Authority",
      );
    const checkpointEndpoint = await staged.recover(input.checkpoint.head);

    await rm(targetAuthority, { recursive: true, force: true });
    await rename(join(stagedRuntime, authorityV3Directory), targetAuthority);
    await syncDirectory(runtimeRoot);
    await publishJson(join(runtimeRoot, "play-genesis-timeline.json"), {
      schemaVersion: 1,
      worldId: input.worldId,
      history: normalized.genesisHistory,
    });
    await publishJson(join(runtimeRoot, "additional-materials.json"), {
      head: input.checkpoint.head,
      items: checkpointEndpoint.additionalMaterials,
    });
    await publishJson(join(runtimeRoot, "materialized-head.json"), {
      schemaVersion: 3,
      head: input.checkpoint.head,
      sequence: input.checkpoint.sequence,
      commitDigest: checkpointFact?.digest ?? null,
    });
    await mkdir(input.operationsRoot, { recursive: true, mode: 0o700 });
    for (const { source, fact, digest } of migrated) {
      await publishJson(
        operationOutcomePath(input.operationsRoot, source.operationId),
        {
          outcome:
            input.checkpoint.sequence >= fact.sequence
              ? "committed"
              : "committed_materialization_pending",
          worldId: input.worldId,
          parentHead: fact.auditParent.head,
          head: fact.head,
          commitDigest: digest,
          historyAppend: fact.historyAppend.map(({ role, exactText }) => ({
            role,
            exactText,
          })),
          nextAdditionalMaterials: fact.nextAdditionalMaterials,
          mode: fact.mode,
        },
      );
    }
    await rm(stagingWorld, { recursive: true, force: true });
    crashAtStorageMigrationEdge("before_authority_v3_head");
    await publishJson(join(runtimeRoot, continuityHeadFile), finalHead);
    crashAtStorageMigrationEdge("after_authority_v3_head");
    return {
      outcome: "migrated",
      authorityCommits: migrated.length,
      callChainContexts: input.callChainContexts,
    };
  } finally {
    await rm(stagingWorld, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
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

function assertTimelineAuthorityRefs(
  contexts: readonly PersistedPlayCallChainContext[],
  commits: readonly CurrentPlayCommit[],
): void {
  const heads = new Set(["genesis", ...commits.map(({ head }) => head)]);
  for (const context of contexts) {
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
