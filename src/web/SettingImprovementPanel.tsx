import { useMemo, useRef, useState } from "react";

import type {
  ContentTreeFile,
  V1SettingConversationExchange,
  V1SettingConversationTurn,
  V1SettingAuthoringDiff,
  V1SettingImprovementHistoryItem,
  V1SettingImprovementRollbackResult,
  V1SettingImprovementView,
} from "../protocol/v1.ts";
import {
  ContentTreeEditor,
  type ContentTreeEditorProps,
} from "./ContentTreeEditor.tsx";
import { ModelUsageBreakdown } from "./ModelUsageBreakdown.tsx";
import { getWebLocale, uiText } from "./i18n.ts";
import { UnifiedTextDiff } from "./UnifiedTextDiff.tsx";

export type SettingImprovementView = V1SettingImprovementView;

interface SettingImprovementPanelProps {
  packageName: string;
  modelConfigured: boolean;
  hasUnsavedFileDraft: boolean;
  loading: boolean;
  view: SettingImprovementView | null;
  history: V1SettingImprovementHistoryItem[];
  latestSessionId: string | null;
  notice: string;
  requestFailure: string | null;
  now: number;
  contentEditor: ContentTreeEditorProps;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onFreshContext: () => void;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRollbackChangeSet: (
    sessionId: string,
    changeSetId: string,
  ) => Promise<V1SettingImprovementRollbackResult>;
  onConfigureModel: () => void;
  onBack: () => void;
}

type FileRailMode = "preview" | "edit";

export function SettingImprovementPanel({
  packageName,
  modelConfigured,
  hasUnsavedFileDraft,
  loading,
  view,
  history,
  latestSessionId,
  notice,
  requestFailure,
  now,
  contentEditor,
  onSend,
  onCancel,
  onFreshContext,
  onSelectSession,
  onDeleteSession,
  onRollbackChangeSet,
  onConfigureModel,
  onBack,
}: SettingImprovementPanelProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [fileRailMode, setFileRailMode] = useState<FileRailMode>("preview");
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [rollingBackChangeSetId, setRollingBackChangeSetId] = useState<
    string | null
  >(null);
  const conversationRef = useRef<HTMLElement>(null);
  const running = view?.runStatus === "running" || submitting;
  const rollbackRunning = rollingBackChangeSetId !== null;
  const interactionLocked = running || rollbackRunning;
  const startingFresh = view === null;
  const continuingHistory =
    view !== null &&
    latestSessionId !== null &&
    view.sessionId !== latestSessionId;
  const disabled =
    loading || interactionLocked || !modelConfigured || hasUnsavedFileDraft;
  const rollbackDisabled = loading || interactionLocked || hasUnsavedFileDraft;

  const send = async (): Promise<void> => {
    const text = message;
    if (disabled || text.trim().length === 0) return;
    setSubmitting(true);
    setMessage("");
    setRightRailOpen(false);
    try {
      await onSend(text);
    } catch {
      setMessage((current) => (current.length === 0 ? text : current));
    } finally {
      setSubmitting(false);
    }
  };

  const openFileRail = (mode: FileRailMode): void => {
    if (mode === "edit" && interactionLocked) return;
    setFileRailMode(mode);
    setRightRailOpen(true);
    setLeftRailOpen(false);
  };

  const collapseAllTraces = (): void => {
    for (const detail of conversationRef.current?.querySelectorAll(
      "details[open]",
    ) ?? [])
      detail.removeAttribute("open");
  };

  const deleteSession = async (
    item: V1SettingImprovementHistoryItem,
  ): Promise<void> => {
    if (
      item.runStatus === "running" ||
      deletingSessionId !== null ||
      !globalThis.confirm(
        uiText(
          "删除对话“{title}”？内容包当前树不会改变，但这段历史中的一键回滚入口也会一并删除。此操作无法撤销。",
          { title: item.excerpt || uiText("未命名对话") },
        ),
      )
    )
      return;
    setDeletingSessionId(item.sessionId);
    try {
      await onDeleteSession(item.sessionId);
    } catch {
      // The parent projects the Runtime failure into the conversation surface.
    } finally {
      setDeletingSessionId(null);
    }
  };

  const rollbackChangeSet = async (
    changeSetId: string,
    changes: readonly V1SettingAuthoringDiff[],
  ): Promise<void> => {
    if (
      view === null ||
      rollbackDisabled ||
      !globalThis.confirm(
        uiText(
          "回滚这次 AI 修改？此次工具调用涉及的 {count} 个文件会一起恢复到修改前版本；对话历史仍会保留。",
          { count: changes.length },
        ),
      )
    )
      return;
    setLeftRailOpen(false);
    setRightRailOpen(false);
    setRollingBackChangeSetId(changeSetId);
    try {
      await onRollbackChangeSet(view.sessionId, changeSetId);
    } catch {
      // The parent projects the Runtime failure into the conversation surface.
    } finally {
      setRollingBackChangeSetId(null);
    }
  };

  return (
    <main
      className="setting-reader-page"
      aria-labelledby="setting-improvement-title"
    >
      <div className="setting-reader-shell">
        <nav
          className="world-floating-chrome world-floating-chrome-left setting-floating-chrome"
          aria-label={uiText("设定完善导航")}
        >
          <button
            type="button"
            disabled={interactionLocked || hasUnsavedFileDraft}
            onClick={onBack}
            aria-label={uiText("返回工作区")}
          >
            ←
          </button>
          <button
            type="button"
            className={leftRailOpen ? "is-current" : ""}
            aria-pressed={leftRailOpen}
            onClick={() => {
              setLeftRailOpen((open) => !open);
              setRightRailOpen(false);
            }}
          >
            {uiText("历史")}
          </button>
        </nav>

        <h1
          id="setting-improvement-title"
          className="world-floating-title setting-floating-title"
          title={packageName}
        >
          {packageName} · {uiText("AI 设定完善")}
        </h1>

        <nav
          className="world-floating-chrome world-floating-chrome-right setting-floating-chrome"
          aria-label={uiText("设定完善工具")}
        >
          <button
            type="button"
            className={
              rightRailOpen && fileRailMode === "preview" ? "is-current" : ""
            }
            onClick={() => openFileRail("preview")}
          >
            {uiText("文件")}
          </button>
          <button
            type="button"
            className={
              rightRailOpen && fileRailMode === "edit" ? "is-current" : ""
            }
            disabled={interactionLocked}
            onClick={() => openFileRail("edit")}
          >
            {uiText("编辑")}
          </button>
          <button type="button" onClick={collapseAllTraces}>
            {uiText("全部收起")}
          </button>
          <button
            type="button"
            disabled={interactionLocked}
            onClick={onFreshContext}
          >
            {uiText("全新上下文")}
          </button>
        </nav>

        <section
          ref={conversationRef}
          className="setting-reader-scroll"
          aria-label={uiText("设定完善对话")}
        >
          <article
            className="setting-story-column"
            aria-live="polite"
            aria-busy={interactionLocked}
          >
            <header className="setting-conversation-intro">
              <span className="eyebrow">AUTHORING CONVERSATION</span>
              <h2>{uiText("和 AI 边聊边改")}</h2>
              <p>
                {uiText(
                  "成功的工具改动直接写入内容包当前树；需要核对或手动修改时，从右侧打开文件。",
                )}
              </p>
            </header>

            {notice.length === 0 ? null : (
              <p className="setting-workspace-feedback" role="status">
                {notice}
              </p>
            )}

            {!modelConfigured ? (
              <section className="setting-improvement-blocker" role="status">
                <p>{uiText("先配置并启用模型，才能开始设定完善对话。")}</p>
                <button
                  type="button"
                  disabled={hasUnsavedFileDraft}
                  onClick={onConfigureModel}
                >
                  {uiText("配置模型")}
                </button>
              </section>
            ) : null}

            {hasUnsavedFileDraft ? (
              <p className="setting-improvement-warning" role="status">
                {uiText("请先保存或放弃文件编辑中的未保存修改。")}
              </p>
            ) : null}

            <p className="setting-current-tree-notice" role="note">
              {uiText(
                "这里没有隔离草稿或应用步骤：每个已完成工具响应的绿色新增和红色删除都已经生效。",
              )}
            </p>

            {startingFresh && history.length > 0 ? (
              <div className="setting-history-review-banner" role="status">
                <div>
                  <strong>{uiText("下一条消息将开启全新上下文")}</strong>
                  <p>
                    {uiText(
                      "新对话会从内容包当前树重新编译；原有对话仍保留在历史中。",
                    )}
                  </p>
                </div>
              </div>
            ) : continuingHistory ? (
              <div className="setting-history-review-banner" role="status">
                <div>
                  <strong>{uiText("正在继续历史对话")}</strong>
                  <p>
                    {uiText(
                      "下一条消息会追加到这段历史的原 Provider 上下文；写入仍以此刻的内容包当前树为准。",
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="setting-conversation-messages">
              {loading ? (
                <p className="setting-conversation-empty">
                  {uiText("正在恢复设定完善对话…")}
                </p>
              ) : view === null || view.turns.length === 0 ? (
                <div className="setting-conversation-empty">
                  <p>{uiText("直接说你现在想做什么。")}</p>
                  <p>
                    {uiText(
                      "例如：先帮我梳理人物关系；或者直接把开场改成雨夜码头，并同步当前情境。",
                    )}
                  </p>
                </div>
              ) : (
                view.turns.map((turn) => (
                  <SettingConversationTurnView
                    key={turn.id}
                    turn={turn}
                    currentFiles={contentEditor.files}
                    rollbackDisabled={rollbackDisabled}
                    rollingBackChangeSetId={rollingBackChangeSetId}
                    onRollbackChangeSet={rollbackChangeSet}
                  />
                ))
              )}

              {running ? (
                <SettingConversationProgress view={view} now={now} />
              ) : null}
              {view?.legacyDraft !== null && view?.legacyDraft !== undefined ? (
                <LegacyDraftHistory legacy={view.legacyDraft} />
              ) : null}
              {view?.lastFailure !== null && view?.lastFailure !== undefined ? (
                <div className="setting-conversation-failure" role="alert">
                  <strong>{uiText("上一次操作未完成")}</strong>
                  <p>{view.lastFailure}</p>
                  <p>
                    {uiText(
                      "完整对话和已经结算的当前树改动都已保留，可以直接继续说。",
                    )}
                  </p>
                </div>
              ) : null}
              {requestFailure !== null ? (
                <div className="setting-conversation-failure" role="alert">
                  {requestFailure}
                </div>
              ) : null}
              {view === null ? null : (
                <ModelUsageBreakdown usage={view.usage} />
              )}
            </div>
          </article>
        </section>

        <footer className="setting-conversation-composer">
          <label htmlFor="setting-conversation-input">
            {startingFresh
              ? uiText("用全新上下文给 AI 发消息")
              : uiText("继续这段对话")}
          </label>
          <div className="setting-conversation-composer-row">
            <textarea
              id="setting-conversation-input"
              rows={2}
              value={message}
              disabled={disabled}
              placeholder={uiText(
                "可以讨论、要求它检查某份设定，也可以直接让它修改内容包。",
              )}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {running && view !== null ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onCancel()}
              >
                {uiText("停止回复")}
              </button>
            ) : (
              <button
                type="button"
                disabled={disabled || message.trim().length === 0}
                onClick={() => void send()}
              >
                {uiText("发送")}
              </button>
            )}
          </div>
          <span className="field-note">
            {uiText("Enter 发送，Shift + Enter 换行")}
          </span>
        </footer>

        <button
          type="button"
          className={
            leftRailOpen || rightRailOpen
              ? "setting-panel-scrim is-visible"
              : "setting-panel-scrim"
          }
          aria-label={uiText("收起侧栏")}
          aria-hidden={!leftRailOpen && !rightRailOpen}
          tabIndex={leftRailOpen || rightRailOpen ? 0 : -1}
          onClick={() => {
            setLeftRailOpen(false);
            setRightRailOpen(false);
          }}
        />

        <aside
          className={
            leftRailOpen
              ? "setting-overlay-rail setting-overlay-rail-left is-open"
              : "setting-overlay-rail setting-overlay-rail-left"
          }
          aria-hidden={!leftRailOpen}
          aria-label={uiText("设定完善对话历史")}
        >
          <header>
            <div>
              <span>CONVERSATIONS</span>
              <strong>{uiText("历史")}</strong>
            </div>
            <button
              type="button"
              aria-label={uiText("收起对话历史")}
              onClick={() => setLeftRailOpen(false)}
            >
              ×
            </button>
          </header>
          <div className="setting-overlay-rail-body">
            <SettingConversationHistory
              history={history}
              latestSessionId={latestSessionId}
              selectedSessionId={view?.sessionId ?? null}
              loading={loading || rollbackRunning}
              deletingSessionId={deletingSessionId}
              onSelectSession={async (sessionId) => {
                await onSelectSession(sessionId);
                setLeftRailOpen(false);
              }}
              onDeleteSession={deleteSession}
            />
          </div>
        </aside>

        <aside
          className={`setting-overlay-rail setting-overlay-rail-right ${
            fileRailMode === "edit" ? "is-editing" : ""
          } ${rightRailOpen ? "is-open" : ""}`}
          aria-hidden={!rightRailOpen}
          aria-label={
            fileRailMode === "edit"
              ? uiText("内容包文件编辑")
              : uiText("内容包文件预览")
          }
        >
          <header>
            <div>
              <span>CONTENT TREE</span>
              <strong>
                {fileRailMode === "edit"
                  ? uiText("编辑文件")
                  : uiText("预览文件")}
              </strong>
            </div>
            <button
              type="button"
              aria-label={uiText("收起文件面板")}
              onClick={() => setRightRailOpen(false)}
            >
              ×
            </button>
          </header>
          <nav aria-label={uiText("内容包文件视图")}>
            <button
              type="button"
              className={fileRailMode === "preview" ? "is-current" : ""}
              onClick={() => setFileRailMode("preview")}
            >
              {uiText("预览")}
            </button>
            <button
              type="button"
              className={fileRailMode === "edit" ? "is-current" : ""}
              disabled={interactionLocked}
              onClick={() => setFileRailMode("edit")}
            >
              {uiText("编辑")}
            </button>
          </nav>
          <div className="setting-overlay-rail-body">
            {fileRailMode === "preview" ? (
              <SettingContentPreview
                files={contentEditor.files}
                dirty={contentEditor.dirty}
                selectedPath={selectedFilePath}
                onSelect={setSelectedFilePath}
                onEdit={() => setFileRailMode("edit")}
                editDisabled={interactionLocked}
              />
            ) : (
              <ContentTreeEditor
                {...contentEditor}
                selectedPath={selectedFilePath}
                onSelectedPathChange={setSelectedFilePath}
                embedded
              />
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function SettingConversationHistory({
  history,
  latestSessionId,
  selectedSessionId,
  loading,
  deletingSessionId,
  onSelectSession,
  onDeleteSession,
}: {
  history: readonly V1SettingImprovementHistoryItem[];
  latestSessionId: string | null;
  selectedSessionId: string | null;
  loading: boolean;
  deletingSessionId: string | null;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (item: V1SettingImprovementHistoryItem) => Promise<void>;
}): React.JSX.Element {
  return (
    <section
      className="setting-conversation-history"
      aria-labelledby="setting-conversation-history-title"
    >
      <header>
        <div>
          <span className="eyebrow">CONTENT PACKAGE</span>
          <h2 id="setting-conversation-history-title">{uiText("对话历史")}</h2>
        </div>
        <span>{uiText("{count} 次对话", { count: history.length })}</span>
      </header>
      {history.length === 0 ? (
        <p className="field-note">
          {uiText("开始后，对话、Provider 返回内容和已生效差异会保留在这里。")}
        </p>
      ) : (
        <ol aria-label={uiText("设定完善对话历史")}>
          {history.map((item) => {
            const selected = item.sessionId === selectedSessionId;
            const deleting = item.sessionId === deletingSessionId;
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  className={
                    selected
                      ? "setting-history-select is-selected"
                      : "setting-history-select"
                  }
                  aria-pressed={selected}
                  disabled={loading || deleting}
                  onClick={() => void onSelectSession(item.sessionId)}
                >
                  <span className="setting-history-item-main">
                    <strong>{item.excerpt || uiText("未命名对话")}</strong>
                    <small>{formatHistoryTime(item.createdAt)}</small>
                  </span>
                  <span
                    className={`setting-history-status is-${item.runStatus}`}
                  >
                    {item.runStatus === "running"
                      ? uiText("回复中")
                      : item.sessionId === selectedSessionId
                        ? uiText("当前所选")
                        : item.sessionId === latestSessionId
                          ? uiText("最近")
                          : uiText("可继续")}
                  </span>
                  <small className="setting-history-counts">
                    {uiText(
                      "{turns} 轮对话 · {tools} 次工具 · {files} 个文件",
                      {
                        turns: item.turnCount,
                        tools: item.toolCallCount,
                        files: item.changedFileCount,
                      },
                    )}
                  </small>
                </button>
                <button
                  type="button"
                  className="setting-history-delete"
                  aria-label={uiText("删除对话：{title}", {
                    title: item.excerpt || uiText("未命名对话"),
                  })}
                  disabled={
                    loading ||
                    deletingSessionId !== null ||
                    item.runStatus === "running"
                  }
                  onClick={() => void onDeleteSession(item)}
                >
                  {deleting ? "…" : uiText("删除")}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SettingContentPreview({
  files,
  dirty,
  selectedPath,
  onSelect,
  onEdit,
  editDisabled,
}: {
  files: readonly ContentTreeFile[];
  dirty: boolean;
  selectedPath: string;
  onSelect: (path: string) => void;
  onEdit: () => void;
  editDisabled: boolean;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const ordered = useMemo(
    () => [...files].sort((left, right) => left.path.localeCompare(right.path)),
    [files],
  );
  const selected =
    ordered.find(({ path }) => path === selectedPath) ??
    ordered.find(({ path }) => path === "opening.md") ??
    ordered[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible =
    normalizedQuery.length === 0
      ? ordered
      : ordered.filter(({ path }) =>
          path.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
        );

  return (
    <div className="setting-content-preview">
      <header>
        <div>
          <strong>{uiText("内容包当前树")}</strong>
          <small>
            {dirty
              ? uiText("正在预览未保存的文件草稿")
              : uiText("正在预览已保存的当前树")}
          </small>
        </div>
        <span>{uiText("{count} 份文件", { count: files.length })}</span>
      </header>
      <label>
        <span>{uiText("筛选文件")}</span>
        <input
          type="search"
          value={query}
          placeholder={uiText("人物、地点或文件名")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <nav aria-label={uiText("内容包文件树")}>
        {visible.length === 0 ? (
          <p>{uiText("没有匹配的文件。")}</p>
        ) : (
          visible.map((file) => (
            <button
              type="button"
              key={file.path}
              className={file.path === selected?.path ? "is-current" : ""}
              aria-pressed={file.path === selected?.path}
              onClick={() => onSelect(file.path)}
            >
              <code>{file.path}</code>
            </button>
          ))
        )}
      </nav>
      {selected === undefined ? (
        <div className="setting-content-preview-empty">
          <p>{uiText("当前内容包还没有文件。")}</p>
          <button type="button" disabled={editDisabled} onClick={onEdit}>
            {uiText("新建第一份文件")}
          </button>
        </div>
      ) : (
        <article>
          <header>
            <code>{selected.path}</code>
            <button type="button" disabled={editDisabled} onClick={onEdit}>
              {uiText("编辑这份文件")}
            </button>
          </header>
          {selected.encoding === "base64" ? (
            <p>{uiText("二进制资源不在文本预览中展开。")}</p>
          ) : (
            <pre>{selected.contents}</pre>
          )}
        </article>
      )}
    </div>
  );
}

function SettingConversationTurnView({
  turn,
  currentFiles,
  rollbackDisabled,
  rollingBackChangeSetId,
  onRollbackChangeSet,
}: {
  turn: V1SettingConversationTurn;
  currentFiles: readonly ContentTreeFile[];
  rollbackDisabled: boolean;
  rollingBackChangeSetId: string | null;
  onRollbackChangeSet: (
    changeSetId: string,
    changes: readonly V1SettingAuthoringDiff[],
  ) => Promise<void>;
}): React.JSX.Element {
  const traces = turn.exchanges.filter(exchangeHasTrace);
  const traceCount = traces.reduce(
    (count, exchange) =>
      count +
      exchange.toolCalls.length +
      (exchange.reasoning?.length ? 1 : 0) +
      (exchange.toolCalls.length > 0 && exchange.text.length > 0 ? 1 : 0),
    0,
  );
  return (
    <section className="setting-conversation-turn">
      <article className="setting-conversation-message setting-conversation-user">
        <span className="setting-conversation-role">{uiText("你")}</span>
        <p>{turn.user.text}</p>
      </article>
      {turn.exchanges.map((exchange) =>
        exchange.toolCalls.length === 0 && exchange.text.length > 0 ? (
          <article
            className="setting-conversation-message setting-conversation-assistant"
            key={`text:${exchange.id}`}
          >
            <span className="setting-conversation-role">{uiText("AI")}</span>
            <p>{exchange.text}</p>
          </article>
        ) : null,
      )}
      {traces.length === 0 ? null : (
        <details className="setting-turn-trace">
          <summary>
            <span>{uiText("本段调用详情")}</span>
            <small>
              {uiText("{count} 项记录", {
                count: traceCount,
              })}
            </small>
          </summary>
          <div className="setting-turn-trace-exchanges">
            {traces.map((exchange) => (
              <SettingConversationExchangeTrace
                key={exchange.id}
                exchange={exchange}
                currentFiles={currentFiles}
                rollbackDisabled={rollbackDisabled}
                rollingBackChangeSetId={rollingBackChangeSetId}
                onRollbackChangeSet={onRollbackChangeSet}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function exchangeHasTrace(exchange: V1SettingConversationExchange): boolean {
  return (exchange.reasoning?.length ?? 0) > 0 || exchange.toolCalls.length > 0;
}

function SettingConversationExchangeTrace({
  exchange,
  currentFiles,
  rollbackDisabled,
  rollingBackChangeSetId,
  onRollbackChangeSet,
}: {
  exchange: V1SettingConversationExchange;
  currentFiles: readonly ContentTreeFile[];
  rollbackDisabled: boolean;
  rollingBackChangeSetId: string | null;
  onRollbackChangeSet: (
    changeSetId: string,
    changes: readonly V1SettingAuthoringDiff[],
  ) => Promise<void>;
}): React.JSX.Element {
  return (
    <details className="setting-conversation-trace">
      <summary>
        <strong>
          {uiText("第 {exchange} 次模型交换", {
            exchange: exchange.exchange,
          })}
        </strong>
        <span>
          {uiText("{count} 次工具调用", {
            count: exchange.toolCalls.length,
          })}
        </span>
      </summary>
      <div className="setting-conversation-trace-body">
        {exchange.reasoning === undefined ||
        exchange.reasoning.length === 0 ? null : (
          <details className="setting-exchange-reasoning">
            <summary>{uiText("Provider 返回推理（不等同隐藏思维链）")}</summary>
            <pre>{exchange.reasoning}</pre>
          </details>
        )}
        {exchange.toolCalls.length > 0 && exchange.text.length > 0 ? (
          <details className="setting-exchange-step-text">
            <summary>{uiText("查看工具步骤文本（未进入最终回复）")}</summary>
            <p>{exchange.text}</p>
          </details>
        ) : null}
        {exchange.toolCalls.map((call) => (
          <details
            className={`setting-exchange-tool ${call.result?.isError === true ? "is-error" : "is-ok"}`}
            key={call.callId}
          >
            <summary>
              <strong>{uiText("调用 {tool}", { tool: call.name })}</strong>
              <span>
                {call.result === null
                  ? uiText("等待 Runtime 结果")
                  : call.result.isError
                    ? uiText("拒绝／失败")
                    : call.result.changes.length > 0
                      ? uiText("当时生效 · {count} 个文件", {
                          count: call.result.changes.length,
                        })
                      : uiText("成功")}
              </span>
            </summary>
            <h5>{uiText("工具参数")}</h5>
            <pre>{safeJson(call.arguments)}</pre>
            {call.result === null ? null : (
              <>
                <h5>{uiText("Runtime 工具结果")}</h5>
                <pre>{call.result.markdown}</pre>
                <AcceptedChanges changes={call.result.changes} />
                {call.result.changeSetId === null ? null : (
                  <ChangeSetRollbackControl
                    changeSetId={call.result.changeSetId}
                    changes={call.result.changes}
                    currentFiles={currentFiles}
                    disabled={rollbackDisabled}
                    rolling={rollingBackChangeSetId === call.result.changeSetId}
                    onRollback={onRollbackChangeSet}
                  />
                )}
              </>
            )}
          </details>
        ))}
      </div>
    </details>
  );
}

function AcceptedChanges({
  changes,
  heading = uiText("当时已生效差异"),
}: {
  changes: readonly V1SettingAuthoringDiff[];
  heading?: string;
}): React.JSX.Element | null {
  if (changes.length === 0) return null;
  return (
    <section className="setting-accepted-changes" aria-label={heading}>
      <h5>{heading}</h5>
      {changes.map((diff) => (
        <details
          key={`${diff.kind}-${diff.path}`}
          className="setting-change-diff"
        >
          <summary>
            <span className={`setting-diff-kind setting-diff-${diff.kind}`}>
              {diff.kind === "create"
                ? uiText("新增")
                : diff.kind === "delete"
                  ? uiText("删除")
                  : uiText("修改")}
            </span>
            <code>{diff.path}</code>
          </summary>
          <UnifiedTextDiff
            before={diff.before}
            after={diff.after}
            label={uiText("{path} 的完整差异", { path: diff.path })}
          />
        </details>
      ))}
    </section>
  );
}

function ChangeSetRollbackControl({
  changeSetId,
  changes,
  currentFiles,
  disabled,
  rolling,
  onRollback,
}: {
  changeSetId: string;
  changes: readonly V1SettingAuthoringDiff[];
  currentFiles: readonly ContentTreeFile[];
  disabled: boolean;
  rolling: boolean;
  onRollback: (
    changeSetId: string,
    changes: readonly V1SettingAuthoringDiff[],
  ) => Promise<void>;
}): React.JSX.Element {
  const state = currentTreeChangeSetState(currentFiles, changes);
  return (
    <div className={`setting-change-rollback is-${state}`}>
      {state === "available" ? (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => void onRollback(changeSetId, changes)}
        >
          {rolling ? uiText("正在回滚…") : uiText("回滚这次 AI 修改")}
        </button>
      ) : state === "already_rolled_back" ? (
        <span>{uiText("当前树已回到这次修改前的版本")}</span>
      ) : (
        <span>{uiText("相关文件后来又有改动，不能直接回滚")}</span>
      )}
    </div>
  );
}

function currentTreeChangeSetState(
  files: readonly ContentTreeFile[],
  changes: readonly V1SettingAuthoringDiff[],
): "available" | "already_rolled_back" | "conflicted" {
  if (treeMatchesDiffSide(files, changes, "before"))
    return "already_rolled_back";
  return treeMatchesDiffSide(files, changes, "after")
    ? "available"
    : "conflicted";
}

function treeMatchesDiffSide(
  files: readonly ContentTreeFile[],
  changes: readonly V1SettingAuthoringDiff[],
  side: "before" | "after",
): boolean {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  return changes.every((change) => {
    const expected = change[side];
    const current = byPath.get(change.path);
    if (expected === null) return current === undefined;
    return (
      current !== undefined &&
      current.encoding === undefined &&
      current.contents === expected
    );
  });
}

function LegacyDraftHistory({
  legacy,
}: {
  legacy: NonNullable<V1SettingImprovementView["legacyDraft"]>;
}): React.JSX.Element {
  return (
    <details className="setting-legacy-draft-history">
      <summary>{uiText("迁移前的隔离草稿记录（仅回顾）")}</summary>
      <p>
        {legacy.outcome === "applied"
          ? uiText("这份旧草稿在迁移前已经应用。")
          : legacy.outcome === "discarded"
            ? uiText("这份旧草稿在迁移前已经放弃。")
            : legacy.outcome === "apply_outcome_unknown"
              ? uiText("旧应用收据的结果无法确认；迁移没有改写当前树。")
              : uiText("这份旧草稿没有自动应用；当前树保持迁移时的真实状态。")}
      </p>
      <AcceptedChanges
        changes={legacy.changes}
        heading={
          legacy.outcome === "applied"
            ? uiText("迁移前已应用的差异")
            : legacy.outcome === "apply_outcome_unknown"
              ? uiText("迁移前草稿差异（结果未知）")
              : uiText("迁移前草稿差异（未生效）")
        }
      />
    </details>
  );
}

function SettingConversationProgress({
  view,
  now,
}: {
  view: SettingImprovementView | null;
  now: number;
}): React.JSX.Element {
  const progress = view?.progress;
  const stream = progress?.streaming;
  const silence =
    stream === null || stream === undefined
      ? null
      : Math.max(0, Math.round((now - stream.receivedAt) / 1000));
  const chars =
    stream === null || stream === undefined
      ? 0
      : stream.reasoningChars + stream.textChars + stream.toolChars;
  const hasLiveTrace =
    (stream?.reasoningText?.length ?? 0) > 0 ||
    (stream?.toolFragment?.length ?? 0) > 0;
  return (
    <div className="setting-conversation-running" role="status">
      <span className="setting-conversation-spinner" aria-hidden="true" />
      <div>
        <strong>{uiText("AI 正在处理…")}</strong>
        <p>
          {uiText(
            "第 {exchange} 次模型交换 · {tools} 次工具调用 · 已接收 {chars} 字",
            {
              exchange: progress?.exchange ?? 0,
              tools: progress?.toolCalls ?? 0,
              chars,
            },
          )}
        </p>
        {silence !== null && silence >= 90 ? (
          <p className="setting-run-age-stalled">
            {uiText("已 {seconds} 秒没有收到新片段，可以停止后继续对话。", {
              seconds: silence,
            })}
          </p>
        ) : null}
        {!stream?.visibleText?.length && stream?.tail.trim() ? (
          <p>{stream.tail}</p>
        ) : null}
        {stream?.visibleText?.length ? (
          <div className="setting-live-response">
            <strong>{uiText("正在接收的正文")}</strong>
            <pre>{stream.visibleText}</pre>
          </div>
        ) : null}
        {hasLiveTrace ? (
          <details className="setting-live-trace-group">
            <summary>{uiText("正在接收调用详情")}</summary>
            {stream?.reasoningText?.length ? (
              <details className="setting-live-trace">
                <summary>
                  {uiText("Provider 返回推理（不等同隐藏思维链）")}
                </summary>
                <pre>{stream.reasoningText}</pre>
              </details>
            ) : null}
            {stream?.toolFragment?.length ? (
              <details className="setting-live-trace">
                <summary>{uiText("正在接收的工具调用片段")}</summary>
                <pre>{stream.toolFragment}</pre>
              </details>
            ) : null}
          </details>
        ) : null}
      </div>
    </div>
  );
}

function formatHistoryTime(value: number): string {
  return new Intl.DateTimeFormat(getWebLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return uiText("[参数无法序列化]");
  }
}
