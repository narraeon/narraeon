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
import { settingImprovementToolDefinitions } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";

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
 * Current-focus, option and authoring guidance (#158) changes the 52 current
 * chain/preview/authoring digests; all 24 preset-free bootstraps remain unchanged.
 * Player-visible character knowledge guidance (#159) changes the 24 current
 * ordered chain/preview and four authoring digests; legacy v1 and preset-free
 * bootstrap digests stay unchanged.
 * Explicit current-player boundaries and shortened turn-guide headers (#179)
 * change fresh chain/preview and authoring digests; preset-free bootstrap input
 * also receives the boundary. Frozen requests are not recompiled.
 * Responses source-aware turn guides (#198) change the ordered append preview
 * in both locales. The remaining 74 compilation digests stay unchanged.
 * Ordered authoring adds control-file and Unicode guidance and shares the
 * play turn-guide reference with world revision (#233). Only new authoring
 * compiles change.
 * Batch 1 prompt cleanup (#245) aligns English turn guides, makes built-in
 * default prose/output wording genre-neutral, deduplicates consecutive
 * same-role provider headings and the redundant setting current-tree boundary,
 * trims play.mechanics settlement overlap, and cleans up option-group /
 * ownership / save-timing wording. The 52 chain/preview/authoring digests
 * moved; all 24 preset-free bootstrap digests remain unchanged.
 * Batch 2B mechanics, history-use-guidance, and base tool description cleanup
 * (#247) trims play.mechanics overlap with world_patch/world_retire, structures
 * history-use-guidance, and shortens base tool descriptions while preserving
 * world-revision shared history_* guardrails. The 72 play bootstrap/chain/preview
 * digests moved; the four authoring digests (setting/*, revision/*) remain unchanged.
 * Saved historical requests and user-authored copies retain their original text.
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
    "64cac0735f28c25e15f5b89153151fc407ec89da5bd995efd9a5fa95a6c88ea6",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "b62e25afe74081820aa355358b0269a5ac42863cb4990d22d3a7a90d6090c6ed",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "2d24b51c96afdf7e7d00b32e25f2d98c4a3c141626cafbe5c3ddd223dd7ecc62",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "d0a2462366c6f017b443224bb87f9bbbfba47b9b6450d92608c049625717352c",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "b280931baced7fd4ab3205f31a924d40dbc88b9e564621a48832a85ab67b134d",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "36d9bda813e34d2a0fe601baca8f5b32e497402ca55b9c71fca7d89d39cca8c5",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "64cac0735f28c25e15f5b89153151fc407ec89da5bd995efd9a5fa95a6c88ea6",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "b62e25afe74081820aa355358b0269a5ac42863cb4990d22d3a7a90d6090c6ed",
  "bootstrap/en/ordered-default/chat_completions/append":
    "2d24b51c96afdf7e7d00b32e25f2d98c4a3c141626cafbe5c3ddd223dd7ecc62",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "d0a2462366c6f017b443224bb87f9bbbfba47b9b6450d92608c049625717352c",
  "bootstrap/en/ordered-default/openai_responses/append":
    "b280931baced7fd4ab3205f31a924d40dbc88b9e564621a48832a85ab67b134d",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "36d9bda813e34d2a0fe601baca8f5b32e497402ca55b9c71fca7d89d39cca8c5",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "f9513c8d9fe284ef6c68bd685c74c4b549562e63f0ffc08dc394d24ff2de0d9a",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "7da311cd0bd4c8149d80d5d972c4a5e0084810f0db012c11263d68cb9f9eb544",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "116a2f6d4fff96cbc2bd193ebef2d2cab1e26cdbde47f77691bb3d91134f003c",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "b2ddf0ec0b5a439d382cde0f23eb93f2bd62bb8bf89444c61f64b5fba17bccea",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "0a1eb4c54b9bf6506724c2edaa521422f44e27f390cb49fc2fb6d695b3e14ff1",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "aca8cbc05b7f19082c408217f40e8a62a23afb3fa350f5635987b1a30e75f186",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "f9513c8d9fe284ef6c68bd685c74c4b549562e63f0ffc08dc394d24ff2de0d9a",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "7da311cd0bd4c8149d80d5d972c4a5e0084810f0db012c11263d68cb9f9eb544",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "116a2f6d4fff96cbc2bd193ebef2d2cab1e26cdbde47f77691bb3d91134f003c",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "b2ddf0ec0b5a439d382cde0f23eb93f2bd62bb8bf89444c61f64b5fba17bccea",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "0a1eb4c54b9bf6506724c2edaa521422f44e27f390cb49fc2fb6d695b3e14ff1",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "aca8cbc05b7f19082c408217f40e8a62a23afb3fa350f5635987b1a30e75f186",
  "chain/en/legacy-v1/anthropic_messages/append":
    "31791352295ecfdfd311e80fcff4fa8aeffb75df9a99473c87c4e0cfdd7c32b6",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "83808198862a09dd3ca353608648e361d2e5671d1b101d042c12896714462447",
  "chain/en/legacy-v1/chat_completions/append":
    "f7cba09e3e2fefdc723aa9e8a6b8857aff455a268fa434374eca6edc0a6ee365",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "f3818d76581a234f067e03b9bc4493013d63e1abd8d5af706207c484a20735e0",
  "chain/en/legacy-v1/openai_responses/append":
    "70eb904354690f47c3f947e6a749b2b4b65d50434d9d1cf028a2b8c155803217",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "b26f5508d5328e8738a09f523cd92ec1318ed995cd85f0f38a5c93bcc30ec8ff",
  "chain/en/ordered-default/anthropic_messages/append":
    "fa74cb8edab2a02da38cca2cc6090854ac043592d6c231617cb9b8b5040ea1d2",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "2c9b88fc44e4d9d30db55d1bb23553f24e4b86e9d2c4221136c65f3adbe7a0bf",
  "chain/en/ordered-default/chat_completions/append":
    "448f21a0835919fa3f76955d4f88577700e440ea2011dc7b02d4b5488366a77e",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "5da57769a360b1df587a9c4f9790af3b1f50c198878d5ac90669958a05262101",
  "chain/en/ordered-default/openai_responses/append":
    "f48469a9ede77e04ec31727c7a09400f1697f102b856378545a9f7de5060ffad",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "e5c20281f99c0c184a08a0c75309d0cd6cad310312aee524f0f282defadc1a86",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "f28d3654655083fe1adc2a824335050b3cceecbee1d5f5b081448164ac0d7706",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "f8e5390b1299692164e0f99d1a7842ad98684d0530970077e03cf715b2a8e3e2",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "122f0d30f1a73870669d066d4d1d5cbc579d50b80f531b8841737cd89a3d819c",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "b2a4d77eeb0b9be5c6ed4048cfb2bcc9446c7d456c43091150497ef08af4bcc5",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "ba2606a29e328218d34194658034ce330d0946abb6a8e1684157ffd7a050c0b7",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "8e8ace56cfb153b7fac9bb3b5801f4560da07dda12f5a58b4df73fcd3a29f9b2",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "7ac29a4cb81dee6f6fde8f1be72a2596fcc25cae97a925f9c4fcd4fac7dbcfd7",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "cfb3fdf060f61537d13ed7732baccb70fd0e74d181299fcea5affe0536bec57e",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "282d4c64dda5b98d03ecd50b76af204f32b534b745c45429dfd6fda773b90400",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "be8a78f81522e016adc3b4e72cb8a6d9cd5fbcd0f25c4405621670a8c617f90d",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "d5e57c73287824f2fdf16db7105b136b7901f87ef9358b0ab6374a6ce638de24",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "1ef8e68281b3416dccc88fe254dbb6aad8c875c96754114724c818de1c2e4a4d",
  "preview/en/legacy-v1/anthropic_messages/append":
    "79c239ed526d401b1349f54f3c52e849e6c2dceb28d7b4ff80ba8556c480a7a9",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "fa43dd3299ce8c1ac314772a69bd233437c73fe8e1a971b44fda2895f02e3681",
  "preview/en/legacy-v1/chat_completions/append":
    "d2e5f0a865debf172566c9a0e31ac482f92d504d9c82f78172d0d1b2b1601be2",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "dacecdbb358579c353caf591d9175965b43e771e682892025a896a9aa5017b74",
  "preview/en/legacy-v1/openai_responses/append":
    "f581a54ff0a8b8d8da1d7cf3bf322f34d2fc4f8640d72993301efffd608dc243",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "e2f32fc40fd78d106548e282d733b3004794844ee31d15e5e929746f286a9726",
  "preview/en/ordered-default/anthropic_messages/append":
    "42be0fbe83e1a4ae4293448a9383feffce54d26d8535025267e8ef850996507f",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "2ecabe99ec2cd32d12045d8af62c9af7b48e4b21b2c8dc246509d61f9b7e0685",
  "preview/en/ordered-default/chat_completions/append":
    "636adb62f5ce171ec433f4a6e9b9ecf3e799c365508246a1c1033883f9eac7f1",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "7df32ab9998fc2fcbf74b424716447611eee2bdc3b8e300e8c6f69c73a5ffda9",
  "preview/en/ordered-default/openai_responses/append":
    "24c294b0578e4d67a8f712eb58ae2086e7b05a756053792ee02daf8975ec24ed",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "0e4650f74da74f1464d6234602009b1bea21d2c9b2f4ed7a7a96e826b45838df",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "8c7ec85f4d3803722c7aacb70eb5c3b1a5c37b3a119e00b71b64bf8c811ed273",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "1531bfe8fef202116cb9f2b56f6cc69b61a33ccedc5fdec0f3adbd814ac5861f",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "556de6b07b4d648faefec64bb232cec3314f1593955768a69a60fd9e63136f44",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "494c7a0553117bb4ee25644839188b0900423fb7e222743fa7ac1d210c1e57e6",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "f248ab3a2149f43318e8853730315360743b1e387f599bbe7fd67c1fec70e692",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "0015f71322e248972d09dad540fe743cd63f77a06da710841c6f2b055f89fb22",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "453f1887a6adc021401437c8ef2e6120d216a1b80ae706c130d5ce6bf20b5f73",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "4eaba5fcbe209db9dc5f4f64690758cc35f56a5dbd22f5e40b1736e5d92d9707",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "b0f0db5627277876325c82e23dc6c364dc93aa51341bfd6c8b6110c87e13cf22",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "013e7d1470deb527bd2aedeb92d0f2d5f6557749123e1e3ba17f37d4cbf20850",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "2344fa756ad5609a67fae82c5c8a4b5740108438c3bd0e6153313f3647de0d91",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "5de68e534f3433a4ab93ff6ee5580b307fc6faa18a9db540c6591077e24d1fe5",
  "revision/en":
    "210062d7f27f32cd66bc449c2ac34432f8e1268bd49b723fc2474a468708175b",
  "revision/zh-CN":
    "f0175d427a23f2a02d16783a73c8fef987369250ada1154a344aa17456df0349",
  "setting/en":
    "084835b327e5228a11cd77a0d17361924c416ee46fee9f3cf114b0ae8ac9c939",
  "setting/zh-CN":
    "c9717e4594108c8e2062276872026a1d082ba6fe7deafe2bbac904e739620707",
};
