import { ModelRetryStatus } from "./ModelRetryStatus.tsx";
import type { ModelRetryEvidence } from "../protocol/modelRetry.ts";
import type { ReactNode } from "react";
import type { ModelUsage } from "../protocol/modelUsage.ts";
import { uiText } from "./i18n.ts";
import { ModelCallUsage } from "./ModelUsageBreakdown.tsx";

export function ModelCallDetailsGroup({
  count,
  children,
}: {
  count: number | null;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className="model-call-details">
      <summary>
        <span>{uiText("本段调用详情")}</span>
        <small>
          {count === null
            ? uiText("仅保留部分调用记录")
            : uiText("{count} 次模型调用", { count })}
        </small>
      </summary>
      <div className="model-call-list">{children}</div>
    </details>
  );
}

type CallStatus = "streaming" | "completed" | "interrupted" | "cancelled";

const statusLabel: Record<CallStatus, string> = {
  streaming: "正在接收",
  completed: "已完成",
  interrupted: "未完成",
  cancelled: "已取消",
};

export function ModelCallDetails({
  number,
  label,
  status = "completed",
  retryOf,
  retries,
  failure,
  context,
  reasoning,
  tools,
  usage,
}: {
  number: number;
  label?: string;
  status?: CallStatus | undefined;
  retryOf?: string | undefined;
  retries?: ModelRetryEvidence[] | undefined;
  failure?: ReactNode;
  context: ReactNode;
  reasoning: ReactNode;
  tools: ReactNode;
  usage: ModelUsage | null | undefined;
}) {
  return (
    <section className="model-call">
      <header>
        <h4>
          {uiText("第 {number} 次调用", { number })}
          {label ? ` · ${label}` : ""}
        </h4>
        <small>
          {uiText(statusLabel[status])}
          {retryOf ? ` · ${retryOf}` : ""}
        </small>
      </header>
      <ModelRetryStatus
        retries={retries}
        active={status === "streaming"}
        history
      />
      {failure ? <div className="model-call-failure">{failure}</div> : null}
      <div className="model-call-sections">
        {context}
        {reasoning}
        {tools}
        <ModelCallUsage usage={usage} />
      </div>
    </section>
  );
}

export function ModelCallReasoning({ text }: { text?: string | undefined }) {
  return text ? (
    <details className="technical-details">
      <summary>{uiText("模型推理")}</summary>
      <pre>{text}</pre>
    </details>
  ) : (
    <div className="model-call-empty">
      <span>{uiText("模型推理")}</span> · <small>{uiText("未返回")}</small>
    </div>
  );
}

export function ModelCallTools({
  count,
  stepText,
  fragment,
  children,
}: {
  count: number;
  stepText?: string | undefined;
  fragment?: string | undefined;
  children?: ReactNode;
}) {
  const label = (
    <>
      {uiText("工具调用")}
      {" · "}
      {uiText("{count} 次", { count })}
    </>
  );
  return count === 0 && !stepText && !fragment ? (
    <div className="model-call-empty">{label}</div>
  ) : (
    <details className="technical-details">
      <summary>{label}</summary>
      {stepText ? <p className="model-call-step">{stepText}</p> : null}
      {fragment ? (
        <>
          <p>{uiText("正在接收的工具调用片段")}</p>
          <pre>{fragment}</pre>
        </>
      ) : null}
      {children}
    </details>
  );
}
