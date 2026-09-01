import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_STORAGE_MIGRATION_EDGE;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([1, 2] as const)(
  "已发布 schemaVersion=%s 的累计 Authority 与调用链会完整迁移且后续只写当前格式",
  async (callChainSchemaVersion) => {
    const fixture = await releasedWorld(
      `released-storage-v${callChainSchemaVersion}`,
      callChainSchemaVersion,
    );
    const store = new FileNativeWorldStore(fixture.root);

    await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
    const authority = await store.readAuthorityHistory(fixture.worldId);
    expect(authority.commits).toHaveLength(4);
    expect(authority.commits.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    const continuityHead = JSON.parse(
      await readFile(join(fixture.runtimeRoot, "continuity-head.json"), "utf8"),
    ) as { genesisDigest: string };
    expect(
      authority.commits.map(({ auditParent }) => auditParent.digest),
    ).toEqual([
      continuityHead.genesisDigest,
      digest(authority.commits[0]),
      digest(authority.commits[1]),
      digest(authority.commits[2]),
    ]);
    for (const expected of fixture.endpoints)
      await expect(
        store.recoverEndpoint(fixture.worldId, expected.head),
      ).resolves.toEqual(expected);
    await expect(store.recoverEndpoint(fixture.worldId)).resolves.toMatchObject(
      {
        head: "commit:4",
        history: [
          { role: "narrator", exactText: "门外传来三声短促的铃响。\n" },
          { role: "player", exactText: "我推开门。" },
          { role: "narrator", exactText: "冷风从门外灌进来。" },
          { role: "player", exactText: "我点亮提灯。" },
          { role: "narrator", exactText: "昏黄的光照亮走廊。" },
        ],
      },
    );

    const contexts = await store.playTimeline.readAllContexts(fixture.worldId);
    expect(contexts.map(({ chainId }) => chainId)).toEqual([
      "released-context-a",
      "released-context-b",
    ]);
    const currentContext = await store.playTimeline.readCurrent(
      fixture.worldId,
    );
    expect(currentContext?.value.previousChainId).toBe("released-context-a");
    expect(currentContext?.value.timelineGeneration).toMatch(
      /^released:[a-f0-9]{64}$/u,
    );
    const page = await store.playTimeline.readPage(fixture.worldId, 20);
    expect(page.items.some(({ kind }) => kind === "context_boundary")).toBe(
      true,
    );
    const toolResult = page.items.find(
      (item) =>
        item.kind === "event" &&
        item.chainId === "released-context-b" &&
        item.event.id === 4,
    );
    expect(toolResult?.kind).toBe("event");
    if (toolResult?.kind !== "event") throw new Error("missing tool result");
    expect(toolResult.event).toMatchObject({
      kind: "tool_result",
      detailsAvailable: true,
    });
    await expect(
      store.playTimeline.readDetail(fixture.worldId, "released-context-b", 4),
    ).resolves.toMatchObject({
      kind: "tool_result",
      markdown: "# 读取成功\n\n这是已发布存档里的完整工具结果。",
    });
    await expect(
      store.playTimeline.readDetail(fixture.worldId, "released-context-b", 2),
    ).resolves.toMatchObject({
      kind: "assistant",
      usage: {
        inputTokens: 321,
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        outputTokens: 45,
        totalTokens: null,
        provenance: {
          inputTokens: "provider",
          uncachedInputTokens: "unavailable",
          outputTokens: "provider",
          totalTokens: "unavailable",
        },
      },
    });
    await expect(
      store.getOperationOutcome("released-player-b"),
    ).resolves.toMatchObject({
      outcome: "committed",
      head: "commit:3",
      commitDigest: digest(authority.commits[2]),
    });

    const currentHeadBefore = await readFile(
      join(fixture.runtimeRoot, "continuity-head.json"),
      "utf8",
    );
    const timelineHeadBefore = await readFile(
      join(fixture.runtimeRoot, "play-timeline-head.json"),
      "utf8",
    );
    await new FileNativeWorldStore(fixture.root).ensureCurrentStorage(
      fixture.worldId,
    );
    await expect(
      readFile(join(fixture.runtimeRoot, "continuity-head.json"), "utf8"),
    ).resolves.toBe(currentHeadBefore);
    await expect(
      readFile(join(fixture.runtimeRoot, "play-timeline-head.json"), "utf8"),
    ).resolves.toBe(timelineHeadBefore);

    await store.commitPlayStep({
      operationId: "current-format-after-migration",
      worldId: fixture.worldId,
      parentHead: "commit:4",
      historyAppend: [{ role: "player", exactText: "我继续向前。" }],
      nextMaterials: [],
      stateChanges: [],
    });
    await expect(
      readFile(join(fixture.runtimeRoot, "play-authority.json"), "utf8"),
    ).resolves.toBe(fixture.releasedAuthoritySource);
    await expect(
      readFile(join(fixture.runtimeRoot, "play-call-chain.json"), "utf8"),
    ).resolves.toBe(fixture.releasedCallChainSource);
    await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:5");
  },
);

test("已发布分叉继承的历史调用链可保留来源世界端点别名并完成迁移", async () => {
  const fixture = await releasedWorld(
    "released-storage-inherited-context-head",
    2,
  );
  const callChainPath = join(fixture.runtimeRoot, "play-call-chain.json");
  const releasedCallChain = JSON.parse(
    await readFile(callChainPath, "utf8"),
  ) as {
    previousContexts: { parentHead: string }[];
  };
  releasedCallChain.previousContexts[0]!.parentHead = "commit:47";
  await writeJson(callChainPath, releasedCallChain);

  const store = new FileNativeWorldStore(fixture.root);
  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
  const contexts = await store.playTimeline.readAllContexts(fixture.worldId);
  expect(contexts.map(({ parentHead }) => parentHead)).toEqual([
    "commit:47",
    "commit:4",
  ]);
});

test("已发布世界的当前调用链引用未知 Authority 端点时仍然拒绝迁移", async () => {
  const fixture = await releasedWorld(
    "released-storage-invalid-current-context-head",
    2,
  );
  const callChainPath = join(fixture.runtimeRoot, "play-call-chain.json");
  const releasedCallChain = JSON.parse(
    await readFile(callChainPath, "utf8"),
  ) as { parentHead: string };
  releasedCallChain.parentHead = "commit:47";
  await writeJson(callChainPath, releasedCallChain);

  await expect(
    new FileNativeWorldStore(fixture.root).currentHead(fixture.worldId),
  ).rejects.toMatchObject({ code: "world_corrupt" });
});

test("schemaVersion=2 调用链迁移后可从包含工具结果的端点创建分叉", async () => {
  const fixture = await releasedWorld(
    "released-storage-v2-tool-result-fork",
    2,
  );
  const store = new FileNativeWorldStore(fixture.root);
  const chains = new PlayCallChain(store);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
  const sourceContexts = await store.playTimeline.readAllContexts(
    fixture.worldId,
  );
  expect(
    sourceContexts.at(-1)?.events.some(({ kind }) => kind === "tool_result"),
  ).toBe(true);
  expect(
    sourceContexts.at(-1)?.transcript.some(({ kind }) => kind === "tool"),
  ).toBe(false);
  const derived = await chains.deriveWorld({
    operationId: "fork-migrated-v2-tool-result",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:4",
    hostPresetId: "host-current",
  });
  await expect(
    chains.inspectWorld(derived.world.worldId),
  ).resolves.toMatchObject({
    parentHead: "commit:4",
  });
  const targetContexts = await store.playTimeline.readAllContexts(
    derived.world.worldId,
  );
  expect(targetContexts.at(-1)?.transcript).toEqual(
    sourceContexts.at(-1)?.transcript,
  );
  expect(targetContexts.at(-1)?.events).toEqual(sourceContexts.at(-1)?.events);
});

test("从未开始游玩的已发布世界会从 genesis 布局迁移", async () => {
  const fixture = await releasedGenesisWorld("released-storage-genesis");
  const store = new FileNativeWorldStore(fixture.root);
  await expect(store.currentHead(fixture.worldId)).resolves.toBe("genesis");
  await expect(store.readAuthorityHistory(fixture.worldId)).resolves.toEqual({
    head: "genesis",
    commits: [],
  });
  const page = await store.playTimeline.readPage(fixture.worldId, 10);
  expect(page.items).toContainEqual({
    kind: "genesis",
    messageId: "message.genesis.narrator",
    role: "narrator",
    exactText: "门外传来三声短促的铃响。\n",
  });
});

test("旧接受点发布前退出留下的唯一不可变链也会按已发布语义迁移", async () => {
  const fixture = await releasedWorld("released-storage-orphan-chain", 1);
  await rm(join(fixture.runtimeRoot, "play-authority.json"), { force: true });
  const store = new FileNativeWorldStore(fixture.root);
  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
  const authority = await store.readAuthorityHistory(fixture.worldId);
  expect(authority.head).toBe("commit:4");
  expect(authority.commits.map(({ sequence }) => sequence)).toEqual([
    1, 2, 3, 4,
  ]);
});

test("schemaVersion=2 迁移逐端点保留状态、历史、材料与 timeline revision 语义", async () => {
  const fixture = await currentV2RevisionWorld(
    "released-storage-current-revision",
  );
  const store = new FileNativeWorldStore(fixture.root);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:5");
  for (const endpoint of fixture.endpoints)
    await expect(
      store.recoverEndpoint(fixture.worldId, endpoint.head),
    ).resolves.toEqual(endpoint);
  const authority = await store.readAuthorityHistory(fixture.worldId);
  expect(authority.commits[4]).toMatchObject({
    mode: "timeline_revision",
    auditParent: { head: "commit:4" },
    timelineParent: { head: "commit:2" },
    timelineRevision: {
      restoresHead: "commit:2",
      replacesHead: "commit:3",
    },
  });
  expect(authority.commits[4]?.timelineRevision).not.toHaveProperty(
    "replacementState",
  );
  expect(authority.commits[4]?.timelineRevision).not.toHaveProperty(
    "replacementHistory",
  );
  const fork = await store.deriveWorld({
    operationId: "fork-migrated-current-revision",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:5",
    hostPresetId: "host-current",
  });
  await expect(store.recoverEndpoint(fork.world.worldId)).resolves.toEqual({
    ...fixture.endpoints.at(-1)!,
    worldId: fork.world.worldId,
  });
  expect(
    JSON.stringify(await store.readSurface(fork.world.worldId, "runtime")),
  ).not.toContain(fixture.worldId);
  for (const [path, source] of fixture.legacySources)
    await expect(readFile(path, "utf8")).resolves.toBe(source);
});

test("schemaVersion=2 存档迁移后的第一条消息可继续提交", async () => {
  const fixture = await currentV2RevisionWorld(
    "released-storage-current-first-message",
  );
  const store = new FileNativeWorldStore(fixture.root);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:5");
  await expect(
    store.commitPlayStep({
      operationId: "current-first-message-after-migration",
      worldId: fixture.worldId,
      parentHead: "commit:5",
      historyAppend: [{ role: "player", exactText: "我继续向前。" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).resolves.toMatchObject({ head: "commit:6" });
  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:6");
});

test("已被旧版本迁移为 V3 的世界作用域历史文件名会在首笔提交时自愈", async () => {
  const fixture = await currentV2RevisionWorld(
    "released-storage-already-migrated-projection",
  );
  const migrated = new FileNativeWorldStore(fixture.root);
  await expect(migrated.currentHead(fixture.worldId)).resolves.toBe("commit:5");
  await rewriteMaterializedHistoryAsWorldScoped(
    join(fixture.root, "worlds-file-native", fixture.worldId, "history"),
    fixture.worldId,
  );

  const reopened = new FileNativeWorldStore(fixture.root);
  await expect(
    reopened.commitPlayStep({
      operationId: "current-first-message-after-old-v3-migration",
      worldId: fixture.worldId,
      parentHead: "commit:5",
      historyAppend: [{ role: "player", exactText: "我继续向前。" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).resolves.toMatchObject({ head: "commit:6" });
});

test("schemaVersion=2 历史投影重键后在 V3 头发布前退出仍可幂等恢复", async () => {
  const fixture = await currentV2RevisionWorld(
    "released-storage-current-projection-crash",
  );
  const crashed = await runMigrationWorker(
    fixture.root,
    fixture.worldId,
    "before_authority_v3_head",
  );
  expect(crashed).toEqual({ code: null, signal: "SIGKILL" });

  const recovered = new FileNativeWorldStore(fixture.root);
  await expect(recovered.currentHead(fixture.worldId)).resolves.toBe(
    "commit:5",
  );
  await expect(
    recovered.commitPlayStep({
      operationId: "current-first-message-after-projection-crash",
      worldId: fixture.worldId,
      parentHead: "commit:5",
      historyAppend: [{ role: "player", exactText: "我继续向前。" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).resolves.toMatchObject({ head: "commit:6" });
});

test.each([
  "after_timeline",
  "before_current_head",
  "after_current_head",
  "before_authority_v3_head",
  "after_authority_v3_head",
])("已发布存档在 %s 强制退出后可由原始事实幂等完成迁移", async (edge) => {
  const fixture = await releasedWorld(`released-storage-crash-${edge}`, 1);
  const crashed = await runMigrationWorker(fixture.root, fixture.worldId, edge);
  expect(crashed).toEqual({ code: null, signal: "SIGKILL" });
  await expect(
    readFile(join(fixture.runtimeRoot, "play-authority.json"), "utf8"),
  ).resolves.toBe(fixture.releasedAuthoritySource);
  await expect(
    readFile(join(fixture.runtimeRoot, "play-call-chain.json"), "utf8"),
  ).resolves.toBe(fixture.releasedCallChainSource);

  const recovered = new FileNativeWorldStore(fixture.root);
  await expect(recovered.currentHead(fixture.worldId)).resolves.toBe(
    "commit:4",
  );
  const endpoint = await recovered.recoverEndpoint(fixture.worldId);
  expect(endpoint.head).toBe("commit:4");
  expect(
    endpoint.history.map(({ role, exactText }) => ({ role, exactText })),
  ).toContainEqual({ role: "player", exactText: "我点亮提灯。" });
  expect(
    endpoint.history.map(({ role, exactText }) => ({ role, exactText })),
  ).toContainEqual({ role: "narrator", exactText: "昏黄的光照亮走廊。" });
  await expect(
    recovered.playTimeline.readAllContexts(fixture.worldId),
  ).resolves.toHaveLength(2);
});

async function releasedWorld(label: string, callChainSchemaVersion: 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: `create-${label}`,
    sourcePackageId: `package-${label}`,
    sourcePackageTitle: `${label} package`,
    packageFiles: worldFiles(),
    prompt: releasePrompt(),
  });
  const worldId = created.world.worldId;
  const steps = [
    ["released-player-a", "player", "我推开门。"],
    ["released-narrator-a", "narrator", "冷风从门外灌进来。"],
    ["released-player-b", "player", "我点亮提灯。"],
    ["released-narrator-b", "narrator", "昏黄的光照亮走廊。"],
  ] as const;
  let parentHead = "genesis";
  for (const [operationId, role, exactText] of steps) {
    const outcome = await store.commitPlayStep({
      operationId,
      worldId,
      parentHead,
      historyAppend: [{ role, exactText }],
      nextMaterials: [],
      stateChanges: [],
    });
    parentHead = outcome.head;
  }
  const currentBinding = await store.bindPlayCallChain(worldId);
  const authority = await store.readAuthorityHistory(worldId);
  const endpoints = await Promise.all(
    ["genesis", ...authority.commits.map(({ head }) => head)].map((head) =>
      store.recoverEndpoint(worldId, head),
    ),
  );
  const releasedCommits = authority.commits.map((commit, index) => ({
    schemaVersion: 1,
    operationId: steps[index]![0],
    parentHead: commit.auditParent.head,
    head: commit.head,
    mode: commit.mode,
    historyAppend: commit.historyAppend.map((message) => ({
      ...structuredClone(message),
      messageId: `${worldId}.${message.messageId}`,
    })),
    stateChanges: [],
    nextAdditionalMaterials: structuredClone(commit.nextAdditionalMaterials),
    ...(commit.correctionTargets === undefined
      ? {}
      : { correctionTargets: structuredClone(commit.correctionTargets) }),
    ...(commit.corrects === undefined ? {} : { corrects: commit.corrects }),
    ...(commit.timelineRevision === undefined
      ? {}
      : { timelineRevision: structuredClone(commit.timelineRevision) }),
  }));
  const releasedAuthority = {
    schemaVersion: 1,
    head: authority.head,
    commits: releasedCommits,
  };
  const runtimeRoot = join(root, "worlds-file-native", worldId, "runtime");
  const genesisPath = join(runtimeRoot, "genesis.json");
  const legacyGenesis = JSON.parse(await readFile(genesisPath, "utf8")) as {
    history: { messageId: string }[];
    additionalMaterials: { kind: string; message?: string }[];
  };
  legacyGenesis.history = legacyGenesis.history.map((message) => ({
    ...message,
    messageId: `${worldId}.${message.messageId}`,
  }));
  legacyGenesis.additionalMaterials = legacyGenesis.additionalMaterials.map(
    (material) =>
      material.kind === "history_message" && material.message !== undefined
        ? { ...material, message: `${worldId}.${material.message}` }
        : material,
  );
  await writeJson(genesisPath, legacyGenesis);
  await rm(join(runtimeRoot, "play-commits"), {
    recursive: true,
    force: true,
  });
  await mkdir(join(runtimeRoot, "play-commits"), { recursive: true });
  for (const commit of releasedCommits)
    await writeJson(
      join(runtimeRoot, "play-commits", `${digest(commit)}.json`),
      commit,
    );
  const releasedAuthoritySource = await writeJson(
    join(runtimeRoot, "play-authority.json"),
    releasedAuthority,
  );
  await writeJson(join(runtimeRoot, "materialized-head.json"), {
    head: authority.head,
  });
  for (const commit of releasedCommits)
    await writeJson(operationOutcomePath(root, commit.operationId), {
      outcome: "committed",
      worldId,
      parentHead: commit.parentHead,
      head: commit.head,
      historyAppend: commit.historyAppend.map(({ role, exactText }) => ({
        role,
        exactText,
      })),
      nextAdditionalMaterials: commit.nextAdditionalMaterials,
      mode: commit.mode,
    });

  const releasedCallChain = {
    schemaVersion: callChainSchemaVersion,
    kind: "play_call_chain",
    worldId,
    ...contextB(),
    documentAuthorizationCheckpoints: [
      {
        afterEventId: 4,
        authorization: {
          schemaVersion: 1,
          kind: "play_document_authorizations",
          stateFingerprint: stateFilesFingerprint(currentBinding.files),
          documents: [],
        },
      },
    ],
    previousContexts: [contextA()],
  };
  const releasedCallChainSource = await writeJson(
    join(runtimeRoot, "play-call-chain.json"),
    releasedCallChain,
  );
  await rm(join(runtimeRoot, "play-genesis-timeline.json"), { force: true });
  await rm(join(runtimeRoot, "play-timeline-head.json"), { force: true });
  await rm(join(runtimeRoot, "play-contexts"), {
    recursive: true,
    force: true,
  });
  await rm(join(runtimeRoot, "play-authority-head.json"), { force: true });
  await rm(join(runtimeRoot, "continuity-head.json"), { force: true });
  await rm(join(runtimeRoot, "authority-v3"), {
    recursive: true,
    force: true,
  });
  return {
    root,
    worldId,
    runtimeRoot,
    releasedAuthoritySource,
    releasedCallChainSource,
    endpoints,
  };
}

async function releasedGenesisWorld(label: string) {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: `create-${label}`,
    sourcePackageId: `package-${label}`,
    sourcePackageTitle: `${label} package`,
    packageFiles: worldFiles(),
    prompt: releasePrompt(),
  });
  const worldId = created.world.worldId;
  const runtimeRoot = join(root, "worlds-file-native", worldId, "runtime");
  await writeJson(join(runtimeRoot, "materialized-head.json"), {
    head: "genesis",
  });
  await rm(join(runtimeRoot, "play-genesis-timeline.json"), { force: true });
  await rm(join(runtimeRoot, "play-authority-head.json"), { force: true });
  await rm(join(runtimeRoot, "continuity-head.json"), { force: true });
  await rm(join(runtimeRoot, "authority-v3"), {
    recursive: true,
    force: true,
  });
  return { root, worldId };
}

async function currentV2RevisionWorld(label: string) {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: `create-${label}`,
    sourcePackageId: `package-${label}`,
    sourcePackageTitle: `${label} package`,
    packageFiles: worldFiles(),
    prompt: releasePrompt(),
  });
  const worldId = created.world.worldId;
  const initial = worldFiles().find(
    ({ path }) => path === "world/current-situation.yaml",
  )!.contents;
  const opened = initial.replace("门仍然关着", "门已经打开");
  const dark = opened.replace("门已经打开", "门外走廊一片漆黑");
  const stateChange = (before: string, after: string) => ({
    kind: "replace" as const,
    documentId: "situation.current",
    stableShortRef: "current-situation",
    relativePath: "current-situation.yaml",
    codec: "yaml" as const,
    expectedPreviousHash: `sha256:${textDigest(before)}`,
    nextHash: `sha256:${textDigest(after)}`,
    canonicalNextBytes: after,
  });
  const operations = [
    "current-player-1",
    "current-narrator-1",
    "current-player-2",
    "current-narrator-2",
    "current-revision",
  ];
  const stateChanges = new Map<number, ReturnType<typeof stateChange>[]>([
    [2, [stateChange(initial, opened)]],
    [4, [stateChange(opened, dark)]],
  ]);
  await store.commitPlayStep({
    operationId: operations[0]!,
    worldId,
    parentHead: "genesis",
    historyAppend: [{ role: "player", exactText: "我推开门。" }],
    nextMaterials: [],
    stateChanges: [],
  });
  await store.commitPlayStep({
    operationId: operations[1]!,
    worldId,
    parentHead: "commit:1",
    historyAppend: [{ role: "narrator", exactText: "冷风从门外灌进来。" }],
    nextMaterials: [
      {
        kind: "history_message",
        message: `${worldId}.message.1.1.player`,
      },
    ],
    stateChanges: stateChanges.get(2)!,
  });
  await store.commitPlayStep({
    operationId: operations[2]!,
    worldId,
    parentHead: "commit:2",
    historyAppend: [{ role: "player", exactText: "我点亮提灯。" }],
    nextMaterials: [],
    stateChanges: [],
  });
  await store.commitPlayStep({
    operationId: operations[3]!,
    worldId,
    parentHead: "commit:3",
    historyAppend: [{ role: "narrator", exactText: "灯芯没有亮起来。" }],
    nextMaterials: [],
    stateChanges: stateChanges.get(4)!,
  });
  await store.reviseTimeline({
    operationId: operations[4]!,
    worldId,
    expectedCurrentHead: "commit:4",
    restoresHead: "commit:2",
    replacesHead: "commit:3",
    replacementText: "我先观察走廊。",
    requestFingerprint: `sha256:${digest("current-revision-request")}`,
  });

  const authority = await store.readAuthorityHistory(worldId);
  const endpoints = await Promise.all(
    ["genesis", ...authority.commits.map(({ head }) => head)].map((head) =>
      store.recoverEndpoint(worldId, head),
    ),
  );
  const endpointByHead = new Map(
    endpoints.map((endpoint) => [endpoint.head, endpoint]),
  );
  const runtimeRoot = join(root, "worlds-file-native", worldId, "runtime");
  const genesisPath = join(runtimeRoot, "genesis.json");
  const legacyGenesis = JSON.parse(await readFile(genesisPath, "utf8")) as {
    history: { messageId: string }[];
    additionalMaterials: { kind: string; message?: string }[];
  };
  legacyGenesis.history = legacyGenesis.history.map((message) => ({
    ...message,
    messageId: `${worldId}.${message.messageId}`,
  }));
  legacyGenesis.additionalMaterials = legacyGenesis.additionalMaterials.map(
    (material) =>
      material.kind === "history_message" && material.message !== undefined
        ? { ...material, message: `${worldId}.${material.message}` }
        : material,
  );
  await writeJson(genesisPath, legacyGenesis);
  const commitsRoot = join(runtimeRoot, "play-commits");
  await rm(commitsRoot, { recursive: true, force: true });
  await mkdir(commitsRoot, { recursive: true });
  let parentCommitDigest: string | null = null;
  const legacySources = new Map<string, string>();
  for (const fact of authority.commits) {
    const operationId = operations[fact.sequence - 1]!;
    const legacyStateChanges = (stateChanges.get(fact.sequence) ?? []).map(
      (change) => structuredClone(change),
    );
    const legacy = {
      schemaVersion: 2,
      sequence: fact.sequence,
      operationId,
      parentHead: fact.auditParent.head,
      parentCommitDigest,
      head: fact.head,
      mode: fact.mode,
      historyAppend: fact.historyAppend.map((message) => ({
        ...structuredClone(message),
        messageId: `${worldId}.${message.messageId}`,
      })),
      stateChanges: legacyStateChanges,
      nextAdditionalMaterials: fact.nextAdditionalMaterials.map((material) =>
        material.kind === "history_message"
          ? { ...material, message: `${worldId}.${material.message}` }
          : structuredClone(material),
      ),
      ...(fact.correctionTargets === undefined
        ? {}
        : { correctionTargets: structuredClone(fact.correctionTargets) }),
      ...(fact.corrects === undefined ? {} : { corrects: fact.corrects }),
      ...(fact.timelineRevision === undefined
        ? {}
        : {
            timelineRevision: {
              ...structuredClone(fact.timelineRevision),
              replacementState: endpointByHead
                .get(fact.timelineRevision.restoresHead)!
                .state.map(({ path, contents }) => ({
                  path,
                  sha256: `sha256:${textDigest(contents)}`,
                  canonicalBytes: contents,
                })),
              replacementHistory: endpointByHead
                .get(fact.timelineRevision.restoresHead)!
                .history.map((message) => ({
                  ...structuredClone(message),
                  messageId: `${worldId}.${message.messageId}`,
                })),
            },
          }),
    };
    parentCommitDigest = digest(legacy);
    const path = join(commitsRoot, `${parentCommitDigest}.json`);
    legacySources.set(path, await writeJson(path, legacy));
  }
  const headPath = join(runtimeRoot, "play-authority-head.json");
  legacySources.set(
    headPath,
    await writeJson(headPath, {
      schemaVersion: 2,
      head: "commit:5",
      sequence: 5,
      commitDigest: parentCommitDigest,
      operationId: operations.at(-1),
    }),
  );
  await writeJson(join(runtimeRoot, "materialized-head.json"), {
    schemaVersion: 2,
    head: "commit:5",
    sequence: 5,
    commitDigest: parentCommitDigest,
  });
  await rewriteMaterializedHistoryAsWorldScoped(
    join(root, "worlds-file-native", worldId, "history"),
    worldId,
  );
  await rm(join(runtimeRoot, "continuity-head.json"), { force: true });
  await rm(join(runtimeRoot, "authority-v3"), {
    recursive: true,
    force: true,
  });
  return { root, worldId, endpoints, legacySources };
}

async function rewriteMaterializedHistoryAsWorldScoped(
  historyRoot: string,
  worldId: string,
): Promise<void> {
  for (const file of await readdir(historyRoot)) {
    const match = /^(\d{8})-(\d+)-(player|narrator)-[a-f0-9]{12}\.md$/u.exec(
      file,
    );
    if (match === null) throw new Error(`Unexpected history file: ${file}`);
    const sequence = Number.parseInt(match[1]!, 10);
    const index = Number.parseInt(match[2]!, 10);
    const role = match[3]!;
    const localMessageId =
      sequence === 0
        ? index === 1 && role === "narrator"
          ? "message.genesis.narrator"
          : `message.genesis.${String(index)}.${role}`
        : `message.${String(sequence)}.${String(index)}.${role}`;
    const legacyMessageId = `${worldId}.${localMessageId}`;
    const legacyName = `${match[1]}-${match[2]}-${role}-${textDigest(legacyMessageId).slice(0, 12)}.md`;
    await rename(join(historyRoot, file), join(historyRoot, legacyName));
  }
}

function contextA() {
  return {
    chainId: "released-context-a",
    baselineHead: "genesis",
    baselineHistoryLength: 1,
    parentHead: "commit:2",
    playPreset: { id: "released-preset", revision: "v1" },
    status: "ready",
    canRetry: false,
    bootstrap: { messages: [] },
    tools: [],
    transcript: [
      { kind: "player", text: "我推开门。" },
      { kind: "assistant", text: "冷风从门外灌进来。", toolCalls: [] },
    ],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId: "released-exchange-a",
        text: "我推开门。",
        context: "fresh",
        committedHead: "commit:1",
      },
      {
        id: 2,
        kind: "assistant",
        text: "冷风从门外灌进来。",
        status: "completed",
        exchange: 1,
        attempt: 1,
        committedHead: "commit:2",
      },
    ],
    completedTools: [],
    changedDocuments: [],
    nextMaterials: [],
    nextEventId: 3,
    exchange: 1,
    lastRequest: null,
    lastRequestAttempt: 0,
    lastFailure: null,
    updatedAt: 1_700_000_000_000,
  };
}

function contextB() {
  return {
    chainId: "released-context-b",
    baselineHead: "commit:2",
    baselineHistoryLength: 3,
    parentHead: "commit:4",
    playPreset: { id: "released-preset", revision: "v1" },
    status: "ready",
    canRetry: false,
    bootstrap: { messages: [] },
    tools: [],
    transcript: [
      { kind: "player", text: "我点亮提灯。" },
      { kind: "assistant", text: "昏黄的光照亮走廊。", toolCalls: [] },
    ],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId: "released-exchange-b",
        text: "我点亮提灯。",
        context: "fresh",
        committedHead: "commit:3",
      },
      {
        id: 2,
        kind: "assistant",
        text: "昏黄的光照亮走廊。",
        reasoning: "先确认走廊里没有突然出现的新事实。",
        usage: { inputTokens: 321, outputTokens: 45 },
        status: "completed",
        exchange: 1,
        attempt: 1,
        committedHead: "commit:4",
      },
      {
        id: 3,
        kind: "tool_call",
        callId: "released-read",
        name: "context_read",
        arguments: { target: "@current-situation" },
        replayed: false,
      },
      {
        id: 4,
        kind: "tool_result",
        callId: "released-read",
        name: "context_read",
        ok: true,
        markdown: "# 读取成功\n\n这是已发布存档里的完整工具结果。",
        replayed: false,
      },
    ],
    completedTools: [],
    changedDocuments: [],
    nextMaterials: [],
    nextEventId: 5,
    exchange: 1,
    lastRequest: null,
    lastRequestAttempt: 0,
    lastFailure: null,
    updatedAt: 1_700_000_100_000,
  };
}

function releasePrompt() {
  return {
    hostBinding: {
      hostPresetId: "released-host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
        "blocks/style.md": "# Style\n",
      },
    },
    modelBinding: {
      provider: "chat_completions" as const,
      modelId: "released-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  };
}

function worldFiles() {
  return [
    { path: "opening.md", contents: "门外传来三声短促的铃响。\n" },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 当前局面。
  aliases: []
情况: 门仍然关着
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`,
    },
    { path: "control/blocks/world.md", contents: "# World Rules\n" },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}

function operationOutcomePath(root: string, operationId: string): string {
  return join(
    root,
    "operations",
    `outcome-${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateFilesFingerprint(
  files: Readonly<Record<string, string>>,
): string {
  const hash = createHash("sha256");
  for (const [path, contents] of Object.entries(files)
    .filter(([path]) => path.startsWith("state/"))
    .sort(([left], [right]) => left.localeCompare(right)))
    hash.update(path).update("\0").update(contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, source, "utf8");
  return source;
}

function runMigrationWorker(root: string, worldId: string, edge: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve(
            "tests/runtime/fixtures/released-storage-migration-worker.ts",
          ),
          root,
          worldId,
          edge,
        ],
        { env: { ...process.env, NODE_ENV: "test" }, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    },
  );
}
