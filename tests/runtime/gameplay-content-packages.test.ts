import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { gameplayFile, gameplayPath } from "../../src/protocol/gameplay.ts";
import { appLocales } from "../../src/protocol/appPreferences.ts";
import {
  parseV1Envelope,
  V1ProtocolError,
  v1Protocol,
} from "../../src/protocol/v1.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import {
  ContentWorkspace,
  InvalidContentTreeError,
} from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("内容包玩法身份", () => {
  test("默认新建为互动式小说，不写玩法文件，摘要与详情都暴露玩法", async () => {
    const workspace = new ContentWorkspace(join(await temporaryRoot(), "data"));

    const created = await workspace.createCurrentTreeContentPackage();
    const detail = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    expect(created.gameplay).toEqual({ mode: "interactive-fiction" });
    expect(detail.gameplay).toEqual({ mode: "interactive-fiction" });
    expect(detail.files.map(({ path }) => path)).not.toContain(gameplayPath);
    expect(await workspace.listCurrentTreeContentPackages()).toEqual([
      expect.objectContaining({ gameplay: { mode: "interactive-fiction" } }),
    ]);
  });

  test("跑团新建写入 control/gameplay.json，默认 d100 与显式 bag 都保留方案", async () => {
    const workspace = new ContentWorkspace(join(await temporaryRoot(), "data"));

    const d100 = await workspace.createCurrentTreeContentPackage({
      mode: "tabletop",
      scheme: "d100",
    });
    const bag = await workspace.createCurrentTreeContentPackage({
      mode: "tabletop",
      scheme: "bag",
    });

    const d100Detail = await workspace.readCurrentTreeContentPackage(
      d100.localId,
    );
    expect(d100.gameplay).toEqual({ mode: "tabletop", scheme: "d100" });
    expect(d100Detail.files).toContainEqual(
      gameplayFile({ mode: "tabletop", scheme: "d100" }),
    );
    expect(bag.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });
    expect(
      (await workspace.readCurrentTreeContentPackage(bag.localId)).files,
    ).toContainEqual(gameplayFile({ mode: "tabletop", scheme: "bag" }));
  });

  test("设定完善保存可以改判定方案，但拒绝改玩法模式且不发布部分树", async () => {
    const workspace = new ContentWorkspace(join(await temporaryRoot(), "data"));
    const created = await workspace.createCurrentTreeContentPackage({
      mode: "tabletop",
      scheme: "d100",
    });
    const current = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    const retargeted = await workspace.replaceCurrentTreeContentPackage(
      created.localId,
      current.files.map((file) =>
        file.path === gameplayPath
          ? gameplayFile({ mode: "tabletop", scheme: "d20" })
          : file,
      ),
      {
        baseTreeRevision: (
          await workspace.readCurrentTreeContentPackage(created.localId)
        ).treeRevision,
      },
    );
    expect(retargeted.gameplay).toEqual({ mode: "tabletop", scheme: "d20" });

    await expect(
      workspace.replaceCurrentTreeContentPackage(
        created.localId,
        retargeted.files.filter(({ path }) => path !== gameplayPath),
        {
          baseTreeRevision: (
            await workspace.readCurrentTreeContentPackage(created.localId)
          ).treeRevision,
        },
      ),
    ).rejects.toThrow(InvalidContentTreeError);
    await expect(
      workspace.replaceCurrentTreeContentPackage(
        created.localId,
        [
          ...retargeted.files.filter(({ path }) => path !== gameplayPath),
          gameplayFile({ mode: "interactive-fiction" }),
        ],
        {
          baseTreeRevision: (
            await workspace.readCurrentTreeContentPackage(created.localId)
          ).treeRevision,
        },
      ),
    ).rejects.toThrow(/Gameplay mode is fixed/u);
    expect(
      await workspace.readCurrentTreeContentPackage(created.localId),
    ).toMatchObject({
      gameplay: { mode: "tabletop", scheme: "d20" },
      files: retargeted.files,
    });
  });

  test("玩法文件损坏时检查报告 invalid_gameplay，且不把它当成不支持的 JSON", () => {
    const files = [
      { path: "opening.md", contents: "开场\n" },
      { path: gameplayPath, contents: "{ broken" },
    ];
    const inspection = inspectContentPackageCurrentTree(files);

    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_gameplay",
        path: gameplayPath,
      }),
    );
    expect(
      inspection.issues.filter(
        ({ code }) => code === "unsupported_content_file",
      ),
    ).toEqual([]);
    const otherJson = inspectContentPackageCurrentTree([
      { path: "control/other.json", contents: "{}" },
    ]);
    expect(otherJson.issues).toContainEqual(
      expect.objectContaining({
        code: "unsupported_content_file",
        path: "control/other.json",
      }),
    );
  });

  test("有效玩法文件不被报告为不支持的 JSON", async () => {
    const workspace = new ContentWorkspace(join(await temporaryRoot(), "data"));
    const created = await workspace.createCurrentTreeContentPackage({
      mode: "tabletop",
      scheme: "d100",
    });
    const detail = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    expect(detail.status).toBe("usable");
    expect(detail.issues).toEqual([]);
    await expect(
      workspace.replaceCurrentTreeContentPackage(
        created.localId,
        [
          ...detail.files.filter(({ path }) => path !== gameplayPath),
          { path: gameplayPath, contents: "{ broken" },
        ],
        {
          baseTreeRevision: (
            await workspace.readCurrentTreeContentPackage(created.localId)
          ).treeRevision,
        },
      ),
    ).rejects.toThrow(/valid JSON/u);
  });

  test("复制、ZIP 导出与导入都保留玩法文件和判定方案", async () => {
    const workspace = new ContentWorkspace(join(await temporaryRoot(), "data"));
    const created = await workspace.createCurrentTreeContentPackage({
      mode: "tabletop",
      scheme: "bag",
    });
    const source = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    const copied = await workspace.copyCurrentTreeContentPackage(
      created.localId,
    );
    expect(copied.localId).not.toBe(created.localId);
    expect(copied.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });
    expect(copied.files).toEqual(source.files);

    const exported = await workspace.exportCurrentTreeContentPackage(
      created.localId,
    );
    const imported = await workspace.importPortableContentPackageArchive(
      exported.archive,
    );
    expect(imported.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });
    expect(imported.files).toEqual(source.files);

    const fiction = await workspace.createCurrentTreeContentPackage();
    const fictionArchive = await workspace.exportCurrentTreeContentPackage(
      fiction.localId,
    );
    const importedFiction = await workspace.importPortableContentPackageArchive(
      fictionArchive.archive,
    );
    expect(importedFiction.gameplay).toEqual({ mode: "interactive-fiction" });
    expect(importedFiction.files.map(({ path }) => path)).not.toContain(
      gameplayPath,
    );
  });
});

describe("内容包玩法 V1 请求", () => {
  test("content.create 接受显式玩法，content.gameplay.set 只改跑团方案并持久保存", async () => {
    const root = await temporaryRoot();
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });

    const created = (await call(runtime, {
      type: "content.create",
      gameplay: { mode: "tabletop", scheme: "d100" },
    })) as { localId: string; gameplay: unknown };
    expect(created.gameplay).toEqual({ mode: "tabletop", scheme: "d100" });

    const set = (await call(runtime, {
      type: "content.gameplay.set",
      packageId: created.localId,
      scheme: "bag",
    })) as { gameplay: unknown; files: { path: string; contents: string }[] };
    expect(set.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });
    expect(set.files).toContainEqual(
      gameplayFile({ mode: "tabletop", scheme: "bag" }),
    );

    const restarted = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const workspace = (await call(restarted, { type: "workspace.read" })) as {
      contentPackages: { localId: string; gameplay: unknown }[];
    };
    expect(
      workspace.contentPackages.find(
        ({ localId }) => localId === created.localId,
      )?.gameplay,
    ).toEqual({ mode: "tabletop", scheme: "bag" });
  });

  test("content.gameplay.set 拒绝互动式小说包，默认 content.create 仍是小说", async () => {
    const root = await temporaryRoot();
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const fiction = (await call(runtime, { type: "content.create" })) as {
      localId: string;
      gameplay: unknown;
    };
    expect(fiction.gameplay).toEqual({ mode: "interactive-fiction" });

    const rejected = runtime.handle({
      type: "content.gameplay.set",
      packageId: fiction.localId,
      scheme: "d20",
    });
    await expect(rejected).rejects.toBeInstanceOf(V1ProtocolError);
    await expect(rejected).rejects.toThrow(/判定方案/u);
    const read = (await call(runtime, {
      type: "content.read",
      packageId: fiction.localId,
    })) as { files: { path: string }[] };
    expect(read.files.map(({ path }) => path)).not.toContain(gameplayPath);
  });

  test("示例内容包是互动式小说：创建、工作区摘要与导入导出往返都报告互动式小说", async () => {
    const root = await temporaryRoot();
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const fiction = { mode: "interactive-fiction" };
    for (const locale of appLocales) {
      const sample = (await call(runtime, {
        type: "content.create-sample",
        locale,
      })) as { localId: string; gameplay: unknown };
      expect(sample.gameplay).toEqual(fiction);
      const exported = (await call(runtime, {
        type: "content.export",
        packageId: sample.localId,
      })) as { base64: string };
      const imported = (await call(runtime, {
        type: "content.import",
        archiveBase64: exported.base64,
        title: "示例导入",
      })) as { localId: string; gameplay: unknown; files: { path: string }[] };
      expect(imported.gameplay).toEqual(fiction);
      expect(imported.files.map(({ path }) => path)).not.toContain(
        gameplayPath,
      );
    }
    const workspace = (await call(runtime, { type: "workspace.read" })) as {
      contentPackages: { gameplay: unknown }[];
    };
    expect(workspace.contentPackages).toHaveLength(appLocales.length * 2);
    for (const item of workspace.contentPackages)
      expect(item.gameplay).toEqual(fiction);
  });

  test("content.replace 改变玩法模式时返回 invalid_request，而不是内部错误", async () => {
    const root = await temporaryRoot();
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const created = (await call(runtime, {
      type: "content.create",
      gameplay: { mode: "tabletop", scheme: "d100" },
    })) as { localId: string };
    const current = (await call(runtime, {
      type: "content.read",
      packageId: created.localId,
    })) as { files: { path: string; contents: string }[] };

    const rejected = runtime.handle({
      type: "content.replace",
      packageId: created.localId,
      baseTreeRevision: (
        (await call(runtime, {
          type: "content.read",
          packageId: created.localId,
        })) as { treeRevision: string }
      ).treeRevision,
      files: [
        ...current.files.filter(({ path }) => path !== gameplayPath),
        gameplayFile({ mode: "interactive-fiction" }),
      ],
    });
    await expect(rejected).rejects.toBeInstanceOf(V1ProtocolError);
    await expect(rejected).rejects.toMatchObject({ code: "invalid_request" });
    await expect(rejected).rejects.toThrow(
      /Gameplay mode is fixed.*玩法模式不能/su,
    );
    expect(
      (await call(runtime, {
        type: "content.read",
        packageId: created.localId,
      })) as { gameplay: unknown },
    ).toMatchObject({ gameplay: { mode: "tabletop", scheme: "d100" } });
  });

  test("协议层拒绝未知判定方案和格式错误的玩法选择", () => {
    const request = (value: Record<string, unknown>) =>
      parseV1Envelope({ protocol: v1Protocol, request: value });
    expect(() =>
      request({ type: "content.gameplay.set", packageId: "p", scheme: "d6" }),
    ).toThrow(V1ProtocolError);
    expect(() =>
      request({ type: "content.gameplay.set", packageId: "p" }),
    ).toThrow(V1ProtocolError);
    expect(() =>
      request({ type: "content.create", gameplay: { mode: "tabletop" } }),
    ).toThrow(/content\.create\.gameplay is invalid/u);
    expect(() =>
      request({
        type: "content.create",
        gameplay: { mode: "interactive-fiction", scheme: "d20" },
      }),
    ).toThrow(/content\.create\.gameplay is invalid/u);
    expect(
      request({
        type: "content.create",
        gameplay: { mode: "tabletop", scheme: "bag" },
      }).request,
    ).toEqual({
      type: "content.create",
      gameplay: { mode: "tabletop", scheme: "bag" },
    });
  });
});

async function call(runtime: V1Runtime, request: V1Request) {
  return (await runtime.handle(request)).result;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-gameplay-content-"));
  roots.push(root);
  return root;
}
