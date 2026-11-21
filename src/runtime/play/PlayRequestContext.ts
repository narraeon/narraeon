import { continuationPrompt } from "../model/AssistantPrefill.ts";
import {
  modelHostInputText,
  worldRevisionSystemBoundaryText,
  worldRevisionTransitionText,
} from "../model/ModelHost.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PlayRequestContextMessage } from "../../protocol/playRequestContext.ts";
import type {
  ModelHostAppendItem,
  ModelHostExchange,
} from "../model/ModelHost.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

interface ContinuationMessage {
  role: "assistant · prefill" | "user · continuation";
  text: string;
}

export function continuationMessage(
  partial: ModelHostExchange["assistantPrefill"],
): ContinuationMessage | undefined {
  if (!partial) return undefined;
  return partial.mode === "prompt"
    ? { role: "user · continuation", text: continuationPrompt(partial.text) }
    : { role: "assistant · prefill", text: partial.text };
}

/** Small dispatch boundary; large immutable prompt and transcript stay shared. */
export interface PlayRequestContextEvidence {
  version: 1;
  exchange: number;
  attempt: number;
  transcriptCount: number;
  transcriptDigest: string;
  bootstrapDigest: string;
  logicalBootstrapDigest?: string;
  followupPromptDigest?: string;
  toolsDigest: string;
  continuation?: ContinuationMessage;
  suffix: {
    kind: "runtime_notice";
    notice: "turn_guide" | "response_correction";
    text: string;
  }[];
}

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function logicalBootstrapDigest(bootstrap: PromptCompilation): string {
  return contextDigest([
    bootstrap.logicalMessages,
    bootstrap.provider.preload?.markdown,
  ]);
}

export function playRequestSuffix(
  request: Pick<ModelHostExchange, "appended">,
  transcript: readonly ModelHostAppendItem[],
  includeFollowupPrompt = false,
) {
  if (
    !isDeepStrictEqual(request.appended.slice(0, transcript.length), transcript)
  )
    return null;
  const suffix = request.appended.slice(transcript.length);
  const followupPrompt = includeFollowupPrompt ? suffix.pop() : undefined;
  if (includeFollowupPrompt && followupPrompt?.kind !== "prompt_delta")
    return null;
  if (
    !suffix.every(
      (item): item is PlayRequestContextEvidence["suffix"][number] =>
        item.kind === "runtime_notice" &&
        (item.notice === "turn_guide" || item.notice === "response_correction"),
    )
  )
    return null;
  return { suffix, followupPrompt };
}

export function captureRequestContext(
  request: ModelHostExchange,
  transcript: ModelHostAppendItem[],
  attempt: number,
  includeFollowupPrompt = false,
): PlayRequestContextEvidence | null {
  const boundary = playRequestSuffix(
    request,
    transcript,
    includeFollowupPrompt,
  );
  if (boundary === null) return null;
  const { suffix, followupPrompt } = boundary;
  return {
    version: 1,
    exchange: request.exchange ?? 1,
    attempt,
    transcriptCount: transcript.length,
    transcriptDigest: contextDigest(transcript),
    bootstrapDigest: contextDigest(request.bootstrap),
    logicalBootstrapDigest: logicalBootstrapDigest(request.bootstrap),
    ...(followupPrompt?.kind === "prompt_delta"
      ? { followupPromptDigest: contextDigest(followupPrompt.logicalMessages) }
      : {}),
    toolsDigest: contextDigest(request.toolUniverse ?? request.tools),
    ...(request.assistantPrefill === undefined
      ? {}
      : { continuation: continuationMessage(request.assistantPrefill)! }),
    // History displays the logical guide once, independent of its wire placement.
    suffix: suffix.map(({ kind, notice, text }) => ({ kind, notice, text })),
  };
}

export function validRequestContextEvidence(
  value: unknown,
): value is PlayRequestContextEvidence {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PlayRequestContextEvidence>;
  return (
    item.version === 1 &&
    Number.isSafeInteger(item.exchange) &&
    Number(item.exchange) > 0 &&
    Number.isSafeInteger(item.attempt) &&
    Number(item.attempt) > 0 &&
    Number.isSafeInteger(item.transcriptCount) &&
    Number(item.transcriptCount) >= 0 &&
    typeof item.transcriptDigest === "string" &&
    typeof item.bootstrapDigest === "string" &&
    (item.logicalBootstrapDigest === undefined ||
      typeof item.logicalBootstrapDigest === "string") &&
    typeof item.toolsDigest === "string" &&
    (item.followupPromptDigest === undefined ||
      typeof item.followupPromptDigest === "string") &&
    (item.continuation === undefined ||
      (item.continuation !== null &&
        (item.continuation.role === "user · continuation" ||
          item.continuation.role === "assistant · prefill") &&
        typeof item.continuation.text === "string")) &&
    Array.isArray(item.suffix) &&
    item.suffix.every(
      (suffix) =>
        suffix?.kind === "runtime_notice" &&
        (suffix.notice === "turn_guide" ||
          suffix.notice === "response_correction") &&
        typeof suffix.text === "string",
    )
  );
}

/** Explicit allowlist projection excludes signatures, tokens and raw provider state. */
export function projectRequestContext(
  bootstrap: PromptCompilation,
  appended: ModelHostAppendItem[],
  tools = bootstrap.toolUniverse,
  continuation?: ContinuationMessage,
  boundaries?: ModelHostExchange["worldRevisionBoundaries"],
): PlayRequestContextMessage[] {
  const messages: PlayRequestContextMessage[] = [];
  const appendPrompts = (prompts: PromptCompilation["logicalMessages"]) => {
    for (const message of prompts) {
      if (
        message.role === "world_context" &&
        bootstrap.provider.preload !== undefined
      )
        continue;
      const role =
        message.messageRole ??
        (message.role === "player_input"
          ? "user"
          : message.role === "assistant"
            ? "assistant"
            : message.role === "tool"
              ? "tool"
              : "system");
      messages.push({
        role: `${role} · ${message.role}`,
        text: message.markdown,
      });
    }
  };
  appendPrompts(
    bootstrap.logicalMessages.filter(({ role }) => role !== "player_input"),
  );
  const currentBoundary = boundaries?.entries.findLast(
    ({ epochId }) => epochId === boundaries.currentEpochId,
  );
  if (currentBoundary !== undefined)
    messages.push({
      role: "system · world_revision_epoch",
      text: worldRevisionSystemBoundaryText(currentBoundary),
    });
  if (bootstrap.provider.preload !== undefined)
    messages.push({
      role: "tool · runtime_load_context",
      text: bootstrap.provider.preload.markdown,
    });
  appendPrompts(
    bootstrap.logicalMessages.filter(({ role }) => role === "player_input"),
  );
  for (const [index, item] of appended.entries()) {
    const boundary = boundaries?.entries.find(
      ({ itemIndex }) => itemIndex === index,
    );
    if (item.kind === "prompt_delta" && boundary !== undefined) {
      messages.push({
        role: "user · world_revision_epoch",
        text: worldRevisionTransitionText(boundary.markdown),
      });
      continue;
    }
    switch (item.kind) {
      case "prompt_delta":
        appendPrompts(item.logicalMessages);
        break;
      case "assistant": {
        const prefix = item.providerState?.continuedPrefixLength ?? 0;
        if (prefix > 0)
          messages.push({
            role: "user · continuation",
            text: continuationPrompt(item.text.slice(0, prefix)),
          });
        messages.push({ role: "assistant", text: item.text.slice(prefix) });
        for (const call of item.toolCalls)
          messages.push({
            role: `assistant · ${call.name} · ${call.id}`,
            text: JSON.stringify(call.arguments, null, 2) ?? "",
          });
        break;
      }
      case "tool":
        messages.push({
          role: `tool · ${item.toolCallId}`,
          text: item.markdown,
        });
        break;
      case "runtime_notice":
        messages.push({ role: `user · ${item.notice}`, text: item.text });
        break;
      case "player":
      case "user":
        messages.push({ role: "user", text: modelHostInputText(item) });
        break;
    }
  }
  if (continuation !== undefined) messages.push(continuation);
  messages.push({ role: "tools", text: JSON.stringify(tools, null, 2) });
  return messages;
}
