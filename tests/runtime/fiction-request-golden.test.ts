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
 * Provenance: the digests below were regenerated at the commit that split the
 * continuation rules out of the narrative block (after main 7afe47c): the
 * narrative wording changed and the default ordered preset gained the
 * play.continue-stage and play.continue-advance builtins. The previous digests
 * were generated from main 8f29721; this change moved 52 of the 76 digests
 * (the 24 preset-free bootstrap digests are unchanged).
 * Gameplay wording (control/gameplay.json mentions, bag guidance) reaches the
 * model only for tabletop worlds and packages.
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
    "63674a619f5244b797e36dd953a8fc8ec0da410427cd686ddfb92a1be6c437ff",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "d1499e3249aa0b7d974ac8aa5878bca125a552105ed169651d1a3860dce8da9f",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "d057eed38b2d6f5f1cabc2d473f3f95ab4855596756180b4cbb41d8971daaff7",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "07573569fe678351757dddcff28c99d78b76f70db18e577a8e8a6e1a74c983e1",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "572db31dbb8f856b35ebecf103c3ff7cbc43812d0b1d9e810e7e314b180d9bb6",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "7e8bb14d78e2eb2ffc33420ebbc68d07b5b67e09b0be32d7d56f0d7c0ef9d3e3",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "63674a619f5244b797e36dd953a8fc8ec0da410427cd686ddfb92a1be6c437ff",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "d1499e3249aa0b7d974ac8aa5878bca125a552105ed169651d1a3860dce8da9f",
  "bootstrap/en/ordered-default/chat_completions/append":
    "d057eed38b2d6f5f1cabc2d473f3f95ab4855596756180b4cbb41d8971daaff7",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "07573569fe678351757dddcff28c99d78b76f70db18e577a8e8a6e1a74c983e1",
  "bootstrap/en/ordered-default/openai_responses/append":
    "572db31dbb8f856b35ebecf103c3ff7cbc43812d0b1d9e810e7e314b180d9bb6",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "7e8bb14d78e2eb2ffc33420ebbc68d07b5b67e09b0be32d7d56f0d7c0ef9d3e3",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "3cbfa453d9c6975239d10c81388ce63029cf89bd51b253d06ccdba7061fcac21",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "95d9550623f0e9906be13e173a8ca15d4cbeb2c675dbe07a53ad4c5e97c7b339",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "ddbd88b171e6d4910df27e8aff2d0f4fce776ce36d91f67926ff0fedd8e4e331",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "a58e0d0435a4f9f0863bce4b8d5d59f74c532534749426738eca83ead99b9872",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "c1ff43e9eeb70f45d45955dd18532a7d7a319db9b1cfda84bea31bd6a48be5e1",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "1b82f2f7312bb1a839f807d397186497c92e0e6dcaab7a109cdb8c27a8a9dd06",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "3cbfa453d9c6975239d10c81388ce63029cf89bd51b253d06ccdba7061fcac21",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "95d9550623f0e9906be13e173a8ca15d4cbeb2c675dbe07a53ad4c5e97c7b339",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "ddbd88b171e6d4910df27e8aff2d0f4fce776ce36d91f67926ff0fedd8e4e331",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "a58e0d0435a4f9f0863bce4b8d5d59f74c532534749426738eca83ead99b9872",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "c1ff43e9eeb70f45d45955dd18532a7d7a319db9b1cfda84bea31bd6a48be5e1",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "1b82f2f7312bb1a839f807d397186497c92e0e6dcaab7a109cdb8c27a8a9dd06",
  "chain/en/legacy-v1/anthropic_messages/append":
    "45d45a7572fd9f4dd14aab3211110899fba274b83c630074086f1efd0c393756",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "e0b159d1f8a07d7ab630ef15cbb6048e533039851a24f9260413b8d35ddccebb",
  "chain/en/legacy-v1/chat_completions/append":
    "af98b70cf92284457fbc1a33e913f172c8a433edf1c9be6362f70bd103bc2148",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "78c0f7b290600ca14593d4c7d057b9abb8999adfb2a672c71530588e0bf0372e",
  "chain/en/legacy-v1/openai_responses/append":
    "42b68ce670232a4fe86077b4a8b90166b395373233225c49758379460601da0c",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "6c526c2a729e24776b3ce407e5d05b0abe3750982805136561624531fe8117e0",
  "chain/en/ordered-default/anthropic_messages/append":
    "c80f458d93ad73e3dfd0e4b25cbc9239e993967a1de08dac797ebdb7599913df",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "fd3500a20af292f4edcee3a915dd695b4d0cb7efde0ded3c2b8405eaeb35b3ca",
  "chain/en/ordered-default/chat_completions/append":
    "3d637c1bf65c7cee0776edab352ec93e7f4bcdfeb8bb2de9848910f4925632a3",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "fa16a4bde5381166c88a39182694512f554cf46ada8ef772fa2547d51a2c3f88",
  "chain/en/ordered-default/openai_responses/append":
    "89f735fcb159a69169ab66938043a89435a8a6ce5ea4551ca06855dfa5811a23",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "13d9230816f4e1e7c59d7cd358c2e31cb9eb7400d731084bc2f4130299c01eb0",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "97eff8deb0c2c79024e5b8d2bc1a1aa671ede549eb9a00bd6638a329e96cec6c",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "bf230b06fa3559e1913eda7ce04a0fc76e8a0d0b12cae32f259df814e787d04f",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "aaa4e83a92aa516da0d1c06aed4c045c119ef8207baebe0ff27574fe46dbc113",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "39b494d8fd37ca4f9eb9ac34a95efc4a20b0396c10cbb2301f5729a9d3a005f7",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "4c2cb03f33a35f68c1efac3d545ba46a68b997f9ddea966a2fea2d076371357b",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "f867d11f475b4d42546c3fbaa408e80c55fbc4bd9baf71ed903c5c90d7f663cc",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "3382ed5261c1b149467d2b3f2d7a2226a5ee2812cf480df59dc2ac1f4b7f64b4",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "0aeae2f59c4b49047ec9f3bc37e94f21c4ff67651c5adbeec30daf4fb4373fcb",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "bd5babbbdccc4e2c4c4d6bd617a84a863dcd903e20b59cb7c99bdb50c543b300",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "1a8b415143a545e678f99b7c930d9a1de9a8eaa1f79edc76b277820b38aec566",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "b9c5317196317caa787c534a2b8db5391ab370302745f9f8eb81519c5937e4aa",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "cd583f29ac4623d35b9fe1c45509b4a06ced520fcd1aebba2f4b1d6899b93d6f",
  "preview/en/legacy-v1/anthropic_messages/append":
    "64cc3ad7dfac0b3ea0dd908abb652a62584e0797e2541bd52d7da7f7407d2d12",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "e037f8b7007b9f80831c8da97813498367902e913413223e50766c7a9bb56220",
  "preview/en/legacy-v1/chat_completions/append":
    "4898fa0e4374c909e3a4b8b59816c9823a5625a9ebebde5e5b4a9ed52f6dc7b5",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "45530ad6f35009234d3a299f8baeefd4301d24dd5429c4db3c7ae1e0cc40c20f",
  "preview/en/legacy-v1/openai_responses/append":
    "f32b76a8db25105cfdde6c60093f7f067261560007ed45374bd29e7ea8f455e1",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "d645aa9022a0880a6b31b0b2863fddb7f6008277d167bcdcb6d998cb66fd7db3",
  "preview/en/ordered-default/anthropic_messages/append":
    "5e85b8c87374fbd84c0a114fbafa6637db857956089e026b6fa38ef534f81340",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "4ae5412fdec646c7addfce884d896aed023d292ae3304ad33169a9c5f7b0e2de",
  "preview/en/ordered-default/chat_completions/append":
    "c57f754d18d7ee01980fe7da88ccb706d11f0a75ebf499fec29a93a54caaeaa1",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "e6f3e82b574461b055316798c1d9b54682d959e41b87e9fa093e9fcc7f6bf54c",
  "preview/en/ordered-default/openai_responses/append":
    "12e531c001f773486e413ac1c24496b9dd3227679f6c0e6ac2a1383f17f4aa98",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "1b2113f57ac1e630e2ef5c186234792e268d8c84133b0f5d9b918b5ec30c8bb6",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "373efa622389b791170db7ce9f1c46a791c830395e7846ee75934b518f052bb9",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "b2d206efa7fc861110ed27a02b95299c64faa08b72fa6f7a830e5e84017270ff",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "4e9338163410146cb0e19eae6494363c4c0625d66394979991b55cebe6e1f29a",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "c5fe87a20191d5460d94ca2c195dc99dcb74d2c1fa2b975dacaef0964e174715",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "ac9162826d08b6f5460abfb8b974a0b0cf4e9eccdef0fd97c3a56fb51312248d",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "4837eb28475105e2b60a3fc47b305901e721d5e7e821a427bd9be3cd9412831f",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "ae31033072c8417af3706ab59cbc7a106a85f8eabb8d451575cffcd2a01b12c5",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "c4fa486c0178c026d0efc15ed6143f3d0573ea53ccefc2a04fe3e994b6fa2d5b",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "b7dcde82687105ce8b3bc803e5a19fb6a1e27e41c9961ebf85d608f648ace388",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "c87bde25cbd926a973544882488fc73e064070e50505b85b9a57e5fb45a08ff8",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "00bbd586ae1a1b30acd0b3bbcbb2f76511cb9e9be13e5231bbfbf7fcbfe8572a",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "6b2a9506a953ecdcde8135c8c2eb95e7821e343d5fdd2bb21a8a1625d9722f0f",
  "revision/en":
    "fa18868b9f737db03a1d1e67e9e81afa7c657f71b7fcaeb17d062304b6b18b83",
  "revision/zh-CN":
    "23dd3200f962f06f909b77f44c2635761dc97d6378f646d70dfe8f5f463df206",
  "setting/en":
    "41dfef208bbb6bc05a59ba6bb07be340c8ada31e3ebad1d07c38dacbe59584c6",
  "setting/zh-CN":
    "e9c7a8dbfc578165c70733b9cf4765d39afee461fc4ce76e2ae2cdaf0b06ff60",
};
