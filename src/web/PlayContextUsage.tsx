import type {
  V1PlayCallChainView,
  V1PlayTimelinePage,
} from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

export function PlayContextUsage({
  chain,
  timeline,
  freshContextSelected,
  freshContextDisabled,
  onUseFreshContext,
}: {
  chain: Pick<
    V1PlayCallChainView,
    "chainId" | "contextWindowTokens" | "latestCompletedResponse"
  > | null;
  timeline: V1PlayTimelinePage | null;
  freshContextSelected: boolean;
  freshContextDisabled: boolean;
  onUseFreshContext: () => void;
}): React.JSX.Element {
  const chainId = chain?.chainId ?? timeline?.activeChainId;
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
  const projectedResponse = chain?.latestCompletedResponse;
  const response =
    projectedResponse !== undefined &&
    (timelineResponse === undefined ||
      projectedResponse.id >= timelineResponse.id)
      ? projectedResponse
      : timelineResponse;
  const contextWindow = chain?.contextWindowTokens;
  const usage = response?.usage;
  const input = usage?.inputTokens;
  const percent =
    contextWindow !== undefined &&
    contextWindow > 0 &&
    input !== undefined &&
    input !== null &&
    usage?.provenance.inputTokens !== "unavailable"
      ? (input / contextWindow) * 100
      : null;
  // Keep the displayed integer below 85 until the actual warning threshold.
  const displayedPercent = percent === null ? null : Math.floor(percent);
  const explanation =
    response === undefined
      ? uiText("当前上下文尚无已完成的 AI 响应。")
      : contextWindow === undefined || contextWindow <= 0
        ? uiText("当前上下文没有记录模型窗口。")
        : percent === null
          ? uiText("Provider 未报告最近一次完整响应的输入 token 数。")
          : uiText(
              "最近一次完整响应的实报输入量：{input} / {window} tokens。仅作提示，不限制发送。",
              { input: input!, window: contextWindow },
            );
  return (
    <div className="world-context-usage">
      {percent !== null && percent >= 85 && !freshContextSelected ? (
        <div className="world-context-usage-warning" role="status">
          <span>
            {uiText("上下文已用 {percent}%，建议下一条从全新上下文开始", {
              percent: displayedPercent!,
            })}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={freshContextDisabled}
            onClick={onUseFreshContext}
          >
            {uiText("下一条消息使用全新上下文")}
          </button>
        </div>
      ) : null}
      <small className="world-context-usage-label" title={explanation}>
        {percent === null
          ? uiText("上下文 —")
          : uiText("上下文 {percent}%", { percent: displayedPercent! })}
      </small>
    </div>
  );
}
