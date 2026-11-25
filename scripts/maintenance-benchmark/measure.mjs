import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  arch,
  cpus,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { measureFaults } from "./faults.mjs";
import { measureImports } from "./imports.mjs";
import { measureRevisions } from "./revision.mjs";
import { measureSessions } from "./session.mjs";

const {
  positionals: [evidencePath],
  values,
} = parseArgs({
  allowPositionals: true,
  options: {
    repeats: { type: "string", default: "5" },
    suite: { type: "string", default: "all" },
  },
});
const usage =
  "Usage: node scripts/maintenance-benchmark/measure.mjs <new-evidence-directory> [--repeats 5] [--suite all|faults|revision|session|import]";
assert(evidencePath, usage);
const repeats = Number(values.repeats);
assert(Number.isSafeInteger(repeats) && repeats > 0, usage);
assert(
  ["all", "faults", "revision", "session", "import"].includes(values.suite),
  usage,
);

const evidence = resolve(evidencePath);
await mkdir(evidence, { mode: 0o700 });
const work = await mkdtemp(join(tmpdir(), "narraeon-343-"));
const save = (name, value) =>
  writeFile(
    join(evidence, name + ".json"),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
try {
  await save("environment", {
    utcTime: new Date().toISOString(),
    revision: git("rev-parse", "HEAD"),
    status: git("status", "--short"),
    cpu: cpus()[0]?.model,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    platform: platform(),
    release: release(),
    osVersion:
      platform() === "darwin"
        ? execFileSync("sw_vers", ["-productVersion"], {
            encoding: "utf8",
          }).trim()
        : null,
    loadAverage: loadavg(),
    architecture: arch(),
    node: process.version,
    workFilesystem: execFileSync("df", ["-h", work], {
      encoding: "utf8",
    }).trim(),
    repeats,
  });
  if (["all", "faults"].includes(values.suite))
    await save(
      "faults",
      await measureFaults(join(work, "faults"), evidence, repeats),
    );
  if (["all", "revision"].includes(values.suite))
    await save(
      "revisions",
      await measureRevisions(join(work, "revision"), repeats),
    );
  if (["all", "session"].includes(values.suite))
    await save(
      "sessions",
      await measureSessions(join(work, "session"), repeats),
    );
  if (["all", "import"].includes(values.suite))
    await save("imports", await measureImports(work, repeats));
} finally {
  await rm(work, { recursive: true, force: true });
}
