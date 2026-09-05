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
): value is AuthoringRequestSnapshot[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  let previous = -1;
  return value.every((raw: unknown) => {
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
      !validPrompt(item.bootstrap) ||
      !isPlayPresetBinding(item.playPreset)
    )
      return false;
    ids.add(item.requestId);
    previous = item.modelItemStart as number;
    return true;
  });
}
