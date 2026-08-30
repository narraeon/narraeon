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

afterEach(cleanup);

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
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        hasApiKey: true,
      },
    ],
    presets: modelProviderPresets,
  };
}
