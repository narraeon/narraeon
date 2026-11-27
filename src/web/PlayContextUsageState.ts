import type {
  V1PlayCallChainView,
  V1PlayTimelinePage,
} from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

export interface PlayContextUsageDisplay {
  label: string;
  explanation: string;
  warningPercent: number | null;
}

export function describePlayContextUsage({
  chain,
  timeline,
  freshContextSelected,
}: {
  chain: Pick<
    V1PlayCallChainView,
    "chainId" | "contextWindowTokens" | "latestCompletedResponse"
  > | null;
  timeline: V1PlayTimelinePage | null;
  freshContextSelected: boolean;
}): PlayContextUsageDisplay {
  const currentChain =
    timeline === null || chain?.chainId === timeline.activeChainId
      ? chain
      : null;
  const chainId = currentChain?.chainId ?? timeline?.activeChainId;
  const timelineResponse = timeline?.items.reduce<
    V1PlayCallChainView["latestCompletedResponse"]
  >(
    (latest, item) =>
      item.kind === "event" &&
      item.chainId === chainId &&
      item.event.kind === "assistant" &&
      item.event.status === "completed" &&
      (latest === undefined || item.event.id > latest.id)
        ? item.event
        : latest,
    undefined,
  );
  const projectedResponse = currentChain?.latestCompletedResponse;
  const response =
    projectedResponse !== undefined &&
    (timelineResponse === undefined ||
      projectedResponse.id >= timelineResponse.id)
      ? projectedResponse
      : timelineResponse;
  const contextWindow = currentChain?.contextWindowTokens;
  const usage = response?.usage;
  const input = usage?.inputTokens;
  const percent =
    !freshContextSelected &&
    contextWindow !== undefined &&
    contextWindow > 0 &&
    input !== undefined &&
    input !== null &&
    usage?.provenance.inputTokens !== "unavailable"
      ? (input / contextWindow) * 100
      : null;
  // Keep the displayed integer below 85 until the actual warning threshold.
  const displayedPercent = percent === null ? null : Math.floor(percent);
  const explanation = freshContextSelected
    ? uiText("下一次发送将开启全新上下文，尚无实报占用。")
    : response === undefined
      ? uiText("当前上下文尚无已完成的 AI 响应。")
      : contextWindow === undefined || contextWindow <= 0
        ? uiText("当前上下文没有记录模型窗口。")
        : percent === null
          ? uiText("Provider 未报告最近一次完整响应的输入 token 数。")
          : uiText(
              "最近一次完整响应的实报输入量：{input} / {window} tokens。仅作提示，不限制发送。",
              { input: input!, window: contextWindow },
            );
  return {
    label:
      percent === null
        ? uiText("上下文 —")
        : uiText("上下文 {percent}%", {
            percent: percent > 0 && percent < 1 ? "<1" : displayedPercent!,
          }),
    explanation,
    warningPercent: percent !== null && percent >= 85 ? displayedPercent : null,
  };
}
