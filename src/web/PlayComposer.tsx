import styles from "./PlayComposer.module.css";
import {
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { turnGuideLineSoftLimit } from "../shared/ordered-play-prompts.ts";
import { ArtifactExtensionMount } from "./ArtifactExtensionHost.tsx";
import { uiText } from "./i18n.ts";
import type { useConversationComposer } from "./useConversationComposer.ts";

const primaryLabels = {
  fresh: "从全新上下文发送行动",
  append: "追加行动",
  continue: "继续故事",
  retry: "重试本轮",
  resume: "继续本轮",
} as const;

const currentActionCopy = {
  first: ["发送第一步行动", "从当前世界重新编译材料"],
  current: ["接着当前对话继续", "保留原生对话，重新编译当前提示和材料"],
  retry: ["在当前对话重试本轮", "沿用上一次保存的请求。"],
  resume: ["接着暂停的本轮生成", "沿用暂停前保存的请求。"],
} as const;

export function PlayComposer({
  children,
  tools,
  compactStatus,
  dockRef,
  action,
  note,
  submission,
  disabled,
  showTechnicalInfo,
}: {
  children: ReactNode;
  tools: ReactNode;
  compactStatus?: string | undefined;
  dockRef: RefObject<HTMLElement | null>;
  action: {
    text: string;
    onChange: (text: string) => void;
    attach: (node: HTMLTextAreaElement | null) => void;
    ref: RefObject<HTMLTextAreaElement | null>;
  };
  note: {
    text: string;
    setText: Dispatch<SetStateAction<string>>;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    ref: RefObject<HTMLInputElement | null>;
  };
  submission: {
    composer: ReturnType<typeof useConversationComposer>;
    canAppend: boolean;
    canStartFresh: boolean;
    primaryAction: keyof typeof primaryLabels;
    currentAction: keyof typeof currentActionCopy;
    defaultSubmitEnabled: boolean;
    submitting: boolean;
    onSubmitAlternate: (mode: "append" | "fresh") => Promise<void>;
  };
  disabled: boolean;
  showTechnicalInfo: boolean;
}) {
  const {
    text: playerText,
    onChange: setPlayerText,
    attach: composerTextareaAttach,
    ref: composerTextareaRef,
  } = action;
  const {
    text: turnNote,
    setText: setTurnNote,
    open: turnNoteOpen,
    setOpen: setTurnNoteOpen,
    ref: turnNoteInputRef,
  } = note;
  const {
    composer,
    canAppend,
    canStartFresh,
    primaryAction,
    currentAction,
    defaultSubmitEnabled,
    submitting,
    onSubmitAlternate,
  } = submission;
  const submissionModeId = useId();
  const statusId = submissionModeId + "-status";
  const [shortStatusOpen, setShortStatusOpen] = useState(false);
  const composerMoreRef = useRef<HTMLDetailsElement>(null);
  const primaryLabel = uiText(primaryLabels[primaryAction]);
  const iconOnly = primaryAction === "fresh" || primaryAction === "append";
  const [currentLabel, currentDescription] = currentActionCopy[currentAction];
  return (
    <footer ref={dockRef} className={`world-composer-dock ${styles.dock}`}>
      <div
        id={statusId}
        className={`${styles.status}${shortStatusOpen ? ` ${styles.statusOpen}` : ""}`}
        role="region"
        aria-label={uiText("游玩状态")}
        tabIndex={0}
      >
        {children}
        {showTechnicalInfo ? (
          <p className={styles.hint}>
            {uiText(
              currentAction === "retry"
                ? "原样重试使用已保存请求，不采用新编排方案。"
                : currentAction === "resume"
                  ? "继续本轮沿用暂停前保存的请求。"
                  : "正常发送和空输入续写使用最新编排方案；本轮工具执行期间保持不变。",
            )}
          </p>
        ) : null}
      </div>
      <ArtifactExtensionMount mount="composer_above" />
      {turnNoteOpen ? (
        <div className={`world-turn-note ${styles.turnNote}`}>
          <div className={`world-turn-note-field ${styles.turnNoteField}`}>
            <span>{uiText("本轮")}</span>
            <input
              ref={turnNoteInputRef}
              type="text"
              aria-label={uiText("本轮临时要求内容")}
              value={turnNote}
              placeholder={uiText("只对这一轮生效，不进入故事")}
              disabled={disabled}
              onChange={(event) =>
                setTurnNote(event.currentTarget.value.replace(/[\r\n]/gu, ""))
              }
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  composerTextareaRef.current?.focus();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTurnNoteOpen(false);
                  composerTextareaRef.current?.focus();
                }
              }}
            />
            <button
              type="button"
              className={`world-turn-note-clear ${styles.clearNote}`}
              aria-label={uiText("清空并收起本轮临时要求")}
              disabled={disabled}
              onClick={() => {
                setTurnNote("");
                setTurnNoteOpen(false);
              }}
            >
              ✕
            </button>
          </div>
          {turnNote.length > turnGuideLineSoftLimit ? (
            <span className="field-note" role="status">
              {uiText("超过 120 字；仍会发送，但请尽量简短。")}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.tools}>
        <button
          className={styles.statusToggle}
          type="button"
          aria-expanded={shortStatusOpen}
          aria-controls={statusId}
          onClick={() => setShortStatusOpen((open) => !open)}
        >
          {uiText("游玩状态")}
          {compactStatus === undefined ? "" : ` · ${compactStatus}`}
        </button>
        {tools}
      </div>
      <div className={`world-composer-row ${styles.row}`}>
        <details
          ref={composerMoreRef}
          name="world-composer-menu"
          className={`world-composer-mode ${styles.more}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !event.currentTarget.open) return;
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}
        >
          <summary
            aria-label={uiText("更多")}
            className={turnNote === "" ? undefined : "has-turn-note"}
          >
            ⋯
          </summary>
          <div>
            <div
              className={styles.actionGroup}
              role="group"
              aria-labelledby={submissionModeId + "-edit-group"}
            >
              <p id={submissionModeId + "-edit-group"}>{uiText("编辑本轮")}</p>
              <button
                type="button"
                aria-labelledby={submissionModeId + "-note"}
                aria-describedby={submissionModeId + "-note-description"}
                aria-pressed={turnNoteOpen}
                disabled={disabled}
                onClick={() => {
                  if (composerMoreRef.current)
                    composerMoreRef.current.open = false;
                  setTurnNoteOpen((open) => !open);
                  if (turnNoteOpen) composerTextareaRef.current?.focus();
                }}
              >
                <strong id={submissionModeId + "-note"}>
                  {uiText("本轮临时要求")}
                </strong>
                <span id={submissionModeId + "-note-description"}>
                  {uiText("只对这一轮生效，不进入故事")}
                </span>
              </button>
              <button
                type="button"
                aria-labelledby={submissionModeId + "-wrap-up"}
                aria-describedby={submissionModeId + "-wrap-up-description"}
                disabled={disabled}
                onClick={() => {
                  if (composerMoreRef.current)
                    composerMoreRef.current.open = false;
                  const note = uiText(
                    "这段就在这里收尾，保存后续需要的信息，并登记检查点。",
                  );
                  setTurnNote((current) =>
                    current.includes(note)
                      ? current
                      : current.trim() === ""
                        ? note
                        : `${current} ${note}`,
                  );
                  setTurnNoteOpen(true);
                  turnNoteInputRef.current?.focus();
                }}
              >
                <strong id={submissionModeId + "-wrap-up"}>
                  {uiText("在此收尾")}
                </strong>
                <span id={submissionModeId + "-wrap-up-description"}>
                  {uiText(
                    "只填入本轮临时要求，供下次发送行动或继续故事时使用。点击不会发送。",
                  )}
                </span>
              </button>
            </div>
            <div
              className={styles.actionGroup}
              role="group"
              aria-labelledby={submissionModeId + "-send-group"}
            >
              <p id={submissionModeId + "-send-group"}>{uiText("立即发送")}</p>
              <button
                type="button"
                aria-labelledby={submissionModeId + "-append"}
                aria-describedby={submissionModeId + "-append-description"}
                disabled={!canAppend}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  void onSubmitAlternate("append");
                }}
              >
                <strong id={submissionModeId + "-append"}>
                  {uiText(currentLabel)}
                </strong>
                <span id={submissionModeId + "-append-description"}>
                  {uiText(currentDescription)}
                </span>
              </button>
              <button
                type="button"
                aria-labelledby={submissionModeId + "-fresh"}
                aria-describedby={submissionModeId + "-fresh-description"}
                disabled={!canStartFresh}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  void onSubmitAlternate("fresh");
                }}
              >
                <strong id={submissionModeId + "-fresh"}>
                  {uiText("用新对话继续（保留故事进度）")}
                </strong>
                <span id={submissionModeId + "-fresh-description"}>
                  {uiText("从当前世界重新编译材料")}
                </span>
              </button>
            </div>
          </div>
        </details>
        <label>
          <span className="visually-hidden">{uiText("你的行动")}</span>
          <textarea
            ref={composerTextareaAttach}
            aria-label={uiText("你的行动")}
            rows={1}
            placeholder={uiText("接下来，你要做什么？")}
            value={playerText}
            disabled={disabled}
            onChange={(event) => setPlayerText(event.target.value)}
            onKeyDown={composer.onKeyDown}
            enterKeyHint="enter"
            title={uiText(
              composer.enterInsertsNewline
                ? "回车换行，点击发送按钮发送"
                : "Enter 发送，Shift + Enter 换行",
            )}
          />
        </label>
        <button
          type="button"
          className={`world-composer-send ${styles.send}${iconOnly ? "" : ` ${styles.labeledSend}`}`}
          aria-label={primaryLabel}
          disabled={!defaultSubmitEnabled}
          onClick={() => void composer.submit()}
        >
          {submitting || iconOnly ? (
            <span aria-hidden="true">{submitting ? "…" : "↑"}</span>
          ) : (
            primaryLabel
          )}
        </button>
      </div>
      <ArtifactExtensionMount mount="composer_below" />
    </footer>
  );
}
