import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  OrchestrationSurface,
  V1OrchestrationOverview,
  V1OrchestrationStatus,
  V1OrchestrationView,
} from "../protocol/orchestrationSession.ts";
import type { PlayRequestContext } from "../protocol/playRequestContext.ts";
import type {
  V1AuthoringRequestPreview,
  V1Request,
  V1SettingConversationTurn,
} from "../protocol/v1.ts";
import { AuthoringPromptPreview } from "./AuthoringPromptPreview.tsx";
import { createClientId } from "./ClientId.ts";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";
import {
  conversationConnectionText,
  type ObserveConversation,
} from "./ConversationObserver.ts";
import { groupCallAttempts } from "./GroupModelCallAttempts.ts";
import { ModelCallAttempts } from "./ModelCallAttempts.tsx";
import {
  ModelCallDetails,
  ModelCallDetailsGroup,
  ModelCallReasoning,
  ModelCallTools,
} from "./ModelCallDetails.tsx";
import { OrchestrationProvenance } from "./OrchestrationProvenance.tsx";
import { RequestContextDetails } from "./PlayRequestContextDetails.tsx";
import { RuntimeRequestError } from "./runtimeClient.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { UnifiedTextDiff } from "./UnifiedTextDiff.tsx";
import { uiText } from "./i18n.ts";
import {
  readOrchestrationPendingRequest,
  saveOrchestrationPendingRequest,
  type OrchestrationPendingRequest,
} from "./orchestration-ai-workbench.ts";
import { useConversationComposer } from "./useConversationComposer.ts";
import { useReadTarget } from "./useReadTarget.ts";

type Send = Extract<V1Request, { type: "orchestration.message" }>;
type Resume = Extract<V1Request, { type: "orchestration.resume" }>;
type SessionChoice =
  { kind: "latest" | "new" } | { kind: "session"; id: string };
type RequestConfirmation =
  | { kind: "delete"; sessionId: string }
  | { kind: "undo"; changeSetId: string; sessionId: string };
interface Projection {
  selectedId: string | undefined;
  overview: V1OrchestrationOverview;
  selected: V1OrchestrationView | null;
}

interface OrchestrationConversationPanelProps {
  client: {
    request<T>(request: V1Request): Promise<T>;
    observeConversation?: ObserveConversation;
  };
  presetId: string;
  presetName: string;
  effectiveRevision: string;
  surface: OrchestrationSurface;
  focusedEntryId: string | undefined;
  focusedEntryName: string | undefined;
  message: string;
  editMessage: (message: string) => void;
  modelConfigured: boolean;
  configureModel?: (() => void) | undefined;
  close: () => void;
  localDirty: boolean;
  menuBusy: boolean;
  localConflict: boolean;
  saveLocal: () => Promise<void>;
  discardLocal: () => void;
  refreshPreset: () => Promise<void>;
}

function acknowledged(
  view: V1OrchestrationView | null | undefined,
  id: string,
): boolean {
  return view?.confirmedRequestIds?.includes(id) === true;
}

export function OrchestrationConversationPanel({
  client,
  presetId,
  presetName,
  effectiveRevision,
  surface,
  focusedEntryId,
  focusedEntryName,
  message,
  editMessage,
  modelConfigured,
  configureModel,
  close,
  localDirty,
  menuBusy,
  localConflict,
  saveLocal,
  discardLocal,
  refreshPreset,
}: OrchestrationConversationPanelProps) {
  const [restored] = useState(() => readOrchestrationPendingRequest(presetId));
  const [choice, choose] = useState<SessionChoice>(() => {
    if (restored?.type === "orchestration.resume")
      return { kind: "session", id: restored.sessionId };
    if (restored?.continuation.kind === "continue_context")
      return { kind: "session", id: restored.continuation.sessionId };
    return { kind: "latest" };
  });
  const [projection, setProjection] = useState<Projection | null>(null);
  const [observed, setObserved] = useState<V1OrchestrationStatus | null>(null);
  const [inFlight, setInFlight] = useState<Send | Resume | null>(null);
  const [uncertain, setUncertain] =
    useState<OrchestrationPendingRequest | null>(restored);
  const [action, setAction] = useState<"cancel" | "undo" | "delete" | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [suggestedReopen, setSuggestedReopen] = useState(0);
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest<RequestConfirmation> | null>(null);
  const latestMessage = useRef(message);
  useLayoutEffect(() => {
    latestMessage.current = message;
  }, [message]);
  const commandActive = useRef(false);
  const livePanel = useRef(false);
  useEffect(() => {
    livePanel.current = true;
    return () => {
      livePanel.current = false;
    };
  }, []);

  const selectedId = choice.kind === "session" ? choice.id : undefined;
  const readProjection = useCallback(async (): Promise<Projection> => {
    const [overview, selected] = await Promise.all([
      client.request<V1OrchestrationOverview>({
        type: "orchestration.overview",
        presetId,
      }),
      selectedId === undefined
        ? undefined
        : client.request<V1OrchestrationView>({
            type: "orchestration.session.read",
            presetId,
            sessionId: selectedId,
          }),
    ]);
    return { selectedId, overview, selected: selected ?? overview.latest };
  }, [client, presetId, selectedId]);
  const reconcileProjection = useRef<((value: Projection) => void) | null>(
    null,
  );
  const applyProjection = useCallback((value: Projection) => {
    setProjection(value);
    reconcileProjection.current?.(value);
  }, []);
  const { target, syncFailed, syncError } = useReadTarget(
    readProjection,
    applyProjection,
  );
  useEffect(() => {
    void target.read();
  }, [target]);
  const progress = observed?.selected;
  const visibleSession =
    choice.kind === "session"
      ? projection?.selected?.sessionId === choice.id
        ? (projection?.selected ?? null)
        : null
      : choice.kind === "latest"
        ? (projection?.overview.latest ?? null)
        : inFlight !== null &&
            acknowledged(projection?.overview.latest, inFlight.requestId)
          ? projection!.overview.latest
          : null;
  const activeProgress =
    visibleSession?.sessionId === progress?.sessionId ? progress : undefined;
  const workspaceRunning =
    projection?.overview.history.some(
      ({ runStatus }) => runStatus === "running",
    ) === true;
  const running =
    (activeProgress?.runStatus ?? visibleSession?.runStatus) === "running";
  const reportProjection = useEffectEvent(
    async (status: V1OrchestrationStatus, durable: boolean) => {
      setObserved(status);
      if (!durable) return;
      const received = await target.recover();
      if (received === null) throw new Error(uiText("无法刷新编排对话。"));
      if (received.overview.revision !== effectiveRevision)
        await refreshPreset();
    },
  );
  useEffect(
    () =>
      client.observeConversation?.(
        {
          kind: "orchestration",
          id: presetId,
          ...(selectedId === undefined ? {} : { sessionId: selectedId }),
        },
        async (state, durable, isCurrent) => {
          if (state.kind === "orchestration" && isCurrent?.() !== false)
            await reportProjection(state.value, durable);
        },
        (state, detail) =>
          setConnectionNotice(conversationConnectionText(state, detail)),
      ),
    [client, presetId, selectedId, suggestedReopen],
  );

  async function refresh(): Promise<void> {
    const received = await target.recover();
    if (received !== null && received.overview.revision !== effectiveRevision)
      await refreshPreset();
  }

  function confirmReceipt(
    input: Send | Resume,
    view: V1OrchestrationView,
  ): void {
    if (
      input.type === "orchestration.message" &&
      latestMessage.current === input.message
    )
      editMessage("");
    setUncertain(null);
    saveOrchestrationPendingRequest(presetId, null);
    if (choice.kind === "new") choose({ kind: "session", id: view.sessionId });
  }

  useLayoutEffect(() => {
    reconcileProjection.current = ({ selected, overview }) => {
      const pending = inFlight ?? uncertain;
      if (pending === null) return;
      const matching = [selected, overview.latest].find((view) =>
        acknowledged(view, pending.requestId),
      );
      if (matching) {
        confirmReceipt(pending, matching);
        setFailure(null);
      }
    };
  });

  async function dispatch(input: Send | Resume): Promise<void> {
    if (commandActive.current) return;
    commandActive.current = true;
    setInFlight(input);
    saveOrchestrationPendingRequest(presetId, input);
    setFailure(null);
    try {
      const receipt = await client.request<V1OrchestrationView>(input);
      if (!livePanel.current) return;
      confirmReceipt(input, receipt);
      await refresh().catch(() => undefined);
    } catch (error: unknown) {
      if (!livePanel.current) return;
      const received = await target.recover();
      const matching = [received?.selected, received?.overview.latest].find(
        (view) => acknowledged(view, input.requestId),
      );
      if (!livePanel.current) return;
      if (matching) confirmReceipt(input, matching);
      else {
        const rejected =
          error instanceof RuntimeRequestError && error.kind === "runtime";
        setUncertain(rejected ? null : input);
        if (rejected) saveOrchestrationPendingRequest(presetId, null);
        setFailure(
          error instanceof Error ? error.message : uiText("编排对话操作失败。"),
        );
      }
      if (
        received !== null &&
        received.overview.revision !== effectiveRevision
      ) {
        try {
          await refreshPreset();
        } catch {
          /* ReadTarget shows the failed read. */
        }
      }
    } finally {
      commandActive.current = false;
      if (livePanel.current) setInFlight(null);
    }
  }

  const noNewMessage =
    visibleSession?.runStatus === "paused" ||
    visibleSession?.runStatus === "interrupted";
  const canSend =
    projection !== null &&
    projection.selectedId === selectedId &&
    (choice.kind !== "session" || visibleSession !== null) &&
    modelConfigured &&
    !localDirty &&
    !menuBusy &&
    !workspaceRunning &&
    !running &&
    inFlight === null &&
    action === null &&
    uncertain === null &&
    !noNewMessage &&
    message.trim().length > 0;
  const composer = useConversationComposer(canSend, () =>
    dispatch({
      type: "orchestration.message",
      presetId,
      surface,
      message,
      requestId: createClientId("orchestration-request"),
      expectedRevision: effectiveRevision,
      ...(focusedEntryId === undefined ? {} : { focusedEntryId }),
      continuation:
        visibleSession === null
          ? { kind: "fresh_context" }
          : { kind: "continue_context", sessionId: visibleSession.sessionId },
    }),
  );
  const recoveryDisabled =
    localDirty ||
    menuBusy ||
    inFlight !== null ||
    action !== null ||
    running ||
    workspaceRunning;

  async function runAction(
    input: V1Request,
    kind: NonNullable<typeof action>,
  ): Promise<void> {
    if (action !== null) return;
    setAction(kind);
    setFailure(null);
    try {
      await client.request(input);
      if (!livePanel.current) return;
      if (kind === "delete") choose({ kind: "latest" });
      await refresh();
    } catch (error: unknown) {
      if (!livePanel.current) return;
      setFailure(
        error instanceof Error ? error.message : uiText("编排对话操作失败。"),
      );
      try {
        await refresh();
      } catch {
        /* ReadTarget shows the failed read. */
      }
    } finally {
      if (livePanel.current) setAction(null);
    }
  }

  const cancelId =
    visibleSession?.sessionId ??
    (choice.kind === "new" ? undefined : progress?.sessionId);
  function resume(recovery?: "continue_partial"): void {
    if (visibleSession === null) return;
    void dispatch({
      type: "orchestration.resume",
      presetId,
      sessionId: visibleSession.sessionId,
      requestId: createClientId("orchestration-resume"),
      ...(recovery === undefined ? {} : { recovery }),
    });
  }

  const selectedValue =
    choice.kind === "new"
      ? ""
      : ((choice.kind === "session" ? selectedId : visibleSession?.sessionId) ??
        "");
  const latestExchange = visibleSession?.turns.at(-1)?.exchanges.at(-1);
  const stream = activeProgress?.progress.streaming;
  const progressText =
    stream?.callId === latestExchange?.id &&
    stream?.visibleText === latestExchange?.text
      ? undefined
      : stream?.visibleText;
  const pending = inFlight !== null || running;
  const lockHistory =
    inFlight !== null || uncertain !== null || action !== null;
  const history = projection?.overview.history ?? [];
  return (
    <section
      className="orchestration-conversation"
      aria-label={uiText("编排方案 AI 编辑")}
    >
      <header className="orchestration-conversation-header">
        <div>
          <h4>{uiText("编排方案 AI 编辑")}</h4>
          <p>
            {presetName} ·{" "}
            {uiText(surface === "playPrompts" ? "游玩" : "设定完善")}
            {focusedEntryName && <> · {focusedEntryName}</>}
          </p>
        </div>
        <button type="button" onClick={close}>
          {uiText("关闭")}
        </button>
      </header>
      <div className="orchestration-chat">
        {connectionNotice && <p role="status">{connectionNotice}</p>}
        {syncFailed && (
          <SyncNotice
            failed
            reason={syncError}
            onRead={() => {
              setSuggestedReopen((value) => value + 1);
              void refresh().catch(() => undefined);
            }}
          />
        )}
        {!syncFailed && connectionNotice && (
          <button
            type="button"
            onClick={() => {
              setSuggestedReopen((value) => value + 1);
              void refresh().catch(() => undefined);
            }}
          >
            {uiText("重新加载")}
          </button>
        )}
        {projection !== null && (
          <div className="orchestration-history">
            <label>
              <span>{uiText("对话记录")}</span>
              <select
                value={selectedValue}
                disabled={lockHistory}
                onChange={(event) => {
                  setFailure(null);
                  const id = event.currentTarget.value;
                  choose(id === "" ? { kind: "new" } : { kind: "session", id });
                }}
              >
                <option value="">{uiText("新对话")}</option>
                {history.map(({ sessionId, excerpt }) => (
                  <option key={sessionId} value={sessionId}>
                    {excerpt || sessionId}
                  </option>
                ))}
              </select>
            </label>
            {visibleSession && (
              <>
                <button
                  type="button"
                  disabled={lockHistory}
                  onClick={() => {
                    choose({ kind: "new" });
                    setFailure(null);
                  }}
                >
                  {uiText("开启新对话")}
                </button>
                <button
                  type="button"
                  disabled={lockHistory || running}
                  onClick={(event) =>
                    setConfirmation({
                      action: {
                        kind: "delete",
                        sessionId: visibleSession.sessionId,
                      },
                      opener: event.currentTarget,
                      message: uiText(
                        "删除此编排对话？已保存的草稿仍可继续编辑。",
                      ),
                      confirmLabel: uiText("删除"),
                    })
                  }
                >
                  {uiText("删除对话")}
                </button>
              </>
            )}
          </div>
        )}
        <div
          className="orchestration-transcript"
          aria-label={uiText("编排对话内容")}
        >
          {visibleSession?.turns.map((turn) => (
            <ConversationTurn
              key={turn.id}
              turn={turn}
              loadContext={(callId) =>
                client.request<PlayRequestContext>({
                  type: "orchestration.call.context",
                  presetId,
                  sessionId: visibleSession.sessionId,
                  callId,
                })
              }
            />
          ))}
          {progressText && (
            <article className="setting-conversation-message setting-conversation-assistant">
              {progressText}
            </article>
          )}
        </div>
        {visibleSession &&
          (visibleSession.requestPreviews?.length ?? 0) > 0 && (
            <AuthoringPromptPreview
              requests={visibleSession.requestPreviews ?? []}
              onRequestPreview={(requestId) =>
                client.request<V1AuthoringRequestPreview | null>({
                  type: "orchestration.request.preview",
                  presetId,
                  sessionId: visibleSession.sessionId,
                  requestId,
                })
              }
            />
          )}
        <div className="orchestration-composer">
          {failure && <p role="alert">{failure}</p>}
          {localDirty && (
            <div className="orchestration-local-draft" role="status">
              <p>
                {uiText(
                  localConflict
                    ? "编排草稿已在别处更新。你的本地修改仍保留。"
                    : "请先保存或放弃本地修改，再发送给编排助手。",
                )}
              </p>
              <button
                type="button"
                disabled={menuBusy}
                onClick={() => void saveLocal()}
              >
                {uiText("保存本地修改")}
              </button>
              <button type="button" disabled={menuBusy} onClick={discardLocal}>
                {uiText("放弃本地修改")}
              </button>
            </div>
          )}
          {!modelConfigured && (
            <button
              type="button"
              disabled={localDirty || menuBusy}
              onClick={configureModel}
            >
              {uiText("配置模型")}
            </button>
          )}
          {pending && <p role="status">{uiText("编排助手正在工作…")}</p>}
          {visibleSession?.lastFailure && noNewMessage && (
            <p role="alert">{visibleSession.lastFailure}</p>
          )}
          {uncertain && (
            <p>
              <button
                type="button"
                disabled={localDirty || menuBusy || inFlight !== null}
                onClick={() => void dispatch(uncertain)}
              >
                {uiText("核对或重试同一请求")}
              </button>
            </p>
          )}
          {noNewMessage && uncertain === null && (
            <div className="orchestration-recovery">
              {visibleSession.runStatus === "paused" && (
                <button
                  type="button"
                  disabled={recoveryDisabled}
                  onClick={() => resume()}
                >
                  {uiText("继续本次编辑")}
                </button>
              )}
              {visibleSession.canContinuePartial && (
                <button
                  type="button"
                  disabled={recoveryDisabled}
                  onClick={() => resume("continue_partial")}
                >
                  {uiText("续写")}
                </button>
              )}
              {visibleSession.runStatus !== "paused" &&
                visibleSession.canRetry && (
                  <button
                    type="button"
                    disabled={recoveryDisabled}
                    onClick={() => resume()}
                  >
                    {uiText("原样重试")}
                  </button>
                )}
            </div>
          )}
          <label>
            {uiText("给编排助手的消息")}
            <textarea
              aria-label={uiText("给编排助手的消息")}
              value={message}
              rows={3}
              onChange={(event) => editMessage(event.currentTarget.value)}
              onKeyDown={composer.onKeyDown}
            />
          </label>
          <div className="orchestration-composer-actions">
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void composer.submit()}
            >
              {uiText("发送给编排助手")}
            </button>
            {pending && cancelId && (
              <button
                type="button"
                disabled={action !== null}
                onClick={() =>
                  void runAction(
                    {
                      type: "orchestration.cancel",
                      presetId,
                      sessionId: cancelId,
                    },
                    "cancel",
                  )
                }
              >
                {uiText("取消生成")}
              </button>
            )}
          </div>
        </div>
      </div>
      <section
        className="orchestration-changes"
        aria-label={uiText("草稿改动")}
      >
        <h5>{uiText("草稿改动")}</h5>
        {(visibleSession?.changes.length ?? 0) === 0 && (
          <p>{uiText("此对话还没有草稿改动。")}</p>
        )}
        {visibleSession?.changes.map((receipt) => (
          <details key={receipt.id}>
            <summary>
              {uiText("{count} 项编排改动", { count: receipt.entries.length })}
              {receipt.undone && <> · {uiText("已撤销")}</>}
            </summary>
            <p className="orchestration-revisions">
              <code>{receipt.beforeRevision}</code> →{" "}
              <code>{receipt.afterRevision}</code>
            </p>
            {receipt.entries.map(
              ({ surface: entrySurface, entryId, moved, before, after }) => (
                <details key={`${entrySurface}:${entryId}`}>
                  <summary>
                    {uiText(
                      entrySurface === "playPrompts" ? "游玩" : "设定完善",
                    )}{" "}
                    · {after?.name ?? before?.name ?? entryId}
                    {moved === true && <> · {uiText("已移动")}</>}
                  </summary>
                  <p>
                    <code>{entryId}</code>
                  </p>
                  <dl className="orchestration-change-fields">
                    {(
                      [
                        "name",
                        "messageRole",
                        "index",
                        "enabled",
                        "turnGuide",
                        "turnGuideOverride",
                        "gameplay",
                      ] as const
                    ).map((field) =>
                      before?.[field] === after?.[field] &&
                      !(field === "index" && moved === true) ? null : (
                        <div key={field}>
                          <dt>{uiText(changeFieldLabels[field])}</dt>
                          <dd>
                            {changeValue(field, before?.[field])} →{" "}
                            {changeValue(field, after?.[field])}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                  {receipt.provenance
                    ?.filter((item) => item.entryId === entryId)
                    .map((item) => (
                      <OrchestrationProvenance
                        key={item.operationId}
                        record={item.value}
                      />
                    ))}
                  {before?.text !== after?.text && (
                    <UnifiedTextDiff
                      before={before?.text ?? null}
                      after={after?.text ?? null}
                      label={uiText("提示词正文差异")}
                    />
                  )}
                </details>
              ),
            )}
            {receipt.undoAvailable ? (
              <button
                type="button"
                disabled={recoveryDisabled}
                onClick={(event) =>
                  setConfirmation({
                    action: {
                      kind: "undo",
                      changeSetId: receipt.id,
                      sessionId: visibleSession.sessionId,
                    },
                    message: uiText("撤销这批编排草稿改动？"),
                    opener: event.currentTarget,
                    confirmLabel: uiText("撤销此批改动"),
                  })
                }
              >
                {uiText("撤销此批改动")}
              </button>
            ) : (
              !receipt.undone && (
                <p>{uiText("此批已不是当前草稿的最后一批改动。")}</p>
              )
            )}
          </details>
        ))}
      </section>
      {confirmation !== null && (
        <ConfirmationDialog
          request={confirmation}
          onDecision={(accepted) => {
            const confirmed = confirmation.action;
            setConfirmation(null);
            if (!accepted) return;
            if (confirmed.kind === "delete")
              void runAction(
                {
                  type: "orchestration.session.delete",
                  presetId,
                  sessionId: confirmed.sessionId,
                },
                "delete",
              );
            else
              void runAction(
                {
                  type: "orchestration.undo",
                  presetId,
                  sessionId: confirmed.sessionId,
                  changeSetId: confirmed.changeSetId,
                  expectedRevision: effectiveRevision,
                },
                "undo",
              );
          }}
        />
      )}
    </section>
  );
}

const changeFieldLabels = {
  name: "名称",
  messageRole: "发送角色",
  index: "位置",
  enabled: "启停",
  turnGuide: "本轮尾部提示",
  turnGuideOverride: "尾部覆盖",
  gameplay: "玩法限定",
} as const;

function changeValue(
  field: keyof typeof changeFieldLabels,
  value: string | number | boolean | null | undefined,
) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return uiText(value ? "已启用" : "已停用");
  if (value === "") return uiText("已明确清空");
  if (field === "index" && typeof value === "number") return value + 1;
  return value;
}

function ConversationTurn({
  turn,
  loadContext,
}: {
  turn: V1SettingConversationTurn;
  loadContext: (callId: string) => Promise<PlayRequestContext>;
}) {
  const attempts = groupCallAttempts(
    turn.exchanges,
    ({ id }) => id,
    ({ retryOf }) => retryOf,
  );
  return (
    <section className="setting-conversation-turn">
      <article className="setting-conversation-message setting-conversation-user">
        <span className="setting-conversation-role">{uiText("你")}</span>
        <p>{turn.user.text}</p>
      </article>
      {turn.exchanges.map(
        ({ id, status, text, toolCalls }) =>
          status !== "interrupted" &&
          status !== "cancelled" &&
          toolCalls.length === 0 &&
          text && (
            <article
              className="setting-conversation-message setting-conversation-assistant"
              key={id}
            >
              <span className="setting-conversation-role">AI</span>
              <p>{text}</p>
            </article>
          ),
      )}
      <ModelCallDetailsGroup count={attempts.length}>
        {attempts.map((items) => (
          <ModelCallAttempts
            key={items[0]!.id}
            attempts={items}
            render={(exchange) => (
              <ModelCallDetails
                key={exchange.id}
                retries={exchange.retries}
                status={exchange.status}
                failure={exchange.failure}
                context={
                  <RequestContextDetails
                    load={() => loadContext(exchange.id)}
                  />
                }
                reasoning={<ModelCallReasoning text={exchange.reasoning} />}
                tools={
                  <ModelCallTools
                    count={exchange.toolCalls.length}
                    stepText={
                      exchange.toolCalls.length ? exchange.text : undefined
                    }
                    fragment={exchange.toolFragment}
                  >
                    {exchange.toolCalls.map(
                      ({ callId, name, arguments: args, result }) => (
                        <details key={callId}>
                          <summary>
                            <code>{name}</code>
                          </summary>
                          <pre>{JSON.stringify(args, null, 2)}</pre>
                          {result && <pre>{result.markdown}</pre>}
                        </details>
                      ),
                    )}
                  </ModelCallTools>
                }
                usage={exchange.usage}
              />
            )}
          />
        ))}
      </ModelCallDetailsGroup>
    </section>
  );
}
