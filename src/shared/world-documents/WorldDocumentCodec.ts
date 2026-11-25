import { isMap, isScalar, isSeq, type Pair, type YAMLMap } from "yaml";
import { documentCodec } from "../world-document-format.ts";
import { parseRestrictedYamlDocument } from "../restricted-yaml.ts";
import { inspectYamlReferences } from "./WorldDocumentReferences.ts";
import {
  createSourceRangeReader,
  diagnostic,
  documentIdPattern,
  freeze,
  isRangedNode,
  isRecord,
  joinedNodeRange,
  nodeRange,
  scalarEquals,
  scalarString,
  shortRefPattern,
  sourceRange,
  type SourceRangeReader,
  trimTrailingWhitespaceOffset,
  validRelativePath,
  yamlLocatorKey,
} from "./WorldDocumentSource.ts";
import type {
  WorldDocumentCodec,
  WorldDocumentDescriptor,
  WorldDocumentDiagnostic,
  WorldDocumentFile,
  WorldDocumentLocator,
  WorldDocumentSourceRange,
} from "./WorldDocumentTypes.ts";

export function inspectDocumentFile(
  file: WorldDocumentFile,
  logicalRoot: "world" | "state",
): InternalDocumentEntry {
  const entry: InternalDocumentEntry = {
    file,
    relativePath: file.path.slice(logicalRoot.length + 1),
    codec: null,
    references: [],
    diagnostics: [],
  };
  if (!validRelativePath(entry.relativePath)) {
    entry.diagnostics.push(
      diagnostic({
        code: "logical_path_invalid",
        logicalPath: file.path,
        message:
          "World-document logical path must remain within the layout root",
      }),
    );
    return entry;
  }
  if (file.encoding !== undefined) {
    entry.diagnostics.push(
      diagnostic({
        code: "world_document_binary",
        logicalPath: file.path,
        range: sourceRange(file.contents, 0, file.contents.length),
        message: "World documents accept only UTF-8 YAML or Markdown source",
      }),
    );
    return entry;
  }
  entry.codec = documentCodec(file.path);
  if (entry.codec === null) {
    entry.diagnostics.push(
      diagnostic({
        code: "world_document_codec_unsupported",
        logicalPath: file.path,
        range: sourceRange(file.contents, 0, file.contents.length),
        message: "World documents accept only .yaml, .yml, or .md codecs",
      }),
    );
    return entry;
  }
  const rangeAt = createSourceRangeReader(file.contents);
  if (entry.codec === "yaml") inspectYamlDocument(entry, rangeAt);
  else inspectMarkdownDocument(entry, rangeAt);
  return entry;
}

interface HeaderRanges {
  readonly documentId?: WorldDocumentSourceRange;
  readonly shortRef?: WorldDocumentSourceRange;
  readonly title?: WorldDocumentSourceRange;
  readonly summary?: WorldDocumentSourceRange;
  readonly aliases?: WorldDocumentSourceRange;
}

export interface InternalReference {
  readonly targetId: string | null;
  readonly locator: WorldDocumentLocator;
  readonly range: WorldDocumentSourceRange;
  readonly valueRange: WorldDocumentSourceRange;
}

export interface InternalDocumentEntry {
  readonly file: WorldDocumentFile;
  readonly relativePath: string;
  codec: WorldDocumentCodec | null;
  descriptor?: WorldDocumentDescriptor;
  headerRanges?: HeaderRanges;
  bodyRange?: WorldDocumentSourceRange;
  searchRanges?: readonly WorldDocumentSourceRange[];
  yaml?: {
    readonly body: Record<string, unknown>;
    readonly nodes: readonly InternalYamlNode[];
  };
  markdown?: {
    readonly bodyStart: number;
    readonly headings: readonly InternalMarkdownHeading[];
  };
  readonly references: InternalReference[];
  readonly diagnostics: WorldDocumentDiagnostic[];
}

interface InternalYamlNode {
  readonly locatorKey: string;
  readonly range: WorldDocumentSourceRange;
}

interface InternalMarkdownHeading {
  readonly locator: readonly string[];
  readonly locatorKey: string;
  readonly range: WorldDocumentSourceRange;
}

interface ParsedRestrictedYaml {
  readonly root: YAMLMap<unknown, unknown>;
  readonly value: Record<string, unknown>;
  readonly baseOffset: number;
}

const maxYamlDepth = 64;

const maxYamlNodes = 100_000;

function inspectYamlDocument(
  entry: InternalDocumentEntry,
  rangeAt: SourceRangeReader,
): void {
  const parsed = parseRestrictedYaml(entry, entry.file.contents, 0, rangeAt);
  if (parsed === null) return;
  const header = readHeader(entry, parsed, false, rangeAt);
  if (header === null) return;
  entry.descriptor = header.descriptor;
  entry.headerRanges = header.ranges;
  entry.bodyRange = yamlBodyRange(entry.file.contents, parsed.root, rangeAt);
  entry.searchRanges = freeze([
    ...headerSearchRanges(header.ranges),
    entry.bodyRange,
  ]);
  inspectYamlReferences(entry, parsed.root, [], rangeAt);
  entry.yaml = {
    body: freeze(
      Object.fromEntries(
        Object.entries(parsed.value).filter(([key]) => key !== "$document"),
      ),
    ),
    nodes: freeze(indexYamlNodes(entry.file.contents, parsed.root, rangeAt)),
  };
}

function inspectMarkdownDocument(
  entry: InternalDocumentEntry,
  rangeAt: SourceRangeReader,
): void {
  const source = entry.file.contents;
  if (!source.startsWith("---\n")) {
    entry.diagnostics.push(
      diagnostic({
        code: "markdown_invalid",
        logicalPath: entry.file.path,
        range: rangeAt(0, Math.min(source.length, 3)),
        message: "Markdown must begin with $document front matter",
      }),
    );
    return;
  }
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) {
    entry.diagnostics.push(
      diagnostic({
        code: "markdown_invalid",
        logicalPath: entry.file.path,
        range: rangeAt(0, Math.min(source.length, 3)),
        message: "Markdown front matter is not closed",
      }),
    );
    return;
  }
  const parsed = parseRestrictedYaml(entry, source.slice(4, end), 4, rangeAt);
  if (parsed === null) return;
  const header = readHeader(entry, parsed, true, rangeAt);
  if (header === null) return;
  entry.descriptor = header.descriptor;
  entry.headerRanges = header.ranges;

  const bodyStart = end + 5;
  entry.bodyRange = rangeAt(bodyStart, source.length);
  entry.searchRanges = freeze([
    ...headerSearchRanges(header.ranges),
    entry.bodyRange,
  ]);
  const headings = scanMarkdownHeadings(source, bodyStart, rangeAt).headings;
  const topLevel = headings.filter(({ level }) => level === 1);
  if (
    headings.length === 0 ||
    headings[0]!.level !== 1 ||
    topLevel.length !== 1 ||
    headings[0]!.title.normalize("NFKC") !==
      header.descriptor.title.normalize("NFKC") ||
    headings.some(
      (heading, index) =>
        index > 0 && heading.level > headings[index - 1]!.level + 1,
    )
  )
    entry.diagnostics.push(
      diagnostic({
        code: "markdown_invalid",
        logicalPath: entry.file.path,
        documentId: header.descriptor.documentId,
        range: headings[0]?.range ?? rangeAt(bodyStart, source.length),
        message:
          "Markdown must have one h1 matching the technical title, and heading levels cannot be skipped",
      }),
    );

  const seen = new Map<string, WorldDocumentSourceRange>();
  const indexed: InternalMarkdownHeading[] = [];
  const stack: string[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.level === 1) {
      stack.length = 0;
      continue;
    }
    stack.length = heading.level - 2;
    stack[heading.level - 2] = heading.title.normalize("NFKC");
    const locator = [...stack];
    const key = JSON.stringify(locator);
    if (seen.has(key))
      entry.diagnostics.push(
        diagnostic({
          code: "locator_ambiguous",
          logicalPath: entry.file.path,
          documentId: header.descriptor.documentId,
          locator: { markdown: locator },
          range: heading.range,
          message: "Markdown heading paths must be unique within the document",
        }),
      );
    else seen.set(key, heading.range);
    const next = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    const rawEnd = next?.range.start.offset ?? source.length;
    const end = trimTrailingWhitespaceOffset(
      source,
      heading.range.start.offset,
      rawEnd,
    );
    indexed.push({
      locator: freeze(locator),
      locatorKey: key,
      range: rangeAt(heading.range.start.offset, end),
    });
  }
  entry.markdown = { bodyStart, headings: freeze(indexed) };
}

export function parseRestrictedYaml(
  entry: InternalDocumentEntry,
  source: string,
  baseOffset: number,
  rangeAt: SourceRangeReader = (start, end) =>
    sourceRange(entry.file.contents, start, end),
): ParsedRestrictedYaml | null {
  const { document, problems } = parseRestrictedYamlDocument(source, {
    rejectRawControlCharacters: true,
  });
  if (problems) {
    for (const problem of problems)
      entry.diagnostics.push(
        diagnostic({
          code: "yaml_invalid",
          logicalPath: entry.file.path,
          range: rangeAt(
            baseOffset + problem.pos[0],
            baseOffset + problem.pos[1],
          ),
          message: problem.message,
        }),
      );
    return null;
  }
  if (!isMap(document.contents)) {
    entry.diagnostics.push(
      diagnostic({
        code: "yaml_invalid",
        logicalPath: entry.file.path,
        range: rangeAt(baseOffset, baseOffset + source.length),
        message: "Top-level YAML must be a map",
      }),
    );
    return null;
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value)) return null;
  const shape = inspectShape(value);
  if (shape.capacityExceeded)
    entry.diagnostics.push(
      diagnostic({
        code: "capacity_exceeded",
        logicalPath: entry.file.path,
        range: nodeRange(rangeAt, document.contents, baseOffset),
        message: "YAML depth or node count exceeds world-document capacity",
      }),
    );
  if (shape.invalidNumber)
    entry.diagnostics.push(
      diagnostic({
        code: "yaml_invalid",
        logicalPath: entry.file.path,
        range: nodeRange(rangeAt, document.contents, baseOffset),
        message: "YAML numbers must be finite",
      }),
    );
  return {
    root: document.contents,
    value,
    baseOffset,
  };
}

function readHeader(
  entry: InternalDocumentEntry,
  parsed: ParsedRestrictedYaml,
  headerOnly: boolean,
  rangeAt: SourceRangeReader,
): { descriptor: WorldDocumentDescriptor; ranges: HeaderRanges } | null {
  const first = parsed.root.items[0];
  if (
    first === undefined ||
    !scalarEquals(first.key, "$document") ||
    !isMap(first.value)
  ) {
    entry.diagnostics.push(
      diagnostic({
        code: "document_header_invalid",
        logicalPath: entry.file.path,
        range: nodeRange(rangeAt, parsed.root, parsed.baseOffset),
        message: "$document must be the first document entry",
      }),
    );
    return null;
  }
  const header = first.value;
  const pairs = stringPairMap(header);
  const required = new Set(["id", "ref", "title", "summary", "aliases"]);
  const allowed = new Set([...required, "retired"]);
  const exactShape =
    (pairs.size === required.size || pairs.size === allowed.size) &&
    [...required].every((key) => pairs.has(key)) &&
    [...pairs.keys()].every((key) => allowed.has(key)) &&
    (!headerOnly || parsed.root.items.length === 1);
  const idPair = pairs.get("id");
  const refPair = pairs.get("ref");
  const titlePair = pairs.get("title");
  const summaryPair = pairs.get("summary");
  const aliasesPair = pairs.get("aliases");
  const retiredPair = pairs.get("retired");
  const id = scalarString(idPair?.value);
  const shortRef = scalarString(refPair?.value);
  const title = scalarString(titlePair?.value);
  const summary = scalarString(summaryPair?.value);
  const aliases = stringSequence(aliasesPair?.value);
  const retired =
    retiredPair === undefined ? false : scalarBoolean(retiredPair.value);
  let valid = exactShape && retired !== null;

  if (
    id === null ||
    id.length < 3 ||
    id.length > 128 ||
    !documentIdPattern.test(id)
  ) {
    valid = false;
    entry.diagnostics.push(
      diagnostic({
        code: "document_identity_invalid",
        logicalPath: entry.file.path,
        ...(idPair?.value === undefined
          ? {}
          : {
              range: nodeRange(rangeAt, idPair.value, parsed.baseOffset),
            }),
        message:
          "$document.id must be a stable lowercase identity within the world",
      }),
    );
  }
  if (
    shortRef === null ||
    shortRef.length < 2 ||
    shortRef.length > 32 ||
    !shortRefPattern.test(shortRef)
  ) {
    valid = false;
    entry.diagnostics.push(
      diagnostic({
        code: "document_short_ref_invalid",
        logicalPath: entry.file.path,
        ...(refPair?.value === undefined
          ? {}
          : {
              range: nodeRange(rangeAt, refPair.value, parsed.baseOffset),
            }),
        message: "$document.ref must be a stable lowercase short reference",
      }),
    );
  }
  if (
    title === null ||
    [...title].length < 1 ||
    [...title].length > 120 ||
    summary === null ||
    [...summary].length < 1 ||
    [...summary].length > 240 ||
    aliases === null ||
    aliases.length > 16 ||
    aliases.some((alias) => [...alias].length < 1 || [...alias].length > 64)
  )
    valid = false;

  if (!valid) {
    entry.diagnostics.push(
      diagnostic({
        code: "document_header_invalid",
        logicalPath: entry.file.path,
        ...(id !== null && documentIdPattern.test(id)
          ? { documentId: id }
          : {}),
        range: nodeRange(rangeAt, header, parsed.baseOffset),
        message:
          "$document must contain valid id, ref, title, summary, aliases, and an optional boolean retired flag",
      }),
    );
    return null;
  }

  const descriptor = freeze({
    documentId: id!,
    shortRef: shortRef!,
    title: title!,
    summary: summary!,
    aliases: freeze(aliases!),
    retired: retired!,
    codec: entry.codec!,
    logicalPath: entry.file.path,
  });
  return {
    descriptor,
    ranges: freeze({
      ...(idPair?.value === undefined
        ? {}
        : {
            documentId: nodeRange(rangeAt, idPair.value, parsed.baseOffset),
          }),
      ...(refPair?.value === undefined
        ? {}
        : {
            shortRef: nodeRange(rangeAt, refPair.value, parsed.baseOffset),
          }),
      ...(titlePair?.value === undefined
        ? {}
        : {
            title: nodeRange(rangeAt, titlePair.value, parsed.baseOffset),
          }),
      ...(summaryPair?.value === undefined
        ? {}
        : {
            summary: nodeRange(rangeAt, summaryPair.value, parsed.baseOffset),
          }),
      ...(aliasesPair?.value === undefined
        ? {}
        : {
            aliases: nodeRange(rangeAt, aliasesPair.value, parsed.baseOffset),
          }),
    }),
  };
}

function yamlBodyRange(
  source: string,
  root: YAMLMap<unknown, unknown>,
  rangeAt: SourceRangeReader,
): WorldDocumentSourceRange {
  const firstBodyPair = root.items.find(
    ({ key }) => !scalarEquals(key, "$document"),
  );
  const start =
    firstBodyPair === undefined || !isRangedNode(firstBodyPair.key)
      ? source.length
      : (firstBodyPair.key.range?.[0] ?? source.length);
  return rangeAt(start, source.length);
}

function headerSearchRanges(ranges: HeaderRanges): WorldDocumentSourceRange[] {
  return [ranges.title, ranges.summary, ranges.aliases].filter(
    (range): range is WorldDocumentSourceRange => range !== undefined,
  );
}

function indexYamlNodes(
  source: string,
  root: YAMLMap<unknown, unknown>,
  rangeAt: SourceRangeReader,
): InternalYamlNode[] {
  const result: InternalYamlNode[] = [];
  const bodyPairs = root.items.filter(
    ({ key }) => !scalarEquals(key, "$document"),
  );
  if (bodyPairs.length === 0)
    result.push({
      locatorKey: yamlLocatorKey([]),
      range: rangeAt(source.length, source.length),
    });
  else {
    const first = bodyPairs[0]!;
    const last = bodyPairs.at(-1)!;
    result.push({
      locatorKey: yamlLocatorKey([]),
      range: joinedNodeRange(rangeAt, first.key, last.value ?? last.key, 0),
    });
  }

  const visit = (
    node: unknown,
    locator: readonly (string | number)[],
  ): void => {
    if (isMap(node)) {
      if (node.items.some(({ key }) => scalarEquals(key, "$ref"))) return;
      for (const pair of node.items) {
        const key = scalarString(pair.key);
        if (key === null || (locator.length === 0 && key === "$document"))
          continue;
        const childLocator = [...locator, key];
        result.push({
          locatorKey: yamlLocatorKey(childLocator),
          range: nodeRange(rangeAt, pair.value ?? pair.key, 0),
        });
        visit(pair.value, childLocator);
      }
      return;
    }
    if (isSeq(node))
      node.items.forEach((child, index) => {
        const childLocator = [...locator, index];
        result.push({
          locatorKey: yamlLocatorKey(childLocator),
          range: nodeRange(rangeAt, child, 0),
        });
        visit(child, childLocator);
      });
  };
  visit(root, []);
  return result;
}

interface MarkdownHeadingScan {
  readonly headings: readonly {
    readonly level: number;
    readonly title: string;
    readonly range: WorldDocumentSourceRange;
  }[];
  readonly hasUnclosedFence: boolean;
}

export function scanMarkdownHeadings(
  source: string,
  bodyStart: number,
  rangeAt: SourceRangeReader = createSourceRangeReader(source),
): MarkdownHeadingScan {
  const headings: {
    level: number;
    title: string;
    range: WorldDocumentSourceRange;
  }[] = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | null =
    null;
  let lineStart = bodyStart;
  while (lineStart < source.length) {
    const nextNewline = source.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline;
    const line = source.slice(lineStart, lineEnd);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== null) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
      if (
        closing !== null &&
        closing[1]!.startsWith(fence.marker) &&
        closing[1]!.length >= fence.length
      )
        fence = null;
    } else if (fenceMatch !== null) {
      const run = fenceMatch[1]!;
      fence = {
        marker: run[0] as "`" | "~",
        length: run.length,
      };
    } else {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/u.exec(line);
      if (heading !== null) {
        const rawTitle = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/u, "");
        headings.push({
          level: heading[1]!.length,
          title: rawTitle.trim(),
          range: rangeAt(lineStart, lineEnd),
        });
      }
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }
  return { headings, hasUnclosedFence: fence !== null };
}

function inspectShape(value: unknown): {
  capacityExceeded: boolean;
  invalidNumber: boolean;
} {
  let nodes = 0;
  let capacityExceeded = false;
  let invalidNumber = false;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (depth > maxYamlDepth || nodes > maxYamlNodes) {
      capacityExceeded = true;
      return;
    }
    if (typeof candidate === "number" && !Number.isFinite(candidate))
      invalidNumber = true;
    else if (Array.isArray(candidate))
      candidate.forEach((child) => visit(child, depth + 1));
    else if (isRecord(candidate))
      Object.values(candidate).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
  return { capacityExceeded, invalidNumber };
}

function stringPairMap(
  map: YAMLMap<unknown, unknown>,
): Map<string, Pair<unknown, unknown>> {
  const result = new Map<string, Pair<unknown, unknown>>();
  for (const pair of map.items) {
    const key = scalarString(pair.key);
    if (key !== null) result.set(key, pair);
  }
  return result;
}

function scalarBoolean(value: unknown): boolean | null {
  return isScalar(value) && typeof value.value === "boolean"
    ? value.value
    : null;
}

function stringSequence(value: unknown): string[] | null {
  if (!isSeq(value)) return null;
  const result: string[] = [];
  for (const item of value.items) {
    const text = scalarString(item);
    if (text === null) return null;
    result.push(text);
  }
  return result;
}
