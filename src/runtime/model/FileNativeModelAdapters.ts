import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostExchangeObserver,
  ModelHostExchange,
  ModelHostToolCall,
  ModelHostUsage,
  ModelHostResponse,
} from "./ModelHost.ts";
import {
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "./ModelHost.ts";
import {
  renderPromptDeltaMessage,
  type FileNativePromptInput,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  documentCandidateSettingTools,
  SettingAuthorAdapter,
  SettingAuthorMessage,
  SettingAuthorUsage,
} from "../setting/DocumentCandidateSettingImprovement.ts";
import type { ProviderExchangeState } from "./ProviderExchangeState.ts";
import {
  aggregateAnthropicSettingStream,
  aggregateChatSettingStream,
} from "./SettingAuthorStream.ts";
import {
  aggregateAnthropicModelStream,
  aggregateChatModelStream,
  aggregateResponsesModelStream,
  type ModelHostDeltaSink,
} from "./ModelHostStream.ts";
import {
  defaultRuntimeToolDefinitionStrategy,
  type RuntimeToolDefinitionStrategy,
} from "../prompt/FileNativeToolRegistry.ts";

export interface FileNativeModelConnection {
  provider: FileNativePromptInput["modelBinding"]["provider"];
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export class FileNativeModelHost implements ModelHost {
  readonly #connection: FileNativeModelConnection;
  readonly #fetch: typeof fetch;

  constructor(
    connection: FileNativeModelConnection,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.#connection = structuredClone(connection);
    this.#fetch = fetchImplementation;
  }

  binding(): ModelHostBinding {
    const { provider, modelId, contextWindowTokens, maxOutputTokens } =
      this.#connection;
    return {
      provider,
      modelId,
      contextWindowTokens,
      maxOutputTokens,
      endpointFingerprint: createHash("sha256")
        .update(`${provider}\0${this.#connection.baseUrl}`)
        .digest("hex"),
      protocolConfigFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            provider,
            stream: true,
            toolChoice: "runtime_strategy",
            responseStorage:
              provider === "openai_responses" ? "disabled" : "provider_default",
            encryptedReasoningContinuation:
              provider === "openai_responses" ? "included" : "not_requested",
            anthropicVersion:
              provider === "anthropic_messages" ? "2023-06-01" : null,
          }),
        )
        .digest("hex"),
    };
  }

  async exchange(
    request: ModelHostExchange,
    observer?: ModelHostExchangeObserver,
  ): Promise<ModelHostResponse> {
    await trace("model_host_exchange", modelHostTrace(request));
    if (this.#connection.provider === "chat_completions")
      return this.#chat(request, observer?.onDelta);
    if (this.#connection.provider === "openai_responses")
      return this.#responses(request, observer?.onDelta);
    return this.#anthropic(request, observer?.onDelta);
  }

  async #responses(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
  ): Promise<ModelHostResponse> {
    return openAIResponsesRequest({
      connection: this.#connection,
      fetchImplementation: this.#fetch,
      input: [
        ...request.bootstrap.provider.messages.map(responsesBootstrapMessage),
        ...responsesAppend(request),
      ],
      tools: providerToolDefinitions(request).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
      allowedTools: providerAllowedTools(request),
      toolStrategy: providerToolStrategy(request, this.#connection.provider),
      hasFrozenToolPolicy: hasFrozenToolPolicy(request),
      maxOutputTokens: request.maxOutputTokens,
      tracePrefix: "responses",
      ...(onDelta === undefined ? {} : { onDelta }),
    });
  }

  async #chat(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
  ): Promise<ModelHostResponse> {
    const messages = [
      ...request.bootstrap.provider.messages,
      ...chatAppend(request),
    ];
    const tools = providerToolDefinitions(request);
    const allowedTools = providerAllowedTools(request);
    const hasPolicy = hasFrozenToolPolicy(request);
    const body = {
      model: this.#connection.modelId,
      messages,
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }),
      ...(hasPolicy && allowedTools.length === 0
        ? { tool_choice: "none" }
        : tools.length === 0
          ? {}
          : { tool_choice: "auto" }),
      max_tokens: request.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    const bodyJson = JSON.stringify(body);
    await trace("chat_request", body);
    const response = await dispatchProviderRequest(
      this.#fetch,
      providerUrl(this.#connection),
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.#connection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: bodyJson,
      },
      "Chat Completions",
    );
    if (!response.ok) throw await providerError(response);
    if (isProviderEventStream(response)) {
      const streamed = await providerStreamResult(
        response,
        "Chat Completions",
        (body) => aggregateChatModelStream(body, onDelta),
      );
      await trace("chat_response", streamed);
      return {
        ...(streamed.content === "" ? {} : { text: streamed.content }),
        ...(streamed.reasoningContent === ""
          ? {}
          : { reasoningContent: streamed.reasoningContent }),
        providerState: {
          protocol: "chat_completions",
          assistantMessage: cloneProviderValue(streamed.assistantMessage),
        },
        usage: normalizeChatUsage(streamed.usage),
        toolCalls: streamed.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: parseArguments(call.arguments),
        })),
      };
    }
    const rawPayload = await providerJson(response, "Chat Completions");
    if (
      !isRecord(rawPayload) ||
      !Array.isArray(rawPayload.choices) ||
      !isRecord(rawPayload.choices[0]) ||
      !isRecord(rawPayload.choices[0].message)
    )
      throw unknownProviderResponse("Chat Completions");
    const payload = rawPayload as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        };
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    await trace("chat_response", payload);
    const message = payload.choices?.[0]?.message;
    if (message === undefined)
      throw unknownProviderResponse("Chat Completions");
    if (
      (message.content !== undefined &&
        message.content !== null &&
        typeof message.content !== "string") ||
      (message.reasoning_content !== undefined &&
        message.reasoning_content !== null &&
        typeof message.reasoning_content !== "string") ||
      (message.tool_calls !== undefined &&
        (!Array.isArray(message.tool_calls) ||
          message.tool_calls.some(
            (call) =>
              !isRecord(call) ||
              typeof call.id !== "string" ||
              !isRecord(call.function) ||
              typeof call.function.name !== "string" ||
              typeof call.function.arguments !== "string",
          )))
    )
      throw unknownProviderResponse("Chat Completions");
    return {
      ...(message.content == null ? {} : { text: message.content }),
      ...(message.reasoning_content == null
        ? {}
        : { reasoningContent: message.reasoning_content }),
      providerState: {
        protocol: "chat_completions",
        assistantMessage: cloneProviderValue(message),
      },
      usage: normalizeChatUsage(payload.usage),
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
    };
  }

  async #anthropic(
    request: ModelHostExchange,
    onDelta?: ModelHostDeltaSink,
  ): Promise<ModelHostResponse> {
    const tools = providerToolDefinitions(request);
    const body = {
      model: this.#connection.modelId,
      system: request.bootstrap.provider.system,
      messages: [
        ...request.bootstrap.provider.messages.filter(
          ({ role }) => role !== "system",
        ),
        ...anthropicAppend(request),
      ],
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }),
      max_tokens: request.maxOutputTokens,
      stream: true,
    };
    const bodyJson = JSON.stringify(body);
    await trace("anthropic_request", body);
    const response = await dispatchProviderRequest(
      this.#fetch,
      providerUrl(this.#connection),
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "anthropic-version": "2023-06-01",
          "x-api-key": this.#connection.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyJson,
      },
      "Anthropic Messages",
    );
    if (!response.ok) throw await providerError(response);
    if (isProviderEventStream(response)) {
      const streamed = await providerStreamResult(
        response,
        "Anthropic Messages",
        (body) => aggregateAnthropicModelStream(body, onDelta),
      );
      await trace("anthropic_response", streamed);
      return {
        ...(streamed.text === "" ? {} : { text: streamed.text }),
        ...(streamed.reasoningContent === ""
          ? {}
          : { reasoningContent: streamed.reasoningContent }),
        toolCalls: streamed.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments),
        })),
        providerState: {
          protocol: "anthropic_messages",
          content: cloneProviderValue(streamed.content),
          ...(streamed.responseId === undefined
            ? {}
            : { responseId: streamed.responseId }),
          ...(streamed.model === undefined ? {} : { model: streamed.model }),
          ...(streamed.stopReason === undefined
            ? {}
            : { stopReason: streamed.stopReason }),
        },
        usage: normalizeAnthropicUsage(streamed.usage),
      };
    }
    const rawPayload = await providerJson(response, "Anthropic Messages");
    if (!isRecord(rawPayload) || !Array.isArray(rawPayload.content))
      throw unknownProviderResponse("Anthropic Messages");
    const payload = rawPayload as {
      content?: (
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
        | Record<string, unknown>
      )[];
      id?: string;
      model?: string;
      stop_reason?: string | null;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const content = payload.content!;
    if (
      content.some(
        (item) =>
          !isRecord(item) ||
          typeof item.type !== "string" ||
          (item.type === "text" && typeof item.text !== "string") ||
          (item.type === "tool_use" &&
            (typeof item.id !== "string" ||
              typeof item.name !== "string" ||
              !("input" in item))),
      )
    )
      throw unknownProviderResponse("Anthropic Messages");
    await trace("anthropic_response", payload);
    return {
      text: content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map(({ text }) => text)
        .join(""),
      toolCalls: content
        .filter(
          (
            item,
          ): item is {
            type: "tool_use";
            id: string;
            name: string;
            input: unknown;
          } => item.type === "tool_use",
        )
        .map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.input,
        })),
      providerState: {
        protocol: "anthropic_messages",
        content: cloneProviderValue(content),
        ...(payload.id === undefined ? {} : { responseId: payload.id }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.stop_reason === undefined
          ? {}
          : { stopReason: payload.stop_reason }),
      },
      usage: normalizeAnthropicUsage(payload.usage),
    };
  }
}

function modelHostTrace(request: ModelHostExchange) {
  return {
    requestId: request.requestId,
    operationId: request.operationId,
    requestAttempt: request.requestAttempt,
    exchange: request.exchange,
    bootstrap: structuredClone(request.bootstrap),
    appended: request.appended.map((item) =>
      item.kind !== "assistant"
        ? structuredClone(item)
        : {
            kind: item.kind,
            text: item.text,
            toolCalls: structuredClone(item.toolCalls),
            reasoningContentAvailable: item.reasoningContent !== undefined,
            providerStateAvailable: item.providerState !== undefined,
          },
    ),
    tools: request.tools.map(({ name }) => name),
    toolUniverse: request.toolUniverse?.map(({ name }) => name),
    allowedTools: structuredClone(request.allowedTools),
    toolStrategy: structuredClone(request.toolStrategy),
    maxOutputTokens: request.maxOutputTokens,
  };
}

async function trace(kind: string, value: unknown): Promise<void> {
  const path = process.env.NARRAEON_PROVIDER_TRACE_PATH;
  if (path === undefined) return;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const size = await stat(path).then(
      ({ size }) => size,
      () => 0,
    );
    if (size > 0) await chmod(path, 0o600);
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024 - size) return;
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Explicit acceptance diagnostics must never change provider semantics.
  }
}

export class FileNativeSettingAuthorProvider implements SettingAuthorAdapter {
  readonly #connection: FileNativeModelConnection;
  readonly #fetch: typeof fetch;

  constructor(
    connection: FileNativeModelConnection,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.#connection = structuredClone(connection);
    this.#fetch = fetchImplementation;
  }

  async next(request: Parameters<SettingAuthorAdapter["next"]>[0]) {
    const tools = request.tools.map(settingToolDefinition);
    if (this.#connection.provider === "chat_completions") {
      const body = {
        model: this.#connection.modelId,
        messages: request.messages.map(chatSettingMessage),
        ...(tools.length === 0
          ? {}
          : {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.schema,
                },
              })),
            }),
        max_tokens: Math.min(
          request.maxOutputTokens,
          this.#connection.maxOutputTokens,
        ),
        stream: true,
        stream_options: { include_usage: true },
      };
      await trace("setting_chat_request", body);
      const response = await this.#fetch(providerUrl(this.#connection), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#connection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await providerError(response);
      if (response.body === null) throw new Error("创作响应缺少流式正文");
      const streamed = await aggregateChatSettingStream(
        response.body,
        request.onDelta,
      );
      await trace("setting_chat_response", streamed);
      return {
        role: "assistant" as const,
        content: streamed.content,
        ...(streamed.reasoningContent === ""
          ? {}
          : { reasoningContent: streamed.reasoningContent }),
        toolCalls: streamed.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: asArguments(parseArguments(call.arguments)),
        })),
        usage: settingAuthorUsage(normalizeChatUsage(streamed.usage)),
      };
    }
    if (this.#connection.provider === "openai_responses") {
      const response = await openAIResponsesRequest({
        connection: this.#connection,
        fetchImplementation: this.#fetch,
        input: request.messages.flatMap(responsesSettingMessage),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        })),
        maxOutputTokens: Math.min(
          request.maxOutputTokens,
          this.#connection.maxOutputTokens,
        ),
        tracePrefix: "setting_responses",
        ...(request.onDelta === undefined ? {} : { onDelta: request.onDelta }),
      });
      return {
        role: "assistant" as const,
        content: response.text ?? "",
        providerState: response.providerState,
        toolCalls: (response.toolCalls ?? []).map((call) => ({
          ...call,
          arguments: asArguments(call.arguments),
        })),
        usage: settingAuthorUsage(response.usage),
      };
    }
    const system = request.messages
      .filter(({ role }) => role === "system")
      .map(({ content }) => content)
      .join("\n\n");
    const body = {
      model: this.#connection.modelId,
      ...(system.length === 0 ? {} : { system }),
      messages: request.messages
        .filter(({ role }) => role !== "system")
        .map(anthropicSettingMessage),
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.schema,
            })),
          }),
      max_tokens: Math.min(
        request.maxOutputTokens,
        this.#connection.maxOutputTokens,
      ),
      stream: true,
    };
    await trace("setting_anthropic_request", body);
    const response = await this.#fetch(providerUrl(this.#connection), {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": this.#connection.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await providerError(response);
    if (response.body === null) throw new Error("创作响应缺少流式正文");
    const streamed = await aggregateAnthropicSettingStream(
      response.body,
      request.onDelta,
    );
    await trace("setting_anthropic_response", streamed);
    return {
      role: "assistant" as const,
      content: streamed.content,
      ...(streamed.reasoningContent === ""
        ? {}
        : { reasoningContent: streamed.reasoningContent }),
      toolCalls: streamed.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: asArguments(parseArguments(call.arguments)),
      })),
      usage: settingAuthorUsage(normalizeAnthropicUsage(streamed.usage)),
    };
  }
}

// The progress projection only counts tokens, so the nullable per-field
// provenance of ModelHostUsage collapses to two numbers here.
function settingAuthorUsage(
  usage: ModelHostUsage | undefined,
): SettingAuthorUsage {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

function settingToolDefinition(
  name: (typeof documentCandidateSettingTools)[number],
) {
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
  const definitions = {
    setting_list: {
      description:
        "通过当前候选文档快照列出 world 或 world/ 子目录；根目录同时显示 opening／control 等专用文件。分页 cursor 只能用于产生它的同一候选快照和相同查询。",
      schema: schema(
        {
          // World document paths accept any segment that is not "."/".."; an
          // ASCII-only pattern here made directories the author had just
          // created impossible to list back.
          directory: {
            type: "string",
            pattern: "^world(?:/[^\\\\]+)?$",
          },
          limit,
          cursor,
        },
        [],
      ),
    },
    setting_search: {
      description:
        "通过当前候选文档快照原文字面搜索 world 文档；within 可取 world/ 目录、world/ 文档路径、@短引用或文档身份。",
      schema: schema(
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
    setting_read: {
      description:
        "通过当前候选文档快照按 world/ 路径、@短引用或文档身份精确读取世界文档正文；opening／control 使用精确路径专用读取。只有读完全部分页才获得写授权，此后不因其他修改失效。",
      schema: schema(
        {
          path,
          maxBytes: { type: "integer", minimum: 4, maximum: 65_536 },
          cursor,
        },
        ["path"],
      ),
    },
    setting_write_file: {
      description:
        "创建或整份写入一个候选文件，path 一律是完整逻辑路径：world/ 下的 .yaml 或 .md 世界文档、control/frame.yaml、control/player-views.yaml、control/blocks/*.md，或根级 opening.md。新建世界文档写完整原文并带 $document 技术头；覆盖既有世界文档可以省略 $document，直接写回 setting_read 返回的正文，Runtime 会沿用原有 title、summary 和 aliases。id 和 ref 始终由 Runtime 决定——新建时分配，覆盖时保留原值，你写什么都不会报错。既有 world 文档和既有 opening.md 必须先完整读取。",
      schema: schema({ path, contents: text }, ["path", "contents"]),
    },
    setting_patch: {
      description:
        '通过 revision 按文档 ID、@短引用或 world/ 逻辑路径 patch 一个 YAML map 节点；op 必须明确选择 add（新增）或 replace（替换），locator 是稳定 map-key 数组，例如 ["关系","对玩家","信任"]。既有文档必须已完整读取。Markdown 文档请用 setting_write_file 整份重写。',
      schema: schema(
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
    setting_move: {
      description:
        "通过 revision 把已完整读取的 world 文档移动到新的 world/ 逻辑路径；用于修复 catalog 目录关联，保留文档内容和身份。",
      schema: schema({ from: text, to: path }, ["from", "to"]),
    },
    setting_preview_candidate: {
      description:
        "对当前隔离候选运行内容树机械检查和真实 Prompt Preview，并返回路径关联、slot、引用和材料覆盖诊断；所有最终修改后调用，通过后才可结束候选。未通过属于正常迭代，修复后重新调用即可。",
      schema: schema({}, []),
    },
    setting_finish_candidate: {
      description:
        "setting_preview_candidate 已对最终修改返回自检通过后调用，可以紧接在同一模型响应的自检之后；必须是当前响应的最后一个调用，且不得携带参数。",
      schema: schema({}, []),
    },
  } satisfies Record<
    (typeof documentCandidateSettingTools)[number],
    { description: string; schema: object }
  >;
  return { name, ...definitions[name] };
}

function items(request: ModelHostExchange): ModelHostAppendItem[] {
  return request.appended;
}

type ProviderRequest = ModelHostExchange;

type FrozenModelHostExchange = ModelHostExchange & {
  toolUniverse: NonNullable<ModelHostExchange["toolUniverse"]>;
};

/**
 * A frozen policy is present when the caller supplies the logical operation's
 * complete tool universe. All play lifecycles share this one ModelHost seam.
 */
function hasFrozenToolPolicy(request: ProviderRequest): boolean {
  return frozenToolPolicy(request) !== null;
}

function frozenToolPolicy(
  request: ProviderRequest,
): FrozenModelHostExchange | null {
  if (!("toolUniverse" in request && request.toolUniverse !== undefined))
    return null;
  return request as FrozenModelHostExchange;
}

function providerToolDefinitions(
  request: ProviderRequest,
): PromptCompilation["tools"] {
  const policy = frozenToolPolicy(request);
  return policy?.toolUniverse ?? request.tools;
}

function providerAllowedTools(request: ProviderRequest): string[] {
  const policy = frozenToolPolicy(request);
  if (policy !== null) return [...(policy.allowedTools ?? [])];
  return request.tools.map((tool) => tool.name);
}

function providerToolStrategy(
  request: ProviderRequest,
  provider: FileNativeModelConnection["provider"],
): RuntimeToolDefinitionStrategy {
  const policy = frozenToolPolicy(request);
  if (policy?.toolStrategy !== undefined) return policy.toolStrategy;
  return defaultRuntimeToolDefinitionStrategy(provider);
}

function chatAppend(request: ModelHostExchange) {
  return items(request).flatMap((item) => {
    if (item.kind === "player") return { role: "user", content: item.text };
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return {
        role: "tool",
        tool_call_id: item.toolCallId,
        content: item.markdown,
      };
    if (item.providerState?.protocol === "chat_completions") {
      const message = item.providerState.assistantMessage;
      if (isRecord(message)) return [cloneProviderValue(message)];
    }
    const assistant = {
      role: "assistant",
      content: item.text,
      ...(item.reasoningContent === undefined
        ? {}
        : { reasoning_content: item.reasoningContent }),
      ...(item.toolCalls.length === 0
        ? {}
        : {
            tool_calls: item.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }),
    };
    return assistant;
  });
}

function anthropicAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item): unknown => {
    if (item.kind === "player") return { role: "user", content: item.text };
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.toolCallId,
            content: item.markdown,
          },
        ],
      };
    if (item.providerState?.protocol === "anthropic_messages")
      return [
        {
          role: "assistant",
          content: cloneProviderValue(item.providerState.content),
        },
      ];
    return {
      role: "assistant",
      content: [
        ...(item.text.length === 0 ? [] : [{ type: "text", text: item.text }]),
        ...item.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ],
    };
  });
}

function responsesAppend(request: ModelHostExchange): unknown[] {
  return items(request).flatMap((item) => {
    if (item.kind === "player") return [{ role: "user", content: item.text }];
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return [
        {
          type: "function_call_output",
          call_id: item.toolCallId,
          output: item.markdown,
        },
      ];
    if (item.providerState?.protocol === "openai_responses")
      return cloneResponseOutput(item.providerState.output);
    return fallbackResponsesAssistant(item.text, item.toolCalls);
  });
}

function promptDeltaProviderMessages(
  messages: PromptCompilation["logicalMessages"],
) {
  return messages.map((message) => ({
    role: "user" as const,
    content: renderPromptDeltaMessage(message.role, message.markdown),
  }));
}

function providerUrl(connection: FileNativeModelConnection): URL {
  const url = new URL(connection.baseUrl);
  const suffix =
    connection.provider === "chat_completions"
      ? "/chat/completions"
      : connection.provider === "openai_responses"
        ? "/responses"
        : "/messages";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { $invalidToolArgumentsJson: value };
  }
}

async function providerError(response: Response): Promise<Error> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 4096);
  } catch {
    // A non-2xx response is already a confirmed remote rejection. Preserve
    // that deterministic classification even if its error body is unreadable.
  }
  await trace("provider_error", {
    status: response.status,
    statusText: response.statusText,
    body: text,
  });
  return new ModelHostFailureError(
    `Provider 请求失败：${response.status} ${text}`,
  );
}

function chatSettingMessage(message: SettingAuthorMessage) {
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  return {
    role:
      message.role === "assistant"
        ? "assistant"
        : message.role === "system"
          ? "system"
          : "user",
    content: message.content,
    ...(message.role !== "assistant" || message.reasoningContent === undefined
      ? {}
      : { reasoning_content: message.reasoningContent }),
    ...(message.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0
      ? {}
      : {
          tool_calls: message.toolCalls!.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        }),
  };
}

function anthropicSettingMessage(message: SettingAuthorMessage) {
  if (message.role === "tool")
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  if (message.role === "assistant")
    return {
      role: "assistant",
      content: [
        ...(message.content.length === 0
          ? []
          : [{ type: "text", text: message.content }]),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ],
    };
  return { role: "user", content: message.content };
}

function responsesSettingMessage(message: SettingAuthorMessage): unknown[] {
  if (message.role === "tool")
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  if (
    message.role === "assistant" &&
    message.providerState?.protocol === "openai_responses"
  )
    return cloneResponseOutput(message.providerState.output);
  if (message.role === "assistant")
    return fallbackResponsesAssistant(message.content, message.toolCalls ?? []);
  return [{ role: message.role, content: message.content }];
}

function responsesBootstrapMessage(
  message: PromptCompilation["provider"]["messages"][number],
) {
  return { role: message.role, content: providerText(message.content) };
}

function providerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const items: unknown[] = content;
    return items
      .flatMap((item) =>
        isRecord(item) && typeof item.text === "string" ? [item.text] : [],
      )
      .join("\n\n");
  }
  return JSON.stringify(content) ?? "";
}

function fallbackResponsesAssistant(
  text: string,
  toolCalls: readonly ModelHostToolCall[],
): unknown[] {
  return [
    ...(text.length === 0 ? [] : [{ role: "assistant", content: text }]),
    ...toolCalls.map((call) => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
  ];
}

async function openAIResponsesRequest(input: {
  connection: FileNativeModelConnection;
  fetchImplementation: typeof fetch;
  input: unknown[];
  tools: { name: string; description: string; parameters: object }[];
  allowedTools?: string[];
  toolStrategy?: RuntimeToolDefinitionStrategy;
  hasFrozenToolPolicy?: boolean;
  maxOutputTokens: number;
  tracePrefix: string;
  onDelta?: ModelHostDeltaSink;
}): Promise<{
  text?: string;
  usage?: ModelHostUsage;
  providerState: ProviderExchangeState;
  toolCalls?: ModelHostToolCall[];
}> {
  const allowedTools =
    input.allowedTools ?? input.tools.map((tool) => tool.name);
  const toolChoice =
    input.hasFrozenToolPolicy === true && allowedTools.length === 0
      ? "none"
      : input.hasFrozenToolPolicy === true &&
          input.toolStrategy === "native_allowed_subset"
        ? {
            type: "allowed_tools",
            mode: "auto",
            tools: allowedTools.map((name) => ({ type: "function", name })),
          }
        : "auto";
  const body = {
    model: input.connection.modelId,
    input: input.input,
    ...(input.tools.length === 0
      ? input.hasFrozenToolPolicy === true && allowedTools.length === 0
        ? { tool_choice: "none" }
        : {}
      : {
          tools: input.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          tool_choice: toolChoice,
        }),
    max_output_tokens: input.maxOutputTokens,
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: true,
  };
  await trace(`${input.tracePrefix}_request`, body);
  const bodyJson = JSON.stringify(body);
  const response = await dispatchProviderRequest(
    input.fetchImplementation,
    providerUrl(input.connection),
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${input.connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: bodyJson,
    },
    "OpenAI Responses",
  );
  if (!response.ok) throw await providerError(response);
  const payload = isProviderEventStream(response)
    ? await providerStreamResult(response, "Responses API", (body) =>
        aggregateResponsesModelStream(body, input.onDelta),
      )
    : await providerJson(response, "Responses API");
  await trace(`${input.tracePrefix}_response`, payload);
  if (!isRecord(payload) || !Array.isArray(payload.output))
    throw unknownProviderResponse("Responses API");
  const output = cloneResponseOutput(payload.output);
  if (
    output.some(
      (item) =>
        !isRecord(item) ||
        typeof item.type !== "string" ||
        (item.type === "message" && !Array.isArray(item.content)) ||
        (item.type === "function_call" &&
          (typeof item.call_id !== "string" ||
            typeof item.name !== "string" ||
            typeof item.arguments !== "string")),
    )
  )
    throw unknownProviderResponse("Responses API");
  const text = output
    .flatMap((item) => {
      if (
        !isRecord(item) ||
        item.type !== "message" ||
        !Array.isArray(item.content)
      )
        return [];
      return item.content.flatMap((part) =>
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      );
    })
    .join("");
  const toolCalls = output.flatMap((item): ModelHostToolCall[] => {
    if (
      !isRecord(item) ||
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    )
      return [];
    return [
      {
        id: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      },
    ];
  });
  return {
    ...(text.length === 0 ? {} : { text }),
    providerState: {
      protocol: "openai_responses",
      output,
      ...(typeof payload.id === "string" ? { responseId: payload.id } : {}),
    },
    usage: normalizeResponsesUsage(payload.usage),
    toolCalls,
  };
}

function cloneResponseOutput(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Responses output 必须是数组");
  const source = JSON.stringify(value);
  return JSON.parse(source) as unknown[];
}

/** Clone provider-owned state before it enters the logical transcript. */
function cloneProviderValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  const source = JSON.stringify(value);
  if (typeof source !== "string") return value;
  return JSON.parse(source) as T;
}

function normalizeChatUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const inputTokens = providerNumber(usage.prompt_tokens);
  const cacheReadTokens = providerNumber(promptDetails.cached_tokens);
  const cacheWriteTokens = providerNumber(promptDetails.cache_write_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens: subtractCachedInput(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: providerNumber(completionDetails.reasoning_tokens),
      outputTokens: providerNumber(usage.completion_tokens),
      totalTokens: providerNumber(usage.total_tokens),
    },
    ["uncachedInputTokens"],
  );
}

function normalizeAnthropicUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const uncachedInputTokens = providerNumber(usage.input_tokens);
  const cacheReadTokens = providerNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = providerNumber(usage.cache_creation_input_tokens);
  const inputTokens = sumInputTokens(
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  );
  const outputTokens = providerNumber(usage.output_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: null,
      outputTokens,
      totalTokens:
        inputTokens === null || outputTokens === null
          ? null
          : inputTokens + outputTokens,
    },
    ["inputTokens", "totalTokens"],
  );
}

function normalizeResponsesUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
  const inputTokens = providerNumber(usage.input_tokens);
  const cacheReadTokens = providerNumber(inputDetails.cached_tokens);
  const cacheWriteTokens = providerNumber(inputDetails.cache_write_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens: subtractCachedInput(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: providerNumber(outputDetails.reasoning_tokens),
      outputTokens: providerNumber(usage.output_tokens),
      totalTokens: providerNumber(usage.total_tokens),
    },
    ["uncachedInputTokens"],
  );
}

function providerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageRecord(
  values: {
    inputTokens: number | null;
    uncachedInputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  },
  derivedFields: (keyof typeof values)[] = [],
): ModelHostUsage {
  const derived = new Set(derivedFields);
  const provenance = (
    key: keyof typeof values,
    value: number | null,
  ): ModelHostUsage["provenance"]["inputTokens"] =>
    value === null
      ? "unavailable"
      : derived.has(key)
        ? "derived_provider_fields"
        : "provider";
  return {
    ...values,
    provenance: {
      inputTokens: provenance("inputTokens", values.inputTokens),
      uncachedInputTokens: provenance(
        "uncachedInputTokens",
        values.uncachedInputTokens,
      ),
      cacheReadTokens: provenance("cacheReadTokens", values.cacheReadTokens),
      cacheWriteTokens: provenance("cacheWriteTokens", values.cacheWriteTokens),
      reasoningTokens: provenance("reasoningTokens", values.reasoningTokens),
      outputTokens: provenance("outputTokens", values.outputTokens),
      totalTokens: provenance("totalTokens", values.totalTokens),
    },
  };
}

function subtractCachedInput(
  inputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
): number | null {
  if (
    inputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    cacheReadTokens + cacheWriteTokens > inputTokens
  )
    return null;
  return inputTokens - cacheReadTokens - cacheWriteTokens;
}

function sumInputTokens(
  uncachedInputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
): number | null {
  if (
    uncachedInputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null
  )
    return null;
  return uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
}

async function parseProviderJson(
  response: Response,
  label: string,
): Promise<unknown> {
  const source = await response.text();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} 响应不是合法 JSON`);
  }
}

async function providerJson(
  response: Response,
  label: string,
): Promise<unknown> {
  try {
    return await parseProviderJson(response, label);
  } catch (error: unknown) {
    throw new ModelHostOutcomeUnknownError(`${label} 已派发但响应无法确认`, {
      cause: error,
    });
  }
}

function isProviderEventStream(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") === true
  );
}

async function providerStreamResult<Value>(
  response: Response,
  label: string,
  read: (body: ReadableStream<Uint8Array>) => Promise<Value>,
): Promise<Value> {
  if (response.body === null)
    throw new ModelHostOutcomeUnknownError(`${label} 已派发但流式响应缺少正文`);
  try {
    return await read(response.body);
  } catch (error: unknown) {
    if (
      error instanceof ModelHostFailureError ||
      error instanceof ModelHostOutcomeUnknownError
    )
      throw error;
    throw new ModelHostOutcomeUnknownError(
      `${label} 已派发但流式响应无法确认`,
      { cause: error },
    );
  }
}

async function dispatchProviderRequest(
  fetchImplementation: typeof fetch,
  url: URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetchImplementation(url, init);
  } catch (error: unknown) {
    throw new ModelHostOutcomeUnknownError(`${label} 请求已派发但结果未知`, {
      cause: error,
    });
  }
}

function unknownProviderResponse(label: string): ModelHostOutcomeUnknownError {
  return new ModelHostOutcomeUnknownError(`${label} 已派发但响应形状无法确认`);
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("创作工具参数必须是对象");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
