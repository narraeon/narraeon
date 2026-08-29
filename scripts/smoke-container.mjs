import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const image = requiredArgument("--image");
const runId = `${String(process.pid)}-${Date.now().toString(36)}`;
const volume = `narraeon-smoke-volume-${runId}`;
const containers = [
  `narraeon-smoke-first-${runId}`,
  `narraeon-smoke-second-${runId}`,
];
let volumeCreated = false;

try {
  const configuredUser = (
    await docker(["image", "inspect", "--format", "{{.Config.User}}", image])
  ).stdout.trim();
  assert(
    configuredUser !== "" &&
      configuredUser !== "0" &&
      configuredUser !== "root",
    `The image must declare a non-root user, received ${configuredUser || "(empty)"}`,
  );

  await docker(["volume", "create", volume]);
  volumeCreated = true;

  const firstPort = await startContainer(containers[0]);
  await verifyHttpSurface(firstPort);
  const uid = (
    await docker([
      "exec",
      containers[0],
      "node",
      "--eval",
      "process.stdout.write(String(process.getuid?.() ?? 'unsupported'))",
    ])
  ).stdout.trim();
  assert(
    uid !== "0" && uid !== "unsupported",
    `Unexpected runtime UID: ${uid}`,
  );

  await docker([
    "exec",
    containers[0],
    "node",
    "--input-type=module",
    "--eval",
    "import { writeFile } from 'node:fs/promises'; await writeFile(`${process.env.NARRAEON_DATA_ROOT}/.container-smoke`, 'persisted', 'utf8');",
  ]);
  await removeContainer(containers[0]);

  const secondPort = await startContainer(containers[1]);
  await verifyHttpSurface(secondPort);
  const marker = (
    await docker([
      "exec",
      containers[1],
      "node",
      "--input-type=module",
      "--eval",
      "import { readFile } from 'node:fs/promises'; process.stdout.write(await readFile(`${process.env.NARRAEON_DATA_ROOT}/.container-smoke`, 'utf8'));",
    ])
  ).stdout;
  assert(marker === "persisted", "The named volume did not survive recreation");

  process.stdout.write(
    `Container smoke test passed: ${image} · UID ${uid} · persistent volume\n`,
  );
} finally {
  for (const container of containers)
    await dockerAllowFailure(["rm", "--force", container]);
  if (volumeCreated)
    await dockerAllowFailure(["volume", "rm", "--force", volume]);
}

async function startContainer(name) {
  const port = await availablePort();
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--mount",
    `source=${volume},target=/var/lib/narraeon`,
    "--env",
    `NARRAEON_PORT=${String(port)}`,
    "--publish",
    `127.0.0.1:${String(port)}:${String(port)}`,
    image,
  ]);
  await waitForHealth(name, port);
  return port;
}

async function verifyHttpSurface(port) {
  const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
  assert(
    health.ok,
    `The container health endpoint returned ${String(health.status)}`,
  );
  assert(
    (await health.json()).protocol === "narraeon.runtime/v1",
    "The container health protocol does not match",
  );

  const page = await fetch(`http://127.0.0.1:${String(port)}/`);
  assert(page.ok, `The container home page returned ${String(page.status)}`);
  assert(
    (await page.text()).includes('<div id="root"></div>'),
    "The container did not serve the production web application",
  );

  const runtime = await fetch(
    `http://127.0.0.1:${String(port)}/api/runtime/v1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${String(port)}`,
      },
      body: JSON.stringify({
        protocol: "narraeon.runtime/v1",
        request: { type: "workspace.read" },
      }),
    },
  );
  assert(
    runtime.ok,
    `The container Runtime endpoint returned ${String(runtime.status)}`,
  );
  assert(
    (await runtime.json()).protocol === "narraeon.runtime/v1",
    "The container Runtime protocol does not match",
  );
}

async function waitForHealth(container, port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    const state = await dockerAllowFailure([
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ]);
    if (state.stdout.trim() === "false") break;
    await delay(100);
  }
  const logs = await dockerAllowFailure(["logs", container]);
  throw new Error(
    `Container did not become healthy:\n${logs.stdout}${logs.stderr}`,
  );
}

async function removeContainer(container) {
  await docker(["stop", container]);
  await docker(["rm", container]);
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a container-test port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else rejectPort(error);
      });
    });
  });
}

function docker(args) {
  return execute(dockerCommand, args, { maxBuffer: 10 * 1024 * 1024 });
}

async function dockerAllowFailure(args) {
  try {
    return await docker(args);
  } catch (error) {
    return {
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
    };
  }
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--"))
    throw new Error(`Missing required argument ${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
