import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const worker = resolve(
  "tests/runtime/fixtures/file-native-world-creation-worker.ts",
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "linux")(
  "文件原生世界创建的进程故障边界",
  () => {
    test("原子发布前故障不留下半世界，同 operation 可以恢复", async () => {
      const fixture = await prepare();
      expect(await run(fixture, "after_staging")).toMatchObject({
        signal: "SIGKILL",
      });
      const store = new FileNativeWorldStore(fixture.root);
      await expect(store.getCreationOutcome("create-op-1")).resolves.toEqual({
        outcome: "not_created",
      });
      expect(await run(fixture)).toMatchObject({ code: 0, signal: null });
      await expect(
        store.getCreationOutcome("create-op-1"),
      ).resolves.toMatchObject({ outcome: "created" });
    });

    test("原子发布后结果未知可由同一 operation outcome 恢复", async () => {
      const fixture = await prepare();
      expect(await run(fixture, "after_atomic_publish")).toMatchObject({
        signal: "SIGKILL",
      });
      const store = new FileNativeWorldStore(fixture.root);
      const outcome = await store.getCreationOutcome("create-op-1");
      expect(outcome).toMatchObject({ outcome: "created" });
      if (outcome.outcome !== "created")
        throw new Error("The world was not recovered");
      await expect(
        store.readSurface(outcome.world.worldId, "history"),
      ).resolves.toEqual([
        expect.objectContaining({
          contents:
            "The room falls quiet, leaving the present situation for your response.\n",
        }),
      ]);
    });
  },
);

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-file-world-process-"));
  roots.push(root);
  const inputPath = join(root, "input.json");
  await writeFile(inputPath, JSON.stringify(input()), "utf8");
  return { root, inputPath };
}

function run(
  fixture: { root: string; inputPath: string },
  edge = "none",
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [worker, fixture.root, fixture.inputPath, edge],
      { env: { ...process.env, NODE_ENV: "test" }, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

function input() {
  return {
    operationId: "create-op-1",
    sourcePackageId: "package-1",
    sourcePackageTitle: "Test content package",
    packageFiles: [
      {
        path: "opening.md",
        contents:
          "The room falls quiet, leaving the present situation for your response.\n",
      },
      {
        path: "world/current-situation.yaml",
        contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`,
      },
      {
        path: "control/frame.yaml",
        contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
      },
      { path: "control/blocks/world.md", contents: "# World Rules\n" },
      {
        path: "control/player-views.yaml",
        contents:
          "format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 当前状态\n    items: []\n",
      },
    ],
    prompt: {
      hostBinding: {
        hostPresetId: "host-1",
        files: {
          "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
          "blocks/style.md": "# Style\n",
        },
      },
      modelBinding: {
        provider: "chat_completions",
        modelId: "test-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    },
  };
}
