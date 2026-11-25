import { expect, type Page } from "@playwright/test";
import type {
  CopyModelConnectionResult,
  ModelConnectionLibraryView,
} from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/CurrentTreeContentLibrary.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "workspace-language" });

test.beforeEach(async ({ page }) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
});

test("language changes keep the content-package draft and selected file", async ({
  page,
}) => {
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const filePath = "world/current-situation.yaml";
  await page.goto(`/#/content/${localId}`);
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page
    .getByRole("button", { name: `打开 ${filePath}`, exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: /^(编辑|Edit) world\/current-situation\.yaml$/u,
  });
  const draft = `${await editor.inputValue()}\n# The lantern still burns.\n`;
  await editor.fill(draft);
  await editor.press("ArrowLeft");
  const caret = await editor.evaluate(
    (element: HTMLTextAreaElement) => element.selectionStart,
  );

  await switchLanguage(page, "en");
  await expect(
    page.getByRole("button", { name: `Open ${filePath}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toHaveValue(draft);
  await expect(editor).toHaveJSProperty("selectionStart", caret);
  await expect(
    page.getByText("Draft not saved", { exact: true }),
  ).toBeVisible();
  const original = await runtime<EditableContentPackageDetail>(page, {
    type: "content.read",
    packageId: localId,
  });
  expect(
    original.files.find(({ path }) => path === filePath)?.contents,
  ).not.toBe(draft);

  await switchLanguage(page, "zh-CN");
  await expect(editor).toHaveValue(draft);
  await expect(editor).toHaveJSProperty("selectionStart", caret);
  await expect(page).toHaveURL(new RegExp(`#/content/${localId}$`, "u"));
  await page.getByRole("button", { name: "整批保存", exact: true }).click();
  await expect(page.getByText("当前树已保存", { exact: true })).toBeVisible();
  const saved = await runtime<EditableContentPackageDetail>(page, {
    type: "content.read",
    packageId: localId,
  });
  expect(saved.files.find(({ path }) => path === filePath)?.contents).toBe(
    draft,
  );
});

test("a localized orchestration refresh keeps the open prompt and saves its edits", async ({
  page,
}) => {
  const before = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const preset = before.presets.find(
    ({ id }) => id === before.currentPresetId,
  )!;
  const alternative = await runtime<{ preset: { id: string } }>(page, {
    type: "play.create",
    name: "Separate active orchestration",
  });
  await runtime(page, { type: "play.select", presetId: alternative.preset.id });
  await page.goto(`/#/orchestrations/${preset.id}`);
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u })
    .click();
  const name = page.getByRole("textbox", {
    name: /^(编排方案名称|Orchestration name)$/u,
  });
  await name.fill("Edited orchestration");
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  const prompt = page.getByRole("textbox", {
    name: /^(提示词正文|Prompt text)$/u,
  });
  await prompt.fill("Preserve the lantern's light.");

  await switchLanguage(page, "en");
  await expect(
    page.getByText("Interface language saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Switch orchestration")).toHaveValue(preset.id);
  await expect(
    page.getByRole("button", { name: "新提示词", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(prompt).toHaveValue("Preserve the lantern's light.");
  await page
    .locator("summary")
    .filter({ hasText: /^Orchestration actions$/u })
    .click();
  await expect(name).toHaveValue("Edited orchestration");
  await expect(page).toHaveURL(
    new RegExp(`#/orchestrations/${preset.id}$`, "u"),
  );

  const refreshed = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  expect(refreshed.currentPresetId).toBe(alternative.preset.id);
  const refreshedPreset = refreshed.presets.find(({ id }) => id === preset.id);
  expect(refreshedPreset?.revision).not.toBe(preset.revision);
  expect(refreshedPreset?.name).toBe(preset.name);
  expect(refreshedPreset?.draft).toBeUndefined();

  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Orchestration saved.", { exact: true }),
  ).toBeVisible();
  const saved = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const savedPreset = saved.presets.find(({ id }) => id === preset.id);
  expect(savedPreset?.name).toBe("Edited orchestration");
  expect(Object.values(savedPreset?.draft?.files ?? {}).join("\n")).toContain(
    "Preserve the lantern's light.",
  );
});

test("language changes keep the selected follow-up output, renderer, and preview draft", async ({
  page,
}) => {
  const created = await runtime<{ preset: { id: string } }>(page, {
    type: "play.create",
    name: "Follow-up locale fixture",
  });
  await page.goto(`/#/orchestrations/${created.preset.id}`);
  await page.getByRole("button", { name: "新增后置请求", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "后置请求名称" })).toHaveValue(
    "新后置请求",
  );
  await page.getByRole("button", { name: "界面产物", exact: true }).click();
  await page
    .getByRole("combobox", { name: "产物显示位置", exact: true })
    .selectOption("sidebar");
  await page
    .getByRole("button", { name: "新建 HTML 模板", exact: true })
    .click();
  const renderer = page.getByRole("textbox", { name: "HTML", exact: true });
  const html = "<h2>Follow-up example</h2><!-- narraeon:content -->";
  await renderer.fill(html);
  await page.getByText("游玩效果预览 · 就地展开", { exact: true }).click();
  const input = page.getByRole("textbox", {
    name: /^(本页输入草稿（尚未发送）|Local input draft \(not sent\))$/u,
  });
  await input.fill("Keep this sample draft.");

  await switchLanguage(page, "en");
  await expect(
    page.getByRole("button", { name: "Outputs", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Interface outputs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Output position", exact: true }),
  ).toHaveValue("sidebar");
  await expect(
    page.getByRole("combobox", { name: "Renderer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Play preview · expand here", { exact: true }),
  ).toBeVisible();
  await expect(renderer).toHaveValue(html);
  await expect(input).toHaveValue("Keep this sample draft.");

  await switchLanguage(page, "zh-CN");
  await expect(
    page.getByRole("combobox", { name: "产物显示位置", exact: true }),
  ).toHaveValue("sidebar");
  await expect(renderer).toHaveValue(html);
  await expect(input).toHaveValue("Keep this sample draft.");
});

test("a keyboard language change keeps picker focus and a selected model draft", async ({
  page,
}) => {
  const library = await runtime<ModelConnectionLibraryView>(page, {
    type: "model.save",
    connection: {
      name: "Active fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "fixture-key",
      modelId: "active-model",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
  const { copiedConnectionId: connectionId } =
    await runtime<CopyModelConnectionResult>(page, {
      type: "model.copy",
      connectionId: library.activeConnectionId!,
      name: "Choose this connection",
    });
  const refreshing = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  const savingModel = Promise.withResolvers<void>();
  const releaseModelSave = Promise.withResolvers<void>();
  let localeWrites = 0;
  let workspaceReads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type === "preferences.save") localeWrites++;
    if (request.type === "workspace.read" && localeWrites === 1) {
      workspaceReads++;
      refreshing.resolve();
      await releaseRefresh.promise;
    }
    if (request.type === "model.save") {
      savingModel.resolve();
      await releaseModelSave.promise;
    }
    await route.continue();
  });

  await page.goto("/#/models");
  const card = page
    .getByRole("article")
    .filter({ hasText: "Choose this connection" });
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  const name = page.getByRole("textbox", {
    name: /^(配置名称|Configuration name)$/u,
  });
  const modelId = page.getByRole("textbox", { name: /^(模型 ID|Model ID)$/u });
  await name.fill("Edited connection name");
  await modelId.fill("edited-model");
  await page.getByText("高级协议选项", { exact: true }).click();

  const picker = languagePicker(page);
  await picker.focus();
  await page.keyboard.press("e");
  try {
    await expect(picker).toHaveValue("en");
    await refreshing.promise;
    await expect(picker).toBeDisabled();
    await expect(picker).toBeFocused();
    await picker.evaluate((select: HTMLSelectElement) => {
      select.value = "zh-CN";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(picker).toHaveValue("en");
    await expect(picker).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(picker).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(picker).toBeFocused();
  } finally {
    releaseRefresh.resolve();
  }
  await expect(picker).toBeEnabled();
  await expect(picker).toBeFocused();
  await expect(name).toHaveValue("Edited connection name");
  await expect(modelId).toHaveValue("edited-model");
  await expect(
    card.getByRole("button", { name: "Editing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Advanced protocol options", { exact: true }).locator(".."),
  ).toHaveAttribute("open", "");
  expect(localeWrites).toBe(1);
  expect(workspaceReads).toBe(1);
  await switchLanguage(page, "zh-CN");
  await expect(picker).toHaveValue("zh-CN");
  await expect(picker).toBeFocused();
  await expect(name).toHaveValue("Edited connection name");
  await expect(modelId).toHaveValue("edited-model");
  await expect(page).toHaveURL(/#\/models$/u);

  await page
    .getByRole("button", { name: "保存模型连接并启用", exact: true })
    .click();
  try {
    await savingModel.promise;
    await expect(picker).toBeDisabled();
  } finally {
    releaseModelSave.resolve();
  }
  await expect(picker).toBeEnabled();
  const saved = await runtime<ModelConnectionLibraryView>(page, {
    type: "model.read",
  });
  expect(saved.activeConnectionId).toBe(connectionId);
  expect(saved.connections.find(({ id }) => id === connectionId)).toMatchObject(
    {
      name: "Edited connection name",
      modelId: "edited-model",
    },
  );
  expect(localeWrites).toBe(2);
});

function languagePicker(page: Page) {
  return page.getByRole("combobox", {
    name: /^(界面语言|Interface language)$/u,
  });
}

async function switchLanguage(page: Page, locale: "en" | "zh-CN") {
  const picker = languagePicker(page);
  await expect(picker).toBeEnabled();
  await picker.selectOption(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(picker).toBeEnabled();
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
