/**
 * `content_package` edits a template under `world`; `world_revision` edits a
 * playing world's authoring worktree under `state` with the same authoring
 * rules; `world_state` is the read-only play snapshot under `state`.
 */
export type WorldDocumentLayout =
  "content_package" | "world_revision" | "world_state";

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
  /** Retired state documents remain addressable but leave frame catalogs. */
  readonly retired: boolean;
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
  /** Defaults to true; frame catalog injection opts out explicitly. */
  readonly includeRetired?: boolean;
  /**
   * Logical directories declared outside the persisted document tree. They
   * participate in the same deterministic listing and cursor as directories
   * inferred from files, but do not create storage entries of their own.
   */
  readonly declaredDirectories?: readonly string[];
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
