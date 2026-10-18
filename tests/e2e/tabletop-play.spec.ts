import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "../support/isolatedRuntimeTest.ts";

import type { V1PlayTimelinePage, V1Request } from "../../src/protocol/v1.ts";
import type { ResolutionReceipt } from "../../src/protocol/resolution.ts";
import { gameplayFile, type Gameplay } from "../../src/protocol/gameplay.ts";

type ScriptedTurn =
  { text: string } | { tool: string; arguments: Record<string, unknown> };

interface ProviderRequest {
  raw: string;
  body: {
    messages: { role: string; content?: unknown; tool_call_id?: string }[];
    tools?: { type: string; function: { name: string } }[];
  };
}

const resolutionToolNames = [
  "d20_check",
  "percentile_check",
  "bag_check",
  "roll_dice",
  "calculate",
];
const outcomeLabels = {
  success: "成功",
  failure: "失败",
  critical_success: "大成功",
  critical_failure: "大失败",
} as const;

let provider: Server;
let providerUrl = "";
const turns: ScriptedTurn[] = [];
const providerRequests: ProviderRequest[] = [];

test.use({ runtimeScope: "tabletop-play" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let raw = "";
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      providerRequests.push({
        raw,
        body: JSON.parse(raw) as ProviderRequest["body"],
      });
      const turn = turns.shift();
      if (turn === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected model request" }));
        return;
      }
      const delta =
        "text" in turn
          ? { content: turn.text }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${providerRequests.length}`,
                  type: "function",
                  function: {
                    name: turn.tool,
                    arguments: JSON.stringify(turn.arguments),
                  },
                },
              ],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`,
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
    throw new Error(
      "The tabletop play fixture Provider did not receive a port",
    );
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

test.beforeEach(() => {
  turns.length = 0;
  providerRequests.length = 0;
});

test("跑团 d20 行动：请求暴露判定工具与规则，折叠卡片与回执一致，展开显示本地化标签，刷新后保持", async ({
  page,
}) => {
  const world = await createPlayWorld(page, {
    name: "跑团播放 d20",
    gameplay: { mode: "tabletop", scheme: "d20" },
  });
  try {
    turns.push(
      {
        tool: "d20_check",
        arguments: { goal: "推开石门", modifier: 3, difficulty: 15 },
      },
      { text: "石门在你的力量下缓缓打开，门后传来潮湿的风。" },
    );
    await openWorld(page, world.title);
    const settle = await sendFirstAction(page, "我用力推开石门。");
    await expect(
      page.getByText("石门在你的力量下缓缓打开，门后传来潮湿的风。"),
    ).toBeVisible();
    await settle();

    // The first request carries the tools and rules; the second carries the receipt.
    expect(providerRequests).toHaveLength(2);
    const first = providerRequests[0]!;
    const exposed = (first.body.tools ?? []).map(({ function: fn }) => fn.name);
    expect(exposed).toEqual(
      expect.arrayContaining(["d20_check", "roll_dice", "calculate"]),
    );
    expect(exposed).not.toContain("percentile_check");
    expect(exposed).not.toContain("bag_check");
    expect(first.raw).toContain("# 跑团判定规则");
    expect(first.raw).toContain("## 主持流程");
    expect(providerRequests[1]!.body.messages).toContainEqual(
      expect.objectContaining({ role: "tool" }),
    );

    const receipt = await tabletopReceipt(page, world.worldId, "d20_check");
    expect(receipt).toMatchObject({
      kind: "d20",
      goal: "推开石门",
      modifier: 3,
      difficulty: 15,
    });
    if (receipt.kind !== "d20") throw new Error("expected a d20 receipt");
    const comparison = receipt.total >= receipt.difficulty ? "≥" : "<";
    const outcome = outcomeLabels[receipt.outcome];
    const expectedLine = `推开石门 · d20 ${receipt.selected} + ${receipt.modifier} = ${receipt.total} ${comparison} ${receipt.difficulty} · ${outcome}`;
    const card = page.getByRole("article", { name: "判定结果", exact: true });
    await expect(card).toHaveCount(1);
    await expect(card.locator("details")).not.toHaveAttribute("open", "");
    const summary = card.locator("summary");
    await expect(card.locator(".resolution-outcome")).toHaveText(outcome);
    await expect(summary).toHaveText(expectedLine);

    await summary.click();
    const facts = card.locator(".resolution-facts");
    await expect(facts).toBeVisible();
    for (const label of ["行动", "修正", "难度", "总值", "结果"])
      await expect(
        facts.locator("dt", { hasText: exactLabel(label) }),
      ).toHaveCount(1);
    await expect(factValue(facts, "修正")).toHaveText("+3");
    await expect(factValue(facts, "难度")).toHaveText("15");
    const factsText = await facts.innerText();
    for (const raw of [
      "modifier",
      "difficulty",
      "outcome",
      "selected",
      "total",
      "goal",
      "critical_",
    ])
      expect(factsText).not.toContain(raw);

    await page.reload();
    await openWorld(page, world.title);
    const reloadedCard = page.getByRole("article", {
      name: "判定结果",
      exact: true,
    });
    await expect(reloadedCard).toHaveCount(1);
    await expect(reloadedCard.locator("summary")).toHaveText(expectedLine);
    await expect(reloadedCard.locator("details")).not.toHaveAttribute(
      "open",
      "",
    );
  } finally {
    await cleanupWorld(page, world);
  }
});

test("互动式小说请求不暴露判定工具也没有规则块，故事中没有判定卡片", async ({
  page,
}) => {
  const world = await createPlayWorld(page, { name: "互动小说播放" });
  try {
    turns.push({ text: "门后只有一条安静的走廊。" });
    await openWorld(page, world.title);
    const settle = await sendFirstAction(page, "我推开门看看。");
    await expect(page.getByText("门后只有一条安静的走廊。")).toBeVisible();
    await settle();

    expect(providerRequests).toHaveLength(1);
    const exposed = (providerRequests[0]!.body.tools ?? []).map(
      ({ function: fn }) => fn.name,
    );
    for (const name of resolutionToolNames) expect(exposed).not.toContain(name);
    expect(providerRequests[0]!.raw).not.toContain("# 跑团判定规则");
    expect(providerRequests[0]!.raw).not.toContain("## 主持流程");
    await expect(
      page.getByRole("article", { name: "判定结果", exact: true }),
    ).toHaveCount(0);
  } finally {
    await cleanupWorld(page, world);
  }
});

test("跑团混乱袋默认袋：展开后的标记表使用本地化特殊标记，不显示内部键名", async ({
  page,
}) => {
  const world = await createPlayWorld(page, {
    name: "跑团播放混乱袋",
    gameplay: { mode: "tabletop", scheme: "bag" },
  });
  try {
    turns.push(
      {
        tool: "bag_check",
        arguments: { goal: "撬开铁箱", value: 0, difficulty: 1 },
      },
      { text: "铁箱的锁扣终于松开。" },
    );
    await openWorld(page, world.title);
    const settle = await sendFirstAction(page, "我撬开铁箱。");
    await expect(page.getByText("铁箱的锁扣终于松开。")).toBeVisible();
    await settle();

    const exposed = (providerRequests[0]!.body.tools ?? []).map(
      ({ function: fn }) => fn.name,
    );
    expect(exposed).toEqual(
      expect.arrayContaining(["bag_check", "roll_dice", "calculate"]),
    );
    expect(exposed).not.toContain("d20_check");
    expect(exposed).not.toContain("percentile_check");

    const receipt = await tabletopReceipt(page, world.worldId, "bag_check");
    if (receipt.kind !== "bag") throw new Error("expected a bag receipt");
    expect(receipt.defaultBag).toBe(true);
    const card = page.getByRole("article", { name: "判定结果", exact: true });
    await expect(card.locator(".resolution-outcome")).toHaveText(
      outcomeLabels[receipt.outcome],
    );
    await card.locator("summary").click();
    const table = card.locator(".resolution-tokens");
    await expect(table).toBeVisible();
    await expect(table.locator("caption")).toHaveText("本次使用的混乱袋");
    await expect(table.locator("tbody tr", { hasText: "大成功" })).toHaveCount(
      1,
    );
    await expect(table.locator("tbody tr", { hasText: "大失败" })).toHaveCount(
      1,
    );
    await expect(card.locator(".resolution-facts")).toContainText("默认混乱袋");
    const cardText = await card.innerText();
    expect(cardText).not.toContain("critical_success");
    expect(cardText).not.toContain("critical_failure");
  } finally {
    await cleanupWorld(page, world);
  }
});

interface PlayWorld {
  packageId: string;
  worldId: string;
  title: string;
}

async function createPlayWorld(
  page: Page,
  options: { name: string; gameplay?: Gameplay },
): Promise<PlayWorld> {
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Tabletop play fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "tabletop-play-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  const created = await runtime<{ localId: string }>(
    page,
    options.gameplay === undefined
      ? { type: "content.create" }
      : { type: "content.create", gameplay: options.gameplay },
  );
  await runtime(page, {
    type: "content.rename",
    packageId: created.localId,
    name: options.name,
  });
  // content.replace swaps the whole tree, so a tabletop package keeps its
  // gameplay identity by carrying control/gameplay.json in the same write.
  await runtime(page, {
    type: "content.replace",
    packageId: created.localId,
    files: [
      ...contentFiles(),
      ...(options.gameplay === undefined
        ? []
        : [gameplayFile(options.gameplay)]),
    ],
  });
  const world = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: `tabletop-play-${randomUUID()}`,
    packageId: created.localId,
    model: {
      provider: "chat_completions",
      modelId: "tabletop-play-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  return {
    packageId: created.localId,
    worldId: world.world.worldId,
    title: options.name,
  };
}

/** A fact label cell, matched exactly so `修正` never matches `修正值`. */
function exactLabel(label: string): RegExp {
  return new RegExp(`^${label}$`, "u");
}

function factValue(facts: Locator, label: string): Locator {
  return facts
    .locator("dt", { hasText: exactLabel(label) })
    .locator("xpath=following-sibling::dd");
}

async function openWorld(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("button", { name: `打开世界：${title}`, exact: true })
    .click();
}

/**
 * Sends the first action. Visible streamed text precedes durable settlement, so
 * the returned step waits for the play request to finish before the test
 * deletes the world it writes to.
 */
async function sendFirstAction(
  page: Page,
  text: string,
): Promise<() => Promise<void>> {
  await page.getByLabel("你的行动").fill(text);
  const stream = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "play.chain.start",
  );
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  const response = await stream;
  return async () => {
    expect(await response.finished()).toBeNull();
  };
}

async function tabletopReceipt(
  page: Page,
  worldId: string,
  toolName: string,
): Promise<ResolutionReceipt> {
  const timeline = await runtime<V1PlayTimelinePage>(page, {
    type: "play.timeline.page",
    worldId,
    limit: 50,
  });
  const receipts = timeline.items.flatMap((item) =>
    item.kind === "event" &&
    item.event.kind === "tool_result" &&
    item.event.name === toolName &&
    item.event.resolution !== undefined
      ? [item.event.resolution]
      : [],
  );
  expect(receipts).toHaveLength(1);
  return receipts[0]!;
}

async function cleanupWorld(page: Page, world: PlayWorld): Promise<void> {
  await runtime(page, { type: "world.delete", worldId: world.worldId });
  await runtime(page, { type: "content.delete", packageId: world.packageId });
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
      if (!response.ok) throw new Error(JSON.stringify(body));
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
