import type { WorldDocumentStore } from "../WorldDocumentStore.ts";
import type {
  WorldDocumentCodec,
  WorldDocumentDiagnostic,
  WorldDocumentFile,
  WorldDocumentSelector,
  WorldDocumentSnapshotStatus,
} from "../../../shared/world-documents/WorldDocumentTypes.ts";

export type * from "../../../shared/world-documents/WorldDocumentTypes.ts";

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

/** Sets any non-empty subset of title, summary and aliases; omitted fields keep their stored value. */
export interface WorldDocumentMetadataRevisionEdit {
  readonly op: "set_metadata";
  readonly title?: string;
  readonly summary?: string;
  readonly aliases?: readonly string[];
}

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

/** Toggle catalog participation without destroying narrative state. */
export interface WorldDocumentRetireRevisionCommand {
  readonly kind: "retire";
  readonly document: WorldDocumentRevisionTarget;
  readonly retired: boolean;
}

export type WorldDocumentRevisionCommand =
  | WorldDocumentCreateRevisionCommand
  | WorldDocumentMoveRevisionCommand
  | WorldDocumentPatchRevisionCommand
  | WorldDocumentReplaceRevisionCommand
  | WorldDocumentRetireRevisionCommand
  | WorldDocumentWriteRevisionCommand;

/**
 * An ephemeral candidate-tree expansion against one fixed document snapshot.
 * Content packages allow create/move/patch/replace under `world`; world state
 * allows create/patch/replace/retire under `state`. It never publishes
 * authority.
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

/**
 * How one edit of a patch command settled. Edits settle one by one: an edit
 * that cannot apply is skipped and the edits around it still apply.
 */
export interface WorldDocumentEditOutcome {
  readonly commandIndex: number;
  readonly editIndex: number;
  readonly status: "applied" | "no_op" | "failed";
  /** Present for no_op (the target was absent) and failed edits. */
  readonly diagnostic?: WorldDocumentDiagnostic;
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
  readonly editOutcomes: readonly WorldDocumentEditOutcome[];
}

export interface WorldDocumentRevisionFailure {
  readonly kind: "error";
  readonly ok: false;
  readonly sourceSnapshotId: string;
  readonly snapshotStatus: WorldDocumentSnapshotStatus;
  readonly diagnostics: readonly WorldDocumentRevisionDiagnostic[];
  /** Set when a patch command failed because none of its edits applied. */
  readonly editOutcomes: readonly WorldDocumentEditOutcome[];
}

export type WorldDocumentRevisionResult =
  WorldDocumentRevisionSuccess | WorldDocumentRevisionFailure;
