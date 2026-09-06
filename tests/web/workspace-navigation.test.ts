// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";
import type { ObserveConversation } from "../../src/web/ConversationObserver.ts";
import { App } from "../../src/web/App.tsx";
import { CreateWorldScreen } from "../../src/web/CreateWorldScreen.tsx";

afterEach(cleanup);

function fixture() {
  const packages = [
    { localId: "first", title: "第一份内容", status: "usable" as const },
    { localId: "chosen", title: "当前创作", status: "usable" as const },
  ];
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    await Promise.resolve();
    if (input.type === "workspace.read") {
      return {
        preferences: { locale: "zh-CN" },
        contentPackages: packages,
        worlds: [],
        storageNotices: [],
        playPresets: { currentPresetId: "", presets: [] },
        model: {
          configured: true,
          activeConnectionId: "model",
          presets: [],
          connections: [
            {
              id: "model",
              name: "本地主持",
              provider: "chat_completions",
              presetId: "custom",
              dialect: "standard",
              baseUrl: "http://localhost:1/v1",
              hasApiKey: true,
              reasoningEffort: "provider_default",
              reasoningSummary: "provider_default",
              thinkingMode: "provider_default",
              thinkingBudgetTokens: null,
              modelId: "test",
              contextWindowTokens: 128000,
              maxOutputTokens: 16000,
            },
          ],
        },
      };
    }
    if (input.type === "content.read") {
      return {
        ...packages.find((p) => p.localId === input.packageId),
        files: [{ path: "opening.md", contents: "已保存开场" }],
        issues: [],
      };
    }
    if (input.type === "setting-improvement.overview") {
      return { latest: null, history: [] };
    }
    if (input.type === "content.scripts.read") {
      return { entries: [], enabled: false };
    }
    if (input.type === "world.create") {
      throw new Error("创建失败，供重试测试");
    }
    throw new Error(`Unexpected request: ${input.type}`);
  });
  const observeConversation: ObserveConversation = (_target, receive) => {
    let active = true;
    queueMicrotask(() => {
      if (active)
        void receive(
          { kind: "setting", value: { revision: "1", selected: null } },
          true,
        );
    });
    return () => {
      active = false;
    };
  };
  const client = {
    request,
    observeConversation,
  } as unknown as RuntimeClient;
  return { client, request };
}

test("顶栏不选择任意世界，快捷创建使用当前编辑的内容包，失败后可重试", async () => {
  const { client, request } = fixture();
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  expect(
    within(screen.getByRole("navigation", { name: "工作区导航" })).queryByRole(
      "button",
      { name: "游玩" },
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开内容包：当前创作" }));
  await screen.findByRole("heading", { name: "当前创作 · AI 设定完善" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "创建世界" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  const create = screen.getByRole("button", { name: "创建世界" });
  fireEvent.click(create);
  fireEvent.click(create);
  await screen.findByText("创建失败，供重试测试");
  const creates = () =>
    request.mock.calls.map(([r]) => r).filter((r) => r.type === "world.create");
  expect(creates()).toHaveLength(1);
  expect(creates()[0]).toMatchObject({
    type: "world.create",
    packageId: "chosen",
    model: { modelId: "test" },
  });
  await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
  fireEvent.click(create);
  await waitFor(() => expect(creates()).toHaveLength(2));
});

test("文件草稿阻止全局导航与快捷创建，放弃草稿后恢复", async () => {
  const { client, request } = fixture();
  render(createElement(App, { client }));
  fireEvent.click(
    await screen.findByRole("button", { name: "打开内容包：当前创作" }),
  );
  await screen.findByRole("heading", { name: "当前创作 · AI 设定完善" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "创建世界" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "设定完善工具" })).getByRole(
      "button",
      { name: "编辑" },
    ),
  );
  fireEvent.change(screen.getByLabelText("编辑 opening.md"), {
    target: { value: "尚未保存" },
  });
  expect(
    screen.getByRole("button", { name: "创建世界" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "返回工作区" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByLabelText("界面语言").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "创建世界" }));
  expect(request.mock.calls.some(([r]) => r.type === "world.create")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "放弃未保存修改" }));
  expect(
    screen.getByRole("button", { name: "创建世界" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("切换创建来源时迟到的开场读取不能替换当前预览", async () => {
  let resolveFirst: (value: unknown) => void = () => undefined;
  const request = vi.fn((r: V1Request) =>
    r.type === "content.read" && r.packageId === "first"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve({
          files: [{ path: "opening.md", contents: "当前开场" }],
        }),
  );
  const props = {
    client: { request } as unknown as RuntimeClient,
    packages: [
      { localId: "first", title: "第一份", status: "usable" as const },
      { localId: "second", title: "第二份", status: "usable" as const },
    ],
    selectedId: "first",
    pending: false,
    modelConfigured: true,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onConfigureModel: vi.fn(),
  };
  const view = render(createElement(CreateWorldScreen, props));
  view.rerender(
    createElement(CreateWorldScreen, { ...props, selectedId: "second" }),
  );
  await screen.findByText("当前开场");
  await act(async () => {
    resolveFirst({ files: [{ path: "opening.md", contents: "迟到的开场" }] });
    await Promise.resolve();
  });
  expect(screen.queryByText("迟到的开场")).toBeNull();
  expect(screen.getByText("当前开场")).toBeTruthy();
  view.rerender(
    createElement(CreateWorldScreen, {
      ...props,
      selectedId: "second",
      packages: props.packages.map((p) => ({
        ...p,
        status: "needs_repair" as const,
      })),
    }),
  );
  expect(
    screen
      .getByRole("button", { name: "从当前内容包创建" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("迟到的内容包读取不会卸载刚产生模型草稿的页面", async () => {
  const { client, request } = fixture();
  let finish: (value: unknown) => void = () => undefined;
  const original = request.getMockImplementation()!;
  request.mockImplementation((input) =>
    input.type === "content.read"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(input),
  );
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
      "button",
      { name: "内容编辑" },
    ),
  );
  fireEvent.change(screen.getByLabelText("配置名称"), {
    target: { value: "新的未保存名称" },
  });
  await act(async () => {
    finish({
      localId: "first",
      title: "第一份内容",
      status: "usable",
      files: [],
      issues: [],
    });
    await Promise.resolve();
  });
  expect(screen.getByLabelText<HTMLInputElement>("配置名称").value).toBe(
    "新的未保存名称",
  );
  expect(
    screen.queryByRole("heading", { name: "第一份内容 · AI 设定完善" }),
  ).toBeNull();
});

test("创建页重新核验所选包的运行状态，避免使用其他标签页的中间结果", async () => {
  const { client, request } = fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementation((input) =>
    input.type === "setting-improvement.overview"
      ? Promise.resolve({
          latest: { runStatus: "ready" },
          history: [{ runStatus: "running" }],
        })
      : original(input),
  );
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
      "button",
      { name: "新建世界" },
    ),
  );
  fireEvent.change(screen.getByLabelText("创建世界的内容包"), {
    target: { value: "chosen" },
  });
  fireEvent.click(screen.getByRole("button", { name: "从当前内容包创建" }));
  await screen.findByText("这份内容包正在完善，请在回复完成后创建世界。");
  expect(request).toHaveBeenCalledWith({
    type: "setting-improvement.overview",
    packageId: "chosen",
  });
  expect(request.mock.calls.some(([r]) => r.type === "world.create")).toBe(
    false,
  );
});
