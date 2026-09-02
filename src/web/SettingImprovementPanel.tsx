import { useState } from "react";

import type {
  V1SettingConversationExchange,
  V1SettingConversationTurn,
  V1SettingAuthoringDiff,
  V1SettingImprovementHistoryItem,
  V1SettingImprovementView,
} from "../protocol/v1.ts";
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
  requestFailure: string | null;
  now: number;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onFreshContext: () => void;
  onSelectSession: (sessionId: string) => Promise<void>;
  onConfigureModel: () => void;
}

export function SettingImprovementPanel({
  packageName,
  modelConfigured,
  hasUnsavedFileDraft,
  loading,
  view,
  history,
  latestSessionId,
  requestFailure,
  now,
  onSend,
  onCancel,
  onFreshContext,
  onSelectSession,
  onConfigureModel,
}: SettingImprovementPanelProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const running = view?.runStatus === "running" || submitting;
  const startingFresh = view === null;
  const continuingHistory =
    view !== null &&
    latestSessionId !== null &&
    view.sessionId !== latestSessionId;
  const disabled =
    loading || running || !modelConfigured || hasUnsavedFileDraft;

  const send = async (): Promise<void> => {
    const text = message;
    if (disabled || text.trim().length === 0) return;
    setSubmitting(true);
    setMessage("");
    try {
      await onSend(text);
    } catch {
      setMessage((current) => (current.length === 0 ? text : current));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="setting-improvement-workspace setting-conversation-workspace"
      aria-labelledby="setting-improvement-title"
    >
      <header className="setting-improvement-header">
        <div>
          <h2 id="setting-improvement-title">{uiText("AI 设定完善")}</h2>
          <p className="setting-improvement-intro">
            {uiText(
              "和 AI 边聊边修改 {packageName}。成功的工具改动会像游玩一样直接写入内容包当前树。",
              { packageName },
            )}
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={running}
          onClick={onFreshContext}
        >
          {uiText("全新上下文")}
        </button>
      </header>

      {!modelConfigured ? (
        <section className="setting-improvement-blocker" role="status">
          <p>{uiText("先配置并启用模型，才能开始设定完善对话。")}</p>
          <button type="button" onClick={onConfigureModel}>
            {uiText("配置模型")}
          </button>
        </section>
      ) : null}

      {hasUnsavedFileDraft ? (
        <p className="setting-improvement-warning" role="status">
          {uiText("请先保存或放弃文件编辑中的未保存修改。")}
        </p>
      ) : null}

      <p className="setting-current-tree-notice" role="status">
        {uiText(
          "这里没有隔离草稿或应用步骤：每个已完成工具响应的绿色新增和红色删除都已经生效。",
        )}
      </p>

      <SettingConversationHistory
        history={history}
        latestSessionId={latestSessionId}
        selectedSessionId={view?.sessionId ?? null}
        loading={loading}
        onSelectSession={onSelectSession}
      />

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

      <div className="setting-conversation-layout">
        <div className="setting-conversation-main">
          <div
            className="setting-conversation-messages"
            aria-live="polite"
            aria-busy={running}
          >
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
                <SettingConversationTurnView key={turn.id} turn={turn} />
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
            {view === null ? null : <ModelUsageBreakdown usage={view.usage} />}
          </div>

          <div className="setting-conversation-composer">
            <label htmlFor="setting-conversation-input">
              {startingFresh
                ? uiText("用全新上下文给 AI 发消息")
                : uiText("继续这段对话")}
            </label>
            <textarea
              id="setting-conversation-input"
              rows={4}
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
            <div className="setting-conversation-composer-actions">
              <span className="field-note">
                {uiText("Enter 发送，Shift + Enter 换行")}
              </span>
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
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingConversationHistory({
  history,
  latestSessionId,
  selectedSessionId,
  loading,
  onSelectSession,
}: {
  history: readonly V1SettingImprovementHistoryItem[];
  latestSessionId: string | null;
  selectedSessionId: string | null;
  loading: boolean;
  onSelectSession: (sessionId: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <section
      className="setting-conversation-history"
      aria-labelledby="setting-conversation-history-title"
    >
      <header>
        <div>
          <span className="eyebrow">{uiText("内容包记录")}</span>
          <h3 id="setting-conversation-history-title">
            {uiText("设定完善对话历史")}
          </h3>
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
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  className={selected ? "is-selected" : ""}
                  aria-pressed={selected}
                  disabled={loading}
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
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SettingConversationTurnView({
  turn,
}: {
  turn: V1SettingConversationTurn;
}): React.JSX.Element {
  return (
    <section className="setting-conversation-turn">
      <article className="setting-conversation-message setting-conversation-user">
        <span className="setting-conversation-role">{uiText("你")}</span>
        <p>{turn.user.text}</p>
      </article>
      {turn.exchanges.map((exchange) => (
        <SettingConversationExchangeView
          key={exchange.id}
          exchange={exchange}
        />
      ))}
    </section>
  );
}

function SettingConversationExchangeView({
  exchange,
}: {
  exchange: V1SettingConversationExchange;
}): React.JSX.Element {
  const hasTrace =
    (exchange.reasoning?.length ?? 0) > 0 || exchange.toolCalls.length > 0;
  return (
    <div className="setting-conversation-exchange">
      {hasTrace ? (
        <section className="setting-conversation-trace">
          <header>
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
          </header>
          {exchange.reasoning === undefined ||
          exchange.reasoning.length === 0 ? null : (
            <div className="setting-exchange-reasoning">
              <strong>{uiText("Provider 返回推理（不等同隐藏思维链）")}</strong>
              <pre>{exchange.reasoning}</pre>
            </div>
          )}
          {exchange.toolCalls.map((call) => (
            <details
              className={`setting-exchange-tool ${call.result?.isError === true ? "is-error" : "is-ok"}`}
              key={call.callId}
              open={(call.result?.changes.length ?? 0) > 0}
            >
              <summary>
                <strong>{uiText("调用 {tool}", { tool: call.name })}</strong>
                <span>
                  {call.result === null
                    ? uiText("等待 Runtime 结果")
                    : call.result.isError
                      ? uiText("拒绝／失败")
                      : call.result.changes.length > 0
                        ? uiText("已生效 · {count} 个文件", {
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
                </>
              )}
            </details>
          ))}
        </section>
      ) : null}
      {exchange.text.length === 0 ? null : (
        <article className="setting-conversation-message setting-conversation-assistant">
          <span className="setting-conversation-role">
            {exchange.toolCalls.length > 0
              ? uiText("AI · 工具步骤文本")
              : uiText("AI")}
          </span>
          <p>{exchange.text}</p>
        </article>
      )}
    </div>
  );
}

function AcceptedChanges({
  changes,
  heading = uiText("已生效差异"),
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
          open
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
        {stream?.reasoningText?.length ? (
          <div className="setting-live-trace">
            <strong>{uiText("Provider 返回推理（不等同隐藏思维链）")}</strong>
            <pre>{stream.reasoningText}</pre>
          </div>
        ) : null}
        {stream?.visibleText?.length ? (
          <div className="setting-live-trace">
            <strong>{uiText("正在接收的正文")}</strong>
            <pre>{stream.visibleText}</pre>
          </div>
        ) : null}
        {stream?.toolFragment?.length ? (
          <details className="setting-live-trace">
            <summary>{uiText("正在接收的工具调用片段")}</summary>
            <pre>{stream.toolFragment}</pre>
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
