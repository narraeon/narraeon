import { stringify } from "yaml";
import type { WorldDocumentValue } from "./WorldDocumentStore.ts";

/** Shared public YAML rendering; references keep their handle without expansion. */
export function renderWorldYamlSource(
  value: WorldDocumentValue,
  options: { blockQuote?: boolean } = {},
): string {
  return stringify(publicValue(value), {
    indent: 2,
    lineWidth: 0,
    ...options,
  }).trimEnd();
}

function publicValue(value: WorldDocumentValue): unknown {
  if (Array.isArray(value)) return value.map(publicValue);
  if (record(value)) {
    if (
      Object.keys(value).length === 2 &&
      typeof value.$ref === "string" &&
      record(value.target) &&
      typeof value.target.shortRef === "string"
    )
      return { $ref: `@${value.target.shortRef}` };
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, publicValue(child)]),
    );
  }
  return value;
}

function record(
  value: WorldDocumentValue | undefined,
): value is Readonly<Record<string, WorldDocumentValue>> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
