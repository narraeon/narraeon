import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";

export type WorldDocumentLayout = "content_package" | "world_state";
export type WorldDocumentCodec = "yaml" | "markdown";
export type WorldDocumentSnapshotStatus = "usable" | "needs_repair";

export interface WorldDocumentFile {
  readonly path: string;
  readonly contents: string;
  readonly encoding?: "base64";
}

export interface WorldDocumentDescriptor {
  readonly documentId: string;
  readonly shortRef: string;
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  readonly codec: WorldDocumentCodec;
  readonly logicalPath: string;
}

export type WorldDocumentLocator =
  | { readonly yaml: readonly (string | number)[] }
  | { readonly markdown: readonly string[] };

/** Offsets and columns count UTF-16 code units; byteOffset counts UTF-8 bytes. */
export interface WorldDocumentSourcePoint {
  readonly offset: number;
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface WorldDocumentSourceRange {
  readonly start: WorldDocumentSourcePoint;
  readonly end: WorldDocumentSourcePoint;
}

export type WorldDocumentDiagnosticCode =
  | "capacity_exceeded"
  | "cursor_invalid"
  | "document_ambiguous"
  | "document_header_invalid"
  | "document_identity_duplicate"
  | "document_identity_invalid"
  | "document_not_found"
  | "document_reference_invalid"
  | "document_short_ref_duplicate"
  | "document_short_ref_invalid"
  | "locator_ambiguous"
  | "locator_invalid"
  | "locator_not_found"
  | "logical_path_duplicate"
  | "logical_path_invalid"
  | "markdown_invalid"
  | "query_invalid"
  | "world_document_binary"
  | "world_document_codec_unsupported"
  | "yaml_invalid";

export interface WorldDocumentDiagnostic {
  readonly code: WorldDocumentDiagnosticCode;
  readonly logicalPath?: string;
  readonly documentId?: string;
  readonly locator?: WorldDocumentLocator;
  readonly range?: WorldDocumentSourceRange;
  /** Human-facing only; callers must branch on code and structured fields. */
  readonly message: string;
}

export interface WorldDocumentCatalogQuery {
  readonly kind: "catalog";
  readonly directory?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export type WorldDocumentSelector =
  | { readonly documentId: string }
  | { readonly shortRef: string }
  | { readonly logicalPath: string };

export type WorldDocumentSearchScope =
  { readonly directory: string } | { readonly document: WorldDocumentSelector };

export interface WorldDocumentLiteralSearchQuery {
  readonly kind: "literal_search";
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly within?: WorldDocumentSearchScope;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface WorldDocumentReadQuery {
  readonly kind: "read_document";
  readonly document: WorldDocumentSelector;
  readonly maxBytes?: number;
  readonly cursor?: string | null;
  /** Replace persisted reference identities with quoted @short-ref values. */
  readonly referenceProjection?: "short_ref";
}

export interface WorldDocumentSelectNodeQuery {
  readonly kind: "select_node";
  readonly document: WorldDocumentSelector;
  readonly locator: WorldDocumentLocator;
}

export type WorldDocumentQuery =
  | WorldDocumentCatalogQuery
  | WorldDocumentLiteralSearchQuery
  | WorldDocumentReadQuery
  | WorldDocumentSelectNodeQuery;

export type WorldDocumentValue =
  | null
  | boolean
  | number
  | string
  | readonly WorldDocumentValue[]
  | { readonly [key: string]: WorldDocumentValue };

export type WorldDocumentCatalogEntry =
  | {
      readonly kind: "directory";
      readonly logicalPath: string;
    }
  | {
      readonly kind: "document";
      readonly logicalPath: string;
      readonly status: "queryable" | "damaged";
      readonly document?: WorldDocumentDescriptor;
      readonly diagnostics: readonly WorldDocumentDiagnostic[];
    };

export interface WorldDocumentCatalogResult {
  readonly kind: "catalog";
  readonly ok: true;
  readonly snapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly scope: {
    readonly layout: WorldDocumentLayout;
    readonly logicalRoot: "world" | "state";
    readonly directory: string;
  };
  readonly coverage: {
    readonly status: "complete" | "partial";
    readonly excludedDocuments: number;
  };
  readonly page: {
    readonly unit: "entries";
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly complete: boolean;
    readonly nextCursor: string | null;
  };
  readonly entries: readonly WorldDocumentCatalogEntry[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
}

export interface WorldDocumentLiteralSearchResult {
  readonly kind: "literal_search";
  readonly ok: true;
  readonly snapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly scope: {
    readonly layout: WorldDocumentLayout;
    readonly logicalRoot: "world" | "state";
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly within:
      | null
      | { readonly directory: string }
      | { readonly document: WorldDocumentDescriptor };
  };
  readonly coverage: {
    readonly status: "complete" | "partial";
    readonly excludedDocuments: number;
  };
  readonly page: {
    readonly unit: "matches";
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly complete: boolean;
    readonly nextCursor: string | null;
  };
  readonly matches: readonly {
    readonly document: WorldDocumentDescriptor;
    readonly text: string;
    readonly range: WorldDocumentSourceRange;
    readonly excerpt: {
      readonly text: string;
      readonly range: WorldDocumentSourceRange;
    };
    readonly referenceProjection: {
      readonly text: string;
      readonly excerpt: string;
    };
  }[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
}

export interface WorldDocumentReadResult {
  readonly kind: "read_document";
  readonly ok: true;
  readonly snapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly scope: {
    readonly layout: WorldDocumentLayout;
    readonly logicalRoot: "world" | "state";
    readonly document: WorldDocumentDescriptor;
  };
  readonly coverage: {
    readonly status: "complete";
    readonly excludedDocuments: 0;
  };
  readonly document: WorldDocumentDescriptor;
  readonly codec: WorldDocumentCodec;
  readonly body: string;
  readonly page: {
    readonly unit: "utf8_bytes";
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly complete: boolean;
    readonly nextCursor: string | null;
  };
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
}

export interface WorldDocumentSelectNodeResult {
  readonly kind: "select_node";
  readonly ok: true;
  readonly snapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly scope: {
    readonly layout: WorldDocumentLayout;
    readonly logicalRoot: "world" | "state";
    readonly document: WorldDocumentDescriptor;
    readonly locator: WorldDocumentLocator;
  };
  readonly coverage: {
    readonly status: "complete";
    readonly excludedDocuments: 0;
  };
  readonly document: WorldDocumentDescriptor;
  readonly node:
    | {
        readonly codec: "yaml";
        readonly locator: WorldDocumentLocator;
        readonly value: WorldDocumentValue;
        readonly range: WorldDocumentSourceRange;
      }
    | {
        readonly codec: "markdown";
        readonly locator: WorldDocumentLocator;
        readonly markdown: string;
        readonly range: WorldDocumentSourceRange;
      };
  /** Explicit whole-document references contained by the selected YAML node. */
  readonly references: readonly {
    readonly locator: WorldDocumentLocator;
    readonly target: WorldDocumentDescriptor;
  }[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
}

export interface WorldDocumentQueryFailure {
  readonly kind: "error";
  readonly ok: false;
  readonly requestKind: WorldDocumentQuery["kind"] | null;
  readonly snapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly scope: unknown;
  /** Resolved public identity when the target document itself was unambiguous. */
  readonly document?: WorldDocumentDescriptor;
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
}

export type WorldDocumentQueryResult =
  | WorldDocumentCatalogResult
  | WorldDocumentLiteralSearchResult
  | WorldDocumentReadResult
  | WorldDocumentSelectNodeResult
  | WorldDocumentQueryFailure;

export type WorldDocumentRevisionYamlValue =
  | null
  | boolean
  | number
  | string
  | readonly WorldDocumentRevisionYamlValue[]
  | { readonly [key: string]: WorldDocumentRevisionYamlValue };

export type WorldDocumentRevisionTarget =
  WorldDocumentSelector | { readonly temporaryName: string };

export interface WorldDocumentMetadataInput {
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
}

interface WorldDocumentCreateRevisionCommandBase extends WorldDocumentMetadataInput {
  readonly kind: "create";
  readonly temporaryName: string;
  readonly logicalPath: string;
  readonly refHint: string;
}

export type WorldDocumentCreateRevisionCommand =
  WorldDocumentCreateRevisionCommandBase &
    (
      | {
          readonly codec: "yaml";
          readonly body:
            Readonly<Record<string, WorldDocumentRevisionYamlValue>> | string;
        }
      | { readonly codec: "markdown"; readonly body: string }
    );

export interface WorldDocumentYamlValueRevisionEdit {
  readonly op: "add" | "replace" | "append";
  readonly locator: { readonly yaml: readonly (string | number)[] };
  readonly value: WorldDocumentRevisionYamlValue;
}

export interface WorldDocumentYamlRemoveRevisionEdit {
  readonly op: "remove";
  readonly locator: { readonly yaml: readonly (string | number)[] };
}

export type WorldDocumentMetadataRevisionEdit = {
  readonly op: "set_metadata";
} & (
  | {
      readonly title: string;
      readonly summary?: string;
      readonly aliases?: readonly string[];
    }
  | {
      readonly title?: string;
      readonly summary: string;
      readonly aliases?: readonly string[];
    }
  | {
      readonly title?: string;
      readonly summary?: string;
      readonly aliases: readonly string[];
    }
);

export interface WorldDocumentMarkdownSectionRevisionEdit {
  readonly op: "replace_section" | "add_section";
  readonly locator: { readonly markdown: readonly string[] };
  readonly markdown: string;
}

export interface WorldDocumentMarkdownRenameRevisionEdit {
  readonly op: "rename_section";
  readonly locator: { readonly markdown: readonly string[] };
  readonly title: string;
}

export interface WorldDocumentMarkdownRemoveRevisionEdit {
  readonly op: "remove_section";
  readonly locator: { readonly markdown: readonly string[] };
}

export interface WorldDocumentMarkdownBodyRevisionEdit {
  readonly op: "replace_body" | "replace_preamble";
  readonly markdown: string;
}

export type WorldDocumentRevisionEdit =
  | WorldDocumentYamlValueRevisionEdit
  | WorldDocumentYamlRemoveRevisionEdit
  | WorldDocumentMetadataRevisionEdit
  | WorldDocumentMarkdownSectionRevisionEdit
  | WorldDocumentMarkdownRenameRevisionEdit
  | WorldDocumentMarkdownRemoveRevisionEdit
  | WorldDocumentMarkdownBodyRevisionEdit;

export interface WorldDocumentPatchRevisionCommand {
  readonly kind: "patch";
  readonly document: WorldDocumentRevisionTarget;
  readonly edits: readonly WorldDocumentRevisionEdit[];
}

export interface WorldDocumentMoveRevisionCommand {
  readonly kind: "move";
  readonly document: WorldDocumentRevisionTarget;
  readonly toLogicalPath: string;
}

export interface WorldDocumentReplaceRevisionCommand {
  readonly kind: "replace";
  readonly document: WorldDocumentRevisionTarget;
  readonly contents: string;
}

/**
 * Create-or-replace by logical path from one complete source text. The author
 * always writes the whole document, `$document` header included; the store owns
 * `id` and `ref`, minting them for a new path and preserving them for an
 * existing one. Whatever identity the author wrote is ignored, never rejected.
 */
export interface WorldDocumentWriteRevisionCommand {
  readonly kind: "write";
  readonly logicalPath: string;
  readonly contents: string;
}

export type WorldDocumentRevisionCommand =
  | WorldDocumentCreateRevisionCommand
  | WorldDocumentMoveRevisionCommand
  | WorldDocumentPatchRevisionCommand
  | WorldDocumentReplaceRevisionCommand
  | WorldDocumentWriteRevisionCommand;

/**
 * An ephemeral candidate-tree expansion against one fixed document snapshot.
 * Content packages allow create/move/patch/replace under `world`; world state
 * allows create/patch/replace under `state`. It never publishes authority.
 */
export interface WorldDocumentRevisionRequest {
  readonly commands: readonly WorldDocumentRevisionCommand[];
}

export interface WorldDocumentRevisionDiagnostic extends WorldDocumentDiagnostic {
  readonly commandIndex: number | null;
}

export interface WorldDocumentRevisionFileVersion {
  readonly logicalPath: string;
  readonly contents: string;
  readonly mechanicalHash: string;
}

export interface WorldDocumentRevisionChange {
  readonly documentId: string;
  readonly shortRef: string;
  readonly codec: WorldDocumentCodec;
  readonly before: WorldDocumentRevisionFileVersion | null;
  readonly after: WorldDocumentRevisionFileVersion;
  /**
   * Which command in the batch last touched this file, so a caller that issued
   * the batch as separate tool calls can report each call's own outcome
   * instead of handing every call a copy of the whole batch.
   */
  readonly commandIndex: number | null;
}

export interface WorldDocumentRevisionSuccess {
  readonly kind: "revision";
  readonly ok: true;
  readonly sourceSnapshotId: string;
  readonly snapshot: WorldDocumentStore;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly files: readonly WorldDocumentFile[];
  readonly diagnostics: readonly WorldDocumentRevisionDiagnostic[];
  readonly changes: readonly WorldDocumentRevisionChange[];
}

export interface WorldDocumentRevisionFailure {
  readonly kind: "error";
  readonly ok: false;
  readonly sourceSnapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly diagnostics: readonly WorldDocumentRevisionDiagnostic[];
}

export type WorldDocumentRevisionResult =
  WorldDocumentRevisionSuccess | WorldDocumentRevisionFailure;

interface HeaderRanges {
  readonly documentId?: WorldDocumentSourceRange;
  readonly shortRef?: WorldDocumentSourceRange;
  readonly title?: WorldDocumentSourceRange;
  readonly summary?: WorldDocumentSourceRange;
  readonly aliases?: WorldDocumentSourceRange;
}

interface InternalReference {
  readonly targetId: string | null;
  readonly locator: WorldDocumentLocator;
  readonly range: WorldDocumentSourceRange;
  readonly valueRange: WorldDocumentSourceRange;
}

interface InternalDocumentEntry {
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

interface RevisionWorkingFile {
  file: {
    path: string;
    contents: string;
    encoding?: "base64";
  };
  readonly original: WorldDocumentFile | null;
  temporaryName?: string;
  lastCommandIndex: number | null;
}

const documentIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const shortRefPattern = /^[a-z][a-z0-9-]*$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maxWorldDocumentBytes = 4 * 1024 * 1024;
const maxYamlDepth = 64;
const maxYamlNodes = 100_000;
const maxLiteralSearchMatches = 10_000;
const maxSelectedNodeBytes = 1024 * 1024;

export class WorldDocumentStore {
  static open(input: {
    readonly layout: WorldDocumentLayout;
    readonly files: readonly WorldDocumentFile[];
  }): WorldDocumentStore {
    return new WorldDocumentStore(input.layout, input.files);
  }

  readonly id = `world-document-snapshot:${randomUUID()}`;
  readonly layout: WorldDocumentLayout;
  readonly logicalRoot: "world" | "state";
  readonly files: readonly WorldDocumentFile[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
  readonly status: WorldDocumentSnapshotStatus;

  readonly #entries: readonly InternalDocumentEntry[];
  readonly #cursorSecret = randomBytes(32);

  private constructor(
    layout: WorldDocumentLayout,
    files: readonly WorldDocumentFile[],
  ) {
    this.layout = layout;
    this.logicalRoot = layout === "content_package" ? "world" : "state";
    this.files = freeze(files.map((file) => freezeFile(file)));
    this.#entries = this.files
      .filter(({ path }) => path.startsWith(`${this.logicalRoot}/`))
      .map((file) => this.#inspectFile(file));

    this.#diagnoseDuplicateLogicalPaths();
    this.#diagnoseDuplicateHeaders();
    this.#diagnoseReferences();
    for (const entry of this.#entries) freeze(entry.diagnostics);
    this.diagnostics = freeze(
      this.#entries.flatMap(({ diagnostics }) => diagnostics),
    );
    this.status = this.diagnostics.length === 0 ? "usable" : "needs_repair";
    freeze(this.#entries);
    Object.freeze(this);
  }

  revise(request: WorldDocumentRevisionRequest): WorldDocumentRevisionResult {
    let activeCommandIndex: number | null = null;
    try {
      if (
        !isRecord(request) ||
        !hasOnlyKeys(request, ["commands"]) ||
        !Array.isArray(request.commands) ||
        request.commands.length === 0 ||
        request.commands.length > 64
      )
        return this.#revisionFailure(null, {
          code: "query_invalid",
          message:
            "revise requires a closed candidate batch of 1 to 64 commands",
        });

      const working: RevisionWorkingFile[] = this.files.map((file) => ({
        file: { ...file },
        original: file,
        lastCommandIndex: null,
      }));
      for (const [commandIndex, command] of request.commands.entries()) {
        activeCommandIndex = commandIndex;
        if (!isRecord(command) || typeof command.kind !== "string")
          return this.#revisionFailure(commandIndex, {
            code: "query_invalid",
            message: "A revise command must be a closed object with kind",
          });
        const current = WorldDocumentStore.open({
          layout: this.layout,
          files: working.map(({ file }) => file),
        });
        let touchedPath: string;
        if (command.kind === "create") {
          if (
            !hasOnlyKeys(command, [
              "kind",
              "temporaryName",
              "logicalPath",
              "codec",
              "refHint",
              "title",
              "summary",
              "aliases",
              "body",
            ]) ||
            typeof command.temporaryName !== "string" ||
            !/^[a-z][a-z0-9_-]{0,63}$/u.test(command.temporaryName) ||
            working.some(
              ({ temporaryName }) => temporaryName === command.temporaryName,
            ) ||
            typeof command.logicalPath !== "string" ||
            (command.codec !== "yaml" && command.codec !== "markdown") ||
            !validRevisionLogicalPath(
              command.logicalPath,
              command.codec,
              this.logicalRoot,
            ) ||
            typeof command.refHint !== "string" ||
            command.refHint.length < 2 ||
            command.refHint.length > 32 ||
            !shortRefPattern.test(command.refHint) ||
            !validDocumentMetadata(command) ||
            (command.codec === "yaml"
              ? (typeof command.body !== "string" && !isRecord(command.body)) ||
                (isRecord(command.body) &&
                  Object.hasOwn(command.body, "$document"))
              : typeof command.body !== "string")
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "Create-command arguments, temporary name, logical path, codec, or document metadata are invalid",
            });
          if (working.some(({ file }) => file.path === command.logicalPath))
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_duplicate",
              logicalPath: command.logicalPath,
              message: "Create target logical path already exists",
            });
          const createLogicalPath = command.logicalPath;
          const occupiedRefs = new Set(
            current.#entries.flatMap(({ descriptor }) =>
              descriptor === undefined ? [] : [descriptor.shortRef],
            ),
          );
          const shortRef = nextAvailableShortRef(command.refHint, occupiedRefs);
          const documentId = `doc.${randomUUID().replace(/-/gu, "")}`;
          const header = {
            $document: {
              id: documentId,
              ref: shortRef,
              title: command.title,
              summary: command.summary,
              aliases: [...command.aliases],
            },
          };
          let contents: string;
          if (command.codec === "yaml") {
            const revisionBody =
              typeof command.body === "string"
                ? parseRevisionYamlBodySource(command.logicalPath, command.body)
                : { value: command.body };
            if ("diagnostics" in revisionBody)
              return this.#revisionFailure(
                commandIndex,
                revisionBody.diagnostics,
              );
            const body = this.#resolveRevisionYamlValue(
              revisionBody.value,
              current,
              working,
              {
                referenceInput:
                  typeof command.body === "string"
                    ? "explicit_short_ref_only"
                    : "persistent_or_explicit",
              },
            );
            if ("diagnostics" in body)
              return this.#revisionFailure(
                commandIndex,
                body.diagnostics.map((problem) => ({
                  ...problem,
                  logicalPath: createLogicalPath,
                  documentId,
                })),
              );
            if (!isRecord(body.value) || Object.hasOwn(body.value, "$document"))
              return this.#revisionFailure(commandIndex, {
                code: "yaml_invalid",
                logicalPath: command.logicalPath,
                message:
                  "Create YAML body must be a safe map without $document",
              });
            contents = stringify(
              { ...header, ...body.value },
              { indent: 2, lineWidth: 0 },
            );
          } else
            contents = `---\n${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${(command.body as string).trimEnd()}\n`;
          working.push({
            file: { path: command.logicalPath, contents },
            original: null,
            temporaryName: command.temporaryName,
            lastCommandIndex: commandIndex,
          });
          touchedPath = command.logicalPath;
        } else if (command.kind === "move") {
          if (this.layout === "world_state")
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message: "World state revision does not support move",
            });
          if (
            !hasOnlyKeys(command, ["kind", "document", "toLogicalPath"]) ||
            typeof command.toLogicalPath !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message: "A move command requires a target and new logical path",
            });
          const target = this.#resolveRevisionTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          if (
            !validRevisionLogicalPath(
              command.toLogicalPath,
              target.entry.descriptor.codec,
              this.logicalRoot,
            )
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_invalid",
              logicalPath: command.toLogicalPath,
              documentId: target.entry.descriptor.documentId,
              message:
                "Move target must be a safe logical path under world/ with the original codec",
            });
          if (
            working.some(
              ({ file }) =>
                file !== target.working.file &&
                file.path === command.toLogicalPath,
            )
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_duplicate",
              logicalPath: command.toLogicalPath,
              documentId: target.entry.descriptor.documentId,
              message: "Move target logical path already exists",
            });
          target.working.file.path = command.toLogicalPath;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = command.toLogicalPath;
        } else if (command.kind === "replace") {
          if (
            !hasOnlyKeys(command, ["kind", "document", "contents"]) ||
            typeof command.contents !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A replace command requires a target and complete UTF-8 document source",
            });
          const target = this.#resolveRevisionReplaceTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          const previousDescriptor = target.entry.descriptor;
          target.working.file.contents = command.contents;
          delete target.working.file.encoding;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = target.working.file.path;
          const candidate = WorldDocumentStore.open({
            layout: this.layout,
            files: working.map(({ file }) => file),
          });
          const localProblems = this.#localRevisionDiagnostics(
            candidate,
            touchedPath,
          );
          if (localProblems.length > 0)
            return this.#revisionFailure(commandIndex, localProblems);
          const nextDescriptor = candidate.#entries.find(
            ({ file }) => file.path === touchedPath,
          )?.descriptor;
          if (nextDescriptor === undefined)
            return this.#revisionFailure(commandIndex, {
              code: "document_header_invalid",
              logicalPath: touchedPath,
              message:
                "Replace must produce a world document with a usable identity",
            });
          const identityProblems: WorldDocumentDiagnostic[] = [];
          if (
            previousDescriptor !== undefined &&
            previousDescriptor.documentId !== nextDescriptor.documentId
          )
            identityProblems.push({
              code: "document_identity_invalid",
              logicalPath: touchedPath,
              documentId: nextDescriptor.documentId,
              message: "Replacing a valid document cannot change its identity",
            });
          if (
            previousDescriptor !== undefined &&
            previousDescriptor.shortRef !== nextDescriptor.shortRef
          )
            identityProblems.push({
              code: "document_short_ref_invalid",
              logicalPath: touchedPath,
              documentId: nextDescriptor.documentId,
              message:
                "Replacing a valid document cannot change its short reference",
            });
          if (identityProblems.length > 0)
            return this.#revisionFailure(commandIndex, identityProblems);
        } else if (command.kind === "write") {
          if (
            !hasOnlyKeys(command, ["kind", "logicalPath", "contents"]) ||
            typeof command.logicalPath !== "string" ||
            typeof command.contents !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A write command requires a logical path and complete UTF-8 document source",
            });
          const writePath = command.logicalPath;
          const codec = documentCodec(writePath);
          if (
            codec === null ||
            !validRevisionLogicalPath(writePath, codec, this.logicalRoot)
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_invalid",
              logicalPath: writePath,
              message: `Write target must be a safe logical path under ${this.logicalRoot}/ ending in .yaml or .md`,
            });
          const existing = working.find(({ file }) => file.path === writePath);
          const previous = current.#entries.find(
            ({ file }) => file.path === writePath,
          )?.descriptor;
          const source = parseWriteDocumentSource(
            writePath,
            codec,
            command.contents,
            previous,
          );
          if ("diagnostics" in source)
            return this.#revisionFailure(commandIndex, source.diagnostics);
          // A damaged document has no usable identity to preserve, yet other
          // documents may still reference the identity it used to carry. Only
          // there is the authored id honoured; conflicts surface as diagnostics.
          const repairing = existing !== undefined && previous === undefined;
          const documentId =
            previous?.documentId ??
            (repairing ? source.authoredId : null) ??
            `doc.${randomUUID().replace(/-/gu, "")}`;
          const shortRef =
            previous?.shortRef ??
            (repairing
              ? source.refHint
              : nextAvailableShortRef(
                  source.refHint,
                  new Set(
                    current.#entries.flatMap(({ descriptor }) =>
                      descriptor === undefined ? [] : [descriptor.shortRef],
                    ),
                  ),
                ));
          const header = {
            $document: {
              id: documentId,
              ref: shortRef,
              title: source.metadata.title,
              summary: source.metadata.summary,
              aliases: [...source.metadata.aliases],
            },
          };
          let contents: string;
          if (codec === "yaml") {
            // Unlike create, write also overwrites existing documents, whose
            // own source already spells references as document ids. Rejecting
            // that form would break read-edit-write on any referencing file.
            const body = this.#resolveRevisionYamlValue(
              source.body,
              current,
              working,
              { referenceInput: "persistent_or_explicit" },
            );
            if ("diagnostics" in body)
              return this.#revisionFailure(
                commandIndex,
                body.diagnostics.map((problem) => ({
                  ...problem,
                  logicalPath: writePath,
                  documentId,
                })),
              );
            if (!isRecord(body.value))
              return this.#revisionFailure(commandIndex, {
                code: "yaml_invalid",
                logicalPath: writePath,
                documentId,
                message: "Write YAML body must be a safe map without $document",
              });
            contents = stringify(
              { ...header, ...body.value },
              { indent: 2, lineWidth: 0 },
            );
          } else
            contents = `---\n${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${(source.body as string).trimEnd()}\n`;
          if (existing === undefined)
            working.push({
              file: { path: writePath, contents },
              original: null,
              lastCommandIndex: commandIndex,
            });
          else {
            existing.file.contents = contents;
            delete existing.file.encoding;
            existing.lastCommandIndex = commandIndex;
          }
          touchedPath = writePath;
        } else if (command.kind === "patch") {
          if (
            !hasOnlyKeys(command, ["kind", "document", "edits"]) ||
            !Array.isArray(command.edits) ||
            command.edits.length < 1 ||
            command.edits.length > 32
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A patch command requires a target and 1 to 32 closed edits",
            });
          const target = this.#resolveRevisionTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          if (target.entry.codec === "markdown") {
            const patched = patchRevisionMarkdown(
              target.working.file.contents,
              command.edits,
              target.entry.descriptor,
            );
            if ("diagnostics" in patched)
              return this.#revisionFailure(
                commandIndex,
                patched.diagnostics.map((problem) => ({
                  ...problem,
                  logicalPath: target.entry.file.path,
                  documentId: target.entry.descriptor.documentId,
                })),
              );
            target.working.file.contents = patched.contents;
          } else {
            let document = parseDocument(target.working.file.contents, {
              schema: "core",
              uniqueKeys: true,
              strict: true,
            });
            let metadata: WorldDocumentMetadataInput = {
              title: target.entry.descriptor.title,
              summary: target.entry.descriptor.summary,
              aliases: [...target.entry.descriptor.aliases],
            };
            for (const edit of command.edits) {
              if (!isRecord(edit) || typeof edit.op !== "string")
                return this.#revisionFailure(commandIndex, {
                  code: "query_invalid",
                  logicalPath: target.entry.file.path,
                  documentId: target.entry.descriptor.documentId,
                  message: "A patch edit must be a closed object with op",
                });
              if (edit.op === "set_metadata") {
                if (!hasOnlyKeys(edit, ["op", "title", "summary", "aliases"]))
                  return this.#revisionFailure(commandIndex, {
                    code: "document_header_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    message:
                      "set_metadata accepts only op, title, summary, and aliases",
                  });
                const resolved = resolveDocumentMetadataRevision(
                  metadata,
                  edit,
                );
                if ("problems" in resolved)
                  return this.#revisionFailure(commandIndex, {
                    code: "document_header_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    message: `set_metadata arguments are invalid: ${resolved.problems.join("; ")}`,
                  });
                metadata = resolved.metadata;
                document.setIn(["$document", "title"], metadata.title);
                document.setIn(["$document", "summary"], metadata.summary);
                document.setIn(["$document", "aliases"], [...metadata.aliases]);
                continue;
              }
              if (
                !["add", "replace", "append", "remove"].includes(edit.op) ||
                !validYamlLocator(edit.locator) ||
                edit.locator.yaml[0] === "$document"
              )
                return this.#revisionFailure(commandIndex, {
                  code: "locator_invalid",
                  logicalPath: target.entry.file.path,
                  documentId: target.entry.descriptor?.documentId,
                  ...(isRecord(edit) && isRecord(edit.locator)
                    ? {
                        locator: copyLocator(
                          edit.locator as unknown as WorldDocumentLocator,
                        ),
                      }
                    : {}),
                  message:
                    "A YAML edit requires an exact locator outside the technical header",
                });
              const locator = [...edit.locator.yaml];
              if (locator.length === 0) {
                if (
                  (edit.op !== "add" && edit.op !== "replace") ||
                  !hasOnlyKeys(edit, ["op", "locator", "value"])
                )
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: [] },
                    message: "A whole YAML body supports only add or replace",
                  });
                const value = this.#resolveRevisionYamlValue(
                  edit.value,
                  current,
                  working,
                  { referenceInput: "persistent_or_explicit" },
                  [],
                );
                if ("diagnostics" in value)
                  return this.#revisionFailure(
                    commandIndex,
                    value.diagnostics.map((problem) => ({
                      ...problem,
                      logicalPath: target.entry.file.path,
                      documentId: target.entry.descriptor.documentId,
                    })),
                  );
                if (
                  !isRecord(value.value) ||
                  Object.hasOwn(value.value, "$document")
                )
                  return this.#revisionFailure(commandIndex, {
                    code: "yaml_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: [] },
                    message:
                      "A whole YAML body must be a map without $document",
                  });
                const currentValue: unknown = document.toJS({
                  maxAliasCount: 0,
                });
                if (
                  !isRecord(currentValue) ||
                  !isRecord(currentValue.$document)
                )
                  return this.#revisionFailure(commandIndex, {
                    code: "document_header_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    message: "YAML technical header could not be preserved",
                  });
                if (
                  edit.op === "add" &&
                  Object.keys(currentValue).some((key) => key !== "$document")
                )
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: [] },
                    message:
                      "Adding a whole YAML body requires the current body to be empty",
                  });
                document = parseDocument(
                  stringify(
                    { $document: currentValue.$document, ...value.value },
                    { indent: 2, lineWidth: 0 },
                  ),
                  { schema: "core", uniqueKeys: true, strict: true },
                );
                continue;
              }
              const exists = document.hasIn(locator);
              if (edit.op === "remove") {
                if (!hasOnlyKeys(edit, ["op", "locator"]) || !exists)
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_not_found",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: locator },
                    message: "YAML remove target must exist",
                  });
                document.deleteIn(locator);
                continue;
              }
              if (!hasOnlyKeys(edit, ["op", "locator", "value"]))
                return this.#revisionFailure(commandIndex, {
                  code: "query_invalid",
                  logicalPath: target.entry.file.path,
                  documentId: target.entry.descriptor.documentId,
                  locator: { yaml: locator },
                  message: "YAML value-edit arguments are invalid",
                });
              let valueLocator = locator;
              if (edit.op === "append") {
                const sequence = document.getIn(locator, true);
                if (!isSeq(sequence))
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: locator },
                    message: "YAML append target must be a sequence",
                  });
                valueLocator = [...locator, sequence.items.length];
              }
              const value = this.#resolveRevisionYamlValue(
                edit.value,
                current,
                working,
                { referenceInput: "persistent_or_explicit" },
                valueLocator,
              );
              if ("diagnostics" in value)
                return this.#revisionFailure(
                  commandIndex,
                  value.diagnostics.map((problem) => ({
                    ...problem,
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor?.documentId,
                  })),
                );
              if (edit.op === "add") {
                const parent =
                  locator.length === 1
                    ? document.contents
                    : document.getIn(locator.slice(0, -1), true);
                const last = locator.at(-1);
                const parentAcceptsLocator =
                  (isMap(parent) && typeof last === "string") ||
                  (isSeq(parent) && typeof last === "number");
                if (exists || !parentAcceptsLocator)
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_invalid",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: locator },
                    message:
                      "YAML add target must not exist, and its parent map or sequence must exist",
                  });
                document.setIn(locator, value.value);
              } else if (edit.op === "replace") {
                if (!exists)
                  return this.#revisionFailure(commandIndex, {
                    code: "locator_not_found",
                    logicalPath: target.entry.file.path,
                    documentId: target.entry.descriptor.documentId,
                    locator: { yaml: locator },
                    message: "YAML replace target must exist",
                  });
                document.setIn(locator, value.value);
              } else document.addIn(locator, value.value);
            }
            target.working.file.contents = document.toString({
              indent: 2,
              lineWidth: 0,
            });
          }
          delete target.working.file.encoding;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = target.working.file.path;
        } else
          return this.#revisionFailure(commandIndex, {
            code: "query_invalid",
            message:
              "World-document candidate batch does not support this command kind",
          });

        const candidate = WorldDocumentStore.open({
          layout: this.layout,
          files: working.map(({ file }) => file),
        });
        const localProblems = this.#localRevisionDiagnostics(
          candidate,
          touchedPath,
        );
        if (localProblems.length > 0)
          return this.#revisionFailure(commandIndex, localProblems);
      }

      const snapshot = WorldDocumentStore.open({
        layout: this.layout,
        files: working.map(({ file }) => file),
      });
      if (snapshot.status !== "usable")
        return freeze({
          kind: "error" as const,
          ok: false as const,
          sourceSnapshotId: this.id,
          snapshotStatus: this.status,
          diagnostics: freeze(
            snapshot.diagnostics.map((problem) => {
              const commandIndex = working.find(
                ({ file }) => file.path === problem.logicalPath,
              )?.lastCommandIndex;
              return revisionDiagnostic(commandIndex ?? null, problem);
            }),
          ),
        });
      const changes = working
        .filter(
          ({ file, original }) =>
            file.path !== original?.path ||
            file.contents !== original?.contents ||
            file.encoding !== original?.encoding,
        )
        .map(({ file, original, lastCommandIndex }) => {
          const descriptor = snapshot.#entries.find(
            ({ file: candidate }) => candidate.path === file.path,
          )?.descriptor;
          if (descriptor === undefined)
            throw new Error(
              "Usable candidate is missing its final world-document identity",
            );
          return freeze({
            documentId: descriptor.documentId,
            shortRef: descriptor.shortRef,
            codec: descriptor.codec,
            commandIndex: lastCommandIndex,
            before:
              original === null
                ? null
                : freeze({
                    logicalPath: original.path,
                    contents: original.contents,
                    mechanicalHash: mechanicalHash(original.contents),
                  }),
            after: freeze({
              logicalPath: file.path,
              contents: file.contents,
              mechanicalHash: mechanicalHash(file.contents),
            }),
          });
        })
        .sort((left, right) =>
          left.after.logicalPath.localeCompare(right.after.logicalPath),
        );
      return freeze({
        kind: "revision" as const,
        ok: true as const,
        sourceSnapshotId: this.id,
        snapshot,
        snapshotStatus: snapshot.status,
        files: snapshot.files,
        diagnostics: freeze([]),
        changes: freeze(changes),
      });
    } catch {
      return this.#revisionFailure(activeCommandIndex, {
        code: "query_invalid",
        message: "Revise command cannot be interpreted as safe closed input",
      });
    }
  }

  #revisionFailure(
    commandIndex: number | null,
    problem: WorldDocumentDiagnostic | readonly WorldDocumentDiagnostic[],
  ): WorldDocumentRevisionFailure {
    const diagnostics: readonly WorldDocumentDiagnostic[] = Array.isArray(
      problem,
    )
      ? (problem as readonly WorldDocumentDiagnostic[])
      : [problem as WorldDocumentDiagnostic];
    return freeze({
      kind: "error" as const,
      ok: false as const,
      sourceSnapshotId: this.id,
      snapshotStatus: this.status,
      diagnostics: freeze(
        diagnostics.map((candidate) =>
          revisionDiagnostic(commandIndex, candidate),
        ),
      ),
    });
  }

  #resolveRevisionTarget(
    snapshot: WorldDocumentStore,
    working: readonly RevisionWorkingFile[],
    target: unknown,
  ):
    | {
        readonly entry: InternalDocumentEntry & {
          descriptor: WorldDocumentDescriptor;
        };
        readonly working: RevisionWorkingFile;
      }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    let resolved:
      | { readonly entry: InternalDocumentEntry }
      | { readonly diagnostics: readonly WorldDocumentDiagnostic[] };
    if (
      isRecord(target) &&
      Object.keys(target).length === 1 &&
      typeof target.temporaryName === "string"
    ) {
      const temporary = working.filter(
        ({ temporaryName }) => temporaryName === target.temporaryName,
      );
      if (temporary.length !== 1)
        return {
          diagnostics: freeze([
            diagnostic({
              code:
                temporary.length === 0
                  ? "document_not_found"
                  : "document_ambiguous",
              message:
                "Candidate-batch temporary name does not uniquely identify a document created in the batch",
            }),
          ]),
        };
      resolved = snapshot.#resolveSelector({
        logicalPath: temporary[0]!.file.path,
      });
    } else resolved = snapshot.#resolveSelector(target);
    if ("diagnostics" in resolved) return resolved;
    if (resolved.entry.descriptor === undefined)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_header_invalid",
            logicalPath: resolved.entry.file.path,
            message: "Candidate-batch target has no usable document identity",
          }),
        ]),
      };
    const matches = working.filter(
      ({ file }) => file.path === resolved.entry.file.path,
    );
    if (matches.length !== 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_ambiguous",
            logicalPath: resolved.entry.file.path,
            documentId: resolved.entry.descriptor.documentId,
            message: "Target is not unique in the complete candidate file set",
          }),
        ]),
      };
    return {
      entry: resolved.entry as InternalDocumentEntry & {
        descriptor: WorldDocumentDescriptor;
      },
      working: matches[0]!,
    };
  }

  #resolveRevisionReplaceTarget(
    snapshot: WorldDocumentStore,
    working: readonly RevisionWorkingFile[],
    target: unknown,
  ):
    | {
        readonly entry: InternalDocumentEntry;
        readonly working: RevisionWorkingFile;
      }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    if (
      !isRecord(target) ||
      Object.keys(target).length !== 1 ||
      typeof target.logicalPath !== "string"
    )
      return this.#resolveRevisionTarget(snapshot, working, target);
    const entries = snapshot.#entries.filter(
      ({ file }) => file.path === target.logicalPath,
    );
    const files = working.filter(
      ({ file }) => file.path === target.logicalPath,
    );
    if (entries.length !== 1 || files.length !== 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code:
              entries.length === 0 || files.length === 0
                ? "document_not_found"
                : "document_ambiguous",
            logicalPath: target.logicalPath,
            message:
              "Replace logical path does not uniquely identify a candidate world document",
          }),
        ]),
      };
    return { entry: entries[0]!, working: files[0]! };
  }

  #resolveRevisionYamlValue(
    value: unknown,
    snapshot: WorldDocumentStore,
    working: readonly RevisionWorkingFile[],
    options: {
      readonly referenceInput:
        "persistent_or_explicit" | "explicit_short_ref_only";
    } = { referenceInput: "persistent_or_explicit" },
    locator: readonly (string | number)[] = [],
    seen = new WeakSet<object>(),
  ):
    | { readonly value: unknown }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return { value };
    if (typeof value !== "object" || value === null || seen.has(value))
      return {
        diagnostics: freeze([
          diagnostic({
            code: "yaml_invalid",
            locator: { yaml: [...locator] },
            message:
              "Candidate YAML value must be an acyclic JSON-shaped safe value",
          }),
        ]),
      };
    seen.add(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const resolved = this.#resolveRevisionYamlValue(
          item,
          snapshot,
          working,
          options,
          [...locator, index],
          seen,
        );
        if ("diagnostics" in resolved) return resolved;
        result.push(resolved.value);
      }
      seen.delete(value);
      return { value: result };
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !isRecord(value) ||
      (prototype !== Object.prototype && prototype !== null)
    )
      return {
        diagnostics: freeze([
          diagnostic({
            code: "yaml_invalid",
            locator: { yaml: [...locator] },
            message: "Candidate YAML map must be a plain object",
          }),
        ]),
      };
    if (Object.hasOwn(value, "$ref")) {
      if (
        Object.keys(value).length !== 1 ||
        (options.referenceInput === "explicit_short_ref_only" &&
          (typeof value.$ref !== "string" || !value.$ref.startsWith("@")))
      )
        return {
          diagnostics: freeze([
            diagnostic({
              code: "document_reference_invalid",
              locator: { yaml: [...locator] },
              message:
                options.referenceInput === "explicit_short_ref_only"
                  ? "$ref must use an @short-ref returned by Runtime, and the reference object cannot contain other fields"
                  : "A $ref object cannot contain other fields",
            }),
          ]),
        };
      if (typeof value.$ref === "string") {
        if (!value.$ref.startsWith("@")) {
          if (!documentIdPattern.test(value.$ref))
            return {
              diagnostics: freeze([
                diagnostic({
                  code: "document_reference_invalid",
                  locator: { yaml: [...locator] },
                  message:
                    "$ref must be a document identity or explicit document selector",
                }),
              ]),
            };
          seen.delete(value);
          return { value: { $ref: value.$ref } };
        }
        const target = this.#resolveRevisionTarget(snapshot, working, {
          shortRef: value.$ref.slice(1),
        });
        if ("diagnostics" in target)
          return {
            diagnostics: freeze(
              target.diagnostics.map((problem) =>
                diagnostic({
                  ...problem,
                  locator: { yaml: [...locator] },
                }),
              ),
            ),
          };
        seen.delete(value);
        return { value: { $ref: target.entry.descriptor.documentId } };
      }
      const target = this.#resolveRevisionTarget(snapshot, working, value.$ref);
      if ("diagnostics" in target)
        return {
          diagnostics: freeze(
            target.diagnostics.map((problem) =>
              diagnostic({
                ...problem,
                locator: { yaml: [...locator] },
              }),
            ),
          ),
        };
      seen.delete(value);
      return { value: { $ref: target.entry.descriptor.documentId } };
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const resolved = this.#resolveRevisionYamlValue(
        item,
        snapshot,
        working,
        options,
        [...locator, key],
        seen,
      );
      if ("diagnostics" in resolved) return resolved;
      result[key] = resolved.value;
    }
    seen.delete(value);
    return { value: result };
  }

  #localRevisionDiagnostics(
    snapshot: WorldDocumentStore,
    logicalPath: string,
  ): readonly WorldDocumentDiagnostic[] {
    const entries = snapshot.#entries.filter(
      ({ file }) => file.path === logicalPath,
    );
    if (entries.length !== 1)
      return freeze([
        diagnostic({
          code:
            entries.length === 0
              ? "document_not_found"
              : "logical_path_duplicate",
          logicalPath,
          message: "Command must produce one unique target world document",
        }),
      ]);
    const entry = entries[0]!;
    const malformedReference = entry.references.some(
      ({ targetId }) => targetId === null,
    );
    return freeze(
      entry.diagnostics.filter(
        ({ code }) =>
          code !== "document_identity_duplicate" &&
          code !== "document_short_ref_duplicate" &&
          (code !== "document_reference_invalid" || malformedReference),
      ),
    );
  }

  query(request: WorldDocumentQuery): WorldDocumentQueryResult {
    if (!isRecord(request) || typeof request.kind !== "string")
      return this.#failure(null, null, [
        diagnostic({
          code: "query_invalid",
          message:
            "WorldDocumentStore.query accepts only closed query requests",
        }),
      ]);
    if (request.kind === "catalog") return this.#catalog(request);
    if (request.kind === "literal_search") return this.#literalSearch(request);
    if (request.kind === "read_document") return this.#readDocument(request);
    if (request.kind === "select_node") return this.#selectNode(request);
    return this.#failure(null, null, [
      diagnostic({
        code: "query_invalid",
        message: "WorldDocumentStore.query accepts only closed query requests",
      }),
    ]);
  }

  #catalog(
    request: WorldDocumentCatalogQuery,
  ): WorldDocumentCatalogResult | WorldDocumentQueryFailure {
    if (!hasOnlyKeys(request, ["kind", "directory", "limit", "cursor"]))
      return this.#failure("catalog", request, [
        diagnostic({
          code: "query_invalid",
          message: "Catalog contains undeclared query conditions",
        }),
      ]);
    const directory = request.directory ?? "";
    const limit = request.limit ?? 20;
    if (
      (directory !== "" && !validRelativePath(directory)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return this.#failure("catalog", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "Catalog directory must be within the layout root, and limit must be 1 to 100",
        }),
      ]);
    const relativePrefix = directory === "" ? "" : `${directory}/`;
    const prefix = `${this.logicalRoot}/${relativePrefix}`;
    const entries = new Map<string, WorldDocumentCatalogEntry>();
    for (const entry of this.#entries) {
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
    const ordered = [...entries.values()].sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath),
    );
    const cursorScope = JSON.stringify({
      kind: "catalog",
      layout: this.layout,
      logicalRoot: this.logicalRoot,
      directory,
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
        excludedDocuments: 0,
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
      return this.#failure("literal_search", request, [
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
      return this.#failure("literal_search", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "literal_search requires a 1-to-256-character literal and a limit from 1 to 100",
        }),
      ]);
    let candidates: readonly InternalDocumentEntry[] = this.#entries;
    let within:
      | null
      | { readonly directory: string }
      | { readonly document: WorldDocumentDescriptor } = null;
    if (request.within !== undefined) {
      if (!isRecord(request.within))
        return this.#failure("literal_search", request, [
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
          return this.#failure("literal_search", request, [
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
        const resolved = this.#resolveSelector(request.within.document);
        if ("diagnostics" in resolved)
          return this.#failure(
            "literal_search",
            request,
            resolved.diagnostics,
            resolved.document,
          );
        candidates = [resolved.entry];
        within = freeze({ document: resolved.entry.descriptor! });
      } else
        return this.#failure("literal_search", request, [
          diagnostic({
            code: "query_invalid",
            message:
              "literal_search within must declare only directory or document",
          }),
        ]);
    }

    const query = normalizeSearchQuery(request.query, caseSensitive);
    if (query.length === 0)
      return this.#failure("literal_search", request, [
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
    const descriptors = this.#descriptorIndex();
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
            return this.#failure("literal_search", request, [
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

  #readDocument(
    request: WorldDocumentReadQuery,
  ): WorldDocumentReadResult | WorldDocumentQueryFailure {
    if (
      !hasOnlyKeys(request, [
        "kind",
        "document",
        "maxBytes",
        "cursor",
        "referenceProjection",
      ])
    )
      return this.#failure("read_document", request, [
        diagnostic({
          code: "query_invalid",
          message: "read_document contains undeclared query conditions",
        }),
      ]);
    const maxBytes = request.maxBytes ?? 8192;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > 65_536 ||
      (request.referenceProjection !== undefined &&
        request.referenceProjection !== "short_ref")
    )
      return this.#failure("read_document", request, [
        diagnostic({
          code: "query_invalid",
          message:
            "read_document maxBytes must be 4 to 65536 and referenceProjection, when present, must be short_ref",
        }),
      ]);
    const resolved = this.#resolveSelector(request.document);
    if ("diagnostics" in resolved)
      return this.#failure(
        "read_document",
        request,
        resolved.diagnostics,
        resolved.document,
      );
    const bodyRange = resolved.entry.bodyRange;
    if (bodyRange === undefined)
      return this.#failure(
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
            this.#descriptorIndex(),
            true,
          )
        : resolved.entry.file.contents.slice(
            bodyRange.start.offset,
            bodyRange.end.offset,
          );
    const bytes = Buffer.from(completeBody, "utf8");
    const cursorScope = JSON.stringify({
      kind: "read_document",
      layout: this.layout,
      logicalRoot: this.logicalRoot,
      document: request.document,
      maxBytes,
      referenceProjection: request.referenceProjection ?? null,
    });
    const offset = this.#cursorOffset(request.cursor, cursorScope);
    if (offset === null || offset > bytes.length)
      return this.#cursorFailure("read_document", request);
    const end = safeUtf8PageEnd(bytes, offset, maxBytes);
    const body = bytes.subarray(offset, end).toString("utf8");
    const complete = end === bytes.length;
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
      body,
      page: freeze({
        unit: "utf8_bytes" as const,
        start: offset,
        end,
        total: bytes.length,
        complete,
        nextCursor: complete ? null : this.#cursor(cursorScope, end),
      }),
      diagnostics: freeze([]),
    });
  }

  #selectNode(
    request: WorldDocumentSelectNodeQuery,
  ): WorldDocumentSelectNodeResult | WorldDocumentQueryFailure {
    if (!hasOnlyKeys(request, ["kind", "document", "locator"]))
      return this.#failure("select_node", request, [
        diagnostic({
          code: "query_invalid",
          message: "select_node contains undeclared query conditions",
        }),
      ]);
    if (!isRecord(request.locator))
      return this.#failure("select_node", request, [
        diagnostic({
          code: "query_invalid",
          message: "select_node must declare one closed locator",
        }),
      ]);
    const resolved = this.#resolveSelector(request.document);
    if ("diagnostics" in resolved)
      return this.#failure(
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
      const damagedSelection = entry.diagnostics.filter(
        (problem) =>
          problem.code === "document_reference_invalid" &&
          problem.locator !== undefined &&
          "yaml" in problem.locator &&
          yamlLocatorsOverlap(locator.yaml, problem.locator.yaml),
      );
      if (damagedSelection.length > 0)
        return this.#failure(
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
      const projected = projectYamlValue(value, this.#descriptorIndex());
      const isWholeDocumentProjection = locator.yaml.length === 0;
      if (
        !isWholeDocumentProjection &&
        Buffer.byteLength(JSON.stringify(projected), "utf8") >
          maxSelectedNodeBytes
      )
        return this.#failure(
          "select_node",
          request,
          [
            diagnostic({
              code: "capacity_exceeded",
              logicalPath: entry.file.path,
              documentId: entry.descriptor!.documentId,
              locator: publicLocator,
              range: node.range,
              message:
                "Exact-node projection exceeds the capacity of one query",
            }),
          ],
          entry.descriptor,
        );
      return this.#selected(
        entry,
        publicLocator,
        {
          codec: "yaml",
          locator: publicLocator,
          value: projected,
          range: node.range,
        },
        this.#selectedReferences(entry, publicLocator),
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
      if (Buffer.byteLength(markdown, "utf8") > maxSelectedNodeBytes)
        return this.#failure(
          "select_node",
          request,
          [
            diagnostic({
              code: "capacity_exceeded",
              logicalPath: entry.file.path,
              documentId: entry.descriptor!.documentId,
              locator: publicLocator,
              range: heading.range,
              message:
                "Exact-node projection exceeds the capacity of one query",
            }),
          ],
          entry.descriptor,
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

  #selectedReferences(
    entry: InternalDocumentEntry,
    locator: { readonly yaml: readonly (string | number)[] },
  ): WorldDocumentSelectNodeResult["references"] {
    const descriptors = this.#descriptorIndex();
    return entry.references.flatMap((reference) => {
      if (
        reference.targetId === null ||
        !("yaml" in reference.locator) ||
        !locatorStartsWith(reference.locator.yaml, locator.yaml)
      )
        return [];
      const target = descriptors.get(reference.targetId);
      return target === undefined
        ? []
        : [
            freeze({
              locator: copyLocator(reference.locator),
              target,
            }),
          ];
    });
  }

  #locatorFailure(
    entry: InternalDocumentEntry,
    locator: WorldDocumentLocator,
    code: "locator_ambiguous" | "locator_invalid" | "locator_not_found",
  ): WorldDocumentQueryFailure {
    return this.#failure(
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

  #resolveSelector(selector: unknown):
    | { readonly entry: InternalDocumentEntry }
    | {
        readonly diagnostics: readonly WorldDocumentDiagnostic[];
        readonly document?: WorldDocumentDescriptor;
      } {
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
      matches = this.#entries.filter(
        ({ descriptor }) => descriptor?.documentId === selector.documentId,
      );
    else if (
      typeof selector.shortRef === "string" &&
      selector.shortRef.length > 0
    )
      matches = this.#entries.filter(
        ({ descriptor }) => descriptor?.shortRef === selector.shortRef,
      );
    else if (
      typeof selector.logicalPath === "string" &&
      selector.logicalPath.length > 0
    )
      matches = this.#entries.filter(
        ({ file }) => file.path === selector.logicalPath,
      );
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

  #descriptorIndex(): ReadonlyMap<string, WorldDocumentDescriptor> {
    const descriptors = this.#entries.flatMap(({ descriptor }) =>
      descriptor === undefined ? [] : [descriptor],
    );
    return new Map(
      [...groupBy(descriptors, ({ documentId }) => documentId).entries()]
        .filter(([, matches]) => matches.length === 1)
        .map(([documentId, matches]) => [documentId, matches[0]!] as const),
    );
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
    return this.#failure(requestKind, scope, [
      diagnostic({
        code: "cursor_invalid",
        message:
          "Cursor does not match the current snapshot or all query conditions",
      }),
    ]);
  }

  #failure(
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

  #inspectFile(file: WorldDocumentFile): InternalDocumentEntry {
    const entry: InternalDocumentEntry = {
      file,
      relativePath: file.path.slice(this.logicalRoot.length + 1),
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
    if (Buffer.byteLength(file.contents, "utf8") > maxWorldDocumentBytes) {
      entry.diagnostics.push(
        diagnostic({
          code: "capacity_exceeded",
          logicalPath: file.path,
          range: sourceRange(file.contents, 0, file.contents.length),
          message: "One world document cannot exceed 4 MiB",
        }),
      );
      return entry;
    }
    if (entry.codec === "yaml") inspectYamlDocument(entry);
    else inspectMarkdownDocument(entry);
    return entry;
  }

  #diagnoseDuplicateLogicalPaths(): void {
    const groups = groupBy(this.#entries, ({ file }) => file.path);
    for (const entries of groups.values()) {
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

  #diagnoseDuplicateHeaders(): void {
    const withDescriptors = this.#entries.filter(
      (
        entry,
      ): entry is InternalDocumentEntry & {
        descriptor: WorldDocumentDescriptor;
      } => entry.descriptor !== undefined,
    );
    for (const entries of groupBy(
      withDescriptors,
      ({ descriptor }) => descriptor.documentId,
    ).values()) {
      if (entries.length < 2) continue;
      for (const entry of entries)
        entry.diagnostics.push(
          diagnostic({
            code: "document_identity_duplicate",
            logicalPath: entry.file.path,
            documentId: entry.descriptor.documentId,
            ...(entry.headerRanges?.documentId === undefined
              ? {}
              : { range: entry.headerRanges.documentId }),
            message: "Document identity must be unique within the snapshot",
          }),
        );
    }
    for (const entries of groupBy(
      withDescriptors,
      ({ descriptor }) => descriptor.shortRef,
    ).values()) {
      if (entries.length < 2) continue;
      for (const entry of entries)
        entry.diagnostics.push(
          diagnostic({
            code: "document_short_ref_duplicate",
            logicalPath: entry.file.path,
            documentId: entry.descriptor.documentId,
            ...(entry.headerRanges?.shortRef === undefined
              ? {}
              : { range: entry.headerRanges.shortRef }),
            message:
              "Document short reference must be unique within the snapshot",
          }),
        );
    }
  }

  #diagnoseReferences(): void {
    const byId = groupBy(
      this.#entries.filter(
        (
          entry,
        ): entry is InternalDocumentEntry & {
          descriptor: WorldDocumentDescriptor;
        } => entry.descriptor !== undefined,
      ),
      ({ descriptor }) => descriptor.documentId,
    );
    for (const entry of this.#entries) {
      for (const reference of entry.references) {
        if (
          reference.targetId !== null &&
          byId.get(reference.targetId)?.length === 1
        )
          continue;
        entry.diagnostics.push(
          diagnostic({
            code: "document_reference_invalid",
            logicalPath: entry.file.path,
            ...(entry.descriptor === undefined
              ? {}
              : { documentId: entry.descriptor.documentId }),
            locator: reference.locator,
            range: reference.range,
            message:
              "An explicit $ref must uniquely identify a whole document in the snapshot",
          }),
        );
      }
    }
  }
}

function inspectYamlDocument(entry: InternalDocumentEntry): void {
  const parsed = parseRestrictedYaml(entry, entry.file.contents, 0);
  if (parsed === null) return;
  const header = readHeader(entry, parsed, false);
  if (header === null) return;
  entry.descriptor = header.descriptor;
  entry.headerRanges = header.ranges;
  entry.bodyRange = yamlBodyRange(entry.file.contents, parsed.root);
  entry.searchRanges = freeze([
    ...headerSearchRanges(header.ranges),
    entry.bodyRange,
  ]);
  inspectYamlReferences(entry, parsed.root, []);
  entry.yaml = {
    body: freeze(
      Object.fromEntries(
        Object.entries(parsed.value).filter(([key]) => key !== "$document"),
      ),
    ),
    nodes: freeze(indexYamlNodes(entry.file.contents, parsed.root)),
  };
}

function inspectMarkdownDocument(entry: InternalDocumentEntry): void {
  const source = entry.file.contents;
  if (!source.startsWith("---\n")) {
    entry.diagnostics.push(
      diagnostic({
        code: "markdown_invalid",
        logicalPath: entry.file.path,
        range: sourceRange(source, 0, Math.min(source.length, 3)),
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
        range: sourceRange(source, 0, Math.min(source.length, 3)),
        message: "Markdown front matter is not closed",
      }),
    );
    return;
  }
  const parsed = parseRestrictedYaml(entry, source.slice(4, end), 4);
  if (parsed === null) return;
  const header = readHeader(entry, parsed, true);
  if (header === null) return;
  entry.descriptor = header.descriptor;
  entry.headerRanges = header.ranges;

  const bodyStart = end + 5;
  entry.bodyRange = sourceRange(source, bodyStart, source.length);
  entry.searchRanges = freeze([
    ...headerSearchRanges(header.ranges),
    entry.bodyRange,
  ]);
  const headings = scanMarkdownHeadings(source, bodyStart).headings;
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
        range:
          headings[0]?.range ?? sourceRange(source, bodyStart, source.length),
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
      range: sourceRange(source, heading.range.start.offset, end),
    });
  }
  entry.markdown = { bodyStart, headings: freeze(indexed) };
}

function parseRevisionYamlBodySource(
  logicalPath: string,
  source: string,
):
  | { readonly value: Record<string, unknown> }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  const entry: InternalDocumentEntry = {
    file: { path: logicalPath, contents: source },
    relativePath: logicalPath,
    codec: "yaml",
    references: [],
    diagnostics: [],
  };
  const parsed = parseRestrictedYaml(entry, source, 0);
  if (parsed === null || entry.diagnostics.length > 0)
    return { diagnostics: freeze([...entry.diagnostics]) };
  if (Object.hasOwn(parsed.value, "$document"))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "yaml_invalid",
          logicalPath,
          message:
            "Create YAML body cannot include a $document technical header",
        }),
      ]),
    };
  return { value: parsed.value };
}

// Splits one complete document source into the metadata the author owns and
// the body it wrote. `id` is deliberately not read back: the store assigns it.
// A source with no `$document` at all is what read_document hands back, so
// overwriting an existing document may omit it and inherit that document's
// metadata; only a new document has nothing to inherit and must supply one.
function parseWriteDocumentSource(
  logicalPath: string,
  codec: WorldDocumentCodec,
  source: string,
  existing: WorldDocumentDescriptor | undefined,
):
  | {
      readonly metadata: WorldDocumentMetadataInput;
      readonly refHint: string;
      readonly authoredId: string | null;
      readonly body: Record<string, unknown> | string;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  let header: unknown;
  let body: Record<string, unknown> | string;
  if (codec === "yaml") {
    const entry: InternalDocumentEntry = {
      file: { path: logicalPath, contents: source },
      relativePath: logicalPath,
      codec: "yaml",
      references: [],
      diagnostics: [],
    };
    const parsed = parseRestrictedYaml(entry, source, 0);
    if (parsed === null || entry.diagnostics.length > 0)
      return { diagnostics: freeze([...entry.diagnostics]) };
    const { $document, ...rest } = parsed.value;
    header = $document;
    body = rest;
  } else if (source.startsWith("---\n")) {
    const envelope = markdownEnvelope(source);
    if ("diagnostics" in envelope)
      return {
        diagnostics: freeze(
          envelope.diagnostics.map((problem) => ({ ...problem, logicalPath })),
        ),
      };
    const parsedHeader = envelope.header.toJSON() as unknown;
    header = isRecord(parsedHeader) ? parsedHeader.$document : undefined;
    body = source.slice(envelope.bodyStart);
  } else {
    header = undefined;
    body = source;
  }
  if (header === undefined && existing !== undefined)
    return {
      metadata: {
        title: existing.title,
        summary: existing.summary,
        aliases: [...existing.aliases],
      },
      refHint: existing.shortRef,
      authoredId: existing.documentId,
      body,
    };
  if (!isRecord(header))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_header_invalid",
          logicalPath,
          message:
            "Write source for a new document must begin with a $document technical header; replacing an existing document may omit it to preserve title, summary, and aliases",
        }),
      ]),
    };
  const normalized = { ...header, aliases: normalizeAliases(header.aliases) };
  if (!validDocumentMetadata(normalized))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_header_invalid",
          logicalPath,
          message: `$document technical header is invalid: ${documentMetadataProblems(normalized).join("; ")}`,
        }),
      ]),
    };
  const { ref } = header;
  if (
    typeof ref !== "string" ||
    ref.length < 2 ||
    ref.length > 32 ||
    !shortRefPattern.test(ref)
  )
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_short_ref_invalid",
          logicalPath,
          message: `$document.ref must be a 2-to-32-character short reference containing only lowercase letters, digits, and hyphens; received ${describeValue(ref)}`,
        }),
      ]),
    };
  const { id } = header;
  return {
    metadata: {
      title: normalized.title,
      summary: normalized.summary,
      aliases: normalized.aliases,
    },
    refHint: ref,
    authoredId: typeof id === "string" && id.length > 0 ? id : null,
    body,
  };
}

function parseRestrictedYaml(
  entry: InternalDocumentEntry,
  source: string,
  baseOffset: number,
): ParsedRestrictedYaml | null {
  const forbidden = forbiddenYamlRange(source);
  if (forbidden !== null) {
    entry.diagnostics.push(
      diagnostic({
        code: "yaml_invalid",
        logicalPath: entry.file.path,
        range: sourceRange(
          entry.file.contents,
          baseOffset + forbidden.start,
          baseOffset + forbidden.end,
        ),
        message:
          "YAML uses a forbidden tag, anchor, alias, merge, multiple documents, or invalid line break",
      }),
    );
    return null;
  }
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    for (const problem of [...document.errors, ...document.warnings])
      entry.diagnostics.push(
        diagnostic({
          code: "yaml_invalid",
          logicalPath: entry.file.path,
          range: sourceRange(
            entry.file.contents,
            baseOffset + problem.pos[0],
            baseOffset + problem.pos[1],
          ),
          message: "YAML is not a safe single-document YAML 1.2 core map",
        }),
      );
    return null;
  }
  if (!isMap(document.contents)) {
    entry.diagnostics.push(
      diagnostic({
        code: "yaml_invalid",
        logicalPath: entry.file.path,
        range: sourceRange(
          entry.file.contents,
          baseOffset,
          baseOffset + source.length,
        ),
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
        range: nodeRange(entry.file.contents, document.contents, baseOffset),
        message: "YAML depth or node count exceeds world-document capacity",
      }),
    );
  if (shape.invalidNumber)
    entry.diagnostics.push(
      diagnostic({
        code: "yaml_invalid",
        logicalPath: entry.file.path,
        range: nodeRange(entry.file.contents, document.contents, baseOffset),
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
        range: nodeRange(entry.file.contents, parsed.root, parsed.baseOffset),
        message: "$document must be the first document entry",
      }),
    );
    return null;
  }
  const header = first.value;
  const pairs = stringPairMap(header);
  const allowed = new Set(["id", "ref", "title", "summary", "aliases"]);
  const exactShape =
    pairs.size === allowed.size &&
    [...pairs.keys()].every((key) => allowed.has(key)) &&
    (!headerOnly || parsed.root.items.length === 1);
  const idPair = pairs.get("id");
  const refPair = pairs.get("ref");
  const titlePair = pairs.get("title");
  const summaryPair = pairs.get("summary");
  const aliasesPair = pairs.get("aliases");
  const id = scalarString(idPair?.value);
  const shortRef = scalarString(refPair?.value);
  const title = scalarString(titlePair?.value);
  const summary = scalarString(summaryPair?.value);
  const aliases = stringSequence(aliasesPair?.value);
  let valid = exactShape;

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
              range: nodeRange(
                entry.file.contents,
                idPair.value,
                parsed.baseOffset,
              ),
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
              range: nodeRange(
                entry.file.contents,
                refPair.value,
                parsed.baseOffset,
              ),
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
        range: nodeRange(entry.file.contents, header, parsed.baseOffset),
        message:
          "$document must contain only valid id, ref, title, summary, and aliases",
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
    codec: entry.codec!,
    logicalPath: entry.file.path,
  });
  return {
    descriptor,
    ranges: freeze({
      ...(idPair?.value === undefined
        ? {}
        : {
            documentId: nodeRange(
              entry.file.contents,
              idPair.value,
              parsed.baseOffset,
            ),
          }),
      ...(refPair?.value === undefined
        ? {}
        : {
            shortRef: nodeRange(
              entry.file.contents,
              refPair.value,
              parsed.baseOffset,
            ),
          }),
      ...(titlePair?.value === undefined
        ? {}
        : {
            title: nodeRange(
              entry.file.contents,
              titlePair.value,
              parsed.baseOffset,
            ),
          }),
      ...(summaryPair?.value === undefined
        ? {}
        : {
            summary: nodeRange(
              entry.file.contents,
              summaryPair.value,
              parsed.baseOffset,
            ),
          }),
      ...(aliasesPair?.value === undefined
        ? {}
        : {
            aliases: nodeRange(
              entry.file.contents,
              aliasesPair.value,
              parsed.baseOffset,
            ),
          }),
    }),
  };
}

function inspectYamlReferences(
  entry: InternalDocumentEntry,
  node: unknown,
  locator: readonly (string | number)[],
): void {
  if (isMap(node)) {
    const refPair = node.items.find(({ key }) => scalarEquals(key, "$ref"));
    if (refPair !== undefined) {
      const target = scalarString(refPair.value);
      const startNode = refPair.key;
      const endNode = refPair.value ?? refPair.key;
      entry.references.push({
        targetId: node.items.length === 1 ? target : null,
        locator: freeze({ yaml: freeze([...locator]) }),
        range: joinedNodeRange(entry.file.contents, startNode, endNode, 0),
        valueRange: nodeRange(
          entry.file.contents,
          refPair.value ?? refPair.key,
          0,
        ),
      });
      return;
    }
    for (const pair of node.items) {
      const key = scalarString(pair.key);
      if (key === null) {
        entry.diagnostics.push(
          diagnostic({
            code: "yaml_invalid",
            logicalPath: entry.file.path,
            ...(entry.descriptor === undefined
              ? {}
              : { documentId: entry.descriptor.documentId }),
            range: nodeRange(entry.file.contents, pair.key, 0),
            message: "YAML map keys must be strings",
          }),
        );
        continue;
      }
      if (locator.length === 0 && key === "$document") continue;
      inspectYamlReferences(entry, pair.value, [...locator, key]);
    }
    return;
  }
  if (isSeq(node))
    node.items.forEach((child, index) =>
      inspectYamlReferences(entry, child, [...locator, index]),
    );
}

function projectExplicitReferenceValues(
  source: string,
  selectedRange: WorldDocumentSourceRange,
  references: readonly InternalReference[],
  descriptors: ReadonlyMap<string, WorldDocumentDescriptor>,
  quoteProjection = false,
): string {
  const selectedStart = selectedRange.start.offset;
  const selectedEnd = selectedRange.end.offset;
  const replacements = references
    .flatMap((reference) => {
      const descriptor =
        reference.targetId === null
          ? undefined
          : descriptors.get(reference.targetId);
      const start = Math.max(selectedStart, reference.valueRange.start.offset);
      const end = Math.min(selectedEnd, reference.valueRange.end.offset);
      return start < end
        ? [
            {
              start,
              end,
              projection:
                descriptor === undefined
                  ? quoteProjection
                    ? JSON.stringify("(invalid document reference)")
                    : "(invalid document reference)"
                  : quoteProjection
                    ? JSON.stringify(`@${descriptor.shortRef}`)
                    : `@${descriptor.shortRef}`,
            },
          ]
        : [];
    })
    .sort((left, right) => left.start - right.start);
  let cursor = selectedStart;
  let projected = "";
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    projected += source.slice(cursor, replacement.start);
    projected += replacement.projection;
    cursor = replacement.end;
  }
  return projected + source.slice(cursor, selectedEnd);
}

function yamlBodyRange(
  source: string,
  root: YAMLMap<unknown, unknown>,
): WorldDocumentSourceRange {
  const firstBodyPair = root.items.find(
    ({ key }) => !scalarEquals(key, "$document"),
  );
  const start =
    firstBodyPair === undefined || !isRangedNode(firstBodyPair.key)
      ? source.length
      : (firstBodyPair.key.range?.[0] ?? source.length);
  return sourceRange(source, start, source.length);
}

function headerSearchRanges(ranges: HeaderRanges): WorldDocumentSourceRange[] {
  return [ranges.title, ranges.summary, ranges.aliases].filter(
    (range): range is WorldDocumentSourceRange => range !== undefined,
  );
}

function indexYamlNodes(
  source: string,
  root: YAMLMap<unknown, unknown>,
): InternalYamlNode[] {
  const result: InternalYamlNode[] = [];
  const bodyPairs = root.items.filter(
    ({ key }) => !scalarEquals(key, "$document"),
  );
  if (bodyPairs.length === 0)
    result.push({
      locatorKey: yamlLocatorKey([]),
      range: sourceRange(source, source.length, source.length),
    });
  else {
    const first = bodyPairs[0]!;
    const last = bodyPairs.at(-1)!;
    result.push({
      locatorKey: yamlLocatorKey([]),
      range: joinedNodeRange(source, first.key, last.value ?? last.key, 0),
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
          range: nodeRange(source, pair.value ?? pair.key, 0),
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
          range: nodeRange(source, child, 0),
        });
        visit(child, childLocator);
      });
  };
  visit(root, []);
  return result;
}

const unresolved = Symbol("world-document-node-unresolved");

function locateYamlValue(
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

function projectYamlValue(
  value: unknown,
  documents: ReadonlyMap<string, WorldDocumentDescriptor>,
): WorldDocumentValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return freeze(value.map((child) => projectYamlValue(child, documents)));
  if (isRecord(value)) {
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      const target = documents.get(value.$ref);
      if (target !== undefined)
        return freeze({
          $ref: value.$ref,
          target: freeze({
            documentId: target.documentId,
            shortRef: target.shortRef,
            title: target.title,
          }),
        });
    }
    return freeze(
      Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$document")
          .map(([key, child]) => [key, projectYamlValue(child, documents)]),
      ),
    );
  }
  return null;
}

function yamlLocatorKey(locator: readonly (string | number)[]): string {
  return JSON.stringify(locator);
}

function markdownLocatorKey(locator: readonly string[]): string {
  return JSON.stringify(locator.map((part) => part.normalize("NFKC")));
}

function trimTrailingWhitespaceOffset(
  source: string,
  start: number,
  rawEnd: number,
): number {
  let end = rawEnd;
  while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
  return end;
}

function normalizeSearchQuery(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("und");
}

function literalMatches(
  source: string,
  normalizedQuery: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const segment of segmenter.segment(source)) {
    const folded = normalizeSearchQuery(segment.segment, caseSensitive);
    normalized += folded;
    let remainingCodeUnits = folded.length;
    while (remainingCodeUnits > 0) {
      starts.push(segment.index);
      ends.push(segment.index + segment.segment.length);
      remainingCodeUnits -= 1;
    }
  }
  const result: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  let from = 0;
  while (from <= normalized.length - normalizedQuery.length) {
    const found = normalized.indexOf(normalizedQuery, from);
    if (found < 0) break;
    const start = starts[found];
    const end = ends[found + normalizedQuery.length - 1];
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

function safeUtf8PageEnd(
  bytes: Buffer,
  offset: number,
  maxBytes: number,
): number {
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0)
    end -= 1;
  return end;
}

interface MarkdownHeadingScan {
  readonly headings: readonly {
    readonly level: number;
    readonly title: string;
    readonly range: WorldDocumentSourceRange;
  }[];
  readonly hasUnclosedFence: boolean;
}

function scanMarkdownHeadings(
  source: string,
  bodyStart: number,
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
          range: sourceRange(source, lineStart, lineEnd),
        });
      }
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }
  return { headings, hasUnclosedFence: fence !== null };
}

function patchRevisionMarkdown(
  source: string,
  edits: readonly unknown[],
  initialMetadata: WorldDocumentMetadataInput,
):
  | { readonly contents: string }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  let contents = source;
  let metadata: WorldDocumentMetadataInput = {
    title: initialMetadata.title,
    summary: initialMetadata.summary,
    aliases: [...initialMetadata.aliases],
  };
  for (const edit of edits) {
    if (!isRecord(edit) || typeof edit.op !== "string")
      return {
        diagnostics: [
          diagnostic({
            code: "query_invalid",
            message: "A Markdown patch edit must be a closed object with op",
          }),
        ],
      };
    if (edit.op === "set_metadata") {
      if (!hasOnlyKeys(edit, ["op", "title", "summary", "aliases"]))
        return {
          diagnostics: [
            diagnostic({
              code: "document_header_invalid",
              message:
                "set_metadata accepts only op, title, summary, and aliases",
            }),
          ],
        };
      const resolved = resolveDocumentMetadataRevision(metadata, edit);
      if ("problems" in resolved)
        return {
          diagnostics: [
            diagnostic({
              code: "document_header_invalid",
              message: `set_metadata arguments are invalid: ${resolved.problems.join("; ")}`,
            }),
          ],
        };
      metadata = resolved.metadata;
      const envelope = markdownEnvelope(contents);
      if ("diagnostics" in envelope) return envelope;
      envelope.header.setIn(["$document", "title"], metadata.title);
      envelope.header.setIn(["$document", "summary"], metadata.summary);
      envelope.header.setIn(["$document", "aliases"], [...metadata.aliases]);
      const body = contents.slice(envelope.bodyStart);
      const firstHeading = scanMarkdownHeadings(body, 0).headings[0];
      if (firstHeading?.level !== 1)
        return {
          diagnostics: [
            diagnostic({
              code: "markdown_invalid",
              message: "Markdown body is missing an updateable h1",
            }),
          ],
        };
      const nextBody = `${body.slice(0, firstHeading.range.start.offset)}# ${metadata.title}${body.slice(firstHeading.range.end.offset)}`;
      contents = `---\n${envelope.header.toString({ indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${nextBody}`;
      continue;
    }
    if (edit.op === "replace_body" || edit.op === "replace_preamble") {
      if (
        !hasOnlyKeys(edit, ["op", "markdown"]) ||
        typeof edit.markdown !== "string"
      )
        return {
          diagnostics: [
            diagnostic({
              code: "query_invalid",
              message: "A Markdown body edit requires markdown source",
            }),
          ],
        };
      const envelope = markdownEnvelope(contents);
      if ("diagnostics" in envelope) return envelope;
      if (edit.op === "replace_body") {
        contents = `${contents.slice(0, envelope.bodyStart)}${edit.markdown.trimEnd()}\n`;
        continue;
      }
      const headings = scanMarkdownHeadings(
        contents,
        envelope.bodyStart,
      ).headings;
      const h1 = headings.find(({ level }) => level === 1);
      if (h1 === undefined)
        return {
          diagnostics: [
            diagnostic({
              code: "markdown_invalid",
              message: "Markdown body is missing an updateable h1",
            }),
          ],
        };
      const nextH2 = headings.find(
        ({ level, range }) =>
          level === 2 && range.start.offset > h1.range.start.offset,
      );
      const end = nextH2?.range.start.offset ?? contents.length;
      contents = `${contents.slice(0, h1.range.end.offset)}\n\n${edit.markdown.trim()}\n\n${contents.slice(end)}`;
      continue;
    }
    if (
      ![
        "replace_section",
        "add_section",
        "rename_section",
        "remove_section",
      ].includes(edit.op) ||
      !validMarkdownLocator(edit.locator)
    )
      return {
        diagnostics: [
          diagnostic({
            code: "locator_invalid",
            ...(isRecord(edit.locator)
              ? {
                  locator: copyLocator(
                    edit.locator as unknown as WorldDocumentLocator,
                  ),
                }
              : {}),
            message: "A Markdown patch requires an exact heading locator",
          }),
        ],
      };
    const locator = { markdown: [...edit.locator.markdown] } as const;
    const section = markdownRevisionSection(contents, locator.markdown);
    if ("diagnostics" in section) return section;
    if (edit.op === "remove_section") {
      if (!hasOnlyKeys(edit, ["op", "locator"]))
        return {
          diagnostics: [
            diagnostic({
              code: "query_invalid",
              locator,
              message: "remove_section contains undeclared arguments",
            }),
          ],
        };
      contents = `${contents.slice(0, section.start)}${contents.slice(section.rawEnd)}`;
      continue;
    }
    if (edit.op === "rename_section") {
      if (
        !hasOnlyKeys(edit, ["op", "locator", "title"]) ||
        !validMarkdownHeadingTitle(edit.title)
      )
        return {
          diagnostics: [
            diagnostic({
              code: "query_invalid",
              locator,
              message: "rename_section requires a valid new heading",
            }),
          ],
        };
      contents = `${contents.slice(0, section.start)}${"#".repeat(section.level)} ${edit.title}${contents.slice(section.headingEnd)}`;
      continue;
    }
    if (
      !hasOnlyKeys(edit, ["op", "locator", "markdown"]) ||
      typeof edit.markdown !== "string"
    )
      return {
        diagnostics: [
          diagnostic({
            code: "query_invalid",
            locator,
            message:
              "A Markdown section edit requires a complete Markdown block",
          }),
        ],
      };
    const block = edit.markdown.trim();
    const { headings, hasUnclosedFence } = scanMarkdownHeadings(block, 0);
    const first = headings[0];
    const escapesSectionSubtree = headings
      .slice(1)
      .some(({ level }) => first !== undefined && level <= first.level);
    if (edit.op === "replace_section") {
      if (
        first?.range.start.offset !== 0 ||
        first.level !== section.level ||
        first.title.normalize("NFKC") !==
          locator.markdown.at(-1)!.normalize("NFKC") ||
        escapesSectionSubtree ||
        hasUnclosedFence
      )
        return {
          diagnostics: [
            diagnostic({
              code: "locator_invalid",
              locator,
              message:
                "replace_section first heading must preserve the exact original heading path",
            }),
          ],
        };
      contents = `${contents.slice(0, section.start)}${block}${contents.slice(section.trimmedEnd)}`;
    } else {
      if (
        first?.range.start.offset !== 0 ||
        first.level !== section.level + 1 ||
        escapesSectionSubtree ||
        hasUnclosedFence
      )
        return {
          diagnostics: [
            diagnostic({
              code: "locator_invalid",
              locator,
              message:
                "add_section must add a complete block with a heading one level lower",
            }),
          ],
        };
      contents = `${contents.slice(0, section.trimmedEnd)}\n\n${block}${contents.slice(section.trimmedEnd)}`;
    }
  }
  return { contents: contents.trimEnd().concat("\n") };
}

function markdownEnvelope(source: string):
  | {
      readonly header: ReturnType<typeof parseDocument>;
      readonly bodyStart: number;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  if (!source.startsWith("---\n"))
    return {
      diagnostics: [
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown must begin with technical front matter",
        }),
      ],
    };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0)
    return {
      diagnostics: [
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown technical front matter is not closed",
        }),
      ],
    };
  const header = parseDocument(source.slice(4, end), {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (header.errors.length > 0 || header.warnings.length > 0)
    return {
      diagnostics: [
        diagnostic({
          code: "yaml_invalid",
          message: "Markdown technical front matter could not be parsed safely",
        }),
      ],
    };
  return { header, bodyStart: end + 5 };
}

function markdownRevisionSection(
  source: string,
  locator: readonly string[],
):
  | {
      readonly start: number;
      readonly headingEnd: number;
      readonly trimmedEnd: number;
      readonly rawEnd: number;
      readonly level: number;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  const envelope = markdownEnvelope(source);
  if ("diagnostics" in envelope) return envelope;
  const headings = scanMarkdownHeadings(source, envelope.bodyStart).headings;
  const stack: string[] = [];
  const matches: { readonly index: number; readonly level: number }[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.level === 1) {
      stack.length = 0;
      continue;
    }
    stack.length = heading.level - 2;
    stack[heading.level - 2] = heading.title.normalize("NFKC");
    if (
      stack.length === locator.length &&
      locator.every(
        (part, locatorIndex) => stack[locatorIndex] === part.normalize("NFKC"),
      )
    )
      matches.push({ index, level: heading.level });
  }
  const publicLocator = { markdown: [...locator] } as const;
  if (matches.length !== 1)
    return {
      diagnostics: [
        diagnostic({
          code:
            matches.length === 0 ? "locator_not_found" : "locator_ambiguous",
          locator: publicLocator,
          message: "Markdown heading path cannot be located uniquely",
        }),
      ],
    };
  const match = matches[0]!;
  const heading = headings[match.index]!;
  const next = headings
    .slice(match.index + 1)
    .find(({ level }) => level <= match.level);
  const rawEnd = next?.range.start.offset ?? source.length;
  return {
    start: heading.range.start.offset,
    headingEnd: heading.range.end.offset,
    trimmedEnd: trimTrailingWhitespaceOffset(
      source,
      heading.range.start.offset,
      rawEnd,
    ),
    rawEnd,
    level: match.level,
  };
}

function forbiddenYamlRange(
  source: string,
): { start: number; end: number } | null {
  const nul = source.indexOf("\0");
  if (nul >= 0) return { start: nul, end: nul + 1 };
  const carriage = source.indexOf("\r");
  if (carriage >= 0) return { start: carriage, end: carriage + 1 };
  for (const pattern of [
    /(^|\s)[&*!][^\s,\]}]+/mu,
    /^\s*<<\s*:/mu,
    /^\.\.\.\s*$/mu,
  ]) {
    const match = pattern.exec(source);
    if (match !== null)
      return { start: match.index, end: match.index + match[0].length };
  }
  return null;
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

function scalarEquals(value: unknown, expected: string): boolean {
  return isScalar(value) && value.value === expected;
}

function scalarString(value: unknown): string | null {
  return isScalar(value) && typeof value.value === "string"
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

function nodeRange(
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

function joinedNodeRange(
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

function isRangedNode(value: unknown): value is Node {
  return isScalar(value) || isMap(value) || isSeq(value);
}

function sourceRange(
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

function diagnostic(value: WorldDocumentDiagnostic): WorldDocumentDiagnostic {
  return freeze(value);
}

function revisionDiagnostic(
  commandIndex: number | null,
  value: WorldDocumentDiagnostic,
): WorldDocumentRevisionDiagnostic {
  return freeze({ ...value, commandIndex });
}

function mechanicalHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function validDocumentMetadata<
  T extends {
    readonly title?: unknown;
    readonly summary?: unknown;
    readonly aliases?: unknown;
  },
>(value: T): value is T & WorldDocumentMetadataInput {
  return documentMetadataProblems(value).length === 0;
}

function resolveDocumentMetadataRevision(
  current: WorldDocumentMetadataInput,
  edit: {
    readonly title?: unknown;
    readonly summary?: unknown;
    readonly aliases?: unknown;
  },
):
  | { readonly metadata: WorldDocumentMetadataInput }
  | { readonly problems: readonly string[] } {
  if (
    !Object.hasOwn(edit, "title") &&
    !Object.hasOwn(edit, "summary") &&
    !Object.hasOwn(edit, "aliases")
  )
    return {
      problems: ["at least one of title, summary, or aliases must be provided"],
    };
  const metadata = {
    title: Object.hasOwn(edit, "title") ? edit.title : current.title,
    summary: Object.hasOwn(edit, "summary") ? edit.summary : current.summary,
    aliases: Object.hasOwn(edit, "aliases") ? edit.aliases : current.aliases,
  };
  const problems = documentMetadataProblems(metadata);
  return problems.length === 0
    ? { metadata: metadata as WorldDocumentMetadataInput }
    : { problems };
}

/**
 * Says which of the three fields is wrong and what arrived instead.
 *
 * One shared sentence covering title, summary and aliases left the author
 * guessing among six failure modes, and guessing costs a whole exchange.
 */
function documentMetadataProblems(value: {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly aliases?: unknown;
}): string[] {
  const problems: string[] = [];
  problems.push(...boundedTextProblems("title", value.title, 120));
  problems.push(...boundedTextProblems("summary", value.summary, 240));
  if (!Array.isArray(value.aliases))
    problems.push(
      `aliases must be an array; received ${describeValue(value.aliases)}`,
    );
  else if (value.aliases.length > 16)
    problems.push(
      `aliases may contain at most 16 items; received ${value.aliases.length}`,
    );
  else
    for (const [index, alias] of value.aliases.entries()) {
      if (typeof alias !== "string")
        problems.push(
          `aliases item ${index + 1} must be a string; received ${describeValue(alias)}`,
        );
      else if ([...alias].length < 1 || [...alias].length > 64)
        problems.push(
          `aliases item ${index + 1} must contain 1 to 64 characters; received ${[...alias].length}`,
        );
    }
  return problems;
}

function boundedTextProblems(
  field: string,
  value: unknown,
  limit: number,
): string[] {
  if (typeof value !== "string")
    return [`${field} must be a string; received ${describeValue(value)}`];
  const length = [...value].length;
  if (length < 1) return [`${field} cannot be empty`];
  return length > limit
    ? [`${field} may contain at most ${limit} characters; received ${length}`]
    : [];
}

// aliases feeds the literal search index, so entries must end up as strings.
// A numeric alias such as a room number is still worth searching for, so it is
// coerced rather than used as grounds to reject the whole document.
function normalizeAliases(value: unknown): unknown {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return value;
  return value.map((alias: unknown) =>
    typeof alias === "number" || typeof alias === "boolean"
      ? String(alias)
      : alias,
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === "object") return "object";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function validRevisionLogicalPath(
  logicalPath: string,
  codec: WorldDocumentCodec,
  logicalRoot: "world" | "state",
): boolean {
  const prefix = `${logicalRoot}/`;
  return (
    logicalPath.startsWith(prefix) &&
    validRelativePath(logicalPath.slice(prefix.length)) &&
    documentCodec(logicalPath) === codec
  );
}

function nextAvailableShortRef(
  hint: string,
  occupied: ReadonlySet<string>,
): string {
  if (!occupied.has(hint)) return hint;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${hint.slice(0, 32 - suffixText.length)}${suffixText}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function freezeFile(file: WorldDocumentFile): WorldDocumentFile {
  return freeze({
    path: file.path,
    contents: file.contents,
    ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
  });
}

function documentCodec(path: string): WorldDocumentCodec | null {
  if (/\.ya?ml$/iu.test(path)) return "yaml";
  if (/\.md$/iu.test(path)) return "markdown";
  return null;
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function blockingDocumentDiagnostics(
  entry: InternalDocumentEntry,
): readonly WorldDocumentDiagnostic[] {
  return entry.diagnostics.filter(
    ({ code }) =>
      code !== "locator_ambiguous" && code !== "document_reference_invalid",
  );
}

function literalSearchBlockingDiagnostics(
  entry: InternalDocumentEntry,
): readonly WorldDocumentDiagnostic[] {
  return entry.diagnostics.filter(({ code }) => code !== "locator_ambiguous");
}

function yamlLocatorsOverlap(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return locatorStartsWith(left, right) || locatorStartsWith(right, left);
}

function locatorStartsWith(
  value: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return (
    value.length >= prefix.length &&
    prefix.every((segment, index) => value[index] === segment)
  );
}

function validYamlLocator(
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

function validMarkdownLocator(
  value: unknown,
): value is { readonly markdown: readonly string[] } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.markdown) &&
    value.markdown.length > 0 &&
    value.markdown.every(
      (segment) => typeof segment === "string" && segment.length > 0,
    )
  );
}

function validMarkdownHeadingTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    !/[\r\n]/u.test(value) &&
    [...value].length >= 1 &&
    [...value].length <= 120
  );
}

function copyLocator(value: WorldDocumentLocator): WorldDocumentLocator {
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

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
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

function groupBy<T>(
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

function freeze<T>(value: T): T {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
