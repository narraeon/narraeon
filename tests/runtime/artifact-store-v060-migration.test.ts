import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "artifact-store-v060",
);

async function readAll(store: FileNativeArtifactStore, worldId: string) {
  return {
    activeProjection: await store.readActiveProjection(worldId),
    extensionSummaries: await store.readExtensionSummaries(worldId),
    debug: await store.readDebug(worldId),
  };
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    throw error;
  }
}

describe("v0.6.0 artifact-store migration", () => {
  test("迁移后读取结果与 v0.6.0 读取器在同一数据上的输出逐项一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-v060-"));
    try {
      await cp(join(fixture, "data"), root, { recursive: true });
      const expected = JSON.parse(
        await readFile(join(fixture, "expected.json"), "utf8"),
      ) as Record<string, Awaited<ReturnType<typeof readAll>>>;
      const store = new FileNativeArtifactStore(root);
      for (const worldId of ["world-1", "world-fork"])
        expect(await readAll(store, worldId)).toEqual(expected[worldId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("迁移删除旧布局与分叉暂存，重复打开结果不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-v060-"));
    try {
      await cp(join(fixture, "data"), root, { recursive: true });
      const expected = JSON.parse(
        await readFile(join(fixture, "expected.json"), "utf8"),
      ) as Record<string, Awaited<ReturnType<typeof readAll>>>;
      await readAll(new FileNativeArtifactStore(root), "world-fork");
      await readAll(new FileNativeArtifactStore(root), "world-1");

      expect(await missing(join(root, "artifact-store"))).toBe(true);
      expect(
        await missing(
          join(
            root,
            "worlds-file-native",
            "world-fork",
            "runtime",
            "artifact-fork.json",
          ),
        ),
      ).toBe(true);
      expect(
        await missing(
          join(root, "worlds-file-native", "world-fork", "fork-restored.json"),
        ),
      ).toBe(true);
      expect(
        await missing(
          join(root, "worlds-file-native", "world-1", "artifacts", "records"),
        ),
      ).toBe(false);

      const reopened = new FileNativeArtifactStore(root);
      for (const worldId of ["world-1", "world-fork"])
        expect(await readAll(reopened, worldId)).toEqual(expected[worldId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
