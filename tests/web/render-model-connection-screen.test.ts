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
  fireEvent.click(screen.getByText("高级选项"));
  const select = screen.getByLabelText<HTMLSelectElement>("中断回复的继续发送");
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
  fireEvent.click(screen.getByText("高级选项"));
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的继续发送").value,
  ).toBe("mistral_prefix");
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "anthropic_messages" },
  });
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的继续发送").value,
  ).toBe("disabled");
  expect(
    screen.queryByRole("option", { name: "prefix: true（DeepSeek）" }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "openai_responses" },
  });
  expect(
    screen.getByLabelText<HTMLSelectElement>("中断回复的继续发送").value,
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
  fireEvent.click(screen.getByText("Advanced options"));
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
  fireEvent.click(screen.getByText("Advanced options"));
  expect(
    screen.getByLabelText<HTMLSelectElement>(
      "Supports tool subset selection (allowed_tools)",
    ).value,
  ).toBe("true");
});

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
        reasoningEffort: "high",
        reasoningSummary: "none",
        thinkingMode: "enabled",
        thinkingBudgetTokens: 4_096,
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

test("已有配置改变协议和端点后仍可沿用本机 API Key", () => {
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

  fireEvent.change(screen.getByLabelText("协议适配器"), {
    target: { value: "openai_responses" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://new-endpoint.invalid/v1" },
  });

  expect(screen.getByLabelText<HTMLInputElement>("API Key").required).toBe(
    false,
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "从端点拉取模型",
    }).disabled,
  ).toBe(false);
  expect(screen.getByLabelText("API Key").getAttribute("placeholder")).toBe(
    "留空以沿用本机保存的现有凭据",
  );
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
