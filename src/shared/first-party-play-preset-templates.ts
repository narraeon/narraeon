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

export interface FirstPartyPlayPresetTemplate {
  id: string;
  label: string;
  name: string;
  files: Record<string, string>;
}

/** Optional workbench registry; each entry is ordinary portable file content. */
export function firstPartyPlayPresetTemplatesForLocale(
  locale: AppLocale,
): FirstPartyPlayPresetTemplate[] {
  return [
    {
      id: "action-choices",
      label: locale === "zh-CN" ? "行动选项" : "Action choices",
      name:
        locale === "zh-CN"
          ? "下一步建议（可编辑副本）"
          : "Next-step ideas (editable copy)",
      files: firstPartyActionChoicesPresetFilesForLocale(locale),
    },
    {
      id: "status-panel",
      label: locale === "zh-CN" ? "状态栏" : "Status panel",
      name:
        locale === "zh-CN"
          ? "状态栏（可编辑副本）"
          : "Status panel (editable copy)",
      files: firstPartyStatusPanelPresetFilesForLocale(locale),
    },
    {
      id: "generic-panels",
      label:
        locale === "zh-CN" ? "Markdown / HTML 面板" : "Markdown / HTML panels",
      name:
        locale === "zh-CN"
          ? "通用面板（可编辑副本）"
          : "Generic panels (editable copy)",
      files: firstPartyGenericPanelsPresetFilesForLocale(locale),
    },
    {
      id: "artifact-debugger",
      label:
        locale === "zh-CN" ? "产物调试器示例" : "Artifact debugger example",
      name:
        locale === "zh-CN"
          ? "产物调试器示例（可编辑副本）"
          : "Artifact debugger example (editable copy)",
      files: firstPartyArtifactDebuggerPresetFilesForLocale(locale),
    },
  ];
}

export const firstPartyPlayPresetTemplates =
  firstPartyPlayPresetTemplatesForLocale("en");
