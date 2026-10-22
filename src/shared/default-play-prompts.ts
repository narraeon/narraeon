import type { AppLocale } from "../protocol/appPreferences.ts";
import { defaultPresetHostFilesForLocale } from "./default-preset-host.ts";

/**
 * The legacy v1 narrative prompt (`prompts/narrate.md`). Ordered v2 presets
 * compile the individual blocks directly; v1 presets, which list only host
 * frame blocks, receive the blocks the frame cannot express (the default
 * person, continuation, stopping, ending and output choices) concatenated into
 * one author prompt so the shipped starting points never drift apart.
 */
const legacyNarrationBlocks = [
  "person-second",
  "continue-stage",
  "stop-beat",
  "ending",
  "output",
] as const;

export function defaultNarrationPromptForLocale(locale: AppLocale): string {
  const host = defaultPresetHostFilesForLocale(locale);
  return legacyNarrationBlocks
    .map((block) => host[`blocks/${block}.md`]!.trimEnd())
    .join("\n\n")
    .concat("\n");
}

export const defaultNarrationPromptZhCN =
  defaultNarrationPromptForLocale("zh-CN");
export const defaultNarrationPromptEn = defaultNarrationPromptForLocale("en");
export const defaultNarrationPrompt = defaultNarrationPromptEn;
