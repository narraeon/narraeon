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
 * branch (45ee767). The digests below were produced by running this scenario
 * set against main. Gameplay wording (control/gameplay.json mentions, bag
 * guidance) reaches the model only for tabletop worlds and packages.
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
    "55b47b7958b433693be5aab0ddcdb491a79b4f0d25c196fb53daa367b21acee6",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "0ae86413cd599dc12a27dd8e26f999e1092515d8ff392c8238842452d4bc6fd7",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "f95eae3b6cdc4e270f5eed81df3f4f7d5ef844c7b4f1cb2bd87e0a146e8d0621",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "f437366ae47ecea28288017317feb2430aeab545a50e12409dd2af25859abc7b",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "53a8edc5cabb964d1e961950144ffe9e41a0bb2d743a48e3fd0f53d471929e13",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "b8c512b5261f684f64d61118bf88ce0077ac56becc4b1a7e3aef230f93f7ac3f",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "55b47b7958b433693be5aab0ddcdb491a79b4f0d25c196fb53daa367b21acee6",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "0ae86413cd599dc12a27dd8e26f999e1092515d8ff392c8238842452d4bc6fd7",
  "bootstrap/en/ordered-default/chat_completions/append":
    "f95eae3b6cdc4e270f5eed81df3f4f7d5ef844c7b4f1cb2bd87e0a146e8d0621",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "f437366ae47ecea28288017317feb2430aeab545a50e12409dd2af25859abc7b",
  "bootstrap/en/ordered-default/openai_responses/append":
    "53a8edc5cabb964d1e961950144ffe9e41a0bb2d743a48e3fd0f53d471929e13",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "b8c512b5261f684f64d61118bf88ce0077ac56becc4b1a7e3aef230f93f7ac3f",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "a1b47ff39f441b34d7a7cca16dac790f99b150905b67d2c5f9183f295be079e2",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "2a4bdaef2d4d37fc495200e2375f60a31b43bdf77514edd467c742f41d86167c",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "8909d32fc1432dc0276708d3a07f3b16b90570f99831d07ddce40c3b0061eefa",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "f92f0e0f835d4defb22d93fc27389262cbea76f633e961a2c1bc8b00bc82009a",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "3045245444596081ad426e7e83cb1cae2c9b9237207989a139204f90f379a208",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "a928f7a8042964756d6ec2cdc2e3cba425caa9e0e1eac71d1c5b7dfd56cac6e1",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "a1b47ff39f441b34d7a7cca16dac790f99b150905b67d2c5f9183f295be079e2",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "2a4bdaef2d4d37fc495200e2375f60a31b43bdf77514edd467c742f41d86167c",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "8909d32fc1432dc0276708d3a07f3b16b90570f99831d07ddce40c3b0061eefa",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "f92f0e0f835d4defb22d93fc27389262cbea76f633e961a2c1bc8b00bc82009a",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "3045245444596081ad426e7e83cb1cae2c9b9237207989a139204f90f379a208",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "a928f7a8042964756d6ec2cdc2e3cba425caa9e0e1eac71d1c5b7dfd56cac6e1",
  "chain/en/legacy-v1/anthropic_messages/append":
    "a0e0c236bbc5f7874f1fe177543024535b1481b2415e2347aa2a34582197f8f5",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "d8eb0f676fca5a1f1a838ee57961e3a81a04d334179c1d26aa04d6f07bfe0afb",
  "chain/en/legacy-v1/chat_completions/append":
    "25f94cf4e7e26354a20c36d4217988d189db8092b313528e9a41c66f3ac55cd0",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "11d9a7818c7116b19a09cb6c7953c0a2dcd92fc9a7a97f49a59aaba3d1d3e499",
  "chain/en/legacy-v1/openai_responses/append":
    "11af4b867e6b06b79508c00e9e1c1889932c9ec4df2b2ae3840695ff75386ec7",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "8def13eea1b9693611aa70fada9535e5cb17d9e222c7686bfbe57b65386068eb",
  "chain/en/ordered-default/anthropic_messages/append":
    "ed533b797a4886db4aa0df21ca16348f0fdad6e3c5bb27a72b92727ba8cbbdb1",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "f1dc0713099bd40012a23e1de82d97902fc45ded3bff1ebbeb7e89528239b57a",
  "chain/en/ordered-default/chat_completions/append":
    "3abac5e1f2045f2f240cf7d4109c5987277e7fd83c98575e0ee5727c420042ba",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "dbdeaa00d218423feed74742900fe69b99009d4a9fd681263a5727a02a568090",
  "chain/en/ordered-default/openai_responses/append":
    "94df39b44b6d509ae6d037fea5b472298c3d7dbdd81fcee30d0cb8ef2438cf4d",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "4aa42cc761a2c29c9d81b4dbe1ad71db88364b16c669e2eb579f8f78ddccef58",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "aee46f5e5b3cd84f53d749296d917eafd1a1898b553e1a67a19a5fb1f4932fa2",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "ff059b69d922ec01623b14656c592a3674370b2058d40c23028ea462cade9d22",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "acfce28ef4fea57e9f954ea7c649b7dd19c16f98cc7fbe48674600be9e1b58d1",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "25d73592b3f819d3bca243dc26e78028512dd76ffcc742d6db2be588648ce000",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "5448f3f36681ea5e3121c346a958ff995ec5f1206636425cfcf71f79c487a7b8",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "4a2ae8c6813a48f313f8c6e75e188ac8713d3e669576364939bcca50391c39ce",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "15c46209a4955524f92e051909e6c5618c1ae7ea12756f88100801b150645646",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "f4061ec495d0a20887c49da70d6b14ab0a9c0a741e60fc9e5e8f094943f241a7",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "e81a3e4f6e75f97480480a1f6e5ed44eb529bb8a8f625ffe84b43f211d7931cc",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "dd75b2c84cf4f2e2c84ddca412e4a78212c75dd980122e4d14c44c1aa9c6d1d4",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "d752e29025f4e072ad09235edd141a34911a2958bec6d58c90b0e0b044229333",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "8c802d1658ac46d10d3b5e1418e3722fb64dcf344766c8b69c4f10ab8e26a032",
  "preview/en/legacy-v1/anthropic_messages/append":
    "96c561a506f79bd4ed5d99cc59edf263fbce0be478717a30b0d8ba684ec6bac2",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "dad798d5aa1891b4a6c4ff8654aadb541623ea367d43a171a50052ee4f6e49d0",
  "preview/en/legacy-v1/chat_completions/append":
    "9ac8868d76e9b79c24fc1c2cdde6f95e1e9661e3c39d3599e15498a55e69e0e9",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "847fd2512a245cf142307c5cc4bb6b9eed72198e1e4b2a0db4bf1064d84177ff",
  "preview/en/legacy-v1/openai_responses/append":
    "84ad6b5042d21e7695a8f1aa57f5fa54b6138d0557d104c09e89d34f20ac440a",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "be25ecb444d0660b3a6761ec479f48acc05ed43894cee21f2fbde85d262bb36c",
  "preview/en/ordered-default/anthropic_messages/append":
    "1581f598d9b0d7140fc7e13a8f6a049090a894994322f7cc7a0b202b41a90500",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "ff9623877b1f62f6022769fb99104fee4e10aaad58c4ce56c745ad6d44979ec1",
  "preview/en/ordered-default/chat_completions/append":
    "b147a09eb2b949bb1a29099a4ac09944aa785e2642de4df9bf3e31c291ea063a",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "2913aae3eb65ff3e33e2312c6cf5997d27df2450d9199ccd1e06454b5cfb6524",
  "preview/en/ordered-default/openai_responses/append":
    "62000fd676e5448d2207d7a76c859f7fa8f5ac387f8cdbb88e81083c584176ec",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "f974a4d6b76f1bbb9e8537127fec41992f21d784577d3d0eefe55d72fab735ea",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "41b302d6d35e4fa79241c4d47fc4a202685297715374d2e7b8d12e183b10b13e",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "addb10d54ebadf418e13a3a2fb356fc6e18705042a5fbc4dc6d3d57bdc83c813",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "b66770c891ae0029a57ee377d54f9f80c067847b69705bb0d32d9b96f0ca4d9b",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d7216dddcf3791e15a5b56f79b3e546be5f20d1b1786c27b8a7e7f19c597a4c0",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "71db3d8e2949f9c7cf7557e479b0123a0e7077ed0f522006b7c8c5ea45f55f0b",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "6524954660965fd5f87bd8aa4fec0b25a1bfd55556b48a1767dfda1d1c05f8e1",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "f859b3183b5c42df83dcc389e966a7df0fc3ba67fc160d4d679fadcbbe498da0",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "7fc643a941ba43bf989ca39b33818f7f487e7030f216e21bc4e76c9dc73d181b",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "77c74f7b947f0c34a012afc69992d932984c45f31b0eb0f9426f1e7d69240bb3",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "0b7e1c062ab1861bc049901bee5f098437a228665e00e0efcad28b94a98e652a",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "248c14dd7f08e03e9fe1c771e35bbd8c5705f5d4ecf60cffbbf0b8ac53cbad61",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "646db33158f50cad0d9c3203a71a81992c363a95846fb9287e6d22d0a990a7ca",
  "revision/en":
    "5abbc35a3e641d237a6a008a07d49afc134c5c05f3793eb1f411ea80094819f6",
  "revision/zh-CN":
    "7c153e4ecc3017e2d543fa1ef3700acc63b9ee1c512cd2c24ea3184efe0f5714",
  "setting/en":
    "0d5231de8c6b09f878e0949b549f2e7d3237612d0b55b9210f6e58ab42a91d2e",
  "setting/zh-CN":
    "38628ba1c135c69e448be936f275f2a4d91e2049d366811023072d32daae33b1",
};
