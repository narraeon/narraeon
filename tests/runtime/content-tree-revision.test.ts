import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseV1Envelope,
  V1ProtocolError,
  type V1Request,
  v1Protocol,
} from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { ContentTreeConflictError } from "../../src/runtime/content/CurrentTreeContentLibrary.ts";
import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "narraeon-tree-revision-"));
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

describe("内容包当前树版本", () => {
  test("读取详情带上树版本；树内容不变时版本稳定，内容改变时版本改变", async () => {
    const content = new ContentWorkspace(root);
    const created = await content.createCurrentTreeContentPackage();
    const first = await content.readCurrentTreeContentPackage(created.localId);
    const again = await content.readCurrentTreeContentPackage(created.localId);
    expect(first.treeRevision).toEqual(expect.any(String));
    expect(again.treeRevision).toBe(first.treeRevision);

    const changed = await content.replaceCurrentTreeContentPackage(
      created.localId,
      edited(first.files, "control/frame.yaml", "changed"),
      { baseTreeRevision: first.treeRevision },
    );
    expect(changed.treeRevision).not.toBe(first.treeRevision);
  });

  test("读取后另一来源发布变更，旧 baseTreeRevision 的保存被拒绝，当前树不变", async () => {
    const content = new ContentWorkspace(root);
    const created = await content.createCurrentTreeContentPackage();
    const draftBase = await content.readCurrentTreeContentPackage(
      created.localId,
    );
    const otherTab = edited(draftBase.files, "control/frame.yaml", "other tab");
    await content.replaceCurrentTreeContentPackage(created.localId, otherTab, {
      baseTreeRevision: draftBase.treeRevision,
    });

    const stale = content.replaceCurrentTreeContentPackage(
      created.localId,
      edited(draftBase.files, "control/frame.yaml", "stale draft"),
      { baseTreeRevision: draftBase.treeRevision },
    );
    await expect(stale).rejects.toBeInstanceOf(ContentTreeConflictError);

    const current = await content.readCurrentTreeContentPackage(
      created.localId,
    );
    expect(current.files).toEqual(otherTab);
  });

  test("用当前版本保存成功，返回的详情带新版本", async () => {
    const content = new ContentWorkspace(root);
    const created = await content.createCurrentTreeContentPackage();
    const base = await content.readCurrentTreeContentPackage(created.localId);
    const saved = await content.replaceCurrentTreeContentPackage(
      created.localId,
      edited(base.files, "control/frame.yaml", "saved"),
      { baseTreeRevision: base.treeRevision },
    );
    expect(
      saved.files.find((f) => f.path === "control/frame.yaml"),
    ).toMatchObject({ contents: "saved" });
    expect(saved.treeRevision).not.toBe(base.treeRevision);
    expect(
      (await content.readCurrentTreeContentPackage(created.localId))
        .treeRevision,
    ).toBe(saved.treeRevision);
  });

  test("设定完善 AI 的已发布写入之后，基于写入前树的保存被拒绝", async () => {
    const content = new ContentWorkspace(root);
    const created = await content.createCurrentTreeContentPackage();
    const draftBase = await content.readCurrentTreeContentPackage(
      created.localId,
    );
    // Setting improvement publishes its settled changes through the same
    // package lease it holds while it writes, so the draft's base goes stale.
    const lease = await content.beginCurrentTreeContentPackageOperation(
      created.localId,
    );
    try {
      await lease.replace(
        edited(draftBase.files, "control/frame.yaml", "AI published"),
      );
    } finally {
      lease.release();
    }

    await expect(
      content.replaceCurrentTreeContentPackage(
        created.localId,
        edited(draftBase.files, "control/frame.yaml", "author draft"),
        { baseTreeRevision: draftBase.treeRevision },
      ),
    ).rejects.toBeInstanceOf(ContentTreeConflictError);
    expect(
      (await content.readCurrentTreeContentPackage(created.localId)).files.find(
        (f) => f.path === "control/frame.yaml",
      ),
    ).toMatchObject({ contents: "AI published" });
  });
});

describe("content.replace 协议", () => {
  const call = async (runtime: V1Runtime, request: V1Request) =>
    (await runtime.handle(request)).result;

  test("缺少 baseTreeRevision 时返回 invalid_request，不写入任何文件", async () => {
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const created = (await call(runtime, { type: "content.create" })) as {
      localId: string;
    };
    const before = (await call(runtime, {
      type: "content.read",
      packageId: created.localId,
    })) as { files: { path: string; contents: string }[] };

    // The wire boundary rejects the envelope before any runtime handling runs.
    const wire = (() => {
      try {
        parseV1Envelope({
          protocol: v1Protocol,
          request: {
            type: "content.replace",
            packageId: created.localId,
            files: edited(before.files, "control/frame.yaml", "no base"),
          },
        });
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(wire).toBeInstanceOf(V1ProtocolError);
    expect(wire).toMatchObject({ code: "invalid_request" });
    expect(
      (await call(runtime, {
        type: "content.read",
        packageId: created.localId,
      })) as { files: unknown },
    ).toMatchObject({ files: before.files });
  });

  test("版本过期时返回 content_conflict 并附带当前树详情", async () => {
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const created = (await call(runtime, { type: "content.create" })) as {
      localId: string;
    };
    const base = (await call(runtime, {
      type: "content.read",
      packageId: created.localId,
    })) as {
      files: { path: string; contents: string }[];
      treeRevision: string;
    };
    await call(runtime, {
      type: "content.replace",
      packageId: created.localId,
      files: edited(base.files, "control/frame.yaml", "newer"),
      baseTreeRevision: base.treeRevision,
    });

    const rejected = runtime.handle({
      type: "content.replace",
      packageId: created.localId,
      files: edited(base.files, "control/frame.yaml", "stale"),
      baseTreeRevision: base.treeRevision,
    });
    await expect(rejected).rejects.toBeInstanceOf(V1ProtocolError);
    await expect(rejected).rejects.toMatchObject({ code: "content_conflict" });
    await rejected.catch((error: V1ProtocolError) => {
      const current = error.details?.current as {
        treeRevision: string;
        files: unknown;
      };
      expect(current.treeRevision).not.toBe(base.treeRevision);
      expect(current.files).toEqual(
        edited(base.files, "control/frame.yaml", "newer"),
      );
    });
  });
});
