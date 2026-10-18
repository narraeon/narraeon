import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  gameplayFile,
  type Gameplay,
  type ResolutionScheme,
} from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  baseRuntimeToolNames,
  runtimeToolNamesForGameplay,
} from "../../src/runtime/prompt/FileNativeToolRegistry.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  builtinDefaultPlayPresetBinding,
  defaultPlayPresetFilesForLocale,
  legacyDefaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { settingImprovementToolDefinitions } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import {
  previewInputWithGameplay,
  toolNames,
} from "../support/tabletopFixtures.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fiction: Gameplay = { mode: "interactive-fiction" };
const schemes: [ResolutionScheme, string][] = [
  ["d20", "d20_check"],
  ["d100", "percentile_check"],
  ["bag", "bag_check"],
];

/**
 * Play call chains expose the chain's own surface: artifact tools belong to
 * follow-up requests, so the chain universe is the gameplay surface minus them.
 */
function playChainToolNames(gameplay: Gameplay): string[] {
  return runtimeToolNamesForGameplay(gameplay).filter(
    (name) => name !== "artifact_emit" && name !== "artifact_clear",
  );
}

function bindingFromFiles(files: Record<string, string>): PlayPresetBinding {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "tool-exposure",
    name: "tool exposure",
    revision: "rev-tool-exposure",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

describe("per-world tool exposure", () => {
  test("fiction keeps the base surface and each scheme adds its check plus auxiliary tools", () => {
    expect(runtimeToolNamesForGameplay(fiction)).toEqual([
      ...baseRuntimeToolNames,
    ]);
    for (const [scheme, check] of schemes)
      expect(runtimeToolNamesForGameplay({ mode: "tabletop", scheme })).toEqual(
        [...baseRuntimeToolNames, check, "roll_dice", "calculate"],
      );
  });

  test.each([
    ["ordered default", () => builtinDefaultPlayPresetBinding("en")],
    [
      "legacy v1 preset",
      () => bindingFromFiles(legacyDefaultPlayPresetFilesForLocale("en")),
    ],
    [
      "ordered preset",
      () => bindingFromFiles(defaultPlayPresetFilesForLocale("zh-CN")),
    ],
  ])(
    "play preview and call chain derive tools from the world (%s)",
    (_name, binding) => {
      const compiler = new FileNativePromptCompiler();
      for (const gameplay of [
        fiction,
        ...schemes.map(([scheme]) => ({ mode: "tabletop" as const, scheme })),
      ]) {
        const input = previewInputWithGameplay(gameplay, {
          playerInputPlacement: "append",
        });
        const expected = playChainToolNames(gameplay);
        const preview = compiler.preview(input, binding());
        expect(toolNames(preview.playPreset!.toolUniverse)).toEqual(expected);
        expect(toolNames(preview.compilation.tools)).toEqual(expected);
        expect(
          toolNames(
            compiler.compilePlayCallChain(input, binding()).toolUniverse,
          ),
        ).toEqual(expected);
      }
    },
  );

  test("bootstrap without a preset derives tools from the same gameplay", () => {
    const compiler = new FileNativePromptCompiler();
    expect(
      toolNames(
        compiler.compileBootstrap(previewInputWithGameplay(fiction)).tools,
      ),
    ).toEqual([...baseRuntimeToolNames]);
    expect(
      toolNames(
        compiler.compileBootstrap(
          previewInputWithGameplay({ mode: "tabletop", scheme: "bag" }),
        ).tools,
      ),
    ).toEqual(runtimeToolNamesForGameplay({ mode: "tabletop", scheme: "bag" }));
    expect(
      toolNames(
        compiler.preview(
          previewInputWithGameplay({ mode: "tabletop", scheme: "d100" }),
        ).compilation.tools,
      ),
    ).toEqual(
      runtimeToolNamesForGameplay({ mode: "tabletop", scheme: "d100" }),
    );
  });

  test("a continued send derives the tabletop tools from the world, even when frozen before them", () => {
    const compiler = new FileNativePromptCompiler();
    const binding = builtinDefaultPlayPresetBinding("en");
    const frozenFiction = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction),
      binding,
    ).bootstrap;
    const tabletop: Gameplay = { mode: "tabletop", scheme: "d20" };
    const resumed = compiler.compilePlayCallChain(
      {
        ...previewInputWithGameplay(tabletop, {
          playerInputPlacement: "append",
        }),
        frozenWorldContext: frozenFiction,
      },
      binding,
    );
    expect(toolNames(resumed.toolUniverse)).toEqual(
      playChainToolNames(tabletop),
    );
    expect(toolNames(resumed.bootstrap.tools)).toEqual(
      playChainToolNames(tabletop),
    );
  });

  test("authoring tool sets are independent of world gameplay", () => {
    const compiler = new FileNativePromptCompiler();
    const tools = settingImprovementToolDefinitions("en");
    const input = previewInputWithGameplay({ mode: "tabletop", scheme: "d20" });
    const compiled = compiler.compileSettingImprovement({
      gameplay: { mode: "interactive-fiction" },
      contentPackageTitle: "Authoring",
      runtimeContract: "contract",
      authorPrompt: "author",
      playPreset: builtinDefaultPlayPresetBinding("en"),
      modelBinding: input.modelBinding,
      tools,
    });
    expect(toolNames(compiled.tools)).toEqual(toolNames(tools));
    expect(toolNames(compiled.tools)).not.toContain("d20_check");
  });
});

describe("store-level previews use the world's gameplay", () => {
  test("creation preview and control-draft preview expose the scheme's tools only for tabletop worlds", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-tool-exposure-"));
    roots.push(root);
    const store = new FileNativeWorldStore(root);
    const created = await store.createFromContentPackage(
      input("tool-exposure-d100", [
        ...minimalFileNativeContentScaffold("en"),
        gameplayFile({ mode: "tabletop", scheme: "d100" }),
      ]),
    );
    if (created.outcome !== "created") throw new Error("world not created");
    const tabletopTools = runtimeToolNamesForGameplay({
      mode: "tabletop",
      scheme: "d100",
    });
    expect(toolNames(created.preview.compilation.tools)).toEqual(tabletopTools);

    const control = await store.readSurface(created.world.worldId, "control");
    await store.saveControlDraft(created.world.worldId, control);
    const draftPreview = await store.previewControlDraft(
      created.world.worldId,
      input("unused", []).prompt,
    );
    expect(toolNames(draftPreview.compilation.tools)).toEqual(tabletopTools);

    const fiction = await store.createFromContentPackage(
      input("tool-exposure-fiction", minimalFileNativeContentScaffold("en")),
    );
    if (fiction.outcome !== "created") throw new Error("world not created");
    expect(toolNames(fiction.preview.compilation.tools)).toEqual([
      ...baseRuntimeToolNames,
    ]);
  });
});

function input(
  sourcePackageId: string,
  packageFiles: readonly { path: string; contents: string }[],
) {
  return {
    operationId: `create-${sourcePackageId}`,
    sourcePackageId,
    sourcePackageTitle: "Tool exposure world",
    packageFiles,
    prompt: {
      hostBinding: {
        hostPresetId: "host-1",
        files: {
          "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
          "blocks/style.md": "# Host style\n\nRestrained and specific.\n",
        },
      },
      modelBinding: {
        provider: "chat_completions" as const,
        modelId: "test-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    },
  };
}
