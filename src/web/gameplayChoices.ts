import type { ResolutionScheme } from "../protocol/gameplay.ts";
import { uiText } from "./i18n.ts";

export interface ResolutionSchemeChoice {
  scheme: ResolutionScheme;
  label: string;
  description: string;
}

/** Scheme choices in their presentation order; d100 is the default. */
export function resolutionSchemeChoices(): ResolutionSchemeChoice[] {
  return [
    {
      scheme: "d100",
      label: "d100",
      description: uiText(
        "默认方案。掷一颗个位骰，可加奖励骰或惩罚骰；结果不高于目标值即成功。",
      ),
    },
    {
      scheme: "d20",
      label: "d20",
      description: uiText(
        "掷一颗 d20 加修正，总值不低于难度即成功；可掷优势或劣势。",
      ),
    },
    {
      scheme: "bag",
      label: uiText("混乱袋"),
      description: uiText(
        "从混乱袋抽一枚标记；数值标记加修正后与难度比较，特殊标记直接决定大成功或大失败。",
      ),
    },
  ];
}
