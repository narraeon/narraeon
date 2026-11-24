// Frozen pre-1.0.0 tool definitions still use these request and receipt shapes.
// Keep the adapter until the compatibility audit in #244.
import { normalizeLiteral } from "../LiteralSearch.ts";
import {
  argumentsObject,
  integer,
  invalid,
  queryFailure,
  type HistoryFailure,
  type HistoryMessage,
  type HistoryQuery,
  type HistorySearch,
} from "./HistoryQuery.ts";

export interface HistoryLegacyList {
  ok: true;
  kind: "legacy_list";
  total: number;
  order: "newest_first" | "oldest_first";
  offset: number;
  messages: readonly HistoryMessage[];
  nextCursor: string | null;
}

export function legacyHistoryList(
  history: HistoryQuery,
  args: unknown,
  tool: "context_list" | "history_list",
): HistoryLegacyList | HistoryFailure {
  try {
    const input = argumentsObject(args, ["order", "limit", "cursor"]);
    if (input.order !== "newest_first" && input.order !== "oldest_first")
      invalid(
        "Legacy history listing requires newest_first or oldest_first order.",
      );
    const limit = integer(input.limit, 20, 1, 100, "limit");
    const query = { order: input.order, limit };
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      const cursor = history.decodeCursor(input.cursor, `legacy_${tool}`);
      if (JSON.stringify(cursor.query) !== JSON.stringify(query))
        invalid(
          "Keep the original legacy order and limit, or run a new query.",
        );
      offset = cursor.offset;
    }
    const total = history.messages.length;
    const end = Math.min(total, offset + limit);
    const page =
      input.order === "newest_first"
        ? history.messages.slice(total - end, total - offset).reverse()
        : history.messages.slice(offset, end);
    return {
      ok: true,
      kind: "legacy_list",
      total,
      order: input.order,
      offset,
      messages: page,
      nextCursor:
        offset + page.length >= total
          ? null
          : history.encodeCursor(
              `legacy_${tool}`,
              query,
              offset + page.length,
              "later",
            ),
    };
  } catch (error) {
    return queryFailure(error);
  }
}

export function legacyHistorySearch(
  history: HistoryQuery,
  args: unknown,
): HistorySearch | HistoryFailure {
  try {
    const input = argumentsObject(args, [
      "query",
      "caseSensitive",
      "within",
      "limit",
      "cursor",
    ]);
    const { cursor, query, within, ...options } = input;
    if (within !== undefined && typeof within !== "string")
      invalid("Legacy within must be a Runtime history handle.");
    const request = { queries: [query], ...options, order: "oldest_first" };
    if (cursor !== undefined && cursor !== null) {
      const saved = history.decodeCursor(cursor, "legacy_context_search");
      if (
        normalizeLiteral(String(query), options.caseSensitive === true) !==
          normalizeLiteral(
            String((saved.query.queries as string[])[0]),
            options.caseSensitive === true,
          ) ||
        (within ?? null) !== saved.query.within ||
        integer(options.limit, 10, 1, 50, "limit") !== saved.query.limit ||
        (options.caseSensitive === true) !== saved.query.caseSensitive
      )
        invalid(
          "Keep the original legacy search parameters, or run a new query.",
        );
      return history.search({ cursor }, { within: null });
    }
    return history.search(request, { within: within ?? null });
  } catch (error) {
    return queryFailure(error);
  }
}
