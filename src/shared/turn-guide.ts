import type { AppLocale } from "../protocol/appPreferences.ts";
import {
  turnGuideLineSoftLimit,
  turnGuideLinesSoftLimit,
} from "./ordered-play-prompts.ts";

/** The source of the player's one-turn request line. */
export const turnNoteSource = "player:turn";

/** One line of the per-send turn guide and the ordered entry it came from. */
export interface TurnGuideLine {
  /** `preset:builtin/<id>`, `preset:prompt/<id>`, `world:control/frame.yaml#instructions[i]` or `player:turn`. */
  source: string;
  text: string;
}

/** Model-facing boundary only; the enclosed original is preserved exactly. */
export function playerInputText(locale: AppLocale, text: string): string {
  if (text.trim().length === 0) return text;
  const tag = locale === "zh-CN" ? "本轮玩家输入" : "current_player_input";
  return `<${tag}>\n${text}\n</${tag}>`;
}

/** Mechanical header points only to a new submission, never old input. */
export function turnGuideHeader(
  locale: AppLocale,
  hasPlayerInput = true,
): string {
  return locale === "zh-CN"
    ? hasPlayerInput
      ? "[Runtime 本轮提示]\n请回应 <本轮玩家输入> 中的内容，撰写最终正文时遵循以下要求。"
      : "[Runtime 本轮提示]\n撰写最终正文时遵循以下要求。"
    : hasPlayerInput
      ? "[Runtime turn guide]\nRespond to the content in <current_player_input>, following these requirements when writing the final prose."
      : "[Runtime turn guide]\nFollow these requirements when writing the final prose.";
}

/**
 * The player's one-turn request as a turn-guide line. The prefix only names
 * the source; it adds no constraint of its own.
 */
export function turnNoteLine(
  locale: AppLocale,
  turnNote: string,
): TurnGuideLine {
  return {
    source: turnNoteSource,
    text:
      locale === "zh-CN"
        ? `玩家本轮要求：${turnNote}`
        : `Player's request for this turn: ${turnNote}`,
  };
}

/**
 * Appends the player's request line to a compiled turn guide, creating the
 * suffix when no preset or world line exists. Rebuild the header for the
 * current submission while retaining the compiled lines.
 */
export function turnGuideWithTurnNote(
  locale: AppLocale,
  guide: { text: string; lines: TurnGuideLine[] } | undefined,
  turnNote: string | undefined,
  hasPlayerInput = true,
): { text: string; lines: TurnGuideLine[] } | undefined {
  if (turnNote === undefined && guide === undefined) return undefined;
  const lines = [
    ...(guide?.lines ?? []),
    ...(turnNote === undefined ? [] : [turnNoteLine(locale, turnNote)]),
  ];
  return { text: turnGuideText(locale, lines, hasPlayerInput), lines };
}

/** The complete suffix text: header, then one line per enabled entry in list order. */
export function turnGuideText(
  locale: AppLocale,
  lines: readonly Pick<TurnGuideLine, "text">[],
  hasPlayerInput = true,
): string {
  return [
    turnGuideHeader(locale, hasPlayerInput),
    ...lines.map(({ text }) => `- ${text}`),
  ].join("\n");
}

export interface TurnGuideWarning {
  kind: "line_length" | "line_count";
  /** Index of the offending line for `line_length`. */
  index?: number;
}

/** Soft-limit warnings; the compiler never rejects on them. */
export function turnGuideWarnings(
  lines: readonly Pick<TurnGuideLine, "text">[],
): TurnGuideWarning[] {
  const warnings: TurnGuideWarning[] = lines.flatMap(({ text }, index) =>
    [...text].length > turnGuideLineSoftLimit
      ? [{ kind: "line_length" as const, index }]
      : [],
  );
  if (lines.length > turnGuideLinesSoftLimit)
    warnings.push({ kind: "line_count" });
  return warnings;
}
