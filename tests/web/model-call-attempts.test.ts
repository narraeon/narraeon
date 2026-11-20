// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  V1PlayTimelineItem,
  V1PlayTimelineEventSummary,
  V1Request,
} from "../../src/protocol/v1.ts";
import { PlayTurnCallDetails } from "../../src/web/PlayTurnCallDetails.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});
function item(
  event: V1PlayTimelineEventSummary,
  chainId = "chain",
): Extract<V1PlayTimelineItem, { kind: "event" }> {
  return { kind: "event", chainId, current: true, event };
}
function assistant(
  id: number,
  overrides: Partial<
    Extract<V1PlayTimelineEventSummary, { kind: "assistant" }>
  > = {},
): Extract<V1PlayTimelineEventSummary, { kind: "assistant" }> {
  return {
    id,
    kind: "assistant",
    text: "",
    exchange: id,
    attempt: id,
    status: "interrupted",
    hasReasoning: false,
    hasToolFragment: false,
    hasUsage: false,
    detailsAvailable: false,
    ...overrides,
  };
}
async function open(element: HTMLDetailsElement) {
  await act(async () => {
    element.open = true;
    fireEvent(element, new Event("toggle"));
    await Promise.resolve();
  });
}

test.each([false, true])(
  "play retries replace default card across exchange changes, lazy history and exact context (%s explicit link)",
  async (explicit) => {
    const request = vi.fn((input: V1Request) =>
      Promise.resolve({
        status: "available",
        messages: [
          {
            role: "system",
            text: `context-${"eventId" in input ? input.eventId : "unknown"}`,
          },
        ],
      }),
    );
    const first = assistant(1, { attempt: 1 });
    const second = assistant(3, {
      attempt: 2,
      ...(explicit ? { retryOf: 1 } : {}),
    });
    const third = assistant(5, {
      attempt: 3,
      status: "streaming",
      ...(explicit ? { retryOf: 3 } : {}),
    });
    const frames = [
      item(first),
      item({ id: 2, kind: "failure", message: "first failure" }),
      item(second),
      item({ id: 4, kind: "cancellation", message: "stopped" }),
    ];
    const props = { worldId: "world", liveChain: null, request };
    const view = render(
      createElement(PlayTurnCallDetails, { ...props, items: frames }),
    );
    expect(view.container.querySelectorAll(".model-call")).toHaveLength(1);
    expect(view.container.querySelector(".model-call")?.textContent).toContain(
      "已取消",
    );
    view.rerender(
      createElement(PlayTurnCallDetails, {
        ...props,
        items: [...frames, item(third)],
      }),
    );
    expect(view.container.querySelectorAll(".model-call")).toHaveLength(1);
    expect(view.container.querySelector(".model-call")?.textContent).toContain(
      "正在接收",
    );
    expect(request).not.toHaveBeenCalled();
    await open(
      view.container.querySelector<HTMLDetailsElement>(
        ".model-call-attempt-history",
      )!,
    );
    expect(
      view.container.querySelectorAll(".model-call-attempt-list .model-call"),
    ).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    const oldContext = view.container.querySelector<HTMLDetailsElement>(
      ".model-call-attempt-list .technical-details",
    )!;
    await open(oldContext);
    expect(request).toHaveBeenCalledWith({
      type: "play.timeline.context",
      worldId: "world",
      chainId: "chain",
      eventId: 1,
    });
    third.status = "completed";
    third.responseKind = "narrative";
    third.text = "Recovered";
    cleanup();
    setWebLocale("en");
    const refreshed = render(
      createElement(PlayTurnCallDetails, {
        ...props,
        items: [...frames, item(third)],
      }),
    );
    expect(refreshed.container.querySelectorAll(".model-call")).toHaveLength(1);
    expect(refreshed.container.textContent).toContain("1 model steps");
    expect(refreshed.container.textContent).toContain("Previous attempts");
    expect(refreshed.container.textContent).not.toMatch(
      /Call \d|Retry of call/u,
    );
  },
);

test("completed tool steps, normal replies, sends, contexts and named followups stay separate", () => {
  const frames = [
    item(
      assistant(1, {
        attempt: 1,
        status: "completed",
        responseKind: "tool_step",
      }),
    ),
    item(
      assistant(2, {
        attempt: 1,
        status: "completed",
        responseKind: "narrative",
      }),
    ),
    item({
      id: 3,
      kind: "player",
      exchangeId: "new-send",
      context: "append",
      text: "New send",
    }),
    item(assistant(4, { attempt: 2 })),
    item(assistant(5, { attempt: 2 }), "other-chain"),
    item({
      id: 6,
      kind: "followup",
      followupId: "status",
      displayName: "Status panel",
      toolCallCount: 0,
      failed: false,
      detailsAvailable: true,
    }),
  ];
  const view = render(
    createElement(PlayTurnCallDetails, {
      items: frames,
      worldId: "world",
      liveChain: null,
      request: () => Promise.resolve({}),
    }),
  );
  expect(view.container.querySelectorAll(".model-call")).toHaveLength(5);
  expect(
    view.container.querySelector(".model-call-attempt-history"),
  ).toBeNull();
  expect(view.container.textContent).toContain("Status panel");
});
