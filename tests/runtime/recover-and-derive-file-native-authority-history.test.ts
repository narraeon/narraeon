import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("从 genesis 与不可变提交恢复同一端点，并用同一 commit 幂等修复物化", async () => {
  const fixture = await world();
  const before = initialSituation();
  const after = before.replace("安静", "奖杯已经交给秦龙");
  const committed = await fixture.store.commitPlayStep({
    operationId: "play-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "我把奖杯交给秦龙。" },
      { role: "narrator", exactText: "秦龙接过奖杯，认真道谢。" },
    ],
    nextMaterials: [],
    stateChanges: [change(before, after)],
  });
  expect(committed.outcome).toBe("committed");

  const recovered = await fixture.store.recoverEndpoint(fixture.worldId);
  expect(recovered).toMatchObject({
    head: "commit:1",
    history: [
      {
        role: "narrator",
        exactText: "房间安静下来，眼前的局面正等你回应。\n",
      },
      { role: "player", exactText: "我把奖杯交给秦龙。" },
      { role: "narrator", exactText: "秦龙接过奖杯，认真道谢。" },
    ],
  });
  expect(recovered.state[0]?.contents).toContain("奖杯已经交给秦龙");

  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  await writeFile(join(worldRoot, "state/current-situation.yaml"), before);
  await rm(join(worldRoot, "history"), { recursive: true, force: true });
  await rm(join(worldRoot, "runtime/materialized-head.json"), { force: true });
  await expect(
    fixture.store.getOperationOutcome("play-1"),
  ).resolves.toMatchObject({
    outcome: "committed_materialization_pending",
  });
  await expect(
    fixture.store.repairMaterialization(fixture.worldId),
  ).resolves.toMatchObject({
    outcome: "committed",
    head: "commit:1",
  });
  expect(
    await readFile(join(worldRoot, "state/current-situation.yaml"), "utf8"),
  ).toBe(after);
  expect(
    await fixture.store.readSurface(fixture.worldId, "history"),
  ).toHaveLength(2);
});

test("Authority 接受后的确定物化冲突必须抛出，不得伪装为普通 pending", async () => {
  const fixture = await world();
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  const playerMessageId = `${fixture.worldId}.message.1.1.player`;
  const playerDigest = createHash("sha256")
    .update(playerMessageId)
    .digest("hex")
    .slice(0, 12);
  const historyRoot = join(worldRoot, "history");
  await mkdir(historyRoot, { recursive: true });
  await writeFile(
    join(historyRoot, `00000001-01-player-${playerDigest}.md`),
    "与待提交玩家原文冲突的字节",
    "utf8",
  );

  await expect(
    fixture.store.commitPlayStep({
      operationId: "play-materialization-conflict",
      worldId: fixture.worldId,
      parentHead: "genesis",
      historyAppend: [
        { role: "player", exactText: "我确认房间里的变化。" },
        { role: "narrator", exactText: "你确认了眼前的变化。" },
      ],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).rejects.toMatchObject({ code: "inconsistent_materialization" });
  await expect(
    fixture.store.getOperationOutcome("play-materialization-conflict"),
  ).rejects.toMatchObject({ code: "inconsistent_materialization" });
});

test("提交边界把无效候选归类为候选校验失败，而不是权威世界损坏", async () => {
  const fixture = await world();
  const before = initialSituation();
  const after = before.replace("情况: 安静", "地点:\n  $ref: location.missing");

  const error: unknown = await fixture.store
    .commitPlayStep({
      operationId: "play-invalid-candidate",
      worldId: fixture.worldId,
      parentHead: "genesis",
      historyAppend: [
        { role: "player", exactText: "我去食堂。" },
        { role: "narrator", exactText: "你到了食堂。" },
      ],
      nextMaterials: [],
      stateChanges: [change(before, after)],
    })
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "candidate_validation_failed" });
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error)
    expect(error.message).toContain("显式 $ref 指向不存在的文档");
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId),
  ).resolves.toMatchObject({ head: "genesis" });
});

test("历史端点派生为物理闭包，保留文档身份并重写历史材料引用", async () => {
  const fixture = await world();
  const before = initialSituation();
  const first = before.replace("安静", "第一段状态");
  await fixture.store.commitPlayStep({
    operationId: "play-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "第一句" },
      { role: "narrator", exactText: "第一答" },
    ],
    nextMaterials: [
      {
        kind: "history_message",
        message: `${fixture.worldId}.message.1.1.player`,
      },
    ],
    stateChanges: [change(before, first)],
  });
  const second = first.replace("第一段状态", "第二段状态");
  await fixture.store.commitPlayStep({
    operationId: "play-2",
    worldId: fixture.worldId,
    parentHead: "commit:1",
    historyAppend: [
      { role: "player", exactText: "第二句" },
      { role: "narrator", exactText: "第二答" },
    ],
    nextMaterials: [],
    stateChanges: [change(first, second)],
  });

  const derived = await fixture.store.deriveWorld({
    operationId: "derive-1",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host-current",
  });
  const endpoint = await fixture.store.recoverEndpoint(derived.world.worldId);
  expect(endpoint.head).toBe("genesis");
  expect(endpoint.state[0]?.contents).toContain("第一段状态");
  expect(endpoint.state[0]?.contents).not.toContain("第二段状态");
  expect(endpoint.state[0]?.contents).toContain("id: situation.current");
  expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
    "房间安静下来，眼前的局面正等你回应。\n",
    "第一句",
    "第一答",
  ]);
  expect(endpoint.additionalMaterials).toEqual([
    {
      kind: "history_message",
      message: `${derived.world.worldId}.message.2`,
    },
  ]);

  await rm(join(fixture.root, "worlds-file-native", fixture.worldId), {
    recursive: true,
    force: true,
  });
  await expect(
    fixture.store.recoverEndpoint(derived.world.worldId),
  ).resolves.toEqual(endpoint);
});

test.runIf(process.platform === "linux")(
  "进程崩溃边界诚实区分接受、物化、修复与派生发布",
  async () => {
    for (const edge of ["before_commit_acceptance", "after_commit_acceptance"])
      expect(await crashWorker(edge)).toMatchObject({ signal: "SIGKILL" });
    const root = roots.at(-1)!;
    const store = new FileNativeWorldStore(root);
    const worldId = (await store.getCreationOutcome("create")).outcome;
    expect(worldId).toBe("created");
    await expect(store.getOperationOutcome("play")).resolves.toMatchObject({
      outcome: "committed_materialization_pending",
    });
    expect(await runWorker(root, "after_state_materialization")).toMatchObject({
      signal: "SIGKILL",
    });
    expect(await runWorker(root, "none")).toMatchObject({ code: 0 });
    expect(
      await runWorker(root, "derivation_before_publish", "derive"),
    ).toMatchObject({
      signal: "SIGKILL",
    });
    expect(await runWorker(root, "none", "derive")).toMatchObject({ code: 0 });
  },
);

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-file-authority-"));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: "create",
    sourcePackageId: "package",
    packageFiles: [
      {
        path: "opening.md",
        contents: "房间安静下来，眼前的局面正等你回应。\n",
      },
      { path: "world/current-situation.yaml", contents: initialSituation() },
      {
        path: "control/frame.yaml",
        contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
      },
      { path: "control/blocks/world.md", contents: "# 世界规则\n" },
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
          "blocks/style.md": "# 风格\n",
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

async function crashWorker(edge: string) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-authority-crash-"));
  roots.push(root);
  return runWorker(root, edge);
}

function runWorker(root: string, edge: string, mode = "commit") {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve("tests/runtime/fixtures/file-native-authority-worker.ts"),
          root,
          edge,
          mode,
        ],
        { env: { ...process.env, NODE_ENV: "test" }, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    },
  );
}
