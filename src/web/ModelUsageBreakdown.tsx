import type { ModelUsage, ModelUsageField } from "../protocol/modelUsage.ts";
import { getWebLocale, uiText } from "./i18n.ts";

const usageFields = [
  ["inputTokens", "输入"],
  ["uncachedInputTokens", "未缓存输入"],
  ["cacheReadTokens", "缓存读取"],
  ["cacheWriteTokens", "缓存写入"],
  ["reasoningTokens", "推理（输出内）"],
  ["outputTokens", "输出（含推理）"],
  ["totalTokens", "合计"],
] as const satisfies readonly [keyof ModelUsage["provenance"], string][];

/** Exact Provider token accounting, reusable by play and authoring surfaces. */
export function ModelUsageBreakdown({
  usage,
  compact = false,
  showProvenance = false,
}: {
  usage: ModelUsage;
  compact?: boolean;
  showProvenance?: boolean;
}): React.JSX.Element {
  return (
    <section
      className={`model-usage${compact ? " model-usage-compact" : ""}`}
      aria-label={uiText("Token 用量明细")}
    >
      <dl>
        {usageFields.map(([field, label]) => (
          <div key={field}>
            <dt>{uiText(label)}</dt>
            <dd>
              <strong>{formatUsageTokens(usage[field])}</strong>
              {usage[field] === null ? null : <span> tokens</span>}
              {showProvenance ? (
                <small>{usageProvenanceLabel(usage.provenance[field])}</small>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {showProvenance ? (
        <p>
          {uiText(
            "缓存读取和缓存写入属于输入构成；推理 tokens 已包含在输出 tokens 中，不应重复相加。",
          )}
        </p>
      ) : null}
    </section>
  );
}

function formatUsageTokens(value: number | null): string {
  return value === null
    ? uiText("未报告")
    : value.toLocaleString(getWebLocale());
}

function usageProvenanceLabel(value: ModelUsageField): string {
  if (value === "provider") return uiText("Provider 报告");
  if (value === "derived_provider_fields")
    return uiText("由 Provider 字段计算");
  return uiText("Provider 未报告");
}
