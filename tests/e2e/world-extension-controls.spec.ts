import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { stringify } from "yaml";
import {
  RuntimeServerPool,
  availableRuntimePort,
} from "../support/runtimeServer.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { WorldExtensionsView } from "../../src/protocol/worldExtensions.ts";

test("真实世界扩展菜单阻止派发、取消在途、隐藏全部输出；纯界面零请求、跨标签通知和冷启动独立偏好", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(
    join(tmpdir(), "narraeon-world-controls-browser-"),
  );
  const servers = new RuntimeServerPool();
  const port = await availableRuntimePort();
  const url = `http://127.0.0.1:${port}`;
  let runtimeOutput = "";
  const startRuntime = async () => {
    const runtime = await servers.start(root, port);
    const capture = (chunk: Buffer) => {
      runtimeOutput += chunk.toString("utf8");
    };
    runtime.stdout?.on("data", capture);
    runtime.stderr?.on("data", capture);
    return runtime;
  };
  let child = await startRuntime();
  let mainCount = 0,
    followupCount = 0;
  const firstMain = Promise.withResolvers<ServerResponse>();
  const firstFollowup = Promise.withResolvers<ServerResponse>();
  let wasCancelled = false;
  const responses: ServerResponse[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      responses.push(response);
      const parsed = JSON.parse(body) as { tools?: unknown[] };
      if (parsed.tools?.length === 2) {
        followupCount++;
        if (followupCount === 1) {
          response.on("close", () => {
            wasCancelled = true;
          });
          firstFollowup.resolve(response);
          return;
        }
        send(response, {
          tool_calls: ["one", "two"].map((output, index) => ({
            index,
            id: `output-${followupCount}-${index}`,
            type: "function",
            function: {
              name: "artifact_emit",
              arguments: JSON.stringify({
                output,
                payload: `<p>VISIBLE ${output}</p>`,
              }),
            },
          })),
        });
      } else {
        mainCount++;
        if (mainCount === 1) {
          firstMain.resolve(response);
          return;
        }
        send(response, { content: `Committed narrative ${mainCount}` });
      }
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("No provider address");
  try {
    await page.goto(url);
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await api(page, {
      type: "model.save",
      connection: {
        name: "Controls fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "controls-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const content = await api<{ localId: string }>(page, {
      type: "content.create",
    });
    await api(page, {
      type: "content.rename",
      packageId: content.localId,
      name: "扩展菜单世界",
    });
    const files = minimalFileNativeContentScaffold().map((file) =>
      file.path === "control/player-views.yaml"
        ? {
            ...file,
            contents: stringify({
              format: "narraeon.player-views/v1",
              views: [
                {
                  id: "current",
                  title: "当前字段",
                  items: [
                    {
                      id: "location",
                      label: "所在位置",
                      select: {
                        document: "@current-situation",
                        locator: { yaml: ["location"] },
                      },
                    },
                  ],
                },
              ],
            }),
          }
        : file,
    );
    files.push(
      {
        path: "control/followups.yaml",
        contents: stringify({
          format: "narraeon.package-followups/v1",
          followups: [
            {
              id: "review",
              displayName: "本轮回顾",
              enabled: false,
              mount: "story",
              prompt: {
                role: "author_instruction",
                markdown: "prompts/review.md",
              },
              artifacts: ["one", "two"].map((name) => ({
                name,
                channel: name,
                strategy: "append",
                contentType: "text/html",
                save: "commit",
                invalidation: "explicit_clear",
              })),
              maxArtifactBytes: 32768,
            },
          ],
        }),
      },
      { path: "control/prompts/review.md", contents: "Emit one and two." },
    );
    await api(page, {
      type: "content.replace",
      packageId: content.localId,
      files,
    });
    const created = await api<{ world: { worldId: string } }>(page, {
      type: "world.create",
      packageId: content.localId,
      operationId: "create-controls",
      model: {
        provider: "chat_completions",
        modelId: "controls-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const worldId = created.world.worldId;
    const open = async (target: Page = page) => {
      await target.goto(url);
      await target
        .getByRole("button", { name: "打开世界：扩展菜单世界", exact: true })
        .click();
    };
    await open();
    const menu = page.locator(".world-extension-menu");
    await menu.locator("summary").click();
    const request = menu.getByRole("checkbox", {
      name: "本轮回顾",
      exact: true,
    });
    const group = menu.getByRole("checkbox", {
      name: "内容包后置请求",
      exact: true,
    });
    await expect(request).not.toBeChecked();
    await setChecked(request, true);
    await expect(request).toBeEnabled();
    await page.getByLabel("你的行动").fill("First action");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    const pendingMain = await firstMain.promise;
    await setChecked(request, false);
    await expect(request).toBeEnabled();
    await setChecked(request, true);
    await expect(request).toBeEnabled();
    send(pendingMain, { content: "Committed narrative 1" });
    await expect(
      page.getByText("Committed narrative 1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("你的行动")).toBeEnabled();
    expect(followupCount).toBe(0);
    await page.getByLabel("你的行动").fill("Second action");
    await page.getByRole("button", { name: "追加行动", exact: true }).click();
    const pendingFollowup = await firstFollowup.promise;
    const head = (
      await api<{ head: string }>(page, { type: "world.read", worldId })
    ).head;
    await setChecked(request, false);
    await expect.poll(() => wasCancelled).toBe(true);
    // The HTTP response arrives after cancellation; it cannot put either output on screen.
    send(pendingFollowup, { content: "Late response" });
    await expect(request).toBeEnabled();
    await setChecked(request, true);
    await expect(request).toBeEnabled();
    expect(followupCount).toBe(1);
    await expect(page.locator('iframe[title="one"]')).toHaveCount(0);
    expect(
      (await api<{ head: string }>(page, { type: "world.read", worldId })).head,
    ).toBe(head);
    await page.getByLabel("你的行动").fill("Third action");
    await page.getByRole("button", { name: "追加行动", exact: true }).click();
    for (const name of ["one", "two"])
      await expect(
        page
          .frameLocator(`iframe[title="${name}"]`)
          .getByText(`VISIBLE ${name}`, { exact: true }),
      ).toBeVisible();
    await expect(page.getByLabel("你的行动")).toBeEnabled();
    await page.getByLabel("你的行动").fill("Fourth action");
    await page.getByRole("button", { name: "追加行动", exact: true }).click();
    for (const name of ["one", "two"])
      await expect(page.locator(`iframe[title="${name}"]`)).toHaveCount(2);
    for (const narrative of [3, 4]) {
      const reply = page
        .locator(".call-chain-assistant")
        .filter({ hasText: `Committed narrative ${narrative}` });
      await expect(reply).toHaveCount(1);
      await expect(reply.locator("iframe")).toHaveCount(2);
    }
    await expect(page.getByLabel("你的行动")).toBeEnabled();
    const retainedFork = await api<{ world: { worldId: string } }>(page, {
      type: "world.derive",
      sourceWorldId: worldId,
      sourceHead: (
        await api<{ head: string }>(page, { type: "world.read", worldId })
      ).head,
      operationId: "fork-retained-attachments",
    });
    await api(page, {
      type: "world.rename",
      worldId: retainedFork.world.worldId,
      name: "Retained attachments",
    });
    const observer = await context.newPage();
    await open(observer);
    await expect(observer.locator('iframe[title="one"]')).toHaveCount(2);
    await setChecked(group, false);
    await expect(group).toBeEnabled();
    await expect(request).toBeChecked();
    for (const target of [page, observer])
      for (const name of ["one", "two"])
        await expect(target.locator(`iframe[title="${name}"]`)).toHaveCount(0);
    await setChecked(group, true);
    await expect(group).toBeEnabled();
    await expect(page.locator('iframe[title="one"]')).toHaveCount(0);
    expect(followupCount).toBe(3);
    await page.getByRole("button", { name: "此刻", exact: true }).click();
    await expect(page.getByText("Not set", { exact: true })).toBeVisible();
    await setChecked(
      menu.getByRole("checkbox", { name: "当前字段", exact: true }),
      false,
    );
    await expect(page.getByText("Not set", { exact: true })).toHaveCount(0);
    await setChecked(
      menu.getByRole("checkbox", { name: "当前字段", exact: true }),
      true,
    );
    await expect(page.getByText("Not set", { exact: true })).toBeVisible();
    expect(mainCount).toBe(4);
    expect(followupCount).toBe(3);
    await setChecked(request, false);
    await expect(request).toBeEnabled();
    expect(
      await api(page, { type: "world.package-scripts.read", worldId }),
    ).toEqual({ enabled: false });
    const fork = await api<{ world: { worldId: string } }>(page, {
      type: "world.derive",
      sourceWorldId: worldId,
      sourceHead: (
        await api<{ head: string }>(page, { type: "world.read", worldId })
      ).head,
      operationId: "fork-controls",
    });
    await api(page, {
      type: "world.extensions.set",
      worldId: fork.world.worldId,
      key: "package:review",
      value: "on",
    });
    await observer.close();
    await page.goto("about:blank");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    child = await startRuntime();
    await open();
    await menu.locator("summary").click();
    await expect(request).not.toBeChecked();
    await expect(page.locator('iframe[title="one"]')).toHaveCount(0);
    const forkView = await api<WorldExtensionsView>(page, {
      type: "world.extensions.read",
      worldId: fork.world.worldId,
    });
    expect(
      forkView.items.find((item) => item.key === "package:review")?.enabled,
    ).toBe(true);
    expect(
      await api(page, { type: "artifacts.read", worldId: fork.world.worldId }),
    ).toEqual([]);
    await api(page, { type: "world.delete", worldId });
    await page.goto("about:blank");
    const sourceDeletedExit = once(child, "exit");
    child.kill("SIGKILL");
    await sourceDeletedExit;
    child = await startRuntime();
    await page.goto(url);
    await page
      .getByRole("button", {
        name: "打开世界：Retained attachments",
        exact: true,
      })
      .click();
    for (const narrative of [3, 4]) {
      const reply = page
        .locator(".call-chain-assistant")
        .filter({ hasText: `Committed narrative ${narrative}` });
      await expect(reply).toHaveCount(1);
      await expect(reply.locator("iframe")).toHaveCount(2);
    }
    const retainedWorldId = retainedFork.world.worldId;
    const retainedHead = (
      await api<{ head: string }>(page, {
        type: "world.read",
        worldId: retainedWorldId,
      })
    ).head;
    await menu.locator("summary").click();
    await setChecked(request, false);
    await expect(page.locator('iframe[title="one"]')).toHaveCount(0);
    await expect(page.locator('iframe[title="two"]')).toHaveCount(0);
    await setChecked(request, true);
    expect(
      await api(page, { type: "artifacts.read", worldId: retainedWorldId }),
    ).toEqual([]);
    expect(
      (
        await api<{ head: string }>(page, {
          type: "world.read",
          worldId: retainedWorldId,
        })
      ).head,
    ).toBe(retainedHead);
    expect(
      await api(page, {
        type: "world.package-scripts.read",
        worldId: retainedWorldId,
      }),
    ).toEqual({ enabled: false });
    expect(mainCount).toBe(4);
    expect(followupCount).toBe(3);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await servers.stopAll();
    const logPath = test.info().outputPath("runtime-output.log");
    await writeFile(logPath, runtimeOutput);
    await test.info().attach("runtime-output", {
      path: logPath,
      contentType: "text/plain",
    });
    for (const response of responses) response.destroy();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function send(response: ServerResponse, delta: object) {
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
  );
}
async function api<T = unknown>(page: Page, request: V1Request): Promise<T> {
  return page.evaluate(async (request) => {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "narraeon.runtime/v1", request }),
    });
    const body = (await response.json()) as { result: T; error?: unknown };
    if (!response.ok) throw new Error(JSON.stringify(body.error));
    return body.result;
  }, request);
}

async function setChecked(locator: Locator, value: boolean) {
  await locator.click();
  if (value) await expect(locator).toBeChecked();
  else await expect(locator).not.toBeChecked();
  await expect(locator).toBeEnabled();
}
