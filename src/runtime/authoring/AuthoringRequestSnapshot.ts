import {
  isPlayPresetBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import type {
  ModelHostBinding,
  ModelHostWireRequest,
} from "../model/ModelHost.ts";
import { isSafeGoogleWireRequest } from "../model/GoogleRequestPreview.ts";

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
  modelBinding?: ModelHostBinding;
  retryAttempts?: {
    requestId: string;
    compilation: PromptCompilation;
    wireRequest?: ModelHostWireRequest;
    modelBinding: ModelHostBinding;
  }[];
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
    extended?: boolean;
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
      (!session.extended &&
        (item.modelBinding !== undefined ||
          item.retryAttempts !== undefined)) ||
      !Object.keys(item).every((key) =>
        [
          "requestId",
          "modelItemStart",
          "bootstrap",
          "playPreset",
          "preload",
          "wireRequest",
          "retryAttempts",
          "modelBinding",
        ].includes(key),
      ) ||
      (item.modelBinding !== undefined && !isBinding(item.modelBinding)) ||
      (item.retryAttempts !== undefined &&
        (!Array.isArray(item.retryAttempts) ||
          !item.retryAttempts.every(
            (attempt: unknown) =>
              typeof attempt === "object" &&
              attempt !== null &&
              "requestId" in attempt &&
              typeof attempt.requestId === "string" &&
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(attempt.requestId) &&
              Object.keys(attempt).every((key) =>
                [
                  "requestId",
                  "compilation",
                  "modelBinding",
                  "wireRequest",
                ].includes(key),
              ) &&
              "compilation" in attempt &&
              validPrompt(attempt.compilation) &&
              "modelBinding" in attempt &&
              isBinding(attempt.modelBinding) &&
              (!("wireRequest" in attempt) ||
                isSafeGoogleWireRequest(attempt.wireRequest)),
          ) ||
          new Set(
            item.retryAttempts.map(
              (attempt: { requestId: string }) => attempt.requestId,
            ),
          ).size !== item.retryAttempts.length)) ||
      (item.preload !== undefined && !isAuthoringPreloadRecord(item.preload)) ||
      (item.wireRequest !== undefined &&
        !isSafeGoogleWireRequest(item.wireRequest)) ||
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
    if (Array.isArray(item.retryAttempts)) {
      for (const attempt of item.retryAttempts as { requestId: string }[]) {
        if (ids.has(attempt.requestId)) return false;
        ids.add(attempt.requestId);
      }
    }
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

function isBinding(value: unknown): value is ModelHostBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const b = value as Record<string, unknown>;
  return (
    Object.keys(b).every((key) =>
      [
        "provider",
        "endpointFingerprint",
        "modelId",
        "contextWindowTokens",
        "maxOutputTokens",
        "protocolConfigFingerprint",
        "cacheStrategy",
      ].includes(key),
    ) &&
    [
      "chat_completions",
      "openai_responses",
      "anthropic_messages",
      "google_interactions",
    ].includes(String(b.provider)) &&
    typeof b.endpointFingerprint === "string" &&
    typeof b.modelId === "string" &&
    typeof b.protocolConfigFingerprint === "string" &&
    Number.isSafeInteger(b.contextWindowTokens) &&
    Number(b.contextWindowTokens) >= 0 &&
    Number.isSafeInteger(b.maxOutputTokens) &&
    Number(b.maxOutputTokens) >= 0 &&
    (b.cacheStrategy === undefined ||
      (typeof b.cacheStrategy === "string" &&
        [
          "provider_managed",
          "explicit_anthropic_blocks",
          "explicit_cliproxyapi_message",
        ].includes(b.cacheStrategy)))
  );
}

export function authoringActiveBinding(session: {
  modelBinding: ModelHostBinding;
  requests?: AuthoringRequestSnapshot[];
}): ModelHostBinding {
  const request = session.requests?.at(-1);
  return (
    request?.retryAttempts?.at(-1)?.modelBinding ??
    request?.modelBinding ??
    session.modelBinding
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
    ...requests.flatMap(
      ({ requestId, bootstrap, wireRequest, retryAttempts }) => [
        {
          requestId,
          compilation: structuredClone(bootstrap),
          ...(wireRequest === undefined
            ? {}
            : { wireRequest: structuredClone(wireRequest) }),
          legacyBootstrap: false,
        },
        ...(retryAttempts ?? []).map((attempt) => ({
          requestId: attempt.requestId,
          compilation: structuredClone(attempt.compilation),
          ...(attempt.wireRequest === undefined
            ? {}
            : { wireRequest: structuredClone(attempt.wireRequest) }),
          legacyBootstrap: false,
        })),
      ],
    ),
  ];
}
