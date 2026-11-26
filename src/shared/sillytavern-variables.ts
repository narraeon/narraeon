/** Static reading aid only. It deliberately does not evaluate SillyTavern macros. */
export interface VariableToken {
  start: number;
  end: number;
  raw: string;
  kind: "set" | "get";
  name: string;
  value?: string;
  uncertain: boolean;
  scoped?: boolean;
}

const LIMIT = 500_000;
const TOKEN_LIMIT = 2000;

export function scanVariables(source: string): {
  tokens: VariableToken[];
  uncertain: boolean;
} {
  const tokens: VariableToken[] = [];
  let uncertain = source.length > LIMIT;
  const text = source.slice(0, LIMIT);
  let position = 0;
  while (position < text.length && tokens.length < TOKEN_LIMIT) {
    const start = text.indexOf("{{", position);
    if (start < 0) break;
    let depth = 1;
    let cursor = start + 2;
    let nested = false;
    while (cursor < text.length && depth > 0) {
      if (text.startsWith("{{", cursor)) {
        depth++;
        nested = true;
        cursor += 2;
      } else if (text.startsWith("}}", cursor)) {
        depth--;
        cursor += 2;
      } else cursor++;
    }
    if (depth) {
      uncertain = true;
      break;
    }
    const raw = text.slice(start, cursor);
    const body = raw.slice(2, -2);
    const escaped = start > 0 && text[start - 1] === "\\";
    const set = /^\s*setvar\s*::([^:]*?)::([\s\S]*)$/iu.exec(body);
    const scoped = /^\s*#?setvar(?:\s*::\s*|\s+)([^:{}\s]+)\s*$/iu.exec(body);
    const get = /^\s*getvar(?:\s*::\s*|\s+)([^{}]*?)\s*$/iu.exec(body);
    if (set || scoped || get) {
      const name = (set?.[1] ?? scoped?.[1] ?? get?.[1] ?? "").trim();
      tokens.push({
        start,
        end: cursor,
        raw,
        kind: set || scoped ? "set" : "get",
        name,
        ...(set ? { value: set[2]! } : {}),
        ...(scoped ? { scoped: true } : {}),
        uncertain:
          Boolean(scoped) ||
          nested ||
          escaped ||
          !name ||
          /[{}]/u.test(name) ||
          Boolean(set?.[2]?.includes("::")),
      });
      if (nested || escaped || scoped) uncertain = true;
    } else {
      // Unknown macros, block delimiters, comments and mutation macros may affect evaluation.
      uncertain = true;
    }
    position = cursor;
  }
  if (tokens.length >= TOKEN_LIMIT) uncertain = true;
  return { tokens, uncertain };
}
