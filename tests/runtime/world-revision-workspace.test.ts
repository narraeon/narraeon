import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { gameplayFile, gameplayPath } from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import {
  ScriptedModelHost,
  type ModelHostBinding,
} from "../../src/runtime/model/ModelHost.ts";
import {
  FileNativePlayPresetStore,
  toPlayPresetStructuredEditor,
  builtinDefaultPlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import {
  WorldRevisionAuthoringTransaction,
  inspectWorldRevisionFiles,
  worldRevisionRuntimeContract,
  worldRevisionToolDefinitions,
} from "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts";
import { WorldRevisionSession } from "../../src/runtime/world-revision/WorldRevisionSession.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { revisePlayerTimeline } from "./support/player-timeline-edit.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("世界修订工具只暴露 state/control，共用读取授权并拒绝 opening 与身份改写", () => {
  const files = worldRevisionFiles();
  let previewPaths: string[] = [];
  const transaction = new WorldRevisionAuthoringTransaction({
    history: { scope: "world", entries: [] },
    baseFiles: files,
    immutableBaseFiles: files,
    locale: "zh-CN",
    preview: (snapshot) => {
      previewPaths = snapshot.files.map(({ path }) => path);
      return preview;
    },
  });

  const toolDefinitions = worldRevisionToolDefinitions(
    "zh-CN",
    fictionGameplay,
  );
  expect(toolDefinitions.map(({ name }) => name)).toEqual([
    "world_revision_list",
    "world_revision_search",
    "world_revision_read",
    "world_revision_create",
    "world_revision_write_file",
    "world_revision_patch",
    "world_revision_move",
    "world_revision_delete",
    "history_list",
    "history_search",
    "history_read",
  ]);
  expect(
    [
      ...toolDefinitions,
      ...worldRevisionToolDefinitions("en", fictionGameplay),
    ].every(
      ({ description }) =>
        description.length > 0 && !/opening\.md/iu.test(description),
    ),
  ).toBe(true);
  expect(worldRevisionRuntimeContract("zh-CN", fictionGameplay)).toContain(
    "state/* 与 control/* 共同组成唯一的修订工作树",
  );
  expect(worldRevisionRuntimeContract("zh-CN", fictionGameplay)).toContain(
    "此前读取授权全部失效",
  );
  expect(worldRevisionRuntimeContract("en", fictionGameplay)).toContain(
    "existing state documents may be deleted or moved",
  );
  expect(worldRevisionRuntimeContract("zh-CN", fictionGameplay)).not.toContain(
    "不能删除或移动",
  );
  expect(worldRevisionRuntimeContract("zh-CN", fictionGameplay)).toContain(
    "history_list、history_search、history_read 只读导航",
  );
  expect(worldRevisionRuntimeContract("en", fictionGameplay)).toContain(
    "history_list, history_search and history_read only navigate",
  );

  const opening = transaction.execute([
    {
      id: "read-opening",
      name: "world_revision_read",
      arguments: { path: "opening.md" },
    },
  ])[0];
  expect(opening).toMatchObject({ isError: true, changes: [] });
  expect(opening?.markdown).toContain("opening.md");
  expect(opening?.markdown).toContain("不可变");

  const listed = transaction.execute([
    {
      id: "list-root",
      name: "world_revision_list",
      arguments: { directory: "state" },
    },
  ])[0];
  expect(listed).toMatchObject({ isError: false, changes: [] });
  expect(listed?.markdown).not.toContain("opening.md");
  expect(transaction.files().some(({ path }) => path === "opening.md")).toBe(
    false,
  );
  expect(previewPaths.every((path) => /^(?:state|control)\//u.test(path))).toBe(
    true,
  );

  const path = "state/current-situation.yaml";
  const original = files.find((file) => file.path === path)?.contents;
  expect(original).toBeTypeOf("string");
  expect(
    transaction.execute([
      {
        id: "write-without-read",
        name: "world_revision_write_file",
        arguments: {
          path,
          contents: original?.replace("地点: 未设定", "地点: 雨夜码头"),
        },
      },
    ])[0],
  ).toMatchObject({ isError: true, changes: [] });

  expect(
    transaction.execute([
      {
        id: "read-current",
        name: "world_revision_read",
        arguments: { path },
      },
      {
        id: "write-current",
        name: "world_revision_write_file",
        arguments: {
          path,
          contents: original?.replace("地点: 未设定", "地点: 雨夜码头"),
        },
      },
    ]),
  ).toMatchObject([
    { isError: false, changes: [] },
    {
      isError: false,
      changes: [{ path, kind: "modify" }],
    },
  ]);
  expect(
    transaction.files().find((file) => file.path === path)?.contents,
  ).toContain("地点: 雨夜码头");

  expect(
    transaction.execute([
      {
        id: "patch-current-by-state-path",
        name: "world_revision_patch",
        arguments: {
          document: path,
          op: "replace",
          locator: ["地点"],
          value: "潮湿栈桥",
        },
      },
    ])[0],
  ).toMatchObject({ isError: false, changes: [{ path, kind: "modify" }] });
  expect(
    transaction.execute([
      {
        id: "reject-content-package-namespace",
        name: "world_revision_read",
        arguments: { path: "world/current-situation.yaml" },
      },
    ])[0],
  ).toMatchObject({ isError: true, changes: [] });

  const currentAfterPatch = transaction
    .files()
    .find((file) => file.path === path)?.contents;
  const controlPath = "control/blocks/world.md";
  const control = transaction
    .files()
    .find((file) => file.path === controlPath)?.contents;
  if (currentAfterPatch === undefined || control === undefined)
    throw new Error("Missing authoring fixtures");
  const batched = transaction.execute([
    {
      id: "read-control-for-batch",
      name: "world_revision_read",
      arguments: { path: controlPath },
    },
    {
      id: "write-state-in-batch",
      name: "world_revision_write_file",
      arguments: {
        path,
        contents: currentAfterPatch.replace("潮湿栈桥", "钟楼广场"),
      },
    },
    {
      id: "write-control-in-batch",
      name: "world_revision_write_file",
      arguments: { path: controlPath, contents: `${control}\n保持克制。\n` },
    },
  ]);
  expect(batched[1]?.markdown).not.toContain("当前树自动检查");
  expect(batched[2]?.markdown).toContain("当前树自动检查");

  const literalFiles = files.map((file) =>
    file.path === path
      ? {
          ...file,
          contents: `${file.contents}\n说明: "content package world/example 必须保持原样"\n`,
        }
      : file,
  );
  const literalRead = new WorldRevisionAuthoringTransaction({
    history: { scope: "world", entries: [] },
    baseFiles: literalFiles,
    immutableBaseFiles: literalFiles,
    locale: "zh-CN",
    preview: () => preview,
  }).execute([
    {
      id: "read-literal-content",
      name: "world_revision_read",
      arguments: { path },
    },
  ])[0];
  expect(literalRead?.markdown).toContain(
    '说明: "content package world/example 必须保持原样"',
  );
  const literalTransaction = new WorldRevisionAuthoringTransaction({
    history: { scope: "world", entries: [] },
    baseFiles: literalFiles.map((file) =>
      file.path === "control/blocks/world.md"
        ? {
            ...file,
            contents: `${file.contents}\ncontent package world/control 也必须保持原样\n`,
          }
        : file,
    ),
    immutableBaseFiles: literalFiles,
    locale: "zh-CN",
    preview: () => preview,
  });
  const [literalSearch, literalControl] = literalTransaction.execute([
    {
      id: "search-literal-content",
      name: "world_revision_search",
      arguments: { query: "content package" },
    },
    {
      id: "read-literal-control",
      name: "world_revision_read",
      arguments: { path: "control/blocks/world.md" },
    },
  ]);
  expect(literalSearch?.markdown).toContain(
    "content package world/example 必须保持原样",
  );
  expect(literalControl?.markdown).toContain(
    "content package world/control 也必须保持原样",
  );

  const identityChanged = files.map((file) =>
    file.path === path
      ? {
          ...file,
          contents: file.contents.replace(
            "id: situation.current",
            "id: situation.replaced",
          ),
        }
      : file,
  );
  expect(inspectWorldRevisionFiles(identityChanged, files)).toMatchObject({
    status: "needs_repair",
    diagnostics: [
      expect.objectContaining({
        code: "existing_state_identity_changed",
        path,
      }),
    ],
  });
});

test("世界修订可以删除与移动无引用的既有状态文档，检查层保持 usable", () => {
  const base = seededRevisionBase();
  const transaction = new WorldRevisionAuthoringTransaction({
    baseFiles: base,
    immutableBaseFiles: base,
    locale: "zh-CN",
    preview: () => preview,
  });
  const [readOld, deleteOld, readPlace, movePlace] = transaction.execute([
    {
      id: "read-old",
      name: "world_revision_read",
      arguments: { path: "@oldnpc" },
    },
    {
      id: "delete-old",
      name: "world_revision_delete",
      arguments: { document: "@oldnpc" },
    },
    {
      id: "read-place",
      name: "world_revision_read",
      arguments: { path: "@place" },
    },
    {
      id: "move-place",
      name: "world_revision_move",
      arguments: { from: "@place", to: "state/places/dock.yaml" },
    },
  ]);
  expect(readOld).toMatchObject({ isError: false });
  expect(deleteOld).toMatchObject({ isError: false });
  expect(readPlace).toMatchObject({ isError: false });
  expect(movePlace).toMatchObject({ isError: false });
  const files = transaction.files();
  expect(files.some(({ path }) => path === "state/npc/old.yaml")).toBe(false);
  expect(files.some(({ path }) => path === "state/place.yaml")).toBe(false);
  expect(files.some(({ path }) => path === "state/places/dock.yaml")).toBe(
    true,
  );
  expect(inspectWorldRevisionFiles(files, base)).toMatchObject({
    status: "usable",
    diagnostics: [],
  });
});

test("世界修订删除仍被引用的文档时逐条列出全部阻挡位置，手动删除同样给出诊断", () => {
  const base = seededRevisionBase();
  const transaction = new WorldRevisionAuthoringTransaction({
    baseFiles: base,
    immutableBaseFiles: base,
    locale: "zh-CN",
    preview: () => preview,
  });
  const [read, deleted] = transaction.execute([
    {
      id: "read-situation",
      name: "world_revision_read",
      arguments: { path: "@current-situation" },
    },
    {
      id: "delete-situation",
      name: "world_revision_delete",
      arguments: { document: "@current-situation" },
    },
  ]);
  expect(read).toMatchObject({ isError: false });
  expect(deleted).toMatchObject({ isError: true });
  expect(deleted?.markdown).toContain(
    "control/frame.yaml · bindings.currentSituation",
  );

  const manual = base.filter(
    ({ path }) => path !== "state/current-situation.yaml",
  );
  const manualInspection = inspectWorldRevisionFiles(manual, base);
  expect(manualInspection.status).toBe("needs_repair");
  const blocked = manualInspection.diagnostics.find(
    ({ code }) => code === "existing_state_delete_blocked",
  );
  expect(blocked).toMatchObject({ path: "state/current-situation.yaml" });
  expect(blocked?.message).toContain(
    "control/frame.yaml · bindings.currentSituation",
  );
});

test("其他文档的 $ref 同样阻挡删除，手动删除也逐条列出阻挡位置", () => {
  const base = seededRevisionBase();
  const seed = new WorldRevisionAuthoringTransaction({
    baseFiles: base,
    immutableBaseFiles: base,
    locale: "zh-CN",
    preview: () => preview,
  });
  const [created] = seed.execute([
    {
      id: "create-holder",
      name: "world_revision_create",
      arguments: {
        path: "state/holder.yaml",
        ref: "holder",
        title: "持有者",
        summary: "引用旧商人的文档。",
        aliases: [],
        body: "merchant:\n  $ref: '@oldnpc'\n",
      },
    },
  ]);
  expect(created).toMatchObject({ isError: false });
  const withHolder = seed.files();
  const transaction = new WorldRevisionAuthoringTransaction({
    baseFiles: withHolder,
    immutableBaseFiles: withHolder,
    locale: "zh-CN",
    preview: () => preview,
  });
  const [read, deleted] = transaction.execute([
    {
      id: "read-old",
      name: "world_revision_read",
      arguments: { path: "@oldnpc" },
    },
    {
      id: "delete-old",
      name: "world_revision_delete",
      arguments: { document: "@oldnpc" },
    },
  ]);
  expect(read).toMatchObject({ isError: false });
  expect(deleted).toMatchObject({ isError: true });
  expect(deleted?.markdown).toContain("state/holder.yaml");

  const manual = withHolder.filter(({ path }) => path !== "state/npc/old.yaml");
  const manualInspection = inspectWorldRevisionFiles(manual, withHolder);
  expect(manualInspection.status).toBe("needs_repair");
  const blocked = manualInspection.diagnostics.find(
    ({ code }) => code === "existing_state_delete_blocked",
  );
  expect(blocked).toMatchObject({ path: "state/npc/old.yaml" });
  expect(blocked?.message).toContain("state/holder.yaml");
});

test("持久修订锁阻止游玩与其他写入，重启后仍由同一 epoch 恢复", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const opened = await workspace.open(worldId);

  expect(await worlds.readWorldRevisionLock(worldId)).toEqual({
    worldId,
    epochId: opened.epochId,
  });
  await expect(
    worlds.commitPlayStep({
      operationId: "play-while-revising",
      worldId,
      parentHead: "genesis",
      historyAppend: [{ role: "player", exactText: "继续前进" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(
    worlds.saveControlDraft(worldId, [
      {
        path: "player-views.yaml",
        contents: "format: narraeon.player-views/v1\nviews: []\n",
      },
    ]),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(
    worlds.applyControlDraft(worldId, prompt()),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(
    revisePlayerTimeline(worlds, {
      operationId: "timeline-while-revising",
      worldId,
      expectedCurrentHead: "genesis",
      restoresHead: "genesis",
      replacesHead: "commit:1",
      replacementText: "改写行动",
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(
    worlds.deriveWorld({
      operationId: "derive-while-revising",
      sourceWorldId: worldId,
      sourceHead: "genesis",
      hostPresetId: "revision-test-host",
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(worlds.deleteWorld(worldId)).rejects.toMatchObject({
    name: "WorldOperationBusyError",
  });
  await expect(
    worlds.operations.claimCorrectionWorld(
      worldId,
      "correction-while-revising",
      () => Promise.resolve(null),
    ),
  ).resolves.toEqual({ kind: "busy" });
  await expect(
    worlds.renameWorld(worldId, "只改本地名称"),
  ).resolves.toMatchObject({
    title: "只改本地名称",
  });

  const recoveredWorlds = new FileNativeWorldStore(root);
  const recovered = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(root),
    worlds: recoveredWorlds,
  });
  expect((await recovered.open(worldId)).epochId).toBe(opened.epochId);

  await recovered.discard({ worldId, epochId: opened.epochId });
  expect(await recoveredWorlds.readWorldRevisionLock(worldId)).toBeNull();
  expect(await recoveredWorlds.currentHead(worldId)).toBe("genesis");
});

test("修订持久记录遇到未知字段时 fail closed", async () => {
  const { root, worldId, workspace } = await createdWorld();
  const epoch = await workspace.open(worldId);
  const path = join(root, "world-revisions", "epochs", `${epoch.epochId}.json`);
  const stored = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  stored.unknownField = true;
  await writeFile(path, `${JSON.stringify(stored)}\n`, "utf8");

  await expect(
    new FileNativeWorldRevisionStore(root).readEpoch(epoch.epochId),
  ).rejects.toThrow(/durable schema/u);

  delete stored.unknownField;
  stored.baseControlFingerprint = `sha256:${"0".repeat(64)}`;
  await writeFile(path, `${JSON.stringify(stored)}\n`, "utf8");
  await expect(
    new FileNativeWorldRevisionStore(root).readEpoch(epoch.epochId),
  ).rejects.toThrow(/durable schema/u);
});

test("手动与 AI 可共用工作树，逐文件回滚最后一次修改后整批应用 state/control", async () => {
  const { worldId, worlds, workspace } = await createdWorld();
  let epoch = await workspace.open(worldId);
  const statePath = "state/current-situation.yaml";
  const controlPath = "control/blocks/world.md";

  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: replaceContents(epoch.files, statePath, (contents) =>
      contents.replace("地点: 未设定", "地点: 青石桥"),
    ),
  });
  const firstChange = epoch.changes.at(-1);
  expect(firstChange).toMatchObject({ source: "manual" });

  const controlFiles = replaceContents(
    epoch.files,
    controlPath,
    (contents) => `${contents}\n只使用简短段落。\n`,
  );
  const afterControlRevision = contentTreeFingerprint(controlFiles);
  epoch = await workspace.publishAi({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    afterRevision: afterControlRevision,
    files: controlFiles,
    toolResults: [
      {
        toolCallId: "ai-control",
        markdown: "updated",
        isError: false,
        changeSetId: "change-set:00000000-0000-4000-8000-000000000001",
        changes: [
          {
            path: controlPath,
            kind: "modify",
            before:
              epoch.files.find((file) => file.path === controlPath)?.contents ??
              null,
            after:
              controlFiles.find((file) => file.path === controlPath)
                ?.contents ?? null,
          },
        ],
      },
    ],
  });
  expect(epoch.changes.at(-1)).toMatchObject({ source: "ai" });

  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: replaceContents(epoch.files, statePath, (contents) =>
      contents.replace("地点: 青石桥", "地点: 黑塔"),
    ),
  });
  const lastChange = epoch.changes.at(-1);
  if (lastChange === undefined) throw new Error("Expected a third change set");

  const rollback = await workspace.rollback({
    worldId,
    epochId: epoch.epochId,
    changeSetId: lastChange.changeSetId,
    path: statePath,
  });
  expect(rollback).toMatchObject({
    status: "rolled_back",
    path: statePath,
  });
  expect(rollback.changes[0]?.before).toContain("地点: 黑塔");
  epoch = rollback.epoch;
  expect(
    epoch.files.find((file) => file.path === statePath)?.contents,
  ).toContain("地点: 青石桥");
  expect(
    epoch.files.find((file) => file.path === controlPath)?.contents,
  ).toContain("只使用简短段落。");
  expect(firstChange?.changeSetId).not.toBe(lastChange.changeSetId);

  const applied = await workspace.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  expect(applied).toMatchObject({
    lifecycle: "applied",
    apply: { phase: "committed", committedHead: "commit:1" },
  });
  expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();
  expect(await worlds.currentHead(worldId)).toBe("commit:1");
  expect(
    (await worlds.readSurface(worldId, "state")).find(
      (file) => file.path === "current-situation.yaml",
    )?.contents,
  ).toContain("地点: 青石桥");
  expect(
    (await worlds.readSurface(worldId, "control")).find(
      (file) => file.path === "blocks/world.md",
    )?.contents,
  ).toContain("只使用简短段落。");
});

test("应用含删除与移动的修订后世界文件随之变化，回退到应用前端点可恢复被删文件", async () => {
  const { worldId, worlds, workspace } = await createdWorld();
  let epoch = await workspace.open(worldId);
  const seeded = seededRevisionBase();
  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: seeded,
  });
  epoch = await workspace.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  expect(epoch).toMatchObject({ lifecycle: "applied" });
  const beforeDeletion = await worlds.currentHead(worldId);
  expect(
    (await worlds.readSurface(worldId, "state")).some(
      (file) => file.path === "npc/old.yaml",
    ),
  ).toBe(true);

  const transaction = new WorldRevisionAuthoringTransaction({
    baseFiles: seeded,
    immutableBaseFiles: seeded,
    locale: "zh-CN",
    preview: () => preview,
  });
  const edited = transaction.execute([
    {
      id: "read-old",
      name: "world_revision_read",
      arguments: { path: "@oldnpc" },
    },
    {
      id: "delete-old",
      name: "world_revision_delete",
      arguments: { document: "@oldnpc" },
    },
    {
      id: "read-place",
      name: "world_revision_read",
      arguments: { path: "@place" },
    },
    {
      id: "move-place",
      name: "world_revision_move",
      arguments: { from: "@place", to: "state/places/dock.yaml" },
    },
  ]);
  expect(edited.every(({ isError }) => !isError)).toBe(true);
  epoch = await workspace.open(worldId);
  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: transaction.files(),
  });
  epoch = await workspace.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  expect(epoch).toMatchObject({ lifecycle: "applied" });
  const afterDeletion = await worlds.currentHead(worldId);
  expect(afterDeletion).not.toBe(beforeDeletion);
  const appliedState = await worlds.readSurface(worldId, "state");
  expect(appliedState.some(({ path }) => path === "npc/old.yaml")).toBe(false);
  expect(appliedState.some(({ path }) => path === "place.yaml")).toBe(false);
  expect(
    appliedState.find(({ path }) => path === "places/dock.yaml")?.contents,
  ).toContain("id: place.dock");

  await worlds.rewindPlayerRevision(worldId, beforeDeletion);
  const restored = (await worlds.readSurface(worldId, "state")).find(
    (file) => file.path === "npc/old.yaml",
  );
  expect(restored?.contents).toContain("旧商人");
});

test("玩法身份在世界修订中只能保持不变，持久化的修订往返后仍原样应用", async () => {
  const tabletop = [
    ...minimalFileNativeContentScaffold("zh-CN"),
    gameplayFile({ mode: "tabletop", scheme: "d20" }),
  ];
  const { worldId, worlds, workspace } = await createdWorld(tabletop);
  const d20 = gameplayFile({ mode: "tabletop", scheme: "d20" }).contents;
  const d100 = gameplayFile({ mode: "tabletop", scheme: "d100" }).contents;
  let epoch = await workspace.open(worldId);
  expect(epoch.files).toContainEqual(
    expect.objectContaining({ path: gameplayPath, contents: d20 }),
  );

  await expect(
    workspace.replace({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files: replaceContents(epoch.files, gameplayPath, () => d100),
    }),
  ).rejects.toThrow(/fixed/u);
  await expect(
    workspace.replace({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files: epoch.files.filter(({ path }) => path !== gameplayPath),
    }),
  ).rejects.toThrow(/fixed/u);

  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: replaceContents(
      epoch.files,
      "state/current-situation.yaml",
      (contents) => contents.replace("地点: 未设定", "地点: 青石桥"),
    ),
  });
  const reopened = await workspace.open(worldId);
  expect(reopened.epochId).toBe(epoch.epochId);
  expect(reopened.files).toContainEqual(
    expect.objectContaining({ path: gameplayPath, contents: d20 }),
  );

  const applied = await workspace.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  expect(applied).toMatchObject({ lifecycle: "applied" });
  expect(await worlds.readSurface(worldId, "control")).toContainEqual({
    path: "gameplay.json",
    contents: d20,
  });
  expect(await worlds.gameplay(worldId)).toEqual({
    mode: "tabletop",
    scheme: "d20",
  });
});

test("世界修订工具写入玩法文件时只接受模式与方案都不变的内容", () => {
  const files = [
    ...worldRevisionFiles(),
    gameplayFile({ mode: "tabletop", scheme: "d20" }),
  ];
  const transaction = new WorldRevisionAuthoringTransaction({
    history: { scope: "world", entries: [] },
    baseFiles: files,
    immutableBaseFiles: files,
    locale: "en",
    preview: () => preview,
  });

  const [read, switched, unchanged] = transaction.execute([
    {
      id: "read-gameplay",
      name: "world_revision_read",
      arguments: { path: gameplayPath },
    },
    {
      id: "switch-scheme",
      name: "world_revision_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "tabletop", scheme: "d100" }).contents,
      },
    },
    {
      id: "same-scheme",
      name: "world_revision_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
      },
    },
  ]);

  expect(read?.isError).toBe(false);
  expect(switched).toMatchObject({ isError: true, changes: [] });
  expect(switched?.markdown).toMatch(/fixed/u);
  expect(unchanged?.isError).toBe(false);
  expect(
    inspectWorldRevisionFiles(
      files.map((file) =>
        file.path === gameplayPath
          ? {
              ...file,
              contents: gameplayFile({ mode: "tabletop", scheme: "bag" })
                .contents,
            }
          : file,
      ),
      files,
    ).diagnostics,
  ).toEqual([
    expect.objectContaining({
      code: "gameplay_change_forbidden",
      path: gameplayPath,
    }),
  ]);
});

test("空修订只解锁，仅 control 变化也只推进一次 Authority", async () => {
  const { worldId, worlds, workspace } = await createdWorld();
  const empty = await workspace.open(worldId);
  await expect(
    workspace.apply({
      worldId,
      epochId: empty.epochId,
      expectedRevision: empty.revision,
    }),
  ).resolves.toMatchObject({
    lifecycle: "applied",
    apply: { committedHead: "genesis" },
  });
  expect(await worlds.currentHead(worldId)).toBe("genesis");
  expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();

  let controlOnly = await workspace.open(worldId);
  const stateBefore = await worlds.readSurface(worldId, "state");
  controlOnly = await workspace.replace({
    worldId,
    epochId: controlOnly.epochId,
    expectedRevision: controlOnly.revision,
    files: replaceContents(
      controlOnly.files,
      "control/blocks/world.md",
      (contents) => `${contents}\n只修订控制。\n`,
    ),
  });
  const applied = await workspace.apply({
    worldId,
    epochId: controlOnly.epochId,
    expectedRevision: controlOnly.revision,
  });
  expect(applied.apply?.committedHead).toBe("commit:1");
  expect(await worlds.currentHead(worldId)).toBe("commit:1");
  expect(await worlds.readSurface(worldId, "state")).toEqual(stateBefore);
  expect(
    (await worlds.readSurface(worldId, "control")).find(
      ({ path }) => path === "blocks/world.md",
    )?.contents,
  ).toContain("只修订控制。");
});

test("应用前的真实预览失败会保留工作树和修订锁", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const host = new ScriptedModelHost({ binding: modelBinding, steps: [] });
  const service = new WorldRevisionSession({
    store: new FileNativeWorldRevisionStore(root),
    workspace,
    worlds,
    compiler: new FileNativePromptCompiler({ locale: "zh-CN" }),
    locale: () => "zh-CN",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: () => Promise.resolve(host),
    bindPlayPreset: () =>
      Promise.resolve(builtinDefaultPlayPresetBinding("zh-CN")),
    preview: () => {
      throw new Error("preview rejected the revision");
    },
  });
  const opened = await service.open(worldId);
  const initial = opened.epoch;
  if (initial === null) throw new Error("Expected an active revision epoch");
  const statePath = "state/current-situation.yaml";
  const changed = await service.replaceFiles({
    worldId,
    epochId: initial.epochId,
    expectedRevision: initial.revision,
    files: replaceContents(initial.files, statePath, (contents) =>
      contents.replace("地点: 未设定", "地点: 预览失败的桥"),
    ),
  });
  const epoch = changed.epoch;
  if (epoch === null) throw new Error("Expected the changed revision epoch");

  await expect(
    service.apply({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
    }),
  ).rejects.toThrow("preview rejected the revision");
  expect(await worlds.readWorldRevisionLock(worldId)).toEqual({
    worldId,
    epochId: epoch.epochId,
  });
  expect(await worlds.currentHead(worldId)).toBe("genesis");
  expect((await workspace.active(worldId))?.lifecycle).toBe("active");

  const discarded = await service.discard({
    worldId,
    epochId: epoch.epochId,
  });
  expect(discarded.sealedEpochs[0]).toMatchObject({
    epochId: epoch.epochId,
    lifecycle: "discarded",
  });
});

test("世界修订对话达到调用上限后暂停，可在同一修订中继续，修订结束后拒绝继续", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const reads = (prefix: string) =>
    Array.from({ length: 64 }, (_, index) => ({
      outcome: "response" as const,
      toolCalls: [
        {
          id: `${prefix}-${index}`,
          name: "world_revision_read",
          arguments: { path: "state/current-situation.yaml" },
        },
      ],
    }));
  const host = new ScriptedModelHost({
    binding: modelBinding,
    steps: [
      ...reads("first-read"),
      { outcome: "response", text: "继续后完成。", toolCalls: [] },
      ...reads("second-read"),
    ],
  });
  const service = new WorldRevisionSession({
    store: new FileNativeWorldRevisionStore(root),
    workspace,
    worlds,
    compiler: new FileNativePromptCompiler({ locale: "zh-CN" }),
    locale: () => "zh-CN",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: () => Promise.resolve(host),
    bindPlayPreset: () =>
      Promise.resolve(builtinDefaultPlayPresetBinding("zh-CN")),
    preview: () => preview,
  });

  const paused = await service.send({
    worldId,
    requestId: "long-world-revision",
    message: "反复检查当前局面。",
    continuation: { kind: "fresh_context" },
  });
  expect(paused).toMatchObject({ runStatus: "paused", lastFailure: null });

  const resumed = await service.resume({
    worldId,
    sessionId: paused.sessionId,
    requestId: "resume-world-revision",
  });
  expect(resumed.runStatus).toBe("ready");
  expect(host.requests.at(-1)?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "first-read-63",
  });
  expect(resumed.messages.map(({ role }) => role)).toEqual([
    "user",
    "assistant",
  ]);

  const pausedAgain = await service.send({
    worldId,
    requestId: "second-long-world-revision",
    message: "再检查一遍。",
    continuation: { kind: "continue_context", sessionId: paused.sessionId },
  });
  expect(pausedAgain.runStatus).toBe("paused");
  const epoch = await workspace.active(worldId);
  if (epoch === null) throw new Error("Expected an active revision");
  await service.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  await expect(
    service.resume({
      worldId,
      sessionId: paused.sessionId,
      requestId: "resume-after-apply",
    }),
  ).rejects.toThrow("no longer active");
});

test("AI 对话写入同一工作树，应用后继续原对话会收到新 epoch 并强制重新读取", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const source = worldRevisionFiles().find(
    ({ path }) => path === "state/current-situation.yaml",
  )?.contents;
  if (source === undefined)
    throw new Error("Missing current situation fixture");
  const host = new ScriptedModelHost({
    binding: modelBinding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-current-first-epoch",
            name: "world_revision_read",
            arguments: { path: "state/current-situation.yaml" },
          },
          {
            id: "write-current-first-epoch",
            name: "world_revision_write_file",
            arguments: {
              path: "state/current-situation.yaml",
              contents: source.replace("地点: 未设定", "地点: 第一座桥"),
            },
          },
        ],
      },
      { outcome: "response", text: "第一轮修订完成。", toolCalls: [] },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "stale-write-after-apply",
            name: "world_revision_write_file",
            arguments: {
              path: "state/current-situation.yaml",
              contents: source.replace("地点: 未设定", "地点: 越权写入"),
            },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "reread-after-apply",
            name: "world_revision_read",
            arguments: { path: "state/current-situation.yaml" },
          },
          {
            id: "write-after-reread",
            name: "world_revision_write_file",
            arguments: {
              path: "state/current-situation.yaml",
              contents: source.replace("地点: 未设定", "地点: 第二座桥"),
            },
          },
        ],
      },
      { outcome: "response", text: "第二轮修订完成。", toolCalls: [] },
    ],
  });
  const revisionStore = new FileNativeWorldRevisionStore(root);
  const service = new WorldRevisionSession({
    store: revisionStore,
    workspace,
    worlds,
    compiler: new FileNativePromptCompiler({ locale: "zh-CN" }),
    locale: () => "zh-CN",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: (saved) => {
      expect(saved).toEqual(modelBinding);
      return Promise.resolve(host);
    },
    bindPlayPreset: () =>
      Promise.resolve(builtinDefaultPlayPresetBinding("zh-CN")),
    preview: () => preview,
  });

  const first = await service.send({
    worldId,
    requestId: "first-world-revision-message",
    message: "把地点改到第一座桥。",
    continuation: { kind: "fresh_context" },
  });
  expect(first.turns[0]?.exchanges[0]?.toolCalls).toMatchObject([
    { callId: "read-current-first-epoch", result: { isError: false } },
    {
      callId: "write-current-first-epoch",
      result: {
        isError: false,
        changes: [
          {
            path: "state/current-situation.yaml",
          },
        ],
      },
    },
  ]);
  expect(
    first.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changes[0]?.after,
  ).toContain("地点: 第一座桥");
  let epoch = await workspace.active(worldId);
  if (epoch === null) throw new Error("Expected an active first epoch");
  expect(
    epoch.files.find(({ path }) => path === "state/current-situation.yaml")
      ?.contents,
  ).toContain("地点: 第一座桥");
  expect(
    (await worlds.readSurface(worldId, "state")).find(
      ({ path }) => path === "current-situation.yaml",
    )?.contents,
  ).toContain("地点: 未设定");

  const firstEpochId = epoch.epochId;
  await service.apply({
    worldId,
    epochId: firstEpochId,
    expectedRevision: epoch.revision,
  });
  const duplicate = await service.send({
    worldId,
    requestId: "first-world-revision-message",
    message: "把地点改到第一座桥。",
    continuation: { kind: "fresh_context" },
  });
  expect(duplicate.sessionId).toBe(first.sessionId);
  expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();

  const second = await service.send({
    worldId,
    requestId: "second-world-revision-message",
    message: "继续改到第二座桥。",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  epoch = await workspace.active(worldId);
  if (epoch === null) throw new Error("Expected an active second epoch");
  expect(epoch.epochId).not.toBe(firstEpochId);
  const promptDelta = host.requests
    .at(2)
    ?.appended.find(({ kind }) => kind === "prompt_delta");
  expect(promptDelta).toMatchObject({ kind: "prompt_delta" });
  expect(
    promptDelta?.kind === "prompt_delta"
      ? promptDelta.logicalMessages[0]?.markdown
      : "",
  ).toContain("此前全部 list/search cursor");
  expect(second.turns[1]?.exchanges[0]?.toolCalls[0]).toMatchObject({
    callId: "stale-write-after-apply",
    result: { isError: true, changes: [] },
  });
  expect(second.turns[1]?.exchanges[1]?.toolCalls).toMatchObject([
    { callId: "reread-after-apply", result: { isError: false } },
    {
      callId: "write-after-reread",
      result: { isError: false },
    },
  ]);
  expect(
    epoch.files.find(({ path }) => path === "state/current-situation.yaml")
      ?.contents,
  ).toContain("地点: 第二座桥");
  expect((await service.overview(worldId)).sealedEpochs[0]).toMatchObject({
    epochId: firstEpochId,
    lifecycle: "applied",
    appliedHead: "commit:1",
  });
});

test("世界修订预览保留检查点与增长基准，应用记录显式世界时间", async () => {
  const files = minimalFileNativeContentScaffold("zh-CN").map((file) => ({
    ...file,
    contents:
      file.path === "world/current-situation.yaml"
        ? `${file.contents}时间: 第1天08:00\n`
        : file.path === "control/frame.yaml"
          ? `${file.contents}\nmaintenance:\n  clock: { document: '@current-situation', locator: { yaml: [时间] } }\n`
          : file.contents,
  }));
  const { root, worlds, worldId, workspace } = await createdWorld(files);
  const checkpoint = await worlds.commitPlayStep({
    operationId: "revision-checkpoint",
    worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "检查点前的输入。" },
      { role: "narrator", exactText: "检查点前的叙事。" },
    ],
    nextMaterials: [],
    stateChanges: [],
    narrativeCheckpoint: {
      contextId: "revision-checkpoint-context",
      completedPlayerRounds: 1,
    },
  });
  await worlds.commitPlayStep({
    operationId: "revision-after-checkpoint",
    worldId,
    parentHead: checkpoint.head,
    historyAppend: [
      { role: "player", exactText: "检查点后的输入。" },
      { role: "narrator", exactText: "检查点后的叙事。" },
    ],
    nextMaterials: [],
    stateChanges: [],
  });
  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  await runtime.handle({
    type: "model.save",
    connection: {
      name: "Revision integration model",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      modelId: modelBinding.modelId,
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
    },
  });
  const host = new ScriptedModelHost({
    binding: modelBinding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-clock",
            name: "world_revision_read",
            arguments: { path: "state/current-situation.yaml" },
          },
          {
            id: "patch-clock",
            name: "world_revision_patch",
            arguments: {
              document: "@current-situation",
              op: "replace",
              locator: ["时间"],
              value: "第2天08:00",
            },
          },
        ],
      },
      { outcome: "response", text: "已修订工作树中的时间，等待应用。" },
    ],
  });
  const exchange = vi
    .spyOn(FileNativeModelHost.prototype, "exchange")
    .mockImplementation((request, observer) =>
      host.exchange(request, observer),
    );
  const previews = vi.spyOn(FileNativePromptCompiler.prototype, "preview");
  try {
    const response = await runtime.handle({
      type: "world.revision.message",
      worldId,
      requestId: "revision-clock-message",
      continuation: { kind: "fresh_context" },
      message: "将世界时间修正为第2天08:00。",
    });
    expect(response.result).toMatchObject({ runStatus: "ready" });
    const inspected = previews.mock.results.at(-1);
    if (inspected?.type !== "return") throw new Error("Preview did not return");
    const compilation = inspected.value.compilation;
    const materials = compilation.logicalMessages
      .filter(({ role }) => role === "world_context")
      .map(({ markdown }) => markdown)
      .join("\n");
    expect(materials).toContain("检查点后的叙事。");
    expect(materials).not.toContain("检查点前的叙事。");
    expect(compilation.maintenance?.documents).toContainEqual(
      expect.objectContaining({
        shortRef: "current-situation",
        baselineKind: "world_origin",
      }),
    );
    const epoch = await workspace.active(worldId);
    if (epoch === null) throw new Error("Missing active revision");
    expect(
      epoch.files.find(({ path }) => path === "state/current-situation.yaml")
        ?.contents,
    ).toContain("时间: 第2天08:00");
    const diagnosticFailure = vi
      .spyOn(FileNativeWorldStore.prototype, "readDocumentMaintenance")
      .mockRejectedValue(new Error("maintenance unavailable"));
    try {
      await runtime.handle({
        type: "world.revision.apply",
        worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
      });
      const degraded = previews.mock.results.at(-1);
      expect(
        degraded?.type === "return"
          ? degraded.value.compilation.maintenance?.unavailableReason
          : null,
      ).toBe("maintenance unavailable");
    } finally {
      diagnosticFailure.mockRestore();
    }
    expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();
    const facts = await new FileNativeWorldStore(root).readDocumentMaintenance(
      worldId,
    );
    expect(facts["current-situation"]?.lastBodyWrite).toMatchObject({
      kind: "correction",
      worldTime: "第2天08:00",
    });
  } finally {
    exchange.mockRestore();
    previews.mockRestore();
  }
});

test("世界修订对话可只读导航已提交历史，历史调用不改变工作树、改动历史或读取授权", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const source = worldRevisionFiles().find(
    ({ path }) => path === "state/current-situation.yaml",
  )?.contents;
  if (source === undefined)
    throw new Error("Missing current situation fixture");
  const committed = await worlds.commitPlayStep({
    operationId: "history-turn-1",
    worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "我踹开码头的门。" },
      { role: "narrator", exactText: "门后那封信藏着码头的密码。" },
    ],
    nextMaterials: [],
    stateChanges: [],
  });
  await worlds.commitPlayStep({
    operationId: "history-turn-2",
    worldId,
    parentHead: committed.head,
    historyAppend: [
      { role: "player", exactText: "我读完信，记下密码。" },
      { role: "narrator", exactText: "密码与码头的潮汐表吻合。" },
    ],
    nextMaterials: [],
    stateChanges: [],
  });
  const host = new ScriptedModelHost({
    binding: modelBinding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          { id: "history-list", name: "history_list", arguments: {} },
          {
            id: "history-search",
            name: "history_search",
            arguments: { queries: ["密码"] },
          },
          {
            id: "history-read",
            name: "history_read",
            arguments: { latest: 2 },
          },
          {
            id: "read-situation",
            name: "world_revision_read",
            arguments: { path: "state/current-situation.yaml" },
          },
        ],
      },
      { outcome: "response", text: "已核对历史。", toolCalls: [] },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "history-read-mixed",
            name: "history_read",
            arguments: { latest: 1 },
          },
          {
            id: "write-situation",
            name: "world_revision_write_file",
            arguments: {
              path: "state/current-situation.yaml",
              contents: source.replace("地点: 未设定", "地点: 码头"),
            },
          },
        ],
      },
      { outcome: "response", text: "修订完成。", toolCalls: [] },
    ],
  });
  const service = new WorldRevisionSession({
    store: new FileNativeWorldRevisionStore(root),
    workspace,
    worlds,
    compiler: new FileNativePromptCompiler({ locale: "zh-CN" }),
    locale: () => "zh-CN",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: () => Promise.resolve(host),
    bindPlayPreset: () =>
      Promise.resolve(builtinDefaultPlayPresetBinding("zh-CN")),
    preview: () => preview,
  });

  const opened = await workspace.open(worldId);
  const first = await service.send({
    worldId,
    requestId: "history-world-revision-message",
    message: "核对码头的密码后再修改地点。",
    continuation: { kind: "fresh_context" },
  });
  const [list, search, read, reread] =
    first.turns[0]?.exchanges[0]?.toolCalls ?? [];
  expect(list).toMatchObject({
    callId: "history-list",
    result: { isError: false, changes: [], changeSetId: null },
  });
  expect(list?.result?.markdown).toContain("@history-message-");
  expect(search).toMatchObject({
    callId: "history-search",
    result: { isError: false, changes: [], changeSetId: null },
  });
  expect(search?.result?.markdown).toContain("密码");
  expect(read).toMatchObject({
    callId: "history-read",
    result: { isError: false, changes: [], changeSetId: null },
  });
  expect(read?.result?.markdown).toContain("密码与码头的潮汐表吻合。");
  expect(reread).toMatchObject({
    callId: "read-situation",
    result: { isError: false, changeSetId: null },
  });
  const afterHistory = await workspace.active(worldId);
  expect(afterHistory).toMatchObject({
    epochId: opened.epochId,
    revision: opened.revision,
    changes: [],
  });

  const mixed = await service.send({
    worldId,
    requestId: "mixed-world-revision-message",
    message: "把地点改到码头。",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  const [historyRead, write] = mixed.turns[1]?.exchanges[0]?.toolCalls ?? [];
  expect(historyRead).toMatchObject({
    callId: "history-read-mixed",
    result: { isError: false, changes: [], changeSetId: null },
  });
  expect(historyRead?.result?.markdown).toContain("密码与码头的潮汐表吻合。");
  expect(write).toMatchObject({
    callId: "write-situation",
    result: {
      isError: false,
      changes: [{ path: "state/current-situation.yaml" }],
    },
  });
  expect(write?.result?.changeSetId).not.toBeNull();
  const epoch = await workspace.active(worldId);
  expect(epoch?.revision).not.toBe(opened.revision);
  expect(epoch?.changes).toHaveLength(1);
  expect(epoch?.changes[0]?.changes.map(({ path }) => path)).toEqual([
    "state/current-situation.yaml",
  ]);
  expect(
    epoch?.files.find(({ path }) => path === "state/current-situation.yaml")
      ?.contents,
  ).toContain("地点: 码头");
});

async function createdWorld(
  packageFiles = minimalFileNativeContentScaffold("zh-CN"),
) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-revision-"));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const created = await worlds.createFromContentPackage({
    operationId: `create-${roots.length}`,
    sourcePackageId: "revision-package",
    sourcePackageTitle: "Revision test world",
    packageFiles,
    prompt: prompt(),
  });
  return {
    root,
    worlds,
    worldId: created.world.worldId,
    workspace: new WorldRevisionWorkspace({
      store: new FileNativeWorldRevisionStore(root),
      worlds,
    }),
  };
}

function worldRevisionFiles() {
  return minimalFileNativeContentScaffold("zh-CN")
    .filter(({ path }) => path !== "opening.md")
    .map((file) => ({
      ...file,
      path: file.path.startsWith("world/")
        ? `state/${file.path.slice("world/".length)}`
        : file.path,
    }));
}

/** Scaffold state plus two unreferenced existing documents, created through the revision tools. */
function seededRevisionBase() {
  const scaffold = worldRevisionFiles();
  const seed = new WorldRevisionAuthoringTransaction({
    baseFiles: scaffold,
    immutableBaseFiles: scaffold,
    locale: "zh-CN",
    preview: () => preview,
  });
  const results = seed.execute([
    {
      id: "create-old",
      name: "world_revision_create",
      arguments: {
        path: "state/npc/old.yaml",
        ref: "oldnpc",
        title: "旧商人",
        summary: "只在旧档案中出现的商人。",
        aliases: [],
        body: "id: npc.old\nname: 旧商人\n",
      },
    },
    {
      id: "create-place",
      name: "world_revision_create",
      arguments: {
        path: "state/place.yaml",
        ref: "place",
        title: "码头",
        summary: "河岸边的码头。",
        aliases: [],
        body: "id: place.dock\nname: 码头\n",
      },
    },
  ]);
  for (const result of results)
    if (result.isError) throw new Error(result.markdown);
  return seed.files();
}

function replaceContents(
  files: readonly { path: string; contents: string }[],
  path: string,
  replace: (contents: string) => string,
) {
  return files.map((file) =>
    file.path === path ? { ...file, contents: replace(file.contents) } : file,
  );
}

function prompt() {
  return {
    hostBinding: {
      hostPresetId: "revision-test-host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
      },
    },
    modelBinding: {
      provider: "chat_completions" as const,
      modelId: "revision-test-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  };
}

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

const modelBinding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "endpoint:world-revision-test",
  modelId: "model:world-revision-test",
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "protocol:world-revision-test",
  cacheStrategy: "provider_managed",
};

test("world author rules refresh after restart without changing the active tool loop or epoch", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const presets = new FileNativePlayPresetStore(join(root, "author-presets"));
  await presets.initialize();
  const current = await presets.bindCurrent();
  const script = new ScriptedModelHost({
    binding: modelBinding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "world_revision_read",
            arguments: { path: "control/blocks/world.md" },
          },
          {
            id: "write",
            name: "world_revision_write_file",
            arguments: {
              path: "control/blocks/world.md",
              contents: "# Revised control\nFIRST_WORLD_WRITE",
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "Revision ready",
        reasoningContent: "Original provider reasoning",
        toolCalls: [],
      },
      { outcome: "response", text: "Continued revision", toolCalls: [] },
    ],
  });
  let updated = false;
  const host = {
    binding: () => modelBinding,
    exchange: async (...args: Parameters<typeof script.exchange>) => {
      const result = await script.exchange(...args);
      if (!updated) {
        updated = true;
        const structure = toPlayPresetStructuredEditor(current.definition);
        structure.authorPrompts!.unshift({
          id: "next",
          kind: "user",
          name: "Next",
          enabled: true,
          body: "NEXT_WORLD_AUTHOR_RULE",
        });
        await presets.save({
          presetId: current.id,
          name: current.name,
          files: current.files,
          structure,
        });
        await presets.select(current.id);
      }
      return result;
    },
  };
  const service = () =>
    new WorldRevisionSession({
      store: new FileNativeWorldRevisionStore(root),
      workspace,
      worlds,
      compiler: new FileNativePromptCompiler({ locale: "en" }),
      locale: () => "en",
      bindModelHost: () => Promise.resolve(host),
      bindExistingModelHost: () => Promise.resolve(host),
      bindPlayPreset: () => presets.bindCurrent(),
      preview: () => preview,
    });
  const first = await service().send({
    worldId,
    requestId: "author-first",
    message: "Revise",
    continuation: { kind: "fresh_context" },
  });
  expect(first.runStatus).toBe("ready");
  expect(script.requests).toHaveLength(2);
  expect(script.requests[1]!.bootstrap).toEqual(script.requests[0]!.bootstrap);
  expect(JSON.stringify(script.requests[1]!.bootstrap)).not.toContain(
    "NEXT_WORLD_AUTHOR_RULE",
  );
  const epoch = await workspace.active(worldId);
  expect(
    epoch?.files.find(({ path }) => path === "control/blocks/world.md")
      ?.contents,
  ).toContain("FIRST_WORLD_WRITE");
  expect(await worlds.currentHead(worldId)).toBe("genesis");
  const second = await service().send({
    worldId,
    requestId: "author-next",
    message: "Continue",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(second.runStatus).toBe("ready");
  expect(JSON.stringify(script.requests[2]!.bootstrap)).toContain(
    "NEXT_WORLD_AUTHOR_RULE",
  );
  expect(JSON.stringify(script.requests[2]!.bootstrap)).toContain(
    epoch!.epochId,
  );
  expect(script.requests[2]!.appended.slice(0, -1)).toEqual([
    ...script.requests[1]!.appended,
    expect.objectContaining({
      kind: "assistant",
      reasoningContent: "Original provider reasoning",
    }),
  ]);
  expect(second.requestPreviews).toHaveLength(2);
  expect(await worlds.readWorldRevisionLock(worldId)).toEqual({
    worldId,
    epochId: epoch!.epochId,
  });
});

test("world author candidate preview never opens an epoch or dispatches the provider", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const host = new ScriptedModelHost({ binding: modelBinding, steps: [] });
  const service = new WorldRevisionSession({
    store: new FileNativeWorldRevisionStore(root),
    workspace,
    worlds,
    compiler: new FileNativePromptCompiler({ locale: "en" }),
    locale: () => "en",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: () => Promise.resolve(host),
    bindPlayPreset: () =>
      Promise.resolve(builtinDefaultPlayPresetBinding("en")),
    preview: () => preview,
  });
  const candidate = await service.preview(worldId);
  expect(JSON.stringify(candidate)).toContain("durably locked exclusive epoch");
  expect(host.requests).toHaveLength(0);
  expect(await workspace.active(worldId)).toBeNull();
  expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();
});
