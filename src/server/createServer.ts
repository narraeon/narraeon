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
  logger?: boolean;
  logStream?: Writable;
}): Promise<FastifyInstance> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
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
    done(null, payload);
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
        if (
          (runtimeRequestType === "play.chain.start" ||
            runtimeRequestType === "play.chain.append") &&
          isRecord(response.result) &&
          response.result.status === "interrupted" &&
          typeof response.result.lastFailure === "string" &&
          !hasPlayCancellation(response.result)
        )
          request.log.error(
            {
              runtimeRequestType,
              playCallFailure: response.result.lastFailure,
            },
            "play call interrupted",
          );
        return reply.send(response);
      } catch (error: unknown) {
        if (error instanceof V1ProtocolError) {
          return reply.status(400).send({
            protocol: "narraeon.runtime/v1",
            error: {
              code: error.code,
              message: error.message,
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
      if (
        response.result.status === "interrupted" &&
        response.result.lastFailure !== null &&
        !hasPlayCancellation(response.result)
      )
        request.log.error(
          {
            runtimeRequestType: runtimeRequest.type,
            playCallFailure: response.result.lastFailure,
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

function hasPlayCancellation(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.events)) return false;
  const last: unknown = value.events.at(-1);
  return isRecord(last) && last.kind === "cancellation";
}
