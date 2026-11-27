// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { chatGptUsageUrl } from "../../src/protocol/chatGptAuth.ts";
import {
  playFailureKinds,
  type PlayFailureKind,
} from "../../src/protocol/playFailure.ts";
import { PlayFailureNotice } from "../../src/web/PlayFailureNotice.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

test.each(["zh-CN", "en"] as const)(
  "%s: output-limit continuation is independent of resend and locks during generation",
  (locale) => {
    setWebLocale(locale);
    const onContinuePartial = vi.fn();
    const recovery = {
      canRetry: false,
      canContinuePartial: true,
      playDisabled: false,
      configureDisabled: false,
      onRetry: vi.fn(),
      onContinuePartial,
      onConfigureModel: vi.fn(),
    };
    const props = {
      failureKind: "output_limit" as const,
      canRetry: false,
      message: "limit",
      recovery,
    };
    const view = render(createElement(PlayFailureNotice, props));
    expect(view.container.querySelector("p")?.textContent).toContain(
      locale === "en" ? "saved partial reply" : "从已保存的部分回复接着生成",
    );
    const name = locale === "en" ? "Continue response" : "续写";
    expect(
      screen.queryByRole("button", {
        name: locale === "en" ? "Resend request" : "重新发送",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(onContinuePartial).toHaveBeenCalledOnce();
    view.rerender(
      createElement(PlayFailureNotice, {
        ...props,
        recovery: { ...recovery, playDisabled: true },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name }));
    expect(onContinuePartial).toHaveBeenCalledOnce();
    view.rerender(
      createElement(PlayFailureNotice, {
        ...props,
        recovery: { ...recovery, canContinuePartial: false },
      }),
    );
    expect(screen.queryByRole("button", { name })).toBeNull();
  },
);

test.each(["zh-CN", "en"] as const)(
  "%s: invalidated context offers only the new composer",
  (locale) => {
    setWebLocale(locale);
    const onFreshContext = vi.fn();
    const onRetry = vi.fn();
    const onContinuePartial = vi.fn();
    render(
      createElement(PlayFailureNotice, {
        message: "stale",
        failureKind: "provider_error",
        canRetry: true,
        recovery: {
          freshContextReason: "files_changed",
          canRetry: true,
          canContinuePartial: true,
          onRetry,
          onContinuePartial,
          onFreshContext,
          onConfigureModel: vi.fn(),
          playDisabled: false,
          configureDisabled: false,
        },
      }),
    );
    const button = screen.getByRole("button", {
      name: locale === "en" ? "Use new context" : "用新上下文",
    });
    expect(screen.getAllByRole("button")).toEqual([button]);
    fireEvent.click(button);
    expect(onFreshContext).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onContinuePartial).not.toHaveBeenCalled();
  },
);

const titles: Record<PlayFailureKind, readonly [string, string]> = {
  outcome_unknown: ["模型请求结果未知", "Model request outcome unknown"],
  context_limit: ["模型上下文已达上限", "Model context limit reached"],
  output_limit: ["模型输出已达上限", "Model output limit reached"],
  context_unavailable: ["模型上下文无法继续", "Model context unavailable"],
  retryable: ["模型请求可以重新发送", "Model request can be resent"],
  provider_error: ["模型连接发生错误", "Model connection error"],
  other: ["调用链中断", "Call chain interrupted"],
  configuration_mismatch: [
    "旧模型配置曾阻止发送",
    "Previous model settings blocked sending",
  ],
  dispatch_budget: ["游玩生成已暂停", "Play generation paused"],
  chatgpt_plan_quota: [
    "ChatGPT 套餐使用达到上限",
    "ChatGPT plan usage limit reached",
  ],
  chatgpt_plan_authorization: [
    "ChatGPT 套餐授权不可用",
    "ChatGPT plan authorization unavailable",
  ],
};

for (const locale of ["zh-CN", "en"] as const)
  for (const failureKind of playFailureKinds)
    test(`${locale}: ${failureKind} uses localized guidance, legal actions and collapsed technical details`, () => {
      setWebLocale(locale);
      const english = locale === "en";
      const message = "Private adapter diagnostic: dispatch failed.";
      const onRetry = vi.fn();
      const onConfigureModel = vi.fn();
      const recovery = {
        canRetry: true,
        playDisabled: false,
        configureDisabled: false,
        onRetry,
        onConfigureModel,
      };
      const props = { failureKind, canRetry: true, message, recovery };
      const view = render(createElement(PlayFailureNotice, props));
      expect(
        screen.getByText(titles[failureKind][english ? 1 : 0]),
      ).toBeDefined();
      const description = document.querySelector("p")!.textContent;
      expect(description).not.toContain(message);
      expect(/[\u4e00-\u9fff]/u.test(description ?? "")).toBe(!english);
      const technical = screen.getByText(message).closest("details")!;
      expect(technical.open).toBe(false);
      expect(technical.querySelector("summary")?.textContent).toBe(
        english ? "Technical details" : "技术详情",
      );
      const resumeLabel =
        failureKind === "dispatch_budget"
          ? english
            ? "Continue generating"
            : "继续生成"
          : english
            ? "Resend request"
            : "重新发送";
      const retry = screen.queryByRole("button", { name: resumeLabel });
      expect(retry).not.toBeNull();
      if (retry !== null) {
        fireEvent.click(retry);
        expect(onRetry).toHaveBeenCalledOnce();
      }
      expect(
        screen.queryByRole("button", {
          name: english ? "Use new context" : "用新上下文",
        }),
      ).toBeNull();
      const configure = screen.queryByRole("button", {
        name: english
          ? /Check model connection|Adjust maximum output/u
          : /检查模型连接|调整最大输出/u,
      });
      expect(configure !== null).toBe(
        failureKind === "provider_error" ||
          failureKind === "output_limit" ||
          failureKind === "chatgpt_plan_authorization",
      );
      if (configure !== null) {
        fireEvent.click(configure);
        expect(onConfigureModel).toHaveBeenCalledOnce();
      }
      const usageLink = screen.queryByRole("link", {
        name: english ? "Manage ChatGPT usage" : "管理 ChatGPT 用量",
      });
      expect(usageLink?.getAttribute("href") ?? null).toBe(
        failureKind === "chatgpt_plan_quota" ? chatGptUsageUrl : null,
      );
      view.rerender(
        createElement(PlayFailureNotice, { ...props, canRetry: false }),
      );
      expect(document.querySelector("p")?.textContent).not.toMatch(
        /全新上下文|fresh context/iu,
      );
      expect(screen.queryByRole("button", { name: resumeLabel })).toBeNull();
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
          playDisabled: false,
          configureDisabled: false,
          onRetry: vi.fn(),
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
        playDisabled: false,
        configureDisabled: false,
        onRetry: vi.fn(),
        onConfigureModel: vi.fn(),
      },
    }),
  );
  expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
});
