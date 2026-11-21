import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runNarraeonCli } from "../../src/cli/NarraeonCli.ts";
import { availableRuntimePort } from "../support/runtimeServer.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startCli(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-web-access-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<main>Narraeon</main>");
  const port = await availableRuntimePort();
  const result = await runNarraeonCli({
    args: ["web", "--no-open"],
    environment: {
      NARRAEON_PORT: String(port),
      NARRAEON_DATA_ROOT: join(root, "data"),
      NARRAEON_CONFIG_ROOT: join(root, "config"),
      NARRAEON_LOG_ROOT: join(root, "log"),
      ...environment,
    },
    staticRoot: root,
    openUrl: () => Promise.resolve(),
    writeOutput: () => undefined,
  });
  if (result.kind !== "started") throw new Error("Expected a new local server");
  cleanup.push(() => result.server.close());
  return port;
}

async function startProxy(backendPort: number) {
  const proxyPort = await availableRuntimePort();
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: backendPort,
        path: incoming.url ?? "/",
        method: incoming.method ?? "GET",
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.once("error", () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject).listen(proxyPort, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        proxy.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  return proxyPort;
}

const rpc = "/api/runtime/v1";
const archives = `${rpc}/world-archives`;
const workspaceRead = JSON.stringify({
  protocol: "narraeon.runtime/v1",
  request: { type: "workspace.read" },
});

function status(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers,
      },
      (response) => {
        response.resume().once("end", () => resolve(response.statusCode));
      },
    );
    req.once("error", reject).end(body);
  });
}

test("Runtime 校验所有 HTTP 入口的 Host，并允许回环浏览器和原生客户端", async () => {
  const port = await startCli();
  const local = `127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  const unsupported = { host: "unconfigured.example" };

  expect(await status(port, "/", { host: local })).toBe(200);
  expect(await status(port, "/health", { host: `localhost:${port}` })).toBe(
    200,
  );
  expect(await status(port, rpc, { ...json, host: local }, workspaceRead)).toBe(
    200,
  );
  expect(
    await status(
      port,
      rpc,
      { ...json, host: local, origin: `http://${local}` },
      workspaceRead,
    ),
  ).toBe(200);

  for (const path of [
    "/",
    "/health",
    `${rpc}/events`,
    `${archives}/sample/check`,
    `${archives}/sample`,
  ]) {
    expect(await status(port, path, unsupported)).toBe(403);
  }
  expect(
    await status(port, rpc, { ...json, ...unsupported }, workspaceRead),
  ).toBe(403);
  for (const origin of [
    "https://unconfigured.example",
    "null",
    `http://localhost:${port}`,
  ]) {
    expect(
      await status(port, rpc, { ...json, host: local, origin }, workspaceRead),
    ).toBe(403);
  }
  expect(
    await status(
      port,
      rpc,
      { ...json, host: local, "sec-fetch-site": "cross-site" },
      workspaceRead,
    ),
  ).toBe(403);
  expect(
    await status(
      port,
      archives,
      {
        host: local,
        "content-type": "application/zip",
        origin: "https://unconfigured.example",
      },
      "zip",
    ),
  ).toBe(403);
});

test("容器监听保留回环访问，代理使用显式配置的外部地址", async () => {
  const port = await startCli({
    NARRAEON_HOST: "0.0.0.0",
    NARRAEON_TRUSTED_ORIGINS: "https://narraeon.example, http://127.0.0.1:8080",
  });
  const proxyPort = await startProxy(port);
  const json = { "content-type": "application/json" };
  expect(await status(port, "/health", { host: `127.0.0.1:${port}` })).toBe(
    200,
  );
  expect(await status(port, "/", { host: "127.0.0.1:8080" })).toBe(200);
  expect(
    await status(
      proxyPort,
      rpc,
      { ...json, host: "narraeon.example", origin: "https://narraeon.example" },
      workspaceRead,
    ),
  ).toBe(200);
  expect(
    await status(
      proxyPort,
      rpc,
      { ...json, host: "narraeon.example", origin: "http://narraeon.example" },
      workspaceRead,
    ),
  ).toBe(403);
  expect(
    await status(proxyPort, "/", {
      host: "unconfigured.example",
      "x-forwarded-host": "narraeon.example",
    }),
  ).toBe(403);
});
