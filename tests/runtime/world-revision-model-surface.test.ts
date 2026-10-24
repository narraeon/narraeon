import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  appLocales,
  type AppLocale,
} from "../../src/protocol/appPreferences.ts";
import { fictionGameplay, type Gameplay } from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { ContentTreeFile } from "../../src/runtime/content/ContentTreeFile.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  WorldRevisionAuthoringTransaction,
  worldRevisionRuntimeContract,
  worldRevisionToolDefinitions,
} from "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

const tabletopGameplay: Gameplay = { mode: "tabletop", scheme: "d20" };

/**
 * The contract intentionally names the content package once, to tell the
 * author that a world revision is not the source template. Every other
 * model-visible sentence must use the world-revision vocabulary.
 */
const intentionalContrast = {
  en: "not its source content package",
  "zh-CN": "而不是创建世界所用的内容包",
} as const satisfies Record<AppLocale, string>;

const contentPackageLeak = /content[ -]package|内容包/iu;
const settingToolLeak = /\bsetting_[a-z_]+/u;
const worldPathLeak = /(?<![A-Za-z_])world\//u;

/** A world revision edits the state/control worktree of a world already in play. */
function worldRevisionFiles(locale: AppLocale): ContentTreeFile[] {
  return minimalFileNativeContentScaffold(locale)
    .filter(({ path }) => path !== "opening.md")
    .map((file) =>
      file.path.startsWith("world/")
        ? { ...file, path: `state/${file.path.slice("world/".length)}` }
        : file,
    );
}

function worldRevisionTranscript(locale: AppLocale, gameplay: Gameplay) {
  const files = worldRevisionFiles(locale);
  const transaction = new WorldRevisionAuthoringTransaction({
    baseFiles: files,
    immutableBaseFiles: files,
    locale,
    preview: () => preview,
  });
  const results = transaction.execute([
    { id: "list-root", name: "world_revision_list", arguments: {} },
    {
      id: "search-situation",
      name: "world_revision_search",
      arguments: { query: "situation" },
    },
    {
      id: "read-opening",
      name: "world_revision_read",
      arguments: { path: "opening.md" },
    },
    {
      id: "read-situation",
      name: "world_revision_read",
      arguments: { path: "state/current-situation.yaml" },
    },
    {
      id: "write-broken-yaml",
      name: "world_revision_write_file",
      arguments: {
        path: "state/current-situation.yaml",
        contents: "title: [unclosed\n",
      },
    },
    {
      id: "write-control-block",
      name: "world_revision_write_file",
      arguments: {
        path: "control/blocks/extra.md",
        contents: "# Extra\n\nKeep the table honest.\n",
      },
    },
    {
      id: "delete-current-situation",
      name: "world_revision_delete",
      arguments: { document: "state/current-situation.yaml" },
    },
    {
      id: "patch-missing-node",
      name: "world_revision_patch",
      arguments: {
        document: "state/current-situation.yaml",
        op: "replace",
        locator: ["missing"],
        value: "x",
      },
    },
    {
      id: "move-current-situation",
      name: "world_revision_move",
      arguments: {
        from: "state/current-situation.yaml",
        to: "state/moved.yaml",
      },
    },
    {
      id: "namespace-rejected",
      name: "world_revision_read",
      arguments: { path: "world/current-situation.yaml" },
    },
  ]);
  return {
    tools: worldRevisionToolDefinitions(locale, gameplay),
    contract: worldRevisionRuntimeContract(locale, gameplay),
    results,
    review: transaction.review(),
  };
}

function withoutIntentionalContrast(text: string, locale: AppLocale): string {
  return text.replaceAll(intentionalContrast[locale], "");
}

test("world-revision tool definitions never name the content package or setting tools", () => {
  for (const locale of appLocales)
    for (const gameplay of [fictionGameplay, tabletopGameplay]) {
      const tools = worldRevisionToolDefinitions(locale, gameplay);
      expect(tools.map(({ name }) => name)).toEqual([
        "world_revision_list",
        "world_revision_search",
        "world_revision_read",
        "world_revision_create",
        "world_revision_write_file",
        "world_revision_patch",
        "world_revision_move",
        "world_revision_delete",
      ]);
      for (const tool of tools) {
        const text = JSON.stringify(tool);
        expect(text, tool.name).not.toMatch(contentPackageLeak);
        expect(text, tool.name).not.toMatch(settingToolLeak);
        expect(text, tool.name).not.toMatch(worldPathLeak);
      }
    }
});

test("world-revision delete description uses the worktree vocabulary in English", () => {
  const description = worldRevisionToolDefinitions("en", fictionGameplay).find(
    ({ name }) => name === "world_revision_delete",
  )?.description;
  expect(description).toBeDefined();
  expect(description).not.toMatch(/content[ -]package/iu);
  expect(description).toContain("world revision worktree");
});

test("world-revision runtime contract names the content package only in its contrast sentence", () => {
  for (const locale of appLocales)
    for (const gameplay of [fictionGameplay, tabletopGameplay]) {
      const contract = worldRevisionRuntimeContract(locale, gameplay);
      expect(withoutIntentionalContrast(contract, locale), locale).not.toMatch(
        contentPackageLeak,
      );
      expect(contract, locale).not.toMatch(settingToolLeak);
      expect(contract, locale).not.toMatch(worldPathLeak);
    }
});

test("world-revision tool results never leak content-package wording or world/ paths", () => {
  for (const locale of appLocales)
    for (const gameplay of [fictionGameplay, tabletopGameplay]) {
      const transcript = worldRevisionTranscript(locale, gameplay);
      for (const result of transcript.results) {
        const text = result.markdown;
        expect(text, `${locale} ${result.toolCallId}`).not.toMatch(
          contentPackageLeak,
        );
        expect(text, `${locale} ${result.toolCallId}`).not.toMatch(
          settingToolLeak,
        );
        expect(text, `${locale} ${result.toolCallId}`).not.toMatch(
          worldPathLeak,
        );
      }
      expect(JSON.stringify(transcript.review)).not.toMatch(contentPackageLeak);
    }
});

test("world-revision results name the worktree, state/ paths and the rejected opening", () => {
  const transcript = worldRevisionTranscript("en", fictionGameplay);
  const byId = new Map(
    transcript.results.map((result) => [result.toolCallId, result]),
  );
  expect(byId.get("read-situation")?.markdown).toContain(
    "logicalPath: state/current-situation.yaml",
  );
  expect(byId.get("write-control-block")?.markdown).toContain(
    "in the world revision worktree",
  );
  expect(byId.get("delete-current-situation")?.isError).toBe(true);
  expect(byId.get("read-opening")?.markdown).toContain(
    "opening.md is immutable after a world has been created",
  );
  expect(byId.get("namespace-rejected")?.markdown).toContain(
    "exposes only state/* and control/* logical paths",
  );
  expect(transcript.review.status).toBe("usable");
  expect(transcript.review.diagnostics.map(({ path }) => path)).not.toContain(
    "opening.md",
  );
});

test("world-revision transaction returns rendered text without post-hoc rewriting", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  expect(source).not.toContain("replaceAll(");
  expect(source).not.toContain("publicWorldRevisionMarkdown");
  expect(source).not.toContain("mapSchema");
  expect(source).not.toContain("syntheticOpening");
});
