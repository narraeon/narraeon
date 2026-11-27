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
  // Only old frozen root unions need this projection. Keep their wire fallback
  // free of the field annotations introduced for newly compiled requests.
  return structuredClone(
    createToolDefinitions(defaultAppLocale, false)[name].inputSchema,
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
  includeFieldDescriptions = true,
): Record<
  RegisteredRuntimeToolName,
  { description: string; inputSchema: object }
> {
  const descriptions = toolDescriptions[locale];
  const object = objectSchema;
  const describe = (schema: object, en: string, zh: string): object =>
    includeFieldDescriptions
      ? { ...schema, description: locale === "zh-CN" ? zh : en }
      : schema;
  const string = { type: "string", minLength: 1 };
  const historyRef =
    "Use an @history-message-* ref from injected history or a tool result.";
  const historyRefZh = "使用注入历史或工具回执提供的 @history-message-* 引用。";
  const yamlLocator = describe(
    object(
      {
        yaml: describe(
          { type: "array", items: { type: ["string", "integer"] } },
          "Exact path segments: string map keys or zero-based array indexes. An empty path addresses the whole body and is valid only for add or replace.",
          "精确路径段由字符串映射键和从 0 开始的数组下标组成。空路径指向完整正文，仅可用于 add 或 replace。",
        ),
      },
      ["yaml"],
    ),
    "Location in the YAML body, outside the $document header.",
    "YAML 正文中的位置，不能指向 $document 技术头。",
  );
  const markdownLocator = describe(
    object(
      {
        markdown: describe(
          { type: "array", items: { type: "string" }, minItems: 1 },
          "Heading titles from the top-level section down to the target, excluding the document's # title and the heading markers.",
          "从顶层节到目标节的标题文字，不含文档一级标题和标题的 # 标记。",
        ),
      },
      ["markdown"],
    ),
    "Exact Markdown section to edit.",
    "要编辑的 Markdown 节的精确位置。",
  );
  const markdownParentLocator = describe(
    object(
      {
        markdown: describe(
          { type: "array", items: { type: "string" } },
          "Heading titles down to the parent, excluding the document's # title and heading markers. Use [] to add a top-level section at the end of the body.",
          "从顶层节到父节的标题文字，不含文档一级标题和标题的 # 标记。用 [] 在正文末尾添加顶层节。",
        ),
      },
      ["markdown"],
    ),
    "Exact Markdown parent under which to add the new section.",
    "添加新节的精确 Markdown 父级。",
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
          before: describe(
            string,
            `Return the page immediately before this message, excluding it. ${historyRef}`,
            `取紧邻这条消息之前的一页，不含该消息。${historyRefZh}`,
          ),
          after: describe(
            string,
            `Return the page immediately after this message, excluding it. ${historyRef}`,
            `取紧邻这条消息之后的一页，不含该消息。${historyRefZh}`,
          ),
          limit: describe(
            { type: "integer", minimum: 1, maximum: 100 },
            "Maximum messages per page. Defaults to 20.",
            "每页最多返回的消息条数，默认为 20。",
          ),
          cursor: describe(
            string,
            "Use the returned earlierCursor or laterCursor to page in that direction. Run a new query after history_changed.",
            "使用回执返回的 earlierCursor 或 laterCursor 向对应方向翻页。收到 history_changed 后重新查询。",
          ),
        },
        [],
      ),
    },
    history_search: {
      description: descriptions.history_search,
      inputSchema: object(
        {
          queries: describe(
            {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: { type: "string", minLength: 1, maxLength: 256 },
            },
            "One to five non-blank literal search terms, each at most 256 Unicode code points. Equivalent terms after normalization are deduplicated. Required for a new search.",
            "一至五个非空白字面搜索词，每词最多 256 个 Unicode 码点。归一化后等价的词会去重。发起新搜索时必传。",
          ),
          match: describe(
            { enum: ["any", "all"] },
            "Match any term by default. all requires every term in the same message.",
            "默认 any，匹配任一搜索词。all 要求所有搜索词出现在同一条消息中。",
          ),
          order: describe(
            { enum: ["newest_first", "oldest_first"] },
            "Order matching messages newest first (default) or oldest first in timeline order.",
            "按时间线先后排列命中消息，默认最新在前，也可选最早在前。",
          ),
          caseSensitive: describe(
            { type: "boolean" },
            "True preserves case. False (default) folds case. Both use NFKC normalization.",
            "true 区分大小写，false（默认）折叠大小写。两者均进行 NFKC 归一化。",
          ),
          after: describe(
            string,
            `Search only messages later than this exclusive lower bound. ${historyRef}`,
            `只搜索晚于这条消息的原文，不含该消息。${historyRefZh}`,
          ),
          before: describe(
            string,
            `Search only messages earlier than this exclusive upper bound. ${historyRef}`,
            `只搜索早于这条消息的原文，不含该消息。${historyRefZh}`,
          ),
          limit: describe(
            { type: "integer", minimum: 1, maximum: 50 },
            "Maximum matching messages per page. Defaults to 10.",
            "每页最多返回的命中消息条数，默认为 10。",
          ),
          cursor: describe(
            string,
            "Use the returned nextCursor for the next page of the same search. Run a new query after history_changed.",
            "使用回执返回的 nextCursor 继续同一次搜索的下一页。收到 history_changed 后重新查询。",
          ),
        },
        [],
      ),
    },
    history_read: {
      description: descriptions.history_read,
      inputSchema: object(
        {
          latest: describe(
            { type: "integer", minimum: 1, maximum: 21 },
            "Number of latest messages to read, from 1 to 21.",
            "要读最近多少条消息，范围为 1 至 21。",
          ),
          ref: describe(
            string,
            `The anchor message, always included in the window. ${historyRef}`,
            `读取窗口必含的锚点消息。${historyRefZh}`,
          ),
          before: describe(
            { type: "integer", minimum: 0, maximum: 20 },
            "Number of messages to include before ref, excluding the anchor from the count. Defaults to 0.",
            "要附带读取的锚点之前的消息条数，不计锚点，默认为 0。",
          ),
          after: describe(
            { type: "integer", minimum: 0, maximum: 20 },
            "Number of messages to include after ref, excluding the anchor from the count. Defaults to 0.",
            "要附带读取的锚点之后的消息条数，不计锚点，默认为 0。",
          ),
        },
        [],
      ),
    },
    context_search: {
      description: descriptions.context_search,
      inputSchema: object(
        {
          source: describe(
            { const: "state" },
            "Use state to search current world documents.",
            "传入 state，在当前世界的状态文档中搜索。",
          ),
          query: describe(
            { type: "string", minLength: 1, maxLength: 256 },
            "A single literal string to find in document text.",
            "要在文档原文中查找的单个字面字符串。",
          ),
          caseSensitive: describe(
            { type: "boolean" },
            "True preserves case. False (default) folds case. Both use NFKC normalization.",
            "true 区分大小写，false（默认）折叠大小写。两者均进行 NFKC 归一化。",
          ),
          within: describe(
            string,
            "Use a Runtime-returned document @short-ref or @dir-* directory handle to restrict the scope. Omit to search all state documents.",
            "用 Runtime 返回的文档 @短引用或 @dir-* 目录句柄限定范围。省略时搜索全部状态文档。",
          ),
          limit: describe(
            { type: "integer", minimum: 1, maximum: 50 },
            "Maximum literal matches per page. Defaults to 10.",
            "每页最多返回的字面命中数，默认为 10。",
          ),
          cursor: describe(
            { type: ["string", "null"] },
            "Use the returned next-page cursor to continue with the same source, query, scope, case setting and limit. Omit or use null to start at the first page.",
            "保留原 source、query、within、caseSensitive 和 limit，并用返回的下一页游标续查。省略或传 null 从第一页开始。",
          ),
        },
        ["source", "query"],
      ),
    },
    context_read: {
      description: descriptions.context_read,
      inputSchema: object(
        {
          ref: describe(
            string,
            "Use a Runtime-returned @document or @node handle. Re-read available material only for missing content, required write authorization, or unseen metadata (a full-document read includes the current title, summary, and aliases).",
            "使用 Runtime 返回的 @文档或 @节点句柄。已有材料只在需要补齐正文、取得写入资格或查看未显示的元数据时才重读（整份文档的读取结果包含当前 title、summary 和 aliases）。",
          ),
        },
        ["ref"],
      ),
    },
    world_patch: {
      description: descriptions.world_patch,
      inputSchema: object(
        {
          target: describe(
            string,
            "The document's Runtime-returned @short-ref. Each edit must be covered by a precise read or injected material. Whole-document coverage permits body and metadata edits; node coverage permits only edits within that node.",
            "Runtime 返回的文档 @短引用。每条编辑须在精确读取或注入材料的范围内。整份文档范围可编辑正文和元数据，节点范围只可编辑该节点及其子节点。",
          ),
          edits: describe(
            {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: {
                oneOf: [
                  describe(
                    object(
                      {
                        op: describe(
                          { enum: ["add", "replace", "append"] },
                          "add and replace both write to existing or missing targets, creating missing parent maps and appending at indexes at or past the end. append adds one item to an existing sequence.",
                          "add 与 replace 都可写入已有或缺失的目标，自动创建缺失的父映射，下标达到或超过数组长度时追加。append 向既有序列末尾追加一项。",
                        ),
                        locator: yamlLocator,
                        value: describe(
                          {},
                          'YAML-compatible value, or a map without $document when replacing the whole body. For a document reference use only {$ref:"@short-ref"} with a Runtime-returned handle. Use plain text or world_create if no handle is available.',
                          '要写入的 YAML 兼容值。写入完整正文时须为不含 $document 的映射。引用文档时只用 {$ref:"@短引用"}，句柄须来自 Runtime；没有句柄时用普通文字或先调用 world_create。',
                        ),
                      },
                      ["op", "locator", "value"],
                    ),
                    "Write a YAML value at a precise location.",
                    "在精确位置写入 YAML 值。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { const: "remove" },
                          "Delete the addressed map key or array item. A missing target is reported as a no-op.",
                          "删除指定的映射键或数组元素。目标缺失时，回执会标为无操作。",
                        ),
                        locator: yamlLocator,
                      },
                      ["op", "locator"],
                    ),
                    "Remove a YAML node.",
                    "删除一个 YAML 节点。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { const: "replace_section" },
                          "Replace the named section, or add it under its existing parent if the section is absent.",
                          "替换指定节；若该节缺失，则在其已有父级下添加。",
                        ),
                        locator: markdownLocator,
                        markdown: describe(
                          { type: "string" },
                          "One complete section starting with the heading matching the locator's title and level. Include only content within that section.",
                          "传一份完整的节，以和定位器同名同级的标题开头，正文只包含本节范围内的内容。",
                        ),
                      },
                      ["op", "locator", "markdown"],
                    ),
                    "Write a Markdown section by its own heading path.",
                    "按节本身的标题路径写入 Markdown 节。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { const: "add_section" },
                          "Add one child section under the located parent.",
                          "在定位到的父级下添加一个子节。",
                        ),
                        locator: markdownParentLocator,
                        markdown: describe(
                          { type: "string" },
                          "One complete section starting with a heading one level below its parent, such as ## Clues for a top-level section.",
                          "传一份完整的节，以比父级低一级的标题开头。顶层节可用 ## 线索 一类的标题。",
                        ),
                      },
                      ["op", "locator", "markdown"],
                    ),
                    "Add a Markdown section by its parent's heading path.",
                    "按父级的标题路径添加 Markdown 节。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { const: "rename_section" },
                          "Rename an existing section, preserving its level and contents.",
                          "重命名已有节，保留标题级别和内容。",
                        ),
                        locator: markdownLocator,
                        title: describe(
                          string,
                          "New heading text without its # markers.",
                          "新标题的文字，不含 # 标记。",
                        ),
                      },
                      ["op", "locator", "title"],
                    ),
                    "Change a Markdown section heading.",
                    "修改 Markdown 节标题。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { const: "remove_section" },
                          "Delete the located heading and its whole section. A missing section is reported as a no-op.",
                          "删除指定标题和整节内容。该节缺失时，回执会标为无操作。",
                        ),
                        locator: markdownLocator,
                      },
                      ["op", "locator"],
                    ),
                    "Remove a Markdown section.",
                    "删除一个 Markdown 节。",
                  ),
                  describe(
                    {
                      ...object(
                        {
                          op: describe(
                            { const: "set_metadata" },
                            "Supply only changed metadata fields, with at least one of title, summary, or aliases. Omitted fields are preserved.",
                            "只传有变化的元数据字段。title、summary、aliases 至少传一项，省略的字段原样保留。",
                          ),
                          title: describe(
                            string,
                            "New document title. Also updates the # title in Markdown documents.",
                            "新文档标题。Markdown 文档的一级标题也会同步更新。",
                          ),
                          summary: describe(
                            string,
                            "New short catalog summary for the document.",
                            "用于目录索引的新文档简介。",
                          ),
                          aliases: describe(
                            { type: "array", items: { type: "string" } },
                            "Complete replacement list of alternate names. Use [] to clear it.",
                            "用这份别名列表整体替换旧值。传 [] 清空。",
                          ),
                        },
                        ["op"],
                      ),
                      minProperties: 2,
                    },
                    "Update YAML or Markdown document metadata.",
                    "更新 YAML 或 Markdown 文档的元数据。",
                  ),
                  describe(
                    object(
                      {
                        op: describe(
                          { enum: ["replace_body", "replace_preamble"] },
                          "replace_body rewrites the complete Markdown body. replace_preamble rewrites only the text after the # title and before the first ## heading (or the end if there is no ##).",
                          "replace_body 重写整个 Markdown 正文。replace_preamble 只重写一级标题之后、首个二级标题之前的文字（无二级标题则到文末）。",
                        ),
                        markdown: describe(
                          { type: "string" },
                          "For replace_body include the existing # title and the complete new body, without technical front matter. For replace_preamble supply only the replacement preamble text.",
                          "replace_body 要包含原有一级标题和完整的新正文，不带技术头。replace_preamble 只传用来替换前言的文字。",
                        ),
                      },
                      ["op", "markdown"],
                    ),
                    "Rewrite the Markdown body or just its preamble.",
                    "重写 Markdown 正文或其中的前言。",
                  ),
                ],
              },
            },
            "Ordered array of 1 to 32 edits to the same document. Use the branch matching each op. Resend only failures listed in the receipt. The receipt omits the body, so read it with context_read only if a later decision needs exact content or metadata.",
            "按顺序对同一文档执行的 1 至 32 条编辑，逐条使用与 op 对应的分支。仅补发回执列出的失败项。回执省略正文，后续判断需要精确正文或元数据时再调用 context_read。",
          ),
        },
        ["target", "edits"],
      ),
    },
    world_create: {
      description: descriptions.world_create,
      inputSchema: object(
        {
          parent: describe(
            string,
            "Runtime-returned @dir-* from the initial index or state_list. Use @dir-/ for root. Empty frozen-frame catalog directories are valid; unknown directories are rejected.",
            "使用初始索引或 state_list 返回的 @dir-*，根目录用 @dir-/。冻结 frame 声明的空 catalog 目录可用，未知目录会被拒绝。",
          ),
          codec: describe(
            { enum: ["yaml", "markdown"] },
            "Source format of body, either yaml or markdown.",
            "body 的原文格式，选 yaml 或 markdown。",
          ),
          refHint: describe(
            { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
            "Suggested short reference, 2–32 ASCII characters, starting with a lowercase letter and followed by lowercase letters, digits, or hyphens. Omit the @ prefix and any path. Runtime may add a suffix on collision. Use the returned @short-ref afterward.",
            "建议短引用，长 2 至 32 个 ASCII 字符，以小写字母开头，后续仅用小写字母、数字或连字符。不带 @ 前缀或路径。冲突时 Runtime 可能添加后缀，后续使用回执中的 @短引用。",
          ),
          title: describe(
            { type: "string", minLength: 1, maxLength: 120 },
            "Document display title. For markdown it must match the body's # heading.",
            "文档显示标题。Markdown 文档的正文一级标题须与它一致。",
          ),
          summary: describe(
            { type: "string", minLength: 1, maxLength: 240 },
            "Brief description for the catalog.",
            "用于目录索引的简短文档介绍。",
          ),
          aliases: describe(
            {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            "List of alternate names. Pass [] if there are none.",
            "文档别名列表，没有别名时传 []。",
          ),
          body: describe(
            { type: "string" },
            'Complete source text without Runtime metadata. For yaml supply a map without $document. Reference an existing document only with {$ref:"@short-ref"} using a Runtime-returned handle. For markdown start with the # heading matching title and omit technical front matter.',
            '传不含 Runtime 元数据的完整源文。YAML 须为不含 $document 的映射，引用已有文档时只用 {$ref:"@短引用"}，句柄须来自 Runtime。Markdown 须以和 title 相同的一级标题开头，不带技术头。',
          ),
        },
        ["parent", "codec", "refHint", "title", "summary", "aliases", "body"],
      ),
    },
    world_retire: {
      description: descriptions.world_retire,
      inputSchema: object(
        {
          target: describe(
            string,
            "Runtime-returned @short-ref of a document whose full body was read precisely or injected with write authorization.",
            "Runtime 返回的文档 @短引用。须已精确读取全文，或已随写入资格完整注入该文档。",
          ),
          retired: describe(
            { type: "boolean" },
            "True retires the document from future frame catalog injection. False restores its catalog eligibility. Either way it stays stored, listable, searchable, readable and referenceable, and explicit full-document slots still work.",
            "true 退役，将文档移出后续 frame catalog 注入。false 恢复其进入目录索引的资格。两种状态下文档均保留，可列、可搜、可读、可引用，显式全文注入仍可使用。",
          ),
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
      "Discover unknown state directory or document handles. Use @dir-/ for the root or an @dir-* from the initial index or state_list. Use known handles directly. Empty catalog directories declared by the frozen frame stay usable. Returns the whole directory (Complete: yes). Directory entries do not grant write authorization. Never lists committed history.",
    history_list:
      "Browse committed timeline history including the opening, with previews of up to 120 code points in Authority acceptance order from oldest to newest. Historical background reflects capture-time state only, not current world state, and neither certifies facts nor grants character knowledge. Use either before or after for an anchored page, neither for the latest page, or {cursor} alone to continue.",
    history_search:
      "Search committed timeline originals for literal terms and get counts, up to 3 excerpts per message, and original lengths. Start with queries or continue with {cursor} alone, and if both bounds are set, after must precede before in timeline order regardless of result order. Zero matches do not prove an event never happened.",
    history_read:
      "Read complete committed originals on the current timeline, oldest to newest, without summaries, truncation or body pagination. Pass latest alone or ref with optional before and after totaling at most 20 messages besides the anchor. The earlier and later refs mark the immediately adjacent messages outside the window.",
    context_search:
      "Search literal text in current world state. Use history_search for committed narrative. Zero matches do not prove that a fact is absent.",
    context_read:
      "Read the full content of a Runtime-returned @document or @node handle without truncation or pagination. Receipt headings, boundaries, scope and completion markers are not source text; YAML bodies omit $document and Markdown bodies start at the # heading. Never pass file paths, natural-language names, or invented world/... values.",
    world_patch:
      "Apply a batch of edits to one authorized state document. Before the first edit, Runtime checks the target, edits array, write authorization for the whole batch, and the shape of every $ref object, rejecting the whole batch without writes if any check fails. After preflight, Runtime settles edits in order and resolves specific $ref targets per edit, so a failed edit is skipped while others can apply.",
    world_create:
      "Create a state document in a Runtime-known directory. Runtime assigns its identity.",
    world_retire:
      "Retire or restore an authorized state document. Use world_patch for ordinary edits.",
    artifact_emit:
      "Submit an artifact declared in advance for this follow-up request. Supply only the output name and payload; Runtime fixes the channel, key, content type, renderer, retention policy, and authority meaning in the contract.",
    artifact_clear:
      "Clear the projection of an artifact that this follow-up declared in advance and explicitly allows to be cleared. The call cannot choose a channel, key, or any other output contract.",
  },
  "zh-CN": {
    world_checkpoint:
      "登记事件间隙并向玩家建议从此开启全新上下文（参数为空对象 {}）。生效边界见“工具与响应结算”，登记时机见检查点政策。整理归并无需调用，勿为登记推进剧情。",
    state_list:
      "发现未知的状态目录或文档句柄。根目录用 @dir-/，下级用初始目录索引或 state_list 返回的 @dir-*。已有句柄直接使用。冻结 frame 声明的空 catalog 目录仍可用。每次整份返回（完整返回：是），目录条目不授予写入资格。不列出已提交历史。",
    history_list:
      "浏览当前时间线已提交历史（含开场白），页内按 Authority 接受顺序由旧到新，每条预览最多 120 个码点。历史背景仅说明采集时刻状态，不是当前世界状态，不认证事实或授予角色知识。按锚点查页时只传 before 或 after 之一，查最新页时均省略，续页只传 {cursor}。",
    history_search:
      "在当前时间线已提交原文中搜索字面词，返回命中数、每条消息最多 3 个片段和原文长度。新搜索传 queries 或只传 {cursor} 续页，同时指定两个边界时，无论结果如何排序，时间线上 after 须早于 before。零命中不证明事件未发生。",
    history_read:
      "完整读取当前时间线已提交原文，由旧到新，无摘要、无截断、无正文分页。只传 latest，或传 ref 并按需加 before 和 after，两项计数合计最多 20 条消息，另含锚点。earlier 和 later 指向紧邻窗口外的消息。",
    context_search:
      "在当前世界的状态文档中做字面搜索。已提交叙事用 history_search。零命中不证明事实不存在。",
    context_read:
      "完整读取 Runtime 返回的 @文档或 @节点句柄，无截断无分页。回执中的读取标题、边界、范围与完成标记不是源文；YAML 正文不含 $document 头，Markdown 正文从 # 标题开始。勿传文件路径、自然语言名或编造的 world/...。",
    world_patch:
      "批量编辑一份已获写入资格的状态文档。第一条编辑执行前，Runtime 校验目标、edits 数组、整批的写入资格和每个 $ref 对象的形态，任一预检不通过则整批拒绝、零写入。预检通过后按顺序逐条独立结算，在该条内解析具体 $ref 目标，失败项跳过，其余可照常生效。",
    world_create:
      "在 Runtime 已知的目录中新建状态文档。文档身份由 Runtime 分配。",
    world_retire: "退役或恢复已获写入资格的状态文档。普通编辑用 world_patch。",
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
