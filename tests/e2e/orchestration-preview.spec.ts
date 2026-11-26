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
  await expect(panel.getByRole("status")).toHaveText("协议顺序检查 · 未检查");
  await expect(panel.getByText("动态占位", { exact: true })).toBeVisible();

  const response = page.waitForResponse((reply) => {
    const body = reply.request().postDataJSON() as {
      request?: V1Request;
    } | null;
    return (
      body?.request?.type === "play.orchestration.preview" &&
      Object.values(body.request.candidate?.structure ?? {}).some((value) =>
        JSON.stringify(value).includes("独立编排预览未保存正文"),
      )
    );
  });
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page
    .getByLabel("提示词正文", { exact: true })
    .fill("独立编排预览未保存正文");
  if (!(await panel.isVisible())) await drawer.click();
  await expect(
    panel.getByRole("combobox", { name: "预览版本", exact: true }),
  ).toHaveValue("candidate");
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
  await expect(
    panel.getByText(candidate.selected.revision, { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "预览版本", exact: true })
    .selectOption("current");
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
  await request(page, {
    type: "model.save",
    connection: {
      name: "Local preview connection",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "unused",
      modelId: "preview-fixture",
      contextWindowTokens: 32000,
      maxOutputTokens: 4096,
    },
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
  await expect(panel.getByRole("status")).toHaveText(
    "Protocol order check · Role order is compatible · chat_completions",
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
  await panel
    .getByRole("combobox", { name: "Connection", exact: true })
    .selectOption("none");
  await expect(panel.getByRole("status")).toHaveText(
    "Protocol order check · Not checked",
  );

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

test("an open preview queues latest conditions and coalesces typing without reading while closed", async ({
  page,
}) => {
  await request(page, { type: "preferences.save", locale: "zh-CN" });
  await page.clock.install();
  const reads: Extract<V1Request, { type: "play.orchestration.preview" }>[] =
    [];
  const first = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const finalInFlight = Promise.withResolvers<void>();
  const failAfterClosing = Promise.withResolvers<void>();
  await page.route("**/api/runtime/v1", async (route) => {
    const { request: command } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (command.type !== "play.orchestration.preview") return route.continue();
    reads.push(command);
    if (reads.length === 4) {
      finalInFlight.resolve();
      await failAfterClosing.promise;
      return route.abort("failed");
    }
    if (reads.length !== 1) return route.continue();
    const response = await route.fetch();
    first.resolve();
    await finish.promise;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/#/orchestrations");
    const drawer = page
      .locator("summary")
      .filter({ hasText: /^发送给 AI 的内容预览$/u });
    const panel = page.getByRole("region", { name: "编排预览", exact: true });
    await expect(drawer).toBeVisible();
    await page.clock.runFor(1000);
    expect(reads).toHaveLength(0);
    await drawer.click();
    await page.clock.runFor(250);
    await first.promise;
    const gameplay = panel.getByRole("combobox", {
      name: "预览玩法",
      exact: true,
    });
    for (const scheme of ["d20", "d100", "bag"]) {
      await gameplay.selectOption(scheme);
      await page.clock.runFor(250);
    }
    expect(reads).toHaveLength(1);
    await expect(
      panel.getByRole("heading", { name: "预览结果", exact: true }),
    ).toHaveCount(0);
    finish.resolve();
    await expect(
      panel.getByRole("heading", { name: "预览结果", exact: true }),
    ).toBeVisible();
    expect(reads).toHaveLength(2);
    expect(reads[1]?.gameplay).toEqual({ mode: "tabletop", scheme: "bag" });

    await drawer.click();
    await page.getByRole("button", { name: "新增提示词", exact: true }).click();
    const prompt = page.getByRole("textbox", {
      name: "提示词正文",
      exact: true,
    });
    await prompt.fill("候选内容起点");
    await page.clock.runFor(1500);
    expect(reads).toHaveLength(2);
    await drawer.click();
    for (const contents of ["候选内容一", "候选内容二", "最后一次的候选内容"]) {
      await prompt.fill(contents);
      await page.clock.runFor(140);
    }
    expect(reads).toHaveLength(2);
    await page.clock.runFor(420);
    await expect(
      panel.getByRole("heading", { name: "预览结果", exact: true }),
    ).toBeVisible();
    expect(reads).toHaveLength(3);
    expect(JSON.stringify(reads[2]?.candidate)).toContain("最后一次的候选内容");
    expect(JSON.stringify(reads[2]?.candidate)).not.toContain("候选内容二");

    await gameplay.selectOption("d100");
    await page.clock.runFor(500);
    await finalInFlight.promise;
    await drawer.click();
    failAfterClosing.resolve();
    await page.clock.runFor(1500);
    expect(reads).toHaveLength(4);
  } finally {
    finish.resolve();
    failAfterClosing.resolve();
  }
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
