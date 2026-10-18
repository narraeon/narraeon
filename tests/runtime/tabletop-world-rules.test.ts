import { describe, expect, test } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import type {
  Gameplay,
  ResolutionScheme,
} from "../../src/protocol/gameplay.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  builtinDefaultPlayPresetBinding,
  legacyDefaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  resolutionCheckToolForScheme,
  resolutionToolDefinition,
} from "../../src/runtime/play/TabletopResolution.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const fiction: Gameplay = { mode: "interactive-fiction" };
const schemes: ResolutionScheme[] = ["d20", "d100", "bag"];
const rulesSource = "runtime:world-placeholder/gameplay";

function legacyBinding(locale: AppLocale): PlayPresetBinding {
  const files = legacyDefaultPlayPresetFilesForLocale(locale);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "legacy",
    name: "legacy",
    revision: "rev-legacy",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function rulesBlocks(
  messages: { role: string; blocks: { source: string; markdown: string }[] }[],
) {
  return messages.flatMap(({ role, blocks }) =>
    blocks
      .filter(({ source }) => source === rulesSource)
      .map((block) => ({ role, ...block })),
  );
}

describe("tabletop world rules at the world placeholder", () => {
  for (const locale of ["en", "zh-CN"] as const)
    for (const scheme of schemes) {
      test.each([
        ["ordered default", () => builtinDefaultPlayPresetBinding(locale)],
        ["legacy v1 preset", () => legacyBinding(locale)],
      ])(
        `${locale} ${scheme} world carries one rules block (%s)`,
        (_name, binding) => {
          const compiler = new FileNativePromptCompiler({ locale });
          const input = previewInputWithGameplay(
            { mode: "tabletop", scheme },
            { locale, playerInputPlacement: "bootstrap" },
          );
          const { bootstrap } = compiler.compilePlayCallChain(input, binding());
          const blocks = rulesBlocks(bootstrap.logicalMessages);
          expect(blocks).toHaveLength(1);
          expect(blocks[0]!.role).toBe("world_context");
          const tool = resolutionToolDefinition(
            resolutionCheckToolForScheme(scheme),
            locale,
          ).description;
          expect(blocks[0]!.markdown).toContain(tool);
          expect(blocks[0]!.markdown).toContain(
            locale === "zh-CN" ? "绑定契约" : "Binding contract",
          );
          expect(JSON.stringify(bootstrap.provider).split(tool)).toHaveLength(
            2,
          );
        },
      );
    }

  test("the rules block precedes the materials and the coverage block", () => {
    const compiler = new FileNativePromptCompiler();
    const input = previewInputWithGameplay({ mode: "tabletop", scheme: "d20" });
    const messages = compiler.compilePlayCallChain(
      input,
      builtinDefaultPlayPresetBinding("en"),
    ).bootstrap.logicalMessages;
    const sources = messages
      .filter(({ role }) => role === "world_context")
      .flatMap(({ blocks }) => blocks.map(({ source }) => source));
    expect(sources[0]).toBe(rulesSource);
    expect(sources).toContain("runtime:world-placeholder/coverage");
  });

  test("interactive fiction receives no rules block and no gameplay tools", () => {
    const compiler = new FileNativePromptCompiler();
    for (const locale of ["en", "zh-CN"] as const) {
      const input = previewInputWithGameplay(fiction, { locale });
      const compiled = compiler.compilePlayCallChain(
        input,
        builtinDefaultPlayPresetBinding(locale),
      );
      expect(rulesBlocks(compiled.bootstrap.logicalMessages)).toEqual([]);
      expect(JSON.stringify(compiled.bootstrap.provider)).not.toContain(
        "runtime:world-placeholder/gameplay",
      );
    }
  });

  test("a fresh tabletop context and its later frozen continuation carry the block exactly once", () => {
    const compiler = new FileNativePromptCompiler();
    const binding = builtinDefaultPlayPresetBinding("en");
    const fresh = compiler.compilePlayCallChain(
      previewInputWithGameplay({ mode: "tabletop", scheme: "bag" }),
      binding,
    ).bootstrap;
    expect(rulesBlocks(fresh.logicalMessages)).toHaveLength(1);

    const continued = compiler.compilePlayCallChain(
      {
        ...previewInputWithGameplay(
          { mode: "tabletop", scheme: "bag" },
          { playerInputPlacement: "append" },
        ),
        frozenWorldContext: fresh,
      },
      binding,
    ).bootstrap;
    const rules = rulesBlocks(continued.logicalMessages);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.markdown).toEqual(
      rulesBlocks(fresh.logicalMessages)[0]!.markdown,
    );
  });

  test("a context frozen before tabletop tools existed keeps neither the block nor the tools", () => {
    const compiler = new FileNativePromptCompiler();
    const binding = builtinDefaultPlayPresetBinding("en");
    const frozenFiction = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction),
      binding,
    ).bootstrap;
    const resumed = compiler.compilePlayCallChain(
      {
        ...previewInputWithGameplay(
          { mode: "tabletop", scheme: "d100" },
          { playerInputPlacement: "append" },
        ),
        frozenWorldContext: frozenFiction,
      },
      binding,
    ).bootstrap;
    expect(rulesBlocks(resumed.logicalMessages)).toEqual([]);
    expect(resumed.tools.map(({ name }) => name)).not.toContain(
      "percentile_check",
    );
  });
});
