// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SettingImprovementPanel,
  type SettingImprovementCandidateResult,
} from "../../src/web/SettingImprovementPanel.tsx";

const plan = {
  kind: "plan" as const,
  markdown:
    "# 创作计划\n\n## 主要体验\n让人物关系推动日常故事。\n\n## 明确排除项\n不预写未来剧情。",
};

afterEach(cleanup);

describe("AI 设定完善界面", () => {
  test("按目标、计划、候选三步展示单一下一步与完整审阅", () => {
    const onGoalChange = vi.fn();
    const onContextPathsChange = vi.fn();
    const onStart = vi.fn();
    const onConfirm = vi.fn();
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    const common = {
      packageName: "宿舍世界",
      packageStatus: "usable" as const,
      modelConfigured: true,
      currentFiles: [
        {
          path: "opening.md",
          contents: "宿舍门在你身后合上。秦龙抬眼看向你。",
        },
        {
          path: "world/current-situation.yaml",
          contents: "title: 当前情境\n情况: 秦龙正在整理球衣。",
        },
        {
          path: "world/characters/qinlong.yaml",
          contents: "title: 秦龙\n衣着: 白色运动背心",
        },
        {
          path: "control/frame.yaml",
          contents: "format: narraeon.world-frame/v1",
        },
      ],
      hasUnsavedFileDraft: false,
      contextPaths: [],
      contextLocked: false,
      progress: null,
      progressNow: 0,
      onGoalChange,
      onContextPathsChange,
      onStart,
      onConfirm,
      onRevisePlan: vi.fn(),
      onReviseCandidate: vi.fn(),
      onApply,
      onDiscard,
      onConfigureModel: vi.fn(),
    };
    const view = render(
      createElement(SettingImprovementPanel, {
        ...common,
        phase: "idle",
        goal: "",
        plan: null,
        candidate: null,
      }),
    );

    expect(screen.getByLabelText("设定完善进度").textContent).toContain(
      "描述目标",
    );
    expect(screen.getByRole("heading", { name: "当前设定" })).toBeTruthy();
    expect(screen.getByText(/宿舍门在你身后合上/u)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("注入 opening.md"));
    expect(onContextPathsChange).toHaveBeenCalledWith(["opening.md"]);
    fireEvent.click(
      screen.getByRole("button", {
        name: /world\/characters\/qinlong\.yaml/u,
      }),
    );
    expect(screen.getByText(/白色运动背心/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "生成可见创作计划" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "确认计划并生成候选" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "跳过计划，直接生成候选" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "补足人物动机、关系与可持续冲突，让角色更容易推动故事。",
      }),
    );
    expect(onGoalChange).toHaveBeenCalledWith(
      "补足人物动机、关系与可持续冲突，让角色更容易推动故事。",
    );
    view.rerender(
      createElement(SettingImprovementPanel, {
        ...common,
        contextPaths: ["opening.md"],
        phase: "idle",
        goal: "完善人物关系",
        plan: null,
        candidate: null,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "跳过计划，直接生成候选" }),
    );
    expect(onStart).toHaveBeenCalledWith("direct_candidate");

    view.rerender(
      createElement(SettingImprovementPanel, {
        ...common,
        hasUnsavedFileDraft: true,
        phase: "idle",
        goal: "完善人物关系",
        plan: null,
        candidate: null,
      }),
    );
    expect(screen.getByText("手动编辑尚未保存")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "生成可见创作计划" })
        .hasAttribute("disabled"),
    ).toBe(true);

    view.rerender(
      createElement(SettingImprovementPanel, {
        ...common,
        phase: "planned",
        goal: "完善人物关系",
        plan,
        candidate: null,
      }),
    );
    expect(screen.getByRole("heading", { name: "创作计划" })).toBeTruthy();
    expect(screen.getByText("让人物关系推动日常故事。")).toBeTruthy();
    expect(screen.getByText("创作目标已提交")).toBeTruthy();
    expect(screen.getByText("完善人物关系")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认计划并生成候选" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    view.rerender(
      createElement(SettingImprovementPanel, {
        ...common,
        phase: "ready",
        goal: "完善人物关系",
        plan,
        candidate: candidate(),
      }),
    );
    expect(
      screen.getByRole("heading", { name: "审阅候选，再决定是否应用" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("world/characters/qinlong.yaml").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/旧关系/u)).toBeTruthy();
    expect(screen.getByText(/新关系/u)).toBeTruthy();
    expect(screen.getByText("真实提示词预览")).toBeTruthy();
    expect(screen.getByText("12,400 / 32,000 tokens")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "整批应用候选" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  test("直接候选路径明确标记计划已跳过", () => {
    render(
      createElement(SettingImprovementPanel, {
        packageName: "宿舍世界",
        packageStatus: "usable",
        modelConfigured: true,
        currentFiles: [],
        hasUnsavedFileDraft: false,
        contextPaths: [],
        contextLocked: true,
        phase: "ready",
        goal: "直接补齐缺口",
        plan: null,
        candidate: candidate(),
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
      }),
    );

    expect(screen.getByText("已跳过可见计划")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "审阅候选，再决定是否应用" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("设定完善目标")).toBeNull();
  });
});

function candidate(): SettingImprovementCandidateResult {
  return {
    kind: "candidate",
    review: {
      status: "usable",
      diagnostics: [],
      diff: [
        {
          path: "opening.md",
          kind: "modify",
          before: "秦龙抬眼看向你。",
          after: "阿雾和秦龙同时看向你，等你回应。",
        },
        {
          path: "world/characters/qinlong.yaml",
          kind: "modify",
          before: "关系: 旧关系",
          after: "关系: 新关系",
        },
      ],
      preview: {
        diagnosticBinding: {
          endpoint: "setting-candidate",
          commit: "candidate",
          hostPresetId: "setting-candidate",
          controlFingerprint: "setting-candidate",
          modelId: "test-model",
        },
        compilation: {
          logicalMessages: [
            {
              role: "world_context",
              markdown: "# 当前世界\n\n关系已经更新。",
              blocks: [{ source: "world", markdown: "关系已经更新。" }],
            },
          ],
          provider: { messages: [{ role: "user", content: "当前世界" }] },
          tools: [
            {
              name: "context_read",
              description: "读取文档",
              inputSchema: { type: "object" },
            },
          ],
          coverage: [
            {
              slot: "current_situation",
              source: "world/current-situation.yaml",
              status: "resolved",
              complete: true,
              continuation: null,
            },
          ],
          budget: {
            estimator: "conservative_utf8_bytes",
            messageTokens: 5_000,
            toolTokens: 1_000,
            outputReserveTokens: 4_000,
            forcedTailReserveTokens: 1_000,
            safetyMarginTokens: 1_400,
            requiredTokens: 12_400,
            contextWindowTokens: 32_000,
            status: "fits",
          },
          cache: {
            stablePrefixFingerprint: "stable",
            breakpoints: ["world_context"],
            estimatedCacheableTokens: 4_000,
            firstDynamicByte: 2_000,
          },
        },
        leakage: { status: "clean", checkedFields: ["schemaId"] },
      },
    },
  };
}
