import { expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  type PromptPreview,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  SettingAuthoringTransaction,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import type { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

test("设定完善契约描述显式上下文和直接当前树工具行为", () => {
  expect(
    settingImprovementToolDefinitions("zh-CN").map(({ name }) => name),
  ).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_create",
    "setting_write_file",
    "setting_patch",
    "setting_move",
    "setting_delete",
  ]);
  const patch = settingImprovementToolDefinitions("zh-CN").find(
    ({ name }) => name === "setting_patch",
  );
  expect(patch?.description).toContain("remove");
  expect(patch?.description).toContain("数组下标");
  const patchSchema = patch?.inputSchema as {
    properties?: {
      op?: { enum?: string[] };
      locator?: { items?: { type?: string[] } };
    };
  };
  expect(patchSchema.properties?.op?.enum).toContain("remove");
  expect(patchSchema.properties?.locator?.items?.type).toEqual([
    "string",
    "integer",
  ]);
  const contract = settingImprovementRuntimeContract("zh-CN");
  expect(contract).toContain("每条用户消息都追加到所选设定完善对话");
  expect(contract).toContain("显式选择“全新上下文”");
  expect(contract).toContain("不调用工具的完整响应");
  expect(contract).toContain("工具写入直接修改内容包当前树");
  expect(contract).toContain("发布后立即成为内容包权威");
  expect(contract).toContain("无需另一步确认");
  expect(contract).toContain("每个写工具调用独立结算");
  expect(contract).toContain("失败只在对应工具结果中返回");
  expect(contract).toContain("ref 由你提供");
  expect(contract).toContain('{ $ref: "@alex" }');
  expect(contract).not.toContain("$document.id");
  expect(contract).toContain("内容包在游玩中的生命周期");
  expect(contract).toContain("world/*");
  expect(contract).toContain("state_list");
  expect(contract).toContain("空状态目录");
  expect(contract).toContain("world_create 目标");
  expect(contract).toContain("全新游玩上下文由世界控制与当前世界状态编译");
  expect(contract).toContain("精确 selector");
  expect(contract).not.toMatch(/计划阶段|生成阶段|结束工具|preview 或 finish/u);

  const englishContract = settingImprovementRuntimeContract("en");
  expect(englishContract).toContain("remains available through state_list");
  expect(englishContract).not.toMatch(
    /planning phase|generation phase|finish tool|preview and finish tools/iu,
  );
});

test("自动检查把改动文档在真实游玩提示中的覆盖方式返回给模型", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: productionPreview,
  });
  const results = transaction.execute([
    {
      id: "create-character",
      name: "setting_create",
      arguments: {
        path: "world/characters/alex.yaml",
        ref: "alex",
        title: "Alex",
        summary:
          "A courier whose current assignment can affect the opening scene.",
        aliases: [],
        body: "status: waiting at the gate\n",
      },
    },
    {
      id: "create-lore",
      name: "setting_create",
      arguments: {
        path: "world/lore/old-oath.md",
        ref: "old-oath",
        title: "The old oath",
        summary: "Explains the promise that still constrains the two houses.",
        aliases: [],
        body: "# The old oath\n\nThe two houses may not draw steel inside the gate.\n",
      },
    },
    {
      id: "create-unused-control",
      name: "setting_write_file",
      arguments: {
        path: "control/blocks/unused.md",
        contents: "# Unused world instruction\n\nThis block is not enabled.",
      },
    },
  ]);

  expect(results.at(-1)?.markdown).toContain("Play-consumption coverage");
  expect(results.at(-1)?.markdown).toContain(
    "world/characters/alex.yaml — catalog summary only",
  );
  expect(results.at(-1)?.markdown).toContain(
    "world/lore/old-oath.md — on-demand only",
  );
  expect(results.at(-1)?.markdown).toContain(
    "control/blocks/unused.md — not enabled by control/frame.yaml",
  );
  expect(results.at(-1)?.markdown).toContain(
    "consider adding a catalog, injected reference, or world instruction",
  );
  expect(results.at(-1)?.markdown).not.toContain("finish tool");
  expect(transaction.review().playCoverage).toMatchObject({
    changed: [
      { path: "control/blocks/unused.md", access: "unused_control" },
      {
        path: "world/characters/alex.yaml",
        access: "catalog_summary",
      },
      { path: "world/lore/old-oath.md", access: "on_demand" },
    ],
  });
});

test("每个写调用独立结算，失败只回到对应调用且不回滚成功调用", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const opening = baseFiles.find(({ path }) => path === "opening.md")!;
  const results = transaction.execute([
    {
      id: "read-opening",
      name: "setting_read",
      arguments: { path: "opening.md" },
    },
    {
      id: "write-opening",
      name: "setting_write_file",
      arguments: {
        path: "opening.md",
        contents: `${opening.contents}\nChanged.`,
      },
    },
    {
      id: "write-invalid",
      name: "setting_write_file",
      arguments: { path: "private/runtime.txt", contents: "forbidden" },
    },
  ]);

  expect(results.map(({ toolCallId }) => toolCallId)).toEqual([
    "read-opening",
    "write-opening",
    "write-invalid",
  ]);
  expect(results.map(({ isError }) => isError)).toEqual([false, false, true]);
  expect(results[1]?.markdown).toContain("Updated opening.md");
  expect(results[1]?.markdown).not.toContain("private/runtime.txt");
  expect(results[2]?.markdown).toContain("Special-file writes accept only");
  expect(results[2]?.markdown).not.toContain("rolled back");
  expect(transaction.review()).toMatchObject({
    status: "usable",
    diff: [{ path: "opening.md", kind: "modify" }],
  });
});

test("AI 用 ref 和正文新建文档，Runtime 隐藏 id，后续调用可直接更新", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });

  const results = transaction.execute([
    {
      id: "create-alex",
      name: "setting_create",
      arguments: {
        path: "world/characters/alex.yaml",
        ref: "alex",
        title: "Alex",
        summary: "A courier waiting at the city gate.",
        aliases: ["The courier"],
        body: "status: waiting\n",
      },
    },
    {
      id: "update-alex",
      name: "setting_patch",
      arguments: {
        document: "@alex",
        op: "replace",
        locator: ["status"],
        value: "ready",
      },
    },
    {
      id: "update-alex-metadata",
      name: "setting_patch",
      arguments: {
        document: "@alex",
        op: "set_metadata",
        title: "Alex at the gate",
        summary: "A courier who is ready to leave the city gate.",
        aliases: ["The courier"],
      },
    },
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([false, false, false]);
  expect(results[0]?.markdown).toContain(
    "Created @alex · world/characters/alex.yaml",
  );
  expect(results[0]?.markdown).toContain("already fully read");
  expect(results[0]?.markdown).not.toMatch(/\$document\.id|doc\.[a-f0-9]+/u);
  expect(results[1]?.markdown).toContain(
    "Updated @alex · world/characters/alex.yaml",
  );
  expect(results[1]?.markdown).not.toContain("No file changed");
  expect(results[2]?.markdown).toContain(
    "Updated @alex · world/characters/alex.yaml",
  );

  const source = transaction
    .files()
    .find(({ path }) => path === "world/characters/alex.yaml")?.contents;
  expect(source).toMatch(/id: doc\.[a-f0-9]{32}/u);
  expect(source).toContain("ref: alex");
  expect(source).toContain("title: Alex at the gate");
  expect(source).toContain(
    "summary: A courier who is ready to leave the city gate.",
  );
  expect(source).toContain("status: ready");

  const read = transaction.execute([
    {
      id: "read-alex",
      name: "setting_read",
      arguments: { path: "@alex" },
    },
  ]);
  expect(read).toMatchObject([{ isError: false }]);
  expect(read[0]?.markdown).toContain("# Exact read @alex");
  expect(read[0]?.markdown).not.toMatch(/\$document|doc\.[a-f0-9]+/u);
});

test("设定工具可删除 YAML 节点、按数组下标修改，并删除无引用文档", () => {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("zh-CN"),
    locale: "zh-CN",
    preview: () => preview,
  });

  const results = transaction.execute([
    {
      id: "create-note",
      name: "setting_create",
      arguments: {
        path: "world/notes/temporary.yaml",
        ref: "temporary-note",
        title: "临时记录",
        summary: "用于验证细粒度删除和数组定位。",
        aliases: [],
        body: "临时标记: true\n事件:\n  - 第一条\n  - 第二条\n",
      },
    },
    {
      id: "remove-key",
      name: "setting_patch",
      arguments: {
        document: "@temporary-note",
        op: "remove",
        locator: ["临时标记"],
      },
    },
    {
      id: "replace-array-item",
      name: "setting_patch",
      arguments: {
        document: "@temporary-note",
        op: "replace",
        locator: ["事件", 0],
        value: "第一条（已修改）",
      },
    },
    {
      id: "delete-note",
      name: "setting_delete",
      arguments: { document: "@temporary-note" },
    },
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(results[1]?.markdown).toContain("@temporary-note");
  expect(results[2]?.markdown).toContain("@temporary-note");
  expect(results[3]?.markdown).toContain("已删除 @temporary-note");
  expect(
    transaction.files().some(({ path }) => path.endsWith("temporary.yaml")),
  ).toBe(false);
});

test("设定文档删除精确报告 currentSituation 与跨文档引用阻挡者", () => {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("zh-CN"),
    locale: "zh-CN",
    preview: () => preview,
  });
  const created = transaction.execute([
    {
      id: "read-current-situation",
      name: "setting_read",
      arguments: { path: "@current-situation", maxBytes: 65_536 },
    },
    {
      id: "create-target",
      name: "setting_create",
      arguments: {
        path: "world/notes/target.yaml",
        ref: "delete-target",
        title: "被引用记录",
        summary: "删除时应被引用完整性阻止。",
        aliases: [],
        body: "状态: 存在\n",
      },
    },
    {
      id: "create-holder",
      name: "setting_create",
      arguments: {
        path: "world/notes/holder.yaml",
        ref: "delete-holder",
        title: "引用持有者",
        summary: "持有指向待删除记录的机械引用。",
        aliases: [],
        body: '目标:\n  $ref: "@delete-target"\n',
      },
    },
  ]);
  expect(created.map(({ isError }) => isError)).toEqual([false, false, false]);

  const blocked = transaction.execute([
    {
      id: "delete-current-situation",
      name: "setting_delete",
      arguments: { document: "@current-situation" },
    },
    {
      id: "delete-referenced",
      name: "setting_delete",
      arguments: { document: "@delete-target" },
    },
  ]);

  expect(blocked[0]).toMatchObject({ isError: true });
  expect(blocked[0]?.markdown).toContain("control/frame.yaml");
  expect(blocked[0]?.markdown).toContain("bindings.currentSituation");
  expect(blocked[1]).toMatchObject({ isError: true });
  expect(blocked[1]?.markdown).toContain("world/notes/holder.yaml");
  expect(blocked[1]?.markdown).toContain("目标");
});

test("设定文档删除会同时报告 frame slot 与 player-view selector", () => {
  const baseFiles = minimalFileNativeContentScaffold("zh-CN").map((file) => {
    if (file.path === "control/frame.yaml")
      return {
        ...file,
        contents: file.contents.replace(
          "context:\n",
          'context:\n  - slot: { kind: document, document: "@guard" }\n',
        ),
      };
    if (file.path === "control/player-views.yaml")
      return {
        ...file,
        contents: `format: narraeon.player-views/v1
views:
  - id: status
    title: 当前状态
    items:
      - id: guard-state
        label: 守卫状态
        select:
          document: "@guard"
          locator: { yaml: [状态] }
`,
      };
    return file;
  });
  baseFiles.push({
    path: "world/characters/guard.yaml",
    contents: `$document:
  id: character.guard
  ref: guard
  title: 守卫
  summary: 被两个控制选择器使用的守卫。
  aliases: []
状态: 值勤
`,
  });
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "zh-CN",
    preview: () => preview,
  });

  expect(
    transaction.execute([
      {
        id: "read-guard",
        name: "setting_read",
        arguments: { path: "@guard", maxBytes: 65_536 },
      },
    ])[0],
  ).toMatchObject({ isError: false });
  const deletion = transaction.execute([
    {
      id: "delete-guard",
      name: "setting_delete",
      arguments: { document: "@guard" },
    },
  ])[0];

  expect(deletion).toMatchObject({ isError: true });
  expect(deletion?.markdown).toContain(
    "control/frame.yaml · context[0].slot.document",
  );
  expect(deletion?.markdown).toContain(
    "control/player-views.yaml · views[0].items[0].select.document",
  );
});

test("无效 ref 和字面 Unicode 转义只拒绝各自调用，既有成功写入保留", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const opening = baseFiles.find(({ path }) => path === "opening.md")!;
  transaction.execute([
    {
      id: "read-opening",
      name: "setting_read",
      arguments: { path: "opening.md" },
    },
  ]);

  const results = transaction.execute([
    {
      id: "write-opening",
      name: "setting_write_file",
      arguments: {
        path: "opening.md",
        contents: `${opening.contents}\nAccepted.`,
      },
    },
    {
      id: "missing-create-contract",
      name: "setting_write_file",
      arguments: {
        path: "world/notes/missing-header.yaml",
        contents: "status: waiting\n",
      },
    },
    {
      id: "bad-ref",
      name: "setting_create",
      arguments: {
        path: "world/characters/x.yaml",
        ref: "x",
        title: "X",
        summary: "A deliberately invalid one-character ref.",
        aliases: [],
        body: "status: waiting\n",
      },
    },
    {
      id: "escaped-unicode",
      name: "setting_create",
      arguments: {
        path: "world/lore/escaped.md",
        ref: "escaped",
        title: "Escaped",
        summary: "Contains a double-escaped payload that must be rejected.",
        aliases: [],
        body: "text: \\u4f60\\u597d\n",
      },
    },
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([
    false,
    true,
    true,
    true,
  ]);
  expect(results[1]?.markdown).toContain("setting_create");
  expect(results[1]?.markdown).not.toContain("$document");
  expect(results[2]?.markdown).toContain("ref must be 2 to 32");
  expect(results[2]?.markdown).not.toContain("literal Unicode escape");
  expect(results[3]?.markdown).toContain("literal Unicode escape");
  expect(results[3]?.markdown).not.toContain("ref must be 2 to 32");
  expect(transaction.review().diff).toMatchObject([
    { path: "opening.md", kind: "modify" },
  ]);
  expect(
    transaction.files().some(({ path }) => path.endsWith("escaped.md")),
  ).toBe(false);
});

test("重复 ref 精确拒绝，不由 Runtime 静默改成带后缀的新 ref", () => {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("en"),
    locale: "en",
    preview: () => preview,
  });
  const create = (id: string, path: string, ref: string) => ({
    id,
    name: "setting_create",
    arguments: {
      path,
      ref,
      title: id,
      summary: `Document ${id}.`,
      aliases: [],
      body: "status: ready\n",
    },
  });

  const results = transaction.execute([
    create("first", "world/notes/first.yaml", "shared-ref"),
    create("duplicate", "world/notes/duplicate.yaml", "shared-ref"),
    create("third", "world/notes/third.yaml", "third-ref"),
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([false, true, false]);
  expect(results[1]?.markdown).toContain("ref @shared-ref already exists");
  expect(
    transaction
      .files()
      .some(({ contents }) => contents.includes("shared-ref-2")),
  ).toBe(false);
  expect(
    transaction.files().some(({ path }) => path.endsWith("third.yaml")),
  ).toBe(true);
});

test("修复损坏文档只需公开 ref 和元信息，Runtime 自动保留可恢复 id", () => {
  const baseFiles = [
    ...minimalFileNativeContentScaffold("en"),
    {
      path: "world/characters/damaged.yaml",
      contents:
        "$document:\n  id: character.damaged\n  ref: broken ref\n  title: Damaged\n  summary: A damaged character.\n  aliases: []\nstatus: broken\n",
    },
    {
      path: "world/notes/holder.yaml",
      contents:
        "$document:\n  id: note.holder\n  ref: holder\n  title: Holder\n  summary: Keeps a reference to the damaged character.\n  aliases: []\ntarget:\n  $ref: character.damaged\n",
    },
  ];
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  expect(JSON.stringify(transaction.review().diagnostics)).not.toContain(
    "$document",
  );
  const damagedRead = transaction.execute([
    {
      id: "read-damaged",
      name: "setting_read",
      arguments: { path: "world/characters/damaged.yaml" },
    },
  ]);
  expect(damagedRead).toMatchObject([{ isError: true }]);
  expect(damagedRead[0]?.markdown).toContain("Document ref must be");
  expect(damagedRead[0]?.markdown).not.toContain("$document");

  const result = transaction.execute([
    {
      id: "repair-damaged",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/damaged.yaml",
        ref: "damaged",
        title: "Repaired character",
        summary: "A repaired character whose old references still resolve.",
        aliases: [],
        contents: "status: repaired\n",
      },
    },
  ]);

  expect(result).toMatchObject([{ isError: false }]);
  expect(result[0]?.markdown).not.toContain("character.damaged");
  const repaired = transaction
    .files()
    .find(({ path }) => path.endsWith("damaged.yaml"))?.contents;
  expect(repaired).toContain("id: character.damaged");
  expect(repaired).toContain("ref: damaged");
  expect(transaction.review().status).toBe("usable");
});

test("设定模型只能用 @ref 或逻辑路径，既有正文与控制文件中的 id 自动投影为 @ref", () => {
  const legacyFiles = [
    ...minimalFileNativeContentScaffold("en").map((file) => {
      if (file.path === "control/frame.yaml")
        return {
          ...file,
          contents: file.contents.replace(
            'currentSituation: "@current-situation"',
            "currentSituation: situation.current",
          ),
        };
      if (file.path === "control/player-views.yaml")
        return {
          ...file,
          contents:
            "format: narraeon.player-views/v1\nviews:\n  - id: situation\n    title: Situation\n    items:\n      - id: location\n        label: Location\n        select: { document: situation.current, locator: { yaml: [location] } }\n",
        };
      return file;
    }),
    {
      path: "world/notes/holder.yaml",
      contents:
        "$document:\n  id: note.holder\n  ref: holder\n  title: Holder\n  summary: Holds one legacy persisted reference.\n  aliases: []\ntarget:\n  $ref: situation.current\n",
    },
  ];
  const transaction = new SettingAuthoringTransaction({
    baseFiles: legacyFiles,
    locale: "en",
    preview: () => preview,
  });

  const results = transaction.execute([
    {
      id: "raw-id-read",
      name: "setting_read",
      arguments: { path: "situation.current" },
    },
    {
      id: "path-read",
      name: "setting_read",
      arguments: { path: "world/current-situation.yaml" },
    },
    {
      id: "raw-id-patch",
      name: "setting_patch",
      arguments: {
        document: "situation.current",
        op: "replace",
        locator: ["location"],
        value: "Old harbor",
      },
    },
    {
      id: "frame-read",
      name: "setting_read",
      arguments: { path: "control/frame.yaml" },
    },
    {
      id: "holder-read",
      name: "setting_read",
      arguments: { path: "@holder" },
    },
    {
      id: "player-views-read",
      name: "setting_read",
      arguments: { path: "control/player-views.yaml" },
    },
    {
      id: "legacy-id-search",
      name: "setting_search",
      arguments: { query: "situation.current" },
    },
    {
      id: "legacy-frame-write",
      name: "setting_write_file",
      arguments: {
        path: "control/frame.yaml",
        contents: legacyFiles.find(({ path }) => path === "control/frame.yaml")!
          .contents,
      },
    },
  ]);

  expect(results[0]).toMatchObject({ isError: true });
  expect(results[0]?.markdown).toContain("Use @ref or a world/ logical path");
  expect(results[1]).toMatchObject({ isError: false });
  expect(results[2]).toMatchObject({ isError: true });
  expect(results[2]?.markdown).toContain("Invalid world-document selector");
  expect(results[3]).toMatchObject({ isError: false });
  expect(results[3]?.markdown).toContain(
    'currentSituation: "@current-situation"',
  );
  expect(results[3]?.markdown).not.toContain("situation.current");
  expect(results[4]).toMatchObject({ isError: false });
  expect(results[4]?.markdown).toContain('$ref: "@current-situation"');
  expect(results[4]?.markdown).not.toContain("situation.current");
  expect(results[5]).toMatchObject({ isError: false });
  expect(results[5]?.markdown).toContain('document: "@current-situation"');
  expect(results[5]?.markdown).not.toContain("situation.current");
  expect(results[6]).toMatchObject({ isError: false });
  expect(results[6]?.markdown).toContain("@current-situation");
  expect(results[6]?.markdown).not.toContain("situation.current");
  expect(results[7]).toMatchObject({ isError: false });
  expect(
    transaction.files().find(({ path }) => path === "control/frame.yaml")
      ?.contents,
  ).toContain('currentSituation: "@current-situation"');
  expect(
    transaction.files().find(({ path }) => path === "control/frame.yaml")
      ?.contents,
  ).not.toContain("situation.current");
});

test("当前树读取授权可按精确 revision 恢复", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const revision = "current-tree-revision";
  const first = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    revision,
    preview: () => preview,
  });
  first.execute([
    {
      id: "read-opening",
      name: "setting_read",
      arguments: { path: "opening.md" },
    },
  ]);
  const restored = new SettingAuthoringTransaction({
    baseFiles: first.files(),
    locale: "en",
    revision,
    preview: () => preview,
    authorization: first.authorization(revision),
  });
  const result = restored.execute([
    {
      id: "write-opening",
      name: "setting_write_file",
      arguments: { path: "opening.md", contents: "A recovered opening." },
    },
  ]);
  expect(result).toMatchObject([{ isError: false }]);
  expect(restored.review().diff).toHaveLength(1);
});

test("无效 cursor 不会把正常世界文档误授权为可覆盖的损坏文档", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const path = "world/current-situation.yaml";
  const source = baseFiles.find((file) => file.path === path)?.contents;
  expect(source).toBeTypeOf("string");

  expect(
    transaction.execute([
      {
        id: "bad-cursor",
        name: "setting_read",
        arguments: { path, cursor: "not-a-cursor" },
      },
    ]),
  ).toMatchObject([{ isError: true }]);
  expect(
    transaction.execute([
      {
        id: "unauthorized-write",
        name: "setting_write_file",
        arguments: {
          path,
          contents: source?.replace(
            "location: Not set",
            "location: Rain wharf",
          ),
        },
      },
    ]),
  ).toMatchObject([{ isError: true }]);
});

function productionPreview(snapshot: WorldDocumentStore): PromptPreview {
  const playPreset = builtinDefaultPlayPresetBinding("en");
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  const openingMessage = "setting-transaction.message.genesis.narrator";
  const opening = snapshot.files.find(({ path }) => path === "opening.md");
  return compiler.preview(
    {
      endpoint: { id: "setting-authoring", commit: "current-tree" },
      hostBinding: presetHostBinding(playPreset),
      world: {
        controlFingerprint: "setting-authoring",
        documentSnapshot: snapshot,
        history: { [openingMessage]: opening?.contents ?? "" },
        additionalMaterials: [
          { kind: "history_message", message: openingMessage },
        ],
      },
      playerInputPlacement: "append",
      playerInput: "Preview the setting transaction.",
      modelBinding: {
        provider: "chat_completions",
        modelId: "preview-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 4_096,
      },
    },
    playPreset,
  );
}
