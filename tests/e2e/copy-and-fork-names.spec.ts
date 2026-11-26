import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "copy-and-fork-names" });

for (const locale of ["zh-CN", "en"] as const) {
  const t = <T>(zh: T, en: T) => (locale === "zh-CN" ? zh : en);
  test(`${locale}: long copies and current-world forks stay distinct in the list after replay`, async ({
    page,
  }) => {
    const title = t("雨", "R").repeat(160);
    const { localId: packageId } = await runtime<{ localId: string }>(page, {
      type: "content.create-sample",
      locale,
    });
    await runtime(page, { type: "preferences.save", locale });
    await runtime(page, { type: "content.rename", packageId, name: title });
    const { world } = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      packageId,
      operationId: `names-browser-${locale}`,
    });

    const copyRequests: V1Request[] = [];
    const forkRequests: V1Request[] = [];
    await page.route("**/api/runtime/v1", async (route) => {
      const command = (route.request().postDataJSON() as { request: V1Request })
        .request;
      const recorded =
        command.type === "content.copy"
          ? copyRequests
          : command.type === "world.derive"
            ? forkRequests
            : null;
      if (recorded !== null) {
        recorded.push(command);
        if (recorded.length === 1) {
          const committed = await route.fetch();
          expect(committed.ok(), await committed.text()).toBe(true);
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });

    await page.goto("/#/");
    const packageCard = (name: string) =>
      page.getByRole("button", {
        name: t(`打开内容包：${name}`, `Open content package: ${name}`),
        exact: true,
      });
    const worldCard = (name: string) =>
      page.getByRole("button", {
        name: t(`打开世界：${name}`, `Open world: ${name}`),
        exact: true,
      });
    const displayedName = (label: string, number = "") => {
      const suffix = ` · ${label}${number}`;
      return `${title.slice(0, 159 - suffix.length)}…${suffix}`;
    };
    const unconfirmed = t(/尚无法确认/u, /Could not confirm the outcome/u);

    for (const number of ["", " 2"]) {
      await packageCard(title).click();
      await page
        .getByRole("navigation", {
          name: t("设定完善工具", "Setting-improvement tools"),
        })
        .getByRole("button", { name: t("编辑", "Edit"), exact: true })
        .click();
      const rail = page.getByRole("complementary", {
        name: t("内容包文件编辑", "Content-package file editing"),
      });
      await rail
        .getByText(t("内容包操作", "Content-package actions"), { exact: true })
        .click();
      const copyButton = rail.getByRole("button", {
        name: t("创建独立副本", "Create an independent copy"),
        exact: true,
      });
      await copyButton.click();
      if (number === "") {
        await expect(page.getByText(unconfirmed)).toBeVisible();
        expect(copyRequests).toHaveLength(1);
        await copyButton.click();
      }
      const copyName = displayedName(t("副本", "Copy"), number);
      await expect(packageCard(copyName)).toContainText(copyName);
    }
    expect(copyRequests).toHaveLength(3);
    expect(copyRequests[0]).toEqual(copyRequests[1]);
    expect(copyRequests[2]).not.toEqual(copyRequests[1]);
    expect(copyRequests[0]).toMatchObject({
      type: "content.copy",
      packageId,
      operationId: expect.any(String),
    });
    await expect(packageCard(title)).toContainText(title);

    for (const number of ["", " 2"]) {
      await worldCard(title).click();
      await expect(page).toHaveURL(
        new RegExp(`/#/world/${world.worldId}$`, "u"),
      );
      await page
        .getByRole("button", {
          name: t("世界管理", "World management"),
          exact: true,
        })
        .click();
      const forkButton = page
        .getByRole("dialog", { name: t("世界管理", "World management") })
        .getByRole("button", {
          name: t("创建分叉", "Create fork"),
          exact: true,
        });
      await forkButton.click();
      if (number === "") {
        await expect(page.getByText(unconfirmed)).toBeVisible();
        expect(forkRequests).toHaveLength(1);
        await forkButton.click();
      }
      const forkName = displayedName(t("分叉", "Fork"), number);
      await expect(
        page.getByRole("heading", { name: forkName, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: t("返回工作区", "Back to workspace") })
        .click();
      await expect(worldCard(forkName)).toContainText(forkName);
    }
    expect(forkRequests).toHaveLength(3);
    expect(forkRequests[0]).toEqual(forkRequests[1]);
    expect(forkRequests[2]).not.toEqual(forkRequests[1]);
    await expect(worldCard(title)).toContainText(title);
    await expect(
      page
        .locator(".home-package-card")
        .filter({ hasText: title.slice(0, 20) }),
    ).toHaveCount(3);
    await expect(
      page.locator(".home-world-card").filter({ hasText: title.slice(0, 20) }),
    ).toHaveCount(3);
  });
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
