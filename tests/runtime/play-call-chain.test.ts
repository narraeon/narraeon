import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  parseV1Envelope,
  type V1PlayCallChainView,
  type V1PlayContextReadingView,
} from "../../src/protocol/v1.ts";
import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  ScriptedModelHost,
  type ModelHost,
  type ModelHostBinding,
  type ModelHostExchange,
  type ModelHostResponse,
} from "../../src/runtime/model/ModelHost.ts";
import { FileNativeAiFailureLog } from "../../src/runtime/model/AiFailureLog.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import {
  FileNativePlayAdvanceStore,
  type PlayAdvanceBase,
} from "../../src/runtime/play/FileNativePlayAdvanceStore.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_AUTHORITY_EDGE;
  delete process.env.NARRAEON_INTERNAL_TEST_CLONE_STRATEGY;
  delete process.env.NARRAEON_INTERNAL_TEST_REFLINK_ERROR_CODE;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("推进事实先写入、当前指针尚未发布时，可按同一身份恢复而不改写事实", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-play-advance-pointer-"));
  roots.push(root);
  const store = new FileNativePlayAdvanceStore(root);
  const base = {
    schemaVersion: 1,
    kind: "play_advance",
    advanceKind: "response",
    worldId: "world-pointer-recovery",
    chainId: "chain-pointer-recovery",
    advanceId: "advance-pointer-recovery",
    operationId: "operation-pointer-recovery",
    parentHead: "commit:1",
    eventId: 2,
    exchange: 1,
    attempt: 1,
    createdAt: 100,
  } satisfies Extract<PlayAdvanceBase, { advanceKind: "response" }>;
  await store.begin(base);

  const chainDigest = createHash("sha256").update(base.chainId).digest("hex");
  await rm(
    join(
      root,
      "worlds-file-native",
      base.worldId,
      "runtime",
      "play-advances",
      chainDigest,
      "current.json",
    ),
  );

  const retried = { ...base, createdAt: 200 };
  await store.begin(retried);
  await store.recordProviderCompleted(retried, { text: "Recovered once." });
  const recovered = await store.readCurrent(base.worldId, base.chainId);
  expect(recovered).toMatchObject({
    base: { createdAt: 100 },
    providerCompleted: {
      recordedAt: 100,
      response: { text: "Recovered once." },
    },
  });
});

test("Provider 完整结果先落盘，冷恢复不重新调用模型即可继续结算", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-provider-result-recovery",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "Alex opens the recovered door exactly once.",
      },
    ],
  });
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE =
    "after_provider_completed";

  const interrupted = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-provider-result-recovery",
    exchangeId: "play-chain-provider-result-recovery-player",
    playerText: "I ask Alex to open the recovered door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:1",
  });
  expect(modelHost.requests).toHaveLength(1);

  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  const recovered = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(recovered).toMatchObject({
    status: "ready",
    parentHead: "commit:2",
  });
  expect(modelHost.requests).toHaveLength(1);
  expect(
    (await worlds.recoverEndpoint(worldId)).history
      .map(({ exactText }) => exactText)
      .filter((text) => text === "Alex opens the recovered door exactly once."),
  ).toHaveLength(1);
});

test("派发推进存在但结果未落盘时按 outcome unknown 终止，冷恢复不允许重放", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-abandoned-dispatch-unknown",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "Must never be dispatched." }],
  });
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE =
    "after_response_advance_began";

  await expect(
    new PlayCallChain(worlds).start({
      worldId,
      chainId: "play-chain-abandoned-dispatch-unknown",
      exchangeId: "play-chain-abandoned-dispatch-player",
      playerText: "I wait while the service exits.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost,
    }),
  ).rejects.toThrow("after_response_advance_began");
  expect(modelHost.requests).toHaveLength(0);

  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  const recovered = await new PlayCallChain(worlds).inspectWorld(worldId);

  expect(recovered).toMatchObject({ status: "interrupted", canRetry: false });
  expect(
    recovered?.events.some(
      (event) =>
        event.kind === "failure" &&
        event.message.includes("outcome is unknown"),
    ),
  ).toBe(true);
  expect(modelHost.requests).toHaveLength(0);
});

test("玩家取消会终止当前 Provider 派发并保留已提交玩家原文", async () => {
  const { worlds, worldId } = await createWorld("play-chain-player-cancel");
  let signal: AbortSignal | undefined;
  let markExchangeStarted: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  let finishExchange: ((response: ModelHostResponse) => void) | undefined;
  const providerResult = new Promise<ModelHostResponse>((resolve) => {
    finishExchange = resolve;
  });
  const modelHost: ModelHost = {
    binding: modelBinding,
    async exchange(_request, observer) {
      signal = observer?.signal;
      markExchangeStarted?.();
      // This deliberately uncooperative adapter ignores AbortSignal. Runtime
      // must still discard the result when it eventually returns.
      return await providerResult;
    },
  };
  const chains = new PlayCallChain(worlds);
  const running = chains.start({
    worldId,
    chainId: "play-chain-player-cancel-contract",
    exchangeId: "exchange-player-cancel",
    playerText: "I ask Alex to wait while I reconsider.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await exchangeStarted;

  const inspectedWhileRunning = await chains.inspectWorld(worldId);
  expect(inspectedWhileRunning).toMatchObject({
    status: "running",
    activeInvocation: {
      chainId: "play-chain-player-cancel-contract",
      exchangeId: "exchange-player-cancel",
      phase: "waiting",
      dispatches: 1,
    },
  });
  expect(inspectedWhileRunning?.activeInvocation).not.toHaveProperty(
    "abortable",
  );
  expect(inspectedWhileRunning?.activeInvocation).not.toHaveProperty(
    "controller",
  );
  expect(
    inspectedWhileRunning?.events.some(
      (event) => event.kind === "cancellation" || event.kind === "failure",
    ),
  ).toBe(false);
  expect(signal?.aborted).toBe(false);

  expect(
    chains.cancel({
      worldId,
      chainId: "play-chain-player-cancel-contract",
      exchangeId: "different-exchange",
    }),
  ).toEqual({ outcome: "not_running" });
  expect(signal?.aborted).toBe(false);
  expect(
    chains.cancel({
      worldId,
      chainId: "play-chain-player-cancel-contract",
      exchangeId: "exchange-player-cancel",
    }),
  ).toEqual({ outcome: "cancellation_requested" });

  expect(signal?.aborted).toBe(true);
  finishExchange?.({ text: "This late response must never be committed." });
  const interrupted = await running;
  expect(interrupted).toMatchObject({
    status: "interrupted",
    canRetry: false,
  });
  expect(interrupted.activeInvocation).toBeUndefined();
  expect(
    interrupted.events.some(
      (event) =>
        event.kind === "cancellation" &&
        event.message.includes("player cancelled"),
    ),
  ).toBe(true);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I ask Alex to wait while I reconsider.",
  ]);
});

test("浏览器进度流断开不会隐式取消 Runtime 调用或改变 Authority", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-browser-stream-disconnect",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "Alex answers even though the browser progress stream closed.",
        deltas: [
          { kind: "reasoning", text: "checking" },
          { kind: "text", text: "Alex answers" },
        ],
      },
    ],
  });
  const chains = new PlayCallChain(worlds);

  const completed = await chains.start({
    worldId,
    chainId: "play-chain-browser-stream-disconnect-contract",
    exchangeId: "exchange-browser-stream-disconnect",
    playerText: "I keep waiting after the browser stream closes.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
    observer: {
      onSnapshot() {
        throw new Error("Browser snapshot stream closed");
      },
      onAssistantDelta() {
        throw new Error("Browser delta stream closed");
      },
    },
  });

  expect(completed.status).toBe("ready");
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I keep waiting after the browser stream closes.",
    "Alex answers even though the browser progress stream closed.",
  ]);
});

test("检查进度不会把本进程仍在等待的 Provider 派发误判为遗留推进", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-live-inspection-race",
  );
  let markExchangeStarted: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  let finishExchange: (() => void) | undefined;
  const providerRelease = new Promise<void>((resolve) => {
    finishExchange = resolve;
  });
  const modelHost: ModelHost = {
    binding: modelBinding,
    async exchange() {
      markExchangeStarted?.();
      await providerRelease;
      const text = "Alex answers after the live progress inspection.";
      return {
        text,
        providerState: {
          protocol: "chat_completions",
          assistantMessage: { role: "assistant", content: text },
        },
      };
    },
  };
  const chains = new PlayCallChain(worlds);
  const running = chains.start({
    worldId,
    chainId: "play-chain-live-inspection-race-contract",
    exchangeId: "exchange-live-inspection-race",
    playerText: "I wait for Alex while checking the progress display.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await exchangeStarted;

  const inspected = await chains.inspectWorld(worldId);
  finishExchange?.();
  const completed = await running;

  expect(inspected).toMatchObject({
    status: "running",
    activeInvocation: {
      chainId: "play-chain-live-inspection-race-contract",
      exchangeId: "exchange-live-inspection-race",
      phase: "waiting",
    },
  });
  expect(completed).toMatchObject({ status: "ready", parentHead: "commit:2" });
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I wait for Alex while checking the progress display.",
    "Alex answers after the live progress inspection.",
  ]);
});

test("Provider 派发前取消保留冻结请求，空输入可继续且不重复玩家原文", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-player-cancel-before-dispatch",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "Alex answers only after the explicitly resumed request.",
      },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const running = chains.start({
    worldId,
    chainId: "play-chain-cancel-before-dispatch",
    exchangeId: "exchange-cancel-before-dispatch",
    playerText: "I ask Alex a question, then pause before dispatch.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(
    chains.cancel({
      worldId,
      chainId: "play-chain-cancel-before-dispatch",
      exchangeId: "exchange-cancel-before-dispatch",
    }),
  ).toEqual({ outcome: "cancellation_requested" });
  const interrupted = await running;
  expect(interrupted).toMatchObject({ status: "interrupted", canRetry: true });
  expect(modelHost.requests).toHaveLength(0);

  const resumed = await chains.append({
    worldId,
    chainId: "play-chain-cancel-before-dispatch",
    exchangeId: "exchange-resume-after-cancel",
    playerText: "",
    modelHost,
  });
  expect(resumed).toMatchObject({ status: "ready", canRetry: false });
  expect(modelHost.requests).toHaveLength(1);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I ask Alex a question, then pause before dispatch.",
    "Alex answers only after the explicitly resumed request.",
  ]);
});

test("精确结算已准备但 Authority 尚未接受时，冷恢复提交同一结果", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-settlement-prepared-recovery",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "The prepared response is committed after restart.",
      },
    ],
  });
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE =
    "after_settlement_prepared";

  const interrupted = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-settlement-prepared-recovery",
    exchangeId: "play-chain-settlement-prepared-player",
    playerText: "I wait for the prepared response.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:1",
  });
  expect(modelHost.requests).toHaveLength(1);

  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  const recovered = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(recovered).toMatchObject({ status: "ready", parentHead: "commit:2" });
  expect(modelHost.requests).toHaveLength(1);
  expect(
    (await worlds.readAuthorityHistory(worldId)).commits.filter(
      ({ historyAppend }) =>
        historyAppend[0]?.exactText ===
        "The prepared response is committed after restart.",
    ),
  ).toHaveLength(1);
});

test("页面时间线已落盘但推进尚未标记完成时，冷恢复只补完成标记", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-timeline-settled-recovery",
  );
  const scripted = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "The projected response remains exactly once.",
      },
    ],
  });
  const modelHost: ModelHost = {
    binding: () => scripted.binding(),
    exchange(request, observer) {
      process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE =
        "after_timeline_settled";
      return scripted.exchange(request, observer);
    },
  };

  await expect(
    new PlayCallChain(worlds).start({
      worldId,
      chainId: "play-chain-timeline-settled-recovery",
      exchangeId: "play-chain-timeline-settled-player",
      playerText: "I wait for the projected response.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost,
    }),
  ).rejects.toThrow("after_timeline_settled");
  expect(scripted.requests).toHaveLength(1);
  expect(await worlds.currentHead(worldId)).toBe("commit:2");

  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  const recovered = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(recovered).toMatchObject({ status: "ready", parentHead: "commit:2" });
  expect(scripted.requests).toHaveLength(1);
  expect(
    (await worlds.readAuthorityHistory(worldId)).commits.filter(
      ({ historyAppend }) =>
        historyAppend[0]?.exactText ===
        "The projected response remains exactly once.",
    ),
  ).toHaveLength(1);
});

test("Authority 已接受但时间线未结算时，冷恢复补齐同一响应而不重复提交", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-authority-accepted-recovery",
  );
  const scripted = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "The accepted response survives the process exit.",
      },
    ],
  });
  const modelHost: ModelHost = {
    binding: () => scripted.binding(),
    exchange(request, observer) {
      process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE =
        "after_authority_accepted";
      return scripted.exchange(request, observer);
    },
  };

  await expect(
    new PlayCallChain(worlds).start({
      worldId,
      chainId: "play-chain-authority-accepted-recovery",
      exchangeId: "play-chain-authority-accepted-recovery-player",
      playerText: "I wait for the accepted response.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost,
    }),
  ).rejects.toThrow("after_authority_accepted");
  expect(await worlds.currentHead(worldId)).toBe("commit:2");
  expect(scripted.requests).toHaveLength(1);

  delete process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PLAY_ADVANCE_EDGE;
  const recovered = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(recovered).toMatchObject({
    status: "ready",
    parentHead: "commit:2",
  });
  expect(scripted.requests).toHaveLength(1);
  expect(
    (await worlds.readAuthorityHistory(worldId)).commits.filter(
      ({ historyAppend }) =>
        historyAppend[0]?.exactText ===
        "The accepted response survives the process exit.",
    ),
  ).toHaveLength(1);
});

test("长调用轨迹按稳定游标读取摘要，重型详情与旧事件不会随尾部追加重写", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-long-timeline",
  );
  const detailMarker = "tool-detail-must-stay-out-of-pages";
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: Array.from({ length: 30 }, (_, index) => ({
          id: `list-${index + 1}`,
          name: "state_list",
          arguments: { marker: detailMarker, index },
        })),
      },
      { outcome: "response", text: "The long trace is complete." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const completed = await chains.start({
    worldId,
    chainId: "play-chain-long-timeline",
    exchangeId: "play-chain-long-timeline-player",
    playerText: "Inspect many context entries.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  expect(completed.events).toHaveLength(40);

  const tail = await worlds.playTimeline.readPage(worldId, 10);
  expect(tail.items).toHaveLength(10);
  expect(tail.nextCursor).not.toBeNull();
  expect(JSON.stringify(tail)).not.toContain(detailMarker);
  const earlier = await worlds.playTimeline.readPage(
    worldId,
    10,
    tail.nextCursor!,
  );
  expect(earlier.generation).toBe(tail.generation);
  expect(earlier.items).toHaveLength(10);
  expect(JSON.stringify(earlier)).not.toContain(detailMarker);

  let page = tail;
  let selected: { chainId: string; eventId: number } | undefined;
  while (page.nextCursor !== null && selected === undefined) {
    page = await worlds.playTimeline.readPage(worldId, 10, page.nextCursor);
    const item = page.items.find(
      (candidate) =>
        candidate.kind === "event" && candidate.event.kind === "tool_call",
    );
    if (item?.kind === "event")
      selected = { chainId: item.chainId, eventId: item.event.id };
  }
  expect(selected).toBeDefined();
  const selectedDetail = await worlds.playTimeline.readDetail(
    worldId,
    selected!.chainId,
    selected!.eventId,
  );
  expect(selectedDetail.kind).toBe("tool_call");
  if (selectedDetail.kind !== "tool_call")
    throw new Error("Expected a tool-call timeline detail");
  expect(selectedDetail.arguments).toMatchObject({ marker: detailMarker });

  const [contextDirectory] = await readdir(
    join(root, "worlds-file-native", worldId, "runtime", "play-contexts"),
  );
  const oldEventPath = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    contextDirectory!,
    "events",
    "0000000003.json",
  );
  const oldEvent = await readFile(oldEventPath, "utf8");
  const continuation = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "Only the tail advances." }],
  });
  await chains.append({
    worldId,
    chainId: completed.chainId,
    exchangeId: "play-chain-long-timeline-continuation",
    playerText: "",
    modelHost: continuation,
  });
  expect(await readFile(oldEventPath, "utf8")).toBe(oldEvent);
  await expect(
    worlds.playTimeline.readPage(worldId, 10, tail.nextCursor!),
  ).resolves.toEqual(earlier);

  const contextRoot = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    contextDirectory!,
  );
  await writeFile(join(contextRoot, "base.json"), "not needed by a page\n");
  await rm(join(contextRoot, "continuations"), {
    recursive: true,
    force: true,
  });

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const opened = (await runtime.handle({ type: "world.read", worldId }))
    .result as {
    state: unknown[];
    control: unknown[];
    history: unknown[];
    runtime: unknown;
    committedMessages: unknown[];
    playCallChain: unknown;
    playTimeline: { items: unknown[]; nextCursor: string | null };
  };
  expect(opened).toMatchObject({
    state: [],
    control: [],
    history: [],
    runtime: { surfaces: "lazy" },
    committedMessages: [],
    playCallChain: null,
  });
  expect(opened.playTimeline.items.length).toBeLessThanOrEqual(40);
  expect(JSON.stringify(opened)).not.toContain(detailMarker);
  await expect(readdir(join(root, "artifact-store"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  const runtimePage = (
    await runtime.handle({
      type: "play.timeline.page",
      worldId,
      limit: 10,
      cursor: tail.nextCursor!,
    })
  ).result;
  expect(runtimePage).toEqual(earlier);
  const runtimeDetail = (
    await runtime.handle({
      type: "play.timeline.detail",
      worldId,
      chainId: selected!.chainId,
      eventId: selected!.eventId,
    })
  ).result;
  expect(JSON.stringify(runtimeDetail)).toContain(detailMarker);
  const stateSurface = (
    await runtime.handle({
      type: "world.surface.read",
      worldId,
      surface: "state",
    })
  ).result as ContentTreeFile[];
  expect(stateSurface).toContainEqual(
    expect.objectContaining({ path: "current-situation.yaml" }),
  );
  await expect(
    runtime.handle({ type: "world.play-decorations.read", worldId }),
  ).resolves.toMatchObject({
    result: { artifacts: [], extensions: [], artifactDebug: [] },
  });
});

test("新调用链拒绝未冻结的旧 context_list 名称", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-reject-unfrozen-context-list",
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "legacy-list",
            name: "context_list",
            arguments: { source: "state", parent: "@dir-/" },
          },
        ],
      },
      { outcome: "response", text: "The rejected legacy call is ignored." },
    ],
  });

  const completed = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-reject-unfrozen-context-list",
    exchangeId: "play-chain-reject-unfrozen-context-list-player",
    playerText: "Continue without using obsolete tools.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(modelHost.requests[0]?.tools.map(({ name }) => name)).not.toContain(
    "context_list",
  );
  expect(completed.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "legacy-list",
      ok: false,
    }),
  );
  expect(modelHost.requests[1]?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "legacy-list",
    isError: true,
  });
});

test("协议允许空的追加输入，用现有请求上下文触发续写", () => {
  expect(() =>
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: {
        type: "play.chain.append",
        worldId: "world-1",
        chainId: "chain-1",
        exchangeId: "exchange-1",
        playerText: "",
      },
    }),
  ).not.toThrow();
});

test("协议接受按世界、调用链与本轮交换精确寻址的取消请求", () => {
  expect(() =>
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: {
        type: "play.chain.cancel",
        worldId: "world-1",
        chainId: "chain-1",
        exchangeId: "exchange-1",
      },
    }),
  ).not.toThrow();
});

test("协议把玩家历史修改建模为当前世界的时间线修订", () => {
  for (const continuation of ["continue_context", "fresh_context"] as const)
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.chain.revise-player",
          operationId: `revise-player-${continuation}`,
          worldId: "world-1",
          chainId: "chain-1",
          eventId: 3,
          replacementExchangeId: `exchange-replacement-${continuation}`,
          replacementText: "我改为留在门内。",
          continuation,
        },
      }),
    ).not.toThrow();

  expect(() =>
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: {
        type: "play.chain.revise-player",
        operationId: "revise-player-invalid",
        worldId: "world-1",
        chainId: "chain-1",
        eventId: 3,
        replacementExchangeId: "exchange-replacement-invalid",
        replacementText: "我改为留在门内。",
        continuation: "reuse_whatever_is_available",
      },
    }),
  ).toThrow("play.chain.revise-player.continuation is invalid");
});

test("协议拒绝无界时间线分页、空游标、非法详情事件与未知世界表面", () => {
  const invalidRequests = [
    { type: "play.timeline.page", worldId: "world-1", limit: 0 },
    { type: "play.timeline.page", worldId: "world-1", limit: 101 },
    {
      type: "play.timeline.page",
      worldId: "world-1",
      limit: 20,
      cursor: "",
    },
    {
      type: "play.timeline.detail",
      worldId: "world-1",
      chainId: "chain-1",
      eventId: 0,
    },
    {
      type: "world.surface.read",
      worldId: "world-1",
      surface: "everything",
    },
  ];
  for (const request of invalidRequests)
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request,
      }),
    ).toThrow();
});

test("工具中间步文本不进入叙事，状态与终态叙事分别推进并可追加上下文", async () => {
  const { worlds, worldId } = await createWorld("play-chain");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "I will update the door before narrating the result.",
        toolCalls: [
          {
            id: "patch-door",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "Alex已经把宿舍门打开。",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "Alex opens the door and gestures for you to go first.",
      },
      {
        outcome: "response",
        text: "The corridor lights come on one by one with each step.",
      },
    ],
  });
  const chains = new PlayCallChain(worlds);

  const first = await chains.start({
    worldId,
    chainId: "play-chain-contract",
    exchangeId: "exchange-first",
    playerText: "I signal Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(first).toMatchObject({
    status: "ready",
    baselineHead: "genesis",
    parentHead: "commit:3",
    changedDocuments: [
      {
        kind: "replace",
        ref: "@current-situation",
        path: "current-situation.yaml",
      },
    ],
  });
  expect(first.events.map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool_call",
    "tool_result",
    "assistant",
  ]);
  const assistantEvents = first.events.filter(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "assistant" }
    > => event.kind === "assistant",
  );
  expect(assistantEvents[0]).toMatchObject({
    text: "I will update the door before narrating the result.",
    responseKind: "tool_step",
    committedHead: "commit:2",
  });
  expect(assistantEvents[1]).toMatchObject({
    text: "Alex opens the door and gestures for you to go first.",
    responseKind: "narrative",
    committedHead: "commit:3",
  });
  const patchResult = first.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "tool_result" }
    > => event.kind === "tool_result" && event.callId === "patch-door",
  );
  expect(patchResult?.markdown).toBe("");
  const patchDetail = await worlds.playTimeline.readDetail(
    worldId,
    first.chainId,
    patchResult!.id,
  );
  expect(patchDetail).toMatchObject({
    kind: "tool_result",
    markdown:
      "@current-situation write succeeded\nIf a fresh context started now: full body",
  });
  if (patchDetail.kind !== "tool_result")
    throw new Error("Expected a tool-result timeline detail");
  expect(patchDetail.markdown).not.toContain("Alex守在宿舍门边。");
  expect(patchDetail.markdown).not.toContain("Alex已经把宿舍门打开。");
  expect(modelHost.requests[1]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "patch-door",
    markdown: patchDetail.markdown,
  });
  expect(modelHost.requests[1]?.appended.at(-2)).toMatchObject({
    kind: "assistant",
    text: "I will update the door before narrating the result.",
    toolCalls: [
      expect.objectContaining({ id: "patch-door", name: "world_patch" }),
    ],
    providerState: { protocol: "chat_completions" },
  });
  expect(modelHost.requests[0]?.tools.map(({ name }) => name)).toEqual([
    "state_list",
    "history_list",
    "context_search",
    "context_read",
    "world_patch",
    "world_create",
    "world_retire",
  ]);
  expect(modelHost.requests[0]?.maxOutputTokens).toBe(
    modelBinding().maxOutputTokens,
  );
  expect(modelHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "I signal Alex to open the door." },
  ]);
  expect(
    modelHost.requests[0]?.bootstrap.logicalMessages.some(
      ({ role }) => role === "player_input",
    ),
  ).toBe(false);
  expect(JSON.stringify(modelHost.requests[0]?.bootstrap)).not.toContain(
    "门外传来三声短促的铃响。",
  );
  expect(JSON.stringify(modelHost.requests[0]?.bootstrap)).toContain(
    "this world has no earlier player input or host narrative",
  );
  const authorPrompt = modelHost.requests[0]?.bootstrap.logicalMessages
    .filter(({ role }) => role === "author_instruction")
    .map(({ markdown }) => markdown)
    .join("\n");
  // The play narrative block enters bootstrap as an ordinary author instruction.
  expect(authorPrompt).toContain(
    "Make the final sentence a specific action someone takes",
  );
  expect(
    modelHost.requests[0]?.bootstrap.logicalMessages
      .filter(({ role }) => role === "runtime_system")
      .map(({ markdown }) => markdown)
      .join("\n"),
  ).toContain("A response that calls any tool is an intermediate step");

  const continued = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-second",
    playerText: "I walk into the corridor.",
    modelHost,
  });

  expect(continued).toMatchObject({ status: "ready", parentHead: "commit:5" });
  expect(modelHost.requests.at(-1)?.appended.at(-1)).toEqual({
    kind: "player",
    text: "I walk into the corridor.",
  });
  const requestCount = modelHost.requests.length;
  const duplicateAppend = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-second",
    playerText: "I walk into the corridor.",
    modelHost,
  });
  expect(duplicateAppend.parentHead).toBe("commit:5");
  expect(modelHost.requests).toHaveLength(requestCount);
  expect(await worlds.currentHead(worldId)).toBe("commit:5");
  const endpoint = await worlds.recoverEndpoint(worldId);
  expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
    "门外传来三声短促的铃响。\n",
    "I signal Alex to open the door.",
    "Alex opens the door and gestures for you to go first.",
    "I walk into the corridor.",
    "The corridor lights come on one by one with each step.",
  ]);
  expect(endpoint.history.map(({ exactText }) => exactText)).not.toContain(
    "I will update the door before narrating the result.",
  );
  expect(
    endpoint.state.find(({ path }) => path === "current-situation.yaml")
      ?.contents,
  ).toContain("Alex已经把宿舍门打开。");
});

test("已提交写入回执报告下次真实目录覆盖并回显更新后的摘要", async () => {
  const files = worldFiles();
  files.find(({ path }) => path === "control/frame.yaml")!.contents +=
    "  - slot: { kind: catalog, directory: records, maxEntries: 1 }\n";
  files.push({
    path: "world/records/ledger.yaml",
    contents:
      "$document:\n  id: ledger\n  ref: ledger\n  title: 账本\n  summary: 旧摘要\n  aliases: []\n金币: 10\n",
  });
  const { worlds, worldId } = await createWorld("write-coverage", files);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          { id: "read", name: "context_read", arguments: { ref: "@ledger" } },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "write",
            name: "world_patch",
            arguments: {
              target: "@ledger",
              edits: [
                { op: "replace", locator: { yaml: ["金币"] }, value: 8 },
                { op: "set_metadata", summary: "当前金币与未结清借款" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "你付了两枚金币。" },
    ],
  });
  const first = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "write-coverage",
    exchangeId: "first",
    playerText: "付两枚金币。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  const receipt = modelHost.requests[2]!.appended.at(-1);
  expect(receipt).toMatchObject({ kind: "tool", toolCallId: "write" });
  if (receipt?.kind !== "tool")
    throw new Error("Missing committed write receipt");
  expect(receipt.markdown).toContain("@ledger write succeeded");
  expect(receipt.markdown).toContain(
    "If a fresh context started now: catalog summary only",
  );
  expect(receipt.markdown).toContain("Summary: 当前金币与未结清借款");
  expect(receipt.markdown).not.toContain("金币: 8");
  const event = first.events.find(
    (item) => item.kind === "tool_result" && item.callId === "write",
  );
  const persisted = await worlds.playTimeline.readDetail(
    worldId,
    first.chainId,
    event!.id,
  );
  expect(persisted).toMatchObject({ markdown: receipt.markdown });
});

test("AI 读取证据返回冻结 bootstrap、已结算全文读取与下一次真实 Prompt Preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-play-reading-"));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const packageFiles = worldFiles().map((file) =>
    file.path === "control/frame.yaml"
      ? {
          ...file,
          contents: file.contents.replace(
            "  - slot: { kind: additional_materials }",
            "  - slot: { kind: catalog, directory: locations, maxEntries: 24 }\n  - slot: { kind: additional_materials }",
          ),
        }
      : file,
  );
  packageFiles.push({
    path: "world/locations/dorm-404.yaml",
    contents: `$document:
  id: location.dorm-404
  ref: dorm-404
  title: 404 宿舍
  summary: Alex 与玩家当前居住的宿舍。
  aliases: []
设施:
  独立卫生间: true
  独立淋浴间: true
`,
  });
  const created = await worlds.createFromContentPackage({
    operationId: "create-play-reading-world",
    sourcePackageId: "play-reading-package",
    sourcePackageTitle: "Play reading package",
    packageFiles,
    prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  const worldId = created.world.worldId;
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "I will read the dormitory record before describing the scene.",
        toolCalls: [
          {
            id: "read-dorm-room",
            name: "context_read",
            arguments: { ref: "@dorm-404" },
          },
        ],
      },
      {
        outcome: "response",
        text: "You wash up in the dormitory's private bathroom.",
      },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const completed = await chains.start({
    worldId,
    chainId: "play-reading-chain",
    exchangeId: "play-reading-exchange",
    playerText: "I wash up before bed.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  const direct = await chains.inspectReading(worldId, completed.parentHead);
  expect(direct?.bootstrap).toEqual({
    logicalMessages: modelHost.requests[0]!.bootstrap.logicalMessages,
    coverage: modelHost.requests[0]!.bootstrap.coverage,
  });
  expect(JSON.stringify(direct?.bootstrap)).not.toContain("独立淋浴间");
  expect(direct?.bootstrap.coverage).toContainEqual(
    expect.objectContaining({ catalogEntries: ["dorm-404"] }),
  );
  const dormRead = direct?.reads.find(
    ({ callId }) => callId === "read-dorm-room",
  );
  expect(dormRead).toMatchObject({
    ref: "@dorm-404",
    ok: true,
    complete: true,
    locator: null,
  });
  expect(dormRead?.markdown).toContain("独立淋浴间");

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  await runtime.handle({
    type: "model.save",
    connection: {
      name: "Audit model",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "audit-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_000,
    },
  });
  const reading = (
    await runtime.handle({ type: "world.play-context.read", worldId })
  ).result as V1PlayContextReadingView;
  expect(reading.currentContext?.bootstrap).toEqual(direct?.bootstrap);
  expect(reading.currentContext?.reads).toEqual(direct?.reads);
  expect(reading.nextFreshContext).toMatchObject({
    head: completed.parentHead,
    preview: { diagnosticBinding: { modelId: "audit-model" } },
  });
  expect(reading.nextFreshContext?.preview.compilation.coverage).toContainEqual(
    expect.objectContaining({ catalogEntries: ["dorm-404"] }),
  );
});

test("world_patch no-op 保留匹配的紧凑工具结果且不推进世界", async () => {
  const { worlds, worldId } = await createWorld("play-chain-patch-no-op");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-same-situation",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "Alex守在宿舍门边。",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "Alex remains by the door." },
    ],
  });

  const view = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-patch-no-op-contract",
    exchangeId: "play-chain-patch-no-op-exchange",
    playerText: "I look at Alex.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.parentHead).toBe("commit:2");
  expect(
    view.events.find(
      (event) => event.kind === "assistant" && event.exchange === 1,
    ),
  ).not.toHaveProperty("committedHead");
  const patchResult = view.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "tool_result" }
    > =>
      event.kind === "tool_result" && event.callId === "patch-same-situation",
  );
  expect(patchResult?.markdown).toBe("");
  const patchDetail = await worlds.playTimeline.readDetail(
    worldId,
    view.chainId,
    patchResult!.id,
  );
  expect(patchDetail).toMatchObject({
    kind: "tool_result",
    markdown:
      "@current-situation unchanged\nIf a fresh context started now: full body",
  });
  if (patchDetail.kind !== "tool_result")
    throw new Error("Expected a tool-result timeline detail");
  expect(modelHost.requests[1]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "patch-same-situation",
    markdown: patchDetail.markdown,
  });
});

test("world_retire 提交退役状态并让后续全新上下文停止注入 catalog 条目", async () => {
  const packageFiles = [
    ...worldFiles().map((file) =>
      file.path === "control/frame.yaml"
        ? {
            ...file,
            contents: file.contents.replace(
              "context:\n",
              "context:\n  - slot: { kind: catalog, directory: characters, maxEntries: 24, required: false }\n",
            ),
          }
        : file,
    ),
    {
      path: "world/characters/veteran.yaml",
      contents: `$document:
  id: character.veteran
  ref: veteran
  title: 退役守卫
  summary: 已经离开当前舞台的旧城守卫。
  aliases: []
经历:
  - 守卫北门
  - 离开城镇
`,
    },
  ];
  const { worlds, worldId } = await createWorld(
    "play-chain-retire-document",
    packageFiles,
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-veteran-before-retire",
            name: "context_read",
            arguments: { ref: "@veteran", maxBytes: 8192 },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "retire-veteran",
            name: "world_retire",
            arguments: { target: "@veteran", retired: true },
          },
        ],
      },
      { outcome: "response", text: "The old guard leaves the active stage." },
    ],
  });

  const retired = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-retire-document-contract",
    exchangeId: "play-chain-retire-document-player",
    playerText: "Let the old guard depart.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(retired.changedDocuments).toContainEqual({
    kind: "replace",
    ref: "@veteran",
    path: "characters/veteran.yaml",
  });
  const endpoint = await worlds.recoverEndpoint(worldId);
  const stored = endpoint.state.find(
    ({ path }) => path === "characters/veteran.yaml",
  )?.contents;
  expect(stored).toContain("retired: true");
  expect(stored).toContain("守卫北门");

  const freshHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The square is quiet now." }],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-after-retirement-contract",
    exchangeId: "play-chain-after-retirement-player",
    playerText: "I look across the square.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: freshHost,
  });
  expect(
    JSON.stringify(freshHost.requests[0]?.bootstrap.logicalMessages),
  ).not.toContain("退役守卫 [ref: @veteran]");
});

test("游玩调用链可在 frame 声明的空 catalog 中创建首份文档", async () => {
  const packageFiles = worldFiles().map((file) =>
    file.path === "control/frame.yaml"
      ? {
          ...file,
          contents: file.contents.replace(
            "  - slot: { kind: history, recent: 2 }",
            `  - slot: { kind: catalog, directory: items, maxEntries: 24, required: false }
  - slot: { kind: history, recent: 2 }`,
          ),
        }
      : file,
  );
  const { worlds, worldId } = await createWorld(
    "play-chain-empty-declared-catalog",
    packageFiles,
  );
  const firstHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "list-empty-items",
            name: "state_list",
            arguments: { parent: "@dir-/" },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-first-item",
            name: "world_create",
            arguments: {
              parent: "@dir-/items",
              codec: "yaml",
              refHint: "lantern",
              title: "提灯",
              summary: "一盏可持续追踪的提灯。",
              aliases: [],
              body: "状态: 完好\n",
            },
          },
        ],
      },
      { outcome: "response", text: "The lantern is now part of the world." },
    ],
  });
  const chains = new PlayCallChain(worlds);

  const completed = await chains.start({
    worldId,
    chainId: "play-chain-empty-declared-catalog",
    exchangeId: "play-chain-empty-declared-catalog-player",
    playerText: "Create a lantern.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: firstHost,
  });

  expect(completed.status).toBe("ready");
  const listResult = firstHost.requests[1]?.appended.at(-1);
  expect(listResult).toMatchObject({
    kind: "tool",
    toolCallId: "list-empty-items",
  });
  expect(listResult?.kind === "tool" ? listResult.markdown : "").toContain(
    "Directory @dir-/items",
  );
  expect(firstHost.requests[2]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "create-first-item",
    markdown:
      "@lantern write succeeded\nIf a fresh context started now: catalog summary only\nSummary: 一盏可持续追踪的提灯。",
  });
  expect(
    (await worlds.recoverEndpoint(worldId)).state.find(
      ({ path }) => path === "items/lantern.yaml",
    )?.contents,
  ).toContain("状态: 完好");

  const freshHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The lantern remains indexed." }],
  });
  await chains.start({
    worldId,
    chainId: "play-chain-after-first-catalog-document",
    exchangeId: "play-chain-after-first-catalog-document-player",
    playerText: "Inspect the lantern.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: freshHost,
  });
  expect(
    freshHost.requests[0]?.bootstrap.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown,
  ).toContain("提灯 [ref: @lantern] — 一盏可持续追踪的提灯。");
});

test("冷启动恢复 world_create 授予的写权限，后续无需重新读取即可 patch", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-create-authorization-cold-recovery",
  );
  const interruptedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-cold-character",
            name: "world_create",
            arguments: {
              parent: "@dir-/",
              codec: "yaml",
              refHint: "cold-character",
              title: "冷启动角色",
              summary: "用于验证创建后写授权。",
              aliases: [],
              body: "状态: 初始\n",
            },
          },
        ],
      },
      { outcome: "failure", message: "创建后的下一次模型请求被拒绝。" },
    ],
  });

  const interrupted = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-create-authorization-cold-recovery",
    exchangeId: "play-chain-create-authorization-cold-recovery-player",
    playerText: "Record a new character.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: interruptedHost,
  });
  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:2",
  });
  expect(interruptedHost.requests[1]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "create-cold-character",
    markdown:
      "@cold-character write succeeded\nIf a fresh context started now: not directly injected; read on demand",
  });

  const recoveredHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-cold-character",
            name: "world_patch",
            arguments: {
              target: "@cold-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "冷启动后已更新",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "The new character record has been updated.",
      },
    ],
  });
  const recovered = await new PlayCallChain(worlds).append({
    worldId,
    chainId: interrupted.chainId,
    exchangeId: "play-chain-create-authorization-cold-recovery-resume",
    playerText: "",
    modelHost: recoveredHost,
  });

  expect(recovered.status).toBe("ready");
  expect(recovered.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "patch-cold-character",
      ok: true,
    }),
  );
  expect(
    (await worlds.recoverEndpoint(worldId)).state.find(
      ({ path }) => path === "cold-character.yaml",
    )?.contents,
  ).toContain("状态: 冷启动后已更新");
});

test("当前格式不会双读旁路遗留累计调用链文件", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-legacy-authorization-recovery",
  );
  await writeFile(
    join(
      root,
      "worlds-file-native",
      worldId,
      "runtime",
      "play-call-chain.json",
    ),
    `${JSON.stringify({ schemaVersion: 1, kind: "play_call_chain", worldId })}\n`,
  );
  await expect(
    new PlayCallChain(worlds).inspectWorld(worldId),
  ).resolves.toBeNull();
});

test("派生世界恢复所选分叉点的文档写授权，不携带分叉点之后的状态", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-create-authorization-derived",
  );
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-derived-character",
            name: "world_create",
            arguments: {
              parent: "@dir-/",
              codec: "yaml",
              refHint: "derived-character",
              title: "派生角色",
              summary: "用于验证分叉点写授权。",
              aliases: [],
              body: "状态: 初始\n",
            },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-source-derived-character",
            name: "world_patch",
            arguments: {
              target: "@derived-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "来源世界后续状态",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "The source world continues forward." },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  const source = await sourceChains.start({
    worldId,
    chainId: "play-chain-create-authorization-derived-source",
    exchangeId: "play-chain-create-authorization-derived-player",
    playerText: "Create a record that can be forked.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const createHead = source.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "assistant" }
    > => event.kind === "assistant" && event.exchange === 1,
  )?.committedHead;
  expect(createHead).toBe("commit:2");
  expect(
    (await worlds.recoverEndpoint(worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).toContain("状态: 来源世界后续状态");

  const derived = await worlds.deriveWorld({
    operationId: "derive-create-authorization-at-create-head",
    sourceWorldId: worldId,
    sourceHead: createHead!,
    hostPresetId: "play-chain-host",
  });
  const derivedTrace = await sourceChains.forkToDerivedWorld({
    sourceWorldId: worldId,
    sourceHead: createHead!,
    targetWorldId: derived.world.worldId,
  });
  expect(derivedTrace).not.toBeNull();

  const derivedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-derived-branch-character",
            name: "world_patch",
            arguments: {
              target: "@derived-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "派生世界独立状态",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "The derived world continues from the branch point.",
      },
    ],
  });
  const continued = await new PlayCallChain(worlds).append({
    worldId: derived.world.worldId,
    chainId: derivedTrace!.chainId,
    exchangeId: "patch-derived-branch-with-restored-authorization",
    playerText: "",
    modelHost: derivedHost,
  });

  expect(continued.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "patch-derived-branch-character",
      ok: true,
    }),
  );
  expect(
    (await worlds.recoverEndpoint(derived.world.worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).toContain("状态: 派生世界独立状态");
  expect(
    (await worlds.recoverEndpoint(derived.world.worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).not.toContain("来源世界后续状态");
});

test("全新上下文只重建模型上下文，持久保留此前调用轨迹并允许从旧节点派生", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-fresh-display-history",
  );
  const firstHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "Earlier-context reasoning.",
        toolCalls: [
          {
            id: "old-context-list",
            name: "state_list",
            arguments: {},
          },
        ],
      },
      {
        outcome: "response",
        text: "Visible narrative from the earlier context.",
      },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "play-chain-old-context",
    exchangeId: "exchange-old-context",
    playerText: "Player input for the old context.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: firstHost,
  });
  const sourceHead = first.parentHead;

  const secondHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Visible narrative from the new context." },
    ],
  });
  const second = await chains.start({
    worldId,
    chainId: "play-chain-new-context",
    exchangeId: "exchange-new-context",
    playerText: "Player input for the new context.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: secondHost,
  });
  const withHistory = second;

  expect(secondHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "Player input for the new context." },
  ]);
  expect(withHistory.previousContexts).toEqual([]);
  const timeline = await worlds.playTimeline.readPage(worldId, 100);
  expect(
    timeline.items.filter(({ kind }) => kind === "context_boundary"),
  ).toHaveLength(2);
  expect(
    timeline.items.some(
      (item) =>
        item.kind === "event" &&
        item.event.kind === "assistant" &&
        item.event.hasReasoning,
    ),
  ).toBe(true);
  expect(
    timeline.items.some(
      (item) =>
        item.kind === "event" &&
        item.event.kind === "tool_call" &&
        item.event.name === "state_list",
    ),
  ).toBe(true);
  const reasoningSummary = timeline.items.find(
    (item) =>
      item.kind === "event" &&
      item.event.kind === "assistant" &&
      item.event.hasReasoning,
  );
  expect(reasoningSummary?.kind).toBe("event");
  if (reasoningSummary?.kind === "event")
    await expect(
      worlds.playTimeline.readDetail(
        worldId,
        reasoningSummary.chainId,
        reasoningSummary.event.id,
      ),
    ).resolves.toMatchObject({ reasoning: "Earlier-context reasoning." });

  expect(
    await readdir(
      join(root, "worlds-file-native", worldId, "runtime", "play-contexts"),
    ),
  ).toHaveLength(2);
  await expect(
    readFile(
      join(
        root,
        "worlds-file-native",
        worldId,
        "runtime",
        "play-call-chain.json",
      ),
      "utf8",
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const cold = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(cold?.previousContexts).toEqual([]);

  expect(
    timeline.items.some(
      (item) =>
        item.kind === "event" &&
        item.event.kind === "tool_result" &&
        item.event.name === "state_list",
    ),
  ).toBe(true);

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const branch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-from-previous-fresh-context",
      sourceWorldId: worldId,
      sourceHead,
    })
  ).result as { world: { worldId: string } };
  const branchTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: branch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  const branchReasoningSummary = branchTrace?.events.find(
    (event) => event.kind === "assistant" && event.exchange === 1,
  );
  expect(branchReasoningSummary).not.toHaveProperty("reasoning");
  await expect(
    worlds.playTimeline.readDetail(
      branch.world.worldId,
      branchTrace!.chainId,
      branchReasoningSummary!.id,
    ),
  ).resolves.toMatchObject({ reasoning: "Earlier-context reasoning." });
  expect(branchTrace?.events).toContainEqual(
    expect.objectContaining({ kind: "tool_call", name: "state_list" }),
  );
  if (process.platform === "linux") {
    const contextRoot = (targetWorldId: string, chainId: string) =>
      join(
        root,
        "worlds-file-native",
        targetWorldId,
        "runtime",
        "play-contexts",
        createHash("sha256").update(chainId).digest("hex"),
      );
    const sourceContextRoot = contextRoot(worldId, "play-chain-old-context");
    const targetContextRoot = contextRoot(
      branch.world.worldId,
      branchTrace!.chainId,
    );
    const sourceTranscript = join(
      sourceContextRoot,
      "transcript",
      "0000000001.json",
    );
    const targetTranscript = join(
      targetContextRoot,
      "transcript",
      "0000000001.json",
    );
    expect((await stat(targetTranscript)).ino).toBe(
      (await stat(sourceTranscript)).ino,
    );
    const sourceEvent = join(sourceContextRoot, "events", "0000000001.json");
    const targetEvent = join(targetContextRoot, "events", "0000000001.json");
    expect((await stat(targetEvent)).ino).not.toBe(
      (await stat(sourceEvent)).ino,
    );
    const sourceEventBytes = await readFile(sourceEvent, "utf8");
    await writeFile(targetEvent, `${await readFile(targetEvent, "utf8")} `);
    await expect(readFile(sourceEvent, "utf8")).resolves.toBe(sourceEventBytes);
  }

  const fullBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-with-previous-fresh-context",
      sourceWorldId: worldId,
      sourceHead: second.parentHead,
    })
  ).result as { world: { worldId: string } };
  const fullBranchTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: fullBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(fullBranchTrace?.previousContexts).toEqual([]);
  const fullBranchTimeline = await worlds.playTimeline.readPage(
    fullBranch.world.worldId,
    100,
  );
  const committedHeads = (items: typeof fullBranchTimeline.items) =>
    items.flatMap((item) =>
      item.kind === "event" &&
      (item.event.kind === "player" || item.event.kind === "assistant")
        ? [item.event.committedHead]
        : [],
    );
  expect(committedHeads(fullBranchTimeline.items)).toEqual(
    committedHeads(timeline.items),
  );
  await rm(join(root, "worlds-file-native", worldId), {
    recursive: true,
    force: true,
  });
  const coldWorlds = new FileNativeWorldStore(root);
  const coldChains = new PlayCallChain(coldWorlds);
  const coldBranch = await coldChains.inspectWorld(fullBranch.world.worldId);
  expect(coldBranch?.parentHead).toBe(second.parentHead);
  const continued = await coldChains.append({
    worldId: fullBranch.world.worldId,
    chainId: coldBranch!.chainId,
    exchangeId: "continue-after-source-delete",
    playerText: "Continue independently.",
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "The fork continues." }],
    }),
  });
  expect(continued.parentHead).not.toBe(second.parentHead);
  const oldPlayer = coldBranch!.events.find(
    (event) => event.kind === "player" && event.committedHead !== undefined,
  );
  if (oldPlayer?.kind !== "player") throw new Error("missing old player node");
  const revised = await coldChains.revisePlayer({
    operationId: "revise-after-source-delete",
    worldId: fullBranch.world.worldId,
    chainId: continued.chainId,
    eventId: oldPlayer.id,
    replacementExchangeId: "revised-after-source-delete",
    replacementText: "Continue independently, but more carefully.",
    continuation: "continue_context",
  });
  const child = await coldChains.deriveWorld({
    operationId: "fork-again-after-source-delete",
    sourceWorldId: fullBranch.world.worldId,
    sourceHead: revised.playCallChain.parentHead,
    hostPresetId: "host-current",
  });
  await expect(coldWorlds.currentHead(child.world.worldId)).resolves.toBe(
    revised.playCallChain.parentHead,
  );
  await expect(
    coldChains.inspectWorld(child.world.worldId),
  ).resolves.toMatchObject({
    worldId: child.world.worldId,
    parentHead: revised.playCallChain.parentHead,
  });
});

test("从调用链节点派生会保留截至该节点的调用轨迹，并可在玩家节点空输入重新生成", async () => {
  const { worlds, worldId, root } = await createWorld("play-chain-derive");
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "First confirm the dormitory door's current state.",
        toolCalls: [
          {
            id: "patch-derived-door",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "Alex已经把宿舍门打开。",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "Alex opens the door and gestures for you to go first.",
        reasoningContent:
          "The state is updated; now provide visible narrative.",
      },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  const source = await sourceChains.start({
    worldId,
    chainId: "play-chain-derive-source",
    exchangeId: "exchange-source-player",
    playerText: "I signal Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const playerHead = source.events.find(
    (event) => event.kind === "player",
  )?.committedHead;
  expect(playerHead).toBe("commit:1");

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const completedBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-completed-call-chain",
      sourceWorldId: worldId,
      sourceHead: source.parentHead,
    })
  ).result as { world: { worldId: string } };
  const completedTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: completedBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;

  expect(completedTrace).toMatchObject({
    worldId: completedBranch.world.worldId,
    parentHead: source.parentHead,
    status: "ready",
  });
  expect(completedTrace?.chainId).not.toBe(source.chainId);
  const completedReasoningSummary = completedTrace?.events.find(
    (event) => event.kind === "assistant" && event.exchange === 1,
  );
  expect(completedReasoningSummary).not.toHaveProperty("reasoning");
  await expect(
    worlds.playTimeline.readDetail(
      completedBranch.world.worldId,
      completedTrace!.chainId,
      completedReasoningSummary!.id,
    ),
  ).resolves.toMatchObject({
    reasoning: "First confirm the dormitory door's current state.",
  });
  expect(completedTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_call",
      name: "world_patch",
    }),
  );
  expect(completedTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      name: "world_patch",
    }),
  );

  const toolResponseHead = source.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "assistant" }
    > => event.kind === "assistant" && event.exchange === 1,
  )?.committedHead;
  expect(toolResponseHead).toBe("commit:2");
  const toolBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-tool-call-chain",
      sourceWorldId: worldId,
      sourceHead: toolResponseHead!,
    })
  ).result as { world: { worldId: string } };
  const toolTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: toolBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(toolTrace?.events.map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool_call",
    "tool_result",
  ]);
  expect(toolTrace?.parentHead).toBe(toolResponseHead);
  expect(
    toolTrace?.events
      .filter((event) => event.kind === "player" || event.kind === "assistant")
      .map(({ committedHead }) => committedHead),
  ).toEqual(["commit:1", "commit:2"]);
  const continuedToolHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "Alex pushes the door fully open." }],
  });
  await new PlayCallChain(worlds).append({
    worldId: toolBranch.world.worldId,
    chainId: toolTrace!.chainId,
    exchangeId: "continue-derived-tool-response",
    playerText: "",
    modelHost: continuedToolHost,
  });
  expect(
    continuedToolHost.requests[0]?.appended.map(({ kind }) => kind),
  ).toEqual(["player", "assistant", "tool"]);

  const playerBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-player-call-chain",
      sourceWorldId: worldId,
      sourceHead: playerHead!,
    })
  ).result as { world: { worldId: string } };
  const playerTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: playerBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(playerTrace).toMatchObject({
    worldId: playerBranch.world.worldId,
    parentHead: playerHead,
    status: "ready",
    events: [
      expect.objectContaining({
        kind: "player",
        text: "I signal Alex to open the door.",
        committedHead: playerHead,
      }),
    ],
  });
  expect(playerTrace?.events).toHaveLength(1);
  const persistedPlayerBranch = await worlds.playTimeline.readCurrent(
    playerBranch.world.worldId,
  );
  expect(persistedPlayerBranch?.value).not.toHaveProperty("derivedFrom");
  expect(persistedPlayerBranch?.value).not.toHaveProperty(
    "branchedBeforePlayer",
  );
  expect(
    await readUtf8Tree(
      join(root, "worlds-file-native", playerBranch.world.worldId),
    ),
  ).not.toContain(worldId);

  await rm(join(root, "worlds-file-native", worldId), {
    recursive: true,
    force: true,
  });
  const coldWorlds = new FileNativeWorldStore(root);

  const regeneratedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "After reconsidering, Alex pulls the door open.",
      },
    ],
  });
  const regenerated = await new PlayCallChain(coldWorlds).append({
    worldId: playerBranch.world.worldId,
    chainId: playerTrace!.chainId,
    exchangeId: "regenerate-from-player",
    playerText: "",
    modelHost: regeneratedHost,
  });
  expect(regenerated.status).toBe("ready");
  expect(regeneratedHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "I signal Alex to open the door." },
  ]);
  expect(
    (await coldWorlds.recoverEndpoint(playerBranch.world.worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I signal Alex to open the door.",
    "After reconsidering, Alex pulls the door open.",
  ]);
  await runtime.handle({
    type: "world.derive",
    operationId: "derive-player-call-chain",
    sourceWorldId: worldId,
    sourceHead: playerHead!,
  });
  expect(await coldWorlds.currentHead(playerBranch.world.worldId)).toBe(
    "commit:2",
  );
});

test.each([
  {
    label: "reflink",
    key: "reflink",
    strategy: "reflink",
    reflinkErrorCode: undefined,
  },
  {
    label: "copy",
    key: "copy",
    strategy: "copy",
    reflinkErrorCode: undefined,
  },
  {
    label: "macOS ENOSYS 回退",
    key: "reflink-enosys",
    strategy: "reflink",
    reflinkErrorCode: "ENOSYS",
  },
] as const)(
  "页面／模型轨迹物理闭包支持 $label 路径且不会重放 Provider 或工具",
  async ({ key, strategy, reflinkErrorCode }) => {
    process.env.NARRAEON_INTERNAL_TEST_CLONE_STRATEGY = strategy;
    if (reflinkErrorCode !== undefined)
      process.env.NARRAEON_INTERNAL_TEST_REFLINK_ERROR_CODE = reflinkErrorCode;
    const { worlds, worldId, root } = await createWorld(
      `play-chain-trace-${key}`,
    );
    const host = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          reasoningContent: `Inspect state before the ${key} fork.`,
          toolCalls: [
            { id: `state-${key}`, name: "state_list", arguments: {} },
          ],
        },
        { outcome: "response", text: `The ${key} trace is sealed.` },
      ],
    });
    const chains = new PlayCallChain(worlds);
    const source = await chains.start({
      worldId,
      chainId: `trace-${key}-source`,
      exchangeId: `trace-${key}-exchange`,
      playerText: `Create a ${key} trace.`,
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: host,
    });
    const requestCount = host.requests.length;
    const derived = await chains.deriveWorld({
      operationId: `trace-${key}-fork`,
      sourceWorldId: worldId,
      sourceHead: source.parentHead,
      hostPresetId: "host-current",
    });
    expect(host.requests).toHaveLength(requestCount);
    const target = await chains.inspectWorld(derived.world.worldId);
    expect(target).toMatchObject({
      worldId: derived.world.worldId,
      parentHead: source.parentHead,
    });

    const contextRoot = (targetWorldId: string, chainId: string) =>
      join(
        root,
        "worlds-file-native",
        targetWorldId,
        "runtime",
        "play-contexts",
        createHash("sha256").update(chainId).digest("hex"),
      );
    const sourceRoot = contextRoot(worldId, source.chainId);
    const targetRoot = contextRoot(derived.world.worldId, target!.chainId);
    for (const relative of [
      "events/0000000001.json",
      "transcript/0000000001.json",
      "completed-tools/0000000001.json",
    ]) {
      const sourcePath = join(sourceRoot, relative);
      const targetPath = join(targetRoot, relative);
      await expect(readFile(targetPath)).resolves.toEqual(
        await readFile(sourcePath),
      );
      if (process.platform === "linux")
        expect((await stat(targetPath)).ino).not.toBe(
          (await stat(sourcePath)).ino,
        );
    }
  },
);

test("修改历史玩家提交会在同一世界追加时间线修订，并从修改稿继续调用链", async () => {
  const { worlds, worldId, root } = await createWorld("play-chain-edit-player");
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex says to meet downstairs at eight." },
      {
        outcome: "response",
        text: "Alex nods and says he will arrive five minutes early.",
      },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  await sourceChains.start({
    worldId,
    chainId: "play-chain-edit-source",
    exchangeId: "exchange-edit-first",
    playerText: "I ask Alex when we are meeting.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const source = await sourceChains.append({
    worldId,
    chainId: "play-chain-edit-source",
    exchangeId: "exchange-edit-second",
    playerText: "Then I will go downstairs five minutes early.",
    modelHost: sourceHost,
  });
  const editedEvent = source.events.find(
    (event) =>
      event.kind === "player" && event.exchangeId === "exchange-edit-second",
  );
  expect(editedEvent).toMatchObject({ committedHead: "commit:3" });

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const revisionRequest = {
    type: "play.chain.revise-player" as const,
    operationId: "revise-edited-player",
    worldId,
    chainId: source.chainId,
    eventId: editedEvent!.id,
    replacementExchangeId: "exchange-edited-replacement",
    replacementText: "Then let's meet fifteen minutes early.",
    continuation: "continue_context" as const,
  };
  const revised = (await runtime.handle(revisionRequest)).result as {
    outcome: "revised";
    worldId: string;
    playCallChain: V1PlayCallChainView;
  };

  expect(revised).toMatchObject({ outcome: "revised", worldId });
  expect(revised.playCallChain).toMatchObject({
    worldId,
    parentHead: "commit:5",
    status: "ready",
  });
  expect(revised.playCallChain.chainId).not.toBe(source.chainId);
  expect(
    revised.playCallChain.events
      .filter((event) => event.kind === "player")
      .map(({ committedHead }) => committedHead),
  ).toEqual(["commit:1", "commit:5"]);
  expect(
    revised.playCallChain.events
      .filter((event) => event.kind === "player")
      .map(({ text }) => text),
  ).toEqual([
    "I ask Alex when we are meeting.",
    "Then let's meet fifteen minutes early.",
  ]);
  expect(
    revised.playCallChain.events.some(
      (event) =>
        (event.kind === "player" || event.kind === "assistant") &&
        (event.text === "Then I will go downstairs five minutes early." ||
          event.text ===
            "Alex nods and says he will arrive five minutes early."),
    ),
  ).toBe(false);
  await expect(runtime.handle(revisionRequest)).resolves.toMatchObject({
    result: {
      outcome: "revised",
      worldId,
      playCallChain: { parentHead: "commit:5" },
    },
  });

  const replacementHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "Alex agrees to wait downstairs at seven forty-five.",
      },
    ],
  });
  await new PlayCallChain(worlds).append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: "dispatch-after-edited-replacement",
    playerText: "",
    modelHost: replacementHost,
  });

  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I ask Alex when we are meeting.",
    "Alex says to meet downstairs at eight.",
    "Then let's meet fifteen minutes early.",
    "Alex agrees to wait downstairs at seven forty-five.",
  ]);
  expect(
    (await worlds.recoverEndpoint(worldId, "commit:4")).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I ask Alex when we are meeting.",
    "Alex says to meet downstairs at eight.",
    "Then I will go downstairs five minutes early.",
    "Alex nods and says he will arrive five minutes early.",
  ]);
  expect(replacementHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "I ask Alex when we are meeting." },
    {
      kind: "assistant",
      text: "Alex says to meet downstairs at eight.",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: {
          role: "assistant",
          content: "Alex says to meet downstairs at eight.",
        },
      },
      toolCalls: [],
    },
    { kind: "player", text: "Then let's meet fifteen minutes early." },
  ]);
  const authority = await worlds.readAuthorityHistory(worldId);
  expect(authority.commits).toHaveLength(6);
  expect(authority.commits[4]).toMatchObject({
    mode: "timeline_revision",
    auditParent: { head: "commit:4" },
    timelineParent: { head: "commit:2" },
    head: "commit:5",
    timelineRevision: {
      restoresHead: "commit:2",
      replacesHead: "commit:3",
    },
  });
});

test("修改第一条玩家消息可把修改稿保存为不继承旧续传的全新上下文", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-edit-first-as-fresh",
  );
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The old response is discarded." }],
  });
  const source = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-edit-first-source",
    exchangeId: "exchange-edit-first-source",
    playerText: "I take the eastern path.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const selected = source.events.find(
    (event) => event.kind === "player" && event.context === "fresh",
  );
  if (selected?.kind !== "player") throw new Error("missing first player");

  const basePath = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    createHash("sha256").update(source.chainId).digest("hex"),
    "base.json",
  );
  const legacyBase = JSON.parse(await readFile(basePath, "utf8")) as Record<
    string,
    unknown
  >;
  delete legacyBase.modelBinding;
  await writeFile(basePath, `${JSON.stringify(legacyBase)}\n`, "utf8");

  const freshBinding = {
    ...modelBinding(),
    endpointFingerprint: "fresh-edit-endpoint",
    modelId: "fresh-edit-model",
    protocolConfigFingerprint: "fresh-edit-protocol",
  };
  const freshHost = hostBinding();
  freshHost.files["blocks/style.md"] =
    "# Fresh edit style\n\nThis bootstrap was compiled for the edited context.\n";
  const freshPreset = {
    ...playPreset(),
    name: "fresh edit preset",
    revision: "fresh-edit-preset-v1",
  };
  const chains = new PlayCallChain(worlds);
  const request = {
    operationId: "revise-first-as-fresh",
    worldId,
    chainId: source.chainId,
    eventId: selected.id,
    replacementExchangeId: "exchange-edit-first-replacement",
    replacementText: "I take the western path.",
    continuation: "fresh_context" as const,
    freshContext: {
      hostBinding: freshHost,
      playPreset: freshPreset,
      modelBinding: freshBinding,
    },
  };
  const revised = await chains.revisePlayer(request);

  expect(revised.playCallChain).toMatchObject({
    baselineHead: "genesis",
    parentHead: "commit:3",
    playPreset: {
      name: "fresh edit preset",
      revision: "fresh-edit-preset-v1",
    },
    events: [
      {
        id: 1,
        kind: "player",
        context: "fresh",
        text: "I take the western path.",
        committedHead: "commit:3",
      },
    ],
  });
  expect(
    (await worlds.playTimeline.readPage(worldId, 100)).items.filter(
      ({ kind }) => kind === "context_boundary",
    ),
  ).toHaveLength(1);

  const replacementHost = new ScriptedModelHost({
    binding: freshBinding,
    steps: [{ outcome: "response", text: "The western path opens ahead." }],
  });
  const continued = await chains.append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: "exchange-edit-first-continue",
    playerText: "",
    modelHost: replacementHost,
  });
  expect(replacementHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "I take the western path." },
  ]);
  expect(
    replacementHost.requests[0]?.bootstrap.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n"),
  ).toContain("This bootstrap was compiled for the edited context.");
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I take the western path.",
    "The western path opens ahead.",
  ]);
  await expect(chains.revisePlayer(request)).resolves.toMatchObject({
    outcome: "revised",
    playCallChain: {
      chainId: continued.chainId,
      parentHead: continued.parentHead,
    },
  });
  await expect(
    chains.revisePlayer({
      operationId: request.operationId,
      worldId,
      chainId: source.chainId,
      eventId: selected.id,
      replacementExchangeId: request.replacementExchangeId,
      replacementText: request.replacementText,
      continuation: "continue_context",
    }),
  ).rejects.toThrow("already used by another commit");
});

test("全新上下文无法编译时不会先提交玩家消息修订", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-edit-fresh-compile-failure",
  );
  const chains = new PlayCallChain(worlds);
  const source = await chains.start({
    worldId,
    chainId: "play-chain-edit-fresh-compile-source",
    exchangeId: "exchange-edit-fresh-compile-source",
    playerText: "I take the eastern path.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "The eastern path is quiet." }],
    }),
  });
  const selected = source.events.find(
    (event) => event.kind === "player" && event.context === "fresh",
  );
  if (selected?.kind !== "player") throw new Error("missing first player");
  const authorityBefore = await worlds.readAuthorityHistory(worldId);
  const invalidHost = hostBinding();
  delete invalidHost.files["blocks/style.md"];

  await expect(
    chains.revisePlayer({
      operationId: "revise-fresh-compile-failure",
      worldId,
      chainId: source.chainId,
      eventId: selected.id,
      replacementExchangeId: "exchange-edit-fresh-compile-failure",
      replacementText: "I take the western path.",
      continuation: "fresh_context",
      freshContext: {
        hostBinding: invalidHost,
        playPreset: playPreset(),
        modelBinding: modelBinding(),
      },
    }),
  ).rejects.toThrow();

  expect(await worlds.readAuthorityHistory(worldId)).toEqual(authorityBefore);
  expect(await worlds.currentHead(worldId)).toBe(source.parentHead);
});

test("把上下文中较后的修改稿另存为全新上下文时保留页面前缀但不继承模型 transcript", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-edit-later-as-fresh",
  );
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex waits beside the eastern path." },
      { outcome: "response", text: "The abandoned continuation." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "play-chain-edit-later-source",
    exchangeId: "exchange-edit-later-first",
    playerText: "I ask Alex where the paths lead.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const source = await chains.append({
    worldId,
    chainId: "play-chain-edit-later-source",
    exchangeId: "exchange-edit-later-second",
    playerText: "I take the eastern path.",
    modelHost: sourceHost,
  });
  const selected = source.events.find(
    (event) =>
      event.kind === "player" &&
      event.exchangeId === "exchange-edit-later-second",
  );
  if (selected?.kind !== "player") throw new Error("missing later player");

  const basePath = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    createHash("sha256").update(source.chainId).digest("hex"),
    "base.json",
  );
  const legacyBase = JSON.parse(await readFile(basePath, "utf8")) as Record<
    string,
    unknown
  >;
  delete legacyBase.modelBinding;
  await writeFile(basePath, `${JSON.stringify(legacyBase)}\n`, "utf8");

  const freshBinding = {
    ...modelBinding(),
    endpointFingerprint: "later-fresh-endpoint",
    modelId: "later-fresh-model",
    protocolConfigFingerprint: "later-fresh-protocol",
  };
  const revisedChains = new PlayCallChain(worlds);
  const revised = await revisedChains.revisePlayer({
    operationId: "revise-later-as-fresh",
    worldId,
    chainId: source.chainId,
    eventId: selected.id,
    replacementExchangeId: "exchange-edit-later-replacement",
    replacementText: "I take the western path instead.",
    continuation: "fresh_context",
    freshContext: {
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: freshBinding,
    },
  });

  expect(revised.playCallChain.events).toEqual([
    expect.objectContaining({
      id: 1,
      kind: "player",
      context: "fresh",
      text: "I take the western path instead.",
      committedHead: "commit:5",
    }),
  ]);
  const page = await worlds.playTimeline.readPage(worldId, 100);
  expect(
    page.items.filter(({ kind }) => kind === "context_boundary"),
  ).toHaveLength(2);
  expect(
    page.items.flatMap((item) =>
      item.kind === "event" &&
      (item.event.kind === "player" || item.event.kind === "assistant")
        ? [item.event.text]
        : [],
    ),
  ).toEqual([
    "I ask Alex where the paths lead.",
    "Alex waits beside the eastern path.",
    "I take the western path instead.",
  ]);

  const replacementHost = new ScriptedModelHost({
    binding: freshBinding,
    steps: [{ outcome: "response", text: "Alex follows you west." }],
  });
  await revisedChains.append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: "exchange-edit-later-continue",
    playerText: "",
    modelHost: replacementHost,
  });
  expect(replacementHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "I take the western path instead." },
  ]);
});

test("Provider 结果未知时禁止重放已派发请求，并要求全新上下文", async () => {
  const { worlds, worldId } = await createWorld("play-chain-retry");
  const requests: ModelHostExchange[] = [];
  let attempt = 0;
  const modelHost: ModelHost = {
    binding: modelBinding,
    exchange(request, observer) {
      requests.push(structuredClone(request));
      attempt += 1;
      if (attempt === 1) {
        observer?.onDelta?.({
          kind: "reasoning",
          text: "First confirm whether the door can open",
        });
        observer?.onDelta?.({
          kind: "text",
          text: "Alex has pushed the door halfway open",
        });
        return Promise.reject(
          new ModelHostOutcomeUnknownError("Provider 流在半途断开。"),
        );
      }
      return Promise.resolve({
        text: "Alex pushes the door fully open, and cold corridor air rushes in.",
      });
    },
  };
  const chains = new PlayCallChain(worlds);

  const interrupted = await chains.start({
    worldId,
    chainId: "play-chain-retry-contract",
    exchangeId: "exchange-retry",
    playerText: "I ask Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:1",
    lastFailure: "Provider 流在半途断开。",
  });
  expect(interrupted.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      text: "Alex has pushed the door halfway open",
      status: "interrupted",
    }),
  );
  const interruptedAssistant = interrupted.events.find(
    (event) => event.kind === "assistant",
  );
  expect(interruptedAssistant).not.toHaveProperty("reasoning");
  await expect(
    worlds.playTimeline.readDetail(
      worldId,
      interrupted.chainId,
      interruptedAssistant!.id,
    ),
  ).resolves.toMatchObject({
    reasoning: "First confirm whether the door can open",
    status: "interrupted",
  });

  const recoveredChains = new PlayCallChain(worlds);
  const recovered = await recoveredChains.inspectWorld(worldId);
  expect(recovered).toMatchObject({
    status: "interrupted",
    canRetry: false,
  });
  expect(recovered?.events).toContainEqual(
    expect.objectContaining({ kind: "assistant", status: "interrupted" }),
  );
  await expect(
    recoveredChains.append({
      worldId,
      chainId: interrupted.chainId,
      exchangeId: "continue-without-player-input",
      playerText: "",
      modelHost,
    }),
  ).rejects.toThrow(
    "The current model context cannot continue; use a fresh context.",
  );
  expect(requests).toHaveLength(1);
  const endpoint = await worlds.recoverEndpoint(worldId);
  expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
    "门外传来三声短促的铃响。\n",
    "I ask Alex to open the door.",
  ]);
  expect(endpoint.history.map(({ exactText }) => exactText)).not.toContain(
    "Alex has pushed the door halfway open",
  );
});

test("确定性 Provider 拒绝后只重放原样保存的请求", async () => {
  const { worlds, worldId } = await createWorld("play-chain-safe-retry");
  const requests: ModelHostExchange[] = [];
  let attempt = 0;
  const modelHost: ModelHost = {
    binding: modelBinding,
    exchange(request) {
      requests.push(structuredClone(request));
      attempt += 1;
      if (attempt === 1)
        return Promise.reject(
          new ModelHostFailureError("Provider 在生成前拒绝了请求。"),
        );
      return Promise.resolve({
        text: "Alex opens the door after the retry.",
        providerState: {
          protocol: "chat_completions",
          assistantMessage: {
            role: "assistant",
            content: "Alex opens the door after the retry.",
          },
        },
      });
    },
  };
  const chains = new PlayCallChain(worlds);
  const interrupted = await chains.start({
    worldId,
    chainId: "play-chain-safe-retry-contract",
    exchangeId: "exchange-safe-retry",
    playerText: "I ask Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  expect(interrupted).toMatchObject({ status: "interrupted", canRetry: true });

  const completed = await chains.append({
    worldId,
    chainId: interrupted.chainId,
    exchangeId: "safe-retry-without-player-input",
    playerText: "",
    modelHost,
  });
  expect(completed).toMatchObject({ status: "ready", canRetry: false });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("Provider 明确报告上下文溢出时禁止重试并要求全新上下文", async () => {
  const { worlds, worldId } = await createWorld("play-chain-context-overflow");
  const requests: ModelHostExchange[] = [];
  const modelHost: ModelHost = {
    binding: modelBinding,
    exchange(request) {
      requests.push(structuredClone(request));
      return Promise.reject(
        new ModelHostFailureError("Provider request failed: 400", {
          details: {
            error: {
              code: "context_length_exceeded",
              message: "This model's maximum context length was exceeded.",
            },
          },
        }),
      );
    },
  };
  const chains = new PlayCallChain(worlds);
  const interrupted = await chains.start({
    worldId,
    chainId: "play-chain-context-overflow-contract",
    exchangeId: "exchange-context-overflow",
    playerText: "I ask Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(interrupted).toMatchObject({
    status: "interrupted",
    canRetry: false,
    lastFailure: "Provider request failed: 400",
  });
  await expect(
    chains.append({
      worldId,
      chainId: interrupted.chainId,
      exchangeId: "retry-context-overflow",
      playerText: "",
      modelHost,
    }),
  ).rejects.toThrow(
    "The current model context cannot continue; use a fresh context.",
  );
  expect(requests).toHaveLength(1);
});

test("空输入追加会从完整逻辑 transcript 继续生成，并把 Provider 文本增量实时投影", async () => {
  const { worlds, worldId } = await createWorld("play-chain-empty-continue");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "Alex opens the door first.",
        reasoningContent: "First confirm that the doorway is clear.",
        deltas: [
          { kind: "reasoning", text: "First confirm the doorway " },
          { kind: "reasoning", text: "is clear." },
          { kind: "text", text: "Alex opens " },
          { kind: "text", text: "the door first." },
        ],
      },
      { outcome: "response", text: "He then walks into the corridor." },
    ],
  });
  const deltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "play-chain-empty-continue-contract",
    exchangeId: "exchange-first",
    playerText: "I signal Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
    observer: {
      onAssistantDelta(delta) {
        if (delta.kind === "text") deltas.push(delta.text);
        if (delta.kind === "reasoning") reasoningDeltas.push(delta.text);
      },
    },
  });
  expect(deltas).toEqual(["Alex opens ", "the door first."]);

  expect(reasoningDeltas).toEqual(["First confirm the doorway ", "is clear."]);
  const firstAssistant = first.events.find(
    (event) => event.kind === "assistant",
  );
  expect(firstAssistant).not.toHaveProperty("reasoning");
  await expect(
    worlds.playTimeline.readDetail(worldId, first.chainId, firstAssistant!.id),
  ).resolves.toMatchObject({
    reasoning: "First confirm that the doorway is clear.",
  });

  const continued = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-empty",
    playerText: "",
    modelHost,
  });

  expect(continued.status).toBe("ready");
  expect(continued.events.filter(({ kind }) => kind === "player")).toHaveLength(
    1,
  );
  expect(modelHost.requests[1]?.appended).toEqual([
    { kind: "player", text: "I signal Alex to open the door." },
    {
      kind: "assistant",
      text: "Alex opens the door first.",
      reasoningContent: "First confirm that the doorway is clear.",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: {
          role: "assistant",
          content: "Alex opens the door first.",
          reasoning_content: "First confirm that the doorway is clear.",
        },
      },
      toolCalls: [],
    },
  ]);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I signal Alex to open the door.",
    "Alex opens the door first.",
    "He then walks into the corridor.",
  ]);
});

test("模型绑定的协议配置变化会在提交玩家输入前拒绝旧上下文", async () => {
  const { worlds, worldId } = await createWorld("play-binding-switch");
  const initialHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The first exchange settles." }],
  });
  const chains = new PlayCallChain(worlds);
  const initial = await chains.start({
    worldId,
    chainId: "play-binding-switch-contract",
    exchangeId: "binding-switch-first",
    playerText: "Begin with the frozen model.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: initialHost,
  });
  const switchedHost = new ScriptedModelHost({
    binding: {
      ...modelBinding(),
      protocolConfigFingerprint: "sha256:changed-reasoning-policy",
    },
    steps: [{ outcome: "response", text: "Must not be dispatched." }],
  });

  await expect(
    chains.append({
      worldId,
      chainId: initial.chainId,
      exchangeId: "binding-switch-second",
      playerText: "Continue after changing the connection.",
      modelHost: switchedHost,
    }),
  ).rejects.toThrow(
    "The selected model connection does not match the frozen model binding; start a fresh context.",
  );
  expect(switchedHost.requests).toHaveLength(0);
  expect((await worlds.recoverEndpoint(worldId)).history).toHaveLength(3);
});

test("只有 reasoning 的响应仍持久化原生续传载荷，但不会进入叙事 Authority", async () => {
  const { worlds, worldId } = await createWorld("play-reasoning-only-state");
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "Private returned reasoning.",
        stopReason: "tool_calls",
        usage: {
          inputTokens: 100,
          uncachedInputTokens: 60,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          reasoningTokens: 20,
          outputTokens: 30,
          totalTokens: 130,
          provenance: {
            inputTokens: "provider",
            uncachedInputTokens: "derived_provider_fields",
            cacheReadTokens: "provider",
            cacheWriteTokens: "provider",
            reasoningTokens: "provider",
            outputTokens: "provider",
            totalTokens: "provider",
          },
        },
      },
    ],
  });

  const view = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-reasoning-only-state-contract",
    exchangeId: "reasoning-only-first",
    playerText: "Think without narrating.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });

  expect(view).toMatchObject({ status: "interrupted", canRetry: false });
  expect((await worlds.recoverEndpoint(worldId)).history).toHaveLength(2);
  const persisted = await worlds.playTimeline.readCurrent(worldId);
  expect(persisted?.value.transcript.at(-1)).toMatchObject({
    kind: "assistant",
    text: "",
    reasoningContent: "Private returned reasoning.",
    providerState: {
      protocol: "chat_completions",
      assistantMessage: {
        role: "assistant",
        content: null,
        reasoning_content: "Private returned reasoning.",
      },
    },
  });
  expect(
    persisted?.value.events.find(({ kind }) => kind === "assistant"),
  ).toMatchObject({
    stopReason: "tool_calls",
    continuation: "available",
    usage: {
      uncachedInputTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
      provenance: { uncachedInputTokens: "derived_provider_fields" },
    },
  });
});

test("完整响应若缺失原生续传载荷会保留叙事，但立即终止当前模型上下文", async () => {
  const { worlds, worldId } = await createWorld(
    "play-missing-native-continuation",
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        continuation: "lost",
        text: "The visible scene still settles once.",
      },
    ],
  });

  const view = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-missing-native-continuation",
    exchangeId: "play-missing-native-continuation-player",
    playerText: "I look around.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });

  expect(view).toMatchObject({ status: "interrupted", canRetry: false });
  expect(view.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      text: "The visible scene still settles once.",
      continuation: "unavailable",
    }),
  );
  expect(
    view.events.some(
      (event) =>
        event.kind === "failure" &&
        event.message.includes("no provider-native continuation payload"),
    ),
  ).toBe(true);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(({ exactText }) =>
      exactText.trim(),
    ),
  ).toContain("The visible scene still settles once.");
});

test("AI 工具被 Runtime 拒绝时保存产生该调用的原始交换与 reasoning", async () => {
  const { worlds, worldId, root } = await createWorld("play-tool-failure-log");
  const logRoot = join(root, "logs", "ai-failures");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "I will patch the record before presenting the scene.",
        reasoningContent: "First patch a node that has not been read.",
        toolCalls: [
          {
            id: "invalid-world-patch",
            name: "world_patch",
            arguments: { target: "@missing", edits: [] },
          },
        ],
        diagnostics: {
          captureId: "play-tool-failure-capture-1",
          provider: "chat_completions",
          endpoint: "https://provider.invalid/v1/chat/completions",
          context: {
            scope: "play_call_chain",
            requestId: "play_call_chain",
            operationId: "play-tool-failure-log-chain",
            requestAttempt: 1,
            exchange: 1,
          },
          request: {
            method: "POST",
            contentType: "application/json",
            body: '{"messages":[{"role":"user","content":"打开门"}]}',
          },
          response: {
            status: 200,
            statusText: "OK",
            contentType: "text/event-stream",
            body: 'data: {"reasoning_content":"First patch a node that has not been read."}\n\n',
            bodyComplete: true,
          },
          reasoning: "First patch a node that has not been read.",
        },
      },
      {
        outcome: "response",
        text: "I will inspect the current record again first.",
        diagnostics: {
          captureId: "play-tool-failure-capture-2",
          provider: "chat_completions",
          endpoint: "https://provider.invalid/v1/chat/completions",
          context: {
            scope: "play_call_chain",
            requestId: "play_call_chain",
            operationId: "play-tool-failure-log-chain",
            requestAttempt: 1,
            exchange: 2,
          },
          request: {
            method: "POST",
            contentType: "application/json",
            body: '{"messages":[{"role":"tool","content":"参数错误"}]}',
          },
          response: {
            status: 200,
            statusText: "OK",
            contentType: "text/event-stream",
            body: 'data: {"content":"I will inspect the current record again first."}\n\n',
            bodyComplete: true,
          },
        },
      },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    undefined,
    new FileNativeAiFailureLog(logRoot),
  );

  const view = await chains.start({
    worldId,
    chainId: "play-tool-failure-log-chain",
    exchangeId: "play-tool-failure-log-exchange",
    playerText: "Open the door.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(view.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "invalid-world-patch",
      ok: false,
    }),
  );
  const names = (await readdir(logRoot)).filter((value) =>
    value.endsWith(".jsonl"),
  );
  expect(names).toHaveLength(1);
  const entries = (await readFile(join(logRoot, names[0]!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failure = entries.find(({ type }) => type === "failure") as {
    failures: { kind: string; details: unknown }[];
  };
  expect(failure.failures).toHaveLength(1);
  expect(failure.failures[0]?.kind).toBe("tool_execution");
  const details = failure.failures[0]?.details as {
    calls: { id: string; ok: boolean }[];
  };
  expect(details.calls).toEqual([
    expect.objectContaining({ id: "invalid-world-patch", ok: false }),
  ]);
  const exchanges = entries
    .filter(({ type }) => type === "exchange")
    .map(({ exchange }) => exchange) as {
    request: { body: string };
    reasoning?: string;
  }[];
  expect(exchanges).toHaveLength(2);
  expect(exchanges[0]?.request.body).toContain("打开门");
  expect(exchanges[0]?.reasoning).toBe(
    "First patch a node that has not been read.",
  );
  expect(exchanges[1]?.request.body).toContain("参数错误");
  expect(entries.at(-1)).toMatchObject({
    type: "resolved",
    message:
      "The play call chain recovered during a later model exchange and completed.",
  });
  expect(
    view.events.find(
      (event) => event.kind === "assistant" && event.exchange === 1,
    ),
  ).toMatchObject({
    text: "I will patch the record before presenting the scene.",
    responseKind: "tool_step",
  });
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).not.toContain("I will patch the record before presenting the scene.");
});

async function createWorld(
  label: string,
  packageFiles: ContentTreeFile[] = worldFiles(),
): Promise<{
  worlds: FileNativeWorldStore;
  worldId: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const created = await worlds.createFromContentPackage({
    operationId: `create-${label}-world`,
    sourcePackageId: `${label}-package`,
    sourcePackageTitle: `${label} package`,
    packageFiles,
    prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  return { worlds, worldId: created.world.worldId, root };
}

function playPreset(): PlayPresetBinding {
  const files = structuredClone(defaultPlayPresetFiles);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "builtin-default",
    name: "default",
    revision: "builtin-default-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function hostBinding(): FileNativePromptInput["hostBinding"] {
  return {
    hostPresetId: "play-chain-host",
    files: {
      "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
      "blocks/style.md":
        "# Host style\n\nBe restrained and specific. Do not act for the player.\n",
    },
  };
}

function modelBinding(): ModelHostBinding {
  return {
    provider: "chat_completions",
    endpointFingerprint: "play-chain-endpoint",
    modelId: "play-chain-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    protocolConfigFingerprint: "play-chain-protocol",
  };
}

function worldFiles(): ContentTreeFile[] {
  return [
    { path: "opening.md", contents: "门外传来三声短促的铃响。\n" },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 宿舍门边的局面。
  aliases: []
情况: Alex守在宿舍门边。
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World Rules\n\nWrite durable outcomes back to their natural owner.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}

test("后置请求的 Provider 派发和增量持续更新同一轮进度", async () => {
  const { worlds, root, worldId } = await createWorld(
    "play-chain-followup-progress",
  );
  const artifacts = new FileNativeArtifactStore(root);
  let dispatch = 0;
  let markFollowupStarted: (() => void) | undefined;
  const followupStarted = new Promise<void>((resolve) => {
    markFollowupStarted = resolve;
  });
  let finishFollowup: (() => void) | undefined;
  const followupRelease = new Promise<void>((resolve) => {
    finishFollowup = resolve;
  });
  const modelHost: ModelHost = {
    binding: modelBinding,
    async exchange(_request, observer) {
      dispatch += 1;
      if (dispatch === 1) {
        const text = "Alex opens the door before panels are generated.";
        return {
          text,
          providerState: {
            protocol: "chat_completions",
            assistantMessage: { role: "assistant", content: text },
          },
        };
      }
      if (dispatch === 2) {
        observer?.onDelta?.({ kind: "reasoning", text: "checking" });
        observer?.onDelta?.({ kind: "text", text: "panel" });
        observer?.onDelta?.({ kind: "tool", text: '{"output":' });
        markFollowupStarted?.();
        await followupRelease;
        return {
          toolCalls: [
            {
              id: "emit-status-progress",
              name: "artifact_emit",
              arguments: { output: "status_bar", payload: { hp: 9 } },
            },
          ],
        };
      }
      return {
        toolCalls: [
          {
            id: "emit-options-progress",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "跟上去" } },
          },
        ],
      };
    },
  };
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );
  const running = chains.start({
    worldId,
    chainId: "play-chain-followup-progress-contract",
    exchangeId: "exchange-followup-progress",
    playerText: "I ask Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  let completed: V1PlayCallChainView | undefined;
  try {
    await vi.waitFor(() => expect(dispatch).toBe(2));
    await followupStarted;
    expect(await chains.inspectWorld(worldId)).toMatchObject({
      status: "running",
      activeInvocation: {
        phase: "followup",
        reasoningChars: 8,
        textChars: 5,
        toolChars: 10,
        dispatches: 2,
      },
    });
  } finally {
    finishFollowup?.();
    completed = await running;
  }
  expect(completed).toMatchObject({ status: "ready" });
  expect(dispatch).toBe(3);
});

test("后置请求在整轮结束后各跑一次，共享同一主链前缀且互不可见", async () => {
  const { worlds, root, worldId } = await createWorld("play-chain-followup");
  const artifacts = new FileNativeArtifactStore(root);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex opens the door, and wind rushes in." },
      {
        outcome: "response",
        text: "The panel is ready.",
        toolCalls: [
          {
            id: "emit-status",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 9 } },
          },
        ],
      },
      {
        outcome: "response",
        text: "Options generated.",
        toolCalls: [
          {
            id: "emit-options",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "跟上去" } },
          },
        ],
      },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );

  const view = await chains.start({
    worldId,
    chainId: "play-chain-followup-contract",
    exchangeId: "exchange-first",
    playerText: "I signal Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(modelHost.requests).toHaveLength(3);

  // Only the first request belongs to the main chain. Both follow-ups must use
  // the exact transcript at main-chain completion and cannot see each other.
  const mainPrefix = [
    { kind: "player", text: "I signal Alex to open the door." },
    {
      kind: "assistant",
      text: "Alex opens the door, and wind rushes in.",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: {
          role: "assistant",
          content: "Alex opens the door, and wind rushes in.",
        },
      },
      toolCalls: [],
    },
  ];
  const statusRequest = modelHost.requests[1]!;
  const optionsRequest = modelHost.requests[2]!;
  expect(statusRequest.appended.slice(0, 2)).toEqual(mainPrefix);
  expect(optionsRequest.appended.slice(0, 2)).toEqual(mainPrefix);
  expect(statusRequest.appended).toHaveLength(3);
  expect(optionsRequest.appended).toHaveLength(3);
  expect(optionsRequest.appended[2]).not.toEqual(statusRequest.appended[2]);
  expect(JSON.stringify(optionsRequest.appended)).not.toContain("status_bar");
  expect(JSON.stringify(statusRequest.appended)).not.toContain(
    "The panel is ready",
  );

  // Follow-ups receive artifact tools only, never main-chain read/write tools.
  expect(statusRequest.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);
  expect(optionsRequest.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);

  // The trace is visible without advancing world authority.
  expect(view.events.filter(({ kind }) => kind === "followup")).toMatchObject([
    { followupId: "status", toolCalls: [{ name: "artifact_emit", ok: true }] },
    { followupId: "options", toolCalls: [{ name: "artifact_emit", ok: true }] },
  ]);
  expect(view.parentHead).toBe("commit:2");
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I signal Alex to open the door.",
    "Alex opens the door, and wind rushes in.",
  ]);

  // The artifact is active and bound to the current endpoint.
  const projection = await artifacts.readActiveProjection(worldId);
  expect(projection.map(({ output }) => output).sort()).toEqual([
    "options",
    "status_bar",
  ]);

  // The next player input follows the narrative directly; follow-ups leave no
  // trace in main-chain context.
  const nextHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "You follow him into the corridor." },
      {
        outcome: "response",
        text: "The panel was refreshed.",
        toolCalls: [
          {
            id: "emit-status-2",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 7 } },
          },
        ],
      },
      {
        outcome: "response",
        text: "Options refreshed.",
        toolCalls: [
          {
            id: "emit-options-2",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "回头看" } },
          },
        ],
      },
    ],
  });
  await chains.append({
    worldId,
    chainId: view.chainId,
    exchangeId: "exchange-second",
    playerText: "I follow.",
    modelHost: nextHost,
  });
  expect(nextHost.requests[0]!.appended).toEqual([
    ...mainPrefix,
    { kind: "player", text: "I follow." },
  ]);

  // Each settled exchange uses a new operation, replacing the previous panel
  // instead of accumulating another one.
  const refreshed = await artifacts.readActiveProjection(worldId);
  expect(refreshed).toHaveLength(2);
  expect(refreshed.map(({ payload }) => payload)).toEqual(
    expect.arrayContaining([{ hp: 7 }, { first: "回头看" }]),
  );
});

test("后置请求失败不影响已提交的主链，玩家仍可继续", async () => {
  const { worlds, root, worldId } = await createWorld(
    "play-chain-followup-fail",
  );
  const artifacts = new FileNativeArtifactStore(root);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex opens the door." },
      // The required artifact was not committed.
      { outcome: "response", text: "I will not emit a panel this turn." },
      { outcome: "failure", message: "provider 拒绝了这次后置请求。" },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );

  const view = await chains.start({
    worldId,
    chainId: "play-chain-followup-fail-contract",
    exchangeId: "exchange-first",
    playerText: "I signal Alex to open the door.",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(view.lastFailure).toBeNull();
  const followups = view.events.filter(({ kind }) => kind === "followup");
  expect(followups).toHaveLength(2);
  expect(followups[0]).toMatchObject({ followupId: "status" });
  expect(followups[1]).toMatchObject({ followupId: "options" });
  expect(
    followups.every(
      (event) => (event as { failure?: string }).failure !== undefined,
    ),
  ).toBe(true);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "I signal Alex to open the door.",
    "Alex opens the door.",
  ]);
});

/** Two follow-ups on top of the shipped default call chain. */
function followupPlayPreset(): PlayPresetBinding {
  const files = structuredClone(defaultPlayPresetFiles);
  files["preset.yaml"] = `format: narraeon.play-preset/v1
name: followup-test
callChain: call-chain.yaml
mounts:
  panel.status: sidebar
  player.options: composer_below
extensions: []
`;
  files["call-chain.yaml"] = `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
${followupEntry("status", "状态栏", "status_bar", "panel.status")}${followupEntry(
    "options",
    "行动选项",
    "options",
    "player.options",
  )}`;
  files["prompts/status.md"] = "# Status panel\n\nOutput the current status.\n";
  files["prompts/options.md"] =
    "# Action options\n\nSuggest possible next actions.\n";
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "followup-test-preset",
    name: "followup-test",
    revision: "followup-test-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function followupEntry(
  id: string,
  displayName: string,
  output: string,
  channel: string,
): string {
  return `  - id: ${id}
    displayName: ${displayName}
    prompt: { markdown: prompts/${id}.md }
    maxArtifactBytes: 32768
    artifacts:
      - name: ${output}
        channel: ${channel}
        strategy: replace
        contentType: application/json
        save: commit
        invalidation: new_operation
        required: true
        maxEmits: 1
`;
}

async function readUtf8Tree(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? readUtf8Tree(path) : readFile(path, "utf8");
    }),
  );
  return contents.join("\n");
}
