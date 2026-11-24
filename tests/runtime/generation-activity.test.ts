import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { GenerationActivity } from "../../src/runtime/GenerationActivity.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

test("an overlapping authoring run keeps generation active after play settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-generation-"));
  const report = vi.fn<(active: boolean) => void>();
  const model = {
    provider: "chat_completions",
    modelId: "fixture",
    contextWindowTokens: 64_000,
    maxOutputTokens: 512,
  } as const;
  const runtime = new V1Runtime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
    generationActivity: new GenerationActivity(report),
  });

  try {
    await runtime.initialize();
    await runtime.handle({
      type: "model.save",
      connection: {
        ...model,
        name: "Fixture",
        presetId: "custom",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "fixture-only",
      },
    });
    const { localId: packageId } = (
      await runtime.handle({ type: "content.create-sample", locale: "en" })
    ).result as { localId: string };
    const {
      world: { worldId },
    } = (
      await runtime.handle({
        type: "world.create",
        operationId: "generation-world",
        packageId,
        model,
      })
    ).result as { world: { worldId: string } };
    expect(report).not.toHaveBeenCalled();

    const playResponse = Promise.withResolvers<Response>();
    const authorResponse = Promise.withResolvers<Response>();
    const fetchModel = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(playResponse.promise)
      .mockReturnValueOnce(authorResponse.promise);
    vi.stubGlobal("fetch", fetchModel);

    const play = runtime.handle({
      type: "play.chain.start",
      worldId,
      chainId: "generation-chain",
      exchangeId: "generation-exchange",
      playerText: "I open the door.",
    });
    await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledTimes(1));
    const author = runtime.handle({
      type: "setting-improvement.message",
      packageId,
      requestId: "generation-author",
      message: "Describe the tower.",
      continuation: { kind: "fresh_context" },
    });
    await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledTimes(2));
    expect(report.mock.calls).toEqual([[true]]);

    playResponse.resolve(
      Response.json({
        choices: [
          {
            message: { role: "assistant", content: "The door opens." },
            finish_reason: "stop",
          },
        ],
      }),
    );
    expect((await play).result).toMatchObject({ status: "ready" });
    expect(report.mock.calls).toEqual([[true]]);

    authorResponse.resolve(
      Response.json({ error: { message: "Fixture failure" } }, { status: 400 }),
    );
    expect(JSON.stringify((await author).result)).toContain("Fixture failure");
    expect(report.mock.calls).toEqual([[true], [false]]);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
