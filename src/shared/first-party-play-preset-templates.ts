import type { AppLocale } from "../protocol/appPreferences.ts";
import { firstPartyActionChoicesPresetFilesForLocale } from "./first-party-action-choices.ts";
import { firstPartyArtifactDebuggerPresetFilesForLocale } from "./first-party-artifact-debugger.ts";
import { firstPartyGenericPanelsPresetFilesForLocale } from "./first-party-generic-panels.ts";
import { firstPartyStatusPanelPresetFilesForLocale } from "./first-party-player-view.ts";
import {
  builtinExtensionFollowupIds,
  type BuiltinExtensionFollowupId,
} from "./ordered-followups.ts";

export const builtinStatusPanelId = "builtin:status-panel";
type BuiltinExtensionId =
  BuiltinExtensionFollowupId | typeof builtinStatusPanelId;

const templates = {
  "builtin:action-choices": {
    labels: { "zh-CN": "行动选项", en: "Action choices" },
    entryId: "player_options",
    files: firstPartyActionChoicesPresetFilesForLocale,
  },
  "builtin:generic-panels": {
    labels: { "zh-CN": "Markdown / HTML 面板", en: "Markdown / HTML panels" },
    entryId: "publish_panels",
    files: (locale: AppLocale) =>
      firstPartyGenericPanelsPresetFilesForLocale(locale, "document"),
  },
  "builtin:artifact-debugger": {
    labels: { "zh-CN": "调试示例输出", en: "Debug example output" },
    entryId: "emit_debug_example",
    files: firstPartyArtifactDebuggerPresetFilesForLocale,
  },
  [builtinStatusPanelId]: {
    labels: { "zh-CN": "状态栏样式", en: "Status panel style" },
    entryId: "current_view",
    files: firstPartyStatusPanelPresetFilesForLocale,
  },
};

export function builtinExtensionLabel(
  id: BuiltinExtensionId,
  locale: AppLocale,
) {
  return templates[id].labels[locale];
}

export function builtinExtensionTemplateForLocale(
  id: BuiltinExtensionId,
  locale: AppLocale,
) {
  const entry = templates[id];
  return {
    id,
    label: entry.labels[locale],
    entryId: entry.entryId,
    files: entry.files(locale),
  };
}

export function builtinExtensionTemplatesForLocale(locale: AppLocale) {
  const ids: readonly BuiltinExtensionId[] = [
    ...builtinExtensionFollowupIds,
    builtinStatusPanelId,
  ];
  return ids.map((id) => builtinExtensionTemplateForLocale(id, locale));
}
