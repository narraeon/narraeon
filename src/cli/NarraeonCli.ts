import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveAppPaths } from "../runtime/config/appPaths.ts";
import {
  parseWebPort,
  startWebServer,
  type StartWebServerInput,
} from "../server/startWebServer.ts";

export interface StoppableServer {
  close: () => Promise<void>;
}

export type LocalWebInspection = "available" | "narraeon" | "occupied";

export type NarraeonCliResult =
  | { kind: "help" }
  | { kind: "reused"; url: string }
  | { kind: "started"; url: string; server: StoppableServer };

export interface NarraeonCliInput {
  args: string[];
  environment: NodeJS.ProcessEnv;
  staticRoot: string;
  openUrl: (url: string) => Promise<void>;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
  inspectServer?: (url: string) => Promise<LocalWebInspection>;
  startServer?: (input: StartWebServerInput) => Promise<StoppableServer>;
}

interface WebCommand {
  kind: "web";
  port: number;
  openBrowser: boolean;
}

export class NarraeonCliUsageError extends Error {}

export async function runNarraeonCli(
  input: NarraeonCliInput,
): Promise<NarraeonCliResult> {
  const output =
    input.writeOutput ?? ((message) => process.stdout.write(message));
  const errorOutput =
    input.writeError ?? ((message) => process.stderr.write(message));
  const command = parseCliCommand(input.args, input.environment);
  if (command === null) {
    output(cliHelp);
    return { kind: "help" };
  }

  const url = `http://127.0.0.1:${command.port}`;
  const inspect = input.inspectServer ?? inspectLocalWebServer;
  const inspection = await inspect(url);
  if (inspection === "narraeon") {
    output(`Narraeon 已在运行：${url}\n`);
    await openBrowser(command, url, input.openUrl, errorOutput);
    return { kind: "reused", url };
  }
  if (inspection === "occupied")
    throw new Error(`端口 ${String(command.port)} 已被其他服务占用`);

  const start = input.startServer ?? startWebServer;
  let server: StoppableServer;
  try {
    server = await start({
      paths: resolveAppPaths(input.environment),
      staticRoot: input.staticRoot,
      port: command.port,
    });
  } catch (error: unknown) {
    if (hasErrorCode(error, "EADDRINUSE"))
      throw new Error(`端口 ${String(command.port)} 已被其他服务占用`, {
        cause: error,
      });
    throw error;
  }
  output(`Narraeon 已启动：${url}\n`);
  await openBrowser(command, url, input.openUrl, errorOutput);
  return { kind: "started", url, server };
}

export function resolvePackagedWebRoot(moduleUrl: string): string {
  return fileURLToPath(new URL("../../web/", moduleUrl));
}

export async function inspectLocalWebServer(
  url: string,
): Promise<LocalWebInspection> {
  let response: Response;
  try {
    response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(750),
    });
  } catch {
    return (await acceptsTcpConnections(url)) ? "occupied" : "available";
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return "occupied";
  }
  return response.ok && isNarraeonHealth(payload) ? "narraeon" : "occupied";
}

function acceptsTcpConnections(url: string): Promise<boolean> {
  const target = new URL(url);
  return new Promise((resolveInspection) => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    let settled = false;
    const settle = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveInspection(occupied);
    };
    socket.setTimeout(750);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      settle(error.code !== "ECONNREFUSED"),
    );
  });
}

function parseCliCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
): WebCommand | null {
  const parsed = parseRawArguments(args);
  if (parsed.values.help === true || parsed.positionals.length === 0)
    return null;
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "web")
    throw new NarraeonCliUsageError(
      `未知命令：${parsed.positionals.join(" ") || "（空）"}`,
    );
  let port: number;
  try {
    port = parseWebPort(
      parsed.values.port ?? environment.NARRAEON_PORT,
      parsed.values.port === undefined ? "NARRAEON_PORT" : "--port",
    );
  } catch (error: unknown) {
    throw new NarraeonCliUsageError(errorMessage(error));
  }
  return {
    kind: "web",
    port,
    openBrowser: parsed.values.open !== false,
  };
}

function parseRawArguments(args: string[]) {
  try {
    return parseArgs({
      args,
      allowNegative: true,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        open: { type: "boolean" },
        port: { type: "string", short: "p" },
      },
    });
  } catch (error: unknown) {
    throw new NarraeonCliUsageError(errorMessage(error));
  }
}

async function openBrowser(
  command: WebCommand,
  url: string,
  openUrl: (url: string) => Promise<void>,
  writeError: (message: string) => void,
): Promise<void> {
  if (!command.openBrowser) return;
  try {
    await openUrl(url);
  } catch (error: unknown) {
    writeError(
      `无法自动打开浏览器，请手动访问 ${url}：${errorMessage(error)}\n`,
    );
  }
}

function isNarraeonHealth(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok" &&
    "protocol" in value &&
    value.protocol === "narraeon.runtime/v1"
  );
}

function hasErrorCode(value: unknown, code: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("code" in value && value.code === code) return true;
  return "cause" in value && hasErrorCode(value.cause, code);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export const cliHelp = `Narraeon（叙典）

用法：
  narraeon web [--port <端口>] [--no-open]

选项：
  -p, --port <端口>  本地 Web 端口，默认 4317
      --no-open       启动后不自动打开浏览器
  -h, --help          显示帮助
`;
