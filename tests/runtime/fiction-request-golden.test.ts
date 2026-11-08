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
    "1d0c126ee131d4461fa996293c585d3bc97a970ab57d6c067cc67be2ee7105c3",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "acfd410adde0b062baf30de4afdf8cecfb66a2d867d7669ca8c96731f496c9d4",
  "chain/en/ordered-default/chat_completions/append":
    "1c74095acb834d99b4592c820fe2e0bfea8b3f2e650ef954f662f536f52324ae",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "499d116df082f3b10e18a7957f6c33ca3407e68258c0988021d3bf485bfeda5a",
  "chain/en/ordered-default/openai_responses/append":
    "9ffeb44c59c91edebe4d58f286e53267a37adf3aeda7906db880dd4d66c67b23",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "afdc21efd1b6c21f45db4cd8459cfaba67b8ebc4a6fe1f64bf1256b4349dae49",
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
    "d41bda32ec44f343b8168a28318a8c5ad42fdee895f6686961115b38b84cdc41",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "38e3981042fe9290dd4947568475976094db1a5da5507bad8cf7638e7eda6ab6",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "e50fe5dbe7c881a6566ae87ed3a4a1b7d7d8052d023b915d2a57901ad061fc28",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "e3a246438394168a39fbcf81aebe4cd29e696f73c02a3d44e09756985a2d86ad",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "ab9c536aef5421af9895ce893488cecb05f76c3410ca7ad89c5af8a29dfa671c",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "5daf1f7d41f658a1c9bf24296e2f66124614eb169d8e78eaa0a66f8d0aa71b4f",
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
    "11b263a8ef5d9002b177cd402e025e5a63ce550ded31e82722b2a1f438fe4244",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "35d97b664611df9fda1c9a0e58f7e953be33038ba6ccf07d0270dc65e7a3c334",
  "preview/en/ordered-default/chat_completions/append":
    "99456e67a863458b38ab98328307e103e8e17bd94c123bfc3cdfebae74172508",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "b3ea000f6d762cb8ee6824e4c339385a64b263ac57b2b9848d99b86712e28020",
  "preview/en/ordered-default/openai_responses/append":
    "2965163d09be17185c0a21533a6f7f1bd2fc23fbe3093cdd22698f61e3610ed5",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "cce75258817237342b1a7cfd0922dc476f43571636a0c914d73335961a75a224",
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
    "89b225d5f4e1c210efb23e4168ff702f46992b824755d3799bd1069cef8ca9ab",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "436634c53c91f881745381d559504f65157e7a94cd9408fa58c84c15599556c1",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "3e084da5414334d3f66292d596741a911fc2710cc5821aedca4f8699ecb457ec",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "3fe4b639b975036ac68e6cfe6b723d595f65c1ed6aa571cab7f0b41b5ceed9b8",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "cae1885027e78298b9f9340795b096a269570dbd95b0a88adf6fae5699bbb1f6",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "7db4071effb20fe586fdb36c2f7b8689760b8655cbcc00d2a2a70b4604a1a768",
  "revision/en":
    "b0828803453d3ee43038978d717c96120413f76eab8320664289fb968f46c3ce",
  "revision/zh-CN":
    "74b8b891fbb03d6aa0b06e8a897e155b8521ad76020c6859efb78d4da9122420",
  "setting/en":
    "e2125dd0196512557f48fe889e0f3f0a9f9755851c635f28b970da2a5bb067fe",
  "setting/zh-CN":
    "7efd38743e2c314d945baf2b54205c9ea0b6846dd163748718c0e1f490f688d7",
};
