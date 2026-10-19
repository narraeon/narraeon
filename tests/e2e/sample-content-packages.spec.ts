import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";
import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";

for (const locale of appLocales) {
  test.describe(`first launch sample (${locale})`, () => {
    test("empty workspace → sample → world → opening and status", async ({
      page,
    }) => {
      const root = await mkdtemp(join(tmpdir(), `narraeon-sample-${locale}-`));
      const servers = new RuntimeServerPool();
      try {
        const port = await availableRuntimePort();
        await servers.start(root, port);
        await page.goto(`http://127.0.0.1:${port}`);
        const chinese = locale === "zh-CN";
        const sample = sampleContentPackageForLocale(locale);
        await runtime(page, { type: "preferences.save", locale });
        const empty = await runtime<{
          contentPackages: unknown[];
          worlds: unknown[];
        }>(page, { type: "workspace.read" });
        expect(empty.contentPackages).toEqual([]);
        expect(empty.worlds).toEqual([]);
        await page.reload();
        if (chinese) await page.setViewportSize({ width: 390, height: 844 });
        const start = page.getByRole("button", {
          name: chinese ? "从示例开始" : "Start with a sample",
          exact: true,
        });
        const again = page.getByRole("button", {
          name: chinese ? "从示例新建" : "Create from sample",
          exact: true,
        });
        await expect(start).toBeVisible();
        await expect(again).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: chinese ? "配置模型连接" : "Configure model connection",
            exact: true,
          }),
        ).toBeVisible();

        const creation = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            request.url().endsWith("/api/runtime/v1") &&
            (request.postDataJSON() as { request: V1Request }).request.type ===
              "content.create-sample",
        );
        await start.click();
        expect(
          ((await creation).postDataJSON() as { request: V1Request }).request,
        ).toEqual({ type: "content.create-sample", locale });
        await expect(
          page.getByLabel(chinese ? "开场白预览" : "Opening preview"),
        ).toContainText(
          sample.files
            .find(({ path }) => path === "opening.md")!
            .contents.trim(),
        );
        await expect(
          page.getByRole("button", {
            name: chinese
              ? "从当前内容包创建"
              : "Create from current content package",
            exact: true,
          }),
        ).toBeDisabled();

        // The configured endpoint is deliberately unreachable. Creation and the
        // authored opening require no Provider exchange; this does not test AI play.
        await runtime(page, {
          type: "model.save",
          connection: {
            name: "Sample creation fixture",
            presetId: "custom",
            provider: "chat_completions",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "sample-fixture",
            modelId: "sample-fixture",
            contextWindowTokens: 128000,
            maxOutputTokens: 16000,
            reasoningEffort: "provider_default",
          },
        });
        await page.reload();
        await expect(start).toHaveCount(0);
        await expect(page).toHaveURL(/#\/create$/u);
        await page
          .getByRole("button", {
            name: chinese
              ? "从当前内容包创建"
              : "Create from current content package",
            exact: true,
          })
          .click();
        await expect(page.locator(".world-floating-title")).toHaveText(
          sample.title,
          { timeout: 15_000 },
        );
        const timeline = page.getByLabel(
          chinese ? "故事时间线" : "Story timeline",
        );
        await expect(timeline).toContainText(
          chinese
            ? "雨水沿着旅店的檐角落下"
            : "Rain patters from the inn's eaves.",
        );
        await expect(timeline).toContainText(
          chinese ? "她等着你的回答" : "She waits for your answer.",
        );
        await page
          .getByRole("button", {
            name: chinese ? "此刻" : "Now",
            exact: true,
          })
          .click();
        await expect(page.locator(".world-overlay-rail-left")).toContainText(
          chinese
            ? "秋日，雨夜，晚上九点"
            : "An autumn evening, nine o'clock, steady rain",
        );
        await expect(page.locator(".world-overlay-rail-left")).toContainText(
          chinese
            ? "溪桥镇，雨灯旅店大厅"
            : "Rain Lantern Inn lobby, Brookbridge",
        );
        await page.reload();
        await expect(page).toHaveURL(/#\/world\//u);
        await expect(timeline).toContainText(
          chinese
            ? "雨水沿着旅店的檐角落下"
            : "Rain patters from the inn's eaves.",
        );
        await page
          .getByRole("button", {
            name: chinese ? "返回工作区" : "Back to workspace",
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/#\/$/u);
        const repeated = page.waitForResponse((response) => {
          const request = response.request();
          return (
            request.method() === "POST" &&
            request.url().endsWith("/api/runtime/v1") &&
            (request.postDataJSON() as { request: V1Request }).request.type ===
              "content.create-sample"
          );
        });
        await again.click();
        expect((await repeated).ok()).toBe(true);
        const packages = await runtime<{
          contentPackages: { localId: string; title: string }[];
        }>(page, { type: "workspace.read" });
        expect(packages.contentPackages).toHaveLength(2);
        expect(
          new Set(packages.contentPackages.map(({ localId }) => localId)).size,
        ).toBe(2);
        expect(
          packages.contentPackages.every(({ title }) => title === sample.title),
        ).toBe(true);
      } finally {
        await servers.stopAll();
        await rm(root, { force: true, recursive: true });
      }
    });
  });
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post(
    new URL("/api/runtime/v1", page.url()).toString(),
    {
      data: { protocol: "narraeon.runtime/v1", request },
    },
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
