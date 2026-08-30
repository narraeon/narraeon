import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

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
    expect(
      authority.commits.map(({ parentCommitDigest }) => parentCommitDigest),
    ).toEqual([
      null,
      digest(authority.commits[0]),
      digest(authority.commits[1]),
      digest(authority.commits[2]),
    ]);
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
      store.getOperationOutcome("released-player-b"),
    ).resolves.toMatchObject({
      outcome: "committed",
      head: "commit:3",
      commitDigest: digest(authority.commits[2]),
    });

    const currentHeadBefore = await readFile(
      join(fixture.runtimeRoot, "play-authority-head.json"),
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
      readFile(join(fixture.runtimeRoot, "play-authority-head.json"), "utf8"),
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
    messageId: `${fixture.worldId}.message.genesis.narrator`,
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

test.each(["after_timeline", "before_current_head", "after_current_head"])(
  "已发布存档在 %s 强制退出后可由原始事实幂等完成迁移",
  async (edge) => {
    const fixture = await releasedWorld(`released-storage-crash-${edge}`, 1);
    const crashed = await runMigrationWorker(
      fixture.root,
      fixture.worldId,
      edge,
    );
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
  },
);

async function releasedWorld(label: string, callChainSchemaVersion: 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: `create-${label}`,
    sourcePackageId: `package-${label}`,
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
  const authority = await store.readAuthorityHistory(worldId);
  const releasedCommits = authority.commits.map((commit) => ({
    schemaVersion: 1,
    operationId: commit.operationId,
    parentHead: commit.parentHead,
    head: commit.head,
    mode: commit.mode,
    historyAppend: structuredClone(commit.historyAppend),
    stateChanges: structuredClone(commit.stateChanges),
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
  return {
    root,
    worldId,
    runtimeRoot,
    releasedAuthoritySource,
    releasedCallChainSource,
  };
}

async function releasedGenesisWorld(label: string) {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: `create-${label}`,
    sourcePackageId: `package-${label}`,
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
  return { root, worldId };
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
