import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type { ConversationTarget } from "../../src/protocol/conversationObservation.ts";
import {
  observeConversation,
  type ObserveConversation,
} from "../../src/web/ConversationObserver.ts";
import { v1Protocol } from "../../src/protocol/v1.ts";
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
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import {
  ArtifactExtensionHost,
  type FrontendArtifactProjection,
} from "../../src/web/ArtifactExtensionHost.tsx";
import {
  defaultAppReadingPreferences,
  type AppReadingPreferences,
} from "../../src/protocol/appPreferences.ts";
import { WorldPage } from "../../src/web/WorldPage.tsx";
import { PlayTimeline } from "../../src/web/PlayTimeline.tsx";
import { App } from "../../src/web/App.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";
import {
  RuntimeRequestError,
  type RuntimeClient,
} from "../../src/web/runtimeClient.ts";

beforeEach(() => {
  // Node's native localStorage can shadow the browser storage in jsdom.
  const browser = globalThis as unknown as {
    jsdom: { window: { localStorage: Storage } };
  };
  vi.stubGlobal("localStorage", browser.jsdom.window.localStorage);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("世界游玩页面", () => {
  test("renders old transcript narration and leaves the original player action readable", async () => {
    const request = (input: V1Request): Promise<unknown> => {
      if (input.type === "world.read")
        return Promise.resolve({
          ...worldView(null),
          committedMessages: [
            {
              role: "narrator",
              exactText: "# 旧开场\n\n灯亮了。\nThe door opens.",
            },
            { role: "player", exactText: "**我停下。**" },
            { role: "narrator", exactText: "她说：*等一下*。" },
          ],
        });
      return Promise.resolve([]);
    };
    renderWorld({ request });
    const heading = await screen.findByRole("heading", { name: "旧开场" });
    const opening = heading.closest("article")!;
    expect(opening.querySelector("p br")).toBeTruthy();
    expect(opening.querySelector("p")?.textContent).toBe(
      "灯亮了。\nThe door opens.",
    );
    expect(screen.getByText("**我停下。**").closest("p")).toBeTruthy();
    expect(screen.getByText("等一下").tagName).toBe("EM");
  });

  test.each([
    {
      locale: "zh-CN" as const,
      edit: "修改",
      messageActions: "玩家消息操作",
      warning:
        "保存修改会永久删除这条原消息及之后的故事、模型对话和产物，并撤销从这条消息起的世界改动。此前的历史会保留。",
    },
    {
      locale: "en" as const,
      edit: "Edit",
      messageActions: "Player message actions",
      warning:
        "Saving permanently deletes the original message and all later story, model conversation, and artifacts. It rolls back world changes from that message onward. Earlier history is kept.",
    },
  ])(
    "warns before saving a player-message edit in $locale",
    async ({ locale, edit, messageActions, warning }) => {
      setWebLocale(locale);
      const chain = playChainView("original", "first", "Open the door.");
      const request = vi.fn((input: V1Request): Promise<unknown> => {
        if (input.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (input.type === "world.play-decorations.read")
          return Promise.resolve(
            playDecorations(null, chain.worldId, chain.parentHead),
          );
        return Promise.reject(new Error(input.type));
      });
      renderWorld({ request });

      fireEvent.click(
        await screen.findByRole("button", { name: messageActions }),
      );
      fireEvent.click(screen.getByRole("button", { name: edit }));

      expect(screen.getByText(warning)).toBeTruthy();
      expect(request).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "play.chain.revise-player" }),
      );
    },
  );

  test("missing saved request opens a new input without resending or issuing an action", async () => {
    const chain = {
      ...interruptedChainView(),
      freshContextReason: "snapshot_missing" as const,
      modelProtocol: "chat_completions" as const,
      canRetry: false,
    };
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read") return Promise.resolve(worldView(chain));
      if (input.type === "artifacts.debug") return Promise.resolve([]);
      return Promise.reject(new Error(input.type));
    });
    renderWorld({ request }, undefined, {
      activeModelProtocol: "anthropic_messages",
    });
    const button = await screen.findByRole("button", { name: "用新上下文" });
    expect(screen.queryByText(/当前模型协议与此上下文不同/u)).toBeNull();
    expect(
      screen.getByText("缺少这次请求的历史记录，无法还原原请求。"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "续写" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
    fireEvent.click(button);
    const input = screen.getByLabelText<HTMLTextAreaElement>("你的行动");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    expect(
      screen.getByRole("button", { name: "从全新上下文发送行动" }),
    ).toBeTruthy();
    expect(
      request.mock.calls.some(
        ([command]) =>
          command.type === "play.chain.start" ||
          command.type === "play.chain.append",
      ),
    ).toBe(false);
  });

  test("continue response submits the partial recovery action even when resend is unavailable", async () => {
    const chain = {
      ...interruptedChainView(),
      canRetry: false,
      canContinuePartial: true,
      lastFailureKind: "output_limit" as const,
    };
    let finish!: (chain: V1PlayCallChainView) => void;
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read") return Promise.resolve(worldView(chain));
      if (input.type === "world.play-decorations.read")
        return Promise.resolve({ artifacts: [], debug: [] });
      if (input.type === "artifacts.debug") return Promise.resolve([]);
      if (input.type === "play.chain.append")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve([]);
    });
    renderWorld({ request });
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "续写",
    });
    expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续故事" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试本轮" })).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "play.chain.append",
          chainId: chain.chainId,
          playerText: "",
          recovery: "continue_partial",
        }),
      ),
    );
    await act(async () => {
      finish({
        ...chain,
        status: "ready",
        canContinuePartial: false,
        lastFailure: null,
      });
      await Promise.resolve();
    });
  });

  test.each([
    { technical: false, summaryOnly: false },
    { technical: true, summaryOnly: false },
    { technical: false, summaryOnly: true },
    { technical: true, summaryOnly: true },
  ])(
    "resending hides the old failure immediately and only a new failure alerts, $technical/$summaryOnly",
    async ({ technical, summaryOnly }) => {
      let chain = interruptedChainView();
      let resolveSend!: (value: V1PlayCallChainView) => void;
      let receive!: Parameters<ObserveConversation>[1];
      const readView = () => {
        const full = worldView(chain);
        if (!summaryOnly) return full;
        return {
          ...full,
          playCallChain: null,
          playTimeline: {
            worldId: chain.worldId,
            generation: "retry-test",
            activeChainId: chain.chainId,
            activeStatus: chain.status,
            activeCanRetry: chain.canRetry,
            activeLastFailure: chain.lastFailure,
            items: chain.events.map((event) => ({
              kind: "event" as const,
              chainId: chain.chainId,
              current: true,
              event,
            })),
            nextCursor: null,
          },
        };
      };
      const request = vi.fn((input: V1Request): Promise<unknown> => {
        if (input.type === "world.read") return Promise.resolve(readView());
        if (input.type === "world.play-decorations.read")
          return Promise.resolve({ artifacts: [], debug: [] });
        if (input.type === "artifacts.debug") return Promise.resolve([]);
        if (input.type === "play.chain.append")
          return new Promise((resolve) => {
            resolveSend = resolve;
          });
        return Promise.reject(new Error(`Unexpected request: ${input.type}`));
      });
      renderWorld(
        {
          request,
          observeConversation: (_target, callback) => {
            receive = callback;
            return () => {
              receive = () => Promise.resolve();
            };
          },
        },
        undefined,
        {
          initialReadingPreferences: {
            ...defaultAppReadingPreferences,
            showTechnicalInfo: technical,
          },
        },
      );
      fireEvent.click(await screen.findByRole("button", { name: "重新发送" }));
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({ type: "play.chain.append" }),
        ),
      );
      expect(
        document.querySelectorAll(".call-chain-failure[role=alert]").length,
      ).toBe(0);
      await act(async () => {
        await receive({ kind: "play", value: structuredClone(chain) }, true);
      });
      expect(
        document.querySelectorAll(".call-chain-failure[role=alert]").length,
      ).toBe(0);
      chain = {
        ...chain,
        status: "ready",
        canRetry: false,
        lastFailure: null,
        updatedAt: 2,
        events: [
          ...chain.events,
          {
            id: 4,
            kind: "assistant",
            text: "Recovered response",
            status: "completed",
            responseKind: "narrative",
            exchange: 1,
            attempt: 2,
          },
        ],
      };
      await act(async () => {
        resolveSend(chain);
        await Promise.resolve();
      });
      await screen.findByText("Recovered response");
      expect(
        document.querySelectorAll(".call-chain-failure[role=alert]").length,
      ).toBe(0);
      const composer = screen.getByLabelText("你的行动");
      fireEvent.change(composer, { target: { value: "next action" } });
      fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(
          request.mock.calls.filter(
            ([input]) => input.type === "play.chain.append",
          ),
        ).toHaveLength(2),
      );
      chain = {
        ...chain,
        status: "interrupted",
        canRetry: true,
        lastFailure: "New provider failure",
        updatedAt: 3,
        events: [
          ...chain.events,
          { id: 5, kind: "failure", message: "New provider failure" },
        ],
      };
      await act(async () => {
        resolveSend(chain);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          document.querySelectorAll(".call-chain-failure[role=alert]").length,
        ).toBe(1),
      );
      const alert = document.querySelector(".call-chain-failure[role=alert]")!;
      expect(alert.textContent).toContain("New provider failure");
      expect(alert.textContent).not.toContain(
        "The Provider stream disconnected midway.",
      );
    },
  );

  test.each([
    "lost response",
    "failed refresh",
    "unaccepted action",
    "unreachable runtime",
    "running",
  ] as const)("reconciles play submission feedback: %s", async (scenario) => {
    let chain = playChainView("existing", "first", "Begin.");
    const unconfirmed =
      scenario === "unaccepted action" || scenario === "unreachable runtime";
    let submitted = false;
    let refreshFailed = false;
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (submitted && scenario === "unreachable runtime")
        return Promise.reject(new Error("Runtime unreachable"));
      if (input.type === "world.read") {
        if (submitted && scenario === "failed refresh" && !refreshFailed) {
          refreshFailed = true;
          return Promise.reject(new Error("World read disconnected"));
        }
        return Promise.resolve(worldView(chain));
      }
      if (input.type === "world.play-decorations.read")
        return Promise.resolve({ artifacts: [], debug: [] });
      if (input.type === "artifacts.debug") return Promise.resolve([]);
      if (input.type === "play.chain.inspect") return Promise.resolve(chain);
      if (input.type !== "play.chain.append")
        return Promise.reject(new Error(input.type));
      submitted = true;
      if (!unconfirmed) {
        chain = {
          ...chain,
          parentHead: "commit:5",
          status: scenario === "running" ? "running" : "ready",
          events: [
            ...chain.events,
            {
              id: 5,
              kind: "player",
              text: input.playerText,
              context: "append",
              exchangeId: input.exchangeId,
              committedHead: "commit:4",
            },
          ],
        };
        if (scenario !== "running")
          chain.events.push({
            id: 6,
            kind: "assistant",
            text: "The path is clear.",
            status: "completed",
            responseKind: "narrative",
            exchange: 2,
            attempt: 1,
            committedHead: "commit:5",
          });
      }
      if (scenario === "failed refresh") return Promise.resolve(chain);
      return Promise.reject(new Error("Send disconnected"));
    });
    renderWorld({ request });
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "你的行动",
    });
    fireEvent.change(input, { target: { value: "Look outside." } });
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));
    if (unconfirmed) {
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Send disconnected",
      );
      expect(input.value).toBe("Look outside.");
    } else {
      await waitFor(() => expect(input.value).toBe(""));
      if (scenario === "running") {
        expect(
          await screen.findByRole("button", { name: "取消生成" }),
        ).toBeTruthy();
      } else {
        await screen.findByText("The path is clear.");
        fireEvent.change(input, { target: { value: "Continue." } });
        expect(
          screen.getByRole<HTMLButtonElement>("button", {
            name: "接着当前对话继续",
          }).disabled,
        ).toBe(false);
      }
    }
    expect(screen.queryByText("调用链中断")).toBeNull();
    expect(screen.queryByRole("alert", { name: "模型调用失败" })).toBeNull();
    expect(
      request.mock.calls.filter(([call]) => call.type === "play.chain.append"),
    ).toHaveLength(1);
  });

  test("repeated older observations verify once and keep the newer timeline", async () => {
    const stale = interruptedChainView();
    const view = {
      ...worldView(null),
      playTimeline: {
        worldId: stale.worldId,
        generation: "current",
        activeChainId: stale.chainId,
        activeStatus: "ready",
        activeLastFailure: null,
        activeCanRetry: false,
        items: [
          {
            kind: "event",
            chainId: stale.chainId,
            current: true,
            event: {
              id: 99,
              kind: "assistant",
              status: "completed",
              responseKind: "narrative",
              text: "Current accepted reply.",
              hasReasoning: false,
              hasToolFragment: false,
              hasUsage: false,
              detailsAvailable: false,
              exchange: 2,
              attempt: 1,
              committedHead: "commit:9",
            },
          },
        ],
        nextCursor: null,
      } satisfies V1PlayTimelinePage,
    };
    let receive!: Parameters<ObserveConversation>[1];
    let reads = 0;
    let finishRead!: () => void;
    const request = vi.fn((input: V1Request) => {
      if (input.type !== "world.read") return Promise.resolve([]);
      if (++reads === 1) return Promise.resolve(view);
      return new Promise((resolve) => {
        finishRead = () => resolve(view);
      });
    });
    renderWorld({
      request,
      observeConversation: (_target, cb) => {
        receive = cb;
        return () => undefined;
      },
    });
    await screen.findByText("Current accepted reply.");
    let receiving!: void | Promise<void>;
    act(() => {
      receiving = receive({ kind: "play", value: stale }, true);
    });
    expect(screen.queryByRole("alert", { name: "模型调用失败" })).toBeNull();
    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    await act(async () => {
      finishRead();
      await receiving;
    });
    expect(screen.queryByRole("alert", { name: "模型调用失败" })).toBeNull();
    await act(async () => {
      await receive(
        { kind: "play", value: { ...stale, updatedAt: stale.updatedAt + 1 } },
        true,
      );
    });
    expect(reads).toBe(2);
    expect(screen.getByText("Current accepted reply.")).toBeTruthy();
  });

  test("a rejected resend displays its new rejection instead of the unchanged inspected error", async () => {
    const chain = interruptedChainView();
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain);
        if (request.type === "play.chain.append")
          return Promise.reject(new Error("New retry rejected by connection"));
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({ artifacts: [], debug: [] });
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client);
    fireEvent.click(await screen.findByRole("button", { name: "重新发送" }));
    await screen.findByText("New retry rejected by connection");
    const alert = screen.getByRole("alert", { name: "模型调用失败" });
    expect(alert.textContent).not.toContain(chain.lastFailure);
    expect(
      document.querySelectorAll(".call-chain-failure[role=alert]").length,
    ).toBe(0);
  });

  test("导出只在显式触发时读取，修订锁内可下载两种故事格式", async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(
      () => "blob:story-export",
    );
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.story.export")
          return Promise.resolve({
            fileName:
              request.format === "markdown" ? "宿舍世界.md" : "宿舍世界.txt",
            content: "完整故事原文",
          });
        return Promise.resolve({
          ...worldView(null),
          worldRevision: worldRevisionEpoch([]),
        });
      }),
    };
    try {
      renderWorld(client);
      await screen.findByRole("heading", { name: "宿舍世界" });
      fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
      const dialog = screen.getByRole("dialog", { name: "世界管理" });
      expect(
        client.request.mock.calls.some(
          ([request]) => request.type === "world.story.export",
        ),
      ).toBe(false);
      for (const [format, label, fileName] of [
        ["markdown", "导出 Markdown", "宿舍世界.md"],
        ["text", "导出纯文本", "宿舍世界.txt"],
      ] as const) {
        const button = within(dialog).getByRole<HTMLButtonElement>("button", {
          name: label,
        });
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        await waitFor(() =>
          expect(click).toHaveBeenCalledTimes(format === "markdown" ? 1 : 2),
        );
        expect(client.request).toHaveBeenCalledWith({
          type: "world.story.export",
          worldId: "world-one",
          format,
        });
        const anchor = click.mock.instances.at(-1)! as HTMLAnchorElement;
        expect(anchor.download).toBe(fileName);
        expect(anchor.href).toBe("blob:story-export");
        expect(createObjectURL.mock.calls.at(-1)?.[0]).toBeInstanceOf(Blob);
        await waitFor(() => expect(button.disabled).toBe(false));
      }
      expect(revokeObjectURL.mock.calls).toEqual([
        ["blob:story-export"],
        ["blob:story-export"],
      ]);
      expect(await screen.findByText("故事已导出。")).toBeTruthy();
    } finally {
      click.mockRestore();
    }
  });

  test("故事导出失败会报告错误并恢复入口", async () => {
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> =>
        request.type === "world.story.export"
          ? Promise.reject(new Error("无法读取故事"))
          : Promise.resolve(worldView(null)),
      ),
    };
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "导出 Markdown",
    });
    fireEvent.click(button);
    expect(await screen.findByText("无法读取故事")).toBeTruthy();
    expect(button.disabled).toBe(false);
  });
  test.each(["provider_error", "output_limit", "retryable"] as const)(
    "没有模型连接时 %s 的配置入口确认放弃草稿，重发仍禁用",
    async (failureKind) => {
      const chain = interruptedChainView();
      chain.lastFailureKind = failureKind;
      chain.canRetry = failureKind === "retryable";
      const failure = chain.events.at(-1)!;
      if (failure.kind !== "failure") throw new Error("missing failure");
      failure.failureKind = failureKind;
      const request = vi.fn((input: V1Request): Promise<unknown> => {
        if (input.type === "workspace.read")
          return Promise.resolve({
            preferences: { locale: "zh-CN" },
            contentPackages: [],
            worlds: [
              {
                worldId: "world-one",
                title: "宿舍世界",
                gameplay: { mode: "interactive-fiction" },
              },
            ],
            storageNotices: [],
            playPresets: { currentPresetId: "", presets: [] },
            model: {
              configured: false,
              activeConnectionId: null,
              connections: [],
              presets: [],
            },
          });
        if (input.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (input.type === "artifacts.debug") return Promise.resolve([]);
        if (input.type === "world.package-scripts.read")
          return Promise.resolve({ enabled: false });
        return Promise.reject(new Error(`Unexpected request: ${input.type}`));
      });
      render(
        createElement(App, {
          client: { request } as unknown as RuntimeClient,
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "打开世界：宿舍世界" }),
      );
      await screen.findByText("你可以先写下行动。配置模型连接后，再由你发送。");
      expect(screen.queryByRole("button", { name: "用新上下文" })).toBeNull();
      if (failureKind === "retryable") {
        const retry = screen.getByRole<HTMLButtonElement>("button", {
          name: "重新发送",
        });
        expect(retry.disabled).toBe(true);
        fireEvent.click(retry);
        expect(
          request.mock.calls.some(
            ([input]) => input.type === "play.chain.append",
          ),
        ).toBe(false);
        return;
      }
      const configure = screen.getByRole<HTMLButtonElement>("button", {
        name: failureKind === "output_limit" ? "调整最大输出" : "检查模型连接",
      });
      expect(configure.disabled).toBe(false);
      const openManagement = (): HTMLElement => {
        fireEvent.click(screen.getByRole("button", { name: "世界管理" }));
        const management = screen.getByRole("dialog", { name: "世界管理" });
        fireEvent.click(within(management).getByText("世界控制 · 高级编辑"));
        return management;
      };
      const management = openManagement();
      fireEvent.change(
        await within(management).findByRole("textbox", {
          name: "编辑 control/player-views.yaml",
        }),
        { target: { value: "draft player views" } },
      );
      fireEvent.click(within(management).getByRole("button", { name: "关闭" }));
      expect(configure.disabled).toBe(false);
      fireEvent.click(configure);
      const leaveDialog = () =>
        screen.getByRole("dialog", {
          name: "此页有未保存的修改。要放弃修改并离开吗？",
        });
      fireEvent.click(
        within(leaveDialog()).getByRole("button", { name: "取消" }),
      );
      expect(
        document.querySelector(".workspace-shell")?.getAttribute("data-screen"),
      ).toBe("world");
      const retainedManagement = openManagement();
      expect(
        (
          await within(retainedManagement).findByRole<HTMLTextAreaElement>(
            "textbox",
            { name: "编辑 control/player-views.yaml" },
          )
        ).value,
      ).toBe("draft player views");
      fireEvent.click(
        within(retainedManagement).getByRole("button", { name: "关闭" }),
      );
      fireEvent.click(configure);
      fireEvent.click(
        within(leaveDialog()).getByRole("button", { name: "放弃并离开" }),
      );
      await screen.findByRole("heading", { name: "模型连接" });
      expect(
        document.querySelector(".workspace-shell")?.getAttribute("data-screen"),
      ).toBe("model");
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.type === "play.chain.append" ||
            input.type === "play.chain.start",
        ),
      ).toBe(false);
    },
  );

  test("游玩暂停通知在轻量首屏显示，继续只发送一个空输入", async () => {
    const paused = interruptedChainView();
    paused.events = paused.events.filter((event) => event.kind === "player");
    paused.lastFailureKind = "dispatch_budget";
    paused.lastFailure = "Play paused after 64 model requests.";
    const readView = {
      ...worldView(null),
      playTimeline: {
        ...lightweightPlayTimeline(paused),
        activeLastFailureKind: paused.lastFailureKind,
      },
    };
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read") return Promise.resolve(readView);
      if (input.type === "artifacts.debug") return Promise.resolve([]);
      if (input.type === "play.chain.append")
        return Promise.resolve({
          ...paused,
          status: "ready",
          canRetry: false,
          lastFailure: null,
          lastFailureKind: undefined,
        });
      return Promise.reject(new Error(`Unexpected request: ${input.type}`));
    });
    renderWorld({ request });
    expect(
      await screen.findByRole("button", { name: "继续生成" }),
    ).toBeTruthy();
    const resume = screen.getByRole("button", { name: "继续本轮" });
    expect(resume.textContent).toBe("继续本轮");
    expect(
      screen.getByText("游玩生成已暂停").closest('[role="status"]'),
    ).toBeTruthy();
    expect(
      request.mock.calls.filter(
        ([input]) => input.type === "play.chain.append",
      ),
    ).toHaveLength(0);
    fireEvent.click(resume);
    await waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([input]) => input.type === "play.chain.append",
        ),
      ).toMatchObject([
        [{ worldId: "world-one", chainId: paused.chainId, playerText: "" }],
      ]),
    );
  });

  test.each([false, true])(
    "恢复按钮使用当前链，保留草稿并支持轻量首屏=%s",
    async (summaryOnly) => {
      const chain = interruptedChainView();
      chain.lastFailureKind = "retryable";
      const failure = chain.events.at(-1)!;
      if (failure.kind !== "failure") throw new Error("missing failure");
      failure.failureKind = "retryable";
      const readView: ReturnType<typeof worldView> & {
        playTimeline?: V1PlayTimelinePage;
      } = worldView(chain);
      if (summaryOnly) {
        readView.playCallChain = null;
        readView.playTimeline = {
          worldId: "world-one",
          generation: "summary-only",
          activeChainId: chain.chainId,
          activeStatus: "interrupted",
          activeCanRetry: true,
          activeLastFailure: chain.lastFailure,
          activeLastFailureKind: "retryable",
          items: [
            {
              kind: "event",
              chainId: chain.chainId,
              current: true,
              event: failure,
            },
          ],
          nextCursor: null,
        };
      }
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read") return Promise.resolve(readView);
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          if (request.type === "play.chain.append")
            return Promise.resolve(chain);
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client);
      const retry = await screen.findByRole("button", { name: "重新发送" });
      const composer = screen.getByLabelText<HTMLTextAreaElement>("你的行动");
      fireEvent.change(composer, { target: { value: "下一次行动的草稿" } });
      fireEvent.click(retry);
      await waitFor(() =>
        expect(
          client.request.mock.calls.some(
            ([request]) => request.type === "play.chain.append",
          ),
        ).toBe(true),
      );
      const request = client.request.mock.calls.find(
        ([request]) => request.type === "play.chain.append",
      )![0];
      expect(request).toMatchObject({
        type: "play.chain.append",
        worldId: "world-one",
        chainId: chain.chainId,
        playerText: "",
      });
      expect(composer.value).toBe("下一次行动的草稿");
      expect(screen.queryByRole("button", { name: "用新上下文" })).toBeNull();
      expect(
        client.request.mock.calls.filter(
          ([request]) =>
            request.type === "play.chain.append" ||
            request.type === "play.chain.start",
        ),
      ).toHaveLength(1);
      expect(
        client.request.mock.calls.some(
          ([request]) => request.type === "play.timeline.detail",
        ),
      ).toBe(false);
    },
  );

  test("默认故事模式隐藏技术信息，切换详细模式即时显示且不提前读取详情", async () => {
    const chain = playChainView("mode-chain", "send", "我推开门。");
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "play.timeline.context")
          return Promise.resolve({
            status: "available",
            messages: [{ role: "user", text: "historical-context-message" }],
          });
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (request.type === "world.play-decorations.read")
          return Promise.resolve(
            playDecorations("正文附件", "world-one", "commit:3"),
          );
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        if (request.type === "preferences.save")
          return Promise.resolve({ locale: "zh-CN", reading: request.reading });
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    const rendered = renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");
    const story = screen.getByRole("article", { name: "故事时间线" });
    expect(within(story).getByText("我推开门。")).toBeTruthy();
    expect(within(story).queryByText("AI 响应")).toBeNull();
    expect(within(story).queryByText("全新上下文")).toBeNull();
    expect(within(story).queryByText("本段调用详情")).toBeNull();
    expect(within(story).queryByText("本次上下文")).toBeNull();
    expect(within(story).queryByText("本上下文已提交的世界变化")).toBeNull();
    expect(within(story).getByRole("separator").textContent).toBe("");
    expect(
      screen.queryByText(
        "正常发送和空输入续写使用最新编排方案；本轮工具执行期间保持不变。",
      ),
    ).toBeNull();
    await screen.findByTitle("panel");
    fireEvent.click(screen.getByRole("button", { name: "此刻" }));
    expect(screen.getByText("白色运动背心")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "显示技术信息",
    });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(within(story).getByText("AI 响应")).toBeTruthy();
    expect(within(story).getByText("全新上下文")).toBeTruthy();
    expect(
      story.querySelector(".call-chain-assistant > article > header")
        ?.textContent,
    ).toContain("已完成");
    expect(story.textContent).not.toContain("次派发");
    expect(within(story).getByText("本段调用详情")).toBeTruthy();
    expect(within(story).getByText("本上下文已提交的世界变化")).toBeTruthy();
    expect(within(story).getByText("default")).toBeTruthy();
    expect(
      screen.getByText(
        "正常发送和空输入续写使用最新编排方案；本轮工具执行期间保持不变。",
      ),
    ).toBeTruthy();
    expect(rendered.container.querySelector(".is-detailed-mode")).toBeTruthy();
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith({
        type: "preferences.save",
        reading: { ...defaultAppReadingPreferences, showTechnicalInfo: true },
      }),
    );
    expect(
      client.request.mock.calls.filter(
        ([request]) => request.type === "play.timeline.detail",
      ),
    ).toHaveLength(0);
    expect(
      client.request.mock.calls.filter(
        ([request]) => request.type === "play.timeline.context",
      ),
    ).toHaveLength(0);
    const contextSummary = within(story).getByText("本次上下文");
    const contextDetails = contextSummary.closest("details")!;
    expect(contextDetails.open).toBe(false);
    contextDetails.open = true;
    fireEvent(contextDetails, new Event("toggle"));
    await screen.findByText("historical-context-message");
    expect(
      client.request.mock.calls.filter(
        ([request]) => request.type === "play.timeline.context",
      ),
    ).toHaveLength(1);
    expect(client.request).toHaveBeenCalledWith({
      type: "play.timeline.context",
      worldId: "world-one",
      chainId: chain.chainId,
      eventId: 4,
    });
    fireEvent.click(toggle);
    expect(within(story).queryByText("本段调用详情")).toBeNull();
    expect(within(story).queryByText("本次上下文")).toBeNull();
    expect(screen.getByTitle("panel")).toBeTruthy();
  });

  test.each([false, true])(
    "两种模式保留中断、取消和待修复状态（技术信息=%s）",
    async (showTechnicalInfo) => {
      const chain = interruptedChainView();
      chain.events.push(
        { id: 4, kind: "cancellation", message: "玩家取消了模型生成。" },
        { id: 5, kind: "failure", message: "已提交、待修复" },
        {
          id: 6,
          kind: "followup",
          followupId: "failed-panel",
          displayName: "辅助面板",
          text: "",
          toolCalls: [],
          failure: "后置请求失败",
          usage: emptyAggregatedModelUsage(),
        },
      );
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read")
            return Promise.resolve(worldView(chain));
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client, undefined, {
        initialReadingPreferences: {
          ...defaultAppReadingPreferences,
          showTechnicalInfo,
        },
      });
      await screen.findByRole("heading", { name: "宿舍世界" });
      const story = screen.getByRole("article", { name: "故事时间线" });
      expect(
        within(story).queryByText(
          "The Provider stream disconnected midway.",
        ) !== null,
      ).toBe(showTechnicalInfo);
      expect(within(story).getByText("生成已取消")).toBeTruthy();
      expect(within(story).queryByText("已提交、待修复") !== null).toBe(
        showTechnicalInfo,
      );
      expect(story.querySelector(".call-chain-failure[role=alert]")).toBeNull();
      expect(within(story).getAllByText(/辅助面板/u).length).toBeGreaterThan(0);
      expect(within(story).queryAllByLabelText("Token 用量明细")).toHaveLength(
        showTechnicalInfo ? 2 : 0,
      );
    },
  );

  test("故事模式保留流式正文和待定标记，隐藏派发与返回推理", async () => {
    const chain = playChainView("stream-mode", "send", "打开门。");
    const assistant = chain.events.find((event) => event.kind === "assistant")!;
    if (assistant.kind !== "assistant") throw new Error("Missing assistant");
    delete assistant.committedHead;
    assistant.text = "Alex 正在推门";
    assistant.status = "streaming";
    assistant.responseKind = "pending";
    chain.status = "running";
    chain.activeInvocation = createObservedProgress(
      chain.chainId,
      "story-mode-exchange",
    );
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client);
    await screen.findByText("Alex 正在推门");
    expect(screen.getByText("待定输出；响应完成前不会进入故事")).toBeTruthy();
    expect(screen.queryByText("接收中")).toBeNull();
    expect(screen.queryByText("模型推理")).toBeNull();
    expect(screen.getByRole("button", { name: "取消生成" })).toBeTruthy();
  });

  test("只有最新已提交正文检查点自动预选，取消后重复观察和模式切换不重选，新检查点再预选", async () => {
    let receive: Parameters<ObserveConversation>[1] | undefined;
    const chain = playChainView("checkpoint-chain", "send", "我整理书架。");
    const checkpoint = chain.events.find(
      (event) => event.kind === "assistant",
    )!;
    if (checkpoint.kind !== "assistant") throw new Error("Missing narrative");
    checkpoint.checkpoint = true;
    const laterNarrative = structuredClone(checkpoint);
    delete laterNarrative.checkpoint;
    chain.events.push({
      ...laterNarrative,
      id: 5,
      text: "后来又聊了一会。",
      committedHead: "commit:4",
    });
    chain.parentHead = "commit:4";
    const client = {
      observeConversation: ((_target, callback) => {
        receive = callback;
        return () => {
          receive = undefined;
        };
      }) satisfies ObserveConversation,
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        if (request.type === "preferences.save")
          return Promise.resolve({ reading: request.reading });
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client);
    await screen.findByText("后来又聊了一会。");
    expect(screen.queryByText("下一条消息将开启全新上下文")).toBeNull();
    expect(screen.queryByText("检查点")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "显示技术信息" }));
    expect(screen.getAllByText("检查点")).toHaveLength(1);
    expect(screen.queryByText("AI 建议在此开启全新上下文")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "下一条消息使用全新上下文" }),
    ).toBeNull();
    chain.events.push({
      ...checkpoint,
      id: 6,
      text: "新一段整理完成。",
      committedHead: "commit:5",
    });
    chain.parentHead = "commit:5";
    await act(async () => {
      await receive?.({ kind: "play", value: structuredClone(chain) }, true);
    });
    expect(screen.getByText("下一条消息将开启全新上下文")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "保留草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消全新上下文" }));
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "显示技术信息" }));
    await act(async () => {
      await receive?.({ kind: "play", value: structuredClone(chain) }, true);
    });
    expect(screen.queryByText("下一条消息将开启全新上下文")).toBeNull();
    expect(screen.getByRole("button", { name: "追加行动" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>("你的行动").value).toBe(
      "保留草稿",
    );
    expect(screen.queryByText("检查点")).toBeNull();
    chain.events.push({
      ...checkpoint,
      id: 7,
      text: "再一次整理完成。",
      committedHead: "commit:6",
    });
    chain.parentHead = "commit:6";
    await act(async () => {
      await receive?.({ kind: "play", value: structuredClone(chain) }, true);
    });
    expect(screen.getByText("下一条消息将开启全新上下文")).toBeTruthy();
    expect(
      client.request.mock.calls.some(
        ([request]) =>
          request.type === "play.chain.start" ||
          request.type === "play.chain.append",
      ),
    ).toBe(false);
  });

  test("取消检查点后卸载重进仍不预选，相同端点改上下文身份不重选，新检查点及未处理选择保留", async () => {
    const chain = playChainView("checkpoint-navigation", "send", "整理书架。");
    const narrative = chain.events.find((event) => event.kind === "assistant")!;
    if (narrative.kind !== "assistant") throw new Error("Missing narrative");
    narrative.checkpoint = true;
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain));
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    let page = renderWorld(client);
    await screen.findByText("下一条消息将开启全新上下文");
    fireEvent.click(screen.getByRole("button", { name: "取消全新上下文" }));
    page.unmount();
    page = renderWorld(client);
    await screen.findByText(narrative.text);
    expect(screen.queryByText("下一条消息将开启全新上下文")).toBeNull();
    page.unmount();
    chain.chainId = "restored-context-for-same-checkpoint";
    page = renderWorld(client);
    await screen.findByText(narrative.text);
    expect(screen.queryByText("下一条消息将开启全新上下文")).toBeNull();
    page.unmount();
    narrative.committedHead = "commit:4";
    narrative.text = "另一段整理完成。";
    chain.parentHead = "commit:4";
    page = renderWorld(client);
    await screen.findByText(narrative.text);
    expect(screen.getByText("下一条消息将开启全新上下文")).toBeTruthy();
    page.unmount();
    renderWorld(client);
    await screen.findByText(narrative.text);
    expect(screen.getByText("下一条消息将开启全新上下文")).toBeTruthy();
    expect(
      client.request.mock.calls.some(
        ([request]) =>
          request.type === "play.chain.start" ||
          request.type === "play.chain.append",
      ),
    ).toBe(false);
  });

  test.each([6_200, 9_000])(
    "观察 A 链后补读切换到无完成响应的 B 链会清除旧占用和提示：%i",
    async (input) => {
      const old = playChainView("chain-a", "first", "Look around.");
      old.contextWindowTokens = 10_000;
      const oldResponse = {
        id: 4,
        usage: {
          ...emptyAggregatedModelUsage(),
          inputTokens: input,
          provenance: {
            ...emptyAggregatedModelUsage().provenance,
            inputTokens: "provider" as const,
          },
        },
      };
      old.latestCompletedResponse = oldResponse;
      const initial = {
        ...worldView(old),
        playTimeline: {
          worldId: old.worldId,
          generation: "cross-context",
          activeChainId: old.chainId,
          activeStatus: old.status,
          activeCanRetry: false,
          activeLastFailure: null,
          items: [
            {
              kind: "event" as const,
              chainId: old.chainId,
              current: true,
              event: {
                id: 4,
                kind: "assistant" as const,
                text: "The story in A.",
                status: "completed" as const,
                exchange: 1,
                attempt: 1,
                usage: oldResponse.usage,
                hasReasoning: false,
                hasToolFragment: false,
                hasUsage: true,
                detailsAvailable: true,
              },
            },
          ],
          nextCursor: null,
        } satisfies V1PlayTimelinePage,
      };
      const latest = {
        ...worldView(null),
        playTimeline: {
          ...initial.playTimeline,
          activeChainId: "chain-b",
          activeStatus: "running" as const,
          items: initial.playTimeline.items.map((item) => ({
            ...item,
            current: false,
          })),
        },
      };
      let advanced = false;
      let receive: Parameters<ObserveConversation>[1] | undefined;
      const client = {
        observeConversation: ((_target, callback) => {
          receive = callback;
          return () => undefined;
        }) satisfies ObserveConversation,
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read")
            return Promise.resolve(advanced ? latest : initial);
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client);
      await screen.findByText(`上下文 ${input / 100}%`);
      expect(screen.queryByText(/上下文已用 90%/u) !== null).toBe(
        input === 9_000,
      );
      // The observation is A, but a peer opens B before its hydration read.
      advanced = true;
      act(() => void receive?.({ kind: "play", value: old }, true));
      const label = await screen.findByText("上下文 —");
      expect(label.title).toBe("当前上下文尚无已完成的 AI 响应。");
      expect(screen.queryByText(`上下文 ${input / 100}%`)).toBeNull();
      expect(screen.queryByText(/上下文已用 90%/u)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "下一条消息使用全新上下文" }),
      ).toBeNull();
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("你的行动").disabled,
      ).toBe(true);
      expect(
        client.request.mock.calls.filter(
          ([request]) => request.type === "world.read",
        ),
      ).toHaveLength(2);
      expect(
        client.request.mock.calls.some(([request]) =>
          [
            "play.chain.inspect",
            "play.timeline.page",
            "play.timeline.detail",
            "world.surface.read",
          ].includes(request.type),
        ),
      ).toBe(false);
    },
  );

  test.each([
    ["ready", "ready", 9_000, "command"],
    ["running", "ready", 9_000, "command"],
    ["ready", "ready", null, "command"],
    ["ready", "running", 9_000, "command"],
    ["ready", "ready", 9_000, "observation"],
    ["running", "ready", 9_000, "observation"],
    ["ready", "ready", null, "observation"],
    ["ready", "running", 9_000, "observation"],
  ] as const)(
    "断线后跨页同链推进的轻量读取更新占用和发送状态：旧 %s，新 %s，input %s，%s",
    async (oldStatus, latestStatus, input, trigger) => {
      const old = playChainView("cross-page-chain", "first", "Look around.");
      old.contextWindowTokens = 10_000;
      const oldUsage = {
        ...emptyAggregatedModelUsage(),
        inputTokens: 6_200,
        provenance: {
          ...emptyAggregatedModelUsage().provenance,
          inputTokens: "provider" as const,
        },
      };
      old.latestCompletedResponse = { id: 4, usage: oldUsage };
      const latestResponse = {
        id: 6,
        kind: "assistant" as const,
        text: "The other page has advanced the story.",
        status: "completed" as const,
        responseKind: "narrative" as const,
        exchange: 3,
        attempt: 1,
        committedHead: "commit:5",
        hasReasoning: false,
        hasToolFragment: false,
        hasUsage: input !== null,
        detailsAvailable: input !== null,
        ...(input === null
          ? {}
          : { usage: { ...oldUsage, inputTokens: input } }),
      };
      const latestTimeline: V1PlayTimelinePage = {
        worldId: "world-one",
        generation: "same-context",
        activeChainId: old.chainId,
        activeStatus: latestStatus,
        activeCanRetry: false,
        activeLastFailure: null,
        items: [
          {
            kind: "event",
            chainId: old.chainId,
            current: true,
            event: latestResponse,
          },
        ],
        nextCursor: null,
      };
      let advanced = false;
      let onConnection: Parameters<ObserveConversation>[2] | undefined;
      let receive: Parameters<ObserveConversation>[1] | undefined;
      const client = {
        observeConversation: ((_target, callback, connection) => {
          receive = callback;
          onConnection = connection;
          return () => undefined;
        }) satisfies ObserveConversation,
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read")
            return Promise.resolve(
              advanced
                ? {
                    ...worldView(null),
                    head: "commit:5",
                    playTimeline: latestTimeline,
                  }
                : {
                    ...worldView(old),
                    playTimeline: {
                      ...latestTimeline,
                      activeStatus: "ready",
                      items: [
                        {
                          kind: "event",
                          chainId: old.chainId,
                          current: true,
                          event: {
                            ...latestResponse,
                            id: 4,
                            usage: oldUsage,
                            committedHead: old.parentHead,
                          },
                        },
                      ],
                    },
                  },
            );
          if (request.type === "play.chain.append") {
            // A peer advances the same chain after this reply, while SSE is
            // disconnected and before the local post-command world.read.
            advanced = true;
            return Promise.resolve({ ...old, status: oldStatus });
          }
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client);
      await screen.findByText("上下文 62%");
      act(() => onConnection?.("reconnecting"));
      if (trigger === "command")
        fireEvent.click(screen.getByRole("button", { name: "继续故事" }));
      else {
        advanced = true;
        act(
          () =>
            void receive?.(
              { kind: "play", value: { ...old, status: oldStatus } },
              true,
            ),
        );
      }
      await screen.findByText(input === null ? "上下文 —" : "上下文 90%");
      expect(screen.queryByText("上下文 62%")).toBeNull();
      expect(screen.queryByText(/世界已在当前上下文之外更新/u)).toBeNull();
      await waitFor(() =>
        expect(
          screen.getByRole<HTMLButtonElement>("button", {
            name: latestStatus === "running" ? "追加行动" : "继续故事",
          }).disabled,
        ).toBe(latestStatus === "running"),
      );
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("你的行动").disabled,
      ).toBe(latestStatus === "running");
      expect(screen.queryByText(/上下文已用 90%/u) !== null).toBe(
        input !== null,
      );
      if (latestStatus === "ready") {
        fireEvent.change(screen.getByLabelText("你的行动"), {
          target: { value: "Continue from the latest reply." },
        });
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "追加行动" })
            .disabled,
        ).toBe(false);
      }
      expect(
        client.request.mock.calls.filter(
          ([request]) => request.type === "world.read",
        ),
      ).toHaveLength(trigger === "command" ? 3 : 2);
      expect(
        client.request.mock.calls.some(([request]) =>
          [
            "play.chain.inspect",
            "play.timeline.page",
            "play.timeline.detail",
            "world.surface.read",
          ].includes(request.type),
        ),
      ).toBe(false);
    },
  );

  test.each(["imported", "revised"])(
    "必需全新上下文的世界不显示旧占用：%s",
    async (kind) => {
      const chain = playChainView("old-usage", "first", "Look around.");
      chain.contextWindowTokens = 10000;
      chain.latestCompletedResponse = {
        id: 4,
        usage: {
          ...emptyAggregatedModelUsage(),
          inputTokens: 70,
          provenance: {
            ...emptyAggregatedModelUsage().provenance,
            inputTokens: "provider",
          },
        },
      };
      const view = worldView(chain);
      const client = {
        request: vi.fn(() =>
          Promise.resolve({
            ...view,
            archiveNeedsFreshContext: kind === "imported",
            head: kind === "revised" ? "commit:revised" : view.head,
          }),
        ),
      };
      renderWorld(client);
      await screen.findByRole("heading", { name: "宿舍世界" });
      expect(screen.getByText("上下文 —").title).toBe(
        "下一次发送将开启全新上下文，尚无实报占用。",
      );
      expect(screen.queryByText("上下文 <1%")).toBeNull();
    },
  );

  test("上下文占用提示预选下一条全新发送，预选本身不调用 Runtime", async () => {
    const current = playChainView("usage-current", "first", "Look around.");
    current.contextWindowTokens = 10_000;
    const assistant = current.events.find(
      (event) => event.kind === "assistant",
    );
    if (assistant?.kind !== "assistant") throw new Error("Expected response");
    assistant.usage = {
      ...emptyAggregatedModelUsage(),
      inputTokens: 8_500,
      provenance: {
        ...emptyAggregatedModelUsage().provenance,
        inputTokens: "provider",
      },
    };
    let active = current;
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(active));
        if (request.type === "play.chain.start") {
          active = playChainView(
            request.chainId,
            request.exchangeId,
            request.playerText,
          );
          active.contextWindowTokens = 10_000;
          return Promise.resolve(active);
        }
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client);
    await screen.findByText("上下文 85%");
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "Continue the story." },
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加行动" })
        .disabled,
    ).toBe(false);
    const count = client.request.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "下一条消息使用全新上下文" }),
    );
    expect(client.request).toHaveBeenCalledTimes(count);
    expect(screen.getByLabelText("你的行动")).toBe(document.activeElement);
    expect(screen.queryByText(/上下文已用/u)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "从全新上下文发送行动" }),
    );
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "play.chain.start",
          playerText: "Continue the story.",
        }),
      ),
    );
    await screen.findByText("上下文 —");
    expect(active.chainId).not.toBe(current.chainId);
    expect(screen.queryByText(/上下文已用/u)).toBeNull();
  });

  test("正文产物只挂实际回复，早期分页不误挂或重复，旧无归属产物不挂载", async () => {
    const chain = playChainView("attached-chain", "send", "行动");
    const decorations = playDecorations(
      "属于早期回复",
      "world-one",
      "commit:3",
    );
    decorations.artifacts[0]!.frontend.mount = "story";
    decorations.artifacts[0]!.reply = { chainId: chain.chainId, eventId: 4 };
    const legacy = structuredClone(decorations.artifacts[0]!);
    legacy.recordId = "unproven-legacy";
    legacy.payload = "不能猜测归属";
    delete legacy.reply;
    decorations.artifacts.push(legacy);
    const early: V1PlayTimelinePage = {
      worldId: "world-one",
      activeLastFailure: null,
      generation: "page-gen",
      items: [
        {
          kind: "event",
          chainId: chain.chainId,
          current: true,
          event: {
            id: 4,
            kind: "assistant",
            text: `## 早期 AI 原文\n\n${"久远的雪夜。\n\n".repeat(300)}**结尾还在。**`,
            status: "completed",
            responseKind: "narrative",
            exchange: 2,
            attempt: 1,
            committedHead: "commit:3",
            hasReasoning: false,
            hasToolFragment: false,
            hasUsage: false,
            detailsAvailable: false,
          },
        },
      ],
      nextCursor: null,
      activeChainId: chain.chainId,
      activeStatus: "ready",
      activeCanRetry: false,
    };
    const late: V1PlayTimelinePage = {
      ...early,
      items: [],
      nextCursor: "earlier",
    };
    let pageReads = 0;
    const client = {
      request: vi.fn(<T>(request: V1Request): Promise<T> => {
        if (request.type === "world.play-decorations.read")
          return Promise.resolve(decorations as T);
        if (request.type === "play.timeline.page") {
          if (++pageReads <= 2)
            return Promise.reject(new Error("page offline"));
          return Promise.resolve(early as T);
        }
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        return Promise.resolve({
          ...worldView(chain),
          playTimeline: late,
        } as T);
      }),
    };
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    expect(screen.queryByTitle("panel")).toBeNull();
    expect(screen.queryByRole("heading", { name: "早期 AI 原文" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更早的故事" }));
    await screen.findByText("暂时无法同步");
    expect(pageReads).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    const heading = await screen.findByRole("heading", {
      name: "早期 AI 原文",
    });
    expect(pageReads).toBe(3);
    await waitFor(() => expect(screen.getAllByTitle("panel")).toHaveLength(1));
    const reply = heading.closest("article")!;
    expect(within(reply).getByText("结尾还在。").tagName).toBe("STRONG");
    expect(within(reply).getByTitle("panel").getAttribute("srcdoc")).toContain(
      "属于早期回复",
    );
  });

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
    expect(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "发送第一步行动",
      }).disabled,
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

  test("此刻面板支持拖拽、键盘调宽和恢复默认，收起后保留宽度", async () => {
    renderWorld(readOnlyClient());
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "此刻" }));
    const handle = screen.getByRole("separator", { name: "调整此刻面板宽度" });
    const panel = screen.getByLabelText("当前情景");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 320,
    } as DOMRect);
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    function pointer(type: string, x: number): void {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(handle, event);
    }
    pointer("pointerdown", 320);
    pointer("pointermove", 520);
    pointer("pointerup", 520);
    expect(handle.getAttribute("aria-valuenow")).toBe("520");
    pointer("pointermove", 600);
    expect(handle.getAttribute("aria-valuenow")).toBe("520");
    fireEvent.click(screen.getByRole("button", { name: "收起状态栏" }));
    fireEvent.click(screen.getByRole("button", { name: "此刻" }));
    expect(handle.getAttribute("aria-valuenow")).toBe("520");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("720");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
  });

  test("手机游玩输入框放行换行，不触发模型请求", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const client = readOnlyClient();
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    const input = screen.getByLabelText<HTMLTextAreaElement>("你的行动");
    fireEvent.change(input, { target: { value: "第一行" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    expect(input.value).toBe("第一行\n第二行");
    expect(input.getAttribute("enterkeyhint")).toBe("enter");
    expect(
      client.request.mock.calls.some(
        ([request]) =>
          request.type === "play.chain.start" ||
          request.type === "play.chain.append",
      ),
    ).toBe(false);
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
        showTechnicalInfo: false,
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
    composer.style.border = "0";
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
        "记录显示实际发给模型的内容和工具返回的结果，无法确认模型记住了什么或会怎么做。",
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
    expect(within(dialog).getByText("AI 读取记录与发送预览")).toBeTruthy();
    expect(within(dialog).getByText("查看下次编译材料")).toBeTruthy();
    expect(
      within(dialog).getAllByText("最近一次请求材料").length,
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole("heading", { name: "AI 在这段对话中读过" }),
    ).toBeTruthy();
    expect(within(dialog).getAllByText("标题 + 摘要").length).toBeGreaterThan(
      0,
    );
    fireEvent.click(within(dialog).getByText("查看按需读取返回的完整记录"));
    expect(within(dialog).getByText(/独立淋浴间: true/u)).toBeTruthy();
    expect(
      within(dialog).getAllByText("下次发送的世界内容预览").length,
    ).toBeGreaterThan(0);
  });

  test.each(["apply", "discard"] as const)(
    "世界修订 %s 成功后读取失败，明确提示刷新失败且不重复发布",
    async (action) => {
      const epoch = worldRevisionEpoch([]);
      let finished = false;
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read") {
            if (finished)
              return Promise.reject(new Error("refresh unavailable"));
            return Promise.resolve({
              ...worldView(null),
              worldRevision: epoch,
            });
          }
          if (request.type === "world.revision.overview")
            return Promise.resolve(worldRevisionOverview(epoch));
          if (request.type === `world.revision.${action}`) {
            finished = true;
            return Promise.resolve(
              worldRevisionOverview({
                ...epoch,
                locked: false,
                lifecycle: action === "apply" ? "applied" : "discarded",
              }),
            );
          }
          if (request.type === "world.play-decorations.read")
            return Promise.resolve({
              head: "commit:3",
              artifacts: [],
              extensions: [],
              artifactDebug: [],
            });
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client);
      await screen.findByRole("heading", { name: "宿舍世界" });
      fireEvent.click(screen.getByRole("button", { name: "世界" }));
      fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
      await screen.findByRole("heading", { name: /宿舍世界.*世界修订/u });
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: action === "apply" ? "应用并解锁" : "放弃",
      });
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.click(button);
      if (action === "discard")
        fireEvent.click(
          within(
            screen.getByRole("dialog", {
              name: /所有尚未应用的手动和 AI 修改/,
            }),
          ).getByRole("button", { name: "放弃" }),
        );
      const expected =
        action === "apply"
          ? "世界修订已应用并解锁，但刷新世界失败。请重新打开世界：暂时无法同步"
          : "这次世界修订已放弃，原世界保持不变并已解锁，但刷新世界失败。请重新打开世界：暂时无法同步";
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expected,
      );
      expect(
        screen.queryByRole("heading", { name: /宿舍世界.*世界修订/u }),
      ).toBeNull();
      expect(
        client.request.mock.calls.filter(
          ([request]) => request.type === `world.revision.${action}`,
        ),
      ).toHaveLength(1);
    },
  );

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
        if (request.type === "world.surface.read")
          return Promise.resolve(
            (request.surface === "state"
              ? original
              : request.surface === "control"
                ? worldView(chain).control
                : request.surface === "revision"
                  ? revisionFiles
                  : {}) as T,
          );
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
            worldRevisionOverview(
              opened || applied ? epoch : null,
              sealedEpochs,
            ) as T,
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

    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "world.revision.open",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "返回游玩" }));
    await screen.findByRole("heading", { name: "宿舍世界" });
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("你的行动").disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
    await screen.findByRole("heading", { name: /宿舍世界.*世界修订/u });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "删除文件" })
        .disabled,
    ).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>("文件路径").disabled).toBe(
      false,
    );
    fireEvent.change(
      screen.getByLabelText("编辑 state/current-situation.yaml"),
      {
        target: { value: original[0]!.contents },
      },
    );
    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "world.revision.open",
      ),
    ).toBe(false);
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
    await screen.findByText("世界已锁定到这份修订；关闭页面也会保留工作树。");
    expect(screen.getByText("有未保存修改")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "应用并解锁" })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存到修订" }));
    expect(await screen.findByText("手动编辑")).toBeTruthy();
    expect(screen.getByText("修订记录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回游玩" }));
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
    fireEvent.click(within(lockedManagement).getByText("世界控制 · 高级编辑"));
    const lockedSource = await within(lockedManagement).findByRole("textbox", {
      name: "编辑 control/player-views.yaml",
    });
    expect(lockedSource.matches(":disabled")).toBe(true);
    fireEvent.click(
      within(lockedManagement).getByRole("button", { name: "关闭" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续修订" }));
    await screen.findByRole("heading", { name: /宿舍世界.*世界修订/u });
    fireEvent.click(screen.getByRole("button", { name: "应用并解锁" }));
    expect(
      await screen.findByText(
        "世界修订已应用并解锁。再次继续原对话时，AI 会先重新读取当前世界。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "接着当前对话继续",
      }).disabled,
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
    fireEvent.click(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    );

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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I signal Alex to open the door." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    );

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
    const trace = screen.getByText("本段调用详情").closest("details");
    expect(trace?.open).toBe(false);
    expect(trace?.contains(screen.getByText("调用 world_patch"))).toBe(true);
    expect(screen.getByText("调用 world_patch").closest("details")?.open).toBe(
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
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

  test("详细模式显示输入、缓存读写、推理和输出 token 明细", async () => {
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
    let detailReads = 0;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.timeline.detail") {
          if (++detailReads <= 2)
            return Promise.reject(new Error("detail offline"));
          return Promise.resolve(
            chain.events.find(({ id }) => id === request.eventId) as T,
          );
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByText("Alex opens the door and lets you go first.");

    const compact = screen.getByLabelText("Token 用量明细");
    expect(within(compact).getByText("1,200")).toBeTruthy();
    expect(within(compact).getByText("700")).toBeTruthy();
    expect(within(compact).getByText("400")).toBeTruthy();
    expect(within(compact).getByText("100")).toBeTruthy();
    expect(within(compact).getByText("80")).toBeTruthy();
    expect(within(compact).getByText("240")).toBeTruthy();
    expect(within(compact).getByText("1,440")).toBeTruthy();

    const usage = screen
      .getByText(/调用量详情 · 输入 1,200 · 输出 240 tokens/u)
      .closest("details")!;
    expect(usage.open).toBe(false);
    fireEvent.click(usage.querySelector("summary")!);
    expect(within(usage).getAllByText("Provider 报告").length).toBeGreaterThan(
      0,
    );
    const details = screen.getByText("模型推理").closest("details");
    expect(details).not.toBeNull();
    fireEvent.click(details!.querySelector("summary")!);
    await within(details!).findByText("暂时无法同步");
    expect(detailReads).toBe(2);
    fireEvent.click(within(details!).getByRole("button", { name: "重新加载" }));
    await waitFor(() =>
      expect(within(details!).queryByText("暂时无法同步")).toBeNull(),
    );
    expect(detailReads).toBe(3);
    expect(
      await within(details!).findByText(
        "First confirm that the doorway is clear.",
      ),
    ).toBeTruthy();
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByText("调用 context_search");
    expect(
      screen.queryByText(
        "Earlier-context reasoning that should remain visible.",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByText("模型推理").closest("summary")!);
    expect(
      await screen.findByText(
        "Earlier-context reasoning that should remain visible.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("调用 context_search")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "Continue from the fresh context." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    );

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

  test("没有既有上下文时发送第一步行动会从当前世界开始", async () => {
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
    fireEvent.click(screen.getByLabelText("更多"));
    fireEvent.click(
      within(screen.getByRole("group", { name: "立即发送" })).getByRole(
        "button",
        {
          name: "发送第一步行动",
        },
      ),
    );

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
    let emitFrame: ((frame: V1PlayCallChainStreamFrame) => void) | undefined;
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
        emitFrame = onFrame;
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I signal Alex to open the door." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    );

    expect(await screen.findByText("Alex is opening the door")).toBeTruthy();
    const progress = screen.getByRole("status", {
      name: "本次模型调用进度",
    });
    expect(within(progress).getByText("正在输出正文…")).toBeTruthy();
    expect(within(progress).getByText("40 字")).toBeTruthy();
    expect(within(progress).getByText("24 字")).toBeTruthy();
    expect(screen.getByText("接收中")).toBeTruthy();
    expect(screen.getByText("待定输出；响应完成前不会进入故事")).toBeTruthy();
    expect(
      screen.queryByText(
        "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
      ),
    ).toBeNull();
    expect(screen.queryByText("查看模型诊断详情")).toBeNull();
    const reasoning = screen.getByText("模型推理");
    expect(reasoning.closest("details")?.open).toBe(false);
    fireEvent.click(reasoning);
    expect(
      screen.getByText("First confirm that the doorway is clear."),
    ).toBeTruthy();
    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "play.timeline.detail",
      ),
    ).toBe(false);
    act(() =>
      emitFrame?.({
        kind: "assistant_delta",
        eventId: 2,
        deltaKind: "reasoning",
        text: " Then check the corridor.",
        updatedAt: Date.now(),
      }),
    );
    expect(
      screen.getByText(
        "First confirm that the doorway is clear. Then check the corridor.",
      ),
    ).toBeTruthy();
    expect(reasoning.closest("details")?.open).toBe(true);
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
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            ...worldView(chain),
            playerViewPanels: [],
            artifactDebug: [],
          } as T);
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
      fireEvent.click(
        screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
      );

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
        reasoningChars: "Recovered Provider reasoning.".length,
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
          reasoning: "Recovered Provider reasoning.",
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
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            ...worldView(chain),
            playerViewPanels: [],
            artifactDebug: [],
          } as T);
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    const progress = await screen.findByRole("status", {
      name: "本次模型调用进度",
    });
    await waitFor(() =>
      expect(within(progress).getByText(/模型调用可能已经卡住/u)).toBeTruthy(),
    );
    const recovered = screen.getByText("Recovered Provider reasoning.");
    expect(recovered.closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByText("模型推理"));
    expect(recovered.closest("details")?.open).toBe(true);
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

  test("调用链流失败后保留本地化恢复卡片并折叠技术错误", async () => {
    const failure = "Immutable play-advance fact already has different data";
    let chain: V1PlayCallChainView | null = null;
    const client = {
      request: vi.fn(<T>(request: V1Request) => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "world.play-decorations.read")
          return Promise.resolve({
            ...worldView(chain),
            playerViewPanels: [],
            artifactDebug: [],
          } as T);
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
    fireEvent.click(
      screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("p")?.textContent).toContain("旧请求不能重发");
    expect(alert.querySelector("details")?.open).toBe(false);
    expect(within(alert).getByText(failure)).toBeTruthy();
    expect(within(alert).queryByRole("button")).toBeNull();
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
        stopReason: "tool_use",
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
        stopReason: "end_turn",
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByRole("heading", { name: "宿舍世界" });
    const timeline = screen.getByLabelText("模型调用链");
    expect(
      within(timeline).getByText(
        "Alex checks the latch and pulls the door shut.",
      ),
    ).toBeTruthy();
    expect(within(timeline).getAllByText(intermediate)).toHaveLength(1);
    const summary = within(timeline).getByText("工具调用 · 1 次");
    const calls = within(timeline)
      .getByText("本段调用详情")
      .closest("details")!;
    expect(calls.open).toBe(false);
    expect(
      summary.closest("section")?.querySelector("header")?.textContent,
    ).toContain("停止原因：tool_use");
    expect(within(calls).getByText(/停止原因：end_turn/u)).toBeTruthy();
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
  });

  test("判定工具结果在故事中显示卡片，普通工具结果与判定轨迹仍只在调用详情中", async () => {
    const chain = playChainView(
      "play-chain-resolution",
      "exchange-resolution",
      "我推开石门。",
    );
    chain.parentHead = "commit:4";
    chain.events = [
      chain.events[0]!,
      {
        id: 2,
        kind: "tool_call",
        callId: "door-check",
        name: "d20_check",
        arguments: { goal: "推开石门", modifier: 3, difficulty: 15 },
        replayed: false,
      },
      {
        id: 3,
        kind: "tool_result",
        callId: "door-check",
        name: "d20_check",
        ok: true,
        markdown: "d20 14 + 3 = 17",
        replayed: false,
        resolution: {
          kind: "d20",
          goal: "推开石门",
          modifier: 3,
          difficulty: 15,
          mode: "normal",
          dice: [14],
          selected: 14,
          total: 17,
          margin: 2,
          outcome: "success",
        },
      },
      {
        id: 4,
        kind: "tool_result",
        callId: "patch-tool",
        name: "world_patch",
        ok: true,
        markdown: "@current-situation write succeeded",
        replayed: false,
      },
      {
        id: 5,
        kind: "assistant",
        text: "石门缓缓打开。",
        status: "completed",
        responseKind: "narrative",
        exchange: 1,
        attempt: 1,
        committedHead: "commit:5",
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    await screen.findByRole("heading", { name: "宿舍世界" });
    const timeline = screen.getByLabelText("模型调用链");
    const card = within(timeline).getByRole("article", { name: "判定结果" });
    expect(card.textContent).toContain(
      "推开石门 · d20 14 + 3 = 17 ≥ 15 · 成功",
    );
    expect(card.closest(".world-timeline-trace")).toBeNull();
    expect(card.closest(".call-chain-resolution")).not.toBeNull();
    fireEvent.click(latestNarratorActions(timeline)!);
    expect(
      within(timeline).getByRole("button", { name: "只重写这段正文" }),
    ).toBeTruthy();
    expect(
      within(timeline).queryByRole("button", { name: "整轮重来" }),
    ).toBeNull();

    const trace = timeline.querySelector(".model-call-list");
    expect(trace).not.toBeNull();
    expect(
      within(trace as HTMLElement).getByText("调用 world_patch"),
    ).toBeTruthy();
    expect(
      within(trace as HTMLElement).getByText("调用 d20_check"),
    ).toBeTruthy();
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
      renderWorld(client, undefined, {
        initialReadingPreferences: {
          ...defaultAppReadingPreferences,
          showTechnicalInfo: true,
        },
      });
      await screen.findByRole("heading", { name: "宿舍世界" });
      scrollIntoView.mockClear();
      fireEvent.change(screen.getByLabelText("你的行动"), {
        target: { value: "I signal Alex to open the door." },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "用新对话继续（保留故事进度）" }),
      );
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
      renderWorld(client, undefined, {
        initialReadingPreferences: {
          ...defaultAppReadingPreferences,
          showTechnicalInfo: true,
        },
      });
      await screen.findByText(
        "The visible tail starts in the middle of one context.",
      );
      fireEvent.change(screen.getByLabelText("你的行动"), {
        target: { value: "I continue inside the same model context." },
      });
      fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));

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
        screen.queryByText(
          "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
        ),
      ).toBeNull();
    } finally {
      await act(async () => {
        finishStream?.();
        await Promise.resolve();
      });
      cleanup();
    }
  });

  test("并发协议切换被 Runtime 拒绝时保留玩家输入和追加入口", async () => {
    const chain = {
      ...playChainView("existing", "first", "Begin."),
      modelProtocol: "chat_completions" as const,
    };
    let incompatible = true;
    const client = {
      request: vi.fn(<T>(request: V1Request): Promise<T> => {
        if (request.type === "world.read")
          return Promise.resolve(worldView(chain) as T);
        if (request.type === "artifacts.debug") return Promise.resolve([] as T);
        if (request.type === "play.chain.inspect")
          return Promise.resolve(chain as T);
        if (request.type === "play.chain.append") {
          if (incompatible)
            return Promise.reject(
              new RuntimeRequestError("Protocol differs", {
                protocolCode: "model_protocol_mismatch",
              }),
            );
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client, undefined, { activeModelProtocol: "chat_completions" });
    await screen.findByText("Alex opens the door and lets you go first.");
    expect(screen.queryByText(/当前模型协议与此上下文不同/u)).toBeNull();
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "Continue after switching back." },
    });
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));
    const notice = await screen.findByText(
      "当前模型协议与此上下文不同。切回原协议即可继续；使用新协议请开启全新上下文。",
    );
    expect(notice.closest("details")).toBeNull();
    expect(screen.queryByText("调用链中断")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "接着当前对话继续",
      }).disabled,
    ).toBe(false);
    expect(screen.getByLabelText<HTMLTextAreaElement>("你的行动").value).toBe(
      "Continue after switching back.",
    );
    incompatible = false;
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));
    await waitFor(() =>
      expect(
        client.request.mock.calls.filter(
          ([request]) => request.type === "play.chain.append",
        ),
      ).toHaveLength(2),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));

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

  test("本轮临时要求默认收起，展开即聚焦，结算后清空并收起", async () => {
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
          chain = { ...chain, parentHead: "commit:5", updatedAt: 2 };
          return Promise.resolve(chain as T);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");
    const more = screen.getByLabelText("更多");
    fireEvent.click(more);
    const toggle = screen.getByRole("button", { name: "本轮临时要求" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByLabelText("本轮临时要求内容")).toBeNull();

    fireEvent.click(toggle);
    const note = screen.getByLabelText<HTMLInputElement>("本轮临时要求内容");
    expect(note).toBe(document.activeElement);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(note, { target: { value: "写得更细一些" } });
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "I walk into the corridor." },
    });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("本轮临时要求内容")).toBeNull(),
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const append = client.request.mock.calls
      .map(([request]) => request)
      .find(
        (
          request,
        ): request is Extract<V1Request, { type: "play.chain.append" }> =>
          request.type === "play.chain.append",
      );
    expect(append).toMatchObject({ turnNote: "写得更细一些" });
  });

  test("在此收尾只填写可编辑要求，保留手写内容且重复点击不重复追加", async () => {
    const client = {
      request: vi.fn(() => Promise.resolve(worldView(null))),
    };
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    const more = screen.getByLabelText("更多");
    fireEvent.click(more);
    const shortcut = screen.getByRole("button", { name: "在此收尾" });
    fireEvent.click(shortcut);
    const note = screen.getByLabelText<HTMLInputElement>("本轮临时要求内容");
    expect(note).toBe(document.activeElement);
    expect(note.value).toBe(
      "这段就在这里收尾，保存后续需要的信息，并登记检查点。",
    );
    expect(client.request.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ type: "play.chain.start" }),
    );
    fireEvent.change(note, { target: { value: "保留夜晚的氛围。" } });
    fireEvent.keyDown(note, { key: "Escape" });
    fireEvent.click(more);
    fireEvent.click(shortcut);
    fireEvent.click(more);
    fireEvent.click(shortcut);
    expect(
      screen.getByLabelText<HTMLInputElement>("本轮临时要求内容").value,
    ).toBe(
      "保留夜晚的氛围。 这段就在这里收尾，保存后续需要的信息，并登记检查点。",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "清空并收起本轮临时要求" }),
    );
    expect(screen.queryByLabelText("本轮临时要求内容")).toBeNull();
    fireEvent.click(more);
    fireEvent.click(shortcut);
    expect(
      screen.getByLabelText<HTMLInputElement>("本轮临时要求内容").value,
    ).toBe("这段就在这里收尾，保存后续需要的信息，并登记检查点。");
  });

  test.each(["model", "running", "revision"] as const)(
    "配置模型前可以准备草稿，生成或修订期间锁定输入：%s",
    async (blockedBy) => {
      const chain = playChainView("existing", "first", "I wait.");
      const client = {
        request: vi.fn(() =>
          Promise.resolve({
            ...worldView(
              blockedBy === "running" ? { ...chain, status: "running" } : null,
            ),
            ...(blockedBy === "revision"
              ? { worldRevision: worldRevisionEpoch([]) }
              : {}),
          }),
        ),
      };
      renderWorld(client, undefined, {
        modelConfigured: blockedBy !== "model",
      });
      await screen.findByRole("heading", { name: "宿舍世界" });
      fireEvent.click(screen.getByLabelText("更多"));
      await waitFor(() => {
        const draftLocked = blockedBy !== "model";
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "在此收尾" })
            .disabled,
        ).toBe(draftLocked);
        expect(
          screen.getByRole<HTMLButtonElement>("button", {
            name: "本轮临时要求",
          }).disabled,
        ).toBe(draftLocked);
        expect(
          screen.getByLabelText<HTMLTextAreaElement>("你的行动").disabled,
        ).toBe(draftLocked);
      });
    },
  );

  test("本轮临时要求 Escape 收起但保留文字，并以强调态提示仍带着要求", async () => {
    const chain = playChainView(
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
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };

    renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");
    const more = screen.getByLabelText("更多");
    fireEvent.click(more);
    const toggle = screen.getByRole("button", { name: "本轮临时要求" });
    fireEvent.click(toggle);
    const note = screen.getByLabelText<HTMLInputElement>("本轮临时要求内容");
    fireEvent.change(note, { target: { value: "多写些环境描写" } });
    fireEvent.keyDown(note, { key: "Escape" });

    expect(screen.queryByLabelText("本轮临时要求内容")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(more.classList.contains("has-turn-note")).toBe(true);
    fireEvent.click(more);
    fireEvent.click(toggle);
    expect(
      screen.getByLabelText<HTMLInputElement>("本轮临时要求内容").value,
    ).toBe("多写些环境描写");
  });

  test("中断后留空点击追加只发送原上下文，不产生另一条玩家指令或重试事件", async () => {
    let chain = interruptedChainView();
    chain.lastFailureKind = "outcome_unknown";
    const failure = chain.events.at(-1);
    if (failure?.kind === "failure") failure.failureKind = "outcome_unknown";
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

    renderWorld(client, undefined, {
      initialReadingPreferences: {
        ...defaultAppReadingPreferences,
        showTechnicalInfo: true,
      },
    });
    expect(
      await screen.findByText("Alex has opened the door halfway"),
    ).toBeTruthy();
    expect(screen.getByText(/可以使用当前选中的兼容连接/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

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

  test("取消后的可恢复请求以状态提供重新发送", async () => {
    const chain = interruptedChainView();
    chain.events[chain.events.length - 1] = {
      id: 3,
      kind: "cancellation",
      message: "Cancelled",
    };
    const request = vi.fn(<T>(input: V1Request) => {
      if (input.type === "world.read")
        return Promise.resolve(worldView(chain) as T);
      if (input.type === "artifacts.debug") return Promise.resolve([] as T);
      if (input.type === "play.chain.inspect")
        return Promise.resolve(chain as T);
      if (input.type === "play.chain.append")
        return Promise.resolve({
          ...chain,
          status: "ready",
          canRetry: false,
        } as T);
      return Promise.reject(new Error(`Unexpected request: ${input.type}`));
    });
    renderWorld({ request });
    const button = await screen.findByRole("button", { name: "重新发送" });
    expect(button.closest('[role="status"]')).not.toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.type === "play.chain.append" && input.playerText === "",
        ),
      ).toBe(true),
    );
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
    fireEvent.click(
      within(copiedPlayerMessage).getByRole("button", { name: "玩家消息操作" }),
    );
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
      screen.getByRole<HTMLButtonElement>("button", {
        name: "用新对话继续（保留故事进度）",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "接着当前对话继续",
      }).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));

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
    const timeline = within(screen.getByLabelText("模型调用链"));
    fireEvent.click(
      timeline.getAllByRole("button", { name: "玩家消息操作" })[0]!,
    );
    fireEvent.click(timeline.getByRole("button", { name: "创建分叉" }));

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

  test("只在最新已提交正文旁显示重新生成，工具轨迹不阻断玩家锚点", async () => {
    const chain = playChainView("latest-chain", "first-send", "第一次行动");
    const player = chain.events[0]!;
    const assistant = chain.events[3]!;
    if (player.kind !== "player" || assistant.kind !== "assistant")
      throw new Error("Invalid play fixture");
    chain.events.push(
      { ...player, id: 5, text: "第二次行动", committedHead: "commit:4" },
      { ...assistant, id: 6, text: "新的工具步骤", responseKind: "tool_step" },
      { ...assistant, id: 7, text: "最新正文", committedHead: "commit:5" },
    );
    const client = {
      request: vi.fn(() => Promise.resolve(worldView(chain))),
    };
    renderWorld(client);
    const latest = (await screen.findByText("最新正文")).closest("article")!;
    const trigger = within(latest).getByRole("button", {
      name: "主持消息操作",
    });
    fireEvent.click(trigger);
    expect(
      within(latest).getByRole("button", { name: "创建分叉" }),
    ).toBeTruthy();
    expect(
      within(latest).getByRole("button", { name: "只重写这段正文" }),
    ).toBeTruthy();
    expect(
      within(latest).getByRole("button", { name: "整轮重来" }),
    ).toBeTruthy();
    fireEvent.click(trigger);
    const older = within(
      screen
        .getByText("Alex opens the door and lets you go first.")
        .closest("article")!,
    );
    fireEvent.click(older.getByRole("button", { name: "主持消息操作" }));
    expect(older.queryByRole("group", { name: "重新生成" })).toBeNull();
  });

  test("已展开的重新生成菜单会随忙碌状态禁用，仍可关闭并返回原焦点", () => {
    const chain = playChainView("latest-chain", "first-send", "推开石门");
    const onRegenerateNarrative = vi.fn();
    const onRegeneratePlayer = vi.fn();
    const timeline = (
      restartDisabled: boolean,
      freshContextDisabled: boolean,
    ) =>
      createElement(PlayTimeline, {
        client: {
          request: () => Promise.reject(new Error("Unexpected request")),
        },
        worldId: chain.worldId,
        items: lightweightPlayTimeline(chain).items,
        liveChain: null,
        restartDisabled,
        freshContextDisabled,
        showTechnicalInfo: false,
        onRestartFrom: vi.fn(),
        onEditPlayer: vi.fn(),
        onRegenerateNarrative,
        onRegeneratePlayer,
      });
    const { rerender } = render(timeline(false, false), {
      wrapper: ({ children }) =>
        createElement(
          ArtifactExtensionHost,
          {
            worldId: chain.worldId,
            artifacts: [],
            playerViews: { views: [] },
            onSetComposerDraft: () => undefined,
            onRefresh: () => undefined,
          },
          children,
        ),
    });
    const trigger = latestNarratorActions(screen.getByLabelText("模型调用链"))!;
    fireEvent.click(trigger);
    const rewrite = screen.getByRole("button", { name: "只重写这段正文" });
    const redo = screen.getByRole("button", { name: "整轮重来" });
    expect(rewrite.getAttribute("aria-disabled")).toBe("false");
    expect(redo.getAttribute("aria-disabled")).toBe("false");
    rewrite.focus();
    rerender(timeline(true, false));
    expect(rewrite.getAttribute("aria-disabled")).toBe("true");
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(rewrite);
    fireEvent.click(redo);
    fireEvent.keyDown(rewrite, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("group", { name: "重新生成" })).toBeNull();
    expect(onRegenerateNarrative).not.toHaveBeenCalled();
    expect(onRegeneratePlayer).not.toHaveBeenCalled();

    rerender(timeline(false, true));
    fireEvent.click(trigger);
    const noModelRewrite = screen.getByRole("button", {
      name: "只重写这段正文",
    });
    expect(noModelRewrite.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(noModelRewrite);
    fireEvent.click(screen.getByRole("button", { name: "整轮重来" }));
    expect(onRegenerateNarrative).not.toHaveBeenCalled();
    expect(onRegeneratePlayer).toHaveBeenCalledExactlyOnceWith(
      chain.chainId,
      1,
      "推开石门",
      false,
    );
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("group", { name: "重新生成" })).toBeNull();

    rerender(timeline(false, false));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "只重写这段正文" }));
    expect(onRegenerateNarrative).toHaveBeenCalledExactlyOnceWith(
      chain.chainId,
      4,
    );
    expect(onRegeneratePlayer).toHaveBeenCalledTimes(1);
  });

  test.each([
    "空输入续写",
    "未提交玩家消息",
    "genesis 玩家消息",
    "未提交主持正文",
    "工具步骤",
    "其他调用链的玩家消息",
    "玩家锚点尚未加载",
    "生成进行中",
    "世界修订锁定",
  ])("重新生成保护边界：%s", async (scenario) => {
    const chain = playChainView("guarded-chain", "send", "原玩家输入");
    const player = chain.events[0]!;
    const assistant = chain.events[3]!;
    if (player.kind !== "player" || assistant.kind !== "assistant")
      throw new Error("Invalid play fixture");
    let disabled = false;
    switch (scenario) {
      case "空输入续写":
        chain.events.push({ ...assistant, id: 5, text: "续写正文" });
        break;
      case "未提交玩家消息":
        delete player.committedHead;
        break;
      case "genesis 玩家消息":
        player.committedHead = "genesis";
        break;
      case "未提交主持正文":
        delete assistant.committedHead;
        break;
      case "工具步骤":
        assistant.responseKind = "tool_step";
        break;
      case "玩家锚点尚未加载":
        chain.events.shift();
        break;
      case "生成进行中":
        chain.status = "running";
        disabled = true;
        break;
      case "世界修订锁定":
        disabled = true;
        break;
    }
    const timeline: V1PlayTimelinePage = {
      worldId: "world-one",
      generation: "guards",
      activeChainId: chain.chainId,
      activeStatus: chain.status,
      activeCanRetry: false,
      activeLastFailure: null,
      nextCursor: null,
      items: chain.events
        .filter(
          (event) => event.kind === "player" || event.kind === "assistant",
        )
        .map((event) => ({
          kind: "event",
          chainId:
            scenario === "其他调用链的玩家消息" && event.kind === "player"
              ? "other-chain"
              : chain.chainId,
          current: true,
          event: {
            ...event,
            detailsAvailable: false,
            hasReasoning: false,
            hasToolFragment: false,
            hasUsage: false,
          },
        })),
    };
    const client = {
      request: vi.fn(() =>
        Promise.resolve({
          ...worldView(null),
          playTimeline: timeline,
          worldRevision:
            scenario === "世界修订锁定" ? worldRevisionEpoch([]) : null,
        }),
      ),
    };
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    const trigger = latestNarratorActions(screen.getByLabelText("模型调用链"));
    if (scenario === "未提交主持正文" || scenario === "工具步骤") {
      expect(trigger).toBeUndefined();
    } else {
      fireEvent.click(trigger!);
      const rewrite = screen.getByRole("button", { name: "只重写这段正文" });
      expect(rewrite.getAttribute("aria-disabled")).toBe(String(disabled));
      const redo = screen.queryByRole("button", { name: "整轮重来" });
      if (disabled) expect(redo?.getAttribute("aria-disabled")).toBe("true");
      else expect(redo).toBeNull();
    }
  });

  test.each(["refresh", "rejected", "partial"] as const)(
    "regeneration offers only available recovery after %s",
    async (scenario) => {
      const original = playChainView("original", "first", "Begin.");
      let submitted = false;
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read") {
            if (submitted && scenario === "refresh")
              return Promise.reject(new Error("World read unavailable"));
            return Promise.resolve(worldView(original));
          }
          if (request.type === "world.play-decorations.read")
            return Promise.resolve({ artifacts: [], debug: [] });
          if (request.type === "play.chain.revise-player") {
            submitted = true;
            if (scenario === "rejected")
              return Promise.reject(
                new RuntimeRequestError("This event is stale.", {
                  protocolCode: "invalid_request",
                }),
              );
            const chain = playChainView(
              "rewritten",
              request.replacementExchangeId,
              request.replacementText,
            );
            if (scenario === "refresh") {
              const narrative = chain.events.find(
                (event) => event.kind === "assistant",
              );
              if (narrative?.kind === "assistant")
                narrative.text = "Revised once.";
            } else {
              chain.canContinuePartial = true;
              chain.canRetry = false;
              chain.status = "interrupted";
              chain.lastFailureKind = "output_limit";
              Object.assign(original, chain);
            }
            return Promise.resolve({
              outcome: "revised",
              sentAfterRevision: true,
              continuation: "continue_context",
              playCallChain: chain,
            });
          }
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          return Promise.reject(new Error("Read unavailable"));
        }),
      };
      renderWorld(client);
      await redoLatestTurn();
      if (scenario === "refresh") {
        await screen.findByText(/操作已完成，但页面刷新失败/u);
        expect(screen.getByText("Revised once.")).toBeTruthy();
        expect(
          screen.queryByText("Alex opens the door and lets you go first."),
        ).toBeNull();
      } else if (scenario === "rejected")
        await screen.findByText("This event is stale.");
      else await screen.findByText("修改已保存，可以续写中断的回复。");
      expect(
        screen.queryByRole("button", { name: "用全新上下文重新生成" }),
      ).toBeNull();
      expect(
        client.request.mock.calls.filter(
          ([r]) => r.type === "play.chain.revise-player",
        ),
      ).toHaveLength(1);
    },
  );

  test("重新生成确认后忽略命令前在途的世界读取，并只补一次最新端点读取", async () => {
    const original = playChainView("original", "first", "Begin.");
    let current = original;
    let reads = 0;
    let onConnection: Parameters<ObserveConversation>[2] | undefined;
    const oldRead = Promise.withResolvers<ReturnType<typeof worldView>>();
    const oldWorld = worldView(original);
    const client = {
      observeConversation: ((_target, _receive, connection) => {
        onConnection = connection;
        return () => undefined;
      }) satisfies ObserveConversation,
      request: vi.fn((input: V1Request): Promise<unknown> => {
        if (input.type === "world.read") {
          if (++reads === 2) return oldRead.promise;
          return Promise.resolve(worldView(current));
        }
        if (input.type === "world.play-decorations.read")
          return Promise.resolve(
            playDecorations(null, "world-one", current.parentHead),
          );
        if (input.type === "play.chain.revise-player") {
          current = playChainView(
            "rewritten",
            input.replacementExchangeId,
            input.replacementText,
          );
          current.parentHead = "commit:9";
          const narrative = current.events.find(
            (event) => event.kind === "assistant",
          );
          if (narrative?.kind === "assistant")
            narrative.text = "Confirmed replacement narrative.";
          return Promise.resolve({
            outcome: "revised",
            playCallChain: current,
          });
        }
        return Promise.reject(new Error(`Unexpected ${input.type}`));
      }),
    };
    renderWorld(client);
    await screen.findByText("Alex opens the door and lets you go first.");
    act(() => onConnection?.("reconnecting"));
    await waitFor(() => expect(reads).toBe(2));
    await redoLatestTurn();
    await screen.findByText("Confirmed replacement narrative.");
    await act(async () => {
      oldRead.resolve(oldWorld);
      await oldRead.promise;
    });
    await waitFor(() => expect(reads).toBe(3));
    await screen.findByText("Confirmed replacement narrative.");
    expect(
      screen.queryByText("Alex opens the door and lets you go first."),
    ).toBeNull();
    expect(
      client.request.mock.calls.filter(
        ([input]) => input.type === "play.chain.revise-player",
      ),
    ).toHaveLength(1);
  });

  test("世界在故事外前进后重新生成仍沿原上下文直接提交", async () => {
    const originalText = "  原始玩家输入\n";
    let chain = playChainView("original", "first", originalText);
    let worldHead = "commit:9";
    const client = {
      request: vi.fn((request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return Promise.resolve({ ...worldView(chain), head: worldHead });
        if (request.type === "artifacts.debug") return Promise.resolve([]);
        if (request.type === "play.chain.revise-player") {
          worldHead = "commit:10";
          chain = {
            ...chain,
            chainId: "continued-regeneration",
            parentHead: worldHead,
            events: [
              {
                id: 1,
                kind: "player",
                exchangeId: request.replacementExchangeId,
                text: request.replacementText,
                context: "fresh",
                committedHead: worldHead,
              },
            ],
          };
          return Promise.resolve({ outcome: "revised", playCallChain: chain });
        }
        if (request.type === "play.chain.append") {
          worldHead = "commit:11";
          chain = {
            ...chain,
            parentHead: worldHead,
            events: [
              ...chain.events,
              {
                id: 2,
                kind: "assistant",
                text: "沿原上下文重新生成的回复",
                status: "completed",
                responseKind: "narrative",
                committedHead: worldHead,
                exchange: 1,
                attempt: 1,
              },
            ],
          };
          return Promise.resolve(chain);
        }
        return Promise.reject(new Error(`Unexpected request: ${request.type}`));
      }),
    };
    renderWorld(client, undefined, { simulateCombinedRevision: true });
    await screen.findByText("Alex opens the door and lets you go first.");
    expect(
      screen.getByText(
        "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
      ),
    ).toBeTruthy();
    await redoLatestTurn();
    await screen.findByText("沿原上下文重新生成的回复");
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "play.chain.revise-player",
        continuation: "continue_context",
        chainId: "original",
        replacementText: originalText,
      }),
    );
    expect(
      screen.queryByRole("button", { name: "用全新上下文重新生成" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        "世界已在当前上下文之外更新；下一次行动会从新上下文开始。",
      ),
    ).toBeNull();
  });

  test.each(["imported", "unavailable", "append-protocol-mismatch"] as const)(
    "原上下文不可用时提供全新上下文重新生成：%s",
    async (scenario) => {
      const originalText = "  原始玩家输入\n";
      let chain = playChainView("original", "first", originalText);
      if (scenario === "imported") chain.requiresFreshContext = true;
      let fresh = false;
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read")
            return Promise.resolve(worldView(chain));
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          if (request.type === "play.chain.revise-player") {
            if (
              request.continuation === "continue_context" &&
              scenario === "unavailable"
            )
              return Promise.reject(
                new RuntimeRequestError("Missing provider continuation", {
                  protocolCode: "invalid_request",
                  details: { recovery: "fresh_context" },
                }),
              );
            fresh = request.continuation === "fresh_context";
            chain = {
              ...chain,
              chainId: fresh ? "fresh-regeneration" : "continued-regeneration",
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
            };
            delete chain.requiresFreshContext;
            return Promise.resolve({
              outcome: "revised",
              playCallChain: chain,
            });
          }
          if (request.type === "play.chain.append") {
            if (!fresh)
              return Promise.reject(
                new RuntimeRequestError("Protocol mismatch", {
                  protocolCode: "model_protocol_mismatch",
                }),
              );
            chain = {
              ...chain,
              events: [
                ...chain.events,
                {
                  id: 2,
                  kind: "assistant",
                  text: "新上下文重新生成的回复",
                  status: "completed",
                  responseKind: "narrative",
                  committedHead: "commit:5",
                  exchange: 1,
                  attempt: 1,
                },
              ],
            };
            return Promise.resolve(chain);
          }
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      renderWorld(client, undefined, { simulateCombinedRevision: true });
      await screen.findByText("Alex opens the door and lets you go first.");
      await redoLatestTurn();
      const fallback = await screen.findByRole("button", {
        name: "用全新上下文重新生成",
      });
      expect(
        screen.getByText(
          "原上下文无法用于这次重新生成。可使用当前模型和编排方案，从同一条玩家输入开启全新上下文。",
        ),
      ).toBeTruthy();
      expect(
        client.request.mock.calls.some(
          ([request]) =>
            request.type === "play.chain.revise-player" &&
            request.continuation === "fresh_context",
        ),
      ).toBe(false);
      fireEvent.click(fallback);
      await screen.findByText("新上下文重新生成的回复");
      expect(client.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "play.chain.revise-player",
          continuation: "fresh_context",
          replacementText: originalText,
          chainId: "original",
          eventId: 1,
        }),
      );
      expect(client.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "play.chain.revise-player",
          sendAfterRevision: true,
        }),
      );
    },
  );

  test.each([
    {
      status: "ready" as const,
      canRetry: false,
      feedback: "已重新生成；原回复已离开当前时间线",
    },
    {
      status: "interrupted" as const,
      canRetry: true,
      feedback: "修改已保存；模型请求中断，可以重新发送已保存的请求。",
    },
    {
      status: "interrupted" as const,
      canRetry: false,
      feedback: "修改已保存，但模型请求失败。",
    },
  ])(
    "重新生成沿原上下文使用玩家原文并保留恢复反馈：$status/$canRetry",
    async ({ status, canRetry, feedback }) => {
      const originalText = "  I signal Alex to open the door.\n";
      let chain = playChainView("original-chain", "first-send", originalText);
      const confirm = vi.fn(() => true);
      vi.stubGlobal("confirm", confirm);
      const client = {
        request: vi.fn((request: V1Request): Promise<unknown> => {
          if (request.type === "world.read")
            return Promise.resolve(worldView(chain));
          if (request.type === "artifacts.debug") return Promise.resolve([]);
          if (request.type === "play.chain.revise-player") {
            chain = {
              ...chain,
              chainId: "regenerated-chain",
              parentHead: "commit:4",
              changedDocuments: [],
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
            };
            return Promise.resolve({
              outcome: "revised",
              playCallChain: chain,
            });
          }
          if (request.type === "play.chain.append") {
            chain = { ...chain, status, canRetry, parentHead: "commit:5" };
            if (status === "interrupted") {
              chain.lastFailureKind = "outcome_unknown";
              chain.events.push({
                id: chain.events.length + 1,
                kind: "failure",
                failureKind: "outcome_unknown",
                message: "stream interrupted",
              });
            }
            if (status === "ready")
              chain.events.push({
                id: 2,
                kind: "assistant",
                text: "重新生成的正文",
                responseKind: "narrative",
                status: "completed",
                exchange: 1,
                attempt: 1,
                committedHead: "commit:5",
              });
            return Promise.resolve(chain);
          }
          return Promise.reject(
            new Error(`Unexpected request: ${request.type}`),
          );
        }),
      };
      const onOpenWorld = vi.fn(() => Promise.resolve());
      renderWorld(client, onOpenWorld, { simulateCombinedRevision: true });
      fireEvent.change(await screen.findByLabelText("你的行动"), {
        target: { value: "尚未发送的草稿" },
      });
      await redoLatestTurn();
      const feedbackNode = await screen.findByText(feedback);
      if (status === "interrupted" && canRetry)
        expect(feedbackNode.closest('[role="status"]')).not.toBeNull();
      expect(confirm).not.toHaveBeenCalled();
      expect(onOpenWorld).not.toHaveBeenCalled();
      expect(
        screen.queryByText("Alex opens the door and lets you go first."),
      ).toBeNull();
      expect(screen.getByLabelText<HTMLTextAreaElement>("你的行动").value).toBe(
        "尚未发送的草稿",
      );
      const writes = client.request.mock.calls
        .map(([request]) => request)
        .filter((request) => request.type.startsWith("play.chain."));
      expect(writes).toEqual([
        expect.objectContaining({
          type: "play.chain.revise-player",
          worldId: "world-one",
          chainId: "original-chain",
          eventId: 1,
          replacementText: originalText,
          continuation: "continue_context",
        }),
      ]);
      if (status === "ready")
        expect(screen.getByText("重新生成的正文")).toBeTruthy();
      if (status === "interrupted" && canRetry) {
        fireEvent.click(screen.getByRole("button", { name: "重新发送" }));
        await waitFor(() =>
          expect(
            client.request.mock.calls.filter(
              ([request]) => request.type === "play.chain.append",
            ),
          ).toHaveLength(1),
        );
        expect(
          client.request.mock.calls
            .map(([request]) => request)
            .filter((request) => request.type === "play.chain.append")
            .at(-1),
        ).toMatchObject({
          type: "play.chain.append",
          chainId: "regenerated-chain",
          playerText: "",
        });
      }
    },
  );

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

    renderWorld(client, onOpenWorld, { simulateCombinedRevision: true });
    await screen.findByText("I signal Alex to open the door.");
    const playerMessage = screen
      .getByText("I signal Alex to open the door.")
      .closest<HTMLElement>(".call-chain-player")!;
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "玩家消息操作" }),
    );
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "修改" }),
    );
    const editor = within(playerMessage).getByLabelText("修改后的行动");
    expect((editor as HTMLTextAreaElement).value).toBe(
      "I signal Alex to open the door.",
    );
    expect(
      within(playerMessage)
        .getByText("修改后如何继续", { selector: "summary" })
        .closest("details")?.open,
    ).toBe(false);
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
      continuation: "auto",
    });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "play.chain.revise-player",
        sendAfterRevision: true,
      }),
    );
  });

  test("修改玩家提交后可以用新对话继续", async () => {
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

    renderWorld(client, undefined, { simulateCombinedRevision: true });
    await screen.findByText("I signal Alex to open the door.");
    const playerMessage = screen
      .getByText("I signal Alex to open the door.")
      .closest<HTMLElement>(".call-chain-player")!;
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "玩家消息操作" }),
    );
    fireEvent.click(
      within(playerMessage).getByRole("button", { name: "修改" }),
    );
    fireEvent.change(within(playerMessage).getByLabelText("修改后的行动"), {
      target: { value: "I ask Alex to wait before opening the door." },
    });
    fireEvent.click(
      within(playerMessage).getByText("修改后如何继续", {
        selector: "summary",
      }),
    );
    fireEvent.click(
      within(playerMessage).getByRole("radio", {
        name: /用新对话继续/u,
      }),
    );
    fireEvent.click(
      within(playerMessage).getByRole("button", {
        name: "保存修改并用新对话继续",
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
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "play.chain.revise-player",
        sendAfterRevision: true,
      }),
    );
  });
});

function latestNarratorActions(timeline: HTMLElement): HTMLElement | undefined {
  const latest = Array.from(
    timeline.querySelectorAll<HTMLElement>(
      ".call-chain-assistant.is-completed",
    ),
  ).at(-1);
  return latest === undefined
    ? undefined
    : (within(latest).queryByRole("button", { name: "主持消息操作" }) ??
        undefined);
}

async function redoLatestTurn(): Promise<void> {
  const timeline = await screen.findByLabelText("模型调用链");
  fireEvent.click(latestNarratorActions(timeline)!);
  fireEvent.click(screen.getByRole("button", { name: "整轮重来" }));
}

function renderWorld(
  client: {
    request: (request: V1Request) => Promise<unknown>;
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
    initialReadingPreferences?: AppReadingPreferences;
    modelConfigured?: boolean;
    activeModelProtocol?: V1PlayCallChainView["modelProtocol"];
    simulateCombinedRevision?: boolean;
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
      if (
        options.simulateCombinedRevision &&
        request.type === "play.chain.revise-player" &&
        request.sendAfterRevision &&
        vi.isMockFunction(client.request)
      ) {
        const revised = result as {
          outcome: string;
          playCallChain: V1PlayCallChainView;
        };
        const implementation = vi
          .mocked(client.request)
          .getMockImplementation();
        if (implementation === undefined)
          throw new Error("Missing test runtime implementation");
        const continued = await implementation({
          type: "play.chain.append",
          worldId: request.worldId,
          chainId: revised.playCallChain.chainId,
          exchangeId: "combined",
          playerText: "",
        });
        return {
          ...revised,
          playCallChain: continued,
          continuation:
            request.continuation === "auto"
              ? "continue_context"
              : request.continuation,
          sentAfterRevision: true,
        };
      }
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
      onBack: vi.fn(),
      onConfigureModel: vi.fn(),
      onRenameWorld: options.onRenameWorld ?? vi.fn(() => Promise.resolve()),
      onOpenWorld,
      ...(options.initialReadingPreferences === undefined
        ? {}
        : { initialReadingPreferences: options.initialReadingPreferences }),
      modelConfigured: options.modelConfigured ?? true,
      activeModelProtocol: options.activeModelProtocol,
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
  epoch: V1WorldRevisionEpochView | null,
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
          created.requestPreviews = [
            {
              requestId: request.requestId,
            },
          ];
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

test("同一端点的后置结算立即显示内容，轻量读取和重连保留及更新产物", async () => {
  let receive!: Parameters<ObserveConversation>[1];
  let connection!: NonNullable<Parameters<ObserveConversation>[2]>;
  let chain = playChainView("chain-panels", "exchange-panels", "open");
  chain.status = "running";
  let payload: string | null = null;
  const client = {
    observeConversation: ((_target, callback, onConnection) => {
      receive = callback;
      connection = onConnection!;
      return vi.fn();
    }) satisfies ObserveConversation,
    request: vi.fn((request: V1Request) => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(chain));
      if (request.type === "world.play-decorations.read")
        return Promise.resolve(
          playDecorations(payload, "world-one", chain.parentHead),
        );
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  await waitFor(() => expect(receive).toBeTypeOf("function"));
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  payload = "同端点后置真实内容";
  chain = {
    ...chain,
    events: [
      ...chain.events,
      {
        id: 99,
        kind: "followup",
        followupId: "panel",
        displayName: "panel",
        text: "",
        toolCalls: [],
      },
    ],
  };
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  await waitFor(() =>
    expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
      "同端点后置真实内容",
    ),
  );
  const readsBeforeDelta = client.request.mock.calls.length;
  await act(async () => {
    await receive(
      { kind: "play", value: { ...chain, updatedAt: chain.updatedAt + 1 } },
      true,
    );
  });
  expect(client.request.mock.calls).toHaveLength(readsBeforeDelta);
  chain = { ...chain, status: "ready" };
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
    "同端点后置真实内容",
  );
  payload = "重连恢复的产物";
  await act(async () => {
    connection("reconnecting");
    connection("connected");
    await receive({ kind: "play", value: chain }, true);
  });
  await waitFor(() =>
    expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
      "重连恢复的产物",
    ),
  );
  payload = null;
  chain = {
    ...chain,
    events: [
      ...chain.events,
      {
        id: 100,
        kind: "followup",
        followupId: "failed",
        displayName: "failed",
        text: "",
        toolCalls: [],
        failure: "generation failed",
      },
    ],
  };
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  await waitFor(() => expect(screen.queryByTitle("panel")).toBeNull());
});

test("旧端点和旧世界的延迟扩展响应不能覆盖当前页面", async () => {
  let receive!: Parameters<ObserveConversation>[1];
  let chain = playChainView("race-chain", "race-exchange", "open");
  const reads: {
    worldId: string;
    head: string;
    resolve: (value: unknown) => void;
  }[] = [];
  const client = {
    observeConversation: ((_target, callback) => {
      receive = callback;
      return vi.fn();
    }) satisfies ObserveConversation,
    request: async (request: V1Request): Promise<unknown> => {
      if (request.type === "world.read")
        return { ...worldView(chain), worldId: request.worldId };
      if (request.type === "world.play-decorations.read")
        return new Promise((resolve) => {
          reads.push({
            worldId: request.worldId,
            head: chain.parentHead,
            resolve,
          });
        });
      throw new Error(`Unexpected request ${request.type}`);
    },
  };
  const props = {
    client,
    worldId: "world-one",
    worldTitle: "宿舍世界",
    modelConfigured: true,
    onBack: vi.fn(),
    onConfigureModel: vi.fn(),
    onRenameWorld: () => Promise.resolve(),
    onOpenWorld: () => Promise.resolve(),
  };
  const rendered = render(createElement(WorldPage, props));
  await waitFor(() => expect(reads.length).toBe(1));
  const oldHead = reads[0]!;
  chain = { ...chain, parentHead: "commit:4" };
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  await waitFor(() => expect(reads.at(-1)?.head).toBe("commit:4"));
  const newHead = reads.at(-1)!;
  const resolve = (read: typeof oldHead, payload: string) =>
    read.resolve(playDecorations(payload, read.worldId, read.head));
  await act(() => {
    resolve(newHead, "new head");
    return Promise.resolve();
  });
  await waitFor(() =>
    expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
      "new head",
    ),
  );
  await act(() => {
    resolve(oldHead, "old head");
    return Promise.resolve();
  });
  expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
    "new head",
  );
  // Start another read in the first world, then navigate to a different world
  // with the same head alias before it resolves.
  chain = { ...chain, status: "running" };
  await act(async () => {
    await receive({ kind: "play", value: chain }, true);
  });
  const oldWorld = reads.at(-1)!;
  rendered.rerender(
    createElement(WorldPage, { ...props, worldId: "world-two" }),
  );
  await waitFor(() => expect(reads.at(-1)?.worldId).toBe("world-two"));
  await act(() => {
    resolve(reads.at(-1)!, "new world");
    return Promise.resolve();
  });
  await waitFor(() =>
    expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
      "new world",
    ),
  );
  await act(() => {
    resolve(oldWorld, "old world");
    return Promise.resolve();
  });
  expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
    "new world",
  );
});

function playDecorations(
  payload: string | null,
  worldId: string,
  head: string,
) {
  const artifacts: FrontendArtifactProjection[] =
    payload === null
      ? []
      : [
          {
            recordId: "panel-record",
            worldId,
            head,
            payload,
            operationId: "panel-operation",
            playPresetId: "preset-one",
            playPresetRevision: "rev-one",
            requestId: "panel",
            requestAttempt: 1,
            output: "panel",
            channel: "panel",
            contentType: "text/plain",
            projection: "replace",
            save: "commit",
            sequence: 1,
            frontend: {
              status: "ready",
              preset: { id: "preset-one", revision: "rev-one" },
              mount: "sidebar",
              regex: [],
              trustedLocalCode: false,
              fallback: "none",
            },
          },
        ];
  return { head, artifacts, extensions: [], artifactDebug: [] };
}

test("世界扩展菜单提交 Runtime 选择；无调用链的同端点通知也刷新纯界面，关闭不被 fallback 补回", async () => {
  let receive!: Parameters<ObserveConversation>[1];
  let enabled = true;
  const controls = () => ({
    revision: enabled ? 1 : 2,
    items: [
      {
        key: "view:status",
        id: "status",
        name: "当前状态",
        source: "world" as const,
        kind: "view" as const,
        defaultEnabled: true,
        selected: enabled,
        enabled,
        overridden: !enabled,
        generation: enabled ? 0 : 1,
      },
    ],
  });
  const client = {
    observeConversation: ((_target, callback) => {
      receive = callback;
      return () => undefined;
    }) satisfies ObserveConversation,
    request: vi.fn((request: V1Request) => {
      if (request.type === "world.read")
        return Promise.resolve({
          ...worldView(null),
          extensionControls: controls(),
        });
      if (request.type === "world.play-decorations.read")
        return Promise.resolve({
          ...playDecorations(null, "world-one", "commit:1"),
          extensionControls: controls(),
          playerViews: worldView(null).playerViews,
          playerViewPanels: [],
          suppressedPlayerViewIds: enabled ? [] : ["status"],
        });
      if (request.type === "world.extensions.set") {
        enabled = request.value !== "off";
        return Promise.resolve(controls());
      }
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  fireEvent.click(screen.getByText("世界扩展", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "此刻" }));
  expect(screen.getByText("白色运动背心")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "当前状态" }));
  await waitFor(() => expect(screen.queryByText("白色运动背心")).toBeNull());
  expect(client.request).toHaveBeenCalledWith({
    type: "world.extensions.set",
    worldId: "world-one",
    key: "view:status",
    value: "off",
  });
  // An independent tab changes the Runtime state while there is no play chain.
  enabled = true;
  await act(async () => {
    await receive({ kind: "play", value: null, extensionsRevision: 3 }, true);
  });
  await waitFor(() => expect(screen.getByText("白色运动背心")).toBeTruthy());
  expect(
    client.request.mock.calls.some(([request]) =>
      request.type.startsWith("play.chain"),
    ),
  ).toBe(false);
});

test("装饰读取失败时在扩展区域显示原因，重试成功后提示消失并恢复面板", async () => {
  let reads = 0;
  const client = {
    request: vi.fn((request: V1Request): Promise<unknown> => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(null));
      if (request.type === "world.play-decorations.read") {
        reads += 1;
        return reads <= 2
          ? Promise.reject(new Error("World does not exist"))
          : Promise.resolve(
              playDecorations("正文附件", "world-one", "commit:1"),
            );
      }
      if (request.type === "artifacts.debug") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected request: ${request.type}`));
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  const notice = "暂时无法同步";
  await screen.findByText(notice);
  expect(screen.queryByTitle("panel")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByTitle("panel");
  expect(screen.queryByText(notice)).toBeNull();
  expect(reads).toBe(3);
});

test("同一世界装饰读取连续失败时只保留一条提示", async () => {
  const client = {
    request: vi.fn((request: V1Request): Promise<unknown> => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(null));
      if (request.type === "world.play-decorations.read")
        return Promise.reject(new Error("World does not exist"));
      if (request.type === "artifacts.debug") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected request: ${request.type}`));
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  const notice = "暂时无法同步";
  await screen.findByText(notice);
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() =>
    expect(
      client.request.mock.calls.filter(
        ([request]) => request.type === "world.play-decorations.read",
      ),
    ).toHaveLength(3),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy(),
  );
  expect(screen.getAllByText(notice)).toHaveLength(1);
});

test("世界文件面板首次读取失败有界恢复，手动重读只加载文件表面", async () => {
  let stateReads = 0;
  const full = worldView(null);
  const client = {
    request: vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "world.read")
        return { ...full, state: [], control: [] };
      if (input.type === "world.play-decorations.read")
        return playDecorations(null, "world-one", full.head);
      if (input.type === "world.surface.read") {
        if (input.surface === "state" && ++stateReads <= 2)
          throw new Error("offline files");
        return input.surface === "state"
          ? full.state
          : input.surface === "control"
            ? full.control
            : full.runtime;
      }
      throw new Error(input.type);
    }),
  };
  const view = renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  fireEvent.click(screen.getByRole("button", { name: "世界" }));
  const rail = view.container.querySelector<HTMLElement>(
    ".world-overlay-rail-right",
  )!;
  await within(rail).findByText("暂时无法同步");
  expect(stateReads).toBe(2);
  const worldReads = client.request.mock.calls.filter(
    ([input]) => input.type === "world.read",
  ).length;
  fireEvent.click(within(rail).getByRole("button", { name: "重新加载" }));
  await waitFor(() =>
    expect(within(rail).queryByText("暂时无法同步")).toBeNull(),
  );
  expect(stateReads).toBe(3);
  expect(
    client.request.mock.calls.filter(([input]) => input.type === "world.read"),
  ).toHaveLength(worldReads);
  expect(
    client.request.mock.calls.some(([input]) =>
      input.type.startsWith("play.chain"),
    ),
  ).toBe(false);
});

test("AI 读取面板暂时断网时在原位置重读自己的查询", async () => {
  let readingCalls = 0;
  const client = {
    request: vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "world.read") return worldView(null);
      if (input.type === "world.play-decorations.read")
        return playDecorations(null, "world-one", "commit:1");
      if (input.type === "world.play-context.read") {
        if (++readingCalls <= 2) throw new Error("reading offline");
        return playReadingView();
      }
      throw new Error(input.type);
    }),
  };
  const view = renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  fireEvent.click(screen.getByRole("button", { name: "AI 读取" }));
  const rail = view.container.querySelector<HTMLElement>(
    ".world-overlay-rail-right",
  )!;
  await within(rail).findByText("暂时无法同步");
  expect(readingCalls).toBe(2);
  fireEvent.click(within(rail).getByRole("button", { name: "重新加载" }));
  await within(rail).findByText("精确节点");
  expect(readingCalls).toBe(3);
  expect(
    client.request.mock.calls.filter(([input]) => input.type === "world.read"),
  ).toHaveLength(1);
});

test("世界扩展开关设置失败时原因显示在该开关旁，开关保持服务端状态", async () => {
  const controls = {
    revision: 1,
    items: [
      {
        key: "view:status",
        id: "status",
        name: "当前状态",
        source: "world" as const,
        kind: "view" as const,
        defaultEnabled: true,
        selected: true,
        enabled: true,
        overridden: false,
        generation: 0,
      },
    ],
  };
  const client = {
    request: vi.fn((request: V1Request): Promise<unknown> => {
      if (request.type === "world.read")
        return Promise.resolve({
          ...worldView(null),
          extensionControls: controls,
        });
      if (request.type === "world.play-decorations.read")
        return Promise.resolve({
          ...playDecorations(null, "world-one", "commit:1"),
          extensionControls: controls,
          playerViews: worldView(null).playerViews,
          playerViewPanels: [],
          suppressedPlayerViewIds: [],
        });
      if (request.type === "world.extensions.set")
        return Promise.reject(
          new Error("World extension setting was rejected"),
        );
      if (request.type === "artifacts.debug") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected request: ${request.type}`));
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  fireEvent.click(screen.getByText("世界扩展", { exact: true }));
  const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "当前状态",
  });
  fireEvent.click(checkbox);
  const row = checkbox.closest<HTMLElement>(".world-extension-choice");
  expect(row).not.toBeNull();
  await waitFor(() =>
    expect(
      within(row!).getByText("World extension setting was rejected"),
    ).toBeTruthy(),
  );
  expect(checkbox.checked).toBe(true);
  expect(client.request).toHaveBeenCalledWith({
    type: "world.extensions.set",
    worldId: "world-one",
    key: "view:status",
    value: "off",
  });
});

function deferredProtagonistRevision() {
  let resolveWorld!: (value: ReturnType<typeof worldView>) => void;
  const initialWorld = new Promise<ReturnType<typeof worldView>>((resolve) => {
    resolveWorld = resolve;
  });
  let resolveSend!: (value: V1WorldRevisionView) => void;
  let rejectSend!: (reason: unknown) => void;
  const send = new Promise<V1WorldRevisionView>((resolve, reject) => {
    resolveSend = resolve;
    rejectSend = reject;
  });
  window.sessionStorage.removeItem(
    "narraeon.protagonist-customization:world-one",
  );
  let epoch: V1WorldRevisionEpochView | null = null;
  let latest: V1WorldRevisionView | null = null;
  const files = worldView(null).state;
  const subscribers = new Set<{
    target: ConversationTarget;
    receive: Parameters<ObserveConversation>[1];
  }>();
  const client = {
    observeConversation: ((target, receive) => {
      const subscriber = { target, receive };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    }) satisfies ObserveConversation,
    request: vi.fn(async (request: V1Request): Promise<unknown> => {
      if (request.type === "world.read") return initialWorld;
      if (request.type === "world.revision.overview")
        return {
          ...worldRevisionOverview(epoch),
          latest,
          history:
            latest === null
              ? []
              : [{ sessionId: latest.sessionId, epochId: latest.epochId }],
        };
      if (request.type === "world.surface.read")
        return request.surface === "state" ? files : [];
      if (request.type === "world.revision.message") return send;
      if (request.type === "world.play-decorations.read")
        return { ...worldView(null), playerViewPanels: [], artifactDebug: [] };
      if (request.type === "artifacts.debug") return [];
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  const view = (runStatus: "running" | "ready"): V1WorldRevisionView => ({
    sessionId: "protagonist-session",
    confirmedRequestIds: ["protagonist-request"],
    worldId: "world-one",
    epochId: worldRevisionEpoch([]).epochId,
    runStatus,
    messages: [],
    turns: [],
    usage: emptyAggregatedModelUsage(),
    progress: { exchange: 0, toolCalls: 0, streaming: null, updatedAt: 1 },
    lastFailure: null,
  });
  const props = {
    client,
    worldId: "world-one",
    worldTitle: "宿舍世界",
    modelConfigured: true,
    onBack: vi.fn(),
    onConfigureModel: vi.fn(),
    onRenameWorld: vi.fn(() => Promise.resolve()),
    onOpenWorld: vi.fn(() => Promise.resolve()),
    onNavigationProtectionChange: vi.fn(),
    initialProtagonistCustomization: {
      name: "冷静调查员",
      body: "冷静果断",
      message: "固定说明\n\n主角模板：冷静调查员",
      requestId: "protagonist-request",
    },
  };
  return {
    client,
    props,
    rejectSend,
    openWorld: () => resolveWorld(worldView(null)),
    acknowledge: () => {
      epoch = worldRevisionEpoch(
        files.map((file) => ({ ...file, path: `state/${file.path}` })),
      );
      latest = view("running");
      resolveSend(latest);
    },
    complete: async () => {
      latest = view("ready");
      for (const subscriber of [...subscribers]) {
        if (subscriber.target.kind !== "revision") continue;
        await subscriber.receive(
          {
            kind: "revision",
            value: {
              revision: "completed",
              selected: {
                sessionId: latest.sessionId,
                runStatus: latest.runStatus,
                progress: latest.progress,
              },
            },
          },
          true,
        );
      }
    },
  };
}

test("主角确认前不发送，确认后到模型结束持续保护交互和导航", async () => {
  const f = deferredProtagonistRevision();
  render(createElement(StrictMode, null, createElement(WorldPage, f.props)));
  act(f.openWorld);
  const confirm = await screen.findByRole<HTMLButtonElement>("button", {
    name: "确认并定制",
  });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  expect(
    f.client.request.mock.calls.some(
      ([request]) => request.type === "world.revision.message",
    ),
  ).toBe(false);
  expect(screen.getByText("冷静果断")).toBeTruthy();
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  const sent = () =>
    f.client.request.mock.calls.filter(
      ([request]) => request.type === "world.revision.message",
    );
  expect(sent()).toHaveLength(1);
  expect(f.props.onNavigationProtectionChange).toHaveBeenLastCalledWith({
    dirty: false,
    busy: true,
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "高级世界修订" })
      .disabled,
  ).toBe(true);

  await act(async () => {
    f.acknowledge();
    await Promise.resolve();
  });
  expect(f.props.onNavigationProtectionChange).toHaveBeenLastCalledWith({
    dirty: false,
    busy: true,
  });
  await act(f.complete);
  await waitFor(() =>
    expect(f.props.onNavigationProtectionChange).toHaveBeenLastCalledWith({
      dirty: false,
      busy: false,
    }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "放弃定制，阅读开场",
    }).disabled,
  ).toBe(false);
  expect(sent()).toHaveLength(1);
  window.sessionStorage.removeItem(
    "narraeon.protagonist-customization:world-one",
  );
});

test("主角定制发送失败后保留模板，并以相同请求身份明确重试", async () => {
  const f = deferredProtagonistRevision();
  render(createElement(StrictMode, null, createElement(WorldPage, f.props)));
  act(f.openWorld);
  const initial = await screen.findByRole<HTMLButtonElement>("button", {
    name: "确认并定制",
  });
  await waitFor(() => expect(initial.disabled).toBe(false));
  fireEvent.click(initial);
  act(() => f.rejectSend(new Error("模板发送失败")));
  await screen.findByText("模板发送失败");
  expect(screen.getByText("冷静果断")).toBeTruthy();
  expect(f.props.onNavigationProtectionChange).toHaveBeenLastCalledWith({
    dirty: false,
    busy: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "重试定制" }));
  await waitFor(() =>
    expect(
      f.client.request.mock.calls.filter(
        ([request]) => request.type === "world.revision.message",
      ),
    ).toEqual(
      Array.from({ length: 2 }, () => [
        {
          type: "world.revision.message",
          worldId: "world-one",
          requestId: "protagonist-request",
          continuation: { kind: "fresh_context" },
          message: f.props.initialProtagonistCustomization.message,
        },
      ]),
    ),
  );
  await screen.findByText("模板发送失败");
  window.sessionStorage.removeItem(
    "narraeon.protagonist-customization:world-one",
  );
});

test.each(["keep", "revert"] as const)(
  "世界修订页面可重发并以 %s 策略修改消息",
  async (filePolicy) => {
    const epoch = worldRevisionEpoch([]);
    const user = {
      id: "user-edit",
      role: "user" as const,
      text: "原消息",
      createdAt: 1,
    };
    let latest: V1WorldRevisionView = {
      sessionId: "revision-edit",
      worldId: "world-one",
      epochId: epoch.epochId,
      runStatus: "interrupted",
      canRetry: true,
      messages: [user],
      turns: [{ id: user.id, user, exchanges: [] }],
      usage: emptyAggregatedModelUsage(),
      progress: { exchange: 1, toolCalls: 0, streaming: null, updatedAt: 1 },
      lastFailure: "Stream stopped",
    };
    const overview = (): V1WorldRevisionOverview => ({
      ...worldRevisionOverview(epoch),
      latest,
      history: [],
    });
    const client = {
      request: vi.fn(async (request: V1Request): Promise<unknown> => {
        if (request.type === "world.read")
          return await Promise.resolve(worldView(null));
        if (request.type === "artifacts.debug") return [];
        if (
          request.type === "world.revision.overview" ||
          request.type === "world.revision.open"
        )
          return overview();
        if (request.type === "world.revision.session.read") return latest;
        if (request.type === "world.revision.resume") {
          latest = {
            ...latest,
            runStatus: "ready",
            canRetry: false,
            lastFailure: null,
          };
          return latest;
        }
        if (request.type === "world.revision.message.edit") {
          const changed = { ...user, text: request.message };
          latest = {
            ...latest,
            messages: [changed],
            turns: [{ id: changed.id, user: changed, exchanges: [] }],
          };
          return latest;
        }
        throw new Error(`Unexpected request ${request.type}`);
      }),
    };
    renderWorld(client);
    await screen.findByRole("heading", { name: "宿舍世界" });
    fireEvent.click(screen.getByRole("button", { name: "世界" }));
    fireEvent.click(screen.getByRole("button", { name: "修订当前世界" }));
    await screen.findByRole("button", { name: "重新发送" });
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "world.revision.resume",
          sessionId: "revision-edit",
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "修改消息" }));
    fireEvent.change(screen.getByLabelText("修改消息"), {
      target: { value: "取消的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      client.request.mock.calls.some(
        ([request]) => request.type === "world.revision.message.edit",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "修改消息" }));
    fireEvent.change(screen.getByLabelText("修改消息"), {
      target: { value: "修改后的消息" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name:
          filePolicy === "keep" ? "保留文件改动并继续" : "撤回文件改动并继续",
      }),
    );
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "world.revision.message.edit",
          messageId: "user-edit",
          message: "修改后的消息",
          filePolicy,
        }),
      ),
    );
    await screen.findByText("修改后的消息");
  },
);

test("a disconnected play observation recovers once and keeps the action draft", async () => {
  let connection: Parameters<ObserveConversation>[2];
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    if (input.type === "world.read")
      return await Promise.resolve(worldView(null));
    if (input.type === "world.play-decorations.read")
      return { artifacts: [], debug: [] };
    throw new Error(input.type);
  });
  renderWorld({
    request,
    observeConversation: (_target, _receive, notify) => {
      connection = notify;
      return () => undefined;
    },
  });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  const reads = request.mock.calls.filter(
    ([r]) => r.type === "world.read",
  ).length;
  act(() => {
    connection?.("reconnecting");
    connection?.("reconnecting");
    connection?.("failed");
  });
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([r]) => r.type === "world.read"),
    ).toHaveLength(reads + 1),
  );
  expect(input.value).toBe("Keep this draft");
  expect(screen.queryByText("对话连接已断开，正在重新连接…")).toBeNull();
});

test("a lost play response and failed recovery preserve the draft until a read confirms its exchange", async () => {
  let chain: V1PlayCallChainView | null = null;
  let offline = false;
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    if (input.type === "world.read") {
      if (offline) throw new Error("World is offline");
      return await Promise.resolve(worldView(chain));
    }
    if (input.type === "world.play-decorations.read")
      return { artifacts: [], debug: [] };
    if (input.type === "play.chain.start") {
      chain = playChainView(input.chainId, input.exchangeId, input.playerText);
      offline = true;
      throw new RuntimeRequestError("The response was lost", {
        kind: "connection",
      });
    }
    if (
      input.type === "play.chain.inspect" ||
      input.type === "play.timeline.page"
    )
      throw new Error("Offline");
    throw new Error(input.type);
  });
  renderWorld({ request });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  fireEvent.change(input, { target: { value: "Look outside." } });
  fireEvent.click(screen.getByRole("button", { name: "发送第一步行动" }));
  await screen.findByText("暂时无法同步");
  expect(input.value).toBe("Look outside.");
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByText("Alex opens the door and lets you go first.");
  await waitFor(() => expect(screen.queryByText("暂时无法同步")).toBeNull());
  expect(input.value).toBe("");
  expect(screen.queryByText("The response was lost")).toBeNull();
  expect(
    request.mock.calls.filter(([next]) => next.type === "play.chain.start"),
  ).toHaveLength(1);
});

test("a recovered older exchange with identical action text cannot confirm a lost submission", async () => {
  const chain = playChainView("existing", "older-exchange", "Look outside.");
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    if (input.type === "world.read")
      return await Promise.resolve(worldView(chain));
    if (input.type === "world.play-decorations.read")
      return { artifacts: [], debug: [] };
    if (input.type === "play.chain.inspect") return chain;
    if (input.type === "play.chain.append")
      throw new RuntimeRequestError("No response received", {
        kind: "connection",
      });
    throw new Error(input.type);
  });
  renderWorld({ request });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  fireEvent.change(input, { target: { value: "Look outside." } });
  fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));
  await screen.findByText("No response received");
  expect(input.value).toBe("Look outside.");
  expect(screen.queryByText("暂时无法同步")).toBeNull();
  expect(
    request.mock.calls.filter(([next]) => next.type === "play.chain.append"),
  ).toHaveLength(1);
  expect(
    request.mock.calls.filter(([next]) => next.type === "world.read"),
  ).toHaveLength(2);
});

test("a later action in the same context cannot hide the recovered submission identity", async () => {
  let chain = playChainView("existing", "first", "Begin.");
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    if (input.type === "world.read")
      return await Promise.resolve(worldView(chain));
    if (input.type === "world.play-decorations.read")
      return { artifacts: [], debug: [] };
    if (input.type === "play.chain.inspect") return chain;
    if (input.type === "play.chain.append") {
      chain = {
        ...chain,
        parentHead: "commit:7",
        events: [
          ...chain.events,
          {
            id: 5,
            kind: "player",
            text: input.playerText,
            context: "append",
            exchangeId: input.exchangeId,
            committedHead: "commit:5",
          },
          {
            id: 6,
            kind: "player",
            text: "A later action from another page.",
            context: "append",
            exchangeId: "peer-exchange",
            committedHead: "commit:6",
          },
        ],
      };
      throw new RuntimeRequestError("No response received", {
        kind: "connection",
      });
    }
    throw new Error(input.type);
  });
  renderWorld({ request });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  fireEvent.change(input, { target: { value: "Look outside." } });
  fireEvent.click(screen.getByRole("button", { name: "接着当前对话继续" }));
  await screen.findByText("A later action from another page.");
  await waitFor(() => expect(input.value).toBe(""));
  expect(screen.queryByText("No response received")).toBeNull();
  expect(
    request.mock.calls.filter(([next]) => next.type === "play.chain.append"),
  ).toHaveLength(1);
});

function lightweightPlayTimeline(
  chain: V1PlayCallChainView,
): V1PlayTimelinePage {
  return {
    worldId: chain.worldId,
    generation: `lightweight:${chain.chainId}`,
    activeChainId: chain.chainId,
    activeStatus: chain.status,
    activeInvocationExchangeId: chain.activeInvocation?.exchangeId ?? null,
    activeCanRetry: chain.canRetry,
    activeLastFailure: chain.lastFailure,
    nextCursor: null,
    items: chain.events
      .filter((event) => event.kind === "player" || event.kind === "assistant")
      .map((event) => ({
        kind: "event",
        chainId: chain.chainId,
        current: true,
        event: {
          ...event,
          hasReasoning: false,
          hasToolFragment: false,
          hasUsage: false,
          detailsAvailable: false,
        },
      })),
  };
}

test.each(["initial", "recovery", "retry-recovery"] as const)(
  "a lightweight %s projection keeps the running exchange cancellable",
  async (phase) => {
    const now = Date.now();
    const chain: V1PlayCallChainView = {
      ...playChainView(
        "lightweight-running",
        "lightweight-exchange",
        "Wait for Alex.",
      ),
      status: "running",
      contextWindowTokens: 10_000,
      latestCompletedResponse: {
        id: 4,
        usage: {
          ...emptyAggregatedModelUsage(),
          inputTokens: 6_200,
          provenance: {
            ...emptyAggregatedModelUsage().provenance,
            inputTokens: "provider",
          },
        },
      },
      activeInvocation: {
        chainId: "lightweight-running",
        exchangeId:
          phase === "retry-recovery"
            ? "lightweight-retry-exchange"
            : "lightweight-exchange",
        phase: "waiting",
        startedAt: now - 95_000,
        lastActivityAt: now - 91_000,
        reasoningChars: 14,
        textChars: 0,
        toolChars: 0,
        toolCalls: 0,
        dispatches: 1,
      },
    };
    let light = phase === "initial";
    let connection: Parameters<ObserveConversation>[2];
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read")
        return Promise.resolve(
          light
            ? {
                ...worldView(null),
                head: chain.parentHead,
                playTimeline: lightweightPlayTimeline(chain),
              }
            : worldView(chain),
        );
      if (input.type === "world.play-decorations.read")
        return Promise.resolve({ artifacts: [], debug: [] });
      if (input.type === "play.chain.cancel")
        return Promise.resolve({ outcome: "cancellation_requested" });
      if (input.type === "play.chain.inspect") return Promise.resolve(null);
      return Promise.reject(new Error(input.type));
    });
    renderWorld({
      request,
      observeConversation: (_target, _receive, notify) => {
        connection = notify;
        return () => undefined;
      },
    });
    if (phase !== "initial") {
      await screen.findByText("上下文 62%");
      await screen.findByText(/模型调用可能已经卡住/u);
      light = true;
      act(() => connection?.("failed"));
      await waitFor(() =>
        expect(
          request.mock.calls.filter(([input]) => input.type === "world.read"),
        ).toHaveLength(2),
      );
      expect(screen.getByText("上下文 62%")).toBeTruthy();
      expect(screen.getByText(/模型调用可能已经卡住/u)).toBeTruthy();
    }
    const cancel = await screen.findByRole("button", { name: "取消生成" });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: "play.chain.cancel",
        worldId: "world-one",
        chainId: "lightweight-running",
        exchangeId:
          phase === "retry-recovery"
            ? "lightweight-retry-exchange"
            : "lightweight-exchange",
      }),
    );
  },
);

test("a confirmed play receipt keeps the timeline fallback usable when world reads fail", async () => {
  let chain: V1PlayCallChainView | null = null;
  const request = vi.fn((input: V1Request): Promise<unknown> => {
    if (input.type === "world.read")
      return chain === null
        ? Promise.resolve(worldView(null))
        : Promise.reject(new Error("World read unavailable"));
    if (input.type === "world.play-decorations.read")
      return Promise.resolve({ artifacts: [], debug: [] });
    if (input.type === "play.chain.start") {
      chain = playChainView(input.chainId, input.exchangeId, input.playerText);
      return Promise.resolve(chain);
    }
    if (input.type === "play.timeline.page" && chain !== null)
      return Promise.resolve(lightweightPlayTimeline(chain));
    return Promise.reject(new Error(input.type));
  });
  renderWorld({ request, observeConversation: () => () => undefined });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  fireEvent.change(input, { target: { value: "Open the door." } });
  fireEvent.click(screen.getByRole("button", { name: "发送第一步行动" }));
  await screen.findByText("暂时无法同步");
  await screen.findByText("Alex opens the door and lets you go first.");
  fireEvent.change(input, {
    target: { value: "Continue from the committed response." },
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "追加行动" })
      .disabled,
  ).toBe(false);
  expect(
    request.mock.calls.filter(([input]) => input.type === "world.read"),
  ).toHaveLength(3);
  expect(
    request.mock.calls.filter(([input]) => input.type === "play.chain.start"),
  ).toHaveLength(1);
});

test("streaming text stays visible while slow world hydration uses one read", async () => {
  const initial = playChainView("live-chain", "live-exchange", "Look outside.");
  const running: V1PlayCallChainView = {
    ...initial,
    status: "running",
    activeInvocation: createObservedProgress(initial.chainId, "live-exchange"),
    events: initial.events.map((event) => {
      if (event.kind !== "assistant") return event;
      const pending: typeof event = {
        ...event,
        status: "streaming",
        responseKind: "pending",
        text: "Look",
      };
      delete pending.committedHead;
      return pending;
    }),
  };
  const projection = {
    ...worldView(null),
    head: running.parentHead,
    playTimeline: lightweightPlayTimeline(running),
  };
  const beforeRun = lightweightPlayTimeline({
    ...initial,
    events: initial.events.filter((event) => event.kind === "player"),
  });
  const slowRead = Promise.withResolvers<typeof projection>();
  let receive!: Parameters<ObserveConversation>[1];
  let connect!: NonNullable<Parameters<ObserveConversation>[2]>;
  const request = vi.fn((input: V1Request): Promise<unknown> => {
    if (input.type === "world.read") {
      if (worldReads() === 1)
        return Promise.resolve({ ...projection, playTimeline: beforeRun });
      if (worldReads() === 2) return slowRead.promise;
      return Promise.resolve(projection);
    }
    if (input.type === "world.play-decorations.read")
      return Promise.resolve({ artifacts: [], debug: [] });
    return Promise.reject(new Error(input.type));
  });
  const worldReads = () =>
    request.mock.calls.filter(([input]) => input.type === "world.read").length;
  renderWorld({
    request,
    observeConversation: (_target, callback, connection) => {
      receive = callback;
      connect = connection!;
      return () => undefined;
    },
  });
  await screen.findByLabelText("你的行动");

  const publish = (text: string) => {
    const value = {
      ...running,
      events: running.events.map((event) =>
        event.kind === "assistant" ? { ...event, text } : event,
      ),
    };
    act(() => void receive({ kind: "play", value }, true));
    expect(screen.getByText(text)).toBeTruthy();
  };
  publish("Look");
  await waitFor(() => expect(worldReads()).toBe(2));
  publish("Look at the courtyard");
  publish("Look at the courtyard from the window");

  await act(() => {
    slowRead.resolve(projection);
    return slowRead.promise;
  });
  expect(
    screen.getByText("Look at the courtyard from the window"),
  ).toBeTruthy();
  publish("Look at the courtyard from the window before sunset.");
  expect(worldReads()).toBe(2);

  act(() => connect("reconnecting"));
  await waitFor(() => expect(worldReads()).toBe(3));
  act(() => connect("connected"));
  publish("Look at the courtyard from the window before sunset. It is empty.");
  await waitFor(() => expect(worldReads()).toBe(4));
  expect(
    screen.getByText(
      "Look at the courtyard from the window before sunset. It is empty.",
    ),
  ).toBeTruthy();
});

test.each(["endpoint", "status", "invocation"])(
  "a native SSE %s change revalidates a blocked world read",
  async (change) => {
    class NativeSource extends EventTarget {
      static CLOSED = 2;
      static instances: NativeSource[] = [];
      readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        NativeSource.instances.push(this);
      }
      close(): void {
        this.readyState = 2;
      }
      snapshot(sequence: number, chain: V1PlayCallChainView): void {
        this.dispatchEvent(
          new MessageEvent("observation", {
            lastEventId: `live:${sequence}`,
            data: JSON.stringify({
              protocol: v1Protocol,
              update: {
                kind: "snapshot",
                value: { kind: "play", value: chain },
              },
            }),
          }),
        );
      }
    }
    vi.stubGlobal("EventSource", NativeSource);
    const ready = playChainView(
      "nonblocking-hydration",
      "native-exchange",
      "Look outside.",
    );
    const activeInvocation = createObservedProgress(
      ready.chainId,
      "native-exchange",
    );
    const running: V1PlayCallChainView = {
      ...ready,
      status: "running",
      activeInvocation,
      events: ready.events.filter((event) => event.kind === "player"),
    };
    const next: V1PlayCallChainView =
      change === "invocation"
        ? {
            ...running,
            activeInvocation: createObservedProgress(
              ready.chainId,
              "next-exchange",
            ),
          }
        : change === "endpoint"
          ? {
              ...ready,
              parentHead: "commit:9",
              status: "running",
              activeInvocation,
            }
          : ready;
    let reads = 0;
    let release!: () => void;
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read") {
        reads++;
        if (reads === 1)
          return Promise.resolve({
            ...worldView(null),
            head: running.parentHead,
            playTimeline: lightweightPlayTimeline(running),
          });
        if (reads === 2)
          return new Promise((resolve) => {
            release = () => resolve(worldView(running));
          });
        return Promise.resolve(worldView(next));
      }
      if (input.type === "world.play-decorations.read")
        return Promise.resolve({ artifacts: [], debug: [] });
      if (input.type === "play.chain.cancel")
        return Promise.resolve({ outcome: "cancellation_requested" });
      if (input.type === "play.chain.inspect") return Promise.resolve(null);
      return Promise.reject(new Error(input.type));
    });
    renderWorld({ request, observeConversation });
    await screen.findByLabelText("你的行动");
    const source = NativeSource.instances[0]!;
    act(() => source.snapshot(1, running));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      await act(() => {
        source.snapshot(2, next);
        return Promise.resolve();
      });
      if (change !== "invocation") {
        await screen.findByText("Alex opens the door and lets you go first.");
        expect(
          screen.queryByRole("button", { name: "取消生成" }) !== null,
        ).toBe(change === "endpoint");
      }
    } finally {
      await act(async () => {
        release();
        await Promise.resolve();
      });
    }
    expect(reads).toBe(3);
    if (change === "invocation") {
      await act(() => {
        fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
        return Promise.resolve();
      });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "play.chain.cancel",
          exchangeId: "next-exchange",
        }),
      );
      return;
    }
    expect(
      screen.getByText("Alex opens the door and lets you go first."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("你的行动"), {
      target: { value: "Keep going." },
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "追加行动" })
        .disabled,
    ).toBe(change === "endpoint");
  },
);

test.each([
  "initial-retry",
  "peer-action",
  "peer-retry",
  "peer-ready",
  "no-live-invocation",
] as const)(
  "lightweight cancellation follows Runtime identity after %s",
  async (scenario) => {
    const old: V1PlayCallChainView = {
      ...playChainView(
        "shared-context",
        "first-player-exchange",
        "First action.",
      ),
      status: "running",
      activeInvocation: {
        ...createObservedProgress("shared-context", "first-player-exchange"),
        startedAt: Date.now() - 95_000,
        lastActivityAt: Date.now() - 91_000,
      },
    };
    const next: V1PlayCallChainView = {
      ...old,
      activeInvocation: createObservedProgress(
        "shared-context",
        "actual-live-exchange",
      ),
      events:
        scenario === "peer-action"
          ? [
              ...old.events,
              {
                id: 5,
                kind: "player",
                exchangeId: "actual-live-exchange",
                text: "A newer player action.",
                context: "append",
                committedHead: "commit:4",
              },
            ]
          : old.events,
    };
    const page = {
      ...lightweightPlayTimeline(next),
      activeInvocationExchangeId:
        scenario === "no-live-invocation" ? null : "actual-live-exchange",
    };
    let light = scenario === "initial-retry";
    let connection: Parameters<ObserveConversation>[2];
    let receive: Parameters<ObserveConversation>[1];
    const request = vi.fn((input: V1Request): Promise<unknown> => {
      if (input.type === "world.read")
        return Promise.resolve(
          light
            ? { ...worldView(null), head: next.parentHead, playTimeline: page }
            : worldView(old),
        );
      if (input.type === "world.play-decorations.read")
        return Promise.resolve({ artifacts: [], debug: [] });
      if (input.type === "play.chain.cancel")
        return Promise.resolve({ outcome: "cancellation_requested" });
      if (input.type === "play.chain.inspect") return Promise.resolve(null);
      return Promise.reject(new Error(input.type));
    });
    renderWorld({
      request,
      observeConversation: (_target, callback, notify) => {
        receive = callback;
        connection = notify;
        return () => undefined;
      },
    });
    if (scenario !== "initial-retry") {
      await screen.findByText(/模型调用可能已经卡住/u);
      light = true;
      act(() => connection?.("failed"));
      await waitFor(() =>
        expect(
          request.mock.calls.filter(([input]) => input.type === "world.read"),
        ).toHaveLength(2),
      );
    }
    if (
      scenario === "peer-retry" ||
      scenario === "peer-ready" ||
      scenario === "no-live-invocation"
    ) {
      await act(async () => {
        const { activeInvocation: _invocation, ...settled } = old;
        void _invocation;
        await receive(
          {
            kind: "play",
            value:
              scenario === "peer-ready" ? { ...settled, status: "ready" } : old,
          },
          true,
        );
        await Promise.resolve();
      });
    }
    if (scenario === "no-live-invocation") {
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull(),
      );
      return;
    }
    const cancel = await screen.findByRole("button", { name: "取消生成" });
    expect(screen.queryByText(/模型调用可能已经卡住/u)).toBeNull();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: "play.chain.cancel",
        worldId: "world-one",
        chainId: "shared-context",
        exchangeId: "actual-live-exchange",
      }),
    );
  },
);

test("a legacy lightweight running projection cannot invent cancellation identity from a player event", async () => {
  const old = {
    ...playChainView(
      "legacy-running",
      "old-player-exchange",
      "An older action.",
    ),
    status: "running" as const,
  };
  const { activeInvocationExchangeId: _identity, ...page } =
    lightweightPlayTimeline(old);
  void _identity;
  const request = vi.fn((input: V1Request): Promise<unknown> => {
    if (input.type === "world.read")
      return Promise.resolve({ ...worldView(null), playTimeline: page });
    if (input.type === "world.play-decorations.read")
      return Promise.resolve({ artifacts: [], debug: [] });
    return Promise.reject(new Error(input.type));
  });
  renderWorld({ request, observeConversation: () => () => undefined });
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "你的行动",
  });
  expect(input.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
});

function createObservedProgress(chainId: string, exchangeId: string) {
  return {
    chainId,
    exchangeId,
    phase: "waiting" as const,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    reasoningChars: 0,
    textChars: 0,
    toolChars: 0,
    toolCalls: 0,
    dispatches: 1,
  };
}

test("automatic retry updates one progress position then disappears after success", async () => {
  let receive!: Parameters<ObserveConversation>[1];
  let chain = playChainView("retry-chain", "retry-send", "Go");
  chain.status = "running";
  chain.activeInvocation = {
    chainId: chain.chainId,
    exchangeId: "retry-send",
    phase: "waiting",
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    reasoningChars: 0,
    textChars: 0,
    toolChars: 0,
    toolCalls: 0,
    dispatches: 1,
  };
  const assistant = chain.events.find((event) => event.kind === "assistant")!;
  if (assistant.kind !== "assistant") throw new Error("missing assistant");
  assistant.status = "streaming";
  assistant.text = "";
  assistant.retries = [
    {
      retry: 1,
      reason: "rate_limit",
      waitMs: 1000,
      retryAt: Date.now() + 1000,
      status: "waiting",
    },
  ];
  const client = {
    observeConversation: ((_target, callback) => {
      receive = callback;
      return vi.fn();
    }) satisfies ObserveConversation,
    request: vi.fn((request: V1Request) => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(chain));
      if (request.type === "world.play-decorations.read")
        return Promise.resolve(
          playDecorations(null, "world-one", chain.parentHead),
        );
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  renderWorld(client);
  await screen.findByRole("heading", { name: "宿舍世界" });
  await screen.findByText("自动重试 1/5", { exact: false });
  expect(
    document.querySelectorAll(".play-run-progress .model-retry-status p"),
  ).toHaveLength(1);
  expect(screen.queryByText("正在等待模型响应…")).toBeNull();
  assistant.retries.push({
    retry: 2,
    reason: "connect_timeout",
    waitMs: 2000,
    retryAt: Date.now() + 2000,
    status: "waiting",
  });
  chain = { ...chain, updatedAt: chain.updatedAt + 1 };
  await act(async () => {
    await receive({ kind: "play", value: structuredClone(chain) }, true);
  });
  await screen.findByText("自动重试 2/3", { exact: false });
  expect(
    document.querySelectorAll(".play-run-progress .model-retry-status p"),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll(".call-chain-failure[role=alert]"),
  ).toHaveLength(0);
  assistant.status = "completed";
  assistant.text = "Recovered story";
  chain = { ...chain, status: "ready", updatedAt: chain.updatedAt + 1 };
  await act(async () => {
    await receive({ kind: "play", value: structuredClone(chain) }, true);
  });
  await screen.findByText("Recovered story");
  expect(
    document.querySelector(".play-run-progress .model-retry-status"),
  ).toBeNull();
  expect(
    document.querySelectorAll(".call-chain-failure[role=alert]"),
  ).toHaveLength(0);
});

test("multiple failed followups for one reply collapse into one summary without counting successful requests", async () => {
  const chain = playChainView("failed-followups", "send", "Go");
  chain.events.push(
    ...["one", "two", "ok"].map((name, index) => ({
      id: 10 + index,
      kind: "followup" as const,
      followupId: name,
      displayName: `Panel ${name}`,
      replyEventId: 4,
      status: "completed" as const,
      text: "",
      toolCalls: [],
      ...(name === "ok" ? {} : { failure: "Temporary rate limit exhausted" }),
    })),
  );
  const client = {
    request: vi.fn((request: V1Request) => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(chain));
      if (request.type === "world.play-decorations.read")
        return Promise.resolve(
          playDecorations(null, "world-one", chain.parentHead),
        );
      throw new Error(`Unexpected request ${request.type}`);
    }),
  };
  renderWorld(client);
  await screen.findByText("2 个后置请求未完成");
  expect(
    document.querySelectorAll(".call-chain-followup-summary"),
  ).toHaveLength(1);
  const summary = document.querySelector<HTMLDetailsElement>(
    ".call-chain-followup-summary > details",
  )!;
  expect(summary.open).toBe(false);
  expect(summary.textContent).toContain("Panel one");
  expect(summary.textContent).toContain("Panel two");
  expect(summary.textContent).not.toContain("Panel ok");
  expect(
    screen.getByText("Alex opens the door and lets you go first."),
  ).toBeTruthy();
});

test("a replacement snapshot deletes the failed attempt from an already loaded timeline", async () => {
  let chain = interruptedChainView();
  let receive!: Parameters<ObserveConversation>[1];
  const client = {
    observeConversation: ((_target, callback) => {
      receive = callback;
      return vi.fn();
    }) satisfies ObserveConversation,
    request: vi.fn((request: V1Request) => {
      if (request.type === "world.read")
        return Promise.resolve(worldView(chain));
      if (request.type === "world.play-decorations.read")
        return Promise.resolve(
          playDecorations(null, "world-one", chain.parentHead),
        );
      return Promise.resolve({ status: "unavailable", messages: [] });
    }),
  };
  renderWorld(client, undefined, {
    initialReadingPreferences: {
      ...defaultAppReadingPreferences,
      showTechnicalInfo: true,
    },
  });
  await screen.findByRole("heading", { name: "宿舍世界" });
  expect(document.body.textContent).toContain(
    "The Provider stream disconnected midway.",
  );
  chain = {
    ...chain,
    status: "running",
    canRetry: false,
    lastFailure: null,
    updatedAt: 2,
    supersededEventIds: [2, 3],
    events: [
      chain.events[0]!,
      {
        id: 4,
        kind: "assistant",
        status: "streaming",
        text: "",
        responseKind: "pending",
        exchange: 2,
        attempt: 2,
      },
    ],
  };
  await act(async () => {
    await receive({ kind: "play", value: structuredClone(chain) }, true);
  });
  expect(document.body.textContent).not.toContain(
    "The Provider stream disconnected midway.",
  );
  expect(document.body.textContent).not.toContain(
    "Alex has opened the door halfway",
  );
  expect(document.body.textContent).not.toContain("历史尝试");
  expect(document.querySelectorAll(".model-call")).toHaveLength(1);
});
