import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, expect, test } from "vitest";

import {
  v1Protocol,
  type V1PlayCallChainView,
  type V1Request,
} from "../../src/protocol/v1.ts";
import type { PlayCallChainObserver } from "../../src/runtime/play/PlayCallChain.ts";
import type { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { createServer } from "../../src/server/createServer.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import { createZip } from "../support/createZip.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function playChainView(
  status: V1PlayCallChainView["status"],
  text: string,
): V1PlayCallChainView {
  return {
    chainId: "chain-one",
    worldId: "world-one",
    baselineHead: "genesis",
    parentHead: status === "ready" ? "commit:2" : "commit:1",
    playPreset: { id: "preset", name: "默认", revision: "revision" },
    status,
    canRetry: false,
    previousContexts: [],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId: "exchange-one",
        text: "我示意秦龙开门。",
        context: "fresh",
        committedHead: "commit:1",
      },
      {
        id: 2,
        kind: "assistant",
        text,
        status: status === "ready" ? "completed" : "streaming",
        exchange: 1,
        attempt: 1,
        ...(status === "ready" ? { committedHead: "commit:2" } : {}),
      },
    ],
    changedDocuments: [],
    lastFailure: null,
    updatedAt: status === "ready" ? 3 : 1,
  };
}

test("进度轮询不写访问日志，调用链中断写出原始 Provider 原因", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-server-log-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");

  let output = "";
  const logStream = new Writable({
    write(
      chunk: string | Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      callback();
    },
  });
  const runtime = {
    handle(request: V1Request) {
      if (request.type === "play.chain.start")
        return Promise.resolve({
          protocol: v1Protocol,
          result: {
            status: "interrupted",
            lastFailure: "Provider 请求失败：502 upstream disconnected",
          },
        });
      return Promise.resolve({ protocol: v1Protocol, result: null });
    },
  } as unknown as V1Runtime;
  const server = await createServer({
    runtime,
    staticRoot,
    port: 4317,
    logStream,
  });
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4317",
  };

  const progress = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.progress",
        improvementId: "improvement-one",
      },
    },
  });
  expect(progress.statusCode).toBe(200);
  expect(progress.headers["content-security-policy"]).toContain(
    "style-src 'self' 'unsafe-inline'",
  );

  const chainInspection = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: { type: "play.chain.inspect", worldId: "world-one" },
    },
  });
  expect(chainInspection.statusCode).toBe(200);

  const interrupted = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: {
        type: "play.chain.start",
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-one",
        playerText: "继续。",
      },
    },
  });
  expect(interrupted.statusCode).toBe(200);
  await server.close();

  const entries = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries.filter(({ msg }) => msg === "incoming request")).toHaveLength(
    1,
  );
  expect(entries.filter(({ msg }) => msg === "request completed")).toHaveLength(
    1,
  );
  expect(
    entries.find(({ msg }) => msg === "play call interrupted"),
  ).toMatchObject({
    runtimeRequestType: "play.chain.start",
    playCallFailure: "Provider 请求失败：502 upstream disconnected",
  });
});

test("生产 HTTP 边界把 Provider 文本增量作为 NDJSON 调用链流直接推给浏览器", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-play-stream-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
  const running = playChainView("running", "");
  const completed = playChainView("ready", "秦龙推开了门。");
  const runtime = {
    handle(_request: V1Request, observer?: PlayCallChainObserver) {
      observer?.onSnapshot?.(running);
      observer?.onAssistantDelta?.({
        eventId: 2,
        kind: "reasoning",
        text: "先确认门口",
        updatedAt: 2,
      });
      observer?.onAssistantDelta?.({
        eventId: 2,
        kind: "text",
        text: "秦龙推",
        updatedAt: 2,
      });
      return Promise.resolve({ protocol: v1Protocol, result: completed });
    },
  } as unknown as V1Runtime;
  const server = await createServer({
    runtime,
    staticRoot,
    port: 4317,
    logger: false,
  });

  const response = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/json",
      origin: "http://127.0.0.1:4317",
    },
    payload: {
      protocol: v1Protocol,
      request: {
        type: "play.chain.start",
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-one",
        playerText: "我示意秦龙开门。",
      },
    },
  });
  await server.close();

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/x-ndjson");
  const frames = response.body
    .trim()
    .split("\n")
    .map(
      (line) =>
        (JSON.parse(line) as { frame: { kind: string; final?: boolean } })
          .frame,
    );
  expect(frames.map(({ kind }) => kind)).toEqual([
    "snapshot",
    "assistant_delta",
    "assistant_delta",
    "snapshot",
  ]);
  expect(frames.at(-1)).toMatchObject({ kind: "snapshot", final: true });
});

test("生产 HTTP 边界只接受显式 runtime/v1 envelope 并返回当前工作区", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-server-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
  const runtime = await createRuntime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
    logRoot: join(root, "logs"),
  });
  const server = await createServer({
    runtime,
    staticRoot,
    port: 4317,
    logger: false,
  });
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4317",
  };

  // 同源检查是这个本地边界唯一的门禁：没有 Origin 或来自别处的请求一律拒绝，
  // 而带对 Origin 的请求不需要任何随进程变化的令牌，重启服务不会作废已打开的页面。
  for (const origin of [undefined, "http://evil.example"]) {
    const rejected = await server.inject({
      method: "POST",
      url: "/api/runtime/v1",
      headers: {
        "content-type": "application/json",
        ...(origin === undefined ? {} : { origin }),
      },
      payload: {
        protocol: "narraeon.runtime/v1",
        request: { type: "workspace.read" },
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      error: { code: "forbidden_request" },
    });
  }

  const bareRequest = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: { type: "get_workspace_state" },
  });
  expect(bareRequest.statusCode).toBe(400);
  expect(bareRequest.json()).toMatchObject({
    error: { code: "incompatible_data" },
  });

  const invalidProtocol = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "unrelated.runtime/v0",
      request: { type: "workspace.read" },
    },
  });
  expect(invalidProtocol.statusCode).toBe(400);
  expect(invalidProtocol.json()).toMatchObject({
    error: { code: "incompatible_data" },
  });

  const current = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "workspace.read" },
    },
  });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject({
    protocol: "narraeon.runtime/v1",
    result: {
      storageNotices: [],
    },
  });

  // 进度查询要过协议校验并落到会话查找上，而不是被当成未知请求类型拒绝。
  const unknownProgress = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "setting-improvement.progress",
        improvementId: "improvement-missing",
      },
    },
  });
  expect(unknownProgress.statusCode).toBe(500);
  expect(JSON.stringify(unknownProgress.json())).not.toContain(
    "invalid_request",
  );

  const malformedProgress = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "setting-improvement.progress" },
    },
  });
  expect(malformedProgress.statusCode).toBe(400);
  expect(malformedProgress.json()).toMatchObject({
    error: { code: "invalid_request" },
  });

  const pathImport = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "content.import", sourcePath: "/tmp/world" },
    },
  });
  expect(pathImport.statusCode).toBe(400);
  expect(pathImport.json()).toMatchObject({
    error: { code: "invalid_request" },
  });

  const archive = createZip([
    {
      path: "opening.md",
      contents: "你站在门前，屋内有人正等你回应。\n",
    },
  ]);
  const uploaded = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "content.import",
        archiveBase64: archive.toString("base64"),
      },
    },
  });
  expect(uploaded.statusCode).toBe(200);
  expect(uploaded.json()).toMatchObject({
    protocol: "narraeon.runtime/v1",
    result: { status: "needs_repair" },
  });

  const invalidArchive = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "content.import",
        archiveBase64: Buffer.from("not a zip").toString("base64"),
      },
    },
  });
  expect(invalidArchive.statusCode).toBe(400);
  expect(invalidArchive.json()).toMatchObject({
    error: { code: "invalid_request" },
  });
  expect(invalidArchive.body).toContain("zip");

  const unsupportedTree = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "content.import",
        archiveBase64: createZip([
          { path: "manifest.json", contents: "{}\n" },
        ]).toString("base64"),
      },
    },
  });
  expect(unsupportedTree.statusCode).toBe(400);
  expect(unsupportedTree.json()).toMatchObject({
    error: { code: "invalid_request" },
  });
  await server.close();
});
