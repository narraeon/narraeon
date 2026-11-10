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
 * Explicit current-player boundaries and shortened turn-guide headers (#179)
 * change fresh chain/preview and authoring digests; preset-free bootstrap input
 * also receives the boundary. Frozen requests are not recompiled.
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
    "cb8d1136631b71bcd502a7a35c9048852fe91bd67047c7b8e5fbc1ba3f35a037",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "805aae2d6adb09d53c93ade5ff7b2fc2a7fbf6d033cbd138aaad735ebb19f963",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "68cea14cd6ddac831dd9b2023f0448af938adad9d71185055b88c3d5f8cd11ed",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "30517542d52b5e5f041b31bb3e74e70ebdd3d3c94744f2144713153f793d4c90",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "cb8d1136631b71bcd502a7a35c9048852fe91bd67047c7b8e5fbc1ba3f35a037",
  "bootstrap/en/ordered-default/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "805aae2d6adb09d53c93ade5ff7b2fc2a7fbf6d033cbd138aaad735ebb19f963",
  "bootstrap/en/ordered-default/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "68cea14cd6ddac831dd9b2023f0448af938adad9d71185055b88c3d5f8cd11ed",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "5f3aed844694913f47a0dd005acb0ab11551e5e6f9acca340ed86b570c79defa",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "a14e12daac4a64070da31c5bcb15cf600ae4d4fefd5d66858a7715fe1af16d65",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "38d45ee18fe7bc98461e60eebecc197cca6d01d82afebc95a4a749e99a6bf480",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "5f3aed844694913f47a0dd005acb0ab11551e5e6f9acca340ed86b570c79defa",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "a14e12daac4a64070da31c5bcb15cf600ae4d4fefd5d66858a7715fe1af16d65",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "38d45ee18fe7bc98461e60eebecc197cca6d01d82afebc95a4a749e99a6bf480",
  "chain/en/legacy-v1/anthropic_messages/append":
    "49fbea8b3710b53cbea256eb2fe82a882daab171289c67651a60fbb5e0fb353b",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "faa7cb60b268bfccc9192575bbdba1d8c1506a94473b58ee44f8949c873669ef",
  "chain/en/legacy-v1/chat_completions/append":
    "bb4a14f7bdd55fa6098ec1ae4e45e0f7eed83a5d6d1ff12941366a184b29a91e",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "cdb743eb2987b44476b6550e0a089f043083bb42eed742d7b873ba35cc998acc",
  "chain/en/legacy-v1/openai_responses/append":
    "00a7cfba777a92335a61a8eced6b914b643cbf6ddda381d338364608aa93792b",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "48647644843d9d830c1c4fb85fdaf4d77876e122fe7bccdacedfe6954f75662e",
  "chain/en/ordered-default/anthropic_messages/append":
    "d62831623f1f9e2f7b1accbd2e4e57bdd4e113ea45f0d02e3c8e71e67e1586bb",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "ddc619f048ec94f82717a9a2c6398dc26426026c09b905ef35a27b91cf697c3a",
  "chain/en/ordered-default/chat_completions/append":
    "05f3f39108ae87bb0995cdc569bec2a11bdc38643993c4decca59a819302ae8c",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "87ce031cfad64c66422ca99c1b823c6e61f8a5cf830ccf385ec6e8552b23fae2",
  "chain/en/ordered-default/openai_responses/append":
    "ee8d6f7299900b1370c3c7b9139baceab403d10137eb29bdc755c0981d6ee6e6",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "9c2604717cc180093f405c4f6c5ef80659e14308503a5b0226672686e1ff6745",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "489f12674a404d470cda28b4053add75aba0abb04d590e8be474443097309ee7",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "97f8bf5ae11810f29302f2f2fc5acbb2c8c63e6d4eb45574a26ee07d7f122fd3",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "f8720a406370f055094d4ef3ef3a0c390a3c4723c99ce88cb17d9e04e987023a",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "bb7b7a4f5f9793e4adf5484102eb749cfdf73627cc13c4c6692731e4258f9793",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "2f3f511a48be39f7bad2ea1b97127181e8f785542f284b0a94efa54212206d09",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "05357702e792a071dc2a6b1f1b94f00388ba3b9f0521146303f3135a2e75b0f0",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "f1ddc862591f7bb5bf8b07bf244736b0688b630267287b29eca292b89b6a4ec0",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "203c3d0347164b488233c04694346cd6a23389b6cafa6bd903a0f0021cbcee63",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "9c9fb37128662e316b1f04b32c58ead23c91fa849d23c0ec2faf8adbadef45ac",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "f5c8bd6bc89762c7ad4e1a20b89020e1ed4bbb4a942a3bf22b0de77c656d6965",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "e978436b8c3798082c57990d16b6cfde5e24ac2fab0dc16dde9f4de67815e2f2",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "577193df1cc7d43135e51a8bce6d075b48761fdfaf07eb21a7d799b335da6a4a",
  "preview/en/legacy-v1/anthropic_messages/append":
    "a7ca0222da29cb8af084eed8396e05f2621c97035a96db467780a81ebd90dd8f",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "3ef67c04be20a2c2091e70026dcd5c9d1767528b35f0803c1a20c20aa588f198",
  "preview/en/legacy-v1/chat_completions/append":
    "55fcfc6b80945a15d6911a50142e8bd7da5b420274e3b664b4f3b2df43875a77",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "ca2cc83099619716fd302d7e2d7d04737ca17fa3600ecb6321d2720c17413cd6",
  "preview/en/legacy-v1/openai_responses/append":
    "4dff429d8edf0f4c5cb46fc1f29846f090a4e1d280358c1002044481b579338e",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "fe19b3fa085102f7f373221b0e26e7bc4925bd6c0619a8273b5bea6c2acaeb31",
  "preview/en/ordered-default/anthropic_messages/append":
    "5922d36b02b018106b6b7a50b2d20f9f7a23ebf44eb9191b4ef0e323106d74d9",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "233363cb3eebe211b1467adfd6883f0c010566cdd10f7f9760600d448382e60a",
  "preview/en/ordered-default/chat_completions/append":
    "2f116da6611fffd039a01918f082b177f5998f7621c8358064f57f8d6de69acc",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "ce746112daa832cde22c1909a8b2c2cce24946d77f13f6f1b2bb320fd025aa2a",
  "preview/en/ordered-default/openai_responses/append":
    "43e06dcf7ec7c2a92ade8b6ef96f3bd1077350b8d94fac681c07c36ab3914bd4",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "de6d4858dc65a66560de9f01c22238f22b5fc12634a1643bb6c52e8f2db2f961",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "74f66751a53be1df5842aa8cb6166523f49d730cb76c6bac6176e20d5154d597",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "ffcd5d38237a0ba02698dca23bebd761a0eecfe3de574e560f35d18fbd4f650d",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "b491fb2037af77b52e70bc9b6a860da8b4dbd0e169524265446e61e1fbc4cba2",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "dd6e44cb1e7d0cbd4384c472a0894f7911b14f2091488851b501e02b6d145278",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "67791e7ede2ebda04cfc900af2500de6ceb0893b385a26e7c4918a70901129cf",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "3af37b1df9791a02b025f686796b680fedd5fbfec5341d96a7dea9ecc51a4959",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "1aa1922ec5b98f278a8742f4b1fcbc3697a1da95e8c841d86c68689a0e7f086c",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "24106953227c343acc09c28b7490cacba8e42560509fe915082f356d660af116",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "d08f45c8552cdcd24969c6c391031eb81ead522ed905f477461952dc9b94b723",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "2cf2d4787adf1673d9eed8f93fb6d5adbea57885194eee8fee2e47e4e2afa584",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "4a5470a298b7cf1ecea4f177240d748b1f7110233f4d1adbc14e20c461cd44b7",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "c5a9efa1fd9a8c1ea36caf036cb2a26d277054553fc6683db32bc0adad03d5e4",
  "revision/en":
    "b0828803453d3ee43038978d717c96120413f76eab8320664289fb968f46c3ce",
  "revision/zh-CN":
    "74b8b891fbb03d6aa0b06e8a897e155b8521ad76020c6859efb78d4da9122420",
  "setting/en":
    "ac7fb1d5a9ee209c9fa47269362458ab229eff16f8a5a957bb9c5f7c97a19536",
  "setting/zh-CN":
    "1880a2a4db0a5da0721263f4ada9d23c904130a2cbd5a83c7df5706d9143a4af",
};
