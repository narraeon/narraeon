import type { ContentTreeFile } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

export function worldDocumentPresentation(file: ContentTreeFile): {
  ref: string;
  title: string;
  summary: string;
} {
  const title =
    metadataLine(file.contents, "title") ??
    markdownTitle(file.contents) ??
    leafName(file.path);
  return {
    ref:
      metadataLine(file.contents, "ref") ??
      file.path.replace(/\.[^.]+$/u, "").replaceAll("/", "-"),
    title,
    summary: metadataLine(file.contents, "summary") ?? uiText("暂无摘要"),
  };
}

function metadataLine(contents: string, key: string): string | null {
  const match = new RegExp(`^\\s{2}${key}:\\s*(.+?)\\s*$`, "mu").exec(contents);
  if (match?.[1] === undefined) return null;
  return match[1].replace(/^['"]|['"]$/gu, "").trim();
}

function markdownTitle(contents: string): string | null {
  return /^#\s+(.+)$/mu.exec(contents)?.[1]?.trim() ?? null;
}

function leafName(path: string): string {
  return path.split("/").at(-1) ?? path;
}
