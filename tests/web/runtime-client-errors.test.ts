// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AppErrorBoundary } from "../../src/web/AppErrorBoundary.tsx";
import {
  conversationConnectionText,
  observeConversation,
} from "../../src/web/ConversationObserver.ts";
import { setWebLocale } from "../../src/web/i18n.ts";
import { runtimeErrorText } from "../../src/web/RuntimeErrorText.ts";
import {
  RuntimeClient,
  RuntimeRequestError,
} from "../../src/web/runtimeClient.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWebLocale("zh-CN");
});

function respondWith(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  );
}

async function requestFailure(): Promise<unknown> {
  return new RuntimeClient()
    .request({ type: "workspace.read" })
    .catch((error: unknown) => error);
}

test("意外 Runtime 错误显示服务端原文对应的友好提示", async () => {
  respondWith(
    Response.json(
      {
        statusCode: 500,
        error: "Internal Server Error",
        message: "The parent endpoint of the play operation has changed",
      },
      { status: 500 },
    ),
  );
  const failure = await requestFailure();
  expect(failure).toBeInstanceOf(RuntimeRequestError);
  expect(failure).toMatchObject({
    message: "世界刚被其他操作更新，这次操作没有生效。请刷新页面后重试。",
    protocolCode: undefined,
  });
});

test("未知错误原文不被隐藏，协议错误保留错误码", async () => {
  respondWith(
    Response.json(
      {
        protocol: "narraeon.runtime/v1",
        error: { code: "invalid_request", message: "Some new failure." },
      },
      { status: 400 },
    ),
  );
  expect(await requestFailure()).toMatchObject({
    message: "Some new failure.",
    protocolCode: "invalid_request",
  });
});

test("反向代理返回 HTML 时说明服务暂时不可用", async () => {
  respondWith(
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    }),
  );
  expect(await requestFailure()).toMatchObject({
    message: "Narraeon 服务暂时不可用（HTTP 502），可能正在重启，请稍后重试。",
  });
});

test("网络断开时说明无法连接服务", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
  expect(await requestFailure()).toMatchObject({
    message: "无法连接到 Narraeon 服务。请确认服务正在运行、网络连接正常。",
  });
});

test("常见 Runtime 错误都有中英文提示", () => {
  const samples = [
    "A model request is still running; wait for it to return before revising committed history.",
    "Another operation has advanced the current world; use a fresh context.",
    "Timeline editing is locked while a world revision is open",
    "This world was imported from a backup; start a fresh context before continuing.",
    "The current model context cannot continue; use a fresh context.",
    "The selected model protocol differs from this context. Switch back to its original protocol to continue, or start a fresh context.",
    "The call chain does not exist; start from the latest world state.",
    "World does not exist",
    "World Authority is being updated by another durable operation",
    "The timeline revision was committed, but current-world materialization has not reached the new endpoint.",
    "A world backup is being exported; wait for it to finish",
    "World name must contain 1 to 160 characters and no line breaks",
    "Edited player message cannot be empty",
    "The world-revision worktree changed; refresh it before writing",
    "Wait for or cancel the running AI response before changing the revision",
  ];
  for (const sample of samples) {
    setWebLocale("zh-CN");
    const chinese = runtimeErrorText(sample);
    expect(chinese, sample).toMatch(/\p{Script=Han}/u);
    setWebLocale("en");
    const english = runtimeErrorText(sample);
    expect(english, sample).not.toMatch(/\p{Script=Han}/u);
    expect(english, sample).not.toBe(sample);
  }
});

test("对话同步失败时显示服务端给出的原因", () => {
  class Source extends EventTarget {
    static CLOSED = 2;
    static instance: Source | null = null;
    readyState = 1;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      Source.instance = this;
    }
    close() {
      this.readyState = 2;
    }
  }
  vi.stubGlobal("EventSource", Source);
  const connection = vi.fn();
  const close = observeConversation(
    { kind: "play", id: "world-one" },
    () => undefined,
    connection,
  );
  Source.instance!.dispatchEvent(
    new MessageEvent("failure", {
      data: JSON.stringify({ message: "World does not exist" }),
    }),
  );
  expect(connection).toHaveBeenCalledWith(
    "failed",
    "世界不存在，可能已被删除。",
  );
  expect(
    conversationConnectionText("failed", "世界不存在，可能已被删除。"),
  ).toBe("对话同步失败：世界不存在，可能已被删除。　请重新打开此页面。");
  expect(conversationConnectionText("failed")).toBe(
    "对话同步失败，请重新打开此页面。",
  );
  close();
});

test("页面渲染出错时显示原因和重新加载按钮，而不是空白页", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  function Broken(): never {
    throw new Error("Cannot read properties of undefined (reading 'events')");
  }
  render(createElement(AppErrorBoundary, null, createElement(Broken)));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByText("页面出错了")).toBeTruthy();
  expect(
    screen.getByText("Cannot read properties of undefined (reading 'events')"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新加载页面" })).toBeTruthy();
  expect(screen.getByText("技术详情")).toBeTruthy();
});
