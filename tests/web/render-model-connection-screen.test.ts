// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  modelProviderPresets,
  type ModelConnectionLibraryView,
} from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { ModelConnectionScreen } from "../../src/web/ModelConnectionScreen.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

test("拒绝保存后读回最新模型配置并保留表单草稿，恢复失败可以只读重试", async () => {
  const original = modelLibrary();
  const latest = modelLibrary();
  latest.connections[0]!.name = "另一页面保存的模型";
  let offline = true;
  const requests: string[] = [];
  const client = {
    request: async (input: V1Request) => {
      await Promise.resolve();
      requests.push(input.type);
      if (input.type === "model.save")
        throw new Error("配置版本冲突；请检查最新配置再保存");
      if (input.type === "model.read" && !offline) return latest;
      throw new Error("offline");
    },
  } as unknown as RuntimeClient;
  function Harness() {
    const [library, setLibrary] = useState(original);
    const [notice, setNotice] = useState("");
    return createElement(
      "div",
      null,
      createElement("p", { role: "alert" }, notice),
      createElement(ModelConnectionScreen, {
        client,
        library,
        onLibraryChange: setLibrary,
        onNotice: setNotice,
        onDirtyChange: vi.fn(),
      }),
    );
  }
  render(createElement(Harness));
  fireEvent.change(screen.getByLabelText("配置名称"), {
    target: { value: "保留我的编辑" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));
  await screen.findByText("暂时无法同步");
  expect(requests).toEqual(["model.save", "model.read"]);
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByText("另一页面保存的模型", { selector: "strong" });
  expect(screen.getByLabelText<HTMLInputElement>("配置名称").value).toBe(
    "保留我的编辑",
  );
  expect(screen.getByText("配置版本冲突；请检查最新配置再保存")).toBeTruthy();
  expect(screen.queryByText("暂时无法同步")).toBeNull();
  expect(requests).toEqual(["model.save", "model.read", "model.read"]);
});

test("模型保存回执到达前保护当前编辑，结束后可继续修改", async () => {
  const library = modelLibrary();
  const receipt = Promise.withResolvers<ModelConnectionLibraryView>();
  const request = vi.fn(() => receipt.promise);
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  const name = screen.getByLabelText<HTMLInputElement>("配置名称");
  fireEvent.submit(name.form!);
  expect(name.matches(":disabled")).toBe(true);
  receipt.resolve(library);
  await waitFor(() => expect(name.matches(":disabled")).toBe(false));
  expect(request).toHaveBeenCalledTimes(1);
});

test("预填充高级设置显式保存并在重开后保留，切换协议清除能力", async () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "chat_completions",
    dialect: "standard",
  };
  const request = vi.fn((input: V1Request) => {
    if (input.type === "model.save") {
      expect(input.connection.assistantPrefillMode).toBe("mistral_prefix");
      return Promise.resolve({
        ...library,
        connections: [
          {
            ...library.connections[0]!,
            assistantPrefillMode: "mistral_prefix",
          },
        ],
      });
    }
    return Promise.resolve(library);
  });
  const props = {
    client: { request } as unknown as RuntimeClient,
    library,
    onLibraryChange: vi.fn(),
    onNotice: vi.fn(),
    onDirtyChange: vi.fn(),
  };
  const view = render(createElement(ModelConnectionScreen, props));
  fireEvent.click(screen.getByText("高级协议选项"));
  const select = screen.getByLabelText<HTMLSelectElement>("中断回复的续写方式");
  expect(select.value).toBe("disabled");
  fireEvent.change(select, { target: { value: "mistral_prefix" } });
  expect(
    screen.getByText("Mistral 返回包含已发前缀的完整正文，不重复拼接。"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));
  await waitFor(() => expect(props.onLibraryChange).toHaveBeenCalled());
  view.unmount();
  const savedLibrary: ModelConnectionLibraryView = {
    ...library,
    connections: [
      { ...library.connections[0], assistantPrefillMode: "mistral_prefix" },
    ],
  };
  render(
    createElement(ModelConnectionScreen, { ...props, library: savedLibrary }),
  );
  fireEvent.click(screen.getByText("高级协议选项"));
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的续写方式").value,
  ).toBe("mistral_prefix");
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "anthropic_messages" },
  });
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的续写方式").value,
  ).toBe("disabled");
  expect(
    screen.queryByRole("option", { name: "prefix: true（DeepSeek）" }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "openai_responses" },
  });
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的续写方式").value,
  ).toBe("disabled");
  expect(
    screen.getByRole("option", { name: "partial: true（火山方舟）" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("option", { name: "prefix: true（DeepSeek）" }),
  ).toBeNull();
});

test("Responses 高级选项可编辑保存并用英文显示已保存的值", async () => {
  setWebLocale("en");
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "openai_responses",
    dialect: "standard",
    supportsAllowedTools: false,
  };
  const request = vi.fn((input: V1Request) => {
    if (input.type === "model.save") {
      expect(input.connection.supportsAllowedTools).toBe(true);
      return Promise.resolve({
        ...library,
        connections: [
          { ...library.connections[0]!, supportsAllowedTools: true },
        ],
      });
    }
    return Promise.resolve(library);
  });
  const props = {
    client: { request } as unknown as RuntimeClient,
    library,
    onLibraryChange: vi.fn(),
    onNotice: vi.fn(),
    onDirtyChange: vi.fn(),
  };
  const view = render(createElement(ModelConnectionScreen, props));
  fireEvent.click(screen.getByText("Advanced protocol options"));
  const select = screen.getByLabelText<HTMLSelectElement>(
    "Supports tool subset selection (allowed_tools)",
  );
  expect(select.value).toBe("false");
  fireEvent.change(select, { target: { value: "true" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and enable model connection" }),
  );
  await waitFor(() => expect(props.onLibraryChange).toHaveBeenCalled());
  view.unmount();
  render(
    createElement(ModelConnectionScreen, {
      ...props,
      library: {
        ...library,
        connections: [
          { ...library.connections[0], supportsAllowedTools: true },
        ],
      },
    }),
  );
  fireEvent.click(screen.getByText("Advanced protocol options"));
  expect(
    screen.getByLabelText<HTMLSelectElement>(
      "Supports tool subset selection (allowed_tools)",
    ).value,
  ).toBe("true");
});

test("GPT-6.2 本轮提示和转 Claude 缓存各自显式启用，随连接限定范围", async () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "openai_responses",
    dialect: "standard",
  };
  const request = vi.fn((input: V1Request) => {
    if (input.type !== "model.save") return Promise.resolve(library);
    return Promise.resolve({
      ...library,
      connections: [{ ...library.connections[0]!, ...input.connection }],
    });
  });
  const onLibraryChange = vi.fn();
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange,
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByText("高级协议选项"));
  const turnLabel = "GPT-6.2 本轮提示";
  const cacheLabel = "CLIProxyAPI 转 Claude 的显式缓存标记";
  const turn = screen.getByLabelText<HTMLSelectElement>(turnLabel);
  expect(turn.value).toBe("false");
  expect(screen.queryByLabelText(cacheLabel)).toBeNull();
  fireEvent.change(turn, { target: { value: "true" } });
  const dialect = screen.getByLabelText("端点方言");
  fireEvent.change(dialect, { target: { value: "cliproxyapi" } });
  const cache = screen.getByLabelText<HTMLSelectElement>(cacheLabel);
  expect(cache.value).toBe("false");
  fireEvent.change(cache, { target: { value: "true" } });
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));
  await waitFor(() => expect(onLibraryChange).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "model.save",
    connection: {
      responsesTurnInstructions: true,
      responsesCacheControl: true,
    },
  });
  expect(screen.getByLabelText<HTMLSelectElement>(turnLabel).value).toBe(
    "true",
  );
  expect(screen.getByLabelText<HTMLSelectElement>(cacheLabel).value).toBe(
    "true",
  );
  fireEvent.change(dialect, { target: { value: "standard" } });
  fireEvent.change(dialect, { target: { value: "cliproxyapi" } });
  expect(screen.getByLabelText<HTMLSelectElement>(cacheLabel).value).toBe(
    "false",
  );
  const provider = screen.getByLabelText("协议适配器");
  fireEvent.change(provider, { target: { value: "chat_completions" } });
  expect(screen.queryByLabelText(turnLabel)).toBeNull();
  expect(screen.queryByLabelText(cacheLabel)).toBeNull();
  fireEvent.change(provider, { target: { value: "openai_responses" } });
  expect(screen.getByLabelText<HTMLSelectElement>(turnLabel).value).toBe(
    "false",
  );
});

test.each(["zh-CN", "en"] as const)(
  "%s Anthropic 自定义端点显示并保存独立缓存时长",
  async (locale) => {
    setWebLocale(locale);
    const localize = (zh: string, en: string) => (locale === "en" ? en : zh);
    const library = modelLibrary();
    const legacy = {
      ...library.connections[0]!,
      provider: "anthropic_messages" as const,
    };
    const other = {
      ...legacy,
      id: "other",
      name: "Other Anthropic",
      anthropicPromptCacheTtl: "5m" as const,
    };
    library.connections = [legacy, other];
    const onLibraryChange =
      vi.fn<(value: ModelConnectionLibraryView) => void>();
    const request = vi.fn((input: V1Request) => {
      if (input.type !== "model.save") return Promise.resolve(library);
      return Promise.resolve({
        ...library,
        connections: [{ ...legacy, ...input.connection }, other],
      });
    });
    const props = {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange,
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    };
    const label = localize("提示词缓存时长", "Prompt cache duration");
    const advanced = localize("高级协议选项", "Advanced protocol options");
    const save = localize(
      "保存模型连接并启用",
      "Save and enable model connection",
    );
    const view = render(createElement(ModelConnectionScreen, props));
    fireEvent.click(screen.getByText(advanced));
    const select = screen.getByLabelText<HTMLSelectElement>(label);
    expect(select.value).toBe("5m");
    expect(Array.from(select.options, (item) => item.text)).toEqual([
      localize("5 分钟（默认）", "5 minutes (default)"),
      localize("1 小时", "1 hour"),
    ]);
    expect(
      screen.getByText(
        localize(
          "命中缓存会续期。1 小时缓存的写入费用更高。",
          "A cache hit refreshes its lifetime. Writing to the 1-hour cache costs more.",
        ),
      ),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: "1h" } });
    fireEvent.click(screen.getByRole("button", { name: save }));
    await waitFor(() => expect(onLibraryChange).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      type: "model.save",
      connection: { anthropicPromptCacheTtl: "1h" },
    });
    const saved = onLibraryChange.mock.calls[0]![0];
    expect(saved.connections[1]?.anthropicPromptCacheTtl).toBe("5m");
    view.unmount();

    render(createElement(ModelConnectionScreen, { ...props, library: saved }));
    fireEvent.click(screen.getByText(advanced));
    expect(screen.getByLabelText<HTMLSelectElement>(label).value).toBe("1h");
    const protocol = screen.getByLabelText(
      localize("协议适配器", "Protocol adapter"),
    );
    for (const provider of [
      "chat_completions",
      "openai_responses",
      "google_interactions",
    ]) {
      fireEvent.change(protocol, { target: { value: provider } });
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    fireEvent.change(protocol, { target: { value: "anthropic_messages" } });
    expect(screen.getByLabelText<HTMLSelectElement>(label).value).toBe("5m");
  },
);

test("Google 连接允许使用已保存凭据拉取模型并保留手填输入", () => {
  setWebLocale("en");
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "google_interactions",
    dialect: "standard",
    reasoningEffort: "provider_default",
    reasoningSummary: "provider_default",
  };
  render(
    createElement(ModelConnectionScreen, {
      client: { request: vi.fn() } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  expect(
    screen.getByText(/Interactions support depends on the selected model/),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Fetch models from endpoint",
    }).disabled,
  ).toBe(false);
});

test("Google 手工选择方言、推理等级或兼容预算，均保留独立摘要", async () => {
  const library = modelLibrary();
  const requests: V1Request[] = [];
  const request = (value: V1Request) => {
    requests.push(value);
    return Promise.resolve(library);
  };
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByText("高级协议选项"));
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "google_interactions" },
  });
  fireEvent.change(screen.getByLabelText("端点方言"), {
    target: { value: "cliproxyapi" },
  });
  const effort = screen.getByLabelText<HTMLSelectElement>("Effort（推理强度）");
  const mode =
    screen.getByLabelText<HTMLSelectElement>("Thinking（兼容预算模式）");
  const summary = screen.getByLabelText<HTMLSelectElement>("Thinking 返回内容");
  fireEvent.change(effort, { target: { value: "low" } });
  fireEvent.change(summary, { target: { value: "auto" } });
  fireEvent.change(mode, { target: { value: "enabled" } });
  expect(effort.value).toBe("provider_default");
  fireEvent.change(screen.getByLabelText("Thinking budget tokens"), {
    target: { value: "16" },
  });
  fireEvent.change(effort, { target: { value: "high" } });
  expect(mode.value).toBe("provider_default");
  expect(summary.value).toBe("auto");
  fireEvent.change(mode, { target: { value: "enabled" } });
  fireEvent.change(screen.getByLabelText("Thinking budget tokens"), {
    target: { value: "16" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));
  await waitFor(() =>
    expect(requests[0]).toMatchObject({
      type: "model.save",
      connection: {
        provider: "google_interactions",
        dialect: "cliproxyapi",
        reasoningEffort: "provider_default",
        reasoningSummary: "auto",
        thinkingMode: "enabled",
        thinkingBudgetTokens: 16,
      },
    }),
  );
});

test("Google 标准配置显示旧预算并要求明确选择可发送的设置", async () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    name: "Legacy Gemini",
    provider: "google_interactions",
    dialect: "standard",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-4-neon",
    reasoningSummary: "auto",
    thinkingMode: "enabled",
    thinkingBudgetTokens: 128,
  };
  const request = vi
    .fn<(value: V1Request) => Promise<unknown>>()
    .mockResolvedValue(library);
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  const save = screen.getByRole("button", { name: "保存模型连接并启用" });
  const advanced = screen.getByText("高级协议选项");
  expect(screen.getByRole("alert").textContent).toContain("旧的思考预算");
  fireEvent.click(save);
  expect(advanced.parentElement).toHaveProperty("open", true);
  expect(request).not.toHaveBeenCalled();
  const budget = screen.getByLabelText<HTMLInputElement>(
    "Thinking budget tokens",
  );
  expect(budget.value).toBe("128");
  expect(budget.readOnly).toBe(true);
  const dialect = screen.getByLabelText("端点方言");
  fireEvent.change(dialect, { target: { value: "cliproxyapi" } });
  expect(budget.readOnly).toBe(false);
  expect(budget.value).toBe("128");
  fireEvent.change(dialect, { target: { value: "standard" } });
  const effort = screen.getByLabelText<HTMLSelectElement>("Effort（推理强度）");
  expect(Array.from(effort.options, ({ value }) => value)).toEqual([
    "provider_default",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(
    effort.querySelector<HTMLOptionElement>('option[value="xhigh"]')?.disabled,
  ).toBe(false);
  fireEvent.change(effort, { target: { value: "xhigh" } });
  expect(screen.queryByLabelText("Thinking budget tokens")).toBeNull();
  expect(screen.queryByLabelText("Thinking（兼容预算模式）")).toBeNull();
  const model = screen.getByLabelText("模型 ID");
  fireEvent.change(model, { target: { value: "gemini-4-carbon" } });
  expect(effort.value).toBe("xhigh");
  expect(
    effort.querySelector<HTMLOptionElement>('option[value="xhigh"]')?.disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("xhigh");
  fireEvent.click(save);
  expect(request).not.toHaveBeenCalled();
  fireEvent.change(model, { target: { value: "gemini-4-hydrogen" } });
  fireEvent.click(save);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "model.save",
        connection: expect.objectContaining({
          dialect: "standard",
          modelId: "gemini-4-hydrogen",
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          thinkingMode: "provider_default",
          thinkingBudgetTokens: null,
        }) as unknown,
      }),
    ),
  );
});

test("Google Gemini 4 Hydrogen 的旧 minimal 可查看并改为支持的等级", async () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "google_interactions",
    dialect: "standard",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-4-hydrogen",
    reasoningEffort: "minimal",
  };
  const request = vi
    .fn<(value: V1Request) => Promise<unknown>>()
    .mockResolvedValue(library);
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  const save = screen.getByRole("button", { name: "保存模型连接并启用" });
  fireEvent.click(save);
  expect(request).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("请重新选择推理强度");
  const effort = screen.getByLabelText<HTMLSelectElement>("Effort（推理强度）");
  expect(effort.value).toBe("minimal");
  expect(
    effort.querySelector<HTMLOptionElement>('option[value="minimal"]')
      ?.disabled,
  ).toBe(true);
  fireEvent.change(effort, { target: { value: "medium" } });
  expect(effort.querySelector('option[value="minimal"]')).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(save);
  await waitFor(() =>
    expect(request.mock.lastCall?.[0]).toMatchObject({
      type: "model.save",
      connection: { reasoningEffort: "medium" },
    }),
  );
});

test("模型设置分别保存 Anthropic effort、thinking 模式、预算和返回内容", async () => {
  const library = modelLibrary();
  const requests: V1Request[] = [];
  const onLibraryChange = vi.fn();
  const onNotice = vi.fn();

  render(
    createElement(ModelConnectionScreen, {
      client: {
        request<T = unknown>(request: V1Request): Promise<T> {
          requests.push(request);
          return Promise.resolve({
            ...library,
            connections: library.connections.map((connection) => ({
              ...connection,
              reasoningEffort: "high" as const,
              reasoningSummary: "none" as const,
              thinkingMode: "enabled" as const,
              thinkingBudgetTokens: 4_096,
            })),
          } as T);
        },
      } as RuntimeClient,
      library,
      onLibraryChange,
      onNotice,
      onDirtyChange: vi.fn(),
    }),
  );

  fireEvent.click(screen.getByText("高级协议选项"));
  expect(
    screen.getByLabelText<HTMLSelectElement>("Effort（推理强度）").value,
  ).toBe("provider_default");
  expect(
    screen.getByLabelText<HTMLSelectElement>("Thinking（思考模式）").value,
  ).toBe("provider_default");
  expect(
    screen.getByLabelText<HTMLSelectElement>("Thinking 返回内容").disabled,
  ).toBe(true);

  fireEvent.change(screen.getByLabelText("Effort（推理强度）"), {
    target: { value: "high" },
  });
  fireEvent.change(screen.getByLabelText("Thinking（思考模式）"), {
    target: { value: "enabled" },
  });
  fireEvent.change(screen.getByLabelText("Thinking budget tokens"), {
    target: { value: "4096" },
  });
  fireEvent.change(screen.getByLabelText("Thinking 返回内容"), {
    target: { value: "none" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));

  await waitFor(() => expect(onLibraryChange).toHaveBeenCalledTimes(1));
  expect(requests).toEqual([
    {
      type: "model.save",
      connection: {
        connectionId: "model-claude",
        name: "Claude via CLIProxyAPI",
        presetId: "custom",
        provider: "anthropic_messages",
        dialect: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8317/v1",
        modelId: "claude-sonnet",
        modelPrompt: "",
        reasoningEffort: "high",
        reasoningSummary: "none",
        thinkingMode: "enabled",
        thinkingBudgetTokens: 4_096,
        anthropicPromptCacheTtl: "5m",
        supportsAllowedTools: true,
        assistantPrefillMode: "disabled",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
      },
    },
  ]);
  expect(onNotice).toHaveBeenCalledWith(
    "模型连接已保存并启用；后续请求只使用当前配置。",
  );
});

test("三种协议只暴露各自真实支持的 Effort、Thinking 和返回内容控件", () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    provider: "chat_completions",
    dialect: "standard",
    modelId: "chat-model",
  };
  render(
    createElement(ModelConnectionScreen, {
      client: { request: vi.fn() } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );

  fireEvent.click(screen.getByText("高级协议选项"));
  const provider = screen.getByLabelText<HTMLSelectElement>("协议适配器");
  const thinking =
    screen.getByLabelText<HTMLSelectElement>("Thinking（思考模式）");
  const returned =
    screen.getByLabelText<HTMLSelectElement>("Thinking 返回内容");

  expect(thinking.disabled).toBe(true);
  expect(thinking.value).toBe("provider_default");
  expect(returned.disabled).toBe(true);

  fireEvent.change(provider, { target: { value: "openai_responses" } });
  expect(thinking.disabled).toBe(true);
  expect(thinking.value).toBe("provider_default");
  expect(returned.disabled).toBe(false);

  fireEvent.change(provider, { target: { value: "anthropic_messages" } });
  expect(thinking.disabled).toBe(false);
  const effort = screen.getByLabelText<HTMLSelectElement>("Effort（推理强度）");
  expect([...effort.options].map(({ value }) => value)).not.toContain("none");
  expect([...effort.options].map(({ value }) => value)).not.toContain(
    "minimal",
  );
});

test("已有配置可以更改协议，更换来源时须重新填写 API Key", () => {
  const library = modelLibrary();
  render(
    createElement(ModelConnectionScreen, {
      client: { request: vi.fn() } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "新建另一份" }));
  expect(screen.getByLabelText<HTMLInputElement>("API Key").required).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));

  fireEvent.click(screen.getByText("高级协议选项"));
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "openai_responses" },
  });
  const key = screen.getByLabelText<HTMLInputElement>("API Key");
  const pull = screen.getByRole<HTMLButtonElement>("button", {
    name: "从端点拉取模型",
  });
  expect(key.required).toBe(false);
  expect(pull.disabled).toBe(false);
  expect(key.placeholder).toBe("留空以沿用本机保存的现有凭据");

  fireEvent.change(key, { target: { value: "draft-secret" } });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://new-endpoint.invalid/v1" },
  });
  expect(key.value).toBe("");
  expect(key.required).toBe(true);
  expect(pull.disabled).toBe(true);
  fireEvent.change(key, { target: { value: "new-secret" } });
  expect(pull.disabled).toBe(false);
});

test("CLIProxyAPI 模型后缀控制 Thinking 时仍可独立配置返回内容", () => {
  const library = modelLibrary();
  library.connections[0] = {
    ...library.connections[0]!,
    modelId: "claude-sonnet(high)",
    reasoningSummary: "auto",
  };
  render(
    createElement(ModelConnectionScreen, {
      client: { request: vi.fn() } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );

  fireEvent.click(screen.getByText("高级协议选项"));
  expect(
    screen.getByLabelText<HTMLSelectElement>("Thinking（思考模式）").value,
  ).toBe("provider_default");
  const returned =
    screen.getByLabelText<HTMLSelectElement>("Thinking 返回内容");
  expect(returned.disabled).toBe(false);
  expect(returned.value).toBe("auto");
});

test("克隆配置由 Runtime 复制凭据、保持当前配置并打开副本编辑", async () => {
  const library = modelLibrary();
  const copiedConnection = {
    ...library.connections[0]!,
    id: "model-claude-copy",
    name: "Claude via CLIProxyAPI（副本）",
  };
  const copiedLibrary = {
    ...library,
    connections: [...library.connections, copiedConnection],
  };
  const requests: V1Request[] = [];
  const onLibraryChange = vi.fn();
  const onNotice = vi.fn();

  render(
    createElement(ModelConnectionScreen, {
      client: {
        request<T = unknown>(request: V1Request): Promise<T> {
          requests.push(request);
          return Promise.resolve({
            library: copiedLibrary,
            copiedConnectionId: copiedConnection.id,
          } as T);
        },
      } as RuntimeClient,
      library,
      onLibraryChange,
      onNotice,
      onDirtyChange: vi.fn(),
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "克隆配置" }));

  await waitFor(() =>
    expect(onLibraryChange).toHaveBeenCalledWith(copiedLibrary),
  );
  expect(requests).toEqual([
    {
      type: "model.copy",
      connectionId: "model-claude",
      name: "Claude via CLIProxyAPI（副本）",
    },
  ]);
  expect(screen.getByLabelText<HTMLInputElement>("配置名称").value).toBe(
    "Claude via CLIProxyAPI（副本）",
  );
  expect(screen.getByRole("heading", { name: "编辑配置" })).toBeTruthy();
  expect(onNotice).toHaveBeenLastCalledWith(
    "已克隆为「Claude via CLIProxyAPI（副本）」。副本保留本机凭据，但不会切换当前配置。",
  );
});

test("拉取模型后提供独立下拉列表，已有 ID 不会隐藏其他模型，仍可手动输入", async () => {
  const library = modelLibrary();
  const request = vi.fn(async (input: V1Request) => {
    await Promise.resolve();
    if (input.type === "model.models")
      return { models: ["remote-one", "remote-two"] };
    if (input.type === "model.save") return library;
    throw new Error(`unexpected request: ${input.type}`);
  });
  render(
    createElement(ModelConnectionScreen, {
      client: { request } as unknown as RuntimeClient,
      library,
      onLibraryChange: vi.fn(),
      onNotice: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "从端点拉取模型" }));
  const picker = await screen.findByRole<HTMLSelectElement>("combobox", {
    name: "已拉取的模型",
  });
  expect([...picker.options].map(({ value }) => value)).toEqual([
    "",
    "remote-one",
    "remote-two",
  ]);
  fireEvent.change(picker, { target: { value: "remote-two" } });
  expect(screen.getByLabelText<HTMLInputElement>("模型 ID").value).toBe(
    "remote-two",
  );
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "custom-model" },
  });
  expect(picker.value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "保存模型连接并启用" }));
  await waitFor(() => {
    const saved = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.type === "model.save");
    expect(saved?.connection.modelId).toBe("custom-model");
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://other.invalid/v1" },
  });
  expect(screen.queryByRole("combobox", { name: "已拉取的模型" })).toBeNull();
});

function modelLibrary(): ModelConnectionLibraryView {
  return {
    configured: true,
    activeConnectionId: "model-claude",
    connections: [
      {
        id: "model-claude",
        name: "Claude via CLIProxyAPI",
        presetId: "custom",
        provider: "anthropic_messages",
        dialect: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8317/v1",
        modelId: "claude-sonnet",
        reasoningEffort: "provider_default",
        reasoningSummary: "provider_default",
        thinkingMode: "provider_default",
        thinkingBudgetTokens: null,
        supportsAllowedTools: true,
        assistantPrefillMode: "disabled",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        hasApiKey: true,
      },
    ],
    presets: modelProviderPresets,
  };
}
