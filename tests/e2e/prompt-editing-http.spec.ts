import { expect, test, type APIRequestContext } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";

let previousPresetId: string;
let presetId: string;
test.beforeEach(async ({ request }) => {
  const library = await runtime<{ currentPresetId: string }>(request, {
    type: "play.read",
  });
  previousPresetId = library.currentPresetId;
  const created = await runtime<{ preset: { id: string } }>(request, {
    type: "play.create",
    name: `HTTP prompt editing ${Date.now()}`,
  });
  presetId = created.preset.id;
  await runtime(request, { type: "play.select", presetId });
});

test.afterEach(async ({ page, request }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await runtime(request, { type: "play.select", presetId: previousPresetId });
  await runtime(request, { type: "play.delete", presetId });
});

for (const tab of ["游玩", "设定完善"]) {
  for (const action of ["新增提示词", "克隆提示词"]) {
    test(`${tab}：普通 HTTP 下${action}可编辑并保存`, async ({
      page,
      baseURL,
    }) => {
      // A non-loopback HTTP origin has the same Web Crypto restrictions as LAN access.
      const origin = "http://narraeon.test";
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(`${origin}/**`, async (route) => {
        const response = await route.fetch({
          url: route.request().url().replace(origin, baseURL!),
        });
        await route.fulfill({ response });
      });
      await page.goto(origin);
      await page
        .locator(".workspace-locale-picker select")
        .selectOption("zh-CN");
      expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe(
        "undefined",
      );
      await page.getByRole("button", { name: "预设", exact: true }).click();
      await page.getByRole("tab", { name: new RegExp(tab, "u") }).click();
      const order = page.getByRole("list", { name: "提示词顺序", exact: true });
      const count = await order.getByRole("listitem").count();
      const originalBody = await page
        .getByLabel("提示词正文", { exact: true })
        .inputValue();
      await page.getByRole("button", { name: action, exact: true }).click();
      expect(errors).toEqual([]);
      await expect(order.getByRole("listitem")).toHaveCount(count + 1, {
        timeout: 2_000,
      });
      const body = page.getByLabel("提示词正文", { exact: true });
      await expect(body).toBeEditable();
      await expect(body).toHaveValue(
        action === "克隆提示词" ? originalBody : "",
      );
      const name = `${tab}-${action}-${Date.now()}`;
      await page.getByLabel("提示词名称", { exact: true }).fill(name);
      await body.fill(`独立正文：${name}`);
      await page
        .getByLabel("发送角色", { exact: true })
        .selectOption("assistant");
      // Cloning an editable user prompt must also keep an independent identity and body.
      await page
        .getByRole("button", { name: "克隆提示词", exact: true })
        .click();
      await expect(order.getByRole("listitem")).toHaveCount(count + 2);
      await expect(body).toHaveValue(`独立正文：${name}`);
      await expect(page.getByLabel("发送角色", { exact: true })).toHaveValue(
        "assistant",
      );
      const copyName = `${name} 副本`;
      await expect(page.getByLabel("提示词名称", { exact: true })).toHaveValue(
        copyName,
      );
      await body.fill(`副本正文：${name}`);
      await page.getByRole("button", { name: "保存修改", exact: true }).click();
      await expect(
        page.getByText("预设已保存。", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "预设", exact: true }).click();
      await page.getByRole("tab", { name: new RegExp(tab, "u") }).click();
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByLabel("提示词正文", { exact: true })).toHaveValue(
        `独立正文：${name}`,
      );
      await page.getByRole("button", { name: copyName, exact: true }).click();
      await expect(page.getByLabel("提示词正文", { exact: true })).toHaveValue(
        `副本正文：${name}`,
      );
      expect(errors).toEqual([]);
    });
  }
}

async function runtime<T = unknown>(
  request: APIRequestContext,
  input: V1Request,
): Promise<T> {
  const response = await request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request: input },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: T };
  return body.result;
}
