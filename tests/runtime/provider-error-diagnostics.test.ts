import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

test("Provider 明确拒绝会把状态和响应正文写入诊断 trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-provider-error-"));
  const tracePath = join(root, "provider-trace.jsonl");
  const previousTracePath = process.env.NARRAEON_PROVIDER_TRACE_PATH;
  process.env.NARRAEON_PROVIDER_TRACE_PATH = tracePath;
  try {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":"invalid assistant message"}', {
        status: 400,
        statusText: "Bad Request",
      }),
    );
    const adapter = new FileNativeModelHost(
      {
        provider: "chat_completions",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "diagnostic-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
      fetch_,
    );
    const bootstrap = new FileNativePromptCompiler().compileBootstrap(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "diagnostic-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
        playerInput: "继续。",
        playerInputPlacement: "bootstrap",
      }),
    );

    await expect(
      adapter.exchange({
        bootstrap,
        tools: bootstrap.tools,
        appended: [],
        maxOutputTokens: 2_000,
      }),
    ).rejects.toThrow(
      /Provider 请求失败：400 \{"error":"invalid assistant message"\}/u,
    );

    const entries = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            at: string;
            kind: string;
            value: unknown;
          },
      );
    const providerError = entries.at(-1);
    expect(typeof providerError?.at).toBe("string");
    expect(providerError?.kind).toBe("provider_error");
    expect(providerError?.value).toEqual({
      status: 400,
      statusText: "Bad Request",
      body: '{"error":"invalid assistant message"}',
    });
  } finally {
    if (previousTracePath === undefined)
      delete process.env.NARRAEON_PROVIDER_TRACE_PATH;
    else process.env.NARRAEON_PROVIDER_TRACE_PATH = previousTracePath;
    await rm(root, { recursive: true, force: true });
  }
});
