import type { FastifyInstance } from "fastify";

import type { AppPaths } from "../runtime/config/appPaths.ts";
import { acquireDataRootLock } from "../runtime/config/dataRootLock.ts";
import { createRuntime } from "./createRuntime.ts";
import { createServer } from "./createServer.ts";

export const defaultWebPort = 4317;
export const defaultWebHost = "127.0.0.1";
export const containerWebHost = "0.0.0.0";

export type WebHost = typeof defaultWebHost | typeof containerWebHost;

export interface StartWebServerInput {
  paths: AppPaths;
  staticRoot: string;
  host: WebHost;
  port: number;
  logger?: boolean;
}

export async function startWebServer(
  input: StartWebServerInput,
): Promise<FastifyInstance> {
  const lock = await acquireDataRootLock(input.paths.dataRoot);
  let server: FastifyInstance | undefined;
  try {
    const runtime = await createRuntime(input.paths);
    server = await createServer({
      runtime,
      staticRoot: input.staticRoot,
      port: input.port,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    server.addHook("onClose", () => lock.release());
    await server.listen({ host: input.host, port: input.port });
    return server;
  } catch (error: unknown) {
    if (server !== undefined) await server.close().catch(() => undefined);
    else await lock.release();
    throw error;
  }
}

export function parseWebHost(
  value: string | undefined,
  source = "NARRAEON_HOST",
): WebHost {
  if (value === undefined) return defaultWebHost;
  if (value === defaultWebHost || value === containerWebHost) return value;
  throw new Error(
    `${source} must be ${defaultWebHost} or ${containerWebHost}: ${value}`,
  );
}

export function parseWebPort(
  value: string | undefined,
  source = "NARRAEON_PORT",
): number {
  if (value === undefined) return defaultWebPort;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error(`${source} is not a valid port: ${value}`);
  return parsed;
}
