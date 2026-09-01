import { expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  SettingImprovementDraft,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingImprovementDraft.ts";

const preview = {
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

test("设定完善从第一轮起只有固定六个读写工具，没有计划或结束工具", () => {
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
  expect(contract).toContain("没有“计划阶段”“生成阶段”或结束工具");
  expect(contract).toContain("不调用工具的完整响应");
  expect(contract).toContain("原子批次");
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
