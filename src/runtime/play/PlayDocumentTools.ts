import type { AppLocale } from "../../protocol/appPreferences.ts";
import { createHash } from "node:crypto";
import type { ResolutionReceipt } from "../../protocol/resolution.ts";
import type { HistoryQuery } from "../history/HistoryQuery.ts";
import {
  createHistoryQuery,
  type HistoryEntry,
} from "../history/HistoryTools.ts";
import {
  legacyHistoryList,
  legacyHistorySearch,
} from "../history/LegacyHistoryQuery.ts";
import { renderHistoryResult } from "../history/HistoryRendering.ts";
import {
  stateDirectoryHandle,
  parseStateDirectoryHandle,
} from "../world/StateDirectoryHandles.ts";

import { parseDocument, stringify } from "yaml";
import { renderPlayerViewBindings } from "../world/PlayerViewBindings.ts";
import {
  coerceToolArguments,
  renderCoercionNote,
  type CoercedToolArguments,
} from "../model/ToolArgumentCoercion.ts";
import { parseArguments } from "../model/ProviderValues.ts";
import { runtimeToolInputSchema } from "../prompt/FileNativeToolRegistry.ts";

import type { ModelHostToolCall } from "../model/ModelHost.ts";

import {
  PromptCompilationError,
  type MaterialSelection,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type { FileNativeStateChange } from "../world/FileNativeWorldStore.ts";
import {
  formatWorldDocumentLocator,
  locatorStartsWith,
  validMarkdownLocator,
  validYamlLocator,
  type WorldDocumentEditOutcome,
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
  resolution?: ResolutionReceipt;
  /** Document identity recorded when Authority commits world_create. */
  createdDocumentId?: string;
  /** Applied edits that can invalidate an earlier exact read. */
  patchAuthorization?: {
    shortRef: string;
    edits: PatchScopeEdit[];
  };
  /** Internal receipt settled by PlayCallChain only after Authority commits. */
  candidateWrite?: {
    shortRef: string;
    changed: boolean;
    retired?: boolean;
    editDetails?: string;
    sizeAdvice?: string;
    notes?: string[];
  };
}

const writeReceiptStatus = {
  en: {
    unchanged: "unchanged",
    written: "write succeeded",
    retired: "retired",
    restored: "restored",
    retirementSuperseded: "retirement superseded",
    restorationSuperseded: "restoration superseded",
  },
  "zh-CN": {
    unchanged: "无变化",
    written: "写入成功",
    retired: "已退役",
    restored: "已恢复",
    retirementSuperseded: "退役已被后续操作覆盖",
    restorationSuperseded: "恢复已被后续操作覆盖",
  },
} as const;

export function appendPlayToolNote(
  result: PlayDocumentToolResult,
  note: string,
): void {
  result.markdown += `\n\n${note}`;
  if (result.candidateWrite !== undefined)
    (result.candidateWrite.notes ??= []).push(note);
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

interface PlayDocumentToolOptions {
  historyScope?: string;
  historyVersion?: string;
  locale?: AppLocale;
  legacyHistoryTools?: boolean;
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
  #historyQuery?: { scope: string; version: string; query: HistoryQuery };
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

  settledWriteReceipt(
    write: NonNullable<PlayDocumentToolResult["candidateWrite"]>,
    committed: boolean,
    locale: AppLocale = "en",
  ): string {
    let status: keyof typeof writeReceiptStatus.en = "unchanged";
    if (write.changed && committed) {
      if (write.retired === undefined) {
        status = "written";
      } else {
        // A later tool in the same response can reverse a candidate retirement.
        const before =
          documentDescriptorByRef(this.committedSnapshot, write.shortRef)
            ?.retired === true;
        const after =
          documentDescriptorByRef(this.snapshot, write.shortRef)?.retired ===
          true;
        if (before !== after) {
          if (write.retired === after) status = after ? "retired" : "restored";
          else
            status = write.retired
              ? "retirementSuperseded"
              : "restorationSuperseded";
        }
      }
    }
    const summary = [
      `@${write.shortRef} ${writeReceiptStatus[locale][status]}`,
      write.editDetails,
      write.sizeAdvice,
    ]
      .filter(Boolean)
      .join("\n");
    return [summary, ...(write.notes ?? [])].join("\n\n");
  }

  /**
   * Read authorizations live only in memory (ADR-0044). A fresh binding starts
   * from the bootstrap's own reads; writes are guarded at commit time by the
   * previous-content hash of each changed file.
   */
  bindBootstrap(bootstrap: PromptCompilation): void {
    this.#reads = bootstrapAuthorizations(bootstrap, this.#candidate.snapshot);
    // Creation capabilities come from this prefix, not past directory slots.
    this.#declaredDirectories = declaredStateDirectories(bootstrap);
  }

  /**
   * Re-grant one exact read the model already completed in a retained
   * transcript. The scope is resolved against the current snapshot again, so a
   * document or node that no longer exists grants nothing. Returns whether the
   * scope resolved.
   */
  replayRead(shortRef: string, locator: AuthorizedLocator | null): boolean {
    return authorizeResolvedRead(
      this.#reads,
      this.#candidate.snapshot,
      shortRef,
      locator,
    );
  }

  replayCreation(result: PlayDocumentToolResult): void {
    if (!result.ok) return;
    if (result.createdDocumentId !== undefined) {
      const snapshot = this.#candidate.snapshot;
      const created = documentById(snapshot, result.createdDocumentId);
      if (created !== null)
        authorizeRead(this.#reads, snapshot.id, created.shortRef, null);
      return;
    }
    // Published receipts contain the allocated short ref, which may differ
    // from the model's refHint. Only a settled success can grant a scope.
    const shortRef = /^@([a-z][a-z0-9-]*) write succeeded(?:\n|$)/u.exec(
      result.markdown,
    )?.[1];
    if (shortRef !== undefined) this.replayRead(shortRef, null);
  }

  replayPatch(result: PlayDocumentToolResult, args: unknown): void {
    const recorded =
      result.patchAuthorization ?? legacyPatchAuthorization(args);
    if (
      recorded === undefined ||
      typeof recorded.shortRef !== "string" ||
      !Array.isArray(recorded.edits)
    )
      return;
    const scopes = this.#reads.documents.get(recorded.shortRef);
    if (scopes == null) return;
    this.#reads.documents.set(
      recorded.shortRef,
      scopesAfterPatch(
        scopes,
        recorded.edits.flatMap((edit) => {
          const scopeEdit = patchScopeEdit(edit);
          return scopeEdit === null ? [] : [scopeEdit];
        }),
      ),
    );
  }

  execute(
    call: ModelHostToolCall,
    history: readonly HistoryEntry[],
    options: PlayDocumentToolOptions = {},
  ): PlayDocumentToolResult {
    const schema = runtimeToolInputSchema(call.name);
    if (schema === null) return this.#dispatch(call, history, options);
    const repaired = coerceToolArguments(schema, call.arguments);
    if (call.name === "world_patch") repairWorldPatchLocators(repaired);
    const result = this.#dispatch(
      { ...call, arguments: repaired.arguments },
      history,
      options,
    );
    if (repaired.coerced.length > 0)
      appendPlayToolNote(
        result,
        renderCoercionNote(repaired.coerced, options.locale ?? "en"),
      );
    return result;
  }

  #dispatch(
    call: ModelHostToolCall,
    history: readonly HistoryEntry[],
    options: PlayDocumentToolOptions,
  ): PlayDocumentToolResult {
    const locale = options.locale ?? "en";
    const query = () => {
      const scope = options.historyScope ?? "local-document-context";
      const version = options.historyVersion;
      if (version === undefined) return createHistoryQuery(scope, history);
      const cached = this.#historyQuery;
      if (cached?.scope === scope && cached.version === version)
        return cached.query;
      const next = createHistoryQuery(scope, history, version);
      this.#historyQuery = { scope, version, query: next };
      return next;
    };
    const render = (result: Parameters<typeof renderHistoryResult>[0]) =>
      renderHistoryResult(result, locale);
    const legacy = options.legacyHistoryTools !== false;
    const args = call.arguments;
    if (call.name === "history_search") return render(query().search(args));
    if (call.name === "history_read") return render(query().read(args));
    if (call.name === "history_list") {
      return render(
        legacy && record(args) && args.order !== undefined
          ? legacyHistoryList(query(), args, "history_list")
          : query().list(args),
      );
    }
    if (
      call.name === "context_list" &&
      record(args) &&
      args.source === "history"
    ) {
      const { source: _source, ...parameters } = args;
      void _source;
      return legacy
        ? render(legacyHistoryList(query(), parameters, "context_list"))
        : toolFailure("Use history_list for committed history.");
    }
    if (
      call.name === "context_search" &&
      record(args) &&
      args.source === "history"
    ) {
      const { source: _source, ...parameters } = args;
      void _source;
      return legacy
        ? render(legacyHistorySearch(query(), parameters))
        : toolFailure("Use history_search for committed history.");
    }
    if (
      call.name === "context_read" &&
      record(args) &&
      typeof args.ref === "string" &&
      /^@?history-message-/u.test(args.ref)
    ) {
      if (!legacy)
        return toolFailure(
          "Use history_read with refs supplied in injections or tool results.",
        );
      if (!hasOnlyToolKeys(args, ["ref", "cursor", "maxBytes"]))
        return toolFailure(
          "Legacy context_read requires ref and accepts only obsolete cursor/maxBytes in addition.",
        );
      return renderHistoryResult(
        query().read({
          ref: args.ref.startsWith("@") ? args.ref : `@${args.ref}`,
        }),
        locale,
        true,
      );
    }
    if (call.name === "context_search")
      return executeContextSearch(this.#candidate.snapshot, call.arguments);
    if (call.name === "state_list")
      return executeStateList(
        this.#candidate.snapshot,
        call.arguments,
        this.#declaredDirectories,
        locale,
      );
    // Frozen contexts created before runtime-tools-v5 retain this exact name
    // and argument shape. New contexts never advertise it.
    if (call.name === "context_list")
      return executeContextList(
        this.#candidate.snapshot,
        call.arguments,
        this.#declaredDirectories,
        locale,
      );
    if (call.name === "context_read") {
      const result = executeContextRead(
        this.#candidate.snapshot,
        call.arguments,
        locale,
      );
      authorizeToolRead(this.#reads, this.#candidate.snapshot, result);
      return result;
    }
    if (call.name === "world_patch")
      return applyPlayCandidatePatch(
        this.#candidate,
        this.#reads,
        call.arguments,
        locale,
      );
    if (call.name === "world_create")
      return applyPlayCandidateCreate(
        this.#candidate,
        this.#reads,
        call.arguments,
        this.#declaredDirectories,
        locale,
      );
    if (call.name === "world_retire")
      return applyPlayCandidateRetirement(
        this.#candidate,
        this.#reads,
        call.arguments,
        locale,
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
interface PatchScopeEdit {
  op:
    | "add"
    | "remove"
    | "remove_section"
    | "rename_section"
    | "replace"
    | "replace_section";
  locator: AuthorizedLocator;
}
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
    authorizeResolvedRead(
      result,
      snapshot,
      readAuthorization.shortRef,
      readAuthorization.locator,
    );
  }
  return result;
}

function authorizeResolvedRead(
  authorizations: WriteAuthorizations,
  snapshot: WorldDocumentStore,
  shortRef: string,
  locator: AuthorizedLocator | null,
): boolean {
  if (locator === null) {
    const resolved = snapshot.query({
      kind: "read_document",
      document: { shortRef },
    });
    if (resolved.kind !== "read_document" || !resolved.ok) return false;
    authorizeRead(
      authorizations,
      snapshot.id,
      resolved.document.shortRef,
      null,
    );
    return true;
  }
  const selected = snapshot.query({
    kind: "select_node",
    document: { shortRef },
    locator,
  });
  if (selected.kind !== "select_node" || !selected.ok) return false;
  authorizeRead(
    authorizations,
    snapshot.id,
    selected.document.shortRef,
    selected.node.locator,
  );
  return true;
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

function patchLocatorField(op: unknown): "yaml" | "markdown" | undefined {
  switch (op) {
    case "add":
    case "replace":
    case "append":
    case "remove":
      return "yaml";
    case "add_section":
    case "replace_section":
    case "rename_section":
    case "remove_section":
      return "markdown";
  }
}

/** The shallow schema pass has already handled the edits array and its items. */
function repairWorldPatchLocators(repaired: CoercedToolArguments): void {
  const args = repaired.arguments;
  if (!record(args) || !Array.isArray(args.edits) || args.edits.length > 32)
    return;
  const edits: unknown[] = args.edits;
  let next = edits;
  for (const [index, edit] of edits.entries()) {
    if (!record(edit)) continue;
    const { op, locator: rawLocator } = edit;
    const field = patchLocatorField(op);
    if (field === undefined) continue;
    const locator =
      typeof rawLocator === "string" ? parseArguments(rawLocator) : rawLocator;
    if (
      !record(locator) ||
      Object.keys(locator).length !== 1 ||
      !Object.hasOwn(locator, field)
    )
      continue;
    const rawPath = locator[field];
    if (typeof rawLocator !== "string" && typeof rawPath !== "string") continue;
    const path =
      typeof rawPath === "string" ? parseArguments(rawPath) : rawPath;
    const candidate = { [field]: path };
    const valid =
      field === "yaml"
        ? validYamlLocator(candidate) &&
          candidate.yaml[0] !== "$document" &&
          (candidate.yaml.length > 0 || op === "add" || op === "replace")
        : validMarkdownLocator(candidate, op === "add_section");
    if (!valid) continue;
    // JSON.parse keeps the last duplicate property, which could name a
    // different write target. Check serialized locators before using them.
    if (
      typeof rawLocator === "string" &&
      parseDocument(rawLocator, { schema: "json" }).errors.length > 0
    )
      continue;
    if (next === edits) next = [...edits];
    next[index] = { ...edit, locator: candidate };
    const position = `edits[${index}].locator`;
    if (typeof rawLocator === "string") repaired.coerced.push(position);
    if (typeof rawPath === "string")
      repaired.coerced.push(`${position}.${field}`);
  }
  if (next !== edits) repaired.arguments = { ...args, edits: next };
}

function applyPlayCandidatePatch(
  candidate: PlayCandidate,
  reads: WriteAuthorizations,
  args: unknown,
  locale: AppLocale,
): PlayDocumentToolResult {
  if (record(args) && typeof args.edits === "string")
    return toolFailure(
      locale === "zh-CN"
        ? "world_patch.edits 必须是包含 1 到 32 条编辑的 JSON 数组，不能传字符串。"
        : "world_patch.edits must be a JSON array of 1 to 32 edits, not a string.",
      "protocol",
      locale,
    );
  if (
    !record(args) ||
    typeof args.target !== "string" ||
    !Array.isArray(args.edits) ||
    args.edits.length < 1 ||
    args.edits.length > 32
  )
    return toolFailure(
      locale === "zh-CN"
        ? "world_patch 需要目标和 1 到 32 条编辑。"
        : "world_patch requires a target and 1 to 32 edits.",
      "protocol",
      locale,
    );
  const edits: unknown[] = args.edits;
  const ref = args.target.replace(/^@/u, "");
  const target = documentDescriptorByRef(candidate.snapshot, ref);
  if (target === null) return missingWriteTarget(ref, locale);
  const authorization = reads.documents.get(ref);
  if (
    reads.snapshotId !== candidate.snapshot.id ||
    !permitsPatch(authorization, edits)
  )
    return toolFailure(
      locale === "zh-CN"
        ? `写入 @${ref} 超出了当前授权。请用 context_read 精确读取缺少授权的节点，或整份读取文档以更新元数据。`
        : `The edit exceeds the current write scope for @${ref}. Use context_read on each uncovered node before writing it, or read the full document to update metadata.`,
      "protocol",
      locale,
    );
  try {
    assertToolReferenceHandles(edits, locale);
    const revised = candidate.snapshot.revise({
      commands: [
        {
          kind: "patch",
          document: { documentId: target.documentId },
          edits: edits as readonly WorldDocumentRevisionEdit[],
        },
      ],
    });
    if (!revised.ok && revised.editOutcomes.length > 0)
      throw new PlayDocumentToolFailure(
        locale === "zh-CN"
          ? `world_patch 对 @${ref} 的编辑均未生效。${formatEditNotes(revised.editOutcomes, locale)}`
          : `world_patch applied none of its edits to @${ref}. ${formatEditNotes(revised.editOutcomes, locale)}`,
        "candidate",
      );
    if (!revised.ok || revised.snapshotStatus !== "usable")
      throw new PlayDocumentToolFailure(
        writeRevisionFailure(revised.diagnostics, locale),
        "candidate",
      );
    const changed = revised.changes.length > 0;
    if (revised.changes.length > 1)
      throw new Error(
        "A world_patch revision must affect only its target document",
      );
    const editDetails = formatToolEditDetails(revised.editOutcomes, locale);
    const status = `@${target.shortRef} ${changed ? (locale === "zh-CN" ? "待写入" : "pending write") : writeReceiptStatus[locale].unchanged}`;
    const scopeEdits = revised.editOutcomes.flatMap(({ editIndex, status }) => {
      const edit =
        status === "applied" ? patchScopeEdit(edits[editIndex]) : null;
      return edit === null ? [] : [edit];
    });
    const previousSnapshot = candidate.snapshot;
    acceptWorldStateRevision(candidate, revised);
    carryWriteAuthorizations(
      previousSnapshot,
      candidate,
      reads,
      revised.changes,
    );
    if (authorization === null)
      authorizeRead(reads, candidate.snapshot.id, ref, null);
    else {
      reads.documents.delete(ref);
      for (const locator of scopesAfterPatch(authorization, scopeEdits))
        authorizeResolvedRead(reads, candidate.snapshot, ref, locator);
    }
    return {
      ok: true,
      markdown: editDetails === "" ? status : `${status} · ${editDetails}`,
      patchAuthorization: { shortRef: ref, edits: scopeEdits },
      candidateWrite: {
        shortRef: target.shortRef,
        changed,
        ...(editDetails === "" ? {} : { editDetails }),
      },
    };
  } catch (error: unknown) {
    if (error instanceof PlayDocumentToolFailure)
      return toolFailure(error.message, error.failureKind, locale);
    throw error;
  }
}

function permitsPatch(
  authorization: AuthorizedLocator[] | null | undefined,
  edits: unknown[],
): authorization is AuthorizedLocator[] | null {
  if (authorization == null) return authorization === null;
  for (const edit of edits) {
    if (!record(edit) || edit.op === "set_metadata") return false;
    const { locator } = edit;
    if (
      (!validYamlLocator(locator) && !validMarkdownLocator(locator, true)) ||
      !authorization.some((allowed) => includesScope(allowed, locator))
    )
      return false;
    // A batch cannot spend the scope for a deleted item on its unread successor.
    const scopeEdit = patchScopeEdit(edit);
    if (scopeEdit !== null)
      authorization = scopesAfterPatch(authorization, [scopeEdit]);
  }
  return true;
}

function patchScopeEdit(edit: unknown): PatchScopeEdit | null {
  if (!record(edit)) return null;
  const { op, locator } = edit;
  if (
    op !== "add" &&
    op !== "remove" &&
    op !== "remove_section" &&
    op !== "rename_section" &&
    op !== "replace" &&
    op !== "replace_section"
  )
    return null;
  return validYamlLocator(locator) || validMarkdownLocator(locator, true)
    ? { op, locator }
    : null;
}

function includesScope(
  outer: AuthorizedLocator,
  inner: AuthorizedLocator,
): boolean {
  if ("yaml" in outer)
    return "yaml" in inner && locatorStartsWith(inner.yaml, outer.yaml);
  return (
    "markdown" in inner && locatorStartsWith(inner.markdown, outer.markdown)
  );
}

function scopesAfterPatch(
  scopes: AuthorizedLocator[],
  edits: readonly PatchScopeEdit[],
): AuthorizedLocator[] {
  return scopes.filter((scope) =>
    edits.every(({ op, locator }) => {
      if (op === "remove" && "yaml" in locator && "yaml" in scope) {
        const index = locator.yaml.length - 1;
        const removed = locator.yaml[index];
        const current = scope.yaml[index];
        if (
          typeof removed === "number" &&
          typeof current === "number" &&
          current >= removed &&
          locatorStartsWith(scope.yaml, locator.yaml.slice(0, index))
        )
          return false;
      }
      if (!includesScope(locator, scope)) return true;
      return (
        (op === "add" || op === "replace" || op === "replace_section") &&
        includesScope(scope, locator)
      );
    }),
  );
}

function legacyPatchAuthorization(
  args: unknown,
): PlayDocumentToolResult["patchAuthorization"] {
  if (!record(args) || typeof args.target !== "string") return undefined;
  const schema = runtimeToolInputSchema("world_patch");
  // Old receipts predate locator repair. Keep their original interpretation
  // so an edit that used to fail cannot revoke a restored read scope.
  const repaired =
    schema === null ? args : coerceToolArguments(schema, args).arguments;
  if (!record(repaired) || !Array.isArray(repaired.edits)) return undefined;
  // Older settlements retain the requested edits. Where they did not record
  // per-edit outcomes, revoke any scope that an accepted edit could invalidate.
  const edits = repaired.edits.flatMap((edit) => {
    const scopeEdit = patchScopeEdit(edit);
    return scopeEdit === null ? [] : [scopeEdit];
  });
  return { shortRef: args.target.replace(/^@/u, ""), edits };
}

function formatToolEditDetails(
  outcomes: readonly WorldDocumentEditOutcome[],
  locale: AppLocale,
): string {
  const applied = outcomes.filter(({ status }) => status === "applied").length;
  if (applied === outcomes.length) return "";
  return [
    locale === "zh-CN"
      ? `已应用 ${applied}/${outcomes.length} 条编辑`
      : `${applied}/${outcomes.length} edits applied`,
    formatEditNotes(outcomes, locale),
    outcomes.some(({ status }) => status === "failed")
      ? locale === "zh-CN"
        ? "如需重试，请仅重发被拒绝的编辑"
        : "Resend only rejected edits if needed"
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Lists only the edits that did not apply cleanly: failed ones and no-ops. */
function formatEditNotes(
  outcomes: readonly WorldDocumentEditOutcome[],
  locale: AppLocale,
): string {
  return outcomes
    .flatMap(({ editIndex, status, diagnostic }) => {
      if (status === "applied" || diagnostic === undefined) return [];
      const label =
        locale === "zh-CN"
          ? `第 ${editIndex + 1} 条编辑`
          : `edit #${editIndex + 1}`;
      if (status === "no_op")
        return [
          locale === "zh-CN"
            ? `${label}无变化：目标不存在`
            : `${label} no-op: ${diagnostic.message}`,
        ];
      const location = diagnostic.locator
        ? ` (${formatWorldDocumentLocator(diagnostic.locator)})`
        : "";
      return [
        locale === "zh-CN"
          ? `${label}${location}失败：${diagnostic.message}`
          : `${label}${location}: ${diagnostic.message}`,
      ];
    })
    .join(" · ");
}

function applyPlayCandidateRetirement(
  candidate: PlayCandidate,
  reads: WriteAuthorizations,
  args: unknown,
  locale: AppLocale,
): PlayDocumentToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["target", "retired"]) ||
    typeof args.target !== "string" ||
    typeof args.retired !== "boolean"
  )
    return toolFailure(
      locale === "zh-CN"
        ? "world_retire 只接受目标和布尔值 retired。"
        : "world_retire requires exactly a target and boolean retired value.",
      "protocol",
      locale,
    );
  const ref = args.target.replace(/^@/u, "");
  const target = documentDescriptorByRef(candidate.snapshot, ref);
  if (target === null) return missingWriteTarget(ref, locale);
  if (
    reads.snapshotId !== candidate.snapshot.id ||
    reads.documents.get(ref) !== null
  )
    return toolFailure(
      locale === "zh-CN"
        ? `退役或恢复前请精确读取 @${ref}，或在初始化材料中获取该文档全文。`
        : `Read @${ref} exactly, or receive the complete document in bootstrap, before retiring or restoring it.`,
      "protocol",
      locale,
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
      writeRevisionFailure(revised.diagnostics, locale),
      "candidate",
      locale,
    );
  const changed = revised.changes.length > 0;
  const previousSnapshot = candidate.snapshot;
  acceptWorldStateRevision(candidate, revised);
  carryWriteAuthorizations(previousSnapshot, candidate, reads, revised.changes);
  authorizeRead(reads, candidate.snapshot.id, ref, null);
  return {
    ok: true,
    markdown: changed
      ? locale === "zh-CN"
        ? `@${target.shortRef} ${args.retired ? "待退役" : "待恢复"}`
        : `@${target.shortRef} pending ${args.retired ? "retirement" : "restoration"}`
      : `@${target.shortRef} ${writeReceiptStatus[locale].unchanged}`,
    candidateWrite: {
      shortRef: target.shortRef,
      changed,
      retired: args.retired,
    },
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
  locale: AppLocale,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value))
    throw new PlayDocumentToolFailure(
      locale === "zh-CN"
        ? "工具参数不能包含循环引用"
        : "Tool arguments must not contain circular references",
    );
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertToolReferenceHandles(item, locale, seen);
    seen.delete(value);
    return;
  }
  if (!record(value))
    throw new PlayDocumentToolFailure(
      locale === "zh-CN"
        ? "工具参数中的对象必须是普通对象"
        : "Tool arguments may contain only plain objects",
    );
  if (
    Object.hasOwn(value, "$ref") &&
    (Object.keys(value).length !== 1 ||
      typeof value.$ref !== "string" ||
      !value.$ref.startsWith("@"))
  )
    throw new PlayDocumentToolFailure(
      locale === "zh-CN"
        ? "$ref 必须使用 Runtime 返回的 @短引用，且引用对象不能包含其他字段"
        : "$ref must use an @short-ref returned by the Runtime, and a reference object cannot contain other fields",
    );
  for (const item of Object.values(value))
    assertToolReferenceHandles(item, locale, seen);
  seen.delete(value);
}

function applyPlayCandidateCreate(
  candidate: PlayCandidate,
  authorizations: WriteAuthorizations,
  args: unknown,
  declaredDirectories: readonly string[],
  locale: AppLocale,
): PlayDocumentToolResult {
  try {
    const parentDirectory =
      record(args) && typeof args.parent === "string"
        ? parseStateDirectoryHandle(args.parent)
        : null;
    if (record(args) && typeof args.aliases === "string")
      throw new PlayDocumentToolFailure(
        locale === "zh-CN"
          ? "world_create.aliases 必须是由字符串组成的 JSON 数组，不能传字符串"
          : "world_create.aliases must be a JSON array of strings, not a string",
      );
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
      throw new PlayDocumentToolFailure(
        locale === "zh-CN"
          ? "world_create 参数无效"
          : "world_create arguments are invalid",
      );
    if (
      !knownStateDirectory(
        candidate.snapshot,
        parentDirectory,
        declaredDirectories,
      )
    )
      throw new PlayDocumentToolFailure(
        locale === "zh-CN"
          ? "world_create 的 parent 必须是 Runtime 已知的状态目录，请调用 state_list 并使用返回的目录句柄"
          : "world_create parent is not a Runtime-known state directory; call state_list and use one of its directory handles",
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
    if (command.codec === "yaml")
      assertToolReferenceHandles(command.body, locale);
    const revised = candidate.snapshot.revise({
      commands: [command],
    });
    if (!revised.ok || revised.snapshotStatus !== "usable")
      throw new PlayDocumentToolFailure(
        writeRevisionFailure(revised.diagnostics, locale),
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
      markdown: `@${created.shortRef} ${locale === "zh-CN" ? "待写入" : "pending write"}`,
      candidateWrite: { shortRef: created.shortRef, changed: true },
    };
  } catch (error: unknown) {
    if (error instanceof PlayDocumentToolFailure)
      return toolFailure(error.message, error.failureKind, locale);
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

function missingWriteTarget(ref: string, locale: AppLocale) {
  return toolFailure(
    locale === "zh-CN"
      ? `目标 @${ref} 不存在。`
      : `Target @${ref} does not exist.`,
    "protocol",
    locale,
  );
}

function writeRevisionFailure(
  diagnostics: Parameters<typeof worldDocumentRevisionFailureMessage>[0],
  locale: AppLocale,
): string {
  if (locale === "en") return worldDocumentRevisionFailureMessage(diagnostics);
  if (diagnostics.length === 0) return "文档修订无效。";
  return `文档修订无效。详细原因：${worldDocumentRevisionFailureMessage(diagnostics)}`;
}

function toolFailure(
  message: string,
  failureKind: "protocol" | "candidate" = "protocol",
  locale: AppLocale = "en",
): PlayDocumentToolResult {
  return {
    ok: false,
    markdown: `# ${locale === "zh-CN" ? "Runtime 拒绝了工具调用" : "Runtime tool rejected"}\n\n${message}`,
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

  return toolFailure("Use history_search for committed history.");
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
  args: unknown,
  declaredDirectories: readonly string[],
  locale: AppLocale,
): ContextToolResult {
  // Frozen sessions may still send obsolete cursor/limit; directories are
  // listed in full, so those keys are accepted and ignored.
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["parent", "cursor", "limit"]) ||
    typeof args.parent !== "string" ||
    parseStateDirectoryHandle(args.parent) === null
  )
    return stateReadArgumentError(
      locale === "zh-CN"
        ? "state_list 的 parent 必须是 Runtime 返回的 @dir-*；已提交历史用 history_list。"
        : "state_list requires an @dir-* parent returned by Runtime; use history_list for committed history.",
      locale,
    );
  return listStateDirectory(snapshot, args.parent, declaredDirectories, locale);
}

function executeContextList(
  snapshot: WorldDocumentStore,
  args: unknown,
  declaredDirectories: readonly string[],
  locale: AppLocale,
): ContextToolResult {
  if (!record(args) || (args.source !== "state" && args.source !== "history"))
    return stateReadArgumentError(
      locale === "zh-CN"
        ? '状态目录请用 {source:"state", parent:"@dir-/"}，已提交历史请用 history_list。'
        : 'Use {source:"state", parent:"@dir-/"} for state directories and {source:"history", order:"newest_first"} for history.',
      locale,
    );
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
    invalidHistoryShape
  )
    return stateReadArgumentError(
      locale === "zh-CN"
        ? "状态目录请使用 Runtime 返回的 @dir-* 作为 parent，并省略 order；历史排序须为 newest_first 或 oldest_first，并省略 parent。"
        : "state must use an @dir-* parent returned by the Runtime and omit order; history must use newest_first or oldest_first order and omit parent.",
      locale,
    );
  if (args.source === "state")
    return listStateDirectory(
      snapshot,
      args.parent as string,
      declaredDirectories,
      locale,
    );

  return toolFailure(
    locale === "zh-CN"
      ? "已提交历史请用 history_list。"
      : "Use history_list for committed history.",
    "protocol",
    locale,
  );
}

function listStateDirectory(
  snapshot: WorldDocumentStore,
  parent: string,
  declaredDirectories: readonly string[],
  locale: AppLocale,
): ContextToolResult {
  const zh = locale === "zh-CN";
  const directory = parseStateDirectoryHandle(parent);
  if (directory === null) return unexpectedStateQueryResult(locale);
  if (!knownStateDirectory(snapshot, directory, declaredDirectories))
    return stateReadArgumentError(
      zh
        ? "此 parent 不在 Runtime 已知的状态目录中。请调用 state_list，并只使用回执返回的目录句柄逐级查找。"
        : "The parent is not a Runtime-known state directory; call state_list and descend only through its returned directory handles.",
      locale,
    );
  const entries: string[] = [];
  let complete = true;
  let cursor: string | null = null;
  do {
    const result = snapshot.query({
      kind: "catalog",
      directory,
      includeRetired: true,
      declaredDirectories,
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    });
    if (result.kind === "error") return renderStateQueryFailure(result, locale);
    if (result.kind !== "catalog") return unexpectedStateQueryResult(locale);
    if (result.coverage.status !== "complete") complete = false;
    entries.push(
      ...result.entries.map((entry) => {
        if (entry.kind === "directory") {
          const relative = entry.logicalPath.slice(
            `${snapshot.logicalRoot}/`.length,
          );
          return `- ${zh ? "目录" : "Directory"} ${stateDirectoryHandle(relative)}`;
        }
        const { document } = entry;
        if (document === undefined)
          return zh
            ? "- 文档已损坏（当前无法定位）"
            : "- Damaged document (currently not addressable)";
        const retired = document.retired
          ? zh
            ? " · 已退役"
            : " · retired"
          : "";
        const damaged =
          entry.status === "damaged"
            ? zh
              ? " · 待修复"
              : " · needs repair"
            : "";
        return `- ${zh ? "文档" : "Document"} @${document.shortRef} · ${document.title} · ${document.codec.toUpperCase()} · ${document.summary}${retired}${damaged}`;
      }),
    );
    cursor = result.page.nextCursor;
  } while (cursor !== null);
  const coverage = complete
    ? zh
      ? "完整"
      : "complete"
    : zh
      ? "部分"
      : "partial";
  return {
    ok: true,
    markdown: `# ${zh ? "目录列表" : "Directory listing"}\n\n${stateReceiptScope(parent, locale)}\n${zh ? "覆盖：" : "Coverage: "}${coverage}\n${entries.join("\n") || (zh ? "（空）" : "(empty)")}\n\n---\n${stateReceiptComplete(locale)}`,
  };
}

function executeContextRead(
  snapshot: WorldDocumentStore,
  args: unknown,
  locale: AppLocale,
): ContextToolResult {
  if (
    !record(args) ||
    // Frozen contexts created before complete exact reads still advertise
    // cursor/maxBytes. Accept and ignore those obsolete arguments so an
    // existing Provider continuation can cross the upgrade boundary.
    !hasOnlyToolKeys(args, ["ref", "cursor", "maxBytes"]) ||
    typeof args.ref !== "string"
  )
    return stateReadArgumentError(
      locale === "zh-CN"
        ? "需要 Runtime 返回的稳定 ref。"
        : "A stable ref returned by list or search is required.",
      locale,
    );
  const handle = parseStateReadHandle(args.ref);
  if (handle === null)
    return stateReadArgumentError(
      locale === "zh-CN"
        ? "精确读取状态需要文档 @短引用，或它的 #/逻辑节点。"
        : "An exact state read requires a document @short-ref or one of its #/logical nodes.",
      locale,
    );
  const resolved = snapshot.query({
    kind: "read_document",
    document: { shortRef: handle.shortRef },
  });
  if (resolved.kind === "error")
    return renderStateQueryFailure(resolved, locale);
  if (resolved.kind !== "read_document")
    return unexpectedStateQueryResult(locale);
  if (handle.path === null)
    return resolved.codec === "markdown"
      ? renderStateRead(
          snapshot,
          resolved.document,
          args.ref,
          resolved.body.trimEnd(),
          null,
          locale,
        )
      : readProjectedNode(
          snapshot,
          resolved.document,
          { yaml: [] },
          args.ref,
          true,
          locale,
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
    locale,
  );
}

function readProjectedNode(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
  locator: WorldDocumentLocator,
  requestedHandle: string,
  wholeDocument: boolean,
  locale: AppLocale,
): ContextToolResult {
  const result = snapshot.query({
    kind: "select_node",
    document: { shortRef: document.shortRef },
    locator,
  });
  if (result.kind === "error") return renderStateQueryFailure(result, locale);
  if (result.kind !== "select_node") return unexpectedStateQueryResult(locale);
  const body =
    result.node.codec === "yaml"
      ? stringify(toolWorldDocumentValue(result.node.value), {
          indent: 2,
          lineWidth: 0,
        }).trimEnd()
      : result.node.markdown.trimEnd();
  return renderStateRead(
    snapshot,
    document,
    requestedHandle,
    body,
    wholeDocument ? null : result.node.locator,
    locale,
  );
}

function renderStateRead(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
  handle: string,
  body: string,
  locator: WorldDocumentLocator | null,
  locale: AppLocale,
): ContextToolResult {
  const zh = locale === "zh-CN";
  const text =
    locator === null
      ? `${renderDocumentMetadata(document, locale)}\n${zh ? "[可写正文开始，定位从此处起算]" : "[Writable body starts; locators are relative to this point]"}\n${body}\n${zh ? "[可写正文结束]" : "[Writable body ends]"}`
      : `# ${document.title} · ${renderLocator(locator)} [${handle}]\n\n${body}`;
  const writeScope =
    locator === null
      ? zh
        ? "写入范围：整份文档的正文及元数据。"
        : "Write scope: whole document body and metadata."
      : zh
        ? "写入范围：该节点及其子节点。"
        : "Write scope: this node and its descendants.";
  return {
    ok: true,
    markdown: `# ${zh ? "精确读取" : "Exact read"} ${handle}\n\n${text.trimEnd()}\n\n${renderPlayerViewBindings(snapshot, document.shortRef, locale)}\n\n---\n${stateReceiptScope(handle, locale)}\n${writeScope}\n${stateReceiptComplete(locale)}`,
    readAuthorization: {
      snapshotId: snapshot.id,
      shortRef: document.shortRef,
      locator,
    },
  };
}

function renderDocumentMetadata(
  document: WorldDocumentDescriptor,
  locale: AppLocale,
): string {
  const metadata = stringify(
    {
      title: document.title,
      summary: document.summary,
      aliases: document.aliases,
      ...(document.retired ? { retired: true } : {}),
    },
    { indent: 2, lineWidth: 0 },
  ).trimEnd();
  const heading =
    locale === "zh-CN"
      ? "[文档元数据，位于正文之外。用 set_metadata 更新一项或多项，省略项保持原样。retired 只能用 world_retire 修改。]"
      : "[Document metadata: not body content; set_metadata updates one or more fields and preserves omitted fields; retired is changed only by world_retire]";
  return `${heading}\n${metadata}`;
}

function stateReceiptScope(handle: string, locale: AppLocale): string {
  return `${locale === "zh-CN" ? "范围：状态" : "Scope: state"} · ${handle}`;
}

function stateReceiptComplete(locale: AppLocale): string {
  return locale === "zh-CN" ? "完整返回：是" : "Complete: yes";
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
  locale: AppLocale = "en",
): ContextToolResult {
  return stateReadArgumentError(
    result.diagnostics
      .map(({ code, message }) => `${code}: ${message}`)
      .join("\n"),
    locale,
  );
}

function stateReadArgumentError(
  message: string,
  locale: AppLocale,
): ContextToolResult {
  return {
    ok: false,
    markdown: `# ${locale === "zh-CN" ? "Runtime 参数错误" : "Runtime argument error"}\n\n${message}`,
  };
}

function unexpectedStateQueryResult(
  locale: AppLocale = "en",
): ContextToolResult {
  return {
    ok: false,
    markdown:
      locale === "zh-CN"
        ? "# Runtime 拒绝了工具调用\n\n世界文档查询返回了不兼容的结果类型。"
        : "# Runtime tool rejected\n\nThe world-document query returned an incompatible result type.",
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
