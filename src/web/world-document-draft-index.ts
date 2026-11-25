import {
  inspectDocumentFile,
  type InternalDocumentEntry,
} from "../shared/world-documents/WorldDocumentCodec.ts";
import {
  locateYamlValue,
  WorldDocumentReadIndex,
  type WorldDocumentReadSelection,
  yamlReferenceProblems,
} from "../shared/world-documents/WorldDocumentReadIndex.ts";
import {
  groupBy,
  validMarkdownLocator,
  validYamlLocator,
} from "../shared/world-documents/WorldDocumentSource.ts";
import type {
  WorldDocumentCodec,
  WorldDocumentFile,
} from "../shared/world-documents/WorldDocumentTypes.ts";

export type WorldDocumentDraftLocator =
  | null
  | { readonly yaml: readonly string[] }
  | { readonly markdown: readonly string[] };

export interface WorldDocumentDraftDocument {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  readonly path: string;
  readonly codec: WorldDocumentCodec;
  readonly retired: boolean;
}

export type WorldDocumentDraftLayout = "content_package" | "world_revision";

interface WorldDocumentDraft {
  readonly documents: readonly WorldDocumentDraftDocument[];
  resolve(document: string): WorldDocumentDraftDocument | undefined;
  choices(document: string): readonly WorldDocumentDraftLocator[];
  choiceHints(document: string): ReadonlyMap<string, string>;
  yamlBody(document: string): Readonly<Record<string, unknown>> | undefined;
  readonly snapshot: WorldDocumentReadIndex;
}

// File edits replace objects immutably. Keep unaffected document inspections
// and reuse the complete index when only a control file changed.
const inspections = new WeakMap<WorldDocumentFile, InternalDocumentEntry>();
const drafts = new WeakMap<
  WorldDocumentFile,
  { files: readonly WorldDocumentFile[]; draft: WorldDocumentDraft }
>();
const emptyHints: ReadonlyMap<string, string> = new Map();
export function buildWorldDocumentDraft(
  files: readonly WorldDocumentFile[],
  layout: WorldDocumentDraftLayout,
): WorldDocumentDraft {
  const root = layout === "content_package" ? "world/" : "state/";
  const documents = files.filter(({ path }) => path.startsWith(root));
  const first = documents[0];
  const previous = first === undefined ? undefined : drafts.get(first);
  if (
    previous?.files.length === documents.length &&
    documents.every((file, index) => file === previous.files[index])
  )
    return previous.draft;

  const snapshot = new WorldDocumentReadIndex(
    "world-document-draft",
    layout,
    documents,
    (file, logicalRoot) => {
      const previous = inspections.get(file);
      if (previous !== undefined) return previous;
      const inspected = inspectDocumentFile(file, logicalRoot);
      inspections.set(file, inspected);
      return inspected;
    },
  );
  const available = new Map<
    InternalDocumentEntry,
    WorldDocumentDraftDocument
  >();
  for (const entry of snapshot.entries) {
    const { descriptor } = entry;
    if (
      descriptor === undefined ||
      "diagnostics" in
        snapshot.resolveSelector({ shortRef: descriptor.shortRef })
    )
      continue;
    available.set(entry, {
      id: descriptor.documentId,
      ref: `@${descriptor.shortRef}`,
      title: descriptor.title,
      path: descriptor.logicalPath,
      codec: descriptor.codec,
      retired: descriptor.retired,
    });
  }
  const choicesByEntry = new Map<
    InternalDocumentEntry,
    readonly WorldDocumentDraftLocator[]
  >();
  const resolve = (handle: string): WorldDocumentReadSelection =>
    snapshot.resolveSelector(
      handle.startsWith("@")
        ? { shortRef: handle.slice(1) }
        : { documentId: handle },
    );
  const hintsByEntry = new Map<
    InternalDocumentEntry,
    ReadonlyMap<string, string>
  >();
  const draft: WorldDocumentDraft = {
    documents: [...available.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    resolve(handle) {
      const found = resolve(handle);
      return "entry" in found ? available.get(found.entry) : undefined;
    },
    choices(handle) {
      const found = resolve(handle);
      if ("diagnostics" in found) return [];
      const { entry } = found;
      const cached = choicesByEntry.get(entry);
      if (cached !== undefined) return cached;
      const choices = documentChoices(entry);
      choicesByEntry.set(entry, choices);
      return choices;
    },
    choiceHints(handle) {
      const found = resolve(handle);
      if ("diagnostics" in found || found.entry.yaml === undefined)
        return emptyHints;
      const { entry } = found;
      const cached = hintsByEntry.get(entry);
      if (cached !== undefined) return cached;
      const hints = new Map<string, string>();
      const body = found.entry.yaml.body;
      for (const locator of draft.choices(handle)) {
        if (locator === null || !("yaml" in locator)) continue;
        const hint = scalarHint(locateYamlValue(body, locator.yaml));
        if (hint !== undefined) hints.set(JSON.stringify(locator), hint);
      }
      hintsByEntry.set(entry, hints);
      return hints;
    },
    yamlBody(handle) {
      const found = resolve(handle);
      return "entry" in found ? found.entry.yaml?.body : undefined;
    },
    snapshot,
  };
  if (first !== undefined) drafts.set(first, { files: documents, draft });
  return draft;
}

function documentChoices(
  entry: InternalDocumentEntry,
): readonly WorldDocumentDraftLocator[] {
  if (entry.markdown !== undefined) {
    const byPath = groupBy(
      entry.markdown.headings,
      (heading) => heading.locatorKey,
    );
    return [
      null,
      ...entry.markdown.headings.flatMap(({ locator, locatorKey }) => {
        const choice = { markdown: locator };
        return byPath.get(locatorKey)?.length === 1 &&
          validMarkdownLocator(choice)
          ? [choice]
          : [];
      }),
    ];
  }

  return (
    entry.yaml?.nodes.flatMap(({ locatorKey }) => {
      // This key is created from an actual node by the document codec.
      const parts: unknown = JSON.parse(locatorKey);
      const locator = { yaml: parts };
      if (
        !validYamlLocator(locator) ||
        !locator.yaml.every((part) => typeof part === "string") ||
        yamlReferenceProblems(entry, locator.yaml).length > 0
      )
        return [];
      return [locator.yaml.length === 0 ? null : { yaml: locator.yaml }];
    }) ?? []
  );
}

function scalarHint(value: unknown): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    return undefined;

  // Take a bounded prefix before folding whitespace, even for a long scalar.
  const prefix = String(value).slice(0, 160);
  const text = prefix.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;

  const limit = /^.{1,40}/u.exec(text)?.[0] ?? text;
  return limit.length < text.length || prefix.length < String(value).length
    ? `${limit}…`
    : limit;
}
