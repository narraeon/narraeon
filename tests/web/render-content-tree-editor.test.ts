// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ContentTreeEditor,
  type ContentTreeIssue,
} from "../../src/web/ContentTreeEditor.tsx";
import type { ContentTreeFile } from "../../src/protocol/v1.ts";

import { setWebLocale } from "../../src/web/i18n.ts";
import { PackageScriptPermissionControl } from "../../src/web/PackageScriptPermissionControl.tsx";

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
    fireEvent.click(screen.getByText("内容包操作"));
    expect(screen.getByLabelText<HTMLInputElement>("内容包标题").value).toBe(
      "测试内容包",
    );

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
      target: { value: "world/characters/alex.yaml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
    expect(
      screen.getByLabelText("编辑 world/characters/alex.yaml"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "从草稿移除" }));
    expect(
      screen.queryByRole("button", {
        name: "打开 world/characters/alex.yaml",
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
    title: "测试内容包",
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

test("普通作者从内容包入口编辑、停用和排序后置请求，完整资源留在草稿", () => {
  render(
    createElement(EditorHarness, {
      initialFiles: files(),
      issues: [],
      onSave: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "内容包后置请求" }));
  fireEvent.click(screen.getByRole("button", { name: "新增包后置请求" }));
  fireEvent.change(screen.getByLabelText("包请求名称"), {
    target: { value: "旅途回顾" },
  });
  fireEvent.change(screen.getByLabelText("包请求提示词"), {
    target: { value: "输出旅途回顾" },
  });
  fireEvent.click(screen.getByText("编辑渲染资源", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "添加 HTML 模板" }));
  fireEvent.change(screen.getByLabelText("HTML 模板 1"), {
    target: { value: "<h2>旅途</h2>" },
  });
  fireEvent.click(screen.getByLabelText("启用 旅途回顾"));
  expect(screen.getByLabelText<HTMLInputElement>("启用 旅途回顾").checked).toBe(
    false,
  );
  expect(screen.getByLabelText<HTMLTextAreaElement>("HTML 模板 1").value).toBe(
    "<h2>旅途</h2>",
  );
  fireEvent.click(screen.getByRole("button", { name: "新增包后置请求" }));
  expect(screen.getAllByRole("button", { name: /^上移/ })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: /^上移/ })[1]!);
  fireEvent.click(screen.getByRole("button", { name: "旅途回顾" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("包请求提示词").value).toBe(
    "输出旅途回顾",
  );
  expect(screen.getByLabelText<HTMLTextAreaElement>("HTML 模板 1").value).toBe(
    "<h2>旅途</h2>",
  );
});

test("English authors can edit package requests and explicitly grant and revoke script permission", async () => {
  setWebLocale("en");
  render(
    createElement(EditorHarness, {
      initialFiles: files(),
      issues: [],
      onSave: vi.fn(),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Content-package followups" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add package followup" }));
  expect(
    screen.getByLabelText<HTMLTextAreaElement>("Package request prompt").value,
  ).toBe("Use artifact_emit to emit output_1 based on the settled story.");
  expect(screen.getByRole("option", { name: "Story content" })).toBeTruthy();
  const client = {
    request: vi
      .fn()
      .mockResolvedValueOnce({ enabled: false })
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ enabled: false }),
  };
  render(
    createElement(PackageScriptPermissionControl, {
      client,
      kind: "content",
      id: "package_test",
    }),
  );
  const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "Allow package scripts",
  });
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  expect(screen.getByText(/Imports do not grant permission/)).toBeTruthy();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(client.request).toHaveBeenLastCalledWith({
    type: "content.scripts.set",
    packageId: "package_test",
    enabled: true,
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Revoke all package script permissions",
    }),
  );
  await waitFor(() => expect(checkbox.checked).toBe(false));
  expect(client.request).toHaveBeenLastCalledWith({
    type: "content.scripts.set",
    packageId: "package_test",
    enabled: false,
  });
});
