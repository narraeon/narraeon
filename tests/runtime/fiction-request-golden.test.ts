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
import { worldRevisionToolDefinitions } from "../../src/runtime/world-revision/WorldRevisionAuthoringTransaction.ts";

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
 * #269 adds localized play tool field descriptions and shortens their top-level
 * descriptions. The 72 bootstrap, chain and preview digests moved.
 * #270 localizes Runtime role headings for new ordered Chinese requests.
 * Only the 12 ordered chain/preview and two authoring digests for zh-CN moved.
 * #265 adopts the bilingual candidate play blocks and history-use guidance.
 * All 72 fresh bootstrap, chain and preview digests moved. The four authoring
 * digests stayed the same.
 * #287 updates the bilingual built-in authoring guidance. Only the four
 * authoring digests moved.
 * #289 moves repeated play rules into tool definitions. All 72 fresh play
 * digests moved, while the four authoring digests stayed the same.
 * #334 records the Runtime text locale in every compilation and the initial
 * preload notice in production bootstraps, so all 76 compilation digests moved.
 * #355 adds Markdown section operations to the authoring tools. The four
 * authoring digests moved, and the revision digests use the revision tools.
 * #385 explains full history replay before the first effective checkpoint and
 * preserves durable opening details in authoring guidance. All 48 chain and
 * preview digests and the two setting digests moved.
 * #394 clarifies play preload write scopes and localizes read tool framing.
 * All 72 play digests moved.
 * #398 distinguishes intended speech from private action limits in the default
 * continuation block and turn guide. The 52 chain, preview and authoring
 * digests moved; preset-free bootstraps stay unchanged.
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
        tools: worldRevisionToolDefinitions(locale, fictionGameplay),
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
    "20558cebfee2c5450acb8917e832849df84c22b122b006dbdde864e97d3ce92f",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "94da90826910971ae96abec0cb89d0ca539c23cc8ff1d7ab275785113aa2161b",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "941a54a8905bdf1aaf6ecb3ee83caef9a6468e8ddc37810ff079813408c5a9f6",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "9a67a369da2ce14035e8b4a293c4f94200ae1a958b5170d793c89b2b5dea140e",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "17372d64f595062e165d5008896348e63fc64ef8fb5d9cc162978f215fd0fafe",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "4804c7ace09e6888b3ce3dbc09491418f04137adfb9f179c0d310c74dbc7b177",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "20558cebfee2c5450acb8917e832849df84c22b122b006dbdde864e97d3ce92f",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "94da90826910971ae96abec0cb89d0ca539c23cc8ff1d7ab275785113aa2161b",
  "bootstrap/en/ordered-default/chat_completions/append":
    "941a54a8905bdf1aaf6ecb3ee83caef9a6468e8ddc37810ff079813408c5a9f6",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "9a67a369da2ce14035e8b4a293c4f94200ae1a958b5170d793c89b2b5dea140e",
  "bootstrap/en/ordered-default/openai_responses/append":
    "17372d64f595062e165d5008896348e63fc64ef8fb5d9cc162978f215fd0fafe",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "4804c7ace09e6888b3ce3dbc09491418f04137adfb9f179c0d310c74dbc7b177",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "339a3b62c4429ef79e90310beaff2ad074a05c9809f1640bcdc94d9ccac53c5e",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "43feff88ec7432ca38c2cfba3da89d009880401422e8c9f043fab69ff2b6e228",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "f3ea62c2ca2ace0eced733b7cdbc6442fe8c88d805831f68d170a533b16236f3",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d569d50fda93c0d92df0ea580af5f9d7d119bb67758f29309c27f5591da364be",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "7185a7b758e269405a5a65204903b47a548aedae8f18d78a2d4a67bbdb7228fe",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "8e985e0d6d67a4928bca09fc6befd1cb4b73e52a2f68157c97ea3084ba5fb0c5",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "339a3b62c4429ef79e90310beaff2ad074a05c9809f1640bcdc94d9ccac53c5e",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "43feff88ec7432ca38c2cfba3da89d009880401422e8c9f043fab69ff2b6e228",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "f3ea62c2ca2ace0eced733b7cdbc6442fe8c88d805831f68d170a533b16236f3",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "d569d50fda93c0d92df0ea580af5f9d7d119bb67758f29309c27f5591da364be",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "7185a7b758e269405a5a65204903b47a548aedae8f18d78a2d4a67bbdb7228fe",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "8e985e0d6d67a4928bca09fc6befd1cb4b73e52a2f68157c97ea3084ba5fb0c5",
  "chain/en/legacy-v1/anthropic_messages/append":
    "91edb25080c412b365cbf5cb32e20a60ddf87e8796e0a0ec65c53e97690fb7e1",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "c522ad364230727d18556db914a032aecbd5f46a91661eed16b694dbc60f90f2",
  "chain/en/legacy-v1/chat_completions/append":
    "73cf5f16dcd9ecff148d6f36d7ea3c7c26b6cfb4cf5234ce6f26a59f52cd3675",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "4c72552b92d8580315afcea904a18b5c623c537374a42fa4d0701fc7509dab87",
  "chain/en/legacy-v1/openai_responses/append":
    "4c473a4c44f348b026c869d01846dbc2456b209df4f7d3f42bceffb81ba659ba",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "8ac3ff86681a08334fdf2b6373559ae849cf1b1eec41559cfde3716930e1fce0",
  "chain/en/ordered-default/anthropic_messages/append":
    "7cb091a5282a764e03ef1814c68d99ba787c4651170a24a11a7ab43e3b52fbb0",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "81611c0e2d3984b19b0948fbbf0fa55c061381ea905ebf0d31c8c0c672703a37",
  "chain/en/ordered-default/chat_completions/append":
    "398a9cd895f9852b76228ff8f09b992be8b9840e926c92be61cba4b90844811b",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "dbf74c5cf3d1008673b8cea84edb1432d521ddb328946c365246b1d9ef40e768",
  "chain/en/ordered-default/openai_responses/append":
    "37692c64d6e9e5017d11fb790078ce66fdf62f90d2ef89dc4fe64460b240b144",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "143f1663e1df3c5ccb38c7f2453fccae94ab12653f8eb6120c556de6c6691612",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "4099cefdf55ba31e265cd7613df7c533273c06adcf55936e358a9fb0d1d05ce4",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "ac78466616af612026cf79c12c89727fa8793e6c74092e7f1a82bf4ae5002eab",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "5367ee72941c8f25b5c8d2371451b2c9ad749f429cfde6f9c8cabc82a8e51a10",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "e3d9f75aa6e5e5348c9e52c0acf11ba4df028f2ed7a5152324fafabe5a39a76b",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "db3c1b53b99d1509a34fb1b5df9283b297b538861547ec0001393552c195e0cd",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "5a8933194ac4bed146ecadc377b69b9b025bfb89542e6898ffc5fa05d6fc1878",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "e03a4cd6e11f48085a92aab820b7d2f6af850a6aa685313dffb2d2ef8bd37e13",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "ddc34002b4bc37c8dea80aa3df0f9df6227fe65e5ea3023164be4eb041b4a367",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "8cb2839d0f50b9f08011c2e0b4bf67b71ce2bbb7d7f03dea886345b65e67d65d",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "9c6dfba073c4d4652bd228aa85d3e7d42a8e2cdbc81aeb39927fb67780b19caf",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "5fbed65e49c8eba40db3edf814a5855da814b8c97d005a23ead9a14e6b055f26",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "bee4ec2a6f7fdf85b48f025164fe180e3f7f27bcd66cc2712df38c838159ba59",
  "preview/en/legacy-v1/anthropic_messages/append":
    "80cdd0f6a5dc95a1a83241ea1bceac30b3abd142c4ed55f0a1dc88d591f70647",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "f0f8cf3ba5818dd74ec9f7eb06456dbdb0d2134121f538ec707a4bfe8dbe23b2",
  "preview/en/legacy-v1/chat_completions/append":
    "73e12c87a4dd30fc9ae304a5749c50f1e45e4ba5e478f0ed1b6fbfdf66d1b4d3",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "b7e781d7c5da60f778cf7eeec5c9262f25d38bff03fe729030d56f2cfddbcfb2",
  "preview/en/legacy-v1/openai_responses/append":
    "ad727c73d62f8ba26375d58772445da65275a92749ad37e2ce422e26ee9edc63",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "d3407d0c5dac2d4ff85097f2d8e4070ffe77964838f382e3952c8494420435a3",
  "preview/en/ordered-default/anthropic_messages/append":
    "3cc0763004b2e92674cd95b1516f640c6ddb3f26a9b6f000e63581736c7c72a1",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "f408b6728b37b059329af3964929ce22753e57d46927c0d98e656b466a3d19a5",
  "preview/en/ordered-default/chat_completions/append":
    "ac10a983c638576eb0d3da6a54d35d22db5ea320acf0c371d39461707f7d6251",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "a6050e9c050f01d6dd30e20cc2bcb6b825bf12cc7ab08539f77a777a1b4426c3",
  "preview/en/ordered-default/openai_responses/append":
    "1b998dbd8d6893347a2724eccb563f245c93c1e15fccb5ff1da4ef43ba006ed0",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "43384f6c593270382178445a4de4a0e725ca1fc06bf71a96d450aa872c1bb320",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "5119545600cc428ad59eee9d0729fe5163d4640ce29babebb59afd18b0900b91",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "877999c72c627f8c83aca03d2eb1fbdc25fb3876b39e0032c5fd6eacde48c6b5",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "28e28b731ed265d6434159969117b6c89ab6ae0812b9b833a2571864eca9209f",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "d216580269b386dbcaf25dbd375ec37b79581e5e83c19e975aec1633c4b5ebbf",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "483b417e862d63711b07d4e933f30784cda607aec230ad55d4aa197e23c43f6a",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "4f67eebd7db737670e173da5e0ffe6903bc152b7af0cea4c59b184ce7b32e87a",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "7e1f0e86ccca24b6895e8f24759ac7433084a9d83b03e396352c423e1fac61a4",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "c2d3949e0f95918b69a04bdaf172262164bc8db6509bb7f67db3768b1c556bef",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "f7f4aca87a81a24135812540c5536ae6185a9ae9c97fac81a67c2b2d5b2e415b",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "5a5a659f0684a27165f603ad5d8e93d66ef098f3372bafaafbe479ad1da0d1e7",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "8466e879a784ac13768075d186cb21d309620ed9b0ca1173f47b0324fcbf2fd5",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "15ae7446a5b225e241ca9d9e92b889a2f8b3e5c175ded60ee6f9dc01a0c93d28",
  "revision/en":
    "cea8c7f8c028e6b20d4e14365714519cad598cdbbceaca7e2ef9d3204ef0808a",
  "revision/zh-CN":
    "30a4d3b5245a9f59cdd060897e0e7031462c37b980e47359ace2dd74c4a1f836",
  "setting/en":
    "010bc4da02c9fd401bc12ef664f624878e12e8ea9cc65c7e56ecb5bdd0eb660c",
  "setting/zh-CN":
    "7cc39cc31be350dc1f712ab29d490538382b7f0a65dccf2389e0b38cb8191116",
};
