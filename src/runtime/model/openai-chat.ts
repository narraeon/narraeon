import { bootstrapPrefixEnd } from "../prompt/FileNativePromptCompiler.ts";
import { prefillMessage } from "./AssistantPrefill.ts";
import type { ResolvedFileNativeModelConnection } from "./FileNativeModelConnection.ts";
import {
  assertModelOutputComplete,
  modelHostInputText,
  type ModelHostAppendItem,
  type ModelHostExchange,
  type ModelHostExchangeObserver,
  type ModelHostResponse,
  type ModelHostUsage,
  type ModelHostWireRequest,
} from "./ModelHost.ts";
import { aggregateChatModelStream } from "./ModelHostStream.ts";
import { ModelResponseFormatError } from "./ModelResponseCorrection.ts";
import {
  appendWithSuffixBreakpoint,
  checkedCacheBreakpoints,
  markLastMessage,
  promptCacheKey,
} from "./ProviderCache.ts";
import {
  captureDelta,
  capturedProviderOperation,
  modelDiagnosticContext,
  providerCapture,
  trace,
} from "./ProviderDiagnostics.ts";
import {
  continuationError,
  continuationInput,
  hasFrozenToolPolicy,
  initialWorldContext,
  promptDeltaProviderMessages,
  providerAllowedTools,
  providerToolDefinitions,
} from "./ProviderRequest.ts";
import {
  bearerProviderHeaders,
  dispatchProviderRequest,
  isProviderEventStream,
  providerError,
  providerJson,
  providerRequestPreview,
  providerStreamResult,
  providerUrl,
  unknownProviderResponse,
  type ProviderDispatch,
} from "./ProviderTransport.ts";
import {
  cloneProviderValue,
  isRecord,
  parseArguments,
  providerNumber,
  subtractCachedInput,
  usageRecord,
} from "./ProviderValues.ts";

function chatRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
  url: URL,
): Record<string, unknown> {
  const tools = providerToolDefinitions(request);
  const allowedTools = providerAllowedTools(request);
  const hasPolicy = hasFrozenToolPolicy(request);
  const outputLimitField =
    url.origin === "https://api.openai.com" &&
    url.pathname === "/v1/chat/completions" &&
    /^o\d+(?:-|$)/u.test(connection.modelId)
      ? "max_completion_tokens"
      : "max_tokens";
  return checkedCacheBreakpoints({
    model: connection.modelId,
    ...chatReasoningRequest(connection),
    messages: [
      ...chatBootstrapMessages(connection, request),
      ...chatAppend(connection, request),
      ...prefillMessage(request),
    ],
    ...(connection.dialect === "cliproxyapi"
      ? { prompt_cache_key: promptCacheKey(connection, request) }
      : {}),
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
    [outputLimitField]: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  });
}

function encodeInitialWorldContext(request: ModelHostExchange): unknown[] {
  const preload = initialWorldContext(request);
  if (preload === undefined) return [];
  const { callId, markdown, name, notice } = preload;
  return [
    notice,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name, arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: markdown },
  ];
}

function chatBootstrapMessages(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) => cloneProviderValue(message),
  );
  const prefixEnd = bootstrapPrefixEnd(request.bootstrap);
  messages.splice(prefixEnd, 0, ...encodeInitialWorldContext(request));
  return connection.dialect === "cliproxyapi"
    ? attachCacheControlToLastRole(
        messages,
        request.bootstrap.provider.preload === undefined ? "system" : "tool",
      )
    : messages;
}

function attachCacheControlToLastRole(
  messages: unknown[],
  role: string,
): unknown[] {
  const result = cloneProviderValue(messages);
  let target = -1;
  for (const [index, message] of result.entries())
    if (isRecord(message) && message.role === role) target = index;
  if (target < 0) return result;
  const message = result[target];
  if (!isRecord(message)) return result;
  result[target] = {
    ...message,
    cache_control: { type: "ephemeral" },
  };
  return result;
}

function chatAppend(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  return appendWithSuffixBreakpoint(
    connection,
    request,
    chatItems,
    markLastMessage,
  );
}

function chatItems(items: readonly ModelHostAppendItem[]): unknown[] {
  return items.flatMap((item): unknown[] => {
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    )
      return [{ role: "user", content: modelHostInputText(item) }];
    if (item.kind === "prompt_delta")
      return promptDeltaProviderMessages(item.logicalMessages);
    if (item.kind === "tool")
      return [
        {
          role: "tool",
          tool_call_id: item.toolCallId,
          content: item.markdown,
        },
      ];
    if (item.providerState?.protocol === "chat_completions") {
      const message = item.providerState.assistantMessage;
      if (validChatAssistantMessage(message))
        return [...continuationInput(item), cloneProviderValue(message)];
    }
    throw continuationError("Chat Completions");
  });
}

function chatReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  return {
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { reasoning_effort: connection.reasoningEffort }),
    ...(connection.dialect !== "cliproxyapi" ||
    connection.reasoningSummary === "provider_default"
      ? {}
      : {
          // Chat Completions has no standard summary switch. CLIProxyAPI
          // deliberately accepts the OpenRouter-compatible visibility bit and
          // maps it to the target protocol without changing effort.
          reasoning: {
            exclude: connection.reasoningSummary === "none",
          },
        }),
  };
}

export function validChatAssistantMessage(value: unknown): value is Record<
  string,
  unknown
> & {
  role: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
  }[];
} {
  if (!isRecord(value) || value.role !== "assistant") return false;
  if (
    value.content !== undefined &&
    value.content !== null &&
    typeof value.content !== "string"
  )
    return false;
  if (
    value.reasoning_content !== undefined &&
    value.reasoning_content !== null &&
    typeof value.reasoning_content !== "string"
  )
    return false;
  return (
    value.tool_calls === undefined ||
    (Array.isArray(value.tool_calls) &&
      value.tool_calls.every(
        (call) =>
          isRecord(call) &&
          typeof call.id === "string" &&
          isRecord(call.function) &&
          typeof call.function.name === "string" &&
          typeof call.function.arguments === "string",
      ))
  );
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
  const cacheWriteTokens =
    providerNumber(promptDetails.cache_write_tokens) ??
    providerNumber(promptDetails.cached_creation_tokens);
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

export async function exchangeChat(
  { connection, fetchImplementation, failureLog }: ProviderDispatch,
  request: ModelHostExchange,
  observer?: ModelHostExchangeObserver,
): Promise<ModelHostResponse> {
  const onDelta = observer?.onDelta;
  const signal = observer?.signal;
  const url = providerUrl(connection);
  const body = chatRequestBody(connection, request, url);
  const bodyJson = JSON.stringify(body);
  await trace("chat_request", body);
  const capture = providerCapture(
    failureLog,
    connection.provider,
    url,
    modelDiagnosticContext(request),
    bodyJson,
  );
  const diagnosticDelta = captureDelta(capture, onDelta);
  return capturedProviderOperation(failureLog, capture, async (observe) => {
    const received = await dispatchProviderRequest(
      fetchImplementation,
      url,
      {
        method: "POST",
        headers: bearerProviderHeaders(connection.apiKey),
        body: bodyJson,
        ...(signal === undefined ? {} : { signal }),
      },
      "Chat Completions",
    );
    if (!received.ok)
      throw await providerError(received, connection.apiKey, capture);
    const response = observe(received);
    if (isProviderEventStream(response)) {
      const streamed = await providerStreamResult(
        response,
        "Chat Completions",
        (body) => aggregateChatModelStream(body, diagnosticDelta),
        signal,
      );
      capture?.setReasoning(streamed.reasoningContent);
      await trace("chat_response", streamed);
      return {
        ...(streamed.content === "" ? {} : { text: streamed.content }),
        ...(streamed.reasoningContent === ""
          ? {}
          : { reasoningContent: streamed.reasoningContent }),
        providerState: {
          protocol: "chat_completions" as const,
          assistantMessage: cloneProviderValue(streamed.assistantMessage),
        },
        usage: normalizeChatUsage(streamed.usage),
        ...(streamed.stopReason === undefined
          ? {}
          : { stopReason: streamed.stopReason }),
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
        finish_reason?: string | null;
        message?: {
          role?: string;
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
          cached_creation_tokens?: number;
        };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    await trace("chat_response", payload);
    const message = payload.choices?.[0]?.message;
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (
      finishReason === "length" &&
      message !== undefined &&
      validChatAssistantMessage(message)
    ) {
      if (typeof message.content === "string")
        diagnosticDelta?.({ kind: "text", text: message.content });
      if (
        Object.keys(message).some(
          (key) =>
            !["role", "content", "tool_calls", "reasoning_content"].includes(
              key,
            ),
        )
      )
        diagnosticDelta?.({ kind: "reasoning", text: "" });
      if (message.reasoning_content != null)
        diagnosticDelta?.({
          kind: "reasoning",
          text: message.reasoning_content,
        });
      if ((message.tool_calls?.length ?? 0) > 0)
        diagnosticDelta?.({ kind: "tool", text: "" });
    }
    assertModelOutputComplete(finishReason);
    if (message === undefined)
      throw unknownProviderResponse("Chat Completions");
    if (
      finishReason !== undefined &&
      finishReason !== null &&
      typeof finishReason !== "string"
    )
      throw unknownProviderResponse("Chat Completions");
    if (!validChatAssistantMessage(message))
      throw new ModelResponseFormatError(
        "Return an assistant message with string or null content and reasoning_content. Each tool call needs an ID, a function name and JSON arguments encoded as a string.",
        "请返回一条 assistant 消息，content 和 reasoning_content 应为字符串或 null。每个工具调用都需要 ID、函数名和编码为字符串的 JSON 参数。",
      );
    capture?.setReasoning(message.reasoning_content ?? undefined);
    return {
      ...(message.content == null ? {} : { text: message.content }),
      ...(message.reasoning_content == null
        ? {}
        : { reasoningContent: message.reasoning_content }),
      providerState: {
        protocol: "chat_completions" as const,
        assistantMessage: cloneProviderValue(message),
      },
      usage: normalizeChatUsage(payload.usage),
      ...(typeof finishReason === "string" ? { stopReason: finishReason } : {}),
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
    };
  });
}

export function previewChat(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): ModelHostWireRequest {
  const url = providerUrl(connection);
  return providerRequestPreview(
    connection,
    bearerProviderHeaders(connection.apiKey),
    chatRequestBody(connection, request, url),
    url.pathname,
  );
}
