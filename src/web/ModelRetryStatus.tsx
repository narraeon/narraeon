import {
  modelRetryLimit,
  type ModelRetryEvidence,
} from "../protocol/modelRetry.ts";
import { uiText } from "./i18n.ts";

export function ModelRetryStatus({
  retries,
  active = false,
}: {
  retries?: ModelRetryEvidence[] | undefined;
  active?: boolean;
}) {
  const waiting = active && retries?.at(-1)?.status === "waiting";
  const entries = waiting ? retries?.slice(-1) : [];
  if (!entries?.length) return null;
  return (
    <div className="model-retry-status" role={waiting ? "status" : undefined}>
      {entries.map((entry) => (
        <p key={entry.retry}>
          {uiText(
            entry.reason === "rate_limit" ? "服务商暂时限流" : "连接建立超时",
          )}
          {" · "}
          {uiText("自动重试 {retry}/{limit}", {
            retry: entry.retry,
            limit: modelRetryLimit[entry.reason],
          })}
          {" · "}
          {uiText("等待约 {seconds} 秒", {
            seconds: Math.ceil(entry.waitMs / 1000),
          })}
          {waiting && entry === retries?.at(-1)
            ? ` · ${uiText("等待中，可停止")}`
            : ""}
        </p>
      ))}
    </div>
  );
}

/** The Runtime emits this bounded receipt when Retry-After exceeds its budget. */
export function ModelRetryLimitNotice({
  message,
}: {
  message: string | null | undefined;
}) {
  const seconds =
    /^Automatic retry wait limit exceeded; provider recommends waiting (\d+) seconds\.$/u.exec(
      message?.split("\n", 1)[0] ?? "",
    )?.[1];
  return seconds === undefined ? null : (
    <p>{uiText("服务商建议等待 {seconds} 秒后再试。", { seconds })}</p>
  );
}
