#!/usr/bin/env node

import open from "open";

import {
  cliHelp,
  NarraeonCliUsageError,
  resolvePackagedWebRoot,
  runNarraeonCli,
  type StoppableServer,
} from "./NarraeonCli.ts";

try {
  const result = await runNarraeonCli({
    args: process.argv.slice(2),
    environment: process.env,
    staticRoot: resolvePackagedWebRoot(import.meta.url),
    openUrl: async (url) => {
      await open(url);
    },
  });
  if (result.kind === "started") installGracefulShutdown(result.server);
} catch (error: unknown) {
  process.stderr.write(`Narraeon 启动失败：${errorMessage(error)}\n`);
  if (error instanceof NarraeonCliUsageError)
    process.stderr.write(`\n${cliHelp}`);
  process.exitCode = 1;
}

function installGracefulShutdown(server: StoppableServer): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => {
      process.stderr.write(`Narraeon 停止失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
