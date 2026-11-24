import { splitGraphemes } from "unicode-segmenter/grapheme";

export interface OriginalRange {
  start: number;
  end: number;
}

export function normalizeLiteral(
  value: string,
  caseSensitive: boolean,
): string {
  const normalized = value.normalize("NFKC");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function normalizeHistoryText(
  source: string,
  caseSensitive: boolean,
): string {
  let normalized = source.normalize("NFKC");
  // Canonical normalization preserves grapheme boundaries. Compatibility
  // normalization can compose across them (e.g. ㄱㅏ), so preserve the
  // historical per-grapheme NFKC behavior when compatibility changed the text.
  if (normalized !== source && normalized !== source.normalize("NFC")) {
    normalized = "";
    for (const grapheme of splitGraphemes(source))
      normalized += grapheme.normalize("NFKC");
  }
  // History lowercases the whole message for contextual casing (final sigma).
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function mapLiteralSource(
  source: string,
  caseSensitive: boolean,
  offsetUnit: "codePoints" | "codeUnits",
): { normalized: string; ranges: OriginalRange[] } {
  let normalized = "";
  const ranges: OriginalRange[] = [];
  let start = 0;
  for (const grapheme of splitGraphemes(source)) {
    const transformed = normalizeLiteral(grapheme, caseSensitive);
    const end =
      start +
      (offsetUnit === "codePoints"
        ? Array.from(grapheme).length
        : grapheme.length);
    const range = { start, end };
    // String searches return UTF-16 indices. Each normalized unit maps back
    // to the entire original grapheme, including compatibility expansions.
    for (let remaining = transformed.length; remaining > 0; remaining--)
      ranges.push(range);
    normalized += transformed;
    start = end;
  }
  return { normalized, ranges };
}
