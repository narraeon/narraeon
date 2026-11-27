import { useMemo, useState } from "react";
import type { ContentTreeFile } from "../protocol/v1.ts";
import { readWorldDocumentHeader } from "./worldDocumentPresentation.ts";
import type { WorldDocumentRoot } from "./world-document-draft.ts";

export type AuthoringFileTarget = "content-package" | "world-revision";

export interface AuthoringFileView {
  ordered: readonly ContentTreeFile[];
  visible: readonly ContentTreeFile[];
  selected: ContentTreeFile | undefined;
  query: string;
  titles: ReadonlyMap<string, string>;
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
  const titles = useMemo(() => search.titles(ordered), [search, ordered]);
  const visible = useMemo(
    () => search(ordered, query),
    [search, ordered, query],
  );
  return {
    ordered,
    visible,
    selected: ordered.find(({ path }) => path === selectedPath) ?? ordered[0],
    query,
    titles,
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

interface FileIndexEntry {
  file: ContentTreeFile;
  title: string | null;
  terms: string[];
}

export function createAuthoringFileSearch(kind: AuthoringFileTarget) {
  const root = documentRoot(kind);
  let index = new Map<string, FileIndexEntry>();
  let indexedFiles: readonly ContentTreeFile[] | undefined;

  function indexFiles(files: readonly ContentTreeFile[]) {
    if (indexedFiles === files) return index;
    const next = new Map<string, FileIndexEntry>();
    for (const file of files) {
      const prior = index.get(file.path);
      // The drafts may copy every file record for a single change.
      if (
        prior?.file.contents === file.contents &&
        prior.file.encoding === file.encoding
      ) {
        next.set(file.path, prior);
        continue;
      }

      const header = file.path.startsWith(root)
        ? readWorldDocumentHeader(file)
        : undefined;
      const title = header?.title ?? null;
      const ref = header?.ref;
      const terms = [fold(file.path)];
      if (title !== null) terms.push(fold(title));
      if (ref != null) terms.push(fold(`@${ref}`));
      next.set(file.path, { file, title, terms });
    }
    indexedFiles = files;
    index = next;
    return next;
  }

  function search(files: readonly ContentTreeFile[], query: string) {
    const needle = fold(query.trim());
    if (needle === "") return files;
    const indexed = indexFiles(files);
    return files.filter(({ path }) =>
      indexed.get(path)?.terms.some((term) => term.includes(needle)),
    );
  }

  search.titles = (files: readonly ContentTreeFile[]) => {
    const titles = new Map<string, string>();
    for (const [path, { title }] of indexFiles(files))
      if (title !== null) titles.set(path, title);
    return titles;
  };

  return search;
}

function documentRoot(kind: AuthoringFileTarget): WorldDocumentRoot {
  return kind === "content-package" ? "world/" : "state/";
}

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}
