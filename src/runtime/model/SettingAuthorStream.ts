import type { SettingAuthorDelta } from "../setting/DocumentCandidateSettingImprovement.ts";

import {
  aggregateAnthropicModelStream,
  aggregateChatModelStream,
} from "./ModelHostStream.ts";

/**
 * Setting improvement and play must decode one protocol in exactly the same
 * way. The setting surface gets its own projection type, but never its own
 * lossy SSE parser.
 */
export interface ChatSettingStreamResult {
  content: string;
  reasoningContent: string;
  assistantMessage: Record<string, unknown>;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: unknown;
}

export interface AnthropicSettingStreamResult {
  content: string;
  reasoningContent: string;
  providerContent: Record<string, unknown>[];
  toolCalls: { id: string; name: string; arguments: unknown }[];
  usage: unknown;
  responseId?: string;
  model?: string;
  stopReason?: string | null;
}

export type SettingStreamResult =
  ChatSettingStreamResult | AnthropicSettingStreamResult;

export type SettingDeltaSink = (delta: SettingAuthorDelta) => void;

export function aggregateChatSettingStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: SettingDeltaSink,
): Promise<ChatSettingStreamResult> {
  return aggregateChatModelStream(body, onDelta);
}

export async function aggregateAnthropicSettingStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: SettingDeltaSink,
): Promise<AnthropicSettingStreamResult> {
  const result = await aggregateAnthropicModelStream(body, onDelta);
  return {
    content: result.text,
    reasoningContent: result.reasoningContent,
    providerContent: result.content,
    toolCalls: result.toolCalls,
    usage: result.usage,
    ...(result.responseId === undefined
      ? {}
      : { responseId: result.responseId }),
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.stopReason === undefined
      ? {}
      : { stopReason: result.stopReason }),
  };
}
