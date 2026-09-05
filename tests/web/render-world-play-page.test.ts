import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type { ConversationTarget } from "../../src/protocol/conversationObservation.ts";
import type { ObserveConversation } from "../../src/web/ConversationObserver.ts";
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
  ContentTreeFile,
  V1PlayCallChainStreamFrame,
  V1PlayCallChainView,
  V1PlayContextReadingView,
  V1PlayTimelinePage,
  V1Request,
  V1SettingPromptPreview,
  V1WorldRevisionEpochView,
  V1WorldRevisionOverview,
  V1WorldRevisionView,
  V1WorldRevisionSealedEpochView,
} from "../../src/protocol/v1.ts";
import { projectUncoveredPlayerViews } from "../../src/web/PlayerViewFallback.ts";
import { WorldPage } from "../../src/web/WorldPage.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  test("故事固定在阅读区，玩家视图和世界文档从两侧覆盖层按需展开", async () => {
    const client = readOnlyClient();

    renderWorld(client);

    expect(
      await screen.findByRole("heading", { name: "宿舍世界" }),
    ).toBeTruthy();
    expect(screen.getByRole("article", { name: "故事时间线" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "调用链" })).toBeNull();
    expect(screen.getByText("I ask what time practice starts.")).toBeTruthy();
    expect(
      screen.getByText("Alex says practice starts at eight tonight."),
    ).toBeTruthy();
    expect(screen.getByLabelText("当前情景").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.queryByText(/file_native_genesis/u)).toBeNull();
    expect(screen.getByRole("button", { name: "全新上下文" })).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加上下文" })
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "此刻" }));
    expect(screen.getByLabelText("当前情景").getAttribute("aria-hidden")).toBe(
      "false",
    );
    expect(screen.getByText("白色运动背心")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    expect(screen.getAllByText("宿舍里的夜晚").length).toBeGreaterThan(0);
    expect(screen.getByText(/情况: Alex正在整理球衣/u)).toBeTruthy();
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

  test("大量世界文档收进可搜索选择器，不改变中间故事栏宽度", async () => {
    const documents = [
      ...worldView(null).state,
      ...Array.from({ length: 33 }, (_, index) =>
        worldDocument(
          `locations/place-${index + 1}.yaml`,
          `location.place-${index + 1}`,
          `place-${index + 1}`,
          `地点 ${index + 1}`,
          `第 ${index + 1} 个临时地点。`,
          `描述: 地点 ${index + 1}\n`,
        ),
      ),
      worldDocument(
        "locations/south-hotpot.yaml",
        "location.south-hotpot",
        "south-hotpot",
        "南门火锅",
        "学校南门外的火锅店。",
        "设施: 有靠窗四人桌\n",
      ),
    ];
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve({ ...worldView(null), state: documents } as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            head: "commit:1",
            artifacts: [],
            extensions: [],
            artifactDebug: [],
          } as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    const rendered = renderWorld(client, undefined, {
      initialReadingPreferences: {
        density: "compact",
        fontSize: 17,
        lineHeight: 1.7,
        letterSpacing: 0.01,
        measure: 64,
      },
    });
    await screen.findByRole("heading", { name: "宿舍世界" });
    const root =
      rendered.container.querySelector<HTMLElement>(".world-reader-page")!;
    expect(root.style.getPropertyValue("--world-story-measure")).toBe("64rem");

    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    const rail = rendered.container.querySelector<HTMLElement>(
      ".world-overlay-rail-right",
    )!;
    expect(rail.getAttribute("aria-hidden")).toBe("false");
    fireEvent.click(within(rail).getByRole("button", { name: /选择文档/u }));
    expect(within(rail).getByText("全部 35 份文档")).toBeTruthy();
    fireEvent.change(within(rail).getByLabelText("查找当前文档"), {
      target: { value: "南门 火锅" },
    });
    expect(within(rail).getByText("没有匹配的文档")).toBeTruthy();
    fireEvent.change(within(rail).getByLabelText("查找当前文档"), {
      target: { value: "south-hotpot" },
    });
    expect(within(rail).getByText("找到 1 / 35 份")).toBeTruthy();
    fireEvent.click(within(rail).getByRole("option", { name: /南门火锅/u }));
    expect(within(rail).getByText(/设施: 有靠窗四人桌/u)).toBeTruthy();
    expect(root.style.getPropertyValue("--world-story-measure")).toBe("64rem");
  });

  test("阅读设置支持更宽正文并持久化，底部输入条随内容向上增长", async () => {
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(null) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "preferences.save")
          return Promise.resolve({
            locale: "zh-CN",
            reading: request.reading,
          } as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    const rendered = renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    const width = screen.getByRole<HTMLInputElement>("slider", {
      name: /正文宽度/u,
    });
    expect(width.max).toBe("72");
    fireEvent.change(width, { target: { value: "72" } });
    await waitFor(() =>
      expect(
        client.request.mock.calls.some(
          ([request]) =>
            request.type === "preferences.save" &&
            request.reading?.measure === 72,
        ),
      ).toBe(true),
    );
    expect(
      rendered.container
        .querySelector<HTMLElement>(".world-reader-page")!
        .style.getPropertyValue("--world-story-measure"),
    ).toBe("72rem");

    const composer = screen.getByLabelText<HTMLTextAreaElement>("你的行动");
    expect(composer.rows).toBe(1);
    Object.defineProperty(composer, "scrollHeight", {
      configurable: true,
      value: 96,
    });
    fireEvent.change(composer, {
      target: { value: "第一行\n第二行\n第三行\n第四行" },
    });
    await waitFor(() => expect(composer.style.height).toBe("96px"));
    expect(composer.style.overflowY).toBe("hidden");
  });

  test("AI 如何读取区分目录摘要、冻结注入与已返回的精确全文", async () => {
    const chain = playChainView(
      "play-chain-reading",
      "exchange-reading",
      "I wash up before bed.",
    );
    const dorm = worldDocument(
      "locations/dorm-404.yaml",
      "location.dorm-404",
      "dorm-404",
      "404 宿舍",
      "Alex 与玩家当前居住的宿舍。",
      "设施:\n  独立卫生间: true\n  独立淋浴间: true\n",
    );
    const reading = playReadingView();
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve({
            ...worldView(chain),
            state: [...worldView(chain).state, dorm],
          } as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "world.play-context.read")
          return Promise.resolve(reading as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    const rendered = renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "AI 读取" }));
    const rail = rendered.container.querySelector<HTMLElement>(
      ".world-overlay-rail-right",
    )!;
    expect(await within(rail).findByText("精确全文")).toBeTruthy();
    expect(within(rail).getByText("精确节点")).toBeTruthy();
    expect(
      within(rail).getByText(
        "这里只证明 Runtime 发送或返回了什么，不声称 AI 理解、记住或正确使用。",
      ),
    ).toBeTruthy();

    fireEvent.click(
      within(rail).getByRole("button", { name: "展开完整读取记录" }),
    );
    const dialog = screen.getByRole("dialog", { name: "AI 如何读取" });
    expect(
      within(dialog).getByText(
        "这里只查看上下文证据，不会开启修订或锁定世界。",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("AI 实际收到了哪些世界内容")).toBeTruthy();
    expect(within(dialog).getByText("标题 + 摘要")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("查看按需读取返回的完整记录"));
    expect(within(dialog).getByText(/独立淋浴间: true/u)).toBeTruthy();
    expect(
      within(dialog).getAllByText("下一次全新上下文").length,
    ).toBeGreaterThan(0);
  });

  test("世界修订把手动编辑、历史、应用和游玩锁放在同一工作区", async () => {
    const chain = playChainView(
      "play-chain-correction",
      "exchange-correction",
      "I look around the dormitory.",
    );
    const dorm = worldDocument(
      "locations/dorm-404.yaml",
      "location.dorm-404",
      "dorm-404",
      "404 宿舍",
      "Alex 与玩家当前居住的宿舍。",
      "设施:\n  独立卫生间: false\n  独立淋浴间: false\n",
    );
    const original = [...worldView(chain).state, dorm];
    const revisionFiles = [
      ...original.map((file) => ({ ...file, path: `state/${file.path}` })),
      ...worldView(chain).control.map((file) => ({
        ...file,
        path: `control/${file.path}`,
      })),
    ];
    let opened = false;
    let applied = false;
    let epoch = worldRevisionEpoch(revisionFiles);
    let sealedEpochs: V1WorldRevisionSealedEpochView[] = [];
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve({
            ...worldView(chain),
            head: applied ? "commit:4" : "commit:3",
            state: original,
            worldRevision: opened && !applied ? epoch : null,
          } as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "world.revision.open") {
          opened = true;
          if (applied && epoch.lifecycle !== "active")
            epoch = {
              ...worldRevisionEpoch(revisionFiles),
              epochId: "revision-00000000-0000-4000-8000-000000000002",
              baseHead: "commit:4",
            };
          return Promise.resolve(
            worldRevisionOverview(epoch, sealedEpochs) as T,
          );
        }
        if (request.type === "world.revision.overview")
          return Promise.resolve(
            worldRevisionOverview(epoch, sealedEpochs) as T,
          );
        if (request.type === "world.revision.files.replace") {
          const before = epoch.files.find(
            ({ path }) => path === "state/current-situation.yaml",
          )?.contents;
          const after = request.files.find(
            ({ path }) => path === "state/current-situation.yaml",
          )?.contents;
          const change = {
            path: "state/current-situation.yaml",
            kind: "modify" as const,
            before: before ?? null,
            after: after ?? null,
          };
          epoch = {
            ...epoch,
            revision: "revision-files-2",
            files: request.files,
            diff: [change],
            changes: [
              {
                changeSetId: "change-set:00000000-0000-4000-8000-000000000001",
                source: "manual",
                createdAt: 2,
                changes: [change],
              },
            ],
          };
          return Promise.resolve(
            worldRevisionOverview(epoch, sealedEpochs) as T,
          );
        }
        if (request.type === "world.revision.apply") {
          applied = true;
          opened = false;
          epoch = {
            ...epoch,
            lifecycle: "applied",
            locked: false,
            appliedHead: "commit:4",
            finishedAt: 3,
          };
          sealedEpochs = [
            {
              epochId: epoch.epochId,
              worldId: epoch.worldId,
              lifecycle: "applied",
              baseHead: epoch.baseHead,
              diff: epoch.diff,
              changes: epoch.changes,
              createdAt: epoch.createdAt,
              finishedAt: 3,
              appliedHead: epoch.appliedHead,
            },
          ];
          return Promise.resolve(
            worldRevisionOverview(epoch, sealedEpochs) as T,
          );
        }
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            head: applied ? "commit:4" : "commit:3",
            artifacts: [],
            extensions: [],
            artifactDebug: [],
          } as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
    expect(
      await screen.findByRole("heading", { name: /宿舍世界.*世界修订/u }),
    ).toBeTruthy();
    expect(screen.getByText("手动编辑和 AI 共用一份修订")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "手动修正" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(
      await screen.findByText(/世界正在修订，游玩和其他世界修改已锁定/u),
    ).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("你的行动").disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
    const lockedManagement = screen.getByRole("dialog", { name: "世界管理" });
    expect(
      within(lockedManagement).getByText(
        "世界修订期间，分叉和控制变更已锁定；本地显示名称仍可修改。",
      ),
    ).toBeTruthy();
    expect(
      within(lockedManagement).getByRole<HTMLButtonElement>("button", {
        name: "创建分叉",
      }).disabled,
    ).toBe(true);
    expect(
      within(lockedManagement).getByLabelText<HTMLTextAreaElement>(
        "世界控制文件（JSON）",
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      within(lockedManagement).getByRole("button", { name: "关闭" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续修订" }));
    await screen.findByRole("heading", { name: /宿舍世界.*世界修订/u });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "从草稿移除" })
        .disabled,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("文件路径").disabled).toBe(
      true,
    );
    fireEvent.change(
      screen.getByLabelText("编辑 state/current-situation.yaml"),
      {
        target: {
          value: original[0]!.contents.replace(
            "Alex正在整理球衣",
            "Alex正在浴室门边整理球衣",
          ),
        },
      },
    );
    expect(screen.getByText("有未保存修改")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "应用并解锁" })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存到修订" }));
    expect(await screen.findByText("手动编辑")).toBeTruthy();
    expect(screen.getByText("修订记录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "应用并解锁" }));
    expect(
      await screen.findByText(
        "世界修订已应用并解锁。再次继续原对话时，AI 会先重新读取当前世界。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("世界已在故事外修订；下一次行动会从新上下文开始。"),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加上下文" })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
    expect(await screen.findByText("已封存修订")).toBeTruthy();
    fireEvent.click(screen.getByText("已封存修订"));
    fireEvent.click(screen.getByText("已应用修订"));
    expect(screen.getByText("封存时的完整差异")).toBeTruthy();
  });

  test("浏览器没有 randomUUID 时仍能启动全新上下文", async () => {
    let fill = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(++fill);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

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
        return Promise.reject(new Error("Unexpected request: " + request.type));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I signal Alex to open the door." },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith({
        type: "play.chain.start",
        worldId: "world-one",
        chainId: `play-chain-${"01".repeat(16)}`,
        exchangeId: `play-exchange-${"02".repeat(16)}`,
        playerText: "I signal Alex to open the door.",
      }),
    );
    expect(getRandomValues).toHaveBeenCalledTimes(2);
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
        return Promise.reject(new Error("Unexpected request: " + request.type));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I signal Alex to open the door." },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(
      await screen.findByText("Alex opens the door and lets you go first."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The dormitory door closes behind you, and Alex waits for you to speak.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Alex says practice starts at eight tonight."),
    ).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "全新上下文从这里开始" }),
    ).toBeTruthy();
    expect(screen.getAllByText("I signal Alex to open the door.")).toHaveLength(
      1,
    );
    expect(screen.getByText("调用 world_patch")).toBeTruthy();
    expect(screen.getByText("world_patch 返回")).toBeTruthy();
    const trace = screen.getByText("本段调用详情").closest("details");
    expect(trace?.open).toBe(false);
    expect(trace?.contains(screen.getByText("调用 world_patch"))).toBe(true);
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
      playerText: "I signal Alex to open the door.",
    });
    expect(start?.chainId).toMatch(/^play-chain-/u);
    expect(start?.exchangeId).toMatch(/^play-exchange-/u);
  });

  test("每轮对话都在对应回复后显示自己的调用详情", async () => {
    const chain = playChainView(
      "play-chain-two-turns",
      "exchange-first",
      "First player action.",
    );
    chain.events.push(
      {
        id: 5,
        kind: "player",
        exchangeId: "exchange-second",
        text: "Second player action.",
        context: "append",
        committedHead: "commit:4",
      },
      {
        id: 6,
        kind: "assistant",
        text: "Second narration.",
        reasoning: "Reasoning for only the second turn.",
        status: "completed",
        responseKind: "narrative",
        exchange: 3,
        attempt: 1,
        committedHead: "commit:5",
      },
      {
        id: 7,
        kind: "assistant",
        text: "Continuation narration.",
        reasoning: "Reasoning for the continuation call.",
        status: "completed",
        responseKind: "narrative",
        exchange: 4,
        attempt: 1,
        committedHead: "commit:6",
      },
    );
    chain.parentHead = "commit:6";
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    const firstNarration = await screen.findByText(
      "Alex opens the door and lets you go first.",
    );
    const secondPlayer = screen.getByText("Second player action.");
    const secondNarration = screen.getByText("Second narration.");
    const continuationNarration = screen.getByText("Continuation narration.");
    const traces = screen
      .getAllByText("本段调用详情")
      .map((summary) => summary.closest("details"));

    expect(traces).toHaveLength(3);
    expect(traces[0]).not.toBeNull();
    expect(traces[1]).not.toBeNull();
    expect(traces[2]).not.toBeNull();
    expect(
      firstNarration.compareDocumentPosition(traces[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      traces[0]!.compareDocumentPosition(secondPlayer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      secondNarration.compareDocumentPosition(traces[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      traces[1]!.compareDocumentPosition(continuationNarration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      continuationNarration.compareDocumentPosition(traces[2]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(within(traces[0]!).getByText("调用 world_patch")).toBeTruthy();
    expect(within(traces[1]!).queryByText("调用 world_patch")).toBeNull();
    expect(within(traces[2]!).queryByText("调用 world_patch")).toBeNull();
  });

  test("模型响应始终显示输入、缓存读写、推理和输出 token 明细", async () => {
    const chain = playChainView(
      "play-chain-usage",
      "exchange-usage",
      "I ask Alex to check the cache.",
    );
    const assistant = chain.events.find((event) => event.kind === "assistant");
    if (assistant?.kind !== "assistant")
      throw new Error("The usage fixture requires an assistant event");
    assistant.usage = {
      inputTokens: 1_200,
      uncachedInputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      reasoningTokens: 80,
      outputTokens: 240,
      totalTokens: 1_440,
      provenance: {
        inputTokens: "provider",
        uncachedInputTokens: "derived_provider_fields",
        cacheReadTokens: "provider",
        cacheWriteTokens: "provider",
        reasoningTokens: "provider",
        outputTokens: "provider",
        totalTokens: "provider",
      },
    };
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.timeline.detail")
          return Promise.resolve(
            chain.events.find(({ id }) => id === request.eventId) as T,
          );
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");

    const compact = screen.getByLabelText("Token 用量明细");
    expect(within(compact).getByText("1,200")).toBeTruthy();
    expect(within(compact).getByText("700")).toBeTruthy();
    expect(within(compact).getByText("400")).toBeTruthy();
    expect(within(compact).getByText("100")).toBeTruthy();
    expect(within(compact).getByText("80")).toBeTruthy();
    expect(within(compact).getByText("240")).toBeTruthy();
    expect(within(compact).getByText("1,440")).toBeTruthy();

    const details = screen.getByText("查看模型诊断详情").closest("details");
    expect(details).not.toBeNull();
    fireEvent.click(details!.querySelector("summary")!);
    expect(
      await within(details!).findByText(
        "缓存读取和缓存写入属于输入构成；推理 tokens 已包含在输出 tokens 中，不应重复相加。",
      ),
    ).toBeTruthy();
    expect(within(details!).getAllByText("Provider 报告")).toHaveLength(6);
    expect(within(details!).getByText("由 Provider 字段计算")).toBeTruthy();
  });

  test("再次全新上下文后仍按分隔符显示此前思维链和工具记录", async () => {
    let chain = playChainView(
      "play-chain-old",
      "exchange-old",
      "Player input for the old context.",
    );
    chain = {
      ...chain,
      events: chain.events.map((event) =>
        event.kind === "assistant"
          ? {
              ...event,
              text: "Visible narration from the old context.",
              reasoning:
                "Earlier-context reasoning that should remain visible.",
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
        if (request.type === "play.timeline.detail") {
          const context = [...chain.previousContexts, chain].find(
            ({ chainId }) => chainId === request.chainId,
          );
          return Promise.resolve(
            context?.events.find(({ id }) => id === request.eventId) as T,
          );
        }
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("调用 context_search");
    expect(
      screen.queryByText(
        "Earlier-context reasoning that should remain visible.",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByText("查看模型诊断详情").closest("summary")!);
    expect(
      await screen.findByText(
        "Earlier-context reasoning that should remain visible.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("调用 context_search")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "Continue from the fresh context." },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(
      await screen.findByText("Alex opens the door and lets you go first."),
    ).toBeTruthy();
    expect(
      screen.getByText("Earlier-context reasoning that should remain visible."),
    ).toBeTruthy();
    expect(screen.getByText("调用 context_search")).toBeTruthy();
    expect(
      screen.getAllByText("Player input for the old context."),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("Visible narration from the old context."),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("Continue from the fresh context."),
    ).toHaveLength(1);
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I open the dormitory door." },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    await screen.findByText("Alex opens the door and lets you go first.");
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
      async generate(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        const running: V1PlayCallChainView = {
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
        chain = running;
        onFrame({ kind: "snapshot", value: running, final: false });
        onFrame({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "reasoning",
          text: "First confirm that the doorway is clear.",
          updatedAt: Date.now(),
        });
        onFrame({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "text",
          text: "Alex is opening the door",
          updatedAt: Date.now(),
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
      target: { value: "I signal Alex to open the door." },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    expect(await screen.findByText("Alex is opening the door")).toBeTruthy();
    const progress = screen.getByRole("status", {
      name: "本次模型调用进度",
    });
    expect(within(progress).getByText("正在输出正文…")).toBeTruthy();
    expect(within(progress).getByText("40 字")).toBeTruthy();
    expect(within(progress).getByText("24 字")).toBeTruthy();
    expect(screen.getByText("接收中 · 第 1 次派发")).toBeTruthy();
    expect(screen.getByText("待定输出；响应完成前不会进入故事")).toBeTruthy();
    expect(screen.getByText("响应完成后可查看模型诊断详情")).toBeTruthy();
    expect(
      screen.queryByText("世界已在故事外修订；下一次行动会从新上下文开始。"),
    ).toBeNull();
    expect(screen.queryByText("查看模型诊断详情")).toBeNull();
    expect(
      screen.queryByText("First confirm that the doorway is clear."),
    ).toBeNull();
    act(() => finishStream?.());
    expect(
      await screen.findByText("Alex opens the door and lets you go first."),
    ).toBeTruthy();
  });

  test("模型尚未返回首个流帧时持续显示进度并允许取消", async () => {
    let finishStream: (() => void) | undefined;
    let chain: V1PlayCallChainView | null = null;
    let activeExchangeId: string | undefined;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.cancel") {
          expect(request).toMatchObject({
            worldId: "world-one",
            chainId: chain?.chainId,
            exchangeId: activeExchangeId,
          });
          finishStream?.();
          return Promise.resolve({ outcome: "cancellation_requested" } as T);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
      async generate(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        activeExchangeId = request.exchangeId;
        const running: V1PlayCallChainView = {
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
        chain = running;
        onFrame({ kind: "snapshot", value: running, final: false });
        await new Promise<void>((resolve) => {
          finishStream = resolve;
        });
        const cancelled: V1PlayCallChainView = {
          ...running,
          status: "interrupted",
          canRetry: false,
          events: [
            running.events[0]!,
            {
              id: 2,
              kind: "assistant",
              text: "",
              status: "interrupted",
              exchange: 1,
              attempt: 1,
            },
            {
              id: 3,
              kind: "cancellation",
              message: "玩家取消了模型生成。",
            },
          ],
          lastFailure: "玩家取消了模型生成。",
        };
        chain = cancelled;
        onFrame({ kind: "snapshot", value: cancelled, final: true });
        return cancelled;
      },
    };

    try {
      renderWorld(client);
      await screen.findByRole("heading", { name: "宿舍世界" });
      fireEvent.change(screen.getByLabelText("你的行动"), {
        target: { value: "I wait while Alex considers the answer." },
      });
      fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

      const progress = await screen.findByRole("status", {
        name: "本次模型调用进度",
      });
      expect(within(progress).getByText("正在等待模型响应…")).toBeTruthy();
      const cancel = within(progress).getByRole("button", {
        name: "取消生成",
      });
      expect((cancel as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(cancel);
      await waitFor(() =>
        expect(
          client.request.mock.calls.some(
            ([request]) => request.type === "play.chain.cancel",
          ),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("status", { name: "本次模型调用进度" }),
        ).toBeNull(),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("模型生成已取消。")).toBeTruthy();
    } finally {
      finishStream?.();
    }
  });

  test("刷新页面后从 Runtime 恢复进度、识别长时间无数据并仍可取消", async () => {
    const now = Date.now();
    let chain: V1PlayCallChainView = {
      ...playChainView(
        "play-chain-restored-progress",
        "exchange-restored-progress",
        "I wait for Alex to answer.",
      ),
      status: "running",
      parentHead: "commit:2",
      activeInvocation: {
        chainId: "play-chain-restored-progress",
        exchangeId: "exchange-restored-progress",
        phase: "waiting",
        startedAt: now - 95_000,
        lastActivityAt: now - 91_000,
        reasoningChars: 0,
        textChars: 0,
        toolChars: 0,
        toolCalls: 0,
        dispatches: 1,
      },
      events: [
        {
          id: 1,
          kind: "player",
          exchangeId: "exchange-restored-progress",
          text: "I wait for Alex to answer.",
          context: "fresh",
          committedHead: "commit:2",
        },
        {
          id: 2,
          kind: "assistant",
          text: "",
          status: "streaming",
          responseKind: "pending",
          exchange: 1,
          attempt: 1,
        },
      ],
      changedDocuments: [],
      lastFailure: null,
      updatedAt: now - 91_000,
    };
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.cancel") {
          expect(request).toMatchObject({
            worldId: "world-one",
            chainId: "play-chain-restored-progress",
            exchangeId: "exchange-restored-progress",
          });
          const { activeInvocation: _activeInvocation, ...settled } = chain;
          void _activeInvocation;
          const activeAssistant = settled.events.at(-1);
          if (activeAssistant?.kind !== "assistant")
            throw new Error("Expected an active assistant event");
          chain = {
            ...settled,
            status: "interrupted",
            events: [
              ...settled.events.slice(0, -1),
              { ...activeAssistant, status: "interrupted" },
              {
                id: 3,
                kind: "cancellation",
                message: "The player cancelled model generation.",
              },
            ],
            lastFailure: "The player cancelled model generation.",
            updatedAt: Date.now(),
          };
          return Promise.resolve({ outcome: "cancellation_requested" } as T);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    const progress = await screen.findByRole("status", {
      name: "本次模型调用进度",
    });
    await waitFor(() =>
      expect(within(progress).getByText(/模型调用可能已经卡住/u)).toBeTruthy(),
    );
    fireEvent.click(within(progress).getByRole("button", { name: "取消生成" }));
    await waitFor(
      () =>
        expect(
          screen.queryByRole("status", { name: "本次模型调用进度" }),
        ).toBeNull(),
      { timeout: 2_500 },
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("生成已取消")).toBeTruthy();
  });

  test("调用链流失败后在当前操作区保留明确错误而不是只在页面顶部提示", async () => {
    const failure = "Immutable play-advance fact already has different data";
    let chain: V1PlayCallChainView | null = null;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.timeline.page")
          return Promise.reject(new Error("Timeline refresh unavailable"));
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
      generate(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        const running: V1PlayCallChainView = {
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
              responseKind: "pending",
              exchange: 1,
              attempt: 1,
            },
          ],
        };
        chain = running;
        onFrame({ kind: "snapshot", value: running, final: false });
        chain = {
          ...running,
          status: "interrupted",
          events: [
            running.events[0]!,
            {
              id: 2,
              kind: "assistant",
              text: "",
              status: "interrupted",
              responseKind: "pending",
              exchange: 1,
              attempt: 1,
            },
            { id: 3, kind: "failure", message: failure },
          ],
          lastFailure: failure,
        };
        return Promise.reject(new Error(failure));
      },
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I wait for Alex to answer." },
    });
    fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));

    const composer = document.querySelector<HTMLElement>(
      ".world-composer-dock",
    );
    expect(composer).not.toBeNull();
    const alert = await within(composer!).findByRole("alert", {
      name: "模型调用失败",
    });
    expect(alert.textContent).toContain(failure);
    expect(alert.textContent).toContain("旧请求不能重发");
    expect(
      screen.queryByRole("status", { name: "本次模型调用进度" }),
    ).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>("你的行动").value).toBe(
      "",
    );
  });

  test("工具中间步文本默认折叠在调用轨迹中且不会伪装成叙事", async () => {
    const intermediate = "I will inspect the record before narrating.";
    const chain = playChainView(
      "play-chain-tool-step",
      "exchange-tool-step",
      "I ask Alex to check the door.",
    );
    chain.parentHead = "commit:4";
    chain.events = [
      chain.events[0]!,
      {
        id: 2,
        kind: "assistant",
        text: intermediate,
        status: "completed",
        responseKind: "tool_step",
        exchange: 1,
        attempt: 1,
        committedHead: "commit:3",
      },
      {
        id: 3,
        kind: "tool_call",
        callId: "patch-tool-step",
        name: "world_patch",
        arguments: { target: "@current-situation", edits: [] },
        replayed: false,
      },
      {
        id: 4,
        kind: "tool_result",
        callId: "patch-tool-step",
        name: "world_patch",
        ok: true,
        markdown: "@current-situation write succeeded",
        replayed: false,
      },
      {
        id: 5,
        kind: "assistant",
        text: "Alex checks the latch and pulls the door shut.",
        status: "completed",
        responseKind: "narrative",
        exchange: 2,
        attempt: 1,
        committedHead: "commit:4",
      },
    ];
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    const timeline = screen.getByLabelText("模型调用链");
    expect(within(timeline).getByText("模型工具步骤")).toBeTruthy();
    expect(
      within(timeline).getByText(
        "Alex checks the latch and pulls the door shut.",
      ),
    ).toBeTruthy();
    expect(within(timeline).getAllByText(intermediate)).toHaveLength(1);
    const summary =
      within(timeline).getByText("查看工具步骤文本（未进入故事）");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
      async generate(
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
        target: { value: "I signal Alex to open the door." },
      });
      fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));
      await waitFor(() => expect(emitFrame).toBeTypeOf("function"));
      expect(
        within(screen.getByLabelText("模型调用链")).getByText("模型响应中"),
      ).toBeTruthy();
      scrollIntoView.mockClear();

      act(() =>
        emitFrame?.({
          kind: "assistant_delta",
          eventId: 2,
          deltaKind: "text",
          text: "Alex is opening the door",
          updatedAt: 2,
        }),
      );

      expect(screen.getByText("Alex is opening the door")).toBeTruthy();
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

  test("长上下文首页省略边界时，追加不会伪造一个全新上下文", async () => {
    const chainId = "play-chain-long-current-context";
    const timeline = {
      worldId: "world-one",
      generation: "timeline-long-current-context",
      activeChainId: chainId,
      activeStatus: "ready",
      activeCanRetry: false,
      activeLastFailure: null,
      items: [
        {
          kind: "event",
          chainId,
          current: true,
          event: {
            id: 40,
            kind: "assistant",
            text: "The visible tail starts in the middle of one context.",
            status: "completed",
            exchange: 20,
            attempt: 1,
            hasReasoning: false,
            hasToolFragment: false,
            hasUsage: false,
            detailsAvailable: false,
          },
        },
      ],
      nextCursor: "older-page",
    } satisfies V1PlayTimelinePage;
    let finishStream: (() => void) | undefined;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve({
            ...worldView(null),
            playTimeline: timeline,
          } as T);
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            head: "commit:1",
            artifacts: [],
            extensions: [],
            artifactDebug: [],
          } as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(null as T);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
      async generate(
        request: Extract<
          V1Request,
          { type: "play.chain.start" | "play.chain.append" }
        >,
        onFrame: (frame: V1PlayCallChainStreamFrame) => void,
      ) {
        const running = {
          ...playChainView(chainId, request.exchangeId, request.playerText),
          status: "running" as const,
          events: [
            {
              id: 41,
              kind: "player" as const,
              exchangeId: request.exchangeId,
              text: request.playerText,
              context: "append" as const,
              committedHead: "commit:2",
            },
            {
              id: 42,
              kind: "assistant" as const,
              text: "",
              status: "streaming" as const,
              exchange: 21,
              attempt: 1,
            },
          ],
        } satisfies V1PlayCallChainView;
        onFrame({ kind: "snapshot", value: running, final: false });
        await new Promise<void>((resolve) => {
          finishStream = resolve;
        });
        return { ...running, status: "ready" as const };
      },
    };

    try {
      renderWorld(client);
      await screen.findByText(
        "The visible tail starts in the middle of one context.",
      );
      fireEvent.change(screen.getByLabelText("你的行动"), {
        target: { value: "I continue inside the same model context." },
      });
      fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

      await waitFor(() =>
        expect(
          within(screen.getByLabelText("模型调用链")).getByText("模型响应中"),
        ).toBeTruthy(),
      );
      expect(
        screen.queryAllByRole("separator", {
          name: "全新上下文从这里开始",
        }),
      ).toHaveLength(0);
      expect(
        screen.queryByText("世界已在故事外修订；下一次行动会从新上下文开始。"),
      ).toBeNull();
    } finally {
      await act(async () => {
        finishStream?.();
        await Promise.resolve();
      });
      cleanup();
    }
  });

  test("追加上下文只发送一条新的玩家输入并接到现有调用链", async () => {
    let chain = playChainView(
      "play-chain-existing",
      "exchange-first",
      "I signal Alex to open the door.",
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
                text: "The corridor lights come on one by one.",
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I walk into the corridor." },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    expect(
      await screen.findByText("The corridor lights come on one by one."),
    ).toBeTruthy();
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
      playerText: "I walk into the corridor.",
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
                text: "Alex pushes the door fully open.",
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    expect(
      await screen.findByText("Alex has opened the door halfway"),
    ).toBeTruthy();
    expect(screen.getByText(/保持输入为空并重试/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "追加上下文" }));

    expect(
      await screen.findByText("Alex pushes the door fully open."),
    ).toBeTruthy();
    expect(screen.getAllByText("I signal Alex to open the door.")).toHaveLength(
      1,
    );
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
        "I signal Alex to open the door.",
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
          text: "I signal Alex to open the door.",
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
                text: "Alex reconsiders and pulls the door open.",
                status: "completed",
                exchange: 1,
                attempt: 1,
                committedHead: "commit:2",
              },
            ],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("I signal Alex to open the door.");
    const copiedPlayerMessage = screen
      .getByText("I signal Alex to open the door.")
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
      screen.getByText(
        "The dormitory door closes behind you, and Alex waits for you to speak.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("I signal Alex to open the door.")).toHaveLength(
      1,
    );
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
      await screen.findByText("Alex reconsiders and pulls the door open."),
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
      "I signal Alex to open the door.",
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
    await screen.findByText("Alex opens the door and lets you go first.");
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
      "I signal Alex to open the door.",
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
                text: "Alex stops and waits for you to reconsider.",
                status: "completed",
                exchange: 2,
                attempt: 1,
                committedHead: "commit:5",
              },
            ],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error("Unexpected request: " + request.type));
      }),
    };

    renderWorld(client, onOpenWorld);
    await screen.findByText("I signal Alex to open the door.");
    const playerMessage = screen
      .getByText("I signal Alex to open the door.")
      .closest<HTMLElement>(".call-chain-player")!;
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "修改" }),
    );
    const editor = within(playerMessage).getByLabelText("修改后的行动");
    expect((editor as HTMLTextAreaElement).value).toBe(
      "I signal Alex to open the door.",
    );
    expect(
      within(playerMessage)
        .getByRole("radio", {
          name: /沿原上下文继续/u,
        })
        .matches(":checked"),
    ).toBe(true);
    fireEvent.change(editor, {
      target: { value: "I ask Alex not to open the door yet." },
    });
    fireEvent.click(
      within(playerMessage).getByRole("button", {
        name: "保存修改并继续",
      }),
    );

    expect(
      await screen.findByText("Alex stops and waits for you to reconsider."),
    ).toBeTruthy();
    expect(onOpenWorld).not.toHaveBeenCalled();
    expect(
      screen.getByText("I ask Alex not to open the door yet."),
    ).toBeTruthy();
    expect(screen.queryByText("I signal Alex to open the door.")).toBeNull();
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.revise-player"),
    ).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-existing",
      eventId: 1,
      replacementText: "I ask Alex not to open the door yet.",
      continuation: "continue_context",
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

  test("修改玩家提交可明确选择把修改稿作为全新上下文保存", async () => {
    let chain = playChainView(
      "play-chain-existing",
      "exchange-first",
      "I signal Alex to open the door.",
    );
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.revise-player") {
          chain = {
            ...chain,
            chainId: "play-chain-fresh-revision",
            baselineHead: "commit:1",
            parentHead: "commit:4",
            events: [
              {
                id: 1,
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
                text: "Alex waits at the beginning of the fresh context.",
                status: "completed",
                exchange: 1,
                attempt: 1,
                committedHead: "commit:5",
              },
            ],
          };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error("Unexpected request: " + request.type));
      }),
    };

    renderWorld(client);
    await screen.findByText("I signal Alex to open the door.");
    const playerMessage = screen
      .getByText("I signal Alex to open the door.")
      .closest<HTMLElement>(".call-chain-player")!;
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "修改" }),
    );
    fireEvent.change(within(playerMessage).getByLabelText("修改后的行动"), {
      target: { value: "I ask Alex to wait before opening the door." },
    });
    fireEvent.click(
      within(playerMessage).getByRole("radio", {
        name: /作为全新上下文保存/u,
      }),
    );
    fireEvent.click(
      within(playerMessage).getByRole("button", {
        name: "保存为全新上下文并继续",
      }),
    );

    expect(
      await screen.findByText(
        "Alex waits at the beginning of the fresh context.",
      ),
    ).toBeTruthy();
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.revise-player"),
    ).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-existing",
      eventId: 1,
      replacementText: "I ask Alex to wait before opening the door.",
      continuation: "fresh_context",
    });
    expect(
      client.request.mock.calls
        .map(([request]) => request)
        .find((request) => request.type === "play.chain.append"),
    ).toMatchObject({
      worldId: "world-one",
      chainId: "play-chain-fresh-revision",
      playerText: "",
    });
  });
});

function renderWorld(
  client: {
    request(request: V1Request): Promise<unknown>;
    observeConversation?: ObserveConversation;
    generate?: (
      request: Extract<
        V1Request,
        { type: "play.chain.start" | "play.chain.append" }
      >,
      onFrame: (frame: V1PlayCallChainStreamFrame) => void,
    ) => Promise<V1PlayCallChainView>;
  },
  onOpenWorld: (worldId: string) => Promise<void> = vi.fn(() =>
    Promise.resolve(),
  ),
  options: {
    onRenameWorld?: (name: string) => Promise<void>;
    initialReadingPreferences?: {
      density: "compact" | "standard" | "relaxed";
      fontSize: number;
      lineHeight: number;
      letterSpacing: number;
      measure: number;
    };
  } = {},
) {
  let receive: Parameters<ObserveConversation>[1] | undefined;
  let observed: V1PlayCallChainView | null = null;
  const publish = (frame: V1PlayCallChainStreamFrame): void => {
    if (frame.kind === "snapshot") observed = structuredClone(frame.value);
    if (frame.kind === "assistant_delta" && observed !== null) {
      const event = observed.events.find((item) => item.id === frame.eventId);
      if (event?.kind === "assistant") {
        const field =
          frame.deltaKind === "text"
            ? "text"
            : frame.deltaKind === "reasoning"
              ? "reasoning"
              : "toolFragment";
        event[field] = `${event[field] ?? ""}${frame.text}`;
        observed.updatedAt = frame.updatedAt;
      }
    }
    void receive?.({ kind: "play", value: structuredClone(observed) }, true);
  };
  const observedClient = {
    observeConversation:
      client.observeConversation ??
      (((_target, callback) => {
        receive = callback;
        return () => {
          receive = undefined;
        };
      }) satisfies ObserveConversation),
    request: async (request: V1Request): Promise<unknown> => {
      if (
        (request.type === "play.chain.start" ||
          request.type === "play.chain.append") &&
        client.generate !== undefined
      ) {
        const result = await client.generate(request, publish);
        publish({ kind: "snapshot", value: result, final: true });
        return result;
      }
      const result = await client.request(request);
      if (request.type === "play.chain.cancel") {
        const value = (await client.request({
          type: "play.chain.inspect",
          worldId: request.worldId,
        })) as V1PlayCallChainView | null;
        if (value !== null)
          publish({
            kind: "snapshot",
            value,
            final: value.status !== "running",
          });
      }
      return result;
    },
  };
  return render(
    createElement(WorldPage, {
      client: observedClient,
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

function worldDocument(
  path: string,
  id: string,
  ref: string,
  title: string,
  summary: string,
  body: string,
): ContentTreeFile {
  return {
    path,
    contents: `$document:
  id: ${id}
  ref: ${ref}
  title: ${title}
  summary: ${summary}
  aliases: []
${body}`,
  };
}

function promptPreviewFixture(): V1SettingPromptPreview {
  return {
    diagnosticBinding: {
      endpoint: "world-one:commit:3",
      commit: "commit:3",
      hostPresetId: "host-one",
      controlFingerprint: "control-one",
      modelId: "model-one",
    },
    compilation: {
      logicalMessages: [
        {
          role: "world_context",
          markdown: "# 当前世界\n\n404 宿舍",
          blocks: [
            {
              source: "slot:current_situation",
              markdown: "# 当前世界\n\n404 宿舍",
            },
          ],
        },
      ],
      provider: { protocol: "openai_responses" },
      tools: [],
      coverage: [
        {
          slot: "current_situation",
          source: "@current-situation",
          status: "resolved",
          complete: true,
          continuation: "context_read",
          readAuthorization: {
            shortRef: "current-situation",
            locator: null,
          },
        },
        {
          slot: "catalog",
          source: "locations",
          status: "resolved",
          complete: true,
          continuation: "state_list",
          catalogEntries: ["dorm-404"],
        },
      ],
      budget: {
        estimator: "conservative_utf8_bytes",
        messageTokens: 100,
        toolTokens: 0,
        outputReserveTokens: 1_000,
        forcedTailReserveTokens: 0,
        safetyMarginTokens: 100,
        requiredTokens: 1_200,
        contextWindowTokens: 64_000,
        status: "fits",
      },
      cache: {
        strategy: "provider_managed",
        stablePrefixFingerprint: "stable-one",
        breakpoints: [],
        estimatedCacheableBytes: 100,
        firstDynamicByte: 100,
      },
    },
    leakage: { status: "clean", checkedFields: [] },
  };
}

function playReadingView(): V1PlayContextReadingView {
  const preview = promptPreviewFixture();
  return {
    worldId: "world-one",
    worldHead: "commit:3",
    currentContext: {
      chainId: "play-chain-reading",
      baselineHead: "commit:1",
      parentHead: "commit:3",
      stale: false,
      playPreset: {
        id: "preset-one",
        name: "default",
        revision: "preset-revision-one",
      },
      updatedAt: 1,
      bootstrap: {
        logicalMessages: preview.compilation.logicalMessages,
        coverage: preview.compilation.coverage,
      },
      reads: [
        {
          eventId: 3,
          callId: "read-dorm-room",
          ref: "@dorm-404",
          ok: true,
          complete: true,
          locator: null,
          markdown:
            "Document: @dorm-404\nComplete: yes\n\n设施:\n  独立卫生间: true\n  独立淋浴间: true",
        },
        {
          eventId: 4,
          callId: "read-current-situation-node",
          ref: "@current-situation#/情况",
          ok: true,
          complete: true,
          locator: { yaml: ["情况"] },
          markdown:
            "Document: @current-situation#/情况\nComplete: yes\n\nAlex正在整理球衣",
        },
      ],
    },
    nextFreshContext: { head: "commit:3", preview },
  };
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
      exactText:
        "The dormitory door closes behind you, and Alex waits for you to speak.",
      head: "genesis",
    },
    {
      role: "player" as const,
      exactText: "I ask what time practice starts.",
      head: "commit:0",
    },
    {
      role: "narrator" as const,
      exactText: "Alex says practice starts at eight tonight.",
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
          "$document:\n  id: situation.current\n  ref: current-situation\n  title: 宿舍里的夜晚\n  summary: 宿舍里的当前局面。\n  aliases: []\n情况: Alex正在整理球衣\n",
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

function worldRevisionEpoch(
  files: ContentTreeFile[],
): V1WorldRevisionEpochView {
  return {
    epochId: "revision-00000000-0000-4000-8000-000000000000",
    worldId: "world-one",
    lifecycle: "active",
    locked: true,
    baseHead: "commit:3",
    revision: "revision-files-1",
    files,
    diff: [],
    diagnostics: [],
    changes: [],
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    appliedHead: null,
  };
}

function worldRevisionOverview(
  epoch: V1WorldRevisionEpochView,
  sealedEpochs: V1WorldRevisionSealedEpochView[] = [],
): V1WorldRevisionOverview {
  return { epoch, sealedEpochs, latest: null, history: [] };
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
        event.text.trim().length > 0 &&
        event.responseKind !== "tool_step"
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
        markdown: "# World changes committed",
        replayed: false,
      },
      {
        id: 4,
        kind: "assistant",
        text: "Alex opens the door and lets you go first.",
        reasoning: "First confirm that the doorway is clear.",
        status: "completed",
        responseKind: "narrative",
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
        text: "I signal Alex to open the door.",
        context: "fresh",
        committedHead: "commit:2",
      },
      {
        id: 2,
        kind: "assistant",
        text: "Alex has opened the door halfway",
        status: "interrupted",
        exchange: 1,
        attempt: 1,
      },
      {
        id: 3,
        kind: "failure",
        message: "The Provider stream disconnected midway.",
      },
    ],
    changedDocuments: [],
    lastFailure: "The Provider stream disconnected midway.",
    updatedAt: 1,
  };
}

test("世界修订 fresh 订阅不绑定旧 latest，命令完成不覆盖后来选择的历史", async () => {
  const epoch = worldRevisionEpoch([]);
  const view = (sessionId: string): V1WorldRevisionView => ({
    sessionId,
    worldId: "world-one",
    epochId: epoch.epochId,
    runStatus: "ready",
    messages: [],
    turns: [],
    usage: emptyAggregatedModelUsage(),
    progress: { exchange: 0, toolCalls: 0, streaming: null, updatedAt: 1 },
    lastFailure: null,
  });
  const old = view("old-session");
  const recent = view("recent-session");
  const created = view("new-session");
  let latest = recent;
  const history = [recent, old].map((item) => ({
    sessionId: item.sessionId,
    epochId: epoch.epochId,
    createdAt: 1,
    updatedAt: 1,
    runStatus: item.runStatus,
    messageCount: 0,
    turnCount: 0,
    exchangeCount: 0,
    toolCallCount: 0,
    changedFileCount: 0,
    excerpt: item.sessionId,
  }));
  const overview = (): V1WorldRevisionOverview => ({
    ...worldRevisionOverview(epoch),
    latest,
    history,
  });
  const subscribers = new Set<{
    target: ConversationTarget;
    receive: Parameters<ObserveConversation>[1];
  }>();
  let finish!: (value: V1WorldRevisionView) => void;
  const client = {
    observeConversation: ((target, receive) => {
      const item = { target, receive };
      subscribers.add(item);
      return () => {
        subscribers.delete(item);
      };
    }) satisfies ObserveConversation,
    request: vi.fn(async (request: V1Request): Promise<unknown> => {
      if (request.type === "world.read") return worldView(null);
      if (request.type === "artifacts.debug") return [];
      if (
        request.type === "world.revision.open" ||
        request.type === "world.revision.overview"
      )
        return overview();
      if (request.type === "world.revision.session.read")
        return request.sessionId === old.sessionId ? old : latest;
      if (request.type === "world.revision.message")
        return await new Promise<V1WorldRevisionView>((resolve) => {
          finish = resolve;
        });
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  const publish = async () => {
    for (const item of [...subscribers])
      if (item.target.kind === "revision") {
        const selected = item.target.sessionId === old.sessionId ? old : latest;
        await item.receive(
          {
            kind: "revision",
            value: {
              revision: latest.sessionId,
              selected: {
                sessionId: selected.sessionId,
                runStatus: selected.runStatus,
                progress: selected.progress,
              },
            },
          },
          true,
        );
      }
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  fireEvent.click(screen.getByRole("button", { name: "世界" }));
  fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
  await screen.findByText("手动编辑和 AI 共用一份修订");
  fireEvent.click(screen.getByRole("button", { name: "全新上下文" }));
  fireEvent.change(screen.getByLabelText("用全新上下文给 AI 发消息"), {
    target: { value: "start fresh" },
  });
  fireEvent.keyDown(screen.getByLabelText("用全新上下文给 AI 发消息"), {
    key: "Enter",
  });
  await act(publish);
  expect(
    [...subscribers].find(({ target }) => target.kind === "revision")?.target,
  ).toEqual({ kind: "revision", id: "world-one" });
  latest = { ...created, runStatus: "running" };
  await act(publish);
  expect(
    [...subscribers].find(({ target }) => target.kind === "revision")?.target,
  ).toEqual({
    kind: "revision",
    id: "world-one",
    sessionId: created.sessionId,
  });
  fireEvent.click(screen.getByRole("button", { name: "历史" }));
  fireEvent.click(screen.getByRole("button", { name: /^old-session/ }));
  await waitFor(() =>
    expect(
      document.querySelector('.setting-history-select[aria-pressed="true"]')
        ?.textContent,
    ).toContain("old-session"),
  );
  await act(async () => {
    latest = created;
    finish(created);
    await Promise.resolve();
  });
  expect(
    document.querySelector('.setting-history-select[aria-pressed="true"]')
      ?.textContent,
  ).toContain("old-session");
});
