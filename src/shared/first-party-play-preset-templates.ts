import { firstPartyActionChoicesPresetFiles } from "./first-party-action-choices.ts";
import { firstPartyGenericPanelsPresetFiles } from "./first-party-generic-panels.ts";
import { firstPartyStatusPanelPresetFiles } from "./first-party-player-view.ts";

export interface FirstPartyPlayPresetTemplate {
  id: string;
  label: string;
  name: string;
  files: Record<string, string>;
}

/** Optional workbench registry; each entry is ordinary portable file content. */
export const firstPartyPlayPresetTemplates: FirstPartyPlayPresetTemplate[] = [
  {
    id: "action-choices",
    label: "行动选项",
    name: "下一步建议（可编辑副本）",
    files: firstPartyActionChoicesPresetFiles,
  },
  {
    id: "status-panel",
    label: "状态栏",
    name: "状态栏（可编辑副本）",
    files: firstPartyStatusPanelPresetFiles,
  },
  {
    id: "generic-panels",
    label: "Markdown / HTML 面板",
    name: "通用面板（可编辑副本）",
    files: firstPartyGenericPanelsPresetFiles,
  },
  {
    id: "artifact-debugger",
    label: "产物调试器",
    name: "产物调试器（可编辑副本）",
    files: firstPartyGenericPanelsPresetFiles,
  },
];
