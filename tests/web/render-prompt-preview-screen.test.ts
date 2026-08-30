// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { V1Request } from "../../src/protocol/v1.ts";
import {
  PromptPreviewScreen,
  type PromptPreviewData,
} from "../../src/web/PromptPreviewScreen.tsx";

afterEach(cleanup);

describe("提示词预览界面", () => {
  test("先明确预览输入，再按逻辑消息、材料、Provider 和诊断整理真实结果", async () => {
    const requests: V1Request[] = [];
    render(
      createElement(PromptPreviewScreen, {
        client: {
          request<T = unknown>(request: V1Request): Promise<T> {
            requests.push(request);
            return Promise.resolve(previewFixture() as T);
          },
        },
        packages: [
          {
            localId: "package-dormitory",
            displayName: "宿舍内容",
            status: "usable" as const,
          },
        ],
        initialPackageId: "package-dormitory",
        playPresets: presetLibrary(),
        model: modelLibrary(),
        onPackageSelect: vi.fn(),
      }),
    );

    expect(screen.getByRole("heading", { name: "提示词预览" })).toBeTruthy();
    expect(screen.getByText("0 次模型调用")).toBeTruthy();
    expect(screen.getByText("内容包首轮 · 全新上下文")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("预览内容包").value).toBe(
      "package-dormitory",
    );
    expect(screen.getByText("不作为模型历史注入")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("预览玩家输入"), {
      target: { value: "I ask Alex whether we are training tonight." },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成真实预览" }));

    await screen.findByRole("heading", { name: "编译通过" });
    expect(requests).toEqual([
      {
        type: "prompt.preview",
        packageId: "package-dormitory",
        playerInput: "I ask Alex whether we are training tonight.",
        model: {
          provider: "chat_completions",
          modelId: "trace-model",
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_000,
        },
        playPresetId: "preset-current",
      },
    ]);
    expect(
      screen.getByText("真实编译已完成；没有调用模型，也没有改变内容或世界。"),
    ).toBeTruthy();

    const logicalOrder = screen.getByRole("list", { name: "逻辑消息顺序" });
    expect(within(logicalOrder).getByText("Runtime 系统")).toBeTruthy();
    expect(within(logicalOrder).queryByText("玩家原文")).toBeNull();
    expect(screen.getByText("最终 Markdown 正文")).toBeTruthy();
    expect(
      document.querySelector(".prompt-message-body pre")?.textContent,
    ).toBe("# Runtime contract\n\nPropose candidates only through tools.");

    const initialAppend = screen
      .getByRole("heading", { name: "首条玩家追加" })
      .closest("section");
    expect(initialAppend).not.toBeNull();
    expect(
      within(initialAppend!).getByText(
        "I ask Alex whether we are training tonight.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /材料与工具/u }));
    expect(
      screen.getByRole("heading", { name: "材料覆盖与调用链工具" }),
    ).toBeTruthy();
    expect(screen.getByText("当前情境")).toBeTruthy();
    expect(screen.getByText("可选未证明完整")).toBeTruthy();
    expect(screen.getByText("state_list", { exact: true })).toBeTruthy();
    expect(screen.getByText("history_list", { exact: true })).toBeTruthy();
    expect(screen.getByText("world_patch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Provider 映射/u }));
    expect(
      screen.getByRole("heading", {
        name: "Provider 映射 · Chat Completions",
      }),
    ).toBeTruthy();
    expect(screen.getByText("system", { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /预算与诊断/u }));
    expect(screen.getByRole("heading", { name: "预算与诊断" })).toBeTruthy();
    expect(screen.getByText("内部字段泄漏扫描通过")).toBeTruthy();
    expect(screen.getByText("sha256:stable-prefix")).toBeTruthy();
  });

  test("需要修复的内容不能编译，输入变化会让过期请求失效", async () => {
    let resolvePreview: ((preview: PromptPreviewData) => void) | undefined;
    const request = vi.fn();
    const client = {
      request<T = unknown>(command: V1Request): Promise<T> {
        request(command);
        return new Promise<PromptPreviewData>((resolve) => {
          resolvePreview = resolve;
        }) as Promise<T>;
      },
    };
    const onPackageSelect = vi.fn();
    render(
      createElement(PromptPreviewScreen, {
        client,
        packages: [
          {
            localId: "package-broken",
            displayName: "待修内容",
            status: "needs_repair" as const,
          },
          {
            localId: "package-ready",
            displayName: "可用内容",
            status: "usable" as const,
          },
        ],
        initialPackageId: "package-broken",
        playPresets: presetLibrary(),
        model: modelLibrary(),
        onPackageSelect,
      }),
    );

    expect(screen.getByText(/这份内容包仍需修复/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "生成真实预览" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("预览内容包"), {
      target: { value: "package-ready" },
    });
    expect(onPackageSelect).toHaveBeenCalledWith("package-ready");
    fireEvent.click(screen.getByRole("button", { name: "生成真实预览" }));
    expect(
      screen.getByRole("button", { name: "正在编译真实预览…" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("预览玩家输入"), {
      target: { value: "改用另一条玩家输入。" },
    });
    expect(screen.getByRole("button", { name: "生成真实预览" })).toBeTruthy();
    resolvePreview?.(previewFixture());
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "编译通过" })).toBeNull();
  });
});

function presetLibrary() {
  return {
    schemaVersion: 1 as const,
    currentPresetId: "preset-current",
    presets: [
      {
        id: "preset-current",
        name: "克制预设",
        revision: "rev-1",
        files: {},
        validation: { status: "valid" as const },
        enabled: true,
        scriptsEnabled: true,
      },
    ],
  };
}

function modelLibrary() {
  return {
    configured: true,
    activeConnectionId: "model-current",
    connections: [
      {
        id: "model-current",
        name: "默认模型",
        presetId: "custom" as const,
        provider: "chat_completions" as const,
        dialect: "standard" as const,
        baseUrl: "https://example.test/v1",
        modelId: "trace-model",
        reasoningEffort: "provider_default" as const,
        reasoningSummary: "provider_default" as const,
        thinkingMode: "provider_default" as const,
        thinkingBudgetTokens: null,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        hasApiKey: true as const,
      },
    ],
    presets: [],
  };
}

function previewFixture(): PromptPreviewData {
  const messages = [
    {
      role: "runtime_system" as const,
      markdown: "# Runtime contract\n\nPropose candidates only through tools.",
      blocks: [
        {
          source: "runtime:play-contract",
          markdown:
            "# Runtime contract\n\nPropose candidates only through tools.",
        },
      ],
    },
    {
      role: "author_instruction" as const,
      markdown: "# Host style\n\nBe specific and restrained.",
      blocks: [
        {
          source: "host:blocks/style.md",
          markdown: "# Host style\n\nBe specific and restrained.",
        },
      ],
    },
    {
      role: "world_context" as const,
      markdown: "# Current situation\n\nAlex is folding a jersey.",
      blocks: [
        {
          source: "slot:current_situation:situation.current",
          markdown: "# Current situation\n\nAlex is folding a jersey.",
        },
      ],
    },
  ];
  return {
    diagnosticBinding: {
      endpoint: "content:package-dormitory",
      commit: "current",
      hostPresetId: "host-current",
      controlFingerprint: "content-preview",
      modelId: "trace-model",
    },
    compilation: {
      logicalMessages: messages,
      provider: {
        protocol: "chat_completions",
        messages: [
          {
            role: "system",
            content: `${messages[0]!.markdown}\n\n${messages[1]!.markdown}`,
          },
          {
            role: "user",
            content: [{ type: "text", text: messages[2]!.markdown }],
          },
        ],
      },
      tools: [
        {
          name: "state_list",
          description: "List state handles known to Runtime.",
          inputSchema: { type: "object" },
        },
        {
          name: "history_list",
          description: "List committed history handles known to Runtime.",
          inputSchema: { type: "object" },
        },
        {
          name: "context_read",
          description: "Read a handle returned by Runtime precisely.",
          inputSchema: { type: "object" },
        },
        {
          name: "world_patch",
          description: "Update world state.",
          inputSchema: { type: "object" },
        },
      ],
      coverage: [
        {
          slot: "current_situation",
          source: "@current-situation",
          status: "resolved",
          complete: true,
          continuation: "context_read",
        },
        {
          slot: "additional_materials",
          source: "@history-message-genesis",
          status: "optional_missing",
          complete: false,
          continuation: "context_read",
        },
      ],
      budget: {
        estimator: "conservative_utf8_bytes",
        messageTokens: 4_000,
        toolTokens: 2_000,
        outputReserveTokens: 8_000,
        forcedTailReserveTokens: 8_000,
        safetyMarginTokens: 2_560,
        requiredTokens: 24_560,
        contextWindowTokens: 128_000,
        status: "fits",
      },
      cache: {
        stablePrefixFingerprint: "sha256:stable-prefix",
        breakpoints: [],
        strategy: "provider_managed",
        estimatedCacheableBytes: 5_000,
        firstDynamicByte: 5_000,
      },
    },
    initialAppend: {
      logical: {
        kind: "player",
        text: "I ask Alex whether we are training tonight.",
      },
      provider: {
        role: "user",
        content: "I ask Alex whether we are training tonight.",
      },
    },
    leakage: {
      status: "clean",
      checkedFields: ["hostPresetId", "operationId", "recordId"],
    },
  };
}
