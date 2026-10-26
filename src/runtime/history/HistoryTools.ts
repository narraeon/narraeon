import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { HistoryBackground } from "./HistoryBackground.ts";
import { HistoryQuery, historyInputs } from "./HistoryQuery.ts";
import { renderHistoryResult } from "./HistoryRendering.ts";

export const historyToolNames = [
  "history_list",
  "history_search",
  "history_read",
] as const;

export interface HistoryEntry {
  path: string;
  contents: string;
  background?: HistoryBackground;
}

export function isHistoryToolName(name: string): boolean {
  return (historyToolNames as readonly string[]).includes(name);
}

export function historyEntries(
  history: Readonly<Record<string, string>>,
  backgrounds: Readonly<Record<string, HistoryBackground>> = {},
): HistoryEntry[] {
  return Object.entries(history).map(([path, contents]) => ({
    path,
    contents,
    ...(backgrounds[path] === undefined
      ? {}
      : { background: structuredClone(backgrounds[path]) }),
  }));
}

/** Read-only committed-history navigation shared by play and world revision. */
export function createHistoryQuery(
  scope: string,
  entries: readonly HistoryEntry[],
): HistoryQuery {
  return new HistoryQuery(scope, historyInputs(entries));
}

export function runHistoryTool(
  query: HistoryQuery,
  call: { name: string; arguments: unknown },
  locale: AppLocale,
): { ok: boolean; markdown: string } {
  const result =
    call.name === "history_search"
      ? query.search(call.arguments)
      : call.name === "history_read"
        ? query.read(call.arguments)
        : query.list(call.arguments);
  return renderHistoryResult(result, locale);
}
