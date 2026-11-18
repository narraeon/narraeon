import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const registry = "--registry=https://registry.npmjs.org/";
const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const severities = ["info", "low", "moderate", "high", "critical"];

function runNpm(args, stdio) {
  const npm = process.env.npm_execpath;
  const result = spawnSync(
    npm ? process.execPath : "npm",
    npm ? [npm, ...args] : args,
    {
      stdio,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.signal || result.status === null)
    throw new Error("npm audit did not finish");
  return result;
}

/** An npm audit exit of 1 may mean a finding or a failed audit. Only a complete v2 report can distinguish them. */
export function verifyAudit(report, status, devPackages) {
  assert.equal(report.auditReportVersion, 2, "Missing npm audit v2 report");
  assert(!Object.hasOwn(report, "error"), "npm audit returned an error");
  const vulnerabilities = report.vulnerabilities;
  assert(
    vulnerabilities &&
      typeof vulnerabilities === "object" &&
      !Array.isArray(vulnerabilities),
  );
  const entries = Object.entries(vulnerabilities);
  const totals = report.metadata?.vulnerabilities;
  assert.equal(totals?.total, entries.length, "Incomplete npm audit report");
  for (const severity of severities)
    assert.equal(
      totals[severity],
      entries.filter(([, item]) => item.severity === severity).length,
      "Audit severity counts disagree",
    );
  assert.equal(
    status,
    totals.high + totals.critical > 0 ? 1 : 0,
    "Unexpected npm audit exit",
  );
  assert.equal(totals.critical, 0, "Critical vulnerability in npm audit");

  const explained = new Set();
  const high = entries.filter(([, item]) => item.severity === "high");
  for (const [name, item] of entries) {
    assert.equal(item.name, name);
    assert(severities.includes(item.severity), "Unknown npm audit severity");
    assert(
      Array.isArray(item.via) && item.via.length,
      "Missing advisory evidence",
    );
    if (item.severity === "high") {
      assert(
        devPackages &&
          item.nodes?.length &&
          item.nodes.every((node) => devPackages[node]?.dev === true),
        `High vulnerability in production or unknown dependency: ${name}`,
      );
    }
    for (const cause of item.via) {
      if (typeof cause === "string") {
        assert(
          Object.hasOwn(vulnerabilities, cause),
          `Missing advisory dependency: ${cause}`,
        );
        continue;
      }
      assert(
        cause &&
          severities.includes(cause.severity) &&
          typeof cause.url === "string",
        "Invalid advisory",
      );
      if (cause.severity !== "high" && cause.severity !== "critical") continue;
      assert(
        devPackages &&
          item.severity === "high" &&
          cause.severity === "high" &&
          name === "picomatch" &&
          cause.name === name &&
          cause.dependency === name &&
          cause.url === advisory,
        `Unapproved advisory: ${cause.url}`,
      );
      explained.add(name);
    }
  }
  // Propagate only from the verified advisory. A cycle with no explained cause cannot grant an exception.
  let previousSize;
  do {
    previousSize = explained.size;
    for (const [name, item] of high) {
      if (
        item.via.some(
          (cause) => typeof cause === "string" && explained.has(cause),
        )
      )
        explained.add(name);
    }
  } while (explained.size !== previousSize);
  for (const [name] of high)
    assert(explained.has(name), `Unexplained high vulnerability: ${name}`);
  return high.length;
}

function readAudit(scope, devPackages) {
  const { stdout, stderr, status } = runNpm(
    ["audit", scope, "--audit-level=high", "--json", registry],
    "pipe",
  );
  if (stderr) process.stderr.write(stderr);
  const count = verifyAudit(JSON.parse(stdout), status, devPackages);
  console.log(
    `${scope}: audit passed${count ? ` with ${count} development findings traced to ${advisory}` : ""}.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (manifest.version === "0.8.9") {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(lock.packages[""].version, manifest.version);
    readAudit("--omit=dev");
    readAudit("--include=dev", lock.packages);
  } else {
    process.exitCode = runNpm(
      ["audit", "--audit-level=high", registry],
      "inherit",
    ).status;
  }
}
