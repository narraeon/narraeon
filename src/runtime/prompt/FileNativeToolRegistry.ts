import type { ModelProviderKind } from "../../protocol/modelConnections.ts";

/**
 * Runtime-owned prompt tool registry.
 *
 * The file-native play codec only stores names from this registry. Provider
 * schemas and descriptions stay here so authors cannot fork the executable
 * tool contract.
 */

export const registeredRuntimeToolNames = [
  "context_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
  "artifact_emit",
  "artifact_clear",
] as const;

/** Changes only when the executable Runtime tool universe or schemas change. */
export const runtimeToolRegistryRevision = "runtime-tools-v3";

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

const toolDefinitions: Record<
  RegisteredRuntimeToolName,
  { description: string; inputSchema: object }
> = createToolDefinitions();

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
): RuntimePromptTool[] {
  return names.map((name) => ({
    name,
    description: toolDefinitions[name].description,
    inputSchema: toolDefinitions[name].inputSchema,
  }));
}

function createToolDefinitions(): Record<
  RegisteredRuntimeToolName,
  { description: string; inputSchema: object }
> {
  const object = (
    properties: Record<string, object>,
    required: string[],
  ): object => ({
    type: "object",
    additionalProperties: false,
    required,
    properties,
  });
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
    context_list: {
      description:
        '列出 Runtime 已知句柄。状态目录形状固定为 {source:"state", parent:"@dir-/"}，继续下级时 parent 只能使用结果返回的 @dir-*；历史形状固定为 {source:"history", order:"newest_first"}。两种形状互斥，不要同时传 parent 和 order。',
      inputSchema: {
        type: "object",
        oneOf: [
          object(
            {
              source: { const: "state" },
              parent: string,
              cursor: { type: ["string", "null"] },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            ["source", "parent"],
          ),
          object(
            {
              source: { const: "history" },
              order: { enum: ["newest_first", "oldest_first"] },
              cursor: { type: ["string", "null"] },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            ["source", "order"],
          ),
        ],
      },
    },
    context_search: {
      description:
        "在 state 或 history 的原文字面中搜索。0 命中只表示给定文本没有字面命中，不证明世界事实不存在；玩家可见叙事不得复述搜索过程。within 只能使用 Runtime 已返回的 @文档或 @dir-* 句柄。",
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
      description:
        "精确读取 Runtime 先前返回的 @文档、@节点或 @history-message-* 句柄。整文档结果中的读取标题、分页线、元信息边界和正文边界不属于源文；元信息只能用 set_metadata 整组更新，中间的可写正文用 locator 更新。YAML 正文不含 $document 技术头，Markdown 正文从文档 # 一级标题开始。不要传文件路径、自然语言名称或自行拼造的 world/...。",
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
      description:
        '更新已精确读取的文档。target 必须使用 @短引用；文档 title、summary 或 aliases 过时时用 {op:"set_metadata",title,summary,aliases} 整组更新，未改项照抄读取结果。YAML edit 使用 locator:{yaml:["字段","子字段"]}，例如 {op:"replace",locator:{yaml:["情况"]},value:"新值"}。YAML value 需要引用整份文档时只能写 {$ref:"@短引用"}，短引用必须来自 Runtime 的 list、read 或 create 结果；不得自行编造文档 id。没有可用句柄时，根据语义使用普通文本，或先 world_create 后使用其返回的 @短引用。向已存在的 sequence 末尾加一项必须使用 append 并把 locator 指向该 sequence；add 只创建尚不存在的 map key 或 list index。Markdown locator 不包含文档 # 一级标题：{markdown:["职责"]} 精确指向 ## 职责，replace_section.markdown 必须从同级同名标题开始。修改 # 标题下、第一个 ## 前的文字用 replace_preamble（只传该段文字）；替换整个 Markdown 正文用 replace_body，且 markdown 必须保留原 # 一级标题。成功结果只报告文档是否发生变化，不回显正文；只有后续决策依赖 Runtime 序列化后的精确正文时才重新 context_read。不要使用 path、JSON Pointer、set 或文件名。',
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
                object(
                  {
                    op: { const: "set_metadata" },
                    title: string,
                    summary: string,
                    aliases: { type: "array", items: { type: "string" } },
                  },
                  ["op", "title", "summary", "aliases"],
                ),
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
      description:
        '在 Runtime 返回的状态目录中创建文档。parent 必须是 context_list 返回的 @dir-*，例如 @dir-/characters；根目录使用 @dir-/。refHint 是小写 ASCII 短引用，不要传 world/ 路径。YAML body 需要引用整份文档时只能写 {$ref:"@短引用"}，且短引用必须来自 Runtime 的 list、read 或 create 结果；不得自行编造文档 id。',
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
      description:
        "提交本次后置请求预先声明的产物。只能传 output name 与 payload；频道、key、内容类型、renderer、保存策略和权威含义由 Runtime contract 固定。",
      inputSchema: object(
        {
          output: { type: "string", minLength: 1, maxLength: 128 },
          payload: {},
        },
        ["output", "payload"],
      ),
    },
    artifact_clear: {
      description:
        "清除本次后置请求预先声明且允许 clear 的产物投影；不能选择频道、key 或其他输出契约。",
      inputSchema: object(
        { output: { type: "string", minLength: 1, maxLength: 128 } },
        ["output"],
      ),
    },
  };
  return definitions;
}
