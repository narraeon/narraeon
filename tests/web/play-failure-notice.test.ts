// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { playFailureKinds } from "../../src/protocol/playFailure.ts";
import { PlayFailureNotice } from "../../src/web/PlayFailureNotice.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

const titles = [
  ["模型请求结果未知", "Model request outcome unknown"],
  ["模型上下文已达上限", "Model context limit reached"],
  ["模型输出已达上限", "Model output limit reached"],
  ["模型上下文无法继续", "Model context unavailable"],
  ["模型请求可以重新发送", "Model request can be resent"],
  ["模型连接发生错误", "Model connection error"],
  ["调用链中断", "Call chain interrupted"],
];

for (const locale of ["zh-CN", "en"] as const)
  for (const [index, failureKind] of playFailureKinds.entries())
    test(`${locale}: ${failureKind} uses localized guidance, legal actions and collapsed technical details`, () => {
      setWebLocale(locale);
      const english = locale === "en";
      const message = "Private adapter diagnostic: dispatch failed.";
      const onRetry = vi.fn();
      const onFreshContext = vi.fn();
      const onConfigureModel = vi.fn();
      render(
        createElement(PlayFailureNotice, {
          failureKind,
          // A forbidden category must never expose resend even if a stale client says true.
          canRetry: true,
          message,
          recovery: {
            canRetry: true,
            disabled: false,
            onRetry,
            onFreshContext,
            onConfigureModel,
          },
        }),
      );
      expect(screen.getByText(titles[index]![english ? 1 : 0]!)).toBeDefined();
      const description = document.querySelector("p")!.textContent;
      expect(description).not.toContain(message);
      expect(/[\u4e00-\u9fff]/u.test(description ?? "")).toBe(!english);
      const technical = screen.getByText(message).closest("details")!;
      expect(technical.open).toBe(false);
      expect(technical.querySelector("summary")?.textContent).toBe(
        english ? "Technical details" : "技术详情",
      );
      const retry = screen.queryByRole("button", {
        name: english ? "Resend request" : "重新发送",
      });
      expect(retry !== null).toBe(failureKind === "retryable");
      if (retry !== null) {
        fireEvent.click(retry);
        expect(onRetry).toHaveBeenCalledOnce();
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: english ? "Continue with a fresh context" : "从全新上下文继续",
        }),
      );
      expect(onFreshContext).toHaveBeenCalledOnce();
      const configure = screen.queryByRole("button", {
        name: english
          ? /Check model connection|Adjust maximum output/u
          : /检查模型连接|调整最大输出/u,
      });
      expect(configure !== null).toBe(
        failureKind === "provider_error" || failureKind === "output_limit",
      );
      if (configure !== null) {
        fireEvent.click(configure);
        expect(onConfigureModel).toHaveBeenCalledOnce();
      }
    });

test.each([true, false])(
  "legacy failures fall back by canRetry=%s without parsing the diagnostic",
  (canRetry) => {
    render(
      createElement(PlayFailureNotice, {
        canRetry,
        message:
          "Chat Completions request was dispatched but its outcome is unknown",
        recovery: {
          canRetry,
          disabled: false,
          onRetry: vi.fn(),
          onFreshContext: vi.fn(),
          onConfigureModel: vi.fn(),
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "重新发送" }) !== null).toBe(
      canRetry,
    );
    expect(
      screen.getByText(canRetry ? "模型请求可以重新发送" : "调用链中断"),
    ).toBeDefined();
  },
);

test("historical failures and missing replay permission do not offer resend", () => {
  const view = render(
    createElement(PlayFailureNotice, {
      failureKind: "retryable",
      canRetry: false,
      message: "old",
    }),
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    createElement(PlayFailureNotice, {
      failureKind: "retryable",
      canRetry: false,
      message: "old",
      recovery: {
        canRetry: false,
        disabled: false,
        onRetry: vi.fn(),
        onFreshContext: vi.fn(),
        onConfigureModel: vi.fn(),
      },
    }),
  );
  expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
});
