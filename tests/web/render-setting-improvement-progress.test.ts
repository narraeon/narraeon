// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  SettingImprovementPanel,
  type SettingImprovementProgress,
} from "../../src/web/SettingImprovementPanel.tsx";

afterEach(cleanup);

test("候选生成中展示轮次、计数、token 与当前写入路径", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "generating" as const,
      progress: progress({
        round: 12,
        toolCalls: 47,
        failedChecks: 2,
        usage: { inputTokens: 128_400, outputTokens: 9200 },
        writing: "world/characters/mia.yaml",
        recentActions: [
          { tool: "setting_patch", target: "@alex", ok: true },
          {
            tool: "setting_write_file",
            target: "world/characters/mia.yaml",
            ok: true,
          },
        ],
      }),
      progressNow: 1_000_008_000,
    }),
  );

  expect(screen.getByText("第 12 / 64 轮")).toBeTruthy();
  expect(screen.getByText("正在生成候选")).toBeTruthy();
  expect(screen.getByText("47")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText("↑128.4k ↓9.2k")).toBeTruthy();
  // The current write path and recent action each appear once.
  expect(screen.getAllByText("world/characters/mia.yaml")).toHaveLength(2);
  expect(screen.getByText("@alex")).toBeTruthy();
  expect(screen.getByText("8 秒前更新")).toBeTruthy();
});

test("模型正在输出时显示已收字数与正文尾巴，不报停滞", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "generating" as const,
      progress: progress({
        round: 3,
        streaming: {
          reasoningChars: 800,
          textChars: 1400,
          toolChars: 0,
          tail: "Alex把球衣叠好，抬头看你。",
          // Streaming began two minutes ago, but a fragment arrived one second ago.
          receivedAt: 1_000_119_000,
        },
      }),
      progressNow: 1_000_120_000,
    }),
  );

  expect(screen.getByText("正在输出 2.2k 字")).toBeTruthy();
  expect(screen.getByText(/Alex把球衣叠好，抬头看你。/u)).toBeTruthy();
  expect(screen.getByText("正文")).toBeTruthy();
  expect(screen.queryByText(/可能已经卡住/u)).toBeNull();
});

test("只有思维链时标注为思考中", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "generating" as const,
      progress: progress({
        streaming: {
          reasoningChars: 300,
          textChars: 0,
          toolChars: 0,
          tail: "先确认现有关系再决定写哪份文档。",
          receivedAt: 1_000_002_000,
        },
      }),
      progressNow: 1_000_003_000,
    }),
  );

  expect(screen.getByText("思考中")).toBeTruthy();
  expect(screen.getByText("正在输出 300 字")).toBeTruthy();
});

test("长时间收不到任何片段才报卡住", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "generating" as const,
      progress: progress({
        round: 3,
        streaming: {
          reasoningChars: 500,
          textChars: 0,
          toolChars: 0,
          tail: "刚开始想。",
          receivedAt: 1_000_000_000,
        },
      }),
      progressNow: 1_000_100_000,
    }),
  );

  expect(
    screen.getByText(/已有 100 秒没有收到任何输出，模型调用可能已经卡住。/u),
  ).toBeTruthy();
});

test("尚未收到首个进度时不显示误导性的计数为零之外的内容", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "planning" as const,
      progress: null,
      progressNow: 0,
    }),
  );

  expect(screen.getByText("正在生成创作计划")).toBeTruthy();
  expect(screen.getByText("第 0 / 64 轮")).toBeTruthy();
  expect(screen.getByText("正在建立连接…")).toBeTruthy();
});

test("未在生成阶段时不渲染进度卡片", () => {
  render(
    createElement(SettingImprovementPanel, {
      ...common(),
      phase: "idle" as const,
      progress: progress({ round: 9 }),
      progressNow: 1_000_001_000,
    }),
  );

  expect(screen.queryByLabelText("本次生成进度")).toBeNull();
});

function progress(
  overrides: Partial<SettingImprovementProgress> = {},
): SettingImprovementProgress {
  return {
    phase: "generating",
    round: 1,
    maxRounds: 64,
    toolCalls: 0,
    repairs: 0,
    failedChecks: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    writing: null,
    recentActions: [],
    lastCheck: null,
    failure: null,
    streaming: null,
    updatedAt: 1_000_000_000,
    ...overrides,
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
    goal: "Develop the character relationships",
    plan: null,
    candidate: null,
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
