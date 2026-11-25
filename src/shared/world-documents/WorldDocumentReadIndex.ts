import {
  inspectDocumentFile,
  type InternalDocumentEntry,
} from "./WorldDocumentCodec.ts";
import {
  diagnoseDuplicateHeaders,
  diagnoseReferences,
  projectExplicitReferenceValues,
  projectYamlValue,
  selectYamlReferences,
  uniqueDocumentDescriptors,
} from "./WorldDocumentReferences.ts";
import {
  copyLocator,
  diagnostic,
  freeze,
  groupBy,
  hasOnlyKeys,
  isRecord,
  locatorStartsWith,
  sourceRange,
  validMarkdownLocator,
  validYamlLocator,
  yamlLocatorKey,
} from "./WorldDocumentSource.ts";
import type {
  WorldDocumentDescriptor,
  WorldDocumentDiagnostic,
  WorldDocumentFile,
  WorldDocumentLayout,
  WorldDocumentLocator,
  WorldDocumentQuery,
  WorldDocumentQueryFailure,
  WorldDocumentReadQuery,
  WorldDocumentReadResult,
  WorldDocumentSelectNodeQuery,
  WorldDocumentSelectNodeResult,
  WorldDocumentSnapshotStatus,
} from "./WorldDocumentTypes.ts";

/** Synchronous inspection and exact reads of one fixed file tree. */
export class WorldDocumentReadIndex {
  readonly id: string;
  readonly layout: WorldDocumentLayout;
  readonly logicalRoot: "world" | "state";
  readonly files: readonly WorldDocumentFile[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
  readonly status: WorldDocumentSnapshotStatus;
  readonly entries: readonly InternalDocumentEntry[];
  readonly #descriptors: ReadonlyMap<string, WorldDocumentDescriptor>;
  readonly #entriesById: ReadonlyMap<
    string | undefined,
    InternalDocumentEntry[]
  >;
  readonly #entriesByRef: ReadonlyMap<
    string | undefined,
    InternalDocumentEntry[]
  >;
  readonly #entriesByPath: ReadonlyMap<string, InternalDocumentEntry[]>;

  constructor(
    id: string,
    layout: WorldDocumentLayout,
    files: readonly WorldDocumentFile[],
    inspect = inspectDocumentFile,
  ) {
    this.id = id;
    this.layout = layout;
    const logicalRoot = layout === "content_package" ? "world" : "state";
    this.logicalRoot = logicalRoot;
    this.files = freeze(files.map((file) => freezeFile(file)));
    this.entries = this.files.flatMap((file, index) => {
      if (!file.path.startsWith(`${logicalRoot}/`)) return [];
      const inspection = inspect(files[index]!, logicalRoot);
      // Snapshot-wide checks add diagnostics to this entry alone.
      return [
        { ...inspection, file, diagnostics: [...inspection.diagnostics] },
      ];
    });
    this.#entriesByPath = groupBy(this.entries, ({ file }) => file.path);
    this.#entriesById = groupBy(
      this.entries,
      ({ descriptor }) => descriptor?.documentId,
    );
    this.#entriesByRef = groupBy(
      this.entries,
      ({ descriptor }) => descriptor?.shortRef,
    );
    this.#diagnoseDuplicateLogicalPaths();
    diagnoseDuplicateHeaders(this.entries);
    diagnoseReferences(this.entries);
    for (const entry of this.entries) freeze(entry.diagnostics);
    this.diagnostics = freeze(
      this.entries.flatMap(({ diagnostics }) => diagnostics),
    );
    this.status = this.diagnostics.length === 0 ? "usable" : "needs_repair";
    this.#descriptors = uniqueDocumentDescriptors(this.entries);
    freeze(this.entries);
  }

  queryExact(
    request: WorldDocumentReadQuery | WorldDocumentSelectNodeQuery,
  ):
    | WorldDocumentReadResult
    | WorldDocumentSelectNodeResult
    | WorldDocumentQueryFailure {
    return request.kind === "read_document"
      ? this.#readDocument(request)
      : this.#selectNode(request);
  }

  #readDocument(
    request: WorldDocumentReadQuery,
  ): WorldDocumentReadResult | WorldDocumentQueryFailure {
    if (!hasOnlyKeys(request, ["kind", "document", "referenceProjection"]))
      return this.failure("read_document", request, [
        diagnostic({
          code: "query_invalid",
          message: "read_document contains undeclared query conditions",
        }),
      ]);
    if (
      request.referenceProjection !== undefined &&
      request.referenceProjection !== "short_ref"
    )
      return this.failure("read_document", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "read_document referenceProjection, when present, must be short_ref",
        }),
      ]);
    const resolved = this.resolveSelector(request.document);
    if ("diagnostics" in resolved)
      return this.failure(
        "read_document",
        request,
        resolved.diagnostics,
        resolved.document,
      );
    const bodyRange = resolved.entry.bodyRange;
    if (bodyRange === undefined)
      return this.failure(
        "read_document",
        request,
        [
          diagnostic({
            code: "document_header_invalid",
            logicalPath: resolved.entry.file.path,
            documentId: resolved.entry.descriptor!.documentId,
            message: "World document has no readable body range",
          }),
        ],
        resolved.entry.descriptor,
      );
    const completeBody =
      request.referenceProjection === "short_ref"
        ? projectExplicitReferenceValues(
            resolved.entry.file.contents,
            bodyRange,
            resolved.entry.references,
            this.#descriptors,
            true,
          )
        : resolved.entry.file.contents.slice(
            bodyRange.start.offset,
            bodyRange.end.offset,
          );
    return freeze({
      kind: "read_document" as const,
      ok: true as const,
      snapshotId: this.id,
      snapshotStatus: this.status,
      scope: freeze({
        layout: this.layout,
        logicalRoot: this.logicalRoot,
        document: resolved.entry.descriptor!,
      }),
      coverage: freeze({
        status: "complete" as const,
        excludedDocuments: 0 as const,
      }),
      document: resolved.entry.descriptor!,
      codec: resolved.entry.codec!,
      body: completeBody,
      diagnostics: freeze([]),
    });
  }

  #selectNode(
    request: WorldDocumentSelectNodeQuery,
  ): WorldDocumentSelectNodeResult | WorldDocumentQueryFailure {
    if (!hasOnlyKeys(request, ["kind", "document", "locator"]))
      return this.failure("select_node", request, [
        diagnostic({
          code: "query_invalid",
          message: "select_node contains undeclared query conditions",
        }),
      ]);
    if (!isRecord(request.locator))
      return this.failure("select_node", request, [
        diagnostic({
          code: "query_invalid",
          message: "select_node must declare one closed locator",
        }),
      ]);
    const resolved = this.resolveSelector(request.document);
    if ("diagnostics" in resolved)
      return this.failure(
        "select_node",
        request,
        resolved.diagnostics,
        resolved.document,
      );
    const entry = resolved.entry;
    const locator = request.locator;
    if (
      entry.codec === "yaml" &&
      validYamlLocator(locator) &&
      entry.yaml !== undefined
    ) {
      const publicLocator = freeze({ yaml: freeze([...locator.yaml]) });
      const damagedSelection = yamlReferenceProblems(entry, locator.yaml);
      if (damagedSelection.length > 0)
        return this.failure(
          "select_node",
          request,
          damagedSelection,
          entry.descriptor,
        );
      const value = locateYamlValue(entry.yaml.body, locator.yaml);
      const node = entry.yaml.nodes.find(
        ({ locatorKey }) => locatorKey === yamlLocatorKey(locator.yaml),
      );
      if (value === unresolved || node === undefined)
        return this.#locatorFailure(entry, publicLocator, "locator_not_found");
      const projected = projectYamlValue(value, this.#descriptors);
      return this.#selected(
        entry,
        publicLocator,
        {
          codec: "yaml",
          locator: publicLocator,
          value: projected,
          range: node.range,
        },
        selectYamlReferences(entry, publicLocator, this.#descriptors),
      );
    }
    if (
      entry.codec === "markdown" &&
      validMarkdownLocator(locator) &&
      entry.markdown !== undefined
    ) {
      const publicLocator = freeze({
        markdown: freeze([...locator.markdown]),
      });
      const key = markdownLocatorKey(locator.markdown);
      const headings = entry.markdown.headings.filter(
        ({ locatorKey }) => locatorKey === key,
      );
      if (headings.length === 0)
        return this.#locatorFailure(entry, publicLocator, "locator_not_found");
      if (headings.length > 1)
        return this.#locatorFailure(entry, publicLocator, "locator_ambiguous");
      const heading = headings[0]!;
      const markdown = entry.file.contents.slice(
        heading.range.start.offset,
        heading.range.end.offset,
      );
      return this.#selected(
        entry,
        publicLocator,
        {
          codec: "markdown",
          locator: publicLocator,
          markdown,
          range: heading.range,
        },
        [],
      );
    }
    return this.#locatorFailure(entry, copyLocator(locator), "locator_invalid");
  }

  #selected(
    entry: InternalDocumentEntry & { descriptor?: WorldDocumentDescriptor },
    locator: WorldDocumentLocator,
    node: WorldDocumentSelectNodeResult["node"],
    references: WorldDocumentSelectNodeResult["references"],
  ): WorldDocumentSelectNodeResult {
    return freeze({
      kind: "select_node" as const,
      ok: true as const,
      snapshotId: this.id,
      snapshotStatus: this.status,
      scope: freeze({
        layout: this.layout,
        logicalRoot: this.logicalRoot,
        document: entry.descriptor!,
        locator,
      }),
      coverage: freeze({
        status: "complete" as const,
        excludedDocuments: 0 as const,
      }),
      document: entry.descriptor!,
      node: freeze(node),
      references: freeze(references),
      diagnostics: freeze([]),
    });
  }

  #locatorFailure(
    entry: InternalDocumentEntry,
    locator: WorldDocumentLocator,
    code: "locator_ambiguous" | "locator_invalid" | "locator_not_found",
  ): WorldDocumentQueryFailure {
    return this.failure(
      "select_node",
      { document: entry.file.path, locator },
      [
        diagnostic({
          code,
          logicalPath: entry.file.path,
          ...(entry.descriptor === undefined
            ? {}
            : { documentId: entry.descriptor.documentId }),
          locator,
          message:
            "Logical-node locator cannot be resolved uniquely for the target codec",
        }),
      ],
      entry.descriptor,
    );
  }

  resolveSelector(selector: unknown): WorldDocumentReadSelection {
    if (!isRecord(selector) || Object.keys(selector).length !== 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "query_invalid",
            message:
              "A document selector must declare only documentId, shortRef, or logicalPath",
          }),
        ]),
      };
    let matches: readonly InternalDocumentEntry[];
    if (
      typeof selector.documentId === "string" &&
      selector.documentId.length > 0
    )
      matches = this.#entriesById.get(selector.documentId) ?? [];
    else if (
      typeof selector.shortRef === "string" &&
      selector.shortRef.length > 0
    )
      matches = this.#entriesByRef.get(selector.shortRef) ?? [];
    else if (
      typeof selector.logicalPath === "string" &&
      selector.logicalPath.length > 0
    )
      matches = this.#entriesByPath.get(selector.logicalPath) ?? [];
    else
      return {
        diagnostics: freeze([
          diagnostic({
            code: "query_invalid",
            message: "Document-selector value must be a non-empty string",
          }),
        ]),
      };
    if (matches.length === 0)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_not_found",
            message: "Target world document does not exist in the snapshot",
          }),
        ]),
      };
    if (matches.length > 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_ambiguous",
            message: "Target world document is not unique in the snapshot",
          }),
          ...matches.flatMap(({ diagnostics }) => diagnostics),
        ]),
      };
    const entry = matches[0]!;
    const blockingDiagnostics = blockingDocumentDiagnostics(entry);
    if (entry.descriptor === undefined || blockingDiagnostics.length > 0)
      return {
        diagnostics: blockingDiagnostics,
        ...(entry.descriptor === undefined
          ? {}
          : { document: entry.descriptor }),
      };
    return { entry };
  }

  protected failure(
    requestKind: WorldDocumentQuery["kind"] | null,
    scope: unknown,
    diagnostics: readonly WorldDocumentDiagnostic[],
    document?: WorldDocumentDescriptor,
  ): WorldDocumentQueryFailure {
    return freeze({
      kind: "error" as const,
      ok: false as const,
      requestKind,
      snapshotId: this.id,
      snapshotStatus: this.status,
      scope: freeze(copyPublicValue(scope)),
      ...(document === undefined ? {} : { document }),
      diagnostics: freeze([...diagnostics]),
    });
  }

  #diagnoseDuplicateLogicalPaths(): void {
    for (const entries of this.#entriesByPath.values()) {
      if (entries.length < 2) continue;
      for (const entry of entries)
        entry.diagnostics.push(
          diagnostic({
            code: "logical_path_duplicate",
            logicalPath: entry.file.path,
            range: sourceRange(
              entry.file.contents,
              0,
              entry.file.contents.length,
            ),
            message:
              "The fixed file set contains duplicate world-document logical paths",
          }),
        );
    }
  }
}

export type WorldDocumentReadSelection =
  | { readonly entry: InternalDocumentEntry }
  | {
      readonly diagnostics: readonly WorldDocumentDiagnostic[];
      readonly document?: WorldDocumentDescriptor;
    };

export function yamlReferenceProblems(
  entry: InternalDocumentEntry,
  locator: readonly (string | number)[],
): readonly WorldDocumentDiagnostic[] {
  return entry.diagnostics.filter(
    (problem) =>
      problem.code === "document_reference_invalid" &&
      problem.locator !== undefined &&
      "yaml" in problem.locator &&
      yamlLocatorsOverlap(locator, problem.locator.yaml),
  );
}

const unresolved = Symbol("world-document-node-unresolved");

export function locateYamlValue(
  body: Record<string, unknown>,
  locator: readonly (string | number)[],
): unknown {
  let current: unknown = body;
  for (const segment of locator) {
    if (
      typeof segment === "string" &&
      isRecord(current) &&
      Object.hasOwn(current, segment)
    )
      current = current[segment];
    else if (
      typeof segment === "number" &&
      Array.isArray(current) &&
      segment >= 0 &&
      segment < current.length
    )
      current = current[segment];
    else return unresolved;
  }
  return current;
}

function markdownLocatorKey(locator: readonly string[]): string {
  return JSON.stringify(locator.map((part) => part.normalize("NFKC")));
}

function freezeFile(file: WorldDocumentFile): WorldDocumentFile {
  return freeze({
    path: file.path,
    contents: file.contents,
    ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
  });
}

function blockingDocumentDiagnostics(
  entry: InternalDocumentEntry,
): readonly WorldDocumentDiagnostic[] {
  return entry.diagnostics.filter(
    ({ code }) =>
      code !== "locator_ambiguous" && code !== "document_reference_invalid",
  );
}

function yamlLocatorsOverlap(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return locatorStartsWith(left, right) || locatorStartsWith(right, left);
}

function copyPublicValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  )
    return value;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((entry) => copyPublicValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      copyPublicValue(entry, seen),
    ]),
  );
}
