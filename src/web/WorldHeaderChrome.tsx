import styles from "./WorldHeaderChrome.module.css";
import { uiText } from "./i18n.ts";

export type WorldReadingRail = "documents" | "ai-reading";

export function WorldHeaderChrome({
  worldTitle,
  leftRailOpen,
  rightRail,
  readingOpen,
  onBack,
  onToggleNow,
  onOpenRail,
  onToggleReading,
  onManage,
}: {
  worldTitle: string;
  leftRailOpen: boolean;
  rightRail: WorldReadingRail | null;
  readingOpen: boolean;
  onBack?: (() => void) | undefined;
  onToggleNow: () => void;
  onOpenRail: (tab: WorldReadingRail) => void;
  onToggleReading: () => void;
  onManage: (opener: HTMLButtonElement) => void;
}) {
  return (
    <>
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
          type="button"
          className={leftRailOpen ? "is-current" : ""}
          aria-pressed={leftRailOpen}
          onClick={onToggleNow}
        >
          {uiText("此刻")}
        </button>
      </nav>

      <h1 className={`world-floating-title ${styles.title}`} title={worldTitle}>
        {worldTitle}
      </h1>

      <nav
        className={`world-floating-chrome world-floating-chrome-right ${styles.chrome} ${styles.right}`}
        aria-label={uiText("世界阅读工具")}
      >
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
          type="button"
          className={readingOpen ? "is-current" : ""}
          aria-label={uiText("阅读设置")}
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
    </>
  );
}
