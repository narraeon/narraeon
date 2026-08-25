// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HomeScreen } from "../../src/web/HomeScreen.tsx";

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
});
