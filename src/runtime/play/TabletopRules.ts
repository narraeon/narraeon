import type { AppLocale } from "../../protocol/appPreferences.ts";
import { gameplayLabel, type Gameplay } from "../../protocol/gameplay.ts";
import {
  resolutionCheckToolForScheme,
  resolutionToolDefinition,
} from "./TabletopResolution.ts";

type TabletopGameplay = Extract<Gameplay, { mode: "tabletop" }>;

/**
 * The scheme's fixed rules, taken from the same description the check tool
 * sends to the model, so the prompt and the tool cannot drift apart.
 */
export function tabletopSchemeRules(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): string {
  return resolutionToolDefinition(
    resolutionCheckToolForScheme(gameplay.scheme),
    locale,
  ).description;
}

/**
 * Minimal mechanical binding contract shared by fresh tabletop worlds and
 * legacy frozen-context continuations whose frozen world context lacks a
 * world-derived rules block.
 */
function tabletopBindingContract(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): string {
  // Only the bag scheme has a world-defined token list; other schemes never mention one.
  const bagLine =
    gameplay.scheme !== "bag"
      ? ""
      : locale === "zh-CN"
        ? "- 世界文档中定义的混乱袋必须读取，并原样提供其当前标记清单；袋的变化由你在世界文档中维护。\n"
        : "- A chaos bag defined in the world documents must be read and supplied exactly as its current token list. You maintain the bag's changes in the world documents.\n";
  return locale === "zh-CN"
    ? `- 已有材料足够时直接使用，缺少判定依据时先读取相关角色或状态文档，再在参数中写明行动目标及本方案要求的数值；只有有成败不确定性或对抗的行动才需要判定。
- 必须先调用判定工具并取得回执，再叙述结果。
- 公开判定的目标只写玩家已知的行动。若目标、机械细节或结果会透露玩家尚不知道的事，调用前选暗骰（\`visibility: "hidden"\`），正文只呈现玩家当下能感知的后果。
- 判定成功必须实现已声明的目标，失败则不实现，不论情节是否看似合理。
- 大成功与大失败按工具的固定规则兑现，不能由叙述改写。
- 取得回执后不得更改该行动的目标或判定数值，也不得为同一行动重掷。
- 辅助掷骰（roll_dice）与算术（calculate）只决定伤害、数量等数值，不能推翻已经结算的判定。
${bagLine}- 参数不合法属于工具错误，不等于行动失败；修正参数后重新调用即可。`
    : `- Use available materials when sufficient; read relevant character or state documents first when check inputs are missing, then supply the action's goal and the scheme's required numeric inputs in the arguments. Only actions with uncertain success or opposition need a check.
- Call the check tool and receive its receipt before narrating the outcome.
- Phrase public goals using only actions known to the player. If a goal, mechanical detail, or outcome would reveal something unknown to the player, choose a hidden roll (\`visibility: "hidden"\`) before resolving and narrate only consequences the player can perceive now.
- A success must fulfil the declared goal and a failure must not, regardless of whether the story seems plausible.
- Critical outcomes follow the tool's fixed rules and cannot be rewritten by narration.
- After a draw, never change that action's goal or check inputs, and never reroll the same action.
- Auxiliary dice (roll_dice) and arithmetic (calculate) decide numeric values such as damage or quantities; they never reverse a resolved check.
${bagLine}- Invalid arguments are tool errors, not failed actions; correct the arguments and call the tool again.`;
}

/**
 * Runtime-owned rules at the world placeholder of a tabletop world. The block
 * is world-derived and carries no preset state, so a scheme never requires a
 * preset change. Exact per-tool mechanics live in the attached tool
 * definitions so play prompts do not repeat them verbatim.
 */
export function tabletopWorldRulesBlock(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): { source: string; markdown: string } {
  const label = gameplayLabel(gameplay, locale);
  const checkTool = resolutionCheckToolForScheme(gameplay.scheme);
  const contract = tabletopBindingContract(gameplay, locale);
  const markdown =
    locale === "zh-CN"
      ? `# 跑团判定规则

本世界是跑团世界，判定方案为 ${label}。使用随附的 \`${checkTool}\` 执行行动判定，辅以 \`roll_dice\` 与 \`calculate\` 处理伤害、数量等数值；各工具的数值细则以随附工具定义为准。

## 绑定契约

${contract}`
      : `# Tabletop resolution rules

This world is tabletop, with resolution scheme ${label}. Use the attached \`${checkTool}\` tool for action checks, with \`roll_dice\` and \`calculate\` for auxiliary numeric values; follow the attached tool definitions for exact rules.

## Binding contract

${contract}`;
  return { source: "runtime:world-placeholder/gameplay", markdown };
}

/**
 * Runtime-owned minimal fallback injected into runtime_system when continuing a
 * tabletop world on a legacy frozen context that lacks the world-placeholder
 * gameplay rules block, provided the active tool set actually exposes the
 * scheme's check tool. Independent of optional play.tabletop.
 */
export function tabletopContinuationFallbackBlock(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): { source: string; markdown: string } {
  const label = gameplayLabel(gameplay, locale);
  const checkTool = resolutionCheckToolForScheme(gameplay.scheme);
  const contract = tabletopBindingContract(gameplay, locale);
  const markdown =
    locale === "zh-CN"
      ? `# 跑团续玩判定底线

本世界是跑团世界（方案：${label}，判定工具：\`${checkTool}\`）。以下最小绑定契约由 Runtime 固定生效：

${contract}`
      : `# Tabletop continuation binding rules

This world is tabletop (scheme: ${label}, check tool: \`${checkTool}\`). The Runtime-fixed binding contract below applies:

${contract}`;
  return { source: "runtime:tabletop-continuation-fallback", markdown };
}

/**
 * Author-side statement of a tabletop package or world revision: the mode and
 * scheme, what a write may change, and the scheme's rules.
 */
export function tabletopAuthoringRulesBlock(
  gameplay: TabletopGameplay,
  target: "setting" | "world-revision",
  locale: AppLocale,
): { source: string; markdown: string } {
  const label = gameplayLabel(gameplay, locale);
  const rules = tabletopSchemeRules(gameplay, locale);
  const source =
    target === "setting"
      ? "runtime:content-package/gameplay"
      : "runtime:world-revision/gameplay";
  const markdown =
    target === "setting"
      ? locale === "zh-CN"
        ? `# 玩法模式与判定方案

当前内容包是跑团内容包，当前判定方案为 ${label}。玩法模式固定为跑团，不能改为互动式小说。判定方案可通过写入 control/gameplay.json 改为 d20、d100 或 bag；这只影响之后创建的世界，已有世界不随源内容包变化。改变方案时，应同步调整人物数值、难度与规则，使其符合新方案的数值尺度。

当前方案的判定工具规则：

${rules}`
        : `# Gameplay mode and resolution scheme

This content package is tabletop, with current resolution scheme ${label}. The gameplay mode is fixed as tabletop and cannot become interactive fiction. The scheme may be changed by writing control/gameplay.json to d20, d100 or bag. The change affects only worlds created later; existing worlds never follow the source package. When changing the scheme, adjust character values, difficulty and rules so they match the new scheme's numeric scale.

Check-tool rules for the current scheme:

${rules}`
      : locale === "zh-CN"
        ? `# 玩法模式与判定方案（固定）

当前修订的世界是跑团世界，判定方案为 ${label}。玩法模式与判定方案在世界创建后固定，修订不能修改 control/gameplay.json。数值与难度须遵循该方案。

当前方案的判定工具规则：

${rules}`
        : `# Gameplay mode and resolution scheme (fixed)

The world under revision is tabletop, with resolution scheme ${label}. Its gameplay mode and scheme were fixed at creation; a revision cannot change control/gameplay.json. Numeric values and difficulty must follow this scheme.

Check-tool rules for the current scheme:

${rules}`;
  const bag =
    gameplay.scheme === "bag" ? `\n\n${bagAuthoringGuidance(locale)}` : "";
  return { source, markdown: `${markdown}${bag}` };
}

/**
 * Authoring guidance for a chaos-bag scheme: the default bag, or a bag the world
 * documents, and who maintains its contents. Only the bag scheme carries it.
 */
export function bagAuthoringGuidance(locale: AppLocale): string {
  return locale === "zh-CN"
    ? `## 混乱袋内容

- 默认袋：世界文档未定义标记时，判定使用默认袋：+1、0×2、-1×2、-2、大成功、大失败。
- 世界自定义袋：在世界文档中写明每种标记的名称与数量，并且每种标记恰好写明修正值或大成功／大失败之一。判定时必须读取该清单，并原样提供。
- 袋内容的变化由你在世界文档中维护。每次抽取后标记放回，抽取本身不改变袋。`
    : `## Chaos-bag contents

- Default bag: when the world documents define no tokens, the check uses the default bag: +1, 0 ×2, -1 ×2, -2, critical success, critical failure.
- World-documented bag: write each token's label and count in the world documents, and give each token exactly one of a modifier or a critical outcome. Read that list and supply it exactly when checking.
- You maintain any change to the bag's contents in the world documents. Each drawn token returns to the bag, so drawing never changes the bag itself.`;
}

/** The receipt sent after a successful gameplay write; it teaches the new scheme's rules mid-conversation. */
export function tabletopSchemeReceipt(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): string {
  const rules = tabletopSchemeRules(gameplay, locale);
  const receipt =
    locale === "zh-CN"
      ? `新判定方案规则（之后请按此调整数值与难度）：\n\n${rules}`
      : `New resolution-scheme rules (adjust numbers and difficulty to match from now on):\n\n${rules}`;
  return gameplay.scheme === "bag"
    ? `${receipt}\n\n${bagAuthoringGuidance(locale)}`
    : receipt;
}
