import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import {
  FileNativeWorldCreationError,
  FileNativeWorldStore,
} from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  forgetLedger,
  rewindTo,
} from "../../src/runtime/world/WorldTurnLedger.ts";
import { revisePlayerTimeline } from "./support/player-timeline-edit.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// 回退与读取交错（ADR-0044：读取不排队，只依赖原子发布）。
test("world.read 在取得端点与读取之间被回退时，从回退后的当前端点返回，不报错", async () => {
  const fixture = await world();
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  const runtime = new V1Runtime({
    dataRoot: fixture.root,
    configRoot: join(fixture.root, "config"),
  });
  await runtime.initialize();

  // 第一次取得 commit:2 之后、按它读取之前，回退到 commit:1 并发布新端点。
  vi.spyOn(
    FileNativeWorldStore.prototype,
    "currentHead",
  ).mockImplementationOnce(async (worldId) => {
    const head = await fixture.store.currentHead(worldId);
    expect(head).toBe("commit:2");
    await rewindTo(worldRoot, 1);
    return head;
  });

  const response = await runtime.handle({
    type: "world.read",
    worldId: fixture.worldId,
  });
  expect(response.result).toMatchObject({
    worldId: fixture.worldId,
    head: "commit:1",
  });
});

test("显式读取已被回退丢弃的端点返回 endpoint_discarded，而不是 world_corrupt", async () => {
  const fixture = await world();
  await fixture.store.rewindPlayerRevision(fixture.worldId, "commit:1");

  const error = await fixture.store
    .recoverEndpoint(fixture.worldId, "commit:2")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FileNativeWorldCreationError);
  expect(error).toMatchObject({ code: "endpoint_discarded" });
  await expect(
    fixture.store.renderPlayerViewsAtHead(fixture.worldId, "commit:2"),
  ).rejects.toMatchObject({ code: "endpoint_discarded" });
});

test("账本记录真实缺失时仍报告 world_corrupt", async () => {
  const fixture = await world();
  const worldRoot = join(fixture.root, "worlds-file-native", fixture.worldId);
  await rm(join(worldRoot, "runtime/turns/00000002.json"));
  forgetLedger(worldRoot);

  await expect(
    fixture.store.recoverEndpoint(fixture.worldId),
  ).rejects.toMatchObject({ code: "world_corrupt" });
});

test("world.read 与修改玩家消息并发执行时不返回 500", async () => {
  const fixture = await world();
  const runtime = new V1Runtime({
    dataRoot: fixture.root,
    configRoot: join(fixture.root, "config"),
  });
  await runtime.initialize();

  for (let round = 0; round < 10; round += 1) {
    const reads = Array.from({ length: 4 }, () =>
      runtime.handle({ type: "world.read", worldId: fixture.worldId }),
    );
    const [, ...results] = await Promise.all([
      revisePlayerTimeline(fixture.store, {
        operationId: `revise-${round}`,
        worldId: fixture.worldId,
        restoresHead: "commit:1",
        replacementText: `修改后的第二句 ${round}。`,
      }),
      ...reads,
    ]);
    for (const response of results) {
      expect(response.result).toMatchObject({ worldId: fixture.worldId });
    }
  }
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-read-rewind-"));
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
  const worldId = created.world.worldId;
  let parentHead = "genesis";
  const steps = [
    { role: "player", exactText: "第一句。" },
    { role: "narrator", exactText: "第一回应。" },
  ] as const;
  for (const [index, step] of steps.entries()) {
    parentHead = (
      await store.commitPlayStep({
        operationId: `step-${index + 1}`,
        worldId,
        parentHead,
        historyAppend: [step],
        nextMaterials: [],
        stateChanges: [],
      })
    ).head;
  }
  expect(parentHead).toBe("commit:2");
  return { root, store, worldId };
}

function initialSituation() {
  return `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`;
}
