import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_AUTHORITY_EDGE;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("从 genesis 与不可变提交恢复同一端点，并用同一 commit 幂等修复物化", async () => {
  const fixture = await world();
  const before = initialSituation();
  const after = before.replace("安静", "奖杯已经交给Alex");
  const committed = await fixture.store.commitPlayStep({
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
  expect(committed.outcome).toBe("committed");

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

test("Authority 追加只发布新提交和小端点，不再重写累计提交目录", async () => {
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

  await expect(
    readFile(join(runtimeRoot, "play-authority.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const authorityHead = JSON.parse(
    await readFile(join(runtimeRoot, "play-authority-head.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(authorityHead).toEqual({
    schemaVersion: 2,
    head: second.head,
    sequence: 2,
    commitDigest: authorityHead.commitDigest,
    operationId: "small-head-2",
  });
  expect(authorityHead.commitDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    JSON.parse(
      await readFile(join(runtimeRoot, "materialized-head.json"), "utf8"),
    ),
  ).toEqual({
    schemaVersion: 2,
    head: second.head,
    sequence: 2,
    commitDigest: authorityHead.commitDigest,
  });
  await expect(
    fixture.store.getOperationOutcome("small-head-1"),
  ).resolves.toMatchObject({ outcome: "committed", head: first.head });
  expect(await readdir(join(runtimeRoot, "play-commits"))).toHaveLength(2);
});

test.runIf(process.platform === "linux")(
  "提交事实已写但 Authority 端点尚未切换时，只允许同一操作原样恢复",
  async () => {
    expect(await crashWorker("after_acceptance_prepared")).toMatchObject({
      signal: "SIGKILL",
    });
    const root = roots.at(-1)!;
    const store = new FileNativeWorldStore(root);
    const creation = await store.getCreationOutcome("create");
    if (creation.outcome !== "created")
      throw new Error("world was not created");
    const worldId = creation.world.worldId;
    await expect(store.currentHead(worldId)).resolves.toBe("genesis");
    await expect(store.getOperationOutcome("play")).resolves.toEqual({
      outcome: "in_progress",
    });
    const before = initialSituation();
    const after = before.replace("安静", "已经提交");
    await expect(
      store.commitPlayStep({
        operationId: "play",
        worldId,
        parentHead: "genesis",
        historyAppend: [
          { role: "player", exactText: "Different player" },
          { role: "narrator", exactText: "Narrator" },
        ],
        nextMaterials: [],
        stateChanges: [change(before, after)],
      }),
    ).rejects.toMatchObject({ code: "operation_conflict" });

    expect(await runWorker(root, "none")).toMatchObject({ code: 0 });
    await expect(store.getOperationOutcome("play")).resolves.toMatchObject({
      outcome: "committed",
      head: "commit:1",
    });
    expect(
      await readdir(
        join(root, "worlds-file-native", worldId, "runtime", "play-commits"),
      ),
    ).toHaveLength(1);
  },
);

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
        { role: "player", exactText: "I inspect the changes in the room." },
        { role: "narrator", exactText: "You confirm the changes before you." },
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
        { role: "player", exactText: "I go to the cafeteria." },
        { role: "narrator", exactText: "You arrive at the cafeteria." },
      ],
      nextMaterials: [],
      stateChanges: [change(before, after)],
    })
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "candidate_validation_failed" });
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error)
    expect(error.message).toContain(
      "An explicit $ref points to a missing document, or the target identity is not unique in the snapshot",
    );
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId),
  ).resolves.toMatchObject({ head: "genesis" });
});

test("时间线修订在同一世界追加 Authority，并把当前投影恢复到玩家父端点后写入修改稿", async () => {
  const fixture = await world();
  const initial = initialSituation();
  const first = initial.replace("安静", "第一段状态");
  const second = first.replace("第一段状态", "第二段状态");

  await fixture.store.commitPlayStep({
    operationId: "timeline-player-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [{ role: "player", exactText: "First player message" }],
    nextMaterials: [],
    stateChanges: [],
  });
  await fixture.store.commitPlayStep({
    operationId: "timeline-narrator-1",
    worldId: fixture.worldId,
    parentHead: "commit:1",
    historyAppend: [{ role: "narrator", exactText: "First narrator response" }],
    nextMaterials: [
      {
        kind: "history_message",
        message: `${fixture.worldId}.message.1.1.player`,
      },
    ],
    stateChanges: [change(initial, first)],
  });
  await fixture.store.commitPlayStep({
    operationId: "timeline-player-2",
    worldId: fixture.worldId,
    parentHead: "commit:2",
    historyAppend: [{ role: "player", exactText: "Second player message" }],
    nextMaterials: [],
    stateChanges: [],
  });
  await fixture.store.commitPlayStep({
    operationId: "timeline-narrator-2",
    worldId: fixture.worldId,
    parentHead: "commit:3",
    historyAppend: [
      { role: "narrator", exactText: "Second narrator response" },
    ],
    nextMaterials: [],
    stateChanges: [change(first, second)],
  });
  const oldTip = await fixture.store.recoverEndpoint(
    fixture.worldId,
    "commit:4",
  );

  const revised = await fixture.store.reviseTimeline({
    operationId: "timeline-revision",
    worldId: fixture.worldId,
    expectedCurrentHead: "commit:4",
    restoresHead: "commit:2",
    replacesHead: "commit:3",
    replacementText: "Revised second player message",
    requestFingerprint: hash("timeline-revision-request"),
  });

  expect(revised).toMatchObject({
    outcome: "committed",
    worldId: fixture.worldId,
    parentHead: "commit:4",
    head: "commit:5",
    mode: "timeline_revision",
    historyAppend: [
      { role: "player", exactText: "Revised second player message" },
    ],
  });
  expect(await fixture.store.currentHead(fixture.worldId)).toBe("commit:5");
  const authority = await fixture.store.readAuthorityHistory(fixture.worldId);
  expect(authority.commits).toHaveLength(5);
  expect(authority.commits[4]).toMatchObject({
    parentHead: "commit:4",
    head: "commit:5",
    mode: "timeline_revision",
    timelineRevision: {
      restoresHead: "commit:2",
      replacesHead: "commit:3",
      requestFingerprint: hash("timeline-revision-request"),
    },
  });

  const current = await fixture.store.recoverEndpoint(fixture.worldId);
  expect(current.state[0]?.contents).toBe(first);
  expect(current.history.map(({ exactText }) => exactText)).toEqual([
    "The room falls quiet, leaving the present situation for your response.\n",
    "First player message",
    "First narrator response",
    "Revised second player message",
  ]);
  expect(current.additionalMaterials).toEqual([
    {
      kind: "history_message",
      message: `${fixture.worldId}.message.1.1.player`,
    },
  ]);
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId, "commit:4"),
  ).resolves.toEqual(oldTip);
  expect(
    await fixture.store.readSurface(fixture.worldId, "history"),
  ).toHaveLength(4);
  expect(await fixture.store.readSurface(fixture.worldId, "state")).toEqual(
    current.state,
  );

  await expect(
    fixture.store.reviseTimeline({
      operationId: "timeline-revision",
      worldId: fixture.worldId,
      expectedCurrentHead: "commit:5",
      restoresHead: "commit:2",
      replacesHead: "commit:3",
      replacementText: "Revised second player message",
      requestFingerprint: hash("timeline-revision-request"),
    }),
  ).resolves.toEqual(revised);
  await expect(
    fixture.store.reviseTimeline({
      operationId: "timeline-revision",
      worldId: fixture.worldId,
      expectedCurrentHead: "commit:5",
      restoresHead: "commit:2",
      replacesHead: "commit:3",
      replacementText: "另一份修改稿",
      requestFingerprint: hash("other-request"),
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });

  const fork = await fixture.store.deriveWorld({
    operationId: "fork-revised-timeline",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:5",
    hostPresetId: "host-current",
  });
  const forked = await fixture.store.recoverEndpoint(fork.world.worldId);
  expect(endpointSemantics(forked)).toEqual(endpointSemantics(current));
  expect(forked.additionalMaterials).toEqual([
    {
      kind: "history_message",
      message: `${fork.world.worldId}.message.1.1.player`,
    },
  ]);
  expect(
    JSON.stringify(
      await fixture.store.readAuthorityHistory(fork.world.worldId),
    ),
  ).not.toContain(fixture.worldId);
});

test("历史端点派生会复制完整 Authority 前缀，并在来源删除后独立恢复与继续提交", async () => {
  const fixture = await world();
  const before = initialSituation();
  const first = before.replace("安静", "第一段状态");
  await fixture.store.commitPlayStep({
    operationId: "play-1",
    worldId: fixture.worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "First player message" },
      { role: "narrator", exactText: "First narrator response" },
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
      { role: "player", exactText: "Second player message" },
      { role: "narrator", exactText: "Second narrator response" },
    ],
    nextMaterials: [],
    stateChanges: [change(first, second)],
  });
  await fixture.store.renameWorld(fixture.worldId, "雾港第一夜");
  const sourceGenesis = await fixture.store.recoverEndpoint(
    fixture.worldId,
    "genesis",
  );
  const sourceFirst = await fixture.store.recoverEndpoint(
    fixture.worldId,
    "commit:1",
  );

  const derived = await fixture.store.deriveWorld({
    operationId: "derive-1",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host-current",
  });
  expect(derived.world.title).toBe("雾港第一夜 (fork)");
  const derivedWorldId = derived.world.worldId;
  expect(await fixture.store.currentHead(derivedWorldId)).toBe("commit:1");
  expect(
    (await fixture.store.readAuthorityHistory(derivedWorldId)).commits,
  ).toMatchObject([
    {
      parentHead: "genesis",
      head: "commit:1",
      historyAppend: [
        {
          messageId: `${derivedWorldId}.message.1.1.player`,
          role: "player",
          exactText: "First player message",
        },
        {
          messageId: `${derivedWorldId}.message.1.2.narrator`,
          role: "narrator",
          exactText: "First narrator response",
        },
      ],
    },
  ]);
  expect(
    (await fixture.store.readAuthorityHistory(derivedWorldId)).commits[0]
      ?.operationId,
  ).not.toBe("play-1");

  const derivedGenesis = await fixture.store.recoverEndpoint(
    derivedWorldId,
    "genesis",
  );
  const derivedFirst = await fixture.store.recoverEndpoint(
    derivedWorldId,
    "commit:1",
  );
  expect(endpointSemantics(derivedGenesis)).toEqual(
    endpointSemantics(sourceGenesis),
  );
  expect(endpointSemantics(derivedFirst)).toEqual(
    endpointSemantics(sourceFirst),
  );
  expect(derivedFirst.state[0]?.contents).not.toContain("第二段状态");
  expect(derivedFirst.additionalMaterials).toEqual([
    {
      kind: "history_message",
      message: `${derivedWorldId}.message.1.1.player`,
    },
  ]);
  const derivedRuntime = await fixture.store.readSurface(
    derivedWorldId,
    "runtime",
  );
  expect(derivedRuntime).not.toHaveProperty("derivedFrom");
  expect(derivedRuntime).not.toHaveProperty("hostPresetId");
  expect(JSON.stringify(derivedRuntime)).not.toContain(fixture.worldId);

  await rm(join(fixture.root, "worlds-file-native", fixture.worldId), {
    recursive: true,
    force: true,
  });
  const coldStore = new FileNativeWorldStore(fixture.root);
  await expect(
    coldStore.deriveWorld({
      operationId: "derive-1",
      sourceWorldId: fixture.worldId,
      sourceHead: "commit:1",
      hostPresetId: "host-current",
    }),
  ).resolves.toEqual(derived);
  await expect(
    coldStore.deriveWorld({
      operationId: "derive-1",
      sourceWorldId: fixture.worldId,
      sourceHead: "genesis",
      hostPresetId: "host-current",
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(
    coldStore.recoverEndpoint(derivedWorldId, "genesis"),
  ).resolves.toEqual(derivedGenesis);
  await expect(
    coldStore.recoverEndpoint(derivedWorldId, "commit:1"),
  ).resolves.toEqual(derivedFirst);

  const child = await coldStore.deriveWorld({
    operationId: "derive-child",
    sourceWorldId: derivedWorldId,
    sourceHead: "commit:1",
    hostPresetId: "host-current",
  });
  expect(await coldStore.currentHead(child.world.worldId)).toBe("commit:1");

  const targetSecond = first.replace("第一段状态", "派生世界第二段状态");
  await coldStore.commitPlayStep({
    operationId: "derived-play-2",
    worldId: derivedWorldId,
    parentHead: "commit:1",
    historyAppend: [
      { role: "player", exactText: "Derived-world second player message" },
      { role: "narrator", exactText: "Derived-world second narrator response" },
    ],
    nextMaterials: [],
    stateChanges: [change(first, targetSecond)],
  });
  expect(await coldStore.currentHead(derivedWorldId)).toBe("commit:2");
  expect(
    (await coldStore.recoverEndpoint(derivedWorldId, "commit:1")).history,
  ).toEqual(derivedFirst.history);
  expect(
    (await coldStore.recoverEndpoint(derivedWorldId)).state[0]?.contents,
  ).toContain("派生世界第二段状态");
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

function endpointSemantics(endpoint: {
  head: string;
  state: { path: string; contents: string }[];
  history: { role: "player" | "narrator"; exactText: string }[];
}) {
  return {
    head: endpoint.head,
    state: endpoint.state,
    history: endpoint.history.map(({ role, exactText }) => ({
      role,
      exactText,
    })),
  };
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
