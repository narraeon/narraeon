import { describe, expect, test } from "vitest";

import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import type { AuthoringPreloadRecord } from "../../src/runtime/authoring/AuthoringRequestSnapshot.ts";
import { isAuthoringPreloadRecord } from "../../src/runtime/authoring/AuthoringRequestSnapshot.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  type PromptPreview,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  defaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  authoringPreloadAuthorization,
  buildAuthoringPreload,
  contentPackageAuthoringSurface,
  SettingAuthoringTransaction,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
  worldRevisionAuthoringSurface,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { WorldRevisionAuthoringTransaction } from "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

const preview = {
  compilation: { coverage: [], logicalMessages: [] },
  leakage: { status: "clean", checkedFields: [] },
} as unknown as PromptPreview;

const contentFiles = minimalFileNativeContentScaffold("zh-CN");
const contentRevision = contentTreeFingerprint(contentFiles);

function contentSnapshot() {
  return WorldDocumentStore.open({
    layout: "content_package",
    files: contentFiles,
  });
}

function preloadFor(revision = contentRevision) {
  return buildAuthoringPreload({
    snapshot: contentSnapshot(),
    surface: contentPackageAuthoringSurface,
    locale: "zh-CN",
    revision,
    sourcePrefix: "content-package:preload",
    injected: [{ shortRef: "current-situation", slot: "current_situation" }],
  });
}

describe("authoring preload", () => {
  test("preloads directory, control documents, and injected documents with their sources", () => {
    const { blocks, record } = preloadFor();
    const sources = blocks.map(({ source }) => source);

    expect(sources).toEqual([
      "content-package:preload/directory",
      "content-package:preload/control/frame.yaml",
      "content-package:preload/control/player-views.yaml",
      "content-package:preload/control/blocks/world.md",
      "content-package:preload/world/current-situation.yaml",
      "content-package:preload/runtime",
    ]);
    const directory = blocks[0]!.markdown;
    expect(directory).toContain("@current-situation");
    expect(directory).toContain("- [special] opening.md");
    // The directory grants no read authority; only the preloaded bodies do.
    expect(record.opaquePaths).toEqual([
      "control/blocks/world.md",
      "control/frame.yaml",
      "control/player-views.yaml",
    ]);
    expect(record.worldDocumentIds).toEqual([expect.stringMatching(/./u)]);
    expect(record.revision).toBe(contentRevision);
  });

  test("injected document text matches the model's exact read byte for byte", () => {
    const { blocks } = preloadFor();
    const injected = blocks.find(({ source }) =>
      source.endsWith("world/current-situation.yaml"),
    )!;
    const transaction = new SettingAuthoringTransaction({
      baseFiles: contentFiles,
      locale: "zh-CN",
      preview: () => preview,
    });
    const [read] = transaction.execute([
      {
        id: "read",
        name: "setting_read",
        arguments: { path: "world/current-situation.yaml" },
      },
    ]);
    expect(read!.markdown).toBeDefined();
    expect(injected.markdown.endsWith(read!.markdown)).toBe(true);
  });

  test("preloaded bodies are writable without a read; listed-only files are not", () => {
    const { record } = preloadFor();
    const transaction = new SettingAuthoringTransaction({
      baseFiles: contentFiles,
      locale: "zh-CN",
      preview: () => preview,
      revision: contentRevision,
      authorization: authoringPreloadAuthorization(null, record),
    });
    const [written, refused] = transaction.execute([
      {
        id: "write-preloaded",
        name: "setting_write_file",
        arguments: {
          path: "control/blocks/world.md",
          contents: "# 本世界\n\n更新后的说明。",
        },
      },
      {
        id: "write-listed-only",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: "新的开场。" },
      },
    ]);
    expect(written!.isError).toBe(false);
    expect(refused!.isError).toBe(true);
  });

  test("a revision mismatch drops the preload authority", () => {
    const { record } = preloadFor("stale-revision");
    const transaction = new SettingAuthoringTransaction({
      baseFiles: contentFiles,
      locale: "zh-CN",
      preview: () => preview,
      revision: contentRevision,
      authorization: authoringPreloadAuthorization(null, record),
    });
    const [refused] = transaction.execute([
      {
        id: "write-stale",
        name: "setting_write_file",
        arguments: {
          path: "control/blocks/world.md",
          contents: "不能写入。",
        },
      },
    ]);
    expect(refused!.isError).toBe(true);
  });

  test("merging a new revision preload replaces read authority from an older revision", () => {
    const older = {
      revision: "old",
      readWorldDocumentIds: ["doc-a"],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["control/frame.yaml"],
    };
    const preload: AuthoringPreloadRecord = {
      revision: "new",
      worldDocumentIds: ["doc-b"],
      opaquePaths: ["control/blocks/world.md"],
    };
    expect(authoringPreloadAuthorization(older, preload)).toEqual({
      revision: "new",
      readWorldDocumentIds: ["doc-b"],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["control/blocks/world.md"],
    });
    expect(
      authoringPreloadAuthorization({ ...older, revision: "new" }, preload)
        .readWorldDocumentIds,
    ).toEqual(["doc-a", "doc-b"]);
  });

  test("the request snapshot validator accepts only well-formed preload records", () => {
    expect(
      isAuthoringPreloadRecord({
        revision: "r",
        worldDocumentIds: [],
        opaquePaths: ["control/frame.yaml"],
      }),
    ).toBe(true);
    expect(
      isAuthoringPreloadRecord({ revision: "r", worldDocumentIds: [] }),
    ).toBe(false);
  });

  test("world-revision preload serves the world-revision surface the same way", () => {
    // A playing world keeps its documents under state/ and its controls under control/.
    const files = contentFiles
      .filter(({ path }) => path !== "opening.md")
      .map(({ path, contents }) => ({
        path: path.replace(/^world\//u, "state/"),
        contents,
      }));
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files,
    });
    const { blocks, record } = buildAuthoringPreload({
      snapshot,
      surface: worldRevisionAuthoringSurface,
      locale: "zh-CN",
      revision: "rev-world",
      sourcePrefix: "world-revision:preload",
      injected: [{ shortRef: "current-situation", slot: "current_situation" }],
    });
    expect(blocks[0]!.source).toBe("world-revision:preload/directory");
    expect(blocks.map(({ source }) => source)).toContain(
      "world-revision:preload/state/current-situation.yaml",
    );
    expect(blocks[0]!.markdown).toContain(
      "- [special] control/blocks/world.md",
    );
    expect(record.opaquePaths).toEqual([
      "control/blocks/world.md",
      "control/frame.yaml",
      "control/player-views.yaml",
    ]);
    const transaction = new WorldRevisionAuthoringTransaction({
      history: { scope: "world", entries: [] },
      baseFiles: files,
      immutableBaseFiles: files,
      locale: "zh-CN",
      revision: "rev-world",
      authorization: authoringPreloadAuthorization(null, record),
      preview: () => preview,
    });
    const [written, patched, refused] = transaction.execute([
      {
        id: "write",
        name: "world_revision_write_file",
        arguments: {
          path: "control/blocks/world.md",
          contents: "# 世界\n\n修订。",
        },
      },
      {
        id: "patch-preloaded-document",
        name: "world_revision_patch",
        arguments: {
          document: "@current-situation",
          op: "replace",
          locator: ["地点"],
          value: "新的地点",
        },
      },
      {
        id: "write-listed-document",
        name: "world_revision_write_file",
        arguments: { path: "opening.md", contents: "不能写入。" },
      },
    ]);
    expect(written!.isError).toBe(false);
    expect(patched!.isError).toBe(false);
    expect(refused!.isError).toBe(true);
  });
});

describe("authoring preload in the compiled request", () => {
  const playPreset: PlayPresetBinding = (() => {
    const files = defaultPlayPresetFilesForLocale("zh-CN");
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    return {
      id: "preload",
      name: "preload",
      revision: "rev-preload",
      definition: parsed.definition,
      files,
      scriptsEnabled: true,
    };
  })();
  const modelBinding = createMinimalFileNativePreviewInput({
    provider: "anthropic_messages",
    modelId: "preload-model",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    playerInput: "",
    playerInputPlacement: "bootstrap",
    locale: "zh-CN",
  }).modelBinding;

  function compileSetting(preload?: { source: string; markdown: string }[]) {
    return new FileNativePromptCompiler().compileSettingImprovement({
      gameplay: fictionGameplay,
      contentPackageTitle: "Preload",
      runtimeContract: settingImprovementRuntimeContract(
        "zh-CN",
        fictionGameplay,
      ),
      authorPrompt: "stable author prompt",
      playPreset,
      modelBinding,
      tools: settingImprovementToolDefinitions("zh-CN", fictionGameplay),
      ...(preload === undefined ? {} : { preload }),
    });
  }

  test("preload lands as one world_context message after every author prompt", () => {
    const { blocks } = preloadFor();
    const compiled = compileSetting(blocks);
    const last = compiled.logicalMessages.at(-1)!;
    expect(last.role).toBe("world_context");
    expect(last.promptId).toBe("runtime.preload");
    expect(last.blocks.map(({ source }) => source)).toEqual(
      blocks.map(({ source }) => source),
    );
    expect(last.markdown).toContain("@current-situation");
  });

  test("the stable prefix bytes are unchanged by the preload", () => {
    const without = compileSetting();
    const withPreload = compileSetting(preloadFor().blocks);
    const stable = (messages: typeof without.logicalMessages) =>
      messages
        .filter(
          ({ role }) =>
            role === "runtime_system" || role === "author_instruction",
        )
        .map(({ markdown }) => markdown);
    expect(stable(withPreload.logicalMessages)).toEqual(
      stable(without.logicalMessages),
    );
    expect(withPreload.logicalMessages.length).toBe(
      without.logicalMessages.length + 1,
    );
  });
});
