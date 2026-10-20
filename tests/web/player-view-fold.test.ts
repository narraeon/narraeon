// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { BuiltinPlayerViewPanel } from "../../src/web/BuiltinPlayerViewPanel.tsx";
import {
  PlayerViewFoldProvider,
  usePlayerViewFoldController,
} from "../../src/web/PlayerViewFoldState.ts";

afterEach(() => cleanup());

const payload = JSON.stringify({
  viewId: "status",
  title: "当前状态",
  config: { groups: [] },
  items: [
    { id: "mood", label: "心情", value: "平静" },
    {
      id: "gear",
      label: "装备",
      value: {
        武器: { 名称: "短剑", 耐久: 8 },
        背包: ["绳索", { name: "地图", 备注: "旧" }],
      },
    },
    { id: "empty", label: "空", value: {} },
  ],
});

function Harness(): React.JSX.Element {
  const controller = usePlayerViewFoldController();
  return createElement(
    PlayerViewFoldProvider,
    { value: controller.fold },
    createElement("button", { onClick: controller.expandAll }, "all-open"),
    createElement("button", { onClick: controller.collapseAll }, "all-closed"),
    createElement(BuiltinPlayerViewPanel, { content: payload }),
  );
}

function expanded(name: string): string | null {
  return screen
    .getByRole("button", { name: new RegExp(`^${name}`, "u") })
    .getAttribute("aria-expanded");
}

describe("player view folds", () => {
  test("view and items start open; nested containers start collapsed", () => {
    render(createElement(Harness));
    expect(expanded("当前状态")).toBe("true");
    expect(expanded("装备")).toBe("true");
    expect(expanded("武器")).toBe("false");
    expect(expanded("背包")).toBe("false");
    expect(screen.getByText("平静")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^心情/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^空/u })).toBeNull();
    expect(screen.getByText("短剑").closest("[hidden]")).not.toBeNull();
  });

  test("toggling reveals nested values and list entries use their names", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: /^武器/u }));
    expect(expanded("武器")).toBe("true");
    expect(screen.getByText("短剑").closest("[hidden]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^背包/u }));
    expect(screen.getByRole("button", { name: /^地图/u })).toBeTruthy();
  });

  test("collapsing the view hides its items and expand-all opens everything", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: /^当前状态/u }));
    expect(screen.getByText("平静").closest("[hidden]")).not.toBeNull();
    fireEvent.click(screen.getByText("all-open"));
    expect(expanded("武器")).toBe("true");
    expect(expanded("当前状态")).toBe("true");
    fireEvent.click(screen.getByText("all-closed"));
    expect(expanded("当前状态")).toBe("false");
  });

  test("fold state survives a content update with the same ids", () => {
    const { rerender } = render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: /^武器/u }));
    act(() => {
      rerender(createElement(Harness));
    });
    expect(expanded("武器")).toBe("true");
  });
});
