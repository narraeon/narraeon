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
    "30517542d52b5e5f041b31bb3e74e70ebdd3d3c94744f2144713153f793d4c90",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "e0c2fc4d8a525ac90e5dcd9234d7c67d1caaca1b85b601f11a7c2afbf1f81c09",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "1dc5472d4bf884ea42cd0b19421d5e21e3020903e709ab099b18a3390da1ef77",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "0f69f6ab30de5045ed35dfa65203b648803271442ef4d93b5297b28d21fa69db",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "30517542d52b5e5f041b31bb3e74e70ebdd3d3c94744f2144713153f793d4c90",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "e0c2fc4d8a525ac90e5dcd9234d7c67d1caaca1b85b601f11a7c2afbf1f81c09",
  "bootstrap/en/ordered-default/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "1dc5472d4bf884ea42cd0b19421d5e21e3020903e709ab099b18a3390da1ef77",
  "bootstrap/en/ordered-default/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "0f69f6ab30de5045ed35dfa65203b648803271442ef4d93b5297b28d21fa69db",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "a48624d7349d9539e766ba373c56da904a5b76d6d03a6e8427c97f0dd330b7e9",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "c19e74638442b01b6f8e5abc9d68fd0d47e3d5545e9ab297485f0520681965b2",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "7271e8e3a58c20ea4c05dcbff005e833237a997b8338bc9a3611a366afd57f1f",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "a48624d7349d9539e766ba373c56da904a5b76d6d03a6e8427c97f0dd330b7e9",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "c19e74638442b01b6f8e5abc9d68fd0d47e3d5545e9ab297485f0520681965b2",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "7271e8e3a58c20ea4c05dcbff005e833237a997b8338bc9a3611a366afd57f1f",
  "chain/en/legacy-v1/anthropic_messages/append":
    "49fbea8b3710b53cbea256eb2fe82a882daab171289c67651a60fbb5e0fb353b",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "429b3e6f095419648c36b2e7afacacb391731875df0cfa8ae7031c5c07a99f7e",
  "chain/en/legacy-v1/chat_completions/append":
    "bb4a14f7bdd55fa6098ec1ae4e45e0f7eed83a5d6d1ff12941366a184b29a91e",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "1148d27d71c814ba22952524bafe50eaf41cfb17559b16d44efe8579a6703e84",
  "chain/en/legacy-v1/openai_responses/append":
    "00a7cfba777a92335a61a8eced6b914b643cbf6ddda381d338364608aa93792b",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "a854ec0fd105807033478bfb3a13d783be0e8ea3fb6ab543febcc1966f739e7a",
  "chain/en/ordered-default/anthropic_messages/append":
    "44aea77eab617b95a51aa40fdfef11a51b1e32bc42cb65f9b1a52b2ab4ab6695",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "d03795c53126bb59daf9f1842267c6aa716768fc587ee172091534625a69c856",
  "chain/en/ordered-default/chat_completions/append":
    "584164d0e4b072897dd607f16388bfbaa9259e38db8d3ff1978d983195cdf412",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "893b75d97feb211cb9653e0cd318873e7c4f14da89f3564a2620d41d3df3ef85",
  "chain/en/ordered-default/openai_responses/append":
    "bc625cad0b45620ccf364301df99273f44a5872b1a615a657b3cc75393cbdf09",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "7fe204587d570356aac799c9869eade7440dd8952ffb6f28263cf4ae3a2330be",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "489f12674a404d470cda28b4053add75aba0abb04d590e8be474443097309ee7",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "7a4af74c8dbb607dbc8605e9bcc14ea9854c4518ca7374ad90ac43237b123acb",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "f8720a406370f055094d4ef3ef3a0c390a3c4723c99ce88cb17d9e04e987023a",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "ba0a834c061ee327e0fc3f805d7a0b79ca57f23af506706e550b693045445843",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "2f3f511a48be39f7bad2ea1b97127181e8f785542f284b0a94efa54212206d09",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "b595c43c273f18ecf8426f392cb8957116de86bf8c50dd2c8fdaf2751c4ce8c1",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "0cc5f9610d1cf3ecce39bd3be40b99b434f87913d13a838b2c68fcc8fc5cc7ea",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ede782a4f7fa59bbacd7abe7404542a1af7d83e963d971b2ae8124d7dc02bd68",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "b73b29fb6515fe789129a297a3b9146916b3ba0d3d366ad53daf683f02c975aa",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "f8a45f64181b5164f00dc3d636f31e50dfea1933172b40f14c64264b63059ea3",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "d97374c8ddb6baf75a9e5fa1b91f6254807c79057447faf225cd88c380491ecd",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "48ffbbded90561680ec6aa7c1bb8b01fc855c0e50f3066771dfd6d75ff37d141",
  "preview/en/legacy-v1/anthropic_messages/append":
    "e8e52a0e7114b3f9acf665f1a6ca615b558d5673883d481f137baa7db6f544f3",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "bd197e5e7a16d9a7b86c77b81571c69523195d9ad2315e10b5a2c00f4b992f44",
  "preview/en/legacy-v1/chat_completions/append":
    "9b460f4122832881501cf9ff5f9aa8addbdcfb6221c46be7287cf3d75148c9c7",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "b5a98192f7548cafbbf9fa3a41baeac2a2a7bc8575aeef300db78921d2447f0b",
  "preview/en/legacy-v1/openai_responses/append":
    "df155a8e0f57d7635bb2e20926d807a28b8161aa191858aa2caa11b983b8ef4e",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "f4806d1589ab20dfd98a4b76916e345d8c01c9c6bbf5965f9dcdd743c29ddd25",
  "preview/en/ordered-default/anthropic_messages/append":
    "8073c5a1f39fbda93a991ecec61d1d60b0a6ad3505136a5e241f8a0b86e9039d",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "eb35ee825aca6a5f2bf97c2d467f9bbb5a232ce0351e6e6bc82ee958fb84cafb",
  "preview/en/ordered-default/chat_completions/append":
    "c23093bc1855afeeef91c630f155a1e86ae14b837c3dc53a16e61cea4d040bce",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "704abf504261ce7f397077fd2646620c7d2f6f8b9f1edce28ab8ed4781f112fa",
  "preview/en/ordered-default/openai_responses/append":
    "8dde71d085e4b33c71bc1fbc59e4c35942db26c549d0fe630404284f49c17656",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "c384664609cbefe48c9cc140767cd642bc61938ccefc47e64cade011d8db978f",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "dee64f76a6bb275d6935c555f6746d9bf64526d9c97bbdcb4a7e9bce2965b615",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "3eb7badadede75c8c0f8b0c07a2ccc9798855e008ce710c278871c11fb55f236",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "d39acfe151977c5786c1badeef0724b15cba3820a0b87cccd9b97a64836dfa64",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "35953239e29a6f8f50f28ed3bd80d4c3cd2380df9f6e553d94daec90a40be6ea",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "4b0eca605a5a55a55796e108ee2f8107d0a4d84108c0de2b3b0a9bda48dbbdf5",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "5b9f314bd5cd7e6be248c829f8ca07ad8c14a05fec6c0be8c97cc223a8881703",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "eeb9b967b64c63fecc80e2b760ed2a81d0e284276f81736326a335699d6fb257",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "91a1e7f4bff76ef3b19a6905090bd64c3b70ea4cb6c9a0bba4db4b840daf34e8",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "f7fa9b83dfeb2a874be5a8a81b3340365b459ca85206cb2b8861c896e650e633",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "5a9248f66f6584cb1ac0ddcc85c21b5627c04e8db067c9c621089fc667241c65",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "f19394d86f01277a8af93aafc0279ee2c000f1c69b39302f37dd4555265303db",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "450432a800de75bb26931d7c487438a8a9edf53618ab07404c1ba846026da12f",
  "revision/en":
    "b0828803453d3ee43038978d717c96120413f76eab8320664289fb968f46c3ce",
  "revision/zh-CN":
    "74b8b891fbb03d6aa0b06e8a897e155b8521ad76020c6859efb78d4da9122420",
  "setting/en":
    "92b65fc7af603b9cc1f2296c0fc78ca8b5adf2239579ed51f53f84505f618919",
  "setting/zh-CN":
    "c6098d7deee6f9e319f11fec99ef58950a3f6111443b8aaff52c5bfeba0b9cae",
};
