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
 * #269 adds localized play tool field descriptions and shortens their top-level
 * descriptions. The 72 bootstrap, chain and preview digests moved.
 * #270 localizes Runtime role headings for new ordered Chinese requests.
 * Only the 12 ordered chain/preview and two authoring digests for zh-CN moved.
 * #265 adopts the bilingual candidate play blocks and history-use guidance.
 * All 72 fresh bootstrap, chain and preview digests moved. The four authoring
 * digests stayed the same.
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
    "10d52c8c6afe2c67f5e7b327734e7b463d6a0684aca09637c079f28194e894cf",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "8d6e26a0272a778c304bf3bbabf0c081de0abea5997a0e43fbc496a908749d36",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "7d6a61d432a820a51d1d34a958984db1b1761dfe6ba12b2d4ab8a8afbcd6302a",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "8f36db416bb2592121770779fb700be5eabaa8bba81eac3f50d2500477229303",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "ae7100f84b0df61eff794d60632ec9209564219515183739c1f1cba4adfd8ae5",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "65e062ad0fefaec0822995ddf7845be9c545a8e2a530c293bea03474cdc0e964",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "10d52c8c6afe2c67f5e7b327734e7b463d6a0684aca09637c079f28194e894cf",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "8d6e26a0272a778c304bf3bbabf0c081de0abea5997a0e43fbc496a908749d36",
  "bootstrap/en/ordered-default/chat_completions/append":
    "7d6a61d432a820a51d1d34a958984db1b1761dfe6ba12b2d4ab8a8afbcd6302a",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "8f36db416bb2592121770779fb700be5eabaa8bba81eac3f50d2500477229303",
  "bootstrap/en/ordered-default/openai_responses/append":
    "ae7100f84b0df61eff794d60632ec9209564219515183739c1f1cba4adfd8ae5",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "65e062ad0fefaec0822995ddf7845be9c545a8e2a530c293bea03474cdc0e964",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "fc434ff8742195aacf6acb32e6426bf797d4c6292f8054d6ab0b1ab44c9934ca",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "a59ae0df8454e38efc61a8c740b8743122029f04f773ed8e5ec49fc14fe64524",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "be4f95e4ccfa1493db3cbb6809efc999cc21397b83ae1bd6d832d96232efb4b2",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "6f2538387cbc3be522e7492e0d8006d871cc055f6edd5196f99d21afbfa04a13",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "a212f6def186daa9be6c7111033f216dac6e17a6744c762bd392bbddbaf14bfd",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "80e60479a9078ccc35d017cfb09f0729e743b32d8516085781c90b33f3e3a52e",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "fc434ff8742195aacf6acb32e6426bf797d4c6292f8054d6ab0b1ab44c9934ca",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "a59ae0df8454e38efc61a8c740b8743122029f04f773ed8e5ec49fc14fe64524",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "be4f95e4ccfa1493db3cbb6809efc999cc21397b83ae1bd6d832d96232efb4b2",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "6f2538387cbc3be522e7492e0d8006d871cc055f6edd5196f99d21afbfa04a13",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "a212f6def186daa9be6c7111033f216dac6e17a6744c762bd392bbddbaf14bfd",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "80e60479a9078ccc35d017cfb09f0729e743b32d8516085781c90b33f3e3a52e",
  "chain/en/legacy-v1/anthropic_messages/append":
    "62348a9c710c8a2e35ede6b9e19506bad0062e788f2ddd370cdb1d7399c01893",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "505b18ae8d65975d896765fb52938f56a0e6e0901dcbb34ebcec802db8876096",
  "chain/en/legacy-v1/chat_completions/append":
    "438df04917fb29cd6b50083d6f7390d6bf4e4f3828c7c6ac06f17e3b8b846448",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "b0124aff61db69b25254571efd53a1bcc0522cf9a59a7be94663d8f05f3d73f7",
  "chain/en/legacy-v1/openai_responses/append":
    "ab65d8a6fbde9efd4f227f603ccf3cfcb0587934e7a059949b3ef98a8e3db3aa",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "5d1bf11161b28b6ed603e93476a136f3ecf75b9ce117b51fa4f15806edd38183",
  "chain/en/ordered-default/anthropic_messages/append":
    "798306eb97dd7bc6eb2248072c12441322f6b689db740cb55fe0c907d80fad76",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "f4f0c4058ee843a2a2911ee8cc2feb3a008fdd33c83a94fe13eb5b8a7952b06a",
  "chain/en/ordered-default/chat_completions/append":
    "aa6133a1f89da514455ab8a4a68c0f77cfa5fba5b466ef636afc4b4bf57db052",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "116349218761b9fa22fe52a56fd6b4cbf4a90a9107eb9de787fd1f332b1ef485",
  "chain/en/ordered-default/openai_responses/append":
    "f70266505100c52ff5afe76e4ebc2ac9a9e8b8c434178a7e564f6b7b05a24139",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "17dabb54a27a75b58c57988e961d7ba583fb13a0903cac952beae98de0463967",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "cbc31ae17b50f4de2fee501b166c25ce9203f3249b35f0c888d4e85a878de78e",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "76738c6203caa989d2deab604f0ef81c268960d03e62bab69ee1cd75a0d5b109",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "aabe0aa778b7c159816affe48f16b7dade4fca685ded164f90d127d0c05d587a",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "1e690f6ab75394d83fbf72c0afc1a5b0b37742003fe1ba79b22610d2bc405186",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "3fb495274483b66fc41df43781b8950b7b1291c8824718dc77725145584319f4",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "cdf77af4d36e8aaa6d9f3639d16a623f7aa759927621ff6ece26f92fb8268d40",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "c565761c814da790a5cef6e53e6f0b92dd92e988d00757ea3c0c1655d3725ffe",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "027053aa5de16dea2f00547624d513b5089d7ce233788a6d315df591d5cba494",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "323bf378e2ac003e3fa52ed9ebd194eb7de3f8a5663f4508fc7306d578d2d872",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "d06ca19eab5584707bf1e470675d1fb8e470d46bb3c3651017ae51b2f5f2bcec",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "f3b6ea5bb3aca0ad7516d5e3337449d944c82fe9de7ed01cf3bf9c1866bd9302",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "8b8fc82d1367b407c5f59e97bf77b5afb0ffc3e34dd9195a8ed70dcc6726e681",
  "preview/en/legacy-v1/anthropic_messages/append":
    "cd0500988fbd5cd73c4272d5168b6c8d647aede8f232bc5b312de26a53d6e37a",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "cf784471b12d52b66d852482a2eb288ab21889855d027327ec40ab9f21973c45",
  "preview/en/legacy-v1/chat_completions/append":
    "d5097824860cb2549eb216e12c02a5f60ee29c09140838e90cf620296d2e3996",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "3a92ac4c31be715d5c018e7a1bdb4dd65b37e4d4fbe8f7a9a12407faaac23a1e",
  "preview/en/legacy-v1/openai_responses/append":
    "f4f1a32febb5866b56e401f34677cd8dcf98bc045ff60de0bc68cc4a27982625",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "2824d70ea93705cc9f08265b697c00ab53dcdb1afa72c15f3277727fb68ec888",
  "preview/en/ordered-default/anthropic_messages/append":
    "923aab4d351756df5780bf7ce3b7ecd7c733680dbbb848f0dd6419e0e00738e0",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "470caf3e11aacb649c11ca2f25ead348b4d42cd7d1263e1f86f5ef88edf4a858",
  "preview/en/ordered-default/chat_completions/append":
    "c2c597d81ddb35348b57d7d10b3c78c246ac0b000b61316dc799894ba1b772c3",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "67cddd8dba7610031a60d2eaee985fb5311befdbea097c738b0ecde626eb35b7",
  "preview/en/ordered-default/openai_responses/append":
    "542a57eaeb53974cc9d0124fa501383acd886f07ea357a7e4cfd6e85998f7d4e",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "01738ad867740d83216961c5ac56d148f510159a60547355d6cabe7359f9bbf4",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "3f0b50b3a69fdab264907960804abc9c02c3633a8df658e567bd4ffb331f1ffb",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "137789fe49bb94082def08a70c9bf6c8b7ef13524cdf872b96d3882a6721e3ca",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "ef6f91faad39f3cb263c44940a6b39211e5e548392bb5646f1322d7a745f8b2e",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "816a4756d810cfcfb2e0df451e9212163b7f8324caf3d2aaf53636bf7c02c284",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "3bfd7caad6fac350ae87e942738591d6429f956d9803d74d233f996c0a8e2233",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "b74ef7181f911494da32f3fdb8528a1a7493eaf9b64f7c8311b35a4b78c1c148",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "90b9efa3b6d52a29688b75264ba4d163f86397625a7f7a91c00bd9ff605217f5",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "61cbfb2d9fd7f51c44d16c71a6f0906ba5f66b5e8db1caf9ed8f324934a4127e",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "8dc804401ea5283b8ac3b70c55f0bb671fc2e3b0f87e9cff4c8ba742daff65e6",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "e4b177b096211159d00588f0848e6e0b7fdd76632f63f9cdef941d1c0ee1ee25",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "3a3c432eed9dd487aff867143f9e96fe6a92d01ba2c62c686ca241aea286b3aa",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "53f7b4009b533f4cebbbe9a5f0ab3522c591259ea5674d10e0d28aebfa42a30e",
  "revision/en":
    "5c92d09c0a2c6b1fa8e6c9594059182f9aedcb622e076c80246f51229fdd2523",
  "revision/zh-CN":
    "9e79b6033aa8fcb12f4c8fa99ba14457aa32a352d3243392232356ce473e85e9",
  "setting/en":
    "5f5f3a1dde418d6ea699dcbb1dec3be692dfc62bab7113d6b4161d8e0af471b1",
  "setting/zh-CN":
    "555da28fd9aaed5b5e44220409c3c7fa12b50106656574cd125fe20866e1261b",
};
