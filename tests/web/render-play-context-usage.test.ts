// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type {
  V1PlayCallChainView,
  V1PlayTimelineEventSummary,
  V1PlayTimelinePage,
} from "../../src/protocol/v1.ts";
import { PlayContextUsage } from "../../src/web/PlayContextUsage.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(cleanup);

test.each(["fresh", null])(
  "当前时间线切换上下文时拒绝旧链占用缓存：%s",
  (activeChainId) => {
    show([response(9_000)], {
      chain: {
        ...chain,
        latestCompletedResponse: { id: 2, usage: response(9_000).usage! },
      },
      timeline: { ...timeline([response(9_000)]), activeChainId },
    });
    expect(screen.getByText("上下文 —").title).toBe(
      "当前上下文尚无已完成的 AI 响应。",
    );
    expect(screen.queryByText("上下文 90%")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "下一条消息使用全新上下文" }),
    ).toBeNull();
  },
);

test("新链已有实报响应时也不能借用旧链窗口计算占用", () => {
  const page = timeline([response(9_000)]);
  page.activeChainId = "fresh";
  page.items = page.items.map((item) =>
    item.kind === "event" ? { ...item, chainId: "fresh" } : item,
  );
  show([], {
    chain: {
      ...chain,
      latestCompletedResponse: { id: 2, usage: response(9_000).usage! },
    },
    timeline: page,
  });
  expect(screen.getByText("上下文 —").title).toBe(
    "当前上下文没有记录模型窗口。",
  );
  expect(screen.queryByRole("status")).toBeNull();
});

test.each([9_000, null])(
  "较新的同链完成响应覆盖旧 projection，最新缺失时不回退：%s",
  (input) => {
    const latest = { ...response(input), id: 2 };
    if (input === null) delete latest.usage;
    show([latest], {
      chain: {
        ...chain,
        latestCompletedResponse: { id: 1, usage: response(6_200).usage! },
      },
    });
    expect(
      screen.getByText(input === null ? "上下文 —" : "上下文 90%"),
    ).toBeTruthy();
    expect(screen.queryByText("上下文 62%")).toBeNull();
  },
);

function response(
  inputTokens: number | null,
): Extract<V1PlayTimelineEventSummary, { kind: "assistant" }> {
  return {
    id: 1,
    kind: "assistant",
    text: "The story continues.",
    status: "completed",
    exchange: 1,
    attempt: 1,
    usage: {
      ...emptyAggregatedModelUsage(),
      inputTokens,
      provenance: {
        ...emptyAggregatedModelUsage().provenance,
        inputTokens: inputTokens === null ? "unavailable" : "provider",
      },
    },
    hasReasoning: false,
    hasToolFragment: false,
    hasUsage: true,
    detailsAvailable: true,
  };
}

const chain: V1PlayCallChainView = {
  worldId: "world",
  chainId: "current",
  baselineHead: "genesis",
  parentHead: "commit:2",
  contextWindowTokens: 10_000,
  playPreset: { id: "preset", name: "Preset", revision: "1" },
  status: "ready",
  canRetry: false,
  events: [],
  changedDocuments: [],
  previousContexts: [],
  lastFailure: null,
  updatedAt: 0,
};

function timeline(events: V1PlayTimelineEventSummary[]): V1PlayTimelinePage {
  return {
    worldId: "world",
    generation: "generation",
    activeChainId: "current",
    activeStatus: "ready",
    activeCanRetry: false,
    activeLastFailure: null,
    items: events.map((event) => ({
      kind: "event",
      chainId: "current",
      current: true,
      event,
    })),
    nextCursor: null,
  };
}

function show(
  events: V1PlayTimelineEventSummary[],
  overrides: Partial<Parameters<typeof PlayContextUsage>[0]> = {},
) {
  const props = {
    chain,
    timeline: timeline(events),
    freshContextSelected: false,
    freshContextDisabled: false,
    onUseFreshContext: vi.fn(),
    ...overrides,
  };
  return { props, ...render(createElement(PlayContextUsage, props)) };
}

test("占用使用最新完整主响应，不累计输入、不加输出、不使用后置或流式 usage", () => {
  const latest = response(6_200);
  latest.responseKind = "tool_step";
  if (latest.kind !== "assistant" || latest.usage === undefined)
    throw new Error("Expected assistant usage");
  latest.usage.outputTokens = 3_000;
  show([
    response(9_900),
    { ...latest, id: 2 },
    { ...response(9_000), id: 3, status: "streaming" },
    {
      id: 4,
      kind: "followup",
      followupId: "followup",
      displayName: "Follow-up",
      toolCallCount: 0,
      failed: false,
      usage: latest.usage,
      detailsAvailable: true,
    },
    { ...latest, id: 5, status: "interrupted" },
  ]);
  expect(screen.getByText("上下文 62%").title).toContain("6200 / 10000");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test.each([
  [8_499, false],
  [8_500, true],
  [10_500, true],
])("85%% 提示按实际比例判断：%i", (input, warn) => {
  const { props } = show([response(input)]);
  const button = screen.queryByRole("button", {
    name: "下一条消息使用全新上下文",
  });
  expect(button !== null).toBe(warn);
  expect(screen.getByText(`上下文 ${Math.floor(input / 100)}%`)).toBeTruthy();
  if (button !== null) {
    fireEvent.click(button);
    expect(props.onUseFreshContext).toHaveBeenCalledOnce();
  }
});

const noWindow = { ...chain };
delete noWindow.contextWindowTokens;
const noUsage = response(6_200);
delete noUsage.usage;

test.each([
  [[], chain, "当前上下文尚无已完成的 AI 响应。"],
  [[response(6_200)], noWindow, "当前上下文没有记录模型窗口。"],
  [[response(null)], chain, "Provider 未报告最近一次完整响应的输入 token 数。"],
  [[noUsage], chain, "Provider 未报告最近一次完整响应的输入 token 数。"],
])("缺失实报量或冻结窗口显示横线并说明原因", (events, context, reason) => {
  show(events, { chain: context });
  expect(screen.getByText("上下文 —").title).toBe(reason);
  expect(screen.queryByText("上下文 0%")).toBeNull();
});

test("provenance 不可用时忽略非空输入值，真实零和派生 Provider 字段仍可显示", () => {
  const event = response(9_000);
  if (event.kind !== "assistant" || event.usage === undefined)
    throw new Error("Expected usage");
  event.usage.provenance.inputTokens = "unavailable";
  const shown = show([event]);
  expect(screen.getByText("上下文 —")).toBeTruthy();
  const zero = response(0);
  if (zero.kind !== "assistant" || zero.usage === undefined)
    throw new Error("Expected usage");
  zero.usage.provenance.inputTokens = "derived_provider_fields";
  shown.rerender(
    createElement(PlayContextUsage, {
      ...shown.props,
      timeline: timeline([zero]),
    }),
  );
  expect(screen.getByText("上下文 0%")).toBeTruthy();
});

test("已预选或开启全新上下文后不显示旧提示，旧链实报量不能沿用", () => {
  const shown = show([response(9_000)]);
  shown.rerender(
    createElement(PlayContextUsage, {
      ...shown.props,
      freshContextSelected: true,
    }),
  );
  expect(screen.queryByRole("status")).toBeNull();
  shown.rerender(
    createElement(PlayContextUsage, {
      ...shown.props,
      chain: { ...chain, chainId: "fresh" },
      timeline: { ...timeline([]), activeChainId: "fresh" },
    }),
  );
  expect(screen.getByText("上下文 —").title).toBe(
    "当前上下文尚无已完成的 AI 响应。",
  );
  expect(screen.queryByRole("status")).toBeNull();
});

test("英文显示比例、提示和缺失原因", () => {
  setWebLocale("en");
  const shown = show([response(8_500)]);
  expect(screen.getByText("Context 85%")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "Context usage is 85%.",
  );
  expect(
    screen.getByRole("button", {
      name: "Use a fresh context for the next message",
    }),
  ).toBeTruthy();
  shown.rerender(
    createElement(PlayContextUsage, { ...shown.props, timeline: timeline([]) }),
  );
  expect(screen.getByText("Context —").title).toBe(
    "There is no completed AI response in the current context yet.",
  );
});

test("完整响应已离开有界摘要页时仍用调用链最近实报；最新未报告不能回退旧值", () => {
  const latest = response(6_200);
  const shown = show([response(9_000)], {
    chain: {
      ...chain,
      latestCompletedResponse: { id: 2, usage: latest.usage! },
    },
  });
  expect(screen.getByText("上下文 62%")).toBeTruthy();
  shown.rerender(
    createElement(PlayContextUsage, {
      ...shown.props,
      chain: { ...chain, latestCompletedResponse: { id: 3 } },
    }),
  );
  expect(screen.getByText("上下文 —").title).toContain("Provider 未报告");
});
