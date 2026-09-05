import { parseDocument } from "yaml";

import type { ContentTreeFile } from "./ContentTreeFile.ts";
import {
  WorldDocumentStore,
  type WorldDocumentDiagnostic,
  type WorldDocumentDescriptor,
  type WorldDocumentLocator,
} from "../world/WorldDocumentStore.ts";

export type FileNativeContentIssueCode =
  | "binary_world_file"
  | "dangling_reference"
  | "duplicate_id"
  | "duplicate_ref"
  | "invalid_document_header"
  | "invalid_markdown"
  | "invalid_opening"
  | "invalid_player_view"
  | "invalid_world_frame"
  | "unsupported_content_file"
  | "missing_current_situation"
  | "missing_opening"
  | "missing_player_view"
  | "missing_world_frame"
  | "unsafe_yaml";

export interface FileNativeContentIssue {
  code: FileNativeContentIssueCode;
  path: string;
  message: string;
  documentId?: string;
  worldDocumentDiagnostic?: WorldDocumentDiagnostic;
}

export interface FileNativeContentDocument {
  id: string;
  ref: string;
  title: string;
  summary: string;
  aliases: string[];
  path: string;
  codec: "yaml" | "markdown";
}

export interface FileNativeContentInspection {
  status: "usable" | "needs_repair";
  documents: FileNativeContentDocument[];
  issues: FileNativeContentIssue[];
  opening: "valid" | "missing" | "invalid";
  control: {
    worldFrame: "valid" | "missing" | "invalid";
    currentSituation: "valid" | "missing" | "invalid";
    playerView: "valid" | "missing" | "invalid";
  };
  worldDocumentSnapshot: WorldDocumentStore;
}

export function isContentPackageWorldDocumentPath(path: string): boolean {
  return path.startsWith("world/");
}

export function worldDocumentTextRequirement(path: string): string {
  return `World documents must contain UTF-8 YAML or Markdown source: ${path}`;
}

export function inspectContentPackageCurrentTree(
  files: readonly ContentTreeFile[],
  options: {
    requireOpening?: boolean;
    worldDocumentSnapshot?: WorldDocumentStore;
  } = {},
): FileNativeContentInspection {
  const worldDocumentSnapshot =
    options.worldDocumentSnapshot ??
    WorldDocumentStore.open({
      layout: "content_package",
      files,
    });
  if (worldDocumentSnapshot.layout !== "content_package")
    throw new Error(
      "Content-package inspection accepts only content_package document snapshots",
    );
  const snapshotFiles = worldDocumentSnapshot.files;
  const issues: FileNativeContentIssue[] = [];
  const documents = worldDocumentSnapshotDocuments(worldDocumentSnapshot);
  const textFiles = new Map(
    snapshotFiles
      .filter(({ encoding }) => encoding === undefined)
      .map((file) => [file.path, file.contents]),
  );
  const openingFiles = snapshotFiles.filter(
    ({ path }) => path === "opening.md",
  );
  let opening: FileNativeContentInspection["opening"] = "missing";
  if (openingFiles.length === 0) {
    if (options.requireOpening !== false)
      issue(
        issues,
        "missing_opening",
        "opening.md",
        "The content package is missing a root-level opening.md introduction",
      );
  } else if (openingFiles.length > 1) {
    opening = "invalid";
    issue(
      issues,
      "invalid_opening",
      "opening.md",
      "A content package may contain only one root-level opening.md file",
    );
  } else {
    const openingFile = openingFiles[0]!;
    if (
      openingFile.encoding !== undefined ||
      openingFile.contents.trim().length === 0 ||
      Buffer.from(openingFile.contents, "utf8").toString("utf8") !==
        openingFile.contents
    ) {
      opening = "invalid";
      issue(
        issues,
        "invalid_opening",
        "opening.md",
        "The introduction must be non-empty, well-formed UTF-8 text",
      );
    } else opening = "valid";
  }

  const unsupportedPaths = new Set<string>();
  for (const file of snapshotFiles) {
    if (/\.json$/iu.test(file.path)) {
      unsupportedPaths.add(file.path);
      issue(
        issues,
        "unsupported_content_file",
        file.path,
        "The current content package does not accept manifest, seven-field JSON, schema, record, or revision files",
      );
    }
  }
  issues.push(
    ...worldDocumentSnapshot.diagnostics
      .filter(
        ({ logicalPath }) =>
          logicalPath === undefined || !unsupportedPaths.has(logicalPath),
      )
      .map(worldDocumentIssue),
  );

  const index = documentIndex(documents);

  const frameSource = textFiles.get("control/frame.yaml");
  let worldFrame: FileNativeContentInspection["control"]["worldFrame"] =
    "missing";
  let currentSituation: FileNativeContentInspection["control"]["currentSituation"] =
    "missing";
  if (frameSource === undefined) {
    issue(
      issues,
      "missing_world_frame",
      "control/frame.yaml",
      "The content package is missing its world prompt frame",
    );
    issue(
      issues,
      "missing_current_situation",
      "control/frame.yaml",
      "The content package has not bound a current-situation document",
    );
  } else {
    const frame = parseRestrictedYaml(
      "control/frame.yaml",
      frameSource,
      issues,
    );
    if (
      isRecord(frame) &&
      frame.format === "narraeon.world-frame/v1" &&
      Object.keys(frame).every((key) =>
        [
          "format",
          "bindings",
          "instructions",
          "context",
          "maintenance",
        ].includes(key),
      ) &&
      isRecord(frame.bindings) &&
      Object.keys(frame.bindings).length === 1 &&
      validMaintenance(frame)
    ) {
      worldFrame = "valid";
      const binding = isRecord(frame.bindings)
        ? frame.bindings.currentSituation
        : undefined;
      if (typeof binding === "string" && index.resolve(binding) !== undefined)
        currentSituation = "valid";
      else {
        currentSituation = "invalid";
        issue(
          issues,
          "missing_current_situation",
          "control/frame.yaml",
          "The world frame must bind an existing current-situation document",
        );
      }
      validateFrameMarkdownFiles(frame, textFiles, issues);
      validateFrameContext(frame.context, index, worldDocumentSnapshot, issues);
    } else {
      worldFrame = "invalid";
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        "The world-frame format must be narraeon.world-frame/v1",
      );
    }
  }

  const playerSource = textFiles.get("control/player-views.yaml");
  let playerView: FileNativeContentInspection["control"]["playerView"] =
    "missing";
  if (playerSource === undefined) {
    issue(
      issues,
      "missing_player_view",
      "control/player-views.yaml",
      "The content package is missing its player-view control file",
    );
  } else {
    const player = parseRestrictedYaml(
      "control/player-views.yaml",
      playerSource,
      issues,
    );
    const formatProblems =
      isRecord(player) && player.format === "narraeon.player-views/v1"
        ? playerViewProblems(player.views, index)
        : ["The file must begin with format: narraeon.player-views/v1"];
    if (formatProblems.length === 0) {
      playerView = "valid";
    } else {
      playerView = "invalid";
      // A malformed file can produce one problem per item; report enough to
      // act on and say how many were withheld rather than flooding the author.
      for (const problem of formatProblems.slice(
        0,
        maxReportedPlayerViewProblems,
      ))
        issue(
          issues,
          "invalid_player_view",
          "control/player-views.yaml",
          problem,
        );
      if (formatProblems.length > maxReportedPlayerViewProblems)
        issue(
          issues,
          "invalid_player_view",
          "control/player-views.yaml",
          `${formatProblems.length - maxReportedPlayerViewProblems} more player-view issues were omitted`,
        );
    }
  }

  return {
    status: issues.length === 0 ? "usable" : "needs_repair",
    documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
    issues,
    opening,
    control: { worldFrame, currentSituation, playerView },
    worldDocumentSnapshot,
  };
}

function validMaintenance(frame: Record<string, unknown>): boolean {
  try {
    worldMaintenanceSettings(frame);
    return true;
  } catch {
    return false;
  }
}

function worldDocumentSnapshotDocuments(
  snapshot: WorldDocumentStore,
): FileNativeContentDocument[] {
  const documents: FileNativeContentDocument[] = [];
  const pendingDirectories = [""];
  const visitedDirectories = new Set<string>();
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift()!;
    if (visitedDirectories.has(directory)) continue;
    visitedDirectories.add(directory);
    let cursor: string | null = null;
    do {
      const result = snapshot.query({
        kind: "catalog",
        directory,
        limit: 100,
        cursor,
      });
      if (!result.ok || result.kind !== "catalog") {
        throw new Error(
          "The WorldDocumentStore catalog query violated the internal snapshot contract",
        );
      }
      for (const entry of result.entries) {
        if (entry.kind === "directory") {
          const relative = relativeSnapshotPath(snapshot, entry.logicalPath);
          if (relative !== null) pendingDirectories.push(relative);
        } else if (entry.document !== undefined) {
          documents.push(contentDocument(entry.document));
        }
      }
      cursor = result.page.nextCursor;
    } while (cursor !== null);
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function relativeSnapshotPath(
  snapshot: WorldDocumentStore,
  logicalPath: string,
): string | null {
  const prefix = `${snapshot.logicalRoot}/`;
  if (!logicalPath.startsWith(prefix)) return null;
  const relative = logicalPath.slice(prefix.length);
  return relative
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..")
    ? relative
    : null;
}

/**
 * Resolves the handles control files are allowed to address documents by.
 *
 * The prompt compiler already accepts both `@shortRef` and a raw document id,
 * and the model only ever sees the short ref. Resolving both here keeps the
 * self-check from rejecting a frame that compiles and runs perfectly well.
 */
interface ContentDocumentIndex {
  resolve(handle: unknown): FileNativeContentDocument | undefined;
  documents(): readonly FileNativeContentDocument[];
}

function documentIndex(
  documents: readonly FileNativeContentDocument[],
): ContentDocumentIndex {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const byRef = new Map(documents.map((document) => [document.ref, document]));
  return {
    resolve(handle) {
      if (typeof handle !== "string") return undefined;
      return handle.startsWith("@")
        ? byRef.get(handle.slice(1))
        : byId.get(handle);
    },
    documents: () => documents,
  };
}

function contentDocument(
  document: WorldDocumentDescriptor,
): FileNativeContentDocument {
  return {
    id: document.documentId,
    ref: document.shortRef,
    title: document.title,
    summary: document.summary,
    aliases: [...document.aliases],
    path: document.logicalPath,
    codec: document.codec,
  };
}

function worldDocumentIssue(
  diagnostic: WorldDocumentDiagnostic,
): FileNativeContentIssue {
  return {
    code: contentIssueCode(diagnostic),
    path: diagnostic.logicalPath ?? "world",
    message:
      diagnostic.code === "document_reference_invalid"
        ? "An explicit $ref points to a missing document, or the target identity is not unique in the snapshot"
        : diagnostic.message,
    ...(diagnostic.documentId === undefined
      ? {}
      : { documentId: diagnostic.documentId }),
    worldDocumentDiagnostic: diagnostic,
  };
}

function contentIssueCode(
  diagnostic: WorldDocumentDiagnostic,
): FileNativeContentIssueCode {
  switch (diagnostic.code) {
    case "world_document_binary":
      return "binary_world_file";
    case "document_reference_invalid":
      return "dangling_reference";
    case "document_identity_duplicate":
      return "duplicate_id";
    case "document_short_ref_duplicate":
      return "duplicate_ref";
    case "markdown_invalid":
    case "locator_ambiguous":
      return "invalid_markdown";
    case "capacity_exceeded":
    case "yaml_invalid":
      return "unsafe_yaml";
    case "document_header_invalid":
    case "document_identity_invalid":
    case "document_short_ref_invalid":
    case "logical_path_duplicate":
    case "logical_path_invalid":
    case "world_document_codec_unsupported":
    case "cursor_invalid":
    case "document_ambiguous":
    case "document_not_found":
    case "locator_invalid":
    case "locator_not_found":
    case "query_invalid":
      return "invalid_document_header";
  }
}

const maxReportedPlayerViewProblems = 8;

/**
 * Reports where a player view is wrong, not merely that it is.
 *
 * This was one `every` chain returning a boolean, so a dozen distinct mistakes
 * all surfaced as the same sentence and the author had to guess which one it
 * hit. Each check now says which view, which item, and what it actually got.
 */
function playerViewProblems(
  value: unknown,
  index: ContentDocumentIndex,
): string[] {
  if (!Array.isArray(value)) return ["views must be a list of views"];
  const problems: string[] = [];
  for (const [viewIndex, view] of value.entries()) {
    const at = `View ${viewIndex + 1} `;
    if (!isRecord(view)) {
      problems.push(`${at}must be an object`);
      continue;
    }
    const unknownKeys = Object.keys(view).filter(
      (key) => !["id", "title", "items"].includes(key),
    );
    if (unknownKeys.length > 0)
      problems.push(`${at}does not accept fields ${unknownKeys.join(", ")}`);
    if (typeof view.id !== "string")
      problems.push(`${at}is missing a string id`);
    if (typeof view.title !== "string")
      problems.push(`${at}is missing a string title`);
    const named = typeof view.id === "string" ? `View ${view.id} ` : at;
    if (!Array.isArray(view.items)) {
      problems.push(`${named}items must be an array`);
      continue;
    }
    if (view.items.length > 128)
      problems.push(
        `${named}may contain at most 128 items; found ${view.items.length}`,
      );
    for (const [itemIndex, item] of view.items.entries())
      problems.push(
        ...playerViewItemProblems(
          item,
          `${named}item ${itemIndex + 1} `,
          index,
        ),
      );
  }
  return problems;
}

function playerViewItemProblems(
  item: unknown,
  at: string,
  index: ContentDocumentIndex,
): string[] {
  if (!isRecord(item)) return [`${at}must be an object`];
  if (typeof item.id !== "string") return [`${at}is missing a string id`];
  if (typeof item.label !== "string") return [`${at}is missing a string label`];
  if (!isRecord(item.select)) return [`${at}is missing a select object`];
  if (typeof item.select.document !== "string")
    return [`${at}select.document must be an @short-ref or document ID string`];
  const { locator } = item.select;
  if (locator === undefined) return [];
  if (!isRecord(locator) || Object.keys(locator).length !== 1)
    return [`${at}locator must declare exactly one of yaml or markdown`];
  const document = index.resolve(item.select.document);
  if (Array.isArray(locator.yaml)) {
    if (!locator.yaml.every((part) => typeof part === "string"))
      return [`${at}yaml locator entries must all be string map keys`];
    return document !== undefined && document.codec !== "yaml"
      ? [
          `${at}uses a yaml locator for ${document.codec} document ${item.select.document}`,
        ]
      : [];
  }
  if (Array.isArray(locator.markdown)) {
    if (
      !locator.markdown.every(
        (part) => typeof part === "string" && part.length > 0,
      )
    )
      return [
        `${at}markdown locator entries must all be non-empty heading strings`,
      ];
    return document !== undefined && document.codec !== "markdown"
      ? [
          `${at}uses a markdown locator for ${document.codec} document ${item.select.document}`,
        ]
      : [];
  }
  return [`${at}locator must be a yaml or markdown array`];
}

function parseRestrictedYaml(
  path: string,
  source: string,
  issues: FileNativeContentIssue[],
): Record<string, unknown> | undefined {
  if (
    source.includes("\0") ||
    source.includes("\r") ||
    /(^|\s)[&*!][^\s,\]}]+/mu.test(source) ||
    /^\s*<<\s*:/mu.test(source) ||
    /^\.\.\.\s*$/mu.test(source)
  ) {
    issue(
      issues,
      "unsafe_yaml",
      path,
      "YAML uses a forbidden tag, anchor, alias, merge, multi-document stream, or invalid line break",
    );
    return undefined;
  }
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    issue(
      issues,
      "unsafe_yaml",
      path,
      "YAML is not a safe single-document YAML 1.2 core map",
    );
    return undefined;
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value) || exceedsShapeLimit(value)) {
    issue(
      issues,
      "unsafe_yaml",
      path,
      "The YAML root must be a map whose depth and node count stay within the limits",
    );
    return undefined;
  }
  return value;
}

function validateFrameMarkdownFiles(
  frame: Record<string, unknown>,
  files: Map<string, string>,
  issues: FileNativeContentIssue[],
): void {
  const instructions = Array.isArray(frame.instructions)
    ? frame.instructions
    : [];
  for (const entry of instructions) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 1 ||
      typeof entry.markdown !== "string" ||
      entry.markdown.startsWith("/") ||
      entry.markdown.includes("..") ||
      !files.has(`control/${entry.markdown}`)
    ) {
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        "A Markdown block referenced by the world frame is missing or escapes the control directory",
      );
    }
  }
}

function validateFrameContext(
  value: unknown,
  index: ContentDocumentIndex,
  snapshot: WorldDocumentStore,
  issues: FileNativeContentIssue[],
): void {
  if (!Array.isArray(value)) {
    issue(
      issues,
      "invalid_world_frame",
      "control/frame.yaml",
      "World-frame context must be a list of slots",
    );
    return;
  }
  const kinds: string[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 1 ||
      !isRecord(entry.slot) ||
      typeof entry.slot.kind !== "string"
    ) {
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        "Each context entry must contain exactly one valid slot",
      );
      continue;
    }
    // Exactly the kinds FileNativePromptCompiler compiles. history_message
    // was accepted here and rejected there, so a candidate could pass its own
    // self-check and then fail the real Prompt Preview it was meant to predict.
    const allowedKeys: Record<string, string[]> = {
      current_situation: ["kind"],
      additional_materials: ["kind"],
      document: ["kind", "document", "required"],
      node: ["kind", "document", "locator", "required"],
      catalog: ["kind", "directory", "maxEntries", "required"],
      history: ["kind", "recent"],
      reference_targets: ["kind", "from", "maxEntries", "required"],
    };
    const allowed = allowedKeys[entry.slot.kind];
    if (allowed === undefined) {
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        `The world frame contains unknown slot kind ${entry.slot.kind}; available kinds are ${Object.keys(allowedKeys).join(", ")}`,
      );
      continue;
    }
    // Naming the offending key matters: reporting the kind reads as "this slot
    // does not exist" and sends the author off deleting a valid slot.
    const unknownKeys = Object.keys(entry.slot).filter(
      (key) =>
        !allowed.includes(key) && key !== "id" && key !== "advisoryBytes",
    );
    if (unknownKeys.length > 0) {
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        `Slot ${entry.slot.kind} does not accept parameters ${unknownKeys.join(", ")}; it accepts only ${allowed.join(", ")}`,
      );
      continue;
    }
    if (!validSlotParameters(entry.slot, index, snapshot)) {
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        `Invalid world-frame slot parameters: ${entry.slot.kind}`,
      );
      continue;
    }
    if (
      entry.slot.kind === "catalog" &&
      entry.slot.required !== false &&
      catalogDocuments(
        entry.slot.directory as string,
        index.documents(),
        "world",
      ).length === 0
    ) {
      const directory = entry.slot.directory as string;
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        `Required catalog ${directory} has no associated documents; it matches only direct children named world/${directory}/<file>.yaml, .yml, or .md, and dots in file names do not create directories`,
      );
      continue;
    }
    kinds.push(entry.slot.kind);
  }
  for (const required of ["current_situation", "additional_materials"]) {
    if (kinds.filter((kind) => kind === required).length !== 1)
      issue(
        issues,
        "invalid_world_frame",
        "control/frame.yaml",
        `The world frame must contain exactly one ${required} slot`,
      );
  }
}

function validSlotParameters(
  slot: Record<string, unknown>,
  index: ContentDocumentIndex,
  snapshot: WorldDocumentStore,
): boolean {
  if (slot.required !== undefined && typeof slot.required !== "boolean")
    return false;
  if (slot.kind === "current_situation" || slot.kind === "additional_materials")
    return true;
  if (slot.kind === "history")
    return slot.recent === undefined || integerInRange(slot.recent, 1, 32);
  if (slot.kind === "document")
    return index.resolve(slot.document) !== undefined;
  if (slot.kind === "catalog")
    return (
      validRelativeDirectory(slot.directory) &&
      integerInRange(slot.maxEntries, 1, 100)
    );
  if (slot.kind === "reference_targets") {
    const from = isRecord(slot.from)
      ? index.resolve(slot.from.document)
      : undefined;
    return (
      integerInRange(slot.maxEntries, 1, 64) &&
      isRecord(slot.from) &&
      Object.keys(slot.from).length === 2 &&
      Object.keys(slot.from).every((key) =>
        ["document", "locator"].includes(key),
      ) &&
      from !== undefined &&
      isRecord(slot.from.locator) &&
      Object.keys(slot.from.locator).length === 1 &&
      Array.isArray(slot.from.locator.yaml) &&
      slot.from.locator.yaml.every((part) => typeof part === "string") &&
      snapshotHasNode(snapshot, from.id, {
        yaml: slot.from.locator.yaml.filter(
          (part): part is string => typeof part === "string",
        ),
      })
    );
  }
  if (slot.kind === "node") {
    const document = index.resolve(slot.document);
    if (
      document === undefined ||
      !isRecord(slot.locator) ||
      Object.keys(slot.locator).length !== 1
    )
      return false;
    if (Array.isArray(slot.locator.yaml))
      return (
        document.codec === "yaml" &&
        slot.locator.yaml.every((part) => typeof part === "string") &&
        snapshotHasNode(snapshot, document.id, {
          yaml: slot.locator.yaml.filter(
            (part): part is string => typeof part === "string",
          ),
        })
      );
    if (Array.isArray(slot.locator.markdown))
      return (
        document.codec === "markdown" &&
        slot.locator.markdown.every((part) => typeof part === "string") &&
        snapshotHasNode(snapshot, document.id, {
          markdown: slot.locator.markdown.filter(
            (part): part is string => typeof part === "string",
          ),
        })
      );
  }
  return false;
}

function snapshotHasNode(
  snapshot: WorldDocumentStore,
  documentId: string,
  locator: WorldDocumentLocator,
): boolean {
  const result = snapshot.query({
    kind: "select_node",
    document: { documentId },
    locator,
  });
  return result.ok && result.kind === "select_node";
}

function validRelativeDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function catalogDocuments(
  directory: string,
  documents: Iterable<FileNativeContentDocument>,
  root: "world" | "state",
): FileNativeContentDocument[] {
  const prefix = `${root}/${directory}/`;
  return [...documents].filter(
    ({ path }) =>
      path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
  );
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function exceedsShapeLimit(value: unknown): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (depth > 64 || nodes > 100_000) return true;
    if (Array.isArray(candidate))
      return candidate.some((item) => visit(item, depth + 1));
    if (isRecord(candidate))
      return Object.values(candidate).some((item) => visit(item, depth + 1));
    return typeof candidate === "number" && !Number.isFinite(candidate);
  };
  return visit(value, 0);
}

function issue(
  issues: FileNativeContentIssue[],
  code: FileNativeContentIssueCode,
  path: string,
  message: string,
  documentId?: string,
): void {
  issues.push({
    code,
    path,
    message,
    ...(documentId === undefined ? {} : { documentId }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { worldMaintenanceSettings } from "../prompt/WorldMaintenanceReport.ts";
