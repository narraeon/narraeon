import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";
import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { RenderedPlayerView } from "../../src/protocol/playerViews.ts";
import type { V1PlayTimelinePage, V1Request } from "../../src/protocol/v1.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/ContentWorkspace.ts";
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
          model: { configured: boolean };
          worlds: unknown[];
        }>(page, { type: "workspace.read" });
        expect(empty.contentPackages).toEqual([]);
        expect(empty.worlds).toEqual([]);
        expect(empty.model.configured).toBe(false);
        await page.reload();
        if (chinese) await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByRole("heading", {
            name: chinese ? "从一个故事开始" : "Start with a story",
            exact: true,
          }),
        ).toBeVisible();
        const start = page.getByRole("button", {
          name: chinese ? "挑一个故事开玩" : "Choose a story to play",
          exact: true,
        });
        const again = page.getByRole("button", {
          name: chinese ? "从内置故事新建" : "Create from a built-in story",
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
        await page
          .getByRole("dialog")
          .getByRole("button", { name: sample.title, exact: true })
          .click();
        expect(
          ((await creation).postDataJSON() as { request: V1Request }).request,
        ).toEqual({
          type: "content.create-sample",
          locale,
          sampleId: "rainy-inn",
        });
        await expect(
          page.getByLabel(chinese ? "开场白预览" : "Opening preview"),
        ).toContainText(
          sample.files
            .find(({ path }) => path === "opening.md")!
            .contents.trim(),
        );
        const createWorld = page.getByRole("button", {
          name: chinese
            ? "从当前内容包创建"
            : "Create from current content package",
          exact: true,
        });
        await expect(createWorld).toBeEnabled();
        await expect(
          page.getByRole("button", {
            name: chinese ? "编辑这份内容包" : "Refine this content package",
            exact: true,
          }),
        ).toBeVisible();

        // Exercise the optional settings detour using an unreachable endpoint.
        // Creating the world and reading its opening work without a live Provider.
        const packagePicker = page.getByLabel(
          chinese ? "创建世界的内容包" : "Content package for the new world",
          { exact: true },
        );
        const sourceId = await packagePicker.inputValue();
        await page
          .getByRole("button", {
            name: chinese ? "配置模型连接" : "Configure model connection",
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/#\/models$/u);
        await page
          .getByLabel("Base URL", { exact: true })
          .fill("http://127.0.0.1:1/v1");
        await page
          .getByLabel("API Key", { exact: true })
          .fill("sample-fixture");
        await page
          .getByLabel(chinese ? "模型 ID" : "Model ID", { exact: true })
          .fill("sample-fixture");
        await page
          .getByRole("button", {
            name: chinese
              ? "保存模型连接并启用"
              : "Save and enable model connection",
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/#\/create$/u);
        await expect(packagePicker).toHaveValue(sourceId);
        expect(
          (
            await runtime<{ worlds: unknown[] }>(page, {
              type: "workspace.read",
            })
          ).worlds,
        ).toEqual([]);
        await page.reload();
        await expect(start).toHaveCount(0);
        await expect(page).toHaveURL(/#\/create$/u);
        await createWorld.click();
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
          chinese ? "她递来一条干毛巾。" : "She holds out a dry towel.",
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
        await page
          .getByRole("dialog")
          .getByRole("button", { name: sample.title, exact: true })
          .click();
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

const playableStories = [
  {
    id: "missing-reel",
    en: {
      genre: "Detective",
      action: "I ask Noel what he saw away from the sign-in desk.",
      reply: "Noel turns the sign-in sheet face down before he speaks.",
      context: "TS-017",
    },
    "zh-CN": {
      genre: "侦探破案",
      action: "我问罗安离开签到桌时亲眼看见了什么。",
      reply: "罗安开口前，把签到表翻了个面。",
      context: "TS-017",
    },
  },
  {
    id: "screening-night",
    en: {
      genre: "Campus life",
      action:
        "I offer to help Hana test the captions and ask Mina to pend the announcement.",
      reply: "Hana shifts the laptop toward the dry end of the bench.",
      context: "The club has forty-six registrations.",
    },
    "zh-CN": {
      genre: "校园生活",
      action: "我想帮韩夏先试字幕，请米娜暂缓发通知。",
      reply: "韩夏把笔记本往长凳干的那边挪了挪。",
      context: "报名四十六人",
    },
  },
  {
    id: "last-proof",
    en: {
      genre: "Urban romance",
      action:
        "I offer to check the names but tell Lin I need to go home before noodles.",
      reply:
        "Lin passes you the folded proof and says they'll see you upstairs.",
      context: "The two invitations are open and can be answered separately.",
    },
    "zh-CN": {
      genre: "都市恋爱",
      action: "我愿意帮赵林核对署名，不过说我今晚没空去吃面。",
      reply: "赵林把对折的印样递过来，说那就在楼里见。",
      context: "帮忙试印和一起吃面是两件可以分别回答的事。",
    },
  },
] as const;

for (const locale of appLocales) {
  for (const story of playableStories) {
    test(`choose ${story.id}, play a first turn and edit the source (${locale})`, async ({
      page,
    }) => {
      const root = await mkdtemp(join(tmpdir(), "narraeon-story-picker-"));
      const servers = new RuntimeServerPool();
      const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
      const strings = story[locale];
      const sample = sampleContentPackageForLocale(locale, story.id);
      const opening = sample.files.find(
        ({ path }) => path === "opening.md",
      )!.contents;
      const modelRequests: { messages: { content?: string }[] }[] = [];
      const provider = createServer((request, response) => {
        request.setEncoding("utf8");
        let body = "";
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          modelRequests.push(
            JSON.parse(body) as (typeof modelRequests)[number],
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: strings.reply } }] })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      try {
        const port = await availableRuntimePort();
        await servers.start(root, port);
        const origin = `http://127.0.0.1:${port}`;
        await page.goto(origin);
        await runtime(page, { type: "preferences.save", locale });
        if (locale === "zh-CN")
          await page.setViewportSize({ width: 390, height: 844 });
        if (story.id === "last-proof") await page.goto(`${origin}/#/library`);
        else await page.reload();

        const picker = page.getByRole("dialog", {
          name: t("选择一个故事", "Choose a story"),
        });
        const opener = page.getByRole("button", {
          name:
            story.id === "last-proof"
              ? t("从内置故事新建", "Create from a built-in story")
              : t("挑一个故事开玩", "Choose a story to play"),
          exact: true,
        });
        const choice = picker.getByRole("button", {
          name: sample.title,
          exact: true,
        });
        await opener.click();
        await expect(choice).toHaveAccessibleDescription(
          new RegExp(`^${strings.genre} .{10,}`, "u"),
        );
        await page.keyboard.press("Escape");
        await expect(picker).toHaveCount(0);
        await expect(opener).toBeFocused();
        const unopened = await runtime<{ contentPackages: unknown[] }>(page, {
          type: "workspace.read",
        });
        expect(unopened.contentPackages).toEqual([]);
        await opener.click();
        await choice.click();
        await expect(page).toHaveURL(/#\/create$/u);
        await expect(
          page.getByLabel(t("开场白预览", "Opening preview")),
        ).toContainText(opening.split("\n\n", 1)[0]!);
        const packagePicker = page.getByLabel(
          t("创建世界的内容包", "Content package for the new world"),
        );
        const packageId = await packagePicker.inputValue();
        const detail = () =>
          runtime<EditableContentPackageDetail>(page, {
            type: "content.read",
            packageId,
          });
        const original = await detail();
        expect(original).toMatchObject({
          title: sample.title,
          status: "usable",
          issues: [],
        });
        for (const path of [
          "opening.md",
          "world/current-situation.yaml",
          "control/frame.yaml",
        ]) {
          expect(original.files.some((file) => file.path === path)).toBe(true);
        }

        await page
          .getByRole("button", {
            name: t("从当前内容包创建", "Create from current content package"),
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/#\/world\/.+/u);
        const worldId = new URL(page.url()).hash.split("/").at(-1)!;
        const readWorld = () =>
          runtime<{
            head: string;
            playTimeline: V1PlayTimelinePage;
            playerViews: {
              views: RenderedPlayerView[];
              diagnostics: unknown[];
            };
          }>(page, { type: "world.read", worldId });
        const timeline = page.getByLabel(t("故事时间线", "Story timeline"));
        await expect(timeline).toContainText(opening.split("\n\n", 1)[0]!);
        const initialWorld = await readWorld();
        expect(initialWorld.head).toBe("genesis");
        expect(initialWorld.playTimeline.items).toMatchObject([
          { kind: "genesis", exactText: opening },
        ]);
        expect(initialWorld.playerViews.diagnostics).toEqual([]);
        if (story.id === "missing-reel") {
          const clues = initialWorld.playerViews.views
            .flatMap(({ items }) => items)
            .find(({ id }) => id === "known-clues");
          expect(clues?.value).toEqual(
            locale === "zh-CN"
              ? {
                  空展柜:
                    "许玛说五点二十见过母带。玩家亲眼看见蓝毡上的空圆印。",
                }
              : {
                  "Empty case":
                    "Mara says she saw the master at 5:20 p.m. The player can see its empty place on the blue felt.",
                },
          );
          await expect(timeline).not.toContainText(/TS-017|Bay C|C 格/u);
        }
        const send = page.getByRole("button", {
          name: t("从全新上下文发送行动", "Send action from a fresh context"),
          exact: true,
        });
        await page
          .getByRole("textbox", { name: t("你的行动", "Your action") })
          .fill(strings.action);
        await expect(send).toBeDisabled();

        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const address = provider.address();
        if (address === null || typeof address === "string")
          throw new Error("Provider fixture has no port");
        await runtime(page, {
          type: "model.save",
          connection: {
            name: "Built-in stories fixture",
            presetId: "custom",
            provider: "chat_completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "fixture-key",
            modelId: "fixture-model",
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_000,
          },
        });
        await page.reload();
        await page
          .getByRole("textbox", { name: t("你的行动", "Your action") })
          .fill(strings.action);
        expect(modelRequests).toHaveLength(0);
        await send.click();
        await expect(timeline).toContainText(strings.reply);
        expect(modelRequests).toHaveLength(1);
        const dispatched = modelRequests[0]!.messages
          .map(({ content }) => content ?? "")
          .join("\n");
        expect(dispatched.split(opening)).toHaveLength(2);
        expect(dispatched).toContain(strings.context);
        expect(dispatched).toContain(strings.action);

        await page
          .getByRole("button", {
            name: t("返回工作区", "Back to workspace"),
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name: t(
              `打开内容包：${sample.title}`,
              `Open content package: ${sample.title}`,
            ),
            exact: true,
          })
          .click();
        const fileTools = page.getByRole("navigation", {
          name: t("设定完善工具", "Setting-improvement tools"),
        });
        await fileTools
          .getByRole("button", { name: t("文件", "Files"), exact: true })
          .click();
        const tree = page.getByRole("navigation", {
          name: t("内容包文件树", "Content-package file tree"),
        });
        await tree
          .getByRole("button", { name: "opening.md", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: t("编辑这份文件", "Edit this file"),
            exact: true,
          })
          .click();
        const edit = page.getByLabel(t("编辑 opening.md", "Edit opening.md"), {
          exact: true,
        });
        await expect(edit).toHaveValue(opening);
        const revised =
          opening +
          "\n" +
          t("街上传来了铃声。", "A bell sounded in the street.") +
          "\n";
        await edit.fill(revised);
        const editor = page.getByRole("complementary", {
          name: t("内容包文件编辑", "Content-package file editing"),
        });
        await editor
          .getByRole("button", {
            name: t("整批保存", "Save all changes"),
            exact: true,
          })
          .click();
        await expect
          .poll(
            async () =>
              (await detail()).files.find(({ path }) => path === "opening.md")
                ?.contents,
          )
          .toBe(revised);
        const afterEdit = await readWorld();
        expect(afterEdit.playTimeline.items[0]).toMatchObject({
          kind: "genesis",
          exactText: opening,
        });
        expect(
          afterEdit.playTimeline.items.filter(
            (item) =>
              item.kind === "event" &&
              item.event.kind === "player" &&
              item.event.text === strings.action,
          ),
        ).toHaveLength(1);
        expect(
          afterEdit.playTimeline.items.filter(
            (item) =>
              item.kind === "event" &&
              item.event.kind === "assistant" &&
              item.event.text === strings.reply,
          ),
        ).toHaveLength(1);
      } finally {
        if (provider.listening) {
          await new Promise<void>((resolve) => provider.close(() => resolve()));
        }
        await servers.stopAll();
        await rm(root, { force: true, recursive: true });
      }
    });
  }
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
