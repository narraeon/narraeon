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
    "8f4675bdb169877ad2a299dfeaa50e618b09822258773ba87f645bcde493795e",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "4e4cf1686a7defede7861022ba5ee4f40d27617d9b77cdcf70dde292a1418a31",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "12d816ce237f759c0546c27c046cb8ab5aedddd38d5c1f5414c38e1ebe00a4b2",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "3063e507173f899adb7aa1eea8587c98023d8349e5d9bf6dfd206458d786e4b4",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "023e1bec8e8b3ce7e653351db9bc360f347087e0d3388528161eb6ac79c3d673",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "8559693a8f6207f37d61668057151b585ace12152bb22df8115c9208b3ef217a",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "8f4675bdb169877ad2a299dfeaa50e618b09822258773ba87f645bcde493795e",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "4e4cf1686a7defede7861022ba5ee4f40d27617d9b77cdcf70dde292a1418a31",
  "bootstrap/en/ordered-default/chat_completions/append":
    "12d816ce237f759c0546c27c046cb8ab5aedddd38d5c1f5414c38e1ebe00a4b2",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "3063e507173f899adb7aa1eea8587c98023d8349e5d9bf6dfd206458d786e4b4",
  "bootstrap/en/ordered-default/openai_responses/append":
    "023e1bec8e8b3ce7e653351db9bc360f347087e0d3388528161eb6ac79c3d673",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "8559693a8f6207f37d61668057151b585ace12152bb22df8115c9208b3ef217a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "e57dbfacd445917dd05270b5276302bfe955c9f517944a14b0e5fa19067e5b80",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "11c950423a4fb54e331b0396c2ce9e81f661dc5ac7b5d9c4646c0482809d5c47",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "e80a650014a10ed0345d5c598964ca119efb3dc15b527e8f5bdc731896cee6e3",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "866d74526e30cfa2eb78d32659bbab7c827224e9c8208af55833378653e8476c",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "05eef52d35aee21a74c701c88e6bc86891b6515e0517b467888c58c198a78096",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "41a5f86c96a6339a8805761b537b968192771b32a0c66b42697e9cee0b639c03",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "e57dbfacd445917dd05270b5276302bfe955c9f517944a14b0e5fa19067e5b80",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "11c950423a4fb54e331b0396c2ce9e81f661dc5ac7b5d9c4646c0482809d5c47",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "e80a650014a10ed0345d5c598964ca119efb3dc15b527e8f5bdc731896cee6e3",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "866d74526e30cfa2eb78d32659bbab7c827224e9c8208af55833378653e8476c",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "05eef52d35aee21a74c701c88e6bc86891b6515e0517b467888c58c198a78096",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "41a5f86c96a6339a8805761b537b968192771b32a0c66b42697e9cee0b639c03",
  "chain/en/legacy-v1/anthropic_messages/append":
    "ffcea39936076d4018b97eff4451e72a48bb4824b0c1e25bd07ee4b8adcb9c61",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "81ad28f83979b41e5e0cd756c52f1bf682b34f1d5b51373c4e6289e65e2580cf",
  "chain/en/legacy-v1/chat_completions/append":
    "16c312138bdc3001e28f94bf20c390626c0ac814c4f3a166e43d123fb448d387",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "73b8e72b206543674dcced4193a53f7c760bf349e8767e2cac5a6aa21857d16a",
  "chain/en/legacy-v1/openai_responses/append":
    "3560995c1c77e3ebbcc047d78b2793e02f397b66ff48339cfb775257e1814a73",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "bc8eb35dfa8a54558953af39970dcdd2374c49716b83adcec449160e912796d4",
  "chain/en/ordered-default/anthropic_messages/append":
    "09cd0fe58e3fe1b25cb72499f5116872dc3b67c8fd9f2a21568faa8a88a50324",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "e1ffc0cba2ca457741d636068ce8a56539d5b7be117afcc11269a1cea97eb5c9",
  "chain/en/ordered-default/chat_completions/append":
    "348ecd36e9922e4c88141b1fa40da068b9c21a0c1b965faf7b7fec2d90edcd09",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "4b4ef5233b0efef0c0f58a9b209e138ac9aad315d2e7ee00d9e1e5a89ddfda0e",
  "chain/en/ordered-default/openai_responses/append":
    "d30ef61fea21136e8c980c9de29faa0c47f1da97ae92a0f1b3f3314fd5cee835",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "cdded2ceb151340730d1cea46857bd312251e2e4a40a789109dcebeb14ae52a5",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "85d3f3b7a2747aef02831bde0ead8dfce37ea81cb057e7340397db5b5d2b886d",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "2df2c93b6ffd7f8d6055ff9dec91a6aca9faef788a411c49657798e0fb8dcebe",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "3a0402fb15acb60d1db7760184c5b7e6caadaa6930ff7ed47504c840c47d3f0c",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "94cbbb6015e966d09cfd4bd5c7e705cf03d5585981023bb1d5f2ab50767de9bb",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "09351979a4aef4380b5f5aaf7fe59f5ce470f0151eae8cfdae22453e204e187b",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "dad8b71b61c6cffc89f4d15cd17665c52088c77ab078f01b0b0672cfa0687c90",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "048f8d69d9ded86c0deb272c1a6599da18b0e44fcc798484f191fb33e7246866",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "494cae384c7d8072369e443fc30a8fbcc59fa5ea80d54a5b7666fa3040351aa7",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "ec13071de41c119a01957a6b1bd0f3e9a058bef07ceb4f924b01f79c13a408e2",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "abd25d41de2297a6d74bf0918595cf6bd6f7fd7f735e1c12f93106d3fd884eda",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "280ba84751b05dedeba52c9e11b15239a8ab92403e5a34f6b99cd5e5ac9fae35",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "a70199028aa3eeca49db371e65b4596d555ea7b80146f77c1425a1418994772e",
  "preview/en/legacy-v1/anthropic_messages/append":
    "03e04ddfa8590d5ba0253c585f6d50ddb1259916c5d7558b992e607397865ea9",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "db40bcf2aa762b0b58f12274aba2dfbb2deafe98a74349121b24d36df2d38e53",
  "preview/en/legacy-v1/chat_completions/append":
    "a3ac877d0333ed646b23ee8e348d9059fd26e7e79ab3ebabb7e64eb48dbf03ac",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "1ec9b586a867ce71702b3892386675ddf2394c6957e177b0a92dfe1e02a47e6a",
  "preview/en/legacy-v1/openai_responses/append":
    "10355583ee1d7d816e05d7e94635082cb6a23f118ffefc2852260bdaaa7d08b0",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "d0ed73e0a35f666f345267adb3cc80770a9b306933dcb6a345efca4b015e843d",
  "preview/en/ordered-default/anthropic_messages/append":
    "ace5d8a82e6ed220fcc6013116189f122e4a3b81fb88f5aec59207f3ae7a85c4",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "cdb2b58bd34faf17aa674ce14416cb9db6cfa69cfd2bd161d5d94909e259722f",
  "preview/en/ordered-default/chat_completions/append":
    "ebe3fb2394fe89e7e96dba40e42dc32944f90a55757695b22857a579c470e096",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "8c94b4eb5d22570ba4f824d5a64f92b9c0111888ff168b7a2d5452cf2c82d800",
  "preview/en/ordered-default/openai_responses/append":
    "0442ae4484bcaefb589f354fd9c40dbff15ad63b67dd55e499b891780cb03303",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "2f9e51711d77efdc710eb67c5fee230edf0ddc8f5cba7759910f6edeb991c22f",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "2e088f6ea2196c84860896481d89710a5d7e25a1f075711dda7e51ecd05ad011",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "606ecbc10cbb7c1823592fdde4398c86748bcd186c421ff3ce438dadf40cb681",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "8655763f246551ad219ef377b3db9edc60eecf1e480c14c71e8c86b90097156b",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "511849b6643472a3f42f9fa4ac878a5358cf603d4c3f8e21e0f25e9cc865c3fb",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "23189013ef2a8afd8d183fcfb258bff851dcc8c22ea57e908fbe8e2953264712",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "ab79fe2680bd462834b72819f9c65be872657d217336cf6d1a29142f77098d2b",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "ddc5809dd12faa982ce06d671b9c4a8a0943705280f0ed3f7b1ffebdac38815d",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "7d4f4bf1a3b661d7b31d2d799667541f548ff3081da262ea386539720e9e16d4",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "60ce512bdb24de7dee2e66865eacbffca3c426eb5814a72e5de12bbcbfc9299c",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "98e38b033d8391c80b1454941cd3b93230180e0ec6207c42e790a0cfee9fddb7",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "c9a10ca595a11d8a4679aee0c927344779d93f7f7bde57237d11f526a89fbf52",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "65f5f864fa767be903f5389b726c218ff56a0f5acc3477ef08ebe8ab578d0df5",
  "revision/en":
    "707c67a407b2999fe1e09235fb326c37c666769d2aeefb12a35cf7bad6b1a112",
  "revision/zh-CN":
    "5677518f1ccbc124bff6fc0f0fab50af9cf4c30b3b0884ef9734c95846715ef2",
  "setting/en":
    "36b41eeb498f165c1110b32cf5099b89e3d91c19e7ab1e0ea8cc31a76eda844d",
  "setting/zh-CN":
    "bedc66dc815cdc80c8ad5b3c4939a44f9dbd9dec47987a8dab391d06a09fbdf3",
};
