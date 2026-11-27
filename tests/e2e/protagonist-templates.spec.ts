import { createServer, type Server } from "node:http";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/isolatedRuntimeTest.ts";
import type {
  ContentTreeFile,
  V1PlayContextReadingView,
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
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
      const userText = last?.role === "user" ? String(last.content) : "";
      if (
        userText.includes("Retry fixture profile") &&
        providerRequests.filter((request) =>
          request.includes("Retry fixture profile"),
        ).length === 1
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Fixture customization failure" },
          }),
        );
        return;
      }
      const delta = userText.includes("Ask for a detail")
        ? { content: "Which name should I use for your protagonist?" }
        : last?.role === "user"
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
async function setup(
  page: Page,
  locale: "en" | "zh-CN",
  title: string,
  configureModel = true,
) {
  await runtime(page, { type: "preferences.save", locale });
  if (configureModel) {
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
  } else {
    const { connections } = await runtime<ModelConnectionLibraryView>(page, {
      type: "model.read",
    });
    for (const connection of connections)
      await runtime(page, {
        type: "model.delete",
        connectionId: connection.id,
      });
  }
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
    .locator(".home-world-library")
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

test("template manager contains focus and dismisses only the topmost dialog", async ({
  page,
}) => {
  await setup(page, "en", "Template keyboard", false);
  const opener = page.getByRole("button", {
    name: "Manage protagonist templates",
  });
  const manager = page.getByRole("dialog", {
    name: "Manage protagonist templates",
  });
  const close = manager.getByRole("button", { name: "Close", exact: true });
  const name = manager.getByLabel("Template name");
  const body = manager.getByLabel("Template body");
  const androidBack = () =>
    page.evaluate(() =>
      (
        window as { narraeonAndroidBack?: () => boolean }
      ).narraeonAndroidBack?.(),
    );

  await opener.click();
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(body).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await opener.evaluate((button) => button.focus());
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(manager).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await name.fill("Draft");
  await page.keyboard.press("Escape");
  const confirmation = page.getByRole("dialog", {
    name: "Discard unsaved protagonist template changes?",
  });
  const cancel = confirmation.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  const discard = confirmation.getByRole("button", {
    name: "Discard",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(discard).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(close).toBeFocused();
  await expect(name).toHaveValue("Draft");

  expect(await androidBack()).toBe(true);
  await expect(cancel).toBeFocused();
  expect(await androidBack()).toBe(true);
  await expect(close).toBeFocused();
  await close.click();
  await discard.click();
  await expect(opener).toBeFocused();

  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => (releaseSave = resolve));
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type === "protagonist-templates.save") await holdSave;
    await route.continue();
  });
  await opener.click();
  await name.fill("Saved template");
  await body.fill("The template body.");
  const save = manager.getByRole("button", { name: "Save", exact: true });
  try {
    await save.click();
    await expect(close).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(await androidBack()).toBe(true);
    await expect(manager).toBeVisible();
    await expect(confirmation).toHaveCount(0);
  } finally {
    releaseSave();
  }
  await expect(close).toBeEnabled();
  await expect(
    manager.getByRole("button", { name: "Saved template", exact: true }),
  ).toBeVisible();
  expect(await androidBack()).toBe(true);
  await expect(manager).toHaveCount(0);
  await expect(opener).toBeFocused();
  const { templates } = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.read",
  });
  const saved = templates.find(
    (template) => template.name === "Saved template",
  );
  expect(saved).toBeDefined();
  await runtime(page, { type: "protagonist-templates.delete", id: saved!.id });
});

test("review and explicitly apply a Chinese protagonist customization on a narrow screen", async ({
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
  await manager.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除主角模板“临时副本”？" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(
    manager.getByRole("button", { name: "临时副本", exact: true }),
  ).toHaveCount(0);
  await manager.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page.getByLabel("创建世界的内容包").selectOption(source);
  const templates = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.read",
  });
  await page
    .getByLabel("主角模板", { exact: true })
    .selectOption(templates.templates[0]!.id);
  await page.setViewportSize({ width: 390, height: 840 });
  const sent: V1Request[] = [];
  const creationRequests: V1Request[] = [];
  const beforeProvider = providerRequests.length;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/runtime/v1")
    ) {
      const next = (request.postDataJSON() as { request: V1Request }).request;
      if (next.type === "world.revision.message") sent.push(next);
      if (next.type === "world.create") creationRequests.push(next);
    }
  });
  const create = page.getByRole("button", {
    name: "从当前内容包创建",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await create.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  const card = page.getByRole("region", { name: "确认你的主角" });
  await expect(card.getByRole("heading", { name: "冷静调查员" })).toBeVisible();
  await expect(card.getByText("独立模板标记", { exact: true })).toBeVisible();
  const worldId = await createdWorldId(page, title);
  const before = await runtime<{ head: string; worldRevision: unknown }>(page, {
    type: "world.read",
    worldId,
  });
  expect(before.worldRevision).toBeNull();
  expect(creationRequests).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(providerRequests).toHaveLength(beforeProvider);
  const address = page.url();
  await page.reload();
  await expect(page).toHaveURL(address);
  await expect(card.getByRole("heading", { name: "冷静调查员" })).toBeVisible();
  expect(
    await card.evaluate((element) => element.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const confirm = card.getByRole("button", { name: "确认并定制", exact: true });
  await expect(confirm).toBeEnabled();
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(
    card.getByRole("button", { name: "应用并开始游玩", exact: true }),
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
  await page.reload();
  await expect(
    card.getByText("Protagonist updated; review the changes before applying."),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(providerRequests).toHaveLength(beforeProvider + 2);
  await card.getByText("state/player.yaml", { exact: true }).click();
  await expect(
    card.getByRole("table", { name: "state/player.yaml" }),
  ).toContainText("Name: Custom Investigator");
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
  await page.reload();
  await expect(page.getByLabel("你的行动", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
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
  const card = page.getByRole("region", { name: "Confirm your protagonist" });
  await expect(
    card.getByText("English template", { exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Advanced world revision" }).click();
  await expect(
    page.getByText("World play is unlocked", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply and start playing" }),
  ).toHaveCount(0);
  const untouchedWorldId = await createdWorldId(page, title);
  const untouched = await runtime<{ worldRevision: unknown }>(page, {
    type: "world.read",
    worldId: untouchedWorldId,
  });
  expect(untouched.worldRevision).toBeNull();
  await expect(
    page.getByRole("button", { name: "Return to protagonist confirmation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Return to protagonist confirmation" })
    .click();
  await card.getByRole("button", { name: "Confirm and customize" }).click();
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
  await card
    .getByRole("button", { name: "Discard customization and read opening" })
    .click();
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
    .locator(".home-world-library")
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

async function selectTemplateAndCreate(
  page: Page,
  name: string,
  body: string,
): Promise<void> {
  const { templates } = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.save",
    name,
    body,
  });
  await page.reload();
  const template = templates.find((item) => item.name === name)!;
  await page
    .getByLabel("Protagonist template", { exact: true })
    .selectOption(template.id);
  await page
    .getByRole("button", {
      name: "Create from current content package",
      exact: true,
    })
    .click();
}

test("create with no model, set one up, and return to the same template before confirming", async ({
  page,
}) => {
  const title = "Offline protagonist world";
  await setup(page, "en", title, false);
  const providerCount = providerRequests.length;
  await selectTemplateAndCreate(
    page,
    "Offline traveller",
    "Travels by starlight.",
  );
  const card = page.getByRole("region", { name: "Confirm your protagonist" });
  await expect(card).toBeVisible();
  const worldId = await createdWorldId(page, title);
  const address = page.url();
  await expect(
    card.getByText("Connect a model to customize your protagonist with AI."),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Confirm and customize" }),
  ).toHaveCount(0);
  expect(
    (await runtime<ModelConnectionLibraryView>(page, { type: "model.read" }))
      .configured,
  ).toBe(false);
  expect(
    (
      await runtime<{ worldRevision: unknown }>(page, {
        type: "world.read",
        worldId,
      })
    ).worldRevision,
  ).toBeNull();

  const configure = card.getByRole("button", {
    name: "Configure model connection",
    exact: true,
  });
  await configure.click();
  await expect(page).toHaveURL(/#\/models$/u);
  await page.goBack();
  await expect(page).toHaveURL(address);
  await expect(card.getByText("Travels by starlight.")).toBeVisible();

  await configure.click();
  await page
    .getByLabel("Configuration name", { exact: true })
    .fill("Restored connection");
  await page.getByLabel("Base URL", { exact: true }).fill(providerUrl);
  await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await page.getByLabel("Model ID", { exact: true }).fill("protagonist-model");
  await page
    .getByRole("button", {
      name: "Save and enable model connection",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(address);
  await expect(card.getByText("Travels by starlight.")).toBeVisible();
  const confirm = card.getByRole("button", { name: "Confirm and customize" });
  await expect(confirm).toBeEnabled();
  expect(providerRequests).toHaveLength(providerCount);
  expect(
    (
      await runtime<{ worldRevision: unknown }>(page, {
        type: "world.read",
        worldId,
      })
    ).worldRevision,
  ).toBeNull();

  await confirm.click();
  await expect(
    card.getByText("Protagonist updated; review the changes before applying."),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(providerCount + 2);
  const { worlds } = await runtime<{ worlds: { title: string }[] }>(page, {
    type: "workspace.read",
  });
  expect(worlds.filter((world) => world.title === title)).toHaveLength(1);
});

test("skip a selected template and reopen the original opening without a model", async ({
  page,
}) => {
  const title = "Read without connecting";
  await setup(page, "en", title, false);
  const providerCount = providerRequests.length;
  await selectTemplateAndCreate(
    page,
    "Skip profile",
    "No customization confirm.",
  );
  const card = page.getByRole("region", { name: "Confirm your protagonist" });
  await expect(card.getByText("No customization confirm.")).toBeVisible();
  const worldId = await createdWorldId(page, title);
  const readWorld = () =>
    runtime<{ head: string; worldRevision: unknown }>(page, {
      type: "world.read",
      worldId,
    });
  const before = await readWorld();
  await card.getByRole("button", { name: "Skip and read opening" }).click();
  const story = page.getByRole("article", { name: "Story timeline" });
  await expect(story).toContainText(
    "You stand at the threshold of a world still waiting to be written.",
  );
  await page.reload();
  await expect(story).toContainText(
    "You stand at the threshold of a world still waiting to be written.",
  );
  await expect(card).toHaveCount(0);
  expect(providerRequests).toHaveLength(providerCount);
  expect(await readWorld()).toMatchObject({
    head: before.head,
    worldRevision: null,
  });
});

test("a customization request can ask for more information and resume after reload", async ({
  page,
}) => {
  await setup(page, "en", "Clarification world");
  const providerCount = providerRequests.length;
  await selectTemplateAndCreate(page, "Question profile", "Ask for a detail");
  const card = page.getByRole("region", { name: "Confirm your protagonist" });
  await card.getByRole("button", { name: "Confirm and customize" }).click();
  await expect(
    card.getByText("Which name should I use for your protagonist?"),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Apply and start playing" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    card.getByText("Which name should I use for your protagonist?"),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(providerCount + 1);
  await card
    .getByLabel("Additional details")
    .fill("Use Custom Investigator as the name.");
  await card.getByRole("button", { name: "Send details" }).click();
  await expect(
    card.getByText("Protagonist updated; review the changes before applying."),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(providerCount + 3);
  await card.getByRole("button", { name: "Apply and start playing" }).click();
  await expect(page.getByLabel("Your action", { exact: true })).toBeVisible();
});

test("retry uses the saved revision after provider failure", async ({
  page,
}) => {
  const title = "Retry world";
  await setup(page, "en", title);
  const providerCount = providerRequests.length;
  await selectTemplateAndCreate(page, "Retry profile", "Retry fixture profile");
  const card = page.getByRole("region", { name: "Confirm your protagonist" });
  await card.getByRole("button", { name: "Confirm and customize" }).click();
  await expect(card.getByRole("alert")).toContainText(
    "Fixture customization failure",
  );
  await page.reload();
  await card.getByRole("button", { name: "Retry customization" }).click();
  await expect(
    card.getByText("Protagonist updated; review the changes before applying."),
  ).toBeVisible();
  const worldId = await createdWorldId(page, title);
  const overview = await runtime<V1WorldRevisionOverview>(page, {
    type: "world.revision.overview",
    worldId,
  });
  expect(
    overview.latest?.messages.filter(({ role }) => role === "user"),
  ).toHaveLength(1);
  expect(providerRequests).toHaveLength(providerCount + 3);
});

test("reload during creation recovers the same published world and keeps the template", async ({
  page,
}) => {
  const title = "Recover creation world";
  await setup(page, "en", title);
  const beforeProvider = providerRequests.length;
  let creates = 0;
  let publish!: () => void;
  const published = new Promise<void>((resolve) => (publish = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/runtime/v1", async (route) => {
    const request = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (request.type !== "world.create") return route.continue();
    creates += 1;
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    publish();
    await hold;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await selectTemplateAndCreate(
      page,
      "Recovered template",
      "Recorded before reload.",
    );
    await published;
    await page.reload();
    const card = page.getByRole("region", { name: "Confirm your protagonist" });
    await expect(card.getByText("Recorded before reload.")).toBeVisible();
    const { worlds } = await runtime<{ worlds: { title: string }[] }>(page, {
      type: "workspace.read",
    });
    expect(worlds.filter((world) => world.title === title)).toHaveLength(1);
    expect(creates).toBe(1);
    expect(providerRequests).toHaveLength(beforeProvider);
  } finally {
    release();
  }
});
