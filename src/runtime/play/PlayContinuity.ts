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
      ? `距上次检查点已完成 ${rounds} 回合。${hasCheckpoint ? "" : "当前尚无检查点，以世界起点计数。"}必要状态整理完成时，可调用 world_checkpoint 建议在此开启全新上下文。`
      : `Completed player rounds since the last checkpoint: ${rounds}. ${hasCheckpoint ? "" : "No checkpoint yet; counting from the world origin. "}When necessary state maintenance is complete, world_checkpoint can suggest starting a fresh context here.`;
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
): PromptCompilation["logicalMessages"][number]["blocks"] {
  const entries = checkpointHistory(history, checkpoint);
  if (entries.length === 0) return [];
  const zh = locale === "zh-CN";
  return [
    {
      source: "runtime:checkpoint-history:notice",
      markdown: zh
        ? "# 检查点后的已提交原文\n\n以下是当前时间线上最近一次已生效检查点之后的玩家原文与最终主持叙事；尚无检查点时从世界起点选取，开场白除外。部分结果可能已写入当前文档；这些记录用于核对连续性，不代表需要再次执行其中的事件。当前明确的世界修订优先，不能用旧叙事推翻修订。"
        : "# Committed history after the checkpoint\n\nThese are the current timeline’s original player inputs and final narratives after its last effective checkpoint (or the world origin if none, excluding the opening). Some results may already be in current documents. These records support continuity, not repeated execution. Explicit current world corrections take precedence over old narrative.",
    },
    ...entries.map(([id, text]) => ({
      source: `runtime:checkpoint-history:${id}`,
      markdown: `## ${id.endsWith(".player") ? (zh ? "玩家原文" : "Player input") : zh ? "主持叙事" : "Host narrative"}\n\n${text}`,
    })),
  ];
}
