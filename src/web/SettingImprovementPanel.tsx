import { useState } from "react";

import type {
  V1SettingImprovementView,
  V1SettingPromptPreview,
} from "../protocol/v1.ts";
import { ModelUsageBreakdown } from "./ModelUsageBreakdown.tsx";
import { getWebLocale, uiText } from "./i18n.ts";

export type SettingImprovementView = V1SettingImprovementView;

interface SettingImprovementPanelProps {
  packageName: string;
  modelConfigured: boolean;
  hasUnsavedFileDraft: boolean;
  loading: boolean;
  view: SettingImprovementView | null;
  requestFailure: string | null;
  now: number;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onApply: (draftVersion: number) => Promise<void>;
  onDiscard: () => Promise<void>;
  onConfigureModel: () => void;
}

export function SettingImprovementPanel({
  packageName,
  modelConfigured,
  hasUnsavedFileDraft,
  loading,
  view,
  requestFailure,
  now,
  onSend,
  onCancel,
  onApply,
  onDiscard,
  onConfigureModel,
}: SettingImprovementPanelProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const running = view?.runStatus === "running" || submitting;
  const closed = view !== null && view.lifecycle !== "open";
  const disabled =
    loading || running || closed || !modelConfigured || hasUnsavedFileDraft;

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
              "和 AI 直接讨论或修改 {packageName}。它始终可以读取和更新隔离草稿；满意时再由你应用。",
              { packageName },
            )}
          </p>
        </div>
        {view !== null && view.lifecycle === "open" && !running ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void onDiscard()}
          >
            {uiText("放弃对话")}
          </button>
        ) : null}
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
            ) : view === null || view.messages.length === 0 ? (
              <div className="setting-conversation-empty">
                <p>{uiText("直接说你现在想做什么。")}</p>
                <p>
                  {uiText(
                    "例如：先帮我梳理一下人物关系；或者直接把开场改成雨夜码头，并同步当前情境。",
                  )}
                </p>
              </div>
            ) : (
              view.messages.map((item) => (
                <article
                  key={item.id}
                  className={`setting-conversation-message setting-conversation-${item.role}`}
                >
                  <span className="setting-conversation-role">
                    {item.role === "user" ? uiText("你") : uiText("AI")}
                  </span>
                  <p>{item.text}</p>
                </article>
              ))
            )}

            {running ? (
              <SettingConversationProgress view={view} now={now} />
            ) : null}
            {view?.lastFailure !== null && view?.lastFailure !== undefined ? (
              <div className="setting-conversation-failure" role="alert">
                <strong>{uiText("上一次操作未完成")}</strong>
                <p>{view.lastFailure}</p>
                <p>
                  {uiText(
                    "最后一次完整草稿和完整对话都已保留，可以直接继续说。",
                  )}
                </p>
              </div>
            ) : null}
            {requestFailure !== null ? (
              <div className="setting-conversation-failure" role="alert">
                {requestFailure}
              </div>
            ) : null}
          </div>

          <div className="setting-conversation-composer">
            <label htmlFor="setting-conversation-input">
              {uiText("给 AI 发消息")}
            </label>
            <textarea
              id="setting-conversation-input"
              rows={4}
              value={message}
              disabled={disabled}
              placeholder={uiText(
                "可以先讨论、要求它检查某份设定，也可以直接让它修改草稿。",
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

        <SettingDraftSummary view={view} running={running} onApply={onApply} />
      </div>
    </section>
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
        {stream?.tail.trim() ? <p>{stream.tail}</p> : null}
      </div>
    </div>
  );
}

function SettingDraftSummary({
  view,
  running,
  onApply,
}: {
  view: SettingImprovementView | null;
  running: boolean;
  onApply: (draftVersion: number) => Promise<void>;
}): React.JSX.Element {
  const review = view?.review;
  const changed = review?.diff.length ?? 0;
  return (
    <aside className="setting-draft-summary" aria-label={uiText("隔离草稿")}>
      <div className="setting-draft-summary-heading">
        <div>
          <span className="eyebrow">{uiText("隔离草稿")}</span>
          <h3>{uiText("当前候选")}</h3>
        </div>
        <span className="setting-draft-version">
          {uiText("版本 {version}", { version: view?.draftVersion ?? 0 })}
        </span>
      </div>

      {view === null ? (
        <p className="field-note">
          {uiText("AI 调用写入工具后，改动和自动检查会出现在这里。")}
        </p>
      ) : (
        <>
          <dl className="setting-draft-facts">
            <div>
              <dt>{uiText("改动")}</dt>
              <dd>{uiText("{count} 个文件", { count: changed })}</dd>
            </div>
            <div>
              <dt>{uiText("自动检查")}</dt>
              <dd>
                {review?.status === "usable"
                  ? uiText("已通过")
                  : uiText("需要修复")}
              </dd>
            </div>
            <div>
              <dt>{uiText("基线")}</dt>
              <dd>
                {view.baseStatus === "current"
                  ? uiText("未变化")
                  : uiText("已过期")}
              </dd>
            </div>
          </dl>

          {review?.diagnostics.length ? (
            <div className="setting-draft-diagnostics">
              <strong>{uiText("需要修复")}</strong>
              <ul>
                {review.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${diagnostic.path}-${index}`}>
                    <code>{diagnostic.path}</code> · {diagnostic.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {review?.diff.map((diff) => (
            <details
              key={`${diff.kind}-${diff.path}`}
              className="setting-draft-diff"
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
              {diff.before !== null ? (
                <pre aria-label={uiText("修改前")}>{diff.before}</pre>
              ) : null}
              {diff.after !== null ? (
                <pre aria-label={uiText("修改后")}>{diff.after}</pre>
              ) : null}
            </details>
          ))}

          {review?.preview !== null && review?.preview !== undefined ? (
            <SettingDraftPromptPreview preview={review.preview} />
          ) : null}

          <ModelUsageBreakdown usage={view.usage} />

          <button
            type="button"
            className="setting-apply-button"
            disabled={running || !view.canApply}
            onClick={() => void onApply(view.draftVersion)}
          >
            {uiText("应用当前草稿")}
          </button>
          {!view.canApply ? (
            <p className="field-note">
              {view.baseStatus === "stale"
                ? uiText("内容包已在对话外发生变化，不能覆盖应用。")
                : changed === 0
                  ? uiText("草稿还没有改动。")
                  : review?.status !== "usable"
                    ? uiText("修复所有自动检查问题后才能应用。")
                    : uiText("等待当前回复结束后即可应用。")}
            </p>
          ) : (
            <p className="field-note">
              {uiText(
                "应用只提交这个精确版本；对话中的讨论本身不会修改当前树。",
              )}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

function SettingDraftPromptPreview({
  preview,
}: {
  preview: V1SettingPromptPreview;
}): React.JSX.Element {
  const { budget } = preview.compilation;
  return (
    <section
      className="setting-prompt-preview setting-draft-prompt-preview"
      aria-labelledby="setting-draft-preview-title"
    >
      <div className="setting-subsection-heading">
        <div>
          <h4 id="setting-draft-preview-title">{uiText("真实提示词预览")}</h4>
          <p>{uiText("候选已通过和真实请求同源的编译检查。")}</p>
        </div>
      </div>
      <dl className="setting-preview-summary">
        <div>
          <dt>{uiText("模型")}</dt>
          <dd>{preview.diagnosticBinding.modelId}</dd>
        </div>
        <div>
          <dt>{uiText("逻辑消息")}</dt>
          <dd>{preview.compilation.logicalMessages.length}</dd>
        </div>
        <div>
          <dt>{uiText("工具")}</dt>
          <dd>{preview.compilation.tools.length}</dd>
        </div>
        <div>
          <dt>
            {budget.estimator === "disabled"
              ? uiText("上下文检查")
              : uiText("预算")}
          </dt>
          <dd>
            {budget.estimator === "disabled"
              ? uiText("由 Provider 判断")
              : `${formatNumber(budget.requiredTokens)} / ${formatNumber(
                  budget.contextWindowTokens,
                )} tokens`}
          </dd>
        </div>
      </dl>
      <div className="setting-preview-details">
        <details>
          <summary>{uiText("查看逻辑消息正文")}</summary>
          <ol className="setting-message-list">
            {preview.compilation.logicalMessages.map((logical, index) => (
              <li key={`${logical.role}-${index}`}>
                <header>
                  <strong>{logical.role}</strong>
                  <span>
                    {logical.blocks.map(({ source }) => source).join(" · ")}
                  </span>
                </header>
                <pre>{logical.markdown}</pre>
              </li>
            ))}
          </ol>
        </details>
        <details>
          <summary>{uiText("查看材料覆盖与预算")}</summary>
          <pre>
            {JSON.stringify(
              {
                coverage: preview.compilation.coverage,
                budget,
                cache: preview.compilation.cache,
              },
              null,
              2,
            )}
          </pre>
        </details>
        <details>
          <summary>{uiText("查看真实工具定义")}</summary>
          <pre>{JSON.stringify(preview.compilation.tools, null, 2)}</pre>
        </details>
        <details>
          <summary>{uiText("查看最终 Provider 请求结构")}</summary>
          <pre>{JSON.stringify(preview.compilation.provider, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(getWebLocale()).format(value);
}
