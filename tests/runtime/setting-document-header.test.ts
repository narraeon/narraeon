import { expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { SettingAuthoringTransaction } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

function write(path: string, contents: string) {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("en"),
    locale: "en",
    preview: () =>
      ({
        compilation: { coverage: [], logicalMessages: [] },
        leakage: { status: "clean", checkedFields: [] },
      }) as unknown as PromptPreview,
  });
  return transaction.execute([
    { id: "write", name: "setting_write_file", arguments: { path, contents } },
  ])[0]!;
}

const header =
  '"$document":\n  ref: campus\n  title: Campus\n  summary: Campus events.\n  aliases: []';

test.each([
  ["world/events/campus.yaml", `${header}\nevent: meeting\n`],
  [
    "world/events/campus.md",
    `---\n${header}\n---\n# Campus\n\nA campus meeting.\n`,
  ],
])("write_file 识别带引号的文档头键 %s", (path, contents) => {
  const result = write(path, contents);
  expect(result.isError, result.markdown).toBe(false);
});

test.each([
  "---\ntitle: Example\n---\n\n$document: example\n",
  "---\n---\n$document: example\n---\n",
  "# Example\n\n---\n$document: example\n---\n",
])("write_file 保留新建提示，正文示例不算技术文档头", (contents) => {
  const result = write("world/events/example.md", contents);
  expect(result.isError).toBe(true);
  expect(result.markdown).toContain(
    "Create a new world document with setting_create",
  );
});
