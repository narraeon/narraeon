import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, release, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

import { applyConversationUpdate } from "../../src/protocol/conversationObservation.ts";
import { preparePage, submitFromPage, viewport } from "./browser.mjs";
import {
  prepareReadingPage,
  readingPageOptions,
  submitReading,
  verifyReading,
} from "./reading-browser.mjs";
import { longResponse, readingArms } from "./reading-fixture.mjs";
import { summarizeReading } from "./reading-summary.mjs";
import { summarize } from "./summary.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    turns: { type: "string", default: "240" },
    repeats: { type: "string" },
    diagnostics: { type: "string" },
    "chunk-ms": { type: "string", default: "20" },
    fixture: { type: "string" },
    "play-reading": { type: "boolean" },
    "expect-markdown": { type: "boolean" },
    headed: { type: "boolean" },
    mobile: { type: "boolean" },
    "provider-port": { type: "string" },
  },
});
assert(values.out, "Pass --out <new directory>");
const out = resolve(values.out);
const playReading = Boolean(values["play-reading"]);
const expectMarkdown = Boolean(values["expect-markdown"]);
const mobile = Boolean(values.mobile);
assert(
  playReading || (!mobile && !expectMarkdown),
  "--mobile and --expect-markdown require --play-reading",
);
const number = (key, fallback) => {
  const value = Number(values[key] ?? fallback);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `Expected positive --${key}`,
  );
  return value;
};
const options = {
  turns: number("turns"),
  repeats: number("repeats", playReading ? 4 : 8),
  diagnostics: number("diagnostics", playReading ? 2 : 4),
  chunkMs: number("chunk-ms"),
};
const saved = values.fixture && resolve(values.fixture);
const providerPort = values["provider-port"] && number("provider-port");
const playerText = "I ask the harbor keeper to read the final entry aloud.";
const chainId = "sse-benchmark-context";
const responseText =
  "The keeper opens the ledger beneath the lamp. She reads the last entry slowly, pausing where the ink has run. The harbor bell sounded twice before dawn. A boat reached the north pier with neither cargo nor passengers. The keeper turns the page towards you. A thin seam of salt runs along the fold, and beneath it there is a date in smaller handwriting. She waits while you copy it, then shuts the ledger and sets the lamp back in its niche.";
const chunks = responseText.match(/.{1,4}/g);
const longChunks = longResponse.match(/[\s\S]{1,48}/g);
const firstWaitMs = 250;
const finishWaitMs = 100;
const protocol = "narraeon.runtime/v1";
const now = () => performance.timeOrigin + performance.now();
const hash = (body) => createHash("sha256").update(body).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const persist = (path, value) => writeFile(join(out, path), json(value));
const providerEvent = (choice) =>
  `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
const providerStop =
  providerEvent({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n";

async function rpc(url, request) {
  const response = await fetch(`${url}/api/runtime/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol, request }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await response.json();
  assert(response.ok && !envelope.error, JSON.stringify(envelope.error));
  return envelope.result;
}

function startWorker(diagnostic) {
  const child = fork(
    fileURLToPath(new URL("./runtime.mjs", import.meta.url)),
    diagnostic ? ["--diagnostic"] : [],
    { env: { ...process.env, NODE_ENV: "production" } },
  );
  const exited = once(child, "exit");
  const ask = async (command, root) => {
    child.send({ command, root });
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(40_000) }),
      exited.then(([code, signal]) => {
        throw new Error(`Runtime worker exited: ${code ?? signal}`);
      }),
    ]);
    if (message.error) throw new Error(message.error);
    return message.value;
  };
  return {
    ask,
    stop: async () => {
      if (child.connected) child.disconnect();
      await exited;
    },
  };
}

let seedIndex = 0;
let providerRuns = null;
let trialChunks;
const provider = createServer(async (request, response) => {
  try {
    const startedAt = now();
    let body = "";
    for await (const part of request) body += part;
    assert.equal(request.url, "/v1/chat/completions");
    const input = JSON.parse(body);
    assert.equal(input.stream, true);
    const receivedAt = now();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    if (providerRuns === null) {
      seedIndex++;
      const seedText =
        `Harbor journal ${seedIndex}. ` +
        "The keeper marks the tide against the old stone steps. Lantern light moves across the waiting boats, and someone in the market is folding canvas against the rain. The shore guard records each visitor who passes the chain. "
          .repeat(5)
          .trim();
      return response.end(
        providerEvent({ delta: { content: seedText } }) + providerStop,
      );
    }
    const trace = {
      startedAt,
      receivedAt,
      requestBytes: Buffer.byteLength(body),
      requestHash: hash(body),
      messages: input.messages.length,
      sends: [],
    };
    providerRuns.push(trace);
    let chars = 0;
    for (const [index, content] of trialChunks.entries()) {
      const dueAt = receivedAt + firstWaitMs + index * options.chunkMs;
      await delay(Math.max(0, dueAt - now()));
      chars += content.length;
      trace.sends.push({ dueAt, at: now(), chars });
      response.write(providerEvent({ delta: { content } }));
    }
    await delay(
      Math.max(
        0,
        receivedAt +
          firstWaitMs +
          (trialChunks.length - 1) * options.chunkMs +
          finishWaitMs -
          now(),
      ),
    );
    trace.endAt = now();
    response.end(providerStop);
  } catch (error) {
    console.error(error);
    response.destroy();
  }
});

async function seed(url, providerUrl) {
  const binding = {
    provider: "chat_completions",
    modelId: "sse-benchmark-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8192,
  };
  await rpc(url, { type: "preferences.save", locale: "en" });
  await rpc(url, {
    type: "model.save",
    connection: {
      ...binding,
      name: "SSE benchmark",
      presetId: "custom",
      baseUrl: providerUrl + "/v1",
      apiKey: "synthetic-benchmark-key",
    },
  });
  const content = await rpc(url, { type: "content.create" });
  const created = await rpc(url, {
    type: "world.create",
    operationId: "sse-benchmark-world",
    packageId: content.localId,
    model: binding,
  });
  const { worldId } = created.world;
  for (let index = 1; index <= options.turns; index++) {
    const view = await rpc(url, {
      type: index === 1 ? "play.chain.start" : "play.chain.append",
      worldId,
      chainId,
      exchangeId: `seed-${index}`,
      playerText: `Harbor journal notes, watch ${index}. I ask who passed the chain and whether the tide is rising.`,
    });
    assert.equal(view.status, "ready", JSON.stringify(view));
  }
  assert.equal(seedIndex, options.turns);
  return worldId;
}

async function openObserver(url, worldId) {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30_000),
  ]);
  try {
    const response = await fetch(
      `${url}/api/runtime/v1/events?kind=play&id=${worldId}`,
      { signal },
    );
    assert(
      response.ok &&
        response.headers.get("content-type")?.includes("text/event-stream"),
    );
    const reader = response.body.getReader();
    let initial = "";
    while (!/event: observation\ndata: .+\n\n/u.test(initial)) {
      const { value, done } = await reader.read();
      assert(!done && value);
      initial += Buffer.from(value).toString();
    }
    let bytes = 0;
    const drain = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        bytes += value.byteLength;
      }
    };
    const drained = drain().catch((error) => {
      if (!controller.signal.aborted) return error;
    });
    return async () => {
      controller.abort();
      const error = await drained;
      if (error) throw error;
      return bytes;
    };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function arrivals(observations, expected = responseText) {
  let state = null;
  const samples = [];
  let chars = 0;
  for (const { at, data } of observations) {
    state = applyConversationUpdate(state, JSON.parse(data).update);
    const pending = state.value?.events.findLast(
      (event) => event.kind === "assistant" && event.status === "streaming",
    );
    if (
      pending?.text &&
      expected.startsWith(pending.text) &&
      pending.text.length > chars
    ) {
      chars = pending.text.length;
      samples.push({ at, chars });
    }
  }
  return samples;
}

async function measure(worker, sample, fixture, worldId, browser, root) {
  let ui;
  const readingPages = [];
  let closeObserver;
  let observedBytes;
  const short = !playReading || sample.arm === "short";
  const expected = short ? responseText : longResponse;
  trialChunks = short ? chunks : longChunks;
  const trial = await mkdtemp(join(root, "trial-"));
  const url = await worker.ask("open", await copyFixture(fixture, trial));
  try {
    const warm = await rpc(url, { type: "play.chain.inspect", worldId });
    assert.equal(warm.status, "ready");
    assert.equal(warm.chainId, chainId);
    if (sample.arm === "wire") closeObserver = await openObserver(url, worldId);
    if (sample.arm === "page")
      ui = await preparePage(browser, url, worldId, playerText);
    if (playReading) {
      readingPages.push(
        await prepareReadingPage(browser, url, worldId, playerText, mobile),
      );
      if (sample.arm === "dual") {
        readingPages.push(
          await prepareReadingPage(browser, url, worldId, undefined, mobile),
        );
      }
    }
    // Let setup requests and the initial observation settle outside the window.
    await delay(150);
    await worker.ask("arm");
    providerRuns = [];
    const clientStartedAt = now();
    const submission = playReading
      ? await submitReading(readingPages, expected, sample.arm)
      : ui
        ? await submitFromPage(ui, expected)
        : {
            result: await rpc(url, {
              type: "play.chain.append",
              worldId,
              chainId,
              exchangeId: "measured-exchange",
              playerText,
            }),
          };
    const clientFinishedAt = now();
    const runtime = await worker.ask("result");
    if (closeObserver) {
      observedBytes = await closeObserver();
      closeObserver = undefined;
      assert(observedBytes > 0);
    }
    assert.equal(runtime.httpStatus, 200);
    assert.equal(
      runtime.subscribers,
      sample.arm === "none" ? 0 : sample.arm === "dual" ? 2 : 1,
    );
    assert.equal(runtime.endSubscribers, runtime.subscribers);
    assert.equal(runtime.requests["play.chain.append"], 1);
    assert.equal(providerRuns.length, 1);
    const [provider] = providerRuns;
    assert.equal(provider.sends.length, trialChunks.length);
    assert.equal(submission.result.status, "ready");
    const final = submission.result.events.findLast(
      (event) => event.kind === "assistant",
    );
    assert.equal(final.status, "completed");
    assert.equal(final.text, expected);
    const history = historyPath(trial, worldId);
    const historyFiles = (await readdir(history)).sort();
    const committedPath = historyFiles
      .filter((name) => name.includes("-narrator-"))
      .at(-1);
    const committed = await readFile(join(history, committedPath), "utf8");
    assert.equal(committed, expected);
    let committedPlayer;
    if (playReading) {
      const playerPath = historyFiles.findLast((name) =>
        name.includes("-player-"),
      );
      const text = await readFile(join(history, playerPath), "utf8");
      assert.equal(text, playerText);
      committedPlayer = { path: playerPath, text, sha256: hash(text) };
      assert.equal(
        historyFiles.filter((name) => name.endsWith(".md")).length,
        2 * options.turns + 3,
      );
      for (const trace of submission.browsers) {
        verifyReading(trace, expected, expectMarkdown, runtime.repliedAt);
        trace.arrivals = arrivals([...trace.setup, ...trace.events], expected);
        assert(trace.arrivals.length > 1);
      }
    }
    if (runtime.frames && !playReading) {
      const sent = [...runtime.setupFrames, ...runtime.frames].flatMap(
        ({ at, text }) =>
          text.includes("\nevent: observation\n")
            ? [{ at, data: text.split("\ndata: ")[1].trimEnd() }]
            : [],
      );
      runtime.arrivals = arrivals(sent);
      if (sample.arm === "none") {
        assert.equal(runtime.snapshotReads.length, 0);
        assert.equal(runtime.frames.length, 0);
      } else assert(runtime.arrivals.length > 0);
    }
    if (submission.browser) {
      const trace = submission.browser;
      assert.equal(trace.finalText, responseText);
      assert.equal(trace.connections, 1);
      assert.deepEqual(trace.faults, []);
      trace.arrivals = arrivals([
        ...trace.setupObservations,
        ...trace.observations,
      ]);
      assert(
        trace.arrivals.length > 1 && trace.rows.length > 1,
        JSON.stringify(trace.rows),
      );
      assert(
        trace.rows.some(({ inViewport }) => inViewport),
        "No pending text reached the viewport",
      );
      assert(
        trace.rows[0].frameAt < runtime.repliedAt,
        "Pending text appeared only after the command",
      );
    }
    return {
      ...sample,
      provider,
      runtime,
      browser: submission.browser,
      browsers: submission.browsers,
      clientStartedAt,
      clientFinishedAt,
      observedBytes,
      committedPlayer,
      final: {
        text: committed,
        bytes: Buffer.byteLength(committed),
        sha256: hash(committed),
        path: committedPath,
        head: final.committedHead,
      },
    };
  } finally {
    await closeObserver?.();
    await ui?.page.close();
    await Promise.all(readingPages.map(({ page }) => page.close()));
    await worker.ask("close");
    await rm(trial, { recursive: true, force: true, maxRetries: 3 });
  }
}

function historyPath(root, worldId) {
  return join(root, "data", "worlds-file-native", worldId, "history");
}
async function copyFixture(source, destination) {
  for (const directory of ["data", "config"])
    await cp(join(source, directory), join(destination, directory), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  return destination;
}

async function size(path) {
  let bytes = 0;
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    bytes += item.isDirectory() ? await size(child) : (await stat(child)).size;
  }
  return bytes;
}

await mkdir(out);
const fixture = saved ?? join(out, "fixture");
const stored =
  saved && JSON.parse(await readFile(join(saved, "fixture.json"), "utf8"));
assert(
  !providerPort || !stored || providerPort === stored.providerPort,
  "Saved fixture is bound to a different Provider port",
);
const root = await mkdtemp(join(tmpdir(), "narraeon-sse-benchmark-"));
const samples = [];
const orders = [
  ["none", "wire", "page"],
  ["wire", "page", "none"],
  ["page", "none", "wire"],
  ["page", "wire", "none"],
  ["none", "page", "wire"],
  ["wire", "none", "page"],
];
let browser;
try {
  provider.listen(stored?.providerPort ?? providerPort ?? 0, "127.0.0.1");
  await once(provider, "listening");
  const port = provider.address().port;
  browser = await chromium.launch({ headless: !values.headed });
  let worldId = stored?.worldId;
  if (!stored) {
    await mkdir(fixture);
    const worker = startWorker(false);
    try {
      worldId = await seed(
        await worker.ask("open", fixture),
        `http://127.0.0.1:${port}`,
      );
      await worker.ask("close");
    } finally {
      await worker.stop();
    }
    await writeFile(
      join(fixture, "fixture.json"),
      json({ worldId, providerPort: port, turns: options.turns }),
    );
  } else options.turns = stored.turns;

  const history = historyPath(fixture, worldId);
  const world = resolve(history, "..");
  const messages = (await readdir(history)).filter((name) =>
    name.endsWith(".md"),
  );
  assert.equal(messages.length, 2 * options.turns + 1);
  const packageVersion = JSON.parse(
    await readFile("package.json", "utf8"),
  ).version;
  const playwrightVersion = JSON.parse(
    await readFile("node_modules/@playwright/test/package.json", "utf8"),
  ).version;
  await persist("environment.json", {
    ...options,
    fixture,
    worldId,
    chainId,
    playerText,
    messages: messages.length,
    authorityTurns: options.turns * 2,
    historyBytes: await size(history),
    worldBytes: await size(world),
    responseText,
    chunks,
    firstWaitMs,
    finishWaitMs,
    packageVersion,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    platform: process.platform,
    kernel: release(),
    arch: arch(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    chromium: browser.version(),
    playwright: playwrightVersion,
    viewport: playReading ? readingPageOptions(mobile).viewport : viewport,
    headed: Boolean(values.headed),
    ...(playReading
      ? {
          benchmark: "play-reading",
          mobile: mobile ? "Playwright Pixel 7 on the host Chromium" : null,
          expectMarkdown,
          providerPort: port,
          longResponse,
          longChunks,
        }
      : {}),
  });

  let requestHash;
  for (const [mode, count] of [
    ["clean", options.repeats],
    ["diagnostic", options.diagnostics],
  ]) {
    const worker = startWorker(mode === "diagnostic");
    try {
      for (let round = -1; round < count; round++) {
        const rotation = round % readingArms.length;
        const order = playReading
          ? round === -1
            ? ["short"]
            : [
                ...readingArms.slice(rotation),
                ...readingArms.slice(0, rotation),
              ]
          : orders[(round + 1) % orders.length];
        for (const [position, arm] of order.entries()) {
          const sample = await measure(
            worker,
            { mode, round, position, arm },
            fixture,
            worldId,
            browser,
            root,
          );
          requestHash ??= sample.provider.requestHash;
          assert.equal(
            sample.provider.requestHash,
            requestHash,
            "Provider requests differ across trials",
          );
          samples.push(sample);
          await appendFile(
            join(out, "samples.jsonl"),
            JSON.stringify(sample) + "\n",
          );
          console.log(
            `${mode} round ${round} ${arm} ${Math.round(sample.runtime.repliedAt - sample.runtime.startedAt)} ms`,
          );
        }
      }
    } finally {
      await worker.stop();
    }
  }
  const summary = playReading ? summarizeReading(samples) : summarize(samples);
  await persist("summary.json", summary);
  console.log(`Evidence written to ${out}`);
} finally {
  await browser?.close();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
