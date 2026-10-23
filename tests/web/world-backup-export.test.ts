// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi, type Mock } from "vitest";

import { WorldBackupExportButton } from "../../src/web/WorldArchiveControls.tsx";
import { uiText } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function exportClient() {
  return {
    request: vi.fn(() =>
      Promise.resolve({
        archiveId: "archive-1",
        fileName: "雾港.narraeon-world.zip",
        bytes: 42,
      }),
    ),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestedUrls(
  fetchMock: Mock<(url: string) => Promise<Response>>,
): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

test("备份下载返回 404 时页面说明原因，不显示已开始下载", async () => {
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
    Promise.resolve(
      jsonResponse(404, {
        error: {
          code: "invalid_archive",
          message: "The archive download is unavailable",
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);

  render(
    createElement(WorldBackupExportButton, {
      client: exportClient(),
      worldId: "world-1",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: uiText("导出世界备份") }));

  expect(
    await screen.findByText(uiText("备份已失效或不存在，请重新导出。")),
  ).toBeTruthy();
  expect(screen.queryByText(uiText("世界备份已开始下载。"))).toBeNull();
  expect(requestedUrls(fetchMock)).toEqual([
    "/api/runtime/v1/world-archives/archive-1/check",
  ]);
  expect(click).not.toHaveBeenCalled();
});

test("备份服务端出错且没有错误码时显示通用下载失败提示", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        jsonResponse(500, {
          statusCode: 500,
          error: "Internal Server Error",
          message: "boom",
        }),
      ),
    ),
  );

  render(
    createElement(WorldBackupExportButton, {
      client: exportClient(),
      worldId: "world-1",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: uiText("导出世界备份") }));

  expect(await screen.findByText(uiText("下载失败，请重试。"))).toBeTruthy();
  expect(screen.queryByText(uiText("世界备份已开始下载。"))).toBeNull();
});

test("备份可以下载时只做轻量检查，再以同一路径触发浏览器下载", async () => {
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const downloads: { href: string | null; download: string | null }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({
      href: this.getAttribute("href"),
      download: this.getAttribute("download"),
    });
  });

  render(
    createElement(WorldBackupExportButton, {
      client: exportClient(),
      worldId: "world-1",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: uiText("导出世界备份") }));

  expect(await screen.findByText(uiText("世界备份已开始下载。"))).toBeTruthy();
  expect(requestedUrls(fetchMock)).toEqual([
    "/api/runtime/v1/world-archives/archive-1/check",
  ]);
  expect(downloads).toEqual([
    {
      href: "/api/runtime/v1/world-archives/archive-1",
      download: "雾港.narraeon-world.zip",
    },
  ]);
});
