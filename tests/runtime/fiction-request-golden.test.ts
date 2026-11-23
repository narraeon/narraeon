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
 * Batch 3B core play policy refinement (#249) tightens six default play policy
 * blocks (ownership, save-timing, facts, prose, checkpoint-policy, output) while
 * leaving default turn guides and authorSummary untouched. Only the 48 chain/*
 * and preview/* digests moved; all 24 preset-free bootstrap/* digests and all 4
 * ordered authoring digests (setting/*, revision/*) remain unchanged.
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
    "7470eaa3d3257b830d38679afb9a1f21b80cf705495c1eca530b00c41c605205",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "786ea68fc0631ec07ba01b27f9c0d3428c3d3bf151b75f095cf923e60bf4b87a",
  "chain/en/legacy-v1/chat_completions/append":
    "e2f03f3d1a78d21b060a7362bda571dcf5cb3b3da0eb8e0e073217f2a614ac9e",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "518d97ca7a4025aeeaaac82277e78fca324cb2b6f9f398f9bbdb953c37906954",
  "chain/en/legacy-v1/openai_responses/append":
    "1a3cba1021182865ca53da0f2cc7cfa643142171258aa31d35b48109f8b7089b",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "aa4fcfe2bfedc0a77558d667fa1432cf7cc0a272b94ff4c43afe77a953d1950f",
  "chain/en/ordered-default/anthropic_messages/append":
    "9be3909a8cdc9a397ecd258153c967bccbbebd99400207f6700784ae02520673",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "28ad55971905d8f4ddeb6d8e467a18bf7900bb11ef7facfcf4211c5099317b7c",
  "chain/en/ordered-default/chat_completions/append":
    "a18088508d8bb189bf468146c5916c4b46b2aae503c4121721da707acc827da8",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "6b68d01b41c2bba11b8a62bf5aa9980713922dcf3ad17fd5a053a3936df69ff4",
  "chain/en/ordered-default/openai_responses/append":
    "59d42acdd3205a4a8aa4f8b3167dcacfd42e8baf89c171ae0d40c59b5351242f",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "00b59174074bd423e69185c5b8c16ef1f9eaaf234749ca79b8743774605fbb99",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "be2e5fdef6182422ad5973d13ddefe7414546059d5d86f213b58b10fb94ee5f6",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "6bb2c8da275de241110d94583dd03d92681995e22c9c3dd8441a7b5cb2f1293c",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "fe1421abc862bdedc9d05ab9b65ed4b1dcb344298e9a5c21842c65349127b8c5",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d748051076324bcc288479ea63161734aa1c2d3e912dda1187b307eea9845df2",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "78e5e226ffdfc3f46564e117e549f1b7020e1fa60055848627cdf1612a9ac393",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "937e06518d52cd3ffc7cc55a1ec68fd9feade190a6be455ba151f1f50692df0a",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "613e343a458bfb005f081a6be771e8568d0040ca2f4608c076a4b5f210f1e01f",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "5b41922e9845cce7eb2798a7ccbb568f087009e13ea08a3be4dd97c7a309e891",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "6fd490370f90c0f36fdd6571db0b8de46a34227547c2d59bfd0e7172a3a1f9bd",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "fe4c19ecffdb1d32ff9a7c55f2e11c75e8382ac4e1aa193de4787372f1192b13",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "aa738e3588c52c72aeecb18f3f5b4fc7f107e17ccaef21e2aeb292ed3e01763e",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "9554d3bd4521cfeed16bead128af928f9ceef5e7e2868afd045ecd62871f8520",
  "preview/en/legacy-v1/anthropic_messages/append":
    "56d4dc25ea1eafcfe90e8d7023009d8a8b582155941080a40e3e90289f560fa3",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "7a5fec6d7657712559f9fadbfa325cb7c3d7bc00d312534e05e1ee2faad5f464",
  "preview/en/legacy-v1/chat_completions/append":
    "7bfdf07c55f8386ced0e49840e61064349b83a0e09f55d7f8de16a35be061a5d",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "649d17a8c4416c838ee35b6c3757d7d7d316eda2097794f29933cc7bb5a1d085",
  "preview/en/legacy-v1/openai_responses/append":
    "0c104d07b38ba20c23e2b2611562a87b0d4cb310d711df13cfeb40f2864e5994",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "1f75fe62f05d1ab978192dade46df26862735b5af44b9327dc23719c80f8878d",
  "preview/en/ordered-default/anthropic_messages/append":
    "7b7c60d135b58cb2ab00b6285722d27e77808a3b6bacc277d9c905cd6129895e",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "34f32fbb7fed625540e943efdfa25a1a888969516bc15650d5fa7e0b48e3695f",
  "preview/en/ordered-default/chat_completions/append":
    "cb00bdef6300f22a73d6dc740200a1e909c5df3e56dd2bdb6996c3b9a4216796",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "c301e919b2573c5ec8aaff0c5c4d3333d47f085e8fc894fd943e125b2a231ed8",
  "preview/en/ordered-default/openai_responses/append":
    "f59e4b8af098c4a1561e198f79432fd477a18ff5b6e9d538d1154ab77f63b08c",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "9bed8cfbcfc8eb599dbe38e5142d41754101259e8ab78c48c148cb5e24ceffee",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "77d0708effeca3f2487fe6c659e95c950f7d166d71f14aae11fcfecf8128c346",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "f2a69d5ab15053f3de50ae86c42c830cb61b7667f86b3bd47b79321bb113ec68",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "59473855c03613c44362e1419d751e1c620006621cbd6679115113c9b7306069",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "f1ea36169e6f4b2453ff5470cddfb27f1923aafb9209df47e36801fa4d99697f",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "4fdfaf827a119f14b9a3acc175a0fa4fae335e489e3078c9eb4fcc4e0bfb7665",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "9f89856032888583bd49db685315b5c500861990db3e1db0529b3ee89b3e3221",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "83857b89c86d610ca7cd85f8f2bbddc6cf51eb7df87a6ecb2f5e788668eb5320",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "16ade4c434db4c4d6a82212c142f62ed1360c80792d69b147baaf73b35a12694",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "6f0fad01ece6ac900bb34c7571d09453541607b1c5b3b250dc175e6e816e6e95",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "51b671049ada77e3ddfa85bd36f077280891ee7be2ce9c7305000dcbc88427b5",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "386731a7f5801d9786093b6369217225ef5dffc842366f73dc51708799dbda62",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "3fc8876abf9577027a8c1ccc6adeeee5ed9ce149597a73c48e558a6d96a67d2b",
  "revision/en":
    "c5869c27cf7b2f982cce3a66df8e93578b965995d6e1763455b1cd4471176549",
  "revision/zh-CN":
    "bf8b56c98eb41b927c03732f68c3c92419cb18eba7a7f963d3c70a72a6c5603e",
  "setting/en":
    "afde18f8256fdd37295735bd865ed2470e86fa6a8ca976811f03faf8cc603e99",
  "setting/zh-CN":
    "1d73131d7b43c20062f850cd38130645b72177fa01827ed11ca5b3f704663f63",
};
