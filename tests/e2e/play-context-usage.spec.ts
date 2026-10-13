import { expect as playwrightExpect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { V1PlayCallChainView, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

let provider: Server;
let providerUrl = "";
const responses: { text: string; inputTokens: number; delay?: number }[] = [];
const providerRequests: string[] = [];
const expect = playwrightExpect.configure({ timeout: 15_000 });

test.use({ runtimeScope: "play-context-usage" });
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000 });

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      providerRequests.push(body);
      const next = responses.shift();
      if (next === undefined) {
        response.writeHead(500);
        response.end("Unexpected model request");
        return;
      }
      const send = (): void => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: next.text } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: next.inputTokens, completion_tokens: 20 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      };
      if (next.delay === undefined) send();
      else setTimeout(send, next.delay);
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Provider fixture has no port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

test("实报 85% 提示可准备下一条全新上下文，超过窗口仍可追加，刷新保留当前占用", async ({
  page,
}, testInfo) => {
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "POST" ||
      !request.url().endsWith("/api/runtime/v1")
    )
      return;
    const type = (request.postDataJSON() as { request?: { type?: string } })
      .request?.type;
    if (type === "play.chain.start" || type === "play.chain.append")
      submissions.push(type);
  });
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Context usage fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "context-model",
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_024,
    },
  });
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: package_.localId,
    name: "Context world",
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    files: contentFiles(),
  });
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: "context-usage-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "context-model",
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_024,
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "打开世界：Context world", exact: true })
    .click();
  await expect(page.getByText("上下文 —", { exact: true })).toBeVisible();

  responses.push({ text: "Alex waits by the door.", inputTokens: 8_500 });
  await page.getByLabel("你的行动").fill("Look around.");
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  await expect(page.getByText("上下文 85%", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText("上下文已用 85%，建议下一条从全新上下文开始"),
  ).toBeVisible();
  const original = await runtime<V1PlayCallChainView>(page, {
    type: "play.chain.inspect",
    worldId: world.worldId,
  });
  await page.reload();
  await expect(page).toHaveURL(/#\/world\//u);
  await expect(page.getByText("上下文 85%", { exact: true })).toBeVisible();
  const shortcut = page.getByRole("button", {
    name: "下一条消息使用全新上下文",
    exact: true,
  });
  await expect(shortcut).toBeEnabled();
  await page
    .locator(".world-composer-dock")
    .screenshot({ path: testInfo.outputPath("context-usage-composer.png") });
  await shortcut.click();
  await expect(page.getByText("上下文 —", { exact: true })).toBeVisible();
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("你的行动")).toBeFocused();
  expect(providerRequests).toHaveLength(1);
  await page
    .getByRole("button", { name: "取消全新上下文", exact: true })
    .click();

  // Runtime admits the next request even above 100%; the Provider decides fit.
  responses.push({ text: "Alex opens the door.", inputTokens: 10_500 });
  await page.getByLabel("你的行动").fill("Open the door.");
  await page.getByRole("button", { name: "追加行动", exact: true }).click();
  await expect(page.getByText("上下文 105%", { exact: true })).toBeVisible();
  await expect(shortcut).toBeEnabled();
  await shortcut.click();
  responses.push({
    text: "The hallway is quiet.",
    inputTokens: 2_000,
    delay: 1_500,
  });
  await page.getByLabel("你的行动").fill("Walk into the hallway.");
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  await expect(page.getByText("上下文 —", { exact: true })).toBeVisible();
  await expect(page.getByText(/上下文已用/u)).toHaveCount(0);
  await expect(page.getByText("上下文 20%", { exact: true })).toBeVisible();
  const fresh = await runtime<V1PlayCallChainView>(page, {
    type: "play.chain.inspect",
    worldId: world.worldId,
  });
  expect(fresh.chainId).not.toBe(original.chainId);
  expect(submissions).toEqual([
    "play.chain.start",
    "play.chain.append",
    "play.chain.start",
  ]);
  expect(providerRequests).toHaveLength(3);
  const sent = JSON.parse(providerRequests[2]!) as {
    messages: { role: string; content: unknown }[];
  };
  expect(
    sent.messages.filter(({ role }) => role === "assistant"),
  ).not.toContainEqual(
    expect.objectContaining({ content: "Alex waits by the door." }),
  );
  expect(providerRequests.join("\n")).not.toContain("上下文已用");
  await expect(
    page.getByRole("separator", { name: "全新上下文从这里开始" }),
  ).toHaveCount(2);
  await page.reload();
  await expect(page).toHaveURL(/#\/world\//u);
  await expect(page.getByText("上下文 20%", { exact: true })).toBeVisible();
  await expect(page.getByText(/上下文已用/u)).toHaveCount(0);
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await page
    .getByRole("button", { name: "Open world: Context world", exact: true })
    .click();
  await expect(page.getByText("Context 20%", { exact: true })).toBeVisible();
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
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

function contentFiles() {
  return [
    { path: "opening.md", contents: "Alex waits for you to speak.\n" },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: The doorway\n  summary: Waiting by the door.\n  aliases: []\nSituation: Alex stands by the door.\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    { path: "control/blocks/world.md", contents: "Keep facts consistent.\n" },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
