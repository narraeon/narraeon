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
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { PlayPresetScreenPreset } from "../../src/web/PlayPresetScreen.tsx";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { defaultOrderedPlayPrompts } from "../../src/shared/ordered-play-prompts.ts";
import { defaultOrderedAuthorPrompts } from "../../src/shared/ordered-author-prompts.ts";

afterEach(cleanup);

function delayedPresetCopyFixture() {
  const { client, request } = fixture();
  const original = request.getMockImplementation()!;
  const base: PlayPresetScreenPreset = {
    id: "preset-first",
    name: "第一份预设",
    revision: "rev-original",
    files: structuredClone(firstPartyActionChoicesPresetFiles),
    validation: { status: "valid" },
  };
  const other = { ...base, id: "preset-other", name: "第二份预设" };
  const copied = { ...base, id: "preset-copy", name: "复制的预设" };
  let library = { currentPresetId: base.id, presets: [base, other] };
  let finishRead: (value: typeof library) => void = () => undefined;
  request.mockImplementation(async (input) => {
    if (input.type === "workspace.read")
      return { ...((await original(input)) as object), playPresets: library };
    if (input.type === "play.copy") {
      library = { ...library, presets: [...library.presets, copied] };
      return { preset: copied };
    }
    if (input.type === "play.read")
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    return original(input);
  });
  return {
    client,
    request,
    finishRead: () => finishRead(library),
    firstId: base.id,
    otherId: other.id,
    copyId: copied.id,
  };
}

test.each(["model-draft", "reopened-presets"])(
  "离开预设页面后迟到的复制读取不能导航或覆盖当前选择：%s",
  async (destination) => {
    const scenario = delayedPresetCopyFixture();
    render(createElement(App, { client: scenario.client }));
    await screen.findByRole("heading", { name: "世界工作区" });
    const presets = () =>
      within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
        "button",
        { name: "预设" },
      );
    fireEvent.click(presets());
    expect(window.location.hash).toBe(`#/presets/${scenario.firstId}`);
    fireEvent.click(screen.getByText("预设操作", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "复制为新预设" }));
    await waitFor(() =>
      expect(scenario.request).toHaveBeenCalledWith({ type: "play.read" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
    if (destination === "model-draft") {
      fireEvent.change(screen.getByLabelText("配置名称"), {
        target: { value: "新的模型草稿" },
      });
    } else {
      fireEvent.click(presets());
      fireEvent.change(screen.getByLabelText("切换预设"), {
        target: { value: scenario.otherId },
      });
    }
    const address = window.location.hash;
    const historyLength = window.history.length;
    await act(async () => {
      scenario.finishRead();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe(address);
    expect(window.history.length).toBe(historyLength);
    if (destination === "model-draft") {
      expect(screen.getByLabelText<HTMLInputElement>("配置名称").value).toBe(
        "新的模型草稿",
      );
      expect(screen.queryByRole("heading", { name: "玩法预设" })).toBeNull();
    } else {
      expect(screen.getByLabelText<HTMLSelectElement>("切换预设").value).toBe(
        scenario.otherId,
      );
      expect(window.location.hash).toBe(`#/presets/${scenario.otherId}`);
    }
  },
);

test("当前预设页面的选择和有效复制回调仍替换 URL", async () => {
  const scenario = delayedPresetCopyFixture();
  render(createElement(App, { client: scenario.client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
      "button",
      { name: "预设" },
    ),
  );
  const historyLength = window.history.length;
  fireEvent.change(screen.getByLabelText("切换预设"), {
    target: { value: scenario.otherId },
  });
  expect(window.location.hash).toBe(`#/presets/${scenario.otherId}`);
  expect(window.history.length).toBe(historyLength);
  fireEvent.click(screen.getByText("预设操作", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "复制为新预设" }));
  await waitFor(() =>
    expect(scenario.request).toHaveBeenCalledWith({ type: "play.read" }),
  );
  await act(async () => {
    scenario.finishRead();
    await Promise.resolve();
  });
  expect(screen.getByLabelText<HTMLSelectElement>("切换预设").value).toBe(
    scenario.copyId,
  );
  expect(window.location.hash).toBe(`#/presets/${scenario.copyId}`);
  expect(window.history.length).toBe(historyLength);
  expect(screen.getByText("已复制为独立预设。")).toBeTruthy();
});

test("启动恢复指定内容包，读取地址不会创建新的内容包", async () => {
  window.history.replaceState(null, "", "#/content/chosen");
  const { client, request } = fixture();
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "当前创作 · AI 设定完善" });
  expect(window.location.hash).toBe("#/content/chosen");
  expect(request.mock.calls.some(([r]) => r.type === "content.create")).toBe(
    false,
  );
});

test.each([
  ["#/content", "找不到该内容包。"],
  ["#/content/deleted", "找不到该内容包。"],
  ["#/content/%E0%A4%A", "找不到该内容包。"],
  ["#/world/deleted", "找不到该世界。"],
  ["#/presets/deleted", "找不到该预设。"],
  ["#/unknown", "找不到该页面。"],
])("无效书签 %s 返回首页并显示通知", async (hash, message) => {
  window.history.replaceState(null, "", hash);
  const { client, request } = fixture();
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  expect(screen.getByText(message)).toBeTruthy();
  expect(window.location.hash).toBe("#/");
  expect(request.mock.calls.some(([r]) => r.type === "content.create")).toBe(
    false,
  );
});

test("后退立即恢复地址并保留模型草稿", async () => {
  const { client, request } = fixture();
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
  expect(window.location.hash).toBe("#/models");
  fireEvent.change(screen.getByLabelText("配置名称"), {
    target: { value: "未保存的模型名称" },
  });
  const calls = request.mock.calls.length;
  window.history.replaceState(null, "", "#/");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(window.location.hash).toBe("#/models");
  expect(
    screen.getByText("已保留当前页面的未保存修改，请保存或放弃后再切换。"),
  ).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("配置名称").value).toBe(
    "未保存的模型名称",
  );
  expect(request.mock.calls.length).toBe(calls);
});

test("世界创建进行中时后退保持来源页面和地址", async () => {
  window.history.replaceState(null, "", "#/create");
  const { client, request } = fixture();
  const original = request.getMockImplementation()!;
  let rejectCreation: (error: Error) => void = () => undefined;
  request.mockImplementation((r) =>
    r.type === "world.create"
      ? new Promise((_resolve, reject) => {
          rejectCreation = reject;
        })
      : original(r),
  );
  render(createElement(App, { client }));
  fireEvent.click(
    await screen.findByRole("button", { name: "从当前内容包创建" }),
  );
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "world.create")).toBe(
      true,
    ),
  );
  window.history.replaceState(null, "", "#/");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(window.location.hash).toBe("#/create");
  expect(
    screen.getByText("已保留当前页面的未保存修改，请保存或放弃后再切换。"),
  ).toBeTruthy();
  await act(async () => {
    rejectCreation(new Error("已结束创建测试"));
    await Promise.resolve();
  });
  await screen.findByText("已结束创建测试");
});

test("较晚的内容读取不能覆盖更新的浏览器地址", async () => {
  const { client, request } = fixture();
  const original = request.getMockImplementation()!;
  let finish: (value: unknown) => void = () => undefined;
  request.mockImplementation((r) =>
    r.type === "content.read"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(r),
  );
  render(createElement(App, { client }));
  await screen.findByRole("heading", { name: "世界工作区" });
  window.history.replaceState(null, "", "#/content/chosen");
  fireEvent(window, new PopStateEvent("popstate"));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      type: "content.read",
      packageId: "chosen",
    }),
  );
  window.history.replaceState(null, "", "#/models");
  fireEvent(window, new PopStateEvent("popstate"));
  await screen.findByLabelText("配置名称");
  await act(async () => {
    finish({ localId: "chosen", files: [], issues: [] });
    await Promise.resolve();
  });
  expect(window.location.hash).toBe("#/models");
  expect(
    screen.queryByRole("heading", { name: "当前创作 · AI 设定完善" }),
  ).toBeNull();
});

test.each(["model", "preset"])(
  "模型切换与预设删除提示可以各自关闭（先关闭 %s）",
  async (first) => {
    const { client, request } = fixture();
    const original = request.getMockImplementation()!;
    const initial = (await original({ type: "workspace.read" })) as {
      model: ModelConnectionLibraryView;
    };
    let model = {
      ...initial.model,
      connections: [
        ...initial.model.connections,
        { ...initial.model.connections[0]!, id: "other", name: "另一配置" },
      ],
    };
    const preset: PlayPresetScreenPreset = {
      id: "preset",
      name: "工作台",
      revision: "rev-original",
      files: structuredClone(firstPartyActionChoicesPresetFiles),
      validation: { status: "valid" },
      scriptsEnabled: false,
      structure: {
        name: "workbench",
        callChainPath: "call-chain.yaml",
        mounts: [],
        playerViewPanels: [],
        extensionRefs: [],
        narrativePrompts: [],
        followups: [],
        playPrompts: defaultOrderedPlayPrompts(),
        authorPrompts: defaultOrderedAuthorPrompts(),
      },
    };
    let presets = [preset];
    const library = () => ({ currentPresetId: presets[0]!.id, presets });
    request.mockImplementation(async (input) => {
      if (input.type === "workspace.read")
        return { ...initial, model, playPresets: library() };
      if (input.type === "model.select") {
        model = { ...model, activeConnectionId: input.connectionId };
        return model;
      }
      if (input.type === "play.delete") {
        presets = [{ ...preset, id: "default", name: "默认预设" }];
        return {};
      }
      if (input.type === "play.read") return library();
      return original(input);
    });
    render(createElement(App, { client }));
    await screen.findByRole("heading", { name: "世界工作区" });
    fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
    fireEvent.click(screen.getByRole("button", { name: "切换到此配置" }));
    const messages = {
      model: "已切换当前模型配置；Runtime 不会自动故障转移。",
      preset: "玩法预设已删除；删空后会自动重建默认预设。",
    };
    await screen.findByText(messages.model);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "工作区导航" })).getByRole(
        "button",
        { name: "预设" },
      ),
    );
    fireEvent.click(screen.getByText("预设操作", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "删除预设" }));
    await screen.findByText(messages.preset);
    const callsBeforeClosing = request.mock.calls.length;
    const order = first === "model" ? ["model", "preset"] : ["preset", "model"];
    for (const key of order) {
      const text = messages[key as keyof typeof messages];
      const notice = screen.getByText(text).closest('[role="status"]')!;
      fireEvent.click(
        within(notice as HTMLElement).getByRole("button", { name: "关闭提示" }),
      );
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(document.querySelector(".workspace-feedback")).toBeNull();
    expect(document.querySelector(".play-preset-feedback")).toBeNull();
    expect(request.mock.calls).toHaveLength(callsBeforeClosing);
    expect(screen.getByLabelText("切换预设")).toHaveProperty(
      "value",
      "default",
    );
    expect(model.activeConnectionId).toBe("other");
  },
);

function fixture() {
  const packages = [
    {
      localId: "first",
      title: "第一份内容",
      status: "usable" as const,
      gameplay: { mode: "interactive-fiction" as const },
    },
    {
      localId: "chosen",
      title: "当前创作",
      status: "usable" as const,
      gameplay: { mode: "interactive-fiction" as const },
    },
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
    r.type === "protagonist-templates.read"
      ? Promise.resolve({ templates: [] })
      : r.type === "content.read" && r.packageId === "first"
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
      {
        localId: "first",
        title: "第一份",
        status: "usable" as const,
        gameplay: { mode: "interactive-fiction" as const },
      },
      {
        localId: "second",
        title: "第二份",
        status: "usable" as const,
        gameplay: { mode: "interactive-fiction" as const },
      },
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
        gameplay: { mode: "interactive-fiction" as const },
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
      gameplay: { mode: "interactive-fiction" as const },
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
