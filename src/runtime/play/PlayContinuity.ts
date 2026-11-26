import type { HistoryMessage } from "../history/HistoryQuery.ts";
import {
  renderHistoryMessage,
  renderHistoryInjectionNotice,
} from "../history/HistoryRendering.ts";
import { turnGuideText, turnNoteSource } from "../../shared/turn-guide.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ModelHostAppendItem } from "../model/ModelHost.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

export interface NarrativeCheckpointDeclaration {
  contextId: string;
  completedPlayerRounds: number;
}

export interface NarrativeCheckpoint extends NarrativeCheckpointDeclaration {
  head: string;
  historyMessageId: string;
}

/** Narrative history contains only committed original inputs and final prose. */
export function completedPlayerRounds(
  history: Readonly<Record<string, string>>,
): number {
  let pending = false;
  let completed = 0;
  for (const [id, text] of Object.entries(history)) {
    if (id.includes("message.genesis")) continue;
    if (id.endsWith(".player")) pending = text.trim().length > 0;
    else if (id.endsWith(".narrator") && pending) {
      completed += 1;
      pending = false;
    }
  }
  return completed;
}

export function checkpointHistory(
  history: readonly HistoryMessage[],
  checkpoint?: NarrativeCheckpoint,
): readonly HistoryMessage[] {
  if (checkpoint === undefined) return history;
  const cutoff = history.findIndex(
    ({ id }) =>
      id === checkpoint.historyMessageId ||
      id.endsWith(`.${checkpoint.historyMessageId}`),
  );
  if (cutoff < 0)
    throw new Error(
      "The narrative checkpoint is not reachable in this history.",
    );
  return history.slice(cutoff + 1);
}

/** Retain released markers when reconstructing frozen transcript prefixes. */
export function isPlayerRoundMarker(
  item: ModelHostAppendItem | undefined,
): item is Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
  return item?.kind === "runtime_notice" && item.notice === "checkpoint_rounds";
}

export function continuationNotice(
  locale: AppLocale,
): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
  return {
    kind: "runtime_notice",
    notice: "continuation",
    text:
      locale === "zh-CN"
        ? "[Runtime 续写提示]\n本次发送没有追加新的玩家原文。已有的最终主持正文已展示并提交为历史；本次响应接在其后，从那段正文的最后局面继续，只推进既有的动作、NPC 和环境：不重新回答已经回应的问题，不复位已完成的递接或走动，不把旧玩家输入再演一次，不替玩家增加决定，也不代玩家接受邀请或作出承诺。回复提交不表示世界内活动已经结束。"
        : "[Runtime continuation]\nThis send adds no new player input. Existing final narrator prose has been displayed and committed as history; this response follows it, resuming from that prose's final situation and advancing only existing actions, NPCs and the environment: do not answer an already answered question again, reset a completed handover or movement, perform the old player input again, add a decision for the player, or accept an invitation or make a promise on their behalf. A committed reply does not mean an in-world activity has ended.",
  };
}

/** Freeze the guide with the request while keeping it outside the transcript. */
export function turnGuideNotice(
  guide: NonNullable<PromptCompilation["turnGuide"]>,
  protocol: PromptCompilation["provider"]["protocol"],
  locale: AppLocale,
): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
  const notice = {
    kind: "runtime_notice",
    notice: "turn_guide",
    text: guide.text,
  } as const;
  if (protocol !== "openai_responses") return notice;
  const fixed = guide.lines.filter(({ source }) => source !== turnNoteSource);
  const player = guide.lines.find(({ source }) => source === turnNoteSource);
  return {
    ...notice,
    responsesInstructions: {
      fixed:
        fixed.length > 0 ? turnGuideText(locale, fixed, "conditional") : "",
      player: player?.text ?? "",
    },
  };
}

export function toolStepNotice(
  locale: AppLocale,
): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
  return {
    kind: "runtime_notice",
    notice: "tool_step",
    text:
      locale === "zh-CN"
        ? "[Runtime 结算提示]\n上一响应的文字尚未展示或提交，工具已按回执结算。若还需读取、判定或写入可继续调用（勿重复已成功写入）；否则依据回执输出本轮尚未展示的最终正文，不扩大叙事范围。"
        : "[Runtime settlement]\nThe previous response's text is not shown or committed; tools settled per their receipts. Call more tools if needed (do not repeat succeeded writes), or output this turn's unshown final prose without expanding scope.",
  };
}

export function playerInputAppend(
  text: string,
  locale: AppLocale,
): ModelHostAppendItem[] {
  return [{ kind: "player", text, inputBoundary: locale }];
}

export function checkpointReplayBlocks(
  total: number,
  entries: readonly HistoryMessage[],
  checkpoint: NarrativeCheckpoint | undefined,
  locale: AppLocale,
): { key: string; source: string; markdown: string }[] {
  const zh = locale === "zh-CN";
  const fromOrigin = checkpoint === undefined;
  const introduction = fromOrigin
    ? zh
      ? "# 从世界起点补入的已提交原文\n\n当前时间线尚无生效检查点，从世界起点按顺序补入已提交历史。开场白是玩家已经读过的第一段叙事。"
      : "# Committed history from the world origin\n\nThis timeline has no effective checkpoint, so committed history is supplied in order from the world origin. The opening is the first narrative already seen by the player."
    : zh
      ? "# 检查点后的已提交原文\n\n以下是当前时间线上最近一次已生效检查点之后的玩家原文与最终主持叙事。"
      : "# Committed history after the checkpoint\n\nThese are the current timeline’s original player inputs and final narratives after its last effective checkpoint.";
  const guidance = zh
    ? "部分结果可能已写入当前文档；这些记录用于核对连续性，已发生的事件无需重演。以当前明确的世界状态与修订为准。"
    : "Some results may already be in current documents. Use these records to maintain continuity. Do not reenact past events. Explicit current world state and revisions take precedence over old narrative.";
  return [
    {
      key: "history:checkpoint-notice",
      source: "runtime:checkpoint-history:notice",
      markdown: `${introduction} ${guidance}\n\n${renderHistoryInjectionNotice(total, entries, "replay", locale)}`,
    },
    ...entries.map((message) => ({
      key: `history_message:${message.id}`,
      source: `runtime:checkpoint-history:${message.id}`,
      markdown: renderHistoryMessage(message, locale),
    })),
  ];
}
