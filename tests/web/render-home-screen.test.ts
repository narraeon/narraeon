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
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(cleanup);

describe("世界工作区主页", () => {
  test("按游玩、创作任务和内容包整理已有工作区", () => {
    const onEditContent = vi.fn();
    const onOpenWorld = vi.fn();
    const onOpenPackage = vi.fn();
    const onImportPackage = vi.fn();
    const importArchive = new File(["zip fixture"], "雾港来信.zip", {
      type: "application/zip",
    });

    render(
      createElement(HomeScreen, {
        contentPackages: [
          {
            localId: "package-ready",
            displayName: "雾港来信",
            status: "usable" as const,
          },
          {
            localId: "package-repair",
            displayName: "旧塔草稿",
            status: "needs_repair" as const,
          },
        ],
        worlds: [{ worldId: "world-1", title: "雾港第一夜" }],
        selectedPackageId: "package-ready",
        modelConfigured: true,
        activeModelName: "本地主持模型",
        currentPresetName: "克制叙事",
        importArchive,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onEditContent,
        onCreateWorld: vi.fn(),
        onOpenPreview: vi.fn(),
        onCreatePackage: vi.fn(),
        onImportPackage,
        onOpenPackage,
        onOpenWorld,
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(screen.getByRole("heading", { name: "继续游玩" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "创作工作台" })).toBeTruthy();
    for (const name of ["内容编辑", "预设", "新建世界", "提示词预览"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByText("1 份 · 1 份待修复")).toBeTruthy();
    expect(screen.getByText("本地主持模型")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "内容编辑" }));
    expect(onEditContent).toHaveBeenCalledOnce();

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
  });

  test("为空工作区说明起步路径并阻止未选择 ZIP 时导入", () => {
    const onImportArchiveChange = vi.fn();
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
        onEditContent: vi.fn(),
        onCreateWorld: vi.fn(),
        onOpenPreview: vi.fn(),
        onCreatePackage: vi.fn(),
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
        onOpenWorld: vi.fn(),
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(screen.getByText("还没有正在游玩的世界")).toBeTruthy();
    expect(screen.getByText("从一组人类可读文件开始")).toBeTruthy();
    expect(screen.getAllByText("尚未配置").length).toBeGreaterThan(0);
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
        worlds: [{ worldId: "world-1", title: "雾港第一夜" }],
        selectedPackageId: "",
        modelConfigured: true,
        activeModelName: "本地主持模型",
        currentPresetName: "克制叙事",
        importArchive: null,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onEditContent: vi.fn(),
        onCreateWorld: vi.fn(),
        onOpenPreview: vi.fn(),
        onCreatePackage: vi.fn(),
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
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
      { worldId: "world-1", title: "雾港第一夜" },
      "雾港第二夜",
    );
    expect(onOpenWorld).not.toHaveBeenCalled();
    expect(onDeleteWorld).not.toHaveBeenCalled();
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
          worlds: [{ worldId: "world-1", title: worldTitle }],
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

  test("应用保存界面语言并在重新加载后继续使用", async () => {
    let locale: "en" | "zh-CN" = "en";
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      const resolvedInput = await Promise.resolve(input);
      if (resolvedInput.type === "preferences.save") {
        locale = resolvedInput.locale;
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
});
