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
  SettingImprovementDraft,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingImprovementDraft.ts";
import type { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

test("设定完善契约只描述当前对话、工具与应用行为", () => {
  expect(
    settingImprovementToolDefinitions("zh-CN").map(({ name }) => name),
  ).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_write_file",
    "setting_patch",
    "setting_move",
  ]);
  const contract = settingImprovementRuntimeContract("zh-CN");
  expect(contract).toContain("每条用户消息都追加到当前设定完善对话");
  expect(contract).toContain("用户要求讨论或规划时给出讨论结果");
  expect(contract).toContain("不调用工具的完整响应");
  expect(contract).toContain("原子批次");
  expect(contract).toContain("检查结果随本批工具结果返回");
  expect(contract).toContain("内容包在游玩中的生命周期");
  expect(contract).toContain("world/*");
  expect(contract).toContain("state_list");
  expect(contract).toContain("全新游玩上下文由世界控制与当前世界状态编译");
  expect(contract).toContain("精确 selector");
  expect(contract).not.toMatch(/计划阶段|生成阶段|结束工具|preview 或 finish/u);

  const englishContract = settingImprovementRuntimeContract("en");
  expect(englishContract).not.toMatch(
    /planning phase|generation phase|finish tool|preview and finish tools/iu,
  );
});

test("自动检查把改动文档在真实游玩提示中的覆盖方式返回给模型", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const draft = new SettingImprovementDraft({
    baseFiles,
    locale: "en",
    preview: productionPreview,
  });
  const results = draft.execute([
    {
      id: "create-character",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/alex.yaml",
        contents: `$document:\n  id: ignored\n  ref: alex\n  title: Alex\n  summary: A courier whose current assignment can affect the opening scene.\n  aliases: []\nstatus: waiting at the gate\n`,
      },
    },
    {
      id: "create-lore",
      name: "setting_write_file",
      arguments: {
        path: "world/lore/old-oath.md",
        contents: `---\n$document:\n  id: ignored\n  ref: old-oath\n  title: The old oath\n  summary: Explains the promise that still constrains the two houses.\n  aliases: []\n---\n\n# The old oath\n\nThe two houses may not draw steel inside the gate.\n`,
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
  expect(draft.review().playCoverage).toMatchObject({
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

test("同一完整响应里的所有写入整批原子回滚，读取结果仍保留", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const draft = new SettingImprovementDraft({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const opening = baseFiles.find(({ path }) => path === "opening.md")!;
  const results = draft.execute([
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

  expect(results.map(({ isError }) => isError)).toEqual([false, true, true]);
  expect(draft.files()).toEqual(baseFiles);
  expect(draft.review().diff).toEqual([]);

  const accepted = draft.execute([
    {
      id: "write-opening-again",
      name: "setting_write_file",
      arguments: {
        path: "opening.md",
        contents: `${opening.contents}\nChanged.`,
      },
    },
  ]);
  expect(accepted).toMatchObject([{ isError: false }]);
  expect(draft.review()).toMatchObject({
    status: "usable",
    diff: [{ path: "opening.md", kind: "modify" }],
  });
});

test("草稿读取授权和内容可持久化后恢复", () => {
  const baseFiles = minimalFileNativeContentScaffold("en");
  const first = new SettingImprovementDraft({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  first.execute([
    {
      id: "read-opening",
      name: "setting_read",
      arguments: { path: "opening.md" },
    },
  ]);
  const restored = new SettingImprovementDraft({
    baseFiles,
    locale: "en",
    preview: () => preview,
    persisted: first.persist(),
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
  const draft = new SettingImprovementDraft({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const path = "world/current-situation.yaml";
  const source = baseFiles.find((file) => file.path === path)?.contents;
  expect(source).toBeTypeOf("string");

  expect(
    draft.execute([
      {
        id: "bad-cursor",
        name: "setting_read",
        arguments: { path, cursor: "not-a-cursor" },
      },
    ]),
  ).toMatchObject([{ isError: true }]);
  expect(
    draft.execute([
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
  const openingMessage = "setting-draft.message.genesis.narrator";
  const opening = snapshot.files.find(({ path }) => path === "opening.md");
  return compiler.preview(
    {
      endpoint: { id: "setting-draft", commit: "draft" },
      hostBinding: presetHostBinding(playPreset),
      world: {
        controlFingerprint: "setting-draft",
        documentSnapshot: snapshot,
        history: { [openingMessage]: opening?.contents ?? "" },
        additionalMaterials: [
          { kind: "history_message", message: openingMessage },
        ],
      },
      playerInputPlacement: "append",
      playerInput: "Preview the setting draft.",
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
