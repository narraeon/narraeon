import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    turns: { type: "string", multiple: true },
    workload: { type: "string", multiple: true },
    repeats: { type: "string", default: "5" },
    "timeout-ms": { type: "string", default: "30000" },
    "fixture-timeout-ms": { type: "string", default: "90000" },
  },
});
function integer(value, minimum, label) {
  const number = Number(value);
  assert(
    Number.isSafeInteger(number) && number >= minimum,
    `Expected ${label} >= ${minimum}`,
  );
  return number;
}
const rounds = [
  ...new Set(
    (values.turns ?? ["500", "2000"]).map((value) =>
      integer(value, 41, "--turns"),
    ),
  ),
];
const workloads = [...new Set(values.workload ?? ["narrative", "state"])];
assert(
  workloads.every((value) => ["narrative", "state"].includes(value)),
  "Expected --workload narrative or state",
);
const repeats = integer(values.repeats, 1, "--repeats");
const timeoutMs = integer(values["timeout-ms"], 1, "--timeout-ms");
const fixtureTimeoutMs = integer(
  values["fixture-timeout-ms"],
  1,
  "--fixture-timeout-ms",
);
const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const exec = promisify(execFile);

async function ask(command, timeout, args) {
  try {
    const { stdout } = await exec(
      process.execPath,
      [worker, command, ...args.map(String)],
      { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 2 ** 20 },
    );
    return { status: "ok", ...JSON.parse(stdout) };
  } catch (error) {
    if (error.killed && error.signal === "SIGKILL")
      return { status: "timeout", timeoutMs: timeout };
    throw error;
  }
}

const roundMs = (number) => Number(number.toFixed(3));
function summarize(samples) {
  if (!samples.length) return null;
  const times = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const median =
    times.length % 2 === 0 ? (times[mid - 1] + times[mid]) / 2 : times[mid];
  const reads = samples[0].reads;
  return {
    samples: times.length,
    medianMs: roundMs(median),
    minMs: roundMs(times[0]),
    maxMs: roundMs(times[times.length - 1]),
    reads: Object.fromEntries(
      Object.keys(reads ?? {}).map((key) => [
        key,
        [...new Set(samples.map((sample) => sample.reads[key]))],
      ]),
    ),
  };
}

const root = await mkdtemp(join(tmpdir(), "narraeon-world-open-"));
try {
  const results = [];
  for (const count of rounds) {
    for (const workload of workloads) {
      const dataRoot = join(root, `${count}-${workload}`);
      process.stderr.write(`Preparing ${count} turns (${workload})\n`);
      const fixture = await ask("seed", fixtureTimeoutMs, [
        dataRoot,
        count,
        workload,
      ]);
      if (fixture.status !== "ok") {
        process.stderr.write(`Fixture timed out at ${fixtureTimeoutMs} ms\n`);
        results.push({ rounds: count, workload, fixture });
        continue;
      }
      process.stderr.write(
        `Verified ${fixture.ledgerRecords} ledger records and two pages in ${roundMs(fixture.seedMs)} ms\n`,
      );
      const open = [];
      const maintenance = [];
      const args = [dataRoot, fixture.worldId, fixture.head, count, workload];
      for (let trial = 1; trial <= repeats; trial++) {
        for (const [phase, samples] of [
          ["open", open],
          ["maintenance", maintenance],
        ]) {
          const sample = await ask(phase, timeoutMs, args);
          samples.push(sample);
          if (sample.status === "timeout")
            process.stderr.write(
              `${count} ${workload} ${phase} trial ${trial} timed out at ${timeoutMs} ms\n`,
            );
        }
      }
      const openSuccesses = open.filter(({ status }) => status === "ok");
      const maintenanceSuccesses = maintenance.filter(
        ({ status }) => status === "ok",
      );
      results.push({
        rounds: count,
        workload,
        fixture,
        summary: {
          initialize: summarize(
            openSuccesses.map(({ initializeMs }) => ({ ms: initializeMs })),
          ),
          coldOpen: summarize(openSuccesses.map(({ cold }) => cold)),
          warmOpen: summarize(openSuccesses.map(({ warm }) => warm)),
          olderPage: summarize(openSuccesses.map(({ older }) => older)),
          maintenanceRebuild: summarize(
            maintenanceSuccesses.map(({ rebuild }) => rebuild),
          ),
          maintenanceCached: summarize(
            maintenanceSuccesses.map(({ cached }) => cached),
          ),
          openTimeouts: repeats - openSuccesses.length,
          maintenanceTimeouts: repeats - maintenanceSuccesses.length,
        },
        raw: { open, maintenance },
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          checkout: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repo,
            encoding: "utf8",
          }).trim(),
          node: process.version,
          os: `${platform()} ${release()}`,
          arch: arch(),
          cpu: cpus()[0]?.model,
          ramBytes: totalmem(),
          tempFilesystemType: (await statfs(root)).type,
        },
        options: { repeats, timeoutMs, fixtureTimeoutMs, limit: 40 },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
