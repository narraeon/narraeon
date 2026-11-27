import { expect, test as base, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1PlayTimelinePage, V1Request } from "../../src/protocol/v1.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright parses the destructured fixture dependencies.
  baseURL: async ({}, use) => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-original-content-title-"),
    );
    const servers = new RuntimeServerPool();
    try {
      const port = await availableRuntimePort();
      await servers.start(root, port);
      await use(`http://127.0.0.1:${port}`);
    } finally {
      await servers.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  },
});

interface Workspace {
  contentPackages: { localId: string; title: string }[];
  worlds: { worldId: string; title: string }[];
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

async function startProvider(
  opening: string,
  suggestion: string,
  reply: string,
) {
  const requests: string[] = [];
  const responses = [
    [{ name: "setting_read", arguments: { path: "opening.md" } }],
    [
      {
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: opening },
      },
      { name: "setting_suggest_title", arguments: { title: suggestion } },
    ],
    reply,
  ];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => (body += chunk));
    request.once("end", () => {
      const next = responses[requests.length];
      requests.push(body);
      if (next === undefined) {
        response.writeHead(500).end();
        return;
      }
      const delta =
        typeof next === "string"
          ? { content: next }
          : {
              tool_calls: next.map((call, index) => ({
                index,
                id: `title-fixture-${requests.length}-${index}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            };
      const finishReason = typeof next === "string" ? "stop" : "tool_calls";
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
            "data: [DONE]\n\n",
        );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Provider fixture has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const scenarios = [
  { locale: "zh-CN", decision: "adopt" },
  { locale: "en", decision: "edit" },
  { locale: "en", decision: "keep" },
  { locale: "en", decision: "already named" },
] as const;

for (const { locale, decision } of scenarios) {
  test(`${locale}: ${decision} a one-sentence story title and create a world`, async ({
    page,
  }) => {
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    const idea = t(
      "写一个关于末班渡船捎来明天信件的故事。",
      "Write a story about the last ferry bringing a letter from tomorrow.",
    );
    const opening = t(
      "末班渡船靠岸。船工递给你一封落款是明天的信。",
      "The last ferry docks. The boatkeeper hands you a letter dated tomorrow.",
    );
    const suggestedTitle = t("明日来信", "A Letter from Tomorrow");
    const reply = t("开场已经写好。", "The opening is ready.");
    const placeholder = t("待创作内容包", "Untitled content package");
    const existingTitle = "The Last Ferry";
    const initialTitle =
      decision === "already named" ? existingTitle : placeholder;
    const editedTitle = "Tomorrow's Last Ferry";
    const finalTitle =
      decision === "adopt"
        ? suggestedTitle
        : decision === "edit"
          ? editedTitle
          : initialTitle;
    const provider = await startProvider(opening, suggestedTitle, reply);

    try {
      await runtime(page, { type: "preferences.save", locale });
      await runtime(page, {
        type: "model.save",
        connection: {
          name: "Story title fixture",
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: provider.baseUrl,
          apiKey: "fixture-key",
          modelId: "fixture-model",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8192,
        },
      });
      const workspace = () =>
        runtime<Workspace>(page, { type: "workspace.read" });
      const button = (zh: string, en: string) =>
        page.getByRole("button", { name: t(zh, en), exact: true });
      const packageCard = (title: string) =>
        button(`打开内容包：${title}`, `Open content package: ${title}`);
      const contentLibrary = button("内容库", "Content library");
      const createPackageLabel = t("新建内容包", "Create content package");
      await page.goto("/");
      await contentLibrary.click();
      await button("新建内容包", "Create content package").click();
      await page
        .getByRole("dialog", { name: createPackageLabel })
        .getByRole("button", { name: t("创建", "Create"), exact: true })
        .click();
      await expect(page).toHaveURL(/#\/content\/[^/]+$/u);
      const { contentPackages } = await workspace();
      expect(contentPackages).toMatchObject([{ title: placeholder }]);
      const packageId = contentPackages[0]!.localId;
      if (decision === "already named") {
        await contentLibrary.click();
        await page
          .getByLabel(`Content-package actions: ${placeholder}`)
          .click();
        await page
          .getByRole("button", {
            name: `Rename content package: ${placeholder}`,
            exact: true,
          })
          .click();
        await page
          .getByRole("textbox", { name: "Content-package title" })
          .fill(existingTitle);
        await page
          .getByRole("button", {
            name: "Save content-package title",
            exact: true,
          })
          .click();
        await packageCard(existingTitle).click();
      }

      const commands: V1Request[] = [];
      const renameStarted = Promise.withResolvers<void>();
      const rejectRename = Promise.withResolvers<void>();
      const createStarted = Promise.withResolvers<void>();
      const releaseCreate = Promise.withResolvers<void>();
      let renameAttempts = 0;
      await page.route("**/api/runtime/v1", async (route) => {
        const command = (
          route.request().postDataJSON() as { request: V1Request }
        ).request;
        if (
          command.type === "content.rename" ||
          command.type === "world.create"
        )
          commands.push(command);
        if (decision === "edit" && command.type === "world.create") {
          createStarted.resolve();
          await releaseCreate.promise;
          const published = await route.fetch();
          expect(published.ok(), await published.text()).toBe(true);
          return route.abort("failed");
        }
        if (
          decision === "edit" &&
          command.type === "content.rename" &&
          ++renameAttempts === 1
        ) {
          renameStarted.resolve();
          await rejectRename.promise;
          return route.fulfill({
            status: 400,
            json: {
              protocol: "narraeon.runtime/v1",
              error: {
                code: "invalid_state",
                message: "Fixture could not save the title.",
              },
            },
          });
        }
        return route.continue();
      });

      await page
        .getByRole("textbox", {
          name: t(
            "用全新上下文给 AI 发消息",
            "Message the model in a fresh context",
          ),
        })
        .fill(idea);
      await button("发送", "Send").click();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      expect(await workspace()).toMatchObject({
        contentPackages: [{ localId: packageId, title: initialTitle }],
        worlds: [],
      });
      expect(commands).toEqual([]);
      expect(provider.requests).toHaveLength(3);

      const title = page.getByRole("textbox", {
        name: t("书名", "Story title"),
        exact: true,
      });
      const createWorld = page
        .getByRole("navigation", {
          name: t("设定完善工具", "Setting-improvement tools"),
        })
        .getByRole("button", {
          name: t("创建世界", "Create world"),
          exact: true,
        });
      await expect(title).toHaveValue(suggestedTitle);
      if (decision === "already named")
        await expect(
          page.getByText(`Current title: ${existingTitle}`, { exact: true }),
        ).toBeVisible();
      await expect(
        page.getByText(
          t(
            "内容包已准备好。点击「创建世界」开始游玩。",
            "Your content package is ready. Select “Create world” to start playing.",
          ),
          { exact: true },
        ),
      ).toBeVisible();
      expect(provider.requests[0]).toContain('"name":"setting_suggest_title"');
      expect(provider.requests[0]).toContain(
        t(
          "内容包准备好时，告诉作者下一步点击「创建世界」",
          "When the content package is ready, tell the author to click “Create world” next",
        ),
      );
      expect(provider.requests[0]).toContain(
        t(
          "不要声称世界已经创建或游玩已经开始",
          "Never claim during setting improvement that a world has already been created or play has already started",
        ),
      );

      await page.reload();
      await expect(title).toHaveValue(suggestedTitle);
      expect(commands).toEqual([]);
      if (decision === "adopt") {
        await createWorld.click();
        await expect(title).toBeFocused();
        expect(commands).toEqual([]);
        expect((await workspace()).worlds).toEqual([]);
        await button("采用建议书名", "Use suggested title").click();
      } else if (decision === "edit") {
        await title.fill(editedTitle);
        const save = button("保存书名", "Save title");
        try {
          await expect(createWorld).toBeDisabled();
          await save.click();
          await renameStarted.promise;
          await expect(button("正在保存书名…", "Saving title…")).toBeDisabled();
          await expect(title).toBeDisabled();
          await expect(createWorld).toBeDisabled();
          expect(commands).toHaveLength(1);
        } finally {
          rejectRename.resolve();
        }
        await expect(
          page.getByText("Could not save the title. Try again.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(title).toHaveValue(editedTitle);
        expect(await workspace()).toMatchObject({
          contentPackages: [{ localId: packageId, title: initialTitle }],
          worlds: [],
        });
        await save.click();
      } else {
        if (decision === "keep") {
          await title.fill(editedTitle);
          await expect(createWorld).toBeDisabled();
        }
        await button("保留当前书名", "Keep current title").click();
      }

      await expect.poll(workspace).toMatchObject({
        contentPackages: [{ localId: packageId, title: finalTitle }],
        worlds: [],
      });
      const expectedRenames =
        decision === "adopt" ? 1 : decision === "edit" ? 2 : 0;
      expect(commands).toEqual(
        Array.from({ length: expectedRenames }, () => ({
          type: "content.rename",
          packageId,
          name: finalTitle,
          expectedTitle: initialTitle,
        })),
      );
      await expect(createWorld).toBeEnabled();
      await contentLibrary.click();
      await expect(packageCard(finalTitle)).toBeVisible();
      await packageCard(finalTitle).click();
      await expect(page).toHaveURL(new RegExp(`/#/content/${packageId}$`, "u"));
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await expect(title).toBeHidden();
      expect((await workspace()).worlds).toEqual([]);

      try {
        await createWorld.click();
        if (decision === "edit") {
          await createStarted.promise;
          await expect(createWorld).toBeDisabled();
          expect((await workspace()).worlds).toEqual([]);
          expect(
            commands.filter(({ type }) => type === "world.create"),
          ).toHaveLength(1);
        }
      } finally {
        releaseCreate.resolve();
      }
      const worldTitle = page.getByRole("heading", {
        name: finalTitle,
        exact: true,
      });
      const timeline = page.getByRole("article", {
        name: t("故事时间线", "Story timeline"),
      });
      await expect(worldTitle).toBeVisible();
      await expect(timeline.getByText(opening, { exact: true })).toBeVisible();
      const { worlds } = await workspace();
      expect(worlds).toMatchObject([{ title: finalTitle }]);
      const worldId = worlds[0]!.worldId;
      const view = await runtime<{
        head: string;
        playTimeline: V1PlayTimelinePage;
      }>(page, { type: "world.read", worldId });
      expect(view).toMatchObject({
        head: "genesis",
        playTimeline: { items: [{ kind: "genesis", exactText: opening }] },
      });

      await button("我的世界", "My worlds").click();
      await button(
        `打开世界：${finalTitle}`,
        `Open world: ${finalTitle}`,
      ).click();
      await expect(page).toHaveURL(new RegExp(`/#/world/${worldId}$`, "u"));
      await page.reload();
      await expect(worldTitle).toBeVisible();
      expect(
        commands.filter(({ type }) => type === "world.create"),
      ).toHaveLength(1);
      expect(provider.requests).toHaveLength(3);
    } finally {
      await provider.close();
    }
  });
}
