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
import type {
  ContentTreeFile,
  V1PlayTimelinePage,
  V1Request,
} from "../../src/protocol/v1.ts";
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
        const choices = page
          .getByRole("dialog")
          .getByRole("list")
          .getByRole("button");
        await expect(choices).toHaveCount(12);
        await expect(choices.first()).toHaveAccessibleName(sample.title);
        await expect(choices.nth(1)).toHaveAccessibleName(
          chinese ? "潮退后的遗迹" : "The Vault at Ebb Tide",
        );
        await expect(choices.nth(3)).toHaveAccessibleName(
          chinese ? "末灯在听" : "Last Light Listening",
        );
        if (chinese)
          await expect(choices.nth(3)).toBeInViewport({ ratio: 0.75 });
        await choices.first().click();
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
      context: ["TS-017"],
    },
    "zh-CN": {
      genre: "侦探破案",
      action: "我问罗安离开签到桌时亲眼看见了什么。",
      reply: "罗安开口前，把签到表翻了个面。",
      context: ["TS-017"],
    },
  },
  {
    id: "screening-night",
    en: {
      genre: "Campus life",
      action:
        "I take out my own headphones and offer to help Hana test the captions. I ask Mina to hold off on the announcement.",
      reply: "Hana cues the shot so you can try it with your own headphones.",
      context: [
        "The club needs to decide whether and how to hold tonight's screening",
        "The club has forty-six registrations. Room 204 holds twenty-eight and must be claimed by six.",
        "watch the captions against the audio and spot the mismatch for themselves",
        "A listener can use their own headphones or borrow hers",
      ],
    },
    "zh-CN": {
      genre: "校园生活",
      action: "我拿出自己的耳机，提出帮韩夏先试字幕，请米娜暂缓发通知。",
      reply: "韩夏把片子停在那个镜头附近，好让你用自己的耳机试听。",
      context: [
        "今晚是否放映、怎么安排，以及要怎样及时通知报名的人",
        "报名四十六人，204 教室只有二十八座，六点前要领钥匙",
        "让对方边看字幕边听声音，自己找出错位",
        "对方带了耳机就用那副",
      ],
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
      context: ["The two invitations are open and can be answered separately."],
    },
    "zh-CN": {
      genre: "都市恋爱",
      action: "我愿意帮赵林核对署名，不过说我今晚没空去吃面。",
      reply: "赵林把对折的印样递过来，说那就在楼里见。",
      context: ["帮忙试印和一起吃面是两件可以分别回答的事。"],
    },
  },
  {
    id: "tide-vault",
    en: {
      genre: "Fantasy exploration",
      action:
        "I ask Ivo to watch the tide marks while Sera and I inspect the nearest rope fixing.",
      reply:
        "Ivo turns his lamp so you can see the dark notch below the bronze bird.",
      context: [
        "Awaiting a response:",
        "thirty-five minutes from this low water",
        "twenty-four-meter rope",
      ],
    },
    "zh-CN": {
      genre: "奇幻探险",
      action: "我请伊沃留意水痕，和塞拉检查最近能固定绳子的地方。",
      reply: "伊沃把灯朝铜鸟下方的深槽斜了斜，好让你看清水位。",
      context: [
        "待回应:",
        "通常有约三十五分钟能从拱门步行撤出",
        "二十四米长的好绳",
      ],
    },
  },
  {
    id: "lost-signal",
    en: {
      genre: "Science-fiction first contact",
      action:
        "I offer to pulse our lights in a new order and ask what a manual tether would mean to them.",
      reply:
        "Em proposes a pattern of her own, then asks who would be free to release the tether.",
      context: [
        "Open channel:",
        "where to start counting the approach lights",
        "Live station observations:",
        "The two sides have yet to exchange a fresh lamp signal.",
        "have the character explain in everyday words",
        "A crew member stays at the ship controls",
        "about six hours of elapsed time",
        "wants a chance to cross-check a local reading in return",
      ],
    },
    "zh-CN": {
      genre: "科幻首次接触",
      action: "我提议按一个新顺序闪灯，再问对方愿意接受怎样的手动系缆条件。",
      reply: "埃姆提了一个闪灯顺序，又问双方谁能解开系缆。",
      context: [
        "通话中:",
        "想知道引导灯从哪头开始数",
        "站方即时观测:",
        "双方尚未交换临时灯号。",
        "让提出的人先用日常话说清楚",
        "共同的脱离信号",
        "航路中断后过了约六小时",
        "想换取一项能自己核对的站方读数",
      ],
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
        if (story.id === "screening-night") {
          expect(
            initialWorld.playerViews.views[0]?.items.map(({ value }) => value),
          ).toEqual(
            locale === "zh-CN"
              ? ["秋季学期，周四下午五点四十分", "花楸学院院子，图书馆屋檐下"]
              : [
                  "Thursday, 5:40 p.m., during autumn term",
                  "Rowan College courtyard, under the library eaves",
                ],
          );
        }
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
        for (const material of strings.context)
          expect(dispatched).toContain(material);
        expect(dispatched).toContain(strings.action);
        if (story.id === "screening-night") {
          const spokenLine = t(
            "你说，我们到底怎么跟大家讲？",
            "What do you think we should actually tell people?",
          );
          expect(opening).toContain(spokenLine);
          expect(dispatched.split(spokenLine)).toHaveLength(2);
          expect(dispatched).toContain("@hana");
          expect(dispatched).toContain("@mina");
        }
        if (story.id === "missing-reel") {
          expect(dispatched).toContain("@service-corridor");
          expect(dispatched).toContain("@reading-room");
        }
        if (story.id === "lost-signal") {
          const requestForBerth = t(
            "如果你们有不接数据线的泊位，能给我们一个吗？",
            "If you have a berth without a live data link, may we ask for it?",
          );
          expect(opening).toContain(requestForBerth);
          expect(dispatched.split(requestForBerth)).toHaveLength(2);
          expect(dispatched).not.toContain(
            t("目前站方事实:", "On the relay now:"),
          );
        }

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
        const history = await runtime<ContentTreeFile[]>(page, {
          type: "world.surface.read",
          worldId,
          surface: "history",
        });
        expect(history.map(({ contents }) => contents)).toEqual([
          opening,
          strings.action,
          strings.reply,
        ]);
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
