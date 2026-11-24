import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, get } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";

import { expect, test, vi } from "vitest";

import { createRuntime } from "../../src/server/createRuntime.ts";
import { createServer } from "../../src/server/createServer.ts";
import { availableRuntimePort } from "../support/runtimeServer.ts";

async function setup(root: string) {
  await writeFile(join(root, "index.html"), "<!doctype html>");
  const runtime = await createRuntime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
    logRoot: join(root, "logs"),
  });
  const port = await availableRuntimePort();
  const app = await createServer({
    runtime,
    staticRoot: root,
    port,
    logger: false,
  });
  return { app, port };
}

test("优雅退出关闭刚变为空闲的连接，并继续等待其他响应", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-shutdown-test-"));
  const agent = new Agent({ keepAlive: true });
  const hold = (name: string) => ({
    name,
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  });
  const firstGate = hold("first");
  const secondGate = hold("second");
  const gates = [firstGate, secondGate];
  const responses: Promise<string>[] = [];
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const { app, port } = await setup(root);
    server = app;
    for (const gate of gates) {
      app.get(`/${gate.name}`, async () => {
        gate.started.resolve();
        await gate.release.promise;
        return gate.name;
      });
    }
    const url = await app.listen({ host: "127.0.0.1", port });
    const start = (name: string) => {
      const connection = { closed: false };
      const complete = new Promise<string>((resolve, reject) => {
        get(`${url}/${name}`, { agent }, (response) => {
          void text(response).then(resolve, reject);
        })
          .once("error", reject)
          .once("socket", (socket) => {
            socket.once("close", () => (connection.closed = true));
          });
      });
      responses.push(complete);
      return { connection, complete };
    };
    const first = start(firstGate.name);
    const second = start(secondGate.name);
    await Promise.all(gates.map(({ started }) => started.promise));

    closing = app.close();
    await vi.waitFor(() => expect(app.server.listening).toBe(false));
    firstGate.release.resolve();
    expect(await first.complete).toBe("first");
    await vi.waitFor(() => expect(first.connection.closed).toBe(true));
    expect(second.connection.closed).toBe(false);

    secondGate.release.resolve();
    expect(await second.complete).toBe("second");
    await vi.waitFor(() => expect(second.connection.closed).toBe(true));
    await closing;
  } finally {
    for (const gate of gates) gate.release.resolve();
    agent.destroy();
    await Promise.allSettled(responses);
    await (closing ?? server?.close());
    await rm(root, { recursive: true, force: true });
  }
});

test("优雅退出等待同一连接上的流水线响应全部写完", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-shutdown-test-"));
  const socket = new Socket();
  const release = Promise.withResolvers<void>();
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const { app, port } = await setup(root);
    server = app;
    const firstSent = Promise.withResolvers<void>();
    const secondQueued = Promise.withResolvers<void>();
    // This reply cannot fit in the TCP buffers while the client is paused.
    const payload = Buffer.alloc(8 * 1024 * 1024, "x");
    app.get("/first", async (_request, reply) => {
      reply.raw.once("finish", firstSent.resolve);
      await release.promise;
      return "first";
    });
    app.get("/second", (_request, reply) => {
      void reply.send(payload);
      secondQueued.resolve();
    });
    await app.listen({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.pause();
    socket.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `GET /first HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n` +
        `GET /second HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    await secondQueued.promise;
    closing = app.close();
    await vi.waitFor(() => expect(app.server.listening).toBe(false));

    release.resolve();
    await firstSent.promise;
    await setImmediate();
    socket.resume();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    const received = Buffer.concat(chunks);
    expect(received.includes("\r\n\r\nfirstHTTP/1.1 200 OK\r\n")).toBe(true);
    expect(received.subarray(-payload.length).equals(payload)).toBe(true);
    await closing;
  } finally {
    release.resolve();
    socket.destroy();
    await (closing ?? server?.close());
    await rm(root, { recursive: true, force: true });
  }
});
