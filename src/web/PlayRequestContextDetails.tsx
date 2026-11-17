import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayRequestContext } from "../protocol/playRequestContext.ts";
import type { V1Request } from "../protocol/v1.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { uiText } from "./i18n.ts";

interface Props {
  load: (request: V1Request) => Promise<PlayRequestContext>;
  worldId: string;
  chainId: string;
  eventId: number;
  label?: string;
}

export function PlayRequestContextDetails(props: Props): React.JSX.Element {
  return (
    <ContextDetails
      key={`${props.worldId}:${props.chainId}:${props.eventId}`}
      {...props}
    />
  );
}

function ContextDetails({
  load,
  worldId,
  chainId,
  eventId,
  label,
}: Props): React.JSX.Element {
  const [context, setContext] = useState<PlayRequestContext | null>(null);
  const [pending, setPending] = useState(false);
  const expanded = useRef(false);
  const loadContext = useRef(load);
  useEffect(() => {
    loadContext.current = load;
  }, [load]);
  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(
      () =>
        loadContext.current({
          type: "play.timeline.context",
          worldId,
          chainId,
          eventId,
        }),
      [worldId, chainId, eventId],
    ),
    useCallback((value: PlayRequestContext) => setContext(value), []),
  );
  const read = async () => {
    if (context !== null) return;
    setPending(true);
    await target.read();
    setPending(false);
  };
  return (
    <details
      className="technical-details"
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (open && !expanded.current) void read();
        expanded.current = open;
      }}
    >
      <summary>{label ?? uiText("当时的上下文")}</summary>
      {pending ? <p role="status">{uiText("正在加载…")}</p> : null}
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => void target.recover()}
      />
      {context?.status === "unavailable" ? (
        <p>{uiText("当时的上下文不可用（旧记录缺少完整证据或记录已失效）")}</p>
      ) : null}
      {context !== null && context.status !== "unavailable" ? (
        <>
          {context.status === "incomplete" ? (
            <p role="status">
              {uiText(
                "仅保留当时的提示和初始材料；无法确认完整对话边界及本轮提示。",
              )}
            </p>
          ) : null}
          <p>
            {uiText(
              "历史逻辑上下文；原生续传载荷已省略。记录表示尝试派发，不保证服务端已收到。",
            )}
          </p>
          {context.messages.map((message, index) => (
            <details className="technical-details" key={index}>
              <summary>{message.role}</summary>
              <pre>{message.text}</pre>
            </details>
          ))}
        </>
      ) : null}
    </details>
  );
}
