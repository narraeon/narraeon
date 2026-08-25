import type { FastifyInstance } from "fastify";

import type { AppPaths } from "../runtime/config/appPaths.ts";
import { createRuntime } from "./createRuntime.ts";
import { createServer } from "./createServer.ts";

export const defaultWebPort = 4317;

export interface StartWebServerInput {
  paths: AppPaths;
  staticRoot: string;
  port: number;
  logger?: boolean;
}

export async function startWebServer(
  input: StartWebServerInput,
): Promise<FastifyInstance> {
  const runtime = await createRuntime(input.paths);
  const server = await createServer({
    runtime,
    staticRoot: input.staticRoot,
    port: input.port,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  try {
    await server.listen({ host: "127.0.0.1", port: input.port });
    return server;
  } catch (error: unknown) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

export function parseWebPort(
  value: string | undefined,
  source = "NARRAEON_PORT",
): number {
  if (value === undefined) return defaultWebPort;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error(`${source} 不是有效端口：${value}`);
  return parsed;
}
