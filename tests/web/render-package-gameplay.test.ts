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
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Gameplay } from "../../src/protocol/gameplay.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { App } from "../../src/web/App.tsx";
import { PackageGameplaySection } from "../../src/web/PackageGameplaySection.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

describe("内容包 Gameplay 区块", () => {
  test("互动式小说只读显示玩法，没有判定方案控件", () => {
    render(
      createElement(PackageGameplaySection, {
        gameplay: { mode: "interactive-fiction" },
        disabled: false,
        onChangeScheme: vi.fn(),
      }),
    );

    const section = screen.getByRole("region", { name: "玩法" });
    expect(within(section).getByText("互动式小说")).toBeTruthy();
    expect(
      within(section).getByText(
        /玩法模式在创建时固定，不能在互动式小说与跑团之间切换/u,
      ),
    ).toBeTruthy();
    expect(
      within(section).queryByRole("group", { name: "判定方案" }),
    ).toBeNull();
    expect(within(section).queryByRole("radio")).toBeNull();
  });

  test("跑团显示当前方案，改选会提交新方案，点选当前方案不提交", () => {
    const onChangeScheme = vi.fn(() => Promise.resolve());
    render(
      createElement(PackageGameplaySection, {
        gameplay: { mode: "tabletop", scheme: "d100" },
        disabled: false,
        onChangeScheme,
      }),
    );

    const section = screen.getByRole("region", { name: "玩法" });
    expect(within(section).getByText("跑团 · d100")).toBeTruthy();
    expect(
      within(section).getByText(/已有世界保持创建时的判定方案/u),
    ).toBeTruthy();
    const d100 = within(section).getByRole("radio", { name: "d100" });
    expect((d100 as HTMLInputElement).checked).toBe(true);
    fireEvent.click(d100);
    expect(onChangeScheme).not.toHaveBeenCalled();

    fireEvent.click(within(section).getByRole("radio", { name: "d20" }));
    expect(onChangeScheme).toHaveBeenCalledWith("d20");
  });

  test("锁定时方案控件整体禁用，提交期间也不能重复改选", async () => {
    let finish: () => void = () => undefined;
    const onChangeScheme = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(
      createElement(PackageGameplaySection, {
        gameplay: { mode: "tabletop", scheme: "d100" },
        disabled: true,
        onChangeScheme,
      }),
    );
    const section = screen.getByRole("region", { name: "玩法" });
    expect(
      within(section).getByRole("radio", { name: "d20" }).closest("fieldset")
        ?.disabled,
    ).toBe(true);
    fireEvent.click(within(section).getByRole("radio", { name: "d20" }));
    expect(onChangeScheme).not.toHaveBeenCalled();

    rerender(
      createElement(PackageGameplaySection, {
        gameplay: { mode: "tabletop", scheme: "d100" },
        disabled: false,
        onChangeScheme,
      }),
    );
    fireEvent.click(within(section).getByRole("radio", { name: "d20" }));
    expect(
      within(section).getByRole("radio", { name: "d20" }).closest("fieldset")
        ?.disabled,
    ).toBe(true);
    fireEvent.click(within(section).getByRole("radio", { name: "混乱袋" }));
    expect(onChangeScheme).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() =>
      expect(
        within(section).getByRole("radio", { name: "d20" }).closest("fieldset")
          ?.disabled,
      ).toBe(false),
    );
  });

  test("在内容包页改判定方案后刷新玩法标签，失败则在通知区显示错误", async () => {
    let gameplay: Gameplay = { mode: "tabletop", scheme: "d100" };
    let schemeFailure: string | null = null;
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: [packageSummary(gameplay)],
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
      if (input.type === "content.read") return packageDetail(gameplay);
      if (input.type === "setting-improvement.overview")
        return { latest: null, history: [] };
      if (input.type === "content.scripts.read")
        return { entries: [], enabled: false };
      if (input.type === "content.gameplay.set") {
        if (schemeFailure !== null) throw new Error(schemeFailure);
        gameplay = { mode: "tabletop", scheme: input.scheme };
        return packageDetail(gameplay);
      }
      throw new Error(`unexpected request: ${input.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(screen.getByRole("button", { name: "打开内容包：跑团包" }));
    await screen.findByRole("heading", { name: "跑团包 · AI 设定完善" });
    const section = await screen.findByRole("region", { name: "玩法" });
    await waitFor(() =>
      expect(within(section).getByText("跑团 · d100")).toBeTruthy(),
    );

    fireEvent.click(within(section).getByRole("radio", { name: "混乱袋" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: "content.gameplay.set",
        packageId: "package-tabletop",
        scheme: "bag",
      }),
    );
    await waitFor(() =>
      expect(within(section).getByText("跑团 · 混乱袋")).toBeTruthy(),
    );
    expect(
      screen.getByText("判定方案已保存；已有世界保持原方案。"),
    ).toBeTruthy();

    schemeFailure = "玩法模式固定，不能切换";
    fireEvent.click(within(section).getByRole("radio", { name: "d20" }));
    await waitFor(() =>
      expect(screen.getByText("玩法模式固定，不能切换")).toBeTruthy(),
    );
    expect(within(section).getByText("跑团 · 混乱袋")).toBeTruthy();
  });

  test("互动式小说内容包没有判定方案控件，也不会请求方案修改", async () => {
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: [packageSummary({ mode: "interactive-fiction" })],
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
      if (input.type === "content.read")
        return packageDetail({ mode: "interactive-fiction" });
      if (input.type === "setting-improvement.overview")
        return { latest: null, history: [] };
      if (input.type === "content.scripts.read")
        return { entries: [], enabled: false };
      throw new Error(`unexpected request: ${input.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(screen.getByRole("button", { name: "打开内容包：跑团包" }));
    await screen.findByRole("heading", { name: "跑团包 · AI 设定完善" });
    const section = await screen.findByRole("region", { name: "玩法" });
    expect(within(section).getByText("互动式小说")).toBeTruthy();
    expect(within(section).queryByRole("radio")).toBeNull();
    expect(
      request.mock.calls.some(
        ([input]) => input.type === "content.gameplay.set",
      ),
    ).toBe(false);
  });
});

function packageSummary(gameplay: Gameplay) {
  return {
    localId: "package-tabletop",
    title: "跑团包",
    status: "usable" as const,
    gameplay,
  };
}

function packageDetail(gameplay: Gameplay) {
  const files = [
    { path: "opening.md", contents: "开场" },
    ...(gameplay.mode === "tabletop"
      ? [
          {
            path: "control/gameplay.json",
            contents: `${JSON.stringify(
              {
                format: "narraeon.gameplay/v1",
                mode: "tabletop",
                scheme: gameplay.scheme,
              },
              null,
              2,
            )}\n`,
          },
        ]
      : []),
  ];
  return { ...packageSummary(gameplay), files, issues: [] };
}

describe("判定方案保存期间的文件草稿", () => {
  test("保存期间编辑入口关闭，已打开的编辑器也不能开始草稿，结束后恢复", async () => {
    let gameplay: Gameplay = { mode: "tabletop", scheme: "d100" };
    let finishSave: () => void = () => undefined;
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: [packageSummary(gameplay)],
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
      if (input.type === "content.read") return packageDetail(gameplay);
      if (input.type === "setting-improvement.overview")
        return { latest: null, history: [] };
      if (input.type === "content.scripts.read")
        return { entries: [], enabled: false };
      if (input.type === "content.gameplay.set")
        return new Promise((resolve) => {
          finishSave = () => {
            gameplay = { mode: "tabletop", scheme: input.scheme };
            resolve(packageDetail(gameplay));
          };
        });
      throw new Error(`unexpected request: ${input.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(screen.getByRole("button", { name: "打开内容包：跑团包" }));
    await screen.findByRole("heading", { name: "跑团包 · AI 设定完善" });
    const section = await screen.findByRole("region", { name: "玩法" });
    const tools = screen.getByRole("navigation", { name: "设定完善工具" });
    const editTool = within(tools).getByRole("button", { name: "编辑" });
    expect(editTool.matches(":disabled")).toBe(false);
    fireEvent.click(editTool);
    const editor = await screen.findByLabelText("编辑 opening.md");
    expect(editor.closest("fieldset")?.matches(":disabled")).toBe(false);

    fireEvent.click(within(section).getByRole("radio", { name: "混乱袋" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: "content.gameplay.set",
        packageId: "package-tabletop",
        scheme: "bag",
      }),
    );
    expect(
      within(tools).getByRole("button", { name: "编辑" }).matches(":disabled"),
    ).toBe(true);
    expect(editor.closest("fieldset")?.matches(":disabled")).toBe(true);
    fireEvent.change(editor, { target: { value: "草稿不应开始" } });
    expect(screen.queryByText("有未保存修改")).toBeNull();
    expect(screen.queryByText("草稿尚未保存")).toBeNull();

    finishSave();
    await waitFor(() =>
      expect(within(section).getByText("跑团 · 混乱袋")).toBeTruthy(),
    );
    expect(
      within(tools).getByRole("button", { name: "编辑" }).matches(":disabled"),
    ).toBe(false);
    expect(screen.queryByText("有未保存修改")).toBeNull();
    expect(
      screen.getByText("判定方案已保存；已有世界保持原方案。"),
    ).toBeTruthy();
  });
});
