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

/**
 * The fixed Runtime header. It is mechanical: it tells the model what the
 * suffix is and that the prose, not a reply to the suffix, is wanted.
 */
export function turnGuideHeader(locale: AppLocale): string {
  return locale === "zh-CN"
    ? "[Runtime 本轮提示]\n以下是对这一轮正文的提示，来自预设、世界设定和玩家的临时要求。不要回应本提示，直接写正文。"
    : "[Runtime turn guide]\nThese are notes for this turn's prose, from the preset, the world, and the player's requests for this turn. Do not reply to this notice; write the prose.";
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
 * suffix when no preset or world line exists. Without a request the guide is
 * returned unchanged.
 */
export function turnGuideWithTurnNote(
  locale: AppLocale,
  guide: { text: string; lines: TurnGuideLine[] } | undefined,
  turnNote: string | undefined,
): { text: string; lines: TurnGuideLine[] } | undefined {
  if (turnNote === undefined) return guide;
  const lines = [...(guide?.lines ?? []), turnNoteLine(locale, turnNote)];
  return { text: turnGuideText(locale, lines), lines };
}

/** The complete suffix text: header, then one line per enabled entry in list order. */
export function turnGuideText(
  locale: AppLocale,
  lines: readonly Pick<TurnGuideLine, "text">[],
): string {
  return [
    turnGuideHeader(locale),
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
