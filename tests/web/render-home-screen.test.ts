// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { V1Request } from "../../src/protocol/v1.ts";
import { App } from "../../src/web/App.tsx";
import { HomeScreen } from "../../src/web/HomeScreen.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";
import { relativeActivityTime } from "../../src/web/worldActivityPresentation.ts";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(cleanup);

describe("世界工作区主页", () => {
  test("直接展示世界与内容包，保留明确的进入与管理操作", () => {
    const onOpenWorld = vi.fn();
    const onOpenPackage = vi.fn();
    const onImportPackage = vi.fn();
    const onCreateSamplePackage = vi.fn();
    const importArchive = new File(["zip fixture"], "雾港来信.zip", {
      type: "application/zip",
    });

    render(
      createElement(HomeScreen, {
        contentPackages: [
          {
            localId: "package-ready",
            title: "雾港来信",
            status: "usable" as const,
            gameplay: { mode: "interactive-fiction" },
          },
          {
            localId: "package-repair",
            title: "旧塔草稿",
            status: "needs_repair" as const,
            gameplay: { mode: "interactive-fiction" },
          },
        ],
        worlds: [
          {
            worldId: "world-1",
            title: "雾港第一夜",
            gameplay: { mode: "interactive-fiction" },
            lastActivityAt: Date.now(),
            excerpt: "船长把灯挂在舱门前。",
            playerTurns: 6,
          },
        ],
        selectedPackageId: "package-ready",
        modelConfigured: true,
        activeModelName: "本地主持模型",
        currentPresetName: "克制叙事",
        importArchive,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onCreateWorld: vi.fn(),
        onCreatePackage: vi.fn(),
        onCreateSamplePackage,
        onConfigureModel: vi.fn(),
        onImportPackage,
        onOpenPackage,
        onRenamePackage: vi.fn(),
        onDeletePackage: vi.fn(),
        onOpenWorld,
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(screen.getByRole("heading", { name: "继续游玩" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "创作工作台" })).toBeNull();
    expect(screen.getByRole("button", { name: "新建世界" })).toBeTruthy();
    expect(screen.getByText(/1 份待修复/u)).toBeTruthy();
    expect(screen.getByText(/本地主持模型/u)).toBeTruthy();
    expect(screen.getByText("刚刚")).toBeTruthy();
    expect(screen.getByText("6 回合")).toBeTruthy();
    expect(screen.getByText("船长把灯挂在舱门前。")).toBeTruthy();
    expect(
      document.querySelector("time")?.getAttribute("datetime"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "打开世界：雾港第一夜" }),
    );
    expect(onOpenWorld).toHaveBeenCalledWith("world-1");

    fireEvent.click(
      screen.getByRole("button", { name: "打开内容包：旧塔草稿" }),
    );
    expect(onOpenPackage).toHaveBeenCalledWith("package-repair");

    expect(screen.getByText(/雾港来信\.zip/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入 ZIP" }));
    expect(onImportPackage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "从示例开始" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "从示例新建" }));
    expect(onCreateSamplePackage).toHaveBeenCalledOnce();
  });

  test("为空工作区说明起步路径并阻止未选择 ZIP 时导入", () => {
    const onImportArchiveChange = vi.fn();
    const onCreateSamplePackage = vi.fn();
    const onConfigureModel = vi.fn();
    render(
      createElement(HomeScreen, {
        contentPackages: [],
        worlds: [],
        selectedPackageId: "",
        modelConfigured: false,
        activeModelName: null,
        currentPresetName: null,
        importArchive: null,
        importPending: false,
        onImportArchiveChange,
        onCreateWorld: vi.fn(),
        onCreatePackage: vi.fn(),
        onCreateSamplePackage,
        onConfigureModel,
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
        onRenamePackage: vi.fn(),
        onDeletePackage: vi.fn(),
        onOpenWorld: vi.fn(),
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(screen.getByText("还没有正在游玩的世界")).toBeTruthy();
    expect(screen.getByText("从一组人类可读文件开始")).toBeTruthy();
    expect(screen.getAllByText(/尚未配置/u).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "从示例开始" }));
    expect(onCreateSamplePackage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "配置模型连接" }));
    expect(onConfigureModel).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "导入 ZIP" }).hasAttribute("disabled"),
    ).toBe(true);

    const archive = new File(["zip fixture"], "新世界.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("内容包 ZIP 文件"), {
      target: { files: [archive] },
    });
    expect(onImportArchiveChange).toHaveBeenCalledWith(archive);
  });

  test("在世界卡片上修改名称而不打开或删除世界", () => {
    const onRenameWorld = vi.fn();
    const onOpenWorld = vi.fn();
    const onDeleteWorld = vi.fn();
    render(
      createElement(HomeScreen, {
        contentPackages: [],
        worlds: [
          {
            worldId: "world-1",
            title: "雾港第一夜",
            gameplay: { mode: "interactive-fiction" },
            lastActivityAt: null,
            excerpt: null,
            playerTurns: 0,
          },
        ],
        selectedPackageId: "",
        modelConfigured: true,
        activeModelName: "本地主持模型",
        currentPresetName: "克制叙事",
        importArchive: null,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onCreateWorld: vi.fn(),
        onCreatePackage: vi.fn(),
        onCreateSamplePackage: vi.fn(),
        onConfigureModel: vi.fn(),
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
        onRenamePackage: vi.fn(),
        onDeletePackage: vi.fn(),
        onOpenWorld,
        onRenameWorld,
        onDeleteWorld,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "重命名世界：雾港第一夜" }),
    );
    fireEvent.change(screen.getByLabelText("世界名称"), {
      target: { value: "  雾港第二夜  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存世界名称" }));

    expect(onRenameWorld).toHaveBeenCalledWith(
      {
        worldId: "world-1",
        title: "雾港第一夜",
        gameplay: { mode: "interactive-fiction" },
        lastActivityAt: null,
        excerpt: null,
        playerTurns: 0,
      },
      "雾港第二夜",
    );
    expect(onOpenWorld).not.toHaveBeenCalled();
    expect(onDeleteWorld).not.toHaveBeenCalled();
  });

  test("相对活动时间使用界面语言，未来时间显示刚刚", () => {
    const now = 1_790_000_000_000;
    setWebLocale("zh-CN");
    expect(relativeActivityTime(now - 3 * 60 * 60 * 1000, now)).toBe("3小时前");
    expect(relativeActivityTime(now + 1000, now)).toBe("刚刚");
    setWebLocale("en");
    expect(relativeActivityTime(now - 3 * 60 * 60 * 1000, now)).toBe(
      "3 hours ago",
    );
    expect(relativeActivityTime(now - 60 * 1000, now)).toBe("1 minute ago");
    expect(relativeActivityTime(now, now)).toBe("Just now");
    setWebLocale("zh-CN");
  });

  test("应用把世界卡片提交的新名称保存到 Runtime 并刷新工作区", async () => {
    let worldTitle = "雾港第一夜";
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      const resolvedInput = await Promise.resolve(input);
      if (resolvedInput.type === "world.rename") {
        worldTitle = resolvedInput.name;
        return {
          worldId: resolvedInput.worldId,
          title: resolvedInput.name,
          parentEndpoint: "genesis",
        };
      }
      if (resolvedInput.type === "workspace.read")
        return {
          preferences: { locale: "zh-CN" },
          contentPackages: [],
          playPresets: { currentPresetId: "", presets: [] },
          worlds: [
            {
              worldId: "world-1",
              title: worldTitle,
              gameplay: { mode: "interactive-fiction" },
            },
          ],
          storageNotices: [],
          model: {
            configured: false,
            activeConnectionId: null,
            connections: [],
            presets: [],
          },
        };
      if (resolvedInput.type === "world.read")
        return {
          worldId: resolvedInput.worldId,
          head: "genesis",
          state: [],
          control: [],
          history: [],
          runtime: { type: "file_native_genesis" },
          playerViews: { views: [], diagnostics: [] },
          artifacts: [],
          extensions: [],
          committedMessages: [],
          playCallChain: null,
        };
      if (resolvedInput.type === "artifacts.debug") return [];
      throw new Error(`unexpected request: ${resolvedInput.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    render(createElement(App, { client }));

    await screen.findByRole("button", { name: "打开世界：雾港第一夜" });
    fireEvent.click(
      screen.getByRole("button", { name: "重命名世界：雾港第一夜" }),
    );
    fireEvent.change(screen.getByLabelText("世界名称"), {
      target: { value: "雾港第二夜" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存世界名称" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: "world.rename",
        worldId: "world-1",
        name: "雾港第二夜",
      }),
    );
    await screen.findByRole("button", { name: "打开世界：雾港第二夜" });

    fireEvent.click(
      screen.getByRole("button", { name: "打开世界：雾港第二夜" }),
    );
    await screen.findByRole("heading", { name: "雾港第二夜" });
    fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
    fireEvent.change(screen.getByLabelText("世界显示名称"), {
      target: { value: "雾港第三夜" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await screen.findByRole("heading", { name: "雾港第三夜" });
  });

  test("主页按条目身份改名和删除内容包，取消删除不写入 Runtime", async () => {
    let packages = [
      {
        localId: "package-first",
        title: "第一份",
        status: "usable",
        gameplay: { mode: "interactive-fiction" },
      },
      {
        localId: "package-target",
        title: "待改名",
        status: "needs_repair",
        gameplay: { mode: "interactive-fiction" },
      },
    ];
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "content.rename") {
        packages = packages.map((item) =>
          item.localId === input.packageId
            ? { ...item, title: input.name }
            : item,
        );
        return {};
      }
      if (input.type === "content.delete") {
        packages = packages.filter((item) => item.localId !== input.packageId);
        return {};
      }
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
      throw new Error(`unexpected request: ${input.type}`);
    });
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    try {
      render(
        createElement(App, { client: { request } as unknown as RuntimeClient }),
      );
      await screen.findByRole("button", { name: "打开内容包：待改名" });
      fireEvent.click(
        screen.getByRole("button", { name: "重命名内容包：待改名" }),
      );
      const save = screen.getByRole("button", { name: "保存内容包标题" });
      expect(save.hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText("内容包标题"), {
        target: { value: "  新标题  " },
      });
      fireEvent.click(save);
      await screen.findByRole("button", { name: "打开内容包：新标题" });
      expect(request).toHaveBeenCalledWith({
        type: "content.rename",
        packageId: "package-target",
        name: "新标题",
      });
      fireEvent.click(
        screen.getByRole("button", { name: "删除内容包：新标题" }),
      );
      expect(request).not.toHaveBeenCalledWith({
        type: "content.delete",
        packageId: "package-target",
      });
      confirm.mockReturnValue(true);
      fireEvent.click(
        screen.getByRole("button", { name: "删除内容包：新标题" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "打开内容包：新标题" }),
        ).toBeNull(),
      );
      expect(request).toHaveBeenCalledWith({
        type: "content.delete",
        packageId: "package-target",
      });
      expect(
        screen.getByRole("button", { name: "打开内容包：第一份" }),
      ).toBeTruthy();
      expect(
        request.mock.calls.some(([input]) => input.type === "content.read"),
      ).toBe(false);
    } finally {
      confirm.mockRestore();
    }
  });

  test("应用保存界面语言并在重新加载后继续使用", async () => {
    let locale: "en" | "zh-CN" = "en";
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      const resolvedInput = await Promise.resolve(input);
      if (resolvedInput.type === "preferences.save") {
        locale = resolvedInput.locale ?? locale;
        return { locale };
      }
      if (resolvedInput.type === "workspace.read")
        return {
          preferences: { locale },
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
      throw new Error(`unexpected request: ${resolvedInput.type}`);
    });
    const client = { request } as unknown as RuntimeClient;
    const first = render(createElement(App, { client }));

    await screen.findByRole("heading", { name: "World workspace" });
    fireEvent.change(screen.getByLabelText("Interface language"), {
      target: { value: "zh-CN" },
    });
    await screen.findByRole("heading", { name: "世界工作区" });
    expect(request).toHaveBeenCalledWith({
      type: "preferences.save",
      locale: "zh-CN",
    });

    first.unmount();
    render(createElement(App, { client }));
    await screen.findByRole("heading", { name: "世界工作区" });
    expect(screen.getByLabelText<HTMLSelectElement>("界面语言").value).toBe(
      "zh-CN",
    );
  });
  test("待升级的世界只显示待升级，不显示回合数", () => {
    render(
      createElement(HomeScreen, {
        contentPackages: [],
        worlds: [
          {
            worldId: "world-old",
            title: "旧世界",
            gameplay: { mode: "interactive-fiction" },
            lastActivityAt: null,
            excerpt: null,
            playerTurns: 0,
            pendingUpgrade: true,
          },
        ],
        selectedPackageId: "",
        modelConfigured: true,
        activeModelName: "本地主持模型",
        currentPresetName: "克制叙事",
        importArchive: null,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onCreateWorld: vi.fn(),
        onCreatePackage: vi.fn(),
        onCreateSamplePackage: vi.fn(),
        onConfigureModel: vi.fn(),
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
        onRenamePackage: vi.fn(),
        onDeletePackage: vi.fn(),
        onOpenWorld: vi.fn(),
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(screen.getByText("待升级")).toBeTruthy();
    expect(screen.queryByText("0 回合")).toBeNull();
    expect(screen.queryByText("活动时间未记录")).toBeNull();
  });
});
