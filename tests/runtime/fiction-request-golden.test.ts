import { createHash } from "node:crypto";

import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { describe, expect, test } from "vitest";

import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  defaultPlayPresetFilesForLocale,
  legacyDefaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { settingImprovementToolDefinitions } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

/**
 * Fiction requests are the compatibility contract for tabletop work: every
 * compiled logical message, tool, provider payload and cache identity of a
 * fiction world or package is checked against the last intentional prompt
 * change.
 *
 * Provenance: the digests below were regenerated after main 83b6139, when the
 * four composite author blocks were split into single-rule blocks with
 * exclusive choice groups, the history tools lost their inline usage guidance,
 * the world_checkpoint description was shortened, and the per-send turn guide
 * joined the ordered bootstrap. All 76 digests moved: the tool descriptions
 * reach every request, including the 24 preset-free bootstraps.
 * Later, the turn-guide header and the author-side turn-guide block were
 * reworded to name only the suffix's sources (preset, world, player's request
 * for this turn); the digests that carry them moved again and were regenerated.
 * Later, the world_patch descriptions and prompt sentences were rewritten for
 * upsert and per-edit settlement (#113); the digests that carry them moved
 * again and were regenerated.
 * Later, the world-revision summary in ordered-author-prompts named the
 * read-only history tools (#118); only the two revision digests moved and were
 * regenerated. Fiction and preview digests are unchanged.
 * The shared main/follow-up tool universe and phase instructions (#152)
 * changed chain and preview digests; frozen requests remain unchanged.
 * Gameplay wording (control/gameplay.json mentions, bag guidance) reaches the
 * model only for tabletop worlds and packages.
 * Later, the world-revision author summary (#116) states that existing state
 * documents may be deleted or moved under the reference-blocker rule; only the
 * two revision digests moved and were regenerated.
 * Later, the directory list tools (state_list, setting_list, world_revision_list)
 * dropped limit/cursor and return the whole directory (#120); the state_list
 * tool description moved in every request, so all 76 digests were regenerated.
 * Later, receipt boilerplate was trimmed (#124): history_list and history_search
 * receipts, the history_list description, and the setting_patch rejection moved
 * the digests that carry them; the regenerated values are the current ones.
 * Later, checkpoint policy and ending blocks distinguish completed events from
 * key responses still pending, and mechanics explain recent-history fallback
 * (#128). The 52 chain/preview/authoring digests changed; the 24 preset-free
 * bootstrap digests remain unchanged. These are new compiles, not frozen retries.
 * First-play opening guidance (#156) changes chain and preview digests;
 * already frozen requests are not recompiled.
 * Continued-tool settlement guidance (#157) changes new chain and preview digests.
 * Current-focus, option and authoring guidance (#158) changes the 52 current
 * chain/preview/authoring digests; all 24 preset-free bootstraps remain unchanged.
 * Player-visible character knowledge guidance (#159) changes the 24 current
 * ordered chain/preview and four authoring digests; legacy v1 and preset-free
 * bootstrap digests stay unchanged.
 * Explicit current-player boundaries and shortened turn-guide headers (#179)
 * change fresh chain/preview and authoring digests; preset-free bootstrap input
 * also receives the boundary. Frozen requests are not recompiled.
 * Responses source-aware turn guides (#198) change the ordered append preview
 * in both locales. The remaining 74 compilation digests stay unchanged.
 * Ordered authoring adds control-file and Unicode guidance and shares the
 * play turn-guide reference with world revision (#233). Only new authoring
 * compiles change.
 * Batch 1 prompt cleanup (#245) aligns English turn guides, makes built-in
 * default prose/output wording genre-neutral, deduplicates consecutive
 * same-role provider headings and the redundant setting current-tree boundary,
 * trims play.mechanics settlement overlap, and cleans up option-group /
 * ownership / save-timing wording. The 52 chain/preview/authoring digests
 * moved; all 24 preset-free bootstrap digests remain unchanged.
 * Batch 2B mechanics, history-use-guidance, and base tool description cleanup
 * (#247) trims play.mechanics overlap with world_patch/world_retire, structures
 * history-use-guidance, and shortens base tool descriptions while preserving
 * world-revision shared history_* guardrails. The 72 play bootstrap/chain/preview
 * digests moved; the four authoring digests (setting/*, revision/*) remain unchanged.
 * Batch 3A authoring play-reference summarization (#248) renders enabled built-in
 * play blocks inside author.play-reference as concise boundary summaries while
 * keeping user/cloned blocks and active turn guides verbatim. Only the four
 * authoring digests (setting/*, revision/*) moved; all 72 play digests remain unchanged.
 * Batch 3B core play policy refinement (#249) tightens six default play policy
 * blocks (ownership, save-timing, facts, prose, checkpoint-policy, output) while
 * leaving default turn guides and authorSummary untouched. Only the 48 chain/*
 * and preview/* digests moved; all 24 preset-free bootstrap/* digests and all 4
 * ordered authoring digests (setting/*, revision/*) remain unchanged.
 * #243 names the orchestration in fresh Runtime and authoring instructions.
 * Only the 24 bootstrap and four authoring digests moved.
 * #269 adds localized play tool field descriptions and shortens their top-level
 * descriptions. The 72 bootstrap, chain and preview digests moved.
 * Saved historical requests and user-authored copies retain their original text.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingFrom(
  files: Record<string, string>,
  id: string,
): PlayPresetBinding {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id,
    name: id,
    revision: "rev-golden",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

const presets: [string, (locale: AppLocale) => Record<string, string>][] = [
  ["ordered-default", (locale) => defaultPlayPresetFilesForLocale(locale)],
  ["legacy-v1", (locale) => legacyDefaultPlayPresetFilesForLocale(locale)],
];

const providers = [
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const;

const locales: AppLocale[] = ["en", "zh-CN"];

function computeDigests(): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const locale of locales) {
    const compiler = new FileNativePromptCompiler({ locale });
    for (const [presetName, filesFor] of presets) {
      const binding = bindingFrom(filesFor(locale), presetName);
      for (const provider of providers)
        for (const placement of ["bootstrap", "append"] as const) {
          const input = createMinimalFileNativePreviewInput({
            provider,
            modelId: "golden-model",
            contextWindowTokens: 200_000,
            maxOutputTokens: 4096,
            playerInput: "我推开石门。",
            playerInputPlacement: placement,
            locale,
          });
          const key = `${locale}/${presetName}/${provider}/${placement}`;
          const preview = compiler.preview(input, binding);
          digests[`preview/${key}`] = digest({
            compilation: preview.compilation,
            initialAppend: preview.initialAppend,
            playPreset: preview.playPreset
              ? {
                  bootstrap: preview.playPreset.bootstrap,
                  toolUniverse: preview.playPreset.toolUniverse,
                  toolStrategy: preview.playPreset.toolStrategy,
                  followups: preview.playPreset.followups,
                  cache: preview.playPreset.cache,
                }
              : null,
          });
          const chain = compiler.compilePlayCallChain(input, binding);
          digests[`chain/${key}`] = digest({
            bootstrap: chain.bootstrap,
            toolUniverse: chain.toolUniverse,
            toolStrategy: chain.toolStrategy,
            followups: chain.followups,
          });
          digests[`bootstrap/${key}`] = digest(
            compiler.compileBootstrap(input),
          );
        }
    }
    const binding = bindingFrom(
      defaultPlayPresetFilesForLocale(locale),
      "ordered",
    );
    const modelBinding = createMinimalFileNativePreviewInput({
      provider: "anthropic_messages",
      modelId: "golden-model",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      playerInput: "",
      playerInputPlacement: "bootstrap",
      locale,
    }).modelBinding;
    digests[`setting/${locale}`] = digest(
      compiler.compileSettingImprovement({
        gameplay: { mode: "interactive-fiction" },
        contentPackageTitle: "Golden package",
        playPreset: binding,
        modelBinding,
        tools: settingImprovementToolDefinitions(locale, fictionGameplay),
      }),
    );
    digests[`revision/${locale}`] = digest(
      compiler.compileWorldRevision({
        gameplay: { mode: "interactive-fiction" },
        worldTitle: "Golden world",
        epoch: { id: "epoch-golden", baseHead: "head-golden" },
        playPreset: binding,
        modelBinding,
        tools: settingImprovementToolDefinitions(locale, fictionGameplay),
      }),
    );
  }
  return digests;
}

describe("fiction request compatibility", () => {
  test("compiled fiction requests match the current prompt contract byte for byte", () => {
    expect(computeDigests()).toEqual(expectedDigests);
  });
});

test.each([
  ["en", "The current orchestration declares narrative rules"],
  ["zh-CN", "当前编排方案声明叙事规则"],
] as const)(
  "fresh Runtime authority text names the orchestration in %s",
  (locale, line) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const bootstrap = compiler.compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "preview",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
        playerInput: "Preview",
        playerInputPlacement: "bootstrap",
        locale,
      }),
    );
    expect(
      bootstrap.logicalMessages.find(({ role }) => role === "runtime_system")
        ?.markdown,
    ).toContain(line);
  },
);

const expectedDigests: Record<string, string> = {
  "bootstrap/en/legacy-v1/anthropic_messages/append":
    "44b32adb00480224f319dd4415acf21c954be43bd0ba0baca5d934fc76a028de",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "4a07fd0ddff3d7e6f2fca4bf25259ed86c4604d120f7362d27f1b7b48ac098bf",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "94e63e1aa8b2e5441bd113f4b699890da85c5bbaeac4b0e1d3616058afc00b76",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "263c2dc665602a64b5d9e7815e8d48038672072c699ba04e8c8d769e3f8da7d1",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "1d5e2292661951cf0fa909a5e0b9414dfc309bac849413da33656a86b9ac1569",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "a2ad4776599dcb1849977e251fedd91e0969db718e0eeba90f4a47b3e75c0292",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "44b32adb00480224f319dd4415acf21c954be43bd0ba0baca5d934fc76a028de",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "4a07fd0ddff3d7e6f2fca4bf25259ed86c4604d120f7362d27f1b7b48ac098bf",
  "bootstrap/en/ordered-default/chat_completions/append":
    "94e63e1aa8b2e5441bd113f4b699890da85c5bbaeac4b0e1d3616058afc00b76",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "263c2dc665602a64b5d9e7815e8d48038672072c699ba04e8c8d769e3f8da7d1",
  "bootstrap/en/ordered-default/openai_responses/append":
    "1d5e2292661951cf0fa909a5e0b9414dfc309bac849413da33656a86b9ac1569",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "a2ad4776599dcb1849977e251fedd91e0969db718e0eeba90f4a47b3e75c0292",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "0948e5539ea1619a70202a2972a17fee3ec9f7d7cc9c02b82afdf0df6f94307a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "cbca1c456875e2b3a27020479008a46978884dbca6521a34468cdfcc196d288c",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "a32c9d1bb07d1dcafaa4a742264c5132a936c9987e9add2ecc4a37ce176e62a6",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "448f73d4e1aad3ad7c592bff148bd5e057eca842b45fce2774e5216b27df4606",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "846fcce659515fa538b67dcdd98b9bfbf9a22dcb2214cbdf2c3b16d38c838eda",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "9c7190455c5b09e7f33c1e068c0da0a1dcbf06b6083a9c45a37b6e0e25430d33",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "0948e5539ea1619a70202a2972a17fee3ec9f7d7cc9c02b82afdf0df6f94307a",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "cbca1c456875e2b3a27020479008a46978884dbca6521a34468cdfcc196d288c",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "a32c9d1bb07d1dcafaa4a742264c5132a936c9987e9add2ecc4a37ce176e62a6",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "448f73d4e1aad3ad7c592bff148bd5e057eca842b45fce2774e5216b27df4606",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "846fcce659515fa538b67dcdd98b9bfbf9a22dcb2214cbdf2c3b16d38c838eda",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "9c7190455c5b09e7f33c1e068c0da0a1dcbf06b6083a9c45a37b6e0e25430d33",
  "chain/en/legacy-v1/anthropic_messages/append":
    "847f05c23806b1357acbb84f6efeb58dfdd4723dcd955c89ed5fd8df6194b3e1",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "bbc8b89cd0de18393f0defcfbc11865ec8ed8d55b1c5b1c0d67b219bc5bb4ed5",
  "chain/en/legacy-v1/chat_completions/append":
    "b5e5f42ffeaa963154afddadfb65af357b1b19ec93804266280d3609131781e3",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "1998330af85eb2e5a5b973206e9cbff1e6450d47976676b2cdcc5a2fc49a6179",
  "chain/en/legacy-v1/openai_responses/append":
    "9efdf28179ebe3a0201c5da3ba3c2a99b1b0ede744403fa4bd65fd4a90bd0bb0",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "b45d0bb038f5d0289a59250cca06fb897994c1258603542a8956de25e4d62b49",
  "chain/en/ordered-default/anthropic_messages/append":
    "b68cf055a2736f83b1f3e8322d69b5f56c7e44e067eea3a319c06d2579170aaa",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "8e0d51bf9b3b3a1f9e14a2015cec407edba4b65261b9842ca7dd7c73c6ac3877",
  "chain/en/ordered-default/chat_completions/append":
    "64234a964d5308f578fcb6a141a2acc2a70a2830008aa4a92bee6e43f7b528f3",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "26034283ca37791dd20648ff6a9895ca8bddbe2f278d57be2e99768d229f6578",
  "chain/en/ordered-default/openai_responses/append":
    "1e1097dda6853b0bb862ce615a30d109b6467978c16ed3fe0cea2ce4361b5440",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "c2dee3bb9f7754a30ca764844e53ff4833953acf5f45cd1fe04cec97fc660a6a",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "c5e3eed0538f301611942c47101277be70c32f754dfe6ca8534ff50c075f580b",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "2a2e5ac04323b70f41a4edaf64746d1511ed9d291e0743e31661d52d72eba96f",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "b8746ec9299428823e9638e8c4c64ca8a060961136f8ff4930aff212c983b7ab",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "fb30d1822daf9a0feb92db6277f5ec9ae796f6f93c03704df0d04618b1aaa692",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "10b787861b1d8e9079f2425b5dcc33898b8e53621988471426ad39e000883f32",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "4f4a94ef94965580fc5fc593d72350dfa8c000f276b67f5175da6267197f46cc",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "770022dc4230cd0d84c0a28cc7b44926e9373f4bdf523bbca4310752bcdcb69c",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "2dd5c09c0c15d1ad3061e1c48e077c0527fe8a2901c01b0289c3e71ce832731e",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "30d8f467415abaeb6f7df4543da6320b6c63d2f5b4d08ad4b506b53770d841cd",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "cd771d5b7f139470573e219e8a17cbf18bc1138558b29bfe17bfd48b549a525e",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "ae4cd3588b8bd7cbf276e8172bdb646f8a5ae1a98319f57714f1fb29c1a27668",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "23fbb554fb41e7164827bcaf9f083d33b85a1b6f811fd06302acc2e5f28fa33a",
  "preview/en/legacy-v1/anthropic_messages/append":
    "6bfe218f54c7e6bac166844f33f836e972e93ff08027b76a240e3a8ec4446ee2",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "5c93172460a5b169faab900ef02740489f13a4195bf96e16a672a694880589b4",
  "preview/en/legacy-v1/chat_completions/append":
    "6538f15b3a55a8b329cdc135c058f145322938fb3dddd6bf5042e64749b4400d",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "98eced72367569aab0a294dab3c1c8971171ab533049d3288cf21b900703ad6d",
  "preview/en/legacy-v1/openai_responses/append":
    "2e7e77d0ce09a1d9a8439e8474e22df43729111818877a63614b58c75231ccfa",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "9a61779b3637b7a5c83c2542cb66de1807d66164edda082c9303c21175b2a245",
  "preview/en/ordered-default/anthropic_messages/append":
    "a3b308caa561f77d4420f88891046891e8e7216f11d181ac8bb3da424df5f896",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "efe82ab648e3514f3e5fc4eaca01942b09faa884b7b7f714a1ae57b8f3725aa5",
  "preview/en/ordered-default/chat_completions/append":
    "4353164df76a65ba9514621b0af13b9fb1154fb4eee92333bb4a364c4d3fb45f",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "5173f2bb180b496ebe4d395e71c8734c70c282fbc58fdcce1f2650b9944cf201",
  "preview/en/ordered-default/openai_responses/append":
    "4db9a177cd22735d8cbe9f7828f78d47dcbf5a32cc91fcadec75a4acb68763ec",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "0cbc7b5b2225b21938362140ad7929eb7d8b8881188a46b19e882f3dc4f7e1f4",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "6607a48887fa8606cc3b0c311554a423aa9dff7fa6a35b9a527a54ba0d19a622",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "012272312fc41cdff73a9b80fe2dfc7cc77b141fe81616c177b655976ff307ac",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "1d15679c3411243f57abfaec8f8ffa86fb6c7239ab0f88e4c65178f89072ba30",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "384aba6859d8987b625806e8f0344c2395984bc89adc894a3780c4a58495619c",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "8b04a952d3442f1f3d9ed32d286f80eacd9cd0be09216dfbc4b88ba625f1e5e6",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "7e80d3bea3cca87019b9c8933bda65b2e4b0e354bb6336cbaf627fc6d4b0d888",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "5e73667c6e57bd547e3e4a6501c59c65c9736bc69565a1843c0d11bde6bfb443",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "446e2ecb64c253111a7d598a1a2123df3c4ff4b1171640872a1f8a0545898791",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "ce8e866865e11746585db9f1af54d6c2b6e0abff55dd366b744391bb905f138d",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "3822eb5eae0cf5313193fd99886edecfb322a05caa42e011b99a27c1167bc444",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "52868fb62d9dbb27e812eb4b1dd5c1542908901ba99237af7ec3956bd1f16354",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "c93cc9458ca31083761fc6670c210d4d7526f0f277b246ea793437dc4ad559db",
  "revision/en":
    "5c92d09c0a2c6b1fa8e6c9594059182f9aedcb622e076c80246f51229fdd2523",
  "revision/zh-CN":
    "28580e248083568936132bbe8735112897a81f8d7ff50b9f33e1ac0dfbef8e88",
  "setting/en":
    "5f5f3a1dde418d6ea699dcbb1dec3be692dfc62bab7113d6b4161d8e0af471b1",
  "setting/zh-CN":
    "b911113a229b4f3c2db39b56f08cd5ee2e00c950785aaefee61217a584c81a25",
};
