import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../../src/server/createServer.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { WorldArchiveError } from "../../src/runtime/archive/WorldArchiveZip.ts";
import type { RuntimeErrorRecord } from "../../src/runtime/RuntimeErrorLog.ts";
import { availableRuntimePort } from "../support/runtimeServer.ts";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";

const archiveRead = vi.hoisted(() => ({
  pause: undefined as ((path: unknown) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (archiveRead.pause !== undefined) await archiveRead.pause(args[0]);
      return actual.stat(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup({
  port = 3000,
  archiveUploadPolicy,
}: {
  port?: number;
  archiveUploadPolicy?: {
    totalBytes: number;
    maxUploads: number;
    ttlMs: number;
  };
} = {}) {
  const fixture = await worldArchiveFixture();
  roots.push(fixture.root);
  const staticRoot = await mkdtemp(join(tmpdir(), "narraeon-archive-static-"));
  roots.push(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<main>Narraeon</main>");
  const logRoot = await mkdtemp(join(tmpdir(), "narraeon-archive-logs-"));
  roots.push(logRoot);
  const runtime = new V1Runtime({
    dataRoot: fixture.root,
    configRoot: join(fixture.root, "config"),
    logRoot,
    ...(archiveUploadPolicy === undefined ? {} : { archiveUploadPolicy }),
  });
  await runtime.initialize();
  const server = await createServer({
    runtime,
    staticRoot,
    port,
    logger: false,
  });
  return { fixture, runtime, server, logRoot };
}

async function exportArchiveId(
  server: Awaited<ReturnType<typeof setup>>["server"],
  worldId: string,
  operationId: string,
): Promise<string> {
  const exported = await server.inject({
    authority: "127.0.0.1:3000",
    method: "POST",
    url: "/api/runtime/v1",
    payload: {
      protocol: "narraeon.runtime/v1",
      request: { type: "world.archive.export", worldId, operationId },
    },
  });
  expect(exported.statusCode).toBe(200);
  return exported.json<{ result: { archiveId: string } }>().result.archiveId;
}

async function readErrorRecords(
  logRoot: string,
): Promise<RuntimeErrorRecord[]> {
  const directory = join(logRoot, "runtime-errors");
  const files = await readdir(directory).catch(() => []);
  const records: RuntimeErrorRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(directory, file), "utf8");
    for (const line of text.trim().split("\n"))
      records.push(JSON.parse(line) as RuntimeErrorRecord);
  }
  return records;
}

test("归档下载检查不消耗备份，备份不存在时返回错误码", async () => {
  const { fixture, server } = await setup();
  try {
    const archiveId = await exportArchiveId(
      server,
      fixture.worldId,
      "check-export",
    );

    const check = await server.inject(
      `http://127.0.0.1:3000/api/runtime/v1/world-archives/${archiveId}/check`,
    );
    expect(check.statusCode).toBe(204);
    expect(check.body).toBe("");

    const absent = await server.inject(
      "http://127.0.0.1:3000/api/runtime/v1/world-archives/absent/check",
    );
    expect(absent.statusCode).toBe(404);
    expect(absent.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_archive",
    );

    const download = await server.inject(
      `http://127.0.0.1:3000/api/runtime/v1/world-archives/${archiveId}`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
  } finally {
    await server.close();
  }
});

test("归档下载失败写入 runtime-errors 日志", async () => {
  const { fixture, server, logRoot } = await setup();
  try {
    await server.inject(
      "http://127.0.0.1:3000/api/runtime/v1/world-archives/absent",
    );
    const archiveId = await exportArchiveId(
      server,
      fixture.worldId,
      "corrupt-export",
    );
    await writeFile(
      join(fixture.root, "world-archives/exports", archiveId, "download.json"),
      "not json",
    );
    const broken = await server.inject(
      `http://127.0.0.1:3000/api/runtime/v1/world-archives/${archiveId}`,
    );
    expect(broken.statusCode).toBe(500);

    const records = await readErrorRecords(logRoot);
    expect(records).toMatchObject([
      {
        format: "narraeon.runtime-error-log/v1",
        kind: "request_failed",
        requestType: "world.archive.download",
        request: { archiveId: "absent" },
        error: { code: "ENOENT" },
      },
      {
        kind: "request_failed",
        requestType: "world.archive.download",
        request: { archiveId },
        error: { name: "SyntaxError" },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("归档上传失败写入 runtime-errors 日志", async () => {
  const { runtime, server, logRoot } = await setup();
  try {
    vi.spyOn(runtime.worldArchives, "upload").mockRejectedValueOnce(
      new WorldArchiveError("limit_exceeded", "The archive is too large"),
    );
    const rejected = await server.inject({
      authority: "127.0.0.1:3000",
      method: "POST",
      url: "/api/runtime/v1/world-archives",
      headers: { "content-type": "application/zip" },
      payload: Buffer.from("zip fixture"),
    });
    expect(rejected.statusCode).toBe(413);

    expect(await readErrorRecords(logRoot)).toMatchObject([
      {
        kind: "request_failed",
        requestType: "world.archive.upload",
        request: {},
        error: { code: "limit_exceeded" },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("归档上传共享字节预算，服务运行中清除过期上传后可再次上传", async () => {
  const port = await availableRuntimePort();
  const { fixture, runtime, server } = await setup({
    port,
    archiveUploadPolicy: { totalBytes: 14, maxUploads: 4, ttlMs: 60_000 },
  });
  const url = await server.listen({ host: "127.0.0.1", port });
  function upload(bytes: number) {
    return new Promise<{ status: number | undefined; body: unknown }>(
      (resolve, reject) => {
        const input = request(
          `${url}/api/runtime/v1/world-archives`,
          {
            method: "POST",
            agent: false,
            headers: { "content-type": "application/zip" },
          },
          (response) => {
            let body = "";
            response
              .setEncoding("utf8")
              .on("data", (chunk: string) => (body += chunk));
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(body) as unknown,
                });
              } catch (error) {
                reject(
                  new Error("Invalid archive HTTP response", { cause: error }),
                );
              }
            });
          },
        );
        input.once("error", reject).end(Buffer.alloc(bytes));
      },
    );
  }
  try {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const first = await upload(8);
    expect(first.status).toBe(200);
    const rejected = await upload(7);
    expect(rejected.status).toBe(413);
    expect(rejected.body).toMatchObject({
      error: { code: "limit_exceeded" },
    });
    const second = await upload(6);
    expect(second.status).toBe(200);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    const directory = join(fixture.root, "world-archives", "uploads");
    await expect.poll(() => readdir(directory)).toEqual([]);
    const next = await upload(14);
    expect(next.status).toBe(200);
    expect(next.body).toHaveProperty("uploadId");

    await runtime.initialize();
    expect((await upload(14)).status).toBe(200);
  } finally {
    vi.useRealTimers();
    await server.close();
  }
});

test("回收保留导入中的 ZIP，上传数量上限也在消费后释放", async () => {
  const { fixture, server } = await setup({
    archiveUploadPolicy: {
      totalBytes: 1024 ** 2,
      maxUploads: 2,
      ttlMs: 60_000,
    },
  });
  const base = "http://127.0.0.1:3000/api/runtime/v1";
  const upload = (payload: Buffer) =>
    server.inject({
      method: "POST",
      url: `${base}/world-archives`,
      headers: { "content-type": "application/zip" },
      payload,
    });
  const importZip = (uploadId: string, operationId: string) =>
    server.inject({
      method: "POST",
      url: base,
      payload: {
        protocol: "narraeon.runtime/v1",
        request: { type: "world.archive.import", operationId, uploadId },
      },
    });
  const release = Promise.withResolvers<void>();
  try {
    const id = await exportArchiveId(server, fixture.worldId, "active-export");
    const backup = await server.inject(`${base}/world-archives/${id}`);
    expect(backup.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const active = await upload(backup.rawPayload);
    const pending = await upload(Buffer.alloc(1));
    expect(active.statusCode).toBe(200);
    expect(pending.statusCode).toBe(200);
    expect((await upload(Buffer.alloc(1))).statusCode).toBe(413);

    const { uploadId } = active.json<{ uploadId: string }>();
    const activePath = join(
      fixture.root,
      "world-archives",
      "uploads",
      `${uploadId}.zip`,
    );
    const reading = Promise.withResolvers<void>();
    archiveRead.pause = async (path) => {
      // Pause at the filesystem boundary, before the import first opens the ZIP.
      if (path === activePath) {
        reading.resolve();
        await release.promise;
      }
    };
    const importing = importZip(uploadId, "active-import");
    await Promise.race([
      reading.promise,
      importing.then(() => {
        throw new Error("Import finished before opening the upload");
      }),
    ]);
    expect((await importZip(uploadId, "competing-import")).statusCode).toBe(
      400,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await expect
      .poll(() => readdir(join(fixture.root, "world-archives", "uploads")))
      .toEqual([`${uploadId}.zip`]);
    release.resolve();
    const result = await importing;
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ result: { outcome: "imported" } });
    expect((await importZip(uploadId, "active-import")).statusCode).toBe(200);
    expect((await upload(Buffer.alloc(1))).statusCode).toBe(200);
    expect((await upload(Buffer.alloc(1))).statusCode).toBe(200);
  } finally {
    release.resolve();
    archiveRead.pause = undefined;
    vi.useRealTimers();
    await server.close();
  }
});
