import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { WorldLedgerAuthority } from "../../src/runtime/world/WorldLedgerAuthority.ts";
import {
  appendTurn,
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
  const advance = worlds.commitCorrection({
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
