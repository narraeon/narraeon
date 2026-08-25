// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { SettingImprovementPanel } from "../../src/web/SettingImprovementPanel.tsx";

afterEach(cleanup);

const plan = {
  kind: "plan" as const,
  markdown: "# 创作计划\n\n补充人物关系与开局钩子。",
};

test("计划阶段可以写意见让 AI 重出计划，不必放弃重来", () => {
  const onRevisePlan = vi.fn();
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "planned" as const,
      plan,
      onRevisePlan,
    }),
  );

  const box = screen.getByLabelText("让 AI 调整计划");
  fireEvent.change(box, { target: { value: "  改成聚焦社团线。  " } });
  fireEvent.click(screen.getByRole("button", { name: "按意见重出计划" }));

  // 前后空白被去掉，会话继续而不是重开。
  expect(onRevisePlan).toHaveBeenCalledWith("改成聚焦社团线。");
});

test("候选阶段可以写意见让 AI 接着改", () => {
  const onReviseCandidate = vi.fn();
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "ready" as const,
      plan,
      candidate: candidate(),
      onReviseCandidate,
    }),
  );

  fireEvent.change(screen.getByLabelText("让 AI 继续改这份候选"), {
    target: { value: "秦龙的动机再具体一点。" },
  });
  fireEvent.click(screen.getByRole("button", { name: "按意见继续修改" }));

  expect(onReviseCandidate).toHaveBeenCalledWith("秦龙的动机再具体一点。");
});

test("意见为空时提交按钮不可用", () => {
  const onRevisePlan = vi.fn();
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "planned" as const,
      plan,
      onRevisePlan,
    }),
  );

  const submit = screen.getByRole("button", { name: "按意见重出计划" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("让 AI 调整计划"), {
    target: { value: "   " },
  });
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(onRevisePlan).not.toHaveBeenCalled();
});

function candidate() {
  return {
    kind: "candidate" as const,
    review: {
      status: "usable" as const,
      diff: [
        {
          path: "world/characters/qinlong.yaml",
          kind: "modify" as const,
          before: "关系: {}\n",
          after: "关系:\n  启铭: 熟悉\n",
        },
      ],
      diagnostics: [],
      preview: {
        diagnosticBinding: {
          endpoint: "candidate",
          commit: "candidate",
          hostPresetId: "host",
          controlFingerprint: "candidate",
          modelId: "test",
        },
        compilation: {
          logicalMessages: [],
          provider: {},
          tools: [],
          coverage: [],
          budget: {
            estimator: "conservative_utf8_bytes" as const,
            messageTokens: 1,
            toolTokens: 1,
            outputReserveTokens: 1,
            forcedTailReserveTokens: 0,
            safetyMarginTokens: 1,
            requiredTokens: 4,
            contextWindowTokens: 32_000,
            status: "fits" as const,
          },
          cache: {
            stablePrefixFingerprint: "sha256:0",
            breakpoints: [],
            estimatedCacheableTokens: 0,
            firstDynamicByte: 0,
          },
        },
        leakage: { status: "clean" as const, checkedFields: [] },
      },
    },
  };
}

function common() {
  return {
    packageName: "宿舍世界",
    packageStatus: "usable" as const,
    modelConfigured: true,
    currentFiles: [],
    hasUnsavedFileDraft: false,
    contextPaths: [],
    contextLocked: true,
    goal: "补足人物关系",
    plan: null,
    candidate: null,
    progress: null,
    progressNow: 0,
    onGoalChange: vi.fn(),
    onContextPathsChange: vi.fn(),
    onStart: vi.fn(),
    onConfirm: vi.fn(),
    onRevisePlan: vi.fn(),
    onReviseCandidate: vi.fn(),
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    onConfigureModel: vi.fn(),
  };
}
