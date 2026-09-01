import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { createZip } from "../support/createZip.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("YAML/Markdown 内容包当前树", () => {
  test("新建内容包直接得到可供 AI 扩展的最小有效树", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));

    const created = await workspace.createCurrentTreeContentPackage();
    const detail = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    expect(created).toMatchObject({
      title: "Untitled content package",
      status: "usable",
      documentCount: 1,
      issueCount: 0,
    });
    expect(detail.files.map(({ path }) => path)).toEqual([
      "control/blocks/world.md",
      "control/frame.yaml",
      "control/player-views.yaml",
      "opening.md",
      "world/current-situation.yaml",
    ]);
    expect(detail.files.every(({ path }) => !path.endsWith(".json"))).toBe(
      true,
    );
    expect(
      detail.files.find(({ path }) => path === "world/current-situation.yaml")
        ?.contents,
    ).toContain("title: Current situation");
    const frame = detail.files.find(
      ({ path }) => path === "control/frame.yaml",
    )?.contents;
    if (frame === undefined)
      throw new Error("New content package is missing control/frame.yaml");
    expect(frame).toContain(
      "kind: catalog, directory: characters, maxEntries: 24, required: false",
    );
    expect(frame.indexOf("kind: catalog")).toBeLessThan(
      frame.indexOf("kind: current_situation"),
    );
    expect(
      detail.files.find(({ path }) => path === "opening.md")?.contents,
    ).toMatch(/You|before you|threshold/u);
  });

  test("安全但不完整的业务树可导入、诊断、修复并作为独立同名副本导出", async () => {
    const root = await temporaryRoot();
    const source = createZip([
      {
        path: "world/characters/alex.yaml",
        contents: character(),
      },
    ]);
    const workspace = new ContentWorkspace(join(root, "data"));

    const imported =
      await workspace.importPortableContentPackageArchive(source);
    expect(imported).toMatchObject({
      title: "Imported content package",
      status: "needs_repair",
      documentCount: 1,
    });
    expect(imported.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing_opening",
        "missing_world_frame",
        "missing_current_situation",
      ]),
    );

    const completeFiles = [
      { path: "opening.md", contents: opening() },
      { path: "world/characters/alex.yaml", contents: character() },
      { path: "world/current-situation.yaml", contents: currentSituation() },
      { path: "world/rules/cultivation.md", contents: cultivation() },
      { path: "control/frame.yaml", contents: frame() },
      {
        path: "control/blocks/world.md",
        contents:
          "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
      },
      { path: "control/player-views.yaml", contents: playerView() },
    ];
    const repaired = await workspace.replaceCurrentTreeContentPackage(
      imported.localId,
      completeFiles,
    );
    expect(repaired).toMatchObject({
      status: "usable",
      documentCount: 3,
      issueCount: 0,
    });

    const copied = await workspace.copyCurrentTreeContentPackage(
      imported.localId,
    );
    expect(copied.localId).not.toBe(imported.localId);
    expect(copied.title).toBe(repaired.title);
    expect(copied.files).toEqual(repaired.files);

    const exported = await workspace.exportCurrentTreeContentPackage(
      imported.localId,
    );
    const archiveText = exported.archive.toString("utf8");
    expect(archiveText).not.toMatch(
      /localId|manifest|revision|digest|current-tree\.json/u,
    );
  });

  test("便携 ZIP 上传与导出字节闭环，并拒绝危险 ZIP 而不发布半个内容包", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));
    const archive = createZip([
      { path: "opening.md", contents: opening() },
      { path: "world/characters/alex.yaml", contents: character() },
      {
        path: "world/current-situation.yaml",
        contents: currentSituation(),
      },
      { path: "world/rules/cultivation.md", contents: cultivation() },
      { path: "control/frame.yaml", contents: frame() },
      {
        path: "control/blocks/world.md",
        contents:
          "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
      },
      { path: "control/player-views.yaml", contents: playerView() },
      { path: "assets/map.bin", contents: Buffer.from([0xff, 0xfe]) },
    ]);

    const imported =
      await workspace.importPortableContentPackageArchive(archive);
    expect(imported).toMatchObject({ status: "usable", issueCount: 0 });
    expect(imported.files).toContainEqual({
      path: "assets/map.bin",
      contents: "//4=",
      encoding: "base64",
    });

    const exported = await workspace.exportCurrentTreeContentPackage(
      imported.localId,
    );
    const reimported = await workspace.importPortableContentPackageArchive(
      exported.archive,
    );
    expect(reimported.localId).not.toBe(imported.localId);
    expect(reimported.files).toEqual(imported.files);

    await expect(
      workspace.importPortableContentPackageArchive(
        createZip([{ path: "../outside.yaml", contents: "危险: true\n" }]),
      ),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(
      workspace.importPortableContentPackageArchive(
        Buffer.from("not a zip", "utf8"),
      ),
    ).rejects.toMatchObject({ code: "invalid_zip" });
    expect(await workspace.listCurrentTreeContentPackages()).toHaveLength(2);
  });

  test("导入和人工整批保存都拒绝二进制世界文档且不发布部分树", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));

    await expect(
      workspace.importPortableContentPackageArchive(
        createZip([
          {
            path: "world/characters/binary.yaml",
            contents: Buffer.from([0xff, 0xfe]),
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "unsupported_file_type" });
    expect(await workspace.listCurrentTreeContentPackages()).toEqual([]);

    const created = await workspace.createCurrentTreeContentPackage();
    const before = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );
    await expect(
      workspace.replaceCurrentTreeContentPackage(created.localId, [
        ...before.files,
        {
          path: "world/characters/binary.yaml",
          contents: "//4=",
          encoding: "base64",
        },
      ]),
    ).rejects.toThrow(/World documents.*UTF-8/u);
    expect(
      (await workspace.readCurrentTreeContentPackage(created.localId)).files,
    ).toEqual(before.files);
  });

  test("codec 拒绝危险 YAML、重复身份和悬空引用，但不解释开放世界值", () => {
    const workspace = new ContentWorkspace("/unused");
    const inspection = workspace.inspectCurrentTreeContentPackage([
      { path: "opening.md", contents: opening() },
      {
        path: "world/unsafe.yaml",
        contents: `${character()}危险: !include /etc/passwd\n`,
      },
      { path: "world/duplicate.yaml", contents: character() },
      { path: "world/duplicate-again.yaml", contents: character() },
      { path: "world/open-values.yaml", contents: openValues() },
      {
        path: "world/current-situation.yaml",
        contents: currentSituation("missing.person"),
      },
      { path: "control/frame.yaml", contents: frame() },
      {
        path: "control/blocks/world.md",
        contents: "# World Narration Rules\n",
      },
      { path: "control/player-views.yaml", contents: playerView() },
    ]);

    expect(inspection.status).toBe("needs_repair");
    expect(inspection.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "unsafe_yaml",
        "duplicate_id",
        "dangling_reference",
      ]),
    );
    expect(
      inspection.issues.map(({ message }) => message).join("\n"),
    ).not.toMatch(/好感度|修为.*无效|关系.*无效/u);
  });

  test("内容包生命周期直接投影 WorldDocumentStore 的文档诊断", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));
    const candidateFiles = [
      { path: "opening.md", contents: opening() },
      {
        path: "world/characters/alex.yaml",
        contents: characterWithUnexpectedHeaderField(),
      },
      { path: "world/current-situation.yaml", contents: currentSituation() },
      { path: "control/frame.yaml", contents: frame() },
      {
        path: "control/blocks/world.md",
        contents: "# World Narration Rules\n",
      },
      { path: "control/player-views.yaml", contents: playerView() },
      { path: "notes/verbatim.txt", contents: "  opaque 原文\r\n" },
    ];
    const inspection =
      workspace.inspectCurrentTreeContentPackage(candidateFiles);

    expect(inspection.status).toBe("needs_repair");
    const snapshotIssue = inspection.issues.find(
      ({ worldDocumentDiagnostic }) =>
        worldDocumentDiagnostic?.code === "document_header_invalid",
    );
    expect(snapshotIssue).toMatchObject({
      code: "invalid_document_header",
      path: "world/characters/alex.yaml",
    });
    expect(snapshotIssue?.worldDocumentDiagnostic).toMatchObject({
      code: "document_header_invalid",
      logicalPath: "world/characters/alex.yaml",
      documentId: "character.alex",
    });
    expect(snapshotIssue?.worldDocumentDiagnostic?.range?.start.line).toBe(2);

    const imported = await workspace.importPortableContentPackageArchive(
      createZip(candidateFiles),
    );
    const read = await workspace.readCurrentTreeContentPackage(
      imported.localId,
    );
    const saved = await workspace.replaceCurrentTreeContentPackage(
      imported.localId,
      candidateFiles,
    );
    const copied = await workspace.copyCurrentTreeContentPackage(
      imported.localId,
    );
    for (const package_ of [imported, read, saved, copied]) {
      expect(package_.status).toBe("needs_repair");
      expect(
        package_.issues.some(
          ({ worldDocumentDiagnostic }) =>
            worldDocumentDiagnostic?.code === "document_header_invalid",
        ),
      ).toBe(true);
      expect(package_.files).toContainEqual({
        path: "notes/verbatim.txt",
        contents: "  opaque 原文\r\n",
      });
    }
    await expect(
      workspace.exportCurrentTreeContentPackage(imported.localId),
    ).rejects.toThrow(
      /Only a complete, valid content package can be exported/u,
    );

    const repaired = await workspace.replaceCurrentTreeContentPackage(
      imported.localId,
      candidateFiles.map((file) =>
        file.path === "world/characters/alex.yaml"
          ? { ...file, contents: character() }
          : file,
      ),
    );
    expect(repaired.status).toBe("usable");
    const exported = await workspace.exportCurrentTreeContentPackage(
      imported.localId,
    );
    const reimported = await workspace.importPortableContentPackageArchive(
      exported.archive,
    );
    expect(reimported.files).toContainEqual({
      path: "notes/verbatim.txt",
      contents: "  opaque 原文\r\n",
    });
  });

  test.each([
    {
      label: "缺失",
      openingFiles: [],
      code: "missing_opening",
    },
    {
      label: "空白",
      openingFiles: [{ path: "opening.md", contents: " \n\t" }],
      code: "invalid_opening",
    },
    {
      label: "二进制",
      openingFiles: [
        { path: "opening.md", contents: "AAEC", encoding: "base64" as const },
      ],
      code: "invalid_opening",
    },
    {
      label: "超过 64 KiB",
      openingFiles: [{ path: "opening.md", contents: "开".repeat(22_000) }],
      code: "invalid_opening",
    },
    {
      label: "重复",
      openingFiles: [
        { path: "opening.md", contents: opening() },
        { path: "opening.md", contents: "第二份开场白。\n" },
      ],
      code: "invalid_opening",
    },
    {
      label: "含有不完整 Unicode",
      openingFiles: [{ path: "opening.md", contents: "\ud800" }],
      code: "invalid_opening",
    },
  ])("$label opening.md 使内容包待修复", ({ openingFiles, code }) => {
    const workspace = new ContentWorkspace("/unused");
    const inspection = workspace.inspectCurrentTreeContentPackage([
      ...openingFiles,
      { path: "world/characters/alex.yaml", contents: character() },
      { path: "world/current-situation.yaml", contents: currentSituation() },
      { path: "control/frame.yaml", contents: frame() },
      {
        path: "control/blocks/world.md",
        contents: "# World Narration Rules\n",
      },
      { path: "control/player-views.yaml", contents: playerView() },
    ]);

    expect(inspection.status).toBe("needs_repair");
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({ code, path: "opening.md" }),
    );
  });

  test("未手动改名的内容包标题也不随当前情境文档标题漂移", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));
    const created = await workspace.createCurrentTreeContentPackage();
    const before = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    await workspace.replaceCurrentTreeContentPackage(created.localId, [
      ...before.files.filter(
        ({ path }) => path !== "world/current-situation.yaml",
      ),
      {
        path: "world/current-situation.yaml",
        contents: currentSituation().replace(
          "title: 当前情境",
          "title: 暴雨中的码头",
        ),
      },
    ]);

    expect(
      (await workspace.readCurrentTreeContentPackage(created.localId)).title,
    ).toBe(before.title);
  });

  test("旧内容包第一次读取时把原显示名固化为独立标题", async () => {
    const root = await temporaryRoot();
    const dataRoot = join(root, "data");
    const first = new ContentWorkspace(dataRoot);
    const created = await first.createCurrentTreeContentPackage();
    const metadataPath = join(
      dataRoot,
      "content",
      "packages",
      created.localId,
      "local.json",
    );
    await writeFile(
      metadataPath,
      `${JSON.stringify({ schemaVersion: 1, localId: created.localId })}\n`,
      "utf8",
    );

    const restarted = new ContentWorkspace(dataRoot);
    const before = await restarted.readCurrentTreeContentPackage(
      created.localId,
    );
    expect(JSON.parse(await readFile(metadataPath, "utf8")) as unknown).toEqual(
      {
        schemaVersion: 2,
        localId: created.localId,
        title: before.title,
      },
    );
    await restarted.replaceCurrentTreeContentPackage(created.localId, [
      ...before.files.filter(
        ({ path }) => path !== "world/current-situation.yaml",
      ),
      {
        path: "world/current-situation.yaml",
        contents: currentSituation().replace(
          "title: 当前情境",
          "title: 暴雨中的码头",
        ),
      },
    ]);

    expect(
      (await restarted.readCurrentTreeContentPackage(created.localId)).title,
    ).toBe(before.title);
    const migratedMetadata: unknown = JSON.parse(
      await readFile(metadataPath, "utf8"),
    );
    expect(migratedMetadata).toEqual({
      schemaVersion: 2,
      localId: created.localId,
      title: before.title,
    });

    await writeFile(
      metadataPath,
      `${JSON.stringify({
        schemaVersion: 1,
        localId: created.localId,
        name: "旧包标题",
      })}\n`,
      "utf8",
    );
    expect(
      (
        await new ContentWorkspace(dataRoot).readCurrentTreeContentPackage(
          created.localId,
        )
      ).title,
    ).toBe("旧包标题");
    expect(JSON.parse(await readFile(metadataPath, "utf8")) as unknown).toEqual(
      {
        schemaVersion: 2,
        localId: created.localId,
        title: "旧包标题",
      },
    );
  });

  test("内容包改名只动本地外壳，不碰世界文档，也不随内容漂移", async () => {
    const root = await temporaryRoot();
    const workspace = new ContentWorkspace(join(root, "data"));
    const created = await workspace.createCurrentTreeContentPackage();
    const before = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );

    const renamed = await workspace.renameCurrentTreeContentPackage(
      created.localId,
      "  雾港来信  ",
    );
    expect(renamed.title).toBe("雾港来信");
    expect(
      (await workspace.exportCurrentTreeContentPackage(created.localId))
        .fileName,
    ).toBe("雾港来信.zip");

    // The title lives in the local shell, so content bytes must not change.
    const after = await workspace.readCurrentTreeContentPackage(
      created.localId,
    );
    expect(after.files).toEqual(before.files);
    expect(after.title).toBe("雾港来信");
    expect(
      (await workspace.listCurrentTreeContentPackages()).find(
        ({ localId }) => localId === created.localId,
      )?.title,
    ).toBe("雾港来信");

    // Changing the current-situation title does not replace the package title.
    await workspace.replaceCurrentTreeContentPackage(created.localId, [
      ...after.files.filter(
        ({ path }) => path !== "world/current-situation.yaml",
      ),
      {
        path: "world/current-situation.yaml",
        contents: currentSituation().replace(
          "title: 当前情境",
          "title: 别的场景",
        ),
      },
    ]);
    expect(
      (await workspace.readCurrentTreeContentPackage(created.localId)).title,
    ).toBe("雾港来信");

    await expect(
      workspace.renameCurrentTreeContentPackage(created.localId, "   "),
    ).rejects.toThrow(/content-package title/u);
    await expect(
      workspace.renameCurrentTreeContentPackage(created.localId, "坏\n名字"),
    ).rejects.toThrow(/content-package title/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-yaml-content-"));
  roots.push(root);
  return root;
}

function character(): string {
  return `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: 篮球队前锋，直率护短。\n  aliases: [Al]\n衣着: 白色运动背心\n修为: 菠萝\n关系:\n  Sam:\n    好感度: 150\n`;
}

function characterWithUnexpectedHeaderField(): string {
  return `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: 篮球队前锋，直率护短。\n  aliases: [Al]\n  internalVersion: 7\n衣着: 白色运动背心\n`;
}

function opening(): string {
  return "宿舍门在你面前砰地合上。Alex抱着球衣看向你，等你先开口。\n";
}

function openValues(): string {
  return `$document:\n  id: character.open-values\n  ref: open-values\n  title: 开放值\n  summary: 用于证明 Runtime 不解释世界语义。\n  aliases: []\n修为: 菠萝\n好感度: 150\n关系: 随作者自然表达\n`;
}

function currentSituation(target = "character.alex"): string {
  return `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 宿舍里的当前局面。\n  aliases: []\n人物:\n  - $ref: ${target}\n情况: 正在整理球衣。\n`;
}

function cultivation(): string {
  return `---\n$document:\n  id: rule.cultivation\n  ref: cultivation\n  title: 修炼规则\n  summary: 修炼境界的自然语言说明。\n  aliases: []\n---\n# 修炼规则\n\n境界由故事自然解释。\n`;
}

function frame(): string {
  return `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`;
}

function playerView(): string {
  return `format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 当前状态\n    items:\n      - id: clothes\n        label: 衣着\n        select: { document: character.alex, locator: { yaml: [衣着] } }\n`;
}
