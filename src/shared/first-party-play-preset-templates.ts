import type { AppLocale } from "../protocol/appPreferences.ts";
import { firstPartyActionChoicesPresetFilesForLocale } from "./first-party-action-choices.ts";
import { firstPartyGenericPanelsPresetFilesForLocale } from "./first-party-generic-panels.ts";
import { firstPartyStatusPanelPresetFilesForLocale } from "./first-party-player-view.ts";

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
      label: locale === "zh-CN" ? "产物调试器" : "Artifact debugger",
      name:
        locale === "zh-CN"
          ? "产物调试器（可编辑副本）"
          : "Artifact debugger (editable copy)",
      files: firstPartyGenericPanelsPresetFilesForLocale(locale),
    },
  ];
}

export const firstPartyPlayPresetTemplates =
  firstPartyPlayPresetTemplatesForLocale("en");
