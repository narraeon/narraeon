import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Request } from "../../src/protocol/v1.ts";
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

async function fillConnection(page: Page): Promise<void> {
  await page.getByLabel("Configuration name", { exact: true }).fill(model.name);
  await page.getByLabel("Base URL", { exact: true }).fill(model.baseUrl);
  await page.getByLabel("API Key", { exact: true }).fill(model.apiKey);
  await modelId(page).fill(model.modelId);
}

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
