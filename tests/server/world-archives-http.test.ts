import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createServer } from "../../src/server/createServer.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";
import { parseV1Envelope } from "../../src/protocol/v1.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("HTTP 提供原生 ZIP 上传、自动下载文件名和完整导入，JSON 协议不携带归档", async () => {
  const fixture = await worldArchiveFixture();
  roots.push(fixture.root);
  const staticRoot = await mkdtemp(join(tmpdir(), "narraeon-archive-static-"));
  roots.push(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<main>Narraeon</main>");
  const runtime = new V1Runtime({
    dataRoot: fixture.root,
    configRoot: join(fixture.root, "config"),
  });
  await runtime.initialize();
  const server = await createServer({
    runtime,
    staticRoot,
    port: 3000,
    logger: false,
  });
  async function command(request: unknown) {
    return server.inject({
      method: "POST",
      url: "/api/runtime/v1",
      payload: { protocol: "narraeon.runtime/v1", request },
    });
  }
  try {
    const exported = await command({
      type: "world.archive.export",
      worldId: fixture.worldId,
      operationId: "http-export",
    });
    expect(exported.statusCode).toBe(200);
    const metadata = exported.json<{
      result: { archiveId: string; bytes: number };
    }>().result;
    const download = await server.inject(
      `/api/runtime/v1/world-archives/${metadata.archiveId}`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect(download.headers["content-disposition"]).toContain(
      ".narraeon-world.zip",
    );
    expect(download.rawPayload.length).toBe(metadata.bytes);
    await expect
      .poll(async () => readdir(join(fixture.root, "world-archives/exports")))
      .toEqual([]);
    const uploaded = await server.inject({
      method: "POST",
      url: "/api/runtime/v1/world-archives",
      headers: { "content-type": "application/zip" },
      payload: download.rawPayload,
    });
    expect(uploaded.statusCode).toBe(200);
    const imported = await command({
      type: "world.archive.import",
      operationId: "http-import",
      ...uploaded.json<{ uploadId: string }>(),
    });
    expect(imported.statusCode).toBe(200);
    const world = imported.json<{ result: { world: { worldId: string } } }>()
      .result.world;
    expect(world.worldId).not.toBe(fixture.worldId);
    const read = await command({ type: "world.read", worldId: world.worldId });
    expect(
      read.json<{ result: { archiveNeedsFreshContext: boolean } }>().result
        .archiveNeedsFreshContext,
    ).toBe(true);
    const brokenUpload = await server.inject({
      method: "POST",
      url: "/api/runtime/v1/world-archives",
      headers: { "content-type": "application/zip" },
      payload: Buffer.alloc(2 * 1024 ** 2),
    });
    // The default Fastify parser limit is 1 MiB; this route passes a stream to its own counter.
    expect(brokenUpload.statusCode).toBe(200);
    const rejected = await command({
      type: "world.archive.import",
      operationId: "http-broken",
      ...brokenUpload.json<{ uploadId: string }>(),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_archive",
    );
    const missingDownload = await server.inject(
      "/api/runtime/v1/world-archives/absent",
    );
    expect(missingDownload.statusCode).toBe(404);
    const traversal = await server.inject(
      "/api/runtime/v1/world-archives/a%5Cb",
    );
    expect(traversal.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});

test("归档 JSON 协议校验 operation 与身份字段", () => {
  expect(() =>
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: { type: "world.archive.import", uploadId: "upload" },
    }),
  ).toThrow("operationId");
  expect(
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: {
        type: "world.archive.export",
        operationId: "export",
        worldId: "world",
      },
    }).request.type,
  ).toBe("world.archive.export");
});
