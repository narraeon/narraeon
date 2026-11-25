import { ModelCallAttempts } from "./ModelCallAttempts.tsx";
import { groupCallAttempts } from "./GroupModelCallAttempts.ts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PlayRequestContext } from "../protocol/playRequestContext.ts";
import type {
  V1PlayCallChainEvent,
  V1PlayCallChainView,
  V1PlayTimelineItem,
  V1PlayTimelineEventSummary,
  V1Request,
} from "../protocol/v1.ts";
import { PlayRequestContextDetails } from "./PlayRequestContextDetails.tsx";
import {
  ModelCallDetails,
  ModelCallDetailsGroup,
  ModelCallReasoning,
  ModelCallTools,
} from "./ModelCallDetails.tsx";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { uiText } from "./i18n.ts";

type TimelineItem = Extract<V1PlayTimelineItem, { kind: "event" }>;
type Assistant = Extract<V1PlayTimelineEventSummary, { kind: "assistant" }>;
type Followup = Extract<V1PlayTimelineEventSummary, { kind: "followup" }>;
type ToolCall = Extract<V1PlayTimelineEventSummary, { kind: "tool_call" }>;
type ToolResult = Extract<V1PlayTimelineEventSummary, { kind: "tool_result" }>;
type Ending = Extract<
  V1PlayTimelineEventSummary,
  { kind: "failure" | "cancellation" }
>;
interface Call {
  chainId: string;
  event: Assistant | Followup;
  tools: { call?: ToolCall; result?: ToolResult }[];
  endings: Ending[];
  retryOf?: string;
}

function playCalls(items: readonly TimelineItem[]) {
  const calls: Call[] = [];
  const orphanTools = new Map<string, Call["tools"]>();
  const orphanFailures: { chainId: string; event: Ending }[] = [];
  let main: Call | undefined;
  let previous: Call | undefined;
  for (const { chainId, event } of items) {
    if (event.kind === "assistant" || event.kind === "followup") {
      const parent =
        event.kind === "assistant"
          ? event.retryOf !== undefined
            ? `${chainId}:${event.retryOf}`
            : event.attempt > 1 &&
                previous?.chainId === chainId &&
                previous.event.kind === "assistant" &&
                previous.event.status === "interrupted" &&
                previous.tools.length === 0
              ? `${chainId}:${previous.event.id}`
              : undefined
          : undefined;
      const call: Call = {
        chainId,
        event,
        tools: [],
        endings: [],
        ...(parent === undefined ? {} : { retryOf: parent }),
      };
      previous = event.kind === "assistant" ? call : undefined;
      calls.push(call);
      main = event.kind === "assistant" ? call : undefined;
    } else if (event.kind === "player") {
      previous = undefined;
      main = undefined;
    } else if (event.kind === "tool_call" || event.kind === "tool_result") {
      const tools =
        main?.chainId === chainId
          ? main.tools
          : (orphanTools.get(chainId) ?? []);
      if (main?.chainId !== chainId && !orphanTools.has(chainId))
        orphanTools.set(chainId, tools);
      if (event.kind === "tool_call") tools.push({ call: event });
      else {
        const pending = tools.find(
          ({ call, result }) =>
            call?.callId === event.callId && result === undefined,
        );
        if (pending !== undefined) pending.result = event;
        else tools.push({ result: event });
      }
    } else if (event.kind === "failure" || event.kind === "cancellation") {
      if (main?.chainId === chainId) main.endings.push(event);
      else if (event.kind === "failure")
        orphanFailures.push({ chainId, event });
    }
  }
  return { calls, orphanTools, orphanFailures };
}

export function PlayTurnCallDetails({
  items,
  worldId,
  liveChain,
  request,
}: {
  items: readonly TimelineItem[];
  worldId: string;
  liveChain: V1PlayCallChainView | null;
  request: (input: V1Request) => Promise<unknown>;
}) {
  const { calls, orphanTools, orphanFailures } = playCalls(items);
  const callAttempts = groupCallAttempts(
    calls,
    (call) => `${call.chainId}:${call.event.id}`,
    (call) => call.retryOf,
  );
  if (
    calls.length === 0 &&
    orphanTools.size === 0 &&
    orphanFailures.length === 0
  )
    return null;
  return (
    <li className="world-timeline-trace">
      <ModelCallDetailsGroup
        count={calls.length === 0 ? null : callAttempts.length}
      >
        {[...orphanTools].map(([chainId, tools]) => (
          <ModelCallTools key={chainId} count={tools.length}>
            {calls.length > 0 ? <p>{uiText("仅保留部分调用记录")}</p> : null}
            {tools.map(({ call, result }) => (
              <PlayToolDetails
                key={call?.id ?? result?.id}
                call={call}
                result={result}
                load={(eventId) =>
                  request({
                    type: "play.timeline.detail",
                    worldId,
                    chainId,
                    eventId,
                  }) as Promise<V1PlayCallChainEvent>
                }
              />
            ))}
          </ModelCallTools>
        ))}
        {orphanFailures.map(({ chainId, event }) => (
          <details className="technical-details" key={`${chainId}:${event.id}`}>
            <summary>{uiText("历史调用错误")}</summary>
            <pre>{event.message}</pre>
          </details>
        ))}
        {callAttempts.map((attempts) => (
          <ModelCallAttempts
            key={`${attempts[0]!.chainId}:${attempts[0]!.event.id}`}
            attempts={attempts}
            render={({ chainId, event, tools, endings }) => {
              const ending = endings[0];
              const live =
                liveChain?.chainId === chainId && event.status === "streaming"
                  ? liveChain.events.find(
                      (candidate) =>
                        candidate.id === event.id &&
                        (candidate.kind === "assistant" ||
                          candidate.kind === "followup") &&
                        candidate.status === "streaming",
                    )
                  : undefined;
              const streaming =
                live?.kind === "assistant" || live?.kind === "followup"
                  ? live
                  : undefined;
              const load = (eventId: number) =>
                request({
                  type: "play.timeline.detail",
                  worldId,
                  chainId,
                  eventId,
                }) as Promise<V1PlayCallChainEvent>;
              const context = (
                <PlayRequestContextDetails
                  worldId={worldId}
                  chainId={chainId}
                  eventId={event.id}
                  load={(input) =>
                    request(input) as Promise<PlayRequestContext>
                  }
                >
                  {event.kind === "followup" && event.status !== "streaming" ? (
                    <TimelineDetails
                      load={() => load(event.id)}
                      label={uiText("请求编码")}
                    >
                      {(detail) =>
                        detail.kind !== "followup" ? null : (
                          <>
                            <p>
                              {uiText(
                                detail.requestPreview?.status === "completed"
                                  ? "请求编码：已收到完整响应"
                                  : detail.requestPreview?.status ===
                                      "cancelled"
                                    ? "请求编码：派发后取消"
                                    : detail.requestPreview?.status ===
                                        "attempted"
                                      ? "请求编码：已尝试派发，响应未确认"
                                      : "请求编码不可用（未提供或已超出保留窗口）",
                              )}
                            </p>
                            {detail.requestPreview?.status === "unavailable" ||
                            detail.requestPreview === undefined ? null : (
                              <pre>
                                {json(detail.requestPreview.wireRequest)}
                              </pre>
                            )}
                          </>
                        )
                      }
                    </TimelineDetails>
                  ) : null}
                </PlayRequestContextDetails>
              );
              if (event.kind === "followup") {
                return (
                  <ModelCallDetails
                    key={`${chainId}:${event.id}`}
                    retries={event.retries}
                    label={`${uiText("后置请求")} · ${event.displayName}`}
                    status={
                      event.status ??
                      (event.failed ? "interrupted" : "completed")
                    }
                    context={context}
                    reasoning={
                      <PlayCallReasoning
                        text={streaming?.reasoning}
                        recorded={
                          event.hasReasoning ?? event.status === undefined
                        }
                        streaming={event.status === "streaming"}
                        load={() => load(event.id)}
                      />
                    }
                    tools={
                      event.toolCallCount > 0 ? (
                        <TimelineDetails
                          load={() => load(event.id)}
                          label={toolLabel(event.toolCallCount)}
                        >
                          {(detail) =>
                            detail.kind === "followup" ? (
                              <>
                                {detail.text === "" ? null : (
                                  <p className="model-call-step">
                                    {detail.text}
                                  </p>
                                )}
                                {detail.toolCalls.map((call) => (
                                  <details
                                    className="technical-details"
                                    key={call.callId}
                                  >
                                    <summary>
                                      {uiText("调用 {tool}", {
                                        tool: call.name,
                                      })}{" "}
                                      ·{" "}
                                      {uiText(call.ok ? "成功" : "拒绝／失败")}
                                    </summary>
                                    <ToolParameter value={call.arguments} />
                                    <ToolReceipt markdown={call.markdown} />
                                  </details>
                                ))}
                              </>
                            ) : null
                          }
                        </TimelineDetails>
                      ) : (
                        <ModelCallTools
                          count={0}
                          fragment={streaming?.toolFragment}
                        />
                      )
                    }
                    usage={
                      event.usage ??
                      (event.status === undefined ? undefined : null)
                    }
                  />
                );
              }
              return (
                <ModelCallDetails
                  key={`${chainId}:${event.id}`}
                  retries={event.retries}
                  label={uiText("游玩主链")}
                  stopReason={
                    event.status === "completed" ? event.stopReason : undefined
                  }
                  status={
                    ending?.kind === "cancellation"
                      ? "cancelled"
                      : ending?.kind === "failure"
                        ? "interrupted"
                        : event.status
                  }
                  failure={
                    endings.length === 0
                      ? undefined
                      : endings.map(({ message }) => (
                          <span key={message}>{message}</span>
                        ))
                  }
                  context={context}
                  reasoning={
                    <PlayCallReasoning
                      text={streaming?.reasoning}
                      recorded={event.hasReasoning}
                      streaming={event.status === "streaming"}
                      load={() => load(event.id)}
                    />
                  }
                  tools={
                    <ModelCallTools
                      count={tools.length}
                      stepText={
                        event.status !== "streaming" &&
                        (event.responseKind === "tool_step" ||
                          event.status === "interrupted" ||
                          (event.responseKind === undefined &&
                            event.committedHead === undefined) ||
                          tools.length > 0)
                          ? event.text
                          : undefined
                      }
                      fragment={streaming?.toolFragment}
                    >
                      {tools.map(({ call, result }) => (
                        <PlayToolDetails
                          key={call?.id ?? result?.id}
                          call={call}
                          result={result}
                          load={load}
                        />
                      ))}
                    </ModelCallTools>
                  }
                  usage={
                    event.usage ??
                    (event.usageRecorded === true ? null : undefined)
                  }
                />
              );
            }}
          />
        ))}
      </ModelCallDetailsGroup>
    </li>
  );
}

function toolLabel(count: number): string {
  return `${uiText("工具调用")} · ${uiText("{count} 次", { count })}`;
}

function PlayCallReasoning({
  text,
  recorded,
  streaming,
  load,
}: {
  text: string | undefined;
  recorded: boolean;
  streaming: boolean;
  load: () => Promise<V1PlayCallChainEvent>;
}) {
  if (!recorded && !text) return <ModelCallReasoning />;
  return (
    <TimelineDetails
      label={uiText("模型推理")}
      load={load}
      enabled={!streaming}
      preview={text ? <pre>{text}</pre> : null}
    >
      {(detail) =>
        (detail.kind === "assistant" || detail.kind === "followup") &&
        detail.reasoning ? (
          <pre>{detail.reasoning}</pre>
        ) : (
          <p>{uiText("未返回")}</p>
        )
      }
    </TimelineDetails>
  );
}

function PlayToolDetails({
  call,
  result,
  load,
}: {
  call: ToolCall | undefined;
  result: ToolResult | undefined;
  load: (eventId: number) => Promise<V1PlayCallChainEvent>;
}) {
  const label = (
    <>
      <strong>
        {uiText("调用 {tool}", { tool: call?.name ?? result?.name ?? "" })}
      </strong>
      {" · "}
      {uiText(
        result === undefined
          ? "等待 Runtime 结果"
          : result.ok
            ? "成功"
            : "拒绝／失败",
      )}
    </>
  );
  return (
    <TimelineDetails
      label={label}
      load={() =>
        Promise.all([
          call === undefined ? null : load(call.id),
          result === undefined ? null : load(result.id),
        ])
      }
      revision={result?.id}
    >
      {([callDetail, receipt]) => (
        <>
          {callDetail?.kind === "tool_call" ? (
            <ToolParameter value={callDetail.arguments} />
          ) : null}
          {receipt?.kind === "tool_result" ? (
            <ToolReceipt markdown={receipt.markdown} />
          ) : null}
        </>
      )}
    </TimelineDetails>
  );
}

function TimelineDetails<T>({
  label,
  load,
  children,
  revision,
  enabled = true,
  preview,
}: {
  label: ReactNode;
  load: () => Promise<T>;
  children: (detail: T) => ReactNode;
  revision?: number | undefined;
  enabled?: boolean;
  preview?: ReactNode;
}) {
  const [detail, setDetail] = useState<{
    revision: number | undefined;
    value: T;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(
      () => loader.current().then((value) => ({ revision, value })),
      [revision],
    ),
    useCallback(
      (next: { revision: number | undefined; value: T }) => setDetail(next),
      [],
    ),
  );
  const read = useCallback(
    (recover = false) => {
      setPending(true);
      void (recover ? target.recover() : target.read()).finally(() =>
        setPending(false),
      );
    },
    [target],
  );
  useEffect(() => {
    // A receipt may arrive after the arguments disclosure was already open.
    if (
      enabled &&
      disclosure.current?.open &&
      (detail === null || detail.revision !== revision)
    )
      read();
  }, [revision, detail, read, enabled]);
  return (
    <details
      ref={disclosure}
      className="technical-details"
      onToggle={(event) => {
        if (
          event.currentTarget.open &&
          enabled &&
          !pending &&
          (detail === null || detail.revision !== revision)
        )
          read();
      }}
    >
      <summary>{label}</summary>
      {pending ? <p role="status">{uiText("正在加载…")}</p> : null}
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => read(true)}
      />
      {detail === null ? preview : children(detail.value)}
    </details>
  );
}

function ToolParameter({ value }: { value: unknown }) {
  return (
    <>
      <h5>{uiText("工具参数")}</h5>
      <pre>{json(value)}</pre>
    </>
  );
}

function ToolReceipt({ markdown }: { markdown: string }) {
  return (
    <>
      <h5>{uiText("Runtime 工具结果")}</h5>
      <pre>{markdown}</pre>
    </>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
