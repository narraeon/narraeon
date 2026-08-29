import { expect, test } from "vitest";

import {
  providerStreamEvents,
  providerStreamJson,
  type ProviderStreamEvent,
} from "../../src/runtime/model/ProviderStream.ts";

test("按空行切分事件并保留 event 名与 data", async () => {
  expect(
    await collect(["event: delta\ndata: one\n\n", "event: end\ndata: two\n\n"]),
  ).toEqual([
    { event: "delta", data: "one" },
    { event: "end", data: "two" },
  ]);
});

test("chunk 边界落在行中间、字段中间都不影响解析", async () => {
  expect(await collect(["data: he", "llo\n\nda", "ta: wor", "ld\n\n"])).toEqual(
    [
      { event: null, data: "hello" },
      { event: null, data: "world" },
    ],
  );
});

test("多行 data 按换行拼接，注释行被忽略", async () => {
  expect(
    await collect([": keep-alive\ndata: first\ndata: second\n\n"]),
  ).toEqual([{ event: null, data: "first\nsecond" }]);
});

test("CRLF 与无空格字段都能解析", async () => {
  expect(await collect(["event:tick\r\ndata:{}\r\n\r\n"])).toEqual([
    { event: "tick", data: "{}" },
  ]);
});

test("被 chunk 切开的多字节字符不会解码成替换字符", async () => {
  const encoded = new TextEncoder().encode("data: Alex\n\n");
  const events = await collectBytes([encoded.slice(0, 8), encoded.slice(8)]);
  expect(events).toEqual([{ event: null, data: "Alex" }]);
});

test("流末尾缺少空行时最后一个事件仍会产出", async () => {
  expect(await collect(["data: tail"])).toEqual([
    { event: null, data: "tail" },
  ]);
});

test("空 data 的事件不产出，避免下游把心跳当增量", async () => {
  expect(await collect(["event: ping\n\ndata: real\n\n"])).toEqual([
    { event: null, data: "real" },
  ]);
});

test("providerStreamJson 跳过 [DONE] 与非法负载", () => {
  expect(providerStreamJson('{"a":1}')).toEqual({ a: 1 });
  expect(providerStreamJson("[DONE]")).toBeNull();
  expect(providerStreamJson("")).toBeNull();
  expect(providerStreamJson("not json")).toBeNull();
});

test("Provider SSE 完整按 Provider 输出读取，不施加本地正文或事件上限", async () => {
  const payload = "x".repeat(64 * 1024);
  expect(await collect([`data: ${payload}\n\ndata: two\n\n`])).toEqual([
    { event: null, data: payload },
    { event: null, data: "two" },
  ]);
});

test("下游在终态事件后停止读取时取消未结束的 Provider 流", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: done\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of providerStreamEvents(body)) {
    expect(event).toEqual({ event: null, data: "done" });
    break;
  }

  expect(cancelled).toBe(true);
});

async function collect(chunks: string[]): Promise<ProviderStreamEvent[]> {
  const encoder = new TextEncoder();
  return collectBytes(chunks.map((chunk) => encoder.encode(chunk)));
}

async function collectBytes(
  chunks: Uint8Array[],
): Promise<ProviderStreamEvent[]> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const events: ProviderStreamEvent[] = [];
  for await (const event of providerStreamEvents(body)) events.push(event);
  return events;
}
