import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { v1Protocol, type V1Request } from "../../src/protocol/v1.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import { createServer } from "../../src/server/createServer.ts";

test("旧修正命令在 HTTP 与 Runtime 客户端均返回可识别的拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-retired-correction-"));
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
    const changed = vi.fn();
    const unsubscribe = runtime.subscribeConversation(
      { kind: "play", id: "world-old" },
      changed,
    );
    const requests = [
      {
        type: "correction.begin",
        worldId: "world-old",
        operationId: "operation-old",
      },
      {
        type: "correction.read",
        candidateId: "candidate-old",
        document: "@current-situation",
      },
      {
        type: "correction.patch",
        candidateId: "candidate-old",
        expectedVersion: 1,
        target: "@current-situation",
        expectedHash: "hash",
        edits: [],
      },
      {
        type: "correction.replace",
        candidateId: "candidate-old",
        expectedVersion: 1,
        target: "@current-situation",
        expectedHash: "hash",
        contents: "fixture",
      },
      ...["preview", "apply", "cancel"].map((action) => ({
        type: `correction.${action}`,
        candidateId: "candidate-old",
        expectedVersion: 1,
      })),
    ];
    const send = (protocol: string, request: unknown) =>
      server.inject({
        authority: "127.0.0.1:4317",
        method: "POST",
        url: "/api/runtime/v1",
        payload: { protocol, request },
      });
    try {
      for (const request of requests) {
        const error = {
          code: "invalid_request",
          message: `V1 does not support command: ${request.type}`,
        };
        const response = await send(v1Protocol, request);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ protocol: v1Protocol, error });
        await expect(
          runtime.handle(request as unknown as V1Request),
        ).rejects.toMatchObject(error);
      }
      const incompatible = await send("narraeon.runtime/v0", requests[0]);
      expect(incompatible.statusCode).toBe(400);
      expect(incompatible.json()).toMatchObject({
        protocol: v1Protocol,
        error: { code: "incompatible_data" },
      });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
