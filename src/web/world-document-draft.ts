import { parseDocument, stringify } from "yaml";

import type { ContentTreeFile } from "../protocol/v1.ts";
import {
  documentCodec,
  markdownFrontMatter,
  maxShortRefLength,
  nextAvailableShortRef,
} from "../shared/world-document-format.ts";
import { browserUUID } from "./browser-uuid.ts";
import { uiText } from "./i18n.ts";

export function newFileContents(
  path: string,
  root: "world/" | "state/",
  files: readonly ContentTreeFile[],
): string {
  const codec = path.startsWith(root) ? documentCodec(path) : null;
  if (codec === null) return "";

  const occupiedIds = new Set<string>();
  const occupiedRefs = new Set<string>();
  for (const file of files) {
    if (file.encoding !== undefined || !file.path.startsWith(root)) continue;
    const existingCodec = documentCodec(file.path);
    if (existingCodec === null) continue;
    const source =
      existingCodec === "markdown"
        ? markdownFrontMatter(file.contents.replaceAll("\r\n", "\n"))
        : file.contents;
    // Read scalar nodes directly so an incomplete body or other draft errors
    // do not hide readable identifiers or require evaluating YAML aliases.
    const document = parseDocument(source);
    const id: unknown = document.getIn(["$document", "id"]);
    const ref: unknown = document.getIn(["$document", "ref"]);
    if (typeof id === "string") occupiedIds.add(id);
    if (typeof ref === "string") occupiedRefs.add(ref);
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
