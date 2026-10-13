import type { PlayFailureKind } from "../protocol/playFailure.ts";
import { uiText } from "./i18n.ts";
import { failureText } from "./PlayFailureText.ts";

export interface PlayFailureRecovery {
  canRetry: boolean;
  disabled: boolean;
  onRetry: () => void;
  onFreshContext: () => void;
  onConfigureModel: () => void;
}

export function PlayFailureNotice({
  failureKind,
  canRetry,
  message,
  recovery,
}: {
  failureKind?: PlayFailureKind | undefined;
  canRetry: boolean;
  message: string;
  recovery?: PlayFailureRecovery | undefined;
}): React.JSX.Element {
  const kind = failureKind ?? (canRetry ? "retryable" : "other");
  const text = failureText[kind];
  return (
    <>
      <strong>{uiText(text.title)}</strong>
      <p>{uiText(text.description)}</p>
      {recovery === undefined ? null : (
        <div className="play-failure-actions">
          {kind === "retryable" && recovery.canRetry ? (
            <button
              type="button"
              disabled={recovery.disabled}
              onClick={recovery.onRetry}
            >
              {uiText("重新发送")}
            </button>
          ) : null}
          <button
            type="button"
            disabled={recovery.disabled}
            onClick={recovery.onFreshContext}
          >
            {uiText("从全新上下文继续")}
          </button>
          {kind === "provider_error" || kind === "output_limit" ? (
            <button
              type="button"
              disabled={recovery.disabled}
              onClick={recovery.onConfigureModel}
            >
              {uiText(
                kind === "output_limit" ? "调整最大输出" : "检查模型连接",
              )}
            </button>
          ) : null}
        </div>
      )}
      <details>
        <summary>{uiText("技术详情")}</summary>
        <pre>{message}</pre>
      </details>
    </>
  );
}
