import { parseDocument } from "yaml";
import type { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import { renderWorldYamlSource } from "../world/WorldYamlRendering.ts";

/** Complete public YAML node bytes, captured once; never resolved on read. */
export type HistoryBackground =
  | { kind: "snapshot"; value: string }
  | { kind: "narrative"; before: string | null; after: string | null };

export interface NarrativeOrigin {
  firstEventId: number;
  documentId: string;
  value: string | null;
}

type Snapshot = Pick<WorldDocumentStore, "files" | "query">;

export function captureNarrativeOrigin(
  snapshot: Snapshot,
  firstEventId: number,
): NarrativeOrigin {
  const source = snapshot.files.find(
    ({ path }) => path === "control/frame.yaml",
  )?.contents;
  if (source === undefined)
    throw new Error("Current situation frame is missing");
  const parsed = parseDocument(source, { schema: "core", uniqueKeys: true });
  if (parsed.errors.length > 0)
    throw new Error("Current situation frame is invalid");
  const frame: unknown = parsed.toJS({ maxAliasCount: 0 });
  const binding =
    record(frame) && record(frame.bindings)
      ? frame.bindings.currentSituation
      : undefined;
  if (typeof binding !== "string" || binding.length === 0)
    throw new Error("Current situation binding is invalid");
  const read = snapshot.query({
    kind: "read_document",
    document: binding.startsWith("@")
      ? { shortRef: binding.slice(1) }
      : { documentId: binding },
  });
  if (read.kind !== "read_document")
    throw new Error("Bound current situation cannot be read");
  const documentId = read.document.documentId;
  return {
    firstEventId,
    documentId,
    value: readBackground(snapshot, documentId),
  };
}

export function readBackground(
  snapshot: Snapshot,
  documentId: string,
): string | null {
  const selected = snapshot.query({
    kind: "select_node",
    document: { documentId },
    locator: { yaml: ["背景"] },
  });
  if (selected.kind !== "select_node" || selected.node.codec !== "yaml")
    return null;
  const value = selected.node.value;
  if (
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value === "object" && Object.keys(value).length === 0)
  )
    return null;
  // Quoted multiline scalars retain trailing newlines when display framing trims.
  return renderWorldYamlSource(value, { blockQuote: false });
}

export function snapshotBackground(
  value: string | null,
): HistoryBackground | undefined {
  return value === null ? undefined : { kind: "snapshot", value };
}

export function narrativeBackground(
  origin: NarrativeOrigin | undefined,
  snapshot: Snapshot,
): HistoryBackground | undefined {
  // A released frozen request without an origin stays unrecorded on recovery.
  if (origin === undefined) return undefined;
  const after = readBackground(snapshot, origin.documentId);
  return origin.value === null && after === null
    ? undefined
    : { kind: "narrative", before: origin.value, after };
}

export function isHistoryBackground(
  value: unknown,
): value is HistoryBackground {
  if (!record(value)) return false;
  if (value.kind === "snapshot")
    return Object.keys(value).length === 2 && nonempty(value.value);
  return (
    value.kind === "narrative" &&
    Object.keys(value).length === 3 &&
    (value.before === null || nonempty(value.before)) &&
    (value.after === null || nonempty(value.after)) &&
    (value.before !== null || value.after !== null)
  );
}

export function isNarrativeOrigin(value: unknown): value is NarrativeOrigin {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.firstEventId) &&
    Number(value.firstEventId) > 0 &&
    typeof value.documentId === "string" &&
    value.documentId.length > 0 &&
    (value.value === null || nonempty(value.value))
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
