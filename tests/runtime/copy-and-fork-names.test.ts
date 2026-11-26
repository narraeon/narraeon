import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { V1Request } from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/ContentWorkspace.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("content copies use localized distinct titles and reuse a committed operation", async () => {
  const { request, restart } = await runtimeFixture();
  await request({ type: "preferences.save", locale: "zh-CN" });
  const source = await request<EditableContentPackageDetail>({
    type: "content.create-sample",
    locale: "zh-CN",
  });
  const base = "雨灯旅店";
  await request({
    type: "content.rename",
    packageId: source.localId,
    name: base,
  });
  const occupied = await request<EditableContentPackageDetail>({
    type: "content.create",
  });
  await request({
    type: "content.rename",
    packageId: occupied.localId,
    name: `${base} · 副本`,
  });
  const command = {
    type: "content.copy",
    packageId: source.localId,
    operationId: "copy-same-operation",
  } as const;
  const copy = () => request<EditableContentPackageDetail>(command);
  const [first, replayed] = await Promise.all([copy(), copy()]);
  expect(first.title).toBe(`${base} · 副本 2`);
  expect(replayed.localId).toBe(first.localId);

  const sibling = await request<EditableContentPackageDetail>({
    ...command,
    operationId: "copy-sibling",
  });
  expect(sibling.title).toBe(`${base} · 副本 3`);
  const original = await request<EditableContentPackageDetail>({
    type: "content.read",
    packageId: source.localId,
  });
  expect(first.files).toEqual(original.files);
  expect(original.title).toBe(base);

  await request({
    type: "content.rename",
    packageId: first.localId,
    name: `${base} · 副本`,
  });
  await request({ type: "preferences.save", locale: "en" });
  await restart();
  expect(await copy()).toMatchObject({
    localId: first.localId,
    title: `${base} · 副本`,
  });
  await expect(
    request({ ...command, packageId: sibling.localId }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  const nested = await request<EditableContentPackageDetail>({
    type: "content.copy",
    packageId: first.localId,
  });
  expect(nested.title).toBe(`${base} · 副本 · Copy`);

  const long = "🕯️".repeat(80);
  await request({
    type: "content.rename",
    packageId: nested.localId,
    name: long,
  });
  const longCopy = await request<EditableContentPackageDetail>({
    type: "content.copy",
    packageId: nested.localId,
  });
  expect(longCopy.title).toBe(`${"🕯️".repeat(76)}… · Copy`);
  const { contentPackages } = await request<{
    contentPackages: { localId: string; title: string }[];
  }>({ type: "workspace.read" });
  expect(contentPackages.map(({ title }) => title).sort()).toEqual(
    [
      base,
      `${base} · 副本`,
      `${base} · 副本`,
      sibling.title,
      long,
      longCopy.title,
    ].sort(),
  );
});

test("world forks reserve distinct titles across sources and keep the title on retry", async () => {
  const { request, restart } = await runtimeFixture();
  const source = await request<EditableContentPackageDetail>({
    type: "content.create-sample",
    locale: "en",
  });
  const base = "Lantern Inn";
  const create = async (operationId: string, name: string) =>
    await request<{ world: World }>({
      type: "world.create",
      operationId,
      packageId: source.localId,
    }).then(async ({ world }) => {
      return request<World>({
        type: "world.rename",
        worldId: world.worldId,
        name,
      });
    });
  const [one, sameName, occupied] = await Promise.all([
    create("world-one", base),
    create("world-two", base),
    create("world-occupied", `${base} · Fork`),
  ]);
  const fork = async (
    operationId: string,
    sourceWorldId: string,
    sourceHead = "current",
  ) =>
    (
      await request<{ world: World }>({
        type: "world.derive",
        operationId,
        sourceWorldId,
        sourceHead,
      })
    ).world;
  const [oneFork, otherFork] = await Promise.all([
    fork("copy-world-one", one.worldId),
    fork("copy-world-two", sameName.worldId, "genesis"),
  ]);
  expect([oneFork.title, otherFork.title].sort()).toEqual([
    `${base} · Fork 2`,
    `${base} · Fork 3`,
  ]);
  const sibling = await fork("copy-world-sibling", one.worldId);
  expect(sibling.title).toBe(`${base} · Fork 4`);
  expect(
    new Set([
      one.worldId,
      sameName.worldId,
      occupied.worldId,
      oneFork.worldId,
      otherFork.worldId,
      sibling.worldId,
    ]).size,
  ).toBe(6);
  await request({ type: "preferences.save", locale: "zh-CN" });
  await restart();
  expect(await fork("copy-world-one", one.worldId)).toEqual(oneFork);
  const nested = await fork("nested-world-fork", oneFork.worldId, "genesis");
  expect(nested.title).toBe(`${oneFork.title} · 分叉`);
  const { worlds } = await request<{ worlds: World[] }>({
    type: "workspace.read",
  });
  expect(worlds.map(({ title }) => title).sort()).toEqual(
    [
      base,
      base,
      occupied.title,
      oneFork.title,
      otherFork.title,
      sibling.title,
      nested.title,
    ].sort(),
  );
});

interface World {
  worldId: string;
  title: string;
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-copy-fork-names-"));
  roots.push(root);
  const make = () =>
    new V1Runtime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
    });
  let runtime = make();
  await runtime.initialize();
  return {
    request: <T>(command: V1Request) =>
      runtime.handle(command).then(({ result }) => result as T),
    restart: async () => {
      runtime = make();
      await runtime.initialize();
    },
  };
}
