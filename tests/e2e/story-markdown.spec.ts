import { createServer } from "node:http";
import { expect, type Locator, type Page } from "@playwright/test";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({
  runtimeScope: "story-markdown",
  viewport: { width: 360, height: 780 },
  isMobile: true,
  hasTouch: true,
});

const storyUrl = "https://story-links.test/chart";
const opening = [
  "# 雾港夜航",
  "",
  "第一行，灯还亮着。",
  "Second line with **a light** and *a whisper*.",
  "",
  "- 拿起钥匙",
  "- Listen",
  "",
  "> 保持安静。",
  "",
  `Read the [chart](${storyUrl}).`,
  "[Unsafe](javascript:alert%281%29) [Local](#/models)",
  "![海图](https://story-links.test/image.png)",
  "",
  "<script>window.storyCodeRan = true</script>",
  '<img src="https://story-links.test/raw.png">',
  "",
].join("\n");

const initial = `## 风暴继续\n\n${"The waves push against the hull.\n\n".repeat(65)}雨声越来越响。`;
const unclosed = "**窗";
const codeLine = "Long_unbroken_code_".repeat(25);
const remainder = `户**在抖。  \nThe ship wakes.\n\n\`inline\`\n\n\`\`\`text\n${codeLine}\n\`\`\``;
const reply = initial + unclosed + remainder;
const action = "**我推开门。**\nI listen.";

test("opening, streamed reply, and saved story keep Markdown readable and source intact on mobile", async ({
  page,
  context,
}) => {
  const continueStream = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let providerBody = "";
  await using provider = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (providerBody += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (content: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
      response.write(frame(initial));
      void continueStream.promise.then(() => response.write(frame(unclosed)));
      void finish.promise.then(() =>
        response.end(`${frame(remainder)}data: [DONE]\n\n`),
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Provider port missing");

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const externalRequests: string[] = [];
    await context.route("https://story-links.test/**", async (route) => {
      externalRequests.push(route.request().url());
      await route.fulfill({ body: "chart" });
    });
    await runtime(page, { type: "preferences.save", locale: "en" });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Story Markdown fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "story-markdown-fixture",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const { localId: packageId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const pack = await runtime<{
      files: ContentTreeFile[];
      treeRevision: string;
    }>(page, { type: "content.read", packageId });
    await runtime(page, {
      type: "content.replace",
      packageId,
      baseTreeRevision: pack.treeRevision,
      files: pack.files.map((file) =>
        file.path === "opening.md" ? { ...file, contents: opening } : file,
      ),
    });

    await page.goto("/#/create");
    await page
      .getByRole("combobox", { name: "Content package for the new world" })
      .selectOption(packageId);
    const preview = page.getByRole("article", { name: "Opening preview" });
    await expectOpening(preview);
    await expect(preview.locator("script, img")).toHaveCount(0);
    expect(await page.evaluate(() => "storyCodeRan" in window)).toBe(false);
    expect(externalRequests).toEqual([]);
    const link = preview.getByRole("link", { name: "chart" });
    await expect(link).toHaveAttribute("href", storyUrl);
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const popup = page.waitForEvent("popup");
    await link.click();
    const chart = await popup;
    await expect(chart).toHaveURL(storyUrl);
    await chart.close();
    await page.bringToFront();
    expect(externalRequests).toEqual([storyUrl]);
    await copyOriginal(page, preview, opening);

    await page
      .getByRole("button", { name: "Create from current content package" })
      .click();
    await expect(page).toHaveURL(/#\/world\//u);
    const story = page.getByRole("article", { name: "Story timeline" });
    const openingMessage = story.locator("li.narrator-message > article");
    await expectOpening(openingMessage);
    await copyOriginal(page, openingMessage, opening);

    await page.getByLabel("Your action", { exact: true }).fill(action);
    await page
      .getByRole("button", { name: "Send action from a fresh context" })
      .click();
    const latest = story.locator(".call-chain-assistant").last();
    await expect(
      latest.getByRole("heading", { name: "风暴继续" }),
    ).toBeVisible();
    continueStream.resolve();
    await expect(latest).toContainText(unclosed);
    await expect(latest).toHaveClass(/is-streaming/u);
    await expect(story.locator(".call-chain-player p")).toHaveText(action);
    expect(providerBody).toContain(
      JSON.stringify(opening.trimEnd()).slice(1, -1),
    );

    finish.resolve();
    await expect(latest).toHaveClass(/is-completed/u);
    await expect(
      latest.locator("strong").filter({ hasText: "窗户" }),
    ).toBeVisible();
    await expect(latest.locator("p br")).toHaveCount(1);
    await expect(latest.locator("pre code")).toHaveText(codeLine);
    await expect
      .poll(() =>
        latest.evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await copyOriginal(page, latest, reply);

    await page.reload();
    await expectOpening(openingMessage);
    await expect(
      latest.getByRole("heading", { name: "风暴继续" }),
    ).toBeVisible();
    await expect(latest.locator("pre code")).toHaveText(codeLine);
    await copyOriginal(page, latest, reply);
    expect(externalRequests).toEqual([storyUrl]);
  } finally {
    continueStream.resolve();
    finish.resolve();
  }
});

async function expectOpening(container: Locator): Promise<void> {
  await expect(
    container.getByRole("heading", { name: "雾港夜航" }),
  ).toBeVisible();
  await expect(container.locator("p br").first()).toHaveCount(1);
  await expect(container.locator("p strong")).toHaveText("a light");
  await expect(container.locator("p em")).toHaveText("a whisper");
  await expect(container.locator("ul li")).toHaveText(["拿起钥匙", "Listen"]);
  await expect(container.locator("blockquote")).toHaveText("保持安静。");
  await expect(container.getByText("海图", { exact: false })).toBeVisible();
  await expect(
    container.getByRole("link", { name: /Unsafe|Local/u }),
  ).toHaveCount(0);
}

async function copyOriginal(page: Page, container: Locator, source: string) {
  await container.getByRole("button", { name: "Copy original" }).click();
  await expect(
    container.getByRole("button", { name: "Original copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    source,
  );
}

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
