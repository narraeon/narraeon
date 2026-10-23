import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import {
  parseV1Envelope,
  v1Protocol,
  type V1Request,
  type V1StoryExport,
  type V1StoryExportFormat,
} from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { revisePlayerTimeline } from "./support/player-timeline-edit.ts";

const roots: string[] = [];
const opening = "  清晨，门外传来脚步。\n\n窗户仍敞着。  \n";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([
  ["markdown", "zh-CN", "> **我**："],
  ["text", "zh-CN", "我："],
  ["markdown", "en", "> **Me**: "],
  ["text", "en", "Me: "],
] as const)(
  "完整故事保留原文与多行输入：%s / %s",
  async (format, locale, label) => {
    const { runtime, worlds, worldId, worldRoot } = await fixture(locale);
    const player = "  我推开门。\n\n再停下来。  \n";
    const narrator = "  门外没有人。\n\n你听见一声鸟鸣。 \n\n";
    await append(worlds, worldId, "player", player);
    await append(worlds, worldId, "narrator", narrator);
    const before = await treeBytes(worldRoot);
    const changed = vi.fn();
    const stopPlay = runtime.subscribeConversation(
      { kind: "play", id: worldId },
      changed,
    );
    const stopRevision = runtime.subscribeConversation(
      { kind: "revision", id: worldId },
      changed,
    );
    try {
      const result = await exportCurrent(runtime, worldId, format);
      const playerBlock =
        format === "markdown"
          ? `${label}  我推开门。\n> \n> 再停下来。  \n> `
          : `${label}${player}`;
      expect(result).toEqual({
        fileName: format === "markdown" ? "雾港.md" : "雾港.txt",
        content: `${format === "markdown" ? "# " : ""}雾港\n\n${opening}\n\n${playerBlock}\n\n${narrator}`,
      });
      expect(await treeBytes(worldRoot)).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      stopPlay();
      stopRevision();
    }
  },
);

test("活动缓存缺失时导出只读名称与故事，不重建缓存", async () => {
  const { runtime, worlds, worldId, worldRoot } = await fixture("zh-CN");
  await worlds.renameWorld(worldId, "新世界名称");
  await rm(join(worldRoot, "runtime/activity.json"), { force: true });
  const before = await treeBytes(worldRoot);
  const exported = await exportCurrent(runtime, worldId, "text");
  expect(exported.content).toBe(`新世界名称\n\n${opening}`);
  expect(exported.fileName).toBe("新世界名称.txt");
  expect(await treeBytes(worldRoot)).toEqual(before);
});

test("只有开场白、修订锁定和物化历史落后时仍读取已接受正文", async () => {
  const { runtime, worlds, worldId, worldRoot } = await fixture("zh-CN");
  const lock = await worlds.acquireWorldRevisionLock(
    worldId,
    "story-export-revision",
  );
  expect(lock.kind).toBe("acquired");
  if (lock.kind !== "acquired") throw new Error("Revision lock unavailable");
  const historyFiles = await readdir(join(worldRoot, "history"));
  await writeFile(
    join(worldRoot, "history", historyFiles[0]!),
    "stale projection",
  );
  const result = await exportCurrent(runtime, worldId, "text");
  expect(result.content).toBe(`雾港\n\n${opening}`);
  expect(await worlds.currentHead(worldId)).toBe("genesis");
  expect(await worlds.readWorldRevisionLock(worldId)).toEqual({
    worldId,
    epochId: lock.handle.epochId,
  });
});

test("导出完整历史而不受页面最近 40 项边界影响", async () => {
  const { runtime, worlds, worldId } = await fixture("en");
  const messages = Array.from({ length: 61 }, (_, index) => ({
    role: index % 2 === 0 ? ("player" as const) : ("narrator" as const),
    exactText: `Original ${index}`,
  }));
  await worlds.commitPlayStep({
    operationId: "long-story",
    worldId,
    parentHead: "genesis",
    historyAppend: messages,
    stateChanges: [],
    nextMaterials: [],
  });
  const exported = await exportCurrent(runtime, worldId, "text");
  expect(exported.content).toBe(
    [
      "雾港",
      opening,
      ...messages.map(({ role, exactText }) =>
        role === "player" ? `Me: ${exactText}` : exactText,
      ),
    ].join("\n\n"),
  );
});

test("修订排除被替换后续，分叉保留所选前缀且不依赖来源", async () => {
  const { runtime, worlds, worldId } = await fixture("zh-CN");
  await append(worlds, worldId, "player", "第一条行动");
  await append(worlds, worldId, "narrator", "第一段正文");
  await append(worlds, worldId, "player", "已被替换的行动");
  await append(worlds, worldId, "narrator", "已被替换的后续");
  await revisePlayerTimeline(worlds, {
    operationId: "story-revision",
    worldId,
    expectedCurrentHead: "commit:4",
    restoresHead: "commit:2",
    replacesHead: "commit:3",
    replacementText: "修改后的行动",
  });
  await append(worlds, worldId, "narrator", "修改后的正文");
  // 修订先回退（轮 5），再追加修改稿（轮 6）与正文（轮 7）：轮号不重用。
  expect(await worlds.currentHead(worldId)).toBe("commit:7");
  const expected = [
    "雾港",
    opening,
    "我：第一条行动",
    "第一段正文",
    "我：修改后的行动",
    "修改后的正文",
  ].join("\n\n");
  expect((await exportCurrent(runtime, worldId, "text")).content).toBe(
    expected,
  );
  const fork = await worlds.deriveWorld({
    operationId: "story-fork",
    sourceWorldId: worldId,
    sourceHead: "commit:2",
    hostPresetId: "story-host",
  });
  const currentFork = await worlds.deriveWorld({
    operationId: "current-story-fork",
    sourceWorldId: worldId,
    sourceHead: "commit:7",
    hostPresetId: "story-host",
  });
  await worlds.deleteWorld(worldId);
  expect(
    (await exportCurrent(runtime, fork.world.worldId, "text")).content,
  ).toBe(
    [fork.world.title, opening, "我：第一条行动", "第一段正文"].join("\n\n"),
  );
  expect(
    (await exportCurrent(runtime, currentFork.world.worldId, "text")).content,
  ).toBe(expected.replace(/^雾港/u, currentFork.world.title));
});

test.each([
  ['雾<港>:"/\\|?*夜. ', "雾港夜.md"],
  ['<>:"/\\|?*', "story.md"],
  ["CON", "_CON.md"],
  ["旅".repeat(160), `${"旅".repeat(77)}.md`],
  ["🌙".repeat(60), `${"🌙".repeat(60)}.md`],
  ["🌙".repeat(80), `${"🌙".repeat(63)}.md`],
])("文件名清除不允许字符并控制长度：%s", async (title, fileName) => {
  const { runtime, worlds, worldId } = await fixture("en");
  await worlds.renameWorld(worldId, title);
  const result = await exportCurrent(runtime, worldId, "markdown");
  expect(result.fileName).toBe(fileName);
  expect(result.content).toBe(`# ${title.trim()}\n\n${opening}`);
});

test.each([undefined, "", "html", 1, null])(
  "请求拒绝无效格式：%s",
  (format) => {
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type: "world.story.export", worldId: "world", format },
      }),
    ).toThrow();
  },
);

async function fixture(locale: AppLocale) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-story-export-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const runtime = new V1Runtime({ dataRoot, configRoot: join(root, "config") });
  await runtime.initialize();
  await call(runtime, { type: "preferences.save", locale });
  await call(runtime, {
    type: "model.save",
    connection: {
      name: "Story export fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture",
      modelId: "fixture",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
  const package_ = await call<{
    localId: string;
  }>(runtime, { type: "content.create" });
  const packageFiles = await call<{
    files: { path: string; contents: string }[];
  }>(runtime, {
    type: "content.read",
    packageId: package_.localId,
  });
  await call(runtime, {
    type: "content.rename",
    packageId: package_.localId,
    name: "雾港",
  });
  await call(runtime, {
    type: "content.replace",
    packageId: package_.localId,
    baseTreeRevision: (
      await call<{ treeRevision: string }>(runtime, {
        type: "content.read",
        packageId: package_.localId,
      })
    ).treeRevision,
    files: packageFiles.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: opening }
        : file.path === "world/current-situation.yaml"
          ? {
              ...file,
              contents: `${file.contents}\n背景: 导出不包含的历史背景\n`,
            }
          : file,
    ),
  });
  const created = await call<{ world: { worldId: string } }>(runtime, {
    type: "world.create",
    operationId: "story-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "fixture",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
  return {
    runtime,
    worlds: new FileNativeWorldStore(dataRoot),
    worldId: created.world.worldId,
    worldRoot: join(dataRoot, "worlds-file-native", created.world.worldId),
  };
}

async function call<T>(runtime: V1Runtime, request: V1Request): Promise<T> {
  return (await runtime.handle(request)).result as T;
}

function exportCurrent(
  runtime: V1Runtime,
  worldId: string,
  format: V1StoryExportFormat,
) {
  return call<V1StoryExport>(runtime, {
    type: "world.story.export",
    worldId,
    format,
  });
}

async function append(
  worlds: FileNativeWorldStore,
  worldId: string,
  role: "player" | "narrator",
  exactText: string,
) {
  const parentHead = await worlds.currentHead(worldId);
  return worlds.commitPlayStep({
    operationId: `story-${parentHead.replace(":", "-")}`,
    worldId,
    parentHead,
    historyAppend: [{ role, exactText }],
    stateChanges: [],
    nextMaterials: [],
  });
}

async function treeBytes(root: string) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = files
    .filter((file) => file.isFile())
    .map((file) => join(file.parentPath, file.name))
    .sort();
  return Promise.all(
    paths.map(async (path) => [path, await readFile(path, "utf8")]),
  );
}
