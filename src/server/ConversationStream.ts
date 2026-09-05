import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  conversationUpdate,
  type ConversationState,
  type ConversationTarget,
} from "../protocol/conversationObservation.ts";
import { v1Protocol } from "../protocol/v1.ts";
import type { V1Runtime } from "../runtime/V1Runtime.ts";

/** A connection observes an independently owned Runtime task. No connection
 * teardown path has access to the model's cancellation signal. */
export function registerConversationStream(
  server: FastifyInstance,
  runtime: Pick<V1Runtime, "readConversation" | "subscribeConversation">,
): void {
  const connections = new Set<PassThrough>();
  server.addHook("preClose", () => {
    for (const stream of connections) stream.destroy();
    return Promise.resolve();
  });
  server.get<{
    Querystring: { kind?: string; id?: string; sessionId?: string };
  }>("/api/runtime/v1/events", (request, reply) => {
    const { kind, id, sessionId } = request.query;
    if (
      (kind !== "play" && kind !== "setting" && kind !== "revision") ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
      (sessionId !== undefined &&
        (kind === "play" ||
          typeof sessionId !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)))
    ) {
      return reply.code(400).send({ error: "Invalid conversation target" });
    }
    const target: ConversationTarget =
      kind === "play"
        ? { kind, id }
        : { kind, id, ...(sessionId === undefined ? {} : { sessionId }) };
    const stream = new PassThrough();
    connections.add(stream);
    const epoch = randomUUID();
    let sequence = 0;
    let changes = 0;
    let durableChanged = true;
    let reading = false;
    let previous: ConversationState | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = (text: string): void => {
      if (stream.destroyed) return;
      // A slow renderer may reconnect from a snapshot; it cannot backpressure
      // Provider execution or accumulate unbounded queued token events.
      if (stream.readableLength + stream.writableLength > 1024 * 1024) {
        stream.destroy();
        return;
      }
      stream.write(text);
    };
    const read = async (): Promise<void> => {
      if (reading || stream.destroyed) return;
      reading = true;
      const revision = changes;
      const reload = durableChanged;
      durableChanged = false;
      try {
        const next = await runtime.readConversation(
          target,
          reload ? undefined : (previous ?? undefined),
        );
        if (stream.destroyed) return;
        // Subscribe-before-read plus a revision check closes the initialization
        // and asynchronous snapshot race without replaying transient deltas.
        if (revision !== changes) schedule();
        if (
          previous === null ||
          JSON.stringify(previous) !== JSON.stringify(next)
        ) {
          const update = conversationUpdate(previous, next);
          write(
            `id: ${epoch}:${++sequence}\nevent: observation\ndata: ${JSON.stringify({ protocol: v1Protocol, update })}\n\n`,
          );
          previous = next;
        }
      } catch (error: unknown) {
        write(
          `event: failure\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "Conversation observation failed" })}\n\n`,
        );
        stream.end();
        cleanup();
      } finally {
        reading = false;
      }
    };
    const schedule = (): void => {
      if (timer !== undefined || stream.destroyed) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, 25);
    };
    const unsubscribe = runtime.subscribeConversation(target, (durable) => {
      changes += 1;
      durableChanged ||= durable;
      schedule();
    });
    const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
    const cleanup = (): void => {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(timer);
      connections.delete(stream);
    };
    stream.on("close", cleanup);
    reply.raw.on("close", () => stream.destroy());
    write(": connected\nretry: 1000\n\n");
    void read();
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Accel-Buffering", "no")
      .type("text/event-stream; charset=utf-8")
      .send(stream);
  });
}
