import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { registerConversationStream } from "../../src/server/ConversationStream.ts";
import { ConversationChanges } from "../../src/runtime/ConversationChanges.ts";
import type {
  ConversationState,
  ConversationTarget,
} from "../../src/protocol/conversationObservation.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

for (const kind of ["play", "setting", "revision"] as const) {
  test(`${kind}: real SSE socket survives task changes and reconnects from a snapshot`, async () => {
    const changes = new ConversationChanges();
    let revision = "initial";
    const readConversation = vi.fn(
      async (target: ConversationTarget): Promise<ConversationState> => {
        await Promise.resolve();
        return target.kind === "play"
          ? { kind: "play", value: null }
          : { kind: target.kind, value: { revision, selected: null } };
      },
    );
    const server = Fastify();
    registerConversationStream(server, {
      readConversation,
      subscribeConversation: (target, listener) =>
        changes.subscribe(`${target.kind}:${target.id}`, listener),
    });
    cleanup.push(() => server.close());
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    const connect = async () => {
      const abort = new AbortController();
      cleanup.push(() => {
        abort.abort();
        return Promise.resolve();
      });
      const response = await fetch(
        `${address}/api/runtime/v1/events?kind=${kind}&id=target-one`,
        { signal: abort.signal },
      );
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("event: observation")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before observation");
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array))
          throw new Error("Expected SSE bytes");
        text += new TextDecoder().decode(bytes);
      }
      return { abort, reader, text };
    };
    const first = await connect();
    expect(first.text).toContain('"kind":"snapshot"');
    expect(readConversation).toHaveBeenCalledTimes(1);
    first.abort.abort();
    revision = "finished-offline";
    changes.publish(`${kind}:target-one`);
    const second = await connect();
    expect(second.text).toContain(
      kind === "play" ? '"value":null' : "finished-offline",
    );
    expect(/id: ([^\n]+)/.exec(second.text)?.[1]).not.toEqual(
      /id: ([^\n]+)/.exec(first.text)?.[1],
    );
    second.abort.abort();
  });
}

test("an invalidation during an asynchronous initial read is delivered without polling", async () => {
  const server = Fastify();
  const changes = new ConversationChanges();
  let first = true;
  const readConversation = vi.fn(async (): Promise<ConversationState> => {
    if (first) {
      first = false;
      changes.publish("setting:target-one");
      await Promise.resolve();
      return { kind: "setting", value: { revision: "before", selected: null } };
    }
    return { kind: "setting", value: { revision: "after", selected: null } };
  });
  registerConversationStream(server, {
    readConversation,
    subscribeConversation: (target, listener) =>
      changes.subscribe(`${target.kind}:${target.id}`, listener),
  });
  cleanup.push(() => server.close());
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  cleanup.push(() => {
    abort.abort();
    return Promise.resolve();
  });
  const response = await fetch(
    `${address}/api/runtime/v1/events?kind=setting&id=target-one`,
    { signal: abort.signal },
  );
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes('"revision":"after"')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE ended before observation");
    const bytes: unknown = chunk.value;
    if (!(bytes instanceof Uint8Array)) throw new Error("Expected SSE bytes");
    text += new TextDecoder().decode(bytes);
  }
  expect(text).toContain('"revision":"before"');
  expect(readConversation).toHaveBeenCalledTimes(2);
  // No business reads occur simply because time passes.
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(readConversation).toHaveBeenCalledTimes(2);
  abort.abort();
});
