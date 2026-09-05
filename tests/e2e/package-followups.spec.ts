import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Request } from "../../src/protocol/v1.ts";

test("普通作者编辑包后置请求后创建世界，经真实 Runtime 派发、来源脚本授权与冷重启显示", async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const root = await mkdtemp(join(tmpdir(), "narraeon-extension-browser-"));
  const pending: ServerResponse[] = [];
  let requests = 0;
  const requestBodies: string[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests += 1;
      requestBodies.push(body);
      const parsed = JSON.parse(body) as { tools?: unknown[] };
      if (parsed.tools?.length === 2)
        send(response, {
          tool_calls: [
            {
              index: 0,
              id: `package-output-${requests}`,
              type: "function",
              function: {
                name: "artifact_emit",
                arguments: JSON.stringify({
                  output: "output_1",
                  payload: "<p>PACKAGE BROWSER OUTPUT</p>",
                }),
              },
            },
            {
              index: 1,
              id: `package-script-${requests}`,
              type: "function",
              function: {
                name: "artifact_emit",
                arguments: JSON.stringify({
                  output: "output_2",
                  payload: "Script panel",
                }),
              },
            },
          ],
        });
      else send(response, { content: "The world opens its door." });
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
        name: "Package fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "package-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    await page.reload();
    await page.getByRole("button", { name: "新建内容包", exact: true }).click();
    await page
      .getByRole("navigation", { name: "设定完善工具" })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await page
      .getByRole("button", { name: "内容包后置请求", exact: true })
      .click();
    await page.getByRole("button", { name: "新增包后置请求" }).click();
    await page.getByLabel("包请求名称").fill("旅途回顾");
    await page
      .getByLabel("包请求提示词")
      .fill("PACKAGE BROWSER PROMPT: emit output_1 from the settled story.");
    await page.getByLabel("output_1 内容格式").selectOption("text/html");
    await page.getByText("编辑渲染资源", { exact: true }).click();
    await page.getByRole("button", { name: "添加 HTML 模板" }).click();
    await page
      .getByLabel("HTML 模板 1")
      .fill(
        '<main><h2>Package original renderer</h2><!-- narraeon:content --><span id="script-status">Script off</span></main>',
      );
    await page.getByRole("button", { name: "添加 样式与资源" }).click();
    await page
      .getByLabel("样式与资源 1")
      .fill("h2 { color: rgb(17, 88, 133); }");
    await page.getByRole("button", { name: "新增产物", exact: true }).click();
    await page.getByText("编辑渲染资源", { exact: true }).last().click();
    await page.getByRole("button", { name: "添加 HTML 模板" }).last().click();
    await page
      .getByLabel("HTML 模板 1")
      .last()
      .fill('<main><span id="script-status">Script off</span></main>');
    await page.getByRole("button", { name: "添加 JavaScript" }).last().click();
    await page
      .getByLabel("JavaScript 1")
      .fill(
        'document.getElementById("script-status").textContent = "Package script executed";',
      );
    await page.getByText("高级产物设置", { exact: true }).last().click();
    await page.getByLabel("模板模式").last().selectOption("app");
    await page.getByRole("button", { name: "整批保存", exact: true }).click();
    await expect(page.getByText("当前树已保存", { exact: true })).toBeVisible();
    const workspace = await runtime<{ contentPackages: { localId: string }[] }>(
      page,
      { type: "workspace.read" },
    );
    const packageId = workspace.contentPackages[0]!.localId;
    const source = await runtime<{
      files: { path: string; contents: string }[];
      status: string;
    }>(page, { type: "content.read", packageId });
    expect(source.status).toBe("usable");
    const manifest = source.files.find(
      (file) => file.path === "control/followups.yaml",
    )!.contents;
    expect(manifest).toContain("旅途回顾");
    expect(manifest).toContain("enabled: true");
    const exported = await runtime<{ base64: string }>(page, {
      type: "content.export",
      packageId,
    });
    const imported = await runtime<{ localId: string }>(page, {
      type: "content.import",
      archiveBase64: exported.base64,
      title: "Imported panel world",
    });
    expect(
      await runtime(page, {
        type: "content.scripts.read",
        packageId: imported.localId,
      }),
    ).toEqual({ enabled: false });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: "package-browser-world",
      packageId: imported.localId,
      model: {
        provider: "chat_completions",
        modelId: "package-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const worldId = created.world.worldId;
    // Changing and deleting both source packages must never change the copied world or its resources.
    await runtime(page, {
      type: "content.replace",
      packageId: imported.localId,
      files: source.files.filter(
        (file) => file.path !== "control/followups.yaml",
      ),
    });
    await runtime(page, {
      type: "content.delete",
      packageId: imported.localId,
    });
    await runtime(page, { type: "content.delete", packageId });
    const open = async () => {
      await page.goto(url);
      await page
        .getByRole("button", {
          name: "打开世界：Imported panel world",
          exact: true,
        })
        .click();
    };
    await open();
    await page.getByLabel("你的行动").fill("Open the door.");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    const reply = () =>
      page.locator(".call-chain-assistant").filter({
        hasText: "The world opens its door.",
      });
    const panel = () => reply().frameLocator('iframe[title="output_1"]');
    const scriptPanel = () => reply().frameLocator('iframe[title="output_2"]');
    await expect(panel().getByText("Package original renderer")).toBeVisible();
    await expect(panel().getByText("PACKAGE BROWSER OUTPUT")).toBeVisible();
    await expect(panel().getByText("Package original renderer")).toHaveCSS(
      "color",
      "rgb(17, 88, 133)",
    );
    await expect(
      scriptPanel().getByText("Script off", { exact: true }),
    ).toBeVisible();
    await expect(reply()).toHaveCount(1);
    await expect(reply().locator("iframe")).toHaveCount(2);
    const assertPermissions = async (
      targetWorldId: string,
      enabled: boolean,
    ) => {
      for (const type of ["artifacts.read", "artifacts.debug"] as const) {
        const records = await runtime<
          {
            output: string;
            attachment: {
              contextId: string;
              eventId: number;
              runId: string;
              head: string;
            };
            frozenPresentation: { files: Record<string, string> };
            frontend: {
              trustedLocalCode: boolean;
              renderer: { document: string };
            };
          }[]
        >(page, { type, worldId: targetWorldId });
        expect(records).toHaveLength(2);
        expect(records[0]!.attachment).toEqual(records[1]!.attachment);
        expect(records[0]!.attachment.runId).not.toBe("");
        expect(
          records.find((record) => record.output === "output_2")!.frontend
            .trustedLocalCode,
        ).toBe(enabled);
        expect(
          records.find((record) => record.output === "output_1")!.frontend
            .renderer.document,
        ).toContain("Package original renderer");
        expect(
          Object.values(
            records.find((record) => record.output === "output_2")!
              .frozenPresentation.files,
          ).join("\n"),
        ).toContain("Package script executed");
      }
    };
    await assertPermissions(worldId, false);
    expect(requests).toBe(2);
    expect(requestBodies[1]).toContain("PACKAGE BROWSER PROMPT");
    const before = await runtime<{ head: string }>(page, {
      type: "world.read",
      worldId,
    });
    await page
      .getByRole("button", { name: "世界管理", exact: true })
      .first()
      .click();
    await page.getByLabel("允许运行内容包脚本").click();
    await expect(page.getByLabel("允许运行内容包脚本")).toBeChecked();
    await page
      .getByRole("dialog", { name: "世界管理" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(
      scriptPanel().getByText("Package script executed", { exact: true }),
    ).toBeVisible();
    expect(
      (await runtime<{ head: string }>(page, { type: "world.read", worldId }))
        .head,
    ).toBe(before.head);
    expect(requests).toBe(2);
    await assertPermissions(worldId, true);
    const fork = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.derive",
      operationId: "package-artifact-fork",
      sourceWorldId: worldId,
      sourceHead: before.head,
    });
    await runtime(page, {
      type: "world.rename",
      worldId: fork.world.worldId,
      name: "Package artifact fork",
    });
    await stop();
    await start();
    await open();
    await expect(panel().getByText("PACKAGE BROWSER OUTPUT")).toBeVisible();
    await expect(
      scriptPanel().getByText("Package script executed", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "世界管理", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "撤销全部包脚本授权" }).click();
    await expect(page.getByLabel("允许运行内容包脚本")).not.toBeChecked();
    await page
      .getByRole("dialog", { name: "世界管理" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(
      scriptPanel().getByText("Script off", { exact: true }),
    ).toBeVisible();
    await open();
    await expect(
      scriptPanel().getByText("Script off", { exact: true }),
    ).toBeVisible();
    await assertPermissions(worldId, false);
    await assertPermissions(fork.world.worldId, true);
    await runtime(page, { type: "world.delete", worldId });
    await stop();
    await start();
    const openFork = async () => {
      await page.goto(url);
      await page
        .getByRole("button", {
          name: "打开世界：Package artifact fork",
          exact: true,
        })
        .click();
    };
    await openFork();
    await expect(reply()).toHaveCount(1);
    await expect(reply().locator("iframe")).toHaveCount(2);
    await expect(panel().getByText("PACKAGE BROWSER OUTPUT")).toBeVisible();
    await expect(
      scriptPanel().getByText("Package script executed", { exact: true }),
    ).toBeVisible();
    await assertPermissions(fork.world.worldId, true);
    await runtime(page, {
      type: "world.package-scripts.set",
      worldId: fork.world.worldId,
      enabled: false,
    });
    await openFork();
    await expect(
      scriptPanel().getByText("Script off", { exact: true }),
    ).toBeVisible();
    await assertPermissions(fork.world.worldId, false);
    expect(
      (
        await runtime<{ head: string }>(page, {
          type: "world.read",
          worldId: fork.world.worldId,
        })
      ).head,
    ).toBe(before.head);
    expect(requests).toBe(2);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
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
