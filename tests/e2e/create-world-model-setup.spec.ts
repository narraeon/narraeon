import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentTreeFile,
  V1PlayTimelinePage,
  V1Request,
} from "../../src/protocol/v1.ts";
import type { ProtagonistTemplatesView } from "../../src/protocol/protagonistTemplates.ts";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright parses the destructured fixture dependencies.
  baseURL: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-create-model-setup-"));
    const servers = new RuntimeServerPool();
    try {
      const port = await availableRuntimePort();
      await servers.start(root, port);
      await use(`http://127.0.0.1:${port}`);
    } finally {
      await servers.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  },
});

const model = {
  name: "Model setup fixture",
  presetId: "custom",
  provider: "chat_completions",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "fixture-key",
  modelId: "fixture-model",
  contextWindowTokens: 128000,
  maxOutputTokens: 16000,
} as const;

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function prepareCreation(page: Page) {
  await runtime(page, { type: "preferences.save", locale: "en" });
  for (const name of ["Another source", "Chosen source"]) {
    const { localId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, { type: "content.rename", packageId: localId, name });
  }
  const { templates } = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.save",
    name: "Chosen protagonist",
    body: "# A protagonist for this world",
  });
  const { contentPackages } = await runtime<{
    contentPackages: { localId: string; title: string }[];
  }>(page, { type: "workspace.read" });
  const packageId = contentPackages.find(
    ({ title }) => title === "Chosen source",
  )!.localId;
  const templateId = templates[0]!.id;
  const creates: V1Request[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/runtime/v1")) return;
    const input = (request.postDataJSON() as { request: V1Request }).request;
    if (input.type === "world.create") creates.push(input);
  });
  await page.goto("/");
  await page
    .locator(".home-world-library")
    .getByRole("button", { name: "Create world", exact: true })
    .click();
  const packagePicker = page.getByRole("combobox", {
    name: "Content package for the new world",
  });
  const templatePicker = page.getByRole("combobox", {
    name: "Protagonist template",
    exact: true,
  });
  const create = page.getByRole("button", {
    name: "Create from current content package",
  });
  const configure = page.getByRole("button", {
    name: "Configure model connection",
    exact: true,
  });
  await packagePicker.selectOption(packageId);
  await templatePicker.selectOption(templateId);
  await expect(create).toBeEnabled();
  await configure.click();
  await expect(page).toHaveURL(/#\/models$/u);
  return {
    packageId,
    templateId,
    packagePicker,
    templatePicker,
    create,
    creates,
    expectSelection: async () => {
      await expect(page).toHaveURL(/#\/create$/u);
      await expect(packagePicker).toHaveValue(packageId);
      await expect(templatePicker).toHaveValue(templateId);
      await expect(
        page.getByRole("article", { name: "Opening preview" }),
      ).toContainText("Chosen source");
    },
  };
}

const modelId = (page: Page) => page.getByLabel("Model ID", { exact: true });
const save = (page: Page) =>
  page.getByRole("button", {
    name: "Save and enable model connection",
    exact: true,
  });

async function fillConnection(
  page: Page,
  baseUrl: string = model.baseUrl,
): Promise<void> {
  await page.getByLabel("Configuration name", { exact: true }).fill(model.name);
  await page.getByLabel("Base URL", { exact: true }).fill(baseUrl);
  await page.getByLabel("API Key", { exact: true }).fill(model.apiKey);
  await modelId(page).fill(model.modelId);
}

test("create and reopen before model setup, then send the preserved action once", async ({
  page,
}) => {
  const modelRequests: {
    model: string;
    messages: { content?: string }[];
  }[] = [];
  const reply = "The ferryman opens the gate.";
  const provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      modelRequests.push(JSON.parse(body) as (typeof modelRequests)[number]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("Provider fixture has no port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const title = "Unconnected harbor";
    const opening = "A brass lamp burns beside the eastern gate.";
    const draft = "I knock on the black iron gate twice.";
    const note = "Keep the ferryman's reply brief.";
    await runtime(page, { type: "preferences.save", locale: "en" });
    const { localId: packageId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, { type: "content.rename", packageId, name: title });
    const { files, treeRevision } = await runtime<{
      files: ContentTreeFile[];
      treeRevision: string;
    }>(page, { type: "content.read", packageId });
    await runtime(page, {
      type: "content.replace",
      packageId,
      baseTreeRevision: treeRevision,
      files: files.map((file) =>
        file.path === "opening.md" ? { ...file, contents: opening } : file,
      ),
    });
    const playCommands: V1Request[] = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/runtime/v1")) return;
      const input = (request.postDataJSON() as { request: V1Request }).request;
      if (
        input.type === "play.chain.start" ||
        input.type === "play.chain.append"
      )
        playCommands.push(input);
    });
    await page.goto("/");
    await page
      .locator(".home-world-library")
      .getByRole("button", { name: "Create world", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Content package for the new world" })
      .selectOption(packageId);
    await expect(
      page.getByRole("article", { name: "Opening preview" }),
    ).toContainText(opening);
    await page
      .getByRole("button", { name: "Create from current content package" })
      .click();
    const story = page.getByRole("article", { name: "Story timeline" });
    await expect(story.getByText(opening, { exact: true })).toBeVisible();
    const { worlds } = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const worldId = worlds.find(
      (candidate) => candidate.title === title,
    )!.worldId;
    const worldUrl = page.url();
    expect(new URL(worldUrl).hash).toBe(`#/world/${worldId}`);
    const read = () =>
      runtime<{ head: string; playTimeline: V1PlayTimelinePage }>(page, {
        type: "world.read",
        worldId,
      });
    const expectOnlyOpening = async () => {
      const world = await read();
      expect(world.head).toBe("genesis");
      expect(world.playTimeline.activeChainId).toBeNull();
      expect(world.playTimeline.items).toMatchObject([
        { kind: "genesis", role: "narrator", exactText: opening },
      ]);
      expect(modelRequests).toHaveLength(0);
      expect(playCommands).toHaveLength(0);
    };
    await expectOnlyOpening();

    await page
      .getByRole("button", { name: "Back to workspace", exact: true })
      .click();
    await page.getByRole("button", { name: `Open world: ${title}` }).click();
    await page.reload();
    await expect(story.getByText(opening, { exact: true })).toBeVisible();
    const action = page.getByRole("textbox", {
      name: "Your action",
      exact: true,
    });
    const send = page.getByRole("button", {
      name: "Send action from a fresh context",
    });
    const configure = page.getByRole("button", {
      name: "Configure model",
      exact: true,
    });
    await action.fill(draft);
    await action.press("Enter");
    await expect(send).toBeDisabled();
    await page.getByLabel("More", { exact: true }).click();
    await page
      .getByRole("button", { name: "One-turn request", exact: true })
      .click();
    const noteInput = page.getByRole("textbox", {
      name: "One-turn request text",
    });
    await noteInput.fill(note);

    await configure.click();
    await fillConnection(page);
    const routePattern = "**/api/runtime/v1";
    await page.route(routePattern, async (route) => {
      const input = (route.request().postDataJSON() as { request: V1Request })
        .request;
      if (input.type !== "model.save") return route.continue();
      await route.fulfill({
        status: 400,
        json: {
          protocol: "narraeon.runtime/v1",
          error: { code: "invalid_request", message: "Fixture save rejected." },
        },
      });
    });
    await save(page).click();
    await expect(
      page.getByText("Fixture save rejected.", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/#\/models$/u);
    await page
      .getByRole("button", { name: "Back to world", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard and leave", exact: true })
      .click();
    await expect(page).toHaveURL(worldUrl);
    await expect(story.getByText(opening, { exact: true })).toBeVisible();
    await expect(action).toHaveValue(draft);
    await expect(noteInput).toHaveValue(note);
    await expect(send).toBeDisabled();
    await expectOnlyOpening();
    await page.unroute(routePattern);

    await configure.click();
    await fillConnection(page, baseUrl);
    await save(page).click();
    await expect(page).toHaveURL(worldUrl);
    await expect(action).toHaveValue(draft);
    await expect(noteInput).toHaveValue(note);
    await expect(send).toBeEnabled();
    await expectOnlyOpening();

    // Change the active connection after setup has returned to the world.
    await runtime(page, {
      type: "model.save",
      connection: {
        ...model,
        baseUrl,
        name: "Active at send",
        modelId: "active-at-send",
      },
    });
    await send.click();
    await expect(story.getByText(reply, { exact: true })).toBeVisible();
    await expect(action).toHaveValue("");
    expect(playCommands).toMatchObject([
      { type: "play.chain.start", worldId, playerText: draft, turnNote: note },
    ]);
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.model).toBe("active-at-send");
    const messages = JSON.stringify(modelRequests[0]?.messages);
    expect(messages.split(opening)).toHaveLength(2);
    expect(messages.split(draft)).toHaveLength(2);
    const played = await read();
    expect(played.head).toBe("commit:2");
    expect(
      played.playTimeline.items.filter(
        (item) => item.kind === "event" && item.event.kind === "player",
      ),
    ).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("the content editor can create a world without a model and browser Back keeps the draft", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "navigation", { value: undefined }),
  );
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const { localId: packageId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await page.goto(`/#/content/${packageId}`);
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "创建世界", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/world\/[^/]+$/u);
  const worldUrl = page.url();
  const story = page.getByRole("article", { name: "故事时间线" });
  await expect(story.locator(".narrator-message")).toHaveCount(1);
  const draft = "我在门边停下，听里面的声音。";
  const action = page.getByRole("textbox", { name: "你的行动" });
  await action.fill(draft);
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page).toHaveURL(/#\/models$/u);
  await page.goBack();
  await expect(page).toHaveURL(worldUrl);
  await expect(action).toHaveValue(draft);
  await expect(story.locator(".narrator-message")).toHaveCount(1);
  await expect(story.locator(".player-message")).toHaveCount(0);
});

for (const supportsNavigationApi of [true, false]) {
  test(`a save returns to the same creation entry and preserves both choices (Navigation API: ${supportsNavigationApi})`, async ({
    page,
  }) => {
    if (!supportsNavigationApi)
      await page.addInitScript(() =>
        Object.defineProperty(window, "navigation", { value: undefined }),
      );
    const setup = await prepareCreation(page);
    await fillConnection(page);
    await save(page).click();
    await setup.expectSelection();
    await expect(setup.create).toBeEnabled();

    await page.goBack();
    await expect(page).toHaveURL(/#\/$/u);
    await page.goForward();
    await setup.expectSelection();
    await page.reload();
    await setup.expectSelection();
    await expect(setup.create).toBeEnabled();
    expect(setup.creates).toEqual([]);
    expect(
      (await runtime<{ worlds: unknown[] }>(page, { type: "workspace.read" }))
        .worlds,
    ).toEqual([]);
  });
}

for (const leaveWhileEnabling of [false, true]) {
  test(`enabling a saved connection respects the model settings visit (leave: ${leaveWhileEnabling})`, async ({
    page,
  }) => {
    const setup = await prepareCreation(page);
    const connectionName = "First connection";
    const { activeConnectionId } = await runtime<ModelConnectionLibraryView>(
      page,
      {
        type: "model.save",
        connection: { ...model, name: connectionName },
      },
    );
    await runtime(page, {
      type: "model.save",
      connection: { ...model, name: "Second connection" },
    });
    // Reload the workspace projection in this visit by changing its language.
    await page
      .getByRole("combobox", { name: "Interface language" })
      .selectOption("zh-CN");
    await page.getByRole("combobox", { name: "界面语言" }).selectOption("en");
    const row = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: connectionName, exact: true }),
    });
    const enable = row.getByRole("button", {
      name: "Switch to this configuration",
    });
    await expect(enable).toBeEnabled();
    await expect(page).toHaveURL(/#\/models$/u);

    if (leaveWhileEnabling) {
      const receiptDelivered = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/runtime/v1") &&
          (response.request().postDataJSON() as { request: V1Request }).request
            .type === "model.select",
      );
      let release: () => void = () => undefined;
      const holdReceipt = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/runtime/v1", async (route) => {
        const input = (route.request().postDataJSON() as { request: V1Request })
          .request;
        if (input.type !== "model.select") return route.continue();
        const response = await route.fetch();
        await holdReceipt;
        await route.fulfill({ response });
      });
      try {
        await enable.click();
        await page
          .getByRole("button", { name: "Back to workspace", exact: true })
          .click();
        await expect(page).toHaveURL(/#\/$/u);
      } finally {
        release();
      }
      expect((await receiptDelivered).ok()).toBe(true);
      await expect(
        page.getByText(
          "Active model updated (no automatic fallback on errors).",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(/#\/$/u);
    } else {
      await enable.click();
      await setup.expectSelection();
      await expect(setup.create).toBeEnabled();
    }
    expect(
      (await runtime<ModelConnectionLibraryView>(page, { type: "model.read" }))
        .activeConnectionId,
    ).toBe(activeConnectionId);
    expect(setup.creates).toEqual([]);
  });
}

test.describe("rejected model setup", () => {
  test("a failed command and a configured read leave the model draft in place", async ({
    page,
  }) => {
    const setup = await prepareCreation(page);
    await fillConnection(page);
    const routePattern = "**/api/runtime/v1";
    await runtime(page, {
      type: "model.save",
      connection: { ...model, name: "Saved elsewhere" },
    });
    await page.route(routePattern, async (route) => {
      const input = (route.request().postDataJSON() as { request: V1Request })
        .request;
      if (input.type !== "model.save") return route.continue();
      await route.fulfill({
        status: 400,
        json: {
          protocol: "narraeon.runtime/v1",
          error: { code: "invalid_request", message: "Fixture save rejected." },
        },
      });
    });
    await save(page).click();
    await expect(
      page.getByText("Fixture save rejected.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Saved elsewhere", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/#\/models$/u);
    await expect(modelId(page)).toHaveValue(model.modelId);

    await page.goBack();
    await page
      .getByRole("dialog", { name: /unsaved changes/iu })
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page).toHaveURL(/#\/models$/u);
    await expect(modelId(page)).toHaveValue(model.modelId);

    await page.unroute(routePattern);
    await save(page).click();
    await setup.expectSelection();
    await expect(setup.create).toBeEnabled();
    expect(setup.creates).toEqual([]);
  });
});

for (const exit of ["reload", "leave"] as const) {
  test.describe(`creation model settings after ${exit}`, () => {
    test("a later model save stays in ordinary settings", async ({ page }) => {
      const setup = await prepareCreation(page);
      if (exit === "reload") {
        await page.reload();
      } else {
        await page.goBack();
        await setup.expectSelection();
        await page
          .getByRole("button", { name: "Model settings", exact: true })
          .click();
      }
      await fillConnection(page);
      await save(page).click();
      await expect(
        page.getByText(
          "The model connection was saved and enabled. Later requests use only the current configuration.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(/#\/models$/u);
      await page.goBack();
      await setup.expectSelection();
      await expect(setup.create).toBeEnabled();
      expect(setup.creates).toEqual([]);
    });
  });
}

test.describe("creation sources removed during setup", () => {
  test("a saved connection returns with the missing choices cleared", async ({
    page,
  }) => {
    const setup = await prepareCreation(page);
    await runtime(page, { type: "content.delete", packageId: setup.packageId });
    await runtime(page, {
      type: "protagonist-templates.delete",
      id: setup.templateId,
    });
    await fillConnection(page);
    await save(page).click();
    await expect(page).toHaveURL(/#\/create$/u);
    await expect(
      page.getByText("Content package not found.", { exact: true }),
    ).toBeVisible();
    await expect(setup.packagePicker).toHaveValue("");
    await expect(setup.templatePicker).toHaveValue("");
    await expect(setup.create).toBeDisabled();
    expect(setup.creates).toEqual([]);
  });
});
