import { expect, test } from "vitest";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { registeredRuntimeToolNames } from "../../src/runtime/prompt/FileNativeToolRegistry.ts";
import {
  renderToolAliasNote,
  resolveToolName,
} from "../../src/runtime/prompt/ToolNameAlias.ts";
import {
  authoringToolDefinitions,
  contentPackageAuthoringSurface,
  SettingAuthoringTransaction,
  worldRevisionAuthoringSurface,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

test("a name is restored only when exactly one provided tool is its _ suffix", () => {
  const provided = ["state_list", "world_create", "d20_check"];
  expect(resolveToolName("state_list", provided)).toEqual({
    kind: "exact",
    name: "state_list",
  });
  expect(
    resolveToolName("mcp__paddle_steel__margin_world_create", provided),
  ).toEqual({
    kind: "alias",
    name: "world_create",
    declared: "mcp__paddle_steel__margin_world_create",
  });
  expect(resolveToolName("margin_world_create", provided)).toMatchObject({
    kind: "alias",
    name: "world_create",
  });
  // A bare tool name is not its own suffix match.
  expect(resolveToolName("world_create", ["create", "world_create"])).toEqual({
    kind: "exact",
    name: "world_create",
  });
  // Prefix, fuzzy, and case-folded spellings are not restored.
  expect(resolveToolName("state_lis", provided)).toMatchObject({
    kind: "rejected",
    candidates: [],
  });
  expect(resolveToolName("STATE_LIST", provided)).toMatchObject({
    kind: "rejected",
    candidates: [],
  });
  // A name that matches a tool not provided by this request is rejected.
  expect(resolveToolName("x_setting_patch", provided)).toMatchObject({
    kind: "rejected",
    candidates: [],
  });
});

test("two provided tools matching one name reject it instead of guessing", () => {
  expect(resolveToolName("x_a_b", ["a_b", "b"])).toEqual({
    kind: "rejected",
    candidates: ["a_b", "b"],
  });
});

test("the alias note names both spellings in the request locale", () => {
  expect(renderToolAliasNote("margin_world_create", "world_create", "en")).toBe(
    'Runtime note: "margin_world_create" is not a declared tool; it was executed as "world_create". Call tools by their declared names.',
  );
  expect(
    renderToolAliasNote("margin_world_create", "world_create", "zh-CN"),
  ).toContain('已按 "world_create" 执行');
});

/**
 * A later registered name must not end with `_<earlier name>`, or a
 * provider-mangled `mcp__<server>__<word>_<name>` would be ambiguous. The
 * constraint covers the play vocabulary and both setting surfaces.
 */
test("no two declared Runtime tool names are `_` suffixes of each other", () => {
  const names = [
    ...new Set([
      ...registeredRuntimeToolNames,
      "context_list",
      ...authoringToolDefinitions(
        contentPackageAuthoringSurface,
        "en",
        fictionGameplay,
      ).map(({ name }) => name),
      ...authoringToolDefinitions(
        worldRevisionAuthoringSurface,
        "en",
        fictionGameplay,
      ).map(({ name }) => name),
    ]),
  ];
  const clashes = names.flatMap((a) =>
    names
      .filter((b) => a !== b && a.endsWith(`_${b}`))
      .map((b) => `${a} ends with _${b}`),
  );
  expect(
    clashes,
    "Alias restoration needs declared tool names that are never `_` suffixes of one another; a clash makes a mangled name ambiguous.",
  ).toEqual([]);
});

function transaction(surface: "content" | "revision") {
  return new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold("en"),
    locale: "en",
    preview: () => preview,
    surface:
      surface === "content"
        ? contentPackageAuthoringSurface
        : worldRevisionAuthoringSurface,
  });
}

test("a setting alias runs under its setting_ name with a Runtime note", () => {
  const [result] = transaction("content").execute([
    { id: "alias-list", name: "x_setting_list", arguments: {} },
  ]);
  expect(result?.isError).not.toBe(true);
  expect(result?.markdown).toContain("Runtime note");
  expect(result?.markdown).toContain('"setting_list"');
});

test("a setting alias keeps the #111 argument repair and adds its own note", () => {
  const [result] = transaction("content").execute([
    {
      id: "alias-create",
      name: "x_setting_create",
      arguments: {
        path: "world/characters/alex.yaml",
        ref: "alex",
        title: "Alex",
        summary: "Alex is waiting at the gate.",
        aliases: '["Al"]',
        body: "role: gatekeeper",
      },
    },
  ]);
  expect(result?.markdown).not.toContain("must be a JSON array");
  expect(result?.markdown).toContain('"aliases"');
  expect(result?.markdown).toContain('"setting_create"');
});

test("x_setting_patch on the content surface reaches setting_patch, not a rejection", () => {
  const [result] = transaction("content").execute([
    { id: "alias-patch", name: "x_setting_patch", arguments: {} },
  ]);
  expect(result?.markdown).not.toContain("is not a tool on this surface");
  expect(result?.markdown).toContain('"setting_patch"');
});

test("x_setting_patch on a world revision surface is rejected and lists its tools", () => {
  const [result] = transaction("revision").execute([
    { id: "wrong-surface", name: "x_setting_patch", arguments: {} },
  ]);
  expect(result?.isError).toBe(true);
  expect(result?.markdown).toContain(
    "x_setting_patch is not a tool on this surface.",
  );
  for (const name of authoringToolDefinitions(
    worldRevisionAuthoringSurface,
    "en",
    fictionGameplay,
  ).map(({ name }) => name))
    expect(result?.markdown).toContain(name);
});
