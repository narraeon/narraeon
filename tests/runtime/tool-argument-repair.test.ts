import { expect, test } from "vitest";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { SettingAuthoringTransaction } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

function transaction() {
  return new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("en"),
    locale: "en",
    preview: () => preview,
  });
}

function create(aliases: unknown) {
  return {
    id: "create-alex",
    name: "setting_create",
    arguments: {
      path: "world/characters/alex.yaml",
      ref: "alex",
      title: "Alex",
      summary: "Alex is waiting at the gate.",
      aliases,
      body: "role: gatekeeper",
    },
  };
}

test("setting_create parses a JSON-string aliases array and notes the repair", () => {
  const call = create('["Al"]');
  const [result] = transaction().execute([call]);
  expect(result?.markdown).toContain("Runtime note");
  expect(result?.markdown).toContain('"aliases"');
  expect(result?.markdown).not.toContain("must be a JSON array");
  expect(call.arguments.aliases).toBe('["Al"]');
});

test("setting_create names the real cause when aliases is an unparseable string", () => {
  const [result] = transaction().execute([create("Al")]);
  expect(result?.isError).toBe(true);
  expect(result?.markdown).toContain(
    "aliases must be a JSON array of at most 16 strings, not a string",
  );
});

test("a setting call with native arrays gets no Runtime note", () => {
  const [result] = transaction().execute([create(["Al"])]);
  expect(result?.markdown).not.toContain("Runtime note");
});
