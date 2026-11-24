import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { grepHistory } from "./HistoryGrep.ts";
import { v1Protocol } from "../protocol/v1.ts";
import { parseTrustedWebOrigins } from "../server/WebAccess.ts";
import {
  fingerprintDataRoot,
  resolveAppPaths,
} from "../runtime/config/appPaths.ts";
import {
  parseWebHost,
  parseWebPort,
  startWebServer,
  type StartWebServerInput,
  type WebHost,
} from "../server/startWebServer.ts";

export interface StoppableServer {
  close: () => Promise<void>;
}

export type LocalWebInspection =
  "available" | "occupied" | { dataRootFingerprint: string | null };

export type NarraeonCliResult =
  | { kind: "help" }
  | { kind: "history-grep"; exitCode: 0 | 1 | 2 }
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
  host: WebHost;
  port: number;
  trustedOrigins: string[];
  openBrowser: boolean;
}

interface HistoryGrepCommand {
  kind: "history-grep";
  worldId: string;
  query: string;
}

export class NarraeonCliUsageError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

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
  if (command.kind === "history-grep") {
    const { dataRoot } = resolveAppPaths(input.environment);
    const exitCode = await grepHistory(
      dataRoot,
      command.worldId,
      command.query,
      output,
      errorOutput,
    );
    return { kind: "history-grep", exitCode };
  }

  const url = `http://127.0.0.1:${command.port}`;
  const inspect = input.inspectServer ?? inspectLocalWebServer;
  const inspection = await inspect(url);
  if (inspection === "occupied")
    throw new Error(`Port ${String(command.port)} is already in use`);

  const paths = resolveAppPaths(input.environment);
  if (inspection !== "available") {
    if (inspection.dataRootFingerprint === null)
      throw new Error(
        `Narraeon on port ${command.port} did not report a data directory fingerprint. Upgrade the running instance or choose another port with --port.`,
      );
    const requestedFingerprint = await fingerprintDataRoot(
      paths.dataRoot,
    ).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR"))
        return undefined;
      throw error;
    });
    if (requestedFingerprint !== inspection.dataRootFingerprint)
      throw new Error(
        `Narraeon is already running on port ${command.port} with a different data directory. Choose another port with --port.`,
      );
    output(`Narraeon is already running: ${url}\n`);
    await openBrowser(command, url, input.openUrl, errorOutput);
    return { kind: "reused", url };
  }

  const start = input.startServer ?? startWebServer;
  let server: StoppableServer;
  try {
    server = await start({
      paths,
      staticRoot: input.staticRoot,
      host: command.host,
      port: command.port,
      ...(command.trustedOrigins.length === 0
        ? {}
        : { trustedOrigins: command.trustedOrigins }),
    });
  } catch (error: unknown) {
    if (hasErrorCode(error, "EADDRINUSE"))
      throw new Error(`Port ${String(command.port)} is already in use`, {
        cause: error,
      });
    throw error;
  }
  output(`Narraeon started: ${url}\n`);
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
  if (!response.ok || !isNarraeonHealth(payload)) return "occupied";
  const fingerprint = payload.dataRootFingerprint;
  return {
    dataRootFingerprint:
      typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)
        ? fingerprint
        : null,
  };
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
): WebCommand | HistoryGrepCommand | null {
  const parsed = parseRawArguments(args);
  if (parsed.values.help === true || parsed.positionals.length === 0)
    return null;
  if (parsed.positionals[0] === "history") {
    const [, subcommand, worldId, query, ...extra] = parsed.positionals;
    if (
      subcommand !== "grep" ||
      worldId === undefined ||
      query === undefined ||
      extra.length !== 0 ||
      parsed.values.port !== undefined ||
      parsed.values.open !== undefined
    )
      throw new NarraeonCliUsageError(
        "Expected narraeon history grep <worldId> <query>",
        2,
      );
    return { kind: "history-grep", worldId, query };
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "web")
    throw new NarraeonCliUsageError(
      `Unknown command: ${parsed.positionals.join(" ") || "(empty)"}`,
    );
  let port: number;
  let host: WebHost;
  let trustedOrigins: string[];
  try {
    host = parseWebHost(environment.NARRAEON_HOST);
    trustedOrigins = parseTrustedWebOrigins(
      environment.NARRAEON_TRUSTED_ORIGINS,
    );
    port = parseWebPort(
      parsed.values.port ?? environment.NARRAEON_PORT,
      parsed.values.port === undefined ? "NARRAEON_PORT" : "--port",
    );
  } catch (error: unknown) {
    throw new NarraeonCliUsageError(errorMessage(error));
  }
  return {
    kind: "web",
    host,
    port,
    trustedOrigins,
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
    throw new NarraeonCliUsageError(
      errorMessage(error),
      args[0] === "history" ? 2 : 1,
    );
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
      `Could not open a browser automatically. Open ${url} manually: ${errorMessage(error)}\n`,
    );
  }
}

function isNarraeonHealth(value: unknown): value is {
  status: "ok";
  protocol: typeof v1Protocol;
  dataRootFingerprint?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok" &&
    "protocol" in value &&
    value.protocol === v1Protocol
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

export const cliHelp = `Narraeon

Usage:
  narraeon web [--port <port>] [--no-open]
  narraeon history grep <worldId> <query>

Options:
  -p, --port <port>  Local web port (default: 4317)
      --no-open      Do not open a browser after startup
  -h, --help         Show help
`;
