import { uiText } from "./i18n.ts";

export function SyncNotice({
  failed,
  onRead,
}: {
  failed: boolean;
  onRead: () => void;
}): React.JSX.Element | null {
  if (!failed) return null;
  return (
    <div role="status" className="sync-notice">
      <p>{uiText("暂时无法同步")}</p>
      <button type="button" onClick={onRead}>
        {uiText("重新读取")}
      </button>
    </div>
  );
}
