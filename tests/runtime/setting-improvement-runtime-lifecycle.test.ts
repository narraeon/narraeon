import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("setting-improvement.start 失败后删除预占条目，同 ID 可干净重试", async () => {
  const { runtime, packageId } = await fixture();
  let fetchCalls = 0;
  vi.stubGlobal("fetch", () => {
    fetchCalls += 1;
    return Promise.resolve(
      fetchCalls === 1
        ? new Response("provider unavailable", { status: 503 })
        : planResponse(),
    );
  });

  await expect(
    runtime.handle(startRequest(packageId, "same-id")),
  ).rejects.toThrow(/503|Provider/u);
  await expect(
    runtime.handle(startRequest(packageId, "same-id")),
  ).resolves.toMatchObject({ result: { kind: "plan" } });
  await expect(
    runtime.handle({
      type: "setting-improvement.discard",
      improvementId: "same-id",
    }),
  ).resolves.toMatchObject({ result: { discarded: true } });
});

test("start 仍在读取依赖时进度查询不会误报会话不存在", async () => {
  const { runtime, packageId } = await fixture();
  const releaseDependencies = deferred<void>();
  const dependenciesEntered = deferred<void>();
  const readSpy = vi.spyOn(
    ContentWorkspace.prototype,
    "readCurrentTreeContentPackage",
  );
  readSpy.mockImplementation(async function (this: ContentWorkspace, localId) {
    dependenciesEntered.resolve();
    await releaseDependencies.promise;
    readSpy.mockRestore();
    return this.readCurrentTreeContentPackage(localId);
  });
  vi.stubGlobal("fetch", () =>
    Promise.resolve(candidateResponse("loading-id")),
  );

  const starting = runtime.handle({
    type: "setting-improvement.start",
    improvementId: "loading-id",
    packageId,
    goal: "Improve the player experience in the current content package",
    mode: "direct_candidate",
    contextPaths: [],
  });
  await dependenciesEntered.promise;
  await expect(
    runtime.handle({
      type: "setting-improvement.progress",
      improvementId: "loading-id",
    }),
  ).resolves.toMatchObject({ result: { phase: "generating", round: 0 } });
  releaseDependencies.resolve();
  await expect(starting).resolves.toMatchObject({
    result: { kind: "candidate" },
  });
});

test("同 ID 并发 start 在读取依赖前就只预占一条会话", async () => {
  const { runtime, packageId } = await fixture();
  const releaseDependencies = deferred<void>();
  const dependenciesEntered = deferred<void>();
  let entered = 0;
  const readSpy = vi.spyOn(
    ContentWorkspace.prototype,
    "readCurrentTreeContentPackage",
  );
  readSpy.mockImplementation(async function (this: ContentWorkspace, localId) {
    entered += 1;
    dependenciesEntered.resolve();
    await releaseDependencies.promise;
    readSpy.mockRestore();
    return this.readCurrentTreeContentPackage(localId);
  });
  const fetchMock = vi.fn(() => Promise.resolve(planResponse()));
  vi.stubGlobal("fetch", fetchMock);

  const first = runtime.handle(startRequest(packageId, "concurrent-id"));
  await dependenciesEntered.promise;
  const second = runtime.handle(startRequest(packageId, "concurrent-id"));
  await expect(second).rejects.toThrow("Setting-improvement ID already exists");
  expect(entered).toBe(1);
  releaseDependencies.resolve();
  await expect(first).resolves.toMatchObject({ result: { kind: "plan" } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("start 模型 I/O 期间 discard 被拒绝，完成后会话仍可用", async () => {
  const { runtime, packageId } = await fixture();
  const providerGate = deferred<Response>();
  const providerEntered = deferred<void>();
  vi.stubGlobal("fetch", () => {
    providerEntered.resolve();
    return providerGate.promise;
  });

  const starting = runtime.handle(startRequest(packageId, "starting-id"));
  await providerEntered.promise;
  await expect(
    runtime.handle({
      type: "setting-improvement.discard",
      improvementId: "starting-id",
    }),
  ).rejects.toThrow(/operation is running/u);
  providerGate.resolve(planResponse());
  await expect(starting).resolves.toMatchObject({ result: { kind: "plan" } });
  await expect(
    runtime.handle({
      type: "setting-improvement.discard",
      improvementId: "starting-id",
    }),
  ).resolves.toMatchObject({ result: { discarded: true } });
});

test("start 冻结当前预设的设定完善提示，工具定义与说明仍由 Runtime 内置", async () => {
  const { runtime, packageId } = await fixture();
  const firstPrompt =
    "# City authoring method\n\nFrozen marker: improve the neighborhood's daily rhythm first.\n";
  const secondPrompt =
    "# Wilderness authoring method\n\nSwitched marker: write only woodland exploration.\n";
  await saveCurrentSettingPrompt(runtime, firstPrompt);

  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error(
          "Expected the provider request body to be a JSON string",
        );
      providerBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(planResponse());
    },
  );

  await runtime.handle(startRequest(packageId, "frozen-preset"));
  await saveCurrentSettingPrompt(runtime, secondPrompt);
  await runtime.handle({
    type: "setting-improvement.revise-plan",
    improvementId: "frozen-preset",
    feedback: "Make the rhythm more specific.",
  });

  expect(providerBodies).toHaveLength(2);
  for (const body of providerBodies) {
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("Frozen marker");
    expect(serialized).not.toContain("Switched marker");
    expect(serialized).toContain(
      "Runtime setting-improvement tools and mechanical contract",
    );
    expect(serialized).toContain("setting_list");
    expect(serialized).toContain("current candidate-document snapshot");
  }
});

test("候选完成后继续修改会为每个 Chat Completions tool call 保留 tool result", async () => {
  const { runtime, packageId } = await fixture();
  const providerBodies: ChatSettingRequest[] = [];
  let exchange = 0;
  vi.stubGlobal(
    "fetch",
    (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error(
          "Expected the provider request body to be a JSON string",
        );
      const body = JSON.parse(init.body) as ChatSettingRequest;
      providerBodies.push(body);
      const missing = missingToolResultIds(body.messages);
      if (missing.length > 0) return Promise.resolve(toolProtocolError());
      exchange += 1;
      return Promise.resolve(candidateResponse(`exchange-${String(exchange)}`));
    },
  );

  await runtime.handle({
    type: "setting-improvement.start",
    improvementId: "revisable-candidate",
    packageId,
    goal: "Improve the player experience in the current content package",
    mode: "direct_candidate",
    contextPaths: [],
  });
  await expect(
    runtime.handle({
      type: "setting-improvement.revise-candidate",
      improvementId: "revisable-candidate",
      feedback: "Add more observable everyday detail.",
    }),
  ).resolves.toMatchObject({ result: { kind: "candidate" } });

  expect(providerBodies).toHaveLength(2);
  const revisionMessages = providerBodies[1]?.messages ?? [];
  expect(missingToolResultIds(revisionMessages)).toEqual([]);
  expect(revisionMessages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      tool_call_id: "finish-exchange-1",
    }),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-setting-lifecycle-"));
  roots.push(root);
  const runtime = new V1Runtime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  await runtime.handle({
    type: "model.save",
    connection: {
      name: "设定测试模型",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "test",
      contextWindowTokens: 64_000,
      maxOutputTokens: 16_384,
    },
  });
  const created = await runtime.handle({ type: "content.create" });
  return {
    runtime,
    packageId: (created.result as { localId: string }).localId,
  };
}

async function saveCurrentSettingPrompt(
  runtime: V1Runtime,
  prompt: string,
): Promise<void> {
  const read = await runtime.handle({ type: "play.read" });
  const library = read.result as {
    currentPresetId: string;
    presets: { id: string; name: string; files: Record<string, string> }[];
  };
  const preset = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  );
  if (preset === undefined) throw new Error("Current preset does not exist");
  const files = structuredClone(preset.files);
  files["prompts/setting-improvement.md"] = prompt;
  await runtime.handle({
    type: "play.save",
    presetId: preset.id,
    name: preset.name,
    files,
  });
  await runtime.handle({ type: "play.select", presetId: preset.id });
}

function startRequest(packageId: string, improvementId: string) {
  return {
    type: "setting-improvement.start" as const,
    improvementId,
    packageId,
    goal: "Improve the player experience in the current content package",
    mode: "plan_first" as const,
    contextPaths: [],
  };
}

function planResponse() {
  const content =
    "# Creation plan\n\nPreserve the current tree's world constraints and player agency. Improve only the requested experience, document summaries, and opening hook, then pass the full Runtime candidate check.";
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

interface ChatSettingRequest {
  messages: ChatSettingMessage[];
}

interface ChatSettingMessage {
  role: string;
  tool_calls?: { id: string }[];
  tool_call_id?: string;
}

function missingToolResultIds(messages: ChatSettingMessage[]): string[] {
  const missing: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.tool_calls === undefined)
      continue;
    const pending = new Set(message.tool_calls.map(({ id }) => id));
    let cursor = index + 1;
    while (messages[cursor]?.role === "tool") {
      const toolCallId = messages[cursor]?.tool_call_id;
      if (toolCallId !== undefined) pending.delete(toolCallId);
      cursor += 1;
    }
    missing.push(...pending);
  }
  return missing;
}

function candidateResponse(suffix: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `preview-${suffix}`,
                type: "function",
                function: {
                  name: "setting_preview_candidate",
                  arguments: "{}",
                },
              },
              {
                index: 1,
                id: `finish-${suffix}`,
                type: "function",
                function: {
                  name: "setting_finish_candidate",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function toolProtocolError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
    }),
    { status: 400 },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
