import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "narraeon-package-smoke-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let child;

try {
  const pack = await execute(
    npmCommand,
    ["pack", "--json", "--silent", "--pack-destination", temporaryRoot],
    {
      cwd: repositoryRoot,
      env: { ...process.env, TMPDIR: "/tmp" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const jsonStart = pack.stdout.lastIndexOf("\n[");
  const manifestJson = pack.stdout.slice(jsonStart === -1 ? 0 : jsonStart + 1);
  const [manifest] = JSON.parse(manifestJson);
  assert(
    manifest !== undefined,
    "npm pack did not return an artifact manifest",
  );
  const packagePaths = new Set(manifest.files.map(({ path }) => path));
  for (const required of [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "package.json",
    "dist/node/cli/main.js",
    "dist/web/index.html",
  ])
    assert(packagePaths.has(required), `The package is missing ${required}`);
  const allowedRootPaths = new Set([
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "package.json",
  ]);
  for (const path of packagePaths)
    assert(
      allowedRootPaths.has(path) || /^dist\/(?:node|web)\//u.test(path),
      `The package contains an unexpected path: ${path}`,
    );

  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  const archivePath = join(temporaryRoot, manifest.filename);
  await execute(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
    {
      cwd: consumerRoot,
      env: { ...process.env, TMPDIR: "/tmp" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const installedPackageRoot = join(consumerRoot, "node_modules", "narraeon");
  const installedPackage = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );
  assert(
    installedPackage.bin?.narraeon === "dist/node/cli/main.js",
    "The package does not declare exactly one narraeon bin",
  );
  assert(
    typeof installedPackage.exports === "object" &&
      installedPackage.exports !== null &&
      !Array.isArray(installedPackage.exports) &&
      Object.keys(installedPackage.exports).length === 0,
    "The CLI-only package does not block JavaScript entry points",
  );
  const importGuard = await execute(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `for (const specifier of ${JSON.stringify([
        "narraeon",
        "narraeon/dist/node/protocol/v1.js",
      ])}) {
  try {
    await import(specifier);
    throw new Error(\`Unexpectedly imported \${specifier}\`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
}
process.stdout.write("Package imports are blocked\\n");`,
    ],
    { cwd: consumerRoot },
  );
  assert(
    importGuard.stdout.includes("Package imports are blocked"),
    "The package import guard did not run",
  );
  await stat(join(consumerRoot, "node_modules", ".bin", "narraeon"));
  const installedCli = join(installedPackageRoot, "dist/node/cli/main.js");
  const firstLine = (await readFile(installedCli, "utf8")).split("\n", 1)[0];
  assert(
    firstLine === "#!/usr/bin/env node",
    "The packaged CLI lacks the Node shebang",
  );
  const help = await execute(npmCommand, ["exec", "--", "narraeon", "--help"], {
    cwd: consumerRoot,
    env: { ...process.env, TMPDIR: "/tmp" },
  });
  assert(
    help.stdout.includes("narraeon web"),
    "npm exec could not invoke the narraeon bin",
  );

  const port = await availablePort();
  const environment = {
    ...process.env,
    NARRAEON_CONFIG_ROOT: join(temporaryRoot, "runtime-config"),
    NARRAEON_DATA_ROOT: join(temporaryRoot, "runtime-data"),
    NARRAEON_LOG_ROOT: join(temporaryRoot, "runtime-log"),
    TMPDIR: "/tmp",
  };
  child = spawn(
    process.execPath,
    [installedCli, "web", "--port", String(port), "--no-open"],
    {
      cwd: consumerRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
  await waitForHealth(child, port, () => output);

  const page = await fetch(`http://127.0.0.1:${String(port)}/`);
  assert(page.ok, `The packaged home page returned ${String(page.status)}`);
  assert(
    (await page.text()).includes('<div id="root"></div>'),
    "The package did not serve the Vite page",
  );

  const reused = await execute(
    process.execPath,
    [installedCli, "web", "--port", String(port), "--no-open"],
    { cwd: consumerRoot, env: environment },
  );
  assert(
    reused.stdout.includes("Narraeon is already running"),
    "The second invocation did not reuse the service",
  );
  process.stdout.write(
    `Package smoke test passed: ${manifest.filename} · ${String(manifest.entryCount)} files · ${String(manifest.size)} bytes\n`,
  );
} finally {
  await stopChild(child);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a package-test port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else rejectPort(error);
      });
    });
  });
}

async function waitForHealth(process_, port, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process_.exitCode !== null)
      throw new Error(`The packaged CLI exited before startup: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) {
        const payload = await response.json();
        assert(
          payload.protocol === "narraeon.runtime/v1",
          "The packaged health protocol does not match",
        );
        return;
      }
    } catch {
      // The packaged Runtime is still starting.
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for the packaged CLI to start: ${output()}`,
  );
}

async function stopChild(process_) {
  if (process_ === undefined || process_.exitCode !== null) return;
  const exited = once(process_, "exit");
  process_.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (process_.exitCode === null) {
    process_.kill("SIGKILL");
    await exited;
  }
}
