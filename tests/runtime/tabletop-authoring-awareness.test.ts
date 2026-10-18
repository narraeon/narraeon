import { describe, expect, test } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import {
  gameplayFile,
  gameplayPath,
  type Gameplay,
} from "../../src/protocol/gameplay.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { resolutionToolDefinition } from "../../src/runtime/play/TabletopResolution.ts";
import {
  FileNativePromptCompiler,
  type PromptCompilation,
  type PromptPreview,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  SettingAuthoringTransaction,
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { previewInputWithGameplay } from "../support/tabletopFixtures.ts";

const fiction: Gameplay = { mode: "interactive-fiction" };
const d20: Gameplay = { mode: "tabletop", scheme: "d20" };
const bag: Gameplay = { mode: "tabletop", scheme: "bag" };

function compileSetting(
  gameplay: Gameplay,
  locale: AppLocale,
): PromptCompilation {
  const input = previewInputWithGameplay(gameplay, { locale });
  return new FileNativePromptCompiler({ locale }).compileSettingImprovement({
    contentPackageTitle: "Authoring awareness",
    gameplay,
    runtimeContract: settingImprovementRuntimeContract(locale),
    authorPrompt: "author",
    playPreset: builtinDefaultPlayPresetBinding(locale),
    modelBinding: input.modelBinding,
    tools: settingImprovementToolDefinitions(locale),
  });
}

function compileRevision(
  gameplay: Gameplay,
  locale: AppLocale,
): PromptCompilation {
  const input = previewInputWithGameplay(gameplay, { locale });
  return new FileNativePromptCompiler({ locale }).compileWorldRevision({
    worldTitle: "Revision awareness",
    epoch: { id: "epoch-awareness", baseHead: "head-awareness" },
    gameplay,
    runtimeContract: settingImprovementRuntimeContract(locale),
    authorPrompt: "author",
    playPreset: builtinDefaultPlayPresetBinding(locale),
    modelBinding: input.modelBinding,
    tools: settingImprovementToolDefinitions(locale),
  });
}

/** The gameplay block carried inside the author.target message, if any. */
function gameplayTargetBlock(
  compilation: PromptCompilation,
): string | undefined {
  const target = compilation.logicalMessages.find(
    ({ promptId }) => promptId === "author.target",
  );
  return target?.blocks.find(({ source }) => source.endsWith("/gameplay"))
    ?.markdown;
}

describe("tabletop authoring target", () => {
  test("a tabletop package states its mode, scheme, rules and how the scheme may change", () => {
    const en = gameplayTargetBlock(compileSetting(d20, "en"))!;
    expect(en).toContain("Tabletop · d20");
    expect(en).toContain(
      resolutionToolDefinition("d20_check", "en").description,
    );
    expect(en).toContain("control/gameplay.json");
    expect(en).toContain("cannot become interactive fiction");
    expect(en).toContain("existing worlds never follow the source package");

    const zh = gameplayTargetBlock(compileSetting(bag, "zh-CN"))!;
    expect(zh).toContain("跑团 · 混乱袋");
    expect(zh).toContain(
      resolutionToolDefinition("bag_check", "zh-CN").description,
    );
    expect(zh).toContain("control/gameplay.json");
    expect(zh).toContain("不能改为互动式小说");
  });

  test("a tabletop world revision states its fixed scheme and that a revision cannot change it", () => {
    const en = gameplayTargetBlock(compileRevision(bag, "en"))!;
    expect(en).toContain("Tabletop · Chaos bag");
    expect(en).toContain(
      resolutionToolDefinition("bag_check", "en").description,
    );
    expect(en).toContain("cannot change control/gameplay.json");
    expect(en).not.toContain("may be changed");

    const zh = gameplayTargetBlock(compileRevision(d20, "zh-CN"))!;
    expect(zh).toContain("跑团 · d20");
    expect(zh).toContain("修订不能修改 control/gameplay.json");
  });

  test("fiction packages and revisions add no gameplay block to the target", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      expect(
        gameplayTargetBlock(compileSetting(fiction, locale)),
      ).toBeUndefined();
      expect(
        gameplayTargetBlock(compileRevision(fiction, locale)),
      ).toBeUndefined();
    }
  });
});

describe("setting_write_file receipts teach a new scheme's rules", () => {
  const preview = {
    compilation: { coverage: [], logicalMessages: [] },
    leakage: { status: "clean", checkedFields: [] },
  } as unknown as PromptPreview;

  for (const locale of ["en", "zh-CN"] as const)
    test(`a successful scheme change appends the rules (${locale})`, () => {
      const transaction = new SettingAuthoringTransaction({
        baseFiles: [
          ...minimalFileNativeContentScaffold(locale),
          gameplayFile({ mode: "tabletop", scheme: "d20" }),
        ],
        locale,
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
            contents: gameplayFile({ mode: "tabletop", scheme: "bag" })
              .contents,
          },
        },
      ]);
      expect(results[1]?.isError).toBe(false);
      expect(results[1]?.markdown).toContain(
        resolutionToolDefinition("bag_check", locale).description,
      );
      expect(results[1]?.markdown).not.toContain(
        resolutionToolDefinition("d20_check", locale).description,
      );
    });
});
