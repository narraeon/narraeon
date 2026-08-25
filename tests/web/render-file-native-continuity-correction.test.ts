// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";

import { FileNativeCorrectionPanel } from "../../src/web/FileNativeCorrectionPanel.tsx";

describe("文件原生连续性修正界面", () => {
  test("应用前显示父端点、完整前后内容、hash、清单和真实 Prompt Preview", () => {
    const apply = vi.fn();
    const cancel = vi.fn();
    render(
      createElement(FileNativeCorrectionPanel, {
        preview: {
          parentHead: "commit:7",
          candidateVersion: 3,
          diffs: [
            {
              documentId: "character.qinlong",
              path: "characters/qinlong.yaml",
              beforeHash: "sha256:before",
              afterHash: "sha256:after",
              before: "衣着: 白色背心",
              after: "衣着: 蓝色训练外套",
            },
          ],
          materials: {
            before: [],
            after: [{ kind: "document", document: "character.qinlong" }],
          },
          nextPromptMarkdown: "# 下一次真实请求\n\n当前情境",
        },
        onApply: apply,
        onCancel: cancel,
      }),
    );

    expect(screen.getByText("commit:7")).toBeTruthy();
    expect(screen.getByText("衣着: 白色背心")).toBeTruthy();
    expect(screen.getByText("衣着: 蓝色训练外套")).toBeTruthy();
    expect(screen.getByText(/sha256:before/u)).toBeTruthy();
    expect(screen.getByText(/下一次真实请求/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "应用这笔修正" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修正草稿" }));
    expect(apply).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
