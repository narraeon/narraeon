// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { gameplayFile } from "../../src/protocol/gameplay.ts";
import type { ContentTreeFile } from "../../src/protocol/v1.ts";
import { DocumentWorkbench } from "../../src/web/DocumentWorkbench.tsx";
import { useAuthoringFileView } from "../../src/web/authoring-file-list.ts";
import { setWebLocale } from "../../src/web/i18n.ts";

function WorkbenchHarness({
  workspace,
  selectedPath,
}: Pick<ComponentProps<typeof DocumentWorkbench>, "workspace"> & {
  selectedPath?: string;
}): React.JSX.Element {
  const fileView = useAuthoringFileView(
    workspace.files,
    workspace.kind,
    selectedPath,
  );
  return createElement(DocumentWorkbench, { workspace, fileView });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setWebLocale("zh-CN");
});

const gameplay = gameplayFile({ mode: "tabletop", scheme: "d20" });
const files: ContentTreeFile[] = [
  { path: "opening.md", contents: "# 开场\n" },
  gameplay,
];

test.each([
  {
    locale: "en",
    path: "world/rules/１２ Harbor.md",
    existingPath: "world/places/old.yaml",
    existingContents: "weather: [unfinished",
    ref: "doc-12-harbor",
    newPathLabel: "New file path",
    createLabel: "Create file",
    addLabel: "Add to draft",
    summary: "Summarize this document in one sentence.",
    title: "１２ Harbor",
  },
  {
    locale: "zh-CN",
    path: "state/places/港口.yml",
    existingPath: "state/rules/old.md",
    existingContents: "A draft with no heading.",
    ref: "document",
    newPathLabel: "新文件路径",
    createLabel: "新建文件",
    addLabel: "加入草稿",
    summary: "用一句话概括这份文档。",
    title: "港口",
  },
] as const)(
  "seeds $path with localized editable metadata and reserves identifiers from an unfinished file",
  ({
    locale,
    path,
    existingPath,
    existingContents,
    ref,
    newPathLabel,
    createLabel,
    addLabel,
    summary,
    title,
  }) => {
    setWebLocale(locale);
    const duplicateId = "doc.11111111111141118111111111111111";
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const header = `$document: { id: ${duplicateId}, ref: ${ref}, title: Old }\n`;
    const existing = {
      path: existingPath,
      contents: existingPath.endsWith(".md")
        ? `---\n${header}---\n\n${existingContents}`
        : header + existingContents,
    };
    const onFilesChange = vi.fn<(files: ContentTreeFile[]) => void>();
    render(
      createElement(WorkbenchHarness, {
        workspace: {
          kind: path.startsWith("state/")
            ? "world-revision"
            : "content-package",
          files: [existing],
          dirty: false,
          locked: true,
          pending: false,
          issues: [],
          onFilesChange,
          onSave: vi.fn(),
        },
      }),
    );
    fireEvent.click(screen.getByText(createLabel));
    fireEvent.change(screen.getByLabelText(newPathLabel), {
      target: { value: path },
    });
    fireEvent.click(screen.getByRole("button", { name: addLabel }));

    expect(onFilesChange).toHaveBeenCalledTimes(1);
    const [original, added] = onFilesChange.mock.calls[0]![0];
    expect(original).toEqual(existing);
    const metadata = `$document:\n  id: doc.22222222222242228222222222222222\n  ref: ${ref}-2\n  title: ${title}\n  summary: ${summary}\n  aliases: []\n`;
    expect(added).toEqual({
      path,
      contents: path.endsWith(".md")
        ? `---\n${metadata}---\n\n# ${title}\n\n`
        : `${metadata}\n`,
    });
  },
);

test("opening an existing empty world document leaves it empty", () => {
  const path = "world/rules/empty.md";
  const onFilesChange = vi.fn();
  render(
    createElement(WorkbenchHarness, {
      workspace: {
        kind: "content-package",
        files: [{ path, contents: "" }],
        dirty: false,
        issues: [],
        onFilesChange,
        onSave: vi.fn(),
      },
    }),
  );

  const source = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: `编辑 ${path}`,
  });
  expect(source.value).toBe("");
  expect(source.placeholder).toBe("输入 UTF-8 文本内容……");
  expect(onFilesChange).not.toHaveBeenCalled();
});

describe("文档工作区与编排方案文件", () => {
  test("内容包中的 control/gameplay.json 可以打开和编辑，不显示 JSON 不支持的提示", () => {
    const onFilesChange = vi.fn();
    render(
      createElement(WorkbenchHarness, {
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
    expect(editor.getAttribute("readonly")).toBeNull();
    expect(
      screen.getByText("内容包玩法身份，只能修改跑团判定方案"),
    ).toBeTruthy();
    fireEvent.change(editor, { target: { value: `${gameplay.contents} ` } });
    expect(onFilesChange).toHaveBeenCalled();
  });

  test("新建 control/gameplay.json 的路径仍会被当作草稿路径检查，其他 JSON 继续被拒绝", () => {
    render(
      createElement(WorkbenchHarness, {
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

  test("世界修订中的编排方案文件只读，并且不显示 JSON 或修订路径的误导提示", () => {
    render(
      createElement(WorkbenchHarness, {
        workspace: {
          kind: "world-revision",
          files: [
            { path: "state/current-situation.yaml", contents: "x: 1\n" },
            gameplay,
          ],
          dirty: false,
          locked: true,
          pending: false,
          issues: [],
          onFilesChange: vi.fn(),
          onSave: vi.fn(),
        },
        selectedPath: gameplay.path,
      }),
    );

    const editor = screen.getByLabelText("编辑 control/gameplay.json");
    expect(editor.getAttribute("readonly")).not.toBeNull();
    expect(screen.getByText("世界玩法身份，修订中保持不变")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
