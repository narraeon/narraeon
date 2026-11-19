import type { ModelRetryEvidence } from "../../protocol/modelRetry.ts";
import {
  ModelHostCancelledError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "./ModelHost.ts";

export class RetryableModelFailure extends ModelHostFailureError {
  readonly reason: ModelRetryEvidence["reason"];
  readonly retryAfterMs: number;
  constructor(reason: ModelRetryEvidence["reason"], retryAfterMs = 0) {
    super(
      reason === "rate_limit"
        ? "Provider temporarily rate limited the request"
        : "Connection timed out before dispatch",
      {
        details: {
          reason,
          retryAfterMs,
          ...(reason === "rate_limit"
            ? { httpStatus: 429 }
            : { code: "UND_ERR_CONNECT_TIMEOUT" }),
        },
      },
    );
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (value === null || value.trim() === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function hardQuotaFailure(evidence: string): boolean {
  return /insufficient_quota|insufficient_balance|quota_exhausted|(?:credit|balance).*(?:too.low|not.enough)|billing_hard_limit_reached|(?:credit|balance).*(?:exhausted|insufficient|depleted)|(?:exhausted|insufficient).*(?:credit|balance)|spending.limit.*(?:exceeded|reached)|daily.(?:limit|quota).*(?:exceeded|exhausted)|hard.quota|quota[^\n]{0,120}limit["\s:]*0/iu.test(
    evidence,
  );
}

/** Undici's connection timeout is emitted before a connection can send bytes. */
export function provenConnectTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  return (
    ("code" in error && error.code === "UND_ERR_CONNECT_TIMEOUT") ||
    (cause instanceof Error &&
      "code" in cause &&
      cause.code === "UND_ERR_CONNECT_TIMEOUT")
  );
}

export async function withModelRetry<T>(
  dispatch: () => Promise<T>,
  options: {
    signal?: AbortSignal | undefined;
    onRetry?:
      ((evidence: ModelRetryEvidence) => Promise<void> | void) | undefined;
    deadline?: number | undefined;
    random?: () => number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  let total = 0;
  for (let retry = 0; ; retry += 1) {
    if (options.signal?.aborted) throw cancelled();
    if (
      options.deadline !== undefined &&
      (options.now ?? Date.now)() >= options.deadline
    )
      throw deadlineExceeded();
    try {
      return await dispatch();
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (!(error instanceof RetryableModelFailure) || retry >= 3) throw error;
      const waitMs = Math.max(
        1000 * 2 ** retry * (1 + (options.random ?? Math.random)() * 0.25),
        error.retryAfterMs,
      );
      if (total + waitMs > 30_000)
        throw new ModelHostFailureError(
          error.retryAfterMs > 0
            ? `Automatic retry wait limit exceeded; provider recommends waiting ${Math.ceil(error.retryAfterMs / 1000)} seconds.`
            : "Automatic retry wait limit exceeded. Please try again later.",
          {
            cause: error,
            details: {
              reason: error.reason,
              retryAfterMs: error.retryAfterMs,
              totalWaitMs: total,
            },
          },
        );
      if (
        options.deadline !== undefined &&
        (options.now ?? Date.now)() + waitMs >= options.deadline
      )
        throw deadlineExceeded();
      total += waitMs;
      const evidence: ModelRetryEvidence = {
        ...(error.reason === "rate_limit"
          ? { httpStatus: 429 as const }
          : { code: "UND_ERR_CONNECT_TIMEOUT" as const }),
        retryAfterMs: error.retryAfterMs,
        retry: retry + 1,
        reason: error.reason,
        waitMs,
        retryAt: (options.now ?? Date.now)() + waitMs,
        status: "waiting",
      };
      await options.onRetry?.(evidence);
      await (options.sleep ?? cancellableWait)(waitMs, options.signal);
      if (options.signal?.aborted) throw cancelled();
      await options.onRetry?.({ ...evidence, status: "dispatching" });
    }
  }
}

function cancelled(): ModelHostCancelledError {
  return new ModelHostCancelledError(
    "The model request was stopped during automatic retry.",
  );
}
function cancellableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function deadlineExceeded(): ModelHostOutcomeUnknownError {
  return new ModelHostOutcomeUnknownError(
    "Google Interactions exceeded its total time limit",
  );
}
