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

test("同 ID 并发 start 即使同时停在依赖加载窗口也只建立一条会话", async () => {
  const { runtime, packageId } = await fixture();
  const releaseDependencies = deferred<void>();
  const bothEntered = deferred<void>();
  let entered = 0;
  const readSpy = vi.spyOn(
    ContentWorkspace.prototype,
    "readCurrentTreeContentPackage",
  );
  readSpy.mockImplementation(async function (this: ContentWorkspace, localId) {
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await releaseDependencies.promise;
    readSpy.mockRestore();
    return this.readCurrentTreeContentPackage(localId);
  });
  const fetchMock = vi.fn(() => Promise.resolve(planResponse()));
  vi.stubGlobal("fetch", fetchMock);

  const first = runtime.handle(startRequest(packageId, "concurrent-id"));
  const second = runtime.handle(startRequest(packageId, "concurrent-id"));
  await bothEntered.promise;
  releaseDependencies.resolve();
  const outcomes = await Promise.allSettled([first, second]);

  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
    1,
  );
  const rejected = outcomes.find(({ status }) => status === "rejected");
  expect(rejected?.status).toBe("rejected");
  if (rejected?.status !== "rejected") throw new Error("预期有一个失败请求");
  const reason: unknown = rejected.reason;
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toBe("设定完善 ID 已存在");
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
  ).rejects.toThrow(/进行中/u);
  providerGate.resolve(planResponse());
  await expect(starting).resolves.toMatchObject({ result: { kind: "plan" } });
  await expect(
    runtime.handle({
      type: "setting-improvement.discard",
      improvementId: "starting-id",
    }),
  ).resolves.toMatchObject({ result: { discarded: true } });
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

function startRequest(packageId: string, improvementId: string) {
  return {
    type: "setting-improvement.start" as const,
    improvementId,
    packageId,
    goal: "完善当前内容包的玩家体验",
    mode: "plan_first" as const,
    contextPaths: [],
  };
}

function planResponse() {
  const content =
    "# 创作计划\n\n保留当前内容树的世界约束与玩家行动权，只完善目标指定的体验、文档摘要与开场钩子，候选仍需通过 Runtime 整体自检。";
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
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
