import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, test, vi } from "vitest";
import { classifyPlayFailure } from "../../src/runtime/play/PlayFailure.ts";
import { playFailureKinds } from "../../src/protocol/playFailure.ts";

import {
  parseV1Envelope,
  type V1PlayCallChainView,
  type V1PlayContextReadingView,
} from "../../src/protocol/v1.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
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
  builtinDefaultPlayPresetBinding,
  legacyDefaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  presetHostBinding,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import {
  preparePlayerRevisionTrace,
  prepareForkTrace,
} from "../../src/runtime/play/PlayTraceRetention.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import {
  isResolutionReceipt,
  type ResolutionReceipt,
} from "../../src/protocol/resolution.ts";
import { resolutionMarkdown } from "../../src/runtime/play/TabletopResolution.ts";
import {
  baseRuntimeToolNames,
  registeredRuntimeToolNames,
} from "../../src/runtime/prompt/FileNativeToolRegistry.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { gameplayFile } from "../../src/protocol/gameplay.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { revisePlayerTimeline } from "./support/player-timeline-edit.ts";
import { turnGuideHeader } from "../../src/shared/turn-guide.ts";

const roots: string[] = [];

test.each([
  [
    "outcome_unknown",
    new ModelHostOutcomeUnknownError("dispatched outcome unknown"),
    false,
  ],
  [
    "context_limit",
    new ModelHostFailureError("request rejected", {
      details: { code: "context_length_exceeded" },
    }),
    false,
  ],
  [
    "output_limit",
    new ModelHostFailureError("response incomplete", {
      details: { code: "model_output_limit" },
    }),
    false,
  ],
  [
    "context_unavailable",
    new ModelHostContinuationError("lost continuation"),
    false,
  ],
  [
    "context_unavailable",
    new ModelHostBindingMismatchError("incompatible binding"),
    false,
  ],
  ["retryable", new ModelHostFailureError("rejected before generation"), true],
  ["other", new Error("tool processing failed"), false],
] as const)(
  "%s failure is persisted in context, event, summary and cold recovery",
  async (failureKind, failure, canRetry) => {
    const { worlds, worldId } = await createWorld(
      `failure-kind-${failureKind}`,
    );
    const chains = new PlayCallChain(worlds);
    const exchange = vi.fn(() => Promise.reject(failure));
    const result = await chains.start({
      worldId,
      chainId: "classified-failure",
      exchangeId: "first-failure",
      playerText: "I wait for Alex.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: { binding: modelBinding, exchange },
    });
    expect(result).toMatchObject({
      status: "interrupted",
      canRetry,
      lastFailureKind: failureKind,
      lastFailure: failure.message,
    });
    const event = result.events.at(-1)!;
    expect(event).toMatchObject({
      kind: "failure",
      failureKind,
      message: failure.message,
    });
    expect(
      (await worlds.playTimeline.readCurrent(worldId))?.value,
    ).toMatchObject({ lastFailureKind: failureKind, canRetry });
    const page = await worlds.playTimeline.readPage(worldId, 40);
    expect(page).toMatchObject({
      activeLastFailureKind: failureKind,
      activeCanRetry: canRetry,
    });
    expect(page.items.at(-1)).toMatchObject({
      event: { failureKind, message: failure.message },
    });
    expect(
      await worlds.playTimeline.readDetail(worldId, result.chainId, event.id),
    ).toMatchObject({ failureKind });
    expect(await new PlayCallChain(worlds).inspectWorld(worldId)).toMatchObject(
      { lastFailureKind: failureKind, canRetry },
    );
    expect(
      (await worlds.recoverEndpoint(worldId)).history.map(
        ({ exactText }) => exactText,
      ),
    ).toEqual(["门外传来三声短促的铃响。\n", "I wait for Alex."]);
    if (!canRetry) {
      await expect(
        chains.append({
          worldId,
          chainId: result.chainId,
          exchangeId: "forbidden-retry",
          playerText: "",
          modelHost: { binding: modelBinding, exchange },
        }),
      ).rejects.toThrow("use a fresh context");
      expect(exchange).toHaveBeenCalledOnce();
    }
  },
);

test("Provider failures without replay permission classify as provider_error; unknown failures and undispatched requests retain their boundaries", () => {
  expect(
    classifyPlayFailure(new ModelHostFailureError("provider error"), false),
  ).toBe("provider_error");
  expect(classifyPlayFailure(new Error("settlement failed"), false)).toBe(
    "other",
  );
  expect(classifyPlayFailure(new Error("not dispatched"), true)).toBe(
    "retryable",
  );
});

test("all seven failure kinds round-trip through the context and timeline codecs", async () => {
  const { worlds, worldId } = await createWorld("failure-kind-codecs");
  const result = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "failure-kind-codecs",
    exchangeId: "first",
    playerText: "I wait.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "failure", message: "rejected" }],
    }),
  });
  for (const failureKind of playFailureKinds) {
    const loaded = (await worlds.playTimeline.readCurrent(worldId))!;
    loaded.value.lastFailureKind = failureKind;
    loaded.value.canRetry = failureKind === "retryable";
    const event = loaded.value.events.at(-1)!;
    if (event.kind !== "failure") throw new Error("missing failure");
    event.failureKind = failureKind;
    await worlds.playTimeline.persist(loaded.value, loaded.cursor);
    expect(await new PlayCallChain(worlds).inspectWorld(worldId)).toMatchObject(
      { lastFailureKind: failureKind },
    );
    expect(await worlds.playTimeline.readPage(worldId, 40)).toMatchObject({
      activeLastFailureKind: failureKind,
    });
    expect(
      await worlds.playTimeline.readDetail(worldId, result.chainId, event.id),
    ).toMatchObject({ failureKind });
  }
});

test("failure kinds are optional in stored records and invalid kinds fail closed", async () => {
  const { worlds, worldId, root } = await createWorld(
    "failure-kind-compatibility",
  );
  const result = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "optional-failure-kind",
    exchangeId: "first",
    playerText: "I wait.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "failure", message: "rejected" }],
    }),
  });
  const contextRoot = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    createHash("sha256").update(result.chainId).digest("hex"),
  );
  const statePath = join(contextRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  delete state.lastFailureKind;
  await writeFile(statePath, JSON.stringify(state));
  const event = result.events.at(-1)!;
  if (event.kind !== "failure") throw new Error("missing failure");
  delete event.failureKind;
  const numbered = `${String(event.id).padStart(10, "0")}.json`;
  for (const directory of ["events", "summaries"])
    await writeFile(
      join(contextRoot, directory, numbered),
      JSON.stringify(event),
    );
  expect(await new PlayCallChain(worlds).inspectWorld(worldId)).toMatchObject({
    status: "interrupted",
    canRetry: true,
  });
  expect(
    (await worlds.playTimeline.readPage(worldId, 40)).items.at(-1),
  ).toMatchObject({ event });
  expect(
    await worlds.playTimeline.readDetail(worldId, result.chainId, event.id),
  ).not.toHaveProperty("failureKind");
  await writeFile(
    statePath,
    JSON.stringify({ ...state, lastFailureKind: "invented" }),
  );
  await expect(worlds.playTimeline.readPage(worldId, 40)).rejects.toThrow(
    "invalid shape",
  );
  await writeFile(statePath, JSON.stringify(state));
  for (const directory of ["events", "summaries"])
    await writeFile(
      join(contextRoot, directory, numbered),
      JSON.stringify({ ...event, failureKind: "invented" }),
    );
  await expect(worlds.playTimeline.readPage(worldId, 40)).rejects.toThrow(
    "invalid kind",
  );
  await expect(
    worlds.playTimeline.readDetail(worldId, result.chainId, event.id),
  ).rejects.toThrow("invalid kind");
});

test("最近完整响应在40项尾部之外时，仍投影其输入 usage 而不扩大事件尾部", async () => {
  const { worlds, worldId } = await createWorld("context-usage-outside-tail");
  const usage = {
    ...emptyAggregatedModelUsage(),
    inputTokens: 620_000,
    provenance: {
      ...emptyAggregatedModelUsage().provenance,
      inputTokens: "provider" as const,
    },
  };
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "usage-outside-tail",
    exchangeId: "usage-outside-tail-player",
    playerText: "Read the directory many times.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          usage,
          toolCalls: Array.from({ length: 25 }, (_, index) => ({
            id: `usage-list-${index}`,
            name: "state_list",
            arguments: {},
          })),
        },
        { outcome: "failure", message: "Rejected before generation." },
      ],
    }),
  });
  const view = await chains.observeWorld(worldId);
  expect(view?.events).toHaveLength(40);
  expect(
    view?.events.some(
      (event) => event.kind === "assistant" && event.status === "completed",
    ),
  ).toBe(false);
  expect(view?.latestCompletedResponse).toMatchObject({ usage });
});

test("上下文窗口只读投影冻结绑定，旧无绑定记录不补窗口，观察提供最近实报 usage", async () => {
  const { worlds, worldId, root } = await createWorld("context-usage");
  const chains = new PlayCallChain(worlds);
  const usage = {
    ...emptyAggregatedModelUsage(),
    inputTokens: 54_400,
    provenance: {
      ...emptyAggregatedModelUsage().provenance,
      inputTokens: "provider" as const,
    },
  };
  for (const [chainId, window] of [
    ["context-usage-first", 64_000],
    ["context-usage-next", 128_000],
  ] as const) {
    const binding = { ...modelBinding(), contextWindowTokens: window };
    const result = await chains.start({
      worldId,
      chainId,
      exchangeId: `${chainId}-exchange`,
      playerText: "Look around.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: binding,
      modelHost: new ScriptedModelHost({
        binding,
        steps: [
          {
            outcome: "response",
            text: "Alex waits by the door.",
            reasoningContent: "Heavy diagnostics stay behind the detail API.",
            usage,
          },
        ],
      }),
    });
    expect(result.contextWindowTokens).toBe(window);
  }
  const cold = new PlayCallChain(new FileNativeWorldStore(root));
  const inspected = await cold.inspectWorld(worldId);
  expect(inspected?.contextWindowTokens).toBe(128_000);
  expect(inspected?.previousContexts).toEqual([]);
  const observed = await cold.observeWorld(worldId);
  expect(observed?.contextWindowTokens).toBe(128_000);
  expect(observed?.latestCompletedResponse).toMatchObject({ usage });
  expect(JSON.stringify(observed)).not.toContain("Heavy diagnostics");

  const contextRoot = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
  );
  for (const directory of await readdir(contextRoot)) {
    const path = join(contextRoot, directory, "base.json");
    const original = JSON.parse(await readFile(path, "utf8")) as {
      modelBinding?: ModelHostBinding;
    };
    delete original.modelBinding;
    await writeFile(path, JSON.stringify(original));
  }
  const legacy = await new PlayCallChain(
    new FileNativeWorldStore(root),
  ).inspectWorld(worldId);
  expect(legacy).not.toHaveProperty("contextWindowTokens");
  expect(legacy?.previousContexts).toEqual([]);
});

test("修改轨迹统一保留前缀工具及原生载荷，并按含同 ID 修改稿的事件选择运行快照", async () => {
  const { source, prefix, eventIndex, endpoint } =
    await createTraceRetentionFixture();
  const player = source.events[eventIndex]!;
  const original = structuredClone(source);
  const prepared = preparePlayerRevisionTrace(source, eventIndex);
  const retained = prepared
    .withReplacement({
      head: "commit:replacement",
      exchangeId: "replacement",
      text: "Replacement input.",
    })
    .atEndpoint(endpoint);
  expect(retained.transcript.slice(0, -1)).toEqual(prefix.transcript);
  expect(retained.completedTools).toEqual(prefix.completedTools);
  expect(retained.events.at(-1)).toMatchObject({
    id: player.id,
    text: "Replacement input.",
    committedHead: "commit:replacement",
  });
  expect(retained.promptRuns).toEqual(source.promptRuns);
  expect(retained.exchange).toBe(2);
  expect(retained.nextEventId).toBe(player.id + 1);
  expect(source).toEqual(original);
  retained.completedTools[0]!.result.markdown = "changed copy";
  expect(source).toEqual(original);
});

test("fresh 修改按页面前缀选择快照，缺少旧 binding 仍能保留，空前缀不生成记录", async () => {
  const { source, prefix, eventIndex, endpoint } =
    await createTraceRetentionFixture();
  delete source.modelBinding;
  const prepared = preparePlayerRevisionTrace(source, eventIndex);
  const retained = prepared.pagePrefixAtEndpoint(endpoint)!;
  expect(retained.events).toEqual(prefix.events);
  expect(retained.transcript).toEqual(prefix.transcript);
  expect(retained.completedTools).toEqual(prefix.completedTools);
  expect(retained.promptRuns).toEqual(prefix.promptRuns);
  expect(retained.changedDocuments).toEqual([
    {
      kind: "replace",
      ref: "@current-situation",
      path: "current-situation.yaml",
    },
  ]);
  expect(retained).not.toHaveProperty("modelBinding");
  expect(
    preparePlayerRevisionTrace(source, 0).pagePrefixAtEndpoint(endpoint),
  ).toBeNull();
});

test("完整分叉保留原生轨迹及全部工具，部分分叉恢复所选端点的关联记录及文档变化", async () => {
  const { source, prefix, endpoint, current, currentBinding } =
    await createTraceRetentionFixture();
  const partial = prepareForkTrace(source, prefix.events).atEndpoint(endpoint);
  expect(partial.transcript).toEqual(prefix.transcript);
  expect(partial.completedTools).toEqual(prefix.completedTools);
  expect(partial.promptRuns).toEqual(prefix.promptRuns);
  expect(partial.changedDocuments).toEqual([
    {
      kind: "replace",
      ref: "@current-situation",
      path: "current-situation.yaml",
    },
  ]);
  // A frozen next generation can have a continuation notice beyond page events.
  // Complete-context forks preserve that native closure without reconstruction.
  source.transcript.push({
    kind: "runtime_notice",
    notice: "continuation",
    text: "Continue without new player input.",
  });
  const full = prepareForkTrace(source, source.events).atEndpoint({
    ...endpoint,
    selected: current,
    binding: currentBinding,
  });
  expect(full.transcript).toEqual(source.transcript);
  expect(full.completedTools).toEqual(source.completedTools);
  expect(full.promptRuns).toEqual(source.promptRuns);
  expect(full.changedDocuments).toEqual([]);
  full.events[0] = {
    id: 1,
    kind: "failure",
    message: "Independent copy.",
  };
  expect(source.events[0]?.kind).toBe("player");
});

/**
 * The transcript items a request carries, without the per-send turn guide
 * that every dispatch appends after them (see the turn-guide tests below).
 */
function sent(request: ModelHostExchange): ModelHostExchange["appended"] {
  const last = request.appended.at(-1);
  return last?.kind === "runtime_notice" && last.notice === "turn_guide"
    ? request.appended.slice(0, -1)
    : request.appended;
}

async function createTraceRetentionFixture() {
  const { worlds, worldId } = await createWorld("trace-retention-revision");
  const chains = new PlayCallChain(worlds);
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          { id: "read-prefix", name: "state_list", arguments: {} },
          {
            id: "patch-prefix",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "Alex打开了门。",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "The retained reply.",
        providerState: {
          protocol: "chat_completions",
          assistantMessage: {
            role: "assistant",
            content: "The retained reply.",
            provider_extension: { opaque: "KEEP ORIGINAL" },
          },
        },
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-after",
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
      { outcome: "response", text: "The discarded reply." },
    ],
  });
  await chains.start({
    worldId,
    chainId: "trace-retention-source",
    exchangeId: "first",
    playerText: "First input.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const prefix = (await worlds.playTimeline.readCurrent(worldId))!.value;
  await chains.append({
    worldId,
    chainId: prefix.chainId,
    exchangeId: "second",
    playerText: "Second input.",
    modelHost: host,
  });
  const source = (await worlds.playTimeline.readCurrent(worldId))!.value;
  const eventIndex = source.events.findIndex(
    (event) => event.kind === "player" && event.exchangeId === "second",
  );
  const player = source.events[eventIndex];
  if (player?.kind !== "player") throw new Error("missing selected player");
  const endpoint = {
    baseline: await worlds.recoverEndpoint(worldId, source.baselineHead),
    selected: await worlds.recoverEndpoint(worldId, prefix.parentHead),
    binding: await worlds.bindPlayCallChainAt(worldId, prefix.parentHead),
  };
  const current = await worlds.recoverEndpoint(worldId);
  const currentBinding = await worlds.bindPlayCallChain(worldId);
  return { source, prefix, eventIndex, endpoint, current, currentBinding };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([
  "chat_completions",
  "anthropic_messages",
  "openai_responses",
] as const)(
  "%s 的新发送更换提示并保留真实编码中的原生续传",
  async (provider) => {
    const { worlds, worldId } = await createWorld(`live-native-${provider}`);
    const requests: string[] = [];
    const original =
      provider === "chat_completions"
        ? {
            role: "assistant",
            content: "Native original.",
            reasoning_content: "Returned reasoning",
            provider_extension: { exact: "OPAQUE ORIGINAL" },
          }
        : provider === "anthropic_messages"
          ? [
              {
                type: "thinking",
                thinking: "Returned reasoning",
                signature: "OPAQUE ORIGINAL",
              },
              { type: "text", text: "Native original." },
            ]
          : [
              {
                type: "reasoning",
                id: "reasoning-1",
                encrypted_content: "OPAQUE ORIGINAL",
                summary: [{ type: "summary_text", text: "Returned reasoning" }],
              },
              {
                type: "message",
                id: "message-1",
                role: "assistant",
                content: [{ type: "output_text", text: "Native original." }],
              },
            ];
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "native-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 2000,
      },
      (_url, options) => {
        if (typeof options?.body !== "string")
          throw new Error("Expected a JSON request body");
        requests.push(options.body);
        const payload =
          provider === "chat_completions"
            ? { choices: [{ message: original, finish_reason: "stop" }] }
            : provider === "anthropic_messages"
              ? {
                  id: "response-1",
                  type: "message",
                  role: "assistant",
                  content: original,
                  stop_reason: "end_turn",
                }
              : { id: "response-1", status: "completed", output: original };
        return Promise.resolve(new Response(JSON.stringify(payload)));
      },
    );
    const chains = new PlayCallChain(worlds);
    await chains.start({
      worldId,
      chainId: "native-chain",
      exchangeId: "first",
      playerText: "Native first input.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: host.binding(),
      modelHost: host,
    });
    const latest = playPreset();
    latest.definition.playPrompts!.push({
      kind: "user",
      id: "new",
      name: "New",
      enabled: true,
      body: "NATIVE UPDATED PROMPT",
      messageRole: "assistant",
    });
    const next = await new PlayCallChain(worlds).append({
      worldId,
      chainId: "native-chain",
      exchangeId: "next",
      playerText: "Native next input.",
      modelHost: host,
      resolvePrompt: () =>
        Promise.resolve({
          hostBinding: hostBinding(),
          playPreset: latest,
        }),
    });
    expect(next.status).toBe("ready");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("NATIVE UPDATED PROMPT");
    const expectedText: unknown = expect.stringContaining(
      "NATIVE UPDATED PROMPT",
    );
    const expectedContent: unknown =
      provider === "anthropic_messages"
        ? expect.arrayContaining([
            expect.objectContaining({ text: expectedText }),
          ])
        : expectedText;
    expect(JSON.parse(requests[1]!)).toHaveProperty(
      provider === "openai_responses" ? "input" : "messages",
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expectedContent,
        }),
      ]),
    );
    expect(requests[1]).toContain("OPAQUE ORIGINAL");
    expect(requests[1]).toContain(JSON.stringify(original).slice(1, -1));
    const reading = await new PlayCallChain(worlds).inspectReading(
      worldId,
      next.parentHead,
    );
    expect(reading?.prefixDiagnostics?.logical?.changedSources).toContainEqual(
      expect.objectContaining({ change: "added" }),
    );
    expect(reading?.prefixDiagnostics?.encoding.current?.provider).toBe(
      provider,
    );
    expect(reading?.promptHistory).toHaveLength(2);
    expect(JSON.stringify(reading?.promptHistory?.[0])).not.toContain(
      "NATIVE UPDATED PROMPT",
    );
    const fresh = await chains.start({
      worldId,
      chainId: "native-fresh",
      exchangeId: "fresh",
      playerText: "Start another context.",
      hostBinding: hostBinding(),
      playPreset: latest,
      modelBinding: host.binding(),
      modelHost: host,
    });
    const freshReading = await new PlayCallChain(worlds).inspectReading(
      worldId,
      fresh.parentHead,
    );
    expect(freshReading?.prefixDiagnostics?.encoding.previous).toEqual(
      reading?.prefixDiagnostics?.encoding.current,
    );
    expect(freshReading?.prefixDiagnostics?.logical?.previousBytes).toBe(
      reading?.prefixDiagnostics?.logical?.currentBytes,
    );
  },
);

test("后置定义与资源跨冷恢复完整保留，旧请求不解析新预设", async () => {
  const { worlds, worldId, root } = await createWorld(
    "live-followup-resources",
  );
  const artifacts = new FileNativeArtifactStore(root);
  const selected = followupPlayPreset();
  selected.files["assets/run.txt"] = "ORIGINAL RESOURCE";
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Before followups are enabled." },
      { outcome: "failure", message: "Rejected before generation" },
      { outcome: "response", text: "Main story after retry." },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "status",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 7 } },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "options",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "Wait" } },
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
  await chains.start({
    worldId,
    chainId: "resources",
    exchangeId: "first",
    playerText: "Start.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const interrupted = await chains.append({
    worldId,
    chainId: "resources",
    exchangeId: "second",
    playerText: "Enable panels.",
    modelHost: host,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: selected,
      }),
  });
  expect(interrupted).toMatchObject({ canRetry: true });
  selected.files["assets/run.txt"] = "EDITED RESOURCE";
  selected.definition.followups.length = 0;
  const durable = await worlds.playTimeline.readCurrent(worldId);
  expect(durable?.value.promptRuns?.[0]?.presetFiles["assets/run.txt"]).toBe(
    "ORIGINAL RESOURCE",
  );
  expect(durable?.value.promptRuns?.[0]?.followups.map(({ id }) => id)).toEqual(
    ["status", "options"],
  );
  const runPath = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    createHash("sha256").update("resources").digest("hex"),
    "prompt-runs",
    "0000000001.json",
  );
  const originalRecordText = await readFile(runPath, "utf8");
  const originalRecord = JSON.parse(originalRecordText) as {
    run: Record<string, unknown>;
    digest: string;
  };
  for (const invalid of [
    { playPreset: {} },
    { bootstrap: [] },
    { tools: [null] },
    { followups: [null] },
    { unknownField: true },
  ]) {
    const record = structuredClone(originalRecord);
    Object.assign(record.run, invalid);
    record.digest = createHash("sha256")
      .update(JSON.stringify(record.run))
      .digest("hex");
    await writeFile(runPath, JSON.stringify(record));
    await expect(
      new PlayCallChain(worlds).inspectWorld(worldId),
    ).rejects.toThrow("Invalid play prompt run");
  }
  await writeFile(runPath, originalRecordText);

  const recovered = await new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    new FileNativeArtifactStore(root),
  ).append({
    worldId,
    chainId: "resources",
    exchangeId: "retry",
    playerText: "",
    modelHost: host,
    resolvePrompt: () => {
      throw new Error("Saved request must not resolve current configuration");
    },
  });
  expect(recovered.status).toBe("ready");
  expect(host.requests).toHaveLength(5);
  expect(host.requests[2]!.bootstrap).toEqual(host.requests[1]!.bootstrap);
  expect(
    (await artifacts.readActiveProjection(worldId)).map(
      ({ payload }) => payload,
    ),
  ).toEqual(expect.arrayContaining([{ hp: 7 }, { first: "Wait" }]));
});

test("追加上下文冻结初始材料并保留写入授权，历史分叉恢复当时提示", async () => {
  const { worlds, worldId } = await createWorld("live-materials");
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-first",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "NEW MATERIAL VALUE",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "FIRST NARRATIVE ORIGINAL" },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-next",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "LATEST MATERIAL VALUE",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "SECOND NARRATIVE ORIGINAL" },
      { outcome: "response", text: "EMPTY CONTINUATION" },
      { outcome: "response", text: "FRESH CONTEXT" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "materials",
    exchangeId: "first",
    playerText: "FIRST PLAYER ORIGINAL",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const latest = playPreset();
  latest.revision = "material-revision";
  latest.definition.playPrompts!.unshift({
    kind: "user",
    id: "material-rule",
    name: "Material rule",
    enabled: true,
    body: "NEW MATERIAL RULE",
  });
  const second = await new PlayCallChain(worlds).append({
    worldId,
    chainId: "materials",
    exchangeId: "second",
    playerText: "SECOND PLAYER ORIGINAL",
    modelHost: host,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: latest,
      }),
  });
  expect(second.status).toBe("ready");
  expect(host.requests[2]!.bootstrap.provider.preload).toEqual(
    host.requests[0]!.bootstrap.provider.preload,
  );
  expect(JSON.stringify(host.requests[2]!.appended)).toContain(
    "NEW MATERIAL VALUE",
  );
  expect(JSON.stringify(host.requests[2]!.appended)).not.toContain(
    "runtime_initial_world_context",
  );
  expect(JSON.stringify(host.requests[2]!.bootstrap)).toContain(
    "NEW MATERIAL RULE",
  );
  expect(JSON.stringify(host.requests[2]!.bootstrap)).not.toContain(
    "NEW MATERIAL VALUE",
  );
  expect(JSON.stringify(host.requests[2]!.bootstrap)).not.toContain(
    "FIRST NARRATIVE ORIGINAL",
  );
  expect(JSON.stringify(host.requests[2]!.bootstrap)).not.toContain(
    "FIRST PLAYER ORIGINAL",
  );
  expect(host.requests[3]!.bootstrap).toEqual(host.requests[2]!.bootstrap);
  expect(second.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "patch-next",
      ok: true,
    }),
  );
  const restored = new PlayCallChain(worlds);
  const reading = await restored.inspectReading(worldId, second.parentHead);
  expect(JSON.stringify(reading?.bootstrap)).not.toContain(
    "NEW MATERIAL VALUE",
  );
  expect(JSON.stringify(reading?.bootstrap)).not.toContain(
    "LATEST MATERIAL VALUE",
  );
  const branch = await restored.deriveWorld({
    operationId: "fork-live-materials",
    sourceWorldId: worldId,
    sourceHead: first.parentHead,
    hostPresetId: "play-chain-host",
  });
  const branched = await restored.inspectWorld(branch.world.worldId);
  const branchReading = await restored.inspectReading(
    branch.world.worldId,
    branched!.parentHead,
  );
  expect(JSON.stringify(branchReading?.bootstrap)).not.toContain(
    "NEW MATERIAL RULE",
  );
  expect(branchReading?.playPreset.revision).toBe("builtin-default-v1");
  const resolvePrompt = () =>
    Promise.resolve({ hostBinding: hostBinding(), playPreset: latest });
  await new PlayCallChain(worlds).append({
    worldId,
    chainId: "materials",
    exchangeId: "empty",
    playerText: "",
    modelHost: host,
    resolvePrompt,
  });
  expect(host.requests[4]!.bootstrap.provider.preload).toEqual(
    host.requests[0]!.bootstrap.provider.preload,
  );
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "materials-fresh",
    exchangeId: "fresh",
    playerText: "Start fresh.",
    hostBinding: hostBinding(),
    playPreset: latest,
    modelBinding: modelBinding(),
    modelHost: host,
  });
  expect(host.requests[5]!.bootstrap.provider.preload?.markdown).toContain(
    "LATEST MATERIAL VALUE",
  );
});

test("工具中编辑不替换快照，拒绝后的冷重试不读取新配置", async () => {
  const { worlds, worldId } = await createWorld("live-prompt-retry");
  const preset = playPreset();
  const resolvePrompt = vi.fn(() =>
    Promise.resolve({
      hostBinding: hostBinding(),
      playPreset: preset,
    }),
  );
  const scripted = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Initial story." },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "context_read",
            arguments: { ref: "@current-situation" },
          },
        ],
      },
      { outcome: "failure", message: "Rejected before generation." },
      { outcome: "response", text: "Recovered story." },
    ],
  });
  const modelHost: ModelHost = {
    binding: () => scripted.binding(),
    exchange: async (request, options) => {
      const result = await scripted.exchange(request, options);
      if (scripted.requests.length === 2)
        preset.definition.playPrompts!.push({
          kind: "user",
          id: "late",
          name: "Late",
          enabled: true,
          body: "EDIT DURING TOOL LOOP",
        });
      return result;
    },
  };
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "retry",
    exchangeId: "first",
    playerText: "Start.",
    hostBinding: hostBinding(),
    playPreset: preset,
    modelBinding: modelBinding(),
    modelHost,
  });
  const interrupted = await chains.append({
    worldId,
    chainId: "retry",
    exchangeId: "second",
    playerText: "Read.",
    modelHost,
    resolvePrompt,
  });
  expect(interrupted).toMatchObject({ status: "interrupted", canRetry: true });
  expect(scripted.requests[2]!.bootstrap).toEqual(
    scripted.requests[1]!.bootstrap,
  );
  expect(JSON.stringify(scripted.requests[2]!.bootstrap)).not.toContain(
    "EDIT DURING TOOL LOOP",
  );
  expect(resolvePrompt).toHaveBeenCalledTimes(1);
  await new PlayCallChain(worlds).append({
    worldId,
    chainId: "retry",
    exchangeId: "retry-request",
    playerText: "",
    modelHost,
    resolvePrompt: () => {
      throw new Error("Recovery must not read presets");
    },
  });
  expect(scripted.requests[3]!.bootstrap).toEqual(
    scripted.requests[2]!.bootstrap,
  );
  expect(scripted.requests[3]!.appended).toEqual(
    scripted.requests[2]!.appended,
  );
  expect(sent(scripted.requests[3]!).at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "read",
  });
});

test("精读授权在同一进程的发送间保留；重启后从保留的对话记录回放，无需重新精读，且不扩大到未读节点", async () => {
  const { worlds, worldId, root } = await createWorld("retained-read", [
    ...worldFiles(),
    {
      path: "world/characters/qin.yaml",
      contents:
        "$document:\n  id: person.qin\n  ref: qin\n  title: Qin\n  summary: Courier\n  aliases: []\nrelationship: Just met\nprivate: Unknown\npending: Ask for umbrella\n",
    },
  ]);
  const patch = (id: string, key: string, value: string) => ({
    id,
    name: "world_patch",
    arguments: {
      target: "@qin",
      edits: [{ op: "replace", locator: { yaml: [key] }, value }],
    },
  });
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "context_read",
            arguments: { ref: "@qin#/relationship" },
          },
          {
            id: "read-pending",
            name: "context_read",
            arguments: { ref: "@qin#/pending" },
          },
        ],
      },
      { outcome: "response", text: "Qin greets you." },
      {
        // Read authority is memory-only, but a restart replays the exact reads
        // the retained transcript still shows the model (ADR-0044).
        outcome: "response",
        toolCalls: [
          patch(
            "second-write",
            "relationship",
            "Trust after lending an umbrella",
          ),
          {
            id: "remove-completed",
            name: "world_patch",
            arguments: {
              target: "@qin",
              edits: [{ op: "remove", locator: { yaml: ["pending"] } }],
            },
          },
        ],
      },
      { outcome: "response", text: "Qin accepts the umbrella." },
      {
        outcome: "response",
        toolCalls: [
          patch(
            "third-write",
            "relationship",
            "Trust with a promise to return the umbrella",
          ),
          patch("forbidden", "private", "Forged"),
        ],
      },
      { outcome: "response", text: "Qin promises to return it." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "read-proof",
    exchangeId: "first",
    playerText: "Hello",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  for (const [exchangeId, playerText] of [
    ["second", "I lend the umbrella"],
    ["third", ""],
  ]) {
    const resumed = new PlayCallChain(new FileNativeWorldStore(root));
    const view = await resumed.append({
      worldId,
      chainId: "read-proof",
      exchangeId: exchangeId!,
      playerText: playerText!,
      modelHost: host,
      resolvePrompt: () =>
        Promise.resolve({
          hostBinding: hostBinding(),
          playPreset: playPreset(),
        }),
    });
    expect(view.status).toBe("ready");
    expect(
      view.events.find(
        (event) =>
          event.kind === "tool_result" &&
          event.callId === `${exchangeId}-write`,
      ),
    ).toMatchObject({ ok: true });
    if (exchangeId === "third")
      expect(
        view.events.find(
          (event) =>
            event.kind === "tool_result" && event.callId === "forbidden",
        ),
      ).toMatchObject({ ok: false });
  }
  expect(
    (await worlds.bindPlayCallChain(worldId)).files[
      "state/characters/qin.yaml"
    ],
  ).toContain("Trust with a promise");
  const freshHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [patch("fresh-write", "relationship", "Unproven")],
      },
      { outcome: "response", text: "A fresh scene." },
    ],
  });
  const fresh = await new PlayCallChain(new FileNativeWorldStore(root)).start({
    worldId,
    chainId: "fresh-proof",
    exchangeId: "fresh",
    playerText: "Continue",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: freshHost,
  });
  expect(
    fresh.events.find(
      (event) => event.kind === "tool_result" && event.callId === "fresh-write",
    ),
  ).toMatchObject({ ok: false });
});

test("重新生成或修改消息后，保留前缀中的精读授权被回放，模型无需重读即可修改", async () => {
  const { worlds, worldId, root } = await createWorld("revised-read", [
    ...worldFiles(),
    {
      path: "world/characters/qin.yaml",
      contents:
        "$document:\n  id: person.qin\n  ref: qin\n  title: Qin\n  summary: Courier\n  aliases: []\nrelationship: Just met\nprivate: Unknown\n",
    },
  ]);
  const patch = (id: string, key: string, value: string) => ({
    id,
    name: "world_patch",
    arguments: {
      target: "@qin",
      edits: [{ op: "replace", locator: { yaml: [key] }, value }],
    },
  });
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "context_read",
            arguments: { ref: "@qin#/relationship" },
          },
        ],
      },
      { outcome: "response", text: "Qin greets you." },
      { outcome: "response", text: "Qin waits." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "revised-read",
    exchangeId: "first",
    playerText: "Hello",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const second = await chains.append({
    worldId,
    chainId: "revised-read",
    exchangeId: "second",
    playerText: "I wait.",
    modelHost: host,
  });
  const secondPlayer = second.events.findLast(
    (event) => event.kind === "player",
  )!;
  const revised = await chains.revisePlayer({
    operationId: "revise-read",
    worldId,
    chainId: "revised-read",
    eventId: secondPlayer.id,
    replacementExchangeId: "second-revised",
    replacementText: "I lend the umbrella",
    continuation: "continue_context",
  });
  const revisedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          patch("revised-write", "relationship", "Trust after an umbrella"),
          patch("forbidden", "private", "Forged"),
        ],
      },
      { outcome: "response", text: "Qin accepts the umbrella." },
    ],
  });
  const view = await new PlayCallChain(new FileNativeWorldStore(root)).append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: "second-revised",
    playerText: "",
    modelHost: revisedHost,
    resolvePrompt: () =>
      Promise.resolve({ hostBinding: hostBinding(), playPreset: playPreset() }),
  });
  expect(view.status).toBe("ready");
  expect(
    view.events.find(
      (event) =>
        event.kind === "tool_result" && event.callId === "revised-write",
    ),
  ).toMatchObject({ ok: true });
  expect(
    view.events.find(
      (event) => event.kind === "tool_result" && event.callId === "forbidden",
    ),
  ).toMatchObject({ ok: false });
  expect(
    (await worlds.bindPlayCallChain(worldId)).files[
      "state/characters/qin.yaml"
    ],
  ).toContain("Trust after an umbrella");
});

test("新的发送与空输入重编译，冷恢复保留原生对话和当轮快照", async () => {
  const { worlds, worldId } = await createWorld("live-prompts");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "First exact native response." },
      { outcome: "response", text: "Second exact native response." },
      { outcome: "response", text: "Third exact native response." },
    ],
  });
  const first = playPreset();
  const latest = structuredClone(first);
  latest.id = "latest-preset";
  latest.revision = "latest-revision";
  latest.definition.playPrompts!.splice(0, 0, {
    kind: "user",
    id: "live-rule",
    name: "Live rule",
    enabled: true,
    body: "LATEST LIVE RULE",
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "live-prompts",
    exchangeId: "first",
    playerText: "First input.",
    hostBinding: hostBinding(),
    playPreset: first,
    modelBinding: modelBinding(),
    modelHost,
  });
  await chains.append({
    worldId,
    chainId: "live-prompts",
    exchangeId: "second",
    playerText: "Second input.",
    modelHost,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: latest,
      }),
  });
  expect(JSON.stringify(modelHost.requests[1]!.bootstrap)).toContain(
    "LATEST LIVE RULE",
  );
  expect(
    sent(modelHost.requests[1]!).slice(
      0,
      sent(modelHost.requests[0]!).length + 1,
    ),
  ).toEqual([
    ...sent(modelHost.requests[0]!),
    expect.objectContaining({
      kind: "assistant",
      text: "First exact native response.",
    }),
  ]);
  expect(JSON.stringify(modelHost.requests[1]!.bootstrap)).not.toContain(
    "First exact native response.",
  );
  const resumed = new PlayCallChain(worlds);
  expect(await resumed.inspectWorld(worldId)).toMatchObject({
    playPreset: { id: "latest-preset" },
  });
  await resumed.append({
    worldId,
    chainId: "live-prompts",
    exchangeId: "third",
    playerText: "",
    modelHost,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: first,
      }),
  });
  expect(JSON.stringify(modelHost.requests[2]!.bootstrap)).not.toContain(
    "LATEST LIVE RULE",
  );
  expect(sent(modelHost.requests[2]!).slice(0, -2)).toEqual(
    sent(modelHost.requests[1]!),
  );
  expect(sent(modelHost.requests[2]!).at(-1)).toMatchObject({
    kind: "runtime_notice",
    notice: "continuation",
  });
});

test("修正后并发观察与续写：单飞水合不让磁盘快照覆盖运行中的会话", async () => {
  const { worlds, worldId } = await createWorld("play-chain-revise-concurrent");
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "第一段回复" },
      { outcome: "response", text: "第二段回复" },
      { outcome: "response", text: "修正后续写一" },
      { outcome: "response", text: "修正后续写二" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const initial = await chains.start({
    worldId,
    chainId: "play-chain-revise-concurrent",
    exchangeId: "revise-concurrent-first",
    playerText: "第一次行动",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const second = await chains.append({
    worldId,
    chainId: initial.chainId,
    exchangeId: "revise-concurrent-second",
    playerText: "第二次行动",
    modelHost: host,
  });
  const secondPlayer = second.events.findLast(
    (event) => event.kind === "player",
  )!;
  const revised = await chains.revisePlayer({
    operationId: "revise-concurrent-operation",
    worldId,
    chainId: second.chainId,
    eventId: secondPlayer.id,
    replacementExchangeId: "revise-concurrent-replacement",
    replacementText: "第二次行动（修正）",
    continuation: "continue_context",
  });
  const chainId = revised.playCallChain.chainId;
  const [, continued] = await Promise.all([
    chains.inspectWorld(worldId),
    chains.append({
      worldId,
      chainId,
      exchangeId: "revise-concurrent-after-observe",
      playerText: "第三次行动",
      modelHost: host,
    }),
  ]);
  expect(continued).toMatchObject({ status: "ready" });
  await expect(
    chains.append({
      worldId,
      chainId,
      exchangeId: "revise-concurrent-after-continue",
      playerText: "第四次行动",
      modelHost: host,
    }),
  ).resolves.toMatchObject({ status: "ready" });
});

test("内存中的游玩会话最多保留最近使用的 3 个世界，打开第 4 个时回收最久未用的会话（#93）", async () => {
  const { worlds, worldId: oldest } = await createWorld("residency-lru");
  const later = [
    await createWorldIn(worlds, "residency-lru-b"),
    await createWorldIn(worlds, "residency-lru-c"),
    await createWorldIn(worlds, "residency-lru-d"),
  ];
  const chains = new PlayCallChain(worlds);
  await startChain(chains, oldest, "lru-a");
  for (const [index, worldId] of later.entries())
    await startChain(chains, worldId, `lru-${index}`);
  await vi.waitFor(() => expect(chains.residentWorldIds()).toEqual(later));
});

test("有进行中调用的世界即使最久未用也不会被回收（#93）", async () => {
  const { worlds, worldId: busy } = await createWorld("residency-busy");
  const idle = [
    await createWorldIn(worlds, "residency-busy-b"),
    await createWorldIn(worlds, "residency-busy-c"),
    await createWorldIn(worlds, "residency-busy-d"),
  ] as const;
  const chains = new PlayCallChain(worlds);
  const answer = scriptedHost("进行中的回复");
  let reachProvider!: () => void;
  const providerReached = new Promise<void>((resolve) => {
    reachProvider = resolve;
  });
  let release!: () => void;
  const providerReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = chains.start({
    worldId: busy,
    chainId: "busy-chain",
    exchangeId: "busy-start",
    playerText: "进入房间。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: {
      binding: modelBinding,
      exchange: async (request, observer) => {
        reachProvider();
        await providerReleased;
        return answer.exchange(request, observer);
      },
    },
  });
  await providerReached;
  for (const [index, worldId] of idle.entries())
    await startChain(chains, worldId, `busy-${index}`);
  await vi.waitFor(() =>
    expect(chains.residentWorldIds()).toEqual([busy, idle[1], idle[2]]),
  );
  release();
  await expect(inFlight).resolves.toMatchObject({ status: "ready" });
});

test("有排队或正在执行的世界操作时，即使最久未用也不回收该世界的会话（#93）", async () => {
  const { worlds, worldId: queued } = await createWorld("residency-queued");
  const others = [
    await createWorldIn(worlds, "residency-queued-b"),
    await createWorldIn(worlds, "residency-queued-c"),
    await createWorldIn(worlds, "residency-queued-d"),
  ] as const;
  const chains = new PlayCallChain(worlds);
  await startChain(chains, queued, "queued-0");
  await startChain(chains, others[0], "queued-1");
  await startChain(chains, others[1], "queued-2");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = worlds.operations.withWorldAuthorityLock(
    queued,
    () => held,
  );
  await startChain(chains, others[2], "queued-3");
  await vi.waitFor(() =>
    expect(chains.residentWorldIds()).toEqual([queued, others[1], others[2]]),
  );
  release();
  await operation;
  const fifth = await createWorldIn(worlds, "residency-queued-e");
  await startChain(chains, fifth, "queued-4");
  await vi.waitFor(() =>
    expect(chains.residentWorldIds()).toEqual([others[1], others[2], fifth]),
  );
});

test("回收后继续游玩、修改玩家消息并读取上下文，结果与未回收的会话一致（#93）", async () => {
  const { worlds, worldId: evicted } = await createWorld(
    "residency-equivalent",
  );
  const control = await createWorldIn(worlds, "residency-equivalent-control");
  const extra = [
    await createWorldIn(worlds, "residency-equivalent-b"),
    await createWorldIn(worlds, "residency-equivalent-c"),
    await createWorldIn(worlds, "residency-equivalent-d"),
  ];
  const chains = new PlayCallChain(worlds);
  const controlChains = new PlayCallChain(worlds);
  const playThrough = async (
    playChains: PlayCallChain,
    worldId: string,
    label: string,
    between: () => Promise<void>,
  ) => {
    const host = scriptedHost(
      "第一段回复",
      "第二段回复",
      "第三段回复",
      "修正后的回复",
    );
    await playChains.start({
      worldId,
      chainId: `${label}-chain`,
      exchangeId: `${label}-first`,
      playerText: "第一次行动",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: host,
    });
    const second = await playChains.append({
      worldId,
      chainId: `${label}-chain`,
      exchangeId: `${label}-second`,
      playerText: "第二次行动",
      modelHost: host,
    });
    await between();
    const secondPlayer = second.events.findLast(
      (event) => event.kind === "player",
    )!;
    const revised = await playChains.revisePlayer({
      operationId: `${label}-revise`,
      worldId,
      chainId: second.chainId,
      eventId: secondPlayer.id,
      replacementExchangeId: `${label}-replacement`,
      replacementText: "第二次行动（修正）",
      continuation: "continue_context",
    });
    const continued = await playChains.append({
      worldId,
      chainId: revised.playCallChain.chainId,
      exchangeId: `${label}-third`,
      playerText: "第三次行动",
      modelHost: host,
    });
    const reading = await playChains.inspectReading(
      worldId,
      continued.parentHead,
    );
    return {
      revised: playTrace(revised.playCallChain),
      continued: playTrace(continued),
      reading: {
        requestExchange: reading?.requestExchange,
        promptExchanges: reading?.promptHistory?.map((run) => run.exchange),
      },
    };
  };
  const evictedTrace = await playThrough(
    chains,
    evicted,
    "evicted",
    async () => {
      for (const [index, worldId] of extra.entries())
        await startChain(chains, worldId, `equivalent-${index}`);
      await vi.waitFor(() =>
        expect(chains.residentWorldIds()).not.toContain(evicted),
      );
    },
  );
  const controlTrace = await playThrough(
    controlChains,
    control,
    "control",
    () => Promise.resolve(),
  );
  expect(evictedTrace).toEqual(controlTrace);
});

test("回收与同一世界的读取交错时，读取不写回旧会话，发送结果不丢失（#93）", async () => {
  const { worlds, worldId: evicted } = await createWorld(
    "residency-interleave",
  );
  const others = [
    await createWorldIn(worlds, "residency-interleave-b"),
    await createWorldIn(worlds, "residency-interleave-c"),
    await createWorldIn(worlds, "residency-interleave-d"),
  ] as const;
  const chains = new PlayCallChain(worlds);
  await startChain(chains, evicted, "interleave");
  await startChain(chains, others[0], "interleave-b");
  await startChain(chains, others[1], "interleave-c");
  // Injection point: the read pauses after it has loaded the evicted session.
  const readCurrent = worlds.playAdvances.readCurrent.bind(worlds.playAdvances);
  let reachGate!: () => void;
  const readPaused = new Promise<void>((resolve) => {
    reachGate = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  vi.spyOn(worlds.playAdvances, "readCurrent").mockImplementation(
    async (worldId, chainId) => {
      if (worldId === evicted && !paused) {
        paused = true;
        reachGate();
        await gate;
      }
      return readCurrent(worldId, chainId);
    },
  );
  const reading = chains.inspectWorld(evicted);
  await readPaused;
  // While the read is paused, the evicted world becomes least recently used.
  await chains.inspectWorld(others[0]);
  await chains.inspectWorld(others[1]);
  await startChain(chains, others[2], "interleave-d");
  await vi.waitFor(() =>
    expect(chains.residentWorldIds()).toEqual([
      others[0],
      others[1],
      others[2],
    ]),
  );
  const sent = await chains.append({
    worldId: evicted,
    chainId: "interleave-chain",
    exchangeId: "interleave-send",
    playerText: "发送中的行动",
    modelHost: scriptedHost("发送后的回复"),
  });
  release();
  const observed = await reading;
  expect(observed).not.toBeNull();
  expect(playTrace(observed!)).toEqual(playTrace(sent));
  const durable = await new PlayCallChain(worlds).inspectWorld(evicted);
  expect(playTrace(durable!)).toEqual(playTrace(sent));
  expect(
    sent.events.filter(
      (event) => event.kind === "player" && event.text === "发送中的行动",
    ),
  ).toHaveLength(1);
});

/** Opens another world in an existing store; residency tests need several. */
async function createWorldIn(
  worlds: FileNativeWorldStore,
  label: string,
): Promise<string> {
  const created = await worlds.createFromContentPackage({
    operationId: `create-${label}-world`,
    sourcePackageId: `${label}-package`,
    sourcePackageTitle: `${label} package`,
    packageFiles: worldFiles(),
    prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  return created.world.worldId;
}

function scriptedHost(...texts: string[]): ScriptedModelHost {
  return new ScriptedModelHost({
    binding: modelBinding(),
    steps: texts.map((text) => ({ outcome: "response", text })),
  });
}

/** Starts a one-exchange chain whose chain ID is `${label}-chain`. */
function startChain(chains: PlayCallChain, worldId: string, label: string) {
  return chains.start({
    worldId,
    chainId: `${label}-chain`,
    exchangeId: `${label}-start`,
    playerText: "进入房间。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: scriptedHost(`${label} 回复`),
  });
}

/** The in-progress advance marker of a call chain (ADR-0044). */
function advanceMarkerPath(
  root: string,
  worldId: string,
  chainId: string,
): string {
  return join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-advances",
    createHash("sha256").update(chainId).digest("hex"),
    "in-progress.json",
  );
}

/** Observable play state, without IDs that legitimately differ between worlds. */
function playTrace(view: V1PlayCallChainView) {
  return {
    status: view.status,
    events: view.events.map((event) => [
      event.kind,
      "text" in event ? event.text : undefined,
    ]),
  };
}

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

test("删除进行中生成的世界：先中止生成再删除，删除成功且生成以中断结束（#72）", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-delete-during-generation",
  );
  let markExchangeStarted: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  const modelHost: ModelHost = {
    binding: modelBinding,
    async exchange(_request, observer) {
      const signal = observer?.signal;
      markExchangeStarted?.();
      return new Promise<ModelHostResponse>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  };
  const chains = new PlayCallChain(worlds);
  const running = chains.start({
    worldId,
    chainId: "play-chain-delete-during-generation",
    exchangeId: "exchange-delete-during-generation",
    playerText: "I walk out of the room while the story is generating.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await exchangeStarted;

  await chains.abortWorld(worldId);
  chains.forgetWorld(worldId);
  await expect(worlds.deleteWorld(worldId)).resolves.toEqual({ deleted: true });
  await running.catch(() => undefined);
  await expect(worlds.recoverEndpoint(worldId)).rejects.toThrow();
});

test("Provider 游玩调用持有世界使用权，结束前不能开启修订 epoch", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-world-revision-lock",
  );
  let markExchangeStarted: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  let finishExchange: (() => void) | undefined;
  const providerRelease = new Promise<void>((resolve) => {
    finishExchange = resolve;
  });
  const text = "Alex waits until the world revision can safely begin.";
  const modelHost: ModelHost = {
    binding: modelBinding,
    async exchange() {
      markExchangeStarted?.();
      await providerRelease;
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
    chainId: "play-chain-world-revision-lock-contract",
    exchangeId: "exchange-world-revision-lock",
    playerText: "I wait before revising the world.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await exchangeStarted;

  const workspace = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(root),
    worlds,
  });
  await expect(workspace.open(worldId)).rejects.toThrow(
    /operation is still finishing/u,
  );
  expect(await worlds.readWorldRevisionLock(worldId)).toBeNull();

  finishExchange?.();
  await expect(running).resolves.toMatchObject({ status: "ready" });
  const epoch = await workspace.open(worldId);
  expect(epoch.lifecycle).toBe("active");
  await workspace.discard({ worldId, epochId: epoch.epochId });
});

test.each(["manual", "ai"] as const)(
  "%s 世界修订应用后冷恢复旧游玩授权，并允许开启新上下文",
  async (source) => {
    const { worlds, worldId, root } = await createWorld(
      "revision-authorization",
    );
    const chains = new PlayCallChain(worlds);
    const before = await chains.start({
      worldId,
      chainId: "before-revision",
      exchangeId: "before-revision",
      playerText: "Wait.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: new ScriptedModelHost({
        binding: modelBinding(),
        steps: [{ outcome: "response", text: "Alex waits." }],
      }),
    });
    const workspace = new WorldRevisionWorkspace({
      store: new FileNativeWorldRevisionStore(root),
      worlds,
    });
    let epoch = await workspace.open(worldId);
    const path = "state/current-situation.yaml";
    const beforeContents = epoch.files.find(
      (file) => file.path === path,
    )!.contents;
    const afterContents = beforeContents + "\nrevisionNote: revised\n";
    const files = epoch.files.map((file) =>
      file.path === path ? { ...file, contents: afterContents } : file,
    );
    const update = {
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files,
    };
    epoch =
      source === "manual"
        ? await workspace.replace(update)
        : await workspace.publishAi({
            ...update,
            afterRevision: contentTreeFingerprint(files),
            toolResults: [
              {
                toolCallId: "revision-write",
                markdown: "updated",
                isError: false,
                changeSetId: "change-set:00000000-0000-4000-8000-000000000001",
                changes: [
                  {
                    path,
                    kind: "modify",
                    before: beforeContents,
                    after: afterContents,
                  },
                ],
              },
            ],
          });
    expect(epoch.changes.at(-1)?.source).toBe(source);
    await workspace.apply({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
    });
    const revisedHead = await worlds.currentHead(worldId);
    expect(revisedHead).not.toBe(before.parentHead);
    const restored = new PlayCallChain(new FileNativeWorldStore(root));
    await expect(restored.inspectWorld(worldId)).resolves.toMatchObject({
      chainId: before.chainId,
      parentHead: before.parentHead,
      status: "ready",
    });
    await expect(restored.observeWorld(worldId)).resolves.toMatchObject({
      chainId: before.chainId,
    });
    await expect(
      restored.append({
        worldId,
        chainId: before.chainId,
        exchangeId: "stale-append",
        playerText: "Continue.",
        modelHost: new ScriptedModelHost({
          binding: modelBinding(),
          steps: [],
        }),
      }),
    ).rejects.toThrow(/fresh context/u);
    await expect(
      restored.start({
        worldId,
        chainId: "after-revision",
        exchangeId: "after-revision",
        playerText: "Continue.",
        hostBinding: hostBinding(),
        playPreset: playPreset(),
        modelBinding: modelBinding(),
        modelHost: new ScriptedModelHost({
          binding: modelBinding(),
          steps: [{ outcome: "response", text: "Continued." }],
        }),
      }),
    ).resolves.toMatchObject({ chainId: "after-revision", status: "ready" });
  },
);

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
  expect(sent(modelHost.requests[1]!).at(-1)).toMatchObject({
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
  const { worlds, worldId, root } = await createWorld("play-chain");
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
  expect(sent(modelHost.requests[1]!).at(-1)).toMatchObject({
    kind: "runtime_notice",
    notice: "tool_step",
  });
  expect(sent(modelHost.requests[1]!).at(-2)).toEqual({
    kind: "tool",
    toolCallId: "patch-door",
    markdown: patchDetail.markdown,
  });
  expect(sent(modelHost.requests[1]!).at(-3)).toMatchObject({
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
    "history_search",
    "history_read",
    "context_search",
    "context_read",
    "world_patch",
    "world_create",
    "world_retire",
    "world_checkpoint",
  ]);
  expect(modelHost.requests[0]?.maxOutputTokens).toBe(
    modelBinding().maxOutputTokens,
  );
  expect(sent(modelHost.requests[0]!)).toEqual([
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
    "only the opening exists",
  );
  const authorPrompt = modelHost.requests[0]?.bootstrap.logicalMessages
    .filter(({ role }) => role === "author_instruction")
    .map(({ markdown }) => markdown)
    .join("\n");
  // The play narrative block enters bootstrap as an ordinary author instruction.
  expect(authorPrompt).toContain(
    "meaningful silence, solitude, rest and waiting",
  );
  expect(
    modelHost.requests[0]?.bootstrap.logicalMessages
      .filter(({ role }) => role === "runtime_system")
      .map(({ markdown }) => markdown)
      .join("\n"),
  ).toContain("Responses containing tool calls are intermediate steps");

  const restored = new PlayCallChain(new FileNativeWorldStore(root));
  const continued = await restored.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-second",
    playerText: "I walk into the corridor.",
    modelHost,
  });

  expect(continued).toMatchObject({ status: "ready", parentHead: "commit:5" });
  expect(sent(modelHost.requests.at(-1)!).at(-1)).toEqual({
    kind: "player",
    text: "I walk into the corridor.",
  });
  const requestCount = modelHost.requests.length;
  const duplicateAppend = await restored.append({
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

test("整理检查点随最终叙事提交，冷启动保留边界并补入跨上下文原文", async () => {
  const { worlds, worldId } = await createWorld("narrative-checkpoint");
  const firstHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          { id: "checkpoint", name: "world_checkpoint", arguments: {} },
        ],
      },
      { outcome: "response", text: "此事已经告一段落。" },
    ],
  });
  const start = (
    chains: PlayCallChain,
    chainId: string,
    playerText: string,
    modelHost: ScriptedModelHost,
  ) =>
    chains.start({
      worldId,
      chainId,
      exchangeId: chainId,
      playerText,
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost,
    });
  await start(
    new PlayCallChain(worlds),
    "checkpoint-first",
    "我们结束讨论。",
    firstHost,
  );
  expect(sent(firstHost.requests[1]!).at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "checkpoint",
    markdown: expect.stringContaining("registered") as unknown,
  });
  expect(await worlds.recoverEndpoint(worldId)).toMatchObject({
    narrativeCheckpoint: {
      head: "commit:2",
      historyMessageId: "message.2.1.narrator",
      completedPlayerRounds: 1,
    },
  });
  const secondHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "  你拿起窗边的蓝色花瓶。\n" }],
  });
  await start(
    new PlayCallChain(worlds),
    "checkpoint-second",
    "  我拿起蓝色花瓶。\n",
    secondHost,
  );
  expect(JSON.stringify(secondHost.requests[0]?.appended)).not.toContain(
    "checkpoint_rounds",
  );
  const thirdHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "你将花瓶递给 Alex。" }],
  });
  await start(
    new PlayCallChain(worlds),
    "checkpoint-third",
    "递给 Alex。",
    thirdHost,
  );
  const replay = thirdHost.requests[0]?.bootstrap.logicalMessages
    .flatMap(({ blocks }) => blocks)
    .filter(({ source }) => source.startsWith("runtime:checkpoint-history"));
  expect(replay?.map(({ markdown }) => markdown).join("\n")).toContain(
    "  我拿起蓝色花瓶。\n",
  );
  expect(replay?.map(({ markdown }) => markdown).join("\n")).toContain(
    "  你拿起窗边的蓝色花瓶。\n",
  );
  expect(JSON.stringify(replay)).not.toContain("我们结束讨论");
  expect(JSON.stringify(replay)).not.toContain("world_checkpoint");
  expect(JSON.stringify(thirdHost.requests[0]?.appended)).not.toContain(
    "checkpoint_rounds",
  );
});

test.each(
  (["en", "zh-CN"] as const).flatMap((locale) =>
    [false, true].map((legacyCheckpoint) => ({ locale, legacyCheckpoint })),
  ),
)(
  "活动中途主动开新上下文保留进展与待回应原话：$locale/旧检查点=$legacyCheckpoint",
  async ({ locale, legacyCheckpoint }) => {
    const files = worldFiles().map((file) =>
      file.path === "control/frame.yaml"
        ? {
            ...file,
            contents: file.contents.replace(
              "  - slot: { kind: history, recent: 2 }\n",
              "",
            ),
          }
        : file,
    );
    const { worlds, worldId, root } = await createWorld(
      `ongoing-checkpoint-${locale}`,
      files,
    );
    const preset = builtinDefaultPlayPresetBinding(locale);
    const prompt = presetHostBinding(preset);
    const feedback =
      "Try keeping your wrist level. Does this grip feel comfortable?";
    const final = `Alex guides the first movement and says: “${feedback}”`;
    const intermediate = "Unshown draft of the lesson's first movement.";
    const host = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          text: intermediate,
          toolCalls: [
            {
              id: "save-progress",
              name: "world_patch",
              arguments: {
                target: "@current-situation",
                edits: [
                  {
                    op: "add",
                    locator: { yaml: ["lesson"] },
                    value: {
                      status: "ongoing",
                      progress:
                        "First movement demonstrated; practice has not finished.",
                      awaitingPlayerResponse: feedback,
                    },
                  },
                ],
              },
            },
            ...(legacyCheckpoint
              ? [{ id: "checkpoint", name: "world_checkpoint", arguments: {} }]
              : []),
          ],
        },
        { outcome: "response", text: final },
      ],
    });
    const first = await new PlayCallChain(
      worlds,
      new FileNativePromptCompiler({ locale }),
    ).start({
      worldId,
      chainId: "ongoing",
      exchangeId: "start-lesson",
      playerText: "Begin teaching me the first movement.",
      hostBinding: prompt,
      playPreset: preset,
      modelBinding: modelBinding(),
      modelHost: host,
    });
    expect(first.status).toBe("ready");
    const endpoint = await worlds.recoverEndpoint(worldId);
    if (legacyCheckpoint)
      expect(endpoint.narrativeCheckpoint).toMatchObject({
        head: first.parentHead,
        completedPlayerRounds: 1,
      });
    else expect(endpoint.narrativeCheckpoint).toBeUndefined();
    expect(endpoint.history.at(-1)?.exactText).toBe(final);
    expect(
      endpoint.history.some(({ exactText }) => exactText === intermediate),
    ).toBe(false);
    expect(sent(host.requests[1]!).at(-1)).toMatchObject({
      kind: "runtime_notice",
      notice: "tool_step",
    });
    const pendingState = endpoint.state.find(
      ({ path }) => path === "current-situation.yaml",
    )!.contents;
    expect(pendingState).toContain("status: ongoing");
    expect(pendingState).toContain(feedback);
    const next = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          text: "Alex keeps the demonstration in place as you adjust your wrist.",
        },
      ],
    });
    await new PlayCallChain(
      new FileNativeWorldStore(root),
      new FileNativePromptCompiler({ locale }),
    ).start({
      worldId,
      chainId: "fresh-ongoing",
      exchangeId: "respond-to-feedback",
      playerText: "I adjust my wrist and ask him to check the angle.",
      hostBinding: prompt,
      playPreset: preset,
      modelBinding: modelBinding(),
      modelHost: next,
    });
    const bootstrap = next.requests[0]!.bootstrap;
    const materials = bootstrap.logicalMessages
      .filter(({ role }) => role === "world_context")
      .map(({ markdown }) => markdown)
      .join("\n");
    expect(materials).toContain(
      "First movement demonstrated; practice has not finished.",
    );
    expect(materials).toContain(feedback);
    expect(materials).not.toContain(intermediate);
    if (legacyCheckpoint) expect(materials).not.toContain(final);
    else expect(materials).toContain(final);
    const replay = bootstrap.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .filter(({ source }) => source.startsWith("runtime:checkpoint-history"));
    if (legacyCheckpoint) expect(replay).toEqual([]);
    else {
      const originals = replay.map(({ markdown }) => markdown).join("\n");
      expect(originals).toContain("Begin teaching me the first movement.");
      expect(originals).toContain(final);
    }
    expect(sent(next.requests[0]!)).toEqual([
      {
        kind: "player",
        text: "I adjust my wrist and ask him to check the angle.",
      },
    ]);
    expect(
      (await worlds.recoverEndpoint(worldId)).state.find(
        ({ path }) => path === "current-situation.yaml",
      )?.contents,
    ).toBe(pendingState);
  },
);

test("登记后补齐收尾承诺，再过一轮切换上下文时仍从状态取得结果", async () => {
  const { worlds, worldId } = await createWorld("checkpoint-closing-write");
  const promise = "Alex will return the medicine money tomorrow at the ferry.";
  const closing =
    "He promises to bring the medicine money to the ferry tomorrow.";
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          { id: "checkpoint", name: "world_checkpoint", arguments: {} },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "save-closing",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "add", locator: { yaml: ["promise"] }, value: promise },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: closing },
      { outcome: "response", text: "You reach the inn." },
      { outcome: "response", text: "Morning arrives." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "closing",
    exchangeId: "first",
    playerText: "Finish this scene",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  expect(
    first.events.find(
      (event) =>
        event.kind === "tool_result" && event.callId === "save-closing",
    ),
  ).toMatchObject({ ok: true });
  const checkpoint = (await worlds.recoverEndpoint(worldId))
    .narrativeCheckpoint;
  expect(checkpoint?.head).toBe(first.parentHead);
  await chains.append({
    worldId,
    chainId: "closing",
    exchangeId: "later",
    playerText: "Go to the inn",
    modelHost: host,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: playPreset(),
      }),
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "fresh-closing",
    exchangeId: "fresh",
    playerText: "Morning",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const bootstrap = host.requests.at(-1)!.bootstrap;
  const text = bootstrap.logicalMessages
    .map(({ markdown }) => markdown)
    .join("\n");
  expect(text).toContain(promise);
  expect(text).toContain("You reach the inn.");
  expect(text).not.toContain(closing);
  expect(
    (await worlds.bindPlayCallChain(worldId)).history[
      checkpoint!.historyMessageId
    ],
  ).toBe(closing);
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
  const receipt = sent(modelHost.requests[2]!).at(-1);
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

test("维护诊断失败不阻断已提交写入、终态叙事或冷恢复", async () => {
  const { worlds, worldId } = await createWorld("maintenance-failure");
  const original = worlds.readDocumentMaintenance.bind(worlds);
  let reads = 0;
  vi.spyOn(worlds, "readDocumentMaintenance").mockImplementation((...args) =>
    ++reads === 1
      ? original(...args)
      : Promise.reject(new Error("maintenance unavailable")),
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "write",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "Alex 已打开门。",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "context_read",
            arguments: { ref: "@current-situation" },
          },
        ],
      },
      { outcome: "response", text: "Alex 推开门。" },
    ],
  });
  const completed = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "maintenance-failure",
    exchangeId: "first",
    playerText: "打开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  expect(completed.status).toBe("ready");
  expect(completed.parentHead).toBe("commit:3");
  expect(host.requests).toHaveLength(3);
  expect(JSON.stringify(sent(host.requests.at(-1)!).at(-1))).toContain(
    "maintenance unavailable",
  );
  expect((await new PlayCallChain(worlds).inspectWorld(worldId))?.status).toBe(
    "ready",
  );
});

test("增长基准与正文写入位置跨重启和分叉保留，摘要修改不刷新正文位置", async () => {
  const files = worldFiles();
  files.find(({ path }) => path === "world/current-situation.yaml")!.contents +=
    "时间: 黄昏\n";
  files.find(({ path }) => path === "control/frame.yaml")!.contents +=
    "maintenance:\n  documents:\n    '@current-situation': 10\n  clock:\n    document: '@current-situation'\n    locator: { yaml: [时间] }\n";
  const { worlds, worldId, root } = await createWorld(
    "document-maintenance",
    files,
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "time",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "replace", locator: { yaml: ["时间"] }, value: "午夜" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "你一直等到午夜。" },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "summary",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [{ op: "set_metadata", summary: "午夜的门边" }],
            },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-position",
            name: "context_read",
            arguments: { ref: "@current-situation" },
          },
        ],
      },
      { outcome: "response", text: "Alex 从门边走来。" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "document-maintenance",
    exchangeId: "first",
    playerText: "等到午夜。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  expect(JSON.stringify(sent(host.requests[1]!).at(-1))).toContain(
    "advisory limit 10",
  );
  const first = (await worlds.readDocumentMaintenance(worldId))[
    "current-situation"
  ]!;
  expect(first).toMatchObject({
    baselineKind: "world_origin",
    lastBodyWrite: { kind: "play", context: 1, round: 1, worldTime: "午夜" },
    bodyChangedContexts: 1,
  });
  await chains.append({
    worldId,
    chainId: "document-maintenance",
    exchangeId: "second",
    playerText: "整理一下这段的摘要。",
    modelHost: host,
  });
  const after = (await worlds.readDocumentMaintenance(worldId))[
    "current-situation"
  ]!;
  expect(after.lastBodyWrite).toEqual(first.lastBodyWrite);
  const readPosition = JSON.stringify(sent(host.requests.at(-1)!).at(-1));
  expect(readPosition).toContain("Body: Context 1 · round 1");
  expect(readPosition).toContain("Metadata: Context 1 · round 2");
  expect(readPosition).toContain("World time at write: 午夜");
  expect(after.lastMetadataWrite).toMatchObject({
    context: 1,
    round: 2,
    worldTime: "午夜",
  });
  expect(after.baselineBytes).toBe(first.baselineBytes);
  expect(after.bodyChangedContexts).toBe(1);
  const restarted = new FileNativeWorldStore(root);
  expect(
    (await restarted.readDocumentMaintenance(worldId))["current-situation"],
  ).toEqual(after);
  const fork = await chains.deriveWorld({
    operationId: "maintenance-fork",
    sourceWorldId: worldId,
    sourceHead: "commit:6",
    hostPresetId: "host-main",
  });
  expect(
    (await worlds.readDocumentMaintenance(fork.world.worldId))[
      "current-situation"
    ],
  ).toEqual(after);
  const forkContext = await chains.inspectWorld(fork.world.worldId);
  const forkHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "fork-time",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "replace", locator: { yaml: ["时间"] }, value: "凌晨" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "天色将明。" },
    ],
  });
  const forkThird = await chains.append({
    worldId: fork.world.worldId,
    chainId: forkContext!.chainId,
    exchangeId: "fork-third",
    playerText: "等一阵。",
    modelHost: forkHost,
  });
  expect(
    (await worlds.readDocumentMaintenance(fork.world.worldId))[
      "current-situation"
    ],
  ).toMatchObject({
    lastBodyWrite: { context: 1, round: 3 },
    bodyChangedContexts: 1,
    observedContexts: 1,
  });
  const thirdPlayer = forkThird.events.findLast(
    (event) => event.kind === "player",
  )!;
  const revision = await chains.revisePlayer({
    operationId: "maintenance-revision",
    worldId: fork.world.worldId,
    chainId: forkThird.chainId,
    eventId: thirdPlayer.id,
    replacementExchangeId: "revised-third",
    replacementText: "再等一会。",
    continuation: "continue_context",
  });
  const revisedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "revised-time",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "replace", locator: { yaml: ["时间"] }, value: "清晨" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "窗边透进晨光。" },
    ],
  });
  const resumed = await new PlayCallChain(worlds).append({
    worldId: fork.world.worldId,
    chainId: revision.playCallChain.chainId,
    exchangeId: "resume-third",
    playerText: "",
    modelHost: revisedHost,
  });
  expect(
    (await worlds.readDocumentMaintenance(fork.world.worldId))[
      "current-situation"
    ],
  ).toMatchObject({
    lastBodyWrite: { context: 1, round: 3 },
    bodyChangedContexts: 1,
    observedContexts: 1,
  });
  const nestedFork = await chains.deriveWorld({
    operationId: "maintenance-nested-fork",
    sourceWorldId: fork.world.worldId,
    sourceHead: resumed.parentHead,
    hostPresetId: "host-main",
  });
  const nestedContext = await chains.inspectWorld(nestedFork.world.worldId);
  const nestedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "nested-time",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "replace", locator: { yaml: ["时间"] }, value: "日出" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "太阳升起来。" },
    ],
  });
  await chains.append({
    worldId: nestedFork.world.worldId,
    chainId: nestedContext!.chainId,
    exchangeId: "fourth",
    playerText: "等到日出。",
    modelHost: nestedHost,
  });
  expect(
    (await worlds.readDocumentMaintenance(nestedFork.world.worldId))[
      "current-situation"
    ],
  ).toMatchObject({
    lastBodyWrite: { context: 1, round: 4 },
    bodyChangedContexts: 1,
    observedContexts: 1,
  });
  const noOpHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "same-time",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                { op: "replace", locator: { yaml: ["时间"] }, value: "午夜" },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "仍是午夜。" },
    ],
  });
  await chains.append({
    worldId,
    chainId: "document-maintenance",
    exchangeId: "third",
    playerText: "确认时间。",
    modelHost: noOpHost,
  });
  expect(
    (await worlds.readDocumentMaintenance(worldId))["current-situation"],
  ).toEqual(after);
});

test("相邻上下文诊断保存实际编码，重启后仍能对照缓存键和 Provider usage", async () => {
  const { worlds, worldId, root } = await createWorld("prefix-diagnostics");
  const sent: unknown[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "chat_completions",
      dialect: "cliproxyapi",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "diagnostic-secret",
      modelId: "prefix-model",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
    (_url, options) => {
      if (typeof options?.body !== "string")
        throw new Error("Expected JSON request text");
      sent.push(JSON.parse(options.body) as unknown);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "你走到了门边。" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          }),
        ),
      );
    },
  );
  const chains = new PlayCallChain(worlds);
  for (const chainId of ["prefix-first", "prefix-second"])
    await chains.start({
      worldId,
      chainId,
      exchangeId: chainId,
      playerText: "走到门边。",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: host.binding(),
      modelHost: host,
    });
  expect(
    (await worlds.playTimeline.readInitialEncoding(worldId, "prefix-first"))
      ?.body,
  ).toEqual(sent[0]);
  expect(
    (await worlds.playTimeline.readInitialEncoding(worldId, "prefix-second"))
      ?.body,
  ).toEqual(sent[1]);
  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  const view = await restarted.inspectWorld(worldId);
  const reading = await restarted.inspectReading(worldId, view!.parentHead);
  expect(
    reading?.prefixDiagnostics?.logical?.changedSources.length,
  ).toBeGreaterThan(0);
  expect(reading?.prefixDiagnostics?.encoding.cacheKey).toBe("different");
  expect(
    reading?.prefixDiagnostics?.providerUsage.current?.cacheReadTokens,
  ).toBe(4);
  expect(JSON.stringify(reading?.prefixDiagnostics)).not.toContain(
    "diagnostic-secret",
  );
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
  const diagnostics = vi
    .spyOn(FileNativeWorldStore.prototype, "readDocumentMaintenance")
    .mockRejectedValue(new Error("maintenance unavailable"));
  try {
    const degraded = (
      await runtime.handle({ type: "world.play-context.read", worldId })
    ).result as V1PlayContextReadingView;
    expect(degraded.currentContext?.bootstrap).toEqual(direct?.bootstrap);
    expect(
      degraded.nextFreshContext?.preview.compilation.maintenance
        ?.unavailableReason,
    ).toBe("maintenance unavailable");
  } finally {
    diagnostics.mockRestore();
  }
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
  expect(sent(modelHost.requests[1]!).at(-1)).toEqual({
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
  const listResult = sent(firstHost.requests[1]!).at(-1);
  expect(listResult).toMatchObject({
    kind: "tool",
    toolCallId: "list-empty-items",
  });
  expect(listResult?.kind === "tool" ? listResult.markdown : "").toContain(
    "Directory @dir-/items",
  );
  expect((await worlds.readDocumentMaintenance(worldId)).lantern).toMatchObject(
    {
      baselineKind: "document_creation",
      baselineBytes: Buffer.byteLength("状态: 完好\n", "utf8"),
    },
  );
  expect(sent(firstHost.requests[2]!).at(-1)).toEqual({
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

  expect(sent(secondHost.requests[0]!)).toEqual([
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
  // Forks copy context files byte for byte (no hard links since #79), so the
  // derived context carries the same transcript while its files stay independent.
  {
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
    await expect(readFile(targetTranscript, "utf8")).resolves.toBe(
      await readFile(sourceTranscript, "utf8"),
    );
    const sourceEvent = join(sourceContextRoot, "events", "0000000001.json");
    const targetEvent = join(targetContextRoot, "events", "0000000001.json");
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
        text: "Alex reaches for the door handle.",
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
  expect(sent(continuedToolHost.requests[0]!).map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool",
    "runtime_notice",
  ]);
  expect(sent(continuedToolHost.requests[0]!).at(-1)).toMatchObject({
    kind: "runtime_notice",
    notice: "tool_step",
  });

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
  expect(sent(regeneratedHost.requests[0]!)).toEqual([
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
  expect(await coldWorlds.currentHead(playerBranch.world.worldId)).toMatch(
    /^commit:[1-9][0-9]*$/u,
  );
});

test.each(["continue_context", "fresh_context"] as const)(
  "结算提示与空输入续写提示按历史端点截取，并支持 %s 玩家修订",
  async (continuation) => {
    const { worlds, worldId, root } = await createWorld(
      `play-chain-notice-prefix-${continuation}`,
    );
    const host = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          text: "Alex pauses at the door.",
          toolCalls: [
            { id: "list-before-door", name: "state_list", arguments: {} },
            { id: "list-again", name: "state_list", arguments: {} },
          ],
        },
        { outcome: "response", text: "Alex opens the door." },
        { outcome: "response", text: "A breeze stirs the curtains." },
        { outcome: "response", text: "Alex follows you outside." },
      ],
    });
    const chains = new PlayCallChain(worlds);
    const initial = await chains.start({
      worldId,
      chainId: `notice-prefix-${continuation}`,
      exchangeId: "open-door",
      playerText: "I ask Alex to open the door.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: host,
    });
    const initialTranscript = (await worlds.playTimeline.readCurrent(worldId))!
      .value.transcript;
    const continued = await chains.append({
      worldId,
      chainId: initial.chainId,
      exchangeId: "notice-continue",
      playerText: "",
      modelHost: host,
    });
    const continuedTranscript = (await worlds.playTimeline.readCurrent(
      worldId,
    ))!.value.transcript;
    const latest = await chains.append({
      worldId,
      chainId: initial.chainId,
      exchangeId: "leave-room",
      playerText: "I go outside.",
      modelHost: host,
    });

    // Both endpoints are historical: the complete-context copy shortcut must
    // not hide bugs in notice-aware prefix reconstruction.
    const coldWorlds = new FileNativeWorldStore(root);
    const coldChains = new PlayCallChain(coldWorlds);
    for (const [label, head, expected] of [
      ["initial", initial.parentHead, initialTranscript],
      ["continued", continued.parentHead, continuedTranscript],
    ] as const) {
      const branch = await coldChains.deriveWorld({
        operationId: `notice-prefix-fork-${label}-${continuation}`,
        sourceWorldId: worldId,
        sourceHead: head,
        hostPresetId: "host-current",
      });
      const saved = await coldWorlds.playTimeline.readCurrent(
        branch.world.worldId,
      );
      expect(saved!.value.transcript).toEqual(expected);
    }
    expect(
      continuedTranscript
        .filter((item) => item.kind === "runtime_notice")
        .map(({ notice }) => notice),
    ).toEqual(["tool_step", "continuation"]);

    const selected = latest.events.find(
      (event) => event.kind === "player" && event.exchangeId === "leave-room",
    );
    const revised = await coldChains.revisePlayer({
      operationId: `notice-prefix-revise-${continuation}`,
      worldId,
      chainId: latest.chainId,
      eventId: selected!.id,
      replacementExchangeId: "stay-in-room",
      replacementText: "I stay inside.",
      ...(continuation === "fresh_context"
        ? {
            continuation,
            freshContext: {
              hostBinding: hostBinding(),
              playPreset: playPreset(),
              modelBinding: modelBinding(),
            },
          }
        : { continuation }),
    });
    const replacementHost = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "Alex waits by the open door." }],
    });
    await new PlayCallChain(new FileNativeWorldStore(root)).append({
      worldId,
      chainId: revised.playCallChain.chainId,
      exchangeId: "generate-revised-notice-prefix",
      playerText: "",
      modelHost: replacementHost,
    });
    expect(sent(replacementHost.requests[0]!)).toEqual([
      ...(continuation === "continue_context" ? continuedTranscript : []),
      { kind: "player", text: "I stay inside." },
    ]);
    expect(
      (await coldWorlds.recoverEndpoint(worldId)).history.map(
        ({ exactText }) => exactText,
      ),
    ).toEqual([
      "门外传来三声短促的铃响。\n",
      "I ask Alex to open the door.",
      "Alex opens the door.",
      "A breeze stirs the curtains.",
      "I stay inside.",
      "Alex waits by the open door.",
    ]);
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
    parentHead: "commit:6",
    status: "ready",
  });
  expect(revised.playCallChain.chainId).not.toBe(source.chainId);
  expect(
    revised.playCallChain.events
      .filter((event) => event.kind === "player")
      .map(({ committedHead }) => committedHead),
  ).toEqual(["commit:1", "commit:6"]);
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
      playCallChain: { parentHead: "commit:6" },
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
  // 修订丢弃了 commit:4 之后的端点，旧端点不再可达。
  await expect(worlds.recoverEndpoint(worldId, "commit:4")).rejects.toThrow();
  // 修订先回退到 commit:2，再追加修改稿：轮号不重用，修改稿是新的提交。
  const authority = await worlds.readAuthorityHistory(worldId);
  expect(authority.commits.map(({ head }) => head)).toEqual([
    "commit:1",
    "commit:2",
    "commit:6",
    "commit:7",
  ]);
  expect(authority.commits[2]).toMatchObject({
    mode: "play",
    parentHead: "commit:2",
    head: "commit:6",
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
    playPreset: playPreset(legacyDefaultPlayPresetFilesForLocale("en")),
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
    ...playPreset(legacyDefaultPlayPresetFilesForLocale("en")),
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
    parentHead: "commit:4",
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
        committedHead: "commit:4",
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
  // 同一操作重放会得到同一提交；按续传方式区分的拒绝依赖已删除的 requestFingerprint（#79），
  // 编辑请求的重放语义留给 #75 定义。
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
    playPreset: playPreset(legacyDefaultPlayPresetFilesForLocale("en")),
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
        playPreset: playPreset(legacyDefaultPlayPresetFilesForLocale("en")),
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
      committedHead: "commit:6",
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
  expect(sent(replacementHost.requests[0]!)).toEqual([
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

test.each(["en", "zh-CN"] as const)(
  "冻结旧请求冷启动重发保留回合提示与工具定义，新发送不增加提示：%s",
  async (locale) => {
    const fixture = JSON.parse(
      gunzipSync(
        await readFile(
          new URL(
            "./fixtures/released-v056-checkpoint/storage.json.gz",
            import.meta.url,
          ),
        ),
      ).toString("utf8"),
    ) as {
      sourceCommit: string;
      files: Record<string, string>;
      scenarios: {
        locale: "en" | "zh-CN";
        worldId: string;
        chainId: string;
        head: string;
        request: ModelHostExchange;
      }[];
    };
    expect(fixture.sourceCommit).toBe(
      "2cd320bb6a5f4cc37b0d6d8049c175b03cc9d450",
    );
    const root = await mkdtemp(join(tmpdir(), "checkpoint-recovery-"));
    roots.push(root);
    for (const [path, contents] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const scenario = fixture.scenarios.find(
      (value) => value.locale === locale,
    )!;
    const { worldId } = scenario;
    const worlds = new FileNativeWorldStore(root);
    await worlds.ensureCurrentStorage(worldId);
    const frozen = (await worlds.playTimeline.readCurrent(worldId))!.value;
    if (frozen.modelBinding === undefined)
      throw new Error("Historical fixture is missing its model binding");
    expect(frozen.lastRequest).toEqual(scenario.request);
    const oldRequest = scenario.request;
    const marker = oldRequest.appended[0];
    if (marker?.kind !== "runtime_notice")
      throw new Error("Missing old round marker");
    expect(marker.notice).toBe("checkpoint_rounds");
    const oldDescription = oldRequest.tools.find(
      ({ name }) => name === "world_checkpoint",
    )!.description;
    expect(oldDescription).toContain(
      locale === "zh-CN" ? "登记整理声明" : "consolidation declaration",
    );
    const resumed = new ScriptedModelHost({
      binding: frozen.modelBinding,
      steps: [
        {
          outcome: "response",
          text: "Alex demonstrates and waits for your response.",
        },
        { outcome: "response", text: "Alex checks your wrist angle." },
      ],
    });
    const chains = new PlayCallChain(
      new FileNativeWorldStore(root),
      new FileNativePromptCompiler({ locale }),
    );
    const retry = await chains.append({
      worldId,
      chainId: frozen.chainId,
      exchangeId: "retry",
      playerText: "",
      modelHost: resumed,
      resolvePrompt: () => {
        throw new Error("Retry must not recompile presets.");
      },
    });
    expect(retry.status).toBe("ready");
    expect(resumed.requests[0]).toEqual(oldRequest);
    expect(resumed.requests[0]!.appended[0]).toEqual(marker);
    expect(
      resumed.requests[0]!.tools.find(
        ({ name }) => name === "world_checkpoint",
      )!.description,
    ).toBe(oldDescription);
    const branch = await chains.deriveWorld({
      operationId: `legacy-marker-fork-${locale}`,
      sourceWorldId: worldId,
      sourceHead: scenario.head,
      hostPresetId: frozen.playPreset.id,
    });
    expect(
      (await worlds.playTimeline.readCurrent(branch.world.worldId))!.value
        .transcript,
    ).toEqual(oldRequest.appended);
    await chains.append({
      worldId,
      chainId: frozen.chainId,
      exchangeId: "next-input",
      playerText: "I adjust my wrist.",
      modelHost: resumed,
      resolvePrompt: () =>
        Promise.resolve({
          hostBinding: hostBinding(),
          playPreset: playPreset(),
        }),
    });
    expect(
      resumed.requests[1]!.appended.filter(
        (item) =>
          item.kind === "runtime_notice" && item.notice === "checkpoint_rounds",
      ),
    ).toEqual([marker]);
    expect(sent(resumed.requests[1]!).at(-1)).toEqual({
      kind: "player",
      text: "I adjust my wrist.",
    });
    expect(
      (await worlds.recoverEndpoint(worldId)).history.map(
        ({ exactText }) => exactText,
      ),
    ).not.toContain(marker.text);
    const contextRequests = join(
      root,
      "worlds-file-native",
      worldId,
      "runtime",
      "play-contexts",
      createHash("sha256").update(frozen.chainId).digest("hex"),
      "requests",
    );
    // The resumed send replaced the frozen request; only the context's current one remains.
    const [currentRequest] = await readdir(contextRequests);
    expect(await readdir(contextRequests)).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(contextRequests, currentRequest!), "utf8"),
      ),
    ).toEqual(
      (await worlds.playTimeline.readCurrent(worldId))!.value.lastRequest,
    );
  },
);

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
  expect(sent(modelHost.requests[1]!)).toEqual([
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
    {
      kind: "runtime_notice",
      notice: "continuation",
      text: "[Runtime continuation]\nThis send adds no new player input. Existing final narrator prose has been displayed and committed as history; this response follows it, resuming from that prose's final situation and advancing only existing actions, NPCs and the environment: do not answer an already answered question again, reset a completed handover or movement, perform the old player input again, add a decision for the player, or accept an invitation or make a promise on their behalf. A committed reply does not mean an in-world activity has ended.",
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

test("切换协议只临时拒绝，切回原协议后允许继续", async () => {
  const { worlds, worldId } = await createWorld("play-binding-switch");
  const initialHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "First response." }],
  });
  const chains = new PlayCallChain(worlds);
  const initial = await chains.start({
    worldId,
    chainId: "protocol-switch",
    exchangeId: "first",
    playerText: "Begin.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: initialHost,
  });
  const switched = new ScriptedModelHost({
    binding: { ...modelBinding(), provider: "anthropic_messages" },
    steps: [],
  });
  await expect(
    chains.append({
      worldId,
      chainId: initial.chainId,
      exchangeId: "wrong",
      playerText: "Next.",
      modelHost: switched,
    }),
  ).rejects.toThrow(/protocol/i);
  expect(switched.requests).toHaveLength(0);
  expect(await new PlayCallChain(worlds).inspectWorld(worldId)).toMatchObject({
    status: "ready",
    lastFailure: null,
  });
  const changed = new ScriptedModelHost({
    binding: {
      ...modelBinding(),
      modelId: "other-model",
      endpointFingerprint: "other",
      protocolConfigFingerprint: "changed-thinking",
      maxOutputTokens: 8192,
      contextWindowTokens: 256000,
    },
    steps: [{ outcome: "response", text: "Continued." }],
  });
  const result = await new PlayCallChain(worlds).append({
    worldId,
    chainId: initial.chainId,
    exchangeId: "back",
    playerText: "Next.",
    modelHost: changed,
  });
  expect(result.status).toBe("ready");
  expect(changed.requests[0]?.maxOutputTokens).toBe(8192);
  expect(changed.requests[0]?.appended).toContainEqual(
    expect.objectContaining({ kind: "assistant", text: "First response." }),
  );
});

test.each(["binding", "outcome_unknown", "binding_over_unknown"] as const)(
  "旧配置拦截可恢复但真实未知结果不恢复：%s",
  async (kind) => {
    const { worlds, worldId } = await createWorld("legacy-binding-recovery");
    const host = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "Before configuration change." }],
    });
    const initial = await new PlayCallChain(worlds).start({
      worldId,
      chainId: "legacy-poison",
      exchangeId: "first",
      playerText: "Begin.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: host,
    });
    const loaded = (await worlds.playTimeline.readCurrent(worldId))!;
    const value = loaded.value;
    value.status = "interrupted";
    value.canRetry = false;
    value.lastFailureKind =
      kind === "binding" ? "context_unavailable" : "outcome_unknown";
    value.lastFailure =
      kind === "binding"
        ? "The selected model connection does not match the frozen model binding; start a fresh context."
        : "The dispatched request outcome is unknown.";
    value.events.push({
      id: value.nextEventId++,
      kind: "failure",
      message: value.lastFailure,
      failureKind: value.lastFailureKind,
    });
    if (kind === "binding_over_unknown") {
      value.lastFailure =
        "The selected model connection does not match the frozen model binding; start a fresh context.";
      value.lastFailureKind = "context_unavailable";
      value.events.push({
        id: value.nextEventId++,
        kind: "failure",
        message: value.lastFailure,
        failureKind: value.lastFailureKind,
      });
    }
    await worlds.playTimeline.persist(value);
    const cold = new PlayCallChain(worlds);
    const expectedStatus = kind === "binding" ? "ready" : "interrupted";
    expect((await worlds.playTimeline.readPage(worldId, 40)).activeStatus).toBe(
      expectedStatus,
    );
    expect((await cold.inspectWorld(worldId))?.status).toBe(expectedStatus);
    const next = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "Recovered." }],
    });
    const append = cold.append({
      worldId,
      chainId: initial.chainId,
      exchangeId: "after",
      playerText: "Continue.",
      modelHost: next,
    });
    if (kind === "binding") expect((await append).status).toBe("ready");
    else {
      await expect(append).rejects.toThrow();
      expect(next.requests).toHaveLength(0);
    }
  },
);

test("冷恢复重试沿用请求模型快照，下一次发送采用当前配置", async () => {
  const { worlds, worldId } = await createWorld("request-model-snapshot");
  const connection = {
    provider: "chat_completions" as const,
    baseUrl: "https://original.invalid/v1",
    apiKey: "secret",
    modelId: "original",
    reasoningEffort: "high" as const,
    contextWindowTokens: 64000,
    maxOutputTokens: 4096,
  };
  const original = new FileNativeModelHost(connection);
  const changed = new FileNativeModelHost({
    ...connection,
    modelId: "changed",
    reasoningEffort: "low",
    contextWindowTokens: 128000,
    maxOutputTokens: 2048,
  });
  const initial = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "request-model-snapshot",
    exchangeId: "first",
    playerText: "Begin.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: original.binding(),
    modelHost: {
      binding: () => original.binding(),
      freezeRequest: (request) => original.freezeRequest(request),
      exchange: () =>
        Promise.reject(new ModelHostFailureError("Rejected before generation")),
    },
  });
  const saved = (await worlds.playTimeline.readCurrent(worldId))!.value
    .lastRequest!;
  expect(initial.canRetry).toBe(true);
  expect(saved.modelConfig?.modelId).toBe("original");
  const scripted = new ScriptedModelHost({
    binding: changed.binding(),
    steps: [
      { outcome: "response", text: "Retried." },
      { outcome: "response", text: "New parameters." },
    ],
  });
  const changedHost: ModelHost = {
    binding: () => changed.binding(),
    freezeRequest: (request) => changed.freezeRequest(request),
    exchange: (request, observer) => scripted.exchange(request, observer),
  };
  const cold = new PlayCallChain(worlds);
  expect(
    (
      await cold.append({
        worldId,
        chainId: initial.chainId,
        exchangeId: "retry",
        playerText: "",
        modelHost: changedHost,
      })
    ).status,
  ).toBe("ready");
  expect(scripted.requests[0]).toEqual(saved);
  expect(changed.previewRequest(scripted.requests[0]!)).toEqual(
    original.previewRequest(saved),
  );
  const next = await cold.append({
    worldId,
    chainId: initial.chainId,
    exchangeId: "next",
    playerText: "Continue.",
    modelHost: changedHost,
  });
  expect(next.status).toBe("ready");
  expect(next.contextWindowTokens).toBe(128000);
  expect(scripted.requests[1]?.modelConfig).toMatchObject({
    modelId: "changed",
    reasoningEffort: "low",
    maxOutputTokens: 2048,
  });
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
  binding: ModelHostBinding = modelBinding(),
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
    prompt: { hostBinding: hostBinding(), modelBinding: binding },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  return { worlds, worldId: created.world.worldId, root };
}

function playPreset(
  files = structuredClone(defaultPlayPresetFiles),
): PlayPresetBinding {
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
    await followupStarted;
    expect(dispatch).toBe(2);
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
  expect(statusRequest.appended.slice(0, mainPrefix.length)).toEqual(
    mainPrefix,
  );
  expect(optionsRequest.appended.slice(0, mainPrefix.length)).toEqual(
    mainPrefix,
  );
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

test("可选产物工具被拒绝会显示失败并保留允许的旧结果", async () => {
  const { worlds, root, worldId } = await createWorld(
    "optional-artifact-failure",
  );
  const artifacts = new FileNativeArtifactStore(root);
  const preset = followupPlayPreset();
  preset.definition.followups = preset.definition.followups.slice(0, 1);
  preset.definition.followups[0]!.artifacts[0]!.required = false;
  preset.definition.followups[0]!.artifacts[0]!.invalidation = "never";
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );
  const first = await chains.start({
    worldId,
    chainId: "optional-panels",
    exchangeId: "first",
    playerText: "Open.",
    hostBinding: hostBinding(),
    playPreset: preset,
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        { outcome: "response", text: "Alex opens." },
        {
          outcome: "response",
          toolCalls: [
            {
              id: "valid-panel",
              name: "artifact_emit",
              arguments: { output: "status_bar", payload: { hp: 9 } },
            },
          ],
        },
      ],
    }),
  });
  await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "second",
    playerText: "Wait.",
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        { outcome: "response", text: "Alex waits." },
        {
          outcome: "response",
          toolCalls: [
            {
              id: "invalid-panel",
              name: "artifact_emit",
              arguments: { output: "undeclared", payload: { hp: 0 } },
            },
          ],
        },
      ],
    }),
  });
  expect(await artifacts.readActiveProjection(worldId)).toMatchObject([
    { payload: { hp: 9 } },
  ]);
  expect(
    (await artifacts.readExtensionSummaries(worldId)).flatMap(
      (item) => item.requests ?? [],
    ),
  ).toContainEqual(
    expect.objectContaining({ requestId: "status", status: "failed" }),
  );
});

test("后置结算通知可读取同端点产物，失败和冷 Runtime 恢复不推进 Authority", async () => {
  const { worlds, root, worldId } = await createWorld("followup-observation");
  const artifacts = new FileNativeArtifactStore(root);
  let releasePanel!: () => void;
  let releaseFailure!: () => void;
  const panelGate = new Promise<void>((resolve) => {
    releasePanel = resolve;
  });
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let markPanelStarted!: () => void;
  let markFailureStarted!: () => void;
  const panelStarted = new Promise<void>((resolve) => {
    markPanelStarted = resolve;
  });
  const failureStarted = new Promise<void>((resolve) => {
    markFailureStarted = resolve;
  });
  let calls = 0;
  const scripted = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex opens the door." },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "panel",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 9 } },
          },
        ],
      },
      { outcome: "failure", message: "second panel failed" },
    ],
  });
  const modelHost: ModelHost = {
    binding: () => scripted.binding(),
    exchange: async (request, options) => {
      calls += 1;
      if (calls === 2) {
        markPanelStarted();
        await panelGate;
      }
      if (calls === 3) {
        markFailureStarted();
        await failureGate;
      }
      return scripted.exchange(request, options);
    },
  };
  const changes: Promise<V1PlayCallChainView | null>[] = [];
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
    undefined,
    () => {
      changes.push(chains.observeWorld(worldId));
    },
  );
  const run = chains.start({
    worldId,
    chainId: "observed-panels",
    exchangeId: "first",
    playerText: "Open the door.",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await panelStarted;
  const head = await worlds.currentHead(worldId);
  expect(await artifacts.readActiveProjection(worldId)).toEqual([]);
  releasePanel();
  await failureStarted;
  expect(
    (await Promise.all(changes)).some(
      (view) =>
        view?.status === "running" &&
        view.events.some(
          (event) => event.kind === "followup" && event.followupId === "status",
        ),
    ),
  ).toBe(true);
  expect(await artifacts.readActiveProjection(worldId)).toMatchObject([
    { payload: { hp: 9 }, head },
  ]);
  expect(await worlds.currentHead(worldId)).toBe(head);
  releaseFailure();
  const completed = await run;
  expect(completed.events).toContainEqual(
    expect.objectContaining({
      kind: "followup",
      followupId: "options",
      failure: expect.any(String) as unknown,
    }),
  );
  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  expect(
    await runtime.handle({ type: "world.play-decorations.read", worldId }),
  ).toMatchObject({
    result: {
      head,
      artifacts: [
        {
          payload: { hp: 9 },
          reply: { chainId: "observed-panels", eventId: 2 },
          attachment: {
            contextId: "observed-panels",
            eventId: 2,
            runId: expect.any(String) as unknown,
          },
        },
      ],
      extensions: [{ status: "recovery_required" }],
    },
  });
  expect(
    (await runtime.handle({ type: "world.read", worldId })).result,
  ).toMatchObject({ head, artifacts: [] });
  expect(await worlds.currentHead(worldId)).toBe(head);
  const fork = await chains.deriveWorld({
    operationId: "artifact-fork",
    sourceWorldId: worldId,
    sourceHead: head,
    hostPresetId: "host-main",
  });
  const forkId = fork.world.worldId;
  const forkDecorations = await runtime.handle({
    type: "world.play-decorations.read",
    worldId: forkId,
  });
  expect(forkDecorations).toMatchObject({
    result: {
      head,
      artifacts: [
        {
          payload: { hp: 9 },
          reply: { eventId: 2 },
          frontend: { status: "ready" },
        },
      ],
    },
  });
  const player = completed.events.find((event) => event.kind === "player")!;
  await chains.revisePlayer({
    operationId: "artifact-revise",
    worldId,
    chainId: completed.chainId,
    eventId: player.id,
    replacementExchangeId: "replacement",
    replacementText: "Stay outside.",
    continuation: "continue_context",
  });
  expect(
    await runtime.handle({ type: "artifacts.read", worldId }),
  ).toMatchObject({ result: [] });
  // The discarded round's artifact records are removed from disk, not merely
  // superseded, so the debug view no longer carries them (ADR-0045).
  expect(
    await runtime.handle({ type: "artifacts.debug", worldId }),
  ).toMatchObject({ result: [] });
  await worlds.deleteWorld(worldId);
  const cold = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await cold.initialize();
  expect(
    await cold.handle({ type: "world.play-decorations.read", worldId: forkId }),
  ).toMatchObject({
    result: {
      head,
      artifacts: [
        {
          payload: { hp: 9 },
          reply: { eventId: 2 },
          frontend: { status: "ready" },
        },
      ],
    },
  });
  expect(await worlds.currentHead(forkId)).toBe(head);
  expect(calls).toBe(3);
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

test("浏览器观察保持40项尾部并恢复活动片段，旧历史仍只能分页读取", async () => {
  const { worlds, worldId } = await createWorld("play-sse-bounded-observation");
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: Array.from({ length: 25 }, (_, index) => ({
          id: `read-${index}`,
          name: "state_list",
          arguments: {},
        })),
      },
      { outcome: "response", text: "Narration after tools" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "sse-chain",
    exchangeId: "sse-exchange-0",
    playerText: "oldest player sentinel",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const observed = await chains.observeWorld(worldId);
  expect(observed?.events).toHaveLength(40);
  expect(observed?.previousContexts).toEqual([]);
  expect(JSON.stringify(observed)).not.toContain("oldest player sentinel");
  expect(
    (await worlds.playTimeline.readPage(worldId, 10)).nextCursor,
  ).not.toBeNull();

  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (response: ModelHostResponse) => void;
  const result = new Promise<ModelHostResponse>((resolve) => {
    finish = resolve;
  });
  const streaming: ModelHost = {
    binding: modelBinding,
    async exchange(_request, observer) {
      observer?.onDelta?.({
        kind: "reasoning",
        text: "Provider-returned reasoning",
      });
      observer?.onDelta?.({ kind: "text", text: "Pending live text" });
      observer?.onDelta?.({ kind: "tool", text: '{"path":' });
      started();
      return await result;
    },
  };
  const running = chains.append({
    worldId,
    chainId: "sse-chain",
    exchangeId: "sse-exchange-live",
    playerText: "Observe the live response",
    modelHost: streaming,
  });
  await start;
  try {
    const reconnected = await chains.observeWorld(worldId);
    expect(reconnected?.events).toHaveLength(40);
    expect(reconnected?.events.at(-1)).toMatchObject({
      status: "streaming",
      text: "Pending live text",
      reasoning: "Provider-returned reasoning",
      toolFragment: '{"path":',
    });
  } finally {
    finish({
      text: "Complete response",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: { role: "assistant", content: "Complete response" },
      },
    });
    await running;
  }
});

test("冻结旧历史工具会话冷启动后继续，不添加新历史工具并保持原生前缀", async () => {
  const { worlds, worldId, root } = await createWorld("frozen-history-upgrade");
  const initial = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "那封信已交给 Alex。" }],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "modern-fixture",
    exchangeId: "initial",
    playerText: "我递出那封信。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: initial,
  });
  const loaded = (await worlds.playTimeline.readCurrent(worldId))!.value;
  const frozen = structuredClone(loaded);
  frozen.chainId = "released-history-context";
  frozen.previousChainId = null;
  frozen.promptRuns = [];
  frozen.lastRequest = null;
  frozen.tools = frozen.tools.filter(
    ({ name }) => name !== "history_search" && name !== "history_read",
  );
  frozen.tools.find(({ name }) => name === "history_list")!.inputSchema = {
    type: "object",
    required: ["order"],
    properties: {
      order: { enum: ["newest_first", "oldest_first"] },
      cursor: { type: ["string", "null"] },
      limit: { type: "integer" },
    },
  };
  frozen.tools.find(({ name }) => name === "context_search")!.inputSchema = {
    type: "object",
    required: ["source", "query"],
    properties: {
      source: { enum: ["state", "history"] },
      query: { type: "string" },
    },
  };
  frozen.bootstrap.tools = structuredClone(frozen.tools);
  frozen.bootstrap.toolUniverse = structuredClone(frozen.tools);
  await worlds.playTimeline.persist(frozen);
  const prefix = structuredClone(frozen.transcript);
  const resumed = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "old-list",
            name: "history_list",
            arguments: { order: "oldest_first", limit: 2 },
          },
          {
            id: "old-search",
            name: "context_search",
            arguments: { source: "history", query: "那封信" },
          },
          {
            id: "old-read",
            name: "context_read",
            arguments: { ref: "@history-message-message.2.1.narrator" },
          },
        ],
      },
      { outcome: "response", text: "Alex仍收着那封信。" },
    ],
  });
  const coldWorlds = new FileNativeWorldStore(root);
  const result = await new PlayCallChain(coldWorlds).append({
    worldId,
    chainId: frozen.chainId,
    exchangeId: "after-upgrade",
    playerText: "核对之前的交信。",
    modelHost: resumed,
    resolvePrompt: () =>
      Promise.resolve({ hostBinding: hostBinding(), playPreset: playPreset() }),
  });
  expect(result.status).toBe("ready");
  expect(resumed.requests[0]!.tools).toEqual(frozen.tools);
  expect(resumed.requests[0]!.appended.slice(0, prefix.length)).toEqual(prefix);
  const receipts = resumed.requests[1]!.appended.filter(
    (item) => item.kind === "tool",
  );
  expect(receipts).toHaveLength(3);
  expect(
    receipts.every(
      (item) => item.kind === "tool" && item.markdown.includes("position"),
    ),
  ).toBe(true);
  expect(resumed.requests[0]!.tools.map(({ name }) => name)).not.toContain(
    "history_search",
  );
});

test("历史查询沿真实时间线修订与分叉恢复位置，状态修正不使历史 cursor 失效", async () => {
  const { HistoryQuery, historyInputs } =
    await import("../../src/runtime/history/HistoryQuery.ts");
  const { worlds, worldId } = await createWorld("history-query-real-timeline");
  const first = await worlds.commitPlayStep({
    worldId,
    operationId: "history-first",
    parentHead: "genesis",
    stateChanges: [],
    nextMaterials: [],
    historyAppend: [{ role: "player", exactText: "那封信放在桌上。" }],
  });
  await worlds.commitPlayStep({
    worldId,
    operationId: "history-multiple",
    parentHead: first.head,
    stateChanges: [],
    nextMaterials: [],
    historyAppend: [
      { role: "narrator", exactText: "第一段主持原文。" },
      { role: "narrator", exactText: "第二段主持原文。" },
    ],
  });
  const open = async (id: string) => {
    const binding = await worlds.bindPlayCallChain(id);
    return new HistoryQuery(
      id,
      historyInputs(
        Object.entries(binding.history).map(([path, contents]) => ({
          path,
          contents,
        })),
      ),
    );
  };
  const before = await open(worldId);
  const page = before.list({ limit: 2 });
  expect(page).toMatchObject({
    total: 4,
    messages: [
      { position: 3, role: "narrator" },
      { position: 4, role: "narrator" },
    ],
  });
  if (!page.ok) throw new Error("Expected list");
  const { FileNativePlayDocuments } =
    await import("../../src/runtime/play/PlayDocumentTools.ts");
  const documents = new FileNativePlayDocuments(
    (await worlds.bindPlayCallChain(worldId)).files,
  );
  documents.execute(
    {
      id: "read",
      name: "context_read",
      arguments: { ref: "@current-situation" },
    },
    [],
  );
  expect(
    documents.execute(
      {
        id: "patch",
        name: "world_patch",
        arguments: {
          target: "@current-situation",
          edits: [
            {
              op: "replace",
              locator: { yaml: ["情况"] },
              value: "Alex在桌边。",
            },
          ],
        },
      },
      [],
    ).ok,
  ).toBe(true);
  await worlds.commitCorrection({
    worldId,
    operationId: "history-state-only",
    parentHead: await worlds.currentHead(worldId),
    stateChanges: documents.stateChanges(),
    nextMaterials: [],
  });
  expect(
    (await open(worldId)).list({ cursor: page.earlierCursor }),
  ).toMatchObject({ ok: true, messages: [{ position: 1 }, { position: 2 }] });
  const branch = await worlds.deriveWorld({
    operationId: "history-branch",
    sourceWorldId: worldId,
    sourceHead: first.head,
    hostPresetId: "host",
  });
  expect((await open(branch.world.worldId)).read({ latest: 21 })).toMatchObject(
    {
      total: 2,
      messages: [
        { position: 1, isOpening: true },
        { position: 2, ref: "@history-message-message.1.1.player" },
      ],
    },
  );
  expect(
    (await open(branch.world.worldId)).list({ cursor: page.earlierCursor }),
  ).toMatchObject({ code: "history_invalid_cursor" });
  await revisePlayerTimeline(worlds, {
    worldId,
    operationId: "history-revision",
    expectedCurrentHead: await worlds.currentHead(worldId),
    restoresHead: "genesis",
    replacesHead: first.head,
    replacementText: "我把那封信带走。",
  });
  const revised = await open(worldId);
  expect(revised.list({ cursor: page.earlierCursor })).toMatchObject({
    code: "history_changed",
  });
  expect(
    revised.read({ ref: "@history-message-message.1.1.player" }),
  ).toMatchObject({ code: "history_ref_not_in_current_timeline" });
  expect(revised.read({ latest: 21 })).toMatchObject({
    total: 2,
    messages: [{ position: 1 }, { position: 2, text: "我把那封信带走。" }],
  });
});

function backgroundWorldFiles() {
  return [
    ...worldFiles().map((file) =>
      file.path === "world/current-situation.yaml"
        ? {
            ...file,
            path: "world/scene.yaml",
            contents:
              file.contents +
              "背景: {时间: 第一天, 地点: 客栈}\n长局面: " +
              "不属于历史背景".repeat(2000) +
              "\n",
          }
        : file,
    ),
    {
      path: "world/alternate.yaml",
      contents:
        "$document:\n  id: situation.alternate\n  ref: alternate\n  title: Alternate\n  summary: Another scene.\n  aliases: []\n背景: {时间: 第九天, 地点: 城门}\n",
    },
  ];
}
function backgroundPatch(
  id: string,
  day: string,
): NonNullable<ModelHostResponse["toolCalls"]> {
  return [
    {
      id,
      name: "world_patch",
      arguments: {
        target: "@current-situation",
        edits: [
          {
            op: "replace",
            locator: { yaml: ["背景"] },
            value: { 时间: day, 地点: "山门" },
          },
        ],
      },
    },
  ];
}
function backgroundStart(
  worldId: string,
  chainId: string,
  modelHost: ModelHost,
) {
  return {
    worldId,
    chainId,
    exchangeId: "first",
    playerText: "明天再走，后天回来。\n",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  };
}

test("历史背景在工具前冻结，多次工具后提交终点，冷续写与真实预览共用原记录", async () => {
  const { worlds, worldId, root } = await createWorld(
    "history-background-origin",
    backgroundWorldFiles(),
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "这份中间正文不进入历史",
        toolCalls: backgroundPatch("day-two", "第二天"),
      },
      {
        outcome: "response",
        toolCalls: backgroundPatch("day-three", "第三天"),
      },
      {
        outcome: "response",
        toolCalls: backgroundPatch("unchanged", "第三天"),
      },
      { outcome: "response", text: "  他说明天到这里。\n\n" },
      { outcome: "response", text: "维护既有记录，没有推进时间。" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const first = await chains.start(
    backgroundStart(worldId, "background-origin", host),
  );
  expect(first.status).toBe("ready");
  const origin = "时间: 第一天\n地点: 客栈";
  const after = "时间: 第三天\n地点: 山门";
  const endpoint = await worlds.recoverEndpoint(worldId);
  expect(endpoint.history.map(({ background }) => background)).toEqual([
    { kind: "snapshot", value: origin },
    { kind: "snapshot", value: origin },
    { kind: "narrative", before: origin, after },
  ]);
  expect(endpoint.history.at(-1)?.exactText).toBe("  他说明天到这里。\n\n");
  expect(JSON.stringify(endpoint.history)).not.toContain("不属于历史背景");
  expect(endpoint.history).toHaveLength(3);
  await new PlayCallChain(worlds).append({
    worldId,
    chainId: first.chainId,
    exchangeId: "continuation",
    playerText: "",
    modelHost: host,
  });
  const current = await new FileNativeWorldStore(root).recoverEndpoint(worldId);
  expect(current.history.at(-1)?.background).toEqual({
    kind: "narrative",
    before: after,
    after,
  });
  expect(current.history.filter(({ role }) => role === "player")).toHaveLength(
    1,
  );
  const fresh = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "继续。" }],
  });
  await new PlayCallChain(worlds).start({
    ...backgroundStart(worldId, "background-fresh", fresh),
    playerText: "确认旧约定。",
  });
  const injected = fresh.requests[0]!.bootstrap.logicalMessages.flatMap(
    ({ blocks }) => blocks,
  )
    .filter(({ source }) => source.startsWith("runtime:checkpoint-history"))
    .map(({ markdown }) => markdown)
    .join("\n");
  expect(injected).toContain(origin);
  expect(injected).toContain(after);
  expect(injected).not.toContain("不属于历史背景");
  const binding = await worlds.bindPlayCallChain(worldId);
  const documents = new FileNativePlayDocuments(binding.files);
  const preview = new FileNativePromptCompiler().preview({
    endpoint: { id: "preview", commit: binding.parentHead },
    hostBinding: hostBinding(),
    world: {
      controlFingerprint: "preview",
      documentSnapshot: documents.snapshot,
      history: binding.history,
      historyBackgrounds: binding.historyBackgrounds ?? {},
      additionalMaterials: binding.additionalMaterials,
      replayHistory: true,
    },
    playerInputPlacement: "append",
    playerInput: "预览",
    modelBinding: modelBinding(),
  });
  expect(JSON.stringify(preview)).toContain("第一天");
  const read = documents.execute(
    {
      id: "read",
      name: "history_read",
      arguments: { ref: "@history-message-message.4.1.narrator" },
    },
    Object.entries(binding.history).map(([path, contents]) => ({
      path,
      contents,
      ...(binding.historyBackgrounds?.[path] === undefined
        ? {}
        : { background: binding.historyBackgrounds[path] }),
    })),
  );
  expect(read.ok).toBe(true);
  expect(read.markdown).toContain(origin);
  expect(read.markdown).toContain(after);
});

test("历史背景投影丢失时从 Authority 修复，不用修订后的当前情境回填", async () => {
  const { worlds, worldId, root } = await createWorld(
    "background-projection-repair",
    backgroundWorldFiles(),
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "明天见。" }],
  });
  await new PlayCallChain(worlds).start(
    backgroundStart(worldId, "background-projection", host),
  );
  const original = await worlds.recoverEndpoint(worldId);
  const binding = await worlds.bindPlayCallChain(worldId);
  const documents = new FileNativePlayDocuments(binding.files);
  documents.execute(
    {
      id: "read",
      name: "context_read",
      arguments: { ref: "@current-situation" },
    },
    [],
  );
  documents.execute(
    {
      id: "patch",
      name: "world_patch",
      arguments: {
        target: "@current-situation",
        edits: [
          { op: "replace", locator: { yaml: ["背景"] }, value: "十年后" },
        ],
      },
    },
    [],
  );
  await worlds.commitCorrection({
    operationId: "background-correction",
    worldId,
    parentHead: binding.parentHead,
    nextMaterials: binding.additionalMaterials,
    stateChanges: documents.stateChanges(),
  });
  await rm(
    join(root, "worlds-file-native", worldId, "runtime", "history-backgrounds"),
    { recursive: true },
  );
  const repaired = await new FileNativeWorldStore(root).bindPlayCallChain(
    worldId,
  );
  expect(repaired.historyBackgrounds).toEqual(
    Object.fromEntries(
      original.history.map(({ messageId, background }) => [
        messageId,
        background,
      ]),
    ),
  );
  expect(JSON.stringify(repaired.historyBackgrounds)).not.toContain("十年后");
});

test("工具端点分叉的新叙事从所选状态采集背景，原世界记录保持不变", async () => {
  const { worlds, worldId } = await createWorld(
    "background-tool-fork",
    backgroundWorldFiles(),
  );
  const chains = new PlayCallChain(worlds);
  const source = await chains.start(
    backgroundStart(
      worldId,
      "background-tool-source",
      new ScriptedModelHost({
        binding: modelBinding(),
        steps: [
          {
            outcome: "response",
            toolCalls: backgroundPatch("day-three", "第三天"),
          },
          { outcome: "response", text: "原世界的最终叙事。" },
        ],
      }),
    ),
  );
  const toolStep = source.events.find(
    (event) => event.kind === "assistant" && event.responseKind === "tool_step",
  );
  if (toolStep?.kind !== "assistant" || toolStep.committedHead === undefined)
    throw new Error("Tool step did not commit");
  const original = await worlds.recoverEndpoint(worldId);
  const branch = await chains.deriveWorld({
    operationId: "background-tool-fork",
    sourceWorldId: worldId,
    sourceHead: toolStep.committedHead,
    hostPresetId: "host",
  });
  const fork = await chains.inspectWorld(branch.world.worldId);
  if (fork === null) throw new Error("Fork context missing");
  await chains.append({
    worldId: branch.world.worldId,
    chainId: fork.chainId,
    exchangeId: "fork-continuation",
    playerText: "",
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "分叉的新叙事。" }],
    }),
  });
  const forked = await worlds.recoverEndpoint(branch.world.worldId);
  expect(forked.history.at(-1)?.background).toEqual({
    kind: "narrative",
    before: "时间: 第三天\n地点: 山门",
    after: "时间: 第三天\n地点: 山门",
  });
  expect(forked.history.slice(0, 2)).toEqual(original.history.slice(0, 2));
  expect(forked.history).toHaveLength(3);
  expect((await worlds.recoverEndpoint(worldId)).history).toEqual(
    original.history,
  );
});

test("世界外修订改名并更换绑定不改历史背景或游标，新消息重新采集", async () => {
  const { worlds, worldId, root } = await createWorld(
    "background-world-revision",
    backgroundWorldFiles(),
  );
  await new PlayCallChain(worlds).start(
    backgroundStart(
      worldId,
      "background-before-revision",
      new ScriptedModelHost({
        binding: modelBinding(),
        steps: [{ outcome: "response", text: "明天见，后天回来。" }],
      }),
    ),
  );
  const { HistoryQuery, historyInputs } =
    await import("../../src/runtime/history/HistoryQuery.ts");
  const query = (
    binding: Awaited<ReturnType<typeof worlds.bindPlayCallChain>>,
  ) =>
    new HistoryQuery(
      worldId,
      historyInputs(
        Object.entries(binding.history).map(([path, contents]) => ({
          path,
          contents,
          ...(binding.historyBackgrounds?.[path] === undefined
            ? {}
            : { background: binding.historyBackgrounds[path] }),
        })),
      ),
    );
  const original = await worlds.bindPlayCallChain(worldId);
  const page = query(original).list({ limit: 1 });
  if (!page.ok) throw new Error("History listing failed");
  const workspace = new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(root),
    worlds,
  });
  let epoch = await workspace.open(worldId);
  epoch = await workspace.replace({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: epoch.files.map((file) => {
      if (file.path === "state/scene.yaml")
        return {
          ...file,
          contents: file.contents
            .replace(/title: .*/u, "title: 十年后的码头")
            .replace("第一天", "十年后"),
        };
      if (file.path === "control/frame.yaml")
        return {
          ...file,
          contents: file.contents.replace(
            "currentSituation: situation.current",
            'currentSituation: "@alternate"',
          ),
        };
      return file;
    }),
  });
  await workspace.apply({
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  const revised = await new FileNativeWorldStore(root).bindPlayCallChain(
    worldId,
  );
  expect(revised.files["state/scene.yaml"]).toContain("title: 十年后的码头");
  expect(revised.history).toEqual(original.history);
  expect(revised.historyBackgrounds).toEqual(original.historyBackgrounds);
  expect(query(revised).list({ cursor: page.earlierCursor })).toMatchObject({
    ok: true,
  });
  await new PlayCallChain(worlds).start(
    backgroundStart(
      worldId,
      "background-after-revision",
      new ScriptedModelHost({
        binding: modelBinding(),
        steps: [{ outcome: "response", text: "新的约定。" }],
      }),
    ),
  );
  const current = await worlds.recoverEndpoint(worldId);
  expect(current.history.at(-2)?.background).toEqual({
    kind: "snapshot",
    value: "时间: 第九天\n地点: 城门",
  });
  expect(current.history.at(-1)?.background).toEqual({
    kind: "narrative",
    before: "时间: 第九天\n地点: 城门",
    after: "时间: 第九天\n地点: 城门",
  });
  expect(
    current.history.slice(0, 3).map(({ background }) => background),
  ).toEqual(
    Object.keys(original.history).map((id) => original.historyBackgrounds![id]),
  );
});

/** Play surface of a fiction context; artifact tools belong to follow-up requests. */
const fictionPlayToolNames = [
  "state_list",
  "history_list",
  "history_search",
  "history_read",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
  "world_retire",
  "world_checkpoint",
];

/** Resolution scenarios run in a tabletop d20 world, so its universe carries the check. */
function tabletopWorldFiles(): ContentTreeFile[] {
  return [...worldFiles(), gameplayFile({ mode: "tabletop", scheme: "d20" })];
}

function resolutionCompiler(): FileNativePromptCompiler {
  return new FileNativePromptCompiler();
}

function d20ToolStep(id = "roll-1") {
  return {
    outcome: "response" as const,
    toolCalls: [
      {
        id,
        name: "d20_check",
        arguments: { goal: "推开石门", modifier: 3, difficulty: 15 },
      },
    ],
  };
}

test("冻结宇宙含判定工具时执行判定，回执与持久种子逐位复算一致", async () => {
  const label = "play-chain-resolution-receipt";
  const { worlds, worldId } = await createWorld(label, tabletopWorldFiles());
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [d20ToolStep(), { outcome: "response", text: "石门缓缓开启。" }],
  });
  const view = await new PlayCallChain(worlds, resolutionCompiler()).start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(modelHost.requests[0]?.tools.map(({ name }) => name)).toContain(
    "d20_check",
  );
  const result = view.events.find(
    (event) => event.kind === "tool_result" && event.callId === "roll-1",
  );
  expect(result).toMatchObject({
    kind: "tool_result",
    name: "d20_check",
    ok: true,
    resolution: {
      kind: "d20",
      goal: "推开石门",
      modifier: 3,
      difficulty: 15,
      mode: "normal",
    },
  });
  const receipt = (result as { resolution: ResolutionReceipt }).resolution;
  expect(isResolutionReceipt(receipt)).toBe(true);
  // Rolls are generated in memory per settlement and not persisted, so the
  // receipt is checked by its shape and by the markdown fed back to the model.
  expect(sent(modelHost.requests[1]!).at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "roll-1",
    markdown: resolutionMarkdown(receipt, "en"),
  });
  expect(modelHost.requests[1]?.appended.at(-1)).not.toHaveProperty("isError");
});

test("持久化判定回执被篡改后，时间线读取拒绝该回执", async () => {
  const label = "play-chain-resolution-tampered-receipt";
  const { worlds, worldId, root } = await createWorld(
    label,
    tabletopWorldFiles(),
  );
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [d20ToolStep(), { outcome: "response", text: "石门缓缓开启。" }],
  });
  await new PlayCallChain(worlds, resolutionCompiler()).start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  let tampered = 0;
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8");
    if (!text.includes('"resolution"')) continue;
    const parsed = JSON.parse(text) as unknown;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        if (
          record.kind === "tool_result" &&
          typeof record.resolution === "object"
        ) {
          (record.resolution as Record<string, unknown>).total = 999;
          tampered += 1;
        }
        Object.values(record).forEach(walk);
      }
    };
    walk(parsed);
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  expect(tampered).toBeGreaterThan(0);
  await expect(
    new PlayCallChain(worlds, resolutionCompiler()).inspectWorld(worldId),
  ).rejects.toThrow("Invalid resolution receipt");
});

test("判定工具不在冻结宇宙中时被拒绝，非法参数只产生工具错误", async () => {
  const rejected = await createWorld("play-chain-resolution-gating");
  const rejectedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      d20ToolStep("not-frozen"),
      { outcome: "response", text: "石门没有开启，角色只是退后一步。" },
    ],
  });
  const view = await new PlayCallChain(rejected.worlds).start({
    worldId: rejected.worldId,
    chainId: "play-chain-resolution-gating",
    exchangeId: "play-chain-resolution-gating-player",
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: rejectedHost,
  });
  expect(rejectedHost.requests[0]?.tools.map(({ name }) => name)).not.toContain(
    "d20_check",
  );
  expect(view.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "not-frozen",
      ok: false,
    }),
  );
  expect(
    view.events.find(
      (event) => event.kind === "tool_result" && event.callId === "not-frozen",
    ),
  ).not.toHaveProperty("resolution");
  expect(sent(rejectedHost.requests[1]!).at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "not-frozen",
    isError: true,
  });

  const invalid = await createWorld(
    "play-chain-resolution-invalid-args",
    tabletopWorldFiles(),
  );
  const invalidHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "bad-args",
            name: "d20_check",
            arguments: { goal: "推开石门", modifier: 1.5, difficulty: 15 },
          },
        ],
      },
      { outcome: "response", text: "石门没有开启，角色只是退后一步。" },
    ],
  });
  const settled = await new PlayCallChain(
    invalid.worlds,
    resolutionCompiler(),
  ).start({
    worldId: invalid.worldId,
    chainId: "play-chain-resolution-invalid-args",
    exchangeId: "play-chain-resolution-invalid-args-player",
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: invalidHost,
  });
  expect(settled).toMatchObject({ status: "ready" });
  const result = settled.events.find(
    (event) => event.kind === "tool_result" && event.callId === "bad-args",
  );
  expect(result).toMatchObject({ ok: false, name: "d20_check" });
  expect(result).not.toHaveProperty("resolution");
  expect(sent(invalidHost.requests[1]!).at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "bad-args",
    isError: true,
  });
});

test("普通虚构请求的工具列表保持不变，判定工具只存在于注册表词汇中", () => {
  expect([...baseRuntimeToolNames]).toEqual([
    ...fictionPlayToolNames,
    "artifact_emit",
    "artifact_clear",
  ]);
  for (const name of [
    "d20_check",
    "percentile_check",
    "bag_check",
    "roll_dice",
    "calculate",
  ])
    expect(registeredRuntimeToolNames).toContain(name);
  for (const name of fictionPlayToolNames)
    expect(registeredRuntimeToolNames).toContain(name);
  expect(baseRuntimeToolNames).not.toContain("d20_check");
});

test("普通虚构请求编译出的游玩工具与改动前完全一致", async () => {
  const label = "play-chain-fiction-tool-list";
  const { worlds, worldId } = await createWorld(label);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "门后只有安静。" }],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  expect(modelHost.requests[0]?.tools.map(({ name }) => name)).toEqual(
    fictionPlayToolNames,
  );
});
test("世界在故事外前进后仍可修改或重新生成已提交玩家消息", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-edit-after-out-of-story-advance",
  );
  const chains = new PlayCallChain(worlds);
  const source = await chains.start({
    worldId,
    chainId: "play-chain-edit-after-advance-source",
    exchangeId: "exchange-edit-after-advance-source",
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

  // Anything that moves the world head without the chain (an applied world
  // revision, or a timeline revision whose chain publication failed) leaves
  // the persisted chain behind the current world.
  await worlds.commitCorrection({
    worldId,
    operationId: "out-of-story-advance",
    parentHead: source.parentHead,
    stateChanges: [],
    nextMaterials: [],
  });
  const advancedHead = await worlds.currentHead(worldId);
  expect(advancedHead).not.toBe(source.parentHead);
  await expect(chains.inspectWorld(worldId)).resolves.toMatchObject({
    parentHead: source.parentHead,
  });

  const revised = await chains.revisePlayer({
    operationId: "revise-after-out-of-story-advance",
    worldId,
    chainId: source.chainId,
    eventId: selected.id,
    replacementExchangeId: "exchange-edit-after-advance-replacement",
    replacementText: "I take the western path.",
    continuation: "continue_context",
  });
  const revisedHead = await worlds.currentHead(worldId);
  expect(revised.playCallChain.parentHead).toBe(revisedHead);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual(["门外传来三声短促的铃响。\n", "I take the western path."]);

  const continued = await chains.append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: "exchange-edit-after-advance-continue",
    playerText: "",
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "The western path opens." }],
    }),
  });
  expect(continued.status).toBe("ready");
});

test("判定回合重新生成最新玩家消息会创建新推进，新判定重新掷骰", async () => {
  const label = "play-chain-resolution-regenerate";
  const { worlds, worldId } = await createWorld(label, tabletopWorldFiles());
  const chains = new PlayCallChain(worlds, resolutionCompiler());
  const started = await chains.start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        d20ToolStep("roll-old"),
        { outcome: "response", text: "石门缓缓开启。" },
      ],
    }),
  });
  const player = started.events.find(
    (event) => event.kind === "player" && event.context === "fresh",
  );
  if (player?.kind !== "player") throw new Error("missing first player");

  const revised = await chains.revisePlayer({
    operationId: "regenerate-resolution",
    worldId,
    chainId: label,
    eventId: player.id,
    replacementExchangeId: `${label}-regenerate`,
    replacementText: "我推开石门。",
    continuation: "continue_context",
  });
  const regenerationHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      d20ToolStep("roll-new"),
      { outcome: "response", text: "石门缓缓开启。" },
    ],
  });
  const regenerated = await chains.append({
    worldId,
    chainId: revised.playCallChain.chainId,
    exchangeId: `${label}-regenerate-continue`,
    playerText: "",
    modelHost: regenerationHost,
    resolvePrompt: () =>
      Promise.resolve({ hostBinding: hostBinding(), playPreset: playPreset() }),
  });
  expect(regenerated).toMatchObject({ status: "ready" });
  expect(regenerationHost.requests[0]?.tools.map(({ name }) => name)).toContain(
    "d20_check",
  );
  const result = regenerated.events.find(
    (event) => event.kind === "tool_result" && event.callId === "roll-new",
  );
  expect(result).toMatchObject({ ok: true, name: "d20_check" });
  const receipt = (result as { resolution: ResolutionReceipt }).resolution;
  expect(isResolutionReceipt(receipt)).toBe(true);

  expect(receipt.kind).toBe("d20");
});

test("判定回合之后导出故事只含已提交的玩家与叙事原文，判定结果不进入导出也不使导出失败", async () => {
  const label = "play-chain-resolution-story-export";
  const { worlds, worldId } = await createWorld(label, tabletopWorldFiles());
  await new PlayCallChain(worlds, resolutionCompiler()).start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        d20ToolStep("roll-export"),
        { outcome: "response", text: "石门缓缓开启。" },
      ],
    }),
  });

  const text = await worlds.exportStory(worldId, "text", "zh-CN");
  expect(text.content).toContain("我：我推开石门。");
  expect(text.content).toContain("石门缓缓开启。");
  expect(text.content).not.toMatch(/d20 \d/u);
  expect(text.content).not.toContain("≥");
  const markdown = await worlds.exportStory(worldId, "markdown", "zh-CN");
  expect(markdown.content).toContain("> **我**：我推开石门。");
  expect(markdown.content).not.toMatch(/d20 \d/u);
});

test("生成中进程退出后重启标记为中断，重试重新调用模型并成功", async () => {
  const label = "interrupted-generation-retry";
  const { worlds, worldId, root } = await createWorld(label);
  const dispatched: ModelHostExchange[] = [];
  // The first runtime's dispatch never returns, as if the process exited
  // while the model was generating. The promise is simply abandoned.
  const neverReturns: ModelHost = {
    binding: () => modelBinding(),
    exchange: (request) => {
      dispatched.push(structuredClone(request));
      return new Promise<ModelHostResponse>(() => undefined);
    },
  };
  void new PlayCallChain(worlds)
    .start({
      worldId,
      chainId: label,
      exchangeId: `${label}-player`,
      playerText: "我推开石门。",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: neverReturns,
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(dispatched).toHaveLength(1));

  // A new runtime over the same data directory sees the interrupted round.
  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  expect(await restarted.inspectWorld(worldId)).toMatchObject({
    status: "interrupted",
    canRetry: true,
    lastFailure:
      "The service stopped while the model request was in progress; retry to call the model again.",
    lastFailureKind: "retryable",
  });

  const retryHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "石门缓缓开启。" }],
  });
  const retried = await restarted.append({
    worldId,
    chainId: label,
    exchangeId: `${label}-retry`,
    playerText: "",
    modelHost: retryHost,
    resolvePrompt: () =>
      Promise.resolve({ hostBinding: hostBinding(), playPreset: playPreset() }),
  });
  expect(retryHost.requests).toHaveLength(1);
  expect(retried).toMatchObject({ status: "ready" });
});

test("玩家阶段发送进行中重启后标记为中断且不可重试，提示文字与响应阶段的分界一致", async () => {
  const label = "interrupted-player-save";
  const { worlds, worldId, root } = await createWorld(label);
  // The player message never finishes saving, as if the process exited mid-write.
  let saving = 0;
  vi.spyOn(worlds, "commitPlayStep").mockImplementation(() => {
    saving += 1;
    return new Promise(() => undefined);
  });
  void new PlayCallChain(worlds)
    .start({
      worldId,
      chainId: label,
      exchangeId: `${label}-player`,
      playerText: "我推开石门。",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: scriptedHost("石门缓缓开启。"),
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(saving).toBe(1));

  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  expect(await restarted.inspectWorld(worldId)).toMatchObject({
    status: "interrupted",
    canRetry: false,
    lastFailure:
      "The service stopped while saving the player message; use a fresh context.",
    lastFailureKind: "other",
  });
});

test("发送进行中的推进标记不保存冻结请求，后续发送的标记体积不随上下文增长", async () => {
  const label = "advance-marker-size";
  const { worlds, worldId, root } = await createWorld(label);
  // Each settlement of a player message records the marker as it is on disk.
  const markers: string[] = [];
  const commitPlayStep = worlds.commitPlayStep.bind(worlds);
  vi.spyOn(worlds, "commitPlayStep").mockImplementation((input) => {
    const marker = advanceMarkerPath(root, worldId, label);
    if (existsSync(marker)) markers.push(readFileSync(marker, "utf8"));
    return commitPlayStep(input);
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: label,
    exchangeId: `${label}-start`,
    playerText: "进入房间。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: scriptedHost("灯影摇晃，墙上的字迹慢慢变淡。".repeat(40)),
  });
  await chains.append({
    worldId,
    chainId: label,
    exchangeId: `${label}-second`,
    playerText: "继续观察墙面。",
    modelHost: scriptedHost("墙面渐渐平静。"),
  });

  const playerMarkers = markers.filter(
    (raw) =>
      (JSON.parse(raw) as { advanceKind?: string }).advanceKind === "player",
  );
  expect(playerMarkers).toHaveLength(2);
  for (const raw of playerMarkers)
    expect(JSON.parse(raw)).not.toHaveProperty("nextRequest");
  const [early, late] = playerMarkers as [string, string];
  // The later marker was written after a long transcript; its request is not in it.
  expect(late).not.toContain("灯影摇晃");
  expect(Buffer.byteLength(late)).toBeLessThanOrEqual(
    Buffer.byteLength(early) + 64,
  );
});

test("含旧 nextRequest 的推进标记仍可读取，重启后照常标记为中断", async () => {
  const label = "advance-marker-legacy";
  const { worlds, worldId, root } = await createWorld(label);
  let saving = 0;
  vi.spyOn(worlds, "commitPlayStep").mockImplementation(() => {
    saving += 1;
    return new Promise(() => undefined);
  });
  void new PlayCallChain(worlds)
    .start({
      worldId,
      chainId: label,
      exchangeId: `${label}-player`,
      playerText: "我推开石门。",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: scriptedHost("石门缓缓开启。"),
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(saving).toBe(1));

  // Released layouts stored the frozen request inside the marker (ADR-0034).
  const marker = advanceMarkerPath(root, worldId, label);
  const current = JSON.parse(await readFile(marker, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    marker,
    `${JSON.stringify({ ...current, nextRequest: { exchange: 1, appended: [{ kind: "user", text: "我推开石门。" }] } }, null, 2)}\n`,
  );

  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  expect(await restarted.inspectWorld(worldId)).toMatchObject({
    status: "interrupted",
    canRetry: false,
    lastFailureKind: "other",
  });
  expect(existsSync(marker)).toBe(false);
});

test("旧格式操作回执文件被忽略：世界照常打开、游玩与分叉", async () => {
  const label = "legacy-operation-receipt";
  const { worldId, root } = await createWorld(label);
  const operations = join(root, "operations");
  await mkdir(operations, { recursive: true });
  const receiptPath = (operationId: string) =>
    join(
      operations,
      `outcome-${createHash("sha256").update(operationId).digest("hex")}.json`,
    );
  // Shapes written by earlier releases: an acceptance-prepared stage, and a
  // committed record whose head does not exist in Authority.
  await writeFile(
    receiptPath("legacy-fork"),
    `${JSON.stringify({
      outcome: "acceptance_prepared",
      worldId,
      parentHead: "genesis",
      head: "commit:9",
      commitDigest: "f".repeat(64),
      historyAppend: [],
      nextAdditionalMaterials: [],
      mode: "play",
    })}\n`,
  );
  await writeFile(receiptPath("legacy-committed"), '{"outcome":"committed"}\n');

  const restarted = new FileNativeWorldStore(root);
  const played = await new PlayCallChain(restarted).start({
    worldId,
    chainId: label,
    exchangeId: `${label}-player`,
    playerText: "我推开石门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: new ScriptedModelHost({
      binding: modelBinding(),
      steps: [{ outcome: "response", text: "石门缓缓开启。" }],
    }),
  });
  expect(played).toMatchObject({ status: "ready" });

  const fork = await restarted.deriveWorld({
    operationId: "legacy-fork",
    sourceWorldId: worldId,
    sourceHead: "genesis",
    hostPresetId: "host-1",
  });
  expect(fork.outcome).toBe("derived");
  expect(await new FileNativeWorldStore(root).listWorlds()).toHaveLength(2);
});

test("文档授权只在内存中：重启后回放对话记录里的精读，未读过的文档仍被拒绝", async () => {
  const { worlds, worldId, root } = await createWorld("memory-only-read", [
    ...worldFiles(),
    {
      path: "world/characters/qin.yaml",
      contents:
        "$document:\n  id: person.qin\n  ref: qin\n  title: Qin\n  summary: Courier\n  aliases: []\nrelationship: Just met\n",
    },
    {
      path: "world/characters/wei.yaml",
      contents:
        "$document:\n  id: person.wei\n  ref: wei\n  title: Wei\n  summary: Innkeeper\n  aliases: []\nrelationship: Stranger\n",
    },
  ]);
  const patch = (id: string, target: string) => ({
    id,
    name: "world_patch",
    arguments: {
      target,
      edits: [
        {
          op: "replace",
          locator: { yaml: ["relationship"] },
          value: "Trusted",
        },
      ],
    },
  });
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "first-read",
            name: "context_read",
            arguments: { ref: "@qin#/relationship" },
          },
        ],
      },
      { outcome: "response", text: "Qin greets you." },
      {
        outcome: "response",
        toolCalls: [
          patch("replayed-write", "@qin"),
          patch("blind-write", "@wei"),
        ],
      },
      { outcome: "response", text: "Qin smiles." },
    ],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "memory-only-read",
    exchangeId: "first",
    playerText: "Hello",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  // A new process has no persisted proof; it rebuilds read authority from the
  // bootstrap plus the exact reads the retained transcript still shows the model.
  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  const view = await restarted.append({
    worldId,
    chainId: "memory-only-read",
    exchangeId: "second",
    playerText: "I lend the umbrella",
    modelHost: host,
  });
  expect(
    view.events.find(
      (event) =>
        event.kind === "tool_result" && event.callId === "replayed-write",
    ),
  ).toMatchObject({ ok: true });
  expect(
    view.events.find(
      (event) => event.kind === "tool_result" && event.callId === "blind-write",
    ),
  ).toMatchObject({ ok: false });
  const files = (await worlds.bindPlayCallChain(worldId)).files;
  expect(files["state/characters/qin.yaml"]).toContain("Trusted");
  expect(files["state/characters/wei.yaml"]).toContain("Stranger");
});

test.each([
  {
    stage: "intent written",
    rewound: false,
    committed: false,
    continuation: "continue_context" as const,
  },
  {
    stage: "world rewound",
    rewound: true,
    committed: false,
    continuation: "continue_context" as const,
  },
  {
    stage: "replacement committed",
    rewound: true,
    committed: true,
    continuation: "continue_context" as const,
  },
  {
    stage: "intent written, fresh context",
    rewound: false,
    committed: false,
    continuation: "fresh_context" as const,
  },
  {
    stage: "replacement committed, fresh context",
    rewound: true,
    committed: true,
    continuation: "fresh_context" as const,
  },
])(
  "编辑在进程退出后于阶段「$stage」恢复：加载时补完回退与提交，丢弃的上下文从磁盘删除，之后可继续游玩",
  async ({ rewound, committed, continuation }) => {
    const { worlds, worldId, root } = await createWorld(
      `edit-recovery-${rewound}-${committed}`,
    );
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
    const chainId = "edit-recovery";
    const sourceChains = new PlayCallChain(worlds);
    await sourceChains.start({
      worldId,
      chainId,
      exchangeId: "exchange-first",
      playerText: "I ask Alex when we are meeting.",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: sourceHost,
    });
    const source = await sourceChains.append({
      worldId,
      chainId,
      exchangeId: "exchange-second",
      playerText: "Then I will go downstairs five minutes early.",
      modelHost: sourceHost,
    });
    const edited = source.events.find(
      (event) =>
        event.kind === "player" && event.exchangeId === "exchange-second",
    )!;
    const replacementText = "Then let's meet fifteen minutes early.";
    const operationId = "edit-interrupted";
    // Stages before the replacement commit leave the old endpoint in place.
    if (rewound) await worlds.rewindPlayerRevision(worldId, "commit:2");
    if (committed && continuation === "continue_context")
      await revisePlayerTimeline(worlds, {
        operationId,
        worldId,
        restoresHead: "commit:2",
        replacementText,
      });
    await worlds.writePlayerRevisionIntent(worldId, {
      schemaVersion: 1,
      kind: "player_revision_intent",
      operationId,
      worldId,
      chainId,
      eventId: edited.id,
      replacementExchangeId: "exchange-replacement",
      replacementText,
      continuation,
      restoresHead: "commit:2",
      discardChainIds: [chainId],
      ...(continuation === "fresh_context"
        ? {
            freshContext: {
              hostBinding: hostBinding(),
              playPreset: playPreset(),
              modelBinding: modelBinding(),
            },
          }
        : {}),
    });

    // A new process loads the world: the interrupted edit is completed first.
    const replacementHost = new ScriptedModelHost({
      binding: modelBinding(),
      steps: [
        {
          outcome: "response",
          text: "Alex agrees to wait downstairs at seven forty-five.",
        },
      ],
    });
    const restarted = new PlayCallChain(new FileNativeWorldStore(root));
    const recovered = await restarted.inspectWorld(worldId);
    expect(
      recovered?.events.filter((event) => event.kind === "player"),
    ).toEqual(
      continuation === "fresh_context"
        ? // A fresh context keeps its earlier page only as a detached prefix.
          [expect.objectContaining({ text: replacementText })]
        : [
            expect.objectContaining({
              text: "I ask Alex when we are meeting.",
            }),
            expect.objectContaining({ text: replacementText }),
          ],
    );
    expect(await worlds.readPlayerRevisionIntent(worldId)).toBeNull();
    // The discarded context's segments and in-progress markers are gone.
    const digest = createHash("sha256").update(chainId).digest("hex");
    for (const directory of ["play-contexts", "play-advances"])
      expect(
        existsSync(
          join(
            root,
            "worlds-file-native",
            worldId,
            "runtime",
            directory,
            digest,
          ),
        ),
      ).toBe(false);
    expect(
      recovered?.events.some(
        (event) =>
          event.kind === "assistant" &&
          event.text.includes("five minutes early"),
      ),
    ).toBe(false);
    await restarted.append({
      worldId,
      chainId: recovered!.chainId,
      exchangeId: "exchange-continue",
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
      replacementText,
      "Alex agrees to wait downstairs at seven forty-five.",
    ]);
  },
);

test("编辑已发布新上下文但意图未清除时，重启只收尾，不重做回退与提交", async () => {
  const { worlds, worldId, root } = await createWorld(
    "edit-recovery-published",
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "Alex says to meet downstairs at eight." },
      { outcome: "response", text: "Alex nods." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "published-edit",
    exchangeId: "first",
    playerText: "I ask Alex when we are meeting.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const source = await chains.append({
    worldId,
    chainId: "published-edit",
    exchangeId: "second",
    playerText: "I go downstairs early.",
    modelHost: host,
  });
  const edited = source.events.findLast((event) => event.kind === "player")!;
  const writeIntent = vi.spyOn(worlds, "writePlayerRevisionIntent");
  const revised = await chains.revisePlayer({
    operationId: "edit-published",
    worldId,
    chainId: "published-edit",
    eventId: edited.id,
    replacementExchangeId: "second-revised",
    replacementText: "Let's meet fifteen minutes early.",
    continuation: "continue_context",
  });
  const history = (await worlds.recoverEndpoint(worldId)).history;
  // The process exited after publishing the revised context but before the
  // intent was cleared.
  await worlds.writePlayerRevisionIntent(
    worldId,
    writeIntent.mock.calls[0]![1],
  );

  const recovered = await new PlayCallChain(
    new FileNativeWorldStore(root),
  ).inspectWorld(worldId);
  expect(recovered?.chainId).toBe(revised.playCallChain.chainId);
  expect(recovered?.events).toEqual(revised.playCallChain.events);
  expect(await worlds.readPlayerRevisionIntent(worldId)).toBeNull();
  expect((await worlds.recoverEndpoint(worldId)).history).toEqual(history);
});

test("持久化的游玩上下文不再写入文档授权检查点", async () => {
  const { worlds, worldId, root } = await createWorld(
    "no-checkpoint-persistence",
  );
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The lamp flickers." }],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "no-checkpoint",
    exchangeId: "first",
    playerText: "Look around.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const [contextDirectory] = await readdir(
    join(root, "worlds-file-native", worldId, "runtime", "play-contexts"),
  );
  await expect(
    stat(
      join(
        root,
        "worlds-file-native",
        worldId,
        "runtime",
        "play-contexts",
        contextDirectory!,
        "authorization",
      ),
    ),
  ).rejects.toThrow();
});

test("旧版上下文的授权检查点计数与目录被忽略，读取不报错", async () => {
  const { worlds, worldId, root } = await createWorld("legacy-checkpoint-read");
  const host = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "The lamp flickers." }],
  });
  await new PlayCallChain(worlds).start({
    worldId,
    chainId: "legacy-checkpoint",
    exchangeId: "first",
    playerText: "Look around.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  const [contextDirectory] = await readdir(
    join(root, "worlds-file-native", worldId, "runtime", "play-contexts"),
  );
  const contextRoot = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    contextDirectory!,
  );
  const statePath = join(contextRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    statePath,
    JSON.stringify({ ...state, authorizationCheckpointCount: 2 }),
  );
  await mkdir(join(contextRoot, "authorization"));
  for (const index of [1, 2])
    await writeFile(
      join(contextRoot, "authorization", numberedFileName(index)),
      JSON.stringify({ afterEventId: 0, authorization: {} }),
    );
  const current = await worlds.playTimeline.readCurrent(worldId);
  expect(current).not.toBeNull();
  expect(current?.value.events.length).toBeGreaterThan(0);
  expect(current?.value).not.toHaveProperty("documentAuthorizationCheckpoints");
  expect(current?.cursor).not.toHaveProperty("authorizationCheckpointCount");
});

function numberedFileName(index: number): string {
  return `${String(index).padStart(10, "0")}.json`;
}

test("本轮提示只作为每次发送的尾部出现，不进入 transcript，也不出现在后续请求的前缀中", async () => {
  const { worlds, worldId } = await createWorld("turn-guide-suffix");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [{ id: "list", name: "state_list", arguments: {} }],
      },
      { outcome: "response", text: "Alex looks up from the jersey." },
      { outcome: "response", text: "He waits." },
    ],
  });
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "turn-guide",
    exchangeId: "first",
    playerText: "I nod to Alex.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });
  await chains.append({
    worldId,
    chainId: "turn-guide",
    exchangeId: "continue",
    playerText: "",
    modelHost,
  });
  const isGuide = (item: ModelHostExchange["appended"][number]) =>
    item.kind === "runtime_notice" && item.notice === "turn_guide";
  expect(modelHost.requests).toHaveLength(3);
  for (const request of modelHost.requests) {
    // Exactly one suffix per dispatch, after everything else the request
    // appends, with the text the bootstrap compiled.
    expect(request.appended.filter(isGuide)).toHaveLength(1);
    expect(request.appended.at(-1)).toEqual({
      kind: "runtime_notice",
      notice: "turn_guide",
      text: request.bootstrap.turnGuide!.text,
    });
    expect(
      request.bootstrap.turnGuide!.text.startsWith(turnGuideHeader("en")),
    ).toBe(true);
  }
  expect(sent(modelHost.requests[0]!).map(({ kind }) => kind)).toEqual([
    "player",
  ]);
  expect(sent(modelHost.requests[1]!).map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool",
  ]);
  expect(
    sent(modelHost.requests[2]!).map((item) =>
      item.kind === "runtime_notice" ? `notice:${item.notice}` : item.kind,
    ),
  ).toEqual([
    "player",
    "assistant",
    "tool",
    "assistant",
    "notice:continuation",
  ]);
  // The stored transcript never contains the suffix, so later requests and
  // forks are built without it.
  const stored = (await worlds.playTimeline.readCurrent(worldId))!.value
    .transcript;
  expect(stored.some(isGuide)).toBe(false);
  expect(stored.slice(0, sent(modelHost.requests[2]!).length)).toEqual(
    sent(modelHost.requests[2]!),
  );
  expect(stored.at(-1)).toMatchObject({ kind: "assistant", text: "He waits." });

  // A legacy v1 preset compiles no turn guide, so nothing is appended.
  const legacyHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "Quiet." }],
  });
  const legacy = await createWorld("turn-guide-legacy");
  await new PlayCallChain(legacy.worlds).start({
    worldId: legacy.worldId,
    chainId: "turn-guide-legacy",
    exchangeId: "first",
    playerText: "I nod to Alex.",
    hostBinding: hostBinding(),
    playPreset: playPreset(legacyDefaultPlayPresetFilesForLocale("en")),
    modelBinding: modelBinding(),
    modelHost: legacyHost,
  });
  expect(legacyHost.requests[0]!.bootstrap.turnGuide).toBeUndefined();
  expect(legacyHost.requests[0]!.appended).toEqual([
    { kind: "player", text: "I nod to Alex." },
  ]);
});

/**
 * Cache-reuse simulation. A scripted Anthropic provider sits behind the
 * production encoder, and PlayCallChain drives every dispatch. Each request
 * body is replayed through Anthropic's prefix-cache rules: cache entries are
 * written at every cache_control breakpoint and at the request end, and each
 * breakpoint looks back at most 20 blocks for an existing entry.
 */
type CacheSimStep = { text: string } | { toolId: string };

function cacheSimReply(): string {
  return `Alex keeps his eyes on the jersey while the hallway light hums. ${"他把球衣折了一次，又放回桌上。".repeat(300)}`;
}

function anthropicSseFrame(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function cacheSimResponse(step: CacheSimStep): Response {
  const isText = "text" in step;
  const block = isText
    ? { type: "text", text: "" }
    : { type: "tool_use", id: step.toolId, name: "state_list", input: {} };
  const delta = isText
    ? { type: "text_delta", text: step.text }
    : { type: "input_json_delta", partial_json: "{}" };
  const frames = [
    anthropicSseFrame("message_start", {
      type: "message_start",
      message: {
        id: "cache-sim",
        role: "assistant",
        model: "claude-cache-sim",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    anthropicSseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: block,
    }),
    anthropicSseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta,
    }),
    anthropicSseFrame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }),
    anthropicSseFrame("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: isText ? "end_turn" : "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    }),
    anthropicSseFrame("message_stop", { type: "message_stop" }),
  ];
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function cacheSimHost(steps: CacheSimStep[]) {
  const queue = [...steps];
  const fetch_ = vi.fn<typeof fetch>().mockImplementation(() => {
    const step = queue.shift();
    if (step === undefined)
      return Promise.reject(new Error("scripted provider ran out of steps"));
    return Promise.resolve(cacheSimResponse(step));
  });
  const host = new FileNativeModelHost(
    {
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "cache-sim-key",
      modelId: "claude-cache-sim",
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "disabled",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8_192,
    },
    fetch_,
  );
  return { host, fetch_ };
}

function sentRequestBodies(
  fetch_: ReturnType<typeof vi.fn<typeof fetch>>,
): Record<string, unknown>[] {
  return fetch_.mock.calls.map(
    ([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>,
  );
}

interface CacheSimRequest {
  keys: string[];
  chars: number[];
  breakpoints: number[];
  /** Blocks before the request-level suffix; the suffix is never part of the sent prefix. */
  prefix: number;
  hashes: string[];
}

function cacheSimRequest(body: Record<string, unknown>): CacheSimRequest {
  const keys: string[] = [];
  const chars: number[] = [];
  const breakpoints: number[] = [];
  let prefix = -1;
  const push = (role: string, block: unknown) => {
    const { cache_control: marker, ...content } = block as Record<
      string,
      unknown
    >;
    if (marker !== undefined) breakpoints.push(keys.length);
    const key = JSON.stringify({ role, content });
    keys.push(key);
    chars.push(key.length);
  };
  for (const tool of (body.tools as unknown[] | undefined) ?? [])
    push("tool", tool);
  for (const block of (body.system as unknown[] | undefined) ?? [])
    push("system", block);
  for (const message of body.messages as {
    role: string;
    content: unknown;
  }[]) {
    if (
      typeof message.content === "string" &&
      message.content.startsWith(turnGuideHeader("en"))
    )
      prefix = keys.length;
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content as unknown[]);
    for (const block of content) push(message.role, block);
  }
  return {
    keys,
    chars,
    breakpoints,
    prefix: prefix < 0 ? keys.length : prefix,
    hashes: cacheSimHashes(keys),
  };
}

function cacheSimHashes(keys: readonly string[]): string[] {
  let previous = "";
  return keys.map((key) => {
    previous = createHash("sha256")
      .update(previous)
      .update("\0")
      .update(key)
      .digest("hex");
    return previous;
  });
}

/** Share of each request's sent prefix that the next request reads from cache. */
function cacheReuseRatios(
  bodies: readonly Record<string, unknown>[],
): number[] {
  const written = new Set<string>();
  const ratios: number[] = [];
  let previous: CacheSimRequest | undefined;
  for (const body of bodies) {
    const request = cacheSimRequest(body);
    if (previous !== undefined) {
      // Index of the last cached block; -1 when nothing matches.
      let hit = -1;
      for (const breakpoint of request.breakpoints)
        for (
          let index = breakpoint;
          index >= Math.max(0, breakpoint - 20);
          index -= 1
        )
          if (written.has(request.hashes[index]!)) {
            hit = Math.max(hit, index);
            break;
          }
      const sum = (values: readonly number[]) =>
        values.reduce((total, value) => total + value, 0);
      const sent = sum(previous.chars.slice(0, previous.prefix));
      const reused = sum(
        previous.chars.slice(0, Math.min(hit + 1, previous.prefix)),
      );
      ratios.push(sent === 0 ? 1 : reused / sent);
    }
    for (const breakpoint of request.breakpoints)
      written.add(request.hashes[breakpoint]!);
    written.add(request.hashes.at(-1)!);
    previous = request;
  }
  return ratios;
}

const cacheReusePercent = (ratio: number) => Math.floor(ratio * 100);

test("缓存复用模拟：连续派发复用上一次已发送的对话前缀", async () => {
  const steps: CacheSimStep[] = Array.from({ length: 6 }, () => ({
    text: cacheSimReply(),
  }));
  const { host, fetch_ } = cacheSimHost(steps);
  const { worlds, worldId } = await createWorld(
    "cache-reuse-dialogue",
    worldFiles(),
    host.binding(),
  );
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "cache-reuse-dialogue",
    exchangeId: "first",
    playerText: "I nod to Alex.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: host.binding(),
    modelHost: host,
  });
  for (const exchangeId of [
    "continue-1",
    "continue-2",
    "continue-3",
    "continue-4",
    "continue-5",
  ])
    await chains.append({
      worldId,
      chainId: "cache-reuse-dialogue",
      exchangeId,
      playerText: "",
      modelHost: host,
    });
  const bodies = sentRequestBodies(fetch_);
  expect(bodies).toHaveLength(6);
  const percents = cacheReuseRatios(bodies).map(cacheReusePercent);
  expect(percents).toHaveLength(5);
  expect(percents.filter((percent) => percent < 99)).toEqual([]);
});

test("缓存复用模拟：工具循环中的每次再次派发同样复用已发送前缀", async () => {
  const steps: CacheSimStep[] = [
    { toolId: "list-1" },
    { toolId: "list-2" },
    { text: cacheSimReply() },
    { toolId: "list-3" },
    { text: cacheSimReply() },
  ];
  const { host, fetch_ } = cacheSimHost(steps);
  const { worlds, worldId } = await createWorld(
    "cache-reuse-tools",
    worldFiles(),
    host.binding(),
  );
  const chains = new PlayCallChain(worlds);
  await chains.start({
    worldId,
    chainId: "cache-reuse-tools",
    exchangeId: "first",
    playerText: "I nod to Alex.",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: host.binding(),
    modelHost: host,
  });
  await chains.append({
    worldId,
    chainId: "cache-reuse-tools",
    exchangeId: "continue",
    playerText: "",
    modelHost: host,
  });
  const bodies = sentRequestBodies(fetch_);
  expect(bodies).toHaveLength(5);
  const percents = cacheReuseRatios(bodies).map(cacheReusePercent);
  expect(percents).toHaveLength(4);
  expect(percents.filter((percent) => percent < 99)).toEqual([]);
});
