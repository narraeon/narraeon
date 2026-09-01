import { describe, expect, test } from "vitest";

import {
  WorldDocumentStore,
  type WorldDocumentCreateRevisionCommand,
  type WorldDocumentRevisionEdit,
} from "../../src/runtime/world/WorldDocumentStore.ts";

describe("WorldDocumentStore atomic candidate batch Interface", () => {
  test("create publishes a new YAML document snapshot and preserves every opaque file verbatim", () => {
    const opening = "雨停在门槛外。\n";
    const frame = "format: narraeon.world-frame/v1\n";
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "opening.md", contents: opening },
        { path: "control/frame.yaml", contents: frame },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "gate",
          logicalPath: "world/places/gate.yaml",
          codec: "yaml",
          refHint: "gate",
          title: "北门",
          summary: "风雪中的城门。",
          aliases: ["城门"],
          body: { 状态: "关闭" },
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "revision",
      ok: true,
      sourceSnapshotId: source.id,
      snapshotStatus: "usable",
      diagnostics: [],
    });
    if (!revised.ok) throw new Error("create revision unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      shortRef: "gate",
      codec: "yaml",
      before: null,
      after: { logicalPath: "world/places/gate.yaml" },
    });
    expect(revised.changes[0]?.documentId).toMatch(/^doc\.[a-f0-9]{32}$/u);
    expect(revised.changes[0]?.after.contents).toContain("状态: 关闭");
    expect(revised.changes[0]?.after.mechanicalHash).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );

    expect(revised.snapshot).not.toBe(source);
    expect(revised.files).toBe(revised.snapshot.files);
    expect(revised.files).toEqual(
      expect.arrayContaining([
        { path: "opening.md", contents: opening },
        { path: "control/frame.yaml", contents: frame },
      ]),
    );
    expect(source.files).toEqual([
      { path: "opening.md", contents: opening },
      { path: "control/frame.yaml", contents: frame },
    ]);
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["状态"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: "关闭" },
    });
  });

  test("YAML create accepts raw tool body source and resolves explicit short-reference handles", () => {
    const source = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        {
          path: "state/characters/alex.yaml",
          contents: yamlDocument({
            id: "character.alex",
            ref: "alex",
            title: "Alex",
            body: "衣着: 白色运动背心\n",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "trophy",
          logicalPath: "state/items/champion-trophy.yaml",
          codec: "yaml",
          refHint: "champion-trophy",
          title: "冠军奖杯",
          summary: "Alex珍视的冠军奖杯。",
          aliases: ["奖杯"],
          body: '归属:\n  $ref: "@alex"\n状态: 放在书桌上\n',
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("raw YAML create unexpectedly failed");
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "champion-trophy" },
        locator: { yaml: ["归属"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: { target: { shortRef: "alex" } } },
    });

    expect(
      source.revise({
        commands: [
          {
            kind: "create",
            temporaryName: "raw-id",
            logicalPath: "state/items/raw-id.yaml",
            codec: "yaml",
            refHint: "raw-id",
            title: "不应创建的文档",
            summary: "原始工具正文不能携带世界内部文档身份。",
            aliases: [],
            body: "归属:\n  $ref: character.alex\n",
          },
        ],
      }),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "document_reference_invalid" }),
      ],
    });
  });

  test("Markdown create keeps the requested codec and resolves a short-reference collision", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/rules/lore.md",
          contents: markdownDocument({
            id: "rule.lore",
            ref: "lore",
            title: "旧规则",
            body: "旧规则仍在。",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "new-lore",
          logicalPath: "world/rules/new-lore.md",
          codec: "markdown",
          refHint: "lore",
          title: "新规则",
          summary: "新增的长篇规则。",
          aliases: [],
          body: "# 新规则\n\n## 原则\n\n承诺必须兑现。\n",
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("Markdown create unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      shortRef: "lore-2",
      codec: "markdown",
      after: { logicalPath: "world/rules/new-lore.md" },
    });
    expect(revised.changes[0]?.after.contents).toContain("# 新规则");
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore-2" },
        locator: { markdown: ["原则"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { markdown: "## 原则\n\n承诺必须兑现。" },
    });
  });

  test("an ordered batch can target and reference a created document by temporary name", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/characters/hero.yaml",
          contents: yamlDocument({
            id: "character.hero",
            ref: "hero",
            title: "旅人",
            body: "衣着: 灰色斗篷\n",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "gate",
          logicalPath: "world/places/gate.yaml",
          codec: "yaml",
          refHint: "gate",
          title: "北门",
          summary: "风雪中的城门。",
          aliases: [],
          body: {},
        },
        {
          kind: "patch",
          document: { temporaryName: "gate" },
          edits: [{ op: "add", locator: { yaml: ["状态"] }, value: "关闭" }],
        },
        {
          kind: "patch",
          document: { shortRef: "hero" },
          edits: [
            {
              op: "add",
              locator: { yaml: ["位置"] },
              value: { $ref: { temporaryName: "gate" } },
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("ordered revision unexpectedly failed");
    expect(revised.changes).toHaveLength(2);
    expect(
      revised.changes.find(({ documentId }) => documentId === "character.hero"),
    ).toMatchObject({
      shortRef: "hero",
      before: { logicalPath: "world/characters/hero.yaml" },
    });
    expect(
      revised.changes.find(({ shortRef }) => shortRef === "gate"),
    ).toMatchObject({ before: null });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "hero" },
        locator: { yaml: ["位置"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: { target: { shortRef: "gate" } } },
    });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["状态"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: "关闭" },
    });
  });

  test("a later create can persist an explicit reference to an earlier temporary document", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "guard",
          logicalPath: "world/characters/guard.yaml",
          codec: "yaml",
          refHint: "guard",
          title: "守卫",
          summary: "北门守卫。",
          aliases: [],
          body: { 职责: "守门" },
        },
        {
          kind: "create",
          temporaryName: "gate",
          logicalPath: "world/places/gate.yaml",
          codec: "yaml",
          refHint: "gate",
          title: "北门",
          summary: "风雪中的城门。",
          aliases: [],
          body: { 守卫: { $ref: { temporaryName: "guard" } } },
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("create reference unexpectedly failed");
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["守卫"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: { target: { shortRef: "guard", title: "守卫" } } },
    });
  });

  test("move changes only the logical path while preserving identity, short reference, and bytes", () => {
    const hero = yamlDocument({
      id: "character.hero",
      ref: "hero",
      title: "旅人",
      body: "衣着: 灰色斗篷\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "world/characters/hero.yaml", contents: hero },
        { path: "notes/author.md", contents: "opaque\n" },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "move",
          document: { documentId: "character.hero" },
          toLogicalPath: "world/people/hero.yml",
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "revision",
      ok: true,
      changes: [
        {
          documentId: "character.hero",
          shortRef: "hero",
          codec: "yaml",
          before: {
            logicalPath: "world/characters/hero.yaml",
            contents: hero,
          },
          after: {
            logicalPath: "world/people/hero.yml",
            contents: hero,
          },
        },
      ],
    });
    if (!revised.ok) throw new Error("move revision unexpectedly failed");
    expect(revised.changes[0]?.before?.mechanicalHash).toBe(
      revised.changes[0]?.after.mechanicalHash,
    );
    expect(revised.files).toEqual(
      expect.arrayContaining([
        { path: "world/people/hero.yml", contents: hero },
        { path: "notes/author.md", contents: "opaque\n" },
      ]),
    );
    expect(source.files[0]).toEqual({
      path: "world/characters/hero.yaml",
      contents: hero,
    });
  });

  test("YAML patch applies ordered body and metadata edits without changing document identity", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/places/gate.yaml",
          contents: yamlDocument({
            id: "place.gate",
            ref: "gate",
            title: "旧城门",
            body: "状态: 关闭\n标签: [古老]\n临时标记: 待删除\n",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "gate" },
          edits: [
            {
              op: "replace",
              locator: { yaml: ["状态"] },
              value: "开放",
            },
            {
              op: "append",
              locator: { yaml: ["标签"] },
              value: "北境",
            },
            { op: "remove", locator: { yaml: ["临时标记"] } },
            {
              op: "set_metadata",
              title: "北门",
              summary: "风雪中的北门。",
              aliases: ["城门"],
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("YAML patch unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      documentId: "place.gate",
      shortRef: "gate",
      codec: "yaml",
    });
    expect(revised.changes[0]?.after.contents).toContain("title: 北门");
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { documentId: "place.gate" },
        locator: { yaml: ["状态"] },
      }),
    ).toMatchObject({ kind: "select_node", ok: true, node: { value: "开放" } });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["标签"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      scope: { document: { title: "北门", aliases: ["城门"] } },
      node: { value: ["古老", "北境"] },
    });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["临时标记"] },
      }),
    ).toMatchObject({
      kind: "error",
      diagnostics: [expect.objectContaining({ code: "locator_not_found" })],
    });
  });

  test("partial metadata edits preserve omitted fields and keep Markdown title aligned", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/situation.yaml",
          contents: `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 白天的宿舍。
  aliases: [宿舍, "302"]
情况: 正在整理装备
`,
        },
        {
          path: "world/rules/lore.md",
          contents: `---
$document:
  id: rule.lore
  ref: lore
  title: 旧规则
  summary: 一份规则文档。
  aliases: [法则]
---
# 旧规则

规则正文。
`,
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "current-situation" },
          edits: [{ op: "set_metadata", summary: "夜里的宿舍。" }],
        },
        {
          kind: "patch",
          document: { shortRef: "lore" },
          edits: [{ op: "set_metadata", title: "世界规则" }],
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("partial metadata revision failed");
    expect(
      revised.snapshot.query({
        kind: "read_document",
        document: { shortRef: "current-situation" },
        maxBytes: 8_192,
      }),
    ).toMatchObject({
      kind: "read_document",
      ok: true,
      document: {
        title: "当前情境",
        summary: "夜里的宿舍。",
        aliases: ["宿舍", "302"],
      },
    });
    const lore = revised.snapshot.query({
      kind: "read_document",
      document: { shortRef: "lore" },
      maxBytes: 8_192,
    });
    expect(lore).toMatchObject({
      kind: "read_document",
      ok: true,
      document: {
        title: "世界规则",
        summary: "一份规则文档。",
        aliases: ["法则"],
      },
    });
    if (lore.kind !== "read_document" || !lore.ok)
      throw new Error("partially renamed Markdown document cannot be read");
    expect(lore.body).toContain("# 世界规则");
  });

  test.each([
    [
      "没有提供任何字段",
      { op: "set_metadata" },
      "at least one of title, summary, or aliases must be provided",
    ],
    [
      "包含未知字段",
      { op: "set_metadata", summary: "新简介", unknown: true },
      "set_metadata accepts only op, title, summary, and aliases",
    ],
    [
      "提供无效字段",
      { op: "set_metadata", aliases: [1] },
      "aliases item 1 must be a string",
    ],
  ])("set_metadata 拒绝%s", (_label, edit, message) => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/situation.yaml",
          contents: yamlDocument({
            id: "situation.current",
            ref: "current-situation",
            title: "当前情境",
            body: "情况: 正在整理装备\n",
          }),
        },
      ],
    });

    const rejected = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "current-situation" },
          edits: [edit as WorldDocumentRevisionEdit],
        },
      ],
    });
    expect(rejected).toMatchObject({
      kind: "error",
      ok: false,
    });
    if (rejected.ok) throw new Error("invalid metadata edit was accepted");
    expect(rejected.diagnostics[0]?.message).toContain(message);
  });

  test("YAML patch can add or replace the whole body without touching the technical header", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/situation.yaml",
          contents: yamlDocument({
            id: "situation.current",
            ref: "situation",
            title: "当前情境",
            body: "",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "situation" },
          edits: [
            {
              op: "add",
              locator: { yaml: [] },
              value: { 状态: "暂存" },
            },
            {
              op: "replace",
              locator: { yaml: [] },
              value: { 状态: "风雪将至", 在场者: ["旅人"] },
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("whole-body patch unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      documentId: "situation.current",
      shortRef: "situation",
    });
    expect(revised.changes[0]?.after.contents).toContain(
      "id: situation.current",
    );
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "situation" },
        locator: { yaml: [] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: { 状态: "风雪将至", 在场者: ["旅人"] } },
    });
  });

  test("Markdown patch edits exact heading paths in order and ignores fenced pseudo-headings", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/rules/lore.md",
          contents: markdownDocument({
            id: "rule.lore",
            ref: "lore",
            title: "旧规则",
            body: `旧序言。

## 魔法

旧魔法。

\`\`\`md
## 伪标题
\`\`\`

## 地理

旧地理。

## 废弃

等待删除。`,
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "lore" },
          edits: [
            { op: "replace_preamble", markdown: "新序言。" },
            {
              op: "replace_section",
              locator: { markdown: ["魔法"] },
              markdown: "## 魔法\n\n施法需要媒介。",
            },
            {
              op: "add_section",
              locator: { markdown: ["魔法"] },
              markdown: "### 代价\n\n媒介会损耗。",
            },
            {
              op: "rename_section",
              locator: { markdown: ["地理"] },
              title: "北境",
            },
            {
              op: "remove_section",
              locator: { markdown: ["废弃"] },
            },
            {
              op: "set_metadata",
              title: "世界规则",
              summary: "世界运行的长篇规则。",
              aliases: ["法则"],
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "revision", ok: true });
    if (!revised.ok) throw new Error("Markdown patch unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      documentId: "rule.lore",
      shortRef: "lore",
      codec: "markdown",
    });
    expect(revised.changes[0]?.after.contents).toContain("# 世界规则");
    const magic = revised.snapshot.query({
      kind: "select_node",
      document: { shortRef: "lore" },
      locator: { markdown: ["魔法"] },
    });
    expect(magic).toMatchObject({
      kind: "select_node",
      ok: true,
      scope: { document: { title: "世界规则", aliases: ["法则"] } },
    });
    if (magic.kind !== "select_node" || !magic.ok)
      throw new Error("patched Markdown section cannot be selected");
    expect(magic.node.codec).toBe("markdown");
    if (magic.node.codec === "markdown")
      expect(magic.node.markdown).toContain("### 代价\n\n媒介会损耗。");
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "lore" },
        locator: { markdown: ["北境"] },
      }),
    ).toMatchObject({ kind: "select_node", ok: true });
    expect(revised.changes[0]?.after.contents).not.toContain("等待删除");
    expect(revised.changes[0]?.after.contents).not.toContain("旧序言");
  });

  test("Markdown section edits cannot inject headings outside the exact section subtree", () => {
    const original = markdownDocument({
      id: "rule.lore",
      ref: "lore",
      title: "世界规则",
      body: "## 魔法\n\n旧魔法。\n\n## 地理\n\n旧地理。",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/rules/lore.md", contents: original }],
    });
    const unsafeEdits = [
      {
        op: "rename_section",
        locator: { markdown: ["魔法"] },
        title: "新魔法\n## 偷渡标题",
      },
      {
        op: "replace_section",
        locator: { markdown: ["魔法"] },
        markdown: "## 魔法\n\n新魔法。\n\n## 偷渡标题\n\n越出替换子树。",
      },
      {
        op: "add_section",
        locator: { markdown: ["魔法"] },
        markdown: "### 代价\n\n需要媒介。\n\n### 偷渡标题\n\n越出新增子树。",
      },
      {
        op: "replace_section",
        locator: { markdown: ["魔法"] },
        markdown: "## 魔法\n\n```text\n未闭合围栏会吞掉后续兄弟标题。",
      },
      {
        op: "add_section",
        locator: { markdown: ["魔法"] },
        markdown: "### 代价\n\n```text\n未闭合围栏会吞掉后续兄弟标题。",
      },
    ] as const;

    for (const edit of unsafeEdits) {
      const revised = source.revise({
        commands: [
          {
            kind: "patch",
            document: { shortRef: "lore" },
            edits: [edit],
          },
        ],
      });

      expect(revised).toMatchObject({
        kind: "error",
        ok: false,
        diagnostics: [
          expect.objectContaining({
            commandIndex: 0,
            logicalPath: "world/rules/lore.md",
            documentId: "rule.lore",
            locator: { markdown: ["魔法"] },
          }),
        ],
      });
      expect(revised).not.toHaveProperty("snapshot");
      expect(revised).not.toHaveProperty("files");
      expect(source.files[0]?.contents).toBe(original);
    }
  });

  test("replace preserves a valid document identity and keeps caller bytes verbatim", () => {
    const before = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "北门",
      body: "状态: 关闭\n",
    });
    const after = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "北门",
      body: "状态: 开放\n守卫: 三人\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/places/gate.yaml", contents: before }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "replace",
          document: { shortRef: "gate" },
          contents: after,
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "revision",
      ok: true,
      changes: [
        {
          documentId: "place.gate",
          shortRef: "gate",
          before: {
            contents: before,
            mechanicalHash:
              "sha256:399775af267d874b55716051ec380f26d8c0c2f1e2a31385fb7f9be62761e6a8",
          },
          after: {
            contents: after,
            mechanicalHash:
              "sha256:8d0e77aaa0eb2cd6dc42ff484544bef390c07ca9aafeabb55bb1256c0979bc75",
          },
        },
      ],
    });
  });

  test("replace can repair a document with no usable identity when selected by logical path", () => {
    const damaged = `$document:\n  id: INVALID ID\n  ref: Bad Ref\n  title: 损坏\n  summary: 等待修复。\n  aliases: []\n状态: 未知\n`;
    const repaired = yamlDocument({
      id: "place.repaired",
      ref: "repaired",
      title: "修复地点",
      body: "状态: 可用\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "world/places/broken.yaml", contents: damaged },
        { path: "opening.md", contents: "opaque opening\n" },
      ],
    });
    expect(source.status).toBe("needs_repair");

    const revised = source.revise({
      commands: [
        {
          kind: "replace",
          document: { logicalPath: "world/places/broken.yaml" },
          contents: repaired,
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "revision",
      ok: true,
      snapshotStatus: "usable",
      changes: [
        {
          documentId: "place.repaired",
          shortRef: "repaired",
          before: {
            logicalPath: "world/places/broken.yaml",
            contents: damaged,
          },
          after: {
            logicalPath: "world/places/broken.yaml",
            contents: repaired,
          },
        },
      ],
    });
    if (!revised.ok) throw new Error("repair replace unexpectedly failed");
    expect(revised.files).toContainEqual({
      path: "opening.md",
      contents: "opaque opening\n",
    });
    expect(source.files[0]?.contents).toBe(damaged);
  });

  test("a later command failure reports its index and locator without exposing a partial candidate", () => {
    const original = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "北门",
      body: "状态: 关闭\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "world/places/gate.yaml", contents: original },
        { path: "opening.md", contents: "逐字保留。\n" },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "gate" },
          edits: [
            {
              op: "replace",
              locator: { yaml: ["状态"] },
              value: "开放",
            },
          ],
        },
        {
          kind: "patch",
          document: { shortRef: "gate" },
          edits: [
            {
              op: "replace",
              locator: { yaml: ["不存在"] },
              value: "不会发布",
            },
          ],
        },
      ],
    });

    expect(revised).toEqual(
      expect.objectContaining({
        kind: "error",
        ok: false,
        sourceSnapshotId: source.id,
        diagnostics: [
          expect.objectContaining({
            code: "locator_not_found",
            commandIndex: 1,
            logicalPath: "world/places/gate.yaml",
            documentId: "place.gate",
            locator: { yaml: ["不存在"] },
          }),
        ],
      }),
    );
    expect(revised).not.toHaveProperty("snapshot");
    expect(revised).not.toHaveProperty("files");
    expect(source.files).toEqual([
      { path: "world/places/gate.yaml", contents: original },
      { path: "opening.md", contents: "逐字保留。\n" },
    ]);
    expect(
      source.query({
        kind: "select_node",
        document: { shortRef: "gate" },
        locator: { yaml: ["状态"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: "关闭" },
    });
  });

  test("create reports the exact nested YAML locator for an unresolved temporary reference", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "opening.md", contents: "逐字保留。\n" }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "gate",
          logicalPath: "world/gate.yaml",
          codec: "yaml",
          refHint: "gate",
          title: "北门",
          summary: "风雪中的北门。",
          aliases: [],
          body: {
            位置: { $ref: { temporaryName: "missing-place" } },
          },
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "document_not_found",
          commandIndex: 0,
          logicalPath: "world/gate.yaml",
          locator: { yaml: ["位置"] },
        }),
      ],
    });
    expect(revised).not.toHaveProperty("snapshot");
    expect(revised).not.toHaveProperty("files");
    expect(source.files).toEqual([
      { path: "opening.md", contents: "逐字保留。\n" },
    ]);
  });

  test("append diagnostics include the concrete new sequence index", () => {
    const original = yamlDocument({
      id: "rule.routes",
      ref: "routes",
      title: "路线",
      body: "地点: []\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/routes.yaml", contents: original }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "routes" },
          edits: [
            {
              op: "append",
              locator: { yaml: ["地点"] },
              value: {
                目标: { $ref: { temporaryName: "missing-place" } },
              },
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "document_not_found",
          commandIndex: 0,
          logicalPath: "world/routes.yaml",
          documentId: "rule.routes",
          locator: { yaml: ["地点", 0, "目标"] },
        }),
      ],
    });
    expect(revised).not.toHaveProperty("snapshot");
    expect(source.files[0]?.contents).toBe(original);
  });

  test("a YAML add below a scalar returns a stable local-safety diagnostic instead of throwing", () => {
    const original = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "北门",
      body: "状态: 关闭\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/gate.yaml", contents: original }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "gate" },
          edits: [
            {
              op: "add",
              locator: { yaml: ["状态", "子项"] },
              value: "不会写入",
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        {
          code: "locator_invalid",
          commandIndex: 0,
          logicalPath: "world/gate.yaml",
          documentId: "place.gate",
          locator: { yaml: ["状态", "子项"] },
        },
      ],
    });
    expect(source.files[0]?.contents).toBe(original);
  });

  test("batch-final reference integrity rejects a dangling target atomically", () => {
    const original = yamlDocument({
      id: "character.hero",
      ref: "hero",
      title: "旅人",
      body: "衣着: 灰色斗篷\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/hero.yaml", contents: original }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "patch",
          document: { shortRef: "hero" },
          edits: [
            {
              op: "add",
              locator: { yaml: ["位置"] },
              value: { $ref: "place.missing" },
            },
          ],
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        {
          code: "document_reference_invalid",
          commandIndex: 0,
          logicalPath: "world/hero.yaml",
          documentId: "character.hero",
          locator: { yaml: ["位置"] },
        },
      ],
    });
    if (revised.ok) throw new Error("dangling reference unexpectedly passed");
    expect(revised.diagnostics[0]?.range).toBeDefined();
    expect(typeof revised.diagnostics[0]?.message).toBe("string");
    expect(source.files[0]?.contents).toBe(original);
  });

  test("replace rejects identity or short-reference changes on a valid document", () => {
    const original = yamlDocument({
      id: "place.gate",
      ref: "gate",
      title: "北门",
      body: "状态: 关闭\n",
    });
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "world/gate.yaml", contents: original }],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "replace",
          document: { logicalPath: "world/gate.yaml" },
          contents: yamlDocument({
            id: "place.other",
            ref: "other",
            title: "北门",
            body: "状态: 开放\n",
          }),
        },
      ],
    });

    expect(revised).toMatchObject({ kind: "error", ok: false });
    if (revised.ok) throw new Error("identity-changing replace passed");
    expect(
      revised.diagnostics.map(({ code, commandIndex, logicalPath }) => ({
        code,
        commandIndex,
        logicalPath,
      })),
    ).toEqual([
      {
        code: "document_identity_invalid",
        commandIndex: 0,
        logicalPath: "world/gate.yaml",
      },
      {
        code: "document_short_ref_invalid",
        commandIndex: 0,
        logicalPath: "world/gate.yaml",
      },
    ]);
    expect(source.files[0]?.contents).toBe(original);
  });

  test("candidate batch copies caller inputs and deeply freezes the successful result", () => {
    const aliases = ["关隘"];
    const body = { 状态: "关闭" };
    const command: WorldDocumentCreateRevisionCommand = {
      kind: "create",
      temporaryName: "gate",
      logicalPath: "world/gate.yaml",
      codec: "yaml",
      refHint: "gate",
      title: "北门",
      summary: "风雪中的北门。",
      aliases,
      body,
    };
    const request = { commands: [command] };
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "opening.md", contents: "opaque\n" }],
    });

    const revised = source.revise(request);
    if (!revised.ok) throw new Error("immutable revision unexpectedly failed");
    body.状态 = "调用方后来修改";
    aliases[0] = "调用方后来修改";
    request.commands.push(command);

    expect(revised.changes[0]?.after.contents).toContain("状态: 关闭");
    expect(revised.changes[0]?.after.contents).toContain("- 关隘");
    expect(revised.changes[0]?.after.contents).not.toContain("调用方后来修改");
    expect(Object.isFrozen(revised)).toBe(true);
    expect(Object.isFrozen(revised.changes)).toBe(true);
    expect(Object.isFrozen(revised.changes[0]?.after)).toBe(true);
    expect(Object.isFrozen(revised.files)).toBe(true);
    expect(Object.isFrozen(request)).toBe(false);
    expect(Object.isFrozen(body)).toBe(false);
  });

  test("world state revisions apply ordered create, patch, and replace while preserving opaque surfaces", () => {
    const hero = yamlDocument({
      id: "character.hero",
      ref: "hero",
      title: "旅人",
      body: "衣着: 灰色斗篷\n",
    });
    const replacedHero = yamlDocument({
      id: "character.hero",
      ref: "hero",
      title: "旅人",
      body: "衣着: 蓝色外套\n",
    });
    const source = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        { path: "state/characters/hero.yaml", contents: hero },
        { path: "control/frame.yaml", contents: "opaque control\n" },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "create",
          temporaryName: "gate",
          logicalPath: "state/places/gate.yaml",
          codec: "yaml",
          refHint: "gate",
          title: "北门",
          summary: "风雪中的北门。",
          aliases: [],
          body: {},
        },
        {
          kind: "patch",
          document: { temporaryName: "gate" },
          edits: [{ op: "add", locator: { yaml: ["状态"] }, value: "关闭" }],
        },
        {
          kind: "create",
          temporaryName: "guard",
          logicalPath: "state/characters/guard.yaml",
          codec: "yaml",
          refHint: "guard",
          title: "守卫",
          summary: "守卫北门的人。",
          aliases: [],
          body: { 驻守: { $ref: { temporaryName: "gate" } } },
        },
        {
          kind: "replace",
          document: { shortRef: "hero" },
          contents: replacedHero,
        },
      ],
    });

    expect(revised).toMatchObject({
      kind: "revision",
      ok: true,
      snapshotStatus: "usable",
    });
    if (!revised.ok)
      throw new Error("world state revision unexpectedly failed");
    expect(revised.changes).toHaveLength(3);
    expect(revised.files).toContainEqual({
      path: "control/frame.yaml",
      contents: "opaque control\n",
    });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "guard" },
        locator: { yaml: ["驻守"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: { target: { shortRef: "gate" } } },
    });
    expect(
      revised.snapshot.query({
        kind: "select_node",
        document: { shortRef: "hero" },
        locator: { yaml: ["衣着"] },
      }),
    ).toMatchObject({
      kind: "select_node",
      ok: true,
      node: { value: "蓝色外套" },
    });
    expect(source.files).toEqual([
      { path: "state/characters/hero.yaml", contents: hero },
      { path: "control/frame.yaml", contents: "opaque control\n" },
    ]);
  });

  test("revise rejects world state move and every delete command", () => {
    const state = WorldDocumentStore.open({
      layout: "world_state",
      files: [
        {
          path: "state/characters/hero.yaml",
          contents: yamlDocument({
            id: "character.hero",
            ref: "hero",
            title: "旅人",
            body: "衣着: 灰色斗篷\n",
          }),
        },
      ],
    });
    expect(
      state.revise({
        commands: [
          {
            kind: "move",
            document: { shortRef: "hero" },
            toLogicalPath: "state/people/hero.yaml",
          },
        ],
      }),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "query_invalid", commandIndex: 0 }),
      ],
    });
    expect(
      state.revise({
        commands: [{ kind: "delete", document: { shortRef: "hero" } }],
      } as never),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "query_invalid", commandIndex: 0 }),
      ],
    });

    const content = WorldDocumentStore.open({
      layout: "content_package",
      files: [{ path: "opening.md", contents: "不能由 revise 修改。\n" }],
    });
    expect(
      content.revise({
        commands: [
          { kind: "delete", document: { logicalPath: "world/anything.yaml" } },
        ],
      } as never),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "query_invalid", commandIndex: 0 }),
      ],
    });
    expect(
      content.revise({
        commands: [
          {
            kind: "replace",
            document: { logicalPath: "opening.md" },
            contents: "不能替换。\n",
          },
        ],
      }),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "document_not_found",
          commandIndex: 0,
        }),
      ],
    });
    expect(content.files).toEqual([
      { path: "opening.md", contents: "不能由 revise 修改。\n" },
    ]);
  });
});

describe("WorldDocumentStore write revision command", () => {
  const existing = () =>
    WorldDocumentStore.open({
      layout: "content_package",
      files: [
        { path: "opening.md", contents: "雨停在门槛外。\n" },
        {
          path: "world/characters/alex.yaml",
          contents: yamlDocument({
            id: "character.alex",
            ref: "alex",
            title: "Alex",
            body: "衣着: 白色球衣\n",
          }),
        },
      ],
    });

  test("写入新路径时由 store 分配身份，作者写的 id 被忽略", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/places/gate.yaml",
          contents: yamlDocument({
            id: "作者猜测的身份",
            ref: "gate",
            title: "北门",
            body: "状态: 关闭\n",
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({
      shortRef: "gate",
      codec: "yaml",
      before: null,
      after: { logicalPath: "world/places/gate.yaml" },
    });
    expect(revised.changes[0]?.documentId).toMatch(/^doc\.[a-f0-9]{32}$/u);
    expect(revised.changes[0]?.after.contents).toContain("状态: 关闭");
    expect(revised.changes[0]?.after.contents).not.toContain("作者猜测的身份");
  });

  test("写入既有路径时保留原 id 与 ref，作者写错也不报错", () => {
    const source = existing();
    const revised = source.revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/characters/alex.yaml",
          contents: yamlDocument({
            id: "character.someone-else",
            ref: "someoneelse",
            title: "Alex",
            body: "衣着: 黑色球衣\n",
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes[0]).toMatchObject({
      documentId: "character.alex",
      shortRef: "alex",
    });
    const contents = revised.changes[0]?.after.contents ?? "";
    expect(contents).toContain("id: character.alex");
    expect(contents).toContain("ref: alex");
    expect(contents).toContain("衣着: 黑色球衣");
    expect(contents).not.toContain("someone-else");
  });

  test("写入 Markdown 文档保留正文并重建技术头", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/rules/cultivation.md",
          contents: markdownDocument({
            id: "无所谓",
            ref: "cultivation",
            title: "修炼境界",
            body: "炼气之后是筑基。",
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    const contents = revised.changes[0]?.after.contents ?? "";
    expect(revised.changes[0]?.shortRef).toBe("cultivation");
    expect(contents).toMatch(/^---\n\$document:/u);
    expect(contents).toContain("# 修炼境界");
    expect(contents).toContain("炼气之后是筑基。");
    expect(contents).not.toContain("无所谓");
  });

  test("修复损坏文档时采用作者写的 id 与 ref，让既有引用重新指向它", () => {
    const damaged = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/characters/alex.yaml",
          contents: "not: [valid\n",
        },
        {
          path: "world/current-situation.yaml",
          contents: yamlDocument({
            id: "situation.current",
            ref: "current",
            title: "当前情境",
            body: "人物:\n  - $ref: character.alex\n",
          }),
        },
      ],
    });

    const revised = damaged.revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/characters/alex.yaml",
          contents: yamlDocument({
            id: "character.alex",
            ref: "alex",
            title: "Alex",
            body: "关系: {}\n",
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes[0]).toMatchObject({
      documentId: "character.alex",
      shortRef: "alex",
    });
    expect(revised.snapshot.status).toBe("usable");
  });

  test("新建文档的 ref 冲突由 store 消解", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/characters/other.yaml",
          contents: yamlDocument({
            id: "x",
            ref: "alex",
            title: "另一个人",
            body: "衣着: 长衫\n",
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes[0]?.shortRef).toBe("alex-2");
  });

  test("写入的原文可以照抄既有的文档 id 引用，也可以用 @短引用", () => {
    const source = WorldDocumentStore.open({
      layout: "content_package",
      files: [
        {
          path: "world/characters/alex.yaml",
          contents: yamlDocument({
            id: "character.alex",
            ref: "alex",
            title: "Alex",
            body: "关系: {}\n",
          }),
        },
        {
          path: "world/current-situation.yaml",
          contents: yamlDocument({
            id: "situation.current",
            ref: "current",
            title: "当前情境",
            body: "人物:\n  - $ref: character.alex\n",
          }),
        },
      ],
    });

    const revised = source.revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/current-situation.yaml",
          contents: yamlDocument({
            id: "situation.current",
            ref: "current",
            title: "当前情境",
            body: '地点: 宿舍\n人物:\n  - $ref: character.alex\n在场:\n  - $ref: "@alex"\n',
          }),
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    const contents = revised.changes[0]?.after.contents ?? "";
    expect(contents).toContain("地点: 宿舍");
    expect(contents).toContain("$ref: character.alex");
    expect(revised.snapshot.status).toBe("usable");
  });

  test.each([
    ["YAML", "world/characters/alex.yaml", "衣着: 黑色球衣\n", "黑色球衣"],
    [
      "Markdown",
      "world/rules/cultivation.md",
      "# 修炼境界\n\n炼气之后是筑基。\n",
      "炼气之后是筑基。",
    ],
  ])(
    "%s：把 setting_read 返回的正文原样写回即可，元信息自动沿用",
    (_, logicalPath, contents, expected) => {
      const source = WorldDocumentStore.open({
        layout: "content_package",
        files: [
          {
            path: "world/characters/alex.yaml",
            contents: yamlDocument({
              id: "character.alex",
              ref: "alex",
              title: "Alex",
              body: "衣着: 白色球衣\n",
            }),
          },
          {
            path: "world/rules/cultivation.md",
            contents: markdownDocument({
              id: "rule.cultivation",
              ref: "cultivation",
              title: "修炼境界",
              body: "境界由故事解释。",
            }),
          },
        ],
      });

      const revised = source.revise({
        commands: [{ kind: "write", logicalPath, contents }],
      });

      if (!revised.ok) throw new Error("write revision unexpectedly failed");
      const after = revised.changes[0]?.after.contents ?? "";
      expect(after).toContain(expected);
      expect(after).toContain("$document");
      expect(revised.changes[0]?.documentId).toBe(
        logicalPath.endsWith(".yaml") ? "character.alex" : "rule.cultivation",
      );
      expect(revised.snapshot.status).toBe("usable");
    },
  );

  test("数字别名被转成字符串而不是拒绝整份文档", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/locations/dorm.yaml",
          contents:
            "$document:\n  id: x\n  ref: dorm\n  title: 宿舍\n  summary: 三楼的四人间。\n  aliases: [301, 男生宿舍]\n位置: 三楼\n",
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    const contents = revised.changes[0]?.after.contents ?? "";
    expect(contents).toContain('"301"');
    expect(contents).toContain("男生宿舍");
  });

  test("省略 aliases 视为空数组", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/locations/gate.yaml",
          contents:
            "$document:\n  id: x\n  ref: gate\n  title: 北门\n  summary: 风雪中的城门。\n状态: 关闭\n",
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes[0]?.after.contents).toContain("aliases: []");
  });

  test.each([
    [
      "summary 超长",
      header({ summary: "很".repeat(241) }),
      "summary may contain at most 240 characters; received 241",
    ],
    [
      "title 不是字符串",
      header({ title: "[]" }),
      "title must be a string; received array (0 items)",
    ],
    [
      "aliases 不是数组",
      header({ aliases: "男生宿舍" }),
      'aliases must be an array; received string "男生宿舍"',
    ],
    [
      "别名含空串",
      header({ aliases: '["", 宿舍]' }),
      "aliases item 1 must contain 1 to 64 characters; received 0",
    ],
  ])("元信息诊断指出具体是哪一项：%s", (_, contents, expected) => {
    const revised = existing().revise({
      commands: [
        { kind: "write", logicalPath: "world/locations/dorm.yaml", contents },
      ],
    });

    expect(revised.ok).toBe(false);
    if (revised.ok) return;
    expect(
      revised.diagnostics.map(({ message }) => message).join("\n"),
    ).toContain(expected);
  });

  test("新建文档省略 $document 时报错并说明可以省略的前提", () => {
    expect(
      existing().revise({
        commands: [
          {
            kind: "write",
            logicalPath: "world/places/gate.yaml",
            contents: "状态: 关闭\n",
          },
        ],
      }),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "document_header_invalid",
          commandIndex: 0,
        }),
      ],
    });
  });

  test("同一批次里可以先 write 再按逻辑路径 patch", () => {
    const revised = existing().revise({
      commands: [
        {
          kind: "write",
          logicalPath: "world/places/gate.yaml",
          contents: yamlDocument({
            id: "x",
            ref: "gate",
            title: "北门",
            body: "状态: 关闭\n",
          }),
        },
        {
          kind: "patch",
          document: { logicalPath: "world/places/gate.yaml" },
          edits: [
            {
              op: "replace",
              locator: { yaml: ["状态"] },
              value: "敞开",
            },
          ],
        },
      ],
    });

    if (!revised.ok) throw new Error("write revision unexpectedly failed");
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]?.after.contents).toContain("状态: 敞开");
  });

  test.each([
    [
      "缺少 $document",
      "world/places/gate.yaml",
      "状态: 关闭\n",
      "document_header_invalid",
    ],
    [
      "路径不在 world/ 下",
      "places/gate.yaml",
      yamlDocument({
        id: "x",
        ref: "gate",
        title: "北门",
        body: "状态: 关闭\n",
      }),
      "logical_path_invalid",
    ],
    [
      "后缀不是文档 codec",
      "world/places/gate.txt",
      yamlDocument({
        id: "x",
        ref: "gate",
        title: "北门",
        body: "状态: 关闭\n",
      }),
      "logical_path_invalid",
    ],
  ])("write 拒绝%s", (_, logicalPath, contents, code) => {
    expect(
      existing().revise({
        commands: [{ kind: "write", logicalPath, contents }],
      }),
    ).toMatchObject({
      kind: "error",
      ok: false,
      diagnostics: [expect.objectContaining({ code, commandIndex: 0 })],
    });
  });
});

/** A valid $document header whose selected field can be overridden for focused metadata diagnostics. */
function header(
  overrides: { title?: string; summary?: string; aliases?: string } = {},
): string {
  return [
    "$document:",
    "  id: x",
    "  ref: dorm",
    `  title: ${overrides.title ?? "宿舍"}`,
    `  summary: ${overrides.summary ?? "三楼的四人间。"}`,
    `  aliases: ${overrides.aliases ?? "[]"}`,
    "位置: 三楼",
    "",
  ].join("\n");
}

function yamlDocument(input: {
  id: string;
  ref: string;
  title: string;
  body: string;
}): string {
  return `$document:
  id: ${input.id}
  ref: ${input.ref}
  title: ${input.title}
  summary: 一份世界文档。
  aliases: []
${input.body}`;
}

function markdownDocument(input: {
  id: string;
  ref: string;
  title: string;
  body: string;
}): string {
  return `---
$document:
  id: ${input.id}
  ref: ${input.ref}
  title: ${input.title}
  summary: 一份规则文档。
  aliases: []
---
# ${input.title}

${input.body}
`;
}
