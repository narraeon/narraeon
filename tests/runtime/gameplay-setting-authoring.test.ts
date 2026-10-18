import { expect, test } from "vitest";

import { gameplayFile, gameplayPath } from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  SettingAuthoringTransaction,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

function tabletopFiles(scheme: "d20" | "d100" | "bag" = "d100") {
  return [
    ...minimalFileNativeContentScaffold("en"),
    gameplayFile({ mode: "tabletop", scheme }),
  ];
}

test("设定完善可以读取并改写跑团判定方案，回执说明新方案", () => {
  const baseFiles = tabletopFiles("d100");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });

  const results = transaction.execute([
    {
      id: "read-gameplay",
      name: "setting_read",
      arguments: { path: gameplayPath },
    },
    {
      id: "write-gameplay",
      name: "setting_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "tabletop", scheme: "bag" }).contents,
      },
    },
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([false, false]);
  expect(results[1]?.markdown).toContain("Updated control/gameplay.json");
  expect(results[1]?.markdown).toContain(
    "Current gameplay: Tabletop · Chaos bag.",
  );
  expect(results[1]?.changes).toEqual([
    expect.objectContaining({ path: gameplayPath, kind: "modify" }),
  ]);
  expect(transaction.files()).toContainEqual(
    gameplayFile({ mode: "tabletop", scheme: "bag" }),
  );
  expect(transaction.review()).toMatchObject({ status: "usable" });
});

test("修改玩法文件前必须完整读取它", () => {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: tabletopFiles("d100"),
    locale: "zh-CN",
    preview: () => preview,
  });

  const [result] = transaction.execute([
    {
      id: "write-gameplay",
      name: "setting_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
      },
    },
  ]);

  expect(result).toMatchObject({ isError: true, changes: [] });
  expect(result?.markdown).toContain("control/gameplay.json");
  expect(result?.markdown).toContain("完整读取");
});

test("改变玩法模式是工具错误，不回滚同一响应中的成功调用", () => {
  const baseFiles = tabletopFiles("d100");
  const transaction = new SettingAuthoringTransaction({
    baseFiles,
    locale: "en",
    preview: () => preview,
  });
  const world = baseFiles.find(
    ({ path }) => path === "control/blocks/world.md",
  )!;

  const results = transaction.execute([
    {
      id: "read-gameplay",
      name: "setting_read",
      arguments: { path: gameplayPath },
    },
    {
      id: "read-world-rules",
      name: "setting_read",
      arguments: { path: "control/blocks/world.md" },
    },
    {
      id: "switch-to-fiction",
      name: "setting_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "interactive-fiction" }).contents,
      },
    },
    {
      id: "edit-world-rules",
      name: "setting_write_file",
      arguments: {
        path: "control/blocks/world.md",
        contents: `${world.contents}\nA sibling edit still lands.\n`,
      },
    },
  ]);

  expect(results.map(({ isError }) => isError)).toEqual([
    false,
    false,
    true,
    false,
  ]);
  expect(results[2]?.markdown).toContain("Gameplay mode is fixed");
  expect(results[2]?.changes).toEqual([]);
  expect(transaction.files()).toContainEqual(
    gameplayFile({ mode: "tabletop", scheme: "d100" }),
  );
  expect(transaction.files()).toContainEqual(
    expect.objectContaining({
      path: "control/blocks/world.md",
      contents: `${world.contents}\nA sibling edit still lands.\n`,
    }),
  );
});

test("损坏的玩法文件和写入普通包的跑团文件都作为工具错误返回", () => {
  const fictionTransaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("en"),
    locale: "en",
    preview: () => preview,
  });
  const [addTabletop] = fictionTransaction.execute([
    {
      id: "add-tabletop",
      name: "setting_write_file",
      arguments: {
        path: gameplayPath,
        contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
      },
    },
  ]);
  expect(addTabletop).toMatchObject({ isError: true, changes: [] });
  expect(addTabletop?.markdown).toContain("Gameplay mode is fixed");
  expect(fictionTransaction.files().map(({ path }) => path)).not.toContain(
    gameplayPath,
  );

  const tabletopTransaction = new SettingAuthoringTransaction({
    baseFiles: tabletopFiles("d100"),
    locale: "en",
    preview: () => preview,
  });
  const [read, broken] = tabletopTransaction.execute([
    {
      id: "read-gameplay",
      name: "setting_read",
      arguments: { path: gameplayPath },
    },
    {
      id: "write-broken",
      name: "setting_write_file",
      arguments: { path: gameplayPath, contents: "{ broken" },
    },
  ]);
  expect(read?.isError).toBe(false);
  expect(broken).toMatchObject({ isError: true, changes: [] });
  expect(broken?.markdown).toContain("valid JSON");
  expect(tabletopTransaction.files()).toContainEqual(
    gameplayFile({ mode: "tabletop", scheme: "d100" }),
  );
});

test("工具描述与运行时契约只新增玩法文件路径，不加入跑团规则", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const write = settingImprovementToolDefinitions(locale).find(
      ({ name }) => name === "setting_write_file",
    );
    expect(write?.description).toContain("control/gameplay.json");
    expect(settingImprovementRuntimeContract(locale)).toContain(
      "control/gameplay.json",
    );
  }
  expect(settingImprovementRuntimeContract("en")).toContain(
    "only a tabletop resolution scheme may change",
  );
  expect(settingImprovementRuntimeContract("zh-CN")).toContain(
    "只能修改跑团判定方案，玩法模式不可改",
  );
});
