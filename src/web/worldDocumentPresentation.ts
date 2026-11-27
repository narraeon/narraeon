import { isMap, stringify } from "yaml";

import type { ContentTreeFile } from "../protocol/v1.ts";
import { parseRestrictedYamlDocument } from "../shared/restricted-yaml.ts";
import {
  documentCodec,
  markdownFrontMatter,
  maxShortRefLength,
} from "../shared/world-document-format.ts";
import {
  inspectDocumentFile,
  scanMarkdownHeadings,
} from "../shared/world-documents/WorldDocumentCodec.ts";
import {
  scalarEquals,
  scalarString,
  shortRefPattern,
} from "../shared/world-documents/WorldDocumentSource.ts";
import type { WorldDocumentDescriptor } from "../shared/world-documents/WorldDocumentTypes.ts";

interface WorldDocumentHeader {
  title: string | null;
  summary: string | null;
  ref: string | null;
}

const noHeader: WorldDocumentHeader = { title: null, summary: null, ref: null };

export function readWorldDocumentHeader(
  file: ContentTreeFile,
): WorldDocumentHeader {
  if (file.encoding !== undefined) return noHeader;
  const codec = documentCodec(file.path);
  if (codec === null) return noHeader;
  const source =
    codec === "markdown"
      ? markdownFrontMatter(file.contents)
      : yamlMetadataSource(file.contents);
  if (source === "") return noHeader;

  try {
    const { document } = parseRestrictedYamlDocument(source, {
      rejectRawControlCharacters: true,
    });
    const first = isMap(document?.contents) ? document.contents.items[0] : null;
    if (!scalarEquals(first?.key, "$document") || !isMap(first?.value))
      return noHeader;

    const title = scalarString(first.value.get("title", true));
    const summary = scalarString(first.value.get("summary", true));
    const ref = scalarString(first.value.get("ref", true));
    return {
      title: title?.trim() ? title : null,
      summary,
      ref:
        ref !== null &&
        ref.length >= 2 &&
        ref.length <= maxShortRefLength &&
        shortRefPattern.test(ref)
          ? ref
          : null,
    };
  } catch {
    // Incomplete source remains reachable by path.
    return noHeader;
  }
}

const presentations = new WeakMap<
  ContentTreeFile,
  WorldDocumentHeader & { title: string }
>();

export function worldDocumentPresentation(file: ContentTreeFile) {
  const previous = presentations.get(file);
  if (previous !== undefined) return previous;
  const header = readWorldDocumentHeader(file);
  const heading =
    header.title === null &&
    file.encoding === undefined &&
    documentCodec(file.path) === "markdown"
      ? scanMarkdownHeadings(file.contents, 0).headings.find(
          ({ level }) => level === 1,
        )?.title
      : undefined;
  const presentation = {
    ...header,
    title: header.title ?? heading ?? file.path.split("/").at(-1) ?? file.path,
  };
  presentations.set(file, presentation);
  return presentation;
}

type WorldDocumentReading =
  | {
      kind: "markdown" | "yaml";
      text: string;
      identity: WorldDocumentDescriptor;
    }
  | { kind: "source"; text: string; identity?: WorldDocumentDescriptor };

export function readWorldDocumentBody(
  file: ContentTreeFile,
): WorldDocumentReading {
  const source: WorldDocumentReading = { kind: "source", text: file.contents };
  try {
    const entry = inspectDocumentFile(
      { ...file, path: `state/${file.path}` },
      "state",
    );
    const identity = entry.descriptor;
    if (identity !== undefined && entry.diagnostics.length === 0) {
      if (entry.markdown !== undefined)
        return {
          kind: "markdown",
          text: file.contents.slice(entry.markdown.bodyStart),
          identity,
        };
      if (entry.yaml !== undefined)
        return {
          kind: "yaml",
          text:
            Object.keys(entry.yaml.body).length === 0
              ? ""
              : stringify(entry.yaml.body, { lineWidth: 0 }),
          identity,
        };
    }
    return identity === undefined ? source : { ...source, identity };
  } catch {
    // A parser failure must still leave the exact original readable.
    return source;
  }
}

// For a block-format header, leave the rest of a large YAML draft out of the
// title and short-reference index.
function yamlMetadataSource(source: string): string {
  const opening =
    /^(?:[ \t]*(?:#[^\n]*)?\n)*\$document:[ \t]*(?:#[^\n]*)?\n/u.exec(source);
  if (opening === null) return source;
  const nextEntry = /^[^\s#]/gmu;
  nextEntry.lastIndex = opening[0].length;
  const end = nextEntry.exec(source)?.index;
  return end === undefined ? source : source.slice(0, end);
}
