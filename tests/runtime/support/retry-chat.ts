import { FileNativeModelHost } from "../../../src/runtime/model/FileNativeModelAdapters.ts";

export function retryChat(
  steps: ("rate_limit" | "connect_timeout" | Record<string, unknown>)[],
) {
  const bodies: string[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "retry-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 4096,
    },
    async (_url, init) => {
      await Promise.resolve();
      if (typeof init?.body !== "string")
        throw new Error("Expected frozen JSON body");
      bodies.push(init.body);
      const step = steps.shift();
      if (step === "rate_limit")
        return Response.json(
          {
            error: { code: "rate_limit_exceeded", message: "Temporary limit" },
          },
          { status: 429 },
        );
      if (step === "connect_timeout")
        throw new TypeError("fetch failed", {
          cause: Object.assign(
            new Error(
              "Connect Timeout Error (attempted addresses: synthetic, timeout: 10000ms)",
            ),
            { code: "UND_ERR_CONNECT_TIMEOUT" },
          ),
        });
      if (step === undefined) throw new Error("retry fixture exhausted");
      return Response.json({
        choices: [
          { message: { role: "assistant", ...step }, finish_reason: "stop" },
        ],
      });
    },
  );
  return { host, bodies };
}
