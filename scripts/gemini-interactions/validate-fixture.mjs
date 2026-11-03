// Checks the test data only; does not validate a provider or production codec.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(
  await readFile(new URL("./synthetic-steps.json", import.meta.url), "utf8"),
);
assert.match(fixture.provenance, /synthetic/i);
const [thought, call] = fixture.steps;
assert.equal(thought.type, "thought");
assert.deepEqual(thought.summary, []);
assert.equal(thought.signature, "SYNTHETIC-NOT-A-VALID-SIGNATURE");
assert.deepEqual(thought.future_field, {
  nested: [1, "unknown", { keep: true }],
});
assert.equal(call.type, "function_call");
assert.equal(call.arguments.ref, "@scene");
const replay = JSON.parse(
  JSON.stringify([{ type: "user_input", content: [] }, ...fixture.steps]),
);
assert.deepEqual(replay.slice(1), fixture.steps);
console.log("Synthetic fixture valid; no provider behavior was tested.");
