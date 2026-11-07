import type { AiFailureRecorder } from "../../../src/runtime/model/AiFailureLog.ts";
import { FileNativeModelHost } from "../../../src/runtime/model/FileNativeModelAdapters.ts";

interface Call {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function googleTools(calls: Call[]) {
  return [
    ...calls.flatMap((call, index) => {
      const argumentsJson = JSON.stringify(call.arguments);
      const midpoint = Math.floor(argumentsJson.length / 2);
      return [
        {
          event_type: "step.start",
          index,
          step: {
            type: "function_call",
            id: call.id,
            name: call.name,
            arguments: {},
          },
        },
        {
          event_type: "step.delta",
          index,
          delta: {
            type: "arguments_delta",
            arguments: argumentsJson.slice(0, midpoint),
          },
        },
        {
          event_type: "step.delta",
          index,
          delta: {
            type: "arguments_delta",
            arguments: argumentsJson.slice(midpoint),
          },
        },
        { event_type: "step.stop", index },
      ];
    }),
    {
      event_type: "interaction.completed",
      interaction: { status: "requires_action" },
    },
  ];
}

export function googleText(text: string): unknown[] {
  return [
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text } },
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { status: "completed" },
    },
  ];
}

export function googleSignedText(text: string) {
  const events = googleText(text);
  events.splice(
    events.length - 1,
    0,
    {
      event_type: "step.start",
      index: 1,
      step: {
        type: "thought",
        summary: [],
        opaque: { encrypted: "synthetic-opaque-secret" },
      },
    },
    {
      event_type: "step.delta",
      index: 1,
      delta: {
        type: "thought_signature",
        signature: "synthetic-signature-secret",
      },
    },
    { event_type: "step.stop", index: 1 },
  );
  return events;
}

export function interruptedGoogleWrite(name: string, path: string): unknown[] {
  return [
    {
      event_type: "step.start",
      index: 0,
      step: { type: "function_call", id: "partial", name, arguments: {} },
    },
    {
      event_type: "step.delta",
      index: 0,
      delta: {
        type: "arguments_delta",
        arguments: JSON.stringify({
          path,
          contents: "Must never publish",
        }).slice(0, -2),
      },
    },
  ];
}

export function googleAuthoringHost(
  responses: unknown[][],
  failureLog?: AiFailureRecorder,
  override: {
    baseUrl?: string;
    modelId?: string;
    maxOutputTokens?: number;
  } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "synthetic",
      modelId: "manual-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2000,
      ...override,
    },
    (_url, options) => {
      if (typeof options?.body !== "string")
        throw new Error("Missing request body");
      sent.push(JSON.parse(options.body) as Record<string, unknown>);
      const events = responses.shift();
      if (events === undefined) throw new Error("Unexpected synthetic request");
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
    failureLog,
  );
  return { host, sent };
}

export function googleInterruptedHost(
  name: string,
  path: string,
  mode: "cancel" | "disconnect",
) {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "synthetic",
      modelId: "manual-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2000,
    },
    (_url, options) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const partial = interruptedGoogleWrite(name, path)
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("");
              controller.enqueue(new TextEncoder().encode(partial));
              notifyStarted();
              if (mode === "disconnect")
                controller.error(new Error("synthetic disconnect"));
              else
                options?.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  return { host, started };
}
