import type { AppLocale } from "../../protocol/appPreferences.ts";
import { defaultAppLocale } from "../../protocol/appPreferences.ts";
import { isScalar, isSeq, parseDocument, stringify } from "yaml";
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
  type WorldDocumentLocator,
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
  "setting_create",
  "setting_write_file",
  "setting_patch",
  "setting_move",
  "setting_delete",
] as const;

export type SettingImprovementToolName =
  (typeof settingImprovementToolNames)[number];

export interface SettingAuthoringDiff {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

export interface SettingAuthoringDiagnostic {
  code: string;
  path: string;
  message: string;
}

export type SettingAuthoringPlayAccess =
  | "full_injected"
  | "node_injected"
  | "catalog_summary"
  | "referenced_from_injected"
  | "on_demand"
  | "opening_genesis"
  | "play_control"
  | "unused_control"
  | "player_view"
  | "removed";

export interface SettingAuthoringPlayCoverage {
  totals: {
    fullInjected: number;
    nodeInjected: number;
    catalogSummary: number;
    referencedFromInjected: number;
    onDemand: number;
  };
  changed: {
    path: string;
    access: SettingAuthoringPlayAccess;
    detail: string;
  }[];
}

export interface SettingAuthoringReview {
  status: "usable" | "needs_repair";
  diff: SettingAuthoringDiff[];
  diagnostics: SettingAuthoringDiagnostic[];
  preview: PromptPreview | null;
  playCoverage: SettingAuthoringPlayCoverage | null;
}

export interface SettingAuthoringAuthorization {
  /** Stable fingerprint of the content package current tree. */
  revision: string;
  readWorldDocumentIds: string[];
  readableDamagedWorldPaths: string[];
  readOpaquePaths: string[];
}

export interface SettingAuthoringToolResult {
  toolCallId: string;
  markdown: string;
  isError: boolean;
  changes: SettingAuthoringDiff[];
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

- 每条用户消息都追加到所选设定完善对话。默认沿该对话的 Provider 上下文继续；用户显式选择“全新上下文”时，Runtime 才从内容包当前树编译一段新对话。根据用户当前要求决定直接回复、提出问题、读取当前树或修改当前树。
- 当前请求随附八个读写工具。不调用工具的完整响应会作为普通助手消息显示，并结束本次用户调用。含有工具调用的响应是内部工具步骤；收到全部工具结果后继续处理，最终用一个不调用工具的完整响应答复用户。
- 工具写入直接修改内容包当前树。每个完整 Provider 工具响应中的调用按顺序执行，成功改动在该响应结算时原子发布，发布后立即成为内容包权威，无需另一步确认。
- 每个写工具调用独立结算，并按本响应中的调用顺序读取之前已接受的结果。某个调用失败只在对应工具结果中返回精确原因，不回滚同一响应内其他成功调用，也不阻止后续调用。Runtime 在写调用结算后自动运行内容树检查和真实 Prompt Preview，并把检查结果附在最后一个成功写调用的结果中。
- 修改既有文件前必须完整读取它。setting_list／setting_search 的 cursor，以及 setting_read 的读取授权，只属于产生它们的当前树 revision；任何其他对话或手动编辑改变当前树后，必须重新读取再写。setting_read 总是完整返回精确文件，不截断、不分页。工具只暴露逻辑路径，不暴露宿主路径。
- world/ 下只写 .yaml 或 .md 世界文档；专用文件只允许 opening.md、control/frame.yaml、control/player-views.yaml 和 control/blocks/*.md。人物、地点、规则与当前情境放在 world/，本世界特有的主持要求放在 control/。
- opening.md 是玩家看见的第一页，不得替玩家决定行动、台词或内心。会继续约束首次行动的事实也必须写入自然承载它的世界文档。
- 新建 world 文档使用 setting_create：ref 由你提供，并同时提供路径、标题、摘要、别名与不含技术头的正文。ref 必须是唯一的 2～32 位小写 ASCII 短句柄；Runtime 自行完成技术存储。既有文档选择值会在读取时自动投影为对应的 @ref；跨文档引用和 control 中的文档选择只使用 @ref。
- YAML 中指向整份文档的机械引用只写成单键 map，例如 { $ref: "@alex" }；普通字符串中的 @alex 仍只是文字。frame 与 player-view selector 的 document 值也写成 "@alex"，局部位置另用 locator 表达。
- YAML locator 可混合 map key 与从 0 开始的数组下标。用 remove 删除一个既有节点；用 append 追加数组项；不要为了删一个键或改一条数组项而整份重写文档。
- 删除不再需要的 world 文档用 setting_delete。Runtime 仅在它不是 currentSituation、没有被 frame 或 player-view 选择、也没有被其他文档以 $ref 指向时才接受，并精确返回所有阻挡位置。
- 任何准备持久化的字符串中若仍包含字面的 \\uXXXX，说明工具参数被重复转义；该调用会被拒绝。请重新发送真实 Unicode 字符，不要要求 Runtime 猜测解码。

## 内容包在游玩中的生命周期

- 编辑对象是用于创建世界的内容包当前树；成功工具写入会直接替换这份当前树。每个已经创建的世界持有创建时复制的状态、控制与历史，并从此独立演化。
- 创建世界时，world/* 逐份成为可持续修改的 state/*，control/* 成为世界控制，opening.md 逐字成为第一条已提交主持叙事。
- opening.md 的正文只在创建时作为 genesis 提交。全新游玩上下文由世界控制与当前世界状态编译，并追加本次玩家输入；会继续约束首次行动的事实同时写入自然承载它的 world 文档。

## 游玩怎样读取并使用设定

- control/frame.yaml 的 instructions 把世界专属提示块作为作者指令；context 只按声明顺序执行确定性材料选择。
- current_situation、document 和 reference_targets 选择的整份正文会直接注入；node 只注入精确节点。catalog 只注入该目录直接子文档的 title、summary 与 @短引用，不注入正文；history 与 additional_materials 也只按精确声明注入。
- frame 声明的 catalog 目录即使当前没有文档，也会作为空状态目录由 state_list 返回，并可作为 world_create 目标；目录声明不是另一份持久状态。
- 其余世界文档由游玩 AI 按需发现：用 state_list 浏览 Runtime 返回的目录句柄，用 context_search 做原文字面搜索，再用 context_read 精确读取。可发现路径由目录、字面搜索和精确读取组成；字面 0 命中不证明事实不存在。
- control/player-views.yaml 用精确 selector 投影当前原值。它只负责展示；权限、秘密、人物认知与条件显示由世界语义另行表达。

## 游玩怎样更新设定

- 游玩 AI 的世界写入范围是 state/*：在正文已经注入或完整读取后用 world_patch 细粒度增改或删除节点，也可用 world_create 创建新文档；对象退出常驻 catalog 时用 world_retire 退役而不销毁，之后仍可读取并恢复。opening.md 的创作发生在内容包阶段；control/* 的调整属于世界外控制编辑。
- Runtime 负责提交持续状态与叙事。需要跨下一次行动保持的结果写回自然所有者；只约束眼前、没有单一所有者的局面写入当前情境；无需作为当前状态持续保存的细节留在已提交叙事。
- 机械检查通过不代表内容在游玩中容易发现。新增或重组重要信息时，必须同时决定自然所有者、初始注入或发现路径、未来更新位置和玩家显示方式。`
    : `# Runtime setting-improvement conversation contract

- Every user message is appended to the selected setting-improvement conversation. Continue its Provider context by default; only an explicit Fresh context choice compiles a new conversation from the content package's current tree. Decide whether to reply, ask, read the current tree, or change it from the user's current request.
- The current request includes eight read/write tools. A complete response with no tool calls is shown as an ordinary assistant message and settles this user invocation. A response containing tool calls is an internal tool step; continue after all results and eventually answer with a complete tool-free response.
- Tool writes directly modify the content package's current tree. Calls in one complete Provider tool response execute in order; its successful changes publish atomically when that response settles, immediately become authoritative, and require no second confirmation.
- Every write tool call settles independently and sees earlier accepted calls in response order. A failure returns its precise cause only in that call's result, does not roll back successful siblings, and does not stop later calls. Runtime automatically runs content-tree checks and a real Prompt Preview after writes and appends that review to the last successful write result.
- Read an existing file completely before changing it. Cursors from setting_list and setting_search, and read authorization from setting_read, belong only to the current-tree revision that produced them. setting_read always returns the complete exact file without truncation or pagination. Re-read after another conversation or a manual edit changes the current tree. Tools expose logical paths, never host paths.
- World documents are .yaml or .md files under world/. Special writes are limited to opening.md, control/frame.yaml, control/player-views.yaml, and control/blocks/*.md. Put characters, places, rules, and the current situation under world/, and world-specific hosting guidance under control/.
- opening.md is the first page shown to the player. Never decide the player's action, dialogue, or inner thoughts. Facts that constrain the first action must also live in the world document that naturally owns them.
- Create a world document with setting_create. You provide its unique 2-to-32-character lowercase ASCII ref, path, title, summary, aliases, and body without a technical header; Runtime completes the technical storage. Existing document selectors are automatically projected to their @refs when read. Cross-document references and control selectors use only @refs.
- A mechanical YAML reference to one whole document is a one-key map such as { $ref: "@alex" }; @alex inside an ordinary string is still only text. The document value in frame and player-view selectors is likewise "@alex", with any local position expressed separately by a locator.
- A YAML locator may mix map keys and zero-based array indexes. Use remove for one existing node and append for a new array item; never rewrite a whole document merely to delete one key or change one array item.
- Delete an obsolete world document with setting_delete. Runtime accepts it only when it is not currentSituation, no frame or player-view selects it, and no other document points to it with $ref; every blocking location is returned precisely.
- If any string to be persisted still contains a literal \\uXXXX sequence, its tool arguments were double-escaped and that call is rejected. Resend real Unicode characters; Runtime will not guess-decode them.

## Content-package lifecycle during play

- The editing target is the current tree of a content-package template used to create worlds. Successful tool writes replace that current tree directly. Each world already created from it retains the state, control, and history copied at creation and evolves independently from then on.
- When a world is created, world/* becomes independently mutable state/*, control/* becomes world control, and opening.md is committed verbatim as the first host narrative.
- The opening.md body is committed only as genesis during world creation. A fresh play context is compiled from world control and current world state, then appends the current player input. Every fact that still constrains the first action also lives in the world document that naturally owns it.

## How play reads and uses the setting

- control/frame.yaml instructions insert world-specific prompt blocks as author instructions. Its context entries perform deterministic material selections in their declared order.
- current_situation, document, and reference_targets selections inject whole bodies; node injects only one exact node. A catalog injects only title, summary, and @short-ref for direct child documents, never their bodies. History and additional materials are likewise exact selections.
- A catalog directory declared by the frame remains available through state_list as an empty state directory and as a world_create destination even when it currently contains no documents. The declaration is not a second piece of persistent state.
- Play AI discovers the remaining world documents on demand: state_list browses Runtime-provided directory handles, context_search searches literal source text, and context_read reads an exact handle. Discovery consists of directory browsing, literal search, and exact reads; zero literal matches do not prove that a fact is absent.
- control/player-views.yaml projects current values through exact selectors. Its responsibility is presentation; permissions, secrecy, character knowledge, and conditional visibility are expressed separately through world semantics.

## How play updates the setting

- Play AI writes only within state/*: after a document body is injected or completely read, world_patch adds, changes, or removes exact nodes and world_create creates a new document. Use world_retire when an entity leaves the active catalog without destroying it; the document remains readable and restorable. opening.md is authored at the content-package stage; control/* changes belong to world-external control editing.
- Runtime commits durable state and narrative. Write results that must survive the next action to their natural owner; put short-lived cross-object situations with no single owner in the current situation; leave details that do not need to remain current in committed narrative.
- Passing mechanical checks does not make content discoverable during play. Whenever important information is created or reorganized, decide its natural owner, initial injection or discovery path, future update location, and player-visible projection together.`;
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
      inputSchema: schema({ path }, ["path"]),
    },
    {
      name: "setting_create",
      description: descriptions.setting_create,
      inputSchema: schema(
        {
          path: {
            type: "string",
            pattern: "^world/.+\\.(?:ya?ml|md)$",
          },
          ref: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 240 },
          aliases: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          body: { type: "string", minLength: 1 },
        },
        ["path", "ref", "title", "summary", "aliases", "body"],
      ),
    },
    {
      name: "setting_write_file",
      description: descriptions.setting_write_file,
      inputSchema: schema(
        {
          path,
          contents: text,
          ref: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 240 },
          aliases: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        ["path", "contents"],
      ),
    },
    {
      name: "setting_patch",
      description: descriptions.setting_patch,
      inputSchema: schema(
        {
          document: text,
          op: {
            type: "string",
            enum: ["add", "replace", "append", "remove", "set_metadata"],
          },
          locator: {
            type: "array",
            minItems: 1,
            items: { type: ["string", "integer"] },
          },
          value: {},
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 240 },
          aliases: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        ["document", "op"],
      ),
    },
    {
      name: "setting_move",
      description: descriptions.setting_move,
      inputSchema: schema({ from: text, to: path }, ["from", "to"]),
    },
    {
      name: "setting_delete",
      description: descriptions.setting_delete,
      inputSchema: schema({ document: text }, ["document"]),
    },
  ];
}

const toolDescriptionsEn: Record<SettingImprovementToolName, string> = {
  setting_list:
    "List the world root or a world/ subdirectory from the content package's current tree. The root also lists opening and control files. A cursor is valid only for the same query and current-tree revision.",
  setting_search:
    "Search literal source text in world documents in the content package's current tree. within may be world, a world/ directory or path, or @ref.",
  setting_read:
    "Read a complete world document by world/ path or @ref, or read a complete opening/control file by exact path. Existing document selectors are projected to @refs. The result is never truncated or paginated.",
  setting_create:
    "Create one world/ .yaml or .md document. Supply a unique lowercase ASCII ref, title, summary, aliases, and body without a technical header; Runtime completes the storage envelope. The created document is already fully read.",
  setting_write_file:
    "Replace a completely read world/ .yaml or .md document body while preserving its identity and metadata, or create/replace opening.md, control/frame.yaml, control/player-views.yaml, or control/blocks/*.md. To repair a damaged world document, also provide ref, title, summary, and aliases; Runtime preserves any recoverable storage identity. Create new world documents with setting_create.",
  setting_patch:
    'Update a completely read YAML world document without rewriting unrelated content. locator is a non-empty path whose segments are map keys or zero-based array indexes. Use add for a missing map key or array index, replace for an existing node, append for the end of an existing array, and remove for an existing map key or array item. When title, summary, or aliases are stale, update all three together with op "set_metadata". Rewrite Markdown bodies with setting_write_file.',
  setting_move:
    "Move a completely read world document to a new world/ .yaml or .md logical path while preserving its identity and contents.",
  setting_delete:
    "Permanently delete a completely read world document from the content-package current tree. Runtime rejects deletion while currentSituation, a frame slot, a player-view selector, or another document's $ref still points to it, and reports every blocking location. Delete or redirect those references first.",
};

const toolDescriptionsZhCN: Record<SettingImprovementToolName, string> = {
  setting_list:
    "列出内容包当前树的 world 根目录或 world/ 子目录；根目录同时列出 opening 和 control 专用文件。cursor 只对同一查询和当前树 revision 有效。",
  setting_search:
    "在内容包当前树的 world 文档中按原文字面搜索；within 可为 world、world/ 目录或路径或 @ref。",
  setting_read:
    "按 world/ 路径或 @ref 完整读取世界文档，或按精确路径完整读取 opening/control；既有文档选择值自动投影为 @ref。结果不会截断或分页。",
  setting_create:
    "创建一份 world/ 下的 .yaml 或 .md 文档；提供唯一的小写 ASCII ref、标题、摘要、别名和不含技术头的正文，Runtime 自行完成存储封装。创建成功的文档视为已经完整读取。",
  setting_write_file:
    "整份替换已完整读取的 world/ .yaml 或 .md 正文并保留身份和元信息，或创建／替换 opening.md、control/frame.yaml、control/player-views.yaml、control/blocks/*.md。修复损坏世界文档时同时提供 ref、title、summary、aliases，Runtime 会保留仍可恢复的存储身份。新建世界文档使用 setting_create。",
  setting_patch:
    '细粒度更新已完整读取的 YAML 世界文档，不重写无关内容。locator 是非空路径，每段可以是 map key 或从 0 开始的数组下标；add 新建 map key 或数组位置，replace 更新既有节点，append 追加既有数组，remove 删除既有 map key 或数组项。title、summary 或 aliases 过时时用 op "set_metadata" 整组更新三项。Markdown 正文用 setting_write_file 整份重写。',
  setting_move:
    "把已完整读取的世界文档移动到新的 world/ .yaml 或 .md 逻辑路径，并保留身份与内容。",
  setting_delete:
    "从内容包当前树永久删除一份已完整读取的 world 文档。若 currentSituation、frame slot、player-view selector 或其他文档的 $ref 仍指向它，Runtime 会拒绝并返回全部精确阻挡位置；请先删除或改向这些引用。",
};

interface ReadAuthorizations {
  snapshotId: string;
  worldDocumentIds: Set<string>;
  damagedWorldPaths: Set<string>;
  opaquePaths: Set<string>;
}

interface QueryResult {
  ok: boolean;
  markdown: string;
}

export class SettingAuthoringTransaction {
  readonly #baseFiles: ContentTreeFile[];
  readonly #locale: AppLocale;
  readonly #preview: (snapshot: WorldDocumentStore) => PromptPreview;
  readonly #validateFiles: (files: readonly ContentTreeFile[]) => void;
  #snapshot: WorldDocumentStore;
  #reads: ReadAuthorizations;
  #review: SettingAuthoringReview;

  constructor(input: {
    baseFiles: readonly ContentTreeFile[];
    locale?: AppLocale;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
    validateFiles?: (files: readonly ContentTreeFile[]) => void;
    authorization?: SettingAuthoringAuthorization | null;
    revision?: string;
  }) {
    this.#baseFiles = cloneFiles(input.baseFiles);
    this.#locale = input.locale ?? defaultAppLocale;
    this.#preview = input.preview;
    this.#validateFiles = input.validateFiles ?? (() => undefined);
    this.#snapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: cloneFiles(input.baseFiles),
    });
    const authorization =
      input.authorization?.revision === (input.revision ?? this.#snapshot.id)
        ? input.authorization
        : null;
    this.#reads = {
      snapshotId: this.#snapshot.id,
      worldDocumentIds: new Set(authorization?.readWorldDocumentIds ?? []),
      damagedWorldPaths: new Set(
        authorization?.readableDamagedWorldPaths ?? [],
      ),
      opaquePaths: new Set(authorization?.readOpaquePaths ?? []),
    };
    this.#review = this.#inspect();
  }

  files(): ContentTreeFile[] {
    return cloneFiles(this.#snapshot.files);
  }

  review(): SettingAuthoringReview {
    return structuredClone(this.#review);
  }

  authorization(revision: string): SettingAuthoringAuthorization {
    return {
      revision,
      readWorldDocumentIds: [...this.#reads.worldDocumentIds].sort(),
      readableDamagedWorldPaths: [...this.#reads.damagedWorldPaths].sort(),
      readOpaquePaths: [...this.#reads.opaquePaths].sort(),
    };
  }

  execute(calls: readonly ModelHostToolCall[]): SettingAuthoringToolResult[] {
    const normalized = calls.map(normalizeCall);
    const results: SettingAuthoringToolResult[] = [];
    let lastSuccessfulWrite = -1;

    for (const call of normalized) {
      const before = this.files();
      if (isReadTool(call.name)) {
        results.push(toToolResult(call.id, this.#executeRead(call), []));
        continue;
      }
      const result = this.#executeWrite(call);
      results.push(
        toToolResult(
          call.id,
          result,
          result.ok ? fileDiff(before, this.#snapshot.files) : [],
        ),
      );
      if (result.ok) lastSuccessfulWrite = results.length - 1;
    }

    if (lastSuccessfulWrite >= 0) {
      this.#review = this.#inspect();
      const settled = results[lastSuccessfulWrite]!;
      settled.markdown = `${settled.markdown}\n\n${renderAutomaticReview(
        this.#review,
        this.#locale,
      )}`;
    }
    return results;
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

  #executeWrite(call: NormalizedCall): QueryResult {
    const snapshot = this.#snapshot;
    const reads = cloneReads(this.#reads);
    try {
      if (isWorldWriteCall(call)) {
        if (call.name === "setting_delete") {
          const deleted = deleteWorldDocument(
            snapshot,
            call,
            reads,
            this.#locale,
          );
          this.#validateFiles(deleted.snapshot.files);
          this.#snapshot = deleted.snapshot;
          this.#reads = reads;
          return success(deleted.markdown);
        }
        const requestedRef =
          call.name === "setting_create"
            ? requiredSettingRef(call.arguments.ref, this.#locale)
            : null;
        const revised = snapshot.revise({
          commands: [worldRevisionCommand(snapshot, call, this.#locale)],
        });
        if (!revised.ok)
          throw new SettingAuthoringError(
            renderRevisionFailure(revised.diagnostics, this.#locale),
          );
        if (
          requestedRef !== null &&
          revised.changes.some(({ shortRef }) => shortRef !== requestedRef)
        )
          throw new SettingAuthoringError(
            localized(
              this.#locale,
              `ref @${requestedRef} already exists; choose a different ref`,
              `ref @${requestedRef} 已存在；请换一个 ref`,
            ),
          );
        assertWorldWritesAuthorized(
          snapshot.id,
          reads,
          revised.changes,
          this.#locale,
        );
        this.#validateFiles(revised.snapshot.files);
        rebaseReads(reads, revised.snapshot);
        for (const change of revised.changes)
          reads.worldDocumentIds.add(change.documentId);
        this.#snapshot = revised.snapshot;
        this.#reads = reads;
        return success(renderWorldWriteSuccess(revised.changes, this.#locale));
      }
      if (call.name !== "setting_write_file")
        throw new SettingAuthoringError(`Unsupported write tool: ${call.name}`);
      const changed = writeOpaque(snapshot, call, reads, this.#locale);
      this.#validateFiles(changed.snapshot.files);
      this.#snapshot = changed.snapshot;
      this.#reads = reads;
      return success(changed.markdown);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "The content-package write failed";
      return failure(message, this.#locale);
    }
  }

  #inspect(): SettingAuthoringReview {
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
          message: publicSettingDiagnosticMessage(code, message, this.#locale),
        })),
        preview: null,
        playCoverage: null,
      };
    try {
      const preview = structuredClone(this.#preview(this.#snapshot));
      return {
        status: "usable",
        diff,
        diagnostics: [],
        preview,
        playCoverage: buildSettingAuthoringPlayCoverage(
          this.#snapshot,
          preview,
          diff,
        ),
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
                : "Prompt Preview failed for the current content tree",
          },
        ],
        preview: null,
        playCoverage: null,
      };
    }
  }
}

function renderAutomaticReview(
  review: SettingAuthoringReview,
  locale: AppLocale,
): string {
  if (review.status === "usable")
    return `${localized(
      locale,
      `# Current-tree review passed\n\nContent-tree validation and the real Prompt Preview both passed. This tool response changes ${review.diff.length} file(s) directly in the content package. Use this review and the coverage below to decide whether the current user request is satisfied or further edits are needed.`,
      `# 当前树自动检查通过\n\n内容树校验和真实 Prompt Preview 均已通过；本次工具响应直接修改内容包中的 ${review.diff.length} 个文件。请根据本次检查与下方覆盖报告判断当前用户要求是否已经满足，或是否还需修改。`,
    )}\n\n${renderPlayCoverage(review.playCoverage, locale)}`;
  return [
    localized(
      locale,
      "# Current-tree review needs repair",
      "# 当前树自动检查需要修复",
    ),
    "",
    ...review.diagnostics.map(
      ({ code, path, message }) => `- ${code} · ${path} · ${message}`,
    ),
    "",
    localized(
      locale,
      "Repair these diagnostics with the ordinary read/write tools. Runtime will run the review again after the next successful write call.",
      "请用普通读写工具修复这些诊断；下一个写调用成功后 Runtime 会再次自动检查。",
    ),
  ].join("\n");
}

function buildSettingAuthoringPlayCoverage(
  snapshot: WorldDocumentStore,
  preview: PromptPreview,
  diff: readonly SettingAuthoringDiff[],
): SettingAuthoringPlayCoverage {
  const documents = listQueryableWorldDocuments(snapshot);
  const byShortRef = new Map(
    documents.map((document) => [document.shortRef, document]),
  );
  const fullInjected = new Set<string>();
  const nodeInjected = new Set<string>();
  const catalogSummary = new Set<string>();
  const injectedSelections: {
    shortRef: string;
    locator: WorldDocumentLocator | null;
  }[] = [];
  const compilationCoverage = preview.compilation.coverage;

  for (const entry of compilationCoverage) {
    const authorization = entry.readAuthorization;
    if (authorization !== undefined) {
      const selection = {
        shortRef: authorization.shortRef,
        locator: authorization.locator,
      };
      injectedSelections.push(selection);
      if (authorization.locator === null)
        fullInjected.add(authorization.shortRef);
      else nodeInjected.add(authorization.shortRef);
    }
    for (const shortRef of entry.catalogEntries ?? [])
      catalogSummary.add(shortRef);
  }

  const referencedFromInjected = new Set<string>();
  for (const selection of injectedSelections) {
    const descriptor = byShortRef.get(selection.shortRef);
    if (descriptor === undefined) continue;
    const locator =
      selection.locator ??
      (descriptor.codec === "yaml" ? ({ yaml: [] } as const) : null);
    if (locator === null) continue;
    const selected = snapshot.query({
      kind: "select_node",
      document: { shortRef: selection.shortRef },
      locator,
    });
    if (selected.kind !== "select_node") continue;
    for (const reference of selected.references)
      referencedFromInjected.add(reference.target.shortRef);
  }

  const enabledWorldInstructionPaths = new Set(
    preview.compilation.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .flatMap(({ source }) =>
        source.startsWith("world:control/blocks/")
          ? [source.slice("world:".length)]
          : [],
      ),
  );

  const accessByPath = new Map<string, SettingAuthoringPlayAccess>();
  const totals: SettingAuthoringPlayCoverage["totals"] = {
    fullInjected: 0,
    nodeInjected: 0,
    catalogSummary: 0,
    referencedFromInjected: 0,
    onDemand: 0,
  };
  for (const document of documents) {
    const access = fullInjected.has(document.shortRef)
      ? "full_injected"
      : nodeInjected.has(document.shortRef)
        ? "node_injected"
        : catalogSummary.has(document.shortRef)
          ? "catalog_summary"
          : referencedFromInjected.has(document.shortRef)
            ? "referenced_from_injected"
            : "on_demand";
    accessByPath.set(document.logicalPath, access);
    incrementPlayCoverageTotal(totals, access);
  }

  return {
    totals,
    changed: diff.map(({ path, after }) => {
      const access = changedPathPlayAccess(
        path,
        after,
        accessByPath,
        enabledWorldInstructionPaths,
      );
      return { path, access, detail: playAccessDetail(access) };
    }),
  };
}

function listQueryableWorldDocuments(
  snapshot: WorldDocumentStore,
): WorldDocumentDescriptor[] {
  const documents: WorldDocumentDescriptor[] = [];
  const pending = [""];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined || visited.has(directory)) continue;
    visited.add(directory);
    let cursor: string | null = null;
    do {
      const result = snapshot.query({
        kind: "catalog",
        directory,
        limit: 100,
        cursor,
      });
      if (result.kind !== "catalog")
        throw new Error(
          `Play-coverage catalog failed for ${directory || snapshot.logicalRoot}`,
        );
      for (const entry of result.entries) {
        if (entry.kind === "directory") {
          const prefix = `${snapshot.logicalRoot}/`;
          if (!entry.logicalPath.startsWith(prefix))
            throw new Error("Play-coverage catalog escaped the logical root");
          pending.push(entry.logicalPath.slice(prefix.length));
        } else if (entry.document !== undefined) documents.push(entry.document);
      }
      cursor = result.page.nextCursor;
    } while (cursor !== null);
  }
  return documents.sort((left, right) =>
    left.logicalPath.localeCompare(right.logicalPath),
  );
}

function changedPathPlayAccess(
  path: string,
  after: string | null,
  accessByPath: ReadonlyMap<string, SettingAuthoringPlayAccess>,
  enabledWorldInstructionPaths: ReadonlySet<string>,
): SettingAuthoringPlayAccess {
  if (after === null) return "removed";
  if (path === "opening.md") return "opening_genesis";
  if (path === "control/player-views.yaml") return "player_view";
  if (path.startsWith("control/blocks/"))
    return enabledWorldInstructionPaths.has(path)
      ? "play_control"
      : "unused_control";
  if (path.startsWith("control/")) return "play_control";
  return accessByPath.get(path) ?? "on_demand";
}

function incrementPlayCoverageTotal(
  totals: SettingAuthoringPlayCoverage["totals"],
  access: SettingAuthoringPlayAccess,
): void {
  if (access === "full_injected") totals.fullInjected += 1;
  else if (access === "node_injected") totals.nodeInjected += 1;
  else if (access === "catalog_summary") totals.catalogSummary += 1;
  else if (access === "referenced_from_injected")
    totals.referencedFromInjected += 1;
  else if (access === "on_demand") totals.onDemand += 1;
}

function playAccessDetail(access: SettingAuthoringPlayAccess): string {
  const details: Record<SettingAuthoringPlayAccess, string> = {
    full_injected: "complete body is injected into every fresh play context",
    node_injected: "only a selected node is injected into fresh play context",
    catalog_summary: "catalog injects title, summary, and short reference only",
    referenced_from_injected:
      "an injected YAML selection exposes a direct short reference",
    on_demand:
      "available only through directory, literal search, and exact read",
    opening_genesis:
      "committed as genesis narrative and excluded from later fresh context",
    play_control: "compiled as immutable play-author control",
    unused_control:
      "not enabled by control/frame.yaml and unavailable to ordinary play AI",
    player_view: "projected through exact player-view selectors",
    removed: "removed from the content package current tree",
  };
  return details[access];
}

function renderPlayCoverage(
  coverage: SettingAuthoringPlayCoverage | null,
  locale: AppLocale,
): string {
  if (coverage === null)
    return localized(
      locale,
      "# Play-consumption coverage\n\nCoverage is unavailable until the real Prompt Preview succeeds.",
      "# 游玩读取覆盖\n\n真实 Prompt Preview 通过后才会提供覆盖报告。",
    );
  const labels: Record<SettingAuthoringPlayAccess, string> =
    locale === "zh-CN"
      ? {
          full_injected: "全文注入",
          node_injected: "仅节点注入",
          catalog_summary: "仅目录摘要",
          referenced_from_injected: "由已注入内容直接引用",
          on_demand: "仅按需发现",
          opening_genesis: "仅作为创世叙事提交",
          play_control: "游玩控制",
          unused_control: "未被 control/frame.yaml 启用",
          player_view: "玩家视图精确投影",
          removed: "已从内容包当前树删除",
        }
      : {
          full_injected: "full text injected",
          node_injected: "selected node only",
          catalog_summary: "catalog summary only",
          referenced_from_injected: "directly referenced from injected content",
          on_demand: "on-demand only",
          opening_genesis: "genesis narrative only",
          play_control: "play-author control",
          unused_control: "not enabled by control/frame.yaml",
          player_view: "exact player-view projection",
          removed: "removed from the content package current tree",
        };
  const maximumReportedChanges = 64;
  const reportedChanges = coverage.changed.slice(0, maximumReportedChanges);
  const changed = reportedChanges.map(
    ({ path, access }) => `- ${path} — ${labels[access]}`,
  );
  const onDemand = coverage.changed.filter(
    ({ access }) => access === "on_demand",
  );
  const unusedControl = coverage.changed.filter(
    ({ access }) => access === "unused_control",
  );
  return [
    localized(locale, "# Play-consumption coverage", "# 游玩读取覆盖"),
    "",
    localized(
      locale,
      `World documents: ${coverage.totals.fullInjected} full text injected; ${coverage.totals.nodeInjected} node-only; ${coverage.totals.catalogSummary} catalog-summary-only; ${coverage.totals.referencedFromInjected} directly referenced; ${coverage.totals.onDemand} on-demand-only.`,
      `世界文档：${coverage.totals.fullInjected} 份全文注入；${coverage.totals.nodeInjected} 份仅节点注入；${coverage.totals.catalogSummary} 份仅目录摘要；${coverage.totals.referencedFromInjected} 份由已注入内容直接引用；${coverage.totals.onDemand} 份仅按需发现。`,
    ),
    "",
    ...(changed.length > 0
      ? changed
      : [localized(locale, "- No changed files", "- 没有改动文件")]),
    ...(coverage.changed.length > reportedChanges.length
      ? [
          localized(
            locale,
            `- ${coverage.changed.length - reportedChanges.length} additional changed file(s) omitted from this compact report`,
            `- 此精简报告另省略 ${coverage.changed.length - reportedChanges.length} 个改动文件`,
          ),
        ]
      : []),
    ...(onDemand.length > 0
      ? [
          "",
          localized(
            locale,
            "Changed world documents marked on-demand only are not present in a fresh play prompt. If play should discover them reliably, consider adding a catalog, injected reference, or world instruction.",
            "标为仅按需发现的改动世界文档不会出现在全新游玩提示中；如果游玩应可靠发现它们，请考虑增加目录、由已注入内容建立引用，或加入世界指令。",
          ),
        ]
      : []),
    ...(unusedControl.length > 0
      ? [
          "",
          localized(
            locale,
            "Changed control blocks not enabled by control/frame.yaml never reach ordinary play AI. Add each intended block to frame.instructions or remove the unused file.",
            "未被 control/frame.yaml 启用的改动控制块不会进入普通游玩 AI；请把确实需要的块加入 frame.instructions，或删除无用文件。",
          ),
        ]
      : []),
  ].join("\n");
}

interface NormalizedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

class SettingAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingAuthoringError";
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
  if (
    call.name === "setting_create" ||
    call.name === "setting_patch" ||
    call.name === "setting_move" ||
    call.name === "setting_delete"
  )
    return true;
  return (
    call.name === "setting_write_file" &&
    typeof call.arguments.path === "string" &&
    call.arguments.path.startsWith("world/")
  );
}

function worldRevisionCommand(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  locale: AppLocale,
): WorldDocumentRevisionCommand {
  if (call.name === "setting_create") {
    if (
      !hasOnly(call.arguments, [
        "path",
        "ref",
        "title",
        "summary",
        "aliases",
        "body",
      ])
    )
      throw new SettingAuthoringError(
        "setting_create accepts only path, ref, title, summary, aliases, and body",
      );
    const logicalPath = safeWorldDocumentPath(
      requiredString(call.arguments.path, "path"),
      locale,
    );
    const ref = requiredSettingRef(call.arguments.ref, locale);
    const title = requiredString(call.arguments.title, "title");
    const summary = requiredString(call.arguments.summary, "summary");
    const aliases = requiredAliases(call.arguments.aliases);
    const body = requiredString(call.arguments.body, "body");
    assertNoLiteralUnicodeEscapes(
      { ref, title, summary, aliases, body },
      locale,
    );
    return {
      kind: "create",
      temporaryName: "setting-document",
      logicalPath,
      codec: logicalPath.endsWith(".md") ? "markdown" : "yaml",
      refHint: ref,
      title,
      summary,
      aliases,
      body,
    };
  }
  if (call.name === "setting_write_file") {
    const logicalPath = safeWorldDocumentPath(
      requiredString(call.arguments.path, "path"),
      locale,
    );
    const contents = worldWriteContents(
      snapshot,
      logicalPath,
      call.arguments,
      locale,
    );
    assertNoLiteralUnicodeEscapes(contents, locale);
    return {
      kind: "write",
      logicalPath,
      contents,
    };
  }
  if (call.name === "setting_move") {
    const toLogicalPath = safePath(requiredString(call.arguments.to, "to"));
    if (!/^world\/.+\.(?:ya?ml|md)$/u.test(toLogicalPath))
      throw new SettingAuthoringError(
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
    if (op === "set_metadata") {
      const title = requiredString(call.arguments.title, "title");
      const summary = requiredString(call.arguments.summary, "summary");
      const aliases = requiredAliases(call.arguments.aliases);
      assertNoLiteralUnicodeEscapes({ title, summary, aliases }, locale);
      return {
        kind: "patch",
        document: revisionTarget(
          requiredString(call.arguments.document, "document"),
        ),
        edits: [{ op: "set_metadata", title, summary, aliases }],
      };
    }
    if (op !== "add" && op !== "replace" && op !== "append" && op !== "remove")
      throw new SettingAuthoringError(
        "setting_patch.op must be add, replace, append, remove, or set_metadata",
      );
    const locator = requiredYamlLocatorPath(call.arguments.locator, "locator");
    if (op === "remove") {
      if (!hasOnly(call.arguments, ["document", "op", "locator"]))
        throw new SettingAuthoringError(
          "setting_patch remove accepts only document, op, and locator",
        );
      assertNoLiteralUnicodeEscapes(locator, locale);
      return {
        kind: "patch",
        document: revisionTarget(
          requiredString(call.arguments.document, "document"),
        ),
        edits: [{ op: "remove", locator: { yaml: locator } }],
      };
    }
    if (
      !hasOnly(call.arguments, ["document", "op", "locator", "value"]) ||
      !Object.hasOwn(call.arguments, "value")
    )
      throw new SettingAuthoringError(
        `setting_patch ${op} requires document, op, locator, and value`,
      );
    const value = structuredClone(
      call.arguments.value,
    ) as WorldDocumentRevisionYamlValue;
    assertNoLiteralUnicodeEscapes({ locator, value }, locale);
    return {
      kind: "patch",
      document: revisionTarget(
        requiredString(call.arguments.document, "document"),
      ),
      edits: [
        {
          op,
          locator: {
            yaml: locator,
          },
          value,
        },
      ],
    };
  }
  throw new SettingAuthoringError(`Unsupported write tool: ${call.name}`);
}

function safeWorldDocumentPath(path: string, locale: AppLocale): string {
  const logicalPath = safePath(path);
  if (!/^world\/.+\.(?:ya?ml|md)$/u.test(logicalPath))
    throw new SettingAuthoringError(
      localized(
        locale,
        "World files must be .yaml or .md documents below world/",
        "world 文件必须是 world/ 下的 .yaml 或 .md 文档",
      ),
    );
  return logicalPath;
}

function worldWriteContents(
  snapshot: WorldDocumentStore,
  logicalPath: string,
  args: Record<string, unknown>,
  locale: AppLocale,
): string {
  if (
    !hasOnly(args, ["path", "contents", "ref", "title", "summary", "aliases"])
  )
    throw new SettingAuthoringError(
      "setting_write_file accepts only its declared arguments",
    );
  const body = requiredString(args.contents, "contents");
  const metadataKeys = ["ref", "title", "summary", "aliases"] as const;
  const provided = metadataKeys.filter((key) => args[key] !== undefined);
  const existingFile = snapshot.files.some(({ path }) => path === logicalPath);
  const existingDocument = listQueryableWorldDocuments(snapshot).some(
    ({ logicalPath: existingPath }) => existingPath === logicalPath,
  );
  if (provided.length === 0) {
    if (!existingFile && !containsTechnicalDocumentHeader(logicalPath, body))
      throw new SettingAuthoringError(
        localized(
          locale,
          "Create a new world document with setting_create",
          "新建世界文档请使用 setting_create",
        ),
      );
    if (
      existingFile &&
      !existingDocument &&
      !containsTechnicalDocumentHeader(logicalPath, body)
    )
      throw new SettingAuthoringError(
        localized(
          locale,
          "Repair a damaged document by providing ref, title, summary, and aliases with its body",
          "修复损坏文档时，请在正文之外同时提供 ref、title、summary 和 aliases",
        ),
      );
    return body;
  }
  if (provided.length !== metadataKeys.length)
    throw new SettingAuthoringError(
      localized(
        locale,
        "Repair metadata must provide ref, title, summary, and aliases together",
        "修复元信息时必须同时提供 ref、title、summary 和 aliases",
      ),
    );
  if (!existingFile)
    throw new SettingAuthoringError(
      localized(
        locale,
        "Create a new world document with setting_create",
        "新建世界文档请使用 setting_create",
      ),
    );
  if (existingDocument)
    throw new SettingAuthoringError(
      localized(
        locale,
        "Repair metadata is only for a damaged document; update valid metadata with setting_patch set_metadata",
        "修复元信息只用于损坏文档；有效文档请用 setting_patch set_metadata 更新元信息",
      ),
    );
  const ref = requiredSettingRef(args.ref, locale);
  const title = requiredString(args.title, "title");
  const summary = requiredString(args.summary, "summary");
  const aliases = requiredAliases(args.aliases);
  assertNoLiteralUnicodeEscapes({ body, ref, title, summary, aliases }, locale);
  const storedId = recoverStoredDocumentId(snapshot, logicalPath);
  const header = {
    $document: {
      ...(storedId === null ? {} : { id: storedId }),
      ref,
      title,
      summary,
      aliases,
    },
  };
  if (logicalPath.endsWith(".md"))
    return `---\n${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${body.trimEnd()}\n`;
  return `${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n${body.trimStart()}`;
}

function containsTechnicalDocumentHeader(
  logicalPath: string,
  source: string,
): boolean {
  if (logicalPath.endsWith(".md"))
    return /^---\r?\n[\s\S]*?^\$document\s*:/mu.test(source);
  return /^\s*\$document\s*:/u.test(source);
}

function recoverStoredDocumentId(
  snapshot: WorldDocumentStore,
  logicalPath: string,
): string | null {
  const source = snapshot.files.find(
    ({ path }) => path === logicalPath,
  )?.contents;
  if (source === undefined) return null;
  const yamlSource = logicalPath.endsWith(".md")
    ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1]
    : source;
  if (yamlSource === undefined) return null;
  const document = parseDocument(yamlSource, { uniqueKeys: true });
  if (document.errors.length > 0) return null;
  const id = document.getIn(["$document", "id"]);
  return typeof id === "string" &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(id)
    ? id
    : null;
}

function revisionTarget(value: string): WorldDocumentRevisionTarget {
  const selector = documentSelector(value);
  if (selector === null)
    throw new SettingAuthoringError(
      `Invalid world-document selector: ${value}`,
    );
  return selector;
}

interface SettingDocumentDeletionBlocker {
  path: string;
  locator: string;
}

function deleteWorldDocument(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  reads: ReadAuthorizations,
  locale: AppLocale,
): { snapshot: WorldDocumentStore; markdown: string } {
  if (!hasOnly(call.arguments, ["document"]))
    throw new SettingAuthoringError(
      "setting_delete accepts only the document argument",
    );
  const supplied = requiredString(call.arguments.document, "document");
  const selector = documentSelector(supplied);
  if (selector === null)
    throw new SettingAuthoringError(
      localized(
        locale,
        "setting_delete.document must be an @ref or world/ document path",
        "setting_delete.document 必须是 @ref 或 world/ 文档路径",
      ),
    );
  const resolved = snapshot.query({
    kind: "read_document",
    document: selector,
  });
  if (resolved.kind === "error")
    throw new SettingAuthoringError(
      renderRevisionFailure(resolved.diagnostics, locale),
    );
  if (resolved.kind !== "read_document")
    throw new Error("Unexpected world-document delete lookup result");
  const target = resolved.document;
  if (
    reads.snapshotId !== snapshot.id ||
    !reads.worldDocumentIds.has(target.documentId)
  )
    throw new SettingAuthoringError(
      localized(
        locale,
        `Read @${target.shortRef} completely before deleting it`,
        `删除 @${target.shortRef} 前必须完整读取该文档`,
      ),
    );
  const blockers = settingDocumentDeletionBlockers(snapshot, target);
  if (blockers.length > 0) {
    const locations = blockers
      .map(({ path, locator }) => `- ${path} · ${locator}`)
      .join("\n");
    throw new SettingAuthoringError(
      localized(
        locale,
        `Cannot delete @${target.shortRef}; remove or redirect every reference first:\n${locations}`,
        `无法删除 @${target.shortRef}；请先删除或改向全部引用：\n${locations}`,
      ),
    );
  }
  const revised = WorldDocumentStore.open({
    layout: "content_package",
    files: sortFiles(
      snapshot.files.filter(({ path }) => path !== target.logicalPath),
    ),
  });
  rebaseReads(reads, revised);
  reads.worldDocumentIds.delete(target.documentId);
  reads.damagedWorldPaths.delete(target.logicalPath);
  return {
    snapshot: revised,
    markdown: localized(
      locale,
      `# Current-tree deletion accepted\n\nDeleted @${target.shortRef} · ${target.logicalPath}. No currentSituation binding, frame slot, player-view selector, or cross-document $ref points to it.`,
      `# 当前树删除已接受\n\n已删除 @${target.shortRef} · ${target.logicalPath}。没有 currentSituation、frame slot、player-view selector 或跨文档 $ref 指向它。`,
    ),
  };
}

function settingDocumentDeletionBlockers(
  snapshot: WorldDocumentStore,
  target: WorldDocumentDescriptor,
): SettingDocumentDeletionBlocker[] {
  const blockers: SettingDocumentDeletionBlocker[] = [];
  for (const document of listQueryableWorldDocuments(snapshot)) {
    if (document.documentId === target.documentId || document.codec !== "yaml")
      continue;
    const selected = snapshot.query({
      kind: "select_node",
      document: { documentId: document.documentId },
      locator: { yaml: [] },
    });
    if (selected.kind !== "select_node") continue;
    for (const reference of selected.references)
      if (reference.target.documentId === target.documentId)
        blockers.push({
          path: document.logicalPath,
          locator: deletionLocator(reference.locator),
        });
  }
  blockers.push(
    ...controlDocumentDeletionBlockers(snapshot, target, "control/frame.yaml"),
    ...controlDocumentDeletionBlockers(
      snapshot,
      target,
      "control/player-views.yaml",
    ),
  );
  return [
    ...new Map(
      blockers.map((item) => [`${item.path}\0${item.locator}`, item]),
    ).values(),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.locator.localeCompare(right.locator),
  );
}

function controlDocumentDeletionBlockers(
  snapshot: WorldDocumentStore,
  target: WorldDocumentDescriptor,
  path: "control/frame.yaml" | "control/player-views.yaml",
): SettingDocumentDeletionBlocker[] {
  const stored = snapshot.files.find((file) => file.path === path);
  if (stored === undefined || stored.encoding !== undefined) return [];
  const source = projectOpaqueDocumentIds(snapshot, path, stored.contents);
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) return [];
  const expected = `@${target.shortRef}`;
  const blockers: SettingDocumentDeletionBlocker[] = [];
  const recordIfTarget = (
    selectorPath: readonly (string | number)[],
    label: string,
  ): void => {
    const node = document.getIn(selectorPath, true);
    if (isScalar(node) && node.value === expected)
      blockers.push({ path, locator: label });
  };
  if (path === "control/frame.yaml") {
    recordIfTarget(
      ["bindings", "currentSituation"],
      "bindings.currentSituation",
    );
    const context = document.getIn(["context"], true);
    if (isSeq(context))
      for (const index of context.items.keys()) {
        recordIfTarget(
          ["context", index, "slot", "document"],
          `context[${index}].slot.document`,
        );
        recordIfTarget(
          ["context", index, "slot", "from", "document"],
          `context[${index}].slot.from.document`,
        );
      }
  } else {
    const views = document.getIn(["views"], true);
    if (isSeq(views))
      for (const viewIndex of views.items.keys()) {
        const items = document.getIn(["views", viewIndex, "items"], true);
        if (!isSeq(items)) continue;
        for (const itemIndex of items.items.keys())
          recordIfTarget(
            ["views", viewIndex, "items", itemIndex, "select", "document"],
            `views[${viewIndex}].items[${itemIndex}].select.document`,
          );
      }
  }
  return blockers;
}

function deletionLocator(locator: WorldDocumentLocator): string {
  return "yaml" in locator
    ? `yaml:${JSON.stringify(locator.yaml)}`
    : `markdown:${JSON.stringify(locator.markdown)}`;
}

function writeOpaque(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  reads: ReadAuthorizations,
  locale: AppLocale,
): { snapshot: WorldDocumentStore; markdown: string } {
  if (!hasOnly(call.arguments, ["path", "contents"]))
    throw new SettingAuthoringError(
      "Special-file writes accept only path and contents",
    );
  const path = safePath(requiredString(call.arguments.path, "path"));
  if (!writableOpaquePath(path))
    throw new SettingAuthoringError(
      localized(
        locale,
        "Special-file writes accept only opening.md, control/frame.yaml, control/player-views.yaml, or control/blocks/*.md",
        "专用文件只允许写入 opening.md、control/frame.yaml、control/player-views.yaml 或 control/blocks/*.md",
      ),
    );
  const authoredContents = requiredString(call.arguments.contents, "contents");
  assertNoLiteralUnicodeEscapes(authoredContents, locale);
  const contents = projectOpaqueDocumentIds(snapshot, path, authoredContents);
  const next = cloneFiles(snapshot.files);
  const existing = next.find((file) => file.path === path);
  if (existing !== undefined && !reads.opaquePaths.has(path))
    throw new SettingAuthoringError(
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
      `# Current-tree write accepted\n\n${existing === undefined ? "Created" : "Updated"} ${path} in the content package's current tree. This file is already fully read; do not read it again unless a later decision needs Runtime's exact serialization.`,
      `# 当前树写入已接受\n\n已在内容包当前树中${existing === undefined ? "创建" : "更新"} ${path}。该文件已视为完整读取；除非后续判断依赖 Runtime 的精确序列化结果，否则不要再次读取。`,
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
    throw new Error(
      "Read authorization belongs to another current-tree revision",
    );
  for (const change of changes) {
    if (
      change.before === null ||
      reads.worldDocumentIds.has(change.documentId) ||
      reads.damagedWorldPaths.has(change.before.logicalPath)
    )
      continue;
    throw new SettingAuthoringError(
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
  locale: AppLocale,
): string {
  return [
    localized(
      locale,
      "# Current-tree revision accepted",
      "# 当前树 revision 已接受",
    ),
    "",
    ...(changes.length === 0
      ? [localized(locale, "- No file changed", "- 没有文件发生变化")]
      : changes.map((change) => {
          if (change.before === null)
            return `- ${localized(locale, "Created", "创建")} @${change.shortRef} · ${change.after.logicalPath}`;
          if (change.before.logicalPath === change.after.logicalPath)
            return `- ${localized(locale, "Updated", "更新")} @${change.shortRef} · ${change.after.logicalPath}`;
          return `- ${localized(locale, "Moved", "移动")} @${change.shortRef} · ${change.before.logicalPath} → ${change.after.logicalPath}`;
        })),
    "",
    localized(
      locale,
      "This call was accepted independently. Every created or changed document above is already fully read; do not read it again unless a later decision needs Runtime's exact serialization.",
      "本调用已独立接受。上方新建或修改的文档均视为已经完整读取；除非后续判断依赖 Runtime 的精确序列化结果，否则不要再次读取。",
    ),
  ].join("\n");
}

function renderRevisionFailure(
  diagnostics: readonly {
    code: string;
    logicalPath?: string;
    message: string;
  }[],
  locale: AppLocale,
): string {
  return diagnostics
    .map(
      ({ code, logicalPath, message }) =>
        `${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${publicSettingDiagnosticMessage(code, message, locale)}`,
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
  return invalidScope;
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
    path.length === 0
  )
    return failure("Invalid setting_read arguments", locale);
  const opaque = snapshot.files.find(
    (file) => file.path === path && !file.path.startsWith("world/"),
  );
  if (opaque !== undefined) {
    if (opaque.encoding !== undefined)
      return failure("Special files require one complete text read", locale);
    reads.opaquePaths.add(path);
    const projected = projectOpaqueDocumentIds(snapshot, path, opaque.contents);
    return success(
      `# ${localized(locale, "Special-file source", "专用文件原文")} ${path}\n\n${projected}\n\n---\nComplete: yes`,
    );
  }
  const selector = documentSelector(path);
  if (selector === null)
    return failure(
      selector === null && typeof path === "string" && !path.includes("/")
        ? "Use @ref or a world/ logical path"
        : "Invalid setting_read path",
      locale,
    );
  const result = snapshot.query({
    kind: "read_document",
    document: selector,
    referenceProjection: "short_ref",
  });
  if (result.kind === "error") {
    if (repairableDamagedWorldRead(snapshot, path, result))
      reads.damagedWorldPaths.add(path);
    return renderQueryFailure(result, locale);
  }
  if (result.kind !== "read_document")
    throw new Error("Unexpected read result");
  reads.worldDocumentIds.add(result.document.documentId);
  return success(
    `# ${localized(locale, "Exact read", "精确读取")} @${result.document.shortRef}\n\ntitle: ${result.document.title}\nsummary: ${result.document.summary}\ncodec: ${result.document.codec}\nlogicalPath: ${result.document.logicalPath}\n[body]\n${result.body.trimEnd()}\n[/body]\n\n---\nComplete: yes`,
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
  // malformed. Bad selectors, missing documents, and ambiguity must never
  // turn into a read-before-write bypass.
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
  return null;
}

function projectOpaqueDocumentIds(
  snapshot: WorldDocumentStore,
  path: string,
  source: string,
): string {
  if (path !== "control/frame.yaml" && path !== "control/player-views.yaml")
    return source;
  const byId = new Map(
    listQueryableWorldDocuments(snapshot).map((document) => [
      document.documentId,
      document.shortRef,
    ]),
  );
  if (byId.size === 0) return source;
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) return source;
  let changed = false;
  const projectAt = (selectorPath: readonly (string | number)[]): void => {
    const node = document.getIn(selectorPath, true);
    if (!isScalar(node) || typeof node.value !== "string") return;
    const shortRef = byId.get(node.value);
    if (shortRef === undefined) return;
    node.value = `@${shortRef}`;
    changed = true;
  };
  if (path === "control/frame.yaml") {
    projectAt(["bindings", "currentSituation"]);
    const context = document.getIn(["context"], true);
    if (isSeq(context))
      for (const index of context.items.keys()) {
        projectAt(["context", index, "slot", "document"]);
        projectAt(["context", index, "slot", "from", "document"]);
      }
  } else {
    const views = document.getIn(["views"], true);
    if (isSeq(views))
      for (const viewIndex of views.items.keys()) {
        const items = document.getIn(["views", viewIndex, "items"], true);
        if (!isSeq(items)) continue;
        for (const itemIndex of items.items.keys())
          projectAt([
            "views",
            viewIndex,
            "items",
            itemIndex,
            "select",
            "document",
          ]);
      }
  }
  return changed ? document.toString({ indent: 2, lineWidth: 0 }) : source;
}

function renderQueryFailure(
  result: WorldDocumentQueryFailure,
  locale: AppLocale,
): QueryResult {
  return failure(
    result.diagnostics
      .map(
        ({ code, logicalPath, message }) =>
          `${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${publicSettingDiagnosticMessage(code, message, locale)}`,
      )
      .join("\n"),
    locale,
  );
}

function publicSettingDiagnosticMessage(
  code: string,
  message: string,
  locale: AppLocale,
): string {
  if (
    code === "document_header_invalid" ||
    code === "document_identity_invalid" ||
    code === "invalid_document_header"
  )
    return localized(
      locale,
      "Document storage metadata is missing or damaged. Repair this document with setting_write_file using its ref, title, summary, aliases, and body",
      "文档存储元信息缺失或损坏；请用 setting_write_file 提供 ref、title、summary、aliases 和正文进行修复",
    );
  if (code === "document_identity_duplicate" || code === "duplicate_id")
    return localized(
      locale,
      "Runtime-owned storage identity is duplicated; repair the affected document without supplying an identity",
      "Runtime 维护的存储身份发生重复；请修复受影响文档，不要提供内部身份",
    );
  if (code === "document_short_ref_invalid")
    return localized(
      locale,
      "Document ref must be a 2-to-32-character lowercase ASCII short handle; repair it with setting_write_file and public metadata",
      "文档 ref 必须是 2～32 位小写 ASCII 短句柄；请用 setting_write_file 和公开元信息修复",
    );
  if (code === "document_short_ref_duplicate" || code === "duplicate_ref")
    return localized(
      locale,
      "Document refs must be unique; choose a different ref for the affected document",
      "文档 ref 必须唯一；请为受影响文档选择另一个 ref",
    );
  return message
    .replaceAll("$document.id", "Runtime-owned storage identity")
    .replaceAll("$document.ref", "ref")
    .replaceAll("$document technical header", "document storage metadata")
    .replaceAll("$document", "document storage metadata")
    .replace(/document identity/giu, "Runtime-owned storage identity");
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

function toToolResult(
  id: string,
  result: QueryResult,
  changes: SettingAuthoringDiff[],
): SettingAuthoringToolResult {
  return {
    toolCallId: id,
    markdown: result.markdown,
    isError: !result.ok,
    changes,
  };
}

function cloneReads(source: ReadAuthorizations): ReadAuthorizations {
  return {
    snapshotId: source.snapshotId,
    worldDocumentIds: new Set(source.worldDocumentIds),
    damagedWorldPaths: new Set(source.damagedWorldPaths),
    opaquePaths: new Set(source.opaquePaths),
  };
}

function rebaseReads(
  reads: ReadAuthorizations,
  snapshot: WorldDocumentStore,
): void {
  reads.snapshotId = snapshot.id;
}

function fileDiff(
  baseFiles: readonly ContentTreeFile[],
  draftFiles: readonly ContentTreeFile[],
): SettingAuthoringDiff[] {
  const before = new Map(baseFiles.map((file) => [file.path, file]));
  const after = new Map(draftFiles.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path): SettingAuthoringDiff[] => {
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
    throw new SettingAuthoringError(`Unsafe content-package path: ${path}`);
  return path;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SettingAuthoringError(`${name} must be a non-empty string`);
  return value;
}

function requiredSettingRef(value: unknown, locale: AppLocale): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 32 ||
    !/^[a-z][a-z0-9-]*$/u.test(value)
  )
    throw new SettingAuthoringError(
      localized(
        locale,
        "ref must be 2 to 32 lowercase ASCII letters, digits, or hyphens, beginning with a letter",
        "ref 必须是 2～32 位小写 ASCII 字母、数字或连字符，并以字母开头",
      ),
    );
  return value;
}

function requiredAliases(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        [...item].length >= 1 &&
        [...item].length <= 64,
    )
  )
    throw new SettingAuthoringError(
      "aliases must be an array of at most 16 strings, each 1 to 64 characters",
    );
  return value.filter(
    (item: unknown): item is string => typeof item === "string",
  );
}

function assertNoLiteralUnicodeEscapes(
  value: unknown,
  locale: AppLocale,
): void {
  const seen = new Set<object>();
  const walk = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (/\\u[0-9a-f]{4}/iu.test(candidate))
        throw new SettingAuthoringError(
          localized(
            locale,
            "Persisted text contains a literal Unicode escape such as \\u4f60. Resend real Unicode characters instead of a double-escaped string",
            "待写入文本包含 \\u4f60 这类字面 Unicode 转义；请重新发送真实 Unicode 字符，不要发送重复转义字符串",
          ),
        );
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) walk(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      walk(key);
      walk(item);
    }
  };
  walk(value);
}

function requiredYamlLocatorPath(
  value: unknown,
  name: string,
): (string | number)[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item) =>
        (typeof item === "string" && item.length > 0) ||
        (typeof item === "number" && Number.isInteger(item) && item >= 0),
    )
  )
    throw new SettingAuthoringError(
      `${name} must be a non-empty array of map keys or zero-based array indexes`,
    );
  return value.filter(
    (item: unknown): item is string | number =>
      typeof item === "string" || typeof item === "number",
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
