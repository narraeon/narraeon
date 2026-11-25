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
    "78e50357a500ba6ec2ea320cb1e7aa1879e5535e4cac660287ca0c05d5ac167f",
  "bootstrap/en/legacy-v1/anthropic_messages/bootstrap":
    "fa92a4f0d9e6380d4784ceefdefb2d4a95a901824f2a9a0229aed7a836da9e2e",
  "bootstrap/en/legacy-v1/chat_completions/append":
    "e6787736c707d5ad9e8e323a7eae25ba8189db7ecb1437efdaddd6b91c1b0dd9",
  "bootstrap/en/legacy-v1/chat_completions/bootstrap":
    "907283ff52792b57e088735bf80430d052f6d15fcae4065259e8f4db80d8bee4",
  "bootstrap/en/legacy-v1/openai_responses/append":
    "3188ebde830e4035b20b0b55cadce96bfa8a2c6d47d6100d42326dd905bf4f31",
  "bootstrap/en/legacy-v1/openai_responses/bootstrap":
    "240cd397d0e541ce5e0da2a7098f6e13efb46cfd687989d301f4c5a8e3f2ff69",
  "bootstrap/en/ordered-default/anthropic_messages/append":
    "78e50357a500ba6ec2ea320cb1e7aa1879e5535e4cac660287ca0c05d5ac167f",
  "bootstrap/en/ordered-default/anthropic_messages/bootstrap":
    "fa92a4f0d9e6380d4784ceefdefb2d4a95a901824f2a9a0229aed7a836da9e2e",
  "bootstrap/en/ordered-default/chat_completions/append":
    "e6787736c707d5ad9e8e323a7eae25ba8189db7ecb1437efdaddd6b91c1b0dd9",
  "bootstrap/en/ordered-default/chat_completions/bootstrap":
    "907283ff52792b57e088735bf80430d052f6d15fcae4065259e8f4db80d8bee4",
  "bootstrap/en/ordered-default/openai_responses/append":
    "3188ebde830e4035b20b0b55cadce96bfa8a2c6d47d6100d42326dd905bf4f31",
  "bootstrap/en/ordered-default/openai_responses/bootstrap":
    "240cd397d0e541ce5e0da2a7098f6e13efb46cfd687989d301f4c5a8e3f2ff69",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/append":
    "aa527bd81881002cf7ed3e576af9e9bf45b1dd72331d40ec7fa3bafd292d62f9",
  "bootstrap/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "3f9c2638a2569c61ecf20905c2aefb01e837a1d0bda538c6461fed6d0a2cbb45",
  "bootstrap/zh-CN/legacy-v1/chat_completions/append":
    "deba0d8e1b3c0c46fd0e7e2775eaa63fb5015610aa9cb70c1c5d4722b95deb58",
  "bootstrap/zh-CN/legacy-v1/chat_completions/bootstrap":
    "64f3bfd4b1dd3a66d438eff35671c4f4caf42267693e3b2b00c98ddb912271d6",
  "bootstrap/zh-CN/legacy-v1/openai_responses/append":
    "faa581d6292d3857ddb3f64be4f2eee4b962a0f1977a264f4ef12a3d3fe194ca",
  "bootstrap/zh-CN/legacy-v1/openai_responses/bootstrap":
    "0ecc12fc40e1cf8baf38253ac431460294d3dac92ad208d68eb3fdc6aee3889b",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/append":
    "aa527bd81881002cf7ed3e576af9e9bf45b1dd72331d40ec7fa3bafd292d62f9",
  "bootstrap/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "3f9c2638a2569c61ecf20905c2aefb01e837a1d0bda538c6461fed6d0a2cbb45",
  "bootstrap/zh-CN/ordered-default/chat_completions/append":
    "deba0d8e1b3c0c46fd0e7e2775eaa63fb5015610aa9cb70c1c5d4722b95deb58",
  "bootstrap/zh-CN/ordered-default/chat_completions/bootstrap":
    "64f3bfd4b1dd3a66d438eff35671c4f4caf42267693e3b2b00c98ddb912271d6",
  "bootstrap/zh-CN/ordered-default/openai_responses/append":
    "faa581d6292d3857ddb3f64be4f2eee4b962a0f1977a264f4ef12a3d3fe194ca",
  "bootstrap/zh-CN/ordered-default/openai_responses/bootstrap":
    "0ecc12fc40e1cf8baf38253ac431460294d3dac92ad208d68eb3fdc6aee3889b",
  "chain/en/legacy-v1/anthropic_messages/append":
    "8c0d06e87b27bd4fb58dc3ca87a7992da524df8aae155aaa5efc445896a4cc51",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "275f2cb5268f891aeb7bd1325bdb4f248d3ce982dbdfb896f67a4092b26af803",
  "chain/en/legacy-v1/chat_completions/append":
    "3f06dc4ae43b20f544bd2f3acd7d6d30d8aaa650c26a1046b71fa0cba3ce94b5",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "2da6c2021793511ae7b6ad7136465f294886c3f2a1c63624ab04233eb40fd28e",
  "chain/en/legacy-v1/openai_responses/append":
    "d27a272cfb34b59e6a5ecc99c4905393facb2361df9a1674e2c96e0b07733a40",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "6b754f45e6a1b1baeb87df8f7dfc045504d9db8331957deb4189be61298f9ecc",
  "chain/en/ordered-default/anthropic_messages/append":
    "6a970f9f9b0e3ad1dcbda173a136e25def7d663cd2748676f601ac7b4b8d563a",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "ba14c13df5c6c7e261a8716d899b08888cdf30f7faa42be8dc585038d3c629a5",
  "chain/en/ordered-default/chat_completions/append":
    "9e9eddeab1d364699d3933652dcbb5745e8295472db38aebc8e52f60405ed46b",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "ff196194f17711ca7d42f7a4bdb328abbd4413666dbced2f87249d60fb3e8daf",
  "chain/en/ordered-default/openai_responses/append":
    "4576304069d4aba81e80fa4a8fb145f545789c8f0610a1e5ca0154248b0599f0",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "a2920e780280d7af4ef057847921db84e9cbb39ac19e0a2a333307e7425211f7",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "15a813f7841d207a12172ce04392a17652da29b16a5858756ac4edcf863a6e5e",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "a1c9bbd36063fc99ffa9afb9d970ad7cfd43d476a288a317438fca7da7c60b17",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "1119159114899a7a09c1234fda1ab5fa464ab17e81543ba7028a1fc40c826cd6",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "20d34980ee0bd0e03a867459ad83375576f121547a8f1e2298c84ba9d9bfa78c",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "64a3645c4346b765893cc009139c99bb6844fef5b809cb95d9302d9fcc1547ea",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "2a3f4fac44e070f981aa5883f8b7bee3bca23a64106d54234fd1f359d26b051a",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "00809ec2a1952627a15d640eee099d916bdf1e2ece42659e0af4f0c9af51c3a0",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "bf43ab0aff481a79ea638844b35596febd36fbe8032cbaa735d1e862011b9d9b",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "007cac9944f940ab764086f7f3f701152db99e75bab291e997e150dee084236b",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "c3a54ef99fdf482d489dba984771ec8e837eb89a04f908f21bbc40258ca47836",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "5d696d63b185d0de3a314019b921d5d0585a4453dd29b759906feb03158eb00a",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "e0a800fbe2bff47d61103491a0fdfffbc1a55d231b52b4c0d4ab445491cd5a03",
  "preview/en/legacy-v1/anthropic_messages/append":
    "cb5db8ca67788247add968c435fb1cb107a0278c34f3bfb18c01eb30b8586b04",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "9865c5fcaaa0910f6741351c7289c633776b203a2652e4d140960489f0acf9aa",
  "preview/en/legacy-v1/chat_completions/append":
    "958a9b78961d682e6df36ed19f5b234523db898c2f2fcf31c7beecd8282f8439",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "ea8042a2d98fcae8da95975d1810f3bf57a7a293880c8a2d0360e20e5ba50264",
  "preview/en/legacy-v1/openai_responses/append":
    "0deddedf3216e251f45a3515aa09138436e4759253f24239172be58ef4b89475",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "2fdfde56e61a43954454225e32ab516aed462185a0571dcb3266490eeb01cfa4",
  "preview/en/ordered-default/anthropic_messages/append":
    "27702baf5f3a2192f1a978562f40d463b51fdab19d1dcb451a7260d81e26a424",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "fc038fc3d130b5738eacb23ddf0aa298a740c414c4004e1100e2220993229379",
  "preview/en/ordered-default/chat_completions/append":
    "76ef551f7ae779dc54852270ea29c11c2483d049fe7f111ae44a97712ad5ef30",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "017d0639eb19fd610baaaec1bd6ca5c3ade94d5ec5148f3dfa4a454aa6eaa7f0",
  "preview/en/ordered-default/openai_responses/append":
    "c090f9b1e7d835d2f83d775fa728e30b80dcc623905ba475423dcc62b579fdb3",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "f011575c1ccd8dba8f6b05673e9b735680a05d9984b3a28f366e2b795dcbcee5",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "5cc626e7a237ec08bd6237360d7e294951021f14244d3490d9f008fb491bce65",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "eda43f104f4527a6f2a8e825ea8af88258369d92677f9ff3cd48053736b82379",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "358d76daa7df4f280cd6f80a6c74dba2bd7b917cb437dcc6e9919969d7f0e0ba",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "72792c6c5d60ca61ab42c1d4a1d108c7e89c120e9f683d79c8226918dc93c402",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "f6ec1bff8bf3436439cf3429424e66a9e9ef5b20bfaec29c58a16ac0b71203a6",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "4184cba0cc87198fad0a89c6ebbf3887d6905eaa99c8f1324bfd145e5d6920f2",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "e271e2bb827948587c74383f3b5e491574e005b4dccbc00036158d1e0aec5313",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "656b5171cd9e08184d6e74f3fe6946ccb10d099118eb104c63c00c705c2c483a",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "eb9e03de1a65f588a7483bcf8a7806eb00323e29ada7aa53e0ead5426f3828ee",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "38677b4c8546afed8133175e25b01eac8861d2229fd2131de48bd74882d9f2e6",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "e02489d15c6edd91980d86a421ed083274a9beee3c7ef7b9ccc05a352ae916b2",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "ef8795a5e3089d70d12cb9f72ee12e7bab1e44be8fb263817f3ba220c4242767",
  "revision/en":
    "066a11774f572304c6ad5f21c16230a8335adfa6b36c08a8518e740075709eff",
  "revision/zh-CN":
    "4c72140f1f697d7401b5116cbf1aa252b379d3c30a42345d1c126e69c1a75dda",
  "setting/en":
    "e582a3fbc272a2170ccc0e612d0ead623f4ac1e8fd3529a42d498f2a3afd0cf7",
  "setting/zh-CN":
    "aae69254bf6743a7f0af9a70f900ac632c5f8a9a88dbb72a96ee5dceff49b828",
};
