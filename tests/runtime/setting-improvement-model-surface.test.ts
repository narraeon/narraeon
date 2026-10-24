import { expect, test } from "vitest";

import {
  appLocales,
  type AppLocale,
} from "../../src/protocol/appPreferences.ts";
import { fictionGameplay, type Gameplay } from "../../src/protocol/gameplay.ts";
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

const tabletopGameplay: Gameplay = { mode: "tabletop", scheme: "d20" };

const gameplayModes: [string, Gameplay][] = [
  ["interactive-fiction", fictionGameplay],
  ["tabletop", tabletopGameplay],
];

/**
 * Pins the model-visible setting-improvement surface. Setting improvement must
 * keep these bytes exactly: the world-revision surface is rendered by the same
 * transaction, and any change here is a change the content-package author sees.
 */
function settingImprovementModelSurface() {
  return Object.fromEntries(
    appLocales.map((locale) => [
      locale,
      {
        gameplays: Object.fromEntries(
          gameplayModes.map(([label, gameplay]) => [
            label,
            {
              tools: settingImprovementToolDefinitions(locale, gameplay),
              contract: settingImprovementRuntimeContract(locale, gameplay),
            },
          ]),
        ),
        transcript: settingImprovementTranscript(locale),
      },
    ]),
  );
}

function settingImprovementTranscript(locale: AppLocale) {
  const transaction = new SettingAuthoringTransaction({
    baseFiles: minimalFileNativeContentScaffold(locale),
    locale,
    preview: () => preview,
  });
  const results = transaction.execute([
    { id: "list-root", name: "setting_list", arguments: {} },
    {
      id: "search-situation",
      name: "setting_search",
      arguments: { query: "situation" },
    },
    {
      id: "read-opening",
      name: "setting_read",
      arguments: { path: "opening.md" },
    },
    {
      id: "read-situation",
      name: "setting_read",
      arguments: { path: "world/current-situation.yaml" },
    },
    {
      id: "write-broken-yaml",
      name: "setting_write_file",
      arguments: {
        path: "world/current-situation.yaml",
        contents: "title: [unclosed\n",
      },
    },
    {
      id: "write-control-block",
      name: "setting_write_file",
      arguments: {
        path: "control/blocks/extra.md",
        contents: "# Extra\n\nKeep the table honest.\n",
      },
    },
    {
      id: "delete-current-situation",
      name: "setting_delete",
      arguments: { document: "world/current-situation.yaml" },
    },
    {
      id: "patch-missing-node",
      name: "setting_patch",
      arguments: {
        document: "world/current-situation.yaml",
        op: "replace",
        locator: ["missing"],
        value: "x",
      },
    },
    {
      id: "move-current-situation",
      name: "setting_move",
      arguments: {
        from: "world/current-situation.yaml",
        to: "world/moved.yaml",
      },
    },
  ]);
  return {
    results,
    review: transaction.review(),
    authorization: transaction.authorization("revision"),
    files: transaction.files().map(({ path }) => path),
  };
}

test("setting-improvement model-visible surface stays byte-identical", async () => {
  const surface = JSON.stringify(settingImprovementModelSurface(), null, 2);
  await expect(surface).toMatchFileSnapshot(
    "./snapshots/setting-improvement-model-surface.json",
  );
});

test("setting-improvement transcript is deterministic across runs", () => {
  expect(JSON.stringify(settingImprovementTranscript("en"))).toBe(
    JSON.stringify(settingImprovementTranscript("en")),
  );
});
