import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";

test.use({ runtimeScope: "frontend-sync" });

test.beforeEach(async ({ page, runtimeUrl }) => {
  await runtime(page, runtimeUrl, {
    type: "preferences.save",
    locale: "zh-CN",
  });
  await runtime(page, runtimeUrl, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
});

test("an archive import with a lost receipt appears once after a read-only workspace recovery", async ({
  page,
  runtimeUrl,
}) => {
  const source = await worldArchiveFixture();
  try {
    await source.worlds.renameWorld(source.worldId, "Lost archive receipt");
    await source.archives.exportWorld({
      worldId: source.worldId,
      operationId: "lost-receipt",
    });
    let imports = 0;
    let reads = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = (route.request().postDataJSON() as { request: V1Request })
        .request;
      if (input.type === "world.archive.import") {
        imports++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort("failed");
      } else {
        if (imports > 0 && input.type === "workspace.read") reads++;
        await route.continue();
      }
    });
    await page.goto("/#/");
    await page
      .getByLabel("世界备份 ZIP 文件")
      .setInputFiles(
        join(source.root, "world-archives/exports/lost-receipt/archive.zip"),
      );
    await expect(
      page.getByRole("button", {
        name: "打开世界：Lost archive receipt",
        exact: true,
      }),
    ).toBeVisible();
    expect(imports).toBe(1);
    expect(reads).toBe(1);
    const after = await runtime<{ worlds: { title: string }[] }>(
      page,
      runtimeUrl,
      { type: "workspace.read" },
    );
    expect(
      after.worlds.filter(({ title }) => title === "Lost archive receipt"),
    ).toHaveLength(1);
    await expect(page).toHaveURL(/#\/$/u);
  } finally {
    await rm(source.root, { recursive: true, force: true });
  }
});

test("a content import with a lost receipt updates the library once and keeps its selected file", async ({
  page,
  runtimeUrl,
}) => {
  const before = await workspace(page, runtimeUrl);
  const archive = await runtime<{ base64: string; fileName: string }>(
    page,
    runtimeUrl,
    { type: "content.export", packageId: before.contentPackages[0]!.localId },
  );
  let imports = 0;
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "content.import") {
      imports++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else {
      if (imports > 0 && input.type === "workspace.read") reads++;
      await route.continue();
    }
  });
  await page.goto("/#/");
  await page.locator("summary").filter({ hasText: "导入内容包 ZIP" }).click();
  await page.getByLabel("内容包 ZIP 文件").setInputFiles({
    name: "Retained package.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive.base64, "base64"),
  });
  await page.getByRole("button", { name: "导入 ZIP", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^打开内容包：/u }),
  ).toHaveCount(before.contentPackages.length + 1);
  await expect(
    page.getByText("Retained package.zip", { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/$/u);
  expect(imports).toBe(1);
  expect(reads).toBe(1);
});

test("a committed sample with a lost receipt appears once without navigating to a same-name package", async ({
  page,
  runtimeUrl,
}) => {
  const sample = await runtime<{ localId: string; title: string }>(
    page,
    runtimeUrl,
    { type: "content.create-sample", locale: "zh-CN" },
  );
  const before = await workspace(page, runtimeUrl);
  const existingCopies = before.contentPackages.filter(
    ({ title }) => title === sample.title,
  );
  expect(existingCopies.map(({ localId }) => localId)).toContain(
    sample.localId,
  );
  let writes = 0;
  let readbacks = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "content.create-sample") {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else {
      if (writes > 0 && input.type === "workspace.read") readbacks++;
      await route.continue();
    }
  });
  await page.goto("/#/");
  await page.getByRole("button", { name: "从示例新建", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^打开内容包：/u }),
  ).toHaveCount(before.contentPackages.length + 1);
  await expect(page).toHaveURL(/#\/$/u);
  expect(writes).toBe(1);
  expect(readbacks).toBe(1);
  const after = await workspace(page, runtimeUrl);
  expect(after.contentPackages).toHaveLength(before.contentPackages.length + 1);
  expect(
    after.contentPackages.filter(({ title }) => title === sample.title),
  ).toHaveLength(existingCopies.length + 1);
});

test("a transient first-load failure recovers the bookmarked page automatically", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "workspace.read" && ++reads === 1)
      await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/#/models");
  await expect(page.getByLabel("配置名称")).toBeVisible();
  await expect(page).toHaveURL(/#\/models$/u);
  expect(reads).toBe(2);
  await expect(
    page.getByText(/^(暂时无法同步|Temporarily unable to sync)$/u),
  ).toHaveCount(0);
});

test("a saved language with a lost response rereads preferences without repeating the save", async ({
  page,
  runtimeUrl,
}) => {
  let writes = 0;
  let readbacks = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "preferences.save") {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else {
      if (writes && input.type === "workspace.read") readbacks++;
      await route.continue();
    }
  });
  await page.goto("/#/models");
  await page.getByLabel("界面语言").selectOption("en");
  await expect(page.getByLabel("Interface language")).toHaveValue("en");
  expect(writes).toBe(1);
  expect(readbacks).toBe(1);
  expect(
    (
      await runtime<{ locale: string }>(page, runtimeUrl, {
        type: "preferences.read",
      })
    ).locale,
  ).toBe("en");
});

test("a rejected language change keeps its reason after manual recovery", async ({
  page,
}) => {
  let rejected = false;
  let offline = true;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "preferences.save") {
      rejected = true;
      return route.fulfill({
        status: 409,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "preference_conflict",
            message: "偏好版本冲突，请核对后再保存。",
          },
        },
      });
    }
    if (input.type === "workspace.read" && rejected && offline)
      return route.abort("failed");
    await route.continue();
  });
  await page.goto("/#/models");
  await page.getByLabel("界面语言").selectOption("en");
  await expect(page.getByText("暂时无法同步", { exact: true })).toBeVisible();
  offline = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByText("暂时无法同步", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("偏好版本冲突，请核对后再保存。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("界面语言")).toHaveValue("zh-CN");
});

test("first load retries once then offers a read-only recovery in the original position", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "workspace.read" && ++reads <= 2)
      await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/#/");
  await expect(
    page.getByText(/^(暂时无法同步|Temporarily unable to sync)$/u),
  ).toBeVisible();
  expect(reads).toBe(2);
  await page.getByRole("button", { name: /^(重新加载|Reload)$/u }).click();
  await expect(
    page.getByRole("button", { name: "从示例新建", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/^(暂时无法同步|Temporarily unable to sync)$/u),
  ).toHaveCount(0);
  expect(reads).toBe(3);
});

test("failed recovery retains the homepage and selected import; manual recovery only rereads", async ({
  page,
  runtimeUrl,
}) => {
  const before = await workspace(page, runtimeUrl);
  let writes = 0;
  let reads = 0;
  let offline = false;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "content.create-sample") {
      writes++;
      await route.fetch();
      offline = true;
      await route.abort("failed");
    } else if (input.type === "workspace.read" && writes > 0) {
      reads++;
      if (offline) await route.abort("failed");
      else await route.continue();
    } else await route.continue();
  });
  await page.goto("/#/");
  await page.locator("summary").filter({ hasText: "导入内容包 ZIP" }).click();
  await page.getByLabel("内容包 ZIP 文件").setInputFiles({
    name: "unsent-draft.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("unsubmitted draft"),
  });
  await page.getByRole("button", { name: "从示例新建", exact: true }).click();
  await expect(
    page.getByText(/^(暂时无法同步|Temporarily unable to sync)$/u),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^打开内容包：/u }),
  ).toHaveCount(before.contentPackages.length);
  expect(reads).toBe(1);
  offline = false;
  await page.getByRole("button", { name: /^(重新加载|Reload)$/u }).click();
  await expect(
    page.getByRole("button", { name: /^打开内容包：/u }),
  ).toHaveCount(before.contentPackages.length + 1);
  await expect(
    page.getByText(/^(暂时无法同步|Temporarily unable to sync)$/u),
  ).toHaveCount(0);
  await expect(
    page.getByText("unsent-draft.zip", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(reads).toBe(2);
});

test("a non-home workspace refresh failure keeps its receipt and draft with one visible reread action", async ({
  page,
}) => {
  let saved = false;
  let offline = false;
  let writes = 0;
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "preferences.save") {
      writes++;
      const response = await route.fetch();
      saved = true;
      offline = true;
      await route.fulfill({ response });
    } else if (input.type === "workspace.read" && saved) {
      reads++;
      if (offline) await route.abort("failed");
      else await route.continue();
    } else await route.continue();
  });
  await page.goto("/#/models");
  await page.getByLabel("界面语言").selectOption("en");
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel("Interface language")).toHaveValue("en");
  await expect(
    page.getByText("Interface language saved.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Configuration name").fill("Keep this unsaved model");
  expect(reads).toBe(2);
  offline = false;
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Configuration name")).toHaveValue(
    "Keep this unsaved model",
  );
  await expect(page.getByLabel("Interface language")).toHaveValue("en");
  await expect(page).toHaveURL(/#\/models$/u);
  expect(writes).toBe(1);
  expect(reads).toBe(3);
});

test("overlapping page writes retain both commits when a newer receipt overtakes a recovery read", async ({
  page,
  runtimeUrl,
}) => {
  const before = await workspace(page, runtimeUrl);
  const localePending = Promise.withResolvers<void>();
  const commitLocale = Promise.withResolvers<void>();
  const recoveryPending = Promise.withResolvers<void>();
  const releaseRecovery = Promise.withResolvers<void>();
  let localeWrites = 0;
  let sampleWrites = 0;
  let readbacks = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type === "preferences.save") {
      localeWrites++;
      localePending.resolve();
      await commitLocale.promise;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.fulfill({ response });
    } else if (input.type === "content.create-sample") {
      sampleWrites++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else if (input.type === "workspace.read" && sampleWrites > 0) {
      readbacks++;
      if (readbacks === 1) {
        const response = await route.fetch();
        recoveryPending.resolve();
        await releaseRecovery.promise;
        await route.fulfill({ response });
      } else await route.continue();
    } else await route.continue();
  });
  await page.goto("/#/");
  await page.getByLabel("界面语言").selectOption("en");
  await localePending.promise;
  await page.getByRole("button", { name: "从示例新建", exact: true }).click();
  await recoveryPending.promise;
  // The recovery snapshot already includes the sample but predates the locale commit.
  commitLocale.resolve();
  await expect(
    page.getByRole("button", { name: "Create from sample", exact: true }),
  ).toBeVisible();
  releaseRecovery.resolve();
  await expect(
    page.getByRole("button", { name: /^Open content package:/u }),
  ).toHaveCount(before.contentPackages.length + 1);
  await expect(page.getByLabel("Interface language")).toHaveValue("en");
  await expect(page).toHaveURL(/#\/$/u);
  const after = await runtime<{
    preferences: { locale: string };
    contentPackages: unknown[];
  }>(page, runtimeUrl, { type: "workspace.read" });
  expect(after.preferences.locale).toBe("en");
  expect(after.contentPackages).toHaveLength(before.contentPackages.length + 1);
  expect(localeWrites).toBe(1);
  expect(sampleWrites).toBe(1);
  expect(readbacks).toBe(2);
});

async function runtime<T>(
  page: Page,
  url: string,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post(`${url}/api/runtime/v1`, {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function workspace(page: Page, url: string) {
  return runtime<{ contentPackages: { localId: string; title: string }[] }>(
    page,
    url,
    { type: "workspace.read" },
  );
}
