import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { createZip } from "../support/createZip.ts";

let provider: Server;
let providerUrl = "";
const disconnectProviderResponse = Symbol("disconnect-provider-response");
const responses: (object | typeof disconnectProviderResponse)[] = [];
const providerRequests: string[] = [];
/** Delay Provider SSE frames so the browser's real increments remain observable. */
let providerDelayMs = 0;

test.setTimeout(120_000);

test.beforeAll(async () => {
  await Promise.all(
    [".test-data/e2e", ".test-data/e2e-config", ".test-data/e2e-log"].map(
      (path) => rm(path, { force: true, recursive: true }),
    ),
  );
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
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

test("四任务工作台以文件原生内容创建世界并展示真实 Prompt Preview", async ({
  page,
}) => {
  const damagedPath = "world/characters/damaged.yaml";
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
  await expect(page.getByRole("heading", { name: "世界工作区" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("界面语言")).toHaveValue("zh-CN");
  for (const name of ["内容编辑", "预设", "新建世界", "提示词预览"])
    await expect(page.getByRole("button", { name })).toBeVisible();

  await page.getByLabel("内容包 ZIP 文件").setInputFiles({
    name: "dormitory-world.zip",
    mimeType: "application/zip",
    buffer: createZip(files()),
  });
  await expect(page.getByText(/dormitory-world\.zip/u)).toBeVisible();
  await page.getByRole("button", { name: "导入 ZIP" }).click();
  await expect(page.getByRole("status")).toContainText(
    "ZIP 内容包已导入为新的本地身份",
  );
  await expect(
    page.getByRole("heading", { name: "内容包当前树" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回工作区" }).click();

  await page.getByRole("button", { name: "模型连接" }).click();
  await page.getByLabel("Base URL").fill(providerUrl);
  await page.getByLabel("API Key").fill("test-secret");
  await page.getByRole("button", { name: "从端点拉取模型" }).click();
  await expect(page.getByRole("status")).toContainText(
    "已从当前端点拉取 2 个模型",
  );
  await expect(page.locator("#provider-models option")).toHaveCount(2);
  await page.getByLabel("模型 ID").fill("trace-model");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await expect(page.getByRole("status")).toContainText("模型连接已保存");
  await page.getByRole("button", { name: "新建另一份" }).click();
  await page.getByLabel("配置名称").fill("备用模型");
  await page.getByLabel("Base URL").fill(providerUrl);
  await page.getByLabel("API Key").fill("backup-secret");
  await page.getByLabel("模型 ID").fill("backup-model");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await expect(page.locator(".config-card")).toHaveCount(2);
  const firstModel = page
    .locator(".config-card")
    .filter({ hasText: "默认模型" });
  await firstModel.getByRole("button", { name: "切换到此配置" }).click();
  await expect(page.locator(".model-active-summary")).toContainText("默认模型");
  await page.getByRole("button", { name: "返回工作区" }).click();

  await page.getByRole("button", { name: "预设" }).click();
  await expect(page.getByRole("heading", { name: "玩法预设" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "调用链" })).toBeVisible();
  await expect(page.getByLabel("玩法预设文件编辑器")).toContainText(
    "叙事提示块",
  );
  await expect(page.getByLabel("玩法预设文件编辑器")).toContainText("后置请求");
  await page.getByRole("button", { name: "返回工作区" }).click();

  await page.getByRole("button", { name: "新建内容包" }).click();
  await expect(
    page.getByRole("heading", { name: "内容包当前树" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "内容包文件" }),
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
      await page
        .getByText("高级：直接编辑 frame.yaml", { exact: true })
        .click();
      await page.getByLabel("直接编辑 control/frame.yaml").fill(file.contents);
    } else {
      await page.getByLabel(`编辑 ${file.path}`).fill(file.contents);
    }
  }
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeDisabled();
  await page.getByRole("button", { name: "整批保存" }).click();
  await expect(page.getByRole("status")).toContainText("已整批保存");
  await expect(page.getByRole("button", { name: "返回工作区" })).toBeEnabled();

  responses.push(
    chatTools([
      tool("setting_write_file", {
        path: damagedPath,
        contents:
          "$document:\n  id: character.damaged\n  ref: damaged\n  title: Damaged Character\n  summary: Character document repaired in the isolated candidate.\n  aliases: []\nstatus: repaired\n",
      }),
      tool("setting_preview_candidate", {}),
    ]),
    chatTools([tool("setting_finish_candidate", {})]),
  );
  await page.getByRole("button", { name: "AI 完善" }).click();
  const currentSetting = page.getByRole("complementary", {
    name: "当前设定",
  });
  await currentSetting
    .getByRole("button", { name: /world\/characters\/damaged\.yaml/u })
    .click();
  await currentSetting.getByLabel(`注入 ${damagedPath}`).check();
  await page
    .getByLabel("设定完善目标")
    .fill("Repair the damaged character document selected by the user.");
  await page.getByRole("button", { name: "跳过计划，直接生成候选" }).click();
  await expect(page.getByRole("status")).toContainText("候选已通过机械检查");
  await expect(page.locator(".setting-diff-list")).toContainText(damagedPath);
  await page.getByRole("button", { name: "整批应用候选" }).click();
  await expect(page.getByRole("status")).toContainText("候选已整批应用");

  responses.push(
    chatText(plan()),
    chatTools([
      tool("setting_read", { path: "world/current-situation.yaml" }),
      tool("setting_read", { path: "world/characters/alex.yaml" }),
      tool("setting_write_file", {
        path: "world/notes/training.yaml",
        contents:
          "$document:\n  id: Assigned by Runtime\n  ref: training\n  title: Tonight's Training\n  summary: Alex's training plans for tonight.\n  aliases: []\nlocation: Campus basketball court\n",
      }),
      tool("setting_patch", {
        document: "world/notes/training.yaml",
        op: "add",
        locator: ["time"],
        value: "8:00 p.m.",
      }),
      tool("setting_move", {
        from: "world/notes/training.yaml",
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
          "$document:\n  id: situation.current\n  ref: current\n  title: Dormitory World\n  summary: The current situation in the dormitory.\n  aliases: []\nsituation: Alex has put away the jersey and is ready to discuss tonight's training.\n",
      }),
      tool("setting_read", { path: "opening.md" }),
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
      tool("setting_preview_candidate", {}),
    ]),
    chatTools([tool("setting_finish_candidate", {})]),
  );
  await page.getByRole("button", { name: "AI 完善" }).click();
  await expect(currentSetting).toContainText("opening.md");
  await currentSetting.getByRole("button", { name: /opening\.md/u }).click();
  await expect(currentSetting).toContainText(
    "The dormitory door closes behind you",
  );
  await expect(currentSetting).toContainText("world/current-situation.yaml");
  await currentSetting
    .getByRole("button", { name: /world\/current-situation\.yaml/u })
    .click();
  await expect(currentSetting).toContainText("Alex is organizing a jersey");
  await currentSetting.getByLabel("注入 world/current-situation.yaml").check();
  await page
    .getByLabel("设定完善目标")
    .fill(
      "Preserve the dormitory experience and review the current file plan.",
    );
  await page.getByRole("button", { name: "生成可见创作计划" }).click();
  await expect(page.getByRole("status")).toContainText("创作计划已生成");
  const planningRequest = providerRequest();
  expect(JSON.stringify(planningRequest)).toContain(
    "Alex is organizing a jersey",
  );
  expect(JSON.stringify(planningRequest)).toContain("用户选定的当前设定文件");
  expect(toolNames(planningRequest)).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
  ]);
  await expect(page.getByRole("heading", { name: "创作计划" })).toBeVisible();
  await page.getByRole("button", { name: "确认计划并生成候选" }).click();
  await expect(page.getByRole("status")).toContainText("候选已通过机械检查");
  await expect(
    page.getByRole("heading", { name: "审阅候选，再决定是否应用" }),
  ).toBeVisible();
  await expect(page.locator(".setting-diff-list")).toContainText(
    "world/events/training.yaml",
  );
  await expect(page.locator(".setting-diff-list")).toContainText("opening.md");
  await expect(page.locator(".setting-diff-list")).toContainText(
    "control/blocks/world.md",
  );
  await expect(page.getByText("真实提示词预览")).toBeVisible();
  await page.getByText("查看逻辑消息正文").click();
  await expect(page.locator(".setting-prompt-preview")).toContainText(
    "Alex, wearing a dark blue athletic tank top",
  );
  await page.getByRole("button", { name: "整批应用候选" }).click();
  await expect(page.getByRole("status")).toContainText("候选已整批应用");

  responses.push(
    chatTools([
      tool("setting_write_file", {
        path: "control/frame.yaml",
        contents: "invalid: true\n",
      }),
      tool("setting_preview_candidate", {}),
    ]),
    chatTools([
      tool("setting_write_file", {
        path: "control/frame.yaml",
        contents:
          "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
      }),
      tool("setting_preview_candidate", {}),
    ]),
    chatTools([tool("setting_finish_candidate", {})]),
  );
  await page
    .getByLabel("设定完善目标")
    .fill("Inspect the current tree directly and generate a candidate.");
  providerDelayMs = 1200;
  await page.getByRole("button", { name: "跳过计划，直接生成候选" }).click();
  // Progress must move while generation is active; rounds come from live server projection.
  const runProgress = page.getByLabel("本次生成进度");
  await expect(runProgress).toContainText("正在生成候选");
  await expect(runProgress).toContainText(/第 \d+ \/ 64 轮/u);
  // While the first round is still streaming, the UI shows received characters
  // rather than inactivity. This number can only come from live server increments.
  await expect(runProgress).toContainText(/正在输出 \S+ 字/u);
  providerDelayMs = 0;
  await expect(page.getByRole("status")).toContainText("候选已通过机械检查");
  await expect(runProgress).toBeHidden();
  await expect(page.getByText("已跳过可见计划")).toBeVisible();
  const directRequest = providerRequest();
  expect(JSON.stringify(directRequest)).toContain("跳过可见创作计划");
  expect(toolNames(directRequest)).toContain("setting_finish_candidate");
  await page.getByRole("button", { name: "放弃整批候选" }).click();
  await expect(page.getByRole("status")).toContainText("当前树未改变");

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "提示词预览" }).click();
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
  await page.getByRole("button", { name: "新建世界" }).click();
  await page.getByRole("button", { name: "从当前内容包创建" }).click();
  await expect(
    page.getByRole("heading", { name: "Dormitory World" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "世界管理" }).click();
  await page.getByLabel("世界显示名称").fill("Night Training Dormitory");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("status")).toContainText("世界名称已保存");
  await expect(
    page.getByRole("heading", { name: "Night Training Dormitory" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page
    .getByRole("button", { name: "重命名世界：Night Training Dormitory" })
    .click();
  await page.getByRole("textbox", { name: "世界名称" }).fill("Dormitory World");
  await page.getByRole("button", { name: "保存世界名称" }).click();
  await page
    .getByRole("button", { name: "打开世界：Dormitory World", exact: true })
    .click();
  await expect(page.getByLabel("调用链记录")).toContainText(
    "The dormitory door closes behind you. Alex, wearing a dark blue athletic tank top, waits to discuss tonight's training.",
  );
  await expect(page.getByLabel("你的行动")).toBeVisible();
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
  await expect(
    page.getByRole("complementary", { name: "玩家视图" }),
  ).toContainText("Dark blue athletic tank top");
  await page.getByRole("button", { name: "当前文档" }).click();
  await expect(
    page.getByRole("button", { name: /current-situation\.yaml/u }),
  ).toBeVisible();
  await page.getByRole("button", { name: "游玩" }).click();

  responses.push(
    chatTools([
      tool("world_patch", {
        target: "@current-situation",
        edits: [
          {
            op: "replace",
            locator: { yaml: ["situation"] },
            value:
              "Alex has put away the jersey and is waiting for you to confirm the training plan.",
          },
        ],
      }),
    ]),
    chatText(
      "Alex nods and continues folding the jersey.",
      "First verify the character's current location and the player's action.",
    ),
  );
  providerDelayMs = 200;
  await page
    .getByLabel("你的行动")
    .fill("I ask Alex whether we are training tonight.");
  await page.getByRole("button", { name: "全新上下文" }).click();
  const callChain = page.getByLabel("模型调用链");
  await expect(callChain).toContainText("模型响应中");
  const transcript = page.getByLabel("调用链记录");
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
  const firstAssistant = callChain.locator(".call-chain-assistant", {
    hasText: "Alex nods and continues folding the jersey.",
  });
  const reasoning = firstAssistant.locator("details");
  await expect(reasoning).not.toHaveAttribute("open", "");
  await reasoning.locator("summary").click();
  await expect(reasoning).toContainText(
    "First verify the character's current location and the player's action.",
  );
  await expect(callChain).toContainText("调用 world_patch");
  await expect(callChain).not.toContainText(
    "@current-situation write succeeded",
  );
  const toolCall = callChain
    .getByText("调用 world_patch")
    .locator("xpath=ancestor::details");
  await expect(toolCall).not.toHaveAttribute("open", "");
  const toolResult = callChain
    .getByText("world_patch 返回")
    .locator("xpath=ancestor::details");
  await toolResult.locator("summary").click();
  await expect(toolResult).toContainText("@current-situation write succeeded");
  const firstPlayRequest = providerRequest();
  expect(JSON.stringify(firstPlayRequest)).toContain(
    "当前世界没有更早的玩家原文或主持叙事",
  );
  expect(JSON.stringify(firstPlayRequest)).toContain(
    "最后一句写某个人做的一件具体的事",
  );

  responses.push(
    chatText(
      "Alex saves the training time on the phone.",
      "This is a fresh model context.",
    ),
  );
  await page.getByLabel("你的行动").fill("I ask Alex to write down the time.");
  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(
    page.getByText("Alex saves the training time on the phone."),
  ).toBeVisible();
  const contextsAfterFresh = page.getByLabel("模型调用链");
  await expect(contextsAfterFresh).toHaveCount(1);
  await expect(contextsAfterFresh).toContainText(
    "First verify the character's current location and the player's action.",
  );
  await expect(contextsAfterFresh).toContainText("调用 world_patch");
  const freshAssistant = contextsAfterFresh.locator(".call-chain-assistant", {
    hasText: "Alex saves the training time on the phone.",
  });
  const freshReasoning = freshAssistant.locator("details");
  await freshReasoning.locator("summary").click();
  await expect(contextsAfterFresh).toContainText(
    "This is a fresh model context.",
  );
  await expect(
    page.getByRole("separator", { name: "全新上下文从这里开始" }),
  ).toHaveCount(2);
  const freshRequest = providerRequest();
  expect(
    freshRequest.messages?.filter(({ role }) => role === "assistant"),
  ).toHaveLength(0);
  expect(
    freshRequest.messages?.filter(({ role }) => role === "tool"),
  ).toHaveLength(0);

  responses.push(chatText("We are heading to the court at eight."));
  await page.getByLabel("你的行动").fill("What time are we leaving?");
  await page.getByRole("button", { name: "追加上下文" }).click();
  await expect(
    page.getByText("We are heading to the court at eight."),
  ).toBeVisible();

  responses.push(
    disconnectProviderResponse,
    chatText("Alex adds that everyone will meet downstairs at 7:30."),
  );
  await page.getByLabel("你的行动").fill("Where should we meet beforehand?");
  const interruptedRequestIndex = providerRequests.length;
  await page.getByRole("button", { name: "追加上下文" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "旧请求不能重发" }),
  ).toBeVisible();
  await expect(
    page.getByText("Where should we meet beforehand?", { exact: true }),
  ).toHaveCount(1);
  await page
    .getByLabel("你的行动")
    .fill("Start a fresh call and tell me where we should meet beforehand.");
  await page.getByRole("button", { name: "全新上下文" }).click();
  await expect(
    page.getByText("Alex adds that everyone will meet downstairs at 7:30."),
  ).toBeVisible();
  expect(providerRequests[interruptedRequestIndex + 1]).not.toBe(
    providerRequests[interruptedRequestIndex],
  );
  await expect(
    page.getByText("Where should we meet beforehand?", { exact: true }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "世界管理" }).click();
  await page.getByLabel("YAML 路径").fill("clothes");
  await page.getByLabel("修正后的新值").fill("Blue training jacket");
  await page.getByRole("button", { name: "预览整笔修正" }).click();
  await page.getByRole("button", { name: "应用这笔修正" }).click();
  await page.getByRole("button", { name: "游玩" }).click();
  await expect(
    page.getByRole("complementary", { name: "玩家视图" }),
  ).toContainText("Blue training jacket");

  await page.getByRole("button", { name: "世界管理" }).click();
  await page.getByRole("button", { name: "预览世界控制" }).click();
  await page.getByRole("button", { name: "整批应用世界控制" }).click();
  await expect(page.getByRole("status")).toContainText("世界控制已整批应用");

  await page.getByRole("button", { name: "游玩" }).click();
  const playerBranchPoint = page
    .locator(".call-chain-player")
    .filter({ hasText: "Where should we meet beforehand?" });
  await playerBranchPoint.getByRole("button", { name: "创建分叉" }).click();
  await expect(
    page.getByRole("heading", { name: "Dormitory World (fork)" }),
  ).toBeVisible();
  const derivedTimeline = page.getByLabel("调用链记录");
  await expect(derivedTimeline).toContainText("查看模型诊断详情");
  await expect(derivedTimeline).toContainText("调用 world_patch");
  await expect(derivedTimeline).toContainText(
    "Where should we meet beforehand?",
  );
  await expect(page.getByLabel("你的行动")).toHaveValue("");
  await expect(page.getByRole("button", { name: "全新上下文" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "追加上下文" })).toBeEnabled();
  responses.push(
    chatText("Alex reconsiders and says to meet downstairs at 7:20."),
  );
  await page.getByRole("button", { name: "追加上下文" }).click();
  await expect(
    page.getByText("Alex reconsiders and says to meet downstairs at 7:20."),
  ).toBeVisible();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page
    .getByRole("button", { name: "打开世界：Dormitory World", exact: true })
    .click();
  await page.getByRole("button", { name: "世界管理" }).click();

  await page.getByRole("button", { name: "创建分叉" }).click();
  await expect(
    page.getByRole("heading", { name: "Dormitory World (fork)" }),
  ).toBeVisible();
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

function chatTools(toolCalls: object[]) {
  return { choices: [{ message: { content: null, tool_calls: toolCalls } }] };
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

function providerRequest(): {
  messages?: { role?: string }[];
  tools?: { function?: { name?: string }; name?: string }[];
} {
  return JSON.parse(providerRequests.at(-1) ?? "{}") as {
    messages?: { role?: string }[];
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
