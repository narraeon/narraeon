import {
  createServer as nodeServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { V1OrchestrationView } from "../../src/protocol/orchestrationSession.ts";
import { v1Protocol, type V1Request } from "../../src/protocol/v1.ts";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import { createServer } from "../../src/server/createServer.ts";

test("v1 accepts a consultation in a worldless workspace and emits the actual frozen provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-editor-http-"));
  const requests: {
    url: string | undefined;
    body: {
      messages: { role: string; content?: string; name?: string }[];
      tools: { function: { name: string } }[];
    };
  }[] = [];
  const respond = async (req: IncomingMessage, res: ServerResponse) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push({
      url: req.url,
      body: JSON.parse(
        Buffer.concat(body).toString("utf8"),
      ) as (typeof requests)[number]["body"],
    });
    const round = requests.length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = {
      index: 0,
      id: "list-playing",
      type: "function",
      function: {
        name: "orchestration_list",
        arguments: JSON.stringify({ surface: "playPrompts" }),
      },
    };
    for (const choice of [
      round === 1
        ? {
            delta: { role: "assistant", tool_calls: [tool] },
            finish_reason: null,
          }
        : {
            delta: {
              role: "assistant",
              content: "Only an orchestration catalog was used.",
            },
            finish_reason: null,
          },
      { delta: {}, finish_reason: round === 1 ? "tool_calls" : "stop" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  };
  const provider = nodeServer((req, res) => {
    void respond(req, res).catch((error: unknown) => {
      res.destroy(
        error instanceof Error ? error : new Error("Fixture request failed"),
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const configRoot = join(root, "config");
    const staticRoot = join(root, "static");
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<!doctype html>");
    const runtime = await createRuntime({
      configRoot,
      dataRoot: join(root, "data"),
      logRoot: join(root, "logs"),
    });
    const app = await createServer({
      runtime,
      staticRoot,
      logger: false,
      port: 4317,
    });
    try {
      const send = (request: V1Request) =>
        app.inject({
          method: "POST",
          url: "/api/runtime/v1",
          authority: "127.0.0.1:4317",
          payload: { protocol: v1Protocol, request },
        });
      const { result: library } = (await send({ type: "play.read" })).json<{
        result: FileNativePlayPresetLibrary;
      }>();
      const preset = library.presets[0]!;
      const request = {
        type: "orchestration.message",
        presetId: preset.id,
        expectedRevision: preset.revision,
        requestId: "worldless-consultation",
        message:
          "I have no world yet. Where should a tabletop-only reminder go?",
        surface: "playPrompts",
        continuation: { kind: "fresh_context" },
      } as const;
      const offline = await send(request);
      expect(offline.statusCode).toBe(400);
      expect(offline.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(
        (
          await send({ type: "orchestration.overview", presetId: preset.id })
        ).json(),
      ).toMatchObject({ result: { latest: null, history: [] } });
      const address = provider.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing provider fixture address");
      const model = await send({
        type: "model.save",
        connection: {
          presetId: "custom",
          name: "Fixture",
          provider: "chat_completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          authMode: "none",
          modelId: "fixture",
          modelPrompt: "Fixture connection guidance",
          contextWindowTokens: 32_768,
          maxOutputTokens: 4_096,
        },
      });
      expect(model.statusCode).toBe(200);
      const { result: models } = model.json<{
        result: ModelConnectionLibraryView;
      }>();
      expect(
        (
          await send({
            type: "model.select",
            connectionId: models.connections[0]!.id,
          })
        ).statusCode,
      ).toBe(200);
      const consulted = await send(request);
      expect(consulted.statusCode).toBe(200);
      const view = consulted.json<{ result: V1OrchestrationView }>().result;
      expect(view).toMatchObject({
        revision: preset.revision,
        runStatus: "ready",
        changes: [],
      });
      expect(view.messages.at(-1)?.text).toContain(
        "Only an orchestration catalog",
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url).toBe("/v1/chat/completions");
      expect(
        requests[0]!.body.messages
          .filter(({ role }) => role === "system")
          .map(({ content }) => content)
          .join(" "),
      ).toContain("Fixture connection guidance");
      expect(requests[0]!.body.messages.map(({ role }) => role)).toEqual([
        "system",
        "system",
        "system",
        "user",
        "user",
      ]);
      expect(
        requests[0]!.body.tools.map(({ function: tool }) => tool.name),
      ).toEqual([
        "orchestration_list",
        "orchestration_read",
        "orchestration_preview",
        "orchestration_reference_read",
        "orchestration_edit",
      ]);
      expect(
        requests[1]!.body.messages.find(({ role }) => role === "tool")?.content,
      ).toContain(preset.revision);
      expect(
        (await send(request)).json<{ result: V1OrchestrationView }>().result
          .sessionId,
      ).toBe(view.sessionId);
      expect(requests).toHaveLength(2);

      const conflicting = await send({
        type: "play.save",
        presetId: preset.id,
        name: preset.name,
        files: preset.files,
        expectedRevision: "stale",
      });
      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json()).toMatchObject({
        error: {
          code: "orchestration_conflict",
          details: { revision: preset.revision },
        },
      });
      expect(
        (
          await send({
            type: "orchestration.session.delete",
            presetId: preset.id,
            sessionId: view.sessionId,
          })
        ).json(),
      ).toMatchObject({ result: { latest: null, history: [] } });
    } finally {
      await app.close();
    }
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
