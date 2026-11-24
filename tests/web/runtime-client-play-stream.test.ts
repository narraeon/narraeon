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
  vi.useRealTimers();
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

test("missing deltas reopen observation only after a delay that resets on a snapshot", async () => {
  vi.useFakeTimers();
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
  const delta = conversationUpdate(first, next);
  source.update("epoch:3", delta);
  expect(source.readyState).toBe(Source.CLOSED);
  expect(Source.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(199);
  expect(Source.instances).toHaveLength(1);
  vi.advanceTimersByTime(1);

  const second = Source.instances[1]!;
  second.update("new:2", delta);
  vi.advanceTimersByTime(399);
  expect(Source.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);

  const third = Source.instances[2]!;
  third.update("recovered:1", { kind: "snapshot", value: next });
  await flush();
  expect(receive.mock.calls.at(-1)?.[0]).toEqual(next);
  third.update("another-epoch:2", delta);
  vi.advanceTimersByTime(199);
  expect(Source.instances).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(Source.instances).toHaveLength(4);
  expect(fetch).not.toHaveBeenCalled();
  close();
});

test("consecutive connections missing their snapshot back off exponentially and cap at five seconds", () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  const receive = vi.fn();
  const close = new RuntimeClient().observeConversation(
    { kind: "play", id: "world-one" },
    receive,
  );
  const delta = conversationUpdate(
    { kind: "play", value: chainView("running", "") },
    { kind: "play", value: chainView("running", "片段") },
  );
  expect(delta.kind).toBe("play_delta");

  // Replay the gap on the newest source, including queued events on a closed one.
  for (let gap = 0; gap < 8; gap++)
    Source.instances.at(-1)!.update("sample:2", delta);
  expect(Source.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);

  for (const [index, delay] of [
    200, 400, 800, 1600, 3200, 5000, 5000,
  ].entries()) {
    const source = Source.instances.at(-1)!;
    expect(source.readyState).toBe(Source.CLOSED);
    vi.advanceTimersByTime(delay - 1);
    expect(Source.instances).toHaveLength(index + 1);
    vi.advanceTimersByTime(1);
    expect(Source.instances).toHaveLength(index + 2);
    expect(vi.getTimerCount()).toBe(0);
    source.update("sample:2", delta);
    expect(vi.getTimerCount()).toBe(0);
    // An open EventSource without a valid snapshot does not reset the backoff.
    const next = Source.instances.at(-1)!;
    next.onopen!();
    next.update("sample:2", delta);
    expect(vi.getTimerCount()).toBe(1);
  }
  expect(receive).not.toHaveBeenCalled();
  close();
});

test.each(["close", "switch"] as const)(
  "%s during backoff cancels the timer and ignores old events and deliveries",
  async (action) => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", Source);
    let fail!: (error: unknown) => void;
    let current!: () => boolean;
    const receive = vi.fn(
      (_state: ConversationState, _changed: boolean, valid?: () => boolean) => {
        current = valid!;
        return new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
      },
    );
    const connection = vi.fn();
    const client = new RuntimeClient();
    const close = client.observeConversation(
      { kind: "play", id: "world-one" },
      receive,
      connection,
    );
    const first: ConversationState = {
      kind: "play",
      value: chainView("running", ""),
    };
    const snapshot = { kind: "snapshot", value: first } as const;
    const source = Source.instances[0]!;
    source.update("epoch:1", snapshot);
    expect(current()).toBe(true);
    source.update("epoch:2", snapshot);
    source.update(
      "epoch:4",
      conversationUpdate(first, {
        kind: "play",
        value: chainView("running", "片段"),
      }),
    );
    expect(current()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    close();
    expect(vi.getTimerCount()).toBe(0);

    const receiveNext = vi.fn();
    let closeNext: (() => void) | undefined;
    if (action === "switch") {
      closeNext = client.observeConversation(
        { kind: "play", id: "world-two" },
        receiveNext,
      );
      const next = Source.instances[1]!;
      expect(next.url).toContain("id=world-two");
      next.update("next:1", {
        kind: "snapshot",
        value: { kind: "play", value: null },
      });
    }
    source.onopen!();
    source.onerror!();
    source.update("late:1", snapshot);
    fail(new Error("old projection"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Source.instances).toHaveLength(action === "switch" ? 2 : 1);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receiveNext).toHaveBeenCalledTimes(action === "switch" ? 1 : 0);
    expect(connection).not.toHaveBeenCalled();
    closeNext?.();
  },
);

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

test("failed hydration retries the same revision and clears the warning on the same connection", async () => {
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
  source.update("first:2", update);
  await flush();
  expect(changes).toEqual([true, true]);
  expect(connection.mock.calls).toEqual([
    ["projection_failed", "temporary read failure"],
    ["synchronized"],
  ]);
  close();
});

test("disconnect invalidates an in-flight projection and its late failure", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  let fail!: (error: unknown) => void;
  let current!: () => boolean;
  const status = vi.fn();
  const close = new RuntimeClient().observeConversation(
    { kind: "play", id: "world-one" },
    (_state, _changed, valid) => {
      current = valid!;
      return new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    },
    status,
  );
  const source = Source.instances[0]!;
  source.update("epoch:1", {
    kind: "snapshot",
    value: { kind: "play", value: chainView("running", "") },
  });
  expect(current()).toBe(true);
  source.onerror!();
  expect(current()).toBe(false);
  fail(new Error("old projection"));
  await flush();
  expect(status.mock.calls).toEqual([["reconnecting"]]);
  vi.advanceTimersByTime(5_000);
  expect(Source.instances).toHaveLength(1);
  source.onopen!();
  expect(status.mock.calls).toEqual([["reconnecting"], ["connected"]]);
  close();
});

test.each(["observation", "failure"] as const)(
  "a terminal %s error closes the source without scheduling a retry",
  (event) => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", Source);
    const connection = vi.fn();
    const close = new RuntimeClient().observeConversation(
      { kind: "play", id: "world-one" },
      vi.fn(),
      connection,
    );
    const source = Source.instances[0]!;
    source.dispatchEvent(new MessageEvent(event, { data: "{}" }));
    expect(connection.mock.calls).toEqual([
      [
        "failed",
        event === "observation"
          ? "Incompatible conversation observation"
          : undefined,
      ],
    ]);
    expect(source.readyState).toBe(Source.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
    close();
  },
);

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
