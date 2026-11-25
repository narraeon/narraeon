import { isMap, isScalar, isSeq } from "yaml";

import {
  exceedsRestrictedYamlShape,
  parseRestrictedYamlDocument,
} from "../shared/restricted-yaml.ts";

export const playerViewControlPath = "control/player-views.yaml";
const playerViewFormat = "narraeon.player-views/v1";

export const blankPlayerViewControl = `format: ${playerViewFormat}\nviews: []\n`;

export type PlayerViewControlLocator =
  | { readonly yaml: readonly string[] }
  | { readonly markdown: readonly string[] };

interface PlayerViewControlItem {
  id: string;
  label: string;
  select: { document: string; locator?: PlayerViewControlLocator };
}

interface PlayerViewControlView {
  id: string;
  title: string;
  items: PlayerViewControlItem[];
}

type ParsedControl =
  | { views: PlayerViewControlView[]; error?: never }
  | { views?: never; error: string };

export function readPlayerViewControl(source: string): ParsedControl {
  try {
    const { document, problems } = parseRestrictedYamlDocument(source, {
      rejectRawControlCharacters: true,
    });
    if (document === undefined)
      return { error: problems[0]?.detail ?? problems[0]?.message ?? "" };
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      isRecord(value) &&
      !exceedsRestrictedYamlShape(value) &&
      value.format === playerViewFormat &&
      Array.isArray(value.views) &&
      value.views.every(isControlView) &&
      uniqueIds(value.views)
    ) {
      return { views: value.views };
    }
  } catch (error) {
    if (error instanceof Error) return { error: error.message };
  }
  return { error: "" };
}

type YamlPath = readonly (string | number)[];
type ControlEdit =
  | { kind: "set"; path: YamlPath; value: string }
  | {
      kind: "set-locator";
      path: YamlPath;
      value: PlayerViewControlLocator;
    }
  | { kind: "delete"; path: YamlPath }
  | { kind: "append"; path: YamlPath; value: unknown }
  | { kind: "move"; path: YamlPath; from: number; to: number };

/** Edit YAML nodes directly so unrelated keys, styles and comments stay attached. */
export function editPlayerViewControl(
  source: string,
  edit: ControlEdit,
): string {
  const { document } = parseRestrictedYamlDocument(source, {
    rejectRawControlCharacters: true,
  });
  if (document === undefined) return source;
  switch (edit.kind) {
    case "set":
      document.setIn(edit.path, edit.value);
      break;
    case "set-locator": {
      const locator: unknown = document.getIn(edit.path, true);
      const codec = "yaml" in edit.value ? "yaml" : "markdown";
      const parts =
        "yaml" in edit.value ? edit.value.yaml : edit.value.markdown;
      const pair = isMap(locator) ? locator.items[0] : undefined;
      if (pair === undefined || !isScalar(pair.key) || !isSeq(pair.value)) {
        document.setIn(edit.path, edit.value);
        break;
      }
      const sequence = pair.value;
      pair.key.value = codec;
      parts.forEach((part, index) => sequence.set(index, part));
      sequence.items.length = parts.length;
      break;
    }
    case "delete":
      document.deleteIn(edit.path);
      break;
    case "append":
      document.addIn(edit.path, edit.value);
      break;
    case "move": {
      const sequence: unknown = document.getIn(edit.path, true);
      if (!isSeq(sequence)) return source;
      const [node] = sequence.items.splice(edit.from, 1);
      sequence.items.splice(edit.to, 0, node);
      break;
    }
  }
  return document.toString({ lineWidth: 0 });
}

function isControlView(value: unknown): value is PlayerViewControlView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.items) &&
    value.items.every(isControlItem) &&
    uniqueIds(value.items)
  );
}

function isControlItem(value: unknown): value is PlayerViewControlItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isRecord(value.select) &&
    typeof value.select.document === "string" &&
    (value.select.locator === undefined || isLocator(value.select.locator))
  );
}

function isLocator(value: unknown): value is PlayerViewControlLocator {
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (Array.isArray(value.yaml)) {
    return value.yaml.every((part: unknown) => typeof part === "string");
  }
  return (
    Array.isArray(value.markdown) &&
    value.markdown.every(
      (part: unknown) => typeof part === "string" && part.length > 0,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueIds(entries: readonly { id: string }[]): boolean {
  return new Set(entries.map(({ id }) => id)).size === entries.length;
}
