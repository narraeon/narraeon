import { hasCLIProxyThinkingSuffix } from "../../protocol/modelConnections.ts";
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
import { aggregateAnthropicModelStream } from "./ModelHostStream.ts";
import { ModelResponseFormatError } from "./ModelResponseCorrection.ts";
import {
  appendWithSuffixBreakpoint,
  checkedCacheBreakpoints,
} from "./ProviderCache.ts";
import {
  captureDelta,
  capturedProviderOperation,
  modelDiagnosticContext,
  providerCapture,
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
  providerNumber,
  usageRecord,
} from "./ProviderValues.ts";

interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

function isAnthropicCacheBreakpoint(
  block: unknown,
): block is Record<string, unknown> {
  return (
    isRecord(block) &&
    isRecord(block.cache_control) &&
    block.cache_control.type === "ephemeral"
  );
}

function applyBootstrapCacheControl(
  block: unknown,
  cacheControl: AnthropicCacheControl,
): unknown {
  return isAnthropicCacheBreakpoint(block)
    ? { ...block, cache_control: cacheControl }
    : block;
}

function anthropicRequestBody(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): Record<string, unknown> {
  const cacheControl: AnthropicCacheControl = {
    type: "ephemeral",
    ...(connection.anthropicPromptCacheTtl === "1h" ? { ttl: "1h" } : {}),
  };
  const system = request.bootstrap.provider.system?.map((block) =>
    applyBootstrapCacheControl(block, cacheControl),
  );
  const messages = [
    ...anthropicBootstrapMessages(request, cacheControl),
    ...appendWithSuffixBreakpoint(
      connection,
      request,
      anthropicItems,
      (items) => markLastAnthropicBlock(items, cacheControl),
    ),
    ...prefillMessage(request, true),
  ];
  // Tool arguments and provider extensions can also contain a cache_control key.
  const cacheBreakpoints = [
    ...(system ?? []),
    ...messages.flatMap((message) =>
      isRecord(message) && Array.isArray(message.content)
        ? (message.content as unknown[])
        : [],
    ),
  ].filter(isAnthropicCacheBreakpoint).length;
  const tools = providerToolDefinitions(request);
  const body = {
    model: connection.modelId,
    ...anthropicReasoningRequest(connection),
    system,
    messages,
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
    ...(hasFrozenToolPolicy(request) &&
    providerAllowedTools(request).length === 0
      ? { tool_choice: { type: "none" } }
      : {}),
    max_tokens: request.maxOutputTokens,
    stream: true,
  };
  return checkedCacheBreakpoints(body, cacheBreakpoints);
}

function encodeInitialWorldContext(
  request: ModelHostExchange,
  cacheControl: AnthropicCacheControl,
): unknown[] {
  const preload = initialWorldContext(request);
  if (preload === undefined) return [];
  const { callId, markdown, name, notice } = preload;
  return [
    notice,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name, input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          content: markdown,
          ...(request.bootstrap.cache.strategy === "explicit_anthropic_blocks"
            ? { cache_control: cacheControl }
            : {}),
        },
      ],
    },
  ];
}

function anthropicBootstrapMessages(
  request: ModelHostExchange,
  cacheControl: AnthropicCacheControl,
): unknown[] {
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? (message.content as unknown[]).map((block) =>
            applyBootstrapCacheControl(block, cacheControl),
          )
        : message.content,
    }),
  );
  messages.splice(
    bootstrapPrefixEnd(request.bootstrap),
    0,
    ...encodeInitialWorldContext(request, cacheControl),
  );
  return messages.filter(
    (message) => !isRecord(message) || message.role !== "system",
  );
}

/** Thinking blocks reject cache_control, so the breakpoint lands on the last block that accepts it. */
function markLastAnthropicBlock(
  messages: unknown[],
  cacheControl: AnthropicCacheControl,
): unknown[] {
  const last = messages.at(-1);
  if (!isRecord(last))
    throw new Error("The transcript tail cannot carry a cache breakpoint.");
  const content: unknown[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : Array.isArray(last.content)
        ? last.content
        : [];
  const index = content.findLastIndex(
    (block) =>
      isRecord(block) &&
      block.type !== "thinking" &&
      block.type !== "redacted_thinking",
  );
  if (index < 0)
    throw new Error(
      "The Anthropic transcript tail has no block that can carry a cache breakpoint.",
    );
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: content.map((block, position) =>
        position === index
          ? {
              ...(block as Record<string, unknown>),
              cache_control: cacheControl,
            }
          : block,
      ),
    },
  ];
}

function anthropicItems(items: readonly ModelHostAppendItem[]): unknown[] {
  const messages: unknown[] = [];
  let toolResults: Record<string, unknown>[] = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: item.markdown,
        ...(item.isError === true ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    ) {
      messages.push({ role: "user", content: modelHostInputText(item) });
      continue;
    }
    if (item.kind === "prompt_delta") {
      messages.push(...promptDeltaProviderMessages(item.logicalMessages));
      continue;
    }
    if (
      item.providerState?.protocol === "anthropic_messages" &&
      validAnthropicContent(item.providerState.content)
    ) {
      messages.push(...continuationInput(item), {
        role: "assistant",
        content: cloneProviderValue(item.providerState.content),
      });
      continue;
    }
    throw continuationError("Anthropic Messages");
  }
  flushToolResults();
  return messages;
}

function anthropicReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  const display =
    connection.reasoningSummary === "provider_default"
      ? {}
      : {
          display:
            connection.reasoningSummary === "auto" ? "summarized" : "omitted",
        };
  const thinking =
    connection.thinkingMode === "provider_default"
      ? connection.dialect === "cliproxyapi" &&
        hasCLIProxyThinkingSuffix(connection.modelId) &&
        connection.reasoningSummary !== "provider_default"
        ? {
            // CLIProxyAPI extracts visibility from a valid source thinking
            // block before the model suffix replaces its mode. The suffix is
            // still the sole mode/effort authority; adaptive is only the
            // proxy's protocol-valid summary carrier.
            thinking: { type: "adaptive", ...display },
          }
        : {}
      : connection.thinkingMode === "disabled"
        ? { thinking: { type: "disabled" } }
        : connection.thinkingMode === "adaptive"
          ? { thinking: { type: "adaptive", ...display } }
          : {
              thinking: {
                type: "enabled",
                budget_tokens: connection.thinkingBudgetTokens,
                ...display,
              },
            };
  return {
    ...thinking,
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { output_config: { effort: connection.reasoningEffort } }),
  };
}

export function validAnthropicContent(
  value: unknown,
): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item) || typeof item.type !== "string") return false;
      if (item.type === "text") return typeof item.text === "string";
      if (item.type === "thinking")
        return (
          typeof item.thinking === "string" &&
          (item.signature === undefined || typeof item.signature === "string")
        );
      if (item.type === "redacted_thinking")
        return typeof item.data === "string";
      if (item.type === "tool_use")
        return (
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          isRecord(item.input)
        );
      return true;
    })
  );
}

function normalizeAnthropicUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
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
      reasoningTokens:
        providerNumber(outputDetails.thinking_tokens) ??
        providerNumber(usage.thinking_tokens),
      outputTokens,
      totalTokens:
        inputTokens === null || outputTokens === null
          ? null
          : inputTokens + outputTokens,
    },
    ["inputTokens", "totalTokens"],
  );
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

export async function exchangeAnthropic(
  { connection, fetchImplementation, failureLog, trace }: ProviderDispatch,
  request: ModelHostExchange,
  observer?: ModelHostExchangeObserver,
): Promise<ModelHostResponse> {
  const onDelta = observer?.onDelta;
  const signal = observer?.signal;
  const body = anthropicRequestBody(connection, request);
  const bodyJson = JSON.stringify(body);
  await trace?.("anthropic_request", body);
  const url = providerUrl(connection);
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
        headers: anthropicRequestHeaders(connection.apiKey),
        body: bodyJson,
        ...(signal === undefined ? {} : { signal }),
      },
      "Anthropic Messages",
    );
    if (!received.ok)
      throw await providerError(received, connection.apiKey, capture, trace);
    const response = observe(received);
    if (isProviderEventStream(response)) {
      const streamed = await providerStreamResult(
        response,
        "Anthropic Messages",
        (body) => aggregateAnthropicModelStream(body, diagnosticDelta),
        signal,
      );
      capture?.setReasoning(streamed.reasoningContent);
      await trace?.("anthropic_response", streamed);
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
          protocol: "anthropic_messages" as const,
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
        ...(typeof streamed.stopReason === "string"
          ? { stopReason: streamed.stopReason }
          : {}),
      };
    }
    const rawPayload = await providerJson(response, "Anthropic Messages");
    if (!isRecord(rawPayload) || !Array.isArray(rawPayload.content))
      throw unknownProviderResponse("Anthropic Messages");
    const payload = rawPayload as {
      content?: (
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
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
    if (
      payload.stop_reason === "max_tokens" &&
      validAnthropicContent(payload.content)
    ) {
      for (const part of payload.content) {
        if (part.type === "text" && typeof part.text === "string")
          diagnosticDelta?.({ kind: "text", text: part.text });
        else
          diagnosticDelta?.({
            kind: part.type === "tool_use" ? "tool" : "reasoning",
            text: "",
          });
      }
    }
    assertModelOutputComplete(payload.stop_reason);
    const content = payload.content!;
    if (!validAnthropicContent(content))
      throw new ModelResponseFormatError(
        "Return a valid Anthropic Messages assistant response. Each tool call needs an ID, a name and valid arguments.",
        "请返回有效的 Anthropic Messages assistant 响应。每个工具调用都需要 ID、名称和有效参数。",
      );
    await trace?.("anthropic_response", payload);
    const reasoningContent = content
      .filter(
        (item): item is { type: "thinking"; thinking: string } =>
          item.type === "thinking",
      )
      .map(({ thinking }) => thinking)
      .join("");
    capture?.setReasoning(reasoningContent);
    return {
      text: content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map(({ text }) => text)
        .join(""),
      ...(reasoningContent === "" ? {} : { reasoningContent }),
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
        protocol: "anthropic_messages" as const,
        content: cloneProviderValue(content),
        ...(payload.id === undefined ? {} : { responseId: payload.id }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.stop_reason === undefined
          ? {}
          : { stopReason: payload.stop_reason }),
      },
      usage: normalizeAnthropicUsage(payload.usage),
      ...(typeof payload.stop_reason === "string"
        ? { stopReason: payload.stop_reason }
        : {}),
    };
  });
}

function anthropicRequestHeaders(apiKey: string) {
  return {
    Accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

export function previewAnthropic(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): ModelHostWireRequest {
  return providerRequestPreview(
    connection,
    anthropicRequestHeaders(connection.apiKey),
    anthropicRequestBody(connection, request),
  );
}
