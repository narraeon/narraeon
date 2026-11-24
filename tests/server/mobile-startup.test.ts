import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, expect, test } from "vitest";

import { availableRuntimePort } from "../support/runtimeServer.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startMobile(staticFiles = true, port?: number | string) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-mobile-startup-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  if (staticFiles) {
    await writeFile(join(root, "index.html"), "<main>Narraeon</main>");
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "assets", "entry.js"),
      "export const ready = true;",
    );
  }
  port ??= await availableRuntimePort();
  const key = randomBytes(32).toString("hex");
  const cache = join(root, "cache");
  await mkdir(cache);
  const probe = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    import { isMainThread } from "node:worker_threads";
    if (!isMainThread) writeFileSync(join(tmpdir(), "tmpdir-probe"), process.env.HOME);
  `;
  const child = spawn(
    process.execPath,
    [
      `--import=data:text/javascript,${encodeURIComponent(probe)}`,
      "src/server/mobile-bootstrap.ts",
      "3",
      "4",
    ],
    {
      env: {
        ...process.env,
        NARRAEON_STATIC_ROOT: join(root, "unused-host-static-root"),
        NARRAEON_MOBILE_STARTUP_KEY: "unused-host-startup-key",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const configuration = child.stdio[3];
  if (!(configuration instanceof Writable))
    throw new Error("Could not open the startup configuration pipe");
  configuration.end(
    JSON.stringify({
      NARRAEON_PORT: String(port),
      NARRAEON_DATA_ROOT: join(root, "data"),
      NARRAEON_CONFIG_ROOT: join(root, "config"),
      NARRAEON_LOG_ROOT: join(root, "log"),
      NARRAEON_STATIC_ROOT: root,
      NARRAEON_MOBILE_STARTUP_KEY: key,
      HOME: root,
      TMPDIR: cache,
    }),
  );
  child.stderr?.resume();
  child.stdout?.resume();
  return { child, closed, key, port, root, cache };
}

async function readReadyPort(child: ChildProcess): Promise<number | null> {
  const pipe = child.stdio[4];
  if (pipe === undefined || pipe === null || !(Symbol.asyncIterator in pipe))
    throw new Error("Could not open the readiness pipe");
  let handoff = Buffer.alloc(0);
  for await (const chunk of pipe as AsyncIterable<Buffer>) {
    handoff = Buffer.concat([handoff, chunk]);
    if (handoff.length >= 2) break;
  }
  return handoff.length === 2 ? handoff.readUInt16BE() : null;
}

test("Android hands off its actual port while another loopback server is listening", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const blockerAddress = blocker.address();
  if (blockerAddress === null || typeof blockerAddress === "string")
    throw new Error("Could not reserve a loopback port");
  const { child, key } = await startMobile(true, 0);
  const port = await readReadyPort(child);
  expect(port).toBeGreaterThan(0);
  expect(port).not.toBe(blockerAddress.port);
  const address = `http://127.0.0.1:${port}`;
  expect((await fetch(address)).status).toBe(200);
  const api = `${address}/api/runtime/v1`;
  const read = (headers: Record<string, string>) =>
    fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        protocol: "narraeon.runtime/v1",
        request: { type: "workspace.read" },
      }),
    });
  const cookie = cookieFor(key);
  expect((await read({ origin: address, cookie })).status).toBe(200);
  expect((await read({ origin: address })).status).toBe(403);
  expect(
    (await read({ origin: `http://127.0.0.1:${blockerAddress.port}`, cookie }))
      .status,
  ).toBe(403);
});

function cookieFor(key: string): string {
  return `narraeon_mobile_runtime=${createHmac(
    "sha256",
    Buffer.from(key, "hex"),
  )
    .update("narraeon-mobile-runtime/v1")
    .digest("hex")}`;
}

test("Android Node 入口用本次启动密钥应答就绪挑战", async () => {
  const { child, key, port, root, cache } = await startMobile();
  expect(await readReadyPort(child)).toBe(port);
  expect(await readFile(join(cache, "tmpdir-probe"), "utf8")).toBe(root);
  const base = `http://127.0.0.1:${port}`;
  const challenge = "5b".repeat(32);
  const headers = { "x-narraeon-startup-challenge": challenge };
  for (const [path, body] of [
    ["/", "<main>Narraeon</main>"],
    ["/assets/entry.js", "export const ready = true;"],
  ]) {
    const response = await fetch(`${base}${path}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    const proof = response.headers.get("x-narraeon-startup-proof");
    const message = `${challenge}\n${path}`;
    expect(proof).toBe(
      createHmac("sha256", Buffer.from(key, "hex"))
        .update(message)
        .digest("hex"),
    );
    expect(proof).not.toBe(
      createHmac("sha256", Buffer.alloc(32)).update(message).digest("hex"),
    );
    expect(await response.text()).toBe(body);
  }
  const home = await fetch(`${base}/`);
  expect(home.headers.has("x-narraeon-startup-proof")).toBe(false);
  expect(home.headers.has("set-cookie")).toBe(false);
  expect(await home.text()).toBe("<main>Narraeon</main>");
});

test("Android Node 入口重新启动后只接受本次启动的调用方凭据", async () => {
  const first = await startMobile();
  expect(await readReadyPort(first.child)).toBe(first.port);
  const api = `http://127.0.0.1:${first.port}/api/runtime/v1`;
  const read = (cookie: string) =>
    fetch(api, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "narraeon.runtime/v1",
        request: { type: "workspace.read" },
      }),
    });
  const oldCookie = cookieFor(first.key);
  expect((await read(oldCookie)).status).toBe(200);
  first.child.kill();
  await first.closed;

  const second = await startMobile(true, first.port);
  expect(await readReadyPort(second.child)).toBe(second.port);
  expect((await read(oldCookie)).status).toBe(403);
  const cookie = cookieFor(second.key);
  expect((await read(cookie)).status).toBe(200);

  const abort = new AbortController();
  try {
    const response = await fetch(`${api}/events?kind=play&id=fixture`, {
      headers: { cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const chunk: unknown = (await response.body!.getReader().read()).value;
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected SSE bytes");
    expect(new TextDecoder().decode(chunk)).toContain(": connected");
  } finally {
    abort.abort();
  }
});

test("Android Node 入口启动失败时以错误状态结束并写入诊断", async () => {
  const { child, closed, root } = await startMobile(false);
  expect(await readReadyPort(child)).toBeNull();
  expect(await closed).toBe(1);
  expect(
    await readFile(join(root, "log", "crash", "node-errors.log"), "utf8"),
  ).toContain("[startup]");
});

test.each(["", "-1", "65536", "12.5", "invalid"])(
  "Android reports an invalid NARRAEON_PORT value %j without handing off a port",
  async (port) => {
    const { child, closed, root } = await startMobile(true, port);
    expect(await readReadyPort(child)).toBeNull();
    expect(await closed).toBe(1);
    expect(
      await readFile(join(root, "log", "crash", "node-errors.log"), "utf8"),
    ).toContain(`NARRAEON_PORT is not a valid port: ${port}`);
  },
);
