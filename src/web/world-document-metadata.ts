import {
  isMap,
  isScalar,
  isSeq,
  stringify,
  type CST,
  type Range,
  type Scalar,
} from "yaml";

import { parseRestrictedYamlDocument } from "../shared/restricted-yaml.ts";
import { markdownFrontMatter } from "../shared/world-document-format.ts";
import { scanMarkdownHeadings } from "../shared/world-documents/WorldDocumentCodec.ts";
import { documentIdPattern } from "../shared/world-documents/WorldDocumentSource.ts";

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

type RangedString = Scalar<string> & { range: Range };
type TextField = "title" | "summary" | "ref";
export type MetadataEdit =
  | { field: TextField; value: string }
  | { field: "alias"; index: number; value: string }
  | { field: "appendAlias" }
  | { field: "removeAlias"; index: number };

/** The form changes only value spans in the existing file. */
export function readWorldDocumentMetadata(
  source: string,
  codec: "yaml" | "markdown",
) {
  const yamlStart = codec === "markdown" ? 4 : 0;
  const yaml = codec === "markdown" ? markdownFrontMatter(source) : source;
  if (yaml === "") return null;
  const { document } = parseRestrictedYamlDocument(yaml, {
    rejectRawControlCharacters: true,
    keepSourceTokens: true,
  });
  if (!isMap(document?.contents)) return null;
  const header = document.contents.items[0];
  if (
    !isScalar(header?.key) ||
    header.key.value !== "$document" ||
    !isMap(header.value) ||
    (codec === "markdown" && document.contents.items.length !== 1) ||
    header.value.items.some(
      ({ key }) => !isScalar(key) || !fields.has(key.value),
    )
  )
    return null;

  const id = header.value.get("id", true);
  const ref = header.value.get("ref", true);
  const title = header.value.get("title", true);
  const summary = header.value.get("summary", true);
  const aliasesPair = header.value.items.find(
    ({ key }) => isScalar(key) && key.value === "aliases",
  );
  const aliases = aliasesPair?.value;
  const retired = header.value.get("retired");
  if (
    !isRangedString(id) ||
    id.value.length < 3 ||
    id.value.length > 128 ||
    !documentIdPattern.test(id.value) ||
    !isRangedString(ref) ||
    !isRangedString(title) ||
    !isRangedString(summary) ||
    !isSeq(aliases) ||
    aliases.range === undefined ||
    !aliases.items.every(isRangedString) ||
    (header.value.has("retired") && typeof retired !== "boolean")
  )
    return null;
  const aliasItems = aliases.items;
  const aliasToken = aliases.srcToken;
  if (
    aliasToken?.type !== "flow-collection" &&
    aliasToken?.type !== "block-seq"
  )
    return null;

  const bodyStart = codec === "markdown" ? yamlStart + yaml.length + 5 : 0;
  const headings =
    codec === "markdown"
      ? scanMarkdownHeadings(source, bodyStart).headings
      : [];
  const heading = headings[0];
  if (
    codec === "markdown" &&
    (heading?.level !== 1 ||
      (title.value.trim() !== "" &&
        heading.title.normalize("NFKC") !==
          title.value.trim().normalize("NFKC")) ||
      headings.slice(1).some(({ level }) => level === 1))
  )
    return null;

  const locations = { ref, title, summary };
  const aliasColon = aliasesPair?.srcToken?.sep?.find(
    ({ type }) => type === "map-value-ind",
  );
  const edit = (change: MetadataEdit): string | null => {
    const patch: TextEdit[] = [];
    switch (change.field) {
      case "alias": {
        const alias = aliasItems[change.index];
        if (alias !== undefined && alias.value !== change.value)
          patch.push(replaceScalar(alias, change.value, yaml));
        break;
      }
      case "appendAlias": {
        const last = aliasItems.at(-1);
        if (aliasToken.type === "flow-collection") {
          const position = last?.range[1] ?? aliasToken.start.offset + 1;
          patch.push(insertAt(position, last === undefined ? '""' : ', ""'));
        } else if (last !== undefined) {
          const position = last.range[2];
          const onNewLine = yaml[position - 1] === "\n";
          const prefix = onNewLine ? "" : "\n";
          const suffix = onNewLine || position < yaml.length ? "\n" : "";
          patch.push(
            insertAt(
              position,
              `${prefix}${" ".repeat(aliasToken.indent)}- ""${suffix}`,
            ),
          );
        }
        break;
      }
      case "removeAlias": {
        const alias = aliasItems[change.index];
        if (alias === undefined) break;
        patch.push(replaceScalar(alias, null, yaml));
        if (aliasToken.type === "flow-collection") {
          const comma =
            aliasToken.items[change.index]?.start.find(
              ({ type }) => type === "comma",
            ) ??
            aliasToken.items[change.index + 1]?.start.find(
              ({ type }) => type === "comma",
            );
          if (comma !== undefined) patch.push(removeToken(comma));
        } else {
          const dash = aliasToken.items[change.index]?.start.find(
            ({ type }) => type === "seq-item-ind",
          );
          if (dash === undefined) return null;
          patch.push(removeToken(dash));
          if (aliasItems.length === 1) {
            if (aliasColon === undefined) return null;
            patch.push(
              insertAt(aliasColon.offset + aliasColon.source.length, " []"),
            );
          }
        }
        break;
      }
      case "ref":
      case "title":
      case "summary": {
        const node = locations[change.field];
        if (node.value !== change.value)
          patch.push(replaceScalar(node, change.value, yaml));
      }
    }
    const edits = patch.map(({ start, end, text }) => ({
      start: start + yamlStart,
      end: end + yamlStart,
      text,
    }));
    if (
      change.field === "title" &&
      heading !== undefined &&
      change.value.trim() !== "" &&
      change.value !== title.value
    ) {
      const start = heading.range.start.offset;
      const end = heading.range.end.offset;
      const line = source.slice(start, end);
      const nextHeading = editHeading(line, heading.title, change.value.trim());
      if (nextHeading === null) return null;
      edits.push({ start, end, text: nextHeading });
    }
    const next = edits
      .sort((left, right) => right.start - left.start)
      .reduce(
        (contents, { start, end, text }) =>
          contents.slice(0, start) + text + contents.slice(end),
        source,
      );
    return next;
  };

  return {
    id: id.value,
    title: title.value,
    summary: summary.value,
    ref: ref.value,
    aliases: aliasItems.map((alias) => alias.value),
    edit,
  };
}

const fields = new Set<unknown>([
  "id",
  "ref",
  "title",
  "summary",
  "aliases",
  "retired",
]);

function isRangedString(value: unknown): value is RangedString {
  return (
    isScalar(value) &&
    typeof value.value === "string" &&
    value.range !== undefined
  );
}

function replaceScalar(
  scalar: RangedString,
  value: string | null,
  yaml: string,
): TextEdit {
  const [start, end] = scalar.range;
  const token = scalar.srcToken;
  const text =
    value === null
      ? ""
      : stringify(value, {
          defaultStringType: "QUOTE_DOUBLE",
          doubleQuotedMinMultiLineLength: Infinity,
          lineWidth: 0,
        }).trimEnd();
  if (token?.type !== "block-scalar") return { start, end, text };
  // A block scalar owns its indicator's inline comment and its terminating newline.
  const afterIndicator = token.props.at(1)?.offset ?? end;
  const newline = token.props.find(({ type }) => type === "newline");
  const suffixEnd = newline === undefined ? end : newline.offset + 1;
  const extraBlankLines = /\n([ \t]*\n[\s]*)$/u.exec(token.source)?.[1] ?? "";
  return {
    start,
    end,
    text: text + yaml.slice(afterIndicator, suffixEnd) + extraBlankLines,
  };
}

function removeToken({ offset, source }: CST.SourceToken): TextEdit {
  return { start: offset, end: offset + source.length, text: "" };
}

function insertAt(position: number, text: string): TextEdit {
  return { start: position, end: position, text };
}

function editHeading(
  line: string,
  title: string,
  nextTitle: string,
): string | null {
  const marker = line.indexOf("#");
  const titleStart =
    title === "" ? line.length : line.indexOf(title, marker + 1);
  const separator = titleStart === marker + 1 ? " " : "";
  const prefix = line.slice(0, titleStart) + separator;
  const suffix = line.slice(titleStart + title.length);
  const next = prefix + nextTitle + suffix;
  const matches = (candidate: string) =>
    scanMarkdownHeadings(candidate, 0).headings[0]?.title === nextTitle;
  if (matches(next)) return next;
  // A closing sequence allows a literal hash at the end of the title.
  const withClosing = `${prefix}${nextTitle} #${suffix}`;
  return matches(withClosing) ? withClosing : null;
}
