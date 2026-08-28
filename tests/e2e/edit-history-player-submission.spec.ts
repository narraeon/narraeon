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
    throw new Error("历史提交编辑 fixture Provider 未获得端口");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

test("修改旧玩家提交会留在当前世界，创建分叉才生成独立世界", async ({
  page,
}) => {
  await page.goto("/");
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "历史分支 fixture",
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
    name: "历史分支世界",
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
    .getByRole("button", { name: "打开世界：当前情境", exact: true })
    .click();

  responses.push("秦龙说八点在宿舍楼下集合。");
  await page.getByLabel("你的行动").fill("我问秦龙几点集合。");
  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(page.getByText("秦龙说八点在宿舍楼下集合。")).toBeVisible();

  responses.push("秦龙点头，说会提前五分钟下楼。");
  await page.getByLabel("你的行动").fill("那我提前五分钟下楼。");
  await page.getByRole("button", { name: "追加上下文" }).click();
  await expect(page.getByText("秦龙点头，说会提前五分钟下楼。")).toBeVisible();

  const editedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "那我提前五分钟下楼。" });
  await editedPlayer.getByRole("button", { name: "修改" }).click();
  await editedPlayer
    .getByLabel("修改后的行动")
    .fill("那我们提前十五分钟集合。");
  responses.push("秦龙答应七点四十五就在楼下等你。");
  await page.getByRole("button", { name: "保存修改并继续" }).click();

  await expect(
    page.getByRole("heading", { name: "当前情境", exact: true }),
  ).toBeVisible();
  const revisedTimeline = page.getByLabel("调用链记录");
  await expect(revisedTimeline).not.toContainText("那我提前五分钟下楼。");
  await expect(revisedTimeline).not.toContainText(
    "秦龙点头，说会提前五分钟下楼。",
  );
  await expect(revisedTimeline).toContainText("那我们提前十五分钟集合。");
  await expect(revisedTimeline).toContainText(
    "秦龙答应七点四十五就在楼下等你。",
  );
  const workspaceAfterRevision = await runtime<{
    worlds: { worldId: string; title: string }[];
  }>(page, { type: "workspace.read" });
  expect(workspaceAfterRevision.worlds).toEqual([
    expect.objectContaining({ worldId: created.world.worldId }),
  ]);
  const copiedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "我问秦龙几点集合。" });
  await expect(
    copiedPlayer.getByRole("button", { name: "修改" }),
  ).toBeVisible();
  await expect(
    copiedPlayer.getByRole("button", { name: "创建分叉" }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(3);
  expect(providerRequests[2]).toContain("那我们提前十五分钟集合。");
  expect(providerRequests[2]).not.toContain("那我提前五分钟下楼。");

  const revisedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "那我们提前十五分钟集合。" });
  await revisedPlayer.getByRole("button", { name: "创建分叉" }).click();
  await expect(
    page.getByRole("heading", { name: "当前情境（分叉）" }),
  ).toBeVisible();
  const forkTimeline = page.getByLabel("调用链记录");
  await expect(forkTimeline).toContainText("那我们提前十五分钟集合。");
  await expect(forkTimeline).not.toContainText("那我提前五分钟下楼。");
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
    .getByRole("button", { name: "打开世界：当前情境", exact: true })
    .click();
  const currentTimeline = page.getByLabel("调用链记录");
  await expect(currentTimeline).toContainText("那我们提前十五分钟集合。");
  await expect(currentTimeline).not.toContainText("那我提前五分钟下楼。");
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
      contents: "宿舍门在你身后合上。秦龙正等你先开口。\n",
    },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 宿舍里的当前局面。\n  aliases: []\n情况: 秦龙正在整理球衣。\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界规则\n\n保持事实一致，不代理玩家行动。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
