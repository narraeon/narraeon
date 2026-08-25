// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ContentTreeEditor,
  type ContentTreeIssue,
} from "../../src/web/ContentTreeEditor.tsx";
import type { ContentTreeFile } from "../../src/protocol/v1.ts";

afterEach(cleanup);

describe("内容包手动编辑界面", () => {
  test("按职责整理文件并逐份编辑、重命名、新建和移除草稿", () => {
    const onSave = vi.fn();
    render(
      createElement(EditorHarness, {
        initialFiles: files(),
        issues: [],
        onSave,
      }),
    );

    expect(
      screen.getByRole("complementary", { name: "内容包文件" }),
    ).toBeTruthy();
    expect(screen.getByText("开场")).toBeTruthy();
    const fileTree = screen.getByRole("navigation", { name: "内容包文件树" });
    expect(within(fileTree).getByText("世界内容")).toBeTruthy();
    expect(within(fileTree).getByText("控制")).toBeTruthy();
    expect(screen.getByLabelText("内容包文件统计").textContent).toContain("3");

    fireEvent.click(
      screen.getByRole("button", { name: "打开 control/frame.yaml" }),
    );
    expect(screen.getByRole("heading", { name: "世界提示框架" })).toBeTruthy();
    expect(screen.queryByLabelText("编辑 control/frame.yaml")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "打开 world/current-situation.yaml",
      }),
    );
    const editor = screen.getByLabelText("编辑 world/current-situation.yaml");
    fireEvent.change(editor, { target: { value: "地点: 球场\n" } });
    expect((editor as HTMLTextAreaElement).value).toBe("地点: 球场\n");
    expect(screen.getByText("有未保存修改")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("文件路径"), {
      target: { value: "world/situation/current.yaml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用新路径" }));
    expect(
      screen.getByRole("button", {
        name: "打开 world/situation/current.yaml",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("新建文件", { exact: true }));
    fireEvent.change(screen.getByLabelText("新文件路径"), {
      target: { value: "world/characters/qinlong.yaml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
    expect(
      screen.getByLabelText("编辑 world/characters/qinlong.yaml"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "从草稿移除" }));
    expect(
      screen.queryByRole("button", {
        name: "打开 world/characters/qinlong.yaml",
      }),
    ).toBeNull();

    fireEvent.keyDown(
      screen.getByLabelText("编辑 world/situation/current.yaml"),
      {
        key: "s",
        ctrlKey: true,
      },
    );
    expect(onSave).toHaveBeenCalledOnce();
  });

  test("显示已保存诊断，并保留二进制资源而不展开正文", () => {
    const issues: ContentTreeIssue[] = [
      {
        code: "missing_current_situation",
        path: "control/frame.yaml",
        message: "世界框架必须绑定一份存在的当前情境文档",
      },
    ];
    render(
      createElement(EditorHarness, {
        initialFiles: [
          ...files(),
          { path: "assets/map.png", contents: "AA==", encoding: "base64" },
        ],
        issues,
        onSave: vi.fn(),
      }),
    );

    expect(screen.getByText("已保存版本有 1 项需要修复")).toBeTruthy();
    expect(
      screen.getByText("世界框架必须绑定一份存在的当前情境文档"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "打开 assets/map.png" }),
    );
    expect(screen.getByText("二进制资源不在文本编辑器展开")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "编辑 assets/map.png" }),
    ).toBeNull();
  });
});

function EditorHarness({
  initialFiles,
  issues,
  onSave,
}: {
  initialFiles: ContentTreeFile[];
  issues: ContentTreeIssue[];
  onSave: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialFiles);
  const [dirty, setDirty] = useState(false);
  return createElement(ContentTreeEditor, {
    files: draft,
    status: issues.length === 0 ? "usable" : "needs_repair",
    issues,
    dirty,
    displayName: "测试内容包",
    onRename: vi.fn(),
    onFilesChange: (nextFiles) => {
      setDraft(nextFiles);
      setDirty(true);
    },
    onSave,
    onReset: vi.fn(),
    onCopy: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  });
}

function files(): ContentTreeFile[] {
  return [
    { path: "opening.md", contents: "雨落在球场边。\n" },
    {
      path: "world/current-situation.yaml",
      contents: "地点: 宿舍\n",
    },
    {
      path: "control/frame.yaml",
      contents: "format: narraeon.world-frame/v1\n",
    },
  ];
}
