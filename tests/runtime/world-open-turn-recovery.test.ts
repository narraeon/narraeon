import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import type * as LedgerModule from "../../src/runtime/world/WorldTurnLedger.ts";
import {
  applyChanges,
  beginTurn,
  forgetLedger,
  recoverIncomplete,
  type WorldTurnFileChange,
} from "../../src/runtime/world/WorldTurnLedger.ts";

// 只观察首次打开时的恢复调用次数；恢复本身仍是真实实现。
vi.mock(
  "../../src/runtime/world/WorldTurnLedger.ts",
  async (importOriginal) => {
    const actual = await importOriginal<typeof LedgerModule>();
    return { ...actual, recoverIncomplete: vi.fn(actual.recoverIncomplete) };
  },
);

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(recoverIncomplete).mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// 崩溃现场：第 N+1 轮记录已写入、文件已替换，端点没有发布，进程随即退出。
test("崩溃留下的未完成轮在第一次读取时回滚：端点与当前文件回到原始内容，记录被删除", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const worldRoot = worldRootOf(fixture);
  const committed = await new FileNativeWorldStore(
    fixture.root,
  ).recoverEndpoint(fixture.worldId);
  const contentsBefore = await contentsOf(worldRoot);

  await crashMidTurn(worldRoot, crashedChanges());

  const reopened = new FileNativeWorldStore(fixture.root);
  await expect(reopened.recoverEndpoint(fixture.worldId)).resolves.toEqual(
    committed,
  );
  expect(await contentsOf(worldRoot)).toEqual(contentsBefore);
  expect(await readHeadSequence(worldRoot)).toBe(1);
});

test("崩溃现场打开之后再提交一轮并回退到 commit:1，文件回到原始内容", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const worldRoot = worldRootOf(fixture);
  const committed = await new FileNativeWorldStore(
    fixture.root,
  ).recoverEndpoint(fixture.worldId);

  await crashMidTurn(worldRoot, crashedChanges());

  const reopened = new FileNativeWorldStore(fixture.root);
  const after = initialSituation().replace("情况: 安静", "情况: 续写");
  await reopened.commitPlayStep({
    operationId: "after-crash",
    worldId: fixture.worldId,
    parentHead: "commit:1",
    historyAppend: [{ role: "player", exactText: "崩溃后的第二句。" }],
    nextMaterials: [],
    stateChanges: [change(initialSituation(), after)],
  });
  await reopened.rewindPlayerRevision(fixture.worldId, "commit:1");

  expect(
    await readFile(join(worldRoot, "state/current-situation.yaml"), "utf8"),
  ).toBe(initialSituation());
  await expect(reopened.recoverEndpoint(fixture.worldId)).resolves.toEqual(
    committed,
  );
});

test("回退丢弃的轮记录在清理失败留下残留后，下一次打开时被删除", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  await commitPlay(fixture, "commit:1", "第二句。");
  const worldRoot = worldRootOf(fixture);
  const discardedRecord = await readFile(
    join(worldRoot, "runtime/turns/00000002.json"),
    "utf8",
  );

  await new FileNativeWorldStore(fixture.root).rewindPlayerRevision(
    fixture.worldId,
    "commit:1",
  );
  // 端点已经发布；把被丢弃的第 2 轮记录放回去，模拟清理在发布之后失败。
  await writeFile(
    join(worldRoot, "runtime/turns/00000002.json"),
    discardedRecord,
  );

  const reopened = new FileNativeWorldStore(fixture.root);
  await expect(
    reopened.recoverEndpoint(fixture.worldId),
  ).resolves.toMatchObject({ head: "commit:1" });
  expect((await readdir(join(worldRoot, "runtime/turns"))).sort()).toEqual([
    "00000001.json",
    "00000003.json",
  ]);
});

test("干净世界首次打开不写任何文件", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const worldRoot = worldRootOf(fixture);
  const stampsBefore = await stampsOf(worldRoot);

  const reopened = new FileNativeWorldStore(fixture.root);
  await reopened.recoverEndpoint(fixture.worldId);

  expect(await stampsOf(worldRoot)).toEqual(stampsBefore);
});

test("同一世界并发的首次打开只恢复一次，且都读到回滚后的端点", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const worldRoot = worldRootOf(fixture);
  const committed = await new FileNativeWorldStore(
    fixture.root,
  ).recoverEndpoint(fixture.worldId);

  await crashMidTurn(worldRoot, crashedChanges());
  vi.mocked(recoverIncomplete).mockClear();

  const reopened = new FileNativeWorldStore(fixture.root);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reopened.recoverEndpoint(fixture.worldId)),
  );

  for (const result of results) expect(result).toEqual(committed);
  expect(
    vi
      .mocked(recoverIncomplete)
      .mock.calls.filter(([root]) => root === worldRoot),
  ).toHaveLength(1);
});

let playSteps = 0;

async function commitPlay(
  fixture: Awaited<ReturnType<typeof world>>,
  parentHead: string,
  exactText: string,
): Promise<void> {
  playSteps += 1;
  await fixture.store.commitPlayStep({
    operationId: `play-step-${playSteps}`,
    worldId: fixture.worldId,
    parentHead,
    historyAppend: [{ role: "player", exactText }],
    nextMaterials: [],
    stateChanges: [],
  });
}

function crashedChanges(): WorldTurnFileChange[] {
  return [
    { path: "state/current-situation.yaml", content: "情况: 半写入\n" },
    { path: "history/0002-01-player-unfinished.md", content: "半写入\n" },
  ];
}

async function crashMidTurn(
  worldRoot: string,
  changes: readonly WorldTurnFileChange[],
): Promise<void> {
  // 写入第 N+1 轮记录并替换全部文件，然后在发布端点之前退出。
  await beginTurn(worldRoot, { mode: "play", changes });
  await applyChanges(worldRoot, changes);
  forgetLedger(worldRoot);
}

async function readHeadSequence(worldRoot: string): Promise<number> {
  const head = JSON.parse(
    await readFile(join(worldRoot, "runtime/head.json"), "utf8"),
  ) as { sequence: number };
  return head.sequence;
}

async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(dir, relative), {
      withFileTypes: true,
    })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else found.push(child);
    }
  };
  await visit("");
  return found.sort();
}

async function contentsOf(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await listFiles(dir))
    result[path] = await readFile(join(dir, path), "utf8");
  return result;
}

async function stampsOf(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await listFiles(dir)) {
    const info = await stat(join(dir, path));
    result[path] = `${info.ino}:${info.mtimeMs}`;
  }
  return result;
}

function worldRootOf(fixture: Awaited<ReturnType<typeof world>>): string {
  return join(fixture.root, "worlds-file-native", fixture.worldId);
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-open-recovery-"));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: "create",
    sourcePackageId: "package",
    sourcePackageTitle: "Test content package",
    packageFiles: [
      {
        path: "opening.md",
        contents:
          "The room falls quiet, leaving the present situation for your response.\n",
      },
      { path: "world/current-situation.yaml", contents: initialSituation() },
      {
        path: "control/frame.yaml",
        contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
      },
      { path: "control/blocks/world.md", contents: "# World Rules\n" },
      {
        path: "control/player-views.yaml",
        contents: "format: narraeon.player-views/v1\nviews: []\n",
      },
    ],
    prompt: {
      hostBinding: {
        hostPresetId: "host",
        files: {
          "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
          "blocks/style.md": "# Style\n",
        },
      },
      modelBinding: {
        provider: "chat_completions",
        modelId: "test",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    },
  });
  return { root, store, worldId: created.world.worldId };
}

function initialSituation() {
  return `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`;
}

function change(before: string, after: string) {
  return {
    kind: "replace" as const,
    documentId: "situation.current",
    stableShortRef: "current-situation",
    relativePath: "current-situation.yaml",
    codec: "yaml" as const,
    expectedPreviousHash: hash(before),
    nextHash: hash(after),
    canonicalNextBytes: after,
  };
}

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
