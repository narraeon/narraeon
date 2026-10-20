import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  acquireDataRootLock,
  DataRootBusyError,
} from "../../src/runtime/config/dataRootLock.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-data-root-lock-"));
  roots.push(root);
  return root;
}

function exitedPid(): number {
  // A child that has exited: its pid is no longer a live process.
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return child.pid;
}

test("同一数据目录的第二个服务拒绝启动，释放后可以重新拿到启动锁", async () => {
  const root = await dataRoot();
  const first = await acquireDataRootLock(root);
  await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(
    DataRootBusyError,
  );
  await first.release();
  const second = await acquireDataRootLock(root);
  await second.release();
});

test("首个服务异常退出（owner pid 已不存在）后，重启可以拿到启动锁", async () => {
  const root = await dataRoot();
  await writeFile(join(root, "server.pid"), `${exitedPid()}\n`, "utf8");
  const lock = await acquireDataRootLock(root);
  expect(await readFile(join(root, "server.pid"), "utf8")).toBe(
    `${process.pid}\n`,
  );
  await lock.release();
});

test("启动时删除旧的操作回执（含导入回执），保留世界修订 epoch 标记", async () => {
  const root = await dataRoot();
  const operations = join(root, "operations");
  await mkdir(join(operations, "world-revision-locks"), { recursive: true });
  await writeFile(
    join(operations, "world-revision-locks", "world.json"),
    "{}",
    "utf8",
  );
  await writeFile(join(operations, "import-abc.json"), "{}", "utf8");
  await writeFile(join(operations, "create-world.json"), "{}", "utf8");

  const lock = await acquireDataRootLock(root);
  for (const receipt of ["import-abc.json", "create-world.json"])
    await expect(stat(join(operations, receipt))).rejects.toMatchObject({
      code: "ENOENT",
    });
  await expect(
    stat(join(operations, "world-revision-locks", "world.json")),
  ).resolves.toBeDefined();
  await lock.release();
});

test("启动时只剩旧回执的 operations 目录会被整体删除", async () => {
  const root = await dataRoot();
  await mkdir(join(root, "operations"), { recursive: true });
  await writeFile(join(root, "operations", "import-abc.json"), "{}", "utf8");

  const lock = await acquireDataRootLock(root);
  await expect(stat(join(root, "operations"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await lock.release();
});

test("启动时清理旧的世界锁、authority 锁与修正 claim 目录", async () => {
  const root = await dataRoot();
  const legacy = [
    join(root, "runtime-locks", "artifacts", "world"),
    join(root, "operations", "world-locks", "world"),
    join(root, "operations", "authority-locks", "world"),
    join(root, "operations", "correction-claims"),
  ];
  for (const path of legacy) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "owner.json"), "", "utf8");
  }
  const kept = join(root, "operations", "world-revision-locks");
  await mkdir(kept, { recursive: true });

  const lock = await acquireDataRootLock(root);
  for (const path of legacy) {
    await expect(readFile(join(path, "owner.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  await expect(stat(kept)).resolves.toMatchObject({});
  await lock.release();
});
