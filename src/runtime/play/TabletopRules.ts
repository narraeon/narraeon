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
 * Runtime-owned rules at the world placeholder of a tabletop world. The block
 * is world-derived and carries no preset state, so a scheme never requires a
 * preset change.
 */
export function tabletopWorldRulesBlock(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): { source: string; markdown: string } {
  const label = gameplayLabel(gameplay, locale);
  const rules = tabletopSchemeRules(gameplay, locale);
  const markdown =
    locale === "zh-CN"
      ? `# 跑团判定规则

本世界是跑团世界，判定方案为 ${label}。以下规则由 Runtime 固定，随本世界的玩法身份生效。

## 判定工具

${rules}

## 辅助工具

- roll_dice：辅助数值掷骰，用于伤害、数量等，不重新裁决已确定的行动成败。
- calculate：对两个数执行加减乘除，不产生随机数，不修改世界。

## 绑定契约

- 调用判定工具前，先声明行动目标、所用数值与难度；只有有成败不确定性或对抗的行动才需要判定。
- 必须先调用判定工具并取得回执，再叙述结果。
- 判定成功必须实现已声明的目标，失败则不实现，不论情节是否看似合理。
- 大成功与大失败按工具的固定规则兑现，不能由叙述改写。
- 掷骰之后不得更改该行动的目标或难度，也不得为同一行动重掷。
- 辅助掷骰与算术只决定伤害、数量等数值，不能推翻已经结算的判定。
- 世界文档中定义的混乱袋必须读取，并原样提供其当前标记清单；袋的变化由你在世界文档中维护。
- 参数不合法属于工具错误，不等于行动失败；修正参数后重新调用即可。`
      : `# Tabletop resolution rules

This world is tabletop, with resolution scheme ${label}. The Runtime-fixed rules below apply because of this world's gameplay identity.

## Check tool

${rules}

## Auxiliary tools

- roll_dice: auxiliary numeric dice for damage, quantities and similar values. It never re-decides a resolved action.
- calculate: add, subtract, multiply or divide two numbers. It draws no randomness and changes no world state.

## Binding contract

- Before calling the check tool, declare the action's goal, the inputs and the difficulty. Only actions with uncertain success or opposition need a check.
- Call the check tool and receive its receipt before narrating the outcome.
- A success must fulfil the declared goal and a failure must not, regardless of whether the story seems plausible.
- Critical outcomes follow the tool's fixed rules and cannot be rewritten by narration.
- After a draw, never change that action's goal or difficulty, and never reroll the same action.
- Auxiliary dice and arithmetic decide numeric values such as damage or quantities; they never reverse a resolved check.
- A chaos bag defined in the world documents must be read and supplied exactly as its current token list. You maintain the bag's changes in the world documents.
- Invalid arguments are tool errors, not failed actions; correct the arguments and call the tool again.`;
  return { source: "runtime:world-placeholder/gameplay", markdown };
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
  return { source, markdown };
}

/** The receipt sent after a successful gameplay write; it teaches the new scheme's rules mid-conversation. */
export function tabletopSchemeReceipt(
  gameplay: TabletopGameplay,
  locale: AppLocale,
): string {
  const rules = tabletopSchemeRules(gameplay, locale);
  return locale === "zh-CN"
    ? `新判定方案规则（之后请按此调整数值与难度）：\n\n${rules}`
    : `New resolution-scheme rules (adjust numbers and difficulty to match from now on):\n\n${rules}`;
}
