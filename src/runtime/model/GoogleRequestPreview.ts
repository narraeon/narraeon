import { isGoogleThinkingLevel } from "../../protocol/modelConnections.ts";
import type { GoogleHopEvidence, ModelHostWireRequest } from "./ModelHost.ts";

export function withGoogleHop(
  wire: ModelHostWireRequest,
  hop: GoogleHopEvidence,
): ModelHostWireRequest {
  const hops = [...(wire.googleHops ?? [])];
  const index = hops.findIndex(
    (old) =>
      old.exchange === hop.exchange &&
      old.attempt === hop.attempt &&
      old.hop === hop.hop,
  );
  if (index < 0) hops.push(structuredClone(hop));
  else hops[index] = structuredClone(hop);
  const updated = { ...wire, googleHops: hops };
  if (!isSafeGoogleWireRequest(updated))
    throw new Error("Unsafe Google hop evidence");
  return updated;
}

export function isSafeGoogleWireRequest(
  value: unknown,
): value is ModelHostWireRequest {
  return validWireRequest(value, true);
}

function validWireRequest(value: unknown, allowHops: boolean): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        "provider",
        "method",
        "endpointPath",
        "headerNames",
        "body",
        "systemInstructionSources",
        "redactedProviderContinuation",
        ...(allowHops ? ["googleHops"] : []),
      ].includes(key),
    ) &&
    record.provider === "google_interactions" &&
    record.redactedProviderContinuation === true &&
    record.method === "POST" &&
    typeof record.endpointPath === "string" &&
    (record.endpointPath === "" ||
      /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]*\/)?interactions$/u.test(
        record.endpointPath,
      )) &&
    Array.isArray(record.headerNames) &&
    (record.headerNames.length === 3 ||
      (record.headerNames.length === 4 &&
        record.headerNames[3] === "X-Session-Id")) &&
    record.headerNames[0] === "Accept" &&
    record.headerNames[1] === "x-goog-api-key" &&
    record.headerNames[2] === "Content-Type" &&
    validGooglePreviewBody(record.body) &&
    (record.googleHops === undefined ||
      (allowHops &&
        Array.isArray(record.googleHops) &&
        record.googleHops.every((hop: unknown) =>
          validHop(hop, record.endpointPath as string),
        ))) &&
    (record.systemInstructionSources === undefined ||
      (Array.isArray(record.systemInstructionSources) &&
        record.systemInstructionSources.every(
          (source: unknown) =>
            typeof source === "object" &&
            source !== null &&
            !Array.isArray(source) &&
            Object.keys(source).every(
              (key) => key === "promptId" || key === "sources",
            ) &&
            (!("promptId" in source) || typeof source.promptId === "string") &&
            "sources" in source &&
            Array.isArray(source.sources) &&
            source.sources.every((item: unknown) => typeof item === "string"),
        )))
  );
}

export function isSafeGoogleHop(value: unknown): value is GoogleHopEvidence {
  return validHop(value);
}

function validHop(value: unknown, endpointPath?: string): boolean {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "exchange",
        "attempt",
        "hop",
        "tokenSupplied",
        "status",
        "httpStatus",
        "usage",
        "request",
      ].includes(key),
    )
  )
    return false;
  return (
    Number.isSafeInteger(value.exchange) &&
    Number(value.exchange) > 0 &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0 &&
    Number.isSafeInteger(value.hop) &&
    Number(value.hop) > 0 &&
    typeof value.tokenSupplied === "boolean" &&
    [
      "attempted",
      "completed",
      "requires_action",
      "requires_continuation",
      "failed",
      "cancelled",
      "incomplete",
      "interrupted",
      "rejected",
    ].includes(String(value.status)) &&
    (value.httpStatus === undefined ||
      (Number.isSafeInteger(value.httpStatus) &&
        Number(value.httpStatus) >= 100 &&
        Number(value.httpStatus) <= 599)) &&
    (value.usage === undefined ||
      (isRecord(value.usage) &&
        Object.entries(value.usage).every(
          ([key, count]) =>
            [
              "total_input_tokens",
              "total_cached_tokens",
              "total_thought_tokens",
              "total_output_tokens",
              "total_tool_use_tokens",
              "total_tokens",
            ].includes(key) &&
            Number.isSafeInteger(count) &&
            Number(count) >= 0,
        ))) &&
    (value.request === undefined
      ? Number(value.hop) > 1
      : validWireRequest(value.request, false) &&
        isRecord(value.request) &&
        (endpointPath === undefined ||
          value.request.endpointPath === endpointPath))
  );
}

function validGooglePreviewBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const body = value as Record<string, unknown>;
  if (
    !Object.keys(body).every((key) =>
      [
        "model",
        "store",
        "stream",
        "system_instruction",
        "input",
        "tools",
        "generation_config",
      ].includes(key),
    ) ||
    typeof body.model !== "string" ||
    body.store !== false ||
    body.stream !== true ||
    (body.system_instruction !== undefined &&
      typeof body.system_instruction !== "string") ||
    !Array.isArray(body.input) ||
    !isRecord(body.generation_config)
  )
    return false;
  if (!validGoogleGenerationConfig(body.generation_config)) return false;
  if (!body.input.every(validGooglePreviewItem)) return false;
  return (
    body.tools === undefined ||
    (Array.isArray(body.tools) &&
      body.tools.every(
        (tool: unknown) =>
          isRecord(tool) &&
          Object.keys(tool).every((key) =>
            ["type", "name", "description", "parameters"].includes(key),
          ) &&
          tool.type === "function" &&
          typeof tool.name === "string" &&
          typeof tool.description === "string" &&
          isRecord(tool.parameters),
      ))
  );
}

function validGoogleGenerationConfig(config: Record<string, unknown>): boolean {
  if (
    !Object.keys(config).every((key) =>
      [
        "max_output_tokens",
        "tool_choice",
        "thinking_level",
        "thinking_summaries",
        "thinking",
        "thinking_budget",
      ].includes(key),
    )
  )
    return false;
  if (
    typeof config.max_output_tokens !== "number" ||
    !validGoogleToolChoice(config.tool_choice)
  )
    return false;
  if (
    config.thinking_summaries !== undefined &&
    config.thinking_summaries !== "auto" &&
    config.thinking_summaries !== "none"
  )
    return false;
  if (
    config.thinking_level !== undefined &&
    !isGoogleThinkingLevel(config.thinking_level)
  )
    return false;
  if (config.thinking === undefined && config.thinking_budget === undefined)
    return true;
  if (config.thinking_level !== undefined) return false;
  let budget = config.thinking_budget;
  if (config.thinking !== undefined) {
    if (
      budget !== undefined ||
      !isRecord(config.thinking) ||
      Object.keys(config.thinking).length !== 1
    )
      return false;
    budget = config.thinking.thinking_budget;
  }
  return (
    typeof budget === "number" && Number.isSafeInteger(budget) && budget >= -1
  );
}

function validGoogleToolChoice(value: unknown): boolean {
  if (value === undefined || value === "none") return true;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !isRecord(value.allowed_tools)
  )
    return false;
  const allowed = value.allowed_tools;
  return (
    Object.keys(allowed).every((key) => key === "mode" || key === "tools") &&
    allowed.mode === "auto" &&
    Array.isArray(allowed.tools) &&
    allowed.tools.every((name: unknown) => typeof name === "string")
  );
}

function validGooglePreviewItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "runtime_redacted_provider_step")
    return Object.keys(value).length === 1;
  if (value.type === "user_input" || value.type === "model_output")
    return (
      Object.keys(value).every((key) => key === "type" || key === "content") &&
      validTextParts(value.content)
    );
  if (value.type === "function_call")
    return (
      Object.keys(value).every((key) =>
        ["type", "id", "name", "arguments"].includes(key),
      ) &&
      typeof value.id === "string" &&
      value.name === "runtime_load_context" &&
      isRecord(value.arguments) &&
      Object.keys(value.arguments).length === 0
    );
  if (value.type === "function_result")
    return (
      Object.keys(value).every((key) =>
        ["type", "call_id", "name", "result", "is_error"].includes(key),
      ) &&
      typeof value.call_id === "string" &&
      typeof value.name === "string" &&
      validTextParts(value.result) &&
      (value.is_error === undefined || value.is_error === true)
    );
  return false;
}

function validTextParts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (part: unknown) =>
        isRecord(part) &&
        Object.keys(part).length === 2 &&
        part.type === "text" &&
        typeof part.text === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
