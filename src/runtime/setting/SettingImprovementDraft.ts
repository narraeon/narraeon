import type { AppLocale } from "../../protocol/appPreferences.ts";
import { defaultAppLocale } from "../../protocol/appPreferences.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { inspectContentPackageCurrentTree } from "../content/FileNativeContentTree.ts";
import type { ModelHostToolCall } from "../model/ModelHost.ts";
import type {
  PromptCompilation,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  WorldDocumentStore,
  type WorldDocumentDescriptor,
  type WorldDocumentQueryFailure,
  type WorldDocumentRevisionChange,
  type WorldDocumentRevisionCommand,
  type WorldDocumentRevisionTarget,
  type WorldDocumentRevisionYamlValue,
  type WorldDocumentSelector,
} from "../world/WorldDocumentStore.ts";

export const settingImprovementToolNames = [
  "setting_list",
  "setting_search",
  "setting_read",
  "setting_write_file",
  "setting_patch",
  "setting_move",
] as const;

export type SettingImprovementToolName =
  (typeof settingImprovementToolNames)[number];

export interface SettingDraftDiff {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

export interface SettingDraftDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface SettingDraftReview {
  status: "usable" | "needs_repair";
  diff: SettingDraftDiff[];
  diagnostics: SettingDraftDiagnostic[];
  preview: PromptPreview | null;
}

export interface PersistedSettingDraftState {
  files: ContentTreeFile[];
  readWorldDocumentIds: string[];
  readableDamagedWorldPaths: string[];
  readOpaquePaths: string[];
}

export interface SettingDraftToolResult {
  toolCallId: string;
  markdown: string;
  isError: boolean;
}

const frameExample = `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: document, document: "@cultivation" }
  - slot: { kind: node, document: "@alex", locator: { yaml: [relationships] } }
  - slot:
      kind: reference_targets
      from: { document: "@current-situation", locator: { yaml: [characters] } }
      maxEntries: 8
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`;

const emptyPlayerViewsExample = `format: narraeon.player-views/v1
views: []
`;

const playerViewsExample = `format: narraeon.player-views/v1
views:
  - id: player-status
    title: Current status
    items:
      - id: alex-clothes
        label: Alex's clothing
        select:
          document: "@alex"
          locator:
            yaml: [clothing]
      - id: gold-core-rule
        label: Gold Core
        select:
          document: "@cultivation"
          locator:
            markdown: [Gold Core]
`;

/** Control-file examples from the author contract, validated by tests. */
export const settingAuthorContractExamples = {
  frame: frameExample,
  emptyPlayerViews: emptyPlayerViewsExample,
  playerViews: playerViewsExample,
} as const;

export function settingImprovementRuntimeContract(locale: AppLocale): string {
  return locale === "zh-CN"
    ? `# Runtime 设定完善对话契约

- 这是同一条持续对话，没有“计划阶段”“生成阶段”或结束工具。根据用户当前消息自行决定讨论、提问、读取或修改；用户要求先讨论计划时就只讨论，用户要求落地时再调用写工具。
- 六个读写工具从第一轮起始终可用。不调用工具的完整响应会作为普通助手消息显示，并结束本次用户调用。只要调用了工具，该响应就是内部工具步骤；收到全部工具结果后继续，最终用一个不调用工具的响应答复用户。
- 所有写入只落到隔离草稿。用户可在任意一次完整响应结束后点击“应用”；只有 Runtime 的应用操作会原子替换内容包当前树。
- 同一模型响应里的所有写调用属于一个原子批次：任何写调用失败，整批都不生效。Runtime 会在成功批次后自动运行内容树检查和真实 Prompt Preview；不需要也不存在 preview 或 finish 工具。
- 修改既有文件前必须完整读取它。setting_list／setting_search／setting_read 的 cursor 只属于产生它的草稿快照；写入成功后旧 cursor 失效。工具只暴露逻辑路径，不暴露宿主路径。
- world/ 下只写 .yaml 或 .md 世界文档；专用文件只允许 opening.md、control/frame.yaml、control/player-views.yaml 和 control/blocks/*.md。人物、地点、规则与当前情境放在 world/，本世界特有的主持要求放在 control/。
- opening.md 是玩家看见的第一页，不得替玩家决定行动、台词或内心。会继续约束首次行动的事实也必须写入自然承载它的世界文档。
- world 文档的 $document.id 与 ref 由 Runtime 分配或保留。跨文档引用和 control 中的文档选择使用工具返回的 @短引用；不要猜测文档 id，也不要用文件路径冒充引用。`
    : `# Runtime setting-improvement conversation contract

- This is one continuous conversation. There is no planning phase, generation phase, or finish tool. Decide from the user's current message whether to discuss, ask, read, or edit. If the user asks to plan first, discuss only; call write tools only when the user asks to make the changes.
- The same six read/write tools are available from the first turn onward. A complete response with no tool calls is shown as an ordinary assistant message and settles this user invocation. Any response with tool calls is an internal tool step; continue after all results and eventually answer with a tool-free response.
- Every write lands only in an isolated draft. The user may click Apply after any complete response; only Runtime's Apply operation atomically replaces the content package's current tree.
- All writes in one model response are one atomic batch. If any write fails, none take effect. Runtime automatically runs content-tree checks and a real Prompt Preview after each successful batch; preview and finish tools do not exist.
- Read an existing file completely before changing it. Cursors from setting_list, setting_search, and setting_read belong only to the draft snapshot that produced them; a successful write invalidates them. Tools expose logical paths, never host paths.
- World documents are .yaml or .md files under world/. Special writes are limited to opening.md, control/frame.yaml, control/player-views.yaml, and control/blocks/*.md. Put characters, places, rules, and the current situation under world/, and world-specific hosting guidance under control/.
- opening.md is the first page shown to the player. Never decide the player's action, dialogue, or inner thoughts. Facts that constrain the first action must also live in the world document that naturally owns them.
- Runtime allocates or preserves $document.id and ref. Cross-document references and control selectors use @short-refs returned by tools. Never guess a document id or substitute a file path for a reference.`;
}

export function settingImprovementToolDefinitions(
  locale: AppLocale = defaultAppLocale,
): PromptCompilation["tools"] {
  const descriptions =
    locale === "zh-CN" ? toolDescriptionsZhCN : toolDescriptionsEn;
  const schema = (properties: Record<string, object>, required: string[]) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  const text = { type: "string", minLength: 1 };
  const path = { type: "string", minLength: 1 };
  const cursor = { type: "string", minLength: 1 };
  const limit = { type: "integer", minimum: 1, maximum: 100 };
  return [
    {
      name: "setting_list",
      description: descriptions.setting_list,
      inputSchema: schema(
        {
          directory: { type: "string", pattern: "^world(?:/[^\\\\]+)?$" },
          limit,
          cursor,
        },
        [],
      ),
    },
    {
      name: "setting_search",
      description: descriptions.setting_search,
      inputSchema: schema(
        {
          query: { type: "string", minLength: 1, maxLength: 256 },
          within: path,
          caseSensitive: { type: "boolean" },
          limit,
          cursor,
        },
        ["query"],
      ),
    },
    {
      name: "setting_read",
      description: descriptions.setting_read,
      inputSchema: schema(
        {
          path,
          maxBytes: { type: "integer", minimum: 4, maximum: 65_536 },
          cursor,
        },
        ["path"],
      ),
    },
    {
      name: "setting_write_file",
      description: descriptions.setting_write_file,
      inputSchema: schema({ path, contents: text }, ["path", "contents"]),
    },
    {
      name: "setting_patch",
      description: descriptions.setting_patch,
      inputSchema: schema(
        {
          document: text,
          op: { type: "string", enum: ["add", "replace"] },
          locator: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          value: {},
        },
        ["document", "op", "locator", "value"],
      ),
    },
    {
      name: "setting_move",
      description: descriptions.setting_move,
      inputSchema: schema({ from: text, to: path }, ["from", "to"]),
    },
  ];
}

const toolDescriptionsEn: Record<SettingImprovementToolName, string> = {
  setting_list:
    "List the world root or a world/ subdirectory from the isolated draft. The root also lists opening and control files. A cursor is valid only for the same query and draft snapshot.",
  setting_search:
    "Search literal source text in world documents in the isolated draft. within may be world, a world/ directory or path, @short-ref, or document identity.",
  setting_read:
    "Read a world document by world/ path, @short-ref, or identity, or read an exact opening/control path. Read every page before overwriting an existing file.",
  setting_write_file:
    "Create or replace a complete draft file: a .yaml/.md document under world/, opening.md, control/frame.yaml, control/player-views.yaml, or control/blocks/*.md. Runtime owns world-document identity.",
  setting_patch:
    "Add or replace one YAML map node in a completely read world document. locator is a non-empty array of map keys. Rewrite Markdown with setting_write_file.",
  setting_move:
    "Move a completely read world document to a new world/ .yaml or .md logical path while preserving its identity and contents.",
};

const toolDescriptionsZhCN: Record<SettingImprovementToolName, string> = {
  setting_list:
    "列出隔离草稿的 world 根目录或 world/ 子目录；根目录同时列出 opening 和 control 专用文件。cursor 只对同一查询和草稿快照有效。",
  setting_search:
    "在隔离草稿的 world 文档中按原文字面搜索；within 可为 world、world/ 目录或路径、@短引用或文档身份。",
  setting_read:
    "按 world/ 路径、@短引用或身份读取世界文档，或按精确路径读取 opening/control；覆盖既有文件前必须读完全部分页。",
  setting_write_file:
    "创建或整份替换草稿文件：world/ 下的 .yaml/.md、opening.md、control/frame.yaml、control/player-views.yaml 或 control/blocks/*.md。世界文档身份由 Runtime 管理。",
  setting_patch:
    "在已完整读取的 YAML 世界文档中新增或替换一个 map 节点；locator 是非空 map-key 数组。Markdown 用 setting_write_file 整份重写。",
  setting_move:
    "把已完整读取的世界文档移动到新的 world/ .yaml 或 .md 逻辑路径，并保留身份与内容。",
};

interface ReadAuthorizations {
  snapshotId: string;
  worldDocumentIds: Set<string>;
  damagedWorldPaths: Set<string>;
  opaquePaths: Set<string>;
  pendingWorldReads: Map<
    string,
    { documentId: string; nextOffset: number; totalBytes: number }
  >;
}

interface QueryResult {
  ok: boolean;
  markdown: string;
}

export class SettingImprovementDraft {
  readonly #baseFiles: ContentTreeFile[];
  readonly #locale: AppLocale;
  readonly #preview: (snapshot: WorldDocumentStore) => PromptPreview;
  #snapshot: WorldDocumentStore;
  #reads: ReadAuthorizations;
  #review: SettingDraftReview;

  constructor(input: {
    baseFiles: readonly ContentTreeFile[];
    locale?: AppLocale;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
    persisted?: PersistedSettingDraftState;
  }) {
    this.#baseFiles = cloneFiles(input.baseFiles);
    this.#locale = input.locale ?? defaultAppLocale;
    this.#preview = input.preview;
    const files = input.persisted?.files ?? input.baseFiles;
    this.#snapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: cloneFiles(files),
    });
    this.#reads = {
      snapshotId: this.#snapshot.id,
      worldDocumentIds: new Set(input.persisted?.readWorldDocumentIds ?? []),
      damagedWorldPaths: new Set(
        input.persisted?.readableDamagedWorldPaths ?? [],
      ),
      opaquePaths: new Set(input.persisted?.readOpaquePaths ?? []),
      pendingWorldReads: new Map(),
    };
    this.#review = this.#inspect();
  }

  files(): ContentTreeFile[] {
    return cloneFiles(this.#snapshot.files);
  }

  review(): SettingDraftReview {
    return structuredClone(this.#review);
  }

  persist(): PersistedSettingDraftState {
    return {
      files: this.files(),
      readWorldDocumentIds: [...this.#reads.worldDocumentIds].sort(),
      readableDamagedWorldPaths: [...this.#reads.damagedWorldPaths].sort(),
      readOpaquePaths: [...this.#reads.opaquePaths].sort(),
    };
  }

  execute(calls: readonly ModelHostToolCall[]): SettingDraftToolResult[] {
    const normalized = calls.map(normalizeCall);
    const results = new Map<string, SettingDraftToolResult>();
    const reads = normalized.filter((call) => isReadTool(call.name));
    const writes = normalized.filter((call) => !isReadTool(call.name));

    for (const call of reads) {
      const result = this.#executeRead(call);
      results.set(call.id, toToolResult(call.id, result));
    }

    if (writes.length > 0) {
      const writeResults = this.#executeWriteBatch(writes);
      for (const result of writeResults) results.set(result.toolCallId, result);
    }

    return normalized.map(
      ({ id }) =>
        results.get(id) ?? {
          toolCallId: id,
          markdown:
            "# Runtime tool rejected\n\nThe tool call was not executed.",
          isError: true,
        },
    );
  }

  #executeRead(call: NormalizedCall): QueryResult {
    if (call.name === "setting_list")
      return listDocuments(this.#snapshot, call.arguments, this.#locale);
    if (call.name === "setting_search")
      return searchDocuments(this.#snapshot, call.arguments, this.#locale);
    if (call.name === "setting_read")
      return readDocument(
        this.#snapshot,
        call.arguments,
        this.#reads,
        this.#locale,
      );
    return failure(`Unsupported read tool: ${call.name}`, this.#locale);
  }

  #executeWriteBatch(
    calls: readonly NormalizedCall[],
  ): SettingDraftToolResult[] {
    let snapshot = this.#snapshot;
    const reads = cloneReads(this.#reads);
    const successes = new Map<string, string>();
    try {
      const worldCalls = calls.filter(isWorldWriteCall);
      if (worldCalls.length > 0) {
        const commands = worldCalls.map((call) =>
          worldRevisionCommand(call, this.#locale),
        );
        const revised = snapshot.revise({ commands });
        if (!revised.ok)
          throw new SettingDraftError(
            renderRevisionFailure(revised.diagnostics),
          );
        assertWorldWritesAuthorized(
          snapshot.id,
          reads,
          revised.changes,
          this.#locale,
        );
        snapshot = revised.snapshot;
        rebaseReads(reads, snapshot);
        for (const change of revised.changes)
          reads.worldDocumentIds.add(change.documentId);
        for (const [index, call] of worldCalls.entries())
          successes.set(
            call.id,
            renderWorldWriteSuccess(revised.changes, index, this.#locale),
          );
      }
      for (const call of calls.filter(
        (candidate) => !isWorldWriteCall(candidate),
      )) {
        if (call.name !== "setting_write_file")
          throw new SettingDraftError(`Unsupported write tool: ${call.name}`);
        const changed = writeOpaque(snapshot, call, reads, this.#locale);
        snapshot = changed.snapshot;
        successes.set(call.id, changed.markdown);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "The draft write batch failed";
      return calls.map((call) => ({
        toolCallId: call.id,
        markdown: localized(
          this.#locale,
          `# Runtime tool rejected\n\nThe entire response-level write batch was rolled back. ${message}`,
          `# Runtime 工具拒绝\n\n本响应中的整批写入已回滚。${message}`,
        ),
        isError: true,
      }));
    }

    this.#snapshot = snapshot;
    this.#reads = reads;
    this.#review = this.#inspect();
    const reviewMarkdown = renderAutomaticReview(this.#review, this.#locale);
    const lastCallId = calls.at(-1)?.id;
    return calls.map((call) => ({
      toolCallId: call.id,
      markdown: `${
        successes.get(call.id) ??
        localized(
          this.#locale,
          "# Draft write accepted\n\nThe response-level batch was committed to the isolated draft.",
          "# 草稿写入已接受\n\n本响应中的写入已整批提交到隔离草稿。",
        )
      }${call.id === lastCallId ? `\n\n${reviewMarkdown}` : ""}`,
      isError: false,
    }));
  }

  #inspect(): SettingDraftReview {
    const inspection = inspectContentPackageCurrentTree(this.#snapshot.files, {
      worldDocumentSnapshot: this.#snapshot,
    });
    const diff = fileDiff(this.#baseFiles, this.#snapshot.files);
    if (inspection.status !== "usable")
      return {
        status: "needs_repair",
        diff,
        diagnostics: inspection.issues.map(({ code, path, message }) => ({
          code,
          path,
          message,
        })),
        preview: null,
      };
    try {
      return {
        status: "usable",
        diff,
        diagnostics: [],
        preview: structuredClone(this.#preview(this.#snapshot)),
      };
    } catch (error: unknown) {
      return {
        status: "needs_repair",
        diff,
        diagnostics: [
          {
            code: "prompt_preview_failed",
            path: "control/frame.yaml",
            message:
              error instanceof Error
                ? error.message
                : "Prompt Preview failed for the isolated draft",
          },
        ],
        preview: null,
      };
    }
  }
}

function renderAutomaticReview(
  review: SettingDraftReview,
  locale: AppLocale,
): string {
  if (review.status === "usable")
    return localized(
      locale,
      `# Automatic draft review passed\n\nContent-tree validation and the real Prompt Preview both passed. The isolated draft currently changes ${review.diff.length} file(s). Continue only if the user's request needs more work; no finish tool is required.`,
      `# 草稿自动检查通过\n\n内容树校验和真实 Prompt Preview 均已通过；隔离草稿当前改动 ${review.diff.length} 个文件。仅在用户要求尚未完成时继续修改，不需要结束工具。`,
    );
  return [
    localized(
      locale,
      "# Automatic draft review needs repair",
      "# 草稿自动检查需要修复",
    ),
    "",
    ...review.diagnostics.map(
      ({ code, path, message }) => `- ${code} · ${path} · ${message}`,
    ),
    "",
    localized(
      locale,
      "Repair these diagnostics with the ordinary read/write tools. Runtime will run the review again after the next successful write batch.",
      "请用普通读写工具修复这些诊断；下一批写入成功后 Runtime 会再次自动检查。",
    ),
  ].join("\n");
}

interface NormalizedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

class SettingDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingDraftError";
  }
}

function normalizeCall(call: ModelHostToolCall): NormalizedCall {
  if (!isRecord(call.arguments))
    return { id: call.id, name: call.name, arguments: {} };
  return {
    id: call.id,
    name: call.name,
    arguments: structuredClone(call.arguments),
  };
}

function isReadTool(name: string): boolean {
  return (
    name === "setting_list" ||
    name === "setting_search" ||
    name === "setting_read"
  );
}

function isWorldWriteCall(call: NormalizedCall): boolean {
  if (call.name === "setting_patch" || call.name === "setting_move")
    return true;
  return (
    call.name === "setting_write_file" &&
    typeof call.arguments.path === "string" &&
    call.arguments.path.startsWith("world/")
  );
}

function worldRevisionCommand(
  call: NormalizedCall,
  locale: AppLocale,
): WorldDocumentRevisionCommand {
  if (call.name === "setting_write_file") {
    const logicalPath = safePath(requiredString(call.arguments.path, "path"));
    if (!/^world\/.+\.(?:ya?ml|md)$/u.test(logicalPath))
      throw new SettingDraftError(
        localized(
          locale,
          "World files must be .yaml or .md documents below world/",
          "world 文件必须是 world/ 下的 .yaml 或 .md 文档",
        ),
      );
    return {
      kind: "write",
      logicalPath,
      contents: requiredString(call.arguments.contents, "contents"),
    };
  }
  if (call.name === "setting_move") {
    const toLogicalPath = safePath(requiredString(call.arguments.to, "to"));
    if (!/^world\/.+\.(?:ya?ml|md)$/u.test(toLogicalPath))
      throw new SettingDraftError(
        "setting_move.to must be a world/ .yaml or .md path",
      );
    return {
      kind: "move",
      document: revisionTarget(requiredString(call.arguments.from, "from")),
      toLogicalPath,
    };
  }
  if (call.name === "setting_patch") {
    const op = requiredString(call.arguments.op, "op");
    if (op !== "add" && op !== "replace")
      throw new SettingDraftError("setting_patch.op must be add or replace");
    return {
      kind: "patch",
      document: revisionTarget(
        requiredString(call.arguments.document, "document"),
      ),
      edits: [
        {
          op,
          locator: {
            yaml: requiredStringArray(call.arguments.locator, "locator"),
          },
          value: structuredClone(
            call.arguments.value,
          ) as WorldDocumentRevisionYamlValue,
        },
      ],
    };
  }
  throw new SettingDraftError(`Unsupported write tool: ${call.name}`);
}

function revisionTarget(value: string): WorldDocumentRevisionTarget {
  const selector = documentSelector(value);
  if (selector === null)
    throw new SettingDraftError(`Invalid world-document selector: ${value}`);
  return selector;
}

function writeOpaque(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  reads: ReadAuthorizations,
  locale: AppLocale,
): { snapshot: WorldDocumentStore; markdown: string } {
  const path = safePath(requiredString(call.arguments.path, "path"));
  if (!writableOpaquePath(path))
    throw new SettingDraftError(
      localized(
        locale,
        "Special-file writes accept only opening.md, control/frame.yaml, control/player-views.yaml, or control/blocks/*.md",
        "专用文件只允许写入 opening.md、control/frame.yaml、control/player-views.yaml 或 control/blocks/*.md",
      ),
    );
  const contents = requiredString(call.arguments.contents, "contents");
  const next = cloneFiles(snapshot.files);
  const existing = next.find((file) => file.path === path);
  if (existing !== undefined && !reads.opaquePaths.has(path))
    throw new SettingDraftError(
      localized(
        locale,
        `Read ${path} completely before replacing it`,
        `替换 ${path} 前必须完整读取它`,
      ),
    );
  if (existing === undefined) next.push({ path, contents });
  else {
    existing.contents = contents;
    delete existing.encoding;
  }
  const revised = WorldDocumentStore.open({
    layout: "content_package",
    files: sortFiles(next),
  });
  rebaseReads(reads, revised);
  reads.opaquePaths.add(path);
  return {
    snapshot: revised,
    markdown: localized(
      locale,
      `# Draft write accepted\n\n${existing === undefined ? "Created" : "Updated"} ${path} in the isolated draft. Runtime automatically refreshed the draft review.`,
      `# 草稿写入已接受\n\n已在隔离草稿中${existing === undefined ? "创建" : "更新"} ${path}；Runtime 已自动刷新草稿检查。`,
    ),
  };
}

function writableOpaquePath(path: string): boolean {
  return (
    path === "opening.md" ||
    path === "control/frame.yaml" ||
    path === "control/player-views.yaml" ||
    /^control\/blocks\/[a-z0-9][a-z0-9/_-]*\.md$/u.test(path)
  );
}

function assertWorldWritesAuthorized(
  snapshotId: string,
  reads: ReadAuthorizations,
  changes: readonly WorldDocumentRevisionChange[],
  locale: AppLocale,
): void {
  if (reads.snapshotId !== snapshotId)
    throw new Error("Draft read authorization belongs to another snapshot");
  for (const change of changes) {
    if (
      change.before === null ||
      reads.worldDocumentIds.has(change.documentId) ||
      reads.damagedWorldPaths.has(change.before.logicalPath)
    )
      continue;
    throw new SettingDraftError(
      localized(
        locale,
        `Read @${change.shortRef} completely before changing it`,
        `修改 @${change.shortRef} 前必须完整读取该文档`,
      ),
    );
  }
}

function renderWorldWriteSuccess(
  changes: readonly WorldDocumentRevisionChange[],
  commandIndex: number,
  locale: AppLocale,
): string {
  const own = changes.filter((change) => change.commandIndex === commandIndex);
  return [
    localized(locale, "# Draft revision accepted", "# 草稿 revision 已接受"),
    "",
    ...(own.length === 0
      ? [localized(locale, "- No file changed", "- 没有文件发生变化")]
      : own.map((change) => {
          if (change.before === null)
            return `- ${localized(locale, "Created", "创建")} @${change.shortRef} · ${change.after.logicalPath}`;
          if (change.before.logicalPath === change.after.logicalPath)
            return `- ${localized(locale, "Updated", "更新")} @${change.shortRef} · ${change.after.logicalPath}`;
          return `- ${localized(locale, "Moved", "移动")} @${change.shortRef} · ${change.before.logicalPath} → ${change.after.logicalPath}`;
        })),
    "",
    localized(
      locale,
      "The whole response-level write batch was committed atomically. Runtime automatically refreshed the draft review.",
      "本响应中的整批写入已原子提交；Runtime 已自动刷新草稿检查。",
    ),
  ].join("\n");
}

function renderRevisionFailure(
  diagnostics: readonly {
    commandIndex: number | null;
    code: string;
    logicalPath?: string;
    message: string;
  }[],
): string {
  return diagnostics
    .map(
      ({ commandIndex, code, logicalPath, message }) =>
        `[${commandIndex ?? "batch"}] ${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${message}`,
    )
    .join("\n");
}

function listDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  locale: AppLocale,
): QueryResult {
  if (!hasOnly(args, ["directory", "limit", "cursor"]))
    return failure(
      "setting_list accepts only directory, limit, and cursor",
      locale,
    );
  const directory = args.directory ?? "world";
  const limit = args.limit ?? 100;
  if (
    typeof directory !== "string" ||
    (directory !== "world" && !directory.startsWith("world/")) ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !validCursor(args.cursor)
  )
    return failure("Invalid setting_list directory, limit, or cursor", locale);
  const relative = directory === "world" ? "" : directory.slice(6);
  const result = snapshot.query({
    kind: "catalog",
    directory: relative,
    limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") return renderQueryFailure(result, locale);
  if (result.kind !== "catalog") throw new Error("Unexpected catalog result");
  const entries = result.entries.map((entry) => {
    if (entry.kind === "directory") return `- [dir] ${entry.logicalPath}/`;
    if (entry.document === undefined)
      return `- [damaged] ${entry.logicalPath} · ${entry.diagnostics.map(({ code }) => code).join(", ")}`;
    return `- @${entry.document.shortRef} · ${entry.document.title} · ${entry.logicalPath}`;
  });
  if (relative === "" && result.page.start === 0)
    entries.unshift(
      ...snapshot.files
        .filter(({ path }) => !path.startsWith("world/"))
        .map(({ path, encoding }) =>
          encoding === undefined ? `- [special] ${path}` : `- [binary] ${path}`,
        ),
    );
  return success(
    `# ${localized(locale, "Setting directory", "设定目录")}\n\n${entries.join("\n") || localized(locale, "(empty)", "（空）")}\n\n${pageFooter(result.page, locale)}`,
  );
}

function searchDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  locale: AppLocale,
): QueryResult {
  const query = args.query;
  const limit = args.limit ?? 20;
  if (
    !hasOnly(args, ["query", "within", "caseSensitive", "limit", "cursor"]) ||
    typeof query !== "string" ||
    query.length < 1 ||
    query.length > 256 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (args.caseSensitive !== undefined &&
      typeof args.caseSensitive !== "boolean") ||
    !validCursor(args.cursor)
  )
    return failure("Invalid setting_search arguments", locale);
  const within = searchScope(args.within);
  if (within === invalidScope)
    return failure("Invalid setting_search within scope", locale);
  const result = snapshot.query({
    kind: "literal_search",
    query,
    caseSensitive: args.caseSensitive === true,
    ...(within === undefined ? {} : { within }),
    limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") return renderQueryFailure(result, locale);
  if (result.kind !== "literal_search")
    throw new Error("Unexpected literal search result");
  const lines = result.matches.map(
    ({ document, referenceProjection, range }) =>
      `- @${document.shortRef} · ${document.logicalPath} · ${range.start.line}:${range.start.column}\n  ${JSON.stringify(referenceProjection.excerpt)}`,
  );
  return success(
    `# ${localized(locale, "Literal setting search", "设定字面搜索")}\n\n${lines.join("\n") || localized(locale, "Zero literal matches do not prove the fact is absent.", "0 个字面命中不证明设定中不存在该事实。")}\n\n${pageFooter(result.page, locale)}`,
  );
}

const invalidScope = Symbol("invalid-scope");

function searchScope(
  value: unknown,
):
  | undefined
  | { directory: string }
  | { document: WorldDocumentSelector }
  | typeof invalidScope {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) return invalidScope;
  if (value === "world") return { directory: "" };
  if (value.startsWith("@"))
    return value.length > 1
      ? { document: { shortRef: value.slice(1) } }
      : invalidScope;
  if (value.startsWith("world/")) {
    const path = safePath(value);
    return /\.(?:ya?ml|md)$/u.test(path)
      ? { document: { logicalPath: path } }
      : { directory: path.slice(6) };
  }
  return value.includes("/")
    ? invalidScope
    : { document: { documentId: value } };
}

function readDocument(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  reads: ReadAuthorizations,
  locale: AppLocale,
): QueryResult {
  const path = args.path;
  if (
    !hasOnly(args, ["path", "maxBytes", "cursor"]) ||
    typeof path !== "string" ||
    path.length === 0 ||
    !validCursor(args.cursor)
  )
    return failure("Invalid setting_read arguments", locale);
  const opaque = snapshot.files.find(
    (file) => file.path === path && !file.path.startsWith("world/"),
  );
  if (opaque !== undefined) {
    if (
      args.cursor !== undefined ||
      args.maxBytes !== undefined ||
      opaque.encoding !== undefined
    )
      return failure("Special files require one complete text read", locale);
    reads.opaquePaths.add(path);
    return success(
      `# ${localized(locale, "Special-file source", "专用文件原文")} ${path}\n\n${opaque.contents}\n\n---\nComplete: yes`,
    );
  }
  const selector = documentSelector(path);
  const maxBytes = args.maxBytes ?? 8192;
  if (
    selector === null ||
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > 65_536
  )
    return failure("Invalid setting_read path or maxBytes", locale);
  const result = snapshot.query({
    kind: "read_document",
    document: selector,
    maxBytes,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") {
    if (repairableDamagedWorldRead(snapshot, path, result))
      reads.damagedWorldPaths.add(path);
    return renderQueryFailure(result, locale);
  }
  if (result.kind !== "read_document")
    throw new Error("Unexpected read result");
  authorizeReadPage(reads, result.document, selector, maxBytes, result.page);
  return success(
    `# ${localized(locale, "Exact read", "精确读取")} @${result.document.shortRef}\n\ntitle: ${result.document.title}\nsummary: ${result.document.summary}\ncodec: ${result.document.codec}\nlogicalPath: ${result.document.logicalPath}\n[body]\n${result.body.trimEnd()}\n[/body${result.page.complete ? "" : " continues"}]\n\n${pageFooter(result.page, locale)}`,
  );
}

function repairableDamagedWorldRead(
  snapshot: WorldDocumentStore,
  path: string,
  result: WorldDocumentQueryFailure,
): boolean {
  if (
    !path.startsWith("world/") ||
    !snapshot.files.some(({ path: candidate }) => candidate === path)
  )
    return false;
  // A failed exact read authorizes replacement only when the source itself is
  // malformed. Bad cursors, bad selectors, missing documents, and ambiguity
  // must never turn into a read-before-write bypass.
  return result.diagnostics.some(
    ({ code }) =>
      code !== "cursor_invalid" &&
      code !== "query_invalid" &&
      code !== "document_not_found" &&
      code !== "document_ambiguous",
  );
}

function documentSelector(value: string): WorldDocumentSelector | null {
  if (value.startsWith("@"))
    return value.length > 1 ? { shortRef: value.slice(1) } : null;
  if (value.startsWith("world/")) {
    const path = safePath(value);
    return /\.(?:ya?ml|md)$/u.test(path) ? { logicalPath: path } : null;
  }
  return value.includes("/") ? null : { documentId: value };
}

function authorizeReadPage(
  reads: ReadAuthorizations,
  document: WorldDocumentDescriptor,
  selector: WorldDocumentSelector,
  maxBytes: number,
  page: { start: number; end: number; total: number; complete: boolean },
): void {
  const key = JSON.stringify({ selector, maxBytes });
  if (page.start === 0)
    reads.pendingWorldReads.set(key, {
      documentId: document.documentId,
      nextOffset: page.end,
      totalBytes: page.total,
    });
  else {
    const pending = reads.pendingWorldReads.get(key);
    if (
      pending?.documentId !== document.documentId ||
      pending.nextOffset !== page.start ||
      pending.totalBytes !== page.total
    )
      return;
    pending.nextOffset = page.end;
  }
  const pending = reads.pendingWorldReads.get(key);
  if (pending?.nextOffset === pending?.totalBytes && page.complete) {
    reads.worldDocumentIds.add(document.documentId);
    reads.pendingWorldReads.delete(key);
  }
}

function renderQueryFailure(
  result: WorldDocumentQueryFailure,
  locale: AppLocale,
): QueryResult {
  return failure(
    result.diagnostics
      .map(
        ({ code, logicalPath, message }) =>
          `${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${message}`,
      )
      .join("\n"),
    locale,
  );
}

function pageFooter(
  page: {
    start: number;
    end: number;
    total: number;
    complete: boolean;
    nextCursor: string | null;
  },
  locale: AppLocale,
): string {
  return `${localized(locale, "Page", "本页")} ${page.start}..${page.end} / ${page.total}\nComplete: ${page.complete ? "yes" : "no"}${page.nextCursor === null ? "" : `\nNext cursor: ${page.nextCursor}`}`;
}

function success(markdown: string): QueryResult {
  return { ok: true, markdown };
}

function failure(message: string, locale: AppLocale): QueryResult {
  return {
    ok: false,
    markdown: `${localized(locale, "# Runtime tool rejected", "# Runtime 工具拒绝")}\n\n${message}`,
  };
}

function toToolResult(id: string, result: QueryResult): SettingDraftToolResult {
  return { toolCallId: id, markdown: result.markdown, isError: !result.ok };
}

function cloneReads(source: ReadAuthorizations): ReadAuthorizations {
  return {
    snapshotId: source.snapshotId,
    worldDocumentIds: new Set(source.worldDocumentIds),
    damagedWorldPaths: new Set(source.damagedWorldPaths),
    opaquePaths: new Set(source.opaquePaths),
    pendingWorldReads: new Map(
      [...source.pendingWorldReads].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    ),
  };
}

function rebaseReads(
  reads: ReadAuthorizations,
  snapshot: WorldDocumentStore,
): void {
  reads.snapshotId = snapshot.id;
  reads.pendingWorldReads.clear();
}

function fileDiff(
  baseFiles: readonly ContentTreeFile[],
  draftFiles: readonly ContentTreeFile[],
): SettingDraftDiff[] {
  const before = new Map(baseFiles.map((file) => [file.path, file]));
  const after = new Map(draftFiles.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path): SettingDraftDiff[] => {
      const left = before.get(path) ?? null;
      const right = after.get(path) ?? null;
      if (
        left?.contents === right?.contents &&
        left?.encoding === right?.encoding
      )
        return [];
      return [
        {
          path,
          kind: left === null ? "create" : right === null ? "delete" : "modify",
          before: left?.contents ?? null,
          after: right?.contents ?? null,
        },
      ];
    });
}

function safePath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "." || part === ".." || part.length === 0)
  )
    throw new SettingDraftError(`Unsafe candidate path: ${path}`);
  return path;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SettingDraftError(`${name} must be a non-empty string`);
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  )
    throw new SettingDraftError(`${name} must be a non-empty string array`);
  return value.filter(
    (item: unknown): item is string => typeof item === "string",
  );
}

function hasOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validCursor(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files.map((file) => structuredClone(file));
}

function sortFiles(files: ContentTreeFile[]): ContentTreeFile[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function localized(
  locale: AppLocale,
  english: string,
  chinese: string,
): string {
  return locale === "zh-CN" ? chinese : english;
}
