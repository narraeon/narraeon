import styles from "./WorldHeaderChrome.module.css";
import { ArtifactExtensionMount } from "./ArtifactExtensionHost.tsx";
import { uiText } from "./i18n.ts";
import { useLayoutEffect, useRef, type Ref } from "react";

export type WorldReadingRail = "documents" | "ai-reading";

export function WorldHeaderChrome({
  worldTitle,
  leftRailOpen,
  nowButtonRef,
  rightRail,
  readingOpen,
  readingButtonRef,
  readingPanelId,
  onBack,
  onToggleNow,
  onOpenRail,
  onToggleReading,
  onManage,
}: {
  worldTitle: string;
  leftRailOpen: boolean;
  nowButtonRef: Ref<HTMLButtonElement>;
  rightRail: WorldReadingRail | null;
  readingOpen: boolean;
  readingButtonRef: Ref<HTMLButtonElement>;
  readingPanelId: string;
  onBack?: (() => void) | undefined;
  onToggleNow: () => void;
  onOpenRail: (tab: WorldReadingRail) => void;
  onToggleReading: () => void;
  onManage: (opener: HTMLButtonElement) => void;
}) {
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (header === null) return;

    const updateOverlayTop = () => {
      const bottom = header.getBoundingClientRect().bottom;
      const zoom = header.currentCSSZoom || 1;
      header.style.setProperty(
        "--world-reader-header-bottom",
        `${bottom / zoom}px`,
      );
    };

    updateOverlayTop();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateOverlayTop);
    observer?.observe(header, { box: "border-box" });
    window.addEventListener("resize", updateOverlayTop);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateOverlayTop);
    };
  }, []);

  return (
    <header
      ref={headerRef}
      className={`world-reader-header ${styles.readerHeader}`}
    >
      <nav
        className={`world-floating-chrome world-floating-chrome-left ${styles.chrome} ${styles.left}`}
        aria-label={uiText("世界与状态")}
      >
        {onBack !== undefined && (
          <button
            type="button"
            onClick={onBack}
            aria-label={uiText("返回工作区")}
          >
            ←
          </button>
        )}
        <button
          ref={nowButtonRef}
          type="button"
          className={leftRailOpen ? "is-current" : ""}
          aria-pressed={leftRailOpen}
          onClick={onToggleNow}
        >
          {uiText("此刻")}
        </button>
      </nav>

      <h1
        className={`world-floating-title ${styles.readerTitle}`}
        title={worldTitle}
      >
        {worldTitle}
      </h1>

      <nav
        className={`world-floating-chrome world-floating-chrome-right ${styles.chrome} ${styles.right}`}
        aria-label={uiText("世界阅读工具")}
      >
        <ArtifactExtensionMount mount="overlay" />
        <button
          type="button"
          className={rightRail === "documents" ? "is-current" : ""}
          onClick={() => onOpenRail("documents")}
        >
          {uiText("世界")}
        </button>
        <button
          type="button"
          className={rightRail === "ai-reading" ? "is-current" : ""}
          onClick={() => onOpenRail("ai-reading")}
        >
          {uiText("AI 读取")}
        </button>
        <button
          ref={readingButtonRef}
          type="button"
          className={readingOpen ? "is-current" : ""}
          aria-label={uiText("阅读设置")}
          aria-expanded={readingOpen}
          aria-controls={readingOpen ? readingPanelId : undefined}
          onClick={onToggleReading}
        >
          Aa
        </button>
        <button
          type="button"
          aria-label={uiText("世界管理")}
          onClick={(event) => onManage(event.currentTarget)}
        >
          ···
        </button>
      </nav>
    </header>
  );
}
