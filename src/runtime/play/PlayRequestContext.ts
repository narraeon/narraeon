import { modelHostInputText } from "../model/ModelHost.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PlayRequestContextMessage } from "../../protocol/playRequestContext.ts";
import type {
  ModelHostAppendItem,
  ModelHostExchange,
} from "../model/ModelHost.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

/** Small dispatch boundary; large immutable prompt and transcript stay shared. */
export interface PlayRequestContextEvidence {
  version: 1;
  exchange: number;
  attempt: number;
  transcriptCount: number;
  transcriptDigest: string;
  bootstrapDigest: string;
  toolsDigest: string;
  suffix: { kind: "runtime_notice"; notice: "turn_guide"; text: string }[];
}

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function captureRequestContext(
  request: ModelHostExchange,
  transcript: ModelHostAppendItem[],
  attempt: number,
): PlayRequestContextEvidence | null {
  if (
    !isDeepStrictEqual(request.appended.slice(0, transcript.length), transcript)
  )
    return null;
  const suffix = request.appended.slice(transcript.length);
  if (
    !suffix.every(
      (item) => item.kind === "runtime_notice" && item.notice === "turn_guide",
    )
  )
    return null;
  return {
    version: 1,
    exchange: request.exchange ?? 1,
    attempt,
    transcriptCount: transcript.length,
    transcriptDigest: contextDigest(transcript),
    bootstrapDigest: contextDigest(request.bootstrap),
    toolsDigest: contextDigest(request.toolUniverse ?? request.tools),
    suffix: suffix as PlayRequestContextEvidence["suffix"],
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
    typeof item.toolsDigest === "string" &&
    Array.isArray(item.suffix) &&
    item.suffix.every(
      (suffix) =>
        suffix?.kind === "runtime_notice" &&
        suffix.notice === "turn_guide" &&
        typeof suffix.text === "string",
    )
  );
}

/** Explicit allowlist projection excludes signatures, tokens and raw provider state. */
export function projectRequestContext(
  bootstrap: PromptCompilation,
  appended: ModelHostAppendItem[],
  tools = bootstrap.toolUniverse,
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
  if (bootstrap.provider.preload !== undefined)
    messages.push({
      role: "tool · runtime_load_context",
      text: bootstrap.provider.preload.markdown,
    });
  appendPrompts(
    bootstrap.logicalMessages.filter(({ role }) => role === "player_input"),
  );
  for (const item of appended) {
    switch (item.kind) {
      case "prompt_delta":
        appendPrompts(item.logicalMessages);
        break;
      case "assistant":
        messages.push({ role: "assistant", text: item.text });
        for (const call of item.toolCalls)
          messages.push({
            role: `assistant · ${call.name} · ${call.id}`,
            text: JSON.stringify(call.arguments, null, 2) ?? "",
          });
        break;
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
  messages.push({ role: "tools", text: JSON.stringify(tools, null, 2) });
  return messages;
}
