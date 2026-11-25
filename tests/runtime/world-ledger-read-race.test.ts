import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { MaterialSelection } from "../../src/runtime/prompt/MaterialSelection.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { WorldLedgerAuthority } from "../../src/runtime/world/WorldLedgerAuthority.ts";
import {
  appendTurn,
  beginTurn,
  forgetLedger,
  initializeLedger,
  listTurns,
  recoverIncomplete,
  rewindTo,
} from "../../src/runtime/world/WorldTurnLedger.ts";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";

// 注入点：在账本读取目录（读取视图的第二步）之前，由另一次回退发布新的端点。
// 这正是 readHead 的物理端点读取与视图解析之间的窗口（#94）。
const race = vi.hoisted(() => ({
  armed: false,
  inject: (): Promise<void> => Promise.resolve(),
  beforeRename: undefined as ((destination: string) => void) | undefined,
  afterRename: undefined as
    ((destination: string) => Promise<void>) | undefined,
  beforeRead: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (race.armed && String(args[0]).endsWith(join("runtime", "turns"))) {
        race.armed = false;
        await race.inject();
      }
      return actual.readdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      race.beforeRename?.(String(args[1]));
      await actual.rename(...args);
      await race.afterRename?.(String(args[1]));
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (typeof args[0] === "string") await race.beforeRead?.(args[0]);
      return actual.readFile(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  race.armed = false;
  race.beforeRename = undefined;
  race.afterRename = undefined;
  race.beforeRead = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("先替换一个状态文件时，正常读取仍返回旧端点的完整状态，发布后读取新端点", async () => {
  const fixture = await worldArchiveFixture({
    extraPackageFiles: [
      {
        path: "world/front-desk.yaml",
        contents:
          "$document:\n  id: location.desk\n  ref: front-desk\n  title: 前台\n  summary: 旅店前台。\n  aliases: []\n情况: 灯已熄灭。\n",
      },
      { path: "control/assets/player-note.tmp", contents: "保留这个资源。\n" },
    ],
  });
  const { root, worldId, worlds } = fixture;
  roots.push(root);
  const worldRoot = join(root, "worlds-file-native", worldId);
  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const request = {
    type: "world.surface.read",
    worldId,
    surface: "state",
  } as const;
  const before = await worlds.recoverEndpoint(worldId);
  expect((await runtime.handle(request)).result).toEqual(before.state);
  const revisionRequest = { ...request, surface: "revision" } as const;
  const revisionBefore = (await runtime.handle(revisionRequest)).result;
  expect(revisionBefore).toContainEqual({
    path: "control/assets/player-note.tmp",
    contents: "保留这个资源。\n",
  });

  const changes = before.state.map(({ path, contents }) => {
    const next = `${contents}时间: 深夜\n`;
    const desk = path === "front-desk.yaml";
    return {
      kind: "replace" as const,
      documentId: desk ? "location.desk" : "situation.current",
      stableShortRef: desk ? "front-desk" : "current-situation",
      relativePath: path,
      codec: "yaml" as const,
      expectedPreviousHash: hash(contents),
      nextHash: hash(next),
      canonicalNextBytes: next,
    };
  });
  expect(changes).toHaveLength(2);
  const first = join(worldRoot, "state", changes[0]!.relativePath);
  const second = join(worldRoot, "state", changes[1]!.relativePath);
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readPaused = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  race.beforeRead = async (path) => {
    if (path !== first) return;
    race.beforeRead = undefined;
    readPaused.resolve();
    await resumeRead.promise;
  };
  const overlappingRead = runtime.handle(request);
  await Promise.race([readPaused.promise, overlappingRead]);
  // Evict the paused reader's view while it is still coordinating with writes.
  for (let index = 0; index < 8; index += 1) {
    const other = join(root, `other-ledger-${index}`);
    await initializeLedger(other);
    await listTurns(other);
  }
  race.afterRename = async (destination) => {
    if (destination !== first) return;
    race.afterRename = undefined;
    paused.resolve();
    await resume.promise;
  };
  const advance = worlds.commitPlayStep({
    historyAppend: [],
    worldId,
    operationId: "replace-both-state-files",
    parentHead: before.head,
    stateChanges: changes,
    nextMaterials: [],
  });
  try {
    await Promise.race([paused.promise, advance]);
    expect(await readFile(first, "utf8")).toContain("时间: 深夜");
    expect(await readFile(second, "utf8")).toBe(before.state[1]!.contents);
    resumeRead.resolve();
    expect((await overlappingRead).result).toEqual(before.state);
    expect((await runtime.handle(request)).result).toEqual(before.state);
    expect((await runtime.handle(revisionRequest)).result).toEqual(
      revisionBefore,
    );
    expect(await worlds.recoverEndpoint(worldId)).toEqual(before);
  } finally {
    resumeRead.resolve();
    resume.resolve();
    await advance;
  }

  const committed = await advance;
  const expectedState = changes.map(({ relativePath, canonicalNextBytes }) => ({
    path: relativePath,
    contents: canonicalNextBytes,
  }));
  expect((await runtime.handle(request)).result).toEqual(expectedState);
  expect(
    (await runtime.handle({ ...request, head: before.head })).result,
  ).toEqual(before.state);
  const reopened = new FileNativeWorldStore(root);
  expect(await reopened.recoverEndpoint(worldId)).toMatchObject({
    head: committed.head,
    state: expectedState,
  });
  expect(await reopened.recoverEndpoint(worldId, before.head)).toEqual(before);
});

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("纯正文已写入历史文件但端点未发布时，读取仍使用已提交的快照", async () => {
  const { root, worldId, worlds } = await worldArchiveFixture();
  roots.push(root);
  const historyRoot = join(root, "worlds-file-native", worldId, "history");
  const before = await worlds.recoverEndpoint(worldId);
  const beforeQuery = await worlds.openHistoryQuery(worldId);
  const beforeSummary = await worlds.readWorldSummary(worldId);
  const exactText = "船靠岸了。\n码头亮着灯。\n";
  const operationId = "append-history-only";
  const staged = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  race.afterRename = async (destination) => {
    if (dirname(destination) !== historyRoot) return;
    race.afterRename = undefined;
    staged.resolve();
    await resume.promise;
  };
  const advance = worlds.commitPlayStep({
    worldId,
    operationId,
    parentHead: before.head,
    historyAppend: [{ role: "narrator", exactText }],
    stateChanges: [],
    nextMaterials: before.additionalMaterials,
  });
  try {
    await Promise.race([staged.promise, advance]);
    expect(race.afterRename).toBeUndefined();
    expect(await worlds.recoverEndpoint(worldId)).toEqual(before);
    expect((await worlds.openHistoryQuery(worldId)).snapshotId).toBe(
      beforeQuery.snapshotId,
    );
    expect(await worlds.readWorldSummary(worldId)).toEqual(beforeSummary);
    expect(await worlds.getOperationOutcome(operationId)).toMatchObject({
      outcome: "not_started",
    });
  } finally {
    resume.resolve();
    await advance;
  }

  const receipt = await advance;
  expect(await worlds.getOperationOutcome(operationId)).toEqual(receipt);
  expect(await worlds.currentEndpoint(worldId)).toEqual({
    head: receipt.head,
    operationId,
  });
  const afterQuery = await worlds.openHistoryQuery(worldId);
  expect(afterQuery.snapshotId).not.toBe(beforeQuery.snapshotId);
  expect(afterQuery.messages.at(-1)).toMatchObject({ text: exactText });
  expect(await worlds.readWorldSummary(worldId)).toMatchObject({
    excerpt: "船靠岸了。 码头亮着灯。",
    playerTurns: beforeSummary.playerTurns,
  });
});

test("readHead 在端点读取与视图解析之间被回退时，返回一致的当前端点", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ledger-read-race-"));
  roots.push(root);
  await initializeLedger(root);
  for (const sequence of [1, 2]) {
    await appendTurn(root, {
      mode: "play",
      changes: [],
      payload: commitPayload(sequence),
    });
  }
  forgetLedger(root);

  race.inject = () => rewindTo(root, 1).then(() => undefined);
  race.armed = true;
  const head = await new WorldLedgerAuthority(root).readHead();

  expect(race.armed).toBe(false);
  // 回退发布了 commit:1 的新端点；读取只能得到它，或回退之前的正确解析，不能抛错。
  expect(head).toMatchObject({
    head: "commit:1",
    sequence: 1,
    operationId: "op-1",
  });
});

test("冷读期间回退清理已经列出的轮记录，会重读端点和轮账本", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ledger-read-race-"));
  roots.push(root);
  await initializeLedger(root);
  const first = await appendTurn(root, { mode: "play", changes: [] });
  await appendTurn(root, { mode: "play", changes: [] });
  forgetLedger(root);

  const discarded = join(root, "runtime/turns/00000002.json");
  race.beforeRead = async (path) => {
    if (path !== discarded) return;
    race.beforeRead = undefined;
    await rewindTo(root, 1);
    await expect(readFile(discarded)).rejects.toMatchObject({ code: "ENOENT" });
    forgetLedger(root);
  };

  expect(await listTurns(root)).toEqual([
    first,
    expect.objectContaining({
      sequence: 3,
      mode: "rewind",
      restoresSequence: 1,
    }),
  ]);
  expect(race.beforeRead).toBeUndefined();
});

test("首次恢复分批读取轮账本，损坏记录修复后可以重读", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ledger-batch-"));
  roots.push(root);
  await initializeLedger(root);
  const turns = [];
  for (let sequence = 1; sequence <= 17; sequence += 1) {
    turns.push(await appendTurn(root, { mode: "play", changes: [] }));
  }
  forgetLedger(root);

  const directory = join(root, "runtime/turns");
  const damaged = join(directory, "00000017.json");
  const original = await readFile(damaged, "utf8");
  await writeFile(damaged, "{");
  await writeFile(join(directory, "ignored.tmp"), "{");

  let inFlight = 0;
  let peak = 0;
  let reads = 0;
  race.beforeRead = async (path) => {
    if (dirname(path) !== directory) return;
    reads += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
  };
  await expect(recoverIncomplete(root)).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(peak).toBe(8);
  expect(inFlight).toBe(0);

  reads = 0;
  await writeFile(damaged, original);
  expect(await listTurns(root)).toEqual(turns);
  expect(reads).toBe(turns.length);
});

test("an append with an empty view cache loads the parent before writing its journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ledger-cold-append-"));
  roots.push(root);
  await initializeLedger(root);
  await appendTurn(root, { mode: "play", changes: [] });
  forgetLedger(root);

  const directory = join(root, "runtime/turns");
  const reads: string[] = [];
  race.beforeRead = (path) => {
    if (dirname(path) === directory) reads.push(path);
    return Promise.resolve();
  };
  await appendTurn(root, { mode: "play", changes: [] });
  expect(reads).toEqual([
    join(directory, "00000001.json"),
    join(directory, "00000002.json"), // Absence check before the write.
  ]);
  expect((await listTurns(root)).map(({ sequence }) => sequence)).toEqual([
    1, 2,
  ]);
});

test.each(["turns/00000003.json", "head.json"])(
  "can retry a product commit after failing to rename runtime/%s",
  async (file) => {
    const { root, worldId, worlds } = await worldArchiveFixture();
    roots.push(root);
    const worldRoot = join(root, "worlds-file-native", worldId);
    const before = await worlds.recoverEndpoint(worldId);
    expect(before.head).toBe("commit:2");
    const input = {
      worldId,
      operationId: "retry-after-rename-failure",
      parentHead: before.head,
      historyAppend: [{ role: "player" as const, exactText: "Try again." }],
      nextMaterials: [
        { kind: "document" as const, document: "@current-situation" },
      ],
      stateChanges: [],
    };
    const failure = new Error("injected rename failure");
    race.beforeRename = (destination) => {
      if (destination !== join(worldRoot, "runtime", file)) return;
      race.beforeRename = undefined;
      throw failure;
    };
    await expect(worlds.commitPlayStep(input)).rejects.toBe(failure);
    expect(await worlds.recoverEndpoint(worldId)).toEqual(before);
    const journal = join(worldRoot, "runtime", "turns", "00000003.json");
    await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });

    const committed = await worlds.commitPlayStep(input);
    expect(committed.head).toBe("commit:3");
    expect(committed.commitDigest).toBe(
      createHash("sha256")
        .update(await readFile(journal))
        .digest("hex"),
    );
    expect(await worlds.commitPlayStep(input)).toEqual(committed);
    const after = await worlds.recoverEndpoint(worldId);
    expect(after.history.slice(0, -1)).toEqual(before.history);
    expect(after.history.at(-1)?.exactText).toBe("Try again.");
    forgetLedger(worldRoot);
    const restarted = new FileNativeWorldStore(root);
    expect(await restarted.recoverEndpoint(worldId)).toEqual(after);
    expect(await new WorldLedgerAuthority(worldRoot).readHead()).toMatchObject({
      head: committed.head,
      commitDigest: committed.commitDigest,
    });
  },
);

test("commit payloads and product read results are detached from the cached ledger", async () => {
  const { root, worldId, worlds } = await worldArchiveFixture();
  roots.push(root);
  const worldRoot = join(root, "worlds-file-native", worldId);
  const authority = new WorldLedgerAuthority(worldRoot);
  const background = {
    kind: "narrative" as const,
    before: "dock",
    after: "inn",
  };
  const material = {
    kind: "node",
    document: "@current-situation",
    locator: { yaml: ["情况"] },
  } satisfies MaterialSelection;
  const checkpoint = { contextId: "archive-chain", completedPlayerRounds: 1 };
  const input = {
    worldId,
    operationId: "test-ownership",
    parentHead: await worlds.currentHead(worldId),
    historyAppend: [
      { role: "narrator" as const, exactText: "In the inn.", background },
    ],
    nextMaterials: [material],
    stateChanges: [],
    narrativeCheckpoint: checkpoint,
  };
  const originalInput = structuredClone(input);
  const outcome = await worlds.commitPlayStep(input);
  const expectedOutcome = structuredClone(outcome);
  background.after = "mutated input";
  material.locator.yaml[0] = "mutated input";
  checkpoint.completedPlayerRounds = 100;
  outcome.commitDigest = "mutated outcome";
  outcome.nextAdditionalMaterials.length = 0;
  const retry = await worlds.commitPlayStep(originalInput);
  expect(retry).toEqual(expectedOutcome);
  retry.historyAppend[0]!.exactText = "mutated retry";
  expect(await worlds.getOperationOutcome(input.operationId)).toEqual(
    expectedOutcome,
  );

  const recovered = await worlds.recoverEndpoint(worldId);
  const expected = structuredClone(recovered);
  recovered.history[0]!.exactText = "mutated opening";
  const lastBackground = recovered.history.at(-1)?.background;
  if (lastBackground?.kind !== "narrative")
    throw new Error("Missing background");
  lastBackground.after = "mutated history";
  const recoveredMaterial = recovered.additionalMaterials[0];
  if (recoveredMaterial?.kind !== "node")
    throw new Error("Missing node material");
  recoveredMaterial.locator.yaml![0] = "mutated recovery";
  recovered.narrativeCheckpoint!.completedPlayerRounds = 100;

  const { commits } = await authority.readHistory();
  commits.at(-1)!.historyAppend[0]!.exactText = "mutated history commit";
  const commit = await authority.commitAt(expected.head);
  commit!.historyAppend[0]!.exactText = "mutated commit at";
  const { commit: fact } = await authority.authorityFactAt(expected.head);
  fact.nextAdditionalMaterials.length = 0;
  const materials = await authority.recoverMaterials();
  materials[0]!.kind = "document";
  expect(await worlds.recoverEndpoint(worldId)).toEqual(expected);
  expect(await worlds.commitPlayStep(originalInput)).toEqual(expectedOutcome);

  // A fresh instance rolls back an uncommitted journal using its disk before-images.
  const statePath = `state/${expected.state[0]!.path}`;
  const changes = [{ path: statePath, content: "unpublished state" }];
  await beginTurn(worldRoot, { mode: "play", changes });
  await writeFile(join(worldRoot, statePath), changes[0]!.content);
  forgetLedger(worldRoot);
  const restarted = new FileNativeWorldStore(root);
  expect(await restarted.recoverEndpoint(worldId)).toEqual(expected);
  await expect(
    readFile(join(worldRoot, "runtime", "turns", "00000004.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

function commitPayload(sequence: number) {
  return {
    sequence,
    head: `commit:${sequence}`,
    operationId: `op-${sequence}`,
    parentHead: sequence === 1 ? "genesis" : `commit:${sequence - 1}`,
    mode: "play",
    historyAppend: [],
    stateChanges: [],
    nextAdditionalMaterials: [],
  };
}

test("maintenance rebuild reads a fixed number of ledger heads across historical and current endpoints", async () => {
  const { root, worldId, worlds } = await worldArchiveFixture();
  roots.push(root);
  const worldRoot = join(root, "worlds-file-native", worldId);
  const authority = new WorldLedgerAuthority(worldRoot);
  await worlds.rewindPlayerRevision(worldId, "genesis");
  const genesis = (await worlds.readSurface(worldId, "state"))[0]!.contents;
  let head = "genesis";
  let contents = genesis;
  const append = async (round: number) => {
    const next = `${genesis}观察: ${round}\n`;
    const { commit } = await authority.appendCommit({
      operationId: `maintenance-turn-${round}`,
      parentHead: head,
      mode: "play",
      playContext: "maintenance-context",
      worldClock: `时刻 ${round}`,
      historyAppend: [{ role: "player", exactText: "继续观察。" }],
      stateChanges: [replaceSituation(contents, next)],
      nextMaterials: [],
    });
    head = commit.head;
    contents = next;
  };
  for (let round = 1; round <= 3; round++) await append(round);
  const earlier = head;
  for (let round = 4; round <= 30; round++) await append(round);
  const latest = head;
  const paths: string[] = [];
  const current = new FileNativeWorldStore(root);
  const historical = new FileNativeWorldStore(root);
  expect(await current.currentHead(worldId)).toBe(latest);
  expect(await historical.currentHead(worldId)).toBe(latest);
  race.beforeRead = (path) => {
    paths.push(path);
    return Promise.resolve();
  };
  const ledgerHead = join(worldRoot, "runtime", "head.json");
  const stateFile = join(worldRoot, "state", "current-situation.yaml");
  const earlyFacts = await historical.readDocumentMaintenance(worldId, earlier);
  expect(earlyFacts["current-situation"]?.lastBodyWrite).toEqual({
    kind: "play",
    context: 1,
    round: 3,
    worldTime: "时刻 3",
  });
  expect(paths.filter((path) => path === ledgerHead)).toHaveLength(2);
  expect(paths.filter((path) => path === stateFile)).toHaveLength(0);
  paths.length = 0;
  const latestFacts = await current.readDocumentMaintenance(worldId, latest);
  expect(latestFacts["current-situation"]).toMatchObject({
    lastBodyWrite: { context: 1, round: 30, worldTime: "时刻 30" },
    lastMetadataWrite: { kind: "world_origin" },
    observedContexts: 1,
    bodyChangedContexts: 1,
    metadataChangedContexts: 0,
  });
  expect(paths.filter((path) => path === ledgerHead)).toHaveLength(2);
  expect(paths.filter((path) => path === stateFile)).toHaveLength(1);
  paths.length = 0;
  expect(await current.readDocumentMaintenance(worldId, latest)).toEqual(
    latestFacts,
  );
  expect(paths.filter((path) => path === ledgerHead)).toHaveLength(1);
  expect(paths.filter((path) => path === stateFile)).toHaveLength(0);
  race.beforeRead = undefined;

  await append(31);
  paths.length = 0;
  race.beforeRead = (path) => {
    paths.push(path);
    return Promise.resolve();
  };
  const extended = await current.readDocumentMaintenance(worldId);
  expect(extended["current-situation"]?.lastBodyWrite).toMatchObject({
    round: 31,
    worldTime: "时刻 31",
  });
  expect(paths.filter((path) => path === ledgerHead)).toHaveLength(2);
  expect(paths.filter((path) => path === stateFile)).toHaveLength(1);
  race.beforeRead = undefined;
  expect(
    await new FileNativeWorldStore(root).readDocumentMaintenance(worldId),
  ).toEqual(extended);
});

test("maintenance caches follow a rewind and bad state bytes make diagnostics unavailable", async () => {
  const { root, worldId, worlds } = await worldArchiveFixture();
  roots.push(root);
  const worldRoot = join(root, "worlds-file-native", worldId);
  const authority = new WorldLedgerAuthority(worldRoot);
  const parent = await worlds.currentHead(worldId);
  const original = (await worlds.readSurface(worldId, "state"))[0]!.contents;
  const append = async (
    parentHead: string,
    id: string,
    next: string,
    playContext: string,
  ) =>
    (
      await authority.appendCommit({
        operationId: id,
        parentHead,
        mode: "play",
        playContext,
        historyAppend: [{ role: "player", exactText: "看看旅店。" }],
        stateChanges: [replaceSituation(original, next)],
        nextMaterials: [],
      })
    ).commit.head;
  const body = `${original}时间: 半夜\n`;
  const discarded = await append(
    parent,
    "maintenance-body",
    body,
    "discarded-context",
  );
  const { commits } = await authority.readStateHistory(
    discarded,
    (head) => head === parent,
  );
  const projected = commits[0]!;
  projected.playContext = "mutated context";
  projected.historyAppend[0]!.exactText = " ";
  projected.changes[0]!.stableShortRef = "mutated-ref";
  expect(await authority.commitAt(discarded)).toMatchObject({
    playContext: "discarded-context",
    historyAppend: [{ exactText: "看看旅店。" }],
    stateChanges: [{ stableShortRef: "current-situation" }],
  });

  const beforeRewind = await worlds.readDocumentMaintenance(worldId, discarded);
  expect(beforeRewind["current-situation"]).toMatchObject({
    lastBodyWrite: { kind: "play", context: 2, round: 1, worldTime: null },
    bodyChangedContexts: 1,
    observedContexts: 2,
  });

  const parentFacts = await worlds.readDocumentMaintenance(worldId, parent);
  await worlds.rewindPlayerRevision(worldId, parent);
  const physical = await readFile(
    join(worldRoot, "runtime", "head.json"),
    "utf8",
  );
  const { sequence } = JSON.parse(physical) as { sequence: number };
  expect(
    await worlds.readDocumentMaintenance(worldId, `commit:${sequence}`),
  ).toEqual(parentFacts);
  expect(await worlds.readDocumentMaintenance(worldId)).toEqual(parentFacts);
  await expect(
    worlds.readDocumentMaintenance(worldId, discarded),
  ).rejects.toMatchObject({ code: "discarded" });

  const metadata = original.replace(
    "summary: 旅店门边。",
    "summary: 旅店大门。",
  );
  const kept = await append(
    parent,
    "maintenance-metadata",
    metadata,
    "kept-context",
  );
  const afterRewind = await worlds.readDocumentMaintenance(worldId, kept);
  expect(afterRewind["current-situation"]).toEqual({
    ...parentFacts["current-situation"],
    lastMetadataWrite: { kind: "play", context: 2, round: 1, worldTime: null },
    metadataChangedContexts: 1,
    observedContexts: 2,
  });
  const statePath = join(worldRoot, "state", "current-situation.yaml");
  await writeFile(statePath, original);
  const restarted = new FileNativeWorldStore(root);
  expect(await restarted.inspectDocumentMaintenance(worldId, kept)).toEqual({
    documentMaintenance: {},
    documentMaintenanceUnavailableReason:
      "State change content conflicts with its commit: current-situation.yaml",
  });
  expect(await restarted.readDocumentMaintenance(worldId, parent)).toEqual(
    parentFacts,
  );
  await writeFile(statePath, metadata);
  expect(await restarted.readDocumentMaintenance(worldId, kept)).toEqual(
    afterRewind,
  );
});

function replaceSituation(previous: string, next: string) {
  return {
    kind: "replace" as const,
    documentId: "situation.current",
    stableShortRef: "current-situation",
    relativePath: "current-situation.yaml",
    codec: "yaml" as const,
    expectedPreviousHash: hash(previous),
    nextHash: hash(next),
    canonicalNextBytes: next,
  };
}
