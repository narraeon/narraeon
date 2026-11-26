import { splitGraphemes } from "unicode-segmenter/grapheme";
import type { AppLocale } from "../protocol/appPreferences.ts";

export const localDisplayNameLimit = 160;

const labels = {
  en: { copy: "Copy", fork: "Fork" },
  "zh-CN": { copy: "副本", fork: "分叉" },
} as const;

export function derivedDisplayName(
  sourceName: string,
  kind: "copy" | "fork",
  locale: AppLocale,
  existingNames: Iterable<string>,
): string {
  const occupied = new Set(Array.from(existingNames, nameKey));
  const source = sourceName.replace(/[\r\n]+/gu, " ").trim();
  for (let number = 1; ; number += 1) {
    const suffix = ` · ${labels[locale][kind]}${number === 1 ? "" : ` ${number}`}`;
    const budget = localDisplayNameLimit - Array.from(suffix).length;
    const candidate = fitSourceName(source, budget) + suffix;
    if (!occupied.has(nameKey(candidate))) return candidate;
  }
}

function nameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

function fitSourceName(source: string, budget: number): string {
  if (Array.from(source).length <= budget) return source;
  let remaining = budget - 1;
  let prefix = "";
  for (const grapheme of splitGraphemes(source)) {
    remaining -= Array.from(grapheme).length;
    if (remaining < 0) break;
    prefix += grapheme;
  }
  return `${prefix.trimEnd()}…`;
}
