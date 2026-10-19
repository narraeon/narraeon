/**
 * Structured mechanical receipts for tabletop resolution tools.
 *
 * Receipts store numbers and identifiers only. Localized prose is rendered by
 * Runtime for the model and by the UI from these fields, never stored as text.
 */

export type ResolutionOutcome =
  "success" | "failure" | "critical_success" | "critical_failure";

export type ResolutionCriticalOutcome = Extract<
  ResolutionOutcome,
  "critical_success" | "critical_failure"
>;

export type D20Mode = "normal" | "advantage" | "disadvantage";

export type ArithmeticOperation = "add" | "subtract" | "multiply" | "divide";

export interface D20Receipt {
  kind: "d20";
  goal: string;
  modifier: number;
  difficulty: number;
  mode: D20Mode;
  /** Raw dice in roll order: one for normal, two for advantage or disadvantage. */
  dice: number[];
  selected: number;
  total: number;
  margin: number;
  outcome: ResolutionOutcome;
}

export interface D100Receipt {
  kind: "d100";
  goal: string;
  target: number;
  bonusDice: number;
  penaltyDice: number;
  units: number;
  /** One tens die per remaining bonus or penalty after cancellation, in roll order. */
  tens: number[];
  /** Complete results, one per tens die. Selection is the lowest for bonus and highest for penalty. */
  candidates: number[];
  selected: number;
  margin: number;
  outcome: ResolutionOutcome;
}

export interface BagToken {
  label: string;
  count: number;
  modifier?: number;
  outcome?: ResolutionCriticalOutcome;
}

/** The token that was drawn. Its count belongs to the bag, not the draw. */
export type BagDraw = Omit<BagToken, "count">;

export interface BagReceipt {
  kind: "bag";
  goal: string;
  value: number;
  difficulty: number;
  defaultBag: boolean;
  tokens: BagToken[];
  drawn: BagDraw;
  /**
   * Present only for a numeric draw. A special token decides the outcome
   * without a comparison, so the receipt carries no total or margin for it.
   */
  total?: number;
  margin?: number;
  outcome: ResolutionOutcome;
}

export interface DiceReceipt {
  kind: "dice";
  goal: string;
  count: number;
  sides: number;
  modifier: number;
  dice: number[];
  total: number;
}

export interface ArithmeticReceipt {
  kind: "arithmetic";
  goal: string;
  left: number;
  right: number;
  operation: ArithmeticOperation;
  total: number;
}

export type ResolutionReceipt =
  D20Receipt | D100Receipt | BagReceipt | DiceReceipt | ArithmeticReceipt;

/** Shared Narraeon v1 rules; the engine and the receipt validator both use them. */
export function d20Outcome(
  selected: number,
  total: number,
  difficulty: number,
): ResolutionOutcome {
  if (selected === 20) return "critical_success";
  if (selected === 1) return "critical_failure";
  return total >= difficulty ? "success" : "failure";
}

export function arithmeticTotal(
  operation: ArithmeticOperation,
  left: number,
  right: number,
): number {
  switch (operation) {
    case "add":
      return left + right;
    case "subtract":
      return left - right;
    case "multiply":
      return left * right;
    case "divide":
      return left / right;
  }
}

export function percentileCandidate(tens: number, units: number): number {
  return tens * 10 + units || 100;
}

export function d100Outcome(
  selected: number,
  target: number,
): ResolutionOutcome {
  if (selected === 1) return "critical_success";
  if (selected === 100) return "critical_failure";
  return selected <= target ? "success" : "failure";
}

const maximumMagnitude = 1_000_000;
const maximumGoalLength = 1000;
const maximumLabelLength = 80;
const maximumBagTokens = 100;
const outcomes: readonly string[] = [
  "success",
  "failure",
  "critical_success",
  "critical_failure",
];
const criticalOutcomes: readonly string[] = [
  "critical_success",
  "critical_failure",
];
const operations: readonly string[] = ["add", "subtract", "multiply", "divide"];
const modes: readonly string[] = ["normal", "advantage", "disadvantage"];

/** Strict structural and arithmetic validation for a persisted or received receipt. */
export function isResolutionReceipt(
  value: unknown,
): value is ResolutionReceipt {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "d20":
      return isD20Receipt(value);
    case "d100":
      return isD100Receipt(value);
    case "bag":
      return isBagReceipt(value);
    case "dice":
      return isDiceReceipt(value);
    case "arithmetic":
      return isArithmeticReceipt(value);
    default:
      return false;
  }
}

function isD20Receipt(value: Record<string, unknown>): boolean {
  if (
    !hasShape(
      value,
      [
        "kind",
        "goal",
        "modifier",
        "difficulty",
        "mode",
        "dice",
        "selected",
        "total",
        "margin",
        "outcome",
      ],
      [],
    ) ||
    !isGoal(value.goal) ||
    !isInteger(value.modifier, -maximumMagnitude, maximumMagnitude) ||
    !isInteger(value.difficulty, -maximumMagnitude, maximumMagnitude) ||
    typeof value.mode !== "string" ||
    !modes.includes(value.mode) ||
    !Array.isArray(value.dice) ||
    !value.dice.every((die) => isInteger(die, 1, 20)) ||
    value.dice.length !== (value.mode === "normal" ? 1 : 2) ||
    !isOutcome(value.outcome)
  )
    return false;
  const dice = value.dice;
  const selected =
    value.mode === "disadvantage" ? Math.min(...dice) : Math.max(...dice);
  const modifier = value.modifier;
  const difficulty = value.difficulty;
  const total = selected + modifier;
  return (
    value.selected === selected &&
    value.total === total &&
    value.margin === total - difficulty &&
    value.outcome === d20Outcome(selected, total, difficulty)
  );
}

function isD100Receipt(value: Record<string, unknown>): boolean {
  if (
    !hasShape(
      value,
      [
        "kind",
        "goal",
        "target",
        "bonusDice",
        "penaltyDice",
        "units",
        "tens",
        "candidates",
        "selected",
        "margin",
        "outcome",
      ],
      [],
    ) ||
    !isGoal(value.goal) ||
    !isInteger(value.target, 0, 100) ||
    !isInteger(value.bonusDice, 0, 2) ||
    !isInteger(value.penaltyDice, 0, 2) ||
    !isInteger(value.units, 0, 9) ||
    !Array.isArray(value.tens) ||
    !value.tens.every((ten) => isInteger(ten, 0, 9)) ||
    !Array.isArray(value.candidates) ||
    !isOutcome(value.outcome)
  )
    return false;
  const bonus = value.bonusDice;
  const penalty = value.penaltyDice;
  const units = value.units;
  const tens = value.tens;
  const candidates = value.candidates as unknown[];
  if (tens.length !== Math.abs(bonus - penalty) + 1) return false;
  if (candidates.length !== tens.length) return false;
  const expected = tens.map((ten) => percentileCandidate(ten, units));
  if (!candidates.every((item, index) => item === expected[index]))
    return false;
  const selected =
    bonus < penalty ? Math.max(...expected) : Math.min(...expected);
  const target = value.target;
  return (
    value.selected === selected &&
    value.margin === target - selected &&
    value.outcome === d100Outcome(selected, target)
  );
}

function isBagReceipt(value: Record<string, unknown>): boolean {
  if (
    !hasShape(
      value,
      [
        "kind",
        "goal",
        "value",
        "difficulty",
        "defaultBag",
        "tokens",
        "drawn",
        "outcome",
      ],
      ["total", "margin"],
    ) ||
    !isGoal(value.goal) ||
    !isNumber(value.value) ||
    !isNumber(value.difficulty) ||
    typeof value.defaultBag !== "boolean" ||
    !Array.isArray(value.tokens) ||
    value.tokens.length < 1 ||
    value.tokens.length > maximumBagTokens ||
    !value.tokens.every(isBagToken) ||
    !isOutcome(value.outcome)
  )
    return false;
  const tokens = value.tokens;
  if (new Set(tokens.map((token) => token.label)).size !== tokens.length)
    return false;
  if (!isBagDraw(value.drawn)) return false;
  const drawn = value.drawn;
  const token = tokens.find((item) => item.label === drawn.label);
  if (
    token === undefined ||
    token.modifier !== drawn.modifier ||
    token.outcome !== drawn.outcome
  )
    return false;
  if (drawn.outcome !== undefined)
    return (
      value.total === undefined &&
      value.margin === undefined &&
      value.outcome === drawn.outcome
    );
  if (
    drawn.modifier === undefined ||
    !isNumber(value.total) ||
    !isNumber(value.margin)
  )
    return false;
  const difficulty = value.difficulty;
  const total = value.value + drawn.modifier;
  return (
    value.total === total &&
    value.margin === total - difficulty &&
    value.outcome === (total >= difficulty ? "success" : "failure")
  );
}

function isDiceReceipt(value: Record<string, unknown>): boolean {
  if (
    !hasShape(
      value,
      ["kind", "goal", "count", "sides", "modifier", "dice", "total"],
      [],
    ) ||
    !isGoal(value.goal) ||
    !isInteger(value.count, 1, 100) ||
    !isInteger(value.sides, 2, 1000) ||
    !isNumber(value.modifier) ||
    !Array.isArray(value.dice) ||
    value.dice.length !== value.count ||
    !value.dice.every((die) => isInteger(die, 1, value.sides as number))
  )
    return false;
  const dice = value.dice;
  return value.total === dice.reduce((sum, die) => sum + die, value.modifier);
}

function isArithmeticReceipt(value: Record<string, unknown>): boolean {
  if (
    !hasShape(
      value,
      ["kind", "goal", "left", "right", "operation", "total"],
      [],
    ) ||
    !isGoal(value.goal) ||
    !isNumber(value.left) ||
    !isNumber(value.right) ||
    typeof value.operation !== "string" ||
    !operations.includes(value.operation)
  )
    return false;
  const left = value.left;
  const right = value.right;
  if (value.operation === "divide" && right === 0) return false;
  const total = arithmeticTotal(
    value.operation as ArithmeticOperation,
    left,
    right,
  );
  return Number.isFinite(total) && value.total === total;
}

function isBagToken(value: unknown): value is BagToken {
  return (
    isRecord(value) &&
    hasShape(value, ["label", "count"], ["modifier", "outcome"]) &&
    isLabel(value.label) &&
    isInteger(value.count, 1, 100) &&
    exactlyOneOf(value) &&
    (value.modifier === undefined || isNumber(value.modifier)) &&
    (value.outcome === undefined || isCriticalOutcome(value.outcome))
  );
}

function isBagDraw(value: unknown): value is BagDraw {
  return (
    isRecord(value) &&
    hasShape(value, ["label"], ["modifier", "outcome"]) &&
    isLabel(value.label) &&
    exactlyOneOf(value) &&
    (value.modifier === undefined || isNumber(value.modifier)) &&
    (value.outcome === undefined || isCriticalOutcome(value.outcome))
  );
}

function exactlyOneOf(value: Record<string, unknown>): boolean {
  return (value.modifier === undefined) !== (value.outcome === undefined);
}

function hasShape(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((key) => value[key] !== undefined) &&
    Object.entries(value).every(
      ([key, item]) =>
        item !== undefined &&
        (required.includes(key) || optional.includes(key)),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= maximumMagnitude
  );
}

function isInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function isGoal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /\S/.test(value) &&
    Array.from(value).length <= maximumGoalLength
  );
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maximumLabelLength
  );
}

function isOutcome(value: unknown): value is ResolutionOutcome {
  return typeof value === "string" && outcomes.includes(value);
}

function isCriticalOutcome(value: unknown): value is ResolutionCriticalOutcome {
  return typeof value === "string" && criticalOutcomes.includes(value);
}
