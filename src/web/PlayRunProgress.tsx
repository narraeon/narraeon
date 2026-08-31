import type { V1PlayRunPhase } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";
import type { PlayRunProgressValue } from "./PlayRunProgressState.ts";

export function PlayRunProgress({
  progress,
  now,
  onCancel,
}: {
  progress: PlayRunProgressValue;
  now: number;
  onCancel: () => void;
}): React.JSX.Element {
  const elapsed = Math.max(0, Math.round((now - progress.startedAt) / 1000));
  const silence = Math.max(
    0,
    Math.round((now - progress.lastActivityAt) / 1000),
  );
  const stalled = progress.phase !== "cancelling" && silence >= 90;
  return (
    <section
      className="model-run-progress play-run-progress"
      role="status"
      aria-live="polite"
      aria-label={uiText("本次模型调用进度")}
    >
      <div className="model-run-headline">
        <strong>{phaseLabel(progress.phase)}</strong>
        <span>{uiText("已运行 {seconds} 秒", { seconds: elapsed })}</span>
        <span className={stalled ? "model-run-age-stalled" : undefined}>
          {silence === 0
            ? uiText("刚刚收到新数据")
            : uiText("{seconds} 秒没有新数据", { seconds: silence })}
        </span>
      </div>
      <dl className="model-run-counters">
        <Counter label={uiText("返回推理")} value={progress.reasoningChars} />
        <Counter label={uiText("正文")} value={progress.textChars} />
        <Counter label={uiText("工具参数")} value={progress.toolChars} />
        <div>
          <dt>{uiText("工具调用")}</dt>
          <dd>{progress.toolCalls}</dd>
        </div>
        <div>
          <dt>{uiText("Provider 派发")}</dt>
          <dd>{progress.dispatches}</dd>
        </div>
      </dl>
      {progress.phase === "waiting" ? (
        <p className="model-run-note">
          {uiText(
            "Provider 尚未返回可区分的增量；这可能是排队、模型内部思考或网络等待。",
          )}
        </p>
      ) : null}
      {stalled ? (
        <p className="model-run-stalled-note" role="note">
          {uiText(
            "已有 {seconds} 秒没有收到任何新数据，模型调用可能已经卡住；你可以继续等待或取消。",
            { seconds: silence },
          )}
        </p>
      ) : null}
      <div className="model-run-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={progress.phase === "cancelling"}
          onClick={onCancel}
        >
          {progress.phase === "cancelling"
            ? uiText("正在取消…")
            : uiText("取消生成")}
        </button>
      </div>
    </section>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {uiText("{count} 字", {
          count:
            value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value),
        })}
      </dd>
    </div>
  );
}

function phaseLabel(phase: V1PlayRunPhase): string {
  if (phase === "preparing") return uiText("正在准备模型请求…");
  if (phase === "waiting") return uiText("正在等待模型响应…");
  if (phase === "reasoning")
    return uiText("思考中（正在接收 Provider 返回推理）");
  if (phase === "text") return uiText("正在输出正文…");
  if (phase === "tool") return uiText("正在处理工具调用…");
  if (phase === "followup") return uiText("正在生成界面产物…");
  return uiText("正在取消模型生成…");
}
