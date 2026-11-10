import { useEffect, useRef, useState } from "react";
import type { PlayRequestContext } from "../protocol/playRequestContext.ts";
import type { V1Request } from "../protocol/v1.ts";
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
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  const loading = useRef(false);
  const expanded = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const read = async () => {
    if (loading.current || context !== null) return;
    loading.current = true;
    setPending(true);
    setFailed(false);
    try {
      const result = await load({
        type: "play.timeline.context",
        worldId,
        chainId,
        eventId,
      });
      if (active.current) setContext(result);
    } catch {
      if (active.current) setFailed(true);
    } finally {
      loading.current = false;
      if (active.current) setPending(false);
    }
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
      {failed ? (
        <p role="alert">
          {uiText("上下文加载失败")}{" "}
          <button type="button" onClick={() => void read()}>
            {uiText("重试")}
          </button>
        </p>
      ) : null}
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
            <section key={index}>
              <strong>{message.role}</strong>
              <pre>{message.text}</pre>
            </section>
          ))}
        </>
      ) : null}
    </details>
  );
}
