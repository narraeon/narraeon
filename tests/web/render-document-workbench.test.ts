// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { gameplayFile } from "../../src/protocol/gameplay.ts";
import type { ContentTreeFile } from "../../src/protocol/v1.ts";
import { DocumentWorkbench } from "../../src/web/DocumentWorkbench.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

const gameplay = gameplayFile({ mode: "tabletop", scheme: "d20" });
const files: ContentTreeFile[] = [
  { path: "opening.md", contents: "# 开场\n" },
  gameplay,
];

describe("文档工作区与玩法文件", () => {
  test("内容包中的 control/gameplay.json 可以打开和编辑，不显示 JSON 不支持的提示", () => {
    const onFilesChange = vi.fn();
    render(
      createElement(DocumentWorkbench, {
        workspace: {
          kind: "content-package",
          files,
          dirty: false,
          issues: [],
          onFilesChange,
          onSave: vi.fn(),
        },
        selectedPath: gameplay.path,
      }),
    );

    expect(screen.queryByRole("alert")).toBeNull();
    const editor = screen.getByLabelText("编辑 control/gameplay.json");
    expect((editor as HTMLTextAreaElement).readOnly).toBe(false);
    expect(
      screen.getByText("内容包玩法身份，只能修改跑团判定方案"),
    ).toBeTruthy();
    fireEvent.change(editor, { target: { value: `${gameplay.contents} ` } });
    expect(onFilesChange).toHaveBeenCalled();
  });

  test("新建 control/gameplay.json 的路径仍会被当作草稿路径检查，其他 JSON 继续被拒绝", () => {
    render(
      createElement(DocumentWorkbench, {
        workspace: {
          kind: "content-package",
          files: [{ path: "opening.md", contents: "" }],
          dirty: false,
          issues: [],
          onFilesChange: vi.fn(),
          onSave: vi.fn(),
        },
      }),
    );
    fireEvent.click(screen.getByText("新建文件"));
    const input = screen.getByLabelText("新文件路径");

    fireEvent.change(input, { target: { value: "control/gameplay.json" } });
    expect(screen.queryByText(/不接受 manifest/u)).toBeNull();

    fireEvent.change(input, { target: { value: "control/other.json" } });
    expect(screen.getByRole("alert").textContent).toContain(
      "不接受 manifest 或 JSON",
    );
  });

  test("世界修订中的玩法文件只读，并且不显示 JSON 或修订路径的误导提示", () => {
    render(
      createElement(DocumentWorkbench, {
        workspace: {
          kind: "world-revision",
          files: [
            { path: "state/current-situation.yaml", contents: "x: 1\n" },
            gameplay,
          ],
          dirty: false,
          pending: false,
          issues: [],
          immutablePaths: [],
          onFilesChange: vi.fn(),
          onSave: vi.fn(),
        },
        selectedPath: gameplay.path,
      }),
    );

    const editor = screen.getByLabelText(
      "编辑 control/gameplay.json",
    ) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText("世界玩法身份，修订中保持不变")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
