import { ModelRetryLimitNotice } from "./ModelRetryStatus.tsx";
import {
  ModelRecoveryActions,
  type ComposerFreshContextReason,
} from "./ModelRecoveryActions.tsx";
import type { PlayFailureKind } from "../protocol/playFailure.ts";
import { uiText } from "./i18n.ts";
import { failureText, playFailureDescription } from "./PlayFailureText.ts";

export interface PlayFailureRecovery {
  canRetry: boolean;
  freshContextReason?: ComposerFreshContextReason | undefined;
  onFreshContext?: () => void;
  canContinuePartial?: boolean;
  onContinuePartial?: () => void;
  playDisabled: boolean;
  configureDisabled: boolean;
  onRetry: () => void;
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
  const canResend = canRetry && (recovery?.canRetry ?? true);
  const canConfigure = kind === "provider_error" || kind === "output_limit";
  const text = failureText[kind === "retryable" && !canResend ? "other" : kind];
  return (
    <>
      <strong>{uiText(text.title)}</strong>
      <ModelRetryLimitNotice message={message} />
      {recovery?.freshContextReason === undefined && (
        <p>
          {playFailureDescription(
            kind,
            canResend,
            recovery?.canContinuePartial,
          )}
        </p>
      )}
      {recovery && (
        <ModelRecoveryActions
          disabled={recovery.playDisabled}
          freshContextReason={recovery.freshContextReason}
          onFreshContext={recovery.onFreshContext}
          onResend={canResend ? recovery.onRetry : undefined}
          onContinue={
            recovery.canContinuePartial ? recovery.onContinuePartial : undefined
          }
        >
          {canConfigure ? (
            <button
              type="button"
              disabled={recovery.configureDisabled}
              onClick={recovery.onConfigureModel}
            >
              {uiText(
                kind === "output_limit" ? "调整最大输出" : "检查模型连接",
              )}
            </button>
          ) : null}
        </ModelRecoveryActions>
      )}
      <details>
        <summary>{uiText("技术详情")}</summary>
        <pre>{message}</pre>
      </details>
    </>
  );
}
