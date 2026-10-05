import { HistoryQuery, historyInputs } from "../history/HistoryQuery.ts";
import {
  renderHistoryMessage,
  renderHistoryInjectionNotice,
} from "../history/HistoryRendering.ts";
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
  history: Readonly<Record<string, string>>,
  checkpoint?: NarrativeCheckpoint,
): [string, string][] {
  const entries = Object.entries(history);
  const cutoff =
    checkpoint === undefined
      ? -1
      : entries.findIndex(
          ([id]) =>
            id === checkpoint.historyMessageId ||
            id.endsWith(`.${checkpoint.historyMessageId}`),
        );
  if (checkpoint !== undefined && cutoff < 0)
    throw new Error(
      "The narrative checkpoint is not reachable in this history.",
    );
  return entries
    .slice(cutoff + 1)
    .filter(([id]) => !id.includes("message.genesis"));
}

export function playerRoundMarker(
  rounds: number,
  hasCheckpoint: boolean,
  locale: AppLocale,
): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
  const markdown =
    locale === "zh-CN"
      ? `距上次检查点已完成 ${rounds} 回合。${hasCheckpoint ? "" : "当前尚无检查点，以世界起点计数。"}`
      : `Completed player rounds since the last checkpoint: ${rounds}.${hasCheckpoint ? "" : " No checkpoint yet; counting from the world origin."}`;
  return {
    kind: "runtime_notice",
    notice: "checkpoint_rounds",
    text: `${locale === "zh-CN" ? "[Runtime 回合提示]" : "[Runtime round marker]"}\n${markdown}`,
  };
}

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
        ? "[Runtime 续写提示]\n本次发送没有追加新的玩家原文。已有的最终主持正文已展示并提交为历史；本次响应接在其后，不重新提交旧正文。回复提交不表示世界内活动已经结束。"
        : "[Runtime continuation]\nThis send adds no new player input. Existing final narrator prose has been displayed and committed as history; this response follows it without resubmitting it. A committed reply does not mean an in-world activity has ended.",
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
        ? "[Runtime 结算提示]\n上一响应调用了工具，其中的文字尚未作为最终故事展示或提交。工具已按回执结算；请根据回执，用无工具调用的非空最终正文呈现本轮尚未展示的内容，并与已提交状态一致。工具结算不要求在这些内容之后再推进剧情。"
        : "[Runtime settlement]\nThe previous response called tools, so its text has not yet been displayed or committed as final story. The tools have settled as their receipts state. Use those receipts to present this turn’s still-unshown content in nonempty final prose with no tool calls, consistent with committed state. Tool settlement does not require advancing the story beyond that content.",
  };
}

export function playerInputAppend(input: {
  history: Readonly<Record<string, string>>;
  checkpoint?: NarrativeCheckpoint | undefined;
  text: string;
  locale: AppLocale;
  checkpointAvailable: boolean;
}): ModelHostAppendItem[] {
  return [
    ...(input.text.trim().length > 0 && input.checkpointAvailable
      ? [
          playerRoundMarker(
            completedPlayerRounds(input.history) -
              (input.checkpoint?.completedPlayerRounds ?? 0),
            input.checkpoint !== undefined,
            input.locale,
          ),
        ]
      : []),
    { kind: "player", text: input.text },
  ];
}

export function checkpointReplayBlocks(
  history: Readonly<Record<string, string>>,
  checkpoint: NarrativeCheckpoint | undefined,
  locale: AppLocale,
  excluded: ReadonlySet<string> = new Set(),
  snapshot = new HistoryQuery(
    "checkpoint-replay",
    historyInputs(
      Object.entries(history).map(([path, contents]) => ({ path, contents })),
    ),
  ),
): PromptCompilation["logicalMessages"][number]["blocks"] {
  const eligible = checkpointHistory(history, checkpoint);
  if (eligible.length === 0) return [];
  const ids = new Set(
    eligible.filter(([id]) => !excluded.has(id)).map(([id]) => id),
  );
  const entries = snapshot.messages.filter(({ id }) => ids.has(id));
  const zh = locale === "zh-CN";
  return [
    {
      source: "runtime:checkpoint-history:notice",
      markdown:
        (zh
          ? "# 检查点后的已提交原文\n\n以下是当前时间线上最近一次已生效检查点之后的玩家原文与最终主持叙事；尚无检查点时从世界起点选取，开场白除外。部分结果可能已写入当前文档；这些记录用于核对连续性，不代表需要再次执行其中的事件。当前明确的世界修订优先，不能用旧叙事推翻修订。"
          : "# Committed history after the checkpoint\n\nThese are the current timeline’s original player inputs and final narratives after its last effective checkpoint (or the world origin if none, excluding the opening). Some results may already be in current documents. These records support continuity, not repeated execution. Explicit current world corrections take precedence over old narrative.") +
        `\n\n${renderHistoryInjectionNotice(snapshot.messages.length, entries, "checkpoint", locale)}`,
    },
    ...entries.map((message) => ({
      source: `runtime:checkpoint-history:${message.id}`,
      markdown: renderHistoryMessage(message, locale),
    })),
  ];
}
