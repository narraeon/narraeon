import type { AppLocale } from "../../protocol/appPreferences.ts";

/**
 * Restores a tool name the provider proxy mangled. A proxy may rename a
 * declared tool to `mcp__<server>__<word>_<name>` and fail to restore it, so
 * the model sometimes sends only a suffix such as `margin_world_create`.
 *
 * Only a name that ends in `_<T>` for exactly one provided tool `T` is
 * restored. Prefix, fuzzy, and case-folded matches are not attempted, and
 * the candidates are the tools the current request provides, never the whole
 * registry.
 */
export type ToolNameResolution =
  | { kind: "exact"; name: string }
  | { kind: "alias"; name: string; declared: string }
  | { kind: "rejected"; candidates: string[] };

export function resolveToolName(
  called: string,
  provided: readonly string[],
): ToolNameResolution {
  if (provided.includes(called)) return { kind: "exact", name: called };
  const candidates = provided.filter(
    (name) => called.length > name.length && called.endsWith(`_${name}`),
  );
  if (candidates.length === 1)
    return { kind: "alias", name: candidates[0]!, declared: called };
  return { kind: "rejected", candidates };
}

/** The Runtime note appended to a result whose call was restored by alias. */
export function renderToolAliasNote(
  declared: string,
  name: string,
  locale: AppLocale,
): string {
  return locale === "zh-CN"
    ? `Runtime 说明："${declared}" 不是本次提供的工具，已按 "${name}" 执行。请使用声明的工具名。`
    : `Runtime note: "${declared}" is not a declared tool; it was executed as "${name}". Call tools by their declared names.`;
}
