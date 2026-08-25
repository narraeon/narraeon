import { describe, expect, test } from "vitest";

import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

describe("WorldDocumentStore open/query Interface", () => {
  test.each([
    {
      layout: "content_package" as const,
      logicalRoot: "world" as const,
      path: "world/hero.yaml",
      opaquePath: "state/ignored.yaml",
      contents: yamlDocument(),
      codec: "yaml" as const,
    },
    {
      layout: "world_state" as const,
      logicalRoot: "state" as const,
      path: "state/rules.md",
      opaquePath: "world/ignored.md",
      contents: markdownDocument(),
      codec: "markdown" as const,
    },
  ])(
    "$layout 只解析 $logicalRoot 布局并在入口冻结完整文件集",
    ({ layout, logicalRoot, path, opaquePath, contents, codec }) => {
      const files = [
        { path, contents },
        { path: opaquePath, contents: "这不是对应布局下的世界文档。" },
        {
          path: "assets/portrait.bin",
          contents: "AAEC",
          encoding: "base64" as const,
        },
      ];
      const snapshot = WorldDocumentStore.open({ layout, files });

      files[0]!.path = `${logicalRoot}/mutated.yaml`;
      files[0]!.contents = "调用方随后改写";
      files.push({
        path: `${logicalRoot}/late.yaml`,
        contents: yamlDocument(),
      });

      expect(snapshot).toMatchObject({
        layout,
        logicalRoot,
        status: "usable",
        diagnostics: [],
      });
      expect(snapshot.files).toEqual([
        { path, contents },
        { path: opaquePath, contents: "这不是对应布局下的世界文档。" },
        {
          path: "assets/portrait.bin",
          contents: "AAEC",
          encoding: "base64",
        },
      ]);

      const result = snapshot.query({
        kind: "catalog",
        directory: "",
        limit: 10,
      });
      expect(result).toMatchObject({
        kind: "catalog",
        ok: true,
        snapshotId: snapshot.id,
        snapshotStatus: "usable",
        scope: { layout, logicalRoot, directory: "" },
        coverage: { status: "complete", excludedDocuments: 0 },
        page: {
          unit: "entries",
          start: 0,
          end: 1,
          total: 1,
          complete: true,
          nextCursor: null,
        },
        entries: [
          {
            kind: "document",
            logicalPath: path,
            status: "queryable",
            document: {
              documentId: codec === "yaml" ? "character.hero" : "rule.lore",
              shortRef: codec === "yaml" ? "hero" : "lore",
              title: codec === "yaml" ? "主角" : "世界规则",
              codec,
              logicalPath: path,
            },
            diagnostics: [],
          },
        ],
      });
    },
  );

  test("待修复快照用稳定诊断隔离损坏文档，目录仍可观察合法文档", () => {
    const snapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "world/valid.yaml", contents: yamlDocument() },
        {
          path: "world/dangling.yaml",
          contents: yamlDocument({
            id: "place.gate",
            ref: "gate",
            title: "城门",
            body: "守卫: { $ref: character.missing }\n",
          }),
        },
        {
          path: "world/duplicate-a.yaml",
          contents: yamlDocument({ id: "item.key", ref: "key", title: "钥匙" }),
        },
        {
          path: "world/duplicate-b.yaml",
          contents: yamlDocument({
            id: "item.key",
            ref: "key",
            title: "备用钥匙",
          }),
        },
        {
          path: "world/bad-header.yaml",
          contents: `$document:\n  id: INVALID ID\n  ref: Bad Ref\n  title: 损坏\n  summary: 技术头损坏。\n正文: true\n`,
        },
        {
          path: "world/unsafe.yaml",
          contents: `${yamlDocument()}危险: !include /etc/passwd\n`,
        },
        {
          path: "world/ambiguous.md",
          contents: markdownDocument().replace(
            "魔法需要媒介。",
            "魔法需要媒介。\n\n## 魔法\n\n第二段同名章节。",
          ),
        },
        {
          path: "world/binary.yaml",
          contents: "AAEC",
          encoding: "base64",
        },
        { path: "world/image.png", contents: "not a document" },
        {
          path: "world/deep.yaml",
          contents: `${yamlDocument({ id: "place.deep", ref: "deep", title: "深处", body: "" })}${nestedYaml(66)}`,
        },
      ],
    });

    expect(snapshot.status).toBe("needs_repair");
    expect(new Set(snapshot.diagnostics.map(({ code }) => code))).toEqual(
      new Set([
        "capacity_exceeded",
        "document_header_invalid",
        "document_identity_duplicate",
        "document_identity_invalid",
        "document_reference_invalid",
        "document_short_ref_duplicate",
        "document_short_ref_invalid",
        "locator_ambiguous",
        "world_document_binary",
        "world_document_codec_unsupported",
        "yaml_invalid",
      ]),
    );
    expect(
      snapshot.diagnostics.find(
        ({ code, logicalPath }) =>
          code === "document_reference_invalid" &&
          logicalPath === "world/dangling.yaml",
      ),
    ).toMatchObject({
      documentId: "place.gate",
      locator: { yaml: ["守卫"] },
      range: {
        start: { line: 7, column: 7 },
        end: { line: 7 },
      },
    });
    expect(
      snapshot.diagnostics.every(
        ({ range }) =>
          range === undefined ||
          (range.start.offset <= range.end.offset &&
            range.start.byteOffset <= range.end.byteOffset),
      ),
    ).toBe(true);

    const catalog = snapshot.query({ kind: "catalog", directory: "" });
    if (catalog.kind !== "catalog" || !catalog.ok)
      throw new Error("目录查询意外失败");
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        logicalPath: "world/valid.yaml",
        status: "queryable",
      }),
    );
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        logicalPath: "world/dangling.yaml",
        status: "damaged",
        diagnostics: [
          expect.objectContaining({ code: "document_reference_invalid" }),
        ],
      }),
    );
    expect(catalog.coverage).toEqual({
      status: "complete",
      excludedDocuments: 0,
    });
  });

  test("待修复文档仍可读取、搜索和选择未受损节点", () => {
    const markdown = markdownDocument().replace(
      "魔法需要媒介。",
      "魔法需要媒介。\n\n## 魔法\n\n重复标题。\n\n## 地理\n\n北境仍可查询。",
    );
    const dangling = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "城门",
      body: `守卫: { $ref: character.missing }
天气: 晴朗
`,
    });
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        { path: "state/rules.md", contents: markdown },
        { path: "state/gate.yaml", contents: dangling },
      ],
    });

    expect(snapshot.status).toBe("needs_repair");
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore" },
        locator: { markdown: ["地理"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { markdown: "## 地理\n\n北境仍可查询。" },
    });
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore" },
        locator: { markdown: ["魔法"] },
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "locator_ambiguous" })],
    });
    expect(
      snapshot.query({
        kind: "literal_search",
        query: "北境仍可查询",
        within: { document: { shortRef: "lore" } },
      }),
    ).toMatchObject({
      kind: "literal_search",
      ok: true,
      coverage: { status: "complete", excludedDocuments: 0 },
      page: { total: 1 },
    });
    expect(
      snapshot.query({
        kind: "read_document",
        document: { shortRef: "lore" },
      }),
    ).toMatchObject({ kind: "read_document", ok: true });
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["天气"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: "晴朗" },
    });
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["守卫"] },
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [
        expect.objectContaining({ code: "document_reference_invalid" }),
      ],
    });
  });

  test("Markdown locator 忽略 fenced code block 中的伪标题", () => {
    const markdown = markdownDocument().replace(
      "魔法需要媒介。",
      "魔法需要媒介。\n\n```md\n## 伪标题\n```\n\n## 地理\n\n北境。",
    );
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [{ path: "state/rules.md", contents: markdown }],
    });

    expect(snapshot.status).toBe("usable");
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore" },
        locator: { markdown: ["伪标题"] },
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "locator_not_found" })],
    });
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore" },
        locator: { markdown: ["地理"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { markdown: "## 地理\n\n北境。" },
    });
  });

  test("读取、字面搜索和精确节点只投影目标内容与整文档引用", () => {
    const hero = yamlDocument({
      body: `衣着: Ａ级斗篷
盟友: { $ref: place.gate }
背包:
  - 名称: 水晶
    数量: 2
`,
    });
    const rules = markdownDocument().replace(
      "魔法需要媒介。",
      "魔法需要媒介。\n\n### 媒介\n\n水晶可以稳定施法。",
    );
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        { path: "state/characters/hero.yaml", contents: hero },
        {
          path: "state/places/gate.yaml",
          contents: yamlDocument({
            id: "place.gate",
            ref: "gate",
            title: "城门",
            body: "状态: 开放\n",
          }),
        },
        { path: "state/rules/lore.md", contents: rules },
        {
          path: "state/broken.yaml",
          contents: `${yamlDocument({ id: "item.broken", ref: "broken" })}危险: !load now\n`,
        },
        { path: "control/frame.yaml", contents: "opaque: true\n" },
      ],
    });

    const read = snapshot.query({
      kind: "read_document",
      document: { shortRef: "hero" },
      maxBytes: 65_536,
    });
    expect(read).toMatchObject({
      kind: "read_document",
      ok: true,
      snapshotId: snapshot.id,
      document: {
        documentId: "character.hero",
        shortRef: "hero",
        title: "主角",
        summary: "故事的主角。",
        aliases: ["旅人"],
      },
      codec: "yaml",
      body: `衣着: Ａ级斗篷
盟友: { $ref: place.gate }
背包:
  - 名称: 水晶
    数量: 2
`,
      page: {
        unit: "utf8_bytes",
        start: 0,
        end: Buffer.byteLength(
          `衣着: Ａ级斗篷
盟友: { $ref: place.gate }
背包:
  - 名称: 水晶
    数量: 2
`,
          "utf8",
        ),
        total: Buffer.byteLength(
          `衣着: Ａ级斗篷
盟友: { $ref: place.gate }
背包:
  - 名称: 水晶
    数量: 2
`,
          "utf8",
        ),
        complete: true,
        nextCursor: null,
      },
    });

    const yamlNode = snapshot.query({
      kind: "select_node",
      document: { documentId: "character.hero" },
      locator: { yaml: ["盟友"] },
    });
    expect(yamlNode).toMatchObject({
      kind: "select_node",
      ok: true,
      snapshotId: snapshot.id,
      node: {
        codec: "yaml",
        locator: { yaml: ["盟友"] },
        value: {
          $ref: "place.gate",
          target: {
            documentId: "place.gate",
            shortRef: "gate",
            title: "城门",
          },
        },
      },
      references: [
        {
          locator: { yaml: ["盟友"] },
          target: {
            documentId: "place.gate",
            shortRef: "gate",
            title: "城门",
          },
        },
      ],
    });

    const markdownNode = snapshot.query({
      kind: "select_node",
      document: { logicalPath: "state/rules/lore.md" },
      locator: { markdown: ["魔法", "媒介"] },
    });
    expect(markdownNode).toMatchObject({
      kind: "select_node",
      ok: true,
      node: {
        codec: "markdown",
        locator: { markdown: ["魔法", "媒介"] },
        markdown: "### 媒介\n\n水晶可以稳定施法。",
        range: {
          start: { offset: rules.indexOf("### 媒介"), line: 15, column: 1 },
        },
      },
    });

    const search = snapshot.query({
      kind: "literal_search",
      query: "a级",
      caseSensitive: false,
      limit: 10,
    });
    expect(search).toMatchObject({
      kind: "literal_search",
      ok: true,
      snapshotId: snapshot.id,
      scope: {
        layout: "world_state",
        logicalRoot: "state",
        query: "a级",
        caseSensitive: false,
        within: null,
      },
      coverage: { status: "partial", excludedDocuments: 1 },
      page: {
        unit: "matches",
        start: 0,
        end: 1,
        total: 1,
        complete: true,
      },
      matches: [
        {
          document: { documentId: "character.hero", shortRef: "hero" },
          text: "Ａ级",
          range: {
            start: {
              offset: hero.indexOf("Ａ级"),
              byteOffset: Buffer.byteLength(
                hero.slice(0, hero.indexOf("Ａ级")),
                "utf8",
              ),
              line: 7,
              column: 5,
            },
            end: { line: 7, column: 7 },
          },
        },
      ],
      diagnostics: [expect.objectContaining({ code: "yaml_invalid" })],
    });

    const referenceSearch = snapshot.query({
      kind: "literal_search",
      query: "place.gate",
      within: { document: { shortRef: "hero" } },
    });
    expect(referenceSearch).toMatchObject({
      kind: "literal_search",
      ok: true,
      matches: [
        {
          text: "place.gate",
          excerpt: { text: "盟友: { $ref: place.gate }" },
          referenceProjection: {
            text: "@gate",
            excerpt: "盟友: { $ref: @gate }",
          },
        },
      ],
    });

    const literalIdText = yamlDocument({
      id: "note.literal-id",
      ref: "literal-id",
      title: "普通文本",
      body: "备注: place.gate\n",
    });
    const literalSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        { path: "state/note.yaml", contents: literalIdText },
        {
          path: "state/gate.yaml",
          contents: yamlDocument({ id: "place.gate", ref: "gate" }),
        },
      ],
    });
    expect(
      literalSnapshot.query({ kind: "literal_search", query: "place.gate" }),
    ).toMatchObject({
      kind: "literal_search",
      ok: true,
      matches: [
        {
          text: "place.gate",
          referenceProjection: {
            text: "place.gate",
            excerpt: "备注: place.gate",
          },
        },
      ],
    });

    const invalidReferenceSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        {
          path: "state/secret.yaml",
          contents: yamlDocument({
            id: "note.secret",
            ref: "secret",
            body: "线索: { $ref: missing.secret-id }\n",
          }),
        },
      ],
    });
    expect(
      invalidReferenceSnapshot.query({
        kind: "literal_search",
        query: "missing.secret-id",
      }),
    ).toMatchObject({
      kind: "literal_search",
      ok: true,
      coverage: { status: "partial", excludedDocuments: 1 },
      page: { total: 0, complete: true },
      matches: [],
      diagnostics: [
        expect.objectContaining({ code: "document_reference_invalid" }),
      ],
    });

    const damaged = snapshot.query({
      kind: "read_document",
      document: { logicalPath: "state/broken.yaml" },
    });
    expect(damaged).toMatchObject({
      kind: "error",
      requestKind: "read_document",
      ok: false,
      snapshotId: snapshot.id,
      diagnostics: [expect.objectContaining({ code: "yaml_invalid" })],
    });

    const technicalHeaderSearch = snapshot.query({
      kind: "literal_search",
      query: "character.hero",
      within: { document: { shortRef: "hero" } },
    });
    expect(technicalHeaderSearch).toMatchObject({
      kind: "literal_search",
      ok: true,
      matches: [],
      page: { total: 0, complete: true },
    });
    const titleSearch = snapshot.query({
      kind: "literal_search",
      query: "主角",
      within: { document: { shortRef: "hero" } },
    });
    if (titleSearch.kind !== "literal_search" || !titleSearch.ok)
      throw new Error("元信息字面搜索失败");
    expect(
      titleSearch.matches.some(
        ({ text, range }) =>
          text === "主角" &&
          range.start.line === 4 &&
          range.start.column === 10,
      ),
    ).toBe(true);
  });

  test("opaque cursor 绑定快照及 catalog、search、read 的全部分页条件", () => {
    const files = [
      {
        path: "state/a.yaml",
        contents: yamlDocument({
          id: "place.alpha",
          ref: "alpha",
          title: "甲地",
          body: "描述: 红色斗篷在门边。\n",
        }),
      },
      {
        path: "state/b.yaml",
        contents: yamlDocument({
          id: "place.beta",
          ref: "beta",
          title: "乙地",
          body: "描述: 蓝色斗篷在窗边。\n",
        }),
      },
      {
        path: "state/c.yaml",
        contents: yamlDocument({
          id: "place.gamma",
          ref: "gamma",
          title: "丙地",
          body: "描述: 一切安静。\n",
        }),
      },
    ];
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files,
    });
    const otherSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files,
    });

    const firstCatalog = snapshot.query({ kind: "catalog", limit: 1 });
    if (firstCatalog.kind !== "catalog" || !firstCatalog.ok)
      throw new Error("首个目录页失败");
    expect(firstCatalog.page).toMatchObject({
      start: 0,
      end: 1,
      total: 3,
      complete: false,
    });
    expect(firstCatalog.page.nextCursor).toEqual(expect.any(String));
    const firstCursor = firstCatalog.page.nextCursor!;
    const secondCatalog = snapshot.query({
      kind: "catalog",
      limit: 1,
      cursor: firstCursor,
    });
    expect(secondCatalog).toMatchObject({
      kind: "catalog",
      ok: true,
      page: { start: 1, end: 2, total: 3, complete: false },
    });
    expect(firstCatalog.page.start).toBe(0);

    for (const rejected of [
      snapshot.query({ kind: "catalog", limit: 2, cursor: firstCursor }),
      snapshot.query({
        kind: "catalog",
        directory: "other",
        limit: 1,
        cursor: firstCursor,
      }),
      snapshot.query({
        kind: "catalog",
        limit: 1,
        cursor: `${firstCursor.slice(0, -1)}x`,
      }),
      snapshot.query({
        kind: "catalog",
        limit: 1,
        cursor: `${firstCursor}!`,
      }),
      otherSnapshot.query({
        kind: "catalog",
        limit: 1,
        cursor: firstCursor,
      }),
    ])
      expect(rejected).toMatchObject({
        kind: "error",
        ok: false,
        diagnostics: [expect.objectContaining({ code: "cursor_invalid" })],
      });

    const firstSearch = snapshot.query({
      kind: "literal_search",
      query: "斗篷",
      limit: 1,
    });
    if (firstSearch.kind !== "literal_search" || !firstSearch.ok)
      throw new Error("首个搜索页失败");
    expect(firstSearch.page).toMatchObject({
      start: 0,
      end: 1,
      total: 2,
      complete: false,
    });
    expect(
      snapshot.query({
        kind: "literal_search",
        query: "安静",
        limit: 1,
        cursor: firstSearch.page.nextCursor,
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "cursor_invalid" })],
    });

    const firstRead = snapshot.query({
      kind: "read_document",
      document: { shortRef: "alpha" },
      maxBytes: 16,
    });
    if (firstRead.kind !== "read_document" || !firstRead.ok)
      throw new Error("首个读取页失败");
    expect(firstRead.page).toMatchObject({
      start: 0,
      complete: false,
    });
    expect(typeof firstRead.page.nextCursor).toBe("string");
    expect(
      snapshot.query({
        kind: "read_document",
        document: { shortRef: "alpha" },
        maxBytes: 32,
        cursor: firstRead.page.nextCursor,
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "cursor_invalid" })],
    });
    const secondRead = snapshot.query({
      kind: "read_document",
      document: { shortRef: "alpha" },
      maxBytes: 16,
      cursor: firstRead.page.nextCursor,
    });
    expect(secondRead).toMatchObject({
      kind: "read_document",
      ok: true,
      page: { start: firstRead.page.end },
    });

    expect(snapshot.query({ kind: "unknown" } as never)).toMatchObject({
      kind: "error",
      requestKind: null,
      diagnostics: [expect.objectContaining({ code: "query_invalid" })],
    });
  });

  test("封闭请求拒绝额外字段，locator 诊断稳定且查询不冻结调用方输入", () => {
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: [{ path: "state/hero.yaml", contents: yamlDocument() }],
    });
    const locator = { yaml: ["衣着"] };
    const selected = snapshot.query({
      kind: "select_node",
      document: { shortRef: "hero" },
      locator,
    });

    expect(Object.isFrozen(locator)).toBe(false);
    expect(Object.isFrozen(locator.yaml)).toBe(false);
    locator.yaml[0] = "调用方后来改写";
    expect(selected).toMatchObject({
      kind: "select_node",
      ok: true,
      scope: { locator: { yaml: ["衣着"] } },
      node: { locator: { yaml: ["衣着"] }, value: "灰色斗篷" },
    });

    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "hero" },
        locator: { markdown: ["衣着"] },
      }),
    ).toMatchObject({
      kind: "error",
      requestKind: "select_node",
      diagnostics: [
        expect.objectContaining({
          code: "locator_invalid",
          logicalPath: "state/hero.yaml",
          documentId: "character.hero",
        }),
      ],
    });
    const missingLocator = snapshot.query({
      kind: "select_node",
      document: { shortRef: "hero" },
      locator: { yaml: ["不存在"] },
    });
    expect(missingLocator).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "locator_not_found" })],
    });
    if (missingLocator.kind !== "error")
      throw new Error("缺失 locator 应返回结构化失败");
    expect(missingLocator.document?.shortRef).toBe("hero");

    const extraFieldRequest = { kind: "catalog", limit: 10, semantic: true };
    expect(snapshot.query(extraFieldRequest as never)).toMatchObject({
      kind: "error",
      requestKind: "catalog",
      diagnostics: [expect.objectContaining({ code: "query_invalid" })],
    });
    expect(Object.isFrozen(extraFieldRequest)).toBe(false);

    expect(
      snapshot.query({
        kind: "literal_search",
        query: "主角",
        within: null,
      } as never),
    ).toMatchObject({
      kind: "error",
      requestKind: "literal_search",
      diagnostics: [expect.objectContaining({ code: "query_invalid" })],
    });
    expect(
      snapshot.query({
        kind: "select_node",
        document: { shortRef: "hero" },
      } as never),
    ).toMatchObject({
      kind: "error",
      requestKind: "select_node",
      diagnostics: [expect.objectContaining({ code: "query_invalid" })],
    });
  });
});

function yamlDocument(
  options: {
    id?: string;
    ref?: string;
    title?: string;
    body?: string;
  } = {},
): string {
  return `$document:
  id: ${options.id ?? "character.hero"}
  ref: ${options.ref ?? "hero"}
  title: ${options.title ?? "主角"}
  summary: 故事的主角。
  aliases: [旅人]
${options.body ?? "衣着: 灰色斗篷\n"}`;
}

function markdownDocument(): string {
  return `---
$document:
  id: rule.lore
  ref: lore
  title: 世界规则
  summary: 世界运行的长篇规则。
  aliases: []
---
# 世界规则

## 魔法

魔法需要媒介。
`;
}

function nestedYaml(depth: number): string {
  return `${Array.from({ length: depth }, (_, index) => `${"  ".repeat(index)}层${index}:`).join("\n")}\n${"  ".repeat(depth)}值: 到达\n`;
}
