import { expect, test, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import type { V1Request } from "../../src/protocol/v1.ts";

let provider: Server;
let providerUrl = "";
const responses: string[] = [];
const providerRequests: string[] = [];

test.setTimeout(60_000);

test.beforeAll(async () => {
  await Promise.all(
    [".test-data/e2e", ".test-data/e2e-config", ".test-data/e2e-log"].map(
      (path) => rm(path, { force: true, recursive: true }),
    ),
  );
  provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push(body);
      const text = responses.shift();
      if (text === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected model request" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 20 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("The history-edit fixture Provider did not receive a port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

test("修改旧玩家提交可另存为全新上下文，创建分叉才生成独立世界", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "History branch fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "history-branch-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: package_.localId,
    name: "History branch world",
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    files: contentFiles(),
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: "edit-history-player-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "history-branch-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });

  await page.reload();
  await page
    .getByRole("button", { name: "打开世界：Current Situation", exact: true })
    .click();

  responses.push("Alex says to meet downstairs at eight.");
  await page.getByLabel("你的行动").fill("I ask Alex when we are meeting.");
  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(
    page.getByText("Alex says to meet downstairs at eight."),
  ).toBeVisible();

  responses.push("Alex nods and says he will arrive five minutes early.");
  await page
    .getByLabel("你的行动")
    .fill("Then I will go downstairs five minutes early.");
  await page.getByRole("button", { name: "追加上下文" }).click();
  await expect(
    page.getByText("Alex nods and says he will arrive five minutes early."),
  ).toBeVisible();

  const editedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "Then I will go downstairs five minutes early." });
  await editedPlayer.getByRole("button", { name: "修改" }).click();
  await editedPlayer
    .getByLabel("修改后的行动")
    .fill("Then let's meet fifteen minutes early.");
  await page.getByRole("radio", { name: /作为全新上下文保存/u }).check();
  responses.push("Alex agrees to wait downstairs at seven forty-five.");
  await page.getByRole("button", { name: "保存为全新上下文并继续" }).click();

  await expect(
    page.getByRole("heading", { name: "Current Situation", exact: true }),
  ).toBeVisible();
  const revisedTimeline = page.getByLabel("调用链记录");
  await expect(
    page.getByRole("separator", { name: "全新上下文从这里开始" }),
  ).toHaveCount(2);
  await expect(revisedTimeline).not.toContainText(
    "Then I will go downstairs five minutes early.",
  );
  await expect(revisedTimeline).not.toContainText(
    "Alex nods and says he will arrive five minutes early.",
  );
  await expect(revisedTimeline).toContainText(
    "Then let's meet fifteen minutes early.",
  );
  await expect(revisedTimeline).toContainText(
    "Alex agrees to wait downstairs at seven forty-five.",
  );
  const workspaceAfterRevision = await runtime<{
    worlds: { worldId: string; title: string }[];
  }>(page, { type: "workspace.read" });
  expect(workspaceAfterRevision.worlds).toEqual([
    expect.objectContaining({ worldId: created.world.worldId }),
  ]);
  const copiedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "I ask Alex when we are meeting." });
  await expect(
    copiedPlayer.getByRole("button", { name: "修改" }),
  ).toBeVisible();
  await expect(
    copiedPlayer.getByRole("button", { name: "创建分叉" }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(3);
  expect(providerRequests[2]).toContain(
    "Then let's meet fifteen minutes early.",
  );
  expect(providerRequests[2]).not.toContain(
    "Then I will go downstairs five minutes early.",
  );

  const revisedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "Then let's meet fifteen minutes early." });
  await revisedPlayer.getByRole("button", { name: "创建分叉" }).click();
  await expect(
    page.getByRole("heading", { name: "Current Situation (fork)" }),
  ).toBeVisible();
  const forkTimeline = page.getByLabel("调用链记录");
  await expect(forkTimeline).toContainText(
    "Then let's meet fifteen minutes early.",
  );
  await expect(forkTimeline).not.toContainText(
    "Then I will go downstairs five minutes early.",
  );
  const workspaceAfterFork = await runtime<{
    worlds: { worldId: string; title: string }[];
  }>(page, { type: "workspace.read" });
  expect(workspaceAfterFork.worlds).toHaveLength(2);
  expect(
    workspaceAfterFork.worlds.some(
      ({ worldId }) => worldId === created.world.worldId,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page
    .getByRole("button", { name: "打开世界：Current Situation", exact: true })
    .click();
  const currentTimeline = page.getByLabel("调用链记录");
  await expect(currentTimeline).toContainText(
    "Then let's meet fifteen minutes early.",
  );
  await expect(currentTimeline).not.toContainText(
    "Then I will go downstairs five minutes early.",
  );
});

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
