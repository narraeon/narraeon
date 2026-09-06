import { uiText } from "./i18n.ts";

export function DismissibleNotice({
  text,
  onDismiss,
  className = "",
  role = "status",
}: {
  text: string;
  onDismiss: () => void;
  className?: string;
  role?: "status" | "alert";
}): React.JSX.Element {
  return (
    <div className={`dismissible-notice ${className}`} role={role}>
      <span>{text}</span>
      <button
        type="button"
        aria-label={uiText("关闭提示")}
        title={uiText("关闭提示")}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
