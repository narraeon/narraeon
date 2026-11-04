import {
  isPlayPresetBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import type { ModelHostWireRequest } from "../model/ModelHost.ts";

/**
 * Documents the Runtime preloaded into one send's bootstrap. They count as
 * completely read only at this exact tree revision.
 */
export interface AuthoringPreloadRecord {
  revision: string;
  worldDocumentIds: string[];
  opaquePaths: string[];
}

/** One immutable configuration per user send, retained alongside original bootstrap evidence. */
export interface AuthoringRequestSnapshot {
  requestId: string;
  modelItemStart: number;
  bootstrap: PromptCompilation;
  playPreset: PlayPresetBinding;
  preload?: AuthoringPreloadRecord;
  wireRequest?: ModelHostWireRequest;
}

function validWireRequest(value: unknown): value is ModelHostWireRequest {
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

export function isAuthoringPreloadRecord(
  value: unknown,
): value is AuthoringPreloadRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.revision === "string" &&
    Array.isArray(record.worldDocumentIds) &&
    record.worldDocumentIds.every((id) => typeof id === "string") &&
    Array.isArray(record.opaquePaths) &&
    record.opaquePaths.every((path) => typeof path === "string")
  );
}

export function validAuthoringRequests(
  value: unknown,
  validPrompt: (value: unknown) => boolean,
  session: {
    modelItems: unknown;
    activeRequestId: unknown;
    completedRequestIds: unknown;
  },
): value is AuthoringRequestSnapshot[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !Array.isArray(session.modelItems) ||
    !Array.isArray(session.completedRequestIds)
  )
    return false;
  const items: unknown[] = session.modelItems;
  const completed: unknown[] = session.completedRequestIds;
  const ids = new Set<string>();
  let previous = -1;
  let lastRequestId: unknown;
  const valid = value.every((raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return false;
    const item = raw as Record<string, unknown>;
    if (
      !Object.keys(item).every((key) =>
        [
          "requestId",
          "modelItemStart",
          "bootstrap",
          "playPreset",
          "preload",
          "wireRequest",
        ].includes(key),
      ) ||
      (item.preload !== undefined && !isAuthoringPreloadRecord(item.preload)) ||
      (item.wireRequest !== undefined && !validWireRequest(item.wireRequest)) ||
      typeof item.requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(item.requestId) ||
      ids.has(item.requestId) ||
      !Number.isSafeInteger(item.modelItemStart) ||
      (item.modelItemStart as number) <= previous ||
      !(
        item.requestId === session.activeRequestId ||
        completed.includes(item.requestId)
      ) ||
      !isUserItem(items[item.modelItemStart as number]) ||
      !validPrompt(item.bootstrap) ||
      !isPlayPresetBinding(item.playPreset)
    )
      return false;
    ids.add(item.requestId);
    lastRequestId = item.requestId;
    previous = item.modelItemStart as number;
    return true;
  });
  return (
    valid &&
    (session.activeRequestId === null ||
      lastRequestId === session.activeRequestId)
  );
}

function isUserItem(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "user"
  );
}

export function authoringRequestPreviews(session: {
  creationRequestId: string;
  bootstrap: PromptCompilation;
  requests?: AuthoringRequestSnapshot[];
}) {
  const requests = session.requests ?? [];
  const legacy = requests.length === 0 || requests[0]!.modelItemStart > 0;
  return [
    ...(legacy
      ? [
          {
            requestId: session.creationRequestId,
            compilation: structuredClone(session.bootstrap),
            legacyBootstrap: true,
          },
        ]
      : []),
    ...requests.map(({ requestId, bootstrap, wireRequest }) => ({
      requestId,
      compilation: structuredClone(bootstrap),
      ...(wireRequest === undefined
        ? {}
        : { wireRequest: structuredClone(wireRequest) }),
      legacyBootstrap: false,
    })),
  ];
}
