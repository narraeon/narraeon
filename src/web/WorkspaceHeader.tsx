import { useEffect, useRef, useState } from "react";
import { ModelConnectionSwitcher } from "./ModelConnectionSwitcher.tsx";
import type { ModelConnectionLibraryView } from "../protocol/modelConnections.ts";
import type { AppLocale } from "../protocol/appPreferences.ts";
import {
  canExportAndroidLogs,
  exportAndroidLogs,
  useAndroidBack,
} from "./androidBridge.ts";
import { uiText } from "./i18n.ts";

export type WorkspaceScreen =
  | "home"
  | "library"
  | "content"
  | "plays"
  | "model"
  | "create"
  | "preview"
  | "world";

const creationDestinations = [
  ["plays", "编排方案"],
  ["preview", "提示词预览"],
] as const;

export function WorkspaceHeader({
  screen,
  locale,
  localeSaving,
  navigationLocked,
  model,
  modelBusy,
  onSelectModel,
  onNavigate,
  onLocaleChange,
}: {
  screen: WorkspaceScreen;
  locale: AppLocale;
  localeSaving: boolean;
  navigationLocked: boolean;
  model: ModelConnectionLibraryView;
  modelBusy: boolean;
  onSelectModel: (id: string) => Promise<boolean>;
  onNavigate: (screen: WorkspaceScreen) => void;
  onLocaleChange: (locale: AppLocale) => void;
}): React.JSX.Element {
  const activeModelName =
    model.connections.find(({ id }) => id === model.activeConnectionId)?.name ??
    null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [creationOpen, setCreationOpen] = useState(false);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const creationMenu = useRef<HTMLDivElement>(null);
  const creationToggle = useRef<HTMLButtonElement>(null);
  const creativePage = screen === "plays" || screen === "preview";

  function closeNavigation(restoreFocus = false): void {
    setCreationOpen(false);
    setMenuOpen(false);
    if (restoreFocus) mobileToggle.current?.focus();
  }

  function closeCreation(restoreFocus = false): void {
    setCreationOpen(false);
    if (restoreFocus) creationToggle.current?.focus();
  }

  useAndroidBack(menuOpen, () => closeNavigation(true));
  useAndroidBack(creationOpen, () => closeCreation(true));
  useEffect(() => {
    if (menuOpen) navigation.current?.querySelector("button")?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen && !creationOpen) return;
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return;
      if (!creationMenu.current?.contains(event.target)) setCreationOpen(false);
      if (
        !navigation.current?.contains(event.target) &&
        !mobileToggle.current?.contains(event.target)
      )
        setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [creationOpen, menuOpen]);

  function navigate(next: WorkspaceScreen): void {
    if (navigationLocked) return;
    if (menuOpen) closeNavigation(true);
    else closeCreation(creationOpen);
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
        className="workspace-header-navigation"
        aria-label={uiText("工作区导航")}
      >
        <div
          ref={navigation}
          id="workspace-navigation"
          className={
            menuOpen ? "workspace-navigation is-open" : "workspace-navigation"
          }
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !menuOpen) return;
            event.stopPropagation();
            closeNavigation(true);
          }}
        >
          <button
            type="button"
            aria-current={
              screen === "home"
                ? "page"
                : screen === "world" || screen === "create"
                  ? "location"
                  : undefined
            }
            disabled={navigationLocked}
            onClick={() => navigate("home")}
          >
            {uiText("我的世界")}
          </button>
          <button
            type="button"
            aria-current={
              screen === "library"
                ? "page"
                : screen === "content"
                  ? "location"
                  : undefined
            }
            disabled={navigationLocked}
            onClick={() => navigate("library")}
          >
            {uiText("内容库")}
          </button>
          <div
            ref={creationMenu}
            className="workspace-creation-tools"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !creationOpen) return;
              event.stopPropagation();
              closeCreation(true);
            }}
          >
            <button
              ref={creationToggle}
              type="button"
              aria-current={
                creativePage && !creationOpen ? "location" : undefined
              }
              aria-expanded={creationOpen}
              aria-controls="workspace-creation-destinations"
              disabled={navigationLocked}
              onClick={() => setCreationOpen(!creationOpen)}
            >
              {uiText("创作工具")}
              <span aria-hidden="true"> ▾</span>
            </button>
            <div
              id="workspace-creation-destinations"
              className="workspace-creation-destinations"
              hidden={!creationOpen}
            >
              {creationDestinations.map(([destination, label]) => (
                <button
                  key={destination}
                  type="button"
                  aria-current={screen === destination ? "page" : undefined}
                  disabled={navigationLocked}
                  onClick={() => navigate(destination)}
                >
                  {destination === "plays" && locale === "en"
                    ? "Orchestrations"
                    : uiText(label)}
                </button>
              ))}
              {canExportAndroidLogs() && (
                <button
                  type="button"
                  onClick={() => {
                    if (menuOpen) closeNavigation(true);
                    else closeCreation(true);
                    exportAndroidLogs();
                  }}
                >
                  {uiText("导出诊断日志")}
                </button>
              )}
            </div>
          </div>
        </div>
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
          <div className="workspace-model-control">
            <button
              type="button"
              className="workspace-model-button"
              aria-label={uiText("模型设置")}
              aria-current={screen === "model" ? "page" : undefined}
              title={activeModelName ?? uiText("尚未配置")}
              disabled={navigationLocked}
              onClick={() => navigate("model")}
            >
              <span
                className={`workspace-model-dot ${activeModelName === null ? "needs-attention" : "is-ready"}`}
                aria-hidden="true"
              />
              {uiText("模型设置")}
              {activeModelName !== null && (
                <span className="workspace-model-label" aria-hidden="true">
                  {activeModelName}
                </span>
              )}
            </button>
            {model.connections.some(
              ({ id }) => id !== model.activeConnectionId,
            ) && (
              <ModelConnectionSwitcher
                key={screen}
                model={model}
                busy={modelBusy}
                onOpen={() => closeNavigation()}
                onSelect={onSelectModel}
              />
            )}
          </div>
          <button
            ref={mobileToggle}
            id="workspace-menu-toggle"
            type="button"
            className="workspace-menu-toggle"
            aria-label={uiText("切换页面")}
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            disabled={navigationLocked}
            onClick={() => (menuOpen ? closeNavigation() : setMenuOpen(true))}
            onKeyDown={(event) => {
              if (event.key === "Escape" && menuOpen) closeNavigation(true);
            }}
          >
            ☰
          </button>
        </div>
      </nav>
    </header>
  );
}
