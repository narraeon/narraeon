import type {
  ArithmeticOperation,
  ArithmeticReceipt,
  BagReceipt,
  ResolutionCriticalOutcome,
  D100Receipt,
  D20Receipt,
  DiceReceipt,
  ResolutionOutcome,
  ResolutionReceipt,
} from "../protocol/resolution.ts";
import { uiText } from "./i18n.ts";

export type ResolutionTone = ResolutionOutcome | "neutral";

export interface ResolutionFact {
  label: string;
  value: string;
}

export interface ResolutionTokenRow {
  label: string;
  count: string;
  effect: string;
}

/**
 * Display strings for one resolution receipt. Every string is derived from the
 * structured receipt fields and localized through uiText at call time.
 */
export interface ResolutionPresentation {
  tone: ResolutionTone;
  /** The collapsed line without its outcome word, for example `推开石门 · d20 14 + 3 = 17 ≥ 15`. */
  summary: string;
  /** Localized outcome word; null for dice and arithmetic, which carry no outcome. */
  outcome: string | null;
  /** The full collapsed line, `summary` followed by ` · outcome` when there is one. */
  headline: string;
  facts: ResolutionFact[];
  /** Present only for a chaos bag: every token of the bag used for the draw. */
  tokens: ResolutionTokenRow[] | null;
}

export function presentResolution(
  receipt: ResolutionReceipt,
): ResolutionPresentation {
  switch (receipt.kind) {
    case "d20":
      return presentD20(receipt);
    case "d100":
      return presentD100(receipt);
    case "bag":
      return presentBag(receipt);
    case "dice":
      return presentDice(receipt);
    case "arithmetic":
      return presentArithmetic(receipt);
  }
}

function presentD20(receipt: D20Receipt): ResolutionPresentation {
  const { modifier, difficulty, mode, dice, selected, total, margin } = receipt;
  const die =
    mode === "normal"
      ? `d20 ${selected}`
      : uiText("d20 {mode} {dice} 取 {die}", {
          mode: modeLabel(mode),
          dice: dice.join("/"),
          die: selected,
        });
  const outcome = receipt.outcome;
  return presentation(
    receipt.goal,
    outcome,
    [
      `${die}${operand(modifier)} = ${total} ${total >= difficulty ? "≥" : "<"} ${difficulty}`,
    ],
    [
      fact("行动", receipt.goal),
      fact("修正", signed(modifier)),
      fact("难度", String(difficulty)),
      fact("掷骰方式", modeLabel(mode)),
      fact("掷出的骰", dice.join("、")),
      fact("采用的骰", String(selected)),
      fact("总值", String(total)),
      fact("差值（总值 − 难度）", signed(margin)),
      fact("结果", outcomeLabel(outcome)),
    ],
    null,
  );
}

function presentD100(receipt: D100Receipt): ResolutionPresentation {
  const { target, bonusDice, penaltyDice, units, tens, candidates } = receipt;
  const { selected, margin, outcome } = receipt;
  const tensRule =
    tens.length > 1
      ? bonusDice > penaltyDice
        ? uiText("奖励骰取较低的十位")
        : uiText("惩罚骰取较高的十位")
      : null;
  const note =
    bonusDice === penaltyDice
      ? []
      : [bonusDice > penaltyDice ? uiText("奖励骰") : uiText("惩罚骰")];
  return presentation(
    receipt.goal,
    outcome,
    [`d100 ${selected} ${selected <= target ? "≤" : ">"} ${target}`, ...note],
    [
      fact("行动", receipt.goal),
      fact("目标值", String(target)),
      fact("奖励骰", String(bonusDice)),
      fact("惩罚骰", String(penaltyDice)),
      fact("个位", String(units)),
      fact("十位骰", tens.join("、")),
      fact("候选值", candidates.join("、")),
      ...(tensRule === null ? [] : [fact("选取", tensRule)]),
      fact("采用的结果", String(selected)),
      fact("余量（目标值 − 结果）", signed(margin)),
      fact("结果", outcomeLabel(outcome)),
    ],
    null,
  );
}

function presentBag(receipt: BagReceipt): ResolutionPresentation {
  const { value, difficulty, drawn, tokens, defaultBag } = receipt;
  const source = defaultBag ? uiText("默认混乱袋") : uiText("世界混乱袋");
  const drawnLabel = bagTokenLabel(drawn);
  const tokenRows = tokens.map((token) => ({
    label: bagTokenLabel(token),
    count: String(token.count),
    effect:
      token.outcome === undefined
        ? signed(token.modifier ?? 0)
        : outcomeLabel(token.outcome),
  }));
  const common = [
    fact("行动", receipt.goal),
    fact("属性值", String(value)),
    fact("难度", String(difficulty)),
    fact("袋子", source),
    fact("抽到", drawnLabel),
  ];
  if (drawn.outcome !== undefined)
    return presentation(
      receipt.goal,
      receipt.outcome,
      [uiText("抽到 {token}", { token: drawnLabel })],
      [...common, fact("效果", outcomeLabel(drawn.outcome))],
      tokenRows,
    );
  const modifier = drawn.modifier ?? 0;
  const total = receipt.total ?? value + modifier;
  const margin = receipt.margin ?? total - difficulty;
  return presentation(
    receipt.goal,
    receipt.outcome,
    [
      uiText("抽到 {token}", { token: drawnLabel }),
      `${value}${operand(modifier)} = ${total} ${total >= difficulty ? "≥" : "<"} ${difficulty}`,
    ],
    [
      ...common,
      fact("修正", signed(modifier)),
      fact("总值", String(total)),
      fact("差值（总值 − 难度）", signed(margin)),
      fact("结果", outcomeLabel(receipt.outcome)),
    ],
    tokenRows,
  );
}

/**
 * The default bag names its two special tokens by outcome key. Show the outcome
 * word for them; the receipt and the engine keep the stored label unchanged.
 */
function bagTokenLabel(token: {
  label: string;
  outcome?: ResolutionCriticalOutcome;
}): string {
  if (token.outcome !== undefined && token.label === token.outcome)
    return outcomeLabel(token.outcome);
  return token.label;
}

function presentDice(receipt: DiceReceipt): ResolutionPresentation {
  const { count, sides, modifier, dice, total } = receipt;
  const notation = `${count}d${sides}${compactModifier(modifier)}`;
  const calculation =
    count === 1 && modifier === 0
      ? String(total)
      : `${dice.join(" + ")}${modifier === 0 ? "" : operand(modifier)} = ${total}`;
  return presentation(
    receipt.goal,
    null,
    [`${notation} = ${calculation}`],
    [
      fact("行动", receipt.goal),
      fact("骰子", `${count}d${sides}`),
      fact("修正", signed(modifier)),
      fact("掷出的骰", dice.join("、")),
      fact("总值", String(total)),
    ],
    null,
  );
}

function presentArithmetic(receipt: ArithmeticReceipt): ResolutionPresentation {
  const { left, right, operation, total } = receipt;
  return presentation(
    receipt.goal,
    null,
    [
      `${operandText(left)} ${operationSymbol(operation)} ${operandText(right)} = ${numberText(total)}`,
    ],
    [
      fact("行动", receipt.goal),
      fact("左值", numberText(left)),
      fact("运算", operationLabel(operation)),
      fact("右值", numberText(right)),
      fact("结果", numberText(total)),
    ],
    null,
  );
}

function presentation(
  goal: string,
  outcome: ResolutionOutcome | null,
  segments: readonly string[],
  facts: ResolutionFact[],
  tokens: ResolutionTokenRow[] | null,
): ResolutionPresentation {
  const summary = [goal, ...segments].join(" · ");
  const outcomeWord = outcome === null ? null : outcomeLabel(outcome);
  return {
    tone: outcome ?? "neutral",
    summary,
    outcome: outcomeWord,
    headline: outcomeWord === null ? summary : `${summary} · ${outcomeWord}`,
    facts,
    tokens,
  };
}

export function outcomeLabel(outcome: ResolutionOutcome): string {
  switch (outcome) {
    case "success":
      return uiText("成功");
    case "failure":
      return uiText("失败");
    case "critical_success":
      return uiText("大成功");
    case "critical_failure":
      return uiText("大失败");
  }
}

function modeLabel(mode: D20Receipt["mode"]): string {
  switch (mode) {
    case "normal":
      return uiText("普通");
    case "advantage":
      return uiText("优势");
    case "disadvantage":
      return uiText("劣势");
  }
}

function operationLabel(operation: ArithmeticOperation): string {
  switch (operation) {
    case "add":
      return uiText("加");
    case "subtract":
      return uiText("减");
    case "multiply":
      return uiText("乘");
    case "divide":
      return uiText("除");
  }
}

function operationSymbol(operation: ArithmeticOperation): string {
  switch (operation) {
    case "add":
      return "+";
    case "subtract":
      return "−";
    case "multiply":
      return "×";
    case "divide":
      return "÷";
  }
}

function fact(label: string, value: string): ResolutionFact {
  return { label: uiText(label), value };
}

/** A signed value for a result or modifier, using the typographic minus sign. */
function signed(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}

/** A dice-notation suffix: `+1`, `−1`, or nothing for zero. */
function compactModifier(value: number): string {
  if (value === 0) return "";
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

/** The right-hand side of a calculation: ` + 3` or ` + (−2)`. */
function operand(value: number): string {
  return value < 0 ? ` + (−${Math.abs(value)})` : ` + ${value}`;
}

function operandText(value: number): string {
  return value < 0 ? `(−${Math.abs(value)})` : numberText(value);
}

function numberText(value: number): string {
  const magnitude = String(Number(Math.abs(value).toPrecision(12)));
  return value < 0 ? `−${magnitude}` : magnitude;
}
