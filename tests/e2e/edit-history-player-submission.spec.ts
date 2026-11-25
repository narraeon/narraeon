import { expect, type Page } from "@playwright/test";
import { test } from "../support/isolatedRuntimeTest.ts";
import { createServer, type Server } from "node:http";

import type { V1PlayCallChainView, V1Request } from "../../src/protocol/v1.ts";

let provider: Server;
let providerUrl = "";
const responses: (string | { checkpoint: true } | { disconnect: true })[] = [];
const providerRequests: string[] = [];

test.setTimeout(90_000);

test.use({ runtimeScope: "edit-history" });

test.beforeAll(async () => {
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
      if (typeof text === "object" && "disconnect" in text) {
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({ choices: [{ delta: typeof text === "string" ? { content: text } : { tool_calls: [{ index: 0, id: `checkpoint-call-${providerRequests.length}`, type: "function", function: { name: "world_checkpoint", arguments: "{}" } }] } }] })}\n\n`,
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
  if (provider === undefined) return;
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`${locale}: edit history in the existing session or a new conversation`, ({
    page,
  }) => verifyHistoryEdit(page, locale));
}

async function verifyHistoryEdit(page: Page, locale: "zh-CN" | "en") {
  const t = (zh: string, en: string) => (locale === "en" ? en : zh);
  const expectReply = expect.configure({ timeout: 20_000 });
  const title = `History branch world ${locale}`;
  const openWorld = t(`打开世界：${title}`, `Open world: ${title}`);
  const workspace = () =>
    runtime<{ worlds: { worldId: string }[] }>(page, {
      type: "workspace.read",
    });
  responses.length = 0;
  providerRequests.length = 0;
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption(locale);
  const worldsBefore = (await workspace()).worlds.length;
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
    name: title,
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    baseTreeRevision: (
      await runtime<{ treeRevision: string }>(page, {
        type: "content.read",
        packageId: package_.localId,
      })
    ).treeRevision,
    files: contentFiles(),
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: `edit-history-player-world-${locale}`,
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "history-branch-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });

  await page.reload();
  await page.getByRole("button", { name: openWorld, exact: true }).click();

  const originalReply = "Alex says to meet downstairs at eight.";
  const action = page.getByLabel(t("你的行动", "Your action"), { exact: true });
  responses.push(originalReply);
  await action.fill("I ask Alex when we are meeting.");
  await page
    .getByRole("button", {
      name: t("从全新上下文发送行动", "Send action from a fresh context"),
      exact: true,
    })
    .click();
  await expectReply(
    page.getByText(originalReply, { exact: true }),
  ).toBeVisible();

  const originalAction = "Then I will go downstairs five minutes early.";
  const replacedReply = "Alex nods and says he will arrive five minutes early.";
  responses.push(replacedReply);
  await action.fill(originalAction);
  await page
    .getByRole("button", { name: t("追加行动", "Append action"), exact: true })
    .click();
  await expectReply(
    page.getByText(replacedReply, { exact: true }),
  ).toBeVisible();

  const revisedTimeline = page.getByLabel(t("故事时间线", "Story timeline"));
  const edit = t("修改", "Edit");
  const fork = t("创建分叉", "Create fork");
  const editor = revisedTimeline.locator(".history-player-edit");
  const openEdit = async (before: string, after: string) => {
    const player = revisedTimeline
      .locator(".call-chain-player")
      .filter({ hasText: before });
    await player.getByRole("button", { name: edit, exact: true }).click();
    await editor.getByLabel(t("修改后的行动", "Edited action")).fill(after);
  };
  const revisionCommands: Extract<
    V1Request,
    { type: "play.chain.revise-player" }
  >[] = [];
  page.on("request", (request) => {
    if (
      !request.url().endsWith("/api/runtime/v1") ||
      request.method() !== "POST"
    )
      return;
    const command = (request.postDataJSON() as { request: V1Request }).request;
    if (command.type === "play.chain.revise-player")
      revisionCommands.push(command);
  });
  const readHead = async () =>
    (
      await runtime<{ head: string }>(page, {
        type: "world.read",
        worldId: created.world.worldId,
      })
    ).head;
  const originalHead = await readHead();
  const priorAssistantMessage = { role: "assistant", content: originalReply };
  const messages = () =>
    (JSON.parse(providerRequests.at(-1)!) as { messages: unknown[] }).messages;
  const separators = revisedTimeline.getByRole("separator", {
    name: t("全新上下文从这里开始", "A new context begins here"),
  });

  const currentEdit = "Then let's meet ten minutes early.";
  const currentReply =
    "Alex agrees to meet ten minutes early in the same conversation.";
  await openEdit(originalAction, currentEdit);
  const continuation = t("修改后如何继续", "How to continue after editing");
  const options = editor.locator("summary").filter({ hasText: continuation });
  await expect(options).toBeVisible();
  await expect(editor.getByRole("radio")).toHaveCount(0);
  await expect(
    editor.getByText(
      t(
        "保存修改会永久删除这条原消息及之后的故事、模型对话和产物，并撤销从这条消息起的世界改动。此前的历史会保留。",
        "Saving permanently deletes the original message and all later story, model conversation, and artifacts. It rolls back world changes from that message onward. Earlier history is kept.",
      ),
      { exact: true },
    ),
  ).toBeVisible();
  responses.push({ disconnect: true });
  await editor
    .getByRole("button", {
      name: t("保存修改并继续", "Save edit and continue"),
      exact: true,
    })
    .click();
  const resend = page.getByRole("button", {
    name: t("重新发送", "Resend request"),
    exact: true,
  });
  await expectReply(resend).toBeEnabled();
  const interruptedHead = await readHead();
  expect(interruptedHead).not.toBe(originalHead);
  expect(providerRequests).toHaveLength(3);
  responses.push(currentReply);
  await resend.click();
  await expectReply(
    revisedTimeline.getByText(currentReply, { exact: true }),
  ).toBeVisible();
  await expectReply(action).toBeEnabled();
  await expect(revisedTimeline).not.toContainText(originalAction);
  await expect(revisedTimeline).not.toContainText(replacedReply);
  await expect(separators).toHaveCount(1);
  expect(messages()).toContainEqual(
    expect.objectContaining(priorAssistantMessage),
  );

  expect(revisionCommands.map(({ continuation }) => continuation)).toEqual([
    "auto",
  ]);
  const currentHead = await readHead();
  expect(currentHead).not.toBe(originalHead);
  const replayed = await runtime<{
    continuation: string;
    playCallChain: V1PlayCallChainView;
  }>(page, revisionCommands[0]!);
  expect(replayed.continuation).toBe("continue_context");
  expect(replayed.playCallChain.parentHead).toBe(currentHead);
  expect(await readHead()).toBe(currentHead);
  expect(providerRequests).toHaveLength(4);
  expect(providerRequests[3]).toBe(providerRequests[2]);
  expect(currentHead).not.toBe(interruptedHead);
  await expect(
    revisedTimeline.getByText(currentEdit, { exact: true }),
  ).toHaveCount(1);

  await page.setViewportSize({ width: 375, height: 812 });
  const freshEdit = "Then let's meet fifteen minutes early.";
  await openEdit(currentEdit, freshEdit);
  const freshLabel = t("用新对话继续", "Continue in a new conversation");
  await options.click();
  await expect(
    editor.getByRole("radio", {
      name: new RegExp(t("^自动选择", "^Choose automatically"), "u"),
    }),
  ).toBeChecked();
  await editor
    .getByRole("radio", { name: new RegExp(`^${freshLabel}`, "u") })
    .check();
  const freshReply = "Alex agrees to wait downstairs at seven forty-five.";
  responses.push(freshReply);
  await editor
    .getByRole("button", {
      name: t(
        "保存修改并用新对话继续",
        "Save edit and continue in a new conversation",
      ),
      exact: true,
    })
    .click();

  await expectReply(
    revisedTimeline.getByText(freshReply, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(separators).toHaveCount(2);
  await expect(revisedTimeline).not.toContainText(currentEdit);
  await expect(revisedTimeline).not.toContainText(currentReply);
  await expect(
    revisedTimeline.getByText(freshEdit, { exact: true }),
  ).toHaveCount(1);
  await expect(revisedTimeline).toContainText(originalReply);
  const afterRevision = (await workspace()).worlds;
  expect(afterRevision).toHaveLength(worldsBefore + 1);
  expect(afterRevision).toContainEqual(
    expect.objectContaining({ worldId: created.world.worldId }),
  );
  const copiedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: "I ask Alex when we are meeting." });
  await expect(
    copiedPlayer.getByRole("button", { name: edit, exact: true }),
  ).toBeVisible();
  await expect(
    copiedPlayer.getByRole("button", { name: fork, exact: true }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(5);
  expect(providerRequests.at(-1)).toContain(freshEdit);
  expect(providerRequests.at(-1)).not.toContain(originalAction);
  expect(messages()).not.toContainEqual(
    expect.objectContaining(priorAssistantMessage),
  );

  expect(revisionCommands.at(-1)?.continuation).toBe("fresh_context");
  expect(await readHead()).not.toBe(currentHead);

  const revisedPlayer = page
    .locator(".call-chain-player")
    .filter({ hasText: freshEdit });
  await revisedPlayer.getByRole("button", { name: fork, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${title} (fork)`, exact: true }),
  ).toBeVisible();
  await expect(revisedTimeline).toContainText(freshEdit);
  await expect(revisedTimeline).not.toContainText(originalAction);
  const afterFork = (await workspace()).worlds;
  expect(afterFork).toHaveLength(worldsBefore + 2);
  expect(afterFork).toContainEqual(
    expect.objectContaining({ worldId: created.world.worldId }),
  );

  await page
    .getByRole("button", { name: t("返回工作区", "Back to workspace") })
    .click();
  await page.getByRole("button", { name: openWorld, exact: true }).click();
  await expect(revisedTimeline).toContainText(freshEdit);
  await expect(revisedTimeline).not.toContainText(originalAction);
}

test("故事模式开关持久化，最新检查点自动预选且取消后只由新检查点重选", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Checkpoint fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "checkpoint-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: package_.localId,
    name: "Checkpoint world",
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    baseTreeRevision: (
      await runtime<{ treeRevision: string }>(page, {
        type: "content.read",
        packageId: package_.localId,
      })
    ).treeRevision,
    files: contentFiles(),
  });
  await runtime(page, {
    type: "world.create",
    operationId: "checkpoint-ui-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "checkpoint-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "打开世界：Checkpoint world", exact: true })
    .click();
  responses.push({ checkpoint: true }, "Alex 把整理好的书放回架上。");
  await page.getByLabel("你的行动").fill("整理这段事情。");
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  await expect(page.getByText("Alex 把整理好的书放回架上。")).toBeVisible({
    timeout: 20_000,
  });
  const story = page.getByLabel("故事时间线");
  await expect(page.locator(".world-reader-page")).toHaveClass(
    /is-story-mode/u,
  );
  await expect(story.locator(".world-timeline-trace")).toHaveCount(0);
  await expect(story.locator(".play-checkpoint-marker")).toHaveCount(0);
  await expect(story.getByRole("separator")).toHaveText("");
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".play-checkpoint-note")).toHaveCount(0);
  await expect(page.locator(".world-feedback.status")).toHaveCount(0);
  const player = story
    .locator(".call-chain-player")
    .filter({ hasText: "整理这段事情。" });
  await page.mouse.move(0, 0);
  await expect(player.getByRole("button", { name: "修改" })).toHaveCSS(
    "opacity",
    "0",
  );
  await player.locator("article").hover();
  await expect(player.getByRole("button", { name: "修改" })).toHaveCSS(
    "opacity",
    "1",
  );
  await page.mouse.move(0, 0);
  await player.getByRole("button", { name: "修改" }).focus();
  await expect(player.getByRole("button", { name: "修改" })).toHaveCSS(
    "opacity",
    "1",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("你的行动").focus();
  await expect(player.getByRole("button", { name: "修改" })).toHaveCSS(
    "opacity",
    "1",
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "阅读设置" }).click();
  const toggle = page.getByRole("checkbox", { name: "显示技术信息" });
  await expect(toggle).not.toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "preferences.save",
  );
  await toggle.check();
  expect((await saved).ok()).toBe(true);
  await expect(story.getByText("本段调用详情", { exact: true })).toHaveCount(1);
  await expect(story.locator(".play-checkpoint-marker")).toHaveText("检查点");
  await expect(
    story.getByRole("button", { name: "下一条消息使用全新上下文" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/#\/world\//u);
  await expect(page.locator(".world-reader-page")).toHaveClass(
    /is-detailed-mode/u,
  );
  await page.getByRole("button", { name: "阅读设置" }).click();
  await expect(
    page.getByRole("checkbox", { name: "显示技术信息" }),
  ).toBeChecked();
  await page
    .getByLabel("阅读设置")
    .getByRole("button", { name: "关闭" })
    .click();
  const count = providerRequests.length;

  await expect(
    page.getByRole("button", { name: "从全新上下文发送行动", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("你的行动").press("Enter");
  await page.getByLabel("更多", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "接着当前对话继续", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "用新对话继续（保留故事进度）",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(providerRequests).toHaveLength(count);
  await page.getByLabel("你的行动").fill("保留这份行动草稿。");
  await page
    .getByRole("button", { name: "取消全新上下文", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "追加行动", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("你的行动")).toHaveValue("保留这份行动草稿。");
  await expect(
    page.getByText("世界已在当前上下文之外更新；下一次行动会从新上下文开始。"),
  ).toHaveCount(0);
  expect(providerRequests).toHaveLength(count);
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page
    .getByRole("button", { name: "打开世界：Checkpoint world", exact: true })
    .click();
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "继续故事", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page).toHaveURL(/#\/world\//u);
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "继续故事", exact: true }),
  ).toBeEnabled();
  expect(providerRequests).toHaveLength(count);
  await page.getByLabel("你的行动").fill("保留这份行动草稿。");
  responses.push("Alex 点头，继续刚才的话题。");
  const appendStream = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "play.chain.append",
  );
  await page.getByLabel("你的行动").press("Enter");
  await expect(page.getByText("Alex 点头，继续刚才的话题。")).toBeVisible({
    timeout: 20_000,
  });
  expect(await (await appendStream).finished()).toBeNull();
  const appended = JSON.parse(providerRequests.at(-1)!) as {
    messages: { role: string; content: unknown }[];
  };
  expect(appended.messages.some(({ role }) => role === "tool")).toBe(true);
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toHaveCount(0);
  responses.push({ checkpoint: true }, "新一段整理完成。");
  await page.getByLabel("你的行动").fill("再整理一段。");
  await page.getByRole("button", { name: "追加行动", exact: true }).click();
  await expect(page.getByText("新一段整理完成。", { exact: true })).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toBeVisible();
  await expect(story.locator(".play-checkpoint-marker")).toHaveCount(2);
  responses.push("你们走进走廊。");
  const finalStream = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "play.chain.start",
  );
  await page.getByLabel("你的行动").fill("走进走廊。");
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  await expect(page.getByText("你们走进走廊。")).toBeVisible({
    timeout: 20_000,
  });
  // Visible streamed text precedes durable settlement. Finish this request
  // before another suite removes the shared test world's files.
  expect(await (await finalStream).finished()).toBeNull();
  const sent = JSON.parse(providerRequests.at(-1)!) as {
    messages: { role: string; content: unknown; tool_call_id?: string }[];
  };
  expect(JSON.stringify(sent.messages)).not.toContain("距上次检查点已完成");
  expect(sent.messages.filter(({ role }) => role === "tool")).toEqual([
    expect.objectContaining({ tool_call_id: "runtime_initial_world_context" }),
  ]);
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "阅读设置" }).click();
  const savedStory = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "preferences.save",
  );
  await page.getByRole("checkbox", { name: "显示技术信息" }).uncheck();
  expect((await savedStory).ok()).toBe(true);
  await expect(story.locator(".play-checkpoint-marker")).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/#\/world\//u);
  await expect(page.locator(".world-reader-page")).toHaveClass(
    /is-story-mode/u,
  );
  await expect(
    page.getByText("下一条消息将开启全新上下文", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "阅读设置" }).click();
  await expect(
    page.getByRole("checkbox", { name: "显示技术信息" }),
  ).not.toBeChecked();
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await expect(
    page.getByRole("checkbox", { name: "Show technical information" }),
  ).not.toBeChecked();
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
