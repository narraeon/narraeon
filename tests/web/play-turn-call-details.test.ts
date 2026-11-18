// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { V1PlayTimelineItem, V1Request } from "../../src/protocol/v1.ts";
import { PlayTurnCallDetails } from "../../src/web/PlayTurnCallDetails.tsx";

afterEach(cleanup);

test("an incomplete page keeps tool receipts without pairing call IDs across contexts", async () => {
  const items = [
    {
      kind: "event",
      chainId: "first-context",
      current: false,
      event: {
        id: 7,
        kind: "tool_call",
        callId: "reused",
        name: "earlier_tool",
        replayed: false,
        detailsAvailable: true,
      },
    },
    {
      kind: "event",
      chainId: "later-context",
      current: true,
      event: {
        id: 7,
        kind: "tool_result",
        callId: "reused",
        name: "later_tool",
        replayed: false,
        ok: true,
        detailsAvailable: true,
      },
    },
  ] satisfies V1PlayTimelineItem[];
  const request = vi.fn((input: V1Request): Promise<unknown> => {
    if (
      input.type === "play.timeline.detail" &&
      input.chainId === "later-context"
    )
      return Promise.resolve({
        ...items[1]!.event,
        markdown: "Only the later receipt.",
      });
    return Promise.reject(new Error("Selected the wrong context"));
  });

  render(
    createElement(PlayTurnCallDetails, {
      items,
      worldId: "world",
      liveChain: null,
      request,
    }),
  );
  const trace = screen.getByText("本段调用详情").closest("details")!;
  expect(within(trace).getByText("仅保留部分调用记录")).toBeTruthy();
  expect(within(trace).queryByRole("heading", { name: /次调用/u })).toBeNull();
  expect(
    within(trace).getByText("调用 earlier_tool").closest("summary")
      ?.textContent,
  ).toContain("等待 Runtime 结果");
  const receipt = within(trace)
    .getByText("调用 later_tool")
    .closest("details")!;
  receipt.open = true;
  fireEvent(receipt, new Event("toggle"));
  expect(
    await within(receipt).findByText("Only the later receipt."),
  ).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({
    type: "play.timeline.detail",
    worldId: "world",
    chainId: "later-context",
    eventId: 7,
  });
});

test("a failure before dispatch stays in the technical history without creating a call", () => {
  const items = [
    {
      kind: "event",
      chainId: "context",
      current: true,
      event: {
        kind: "failure",
        id: 3,
        message: "The frozen request was unavailable.",
      },
    },
  ] satisfies V1PlayTimelineItem[];
  render(
    createElement(PlayTurnCallDetails, {
      items,
      worldId: "world",
      liveChain: null,
      request: vi.fn(),
    }),
  );
  const trace = screen.getByText("本段调用详情").closest("details")!;
  expect(within(trace).getByText("仅保留部分调用记录")).toBeTruthy();
  expect(within(trace).getByText("历史调用错误")).toBeTruthy();
  expect(
    within(trace).getByText("The frozen request was unavailable."),
  ).toBeTruthy();
  expect(within(trace).queryByRole("heading", { name: /次调用/u })).toBeNull();
});
