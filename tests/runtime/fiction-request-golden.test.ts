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
 * Provenance: the digests below were generated from main 8f29721 by running
 * this scenario set on a git archive of that commit (the harness with the
 * fiction gameplay arguments removed, since main has no gameplay API; the
 * interactive-fiction default makes that removal a no-op for requests). The
 * previous digests were generated from base 45ee767; main's later commits
 * changed 76 of the 76 digests, which is why they were regenerated.
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
    "4f1f6d72374fc3c7f2a7d229bc6fd33a1bc66aa8b5b187a5ae099741cdced94a",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "e4181e86f71907bcc5122d9e585ebef1470ae610c8416b16e050f56dd3c9bac4",
  "chain/en/legacy-v1/chat_completions/append":
    "d508f05b96c87bbec0239daa70d5ed9e93466effc3177e776b717c792157137f",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "e0fc82240d027d985f0da0b9c91603dba03a76d7cdbcdc5176952e49b697a0be",
  "chain/en/legacy-v1/openai_responses/append":
    "de67068516c619ebf7896c568d33d7451330423a705ff1bc2d04043b88d6823b",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "5711b4b5bd4903574b07448eea57ee009532e409e78048509bb53b3a634967e3",
  "chain/en/ordered-default/anthropic_messages/append":
    "67080e0d34f1006987a1c4bad131297acca0208120c6221db8de8fd1e2171a2f",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "17c79f2b608f7adf8c4e650c152d329afb8e746f0a6034deee75236179018c7f",
  "chain/en/ordered-default/chat_completions/append":
    "0e98b1bb1e8d616a46066908f52c254266396d1768d629e57bc5a61fd0e74d1d",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "b35c296f538a17441cbb445ec1339445373c0e8dc86b999fa37ed88e0c063d2d",
  "chain/en/ordered-default/openai_responses/append":
    "f90fe4b89ca7fe5b434ad2d7183d289c8532d5171c05943a22c1565dcf4de940",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "6ac5ad114fd16f23ff183e988aac4e7c8b41f5a52d17329b6b455c80b785c9bb",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "b5f9f21a3262857c4274f03d572d9f5e40d77ecd5a2dd7e81953164a647752cc",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "5b5b90117acb105946b2b0fc11cc3f56b7948848bd6ef3e96779ac3abedd8d99",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "61345c73a8a7e8e2bfd7798a46cc1edabf698e3fe4582871b61d82d4c50fb33a",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "98ddac76e8ec59b1254ca4534ce6c74d3b0d47f9806ddf72ab19120a4c624998",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "5a30ae2519982f0648f98cd0463c3778efe5da2d1bce72cf0effa0779c0aed9a",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "96760caa6e527232f7a45cc1b520de1004aa388bdcd45262ca3101b115e45c31",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "4439c1fd98e919f83897d0e3dff38ddaa8188e5d6457a0e8b7edb37609ab504e",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "d517b08025c6395b6e5447f64e433c2d86a64a54d604082ce5c7728b020db1c5",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "72e594fda4982dc2e4777ddfb93a82aff25a7f71f7d8d5d139c969998269585d",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "a5945cb2b1c89b8d3cf3b1989f6d6e6f60f4b6ec13eb7908d5158292bd7b7640",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "36b85ca4a83528b3ffaf31b59fbc594f90166638e68369d5d01d6753bde0bb46",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "21d4985bdafc4a2eeaa366c54bf188b211f3453795e65523f79d8ad26e253155",
  "preview/en/legacy-v1/anthropic_messages/append":
    "16536ddee3a75f8c50c551c167ed72bfeb1f8f22b3f4643e54e2dbb69f3d4aa7",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "65d024db677a87c30801bc7ffca1756b14e5f3aca20bcc015078034bd6641c20",
  "preview/en/legacy-v1/chat_completions/append":
    "b4066b2126a59bcca1a63a4b3f0254e254c5852394a6babc37107f5f5fd4ab21",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "c9b031f396bb8261615a92b39e9ec33dfe1bf08f6bc048ba67a2a218116276de",
  "preview/en/legacy-v1/openai_responses/append":
    "1f801a37c1b8ab0365534b18a1a32a96dc10413dc22e7453130a05f975253f8a",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "8f818bbcf14b934920f16ffa8b124acfb1c06a50dcced61cdb3dfcceef35d8cb",
  "preview/en/ordered-default/anthropic_messages/append":
    "2021cf4a164f1dd8ed90d87d796a4902a3bccba2c448f41544efc293865b97b6",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "b190fb54e949182def8a30208470b3af91e0c8b0a079e810e17eff1a2af6bb82",
  "preview/en/ordered-default/chat_completions/append":
    "a572f1c61fc147d149517f110439b048b15cc65aab9a3b56a61accc6d4f54cb7",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "a82bf2c3ec5837249e3b483e3dcee0462efb0bdac5a41d68d6f1dad782e85be2",
  "preview/en/ordered-default/openai_responses/append":
    "c85ae4cb948d7c4dd4b04c292e585649fc0305aea5742879eb74aff38db66aa5",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "7bc7b60e889a190f6b8ea5cffa85701901a1ecf88a5cf6eaa897e39e17f23e7b",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "f1ff0e8780aad50eb97a949d7934a014c821c4e93627e4574ab387283f9e3323",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "e7b976549c72d32ab2cb261b2011cf5b553dc9ddd4a14eeac7f6fd00b5626d33",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "6a76c6475e5968492d4cf55e53da089fca6e42fd3572d85366d086de01b7fe78",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "4714ebbe3d95b94850a8eb61b57aec489c6909d46d565676c51c63b3d1f367bd",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "22e9bffb1a060145c5c4d4a27ff2178555c7acd1201eca4b99642e24aab62956",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "f1c39813faea36b166ffd0bcf65d4835c73cf70d692113dc66761f0f7aac23dd",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "94469845f3cf34508e7f2e61b6e73332aa1b98c0cda7299811bb2af5546674d4",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "d6a0900f9a50cb9ed28f61e574acc916bbc218e0df9fc651bb83ddcc3d30f37d",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "cd8ba9ea19f5ca9fd6b71789958020a0193b81115bd107461c7856e364bb8a34",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "fa0bb01be64fdf6502242b9833ebce49b0c9a2f44790f615e9f6995856eb97ee",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "3cbee816d685a7c14e9acff98c7c7b323174ad370179aef3794bc0d262ca4697",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "7c7e8682c52bbf094b2fc4d67b084ed35a15faaff4615b1f31637c7162f691ac",
  "revision/en":
    "8746e918d2d7621a3d49bc8837c2d910236c266f2e9ed14025dc4f656bc753b7",
  "revision/zh-CN":
    "b98b97860835ec03f00367e3321392242bc19126a913325ef6a7e7e15497588c",
  "setting/en":
    "0bf53e0b464830ede2d10fd20c6a89c940a814f96ca6768e962c592034e586e2",
  "setting/zh-CN":
    "3517fa6feba3bd05f60a5e7b8a96b5c37fd3428596e708f808bc6254efb447d2",
};
