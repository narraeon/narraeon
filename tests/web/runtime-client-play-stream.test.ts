import { afterEach, expect, test, vi } from "vitest";

import {
  v1Protocol,
  type V1PlayCallChainStreamFrame,
  type V1PlayCallChainView,
} from "../../src/protocol/v1.ts";
import { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(() => vi.unstubAllGlobals());

test("RuntimeClient 按 NDJSON 增量消费调用链流并返回最终快照", async () => {
  const running = chainView("running", "");
  const completed = chainView("ready", "Alex推开了门。");
  const lines = [
    {
      protocol: v1Protocol,
      frame: { kind: "snapshot", value: running, final: false },
    },
    {
      protocol: v1Protocol,
      frame: {
        kind: "assistant_delta",
        eventId: 2,
        deltaKind: "reasoning",
        text: "先确认门口",
        updatedAt: 2,
      },
    },
    {
      protocol: v1Protocol,
      frame: {
        kind: "assistant_delta",
        eventId: 2,
        deltaKind: "text",
        text: "Alex推",
        updatedAt: 2,
      },
    },
    {
      protocol: v1Protocol,
      frame: { kind: "snapshot", value: completed, final: true },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n")
    .concat("\n");
  const split = Math.floor(lines.length / 2);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.slice(0, split)));
      controller.enqueue(encoder.encode(lines.slice(split)));
      controller.close();
    },
  });
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const frames: V1PlayCallChainStreamFrame[] = [];

  const result = await new RuntimeClient().streamPlayCallChain(
    {
      type: "play.chain.start",
      worldId: "world-one",
      chainId: "chain-one",
      exchangeId: "exchange-one",
      playerText: "I signal Alex to open the door.",
    },
    (frame) => frames.push(frame),
  );

  expect(result).toEqual(completed);
  expect(frames.map(({ kind }) => kind)).toEqual([
    "snapshot",
    "assistant_delta",
    "assistant_delta",
    "snapshot",
  ]);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, requestInit] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/runtime/v1");
  expect(requestInit?.method).toBe("POST");
  expect(requestInit?.headers).toEqual({
    Accept: "application/x-ndjson",
    "Content-Type": "application/json",
  });
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
