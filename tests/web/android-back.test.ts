// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  handleAndroidBack,
  useAndroidBack,
} from "../../src/web/androidBridge.ts";
import { CreateContentPackageDialog } from "../../src/web/CreateContentPackageDialog.tsx";
import { WorkspaceHeader } from "../../src/web/WorkspaceHeader.tsx";

beforeAll(() => {
  // jsdom has no modal dialog support; the dialog only needs the open state.
  const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
  if (typeof proto.showModal !== "function")
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  if (typeof proto.close !== "function")
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
});

afterEach(() => cleanup());

function Overlay({
  active,
  onBack,
}: {
  active: boolean;
  onBack: () => boolean | void;
}): null {
  useAndroidBack(active, onBack);
  return null;
}

describe("Android 返回键", () => {
  test("没有打开的浮层时不处理，交给页面历史", () => {
    expect(handleAndroidBack()).toBe(false);
    expect(
      (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack,
    ).toBe(handleAndroidBack);
  });

  test("先交给最近打开的浮层；返回 false 的浮层让给下面一层", () => {
    const below = vi.fn();
    const above = vi.fn(() => false);
    const { rerender } = render(
      createElement(
        "div",
        null,
        createElement(Overlay, { active: true, onBack: below }),
        createElement(Overlay, { active: false, onBack: above }),
      ),
    );
    rerender(
      createElement(
        "div",
        null,
        createElement(Overlay, { active: true, onBack: below }),
        createElement(Overlay, { active: true, onBack: above }),
      ),
    );

    expect(handleAndroidBack()).toBe(true);
    expect(above).toHaveBeenCalledOnce();
    expect(below).toHaveBeenCalledOnce();

    cleanup();
    expect(handleAndroidBack()).toBe(false);
  });

  test("新建内容包对话框：返回键取消；创建进行中时保持打开但仍吞掉返回键", () => {
    const onCancel = vi.fn();
    const props = { onCancel, onCreate: () => Promise.resolve() };
    const { rerender } = render(
      createElement(CreateContentPackageDialog, { ...props, pending: true }),
    );

    expect(handleAndroidBack()).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();

    rerender(
      createElement(CreateContentPackageDialog, { ...props, pending: false }),
    );
    expect(handleAndroidBack()).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("页头导航菜单：返回键收起菜单，收起后交还页面历史", () => {
    render(
      createElement(WorkspaceHeader, {
        screen: "home",
        locale: "zh-CN",
        localeSaving: false,
        navigationLocked: false,
        activeModelName: null,
        onNavigate: vi.fn(),
        onLocaleChange: vi.fn(),
      }),
    );
    const toggle = screen.getByRole("button", { name: "切换页面" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    let handled = false;
    act(() => {
      handled = handleAndroidBack();
    });
    expect(handled).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(handleAndroidBack()).toBe(false);
  });
});
