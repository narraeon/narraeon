import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import { resolveAppPaths } from "../runtime/config/appPaths.ts";
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

  const port = parseWebPort(process.env.NARRAEON_PORT);
  const server = await startWebServer({
    paths,
    staticRoot,
    host: "127.0.0.1",
    port,
  });

  const address = server.server.address();
  const listeningPort =
    typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`NARRAEON_READY ${listeningPort}\n`);
} catch (error: unknown) {
  recordCrash("startup", error);
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
