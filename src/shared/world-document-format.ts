export const maxShortRefLength = 32;

export function documentCodec(path: string): "yaml" | "markdown" | null {
  if (/\.ya?ml$/iu.test(path)) return "yaml";
  if (/\.md$/iu.test(path)) return "markdown";
  return null;
}

export function markdownFrontMatter(source: string): string {
  if (!source.startsWith("---\n")) return "";
  const end = source.indexOf("\n---\n", 4);
  return end < 0 ? "" : source.slice(4, end);
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
