import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  FileNativeWorldCreationError,
  FileNativeWorldStore,
} from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  FileNativeWorldStorageMigrator,
  UnsupportedLegacyStorageError,
} from "../../src/runtime/world/FileNativeWorldStorageMigrator.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Writes a world directory holding only the files of a pre-V3 layout. */
async function legacyWorld(
  worldId: string,
  files: Record<string, unknown>,
): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "unsupported-legacy-"));
  roots.push(dataRoot);
  const worldRoot = join(dataRoot, "worlds-file-native", worldId);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(worldRoot, path)), { recursive: true });
    await writeFile(join(worldRoot, path), `${JSON.stringify(value)}\n`);
  }
  return dataRoot;
}

const v1Files = {
  "publication.json": { schemaVersion: 1, worldId: "world-v1" },
  "runtime/genesis.json": {},
  "runtime/play-authority.json": {
    schemaVersion: 1,
    head: "genesis",
    commits: [],
  },
};

const v2Files = {
  "runtime/play-authority-head.json": {
    schemaVersion: 2,
    head: "genesis",
    sequence: 0,
    commitDigest: null,
    operationId: null,
  },
  "runtime/materialized-head.json": {
    schemaVersion: 2,
    head: "genesis",
    sequence: 0,
    commitDigest: null,
  },
};

test("the migrator rejects a V1 layout as unsupported", async () => {
  const dataRoot = await legacyWorld("world-v1", v1Files);
  const migrator = new FileNativeWorldStorageMigrator(dataRoot);

  const error = await migrator
    .migrate("world-v1")
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(UnsupportedLegacyStorageError);
  expect(error).toMatchObject({ code: "unsupported_legacy_storage" });
});

test("a V2 layout is reported as a non-openable world, not a crash", async () => {
  const dataRoot = await legacyWorld("world-v2", v2Files);
  const store = new FileNativeWorldStore(dataRoot);

  const error = await store
    .ensureCurrentStorage("world-v2")
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(FileNativeWorldCreationError);
  expect(error).toMatchObject({ code: "world_corrupt" });
  expect((error as Error).message).toContain("v0.3.0–v0.6.0");
});
