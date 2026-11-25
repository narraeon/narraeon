import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mapLiteralSource, normalizeLiteral } from "../../LiteralSearch.ts";
import {
  inspectDocumentFile,
  type InternalDocumentEntry,
} from "../../../shared/world-documents/WorldDocumentCodec.ts";
import {
  projectExplicitReferenceValues,
  uniqueDocumentDescriptors,
} from "../../../shared/world-documents/WorldDocumentReferences.ts";
import { WorldDocumentReadIndex } from "../../../shared/world-documents/WorldDocumentReadIndex.ts";
import {
  diagnostic,
  freeze,
  hasOnlyKeys,
  isRecord,
  sourceRange,
  validRelativePath,
} from "../../../shared/world-documents/WorldDocumentSource.ts";
import type {
  WorldDocumentCatalogEntry,
  WorldDocumentCatalogQuery,
  WorldDocumentCatalogResult,
  WorldDocumentDescriptor,
  WorldDocumentDiagnostic,
  WorldDocumentFile,
  WorldDocumentLayout,
  WorldDocumentLiteralSearchQuery,
  WorldDocumentLiteralSearchResult,
  WorldDocumentQuery,
  WorldDocumentQueryFailure,
  WorldDocumentQueryResult,
  WorldDocumentSourceRange,
} from "../../../shared/world-documents/WorldDocumentTypes.ts";

/** Runtime queries of one fixed document tree, including its private cursor scope. */
export class WorldDocumentIndex extends WorldDocumentReadIndex {
  readonly #cursorSecret = randomBytes(32);
  readonly #fileInspections: ReadonlyMap<string, InternalDocumentEntry>;

  constructor(
    layout: WorldDocumentLayout,
    files: readonly WorldDocumentFile[],
    previousFiles?: ReadonlyMap<string, InternalDocumentEntry>,
  ) {
    const inspections = new Map<string, InternalDocumentEntry>();
    super(
      `world-document-snapshot:${randomUUID()}`,
      layout,
      files,
      (file, logicalRoot) => {
        const cached = previousFiles?.get(file.path);
        const inspection =
          cached?.file.contents === file.contents &&
          cached.file.encoding === file.encoding
            ? cached
            : freeze(inspectDocumentFile({ ...file }, logicalRoot));
        inspections.set(file.path, inspection);
        return inspection;
      },
    );
    this.#fileInspections = inspections;
    Object.freeze(this);
  }

  withFiles(files: readonly WorldDocumentFile[]): WorldDocumentIndex {
    return new WorldDocumentIndex(this.layout, files, this.#fileInspections);
  }

  query(request: WorldDocumentQuery): WorldDocumentQueryResult {
    if (!isRecord(request) || typeof request.kind !== "string")
      return this.failure(null, null, [
        diagnostic({
          code: "query_invalid",
          message:
            "WorldDocumentStore.query accepts only closed query requests",
        }),
      ]);
    if (request.kind === "catalog") return this.#catalog(request);
    if (request.kind === "literal_search") return this.#literalSearch(request);
    if (request.kind === "read_document" || request.kind === "select_node")
      return this.queryExact(request);
    return this.failure(null, null, [
      diagnostic({
        code: "query_invalid",
        message: "WorldDocumentStore.query accepts only closed query requests",
      }),
    ]);
  }

  #catalog(
    request: WorldDocumentCatalogQuery,
  ): WorldDocumentCatalogResult | WorldDocumentQueryFailure {
    if (
      !hasOnlyKeys(request, [
        "kind",
        "directory",
        "includeRetired",
        "declaredDirectories",
        "limit",
        "cursor",
      ])
    )
      return this.failure("catalog", request, [
        diagnostic({
          code: "query_invalid",
          message: "Catalog contains undeclared query conditions",
        }),
      ]);
    const directory = request.directory ?? "";
    const includeRetired = request.includeRetired ?? true;
    const declaredDirectories: unknown = request.declaredDirectories ?? [];
    const limit = request.limit ?? 20;
    if (
      (directory !== "" && !validRelativePath(directory)) ||
      typeof includeRetired !== "boolean" ||
      !validDeclaredDirectories(declaredDirectories) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return this.failure("catalog", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "Catalog directories must be within the layout root, and limit must be 1 to 100",
        }),
      ]);
    const normalizedDeclaredDirectories = [
      ...new Set(declaredDirectories),
    ].sort((left, right) => left.localeCompare(right));
    const relativePrefix = directory === "" ? "" : `${directory}/`;
    const prefix = `${this.logicalRoot}/${relativePrefix}`;
    const entries = new Map<string, WorldDocumentCatalogEntry>();
    let excludedDocuments = 0;
    for (const entry of this.entries) {
      if (!entry.file.path.startsWith(prefix)) continue;
      const relative = entry.file.path.slice(prefix.length);
      const slash = relative.indexOf("/");
      if (slash >= 0) {
        const child = relative.slice(0, slash);
        entries.set(
          `directory:${child}`,
          freeze({
            kind: "directory" as const,
            logicalPath: `${prefix}${child}`,
          }),
        );
      } else {
        if (entry.descriptor?.retired === true && !includeRetired) {
          excludedDocuments += 1;
          continue;
        }
        entries.set(
          `document:${relative}`,
          freeze({
            kind: "document" as const,
            logicalPath: entry.file.path,
            status:
              entry.descriptor !== undefined && entry.diagnostics.length === 0
                ? ("queryable" as const)
                : ("damaged" as const),
            ...(entry.descriptor === undefined
              ? {}
              : { document: entry.descriptor }),
            diagnostics: entry.diagnostics,
          }),
        );
      }
    }
    for (const declaredDirectory of normalizedDeclaredDirectories) {
      if (!declaredDirectory.startsWith(relativePrefix)) continue;
      const relative = declaredDirectory.slice(relativePrefix.length);
      if (relative === "") continue;
      const slash = relative.indexOf("/");
      const child = slash < 0 ? relative : relative.slice(0, slash);
      entries.set(
        `directory:${child}`,
        freeze({
          kind: "directory" as const,
          logicalPath: `${prefix}${child}`,
        }),
      );
    }
    const ordered = [...entries.values()].sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath),
    );
    const cursorScope = JSON.stringify({
      kind: "catalog",
      layout: this.layout,
      logicalRoot: this.logicalRoot,
      directory,
      declaredDirectories: normalizedDeclaredDirectories,
      includeRetired,
      limit,
    });
    const offset = this.#cursorOffset(request.cursor, cursorScope);
    if (offset === null || offset > ordered.length)
      return this.#cursorFailure("catalog", request);
    const pageEntries = ordered.slice(offset, offset + limit);
    const end = offset + pageEntries.length;
    const complete = end >= ordered.length;
    return freeze({
      kind: "catalog" as const,
      ok: true as const,
      snapshotId: this.id,
      snapshotStatus: this.status,
      scope: freeze({
        layout: this.layout,
        logicalRoot: this.logicalRoot,
        directory,
      }),
      coverage: freeze({
        status: "complete" as const,
        excludedDocuments,
      }),
      page: freeze({
        unit: "entries" as const,
        start: offset,
        end,
        total: ordered.length,
        complete,
        nextCursor: complete ? null : this.#cursor(cursorScope, end),
      }),
      entries: freeze(pageEntries),
      diagnostics: freeze([]),
    });
  }

  #literalSearch(
    request: WorldDocumentLiteralSearchQuery,
  ): WorldDocumentLiteralSearchResult | WorldDocumentQueryFailure {
    if (
      !hasOnlyKeys(request, [
        "kind",
        "query",
        "caseSensitive",
        "within",
        "limit",
        "cursor",
      ])
    )
      return this.failure("literal_search", request, [
        diagnostic({
          code: "query_invalid",
          message: "literal_search contains undeclared query conditions",
        }),
      ]);
    const caseSensitive = request.caseSensitive ?? false;
    const limit = request.limit ?? 20;
    if (
      typeof request.query !== "string" ||
      request.query.length < 1 ||
      request.query.length > 256 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (request.caseSensitive !== undefined &&
        typeof request.caseSensitive !== "boolean")
    )
      return this.failure("literal_search", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "literal_search requires a 1-to-256-character literal and a limit from 1 to 100",
        }),
      ]);
    let candidates: readonly InternalDocumentEntry[] = this.entries;
    let within:
      | null
      | { readonly directory: string }
      | { readonly document: WorldDocumentDescriptor } = null;
    if (request.within !== undefined) {
      if (!isRecord(request.within))
        return this.failure("literal_search", request, [
          diagnostic({
            code: "query_invalid",
            message: "literal_search within must be a closed query scope",
          }),
        ]);
      if (
        "directory" in request.within &&
        Object.keys(request.within).length === 1 &&
        typeof request.within.directory === "string"
      ) {
        if (
          request.within.directory !== "" &&
          !validRelativePath(request.within.directory)
        )
          return this.failure("literal_search", request, [
            diagnostic({
              code: "query_invalid",
              message:
                "literal_search directory must be a logical directory within the layout root",
            }),
          ]);
        const relativePrefix =
          request.within.directory === "" ? "" : `${request.within.directory}/`;
        const prefix = `${this.logicalRoot}/${relativePrefix}`;
        candidates = candidates.filter(({ file }) =>
          file.path.startsWith(prefix),
        );
        within = freeze({
          directory:
            request.within.directory === ""
              ? this.logicalRoot
              : `${this.logicalRoot}/${request.within.directory}`,
        });
      } else if (
        "document" in request.within &&
        Object.keys(request.within).length === 1 &&
        request.within.document !== undefined
      ) {
        const resolved = this.resolveSelector(request.within.document);
        if ("diagnostics" in resolved)
          return this.failure(
            "literal_search",
            request,
            resolved.diagnostics,
            resolved.document,
          );
        candidates = [resolved.entry];
        within = freeze({ document: resolved.entry.descriptor! });
      } else
        return this.failure("literal_search", request, [
          diagnostic({
            code: "query_invalid",
            message:
              "literal_search within must declare only directory or document",
          }),
        ]);
    }

    const query = normalizeLiteral(request.query, caseSensitive);
    if (query.length === 0)
      return this.failure("literal_search", request, [
        diagnostic({
          code: "query_invalid",
          message: "literal_search cannot be empty after normalization",
        }),
      ]);
    const excluded = candidates.filter(
      (entry) =>
        entry.descriptor === undefined ||
        literalSearchBlockingDiagnostics(entry).length > 0,
    );
    const matches: {
      document: WorldDocumentDescriptor;
      text: string;
      range: WorldDocumentSourceRange;
      excerpt: { text: string; range: WorldDocumentSourceRange };
      referenceProjection: { text: string; excerpt: string };
    }[] = [];
    const descriptors = uniqueDocumentDescriptors(this.entries);
    for (const entry of candidates) {
      if (
        entry.descriptor === undefined ||
        literalSearchBlockingDiagnostics(entry).length > 0
      )
        continue;
      for (const searchableRange of entry.searchRanges ?? []) {
        const searchable = entry.file.contents.slice(
          searchableRange.start.offset,
          searchableRange.end.offset,
        );
        for (const relativeMatch of literalMatches(
          searchable,
          query,
          caseSensitive,
        )) {
          if (matches.length >= maxLiteralSearchMatches)
            return this.failure("literal_search", request, [
              diagnostic({
                code: "capacity_exceeded",
                message:
                  "Literal-search matches exceed the capacity of one snapshot query",
              }),
            ]);
          const match = {
            start: searchableRange.start.offset + relativeMatch.start,
            end: searchableRange.start.offset + relativeMatch.end,
          };
          const excerptRange = lineExcerptRange(
            entry.file.contents,
            match.start,
            match.end,
          );
          const matchRange = sourceRange(
            entry.file.contents,
            match.start,
            match.end,
          );
          matches.push({
            document: entry.descriptor,
            text: entry.file.contents.slice(match.start, match.end),
            range: matchRange,
            excerpt: freeze({
              text: entry.file.contents.slice(
                excerptRange.start.offset,
                excerptRange.end.offset,
              ),
              range: excerptRange,
            }),
            referenceProjection: freeze({
              text: projectExplicitReferenceValues(
                entry.file.contents,
                matchRange,
                entry.references,
                descriptors,
              ),
              excerpt: projectExplicitReferenceValues(
                entry.file.contents,
                excerptRange,
                entry.references,
                descriptors,
              ),
            }),
          });
        }
      }
    }
    const cursorScope = JSON.stringify({
      kind: "literal_search",
      layout: this.layout,
      logicalRoot: this.logicalRoot,
      query: request.query,
      caseSensitive,
      within: request.within ?? null,
      limit,
    });
    const offset = this.#cursorOffset(request.cursor, cursorScope);
    if (offset === null || offset > matches.length)
      return this.#cursorFailure("literal_search", request);
    const pageMatches = matches
      .slice(offset, offset + limit)
      .map((match) => freeze(match));
    const end = offset + pageMatches.length;
    const complete = end >= matches.length;
    const diagnostics = freeze(excluded.flatMap((entry) => entry.diagnostics));
    return freeze({
      kind: "literal_search" as const,
      ok: true as const,
      snapshotId: this.id,
      snapshotStatus: this.status,
      scope: freeze({
        layout: this.layout,
        logicalRoot: this.logicalRoot,
        query: request.query,
        caseSensitive,
        within,
      }),
      coverage: freeze({
        status:
          excluded.length === 0 ? ("complete" as const) : ("partial" as const),
        excludedDocuments: excluded.length,
      }),
      page: freeze({
        unit: "matches" as const,
        start: offset,
        end,
        total: matches.length,
        complete,
        nextCursor: complete ? null : this.#cursor(cursorScope, end),
      }),
      matches: freeze(pageMatches),
      diagnostics,
    });
  }

  #cursor(scope: string, offset: number): string {
    const payload = Buffer.from(JSON.stringify({ offset }), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.#cursorSecret)
      .update(this.id)
      .update("\0")
      .update(scope)
      .update("\0")
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #cursorOffset(cursor: unknown, scope: string): number | null {
    if (cursor === undefined || cursor === null) return 0;
    if (typeof cursor !== "string") return null;
    const parts = cursor.split(".");
    if (parts.length !== 2) return null;
    const [payload, suppliedSignature] = parts;
    if (
      payload === undefined ||
      suppliedSignature === undefined ||
      !base64UrlPattern.test(payload) ||
      !base64UrlPattern.test(suppliedSignature)
    )
      return null;
    const expectedSignature = createHmac("sha256", this.#cursorSecret)
      .update(this.id)
      .update("\0")
      .update(scope)
      .update("\0")
      .update(payload)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, "base64url");
      if (supplied.toString("base64url") !== suppliedSignature) return null;
    } catch {
      return null;
    }
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    )
      return null;
    try {
      const decodedPayload = Buffer.from(payload, "base64url");
      if (decodedPayload.toString("base64url") !== payload) return null;
      const value: unknown = JSON.parse(decodedPayload.toString("utf8"));
      return isRecord(value) &&
        Object.keys(value).length === 1 &&
        Number.isSafeInteger(value.offset) &&
        Number(value.offset) >= 0
        ? Number(value.offset)
        : null;
    } catch {
      return null;
    }
  }

  #cursorFailure(
    requestKind: "catalog" | "literal_search" | "read_document",
    scope: unknown,
  ): WorldDocumentQueryFailure {
    return this.failure(requestKind, scope, [
      diagnostic({
        code: "cursor_invalid",
        message:
          "Cursor does not match the current snapshot or all query conditions",
      }),
    ]);
  }
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const maxLiteralSearchMatches = 10_000;

function literalMatches(
  source: string,
  normalizedQuery: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  const { normalized, ranges } = mapLiteralSource(
    source,
    caseSensitive,
    "codeUnits",
  );
  const result: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  let from = 0;
  while (from <= normalized.length - normalizedQuery.length) {
    const found = normalized.indexOf(normalizedQuery, from);
    if (found < 0) break;
    const start = ranges[found]?.start;
    const end = ranges[found + normalizedQuery.length - 1]?.end;
    if (start !== undefined && end !== undefined) {
      const key = `${start}:${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ start, end });
      }
    }
    from = found + Math.max(1, normalizedQuery.length);
  }
  return result;
}

function lineExcerptRange(
  source: string,
  matchStart: number,
  matchEnd: number,
): WorldDocumentSourceRange {
  const lineStart = source.lastIndexOf("\n", Math.max(0, matchStart - 1)) + 1;
  const followingNewline = source.indexOf("\n", matchEnd);
  const lineEnd = followingNewline < 0 ? source.length : followingNewline;
  const start = Math.max(lineStart, matchStart - 160);
  const end = Math.min(lineEnd, matchEnd + 160);
  return sourceRange(source, start, end);
}

function validDeclaredDirectories(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (candidate: unknown) =>
        typeof candidate === "string" && validRelativePath(candidate),
    )
  );
}

function literalSearchBlockingDiagnostics(
  entry: InternalDocumentEntry,
): readonly WorldDocumentDiagnostic[] {
  return entry.diagnostics.filter(({ code }) => code !== "locator_ambiguous");
}
