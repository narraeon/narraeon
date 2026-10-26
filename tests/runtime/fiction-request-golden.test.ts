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
    "4705ee468f7d8075e3dd0b6b0d1d0cdd987fbcf44cb559518e103af8f4783794",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "a02d313d95e36d660ac94fc0d44e9caa30470ca63a3d13635a072c11b97402dd",
  "chain/en/legacy-v1/chat_completions/append":
    "51251eca5b2d5c2af8f2c398bfedc37d879415e7a9da5dac4b71c2796dee35cd",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "9d9b68c2f2b624e64ad6f3444abbbe8e2bcfc8bf35b3077ee457e53aa99feb76",
  "chain/en/legacy-v1/openai_responses/append":
    "dc9c926a597353a6f388cea513f2663eb9ef861c8584d62454697ee802e0e7d3",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "b667ba2e67c032296e8765c200d23a4b79103fb5fa6e59ce1cc782035031e48e",
  "chain/en/ordered-default/anthropic_messages/append":
    "d17b62d0b1bf0e8c9b11336a2b19ef36f1b7bca88b7b72cac0af36718ca0586c",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "b457e251c6b10b47720f041ebe0488a3ee943443d4bdbac178d73332c66dba14",
  "chain/en/ordered-default/chat_completions/append":
    "f24bf7da1792f6eca70a096e91be0e1b6e59bb8b7c1e3d48d08ba7db6ab5b067",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "03e960912ef33acbb8c099ae3a83b98835977117d4a4f03f1972ffcda94117da",
  "chain/en/ordered-default/openai_responses/append":
    "d4302e61e29772141e2bfc80d8138635744f799957baca8413f903b784acd059",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "acd08c9d60fb61c52e0fdd544c89be2dcbf0a096d9702a1bb44f53fb2a29aa89",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "30c3e1639664de74813ce1ebc182f6f00cde46874989936b3fd6623e30b49b9d",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "08dcd7bafaa268762d9bb2982c77d726d7163f2e29fe3156c5c5cc79ef337ebc",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "cff4caf289f353625b7b261c42521e633dfe7ec18b58a5274f71114626a23b1e",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "b0b3091fe56add1e95fd91cbb735eb6c638fa37f709545f46dba2d07ebf3e8c3",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "61b6e53b483b485368bfedb5e6cad50cd89d973d5afbfbd9d6df78f36532bc87",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "e4bbf2119139462bc205f1583941a0abf8e41d2a8146bc8b03323215d4ec1f49",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "aa89dcd5ef5aff489d58a18210108d1f2d3d0742306ce7f4160730a710a3df9c",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "1ec98c5b1a9df3da6a98b896b98c18c9e213eb2f0518b59d5d02d6ddd572f135",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "8e14d83999d00794ef3c0f6cb10229d1e188f8c91082679b730e31ae5229fa79",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "33c27b2af7e0448bd7f4ccf483870e211a88c182317f347f45de226f61b1a077",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "56de3b5fac172c098bd7974e66cd412717e625fab7054a205ab02212f1417ea4",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "93151f23d2bd75ba05b6749b7134849ea9dd6117da42cf595d8126da1f63ee1b",
  "preview/en/legacy-v1/anthropic_messages/append":
    "b4d25312147479cc7088efc50b196a322735423512a9e80e0b204cf3b9ad8950",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "e3c4e03d2cb22fc62e9aaac0ea654adcadb1719ca12a7cc40a3952f35fd00a81",
  "preview/en/legacy-v1/chat_completions/append":
    "a1156c7b2e4a8ef765747d4e154b294fe278b4ddebf0455b1cfd313d353084c5",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "ba48641e8a9968112032bdd7556658e183a488cfc31be1edd385710636d56fcb",
  "preview/en/legacy-v1/openai_responses/append":
    "1b66509339ed6da0856036072e5ddbaee13efcf733b25a6aa252253f775a13af",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "59bea884214e5efa10e6e019f45b4e999e1366bcb5265a597a50591f2696ec02",
  "preview/en/ordered-default/anthropic_messages/append":
    "10af3b786b13fb5ab487dd45277d0554225b30082863e82d6df7b8080b70d85e",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "b4eede8a024d083791d0f1092e7fad528b68c934491b687fcdf4f47a5b7d2439",
  "preview/en/ordered-default/chat_completions/append":
    "fb3c6c7a598e383e85c674c3d7854e0dabcf38a4d721249e10bbb239d0f83a05",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "bec845fc1c2ba98fd85ca8dcb2c96ae79405734bb7f6f556a055a4bfeb6a27bd",
  "preview/en/ordered-default/openai_responses/append":
    "2cf8eb0709efca5e611fdcd8c4af3ae9efc8a546d9c7c2d7c8ff25ec63c2f8e3",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "77eef2e82530f532f340ca2283938ad82ff25215f18e583b57542396b5087eb3",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "c723e618c676a1e83e6c99b0770356b5047ed7c96cd4be08f7d54c8cdd875e0f",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "27586d12862d3daf2e0266bb9159df913d37e7856a473ee99c0352c90c3b7336",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "2678c3c173990af9e003cf10ce6e1d054438e05ce480adbbdf214bd4e9f9a7d6",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "68c0e81b556c188717149fbd6ac2852f6393d506eb5931985251972bf13aca9d",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "07b790332ebf5fff803b94fce7c03304cacb35373836ba45168f6a0f2114ed30",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "5ba3aaa8f109fcbbded42e39f0a42552c0a4d774c743e61861924ba41d1d224e",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "a5d700c9c56e522d31061fa406b37e4e37c3131891490718d5eaad95fb13f613",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "4f4f120256518f2b80bcbf28b86bfa3593016f4aa4febf75e74647c392b6158c",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "6a32f9b0a75aab562aeb2ce81c90e21a1e12888f16df7f6a358f4a46f9e36b99",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "5e322c609b286e870a2a1426eecb628862bae788c0a644196412fd09180281f1",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "4d30f6789f98bd6a51150e221a3f393fcc7f684cad3d8aadac1a33c2dafb64b9",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "64af900e39fba4104c8def0621d647d7ea50549e32f0d9214d66995ebab738ae",
  "revision/en":
    "c0a51f96f2c2efcc6dbb00f2e686eee45ab533002f21301cd51401da41ade12c",
  "revision/zh-CN":
    "b60dcd86dd9aec61c696de231e66642ce8951cf6944ba5b8ac1670f0bbee76df",
  "setting/en":
    "a423db4f69fff506a4f2e98eaad584d8802165972e358c2e49ae850dd071f7cb",
  "setting/zh-CN":
    "c79ec55ac76476e352293b4dfea936377303bf0a781381abb44f706d5a679a34",
};
