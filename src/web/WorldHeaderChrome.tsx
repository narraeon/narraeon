import styles from "./WorldHeaderChrome.module.css";
import { ArtifactExtensionMount } from "./ArtifactExtensionHost.tsx";
import { uiText } from "./i18n.ts";
import type { Ref } from "react";

export type WorldReadingRail = "documents" | "ai-reading";

export function WorldHeaderChrome({
  worldTitle,
  leftRailOpen,
  nowButtonRef,
  rightRail,
  rightRailId,
  documentsButtonRef,
  aiReadingButtonRef,
  readingOpen,
  readingButtonRef,
  readingPanelId,
  onBack,
  onToggleNow,
  onToggleRail,
  onToggleReading,
  onManage,
}: {
  worldTitle: string;
  leftRailOpen: boolean;
  nowButtonRef: Ref<HTMLButtonElement>;
  rightRail: WorldReadingRail | null;
  rightRailId: string;
  documentsButtonRef: Ref<HTMLButtonElement>;
  aiReadingButtonRef: Ref<HTMLButtonElement>;
  readingOpen: boolean;
  readingButtonRef: Ref<HTMLButtonElement>;
  readingPanelId: string;
  onBack?: (() => void) | undefined;
  onToggleNow: () => void;
  onToggleRail: (tab: WorldReadingRail) => void;
  onToggleReading: () => void;
  onManage: (opener: HTMLButtonElement) => void;
}) {
  return (
    <header className={`world-reader-header ${styles.readerHeader}`}>
      <nav
        className={`world-floating-chrome world-floating-chrome-left ${styles.chrome}`}
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
          ref={documentsButtonRef}
          type="button"
          className={rightRail === "documents" ? "is-current" : ""}
          aria-expanded={rightRail === "documents"}
          aria-controls={rightRailId}
          onClick={() => onToggleRail("documents")}
        >
          {uiText("世界")}
        </button>
        <button
          ref={aiReadingButtonRef}
          type="button"
          className={rightRail === "ai-reading" ? "is-current" : ""}
          aria-expanded={rightRail === "ai-reading"}
          aria-controls={rightRailId}
          onClick={() => onToggleRail("ai-reading")}
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
          className={styles.manage}
          aria-label={uiText("世界管理")}
          onClick={(event) => onManage(event.currentTarget)}
        >
          ⋯
        </button>
      </nav>
    </header>
  );
}
