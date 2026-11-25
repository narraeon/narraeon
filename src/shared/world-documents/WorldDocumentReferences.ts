import { isMap, isSeq } from "yaml";
import type {
  InternalDocumentEntry,
  InternalReference,
} from "./WorldDocumentCodec.ts";
import {
  copyLocator,
  diagnostic,
  freeze,
  groupBy,
  isRecord,
  joinedNodeRange,
  locatorStartsWith,
  nodeRange,
  scalarEquals,
  scalarString,
  type SourceRangeReader,
} from "./WorldDocumentSource.ts";
import type {
  WorldDocumentDescriptor,
  WorldDocumentSelectNodeResult,
  WorldDocumentSourceRange,
  WorldDocumentValue,
} from "./WorldDocumentTypes.ts";

export function diagnoseDuplicateHeaders(
  entries: readonly InternalDocumentEntry[],
): void {
  const withDescriptors = entries.filter(
    (
      entry,
    ): entry is InternalDocumentEntry & {
      descriptor: WorldDocumentDescriptor;
    } => entry.descriptor !== undefined,
  );
  for (const entries of groupBy(
    withDescriptors,
    ({ descriptor }) => descriptor.documentId,
  ).values()) {
    if (entries.length < 2) continue;
    for (const entry of entries)
      entry.diagnostics.push(
        diagnostic({
          code: "document_identity_duplicate",
          logicalPath: entry.file.path,
          documentId: entry.descriptor.documentId,
          ...(entry.headerRanges?.documentId === undefined
            ? {}
            : { range: entry.headerRanges.documentId }),
          message: "Document identity must be unique within the snapshot",
        }),
      );
  }
  for (const entries of groupBy(
    withDescriptors,
    ({ descriptor }) => descriptor.shortRef,
  ).values()) {
    if (entries.length < 2) continue;
    for (const entry of entries)
      entry.diagnostics.push(
        diagnostic({
          code: "document_short_ref_duplicate",
          logicalPath: entry.file.path,
          documentId: entry.descriptor.documentId,
          ...(entry.headerRanges?.shortRef === undefined
            ? {}
            : { range: entry.headerRanges.shortRef }),
          message:
            "Document short reference must be unique within the snapshot",
        }),
      );
  }
}

export function diagnoseReferences(
  entries: readonly InternalDocumentEntry[],
): void {
  const byId = groupBy(
    entries.filter(
      (
        entry,
      ): entry is InternalDocumentEntry & {
        descriptor: WorldDocumentDescriptor;
      } => entry.descriptor !== undefined,
    ),
    ({ descriptor }) => descriptor.documentId,
  );
  for (const entry of entries) {
    for (const reference of entry.references) {
      if (
        reference.targetId !== null &&
        byId.get(reference.targetId)?.length === 1
      )
        continue;
      entry.diagnostics.push(
        diagnostic({
          code: "document_reference_invalid",
          logicalPath: entry.file.path,
          ...(entry.descriptor === undefined
            ? {}
            : { documentId: entry.descriptor.documentId }),
          locator: reference.locator,
          range: reference.range,
          message:
            "An explicit $ref must uniquely identify a whole document in the snapshot",
        }),
      );
    }
  }
}

export function uniqueDocumentDescriptors(
  entries: readonly InternalDocumentEntry[],
): ReadonlyMap<string, WorldDocumentDescriptor> {
  const descriptors = entries.flatMap(({ descriptor }) =>
    descriptor === undefined ? [] : [descriptor],
  );
  return new Map(
    [...groupBy(descriptors, ({ documentId }) => documentId).entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([documentId, matches]) => [documentId, matches[0]!] as const),
  );
}

export function selectYamlReferences(
  entry: InternalDocumentEntry,
  locator: { readonly yaml: readonly (string | number)[] },
  descriptors: ReadonlyMap<string, WorldDocumentDescriptor>,
): WorldDocumentSelectNodeResult["references"] {
  return entry.references.flatMap((reference) => {
    if (
      reference.targetId === null ||
      !("yaml" in reference.locator) ||
      !locatorStartsWith(reference.locator.yaml, locator.yaml)
    )
      return [];
    const target = descriptors.get(reference.targetId);
    return target === undefined
      ? []
      : [
          freeze({
            locator: copyLocator(reference.locator),
            target,
          }),
        ];
  });
}

export function inspectYamlReferences(
  entry: InternalDocumentEntry,
  node: unknown,
  locator: readonly (string | number)[],
  rangeAt: SourceRangeReader,
): void {
  if (isMap(node)) {
    const refPair = node.items.find(({ key }) => scalarEquals(key, "$ref"));
    if (refPair !== undefined) {
      const target = scalarString(refPair.value);
      const startNode = refPair.key;
      const endNode = refPair.value ?? refPair.key;
      entry.references.push({
        targetId: node.items.length === 1 ? target : null,
        locator: freeze({ yaml: freeze([...locator]) }),
        range: joinedNodeRange(rangeAt, startNode, endNode, 0),
        valueRange: nodeRange(rangeAt, refPair.value ?? refPair.key, 0),
      });
      return;
    }
    for (const pair of node.items) {
      const key = scalarString(pair.key);
      if (key === null) {
        entry.diagnostics.push(
          diagnostic({
            code: "yaml_invalid",
            logicalPath: entry.file.path,
            ...(entry.descriptor === undefined
              ? {}
              : { documentId: entry.descriptor.documentId }),
            range: nodeRange(rangeAt, pair.key, 0),
            message: "YAML map keys must be strings",
          }),
        );
        continue;
      }
      if (locator.length === 0 && key === "$document") continue;
      inspectYamlReferences(entry, pair.value, [...locator, key], rangeAt);
    }
    return;
  }
  if (isSeq(node))
    node.items.forEach((child, index) =>
      inspectYamlReferences(entry, child, [...locator, index], rangeAt),
    );
}

export function projectExplicitReferenceValues(
  source: string,
  selectedRange: WorldDocumentSourceRange,
  references: readonly InternalReference[],
  descriptors: ReadonlyMap<string, WorldDocumentDescriptor>,
  quoteProjection = false,
): string {
  const selectedStart = selectedRange.start.offset;
  const selectedEnd = selectedRange.end.offset;
  const replacements = references
    .flatMap((reference) => {
      const descriptor =
        reference.targetId === null
          ? undefined
          : descriptors.get(reference.targetId);
      const start = Math.max(selectedStart, reference.valueRange.start.offset);
      const end = Math.min(selectedEnd, reference.valueRange.end.offset);
      return start < end
        ? [
            {
              start,
              end,
              projection:
                descriptor === undefined
                  ? quoteProjection
                    ? JSON.stringify("(invalid document reference)")
                    : "(invalid document reference)"
                  : quoteProjection
                    ? JSON.stringify(`@${descriptor.shortRef}`)
                    : `@${descriptor.shortRef}`,
            },
          ]
        : [];
    })
    .sort((left, right) => left.start - right.start);
  let cursor = selectedStart;
  let projected = "";
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    projected += source.slice(cursor, replacement.start);
    projected += replacement.projection;
    cursor = replacement.end;
  }
  return projected + source.slice(cursor, selectedEnd);
}

export function projectYamlValue(
  value: unknown,
  documents: ReadonlyMap<string, WorldDocumentDescriptor>,
): WorldDocumentValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return freeze(value.map((child) => projectYamlValue(child, documents)));
  if (isRecord(value)) {
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      const target = documents.get(value.$ref);
      if (target !== undefined)
        return freeze({
          $ref: value.$ref,
          target: freeze({
            documentId: target.documentId,
            shortRef: target.shortRef,
            title: target.title,
          }),
        });
    }
    return freeze(
      Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$document")
          .map(([key, child]) => [key, projectYamlValue(child, documents)]),
      ),
    );
  }
  return null;
}
