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
    "e6e7d00d9ff5b1cbe9e9ad0b5d5d7aad902257ce2e8428516f98ef793adc3e6f",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "5f35b672721856af7c6b4be82a930f4ca1def46187bb6edcb8a28957021bb9da",
  "chain/en/legacy-v1/chat_completions/append":
    "ae0d194d44955d073d8dc405424d8b8589b929821542de8be2946ff94ed417b6",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "09a44fa52a8b20fb69a044324a5cfee39d7c730b5b08ac8b6198e8b6838318da",
  "chain/en/legacy-v1/openai_responses/append":
    "733f11c7ddeddf88ddf72c221d9acceecd0b64602b034d3786b3cd267fbdc081",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "de6b6657125b66396e45910b955f41c5c66fc0b219a4436ad8c574a038b10ffd",
  "chain/en/ordered-default/anthropic_messages/append":
    "7bbd6b6c15966432fbe538f522ebb9db1aa8f97869d61680f7bc1c8e7a770d42",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "eac3e78eb53a01e5d665a358bc957e05117e1a491a80afd47c04090036e2e847",
  "chain/en/ordered-default/chat_completions/append":
    "8d82b08ed36b050efc426576c4d6aa28645546a19f55b08fb36793df8f3ad859",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "77a1bedf24f9048f58da24eb44b73d5001a6f499dfef69562b161583d45a64de",
  "chain/en/ordered-default/openai_responses/append":
    "9a237ce9fb6901fd005e449eb9220f4e2c78cbdd62af3ba7a86cf6f2263f55fb",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "e733c0a4fd8939e6a73f23d5cd74f5bb0dd6634609bdb60cf246efb220255098",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "1b9807ff5f79cba1880a30ad48823a96ceefeb401a492e1b565ec4aa0468be4e",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "d2298915ea02aae58e86626fe0d6f462b1b664d4e626a86f5e3b39bb5b996092",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "8e236f50f652713fe3ff27dbb641500b40a6bbf1c300bdc344d6c6b0991f743d",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "3c801545d8f9c024d53b021d22a1947b320a6945242de6830bfe346ad6278eb2",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "15843ad62e479efde87bf611091f80b850db4694346f25c18b4c0110234078ad",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "8408260e5560d36f9aea67e0da6d34ce42cb9c77bd5da738623750e6232d6ae5",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "ee0b6e1b1ac4999981b82cacd203970cb42bf1cfa3fa737a073940fd72b9494c",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "4330d86f12444db579f03ed30841d9f0dfeaa17e9b553b1a74656bb22ef9b14d",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "aed6d4fe8e39fd239d2b5e8cd264779fc361383f4a7941d751ddf13607f941a1",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "756635d26d42cf44b03298e5bd01d6970818721e3ca7f35c29d5b30feb371adb",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "a0fabacefae226716bfc536b0abe77def73da470561ce3d18ba23269aa4107ac",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "bf25a1f171c43274553beb86c6b4cf84913bb84ad807fb15fb655586dd4edaa1",
  "preview/en/legacy-v1/anthropic_messages/append":
    "fe0f80df3dfad33f8c527b769f4bef35e3463028d5daa472eeeed8c5b6fb9da0",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "b474465bcb3e90db42addbf965d5e3388b37ba414bc4b25be1ebb8b4687c4a3b",
  "preview/en/legacy-v1/chat_completions/append":
    "16b2fae17529a2a9714cc08b7b2ae87eb2a1786330bb09d9d5faa959477fd83a",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "292349b451c820e2685411fff83d463cd51056b8b51e19e35e2d3e4e13b77903",
  "preview/en/legacy-v1/openai_responses/append":
    "3348c157f227a2fd22fe6ed9f944123abf053cb215956b10f81b899a560fb790",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "a2b82916410c45b1e98c5097d5cfed8cd819c03a6e8bf3c5e7bbbcd777edebdc",
  "preview/en/ordered-default/anthropic_messages/append":
    "d24abc64a0b67f841374896be404950497e1b4d8fe03bfb25a61cebeca95c27a",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "cd5838db960a271866b8c571a84a5b777ee5ab39e2569004d61adf79571ad16b",
  "preview/en/ordered-default/chat_completions/append":
    "b0c5f28da75182c80cc4e2c289972d24d73a3e38e320644966397fbe63ae6a43",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "7663a087a806d3b1358cccb8805b8b1600e40f6a2c0a99aacb77b75b9d5c1af6",
  "preview/en/ordered-default/openai_responses/append":
    "3107c25711af27008538746c6e3a00a61d61cf73047b88e7b6e4095f155e1d0c",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "fc55bce6abeda5136e4e6ca4457f50b2c3f9f1efbbb3c0060d1bdbc9048d38ad",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "b3cfed58eaaac09592477a5d95f030ed1db76fd1f0bb2a6bfa9b94970df39b37",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "82f6521d1f7c31d8506a0313b4a1b607b6bcfb66086343f923ed0b535819b22f",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "812893221293905a33dcbc799a5e00a04a77b2194cbb4eb3de26bc0b884f8aef",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "41f7240f281e6b066624008ed37b2807ea54029f2a44d1cb4b468c281284c110",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "cd5a6ae59a0049e1fed7b8147a3bf5bd2878f2a31fd0ebd5072f13e9717df017",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "8d5978f788932b69b98ad79f2f5058f6063a54bcc1da1efa559fc2251322d6c5",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "4eee19a291e296293a36a07f4b74033dcd0c9cfe91eb5773628f738502a80d54",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "0c9f99c8bb5c4c0ef42a1f05670b111485b96b23d822f4b067d4de9e4cfb14c0",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "fed7c41461c91a523edb6eb3782b4713fc94fecef17db0fc00f53a2a58a9659f",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "b3ee569f1fc335ded1b8db8920474502e02664c08f48d37319252465f5530b5a",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "cd60988622326be28f333fdfef3133b9232af73243be31c40f15c242bd736153",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "9f9db844bc42e7bf2d76e522843ec31c37f4e6d20f0258a1e5b1ce1dfe61c33a",
  "revision/en":
    "50ad0466eaf3dcce310650d8ef14c669caf84e2f637aa4221be1a0e81041542f",
  "revision/zh-CN":
    "413b05cc17b18d68b1350dc5618c0cad84d724aa6976c673cd28d2c5a8eb035e",
  "setting/en":
    "2e07c6a61807bdf0367d251773e5f602b78f30b3c667144c7186527f5bee5f89",
  "setting/zh-CN":
    "ad042c070ec6e8ee73c6c27d377461a9f7ede5776ed8951f4f2db32736034371",
};
