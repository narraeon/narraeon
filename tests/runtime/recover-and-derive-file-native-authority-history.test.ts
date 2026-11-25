import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  applyChanges,
  beginTurn,
} from "../../src/runtime/world/WorldTurnLedger.ts";
import { revisePlayerTimeline } from "./support/player-timeline-edit.ts";

const roots: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename) };
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("端点由当前文件与轮账本恢复，重新打开后同一端点的内容一致", async () => {
  const fixture = await world();
  const before = initialSituation();
  const after = before.replace("情况: 安静", "情况: 奖杯已经交给Alex");
  await fixture.store.commitPlayStep({
    operationId: "play-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "I hand the trophy to Alex." },
      {
        role: "narrator",
        exactText: "Alex accepts the trophy and thanks me sincerely.",
      },
    ],
    nextMaterials: [],
    stateChanges: [change(before, after)],
  });

  const recovered = await fixture.store.recoverEndpoint(fixture.worldId);
  expect(recovered).toMatchObject({
    head: "commit:1",
    history: [
      {
        role: "narrator",
        exactText:
          "The room falls quiet, leaving the present situation for your response.\n",
      },
      { role: "player", exactText: "I hand the trophy to Alex." },
      {
        role: "narrator",
        exactText: "Alex accepts the trophy and thanks me sincerely.",
      },
    ],
  });
  expect(recovered.state[0]?.contents).toContain("奖杯已经交给Alex");

  const reopened = new FileNativeWorldStore(fixture.root);
  await expect(reopened.recoverEndpoint(fixture.worldId)).resolves.toEqual(
    recovered,
  );
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  expect(
    await readFile(join(worldRoot, "state/current-situation.yaml"), "utf8"),
  ).toBe(after);
  expect(
    await fixture.store.readSurface(fixture.worldId, "history"),
  ).toHaveLength(3);
});

test("每次提交只新增一个轮记录并发布端点头，不再写 V3 事实链", async () => {
  const fixture = await world();
  const first = await fixture.store.commitPlayStep({
    operationId: "small-head-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [{ role: "player", exactText: "First action" }],
    nextMaterials: [],
    stateChanges: [],
  });
  const second = await fixture.store.commitPlayStep({
    operationId: "small-head-2",
    worldId: fixture.worldId,
    parentHead: first.head,
    historyAppend: [{ role: "narrator", exactText: "Second result" }],
    nextMaterials: [],
    stateChanges: [],
  });
  const runtimeRoot = join(
    fixture.root,
    "worlds-file-native",
    fixture.worldId,
    "runtime",
  );

  expect(
    JSON.parse(await readFile(join(runtimeRoot, "head.json"), "utf8")),
  ).toEqual({
    sequence: 2,
  });
  expect((await readdir(join(runtimeRoot, "turns"))).sort()).toEqual([
    "00000001.json",
    "00000002.json",
  ]);
  expect(second.head).toBe("commit:2");
  for (const retired of [
    "authority-v3",
    "continuity-head.json",
    "materialized-head.json",
  ])
    await expect(stat(join(runtimeRoot, retired))).rejects.toMatchObject({
      code: "ENOENT",
    });
});

test("候选前像哈希不一致时拒绝提交，世界文件与端点都不变", async () => {
  const fixture = await world();
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  const stale = initialSituation().replace("情况: 安静", "情况: 旧前像");
  const after = initialSituation().replace("情况: 安静", "情况: 新状态");

  await expect(
    fixture.store.commitPlayStep({
      operationId: "stale-before",
      worldId: fixture.worldId,
      parentHead: "genesis",
      historyAppend: [{ role: "player", exactText: "stale" }],
      nextMaterials: [],
      stateChanges: [change(stale, after)],
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });

  expect(
    await readFile(join(worldRoot, "state/current-situation.yaml"), "utf8"),
  ).toBe(initialSituation());
  expect(await fixture.store.currentHead(fixture.worldId)).toBe("genesis");
});

test("修改状态时，即使前像和新内容哈希匹配，损坏的候选树仍被拒绝", async () => {
  const { store, worldId } = await world();
  const before = await store.recoverEndpoint(worldId);
  await expect(
    store.commitPlayStep({
      worldId,
      operationId: "invalid-candidate",
      parentHead: before.head,
      historyAppend: [{ role: "narrator", exactText: "不会提交。" }],
      nextMaterials: [],
      stateChanges: [change(initialSituation(), "情况: 缺少文档身份\n")],
    }),
  ).rejects.toMatchObject({ code: "candidate_validation_failed" });
  expect(await store.recoverEndpoint(worldId)).toEqual(before);
});

test("时间线修订回退到被替换消息的父端点后追加修改稿，被替换的端点不再可达", async () => {
  const fixture = await world();
  const steps = [
    ["player", "第一句。"],
    ["narrator", "第一回应。"],
    ["player", "被替换的第二句。"],
    ["narrator", "被替换的回应。"],
  ] as const;
  let parentHead = "genesis";
  for (const [index, [role, exactText]] of steps.entries()) {
    parentHead = (
      await fixture.store.commitPlayStep({
        operationId: `revision-step-${index + 1}`,
        worldId: fixture.worldId,
        parentHead,
        historyAppend: [{ role, exactText }],
        nextMaterials: [],
        stateChanges: [],
      })
    ).head;
  }
  const replaced = await fixture.store.recoverEndpoint(
    fixture.worldId,
    "commit:2",
  );

  const revised = await revisePlayerTimeline(fixture.store, {
    operationId: "revision-edit",
    worldId: fixture.worldId,
    expectedCurrentHead: "commit:4",
    restoresHead: "commit:2",
    replacesHead: "commit:3",
    replacementText: "修改后的第二句。",
  });
  // 修订先回退再追加：轮号不重用，修改稿的端点是新的轮号。
  expect(revised).toMatchObject({ outcome: "committed", head: "commit:6" });

  const current = await fixture.store.recoverEndpoint(fixture.worldId);
  expect(current.history.map(({ exactText }) => exactText)).toEqual([
    "The room falls quiet, leaving the present situation for your response.\n",
    "第一句。",
    "第一回应。",
    "修改后的第二句。",
  ]);
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId, "commit:2"),
  ).resolves.toEqual(replaced);
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId, "commit:3"),
  ).rejects.toThrow();

  // 被丢弃的历史消息文件随回退一并删除，当前历史目录只剩当前时间线。
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  expect(await readdir(join(worldRoot, "history"))).toHaveLength(4);
});

test("历史端点派生复制闭包，来源删除后分叉仍可恢复、继续提交并再次分叉", async () => {
  const fixture = await world();
  const derivedSteps = [
    { role: "player", exactText: "第一句。" },
    { role: "narrator", exactText: "第一回应。" },
  ] as const;
  for (const [index, step] of derivedSteps.entries()) {
    await fixture.store.commitPlayStep({
      operationId: `derive-step-${index + 1}`,
      worldId: fixture.worldId,
      parentHead: index === 0 ? "genesis" : "commit:1",
      historyAppend: [step],
      nextMaterials: [],
      stateChanges: [],
    });
  }
  const source = await fixture.store.recoverEndpoint(
    fixture.worldId,
    "commit:1",
  );
  const fork = await fixture.store.deriveWorld({
    operationId: "derive-from-first",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host",
  });
  await rm(join(fixture.root, "worlds-file-native", fixture.worldId), {
    recursive: true,
    force: true,
  });

  await expect(
    fixture.store.recoverEndpoint(fork.world.worldId),
  ).resolves.toEqual({
    ...source,
    worldId: fork.world.worldId,
  });
  await expect(
    fixture.store.commitPlayStep({
      operationId: "fork-continues",
      worldId: fork.world.worldId,
      parentHead: "commit:1",
      historyAppend: [{ role: "player", exactText: "来源删除后的续写。" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).resolves.toMatchObject({ head: "commit:4" });
  const again = await fixture.store.deriveWorld({
    operationId: "derive-again",
    sourceWorldId: fork.world.worldId,
    sourceHead: "commit:4",
    hostPresetId: "host",
  });
  expect(await fixture.store.currentHead(again.world.worldId)).toBe("commit:4");
});

test("分叉的当前文件与来源该端点逐字节一致，且不与来源共享任何文件", async () => {
  const fixture = await world();
  await fixture.store.commitPlayStep({
    operationId: "share-step-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [{ role: "player", exactText: "独立的第一句。" }],
    nextMaterials: [],
    stateChanges: [],
  });
  const fork = await fixture.store.deriveWorld({
    operationId: "share-derive",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host",
  });
  const sourceRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  const forkRoot = join(fixture.root, "worlds-file-native", fork.world.worldId);
  const sourceState = join(sourceRoot, "state/current-situation.yaml");
  const forkState = join(forkRoot, "state/current-situation.yaml");
  expect(await readFile(forkState, "utf8")).toBe(
    await readFile(sourceState, "utf8"),
  );
  expect((await stat(forkState)).ino).not.toBe((await stat(sourceState)).ino);
});

test("公开分叉跳过后续轮文件，保留正确投影并修复缺失、损坏和多余投影", async () => {
  const fixture = await world();
  const worldsRoot = join(fixture.root, "worlds-file-native");
  const source = join(worldsRoot, fixture.worldId);
  for (let step = 1; step <= 2; step += 1) {
    await fixture.store.commitPlayStep({
      operationId: `projection-step-${step}`,
      worldId: fixture.worldId,
      parentHead: step === 1 ? "genesis" : "commit:1",
      historyAppend: [
        {
          role: "player",
          exactText: `正文 ${step}`,
          background: { kind: "snapshot", value: `背景 ${step}` },
        },
      ],
      nextMaterials: [],
      stateChanges: [],
    });
  }
  const history = (await readdir(join(source, "history"))).sort();
  const [opening, kept, discarded] = history;
  const backgrounds = join("runtime", "history-backgrounds");
  const keptBackground = join(backgrounds, "message.1.1.player.json");
  const discardedBackground = join(backgrounds, "message.2.1.player.json");
  const expectedBackground = await readFile(join(source, keptBackground));
  await writeFile(join(source, "history", kept!), "损坏的正文");
  await rm(join(source, keptBackground));
  await mkdir(join(source, "history", "unrelated"));
  await writeFile(join(source, "history", "unrelated", "extra.md"), "多余正文");

  const runtime = new V1Runtime({
    dataRoot: fixture.root,
    configRoot: join(fixture.root, "config"),
  });
  await runtime.initialize();
  vi.clearAllMocks();
  const result = (
    await runtime.handle({
      type: "world.derive",
      operationId: "projection-fork",
      sourceWorldId: fixture.worldId,
      sourceHead: "commit:1",
    })
  ).result as { outcome: string; world: { worldId: string } };
  expect(result.outcome).toBe("derived");
  const fork = join(worldsRoot, result.world.worldId);
  const historyCopy = vi
    .mocked(cp)
    .mock.calls.find(([path]) => path === join(source, "history"));
  const turnsCopy = vi
    .mocked(cp)
    .mock.calls.find(([path]) => path === join(source, "runtime", "turns"));
  const backgroundsCopy = vi
    .mocked(cp)
    .mock.calls.find(([path]) => path === join(source, backgrounds));
  expect(
    await historyCopy?.[2]?.filter?.(
      join(source, "history", discarded!),
      "unused",
    ),
  ).toBe(false);
  expect(
    await backgroundsCopy?.[2]?.filter?.(
      join(source, discardedBackground),
      "unused",
    ),
  ).toBe(false);
  expect(
    await turnsCopy?.[2]?.filter?.(
      join(source, "runtime", "turns", "00000002.json"),
      "unused",
    ),
  ).toBe(false);
  const staging = String(historyCopy?.[1]);
  const renamedTo = vi.mocked(rename).mock.calls.map(([, path]) => path);
  expect(renamedTo).not.toContain(join(staging, opening!));
  expect(renamedTo).toContain(join(staging, kept!));
  expect((await readdir(join(fork, "history"))).sort()).toEqual([
    opening,
    kept,
  ]);
  expect(await readFile(join(fork, "history", kept!), "utf8")).toBe("正文 1");
  expect(await readFile(join(fork, keptBackground))).toEqual(
    expectedBackground,
  );
  expect(await readFile(join(source, "history", kept!), "utf8")).toBe(
    "损坏的正文",
  );
  expect((await readdir(join(fork, "runtime", "turns"))).sort()).toEqual([
    "00000001.json",
    "00000003.json",
  ]);
});

test("分叉使用已发布的文件，暂存失败后可重试且不改动来源的未完成轮", async () => {
  const { root, store, worldId } = await world();
  await store.ensureCurrentStorage(worldId);
  const worldsRoot = join(root, "worlds-file-native");
  const source = join(worldsRoot, worldId);
  const path = "state/current-situation.yaml";
  const changes = [
    { path, content: initialSituation().replace("安静", "未发布") },
  ];
  await beginTurn(source, { mode: "play", changes });
  await applyChanges(source, changes);

  const input = {
    operationId: "fork-with-incomplete-source-turn",
    sourceWorldId: worldId,
    sourceHead: "genesis",
    hostPresetId: "host",
  };
  await expect(
    store.deriveWorld({
      ...input,
      stageTarget: () => Promise.reject(new Error("stage failed")),
    }),
  ).rejects.toThrow("stage failed");
  expect(await readdir(worldsRoot)).toEqual([worldId]);

  const fork = await store.deriveWorld(input);
  expect(await readFile(join(fork.worldRoot, path), "utf8")).toBe(
    initialSituation(),
  );
  expect(await readdir(join(fork.worldRoot, "runtime", "turns"))).toEqual([]);
  await expect(store.deriveWorld(input)).resolves.toEqual(fork);
  expect(await readFile(join(source, path), "utf8")).toBe(changes[0]!.content);
  expect(await readdir(join(source, "runtime", "turns"))).toEqual([
    "00000001.json",
  ]);
});

test("完成的操作结果按世界保留最近 256 条，更早的操作 ID 视为未开始", async () => {
  const fixture = await world();
  let parentHead = "genesis";
  for (let index = 0; index < 257; index += 1) {
    const committed = await fixture.store.commitPlayStep({
      operationId: `retain-${index}`,
      worldId: fixture.worldId,
      parentHead,
      historyAppend: [{ role: "player", exactText: `Action ${index}` }],
      nextMaterials: [],
      stateChanges: [],
    });
    parentHead = committed.head;
  }
  await expect(fixture.store.getOperationOutcome("retain-0")).resolves.toEqual({
    outcome: "not_started",
  });
  await expect(
    fixture.store.getOperationOutcome("retain-1"),
  ).resolves.toMatchObject({ outcome: "committed" });
  await expect(
    fixture.store.getOperationOutcome("retain-256"),
  ).resolves.toMatchObject({ outcome: "committed" });
}, 120_000);

test("删除世界时清空该世界保留的操作结果", async () => {
  const fixture = await world();
  await fixture.store.commitPlayStep({
    operationId: "before-delete",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [{ role: "player", exactText: "Before deletion" }],
    nextMaterials: [],
    stateChanges: [],
  });
  await fixture.store.deleteWorld(fixture.worldId);
  await expect(
    fixture.store.getOperationOutcome("before-delete"),
  ).resolves.toEqual({ outcome: "not_started" });
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-file-authority-"));
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
