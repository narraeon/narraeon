import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { stringify } from "yaml";

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
}

export interface ContextToolBudgetRequest {
  requestedResultBytes: number;
  previewMarkdown: string;
  retryParameter: "max_bytes" | "limit";
  retryMinimum: number;
  retryMaximum: number;
  restartWithoutCursor: boolean;
}

export interface ContextToolRetryPreview {
  call: ModelHostToolCall;
  markdown: string;
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
  #reads: WriteAuthorizations;

  constructor(files: Readonly<Record<string, string>>) {
    this.#candidate = openPlayCandidate({ ...files });
    this.#reads = {
      snapshotId: this.#candidate.snapshot.id,
      documents: new Map(),
      pendingReads: new Map(),
    };
  }

  get snapshot(): WorldDocumentStore {
    return this.#candidate.snapshot;
  }

  bindBootstrap(bootstrap: PromptCompilation): void {
    this.#reads = bootstrapAuthorizations(bootstrap, this.#candidate.snapshot);
  }

  contextToolBudgetRequest(
    call: ModelHostToolCall,
    history: { path: string; contents: string }[],
  ): ContextToolBudgetRequest | null {
    const preview = previewContextToolResult(
      this.#candidate.snapshot,
      history,
      call,
    );
    if (preview === null) return null;
    const retryParameter = call.name === "context_read" ? "max_bytes" : "limit";
    return {
      requestedResultBytes: Buffer.byteLength(preview.markdown, "utf8"),
      previewMarkdown: preview.markdown,
      retryParameter,
      retryMinimum: call.name === "context_read" ? 4 : 1,
      retryMaximum: contextToolRetryMaximum(call),
      restartWithoutCursor:
        record(call.arguments) && typeof call.arguments.cursor === "string",
    };
  }

  contextToolRetryPreview(
    call: ModelHostToolCall,
    history: { path: string; contents: string }[],
    retryValue: number,
  ): ContextToolRetryPreview {
    const argumentsWithoutCursor = record(call.arguments)
      ? Object.fromEntries(
          Object.entries(call.arguments).filter(([key]) => key !== "cursor"),
        )
      : {};
    const retryCall: ModelHostToolCall = {
      ...structuredClone(call),
      id: `${call.id}-budget-retry`,
      arguments: {
        ...argumentsWithoutCursor,
        [call.name === "context_read" ? "maxBytes" : "limit"]: retryValue,
      },
    };
    const preview = previewContextToolResult(
      this.#candidate.snapshot,
      history,
      retryCall,
    );
    if (preview === null)
      throw new TypeError("context tool retry preview requires a read tool");
    return { call: retryCall, markdown: preview.markdown };
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
    if (call.name === "context_list")
      return executeContextList(
        this.#candidate.snapshot,
        history,
        call.arguments,
      );
    if (call.name === "context_read") {
      const result = executeContextRead(
        this.#candidate.snapshot,
        history,
        call.arguments,
      );
      authorizeToolRead(this.#reads, this.#candidate.snapshot, result);
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
      );
    return toolFailure(`当前文档上下文不接受 ${call.name}`);
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
    this.#candidate.changes.clear();
    this.#candidate.suppliedBytes = 0;
  }
}

interface PlayCandidate extends WorldStateRevision {
  suppliedBytes: number;
}

type AuthorizedLocator = WorldDocumentLocator;
interface WriteAuthorizations {
  snapshotId: string;
  documents: Map<string, AuthorizedLocator[] | null>;
  pendingReads: Map<
    string,
    {
      shortRef: string;
      locator: AuthorizedLocator | null;
      nextOffset: number;
      totalBytes: number;
    }
  >;
}

function bootstrapAuthorizations(
  bootstrap: PromptCompilation,
  snapshot: WorldDocumentStore,
): WriteAuthorizations {
  const result: WriteAuthorizations = {
    snapshotId: snapshot.id,
    documents: new Map(),
    pendingReads: new Map(),
  };
  for (const { status, complete, readAuthorization } of bootstrap.coverage) {
    if (status !== "resolved" || !complete || readAuthorization === undefined)
      continue;
    if (readAuthorization.locator === null) {
      const resolved = snapshot.query({
        kind: "read_document",
        document: { shortRef: readAuthorization.shortRef },
        maxBytes: 4,
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
  const { page } = authorization;
  let progress = authorizations.pendingReads.get(authorization.readKey);
  if (page.start === 0) {
    progress = {
      shortRef: authorization.shortRef,
      locator: authorization.locator,
      nextOffset: page.end,
      totalBytes: page.total,
    };
    authorizations.pendingReads.set(authorization.readKey, progress);
  } else {
    if (progress === undefined) return;
    if (
      progress.shortRef !== authorization.shortRef ||
      !sameLocator(progress.locator, authorization.locator) ||
      progress.nextOffset !== page.start ||
      progress.totalBytes !== page.total
    )
      return;
    progress.nextOffset = page.end;
  }
  if (progress.nextOffset !== progress.totalBytes) return;
  authorizeRead(
    authorizations,
    snapshot.id,
    progress.shortRef,
    progress.locator,
  );
  authorizations.pendingReads.delete(authorization.readKey);
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
  return {
    ...beginWorldStateRevision(files),
    suppliedBytes: 0,
  };
}

function documentDescriptorByRef(
  snapshot: WorldDocumentStore,
  ref: string,
): WorldDocumentDescriptor | null {
  const result = snapshot.query({
    kind: "read_document",
    document: { shortRef: ref },
    maxBytes: 4,
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
    return toolFailure("world_patch 需要 target 和 1 到 32 个 edits。");
  const ref = args.target.replace(/^@/u, "");
  const target = documentDescriptorByRef(candidate.snapshot, ref);
  if (target === null) return toolFailure(`目标 @${ref} 不存在。`);
  const retainedAuthorization = reads.documents.get(ref);
  if (
    reads.snapshotId !== candidate.snapshot.id ||
    retainedAuthorization === undefined ||
    !editsAreAuthorized(retainedAuthorization, args.edits)
  )
    return toolFailure(
      `必须先精确读取 @${ref} 或 bootstrap 完整提供该文档，才能写入。`,
    );
  try {
    const suppliedBytes = Buffer.byteLength(JSON.stringify(args.edits), "utf8");
    if (suppliedBytes > 64 * 1024)
      throw new PlayDocumentToolFailure("单次 patch 正文超过 64 KiB");
    if (candidate.suppliedBytes + suppliedBytes > 256 * 1024)
      throw new PlayDocumentToolFailure("本次模型操作累计新正文超过 256 KiB");
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
    const receipt = formatToolRevisionReceipt(revised.changes);
    const previousSnapshot = candidate.snapshot;
    acceptWorldStateRevision(candidate, revised);
    candidate.suppliedBytes += suppliedBytes;
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
  changes: readonly WorldDocumentRevisionChange[],
): string {
  if (changes.length === 0) return "# world_patch 成功\n\n文档未发生变化。";
  if (changes.length !== 1)
    throw new Error("world_patch revision 必须只影响目标文档");
  return "# world_patch 成功\n\n文档已发生变化。";
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
    throw new PlayDocumentToolFailure("工具参数不能包含循环引用");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertToolReferenceHandles(item, seen);
    seen.delete(value);
    return;
  }
  if (!record(value))
    throw new PlayDocumentToolFailure("工具参数只能包含普通对象");
  if (
    Object.hasOwn(value, "$ref") &&
    (Object.keys(value).length !== 1 ||
      typeof value.$ref !== "string" ||
      !value.$ref.startsWith("@"))
  )
    throw new PlayDocumentToolFailure(
      "$ref 必须使用 Runtime 返回的 @短引用，且引用对象不能包含其他字段",
    );
  for (const item of Object.values(value))
    assertToolReferenceHandles(item, seen);
  seen.delete(value);
}

function applyPlayCandidateCreate(
  candidate: PlayCandidate,
  authorizations: WriteAuthorizations,
  args: unknown,
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
      throw new PlayDocumentToolFailure("world_create 参数无效");
    const suppliedBytes = Buffer.byteLength(args.body, "utf8");
    if (suppliedBytes > 64 * 1024)
      throw new PlayDocumentToolFailure("world_create body 超过 64 KiB");
    if (candidate.suppliedBytes + suppliedBytes > 256 * 1024)
      throw new PlayDocumentToolFailure("本次模型操作累计新正文超过 256 KiB");
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
      throw new Error("world_create revision 没有返回新建文档变化");
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
    candidate.suppliedBytes += suppliedBytes;
    return {
      ok: true,
      markdown: `# 已创建候选文档\n\n- 名称：${String(args.title)}\n- 引用：@${created.shortRef}\n- codec：${String(args.codec).toUpperCase()}\n\n后续工具调用请使用 \`@${created.shortRef}\`。该文档仍是未提交候选。`,
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
  for (const [readKey, progress] of authorizations.pendingReads)
    if (stale.has(progress.shortRef))
      authorizations.pendingReads.delete(readKey);
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
    maxBytes: 4,
  });
  return result.kind === "read_document" && result.ok ? result.document : null;
}

function toolFailure(
  message: string,
  failureKind: "protocol" | "candidate" = "protocol",
): PlayDocumentToolResult {
  return {
    ok: false,
    markdown: `# Runtime 工具拒绝\n\n${message}`,
    failureKind,
  };
}

interface ContextToolResult {
  ok: boolean;
  markdown: string;
  failureKind?: "protocol" | "candidate";
  readAuthorization?: {
    snapshotId: string;
    readKey: string;
    shortRef: string;
    locator: AuthorizedLocator | null;
    page: {
      start: number;
      end: number;
      total: number;
    };
  };
}

function previewContextToolResult(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  call: ModelHostToolCall,
): ContextToolResult | null {
  if (call.name === "context_list")
    return executeContextList(snapshot, history, call.arguments);
  if (call.name === "context_search")
    return executeContextSearch(snapshot, history, call.arguments);
  if (call.name === "context_read")
    return executeContextRead(snapshot, history, call.arguments);
  return null;
}

function contextToolRetryMaximum(call: ModelHostToolCall): number {
  if (!record(call.arguments)) return call.name === "context_read" ? 8_192 : 1;
  if (call.name === "context_read")
    return Number.isInteger(call.arguments.maxBytes) &&
      Number(call.arguments.maxBytes) >= 4 &&
      Number(call.arguments.maxBytes) <= 8_192
      ? Number(call.arguments.maxBytes)
      : 8_192;
  const defaultLimit = call.name === "context_search" ? 10 : 20;
  const maximumLimit = call.name === "context_search" ? 50 : 100;
  return Number.isInteger(call.arguments.limit) &&
    Number(call.arguments.limit) >= 1 &&
    Number(call.arguments.limit) <= maximumLimit
    ? Number(call.arguments.limit)
    : defaultLimit;
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
        "# Runtime 参数错误\n\ncontext_search 只接受 query 字面量以及严格的 source、within、caseSensitive、limit、cursor；不接受语义过滤器。",
    };
  const caseSensitive = args.caseSensitive === true;
  const query = args.query;
  const limit = typeof args.limit === "number" ? args.limit : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\nlimit 必须为 1 到 50。",
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
      markdown: "# Runtime 参数错误\n\ncursor 与搜索条件或端点不匹配。",
    };
  const hits = allHits.slice(offset, offset + limit);
  const complete = offset + hits.length >= allHits.length;
  const renderedHits = hits
    .map(
      ([ref, text]) =>
        `- @${ref}\n  原始命中片段：\n${quoteMarkdown(snippet(text, query), "  ")}`,
    )
    .join("\n");
  return {
    ok: true,
    markdown: `# 字面搜索\n\n范围：history${args.within === undefined ? "" : ` · ${args.within}`}\nnormalization：${caseSensitive ? "原文" : "NFKC + 大小写折叠"}\n命中总数：${allHits.length}\n${renderedHits || "0 个字面命中不证明世界中不存在该事实。"}\n\n---\n本页：${offset}..${offset + hits.length} / ${allHits.length} 个命中\n完整：${complete ? "是" : "否"}${complete ? "" : `\n下一页 cursor：${cursorFor(scope, offset + hits.length)}`}`,
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
        "# Runtime 参数错误\n\nstate 搜索范围必须是 Runtime 返回的 @dir-* 或 @文档短引用。",
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
        `- @${document.shortRef} · ${document.title} · 第 ${range.start.line} 行第 ${range.start.column} 列\n  原始命中：${JSON.stringify(referenceProjection.text)}\n  原始命中片段（机械引用显示为 @短引用）：\n${quoteMarkdown(referenceProjection.excerpt, "  ")}`,
    )
    .join("\n");
  const scope =
    input.within === undefined ? "state" : `state · ${input.within}`;
  return {
    ok: true,
    markdown: `# 字面搜索\n\n范围：${scope}\nnormalization：${input.caseSensitive ? "原文" : "NFKC + 大小写折叠"}\n覆盖：${result.coverage.status === "complete" ? "完整" : `部分（排除 ${result.coverage.excludedDocuments} 份损坏文档）`}\n命中总数：${result.page.total}\n${renderedHits || "0 个字面命中不证明世界中不存在该事实。"}\n\n---\n本页：${result.page.start}..${result.page.end} / ${result.page.total} 个命中\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
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

function executeContextList(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
): ContextToolResult {
  if (!record(args) || (args.source !== "state" && args.source !== "history"))
    return {
      ok: false,
      markdown:
        '# Runtime 参数错误\n\n状态目录使用 {source:"state", parent:"@dir-/"}；历史使用 {source:"history", order:"newest_first"}。',
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
        "# Runtime 参数错误\n\nstate 必须使用 Runtime 返回的 @dir-* parent 且不能带 order；history 必须带 newest_first 或 oldest_first order 且不能带 parent。",
    };
  const limit = typeof args.limit === "number" ? args.limit : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\nlimit 必须为 1 到 100。",
    };
  if (args.source === "state") {
    const parent = args.parent as string;
    const directory = parseStateDirectoryHandle(parent);
    if (directory === null) return unexpectedStateQueryResult();
    const result = snapshot.query({
      kind: "catalog",
      directory,
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
        return `- 目录 ${stateDirectoryHandle(relative)}`;
      }
      if (entry.document === undefined) return "- 损坏文档（当前不可寻址）";
      return `- 文档 @${entry.document.shortRef} · ${entry.document.title} · ${entry.document.codec.toUpperCase()} · ${entry.document.summary}${entry.status === "damaged" ? " · 待修复" : ""}`;
    });
    return {
      ok: true,
      markdown: `# 目录列表\n\n范围：state · ${parent}\n覆盖：${result.coverage.status === "complete" ? "完整" : "部分"}\n${entries.join("\n") || "（空）"}\n\n---\n本页：${result.page.start}..${result.page.end} / ${result.page.total} 项\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
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
        `- @${historyRef(path)}，${Buffer.byteLength(contents, "utf8")} bytes`,
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
      markdown: "# Runtime 参数错误\n\ncursor 与列表条件或端点不匹配。",
    };
  const page = entries.slice(offset, offset + limit);
  const complete = offset + page.length >= entries.length;
  return {
    ok: true,
    markdown: `# 目录列表\n\n范围：history · ${String(args.order)}\n${page.join("\n") || "（空）"}\n\n---\n本页：${offset}..${offset + page.length} / ${entries.length} 项\n完整：${complete ? "是" : "否"}${complete ? "" : `\n下一页 cursor：${cursorFor(scope, offset + page.length)}`}`,
  };
}

function executeContextRead(
  snapshot: WorldDocumentStore,
  history: { path: string; contents: string }[],
  args: unknown,
): ContextToolResult {
  if (
    !record(args) ||
    !hasOnlyToolKeys(args, ["ref", "cursor", "maxBytes"]) ||
    typeof args.ref !== "string" ||
    (args.maxBytes !== undefined && typeof args.maxBytes !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\n需要 list/search 返回的稳定 ref。",
    };
  const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 8192;
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 8192)
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\nmaxBytes 必须为 4 到 8192。",
    };
  const historyRefValue = args.ref.replace(/^@/u, "");
  const historyEntry = history.find(
    ({ path }) => historyRef(path) === historyRefValue,
  );
  if (historyEntry !== undefined)
    return pagedRead(
      historyRefValue,
      historyEntry.contents,
      maxBytes,
      args.cursor,
    );

  const handle = parseStateReadHandle(args.ref);
  if (handle === null)
    return {
      ok: false,
      markdown:
        "# Runtime 参数错误\n\nstate 精确读取需要 @文档短引用或其 #/逻辑节点。",
    };
  const resolved = snapshot.query({
    kind: "read_document",
    document: { shortRef: handle.shortRef },
    maxBytes: 4,
  });
  if (resolved.kind === "error") return renderStateQueryFailure(resolved);
  if (resolved.kind !== "read_document") return unexpectedStateQueryResult();
  if (handle.path === null)
    return resolved.codec === "markdown"
      ? readMarkdownDocument(snapshot, resolved.document, maxBytes, args.cursor)
      : readProjectedNode(
          snapshot,
          resolved.document,
          { yaml: [] },
          args.ref,
          maxBytes,
          args.cursor,
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
    maxBytes,
    args.cursor,
    false,
  );
}

function readMarkdownDocument(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
  maxBytes: number,
  cursor: unknown,
): ContextToolResult {
  const result = snapshot.query({
    kind: "read_document",
    document: { shortRef: document.shortRef },
    maxBytes,
    ...(typeof cursor === "string" || cursor === null ? { cursor } : {}),
  });
  if (result.kind === "error") return renderStateQueryFailure(result);
  if (result.kind !== "read_document") return unexpectedStateQueryResult();
  return {
    ok: true,
    markdown: `# 精确读取 @${document.shortRef}\n\n${renderDocumentMetadata(document)}\n[可写正文开始；locator 相对于这里]\n${result.body.trimEnd()}\n[可写正文${result.page.complete ? "结束" : "继续"}]\n\n---\n范围：state · @${document.shortRef}\n本页：${result.page.start}..${result.page.end} / ${result.page.total} bytes\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
    readAuthorization: {
      snapshotId: snapshot.id,
      readKey: readAuthorizationKey(document.shortRef, null, maxBytes),
      shortRef: document.shortRef,
      locator: null,
      page: {
        start: result.page.start,
        end: result.page.end,
        total: result.page.total,
      },
    },
  };
}

function readProjectedNode(
  snapshot: WorldDocumentStore,
  document: WorldDocumentDescriptor,
  locator: WorldDocumentLocator,
  requestedHandle: string,
  maxBytes: number,
  cursor: unknown,
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
    ? `${renderDocumentMetadata(document)}\n[可写正文开始；locator 相对于这里]\n${body}\n[可写正文结束]\n`
    : `# ${document.title} · ${renderLocator(result.node.locator)} [${requestedHandle}]\n\n${body}\n`;
  return pagedStateProjection(
    snapshot,
    requestedHandle,
    text,
    maxBytes,
    cursor,
    document.shortRef,
    wholeDocument ? null : result.node.locator,
  );
}

function renderDocumentMetadata(document: WorldDocumentDescriptor): string {
  const metadata = stringify(
    {
      title: document.title,
      summary: document.summary,
      aliases: document.aliases,
    },
    { indent: 2, lineWidth: 0 },
  ).trimEnd();
  return `[文档元信息：非正文；需要改动时用 set_metadata 整组更新]\n${metadata}`;
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

function pagedStateProjection(
  snapshot: WorldDocumentStore,
  handle: string,
  text: string,
  maxBytes: number,
  cursor: unknown,
  shortRef: string,
  locator: AuthorizedLocator | null,
): ContextToolResult {
  const scope = JSON.stringify({
    kind: "state_projected_read",
    snapshotId: snapshot.id,
    handle,
    maxBytes,
  });
  const offset = parseStateProjectionCursor(snapshot, cursor, scope);
  const bytes = Buffer.from(text, "utf8");
  if (offset === null || offset > bytes.length)
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\ncursor 与当前快照或全部查询条件不匹配。",
    };
  const end = safeUtf8ReadEnd(bytes, offset, maxBytes);
  const complete = end === bytes.length;
  const page = bytes.subarray(offset, end).toString("utf8");
  return {
    ok: true,
    markdown: `# 精确读取 ${handle}\n\n${page}\n\n---\n范围：state · ${handle}\n本页：${offset}..${end} / ${bytes.length} bytes\n完整：${complete ? "是" : "否"}${complete ? "" : `\n下一页 cursor：${stateProjectionCursorFor(snapshot, scope, end)}`}`,
    readAuthorization: {
      snapshotId: snapshot.id,
      readKey: readAuthorizationKey(shortRef, locator, maxBytes),
      shortRef,
      locator,
      page: { start: offset, end, total: bytes.length },
    },
  };
}

function readAuthorizationKey(
  shortRef: string,
  locator: AuthorizedLocator | null,
  maxBytes: number,
): string {
  return JSON.stringify({ shortRef, locator, maxBytes });
}

const stateProjectionCursorSecrets = new WeakMap<WorldDocumentStore, Buffer>();

function stateProjectionCursorFor(
  snapshot: WorldDocumentStore,
  scope: string,
  offset: number,
): string {
  const payload = Buffer.from(JSON.stringify({ offset }), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", stateProjectionCursorSecret(snapshot))
    .update(snapshot.id)
    .update("\0")
    .update(scope)
    .update("\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function parseStateProjectionCursor(
  snapshot: WorldDocumentStore,
  cursor: unknown,
  scope: string,
): number | null {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== "string") return null;
  const parts = cursor.split(".");
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (payload === undefined || suppliedSignature === undefined) return null;
  try {
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (supplied.toString("base64url") !== suppliedSignature) return null;
    const expected = createHmac("sha256", stateProjectionCursorSecret(snapshot))
      .update(snapshot.id)
      .update("\0")
      .update(scope)
      .update("\0")
      .update(payload)
      .digest();
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return null;
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return null;
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    return record(value) &&
      Object.keys(value).length === 1 &&
      Number.isSafeInteger(value.offset) &&
      Number(value.offset) >= 0
      ? Number(value.offset)
      : null;
  } catch {
    return null;
  }
}

function stateProjectionCursorSecret(snapshot: WorldDocumentStore): Buffer {
  const existing = stateProjectionCursorSecrets.get(snapshot);
  if (existing !== undefined) return existing;
  const created = randomBytes(32);
  stateProjectionCursorSecrets.set(snapshot, created);
  return created;
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
    markdown: `# Runtime 参数错误\n\n${result.diagnostics.map(({ code, message }) => `${code}：${message}`).join("\n")}`,
  };
}

function unexpectedStateQueryResult(): ContextToolResult {
  return {
    ok: false,
    markdown: "# Runtime 工具拒绝\n\n世界文档查询返回了不匹配的结果类型。",
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

function pagedRead(
  ref: string,
  text: string,
  maxBytes: number,
  cursor: unknown,
): { ok: boolean; markdown: string } {
  const scope = JSON.stringify({
    kind: "read",
    ref,
    sha256: createHash("sha256").update(text).digest("hex"),
    maxBytes,
  });
  const offset = parseCursor(cursor, scope);
  if (offset === null)
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\ncursor 与当前读取不匹配。",
    };
  const bytes = Buffer.from(text, "utf8");
  const end = safeUtf8ReadEnd(bytes, offset, maxBytes);
  const page = bytes.subarray(offset, end).toString("utf8");
  return {
    ok: true,
    markdown: `# 精确读取 @${ref}\n\n${page}\n\n---\n来源：@${ref}\n本页：${offset}..${end} bytes\n完整：${end === bytes.length ? "是" : "否"}\n${end === bytes.length ? "" : `下一页 cursor：${cursorFor(scope, end)}`}`,
  };
}

function safeUtf8ReadEnd(
  bytes: Buffer,
  offset: number,
  maxBytes: number,
): number {
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0)
    end -= 1;
  return end;
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
      "叙事必须为 1 到 24000 个 Unicode 字符",
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
