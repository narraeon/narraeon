import { expect, test } from "vitest";

import {
  aggregateAnthropicSettingStream,
  aggregateChatSettingStream,
  type SettingStreamResult,
} from "../../src/runtime/model/SettingAuthorStream.ts";
import type { SettingAuthorDelta } from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";

test("拼接正文与思维链增量，并按顺序报出", async () => {
  const deltas: SettingAuthorDelta[] = [];
  const result = await aggregate(
    [
      chunk({ reasoning_content: "Think " }),
      chunk({ reasoning_content: "first." }),
      chunk({ content: "Alex" }),
      chunk({ content: " is holding a jersey." }),
      "data: [DONE]\n\n",
    ],
    (delta) => deltas.push(delta),
  );

  expect(result.reasoningContent).toBe("Think first.");
  expect(result.content).toBe("Alex is holding a jersey.");
  expect(deltas).toEqual([
    { kind: "reasoning", text: "Think " },
    { kind: "reasoning", text: "first." },
    { kind: "text", text: "Alex" },
    { kind: "text", text: " is holding a jersey." },
  ]);
});

test("按 index 拼接分片的工具参数，id 与 name 只在首片出现", async () => {
  const result = await aggregate([
    chunk({
      tool_calls: [
        { index: 0, id: "call-1", function: { name: "setting_write_file" } },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: '{"path":"wor' } }],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: 'ld/a.yaml"}' } }],
    }),
    "data: [DONE]\n\n",
  ]);

  expect(result.toolCalls).toEqual([
    {
      id: "call-1",
      name: "setting_write_file",
      arguments: '{"path":"world/a.yaml"}',
    },
  ]);
});

test("多个工具调用按 index 排序，交错到达也不串行", async () => {
  const result = await aggregate([
    chunk({
      tool_calls: [
        { index: 1, id: "b", function: { name: "setting_patch" } },
        { index: 0, id: "a", function: { name: "setting_read" } },
      ],
    }),
    chunk({
      tool_calls: [
        { index: 1, function: { arguments: '{"op":"add"}' } },
        { index: 0, function: { arguments: '{"path":"x"}' } },
      ],
    }),
    "data: [DONE]\n\n",
  ]);

  expect(result.toolCalls.map(({ id }) => id)).toEqual(["a", "b"]);
  expect(result.toolCalls[0]?.arguments).toBe('{"path":"x"}');
  expect(result.toolCalls[1]?.arguments).toBe('{"op":"add"}');
});

test("include_usage 的末尾用量帧被采集", async () => {
  const result = await aggregate([
    chunk({ content: "Okay." }),
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8}}\n\n',
    "data: [DONE]\n\n",
  ]);

  expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 8 });
});

test("心跳注释与空 delta 不产生增量", async () => {
  const deltas: SettingAuthorDelta[] = [];
  const result = await aggregate(
    [
      ": keep-alive\n\n",
      chunk({ content: "" }),
      chunk({ content: "Present." }),
      "data: [DONE]\n\n",
    ],
    (delta) => deltas.push(delta),
  );

  expect(result.content).toBe("Present.");
  expect(deltas).toEqual([{ kind: "text", text: "Present." }]);
});

test("anthropic：拼接 thinking 与 text，并按 index 拼 tool 的 partial_json", async () => {
  const deltas: SettingAuthorDelta[] = [];
  const result = await aggregateAnthropic(
    [
      anthropic("message_start", {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 240 },
        },
      }),
      anthropic("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      anthropic("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Think it through." },
      }),
      anthropic("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }),
      anthropic("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "setting_write_file",
          input: {},
        },
      }),
      anthropic("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      }),
      anthropic("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"a.yaml"}' },
      }),
      anthropic("content_block_stop", {
        type: "content_block_stop",
        index: 1,
      }),
      anthropic("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 36 },
      }),
      anthropic("message_stop", { type: "message_stop" }),
    ],
    (delta) => deltas.push(delta),
  );

  expect(result.reasoningContent).toBe("Think it through.");
  expect(result.toolCalls).toEqual([
    {
      id: "toolu_1",
      name: "setting_write_file",
      arguments: { path: "a.yaml" },
    },
  ]);
  expect(result.usage).toEqual({ input_tokens: 240, output_tokens: 36 });
  expect(deltas.map(({ kind }) => kind)).toEqual(["reasoning", "tool", "tool"]);
});

test("anthropic：缺少对应原生块的 delta 会使续传载荷整体失败", async () => {
  await expect(
    aggregateAnthropic([
      anthropic("message_start", {
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      anthropic("content_block_delta", {
        type: "content_block_delta",
        index: 7,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
    ]),
  ).rejects.toThrow("Anthropic SSE content block delta is invalid");
});

function anthropic(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function aggregateAnthropic(
  chunks: string[],
  onDelta?: (delta: SettingAuthorDelta) => void,
): Promise<SettingStreamResult> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of chunks) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return aggregateAnthropicSettingStream(body, onDelta);
}

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

async function aggregate(
  chunks: string[],
  onDelta?: (delta: SettingAuthorDelta) => void,
): Promise<SettingStreamResult> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of chunks) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return aggregateChatSettingStream(body, onDelta);
}
