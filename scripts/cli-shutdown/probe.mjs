import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    "hold-ms": { type: "string", default: "1500" },
    "natural-keepalive": { type: "boolean" },
  },
});
assert(values.cli, "Pass --cli <installed narraeon bin>");
const cli = await realpath(resolve(values.cli));
const holdMs = Number(values["hold-ms"]);
assert(Number.isSafeInteger(holdMs) && holdMs > 0, "Invalid --hold-ms");

const host = "127.0.0.1";
const protocol = "narraeon.runtime/v1";
const runtimePath = "/api/runtime/v1";
const chainId = "cli-shutdown";
const waitMs = 30_000;
const naturalKeepAliveMs = 105_000;
const playerText = "I open the journal.";
const nextPlayerText = "I read the next page.";
const committedText = "The journal opens.";
const partialText = "The next page shows";
const finishedText = partialText + " a map.";
const retriedText = "A map unfolds on the next page.";
const event = (choice) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
const stop = event({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n";
const elapsed = (from, at = performance.now()) =>
  at === null ? null : Math.round((at - from) * 10) / 10;

const requireFromCli = createRequire(cli);
const report = {
  environment: {
    platform: process.platform,
    release: release(),
    arch: process.arch,
    node: process.version,
    cliVersion: JSON.parse(
      await readFile(resolve(dirname(cli), "../../../package.json"), "utf8"),
    ).version,
    fastify: requireFromCli("fastify/package.json").version,
    providerHoldMs: holdMs,
    observationTimeoutMs: waitMs,
    naturalKeepAliveObservation: values["natural-keepalive"] === true,
  },
  cases: {},
};
const root = await mkdtemp(join(tmpdir(), "narraeon-cli-shutdown-"));
const children = new Set();
const clients = new Agent({ keepAlive: true, timeout: 0 });
const plans = [];
const calls = [];
const providerErrors = [];
const provider = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(JSON.parse(body).stream, true);
    const plan = plans.shift();
    assert(plan, "Unexpected Provider request");
    calls.push(body);
    response.once("close", () => {
      plan.terminal = response.writableFinished ? "finished" : "peer_closed";
    });
    plan.finish = () => {
      plan.finishedAt = performance.now();
      response.end(
        (plan.tail ? event({ delta: { content: plan.tail } }) : "") + stop,
      );
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(event({ delta: { content: plan.text } }));
    if (!plan.held) plan.finish();
  } catch (error) {
    providerErrors.push(error.message);
    response.destroy(error);
  }
});

function planResponse(text, { held = false, tail = "" } = {}) {
  const plan = { text, tail, held, finishedAt: null, terminal: null };
  plans.push(plan);
  return plan;
}

async function listen(server, port = 0) {
  server.listen(port, host);
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((done) => server.close(done));
}

async function portProbe(port = 0) {
  const server = createTcpServer();
  try {
    return { bound: true, port: await listen(server, port) };
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return { bound: false, error: error.code };
  } finally {
    await closeServer(server);
  }
}

async function waitFor(read, label, timeout = waitMs) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startCli(name, port) {
  port ??= (await portProbe()).port;
  const child = spawn(
    process.execPath,
    [cli, "web", "--port", String(port), "--no-open"],
    {
      env: {
        ...process.env,
        NARRAEON_HOST: host,
        NARRAEON_TRUSTED_ORIGINS: "",
        NARRAEON_DATA_ROOT: join(root, name, "data"),
        NARRAEON_CONFIG_ROOT: join(root, name, "config"),
        NARRAEON_LOG_ROOT: join(root, name, "log"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = `http://${host}:${port}`;
  const run = { child, url, port, exit: null, stdout: "", stderr: "" };
  children.add(run);
  child.stdout.setEncoding("utf8").on("data", (text) => (run.stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (run.stderr += text));
  child.once("exit", (code, signal) => {
    run.exit = { at: performance.now(), code, signal };
  });
  await waitFor(() => {
    assert(
      !run.exit,
      `CLI exited before startup: ${run.stdout}\n${run.stderr}`,
    );
    return run.stdout.includes(`Narraeon started: ${url}\n`);
  }, "installed CLI startup");
  const health = await fetch(url + "/health", {
    headers: { Connection: "close" },
    signal: AbortSignal.timeout(waitMs),
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).protocol, protocol);
  return run;
}

async function rpc(run, request) {
  const response = await fetch(run.url + runtimePath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ protocol, request }),
    signal: AbortSignal.timeout(waitMs),
  });
  const envelope = await response.json();
  assert(response.ok && !envelope.error, JSON.stringify(envelope));
  return envelope.result;
}

async function createWorld(run, providerPort) {
  const model = {
    provider: "chat_completions",
    modelId: "cli-shutdown-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 8192,
  };
  await rpc(run, { type: "preferences.save", locale: "en" });
  await rpc(run, {
    type: "model.save",
    connection: {
      ...model,
      name: "CLI shutdown probe",
      presetId: "custom",
      baseUrl: `http://${host}:${providerPort}/v1`,
      apiKey: "synthetic-shutdown-key",
    },
  });
  const content = await rpc(run, { type: "content.create" });
  const created = await rpc(run, {
    type: "world.create",
    operationId: "cli-shutdown-world",
    packageId: content.localId,
    model,
  });
  return created.world.worldId;
}

function play(worldId, type, exchangeId, playerText) {
  return {
    type: `play.chain.${type}`,
    worldId,
    chainId,
    exchangeId,
    playerText,
  };
}

function readStream(
  run,
  url,
  { command, accept = "text/event-stream", keepAlive = true } = {},
) {
  const sse = accept === "text/event-stream";
  const json = accept === "application/json";
  const frames = [];
  const connection = {
    frames,
    jsonResult: null,
    response: null,
    terminal: null,
    socketClosedAt: null,
    error: null,
  };
  const request = httpRequest(run.url + url, {
    method: sse ? "GET" : "POST",
    agent: clients,
    headers: {
      Accept: accept,
      ...(sse ? {} : { "Content-Type": "application/json" }),
      Connection: keepAlive ? "keep-alive" : "close",
    },
  });
  request.once("socket", (socket) => {
    socket.once("close", () => {
      connection.socketClosedAt = performance.now();
    });
  });
  request.on("error", (error) => {
    connection.error = error;
  });
  request.on("response", (response) => {
    connection.response = response;
    let pending = "";
    const delimiter = sse ? "\n\n" : "\n";
    response.setEncoding("utf8").on("data", (chunk) => {
      pending += chunk;
      if (json) return;
      const records = pending.split(delimiter);
      pending = records.pop();
      try {
        for (const record of records) {
          if (!sse) {
            frames.push(parseEnvelope(record).frame);
          } else if (record.includes("\nevent: observation\n")) {
            const data = record
              .split("\n")
              .find((line) => line.startsWith("data: "));
            frames.push(parseEnvelope(data.slice(6)).update);
          } else if (record.startsWith("event: failure\n")) {
            throw new Error(record);
          }
        }
      } catch (error) {
        connection.error = error;
      }
    });
    response.on("error", (error) => {
      connection.error = error;
    });
    if (json)
      response.once("end", () => {
        try {
          connection.jsonResult = parseEnvelope(pending).result;
        } catch (error) {
          connection.error = error;
        }
      });
    response.once("close", () => {
      connection.terminal = {
        at: performance.now(),
        httpComplete: response.complete,
        kind: response.readableEnded ? "eof" : "aborted",
        error: connection.error?.code ?? connection.error?.message ?? null,
      };
    });
  });
  connection.disconnect = () => request.socket.destroy();
  request.end(sse ? undefined : JSON.stringify({ protocol, request: command }));
  connection.ready = async () => {
    const response = await waitFor(() => {
      if (connection.error) throw connection.error;
      return connection.response;
    }, accept + " headers");
    assert.equal(response.statusCode, 200);
    assert(response.headers["content-type"]?.startsWith(accept));
  };
  return connection;
}

function parseEnvelope(text) {
  const envelope = JSON.parse(text);
  assert.equal(envelope.protocol, protocol);
  assert(!envelope.error, JSON.stringify(envelope.error));
  return envelope;
}

function finalView(stream) {
  return (
    stream.jsonResult ??
    stream.frames.find((frame) => frame.kind === "snapshot" && frame.final)
      ?.value
  );
}

function summary(view) {
  return {
    status: view.status,
    canRetry: view.canRetry,
    activeInvocation: view.activeInvocation !== undefined,
    lastFailureKind: view.lastFailureKind ?? null,
    events: view.events
      .filter(({ kind }) => kind === "player" || kind === "assistant")
      .map(({ kind, text, status, committedHead }) => ({
        kind,
        text,
        status,
        committedHead,
      })),
  };
}

function terminate(run) {
  const at = performance.now();
  assert(run.child.kill("SIGTERM"), "Could not signal the installed CLI");
  return at;
}

async function observeExit(run, at, stream, timeout) {
  await waitFor(() => run.exit, "CLI exit", timeout);
  if (stream) await waitFor(() => stream.socketClosedAt, "HTTP socket close");
  const { code, signal } = run.exit;
  const port = await portProbe(run.port);
  const terminal = stream?.terminal;
  return {
    exit: { code, signal, msFromSigterm: elapsed(at, run.exit.at) },
    connection: terminal
      ? {
          kind: terminal.kind,
          httpComplete: terminal.httpComplete,
          error: terminal.error,
          responseClosedMsFromSigterm: elapsed(at, terminal.at),
          socketClosedMsFromSigterm: elapsed(at, stream.socketClosedAt),
          exitMsAfterResponseClosed: elapsed(terminal.at, run.exit.at),
        }
      : null,
    portRebound: port.bound,
  };
}

function assertGraceful(result) {
  assert.equal(result.exit.code, 0);
  assert.equal(result.exit.signal, null);
  assert.equal(result.portRebound, true);
}

async function inspect(run, worldId) {
  const world = await rpc(run, { type: "world.read", worldId });
  const view = await rpc(run, { type: "play.chain.inspect", worldId });
  return { head: world.head, ...summary(view) };
}

function assertCommittedExchange(view, assistantText) {
  assert.deepEqual(
    view.events.filter(({ kind }) => kind === "player").map(({ text }) => text),
    [playerText, nextPlayerText],
  );
  assert.equal(
    view.events.filter(
      ({ kind, text, committedHead }) =>
        kind === "assistant" && text === assistantText && committedHead,
    ).length,
    1,
  );
}

async function runChecks(providerPort) {
  const idle = await startCli("idle");
  const idleReport = (report.cases.idle = await observeExit(
    idle,
    terminate(idle),
  ));
  assertGraceful(idleReport);

  const sse = await startCli("sse");
  const sseWorld = await createWorld(sse, providerPort);
  const observer = readStream(
    sse,
    `${runtimePath}/events?kind=play&id=${sseWorld}`,
  );
  await observer.ready();
  const update = await waitFor(
    () => observer.frames[0],
    "real SSE observation",
  );
  assert.equal(update.kind, "snapshot");
  assert.equal(update.value.kind, "play");
  assert.equal(observer.terminal, null);
  assert.equal(observer.socketClosedAt, null);
  const sseReport = (report.cases.sse = {
    beforeSigterm: { observation: update, connectionOpen: true },
  });
  Object.assign(sseReport, await observeExit(sse, terminate(sse), observer));
  assertGraceful(sseReport);
  assert(sseReport.connection);

  const completed = await startCli("ndjson-completed");
  const completedWorld = await createWorld(completed, providerPort);
  planResponse(committedText);
  const done = readStream(completed, runtimePath, {
    command: play(completedWorld, "start", "first", playerText),
    accept: "application/x-ndjson",
  });
  await done.ready();
  await waitFor(() => done.terminal, "completed NDJSON response");
  assert.equal(done.terminal.kind, "eof");
  assert.equal(done.socketClosedAt, null);
  const beforeCompleted = finalView(done);
  assert.equal(beforeCompleted?.status, "ready");
  const completedReport = (report.cases.ndjsonCompleted = {
    beforeSigterm: {
      final: summary(beforeCompleted),
      keepAliveSocketOpen: true,
    },
  });
  Object.assign(
    completedReport,
    await observeExit(completed, terminate(completed), done),
  );
  assertGraceful(completedReport);

  const activeCases = [
    { name: "ndjsonDrainedConnectionClose", keepAlive: false },
    { name: "ndjsonDrainedKeepAlive" },
    { name: "jsonDrainedKeepAlive", json: true },
    { name: "ndjsonInterrupted", forceStop: true },
  ];
  for (const { name, forceStop, json, keepAlive = true } of activeCases) {
    const active = await startCli(name);
    const worldId = await createWorld(active, providerPort);
    planResponse(committedText);
    const seeded = await rpc(
      active,
      play(worldId, "start", "first", playerText),
    );
    assert.equal(seeded.status, "ready");

    const held = planResponse(partialText, { held: true, tail: " a map." });
    const stream = readStream(active, runtimePath, {
      command: play(worldId, "append", "next", nextPlayerText),
      accept: json ? "application/json" : "application/x-ndjson",
      keepAlive,
    });
    let delta;
    if (!json) {
      await stream.ready();
      delta = await waitFor(
        () =>
          stream.frames.find(
            (frame) =>
              frame.kind === "assistant_delta" && frame.text === partialText,
          ),
        "live NDJSON text from the held Provider",
      );
    }
    assert.equal(held.finishedAt, null);
    assert.equal(stream.terminal, null);
    const before = await waitFor(async () => {
      const view = await inspect(active, worldId);
      return view.events.some((entry) => entry.text === partialText) && view;
    }, "Runtime to observe the held Provider's text");
    assert.equal(before.status, "running");
    assert.equal(before.activeInvocation, true);
    const activeReport = (report.cases[name] = {
      responseFormat: json ? "json" : "ndjson",
      requestConnection: keepAlive ? "keep-alive" : "close",
      beforeSigterm: { delta, ...before },
    });
    const at = terminate(active);
    await delay(holdMs);
    activeReport.whileProviderHeld = {
      msFromSigterm: elapsed(at),
      processAlive: active.exit === null,
      responsePending: stream.terminal === null,
      providerOpen: held.terminal === null,
      finalResultReceived: finalView(stream) !== undefined,
      portRebound: (await portProbe(active.port)).bound,
    };
    assert(activeReport.whileProviderHeld.processAlive);
    assert(activeReport.whileProviderHeld.responsePending);
    assert(activeReport.whileProviderHeld.providerOpen);
    assert.equal(activeReport.whileProviderHeld.finalResultReceived, false);

    const waitForPeerClose =
      values["natural-keepalive"] && keepAlive && !forceStop;
    if (forceStop) {
      activeReport.harnessSigkillMsFromSigterm = elapsed(at);
      assert(active.child.kill("SIGKILL"));
    } else {
      held.finish();
      activeReport.providerReleasedMsFromSigterm = elapsed(at, held.finishedAt);
      await stream.ready();
      await waitFor(
        () => stream.terminal,
        "response to end after Provider completion",
      );
      assert.equal(stream.terminal.kind, "eof");
      assert.equal(stream.terminal.httpComplete, true);
      assert.equal(finalView(stream)?.status, "ready");
      await waitFor(() => held.terminal, "Provider HTTP close");
      assert.equal(held.terminal, "finished");
      if (keepAlive) {
        await delay(holdMs);
        activeReport.afterProviderFinished = {
          msFromSigterm: elapsed(at),
          idleMs: elapsed(stream.terminal.at),
          processAlive: active.exit === null,
          socketOpen: stream.socketClosedAt === null,
          responseConnectionHeader: stream.response.headers.connection ?? null,
          keepAliveHeader: stream.response.headers["keep-alive"] ?? null,
        };
        if (
          activeReport.afterProviderFinished.socketOpen &&
          !waitForPeerClose
        ) {
          activeReport.harnessClientCloseMsFromSigterm = elapsed(at);
          stream.disconnect();
        }
      }
    }
    Object.assign(
      activeReport,
      await observeExit(
        active,
        at,
        stream,
        waitForPeerClose ? naturalKeepAliveMs : waitMs,
      ),
    );
    await waitFor(() => held.terminal, "Provider HTTP close");
    activeReport.providerConnection = held.terminal;
    const final = finalView(stream);
    activeReport.finalResult = final ? summary(final) : null;

    const callsBeforeRestart = calls.length;
    const restarted = await startCli(name, active.port);
    const restored = await inspect(restarted, worldId);
    activeReport.afterRestart = restored;
    activeReport.providerCallsOnRestart = calls.length - callsBeforeRestart;
    assert.equal(activeReport.providerCallsOnRestart, 0);
    assert.equal(restored.activeInvocation, false);
    assertCommittedExchange(restored, committedText);
    if (forceStop) {
      assert.equal(activeReport.exit.code, null);
      assert.equal(activeReport.exit.signal, "SIGKILL");
      assert.equal(activeReport.connection.kind, "aborted");
      assert.equal(activeReport.portRebound, true);
      assert.equal(activeReport.finalResult, null);
      assert.equal(held.terminal, "peer_closed");
      assert.equal(restored.head, before.head);
      assert.equal(restored.status, "interrupted");
      assert.equal(restored.canRetry, true);
      assert(
        !restored.events.some(
          (entry) => entry.text === partialText && entry.committedHead,
        ),
      );

      planResponse(retriedText);
      const retried = await rpc(
        restarted,
        play(worldId, "append", "retry", ""),
      );
      const afterRetry = await inspect(restarted, worldId);
      const frozenRequestMatched =
        calls.length === callsBeforeRestart + 1 &&
        calls.at(-1) === calls.at(-2);
      activeReport.afterExplicitRetry = { frozenRequestMatched, ...afterRetry };
      assert(frozenRequestMatched);
      assert.equal(retried.status, "ready");
      assertCommittedExchange(afterRetry, retriedText);
    } else {
      assertGraceful(activeReport);
      assert.equal(activeReport.connection.kind, "eof");
      assert.equal(held.terminal, "finished");
      assert.equal(restored.status, "ready");
      const beforeTurn = Number(before.head.split(":")[1]);
      const restoredTurn = Number(restored.head.split(":")[1]);
      activeReport.commitsAdded = restoredTurn - beforeTurn;
      assert.equal(activeReport.commitsAdded, 1);
      assertCommittedExchange(restored, finishedText);
    }
    assertGraceful(await observeExit(restarted, terminate(restarted)));
  }
}

try {
  const providerPort = await listen(provider);
  await runChecks(providerPort);
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(plans, []);
} catch (error) {
  report.failure = error.message;
  report.providerErrors = providerErrors;
  for (const run of children) {
    if (run.exit === null) {
      process.stderr.write(run.stdout + run.stderr);
      run.child.kill("SIGKILL");
    }
  }
  throw error;
} finally {
  console.log(JSON.stringify(report, null, 2));
  clients.destroy();
  await Promise.all(
    [...children].map((run) => waitFor(() => run.exit, "CLI cleanup")),
  );
  provider.closeAllConnections();
  await closeServer(provider);
  await rm(root, { recursive: true, force: true });
}
