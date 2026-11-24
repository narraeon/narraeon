import { uiText } from "./i18n.ts";
import { RuntimeRequestError } from "./RuntimeResponse.ts";

export function SyncNotice({
  failed,
  onRead,
  reason,
}: {
  failed: boolean;
  onRead: () => void;
  reason?: unknown;
}): React.JSX.Element | null {
  if (!failed) return null;
  return (
    <div role="status" className="sync-notice">
      {reason instanceof RuntimeRequestError && reason.kind === "runtime" && (
        <p role="alert">{reason.message}</p>
      )}
      <p>{uiText("暂时无法同步")}</p>
      <button type="button" onClick={onRead}>
        {uiText("重新加载")}
      </button>
    </div>
  );
}
