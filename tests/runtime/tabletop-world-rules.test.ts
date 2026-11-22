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
import {
  tabletopAuthoringRulesBlock,
  tabletopWorldRulesBlock,
} from "../../src/runtime/play/TabletopRules.ts";

const fiction: Gameplay = { mode: "interactive-fiction" };
const schemes: ResolutionScheme[] = ["d20", "d100", "bag"];
const rulesSource = "runtime:world-placeholder/gameplay";
const fallbackSource = "runtime:tabletop-continuation-fallback";

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

function fallbackBlocks(
  messages: { role: string; blocks: { source: string; markdown: string }[] }[],
) {
  return messages.flatMap(({ role, blocks }) =>
    blocks
      .filter(({ source }) => source === fallbackSource)
      .map((block) => ({ role, ...block })),
  );
}

function bindingWithTabletopEnabled(
  locale: AppLocale,
  enabled: boolean,
): PlayPresetBinding {
  const binding = builtinDefaultPlayPresetBinding(locale);
  binding.definition.playPrompts = binding.definition.playPrompts!.map(
    (entry) =>
      entry.kind === "builtin" && entry.builtin === "play.tabletop"
        ? { ...entry, enabled }
        : entry,
  );
  return binding;
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
          expect(fallbackBlocks(bootstrap.logicalMessages)).toEqual([]);
          const checkToolName = resolutionCheckToolForScheme(scheme);
          const tool = resolutionToolDefinition(
            checkToolName,
            locale,
          ).description;
          expect(blocks[0]!.markdown).toContain(checkToolName);
          expect(blocks[0]!.markdown).toContain("roll_dice");
          expect(blocks[0]!.markdown).toContain("calculate");
          expect(blocks[0]!.markdown).toContain(
            locale === "zh-CN" ? "绑定契约" : "Binding contract",
          );
          expect(blocks[0]!.markdown).toContain(
            locale === "zh-CN"
              ? "缺少判定依据时先读取相关角色或状态文档"
              : "read relevant character or state documents first when check inputs are missing",
          );
          // Play prompts refer to the attached tool definitions instead of
          // pasting the check tool's full description a second time.
          expect(blocks[0]!.markdown).not.toContain(tool);
          expect(
            bootstrap.tools.find(({ name }) => name === checkToolName)
              ?.description,
          ).toBe(tool);
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
    expect(fallbackBlocks(continued.logicalMessages)).toEqual([]);
  });

  test("a context frozen before tabletop existed gets the send's tools, no frozen rules block, and one runtime fallback", () => {
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
    // Rules are frozen material; tools follow the world on every send.
    expect(rulesBlocks(resumed.logicalMessages)).toEqual([]);
    expect(resumed.tools.map(({ name }) => name)).toContain("percentile_check");
    expect(fallbackBlocks(resumed.logicalMessages)).toHaveLength(1);
  });

  for (const locale of ["en", "zh-CN"] as const)
    for (const scheme of ["d100", "bag"] as const)
      for (const playTabletopEnabled of [true, false] as const) {
        test(`legacy continuation fallback stays active and idempotent across two turns (${locale}, ${scheme}, play.tabletop=${playTabletopEnabled}) (#246)`, () => {
          const compiler = new FileNativePromptCompiler({ locale });
          const binding = bindingWithTabletopEnabled(
            locale,
            playTabletopEnabled,
          );
          const frozenFiction = compiler.compilePlayCallChain(
            previewInputWithGameplay(fiction, { locale }),
            binding,
          ).bootstrap;

          const turn1 = compiler.compilePlayCallChain(
            {
              ...previewInputWithGameplay(
                { mode: "tabletop", scheme },
                { locale, playerInputPlacement: "append" },
              ),
              frozenWorldContext: frozenFiction,
            },
            binding,
          ).bootstrap;
          const turn2 = compiler.compilePlayCallChain(
            {
              ...previewInputWithGameplay(
                { mode: "tabletop", scheme },
                { locale, playerInputPlacement: "append" },
              ),
              frozenWorldContext: turn1,
            },
            binding,
          ).bootstrap;

          for (const resumed of [turn1, turn2]) {
            expect(rulesBlocks(resumed.logicalMessages)).toEqual([]);
            const fallbacks = fallbackBlocks(resumed.logicalMessages);
            expect(fallbacks).toHaveLength(1);
            expect(fallbacks[0]!.role).toBe("runtime_system");
            expect(fallbacks[0]!.markdown).toContain(
              locale === "zh-CN"
                ? "不得为同一行动重掷"
                : "never reroll the same action",
            );
            expect(fallbacks[0]!.markdown).toContain(
              locale === "zh-CN"
                ? "缺少判定依据时先读取相关角色或状态文档"
                : "read relevant character or state documents first when check inputs are missing",
            );
            if (scheme === "bag")
              expect(fallbacks[0]!.markdown).toContain(
                locale === "zh-CN"
                  ? "混乱袋必须读取"
                  : "A chaos bag defined in the world documents must be read",
              );
            const providerText = JSON.stringify(resumed.provider);
            const marker =
              locale === "zh-CN"
                ? "跑团续玩判定底线"
                : "Tabletop continuation binding rules";
            expect(providerText.split(marker)).toHaveLength(2);
          }
        });
      }

  test("legacy frozen context using legacy history tools without a check tool does not inject a tabletop fallback (#246)", () => {
    const compiler = new FileNativePromptCompiler({ locale: "en" });
    const binding = bindingWithTabletopEnabled("en", false);
    const frozenFiction = compiler.compilePlayCallChain(
      previewInputWithGameplay(fiction, { locale: "en" }),
      binding,
    ).bootstrap;
    const legacyToolUniverse = [
      {
        name: "context_list",
        description: "Legacy context list tool.",
        inputSchema: {
          type: "object",
          properties: { source: { enum: ["state", "history"] } },
          required: ["source"],
        },
      },
      ...frozenFiction.tools.filter(({ name }) => name !== "state_list"),
    ];
    const legacyFrozen = {
      ...frozenFiction,
      tools: legacyToolUniverse,
      toolUniverse: legacyToolUniverse,
    };

    const resumed = compiler.compilePlayCallChain(
      {
        ...previewInputWithGameplay(
          { mode: "tabletop", scheme: "d100" },
          { locale: "en", playerInputPlacement: "append" },
        ),
        frozenWorldContext: legacyFrozen,
      },
      binding,
    ).bootstrap;

    expect(resumed.tools.map(({ name }) => name)).not.toContain(
      "percentile_check",
    );
    expect(rulesBlocks(resumed.logicalMessages)).toEqual([]);
    expect(fallbackBlocks(resumed.logicalMessages)).toEqual([]);
  });

  test("authoring tabletop rules blocks retain full check tool descriptions because resolution tools are not attached (#246)", () => {
    for (const locale of ["en", "zh-CN"] as const)
      for (const scheme of schemes)
        for (const target of ["setting", "world-revision"] as const) {
          const block = tabletopAuthoringRulesBlock(
            { mode: "tabletop", scheme },
            target,
            locale,
          );
          const expectedRules = resolutionToolDefinition(
            resolutionCheckToolForScheme(scheme),
            locale,
          ).description;
          expect(block.markdown).toContain(expectedRules);
        }
  });
});

describe("the chaos-bag sentence belongs to the bag scheme only", () => {
  const bagSentence = {
    "zh-CN": "混乱袋必须读取",
    en: "A chaos bag defined in the world documents must be read",
  } as const;
  for (const locale of ["en", "zh-CN"] as const) {
    test(`bag rules state the bag contract (${locale})`, () => {
      const { markdown } = tabletopWorldRulesBlock(
        { mode: "tabletop", scheme: "bag" },
        locale,
      );
      expect(markdown).toContain(bagSentence[locale]);
    });
    for (const scheme of ["d20", "d100"] as const)
      test(`${scheme} rules never mention a bag (${locale})`, () => {
        const { markdown } = tabletopWorldRulesBlock(
          { mode: "tabletop", scheme },
          locale,
        );
        expect(markdown).not.toMatch(/bag|混乱袋|标记清单/iu);
        // The contract itself is still complete without the bag bullet.
        expect(markdown).toContain(
          locale === "zh-CN"
            ? "参数不合法属于工具错误"
            : "Invalid arguments are tool errors",
        );
      });
  }
});

describe("tabletop compiled builtin prompts are genre-neutral and scheme-agnostic (#245)", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    test(`d100 compiled builtin blocks and turnGuide avoid novel-only wording and difficulty parameter instructions (${locale})`, () => {
      const compiler = new FileNativePromptCompiler({ locale });
      const binding = builtinDefaultPlayPresetBinding(locale);
      const compiled = compiler.compilePlayCallChain(
        previewInputWithGameplay({ mode: "tabletop", scheme: "d100" }),
        binding,
      ).bootstrap;
      const builtinText = [
        ...compiled.logicalMessages
          .flatMap(({ blocks }) => blocks)
          .filter(({ source }) => source.startsWith("runtime:"))
          .map(({ markdown }) => markdown),
        compiled.turnGuide?.text ?? "",
      ].join("\n\n");
      expect(builtinText).not.toMatch(
        /互动式小说|小说正文|小说形式|interactive novel|novel's prose|prose of the novel|novel form/iu,
      );
      const percentile = compiled.tools.find(
        ({ name }) => name === "percentile_check",
      )!;
      expect(percentile.inputSchema).toMatchObject({
        required: ["goal", "target"],
      });
      const worldRules = rulesBlocks(compiled.logicalMessages)[0]!.markdown;
      expect(worldRules).not.toMatch(
        /先声明行动目标、所用数值与难度|declare the action's goal, the inputs and the difficulty/u,
      );
      const tabletopGuide = compiled.logicalMessages
        .flatMap(({ blocks }) => blocks)
        .find(
          ({ source }) => source === "runtime:ordered/play.tabletop",
        )?.markdown;
      expect(tabletopGuide).toBeDefined();
      expect(tabletopGuide).not.toMatch(
        /确定修正与难度|明确行动目标、属性修正和难度|declare the goal, modifiers and difficulty/u,
      );
    });
  }
});
