import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  gameplayFile,
  type ResolutionScheme,
} from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  FileNativeWorldStore,
  FileNativeWorldCreationError,
} from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("世界继承内容包玩法身份", () => {
  test("创建跑团世界时复制 control/gameplay.json，摘要与读取都暴露玩法", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const tabletop = tabletopFiles("d20");

    const created = await store.createFromContentPackage(
      input("package-d20", tabletop),
    );
    if (created.outcome !== "created") throw new Error("world not created");

    const worldId = created.world.worldId;
    expect(created.world.gameplay).toEqual({ mode: "tabletop", scheme: "d20" });
    expect(await store.readSurface(worldId, "control")).toContainEqual({
      path: "gameplay.json",
      contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
    });
    expect(await store.gameplay(worldId)).toEqual({
      mode: "tabletop",
      scheme: "d20",
    });
    expect(await store.listWorlds()).toEqual([created.world]);
    expect(await new FileNativeWorldStore(root).listWorlds()).toEqual([
      created.world,
    ]);
  });

  test("互动式小说世界没有玩法文件，摘要为互动式小说", async () => {
    const store = new FileNativeWorldStore(await temporaryRoot());

    const created = await store.createFromContentPackage(
      input("package-fiction", minimalFileNativeContentScaffold("en")),
    );
    if (created.outcome !== "created") throw new Error("world not created");

    expect(created.world.gameplay).toEqual({ mode: "interactive-fiction" });
    expect(
      (await store.readSurface(created.world.worldId, "control")).map(
        ({ path }) => path,
      ),
    ).not.toContain("gameplay.json");
    expect(await store.gameplay(created.world.worldId)).toEqual({
      mode: "interactive-fiction",
    });
  });

  test("派生世界沿用来源玩法，改名后仍保留", async () => {
    const store = new FileNativeWorldStore(await temporaryRoot());
    const created = await store.createFromContentPackage(
      input("package-bag", tabletopFiles("bag")),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    await store.renameWorld(created.world.worldId, "来源世界");

    const derived = await store.deriveWorld({
      operationId: "derive-bag",
      sourceWorldId: created.world.worldId,
      sourceHead: "genesis",
      hostPresetId: "host-1",
    });

    expect(derived.world.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });
    expect(await store.gameplay(derived.world.worldId)).toEqual({
      mode: "tabletop",
      scheme: "bag",
    });
    expect(
      (await store.readSurface(derived.world.worldId, "control")).find(
        ({ path }) => path === "gameplay.json",
      ),
    ).toEqual({
      path: "gameplay.json",
      contents: gameplayFile({ mode: "tabletop", scheme: "bag" }).contents,
    });
  });

  test("世界控制草稿拒绝改变模式或方案，未改变的玩法文件可以保存", async () => {
    const store = new FileNativeWorldStore(await temporaryRoot());
    const created = await store.createFromContentPackage(
      input("package-d100", tabletopFiles("d100")),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    const worldId = created.world.worldId;
    const control = await store.readSurface(worldId, "control");

    const retargeted = control.map((file) =>
      file.path === "gameplay.json"
        ? gameplayFile({ mode: "tabletop", scheme: "d20" })
        : file,
    );
    const fiction = control.filter(({ path }) => path !== "gameplay.json");

    const rejected = store.saveControlDraft(worldId, retargeted);
    await expect(rejected).rejects.toMatchObject({
      code: "candidate_validation_failed",
    });
    await expect(rejected).rejects.toThrow(/fixed/u);
    await expect(
      store.saveControlDraft(worldId, fiction),
    ).rejects.toBeInstanceOf(FileNativeWorldCreationError);
    expect(await store.gameplay(worldId)).toEqual({
      mode: "tabletop",
      scheme: "d100",
    });
    const saved = await store.saveControlDraft(worldId, control);
    expect(saved.fingerprint).toMatch(/^sha256:/u);
  });

  test("应用控制草稿时再次拒绝改变玩法身份，世界控制保持原样", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const request = input("package-apply", tabletopFiles("d100"));
    const created = await store.createFromContentPackage(request);
    if (created.outcome !== "created") throw new Error("world not created");
    const worldId = created.world.worldId;
    const control = await store.readSurface(worldId, "control");
    // Save rejects a scheme change, so a draft that bypassed it must still fail at apply.
    const draft = join(
      root,
      "worlds-file-native",
      worldId,
      "runtime",
      "control-draft",
    );
    await mkdir(draft, { recursive: true });
    for (const file of control) {
      const path = join(draft, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        file.path === "gameplay.json"
          ? gameplayFile({ mode: "tabletop", scheme: "bag" }).contents
          : file.contents,
      );
    }

    await expect(
      store.applyControlDraft(worldId, request.prompt),
    ).rejects.toMatchObject({ code: "candidate_validation_failed" });
    expect(await store.gameplay(worldId)).toEqual({
      mode: "tabletop",
      scheme: "d100",
    });
  });
});

function tabletopFiles(scheme: ResolutionScheme) {
  return [
    ...minimalFileNativeContentScaffold("en"),
    gameplayFile({ mode: "tabletop", scheme }),
  ];
}

function input(
  sourcePackageId: string,
  packageFiles: readonly { path: string; contents: string }[],
) {
  return {
    operationId: `create-${sourcePackageId}`,
    sourcePackageId,
    sourcePackageTitle: "Gameplay test world",
    packageFiles,
    prompt: {
      hostBinding: {
        hostPresetId: "host-1",
        files: {
          "frame.yaml": hostFrame(),
          "blocks/style.md": "# Host style\n\nRestrained and specific.\n",
        },
      },
      modelBinding: {
        provider: "chat_completions" as const,
        modelId: "test-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    },
  };
}

function hostFrame(): string {
  return `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-gameplay-worlds-"));
  roots.push(root);
  return root;
}
