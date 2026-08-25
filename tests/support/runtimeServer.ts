import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class RuntimeServerPool {
  readonly #children = new Set<ChildProcess>();

  async start(root: string, port: number): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/server/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NARRAEON_CONFIG_ROOT: join(root, "config"),
          NARRAEON_DATA_ROOT: join(root, "data"),
          NARRAEON_LOG_ROOT: join(root, "log"),
          NARRAEON_PORT: String(port),
          NODE_ENV: "test",
          TMPDIR: "/tmp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#children.add(child);
    child.once("exit", () => this.#children.delete(child));
    let output = "";
    child.stdout?.on(
      "data",
      (chunk: Buffer) => (output += chunk.toString("utf8")),
    );
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (output += chunk.toString("utf8")),
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Runtime 启动前退出：${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return child;
      } catch {
        // Runtime is still starting.
      }
      await delay(50);
    }
    await this.stop(child);
    throw new Error(`等待 Runtime 启动超时：${output}`);
  }

  async stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#children.delete(child);
      return;
    }
    const exited = once(child, "exit").then(() => undefined);
    child.kill("SIGTERM");
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    this.#children.delete(child);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#children].map((child) => this.stop(child)));
  }
}

export function availableRuntimePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("无法分配 E2E Runtime 端口"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else rejectPort(error);
      });
    });
  });
}
