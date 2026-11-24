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
 * fiction world or package is checked against the last intentional prompt
 * change.
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
 * #243 names the orchestration in fresh Runtime and authoring instructions.
 * Only the 24 bootstrap and four authoring digests moved.
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
  test("compiled fiction requests match the current prompt contract byte for byte", () => {
    expect(computeDigests()).toEqual(expectedDigests);
  });
});

test.each([
  ["en", "The current orchestration declares narrative rules"],
  ["zh-CN", "当前编排方案声明叙事规则"],
] as const)(
  "fresh Runtime authority text names the orchestration in %s",
  (locale, line) => {
    const compiler = new FileNativePromptCompiler({ locale });
    const bootstrap = compiler.compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "preview",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
        playerInput: "Preview",
        playerInputPlacement: "bootstrap",
        locale,
      }),
    );
    expect(
      bootstrap.logicalMessages.find(({ role }) => role === "runtime_system")
        ?.markdown,
    ).toContain(line);
  },
);

const expectedDigests: Record<string, string> = {
  "bootstrap/en/legacy-v1/anthropic_messages/append":
    "acee8fc106000070551cfb3e111037faab0da31084245ec6ab9d9a92b27fdb3b",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "511ca3e27e249d5707f1c8410e3491cfd67631df09cc7dc4b3a6e3a931b7c29d",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "943989f689814fddf6977ceb0f2a1a79668c3bed8f971d6ef26c5a72888786db",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "a5f664b15a18c674535901cd356bdcfef47fb483fba61dec27673cc6c049e0fe",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "698f962afbc7f675eb5ae6931412d769ddcad98fff9ef65afff346d2e96d2709",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "c932b28e354da0857be3c1f94a6ab34f7920fd582070a844f762fc47ca239fff",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "acee8fc106000070551cfb3e111037faab0da31084245ec6ab9d9a92b27fdb3b",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "511ca3e27e249d5707f1c8410e3491cfd67631df09cc7dc4b3a6e3a931b7c29d",
  "bootstrap/en/ordered-default/chat_completions/append":
    "943989f689814fddf6977ceb0f2a1a79668c3bed8f971d6ef26c5a72888786db",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "a5f664b15a18c674535901cd356bdcfef47fb483fba61dec27673cc6c049e0fe",
  "bootstrap/en/ordered-default/openai_responses/append":
    "698f962afbc7f675eb5ae6931412d769ddcad98fff9ef65afff346d2e96d2709",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "c932b28e354da0857be3c1f94a6ab34f7920fd582070a844f762fc47ca239fff",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "54d7e37394a8e3dcd49f8099da635be3a64637ed1a0c803c916192f70d5b47d6",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "2e23c4deba8f7e878099cbd76f7b52f38211a6201db08bfb96109df70aaed530",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "91b429896dec3ab0949cc0c03a56cd69437d8806595cd3066029dea300689656",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "6f0c692cc02284e8f90c1685836c253c7dc664a34ffd187e0df17e0d2695a008",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "dd0c2ba7538089edac6284c73c63090c3620b72de4f0a8a1c11c948e65ef374c",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "22517826947192f80fca320d67c9bdfc4f96299a4672e0577bdbc3bee5c0b9cd",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "54d7e37394a8e3dcd49f8099da635be3a64637ed1a0c803c916192f70d5b47d6",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "2e23c4deba8f7e878099cbd76f7b52f38211a6201db08bfb96109df70aaed530",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "91b429896dec3ab0949cc0c03a56cd69437d8806595cd3066029dea300689656",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "6f0c692cc02284e8f90c1685836c253c7dc664a34ffd187e0df17e0d2695a008",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "dd0c2ba7538089edac6284c73c63090c3620b72de4f0a8a1c11c948e65ef374c",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "22517826947192f80fca320d67c9bdfc4f96299a4672e0577bdbc3bee5c0b9cd",
  "chain/en/legacy-v1/anthropic_messages/append":
    "0e59481040a71217aa6542c8585022ab588c92e546561e432e20f0b1c316cbef",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "ac12f39d547cb542c22deaf62a784131929cfcfa28bcaeeece3007643a95fb92",
  "chain/en/legacy-v1/chat_completions/append":
    "1d2a8d4a2f4951b0574d900fe01cb0e5997f8c97358df57d65ce663098d090cf",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "7d727a525a43211c374cda838195133873f2ddf6d1a9451bf0b0da7b4df1f280",
  "chain/en/legacy-v1/openai_responses/append":
    "25f0b81f19d55d93bcc23ad00a2e4ceb6cfd533a3c8637f04bfa5e46b7538a6c",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "f3f554ba10d8793485c3a47b5a3339fd6e644815760d63cd5556e170c9ec709f",
  "chain/en/ordered-default/anthropic_messages/append":
    "a4b589e852f6021b75f32d136620755d6f1fa0e3245b09c31655147a90572b21",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "58a6774bc005061efe94d5e1ac1c3d39ecd6d7205aa27ad3c3a73d219c41a5d5",
  "chain/en/ordered-default/chat_completions/append":
    "3ebb131d897d9dec6dcfdef70ba5f7cc7f919d234a6e70cdbbefb0dea5a17ca2",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "f32439b034c477ac9253b40834bb722300ce502bfb7aac3b1a29a9035d20b8ab",
  "chain/en/ordered-default/openai_responses/append":
    "1b23f1924fcfeb308f72aef0c8255bc2f22c45327a049d23365ab2cc8c334571",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "3d6032c663fe285d9e7e851469514c91c893c8115029b9e5f82323029c1f70bd",
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
    "879ebb4b826dce618ab091465c7b4429cac132c68ed5718f892eea2dece7b63d",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "caeb5b658044ca73a478123ba019b6b75c44f87ed6eb73c8058a76c62a28cc9e",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "90150acda33ffc5bd1710cf8acb7b09e6cf3185630772cff36a0eea5b6af39ba",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "6c6b129b99c84c13b233da0b43387ca9ea7ef17cd1f11d4c65c4369c39e75f3f",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "93076e8a35447ffcb3f69382f2fc0ac8da225edf5b1fec779854a5a6ea4e3002",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "6954b0d997a1c77647d9934c1353548e8b29baa69a926383e4b8bc0ed036eec4",
  "preview/en/legacy-v1/anthropic_messages/append":
    "6cab014ff3135da42078ff7442acb5e1c82875cf1d78291e9dc5cad420a83e5c",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "9c6340fb10dd9458add3edaf8a471cd11bf2f2d93bfc5b56aaafce88dac8a222",
  "preview/en/legacy-v1/chat_completions/append":
    "33ee4e76b21e9bb5197ef89be820072cd66642979df38f574a00b8fa4bb7182b",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "e01afb0e24cd275f2c795b9eb124d11e1edf9dc7260083e836e033a383a05150",
  "preview/en/legacy-v1/openai_responses/append":
    "b97869bb154b73c2dc976d959d8f6d36b9fa8356b058e6032831549ca29197a0",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "5ec5577e7d08845621cbb1d33f53786484c259543656464983c937ce1cf19e15",
  "preview/en/ordered-default/anthropic_messages/append":
    "6b9e182a9aa98dc5f13a508e62e72b59950b9c84ee44c8de982ca18d65700bde",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "a1f39eaf0963886917ea15c64da895da3dfc2bf6607ea01f548b3e3df1020957",
  "preview/en/ordered-default/chat_completions/append":
    "ad5d3579b53c9a0a9c3a32db7bafa14264eba4739e5281699bec9bda155f40d8",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "970477784848029ec8e2b6331bc34dddd4212c67bb40680206f7ee7d34a2acd4",
  "preview/en/ordered-default/openai_responses/append":
    "e57037c2a7c0531e16e266ac92ef42d6941fa0dac8f8e627239f839a38aa15d9",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "0c8828b4743e71c47109a57c0f2b8ac130e4916f21890d6c0718c965341614f9",
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
    "e96c41d70597c51a7283dd5703d84623f47623a49a83e0819f264d0ff7bcbf73",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "1709021eaa8042bcf9a77214234ed8bef0ec69ae2c4a75b0445c68340b5d792f",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "0a0a977439275dcdb697471ab65f0b2835c57613bd2af57bbd7c2e1a6e89ca37",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "ba8d4f655b51eaccc278304272fd931e7e4794d8adf3487622dc0420a51ea3b3",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "07e57c90ccafab36d973afa8ee01ef59e084463710a02388969998fa38de7de3",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "1e9f5f43851e1fac68959142e8477c391eed176f70391077c0996073364573f3",
  "revision/en":
    "5c92d09c0a2c6b1fa8e6c9594059182f9aedcb622e076c80246f51229fdd2523",
  "revision/zh-CN":
    "28580e248083568936132bbe8735112897a81f8d7ff50b9f33e1ac0dfbef8e88",
  "setting/en":
    "5f5f3a1dde418d6ea699dcbb1dec3be692dfc62bab7113d6b4161d8e0af471b1",
  "setting/zh-CN":
    "b911113a229b4f3c2db39b56f08cd5ee2e00c950785aaefee61217a584c81a25",
};
