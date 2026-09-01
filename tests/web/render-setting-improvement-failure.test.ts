// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { V1Request } from "../../src/protocol/v1.ts";
import { App } from "../../src/web/App.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(cleanup);

test("直接生成流失败后保留明确错误、目标和原方式重试入口", async () => {
  const starts: Extract<V1Request, { type: "setting-improvement.start" }>[] =
    [];
  let rejectFirstStart: ((reason: Error) => void) | undefined;
  const firstStart = new Promise<never>((_resolve, reject) => {
    rejectFirstStart = reject;
  });
  const retryStart = new Promise<never>(() => undefined);
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    const resolved = await Promise.resolve(input);
    if (resolved.type === "workspace.read") return workspace();
    if (resolved.type === "content.read") return contentPackage();
    if (resolved.type === "setting-improvement.progress") return progress();
    if (resolved.type === "setting-improvement.start") {
      starts.push(resolved);
      return starts.length === 1 ? firstStart : retryStart;
    }
    throw new Error(`Unexpected request: ${resolved.type}`);
  });
  const client = { request } as unknown as RuntimeClient;

  render(createElement(App, { client }));
  fireEvent.click(
    await screen.findByRole("button", { name: "打开内容包：宿舍草稿" }),
  );
  await screen.findByRole("heading", { name: "宿舍草稿" });
  fireEvent.click(screen.getByRole("button", { name: "AI 完善" }));
  const goal = screen.getByLabelText<HTMLTextAreaElement>("设定完善目标");
  fireEvent.change(goal, {
    target: { value: "补足人物动机和可持续冲突，但不要改开场白。" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "跳过计划，直接生成候选" }),
  );
  await waitFor(() => expect(starts).toHaveLength(1));

  await act(async () => {
    rejectFirstStart?.(new Error("Anthropic SSE content block did not end"));
    await Promise.resolve();
  });

  const failure = await screen.findByRole("alert", {
    name: "AI 设定完善失败",
  });
  expect(failure.textContent).toContain(
    "Anthropic SSE content block did not end",
  );
  expect(failure.textContent).toContain("内容包当前树没有改变");
  expect(goal.value).toBe("补足人物动机和可持续冲突，但不要改开场白。");

  fireEvent.click(screen.getByRole("button", { name: "按原方式重试" }));
  await waitFor(() => expect(starts).toHaveLength(2));
  expect(starts.map(({ mode }) => mode)).toEqual([
    "direct_candidate",
    "direct_candidate",
  ]);
  expect(starts[1]?.improvementId).not.toBe(starts[0]?.improvementId);
});

function workspace(): unknown {
  return {
    preferences: { locale: "zh-CN" },
    contentPackages: [
      {
        localId: "package-dorm",
        displayName: "宿舍草稿",
        status: "usable",
      },
    ],
    playPresets: { currentPresetId: "", presets: [] },
    worlds: [],
    storageNotices: [],
    model: {
      configured: true,
      activeConnectionId: "model-1",
      connections: [{ id: "model-1", name: "Claude 测试模型" }],
      presets: [],
    },
  };
}

function contentPackage(): unknown {
  return {
    localId: "package-dorm",
    displayName: "宿舍草稿",
    status: "usable",
    issues: [],
    files: [
      {
        path: "opening.md",
        encoding: "utf8",
        contents: "宿舍门在你身后合上。",
      },
    ],
  };
}

function progress(): unknown {
  return {
    phase: "generating",
    round: 0,
    maxRounds: 64,
    toolCalls: 0,
    repairs: 0,
    failedChecks: 0,
    usage: {
      inputTokens: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      provenance: {
        inputTokens: "derived_provider_fields",
        uncachedInputTokens: "derived_provider_fields",
        cacheReadTokens: "derived_provider_fields",
        cacheWriteTokens: "derived_provider_fields",
        reasoningTokens: "derived_provider_fields",
        outputTokens: "derived_provider_fields",
        totalTokens: "derived_provider_fields",
      },
    },
    writing: null,
    recentActions: [],
    lastCheck: null,
    failure: null,
    streaming: null,
    updatedAt: Date.now(),
  };
}
