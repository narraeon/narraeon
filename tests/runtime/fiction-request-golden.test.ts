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
 * #270 localizes Runtime role headings for new ordered Chinese requests.
 * Only the 12 ordered chain/preview and two authoring digests for zh-CN moved.
 * #265 adopts the bilingual candidate play blocks and history-use guidance.
 * All 72 fresh bootstrap, chain and preview digests moved. The four authoring
 * digests stayed the same.
 * #287 updates the bilingual built-in authoring guidance. Only the four
 * authoring digests moved.
 * #289 moves repeated play rules into tool definitions. All 72 fresh play
 * digests moved, while the four authoring digests stayed the same.
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
    "3d50b77174c6af8b052252a37893d01d891ab17298aa2661697136a56b033cc7",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "0a21aaa79f00bc2706977faae858a8254688bba432f837428cdb91839bd3e73c",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "0b6e73e2071480465a9278faaf40d5a959e535826425895575ffc00b93be7fe4",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "cf313a99702aa20e4b30907fd820438943e55b5c3dbe3d74245e7a38bc5589bc",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "deb439a18e1415739a3fcbcb30810291adaa5b49bc0d3f5ec0a03b8b6dcf8edd",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "5187d5bc4c069bb7ab9f31b4839355d6f8fca794b4f5c60e0aa1c90f28d96824",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "3d50b77174c6af8b052252a37893d01d891ab17298aa2661697136a56b033cc7",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "0a21aaa79f00bc2706977faae858a8254688bba432f837428cdb91839bd3e73c",
  "bootstrap/en/ordered-default/chat_completions/append":
    "0b6e73e2071480465a9278faaf40d5a959e535826425895575ffc00b93be7fe4",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "cf313a99702aa20e4b30907fd820438943e55b5c3dbe3d74245e7a38bc5589bc",
  "bootstrap/en/ordered-default/openai_responses/append":
    "deb439a18e1415739a3fcbcb30810291adaa5b49bc0d3f5ec0a03b8b6dcf8edd",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "5187d5bc4c069bb7ab9f31b4839355d6f8fca794b4f5c60e0aa1c90f28d96824",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "7a6bf8b1db195f64d0ae0c18470a8b81c683df7f66353abf800da6ada213fa6e",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "83e5dd82cbd56720f3dc67fa91ca0d1fcec784e22d3b643953bb5b3c16c35261",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "c5b56ef199edaa2fda28ca64435589e58d190e10e13f9d937443e389e295f004",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "72680b72d2b6f3fdced86b4fb575412dcac297011a07d46d0165d04bff57bc52",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "73066016f0bf8e0600bf871475daddbab3beb18902574fdd08ea400633a265ee",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "6c11185fbadf490ee69f3cbe06153fb81a3f05215bdccfd4e4b1ed5bc5bbe37c",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "7a6bf8b1db195f64d0ae0c18470a8b81c683df7f66353abf800da6ada213fa6e",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "83e5dd82cbd56720f3dc67fa91ca0d1fcec784e22d3b643953bb5b3c16c35261",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "c5b56ef199edaa2fda28ca64435589e58d190e10e13f9d937443e389e295f004",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "72680b72d2b6f3fdced86b4fb575412dcac297011a07d46d0165d04bff57bc52",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "73066016f0bf8e0600bf871475daddbab3beb18902574fdd08ea400633a265ee",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "6c11185fbadf490ee69f3cbe06153fb81a3f05215bdccfd4e4b1ed5bc5bbe37c",
  "chain/en/legacy-v1/anthropic_messages/append":
    "d423320df4909c5d7b1bea641e4450836cb3682197160aa663fa43827c8a8847",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "cb1d56f3eee0813f9d560cd2cbf7c7dc6b6c8f302827f542f35fecb1608f2b61",
  "chain/en/legacy-v1/chat_completions/append":
    "b8085d71829650bff0db776b90493597da5ad2a7711ae171132e50d5650d0358",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "53bae197c681ebb136096039637bd466ea70c2204d53aac0ad5a7be6fdfbfebc",
  "chain/en/legacy-v1/openai_responses/append":
    "9dd3b728373e9369fb55fe2783b322718ef2308131a95c10fe4cd932e1f01d41",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "ad4762d0988aa7dfba43f8da3b6df796163ad591831fb9591297014119173aea",
  "chain/en/ordered-default/anthropic_messages/append":
    "3163bdfb841edbbf555ede7cbda90495b3b073618c47ae657c00b1f29dd3d89e",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "864c49c4204ef1c4a6e4095cfdf4691096f7170710e672ca9022ed476b6c2c7b",
  "chain/en/ordered-default/chat_completions/append":
    "a16f5c67d7b35f39f6fa2db3929792956da8204cf9f84f07aef6c786f9e7ee4e",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "b88ad2396b710584dd87a807317de89ae17abb12801ca37fea51b5ce35a228cd",
  "chain/en/ordered-default/openai_responses/append":
    "f260c8eac303d1eb1cff148bcddfcd1d3d349440f952ffa4fbde0d0fa9eaee1d",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "ffb6f0c5844aa562638f981e8b0f5cc4d556bc1069fca9f433bd3fbe784d6422",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "49eead4063352ae59ceeda4acdb09d73cbcdccf30e020dec9f45588e810c56c5",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "8804cea03607f0e40e57ce0ad6ed832e882db95959ccdf6ea1577a6dafcc1317",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "c14ef1cc25452c2854a52a0362818f2b254140943831484f7f4a995a216c7147",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "96a22109f837e11ee3957c7974be4db87e69e827db4c933288b2802e057e6815",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "9302d808de0698df009c993fcfa19e91041673c62330fa6afd1e8dae7a98cd60",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "836955915e26e85f73a8d885a730f0329823b58ada490280fa44e76dc3ac88c4",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "682d39809f6c527daea63a32860b2524291cc851985d94ab1d8c6366f67f10ad",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "34c7d418e42b891741ae21b31c118276b66ee90b02eb976cffbf89e0f6d2a9d5",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "af5286589e26f3aa7f6810e67d98ab223e4dec5998d5c6580e47b2e328525228",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "79f8675108e416404f80001d9031e910f34d73127d09cc3c44a4c4359320ce6c",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "a9e8f0e4611f59a56d51e38627b988915002ba38a7c0e1af3181595fd028ed3e",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "1da53c950c590ff031e42543fa58e5b0fcc5c03b0aa1f63ec24499b95200c6ed",
  "preview/en/legacy-v1/anthropic_messages/append":
    "054c0ad327f0c41a3fa3d85ecd9e3ec42545bd3a1aa5d99f1d2e85d353790309",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "5843f22feb3d6f1323d6e96e767f862734089fa8b3b971e2b02b9849b8988a09",
  "preview/en/legacy-v1/chat_completions/append":
    "1259e1230c81907622822fd0cf8a648cc7ad64c9080f1e3a8e54343cc5314671",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "e4137149366a44f22dfdd7e930ec50542810199560ca4cf8fe897a5ac1d33f4b",
  "preview/en/legacy-v1/openai_responses/append":
    "0a3267b3b73d3e4269213d167545b7d8e41a23e9b4fa22fe29d1d81997841566",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "13f8f10c92b54a1efe8cf418a499afc0cf27da4dda06d86d23e2846113fc405e",
  "preview/en/ordered-default/anthropic_messages/append":
    "61929853035a00e2a5ae6b283ad3e72154e43da515550e0e0fe90632af385409",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "8a85461d3c270a412a99aa333e27ebd64e30c985690703cf6313b65d0cf93264",
  "preview/en/ordered-default/chat_completions/append":
    "881fe61103ba16499bd8a4a941376710ebc42ce683eff02ffeb5cf9f3bde3845",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "f214f2f27aa9f924341bf342f7ddd8e65f1d2622c3af3147352ef0ee4fc649df",
  "preview/en/ordered-default/openai_responses/append":
    "4a2f42c167540d66a6324a0128463218bf4aa439ceb748f7775314015bec6e64",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "cac606dbf310eb881a7113ab4dff4fb62b8b408ddf95a47bfdc02ed74194338c",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "090a18222e5c511a89ca3a575402fb534900f871614caef8d5d432f28d089222",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "54001b03b9b85d9f42a54079c1edb878f45fbafce238b4729b37173ff24a694b",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "ccbdf1f0232529a95ee6cf121f3f058da8d19ef2119863dbdcfcc9c6b4b148b7",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "709aa2dbc028e334eab2d00b84c22e3acc66a346ebe12244fb01d279a9643f36",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "79e1b66ffd6762c9aa3da7602d9bee38533b8e6ad1f8f5b49ddeaebddbf64d28",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "9d2726f071ce353339e57a952921b63715ac5e5fad8aedc1a8329330baa63cf2",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "17ff4d29fc03872d5c5d58065bd85eefb3e68677bb1f87fb46d88cecc4f4cecc",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "290d138dd977d16f333ab5d16541381d9fb3fc38471ac098982a89c8d1fa9cdf",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "c38728b5e183e41a705194b59cd58d82a382a94aa61f994a85b0310a7ebb3f5c",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "ba6e9a2f0ef955422aa2d2889fb7610f3644ebc77b4f046527875d649ae29d1c",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "8d64163647500074ba0decea050bb6d2cd97627a3d4c1aad0ed36ecb3ab8fa75",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "c39a6a86fabd42d6020f8f51ea56948d5e7c7a712f92c23ba4d48b0533b40048",
  "revision/en":
    "026ddc81c425eaf14f639b5306f6a5bc642b2ef02135d4ba7d4d961269d50513",
  "revision/zh-CN":
    "7d3cacbfbce98652535719d39041ab71c9671ff368f5e700c63c7ac007d0e880",
  "setting/en":
    "20b2b0b7d6dd63b15590181c2afb04be2e9ded4996fe3b03dc2c81e59034a70e",
  "setting/zh-CN":
    "b7bf06f743d16e594dbc3b90c51d97e1b19d6b36dfc68ed231593c32f77926e0",
};
