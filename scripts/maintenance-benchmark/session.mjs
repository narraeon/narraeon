import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import {
  loopbackProvider,
  modelBinding,
  post,
  rpc,
  rpcBody,
  runtimeServer,
} from "./common.mjs";

const model = modelBinding("author-session-fixture");
const answer = {
  content:
    "The dock log contains a dated arrival and departure for each vessel. "
      .repeat(120)
      .trim(),
};

async function authorWorld(url, size) {
  const { localId: packageId } = await rpc(url, { type: "content.create" });
  const { outcome, world } = await rpc(url, {
    type: "world.create",
    packageId,
    operationId: `author-session-${size}`,
    model,
  });
  assert.equal(outcome, "created");
  return { worldId: world.worldId, sessionId: null, turn: 0 };
}

export async function measureSessions(root, repeats) {
  const provider = await loopbackProvider();
  const store = FileNativeWorldRevisionStore.prototype;
  const original = store.saveSession;
  let timedSaves;
  store.saveSession = async function (session) {
    const measurement = timedSaves;
    if (!measurement) return original.call(this, session);
    const started = performance.now();
    await original.call(this, session);
    measurement.push({
      elapsedMs: performance.now() - started,
      status: session.runStatus,
      messages: session.messages.length,
      modelItems: session.modelItems.length,
      requests: session.requests.length,
    });
  };

  let runtime;
  try {
    runtime = await runtimeServer(root);
    const { url, dataRoot } = runtime;
    await rpc(url, {
      type: "model.save",
      connection: {
        ...model,
        name: "Synthetic author benchmark",
        presetId: "custom",
        baseUrl: provider.url,
        apiKey: "synthetic-local-credential",
      },
    });

    async function send(state, measure) {
      const { worldId, sessionId } = state;
      const path =
        sessionId === null
          ? null
          : join(dataRoot, "world-revisions", "sessions", `${sessionId}.json`);
      const beforeSessionBytes = path === null ? null : (await stat(path)).size;
      const turn = ++state.turn;
      provider.pending.push(answer);
      const body = rpcBody({
        type: "world.revision.message",
        worldId,
        requestId: `author-turn-${turn}`,
        message: `Pass ${turn}: read the scene outline and tell me how the keeper uses this log.`,
        continuation:
          sessionId === null
            ? { kind: "fresh_context" }
            : { kind: "continue_context", sessionId },
      });
      timedSaves = measure ? [] : undefined;
      const { bytes, elapsedMs } = await post(url, body);
      const saves = timedSaves;
      timedSaves = undefined;
      const { result } = JSON.parse(bytes);
      assert.equal(result.runStatus, "ready", result.lastFailure ?? undefined);
      assert.equal(result.messages.length, turn * 2);
      assert.equal(result.messages.at(-1).text, answer.content);
      assert.deepEqual(provider.pending, []);
      state.sessionId = result.sessionId;
      if (!measure) return;

      assert.equal(result.sessionId, sessionId);
      assert(saves.length > 0);
      assert.equal(saves.at(-1).status, "ready");
      assert.equal(saves.at(-1).requests, turn);
      return {
        turn,
        beforeSessionBytes,
        afterSessionBytes: (await stat(path)).size,
        rpcElapsedMs: elapsedMs,
        responseBytes: bytes.byteLength,
        providerRequestBytes: provider.requests.at(-1).receivedBytes,
        saves,
      };
    }

    const small = await authorWorld(url, "small");
    const large = await authorWorld(url, "large");
    const seededTurns = { small: 2, large: 24 };
    console.error(
      `author session, seed ${seededTurns.small} and ${seededTurns.large} turns`,
    );
    for (const [state, target] of [
      [small, seededTurns.small],
      [large, seededTurns.large],
    ])
      while (state.turn < target) await send(state, false);

    const samples = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const order =
        repeat % 2
          ? [
              ["small", small],
              ["large", large],
            ]
          : [
              ["large", large],
              ["small", small],
            ];
      for (const [size, state] of order)
        samples.push({ size, repeat, ...(await send(state, true)) });
    }
    const durable = new FileNativeWorldRevisionStore(dataRoot);
    for (const state of [small, large]) {
      const session = await durable.readSession(state.sessionId);
      assert.equal(session.requests.length, state.turn);
      assert.equal(session.messages.length, 2 * state.turn);
      assert.equal(session.runStatus, "ready");
    }
    return {
      seededTurns,
      syntheticReplyUtf8Bytes: Buffer.byteLength(answer.content),
      samples,
    };
  } finally {
    store.saveSession = original;
    await runtime?.server.close();
    await provider.close();
  }
}
