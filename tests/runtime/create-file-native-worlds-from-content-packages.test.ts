import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("从内容包创建文件原生世界", () => {
  test("原样复制 state/control，原子发布 genesis，并提供四个固定表面", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "content"));
    const package_ = await workspace.createCurrentTreeContentPackage();
    await workspace.replaceCurrentTreeContentPackage(package_.localId, files());
    const source = await workspace.readCurrentTreeContentPackage(
      package_.localId,
    );
    const store = new FileNativeWorldStore(join(root, "runtime"));

    const created = await store.createFromContentPackage(
      input(source.localId, source.files),
    );

    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("world not created");
    expect(created.preview.compilation.logicalMessages).toHaveLength(4);
    expect(created.preview.leakage.status).toBe("clean");
    expect(created.world.parentEndpoint).toBe("genesis");
    expect(await store.readSurface(created.world.worldId, "state")).toEqual([
      expect.objectContaining({
        path: "characters/alex.yaml",
        contents: character(),
      }),
      expect.objectContaining({
        path: "current-situation.yaml",
        contents: currentSituation(),
      }),
    ]);
    expect(await store.readSurface(created.world.worldId, "control")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "frame.yaml", contents: frame() }),
      ]),
    );
    const history = await store.readSurface(created.world.worldId, "history");
    expect(history).toHaveLength(1);
    expect(history[0]?.path).toMatch(/narrator.*\.md$/u);
    expect(history[0]?.contents).toBe(opening());
    expect(await store.readSurface(created.world.worldId, "runtime")).toEqual(
      expect.objectContaining({
        operationId: "create-op-1",
        parentEndpoint: "genesis",
        historyEntries: 1,
        history: [
          expect.objectContaining({ role: "narrator", exactText: opening() }),
        ],
        additionalMaterials: [
          expect.objectContaining({ kind: "history_message" }),
        ],
      }),
    );
    const genesis = await store.readAuthorityEndpoint(
      created.world.worldId,
      "genesis",
    );
    expect(genesis.history).toEqual([
      { role: "narrator", exactText: opening() },
    ]);
    expect(genesis.additionalMaterials).toEqual([
      {
        kind: "history_message",
        message: "message.genesis.narrator",
      },
    ]);
    const binding = await store.bindPlayCallChain(created.world.worldId);
    expect(binding.history).toEqual({
      "message.genesis.narrator": opening(),
    });
    expect(binding.additionalMaterials).toEqual(genesis.additionalMaterials);
    const worldContext = created.preview.compilation.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(worldContext).toContain(opening().trim());
    expect(worldContext?.split(opening().trim())).toHaveLength(2);
    const previewPlayer = created.preview.compilation.logicalMessages.find(
      ({ role }) => role === "player_input",
    )?.markdown;
    expect(previewPlayer).toContain("Preview placeholder");
    expect(previewPlayer).not.toContain("Start this world");

    await workspace.replaceCurrentTreeContentPackage(package_.localId, [
      ...files().filter(
        ({ path }) =>
          path !== "world/characters/alex.yaml" && path !== "opening.md",
      ),
      { path: "world/characters/alex.yaml", contents: character("已修改") },
      { path: "opening.md", contents: "这是后来修改的开场白。\n" },
    ]);
    expect(
      await store.readSurface(created.world.worldId, "state"),
    ).toContainEqual(
      expect.objectContaining({
        path: "characters/alex.yaml",
        contents: character(),
      }),
    );
    expect(
      await store.readAuthorityEndpoint(created.world.worldId, "genesis"),
    ).toMatchObject({
      history: [{ role: "narrator", exactText: opening() }],
    });
  });

  test("同一内容包创建两个世界时保留文档身份，但不共享文件权威", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const first = await store.createFromContentPackage(
      input("package-1", files()),
    );
    const second = await store.createFromContentPackage({
      ...input("package-1", files()),
      operationId: "create-op-2",
    });
    if (first.outcome !== "created" || second.outcome !== "created") {
      throw new Error("world not created");
    }
    expect(first.world.worldId).not.toBe(second.world.worldId);
    const firstState = await store.readSurface(first.world.worldId, "state");
    const secondState = await store.readSurface(second.world.worldId, "state");
    expect(firstState).toEqual(secondState);
    expect(firstState).not.toBe(secondState);
  });

  test("创建 operation 绑定不可变内容包快照并以 state 布局重新验证文档", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const packageFiles = files();
    packageFiles.push({
      path: "state/opaque.txt",
      contents: "内容包中的非世界文档不能被 state 布局解释。\n",
    });

    const creation = store.createFromContentPackage(
      input("package-1", packageFiles),
    );
    packageFiles.find(({ path }) => path === "opening.md")!.contents =
      "调用方稍后改写的开场白。\n";
    packageFiles.find(
      ({ path }) => path === "world/characters/alex.yaml",
    )!.contents = character("调用方稍后改写的衣着");
    packageFiles.find(
      ({ path }) => path === "control/blocks/world.md",
    )!.contents = "# 调用方稍后改写的控制块\n";

    const created = await creation;
    const state = await store.readSurface(created.world.worldId, "state");
    const control = await store.readSurface(created.world.worldId, "control");
    const history = await store.readSurface(created.world.worldId, "history");
    expect(state).toContainEqual(
      expect.objectContaining({
        path: "characters/alex.yaml",
        contents: character(),
      }),
    );
    expect(control).toContainEqual(
      expect.objectContaining({
        path: "blocks/world.md",
        contents: "# World Narration Rules\n",
      }),
    );
    expect(history[0]?.contents).toBe(opening());

    const stateSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: state.map((file) => ({ ...file, path: `state/${file.path}` })),
    });
    expect(stateSnapshot.status).toBe("usable");
    expect(
      stateSnapshot.query({
        kind: "read_document",
        document: { documentId: "character.alex" },
        maxBytes: 65_536,
      }),
    ).toMatchObject({
      ok: true,
      snapshotStatus: "usable",
      document: {
        documentId: "character.alex",
        shortRef: "alex",
        logicalPath: "state/characters/alex.yaml",
      },
    });
  });

  test("待修复内容不发布半个世界，而极小窗口配置仍交给 Provider 判断", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    await expect(
      store.createFromContentPackage(
        input(
          "broken",
          files().filter(({ path }) => path !== "control/frame.yaml"),
        ),
      ),
    ).rejects.toMatchObject({ code: "content_package_needs_repair" });
    expect(await store.getCreationOutcome("create-op-1")).toEqual({
      outcome: "not_created",
    });

    await expect(
      store.createFromContentPackage(
        input(
          "missing-opening",
          files().filter(({ path }) => path !== "opening.md"),
        ),
      ),
    ).rejects.toMatchObject({ code: "content_package_needs_repair" });

    const created = await store.createFromContentPackage({
      ...input("valid", files()),
      prompt: {
        ...input("valid", files()).prompt,
        modelBinding: {
          ...input("valid", files()).prompt.modelBinding,
          contextWindowTokens: 1,
        },
      },
    });
    expect(created).toMatchObject({ outcome: "created" });
    expect(created.preview.compilation.budget).toMatchObject({
      estimator: "disabled",
      status: "not_checked",
      requiredTokens: 0,
      contextWindowTokens: 1,
    });
    expect(await store.getCreationOutcome("create-op-1")).toMatchObject({
      outcome: "created",
    });
  });

  test("并发重放同一 operation 只发布同一个完整世界，冲突载荷明确拒绝", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const source = input("package-1", files());

    const outcomes = await Promise.all([
      store.createFromContentPackage(source),
      store.createFromContentPackage(source),
    ]);
    expect(outcomes[0].world).toEqual(outcomes[1].world);
    expect(
      await store.readSurface(outcomes[0].world.worldId, "state"),
    ).toHaveLength(2);

    await expect(
      store.createFromContentPackage({
        ...source,
        packageFiles: [
          ...files().filter(
            ({ path }) => path !== "world/characters/alex.yaml",
          ),
          {
            path: "world/characters/alex.yaml",
            contents: character("冲突载荷"),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });

  test("删除世界移除它的全部存档，并拒绝删除不存在的世界", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "content"));
    const package_ = await workspace.createCurrentTreeContentPackage();
    await workspace.replaceCurrentTreeContentPackage(package_.localId, files());
    const source = await workspace.readCurrentTreeContentPackage(
      package_.localId,
    );
    const store = new FileNativeWorldStore(join(root, "runtime"));

    const first = await store.createFromContentPackage(
      input(source.localId, source.files),
    );
    const second = await store.createFromContentPackage({
      ...input(source.localId, source.files),
      operationId: "second-world-operation",
    });
    if (first.outcome !== "created" || second.outcome !== "created")
      throw new Error("world not created");
    expect(await store.listWorlds()).toHaveLength(2);

    await expect(store.deleteWorld(first.world.worldId)).resolves.toMatchObject(
      { deleted: true },
    );

    // Only the target world disappears; the other world's surfaces remain readable.
    expect((await store.listWorlds()).map(({ worldId }) => worldId)).toEqual([
      second.world.worldId,
    ]);
    expect(await store.readSurface(second.world.worldId, "state")).toHaveLength(
      2,
    );
    await expect(
      store.readSurface(first.world.worldId, "state"),
    ).rejects.toThrow();

    // Deleting the same world again reports absence instead of succeeding silently.
    await expect(store.deleteWorld(first.world.worldId)).rejects.toMatchObject({
      name: "FileNativeWorldNotFoundError",
    });
  });

  test("重命名世界后重启仍保留显示名称，且不改变身份、端点和世界表面", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage(
      input("package-1", files()),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    const beforeState = await store.readSurface(created.world.worldId, "state");
    const beforeControl = await store.readSurface(
      created.world.worldId,
      "control",
    );
    const beforeHistory = await store.readSurface(
      created.world.worldId,
      "history",
    );
    const beforeHead = await store.currentHead(created.world.worldId);

    await expect(
      store.renameWorld(created.world.worldId, "  雾港第一夜  "),
    ).resolves.toEqual({
      worldId: created.world.worldId,
      title: "雾港第一夜",
      parentEndpoint: "genesis",
    });

    const reopened = new FileNativeWorldStore(root);
    expect(await reopened.listWorlds()).toEqual([
      {
        worldId: created.world.worldId,
        title: "雾港第一夜",
        parentEndpoint: "genesis",
      },
    ]);
    expect(await reopened.getCreationOutcome("create-op-1")).toEqual({
      outcome: "created",
      world: {
        worldId: created.world.worldId,
        title: "雾港第一夜",
        parentEndpoint: "genesis",
      },
    });
    expect(await reopened.currentHead(created.world.worldId)).toBe(beforeHead);
    expect(await reopened.readSurface(created.world.worldId, "state")).toEqual(
      beforeState,
    );
    expect(
      await reopened.readSurface(created.world.worldId, "control"),
    ).toEqual(beforeControl);
    expect(
      await reopened.readSurface(created.world.worldId, "history"),
    ).toEqual(beforeHistory);
  });

  test("V1 Runtime 重命名世界并让工作区立即返回新名称", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage(
      input("package-1", files()),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    await runtime.initialize();

    await expect(
      runtime.handle({
        type: "world.rename",
        worldId: created.world.worldId,
        name: "雾港第一夜",
      }),
    ).resolves.toMatchObject({
      result: {
        worldId: created.world.worldId,
        title: "雾港第一夜",
      },
    });
    await expect(
      runtime.handle({ type: "workspace.read" }),
    ).resolves.toMatchObject({
      result: {
        worlds: [
          {
            worldId: created.world.worldId,
            title: "雾港第一夜",
          },
        ],
      },
    });
  });

  test("世界名称拒绝空白、换行和超长输入，既有名称继续可读", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage(
      input("package-1", files()),
    );
    if (created.outcome !== "created") throw new Error("world not created");

    for (const name of ["   ", "雾港\n第二夜", "界".repeat(161)])
      await expect(
        store.renameWorld(created.world.worldId, name),
      ).rejects.toThrow(
        "World name must contain 1 to 160 characters and no line breaks",
      );

    expect(await store.listWorlds()).toEqual([created.world]);
  });

  test("派生世界沿用来源当前名称，并把默认名称限制在 160 个字符内", async () => {
    const root = await temporaryRoot();
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage(
      input("package-1", files()),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    await store.renameWorld(created.world.worldId, "界".repeat(160));

    const derived = await store.deriveWorld({
      operationId: "derive-long-name",
      sourceWorldId: created.world.worldId,
      sourceHead: "genesis",
      hostPresetId: "host-1",
    });

    expect(derived.world.title).toBe(`${"界".repeat(153)} (fork)`);
    expect(Array.from(derived.world.title)).toHaveLength(160);
  });
});

function input(
  sourcePackageId: string,
  packageFiles: ReturnType<typeof files>,
) {
  return {
    operationId: "create-op-1",
    sourcePackageId,
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-file-world-"));
  roots.push(root);
  return root;
}

function files() {
  return [
    { path: "opening.md", contents: opening() },
    { path: "world/characters/alex.yaml", contents: character() },
    { path: "world/current-situation.yaml", contents: currentSituation() },
    { path: "control/frame.yaml", contents: frame() },
    { path: "control/blocks/world.md", contents: "# World Narration Rules\n" },
    { path: "control/player-views.yaml", contents: playerView() },
  ];
}

function opening(): string {
  return "宿舍门在你身后合上。Alex抱着球衣看向你，等你先开口。\n";
}

function character(note?: string): string {
  return `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: 篮球队前锋。\n  aliases: []\n衣着: ${note ?? "白色运动背心"}\n`;
}

function currentSituation(): string {
  return `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 宿舍里的当前局面。\n  aliases: []\n人物:\n  - $ref: character.alex\n`;
}

function frame(): string {
  return `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`;
}

function playerView(): string {
  return `format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 当前状态\n    items:\n      - id: clothes\n        label: 衣着\n        select: { document: character.alex, locator: { yaml: [衣着] } }\n`;
}

function hostFrame(): string {
  return `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`;
}
