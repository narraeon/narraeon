import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyAudit } from "./audit-release.mjs";

const url = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

function fixture() {
  const vulnerabilities = {};
  const packages = {};
  for (const [name, via] of [
    [
      "picomatch",
      [{ name: "picomatch", dependency: "picomatch", severity: "high", url }],
    ],
    ["build-tool", ["picomatch"]],
    ["runner", ["build-tool"]],
  ]) {
    const node = `node_modules/${name}`;
    vulnerabilities[name] = { name, via, severity: "high", nodes: [node] };
    packages[node] = { dev: true };
  }
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 3,
          critical: 0,
          total: 3,
        },
      },
    },
    packages,
  };
}

test("accepts the one development advisory and indirect findings tracing back to it", () => {
  const { report, packages } = fixture();
  assert.equal(verifyAudit(report, 1, packages), 3);
  assert.throws(() => verifyAudit(report, 1));
  packages["node_modules/runner"].dev = false;
  assert.throws(() => verifyAudit(report, 1, packages));
});

test("fails closed for incomplete reports and npm errors", () => {
  const { report, packages } = fixture();
  assert.throws(() => verifyAudit(report, 0, packages));
  assert.throws(() =>
    verifyAudit({ ...report, error: { code: "EAI_AGAIN" } }, 1, packages),
  );
  assert.throws(() => verifyAudit({}, 1, packages));
  assert.throws(() => verifyAudit({ ...report, metadata: {} }, 1, packages));
});

test("another high advisory or a critical escalation blocks the release", () => {
  const { report, packages } = fixture();
  const via = report.vulnerabilities.picomatch.via;
  via.push({ ...via[0], url: "https://github.com/advisories/GHSA-other" });
  assert.throws(() => verifyAudit(report, 1, packages));
  via.pop();
  via[0].severity = "critical";
  assert.throws(() => verifyAudit(report, 1, packages));
});

test("unrelated, missing and cyclic advisory evidence cannot receive the exception", () => {
  const { report, packages } = fixture();
  report.vulnerabilities["build-tool"].via = ["runner"];
  assert.throws(() => verifyAudit(report, 1, packages));
  report.vulnerabilities["build-tool"].via = ["missing"];
  assert.throws(() => verifyAudit(report, 1, packages));
  report.vulnerabilities["build-tool"].via = [
    { severity: "moderate", url: "https://example.com/moderate" },
  ];
  assert.throws(() => verifyAudit(report, 1, packages));
});

test("other versions run the standard audit and preserve its failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "release-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.8.10" }),
  );
  const stub = join(dir, "npm.mjs");
  writeFileSync(
    stub,
    "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 1;",
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./audit-release.mjs", import.meta.url))],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: stub },
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), [
    "audit",
    "--audit-level=high",
    "--registry=https://registry.npmjs.org/",
  ]);
});
