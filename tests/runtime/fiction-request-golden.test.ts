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
    "85256ed2fb94a3fcb937727336b3ac2f9b8221a1a677e4c684bd219daaf929c4",
  "chain/en/legacy-v1/anthropic_messages/bootstrap":
    "0b22383410cf76cd991828375836399abda45079b9fcd6d4c33d607fe46bd03f",
  "chain/en/legacy-v1/chat_completions/append":
    "222cc4c0b0dd1bc8cbd493d482f369b2d0d72907bc9494779273161203d4e5e6",
  "chain/en/legacy-v1/chat_completions/bootstrap":
    "f9979fa96315ada161d257a128ab37407604e59fc9a902093063e4a182276ccf",
  "chain/en/legacy-v1/openai_responses/append":
    "09587d46c5749082994d22da4571d1abc9fdf1a030800affc61a251c4f2c4a3e",
  "chain/en/legacy-v1/openai_responses/bootstrap":
    "117c268cb1bcc4de455f4be0e5ccb548518d3984eabdcc8fd6508997206439e1",
  "chain/en/ordered-default/anthropic_messages/append":
    "59478af11f0867cccae2c271ce767d5e2ee689b47752c5f500d95f60b2932413",
  "chain/en/ordered-default/anthropic_messages/bootstrap":
    "040a6b52a23c23ce298a63f1ca1ae69b75210adfa50ef0c3b6334c52d45ff4c5",
  "chain/en/ordered-default/chat_completions/append":
    "5bcffa3e8f6b6c9e13c272f364fcaacda506cbf5e91fedeb8ac23daa0951f057",
  "chain/en/ordered-default/chat_completions/bootstrap":
    "8c7b38f2f03fb3312f2b58be6694cf7780b1e614b2405c8307708b809d83bb7f",
  "chain/en/ordered-default/openai_responses/append":
    "80700786505994e6c62335d31f0fef8e154de890ba2ddb35fb6d89f3c9141b41",
  "chain/en/ordered-default/openai_responses/bootstrap":
    "04881adf40cf9856eb4302e4b7cf806fbe98b04f03cd2d02373701efe4c8d152",
  "chain/zh-CN/legacy-v1/anthropic_messages/append":
    "25c96b84ebee8b57fc61648e9ade8428b257e27f96505708f6024dc64f812424",
  "chain/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "8d6f6f543ae991d76c3365d4ba1f34d1de41a115a8f134ad57e20e011b26e262",
  "chain/zh-CN/legacy-v1/chat_completions/append":
    "91a832956925612e21fb00945cd7fe1ad823e1ed6e40bdcc5fc42561c7b4f9c8",
  "chain/zh-CN/legacy-v1/chat_completions/bootstrap":
    "54c34e0a50196331cc41fde2ac1cde0ceb1b7bed9adc50089c19653a536eac2f",
  "chain/zh-CN/legacy-v1/openai_responses/append":
    "10e2a09cd0f6469345f3ee7cb96be2c8cafa8807eaf9115599bba784ffef1c92",
  "chain/zh-CN/legacy-v1/openai_responses/bootstrap":
    "c2db1016554eae45d3f47d107fbcc6277ce7ba05e03a1fab6d9738c14bf439e4",
  "chain/zh-CN/ordered-default/anthropic_messages/append":
    "17fd34dbfd1565228cd68696de65a9224dc2747027bf91c063af2a0e06079ee9",
  "chain/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "6e214870627c7a3698acc720fd1f0e50678e108579cc33c02841216434a29adb",
  "chain/zh-CN/ordered-default/chat_completions/append":
    "5ff51885f40a55b293f449cc4eeaab453710105ceec7e8e2a8b853cf1439450d",
  "chain/zh-CN/ordered-default/chat_completions/bootstrap":
    "cd672d7b85af6d0d777347ecc198c3b21d97acfd7e9f851d2bafa5c11ea72b5c",
  "chain/zh-CN/ordered-default/openai_responses/append":
    "71b710f63a2337a7e217b5358190933088b2f69a4a47ac6c85a599a5448a0bc4",
  "chain/zh-CN/ordered-default/openai_responses/bootstrap":
    "467d0256c97091e2303e47a14757e9cbc842c97bade14c3f336714a0d35ef20f",
  "preview/en/legacy-v1/anthropic_messages/append":
    "a5b6adb79d10a1c4e50d6fea053b10f1c783b62cae4836be3bcb2a78905bdb92",
  "preview/en/legacy-v1/anthropic_messages/bootstrap":
    "e440aea57b7cd1ea4fd42ca80fac7ec5a032f05f12281d2881c3949511ae3b3b",
  "preview/en/legacy-v1/chat_completions/append":
    "3c2ba1e024152447db74ba522d3399cb5b53df9c05c5a1ea308da10800f4283d",
  "preview/en/legacy-v1/chat_completions/bootstrap":
    "dcc2df65af5bffaf87ec8f6f93f87fc6c1e669a5885afc7d4dfc89ad4201bced",
  "preview/en/legacy-v1/openai_responses/append":
    "95a868cc0a0fd76a9b81a398d3ad9e8fb5b7f1d9f082ce5ebed3ec454615419e",
  "preview/en/legacy-v1/openai_responses/bootstrap":
    "255b52d45dc9e383bdca21f4d739f40e4b433ca524c9def16570a3441ff05eb4",
  "preview/en/ordered-default/anthropic_messages/append":
    "90fc64092ea9ff4207ac7205d0268439752c2bfcd3a6060db6e0e7a971942402",
  "preview/en/ordered-default/anthropic_messages/bootstrap":
    "4253a31af21fe77a3545d583e9934039cacc27c773115da864a535557ef18dcc",
  "preview/en/ordered-default/chat_completions/append":
    "f3eaaaffbc99432ea3b3c400d3cd77891180efe7e49b8d8db8b1b8375e510b25",
  "preview/en/ordered-default/chat_completions/bootstrap":
    "8edcb4e47b326ef23b99db32490b2730274080a408cd8a25a56ac777df2ce78e",
  "preview/en/ordered-default/openai_responses/append":
    "1704bd589527c7caef3baa3b8e864ae8f8c111b40c8aaf39194f9f289b3784aa",
  "preview/en/ordered-default/openai_responses/bootstrap":
    "f06c7cb489cbeb97cba43ebf55d4d82f159114e61e9de7e5233e33e57688534e",
  "preview/zh-CN/legacy-v1/anthropic_messages/append":
    "c5a5e7c8d428c0d3dd91998a1c77167c382d83cefb4070d0ed33208c22a7f946",
  "preview/zh-CN/legacy-v1/anthropic_messages/bootstrap":
    "b079990baf0acdb89b9dc84caa16023478bcbbcc547e3f64c145d15f80333670",
  "preview/zh-CN/legacy-v1/chat_completions/append":
    "ab65f76822d2f7c6dcbdc7b76efb4228b20f3af82aab469d91174c3ea0fe88a9",
  "preview/zh-CN/legacy-v1/chat_completions/bootstrap":
    "cdf5a1e95370d5ce4ba9e72bfce88ebfec394fec3520d98d535b1a5088861b52",
  "preview/zh-CN/legacy-v1/openai_responses/append":
    "0f0dbed22054ff7b751dd7ac96deabcb382d024959f5ddc8bb00a9a205425c8a",
  "preview/zh-CN/legacy-v1/openai_responses/bootstrap":
    "9e1ab77552314676ad77a0d022a30af48998b2ddf60bc7a832924bb29368641d",
  "preview/zh-CN/ordered-default/anthropic_messages/append":
    "347988d8c48e2ddee39e29b47052a4923d5fff948d686315f24049e8bdb5b1f0",
  "preview/zh-CN/ordered-default/anthropic_messages/bootstrap":
    "e5372b3742fb76454c990fdbadbe5631299d3f0da1bf2328f0163cb76bed0122",
  "preview/zh-CN/ordered-default/chat_completions/append":
    "ff087dd257a3b9cc643dd43eca9f91f8a35e7821d5aadea3425d728e0184b95c",
  "preview/zh-CN/ordered-default/chat_completions/bootstrap":
    "1672491425793c247a76234a08afa8bcf45b4ca03eb8ce5b804a22679dbc8f94",
  "preview/zh-CN/ordered-default/openai_responses/append":
    "e5c28c0791c8da729d882029c3a981f839c8e339e236de756df67fa54d6c3964",
  "preview/zh-CN/ordered-default/openai_responses/bootstrap":
    "b4f8cd26d3161a42b5db728f83e5a4d8f41d70f9bfe55d0e4bcb02c1169ceefb",
  "revision/en":
    "066a11774f572304c6ad5f21c16230a8335adfa6b36c08a8518e740075709eff",
  "revision/zh-CN":
    "4c72140f1f697d7401b5116cbf1aa252b379d3c30a42345d1c126e69c1a75dda",
  "setting/en":
    "31e6493385aaa7e2fb771a5a3a1bb2cac32e1288426025289cfa1faa6e0d6b5b",
  "setting/zh-CN":
    "5f283a3da2edb10bc110d93b35f32b33365a2c5e7953a1ff1e15ebb1a263c2ce",
};
