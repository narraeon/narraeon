import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import {
  FileNativePlayPresetStore,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { playerInputAppend } from "../../src/runtime/play/PlayContinuity.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { updateWorldActivity } from "../../src/runtime/world/WorldActivity.ts";
import { WorldLedgerAuthority } from "../../src/runtime/world/WorldLedgerAuthority.ts";

const chainId = "harbor-watch";
const statePath = "current-situation.yaml";
const baselineTime = Date.UTC(2026, 0, 1);
const modelBinding = {
  provider: "chat_completions",
  endpointFingerprint: "fixture",
  modelId: "world-open-benchmark",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 8_192,
  protocolConfigFingerprint: "fixture-chat",
};
const width = (number) => String(number).padStart(4, "0");
const playerText = (round) =>
  `Watch ${width(round)}. I ask the harbor keeper who passed the chain before the tide turned.`;
const replyText = (round) =>
  `Watch ${width(round)}. ` +
  "The keeper opens the ledger beside the lamp. Salt clings to the fold while she traces the marks with a fingertip. The bell sounded twice before dawn, and a boat waited without cargo on the north pier. "
    .repeat(5)
    .trim();
const patchCall = (round) => ({
  id: `watch-${round}`,
  name: "world_patch",
  arguments: {
    target: "@current-situation",
    edits: [{ op: "replace", locator: { yaml: ["watch"] }, value: round }],
  },
});
const hash = (contents) =>
  `sha256:${createHash("sha256").update(contents).digest("hex")}`;
const headNumber = (round, changesState) => round * (changesState ? 3 : 2);

function packageFiles() {
  const files = minimalFileNativeContentScaffold("en");
  const situation = files.find(({ path }) => path === `world/${statePath}`);
  situation.contents += "watch: 0\n";
  const views = files.find(({ path }) => path === "control/player-views.yaml");
  views.contents = `format: narraeon.player-views/v1
views:
  - id: watch
    title: Harbor status
    items:
      - id: watch-number
        label: Watch
        select: { document: situation.current, locator: { yaml: [watch] } }
`;
  for (let index = 1; index <= 8; index++) {
    files.push({
      path: `world/characters/keeper-${index}.yaml`,
      contents: `$document:
  id: harbor.keeper-${index}
  ref: keeper-${index}
  title: Harbor keeper ${index}
  summary: One of the shore guards.
  aliases: []
station: North pier
equipment: [Lantern, Ledger, Key]
schedule: Watch the chain until the next bell.
`,
    });
  }
  return files;
}

function assistantTranscript(text, toolCalls) {
  return {
    kind: "assistant",
    text,
    toolCalls,
    providerState: {
      protocol: "chat_completions",
      assistantMessage: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length === 0
          ? {}
          : {
              tool_calls: toolCalls.map(({ id, name, arguments: args }) => ({
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              })),
            }),
      },
    },
  };
}

export async function buildFixture(dataRoot, rounds, workload) {
  const started = performance.now();
  const changesState = workload === "state";
  const configRoot = join(dataRoot, "config");
  const presetStore = new FileNativePlayPresetStore(configRoot, {
    locale: () => "en",
  });
  await presetStore.initialize();
  const playPreset = await presetStore.freeze();
  const hostBinding = presetHostBinding(playPreset);
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  const worlds = new FileNativeWorldStore(dataRoot, {
    promptCompiler: compiler,
  });
  const { world } = await worlds.createFromContentPackage({
    operationId: "create-harbor",
    sourcePackageId: "harbor-package",
    sourcePackageTitle: "Harbor watch",
    packageFiles: packageFiles(),
    prompt: { hostBinding, modelBinding },
  });
  const { worldId } = world;
  const worldRoot = join(dataRoot, "worlds-file-native", worldId);
  const authority = new WorldLedgerAuthority(worldRoot);
  const chains = new PlayCallChain(worlds, compiler);
  const first = await chains.start({
    worldId,
    chainId,
    exchangeId: "watch-1",
    playerText: playerText(1),
    hostBinding,
    playPreset,
    modelBinding,
    modelHost: new ScriptedModelHost({
      binding: modelBinding,
      steps: [
        ...(changesState
          ? [{ outcome: "response", toolCalls: [patchCall(1)] }]
          : []),
        { outcome: "response", text: replyText(1) },
      ],
    }),
  });
  assert.equal(first.status, "ready");
  assert.equal(first.parentHead, `commit:${headNumber(1, changesState)}`);
  const { value, cursor } = await worlds.playTimeline.readCurrent(worldId);
  const acceptedPatch = changesState ? value.completedTools[0].result : null;
  if (changesState) {
    assert.equal(acceptedPatch.ok, true);
    assert.match(
      acceptedPatch.markdown,
      /^@current-situation write succeeded/u,
    );
  }
  const seed = await authority.recover();
  let previousState = seed.state.find(
    ({ path }) => path === statePath,
  ).contents;
  let parentHead = first.parentHead;
  let exchange = value.exchange;

  async function commit(operationId, historyAppend, stateChanges = []) {
    const result = await authority.appendCommit({
      operationId,
      parentHead,
      mode: "play",
      playContext: chainId,
      historyAppend,
      stateChanges,
      nextMaterials: [],
    });
    parentHead = result.commit.head;
    return parentHead;
  }
  const event = (data) =>
    value.events.push({ ...data, id: value.events.length + 1 });

  for (let round = 2; round <= rounds; round++) {
    const input = playerText(round);
    const reply = replyText(round);
    event({
      kind: "player",
      exchangeId: `watch-${round}`,
      text: input,
      context: "append",
      committedHead: await commit(`watch-${round}-player`, [
        { role: "player", exactText: input },
      ]),
    });
    value.transcript.push(...playerInputAppend(input, "en"));
    if (changesState) {
      const call = patchCall(round);
      const nextState = previousState.replace(
        /^watch: \d+$/mu,
        `watch: ${round}`,
      );
      assert.notEqual(nextState, previousState);
      event({
        kind: "assistant",
        text: "",
        status: "completed",
        responseKind: "tool_step",
        exchange: ++exchange,
        attempt: 1,
        continuation: "available",
        committedHead: await commit(
          `watch-${round}-patch`,
          [],
          [
            {
              kind: "replace",
              documentId: "situation.current",
              stableShortRef: "current-situation",
              relativePath: statePath,
              codec: "yaml",
              expectedPreviousHash: hash(previousState),
              nextHash: hash(nextState),
              canonicalNextBytes: nextState,
            },
          ],
        ),
      });
      previousState = nextState;
      event({
        kind: "tool_call",
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
        replayed: false,
      });
      event({
        kind: "tool_result",
        callId: call.id,
        name: call.name,
        ok: true,
        markdown: acceptedPatch.markdown,
        replayed: false,
      });
      value.transcript.push(assistantTranscript("", [call]), {
        kind: "tool",
        toolCallId: call.id,
        markdown: acceptedPatch.markdown,
      });
      value.completedTools.push({
        key: `${exchange}:${call.id}`,
        name: call.name,
        signature: JSON.stringify(call.arguments),
        result: acceptedPatch,
      });
    }
    event({
      kind: "assistant",
      text: reply,
      responseKind: "narrative",
      status: "completed",
      exchange: ++exchange,
      attempt: 1,
      continuation: "available",
      committedHead: await commit(`watch-${round}-reply`, [
        { role: "narrator", exactText: reply },
      ]),
    });
    value.transcript.push(assistantTranscript(reply, []));
  }
  Object.assign(value, {
    parentHead,
    exchange,
    nextEventId: value.events.length + 1,
    updatedAt: baselineTime,
    // The measured read paths do not consume a frozen Provider retry request.
    lastRequest: null,
    lastRequestAttempt: 0,
  });
  await worlds.playTimeline.persist(value, cursor);

  // Verify via production readers before firing the independent measured workers.
  const endpoint = await worlds.recoverEndpoint(worldId);
  assert.equal(endpoint.head, `commit:${headNumber(rounds, changesState)}`);
  assert.equal(endpoint.history.length, 2 * rounds + 1);
  assert.equal(endpoint.history.at(-1).exactText, replyText(rounds));
  const middle = Math.floor(rounds / 2);
  const previous = await authority.recoverState(
    `commit:${headNumber(middle, changesState)}`,
  );
  const oldState = previous.find(({ path }) => path === statePath).contents;
  assert.match(
    oldState,
    new RegExp(`^watch: ${changesState ? middle : 0}$`, "mu"),
  );
  const loaded = (await worlds.playTimeline.readCurrent(worldId)).value;
  assert.equal(loaded.events.length, rounds * (changesState ? 5 : 2));
  assert.equal(loaded.transcript.length, rounds * (changesState ? 4 : 2));
  assert.equal(loaded.completedTools.length, changesState ? rounds : 0);
  assert.equal(loaded.events.at(-1).text, endpoint.history.at(-1).exactText);
  await updateWorldActivity(
    worldRoot,
    endpoint.head,
    endpoint.history,
    baselineTime,
  );
  const firstPage = await worlds.playTimeline.readPage(worldId, 40);
  assert.equal(firstPage.items.length, 40);
  assert(firstPage.nextCursor);
  const secondPage = await worlds.playTimeline.readPage(
    worldId,
    40,
    firstPage.nextCursor,
  );
  assert.equal(secondPage.items.length, 40);
  assert(secondPage.items.at(-1).event.id < firstPage.items[0].event.id);

  return {
    worldId,
    head: endpoint.head,
    rounds,
    workload,
    seedMs: performance.now() - started,
    stateFiles: endpoint.state.length,
    stateBytes: endpoint.state.reduce(
      (total, file) => total + Buffer.byteLength(file.contents),
      0,
    ),
    historyMessages: endpoint.history.length,
    historyTextBytes: endpoint.history.reduce(
      (total, message) => total + Buffer.byteLength(message.exactText),
      0,
    ),
    ledgerRecords: (await readdir(join(worldRoot, "runtime", "turns"))).length,
    timelineEvents: loaded.events.length,
    completedTools: loaded.completedTools.length,
  };
}
