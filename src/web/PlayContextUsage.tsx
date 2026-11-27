import { uiText } from "./i18n.ts";

export function PlayContextUsageWarning({
  percent,
  freshContextDisabled,
  onUseFreshContext,
}: {
  percent: number;
  freshContextDisabled: boolean;
  onUseFreshContext: () => void;
}): React.JSX.Element {
  return (
    <div className="world-context-usage-warning" role="status">
      <span>
        {uiText("上下文已用 {percent}%，建议下一条从全新上下文开始", {
          percent,
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
  );
}

export function PlayContextUsageSummary({
  label,
  explanation,
  className,
}: {
  label: string;
  explanation: string;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <details name="world-composer-menu" className={className}>
      <summary title={explanation}>{label}</summary>
      <p>{explanation}</p>
    </details>
  );
}
