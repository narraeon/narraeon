import { registerConversationStream } from "./ConversationStream.ts";
import { checkMobileRuntimeAccess, checkWebAccess } from "./WebAccess.ts";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { PassThrough } from "node:stream";

import fastifyStatic from "@fastify/static";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";

import { maxPortableContentArchiveBase64Characters } from "../protocol/contentTree.ts";
import {
  parseV1Envelope,
  V1ProtocolError,
  v1Protocol,
  type V1PlayCallChainStreamFrame,
  type V1PlayCallChainView,
  type V1Request,
} from "../protocol/v1.ts";
import type { V1Runtime } from "../runtime/V1Runtime.ts";
import type { PlayCallChainObserver } from "../runtime/play/PlayCallChain.ts";
import { WorldArchiveError } from "../runtime/archive/WorldArchiveZip.ts";
import type { Readable } from "node:stream";

const runtimeRequestBodyLimit =
  maxPortableContentArchiveBase64Characters + 64 * 1024;
const playCallChainStreamContentType = "application/x-ndjson";

class RuntimeLogController extends LogController {
  override incomingRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    // The request body is not parsed yet. Runtime API requests are logged by
    // the route pre-handler once their request type is known.
    if (isRuntimeApiRequest(request)) return;
    super.incomingRequest(request, reply, metadata);
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    if (isPollingRequest(request) && error == null && reply.statusCode < 400)
      return;
    super.requestCompleted(error, request, reply, metadata);
  }
}

function isPollingRequest(request: FastifyRequest): boolean {
  const body = request.body;
  if (!isRuntimeApiRequest(request) || !isRecord(body)) return false;
  const runtimeRequest = body.request;
  return (
    isRecord(runtimeRequest) &&
    (runtimeRequest.type === "setting-improvement.read" ||
      runtimeRequest.type === "setting-improvement.status" ||
      runtimeRequest.type === "setting-improvement.overview" ||
      runtimeRequest.type === "play.chain.inspect")
  );
}

function isRuntimeApiRequest(request: FastifyRequest): boolean {
  return request.url === "/api/runtime/v1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createServer(input: {
  runtime: V1Runtime;
  staticRoot: string;
  port: number;
  trustedOrigins?: readonly string[];
  mobileStartupKey?: Buffer;
  logger?: boolean;
  logStream?: Writable;
}): Promise<FastifyInstance> {
  const minimumPort = input.mobileStartupKey === undefined ? 1 : 0;
  if (
    !Number.isInteger(input.port) ||
    input.port < minimumPort ||
    input.port > 65_535
  )
    throw new Error(`Invalid local web port: ${input.port}`);
  const server = Fastify({
    logController: new RuntimeLogController(),
    logger:
      input.logger === false
        ? false
        : {
            level: "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.headers.x-api-key",
                "req.body",
              ],
              censor: "[REDACTED]",
            },
            ...(input.logStream === undefined
              ? {}
              : { stream: input.logStream }),
          },
  });
  const trustedOrigins = input.trustedOrigins ?? [];
  if (input.port === 0) {
    // Port zero is resolved by the socket bind, after the request hooks are registered.
    let check: ReturnType<typeof checkWebAccess> | undefined;
    server.addHook("onRequest", async (request, reply) => {
      if (check === undefined) {
        const address = server.server.address();
        if (
          address === null ||
          typeof address === "string" ||
          address.port === 0
        )
          return reply.code(503).send({ error: "Runtime is not listening" });
        check = checkWebAccess(address.port, trustedOrigins);
      }
      return check.call(server, request, reply);
    });
  } else {
    server.addHook("onRequest", checkWebAccess(input.port, trustedOrigins));
  }
  const mobileStartupKey = input.mobileStartupKey;
  if (mobileStartupKey !== undefined)
    server.addHook("onRequest", checkMobileRuntimeAccess(mobileStartupKey));
  const html = await readFile(join(input.staticRoot, "index.html"), "utf8");
  const logRuntimeRequest: preHandlerHookHandler = (request, _reply, done) => {
    if (!isPollingRequest(request))
      request.log.info({ req: request }, "incoming request");
    done();
  };
  server.addHook("onSend", (request, reply, payload, done) => {
    void reply
      .header(
        "Cache-Control",
        request.url.startsWith("/api/") ? "no-store" : "no-cache",
      )
      .header(
        "Content-Security-Policy",
        // App renderer code is explicitly frozen local trusted code and runs
        // inside its own sandboxed iframe. The inline allowance is required
        // for srcDoc templates; the host still exposes no Runtime capability
        // to that code and the product does not treat it as a hostile sandbox.
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY");
    const challenge = request.headers["x-narraeon-startup-challenge"];
    const path = request.url.split("?", 1)[0];
    if (
      mobileStartupKey !== undefined &&
      request.method === "GET" &&
      reply.statusCode === 200 &&
      typeof challenge === "string" &&
      /^[a-f0-9]{64}$/.test(challenge) &&
      (path === "/" || path === "/index.html" || path?.startsWith("/assets/"))
    ) {
      const proof = createHmac("sha256", mobileStartupKey)
        .update(`${challenge}\n${request.url}`)
        .digest("hex");
      void reply
        .header("X-Narraeon-Startup-Proof", proof)
        .header("Cache-Control", "no-store");
    }
    done(null, payload);
  });
  registerConversationStream(server, input.runtime);
  // Keep uploads as a backpressured stream with their own archive-size limit.
  // Fastify's JSON parser and content-package body limit never buffer this route.
  await server.register((archives, _options, done) => {
    archives.addContentTypeParser(
      "application/zip",
      (_request, payload, done) => done(null, payload),
    );
    archives.post("/api/runtime/v1/world-archives", async (request, reply) => {
      const body = request.body as Readable;
      // A failed upload pipeline must leave the HTTP socket open for the error response.
      const transfer = new PassThrough();
      const forwardError = (error: Error) => transfer.destroy(error);
      // The incoming body can abort while Runtime is opening the destination.
      transfer.on("error", () => undefined);
      body.on("error", forwardError).pipe(transfer);
      try {
        return await input.runtime.worldArchives.upload(transfer);
      } catch (error) {
        await input.runtime.recordArchiveFailure(
          { type: "world.archive.upload" },
          error,
        );
        if (error instanceof WorldArchiveError) {
          if (!request.raw.complete) void reply.header("Connection", "close");
          return reply
            .status(error.code === "limit_exceeded" ? 413 : 400)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      } finally {
        body.unpipe(transfer).off("error", forwardError);
        transfer.destroy();
      }
    });
    // The browser checks this before it starts the one-time download, so a
    // missing or failing export is reported on the page instead of a blank file.
    archives.get<{ Params: { archiveId: string } }>(
      "/api/runtime/v1/world-archives/:archiveId/check",
      async (request, reply) => {
        try {
          await input.runtime.worldArchives.checkDownload(
            request.params.archiveId,
          );
          return reply.status(204).send();
        } catch (error) {
          await input.runtime.recordArchiveFailure(
            {
              type: "world.archive.download",
              archiveId: request.params.archiveId,
            },
            error,
          );
          return archiveDownloadFailure(reply, error);
        }
      },
    );
    archives.get<{ Params: { archiveId: string } }>(
      "/api/runtime/v1/world-archives/:archiveId",
      async (request, reply) => {
        try {
          const archive = await input.runtime.worldArchives.download(
            request.params.archiveId,
          );
          reply.raw.once("finish", () => {
            void archive.cleanup().catch(() => undefined);
          });
          return reply
            .type("application/zip")
            .header("Content-Length", archive.metadata.bytes)
            .header(
              "Content-Disposition",
              `attachment; filename="world.narraeon-world.zip"; filename*=UTF-8''${encodeURIComponent(archive.metadata.fileName)}`,
            )
            .send(archive.stream);
        } catch (error) {
          await input.runtime.recordArchiveFailure(
            {
              type: "world.archive.download",
              archiveId: request.params.archiveId,
            },
            error,
          );
          return archiveDownloadFailure(reply, error);
        }
      },
    );
    done();
  });
  server.get("/health", () => ({
    status: "ok",
    protocol: "narraeon.runtime/v1",
  }));
  server.post(
    "/api/runtime/v1",
    {
      bodyLimit: runtimeRequestBodyLimit,
      preHandler: [logRuntimeRequest],
    },
    async (request, reply) => {
      let runtimeRequestType: string | undefined;
      try {
        const envelope = parseV1Envelope(request.body);
        runtimeRequestType = envelope.request.type;
        if (
          acceptsPlayCallChainStream(request) &&
          (envelope.request.type === "play.chain.start" ||
            envelope.request.type === "play.chain.append")
        )
          return sendPlayCallChainStream(
            input.runtime,
            envelope.request,
            request,
            reply,
          );
        const response = await input.runtime.handle(envelope.request);
        const playCallFailure =
          runtimeRequestType === "play.chain.start" ||
          runtimeRequestType === "play.chain.append"
            ? playInterruptionFailure(response.result)
            : null;
        if (playCallFailure !== null)
          request.log.error(
            {
              runtimeRequestType,
              playCallFailure,
            },
            "play call interrupted",
          );
        return reply.send(response);
      } catch (error: unknown) {
        if (error instanceof V1ProtocolError) {
          // 读取期间端点或内容包发生变化时，客户端可以重试。
          const status =
            error.code === "endpoint_discarded" ||
            error.code === "endpoint_read_conflict" ||
            error.code === "content_conflict"
              ? 409
              : 400;
          return reply.status(status).send({
            protocol: "narraeon.runtime/v1",
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined
                ? {}
                : { details: error.details }),
            },
          });
        }
        throw error;
      }
    },
  );
  await server.register(fastifyStatic, {
    root: input.staticRoot,
    index: false,
  });
  const index = (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type("text/html; charset=utf-8").send(html);
  server.get("/", index);
  server.get("/index.html", index);
  return server;
}

function archiveDownloadFailure(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof WorldArchiveError)
    return reply
      .status(400)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return reply.status(404).send({
      error: {
        code: "invalid_archive",
        message: "The archive download is unavailable",
      },
    });
  throw error;
}

function acceptsPlayCallChainStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return (
    typeof accept === "string" &&
    accept
      .split(",")
      .some((value) => value.trim().startsWith(playCallChainStreamContentType))
  );
}

function sendPlayCallChainStream(
  runtime: V1Runtime,
  runtimeRequest: Extract<
    V1Request,
    { type: "play.chain.start" | "play.chain.append" }
  >,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const stream = new PassThrough();
  const send = (frame: V1PlayCallChainStreamFrame): void => {
    if (stream.destroyed || stream.writableEnded) return;
    stream.write(`${JSON.stringify({ protocol: v1Protocol, frame })}\n`);
  };
  const observer: PlayCallChainObserver = {
    onSnapshot(value) {
      send({ kind: "snapshot", value, final: false });
    },
    onAssistantDelta(delta) {
      send({
        kind: "assistant_delta",
        eventId: delta.eventId,
        deltaKind: delta.kind,
        text: delta.text,
        updatedAt: delta.updatedAt,
      });
    },
  };
  void runtime
    .handle(runtimeRequest, observer)
    .then((response) => {
      if (!isPlayCallChainView(response.result))
        throw new Error(
          "The Runtime stream did not return a call-chain snapshot",
        );
      send({ kind: "snapshot", value: response.result, final: true });
      const playCallFailure = playInterruptionFailure(response.result);
      if (playCallFailure !== null)
        request.log.error(
          {
            runtimeRequestType: runtimeRequest.type,
            playCallFailure,
          },
          "play call interrupted",
        );
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Runtime streaming failed";
      request.log.error(
        { err: error, runtimeRequestType: runtimeRequest.type },
        "play call stream failed",
      );
      send({ kind: "error", message });
    })
    .finally(() => {
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    });
  return reply.type(playCallChainStreamContentType).send(stream);
}

function isPlayCallChainView(value: unknown): value is V1PlayCallChainView {
  return (
    isRecord(value) &&
    typeof value.chainId === "string" &&
    typeof value.worldId === "string" &&
    Array.isArray(value.previousContexts) &&
    Array.isArray(value.events) &&
    (value.status === "ready" ||
      value.status === "running" ||
      value.status === "interrupted")
  );
}

function playInterruptionFailure(value: unknown): string | null {
  return isRecord(value) &&
    value.status === "interrupted" &&
    typeof value.lastFailure === "string" &&
    value.lastCancelled !== true &&
    value.lastFailureKind !== "dispatch_budget"
    ? value.lastFailure
    : null;
}
