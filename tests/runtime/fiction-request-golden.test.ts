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
    "c8a5f51d16506758e746b2b13d4a1724730f24d2fe27262f5d0721d350158832",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "dd9505490c17e0bf666745151fc021c91a6a324a25fd12f6deac8306d01fff7f",
  "chain/en/ordered-default/chat_completions/append":
    "1d3ab8c69322ed836acd1552a60e17c95cfa7cb29e4d738241831aff0a8f8b5c",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "53d933dcd7ac564847f2d66fee44831c6233fda30e5f92cbcaa2615523a8665a",
  "chain/en/ordered-default/openai_responses/append":
    "4d7d44785da2049172aeeeec6d0be15db3f945ed04a7cb9646ed2ff2b35f43ca",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "ceb304cc5cf9102fb2d8b7be854afe34a7b91e0286da36f9aa7e4660aa2b936e",
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
    "d5abd4446fde6c051cd3d4bb6cda2a5ec35dd73f472ea2cf0d62775e781db34f",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "6bf9c44e66ed7e87abba7247609e9cda266dde230d79fd87717d2187ab5858fc",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "90a416372b0900b0c1763d8dc429e25595d9240b899a14fe2778dbd49ff63267",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "6a6756598cb0fd508debb7f1bcb5df4817c0bfc5c2c718af076d82d64c3ca310",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "35edddf33e35c6ce7dde06dce5e23b698032be80f7b6a41dd10399459b37aef6",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "3e94393b0507b067b5cb10357fea16132a1aeaf025d1412d829b341712c45c81",
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
    "ea61ce17e986835d8299190899c92f4ef9ad71a501e42ecd754ca56a610439eb",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "205b4f9a6ee112b67ba97a0c7dd4f20a27d0f4c40e5408d0bb0a57400e2f787b",
  "preview/en/ordered-default/chat_completions/append":
    "2dfba454d9c4af89b2431d8febd38de03d51b444670fee81fbf37fc3f1934a22",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "5e71a46571feb9c91de1a27f5745a42f3ea159d03be7922f6ab2f379b7156eb1",
  "preview/en/ordered-default/openai_responses/append":
    "47a514e111a8f537f5f3c6dcd8e0db3435f108d10fd09e6c9821f333da430ae7",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "50613e0d0b85c9e803bae8d4aab0bc48926ced46778105bbebbfe07d89e3a48a",
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
    "1f745e72b2c35f267f65768a2f00b701ba94033a1e9e161654847433c4b2cf74",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "29c98c520228f46f0f29685143ee6e9cadae6f809dbf94bcebb186099e0d3647",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "aa28f24218da190682befc805c7b95654d758af7c72d8760864f016b40752904",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "9e5c40192981f703c4071fe5d229f92cf7deb3b336e3df39672d2cc2ddf295d3",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "7da194943973143ce2cf02c2fda7681bf5f4ad2ef9dcf34e6134f550613b1c88",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "642623a808736c0636bfbcafffb17a1167c8cca6b89ec2e0fa99597693be915e",
  "revision/en":
    "049142cbdef6c330a731d413d3a216cd44c7d3a817ae20c4bae3dd7e470d15fc",
  "revision/zh-CN":
    "2a7ead2eb2d58a8736627624e4290f9cd266253d8e5af789cdf8259abc02b25b",
  "setting/en":
    "e17787e81f9108096859c167f9c3cd180d242d4c34ff28e4d8b4a3ea70b1aba8",
  "setting/zh-CN":
    "1884c5fe8499a69bf3fd38e9e8c4077afe336c34fec415ada3529dffa362b20c",
};
