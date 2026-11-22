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
 * fiction world or package must stay byte-identical to the released main
 * branch.
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
  test("compiled fiction requests match the released base byte for byte", () => {
    expect(computeDigests()).toEqual(expectedDigests);
  });
});

const expectedDigests: Record<string, string> = {
  "bootstrap/en/legacy-v1/anthropic_messages/append":
    "473890af6872412bc3534400f4c3d5a646e7fa222926abf1fca2eb6f1cc2b660",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "33f93b115ec5a843786f08a5d368c7258209329f961c74fc24c11fc04aa7fd77",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "c29ebd210624e5cbbc5d508eaab9525ad8565d01c136f2c5f536ff9cc28d7191",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "9f5426d275a21a844238d42bb0099307c2521e445d65fe27b7197ec910b20eef",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "69e2f159215bb8ea001d5e45bb2f14e08cb10b68c24acc3eb628730345006902",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "fa958bf878b6606f959658838f3dcf19f7af60d31254af7a5ed14c7b1ee31448",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "473890af6872412bc3534400f4c3d5a646e7fa222926abf1fca2eb6f1cc2b660",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "33f93b115ec5a843786f08a5d368c7258209329f961c74fc24c11fc04aa7fd77",
  "bootstrap/en/ordered-default/chat_completions/append":
    "c29ebd210624e5cbbc5d508eaab9525ad8565d01c136f2c5f536ff9cc28d7191",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "9f5426d275a21a844238d42bb0099307c2521e445d65fe27b7197ec910b20eef",
  "bootstrap/en/ordered-default/openai_responses/append":
    "69e2f159215bb8ea001d5e45bb2f14e08cb10b68c24acc3eb628730345006902",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "fa958bf878b6606f959658838f3dcf19f7af60d31254af7a5ed14c7b1ee31448",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "d98429a906ca05962a125ba0a41e1c7790f2e86557ccfe1d0557978d64816a00",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "ed84e68d100b7435a3ff37cdcf65788299463db2605c790f635c6af2d1c22403",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "06aa30bc0f9352a1cdbd1bc4238c536f00eecdd42c5ac31c9caf908841a23a2b",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "5cb69c730585d3280840d9a410744b9dcead862890ca6c20192332d0d6dcdbc0",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "38e37a906c98bd089cdcd9727d6be00c330ac6a9202f598523b3d0295b037545",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "aa8ce4db12da574e5a3488f58df0c8d44735dbfe7093de07391025effb17941c",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "d98429a906ca05962a125ba0a41e1c7790f2e86557ccfe1d0557978d64816a00",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ed84e68d100b7435a3ff37cdcf65788299463db2605c790f635c6af2d1c22403",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "06aa30bc0f9352a1cdbd1bc4238c536f00eecdd42c5ac31c9caf908841a23a2b",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "5cb69c730585d3280840d9a410744b9dcead862890ca6c20192332d0d6dcdbc0",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "38e37a906c98bd089cdcd9727d6be00c330ac6a9202f598523b3d0295b037545",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "aa8ce4db12da574e5a3488f58df0c8d44735dbfe7093de07391025effb17941c",
  "chain/en/legacy-v1/anthropic_messages/append":
    "53aa579804f59d560e39d3ce5f2013c58248036d06e85432e2295ea96c9090ce",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "2122c7d419abea6103888e04f4a15ed1fdd393309c7a45ae1d698f5e9d634dce",
  "chain/en/legacy-v1/chat_completions/append":
    "815392b411f2b566f63fdcd506f714cd804cd21efe74d4a5138217551236d322",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "48b7c440dce29d4834fea1f9a6df446db0a637579c3a63885ae130a1a4dab2e8",
  "chain/en/legacy-v1/openai_responses/append":
    "1603a3c891d1382c5dfa3a18f2732e9812963b582a00c92790984942df447c88",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "4c7b365f4f41141a90ff416cd4ffeba7b42c9b00fc3bf2d7b7ada36b9572b361",
  "chain/en/ordered-default/anthropic_messages/append":
    "04b854e38fc474d139c88b2f21679835da4d5f09ccdc3f3523d94a07da769ed0",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "00bca549fa227fb8ca0a5f5c415dd4c36122d81388be54585ec675f3ac6f7bd1",
  "chain/en/ordered-default/chat_completions/append":
    "afa8dab675f2d73c9e83d5fd15611dede04f5532adf2edf245ab61bd3f162a6f",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "46f500423cafb4f63c24d8880798d93824de3103ed09838c7ab43d00c32b8422",
  "chain/en/ordered-default/openai_responses/append":
    "e564f6baa334b2a4237a3700888c2a09484b6884a7d97fa067bc54c3e9359145",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "bcd143094b14908ac9856c28dfd1ea1d98100f63747eded152fe37a162327b09",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "e99d2ef35a36d10bf14c0764d543ba1c870864f27fb98ed3b8750c15bb900f34",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "53c0b26207181e9edef3307562b4a770cda2e5ebbaa2198086edbc1e1f5df3b0",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "6e7b05562a229103edff4b29f043139c628af57545cd72c39e1520fc275707cf",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "033bdc676820387511e6081e7eeaac8a1d0a6620885150646749314a35548341",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "2835b8896dca78055c4891c330c3e74569a744b66821deaee928223b2b51ddc9",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "6ceb58d07420e8a237193b6d792cbe0a58dffc301d4580344d25655a14a164b4",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "eb4e68f927a3c1d42ab4d06b131c7eac77007616f618d5961fdf385ce00936f0",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ac2d59c0603c678b217e825dec67d530f166b940289c5920b6e8004836a09d77",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "1aceec451642917c6a60febcc6284e7beafe641272923f88e6886bb9f87dc28e",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "2259de883a2204ab66b52aa247c34c4bee794401ff2fb515e038bf9486ed7689",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "c05f3a0135d93450c24163eb94d1d36138a990416cc7efddab271033c69eb944",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "9d2dfefabe7eedd23506aaa20928657f8e39341bfb3d38ca0cdb949b07610106",
  "preview/en/legacy-v1/anthropic_messages/append":
    "64893254876a41d73a31b777217f1376ef88039fa784bf7537b21e54bc33b592",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "90ccdb62de23490909bd3a2eacef65047813e63526afe7b521b446cd5a427a14",
  "preview/en/legacy-v1/chat_completions/append":
    "dcebcfba32bb32ff23e5baca579a5c2f2fa356c3bf878065b34b28df1da3264c",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "41e30fb4700b084a992ae990e5c53c3359df64f5bf8e32d1fe4a299aa6e2598d",
  "preview/en/legacy-v1/openai_responses/append":
    "fd944b60a27f59a61236c4347f9cd740bfe5a303f5ac748c53628b1baf6e7a73",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "4ae6bd8982e5e0370f6131e98b26c7da2bfced078ecf76dd9b957ec622018e59",
  "preview/en/ordered-default/anthropic_messages/append":
    "61700bd8c8a46277bea7ff20ad6c122d7d77293f38ea4edd5dc313bb4fec5800",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "01ae53b4044ed67c6e7bf0c20bb60e7c2208a6aeef8e28528396b8657a5be8d7",
  "preview/en/ordered-default/chat_completions/append":
    "0a403b99e52dcff869c69b48b5559b961a306203b9b0ae25f0c3b1240b2f85be",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "86eb069c5e9129a07a3139b0c3269ae947351618654d2a58f3758f57f67c125d",
  "preview/en/ordered-default/openai_responses/append":
    "ebe2365224499defda3a78a880f07ffe90f1c56b3096458295d0cae616cdc405",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "ae1a6557989a36a0e64e0a822c933a67ccaf1ed37608a5e90f2fcc1863afbe89",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "e83c3c5d6157f436dc0b64145f968872033846a7d0d554edaf0bab6f1ac0a794",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "d287997eb46e5cd59f2ba3565175ed69ab80613007f224bb0f0841c5f47d517e",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "1a6617be959e22ba39b9e070cd502cd18b9e315bbe06280d26297337d634d2eb",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "f3e71ae5cd26e31bb860327ed216259ef9c91ccf821ad3b424b0349bfeb0eea4",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "e405b70802318b1df5127291e44fc671ac1477f4d6dbb95245ebd105b02baf05",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "6ac532e28ef0a74bb15831a8a6c4a69ec4e7bb6ab2700baa94d8b26ab7597b1e",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "40b8f37db75f2f72be1659d4461df03a3d517f105a22dba0b0420208a10b8fb5",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "372b9389caa47d9a7a4ea4f3f1f396e26cdf66963ae2c0e72629b4e0141d7566",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "52a9fa43f126ad301c4a211fe1d44755cd92e4b08762ab43d3dabec6dd7fdd9a",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "11f60778d44f3dcd3e4c99a251c0e95b0f583c81f6d7af94e03ee0247ca09a7d",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "2965d825644ab6f84bf652bbf78a984926422d4cdfd76e88cb0a7b9bb76959c6",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "e5a55720508355f8d9d01b46001a720ce88f7cae7955730983a7696a4f51a6e1",
  "revision/en":
    "210062d7f27f32cd66bc449c2ac34432f8e1268bd49b723fc2474a468708175b",
  "revision/zh-CN":
    "f0175d427a23f2a02d16783a73c8fef987369250ada1154a344aa17456df0349",
  "setting/en":
    "084835b327e5228a11cd77a0d17361924c416ee46fee9f3cf114b0ae8ac9c939",
  "setting/zh-CN":
    "c9717e4594108c8e2062276872026a1d082ba6fe7deafe2bbac904e739620707",
};
