import { afterEach, expect, test, vi } from "vitest";

import {
  RuntimeClient,
  RuntimeRequestError,
} from "../../src/web/runtimeClient.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(body, { status }))),
  );
}

test("意外 Runtime 错误显示服务端原文而不是只有状态码", async () => {
  respondWith(500, {
    statusCode: 500,
    error: "Internal Server Error",
    message: "The parent endpoint of the play operation has changed",
  });
  const failure = await new RuntimeClient()
    .request({ type: "workspace.read" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RuntimeRequestError);
  expect(failure).toMatchObject({
    message: "The parent endpoint of the play operation has changed",
    protocolCode: undefined,
  });
});

test("协议错误保留错误码与原文", async () => {
  respondWith(400, {
    protocol: "narraeon.runtime/v1",
    error: { code: "invalid_request", message: "Use a fresh context." },
  });
  await expect(
    new RuntimeClient().request({ type: "workspace.read" }),
  ).rejects.toMatchObject({
    message: "Use a fresh context.",
    protocolCode: "invalid_request",
  });
});
