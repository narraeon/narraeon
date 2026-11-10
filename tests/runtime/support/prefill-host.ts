import type { ModelAssistantPrefillMode } from "../../../src/protocol/modelConnections.ts";
import { FileNativeModelHost } from "../../../src/runtime/model/FileNativeModelAdapters.ts";

export function prefillHost(
  steps: {
    text: string;
    finish?: "stop" | "length";
    extra?: Record<string, unknown>;
    json?: boolean;
  }[],
  mode: ModelAssistantPrefillMode = "assistant",
) {
  const sent: Record<string, unknown>[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "fixture-secret",
      modelId: "fixture-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2000,
      assistantPrefillMode: mode,
    },
    (_url, options) => {
      if (typeof options?.body !== "string")
        throw new Error("Expected JSON body");
      sent.push(JSON.parse(options.body) as Record<string, unknown>);
      const step = steps.shift();
      if (!step) throw new Error("Prefill fixture exhausted");
      if (step.json)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: step.text,
                    ...step.extra,
                  },
                  finish_reason: step.finish,
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      const deltas: unknown[] = [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: step.text, ...step.extra },
              finish_reason: null,
            },
          ],
        },
      ];
      if (step.finish)
        deltas.push({
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: step.finish,
            },
          ],
        });
      return Promise.resolve(
        new Response(
          deltas.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
            (step.finish ? "data: [DONE]\n\n" : ""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  return { host, sent };
}
