import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/CurrentTreeContentLibrary.ts";

const primaryFill = "rgb(52, 56, 50)";
const fixtureModel = {
  name: "Audit model",
  presetId: "custom",
  provider: "chat_completions",
  authMode: "none",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "audit-model",
  contextWindowTokens: 64_000,
  maxOutputTokens: 8_192,
} as const;

for (const locale of ["zh-CN", "en"] as const) {
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);

  test(`#468 model save and content-package creation are primary (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/models");
    const form = page.locator(".config-form");
    const name = form.getByRole("textbox", {
      name: label("配置名称", "Configuration name"),
    });
    const modelId = form.getByRole("textbox", {
      name: label("模型 ID", "Model ID"),
    });
    const save = form.getByRole("button", {
      name: label("保存模型连接并启用", "Save and enable model connection"),
    });
    const probe = form.getByRole("button", {
      name: label("试发一条消息", "Send a test message"),
    });
    const modelName = `Keyboard model ${locale}`;
    await name.fill(modelName);
    await form
      .getByLabel("Base URL", { exact: true })
      .fill(fixtureModel.baseUrl);
    await form.locator("#model-auth-mode").selectOption("none");
    await modelId.fill(`keyboard-${locale}`);
    await expectPrimary(save, probe);
    await modelId.press("Enter");
    await expect
      .poll(async () => {
        const { activeConnectionId, connections } =
          await runtime<ModelConnectionLibraryView>(page, {
            type: "model.read",
          });
        return connections.find(({ id }) => id === activeConnectionId)?.name;
      })
      .toBe(modelName);

    await expect(save).toBeEnabled();
    const navigation = page.getByRole("navigation", {
      name: label("工作区导航", "Workspace navigation"),
    });
    await navigation
      .getByRole("button", { name: label("切换页面", "Switch page") })
      .click();
    await navigation
      .getByRole("button", {
        name: label("内容库", "Content library"),
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/#\/library$/u);
    const dialogName = label("新建内容包", "Create content package");
    const open = page.getByRole("button", { name: dialogName, exact: true });
    const dialog = page.getByRole("dialog", { name: dialogName });
    const create = dialog.getByRole("button", {
      name: label("创建", "Create"),
      exact: true,
    });
    const cancel = dialog.getByRole("button", {
      name: label("取消", "Cancel"),
    });
    await open.click();
    await expectPrimary(create, cancel);
    expect(await androidBack(page)).toBe(true);
    await expect(dialog).toHaveCount(0);
    await open.click();
    await create.press("Enter");
    await expect(page).toHaveURL(/#\/content\/[^/]+$/u);
  });

  test(`#468 world and content-package rename submit with Enter (${locale})`, async ({
    page,
  }) => {
    const { packageTitle, worldTitle } = await seedWorld(page, locale);
    await page.goto("/#/");
    for (const kind of ["world", "package"] as const) {
      const isWorld = kind === "world";
      const title = isWorld ? worldTitle : packageTitle;
      const actions = page.getByRole("button", {
        name: isWorld
          ? label(`世界操作：${title}`, `World actions: ${title}`)
          : label(`内容包操作：${title}`, `Content-package actions: ${title}`),
        exact: true,
      });
      const rename = page.getByRole("button", {
        name: isWorld
          ? label(`重命名世界：${title}`, `Rename world: ${title}`)
          : label(`重命名内容包：${title}`, `Rename content package: ${title}`),
        exact: true,
      });
      const name = page.getByRole("textbox", {
        name: isWorld
          ? label("世界名称", "World name")
          : label("内容包标题", "Content-package title"),
        exact: true,
      });
      const save = page.getByRole("button", {
        name: isWorld
          ? label("保存世界名称", "Save world name")
          : label("保存内容包标题", "Save content-package title"),
      });
      await actions.click();
      await rename.click();
      await expect(name).toBeFocused();
      await expect(save).toBeDisabled();
      await expect(save).toHaveCSS("cursor", "not-allowed");
      await expect.soft(save).not.toHaveCSS("background-color", primaryFill);
      await name.fill(`${title} updated`);
      await expectPrimary(
        save,
        page.getByRole("button", {
          name: label("取消", "Cancel"),
          exact: true,
        }),
      );
      await name.press("Enter");
      await expect(name).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: isWorld
            ? label(
                `打开世界：${title} updated`,
                `Open world: ${title} updated`,
              )
            : label(
                `打开内容包：${title} updated`,
                `Open content package: ${title} updated`,
              ),
          exact: true,
        }),
      ).toBeVisible();
    }
  });

  test(`#468 file drafts have a primary action at the editor and composer (${locale})`, async ({
    page,
  }) => {
    const { packageId, worldId } = await seedWorld(page, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const kind of ["package", "revision"] as const) {
      const revision = kind === "revision";
      if (revision) {
        await page.goto(`/#/world/${worldId}`);
        await page
          .getByRole("button", { name: label("世界", "Worlds"), exact: true })
          .click();
        await page
          .getByRole("button", {
            name: label("修订当前世界", "Revise current world"),
            exact: true,
          })
          .click();
      } else {
        await page.goto(`/#/content/${packageId}`);
      }

      const tools = page.getByRole("navigation", {
        name: revision
          ? label("世界修订工具", "World-revision tools")
          : label("设定完善工具", "Setting-improvement tools"),
      });
      const saveName = revision
        ? label("保存到修订", "Save to revision")
        : label("整批保存", "Save all changes");
      const save = page.getByRole("button", { name: saveName, exact: true });
      const reset = page.getByRole("button", {
        name: label("放弃未保存修改", "Discard unsaved changes"),
        exact: true,
      });
      await tools
        .getByRole("button", { name: label("编辑", "Edit"), exact: true })
        .click();
      await expect(save).toBeDisabled();
      await expect.soft(save).not.toHaveCSS("background-color", primaryFill);
      const path = revision ? "state/current-situation.yaml" : "opening.md";
      if (revision) {
        await page
          .getByRole("combobox", {
            name: label("选择编辑文件", "Choose a file to edit"),
          })
          .selectOption(path);
      }
      const source = page.getByRole("textbox", {
        name: label(`编辑 ${path}`, `Edit ${path}`),
        exact: true,
      });
      const draft = `${await source.inputValue()}\n# Updated in the audit\n`;
      await source.fill(draft);
      await expectPrimary(save, reset);
      await page
        .getByRole("button", {
          name: label("收起文件面板", "Close file panel"),
          exact: true,
        })
        .click();
      await expectPrimary(save, reset);
      await save.press("Enter");
      await expect(save).toHaveCount(0);

      await tools
        .getByRole("button", { name: label("编辑", "Edit"), exact: true })
        .click();
      await expect(source).toHaveValue(draft);
      await expect(save).toBeDisabled();
      await page
        .getByRole("button", {
          name: label("收起文件面板", "Close file panel"),
          exact: true,
        })
        .click();
      if (!revision) {
        const content = await runtime<EditableContentPackageDetail>(page, {
          type: "content.read",
          packageId,
        });
        expect(content.files.find((file) => file.path === path)?.contents).toBe(
          draft,
        );
      }
    }
  });

  test(`#469 ordinary small text meets 4.5:1 on real surfaces (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    const mutedModelId = `contrast-muted-${locale}`;
    const selectedModelId = `contrast-selected-${locale}`;
    await runtime(page, {
      type: "model.save",
      connection: { ...fixtureModel, modelId: mutedModelId },
    });
    await runtime(page, {
      type: "model.save",
      connection: { ...fixtureModel, modelId: selectedModelId },
    });
    await page.setViewportSize({ width: 1440, height: 844 });
    await page.goto("/#/models");
    const details = page.locator(".model-connection-details > summary");
    await expectContrast(
      details.getByText(selectedModelId, { exact: true }),
      "selected model card",
    );
    await expectContrast(
      details.getByText(mutedModelId, { exact: true }),
      "muted model card",
    );

    await page.goto("/#/orchestrations");
    const playPrompt = page
      .locator(".ordered-play-editor li")
      .filter({
        has: page.getByText(label("仅跑团", "Tabletop only"), { exact: true }),
      })
      .first();
    const promptEntry = playPrompt.getByRole("button");
    await promptEntry.press("Enter");
    await expect(promptEntry).toHaveAttribute("aria-pressed", "true");
    await expectContrast(
      playPrompt.locator(".ordered-play-category"),
      "selected prompt category",
    );
    await expectContrast(
      playPrompt.locator(".ordered-play-entry-tags small").last(),
      "selected prompt metadata",
    );

    await expectContrast(
      page.locator(".preset-directory-group > header > span").first(),
      "follow-up category",
    );
    await page
      .locator(".preset-directory-group")
      .first()
      .getByRole("button", {
        name: label("新增后置请求", "Add follow-up request"),
      })
      .click();
    await expectContrast(
      page.locator(".preset-object-toolbar > span"),
      "follow-up toolbar metadata",
    );
    await page
      .getByRole("button", { name: label("界面产物", "Outputs"), exact: true })
      .click();
    const output = page
      .locator(".preset-output-cards button")
      .filter({ has: page.locator("span") })
      .first();
    await output.press("Enter");
    await expect(output).toHaveAttribute("aria-pressed", "true");
    await expectContrast(output.locator("span"), "selected output placement");
    await page
      .getByRole("button", {
        name: label("＋ 新增产物", "＋ Add output"),
        exact: true,
      })
      .click();
    await expect(output).toHaveAttribute("aria-pressed", "false");
    await expectContrast(output.locator("span"), "unselected output placement");
  });

  test(`#471 more buttons stay in place and keep their keyboard and Back behavior (${locale})`, async ({
    page,
  }) => {
    const { worldId, worldTitle } = await seedWorld(page, locale);
    const card = page.getByRole("button", {
      name: label(`世界操作：${worldTitle}`, `World actions: ${worldTitle}`),
    });
    const manage = page.getByRole("button", {
      name: label("世界管理", "World management"),
      exact: true,
    });
    const more = page.getByLabel(label("更多", "More"), { exact: true });
    const title = page.getByRole("heading", {
      name: worldTitle,
      level: 1,
      exact: true,
    });
    const now = page.getByRole("button", {
      name: label("此刻", "Now"),
      exact: true,
    });
    const dialog = page.getByRole("dialog", {
      name: label("世界管理", "World management"),
    });
    const noteAction = page.getByRole("button", {
      name: label("本轮临时要求", "One-turn request"),
      exact: true,
    });
    const note = page.getByRole("textbox", {
      name: label("本轮临时要求内容", "One-turn request text"),
    });
    const action = page.getByRole("textbox", {
      name: label("你的行动", "Your action"),
    });
    for (const width of [390, 641, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#/");
      await expect.soft(card).toHaveText("⋯", { timeout: 500 });
      const cardBefore = await card.boundingBox();
      await card.press("Enter");
      await expect(card).toHaveAttribute("aria-expanded", "true");
      expect(await card.boundingBox()).toEqual(cardBefore);
      await page.keyboard.press("Escape");
      await expect(card).toHaveAttribute("aria-expanded", "false");
      await expect(card).toBeFocused();

      await page.goto(`/#/world/${worldId}`);
      await expect.soft(manage).toHaveText("⋯", { timeout: 500 });
      await expect(more).toHaveText("⋯");
      await expect(manage).toBeInViewport({ ratio: 1 });
      await expect(title).toBeVisible();
      const openingBounds = (await manage.boundingBox())!;
      expect(openingBounds.x + openingBounds.width).toBeLessThanOrEqual(width);
      const titleBounds = (await title.boundingBox())!;
      const nowBounds = (await now.boundingBox())!;
      test.info().annotations.push({
        type: "bounds",
        description: JSON.stringify({
          width,
          card: cardBefore,
          title: titleBounds,
          now: nowBounds,
          manage: openingBounds,
        }),
      });
      if (width <= 640) {
        expect(titleBounds.y).toBeGreaterThanOrEqual(
          openingBounds.y + openingBounds.height,
        );
      } else {
        expect(titleBounds.x).toBeGreaterThanOrEqual(
          nowBounds.x + nowBounds.width,
        );
        expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(
          openingBounds.x,
        );
        expect(
          Math.abs(
            titleBounds.y +
              titleBounds.height / 2 -
              openingBounds.y -
              openingBounds.height / 2,
          ),
        ).toBeLessThan(1);
      }
      await manage.press("Enter");
      await expect(dialog).toBeVisible();
      expect(await androidBack(page)).toBe(true);
      await expect(dialog).toHaveCount(0);
      await expect(manage).toBeFocused();
      expect(await manage.boundingBox()).toEqual(openingBounds);
    }

    await more.press("Enter");
    await noteAction.press("Enter");
    await expect(note).toBeFocused();
    await note.fill("Keep the lights on.");
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
    await more.press("Enter");
    await noteAction.press("Enter");
    await expect(note).toHaveValue("Keep the lights on.");
    const clear = page.getByRole("button", {
      name: label(
        "清空并收起本轮临时要求",
        "Clear and close the one-turn request",
      ),
    });
    await expect(clear).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(clear).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await clear.click();
    await expect(note).toHaveCount(0);
    await more.press("Enter");
    await noteAction.press("Enter");
    await expect(note).toHaveValue("");
  });
}

async function expectPrimary(action: Locator, secondary: Locator) {
  await expect(action).toBeEnabled();
  await expect.soft(secondary).not.toHaveCSS("background-color", primaryFill);
  const colors = () =>
    action.evaluate((button) => {
      const { backgroundColor, color } = getComputedStyle(button);
      return { backgroundColor, color };
    });
  expect.soft(await colors()).toEqual({
    backgroundColor: primaryFill,
    color: "rgb(255, 255, 255)",
  });
  await action.hover();
  expect.soft(await colors()).toEqual({
    backgroundColor: "rgb(70, 76, 67)",
    color: "rgb(255, 255, 255)",
  });
  await action.page().mouse.move(0, 0);
}

async function expectContrast(target: Locator, description: string) {
  await expect(target).toBeVisible();
  const { foreground, background, fontSize } = await target.evaluate((node) => {
    const { color, fontSize } = getComputedStyle(node);
    for (
      let layer: Element | null = node;
      layer !== null;
      layer = layer.parentElement
    ) {
      const { backgroundColor } = getComputedStyle(layer);
      if (backgroundColor.startsWith("rgb("))
        return { foreground: color, background: backgroundColor, fontSize };
      if (backgroundColor !== "rgba(0, 0, 0, 0)")
        throw new Error(
          `Unexpected translucent background: ${backgroundColor}`,
        );
    }
    throw new Error("No rendered background");
  });
  const luminance = (rgb: string) => {
    const [red, green, blue] = rgb.match(/\d+/gu)!.map((component) => {
      const channel = Number(component) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const values = [luminance(foreground), luminance(background)];
  const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  const result = `${description}: ${ratio.toFixed(2)}:1 (${foreground} on ${background}, ${fontSize})`;
  test.info().annotations.push({ type: "contrast", description: result });
  expect.soft(ratio, result).toBeGreaterThanOrEqual(4.5);
}

async function androidBack(page: Page) {
  return page.evaluate(() =>
    (
      window as Window & { narraeonAndroidBack?: () => boolean }
    ).narraeonAndroidBack?.(),
  );
}

async function seedWorld(page: Page, locale: "zh-CN" | "en") {
  await runtime(page, { type: "preferences.save", locale });
  await runtime(page, { type: "model.save", connection: fixtureModel });
  const { localId: packageId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const packageTitle = `Audit package ${packageId}`;
  await runtime(page, {
    type: "content.rename",
    packageId,
    name: packageTitle,
  });
  const {
    world: { worldId },
  } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId,
  });
  const worldTitle = `Audit world ${packageId}`;
  await runtime(page, { type: "world.rename", worldId, name: worldTitle });
  return { packageId, packageTitle, worldId, worldTitle };
}

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
