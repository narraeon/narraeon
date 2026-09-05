// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { v1Protocol, type V1PlayCallChainView } from "../../src/protocol/v1.ts";
import {
  conversationUpdate,
  type ConversationState,
  type ConversationUpdate,
} from "../../src/protocol/conversationObservation.ts";
import { RuntimeClient } from "../../src/web/runtimeClient.ts";

class Source extends EventTarget {
  static CLOSED = 2;
  static instances: Source[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    Source.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  update(id: string, update: ConversationUpdate) {
    this.dispatchEvent(
      new MessageEvent("observation", {
        lastEventId: id,
        data: JSON.stringify({ protocol: v1Protocol, update }),
      }),
    );
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  Source.instances = [];
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("SSE snapshots and append-only deltas reconstruct live text without repeated history", async () => {
  vi.stubGlobal("EventSource", Source);
  const receive = vi.fn();
  const close = new RuntimeClient().observeConversation(
    { kind: "play", id: "world-one" },
    receive,
  );
  const source = Source.instances[0]!;
  const first: ConversationState = {
    kind: "play",
    value: chainView("running", ""),
  };
  const next: ConversationState = {
    kind: "play",
    value: chainView("running", "Alex推开门。"),
  };
  source.update("first:1", { kind: "snapshot", value: first });
  await flush();
  const delta = conversationUpdate(first, next);
  expect(delta.kind).toBe("play_delta");
  expect(JSON.stringify(delta)).not.toContain("I signal Alex");
  source.update("first:2", delta);
  source.update("first:2", delta);
  await flush();
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive.mock.calls.at(-1)?.[0]).toEqual(next);
  const final: ConversationState = {
    kind: "play",
    value: chainView("ready", "Alex推开门。"),
  };
  source.update("reconnect:1", { kind: "snapshot", value: final });
  await flush();
  expect(receive.mock.calls.at(-1)?.[0]).toEqual(final);
  close();
  source.update("reconnect:2", { kind: "snapshot", value: first });
  expect(receive).toHaveBeenCalledTimes(3);
  expect(source.readyState).toBe(Source.CLOSED);
});

test("missing deltas reopen observation without posting a model command", async () => {
  vi.stubGlobal("EventSource", Source);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const receive = vi.fn();
  const close = new RuntimeClient().observeConversation(
    { kind: "play", id: "world-one" },
    receive,
  );
  const first: ConversationState = {
    kind: "play",
    value: chainView("running", ""),
  };
  const next: ConversationState = {
    kind: "play",
    value: chainView("running", "片段"),
  };
  const source = Source.instances[0]!;
  source.update("epoch:1", { kind: "snapshot", value: first });
  await flush();
  source.update("epoch:3", conversationUpdate(first, next));
  expect(Source.instances).toHaveLength(2);
  expect(source.readyState).toBe(2);
  Source.instances[1]!.update("new:1", { kind: "snapshot", value: next });
  await flush();
  expect(receive.mock.calls.at(-1)?.[0]).toEqual(next);
  expect(fetch).not.toHaveBeenCalled();
  close();
});

test("status updates arriving during hydration are coalesced and delivered afterwards", async () => {
  vi.stubGlobal("EventSource", Source);
  let release!: () => void;
  const received: string[] = [];
  const close = new RuntimeClient().observeConversation(
    { kind: "setting", id: "package-one", sessionId: "session-old" },
    async (state) => {
      if (state.kind !== "setting") throw new Error("wrong target");
      received.push(state.value.revision);
      if (received.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  );
  const source = Source.instances[0]!;
  expect(source.url).toContain("sessionId=session-old");
  for (const sequence of [1, 2, 3])
    source.update(`epoch:${sequence}`, {
      kind: "snapshot",
      value: {
        kind: "setting",
        value: { revision: `${sequence}`, selected: null },
      },
    });
  expect(received).toEqual(["1"]);
  release();
  await flush();
  expect(received).toEqual(["1", "3"]);
  close();
});

test("failed hydration retries the same revision after reconnect", async () => {
  vi.stubGlobal("EventSource", Source);
  let first = true;
  const changes: boolean[] = [];
  const connection = vi.fn();
  const close = new RuntimeClient().observeConversation(
    { kind: "revision", id: "world-one" },
    (_state, changed) => {
      changes.push(changed);
      if (first) {
        first = false;
        throw new Error("temporary read failure");
      }
    },
    connection,
  );
  const source = Source.instances[0]!;
  const update: ConversationUpdate = {
    kind: "snapshot",
    value: { kind: "revision", value: { revision: "same", selected: null } },
  };
  source.update("first:1", update);
  await flush();
  source.update("reconnect:1", update);
  await flush();
  expect(changes).toEqual([true, true]);
  expect(connection).toHaveBeenCalledWith("failed", "temporary read failure");
  close();
});

function chainView(
  status: V1PlayCallChainView["status"],
  text: string,
): V1PlayCallChainView {
  return {
    chainId: "chain-one",
    worldId: "world-one",
    baselineHead: "genesis",
    parentHead: status === "ready" ? "commit:2" : "commit:1",
    playPreset: { id: "preset", name: "默认", revision: "revision" },
    status,
    canRetry: false,
    previousContexts: [],
    events: [
      {
        id: 1,
        kind: "player",
        exchangeId: "exchange-one",
        text: "I signal Alex to open the door.",
        context: "fresh",
        committedHead: "commit:1",
      },
      {
        id: 2,
        kind: "assistant",
        text,
        status: status === "ready" ? "completed" : "streaming",
        exchange: 1,
        attempt: 1,
        ...(status === "ready" ? { committedHead: "commit:2" } : {}),
      },
    ],
    changedDocuments: [],
    lastFailure: null,
    updatedAt: status === "ready" ? 3 : 1,
  };
}
