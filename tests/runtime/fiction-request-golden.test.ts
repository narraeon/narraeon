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
    "deabed0e8ad40bd7540202ae6a87e8d22d5899bb0e6107825f772b1fbc7440ea",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "9a4f7b3fab29cfc458e30bd4ee90ab661dc63cade8897a456ba2e9e6a968cdef",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "93bbd47cfbcb7cde1d6bf760d635c53fb7c6de0b8ec9eb54dd0f5256325a0069",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "9e84b18655cb554fd89fbd3165b6f4b59734ea2c1303c824f709c0a39c044cce",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "fea2e0a5fa7e5edbc8d82dc87ffab05b343d24d6c8ea6af01ec6842e53ed72b8",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "b3f1ad811c7db3766f74604329d57c57bc6ce79a4f7c0b0961d2a880d8861442",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "deabed0e8ad40bd7540202ae6a87e8d22d5899bb0e6107825f772b1fbc7440ea",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "9a4f7b3fab29cfc458e30bd4ee90ab661dc63cade8897a456ba2e9e6a968cdef",
  "bootstrap/en/ordered-default/chat_completions/append":
    "93bbd47cfbcb7cde1d6bf760d635c53fb7c6de0b8ec9eb54dd0f5256325a0069",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "9e84b18655cb554fd89fbd3165b6f4b59734ea2c1303c824f709c0a39c044cce",
  "bootstrap/en/ordered-default/openai_responses/append":
    "fea2e0a5fa7e5edbc8d82dc87ffab05b343d24d6c8ea6af01ec6842e53ed72b8",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "b3f1ad811c7db3766f74604329d57c57bc6ce79a4f7c0b0961d2a880d8861442",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "5c17fcc05f986791a2012eabbf180d582aa86be282f83ee13fb29ae8c9d9f111",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "d7cd985f626eded4f438fa60a91c6a68f4df3ff1b04cdaea13b11183484488af",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "c2a2c2ffc7043e443ba806ddb891e01e950e7456084d4ca35838ad778ca48831",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "b3d4b2c8cb1ffcd4fc992b7c3df2967fca140ce1746c63cf90320df9d7203100",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "8c4eeadbaf155ffe120e197d6f3b0248f9df4244fed96c23e485ba3cc60c107d",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "5f7993acb255b7111eb5574e8fb6d9e8506fc21a6a755bb828818f81090013eb",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "5c17fcc05f986791a2012eabbf180d582aa86be282f83ee13fb29ae8c9d9f111",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "d7cd985f626eded4f438fa60a91c6a68f4df3ff1b04cdaea13b11183484488af",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "c2a2c2ffc7043e443ba806ddb891e01e950e7456084d4ca35838ad778ca48831",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "b3d4b2c8cb1ffcd4fc992b7c3df2967fca140ce1746c63cf90320df9d7203100",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "8c4eeadbaf155ffe120e197d6f3b0248f9df4244fed96c23e485ba3cc60c107d",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "5f7993acb255b7111eb5574e8fb6d9e8506fc21a6a755bb828818f81090013eb",
  "chain/en/legacy-v1/anthropic_messages/append":
    "ee87a36ffdabf838ea416bfdd80be8ac7de20146aa40eb89975eaccb192389ec",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "362f8f7c064b22f619487d9821e1eaadfbd9377a9538dd23f44486ed8c304d1e",
  "chain/en/legacy-v1/chat_completions/append":
    "0c26b5ffcdb2620e9f587459fc16c8cf8cc2b350e0151d34af20fa9d0e177ddf",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "22d3b0e5d5cfc6c01eb812d080804e83076d12d83159df427653a73eb2fa38c2",
  "chain/en/legacy-v1/openai_responses/append":
    "4ac096cb7c0054e1b77b8766348f9f0f88dda11e2670dd682faff27b0af0865e",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "3ab68bba4a303c34ba763b779931ae796c6bc6b7dacd74bd1e313cb61d2613b4",
  "chain/en/ordered-default/anthropic_messages/append":
    "d90c37efd848683e6f3ddab5cd8847461d864478bd07e8cb6ab3e606af39488c",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "824b819c4be1ea669f110ead10a3df8d1d912b2d688d2601c17fbb54e9aa2376",
  "chain/en/ordered-default/chat_completions/append":
    "1dd4fd15fab7a52959968851c1fb66bcc94e81482f1b5db16c1f6715439268f0",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "b3a08ff5f225dead59428f7295dd4e09416c22a4f688221fbad46f103782d95c",
  "chain/en/ordered-default/openai_responses/append":
    "daf6f368452ec83cadb84af2bf9e70ff70f179bc432410f095687cb27f508314",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "69061508b418b42e5a79946c34b231fec8d50a3ade0bf4fc831f52530c110d72",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "f6145cb2378928ef9d08aaaea060fe65f1172b669303cf5be8b1ab9e47b224fd",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "ec4194c791b092abbfb32971051f3f693c84f45b657335101898e811ce2bc981",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "2e5cc929a23a7fa92bd194e99d273d7632c0a8fef90c0b2330fe6c8ba22cc0f8",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "fa0557d9988c6b05c62e9c76eda2010b629a47d6d4a8c648361377112137f059",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "45de08b131c69a02f688aef5f216906ed8971755aa138927c6dc20da57b27434",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "34434ad007e2e049f6a2eae0392971ae61edf96b6488e611b717e3324bfe0236",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "7b873d9baa5dd0729cf8cbb7b56f1508f346fb9f65061ee7a554bbee56e72b03",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "5dda830d9e608b6eb4d502157feb7889d35b5661a012c6dc85369660b5eba0c7",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "10d458a0c9d4eec8e55992ea0aa6e3b061ab091322b71a704a16a23556692f27",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "2472a237c1810fa2d32bb3d86462d87a5004b73e0886d6e83d6cfc086a872630",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "71194e5ff13a43d79c66f3a1737bf9e46088698916a50664c549f3165859e54f",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "1254738eec3f7869d08b442a8d30c8ae81fd5006b4878adeb930839ca7d3faab",
  "preview/en/legacy-v1/anthropic_messages/append":
    "93c30b60003755e7c22770f9578c0345111967a5cac98455518ec9d0dd1d7c9e",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "1da1fb778fda39c0545489ec9a0117bb0a0078af2c1db409267746594c52e25f",
  "preview/en/legacy-v1/chat_completions/append":
    "7ccd023d3e22981828516738646658ee425e4700ab48ef0030c5581dfcf9cafd",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "07980bfc4a0b4c2592409fa8e3559920a7716425ab10275db4964749f81a5d3e",
  "preview/en/legacy-v1/openai_responses/append":
    "c2ab0252063a111c44de1e3d9818a6349bd8c15823f402fe8b0e560ecaf6b65f",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "133553aa495d4fd2d2c27372eb1d109810fd39e89af4058959020e8d1a457d6b",
  "preview/en/ordered-default/anthropic_messages/append":
    "91f740b41c22c15cfd1e21d4bdf8d39d5f90434848191a59de3b7454517a81a3",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "e1df0efe5368ce648fdd6b34678bd440bec7f6cfa3cb03bf61b095a1ab6266d9",
  "preview/en/ordered-default/chat_completions/append":
    "39734dca8d5cbc01a962127eaebfd3a58d0ee8b3a7b2f726f7fdcd6ffde008eb",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "c5d1dc84694af0c931c9b28745626917956a7cd3115eefbc8f7f9acfddf12425",
  "preview/en/ordered-default/openai_responses/append":
    "64d783e0709c3100cec44feda7fc6d76b10175997b37a4d08492ae731474cb9b",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "865086ecb3b25f72581d40e2bc28d874a9caaa7772c87525c0f730005fd00e42",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "b8f4150a10adac31c931ca62c7df06732f0358be5d974b672c34323eaaeed1e0",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "d0d862955f69e4f17c6cc7bd99c7920eface24394061d0023ba2a2df20291966",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "ca4988c738c9a97a1232f9ff5934407fa9003ed7a7224f7689aea91024ff8bd5",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "86d9c077292e909236574cc31f490ac231f9b872a4a59a466644ade9a5a5bc6e",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "9a5ffd53060cd64cb11ccbf27a6f7761a1c6bff00f3691820516aff2ab2d8357",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "d02abadb7b00b3b0421e91082626da690f7935e21c9d007ac73200aa67a0925a",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "9e666572cf5cf3f8f2930a37aec8b63b3924322259bc2a5294c2db159ff099c7",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "36b96ab567e41c71f6d4ef08a5ff53502180caa73722a7f6b54bdae9e8b41d93",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "1727a522dea4414a746e82123e021849d74d4f552e6230a4b654c3ca44ffe001",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "b3797ca39d5ced525b2cbbc3cb957bf8955a8e1ed09362df7821e51562a94019",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "fa29c4b18d1cdbbe6002ac7d6c6553e89e55de8a52597c65e550ca3f51e6c46c",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "95c61b22e90d046071c5613208fcf64e0cd65ec0d836844b23a8aa8be234c7a8",
  "revision/en":
    "50ad0466eaf3dcce310650d8ef14c669caf84e2f637aa4221be1a0e81041542f",
  "revision/zh-CN":
    "413b05cc17b18d68b1350dc5618c0cad84d724aa6976c673cd28d2c5a8eb035e",
  "setting/en":
    "2e07c6a61807bdf0367d251773e5f602b78f30b3c667144c7186527f5bee5f89",
  "setting/zh-CN":
    "ad042c070ec6e8ee73c6c27d377461a9f7ede5776ed8951f4f2db32736034371",
};
