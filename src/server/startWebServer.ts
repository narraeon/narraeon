import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import type { GenerationActivity } from "../runtime/GenerationActivity.ts";
import {
  fingerprintDataRoot,
  type AppPaths,
} from "../runtime/config/appPaths.ts";
import { ChatGptAuth } from "../runtime/model/ChatGptAuth.ts";
import { prepareDataRoot } from "../runtime/config/dataRootCleanup.ts";
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
  trustedOrigins?: readonly string[];
  mobileStartupKey?: Buffer;
  logger?: boolean;
}

export async function startWebServer(
  input: StartWebServerInput,
  generationActivity?: GenerationActivity,
): Promise<FastifyInstance> {
  await prepareDataRoot(input.paths.dataRoot);
  const dataRootFingerprint = await fingerprintDataRoot(input.paths.dataRoot);
  const localChatGpt =
    input.host === defaultWebHost &&
    (input.trustedOrigins?.length ?? 0) === 0 &&
    input.mobileStartupKey === undefined;
  const chatGptAuth = localChatGpt
    ? new ChatGptAuth({
        workspaceDirectory: join(
          input.paths.configRoot,
          "chatgpt",
          dataRootFingerprint,
        ),
        localEnabled: true,
      })
    : undefined;
  let server: FastifyInstance | undefined;
  try {
    const runtime = await createRuntime(
      {
        ...input.paths,
        ...(chatGptAuth === undefined ? {} : { chatGptAuth }),
      },
      generationActivity,
    );
    server = await createServer({
      runtime,
      dataRootFingerprint,
      staticRoot: input.staticRoot,
      port: input.port,
      ...(input.trustedOrigins === undefined
        ? {}
        : { trustedOrigins: input.trustedOrigins }),
      ...(input.mobileStartupKey === undefined
        ? {}
        : { mobileStartupKey: input.mobileStartupKey }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    server.addHook("onClose", (_server, done) => {
      chatGptAuth?.close();
      done();
    });
    await server.listen({ host: input.host, port: input.port });
    return server;
  } catch (error: unknown) {
    if (server !== undefined) await server.close().catch(() => undefined);
    else chatGptAuth?.close();
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
