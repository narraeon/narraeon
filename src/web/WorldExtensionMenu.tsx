import { useState } from "react";
import type {
  WorldExtensionChoice,
  WorldExtensionItem,
  WorldExtensionsView,
} from "../protocol/worldExtensions.ts";
import { uiText } from "./i18n.ts";

export function WorldExtensionMenu({
  view,
  onChange,
}: {
  view: WorldExtensionsView;
  onChange: (key: string, value: WorldExtensionChoice) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (key: string, value: WorldExtensionChoice) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(key, value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const sources = {
    preset: uiText("玩法预设"),
    package: uiText("内容包"),
    builtin: uiText("系统示例"),
    world: uiText("世界"),
  };
  const row = (item: WorldExtensionItem) => (
    <div
      key={item.key}
      className={
        item.group
          ? "world-extension-choice world-extension-child"
          : "world-extension-choice"
      }
    >
      <label>
        <input
          type="checkbox"
          checked={item.selected}
          disabled={busy}
          onChange={(event) =>
            void change(item.key, event.target.checked ? "on" : "off")
          }
        />
        {item.name}
      </label>
      <small>
        {sources[item.source]} ·{" "}
        {item.enabled
          ? uiText("已启用")
          : item.selected && item.group
            ? uiText("随组暂停")
            : uiText("已关闭")}
      </small>
      <button
        type="button"
        disabled={busy || !item.overridden}
        aria-label={`${uiText("恢复默认")}：${item.name}`}
        onClick={() => void change(item.key, "default")}
      >
        {uiText("恢复默认")}
      </button>
    </div>
  );
  return (
    <details className="world-extension-menu">
      <summary>{uiText("世界扩展")}</summary>
      <div className="world-extension-options">
        <p>
          {uiText(
            "选择仅用于当前世界。后置请求重新开启后，从下一次正常发送生效；界面显示直接读取当前字段。",
          )}
        </p>
        <fieldset>
          <legend>{uiText("后置请求")}</legend>
          {view.items
            .filter((item) => item.kind === "request" || item.kind === "group")
            .map(row)}
        </fieldset>
        <fieldset>
          <legend>{uiText("界面显示（不调用模型）")}</legend>
          {view.items
            .filter((item) => item.kind === "panel" || item.kind === "view")
            .map(row)}
        </fieldset>
        {error === null ? null : <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
