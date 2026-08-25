import { createServer as createHttpServer } from "node:http";
import {
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { resolve } from "node:path";

import { expect, test } from "vitest";

import {
  cliHelp,
  inspectLocalWebServer,
  NarraeonCliUsageError,
  resolvePackagedWebRoot,
  runNarraeonCli,
  type LocalWebInspection,
  type NarraeonCliInput,
  type StoppableServer,
} from "../../src/cli/NarraeonCli.ts";
import type { StartWebServerInput } from "../../src/server/startWebServer.ts";

const fakeServer: StoppableServer = {
  close: () => Promise.resolve(),
};

test("CLI 没有命令或显式请求帮助时只显示用法", async () => {
  for (const args of [[], ["--help"], ["web", "--help"]]) {
    const capture = createCapture();
    const result = await runNarraeonCli(
      cliInput({ args, capture, inspection: "available" }),
    );

    expect(result).toEqual({ kind: "help" });
    expect(capture.output).toBe(cliHelp);
  }
});

test("web 子命令使用显式端口和数据根，并允许禁止打开浏览器", async () => {
  const capture = createCapture();
  let startInput: StartWebServerInput | undefined;
  let opened = false;
  const result = await runNarraeonCli({
    ...cliInput({
      args: ["web", "--port", "45678", "--no-open"],
      capture,
      inspection: "available",
    }),
    environment: {
      NARRAEON_CONFIG_ROOT: "/tmp/narraeon-cli-config",
      NARRAEON_DATA_ROOT: "/tmp/narraeon-cli-data",
      NARRAEON_LOG_ROOT: "/tmp/narraeon-cli-log",
    },
    openUrl: () => {
      opened = true;
      return Promise.resolve();
    },
    startServer: (input) => {
      startInput = input;
      return Promise.resolve(fakeServer);
    },
  });

  expect(result).toEqual({
    kind: "started",
    url: "http://127.0.0.1:45678",
    server: fakeServer,
  });
  expect(startInput).toEqual({
    paths: {
      configRoot: "/tmp/narraeon-cli-config",
      dataRoot: "/tmp/narraeon-cli-data",
      logRoot: "/tmp/narraeon-cli-log",
    },
    staticRoot: "/package/dist/web",
    port: 45678,
  });
  expect(opened).toBe(false);
  expect(capture.output).toBe("Narraeon 已启动：http://127.0.0.1:45678\n");
});

test("CLI 等待服务启动后才打开页面", async () => {
  const events: string[] = [];
  const result = await runNarraeonCli({
    ...cliInput({
      args: ["web"],
      capture: createCapture(),
      inspection: "available",
    }),
    startServer: () => {
      events.push("started");
      return Promise.resolve(fakeServer);
    },
    openUrl: (url) => {
      events.push(`opened:${url}`);
      return Promise.resolve();
    },
  });

  expect(result.kind).toBe("started");
  expect(events).toEqual(["started", "opened:http://127.0.0.1:4317"]);
});

test("目标端口已有 Narraeon 时复用服务而不创建第二个 Runtime", async () => {
  const events: string[] = [];
  const result = await runNarraeonCli({
    ...cliInput({
      args: ["web"],
      capture: createCapture(),
      inspection: "narraeon",
    }),
    startServer: () => {
      throw new Error("不应启动 Runtime");
    },
    openUrl: (url) => {
      events.push(url);
      return Promise.resolve();
    },
  });

  expect(result).toEqual({
    kind: "reused",
    url: "http://127.0.0.1:4317",
  });
  expect(events).toEqual(["http://127.0.0.1:4317"]);
});

test("非 Narraeon 端口占用在初始化 Runtime 前失败", async () => {
  let started = false;
  await expect(
    runNarraeonCli({
      ...cliInput({
        args: ["web"],
        capture: createCapture(),
        inspection: "occupied",
      }),
      startServer: () => {
        started = true;
        return Promise.resolve(fakeServer);
      },
    }),
  ).rejects.toThrow("端口 4317 已被其他服务占用");
  expect(started).toBe(false);
});

test("监听竞争产生 EADDRINUSE 时返回同一条可理解错误", async () => {
  await expect(
    runNarraeonCli({
      ...cliInput({
        args: ["web"],
        capture: createCapture(),
        inspection: "available",
      }),
      startServer: () =>
        Promise.reject(
          Object.assign(new Error("listen failed"), {
            code: "EADDRINUSE",
          }),
        ),
    }),
  ).rejects.toThrow("端口 4317 已被其他服务占用");
});

test("浏览器打开失败不会关闭已经启动的服务", async () => {
  const capture = createCapture();
  const result = await runNarraeonCli({
    ...cliInput({
      args: ["web"],
      capture,
      inspection: "available",
    }),
    startServer: () => Promise.resolve(fakeServer),
    openUrl: () => Promise.reject(new Error("没有图形会话")),
  });

  expect(result.kind).toBe("started");
  expect(capture.error).toContain("请手动访问 http://127.0.0.1:4317");
  expect(capture.error).toContain("没有图形会话");
});

test("非法端口和未知命令是用法错误", async () => {
  for (const args of [["web", "--port", "0"], ["serve"], ["web", "extra"]]) {
    await expect(
      runNarraeonCli(
        cliInput({ args, capture: createCapture(), inspection: "available" }),
      ),
    ).rejects.toBeInstanceOf(NarraeonCliUsageError);
  }
});

test("发布版 CLI 从模块位置解析 Web 产物，不依赖当前目录", () => {
  expect(
    resolve(
      resolvePackagedWebRoot(
        new URL("file:///opt/narraeon/dist/node/cli/main.js").href,
      ),
    ),
  ).toBe(resolve("/opt/narraeon/dist/web"));
});

test("本地服务探测只把匹配协议的健康端点视为 Narraeon", async () => {
  const compatible = createHttpServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ status: "ok", protocol: "narraeon.runtime/v1" }));
  });
  const compatiblePort = await listen(compatible);
  try {
    await expect(
      inspectLocalWebServer(`http://127.0.0.1:${String(compatiblePort)}`),
    ).resolves.toBe("narraeon");
  } finally {
    await close(compatible);
  }

  const other = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" }).end("other");
  });
  const otherPort = await listen(other);
  try {
    await expect(
      inspectLocalWebServer(`http://127.0.0.1:${String(otherPort)}`),
    ).resolves.toBe("occupied");
  } finally {
    await close(other);
  }
});

test("健康端点无响应但 TCP 端口被占用时不会初始化第二个 Runtime", async () => {
  const sockets = new Set<Socket>();
  const hanging = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(hanging);
  try {
    await expect(
      inspectLocalWebServer(`http://127.0.0.1:${String(port)}`),
    ).resolves.toBe("occupied");
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(hanging);
  }
});

function cliInput(input: {
  args: string[];
  capture: ReturnType<typeof createCapture>;
  inspection: LocalWebInspection;
}): NarraeonCliInput {
  return {
    args: input.args,
    environment: {},
    staticRoot: "/package/dist/web",
    openUrl: () => Promise.resolve(),
    writeOutput: input.capture.writeOutput,
    writeError: input.capture.writeError,
    inspectServer: () => Promise.resolve(input.inspection),
    startServer: () => Promise.resolve(fakeServer),
  };
}

function createCapture() {
  const result = {
    output: "",
    error: "",
    writeOutput: (message: string) => {
      result.output += message;
    },
    writeError: (message: string) => {
      result.error += message;
    },
  };
  return result;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("测试服务没有 TCP 地址"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}
