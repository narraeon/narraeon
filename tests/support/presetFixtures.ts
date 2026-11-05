import { parseDocument } from "yaml";
import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import { legacyDefaultPlayPresetFilesForLocale } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { defaultOrderedPlayPrompts } from "../../src/shared/ordered-play-prompts.ts";
import { defaultOrderedAuthorPrompts } from "../../src/shared/ordered-author-prompts.ts";

/** Synthetic ordered-list fixture for codec behavior; not released-storage evidence. */
export function orderedListPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  const files = legacyDefaultPlayPresetFilesForLocale(locale);
  const preset = parseDocument(files["preset.yaml"]!);
  preset.set("format", "narraeon.play-preset/v2");
  preset.set("playPrompts", defaultOrderedPlayPrompts());
  preset.set("authorPrompts", defaultOrderedAuthorPrompts());
  preset.set("mergeConsecutiveMessages", false);
  files["preset.yaml"] = preset.toString();
  return files;
}
