import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { v1Protocol } from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { createServer } from "../../src/server/createServer.ts";

export async function runtimeServer(root) {
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const logRoot = join(root, "log");
  const staticRoot = join(root, "static");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
  const runtime = new V1Runtime({ configRoot, dataRoot, logRoot });
  await runtime.initialize();

  // The desktop server requires its actual port at construction for Host checks.
  const socket = createSocketServer();
  await new Promise((resolve, reject) =>
    socket.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const { port } = socket.address();
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );

  const server = await createServer({
    runtime,
    staticRoot,
    port,
    logger: false,
  });
  const url = await server.listen({ host: "127.0.0.1", port });
  return { server, url, dataRoot, logRoot };
}

export function rpcBody(request) {
  return Buffer.from(JSON.stringify({ protocol: v1Protocol, request }));
}

export async function post(
  url,
  body,
  { stream = false, allowFailure = false } = {},
) {
  const started = performance.now();
  const response = await fetch(url + "/api/runtime/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(stream ? { accept: "application/x-ndjson" } : {}),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const elapsedMs = performance.now() - started;
  if (!allowFailure)
    assert.equal(response.status, 200, bytes.subarray(0, 1600).toString());
  return { bytes, elapsedMs, status: response.status };
}

export async function rpc(url, command, { stream = false } = {}) {
  const body = rpcBody(command);
  const { bytes } = await post(url, body, { stream });
  if (stream) {
    const { frame: final } = JSON.parse(
      bytes.toString().trimEnd().split("\n").at(-1),
    );
    assert.equal(final.kind, "snapshot", final.message);
    assert.equal(final.final, true);
    return final.value;
  }
  return JSON.parse(bytes).result;
}

export function modelBinding(modelId) {
  return {
    provider: "chat_completions",
    modelId,
    contextWindowTokens: 128_000,
    maxOutputTokens: 2_000,
  };
}

export async function loopbackProvider() {
  const pending = [];
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    let receivedBytes = 0;
    for await (const chunk of request) receivedBytes += chunk.byteLength;
    const delta = pending.shift();
    const status =
      delta === "unavailable" ? 503 : delta === undefined ? 500 : 200;
    requests.push({ status, receivedBytes });
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Synthetic provider unavailable." },
        }),
      );
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  return {
    pending,
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
