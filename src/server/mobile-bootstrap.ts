import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";

// Android owns this pipe and keeps the read fd open until node::Start returns.
// The launcher closes the write end before startup, so the read ends at EOF.
function readStartupEnvironment(): Record<string, string> {
  const fd = Number(process.argv[2]);
  if (!Number.isSafeInteger(fd) || fd < 3)
    throw new Error("Missing Android startup configuration descriptor");

  try {
    const config: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (config === null || typeof config !== "object" || Array.isArray(config))
      throw new Error();
    const environment: [string, string][] = [];
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string") throw new Error();
      environment.push([key, value]);
    }
    return Object.fromEntries(environment);
  } catch {
    // A JSON parse error can include part of the payload, which holds credentials.
    throw new Error("Could not read Android startup configuration");
  }
}

try {
  // A Worker with its own env keeps app paths (including os.tmpdir()) and the
  // startup key out of the Android process environment shared with native code.
  const entry = new URL(
    `./mobile${extname(import.meta.filename)}`,
    import.meta.url,
  );
  const worker = new Worker(entry, {
    env: { ...process.env, ...readStartupEnvironment() },
  });
  worker.on("error", (error) => {
    console.error("Android backend worker failed", error);
    process.exitCode = 1;
  });
  worker.on("exit", (code) => {
    if (code !== 0) process.exitCode = code;
  });
} catch (error: unknown) {
  console.error("Android backend bootstrap failed", error);
  process.exitCode = 1;
}
