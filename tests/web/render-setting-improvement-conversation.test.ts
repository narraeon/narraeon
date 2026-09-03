import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type { V1SettingImprovementHistoryItem } from "../../src/protocol/v1.ts";
import {
  SettingImprovementPanel,
  type SettingImprovementView,
} from "../../src/web/SettingImprovementPanel.tsx";

test("首屏说明直接写当前树，并提供显式全新上下文而没有 Apply 或放弃", () => {
  const html = renderWith({ value: null, latestSessionId: null, history: [] });

  expect(html).toContain("直接说你现在想做什么");
  expect(html).toContain("全新上下文");
  expect(html).toContain("没有隔离草稿或应用步骤");
  expect(html).toContain(">发送<");
  expect(html).not.toContain("应用当前草稿");
  expect(html).not.toContain("放弃对话");
  expect(html).not.toContain("生成候选");
});

test("对话按模型交换展示 Provider 推理、工具收据和已生效红绿 diff", () => {
  const html = render(
    view({
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
              reasoning: "先检查开场白与当前情境。",
              toolCalls: [
                {
                  callId: "write-opening",
                  name: "setting_write_file",
                  arguments: { path: "opening.md" },
                  result: {
                    markdown: "# Current-tree write accepted",
                    isError: false,
                    changeSetId: "change-set:3",
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
            {
              id: "exchange-2",
              exchange: 2,
              text: "修改已经生效。",
              toolCalls: [],
            },
          ],
        },
      ],
    }),
  );

  expect(html).toContain("Provider 返回推理（不等同隐藏思维链）");
  expect(html).toContain("先检查开场白与当前情境");
  expect(html).toContain("setting_write_file");
  expect(html).toContain("当时生效 · 1 个文件");
  expect(html).toContain("当时已生效差异");
  expect(html).toContain("回滚这个文件");
  expect(html).toContain("unified-diff-remove");
  expect(html).toContain("unified-diff-add");
  expect(html).toContain("Old opening");
  expect(html).toContain("New opening");
  expect(html).toContain('role="columnheader">原文件行号');
  expect(html).toContain('aria-label="原文件第 1 行"');
  expect(html).toContain('aria-label="新文件第 1 行"');
});

test("任意历史对话都显示可继续，选择旧记录不会进入只读模式", () => {
  const historical = view({ sessionId: "setting-old" });
  const html = renderWith({
    value: historical,
    latestSessionId: "setting-latest",
    history: [
      historyItem({
        sessionId: "setting-latest",
        excerpt: "最近的对话",
      }),
      historyItem({ sessionId: "setting-old", excerpt: "雨夜码头" }),
    ],
  });

  expect(html).toContain("设定完善对话历史");
  expect(html).toContain("雨夜码头");
  expect(html).toContain("正在继续历史对话");
  expect(html).toContain("继续这段对话");
  expect(html).toContain(">发送<");
  expect(html).not.toContain("历史对话为只读回顾");
});

test("迁移前未应用隔离草稿只作为历史差异明确标注", () => {
  const html = render(
    view({
      legacyDraft: {
        outcome: "unapplied_dropped",
        changes: [
          {
            path: "opening.md",
            kind: "modify",
            before: "Live",
            after: "Old candidate",
          },
        ],
      },
    }),
  );
  expect(html).toContain("迁移前的隔离草稿记录（仅回顾）");
  expect(html).toContain("没有自动应用");
});

test("旧 Apply 收据无法确认时不把历史差异冒认为已生效", () => {
  const html = render(
    view({
      legacyDraft: {
        outcome: "apply_outcome_unknown",
        changes: [
          {
            path: "opening.md",
            kind: "modify",
            before: "Base",
            after: "Old Apply target",
          },
        ],
      },
    }),
  );

  expect(html).toContain("结果无法确认");
  expect(html).toContain("迁移前草稿差异（结果未知）");
  expect(html).not.toContain("迁移前已应用的差异");
});

function render(value: SettingImprovementView): string {
  return renderWith({ value, latestSessionId: value.sessionId, history: [] });
}

function renderWith({
  value,
  latestSessionId,
  history,
}: {
  value: SettingImprovementView | null;
  latestSessionId: string | null;
  history: V1SettingImprovementHistoryItem[];
}): string {
  return renderToStaticMarkup(
    createElement(SettingImprovementPanel, {
      packageName: "Test",
      modelConfigured: true,
      hasUnsavedFileDraft: false,
      loading: false,
      view: value,
      history,
      latestSessionId,
      notice: "",
      requestFailure: null,
      now: Date.now(),
      contentEditor: {
        files: [{ path: "opening.md", contents: "Opening" }],
        status: "usable",
        issues: [],
        dirty: false,
        onFilesChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        onCopy: () => undefined,
        onExport: () => undefined,
        onDelete: () => undefined,
        title: "Test",
        onRename: () => undefined,
      },
      onSend: () => Promise.resolve(),
      onCancel: () => Promise.resolve(),
      onFreshContext: () => undefined,
      onSelectSession: () => Promise.resolve(),
      onDeleteSession: () => Promise.resolve(),
      onRollbackFile: (_sessionId: string, changeSetId: string, path: string) =>
        Promise.resolve({
          status: "rolled_back" as const,
          changeSetId,
          path,
          changes: [],
        }),
      onConfigureModel: () => undefined,
      onBack: () => undefined,
    }),
  );
}

function view(
  overrides: Partial<SettingImprovementView> = {},
): SettingImprovementView {
  return {
    sessionId: "setting-test",
    packageId: "package-test",
    runStatus: "ready",
    messages: [
      { id: "user-1", role: "user", text: "先讨论", createdAt: 1 },
      { id: "assistant-1", role: "assistant", text: "可以。", createdAt: 2 },
    ],
    turns: [
      {
        id: "turn-1",
        user: {
          id: "user-1",
          role: "user",
          text: "先讨论",
          createdAt: 1,
        },
        exchanges: [
          { id: "exchange-1", exchange: 1, text: "可以。", toolCalls: [] },
        ],
      },
    ],
    legacyDraft: null,
    usage: emptyAggregatedModelUsage(),
    progress: {
      exchange: 1,
      toolCalls: 0,
      streaming: null,
      updatedAt: 2,
    },
    lastFailure: null,
    ...overrides,
  };
}

function historyItem(
  overrides: Partial<V1SettingImprovementHistoryItem> = {},
): V1SettingImprovementHistoryItem {
  return {
    sessionId: "setting-history",
    runStatus: "ready",
    createdAt: 1,
    updatedAt: 2,
    excerpt: "历史对话",
    turnCount: 1,
    exchangeCount: 2,
    toolCallCount: 1,
    changedFileCount: 1,
    ...overrides,
  };
}
