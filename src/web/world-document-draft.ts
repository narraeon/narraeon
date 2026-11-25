import { parseDocument, stringify } from "yaml";

import type {
  ContentTreeFile,
  V1SettingAuthoringDiff,
} from "../protocol/v1.ts";
import {
  documentCodec,
  markdownFrontMatter,
  maxShortRefLength,
  nextAvailableShortRef,
} from "../shared/world-document-format.ts";
import { browserUUID } from "./browser-uuid.ts";
import { uiText } from "./i18n.ts";

export type WorldDocumentRoot = "world/" | "state/";

export function readDraftIdentity(
  file: ContentTreeFile,
  root: WorldDocumentRoot,
): { id: string | null; ref: string | null } | null {
  if (file.encoding !== undefined || !file.path.startsWith(root)) return null;
  const codec = documentCodec(file.path);
  if (codec === null) return null;
  const source =
    codec === "markdown"
      ? markdownFrontMatter(file.contents.replaceAll("\r\n", "\n"))
      : file.contents;
  // Direct scalar reads also reserve identifiers from incomplete file drafts.
  const document = parseDocument(source);
  const id: unknown = document.getIn(["$document", "id"]);
  const ref: unknown = document.getIn(["$document", "ref"]);
  return {
    id: typeof id === "string" ? id : null,
    ref: typeof ref === "string" ? ref : null,
  };
}

export function revisionBaseDocumentIds(
  files: readonly ContentTreeFile[],
  diff: readonly V1SettingAuthoringDiff[] | undefined,
): ReadonlySet<string> {
  const original = new Map(files.map((file) => [file.path, file]));
  for (const { path, before } of diff ?? []) {
    if (before === null) original.delete(path);
    else original.set(path, { path, contents: before });
  }
  return new Set(
    [...original.values()].flatMap((file) => {
      const id = readDraftIdentity(file, "state/")?.id;
      return id == null ? [] : [id];
    }),
  );
}

export function newFileContents(
  path: string,
  root: WorldDocumentRoot,
  files: readonly ContentTreeFile[],
): string {
  const codec = path.startsWith(root) ? documentCodec(path) : null;
  if (codec === null) return "";

  const occupiedIds = new Set<string>();
  const occupiedRefs = new Set<string>();
  for (const file of files) {
    const identity = readDraftIdentity(file, root);
    if (identity?.id != null) occupiedIds.add(identity.id);
    if (identity?.ref != null) occupiedRefs.add(identity.ref);
  }

  let id: string;
  do {
    id = `doc.${browserUUID().replaceAll("-", "")}`;
  } while (occupiedIds.has(id));

  const filename = path.slice(path.lastIndexOf("/") + 1);
  const stem = filename.slice(0, filename.lastIndexOf("."));
  const slug = stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const refStem = slug || "document";
  const refHint = (/^[a-z]./u.test(refStem) ? refStem : `doc-${refStem}`)
    .slice(0, maxShortRefLength)
    .replace(/-$/u, "");
  const title =
    [...stem.replace(/\s+/gu, " ").trim()]
      .slice(0, 120)
      .join("")
      .trimEnd()
      .replace(/(?:^| )#+$/u, "") || uiText("新文档");
  const header = stringify({
    $document: {
      id,
      ref: nextAvailableShortRef(refHint, occupiedRefs),
      title,
      summary: uiText("用一句话概括这份文档。"),
      aliases: [],
    },
  });
  return codec === "markdown"
    ? `---\n${header}---\n\n# ${title}\n\n`
    : `${header}\n`;
}
