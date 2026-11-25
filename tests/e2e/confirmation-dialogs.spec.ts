import { expect, type Locator, type Page } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { ProtagonistTemplatesView } from "../../src/protocol/protagonistTemplates.ts";
import type {
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "confirmation-dialogs" });

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

function browserWrites(page: Page, types: string[]): V1Request[] {
  const writes: V1Request[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/runtime/v1")) return;
    const input = (request.postDataJSON() as { request: V1Request }).request;
    if (types.includes(input.type)) writes.push(input);
  });
  return writes;
}

function androidBack(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() =>
    (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack?.(),
  );
}

const model = {
  provider: "chat_completions" as const,
  modelId: "unused-fixture",
  contextWindowTokens: 64_000,
  maxOutputTokens: 8_192,
};

async function configureModel(page: Page): Promise<void> {
  await runtime(page, {
    type: "model.save",
    connection: {
      ...model,
      name: "Confirmation fixture",
      presetId: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "confirmation-fixture",
    },
  });
}

async function createWorld(page: Page, packageId: string, name: string) {
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId,
    model,
  });
  await runtime(page, { type: "world.rename", worldId: world.worldId, name });
  return world.worldId;
}

test("home deletion confirms the named world and content package in Chinese", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await configureModel(page);
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: localId,
    name: "临时内容包",
  });
  const worldId = await createWorld(page, localId, "待删除的世界");
  const retainedWorldId = await createWorld(page, localId, "保留的世界");
  const writes = browserWrites(page, ["world.delete", "content.delete"]);
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto("/#/");

  for (const { actions, target, warning, request } of [
    {
      actions: "世界操作：待删除的世界",
      target: "删除世界：待删除的世界",
      warning: /删除世界“待删除的世界”.*全部提交、历史和存档/,
      request: { type: "world.delete", worldId },
    },
    {
      actions: "内容包操作：临时内容包",
      target: "删除内容包：临时内容包",
      warning: /删除内容包“临时内容包”.*已创建的世界不受影响/,
      request: { type: "content.delete", packageId: localId },
    },
  ] as const) {
    await page.getByLabel(actions, { exact: true }).click();
    const opener = page.getByRole("button", { name: target, exact: true });
    await opener.click();
    expect(nativeDialogs).toEqual([]);
    const dialog = page.getByRole("dialog", { name: warning });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const confirm = dialog.getByRole("button", { name: "删除", exact: true });
    await expect(cancel).toBeFocused();
    await expect(confirm).toHaveClass(/danger-button/);
    const count = writes.length;
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(writes).toHaveLength(count);

    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(writes).toHaveLength(count);

    await opener.click();
    expect(await androidBack(page)).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(writes).toHaveLength(count);

    await opener.click();
    await confirm.dblclick();
    await expect(opener).toHaveCount(0);
    expect(writes.slice(count)).toEqual([request]);
  }
  const workspace = await runtime<{
    worlds: { worldId: string }[];
    contentPackages: { localId: string }[];
  }>(page, { type: "workspace.read" });
  expect(workspace.worlds.map((world) => world.worldId)).toContain(
    retainedWorldId,
  );
  expect(workspace.worlds.map((world) => world.worldId)).not.toContain(worldId);
  expect(workspace.contentPackages.map((pack) => pack.localId)).not.toContain(
    localId,
  );
});

test("home does not delete a target renamed while its confirmation is open", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  const { localId: packageId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const rename = (name: string) =>
    runtime(page, { type: "content.rename", packageId, name });
  await rename("Before refresh");
  const writes = browserWrites(page, ["content.delete"]);
  await page.goto("/#/");
  await page.getByLabel("Content-package actions: Before refresh").click();
  await page
    .getByRole("button", { name: "Delete content package: Before refresh" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: /Delete content package “Before refresh”/,
  });
  await expect(dialog).toBeVisible();

  await rename("After refresh");
  await page.evaluate(() =>
    window.dispatchEvent(new PopStateEvent("popstate")),
  );
  const opener = page.getByRole("button", {
    name: "Delete content package: After refresh",
  });
  await expect(opener).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(writes).toEqual([]);
});

test("English template confirmations keep the manager and draft available on cancellation", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  const templates = await runtime<ProtagonistTemplatesView>(page, {
    type: "protagonist-templates.save",
    name: "First investigator",
    body: "First saved character.",
  });
  const firstId = templates.templates.at(-1)!.id;
  await runtime(page, {
    type: "protagonist-templates.save",
    name: "Second investigator",
    body: "Second saved character.",
  });
  const writes = browserWrites(page, [
    "protagonist-templates.save",
    "protagonist-templates.copy",
    "protagonist-templates.delete",
  ]);
  await page.goto("/#/create");
  const launch = page.getByRole("button", {
    name: "Manage protagonist templates",
  });
  await launch.click();
  const manager = page.getByRole("dialog", {
    name: "Manage protagonist templates",
  });
  const first = manager.getByRole("button", { name: "First investigator" });
  const second = manager.getByRole("button", { name: "Second investigator" });
  const close = manager.getByRole("button", { name: "Close", exact: true });
  const body = manager.getByRole("textbox", { name: "Template body" });
  await first.click();
  await body.fill("Unsaved draft.");
  await second.click();
  const discard = page.getByRole("dialog", {
    name: /Discard unsaved protagonist template changes/,
  });
  const cancel = discard.getByRole("button", { name: "Cancel" });
  const discardButton = discard.getByRole("button", { name: "Discard" });
  await expect(cancel).toBeFocused();
  await expect(cancel).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Shift+Tab");
  await expect(discardButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(discardButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discard).toBeHidden();
  await expect(second).toBeFocused();
  await expect(body).toHaveValue("Unsaved draft.");

  await close.click();
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(close).toBeFocused();
  await expect(body).toHaveValue("Unsaved draft.");
  expect(await androidBack(page)).toBe(true);
  await expect(cancel).toBeFocused();
  expect(await androidBack(page)).toBe(true);
  await expect(discard).toBeHidden();
  await expect(close).toBeFocused();
  await expect(manager).toBeVisible();
  expect(writes).toEqual([]);

  await second.click();
  await discardButton.click();
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(body).toHaveValue("Second saved character.");
  await body.fill("Another unsaved draft.");
  await close.click();
  await discardButton.click();
  await expect(manager).toBeHidden();
  expect(writes).toEqual([]);

  await launch.click();
  await first.click();
  const deleteOpener = manager.getByRole("button", {
    name: "Delete",
    exact: true,
  });
  const remove = page.getByRole("dialog", {
    name: /Delete protagonist template “First investigator”/,
  });
  await deleteOpener.click();
  await remove.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteOpener).toBeFocused();
  expect(writes).toEqual([]);
  await expect(first).toBeVisible();
  await deleteOpener.click();
  await remove.getByRole("button", { name: "Delete" }).dblclick();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  expect(writes).toEqual([
    { type: "protagonist-templates.delete", id: firstId },
  ]);
});

test("revision discard keeps newer work saved while the confirmation is open", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await configureModel(page);
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create-sample",
    locale: "en",
  });
  const worldId = await createWorld(page, localId, "Revision fixture");
  const opened = await runtime<V1WorldRevisionOverview>(page, {
    type: "world.revision.open",
    worldId,
  });
  const epoch = opened.epoch!;
  const writes = browserWrites(page, ["world.revision.discard"]);
  // Keep observation from winning the race so the Runtime precondition is exercised.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (
          new URL(url, window.location.href).searchParams.get("kind") ===
          "revision"
        )
          this.close();
      }
    };
  });

  await page.goto(`/#/world/${worldId}`);
  await page.getByRole("button", { name: "Continue revision" }).click();
  const opener = page.getByRole("button", { name: "Discard", exact: true });
  const dialog = page.getByRole("dialog", {
    name: /Discard this revision of “Revision fixture”\? Every unapplied manual and model change will be lost/,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const discard = dialog.getByRole("button", { name: "Discard" });
  await opener.click();
  await expect(cancel).toBeFocused();
  await expect(discard).toHaveClass(/danger-button/);
  await cancel.click();
  await expect(opener).toBeFocused();
  expect(writes).toEqual([]);
  await opener.click();
  await expect(cancel).toBeFocused();

  const path = "control/blocks/world.md";
  expect(epoch.files.some((file) => file.path === path)).toBe(true);
  const newer = await runtime<V1WorldRevisionOverview>(page, {
    type: "world.revision.files.replace",
    worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: epoch.files.map((file) =>
      file.path === path
        ? {
            ...file,
            contents: `${file.contents}\nNewer saved revision work.\n`,
          }
        : file,
    ),
  });
  const updated = newer.epoch!;
  expect(updated.revision).not.toBe(epoch.revision);
  expect(updated.diff).toHaveLength(1);
  await discard.click();
  await expect(page.getByRole("alert")).toContainText(
    "The revision was updated elsewhere.",
  );
  const overview = () =>
    runtime<V1WorldRevisionOverview>(page, {
      type: "world.revision.overview",
      worldId,
    });
  expect((await overview()).epoch?.revision).toBe(updated.revision);
  expect(writes).toEqual([
    {
      type: "world.revision.discard",
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
    },
  ]);

  await opener.click();
  await discard.dblclick();
  await expect(
    page.getByRole("textbox", { name: "Your action" }),
  ).toBeVisible();
  expect((await overview()).epoch).toMatchObject({
    epochId: updated.epochId,
    lifecycle: "discarded",
    locked: false,
  });
  expect(writes.slice(1)).toEqual([
    {
      type: "world.revision.discard",
      worldId,
      epochId: updated.epochId,
      expectedRevision: updated.revision,
    },
  ]);
  const world = await runtime<{ head: string; worldRevision: unknown }>(page, {
    type: "world.read",
    worldId,
  });
  expect(world.head).toBe(epoch.baseHead);
  expect(world.worldRevision).toBeNull();
});

for (const locale of ["en", "zh-CN"] as const) {
  const cn = locale === "zh-CN";
  const cancelLabel = cn ? "取消" : "Cancel";
  const confirmLabel = cn ? "删除" : "Delete";

  async function cancelAndConfirmDeletion(
    page: Page,
    opener: Locator,
    warning: RegExp,
    writes: V1Request[],
    expected: V1Request,
    assertRetained: () => Promise<void>,
  ): Promise<void> {
    const url = page.url();
    const dialog = page.getByRole("dialog", { name: warning });
    const cancel = dialog.getByRole("button", { name: cancelLabel });
    await opener.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
    expect(writes).toEqual([]);
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    expect(await androidBack(page)).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(page.url()).toBe(url);
    await assertRetained();
    expect(writes).toEqual([]);

    await opener.click();
    await dialog.getByRole("button", { name: confirmLabel }).dblclick();
    await expect(opener).toBeHidden();
    expect(writes).toEqual([expected]);
  }

  test(`model deletion confirms the named connection (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    await configureModel(page);
    const name = "Connection to remove";
    const library = await runtime<ModelConnectionLibraryView>(page, {
      type: "model.save",
      connection: {
        ...model,
        name,
        presetId: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture-key",
      },
    });
    const connectionId = library.connections.find(
      (item) => item.name === name,
    )!.id;
    await runtime(page, {
      type: "model.select",
      connectionId: library.connections.find(
        (item) => item.id !== connectionId,
      )!.id,
    });
    const writes = browserWrites(page, ["model.delete"]);
    await page.goto("/#/models");
    const card = page.getByRole("article").filter({ hasText: name });
    const opener = card.getByRole("button", {
      name: confirmLabel,
      exact: true,
    });
    const input = page.getByLabel(cn ? "配置名称" : "Configuration name", {
      exact: true,
    });
    await input.fill("Unsaved model draft");
    await expect(opener).toBeDisabled();
    await expect(input).toHaveValue("Unsaved model draft");
    await page
      .getByRole("button", {
        name: cn ? "放弃修改" : "Discard changes",
        exact: true,
      })
      .click();
    await cancelAndConfirmDeletion(
      page,
      opener,
      cn
        ? /删除模型连接“Connection to remove”.*本机凭据/
        : /Delete model connection “Connection to remove”.*local credentials/,
      writes,
      { type: "model.delete", connectionId },
      async () => {
        await expect(card).toBeVisible();
      },
    );
    await expect(
      page.getByText("Confirmation fixture", { exact: true }).first(),
    ).toBeVisible();
  });

  test(`orchestration deletion confirms the named plan (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    const name = "Orchestration to remove";
    const { preset } = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name,
    });
    const writes = browserWrites(page, ["play.delete"]);
    await page.goto(`/#/orchestrations/${preset.id}`);
    await page
      .getByText(cn ? "编排方案操作" : "Orchestration actions", { exact: true })
      .click();
    const opener = page.getByRole("button", {
      name: cn ? "删除编排方案" : "Delete orchestration",
      exact: true,
    });
    const input = page.getByRole("textbox", {
      name: cn ? "编排方案名称" : "Orchestration name",
      exact: true,
    });
    await input.fill("Unsaved orchestration name");
    await expect(opener).toBeDisabled();
    await expect(input).toHaveValue("Unsaved orchestration name");
    await input.fill(name);
    await cancelAndConfirmDeletion(
      page,
      opener,
      cn
        ? /删除编排方案“Orchestration to remove”.*草稿.*无法撤销/
        : /Delete orchestration “Orchestration to remove”.*draft.*cannot be undone/,
      writes,
      { type: "play.delete", presetId: preset.id },
      async () => {
        await expect(input).toHaveValue(name);
      },
    );
    await expect(
      page
        .getByRole("combobox", {
          name: cn ? "切换编排方案" : "Switch orchestration",
        })
        .getByRole("option", { name }),
    ).toHaveCount(0);
  });

  test(`content editor deletion confirms the named package (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    const { localId: packageId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const name = "Package to remove";
    await runtime(page, { type: "content.rename", packageId, name });
    const writes = browserWrites(page, ["content.delete"]);
    await page.goto(`/#/content/${packageId}`);
    await page
      .getByRole("navigation", {
        name: cn ? "设定完善工具" : "Setting-improvement tools",
      })
      .getByRole("button", { name: cn ? "编辑" : "Edit", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: cn ? "内容包文件编辑" : "Content-package file editing",
    });
    await rail
      .getByText(cn ? "内容包操作" : "Content-package actions", { exact: true })
      .click();
    const opener = rail.getByRole("button", {
      name: cn ? "删除内容包" : "Delete content package",
      exact: true,
    });
    const fileDraft = rail.getByRole("textbox", {
      name: cn ? "编辑 opening.md" : "Edit opening.md",
      exact: true,
    });
    await fileDraft.fill("Unsaved opening text");
    await expect(opener).toBeDisabled();
    await expect(fileDraft).toHaveValue("Unsaved opening text");
    await rail
      .getByRole("button", {
        name: cn ? "放弃未保存修改" : "Discard unsaved changes",
        exact: true,
      })
      .click();
    const titleDraft = rail.getByRole("textbox", {
      name: cn ? "内容包标题" : "Content-package title",
    });
    await titleDraft.fill("Unsaved package title");
    await cancelAndConfirmDeletion(
      page,
      opener,
      cn
        ? /删除内容包“Package to remove”.*已创建的世界不受影响/
        : /Delete content package “Package to remove”.*Existing worlds are unaffected/,
      writes,
      { type: "content.delete", packageId },
      async () => {
        await expect(titleDraft).toHaveValue("Unsaved package title");
      },
    );
    await expect(page).toHaveURL(/#\/$/);
  });
}
