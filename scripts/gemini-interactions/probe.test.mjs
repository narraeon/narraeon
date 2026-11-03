// Tests the research CLI with a synthetic local fetch double, never a real API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const key = "synthetic-test-key-not-a-credential";
async function run(extra = {}) {
  const temp = await mkdtemp(join(tmpdir(), "narraeon-probe-test-"));
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      join(directory, "synthetic-provider.mjs"),
      join(directory, "probe.mjs"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: temp,
        GEMINI_API_KEY: key,
        GOOGLE_API_KEY: "",
        ...extra,
      },
    },
  );
  return { temp, child };
}
async function archive(temp) {
  const names = await readdir(temp);
  assert.equal(names.length, 1);
  return join(temp, names[0]);
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("replays complete synthetic steps and keeps evidence out of output", async () => {
  const { temp, child } = await run();
  try {
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!child.stdout.includes(key) && !child.stderr.includes(key));
    const dir = await archive(temp);
    const first = await readJson(join(dir, "01-tool-call-response.json"));
    const second = await readJson(join(dir, "02-tool-result-request.json"));
    assert.deepEqual(second.input.slice(1, 3), first.steps);
    assert.deepEqual(second.input[1].summary, []);
    assert.deepEqual(second.input[1].future_field, {
      nested: [1, "unknown", { keep: true }],
    });
    assert.equal(second.input[3].call_id, "test-call");
    const third = await readJson(join(dir, "03-next-turn-request.json"));
    assert.deepEqual(third.input.slice(0, 4), second.input);
    const boot = await readJson(join(dir, "04-runtime-bootstrap-request.json"));
    assert.equal(boot.input[0].type, "function_call");
    assert.equal(boot.input[1].type, "function_result");
    assert.equal(boot.input[0].signature, undefined);
    const ordered = await readJson(join(dir, "05-prompt-order-request.json"));
    assert.deepEqual(
      ordered.input.map((step) => step.type),
      ["user_input", "model_output", "user_input", "user_input"],
    );
    for (const name of await readdir(dir))
      assert.ok(!(await readFile(join(dir, name), "utf8")).includes(key));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("stops before replay when an unknown number would lose precision", async () => {
  const { temp, child } = await run({ SYNTHETIC_UNSAFE_NUMBER: "1" });
  try {
    assert.equal(child.status, 1);
    assert.match(child.stderr, /non-roundtrippable number/);
    const names = await readdir(await archive(temp));
    assert.ok(!names.some((name) => name.startsWith("02-")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("refuses a temporary directory inside the worktree", async () => {
  const temp = await mkdtemp(join(directory, ".probe-test-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        join(directory, "synthetic-provider.mjs"),
        join(directory, "probe.mjs"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: temp, GEMINI_API_KEY: key },
      },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /inside the worktree/);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
