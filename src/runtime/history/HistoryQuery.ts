import type { HistoryBackground } from "./HistoryBackground.ts";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface HistoryMessageInput {
  readonly id: string;
  readonly role: "player" | "narrator";
  readonly isOpening?: boolean;
  readonly text: string;
  readonly background?: HistoryBackground;
}

export interface HistoryMessage extends HistoryMessageInput {
  readonly ref: string;
  readonly position: number;
  readonly isOpening: boolean;
  readonly previous: string | null;
  readonly next: string | null;
  readonly length: number;
}

export interface HistoryFailure {
  ok: false;
  code:
    | "history_invalid_arguments"
    | "history_invalid_cursor"
    | "history_changed"
    | "history_ref_not_in_current_timeline";
  recovery: string;
}

export interface HistoryList {
  ok: true;
  kind: "list";
  total: number;
  messages: readonly HistoryMessage[];
  earlierCursor: string | null;
  laterCursor: string | null;
  anchor: string | null;
}

export interface HistoryRead {
  ok: true;
  kind: "read";
  total: number;
  mode: "latest" | "anchor";
  center: string | null;
  messages: readonly HistoryMessage[];
  earlier: string | null;
  later: string | null;
}

export interface HistorySearchHit {
  message: HistoryMessage;
  hits: { query: string; count: number }[];
  fragments: {
    text: string;
    start: number;
    end: number;
    omittedBefore: boolean;
    omittedAfter: boolean;
  }[];
  omittedMatches: boolean;
}
export interface HistorySearch {
  ok: true;
  kind: "search";
  total: number;
  range: { start: number | null; end: number | null };
  matches: number;
  queries: string[];
  match: "any" | "all";
  caseSensitive: boolean;
  order: "newest_first" | "oldest_first";
  within: string | null;
  legacy: boolean;
  messages: HistorySearchHit[];
  nextCursor: string | null;
}

export interface HistoryLegacyList {
  ok: true;
  kind: "legacy_list";
  total: number;
  order: "newest_first" | "oldest_first";
  offset: number;
  messages: readonly HistoryMessage[];
  nextCursor: string | null;
}

interface CursorPayload {
  version: 1;
  world: string;
  snapshot: string;
  tool: string;
  query: Record<string, unknown>;
  offset: number;
  direction: "earlier" | "later";
}

// A restart rejects old process-bound cursors explicitly, without guessing a
// snapshot or trusting client-provided query declarations. Frozen requests and
// their already completed tool receipts are restored independently.
const cursorSecret = randomBytes(32);

export class HistoryQuery {
  readonly messages: readonly HistoryMessage[];
  readonly snapshotId: string;
  readonly #world: string;

  constructor(world: string, inputs: readonly HistoryMessageInput[]) {
    this.#world = world;
    const refs = inputs.map(({ id }) => historyMessageRef(id));
    this.messages = inputs.map((message, index) =>
      Object.freeze({
        ...message,
        ...(message.background === undefined
          ? {}
          : { background: Object.freeze(structuredClone(message.background)) }),
        ref: refs[index]!,
        position: index + 1,
        isOpening: message.isOpening === true,
        previous: refs[index - 1] ?? null,
        next: refs[index + 1] ?? null,
        length: Array.from(message.text).length,
      }),
    );
    this.snapshotId = createHash("sha256")
      .update(
        JSON.stringify(
          inputs.map(({ id, role, isOpening, text, background }) => [
            id,
            role,
            isOpening === true,
            text,
            background ?? null,
          ]),
        ),
      )
      .digest("hex");
  }

  list(args: unknown): HistoryList | HistoryFailure {
    try {
      const input = argumentsObject(args, [
        "before",
        "after",
        "limit",
        "cursor",
      ]);
      let start: number;
      let end: number;
      let limit: number;
      let query: Record<string, unknown>;
      let anchor: string | null;
      if (input.cursor !== undefined) {
        cursorOnly(input);
        const cursor = this.#decodeCursor(input.cursor, "history_list");
        query = cursor.query;
        limit = Number(query.limit);
        anchor = typeof query.anchor === "string" ? query.anchor : null;
        if (cursor.direction === "earlier") {
          end = cursor.offset;
          start = Math.max(0, end - limit);
        } else {
          start = cursor.offset;
          end = Math.min(this.messages.length, start + limit);
        }
      } else {
        limit = integer(input.limit, 20, 1, 100, "limit");
        if (input.before !== undefined && input.after !== undefined)
          invalid(
            "Use only one of before or after, or omit both for the latest page.",
          );
        anchor =
          input.before === undefined && input.after === undefined
            ? null
            : this.#find(input.before ?? input.after).ref;
        if (input.after !== undefined) {
          start = this.#find(input.after).position;
          end = Math.min(this.messages.length, start + limit);
        } else {
          end =
            input.before === undefined
              ? this.messages.length
              : this.#find(input.before).position - 1;
          start = Math.max(0, end - limit);
        }
        query = {
          limit,
          anchor,
          mode:
            input.before !== undefined
              ? "before"
              : input.after !== undefined
                ? "after"
                : "latest",
        };
      }
      return {
        ok: true,
        kind: "list",
        total: this.messages.length,
        messages: this.messages.slice(start, end),
        anchor,
        earlierCursor:
          start === 0
            ? null
            : this.#cursor("history_list", query, start, "earlier"),
        laterCursor:
          end === this.messages.length
            ? null
            : this.#cursor("history_list", query, end, "later"),
      };
    } catch (error) {
      return queryFailure(error);
    }
  }

  search(args: unknown): HistorySearch | HistoryFailure {
    return this.#search(args, "history_search");
  }

  legacyList(
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
        const cursor = this.#decodeCursor(input.cursor, `legacy_${tool}`);
        if (JSON.stringify(cursor.query) !== JSON.stringify(query))
          invalid(
            "Keep the original legacy order and limit, or run a new query.",
          );
        offset = cursor.offset;
      }
      const ordered =
        input.order === "newest_first"
          ? [...this.messages].reverse()
          : this.messages;
      const page = ordered.slice(offset, offset + limit);
      return {
        ok: true,
        kind: "legacy_list",
        total: this.messages.length,
        order: input.order,
        offset,
        messages: page,
        nextCursor:
          offset + page.length >= ordered.length
            ? null
            : this.#cursor(
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

  legacySearch(args: unknown): HistorySearch | HistoryFailure {
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
        const saved = this.#decodeCursor(cursor, "legacy_context_search");
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
        return this.#search({ cursor }, "legacy_context_search");
      }
      return this.#search(
        request,
        "legacy_context_search",
        typeof within === "string" ? within : null,
      );
    } catch (error) {
      return queryFailure(error);
    }
  }

  #search(
    args: unknown,
    tool: string,
    within: string | null = null,
  ): HistorySearch | HistoryFailure {
    try {
      const input = argumentsObject(args, [
        "queries",
        "match",
        "order",
        "caseSensitive",
        "limit",
        "after",
        "before",
        "cursor",
      ]);
      let query: Record<string, unknown>;
      let offset = 0;
      if (input.cursor !== undefined) {
        cursorOnly(input);
        const cursor = this.#decodeCursor(input.cursor, tool);
        query = cursor.query;
        offset = cursor.offset;
      } else {
        if (
          !Array.isArray(input.queries) ||
          input.queries.length < 1 ||
          input.queries.length > 5 ||
          input.queries.some(
            (word) =>
              typeof word !== "string" ||
              word.trim().length === 0 ||
              Array.from(word).length > 256,
          )
        )
          invalid(
            "queries must contain 1–5 nonempty literal strings, each at most 256 Unicode code points.",
          );
        if (
          input.caseSensitive !== undefined &&
          typeof input.caseSensitive !== "boolean"
        )
          invalid("caseSensitive must be boolean.");
        if (
          input.match !== undefined &&
          input.match !== "any" &&
          input.match !== "all"
        )
          invalid("match must be any or all (within one message).");
        if (
          input.order !== undefined &&
          input.order !== "newest_first" &&
          input.order !== "oldest_first"
        )
          invalid("order must be newest_first or oldest_first.");
        const caseSensitive = input.caseSensitive === true;
        const seen = new Set<string>();
        const queries = (input.queries as string[]).filter((word) => {
          const normalized = normalizeLiteral(word, caseSensitive);
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        });
        const start =
          input.after === undefined ? 0 : this.#find(input.after).position;
        const end =
          input.before === undefined
            ? this.messages.length
            : this.#find(input.before).position - 1;
        if (
          input.after !== undefined &&
          input.before !== undefined &&
          start > end
        )
          invalid(
            "after must precede before in timeline order, regardless of search order.",
          );
        query = {
          queries,
          caseSensitive,
          match: input.match ?? "any",
          order: input.order ?? "newest_first",
          limit: integer(input.limit, 10, 1, 50, "limit"),
          start,
          end,
          within,
        };
      }
      const queries = query.queries as string[];
      const caseSensitive = query.caseSensitive === true;
      const match = query.match as "any" | "all";
      const order = query.order as HistorySearch["order"];
      const start = Number(query.start);
      const end = Number(query.end);
      const limit = Number(query.limit);
      const found = this.messages.slice(start, end).flatMap((message) => {
        if (
          typeof query.within === "string" &&
          !historyScopeMatches(message, query.within)
        )
          return [];
        const hit = searchMessage(message, queries, caseSensitive);
        return hit.hits.length > 0 &&
          (match === "any" || hit.hits.length === queries.length)
          ? [hit]
          : [];
      });
      if (order === "newest_first") found.reverse();
      const page = found.slice(offset, offset + limit);
      return {
        ok: true,
        kind: "search",
        total: this.messages.length,
        range:
          start === end
            ? { start: null, end: null }
            : { start: start + 1, end },
        queries,
        caseSensitive,
        match,
        order,
        within: typeof query.within === "string" ? query.within : null,
        legacy: tool === "legacy_context_search",
        matches: found.length,
        messages: page,
        nextCursor:
          offset + page.length >= found.length
            ? null
            : this.#cursor(tool, query, offset + page.length, "later"),
      };
    } catch (error) {
      return queryFailure(error);
    }
  }

  read(args: unknown): HistoryRead | HistoryFailure {
    try {
      const input = argumentsObject(args, ["latest", "ref", "before", "after"]);
      let start: number;
      let end: number;
      let center: string | null = null;
      if (input.latest !== undefined) {
        if (Object.keys(input).some((key) => key !== "latest"))
          invalid(
            "Use {latest} alone, or {ref,before,after} for an anchor window.",
          );
        const latest = integer(input.latest, 4, 1, 21, "latest");
        end = this.messages.length;
        start = Math.max(0, end - latest);
      } else {
        const message = this.#find(input.ref);
        const before = integer(input.before, 0, 0, 20, "before");
        const after = integer(input.after, 0, 0, 20, "after");
        if (before + after > 20)
          invalid(
            "before + after must be at most 20 messages. Extend in small windows if needed.",
          );
        center = message.ref;
        start = Math.max(0, message.position - 1 - before);
        end = Math.min(this.messages.length, message.position + after);
      }
      return {
        ok: true,
        kind: "read",
        total: this.messages.length,
        mode: center === null ? "latest" : "anchor",
        center,
        messages: this.messages.slice(start, end),
        earlier: this.messages[start - 1]?.ref ?? null,
        later: this.messages[end]?.ref ?? null,
      };
    } catch (error) {
      return queryFailure(error);
    }
  }

  #find(ref: unknown): HistoryMessage {
    if (typeof ref !== "string" || !ref.startsWith("@history-message-"))
      invalid(
        "Use a history ref supplied by Runtime in an injection or a tool result.",
      );
    const message = this.messages.find((message) => message.ref === ref);
    if (message === undefined)
      throw new HistoryQueryError(
        "history_ref_not_in_current_timeline",
        "This ref is not on the current timeline; it may still exist at an old endpoint. Query the current history again.",
      );
    return message;
  }

  #cursor(
    tool: string,
    query: Record<string, unknown>,
    offset: number,
    direction: CursorPayload["direction"],
  ): string {
    const payload: CursorPayload = {
      version: 1,
      world: this.#world,
      snapshot: this.snapshotId,
      tool,
      query,
      offset,
      direction,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", cursorSecret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  #decodeCursor(value: unknown, tool: string): CursorPayload {
    const bad = () =>
      new HistoryQueryError(
        "history_invalid_cursor",
        "Invalid, obsolete, cross-world or cross-tool cursor. Run the original query again; continue using only the returned cursor.",
      );
    if (typeof value !== "string") throw bad();
    const parts = value.split(".");
    if (parts.length !== 2) throw bad();
    const [encoded, signature] = parts as [string, string];
    const expected = createHmac("sha256", cursorSecret)
      .update(encoded)
      .digest();
    const received = Buffer.from(signature, "base64url");
    if (
      !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
      signature !== received.toString("base64url") ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw bad();
    let payload: CursorPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as CursorPayload;
    } catch {
      throw bad();
    }
    if (
      payload.version !== 1 ||
      payload.world !== this.#world ||
      payload.tool !== tool
    )
      throw bad();
    if (payload.snapshot !== this.snapshotId)
      throw new HistoryQueryError(
        "history_changed",
        "The current history changed. Run the original query again and use its new cursor; do not combine pages from different snapshots.",
      );
    return payload;
  }
}

export function historyMessageRef(id: string): string {
  return `@history-message-${id.replace(/\.md$/u, "").replace(/^@?history-message-/u, "")}`;
}

/** Decode storage identity once at the boundary; never infer order from it. */
export function historyInputs(
  entries: readonly {
    path: string;
    contents: string;
    background?: HistoryBackground;
  }[],
): HistoryMessageInput[] {
  return entries.map(({ path, contents, background }) => {
    const id = path.replace(/\.md$/u, "");
    return {
      id,
      text: contents,
      ...(background === undefined ? {} : { background }),
      role: /(?:\.|-)player(?:-|$)/u.test(id) ? "player" : "narrator",
      isOpening: id.endsWith("message.genesis.narrator"),
    };
  });
}

class HistoryQueryError extends Error {
  readonly code: HistoryFailure["code"];
  readonly recovery: string;
  constructor(code: HistoryFailure["code"], recovery: string) {
    super(recovery);
    this.code = code;
    this.recovery = recovery;
  }
}
function queryFailure(error: unknown): HistoryFailure {
  if (error instanceof HistoryQueryError)
    return { ok: false, code: error.code, recovery: error.recovery };
  throw error;
}
function invalid(message: string): never {
  throw new HistoryQueryError("history_invalid_arguments", message);
}
function argumentsObject(
  args: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !allowed.includes(key))
  )
    invalid(`Use only ${allowed.join(", ")}.`);
  return args as Record<string, unknown>;
}
function cursorOnly(input: Record<string, unknown>): void {
  if (Object.keys(input).length !== 1)
    invalid(
      "Continuation needs only {cursor}; omit all first-query arguments.",
    );
}
function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalid(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function normalizeLiteral(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("und");
}
interface MatchRange {
  start: number;
  end: number;
}

function searchMessage(
  message: HistoryMessage,
  queries: string[],
  caseSensitive: boolean,
): HistorySearchHit {
  // Grapheme clusters keep combining sequences together during normalization.
  // Each normalized UTF-16 unit maps to the original cluster's code-point
  // interval; expansions (ligatures, full-width letters, dotted I) stay exact.
  const source = Array.from(message.text);
  const mapping: MatchRange[] = [];
  let normalized = "";
  let originalOffset = 0;
  for (const { segment } of new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(message.text)) {
    const end = originalOffset + Array.from(segment).length;
    const transformed = normalizeLiteral(segment, caseSensitive);
    normalized += segment.normalize("NFKC");
    transformed
      .split("")
      .forEach(() => mapping.push({ start: originalOffset, end }));
    originalOffset = end;
  }
  // Case conversion uses the entire normalized text so contextual lowercasing
  // (such as final Greek sigma) matches the existing literal-search rules.
  if (!caseSensitive) normalized = normalized.toLocaleLowerCase("und");
  const perQuery = queries.map((query) => {
    const needle = normalizeLiteral(query, caseSensitive);
    const ranges: MatchRange[] = [];
    let offset = 0;
    while (offset <= normalized.length - needle.length) {
      const found = normalized.indexOf(needle, offset);
      if (found < 0) break;
      ranges.push({
        start: mapping[found]!.start,
        end: mapping[found + needle.length - 1]!.end,
      });
      offset = found + needle.length;
    }
    return { query, ranges };
  });
  const allRanges = perQuery
    .flatMap(({ ranges }) => ranges)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const windows: MatchRange[] = [];
  const add = (range: MatchRange): boolean => {
    const window = {
      start: Math.max(0, range.start - 80),
      end: Math.min(source.length, range.end + 80),
    };
    const overlaps = windows.filter(
      (existing) =>
        existing.start <= window.end && window.start <= existing.end,
    );
    if (overlaps.length === 0 && windows.length === 3) return false;
    for (const existing of overlaps) {
      window.start = Math.min(window.start, existing.start);
      window.end = Math.max(window.end, existing.end);
      windows.splice(windows.indexOf(existing), 1);
    }
    windows.push(window);
    return true;
  };
  // Prioritize the first occurrence of each distinct query before filling any
  // remaining fragment slots with other matches in source order.
  for (const { ranges } of perQuery)
    if (ranges[0] !== undefined) add(ranges[0]);
  for (const range of allRanges) {
    if (windows.length >= 3) break;
    const candidate = {
      start: Math.max(0, range.start - 80),
      end: Math.min(source.length, range.end + 80),
    };
    // Supplemental hits fill separate fragment slots. Do not repeatedly grow
    // one window through a chain of nearby hits into a complete long body.
    if (
      windows.some(
        (window) =>
          window.start <= candidate.end && candidate.start <= window.end,
      )
    )
      continue;
    add(range);
  }
  windows.sort((a, b) => a.start - b.start);
  return {
    message,
    hits: perQuery
      .filter(({ ranges }) => ranges.length > 0)
      .map(({ query, ranges }) => ({ query, count: ranges.length })),
    fragments: windows.map(({ start, end }) => ({
      text: source.slice(start, end).join(""),
      start: start + 1,
      end,
      omittedBefore: start > 0,
      omittedAfter: end < source.length,
    })),
    omittedMatches: allRanges.some(
      (range) =>
        !windows.some(
          (window) => range.start >= window.start && range.end <= window.end,
        ),
    ),
  };
}

function historyScopeMatches(message: HistoryMessage, within: string): boolean {
  if (historyMessageRef(message.id) === historyMessageRef(within)) return true;
  const commit =
    /(?:^|\.)message\.([^.]+)\./u.exec(message.id)?.[1] ??
    message.id.split("-")[0];
  return within.replace(/^@/u, "") === `history-commit-${commit}`;
}

export type HistorySelection =
  | { kind: "history_message"; message: string }
  | { kind: "history_commit"; commit: string };

/** Resolve exact author/legacy selections without changing Authority order. */
export function historySelectionMatches(
  material: HistorySelection,
  key: string,
): boolean {
  if (material.kind === "history_message")
    return historyIdentity(key) === historyIdentity(material.message);
  const ref = material.commit;
  return ref.startsWith("commit:")
    ? historyIdentity(key).startsWith(`message.${ref.slice(7)}.`)
    : ref === "genesis"
      ? historyIdentity(key).startsWith("message.genesis.")
      : key.startsWith(
          ref.replace(/^@?history-commit-/u, "history-message-").concat("-"),
        );
}
function historyIdentity(ref: string): string {
  const value = ref.replace(/^@?(?:history-message-)?/u, "");
  return (
    /(?:^|\.)(message\.(?:genesis|[0-9]+)(?:\.[0-9]+)?\.(?:player|narrator))$/u.exec(
      value,
    )?.[1] ?? value
  );
}
