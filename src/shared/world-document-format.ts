export const maxShortRefLength = 32;

export function documentCodec(path: string): "yaml" | "markdown" | null {
  if (/\.ya?ml$/iu.test(path)) return "yaml";
  if (/\.md$/iu.test(path)) return "markdown";
  return null;
}

export function markdownFrontMatter(source: string): {
  yaml: string;
  yamlStart: number;
  bodyStart: number;
} | null {
  const opening = /^---\r?\n/u.exec(source);
  if (opening === null) return null;
  const yamlStart = opening[0].length;
  const closingDelimiter = /\r?\n---\r?\n/gu;
  closingDelimiter.lastIndex = yamlStart;
  const closing = closingDelimiter.exec(source);
  if (closing === null) return null;
  return {
    yaml: source.slice(yamlStart, closing.index),
    yamlStart,
    bodyStart: closingDelimiter.lastIndex,
  };
}

export function nextAvailableShortRef(
  hint: string,
  occupied: ReadonlySet<string>,
): string {
  if (!occupied.has(hint)) return hint;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${hint.slice(0, maxShortRefLength - suffixText.length)}${suffixText}`;
    if (!occupied.has(candidate)) return candidate;
  }
}
