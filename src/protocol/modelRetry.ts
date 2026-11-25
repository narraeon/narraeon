/** Small, credential-free receipt for an automatic retry of one frozen step. */
export interface ModelRetryEvidence {
  retry: number;
  httpStatus?: 429;
  code?: "UND_ERR_CONNECT_TIMEOUT";
  retryAfterMs?: number;
  reason: "rate_limit" | "connect_timeout";
  waitMs: number;
  retryAt: number;
  status: "waiting" | "dispatching";
}

export const modelRetryLimit = {
  rate_limit: 5,
  connect_timeout: 3,
} as const;

export function validOptionalModelRetries(
  value: unknown,
): value is ModelRetryEvidence[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= modelRetryLimit.rate_limit &&
      value.every((entry: unknown, index) => {
        if (typeof entry !== "object" || entry === null) return false;
        const item = entry as Partial<ModelRetryEvidence>;
        return (
          (item.httpStatus === undefined || item.httpStatus === 429) &&
          (item.code === undefined ||
            item.code === "UND_ERR_CONNECT_TIMEOUT") &&
          (item.retryAfterMs === undefined ||
            (Number.isFinite(item.retryAfterMs) && item.retryAfterMs >= 0)) &&
          item.retry === index + 1 &&
          (item.reason === "rate_limit" || item.reason === "connect_timeout") &&
          item.retry <= modelRetryLimit[item.reason] &&
          typeof item.waitMs === "number" &&
          Number.isFinite(item.waitMs) &&
          item.waitMs >= 1000 &&
          item.waitMs <= 30_000 &&
          typeof item.retryAt === "number" &&
          Number.isFinite(item.retryAt) &&
          item.retryAt >= 0 &&
          (item.status === "waiting" || item.status === "dispatching")
        );
      }))
  );
}
