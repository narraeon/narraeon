import { resolve } from "node:path";

import { resolveAppPaths } from "../runtime/config/appPaths.ts";
import { createRuntime } from "./createRuntime.ts";
import { createServer } from "./createServer.ts";

const port = parsePort(process.env.NARRAEON_PORT);
const paths = resolveAppPaths(process.env);
const runtime = await createRuntime(paths);
const server = await createServer({
  runtime,
  staticRoot: resolve("dist"),
  port,
});

await server.listen({ host: "127.0.0.1", port });

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 4317;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`NARRAEON_PORT 不是有效端口：${value}`);
  }
  return parsed;
}
