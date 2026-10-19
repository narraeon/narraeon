import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, expect, test } from "vitest";

import {
  fictionGameplay,
  gameplayFile,
  gameplayPath,
} from "../../src/protocol/gameplay.ts";
import { worldArchiveLimits } from "../../src/protocol/worldArchives.ts";
import { extractArchive } from "../../src/runtime/archive/WorldArchiveZip.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { FileNativeWorldCreationError } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  archiveModelBinding,
  archiveStores,
  worldArchiveFixture,
} from "../support/worldArchiveFixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const bagTabletop = { mode: "tabletop", scheme: "bag" } as const;
const bagGameplayFile = gameplayFile(bagTabletop);

async function tabletopSource() {
  const value = await worldArchiveFixture({
    extraPackageFiles: [bagGameplayFile],
  });
  roots.push(value.root);
  return value;
}

async function exportBackup(
  source: Awaited<ReturnType<typeof tabletopSource>>,
) {
  await source.archives.exportWorld({
    worldId: source.worldId,
    operationId: "export-gameplay",
  });
  return join(
    source.root,
    "world-archives/exports/export-gameplay/archive.zip",
  );
}

async function archivedFile(zip: string, path: string): Promise<string | null> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-gameplay-archive-"));
  roots.push(root);
  const found = await extractArchive(zip, root, worldArchiveLimits);
  return found.has(path) ? readFile(join(root, path), "utf8") : null;
}

async function importBackup(zip: string) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-gameplay-import-"));
  roots.push(root);
  const target = archiveStores(root);
  await target.archives.initialize();
  const upload = await target.archives.upload(
    Readable.from([await readFile(zip)]),
  );
  const result = await target.archives.importWorld({
    operationId: "import-gameplay",
    ...upload,
  });
  return { target, worldId: result.world.worldId, summary: result.world };
}

test("跑团世界的便携归档保留 control/gameplay.json，导入后读取与摘要报告同一模式与方案", async () => {
  const source = await tabletopSource();
  expect(await source.worlds.gameplay(source.worldId)).toEqual(bagTabletop);
  const zip = await exportBackup(source);
  expect(await archivedFile(zip, "world/control/gameplay.json")).toBe(
    bagGameplayFile.contents,
  );

  const { target, worldId, summary } = await importBackup(zip);
  expect(summary).toMatchObject({ gameplay: bagTabletop });
  expect(await target.worlds.gameplay(worldId)).toEqual(bagTabletop);
  expect(await target.worlds.readWorldSummary(worldId)).toMatchObject({
    gameplay: bagTabletop,
  });
  expect(await target.worlds.listWorlds()).toContainEqual(
    expect.objectContaining({ worldId, gameplay: bagTabletop }),
  );
  expect(await target.worlds.readSurface(worldId, "control")).toContainEqual(
    expect.objectContaining({
      path: "gameplay.json",
      contents: bagGameplayFile.contents,
    }),
  );

  // The imported world's first fresh-context send derives its tools from the restored gameplay.
  const preset = builtinDefaultPlayPresetBinding();
  const modelHost = new ScriptedModelHost({
    binding: archiveModelBinding,
    steps: [{ outcome: "response", text: "门后只有安静。" }],
  });
  await target.chains.start({
    worldId,
    chainId: "imported-fresh-chain",
    exchangeId: "imported-fresh-send",
    playerText: "我推门。",
    hostBinding: presetHostBinding(preset),
    playPreset: preset,
    modelBinding: archiveModelBinding,
    modelHost,
  });
  const toolNames = modelHost.requests[0]?.tools.map(({ name }) => name) ?? [];
  expect(toolNames).toContain("bag_check");
  expect(toolNames).not.toContain("d20_check");
});

test("导入的跑团世界仍拒绝改变模式或方案的控制编辑，未改变的玩法文件可以保存", async () => {
  const source = await tabletopSource();
  const { target, worldId } = await importBackup(await exportBackup(source));
  const control = await target.worlds.readSurface(worldId, "control");
  const retargeted = control.map((file) =>
    file.path === "gameplay.json"
      ? {
          path: "gameplay.json",
          contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
        }
      : file,
  );
  const fiction = control.filter(({ path }) => path !== "gameplay.json");

  const rejected = target.worlds.saveControlDraft(worldId, retargeted);
  await expect(rejected).rejects.toMatchObject({
    code: "candidate_validation_failed",
  });
  await expect(rejected).rejects.toThrow(/fixed/u);
  await expect(
    target.worlds.saveControlDraft(worldId, fiction),
  ).rejects.toBeInstanceOf(FileNativeWorldCreationError);
  expect(await target.worlds.gameplay(worldId)).toEqual(bagTabletop);
  const saved = await target.worlds.saveControlDraft(worldId, control);
  expect(saved.fingerprint).toMatch(/^sha256:/u);
});

test("没有玩法文件的互动式小说归档不含该文件，导入后仍是互动式小说", async () => {
  const source = await worldArchiveFixture();
  roots.push(source.root);
  expect(await source.worlds.gameplay(source.worldId)).toEqual(fictionGameplay);
  const zip = await exportBackup(source);
  expect(await archivedFile(zip, "world/control/gameplay.json")).toBeNull();

  const { target, worldId, summary } = await importBackup(zip);
  expect(summary).toMatchObject({ gameplay: { mode: "interactive-fiction" } });
  expect(await target.worlds.gameplay(worldId)).toEqual(fictionGameplay);
  expect(
    await target.worlds.readSurface(worldId, "control"),
  ).not.toContainEqual(expect.objectContaining({ path: "gameplay.json" }));
});

test("导入的跑团世界的世界修订不能改变玩法模式或方案，未改变的修订可以应用", async () => {
  const source = await tabletopSource();
  const { target, worldId } = await importBackup(await exportBackup(source));
  const workspace = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(target.root),
    worlds: target.worlds,
  });
  let epoch = await workspace.open(worldId);
  expect(epoch.files).toContainEqual(
    expect.objectContaining({
      path: gameplayPath,
      contents: bagGameplayFile.contents,
    }),
  );
  const retargeted = epoch.files.map((file) =>
    file.path === gameplayPath
      ? {
          ...file,
          contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
        }
      : file,
  );
  await expect(
    workspace.replace({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files: retargeted,
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
    files: epoch.files,
  });
  expect(epoch.files).toContainEqual(
    expect.objectContaining({
      path: gameplayPath,
      contents: bagGameplayFile.contents,
    }),
  );
  expect(await target.worlds.gameplay(worldId)).toEqual(bagTabletop);
});
