import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [root] = process.argv.slice(2);
assert(
  root,
  "Usage: node scripts/maintenance-benchmark/count-rejections.mjs <synthetic #161 live evaluation directory>",
);
const readJson = async (name) => JSON.parse(await readFile(join(root, name)));
const manifest = await readJson("manifest.json");
assert.equal(manifest.previewOnly, false);
assert.equal(manifest.plan.sourceCommit, "015a2ed");
assert.equal(manifest.cases.length, 27);
const summary = await readJson("summary.json");
assert.deepEqual(
  summary.map(({ id }) => id),
  manifest.cases.map(({ id }) => id),
);

const cases = [];
for (const entry of summary) {
  assert.match(entry.id, /^[a-z0-9-]+$/u);
  const input = await readFile(join(root, entry.id + ".json"));
  assert.equal(createHash("sha256").update(input).digest("hex"), entry.sha256);
  const { id, status, turns } = JSON.parse(input);
  assert.equal(id, entry.id);
  assert.equal(status, entry.status);
  cases.push({
    id,
    status,
    turns: turns.map(({ events, requests, status }) => {
      const results = events.filter(({ kind }) => kind === "tool_result");
      for (const { ok } of results) assert.equal(typeof ok, "boolean");
      return {
        status,
        providerRequests: requests.length,
        toolResults: results.length,
        replayedResults: results.filter(({ replayed }) => replayed).length,
        rejectedTools: results.filter(({ ok }) => !ok).map(({ name }) => name),
      };
    }),
  });
}

const turns = cases.flatMap((item) => item.turns);
const withRejection = (turn) => turn.rejectedTools.length > 0;
const frequencies = {
  finishedScenarios: cases.filter(({ status }) => status === "complete").length,
  scenarios: cases.length,
  scenariosWithRejection: cases.filter((item) => item.turns.some(withRejection))
    .length,
  readyTurns: turns.filter(({ status }) => status === "ready").length,
  turns: turns.length,
  turnsWithToolResult: turns.filter(({ toolResults }) => toolResults > 0)
    .length,
  turnsWithRejection: turns.filter(withRejection).length,
  providerRequests: turns.reduce(
    (count, turn) => count + turn.providerRequests,
    0,
  ),
  toolResults: turns.reduce((count, turn) => count + turn.toolResults, 0),
  replayedResults: turns.reduce(
    (count, turn) => count + turn.replayedResults,
    0,
  ),
  rejectedResults: turns.reduce(
    (count, turn) => count + turn.rejectedTools.length,
    0,
  ),
};
console.log(
  JSON.stringify(
    {
      source: "#161 synthetic real-model runs",
      sourceCommit: manifest.plan.sourceCommit,
      model: manifest.plan.historicalConnection.modelId,
      frequencies,
      cases,
    },
    null,
    2,
  ),
);
