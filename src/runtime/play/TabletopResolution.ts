import { createHmac } from "node:crypto";
import { Ajv } from "ajv";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  arithmeticTotal,
  d100Outcome,
  d20Outcome,
  isResolutionReceipt,
  percentileCandidate,
  type ArithmeticOperation,
  type BagDraw,
  type BagReceipt,
  type BagToken,
  type D100Receipt,
  type D20Mode,
  type D20Receipt,
  type ArithmeticReceipt,
  type DiceReceipt,
  type ResolutionReceipt,
} from "../../protocol/resolution.ts";

export const resolutionToolNames = [
  "d20_check",
  "percentile_check",
  "bag_check",
  "roll_dice",
  "calculate",
] as const;
export type ResolutionToolName = (typeof resolutionToolNames)[number];

export function isResolutionTool(name: string): name is ResolutionToolName {
  return resolutionToolNames.some((item) => item === name);
}

const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const number = { type: "number", minimum: -1_000_000, maximum: 1_000_000 };
const goal = { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" };
const object = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const resolutionSchemas: Record<ResolutionToolName, object> = {
  d20_check: object(
    {
      goal,
      modifier: integer(-1_000_000, 1_000_000),
      difficulty: integer(-1_000_000, 1_000_000),
      mode: { enum: ["normal", "advantage", "disadvantage"] },
    },
    ["goal", "modifier", "difficulty"],
  ),
  percentile_check: object(
    {
      goal,
      target: integer(0, 100),
      bonusDice: integer(0, 2),
      penaltyDice: integer(0, 2),
    },
    ["goal", "target"],
  ),
  bag_check: object(
    {
      goal,
      value: number,
      difficulty: number,
      tokens: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: object(
          {
            label: { type: "string", minLength: 1, maxLength: 80 },
            count: integer(1, 100),
            modifier: number,
            outcome: { enum: ["critical_success", "critical_failure"] },
          },
          ["label", "count"],
        ),
      },
    },
    ["goal", "value", "difficulty"],
  ),
  roll_dice: object(
    { goal, count: integer(1, 100), sides: integer(2, 1000), modifier: number },
    ["goal", "count", "sides"],
  ),
  calculate: object(
    {
      goal,
      left: number,
      right: number,
      operation: { enum: ["add", "subtract", "multiply", "divide"] },
    },
    ["goal", "left", "right", "operation"],
  ),
};

const descriptions: Record<ResolutionToolName, [string, string]> = {
  d20_check: [
    "掷 d20 判定。原始 20 大成功、1 大失败；其余取值加 modifier >= difficulty 成功。优势两骰取高，劣势取低。先确定目标和数值，结果必须兑现。",
    "Resolve a d20 check. Selected raw 20 critically succeeds, 1 critically fails; otherwise roll + modifier >= difficulty succeeds. Advantage keeps the higher of two dice, disadvantage the lower. Declare the goal and values before rolling; honour the result.",
  ],
  percentile_check: [
    "百分骰判定。共享个位，奖励/惩罚额外十位骰相消后取较低/较高的完整结果，00 与个位0表示100。最终1大成功、100大失败，其余 <= target 成功。",
    "Resolve a percentile check. Bonus/penalty tens dice cancel, share one units die, and select the lowest/highest complete result; 00 with units 0 means 100. Selected 1 critically succeeds, 100 critically fails; otherwise <= target succeeds.",
  ],
  bag_check: [
    "从当前标记清单按数量抽一枚并放回。数值 value + 标记修正 >= difficulty 成功；特殊标记覆盖成败。省略 tokens 使用默认袋（+1、0×2、-1×2、-2、大成功、大失败）。自定义袋先从世界文档读取，原样提供；每种标记必须恰好有 modifier 或 outcome。",
    "Draw one token by quantity, with replacement. value + token modifier >= difficulty succeeds; a special outcome overrides comparison. Omit tokens for the default bag (+1, 0 x2, -1 x2, -2, critical success, critical failure). Read a custom bag from world documents and supply it exactly; every token has exactly one modifier or outcome.",
  ],
  roll_dice: [
    "辅助数值掷骰：count 枚 sides 面骰求和加 modifier。用于伤害、数量等，不重新裁决已确定的行动成败。",
    "Roll auxiliary numeric dice: sum count dice of sides faces and add modifier. Use for damage or quantities, not to reverse a resolved action.",
  ],
  calculate: [
    "对两个数执行加减乘除，不产生随机数，不修改世界。",
    "Add, subtract, multiply or divide two numbers without randomness or world changes.",
  ],
};

export function resolutionToolDefinition(
  name: ResolutionToolName,
  locale: AppLocale,
) {
  return {
    name,
    description: descriptions[name][locale === "zh-CN" ? 0 : 1],
    inputSchema: structuredClone(resolutionSchemas[name]),
  };
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  resolutionToolNames.map((name) => [
    name,
    ajv.compile(resolutionSchemas[name]),
  ]),
) as Record<ResolutionToolName, ReturnType<typeof ajv.compile>>;

const defaultBagTokens: BagToken[] = [
  { label: "+1", count: 1, modifier: 1 },
  { label: "0", count: 2, modifier: 0 },
  { label: "-1", count: 2, modifier: -1 },
  { label: "-2", count: 1, modifier: -2 },
  { label: "critical_success", count: 1, outcome: "critical_success" },
  { label: "critical_failure", count: 1, outcome: "critical_failure" },
];

/** Rejection sampling over a secret persisted seed; independent per tool call. */
export function seededRandom(
  seed: string,
  identity: string,
): (maximum: number) => number {
  let counter = 0;
  return (maximum) => {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000)
      throw new Error("Invalid random bound");
    const limit = Math.floor(0x1_0000_0000 / maximum) * maximum;
    for (;;) {
      const value = createHmac("sha256", seed)
        .update(JSON.stringify([identity, counter++]))
        .digest()
        .readUInt32BE();
      if (value < limit) return value % maximum;
    }
  };
}

/** Resolve one validated tool call. Invalid arguments throw before any draw. */
export function resolveTabletop(
  name: ResolutionToolName,
  args: unknown,
  random: (maximum: number) => number,
): ResolutionReceipt {
  if (!validators[name](args))
    throw new Error(
      `Invalid ${name} parameters: ${ajv.errorsText(validators[name].errors)}`,
    );
  const input = args as Record<string, unknown>;
  const receipt =
    name === "d20_check"
      ? resolveD20(input, random)
      : name === "percentile_check"
        ? resolveD100(input, random)
        : name === "bag_check"
          ? resolveBag(input, random)
          : name === "roll_dice"
            ? resolveDice(input, random)
            : resolveArithmetic(input);
  if (!isResolutionReceipt(receipt))
    throw new Error("Calculation produced an invalid resolution receipt");
  return receipt;
}

function roll(random: (maximum: number) => number, sides: number): number {
  return random(sides) + 1;
}

function resolveD20(
  input: Record<string, unknown>,
  random: (maximum: number) => number,
): D20Receipt {
  const mode = (input.mode as D20Mode | undefined) ?? "normal";
  const modifier = input.modifier as number;
  const difficulty = input.difficulty as number;
  const dice = [roll(random, 20)];
  if (mode !== "normal") dice.push(roll(random, 20));
  const selected =
    mode === "disadvantage" ? Math.min(...dice) : Math.max(...dice);
  const total = selected + modifier;
  return {
    kind: "d20",
    goal: input.goal as string,
    modifier,
    difficulty,
    mode,
    dice,
    selected,
    total,
    margin: total - difficulty,
    outcome: d20Outcome(selected, total, difficulty),
  };
}

function resolveD100(
  input: Record<string, unknown>,
  random: (maximum: number) => number,
): D100Receipt {
  const bonusDice = (input.bonusDice as number | undefined) ?? 0;
  const penaltyDice = (input.penaltyDice as number | undefined) ?? 0;
  const target = input.target as number;
  const units = random(10);
  const net = bonusDice - penaltyDice;
  const tens = Array.from({ length: Math.abs(net) + 1 }, () => random(10));
  const candidates = tens.map((ten) => percentileCandidate(ten, units));
  const selected = net < 0 ? Math.max(...candidates) : Math.min(...candidates);
  return {
    kind: "d100",
    goal: input.goal as string,
    target,
    bonusDice,
    penaltyDice,
    units,
    tens,
    candidates,
    selected,
    margin: target - selected,
    outcome: d100Outcome(selected, target),
  };
}

function resolveBag(
  input: Record<string, unknown>,
  random: (maximum: number) => number,
): BagReceipt {
  const defaultBag = input.tokens === undefined;
  const tokens = structuredClone(
    (input.tokens as BagToken[] | undefined) ?? defaultBagTokens,
  );
  if (
    new Set(tokens.map((token) => token.label)).size !== tokens.length ||
    tokens.some(
      (token) =>
        (token.modifier !== undefined) === (token.outcome !== undefined),
    )
  )
    throw new Error(
      "Bag labels must be unique, with exactly one modifier or outcome per token",
    );
  const weight = tokens.reduce((sum, token) => sum + token.count, 0);
  let index = random(weight);
  const token = tokens.find((item) => {
    index -= item.count;
    return index < 0;
  })!;
  const value = input.value as number;
  const difficulty = input.difficulty as number;
  const base = {
    kind: "bag" as const,
    goal: input.goal as string,
    value,
    difficulty,
    defaultBag,
    tokens,
  };
  if (token.outcome !== undefined)
    return {
      ...base,
      drawn: { label: token.label, outcome: token.outcome },
      outcome: token.outcome,
    };
  const drawn: BagDraw = { label: token.label, modifier: token.modifier! };
  const total = value + token.modifier!;
  return {
    ...base,
    drawn,
    total,
    margin: total - difficulty,
    outcome: total >= difficulty ? "success" : "failure",
  };
}

function resolveDice(
  input: Record<string, unknown>,
  random: (maximum: number) => number,
): DiceReceipt {
  const count = input.count as number;
  const sides = input.sides as number;
  const modifier = (input.modifier as number | undefined) ?? 0;
  const dice = Array.from({ length: count }, () => roll(random, sides));
  return {
    kind: "dice",
    goal: input.goal as string,
    count,
    sides,
    modifier,
    dice,
    total: dice.reduce((sum, die) => sum + die, modifier),
  };
}

function resolveArithmetic(input: Record<string, unknown>): ArithmeticReceipt {
  const left = input.left as number;
  const right = input.right as number;
  const operation = input.operation as ArithmeticOperation;
  if (operation === "divide" && right === 0)
    throw new Error("Cannot divide by zero");
  const total = arithmeticTotal(operation, left, right);
  if (!Number.isFinite(total)) throw new Error("Calculation is not finite");
  return {
    kind: "arithmetic",
    goal: input.goal as string,
    left,
    right,
    operation,
    total,
  };
}

const outcomeLabels = {
  "zh-CN": {
    success: "成功",
    failure: "失败",
    critical_success: "大成功",
    critical_failure: "大失败",
  },
  en: {
    success: "success",
    failure: "failure",
    critical_success: "critical success",
    critical_failure: "critical failure",
  },
} as const;

/** Localized text the model receives as the tool result. */
export function resolutionMarkdown(
  receipt: ResolutionReceipt,
  locale: AppLocale,
): string {
  const zh = locale === "zh-CN";
  const outcome = (value: keyof (typeof outcomeLabels)["en"]) =>
    outcomeLabels[zh ? "zh-CN" : "en"][value];
  const signed = (value: number) => (value >= 0 ? `+${value}` : `${value}`);
  const list = (values: readonly (number | string)[]) => values.join(", ");
  const lines: string[] = [`# ${receipt.goal}`, ""];
  if (receipt.kind === "d20") {
    const modes = zh
      ? { normal: "普通", advantage: "优势", disadvantage: "劣势" }
      : {
          normal: "normal",
          advantage: "advantage",
          disadvantage: "disadvantage",
        };
    const compared = receipt.total >= receipt.difficulty ? ">=" : "<";
    lines.push(
      zh
        ? `判定：d20，${modes[receipt.mode]}`
        : `Check: d20, ${modes[receipt.mode]}`,
      zh
        ? `修正：${signed(receipt.modifier)}；难度：${receipt.difficulty}`
        : `Modifier: ${signed(receipt.modifier)}; difficulty: ${receipt.difficulty}`,
      zh
        ? `掷骰：${list(receipt.dice)}；取值：${receipt.selected}`
        : `Dice: ${list(receipt.dice)}; selected: ${receipt.selected}`,
      zh
        ? `计算：${receipt.selected} ${signed(receipt.modifier)} = ${receipt.total}；${receipt.total} ${compared} ${receipt.difficulty}；差值 ${signed(receipt.margin)}`
        : `Calculation: ${receipt.selected} ${signed(receipt.modifier)} = ${receipt.total}; ${receipt.total} ${compared} ${receipt.difficulty}; margin ${signed(receipt.margin)}`,
    );
  } else if (receipt.kind === "d100") {
    const net = receipt.bonusDice - receipt.penaltyDice;
    const pool =
      net === 0
        ? zh
          ? "无额外十位骰"
          : "no extra tens die"
        : net > 0
          ? zh
            ? `奖励骰 ${receipt.bonusDice}、惩罚骰 ${receipt.penaltyDice}，相消后 ${net} 枚奖励骰，取低`
            : `${receipt.bonusDice} bonus and ${receipt.penaltyDice} penalty dice, net ${net} bonus die; lowest kept`
          : zh
            ? `奖励骰 ${receipt.bonusDice}、惩罚骰 ${receipt.penaltyDice}，相消后 ${-net} 枚惩罚骰，取高`
            : `${receipt.bonusDice} bonus and ${receipt.penaltyDice} penalty dice, net ${-net} penalty die; highest kept`;
    lines.push(
      zh ? `目标：${receipt.target}` : `Target: ${receipt.target}`,
      zh ? `判定：d100，${pool}` : `Check: d100, ${pool}`,
      zh
        ? `个位：${receipt.units}；十位：${list(receipt.tens)}`
        : `Units: ${receipt.units}; tens: ${list(receipt.tens)}`,
      zh
        ? `完整结果：${list(receipt.candidates)}；取值：${receipt.selected}`
        : `Complete results: ${list(receipt.candidates)}; selected: ${receipt.selected}`,
      zh
        ? `计算：${receipt.selected} <= ${receipt.target}；差值 ${signed(receipt.margin)}`
        : `Calculation: ${receipt.selected} <= ${receipt.target}; margin ${signed(receipt.margin)}`,
    );
  } else if (receipt.kind === "bag") {
    const tokens = receipt.tokens
      .map((token) => `${token.label} ×${token.count}`)
      .join(zh ? "、" : ", ");
    lines.push(
      zh
        ? `标记袋：${receipt.defaultBag ? "默认袋" : "自定义袋"}（${tokens}）`
        : `Bag: ${receipt.defaultBag ? "default" : "custom"} (${tokens})`,
      zh
        ? `抽取：${receipt.drawn.label}（有放回）`
        : `Drawn: ${receipt.drawn.label} (with replacement)`,
    );
    if (receipt.drawn.outcome !== undefined)
      lines.push(
        zh
          ? `特殊标记直接决定结果：${outcome(receipt.drawn.outcome)}`
          : `Special token decides the result: ${outcome(receipt.drawn.outcome)}`,
      );
    else {
      const compared = receipt.total! >= receipt.difficulty ? ">=" : "<";
      lines.push(
        zh
          ? `数值：${receipt.value}；标记修正：${signed(receipt.drawn.modifier!)}；难度：${receipt.difficulty}`
          : `Value: ${receipt.value}; token modifier: ${signed(receipt.drawn.modifier!)}; difficulty: ${receipt.difficulty}`,
        zh
          ? `计算：${receipt.value} ${signed(receipt.drawn.modifier!)} = ${receipt.total}；${receipt.total} ${compared} ${receipt.difficulty}；差值 ${signed(receipt.margin!)}`
          : `Calculation: ${receipt.value} ${signed(receipt.drawn.modifier!)} = ${receipt.total}; ${receipt.total} ${compared} ${receipt.difficulty}; margin ${signed(receipt.margin!)}`,
      );
    }
  } else if (receipt.kind === "dice") {
    lines.push(
      zh
        ? `掷骰：${receipt.count}d${receipt.sides}，结果 ${list(receipt.dice)}，修正 ${signed(receipt.modifier)}`
        : `Dice: ${receipt.count}d${receipt.sides}, results ${list(receipt.dice)}, modifier ${signed(receipt.modifier)}`,
      zh ? `合计：${receipt.total}` : `Total: ${receipt.total}`,
    );
  } else {
    lines.push(
      zh
        ? `计算：${receipt.left} ${arithmeticSymbol(receipt.operation)} ${receipt.right} = ${receipt.total}`
        : `Calculation: ${receipt.left} ${arithmeticSymbol(receipt.operation)} ${receipt.right} = ${receipt.total}`,
    );
  }
  if (
    receipt.kind === "d20" ||
    receipt.kind === "d100" ||
    receipt.kind === "bag"
  )
    lines.push(
      "",
      zh
        ? `结果：${outcome(receipt.outcome)}`
        : `Outcome: ${outcome(receipt.outcome)}`,
    );
  return lines.join("\n");
}

function arithmeticSymbol(operation: ArithmeticOperation): string {
  return { add: "+", subtract: "-", multiply: "×", divide: "÷" }[operation];
}
