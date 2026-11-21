import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, expect, test } from "vitest";

import {
  v1Protocol,
  type V1PlayCallChainStreamFrame,
  type V1PlayCallChainView,
  type V1Request,
} from "../../src/protocol/v1.ts";
import type { PlayCallChainObserver } from "../../src/runtime/play/PlayCallChain.ts";
import type { RuntimeErrorRecord } from "../../src/runtime/RuntimeErrorLog.ts";
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

test("写入前拒绝返回协议错误，存储故障仍返回服务错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-write-outcome-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot);
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
  const send = (request: V1Request) =>
    server.inject({
      authority: "127.0.0.1:4317",
      method: "POST",
      url: "/api/runtime/v1",
      headers: { "content-type": "application/json" },
      payload: { protocol: v1Protocol, request },
    });

  try {
    const model = {
      provider: "chat_completions" as const,
      modelId: "fixture",
      contextWindowTokens: 4096,
      maxOutputTokens: 512,
    };
    const connection = {
      ...model,
      name: "Custom",
      presetId: "custom" as const,
      baseUrl: "https://example.test",
    };
    const rejections: { request: V1Request; message: string }[] = [
      {
        request: { type: "world.rename", worldId: "world-missing", name: " " },
        message:
          "World name must contain 1 to 160 characters and no line breaks",
      },
      {
        request: { type: "world.rename", worldId: " ", name: "Revised" },
        message: "World ID is invalid",
      },
      {
        request: { type: "world.story.export", worldId: " ", format: "text" },
        message: "World ID is invalid",
      },
      {
        request: { type: "world.delete", worldId: "world-missing" },
        message: "World does not exist",
      },
      {
        request: {
          type: "world.story.export",
          worldId: "world-missing",
          format: "text",
        },
        message: "World does not exist",
      },
      {
        request: {
          type: "protagonist-templates.copy",
          id: "template-02c4f746-5cbd-4554-b3cb-51b51182149a",
        },
        message: "Protagonist template was not found",
      },
      {
        request: { type: "model.copy", connectionId: "missing", name: "Copy" },
        message: "The model configuration to copy was not found",
      },
      {
        request: { type: "model.save", connection },
        message: "A new model configuration requires an API key",
      },
      {
        request: { type: "play.select", presetId: "missing" },
        message: "Requested play preset was not found",
      },
    ];
    for (const { request, message } of rejections) {
      const response = await send(request);
      expect(response.statusCode, request.type).toBe(400);
      expect(response.json(), request.type).toMatchObject({
        protocol: v1Protocol,
        error: { code: "invalid_request", message },
      });
    }

    const sample = await send({ type: "content.create-sample", locale: "en" });
    expect(sample.statusCode).toBe(200);
    const packageId = sample.json<{ result: { localId: string } }>().result
      .localId;
    const rejectedTitle = await send({
      type: "content.rename",
      packageId,
      name: " ",
    });
    expect(rejectedTitle.statusCode).toBe(400);
    expect(rejectedTitle.json()).toMatchObject({
      protocol: v1Protocol,
      error: {
        code: "invalid_request",
        message:
          "A content-package title must contain 1 to 160 characters and no line breaks",
      },
    });
    const create = {
      type: "world.create" as const,
      operationId: "revision-world",
      packageId,
      model,
    };
    const missingModel = await send(create);
    expect(missingModel.statusCode).toBe(400);
    expect(missingModel.json()).toMatchObject({
      protocol: v1Protocol,
      error: {
        code: "invalid_request",
        message: "No V1 model connection is enabled",
      },
    });
    expect(
      (
        await send({
          type: "model.save",
          connection: { ...connection, apiKey: "fixture-key" },
        })
      ).statusCode,
    ).toBe(200);
    const created = await send(create);
    expect(created.statusCode).toBe(200);
    const {
      result: {
        world: { worldId },
      },
    } = created.json<{ result: { world: { worldId: string } } }>();
    expect(
      (await send({ type: "world.revision.open", worldId })).statusCode,
    ).toBe(200);
    const deletion = await send({ type: "world.delete", worldId });
    expect(deletion.json()).toMatchObject({
      protocol: v1Protocol,
      error: {
        code: "operation_conflict",
        message:
          "World play and other changes are locked while a world revision is open",
      },
    });
    expect((await send({ type: "world.read", worldId })).statusCode).toBe(200);

    await writeFile(join(root, "config", "model-connections-v1.json"), "{}", {
      mode: 0o600,
    });
    const storageFailure = await send({
      type: "model.copy",
      connectionId: "missing",
      name: "Copy",
    });
    expect(storageFailure.statusCode).toBe(500);
    expect(storageFailure.json()).not.toHaveProperty("protocol");
  } finally {
    await server.close();
  }
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
        text: "I signal Alex to open the door.",
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
      if (request.type === "play.chain.append")
        return Promise.resolve({
          protocol: v1Protocol,
          result:
            request.exchangeId === "budget-pause"
              ? {
                  ...playChainView("interrupted", ""),
                  lastFailure: "Play paused after 64 model requests.",
                  lastFailureKind: "dispatch_budget",
                  canRetry: true,
                }
              : {
                  status: "interrupted",
                  lastFailure: "The player cancelled model generation.",
                  lastCancelled: true,
                  events: [
                    {
                      id: 1,
                      kind: "cancellation",
                      message: "The player cancelled model generation.",
                    },
                  ],
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
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.read",
        packageId: "package-one",
      },
    },
  });
  expect(progress.statusCode).toBe(200);
  expect(progress.headers["content-security-policy"]).toContain(
    "style-src 'self' 'unsafe-inline'",
  );

  const chainInspection = await server.inject({
    authority: "127.0.0.1:4317",
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
    authority: "127.0.0.1:4317",
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
        playerText: "Continue.",
      },
    },
  });
  expect(interrupted.statusCode).toBe(200);
  const cancelled = await server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: {
        type: "play.chain.append",
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-two",
        playerText: "Continue.",
      },
    },
  });
  expect(cancelled.statusCode).toBe(200);
  for (const accept of ["application/json", "application/x-ndjson"]) {
    const paused = await server.inject({
      authority: "127.0.0.1:4317",
      method: "POST",
      url: "/api/runtime/v1",
      headers: { ...headers, accept },
      payload: {
        protocol: v1Protocol,
        request: {
          type: "play.chain.append",
          worldId: "world-one",
          chainId: "chain-one",
          exchangeId: "budget-pause",
          playerText: "",
        },
      },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.body).toContain('"lastFailureKind":"dispatch_budget"');
  }
  await server.close();

  const entries = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries.filter(({ msg }) => msg === "incoming request")).toHaveLength(
    4,
  );
  expect(entries.filter(({ msg }) => msg === "request completed")).toHaveLength(
    4,
  );
  const interruptions = entries.filter(
    ({ msg }) => msg === "play call interrupted",
  );
  expect(interruptions).toHaveLength(1);
  expect(interruptions[0]).toMatchObject({
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
  const completed = playChainView("ready", "Alex opens the door.");
  const runtime = {
    handle(_request: V1Request, observer?: PlayCallChainObserver) {
      observer?.onSnapshot?.(running);
      observer?.onAssistantDelta?.({
        eventId: 2,
        kind: "reasoning",
        text: "Check the doorway first",
        updatedAt: 2,
      });
      observer?.onAssistantDelta?.({
        eventId: 2,
        kind: "text",
        text: "Alex pushes",
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
    authority: "127.0.0.1:4317",
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
        playerText: "I signal Alex to open the door.",
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

test("模型流仍在等待时，独立的精确取消请求可以终止本轮并返回最终快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-play-cancel-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
  const running = playChainView("running", "");
  const activeAssistant = running.events.at(-1);
  if (activeAssistant?.kind !== "assistant")
    throw new Error("Expected an active assistant event");
  const cancelled: V1PlayCallChainView = {
    ...running,
    status: "interrupted",
    events: [
      running.events[0]!,
      { ...activeAssistant, status: "interrupted" },
      {
        id: 3,
        kind: "cancellation",
        message: "The player cancelled model generation.",
      },
    ],
    lastFailure: "The player cancelled model generation.",
    updatedAt: 3,
  };
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finish: (() => void) | undefined;
  const runtime = {
    handle(request: V1Request, observer?: PlayCallChainObserver) {
      if (request.type === "play.chain.start") {
        observer?.onSnapshot?.(running);
        markStarted?.();
        return new Promise<{ protocol: typeof v1Protocol; result: unknown }>(
          (resolve) => {
            finish = () => resolve({ protocol: v1Protocol, result: cancelled });
          },
        );
      }
      if (request.type === "play.chain.cancel") {
        expect(request).toMatchObject({
          worldId: "world-one",
          chainId: "chain-one",
          exchangeId: "exchange-one",
        });
        finish?.();
        return Promise.resolve({
          protocol: v1Protocol,
          result: { outcome: "cancellation_requested" },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${request.type}`));
    },
  } as unknown as V1Runtime;
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

  const streamed = server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers: { ...headers, accept: "application/x-ndjson" },
    payload: {
      protocol: v1Protocol,
      request: {
        type: "play.chain.start",
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-one",
        playerText: "I wait for Alex to answer.",
      },
    },
  });
  await started;
  const cancellation = await server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: v1Protocol,
      request: {
        type: "play.chain.cancel",
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-one",
      },
    },
  });
  const response = await streamed;
  await server.close();

  expect(cancellation.statusCode).toBe(200);
  expect(cancellation.json()).toMatchObject({
    result: { outcome: "cancellation_requested" },
  });
  const finalFrame = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { frame: V1PlayCallChainStreamFrame })
    .at(-1)?.frame;
  expect(finalFrame).toMatchObject({
    kind: "snapshot",
    final: true,
    value: {
      status: "interrupted",
      events: [
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ kind: "cancellation" }),
      ],
    },
  });
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
  };

  const accepted = await server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers: { ...headers, origin: "http://127.0.0.1:4317" },
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "workspace.read" },
    },
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({
    protocol: "narraeon.runtime/v1",
    result: { storageNotices: [] },
  });

  const bareRequest = await server.inject({
    authority: "127.0.0.1:4317",
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
    authority: "127.0.0.1:4317",
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
    authority: "127.0.0.1:4317",
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

  // Durable conversation reads pass protocol validation and safely return
  // null when the package has no open setting-improvement session.
  const unknownProgress = await server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "setting-improvement.read",
        packageId: "package-missing",
      },
    },
  });
  expect(unknownProgress.statusCode).toBe(200);
  expect(unknownProgress.json()).toMatchObject({ result: null });

  const malformedProgress = await server.inject({
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "setting-improvement.read" },
    },
  });
  expect(malformedProgress.statusCode).toBe(400);
  expect(malformedProgress.json()).toMatchObject({
    error: { code: "invalid_request" },
  });

  const pathImport = await server.inject({
    authority: "127.0.0.1:4317",
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
    authority: "127.0.0.1:4317",
    method: "POST",
    url: "/api/runtime/v1",
    headers,
    payload: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "content.import",
        archiveBase64: archive.toString("base64"),
        title: "雾港来信",
      },
    },
  });
  expect(uploaded.statusCode).toBe(200);
  expect(uploaded.json()).toMatchObject({
    protocol: "narraeon.runtime/v1",
    result: { title: "雾港来信", status: "needs_repair" },
  });

  const invalidArchive = await server.inject({
    authority: "127.0.0.1:4317",
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
  expect(invalidArchive.body).toContain("ZIP");

  const unsupportedTree = await server.inject({
    authority: "127.0.0.1:4317",
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

test("Runtime 请求失败写入 runtime-errors 日志且浏览器拿到错误原文", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-v1-server-errors-"));
  roots.push(root);
  const staticRoot = join(root, "dist");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
  const logRoot = join(root, "logs");
  const runtime = await createRuntime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
    logRoot,
  });
  const server = await createServer({
    runtime,
    staticRoot,
    port: 4317,
    logger: false,
  });
  const send = (request: unknown) =>
    server.inject({
      authority: "127.0.0.1:4317",
      method: "POST",
      url: "/api/runtime/v1",
      headers: { "content-type": "application/json" },
      payload: { protocol: "narraeon.runtime/v1", request },
    });

  const rejected = await send({
    type: "play.chain.revise-player",
    operationId: "revise-missing",
    worldId: "world-missing",
    chainId: "chain-missing",
    eventId: 1,
    replacementExchangeId: "exchange-missing",
    replacementText: "Private player text.",
    continuation: "continue_context",
  });
  expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
  const body = rejected.json<{
    error?: { message?: string } | string;
    message?: string;
  }>();
  const message =
    typeof body.error === "object" ? body.error.message : body.message;
  expect(message).toEqual(expect.any(String));

  const [file, ...others] = await readdir(join(logRoot, "runtime-errors"));
  expect(others).toEqual([]);
  expect(file).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/u);
  expect(
    (await stat(join(logRoot, "runtime-errors", file!))).mode & 0o777,
  ).toBe(0o600);
  const contents = await readFile(
    join(logRoot, "runtime-errors", file!),
    "utf8",
  );
  expect(contents).not.toContain("Private player text.");
  const records = contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RuntimeErrorRecord);
  expect(records).toMatchObject([
    {
      format: "narraeon.runtime-error-log/v1",
      kind: "request_failed",
      requestType: "play.chain.revise-player",
      request: {
        operationId: "revise-missing",
        worldId: "world-missing",
        chainId: "chain-missing",
        eventId: 1,
        replacementExchangeId: "exchange-missing",
        continuation: "continue_context",
      },
      error: { message },
    },
  ]);
  expect(records[0]?.error.stack).toContain(message);
  await server.close();
});
