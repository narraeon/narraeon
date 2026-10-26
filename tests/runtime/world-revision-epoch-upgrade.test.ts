import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  FileNativeWorldRevisionStore,
  UnsupportedLegacyWorldRevisionError,
} from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";

// Written by the v0.7.4 release store; see fixtures/world-revision-epochs-v0.7.4/README.md.
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/world-revision-epochs-v0.7.4/epochs/", import.meta.url),
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A data root holding a copy of the v0.7.4 epoch files, byte for byte. */
async function legacyDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "world-revision-epochs-"));
  roots.push(dataRoot);
  await cp(fixtureDirectory, join(dataRoot, "world-revisions", "epochs"), {
    recursive: true,
  });
  return dataRoot;
}

/** Every epoch file under the data root, keyed by file name. */
async function epochFiles(dataRoot: string): Promise<Map<string, string>> {
  const epochs = join(dataRoot, "world-revisions", "epochs");
  const names = (await readdir(epochs)).sort();
  return new Map(
    await Promise.all(
      names.map(
        async (name) =>
          [name, await readFile(join(epochs, name), "utf8")] as const,
      ),
    ),
  );
}

/** The v0.7.4 fixture file for `worldId`, as the bytes v0.7.4 wrote. */
async function fixtureEpoch(worldId: string) {
  for (const name of await readdir(fixtureDirectory)) {
    const text = await readFile(join(fixtureDirectory, name), "utf8");
    if ((JSON.parse(text) as { worldId: string }).worldId === worldId)
      return { name, text };
  }
  throw new Error(`No fixture epoch for ${worldId}`);
}

test("a v0.7.4 applied epoch lists, reads and seals as committed", async () => {
  const dataRoot = await legacyDataRoot();
  const store = new FileNativeWorldRevisionStore(dataRoot);
  const workspace = new WorldRevisionWorkspace({
    store,
    worlds: new FileNativeWorldStore(dataRoot),
  });

  const [epoch] = await store.listEpochs("world-applied");
  expect(epoch).toMatchObject({
    worldId: "world-applied",
    lifecycle: "applied",
    apply: { phase: "committed", committedHead: "head-1" },
  });
  expect(await store.readEpoch(epoch!.epochId)).toEqual(epoch);
  expect(await workspace.latest("world-applied")).toEqual(epoch);
  expect(await workspace.sealed("world-applied")).toMatchObject([
    {
      epochId: epoch!.epochId,
      lifecycle: "applied",
      appliedHead: "head-1",
    },
  ]);
});

test("the upgrade rewrites only the apply phase and is idempotent", async () => {
  const dataRoot = await legacyDataRoot();
  const before = await epochFiles(dataRoot);

  await new FileNativeWorldRevisionStore(dataRoot).listEpochs("world-applied");
  const once = await epochFiles(dataRoot);

  for (const [name, text] of before) {
    const legacy = JSON.parse(text) as { worldId: string; apply: object };
    if (["world-applied", "world-control"].includes(legacy.worldId)) {
      expect(JSON.parse(once.get(name)!)).toEqual({
        ...legacy,
        apply: { ...legacy.apply, phase: "committed" },
      });
    } else {
      expect(once.get(name)).toBe(text);
    }
  }

  // A later process over the upgraded files rewrites nothing.
  const later = new FileNativeWorldRevisionStore(dataRoot);
  await later.listEpochs("world-applied");
  await later.listEpochs("world-control");
  expect(await epochFiles(dataRoot)).toEqual(once);
});

test("a v0.7.4 applying epoch with control published resumes as committed", async () => {
  const dataRoot = await legacyDataRoot();
  const store = new FileNativeWorldRevisionStore(dataRoot);

  const [epoch] = await store.listEpochs("world-control");
  expect(epoch).toMatchObject({
    lifecycle: "applying",
    apply: { phase: "committed", committedHead: "head-1" },
  });
});

test("a v0.7.4 applying epoch in prepared is left unchanged", async () => {
  const dataRoot = await legacyDataRoot();
  const store = new FileNativeWorldRevisionStore(dataRoot);

  const [epoch] = await store.listEpochs("world-prepared");
  expect(epoch).toMatchObject({
    lifecycle: "applying",
    apply: { phase: "prepared", committedHead: null },
  });
  const { name, text } = await fixtureEpoch("world-prepared");
  expect((await epochFiles(dataRoot)).get(name)).toBe(text);
});

test("a v0.7.4 applying epoch in state_committed is rejected without rewriting", async () => {
  const dataRoot = await legacyDataRoot();
  const store = new FileNativeWorldRevisionStore(dataRoot);
  const { name, text } = await fixtureEpoch("world-state");
  const epochId = name.slice(0, -".json".length);

  const listed = await store
    .listEpochs("world-state")
    .catch((error: unknown) => error);
  expect(listed).toBeInstanceOf(UnsupportedLegacyWorldRevisionError);
  expect(listed).toMatchObject({ code: "unsupported_legacy_world_revision" });
  expect(listed).toHaveProperty(
    "message",
    expect.stringContaining("open it once with v0.7.4"),
  );
  await expect(store.readEpoch(epochId)).rejects.toBeInstanceOf(
    UnsupportedLegacyWorldRevisionError,
  );

  expect((await epochFiles(dataRoot)).get(name)).toBe(text);
});

test("a world with a blocked epoch does not stop other worlds from listing", async () => {
  const dataRoot = await legacyDataRoot();
  const store = new FileNativeWorldRevisionStore(dataRoot);

  expect(await store.listEpochs("world-applied")).toHaveLength(1);
  expect(await store.listEpochs("world-prepared")).toHaveLength(1);
});

test("a damaged epoch in another world does not make listEpochs throw", async () => {
  const dataRoot = await legacyDataRoot();
  const damagedId = `revision-${randomUUID()}`;
  const applied = JSON.parse((await fixtureEpoch("world-applied")).text) as {
    apply: object;
  };
  await writeFile(
    join(dataRoot, "world-revisions", "epochs", `${damagedId}.json`),
    `${JSON.stringify({
      ...applied,
      epochId: damagedId,
      worldId: "world-damaged",
      revision: "not-a-revision",
    })}\n`,
  );
  const store = new FileNativeWorldRevisionStore(dataRoot);

  expect(await store.listEpochs("world-applied")).toHaveLength(1);
  await expect(store.listEpochs("world-damaged")).rejects.toThrow(
    "World-revision epoch does not match its durable schema",
  );
});
