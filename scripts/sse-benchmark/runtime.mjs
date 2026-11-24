import assert from "node:assert/strict";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { availableRuntimePort } from "../../tests/support/runtimeServer.ts";

const diagnostic = process.argv.includes("--diagnostic");
const now = () => performance.timeOrigin + performance.now();
const tailMs = 150;
let sample;
let finished;
let server;
const activeStreams = new Set();
let setupFrames;

// Enable only in the separate diagnostic worker. Keep the production module's
// exact arguments, return values, scheduling, and wire frames.
if (diagnostic) {
  const stream = new URL(
    "../../src/server/ConversationStream.ts",
    import.meta.url,
  );
  const protocol = new URL(
    "../../src/protocol/conversationObservation.ts",
    import.meta.url,
  );
  const patches = new Map([
    [
      stream.href,
      [
        [
          "JSON.stringify(previous)",
          'probe.stringify("state_before", previous)',
        ],
        ["JSON.stringify(next)", 'probe.stringify("state_after", next)'],
        [
          "JSON.stringify({ protocol: v1Protocol, update })",
          'probe.stringify("wire_frame", { protocol: v1Protocol, update })',
        ],
        [
          "const update = conversationUpdate(previous, next);",
          "const update = probe.buildUpdate(() => conversationUpdate(previous, next));",
        ],
        [
          "stream.write(text);",
          "probe.frame(text);\n      stream.write(text);",
        ],
      ],
    ],
    [
      protocol.href,
      [
        [
          "JSON.stringify(candidate)",
          'probe.stringify("delta_candidate", candidate)',
        ],
        [
          "JSON.stringify(next.value)",
          'probe.stringify("delta_expected", next.value)',
        ],
      ],
    ],
  ]);
  globalThis.__narraeonSseBenchmark = {
    stringify(site, value) {
      if (!sample?.measuring) return JSON.stringify(value);
      const start = performance.now();
      const result = JSON.stringify(value);
      sample.serialization.push({ site, ms: performance.now() - start });
      return result;
    },
    buildUpdate(build) {
      if (!sample?.measuring) return build();
      const start = performance.now();
      const result = build();
      sample.updateMs.push(performance.now() - start);
      return result;
    },
    frame(text) {
      if (sample?.measuring) sample.frames.push({ at: now(), text });
      else if (!sample?.closed && setupFrames !== undefined)
        setupFrames.push({ at: now(), text });
    },
  };
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const replacements = patches.get(url);
      if (!replacements) return loaded;
      let source = String(loaded.source);
      for (const [original, replacement] of replacements) {
        assert.equal(
          source.split(original).length,
          2,
          `Probe site changed in ${url}: ${original}`,
        );
        source = source.replace(original, replacement);
      }
      return {
        ...loaded,
        source: `const probe = (globalThis as any).__narraeonSseBenchmark;\n${source}`,
      };
    },
  });
}

const { createRuntime } = await import("../../src/server/createRuntime.ts");
const { createServer } = await import("../../src/server/createServer.ts");
const { FileNativeWorldStore } =
  await import("../../src/runtime/world/FileNativeWorldStore.ts");

function timeRead(receiver, method, key) {
  const original = receiver[method];
  receiver[method] = async function (...args) {
    const current = sample?.measuring ? sample : undefined;
    if (!current) return original.apply(this, args);
    const at = now();
    try {
      return await original.apply(this, args);
    } finally {
      current[key].push({
        at,
        ms: now() - at,
        reusedPrevious: args[1] !== undefined,
      });
    }
  };
}
if (diagnostic)
  timeRead(
    FileNativeWorldStore.prototype,
    "extensionControlsRevision",
    "extensionReads",
  );

async function open(root) {
  setupFrames = diagnostic ? [] : undefined;
  const runtime = await createRuntime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
    logRoot: join(root, "log"),
  });
  if (diagnostic) timeRead(runtime, "readConversation", "snapshotReads");

  const port = await availableRuntimePort();
  server = await createServer({
    runtime,
    port,
    staticRoot: resolve("dist/web"),
    logger: false,
  });

  server.addHook("onRequest", (request, reply, done) => {
    if (request.url.startsWith("/api/runtime/v1/events?")) {
      activeStreams.add(reply.raw);
      reply.raw.once("close", () => activeStreams.delete(reply.raw));
    }
    done();
  });
  server.addHook("preHandler", (request, _reply, done) => {
    if (!sample || sample.closed) return done();
    const type = request.body?.request?.type;
    if (type === "play.chain.append" && sample.startedAt === undefined) {
      sample.startedAt = now();
      sample.startCpu = process.cpuUsage();
      sample.subscribers = activeStreams.size;
      sample.requestId = request.id;
      sample.measuring = true;
    }
    if (sample.measuring && type)
      sample.requests[type] = (sample.requests[type] ?? 0) + 1;
    done();
  });
  server.addHook("onResponse", (request, reply, done) => {
    if (sample?.requestId !== request.id) return done();
    const current = sample;
    current.repliedAt = now();
    current.replyCpu = process.cpuUsage(current.startCpu);
    current.httpStatus = reply.statusCode;
    void delay(tailMs).then(() => {
      current.tailCpu = process.cpuUsage(current.startCpu);
      current.tailAt = now();
      current.endSubscribers = activeStreams.size;
      current.measuring = false;
      current.closed = true;
      finished(current);
    });
    done();
  });
  return server.listen({ host: "127.0.0.1", port });
}

let result;
process.on("message", async ({ command, root }) => {
  try {
    let value;
    switch (command) {
      case "open":
        assert(!server);
        value = await open(root);
        break;
      case "close": {
        // Fastify can finish closing before Node delivers the last SSE
        // response's close event. Wait for both before starting the next trial.
        const closed = [...activeStreams].map((stream) =>
          once(stream, "close"),
        );
        await Promise.all([server.close(), ...closed]);
        server = undefined;
        sample = undefined;
        assert.equal(activeStreams.size, 0);
        break;
      }
      case "arm":
        assert(server && !sample);
        sample = {
          requests: {},
          ...(diagnostic
            ? {
                setupFrames,
                snapshotReads: [],
                extensionReads: [],
                serialization: [],
                updateMs: [],
                frames: [],
              }
            : {}),
        };
        result = new Promise((resolveResult) => {
          finished = resolveResult;
        });
        break;
      case "result":
        value = await result;
        break;
      default:
        throw new Error(`Unknown worker command: ${command}`);
    }
    process.send({ value });
  } catch (error) {
    process.send({ error: error.stack });
  }
});
