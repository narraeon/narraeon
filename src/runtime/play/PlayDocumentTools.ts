import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { WorldDocumentMaintenance } from "../../protocol/worldMaintenance.ts";
import { renderDocumentWritePosition } from "../prompt/WorldMaintenanceReport.ts";
import { createHash } from "node:crypto";

import { stringify } from "yaml";
import { renderPlayerViewBindings } from "../world/PlayerViewBindings.ts";

import type { ModelHostToolCall } from "../model/ModelHost.ts";

import {
  PromptCompilationError,
  type MaterialSelection,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type { FileNativeStateChange } from "../world/FileNativeWorldStore.ts";
import {
  type WorldDocumentStore,
  type WorldDocumentDescriptor,
  type WorldDocumentLocator,
  type WorldDocumentQueryFailure,
  type WorldDocumentRevisionChange,
  type WorldDocumentRevisionEdit,
  type WorldDocumentValue,
} from "../world/WorldDocumentStore.ts";
import {
  acceptWorldStateRevision,
  beginWorldStateRevision,
  fileNativeStateChanges,
  worldDocumentRevisionFailureMessage,
  type WorldStateRevision,
} from "../world/WorldStateRevision.ts";

export interface PlayDocumentToolResult extends ContextToolResult {
  nextMaterials?: MaterialSelection[];
  /** Internal receipt settled by PlayCallChain only after Authority commits. */
  candidateWrite?: {
    shortRef: string;
    changed: boolean;
    freshContextCoverage?: string;
  };
}

/**
 * Durable proof of which exact world-document scopes the current model context
 * has already seen. The snapshot object itself is process-local, so recovery
 * rebinds this proof only when the complete state tree still has the same
 * deterministic fingerprint.
 */
export interface PlayDocumentAuthorizationCheckpoint {
  readonly schemaVersion: 1;
  readonly kind: "play_document_authorizations";
  readonly stateFingerprint: string;
  readonly documents: readonly {
    readonly shortRef: string;
    readonly locators: readonly WorldDocumentLocator[] | null;
  }[];
}

class PlayDocumentToolFailure extends Error {
  readonly failureKind: "protocol" | "candidate";

  constructor(
    message: string,
    failureKind: "protocol" | "candidate" = "protocol",
  ) {
    super(message);
    this.name = "PlayDocumentToolFailure";
    this.failureKind = failureKind;
  }
}

/**
 * One operation-bound document context for the play call chain. Product flows
 * submit tool calls here; document parsing, identity, lookup, locator semantics
 * and revision mechanics remain behind WorldDocumentStore.open/query/revise.
 */
export class FileNativePlayDocuments {
  readonly #candidate: PlayCandidate;
  #committedSnapshot: WorldDocumentStore;
  #reads: WriteAuthorizations;
  #declaredDirectories: string[] = [];
  #maintenanceLocale: AppLocale = "en";
  #maintenance: Readonly<Record<string, WorldDocumentMaintenance>> = {};

  bindMaintenance(
    facts: Readonly<Record<string, WorldDocumentMaintenance>>,
    locale: AppLocale = "en",
  ): void {
    this.#maintenance = structuredClone(facts);
    this.#maintenanceLocale = locale;
  }

  constructor(files: Readonly<Record<string, string>>) {
    this.#candidate = openPlayCandidate({ ...files });
    this.#committedSnapshot = this.#candidate.snapshot;
    this.#reads = {
      snapshotId: this.#candidate.snapshot.id,
      documents: new Map(),
    };
  }

  get snapshot(): WorldDocumentStore {
    return this.#candidate.snapshot;
  }

  get committedSnapshot(): WorldDocumentStore {
    return this.#committedSnapshot;
  }

  bindBootstrap(bootstrap: PromptCompilation): void {
    this.#reads = bootstrapAuthorizations(bootstrap, this.#candidate.snapshot);
    this.#declaredDirectories = declaredStateDirectories(bootstrap);
  }

  authorizationCheckpoint(): PlayDocumentAuthorizationCheckpoint {
    return {
      schemaVersion: 1,
      kind: "play_document_authorizations",
      stateFingerprint: fingerprintStateFiles(this.#candidate.files),
      documents: [...this.#reads.documents.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([shortRef, locators]) => ({
          shortRef,
          locators:
            locators === null
              ? null
              : locators
                  .filter(
                    (locator, index, all) =>
                      all.findIndex((candidate) =>
                        sameLocator(candidate, locator),
                      ) === index,
                  )
                  .map((locator) => structuredClone(locator)),
        })),
    };
  }

  restoreAuthorizationCheckpoint(
    checkpoint: PlayDocumentAuthorizationCheckpoint,
  ): void {
    if (!isPlayDocumentAuthorizationCheckpoint(checkpoint))
      throw new TypeError(
        "The play-document authorization checkpoint has an invalid format",
      );
    if (
      checkpoint.stateFingerprint !==
      fingerprintStateFiles(this.#candidate.files)
    )
      throw new TypeError(
        "The play-document authorization checkpoint does not match the current state",
      );
    const documents = new Map<string, AuthorizedLocator[] | null>();
    for (const { shortRef, locators } of checkpoint.documents) {
      if (documentDescriptorByRef(this.#candidate.snapshot, shortRef) === null)
        throw new TypeError(
          `The play-document authorization checkpoint refers to missing @${shortRef}`,
        );
      const restoredLocators = locators?.map((locator) => {
        const selected = this.#candidate.snapshot.query({
          kind: "select_node",
          document: { shortRef },
          locator,
        });
        if (selected.kind !== "select_node" || !selected.ok)
          throw new TypeError(
            `The play-document authorization checkpoint refers to a missing node in @${shortRef}`,
          );
        return structuredClone(selected.node.locator);
      });
      documents.set(shortRef, restoredLocators ?? null);
    }
    this.#reads = {
      snapshotId: this.#candidate.snapshot.id,
      documents,
    };
  }

  execute(
    call: ModelHostToolCall,
    history: { path: string; contents: string }[],
  ): PlayDocumentToolResult {
    if (call.name === "context_search")
      return executeContextSearch(
        this.#candidate.snapshot,
        history,
        call.arguments,
      );
    if (call.name === "state_list")
      return executeStateList(
        this.#candidate.snapshot,
        history,
        call.arguments,
        this.#declaredDirectories,
      );
    if (call.name === "history_list")
      return executeHistoryList(
        this.#candidate.snapshot,
        history,
        call.arguments,
      );
    // Frozen contexts created before runtime-tools-v5 retain this exact name
    // and argument shape. New contexts never advertise it.
    if (call.name === "context_list")
      return executeContextList(
        this.#candidate.snapshot,
        history,
        call.arguments,
        this.#declaredDirectories,
      );
    if (call.name === "context_read") {
      const result = executeContextRead(
        this.#candidate.snapshot,
        history,
        call.arguments,
      );
      authorizeToolRead(this.#reads, this.#candidate.snapshot, result);
      const ref = result.readAuthorization?.shortRef;
      if (ref !== undefined && result.markdown !== undefined)
        result.markdown += `\n\n${renderDocumentWritePosition(ref, this.#maintenance[ref], this.#maintenanceLocale)}`;
      return result;
    }
    if (call.name === "world_patch")
      return applyPlayCandidatePatch(
        this.#candidate,
        this.#reads,
        call.arguments,
      );
    if (call.name === "world_create")
      return applyPlayCandidateCreate(
        this.#candidate,
        this.#reads,
        call.arguments,
        this.#declaredDirectories,
      );
    if (call.name === "world_retire")
      return applyPlayCandidateRetirement(
        this.#candidate,
        this.#reads,
        call.arguments,
      );
    return toolFailure(
      `The current document context does not accept ${call.name}`,
    );
  }

  stateChanges(): FileNativeStateChange[] {
    return playCandidateStateChanges(this.#candidate);
  }

  /**
   * The current revision has been accepted by Authority. Keep using the same
   * snapshot and read authorizations, but make subsequent writes relative to
   * this new committed baseline instead of replaying the old diff.
   */
  acceptCommittedState(): void {
    this.#committedSnapshot = this.#candidate.snapshot;
    this.#candidate.changes.clear();
  }
}

type PlayCandidate = WorldStateRevision;

type AuthorizedLocator = WorldDocumentLocator;
interface WriteAuthorizations {
  snapshotId: string;
  documents: Map<string, AuthorizedLocator[] | null>;
}

function bootstrapAuthorizations(
  bootstrap: PromptCompilation,
  snapshot: WorldDocumentStore,
): WriteAuthorizations {
  const result: WriteAuthorizations = {
    snapshotId: snapshot.id,
    documents: new Map(),
  };
  for (const { status, complete, readAuthorization } of bootstrap.coverage) {
    if (status !== "resolved" || !complete || readAuthorization === undefined)
      continue;
    if (readAuthorization.locator === null) {
      const resolved = snapshot.query({
        kind: "read_document",
        document: { shortRef: readAuthorization.shortRef },
      });
      if (resolved.kind === "read_document" && resolved.ok)
        authorizeRead(result, snapshot.id, resolved.document.shortRef, null);
    } else {
      const selected = snapshot.query({
        kind: "select_node",
        document: { shortRef: readAuthorization.shortRef },
        locator: readAuthorization.locator,
      });
      if (selected.kind === "select_node" && selected.ok)
        authorizeRead(
          result,
          snapshot.id,
          selected.document.shortRef,
          selected.node.locator,
        );
    }
  }
  return result;
}

function declaredStateDirectories(bootstrap: PromptCompilation): string[] {
  // Catalog coverage is the durable compiler projection shared by current
  // state_list contexts and legacy context_list contexts.
  return [
    ...new Set(
      bootstrap.coverage
        .filter(({ slot }) => slot === "catalog")
        .map(({ source }) => source)
        .filter(validStateDirectory),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function authorizeRead(
  authorizations: WriteAuthorizations,
  snapshotId: string,
  ref: string,
  locator: AuthorizedLocator | null,
): void {
  if (authorizations.snapshotId !== snapshotId) return;
  if (locator === null) authorizations.documents.set(ref, null);
  else if (authorizations.documents.get(ref) !== null)
    authorizations.documents.set(ref, [
      ...(authorizations.documents.get(ref) ?? []),
      locator,
    ]);
}

function authorizeToolRead(
  authorizations: WriteAuthorizations,
  snapshot: WorldDocumentStore,
  result: ContextToolResult,
): void {
  const authorization = result.readAuthorization;
  if (
    authorization?.snapshotId !== snapshot.id ||
    authorizations.snapshotId !== snapshot.id
  )
    return;
  authorizeRead(
    authorizations,
    snapshot.id,
    authorization.shortRef,
    authorization.locator,
  );
}

function sameLocator(
  left: AuthorizedLocator | null,
  right: AuthorizedLocator | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftPath = "yaml" in left ? left.yaml : left.markdown;
  const rightPath = "yaml" in right ? right.yaml : right.markdown;
  return (
    "yaml" in left === "yaml" in right &&
    leftPath.length === rightPath.length &&
    leftPath.every((segment, index) => segment === rightPath[index])
  );
}

function parseYamlHandleSegment(segment: string): string | number {
  return /^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : segment;
}

function openPlayCandidate(files: Record<string, string>): PlayCandidate {
  return beginWorldStateRevision(files);
}

function documentDescriptorByRef(
  snapshot: WorldDocumentStore,
  ref: string,
): WorldDocumentDescriptor | null {
  const result = snapshot.query({
    kind: "read_document",
    document: { shortRef: ref },
  });
  return result.kind === "read_document" && result.ok ? result.document : null;
}

function applyPlayCandidatePatch(
  candidate: PlayCandidate,
  reads: WriteAuthorizations,
  args: unknown,
): PlayDocumentToolResult {
  if (
    !record(args) ||
    typeof args.target !== "string" ||
    !Array.isArray(args.edits) ||
    args.edits.length < 1 ||
    args.edits.length > 32
  )
    return toolFailure("world_patch requires a target and 1 to 32 edits.");
  const ref = args.target.replace(/^@/u, "");
  const target = documentDescriptorByRef(candidate.snapshot, ref);
  if (target === null) return toolFailure(`Target @${ref} does not exist.`);
  const retainedAuthorization = reads.documents.get(ref);
  if (
    reads.snapshotId !== candidate.snapshot.id ||
    retainedAuthorization === undefined ||
    !editsAreAuthorized(retainedAuthorization, args.edits)
  )
    return toolFailure(
      `Read @${ref} exactly, or receive the complete document in bootstrap, before writing it.`,
    );
  try {
    assertToolReferenceHandles(args.edits);
    const revised = candidate.snapshot.revise({
      commands: [
        {
          kind: "patch",
          document: { documentId: target.documentId },
          edits: args.edits as readonly WorldDocumentRevisionEdit[],
        },
      ],
    });
    if (!revised.ok || revised.snapshotStatus !== "usable")
      throw new PlayDocumentToolFailure(
        worldDocumentRevisionFailureMessage(revised.diagnostics),
        "candidate",
      );
    const changed = revised.changes.length > 0;
    const receipt = formatToolRevisionReceipt(target.shortRef, revised.changes);
    const previousSnapshot = candidate.snapshot;
    acceptWorldStateRevision(candidate, revised);
    carryWriteAuthorizations(
      previousSnapshot,
      candidate,
      reads,
      revised.changes,
    );
    if (retainedAuthorization === null)
      authorizeRead(reads, candidate.snapshot.id, ref, null);
    else
      for (const locator of retainedAuthorization)
        authorizeRead(reads, candidate.snapshot.id, ref, locator);
    return {
      ok: true,
      markdown: receipt,
      candidateWrite: { shortRef: target.shortRef, changed },
    };
  } catch (error: unknown) {
    if (error instanceof PlayDocumentToolFailure)
      return toolFailure(error.message, error.failureKind);
    throw error;
  }
}

function editsAreAuthorized(
  authorization: AuthorizedLocator[] | null | undefined,
  edits: unknown[],
): boolean {
  if (authorization === null) return true;
  if (authorization === undefined) return false;
  return edits.every((edit) => {
    if (!record(edit) || edit.op === "set_metadata" || !record(edit.locator))
      return false;
    const requested = Array.isArray(edit.locator.yaml)
      ? { codec: "yaml", path: edit.locator.yaml }
      : Array.isArray(edit.locator.markdown)
        ? { codec: "markdown", path: edit.locator.markdown }
        : null;
    return (
      requested !== null &&
      authorization.some((allowed) => {
        const path = "yaml" in allowed ? allowed.yaml : allowed.markdown;
        return (
          requested.codec in allowed &&
          path.every((segment, index) => requested.path[index] === segment)
        );
      })
    );
  });
}

function formatToolRevisionReceipt(
  shortRef: string,
  changes: readonly WorldDocumentRevisionChange[],
): string {
  if (changes.length > 1)
    throw new Error(
      "A world_patch revision must affect only its target document",
    );
  return changes.length === 1
    ? `@${shortRef} pending write`
    : `@${shortRef} unchanged`;
}

function applyPlayCandidateRetirement(
  candidate: PlayCandidate,
  reads: WriteAuthorizations,
  args: unknown,
): PlayDocumentToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["target", "retired"]) ||
    typeof args.target !== "string" ||
    typeof args.retired !== "boolean"
  )
    return toolFailure(
      "world_retire requires exactly a target and boolean retired value.",
    );
  const ref = args.target.replace(/^@/u, "");
  const target = documentDescriptorByRef(candidate.snapshot, ref);
  if (target === null) return toolFailure(`Target @${ref} does not exist.`);
  if (
    reads.snapshotId !== candidate.snapshot.id ||
    reads.documents.get(ref) !== null
  )
    return toolFailure(
      `Read @${ref} exactly, or receive the complete document in bootstrap, before retiring or restoring it.`,
    );

  const revised = candidate.snapshot.revise({
    commands: [
      {
        kind: "retire",
        document: { documentId: target.documentId },
        retired: args.retired,
      },
    ],
  });
  if (!revised.ok || revised.snapshotStatus !== "usable")
    return toolFailure(
      worldDocumentRevisionFailureMessage(revised.diagnostics),
      "candidate",
    );
  const changed = revised.changes.length > 0;
  const previousSnapshot = candidate.snapshot;
  acceptWorldStateRevision(candidate, revised);
  carryWriteAuthorizations(previousSnapshot, candidate, reads, revised.changes);
  authorizeRead(reads, candidate.snapshot.id, ref, null);
  return {
    ok: true,
    markdown: changed
      ? `@${target.shortRef} pending ${args.retired ? "retirement" : "restoration"}`
      : `@${target.shortRef} unchanged`,
    candidateWrite: { shortRef: target.shortRef, changed },
  };
}

function nextAvailableStatePath(
  candidate: PlayCandidate,
  parentDirectory: string,
  refHint: string,
  codec: "yaml" | "markdown",
): string {
  const directory = parentDirectory === "" ? "" : `${parentDirectory}/`;
  const extension = codec === "yaml" ? "yaml" : "md";
  for (let suffix = 1; ; suffix += 1) {
    const suffixText = suffix === 1 ? "" : `-${suffix}`;
    const fileName = `${refHint.slice(0, 32 - suffixText.length)}${suffixText}`;
    const path = `state/${directory}${fileName}.${extension}`;
    if (candidate.files[path] === undefined) return path;
  }
}

function assertToolReferenceHandles(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value))
    throw new PlayDocumentToolFailure(
      "Tool arguments must not contain circular references",
    );
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertToolReferenceHandles(item, seen);
    seen.delete(value);
    return;
  }
  if (!record(value))
    throw new PlayDocumentToolFailure(
      "Tool arguments may contain only plain objects",
    );
  if (
    Object.hasOwn(value, "$ref") &&
    (Object.keys(value).length !== 1 ||
      typeof value.$ref !== "string" ||
      !value.$ref.startsWith("@"))
  )
    throw new PlayDocumentToolFailure(
      "$ref must use an @short-ref returned by the Runtime, and a reference object cannot contain other fields",
    );
  for (const item of Object.values(value))
    assertToolReferenceHandles(item, seen);
  seen.delete(value);
}

function applyPlayCandidateCreate(
  candidate: PlayCandidate,
  authorizations: WriteAuthorizations,
  args: unknown,
  declaredDirectories: readonly string[],
): PlayDocumentToolResult {
  try {
    const parentDirectory =
      record(args) && typeof args.parent === "string"
        ? parseStateDirectoryHandle(args.parent)
        : null;
    if (
      !record(args) ||
      typeof args.parent !== "string" ||
      parentDirectory === null ||
      (args.codec !== "yaml" && args.codec !== "markdown") ||
      typeof args.refHint !== "string" ||
      !/^[a-z][a-z0-9-]{1,31}$/u.test(args.refHint) ||
      typeof args.title !== "string" ||
      typeof args.summary !== "string" ||
      !Array.isArray(args.aliases) ||
      !args.aliases.every((alias) => typeof alias === "string") ||
      typeof args.body !== "string"
    )
      throw new PlayDocumentToolFailure("world_create arguments are invalid");
    if (
      !knownStateDirectory(
        candidate.snapshot,
        parentDirectory,
        declaredDirectories,
      )
    )
      throw new PlayDocumentToolFailure(
        "world_create parent is not a Runtime-known state directory; call state_list and use one of its directory handles",
      );
    const path = nextAvailableStatePath(
      candidate,
      parentDirectory,
      args.refHint,
      args.codec,
    );
    const command =
      args.codec === "yaml"
        ? ({
            kind: "create",
            temporaryName: "created",
            logicalPath: path,
            codec: "yaml",
            refHint: args.refHint,
            title: args.title,
            summary: args.summary,
            aliases: args.aliases,
            body: args.body,
          } as const)
        : ({
            kind: "create",
            temporaryName: "created",
            logicalPath: path,
            codec: "markdown",
            refHint: args.refHint,
            title: args.title,
            summary: args.summary,
            aliases: args.aliases,
            body: args.body,
          } as const);
    if (command.codec === "yaml") assertToolReferenceHandles(command.body);
    const revised = candidate.snapshot.revise({
      commands: [command],
    });
    if (!revised.ok || revised.snapshotStatus !== "usable")
      throw new PlayDocumentToolFailure(
        worldDocumentRevisionFailureMessage(revised.diagnostics),
        "candidate",
      );
    const created = revised.changes.find(({ before }) => before === null);
    if (created === undefined)
      throw new Error(
        "The world_create revision did not return a newly created document change",
      );
    const previousSnapshot = candidate.snapshot;
    acceptWorldStateRevision(candidate, revised);
    carryWriteAuthorizations(
      previousSnapshot,
      candidate,
      authorizations,
      revised.changes,
    );
    authorizeRead(
      authorizations,
      candidate.snapshot.id,
      created.shortRef,
      null,
    );
    return {
      ok: true,
      markdown: `@${created.shortRef} pending write`,
      candidateWrite: { shortRef: created.shortRef, changed: true },
    };
  } catch (error: unknown) {
    if (error instanceof PlayDocumentToolFailure)
      return toolFailure(error.message, error.failureKind);
    throw error;
  }
}

/**
 * Move read authorizations onto the revised snapshot. Only the documents this
 * revision actually rewrote go stale — everything else is byte-identical in the
 * new snapshot, so a model that read several documents and then patches one of
 * them keeps the right to write the others in the same model response.
 */
function carryWriteAuthorizations(
  previousSnapshot: WorldDocumentStore,
  candidate: PlayCandidate,
  authorizations: WriteAuthorizations,
  changes: readonly WorldDocumentRevisionChange[],
): void {
  const stale = new Set<string>();
  for (const change of changes) {
    stale.add(change.shortRef);
    const previous = documentById(previousSnapshot, change.documentId);
    if (previous !== null) stale.add(previous.shortRef);
  }
  authorizations.snapshotId = candidate.snapshot.id;
  for (const ref of stale) authorizations.documents.delete(ref);
}

function playCandidateStateChanges(
  candidate: PlayCandidate,
): FileNativeStateChange[] {
  return fileNativeStateChanges(candidate);
}

function documentById(
  snapshot: WorldDocumentStore,
  id: string,
): WorldDocumentDescriptor | null {
  const result = snapshot.query({
    kind: "read_document",
    document: { documentId: id },
  });
  return result.kind === "read_document" && result.ok ? result.document : null;
}

function toolFailure(
  message: string,
  failureKind: "protocol" | "candidate" = "protocol",
): PlayDocumentToolResult {
  return {
    ok: false,
    markdown: `# Runtime tool rejected\n\n${message}`,
    failureKind,
  };
}

interface ContextToolResult {
  ok: boolean;
  markdown: string;
  failureKind?: "protocol" | "candidate";
  readAuthorization?: {
    snapshotId: string;
    shortRef: string;
    locator: AuthorizedLocator | null;
  };
}

function executeContextSearch(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
): ContextToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, [
      "source",
      "query",
      "caseSensitive",
      "within",
      "limit",
      "cursor",
    ]) ||
    (args.source !== "state" && args.source !== "history") ||
    typeof args.query !== "string" ||
    args.query.length < 1 ||
    args.query.length > 256 ||
    (args.caseSensitive !== undefined &&
      typeof args.caseSensitive !== "boolean") ||
    (args.within !== undefined && typeof args.within !== "string") ||
    (args.limit !== undefined && typeof args.limit !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\ncontext_search accepts only a literal query and strict source, within, caseSensitive, limit, and cursor arguments; semantic filters are not accepted.",
    };
  const caseSensitive = args.caseSensitive === true;
  const query = args.query;
  const limit = typeof args.limit === "number" ? args.limit : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    return {
      ok: false,
      markdown: "# Runtime argument error\n\nlimit must be between 1 and 50.",
    };
  if (args.source === "state")
    return searchState(snapshot, {
      query,
      caseSensitive,
      ...(args.within === undefined ? {} : { within: args.within }),
      limit,
      ...(typeof args.cursor === "string" || args.cursor === null
        ? { cursor: args.cursor }
        : {}),
    });

  const source = history.map(
    ({ path, contents }) =>
      [
        historyRef(path),
        contents,
        [`history-commit-${path.split("-")[0] ?? ""}`] as string[],
      ] as const,
  );
  const normalizedQuery = normalizeSearch(query, caseSensitive);
  const within =
    typeof args.within === "string" ? args.within.replace(/^@/u, "") : null;
  const allHits = source.filter(
    ([ref, text, parentScopes]) =>
      (within === null || ref === within || parentScopes.includes(within)) &&
      normalizeSearch(text, caseSensitive).includes(normalizedQuery),
  );
  const scope = JSON.stringify({
    kind: "search",
    source: "history",
    query,
    caseSensitive,
    within: args.within ?? null,
    limit,
  });
  const offset = parseCursor(args.cursor, scope);
  if (offset === null)
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nThe cursor does not match the search criteria or endpoint.",
    };
  const hits = allHits.slice(offset, offset + limit);
  const complete = offset + hits.length >= allHits.length;
  const renderedHits = hits
    .map(
      ([ref, text]) =>
        `- @${ref}\n  Exact-match excerpt:\n${quoteMarkdown(snippet(text, query), "  ")}`,
    )
    .join("\n");
  return {
    ok: true,
    markdown: `# Literal search\n\nScope: history${args.within === undefined ? "" : ` · ${args.within}`}\nNormalization: ${caseSensitive ? "original text" : "NFKC + case folding"}\nTotal matches: ${allHits.length}\n${renderedHits || "Zero literal matches do not prove that the fact is absent from the world."}\n\n---\nThis page: ${offset}..${offset + hits.length} / ${allHits.length} matches\nComplete: ${complete ? "yes" : "no"}${complete ? "" : `\nNext-page cursor: ${cursorFor(scope, offset + hits.length)}`}`,
  };
}

function searchState(
  snapshot: WorldDocumentStore,
  input: {
    query: string;
    caseSensitive: boolean;
    within?: string;
    limit: number;
    cursor?: string | null;
  },
): ContextToolResult {
  const within = parseStateSearchScope(input.within);
  if (within === invalidStateHandle)
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nA state search scope must be an @dir-* or document @short-ref returned by the Runtime.",
    };
  const result = snapshot.query({
    kind: "literal_search",
    query: input.query,
    caseSensitive: input.caseSensitive,
    ...(within === undefined ? {} : { within }),
    limit: input.limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  if (result.kind === "error") return renderStateQueryFailure(result);
  if (result.kind !== "literal_search") return unexpectedStateQueryResult();
  const renderedHits = result.matches
    .map(
      ({ document, referenceProjection, range }) =>
        `- @${document.shortRef} · ${document.title} · line ${range.start.line}, column ${range.start.column}\n  Exact match: ${JSON.stringify(referenceProjection.text)}\n  Exact-match excerpt (mechanical references appear as @short-refs):\n${quoteMarkdown(referenceProjection.excerpt, "  ")}`,
    )
    .join("\n");
  const scope =
    input.within === undefined ? "state" : `state · ${input.within}`;
  return {
    ok: true,
    markdown: `# Literal search\n\nScope: ${scope}\nNormalization: ${input.caseSensitive ? "original text" : "NFKC + case folding"}\nCoverage: ${result.coverage.status === "complete" ? "complete" : `partial (${result.coverage.excludedDocuments} damaged documents excluded)`}\nTotal matches: ${result.page.total}\n${renderedHits || "Zero literal matches do not prove that the fact is absent from the world."}\n\n---\nThis page: ${result.page.start}..${result.page.end} / ${result.page.total} matches\nComplete: ${result.page.complete ? "yes" : "no"}${result.page.nextCursor === null ? "" : `\nNext-page cursor: ${result.page.nextCursor}`}`,
  };
}

const invalidStateHandle = Symbol("invalid-state-handle");

function parseStateSearchScope(
  handle: string | undefined,
):
  | { directory: string }
  | { document: { shortRef: string } }
  | undefined
  | typeof invalidStateHandle {
  if (handle === undefined) return undefined;
  const directory = parseStateDirectoryHandle(handle);
  if (directory !== null) return { directory };
  const document = /^@([a-z][a-z0-9-]*)$/u.exec(handle);
  return document === null
    ? invalidStateHandle
    : { document: { shortRef: document[1]! } };
}

function stateDirectoryHandle(directory: string): string {
  if (directory === "") return "@dir-/";
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  return `@dir-/${encoded}`;
}

function parseStateDirectoryHandle(handle: string): string | null {
  if (handle === "@dir-/") return "";
  if (!handle.startsWith("@dir-/") || handle.length === "@dir-/".length)
    return null;
  try {
    const directory = handle
      .slice("@dir-/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    if (
      directory
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            segment.includes("\\"),
        ) ||
      stateDirectoryHandle(directory) !== handle
    )
      return null;
    return directory;
  } catch {
    return null;
  }
}

function validStateDirectory(directory: string): boolean {
  if (directory.length === 0) return false;
  try {
    return (
      parseStateDirectoryHandle(stateDirectoryHandle(directory)) === directory
    );
  } catch {
    return false;
  }
}

function knownStateDirectory(
  snapshot: WorldDocumentStore,
  directory: string,
  declaredDirectories: readonly string[],
): boolean {
  if (directory === "") return true;
  const relativePrefix = `${directory}/`;
  if (
    declaredDirectories.some(
      (declared) =>
        declared === directory || declared.startsWith(relativePrefix),
    )
  )
    return true;
  const logicalPrefix = `${snapshot.logicalRoot}/${relativePrefix}`;
  return snapshot.files.some(({ path }) => path.startsWith(logicalPrefix));
}

function executeStateList(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
  declaredDirectories: readonly string[],
): ContextToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["parent", "cursor", "limit"]) ||
    typeof args.parent !== "string" ||
    parseStateDirectoryHandle(args.parent) === null ||
    (args.limit !== undefined && typeof args.limit !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nstate_list requires an @dir-* parent returned by Runtime and accepts only cursor and limit in addition; use history_list for committed history.",
    };
  return executeContextList(
    snapshot,
    history,
    { ...args, source: "state" },
    declaredDirectories,
  );
}

function executeHistoryList(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
): ContextToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["order", "cursor", "limit"]) ||
    (args.order !== "newest_first" && args.order !== "oldest_first") ||
    (args.limit !== undefined && typeof args.limit !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nhistory_list requires newest_first or oldest_first order and accepts only cursor and limit in addition; use state_list for state directories.",
    };
  return executeContextList(snapshot, history, { ...args, source: "history" });
}

function executeContextList(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
  declaredDirectories: readonly string[] = [],
): ContextToolResult {
  if (!record(args) || (args.source !== "state" && args.source !== "history"))
    return {
      ok: false,
      markdown:
        '# Runtime argument error\n\nUse {source:"state", parent:"@dir-/"} for state directories and {source:"history", order:"newest_first"} for history.',
    };
  const allowedKeys = ["source", "parent", "order", "cursor", "limit"];
  const invalidStateShape =
    args.source === "state" &&
    (typeof args.parent !== "string" ||
      parseStateDirectoryHandle(args.parent) === null ||
      args.order !== undefined);
  const invalidHistoryShape =
    args.source === "history" &&
    (args.parent !== undefined ||
      (args.order !== "newest_first" && args.order !== "oldest_first"));
  if (
    !hasOnlyToolKeys(args, allowedKeys) ||
    invalidStateShape ||
    invalidHistoryShape ||
    (args.limit !== undefined && typeof args.limit !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nstate must use an @dir-* parent returned by the Runtime and omit order; history must use newest_first or oldest_first order and omit parent.",
    };
  const limit = typeof args.limit === "number" ? args.limit : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return {
      ok: false,
      markdown: "# Runtime argument error\n\nlimit must be between 1 and 100.",
    };
  if (args.source === "state") {
    const parent = args.parent as string;
    const directory = parseStateDirectoryHandle(parent);
    if (directory === null) return unexpectedStateQueryResult();
    if (!knownStateDirectory(snapshot, directory, declaredDirectories))
      return {
        ok: false,
        markdown:
          "# Runtime argument error\n\nThe parent is not a Runtime-known state directory; call state_list and descend only through its returned directory handles.",
      };
    const result = snapshot.query({
      kind: "catalog",
      directory,
      includeRetired: true,
      declaredDirectories,
      limit,
      ...(typeof args.cursor === "string" || args.cursor === null
        ? { cursor: args.cursor }
        : {}),
    });
    if (result.kind === "error") return renderStateQueryFailure(result);
    if (result.kind !== "catalog") return unexpectedStateQueryResult();
    const entries = result.entries.map((entry) => {
      if (entry.kind === "directory") {
        const relative = entry.logicalPath.slice(
          `${snapshot.logicalRoot}/`.length,
        );
        return `- Directory ${stateDirectoryHandle(relative)}`;
      }
      if (entry.document === undefined)
        return "- Damaged document (currently not addressable)";
      return `- Document @${entry.document.shortRef} · ${entry.document.title} · ${entry.document.codec.toUpperCase()} · ${entry.document.summary}${entry.document.retired ? " · retired" : ""}${entry.status === "damaged" ? " · needs repair" : ""}`;
    });
    return {
      ok: true,
      markdown: `# Directory listing\n\nScope: state · ${parent}\nCoverage: ${result.coverage.status === "complete" ? "complete" : "partial"}\n${entries.join("\n") || "(empty)"}\n\n---\nThis page: ${result.page.start}..${result.page.end} / ${result.page.total} items\nComplete: ${result.page.complete ? "yes" : "no"}${result.page.nextCursor === null ? "" : `\nNext-page cursor: ${result.page.nextCursor}`}`,
    };
  }

  const entries = [...history]
    .sort((a, b) =>
      (args.order ?? "newest_first") === "oldest_first"
        ? a.path.localeCompare(b.path)
        : b.path.localeCompare(a.path),
    )
    .map(
      ({ path, contents }) =>
        `- @${historyRef(path)}, ${Buffer.byteLength(contents, "utf8")} bytes`,
    );
  const scope = JSON.stringify({
    kind: "list",
    source: "history",
    order: args.order,
    limit,
  });
  const offset = parseCursor(args.cursor, scope);
  if (offset === null)
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nThe cursor does not match the listing criteria or endpoint.",
    };
  const page = entries.slice(offset, offset + limit);
  const complete = offset + page.length >= entries.length;
  return {
    ok: true,
    markdown: `# Directory listing\n\nScope: history · ${String(args.order)}\n${page.join("\n") || "(empty)"}\n\n---\nThis page: ${offset}..${offset + page.length} / ${entries.length} items\nComplete: ${complete ? "yes" : "no"}${complete ? "" : `\nNext-page cursor: ${cursorFor(scope, offset + page.length)}`}`,
  };
}

function executeContextRead(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
): ContextToolResult {
  if (
    !record(args) ||
    // Frozen contexts created before complete exact reads still advertise
    // cursor/maxBytes. Accept and ignore those obsolete arguments so an
    // existing Provider continuation can cross the upgrade boundary.
    !hasOnlyToolKeys(args, ["ref", "cursor", "maxBytes"]) ||
    typeof args.ref !== "string"
  )
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nA stable ref returned by list or search is required.",
    };
  const historyRefValue = args.ref.replace(/^@/u, "");
  const historyEntry = history.find(
    ({ path }) => historyRef(path) === historyRefValue,
  );
  if (historyEntry !== undefined)
    return {
      ok: true,
      markdown: `# Exact read @${historyRefValue}\n\n${historyEntry.contents}\n\n---\nSource: @${historyRefValue}\nComplete: yes`,
    };

  const handle = parseStateReadHandle(args.ref);
  if (handle === null)
    return {
      ok: false,
      markdown:
        "# Runtime argument error\n\nAn exact state read requires a document @short-ref or one of its #/logical nodes.",
    };
  const resolved = snapshot.query({
    kind: "read_document",
    document: { shortRef: handle.shortRef },
  });
  if (resolved.kind === "error") return renderStateQueryFailure(resolved);
  if (resolved.kind !== "read_document") return unexpectedStateQueryResult();
  if (handle.path === null)
    return resolved.codec === "markdown"
      ? readMarkdownDocument(snapshot, resolved.document)
      : readProjectedNode(
          snapshot,
          resolved.document,
          { yaml: [] },
          args.ref,
          true,
        );
  const locator: WorldDocumentLocator =
    resolved.codec === "yaml"
      ? { yaml: handle.path.map(parseYamlHandleSegment) }
      : { markdown: handle.path };
  return readProjectedNode(
    snapshot,
    resolved.document,
    locator,
    args.ref,
    false,
  );
}

function readMarkdownDocument(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
): ContextToolResult {
  const result = snapshot.query({
    kind: "read_document",
    document: { shortRef: document.shortRef },
  });
  if (result.kind === "error") return renderStateQueryFailure(result);
  if (result.kind !== "read_document") return unexpectedStateQueryResult();
  return {
    ok: true,
    markdown: `# Exact read @${document.shortRef}\n\n${renderDocumentMetadata(document)}\n[Writable body starts; locators are relative to this point]\n${result.body.trimEnd()}\n[Writable body ends]\n\n${renderPlayerViewBindings(snapshot, document.shortRef)}\n\n---\nScope: state · @${document.shortRef}\nComplete: yes`,
    readAuthorization: {
      snapshotId: snapshot.id,
      shortRef: document.shortRef,
      locator: null,
    },
  };
}

function readProjectedNode(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
  locator: WorldDocumentLocator,
  requestedHandle: string,
  wholeDocument: boolean,
): ContextToolResult {
  const result = snapshot.query({
    kind: "select_node",
    document: { shortRef: document.shortRef },
    locator,
  });
  if (result.kind === "error") return renderStateQueryFailure(result);
  if (result.kind !== "select_node") return unexpectedStateQueryResult();
  const body =
    result.node.codec === "yaml"
      ? stringify(toolWorldDocumentValue(result.node.value), {
          indent: 2,
          lineWidth: 0,
        }).trimEnd()
      : result.node.markdown.trimEnd();
  const text = wholeDocument
    ? `${renderDocumentMetadata(document)}\n[Writable body starts; locators are relative to this point]\n${body}\n[Writable body ends]\n`
    : `# ${document.title} · ${renderLocator(result.node.locator)} [${requestedHandle}]\n\n${body}\n`;
  return {
    ok: true,
    markdown: `# Exact read ${requestedHandle}\n\n${text.trimEnd()}\n\n${renderPlayerViewBindings(snapshot, document.shortRef)}\n\n---\nScope: state · ${requestedHandle}\nComplete: yes`,
    readAuthorization: {
      snapshotId: snapshot.id,
      shortRef: document.shortRef,
      locator: wholeDocument ? null : result.node.locator,
    },
  };
}

function renderDocumentMetadata(document: WorldDocumentDescriptor): string {
  const metadata = stringify(
    {
      title: document.title,
      summary: document.summary,
      aliases: document.aliases,
      ...(document.retired ? { retired: true } : {}),
    },
    { indent: 2, lineWidth: 0 },
  ).trimEnd();
  return `[Document metadata: not body content; set_metadata updates one or more fields and preserves omitted fields; retired is changed only by world_retire]\n${metadata}`;
}

function toolWorldDocumentValue(value: WorldDocumentValue): unknown {
  if (Array.isArray(value)) return value.map(toolWorldDocumentValue);
  if (!record(value)) return value;
  if (
    typeof value.$ref === "string" &&
    record(value.target) &&
    typeof value.target.shortRef === "string"
  )
    return { $ref: `@${value.target.shortRef}` };
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      toolWorldDocumentValue(child),
    ]),
  );
}

function parseStateReadHandle(
  value: string,
): { shortRef: string; path: string[] | null } | null {
  const match = /^@([a-z][a-z0-9-]*)(?:#\/(.+))?$/u.exec(value);
  if (match === null) return null;
  try {
    return {
      shortRef: match[1]!,
      path:
        match[2] === undefined
          ? null
          : match[2].split("/").map(decodeURIComponent),
    };
  } catch {
    return null;
  }
}

function renderLocator(locator: WorldDocumentLocator): string {
  return "yaml" in locator
    ? `yaml:${locator.yaml.join("/")}`
    : `markdown:${locator.markdown.join("/")}`;
}

function renderStateQueryFailure(
  result: WorldDocumentQueryFailure,
): ContextToolResult {
  return {
    ok: false,
    markdown: `# Runtime argument error\n\n${result.diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n")}`,
  };
}

function unexpectedStateQueryResult(): ContextToolResult {
  return {
    ok: false,
    markdown:
      "# Runtime tool rejected\n\nThe world-document query returned an incompatible result type.",
  };
}

function quoteMarkdown(value: string, indent = ""): string {
  return value
    .split("\n")
    .map((line) => `${indent}> ${line}`)
    .join("\n");
}

function hasOnlyToolKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validOptionalCursor(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function normalizeSearch(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("und");
}

function snippet(text: string, query: string): string {
  const position = text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .indexOf(query.normalize("NFKC").toLocaleLowerCase("und"));
  const start = Math.max(0, position - 120);
  return text.slice(start, start + 240).replace(/\s+/gu, " ");
}

function historyRef(path: string): string {
  return `history-message-${path.replace(/\.md$/u, "")}`;
}

function cursorFor(scope: string, offset: number): string {
  return Buffer.from(
    JSON.stringify({
      scope: createHash("sha256").update(scope).digest("hex"),
      offset,
    }),
    "utf8",
  ).toString("base64url");
}

function parseCursor(cursor: unknown, scope: string): number | null {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== "string") return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !record(value) ||
      value.scope !== createHash("sha256").update(scope).digest("hex") ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0
    )
      return null;
    return Number(value.offset);
  } catch {
    return null;
  }
}

export function parseNarrative(args: unknown): string {
  if (
    !record(args) ||
    typeof args.text !== "string" ||
    args.text.length < 1 ||
    args.text.length > 24_000
  )
    throw new PromptCompilationError(
      "narrative_invalid",
      "Narrative text must contain 1 to 24,000 Unicode characters",
    );
  return args.text;
}

export function fingerprintControl(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, contents] of Object.entries(files)
    .filter(([path]) => path.startsWith("control/"))
    .sort(([a], [b]) => a.localeCompare(b)))
    hash.update(path).update("\0").update(contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

export function isPlayDocumentAuthorizationCheckpoint(
  value: unknown,
): value is PlayDocumentAuthorizationCheckpoint {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "stateFingerprint",
      "documents",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "play_document_authorizations" ||
    typeof value.stateFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.stateFingerprint) ||
    !Array.isArray(value.documents) ||
    value.documents.length > 100_000
  )
    return false;
  const refs = new Set<string>();
  for (const document of value.documents) {
    if (
      !record(document) ||
      !hasExactKeys(document, ["shortRef", "locators"]) ||
      typeof document.shortRef !== "string" ||
      !/^[a-z][a-z0-9-]*$/u.test(document.shortRef) ||
      refs.has(document.shortRef) ||
      (document.locators !== null &&
        (!Array.isArray(document.locators) ||
          document.locators.length > 100_000 ||
          !document.locators.every(isPersistedAuthorizedLocator)))
    )
      return false;
    refs.add(document.shortRef);
  }
  return true;
}

function fingerprintStateFiles(
  files: Readonly<Record<string, string>>,
): string {
  const hash = createHash("sha256");
  for (const [path, contents] of Object.entries(files)
    .filter(([path]) => path.startsWith("state/"))
    .sort(([left], [right]) => left.localeCompare(right)))
    hash.update(path).update("\0").update(contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function isPersistedAuthorizedLocator(
  value: unknown,
): value is AuthorizedLocator {
  if (!record(value)) return false;
  if (hasExactKeys(value, ["yaml"]))
    return (
      Array.isArray(value.yaml) &&
      value.yaml.length <= 64 &&
      value.yaml.every(
        (segment) =>
          typeof segment === "string" ||
          (Number.isSafeInteger(segment) && Number(segment) >= 0),
      )
    );
  if (hasExactKeys(value, ["markdown"]))
    return (
      Array.isArray(value.markdown) &&
      value.markdown.length <= 64 &&
      value.markdown.every((segment) => typeof segment === "string")
    );
  return false;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
