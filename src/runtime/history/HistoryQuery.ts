import type { HistoryBackground } from "./HistoryBackground.ts";
import { appendHistoryVersion } from "./HistorySnapshotVersion.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mapLiteralSource,
  normalizeHistoryText,
  normalizeLiteral,
  type OriginalRange,
} from "../LiteralSearch.ts";

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
  #snapshotId: string | undefined;
  readonly #world: string;

  constructor(
    world: string,
    inputs: readonly HistoryMessageInput[],
    version?: string,
  ) {
    this.#world = world;
    const refs = inputs.map(({ id }) => historyMessageRef(id));
    this.#snapshotId = version;
    this.messages = inputs.map((message, index) => {
      const { text } = message;
      let length: number | undefined;
      return Object.freeze({
        ...message,
        ...(message.background === undefined
          ? {}
          : { background: Object.freeze(structuredClone(message.background)) }),
        ref: refs[index]!,
        position: index + 1,
        isOpening: message.isOpening === true,
        previous: refs[index - 1] ?? null,
        next: refs[index + 1] ?? null,
        get length() {
          return (length ??= Array.from(text).length);
        },
      });
    });
  }

  get snapshotId(): string {
    return (this.#snapshotId ??= appendHistoryVersion("", this.messages));
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
        const cursor = this.decodeCursor(input.cursor, "history_list");
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
            : this.encodeCursor("history_list", query, start, "earlier"),
        laterCursor:
          end === this.messages.length
            ? null
            : this.encodeCursor("history_list", query, end, "later"),
      };
    } catch (error) {
      return queryFailure(error);
    }
  }

  search(
    args: unknown,
    legacy?: { within: string | null },
  ): HistorySearch | HistoryFailure {
    const tool =
      legacy === undefined ? "history_search" : "legacy_context_search";
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
        const cursor = this.decodeCursor(input.cursor, tool);
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
          within: legacy?.within ?? null,
        };
      }
      const queries = query.queries as string[];
      const caseSensitive = query.caseSensitive === true;
      const match = query.match as "any" | "all";
      const order = query.order as HistorySearch["order"];
      const start = Number(query.start);
      const end = Number(query.end);
      const limit = Number(query.limit);
      const scope = typeof query.within === "string" ? query.within : null;
      const terms = queries.map((word) => ({
        query: word,
        needle: normalizeLiteral(word, caseSensitive),
      }));
      const page: { message: HistoryMessage; normalized: string }[] = [];
      let matches = 0;
      for (let step = 0; step < end - start; step++) {
        const index = order === "newest_first" ? end - step - 1 : start + step;
        const message = this.messages[index]!;
        if (scope !== null && !historyScopeMatches(message, scope)) continue;
        const normalized = normalizeHistoryText(message.text, caseSensitive);
        const contains = ({ needle }: SearchTerm) =>
          normalized.includes(needle);
        if (!(match === "all" ? terms.every(contains) : terms.some(contains)))
          continue;
        if (matches >= offset && page.length < limit)
          page.push({ message, normalized });
        matches++;
      }
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
        within: scope,
        legacy: legacy !== undefined,
        matches,
        messages: page.map(({ message, normalized }) =>
          searchHit(message, normalized, terms, caseSensitive),
        ),
        nextCursor:
          offset + page.length >= matches
            ? null
            : this.encodeCursor(tool, query, offset + page.length, "later"),
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

  encodeCursor(
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

  decodeCursor(value: unknown, tool: string): CursorPayload {
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
export function queryFailure(error: unknown): HistoryFailure {
  if (error instanceof HistoryQueryError)
    return { ok: false, code: error.code, recovery: error.recovery };
  throw error;
}
export function invalid(message: string): never {
  throw new HistoryQueryError("history_invalid_arguments", message);
}
export function argumentsObject(
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
export function integer(
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

interface SearchTerm {
  query: string;
  needle: string;
}

function searchHit(
  message: HistoryMessage,
  normalized: string,
  terms: SearchTerm[],
  caseSensitive: boolean,
): HistorySearchHit {
  const source = Array.from(message.text);
  // Contextual casing in the normalized message can change sigma's form
  // without changing the width used to map it back to the original grapheme.
  const { ranges: mapping } = mapLiteralSource(
    message.text,
    caseSensitive,
    "codePoints",
  );
  const perQuery = terms.map(({ query, needle }) => {
    const ranges: OriginalRange[] = [];
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
  const windows: OriginalRange[] = [];
  const add = (range: OriginalRange): boolean => {
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
