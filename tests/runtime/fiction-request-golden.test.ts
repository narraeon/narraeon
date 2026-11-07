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
    "9f557558d5bc1f2e982b18410b2dfe0513af158458f5067750198d568a917ffb",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "c3adf1b9f887ffa288cd89659cc01ec0408c24e1595fd9ff437b865facd23b6b",
  "chain/en/legacy-v1/chat_completions/append":
    "323b1f63785c5ddb57545b71fcb186a62ec43dcc7db1f50d0d7678fe0cf74076",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "2ad33fcf54c9913ea5b763d9c5e1c12c804a199ce70440ea7ea5abd56d5469d7",
  "chain/en/legacy-v1/openai_responses/append":
    "6eed07dfd1820c901dbec2a24313f1e28ffe7d148fabaa231ee8749fc6ae13cc",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "f4aa6f1069f7a887bca75cb2ef38cfa7796eca833122cfd368b18f7c574378f8",
  "chain/en/ordered-default/anthropic_messages/append":
    "f8c7341ec57fcc0ece2837cf4639bd06d1f4498d5a126e0dbd5e1ac36d1740d3",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "9667402284c3c502b22401b4712fbd4e37ef852be5853320dd063fbde20129fa",
  "chain/en/ordered-default/chat_completions/append":
    "f2123ec5cc92a1be3ffc8cab93235701378022f5402167bce4712403dafcc9d0",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "84823a42946eee6531132c38470221928ff7cf08db7827a45d37394d7bcd120d",
  "chain/en/ordered-default/openai_responses/append":
    "f8e798902b3f9d2d268113d1ce15eef956fa556cc58f27261b9c1328b5babe54",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "705bdb10698699f6e1f81ca09e34148d45878be34a2188a72ab4261a74a00ed5",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "cc392aa358bd6e5b7f8ffa30b747ed96ffe4f7c953f627bc6ca449d3d2053421",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "85637be76d560321c6c0133474c202ffe509adfda3d9381246c6ebe6b090121c",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "7596d9ad6e387f24486e6b47f9584ba12e4a6bbf860c5badd129e32cb16c2cae",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "803959b9ef8f6a16c1e627419c18e0accf00ec5180ac15d7d3bb01674f6e65c7",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "780bb96c5f2b6c1a2250d51a49e2f349a3807eb2878409bdc471239b04c06023",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "3e36732ba6448b5ecc313c4ab8cca86313225126f7e131583ddda5a407f2a096",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "4048a4cb77bebe4799484f0449f3e1a6b9da693f07a7ae1e5bbfaadb1d6ee004",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ec094c962468a4a1d0e13b03510ad3cb081cc0c6b13cb11fc619c5e042355af3",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "6ea61b8ad025ae2f3c93f5dc137f76e34c18c45a6165bb00bab6bf672c257bf8",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "4396d0b79fa6b4b573d89eeb4e44fc3bb159ce8ccab868eeca7ec19fa0c8b3a2",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "b74bd02cb9d5d185c8f9cd50a777f4b3f5da23aea1536ca90bbdc1c6349be09b",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "e92fcca81a9a723b5dfd6f5ef753bbedf24df0c36331ef94f968931c0136a950",
  "preview/en/legacy-v1/anthropic_messages/append":
    "0802deb0b64bfa962b90a1de6f0e78f4a3d29a4e232f1305e3735c4556c450ab",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "79394ebdf19e120f10d9cdbc4787b023abc032e73ff799ae0a8b2738bd53ec8f",
  "preview/en/legacy-v1/chat_completions/append":
    "09f2133a3fdeab56f6c934bcd54d5ff6a9482a4ef1cbc5b012635a96a450f74e",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "324b51568a55a132affa0e0f7ea016a5aca80315e47785a8da4ede2ee5dcf4c9",
  "preview/en/legacy-v1/openai_responses/append":
    "6df784054097652e32e0b4a12ec338280f06ed000569eef525704dce0c12ae9b",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "2e9b28920597aaa61c62d538697a7d1da690f9a1483316e4bb2a0f9995e40840",
  "preview/en/ordered-default/anthropic_messages/append":
    "08514de51c339c0228b15d88856ae4357797d247cb92f93510260667b2033e49",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "d91121f79384a5c190742a08b07156d9f956cbb4c97acc7388d3f95b9bdcaf8b",
  "preview/en/ordered-default/chat_completions/append":
    "48e81c2765f707139dffa8b7c73898201c75eb0c8c299a93bd45b008763a9711",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "5a8aa06092324286c78ac267173df9532c7fbcdf53fc8b9e5fb7113fe6bebb88",
  "preview/en/ordered-default/openai_responses/append":
    "55cf926f9978026cb1ca914894870fcb064a62a5e0fb826665adb6162fe7e921",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "3dec8293d4c92190feaba327774629f9d56e00d0665251550c01d1dceba0d797",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "55db769b34f26d3ce2e2713a2bfed42969fcc9067f55508a1c43f460b1408c64",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "2a6d9f84b650751ba7839ac14a8f192faf95b29c375d7b51d292079c8f35be24",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "47880c6a156c56e0fdd2ba81e734be9c67c7d7c72eae3e11f2df1a2ee6202df8",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d184f50d472aae729d2724ce5b53a431f16a070bbb3d322d197700ec85fd0168",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "f606f095d22f1a200c803ad3628203a63aebdf400c1a65f3f005e700a9026c7a",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "83d0cca4ee376b120614e6b63dc8a32ac6b1a3fdfba554ab0b8f4257d5dfe7f9",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "a549a6bb11e67b62f18e3d2ed15dae21d5486dd374da8e45f5f5d67b301e3e4d",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "893653840f1088e68390f9ea9c54925e1bdeff4461cbb8cc9970342550feebf5",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "b1a89755b3c6a2f07ecd0f100d193fe1b2ddaa314792c262023b16d8e09e01ec",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "604353b141e1339a96fa31af14118068c91a714c5bc2234b61130fd4cbca383b",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "2a8247e95b225a36804ccc3b0b4e9a7994b4d7ca68544f79babd18545aa8c2fb",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "a7a2382177bc2a6153ac4f0fa96066a47790b1a72ee9d5a8ec900e4ced1ad662",
  "revision/en":
    "50ad0466eaf3dcce310650d8ef14c669caf84e2f637aa4221be1a0e81041542f",
  "revision/zh-CN":
    "413b05cc17b18d68b1350dc5618c0cad84d724aa6976c673cd28d2c5a8eb035e",
  "setting/en":
    "2e07c6a61807bdf0367d251773e5f602b78f30b3c667144c7186527f5bee5f89",
  "setting/zh-CN":
    "ad042c070ec6e8ee73c6c27d377461a9f7ede5776ed8951f4f2db32736034371",
};
