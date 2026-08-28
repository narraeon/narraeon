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
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  V1PlayCallChainStreamFrame,
  V1PlayCallChainView,
  V1Request,
} from "../../src/protocol/v1.ts";
import { projectUncoveredPlayerViews } from "../../src/web/PlayerViewFallback.ts";
import { WorldPage } from "../../src/web/WorldPage.tsx";

afterEach(() => cleanup());

describe("世界游玩页面", () => {
  test("只由 exact source view 的 panel 承接 fallback，其余 view 与 diagnostics 仍显示", () => {
    const fallback = projectUncoveredPlayerViews(
      {
        views: [
          { id: "status", title: "状态", items: [] },
          { id: "inventory", title: "物品", items: [] },
        ],
        diagnostics: [
          {
            code: "unresolved_selector",
            viewId: "status",
            itemId: "missing-status",
            message: "状态缺失",
          },
          {
            code: "unresolved_selector",
            viewId: "inventory",
            itemId: "missing-inventory",
            message: "物品缺失",
          },
          { code: "invalid_control", message: "全局控制诊断" },
        ],
      },
      [{ source: { kind: "player_view", viewId: "status" } }],
    );
    expect(fallback.views.map(({ id }) => id)).toEqual(["inventory"]);
    expect(fallback.diagnostics.map(({ message }) => message)).toEqual([
      "物品缺失",
      "全局控制诊断",
    ]);
  });

  test("没有调用链时显示已提交叙事和玩家视图，技术表面收进独立页面", async () => {
    const client = readOnlyClient();

    renderWorld(client);

    expect(
      await screen.findByRole("heading", { name: "宿舍世界" }),
    ).toBeTruthy();
    expect(screen.getByText("我问几点训练。")).toBeTruthy();
    expect(screen.getByText("秦龙说晚上八点。")).toBeTruthy();
    expect(screen.getByText("白色运动背心")).toBeTruthy();
    expect(screen.queryByText(/file_native_genesis/u)).toBeNull();
    expect(screen.getByRole("button", { name: "全新上下文" })).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加上下文" })
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "当前文档" }));
    expect(screen.getByRole("heading", { name: "宿舍里的夜晚" })).toBeTruthy();
    expect(screen.getByText(/情况: 秦龙正在整理球衣/u)).toBeTruthy();
  });

  test("在世界管理页修改正在游玩的世界名称", async () => {
    const onRenameWorld = vi.fn(() => Promise.resolve());
    renderWorld(readOnlyClient(), undefined, { onRenameWorld });
    await screen.findByRole("heading", { name: "宿舍世界" });

    fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
    fireEvent.change(screen.getByLabelText("世界显示名称"), {
      target: { value: "  雾港第二夜  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));

    await waitFor(() =>
      expect(onRenameWorld).toHaveBeenCalledWith("雾港第二夜"),
    );
    expect(await screen.findByText("世界名称已保存。")).toBeTruthy();
  });

  test("全新上下文启动生产调用链并显示玩家、AI、工具与已提交变化", async () => {
    let chain: V1PlayCallChainView | null = null;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.start") {
          chain = playChainView(
            request.chainId,
            request.exchangeId,
            request.playerText,
          );
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error("意外请求：" + request.type));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "我示意秦龙开门。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(await screen.findByText("秦龙推开门，让你先走。")).toBeTruthy();
    expect(
      screen.getByText("宿舍门在你身后合上，秦龙等你先开口。"),
    ).toBeTruthy();
    expect(screen.getByText("秦龙说晚上八点。")).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "全新上下文从这里开始" }),
    ).toBeTruthy();
    expect(screen.getAllByText("我示意秦龙开门。")).toHaveLength(1);
    expect(screen.getByText("调用 world_patch")).toBeTruthy();
    expect(screen.getByText("world_patch 返回")).toBeTruthy();
    expect(screen.getByText("调用 world_patch").closest("details")?.open).toBe(
      false,
    );
    expect(screen.getByText("world_patch 返回").closest("details")?.open).toBe(
      false,
    );
    expect(screen.getByText("本上下文已提交的世界变化")).toBeTruthy();
    expect(screen.getByText(/更新 @current-situation/u)).toBeTruthy();
    expect(screen.queryByText(/实验|开放调用链|不会提交真实世界/u)).toBeNull();

    const start = client.request.mock.calls
      .map(([request]) => request)
      .find(
        (
          request,
        ): request is Extract<V1Request, { type: "play.chain.start" }> =>
          request.type === "play.chain.start",
      );
    expect(start).toMatchObject({
      worldId: "world-one",
      playerText: "我示意秦龙开门。",
    });
    expect(start?.chainId).toMatch(/^play-chain-/u);
    expect(start?.exchangeId).toMatch(/^play-exchange-/u);
  });

  test("再次全新上下文后仍按分隔符显示此前思维链和工具记录", async () => {
    let chain = playChainView(
      "play-chain-old",
      "exchange-old",
      "旧上下文玩家输入。",
    );
    chain = {
      ...chain,
      events: chain.events.map((event) =>
        event.kind === "assistant"
          ? {
              ...event,
              text: "旧上下文的可见叙事。",
              reasoning: "旧上下文思维链，应继续显示。",
            }
          : event.kind === "tool_call" || event.kind === "tool_result"
            ? { ...event, name: "context_search" }
            : event,
      ),
    };
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.start") {
          const previous = structuredClone(chain);
          chain = {
            ...playChainView(
              request.chainId,
              request.exchangeId,
              request.playerText,
            ),
            baselineHead: previous.parentHead,
            baselineHistoryLength: 5,
            previousContexts: [previous],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
    };

    renderWorld(client);
    expect(
      await screen.findByText("旧上下文思维链，应继续显示。"),
    ).toBeTruthy();
    expect(screen.getByText("调用 context_search")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "从新上下文继续。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(await screen.findByText("秦龙推开门，让你先走。")).toBeTruthy();
    expect(screen.getByText("旧上下文思维链，应继续显示。")).toBeTruthy();
    expect(screen.getByText("调用 context_search")).toBeTruthy();
    expect(screen.getAllByText("旧上下文玩家输入。")).toHaveLength(1);
    expect(screen.getAllByText("旧上下文的可见叙事。")).toHaveLength(1);
    expect(screen.getAllByText("从新上下文继续。")).toHaveLength(1);
    expect(
      screen.getAllByRole("separator", {
        name: "全新上下文从这里开始",
      }),
    ).toHaveLength(2);
  });

  test("没有既有上下文时点击追加会自动从当前世界开始", async () => {
    let chain: V1PlayCallChainView | null = null;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.start") {
          chain = playChainView(
            request.chainId,
            request.exchangeId,
            request.playerText,
          );
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "我推开宿舍门。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    await screen.findByText("秦龙推开门，让你先走。");
    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "play.chain.start",
      ),
    ).toBe(true);
    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "play.chain.append",
      ),
    ).toBe(false);
  });

  test("浏览器直接消费模型文本流，在最终响应完成前逐段显示", async () => {
    let chain: V1PlayCallChainView | null = null;
    let finishStream: (() => void) | undefined;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
      async streamPlayCallChain(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        chain = {
          ...playChainView(
            request.chainId,
            request.exchangeId,
            request.playerText,
          ),
          status: "running",
          events: [
            {
              id: 1,
              kind: "player",
              exchangeId: request.exchangeId,
              text: request.playerText,
              context: "fresh",
              committedHead: "commit:2",
            },
            {
              id: 2,
              kind: "assistant",
              text: "",
              status: "streaming",
              exchange: 1,
              attempt: 1,
            },
          ],
        };
        onFrame({ kind: "snapshot", value: chain, final: false });
        onFrame({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "reasoning",
          text: "先确认门口没有障碍。",
          updatedAt: 2,
        });
        onFrame({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "text",
          text: "秦龙正在推门",
          updatedAt: 2,
        });
        await new Promise<void>((resolve) => {
          finishStream = resolve;
        });
        chain = playChainView(
          request.chainId,
          request.exchangeId,
          request.playerText,
        );
        onFrame({ kind: "snapshot", value: chain, final: true });
        return chain;
      },
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "我示意秦龙开门。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(await screen.findByText("秦龙正在推门")).toBeTruthy();
    expect(screen.getByText("接收中 · 第 1 次派发")).toBeTruthy();
    const reasoning = screen
      .getByText("模型思维链")
      .closest<HTMLDetailsElement>("details");
    expect(reasoning?.open).toBe(false);
    expect(screen.getByText("先确认门口没有障碍。")).toBeTruthy();
    act(() => finishStream?.());
    expect(await screen.findByText("秦龙推开门，让你先走。")).toBeTruthy();
  });

  test("模型流式输出只更新内容，不反复把页面定位到底部", async () => {
    const scrollDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    let emitFrame: ((frame: V1PlayCallChainStreamFrame) => void) | undefined;
    let finishStream: (() => void) | undefined;
    let chain: V1PlayCallChainView | null = null;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
      async streamPlayCallChain(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        chain = {
          ...playChainView(
            request.chainId,
            request.exchangeId,
            request.playerText,
          ),
          status: "running",
          events: [
            {
              id: 1,
              kind: "player",
              exchangeId: request.exchangeId,
              text: request.playerText,
              context: "fresh",
              committedHead: "commit:2",
            },
            {
              id: 2,
              kind: "assistant",
              text: "",
              status: "streaming",
              exchange: 1,
              attempt: 1,
            },
          ],
        };
        onFrame({ kind: "snapshot", value: chain, final: false });
        emitFrame = onFrame;
        await new Promise<void>((resolve) => {
          finishStream = resolve;
        });
        chain = playChainView(
          request.chainId,
          request.exchangeId,
          request.playerText,
        );
        onFrame({ kind: "snapshot", value: chain, final: true });
        return chain;
      },
    };

    try {
      renderWorld(client);
      await screen.findByRole("heading", { name: "宿舍世界" });
      scrollIntoView.mockClear();
      fireEvent.change(screen.getByLabelText("你的行动"), {
        target: { value: "我示意秦龙开门。" },
      });
      fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));
      await waitFor(() => expect(emitFrame).toBeTypeOf("function"));
      expect(screen.getByText("模型响应中")).toBeTruthy();
      scrollIntoView.mockClear();

      act(() =>
        emitFrame?.({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "text",
          text: "秦龙正在推门",
          updatedAt: 2,
        }),
      );

      expect(screen.getByText("秦龙正在推门")).toBeTruthy();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        finishStream?.();
        await Promise.resolve();
      });
      cleanup();
      if (scrollDescriptor === undefined)
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      else
        Object.defineProperty(
          Element.prototype,
          "scrollIntoView",
          scrollDescriptor,
        );
    }
  });

  test("追加上下文只发送一条新的玩家输入并接到现有调用链", async () => {
    let chain = playChainView(
      "play-chain-existing",
      "exchange-first",
      "我示意秦龙开门。",
    );
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.append") {
          chain = {
            ...chain,
            events: [
              ...chain.events,
              {
                id: 6,
                kind: "player",
                exchangeId: request.exchangeId,
                text: request.playerText,
                context: "append",
                committedHead: "commit:4",
              },
              {
                id: 7,
                kind: "assistant",
                text: "走廊里的灯依次亮起。",
                status: "completed",
                exchange: 3,
                attempt: 1,
                committedHead: "commit:5",
              },
            ],
            parentHead: "commit:5",
            updatedAt: 2,
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("秦龙推开门，让你先走。");
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "我走进走廊。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    expect(await screen.findByText("走廊里的灯依次亮起。")).toBeTruthy();
    const append = client.request.mock.calls
      .map(([request]) => request)
      .find(
        (
          request,
        ): request is Extract<V1Request, { type: "play.chain.append" }> =>
          request.type === "play.chain.append",
      );
    expect(append).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-existing",
      playerText: "我走进走廊。",
    });
    expect(append?.exchangeId).toMatch(/^play-exchange-/u);
  });

  test("中断后留空点击追加只发送原上下文，不产生另一条玩家指令或重试事件", async () => {
    let chain = interruptedChainView();
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.append") {
          chain = {
            ...chain,
            status: "ready",
            canRetry: false,
            parentHead: "commit:3",
            lastFailure: null,
            events: [
              ...chain.events,
              {
                id: 4,
                kind: "assistant",
                text: "秦龙把门完全推开。",
                status: "completed",
                exchange: 1,
                attempt: 2,
                committedHead: "commit:3",
              },
            ],
            updatedAt: 2,
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
    };

    renderWorld(client);
    expect(await screen.findByText("秦龙刚把门推开一半")).toBeTruthy();
    expect(screen.getByText(/保持输入框为空并点击“追加上下文”/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    expect(await screen.findByText("秦龙把门完全推开。")).toBeTruthy();
    expect(screen.getAllByText("我示意秦龙开门。")).toHaveLength(1);
    const continuation = client.request.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === "play.chain.append");
    expect(continuation).toMatchObject({
      type: "play.chain.append",
      worldId: "world-one",
      chainId: "play-chain-interrupted",
      playerText: "",
    });
    expect(screen.queryByText(/原样重发第/u)).toBeNull();
  });

  test("派生到玩家节点后可以留空追加，让模型直接重新生成", async () => {
    let chain: V1PlayCallChainView = {
      ...playChainView(
        "play-chain-derived-player",
        "exchange-derived-player",
        "我示意秦龙开门。",
      ),
      worldId: "world-one",
      baselineHead: "genesis",
      baselineHistoryLength: 3,
      parentHead: "commit:1",
      events: [
        {
          id: 1,
          kind: "player",
          exchangeId: "exchange-derived-player",
          text: "我示意秦龙开门。",
          context: "fresh",
          committedHead: "commit:1",
        },
      ],
      changedDocuments: [],
    };
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.append") {
          chain = {
            ...chain,
            parentHead: "commit:2",
            events: [
              ...chain.events,
              {
                id: 2,
                kind: "assistant",
                text: "秦龙重新考虑后，直接拉开了门。",
                status: "completed",
                exchange: 1,
                attempt: 1,
                committedHead: "commit:2",
              },
            ],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`意外请求：${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("我示意秦龙开门。");
    const copiedPlayerMessage = screen
      .getByText("我示意秦龙开门。")
      .closest<HTMLElement>(".call-chain-player")!;
    expect(
      within(copiedPlayerMessage).getByRole("button", { name: "修改" }),
    ).toBeTruthy();
    expect(
      within(copiedPlayerMessage).getByRole("button", {
        name: "创建分叉",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("宿舍门在你身后合上，秦龙等你先开口。"),
    ).toBeTruthy();
    expect(screen.getAllByText("我示意秦龙开门。")).toHaveLength(1);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "全新上下文" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加上下文" })
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    expect(
      await screen.findByText("秦龙重新考虑后，直接拉开了门。"),
    ).toBeTruthy();
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.append"),
    ).toMatchObject({
      type: "play.chain.append",
      chainId: "play-chain-derived-player",
      playerText: "",
    });
  });

  test("可以从调用链任意已提交消息节点创建分叉", async () => {
    const chain = playChainView(
      "play-chain-existing",
      "exchange-first",
      "我示意秦龙开门。",
    );
    const onOpenWorld = vi.fn((openedWorldId: string) => {
      void openedWorldId;
      return Promise.resolve();
    });
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "world.derive")
          return Promise.resolve({ world: { worldId: "world-branch" } } as T);
        return Promise.resolve(chain as T);
      }),
    };

    renderWorld(client, onOpenWorld);
    await screen.findByText("秦龙推开门，让你先走。");
    fireEvent.click(
      within(screen.getByLabelText("模型调用链")).getAllByRole("button", {
        name: "创建分叉",
      })[0]!,
    );

    await waitFor(() =>
      expect(onOpenWorld).toHaveBeenCalledWith("world-branch"),
    );
    const derive = client.request.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === "world.derive");
    expect(derive).toMatchObject({
      sourceWorldId: "world-one",
      sourceHead: "commit:2",
    });
  });

  test("修改历史玩家提交会留在当前世界，并从修改稿自动继续", async () => {
    let chain = playChainView(
      "play-chain-existing",
      "exchange-first",
      "我示意秦龙开门。",
    );
    const onOpenWorld = vi.fn(() => Promise.resolve());
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.revise-player") {
          chain = {
            ...chain,
            chainId: "play-chain-revised",
            parentHead: "commit:4",
            events: [
              {
                id: request.eventId,
                kind: "player",
                exchangeId: request.replacementExchangeId,
                text: request.replacementText,
                context: "fresh",
                committedHead: "commit:4",
              },
            ],
            changedDocuments: [],
          };
          return Promise.resolve({
            outcome: "revised",
            worldId: "world-one",
            playCallChain: chain,
          } as T);
        }
        if (request.type === "play.chain.append") {
          chain = {
            ...chain,
            parentHead: "commit:5",
            events: [
              ...chain.events,
              {
                id: 2,
                kind: "assistant",
                text: "秦龙停下动作，等你重新决定。",
                status: "completed",
                exchange: 2,
                attempt: 1,
                committedHead: "commit:5",
              },
            ],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error("意外请求：" + request.type));
      }),
    };

    renderWorld(client, onOpenWorld);
    await screen.findByText("我示意秦龙开门。");
    const playerMessage = screen
      .getByText("我示意秦龙开门。")
      .closest<HTMLElement>(".call-chain-player")!;
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "修改" }),
    );
    const editor = within(playerMessage).getByLabelText("修改后的行动");
    expect((editor as HTMLTextAreaElement).value).toBe("我示意秦龙开门。");
    fireEvent.change(editor, {
      target: { value: "我请秦龙先别开门。" },
    });
    fireEvent.click(
      within(playerMessage).getByRole("button", {
        name: "保存修改并继续",
      }),
    );

    expect(
      await screen.findByText("秦龙停下动作，等你重新决定。"),
    ).toBeTruthy();
    expect(onOpenWorld).not.toHaveBeenCalled();
    expect(screen.getByText("我请秦龙先别开门。")).toBeTruthy();
    expect(screen.queryByText("我示意秦龙开门。")).toBeNull();
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.revise-player"),
    ).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-existing",
      eventId: 1,
      replacementText: "我请秦龙先别开门。",
    });
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.append"),
    ).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-revised",
      playerText: "",
    });
  });
});

function renderWorld(
  client: {
    request(request: V1Request): Promise<unknown>;
  },
  onOpenWorld: (worldId: string) => Promise<void> = vi.fn(() =>
    Promise.resolve(),
  ),
  options: {
    onRenameWorld?: (name: string) => Promise<void>;
  } = {},
) {
  return render(
    createElement(WorldPage, {
      client,
      worldId: "world-one",
      worldTitle: "宿舍世界",
      modelConfigured: true,
      onBack: vi.fn(),
      onConfigureModel: vi.fn(),
      onRenameWorld: options.onRenameWorld ?? vi.fn(() => Promise.resolve()),
      onOpenWorld,
      ...options,
    }),
  );
}

function readOnlyClient() {
  return {
    request: vi.fn(<T>(request: V1Request) =>
      request.type === "artifacts.debug"
        ? Promise.resolve([] as T)
        : Promise.resolve(worldView(null) as T),
    ),
  };
}

function worldView(playCallChain: V1PlayCallChainView | null) {
  const committedMessages = [
    {
      role: "narrator" as const,
      exactText: "宿舍门在你身后合上，秦龙等你先开口。",
      head: "genesis",
    },
    {
      role: "player" as const,
      exactText: "我问几点训练。",
      head: "commit:0",
    },
    {
      role: "narrator" as const,
      exactText: "秦龙说晚上八点。",
      head: "commit:1",
    },
    ...committedChainMessages(playCallChain),
  ];
  return {
    worldId: "world-one",
    head: playCallChain?.parentHead ?? "commit:1",
    state: [
      {
        path: "current-situation.yaml",
        contents:
          "$document:\n  id: situation.current\n  ref: current-situation\n  title: 宿舍里的夜晚\n  summary: 宿舍里的当前局面。\n  aliases: []\n情况: 秦龙正在整理球衣\n",
      },
    ],
    control: [
      {
        path: "player-views.yaml",
        contents: "format: narraeon.player-views/v1\n",
      },
    ],
    history: [],
    runtime: { type: "file_native_genesis" },
    playerViews: {
      views: [
        {
          id: "status",
          title: "当前状态",
          items: [{ id: "clothes", label: "衣着", value: "白色运动背心" }],
        },
      ],
      diagnostics: [],
    },
    artifacts: [],
    extensions: [],
    committedMessages,
    playCallChain,
  };
}

function committedChainMessages(
  playCallChain: V1PlayCallChainView | null,
): { role: "player" | "narrator"; exactText: string; head: string }[] {
  if (playCallChain === null) return [];
  const messages: {
    role: "player" | "narrator";
    exactText: string;
    head: string;
  }[] = [];
  for (const context of [...playCallChain.previousContexts, playCallChain])
    for (const event of context.events) {
      if (event.kind === "player" && event.committedHead !== undefined)
        messages.push({
          role: "player",
          exactText: event.text,
          head: event.committedHead,
        });
      if (
        event.kind === "assistant" &&
        event.committedHead !== undefined &&
        event.text.trim().length > 0
      )
        messages.push({
          role: "narrator",
          exactText: event.text,
          head: event.committedHead,
        });
    }
  return messages;
}

function playChainView(
  chainId: string,
  exchangeId: string,
  playerText: string,
): V1PlayCallChainView {
  return {
    chainId,
    worldId: "world-one",
    baselineHead: "commit:1",
    parentHead: "commit:3",
    playPreset: {
      id: "preset-one",
      name: "default",
      revision: "preset-revision-one",
    },
    status: "ready",
    canRetry: false,
    previousContexts: [],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId,
        text: playerText,
        context: "fresh",
        committedHead: "commit:2",
      },
      {
        id: 2,
        kind: "tool_call",
        callId: "patch-one",
        name: "world_patch",
        arguments: { target: "@current-situation", edits: [] },
        replayed: false,
      },
      {
        id: 3,
        kind: "tool_result",
        callId: "patch-one",
        name: "world_patch",
        ok: true,
        markdown: "# 世界变化已提交",
        replayed: false,
      },
      {
        id: 4,
        kind: "assistant",
        text: "秦龙推开门，让你先走。",
        reasoning: "先确认门口没有障碍。",
        status: "completed",
        exchange: 2,
        attempt: 1,
        committedHead: "commit:3",
      },
    ],
    changedDocuments: [
      {
        kind: "replace",
        ref: "@current-situation",
        path: "current-situation.yaml",
      },
    ],
    lastFailure: null,
    updatedAt: 1,
  };
}

function interruptedChainView(): V1PlayCallChainView {
  return {
    chainId: "play-chain-interrupted",
    worldId: "world-one",
    baselineHead: "commit:1",
    parentHead: "commit:2",
    playPreset: {
      id: "preset-one",
      name: "default",
      revision: "preset-revision-one",
    },
    status: "interrupted",
    canRetry: true,
    previousContexts: [],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId: "exchange-first",
        text: "我示意秦龙开门。",
        context: "fresh",
        committedHead: "commit:2",
      },
      {
        id: 2,
        kind: "assistant",
        text: "秦龙刚把门推开一半",
        status: "interrupted",
        exchange: 1,
        attempt: 1,
      },
      { id: 3, kind: "failure", message: "Provider 流在半途断开。" },
    ],
    changedDocuments: [],
    lastFailure: "Provider 流在半途断开。",
    updatedAt: 1,
  };
}
