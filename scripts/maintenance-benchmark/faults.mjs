import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loopbackProvider,
  modelBinding,
  rpc,
  runtimeServer,
} from "./common.mjs";

const model = modelBinding("failure-log-fixture");
const text = {
  content: "The keeper looks out over the harbor and checks her watch. ".repeat(
    18,
  ),
};
function tool(id, name, args) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
const list = (id) => tool(id, "state_list", { parent: "@dir-/" });
const blocked = tool("invalid-patch", "world_patch", {
  target: "@missing",
  edits: [],
});

async function directory(path) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function snapshot(logRoot) {
  const files = [];
  for (const name of (await directory(logRoot)).filter((entry) =>
    entry.endsWith(".jsonl"),
  )) {
    const source = await readFile(join(logRoot, name));
    const entries = source
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    files.push({
      name,
      bytes: source.byteLength,
      exchanges: entries
        .filter(({ type }) => type === "exchange")
        .map(({ exchange }) => ({
          responseStatus: exchange.response?.status ?? null,
          requestBodyBytes: Buffer.byteLength(exchange.request.body),
          responseBodyBytes: Buffer.byteLength(exchange.response?.body ?? ""),
          exchange: exchange.context.exchange,
          requestAttempt: exchange.context.requestAttempt,
        })),
      failures: entries
        .filter(({ type }) => type === "failure")
        .flatMap(({ failures }) => failures.map(({ kind }) => kind)),
      resolved: entries.some(({ type }) => type === "resolved"),
    });
  }
  const stateRoot = join(logRoot, ".state");
  const stateFiles = await Promise.all(
    (await directory(stateRoot)).map(async (name) => {
      const source = await readFile(join(stateRoot, name));
      return {
        name,
        bytes: source.byteLength,
        status: JSON.parse(source).status,
      };
    }),
  );
  return {
    files,
    stateFiles,
    logBytes: files.reduce((total, { bytes }) => total + bytes, 0),
    stateBytes: stateFiles.reduce((total, { bytes }) => total + bytes, 0),
  };
}

async function measureFaultScenario(root, evidence, repeat) {
  const provider = await loopbackProvider();
  let runtime;
  try {
    runtime = await runtimeServer(root);
    const logRoot = join(runtime.logRoot, "ai-failures");
    const request = (command, options) => rpc(runtime.url, command, options);
    await request({
      type: "model.save",
      connection: {
        ...model,
        name: "Synthetic log benchmark",
        presetId: "custom",
        baseUrl: provider.url,
        apiKey: "synthetic-local-credential",
      },
    });
    const { localId: packageId } = await request({ type: "content.create" });
    const { outcome, world } = await request({
      type: "world.create",
      packageId,
      operationId: "measure-failure-log",
      model,
    });
    assert.equal(outcome, "created");

    const stages = [];
    const chainId = "benchmark-faults";
    let invocation = 0;
    async function send(responses, { expected = "ready", retry = false } = {}) {
      const preceding = provider.requests.length;
      provider.pending.push(...responses);
      invocation++;
      const view = await request(
        {
          type: invocation === 1 ? "play.chain.start" : "play.chain.append",
          chainId,
          worldId: world.worldId,
          exchangeId: `send-${invocation}`,
          playerText: retry
            ? ""
            : `Pass ${invocation}: I look along the dock for the harbor keeper.`,
        },
        { stream: true },
      );
      assert.equal(view.status, expected, view.lastFailure ?? undefined);
      assert.deepEqual(provider.pending, []);
      assert.equal(provider.requests.length - preceding, responses.length);
      return view;
    }

    async function mark(phase) {
      const observation = {
        phase,
        requests: provider.requests.length,
        ...(await snapshot(logRoot)),
      };
      stages.push(observation);
      return observation;
    }
    const findIncident = (stage, kind) =>
      stage.files.find(({ failures }) => failures.includes(kind));

    await mark("new-world");
    for (let index = 1; index <= 8; index++) {
      const view = await send(
        index % 4 === 0 ? [list(`baseline-${index}`), text] : [text],
      );
      const clean = await mark(`normal-${index}`);
      assert.equal(
        clean.logBytes,
        0,
        JSON.stringify({
          index,
          results: view.events.filter(({ kind }) => kind === "tool_result"),
          files: clean.files,
        }),
      );
      assert.equal(clean.stateBytes, 0);
    }

    const repairedTool = await send([blocked, list("tool-recovery"), text]);
    assert(
      repairedTool.events.some(
        ({ kind, ok, callId }) =>
          kind === "tool_result" && ok === false && callId === "invalid-patch",
      ),
    );
    assert(
      repairedTool.events.some(
        ({ kind, ok, callId }) =>
          kind === "tool_result" && ok && callId === "tool-recovery",
      ),
    );
    const toolRecovery = await mark("tool-rejection-and-recovery");
    const toolIncident = findIncident(toolRecovery, "tool_execution");
    assert.equal(toolRecovery.files.length, 1);
    assert.equal(toolIncident.exchanges.length, 3);
    assert.equal(toolIncident.resolved, true);
    assert.deepEqual(
      toolRecovery.stateFiles.map(({ status }) => status),
      ["resolved"],
    );

    for (let index = 1; index <= 3; index++) await send([text]);
    const afterTool = await mark("three-turns-after-tool-recovery");
    assert.deepEqual(afterTool.files, toolRecovery.files);
    assert.deepEqual(afterTool.stateFiles, toolRecovery.stateFiles);

    const providerError = await send(["unavailable"], {
      expected: "interrupted",
    });
    assert.equal(providerError.canRetry, true);
    const interrupted = await mark("provider-failure-before-retry");
    const openedIncident = findIncident(interrupted, "provider_rejection");
    assert.equal(interrupted.files.length, 2);
    assert.equal(openedIncident.exchanges.length, 1);
    assert.equal(openedIncident.resolved, false);
    assert.deepEqual(
      interrupted.stateFiles.map(({ status }) => status),
      ["active"],
    );
    assert.equal(openedIncident.exchanges[0].responseStatus, 503);

    await runtime.server.close();
    runtime = await runtimeServer(root);
    const restarted = await mark("runtime-restarted");
    assert.deepEqual(restarted.files, interrupted.files);
    assert.deepEqual(restarted.stateFiles, interrupted.stateFiles);
    await send([list("provider-recovery"), text], { retry: true });
    const providerRecovery = await mark("provider-recovery");
    const closedIncident = findIncident(providerRecovery, "provider_rejection");
    assert.equal(closedIncident.name, openedIncident.name);
    assert.equal(closedIncident.exchanges.length, 3);
    assert.equal(closedIncident.resolved, true);
    assert.deepEqual(
      providerRecovery.stateFiles.map(({ status }) => status),
      ["resolved"],
    );
    assert.deepEqual(
      findIncident(providerRecovery, "tool_execution"),
      toolIncident,
    );

    for (let index = 1; index <= 3; index++) await send([text]);
    const afterProvider = await mark("three-turns-after-provider-recovery");
    assert.deepEqual(afterProvider.files, providerRecovery.files);
    assert.deepEqual(afterProvider.stateFiles, providerRecovery.stateFiles);

    const archive = join(evidence, `synthetic-incidents-${repeat}`);
    await mkdir(archive, { mode: 0o700 });
    for (const { name } of afterProvider.files)
      await copyFile(
        join(logRoot, name),
        join(archive, name),
        constants.COPYFILE_EXCL,
      );
    return {
      repeat,
      invocations: invocation,
      providerRequests: provider.requests,
      stages,
    };
  } finally {
    await runtime?.server.close();
    await provider.close();
  }
}

export async function measureFaults(root, evidence, repeats) {
  const samples = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    console.error(`failure log ${repeat}/${repeats}`);
    samples.push(
      await measureFaultScenario(join(root, String(repeat)), evidence, repeat),
    );
  }
  return samples;
}
