import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { expect, test, vi } from "vitest";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { createServer } from "../../src/server/createServer.ts";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";

const api = "http://127.0.0.1:4317/api/runtime/v1";
const archives = `${api}/world-archives`;

test("Android Runtime rejects commands without a caller credential before dispatch", async () => {
  const staticRoot = await mkdtemp(join(tmpdir(), "narraeon-mobile-access-"));
  try {
    await writeFile(join(staticRoot, "index.html"), "<main>Narraeon</main>");
    const runtime = new V1Runtime({
      dataRoot: join(staticRoot, "data"),
      configRoot: join(staticRoot, "config"),
    });
    const handle = vi.spyOn(runtime, "handle");
    const server = await createServer({
      runtime,
      staticRoot,
      port: 4317,
      mobileStartupKey: Buffer.alloc(32, 1),
      logger: false,
    });
    try {
      const response = await server.inject({
        method: "POST",
        url: api,
        payload: {
          protocol: "narraeon.runtime/v1",
          request: { type: "workspace.read" },
        },
      });
      expect(response.statusCode).toBe(403);
      expect(handle).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  } finally {
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test("Android authenticates every Runtime route before touching state or archives", async () => {
  const fixture = await worldArchiveFixture();
  const staticRoot = await mkdtemp(join(tmpdir(), "narraeon-mobile-access-"));
  try {
    await writeFile(join(staticRoot, "index.html"), "<main>Narraeon</main>");
    const runtime = new V1Runtime({
      dataRoot: fixture.root,
      configRoot: join(fixture.root, "config"),
    });
    await runtime.initialize();
    const startupKey = Buffer.alloc(32, 1);
    const token = createHmac("sha256", startupKey)
      .update("narraeon-mobile-runtime/v1")
      .digest("hex");
    const cookie = `narraeon_mobile_runtime=${token}`;
    const logStream = new PassThrough();
    let log = "";
    logStream.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
    const server = await createServer({
      runtime,
      staticRoot,
      port: 4317,
      mobileStartupKey: startupKey,
      logStream,
    });
    try {
      const exported = await server.inject({
        method: "POST",
        url: api,
        headers: { cookie },
        payload: {
          protocol: "narraeon.runtime/v1",
          request: {
            type: "world.archive.export",
            worldId: fixture.worldId,
            operationId: "authenticated-export",
          },
        },
      });
      expect(exported.statusCode).toBe(200);
      const { archiveId } = exported.json<{ result: { archiveId: string } }>()
        .result;
      const download = `${archives}/${archiveId}`;
      const check = `${download}/check`;
      const handle = vi.spyOn(runtime, "handle");
      const subscribe = vi.spyOn(runtime, "subscribeConversation");
      const uploadArchive = vi.spyOn(runtime.worldArchives, "upload");
      const checkDownload = vi.spyOn(runtime.worldArchives, "checkDownload");
      const openDownload = vi.spyOn(runtime.worldArchives, "download");

      for (const invalidCookie of [
        undefined,
        `narraeon_mobile_runtime=${"0".repeat(64)}`,
        `${cookie}; ${cookie}`,
      ]) {
        const headers =
          invalidCookie === undefined ? {} : { cookie: invalidCookie };
        const denied = await Promise.all([
          server.inject({
            method: "POST",
            url: `${api}?test=denied`,
            headers,
            payload: {
              protocol: "narraeon.runtime/v1",
              request: {
                type: "play.chain.start",
                worldId: fixture.worldId,
                chainId: "blocked-chain",
                exchangeId: "blocked-exchange",
                playerText: "I open the door.",
              },
            },
          }),
          server.inject({
            url: `${api}/events?kind=play&id=${fixture.worldId}`,
            headers,
          }),
          server.inject({
            method: "POST",
            url: archives,
            headers: { ...headers, "content-type": "application/zip" },
            payload: Buffer.from("ZIP"),
          }),
          server.inject({ url: check, headers }),
          server.inject({ method: "HEAD", url: download, headers }),
          server.inject({ url: download, headers }),
        ]);
        expect(denied.map(({ statusCode }) => statusCode)).toEqual([
          403, 403, 403, 403, 403, 403,
        ]);
      }
      const crossOrigin = await server.inject({
        method: "POST",
        url: api,
        headers: { cookie, origin: "http://localhost:4317" },
        payload: {
          protocol: "narraeon.runtime/v1",
          request: { type: "workspace.read" },
        },
      });
      expect(crossOrigin.statusCode).toBe(403);
      for (const entry of [
        handle,
        subscribe,
        uploadArchive,
        checkDownload,
        openDownload,
      ]) {
        expect(entry).not.toHaveBeenCalled();
      }

      expect(
        (await server.inject({ url: check, headers: { cookie } })).statusCode,
      ).toBe(204);
      const backup = await server.inject({
        url: download,
        headers: { cookie },
      });
      expect(backup.statusCode).toBe(200);
      expect(backup.headers["content-type"]).toBe("application/zip");
      const upload = await server.inject({
        method: "POST",
        url: archives,
        headers: { cookie, "content-type": "application/zip" },
        payload: backup.rawPayload,
      });
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toHaveProperty("uploadId");
      expect(log).toContain("incoming request");
      expect(log.includes(token)).toBe(false);
    } finally {
      await server.close();
    }
  } finally {
    for (const root of [fixture.root, staticRoot])
      await rm(root, { recursive: true, force: true });
  }
});
