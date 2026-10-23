import { createServer, type Server } from "node:http";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/isolatedRuntimeTest.ts";
import type {
  ContentTreeFile,
  V1PlayContextReadingView,
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import type { ProtagonistTemplatesView } from "../../src/protocol/protagonistTemplates.ts";

let provider: Server;
let providerUrl = "";
const providerRequests: string[] = [];
test.use({ runtimeScope: "protagonist-templates" });
test.setTimeout(60_000);
test.beforeAll(async () => {
  provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      providerRequests.push(body);
      const payload = JSON.parse(body) as {
        messages: { role: string; content?: unknown }[];
      };
      const last = payload.messages.at(-1);
      const delta =
        last?.role === "user"
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "read-player",
                  type: "function",
                  function: {
                    name: "world_revision_read",
                    arguments: JSON.stringify({ path: "state/player.yaml" }),
                  },
                },
                {
                  index: 1,
                  id: "patch-player",
                  type: "function",
                  function: {
                    name: "world_revision_patch",
                    arguments: JSON.stringify({
                      document: "@player",
                      op: "replace",
                      locator: ["Name"],
                      value: "Custom Investigator",
                    }),
                  },
                },
              ],
            }
          : {
              content:
                "Protagonist updated; review the changes before applying.",
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const payload = (await response.json()) as { result: T };
  expect(response.ok(), JSON.stringify(payload)).toBe(true);
  return payload.result;
}
async function setup(page: Page, locale: "en" | "zh-CN", title: string) {
  await runtime(page, { type: "preferences.save", locale });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Protagonist fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "protagonist-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const source = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const detail = await runtime<{ files: ContentTreeFile[] }>(page, {
    type: "content.read",
    packageId: source.localId,
  });
  await runtime(page, {
    type: "content.rename",
    packageId: source.localId,
    name: title,
  });
  await runtime(page, {
    type: "content.replace",
    packageId: source.localId,
    baseTreeRevision: (
      await runtime<{ treeRevision: string }>(page, {
        type: "content.read",
        packageId: source.localId,
      })
    ).treeRevision,
    files: [
      ...detail.files.map((file) =>
        file.path === "control/frame.yaml"
          ? {
              ...file,
              contents:
                file.contents +
                '  - slot: { kind: document, document: "@player" }\n',
            }
          : file,
      ),
      {
        path: "world/player.yaml",
        contents:
          "$document:\n  id: character.player\n  ref: player\n  title: Player protagonist\n  summary: The character representing the player.\n  aliases: []\nName: Default Player\n",
      },
    ],
  });
  await page.goto("/");
  await page
    .getByRole("navigation", {
      name: locale === "zh-CN" ? "工作区导航" : "Workspace navigation",
    })
    .getByRole("button", {
      name: locale === "zh-CN" ? "新建世界" : "Create world",
      exact: true,
    })
    .click();
  await page
    .getByLabel(
      locale === "zh-CN"
        ? "创建世界的内容包"
        : "Content package for the new world",
    )
    .selectOption(source.localId);
  return source.localId;
}
async function createdWorldId(page: Page, title: string) {
  const workspace = await runtime<{
    worlds: { worldId: string; title: string }[];
  }>(page, { type: "workspace.read" });
  return workspace.worlds.find((world) => world.title === title)!.worldId;
}

test("manage templates and apply the automatically opened protagonist revision before first play", async ({
  page,
}) => {
  const title = "主角验收世界";
  const source = await setup(page, "zh-CN", title);
  await expect(page.getByLabel("主角模板", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "管理主角模板" }).click();
  const manager = page.getByRole("dialog", { name: "管理主角模板" });
  await manager.getByLabel("模板名称").fill("冷静调查员");
  await manager
    .getByLabel("模板正文")
    .fill("# 独立模板标记\nName: Custom Investigator\nPersonality: Calm.");
  await manager.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "冷静调查员", exact: true }),
  ).toBeVisible();
  await manager.getByRole("button", { name: "复制", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "冷静调查员", exact: true }),
  ).toHaveCount(2);
  await manager.getByLabel("模板名称").fill("临时副本");
  await manager.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "临时副本", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await manager.getByRole("button", { name: "删除", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "临时副本", exact: true }),
  ).toHaveCount(0);
  await manager.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "新建世界", exact: true })
    .click();
  await page.getByLabel("创建世界的内容包").selectOption(source);
  const templates = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.read",
  });
  await page
    .getByLabel("主角模板", { exact: true })
    .selectOption(templates.templates[0]!.id);
  const sent: V1Request[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/runtime/v1")
    ) {
      const next = (request.postDataJSON() as { request: V1Request }).request;
      if (next.type === "world.revision.message") sent.push(next);
    }
  });
  await page
    .getByRole("button", { name: "从当前内容包创建", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "应用并开始游玩", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Protagonist updated; review the changes before applying.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "world.revision.message",
    continuation: { kind: "fresh_context" },
  });
  expect(sent[0] && "message" in sent[0] ? sent[0].message : "").toContain(
    templates.templates[0]!.body,
  );
  expect(providerRequests.at(-2)).toContain("不要擅自新建");
  const worldId = await createdWorldId(page, title);
  const before = await runtime<{ head: string }>(page, {
    type: "world.read",
    worldId,
  });
  const epoch = (
    await runtime<V1WorldRevisionOverview>(page, {
      type: "world.revision.overview",
      worldId,
    })
  ).epoch!;
  expect(epoch.locked).toBe(true);
  expect(epoch.diff).toHaveLength(1);
  expect(epoch.diff[0]?.path).toBe("state/player.yaml");
  const playWhileLocked = await page.request.post("/api/runtime/v1", {
    data: {
      protocol: "narraeon.runtime/v1",
      request: {
        type: "play.chain.start",
        worldId,
        chainId: "locked-check",
        exchangeId: "locked-exchange",
        playerText: "Start",
      },
    },
  });
  expect(playWhileLocked.ok()).toBe(false);
  await expect(
    page.getByRole("button", { name: "应用并开始游玩", exact: true }),
  ).toHaveClass(/primary-button/u);
  await page
    .getByRole("button", { name: "应用并开始游玩", exact: true })
    .click();
  await expect(page.getByLabel("你的行动", { exact: true })).toBeVisible();
  const after = await runtime<{ head: string; worldRevision: unknown }>(page, {
    type: "world.read",
    worldId,
  });
  expect(after.head).not.toBe(before.head);
  expect(after.worldRevision).toBeNull();
  const state = await runtime<unknown>(page, {
    type: "world.surface.read",
    worldId,
    surface: "state",
  });
  expect(JSON.stringify(state)).toContain("Name: Custom Investigator");
  const preview = await runtime<V1PlayContextReadingView>(page, {
    type: "world.play-context.read",
    worldId,
  });
  expect(preview.nextFreshContext?.head).toBe(after.head);
  expect(
    JSON.stringify(
      preview.nextFreshContext?.preview.compilation.logicalMessages,
    ),
  ).toContain("Custom Investigator");
  expect(JSON.stringify(preview.nextFreshContext?.preview)).not.toContain(
    "独立模板标记",
  );
  const packageAfter = await runtime<{ files: ContentTreeFile[] }>(page, {
    type: "content.read",
    packageId: source,
  });
  expect(
    packageAfter.files.find(({ path }) => path === "world/player.yaml")
      ?.contents,
  ).toContain("Default Player");
});

test("English template revision can be discarded and choosing None retains mechanical creation", async ({
  page,
}) => {
  const title = "Discard protagonist world";
  const source = await setup(page, "en", title);
  const view = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.save",
    name: "English template",
    body: "Name: Custom Investigator",
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Create world", exact: true })
    .click();
  await page
    .getByLabel("Content package for the new world")
    .selectOption(source);
  await page
    .getByLabel("Protagonist template", { exact: true })
    .selectOption(view.templates.at(-1)!.id);
  await page
    .getByRole("button", {
      name: "Create from current content package",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Protagonist updated; review the changes before applying.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: "Apply and start playing", exact: true }),
  ).toBeEnabled();
  expect(providerRequests.at(-2)).toContain("Do not create one on your own");
  const worldId = await createdWorldId(page, title);
  const before = await runtime<{ head: string }>(page, {
    type: "world.read",
    worldId,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByLabel("Your action", { exact: true })).toBeVisible();
  const after = await runtime<{ head: string; worldRevision: unknown }>(page, {
    type: "world.read",
    worldId,
  });
  expect(after.head).toBe(before.head);
  expect(after.worldRevision).toBeNull();
  expect(
    JSON.stringify(
      await runtime(page, {
        type: "world.surface.read",
        worldId,
        surface: "state",
      }),
    ),
  ).toContain("Name: Default Player");
  await page
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Create world", exact: true })
    .click();
  await page
    .getByLabel("Content package for the new world")
    .selectOption(source);
  await expect(
    page.getByLabel("Protagonist template", { exact: true }),
  ).toHaveValue("");
  const requestsBefore = providerRequests.length;
  await page
    .getByRole("button", {
      name: "Create from current content package",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Your action", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply and start playing", exact: true }),
  ).toHaveCount(0);
  expect(providerRequests).toHaveLength(requestsBefore);
});
