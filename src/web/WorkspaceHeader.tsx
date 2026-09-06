import { useState } from "react";
import type { AppLocale } from "../protocol/appPreferences.ts";
import { uiText } from "./i18n.ts";

export type WorkspaceScreen =
  "home" | "content" | "plays" | "model" | "create" | "preview" | "world";

const destinations = [
  ["home", "工作区"],
  ["content", "内容编辑"],
  ["plays", "预设"],
  ["create", "新建世界"],
  ["preview", "提示词预览"],
] as const;

export function WorkspaceHeader({
  screen,
  locale,
  localeSaving,
  navigationLocked,
  activeModelName,
  onNavigate,
  onLocaleChange,
}: {
  screen: WorkspaceScreen;
  locale: AppLocale;
  localeSaving: boolean;
  navigationLocked: boolean;
  activeModelName: string | null;
  onNavigate: (screen: WorkspaceScreen) => void;
  onLocaleChange: (locale: AppLocale) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  function navigate(next: WorkspaceScreen): void {
    if (navigationLocked) return;
    setMenuOpen(false);
    onNavigate(next);
  }
  return (
    <header className="workspace-header">
      <button
        type="button"
        className="workspace-brand"
        aria-label={uiText("返回工作区")}
        disabled={navigationLocked}
        onClick={() => navigate("home")}
      >
        Narraeon
      </button>
      <nav
        id="workspace-navigation"
        className={
          menuOpen ? "workspace-navigation is-open" : "workspace-navigation"
        }
        aria-label={uiText("工作区导航")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setMenuOpen(false);
            document.getElementById("workspace-menu-toggle")?.focus();
          }
        }}
      >
        {destinations.map(([destination, label]) => (
          <button
            key={destination}
            type="button"
            aria-current={screen === destination ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => navigate(destination)}
          >
            {uiText(label)}
          </button>
        ))}
      </nav>
      <div className="workspace-header-actions">
        <label className="workspace-locale-picker">
          <span>{uiText("界面语言")}</span>
          <select
            aria-label={uiText("界面语言")}
            value={locale}
            disabled={localeSaving || navigationLocked}
            onChange={(event) =>
              onLocaleChange(event.currentTarget.value as AppLocale)
            }
          >
            <option value="en">English</option>
            <option value="zh-CN">{uiText("简体中文")}</option>
          </select>
        </label>
        <button
          type="button"
          className="workspace-model-button"
          aria-label={uiText("模型连接")}
          aria-current={screen === "model" ? "page" : undefined}
          title={activeModelName ?? uiText("尚未配置")}
          disabled={navigationLocked}
          onClick={() => navigate("model")}
        >
          <span
            className={`workspace-model-dot ${activeModelName === null ? "needs-attention" : "is-ready"}`}
            aria-hidden="true"
          />
          {uiText("模型连接")}
        </button>
        <button
          id="workspace-menu-toggle"
          type="button"
          className="workspace-menu-toggle"
          aria-label={uiText("切换页面")}
          aria-expanded={menuOpen}
          aria-controls="workspace-navigation"
          disabled={navigationLocked}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          ☰
        </button>
      </div>
    </header>
  );
}
