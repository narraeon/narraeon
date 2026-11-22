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
    "7d42e7f34d7ac4a41095f7ed90597c3c7d2af3daa88b04784c52be931691ce3c",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "e8c82795ab685e2893718bcc83dd6b0b7e5119049ebcffb943c605e8b1ff64c3",
  "chain/en/legacy-v1/chat_completions/append":
    "9040bd455c8569878d50b9058793149fba8b1278210d01dd9c9101eeac9c335b",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "3ad8f816952324d6e4552727f352151b1c381b1be3d878d9af612b60bf52ede8",
  "chain/en/legacy-v1/openai_responses/append":
    "44bbd67c9ab1b0bd72d594af526d3dddbdb89b4675cea0aac3b2fefd16e09587",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "4ec9e8e09c07341c57d05973b75cde0c01cbd85581ad57145a7e0bb50f3f63fa",
  "chain/en/ordered-default/anthropic_messages/append":
    "91bfa67c2964d60cc421848375a88e3ae61908fcfff2cdc369ed8766d65d97ee",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "3b883b1afe913b6c1dc014a49409043ca2706f5987960fdf6be28abd531ed7b6",
  "chain/en/ordered-default/chat_completions/append":
    "9f27bfe708069688d21bfd4af86b02744c3ba165edd4b662e36d63b5d7aaeff9",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "3875e24339452cd5b3f543ea21cd12aecaabeccd8ab9f4b9185f8d32a4297701",
  "chain/en/ordered-default/openai_responses/append":
    "f849615f0fbdd38c5d523e8c5d271becd86a2e42727ac6fe6c1615c5e6e816a4",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "ceadeea36b4e611ef6f1ef997eb42a8df3ed6ef2e5abaabe2ff360ea903edd7f",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "d0bb94ca45bd0a20258ebb4a11066930afc646d736f75202621d0e3724ff3d2f",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "759a308019f3d9616fe6f84d1ac8f8f47604455f437784a69fdd3e92d3d0e76c",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "e74a318383b8f87e49af4f3c2519dc257b42cf15e268e7def8cb67d5270fc0c4",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "26139f758d55aea5e58f2f9f17e663b66b3744dea3f114eeb110fa6558dd7efd",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "702a39927ad29de97ed14b1fbc764c008b632a2e8bccb31370c93def22ea1dca",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "544df7cb994582362fe7966751e1b11d886b87c838e5c90260a33f485464cdb0",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "cb83d5e4989a9411613656139826c59ea6683a5cce02ac99feda5dc3a46315b5",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "3f4cc660bfb53ca58956a6dbf64cef4989b914152b7ea17caedf6daea56d3b12",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "d133e3b675a4392e2ccf8784a03ee193349a7f4c4694783f3f03bc519853ac39",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "c64600bd3a71761590c51da8bc96746dc15dc7e6e3cb02b6a1abfb7343f8eca4",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "9e1394786875dbbed97c49091e27b0062cdccf045a001eabcb1d3516e4671e19",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "27de385112dab977fd2419734928cbfc8747764cd3a49e7b138b219ffaefa11c",
  "preview/en/legacy-v1/anthropic_messages/append":
    "21d05b564dba7c9b6b32ca3cf1017b88a97016b314d314f24adaadf73a195f2f",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "2327b78e5e3eb461e09cf0ba09172c8838be9ae89c29c9dfab21d626c06637fc",
  "preview/en/legacy-v1/chat_completions/append":
    "17cc83d9d6322ff923016421a08dc3a6db945c4ad7dd9be9c85d0a86168c419d",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "2ab27f5064d4aad63251a75bb47648ed5b7732a06f39f3fe13e21554b99d1099",
  "preview/en/legacy-v1/openai_responses/append":
    "c7b5e3f6265fcf180c85d1096eda73095f8d537292d9dae9a078d7c755eee5b5",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "b060a49e6cce3fff673daa7289a2f9131b3f007dcc61b7bc58abbe62af35f49c",
  "preview/en/ordered-default/anthropic_messages/append":
    "61ecf963bed2aa23ac0f48d1eaafb4a1de5fe1781bcadf7f59520da439c01881",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "7e6747edc082554cebc33c3066fa392459ee2b23f86f3bd104afbcac4d156f35",
  "preview/en/ordered-default/chat_completions/append":
    "4f3a93fd8686364d10acdbc07f7305db1f7ab345dc87db7883caa4454854559c",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "8cdcde15f2141959536c0fea085f2a49068af3b878cad4a8e0ce4cc7b364fb8c",
  "preview/en/ordered-default/openai_responses/append":
    "45611e811b77f4957248d91926576af8278449c623ee5c7e9c5d5de11d6d8712",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "a16922f116847b149e25b11ceff4f0a68d764e8333b16df017abaecea9b1e144",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "d219415ec5d720796488693322b36647875ca702ceadbb5d7629d93c03d4eac8",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "29d00a63e3a7b460ed9b882e055719a86909b551655a352cf5e0c936cafab085",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "62611a2c783f8b0fe01b3b4ad4ccfabc5c4e890b2993515dc3c4ca2f34799ef9",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "c8c97badb04a12dd52f2cddfe7bfdb928a6c03a8bf542f42a6de34b1358a5ce6",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "e066d686c988f4b280507fae3aaf520dd8a95d964c89f087f65ac769082d6f83",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "626e96a429624c9fe06e6cfcae01094677ecb3db3920ea95d88233f827ebe5d5",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "88ec569d608eb69a70dbf3d716330f4dde23cc9ddace3031d27a76ff7e8c8f64",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "0293ebf7d03b33d421a901e2afdad9d86dfc6abf3b0162434f5ad9bfcaca9be8",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "ebe46bbef3c05a1a4e3f01123340de1a84f4bda7c6e87c2d2753574ba53fb4f5",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "111d6733b2149504a91922b431abd4fe68745a096ec672d2ccb469033da92ec1",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "92e96243e97d4b01b30d06364b986f51e782b4c16bcc16b4b5bac3cf8a0c83bb",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "4b8cbf49549532a06c7dfe187a84a62504a73088fb06570b3e93785b08d9fb22",
  "revision/en":
    "210062d7f27f32cd66bc449c2ac34432f8e1268bd49b723fc2474a468708175b",
  "revision/zh-CN":
    "f0175d427a23f2a02d16783a73c8fef987369250ada1154a344aa17456df0349",
  "setting/en":
    "084835b327e5228a11cd77a0d17361924c416ee46fee9f3cf114b0ae8ac9c939",
  "setting/zh-CN":
    "c9717e4594108c8e2062276872026a1d082ba6fe7deafe2bbac904e739620707",
};
