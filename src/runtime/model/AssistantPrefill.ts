import type { V1PlayCallChainEvent } from "../../protocol/v1.ts";
import { isDeepStrictEqual } from "node:util";
import {
  validPromptCompilation,
  validPromptTools,
} from "../prompt/PromptCompilationCodec.ts";
import type { ModelAssistantPrefillMode } from "../../protocol/modelConnections.ts";
import type {
  ModelHost,
  ModelHostExchange,
  ModelHostRequestConfig,
  ModelHostResponse,
} from "./ModelHost.ts";

export type AssistantPrefill = NonNullable<
  ModelHostExchange["assistantPrefill"]
>;

/** Capability is explicit; sharing a wire shape never establishes support. */
export function assistantPrefillMode(
  config: ModelHostRequestConfig | undefined,
): ModelAssistantPrefillMode {
  const mode = config?.assistantPrefillMode ?? "disabled";
  if (!config || mode === "disabled") return "disabled";
  if (config.provider === "chat_completions")
    return ["assistant", "prefix", "mistral_prefix", "partial"].includes(mode)
      ? mode
      : "disabled";
  if (config.provider === "openai_responses")
    return mode === "assistant" || mode === "partial" ? mode : "disabled";
  if (
    config.provider !== "anthropic_messages" ||
    mode !== "assistant" ||
    config.thinkingMode !== "disabled"
  )
    return "disabled";
  // Only known model families predating Claude 4.6. Unknown aliases fail closed.
  return /^claude-(?:(?:opus|sonnet)-4(?:-[15])?|(?:haiku-4-5)|3(?:-[57])?-(?:opus|sonnet|haiku))(?:-\d{8})?$/u.test(
    config.modelId,
  )
    ? mode
    : "disabled";
}

export function prefillFor(
  request: ModelHostExchange,
  text: string,
): AssistantPrefill | null {
  const mode = assistantPrefillMode(request.modelConfig);
  if (mode === "disabled" || text.length === 0) return null;
  // Anthropic rejects a final assistant message ending in whitespace. Do not alter it.
  if (
    request.modelConfig?.provider === "anthropic_messages" &&
    /\s$/u.test(text)
  )
    return null;
  return { text, mode };
}

export function assertAssistantPrefill(request: ModelHostExchange): void {
  const prefix = request.assistantPrefill;
  if (prefix === undefined) return;
  const supported = prefillFor(request, prefix.text);
  if (prefix.mode !== supported?.mode)
    throw new Error(
      "This request does not support exact assistant prefilling; resend or use a compatible connection.",
    );
}

export function prefillMessage(
  request: ModelHostExchange,
  anthropic = false,
): Record<string, unknown>[] {
  assertAssistantPrefill(request);
  const prefix = request.assistantPrefill;
  if (prefix === undefined) return [];
  return [
    {
      role: "assistant",
      content: anthropic ? [{ type: "text", text: prefix.text }] : prefix.text,
      ...(prefix.mode === "prefix" || prefix.mode === "mistral_prefix"
        ? { prefix: true }
        : {}),
      ...(prefix.mode === "partial" ? { partial: true } : {}),
    },
  ];
}

/** Merge only the native text of a complete response. Opaque blocks remain untouched. */
export function completeAssistantPrefill(
  request: ModelHostExchange,
  response: ModelHostResponse,
): ModelHostResponse {
  const prefix = request.assistantPrefill;
  if (prefix === undefined) return response;
  const text = response.text ?? "";
  if (prefix.mode === "mistral_prefix" && !text.startsWith(prefix.text))
    throw new Error(
      "The provider did not return the exact assistant prefix required by this connection's prefill mode.",
    );
  const combined = prefix.mode === "mistral_prefix" ? text : prefix.text + text;
  const state = structuredClone(response.providerState);
  if (state?.protocol === "chat_completions") {
    if (
      typeof state.assistantMessage !== "object" ||
      state.assistantMessage === null
    )
      throw new Error("Missing native assistant message");
    (state.assistantMessage as Record<string, unknown>).content = combined;
  } else if (state?.protocol === "anthropic_messages") {
    const part = state.content[0];
    const first =
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text"
        ? (part as Record<string, unknown>)
        : undefined;
    if (typeof first?.text === "string") first.text = prefix.text + first.text;
    else state.content.unshift({ type: "text", text: prefix.text });
  } else if (state?.protocol === "openai_responses") {
    const first = state.output[0];
    const content: unknown[] | null =
      typeof first === "object" &&
      first !== null &&
      "type" in first &&
      first.type === "message" &&
      "content" in first &&
      Array.isArray(first.content)
        ? first.content
        : null;
    const part = content?.[0];
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "output_text" &&
      "text" in part &&
      typeof part.text === "string"
    )
      part.text = prefix.text + part.text;
    else
      state.output.unshift({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: prefix.text }],
      });
  } else
    throw new Error(
      "A complete native response is required before accepting an assistant prefill.",
    );
  return { ...response, text: combined, providerState: state };
}

/** Strip Mistral's echoed prefix from deltas, while verifying every received byte. */
export function assistantPrefillDelta(
  request: ModelHostExchange,
  sink:
    | ((delta: { kind: "text" | "reasoning" | "tool"; text: string }) => void)
    | undefined,
) {
  let remaining =
    request.assistantPrefill?.mode === "mistral_prefix"
      ? request.assistantPrefill.text
      : "";
  return (delta: {
    kind: "text" | "reasoning" | "tool";
    text: string;
  }): void => {
    if (delta.kind !== "text" || remaining === "") {
      sink?.(delta);
      return;
    }
    const size = Math.min(remaining.length, delta.text.length);
    if (delta.text.slice(0, size) !== remaining.slice(0, size)) {
      sink?.({ kind: "tool", text: "" });
      throw new Error(
        "The provider's streamed assistant prefix does not match the saved text.",
      );
    }
    remaining = remaining.slice(size);
    if (delta.text.length > size)
      sink?.({ ...delta, text: delta.text.slice(size) });
  };
}

export function assertCurrentPrefillConnection(
  request: ModelHostExchange,
  host: ModelHost,
): void {
  const fresh = structuredClone(request);
  delete fresh.modelConfig;
  delete fresh.assistantPrefill;
  const current = host.freezeRequest?.(fresh)?.modelConfig;
  if (
    !current ||
    current.provider !== request.modelConfig?.provider ||
    current.modelId !== request.modelConfig.modelId ||
    assistantPrefillMode(current) !== assistantPrefillMode(request.modelConfig)
  )
    throw new Error(
      "The selected connection is incompatible with this saved assistant prefix; resend or select the original compatible connection.",
    );
}

export function playAssistantPrefill(context: {
  status: string;
  importedFromArchive?: true;
  events: V1PlayCallChainEvent[];
  lastRequest: ModelHostExchange | null;
  lastRequestAttempt: number;
}): AssistantPrefill | null {
  if (
    context.status !== "interrupted" ||
    context.importedFromArchive ||
    !context.lastRequest
  )
    return null;
  const last = context.events.findLast((event) => event.kind === "assistant");
  if (
    last?.kind !== "assistant" ||
    last.status !== "interrupted" ||
    last.responseKind !== "pending" ||
    last.exchange !== context.lastRequest.exchange ||
    last.attempt !== context.lastRequestAttempt ||
    last.reasoning !== undefined ||
    last.toolFragment !== undefined
  )
    return null;
  return prefillFor(context.lastRequest, last.text);
}

export interface PartialAuthoringResponse {
  request: ModelHostExchange;
  text: string;
  modelItemCount: number;
}

/** Validate new optional persisted recovery evidence without promoting it to native history. */
export function validPartialAuthoringResponse(
  value: unknown,
  itemCount: number,
  items?: unknown[],
): value is PartialAuthoringResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !["request", "text", "modelItemCount"].includes(key),
    ) ||
    typeof v.text !== "string" ||
    v.modelItemCount !== itemCount ||
    typeof v.request !== "object" ||
    v.request === null
  )
    return false;
  const request = v.request as ModelHostExchange;
  return (
    Object.keys(request).every((key) =>
      [
        "bootstrap",
        "toolUniverse",
        "allowedTools",
        "toolStrategy",
        "tools",
        "appended",
        "worldRevisionBoundaries",
        "requestId",
        "operationId",
        "requestAttempt",
        "exchange",
        "maxOutputTokens",
        "modelConfig",
        "assistantPrefill",
      ].includes(key),
    ) &&
    validPromptCompilation(request.bootstrap) &&
    Array.isArray(request.appended) &&
    request.appended.length === itemCount &&
    (items === undefined || isDeepStrictEqual(request.appended, items)) &&
    request.worldRevisionBoundaries === undefined &&
    validPromptTools(request.tools) &&
    (request.toolUniverse === undefined ||
      validPromptTools(request.toolUniverse)) &&
    (request.allowedTools === undefined ||
      (Array.isArray(request.allowedTools) &&
        request.allowedTools.every((name) => typeof name === "string"))) &&
    Number.isSafeInteger(request.exchange) &&
    Number(request.exchange) >= 1 &&
    typeof request.requestId === "string" &&
    Number.isSafeInteger(request.maxOutputTokens) &&
    request.maxOutputTokens > 0 &&
    validPrefillConfig(request.modelConfig) &&
    prefillFor(request, v.text) !== null
  );
}

export function canContinueAuthoringPartial(session: {
  runStatus: string;
  pendingSettlement: unknown;
  modelItems: unknown[];
  exchange: number;
  partialResponse?: PartialAuthoringResponse;
}): boolean {
  const partial = session.partialResponse;
  return (
    session.runStatus === "interrupted" &&
    session.pendingSettlement === null &&
    partial !== undefined &&
    validPartialAuthoringResponse(partial, session.modelItems.length) &&
    partial.request.exchange === session.exchange &&
    isDeepStrictEqual(partial.request.appended, session.modelItems)
  );
}

export function prepareAuthoringPartial(
  session: Parameters<typeof canContinueAuthoringPartial>[0],
  host: ModelHost,
): void {
  if (!canContinueAuthoringPartial(session))
    throw new Error(
      "This interrupted response has no supported text prefix to continue.",
    );
  const partial = session.partialResponse!;
  assertCurrentPrefillConnection(partial.request, host);
  partial.request.assistantPrefill = prefillFor(partial.request, partial.text)!;
}

function validPrefillConfig(config: unknown): config is ModelHostRequestConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config))
    return false;
  const c = config as Record<string, unknown>;
  return (
    Object.keys(c).every((key) =>
      [
        "provider",
        "modelId",
        "dialect",
        "reasoningEffort",
        "reasoningSummary",
        "thinkingMode",
        "thinkingBudgetTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "cacheSuffixBreakpoint",
        "supportsAllowedTools",
        "assistantPrefillMode",
      ].includes(key),
    ) &&
    ["chat_completions", "anthropic_messages", "openai_responses"].includes(
      String(c.provider),
    ) &&
    typeof c.modelId === "string" &&
    ["standard", "cliproxyapi"].includes(String(c.dialect)) &&
    [
      "provider_default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ].includes(String(c.reasoningEffort)) &&
    ["provider_default", "auto", "concise", "detailed", "none"].includes(
      String(c.reasoningSummary),
    ) &&
    ["provider_default", "adaptive", "enabled", "disabled"].includes(
      String(c.thinkingMode),
    ) &&
    (c.thinkingBudgetTokens === null ||
      (Number.isSafeInteger(c.thinkingBudgetTokens) &&
        Number(c.thinkingBudgetTokens) >= 0)) &&
    Number.isSafeInteger(c.contextWindowTokens) &&
    Number(c.contextWindowTokens) > 0 &&
    Number.isSafeInteger(c.maxOutputTokens) &&
    Number(c.maxOutputTokens) > 0 &&
    (c.cacheSuffixBreakpoint === undefined ||
      typeof c.cacheSuffixBreakpoint === "boolean") &&
    (c.supportsAllowedTools === undefined ||
      typeof c.supportsAllowedTools === "boolean") &&
    ["assistant", "prefix", "mistral_prefix", "partial"].includes(
      String(c.assistantPrefillMode),
    )
  );
}
