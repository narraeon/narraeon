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
import { worldRevisionToolDefinitions } from "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts";

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
 * #334 records the Runtime text locale in every compilation and the initial
 * preload notice in production bootstraps, so all 76 compilation digests moved.
 * #355 adds Markdown section operations to the authoring tools. The four
 * authoring digests moved, and the revision digests use the revision tools.
 * #385 explains full history replay before the first effective checkpoint and
 * preserves durable opening details in authoring guidance. All 48 chain and
 * preview digests and the two setting digests moved.
 * #394 clarifies play preload write scopes and localizes read tool framing.
 * All 72 play digests moved.
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
        tools: worldRevisionToolDefinitions(locale, fictionGameplay),
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
    "20558cebfee2c5450acb8917e832849df84c22b122b006dbdde864e97d3ce92f",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "94da90826910971ae96abec0cb89d0ca539c23cc8ff1d7ab275785113aa2161b",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "941a54a8905bdf1aaf6ecb3ee83caef9a6468e8ddc37810ff079813408c5a9f6",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "9a67a369da2ce14035e8b4a293c4f94200ae1a958b5170d793c89b2b5dea140e",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "17372d64f595062e165d5008896348e63fc64ef8fb5d9cc162978f215fd0fafe",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "4804c7ace09e6888b3ce3dbc09491418f04137adfb9f179c0d310c74dbc7b177",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "20558cebfee2c5450acb8917e832849df84c22b122b006dbdde864e97d3ce92f",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "94da90826910971ae96abec0cb89d0ca539c23cc8ff1d7ab275785113aa2161b",
  "bootstrap/en/ordered-default/chat_completions/append":
    "941a54a8905bdf1aaf6ecb3ee83caef9a6468e8ddc37810ff079813408c5a9f6",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "9a67a369da2ce14035e8b4a293c4f94200ae1a958b5170d793c89b2b5dea140e",
  "bootstrap/en/ordered-default/openai_responses/append":
    "17372d64f595062e165d5008896348e63fc64ef8fb5d9cc162978f215fd0fafe",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "4804c7ace09e6888b3ce3dbc09491418f04137adfb9f179c0d310c74dbc7b177",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "339a3b62c4429ef79e90310beaff2ad074a05c9809f1640bcdc94d9ccac53c5e",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "43feff88ec7432ca38c2cfba3da89d009880401422e8c9f043fab69ff2b6e228",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "f3ea62c2ca2ace0eced733b7cdbc6442fe8c88d805831f68d170a533b16236f3",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d569d50fda93c0d92df0ea580af5f9d7d119bb67758f29309c27f5591da364be",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "7185a7b758e269405a5a65204903b47a548aedae8f18d78a2d4a67bbdb7228fe",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "8e985e0d6d67a4928bca09fc6befd1cb4b73e52a2f68157c97ea3084ba5fb0c5",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "339a3b62c4429ef79e90310beaff2ad074a05c9809f1640bcdc94d9ccac53c5e",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "43feff88ec7432ca38c2cfba3da89d009880401422e8c9f043fab69ff2b6e228",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "f3ea62c2ca2ace0eced733b7cdbc6442fe8c88d805831f68d170a533b16236f3",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "d569d50fda93c0d92df0ea580af5f9d7d119bb67758f29309c27f5591da364be",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "7185a7b758e269405a5a65204903b47a548aedae8f18d78a2d4a67bbdb7228fe",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "8e985e0d6d67a4928bca09fc6befd1cb4b73e52a2f68157c97ea3084ba5fb0c5",
  "chain/en/legacy-v1/anthropic_messages/append":
    "986218645fd073171d5b231dd7ecfe35570f7553a351b8a93cbfcdf406990b21",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "ccf02f1e389f87a934a872389011910de199becc1568cc67bb7f1989fcbff031",
  "chain/en/legacy-v1/chat_completions/append":
    "30cb92efbd23c53d7feeb1243ba7486c851abd68f7183966063d961fd3b6dd4f",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "1eb373cee54896517b7b6b53b0e7156f99c311754652dbcb731ea15e858e17cb",
  "chain/en/legacy-v1/openai_responses/append":
    "78a1dae49b6802e4b437fb8b136b5d4b756fa76f7533a53d783c3a13a308e8d1",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "a52dbc8092c27ec0546133a231e39f7cceaef6b5e7e73ebf53b0381a5e7602db",
  "chain/en/ordered-default/anthropic_messages/append":
    "3600e22262aff355ae79dfb6549406cfdd25ea41463153f77b7b76242674c559",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "4a1859963337678ba9b7a0a14f491f0bc25b581ad19795ed37d765c38447a851",
  "chain/en/ordered-default/chat_completions/append":
    "3b9962c4b129b0852d1c5beca3b2dec018b05b1a45766acc40826c35da5d6dd4",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "15ab17692fdb9a90ab0e3c1af1dc2874fb264887d9acaa26a4e7597661a9d1e4",
  "chain/en/ordered-default/openai_responses/append":
    "b6578b0a9af101dd090d61c5cbbd310000ea5a3ebc2c95acf6e4358c9993edc0",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "166e6bb7832d8c7f16059ad8a2eeebe30dd6176ec58dbbd0d7dbee24b5cc6f6d",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "a5db136e18cb6704738b579e0b5fce557e9392ec51ea6627e75b8fb7d50417e7",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "1ea08cbb9346bdf0d35319d9acf1b7b68efb988005f103c7acdc176e19a6731f",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "1ac25a98f754372520f630988f23c3e81d256708bbad9be5242db6f387410782",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "859f236eb6ee9fe9e428a61a904cfc62deeb83f6d95238001b59aafdf5e6a091",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "1a192a1da402872853cca1c053cbe42541a610f0b74510b64a13beefc1a568e4",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "17e09216d83a2930f6923e524e7f7e5d2bdf9f7213f0793304ffe2c636938cec",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "d0a8896e9bc17866f65d249a5d4463304ea5e148ef40d5fc93f9ff4b3e6f09d3",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "4ad7f1a641bc97796231137fbd53a4393cd7ed30d7050d57a116bf3b75168015",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "7edc457fee929e30c17c6f4cd3c7ad1a319df4d2d73bcb220d0e932c83179526",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "0a2d15f5ccd262b7c40aada5e33aef417a50ce16a7f379b99a43217271d25db7",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "4f0f651e43bbef69d6dfa72f84ec3a5de758b8c7e82b51b35658eb59df44b385",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "a3153f628535dc8a7ec39d409ed2aeb2af716a8cb63a2da54f3e079a506e4cd9",
  "preview/en/legacy-v1/anthropic_messages/append":
    "9cdd6c9bc503377efdb04e686993d6107534268b6b91a3f105661175c4f40b64",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "96b4329bf192e81aec9ff7452b5e4f2674b9b516da7f6512daf6ba9f16a0253f",
  "preview/en/legacy-v1/chat_completions/append":
    "a1f21f0f8e9af192598e05ddba260f3ccb7f27bc07d2809411e1fb941aa7d077",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "13318f0b92796820e1e67eebfdc3a42db347c9f0122ccde380c6c3cd4c13a109",
  "preview/en/legacy-v1/openai_responses/append":
    "e26fd487a2cb491e841f89c8ccacfdcc57ef4f294eaeb47e022e83a3044c76a3",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "2a288f39e56305446ae4bf0d1e0c0abef297b97163546af54b6a1792ee16bbb5",
  "preview/en/ordered-default/anthropic_messages/append":
    "60a9b13017d45885ff12be5f3a3a1064234138e17891d99c277598bf7471be42",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "2fb8b28161df6713d934f0f39471da9caea0755bc6a8a1c2ef3c034b31e5a428",
  "preview/en/ordered-default/chat_completions/append":
    "580525569793bc1076484e3dff4dac41a10136c745d573ad67f101459e064e97",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "69c5db506fe2cf3291eb43ddcc34d9bcf458d07924932724265ebc3768469f89",
  "preview/en/ordered-default/openai_responses/append":
    "aa5607882221f65c33a9e1bc48709dad29d888be9056339d258d5e0623667b99",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "8beb6f256f26e775bdd3c8b209c9b65c80e6dd99193180e28349552e69bd3430",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "52a1b1a0d52151bb1e6ff3fc79a2257724000d9d9b1c8ac73c293585107025b6",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "cd9b29ab697b64a760ca0c19a917317c693dfb512d27ca422905f072ce9f9795",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "551ac2b29e6b89ff386d6532471356a5f1409d7900b87ead4aa47c87daa074c6",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "33249a8c86c4c7faf92d1437aa8f6de3a8b54ce0d24a473d5e87dc5a7637d0c0",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "44dec151860101ecf55d46bbc82652cc41f81fed3f3b12c1248e2faee93bb282",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "813b1b220fb6283e5640d952d9c0e4d2db6e46a18c3f21d5ac94b0623037482c",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "c667ec88a1cce58b5b9aec73887cf6ed06856382b6e4541a4def747743acd0fb",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "7b080c2a88a8bbc7a807aedb1963fe315b7b54bf98acb3eadbd75f934bfdefe4",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "9a86b58804efdeda35db7abb064ba1e5e732c0582ac335895f09f41cc05a3de9",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "c4d3b5e040cfaef5193538f2446f1f69c9089e331f10b75f17514e07dd33e1c6",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "ee6b4352f48cd317d11a16802cfa05b9fe5fd970de9913d221620ba648ab6f4c",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "9a7c310cf41696aa32cae7239c4cbee2338deb366b6a627477f778b7e0ff77fa",
  "revision/en":
    "066a11774f572304c6ad5f21c16230a8335adfa6b36c08a8518e740075709eff",
  "revision/zh-CN":
    "4c72140f1f697d7401b5116cbf1aa252b379d3c30a42345d1c126e69c1a75dda",
  "setting/en":
    "31e6493385aaa7e2fb771a5a3a1bb2cac32e1288426025289cfa1faa6e0d6b5b",
  "setting/zh-CN":
    "5f283a3da2edb10bc110d93b35f32b33365a2c5e7953a1ff1e15ebb1a263c2ce",
};
