import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, test } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

interface V3Fixture {
  worldId: string;
  files: { path: string; base64: string }[];
  endpoints: Record<string, unknown>;
}

const fixtures = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/authority-v3/storage.json.gz", import.meta.url),
    ),
  ).toString("utf8"),
) as { plain: V3Fixture; revised: V3Fixture };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function restore(label: keyof typeof fixtures) {
  const fixture = fixtures[label];
  const root = await mkdtemp(join(tmpdir(), `narraeon-v3-${label}-`));
  roots.push(root);
  const worldRoot = join(root, "worlds-file-native", fixture.worldId);
  for (const file of fixture.files) {
    await mkdir(dirname(join(worldRoot, file.path)), { recursive: true });
    await writeFile(
      join(worldRoot, file.path),
      Buffer.from(file.base64, "base64"),
    );
  }
  return { root, worldRoot, fixture };
}

// 物理文件中属于端点的部分：状态、历史、历史背景与附加材料清单。
async function endpointSurface(
  worldRoot: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await listRelative(worldRoot)) {
    if (
      path.startsWith("state/") ||
      path.startsWith("history/") ||
      path.startsWith("runtime/history-backgrounds/") ||
      path === "runtime/additional-materials.json"
    )
      files[path] = await readFile(join(worldRoot, path), "utf8");
  }
  return files;
}

async function listRelative(root: string, prefix = ""): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listRelative(root, path)));
    else out.push(path);
  }
  return out;
}

function fixtureSurface(fixture: V3Fixture): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of fixture.files) {
    const path = file.path;
    if (
      path.startsWith("state/") ||
      path.startsWith("history/") ||
      path.startsWith("runtime/history-backgrounds/") ||
      path === "runtime/additional-materials.json"
    )
      files[path] = Buffer.from(file.base64, "base64").toString("utf8");
  }
  return files;
}

test("V3 世界迁移后当前文件逐字节一致，commit 编号与各端点保持不变", async () => {
  const { root, worldRoot, fixture } = await restore("plain");
  const before = fixtureSurface(fixture);
  const store = new FileNativeWorldStore(root);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
  expect(await endpointSurface(worldRoot)).toEqual(before);
  for (const [head, expected] of Object.entries(fixture.endpoints))
    await expect(store.recoverEndpoint(fixture.worldId, head)).resolves.toEqual(
      expected,
    );

  const history = await store.readAuthorityHistory(fixture.worldId);
  expect(history.commits.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
  expect(history.commits.map(({ head }) => head)).toEqual([
    "commit:1",
    "commit:2",
    "commit:3",
    "commit:4",
  ]);
  await expect(
    readFile(join(worldRoot, "runtime/continuity-head.json")),
  ).rejects.toThrow();
  await expect(
    readFile(join(worldRoot, "runtime/materialized-head.json")),
  ).rejects.toThrow();
  await expect(
    readFile(join(worldRoot, "runtime/head.json"), "utf8"),
  ).resolves.toContain('"sequence": 4');
});

test("含时间线修订的 V3 世界迁移为单个修订轮，修订后的端点与当前文件一致", async () => {
  const { root, worldRoot, fixture } = await restore("revised");
  const before = fixtureSurface(fixture);
  const store = new FileNativeWorldStore(root);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:5");
  expect(await endpointSurface(worldRoot)).toEqual(before);
  await expect(
    store.recoverEndpoint(fixture.worldId, "commit:5"),
  ).resolves.toEqual(fixture.endpoints["commit:5"]);
  // 被替换的旧轮不保留；它们的端点不再可达。
  await expect(
    store.recoverEndpoint(fixture.worldId, "commit:1"),
  ).rejects.toThrow();
  await expect(
    store.recoverEndpoint(fixture.worldId, "commit:4"),
  ).rejects.toThrow();
});

test("迁移中途留下的未发布账本会被丢弃并重做", async () => {
  const { root, worldRoot, fixture } = await restore("plain");
  // 构造一个未发布的中间状态：有半写的轮记录目录，但没有 head.json。
  await mkdir(join(worldRoot, "runtime", "turns"), { recursive: true });
  await writeFile(
    join(worldRoot, "runtime", "turns", "00000002.json"),
    "{ half",
  );
  const store = new FileNativeWorldStore(root);

  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:4");
  expect(await endpointSurface(worldRoot)).toEqual(fixtureSurface(fixture));
  await expect(
    store.recoverEndpoint(fixture.worldId, "commit:2"),
  ).resolves.toEqual(fixture.endpoints["commit:2"]);
});

test("迁移后的世界可以继续提交，并可从较早端点分叉", async () => {
  const { root, fixture } = await restore("plain");
  const store = new FileNativeWorldStore(root);

  await expect(
    store.commitPlayStep({
      operationId: "after-migration-player",
      worldId: fixture.worldId,
      parentHead: "commit:4",
      historyAppend: [{ role: "player", exactText: "我继续向前。" }],
      nextMaterials: [],
      stateChanges: [],
    }),
  ).resolves.toMatchObject({ head: "commit:5" });
  await expect(store.currentHead(fixture.worldId)).resolves.toBe("commit:5");

  const fork = await store.deriveWorld({
    operationId: "after-migration-fork",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:2",
    hostPresetId: "host-after-migration",
  });
  await expect(store.recoverEndpoint(fork.world.worldId)).resolves.toEqual({
    ...(fixture.endpoints["commit:2"] as object),
    worldId: fork.world.worldId,
  });
});
