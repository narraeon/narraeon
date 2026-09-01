import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type { V1SettingPromptPreview } from "../../src/protocol/v1.ts";
import {
  SettingImprovementPanel,
  type SettingImprovementView,
} from "../../src/web/SettingImprovementPanel.tsx";

test("设定完善首屏就是普通对话输入，不再提供计划／生成分支", () => {
  const html = renderToStaticMarkup(
    createElement(SettingImprovementPanel, {
      packageName: "雨夜码头",
      modelConfigured: true,
      hasUnsavedFileDraft: false,
      loading: false,
      view: null,
      requestFailure: null,
      now: Date.now(),
      onSend: () => Promise.resolve(),
      onCancel: () => Promise.resolve(),
      onApply: () => Promise.resolve(),
      onDiscard: () => Promise.resolve(),
      onConfigureModel: () => undefined,
    }),
  );

  expect(html).toContain("直接说你现在想做什么");
  expect(html).toContain("先帮我梳理一下人物关系");
  expect(html).toContain(">发送<");
  expect(html).not.toContain("生成候选");
  expect(html).not.toContain("确认计划");
  expect(html).not.toContain("跳过计划");
});

test("运行中显示停止回复，完整草稿显示精确版本 Apply 和自动检查", () => {
  const running = render(view({ runStatus: "running", canApply: false }));
  expect(running).toContain("AI 正在处理");
  expect(running).toContain("停止回复");

  const ready = render(
    view({
      runStatus: "ready",
      canApply: true,
      draftVersion: 3,
      review: {
        status: "usable",
        diagnostics: [],
        preview: promptPreview,
        diff: [
          {
            path: "opening.md",
            kind: "modify",
            before: "Old opening",
            after: "New opening",
          },
        ],
      },
    }),
  );
  expect(ready).toContain("版本 3");
  expect(ready).toContain("已通过");
  expect(ready).toContain("opening.md");
  expect(ready).toContain("应用当前草稿");
  expect(ready).toContain("讨论本身不会修改当前树");
  expect(ready).toContain("真实提示词预览");
  expect(ready).toContain("查看最终 Provider 请求结构");
});

function render(value: SettingImprovementView): string {
  return renderToStaticMarkup(
    createElement(SettingImprovementPanel, {
      packageName: "Test",
      modelConfigured: true,
      hasUnsavedFileDraft: false,
      loading: false,
      view: value,
      requestFailure: null,
      now: Date.now(),
      onSend: () => Promise.resolve(),
      onCancel: () => Promise.resolve(),
      onApply: () => Promise.resolve(),
      onDiscard: () => Promise.resolve(),
      onConfigureModel: () => undefined,
    }),
  );
}

function view(
  overrides: Partial<SettingImprovementView> = {},
): SettingImprovementView {
  return {
    sessionId: "setting-test",
    packageId: "package-test",
    lifecycle: "open",
    runStatus: "ready",
    baseStatus: "current",
    draftVersion: 0,
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "先讨论",
        createdAt: 1,
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "可以。",
        createdAt: 2,
      },
    ],
    review: { status: "usable", diff: [], diagnostics: [], preview: null },
    usage: emptyAggregatedModelUsage(),
    progress: {
      exchange: 2,
      toolCalls: 1,
      streaming: {
        reasoningChars: 10,
        textChars: 5,
        toolChars: 3,
        tail: "正在检查",
        receivedAt: Date.now(),
      },
      updatedAt: Date.now(),
    },
    lastFailure: null,
    canApply: false,
    ...overrides,
  };
}

const promptPreview: V1SettingPromptPreview = {
  diagnosticBinding: {
    endpoint: "setting-draft",
    commit: "draft",
    hostPresetId: "setting-draft",
    controlFingerprint: "control:test",
    modelId: "model:test",
  },
  compilation: {
    logicalMessages: [
      {
        role: "runtime_system",
        markdown: "# Runtime contract",
        blocks: [
          {
            source: "runtime:builtin/setting-improvement",
            markdown: "Contract",
          },
        ],
      },
    ],
    provider: { protocol: "chat_completions", messages: [] },
    tools: [
      {
        name: "setting_read",
        description: "Read",
        inputSchema: { type: "object" },
      },
    ],
    coverage: [],
    budget: {
      estimator: "disabled",
      messageTokens: 0,
      toolTokens: 0,
      outputReserveTokens: 4096,
      forcedTailReserveTokens: 0,
      safetyMarginTokens: 0,
      requiredTokens: 0,
      contextWindowTokens: 32_000,
      status: "not_checked",
    },
    cache: {
      strategy: "provider_managed",
      stablePrefixFingerprint: "cache:test",
      breakpoints: [],
      estimatedCacheableBytes: 0,
      firstDynamicByte: 0,
    },
  },
  leakage: { status: "clean", checkedFields: [] },
};
