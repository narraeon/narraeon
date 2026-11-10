// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { PlayRequestContext } from "../../src/protocol/playRequestContext.ts";
import { PlayRequestContextDetails } from "../../src/web/PlayRequestContextDetails.tsx";

afterEach(cleanup);

test("context is fetched only on expansion, retries errors and ignores an old world's late response", async () => {
  let finish!: (value: PlayRequestContext) => void;
  const first = new Promise<PlayRequestContext>((resolve) => {
    finish = resolve;
  });
  const load = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockRejectedValueOnce(new Error("failed"))
    .mockResolvedValue({
      status: "available",
      messages: [{ role: "user", text: "new-context" }],
    });
  const props = { load, worldId: "first-world", chainId: "chain", eventId: 2 };
  const view = render(createElement(PlayRequestContextDetails, props));
  expect(load).not.toHaveBeenCalled();
  toggle(view.container, true);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(load).toHaveBeenLastCalledWith({
    type: "play.timeline.context",
    worldId: "first-world",
    chainId: "chain",
    eventId: 2,
  });
  view.rerender(
    createElement(PlayRequestContextDetails, {
      ...props,
      worldId: "second-world",
    }),
  );
  await act(async () => {
    finish({
      status: "available",
      messages: [{ role: "user", text: "stale-context" }],
    });
    await first;
  });
  expect(screen.queryByText("stale-context")).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  toggle(view.container, true);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("new-context");
  expect(load).toHaveBeenCalledTimes(3);
  toggle(view.container, false);
  toggle(view.container, true);
  expect(load).toHaveBeenCalledTimes(3);
});

function toggle(container: HTMLElement, open: boolean): void {
  const details = container.querySelector("details")!;
  details.open = open;
  fireEvent(details, new Event("toggle"));
}
