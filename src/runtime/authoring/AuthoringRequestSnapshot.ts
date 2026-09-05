import {
  isPlayPresetBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

/** One immutable configuration per user send, retained alongside original bootstrap evidence. */
export interface AuthoringRequestSnapshot {
  requestId: string;
  modelItemStart: number;
  bootstrap: PromptCompilation;
  playPreset: PlayPresetBinding;
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
      Object.keys(item).length !== 4 ||
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
    ...requests.map(({ requestId, bootstrap }) => ({
      requestId,
      compilation: structuredClone(bootstrap),
      legacyBootstrap: false,
    })),
  ];
}
