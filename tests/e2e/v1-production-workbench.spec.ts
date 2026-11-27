import { openWorkspaceCreationTool } from "../support/workspaceNavigation.ts";
import {
  expect as playwrightExpect,
  type Locator,
  type Page,
} from "@playwright/test";
import { test } from "../support/isolatedRuntimeTest.ts";
import { createServer, type Server } from "node:http";

import { createZip } from "../support/createZip.ts";

let provider: Server;
let providerUrl = "";
const disconnectProviderResponse = Symbol("disconnect-provider-response");
const responses: (object | typeof disconnectProviderResponse)[] = [];
const providerRequests: string[] = [];
/** Delay Provider SSE frames so the browser's real increments remain observable. */
let providerDelayMs = 0;

// This scenario repeatedly waits for durable Runtime settlement on disk.
const expect = playwrightExpect.configure({ timeout: 20_000 });
test.setTimeout(180_000);

async function expectCanScrollVertically(locator: Locator): Promise<void> {
  const result = await locator.evaluate((root) => {
    if (!(root instanceof HTMLElement)) return null;
    const initial = root.scrollTop;
    root.scrollTop = root.scrollHeight;
    const result = {
      overflowY: getComputedStyle(root).overflowY,
      scrollTop: root.scrollTop,
      maximum: root.scrollHeight - root.clientHeight,
    };
    root.scrollTop = initial;
    return result;
  });

  expect(result).not.toBeNull();
  expect(["auto", "scroll"]).toContain(result?.overflowY);
  expect(result?.maximum).toBeGreaterThan(0);
  expect(result?.scrollTop).toBe(result?.maximum);
}

test.use({ runtimeScope: "workbench" });

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ id: "backup-model" }, { id: "trace-model" }],
        }),
      );
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push(body);
      const payload = responses.shift();
      if (payload === disconnectProviderResponse) {
        response.destroy();
        return;
      }
      // Every model path returns SSE according to the request's stream flag.
      if (payload !== undefined && body.includes('"stream":true')) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frames = sseFrames(payload);
        if (providerDelayMs === 0) {
          response.end(frames.join(""));
          return;
        }
        // Send frame by frame to simulate an in-progress model response.
        let index = 0;
        const pump = (): void => {
          if (index >= frames.length) {
            response.end();
            return;
          }
          response.write(frames[index]);
          index += 1;
          setTimeout(pump, providerDelayMs);
        };
        pump();
        return;
      }
      const send = (): void => {
        response.writeHead(payload === undefined ? 500 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(payload ?? { error: "unexpected request" }),
        );
      };
      if (providerDelayMs > 0) setTimeout(send, providerDelayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("The simulated Provider did not receive a port");
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

test("四任务工作台以文件原生内容创建世界并展示真实 Prompt Preview", async ({
  page,
}) => {
  const observationKinds = new Set<string>();
  const pollingRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/runtime/v1/events?"))
      observationKinds.add(new URL(request.url()).searchParams.get("kind")!);
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/runtime/v1")
    ) {
      const type = (request.postDataJSON() as { request?: { type?: string } })
        .request?.type;
      if (
        type === "setting-improvement.status" ||
        type === "world.revision.status" ||
        type === "play.chain.inspect"
      )
        pollingRequests.push(type);
    }
  });
  const damagedPath = "world/characters/damaged.yaml";
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await expect(page.getByRole("heading", { name: "世界工作区" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("界面语言")).toHaveValue("zh-CN");
  for (const name of ["我的世界", "内容库", "模型设置", "创作工具"])
    await expect(
      page
        .getByRole("navigation", { name: "工作区导航" })
        .getByRole("button", { name, exact: true }),
    ).toBeVisible();

  await page.getByText("导入内容包 ZIP", { exact: true }).click();
  await page.getByLabel("内容包 ZIP 文件").setInputFiles({
    name: "dormitory-world.zip",
    mimeType: "application/zip",
    buffer: createZip(files()),
  });
  await expect(page.getByText(/dormitory-world\.zip/u)).toBeVisible();
  await page.getByRole("button", { name: "导入 ZIP" }).click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    "已将内容包导入为独立副本",
  );
  await expect(
    page.getByRole("heading", { name: /dormitory-world · AI 设定完善/u }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "手动编辑" })).toHaveCount(0);
  await page.getByRole("button", { name: "返回工作区" }).click();

  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByLabel("Base URL").fill(providerUrl);
  await page.getByLabel("API Key").fill("test-secret");
  await page.getByRole("button", { name: "从端点拉取模型" }).click();
  await expect(
    page.locator(".workspace-feedback").getByRole("status"),
  ).toContainText("已从当前端点拉取 2 个模型");
  const fetchedModels = page.getByRole("combobox", { name: "已拉取的模型" });
  await expect(fetchedModels.locator("option")).toHaveCount(3);
  await fetchedModels.selectOption("trace-model");
  await expect(page.getByLabel("模型 ID")).toHaveValue("trace-model");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await expect(
    page.locator(".workspace-feedback").getByRole("status"),
  ).toContainText("模型连接已保存");
  await page.getByRole("button", { name: "新建另一份" }).click();
  await page.getByLabel("配置名称").fill("备用模型");
  await page.getByLabel("Base URL").fill(providerUrl);
  await page.getByLabel("API Key").fill("backup-secret");
  await page.getByLabel("模型 ID").fill("backup-model");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await expect(page.locator(".config-card")).toHaveCount(2);
  const backupModel = page
    .locator(".config-card")
    .filter({ hasText: "备用模型" });
  await backupModel.getByRole("button", { name: "克隆配置" }).click();
  await expect(page.locator(".config-card")).toHaveCount(3);
  await expect(
    page.locator(".workspace-feedback").getByRole("status"),
  ).toContainText("副本保留本机凭据，但不会切换当前配置");
  await expect(page.locator(".model-active-summary")).toContainText("备用模型");
  await expect(page.getByLabel("配置名称")).toHaveValue("备用模型（副本）");
  await expect(page.getByLabel("API Key")).toHaveValue("");
  await page.getByText("高级协议选项", { exact: true }).click();
  await page.getByLabel("协议适配器").selectOption("openai_responses");
  await page.getByLabel("Base URL").fill(`${providerUrl}/alternate`);
  await expect(page.getByLabel("API Key")).not.toHaveAttribute("required", "");
  await page.getByRole("button", { name: "从端点拉取模型" }).click();
  await expect(
    page.locator(".workspace-feedback").getByRole("status"),
  ).toContainText("已从当前端点拉取 2 个模型");
  await page.getByLabel("模型 ID").fill("backup-model-copy");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await expect(
    page.locator(".workspace-feedback").getByRole("status"),
  ).toContainText("模型连接已保存");
  await expect(page.locator(".model-active-summary")).toContainText(
    "备用模型（副本）",
  );
  const firstModel = page
    .locator(".config-card")
    .filter({ hasText: "默认模型" });
  await firstModel.getByRole("button", { name: "切换到此配置" }).click();
  await expect(page.locator(".model-active-summary")).toContainText("默认模型");
  await page.getByRole("button", { name: "返回工作区" }).click();

  await openWorkspaceCreationTool(page);
  await expect(
    page.getByRole("combobox", { name: "切换编排方案", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "提示词顺序" })).toBeVisible();
  await expect(page.getByLabel("编排方案编辑器")).toContainText(
    "完整内容包提示",
  );
  await expect(page.getByLabel("编排方案编辑器")).toContainText("回复完成后");
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page.getByLabel("提示词名称", { exact: true }).fill("Before world");
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("ORDERED_BEFORE_WORLD");
  await page.getByRole("button", { name: "上移", exact: true }).click();
  await page
    .getByRole("button", { name: "完整内容包提示", exact: true })
    .click();
  await expect(page.getByLabel("提示词正文", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page.getByLabel("提示词名称", { exact: true }).fill("After world");
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("ORDERED_AFTER_WORLD");
  const mechanics = page.getByRole("button", {
    name: "工具与响应结算（必选）",
    exact: true,
  });
  await mechanics.click();
  await expect(page.getByLabel("启用", { exact: true })).toBeDisabled();
  const promptCount = await page
    .getByRole("list", { name: "提示词顺序" })
    .getByRole("button")
    .count();
  for (let i = 0; i < promptCount; i++) await mechanics.press("Alt+ArrowDown");
  const promptOrder = page.getByRole("list", { name: "提示词顺序" });
  await mechanics.press("Alt+ArrowUp");
  const keyboardOrder = await promptOrder.getByRole("button").allTextContents();
  await mechanics.press("Alt+ArrowDown");
  await promptOrder
    .getByRole("listitem")
    .last()
    .dragTo(promptOrder.getByRole("listitem").nth(promptCount - 2));
  await expect(promptOrder.getByRole("button")).toHaveText(keyboardOrder);
  await mechanics.press("Alt+ArrowDown");
  await page.getByRole("tab", { name: /设定完善/u }).click();
  await expect(page.getByLabel("设定完善提示词编排")).toBeVisible();
  await expect(
    page
      .getByLabel("设定完善提示词编排")
      .getByText("后置请求", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page.getByLabel("提示词名称", { exact: true }).fill("Author rule");
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("ORDERED_AUTHOR_RULE");
  await page
    .getByRole("button", { name: "Author rule", exact: true })
    .press("Alt+ArrowUp");
  await page.getByRole("tab", { name: /^游玩/u }).click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("button", { name: "应用为当前编排方案", exact: true })
    .click();
  await page.reload();
  await openWorkspaceCreationTool(page);
  await page.getByRole("button", { name: "Before world", exact: true }).click();
  await expect(page.getByLabel("提示词正文", { exact: true })).toHaveValue(
    "ORDERED_BEFORE_WORLD",
  );

  await page.getByRole("button", { name: "返回工作区" }).click();

  await page.getByRole("button", { name: "新建内容包" }).click();
  await page
    .getByRole("dialog", { name: "新建内容包" })
    .getByRole("button", { name: "创建", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "内容包当前树" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "内容包文件", exact: true }),
  ).toBeVisible();
  for (const file of [
    ...files(),
    { path: damagedPath, contents: "not: [valid\n" },
  ]) {
    const fileButton = page.getByRole("button", {
      name: `打开 ${file.path}`,
      exact: true,
    });
    if ((await fileButton.count()) === 0) {
      const newPath = page.getByLabel("新文件路径");
      if (!(await newPath.isVisible()))
        await page.getByText("新建文件", { exact: true }).click();
      await newPath.fill(file.path);
      await page.getByRole("button", { name: "加入草稿" }).click();
    } else {
      await fileButton.click();
    }
    if (file.path === "control/frame.yaml") {
      await page.getByText("源码视图（frame.yaml）", { exact: true }).click();
      await page.getByLabel("直接编辑 control/frame.yaml").fill(file.contents);
    } else {
      if (file.path === "control/player-views.yaml") {
        await page.getByRole("button", { name: "源码", exact: true }).click();
      }
      await page.getByLabel(`编辑 ${file.path}`).fill(file.contents);
    }
  }
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeEnabled();
  await page.getByRole("button", { name: "整批保存" }).click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    "已整批保存",
  );
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeEnabled();
  const packageActions = page.locator(".content-package-actions");
  await packageActions.locator("summary").click();
  await packageActions
    .getByLabel("内容包标题")
    .fill("Dormitory Content Package");
  await packageActions.getByRole("button", { name: "重命名" }).click();
  await expect(
    page.getByRole("heading", { name: /Dormitory Content Package/u }),
  ).toBeVisible();
  await page
    .getByRole("complementary", { name: "内容包文件编辑" })
    .getByRole("button", { name: "预览", exact: true })
    .click();
  const contentPreview = page.getByRole("complementary", {
    name: "内容包文件预览",
  });
  await expect(contentPreview).toContainText(damagedPath);
  await expect(contentPreview).toContainText("not: [valid");

  responses.push(
    chatTools(
      [
        tool("setting_read", { path: damagedPath }),
        tool("setting_write_file", {
          path: damagedPath,
          ref: "damaged",
          title: "Damaged Character",
          summary: "Character document repaired in the current tree.",
          aliases: [],
          contents: "status: repaired\n",
        }),
      ],
      null,
      "Read the damaged document before repairing the current tree.",
    ),
    chatText("The damaged character document is repaired in the current tree."),
  );
  await page.getByRole("button", { name: "收起文件面板" }).click();
  await page
    .getByLabel("用全新上下文给 AI 发消息")
    .fill("Repair the damaged character document.");
  const firstComposer = page.getByLabel("用全新上下文给 AI 发消息");
  await firstComposer.press("Shift+Enter");
  await expect(firstComposer).toHaveValue(
    "Repair the damaged character document.\n",
  );
  await firstComposer.fill("Repair the damaged character document.");
  await firstComposer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await expect(firstComposer).toHaveValue(
    "Repair the damaged character document.",
  );
  await firstComposer.press("Enter");
  await expect(page.locator(".setting-conversation-assistant")).toContainText(
    "damaged character document is repaired",
  );
  expect(providerRequests.at(-1)).toContain("ORDERED_AUTHOR_RULE");
  await page.locator(".setting-request-previews > summary").click();
  await expect(page.locator(".setting-request-previews")).toContainText(
    "不是下一次发送预览",
  );
  const repairedTurn = page.locator(".setting-conversation-turn").last();
  const repairedTrace = repairedTurn.locator(".model-call-details");
  await expect(repairedTrace).not.toHaveAttribute("open", "");
  await repairedTrace.locator(":scope > summary").click();
  const repairedExchange = repairedTrace.locator(".model-call").first();
  const repairedReasoning = repairedExchange
    .getByText("模型推理", { exact: true })
    .locator("xpath=ancestor::details[1]");
  await expect(repairedReasoning).not.toHaveAttribute("open", "");
  await repairedReasoning.locator("summary").click();
  await expect(repairedReasoning).toContainText(
    "Read the damaged document before repairing",
  );
  const settingRead = repairedTurn
    .locator(".setting-exchange-tool")
    .filter({ hasText: "setting_read" });
  await expect(settingRead).toContainText("拒绝／失败");
  await settingRead.locator("xpath=ancestor::details[1]/summary").click();
  await settingRead.locator("summary").click();
  await expect(settingRead).toContainText(damagedPath);
  const settingWrite = repairedTurn
    .locator(".setting-exchange-tool")
    .filter({ hasText: "setting_write_file" })
    .filter({ hasText: damagedPath });
  const writeTools = settingWrite.locator("xpath=ancestor::details[1]");
  if ((await writeTools.getAttribute("open")) === null)
    await writeTools.locator(":scope > summary").click();
  await expect(settingWrite).toContainText("已修改内容包");
  await settingWrite.locator(":scope > summary").click();
  const repairedDiff = settingWrite.locator(".setting-change-diff");
  await expect(repairedDiff).not.toHaveAttribute("open", "");
  await repairedDiff.locator("summary").click();
  await expect(repairedDiff.locator(".unified-diff-remove")).toContainText(
    "not: [valid",
  );
  await expect(
    repairedDiff.locator(".unified-diff-add").filter({
      hasText: "status: repaired",
    }),
  ).toBeVisible();
  await expect(page.locator(".setting-current-tree-notice")).toContainText(
    "已经生效",
  );
  await page.getByRole("button", { name: "全部收起" }).click();
  await expect(repairedTrace).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "历史" }).click();
  const settingHistory = page.locator(".setting-conversation-history");
  const repairedHistory = settingHistory
    .locator("button")
    .filter({ hasText: "Repair the damaged character document." });
  await expect(repairedHistory).toContainText("当前所选");
  await page.getByRole("button", { name: "收起对话历史" }).click();
  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(page.getByText("下一条消息将开启全新上下文")).toBeVisible();

  responses.push(
    chatText(
      plan(),
      "Compare the requested experience before proposing the authoring plan.",
    ),
    chatTools([
      tool("setting_read", { path: "world/current-situation.yaml" }),
      tool("setting_read", { path: "world/characters/alex.yaml" }),
      tool("setting_read", { path: "opening.md" }),
      tool("setting_read", { path: "control/blocks/world.md" }),
      tool("setting_create", {
        path: "world/notes/training.yaml",
        ref: "training",
        title: "Tonight's Training",
        summary: "Alex's training plans for tonight.",
        aliases: [],
        body: "location: Campus basketball court\n",
      }),
      tool("setting_patch", {
        document: "@training",
        op: "add",
        locator: ["time"],
        value: "8:00 p.m.",
      }),
      tool("setting_move", {
        from: "@training",
        to: "world/events/training.yaml",
      }),
      tool("setting_patch", {
        document: "@alex",
        op: "replace",
        locator: ["clothes"],
        value: "Dark blue athletic tank top",
      }),
      tool("setting_write_file", {
        path: "world/current-situation.yaml",
        contents:
          "situation: Alex has put away the jersey and is ready to discuss tonight's training.\n",
      }),
      tool("setting_write_file", {
        path: "opening.md",
        contents:
          "The dormitory door closes behind you. Alex, wearing a dark blue athletic tank top, waits to discuss tonight's training.\n",
      }),
      tool("setting_write_file", {
        path: "control/blocks/world.md",
        contents:
          "# World Narration Rules\n\nWrite persistent outcomes back to their natural owner; advance training plans according to character choices.\n",
      }),
    ]),
    chatText(
      "The agreed changes are live in the current tree and pass the automatic review.",
    ),
  );
  await page
    .getByLabel("用全新上下文给 AI 发消息")
    .fill("先讨论一个保留宿舍体验的修改计划，暂时不要改文件。");
  providerDelayMs = 1200;
  await page.getByRole("button", { name: "发送" }).click();
  const freshRunProgress = page.locator(".setting-conversation-running");
  await expect(freshRunProgress).toContainText("AI 正在处理");
  await expect(freshRunProgress).toContainText(/已接收 \d+ 字/u);
  const freshLiveTrace = page
    .locator(".setting-conversation-turn")
    .last()
    .locator(".model-call-details");
  await expect(freshLiveTrace).not.toHaveAttribute("open", "");
  await freshLiveTrace.locator(":scope > summary").click();
  const freshLiveReasoning = freshLiveTrace
    .locator(".model-call")
    .first()
    .locator("details")
    .filter({ has: page.getByText("模型推理", { exact: true }) });
  await freshLiveReasoning.locator("summary").click();
  await expect(freshLiveReasoning).toContainText(
    "Compare the requested experience",
  );
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  providerDelayMs = 0;
  await expect(page.locator(".setting-conversation-assistant")).toContainText(
    "创作计划",
  );
  const planningRequest = providerRequest();
  expect(JSON.stringify(planningRequest)).toContain("暂时不要改文件");
  expect(JSON.stringify(planningRequest)).toContain(
    "Dormitory Content Package",
  );
  expect(JSON.stringify(planningRequest)).toContain("Runtime 预载说明");
  expect(JSON.stringify(planningRequest)).toContain(
    "Alex is organizing a jersey",
  );
  expect(toolNames(planningRequest)).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_create",
    "setting_write_file",
    "setting_patch",
    "setting_move",
    "setting_delete",
    "setting_suggest_title",
  ]);
  await page
    .getByLabel("继续这段对话")
    .fill("按刚才讨论的方向直接更新当前内容树。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(
    page.locator(".setting-conversation-assistant").last(),
  ).toContainText("pass the automatic review");
  const authoredTurn = page.locator(".setting-conversation-turn").last();
  await authoredTurn.locator(".model-call-details > summary").click();
  const acceptedChanges = page.locator(".setting-accepted-changes");
  await expect(
    acceptedChanges.filter({ hasText: "world/events/training.yaml" }),
  ).toHaveCount(1);
  await expect(acceptedChanges.filter({ hasText: "opening.md" })).toHaveCount(
    1,
  );
  await expect(
    acceptedChanges.filter({ hasText: "control/blocks/world.md" }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".setting-exchange-tool")
      .filter({ hasText: /当前树自动检查通过|Current-tree review passed/u }),
  ).toHaveCount(1);
  await expect(page.locator(".setting-current-tree-notice")).toContainText(
    "已经生效",
  );

  const worldRuleWrite = authoredTurn
    .locator(".setting-exchange-tool")
    .filter({ hasText: "setting_write_file" })
    .filter({ hasText: "control/blocks/world.md" });
  await worldRuleWrite.locator("xpath=ancestor::details[1]/summary").click();
  await worldRuleWrite.locator(":scope > summary").click();
  const worldRuleDiff = worldRuleWrite.locator(".setting-change-diff");
  await worldRuleDiff.locator(":scope > summary").click();
  await worldRuleDiff.getByRole("button", { name: "回滚这个文件" }).click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    "已回滚这个文件；对话历史仍然保留",
  );
  await expect(worldRuleWrite).toContainText("当前文件已是修改前版本");
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "文件", exact: true })
    .click();
  const rolledBackPreview = page.getByRole("complementary", {
    name: "内容包文件预览",
  });
  await rolledBackPreview
    .getByRole("navigation", { name: "内容包文件树" })
    .getByRole("button", { name: "control/blocks/world.md" })
    .click();
  await expect(rolledBackPreview).toContainText(
    "Write persistent outcomes back to their natural owner.",
  );
  await expect(rolledBackPreview).not.toContainText(
    "advance training plans according to character choices",
  );
  await page.getByRole("button", { name: "收起文件面板" }).click();

  responses.push(
    chatTools(
      [
        tool("setting_read", { path: "control/frame.yaml" }),
        tool("setting_write_file", {
          path: "control/frame.yaml",
          contents: "invalid: true\n",
        }),
      ],
      null,
      "Inspect the frame before repairing its bindings.",
    ),
    chatTools([
      tool("setting_write_file", {
        path: "control/frame.yaml",
        contents:
          'format: narraeon.world-frame/v1\nbindings:\n  currentSituation: "@current-situation"\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n',
      }),
    ]),
    chatText("The frame was repaired and the automatic review now passes."),
  );
  await page.getByLabel("继续这段对话").fill("直接检查当前树并修复 frame。");
  providerDelayMs = 1200;
  await page.getByRole("button", { name: "发送" }).click();
  // Progress moves while the ordinary conversation message is active; the
  // counters come from the same durable Runtime session used after refresh.
  const runProgress = page.locator(".setting-conversation-running");
  await expect(runProgress).toContainText("AI 正在处理");
  await expect(runProgress).toContainText(/第 \d+ 次模型交换/u);
  // While the first round is still streaming, the UI shows received characters
  // rather than inactivity. This number can only come from live server increments.
  await expect(runProgress).toContainText(/已接收 \d+ 字/u);
  const frameLiveTrace = page
    .locator(".setting-conversation-turn")
    .last()
    .locator(".model-call-details");
  await expect(frameLiveTrace).not.toHaveAttribute("open", "");
  await frameLiveTrace.locator(":scope > summary").click();
  const frameLiveReasoning = frameLiveTrace
    .locator(".model-call")
    .first()
    .locator("details")
    .filter({ has: page.getByText("模型推理", { exact: true }) });
  await frameLiveReasoning.locator("summary").click();
  await expect(frameLiveReasoning).toContainText("Inspect the frame");
  providerDelayMs = 0;
  await expect(
    page.locator(".setting-conversation-assistant").last(),
  ).toContainText("automatic review now passes");
  await expect(runProgress).toBeHidden();
  const directRequest = providerRequest();
  expect(toolNames(directRequest)).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_create",
    "setting_write_file",
    "setting_patch",
    "setting_move",
    "setting_delete",
    "setting_suggest_title",
  ]);
  const documentScrollRange = await page.evaluate(() => {
    const root = document.scrollingElement;
    return root === null ? -1 : root.scrollHeight - root.clientHeight;
  });
  expect(documentScrollRange).toBeLessThanOrEqual(1);
  await expectCanScrollVertically(
    page.getByRole("region", { name: "设定完善对话", exact: true }),
  );

  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(page.getByText("下一条消息将开启全新上下文")).toBeVisible();
  await page.getByRole("button", { name: "历史" }).click();
  await repairedHistory.click();
  await expect(page.getByText("正在继续历史对话")).toBeVisible();
  await expect(page.getByLabel("继续这段对话")).toBeVisible();

  await page.getByRole("button", { name: "历史" }).click();
  await page
    .getByRole("button", {
      name: "删除对话：Repair the damaged character document.",
    })
    .click();
  await page
    .getByRole("dialog", {
      name: /删除对话“Repair the damaged character document/,
    })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    "内容包当前树没有回滚",
  );
  await expect(
    page.getByRole("button", {
      name: "删除对话：Repair the damaged character document.",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "收起对话历史" }).click();

  await page.getByRole("button", { name: "返回工作区" }).click();
  await openWorkspaceCreationTool(page, "preview");
  await expect(page.getByRole("heading", { name: "提示词预览" })).toBeVisible();
  await expect(page.getByText("0 次模型调用")).toBeVisible();
  await page.getByLabel("预览玩家输入").fill("I observe what Alex is doing.");
  await page.getByRole("button", { name: "生成真实预览" }).click();
  await expect(page.getByRole("heading", { name: "编译通过" })).toBeVisible();
  await expect(page.getByRole("list", { name: "逻辑消息顺序" })).toContainText(
    "runtime_system",
  );
  await expect(page.getByRole("list", { name: "逻辑消息顺序" })).toContainText(
    "world_context",
  );
  await expect(page.locator(".prompt-preview-result")).not.toContainText(
    "schemaId",
  );
  await page.getByRole("button", { name: /材料与工具/u }).click();
  await expect(
    page.getByRole("heading", { name: "材料覆盖与调用链工具" }),
  ).toBeVisible();
  await expect(page.getByText("context_read", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /预算与诊断/u }).click();
  await expect(page.getByText("内部字段泄漏扫描通过")).toBeVisible();

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page
    .locator(".home-world-library")
    .getByRole("button", { name: "新建世界" })
    .click();
  await page.getByRole("button", { name: "从当前内容包创建" }).click();
  await expect(
    page.getByRole("heading", { name: "Dormitory Content Package" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "世界管理" }).click();
  await page.getByLabel("世界显示名称").fill("Night Training Dormitory");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(
    page.locator(".world-reader-page").getByRole("status"),
  ).toContainText("世界名称已保存");
  await expect(
    page.getByRole("heading", { name: "Night Training Dormitory" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "世界管理" })
    .getByRole("button", { name: "关闭" })
    .click();
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByLabel("世界操作：Night Training Dormitory").click();
  await page
    .getByRole("button", { name: "重命名世界：Night Training Dormitory" })
    .click();
  await page.getByRole("textbox", { name: "世界名称" }).fill("Dormitory World");
  await page.getByRole("button", { name: "保存世界名称" }).click();
  await page
    .getByRole("button", { name: "打开世界：Dormitory World", exact: true })
    .click();
  await expect(page.getByLabel("故事时间线")).toContainText(
    "The dormitory door closes behind you. Alex, wearing a dark blue athletic tank top, waits to discuss tonight's training.",
  );
  await expect(page.getByLabel("你的行动")).toBeVisible();
  // This workbench scenario inspects the technical trace throughout.
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("checkbox", { name: "显示技术信息" }).check();
  await page
    .getByLabel("阅读设置")
    .getByRole("button", { name: "关闭" })
    .click();
  for (const mount of [
    "story",
    "sidebar",
    "composer_above",
    "composer_below",
    "overlay",
    "debug",
  ])
    await expect(
      page.locator(`[data-extension-mount="${mount}"]`),
    ).toBeAttached();
  await page.getByRole("button", { name: "此刻" }).click();
  await expect(page.getByLabel("当前情景")).toContainText(
    "Dark blue athletic tank top",
  );
  await page.getByRole("button", { name: "收起状态栏" }).click();
  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "世界", exact: true })
    .click();
  const worldRail = page.getByRole("complementary", { name: "当前世界" });
  await worldRail.getByRole("button", { name: /选择文档/u }).click();
  await expect(
    worldRail.getByRole("option", { name: /current-situation\.yaml/u }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收起世界栏" }).click();

  const worldPatch = tool("world_patch", {
    target: "@current-situation",
    edits: [
      {
        op: "replace",
        locator: { yaml: ["situation"] },
        value:
          "Alex has put away the jersey and is waiting for you to confirm the training plan.",
      },
    ],
  });
  responses.push(
    chatTools(
      [worldPatch],
      "I will update the record before narrating the result.",
    ),
    chatText(
      "Alex nods and continues folding the jersey.",
      "First verify the character's current location and the player's action.",
    ),
  );
  providerDelayMs = 200;
  await page
    .getByLabel("你的行动")
    .fill("I ask Alex whether we are training tonight.");
  await page.getByLabel("你的行动").press("Shift+Enter");
  await expect(page.getByLabel("你的行动")).toHaveValue(
    "I ask Alex whether we are training tonight.\n",
  );
  await page.getByLabel("你的行动").press("Enter");
  const callChain = page.getByLabel("模型调用链");
  await expect(callChain).toContainText("模型响应中");
  const transcript = page.getByLabel("世界游玩");
  const scrollRange = await transcript.evaluate((element) => {
    element.scrollTop = 0;
    return element.scrollHeight - element.clientHeight;
  });
  expect(scrollRange).toBeGreaterThan(0);
  await expect(
    callChain.locator(".call-chain-assistant.is-streaming", {
      hasText: "Alex nods",
    }),
  ).toBeVisible();
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
  providerDelayMs = 0;
  await expect(
    page.getByText("Alex nods and continues folding the jersey."),
  ).toBeVisible();
  const orderedPlayRequest = providerRequests.find(
    (body) =>
      body.includes("ORDERED_BEFORE_WORLD") &&
      body.includes("I ask Alex whether we are training tonight."),
  );
  if (orderedPlayRequest === undefined)
    throw new Error("Expected the first play request with the ordered prompts");
  const stoppingHeading = "# 停笔：一拍停";
  const stoppingMessages = providerRequest(orderedPlayRequest).messages?.filter(
    ({ content }) => content?.startsWith(stoppingHeading),
  );
  expect(stoppingMessages).toHaveLength(1);
  expect(stoppingMessages?.[0]?.role).toBe("system");
  expect(stoppingMessages?.[0]?.content).toContain(
    "有分量的沉默、独处、休息和等待同样适合停笔",
  );
  const orderedTokens = [
    "ORDERED_BEFORE_WORLD",
    stoppingHeading,
    "# World Narration Rules",
    "ORDERED_AFTER_WORLD",
    "# 工具与响应结算",
    "I ask Alex whether we are training tonight.",
  ];
  for (let i = 1; i < orderedTokens.length; i++)
    expect(orderedPlayRequest.indexOf(orderedTokens[i]!)).toBeGreaterThan(
      orderedPlayRequest.indexOf(orderedTokens[i - 1]!),
    );
  await callChain.getByText("本段调用详情", { exact: true }).click();
  const toolStep = callChain.locator(".model-call").first();
  await expect(
    toolStep.getByText("I will update the record before narrating the result."),
  ).not.toBeVisible();
  await toolStep.getByText("工具调用 · 1 次").click();
  await expect(
    toolStep.getByText("I will update the record before narrating the result."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The dormitory door closes behind you. Alex, wearing a dark blue athletic tank top, waits to discuss tonight's training.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "全新上下文从这里开始" }),
  ).toBeVisible();
  await expect(
    callChain.getByText(
      "First verify the character's current location and the player's action.",
    ),
  ).toHaveCount(0);
  const reasoning = callChain
    .getByText("模型推理", { exact: true })
    .filter({ visible: true })
    .last()
    .locator("xpath=ancestor::details[1]");
  await expect(reasoning).not.toHaveAttribute("open", "");
  await reasoning.locator("summary").click();
  await expect(reasoning).toContainText(
    "First verify the character's current location and the player's action.",
  );
  const writeReceipt = "@current-situation 写入成功";
  await expect(callChain).toContainText("调用 world_patch");
  await expect(callChain).not.toContainText(writeReceipt);
  const toolCall = callChain
    .getByText("调用 world_patch")
    .locator("xpath=ancestor::details[1]");
  await expect(toolCall).not.toHaveAttribute("open", "");
  await toolCall.locator("summary").click();
  await expect(toolCall).toContainText(writeReceipt);
  const firstPlayRequest = providerRequest();
  expect(firstPlayRequest.messages).toContainEqual({
    role: "tool",
    tool_call_id: worldPatch.id,
    content: writeReceipt,
  });
  expect(JSON.stringify(firstPlayRequest)).toContain(
    "The dormitory door closes behind you. Alex, wearing a dark blue athletic tank top, waits to discuss tonight's training.",
  );
  expect(JSON.stringify(firstPlayRequest)).toContain("玩家已经读过的开场白");
  expect(JSON.stringify(firstPlayRequest)).not.toContain(
    "本次没有可注入的非开场白原文",
  );

  responses.push(
    chatText(
      "Alex saves the training time on the phone.",
      "This is a fresh model context.",
    ),
  );
  await page.getByLabel("你的行动").fill("I ask Alex to write down the time.");
  await page.getByLabel("更多").click();
  await page
    .getByRole("button", { name: "用新对话继续（保留故事进度）", exact: true })
    .click();
  await expect(
    page.getByText("Alex saves the training time on the phone."),
  ).toBeVisible();
  const contextsAfterFresh = page.getByLabel("模型调用链");
  await expect(contextsAfterFresh).toHaveCount(1);
  await expect(contextsAfterFresh).toContainText(
    "First verify the character's current location and the player's action.",
  );
  await expect(contextsAfterFresh).toContainText("调用 world_patch");
  await expect(contextsAfterFresh.locator(".model-call")).toHaveCount(3);
  await expect(
    contextsAfterFresh.getByText("本段调用详情", { exact: true }),
  ).toHaveCount(2);
  await contextsAfterFresh
    .getByText("本段调用详情", { exact: true })
    .last()
    .click();
  await contextsAfterFresh
    .locator(".model-call")
    .last()
    .getByText("模型推理", { exact: true })
    .click();
  await expect(contextsAfterFresh).toContainText(
    "This is a fresh model context.",
  );
  await expect(
    page.getByRole("separator", { name: "全新上下文从这里开始" }),
  ).toHaveCount(2);
  const freshRequest = providerRequest();
  expect(
    freshRequest.messages?.filter(({ role }) => role === "assistant"),
  ).toEqual([
    expect.objectContaining({
      tool_calls: [
        expect.objectContaining({ id: "runtime_initial_world_context" }),
      ],
    }),
  ]);
  expect(freshRequest.messages?.filter(({ role }) => role === "tool")).toEqual([
    expect.objectContaining({ tool_call_id: "runtime_initial_world_context" }),
  ]);

  await page.getByRole("button", { name: "返回工作区" }).click();
  await openWorkspaceCreationTool(page);
  await page.getByRole("button", { name: "Before world", exact: true }).click();
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("LIVE_NEXT_SEND_RULE");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("button", { name: "应用为当前编排方案", exact: true })
    .click();
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page
    .getByRole("button", { name: "打开世界：Dormitory World", exact: true })
    .click();
  await expect(
    page.getByText(
      "正常发送和空输入续写使用最新编排方案；本轮工具执行期间保持不变。",
      { exact: true },
    ),
  ).toBeVisible();
  responses.push(chatText("We are heading to the court at eight."));
  await page.getByLabel("你的行动").fill("What time are we leaving?");
  await page.getByRole("button", { name: "追加行动" }).click();
  await expect(
    page.getByText("We are heading to the court at eight."),
  ).toBeVisible();

  const liveRequest = providerRequest();
  expect(JSON.stringify(liveRequest)).toContain("LIVE_NEXT_SEND_RULE");
  expect(JSON.stringify(liveRequest)).not.toContain("ORDERED_BEFORE_WORLD");
  expect(
    liveRequest.messages?.filter(({ role }) => role === "assistant"),
  ).toEqual([
    expect.objectContaining({
      tool_calls: [
        expect.objectContaining({ id: "runtime_initial_world_context" }),
      ],
    }),
    expect.objectContaining({
      content: "Alex saves the training time on the phone.",
    }),
  ]);
  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "AI 读取", exact: true })
    .click();
  await expect(
    page.getByText("最近一次请求材料", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "AI 读取", exact: true })
    .click();

  responses.push(
    chatText(
      "This response must not become story after cancellation.",
      "The Provider has started returning explicit reasoning.",
    ),
  );
  providerDelayMs = 3000;
  const cancellableRequestIndex = providerRequests.length;
  await page.getByLabel("你的行动").fill("I ask Alex to pause for a moment.");
  await page.getByRole("button", { name: "追加行动" }).click();
  const playProgress = page.getByLabel("本次模型调用进度");
  await expect(playProgress).toBeVisible();
  await expect(playProgress).toContainText(
    "思考中（正在接收 Provider 返回推理）",
  );
  await callChain.getByText("本段调用详情", { exact: true }).last().click();
  await callChain
    .locator(".model-call")
    .last()
    .getByText("模型推理", { exact: true })
    .click();
  await expect(
    page.getByText("The Provider has started returning explicit reasoning.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(cancellableRequestIndex + 1);
  await expect(playProgress).toContainText("Provider 派发");
  await expect(
    playProgress.getByRole("button", { name: "取消生成" }),
  ).toBeEnabled();
  await playProgress.getByRole("button", { name: "取消生成" }).click();
  providerDelayMs = 0;
  await expect(page.locator(".world-feedback.status")).toContainText(
    "模型生成已取消",
  );
  await expect(playProgress).toBeHidden();
  await expect(page.getByText("生成已取消", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This response must not become story after cancellation."),
  ).toHaveCount(0);
  await expect(
    page.getByText("I ask Alex to pause for a moment.", { exact: true }),
  ).toHaveCount(1);

  responses.push(chatText("Alex waits and lets the moment pass."));
  await page
    .getByLabel("你的行动")
    .fill("Start again after the pause and continue from here.");
  await page.getByLabel("更多").click();
  await page
    .getByRole("button", { name: "用新对话继续（保留故事进度）", exact: true })
    .click();
  await expect(
    page.getByText("Alex waits and lets the moment pass."),
  ).toBeVisible();

  responses.push(
    disconnectProviderResponse,
    chatText("Alex adds that everyone will meet downstairs at 7:30."),
  );
  await page.getByLabel("你的行动").fill("Where should we meet beforehand?");
  const interruptedRequestIndex = providerRequests.length;
  await page.getByRole("button", { name: "追加行动" }).click();
  const resendInterrupted = page.getByRole("button", {
    name: "重新发送",
    exact: true,
  });
  await expect(resendInterrupted).toBeEnabled();
  await expect(
    page.getByText("Where should we meet beforehand?", { exact: true }),
  ).toHaveCount(1);
  await resendInterrupted.click();
  await expect(
    page.getByText("Alex adds that everyone will meet downstairs at 7:30."),
  ).toBeVisible();
  expect(providerRequests[interruptedRequestIndex + 1]).toBe(
    providerRequests[interruptedRequestIndex],
  );
  await expect(
    page.getByText("Where should we meet beforehand?", { exact: true }),
  ).toHaveCount(1);

  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "世界", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "当前世界" })
    .getByRole("button", { name: "修订当前世界" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Dormitory World.*世界修订/u }),
  ).toBeVisible();
  await expect(page.getByText("手动编辑和 AI 共用一份修订")).toBeVisible();
  await expect(page.getByRole("button", { name: "应用并解锁" })).toHaveCount(0);
  const previewRequestCount = providerRequests.length;
  await page
    .getByRole("button", { name: "预览下一条请求", exact: true })
    .click();
  await expect(
    page.getByText("下一次发送候选（未发送）", { exact: true }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(previewRequestCount);
  await expect(page.getByRole("button", { name: "应用并解锁" })).toHaveCount(0);

  responses.push(
    chatTools(
      [
        tool("world_revision_read", {
          path: "control/blocks/world.md",
        }),
        tool("world_revision_write_file", {
          path: "control/blocks/world.md",
          contents:
            "# World Narration Rules\n\nWrite persistent outcomes back to their natural owner. Keep this temporary revision concise.\n",
        }),
      ],
      null,
      "Read the current world control before revising it.",
    ),
    chatText("The temporary world-control revision is ready for review."),
  );
  await page
    .getByLabel("用全新上下文给 AI 发消息")
    .fill("Temporarily make the world narration rule more concise.");
  await page.getByLabel("用全新上下文给 AI 发消息").press("Shift+Enter");
  await expect(page.getByLabel("用全新上下文给 AI 发消息")).toHaveValue(
    "Temporarily make the world narration rule more concise.\n",
  );
  await page.getByLabel("用全新上下文给 AI 发消息").press("Enter");
  await expect(
    page.locator(".setting-conversation-assistant").last(),
  ).toContainText("temporary world-control revision");
  expect(providerRequests.at(-1)).toContain("ORDERED_AUTHOR_RULE");
  expect(providerRequests.at(-1)).toContain("世界修订工具只修改持久独占");
  const worldRevisionTurn = page.locator(".setting-conversation-turn").last();
  await worldRevisionTurn.locator(".model-call-details > summary").click();
  const worldRevisionWrite = worldRevisionTurn
    .locator(".setting-exchange-tool")
    .filter({ hasText: "world_revision_write_file" })
    .filter({ hasText: "control/blocks/world.md" });
  await worldRevisionWrite
    .locator("xpath=ancestor::details[1]/summary")
    .click();
  await expect(worldRevisionWrite).toContainText("已修改修订工作树");
  await worldRevisionWrite.locator(":scope > summary").click();
  const worldRevisionDiff = worldRevisionWrite.locator(".setting-change-diff");
  await worldRevisionDiff.locator(":scope > summary").click();
  await worldRevisionDiff.getByRole("button", { name: "回滚这个文件" }).click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    "已回滚所选文件；其他修订保持不变",
  );
  await expect(worldRevisionWrite).toContainText("当前文件已是修改前版本");

  await page
    .getByRole("navigation", { name: "世界修订工具" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const revisionEditor = page.getByRole("complementary", {
    name: "世界修订文件编辑",
  });
  await revisionEditor
    .getByRole("button", { name: "打开 state/characters/alex.yaml" })
    .click();
  const alexEditor = revisionEditor.getByLabel(
    "编辑 state/characters/alex.yaml",
  );
  await alexEditor.fill(
    (await alexEditor.inputValue()).replace(
      "Dark blue athletic tank top",
      "Blue training jacket",
    ),
  );
  await revisionEditor.getByRole("button", { name: "保存到修订" }).click();
  await expect(page.getByText("手动编辑", { exact: true })).toBeVisible();
  await revisionEditor.getByRole("button", { name: "收起文件面板" }).click();
  await page
    .getByRole("navigation", { name: "世界修订工具" })
    .getByRole("button", { name: "应用并解锁" })
    .click();
  await expect(page.locator(".world-feedback.status")).toContainText(
    "世界修订已应用并解锁",
  );
  await page.getByRole("button", { name: "此刻" }).click();
  await expect(page.getByLabel("当前情景")).toContainText(
    "Blue training jacket",
  );
  await page.getByRole("button", { name: "收起状态栏" }).click();

  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "世界管理" })
    .click();
  const managementDialog = page.getByRole("dialog", { name: "世界管理" });
  await managementDialog
    .getByText("世界控制 · 高级编辑", { exact: true })
    .click();
  await managementDialog.getByRole("button", { name: "预览世界控制" }).click();
  await managementDialog
    .getByRole("button", { name: "整批应用世界控制" })
    .click();
  await expect(page.locator(".world-feedback.status")).toContainText(
    "世界控制已整批应用",
  );

  await managementDialog.getByRole("button", { name: "关闭" }).click();
  const playerBranchPoint = page
    .locator(".call-chain-player")
    .filter({ hasText: "Where should we meet beforehand?" });
  await playerBranchPoint.getByRole("button", { name: "创建分叉" }).click();
  await expect(
    page.getByRole("heading", { name: "Dormitory World · 分叉", exact: true }),
  ).toBeVisible();
  const derivedTimeline = page.getByLabel("故事时间线");
  await expect(derivedTimeline).toContainText("模型推理");
  await expect(derivedTimeline).toContainText("调用 world_patch");
  await expect(derivedTimeline).toContainText(
    "Where should we meet beforehand?",
  );
  await expect(page.getByLabel("你的行动")).toHaveValue("");
  await expect(page.getByRole("button", { name: "继续故事" })).toBeEnabled();
  responses.push(
    chatText("Alex reconsiders and says to meet downstairs at 7:20."),
  );
  await page.getByRole("button", { name: "继续故事" }).click();
  await expect(
    page.getByText("Alex reconsiders and says to meet downstairs at 7:20."),
  ).toBeVisible();

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page
    .getByRole("button", { name: "打开世界：Dormitory World", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "世界管理" })
    .click();

  await page
    .getByRole("dialog", { name: "世界管理" })
    .getByRole("button", { name: "创建分叉" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Dormitory World · 分叉 2",
      exact: true,
    }),
  ).toBeVisible();
  expect([...observationKinds].sort()).toEqual(["play", "revision", "setting"]);
  expect(
    pollingRequests.filter((type) => type !== "play.chain.inspect"),
  ).toEqual([]);
  // An explicit failed command may inspect once to reconcile its result.
  expect(
    pollingRequests.filter((type) => type === "play.chain.inspect").length,
  ).toBeLessThanOrEqual(1);
});

test("新建世界文档时文件头是可编辑的草稿内容", async ({ page }) => {
  test.setTimeout(35_000);
  const packageEditor = page.getByRole("complementary", {
    name: "内容包文件编辑",
  });
  const revisionEditor = page.getByRole("complementary", {
    name: "世界修订文件编辑",
  });
  const openEditor = (kind: "设定完善" | "世界修订") =>
    page
      .getByRole("navigation", { name: `${kind}工具` })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
  async function reopenFile(editor: Locator, path: string): Promise<Locator> {
    await editor
      .getByRole("button", { name: `打开 ${path}`, exact: true })
      .click();
    return editor.getByLabel(`编辑 ${path}`);
  }

  const ids = new Set(["situation.current"]);
  async function createWorldDocuments(
    editor: Locator,
    folder: string,
    firstRefSuffix: number,
  ): Promise<Map<string, string>> {
    const documents = [
      { extension: "yml", prefix: /^\$document:/u, body: "weather: clear\n" },
      {
        extension: "md",
        prefix: /^---\n\$document:/u,
        body: "A new paragraph.\n",
      },
    ];
    const saved = new Map<string, string>();
    for (const [index, { extension, prefix, body }] of documents.entries()) {
      const path = `${folder}/current-situation.${extension}`;
      const source = await addWorkbenchFile(editor, path);
      await expect(source).toHaveValue(prefix, { timeout: 3000 });
      const header = await source.inputValue();
      expect(header).toContain(
        `  ref: current-situation-${firstRefSuffix + index}\n`,
      );
      expect(header).toContain("  summary: 用一句话概括这份文档。\n");
      if (extension === "md")
        expect(header).toContain("\n---\n\n# current-situation\n");
      const id = /^ {2}id: (doc\.[0-9a-f]{32})$/mu.exec(header)?.[1] ?? "";
      expect(id).not.toBe("");
      expect(ids.has(id)).toBe(false);
      ids.add(id);

      const editedHeader = header.replace(
        "用一句话概括这份文档。",
        "作者写的简介。",
      );
      await source.fill(editedHeader);
      await appendWorkbenchText(source, body, page);
      const contents = editedHeader + body;
      await expect(source).toHaveValue(contents);
      saved.set(path, contents);
    }
    return saved;
  }

  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  if ((await page.getByLabel("Base URL").inputValue()).length === 0) {
    await page.getByLabel("Base URL").fill(providerUrl);
    await page.getByLabel("API Key").fill("world-document-header-fixture");
    await page.getByLabel("模型 ID").fill("trace-model");
    await page.getByRole("button", { name: "保存模型连接" }).click();
    await expect(
      page.locator(".workspace-feedback").getByRole("status"),
    ).toContainText("模型连接已保存");
  }
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "新建内容包" }).click();
  await page
    .getByRole("dialog", { name: "新建内容包" })
    .getByRole("button", { name: "创建", exact: true })
    .click();
  await openEditor("设定完善");

  const originalSituation = await (
    await reopenFile(packageEditor, "world/current-situation.yaml")
  ).inputValue();
  const packageFiles = await createWorldDocuments(
    packageEditor,
    "world/locations",
    2,
  );
  const opening = await reopenFile(packageEditor, "opening.md");
  const originalOpening = await opening.inputValue();
  await packageEditor.getByRole("button", { name: "删除文件" }).click();
  const newOpening = await addWorkbenchFile(packageEditor, "opening.md");
  await expect(newOpening).toHaveValue("");
  await newOpening.fill(originalOpening);
  for (const [path, text] of [
    ["control/blocks/extra.md", "# Extra control notes\n"],
    ["notes.md", "# Package notes\n"],
  ] as const) {
    const editor = await addWorkbenchFile(packageEditor, path);
    await expect(editor).toHaveValue("");
    await editor.fill(text);
    packageFiles.set(path, text);
  }
  packageFiles.set("opening.md", originalOpening);
  packageFiles.set("world/current-situation.yaml", originalSituation);

  await packageEditor.getByRole("button", { name: "整批保存" }).click();
  await expect(packageEditor.getByText("当前树已保存")).toBeVisible();
  await page.reload();
  await openEditor("设定完善");
  for (const [path, contents] of packageFiles)
    await expect(await reopenFile(packageEditor, path)).toHaveValue(contents);
  await packageEditor.getByRole("button", { name: "收起文件面板" }).click();
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "创建世界", exact: true })
    .click();

  async function openRevision(): Promise<void> {
    await expect(page.getByLabel("你的行动")).toBeVisible();
    await page.getByRole("button", { name: "世界", exact: true }).click();
    await page.getByRole("button", { name: "修订当前世界" }).click();
    await openEditor("世界修订");
  }
  await openRevision();
  const revisionFiles = await createWorldDocuments(
    revisionEditor,
    "state/landmarks",
    4,
  );
  const revisionControlPath = "control/blocks/revision-extra.md";
  const revisionControl = await addWorkbenchFile(
    revisionEditor,
    revisionControlPath,
  );
  await expect(revisionControl).toHaveValue("");
  const controlContents = "# Revision control notes\n";
  await revisionControl.fill(controlContents);
  revisionFiles.set(revisionControlPath, controlContents);
  revisionFiles.set("state/current-situation.yaml", originalSituation);

  await revisionEditor.getByRole("button", { name: "保存到修订" }).click();
  await expect(revisionEditor.getByText("修订工作树已保存")).toBeVisible();
  await page.reload();
  await openRevision();
  for (const [path, contents] of revisionFiles)
    await expect(await reopenFile(revisionEditor, path)).toHaveValue(contents);
  await revisionEditor.getByRole("button", { name: "收起文件面板" }).click();
  await page.getByRole("button", { name: "应用并解锁" }).click();
  await expect(page.locator(".world-feedback.status")).toContainText(
    "世界修订已应用并解锁",
  );
});

async function addWorkbenchFile(
  editor: Locator,
  path: string,
): Promise<Locator> {
  const newPath = editor.getByLabel("新文件路径");
  if (!(await newPath.isVisible()))
    await editor.getByText("新建文件", { exact: true }).click();
  await newPath.fill(path);
  await editor.getByRole("button", { name: "加入草稿" }).click();
  return editor.getByLabel(`编辑 ${path}`);
}

async function appendWorkbenchText(
  source: Locator,
  text: string,
  page: Page,
): Promise<void> {
  await source.focus();
  await source.evaluate((input) => {
    if (input instanceof HTMLTextAreaElement)
      input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.insertText(text);
}

test("世界修订复用统一编辑工作区且世界管理可以纵向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 500 });
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await page.getByText("导入内容包 ZIP", { exact: true }).click();
  await page.getByLabel("内容包 ZIP 文件").setInputFiles({
    name: "dialog-scroll-world.zip",
    mimeType: "application/zip",
    buffer: createZip(files()),
  });
  await page.getByRole("button", { name: "导入 ZIP" }).click();
  await expect(page.getByText(/dialog-scroll-world\.zip/u)).toBeVisible();
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  if ((await page.getByLabel("Base URL").inputValue()).length === 0) {
    await page.getByLabel("Base URL").fill(providerUrl);
    await page.getByLabel("API Key").fill("dialog-scroll-secret");
    await page.getByLabel("模型 ID").fill("trace-model");
    await page.getByRole("button", { name: "保存模型连接" }).click();
    await expect(
      page.locator(".workspace-feedback").getByRole("status"),
    ).toContainText("模型连接已保存");
  }
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page
    .locator(".home-world-library")
    .getByRole("button", { name: "新建世界" })
    .click();
  await page.getByRole("button", { name: "从当前内容包创建" }).click();
  await expect(page.getByLabel("你的行动")).toBeVisible();

  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page
    .getByRole("complementary", { name: "当前世界" })
    .getByRole("button", { name: "修订当前世界" })
    .click();
  await expect(page.getByRole("main", { name: /世界修订/u })).toBeVisible();
  await expect(page.getByText("手动编辑和 AI 共用一份修订")).toBeVisible();
  await page.getByRole("button", { name: "返回游玩" }).click();
  await expect(page.getByLabel("你的行动")).toBeEnabled();
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("button", { name: "修订当前世界" }).click();
  await expect(
    page.getByText("浏览不会锁定世界；首次编辑或发送消息后才会锁定。"),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "应用并解锁" })).toHaveCount(0);
  const previewRequestCount = providerRequests.length;
  await page
    .getByRole("button", { name: "预览下一条请求", exact: true })
    .click();
  await expect(
    page.getByText("下一次发送候选（未发送）", { exact: true }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(previewRequestCount);
  await expect(page.getByRole("button", { name: "应用并解锁" })).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "世界修订工具" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const editorRail = page.getByRole("complementary", {
    name: "世界修订文件编辑",
  });
  await expect(editorRail).toBeVisible();
  await editorRail
    .getByRole("button", { name: "control/blocks/world.md" })
    .click();
  const revisionEditor = editorRail.locator(".content-source-editor textarea");
  await revisionEditor.fill(
    Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n"),
  );
  await expect(
    page.getByText("世界已锁定到这份修订；关闭页面也会保留工作树。"),
  ).toBeVisible();
  await expectCanScrollVertically(revisionEditor);
  await editorRail.getByRole("button", { name: "放弃未保存修改" }).click();
  await editorRail.getByRole("button", { name: "收起文件面板" }).click();
  await page
    .getByRole("navigation", { name: "世界修订工具" })
    .getByRole("button", { name: "放弃", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /尚未应用的手动和 AI 修改都会丢失/ })
    .getByRole("button", { name: "放弃", exact: true })
    .click();
  await expect(page.getByLabel("你的行动")).toBeVisible();

  await page
    .getByRole("navigation", { name: "世界阅读工具" })
    .getByRole("button", { name: "世界管理" })
    .click();
  const managementDialog = page.getByRole("dialog", { name: "世界管理" });
  await expectCanScrollVertically(
    managementDialog.locator(".world-management-body"),
  );
});

function chatText(text: string, reasoningContent?: string) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: [],
          ...(reasoningContent === undefined
            ? {}
            : { reasoning_content: reasoningContent }),
        },
      },
    ],
  };
}

function chatTools(
  toolCalls: object[],
  content: string | null = null,
  reasoningContent?: string,
) {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: toolCalls,
          ...(reasoningContent === undefined
            ? {}
            : { reasoning_content: reasoningContent }),
        },
      },
    ],
  };
}

/** Rewrite a non-streaming chat response as equivalent SSE delta frames. */
function sseFrames(payload: object): string[] {
  const message = (
    payload as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: { id: string; function: object }[];
        };
      }[];
    }
  ).choices?.[0]?.message;
  if (message === undefined)
    return [`data: ${JSON.stringify(payload)}\n\n`, "data: [DONE]\n\n"];
  const frames: string[] = [];
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content !== ""
  )
    for (const text of splitTextDelta(message.reasoning_content))
      frames.push(deltaFrame({ reasoning_content: text }));
  if (typeof message.content === "string" && message.content !== "")
    for (const text of splitTextDelta(message.content))
      frames.push(deltaFrame({ content: text }));
  for (const [index, call] of (message.tool_calls ?? []).entries())
    frames.push(
      deltaFrame({
        tool_calls: [{ index, id: call.id, function: call.function }],
      }),
    );
  frames.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 120 } })}\n\n`,
    "data: [DONE]\n\n",
  );
  return frames;
}

function splitTextDelta(text: string): string[] {
  if (text.length < 2) return [text];
  const middle = Math.ceil(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

function deltaFrame(delta: object): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

function tool(name: string, arguments_: object) {
  return {
    id: `${name}-${responses.length}-${Math.random()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(arguments_) },
  };
}

function providerRequest(body = providerRequests.at(-1) ?? "{}"): {
  messages?: { role?: string; content?: string | null }[];
  tools?: { function?: { name?: string }; name?: string }[];
} {
  return JSON.parse(body) as {
    messages?: { role?: string; content?: string | null }[];
    tools?: { function?: { name?: string }; name?: string }[];
  };
}

function toolNames(request: ReturnType<typeof providerRequest>): string[] {
  return (request.tools ?? []).flatMap((tool_) => {
    const name = tool_.function?.name ?? tool_.name;
    return name === undefined ? [] : [name];
  });
}

function plan(): string {
  return `# 创作计划

## Primary Experience
Dormitory character continuity
## Secondary Experience
Basketball training
## Repeatable Play Loop
Conversation, action, and state feedback
## Focus
Character choices
## Pacing
Natural
## Conflict
Everyday disagreements
## Information Structure
Reveal details as needed
## Tone Boundary
Do not act for the player
## Explicit Exclusions
Do not add schema`;
}

function files() {
  return [
    {
      path: "opening.md",
      contents:
        "The dormitory door closes behind you. Alex looks over with a jersey in hand and waits for you to speak first.\n",
    },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: Dormitory World\n  summary: The current situation in the dormitory.\n  aliases: []\nsituation: Alex is organizing a jersey.\n",
    },
    {
      path: "world/characters/alex.yaml",
      contents:
        "$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: A straightforward basketball forward.\n  aliases: []\nclothes: White athletic tank top\nrank: Pineapple\naffinity: 150\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World Narration Rules\n\nWrite persistent outcomes back to their natural owner.\n",
    },
    {
      path: "control/player-views.yaml",
      contents:
        "format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: Current Status\n    items:\n      - id: clothes\n        label: Clothes\n        select: { document: character.alex, locator: { yaml: [clothes] } }\n",
    },
  ];
}
