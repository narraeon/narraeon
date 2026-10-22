import type { AppLocale } from "../protocol/appPreferences.ts";
import {
  turnGuideLineSoftLimit,
  turnGuideLinesSoftLimit,
} from "./ordered-play-prompts.ts";

/** One line of the per-send turn guide and the ordered entry it came from. */
export interface TurnGuideLine {
  /** `preset:builtin/<id>`, `preset:prompt/<id>` or `world:control/frame.yaml#instructions[i]`. */
  source: string;
  text: string;
}

/**
 * The fixed Runtime header. It is mechanical: it tells the model what the
 * suffix is and that the prose, not a reply to the suffix, is wanted.
 */
export function turnGuideHeader(locale: AppLocale): string {
  return locale === "zh-CN"
    ? "[Runtime 本轮提示]\n以下是本轮写正文时最容易丢的要求，不要回应本提示，直接写正文。"
    : "[Runtime turn guide]\nThese are the requirements most easily lost while writing this turn's prose. Do not reply to this notice; write the prose.";
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
