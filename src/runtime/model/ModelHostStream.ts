import { ModelHostFailureError, type ModelHostDelta } from "./ModelHost.ts";
import { providerStreamEvents } from "./ProviderStream.ts";

export type ModelHostDeltaSink = (delta: ModelHostDelta) => void;

export interface ChatModelStreamResult {
  content: string;
  reasoningContent: string;
  assistantMessage: Record<string, unknown>;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: unknown;
}

export async function aggregateChatModelStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: ModelHostDeltaSink,
): Promise<ChatModelStreamResult> {
  let content = "";
  let reasoningContent = "";
  let usage: unknown;
  let completed = false;
  let sawPayload = false;
  const calls = new Map<
    number,
    { id: string; name: string; type: string; arguments: string }
  >();

  for await (const event of modelHostEvents(body)) {
    if (event.data === "[DONE]") {
      completed = true;
      break;
    }
    const payload = streamRecord(event.data);
    sawPayload = true;
    if (isRecord(payload.error))
      throw new ModelHostFailureError(
        "Provider SSE returned an explicit error",
      );
    if (!Array.isArray(payload.choices))
      throw new Error("Chat SSE choices are invalid");
    if (payload.choices.length > 1)
      throw new Error("Chat SSE returned multiple choices");
    if (payload.usage !== undefined) usage = payload.usage;

    for (const choiceValue of payload.choices) {
      if (!isRecord(choiceValue) || !isRecord(choiceValue.delta))
        throw new Error("Chat SSE choice delta is invalid");
      if (choiceValue.index !== undefined && choiceValue.index !== 0)
        throw new Error("Chat SSE choice index is invalid");
      if (
        choiceValue.finish_reason !== undefined &&
        choiceValue.finish_reason !== null &&
        typeof choiceValue.finish_reason !== "string"
      )
        throw new Error("Chat SSE finish_reason is invalid");
      const delta = choiceValue.delta;
      if (delta.role !== undefined && delta.role !== "assistant")
        throw new Error("Chat SSE assistant role is invalid");
      if (
        delta.content !== undefined &&
        delta.content !== null &&
        typeof delta.content !== "string"
      )
        throw new Error("Chat SSE content delta is invalid");
      if (typeof delta.content === "string" && delta.content !== "") {
        content += delta.content;
        onDelta?.({ kind: "text", text: delta.content });
      }
      if (
        delta.reasoning_content !== undefined &&
        delta.reasoning_content !== null &&
        typeof delta.reasoning_content !== "string"
      )
        throw new Error("Chat SSE reasoning delta is invalid");
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content !== ""
      ) {
        reasoningContent += delta.reasoning_content;
        onDelta?.({ kind: "reasoning", text: delta.reasoning_content });
      }
      // Gateways in front of a Chat Completions Model often write `null` where
      // the protocol omits a field, both for the whole tool-call list and for
      // individual fragment fields. A null carries no continuation content.
      if (delta.tool_calls === undefined || delta.tool_calls === null) continue;
      if (!Array.isArray(delta.tool_calls))
        throw new Error("Chat SSE tool_calls delta is invalid");
      for (const [position, fragmentValue] of delta.tool_calls.entries()) {
        if (!isRecord(fragmentValue))
          throw new Error("Chat SSE tool-call fragment is invalid");
        const index =
          typeof fragmentValue.index === "number"
            ? fragmentValue.index
            : position;
        if (!Number.isSafeInteger(index) || index < 0)
          throw new Error("Chat SSE tool-call index is invalid");
        const current = calls.get(index) ?? {
          id: "",
          name: "",
          type: "function",
          arguments: "",
        };
        if (isPresent(fragmentValue.id)) {
          if (typeof fragmentValue.id !== "string")
            throw new Error("Chat SSE tool-call id is invalid");
          current.id += fragmentValue.id;
        }
        if (isPresent(fragmentValue.type)) {
          if (fragmentValue.type !== "function")
            throw new Error("Chat SSE tool-call type is invalid");
          current.type = fragmentValue.type;
        }
        if (isPresent(fragmentValue.function)) {
          if (!isRecord(fragmentValue.function))
            throw new Error("Chat SSE tool-call function is invalid");
          const function_ = fragmentValue.function;
          if (isPresent(function_.name)) {
            if (typeof function_.name !== "string")
              throw new Error("Chat SSE tool-call name is invalid");
            current.name += function_.name;
          }
          if (isPresent(function_.arguments)) {
            if (typeof function_.arguments !== "string")
              throw new Error("Chat SSE tool-call arguments are invalid");
            current.arguments += function_.arguments;
            if (function_.arguments !== "")
              onDelta?.({ kind: "tool", text: function_.arguments });
          }
        }
        calls.set(index, current);
      }
    }
  }

  if (!completed || !sawPayload)
    throw new Error("Chat SSE ended before a complete response");
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (call.id === "" || call.name === "" || call.type !== "function")
        throw new Error("Chat SSE tool call is incomplete");
      return { id: call.id, name: call.name, arguments: call.arguments };
    });
  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: content === "" ? null : content,
    ...(reasoningContent === "" ? {} : { reasoning_content: reasoningContent }),
    ...(toolCalls.length === 0
      ? {}
      : {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
  };
  return {
    content,
    reasoningContent,
    assistantMessage,
    toolCalls,
    usage,
  };
}

export interface AnthropicModelStreamResult {
  content: Record<string, unknown>[];
  text: string;
  reasoningContent: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  usage: unknown;
  responseId?: string;
  model?: string;
  stopReason?: string | null;
}

interface AnthropicBlock {
  value: Record<string, unknown>;
  partialJson: string;
  stopped: boolean;
}

export async function aggregateAnthropicModelStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: ModelHostDeltaSink,
): Promise<AnthropicModelStreamResult> {
  const blocks = new Map<number, AnthropicBlock>();
  const usage: Record<string, unknown> = {};
  let started = false;
  let stopped = false;
  let responseId: string | undefined;
  let model: string | undefined;
  let stopReason: string | null | undefined;

  stream: for await (const event of modelHostEvents(body)) {
    const payload = streamRecord(event.data);
    if (typeof payload.type !== "string")
      throw new Error("Anthropic SSE type is invalid");
    if (event.event !== null && event.event !== payload.type)
      throw new Error("Anthropic SSE event and payload type do not match");
    switch (payload.type) {
      case "message_start": {
        if (started || !isRecord(payload.message))
          throw new Error("Anthropic SSE message_start is invalid");
        if (
          payload.message.role !== "assistant" ||
          !Array.isArray(payload.message.content)
        )
          throw new Error("Anthropic SSE initial message is invalid");
        started = true;
        responseId = stringOrUndefined(payload.message.id);
        model = stringOrUndefined(payload.message.model);
        mergeUsage(usage, payload.message.usage);
        break;
      }
      case "content_block_start": {
        const index = streamIndex(payload.index);
        if (!isRecord(payload.content_block) || blocks.has(index))
          throw new Error("Anthropic SSE content block start is invalid");
        blocks.set(index, {
          value: structuredClone(payload.content_block),
          partialJson: "",
          stopped: false,
        });
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(streamIndex(payload.index));
        if (block === undefined || block.stopped || !isRecord(payload.delta))
          throw new Error("Anthropic SSE content block delta is invalid");
        const delta = payload.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          appendBlockString(block.value, "text", delta.text, "text");
          if (delta.text !== "") onDelta?.({ kind: "text", text: delta.text });
          break;
        }
        if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          appendBlockString(
            block.value,
            "thinking",
            delta.thinking,
            "thinking",
          );
          if (delta.thinking !== "")
            onDelta?.({ kind: "reasoning", text: delta.thinking });
          break;
        }
        if (
          delta.type === "signature_delta" &&
          typeof delta.signature === "string"
        ) {
          appendBlockString(
            block.value,
            "signature",
            delta.signature,
            "thinking",
          );
          break;
        }
        if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          block.value.type === "tool_use"
        ) {
          block.partialJson += delta.partial_json;
          if (delta.partial_json !== "")
            onDelta?.({ kind: "tool", text: delta.partial_json });
          break;
        }
        throw new Error("Anthropic SSE delta type is not supported");
      }
      case "content_block_stop": {
        const block = blocks.get(streamIndex(payload.index));
        if (block === undefined || block.stopped)
          throw new Error("Anthropic SSE content block stop is invalid");
        block.stopped = true;
        if (block.value.type === "tool_use" && block.partialJson !== "")
          block.value.input = parseStreamJson(block.partialJson);
        break;
      }
      case "message_delta": {
        if (!isRecord(payload.delta))
          throw new Error("Anthropic SSE message_delta is invalid");
        if (
          payload.delta.stop_reason !== undefined &&
          payload.delta.stop_reason !== null &&
          typeof payload.delta.stop_reason !== "string"
        )
          throw new Error("Anthropic SSE stop_reason is invalid");
        stopReason = payload.delta.stop_reason;
        mergeUsage(usage, payload.usage);
        break;
      }
      case "message_stop":
        stopped = true;
        break stream;
      case "ping":
        break;
      case "error":
        throw new ModelHostFailureError(
          "Anthropic SSE returned an explicit error",
        );
      default:
        // Anthropic may add top-level event types. Unknown events do not alter
        // the content blocks that form the final continuation.
        break;
    }
  }

  if (!started || !stopped)
    throw new Error("Anthropic SSE ended before a complete response");
  const content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (!block.stopped)
        throw new Error("Anthropic SSE content block did not end");
      return block.value;
    });
  const text = content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
  const reasoningContent = content
    .flatMap((block) =>
      block.type === "thinking" && typeof block.thinking === "string"
        ? [block.thinking]
        : [],
    )
    .join("");
  const toolCalls = content.flatMap((block) => {
    if (block.type !== "tool_use") return [];
    if (
      typeof block.id !== "string" ||
      block.id === "" ||
      typeof block.name !== "string" ||
      block.name === "" ||
      !isRecord(block.input)
    )
      throw new Error("Anthropic SSE tool call is incomplete");
    return [{ id: block.id, name: block.name, arguments: block.input }];
  });
  return {
    content,
    text,
    reasoningContent,
    toolCalls,
    usage,
    ...(responseId === undefined ? {} : { responseId }),
    ...(model === undefined ? {} : { model }),
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

export async function aggregateResponsesModelStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: ModelHostDeltaSink,
): Promise<Record<string, unknown>> {
  let completed: Record<string, unknown> | null = null;
  for await (const event of modelHostEvents(body)) {
    const payload = streamRecord(event.data);
    if (typeof payload.type !== "string")
      throw new Error("Responses SSE type is invalid");
    if (event.event !== null && event.event !== payload.type)
      throw new Error("Responses SSE event and payload type do not match");
    if (
      (payload.type === "response.output_text.delta" ||
        payload.type === "response.reasoning_text.delta" ||
        payload.type === "response.reasoning_summary_text.delta" ||
        payload.type === "response.function_call_arguments.delta") &&
      typeof payload.delta !== "string"
    )
      throw new Error("Responses SSE delta is invalid");
    if (payload.type === "response.output_text.delta" && payload.delta !== "")
      onDelta?.({ kind: "text", text: payload.delta as string });
    else if (
      (payload.type === "response.reasoning_text.delta" ||
        payload.type === "response.reasoning_summary_text.delta") &&
      payload.delta !== ""
    )
      onDelta?.({ kind: "reasoning", text: payload.delta as string });
    else if (
      payload.type === "response.function_call_arguments.delta" &&
      payload.delta !== ""
    )
      onDelta?.({ kind: "tool", text: payload.delta as string });
    else if (payload.type === "response.completed") {
      if (completed !== null || !isRecord(payload.response))
        throw new Error("Responses SSE completed event is invalid");
      if (
        payload.response.status !== undefined &&
        payload.response.status !== "completed"
      )
        throw new Error("Responses SSE completed response status is invalid");
      completed = structuredClone(payload.response);
      break;
    } else if (
      payload.type === "response.failed" ||
      payload.type === "response.incomplete" ||
      payload.type === "response.cancelled" ||
      payload.type === "error"
    ) {
      throw new ModelHostFailureError(
        "Responses SSE returned an explicit failure",
      );
    }
  }
  if (completed === null)
    throw new Error("Responses SSE ended before response.completed");
  return completed;
}

function modelHostEvents(body: ReadableStream<Uint8Array>) {
  return providerStreamEvents(body);
}

function streamRecord(data: string): Record<string, unknown> {
  const value = parseStreamJson(data);
  if (!isRecord(value)) throw new Error("Provider SSE data is not an object");
  return value;
}

function parseStreamJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("Provider SSE data is not valid JSON");
  }
}

function streamIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Provider SSE content index is invalid");
  return value as number;
}

function appendBlockString(
  block: Record<string, unknown>,
  field: string,
  delta: string,
  expectedType: string,
): void {
  if (block.type !== expectedType || typeof block[field] !== "string")
    throw new Error("Anthropic SSE content block does not match its delta");
  block[field] += delta;
}

function mergeUsage(target: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const field of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    if (value[field] !== undefined) target[field] = value[field];
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
