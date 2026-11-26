import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type {
  OrchestrationSurface,
  V1OrchestrationChangeSet,
  V1OrchestrationEntry,
} from "../../protocol/orchestrationSession.ts";
import { orchestrationManifest } from "../../shared/application-preset-files.ts";
import { builtinAuthorPrompts } from "../../shared/ordered-author-prompts.ts";
import {
  builtinPlayPrompts,
  isPromptMessageRole,
  isTurnGuideLine,
  orderedPromptScope,
  orderedPromptTurnGuide,
  type BuiltinPlayPrompt,
  type OrderedPlayPrompt,
} from "../../shared/ordered-play-prompts.ts";
import { customizePromptArrangement } from "../../shared/prompt-arrangement.ts";
import {
  parseOrderedAuthorPrompts,
  parsePlayPresetFiles,
  toPlayPresetStructuredEditor,
} from "../play/FileNativePlayPresetStore.ts";
import { parseOrderedPlayPrompts } from "../play/OrderedPlayPrompts.ts";

export type EditorEntries = Record<OrchestrationSurface, OrderedPlayPrompt[]>;

export interface EntryRead {
  surface: OrchestrationSurface;
  entryId: string;
  length: number;
  ranges: [number, number][];
}

export const editorSurfaces = ["playPrompts", "authorPrompts"] as const;

export function readEditorEntries(
  files: Record<string, string>,
): EditorEntries {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  const editor = toPlayPresetStructuredEditor(parsed.definition);
  return {
    playPrompts: editor.playPrompts!,
    authorPrompts: editor.authorPrompts!,
  };
}

export function promptCatalog(
  surface: OrchestrationSurface,
  locale: AppLocale,
) {
  return surface === "playPrompts"
    ? builtinPlayPrompts(locale)
    : builtinAuthorPrompts(locale);
}

export function editorEntry(
  entry: OrderedPlayPrompt,
  index: number,
  catalog: readonly BuiltinPlayPrompt[],
  displayWorld: string,
): V1OrchestrationEntry {
  const builtin =
    entry.kind === "builtin"
      ? catalog.find(({ id }) => id === entry.builtin)
      : undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    name:
      builtin?.name ??
      (entry.kind === "world"
        ? displayWorld
        : "name" in entry
          ? entry.name
          : entry.id),
    text:
      entry.kind === "user" || entry.kind === "tail"
        ? entry.body
        : (builtin?.body ?? ""),
    enabled: entry.kind === "world" || entry.enabled,
    messageRole: entry.kind === "tail" ? null : (entry.messageRole ?? "system"),
    turnGuide: orderedPromptTurnGuide(entry, catalog) ?? null,
    turnGuideOverride: "turnGuide" in entry ? (entry.turnGuide ?? null) : null,
    gameplay: orderedPromptScope(entry, catalog) ?? null,
    index,
  };
}

export interface EditorMove {
  entryId: string;
  crossedEntryIds: string[];
}

export function editorEntryDiff(input: {
  before: readonly OrderedPlayPrompt[];
  after: readonly OrderedPlayPrompt[];
  surface: OrchestrationSurface;
  locale: AppLocale;
  moves: readonly EditorMove[];
}): V1OrchestrationChangeSet["entries"] {
  const { before, after, surface, locale, moves } = input;
  const catalog = promptCatalog(surface, locale);
  const name =
    locale === "zh-CN" ? "完整世界提示占位" : "Full world prompt placeholder";
  const indexed = (arrangement: readonly OrderedPlayPrompt[]) =>
    new Map(arrangement.map((entry, index) => [entry.id, { entry, index }]));
  const left = indexed(before);
  const right = indexed(after);
  const moved = netMovedEntries(moves, left, right);
  const entries: V1OrchestrationChangeSet["entries"] = [];
  for (const entryId of new Set([...left.keys(), ...right.keys()])) {
    const oldEntry = left.get(entryId);
    const newEntry = right.get(entryId);
    const positionMoved = moved.has(entryId);
    if (!positionMoved && isDeepStrictEqual(oldEntry?.entry, newEntry?.entry))
      continue;
    const old =
      oldEntry === undefined
        ? null
        : editorEntry(oldEntry.entry, oldEntry.index, catalog, name);
    const next =
      newEntry === undefined
        ? null
        : editorEntry(newEntry.entry, newEntry.index, catalog, name);
    if (
      old === null ||
      next === null ||
      positionMoved ||
      !isDeepStrictEqual({ ...old, index: next.index }, next)
    )
      entries.push({
        surface,
        entryId,
        before: old,
        after: next,
        ...(positionMoved ? { moved: true } : {}),
      });
  }
  return entries;
}

function netMovedEntries(
  moves: readonly EditorMove[],
  before: ReadonlyMap<string, { index: number }>,
  after: ReadonlyMap<string, { index: number }>,
): Set<string> {
  const moved = new Set<string>();
  const seenPairs = new Set<string>();
  // Attribute each surviving reversal to the last explicit move that crossed
  // the pair. Insertions, removals and undone crossings leave no reversal.
  for (const { entryId, crossedEntryIds } of moves.toReversed()) {
    const oldIndex = before.get(entryId)?.index;
    const newIndex = after.get(entryId)?.index;
    if (oldIndex === undefined || newIndex === undefined) continue;
    for (const crossed of crossedEntryIds) {
      const oldNeighbor = before.get(crossed)?.index;
      const newNeighbor = after.get(crossed)?.index;
      if (oldNeighbor === undefined || newNeighbor === undefined) continue;
      const key =
        entryId < crossed ? `${entryId}\0${crossed}` : `${crossed}\0${entryId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const wasBeforeNeighbor = oldIndex < oldNeighbor;
      const isBeforeNeighbor = newIndex < newNeighbor;
      if (wasBeforeNeighbor !== isBeforeNeighbor) moved.add(entryId);
    }
  }
  return moved;
}

export function writeEditorEntries(
  files: Record<string, string>,
  before: EditorEntries,
  after: EditorEntries,
): Record<string, string> {
  const source = files[orchestrationManifest];
  if (source === undefined)
    throw new Error("The orchestration manifest is missing");
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  for (const surface of editorSurfaces) {
    if (isDeepStrictEqual(before[surface], after[surface])) continue;
    const play = surface === "playPrompts";
    const entries = play
      ? parseOrderedPlayPrompts(after[surface])
      : parseOrderedAuthorPrompts(after[surface]);
    document.set(
      surface,
      customizePromptArrangement(entries, promptCatalog(surface, "en"), play),
    );
  }
  const next = { ...files, [orchestrationManifest]: document.toString() };
  const parsed = parsePlayPresetFiles(next);
  if (parsed.kind === "invalid") throw parsed.error;
  return next;
}

export type EditOperationKind =
  "create" | "update" | "move" | "delete" | "replace_builtin";

export interface EditOperation {
  operationId: string;
  op: EditOperationKind;
  entryId: string;
  newEntryId?: string;
  kind?: "user" | "tail";
  name?: string;
  body?: string;
  enabled?: boolean;
  messageRole?: "system" | "user" | "assistant";
  turnGuide?: string;
  restoreTurnGuide?: boolean;
  gameplay?: "tabletop" | "all";
  beforeId?: string;
  afterId?: string;
  provenance?: unknown;
}

const editFields = {
  operationId: {
    type: "string",
    description: "Unique operation identity for this orchestration response.",
  },
  entryId: {
    type: "string",
    description:
      "Stable block identity. For create, choose a new unique identity.",
  },
  op: {
    type: "string",
    enum: ["create", "update", "move", "delete", "replace_builtin"],
  },
  newEntryId: {
    type: "string",
    description: "New user block identity required by replace_builtin.",
  },
  kind: { type: "string", enum: ["user", "tail"] },
  name: { type: "string" },
  body: { type: "string" },
  enabled: { type: "boolean" },
  messageRole: { type: "string", enum: ["system", "user", "assistant"] },
  turnGuide: {
    type: "string",
    description:
      "Single static line. An empty string explicitly clears a builtin's line.",
  },
  restoreTurnGuide: {
    type: "boolean",
    description:
      "Set true to remove an override and restore the builtin default.",
  },
  gameplay: { type: "string", enum: ["tabletop", "all"] },
  beforeId: {
    type: "string",
    description: "Anchor identity. Use beforeId OR afterId.",
  },
  afterId: {
    type: "string",
    description: "Anchor identity. Use beforeId OR afterId.",
  },
};

type OperationProperties = Record<string, object>;

export function editOperationsSchema(provenance?: object) {
  const properties: OperationProperties = { ...editFields };
  if (provenance !== undefined) properties.provenance = provenance;
  return {
    type: "array",
    minItems: 1,
    maxItems: 32,
    items: {
      type: "object",
      properties,
      required: ["operationId", "op", "entryId"],
      additionalProperties: false,
    },
  };
}

const editableFields: Record<
  EditOperationKind,
  readonly (keyof EditOperation)[]
> = {
  create: [
    "kind",
    "name",
    "body",
    "enabled",
    "messageRole",
    "turnGuide",
    "gameplay",
    "beforeId",
    "afterId",
    "provenance",
  ],
  update: [
    "name",
    "body",
    "enabled",
    "messageRole",
    "turnGuide",
    "restoreTurnGuide",
    "gameplay",
    "provenance",
  ],
  move: ["beforeId", "afterId"],
  delete: [],
  replace_builtin: ["newEntryId", "name", "body", "provenance"],
};

export function parseEditOperation(value: unknown): EditOperation {
  const op = record(value);
  if (
    !Object.hasOwn(editableFields, String(op.op)) ||
    !validId(op.entryId) ||
    !validId(op.operationId)
  )
    throw new Error(
      "Invalid operation, stable entry identity, or operation identity",
    );
  const allowed = new Set([
    "op",
    "entryId",
    "operationId",
    ...editableFields[op.op as EditOperationKind],
  ]);
  if (Object.keys(op).some((key) => !allowed.has(key)))
    throw new Error("An operation contains a field outside its permissions");
  for (const field of ["newEntryId", "beforeId", "afterId"] as const)
    if (op[field] !== undefined && !validId(op[field]))
      throw new Error(`Invalid ${field}`);
  if (op.beforeId !== undefined && op.afterId !== undefined)
    throw new Error("Supply a single positioning anchor");
  if (
    op.name !== undefined &&
    (typeof op.name !== "string" ||
      !op.name.trim() ||
      /[\r\n\0]/u.test(op.name) ||
      op.name.length > 160)
  )
    throw new Error("Invalid prompt name");
  if (
    op.body !== undefined &&
    (typeof op.body !== "string" || op.body.length > 256 * 1024)
  )
    throw new Error("Invalid prompt body");
  if (op.enabled !== undefined && typeof op.enabled !== "boolean")
    throw new Error("Invalid enabled value");
  if (
    op.restoreTurnGuide !== undefined &&
    (op.restoreTurnGuide !== true || op.turnGuide !== undefined)
  )
    throw new Error(
      "Use restoreTurnGuide: true by itself to restore a builtin default",
    );
  if (
    op.turnGuide !== undefined &&
    (typeof op.turnGuide !== "string" || !isTurnGuideLine(op.turnGuide))
  )
    throw new Error("The turn guide must contain one line");
  if (op.messageRole !== undefined && !isPromptMessageRole(op.messageRole))
    throw new Error("Invalid message role");
  if (
    op.gameplay !== undefined &&
    op.gameplay !== "tabletop" &&
    op.gameplay !== "all"
  )
    throw new Error("Invalid gameplay scope");
  if (op.kind !== undefined && op.kind !== "user" && op.kind !== "tail")
    throw new Error("Invalid new prompt kind");
  return op as unknown as EditOperation;
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}

export function editorSurface(value: unknown): OrchestrationSurface {
  if (value === "playPrompts" || value === "authorPrompts") return value;
  throw new Error("Choose playPrompts or authorPrompts");
}

export function applyEditOperation(input: {
  entries: OrderedPlayPrompt[];
  operation: EditOperation;
  catalog: readonly BuiltinPlayPrompt[];
  surface: OrchestrationSurface;
  wasRead: (entryId: string) => boolean;
}): EditorMove | undefined {
  const { entries, operation: op, catalog, surface } = input;
  const index = entries.findIndex(({ id }) => id === op.entryId);
  const existing = entries[index];
  if (
    surface === "authorPrompts" &&
    (op.kind === "tail" ||
      op.turnGuide !== undefined ||
      op.restoreTurnGuide !== undefined)
  )
    throw new Error("Author prompts have no per-dispatch turn guide");

  if (op.op === "create") {
    if (
      existing !== undefined ||
      !op.kind ||
      !op.name ||
      op.body === undefined ||
      op.enabled === undefined
    )
      throw new Error(
        "Create needs a unique entryId, kind, name, body and enabled",
      );
    const fields = {
      id: op.entryId,
      name: op.name,
      body: op.body,
      enabled: op.enabled,
    };
    const entry: OrderedPlayPrompt =
      op.kind === "tail"
        ? { kind: "tail", ...fields }
        : { kind: "user", ...fields, ...userSettings(op) };
    if (entry.kind === "tail") assertTailProperties(op, entry.body);
    insertEntry(entries, op, entry);
    return;
  }

  if (existing === undefined || !input.wasRead(existing.id))
    throw new Error(
      `Read the complete current entry ${op.entryId} before editing it`,
    );

  switch (op.op) {
    case "delete":
      if (existing.kind !== "user" && existing.kind !== "tail")
        throw new Error("Only user and tail blocks can be deleted");
      entries.splice(index, 1);
      break;
    case "move": {
      if (op.beforeId === undefined && op.afterId === undefined)
        throw new Error("Move needs a stable adjacent entry ID");
      entries.splice(index, 1);
      const inserted = insertEntry(entries, op, existing);
      const crossed =
        index < inserted
          ? entries.slice(index, inserted)
          : entries.slice(inserted + 1, index + 1);
      return {
        entryId: existing.id,
        crossedEntryIds: crossed.map(({ id }) => id),
      };
    }
    case "update":
      entries[index] = updateEntry(entries, existing, op, catalog);
      break;
    case "replace_builtin": {
      if (existing.kind !== "builtin")
        throw new Error("replace_builtin requires a live replaceable builtin");
      const builtin = catalog.find(({ id }) => id === existing.builtin);
      if (
        !builtin ||
        builtin.required ||
        builtin.dynamic ||
        builtin.id === "author.play-reference"
      )
        throw new Error("Required and dynamic builtins cannot be replaced");
      if (
        !op.newEntryId ||
        entries.some(({ id }) => id === op.newEntryId) ||
        !op.name ||
        !op.body?.trim() ||
        op.body === builtin.body
      )
        throw new Error(
          "Replacement requires a new unique user block ID, name and changed prefix text",
        );
      const line = existing.turnGuide ?? builtin.turnGuide;
      // The disabled builtin remains in the arrangement. The replacement
      // takes its former effective position without shifting other blocks.
      entries.splice(
        index,
        1,
        {
          id: op.newEntryId,
          kind: "user",
          name: op.name,
          body: op.body,
          enabled: existing.enabled,
          ...(existing.messageRole === undefined
            ? {}
            : { messageRole: existing.messageRole }),
          ...(line === undefined ? {} : { turnGuide: line }),
          ...(builtin.gameplay === undefined
            ? {}
            : { gameplay: builtin.gameplay }),
        },
        { ...existing, enabled: false },
      );
      break;
    }
  }
  return undefined;
}

function updateEntry(
  entries: OrderedPlayPrompt[],
  existing: OrderedPlayPrompt,
  op: EditOperation,
  catalog: readonly BuiltinPlayPrompt[],
): OrderedPlayPrompt {
  if (existing.kind === "world") {
    if (
      op.messageRole === undefined ||
      [
        "name",
        "body",
        "enabled",
        "turnGuide",
        "restoreTurnGuide",
        "gameplay",
        "provenance",
      ].some((field) => Object.hasOwn(op, field))
    )
      throw new Error("The world placeholder only supports a send-role update");
    return { ...existing, messageRole: op.messageRole };
  }
  if (existing.kind === "builtin") {
    if (
      ["name", "body", "gameplay", "provenance"].some((field) =>
        Object.hasOwn(op, field),
      )
    )
      throw new Error(
        "Update builtin overrides directly; use replace_builtin for changed prefix text",
      );
    const builtin = catalog.find(({ id }) => id === existing.builtin)!;
    if (
      builtin.required &&
      (op.enabled === false ||
        (op.messageRole !== undefined && op.messageRole !== "system"))
    )
      throw new Error(
        "A required builtin must remain enabled with a System role",
      );
    if (builtin.dynamic && (op.turnGuide !== undefined || op.restoreTurnGuide))
      throw new Error("The model prompt placeholder has no turn guide");
    if (op.enabled === true && builtin.group !== undefined) {
      for (const [index, entry] of entries.entries()) {
        if (
          entry.kind === "builtin" &&
          entry.id !== existing.id &&
          entry.enabled &&
          catalog.find(({ id }) => id === entry.builtin)?.group ===
            builtin.group
        )
          entries[index] = { ...entry, enabled: false };
      }
    }
    const next = {
      ...existing,
      ...(op.enabled === undefined ? {} : { enabled: op.enabled }),
      ...(op.messageRole === undefined ? {} : { messageRole: op.messageRole }),
      ...(op.turnGuide === undefined ? {} : { turnGuide: op.turnGuide }),
    };
    if (op.restoreTurnGuide) delete next.turnGuide;
    return next;
  }
  const fields = {
    name: op.name ?? existing.name,
    body: op.body ?? existing.body,
    enabled: op.enabled ?? existing.enabled,
  };
  if (existing.kind === "tail") {
    assertTailProperties(op, fields.body);
    return { ...existing, ...fields };
  }
  if (op.restoreTurnGuide)
    throw new Error("Only builtins have a default turn-guide line");
  const next = { ...existing, ...fields, ...userSettings(op) };
  if (op.gameplay === "all") delete next.gameplay;
  return next;
}

function userSettings(op: EditOperation) {
  return {
    ...(op.messageRole === undefined ? {} : { messageRole: op.messageRole }),
    ...(op.turnGuide === undefined ? {} : { turnGuide: op.turnGuide }),
    ...(op.gameplay !== "tabletop" ? {} : { gameplay: op.gameplay }),
  };
}

function assertTailProperties(op: EditOperation, body: string): void {
  if (
    op.messageRole !== undefined ||
    op.turnGuide !== undefined ||
    op.restoreTurnGuide ||
    op.gameplay !== undefined ||
    op.provenance !== undefined ||
    !isTurnGuideLine(body)
  )
    throw new Error(
      "Tail blocks allow only name, enabled state and a single body line",
    );
}

function insertEntry(
  entries: OrderedPlayPrompt[],
  op: EditOperation,
  entry: OrderedPlayPrompt,
): number {
  const anchor = op.beforeId ?? op.afterId;
  if (anchor === undefined) {
    entries.push(entry);
    return entries.length - 1;
  }
  const at = entries.findIndex(({ id }) => id === anchor);
  if (at < 0)
    throw new Error(
      "The adjacent entry does not exist in the requested surface",
    );
  const index = at + (op.afterId === undefined ? 0 : 1);
  entries.splice(index, 0, entry);
  return index;
}
