import { isMap, isScalar, isSeq, type Node } from "yaml";
import type {
  WorldDocumentCodec,
  WorldDocumentDiagnostic,
  WorldDocumentLocator,
  WorldDocumentSourcePoint,
  WorldDocumentSourceRange,
} from "./WorldDocumentTypes.ts";

export const documentIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

export const shortRefPattern = /^[a-z][a-z0-9-]*$/u;

export function scalarEquals(value: unknown, expected: string): boolean {
  return isScalar(value) && value.value === expected;
}

export function scalarString(value: unknown): string | null {
  return isScalar(value) && typeof value.value === "string"
    ? value.value
    : null;
}

export function nodeRange(
  source: string,
  node: unknown,
  baseOffset: number,
): WorldDocumentSourceRange {
  const range = isRangedNode(node) ? node.range : null;
  return sourceRange(
    source,
    baseOffset + (range?.[0] ?? 0),
    baseOffset + (range?.[1] ?? range?.[0] ?? 0),
  );
}

export function joinedNodeRange(
  source: string,
  startNode: unknown,
  endNode: unknown,
  baseOffset: number,
): WorldDocumentSourceRange {
  const start = isRangedNode(startNode) ? (startNode.range?.[0] ?? 0) : 0;
  const end = isRangedNode(endNode)
    ? (endNode.range?.[1] ?? endNode.range?.[0] ?? start)
    : start;
  return sourceRange(source, baseOffset + start, baseOffset + end);
}

export function isRangedNode(value: unknown): value is Node {
  return isScalar(value) || isMap(value) || isSeq(value);
}

export function sourceRange(
  source: string,
  rawStart: number,
  rawEnd: number,
): WorldDocumentSourceRange {
  const start = Math.max(0, Math.min(source.length, rawStart));
  const end = Math.max(start, Math.min(source.length, rawEnd));
  return freeze({
    start: sourcePoint(source, start),
    end: sourcePoint(source, end),
  });
}

function sourcePoint(source: string, offset: number): WorldDocumentSourcePoint {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return freeze({
    offset,
    byteOffset: Buffer.byteLength(before, "utf8"),
    line: before.split("\n").length,
    column: offset - lineStart + 1,
  });
}

export function diagnostic(
  value: WorldDocumentDiagnostic,
): WorldDocumentDiagnostic {
  return freeze(value);
}

/** Human-readable locator for receipts and failure text; the structured locator stays the source of truth. */
export function formatWorldDocumentLocator(
  locator: WorldDocumentLocator,
): string {
  if ("markdown" in locator)
    return locator.markdown.length === 0
      ? "document body"
      : locator.markdown.join(" > ");
  return (
    locator.yaml.reduce<string>(
      (text, segment) =>
        typeof segment === "number"
          ? `${text}[${segment}]`
          : text === ""
            ? segment
            : `${text}.${segment}`,
      "",
    ) || "whole body"
  );
}

export function documentCodec(path: string): WorldDocumentCodec | null {
  if (/\.ya?ml$/iu.test(path)) return "yaml";
  if (/\.md$/iu.test(path)) return "markdown";
  return null;
}

export function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function yamlLocatorKey(locator: readonly (string | number)[]): string {
  return JSON.stringify(locator);
}

export function locatorStartsWith(
  value: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return (
    value.length >= prefix.length &&
    prefix.every((segment, index) => value[index] === segment)
  );
}

export function validYamlLocator(
  value: unknown,
): value is { readonly yaml: readonly (string | number)[] } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.yaml) &&
    value.yaml.every(
      (segment) =>
        typeof segment === "string" ||
        (Number.isSafeInteger(segment) && Number(segment) >= 0),
    )
  );
}

export function validMarkdownLocator(
  value: unknown,
  allowBodyRoot = false,
): value is { readonly markdown: readonly string[] } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.markdown) &&
    (allowBodyRoot || value.markdown.length > 0) &&
    value.markdown.every(
      (segment) => typeof segment === "string" && segment.length > 0,
    )
  );
}

export function copyLocator(value: WorldDocumentLocator): WorldDocumentLocator {
  if ("yaml" in value && Array.isArray(value.yaml))
    return freeze({
      yaml: freeze(
        value.yaml.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      ),
    });
  if ("markdown" in value && Array.isArray(value.markdown))
    return freeze({
      markdown: freeze(
        value.markdown.filter(
          (segment): segment is string => typeof segment === "string",
        ),
      ),
    });
  return freeze({ yaml: freeze([]) });
}

export function hasOnlyKeys(
  value: object,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = result.get(key);
    if (group === undefined) result.set(key, [value]);
    else group.push(value);
  }
  return result;
}

export function freeze<T>(value: T): T {
  const candidate: unknown = value;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Object.isFrozen(candidate)
  )
    return value;
  if (Array.isArray(candidate))
    candidate.forEach((entry: unknown) => freeze(entry));
  else if (isRecord(candidate))
    Object.values(candidate).forEach((entry) => freeze(entry));
  return Object.freeze(candidate) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trimTrailingWhitespaceOffset(
  source: string,
  start: number,
  rawEnd: number,
): number {
  let end = rawEnd;
  while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
  return end;
}
