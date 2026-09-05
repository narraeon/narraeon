import type { WorldPromptPrefixComparison } from "../protocol/worldPromptDiagnostics.ts";
import { getWebLocale } from "./i18n.ts";

export function WorldPromptDiagnosticsPanel({
  report,
  preview = false,
}: {
  report: WorldPromptPrefixComparison | undefined;
  preview?: boolean;
}): React.JSX.Element | null {
  if (report === undefined) return null;
  const zh = getWebLocale() === "zh-CN";
  const logical = report.logical;
  const encoding = report.encoding;
  const cacheLabels = zh
    ? {
        same: "相同",
        different: "不同",
        absent: "均未设置",
        unavailable: "缺少对照",
      }
    : {
        same: "Same",
        different: "Different",
        absent: "Both absent",
        unavailable: "Unavailable",
      };
  return (
    <section className="panel-card prompt-preview-detail">
      <h3>
        {preview
          ? zh
            ? "下一次全新上下文的前缀预测"
            : "Next fresh context prefix preview"
          : zh
            ? "相邻新上下文的实际前缀变化"
            : "Actual prefix changes between adjacent contexts"}
      </h3>
      <p>
        {preview
          ? zh
            ? "按当前世界和配置预测；尚未包含下一条玩家输入，也没有发送此请求。"
            : "Predicted from current world and controls; excludes the next player input and has not been sent."
          : zh
            ? "比较当前时间线上上一上下文与当前上下文建立时冻结的文本；不会修改既有请求。"
            : "Compares frozen bootstraps of the previous and current contexts on this timeline; existing requests remain untouched."}
      </p>
      {logical === null ? (
        <p>{zh ? "尚无相邻上下文样本。" : "No adjacent context sample yet."}</p>
      ) : (
        <>
          <p>
            {zh ? "逻辑文本公共前缀" : "Common logical text prefix"}:{" "}
            {logical.commonPrefixBytes.toLocaleString()} UTF-8{" "}
            {zh ? "字节" : "bytes"} / {logical.currentBytes.toLocaleString()}.{" "}
            {zh ? "首次变化来源" : "First changed source"}:{" "}
            {logical.firstChangedSource ?? "—"}
          </p>
          <details>
            <summary>
              {zh
                ? "变化来源与当前材料顺序"
                : "Changed sources and current material order"}
            </summary>
            <ul>
              {logical.changedSources.map((source, index) => (
                <li key={index}>
                  {source.source} · {source.change} ·{" "}
                  {source.previousPosition ?? "—"} →{" "}
                  {source.currentPosition ?? "—"} · {source.previousBytes} →{" "}
                  {source.currentBytes} bytes
                </li>
              ))}
            </ul>
            <ol>
              {logical.currentOrder.map((source) => (
                <li key={source.position}>
                  {source.role} · {source.source} · {source.bytes} bytes
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      <p>
        {zh
          ? "Provider 编码 JSON 的公共前缀"
          : "Common prefix of encoded Provider JSON"}
        :{" "}
        {encoding.commonJsonPrefixBytes?.toLocaleString() ??
          (zh ? "未记录完整对照" : "Comparison unavailable")}{" "}
        {encoding.commonJsonPrefixBytes === null ? "" : "bytes"}.{" "}
        {zh ? "首次变化字段" : "First changed field"}:{" "}
        {encoding.firstChangedPath ?? "—"}
      </p>
      <p>
        {zh ? "缓存键对照" : "Cache key comparison"}:{" "}
        {cacheLabels[encoding.cacheKey]}.{" "}
        {zh
          ? "逻辑文本和 JSON 字节前缀都不等于 Provider 可命中的 token 前缀；缓存分块和会话隔离仍由实际协议决定。"
          : "Neither logical nor JSON byte prefixes equal Provider-cacheable token prefixes. Encoding and session isolation still govern cache behavior."}
      </p>
      <details>
        <summary>
          {zh
            ? "实际内容块与缓存断点"
            : "Encoded content blocks and cache breakpoints"}
        </summary>
        {[
          {
            label: zh ? "前一请求" : "Previous request",
            value: encoding.previous,
          },
          {
            label: zh ? "后一请求" : "Current request",
            value: encoding.current,
          },
        ].map(({ label, value }) =>
          typeof value === "object" && value !== null ? (
            <div key={label}>
              <h4>
                {label} · {value.provider}
              </h4>
              <p>{value.jsonBytes} JSON bytes</p>
              <ul>
                {value.contentBlocks.map((block) => (
                  <li key={block.path}>
                    {block.path} · {block.bytes} bytes
                  </li>
                ))}
              </ul>
              <p>
                {zh ? "断点" : "Breakpoints"}:{" "}
                {value.cacheBreakpoints.join(", ") ||
                  (zh ? "无显式断点" : "No explicit breakpoints")}
              </p>
            </div>
          ) : null,
        )}
      </details>
      {report.suggestions.length > 0 && (
        <div>
          <h4>
            {zh ? "可手动尝试的顺序调整" : "Ordering changes to consider"}
          </h4>
          <p>
            {zh
              ? "以下来源本次发生变化，且排在较大的未变化材料之前。可在世界控制中把稳定材料前移；覆盖标记等 Runtime 来源需要调整相应主持框架。不会自动排序，收益需要实测。"
              : "These changed sources precede larger unchanged material. Consider moving stable materials earlier in world controls; Runtime coverage blocks require the corresponding host frame adjustment. Ordering stays explicit and benefits require measurement."}
          </p>
          <ul>
            {report.suggestions.map((item, index) => (
              <li key={index}>
                {item.afterSource} → {item.source}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!preview && (
        <div>
          <h4>
            {zh
              ? "各上下文首个完成请求的 Provider usage"
              : "Provider usage for each context’s first completed request"}
          </h4>
          {[report.providerUsage.previous, report.providerUsage.current].map(
            (usage, index) => (
              <p key={index}>
                {index === 0
                  ? zh
                    ? "上一上下文"
                    : "Previous"
                  : zh
                    ? "当前上下文"
                    : "Current"}
                : cache read {usage?.cacheReadTokens ?? "—"}; cache write{" "}
                {usage?.cacheWriteTokens ?? "—"}; uncached input{" "}
                {usage?.uncachedInputTokens ?? "—"}
              </p>
            ),
          )}
        </div>
      )}
      <p>
        {zh
          ? "缓存收益尚未实测。未报告的 usage 显示为“—”，不会当作零；CLIProxyAPI 的上下文隔离键不会为提高命中率而改动。"
          : "Cache benefit has not been measured. Unreported usage appears as ‘—’, never zero. CLIProxyAPI context isolation keys are preserved."}
      </p>
    </section>
  );
}
