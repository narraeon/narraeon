import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../../src/server/createServer.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { WorldArchiveError } from "../../src/runtime/archive/WorldArchiveZip.ts";
import type { RuntimeErrorRecord } from "../../src/runtime/RuntimeErrorLog.ts";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
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
  });
  await runtime.initialize();
  const server = await createServer({
    runtime,
    staticRoot,
    port: 3000,
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
      `/api/runtime/v1/world-archives/${archiveId}/check`,
    );
    expect(check.statusCode).toBe(204);
    expect(check.body).toBe("");

    const absent = await server.inject(
      "/api/runtime/v1/world-archives/absent/check",
    );
    expect(absent.statusCode).toBe(404);
    expect(absent.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_archive",
    );

    const download = await server.inject(
      `/api/runtime/v1/world-archives/${archiveId}`,
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
    await server.inject("/api/runtime/v1/world-archives/absent");
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
      `/api/runtime/v1/world-archives/${archiveId}`,
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
