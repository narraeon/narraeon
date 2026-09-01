import type { ModelProviderKind } from "../../protocol/modelConnections.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";

/**
 * Runtime-owned prompt tool registry.
 *
 * The file-native play codec only stores names from this registry. Provider
 * schemas and descriptions stay here so authors cannot fork the executable
 * tool contract.
 */

export const registeredRuntimeToolNames = [
  "state_list",
  "history_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
  "artifact_emit",
  "artifact_clear",
] as const;

/** Changes only when the executable Runtime tool universe or schemas change. */
export const runtimeToolRegistryRevision = "runtime-tools-v6";

export type RegisteredRuntimeToolName =
  (typeof registeredRuntimeToolNames)[number];

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
  const definitions: Record<
    RegisteredRuntimeToolName,
    { description: string; inputSchema: object }
  > = {
    state_list: {
      description: descriptions.state_list,
      inputSchema: object(
        {
          parent: string,
          cursor: { type: ["string", "null"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        ["parent"],
      ),
    },
    history_list: {
      description: descriptions.history_list,
      inputSchema: object(
        {
          order: { enum: ["newest_first", "oldest_first"] },
          cursor: { type: ["string", "null"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        ["order"],
      ),
    },
    context_search: {
      description: descriptions.context_search,
      inputSchema: object(
        {
          source: { enum: ["state", "history"] },
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
      inputSchema: object(
        {
          ref: string,
          cursor: { type: ["string", "null"] },
          maxBytes: { type: "integer", minimum: 4, maximum: 8192 },
        },
        ["ref"],
      ),
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
                    op: { enum: ["replace_section", "add_section"] },
                    locator: markdownLocator,
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
          body: { type: "string", maxLength: 65536 },
        },
        ["parent", "codec", "refHint", "title", "summary", "aliases", "body"],
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

const toolDescriptions: Record<
  AppLocale,
  Record<RegisteredRuntimeToolName, string>
> = {
  en: {
    state_list:
      "List document and state directory handles known to Runtime. parent must be @dir-/ for the state root or an @dir-* handle returned by an earlier state_list result; descend only through returned directory handles. A cursor is valid only for the same state snapshot, parent, and limit. Pass returned document handles to context_read. This tool never lists committed history.",
    history_list:
      "List handles for committed history messages known to Runtime. order must be newest_first or oldest_first. A cursor is valid only for the same committed-history snapshot, order, and limit. Pass returned @history-message-* handles to context_read. This tool never lists the mutable state directory.",
    context_search:
      "Search literal source text in state or history. Zero matches means only that the supplied text had no literal match; it does not prove that a world fact does not exist. Player-visible narrative must not recount the search process. within accepts only an @document or @dir-* handle returned by Runtime.",
    context_read:
      "Precisely read an @document, @node, or @history-message-* handle previously returned by Runtime. Read headings, page markers, metadata boundaries, and body boundaries in a whole-document result are not source text. set_metadata may include only the fields that must change; Runtime preserves omitted metadata fields. Update the writable body between the boundaries with locators. YAML bodies omit the $document technical header; Markdown bodies begin at the document's level-one heading. Never pass file paths, natural-language names, or an invented world/... value.",
    world_patch:
      'Update a document that has been read precisely or whose complete body was injected with write authorization. target must be an @short-ref. When title, summary, or aliases are stale, use set_metadata and include only the title, summary, or aliases that must change. At least one is required; Runtime preserves omitted fields from the current candidate document. A YAML edit uses locator:{yaml:["field","child"]}, for example {op:"replace",locator:{yaml:["status"]},value:"new value"}. A YAML value may reference a whole document only as {$ref:"@short-ref"}; the short reference must come from a Runtime list, read, or create result. Never invent a document id. If no handle is available, use ordinary text when semantically correct or call world_create first and use its returned @short-ref. To add an item to the end of an existing sequence, use append with the locator pointing to that sequence; add creates only a map key or list index that does not exist. A Markdown locator excludes the document level-one heading: {markdown:["Responsibilities"]} points exactly to ## Responsibilities, and replace_section.markdown must begin with the same heading at the same level. Use replace_preamble for text after the level-one heading and before the first level-two heading; send only that text. Use replace_body to replace the whole Markdown body and retain the original level-one heading. Success reports only whether the document changed and does not echo the body. Call context_read again only when a later decision depends on Runtime\'s exact serialized body or current metadata. Do not use path, JSON Pointer, set, or a file name.',
    world_create:
      'Create a document inside a state directory returned by Runtime. parent must be an @dir-* handle returned by state_list, such as @dir-/characters; use @dir-/ for the root. refHint is a lowercase ASCII short-reference hint, not a world/ path. A YAML body may reference a whole document only as {$ref:"@short-ref"}, and the short reference must come from a Runtime list, read, or create result. Never invent a document id.',
    artifact_emit:
      "Submit an artifact declared in advance for this follow-up request. Supply only the output name and payload; Runtime fixes the channel, key, content type, renderer, retention policy, and authority meaning in the contract.",
    artifact_clear:
      "Clear the projection of an artifact that this follow-up declared in advance and explicitly allows to be cleared. The call cannot choose a channel, key, or any other output contract.",
  },
  "zh-CN": {
    state_list:
      "列出 Runtime 已知的文档与状态目录句柄。状态根目录的 parent 使用 @dir-/；继续下级时只能使用先前 state_list 结果返回的 @dir-*。cursor 只对同一状态快照、parent 和 limit 有效。返回的文档句柄交给 context_read；本工具不列出已提交历史。",
    history_list:
      "列出 Runtime 已知的已提交历史消息句柄。order 必须是 newest_first 或 oldest_first；cursor 只对同一历史快照、order 和 limit 有效。返回的 @history-message-* 交给 context_read；本工具不列出可变状态目录。",
    context_search:
      "在 state 或 history 的原文字面中搜索。0 命中只表示给定文本没有字面命中，不证明世界事实不存在；玩家可见叙事不得复述搜索过程。within 只能使用 Runtime 已返回的 @文档或 @dir-* 句柄。",
    context_read:
      "精确读取 Runtime 先前返回的 @文档、@节点或 @history-message-* 句柄。整文档结果中的读取标题、分页线、元信息边界和正文边界不属于源文；set_metadata 可以只提交需要改变的字段，Runtime 会保留未提供的元数据字段。中间的可写正文用 locator 更新。YAML 正文不含 $document 技术头，Markdown 正文从文档 # 一级标题开始。不要传文件路径、自然语言名称或自行拼造的 world/...。",
    world_patch:
      '更新已精确读取，或已随写入资格注入完整正文的文档。target 必须使用 @短引用；文档 title、summary 或 aliases 过时时使用 set_metadata，只提供需要改变的 title、summary 或 aliases。至少提供一项；未提供的字段由 Runtime 从当前候选文档保留。YAML edit 使用 locator:{yaml:["字段","子字段"]}，例如 {op:"replace",locator:{yaml:["情况"]},value:"新值"}。YAML value 需要引用整份文档时只能写 {$ref:"@短引用"}，短引用必须来自 Runtime 的 list、read 或 create 结果；不得自行编造文档 id。没有可用句柄时，根据语义使用普通文本，或先 world_create 后使用其返回的 @短引用。向已存在的 sequence 末尾加一项必须使用 append 并把 locator 指向该 sequence；add 只创建尚不存在的 map key 或 list index。Markdown locator 不包含文档 # 一级标题：{markdown:["职责"]} 精确指向 ## 职责，replace_section.markdown 必须从同级同名标题开始。修改 # 标题下、第一个 ## 前的文字用 replace_preamble（只传该段文字）；替换整个 Markdown 正文用 replace_body，且 markdown 必须保留原 # 一级标题。成功结果只报告文档是否发生变化，不回显正文；只有后续决策依赖 Runtime 序列化后的精确正文或当前元数据时才重新 context_read。不要使用 path、JSON Pointer、set 或文件名。',
    world_create:
      '在 Runtime 返回的状态目录中创建文档。parent 必须是 state_list 返回的 @dir-*，例如 @dir-/characters；根目录使用 @dir-/。refHint 是小写 ASCII 短引用，不要传 world/ 路径。YAML body 需要引用整份文档时只能写 {$ref:"@短引用"}，且短引用必须来自 Runtime 的 list、read 或 create 结果；不得自行编造文档 id。',
    artifact_emit:
      "提交本次后置请求预先声明的产物。只能传 output name 与 payload；频道、key、内容类型、renderer、保存策略和权威含义由 Runtime contract 固定。",
    artifact_clear:
      "清除本次后置请求预先声明且允许 clear 的产物投影；不能选择频道、key 或其他输出契约。",
  },
};
