import { expect, test } from "vitest";
import {
  aggregateGoogleInteractions,
  projectGoogleInteractions,
} from "../../src/runtime/model/GoogleInteractionsStream.ts";
import { ModelHostOutcomeUnknownError } from "../../src/runtime/model/ModelHost.ts";

const created = '{"event_type":"interaction.created"}';
const start =
  '{"event_type":"step.start","index":0,"step":{"type":"model_output"}}';
const text =
  '{"event_type":"step.delta","index":0,"delta":{"type":"text","text":"Hello"}}';
const stop = '{"event_type":"step.stop","index":0}';
const completed =
  '{"event_type":"interaction.completed","interaction":{"status":"completed"}}';

function stream(...events: string[]): ReadableStream<Uint8Array> {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""))
    .body!;
}

test.each(["0", "0.0", "1", "1e0"])(
  "Google SSE completes with %s in discarded metadata",
  async (number) => {
    const payload = await aggregateGoogleInteractions(
      stream(
        `{"event_type":"interaction.created","interaction":{"metadata":[{"sample":${number}}]}}`,
        start,
        text,
        stop,
        completed,
      ),
    );
    expect(payload.completeLifecycle).toBe(true);
    expect(projectGoogleInteractions(payload)).toMatchObject({
      text: "Hello",
      stopReason: "completed",
      providerState: {
        protocol: "google_interactions",
        steps: [
          { type: "model_output", content: [{ type: "text", text: "Hello" }] },
        ],
      },
    });
  },
);

test.each([
  {
    name: "malformed JSON",
    events: [created, start, text, stop, "{", completed],
  },
  { name: "missing terminal event", events: [created, start, text, stop] },
  { name: "unclosed step", events: [created, start, text, completed] },
  {
    name: "a rounded step index",
    events: [
      created,
      start,
      text,
      '{"event_type":"step.stop","index":1e-999}',
      completed,
    ],
  },
  {
    name: "a rounded value in a native step extension",
    events: [
      created,
      '{"event_type":"step.start","index":0,"step":{"type":"model_output","extra":[{"integer":9007199254740993}]}}',
      text,
      stop,
      completed,
    ],
  },
  {
    name: "a rounded value in inline function arguments",
    events: [
      created,
      '{"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call","name":"read","arguments":{"sample":0.1234567890123456789}}}',
      stop,
      '{"event_type":"interaction.completed","interaction":{"status":"requires_action"}}',
    ],
  },
])("Google SSE rejects $name", async ({ events }) => {
  await expect(
    aggregateGoogleInteractions(stream(...events)),
  ).rejects.toBeInstanceOf(ModelHostOutcomeUnknownError);
});
