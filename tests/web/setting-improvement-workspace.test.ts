// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import { SettingImprovementPanel } from "../../src/web/SettingImprovementPanel.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("每轮调用先折叠成窄条，再逐层展开，并可一次全部收起", () => {
  renderPanel();

  const turnTrace = screen.getByText("本段调用详情").closest("details")!;
  const exchange = screen.getByText("第 1 次模型交换").closest("details")!;
  const reasoning = screen
    .getByText("Provider 返回推理（不等同隐藏思维链）")
    .closest("details")!;
  const tool = screen.getByText("调用 setting_write_file").closest("details")!;
  const diff = document.querySelector<HTMLDetailsElement>(
    ".setting-change-diff",
  )!;

  expect(turnTrace.open).toBe(false);
  expect(exchange.open).toBe(false);
  expect(reasoning.open).toBe(false);
  expect(tool.open).toBe(false);
  expect(diff.open).toBe(false);

  fireEvent.click(screen.getByText("本段调用详情"));
  fireEvent.click(screen.getByText("第 1 次模型交换"));
  fireEvent.click(screen.getByText("Provider 返回推理（不等同隐藏思维链）"));
  fireEvent.click(screen.getByText("调用 setting_write_file"));
  fireEvent.click(diff.querySelector("summary")!);
  expect(
    [turnTrace, exchange, reasoning, tool, diff].every(({ open }) => open),
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
  expect(
    [turnTrace, exchange, reasoning, tool, diff].every(({ open }) => !open),
  ).toBe(true);
});

test("左右侧栏承载历史删除、文件预览和同一份文件编辑器", async () => {
  const onDeleteSession = vi.fn(() => Promise.resolve());
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  renderPanel(onDeleteSession);

  const historyRail = document.querySelector(
    'aside[aria-label="设定完善对话历史"]',
  )!;
  expect(historyRail.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "历史" }));
  expect(historyRail.getAttribute("aria-hidden")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "删除对话：修改开场" }));
  await waitFor(() =>
    expect(onDeleteSession).toHaveBeenCalledWith("setting-test"),
  );

  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(
    screen
      .getByRole("complementary", {
        name: "内容包文件预览",
      })
      .getAttribute("aria-hidden"),
  ).toBe("false");
  expect(screen.getByText("Opening preview text")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "编辑这份文件" }));
  expect(
    screen.getByRole("complementary", {
      name: "内容包文件编辑",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "内容包当前树" })).toBeTruthy();
  expect(screen.getByLabelText("编辑 opening.md")).toBeTruthy();
});

function renderPanel(
  onDeleteSession: (sessionId: string) => Promise<void> = () =>
    Promise.resolve(),
): void {
  render(
    createElement(SettingImprovementPanel, {
      packageName: "Test package",
      modelConfigured: true,
      hasUnsavedFileDraft: false,
      loading: false,
      view: {
        sessionId: "setting-test",
        packageId: "package-test",
        runStatus: "ready",
        messages: [],
        turns: [
          {
            id: "turn-1",
            user: {
              id: "user-1",
              role: "user",
              text: "修改开场",
              createdAt: 1,
            },
            exchanges: [
              {
                id: "exchange-1",
                exchange: 1,
                text: "",
                reasoning: "先检查开场。",
                toolCalls: [
                  {
                    callId: "write-opening",
                    name: "setting_write_file",
                    arguments: { path: "opening.md" },
                    result: {
                      markdown: "Write accepted",
                      isError: false,
                      changes: [
                        {
                          path: "opening.md",
                          kind: "modify",
                          before: "Old opening",
                          after: "New opening",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
        legacyDraft: null,
        usage: emptyAggregatedModelUsage(),
        progress: {
          exchange: 1,
          toolCalls: 1,
          streaming: null,
          updatedAt: 2,
        },
        lastFailure: null,
      },
      history: [
        {
          sessionId: "setting-test",
          runStatus: "ready",
          createdAt: 1,
          updatedAt: 2,
          excerpt: "修改开场",
          turnCount: 1,
          exchangeCount: 1,
          toolCallCount: 1,
          changedFileCount: 1,
        },
      ],
      latestSessionId: "setting-test",
      notice: "",
      requestFailure: null,
      now: 2,
      contentEditor: {
        files: [{ path: "opening.md", contents: "Opening preview text" }],
        status: "usable",
        issues: [],
        dirty: false,
        onFilesChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        onCopy: () => undefined,
        onExport: () => undefined,
        onDelete: () => undefined,
        title: "Test package",
        onRename: () => undefined,
      },
      onSend: () => Promise.resolve(),
      onCancel: () => Promise.resolve(),
      onFreshContext: () => undefined,
      onSelectSession: () => Promise.resolve(),
      onDeleteSession,
      onConfigureModel: () => undefined,
      onBack: () => undefined,
    }),
  );
}
