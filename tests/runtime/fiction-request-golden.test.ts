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
 * Continued-tool settlement guidance (#157) changes new chain and preview digests.
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
    "30517542d52b5e5f041b31bb3e74e70ebdd3d3c94744f2144713153f793d4c90",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "e0c2fc4d8a525ac90e5dcd9234d7c67d1caaca1b85b601f11a7c2afbf1f81c09",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "1dc5472d4bf884ea42cd0b19421d5e21e3020903e709ab099b18a3390da1ef77",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "0f69f6ab30de5045ed35dfa65203b648803271442ef4d93b5297b28d21fa69db",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "30517542d52b5e5f041b31bb3e74e70ebdd3d3c94744f2144713153f793d4c90",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "e0c2fc4d8a525ac90e5dcd9234d7c67d1caaca1b85b601f11a7c2afbf1f81c09",
  "bootstrap/en/ordered-default/chat_completions/append":
    "53f60b7d7dffa195da9f8b2333579cc44056fc957bca2f3244cb858a17542721",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "1dc5472d4bf884ea42cd0b19421d5e21e3020903e709ab099b18a3390da1ef77",
  "bootstrap/en/ordered-default/openai_responses/append":
    "1d7855bdb2accc440ddb91c966a717278578de80e7383e42f298dd3a2d87d22d",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "0f69f6ab30de5045ed35dfa65203b648803271442ef4d93b5297b28d21fa69db",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "a48624d7349d9539e766ba373c56da904a5b76d6d03a6e8427c97f0dd330b7e9",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "c19e74638442b01b6f8e5abc9d68fd0d47e3d5545e9ab297485f0520681965b2",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "7271e8e3a58c20ea4c05dcbff005e833237a997b8338bc9a3611a366afd57f1f",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "f2c8277f3c77235e5b312e40d72b0b9ff6c74d6886abcbfae328eea2e822864a",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "a48624d7349d9539e766ba373c56da904a5b76d6d03a6e8427c97f0dd330b7e9",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "b18638f8d4427e3142e65964fa444f5b0b275cd903fc5fa0a20144f4cf3bdfcc",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "c19e74638442b01b6f8e5abc9d68fd0d47e3d5545e9ab297485f0520681965b2",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "777b632180faee595cbf1dd493e9f41aef54c7c4f690dd25e0d48422c9f10848",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "7271e8e3a58c20ea4c05dcbff005e833237a997b8338bc9a3611a366afd57f1f",
  "chain/en/legacy-v1/anthropic_messages/append":
    "3eca757f4bce3a94092a9e2d0d6a524a4f21e07eb0ef2a2047d4ef976a59d9f1",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "8e636a317f8a314dbdf41f954920eaea14522fa7f80442b9cf6be2ef6c313afb",
  "chain/en/legacy-v1/chat_completions/append":
    "03119f9dfd34dde24284c71a9c5b6ff218a4b52e0c3917db9bf61812fb60fad4",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "4364b89a3faf15e635cd866c824204f9163b12f048adf63513017f2b6d105087",
  "chain/en/legacy-v1/openai_responses/append":
    "3b63a6f9845028a48c9ab04f8ef26bdee7e20fccafd7f0f973013214267614fe",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "3c5e044164577b934f919b8d55edefc1809873cc5d8ddad87c39edbbc81bead1",
  "chain/en/ordered-default/anthropic_messages/append":
    "2fc988b95eea4e4fe7e36f86410183d3f6204b94b24367c85be1c28711471766",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "37a085ade2b4e32c7b49ed37cf75b7e731594118a858e3d6bc109b293be78303",
  "chain/en/ordered-default/chat_completions/append":
    "a6d41bb6d87ac45f0c1cd6d301ba97765467f0d9afb2ad8b00e0c95e03fa1ac8",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "a8ef9cc7794fdd915e6ba03657a21358d1ffb4ab3de31de8ee52805dc34228ff",
  "chain/en/ordered-default/openai_responses/append":
    "9e935466c47cf6ceb6363cb984d5287d217ecf82cdd88cde3d7a3725f0835bde",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "cb68c130e528a735bc2957fcd0f724a4dd801f7b9d45edd4371bfae3702ebd4c",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "7926b86e8ae2c4206a727fc6ab0803b5535dcdd528a4cc3a3c8e57de2f08d819",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "f7de8065f57e0e711105833314053b0001e98e30acdb142166785f95418892c7",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "8ad7969ee328f80ff8111d839d17e652ccbdfbbda84c1567e8aeeaaff4f10b7e",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "711269f8747da54003e76a277edfda225151cad8b223ac90459c0bdd2e67625e",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "aa51c8664e1be49e42aebfe246b30a22c04a1f4644d8986f76b5b7949b422af9",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "c1b69afc0dcfb998b649e032cb46db1112e63fb01a618e3b3e2fc4ccb099b042",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "a514dd33857eced675085fda7cd91a3a1b870ee180efa8e4fa8aed2d7e111b1a",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "614d1fdc2d95426d930f5c43fc9e842702f59026c036383180ae66fd74662e22",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "d68e2643d49bbfb6d8b8c726e950681423d9c1821ca8fad862396b4016518548",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "6aa1d092296a1fcf6a3dabc2b820628118e40f26642048369f9b0b25695d708a",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "c3862aa236a5f557be895a0a2597fcf7c18ec28cdc7c8c83dad4408ab457d79b",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "b9bfd461b0bbd239255487d77c26f98ad924c27bdf6fb2a09bb3823cdf50aa43",
  "preview/en/legacy-v1/anthropic_messages/append":
    "850423eeae521054584d39366d6e4844828e5f614a55ec7194654e05f1a439b2",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "f5ff4ca0216617c3cdae7c0c9b1e8caeb54f39ce907195e0bedb339036e2a450",
  "preview/en/legacy-v1/chat_completions/append":
    "8164356ce91c7951637811a459fe8ef0ea0e9f8914a88bdc6f628d35e0e47432",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "d504b55eed37aaa2eb8fad7834e2a30ebcd55aed5a3d5d691d03065926df456a",
  "preview/en/legacy-v1/openai_responses/append":
    "d9314cdf9a3d20cf61e02d7c5cd564f6abed7fac3baef09db2ca97f35c6a73de",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "5b32b3996e313e58016f9398cb712135ec233128f665301ad660a6f8a3dfef39",
  "preview/en/ordered-default/anthropic_messages/append":
    "b7d096b817c9590133b46548935923813784e3646a20431bad04320b59aae76d",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "5edbaff407ab4dba5db1cd24e07339cc4e269a98c0147764b56ac777b4b54e58",
  "preview/en/ordered-default/chat_completions/append":
    "371f6affd11815d2eecc1f288b58c3182978cfb4c33648f53d276011d2f6547b",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "86fdff2168996e3db0b72e26bebabcd424eb5d9858c5fec70de321ff2cf05b51",
  "preview/en/ordered-default/openai_responses/append":
    "329961415991da14d050242fea216837ce79642b1e0047d650f55282e073d5ae",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "d8195b6b61bf4c2126487999911ada5d5a76b992a1c15667231817cb9cfb8bb5",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "55bd601bc0733097a362a49511f5e7764aa43f799c42f56621d377e4d4a105a4",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "478c6c4a859c084244e98bc6bac3461ea9ad9635cf3ca48f8c889d6796c63c3f",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "74939644d1644da8458284a4cf50603a9d3300e305981e5b43ea4807e430a29f",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "4186155c93f0d421a2f1074eef7c8cfc7436e9ac45301b7e023573de2039fcc5",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "1a8a6a12fac075945982efd989004e3c24b332bc516b789b4ac0716e8691e572",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "d7a0a8e3e90d3c50c4191e2629044295223329e4d090ec811cefe2fb4d4ac57a",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "7563b65ab13f551558ec213aefbacfd78c04af7dd734de6f62968751457451bf",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "41cc0edc45d01a0a9a9290b84f6264a66261f50b7c4d76347505ae6fb338695c",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "e42a22b3593366864e6b0b4290d1aa9a7df59427fef1e14fccc93e857fb2b5bb",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "789273af41974fb2698c94f9822598f6034979a6e11ad5964d201130eea3c0e6",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "09e0b47bf82bfd9d6834e241aff448d85df7b3a2704ab8702eec327a222da873",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "d992a48b7f478b20ab32722d90e754a69bb6e6aa041171039b97cddeb9c79297",
  "revision/en":
    "50ad0466eaf3dcce310650d8ef14c669caf84e2f637aa4221be1a0e81041542f",
  "revision/zh-CN":
    "413b05cc17b18d68b1350dc5618c0cad84d724aa6976c673cd28d2c5a8eb035e",
  "setting/en":
    "76727fcb881ae0e0957e9e5978a2dc2666cb21436f23c54f0a0b557eeede6fc3",
  "setting/zh-CN":
    "21ed52c5a9b2a097b6469dddf79e89ffdb7f4f1001df75bfb340badeedea80de",
};
