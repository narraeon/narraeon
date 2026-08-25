import type { SettingAuthorDelta } from "../setting/DocumentCandidateSettingImprovement.ts";

import { providerStreamEvents, providerStreamJson } from "./ProviderStream.ts";

/**
 * Aggregated shape of one streamed author exchange.
 *
 * Streaming exists for observability, not for a different result: callers still
 * receive one complete response. What changes is that the caller learns the
 * exchange is alive while it is being produced, which a single awaited POST
 * cannot express — a long reasoning trace and a hung socket look identical.
 */
export interface SettingStreamResult {
  content: string;
  reasoningContent: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: unknown;
}

export type SettingDeltaSink = (delta: SettingAuthorDelta) => void;

export async function aggregateChatSettingStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: SettingDeltaSink,
): Promise<SettingStreamResult> {
  let content = "";
  let reasoningContent = "";
  let usage: unknown = null;
  // Tool calls arrive as fragments keyed by index; id and name usually only
  // appear on the first fragment, while arguments accumulate across many.
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const event of providerStreamEvents(body)) {
    const payload = providerStreamJson(event.data);
    if (!isRecord(payload)) continue;
    if (isRecord(payload.usage)) usage = payload.usage;
    const choices: unknown[] = Array.isArray(payload.choices)
      ? payload.choices
      : [];
    const choice: unknown = choices[0];
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const { delta } = choice;
    if (typeof delta.content === "string" && delta.content !== "") {
      content += delta.content;
      onDelta?.({ kind: "text", text: delta.content });
    }
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content !== ""
    ) {
      reasoningContent += delta.reasoning_content;
      onDelta?.({ kind: "reasoning", text: delta.reasoning_content });
    }
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const [position, fragment] of delta.tool_calls.entries()) {
      if (!isRecord(fragment)) continue;
      const index =
        typeof fragment.index === "number" ? fragment.index : position;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id !== "")
        current.id = fragment.id;
      const call = isRecord(fragment.function) ? fragment.function : {};
      if (typeof call.name === "string" && call.name !== "")
        current.name = call.name;
      if (typeof call.arguments === "string" && call.arguments !== "") {
        current.arguments += call.arguments;
        onDelta?.({ kind: "tool", text: call.arguments });
      }
      calls.set(index, current);
    }
  }
  return {
    content,
    reasoningContent,
    toolCalls: [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
    usage,
  };
}

export async function aggregateAnthropicSettingStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: SettingDeltaSink,
): Promise<SettingStreamResult> {
  let content = "";
  let reasoningContent = "";
  let inputTokens: unknown;
  let outputTokens: unknown;
  // Anthropic streams one block at a time, so the open block's index decides
  // which accumulator a delta belongs to.
  const blocks = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const event of providerStreamEvents(body)) {
    const payload = providerStreamJson(event.data);
    if (!isRecord(payload)) continue;
    if (isRecord(payload.message) && isRecord(payload.message.usage))
      inputTokens = payload.message.usage.input_tokens;
    if (isRecord(payload.usage) && payload.usage.output_tokens !== undefined)
      outputTokens = payload.usage.output_tokens;
    const index = typeof payload.index === "number" ? payload.index : -1;
    if (payload.type === "content_block_start") {
      const block = isRecord(payload.content_block)
        ? payload.content_block
        : {};
      if (block.type === "tool_use")
        blocks.set(index, {
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          arguments: "",
        });
      continue;
    }
    if (payload.type !== "content_block_delta" || !isRecord(payload.delta))
      continue;
    const { delta } = payload;
    if (typeof delta.text === "string" && delta.text !== "") {
      content += delta.text;
      onDelta?.({ kind: "text", text: delta.text });
    }
    if (typeof delta.thinking === "string" && delta.thinking !== "") {
      reasoningContent += delta.thinking;
      onDelta?.({ kind: "reasoning", text: delta.thinking });
    }
    if (typeof delta.partial_json === "string" && delta.partial_json !== "") {
      const current = blocks.get(index);
      if (current !== undefined) {
        current.arguments += delta.partial_json;
        onDelta?.({ kind: "tool", text: delta.partial_json });
      }
    }
  }
  return {
    content,
    reasoningContent,
    toolCalls: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
