import { useMemo, useState } from "react";
import { isMap } from "yaml";

import type { ContentTreeFile } from "../protocol/v1.ts";
import { parseRestrictedYamlDocument } from "../shared/restricted-yaml.ts";
import {
  documentCodec,
  markdownFrontMatter,
  maxShortRefLength,
} from "../shared/world-document-format.ts";
import {
  scalarEquals,
  scalarString,
  shortRefPattern,
} from "../shared/world-documents/WorldDocumentSource.ts";
import type { WorldDocumentRoot } from "./world-document-draft.ts";

export type AuthoringFileTarget = "content-package" | "world-revision";

export interface AuthoringFileView {
  ordered: readonly ContentTreeFile[];
  visible: readonly ContentTreeFile[];
  selected: ContentTreeFile | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (path: string) => void;
}

export function useAuthoringFileView(
  files: readonly ContentTreeFile[],
  target: AuthoringFileTarget,
  initialSelectedPath = "",
): AuthoringFileView {
  const [selectedPath, setSelectedPath] = useState(initialSelectedPath);
  const [query, setQuery] = useState("");
  const ordered = useMemo(
    () => orderAuthoringFiles(files, target),
    [files, target],
  );
  const search = useMemo(() => createAuthoringFileSearch(target), [target]);
  const visible = useMemo(
    () => search(ordered, query),
    [search, ordered, query],
  );
  return {
    ordered,
    visible,
    selected: ordered.find(({ path }) => path === selectedPath) ?? ordered[0],
    query,
    onQueryChange: setQuery,
    onSelect: setSelectedPath,
  };
}

export function orderAuthoringFiles(
  files: readonly ContentTreeFile[],
  kind: AuthoringFileTarget,
): ContentTreeFile[] {
  const root = documentRoot(kind);
  const rank = (path: string): number => {
    if (kind === "content-package" && path === "opening.md") return 0;
    if (path === `${root}current-situation.yaml`) return 1;
    if (path.startsWith(root)) return 2;
    if (path === "control/frame.yaml") return 3;
    if (path.startsWith("control/")) return 4;
    return 5;
  };
  return [...files].sort(
    (left, right) =>
      rank(left.path) - rank(right.path) || left.path.localeCompare(right.path),
  );
}

interface FileSearchEntry {
  file: ContentTreeFile;
  terms: string[];
}

export function createAuthoringFileSearch(kind: AuthoringFileTarget) {
  const root = documentRoot(kind);
  let indexedFiles: readonly ContentTreeFile[] | undefined;
  let index = new Map<string, FileSearchEntry>();

  return (files: readonly ContentTreeFile[], query: string) => {
    const needle = fold(query.trim());
    if (needle === "") return files;

    if (files !== indexedFiles) {
      // The drafts may copy every file record for a single change.
      const next = new Map<string, FileSearchEntry>();
      for (const file of files) {
        const prior = index.get(file.path);
        const unchanged =
          prior?.file.contents === file.contents &&
          prior.file.encoding === file.encoding;
        const terms = unchanged
          ? prior.terms
          : [file.path, ...documentTerms(file, root)].map(fold);
        next.set(file.path, { file, terms });
      }
      indexedFiles = files;
      index = next;
    }
    return files.filter(({ path }) =>
      index.get(path)?.terms.some((term) => term.includes(needle)),
    );
  };
}

function documentRoot(kind: AuthoringFileTarget): WorldDocumentRoot {
  return kind === "content-package" ? "world/" : "state/";
}

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function documentTerms(
  file: ContentTreeFile,
  root: WorldDocumentRoot,
): string[] {
  if (file.encoding !== undefined || !file.path.startsWith(root)) return [];
  const codec = documentCodec(file.path);
  if (codec === null) return [];
  const source =
    codec === "markdown"
      ? markdownFrontMatter(file.contents)
      : yamlMetadataSource(file.contents);
  if (source === "") return [];

  try {
    const { document } = parseRestrictedYamlDocument(source, {
      rejectRawControlCharacters: true,
    });
    const first = isMap(document?.contents) ? document.contents.items[0] : null;
    if (!scalarEquals(first?.key, "$document") || !isMap(first?.value))
      return [];

    const terms: string[] = [];
    const title = scalarString(first.value.get("title", true));
    if (title !== null) terms.push(title);
    const ref = scalarString(first.value.get("ref", true));
    if (
      ref !== null &&
      ref.length >= 2 &&
      ref.length <= maxShortRefLength &&
      shortRefPattern.test(ref)
    )
      terms.push(`@${ref}`);
    return terms;
  } catch {
    // An incomplete source remains reachable by path even if parsing throws.
    return [];
  }
}

// The usual block-format header is the first top-level entry. Hand the parser
// just this entry, leaving the rest of a large YAML draft outside the index.
function yamlMetadataSource(source: string): string {
  const opening =
    /^(?:[ \t]*(?:#[^\n]*)?\n)*\$document:[ \t]*(?:#[^\n]*)?\n/u.exec(source);
  if (opening === null) return source;
  const nextEntry = /^[^\s#]/gmu;
  nextEntry.lastIndex = opening[0].length;
  const end = nextEntry.exec(source)?.index;
  return end === undefined ? source : source.slice(0, end);
}
