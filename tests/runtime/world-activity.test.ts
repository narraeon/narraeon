import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { createMinimalFileNativePreviewInput } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import type { WorldActivity } from "../../src/runtime/world/WorldActivity.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});

const roots: string[] = [];
const opening = "雾港的灯亮了。\n你站在码头。";
const now = 1_790_000_000_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("创建和每次玩家／主持提交更新本地缓存，摘录按 Unicode 码点取 80 个", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const fixture = await world();
  expect(await activity(fixture.root, fixture.worldId)).toEqual({
    schemaVersion: 1,
    head: "genesis",
    lastActivityAt: now,
    excerpt: "雾港的灯亮了。 你站在码头。",
    playerTurns: 0,
  });
  const player = await play(
    fixture,
    "玩家选择登船。",
    "player",
    "genesis",
    now + 1000,
  );
  expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
    head: player.head,
    lastActivityAt: now + 1000,
    playerTurns: 1,
    excerpt: "雾港的灯亮了。 你站在码头。",
  });
  clock.mockReturnValue(now + 2000);
  const narrative = `船长招手。\n${"🧭".repeat(90)}`;
  const narrator = await play(
    fixture,
    narrative,
    "narrator",
    player.head,
    now + 2000,
  );
  const cached = await activity(fixture.root, fixture.worldId);
  expect(cached).toEqual({
    schemaVersion: 1,
    head: narrator.head,
    lastActivityAt: now + 2000,
    excerpt: `船长招手。 ${"🧭".repeat(74)}`,
    playerTurns: 1,
  });
  expect(Array.from(cached.excerpt!)).toHaveLength(80);
  // Repeating a successful operation does not make an old endpoint newly active.
  await fixture.store.commitPlayStep({
    operationId: `play-${now + 2000}`,
    worldId: fixture.worldId,
    parentHead: player.head,
    historyAppend: [{ role: "narrator", exactText: narrative }],
    nextMaterials: [],
    stateChanges: [],
  });
  expect(await activity(fixture.root, fixture.worldId)).toEqual(cached);
});

test("连续性修正、时间线修订、旧端点分叉和世界修订应用的摘要使用当前时间线", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const fixture = await world();
  const first = await play(
    fixture,
    "我登船。",
    "player",
    "genesis",
    now + 1000,
  );
  const second = await play(
    fixture,
    "船已经离港。",
    "narrator",
    first.head,
    now + 2000,
  );
  clock.mockReturnValue(now + 3000);
  const correction = await fixture.store.commitCorrection({
    operationId: "correction",
    worldId: fixture.worldId,
    parentHead: second.head,
    nextMaterials: [],
    stateChanges: [],
  });
  expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
    head: correction.head,
    lastActivityAt: now + 3000,
    excerpt: "船已经离港。",
    playerTurns: 1,
  });
  // 修订会丢弃 second 之后的端点，所以先从仍可达的 second 分叉。
  clock.mockReturnValue(now + 3500);
  const fork = await fixture.store.deriveWorld({
    operationId: "fork-old-endpoint",
    sourceWorldId: fixture.worldId,
    sourceHead: second.head,
    hostPresetId: "host-activity",
  });
  expect(fork.world).toMatchObject({
    lastActivityAt: now + 3500,
    excerpt: "船已经离港。",
    playerTurns: 1,
  });
  clock.mockReturnValue(now + 4000);
  const revision = await fixture.store.reviseTimeline({
    operationId: "edit-player",
    worldId: fixture.worldId,
    expectedCurrentHead: correction.head,
    restoresHead: "genesis",
    replacesHead: first.head,
    replacementText: "我留在码头。",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
  });
  expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
    head: revision.head,
    lastActivityAt: now + 4000,
    excerpt: "雾港的灯亮了。 你站在码头。",
    playerTurns: 1,
  });
  const workspace = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(fixture.root),
    worlds: fixture.store,
  });
  let epoch = await workspace.open(fixture.worldId);
  epoch = await workspace.replace({
    worldId: fixture.worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: epoch.files.map((file) =>
      file.path.startsWith("control/blocks/")
        ? { ...file, contents: `${file.contents}\n保留码头故事。\n` }
        : file,
    ),
  });
  clock.mockReturnValue(now + 6000);
  const applied = await workspace.apply({
    worldId: fixture.worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
    head: applied.apply?.committedHead,
    lastActivityAt: now + 6000,
    excerpt: "雾港的灯亮了。 你站在码头。",
    playerTurns: 1,
  });
});

test.each(["missing", "json", "schema", "head", "time"])(
  "%s 缓存按需重建并写回，未知时间不被猜测",
  async (damage) => {
    const fixture = await world();
    const first = await play(
      fixture,
      "我登船。",
      "player",
      "genesis",
      now + 1000,
    );
    const second = await play(
      fixture,
      "船长打开舱门。",
      "narrator",
      first.head,
      now + 2000,
    );
    await play(fixture, "我看向舱里。", "player", second.head, now + 3000);
    const path = activityPath(fixture.root, fixture.worldId);
    if (damage === "missing") await rm(path);
    else if (damage === "json") await writeFile(path, "{invalid");
    else
      await writeFile(
        path,
        JSON.stringify({
          ...(await activity(fixture.root, fixture.worldId)),
          ...(damage === "schema"
            ? { playerTurns: -1 }
            : damage === "head"
              ? { head: "genesis" }
              : { lastActivityAt: Number.MAX_SAFE_INTEGER }),
        }),
      );
    vi.mocked(fs.readFile).mockClear();
    const summary = (await fixture.store.listWorlds())[0]!;
    const paths = vi
      .mocked(fs.readFile)
      .mock.calls.map(([path]) => (typeof path === "string" ? path : ""));
    expect(summary).toMatchObject({
      lastActivityAt: null,
      excerpt: "船长打开舱门。",
      playerTurns: 2,
    });
    expect(paths.filter((path) => path.includes("/history/"))).toHaveLength(1);
    expect(paths.some((path) => path.includes("/authority/"))).toBe(false);
    expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
      head: "commit:3",
      lastActivityAt: null,
      excerpt: "船长打开舱门。",
      playerTurns: 2,
    });
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.readdir).mockClear();
    expect(await new FileNativeWorldStore(fixture.root).listWorlds()).toEqual([
      summary,
    ]);
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.some(([path]) =>
          (typeof path === "string" ? path : "").includes("/history/"),
        ),
    ).toBe(false);
    expect(
      vi
        .mocked(fs.readdir)
        .mock.calls.some(([path]) =>
          (typeof path === "string" ? path : "").endsWith("/history"),
        ),
    ).toBe(false);
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(([path]) =>
          (typeof path === "string" ? path : "").endsWith("/activity.json"),
        ),
    ).toHaveLength(1);
  },
);

test("列表按活动时间倒序，未知时间排末尾并按当前名称排序", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const fixture = await world();
  const second = await create(fixture.store, "world-b", "Beta");
  const third = await create(fixture.store, "world-c", "Alpha");
  await play(fixture, "最近活动。", "player", "genesis", now + 1000);
  expect((await fixture.store.listWorlds())[0]?.worldId).toBe(fixture.worldId);
  await rm(activityPath(fixture.root, second.world.worldId));
  await writeFile(activityPath(fixture.root, third.world.worldId), "broken");
  expect(
    (await fixture.store.listWorlds()).map(({ worldId }) => worldId),
  ).toEqual([fixture.worldId, third.world.worldId, second.world.worldId]);
  await fixture.store.renameWorld(second.world.worldId, "Aardvark");
  expect(
    (await fixture.store.listWorlds()).map(({ worldId }) => worldId),
  ).toEqual([fixture.worldId, second.world.worldId, third.world.worldId]);
});

test("缓存写入失败只记录日志，不影响已接受提交或列表", async () => {
  const fixture = await world();
  const path = activityPath(fixture.root, fixture.worldId);
  await rm(path);
  await mkdir(path);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const committed = await play(
    fixture,
    "雨停了。",
    "narrator",
    "genesis",
    now + 1000,
  );
  expect(committed.outcome).toBe("committed");
  expect(await fixture.store.currentHead(fixture.worldId)).toBe(committed.head);
  expect(await fixture.store.listWorlds()).toMatchObject([
    { lastActivityAt: null, excerpt: "雨停了。" },
  ]);
  expect(warning).toHaveBeenCalled();
});

test("缓存头与当前端点不一致时从 history/ 重建摘要，重建时间保持为空", async () => {
  const fixture = await world();
  const committed = await play(
    fixture,
    "雨停了。",
    "narrator",
    "genesis",
    now + 1000,
  );
  await writeFile(
    activityPath(fixture.root, fixture.worldId),
    JSON.stringify({
      schemaVersion: 1,
      head: "genesis",
      lastActivityAt: null,
      excerpt: null,
      playerTurns: 0,
    }),
  );
  expect(await fixture.store.listWorlds()).toMatchObject([
    { lastActivityAt: null, excerpt: "雨停了。" },
  ]);
  expect(await activity(fixture.root, fixture.worldId)).toMatchObject({
    head: committed.head,
    excerpt: "雨停了。",
  });
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-activity-"));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await create(store, "world-a", "Harbor");
  return { root, store, worldId: created.world.worldId };
}

async function create(
  store: FileNativeWorldStore,
  operationId: string,
  title: string,
) {
  return store.createFromContentPackage({
    operationId,
    sourcePackageId: "activity-package",
    sourcePackageTitle: title,
    packageFiles: minimalFileNativeContentScaffold("zh-CN").map((file) =>
      file.path === "opening.md" ? { ...file, contents: opening } : file,
    ),
    prompt: createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "activity-test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
      playerInput: "preview",
      playerInputPlacement: "append",
    }),
  });
}

async function play(
  fixture: Awaited<ReturnType<typeof world>>,
  text: string,
  role: "player" | "narrator",
  parentHead: string,
  time: number,
) {
  vi.spyOn(Date, "now").mockReturnValue(time);
  return fixture.store.commitPlayStep({
    operationId: `play-${time}`,
    worldId: fixture.worldId,
    parentHead,
    historyAppend: [{ role, exactText: text }],
    nextMaterials: [],
    stateChanges: [],
  });
}

function activityPath(root: string, worldId: string) {
  return join(root, "worlds-file-native", worldId, "runtime/activity.json");
}

async function activity(root: string, worldId: string): Promise<WorldActivity> {
  return JSON.parse(
    await readFile(activityPath(root, worldId), "utf8"),
  ) as WorldActivity;
}
