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
 * Provenance: the digests below were regenerated after main 2541c83, when the
 * narrative-person rule moved out of the general style block into the
 * play.person-* builtins (second person enabled by default). That change moved
 * 28 of the 76 digests; the 24 preset-free bootstrap digests are unchanged.
 * The commit before it (2541c83) had split the continuation rules out of the
 * narrative block the same way.
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
    "1357de7bae3dbd517a7eae69f91403e67dee7ff1705efa5b0ac928f74ea7a64d",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "8af80cd34640011458bede482044af891ee9a501a3fc4fe1626dd048061ebffa",
  "chain/en/ordered-default/chat_completions/append":
    "388613f257f83d4e00c67dce8918e70ed5d1b2d3fc907924b72fcaf9b0fcf46a",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "a5a390879551294a749c3fcd44df695bc8a8a559418683083609bb873d7e5346",
  "chain/en/ordered-default/openai_responses/append":
    "560604f3daafa4b5b0fc84d9c15cc6cace5c0e292247aa798a88fdb0b95ffb06",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "35996f39f57b45e1a66aeeb77fb479ce3e59d78a236fceacd562b99d1c46d02e",
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
    "a2bf5a576786d6bc43ccd5855d9c0e612ef64ccdfeb74a0b91a739490bda6696",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "e33f2d8ab7432343f3c1c56a2673a898b40093373845a10276c371879f85772c",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "bb593a9a9ede38d78ebb2776960eedcba9ee4d7c0fff29ac43a92aca590d3112",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "c381e3031107ecf25dcc91f3eb16b707bff6ef90d2e05c4cb4bc07781e126624",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "16e0d5800ba99c442e9133a51a2310e0d183f6c00482dc61c7403a0ddbeabd9e",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "1b499c149d326aa0b5b320d838fba118f3dc30dda18745c3c404a99f8b9a7e5b",
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
    "bb45cc72247f1bf540c85f6c190ccc7e6d56e927c6d54af26f2e39df28df7338",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "3bf0bde98418bef7c36c92789490324aab61e906c13a2d4ab994c3afc1fd7861",
  "preview/en/ordered-default/chat_completions/append":
    "ede4a70c6cef4d99270b9ab810bb9be7dc2663038bcd61bc1c7686271ab27bcd",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "16148f50debcc2791da41a51dff9a4fe939a64a0fad301c246422f818475d30b",
  "preview/en/ordered-default/openai_responses/append":
    "28c754fe2644df22ce31acc01024223d35106b0a884ffed6ff14c4b8252108e0",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "383beaa0333d4356ab062e5c02627679410caa9e27ef90a869f768dc5c86aac6",
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
    "e7ac00c03848d5c36e1813dbdf851223971938e27fcb265f80c1aa1918ee6fe5",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ab96a6a5d1ff7d20fb2ae7ddc8933fdbcef07fce4ae9da2c9d251b1069fb76b0",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "35d152e740f96d70e3d49a30b8442f1360325287634f3897d34f0eab08164970",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "2245e86b8a3d1589d798a103d2cc193bc56ef7121190ae53cd1ff9cd67b2ce71",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "1f29022670f8909506b3c3906d1da0fef12dea2e772889771db98f2863b38be0",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "8a09738da2d6c9840221dffe4294ddf6ec23f7b807b5ead7f61fde6b22f60237",
  "revision/en":
    "066fa277ed255cffdd24c7907a2d060aeae9e1ec1ee21289547ba3ddc7a6c352",
  "revision/zh-CN":
    "980c5524faffb878ea173c1f60e0f99455a189211d0b7c0256b664290769d503",
  "setting/en":
    "bf066d8aa56144d801c99bd74efb307e8f5ab75baddc153d6842a5b8c2846406",
  "setting/zh-CN":
    "16fbbffb6195eda0dd47a8e7919f5f73997d0bc44d949b45963d79cc8e8e9418",
};
