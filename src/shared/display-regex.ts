import { parseDocument, visit, isAlias, isNode } from "yaml";
export type PlayPresetRegexScope =
  "raw_text" | "markdown_html" | "structured_payload";

export type PlayPresetRegexErrorPolicy = "fallback" | "skip" | "fail";

export interface PlayPresetRegexRule {
  enabled?: boolean;
  order: number;
  scope: PlayPresetRegexScope;
  pattern: string;
  flags: string;
  replace: string;
  maxMatches: number;
  errorPolicy: PlayPresetRegexErrorPolicy;
}

export function parseDisplayRegex(
  source: string,
  path = "regex/inline.yaml",
): PlayPresetRegexRule[] {
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    invalid(
      "regex_asset_invalid",
      `Regex-resource YAML is invalid: ${path}`,
      path,
    );
  let unsafe = false;
  visit(document, (_, node) => {
    if (
      isAlias(node) ||
      (isNode(node) &&
        (node.tag !== undefined || ("anchor" in node && Boolean(node.anchor))))
    )
      unsafe = true;
  });
  if (unsafe)
    invalid(
      "regex_asset_invalid",
      "Regex YAML aliases, tags and anchors are not supported",
      path,
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (isRecord(value)) assertKnownKeys(value, ["rules"], path);
  const rules = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.rules)
      ? value.rules
      : null;
  if (rules === null || rules.length > 256)
    invalid(
      "regex_rules_invalid",
      `A regex resource may contain at most 256 rules: ${path}`,
      path,
    );
  const orders = new Set<number>();
  const parsed = rules.map((raw, index): PlayPresetRegexRule => {
    const location = `${path}#rules[${index}]`;
    if (!isRecord(raw))
      invalid("regex_rule_invalid", "A regex rule must be a map", location);
    assertKnownKeys(
      raw,
      [
        "order",
        "scope",
        "pattern",
        "flags",
        "replace",
        "maxMatches",
        "errorPolicy",
        "enabled",
      ],
      location,
    );
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
      invalid(
        "regex_enabled_invalid",
        "Rule enabled must be a boolean",
        location,
      );
    const order = raw.order;
    if (!Number.isSafeInteger(order) || (order as number) < 0)
      invalid(
        "regex_order_invalid",
        "A regex rule must declare a non-negative integer order",
        location,
      );
    if (orders.has(order as number))
      invalid(
        "regex_order_duplicate",
        "Regex rule order cannot be duplicated",
        location,
      );
    orders.add(order as number);
    const scope = raw.scope;
    if (
      scope !== "raw_text" &&
      scope !== "markdown_html" &&
      scope !== "structured_payload"
    )
      invalid(
        "regex_scope_invalid",
        "A regex rule must declare raw_text, markdown_html, or structured_payload scope",
        location,
      );
    const pattern = raw.pattern;
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.length > 4_096
    )
      invalid(
        "regex_pattern_invalid",
        "Regex pattern must be a bounded non-empty string",
        location,
      );
    const flags = raw.flags === undefined ? "" : raw.flags;
    if (typeof flags !== "string" || flags.length > 16)
      invalid("regex_flags_invalid", "Regex flags are invalid", location);
    try {
      new RegExp(pattern, flags);
    } catch {
      invalid(
        "regex_pattern_invalid",
        "Regex pattern could not be compiled",
        location,
      );
    }
    if (typeof raw.replace !== "string")
      invalid("regex_replace_invalid", "Regex replace must be text", location);
    const maxMatches = raw.maxMatches ?? 1;
    if (
      !Number.isSafeInteger(maxMatches) ||
      (maxMatches as number) < 1 ||
      (maxMatches as number) > 1_024
    )
      invalid(
        "regex_limit_invalid",
        "Regex replacement count must be a bounded positive integer",
        location,
      );
    const errorPolicy = raw.errorPolicy;
    if (
      errorPolicy !== "fallback" &&
      errorPolicy !== "skip" &&
      errorPolicy !== "fail"
    )
      invalid(
        "regex_error_policy_invalid",
        "A regex rule must declare fallback, skip, or fail errorPolicy",
        location,
      );
    return {
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
      order: order as number,
      scope,
      pattern,
      flags,
      replace: raw.replace,
      maxMatches: maxMatches as number,
      errorPolicy,
    };
  });
  return parsed.sort((left, right) => left.order - right.order);
}

export class DisplayRegexError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function invalid(code: string, message: string, _location: string): never {
  void _location;
  throw new DisplayRegexError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    invalid(
      "unsupported_field",
      `The current play format does not support field: ${unknown}`,
      location,
    );
}
