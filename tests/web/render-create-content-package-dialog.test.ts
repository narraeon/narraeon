// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { Gameplay } from "../../src/protocol/gameplay.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { App } from "../../src/web/App.tsx";
import { CreateContentPackageDialog } from "../../src/web/CreateContentPackageDialog.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";
import { setWebLocale } from "../../src/web/i18n.ts";

beforeAll(() => {
  // jsdom has no modal dialog support; the component only needs the open state.
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

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

function renderDialog(
  overrides: Partial<{
    pending: boolean;
    onCancel: () => void;
    onCreate: (gameplay: Gameplay) => Promise<void>;
  }> = {},
) {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onCreate = overrides.onCreate ?? vi.fn(() => Promise.resolve());
  render(
    createElement(CreateContentPackageDialog, {
      pending: overrides.pending ?? false,
      onCancel,
      onCreate,
    }),
  );
  return { onCancel, onCreate };
}

describe("新建内容包对话框", () => {
  test("默认互动式小说，不显示判定方案；选择跑团后同一对话框出现 d100 默认方案", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "新建内容包" });
    expect(
      within(dialog).getByRole("radio", { name: "互动式小说" }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("radio", {
          name: "互动式小说",
        })
        .matches(":checked"),
    ).toBe(true);
    expect(
      within(dialog).queryByRole("group", { name: "判定方案" }),
    ).toBeNull();

    fireEvent.click(within(dialog).getByRole("radio", { name: "跑团" }));

    const scheme = within(dialog).getByRole("group", { name: "判定方案" });
    expect(
      within(scheme).getByRole("radio", { name: "d100" }).matches(":checked"),
    ).toBe(true);
    expect(
      within(scheme).getByRole("radio", { name: "d20" }).matches(":checked"),
    ).toBe(false);
    expect(within(scheme).getByRole("radio", { name: "混乱袋" })).toBeTruthy();
    const describedBy = scheme
      .querySelector('input[value="d100"]')
      ?.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
      "默认方案",
    );
    expect(within(dialog).getByText(/默认方案。掷一颗个位骰/u)).toBeTruthy();
    expect(within(dialog).getByText(/掷一颗 d20 加修正/u)).toBeTruthy();
    expect(within(dialog).getByText(/从混乱袋抽一枚标记/u)).toBeTruthy();
  });

  test("提交跑团时把所选判定方案交给创建流程，取消不创建", () => {
    const { onCreate } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建内容包" });

    fireEvent.click(within(dialog).getByRole("radio", { name: "跑团" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "混乱袋" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    expect(onCreate).toHaveBeenCalledWith({ mode: "tabletop", scheme: "bag" });
  });

  test("互动式小说提交时不带判定方案", () => {
    const { onCreate } = renderDialog();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "新建内容包" })).getByRole(
        "button",
        { name: "创建" },
      ),
    );
    expect(onCreate).toHaveBeenCalledWith({ mode: "interactive-fiction" });
  });

  test("Esc 与取消关闭对话框，但创建进行中时两者都不生效", () => {
    const { onCancel } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建内容包" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(2);

    cleanup();
    const pending = renderDialog({ pending: true });
    const pendingDialog = screen.getByRole("dialog", { name: "新建内容包" });
    fireEvent(pendingDialog, new Event("cancel", { cancelable: true }));
    expect(pending.onCancel).not.toHaveBeenCalled();
    expect(
      within(pendingDialog)
        .getByRole("button", {
          name: "取消",
        })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      within(pendingDialog)
        .getByRole("button", {
          name: "创建",
        })
        .matches(":disabled"),
    ).toBe(true);
    const tabletopRadio = within(pendingDialog).getByRole("radio", {
      name: "跑团",
    });
    expect(tabletopRadio.closest("fieldset")?.disabled).toBe(true);
  });

  test("创建失败时在对话框内显示 Runtime 的错误并保留选择", async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error("磁盘已满")));
    renderDialog({ onCreate });
    const dialog = screen.getByRole("dialog", { name: "新建内容包" });

    fireEvent.click(within(dialog).getByRole("radio", { name: "跑团" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "d20" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "磁盘已满",
    );
    expect(
      within(dialog).getByRole("radio", { name: "d20" }).matches(":checked"),
    ).toBe(true);
  });

  test("英文界面使用英文标题、方案说明和按钮", () => {
    setWebLocale("en");
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "New content package" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Tabletop" }));

    expect(
      within(dialog).getByRole("group", { name: "Resolution scheme" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Default\. Roll one units die/u),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("radio", { name: "Chaos bag" }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("主页入口打开新建内容包对话框", () => {
  test("两个创建入口都先打开对话框，选择跑团 d20 后才调用 content.create 并打开新内容包", async () => {
    let packages: {
      localId: string;
      title: string;
      status: "usable";
      gameplay: Gameplay;
    }[] = [];
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: packages,
          playPresets: { currentPresetId: "", presets: [] },
          worlds: [],
          storageNotices: [],
          model: {
            configured: false,
            activeConnectionId: null,
            connections: [],
            presets: [],
          },
        };
      if (input.type === "content.create") {
        const created = {
          localId: "package-tabletop",
          title: "新内容包",
          status: "usable" as const,
          gameplay: input.gameplay ?? { mode: "interactive-fiction" as const },
        };
        packages = [created];
        return created;
      }
      if (input.type === "content.read")
        return {
          ...packages[0],
          files: [
            { path: "opening.md", contents: "开场" },
            {
              path: "control/gameplay.json",
              contents:
                '{\n  "format": "narraeon.gameplay/v1",\n  "mode": "tabletop",\n  "scheme": "d20"\n}\n',
            },
          ],
          issues: [],
        };
      if (input.type === "setting-improvement.overview")
        return { latest: null, history: [] };
      if (input.type === "content.scripts.read")
        return { entries: [], enabled: false };
      throw new Error(`unexpected request: ${input.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(screen.getByRole("button", { name: "新建内容包" }));
    const dialog = screen.getByRole("dialog", { name: "新建内容包" });
    expect(
      request.mock.calls.some(([input]) => input.type === "content.create"),
    ).toBe(false);

    fireEvent.click(within(dialog).getByRole("radio", { name: "跑团" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "d20" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await screen.findByRole("heading", { name: "新内容包 · AI 设定完善" });
    expect(screen.queryByRole("dialog", { name: "新建内容包" })).toBeNull();
    expect(request).toHaveBeenCalledWith({
      type: "content.create",
      gameplay: { mode: "tabletop", scheme: "d20" },
    });
  });

  test("没有选中内容包时进入内容页也打开对话框而不是直接创建", async () => {
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: [],
          playPresets: { currentPresetId: "", presets: [] },
          worlds: [],
          storageNotices: [],
          model: {
            configured: false,
            activeConnectionId: null,
            connections: [],
            presets: [],
          },
        };
      throw new Error(`unexpected request: ${input.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
        "button",
        { name: "内容编辑" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "新建内容包" })).toBeTruthy(),
    );
    expect(
      request.mock.calls.some(([input]) => input.type === "content.create"),
    ).toBe(false);
  });
});
