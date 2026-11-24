import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { inspect } from "node:util";
import { workerData } from "node:worker_threads";

import { resolveAppPaths } from "../runtime/config/appPaths.ts";
import { GenerationActivity } from "../runtime/GenerationActivity.ts";
import { parseWebPort, startWebServer } from "./startWebServer.ts";

// Mobile entry: started inside the Android app's Node runtime. The native shell
// owns the process lifecycle, so this module never registers signal handlers and
// never calls process.exit(); a startup failure is logged and the native side
// reports it.
const paths = resolveAppPaths(process.env);
const crashLogPath = join(paths.logRoot, "crash", "node-errors.log");

// Node shares the Android app process: an uncaught error would make Node call
// exit() and close the whole app. Record the error and keep serving instead; each
// Runtime write is atomic, so a failed request does not leave a half-written file.
process.on("uncaughtException", (error, origin) => {
  recordCrash(origin, error);
});
process.on("unhandledRejection", (reason) => {
  recordCrash("unhandledRejection", reason);
});
process.on("exit", (code) => {
  recordCrash("exit", `process exiting with code ${code}`);
});

try {
  const staticRoot = process.env.NARRAEON_STATIC_ROOT?.trim();
  if (!staticRoot)
    throw new Error("NARRAEON_STATIC_ROOT is required for the mobile entry");

  const startupKey = process.env.NARRAEON_MOBILE_STARTUP_KEY;
  delete process.env.NARRAEON_MOBILE_STARTUP_KEY;
  if (startupKey === undefined || !/^[a-f0-9]{64}$/.test(startupKey))
    throw new Error(
      "The Android launcher must provide a valid mobile startup key",
    );

  const requestedPort = process.env.NARRAEON_PORT;
  const port = requestedPort === "0" ? 0 : parseWebPort(requestedPort);
  const readinessFd: unknown = workerData;
  if (typeof readinessFd !== "number")
    throw new Error("Missing Android startup readiness descriptor");
  const generationSocket = process.env.NARRAEON_GENERATION_SOCKET;
  delete process.env.NARRAEON_GENERATION_SOCKET;
  const server = await startWebServer(
    {
      paths,
      staticRoot,
      host: "127.0.0.1",
      port,
      mobileStartupKey: Buffer.from(startupKey, "hex"),
    },
    generationSocket === undefined
      ? undefined
      : connectGenerationActivity(generationSocket),
  );

  try {
    const address = server.server.address();
    if (address === null || typeof address === "string" || address.port === 0)
      throw new Error("The mobile Runtime has no listening TCP port");

    // Kotlin owns the descriptor. Send the port as one unsigned big-endian short.
    const handoff = Buffer.alloc(2);
    handoff.writeUInt16BE(address.port);
    if (writeSync(readinessFd, handoff) !== handoff.length)
      throw new Error("Could not report the listening port to Android");
    process.stdout.write(`NARRAEON_READY ${address.port}\n`);
  } catch (error: unknown) {
    await server.close().catch(() => undefined);
    throw error;
  }
} catch (error: unknown) {
  recordCrash("startup", error);
  process.exitCode = 1;
}

function connectGenerationActivity(name: string): GenerationActivity {
  // A leading NUL selects the same abstract socket namespace as LocalServerSocket.
  const socket = createConnection({ path: `\0${name}` });
  socket.on("error", (error) => recordCrash("generation wake lock", error));
  socket.unref();
  return new GenerationActivity((active) => {
    if (!socket.destroyed) socket.write(active ? "1" : "0");
  });
}

function recordCrash(kind: string, value: unknown): void {
  const text = `${new Date().toISOString()} [${kind}] ${
    typeof value === "string" ? value : inspect(value, { depth: 4 })
  }\n`;
  process.stderr.write(text);
  try {
    mkdirSync(join(paths.logRoot, "crash"), { recursive: true, mode: 0o700 });
    appendFileSync(crashLogPath, text, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The stderr copy above still reaches logcat and the native stderr log.
  }
}
