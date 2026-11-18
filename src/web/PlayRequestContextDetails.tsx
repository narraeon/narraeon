import type { ReactNode } from "react";
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
  children?: ReactNode;
}

export function PlayRequestContextDetails(props: Props): React.JSX.Element {
  return (
    <RequestContextDetails
      key={`${props.worldId}:${props.chainId}:${props.eventId}`}
      label={props.label}
      children={props.children}
      load={() =>
        props.load({
          type: "play.timeline.context",
          worldId: props.worldId,
          chainId: props.chainId,
          eventId: props.eventId,
        })
      }
    />
  );
}

export function RequestContextDetails({
  load,
  label,
  children,
}: {
  load: () => Promise<PlayRequestContext>;
  label?: string | undefined;
  children?: ReactNode;
}): React.JSX.Element {
  const [context, setContext] = useState<PlayRequestContext | null>(null);
  const [pending, setPending] = useState(false);
  const expanded = useRef(false);
  const loadContext = useRef(load);
  useEffect(() => {
    loadContext.current = load;
  }, [load]);
  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(() => loadContext.current(), []),
    useCallback((value: PlayRequestContext) => setContext(value), []),
  );
  const read = async () => {
    if (
      pending ||
      context?.status === "available" ||
      context?.status === "incomplete"
    )
      return;
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
      <summary>{label ?? uiText("本次上下文")}</summary>
      {pending ? <p role="status">{uiText("正在加载…")}</p> : null}
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => void target.recover()}
      />
      {context?.status === "unavailable" ? (
        <p>{uiText("本次上下文不可用")}</p>
      ) : null}
      {children}
      {context !== null && context.status !== "unavailable" ? (
        <>
          {context.status === "incomplete" ? (
            <p role="status">{uiText("仅保留部分上下文")}</p>
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
