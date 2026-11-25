import { isMap, isScalar, isSeq, type Node } from "yaml";
import type {
  WorldDocumentDiagnostic,
  WorldDocumentLocator,
  WorldDocumentSourcePoint,
  WorldDocumentSourceRange,
} from "./WorldDocumentTypes.ts";

const encoder = new TextEncoder();

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

export type SourceRangeReader = (
  rawStart: number,
  rawEnd: number,
) => WorldDocumentSourceRange;

export function nodeRange(
  rangeAt: SourceRangeReader,
  node: unknown,
  baseOffset: number,
): WorldDocumentSourceRange {
  const range = isRangedNode(node) ? node.range : null;
  return rangeAt(
    baseOffset + (range?.[0] ?? 0),
    baseOffset + (range?.[1] ?? range?.[0] ?? 0),
  );
}

export function joinedNodeRange(
  rangeAt: SourceRangeReader,
  startNode: unknown,
  endNode: unknown,
  baseOffset: number,
): WorldDocumentSourceRange {
  const start = isRangedNode(startNode) ? (startNode.range?.[0] ?? 0) : 0;
  const end = isRangedNode(endNode)
    ? (endNode.range?.[1] ?? endNode.range?.[0] ?? start)
    : start;
  return rangeAt(baseOffset + start, baseOffset + end);
}

export function isRangedNode(value: unknown): value is Node {
  return isScalar(value) || isMap(value) || isSeq(value);
}

/** Reuses line starts and UTF-8 prefix lengths while locating nodes in a file. */
export function createSourceRangeReader(source: string): SourceRangeReader {
  const lineStarts = [0];
  for (
    let newline = source.indexOf("\n");
    newline >= 0;
    newline = source.indexOf("\n", newline + 1)
  )
    lineStarts.push(newline + 1);

  const blockSize = 256;
  const boundaries = [0];
  const byteOffsets = [0];
  for (let offset = blockSize; offset <= source.length; offset += blockSize) {
    // Keep surrogate pairs together when calculating UTF-8 prefix lengths.
    const boundary =
      /[\uD800-\uDBFF]/u.test(source.charAt(offset - 1)) &&
      /[\uDC00-\uDFFF]/u.test(source.charAt(offset))
        ? offset - 1
        : offset;
    byteOffsets.push(
      byteOffsets.at(-1)! +
        encoder.encode(source.slice(boundaries.at(-1), boundary)).byteLength,
    );
    boundaries.push(boundary);
  }
  const pointAt = (offset: number): WorldDocumentSourcePoint => {
    let left = 0;
    let right = lineStarts.length;
    while (right - left > 1) {
      const middle = Math.floor((left + right) / 2);
      if (lineStarts[middle]! <= offset) left = middle;
      else right = middle;
    }

    const block = Math.floor(offset / blockSize);
    return {
      offset,
      byteOffset:
        byteOffsets[block]! +
        encoder.encode(source.slice(boundaries[block], offset)).byteLength,
      line: left + 1,
      column: offset - lineStarts[left]! + 1,
    };
  };
  return (start, end) => boundedRange(source.length, start, end, pointAt);
}

export function sourceRange(
  source: string,
  rawStart: number,
  rawEnd: number,
): WorldDocumentSourceRange {
  return boundedRange(source.length, rawStart, rawEnd, (offset) => {
    const before = source.slice(0, offset);
    const lineStart = before.lastIndexOf("\n") + 1;
    return {
      offset,
      byteOffset: encoder.encode(before).byteLength,
      line: before.split("\n").length,
      column: offset - lineStart + 1,
    };
  });
}

function boundedRange(
  sourceLength: number,
  rawStart: number,
  rawEnd: number,
  pointAt: (offset: number) => WorldDocumentSourcePoint,
): WorldDocumentSourceRange {
  const start = Math.max(0, Math.min(sourceLength, rawStart));
  const end = Math.max(start, Math.min(sourceLength, rawEnd));
  const startPoint = pointAt(start);
  return freeze({
    start: startPoint,
    end: start === end ? startPoint : pointAt(end),
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

export function groupBy<T, Key>(
  values: readonly T[],
  keyFor: (value: T) => Key,
): Map<Key, T[]> {
  const result = new Map<Key, T[]>();
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
