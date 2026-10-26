import { isPackageFollowupControlPath } from "../content/PackageFollowups.ts";
import { renderWorldMaintenanceReport } from "../prompt/WorldMaintenanceReport.ts";
import { listWorldDocuments as listQueryableWorldDocuments } from "../prompt/WorldMaintenanceReport.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import { defaultAppLocale } from "../../protocol/appPreferences.ts";
import {
  fictionGameplay,
  gameplayLabel,
  gameplayPath,
  readGameplay,
  type Gameplay,
} from "../../protocol/gameplay.ts";
import { isScalar, isSeq, parseDocument, stringify } from "yaml";
import { tabletopSchemeReceipt } from "../play/TabletopRules.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { inspectContentPackageCurrentTree } from "../content/FileNativeContentTree.ts";
import type { ModelHostToolCall } from "../model/ModelHost.ts";
import {
  coerceToolArguments,
  renderCoercionNote,
} from "../model/ToolArgumentCoercion.ts";
import {
  renderToolAliasNote,
  resolveToolName,
} from "../prompt/ToolNameAlias.ts";
import { worldMaterialCoverage } from "../prompt/WorldMaterialCoverage.ts";
import type {
  PromptCompilation,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import type { AuthoringPreloadRecord } from "../authoring/AuthoringRequestSnapshot.ts";
import {
  WorldDocumentStore,
  type WorldDocumentCatalogResult,
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

/** Operation shared by every authoring surface; its tool name is surface-specific. */
export type SettingAuthoringOperation =
  | "list"
  | "search"
  | "read"
  | "create"
  | "write_file"
  | "patch"
  | "move"
  | "delete";

const authoringOperations = [
  "list",
  "search",
  "read",
  "create",
  "write_file",
  "patch",
  "move",
  "delete",
] as const satisfies readonly SettingAuthoringOperation[];

/** Phrases a surface uses when Runtime writes a message or a review. */
interface SettingAuthoringPhrases {
  /** The editable tree, e.g. "the content package's current tree". */
  readonly tree: string;
  /** The same tree without its article, used in play-coverage details. */
  readonly bareTree: string;
  /** The tree's owner as a noun phrase, e.g. "the content package". */
  readonly noun: string;
  /** Hyphenated owner name for internal path diagnostics. */
  readonly slug: string;
  readonly directoryHeading: string;
}

/**
 * Everything model-visible that differs between the content-package setting
 * improvement and a world revision. Each surface renders its own words
 * directly; nothing is rewritten after rendering.
 */
export interface SettingAuthoringSurface {
  /** Store layout that owns this surface's logical document namespace. */
  readonly layout: "content_package" | "world_revision";
  /** Logical namespace of world documents: `world` or `state`. */
  readonly root: "world" | "state";
  /** Model-facing tool name prefix, e.g. `setting` or `world_revision`. */
  readonly toolPrefix: "setting" | "world_revision";
  /** Whether opening.md is a special file of this tree. */
  readonly opening: boolean;
  readonly phrases: Record<AppLocale, SettingAuthoringPhrases>;
  readonly descriptions: Record<
    AppLocale,
    (tabletop: boolean) => Record<SettingAuthoringOperation, string>
  >;
  /** Returns the model-facing rejection for a path outside this surface, if any. */
  readonly unavailablePath: (path: string, locale: AppLocale) => string | null;
}

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

/**
 * Model-facing mention of control/gameplay.json. Only a tabletop package may
 * change the scheme, so fiction packages never see the file in their contract
 * or tool text. Runtime validation of the path is unaffected.
 */
function gameplayFileZh(tabletop: boolean): string {
  return tabletop
    ? "、control/blocks/*.md 和 control/gameplay.json（只能修改跑团判定方案，玩法模式不可改）"
    : " 和 control/blocks/*.md";
}

function gameplayFileEn(tabletop: boolean): string {
  return tabletop
    ? ", control/blocks/*.md, and control/gameplay.json (only a tabletop resolution scheme may change)"
    : ", and control/blocks/*.md";
}

export function settingImprovementRuntimeContract(
  locale: AppLocale,
  gameplay: Gameplay,
): string {
  const tabletop = gameplay.mode === "tabletop";
  return locale === "zh-CN"
    ? `# Runtime 设定完善对话契约

- 每条用户消息都追加到所选设定完善对话。默认沿该对话的 Provider 上下文继续；用户显式选择“全新上下文”时，Runtime 才从内容包当前树编译一段新对话。根据用户当前要求决定直接回复、提出问题、读取当前树或修改当前树。
- 当前请求随附八个读写工具。不调用工具的完整响应会作为普通助手消息显示，并结束本次用户调用。含有工具调用的响应是内部工具步骤；收到全部工具结果后继续处理，最终用一个不调用工具的完整响应答复用户。
- 工具写入直接修改内容包当前树。每个完整 Provider 工具响应中的调用按顺序执行，成功改动在该响应结算时原子发布，发布后立即成为内容包权威，无需另一步确认。
- 每个写工具调用独立结算，并按本响应中的调用顺序读取之前已接受的结果。某个调用失败只在对应工具结果中返回精确原因，不回滚同一响应内其他成功调用，也不阻止后续调用。Runtime 在写调用结算后自动运行内容树检查和真实 Prompt Preview，并把检查结果附在最后一个成功写调用的结果中。
- 修改既有文件前必须完整读取它。setting_search 的 cursor，以及 setting_read 的读取授权，只属于产生它们的当前树 revision；任何其他对话或手动编辑改变当前树后，必须重新读取再写。setting_read 总是完整返回精确文件，不截断、不分页。工具只暴露逻辑路径，不暴露宿主路径。
- world/ 下只写 .yaml 或 .md 世界文档；专用文件只允许 opening.md、control/frame.yaml、control/player-views.yaml${gameplayFileZh(tabletop)}，以及 control/followups.yaml 和其中引用的 prompts/*.md、renderers/*.html、scripts/*.js、regex/*.yaml、assets/* 文本资源。人物、地点、规则与当前情境放在 world/，本世界特有的主持要求放在 control/。
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

- control/frame.yaml 的 instructions 把世界专属提示块作为作者指令；每项可带 turnGuide（单行），或只含 turnGuide：这些行成为每次游玩发送追加在玩家输入之后的本轮提示中的世界尾部行，只放本世界特有且最容易丢的约束，一到两行，不复制跨世界规则。context 只按声明顺序执行确定性材料选择。
- 可在 frame.maintenance.documents 中用 @短引用声明正文建议 UTF-8 字节数；slot 可声明唯一稳定 id 和 advisoryBytes。超限只提示，不截断或拒绝写入。frame.maintenance.clock 可明确绑定 {document: "@ref", locator: {yaml: [时间]}}；只记录该次写入时的标量或 Markdown 文本，不推断时钟。
- current_situation、document 和 reference_targets 选择的整份正文会直接注入；node 只注入精确节点。catalog 只注入该目录直接子文档的 title、summary 与 @短引用，不注入正文；history 与 additional_materials 也只按精确声明注入。
- frame 声明的 catalog 目录即使当前没有文档，也会作为空状态目录由 state_list 返回，并可作为 world_create 目标；目录声明不是另一份持久状态。
- 其余世界文档由游玩 AI 按需发现：用 state_list 浏览 Runtime 返回的目录句柄，用 context_search 做原文字面搜索，再用 context_read 精确读取。可发现路径由目录、字面搜索和精确读取组成；字面 0 命中不证明事实不存在。
- control/followups.yaml 可用 narraeon.package-followups/v1 声明 followups 有序数组；每项包含稳定 id、displayName、enabled、mount、prompt（role: author_instruction、markdown 相对 control/）、artifacts 和 maxArtifactBytes。启停保留定义与资源；它们在主叙事提交后独立生成界面产物，不写世界。脚本授权是用户本地设置，文件不能自授信任。
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
- Read an existing file completely before changing it. Cursors from setting_search, and read authorization from setting_read, belong only to the current-tree revision that produced them. setting_read always returns the complete exact file without truncation or pagination. Re-read after another conversation or a manual edit changes the current tree. Tools expose logical paths, never host paths.
- World documents are .yaml or .md files under world/. Special writes are limited to opening.md, control/frame.yaml, control/player-views.yaml${gameplayFileEn(tabletop)}, plus control/followups.yaml and its referenced prompts/*.md, renderers/*.html, scripts/*.js, regex/*.yaml and assets/* text resources. Put characters, places, rules, and the current situation under world/, and world-specific hosting guidance under control/.
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

- control/frame.yaml instructions insert world-specific prompt blocks as author instructions. Each entry may carry a single-line turnGuide, or consist of turnGuide alone: these lines become the world's tail lines in the turn guide appended after the player input on every play send. Keep them to one or two world-specific, easily lost constraints; never copy cross-world rules. Its context entries perform deterministic material selections in their declared order.
- Optional frame.maintenance.documents maps @short-refs to advisory body UTF-8 byte counts; slots can declare a unique stable id and advisoryBytes. Excess size only produces advice. Optional frame.maintenance.clock binds {document: "@ref", locator: {yaml: [time]}} to record scalar or Markdown world time at actual writes, without inferring a clock.
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
  locale: AppLocale,
  gameplay: Gameplay,
): PromptCompilation["tools"] {
  return authoringToolDefinitions(
    contentPackageAuthoringSurface,
    locale,
    gameplay,
  );
}

/** Tool definitions a surface exposes; names, paths and descriptions come from the surface. */
export function authoringToolDefinitions(
  surface: SettingAuthoringSurface,
  locale: AppLocale,
  gameplay: Gameplay,
): PromptCompilation["tools"] {
  const tabletop = gameplay.mode === "tabletop";
  const descriptions = surface.descriptions[locale](tabletop);
  const name = (operation: SettingAuthoringOperation) =>
    authoringToolName(surface, operation);
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
      name: name("list"),
      description: descriptions.list,
      inputSchema: schema(
        {
          directory: {
            type: "string",
            pattern: `^${surface.root}(?:/[^\\\\]+)?$`,
          },
        },
        [],
      ),
    },
    {
      name: name("search"),
      description: descriptions.search,
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
      name: name("read"),
      description: descriptions.read,
      inputSchema: schema({ path }, ["path"]),
    },
    {
      name: name("create"),
      description: descriptions.create,
      inputSchema: schema(
        {
          path: {
            type: "string",
            pattern: `^${surface.root}/.+\\.(?:ya?ml|md)$`,
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
      name: name("write_file"),
      description: descriptions.write_file,
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
      name: name("patch"),
      description: descriptions.patch,
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
      name: name("move"),
      description: descriptions.move,
      inputSchema: schema({ from: text, to: path }, ["from", "to"]),
    },
    {
      name: name("delete"),
      description: descriptions.delete,
      inputSchema: schema({ document: text }, ["document"]),
    },
  ];
}

const toolDescriptionsEn = (
  tabletop: boolean,
): Record<SettingAuthoringOperation, string> => ({
  list: "List the world root or a world/ subdirectory from the content package's current tree. The root also lists opening and control files. Each call returns the whole directory.",
  search:
    "Search literal source text in world documents in the content package's current tree. within may be world, a world/ directory or path, or @ref.",
  read: "Read a complete world document by world/ path or @ref, or read a complete opening/control file by exact path. Existing document selectors are projected to @refs. The result is never truncated or paginated.",
  create:
    "Create one world/ .yaml or .md document. Supply a unique lowercase ASCII ref, title, summary, aliases, and body without a technical header; Runtime completes the storage envelope. The created document is already fully read.",
  write_file: `Replace a completely read world/ .yaml or .md document body while preserving its identity and metadata, or create/replace opening.md, control/frame.yaml, control/player-views.yaml, ${tabletop ? "control/blocks/*.md, or control/gameplay.json (only a tabletop resolution scheme may change)" : "or control/blocks/*.md"}, plus control/followups.yaml and its referenced prompts/*.md, renderers/*.html, scripts/*.js, regex/*.yaml and assets/* text resources. To repair a damaged world document, also provide ref, title, summary, and aliases; Runtime preserves any recoverable storage identity. Create new world documents with setting_create.`,
  patch:
    'Update a completely read YAML world document without rewriting unrelated content. locator is a non-empty path whose segments are map keys or zero-based array indexes. Use add for a missing map key or array index, replace for an existing node, append for the end of an existing array, and remove for an existing map key or array item. When title, summary, or aliases are stale, update all three together with op "set_metadata". Rewrite Markdown bodies with setting_write_file.',
  move: "Move a completely read world document to a new world/ .yaml or .md logical path while preserving its identity and contents.",
  delete:
    "Permanently delete a completely read world document from the content-package current tree. Runtime rejects deletion while currentSituation, a frame slot, a player-view selector, or another document's $ref still points to it, and reports every blocking location. Delete or redirect those references first.",
});

const toolDescriptionsZhCN = (
  tabletop: boolean,
): Record<SettingAuthoringOperation, string> => ({
  list: "列出内容包当前树的 world 根目录或 world/ 子目录；根目录同时列出 opening 和 control 专用文件，每次整份返回。",
  search:
    "在内容包当前树的 world 文档中按原文字面搜索；within 可为 world、world/ 目录或路径或 @ref。",
  read: "按 world/ 路径或 @ref 完整读取世界文档，或按精确路径完整读取 opening/control；既有文档选择值自动投影为 @ref。结果不会截断或分页。",
  create:
    "创建一份 world/ 下的 .yaml 或 .md 文档；提供唯一的小写 ASCII ref、标题、摘要、别名和不含技术头的正文，Runtime 自行完成存储封装。创建成功的文档视为已经完整读取。",
  write_file: `整份替换已完整读取的 world/ .yaml 或 .md 正文并保留身份和元信息，或创建／替换 opening.md、control/frame.yaml、control/player-views.yaml、control/blocks/*.md${tabletop ? "、control/gameplay.json（只能修改跑团判定方案，玩法模式不可改）" : ""}，以及 control/followups.yaml 和其中引用的 prompts/*.md、renderers/*.html、scripts/*.js、regex/*.yaml、assets/* 文本资源。修复损坏世界文档时同时提供 ref、title、summary、aliases，Runtime 会保留仍可恢复的存储身份。新建世界文档使用 setting_create。`,
  patch:
    '细粒度更新已完整读取的 YAML 世界文档，不重写无关内容。locator 是非空路径，每段可以是 map key 或从 0 开始的数组下标；add 新建 map key 或数组位置，replace 更新既有节点，append 追加既有数组，remove 删除既有 map key 或数组项。title、summary 或 aliases 过时时用 op "set_metadata" 整组更新三项。Markdown 正文用 setting_write_file 整份重写。',
  move: "把已完整读取的世界文档移动到新的 world/ .yaml 或 .md 逻辑路径，并保留身份与内容。",
  delete:
    "从内容包当前树永久删除一份已完整读取的 world 文档。若 currentSituation、frame slot、player-view selector 或其他文档的 $ref 仍指向它，Runtime 会拒绝并返回全部精确阻挡位置；请先删除或改向这些引用。",
});

const worldRevisionDescriptionsEn = (
  tabletop: boolean,
): Record<SettingAuthoringOperation, string> => ({
  list: "List the state root or a state/ subdirectory from the world revision worktree. The root also lists control files. Each call returns the whole directory.",
  search:
    "Search literal source text in world documents in the world revision worktree. within may be state, a state/ directory or path, or @ref.",
  read: "Read a complete world document by state/ path or @ref, or read a complete control file by exact path. Existing document selectors are projected to @refs. The result is never truncated or paginated.",
  create:
    "Create one state/ .yaml or .md document. Supply a unique lowercase ASCII ref, title, summary, aliases, and body without a technical header; Runtime completes the storage envelope. The created document is already fully read.",
  write_file: `Replace a completely read state/ .yaml or .md document body while preserving its identity and metadata, or create/replace control/frame.yaml, control/player-views.yaml, ${tabletop ? "control/blocks/*.md, or control/gameplay.json (only a tabletop resolution scheme may change)" : "or control/blocks/*.md"}, plus control/followups.yaml and its referenced prompts/*.md, renderers/*.html, scripts/*.js, regex/*.yaml and assets/* text resources. To repair a damaged world document, also provide ref, title, summary, and aliases; Runtime preserves any recoverable storage identity. Create new world documents with world_revision_create.`,
  patch:
    'Update a completely read YAML world document without rewriting unrelated content. locator is a non-empty path whose segments are map keys or zero-based array indexes. Use add for a missing map key or array index, replace for an existing node, append for the end of an existing array, and remove for an existing map key or array item. When title, summary, or aliases are stale, update all three together with op "set_metadata". Rewrite Markdown bodies with world_revision_write_file.',
  move: "Move a completely read world document to a new state/ .yaml or .md logical path while preserving its identity and contents.",
  delete:
    "Permanently delete a completely read world document from the world revision worktree. Runtime rejects deletion while currentSituation, a frame slot, a player-view selector, or another document's $ref still points to it, and reports every blocking location. Delete or redirect those references first.",
});

const worldRevisionDescriptionsZhCN = (
  tabletop: boolean,
): Record<SettingAuthoringOperation, string> => ({
  list: "列出世界修订工作树的 state 根目录或 state/ 子目录；根目录同时列出 control 文件，每次整份返回。",
  search:
    "在世界修订工作树的 state 文档中按原文字面搜索；within 可为 state、state/ 目录或路径或 @ref。",
  read: "按 state/ 路径或 @ref 完整读取世界文档，或按精确路径完整读取 control 文件；既有文档选择值自动投影为 @ref。结果不会截断或分页。",
  create:
    "创建一份 state/ 下的 .yaml 或 .md 文档；提供唯一的小写 ASCII ref、标题、摘要、别名和不含技术头的正文，Runtime 自行完成存储封装。创建成功的文档视为已经完整读取。",
  write_file: `整份替换已完整读取的 state/ .yaml 或 .md 正文并保留身份和元信息，或创建／替换 control/frame.yaml、control/player-views.yaml、control/blocks/*.md${tabletop ? "、control/gameplay.json（只能修改跑团判定方案，玩法模式不可改）" : ""}，以及 control/followups.yaml 和其中引用的 prompts/*.md、renderers/*.html、scripts/*.js、regex/*.yaml、assets/* 文本资源。修复损坏世界文档时同时提供 ref、title、summary、aliases，Runtime 会保留仍可恢复的存储身份。新建世界文档使用 world_revision_create。`,
  patch:
    '细粒度更新已完整读取的 YAML 世界文档，不重写无关内容。locator 是非空路径，每段可以是 map key 或从 0 开始的数组下标；add 新建 map key 或数组位置，replace 更新既有节点，append 追加既有数组，remove 删除既有 map key 或数组项。title、summary 或 aliases 过时时用 op "set_metadata" 整组更新三项。Markdown 正文用 world_revision_write_file 整份重写。',
  move: "把已完整读取的世界文档移动到新的 state/ .yaml 或 .md 逻辑路径，并保留身份与内容。",
  delete:
    "从世界修订工作树永久删除一份已完整读取的 world 文档。若 currentSituation、frame slot、player-view selector 或其他文档的 $ref 仍指向它，Runtime 会拒绝并返回全部精确阻挡位置；请先删除或改向这些引用。",
});

function worldRevisionUnavailablePath(
  path: string,
  locale: AppLocale,
): string | null {
  if (path === "opening.md")
    return localized(
      locale,
      "opening.md is immutable after a world has been created. Edit state/* or control/* instead.",
      "世界创建后 opening.md 已成为不可变创世叙事。请改写 state/* 或 control/*。",
    );
  if (path === "world" || path.startsWith("world/"))
    return localized(
      locale,
      "World revision exposes only state/* and control/* logical paths; use those instead.",
      "世界修订只公开 state/* 与 control/* 逻辑路径；请改用这两类路径。",
    );
  return null;
}

/** The content package's setting improvement: templates it edits, `world/` paths, and `opening.md`. */
export const contentPackageAuthoringSurface: SettingAuthoringSurface = {
  layout: "content_package",
  root: "world",
  toolPrefix: "setting",
  opening: true,
  phrases: {
    en: {
      tree: "the content package's current tree",
      bareTree: "the content package current tree",
      noun: "the content package",
      slug: "content-package",
      directoryHeading: "Setting directory",
    },
    "zh-CN": {
      tree: "内容包当前树",
      bareTree: "内容包当前树",
      noun: "内容包",
      slug: "content-package",
      directoryHeading: "设定目录",
    },
  },
  descriptions: {
    en: toolDescriptionsEn,
    "zh-CN": toolDescriptionsZhCN,
  },
  unavailablePath: () => null,
};

/** A world revision: the state/control worktree of a world already in play. */
export const worldRevisionAuthoringSurface: SettingAuthoringSurface = {
  layout: "world_revision",
  root: "state",
  toolPrefix: "world_revision",
  opening: false,
  phrases: {
    en: {
      tree: "the world revision worktree",
      bareTree: "the world revision worktree",
      noun: "the world revision worktree",
      slug: "world-revision",
      directoryHeading: "World revision directory",
    },
    "zh-CN": {
      tree: "世界修订工作树",
      bareTree: "世界修订工作树",
      noun: "世界修订工作树",
      slug: "world-revision",
      directoryHeading: "世界修订目录",
    },
  },
  descriptions: {
    en: worldRevisionDescriptionsEn,
    "zh-CN": worldRevisionDescriptionsZhCN,
  },
  unavailablePath: worldRevisionUnavailablePath,
};

function authoringToolName(
  surface: SettingAuthoringSurface,
  operation: SettingAuthoringOperation,
): string {
  return `${surface.toolPrefix}_${operation}`;
}

function authoringOperation(
  surface: SettingAuthoringSurface,
  name: string,
): SettingAuthoringOperation | null {
  return (
    authoringOperations.find(
      (operation) => authoringToolName(surface, operation) === name,
    ) ?? null
  );
}

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
  readonly #surface: SettingAuthoringSurface;
  readonly #preview: (snapshot: WorldDocumentStore) => PromptPreview;
  readonly #validateFiles: (files: readonly ContentTreeFile[]) => void;
  #snapshot: WorldDocumentStore;
  #reads: ReadAuthorizations;
  #review: SettingAuthoringReview;

  constructor(input: {
    baseFiles: readonly ContentTreeFile[];
    locale?: AppLocale;
    surface?: SettingAuthoringSurface;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
    validateFiles?: (files: readonly ContentTreeFile[]) => void;
    authorization?: SettingAuthoringAuthorization | null;
    revision?: string;
  }) {
    this.#baseFiles = cloneFiles(input.baseFiles);
    this.#locale = input.locale ?? defaultAppLocale;
    this.#surface = input.surface ?? contentPackageAuthoringSurface;
    this.#preview = input.preview;
    this.#validateFiles = input.validateFiles ?? (() => undefined);
    this.#snapshot = WorldDocumentStore.open({
      layout: this.#surface.layout,
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
    const normalized = calls.map((call) =>
      normalizeCall(call, this.#surface, this.#locale),
    );
    const results: SettingAuthoringToolResult[] = [];
    const responseBase = this.files();
    let lastSuccessfulWrite = -1;

    for (const call of normalized) {
      if (call.rejection !== undefined) {
        results.push({
          toolCallId: call.id,
          markdown: `# Runtime tool rejected\n\n${call.rejection}`,
          isError: true,
          changes: [],
        });
        continue;
      }
      const before = this.files();
      const unavailable = unavailableArgument(
        this.#surface,
        call.arguments,
        this.#locale,
      );
      if (unavailable !== null) {
        results.push({
          toolCallId: call.id,
          markdown: `# Runtime tool rejected\n\n${unavailable}`,
          isError: true,
          changes: [],
        });
        continue;
      }
      if (call.operation !== null && isReadOperation(call.operation)) {
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
      // The stored review stays cumulative for the whole user request; the
      // model only needs what this tool response changed.
      settled.markdown = `${settled.markdown}\n\n${renderAutomaticReview(
        this.#review,
        fileDiff(responseBase, this.#snapshot.files),
        this.#snapshot,
        this.#surface,
        this.#locale,
      )}`;
    }
    normalized.forEach((call, index) => {
      const notes = [
        ...(call.coerced.length === 0
          ? []
          : [renderCoercionNote(call.coerced, this.#locale)]),
        ...(call.alias === undefined
          ? []
          : [renderToolAliasNote(call.alias, call.name, this.#locale)]),
      ];
      if (notes.length === 0) return;
      const result = results[index]!;
      result.markdown = `${result.markdown}\n\n${notes.join("\n\n")}`;
    });
    return results;
  }

  #executeRead(call: NormalizedCall): QueryResult {
    if (call.operation === "list")
      return listDocuments(
        this.#snapshot,
        call.arguments,
        this.#surface,
        this.#locale,
      );
    if (call.operation === "search")
      return searchDocuments(
        this.#snapshot,
        call.arguments,
        this.#surface,
        this.#locale,
      );
    if (call.operation === "read")
      return readDocument(
        this.#snapshot,
        call.arguments,
        this.#reads,
        this.#surface,
        this.#locale,
      );
    return failure(`Unsupported read tool: ${call.name}`, this.#locale);
  }

  #executeWrite(call: NormalizedCall): QueryResult {
    const snapshot = this.#snapshot;
    const reads = cloneReads(this.#reads);
    try {
      if (isWorldWriteCall(call, this.#surface)) {
        if (call.operation === "delete") {
          const deleted = deleteWorldDocument(
            snapshot,
            call,
            reads,
            this.#surface,
            this.#locale,
          );
          this.#validateFiles(deleted.snapshot.files);
          this.#snapshot = deleted.snapshot;
          this.#reads = reads;
          return success(deleted.markdown);
        }
        const requestedRef =
          call.operation === "create"
            ? requiredSettingRef(call.arguments.ref, this.#locale)
            : null;
        const revised = snapshot.revise({
          commands: [
            worldRevisionCommand(snapshot, call, this.#surface, this.#locale),
          ],
        });
        if (!revised.ok)
          throw new SettingAuthoringError(
            renderRevisionFailure(
              revised.diagnostics,
              this.#surface,
              this.#locale,
            ),
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
      if (call.operation !== "write_file")
        throw new SettingAuthoringError(`Unsupported write tool: ${call.name}`);
      const changed = writeOpaque(
        snapshot,
        call,
        reads,
        this.#surface,
        this.#locale,
      );
      this.#validateFiles(changed.snapshot.files);
      this.#snapshot = changed.snapshot;
      this.#reads = reads;
      return success(changed.markdown);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : `The ${this.#surface.phrases.en.slug} write failed`;
      return failure(message, this.#locale);
    }
  }

  #inspect(): SettingAuthoringReview {
    const inspection = inspectContentPackageCurrentTree(this.#snapshot.files, {
      requireOpening: this.#surface.opening,
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
          message: publicSettingDiagnosticMessage(
            code,
            message,
            this.#surface,
            this.#locale,
          ),
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
          this.#surface,
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
  responseDiff: readonly SettingAuthoringDiff[],
  snapshot: WorldDocumentStore,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  if (review.status === "usable" && review.preview !== null) {
    const changed = responseDiff.length;
    const cumulative = review.diff.length;
    const changedPaths = new Set(responseDiff.map(({ path }) => path));
    const changedShortRefs = new Set(
      listQueryableWorldDocuments(snapshot)
        .filter(({ logicalPath }) => changedPaths.has(logicalPath))
        .map(({ shortRef }) => shortRef),
    );
    return `${localized(
      locale,
      `# Current-tree review passed\n\nContent-tree validation and the real Prompt Preview both passed. This tool response changed ${changed} file(s) in ${surface.phrases.en.noun}${cumulative === changed ? "" : `; ${cumulative} file(s) changed so far in this user request`}. Use this review and the coverage below to decide whether the current user request is satisfied or further edits are needed.`,
      `# 当前树自动检查通过\n\n内容树校验和真实 Prompt Preview 均已通过；本次工具响应修改${surface.phrases["zh-CN"].noun}中的 ${changed} 个文件${cumulative === changed ? "" : `，本次用户请求累计改动 ${cumulative} 个文件`}。请根据本次检查与下方覆盖报告判断当前用户要求是否已经满足，或是否还需修改。`,
    )}\n\n${renderPlayCoverage(
      buildSettingAuthoringPlayCoverage(
        snapshot,
        review.preview,
        responseDiff,
        surface,
      ),
      surface,
      locale,
    )}\n\n${renderWorldMaintenanceReport(
      review.preview.compilation.maintenance,
      changedShortRefs,
      locale,
    )}`;
  }
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
  surface: SettingAuthoringSurface,
): SettingAuthoringPlayCoverage {
  const documents = listQueryableWorldDocuments(snapshot);
  const byShortRef = new Map(
    documents.map((document) => [document.shortRef, document]),
  );
  const { fullInjected, nodeInjected, catalogSummary, injectedSelections } =
    worldMaterialCoverage(preview.compilation.coverage);

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
      return {
        path,
        access,
        detail: playAccessDetail(access, surface),
      };
    }),
  };
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

function playAccessDetail(
  access: SettingAuthoringPlayAccess,
  surface: SettingAuthoringSurface,
): string {
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
    removed: `removed from ${surface.phrases.en.bareTree}`,
  };
  return details[access];
}

function renderPlayCoverage(
  coverage: SettingAuthoringPlayCoverage,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
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
          removed: `已从${surface.phrases["zh-CN"].tree}删除`,
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
          removed: `removed from ${surface.phrases.en.bareTree}`,
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
  /** The surface operation this tool name names, or null for an unknown tool. */
  operation: SettingAuthoringOperation | null;
  arguments: Record<string, unknown>;
  /** Argument paths the model sent as JSON strings and Runtime parsed. */
  coerced: string[];
  /** The name the model sent when Runtime restored it to `name` by alias. */
  alias?: string;
  /** Set when the name matches no tool of this surface; the call is refused. */
  rejection?: string;
}

class SettingAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingAuthoringError";
  }
}

function normalizeCall(
  call: ModelHostToolCall,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): NormalizedCall {
  const cloned = isRecord(call.arguments)
    ? structuredClone(call.arguments)
    : {};
  const definitions = authoringToolDefinitions(
    surface,
    locale,
    fictionGameplay,
  );
  const provided = definitions.map(({ name }) => name);
  const resolved = resolveToolName(call.name, provided);
  if (resolved.kind === "rejected")
    return {
      id: call.id,
      name: call.name,
      operation: null,
      arguments: cloned,
      coerced: [],
      rejection: unknownToolMessage(call.name, provided, locale),
    };
  const name = resolved.name;
  const schema = definitions.find(
    (definition) => definition.name === name,
  )?.inputSchema;
  const repaired =
    schema === undefined
      ? { arguments: cloned, coerced: [] }
      : coerceToolArguments(schema, cloned);
  return {
    id: call.id,
    name,
    operation: authoringOperation(surface, name),
    arguments: repaired.arguments as Record<string, unknown>,
    coerced: repaired.coerced,
    ...(resolved.kind === "alias" ? { alias: resolved.declared } : {}),
  };
}

function unknownToolMessage(
  name: string,
  provided: readonly string[],
  locale: AppLocale,
): string {
  return locale === "zh-CN"
    ? `${name} 不是本界面提供的工具。可用工具：${provided.join(", ")}。`
    : `${name} is not a tool on this surface. Available tools: ${provided.join(", ")}.`;
}

function isReadOperation(operation: SettingAuthoringOperation): boolean {
  return operation === "list" || operation === "search" || operation === "read";
}

/**
 * Rejects a call that names a path outside the surface before any store work.
 * The check covers every path-like argument, so a read and a write fail alike.
 */
function unavailableArgument(
  surface: SettingAuthoringSurface,
  args: Record<string, unknown>,
  locale: AppLocale,
): string | null {
  for (const field of ["path", "directory", "within", "from", "to", "document"])
    if (typeof args[field] === "string") {
      const message = surface.unavailablePath(args[field], locale);
      if (message !== null) return message;
    }
  return null;
}

function isWorldWriteCall(
  call: NormalizedCall,
  surface: SettingAuthoringSurface,
): boolean {
  if (
    call.operation === "create" ||
    call.operation === "patch" ||
    call.operation === "move" ||
    call.operation === "delete"
  )
    return true;
  return (
    call.operation === "write_file" &&
    typeof call.arguments.path === "string" &&
    call.arguments.path.startsWith(`${surface.root}/`)
  );
}

function worldRevisionCommand(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): WorldDocumentRevisionCommand {
  if (call.operation === "create") {
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
        `${authoringToolName(surface, "create")} accepts only path, ref, title, summary, aliases, and body`,
      );
    const logicalPath = safeWorldDocumentPath(
      requiredString(call.arguments.path, "path"),
      surface,
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
  if (call.operation === "write_file") {
    const logicalPath = safeWorldDocumentPath(
      requiredString(call.arguments.path, "path"),
      surface,
      locale,
    );
    const contents = worldWriteContents(
      snapshot,
      logicalPath,
      call.arguments,
      surface,
      locale,
    );
    assertNoLiteralUnicodeEscapes(contents, locale);
    return {
      kind: "write",
      logicalPath,
      contents,
    };
  }
  if (call.operation === "move") {
    const toLogicalPath = safePath(
      requiredString(call.arguments.to, "to"),
      surface,
    );
    if (!documentPathPattern(surface).test(toLogicalPath))
      throw new SettingAuthoringError(
        `${authoringToolName(surface, "move")}.to must be a ${surface.root}/ .yaml or .md path`,
      );
    return {
      kind: "move",
      document: revisionTarget(
        requiredString(call.arguments.from, "from"),
        surface,
      ),
      toLogicalPath,
    };
  }
  if (call.operation === "patch") {
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
          surface,
        ),
        edits: [{ op: "set_metadata", title, summary, aliases }],
      };
    }
    if (op !== "add" && op !== "replace" && op !== "append" && op !== "remove")
      throw new SettingAuthoringError(
        `${authoringToolName(surface, "patch")}.op must be add, replace, append, remove, or set_metadata`,
      );
    const locator = requiredYamlLocatorPath(call.arguments.locator, "locator");
    if (op === "remove") {
      if (!hasOnly(call.arguments, ["document", "op", "locator"]))
        throw new SettingAuthoringError(
          `${authoringToolName(surface, "patch")} remove accepts only document, op, and locator`,
        );
      assertNoLiteralUnicodeEscapes(locator, locale);
      return {
        kind: "patch",
        document: revisionTarget(
          requiredString(call.arguments.document, "document"),
          surface,
        ),
        edits: [{ op: "remove", locator: { yaml: locator } }],
      };
    }
    if (
      !hasOnly(call.arguments, ["document", "op", "locator", "value"]) ||
      !Object.hasOwn(call.arguments, "value")
    )
      throw new SettingAuthoringError(
        `${authoringToolName(surface, "patch")} ${op} requires document, op, locator, and value`,
      );
    const value = structuredClone(
      call.arguments.value,
    ) as WorldDocumentRevisionYamlValue;
    assertNoLiteralUnicodeEscapes({ locator, value }, locale);
    return {
      kind: "patch",
      document: revisionTarget(
        requiredString(call.arguments.document, "document"),
        surface,
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

/** The world-document path pattern for a surface, e.g. `world/…yaml` or `state/…md`. */
function documentPathPattern(surface: SettingAuthoringSurface): RegExp {
  return new RegExp(`^${surface.root}/.+\\.(?:ya?ml|md)$`, "u");
}

function safeWorldDocumentPath(
  path: string,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  const logicalPath = safePath(path, surface);
  if (!documentPathPattern(surface).test(logicalPath))
    throw new SettingAuthoringError(
      localized(
        locale,
        `World files must be .yaml or .md documents below ${surface.root}/`,
        `world 文件必须是 ${surface.root}/ 下的 .yaml 或 .md 文档`,
      ),
    );
  return logicalPath;
}

function worldWriteContents(
  snapshot: WorldDocumentStore,
  logicalPath: string,
  args: Record<string, unknown>,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  if (
    !hasOnly(args, ["path", "contents", "ref", "title", "summary", "aliases"])
  )
    throw new SettingAuthoringError(
      `${authoringToolName(surface, "write_file")} accepts only its declared arguments`,
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
          `Create a new world document with ${authoringToolName(surface, "create")}`,
          `新建世界文档请使用 ${authoringToolName(surface, "create")}`,
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
        `Create a new world document with ${authoringToolName(surface, "create")}`,
        `新建世界文档请使用 ${authoringToolName(surface, "create")}`,
      ),
    );
  if (existingDocument)
    throw new SettingAuthoringError(
      localized(
        locale,
        `Repair metadata is only for a damaged document; update valid metadata with ${authoringToolName(surface, "patch")} set_metadata`,
        `修复元信息只用于损坏文档；有效文档请用 ${authoringToolName(surface, "patch")} set_metadata 更新元信息`,
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

function revisionTarget(
  value: string,
  surface: SettingAuthoringSurface,
): WorldDocumentRevisionTarget {
  const selector = documentSelector(value, surface);
  if (selector === null)
    throw new SettingAuthoringError(
      `Invalid world-document selector: ${value}`,
    );
  return selector;
}

export interface SettingDocumentDeletionBlocker {
  path: string;
  locator: string;
}

function deleteWorldDocument(
  snapshot: WorldDocumentStore,
  call: NormalizedCall,
  reads: ReadAuthorizations,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): { snapshot: WorldDocumentStore; markdown: string } {
  const tool = authoringToolName(surface, "delete");
  if (!hasOnly(call.arguments, ["document"]))
    throw new SettingAuthoringError(
      `${tool} accepts only the document argument`,
    );
  const supplied = requiredString(call.arguments.document, "document");
  const selector = documentSelector(supplied, surface);
  if (selector === null)
    throw new SettingAuthoringError(
      localized(
        locale,
        `${tool}.document must be an @ref or ${surface.root}/ document path`,
        `${tool}.document 必须是 @ref 或 ${surface.root}/ 文档路径`,
      ),
    );
  const resolved = snapshot.query({
    kind: "read_document",
    document: selector,
  });
  if (resolved.kind === "error")
    throw new SettingAuthoringError(
      renderRevisionFailure(resolved.diagnostics, surface, locale),
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
    layout: surface.layout,
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

export function settingDocumentDeletionBlockers(
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
    recordIfTarget(
      ["maintenance", "clock", "document"],
      "maintenance.clock.document",
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
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): { snapshot: WorldDocumentStore; markdown: string } {
  if (!hasOnly(call.arguments, ["path", "contents"]))
    throw new SettingAuthoringError(
      "Special-file writes accept only path and contents",
    );
  const path = safePath(requiredString(call.arguments.path, "path"), surface);
  if (!writableOpaquePath(path, surface))
    throw new SettingAuthoringError(
      surface.opening
        ? localized(
            locale,
            "Special-file writes accept only opening.md, control/frame.yaml, control/player-views.yaml, control/blocks/*.md, or control/gameplay.json",
            "专用文件只允许写入 opening.md、control/frame.yaml、control/player-views.yaml、control/blocks/*.md 或 control/gameplay.json",
          )
        : localized(
            locale,
            "Special-file writes accept only control/frame.yaml, control/player-views.yaml, control/blocks/*.md, or control/gameplay.json",
            "专用文件只允许写入 control/frame.yaml、control/player-views.yaml、control/blocks/*.md 或 control/gameplay.json",
          ),
    );
  const authoredContents = requiredString(call.arguments.contents, "contents");
  assertNoLiteralUnicodeEscapes(authoredContents, locale);
  const contents = projectOpaqueDocumentIds(snapshot, path, authoredContents);
  if (path === gameplayPath)
    assertGameplayWriteKeepsMode(snapshot.files, contents, locale);
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
    layout: surface.layout,
    files: sortFiles(next),
  });
  rebaseReads(reads, revised);
  reads.opaquePaths.add(path);
  const gameplay =
    path === gameplayPath ? readGameplay([{ path, contents }]) : null;
  return {
    snapshot: revised,
    markdown: [
      localized(
        locale,
        `# Current-tree write accepted\n\n${existing === undefined ? "Created" : "Updated"} ${path} in ${surface.phrases.en.tree}. This file is already fully read; do not read it again unless a later decision needs Runtime's exact serialization.`,
        `# 当前树写入已接受\n\n已在${surface.phrases["zh-CN"].tree}中${existing === undefined ? "创建" : "更新"} ${path}。该文件已视为完整读取；除非后续判断依赖 Runtime 的精确序列化结果，否则不要再次读取。`,
      ),
      ...(gameplay === null
        ? []
        : [
            localized(
              locale,
              `Current gameplay: ${gameplayLabel(gameplay, locale)}.`,
              `当前玩法：${gameplayLabel(gameplay, locale)}。`,
            ),
            // Mid-conversation the model learns the new scheme's rules here (ADR-0037 append-only).
            ...(gameplay.mode === "tabletop"
              ? [tabletopSchemeReceipt(gameplay, locale)]
              : []),
          ]),
    ].join("\n\n"),
  };
}

/** The gameplay mode is fixed; a write may only keep it or change a tabletop scheme. */
function assertGameplayWriteKeepsMode(
  files: readonly ContentTreeFile[],
  contents: string,
  locale: AppLocale,
): void {
  const before = readGameplay(files);
  const after = readGameplay([{ path: gameplayPath, contents }]);
  if (before.mode !== after.mode)
    throw new SettingAuthoringError(
      localized(
        locale,
        "Gameplay mode is fixed; control/gameplay.json may change only the resolution scheme of a tabletop package",
        "玩法模式固定；control/gameplay.json 只能修改跑团的判定方案，不能在互动式小说与跑团之间切换",
      ),
    );
}

function writableOpaquePath(
  path: string,
  surface: SettingAuthoringSurface,
): boolean {
  return (
    isPackageFollowupControlPath(path) ||
    (surface.opening && path === "opening.md") ||
    path === "control/frame.yaml" ||
    path === "control/player-views.yaml" ||
    path === gameplayPath ||
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
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  return diagnostics
    .map(
      ({ code, logicalPath, message }) =>
        `${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${publicSettingDiagnosticMessage(code, message, surface, locale)}`,
    )
    .join("\n");
}

function listDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): QueryResult {
  const tool = authoringToolName(surface, "list");
  const root = surface.root;
  // Frozen sessions may still send obsolete limit/cursor; directories are
  // always listed in full, so those keys are accepted and ignored.
  if (!hasOnly(args, ["directory", "limit", "cursor"]))
    return failure(`${tool} accepts only directory`, locale);
  const directory = args.directory ?? root;
  if (
    typeof directory !== "string" ||
    (directory !== root && !directory.startsWith(`${root}/`))
  )
    return failure(`Invalid ${tool} directory`, locale);
  const relative = directory === root ? "" : directory.slice(root.length + 1);
  const entries: string[] = [];
  let cursor: string | null = null;
  do {
    const result = snapshot.query({
      kind: "catalog",
      directory: relative,
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    });
    if (result.kind === "error")
      return renderQueryFailure(result, surface, locale);
    if (result.kind !== "catalog") throw new Error("Unexpected catalog result");
    entries.push(...result.entries.map(catalogEntryLine));
    cursor = result.page.nextCursor;
  } while (cursor !== null);
  if (relative === "")
    entries.unshift(
      ...snapshot.files
        .filter(({ path }) => !path.startsWith(`${root}/`))
        .map(({ path, encoding }) =>
          encoding === undefined ? `- [special] ${path}` : `- [binary] ${path}`,
        ),
    );
  return success(
    `# ${localized(locale, surface.phrases.en.directoryHeading, surface.phrases["zh-CN"].directoryHeading)}\n\n${entries.join("\n") || localized(locale, "(empty)", "（空）")}\n\nComplete: yes`,
  );
}

function catalogEntryLine(
  entry: WorldDocumentCatalogResult["entries"][number],
): string {
  if (entry.kind === "directory") return `- [dir] ${entry.logicalPath}/`;
  if (entry.document === undefined)
    return `- [damaged] ${entry.logicalPath} · ${entry.diagnostics.map(({ code }) => code).join(", ")}`;
  return `- @${entry.document.shortRef} · ${entry.document.title} · ${entry.logicalPath}`;
}

function searchDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): QueryResult {
  const tool = authoringToolName(surface, "search");
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
    return failure(`Invalid ${tool} arguments`, locale);
  const within = searchScope(args.within, surface);
  if (within === invalidScope)
    return failure(`Invalid ${tool} within scope`, locale);
  const result = snapshot.query({
    kind: "literal_search",
    query,
    caseSensitive: args.caseSensitive === true,
    ...(within === undefined ? {} : { within }),
    limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error")
    return renderQueryFailure(result, surface, locale);
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
  surface: SettingAuthoringSurface,
):
  | undefined
  | { directory: string }
  | { document: WorldDocumentSelector }
  | typeof invalidScope {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) return invalidScope;
  if (value === surface.root) return { directory: "" };
  if (value.startsWith("@"))
    return value.length > 1
      ? { document: { shortRef: value.slice(1) } }
      : invalidScope;
  if (value.startsWith(`${surface.root}/`)) {
    const path = safePath(value, surface);
    return /\.(?:ya?ml|md)$/u.test(path)
      ? { document: { logicalPath: path } }
      : { directory: path.slice(surface.root.length + 1) };
  }
  return invalidScope;
}

function readDocument(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  reads: ReadAuthorizations,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): QueryResult {
  const path = args.path;
  if (
    !hasOnly(args, ["path", "maxBytes", "cursor"]) ||
    typeof path !== "string" ||
    path.length === 0
  )
    return failure(
      `Invalid ${authoringToolName(surface, "read")} arguments`,
      locale,
    );
  const opaque = snapshot.files.find(
    (file) => file.path === path && !file.path.startsWith(`${surface.root}/`),
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
  const selector = documentSelector(path, surface);
  if (selector === null)
    return failure(
      selector === null && typeof path === "string" && !path.includes("/")
        ? `Use @ref or a ${surface.root}/ logical path`
        : `Invalid ${authoringToolName(surface, "read")} path`,
      locale,
    );
  const result = snapshot.query({
    kind: "read_document",
    document: selector,
    referenceProjection: "short_ref",
  });
  if (result.kind === "error") {
    if (repairableDamagedWorldRead(snapshot, path, surface, result))
      reads.damagedWorldPaths.add(path);
    return renderQueryFailure(result, surface, locale);
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
  surface: SettingAuthoringSurface,
  result: WorldDocumentQueryFailure,
): boolean {
  if (
    !path.startsWith(`${surface.root}/`) ||
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

function documentSelector(
  value: string,
  surface: SettingAuthoringSurface,
): WorldDocumentSelector | null {
  if (value.startsWith("@"))
    return value.length > 1 ? { shortRef: value.slice(1) } : null;
  if (value.startsWith(`${surface.root}/`)) {
    const path = safePath(value, surface);
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
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): QueryResult {
  return failure(
    result.diagnostics
      .map(
        ({ code, logicalPath, message }) =>
          `${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${publicSettingDiagnosticMessage(code, message, surface, locale)}`,
      )
      .join("\n"),
    locale,
  );
}

function publicSettingDiagnosticMessage(
  code: string,
  message: string,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  const writeFile = authoringToolName(surface, "write_file");
  if (
    code === "document_header_invalid" ||
    code === "document_identity_invalid" ||
    code === "invalid_document_header"
  )
    return localized(
      locale,
      `Document storage metadata is missing or damaged. Repair this document with ${writeFile} using its ref, title, summary, aliases, and body`,
      `文档存储元信息缺失或损坏；请用 ${writeFile} 提供 ref、title、summary、aliases 和正文进行修复`,
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
      `Document ref must be a 2-to-32-character lowercase ASCII short handle; repair it with ${writeFile} and public metadata`,
      `文档 ref 必须是 2～32 位小写 ASCII 短句柄；请用 ${writeFile} 和公开元信息修复`,
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

function safePath(path: string, surface: SettingAuthoringSurface): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "." || part === ".." || part.length === 0)
  )
    throw new SettingAuthoringError(
      `Unsafe ${surface.phrases.en.slug} path: ${path}`,
    );
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
  if (typeof value === "string")
    throw new SettingAuthoringError(
      "aliases must be a JSON array of at most 16 strings, not a string",
    );
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
  if (typeof value === "string")
    throw new SettingAuthoringError(
      `${name} must be a JSON array of map keys or zero-based array indexes, not a string`,
    );
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

/** A bootstrap section derived from the current tree; the sources name each part. */
export interface AuthoringPreloadBlock {
  source: string;
  markdown: string;
}

export interface AuthoringPreloadInput {
  snapshot: WorldDocumentStore;
  surface: SettingAuthoringSurface;
  locale: AppLocale;
  /** Fingerprint of the tree the preload was taken from. */
  revision: string;
  /** Source prefix, e.g. `world-revision:preload`. */
  sourcePrefix: string;
  /** Documents the play preview injects whole or by node, with the slot that selected them. */
  injected: readonly { shortRef: string; slot: string }[];
  /** Why the injected set is unknown, when the play preview could not be built. */
  injectedUnavailable?: string;
}

export interface AuthoringPreload {
  blocks: AuthoringPreloadBlock[];
  record: AuthoringPreloadRecord;
}

/**
 * Builds the complete-read preload for one bootstrap. Every document body goes
 * through the same read path the model's read tool uses, so the text matches it
 * byte for byte and the read authority is exactly what that path would grant.
 */
export function buildAuthoringPreload(
  input: AuthoringPreloadInput,
): AuthoringPreload {
  const { snapshot, surface, locale, sourcePrefix } = input;
  const reads: ReadAuthorizations = {
    snapshotId: snapshot.id,
    worldDocumentIds: new Set(),
    damagedWorldPaths: new Set(),
    opaquePaths: new Set(),
  };
  const blocks: AuthoringPreloadBlock[] = [
    {
      source: `${sourcePrefix}/directory`,
      markdown: preloadDirectory(snapshot, surface, locale),
    },
  ];
  const controlPaths = snapshot.files
    .map(({ path }) => path)
    .filter(isPreloadControlPath)
    .sort(
      (left, right) =>
        controlRank(left) - controlRank(right) || left.localeCompare(right),
    );
  for (const path of controlPaths) {
    const result = readDocument(snapshot, { path }, reads, surface, locale);
    if (result.ok)
      blocks.push({
        source: `${sourcePrefix}/${path}`,
        markdown: result.markdown,
      });
  }
  const seen = new Set<string>();
  for (const { shortRef, slot } of input.injected) {
    if (seen.has(shortRef)) continue;
    seen.add(shortRef);
    const document = snapshot.query({
      kind: "read_document",
      document: { shortRef },
      referenceProjection: "short_ref",
    });
    if (document.kind !== "read_document") continue;
    const result = readDocument(
      snapshot,
      { path: `@${shortRef}` },
      reads,
      surface,
      locale,
    );
    if (!result.ok) continue;
    blocks.push({
      source: `${sourcePrefix}/${document.document.logicalPath}`,
      markdown: `${localized(locale, `Injected by slot ${slot}`, `由槽位 ${slot} 注入`)}\n\n${result.markdown}`,
    });
  }
  if (input.injectedUnavailable !== undefined)
    blocks.push({
      source: `${sourcePrefix}/injected-unavailable`,
      markdown: localized(
        locale,
        `# Injected documents unavailable\n\nThe play preview could not be built (${input.injectedUnavailable}), so documents injected by the world frame are not preloaded. Read them before writing.`,
        `# 注入文档不可用\n\n游玩预览无法生成（${input.injectedUnavailable}），因此未预载世界框架注入的文档。写入前请先读取它们。`,
      ),
    });
  blocks.push({
    source: `${sourcePrefix}/runtime`,
    markdown: localized(
      locale,
      `# Runtime preload note\n\nThe documents above are a snapshot of the worktree at revision ${input.revision}, taken when this request was sent. Preloaded documents count as completely read at this revision and may be changed directly. The directory only helps discovery and grants no read authority. Read any other document with a tool before changing it. After any write, re-read as the existing rules require.`,
      `# Runtime 预载说明\n\n以上内容是本次请求发出时工作树 revision ${input.revision} 的快照。其中的预载文档视为已在该 revision 完整读取，可直接修改。目录只用于发现，不授予读取资格。其余文档修改前仍需用工具读取；任何写入后按既有规则重新读取。`,
    ),
  });
  return {
    blocks,
    record: {
      revision: input.revision,
      worldDocumentIds: [...reads.worldDocumentIds].sort(),
      opaquePaths: [...reads.opaquePaths].sort(),
    },
  };
}

/** Merges a preload's read authority into the authorization of the same revision. */
export function authoringPreloadAuthorization(
  current: SettingAuthoringAuthorization | null,
  preload: AuthoringPreloadRecord,
): SettingAuthoringAuthorization {
  const same = current?.revision === preload.revision;
  return {
    revision: preload.revision,
    readWorldDocumentIds: sortedUnion(
      same ? current.readWorldDocumentIds : [],
      preload.worldDocumentIds,
    ),
    readableDamagedWorldPaths: same
      ? [...current.readableDamagedWorldPaths]
      : [],
    readOpaquePaths: sortedUnion(
      same ? current.readOpaquePaths : [],
      preload.opaquePaths,
    ),
  };
}

function sortedUnion(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])].sort();
}

const preloadControlFiles = [
  "control/frame.yaml",
  "control/player-views.yaml",
  "control/gameplay.json",
  "control/followups.yaml",
];

function isPreloadControlPath(path: string): boolean {
  return (
    preloadControlFiles.includes(path) ||
    /^control\/blocks\/[^/]+\.md$/u.test(path)
  );
}

function controlRank(path: string): number {
  const index = preloadControlFiles.indexOf(path);
  return index === -1 ? preloadControlFiles.length : index;
}

function preloadDirectory(
  snapshot: WorldDocumentStore,
  surface: SettingAuthoringSurface,
  locale: AppLocale,
): string {
  const entries = snapshot.files
    .filter(({ path }) => !path.startsWith(`${surface.root}/`))
    .map(({ path, encoding }) =>
      encoding === undefined ? `- [special] ${path}` : `- [binary] ${path}`,
    );
  let cursor: string | null = null;
  do {
    const result = snapshot.query({
      kind: "catalog",
      directory: "",
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    });
    if (result.kind === "error")
      throw new Error("The authoring directory could not be listed");
    if (result.kind !== "catalog") throw new Error("Unexpected catalog result");
    entries.push(...result.entries.map(catalogEntryLine));
    cursor = result.page.nextCursor;
  } while (cursor !== null);
  return `# ${localized(locale, surface.phrases.en.directoryHeading, surface.phrases["zh-CN"].directoryHeading)}\n\n${entries.join("\n") || localized(locale, "(empty)", "（空）")}\n\nComplete: yes`;
}
