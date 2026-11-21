import type { FreshContextReason } from "../protocol/playFailure.ts";
import { uiText } from "./i18n.ts";

export type ComposerFreshContextReason = FreshContextReason | "imported_world";

const reasons: Record<ComposerFreshContextReason, string> = {
  snapshot_missing: "缺少这次请求的历史记录，无法还原原请求。",
  continuation_unavailable: "原上下文的模型续传记录缺失或已损坏。",
  files_changed: "相关文件已经改变，无法从上次保存的位置恢复。",
  world_changed: "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
  imported_world: "世界从备份导入；下一次行动会从新上下文开始",
  revision_closed: "这次世界修订已应用或放弃。",
};

export function ModelRecoveryActions({
  freshContextReason,
  disabled,
  onContinue,
  onResend,
  resendLabel = "重新发送",
  onFreshContext,
  children,
}: {
  freshContextReason?: ComposerFreshContextReason | undefined;
  disabled: boolean;
  onContinue?: (() => void) | undefined;
  onResend?: (() => void) | undefined;
  resendLabel?: string;
  onFreshContext?: (() => void) | undefined;
  children?: React.ReactNode;
}): React.JSX.Element | null {
  if (freshContextReason !== undefined)
    return (
      <>
        <p>{uiText(reasons[freshContextReason])}</p>
        <div className="play-failure-actions">
          <button type="button" disabled={disabled} onClick={onFreshContext}>
            {uiText("用新上下文")}
          </button>
        </div>
      </>
    );
  if (!onContinue && !onResend && !children) return null;
  return (
    <div className="play-failure-actions">
      {onContinue && (
        <button type="button" disabled={disabled} onClick={onContinue}>
          {uiText("续写")}
        </button>
      )}
      {onResend && (
        <button type="button" disabled={disabled} onClick={onResend}>
          {uiText(resendLabel)}
        </button>
      )}
      {children}
    </div>
  );
}
