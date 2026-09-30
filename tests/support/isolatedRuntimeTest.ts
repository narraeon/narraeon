import { test as base } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableRuntimePort, RuntimeServerPool } from "./runtimeServer.ts";

export const test = base.extend<
  Record<never, never>,
  { runtimeScope: string; runtimeUrl: string }
>({
  // Distinct scopes give each suite its own worker, server and persistent state.
  runtimeScope: ["default", { scope: "worker", option: true }],
  runtimeUrl: [
    async ({ runtimeScope }, use) => {
      const root = await mkdtemp(join(tmpdir(), `narraeon-${runtimeScope}-`));
      const servers = new RuntimeServerPool();
      try {
        const port = await availableRuntimePort();
        await servers.start(root, port);
        await use(`http://127.0.0.1:${port}`);
      } finally {
        await servers.stopAll();
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ runtimeUrl }, use) => use(runtimeUrl),
});
