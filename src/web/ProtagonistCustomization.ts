import type { ProtagonistTemplate } from "../protocol/protagonistTemplates.ts";
import { createClientId } from "./ClientId.ts";
import { uiText } from "./i18n.ts";

export interface ProtagonistCustomization {
  name: string;
  body: string;
  message: string;
  requestId: string;
  attempted?: boolean;
  epochId?: string;
  reply?: { text: string; requestId: string; sessionId: string };
}

function storageKey(worldId: string): string {
  return `narraeon.protagonist-customization:${worldId}`;
}

export function prepareProtagonistCustomization(
  template: ProtagonistTemplate,
): ProtagonistCustomization {
  return {
    name: template.name,
    body: template.body,
    message: uiText(
      "请按下面的主角模板修改本世界的主角。\n\n- 找到本世界中代表玩家的主角文档，按模板改写姓名、外貌、背景、性格等相关内容。\n- 模板与本世界设定冲突的部分，保留模板的意图，按本世界的规则调整。\n- 只修改主角相关的内容，不修改其他人物、地点、规则或世界控制。\n- 如果本世界中找不到明确的主角文档，先在回复中说明并询问我，不要擅自新建。\n\n主角模板：\n\n{body}",
      { body: template.body },
    ),
    requestId: createClientId("protagonist"),
  };
}

export function readProtagonistCustomization(
  worldId: string,
): ProtagonistCustomization | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(worldId));
    if (raw !== null) return JSON.parse(raw) as ProtagonistCustomization;
  } catch {
    // The card can still be used in memory when browser storage is unavailable.
  }
  return null;
}

export function saveProtagonistCustomization(
  worldId: string,
  customization: ProtagonistCustomization | null,
): void {
  try {
    const key = storageKey(worldId);
    if (customization === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(customization));
  } catch {
    // Browser storage is used only to keep the card through a reload.
  }
}
