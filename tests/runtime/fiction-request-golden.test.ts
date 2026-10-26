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
    "85b919d4f459543e4df1f49ab116daf562070749f00c85676ba77b7e7a01a29d",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "e2589a7f6cb91554b06688bfcce749f9258cc9ef0a42fd3e256769a79bee264c",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "8f078fc168c4080f6911742e98a68ddace7490047fc201acbc122ac6af7b0964",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "7f413ca56908d74458fbc1329a94a79f6f40c87c1e4b74faab0ee1df54b270d6",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "e673c8b81b85d1ca137c7031b5253a24dd65dc411bb95df8fe7b9bd07b991908",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "da8f0ccca88bee48ba74b5dd569f12e0bd63a662a6c358216aa1799489477d42",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "85b919d4f459543e4df1f49ab116daf562070749f00c85676ba77b7e7a01a29d",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "e2589a7f6cb91554b06688bfcce749f9258cc9ef0a42fd3e256769a79bee264c",
  "bootstrap/en/ordered-default/chat_completions/append":
    "8f078fc168c4080f6911742e98a68ddace7490047fc201acbc122ac6af7b0964",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "7f413ca56908d74458fbc1329a94a79f6f40c87c1e4b74faab0ee1df54b270d6",
  "bootstrap/en/ordered-default/openai_responses/append":
    "e673c8b81b85d1ca137c7031b5253a24dd65dc411bb95df8fe7b9bd07b991908",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "da8f0ccca88bee48ba74b5dd569f12e0bd63a662a6c358216aa1799489477d42",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "550d0ea4250ccb8bd5a6a7ba0ae6c3649eb75e6355223ec699d4fbe1af663d59",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "8d50e3d3f22c8375d2f4e48f7fa9df742758531545920e5ba63dc27d61f60917",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "d95c23d9f6b75c13acf1fd584eb9e83ba8a65e0e2bae7c2bf47ed2e7bb685b95",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "b70ab8dcab0e7480ebad73fb52b9921a272602ce026c9f15064116ca4af8ece8",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "1a4943c6e12c441e49d1a64a1ba4806ee940be2cfbd5889cafb2dc58e97a772b",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "ce214fc5f0c4e22806c063bbdb5e6930d8b7d7b058466f91687c8245d5556afe",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "550d0ea4250ccb8bd5a6a7ba0ae6c3649eb75e6355223ec699d4fbe1af663d59",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "8d50e3d3f22c8375d2f4e48f7fa9df742758531545920e5ba63dc27d61f60917",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "d95c23d9f6b75c13acf1fd584eb9e83ba8a65e0e2bae7c2bf47ed2e7bb685b95",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "b70ab8dcab0e7480ebad73fb52b9921a272602ce026c9f15064116ca4af8ece8",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "1a4943c6e12c441e49d1a64a1ba4806ee940be2cfbd5889cafb2dc58e97a772b",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "ce214fc5f0c4e22806c063bbdb5e6930d8b7d7b058466f91687c8245d5556afe",
  "chain/en/legacy-v1/anthropic_messages/append":
    "aaa61083fda7df35ef49749a1938a7ac63001d0c7f41e16d5a02d61630b37365",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "3ac8efe636bafbf75f0fe9c4730a5380539a340f85001cd3ac155759ef00e8d0",
  "chain/en/legacy-v1/chat_completions/append":
    "59d7fae8ac1164b5d014fed14ad7969055d945fa863f3b8c4f065082509e7f27",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "a6578fd9645dbf18e4f49dbc1e75d904ee1010e2ed2020b025e1d299e6770ea2",
  "chain/en/legacy-v1/openai_responses/append":
    "0cac2a6c49ba105c3c1e56ba8cddcbc273c0770ce574906cc6e120f8b3950cbf",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "b844c64d112b847dd97e1df6235ca2f283c0329b2a6ac8ce983e3a2aa0bcfc33",
  "chain/en/ordered-default/anthropic_messages/append":
    "15e4708636a780a3f1ba5d0573463cae8aa88c68143becd79c427b5e6e61d438",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "8d4f004b2b769bbac4fdbcba032cefb28b0aa9802f04f7dd947f9c286e9bd128",
  "chain/en/ordered-default/chat_completions/append":
    "0bf6675fd3d88ccb8a5253d1bd997b293ddfcaa7354ab6108db1c221e4c67ca9",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "1f152b7b5fd6473ed5aa5614f2b07f8cb250f897387e24acad9b5cbe8883a946",
  "chain/en/ordered-default/openai_responses/append":
    "0fa69ee61d96d6b606326e6ad1f39443d2bfd48efedbe104f1d516002d54947e",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "85ae29003a322ddaf6e2aca00b7c6b5c753859b953606fc94975d0b36b58a0a3",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "b7a0babe7040ec582c80bda439c9039ddf68ef6f93c48a21fe8ec90da283a034",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "9d85a568ee4d995f3e47a65f91b36c8b90158091af4f2c8e85de3fdd3b4bcbf9",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "0ec15785c1b124ad73f3ffadfe29d18ba472bc5d43e92003dab7c78902e8fe6a",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "6294428002f6174bb69979fff8f0071cd84d920b5965c3be1954d7cd5da9de75",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "8f7950cfcf78fc9a8e7c9d47b3eecfa575eff19e8ecd0b4a70bc65c186e4b2ea",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "e5e2b592ad6f7bc8af3b9d69e845c8898ef08723616f9007a4ace3f99ad303bb",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "476ab2db865cd2f5a225a65964b4a19dfec3dde882210456c204b8caf1083ba4",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "982c68374ebb2bf5b9b15b06bba2a0b37903c64cd5b5d9577d1f27f16453bc18",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "8fa9e4f2d8ff64cc41b9ba9aaf4af883ae97efb390b90f565c259a67a8fa77e5",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "76ea8534e1f96bdbfb6c1f90e8f557cf23f417e0c893db71315763df30934bc4",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "20ec0f8c029de0449e66ad9ae162a286fa496b188b669a903420fdb532e08628",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "5a8b05e482f8a60e49f99012c5d1ff638ffa22850584efb6a9abe579d85f9367",
  "preview/en/legacy-v1/anthropic_messages/append":
    "43f64475ef3ae37dcf532c5b4f1ae6440108c440ce77a3df5908638f8fd3ad1a",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "dac9025069c51fbab4b4a8e8c9cc8cc9f00346e57e9626a53196d0155708e482",
  "preview/en/legacy-v1/chat_completions/append":
    "e604a76cc09cc92829c8c408fc3feb9996b084c0b2fd591d0f5ac5986a6a2aa5",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "f1b72e5a2f58fdbfb6e3f6ab229536302af0efbe2c7273455327b229e97d3a78",
  "preview/en/legacy-v1/openai_responses/append":
    "eaeb092e14b6c9f0de49ca41a288dd79562743021c79b8889a715f5bfef4a220",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "813a739f4659eecb0a5509ccc629eaed7a47292ce4b375577e41ac2ce27debe0",
  "preview/en/ordered-default/anthropic_messages/append":
    "5902a1509a43b839df0e551fda6792ac91fab8952b77b32712d20423fdf68994",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "6d83273e16b93d44b985ab0f0c97a2eb0139885f048e9bf4f96be6b67d6048c5",
  "preview/en/ordered-default/chat_completions/append":
    "85a3145b7a07fabacea5ce57a2fd05b9c4da661b156e580f0f0fb6d02b2ad7d8",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "ae6e26fd942cb6bdfb154a24b62c0e6c922474d27addf3b2b7f5f3b9d30a56d9",
  "preview/en/ordered-default/openai_responses/append":
    "bf31c6f986a532820ffc3295bc190845c064c8058754906086c4959ee2737856",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "b4f2cf4ef5e4271e38dd7a2b3f5c1bad0e8d336d64e25e70a33dcc2a8c1b1db1",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "a95b6a3b33ee92ce4e5bac54a065444897ab8c84b11e85179cfb3b5ff40279de",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "e7cb5a9c1fdac69710597b75243706bfdfe0f6cfc60d750e565da591809cb006",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "3e2f1f1344a9121132b8d289a7b1279702fe05e38c1fc58719152653ebf3e815",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "cdf0b7c32162df08f09e66e7ca4b43b21c22d07e310cbc1fd87f2ea5340a8677",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "4b7e20054eea16872d231a8fc355960240f0b75ca63b433eb8ff5aa273362ac8",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "a199d126f8356c0a383618808c07ba36e7061da2b71d1c542843efc942ffbedf",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "5132d40b6efaad1c0c005c80f6487c74d5c53797dc657b39ae91c562ed8d9a6d",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "f48e1a9792a4ca6d489ba96bf7c8ffb754751f9462ca42f99ec9c839e4855d3b",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "48067b303151a30c6b286c213982d976ed84d4072f0400b875b42c777b7cb400",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "5ef6c2c69021c107c01570f351499ea69c23f3abd066e4b3e165cd0b4026961f",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "6fc248666f74d39062d85855257251dc1d9767805303afdcb828402da1163b62",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "a312344bfdcebdb4ca3b96767e8964de75e79f52690596ad9a073145f03b4cc2",
  "revision/en":
    "049142cbdef6c330a731d413d3a216cd44c7d3a817ae20c4bae3dd7e470d15fc",
  "revision/zh-CN":
    "2a7ead2eb2d58a8736627624e4290f9cd266253d8e5af789cdf8259abc02b25b",
  "setting/en":
    "e17787e81f9108096859c167f9c3cd180d242d4c34ff28e4d8b4a3ea70b1aba8",
  "setting/zh-CN":
    "1884c5fe8499a69bf3fd38e9e8c4077afe336c34fec415ada3529dffa362b20c",
};
