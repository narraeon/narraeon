import { expect, test, type Locator, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function dialogSurface(dialog: Locator) {
  return dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: style.border,
      borderRadius: style.borderRadius,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      backdrop: getComputedStyle(element, "::backdrop").backgroundColor,
    };
  });
}

const worldBookFile = {
  name: "harbor.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      entries: { 0: { uid: 0, comment: "Harbor", content: "A foggy port" } },
    }),
  ),
};

test("the current protagonist template has a visible editing marker", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  for (const name of ["Harbor guide", "Forest guide"])
    await runtime(page, {
      type: "protagonist-templates.save",
      name,
      body: name + " body",
    });

  await page.goto("/#/create");
  await page
    .getByRole("button", { name: "Manage protagonist templates" })
    .click();
  const manager = page.getByRole("dialog", {
    name: "Manage protagonist templates",
  });
  const library = manager.getByRole("navigation", {
    name: "Protagonist template list",
  });
  const harbor = library.getByRole("button", {
    name: "Harbor guide",
    exact: true,
  });
  const forest = library.getByRole("button", {
    name: "Forest guide",
    exact: true,
  });
  const create = library.getByRole("button", {
    name: "New protagonist template",
  });
  const name = manager.getByRole("textbox", { name: "Template name" });
  const border = (row: Locator) =>
    row.evaluate((element) => getComputedStyle(element).borderInlineStartColor);

  await harbor.click();
  await expect(harbor).toHaveAttribute("aria-pressed", "true");
  await expect(forest).toHaveAttribute("aria-pressed", "false");
  await name.click();
  expect.soft(await border(harbor)).not.toBe(await border(forest));
  await forest.focus();
  await page.keyboard.press("Enter");
  await expect(forest).toBeFocused();
  await expect(forest).toHaveAttribute("aria-pressed", "true");
  await expect(harbor).toHaveAttribute("aria-pressed", "false");
  await expect(forest).toHaveCSS("outline-style", "solid");
  await name.click();
  expect.soft(await border(forest)).not.toBe(await border(harbor));
  await create.click();
  await expect(create).toHaveAttribute("aria-pressed", "true");
  await expect(name).toHaveValue("");
  await name.click();
  expect(await border(create)).not.toBe(await border(forest));
});

test("opening a home content package is announced as an ordinary button", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: localId,
    name: "Guide to the harbor",
  });
  await page.goto("/#/");
  const open = page.getByRole("button", {
    name: "Open content package: Guide to the harbor",
  });
  await expect(open).toBeVisible();
  expect(await open.getAttribute("aria-pressed")).toBeNull();
  expect(await open.ariaSnapshot()).toContain(
    'button "Open content package: Guide to the harbor"',
  );
  await open.click();
  const destination = new RegExp("#/content/" + localId + "$", "u");
  await expect(page).toHaveURL(destination);

  const keyboardPage = await page.context().newPage();
  await keyboardPage.goto("/#/");
  await keyboardPage
    .getByRole("button", { name: "Open content package: Guide to the harbor" })
    .focus();
  await keyboardPage.keyboard.press("Enter");
  await expect(keyboardPage).toHaveURL(destination);
});

for (const { locale, route, width } of [
  { locale: "en", route: "/#/", width: 1440 },
  { locale: "zh-CN", route: "/#/library", width: 390 },
] as const) {
  test(`content import file controls open on demand and report selection (${locale})`, async ({
    browserName,
    page,
  }) => {
    const en = locale === "en";
    await runtime(page, { type: "preferences.save", locale });
    const { localId } = await runtime<{ localId: string }>(page, {
      type: "content.create-sample",
      locale,
    });
    const { base64 } = await runtime<{ base64: string }>(page, {
      type: "content.export",
      packageId: localId,
    });
    await page.setViewportSize({ width, height: 840 });
    await page.goto(route);
    const content = page.getByText(
      en
        ? "Import SillyTavern character card or world book"
        : "导入 SillyTavern 角色卡或世界书",
      { exact: true },
    );
    const zip = page.getByText(
      en ? "Import content package ZIP" : "导入内容包 ZIP",
      { exact: true },
    );
    const contentPicker = page.getByRole("button", {
      name: en ? "Choose character card or world book" : "选择角色卡或世界书",
    });
    const zipPicker = page.getByRole("button", {
      name: en ? "Choose content-package ZIP" : "选择内容包 ZIP",
    });
    const status = zip.locator("..").getByRole("status");

    await expect(zip.locator("..")).toHaveJSProperty("open", false);
    await zip.click();
    const nativeZip = zip.locator("..").locator("input[type=file]");
    await expect.soft(nativeZip).toBeHidden({ timeout: 500 });
    await zip.click();
    await expect(content).toHaveJSProperty("tagName", "SUMMARY");
    await expect(content.locator("..")).toHaveJSProperty("open", false);
    await content.focus();
    await page.keyboard.press("Enter");
    // Safari's default keyboard navigation reaches buttons with Option-Tab.
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(contentPicker).toBeFocused();
    const [contentChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.keyboard.press("Space"),
    ]);
    await contentChooser.setFiles(worldBookFile);
    const dialog = page.getByRole("dialog", {
      name: en
        ? "SillyTavern content import wizard"
        : "SillyTavern 内容导入向导",
    });
    await expect(
      dialog.getByText("A foggy port", { exact: true }),
    ).toBeVisible();
    const wizard = (await dialog.boundingBox())!;
    expect(wizard.x).toBeGreaterThanOrEqual(0);
    expect(wizard.x + wizard.width).toBeLessThanOrEqual(width);
    expect(wizard.y).toBeGreaterThanOrEqual(0);
    expect(wizard.y + wizard.height).toBeLessThanOrEqual(840);
    expect(
      await page.evaluate(() =>
        (
          window as { narraeonAndroidBack?: () => boolean }
        ).narraeonAndroidBack?.(),
      ),
    ).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(contentPicker).toBeFocused();

    await zip.click();
    await expect(status).toHaveText(en ? "Not selected" : "尚未选择");
    const [zipChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      zipPicker.click(),
    ]);
    await zipChooser.setFiles({
      name: "invalid.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("bad archive"),
    });
    await expect(status).toHaveText("invalid.zip · 11 B");
    const rect = (await zip.locator("..").boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    const submit = zip.locator("..").getByRole("button", {
      name: en ? "Import ZIP" : "导入 ZIP",
      exact: true,
    });
    await expect(zipPicker).toHaveAccessibleDescription("invalid.zip · 11 B");
    await submit.click();
    await expect(
      page.locator(".workspace-feedback").getByRole("status"),
    ).toBeVisible();
    await expect(status).toHaveText("invalid.zip · 11 B");
    await expect(zipPicker).toBeEnabled();
    await zipPicker.focus();
    const [retryChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.keyboard.press("Enter"),
    ]);
    await retryChooser.setFiles({
      name: "harbor-library.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(base64, "base64"),
    });
    await expect(status).toContainText("harbor-library.zip");
    await submit.click();
    await expect(page).toHaveURL(/#\/content\//u);
    expect(
      await runtime<{ contentPackages: { title: string }[] }>(page, {
        type: "workspace.read",
      }),
    ).toMatchObject({
      contentPackages: expect.arrayContaining([
        expect.objectContaining({ title: "harbor-library" }),
      ]),
    });
  });
}

test("the template and both SillyTavern dialogs use the workspace dialog surface", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await page.goto("/#/");
  const sample = page.getByRole("button", {
    name: "Create from a built-in story",
  });
  await sample.click();
  const sampleDialog = page.getByRole("dialog");
  const surface = await dialogSurface(sampleDialog);
  await page.keyboard.press("Escape");
  await expect(sampleDialog).toHaveCount(0);

  await page
    .getByLabel("Import SillyTavern character card or world book", {
      exact: true,
    })
    .setInputFiles(worldBookFile);
  const content = page.getByRole("dialog", {
    name: "SillyTavern content import wizard",
  });
  await expect(content).toBeVisible();
  expect.soft(await dialogSurface(content)).toEqual(surface);

  await page.goto("/#/create");
  await page
    .getByRole("button", { name: "Manage protagonist templates" })
    .click();
  const template = page.getByRole("dialog", {
    name: "Manage protagonist templates",
  });
  await expect(template).toBeVisible();
  expect.soft(await dialogSurface(template)).toEqual(surface);

  await page.goto("/#/orchestrations");
  await page.getByText("Manage orchestrations", { exact: true }).click();
  await page.getByLabel("Choose SillyTavern JSON file").setInputFiles({
    name: "preset.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  const preset = page.getByRole("dialog", {
    name: "SillyTavern import wizard",
  });
  await expect(preset).toBeVisible();
  expect.soft(await dialogSurface(preset)).toEqual(surface);
});
