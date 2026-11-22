import type { ModelProviderKind } from "../../protocol/modelConnections.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";
import type { Gameplay } from "../../protocol/gameplay.ts";
import {
  resolutionCheckToolForScheme,
  resolutionToolDefinition,
  resolutionToolNames,
  type ResolutionToolName,
} from "../play/TabletopResolution.ts";

/**
 * Runtime-owned prompt tool registry.
 *
 * The file-native play codec only stores names from this registry. Provider
 * schemas and descriptions stay here so authors cannot fork the executable
 * tool contract.
 */

/**
 * Tools that every current play and authoring surface may expose. Resolution
 * tools are registered below but never enter a surface until a per-world
 * selection (Phase 2) includes them.
 *
 * No declared name may end in `_<another declared name>`: a provider-mangled
 * `mcp__<server>__<word>_<name>` is restored by that suffix (see
 * ToolNameAlias.ts), so such a pair would make the restoration ambiguous.
 * tests/runtime/tool-name-alias.test.ts enforces this across all surfaces.
 */
export const baseRuntimeToolNames = [
  "state_list",
  "history_list",
  "history_search",
  "history_read",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
  "world_retire",
  "world_checkpoint",
  "artifact_emit",
  "artifact_clear",
] as const;

/** The full executable Runtime vocabulary. Exposure is chosen per surface. */
export const registeredRuntimeToolNames = [
  ...baseRuntimeToolNames,
  ...resolutionToolNames,
] as const;

/**
 * The tool surface of one world or package, derived only from its gameplay.
 * Interactive fiction keeps the base surface exactly; tabletop adds the
 * scheme's check plus auxiliary dice and arithmetic.
 */
export function runtimeToolNamesForGameplay(
  gameplay: Gameplay,
): RegisteredRuntimeToolName[] {
  if (gameplay.mode !== "tabletop") return [...baseRuntimeToolNames];
  return [
    ...baseRuntimeToolNames,
    resolutionCheckToolForScheme(gameplay.scheme),
    "roll_dice",
    "calculate",
  ];
}

/** Changes only when the executable Runtime tool universe or schemas change. */
export const runtimeToolRegistryRevision = "runtime-tools-v10";

export type RegisteredRuntimeToolName =
  (typeof registeredRuntimeToolNames)[number];

type BaseRuntimeToolName = (typeof baseRuntimeToolNames)[number];

export interface RuntimePromptTool {
  name: RegisteredRuntimeToolName;
  description: string;
  inputSchema: object;
}

/**
 * How an adapter exposes the frozen Runtime definitions to a provider.
 *
 * `native_allowed_subset` keeps the full definition array stable and asks a
 * provider-native capability to restrict callable names. `runtime_gate`
 * keeps the full array stable and lets Runtime reject calls after the response.
 */
export type RuntimeToolDefinitionStrategy =
  "native_allowed_subset" | "runtime_gate";

export function defaultRuntimeToolDefinitionStrategy(
  provider: ModelProviderKind,
): RuntimeToolDefinitionStrategy {
  return provider === "openai_responses"
    ? "native_allowed_subset"
    : "runtime_gate";
}

/** Canonical Runtime-owned order for a set of registered names. */
export function canonicalRuntimeToolNames(
  names: readonly RegisteredRuntimeToolName[],
): RegisteredRuntimeToolName[] {
  const set = new Set(names);
  return registeredRuntimeToolNames.filter((name) => set.has(name));
}

export function isRegisteredRuntimeToolName(
  value: string,
): value is RegisteredRuntimeToolName {
  return (registeredRuntimeToolNames as readonly string[]).includes(value);
}

/** Expand author names to the one Runtime schema/description registry. */
export function runtimeToolsForNames(
  names: readonly RegisteredRuntimeToolName[],
  locale: AppLocale = defaultAppLocale,
): RuntimePromptTool[] {
  const toolDefinitions = createToolDefinitions(locale);
  return names.map((name) => ({
    name,
    description: toolDefinitions[name].description,
    inputSchema: toolDefinitions[name].inputSchema,
  }));
}

/**
 * The original Runtime input schema of a registered tool. Argument repair reads
 * this, not the portable wire projection, so every array or object position is
 * exactly what Runtime validates.
 */
export function runtimeToolInputSchema(
  name: string,
  locale: AppLocale = defaultAppLocale,
): object | null {
  if (!isRegisteredRuntimeToolName(name)) return null;
  return createToolDefinitions(locale)[name].inputSchema;
}

/**
 * Return a Provider-portable root-object schema for a Runtime-owned tool.
 *
 * Released call-chain contexts keep their exact logical tool definitions. The
 * legacy context_list branch therefore lives here as a wire-only compatibility
 * projection: adapters may repair its old root union without adding it back to
 * the tool universe exposed to new sessions.
 */
export function portableRuntimeToolInputSchema(name: string): object | null {
  if (name === "context_list") return legacyContextListInputSchema();
  if (!isRegisteredRuntimeToolName(name)) return null;
  return structuredClone(
    createToolDefinitions(defaultAppLocale)[name].inputSchema,
  );
}

function objectSchema(
  properties: Record<string, object>,
  required: string[],
): object {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function legacyContextListInputSchema(): object {
  return objectSchema(
    {
      source: { enum: ["state", "history"] },
      parent: { type: "string", minLength: 1 },
      order: { enum: ["newest_first", "oldest_first"] },
      cursor: { type: ["string", "null"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    ["source"],
  );
}

function createToolDefinitions(
  locale: AppLocale,
): Record<
  RegisteredRuntimeToolName,
  { description: string; inputSchema: object }
> {
  const descriptions = toolDescriptions[locale];
  const object = objectSchema;
  const string = { type: "string", minLength: 1 };
  const yamlLocator = object(
    {
      yaml: {
        type: "array",
        items: { type: ["string", "integer"] },
      },
    },
    ["yaml"],
  );
  const markdownLocator = object(
    { markdown: { type: "array", items: { type: "string" }, minItems: 1 } },
    ["markdown"],
  );
  // add_section takes [] to add a new top-level section at the end of the body.
  const markdownParentLocator = object(
    { markdown: { type: "array", items: { type: "string" } } },
    ["markdown"],
  );
  const definitions: Record<
    RegisteredRuntimeToolName,
    { description: string; inputSchema: object }
  > = {
    ...resolutionDefinitions(locale),
    state_list: {
      description: descriptions.state_list,
      inputSchema: object({ parent: string }, ["parent"]),
    },
    history_list: {
      description: descriptions.history_list,
      inputSchema: object(
        {
          before: string,
          after: string,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: string,
        },
        [],
      ),
    },
    history_search: {
      description: descriptions.history_search,
      inputSchema: object(
        {
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string", minLength: 1, maxLength: 256 },
          },
          match: { enum: ["any", "all"] },
          order: { enum: ["newest_first", "oldest_first"] },
          caseSensitive: { type: "boolean" },
          after: string,
          before: string,
          limit: { type: "integer", minimum: 1, maximum: 50 },
          cursor: string,
        },
        [],
      ),
    },
    history_read: {
      description: descriptions.history_read,
      inputSchema: object(
        {
          latest: { type: "integer", minimum: 1, maximum: 21 },
          ref: string,
          before: { type: "integer", minimum: 0, maximum: 20 },
          after: { type: "integer", minimum: 0, maximum: 20 },
        },
        [],
      ),
    },
    context_search: {
      description: descriptions.context_search,
      inputSchema: object(
        {
          source: { const: "state" },
          query: { type: "string", minLength: 1, maxLength: 256 },
          caseSensitive: { type: "boolean" },
          within: string,
          limit: { type: "integer", minimum: 1, maximum: 50 },
          cursor: { type: ["string", "null"] },
        },
        ["source", "query"],
      ),
    },
    context_read: {
      description: descriptions.context_read,
      inputSchema: object({ ref: string }, ["ref"]),
    },
    world_patch: {
      description: descriptions.world_patch,
      inputSchema: object(
        {
          target: string,
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              oneOf: [
                object(
                  {
                    op: { enum: ["add", "replace", "append"] },
                    locator: yamlLocator,
                    value: {},
                  },
                  ["op", "locator", "value"],
                ),
                object({ op: { const: "remove" }, locator: yamlLocator }, [
                  "op",
                  "locator",
                ]),
                object(
                  {
                    op: { const: "replace_section" },
                    locator: markdownLocator,
                    markdown: { type: "string" },
                  },
                  ["op", "locator", "markdown"],
                ),
                object(
                  {
                    op: { const: "add_section" },
                    locator: markdownParentLocator,
                    markdown: { type: "string" },
                  },
                  ["op", "locator", "markdown"],
                ),
                object(
                  {
                    op: { const: "rename_section" },
                    locator: markdownLocator,
                    title: string,
                  },
                  ["op", "locator", "title"],
                ),
                object(
                  { op: { const: "remove_section" }, locator: markdownLocator },
                  ["op", "locator"],
                ),
                {
                  ...object(
                    {
                      op: { const: "set_metadata" },
                      title: string,
                      summary: string,
                      aliases: { type: "array", items: { type: "string" } },
                    },
                    ["op"],
                  ),
                  minProperties: 2,
                },
                object(
                  {
                    op: { enum: ["replace_body", "replace_preamble"] },
                    markdown: { type: "string" },
                  },
                  ["op", "markdown"],
                ),
              ],
            },
          },
        },
        ["target", "edits"],
      ),
    },
    world_create: {
      description: descriptions.world_create,
      inputSchema: object(
        {
          parent: string,
          codec: { enum: ["yaml", "markdown"] },
          refHint: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 240 },
          aliases: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          body: { type: "string" },
        },
        ["parent", "codec", "refHint", "title", "summary", "aliases", "body"],
      ),
    },
    world_retire: {
      description: descriptions.world_retire,
      inputSchema: object(
        {
          target: string,
          retired: { type: "boolean" },
        },
        ["target", "retired"],
      ),
    },
    artifact_emit: {
      description: descriptions.artifact_emit,
      inputSchema: object(
        {
          output: { type: "string", minLength: 1, maxLength: 128 },
          payload: {},
        },
        ["output", "payload"],
      ),
    },
    world_checkpoint: {
      description: descriptions.world_checkpoint,
      inputSchema: object({}, []),
    },
    artifact_clear: {
      description: descriptions.artifact_clear,
      inputSchema: object(
        { output: { type: "string", minLength: 1, maxLength: 128 } },
        ["output"],
      ),
    },
  };
  return definitions;
}

function resolutionDefinitions(
  locale: AppLocale,
): Record<ResolutionToolName, { description: string; inputSchema: object }> {
  return Object.fromEntries(
    resolutionToolNames.map((name) => {
      const { description, inputSchema } = resolutionToolDefinition(
        name,
        locale,
      );
      return [name, { description, inputSchema }];
    }),
  ) as Record<ResolutionToolName, { description: string; inputSchema: object }>;
}

const toolDescriptions: Record<
  AppLocale,
  Record<BaseRuntimeToolName, string>
> = {
  en: {
    world_checkpoint:
      "Register an event gap and suggest starting a fresh context here (empty object {}). Settlement and replay scope follow tools-and-settlement rules; timing follows checkpoint policy. Consolidation does not need this tool; never advance the story just to register.",
    state_list:
      "List Runtime-known state directory and document handles. Use @dir-/ for the root or an @dir-* from the initial index or state_list (no need to re-list known handles). Empty catalog directories declared by the frozen frame stay usable. Returns the whole directory (Complete: yes); pass document handles to context_read. Never lists committed history.",
    history_list:
      "Browse committed timeline history (opening included). Omit anchors for the latest page; before/after are mutually exclusive and exclude the anchor (injected refs work directly). Pages are oldest to newest in Authority acceptance order, not story dates; positions are not identities or turns. Previews show only 120 code points; read full originals with history_read. Historical background reflects capture-time state only, not current world state, and neither certifies facts nor grants character knowledge (interpret memories, dreams and local times with originals). Continue with {cursor} alone (earlierCursor/laterCursor are independent); rerun after history_changed.",
    history_search:
      "Search committed timeline originals literally using nonempty queries (no query alias or semantic filters; match defaults to any, all applies within one message). NFKC-normalized and case-insensitive by default (duplicates collapse). Zero matches do not prove an event never happened. after/before exclude timeline bounds regardless of order (after must precede before). Returns up to 3 excerpts, match counts and full length; read context with history_read. Continue with {cursor} alone; rerun after history_changed.",
    history_read:
      "Read complete committed timeline originals without summaries, truncation or body pagination. {latest:N} (1–21) and {ref,before,after} (defaults 0, before+after<=20) are mutually exclusive; refs from injections or tools work directly. Windows are oldest to newest including the anchor; earlier/later sit just outside and can anchor the next read without overlap. Boundaries and empty history are normal. Counts are messages, not turns; large windows can be big.",
    context_search:
      "Search literal text in state documents (source=state; use history_search for history). Zero matches do not prove a fact is absent; never recount searches in player-visible prose. within accepts only Runtime-returned @document or @dir-* handles.",
    context_read:
      "Read the full content of a Runtime-returned @document or @node handle without truncation or pagination. Receipt headings, boundaries, scope and completion markers are not source text; YAML bodies omit $document and Markdown bodies start at the # heading. Never pass file paths, natural-language names, or invented world/... values.",
    world_patch: `Update a document read precisely or injected completely with write authorization (target must be an @short-ref; never use path, JSON Pointer, set, or a filename).
- Metadata: use set_metadata for stale title, summary, or aliases with only changed fields (at least one); omitted fields are preserved.
- YAML: locator:{yaml:[...]} addresses map keys or zero-based array indexes. add/replace are upserts (creating missing parent maps; index at/past end appends); append adds to an existing sequence's end; remove deletes an exact target (missing target is a no-op reported in receipt). Reference a whole document only as {$ref:"@short-ref"} from a Runtime result (never invent document ids); otherwise use plain text or world_create first.
- Markdown: locators exclude the # title. replace_section must start with the matching heading level/name and adds it if absent; add_section adds a child under locator, or a top-level section at the end via {"op":"add_section","locator":{"markdown":[]},"markdown":"## Clues\\nSilver key"}; replace_preamble edits between # and the first ##; replace_body replaces the body while keeping the original # heading.
- Validation & settlement: batch-validated first (authorization and basic shape; any failure rejects the whole batch with zero writes), then each edit settles independently (failed edits skip while others apply; resend only listed failures). Body is not echoed; re-read with context_read only if later decisions need exact serialized body or metadata.`,
    world_create:
      'Create a document in a Runtime-known state directory. parent must be an @dir-* from the initial index or state_list (@dir-/ for root; empty frozen-frame catalog directories stay usable; unknown directories are rejected). refHint is a suggested lowercase ASCII short-reference hint (not a world/ path); use the @short-ref returned by Runtime. Reference whole documents in YAML only as {$ref:"@short-ref"} from a Runtime result (never invent document ids).',
    world_retire:
      "Retire or restore an authorized state document (target is an @short-ref). retired:true removes it from future frame catalog injection while keeping it listed, searchable, readable, referenceable and restorable; retired:false restores it. Does not affect explicit full-document slots; use world_patch for ordinary edits.",
    artifact_emit:
      "Submit an artifact declared in advance for this follow-up request. Supply only the output name and payload; Runtime fixes the channel, key, content type, renderer, retention policy, and authority meaning in the contract.",
    artifact_clear:
      "Clear the projection of an artifact that this follow-up declared in advance and explicitly allows to be cleared. The call cannot choose a channel, key, or any other output contract.",
  },
  "zh-CN": {
    world_checkpoint:
      "登记事件间隙并向玩家建议从此开启全新上下文（参数为空对象 {}）。生效边界见“工具与响应结算”，登记时机见检查点政策。整理归并无需调用，勿为登记推进剧情。",
    state_list:
      "列出 Runtime 已知的状态目录与文档句柄。根目录用 @dir-/，下级用初始目录索引或 state_list 返回的 @dir-*（已有句柄无需再列）。冻结 frame 声明的空 catalog 目录仍可用。每次整份返回（Complete: yes），文档句柄交给 context_read；不列出已提交历史。",
    history_list:
      "浏览当前时间线已提交历史（含开场白）。无锚点取最新页；before 或 after 互斥，取紧邻前／后页且不含锚点（注入中的 ref 可直接使用）。页内按 Authority 接受顺序由旧到新，不代表故事日期；位置非身份或回合数。预览仅前 120 码点，完整原文用 history_read。历史背景仅说明采集时刻状态，不是当前世界状态，不认证事实或授予角色知识（回忆、梦境或局部时间须结合原文解释）。续页只传 {cursor}（earlierCursor/laterCursor 独立翻页）；history_changed 须重新查询。",
    history_search:
      "字面搜索当前时间线已提交原文（queries 为非空字面词，不接受 query 别名或语义筛选；match 默认 any，all 限于同一消息）。始终 NFKC 规范化且默认不区分大小写（重复词合并）。零命中不证明事件未发生。after/before 按时间线先后排除边界且 after 须早于 before。每项返回最多 3 个片段、命中数与原文长度，前后文用 history_read。续页只传 {cursor}；history_changed 须重新查询。",
    history_read:
      "完整读取当前时间线已提交原文，无摘要、无截断、无正文分页。{latest:N}（1–21）与 {ref,before,after}（before/after 默认 0 且合计<=20）两模式互斥，注入或工具返回的 ref 可直接使用。窗口由旧到新且含锚点；earlier/later 为紧邻窗口外句柄，可作下一次 ref 避免重读；边界与空历史正常。计数单位为消息而非回合，大窗口输出可能很大。",
    context_search:
      "在状态文档原文字面搜索（source 固定为 state；历史用 history_search）。0 命中不证明事实不存在；玩家可见叙事不得复述搜索过程。within 只接受 Runtime 返回的 @文档或 @dir-* 句柄。",
    context_read:
      "完整读取 Runtime 返回的 @文档或 @节点句柄，无截断无分页。回执中的读取标题、边界、范围与完成标记不是源文；YAML 正文不含 $document 头，Markdown 正文从 # 标题开始。勿传文件路径、自然语言名或编造的 world/...。",
    world_patch: `更新已精确读取或已随写入资格完整注入的文档（target 须为 @短引用；勿用 path、JSON Pointer、set 或文件名）。
- 元数据：title/summary/aliases 过时时用 set_metadata，仅传变更字段（至少一项），未传字段保留。
- YAML：locator:{yaml:[...]} 用 map key 或 0 起数组下标；add/replace 均为 upsert（自动建缺失父 map，下标越界追加）；append 追加到既有 sequence 末尾；remove 删精确位置，目标不存在为 no-op（回执注明）。整文档引用只能写 {$ref:"@短引用"}（须来自 Runtime 返回，禁造文档 id）；无句柄时写普通文本或先 world_create。
- Markdown：locator 不含 # 标题；replace_section 须以同级同名标题开头，不存在时在父级下新增；add_section 在 locator 下加子节，正文末尾新增顶层节用 {"op":"add_section","locator":{"markdown":[]},"markdown":"## 线索\\n银钥匙"}；replace_preamble 改 # 与首个 ## 间文字；replace_body 替换正文并保留原 # 标题。
- 校验与结算：先整批校验（写入授权与基本参数/形态，任一项不通过则整批拒绝、零写入），通过后逐条独立结算（失败跳过、其余生效；回执列失败项时仅补发失败项）。不回显正文，仅后续依赖精确正文或元数据时再 context_read。`,
    world_create:
      '在 Runtime 已知状态目录中新建文档。parent 须为初始索引或 state_list 返回的 @dir-*（根目录 @dir-/，冻结 frame 的空 catalog 目录可用，未知目录被拒）。refHint 是创建时建议的小写 ASCII 短引用（非 world/ 路径），后续以 Runtime 返回的 @短引用 为准。YAML 整文档引用只能写 {$ref:"@短引用"}（须来自 Runtime 返回，禁造文档 id）。',
    world_retire:
      "退役或恢复已获写入资格的精确状态文档（target 为 @短引用）。retired:true 移出后续 frame catalog 注入但保留可列、可搜、可读、可引用与可恢复；retired:false 恢复参与。不影响显式全文注入，普通字段变化用 world_patch。",
    artifact_emit:
      "提交本次后置请求预先声明的产物。只能传 output name 与 payload；频道、key、内容类型、renderer、保存策略和权威含义由 Runtime contract 固定。",
    artifact_clear:
      "清除本次后置请求预先声明且允许 clear 的产物投影；不能选择频道、key 或其他输出契约。",
  },
};

export function hasLegacyHistoryTools(
  tools: readonly { name: string; inputSchema: object }[],
): boolean {
  return tools.some(({ name, inputSchema }) => {
    const schema = inputSchema as {
      properties?: Record<string, { enum?: unknown[] }>;
      oneOf?: unknown[];
      anyOf?: unknown[];
    };
    return (
      name === "context_list" ||
      (name === "history_list" && schema.properties?.order !== undefined) ||
      (name === "context_search" &&
        schema.properties?.source?.enum?.includes("history") === true)
    );
  });
}
