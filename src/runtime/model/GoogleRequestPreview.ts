import type { ModelHostWireRequest } from "./ModelHost.ts";

export function isSafeGoogleWireRequest(
  value: unknown,
): value is ModelHostWireRequest {
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
      ].includes(key),
    ) &&
    record.provider === "google_interactions" &&
    record.redactedProviderContinuation === true &&
    record.method === "POST" &&
    typeof record.endpointPath === "string" &&
    Array.isArray(record.headerNames) &&
    record.headerNames.every((name) => typeof name === "string") &&
    validGooglePreviewBody(record.body) &&
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
  if (
    !Object.keys(body.generation_config).every(
      (key) => key === "max_output_tokens" || key === "tool_choice",
    ) ||
    typeof body.generation_config.max_output_tokens !== "number" ||
    (body.generation_config.tool_choice !== undefined &&
      body.generation_config.tool_choice !== "none")
  )
    return false;
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
      typeof value.name === "string" &&
      isRecord(value.arguments)
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
