import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { ModelConnectionStore } from "../../src/runtime/model/ModelConnectionStore.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { createServer } from "../../src/server/createServer.ts";

const [configFile, evidencePath, mode] = process.argv.slice(2);
assert(
  configFile && evidencePath && [undefined, "--preflight"].includes(mode),
  "Usage: node scripts/evaluate-iou/run.mjs <model-connections-v1.json> <new-evidence-directory> [--preflight]",
);
const previewOnly = mode === "--preflight";
const plan = JSON.parse(
  await readFile(new URL("./plan.json", import.meta.url)),
);
const output = resolve(evidencePath);
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const locale = "zh-CN";
const { connections } = JSON.parse(await readFile(configFile));
const matches = connections.filter((connection) =>
  new FileNativeModelHost(connection).matchesBinding(plan.historicalConnection),
);
assert.equal(
  matches.length,
  1,
  "The library must contain one matching #161 connection",
);
const [connection] = matches;
const secrets = connections.map(({ apiKey }) => apiKey).filter(Boolean);
const scrub = (value) =>
  secrets.reduce(
    (text, secret) => text.replaceAll(secret, "[REDACTED]"),
    value,
  );
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeJson = (data) => scrub(JSON.stringify(data, null, 2)) + "\n";
const save = async (file, data) => {
  const encoded = safeJson(data);
  await writeFile(join(output, file), encoded, { flag: "wx", mode: 0o600 });
  return digest(encoded);
};
const scope = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
const originalParameters = plan.historicalRequestParameters;

function parameters({ messages, tools, ...requestParameters }) {
  assert(Array.isArray(messages) && tools.length > 0);
  return requestParameters;
}

globalThis.fetch = async (url, options) => {
  const record = scope.getStore();
  assert(record, "Unexpected provider fetch outside a registered send");
  const body = JSON.parse(options.body);
  const entry = {
    step: record.requests.length + 1,
    method: options.method,
    body,
  };
  record.requests.push(entry);
  if (entry.step === 1) {
    entry.parameterMatch = true;
    try {
      assert.deepEqual(parameters(body), originalParameters);
    } catch (error) {
      entry.parameterMatch = false;
      throw error;
    }
  }
  const response = await realFetch(url, {
    ...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(240_000)]),
  });
  entry.status = response.status;
  return response;
};

const cases = [];
for (let repeat = 1; repeat <= plan.repeats; repeat++) {
  for (const [scenario, { questions }] of Object.entries(plan.scenarios)) {
    for (const question of Object.keys(questions)) {
      cases.push({
        id: `${scenario}-${question}-${repeat}`,
        scenario,
        question,
        repeat,
      });
    }
  }
}

function filesFor({ opening, state }) {
  return [
    { path: "opening.md", contents: opening },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前局面\n  summary: 账房当前局面。\n  aliases: []\n情况: ${JSON.stringify(state)}\n`,
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界规则\n\n当前情境正文是本场景已成立的事实与条件。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}

function changes(before, after) {
  const index = (endpoint) =>
    new Map(endpoint.state.map(({ path, contents }) => [path, contents]));
  const previous = index(before);
  const current = index(after);
  return [...new Set([...previous.keys(), ...current.keys()])]
    .sort()
    .flatMap((path) => {
      const before = previous.get(path) ?? null;
      const after = current.get(path) ?? null;
      return before === after ? [] : [{ path, before, after }];
    });
}

async function send(server, request, stream = false) {
  const response = await server.inject({
    method: "POST",
    url: "/api/runtime/v1",
    headers: {
      host: "127.0.0.1:49191",
      ...(stream && { accept: "application/x-ndjson" }),
    },
    payload: { protocol: "narraeon.runtime/v1", request },
  });
  assert.equal(
    response.statusCode,
    200,
    scrub(`${request.type}: ${response.body}`),
  );
  if (!stream) return response.json().result;
  assert.match(response.headers["content-type"], /^application\/x-ndjson/u);
  const frames = response.body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).frame);
  const final = frames.at(-1);
  assert(
    final.kind === "snapshot" && final.final,
    scrub(JSON.stringify(final)),
  );
  return final.value;
}

async function runCase(scratch, staticRoot, sample) {
  const scenario = plan.scenarios[sample.scenario];
  const root = join(scratch, sample.id);
  const dataRoot = join(root, "data");
  const configRoot = join(root, "config");
  const worlds = new FileNativeWorldStore(dataRoot);
  const result = { ...sample, status: "incomplete", turns: [] };
  let server;
  try {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configRoot, "model-connections-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeConnectionId: connection.id,
        connections: [connection],
      }),
      { mode: 0o600 },
    );
    const normalized = await new ModelConnectionStore(configRoot).bind();
    assert.deepEqual(
      new FileNativeModelHost(normalized).binding(),
      plan.historicalConnection,
    );
    assert(!normalized.modelPrompt, "Unexpected connection-level prompt");
    const runtime = new V1Runtime({ dataRoot, configRoot });
    await runtime.initialize();
    server = await createServer({
      runtime,
      staticRoot,
      port: 49191,
      logger: false,
    });
    const request = (command) => send(server, command);
    assert.equal(
      (await request({ type: "preferences.save", locale })).locale,
      locale,
    );
    const { playPresets } = await request({ type: "workspace.read" });
    const preset = playPresets.presets.find(
      ({ id }) => id === playPresets.currentPresetId,
    );
    assert.equal(preset.name, "default");
    assert.equal(
      preset.revision,
      builtinDefaultPlayPresetBinding(locale).revision,
    );
    result.preset = { id: preset.id, revision: preset.revision };
    const { localId: packageId } = await request({ type: "content.create" });
    const { treeRevision } = await request({ type: "content.read", packageId });
    await request({
      type: "content.replace",
      packageId,
      baseTreeRevision: treeRevision,
      files: filesFor(scenario),
    });
    const { outcome, world } = await request({
      type: "world.create",
      packageId,
      operationId: sample.id,
      model: plan.historicalConnection,
    });
    assert.equal(outcome, "created");
    const { worldId } = world;
    result.worldId = worldId;
    result.genesis = await worlds.recoverEndpoint(worldId);
    assert.deepEqual(
      result.genesis.history.map(({ role, exactText }) => [role, exactText]),
      [["narrator", scenario.opening]],
    );
    assert.deepEqual(
      result.genesis.state.map(({ path, contents }) => [path, contents]),
      [["current-situation.yaml", filesFor(scenario)[1].contents]],
    );
    const verifyPublicHead = async (checkpoint) => {
      const publicWorld = await request({ type: "world.read", worldId });
      assert.equal(publicWorld.head, checkpoint.head);
      return publicWorld.head;
    };
    result.publicGenesis = await verifyPublicHead(result.genesis);

    if (previewOnly) {
      const { wireRequest } = await request({
        type: "prompt.preview",
        packageId,
        playerInput: scenario.input,
        model: plan.historicalConnection,
      });
      assert.deepEqual(parameters(wireRequest.body), originalParameters);
      result.preview = wireRequest.body;
      result.status = "preflight";
      return result;
    }

    const chainId = sample.id;
    const inputs = [scenario.input, scenario.questions[sample.question]];
    let before = result.genesis;
    for (const [index, playerText] of inputs.entries()) {
      const command = {
        type: index === 0 ? "play.chain.start" : "play.chain.append",
        worldId,
        chainId,
        exchangeId: `${chainId}-${index + 1}`,
        playerText,
      };
      const turn = { command, requests: [] };
      result.turns.push(turn);
      let receipt;
      try {
        receipt = await scope.run(turn, () => send(server, command, true));
      } finally {
        turn.after = await worlds.recoverEndpoint(worldId);
        turn.changes = changes(before, turn.after);
        const saved = (await worlds.playTimeline.readCurrent(worldId))?.value;
        turn.events =
          saved?.events
            .filter(
              ({ kind }) => kind === "tool_call" || kind === "tool_result",
            )
            .slice(
              result.turns
                .slice(0, -1)
                .reduce((count, entry) => count + entry.events.length, 0),
            ) ?? [];
      }
      turn.status = receipt.status;
      turn.failure = receipt.lastFailure;
      turn.failureKind = receipt.lastFailureKind;
      turn.publicHead = await verifyPublicHead(turn.after);
      if (receipt.status !== "ready") return result;
      const appended = turn.after.history.slice(before.history.length);
      assert.deepEqual(
        appended.map(({ role }) => role),
        ["player", "narrator"],
      );
      assert.equal(appended[0].exactText, playerText);
      assert(appended[1].exactText.trim());
      assert(turn.requests[0]?.parameterMatch, "Missing provider request");
      turn.narrative = appended[1].exactText;
      before = turn.after;
    }
    assert.deepEqual(
      await worlds.recoverEndpoint(worldId, result.genesis.head),
      result.genesis,
    );
    assert.deepEqual(
      await worlds.recoverEndpoint(worldId, result.turns[0].after.head),
      result.turns[0].after,
    );
    result.historicalEndpointsVerified = true;
    result.status = "complete";
  } catch (error) {
    result.error = scrub(error.stack ?? String(error));
  } finally {
    await server?.close();
  }
  return result;
}

await mkdir(output, { mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), "narraeon-161-eval-"));
try {
  const staticRoot = join(scratch, "static");
  await mkdir(staticRoot);
  await writeFile(
    join(staticRoot, "index.html"),
    await readFile(join(sourceRoot, "index.html")),
  );
  const selected = previewOnly
    ? cases.filter(({ repeat }) => repeat === 1)
    : cases;
  await save("manifest.json", {
    sourceRoot,
    plan,
    connectionName: connection.name,
    cases: selected,
    previewOnly,
  });
  let next = 0;
  const summaries = new Map();
  await Promise.all(
    Array.from({ length: plan.workers }, async () => {
      while (next < selected.length) {
        const sample = selected[next++];
        const result = await runCase(scratch, staticRoot, sample);
        const sha256 = await save(`${sample.id}.json`, result);
        console.log(
          `${sample.id}: ${result.status} (${result.turns.map(({ requests }) => requests.length).join("+")})`,
        );
        summaries.set(sample.id, {
          ...sample,
          status: result.status,
          sha256,
          worldId: result.worldId,
        });
      }
    }),
  );
  const summary = selected.map(({ id }) => summaries.get(id));
  await save("summary.json", summary);
  const expected = previewOnly ? "preflight" : "complete";
  assert.equal(
    new Set(summary.map(({ worldId }) => worldId)).size,
    summary.length,
  );
  if (summary.some(({ status }) => status !== expected)) process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await rm(scratch, { recursive: true, force: true });
}
