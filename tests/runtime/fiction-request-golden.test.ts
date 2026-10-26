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
import {
  settingImprovementRuntimeContract,
  settingImprovementToolDefinitions,
} from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

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
 * Gameplay wording (control/gameplay.json mentions, bag guidance) reaches the
 * model only for tabletop worlds and packages.
 * Later, the world-revision author summary (#116) states that existing state
 * documents may be deleted or moved under the reference-blocker rule; only the
 * two revision digests moved and were regenerated.
 * Later, the directory list tools (state_list, setting_list, world_revision_list)
 * dropped limit/cursor and return the whole directory (#120); the state_list
 * tool description moved in every request, so all 76 digests were regenerated.
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
        runtimeContract: settingImprovementRuntimeContract(
          locale,
          fictionGameplay,
        ),
        authorPrompt: "golden author prompt",
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
        runtimeContract: settingImprovementRuntimeContract(
          locale,
          fictionGameplay,
        ),
        authorPrompt: "golden author prompt",
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
    "7be311f0a9bbbc8795cc592d92cd804c94b775b85c5ef32fe18f026a03a8cd12",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "694c6fbc56fa354d4b8f4c510f581bd7ac260f38a9083752c561aba416e44feb",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "ab4c9e0890d3f0948827d571288db65d6c75132b59e39d1d6e6c7fca4f4eff7e",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "199c37035ec42bc0d3ba06bad76494ff0aad09656b7a4690aa03ec5a42a30395",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "84c55a64a3fae100719071829e0dcc2d6140e7c12bb12cc816ec8dba24d55ad6",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "99c9e277d7ecb0f92183ec69d603c45bf71e07894e3e686d4ced26f1eaeecdea",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "7be311f0a9bbbc8795cc592d92cd804c94b775b85c5ef32fe18f026a03a8cd12",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "694c6fbc56fa354d4b8f4c510f581bd7ac260f38a9083752c561aba416e44feb",
  "bootstrap/en/ordered-default/chat_completions/append":
    "ab4c9e0890d3f0948827d571288db65d6c75132b59e39d1d6e6c7fca4f4eff7e",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "199c37035ec42bc0d3ba06bad76494ff0aad09656b7a4690aa03ec5a42a30395",
  "bootstrap/en/ordered-default/openai_responses/append":
    "84c55a64a3fae100719071829e0dcc2d6140e7c12bb12cc816ec8dba24d55ad6",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "99c9e277d7ecb0f92183ec69d603c45bf71e07894e3e686d4ced26f1eaeecdea",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "5d20d75ff98e7bea9af70ebecfe17ecccde9d0d31d774adbef072b5e3772030c",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "a29cc2bbda751930fbf97471725f9c01d99d2618aca21cbde00997e470ea3bca",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "8e873d49a1ae29f2544a971e2f4a16f4b67e2fce4417aa092aa4bb8da6a6071a",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d26c1095164ae83badd24f92e5a80846552852f41774015662e614d87c38e250",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "7b2d43f4a4e0d4f3be46173a3f54ec14cfb36f4d8c1e55a4e8400412e9da9ac2",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "7d26dace89d49329d4abe234c210279fdbe0356dfe9b3d8691ae250382f56697",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "5d20d75ff98e7bea9af70ebecfe17ecccde9d0d31d774adbef072b5e3772030c",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "a29cc2bbda751930fbf97471725f9c01d99d2618aca21cbde00997e470ea3bca",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "8e873d49a1ae29f2544a971e2f4a16f4b67e2fce4417aa092aa4bb8da6a6071a",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "d26c1095164ae83badd24f92e5a80846552852f41774015662e614d87c38e250",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "7b2d43f4a4e0d4f3be46173a3f54ec14cfb36f4d8c1e55a4e8400412e9da9ac2",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "7d26dace89d49329d4abe234c210279fdbe0356dfe9b3d8691ae250382f56697",
  "chain/en/legacy-v1/anthropic_messages/append":
    "7b2a57f442db42a5218015b125eb9cd3a3f23b7410820f88fdada148f05ea5cf",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "92c74157059295afa7d30d5e8f519b41678699cbb3acb18e3ae0837ef08d09ab",
  "chain/en/legacy-v1/chat_completions/append":
    "d2c50e1a5ff1521b5fd635eccf891bbcfc2193827060faf6c5ae6abab7ebc112",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "4469292f0bc13fb980be6aef7e485968ff5c09d052598dce1107db3aa95d1a35",
  "chain/en/legacy-v1/openai_responses/append":
    "bb201a487443ee72e2c77267bda54cf1ce317311c2b25ef6f11bc7b9ce40c41e",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "a4195eda481d584523facd8dd569a45c47c94ff04c6ef551486721e9f3ddaf16",
  "chain/en/ordered-default/anthropic_messages/append":
    "475fd49e9cc43744818e23d9bb5f7d63b85a7f3f37c39aaddd9f2886c150e218",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "8042471734ff18f7c625ba89eeb3e8cebf1ed0516bab998386ff8dc675eee9ce",
  "chain/en/ordered-default/chat_completions/append":
    "269e6f44759d0fff4683b1819f3d1d7efe911185310261d6fff7cf6d932932cb",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "94f9968374804fc67e0757bd9c07f13ea6200f0597a2a3e58d4553cf8657f891",
  "chain/en/ordered-default/openai_responses/append":
    "2f1db0a3b418a7e69891752558d71e9d94a5f496041b0a2a63f5b5a8e5fd459f",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "eceb6158e67ae286dfc4bd1792722770e90eb0581e7b2d5b203362f684b1da6a",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "a80581fa1d3a296837a1680fbec3d933ad89fa665d57fcb5cf49493771ea98f7",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "c72602a05aec340906386c04a740185fe93bdb655691e83990faa516f7b03971",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "6908a70439f17d51d927db4ea496f3a2d098f07e8003394bb77b7dcbd9988ee5",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "be0f96b5fd0a0485d5dd98b4dd1f813af0ca9b18c1866316e9c372639e474c6a",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "a0f6552c4fef3d501985735d531e1bcdcdb4e0f8e571a31dfcf2de9f116e8ef0",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "484c6e8732a59aa949a71f978615af6e08bc67dbca0b7575c20903bf019cb154",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "47a27905791699b9f0887686cd8ce453b47c8219d22e32ec11a243ce86af8d16",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "cf752233443cde6be93ab8a30e3720cf1e7a66167de09c5f555b539abe675099",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "a643bf57d7b7b85e0dcdf0b30a81c253e9912965a6bc2dc10e21882a7045cc5c",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "722817b10d2dc8fe3bfc02fc4169419991d8fd020409b4c8944f327398ae52c0",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "41fdf646e921e3a58707587e0ad5437025d89a20a1cac87b53a09baa76aff5d1",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "69d2e2536ae423eb90bf4ff1ce50df9a5b613d44b0526be675b00a3bde573e8d",
  "preview/en/legacy-v1/anthropic_messages/append":
    "55587c6f41c5bde2677a8bc6c951cd4e1394760364a39de81edc04ce83a0594a",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "ece889e3cbfaefb6ba66ecb221053977821eef5fc2dc82f40dfc7cf543de41fa",
  "preview/en/legacy-v1/chat_completions/append":
    "0354373dccfe562da0f156506c9bf40e22208921ba7a269868becea5dd97d3d7",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "96d579c14e126a44eccd92837084f54c9d5f23166f41344e4bfe8c7378d04cc1",
  "preview/en/legacy-v1/openai_responses/append":
    "23d19c43bf02633356bf60b304e90a8661f4d9e0f256c7e29bf83f05f729eb62",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "24bab7daf895cd883204fb32781f22485fcbed7e865e09d41afce273459b9a99",
  "preview/en/ordered-default/anthropic_messages/append":
    "a59ff9bf2ce256d6cb226757c9b1648c68fff99c50ae1287b06df9f08acfaf67",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "8e2c453f10e720183412a85c10cbdb48a0b3ecfa5bd7d33a0c58cb53385a4b66",
  "preview/en/ordered-default/chat_completions/append":
    "461c58162bdef71ed0680bdd647a3839a4c928c31b141ea5d395141237fa8aa2",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "d80a1262cef32fa6e6d99af7d398d6aaaf1458d650d54750580c91f40435f02c",
  "preview/en/ordered-default/openai_responses/append":
    "7d93c0d00c9d30fb3cddd218f0ce5d343ad93d56586a8e167729936f2d57453d",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "2fc3ea2d33c0c456fe8ddaa71f3bf870a9374993332b28e8c4eae05fe967ff59",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "f1c67093aa153f9db0d94d5758f7b1ca74a6fe40eecf8592ca8ae4535eb5d922",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "c8555dfb796079f93e9a54fb82677bc9075e3b68e8f93593b25bf625331c6f59",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "36b5fd0e3861cd5508bcc65b6eb9273dae491a57356f580bd6a113edfac8a820",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "52778049c331179b608b41ce4958ad3d3c4c92a179584c3d14b72a2934091f26",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "55589db06731715a6c19ca03d28e960eaaf1f885f53e1266041aa3623af42465",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "00ecbc30dbebe9de644efcf6afec311c3658e82d8efdc40d2cf25d1d12504279",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "83a421b087f6b4c811d7674afa01e1399ab7e83077278c0eea4942aabd38461c",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "8e9396265c149d48492865ecffc9c138a61ea948b8c6ac1930ade2c3a1bb7d83",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "c6cc2bad37f1293105087e3c03848b7c55c402b77946b3b4fc42e1dbb80a8966",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "18cce50d0e3f55d466b5fc4500dc1729935dd99655a0e2400e4d72e5ad392098",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "4b48552d11b1c39616bbfc9d49066415fa8ecac8a9e90678099ec55d4a96669a",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "aabe1d6c4dde04b80e5ad515cd28483b885a6d62b9fc1617d19b0c3d35f8f589",
  "revision/en":
    "befd1de1c09664dcb4ba44bd16255db2f093364c88b02b72ddcf3658da825ed7",
  "revision/zh-CN":
    "dd65cceb5b21c204f06f3f37a426ca9fccec6da221cbd2a04681ec5aae57e78b",
  "setting/en":
    "7221b5a7988beb735bdb83b75e8246908a37dcadfea5f1470c44beb316582e08",
  "setting/zh-CN":
    "9b7f3d263c21748d8885c0b09d508492435c6ef1ff182f4505da05c8162475b4",
};
