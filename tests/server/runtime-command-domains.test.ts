import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  v1Protocol,
  type ContentTreeFile,
  type V1Request,
} from "../../src/protocol/v1.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import { createServer } from "../../src/server/createServer.ts";

test("各领域命令经 HTTP 返回原回执，并保持通知与修订锁边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-runtime-domains-"));
  try {
    await writeFile(join(root, "index.html"), "<!doctype html>");
    const runtime = await createRuntime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
      logRoot: join(root, "logs"),
    });
    const server = await createServer({
      runtime,
      staticRoot: root,
      port: 4317,
      logger: false,
    });
    const send = (request: V1Request) =>
      server.inject({
        authority: "127.0.0.1:4317",
        method: "POST",
        url: "/api/runtime/v1",
        payload: { protocol: v1Protocol, request },
      });
    const ok = async <Result>(request: V1Request): Promise<Result> => {
      const response = await send(request);
      expect(response.statusCode, request.type).toBe(200);
      const body = response.json<{ protocol: string; result: Result }>();
      expect(body.protocol).toBe(v1Protocol);
      return body.result;
    };
    const reject = async (
      request: V1Request,
      status: number,
      code: string,
      message?: string,
    ) => {
      const response = await send(request);
      expect(response.statusCode, request.type).toBe(status);
      const body = response.json<{
        protocol: string;
        error: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      }>();
      expect(body).toMatchObject({ protocol: v1Protocol, error: { code } });
      expect(typeof body.error.message).toBe("string");
      if (message !== undefined) expect(body.error.message).toBe(message);
      return body.error;
    };

    try {
      const model = {
        provider: "chat_completions" as const,
        modelId: "fixture",
        contextWindowTokens: 4096,
        maxOutputTokens: 512,
      };
      const connection = {
        ...model,
        name: "Fixture",
        presetId: "custom" as const,
        baseUrl: "https://example.test",
      };
      await reject(
        { type: "model.save", connection },
        400,
        "invalid_request",
        "A new model configuration requires an API key",
      );
      await ok({
        type: "model.save",
        connection: { ...connection, apiKey: "fixture" },
      });
      expect(await ok({ type: "model.read" })).toMatchObject({
        configured: true,
      });

      const { localId: packageId } = await ok<{ localId: string }>({
        type: "content.create-sample",
        locale: "en",
      });
      interface Package {
        title: string;
        files: ContentTreeFile[];
      }
      const content = await ok<Package>({ type: "content.read", packageId });
      const notifications: string[] = [];
      const stopSetting = runtime.subscribeConversation(
        { kind: "setting", id: packageId },
        (durable) => notifications.push(`setting:${durable}`),
      );
      try {
        const conflict = await reject(
          {
            type: "content.replace",
            packageId,
            files: content.files,
            baseTreeRevision: "stale",
          },
          409,
          "content_conflict",
        );
        expect(conflict.details?.current).toMatchObject({
          localId: packageId,
          files: content.files,
        });
        expect(notifications.splice(0)).toEqual(["setting:true"]);
        await ok({ type: "setting-improvement.overview", packageId });
        expect(notifications).toEqual([]);
      } finally {
        stopSetting();
      }

      await reject(
        { type: "play.select", presetId: "missing" },
        400,
        "invalid_request",
        "Requested orchestration was not found",
      );
      const {
        world: { worldId },
      } = await ok<{ world: { worldId: string } }>({
        type: "world.create",
        operationId: "domains-world",
        packageId,
        model,
      });
      expect(await ok({ type: "world.read", worldId })).toMatchObject({
        head: "genesis",
      });
      expect(
        await ok({ type: "play.timeline.page", worldId, limit: 1 }),
      ).toMatchObject({
        activeChainId: null,
      });
      const stopPlay = runtime.subscribeConversation(
        { kind: "play", id: worldId },
        (durable) => notifications.push(`play:${durable}`),
      );
      const stopRevision = runtime.subscribeConversation(
        { kind: "revision", id: worldId },
        (durable) => notifications.push(`revision:${durable}`),
      );
      try {
        const { epoch: revision } = await ok<{
          epoch: { epochId: string; revision: string };
        }>({
          type: "world.revision.open",
          worldId,
        });
        expect(notifications.splice(0)).toEqual(["play:true", "revision:true"]);
        await reject(
          {
            type: "world.revision.discard",
            worldId,
            epochId: revision.epochId,
            expectedRevision: "stale",
          },
          400,
          "invalid_request",
        );
        expect(notifications.splice(0)).toEqual(["play:true", "revision:true"]);
        await reject(
          { type: "world.delete", worldId },
          400,
          "operation_conflict",
          "World play and other changes are locked while a world revision is open",
        );
        expect(notifications.splice(0)).toEqual(["play:true", "revision:true"]);
        await ok({
          type: "world.revision.discard",
          worldId,
          epochId: revision.epochId,
          expectedRevision: revision.revision,
        });
        expect(notifications.splice(0)).toEqual(["play:true", "revision:true"]);
        expect(await ok({ type: "world.delete", worldId })).toEqual({
          deleted: true,
        });
        expect(notifications).toEqual(["play:true", "revision:true"]);
      } finally {
        stopPlay();
        stopRevision();
      }
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
