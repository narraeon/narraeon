// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";

import type {
  ArithmeticReceipt,
  BagReceipt,
  D100Receipt,
  D20Receipt,
  DiceReceipt,
} from "../../src/protocol/resolution.ts";
import { setWebLocale } from "../../src/web/i18n.ts";
import {
  presentResolution,
  type ResolutionPresentation,
} from "../../src/web/resolutionPresentation.ts";

afterEach(() => setWebLocale("zh-CN"));

const d20Success: D20Receipt = {
  kind: "d20",
  goal: "推开石门",
  modifier: 3,
  difficulty: 15,
  mode: "normal",
  dice: [14],
  selected: 14,
  total: 17,
  margin: 2,
  outcome: "success",
};

const d100Bonus: D100Receipt = {
  kind: "d100",
  goal: "推开石门",
  target: 50,
  bonusDice: 1,
  penaltyDice: 0,
  units: 3,
  tens: [3, 5],
  candidates: [33, 53],
  selected: 33,
  margin: 17,
  outcome: "success",
};

const bagNumeric: BagReceipt = {
  kind: "bag",
  goal: "推开石门",
  value: 3,
  difficulty: 2,
  defaultBag: true,
  tokens: [
    { label: "+1", count: 2, modifier: 1 },
    { label: "0", count: 4, modifier: 0 },
    { label: "−1", count: 2, modifier: -1 },
    { label: "骷髅", count: 1, outcome: "critical_failure" },
  ],
  drawn: { label: "−1", modifier: -1 },
  total: 2,
  margin: 0,
  outcome: "success",
};

/** A special token decides the outcome, so the receipt has no total or margin. */
const specialBag: BagReceipt = {
  kind: "bag",
  goal: "推开石门",
  value: 3,
  difficulty: 2,
  defaultBag: true,
  tokens: bagNumeric.tokens,
  drawn: { label: "祝福", outcome: "critical_success" },
  outcome: "critical_success",
};

const dice: DiceReceipt = {
  kind: "dice",
  goal: "推开石门",
  count: 2,
  sides: 6,
  modifier: 1,
  dice: [3, 5],
  total: 9,
};

const arithmetic: ArithmeticReceipt = {
  kind: "arithmetic",
  goal: "推开石门",
  left: 3,
  right: 4,
  operation: "multiply",
  total: 12,
};

describe("判定收据的中文展示", () => {
  test("d20 普通掷骰把采用的骰、修正、比较与结果放进一行", () => {
    const presented = presentResolution(d20Success);

    expect(presented.tone).toBe("success");
    expect(presented.headline).toBe("推开石门 · d20 14 + 3 = 17 ≥ 15 · 成功");
    expect(presented.facts).toContainEqual({ label: "难度", value: "15" });
    expect(presented.facts).toContainEqual({ label: "结果", value: "成功" });
    expect(presented.tokens).toBeNull();
  });

  test("d20 优势同时显示两颗骰和采用的骰", () => {
    const presented = presentResolution({
      ...d20Success,
      mode: "advantage",
      dice: [12, 18],
      selected: 18,
      total: 21,
      margin: 6,
    });

    expect(presented.headline).toBe(
      "推开石门 · d20 优势 12/18 取 18 + 3 = 21 ≥ 15 · 成功",
    );
    expect(presented.facts).toContainEqual({
      label: "掷出的骰",
      value: "12、18",
    });
    expect(presented.facts).toContainEqual({ label: "采用的骰", value: "18" });
  });

  test("d20 劣势取较低的骰，负修正写成括号形式", () => {
    const presented = presentResolution({
      ...d20Success,
      modifier: -2,
      mode: "disadvantage",
      dice: [12, 5],
      selected: 5,
      total: 3,
      difficulty: 10,
      margin: -7,
      outcome: "failure",
    });

    expect(presented.headline).toBe(
      "推开石门 · d20 劣势 12/5 取 5 + (−2) = 3 < 10 · 失败",
    );
    expect(presented.tone).toBe("failure");
    expect(presented.facts).toContainEqual({
      label: "差值（总值 − 难度）",
      value: "−7",
    });
  });

  test("d20 大成功与大失败由原始骰决定，并保留结果词", () => {
    const critical = presentResolution({
      ...d20Success,
      modifier: 0,
      difficulty: 25,
      dice: [20],
      selected: 20,
      total: 20,
      margin: -5,
      outcome: "critical_success",
    });
    expect(critical.headline).toBe("推开石门 · d20 20 + 0 = 20 < 25 · 大成功");
    expect(critical.tone).toBe("critical_success");

    const failure = presentResolution({
      ...d20Success,
      modifier: 2,
      difficulty: 5,
      dice: [1],
      selected: 1,
      total: 3,
      margin: -2,
      outcome: "critical_failure",
    });
    expect(failure.headline).toBe("推开石门 · d20 1 + 2 = 3 < 5 · 大失败");
    expect(failure.tone).toBe("critical_failure");
  });

  test("d100 按结果与目标值比较，奖励骰说明取较低的十位", () => {
    const presented = presentResolution(d100Bonus);

    expect(presented.headline).toBe("推开石门 · d100 33 ≤ 50 · 奖励骰 · 成功");
    expect(presented.facts).toContainEqual({
      label: "选取",
      value: "奖励骰取较低的十位",
    });
    expect(presented.facts).toContainEqual({
      label: "候选值",
      value: "33、53",
    });
  });

  test("d100 惩罚骰取较高的十位，失败时使用大于号", () => {
    const presented = presentResolution({
      ...d100Bonus,
      bonusDice: 0,
      penaltyDice: 1,
      units: 7,
      tens: [2, 6],
      candidates: [27, 67],
      selected: 67,
      margin: -17,
      outcome: "failure",
    });

    expect(presented.headline).toBe("推开石门 · d100 67 > 50 · 惩罚骰 · 失败");
    expect(presented.facts).toContainEqual({
      label: "选取",
      value: "惩罚骰取较高的十位",
    });
  });

  test("d100 奖励骰与惩罚骰抵消后不说明骰子修正", () => {
    const presented = presentResolution({
      ...d100Bonus,
      bonusDice: 1,
      penaltyDice: 1,
      tens: [4],
      candidates: [43],
      selected: 43,
      margin: 7,
    });

    expect(presented.headline).toBe("推开石门 · d100 43 ≤ 50 · 成功");
    expect(presented.facts.map(({ label }) => label)).not.toContain("选取");
  });

  test("d100 的 01 与 100 分别是大成功与大失败", () => {
    const critical = presentResolution({
      ...d100Bonus,
      bonusDice: 0,
      tens: [0],
      candidates: [1],
      units: 1,
      selected: 1,
      margin: 49,
      outcome: "critical_success",
    });
    expect(critical.headline).toBe("推开石门 · d100 1 ≤ 50 · 大成功");

    const failure = presentResolution({
      ...d100Bonus,
      bonusDice: 0,
      tens: [0],
      candidates: [100],
      units: 0,
      selected: 100,
      margin: -50,
      outcome: "critical_failure",
    });
    expect(failure.headline).toBe("推开石门 · d100 100 > 50 · 大失败");
  });

  test("混乱袋数值抽取列出加减与比较，并给出整袋标记表", () => {
    const presented = presentResolution(bagNumeric);

    expect(presented.headline).toBe(
      "推开石门 · 抽到 −1 · 3 + (−1) = 2 ≥ 2 · 成功",
    );
    expect(presented.facts).toContainEqual({
      label: "袋子",
      value: "默认混乱袋",
    });
    expect(presented.facts).toContainEqual({ label: "总值", value: "2" });
    expect(presented.tokens).toEqual([
      { label: "+1", count: "2", effect: "+1" },
      { label: "0", count: "4", effect: "0" },
      { label: "−1", count: "2", effect: "−1" },
      { label: "骷髅", count: "1", effect: "大失败" },
    ]);
  });

  test("混乱袋特殊标记直接显示效果，不显示总值与差值", () => {
    const presented = presentResolution(specialBag);

    expect(presented.headline).toBe("推开石门 · 抽到 祝福 · 大成功");
    expect(presented.tone).toBe("critical_success");
    expect(presented.facts.map(({ label }) => label)).not.toContain("总值");
    expect(presented.facts).toContainEqual({ label: "效果", value: "大成功" });
  });

  test("混乱袋标明世界自定义的袋子", () => {
    const presented = presentResolution({ ...bagNumeric, defaultBag: false });

    expect(presented.facts).toContainEqual({
      label: "袋子",
      value: "世界混乱袋",
    });
  });

  test("掷骰与算术没有结果词，因此保持中性色", () => {
    const rolled = presentResolution(dice);
    expect(rolled.tone).toBe("neutral");
    expect(rolled.outcome).toBeNull();
    expect(rolled.headline).toBe("推开石门 · 2d6+1 = 3 + 5 + 1 = 9");

    expect(
      presentResolution({
        ...dice,
        count: 1,
        sides: 20,
        modifier: 0,
        dice: [4],
        total: 4,
      }).headline,
    ).toBe("推开石门 · 1d20 = 4");

    const calculated = presentResolution(arithmetic);
    expect(calculated.tone).toBe("neutral");
    expect(calculated.headline).toBe("推开石门 · 3 × 4 = 12");
    expect(
      presentResolution({
        ...arithmetic,
        operation: "subtract",
        right: -3,
        total: 6,
      }).headline,
    ).toBe("推开石门 · 3 − (−3) = 6");
    expect(
      presentResolution({
        ...arithmetic,
        operation: "divide",
        left: 7,
        right: 2,
        total: 3.5,
      }).headline,
    ).toBe("推开石门 · 7 ÷ 2 = 3.5");
  });
});

describe("判定收据的英文展示", () => {
  const goal = "Open the stone door";

  test("英文收据只使用英文标签与结果词", () => {
    setWebLocale("en");
    const presented = presentResolution({ ...d20Success, goal });

    expect(presented.headline).toBe(
      "Open the stone door · d20 14 + 3 = 17 ≥ 15 · Success",
    );
    expect(presented.facts).toEqual([
      { label: "Action", value: "Open the stone door" },
      { label: "Modifier", value: "+3" },
      { label: "Difficulty", value: "15" },
      { label: "Roll mode", value: "Normal" },
      { label: "Dice rolled", value: "14" },
      { label: "Die used", value: "14" },
      { label: "Total", value: "17" },
      { label: "Margin (total − difficulty)", value: "+2" },
      { label: "Result", value: "Success" },
    ]);
  });

  test("英文 d20 优势、劣势与大失败", () => {
    setWebLocale("en");
    expect(
      presentResolution({
        ...d20Success,
        goal,
        mode: "advantage",
        dice: [12, 18],
        selected: 18,
        total: 21,
      }).headline,
    ).toBe(
      "Open the stone door · d20 Advantage 12/18 keep 18 + 3 = 21 ≥ 15 · Success",
    );
    expect(
      presentResolution({
        ...d20Success,
        goal,
        mode: "disadvantage",
        dice: [12, 5],
        selected: 5,
        total: 8,
        difficulty: 10,
        margin: -2,
        outcome: "failure",
      }).headline,
    ).toBe(
      "Open the stone door · d20 Disadvantage 12/5 keep 5 + 3 = 8 < 10 · Failure",
    );
    expect(
      presentResolution({
        ...d20Success,
        goal,
        dice: [1],
        selected: 1,
        total: 4,
        outcome: "critical_failure",
      }).headline,
    ).toBe("Open the stone door · d20 1 + 3 = 4 < 15 · Critical failure");
  });

  test("英文 d100 奖励骰与大成功", () => {
    setWebLocale("en");
    const bonus = presentResolution({ ...d100Bonus, goal });
    expect(bonus.headline).toBe(
      "Open the stone door · d100 33 ≤ 50 · Bonus dice · Success",
    );
    expect(bonus.facts).toContainEqual({
      label: "Selection",
      value: "Bonus dice keep the lower tens",
    });
    expect(
      presentResolution({
        ...d100Bonus,
        goal,
        bonusDice: 0,
        tens: [0],
        candidates: [1],
        units: 1,
        selected: 1,
        margin: 49,
        outcome: "critical_success",
      }).headline,
    ).toBe("Open the stone door · d100 1 ≤ 50 · Critical success");
  });

  test("英文混乱袋显示抽到的标记、计算与特殊标记", () => {
    setWebLocale("en");
    const numeric = presentResolution({ ...bagNumeric, goal });
    expect(numeric.headline).toBe(
      "Open the stone door · Drew −1 · 3 + (−1) = 2 ≥ 2 · Success",
    );
    expect(numeric.tokens).toContainEqual({
      label: "骷髅",
      count: "1",
      effect: "Critical failure",
    });
    expect(numeric.facts).toContainEqual({
      label: "Bag",
      value: "Default chaos bag",
    });

    const special = presentResolution({ ...specialBag, goal });
    expect(special.headline).toBe(
      "Open the stone door · Drew 祝福 · Critical success",
    );
  });

  test("英文骰子与算术没有结果词", () => {
    setWebLocale("en");
    expect(presentResolution({ ...dice, goal }).headline).toBe(
      "Open the stone door · 2d6+1 = 3 + 5 + 1 = 9",
    );
    expect(presentResolution({ ...arithmetic, goal }).headline).toBe(
      "Open the stone door · 3 × 4 = 12",
    );
    expect(presentResolution({ ...arithmetic, goal }).facts).toContainEqual({
      label: "Operation",
      value: "Multiply",
    });
  });

  test("英文收据不包含中文文字", () => {
    setWebLocale("en");
    const receipts = [
      { ...d20Success, goal },
      { ...d100Bonus, goal },
      { ...bagNumeric, goal },
      { ...dice, goal },
      { ...arithmetic, goal },
    ];
    for (const receipt of receipts) {
      const presented = presentResolution(receipt);
      const text = [
        presented.headline,
        ...presented.facts.flatMap(({ label, value }) => [label, value]),
        ...(presented.tokens ?? []).flatMap(({ label, count, effect }) => [
          label,
          count,
          effect,
        ]),
      ];
      const cjk = text.filter((item) => /[㐀-鿿]/u.test(item));
      expect(cjk).toEqual(receipt.kind === "bag" ? ["骷髅"] : []);
    }
  });
});

/** The strings a player reads; the internal tone key is not displayed. */
function displayedText(presented: ResolutionPresentation[]): string {
  return presented
    .flatMap((item) => [
      item.headline,
      ...item.facts.flatMap(({ label, value }) => [label, value]),
      ...(item.tokens ?? []).flatMap(({ label, count, effect }) => [
        label,
        count,
        effect,
      ]),
    ])
    .join("\n");
}

describe("默认混乱袋的特殊标记", () => {
  const defaultTokens: BagReceipt["tokens"] = [
    { label: "+1", count: 1, modifier: 1 },
    { label: "0", count: 2, modifier: 0 },
    { label: "-1", count: 2, modifier: -1 },
    { label: "-2", count: 1, modifier: -2 },
    { label: "critical_success", count: 1, outcome: "critical_success" },
    { label: "critical_failure", count: 1, outcome: "critical_failure" },
  ];
  const defaultSpecial = (
    outcome: "critical_success" | "critical_failure",
  ): BagReceipt => ({
    kind: "bag",
    goal: "推开石门",
    value: 3,
    difficulty: 2,
    defaultBag: true,
    tokens: defaultTokens,
    drawn: { label: outcome, outcome },
    outcome,
  });

  test("中文界面把默认大成功与大失败标记显示为结果词，不显示原始键", () => {
    const success = presentResolution(defaultSpecial("critical_success"));
    expect(success.headline).toBe("推开石门 · 抽到特殊标记 · 大成功");
    expect(success.facts).toContainEqual({ label: "抽到", value: "特殊标记" });
    expect(success.tokens).toContainEqual({
      label: "大成功",
      count: "1",
      effect: "大成功",
    });

    const failure = presentResolution(defaultSpecial("critical_failure"));
    expect(failure.headline).toBe("推开石门 · 抽到特殊标记 · 大失败");
    expect(failure.tokens).toContainEqual({
      label: "大失败",
      count: "1",
      effect: "大失败",
    });
    expect(displayedText([success, failure])).not.toContain("critical_");
  });

  test("英文界面把默认特殊标记显示为英文结果词", () => {
    setWebLocale("en");
    const success = presentResolution({
      ...defaultSpecial("critical_success"),
      goal: "Open the stone door",
    });
    expect(success.headline).toBe(
      "Open the stone door · Drew a special token · Critical success",
    );
    expect(success.tokens).toContainEqual({
      label: "Critical success",
      count: "1",
      effect: "Critical success",
    });

    const failure = presentResolution({
      ...defaultSpecial("critical_failure"),
      goal: "Open the stone door",
    });
    expect(failure.headline).toBe(
      "Open the stone door · Drew a special token · Critical failure",
    );
    expect(failure.tokens).toContainEqual({
      label: "Critical failure",
      count: "1",
      effect: "Critical failure",
    });
    expect(displayedText([success, failure])).not.toContain("critical_");
  });

  test("自定义特殊标记保留自己的标签，不被替换为特殊标记", () => {
    const custom: BagReceipt = {
      ...defaultSpecial("critical_failure"),
      drawn: { label: "骷髅", outcome: "critical_failure" },
    };
    expect(presentResolution(custom).headline).toBe(
      "推开石门 · 抽到 骷髅 · 大失败",
    );
    expect(presentResolution(custom).facts).toContainEqual({
      label: "抽到",
      value: "骷髅",
    });
    setWebLocale("en");
    expect(
      presentResolution({ ...custom, goal: "Open the stone door" }).headline,
    ).toBe("Open the stone door · Drew 骷髅 · Critical failure");
  });

  test("收据保存的标记键不被修改", () => {
    const receipt = defaultSpecial("critical_failure");
    const before = JSON.stringify(receipt);
    presentResolution(receipt);
    expect(JSON.stringify(receipt)).toBe(before);
    expect(receipt.drawn.label).toBe("critical_failure");
    expect(receipt.tokens[5]?.label).toBe("critical_failure");
  });
});
