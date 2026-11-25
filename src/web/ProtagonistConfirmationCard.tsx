import { useRef, useState } from "react";

import { confirmsAuthoringRequest } from "./AuthoringTarget.ts";
import type {
  AuthoringWorkspace,
  AuthoringWorkspaceState,
} from "./AuthoringWorkspace.ts";
import { createClientId } from "./ClientId.ts";
import { uiText } from "./i18n.ts";
import type { ProtagonistCustomization } from "./ProtagonistCustomization.ts";
import { StoryMarkdown } from "./StoryMarkdown.tsx";
import { SyncNotice } from "./SyncNotice.tsx";
import { UnifiedTextDiff } from "./UnifiedTextDiff.tsx";

export function ProtagonistConfirmationCard({
  worldTitle,
  customization,
  onChange,
  workspace,
  authoring,
  modelConfigured,
  onConfigureModel,
  onAdvanced,
  onApply,
  onDiscard,
  onBusyChange,
}: {
  worldTitle: string;
  customization: ProtagonistCustomization;
  onChange: (next: ProtagonistCustomization) => void;
  workspace: AuthoringWorkspace;
  authoring: AuthoringWorkspaceState;
  modelConfigured: boolean;
  onConfigureModel: () => void;
  onAdvanced: () => void;
  onApply: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const [replyDraft, setReplyDraft] = useState<string | null>(null);
  const epoch = authoring.target?.revision?.epoch;
  const activeEpoch = epoch?.locked === true ? epoch : null;
  const { view } = authoring;
  const isCurrentConversation =
    view !== null &&
    activeEpoch !== null &&
    authoring.target?.revision?.history.some(
      ({ sessionId, epochId }) =>
        sessionId === view.sessionId && epochId === activeEpoch.epochId,
    ) === true;
  const conversation = isCurrentConversation ? view : null;
  const confirmed = confirmsAuthoringRequest(
    conversation,
    customization.requestId,
  );
  const hasPendingReply =
    customization.reply !== undefined &&
    customization.reply.sessionId === conversation?.sessionId &&
    !confirmsAuthoringRequest(conversation, customization.reply.requestId);
  const reply =
    replyDraft ?? (hasPendingReply ? (customization.reply?.text ?? "") : "");
  const running = view?.runStatus === "running";
  const busy = submitting || authoring.applying || running;
  const hasChanges = (activeEpoch?.diff.length ?? 0) > 0;
  const response = conversation?.messages.findLast(
    ({ role, text }) => role === "assistant" && text.trim() !== "",
  )?.text;

  async function run(action: () => Promise<void>): Promise<void> {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setSubmitting(true);
    onBusyChange(true);
    try {
      await action();
    } catch {
      // AuthoringWorkspace exposes the error and refreshes the saved state.
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      onBusyChange(false);
    }
  }

  function start(): void {
    if (!modelConfigured || authoring.loading || authoring.syncFailed) return;
    void run(async () => {
      onChange({ ...customization, attempted: true });
      workspace.startFresh();
      await workspace.send(customization.message, customization.requestId);
    });
  }

  function sendReply(): void {
    const text = reply.trim();
    if (!modelConfigured || conversation === null || text === "") return;
    const sessionId = conversation.sessionId;
    void run(async () => {
      const previous = customization.reply;
      const requestId =
        hasPendingReply && previous?.text === text
          ? previous.requestId
          : createClientId("protagonist-reply");
      onChange({ ...customization, reply: { text, requestId, sessionId } });
      await workspace.send(text, requestId);
      setReplyDraft(null);
    });
  }

  return (
    <main className="protagonist-confirmation-page">
      <section
        className="protagonist-confirmation-card"
        aria-labelledby="protagonist-confirmation-title"
        aria-busy={busy}
      >
        <header>
          <p>{worldTitle}</p>
          <h1 id="protagonist-confirmation-title">{uiText("确认你的主角")}</h1>
        </header>
        <div className="protagonist-template-preview">
          <h2>{customization.name}</h2>
          <StoryMarkdown
            className="protagonist-template-body"
            text={customization.body}
          />
        </div>
        {!customization.attempted && activeEpoch === null && (
          <p>
            {uiText(
              "你可以用这个模板定制主角，或保留内容包里的原主角直接阅读开场。",
            )}
          </p>
        )}
        {!modelConfigured && (
          <p>{uiText("使用 AI 定制主角需要配置模型连接。")}</p>
        )}
        {authoring.loading && (
          <p role="status">{uiText("正在检查主角定制状态…")}</p>
        )}
        <SyncNotice
          failed={authoring.syncFailed}
          reason={authoring.syncError}
          onRead={() => void workspace.reread()}
        />
        {busy && !authoring.applying && (
          <p role="status">{uiText("正在定制主角…")}</p>
        )}
        {authoring.requestFailure !== null && (
          <p role="alert">{authoring.requestFailure}</p>
        )}
        {conversation?.lastFailure && !busy && (
          <p role="alert">{conversation.lastFailure}</p>
        )}
        {response !== undefined && (
          <div className="protagonist-customization-response">
            <h2>{uiText("定制回复")}</h2>
            <StoryMarkdown text={response} />
          </div>
        )}
        {activeEpoch !== null && hasChanges && (
          <div className="protagonist-customization-changes">
            <h2>{uiText("待应用的改动")}</h2>
            {activeEpoch.diff.map(({ path, before, after }) => (
              <details key={path}>
                <summary>{path}</summary>
                <UnifiedTextDiff before={before} after={after} label={path} />
              </details>
            ))}
            {activeEpoch.diagnostics.length > 0 && (
              <p role="status">
                {uiText("请在高级世界修订中先修复这些改动。")}
              </p>
            )}
          </div>
        )}
        {confirmed &&
          conversation?.runStatus === "ready" &&
          conversation.freshContextReason === undefined && (
            <form
              className="protagonist-customization-reply"
              onSubmit={(event) => {
                event.preventDefault();
                sendReply();
              }}
            >
              <label htmlFor="protagonist-reply">{uiText("补充信息")}</label>
              <textarea
                id="protagonist-reply"
                rows={3}
                value={reply}
                disabled={busy}
                onChange={(event) => setReplyDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={!modelConfigured || busy || reply.trim() === ""}
              >
                {uiText(hasPendingReply ? "重试发送" : "发送补充信息")}
              </button>
            </form>
          )}
        <div className="protagonist-confirmation-actions">
          {!confirmed && modelConfigured && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || authoring.loading || authoring.syncFailed}
              onClick={start}
            >
              {uiText(customization.attempted ? "重试定制" : "确认并定制")}
            </button>
          )}
          {confirmed && modelConfigured && conversation?.canRetry && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || authoring.syncFailed}
              onClick={() => void run(() => workspace.resume())}
            >
              {uiText("重试定制")}
            </button>
          )}
          {modelConfigured && conversation?.canContinuePartial && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || authoring.syncFailed}
              onClick={() =>
                void run(() => workspace.resume("continue_partial"))
              }
            >
              {uiText("继续未完成的定制")}
            </button>
          )}
          {modelConfigured && conversation?.runStatus === "paused" && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || authoring.syncFailed}
              onClick={() => void run(() => workspace.resume())}
            >
              {uiText("继续定制")}
            </button>
          )}
          {!modelConfigured && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={onConfigureModel}
            >
              {uiText("配置模型连接")}
            </button>
          )}
          {activeEpoch !== null && hasChanges && (
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                authoring.syncFailed ||
                activeEpoch.diagnostics.length > 0
              }
              onClick={() => void run(onApply)}
            >
              {uiText("应用并开始游玩")}
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy || authoring.loading || authoring.syncFailed}
            onClick={() => void run(onDiscard)}
          >
            {uiText(
              activeEpoch === null ? "跳过，阅读开场" : "放弃定制，阅读开场",
            )}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy || authoring.loading || authoring.syncFailed}
            onClick={onAdvanced}
          >
            {uiText("高级世界修订")}
          </button>
        </div>
      </section>
    </main>
  );
}
