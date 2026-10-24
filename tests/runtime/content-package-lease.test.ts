import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CurrentTreeContentLibrary,
  CurrentTreeContentPackageBusyError,
} from "../../src/runtime/content/CurrentTreeContentLibrary.ts";
import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "narraeon-package-lease-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function edited(
  files: readonly { path: string; contents: string; encoding?: "base64" }[],
  path: string,
  contents: string,
) {
  return files.map((file) =>
    file.path === path ? { ...file, contents } : file,
  );
}

function legacyLockMarker(pid: number): string {
  return `${JSON.stringify({ schemaVersion: 1, pid, token: randomUUID() })}\n`;
}

describe("内容包操作租约只在进程内互斥", () => {
  test("旧版本遗留的 pid 锁文件（pid 等于当前进程）不阻止新的库实例保存，并删除该目录", async () => {
    const content = new ContentWorkspace(root);
    const created = await content.createCurrentTreeContentPackage();
    const base = await content.readCurrentTreeContentPackage(created.localId);
    const locksRoot = join(root, "content", ".package-locks");
    await mkdir(locksRoot, { recursive: true });
    await writeFile(
      join(locksRoot, `${created.localId}.mutation`),
      legacyLockMarker(process.pid),
    );
    await writeFile(
      join(locksRoot, `${created.localId}.reclaim`),
      legacyLockMarker(process.pid),
    );

    const restarted = new ContentWorkspace(root);
    const saved = await restarted.replaceCurrentTreeContentPackage(
      created.localId,
      edited(base.files, "control/frame.yaml", "after restart"),
      { baseTreeRevision: base.treeRevision, waitForLease: false },
    );
    expect(
      saved.files.find((file) => file.path === "control/frame.yaml"),
    ).toMatchObject({ contents: "after restart" });

    const again = await restarted.replaceCurrentTreeContentPackage(
      created.localId,
      edited(saved.files, "control/frame.yaml", "waiting save"),
      { baseTreeRevision: saved.treeRevision },
    );
    expect(again.treeRevision).not.toBe(saved.treeRevision);
    await expect(stat(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("同一进程内同一内容包的租约互斥", () => {
  test("不等待的第二个获取得到忙碌错误；等待式的第二个在第一个释放后取得", async () => {
    const library = new CurrentTreeContentLibrary(root);
    const created = await library.createPackage({ title: "lease" });
    const first = await library.acquireOperationLease(created.localId);

    await expect(
      library.acquireOperationLease(created.localId, { wait: false }),
    ).rejects.toBeInstanceOf(CurrentTreeContentPackageBusyError);

    let secondAcquired = false;
    const second = library
      .acquireOperationLease(created.localId, { wait: true })
      .then((lease) => {
        secondAcquired = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);

    first.release();
    const lease = await second;
    expect(lease.package.localId).toBe(created.localId);
    lease.release();
  });

  test("同一进程的另一个库实例同样受租约互斥约束", async () => {
    const created = await new CurrentTreeContentLibrary(root).createPackage({
      title: "shared",
    });
    const held = await new CurrentTreeContentLibrary(
      root,
    ).acquireOperationLease(created.localId);

    await expect(
      new CurrentTreeContentLibrary(root).acquireOperationLease(
        created.localId,
        { wait: false },
      ),
    ).rejects.toBeInstanceOf(CurrentTreeContentPackageBusyError);

    held.release();
    const lease = await new CurrentTreeContentLibrary(
      root,
    ).acquireOperationLease(created.localId, { wait: false });
    lease.release();
  });

  test("设定完善结算持有租约期间，同一内容包的手动保存忙碌或等待，其他内容包不受影响", async () => {
    const content = new ContentWorkspace(root);
    const target = await content.createCurrentTreeContentPackage();
    const other = await content.createCurrentTreeContentPackage();
    const targetBase = await content.readCurrentTreeContentPackage(
      target.localId,
    );
    const otherBase = await content.readCurrentTreeContentPackage(
      other.localId,
    );

    // Settlement of a setting-improvement tool response holds the package
    // lease the same way while it publishes the settled tree.
    const settlement = await content.beginCurrentTreeContentPackageOperation(
      target.localId,
    );
    try {
      await expect(
        content.replaceCurrentTreeContentPackage(
          target.localId,
          edited(targetBase.files, "control/frame.yaml", "manual save"),
          { baseTreeRevision: targetBase.treeRevision, waitForLease: false },
        ),
      ).rejects.toBeInstanceOf(CurrentTreeContentPackageBusyError);

      const otherSaved = await content.replaceCurrentTreeContentPackage(
        other.localId,
        edited(otherBase.files, "control/frame.yaml", "other package"),
        { baseTreeRevision: otherBase.treeRevision, waitForLease: false },
      );
      expect(otherSaved.treeRevision).not.toBe(otherBase.treeRevision);

      const pending = content.replaceCurrentTreeContentPackage(
        target.localId,
        edited(targetBase.files, "control/frame.yaml", "waited save"),
        { baseTreeRevision: targetBase.treeRevision },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      settlement.release();

      const saved = await pending;
      expect(
        saved.files.find((file) => file.path === "control/frame.yaml"),
      ).toMatchObject({ contents: "waited save" });
    } finally {
      settlement.release();
    }
  });
});
