import { expect, test } from "vitest";
import {
  resolutionMarkdown,
  resolutionToolDefinition,
  resolveTabletop,
  seededRandom,
} from "../../src/runtime/play/TabletopResolution.ts";
import {
  isResolutionReceipt,
  type ArithmeticReceipt,
  type BagReceipt,
  type D100Receipt,
  type D20Receipt,
  type DiceReceipt,
  type ResolutionReceipt,
} from "../../src/protocol/resolution.ts";

const sequence =
  (...values: number[]) =>
  (maximum: number) => {
    const value = values.shift();
    if (value === undefined || value >= maximum)
      throw new Error("Unexpected draw");
    return value;
  };

function resolved(
  name: Parameters<typeof resolveTabletop>[0],
  args: unknown,
  random: (maximum: number) => number,
): ResolutionReceipt {
  const receipt = resolveTabletop(name, args, random);
  expect(isResolutionReceipt(receipt)).toBe(true);
  return receipt;
}

test("d20 resolves thresholds, integer modifiers and critical overrides", () => {
  const check = (raw: number, difficulty: number) =>
    resolved(
      "d20_check",
      { goal: "Jump", modifier: 3, difficulty },
      sequence(raw - 1),
    );
  expect(check(10, 13)).toMatchObject({
    kind: "d20",
    mode: "normal",
    dice: [10],
    selected: 10,
    total: 13,
    margin: 0,
    outcome: "success",
  });
  expect(check(10, 14)).toMatchObject({ margin: -1, outcome: "failure" });
  expect(check(20, 9999)).toMatchObject({ outcome: "critical_success" });
  expect(check(1, -9999)).toMatchObject({ outcome: "critical_failure" });
  expect(
    resolved(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: 10, mode: "advantage" },
      sequence(0, 19),
    ),
  ).toMatchObject({ dice: [1, 20], selected: 20, outcome: "critical_success" });
  expect(
    resolved(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: 10, mode: "disadvantage" },
      sequence(0, 19),
    ),
  ).toMatchObject({ dice: [1, 20], selected: 1, outcome: "critical_failure" });
  expect(
    resolved(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: 10, mode: "advantage" },
      sequence(4, 9),
    ),
  ).toMatchObject({ selected: 10, total: 10, outcome: "success" });
});

test("d20 rejects non-integer and out-of-range modifiers before any draw", () => {
  const random = () => {
    throw new Error("drew before validation");
  };
  expect(() =>
    resolveTabletop(
      "d20_check",
      { goal: "Jump", modifier: 1.5, difficulty: 10 },
      random,
    ),
  ).toThrow("Invalid d20_check");
  expect(() =>
    resolveTabletop(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: "10" },
      random,
    ),
  ).toThrow("Invalid d20_check");
  expect(() =>
    resolveTabletop(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: 10.5 },
      random,
    ),
  ).toThrow("Invalid d20_check");
  expect(() =>
    resolveTabletop(
      "d20_check",
      { goal: "Jump", modifier: 0, difficulty: 10, mode: "sideways" },
      random,
    ),
  ).toThrow("Invalid d20_check");
  expect(() =>
    resolveTabletop(
      "d20_check",
      { goal: "", modifier: 0, difficulty: 5 },
      random,
    ),
  ).toThrow("Invalid d20_check");
});

test("percentile shares units, cancels bonus and penalty dice, and treats 00 with units 0 as 100", () => {
  expect(
    resolved("percentile_check", { goal: "Open", target: 100 }, sequence(0, 0)),
  ).toMatchObject({ selected: 100, outcome: "critical_failure" });
  expect(
    resolved("percentile_check", { goal: "Open", target: 0 }, sequence(0, 0)),
  ).toMatchObject({ selected: 100, outcome: "critical_failure" });
  expect(
    resolved("percentile_check", { goal: "Open", target: 0 }, sequence(1, 0)),
  ).toMatchObject({ selected: 1, outcome: "critical_success" });
  const bonus = resolved(
    "percentile_check",
    { goal: "Open", target: 20, bonusDice: 2, penaltyDice: 1 },
    sequence(0, 0, 2),
  );
  expect(bonus).toMatchObject({
    bonusDice: 2,
    penaltyDice: 1,
    units: 0,
    tens: [0, 2],
    candidates: [100, 20],
    selected: 20,
    margin: 0,
    outcome: "success",
  });
  expect(
    resolved(
      "percentile_check",
      { goal: "Open", target: 99, penaltyDice: 1 },
      sequence(0, 0, 2),
    ),
  ).toMatchObject({ selected: 100 });
  expect(
    resolved(
      "percentile_check",
      { goal: "Open", target: 20, bonusDice: 2, penaltyDice: 2 },
      sequence(1, 2),
    ),
  ).toMatchObject({ tens: [2], candidates: [21], outcome: "failure" });
  expect(
    resolved(
      "percentile_check",
      { goal: "Open", target: 100, bonusDice: 1 },
      sequence(9, 0, 9),
    ),
  ).toMatchObject({
    units: 9,
    candidates: [9, 99],
    selected: 9,
    outcome: "success",
  });
});

test("percentile critical boundaries and target limits are fixed", () => {
  expect(
    resolved("percentile_check", { goal: "Open", target: 1 }, sequence(1, 0)),
  ).toMatchObject({ selected: 1, outcome: "critical_success" });
  expect(
    resolved("percentile_check", { goal: "Open", target: 99 }, sequence(9, 8)),
  ).toMatchObject({ selected: 89, margin: 10, outcome: "success" });
  expect(
    resolved("percentile_check", { goal: "Open", target: 100 }, sequence(9, 8)),
  ).toMatchObject({ selected: 89, outcome: "success" });
  expect(() =>
    resolveTabletop(
      "percentile_check",
      { goal: "Open", target: 101 },
      sequence(),
    ),
  ).toThrow("Invalid percentile_check");
  expect(() =>
    resolveTabletop(
      "percentile_check",
      { goal: "Open", target: 50, bonusDice: 3 },
      sequence(),
    ),
  ).toThrow("Invalid percentile_check");
});

test("bag draws by weight with replacement and special tokens override the comparison", () => {
  const args = {
    goal: "Climb",
    value: 4,
    difficulty: 4,
    tokens: [
      { label: "0", count: 2, modifier: 0 },
      { label: "doom", count: 1, outcome: "critical_failure" },
    ],
  };
  expect(resolved("bag_check", args, sequence(1))).toMatchObject({
    defaultBag: false,
    drawn: { label: "0", modifier: 0 },
    total: 4,
    margin: 0,
    outcome: "success",
  });
  const special = resolved("bag_check", args, sequence(2));
  expect(special).toMatchObject({
    drawn: { label: "doom", outcome: "critical_failure" },
    outcome: "critical_failure",
  });
  expect(special).not.toHaveProperty("total");
  expect(special).not.toHaveProperty("margin");
  expect(args.tokens[1]).toEqual({
    label: "doom",
    count: 1,
    outcome: "critical_failure",
  });
});

test("default bag weights its eight slots as +1, 0 x2, -1 x2, -2, critical success, critical failure", () => {
  const args = { goal: "Strike", value: 2, difficulty: 3 };
  const drawn = (index: number) =>
    (resolved("bag_check", args, sequence(index)) as BagReceipt).drawn;
  expect(drawn(0)).toEqual({ label: "+1", modifier: 1 });
  expect(drawn(1)).toEqual({ label: "0", modifier: 0 });
  expect(drawn(2)).toEqual({ label: "0", modifier: 0 });
  expect(drawn(3)).toEqual({ label: "-1", modifier: -1 });
  expect(drawn(4)).toEqual({ label: "-1", modifier: -1 });
  expect(drawn(5)).toEqual({ label: "-2", modifier: -2 });
  expect(drawn(6)).toEqual({
    label: "critical_success",
    outcome: "critical_success",
  });
  expect(drawn(7)).toEqual({
    label: "critical_failure",
    outcome: "critical_failure",
  });
  expect(resolved("bag_check", args, sequence(0))).toMatchObject({
    defaultBag: true,
    total: 3,
    margin: 0,
    outcome: "success",
  });
  expect(resolved("bag_check", args, sequence(5))).toMatchObject({
    total: 0,
    margin: -3,
    outcome: "failure",
  });
});

test("bag rejects duplicate labels and tokens with both or neither modifier and outcome", () => {
  const base = { goal: "Climb", value: 0, difficulty: 0 };
  const reject = (tokens: unknown) =>
    expect(() =>
      resolveTabletop("bag_check", { ...base, tokens }, sequence(0)),
    ).toThrow("exactly one");
  reject([
    { label: "same", count: 1, modifier: 0 },
    { label: "same", count: 1, modifier: 1 },
  ]);
  reject([{ label: "bad", count: 1 }]);
  reject([
    {
      label: "both",
      count: 1,
      modifier: 1,
      outcome: "critical_success",
    },
  ]);
  reject([
    { label: "dup", count: 1, modifier: 1 },
    { label: "dup", count: 2, outcome: "critical_failure" },
  ]);
  expect(() =>
    resolveTabletop(
      "bag_check",
      { ...base, tokens: [{ label: "x", count: 1, outcome: "success" }] },
      sequence(0),
    ),
  ).toThrow("Invalid bag_check");
});

test("auxiliary dice and arithmetic have no verdict and reject bad arguments", () => {
  const dice = resolved(
    "roll_dice",
    { goal: "Damage", count: 2, sides: 6, modifier: 2 },
    sequence(0, 5),
  );
  expect(dice).toEqual({
    kind: "dice",
    goal: "Damage",
    count: 2,
    sides: 6,
    modifier: 2,
    dice: [1, 6],
    total: 9,
  });
  expect(dice).not.toHaveProperty("outcome");
  const subtraction = resolved(
    "calculate",
    { goal: "Health", left: 10, right: 3, operation: "subtract" },
    sequence(),
  );
  expect(subtraction).toEqual({
    kind: "arithmetic",
    goal: "Health",
    left: 10,
    right: 3,
    operation: "subtract",
    total: 7,
  });
  expect(subtraction).not.toHaveProperty("outcome");
  expect(() =>
    resolveTabletop(
      "calculate",
      { goal: "Health", left: 10, right: 0, operation: "divide" },
      sequence(),
    ),
  ).toThrow("zero");
  expect(() =>
    resolveTabletop(
      "roll_dice",
      { goal: "Damage", count: 101, sides: 6 },
      sequence(),
    ),
  ).toThrow("Invalid roll_dice");
  expect(() =>
    resolveTabletop(
      "calculate",
      { goal: "Health", left: 1e7, right: 1, operation: "add" },
      sequence(),
    ),
  ).toThrow("Invalid calculate");
});

test("seeded streams reproduce a call, separate identities, and stay unbiased in range", () => {
  const sample = (id: string, maximum = 100, length = 30) => {
    const random = seededRandom("1".repeat(64), id);
    return Array.from({ length }, () => random(maximum));
  };
  expect(sample("call1")).toEqual(sample("call1"));
  expect(sample("call1")).not.toEqual(sample("call2"));
  const otherSeed = seededRandom("2".repeat(64), "call1");
  expect(Array.from({ length: 30 }, () => otherSeed(100))).not.toEqual(
    sample("call1"),
  );

  const random = seededRandom("3".repeat(64), "bias");
  const counts = [0, 0, 0];
  const draws = 90_000;
  for (let index = 0; index < draws; index += 1) counts[random(3)]! += 1;
  for (const count of counts)
    expect(Math.abs(count / draws - 1 / 3)).toBeLessThan(0.01);
  for (const maximum of [1, 2, 10, 1_000_000]) {
    const values = seededRandom("4".repeat(64), `range-${maximum}`);
    for (let index = 0; index < 200; index += 1) {
      const value = values(maximum);
      expect(Number.isInteger(value) && value >= 0 && value < maximum).toBe(
        true,
      );
    }
  }
  expect(() => seededRandom("5".repeat(64), "bad")(0)).toThrow(
    "Invalid random bound",
  );
  expect(() => seededRandom("5".repeat(64), "bad")(1.5)).toThrow(
    "Invalid random bound",
  );
});

test("isResolutionReceipt accepts produced receipts and rejects inconsistent or extra fields", () => {
  const d20 = resolved(
    "d20_check",
    { goal: "Jump", modifier: 3, difficulty: 15, mode: "advantage" },
    sequence(13, 4),
  ) as D20Receipt;
  const d100 = resolved(
    "percentile_check",
    { goal: "Open", target: 50, bonusDice: 1 },
    sequence(3, 4, 0),
  ) as D100Receipt;
  const bag = resolved(
    "bag_check",
    { goal: "Climb", value: 4, difficulty: 4 },
    sequence(6),
  ) as BagReceipt;
  const bagNumeric = resolved(
    "bag_check",
    { goal: "Climb", value: 4, difficulty: 4 },
    sequence(0),
  ) as BagReceipt;
  const dice = resolved(
    "roll_dice",
    { goal: "Damage", count: 2, sides: 6 },
    sequence(0, 5),
  ) as DiceReceipt;
  const arithmetic = resolved(
    "calculate",
    { goal: "Health", left: 10, right: 4, operation: "divide" },
    sequence(),
  ) as ArithmeticReceipt;
  for (const receipt of [d20, d100, bag, bagNumeric, dice, arithmetic])
    expect(isResolutionReceipt(structuredClone(receipt))).toBe(true);

  const reject = (value: unknown) =>
    expect(isResolutionReceipt(value)).toBe(false);
  reject(null);
  reject([]);
  reject({ kind: "unknown", goal: "x" });
  reject({ ...d20, total: d20.total + 1 });
  reject({ ...d20, margin: d20.margin + 1 });
  reject({ ...d20, selected: 1 });
  reject({ ...d20, dice: [13] });
  reject({ ...d20, modifier: 1.5, total: 14.5, margin: -0.5 });
  reject({ ...d20, extra: true });
  reject({ ...d20, outcome: "critical_success" });
  reject({ ...d100, selected: 1, outcome: "success" });
  reject({ ...d100, tens: [3] });
  reject({ ...d100, candidates: [999] });
  reject({ ...bag, drawn: { label: "missing", outcome: "critical_success" } });
  reject({ ...bag, outcome: "success" });
  reject({ ...bagNumeric, total: 99 });
  reject({
    ...bagNumeric,
    tokens: [
      { label: "x", count: 1, modifier: 0, outcome: "critical_success" },
    ],
  });
  reject({ ...dice, outcome: "success" });
  reject({ ...dice, dice: [7, 1] });
  reject({ ...arithmetic, operation: "divide", right: 0 });
  reject({ ...arithmetic, total: Number.NaN });
  reject({ ...arithmetic, total: Number.POSITIVE_INFINITY });
  reject({ ...arithmetic, outcome: "success" });
});

test("resolution rendering is localized, structured-field based, and never leaks prose into receipts", () => {
  const receipt = resolved(
    "d20_check",
    { goal: "推开石门", modifier: 3, difficulty: 15 },
    sequence(13),
  );
  const zh = resolutionMarkdown(receipt, "zh-CN");
  expect(zh).toContain("# 推开石门");
  expect(zh).toContain("判定：d20，普通");
  expect(zh).toContain("修正：+3；难度：15");
  expect(zh).toContain("结果：成功");
  expect(zh).not.toContain("Outcome");
  const en = resolutionMarkdown(receipt, "en");
  expect(en).toContain("# 推开石门");
  expect(en).toContain("Check: d20, normal");
  expect(en).toContain("Calculation: 14 +3 = 17; 17 >= 15; margin +2");
  expect(en).toContain("Outcome: success");
  expect(en).not.toContain("结果");
  expect(Object.keys(receipt).sort()).toEqual([
    "dice",
    "difficulty",
    "goal",
    "kind",
    "margin",
    "mode",
    "modifier",
    "outcome",
    "selected",
    "total",
  ]);

  const bag = resolved(
    "bag_check",
    { goal: "Climb", value: 4, difficulty: 4 },
    sequence(7),
  );
  expect(resolutionMarkdown(bag, "en")).toContain(
    "Special token decides the result: critical failure",
  );
  expect(resolutionMarkdown(bag, "zh-CN")).toContain(
    "特殊标记直接决定结果：大失败",
  );
  const d100 = resolved(
    "percentile_check",
    { goal: "开门", target: 50, bonusDice: 2, penaltyDice: 1 },
    sequence(3, 0, 4),
  );
  expect(resolutionMarkdown(d100, "zh-CN")).toContain(
    "相消后 1 枚奖励骰，取低",
  );
  expect(resolutionMarkdown(d100, "en")).toContain(
    "net 1 bonus die; lowest kept",
  );
  const arithmetic = resolved(
    "calculate",
    { goal: "Health", left: 10, right: 3, operation: "subtract" },
    sequence(),
  );
  expect(resolutionMarkdown(arithmetic, "zh-CN")).toContain("计算：10 - 3 = 7");
  expect(resolutionMarkdown(arithmetic, "en")).not.toContain("结果");
});

test("tool definitions keep bilingual descriptions and the shared input schema", () => {
  const zh = resolutionToolDefinition("d20_check", "zh-CN");
  const en = resolutionToolDefinition("d20_check", "en");
  expect(zh.name).toBe("d20_check");
  expect(zh.description).toContain("大成功");
  expect(en.description).toContain("Resolve a d20 check");
  expect(zh.inputSchema).toEqual(en.inputSchema);
  expect(zh.inputSchema).toMatchObject({
    properties: {
      modifier: { type: "integer" },
      difficulty: { type: "integer" },
    },
  });
});
