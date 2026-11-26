import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { OrchestrationPreviewResult } from "../../src/protocol/orchestrationPreview.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "orchestration-preview" });

test("empty workspace previews unsaved and saved changes without accessing instances", async ({
  page,
}) => {
  await request(page, { type: "preferences.save", locale: "zh-CN" });
  const seen = observe(page);
  await page.goto("/#/orchestrations");
  const drawer = page
    .locator("summary")
    .filter({ hasText: /^发送给 AI 的内容预览$/u });
  await drawer.click();
  const panel = page.getByRole("region", { name: "编排预览", exact: true });
  const generate = panel.getByRole("button", {
    name: "生成编排预览",
    exact: true,
  });
  await generate.click();
  await expect(panel.getByRole("status")).toHaveText("协议顺序检查 · 未检查");
  await expect(panel.getByText("动态占位", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("独立编排预览未保存正文");
  if (!(await panel.isVisible())) await drawer.click();
  await expect(
    panel.getByRole("combobox", { name: "预览版本", exact: true }),
  ).toHaveValue("candidate");
  const response = page.waitForResponse((reply) => {
    const body = reply.request().postDataJSON() as {
      request?: V1Request;
    } | null;
    return body?.request?.type === "play.orchestration.preview";
  });
  await generate.click();
  const candidate = (
    (await (await response).json()) as { result: OrchestrationPreviewResult }
  ).result;
  expect(candidate.selectedKind).toBe("candidate");
  expect(
    candidate.comparison.changes.some(
      ({ after }) => after?.markdown === "独立编排预览未保存正文",
    ),
  ).toBe(true);
  expect(seen.filter(({ type }) => type === "play.save")).toHaveLength(0);
  await expect(
    panel.getByText("与已应用版本比较", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    panel.getByRole("combobox", { name: "预览版本", exact: true }),
  ).toHaveValue("draft");
  await generate.click();
  await expect(
    panel.getByText(candidate.selected.revision, { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "预览版本", exact: true })
    .selectOption("current");
  await generate.click();
  await expect(
    panel.getByText("此表面的编排一致。", { exact: true }),
  ).toBeVisible();
  expect(seen.filter(({ type }) => type === "workspace.read")).toEqual([
    { type: "workspace.read", scope: "orchestration" },
  ]);
  expect(seen.filter(({ type }) => type === "play.save")).toHaveLength(1);

  // Leaving the workbench restores the normal workspace read.
  await page.getByRole("button", { name: "我的世界", exact: true }).click();
  await expect
    .poll(() => seen.filter(({ type }) => type === "workspace.read").at(-1))
    .toEqual({ type: "workspace.read" });
  await page.goBack();
  await expect(
    panel.getByRole("combobox", { name: "预览版本", exact: true }),
  ).toHaveCount(0);
  await drawer.click();
  await panel.getByLabel("预览玩法").selectOption("d20");
  expect(seen.filter(({ type }) => type === "workspace.read").at(-1)).toEqual({
    type: "workspace.read",
    scope: "orchestration",
  });
});

test("author preview switches targets in English with existing instances kept outside the workbench", async ({
  page,
}) => {
  await request(page, { type: "preferences.save", locale: "en" });
  const pack = await request<{ localId: string }>(page, {
    type: "content.create",
  });
  await request(page, {
    type: "content.rename",
    packageId: pack.localId,
    name: "Private example package",
  });
  await request(page, {
    type: "world.create",
    packageId: pack.localId,
    operationId: "orchestration-preview-test",
  });
  const seen = observe(page);
  await page.goto("/#/orchestrations");
  await page.getByRole("tab", { name: "Setting improvement" }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Preview content sent to AI$/u })
    .click();
  const panel = page.getByRole("region", {
    name: "Orchestration preview",
    exact: true,
  });
  const generate = panel.getByRole("button", {
    name: "Generate orchestration preview",
    exact: true,
  });
  await generate.click();
  await expect(panel.getByRole("status")).toHaveText(
    "Protocol order check · Not checked",
  );
  await expect(
    panel.getByText("content-package:title", { exact: true }).first(),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "Authoring target", exact: true })
    .selectOption("world-revision");
  await panel
    .getByRole("combobox", { name: "Preview gameplay", exact: true })
    .selectOption("d100");
  await generate.click();
  await expect(
    panel.getByText("world-revision:title", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    panel.getByText("Known turn-guide lines", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private example package", { exact: true }),
  ).toHaveCount(0);
  expect(seen.filter(({ type }) => type === "workspace.read")).toEqual([
    { type: "workspace.read", scope: "orchestration" },
  ]);
  expect(
    seen.filter(({ type }) => type === "play.orchestration.preview"),
  ).toMatchObject([
    { surface: "author", authorTarget: "setting" },
    {
      surface: "author",
      authorTarget: "world-revision",
      gameplay: { mode: "tabletop", scheme: "d100" },
    },
  ]);
});

function observe(page: Page): V1Request[] {
  const seen: V1Request[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/runtime/v1")) return;
    const { request: command } = request.postDataJSON() as {
      request: V1Request;
    };
    seen.push(command);
    const available = [
      "workspace.read",
      "play.read",
      "play.orchestration.preview",
      "play.save",
    ];
    expect(available).toContain(command.type);
  });
  return seen;
}

async function request<T = unknown>(page: Page, input: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request: input },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
