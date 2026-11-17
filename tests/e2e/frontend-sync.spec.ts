import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

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

test("a committed sample with a lost receipt appears once without navigating to a same-name package", async ({
  page,
  runtimeUrl,
}) => {
  await runtime(page, runtimeUrl, {
    type: "preferences.save",
    locale: "zh-CN",
  });
  await runtime(page, runtimeUrl, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
  const before = await workspace(page, runtimeUrl);
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
    after.contentPackages.filter(
      ({ title }) => title === before.contentPackages.at(-1)?.title,
    ).length,
  ).toBeGreaterThanOrEqual(2);
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
  await page.getByRole("button", { name: /^(重新读取|Read again)$/u }).click();
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
  await page.getByRole("button", { name: /^(重新读取|Read again)$/u }).click();
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
