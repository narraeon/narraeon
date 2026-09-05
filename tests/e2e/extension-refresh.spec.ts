import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Request } from "../../src/protocol/v1.ts";
import { defaultPlayPresetFiles } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

test("后置内容同端点刷新，观察重连和冷重启恢复且不追加模型请求", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "narraeon-extension-browser-"));
  const pending: ServerResponse[] = [];
  let requests = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      if (requests === 1) send(response, { content: "Alex opens the door." });
      else pending.push(response);
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("No Provider port");
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const reserved = reservation.address();
  if (reserved === null || typeof reserved === "string")
    throw new Error("No Runtime port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const url = `http://127.0.0.1:${reserved.port}`;
  let child: ChildProcess | undefined;
  let serverLog = "";
  const start = async () => {
    child = spawn(process.execPath, ["dist/node/server/main.js"], {
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        NARRAEON_PORT: String(reserved.port),
        NARRAEON_DATA_ROOT: join(root, "data"),
        NARRAEON_CONFIG_ROOT: join(root, "config"),
        NARRAEON_LOG_ROOT: join(root, "logs"),
        NARRAEON_HOST: "127.0.0.1",
      },
      stdio: "pipe",
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    await expect
      .poll(async () => {
        if (child?.exitCode !== null) throw new Error(serverLog);
        return fetch(`${url}/health`).then(
          (response) => response.ok,
          () => false,
        );
      })
      .toBe(true);
  };
  const stop = async () => {
    if (child?.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  try {
    await start();
    await page.goto(url);
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Deferred panels",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "panels",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const preset = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: "Deferred panels",
      files: presetFiles(),
    });
    await runtime(page, { type: "play.select", presetId: preset.preset.id });
    const content = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.rename",
      packageId: content.localId,
      name: "Panel world",
    });
    await runtime(page, {
      type: "content.replace",
      packageId: content.localId,
      files: contentFiles(),
    });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: "panel-world",
      packageId: content.localId,
      model: {
        provider: "chat_completions",
        modelId: "panels",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const worldId = created.world.worldId;
    const head = async () =>
      (await runtime<{ head: string }>(page, { type: "world.read", worldId }))
        .head;
    const open = async () => {
      await page.goto(url);
      await page
        .getByRole("button", { name: "打开世界：Panel world", exact: true })
        .click();
    };
    await open();
    await page.getByLabel("你的行动").fill("Open the door.");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    await expect.poll(() => pending.length).toBe(1);
    const settledHead = await head();
    // Reopen while the follow-up is pending: a new real SSE subscription
    // restores the already committed narrative at the same endpoint.
    await open();
    await expect(page.getByText("Alex opens the door.")).toBeVisible();
    send(pending.shift()!, {
      tool_calls: [
        {
          index: 0,
          id: "emit-panel",
          type: "function",
          function: {
            name: "artifact_emit",
            arguments: JSON.stringify({
              output: "panel",
              payload: "Saved panel at the same head",
            }),
          },
        },
      ],
    });
    await expect.poll(() => pending.length).toBe(1);
    const panel = page.frameLocator('iframe[title="panel"]');
    await expect(
      panel.getByText("Saved panel at the same head", { exact: true }),
    ).toBeVisible();
    expect(await head()).toBe(settledHead);
    // A second follow-up fails after the first content has become visible.
    send(pending.shift()!, { content: "No required artifact emitted." });
    await expect(
      page.getByRole("button", { name: "追加行动", exact: true }),
    ).toBeEnabled();
    await expect(
      panel.getByText("Saved panel at the same head", { exact: true }),
    ).toBeVisible();
    expect(await head()).toBe(settledHead);
    await open();
    await expect(
      panel.getByText("Saved panel at the same head", { exact: true }),
    ).toBeVisible();
    await stop();
    await start();
    await open();
    await expect(
      panel.getByText("Saved panel at the same head", { exact: true }),
    ).toBeVisible();
    expect(await head()).toBe(settledHead);
    expect(requests).toBe(3);
  } finally {
    await page.goto("about:blank");
    await stop();
    for (const response of pending) response.destroy();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

function send(response: ServerResponse, delta: object): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
  );
}

function presetFiles(): Record<string, string> {
  return {
    ...defaultPlayPresetFiles,
    "preset.yaml":
      "format: narraeon.play-preset/v1\nname: panels\ncallChain: call-chain.yaml\nmounts:\n  panel: story\nextensions: []\n",
    "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
${["first", "second"]
  .map(
    (id) => `  - id: ${id}
    displayName: ${id}
    prompt: { markdown: prompts/panel.md }
    maxArtifactBytes: 32768
    artifacts:
      - name: panel
        channel: panel
        strategy: replace
        contentType: text/plain
        save: commit
        invalidation: new_operation
        required: true
        maxEmits: 1
`,
  )
  .join("")}`,
    "prompts/panel.md": "Write the panel.\n",
  };
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  return page.evaluate(
    async ({ request: nextRequest }) => {
      const response = await fetch("/api/runtime/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "narraeon.runtime/v1",
          request: nextRequest,
        }),
      });
      const body = (await response.json()) as { result?: T; error?: unknown };
      if (!response.ok) throw new Error(JSON.stringify(body.error));
      return body.result as T;
    },
    { request },
  );
}

function contentFiles() {
  return [
    {
      path: "opening.md",
      contents:
        "The dormitory door closes behind you, and Alex waits for you to speak.\n",
    },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: Current Situation\n  summary: The current situation in the dormitory.\n  aliases: []\nSituation: Alex is folding a jersey.\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World rules\n\nKeep facts consistent and do not act for the player.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
