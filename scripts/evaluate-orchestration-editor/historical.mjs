import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAppPaths } from "../../src/runtime/config/appPaths.ts";
import {
  RuntimeServerPool,
  availableRuntimePort,
} from "../../tests/support/runtimeServer.ts";

const [destination, model] = process.argv.slice(2);
if (!destination || !model)
  throw new Error(
    "Usage: node scripts/evaluate-orchestration-editor/run.mjs NEW_OUTPUT_DIRECTORY MODEL_ID",
  );
const output = resolve(destination);
const questionFile = await readFile(
  new URL("./questions.json", import.meta.url),
);
const rubric = await readFile(new URL("./rubric.md", import.meta.url));
const questions = JSON.parse(questionFile);
const protocols = ["openai_responses", "chat_completions"];
const config = resolveAppPaths(process.env).configRoot;
const library = JSON.parse(
  await readFile(join(config, "model-connections-v1.json"), "utf8"),
);
const profiles = protocols.map((protocol) => {
  const profile = library.connections.find(
    (entry) => entry.modelId === model && entry.provider === protocol,
  );
  if (!profile)
    throw new Error(
      "Missing configured connection: " + model + " / " + protocol,
    );
  return profile;
});
await mkdir(output, { mode: 0o700 });
const save = (name, value) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
await save("design.json", {
  model,
  protocols,
  questionHash: digest(questionFile),
  rubricHash: digest(rubric),
});

async function evaluate(profile) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-orchestration-eval-"));
  const pool = new RuntimeServerPool();
  try {
    await mkdir(join(root, "config"), { mode: 0o700 });
    await writeFile(
      join(root, "config", "model-connections-v1.json"),
      JSON.stringify({
        schemaVersion: library.schemaVersion,
        activeConnectionId: profile.id,
        connections: [profile],
      }),
      { mode: 0o600 },
    );
    const port = await availableRuntimePort();
    await pool.start(root, port);
    async function request(payload) {
      const response = await fetch(
        "http://127.0.0.1:" + port + "/api/runtime/v1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: "narraeon.runtime/v1",
            request: payload,
          }),
          signal: AbortSignal.timeout(300_000),
        },
      );
      const envelope = await response.json();
      if (!response.ok)
        throw new Error(
          [payload.type, response.status, envelope.error?.code].join(" "),
        );
      return envelope.result;
    }
    await request({ type: "preferences.save", locale: "zh-CN" });
    const presets = await request({ type: "play.read" });
    const presetId = presets.currentPresetId;
    const base = presets.presets.find((preset) => preset.id === presetId);
    const rows = [];
    for (const [index, question] of questions.entries()) {
      if (index === 5) {
        for (let instance = 0; instance < 2; instance++) {
          const { localId } = await request({ type: "content.create" });
          await request({
            type: "world.create",
            operationId: randomUUID(),
            packageId: localId,
          });
        }
      }
      let view = await request({
        type: "orchestration.message",
        presetId,
        requestId: randomUUID(),
        expectedRevision: base.revision,
        surface: "playPrompts",
        message: question.text,
        continuation: { kind: "fresh_context" },
      });
      const deadline = Date.now() + 300_000;
      while (view.runStatus === "running" && Date.now() < deadline) {
        await delay(1000);
        view = await request({
          type: "orchestration.session.read",
          presetId,
          sessionId: view.sessionId,
        });
      }
      const exchanges = view.turns.flatMap((turn) => turn.exchanges);
      const row = {
        id: question.id,
        protocol: profile.provider,
        model,
        instances: index >= 5,
        runStatus: view.runStatus,
        text: exchanges.at(-1)?.text ?? "",
        usage: view.usage,
        changes: view.changes.length,
        dispatches: exchanges.map((exchange) => ({
          usage: exchange.usage,
          tools: exchange.toolCalls.map((call) => call.name),
        })),
      };
      rows.push(row);
      await save("raw-" + profile.provider + ".json", rows);
      console.log(profile.provider, question.id, row.runStatus);
      assert.equal(row.runStatus, "ready");
      assert.equal(row.changes, 0);
      assert.equal(view.revision, base.revision);
      assert(row.text.trim().length > 0);
    }
    return rows;
  } finally {
    await pool.stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

const results = await Promise.allSettled(profiles.map(evaluate));
for (const result of results)
  if (result.status === "rejected") throw result.reason;
const blind = [];
const mapping = [];
for (const [index, question] of questions.entries()) {
  const pair = results.map((result) => result.value[index]);
  if (randomInt(2)) pair.reverse();
  for (const row of pair) {
    const label = randomUUID().slice(0, 12);
    blind.push({
      label,
      questionId: question.id,
      question: question.text,
      answer: row.text,
    });
    mapping.push({ label, id: question.id, protocol: row.protocol, model });
  }
}
await save("seal.json", mapping);
await save("blind.json", blind);
