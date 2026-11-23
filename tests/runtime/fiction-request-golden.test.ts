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
 * Batch 3A authoring play-reference summarization (#248) renders enabled built-in
 * play blocks inside author.play-reference as concise boundary summaries while
 * keeping user/cloned blocks and active turn guides verbatim. Only the four
 * authoring digests (setting/*, revision/*) moved; all 72 play digests remain unchanged.
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
    "6e0c29f7bc0ee449353308e172f11133269d25dddf5340e0ed475495184b5387",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "219d59d124dcbba772d6eba62542c84bdde5a6bf2132156f48273d49cb2c1b26",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "0d6bb9c7c7ec872b7a60a9d6f0fdab7a6d5b989bea1e5d56aa3bff103eda759d",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "37cbb8d34c3847e5da2454f5f7e9b2245241d08645675f86c6ad1c0537e04abe",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "c8d04e0ce95dd2a25dee430bf475d303457913fa632f401ceaec17d45023c9cb",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "ae3db5b2be90b78381256be3c7945af38f6322640ad10e972ac15b6040032cfb",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "6e0c29f7bc0ee449353308e172f11133269d25dddf5340e0ed475495184b5387",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "219d59d124dcbba772d6eba62542c84bdde5a6bf2132156f48273d49cb2c1b26",
  "bootstrap/en/ordered-default/chat_completions/append":
    "0d6bb9c7c7ec872b7a60a9d6f0fdab7a6d5b989bea1e5d56aa3bff103eda759d",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "37cbb8d34c3847e5da2454f5f7e9b2245241d08645675f86c6ad1c0537e04abe",
  "bootstrap/en/ordered-default/openai_responses/append":
    "c8d04e0ce95dd2a25dee430bf475d303457913fa632f401ceaec17d45023c9cb",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "ae3db5b2be90b78381256be3c7945af38f6322640ad10e972ac15b6040032cfb",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "dac51d2d5c2829868f7960fd10e7dbd51b31d6c315f2e65790bee62bf4072584",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "12ec62d9d202af76353745bf116aca39de9da19f97596ef3939d2023b6444f05",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "32f9454e53358fa52da8827a615997f9eaf1ada3fa0b3bb11d1302192cd8cf36",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "3be1285250c0cb924711d8b059e35812011fef6b68031b5faf8c9799a582274c",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "7fe0f31d07c89ecfe6f0e88df723aee256bf15ac99e6add88c41a925d84c963b",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "78e67e9e41c5e4baad76c80172286ca6ca8ecacc8515fecda9060628bbb242e7",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "dac51d2d5c2829868f7960fd10e7dbd51b31d6c315f2e65790bee62bf4072584",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "12ec62d9d202af76353745bf116aca39de9da19f97596ef3939d2023b6444f05",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "32f9454e53358fa52da8827a615997f9eaf1ada3fa0b3bb11d1302192cd8cf36",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "3be1285250c0cb924711d8b059e35812011fef6b68031b5faf8c9799a582274c",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "7fe0f31d07c89ecfe6f0e88df723aee256bf15ac99e6add88c41a925d84c963b",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "78e67e9e41c5e4baad76c80172286ca6ca8ecacc8515fecda9060628bbb242e7",
  "chain/en/legacy-v1/anthropic_messages/append":
    "afc842c6e328338ed8aead12724d3bab49d5c12ecce5f6781a170cbd4f1849e3",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "69d820780941f00cd9df269f01e236b6d71eb3928ca22174280d2ded131736a2",
  "chain/en/legacy-v1/chat_completions/append":
    "2db240583bad49c3eaa026dd1a0d09e6ecf744d11d5d2e3a1484948df2515ab1",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "14584eda5ccd27f4ae9a65fb1d0c73cc34993fe74d2c3092fc20d6d2f9fb6cb6",
  "chain/en/legacy-v1/openai_responses/append":
    "c5b90ad8bf0967e18aad7245f101635d6d771ea455b75639c72351aefc7c5b79",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "fb8b4527ca75e0052fd4a29f3f04e1529fb432e5be5c37d8d2c484bf7591a5b3",
  "chain/en/ordered-default/anthropic_messages/append":
    "e1ec49264570c5942ae3081507011da1bc984a3b1603bc386207692f47de763f",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "b91de21ba65607d0a71802ab876e9c230a647af9501ccd88df86ecb4b54275b1",
  "chain/en/ordered-default/chat_completions/append":
    "dc7854e3a2b21de4adda56ed36aaaa720d706af145fd91152beba96ab4647fb1",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "8889e779fdc4cc044884a9f3307887e6025db29adf2be70c1a229cdbebda2fb3",
  "chain/en/ordered-default/openai_responses/append":
    "246b48a964176e488d2109ec150cbd2776f9566622fe521fc9d5a0ba1ba20e39",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "6b92ffc07367f4e05f86b2bccf851f398b6908fb54dff3413b0cc5d6a0f9da15",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "1de5f91897b64681344cacbd0feed26adff06d1754b82d544ef9be5801bf6ca6",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "913751414454b23c68aa9ef0705d0957c14c603d24ca69953970ca1987f79c53",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "f41e347add00136f99aa27c800732eca12659fb7795162c3f5cae325f46f5da6",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "9ddd2a28d08598cb0ebeba1a5b14964f069517ee372e126286284f2e2c088334",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "da4c3cc0782c2e97f375595e23d39529e8eac84e0fbb6ec1875a259060fbfcc4",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "a588979829b28f41ae846ad690cc1a2a7ebf1c18600716909123178fd8a6c092",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "f69b0513a9a30331ef6b9e14a90e5931c53e1dd45424a42d10e245ac309e0351",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "80df96f3db1d8709aeb67cffab3c7ec9103fdf6fd5cfead9bd8bbfdc0bcbfe81",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "af1772b104fe9f2c8bf8549954b105e6ba2f401c20d48e57f915518e4283ea78",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "ed4813e82d179a8ecabd21ac859308a94ce580f5a0ac48fff5827844670b98a3",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "7113d42109822175d4548f026a19e8b1bfa0f6ec1250f159b1dc327c87a23dae",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "7afbbe913d7374d72a2257728dc37d735f847f9f035c423f727d065fc01002dd",
  "preview/en/legacy-v1/anthropic_messages/append":
    "774417fe10efa58a7a51af13e398c48db10cf73b903fd7f041b3c3233914263d",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "54af33bf85f50e9641fccee9b860d0f277b320eab45cebe4a2bb621cb46fcb5c",
  "preview/en/legacy-v1/chat_completions/append":
    "7cef25700ab671383eb78fc95570e2e126872f4986814a59a74b336d371e385c",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "def55071e5d4b00a446055042aa23ea448c7a30e74acfe26027c6aa64cce1023",
  "preview/en/legacy-v1/openai_responses/append":
    "253f9200e7455e1a9b17e7f20a6b721e7150ec05d0e7f656a5e91581c7d2d4ba",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "8429f9713b7aacf5c4c4090b246c1dd1f5b0e8009991d3380a8ed8108348a3d9",
  "preview/en/ordered-default/anthropic_messages/append":
    "ac6c120091b7d52a46e64c8025901b3d0935d639e428606a6b2cce5ca563600b",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "bfb56810823bc0dfc6ba2fafb83f2930cbf6c7d31a01dec2e4305bdb7b4fb671",
  "preview/en/ordered-default/chat_completions/append":
    "53da91b828c09d98fa86f8f73b5946c0dca283cefa8adb82d3e8d81adc180d95",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "38688220e1f018653e7d01e9c8d3a8b8d82ee8e4602cc84ad10681aea3146d82",
  "preview/en/ordered-default/openai_responses/append":
    "9600b7e7c3592a29bde8de8142926dcb140f88ae1c2e2381725f5a142911af80",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "e43002ba9ddcdef1ef8c1a554c5c32c44eb13bdddde2f4f678815151d382ed2a",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "5116253034acfa6334c42ee6d57c171f3f7205d7317e951adc1cd6b94e2120d9",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "eb6be67a621e6770c1dfbd2fac918ebc88667ca2038c26d87ffe8411dbff16ce",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "15ed37805c62254e306f12473b7e8d49082b25b7088f0cf78a48ce4f200190db",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "2f45eae181fba8bdb202ed65d26978d7946b14230f583529b1e436183d6cfae0",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "9f2eebbf601a3ef0ec2705519bf10c0cd0b3dadfad503be606daacf8708111b8",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "44b34b1b8390a2320b12544ea41933316d26e6f907760e087c64543eb406a20e",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "2357284e9492191eeae1c524420238ae698930bad8a181b0775b4cfb9632a1bc",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "8d14b20dcde520f5b88ad337bcb850770c01e62f40705a2beffc004d014342c8",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "7e26b61c68a629c49472c768449e09cde579cea9bc97be9597f33db0771b53bd",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "a3605d3f51c2c8e1957c2902256972f6716acfbfb1edc2fae789d5daaefa9a6b",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "153628a7eb45d2c24aba478fe43bd5c1ac597c81b6805ae5f9d372baf10ad08e",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "78a228b4c5a016c489f24f48e10634be19387c420fd1ca39572a3a4734174291",
  "revision/en":
    "c5869c27cf7b2f982cce3a66df8e93578b965995d6e1763455b1cd4471176549",
  "revision/zh-CN":
    "bf8b56c98eb41b927c03732f68c3c92419cb18eba7a7f963d3c70a72a6c5603e",
  "setting/en":
    "afde18f8256fdd37295735bd865ed2470e86fa6a8ca976811f03faf8cc603e99",
  "setting/zh-CN":
    "1d73131d7b43c20062f850cd38130645b72177fa01827ed11ca5b3f704663f63",
};
