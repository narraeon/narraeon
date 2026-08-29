import { resolve } from "node:path";

import { resolveAppPaths } from "../runtime/config/appPaths.ts";
import {
  parseWebHost,
  parseWebPort,
  startWebServer,
} from "./startWebServer.ts";

const host = parseWebHost(process.env.NARRAEON_HOST);
const port = parseWebPort(process.env.NARRAEON_PORT);
const paths = resolveAppPaths(process.env);
const server = await startWebServer({
  paths,
  staticRoot: resolve("dist/web"),
  host,
  port,
});

installGracefulShutdown(server);

function installGracefulShutdown(server: { close(): Promise<void> }): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
