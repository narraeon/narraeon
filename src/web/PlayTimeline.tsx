import styles from "./PlayTimeline.module.css";
import { Fragment, useCallback, useId, useState } from "react";
import type {
  V1PlayCallChainEvent,
  V1PlayCallChainView,
  V1PlayTimelineEventSummary,
  V1PlayTimelineItem,
} from "../protocol/v1.ts";
import { ArtifactExtensionMount } from "./ArtifactExtensionHost.tsx";
import { uiText } from "./i18n.ts";
import { ModelRetryStatus } from "./ModelRetryStatus.tsx";
import {
  PlayFailureNotice,
  type PlayFailureRecovery,
} from "./PlayFailureNotice.tsx";
import { PlayTurnCallDetails } from "./PlayTurnCallDetails.tsx";
import { ResolutionCard } from "./ResolutionCard.tsx";
import { StoryMarkdown } from "./StoryMarkdown.tsx";
import { StorySourceCopy } from "./StorySourceCopy.tsx";
import { SyncNotice } from "./SyncNotice.tsx";
import { TimelineMessageMenu } from "./TimelineMessageMenu.tsx";
import { useReadTarget } from "./useReadTarget.ts";
import {
  assistantResponseKind,
  requestRuntime,
  type PlayerRevisionContinuation,
  type WorldPageClient,
  type WorldMessage,
} from "./WorldPlayStore.ts";

export function PlayTimeline({
  activeFailure,
  liveChain,
  failureRecovery,
  client,
  worldId,
  items,
  restartDisabled,
  freshContextDisabled,
  showTechnicalInfo,
  onRestartFrom,
  onEditPlayer,
  onRegeneratePlayer,
  onRegenerateNarrative,
}: {
  client: WorldPageClient;
  worldId: string;
  items: readonly V1PlayTimelineItem[];
  liveChain: V1PlayCallChainView | null;
  activeFailure?: { chainId: string; eventId: number } | undefined;
  failureRecovery?: (PlayFailureRecovery & { chainId: string }) | undefined;
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  showTechnicalInfo: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
  onRegenerateNarrative: (chainId: string, eventId: number) => void;
  onRegeneratePlayer: (
    chainId: string,
    eventId: number,
    originalText: string,
    requiresFreshContext: boolean,
  ) => void;
}): React.JSX.Element {
  const groups = groupPlayTimelineItems(items);
  const latestNarrativeIndex = items.findLastIndex(
    (item) =>
      item.kind === "event" &&
      item.event.kind === "assistant" &&
      item.event.status === "completed" &&
      assistantResponseKind(item.event) === "narrative" &&
      item.event.committedHead !== undefined,
  );
  const latestNarrative = items[latestNarrativeIndex];
  const previousStory =
    latestNarrative?.kind === "event"
      ? items
          .slice(0, latestNarrativeIndex)
          .findLast(
            (item) =>
              item.kind === "event" &&
              item.chainId === latestNarrative.chainId &&
              (timelineEventBelongsInStory(item.event) ||
                (item.event.kind === "tool_result" &&
                  (item.event.hiddenResolution === true ||
                    item.event.resolution !== undefined))),
          )
      : undefined;
  const regeneratePlayer =
    previousStory?.kind === "event" &&
    previousStory.event.kind === "player" &&
    previousStory.event.committedHead !== undefined &&
    previousStory.event.committedHead !== "genesis"
      ? {
          chainId: previousStory.chainId,
          event: previousStory.event,
          requiresFreshContext: previousStory.requiresFreshContext,
        }
      : undefined;
  const lastActiveItem = items.findLast(
    (item) =>
      item.kind === "event" && item.chainId === failureRecovery?.chainId,
  );
  return (
    <ol
      className={`call-chain-events play-timeline-events ${styles.events}`}
      aria-label={uiText("模型调用链")}
    >
      {groups.map((group) => {
        if (group.kind === "turn") {
          return (
            <Fragment key={group.key}>
              {group.items.map((item) =>
                item.event.kind !== "followup" &&
                timelineEventBelongsInStory(item.event) &&
                (item.event.kind !== "failure" ||
                  (activeFailure?.chainId === item.chainId &&
                    activeFailure.eventId === item.event.id)) ? (
                  <TimelineEvent
                    key={`${item.chainId}:${item.event.id}`}
                    client={client}
                    worldId={worldId}
                    chainId={item.chainId}
                    event={item.event}
                    requiresFreshContext={item.requiresFreshContext}
                    restartDisabled={restartDisabled}
                    freshContextDisabled={freshContextDisabled}
                    showTechnicalInfo={showTechnicalInfo}
                    onRestartFrom={onRestartFrom}
                    onEditPlayer={onEditPlayer}
                    onRegenerateNarrative={
                      item === latestNarrative
                        ? () =>
                            onRegenerateNarrative(item.chainId, item.event.id)
                        : undefined
                    }
                    onRegenerate={
                      item === latestNarrative && regeneratePlayer !== undefined
                        ? () =>
                            onRegeneratePlayer(
                              regeneratePlayer.chainId,
                              regeneratePlayer.event.id,
                              regeneratePlayer.event.text,
                              item.requiresFreshContext === true ||
                                regeneratePlayer.requiresFreshContext ===
                                  true ||
                                (item.event.kind === "assistant" &&
                                  item.event.continuation === "unavailable"),
                            )
                        : undefined
                    }
                    failureRecovery={
                      lastActiveItem === item ? failureRecovery : undefined
                    }
                  />
                ) : null,
              )}
              {Array.from(
                new Set(
                  group.items
                    .filter(
                      (item) =>
                        item.event.kind === "followup" && item.event.failed,
                    )
                    .map((item) =>
                      item.event.kind === "followup"
                        ? `${item.chainId}:${item.event.replyEventId ?? "legacy"}`
                        : "",
                    ),
                ),
              ).map((key) => {
                const failed = group.items.filter(
                  (item) =>
                    item.event.kind === "followup" &&
                    item.event.failed &&
                    `${item.chainId}:${item.event.replyEventId ?? "legacy"}` ===
                      key,
                );
                return (
                  <li
                    key={`failed-followups:${key}`}
                    className="call-chain-followup-summary"
                  >
                    <details>
                      <summary>
                        {uiText("{count} 个后置请求未完成", {
                          count: failed.length,
                        })}
                      </summary>
                      <ol>
                        {failed.map((item) => (
                          <TimelineEvent
                            key={`${item.chainId}:${item.event.id}`}
                            client={client}
                            worldId={worldId}
                            chainId={item.chainId}
                            event={item.event}
                            restartDisabled={restartDisabled}
                            freshContextDisabled={freshContextDisabled}
                            showTechnicalInfo={showTechnicalInfo}
                            onRestartFrom={onRestartFrom}
                            onEditPlayer={onEditPlayer}
                          />
                        ))}
                      </ol>
                    </details>
                  </li>
                );
              })}
              {showTechnicalInfo ? (
                <PlayTurnCallDetails
                  items={group.items}
                  worldId={worldId}
                  liveChain={liveChain}
                  request={(request) => requestRuntime(client, request)}
                />
              ) : null}
            </Fragment>
          );
        }
        const item = group.item;
        if (item.kind === "context_boundary")
          return (
            <li
              key={group.key}
              data-timeline-item={group.key}
              className="story-context-boundary"
              role="separator"
              aria-label={uiText("全新上下文从这里开始")}
            >
              {showTechnicalInfo ? (
                <>
                  <span>{uiText("全新上下文从这里开始")}</span>
                  <small>{item.playPreset.name}</small>
                  <details className="call-chain-summary">
                    <summary>{uiText("本上下文已提交的世界变化")}</summary>
                    {item.changedDocuments.length === 0 ? (
                      <span>{uiText("没有文档变化")}</span>
                    ) : (
                      <ul>
                        {item.changedDocuments.map((change) => (
                          <li key={`${change.kind}:${change.path}`}>
                            {change.kind === "create"
                              ? uiText("新建")
                              : uiText("更新")}{" "}
                            {change.ref} · {change.path}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </>
              ) : null}
            </li>
          );
        if (item.kind === "genesis")
          return (
            <li
              key={group.key}
              data-timeline-item={group.key}
              className={`${item.role}-message`}
            >
              <article>
                <header>
                  <strong>
                    {item.role === "player" ? uiText("你") : uiText("主持")}
                  </strong>
                  {item.role === "narrator" ? (
                    <TimelineMessageMenu label={uiText("主持消息操作")}>
                      <StorySourceCopy text={item.exactText} />
                    </TimelineMessageMenu>
                  ) : null}
                </header>
                {item.role === "narrator" ? (
                  <StoryMarkdown text={item.exactText} />
                ) : (
                  <p>{item.exactText}</p>
                )}
              </article>
            </li>
          );
        return null;
      })}
    </ol>
  );
}

type PlayTimelineEventItem = Extract<V1PlayTimelineItem, { kind: "event" }>;
type PlayTimelineStandaloneItem = Exclude<
  V1PlayTimelineItem,
  { kind: "event" }
>;
type PlayTimelineGroup =
  | {
      kind: "standalone";
      key: string;
      item: PlayTimelineStandaloneItem;
    }
  | {
      kind: "turn";
      key: string;
      items: PlayTimelineEventItem[];
    };

function groupPlayTimelineItems(
  items: readonly V1PlayTimelineItem[],
): PlayTimelineGroup[] {
  const groups: PlayTimelineGroup[] = [];
  let turn: PlayTimelineEventItem[] = [];
  const flushTurn = (): void => {
    const first = turn[0];
    if (first === undefined) return;
    groups.push({
      kind: "turn",
      key: `turn:${first.chainId}:${first.event.id}`,
      items: turn,
    });
    turn = [];
  };

  for (const item of items) {
    if (item.kind !== "event") {
      flushTurn();
      groups.push({
        kind: "standalone",
        key:
          item.kind === "context_boundary"
            ? `context:${item.chainId}`
            : `genesis:${item.messageId}`,
        item,
      });
      continue;
    }
    const beginsTurn =
      item.event.kind === "player" ||
      (item.event.kind === "assistant" && turnHasCompletedNarrative(turn));
    if (beginsTurn) flushTurn();
    turn.push(item);
  }
  flushTurn();
  return groups;
}

function turnHasCompletedNarrative(
  items: readonly PlayTimelineEventItem[],
): boolean {
  return items.some(
    ({ event }) =>
      event.kind === "assistant" &&
      event.status === "completed" &&
      assistantResponseKind(event) === "narrative",
  );
}

function timelineEventBelongsInStory(
  event: V1PlayTimelineEventSummary,
): boolean {
  if (
    event.kind === "player" ||
    event.kind === "failure" ||
    event.kind === "cancellation"
  )
    return true;
  if (event.kind === "followup") return event.failed;
  if (event.kind === "tool_result")
    return (
      event.resolution !== undefined &&
      event.resolution.visibility !== "hidden" &&
      event.hiddenResolution !== true
    );
  if (event.kind !== "assistant") return false;
  return (
    event.status === "streaming" || assistantResponseKind(event) === "narrative"
  );
}

function RegenerationActions({
  restartDisabled,
  freshContextDisabled,
  onRegenerate,
  onRegenerateNarrative,
}: {
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  onRegenerate: (() => void) | undefined;
  onRegenerateNarrative: (() => void) | undefined;
}): React.JSX.Element {
  const optionsId = useId();
  const options = [
    {
      key: "rewrite",
      label: uiText("只重写这段正文"),
      description: uiText("保留本轮已生效的结果和状态变化。"),
      disabled: restartDisabled || freshContextDisabled,
      run: onRegenerateNarrative,
    },
    {
      key: "redo",
      label: uiText("整轮重来"),
      description: uiText("撤回本轮进展，从你的行动重新推演。"),
      disabled: restartDisabled,
      run: onRegenerate,
    },
  ];

  return (
    <span
      className={styles.regenerationActions}
      role="group"
      aria-labelledby={optionsId}
    >
      <strong id={optionsId}>{uiText("重新生成")}</strong>
      {options.map(({ key, label, description, disabled, run }) =>
        run === undefined ? null : (
          <button
            key={key}
            type="button"
            aria-disabled={disabled}
            aria-labelledby={`${optionsId}-${key}-label`}
            aria-describedby={`${optionsId}-${key}-description`}
            data-close-message-menu
            onClick={() => {
              if (!disabled) run();
            }}
          >
            <strong id={`${optionsId}-${key}-label`}>{label}</strong>
            <span
              className={styles.regenerationDescription}
              id={`${optionsId}-${key}-description`}
            >
              {description}
            </span>
          </button>
        ),
      )}
    </span>
  );
}

function TimelineEvent({
  failureRecovery,
  client,
  worldId,
  chainId,
  event,
  requiresFreshContext = false,
  restartDisabled,
  freshContextDisabled,
  showTechnicalInfo,
  onRestartFrom,
  onEditPlayer,
  onRegenerate,
  onRegenerateNarrative,
}: {
  client: WorldPageClient;
  worldId: string;
  chainId: string;
  event: V1PlayTimelineEventSummary;
  requiresFreshContext?: boolean | undefined;
  failureRecovery?: PlayFailureRecovery | undefined;
  restartDisabled: boolean;
  freshContextDisabled: boolean;
  showTechnicalInfo: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (
    chainId: string,
    eventId: number,
    editedText: string,
    continuation: PlayerRevisionContinuation,
  ) => void;
  onRegenerate?: (() => void) | undefined;
  onRegenerateNarrative?: (() => void) | undefined;
}): React.JSX.Element | null {
  const [detail, setDetail] = useState<V1PlayCallChainEvent | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [revisionContinuation, setRevisionContinuation] =
    useState<PlayerRevisionContinuation>("auto");
  const eventId = event.id;
  const timelineItem = `event:${chainId}:${eventId}`;
  const {
    target: detailTarget,
    syncFailed: detailFailed,
    syncError: detailError,
  } = useReadTarget(
    useCallback(
      () =>
        requestRuntime<V1PlayCallChainEvent>(client, {
          type: "play.timeline.detail",
          worldId,
          chainId,
          eventId,
        }),
      [client, worldId, chainId, eventId],
    ),
    useCallback((value: V1PlayCallChainEvent) => setDetail(value), []),
  );
  const loadDetail = async (): Promise<void> => {
    if (detail !== null || detailPending) return;
    setDetailPending(true);
    await detailTarget.read();
    setDetailPending(false);
  };

  if (event.kind === "player")
    return (
      <li className="call-chain-player" data-timeline-item={timelineItem}>
        <article>
          <header>
            <strong>{uiText("玩家")}</strong>
            {showTechnicalInfo ? (
              <span>
                {event.context === "fresh"
                  ? uiText("全新上下文")
                  : uiText("追加上下文")}
              </span>
            ) : null}
            {event.committedHead === undefined ? null : (
              <TimelineMessageMenu label={uiText("玩家消息操作")}>
                {event.committedHead === "genesis" ? null : (
                  <button
                    type="button"
                    disabled={restartDisabled}
                    data-close-message-menu
                    onClick={() => {
                      setEditedText(event.text);
                      setRevisionContinuation("auto");
                    }}
                  >
                    {uiText("修改")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={restartDisabled}
                  data-close-message-menu
                  onClick={() => onRestartFrom(event.committedHead!)}
                >
                  {uiText("创建分叉")}
                </button>
              </TimelineMessageMenu>
            )}
          </header>
          {editedText === null ? (
            <p>{event.text}</p>
          ) : (
            <div className="history-player-edit">
              <label>
                <span>{uiText("修改后的行动")}</span>
                <textarea
                  aria-label={uiText("修改后的行动")}
                  rows={3}
                  value={editedText}
                  disabled={restartDisabled}
                  onChange={(change) => setEditedText(change.target.value)}
                />
              </label>
              <p>
                {uiText(
                  "保存修改会永久删除这条原消息及之后的故事、模型对话和产物，并撤销从这条消息起的世界改动。此前的历史会保留。",
                )}
              </p>
              {requiresFreshContext ? (
                <p>
                  {uiText(
                    freshContextDisabled
                      ? "这次修改需要开启新对话。请先配置模型，再保存修改。"
                      : "此上下文来自备份；修改后须以本机选择开启全新上下文。",
                  )}
                </p>
              ) : null}
              <details className="history-player-edit-options">
                <summary>{uiText("修改后如何继续")}</summary>
                <fieldset className="history-player-edit-continuation">
                  <legend className="visually-hidden">
                    {uiText("修改后如何继续")}
                  </legend>
                  <label>
                    <input
                      type="radio"
                      name={`revision-continuation-${chainId}-${event.id}`}
                      value="auto"
                      checked={revisionContinuation === "auto"}
                      disabled={restartDisabled}
                      onChange={() => setRevisionContinuation("auto")}
                    />
                    <span>
                      <strong>{uiText("自动选择")}</strong>
                      <small>
                        {uiText("优先接着原对话；无法续传时开启新对话。")}
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`revision-continuation-${chainId}-${event.id}`}
                      value="continue_context"
                      checked={revisionContinuation === "continue_context"}
                      disabled={restartDisabled || requiresFreshContext}
                      onChange={() =>
                        setRevisionContinuation("continue_context")
                      }
                    />
                    <span>
                      <strong>{uiText("接着原对话继续")}</strong>
                      <small>
                        {uiText("保留修改点以前的模型对话和原生续传。")}
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`revision-continuation-${chainId}-${event.id}`}
                      value="fresh_context"
                      checked={revisionContinuation === "fresh_context"}
                      disabled={restartDisabled || freshContextDisabled}
                      onChange={() => setRevisionContinuation("fresh_context")}
                    />
                    <span>
                      <strong>{uiText("用新对话继续")}</strong>
                      <small>
                        {uiText("修改稿会成为新对话的第一条玩家消息。")}
                      </small>
                    </span>
                  </label>
                </fieldset>
              </details>
              <div className="button-row">
                <button
                  type="button"
                  disabled={
                    restartDisabled ||
                    editedText.trim().length === 0 ||
                    (freshContextDisabled &&
                      (requiresFreshContext ||
                        revisionContinuation === "fresh_context"))
                  }
                  onClick={() =>
                    onEditPlayer(
                      chainId,
                      event.id,
                      editedText,
                      revisionContinuation,
                    )
                  }
                >
                  {freshContextDisabled && !requiresFreshContext
                    ? uiText("保存修改")
                    : revisionContinuation === "fresh_context"
                      ? uiText("保存修改并用新对话继续")
                      : uiText("保存修改并继续")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={restartDisabled}
                  onClick={() => setEditedText(null)}
                >
                  {uiText("取消")}
                </button>
              </div>
            </div>
          )}
        </article>
      </li>
    );

  if (event.kind === "assistant") {
    const responseKind = assistantResponseKind(event);
    const responseClass =
      responseKind === "tool_step" ? "tool-step" : responseKind;
    const committedHead = event.committedHead;
    const hasHeading = showTechnicalInfo || event.status === "interrupted";
    const marginActions = !hasHeading && committedHead !== undefined;
    const actions =
      committedHead === undefined ? null : (
        <TimelineMessageMenu
          label={uiText("主持消息操作")}
          className={marginActions ? styles.narratorMarginActions : undefined}
        >
          {responseKind === "narrative" && event.text.length > 0 ? (
            <StorySourceCopy text={event.text} />
          ) : null}
          <button
            type="button"
            disabled={restartDisabled}
            data-close-message-menu
            onClick={() => onRestartFrom(committedHead)}
          >
            {uiText("创建分叉")}
          </button>
          {onRegenerateNarrative !== undefined || onRegenerate !== undefined ? (
            <RegenerationActions
              restartDisabled={restartDisabled}
              freshContextDisabled={freshContextDisabled}
              onRegenerate={onRegenerate}
              onRegenerateNarrative={onRegenerateNarrative}
            />
          ) : null}
        </TimelineMessageMenu>
      );
    return (
      <li
        className={`call-chain-assistant is-${event.status} is-${responseClass}`}
        data-timeline-item={timelineItem}
      >
        <article
          className={
            marginActions ? styles.narratorWithMarginActions : undefined
          }
        >
          {hasHeading ? (
            <header>
              {showTechnicalInfo ? (
                <>
                  <strong>
                    {event.status === "streaming"
                      ? uiText("模型响应中")
                      : responseKind === "tool_step"
                        ? uiText("模型工具步骤")
                        : responseKind === "empty"
                          ? uiText("空模型响应")
                          : uiText("AI 响应")}
                  </strong>
                  <span>{callChainAssistantStatusLabel(event.status)}</span>
                </>
              ) : (
                <strong>{uiText("中断片段")}</strong>
              )}
              {actions}
            </header>
          ) : (
            actions
          )}
          {responseKind === "tool_step" && event.text.length > 0 ? (
            <details className="call-chain-tool-step-text">
              <summary>{uiText("查看工具步骤文本（未进入故事）")}</summary>
              <p>{event.text}</p>
            </details>
          ) : event.text.length > 0 ? (
            <StoryMarkdown
              text={event.text}
              streaming={event.status === "streaming"}
            />
          ) : (
            <p>
              {event.status === "streaming"
                ? uiText("正在接收模型输出…")
                : responseKind === "tool_step"
                  ? uiText("（本次响应只调用了工具）")
                  : uiText("（本次响应没有文本）")}
            </p>
          )}
          {event.committedHead !== undefined ? (
            <ArtifactExtensionMount
              mount="story"
              reply={{ chainId, eventId: event.id }}
            />
          ) : null}
          {responseKind === "pending" ? (
            <small>{uiText("待定输出；响应完成前不会进入故事")}</small>
          ) : null}
          {showTechnicalInfo &&
          event.checkpoint === true &&
          event.status === "completed" &&
          responseKind === "narrative" ? (
            <small className="play-checkpoint-marker">{uiText("检查点")}</small>
          ) : null}
        </article>
      </li>
    );
  }

  if (event.kind === "tool_call") return null;
  if (event.kind === "tool_result")
    return event.resolution === undefined ? null : (
      <li className="call-chain-resolution" data-timeline-item={timelineItem}>
        <ResolutionCard receipt={event.resolution} />
      </li>
    );

  if (event.kind === "followup") {
    const full = detail?.kind === "followup" ? detail : null;
    return (
      <li
        className={`call-chain-followup ${event.failed ? "is-error" : "is-ok"}`}
      >
        <details
          onToggle={(change) => change.currentTarget.open && void loadDetail()}
        >
          <summary>
            <strong>
              {uiText("后置请求 · {name}", { name: event.displayName })}
            </strong>
            <span>
              {event.failed
                ? uiText("未完成")
                : uiText("{count} 项产物", { count: event.toolCallCount })}
            </span>
          </summary>
          {detailPending ? <p>{uiText("正在加载…")}</p> : null}
          <SyncNotice
            failed={detailFailed}
            reason={detailError}
            onRead={() => void detailTarget.recover()}
          />
          {full?.failure === undefined ? null : <p>{full.failure}</p>}
          <ModelRetryStatus
            retries={full?.retries ?? event.retries}
            active={event.status === "streaming"}
          />
        </details>
      </li>
    );
  }

  if (event.kind === "cancellation")
    return (
      <li
        className="call-chain-cancellation"
        data-timeline-item={timelineItem}
        role="status"
      >
        <strong>{uiText("生成已取消")}</strong>
        <p>
          {uiText(
            "本轮生成已停止；已提交的玩家原文保留，未完成的模型输出不会进入故事。",
          )}
        </p>
      </li>
    );

  return (
    <li
      className="call-chain-failure"
      data-timeline-item={timelineItem}
      role="alert"
    >
      <PlayFailureNotice
        failureKind={event.failureKind}
        canRetry={failureRecovery?.canRetry ?? false}
        message={event.message}
        recovery={failureRecovery}
      />
    </li>
  );
}

export function Transcript({
  messages,
  restartDisabled = false,
  onRestartFrom,
}: {
  messages: readonly (WorldMessage & { pending: boolean })[];
  restartDisabled?: boolean;
  onRestartFrom?: (head: string) => void;
}): React.JSX.Element {
  return (
    <ol className={`narrative-list ${styles.transcript}`}>
      {messages.map((message, index) => (
        <li
          key={message.messageId ?? `${index}-${message.role}`}
          className={`${message.role}-message ${message.pending ? "pending-message" : ""}`}
        >
          <article>
            <header>
              <strong>
                {message.role === "player" ? uiText("你") : uiText("主持")}
              </strong>
              {message.pending ? <span>{uiText("未结算")}</span> : null}
              {(message.role === "narrator" && !message.pending) ||
              (message.head !== undefined && onRestartFrom !== undefined) ? (
                <TimelineMessageMenu
                  label={
                    message.role === "player"
                      ? uiText("玩家消息操作")
                      : uiText("主持消息操作")
                  }
                >
                  {message.role === "narrator" && !message.pending ? (
                    <StorySourceCopy text={message.exactText} />
                  ) : null}
                  {message.head === undefined ||
                  onRestartFrom === undefined ? null : (
                    <button
                      type="button"
                      disabled={restartDisabled}
                      data-close-message-menu
                      onClick={() => onRestartFrom(message.head!)}
                    >
                      {uiText("创建分叉")}
                    </button>
                  )}
                </TimelineMessageMenu>
              ) : null}
            </header>
            {message.role === "narrator" ? (
              <StoryMarkdown text={message.exactText} />
            ) : (
              <p>{message.exactText}</p>
            )}
          </article>
        </li>
      ))}
    </ol>
  );
}

function callChainAssistantStatusLabel(
  status: Extract<V1PlayCallChainEvent, { kind: "assistant" }>["status"],
): string {
  if (status === "streaming") return uiText("接收中");
  if (status === "interrupted") return uiText("中断片段");
  return uiText("已完成");
}
