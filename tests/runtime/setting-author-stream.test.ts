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
      chunk({ reasoning_content: "先想" }),
      chunk({ reasoning_content: "一下。" }),
      chunk({ content: "秦龙" }),
      chunk({ content: "抱着球衣。" }),
      "data: [DONE]\n\n",
    ],
    (delta) => deltas.push(delta),
  );

  expect(result.reasoningContent).toBe("先想一下。");
  expect(result.content).toBe("秦龙抱着球衣。");
  expect(deltas).toEqual([
    { kind: "reasoning", text: "先想" },
    { kind: "reasoning", text: "一下。" },
    { kind: "text", text: "秦龙" },
    { kind: "text", text: "抱着球衣。" },
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
  ]);

  expect(result.toolCalls.map(({ id }) => id)).toEqual(["a", "b"]);
  expect(result.toolCalls[0]?.arguments).toBe('{"path":"x"}');
  expect(result.toolCalls[1]?.arguments).toBe('{"op":"add"}');
});

test("include_usage 的末尾用量帧被采集", async () => {
  const result = await aggregate([
    chunk({ content: "好。" }),
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8}}\n\n',
    "data: [DONE]\n\n",
  ]);

  expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 8 });
});

test("心跳注释与空 delta 不产生增量", async () => {
  const deltas: SettingAuthorDelta[] = [];
  const result = await aggregate(
    [": keep-alive\n\n", chunk({ content: "" }), chunk({ content: "在。" })],
    (delta) => deltas.push(delta),
  );

  expect(result.content).toBe("在。");
  expect(deltas).toEqual([{ kind: "text", text: "在。" }]);
});

test("anthropic：拼接 thinking 与 text，并按 index 拼 tool 的 partial_json", async () => {
  const deltas: SettingAuthorDelta[] = [];
  const result = await aggregateAnthropic(
    [
      anthropic("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 240 } },
      }),
      anthropic("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
      anthropic("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先想想。" },
      }),
      anthropic("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "setting_write_file",
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
      anthropic("message_delta", {
        type: "message_delta",
        usage: { output_tokens: 36 },
      }),
    ],
    (delta) => deltas.push(delta),
  );

  expect(result.reasoningContent).toBe("先想想。");
  expect(result.toolCalls).toEqual([
    {
      id: "toolu_1",
      name: "setting_write_file",
      arguments: '{"path":"a.yaml"}',
    },
  ]);
  expect(result.usage).toEqual({ input_tokens: 240, output_tokens: 36 });
  expect(deltas.map(({ kind }) => kind)).toEqual(["reasoning", "tool", "tool"]);
});

test("anthropic：没有对应 tool 块的 partial_json 被忽略而不是崩溃", async () => {
  const result = await aggregateAnthropic([
    anthropic("content_block_delta", {
      type: "content_block_delta",
      index: 7,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    anthropic("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "好。" },
    }),
  ]);

  expect(result.toolCalls).toEqual([]);
  expect(result.content).toBe("好。");
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
