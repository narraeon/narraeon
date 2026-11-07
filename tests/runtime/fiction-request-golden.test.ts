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
    "dae7ddf452ae90ee453f889d51c12561870894334a6b23d92aac1c5dfc59be90",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "195f3ffc24dbfe66626b600976cd0eba57e10027152922c24047df01655e890f",
  "chain/en/ordered-default/chat_completions/append":
    "40b9741e4adc372e18480f7e2d88b691481006104b74d0fb76cbdbaafcd74b46",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "142444fc89d7d8fe27eebd1c44e533f318c1899e49c1b63338ffe6d4a5c96494",
  "chain/en/ordered-default/openai_responses/append":
    "d76cce0710c61c7c43d6d8fc2ae5c8ffb26a63494a49d1821e20a430d1d795a8",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "399733ac4fe5417ca676533b8b51189e2af8878692e3c511f1f6b8097ad5a978",
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
    "25966ff282919185b72a1dfc995e3c2529494b59b0e980a911b996d6c4a98f66",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "c928f70eb46e4b8b81100e25bae60d2cc6d26fd4b1da8211e60aeb5c2c213c28",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "641166f53f8df031f16122b243cda8aa64ca8716895c968baa54d5d92d793d79",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "2eb94692d9101ccc8dafb0037ceb331aa3dcbae4ca0d31eb2492d0ca9ca74e87",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "301478a5e7f1d3e13b58c2610dec1b02047f66cbb98cad15bea4df02ab295132",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "a3e903361ab97178866bd3ab5b49acc82f32201cb7af360577cdf4f1401e23d0",
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
    "68c99f34e519e69f2306197346f61e8ecdbd5b4dac90d68889d8e1226c07922f",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "0ac4987474cb93efbee7f19a1047649a71c78bf96cfaae1a2c484325b8d2717e",
  "preview/en/ordered-default/chat_completions/append":
    "ede57f033954e8cc91874b88e2eac7855d8d25a378729132a9449509edacd1c6",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "4d1e9b45bbe7223edca536bbbd9fb47b950fc5d39514a4c5eec07847b64bd617",
  "preview/en/ordered-default/openai_responses/append":
    "95c4ad32af584997d7afd12fb5efb7b7f944c38638ac9c8a7c3a532801ac671a",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "7b3f993f30aa776161b4b8a7eec8c16f9d971a62e3429eb4e213b7736078607d",
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
    "d6cd4f3b0e02240c6c61b443fd0d513973e03ede5a12d4a2ee9d545eb3cbb660",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "4e316f5e4bef4719dc20e748a61b1d75f466633afb61401fdc2af67f167de0c5",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "c4c8ed3109095802320b32eacbc5fe07c0f61432a3b32016f0982ac0fbb55cd3",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "3c116ec773fea5f51870d93b86c9523e72a3c57a127520cafa94bb29dba2f589",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "78bf32b7ae6c6adf2e58bf60c44f5e6478d7adbde77fcf9b8457327525bd5702",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "886b4f165aa82d5532450c9d818eff2320416bb0a9f8719eaac87e967595109a",
  "revision/en":
    "af0c1c256a18b733fff6428a0f64463f4a3e1a649b51a379752ea0bfa22c695f",
  "revision/zh-CN":
    "4f71ab993a9e7a62be8f01d83dd90623499593a4be14c991c92548c6627b3887",
  "setting/en":
    "45beb40738ef950d56edce0349275b52938b7a148bdc6b9d4ea42cb4f28ebb43",
  "setting/zh-CN":
    "61d8d062b97f51aba472292332cde1f529370028f0a4fbb8fcda99a5f3110438",
};
