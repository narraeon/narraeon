import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import {
  ScriptedModelHost,
  type ModelHostBinding,
} from "../../src/runtime/model/ModelHost.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
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
    baseFiles: files,
    immutableBaseFiles: files,
    locale: "zh-CN",
    preview: (snapshot) => {
      previewPaths = snapshot.files.map(({ path }) => path);
      return preview;
    },
  });

  const toolDefinitions = worldRevisionToolDefinitions("zh-CN");
  expect(toolDefinitions.map(({ name }) => name)).toEqual([
    "world_revision_list",
    "world_revision_search",
    "world_revision_read",
    "world_revision_create",
    "world_revision_write_file",
    "world_revision_patch",
    "world_revision_move",
    "world_revision_delete",
  ]);
  expect(
    [...toolDefinitions, ...worldRevisionToolDefinitions("en")].every(
      ({ description }) =>
        description.length > 0 && !/opening(?:\.md)?/iu.test(description),
    ),
  ).toBe(true);
  expect(worldRevisionRuntimeContract("zh-CN")).toContain(
    "state/* 与 control/* 共同组成唯一的修订工作树",
  );
  expect(worldRevisionRuntimeContract("zh-CN")).toContain(
    "此前读取授权全部失效",
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
    worlds.reviseTimeline({
      operationId: "timeline-while-revising",
      worldId,
      expectedCurrentHead: "genesis",
      restoresHead: "genesis",
      replacesHead: "commit:1",
      replacementText: "改写行动",
      requestFingerprint: `sha256:${"0".repeat(64)}`,
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
    apply: { phase: "control_published", committedHead: "commit:1" },
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

test("控制目录交换中断后可从确定路径恢复，Authority 不会重复推进", async () => {
  const { root, worldId, worlds, workspace } = await createdWorld();
  const revisionStore = new FileNativeWorldRevisionStore(root);
  let epoch = await workspace.open(worldId);
  const controlPath = "control/blocks/world.md";
  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: replaceContents(
      epoch.files,
      controlPath,
      (contents) => `${contents}\n恢复后的控制规则。\n`,
    ),
  });
  const handle = { worldId, epochId: epoch.epochId };
  const binding = await worlds.bindWorldRevision(handle);
  const desiredControl = epoch.files
    .filter(({ path }) => path.startsWith("control/"))
    .map(({ path, contents }) => ({
      path: path.slice("control/".length),
      contents,
    }));
  const committed = await worlds.commitCorrection({
    operationId: `world-revision-${epoch.epochId}`,
    worldId,
    parentHead: epoch.baseHead,
    nextMaterials: binding.additionalMaterials,
    stateChanges: [],
    worldRevisionLock: handle,
    validationControl: desiredControl,
  });
  epoch.lifecycle = "applying";
  epoch.apply = {
    operationId: `world-revision-${epoch.epochId}`,
    expectedRevision: epoch.revision,
    phase: "state_committed",
    committedHead: committed.head,
  };
  epoch.updatedAt = Date.now();
  await revisionStore.saveEpoch(epoch);

  const worldRoot = join(root, "worlds-file-native", worldId);
  const stagingRoot = join(
    worldRoot,
    "runtime",
    `.revision-control-${epoch.epochId}-next`,
  );
  for (const file of desiredControl) {
    const path = join(stagingRoot, "control", file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents, "utf8");
  }
  await rename(
    join(worldRoot, "control"),
    join(worldRoot, "runtime", `.revision-control-${epoch.epochId}-previous`),
  );

  const recoveredWorlds = new FileNativeWorldStore(root);
  const recovered = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(root),
    worlds: recoveredWorlds,
  });
  expect(await recovered.active(worldId)).toBeNull();
  expect(await recoveredWorlds.readWorldRevisionLock(worldId)).toBeNull();
  expect(await recoveredWorlds.currentHead(worldId)).toBe(committed.head);
  expect((await recovered.latest(worldId))?.lifecycle).toBe("applied");
  expect(
    (await recoveredWorlds.readSurface(worldId, "control")).find(
      ({ path }) => path === "blocks/world.md",
    )?.contents,
  ).toContain("恢复后的控制规则。");
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

async function createdWorld() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-revision-"));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const created = await worlds.createFromContentPackage({
    operationId: `create-${roots.length}`,
    sourcePackageId: "revision-package",
    sourcePackageTitle: "Revision test world",
    packageFiles: minimalFileNativeContentScaffold("zh-CN"),
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
