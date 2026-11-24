import { expect, test, vi } from "vitest";
import {
  hardQuotaFailure,
  provenConnectTimeout,
  retryAfterMs,
  RetryableModelFailure,
  withModelRetry,
} from "../../src/runtime/model/ModelRetry.ts";
import {
  ModelHostCancelledError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "../../src/runtime/model/ModelHost.ts";
import {
  validOptionalModelRetries,
  type ModelRetryEvidence,
} from "../../src/protocol/modelRetry.ts";

test("retry budget is initial plus three attempts with bounded jitter", async () => {
  await Promise.resolve();
  const waits: number[] = [];
  const receipts: ModelRetryEvidence[] = [];
  const dispatch = vi.fn(async () => {
    await Promise.resolve();
    throw new RetryableModelFailure("rate_limit");
  });
  await expect(
    withModelRetry(dispatch, {
      random: () => 1,
      now: () => 10,
      sleep: async (ms) => {
        await Promise.resolve();
        waits.push(ms);
      },
      onRetry: (receipt) => {
        receipts.push(receipt);
      },
    }),
  ).rejects.toBeInstanceOf(ModelHostFailureError);
  expect(dispatch).toHaveBeenCalledTimes(4);
  expect(waits).toEqual([1250, 2500, 5000]);
  expect(receipts.map(({ status }) => status)).toEqual([
    "waiting",
    "dispatching",
    "waiting",
    "dispatching",
    "waiting",
    "dispatching",
  ]);
  expect(
    validOptionalModelRetries(
      receipts.filter(({ status }) => status === "waiting"),
    ),
  ).toBe(true);
});

test("Retry-After accepts seconds and HTTP dates and caps cumulative waits", async () => {
  await Promise.resolve();
  const now = Date.parse("2026-11-19T00:00:00Z");
  expect(retryAfterMs("12", now)).toBe(12000);
  expect(retryAfterMs("Thu, 19 Nov 2026 00:00:20 GMT", now)).toBe(20000);
  expect(retryAfterMs("garbage", now)).toBe(0);
  const waits: number[] = [];
  const dispatch = vi.fn(async () => {
    await Promise.resolve();
    throw new RetryableModelFailure(
      "rate_limit",
      16000,
      `upstream refusal ${waits.length + 1}`,
    );
  });
  await expect(
    withModelRetry(dispatch, {
      sleep: async (ms) => {
        await Promise.resolve();
        waits.push(ms);
      },
    }),
  ).rejects.toMatchObject({
    message:
      "Automatic retry wait limit exceeded; provider recommends waiting 16 seconds.\nupstream refusal 2",
  });
  expect(waits).toEqual([16000]);
  expect(dispatch).toHaveBeenCalledTimes(2);
});

test("cancel interrupts waiting without another dispatch", async () => {
  await Promise.resolve();
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const dispatch = vi.fn(async () => {
      await Promise.resolve();
      throw new RetryableModelFailure("connect_timeout");
    });
    const result = withModelRetry(dispatch, {
      signal: controller.signal,
      onRetry: () => controller.abort(),
    });
    await expect(result).rejects.toBeInstanceOf(ModelHostCancelledError);
    await vi.runAllTimersAsync();
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("model total deadline includes prior dispatch and waits", async () => {
  await Promise.resolve();
  const dispatch = vi.fn(async () => {
    await Promise.resolve();
    throw new RetryableModelFailure("rate_limit");
  });
  await expect(
    withModelRetry(dispatch, { deadline: 1000, now: () => 500 }),
  ).rejects.toThrow(
    new ModelHostOutcomeUnknownError(
      "Model request exceeded its total time limit",
    ),
  );
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test("only real Undici connection timeout code proves dispatch did not happen", () => {
  expect(
    provenConnectTimeout(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    ),
  ).toBe(true);
  expect(provenConnectTimeout(new Error("connect timeout"))).toBe(false);
  expect(
    provenConnectTimeout(
      Object.assign(new Error("headers timeout"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      }),
    ),
  ).toBe(false);
});

test("hard quota evidence is explicit and billing links remain retryable", () => {
  expect(hardQuotaFailure('{"error":{"code":"insufficient_quota"}}')).toBe(
    true,
  );
  expect(hardQuotaFailure("Your credit balance is depleted")).toBe(true);
  expect(hardQuotaFailure("Your credit balance is too low")).toBe(true);
  expect(
    hardQuotaFailure(
      JSON.stringify({ error: { code: "insufficient_balance" } }),
    ),
  ).toBe(true);
  expect(
    hardQuotaFailure(
      "Rate exceeded; inspect billing https://provider/billing and retry in 2 seconds",
    ),
  ).toBe(false);
  expect(
    hardQuotaFailure(
      "Resource exhausted: requests per day rate; retry delay 1s",
    ),
  ).toBe(false);
});

test("retry receipts accept legacy absence and reject malformed persisted values", () => {
  expect(validOptionalModelRetries(undefined)).toBe(true);
  expect(
    validOptionalModelRetries([
      {
        retry: 1,
        reason: "rate_limit",
        waitMs: 1000,
        retryAt: 1000,
        status: "waiting",
      },
    ]),
  ).toBe(true);
  for (const broken of [
    null,
    {},
    [{ retry: 1 }],
    [
      {
        retry: 2,
        reason: "rate_limit",
        waitMs: 1000,
        retryAt: 0,
        status: "waiting",
      },
    ],
  ])
    expect(validOptionalModelRetries(broken)).toBe(false);
});

test("cumulative cap without a new Retry-After never invents a zero-second provider recommendation", async () => {
  await Promise.resolve();
  let count = 0;
  const waits: number[] = [];
  await expect(
    withModelRetry(
      async () => {
        await Promise.resolve();
        count += 1;
        throw new RetryableModelFailure("rate_limit", count === 1 ? 28000 : 0);
      },
      {
        random: () => 1,
        sleep: async (ms) => {
          await Promise.resolve();
          waits.push(ms);
        },
      },
    ),
  ).rejects.toThrow("Please try again later");
  expect(waits).toEqual([28000]);
  expect(count).toBe(2);
});
