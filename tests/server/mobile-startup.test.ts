import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, test } from "vitest";

import { availableRuntimePort } from "../support/runtimeServer.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startMobile(staticFiles = true) {
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
  const port = await availableRuntimePort();
  const key = "2a".repeat(32);
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
    ],
    {
      env: {
        ...process.env,
        NARRAEON_STATIC_ROOT: join(root, "unused-host-static-root"),
        NARRAEON_MOBILE_STARTUP_KEY: "unused-host-startup-key",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
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
  return { child, closed, key, port, root, cache };
}

async function ready(child: ChildProcess, port: number): Promise<void> {
  let output = "";
  child.stdout?.on(
    "data",
    (chunk: Buffer) => (output += chunk.toString("utf8")),
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (output.includes(`NARRAEON_READY ${port}`)) return;
    if (child.exitCode !== null) break;
    await delay(25);
  }
  throw new Error("The mobile backend did not start");
}

test("Android Node 入口用本次启动密钥应答就绪挑战", async () => {
  const { child, key, port, root, cache } = await startMobile();
  await ready(child, port);
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
  expect(
    (await fetch(`${base}/`)).headers.has("x-narraeon-startup-proof"),
  ).toBe(false);
});

test("Android Node 入口启动失败时以错误状态结束并写入诊断", async () => {
  const { child, closed, root } = await startMobile(false);
  child.stdout?.resume();
  expect(await closed).toBe(1);
  expect(
    await readFile(join(root, "log", "crash", "node-errors.log"), "utf8"),
  ).toContain("[startup]");
});
