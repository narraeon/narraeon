import { expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({
  runtimeScope: "earlier-story-position",
  viewport: { width: 1440, height: 880 },
});

test("earlier story pages preserve the line being read, including a retry during generation", async ({
  page,
}) => {
  const nextChunk = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let replies = 0;
  const frame = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  await using provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const turn = ++replies;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (turn <= 42) {
        const story = Array.from(
          { length: 5 },
          (_, index) => `Harbor watch ${turn}, journal entry ${index + 1}.`,
        ).join("\n\n");
        response.end(frame(story) + "data: [DONE]\n\n");
        return;
      }
      response.write(frame("The next watch has begun."));
      void nextChunk.promise.then(() =>
        response.write(frame("\n\nThe watch continues.")),
      );
      void finish.promise.then(() => response.end("data: [DONE]\n\n"));
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture provider port missing");

  const releasePage = Promise.withResolvers<void>();
  try {
    await runtime(page, { type: "preferences.save", locale: "en" });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Earlier story fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "earlier-story",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const { localId: packageId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const { world } = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: crypto.randomUUID(),
      packageId,
    });
    const { worldId } = world;
    const chainId = crypto.randomUUID();
    for (let turn = 1; turn <= 42; turn++) {
      await runtime(page, {
        type: turn === 1 ? "play.chain.start" : "play.chain.append",
        worldId,
        chainId,
        exchangeId: crypto.randomUUID(),
        playerText: `I begin harbor watch ${turn}.`,
      });
    }

    let failRead = false;
    let holdRead = false;
    let reads = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = route.request().postDataJSON() as { request?: V1Request };
      if (input.request?.type !== "play.timeline.page") return route.continue();
      reads++;
      if (failRead) return route.abort("failed");
      if (holdRead) await releasePage.promise;
      return route.continue();
    });
    await page.goto(`/#/world/${worldId}`);
    const reader = page.getByLabel("World play", { exact: true });
    const earlier = page.getByRole("button", { name: "Load earlier story" });
    const watch = (turn: number) =>
      reader.getByText(`I begin harbor watch ${turn}.`, { exact: true });
    await expect(watch(23)).toBeAttached();
    await expect(watch(3)).toHaveCount(0);
    await earlier.evaluate((button) =>
      button.scrollIntoView({ block: "center" }),
    );
    const firstAnchor = await storyLine(page);
    await earlier.click();
    await expect(watch(3)).toBeAttached();
    await expectSameLine(page, firstAnchor);
    expect(reads).toBe(1);

    await page
      .getByLabel("Your action", { exact: true })
      .fill("Start a new watch.");
    await page
      .getByRole("button", { name: "Append action", exact: true })
      .click();
    await expect(reader.getByText("The next watch has begun.")).toBeAttached();
    const generating = page.getByRole("button", { name: "Cancel generation" });
    await expect(generating).toBeVisible();
    await earlier.evaluate((button) =>
      button.scrollIntoView({ block: "center" }),
    );
    failRead = true;
    await earlier.click({ timeout: 1_500 });
    const retry = reader.getByRole("button", { name: "Reload", exact: true });
    await expect(retry).toBeVisible();
    expect(reads).toBe(3);
    await expect(watch(1)).toHaveCount(0);

    failRead = false;
    holdRead = true;
    const beforeScroll = await storyLine(page);
    await retry.click();
    await expect.poll(() => reads).toBe(4);
    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 620);
    await expect
      .poll(async () => (await storyLine(page)).text)
      .not.toBe(beforeScroll.text);
    const retryAnchor = await storyLine(page);
    nextChunk.resolve();
    await expect(
      reader.getByText("The watch continues.", { exact: true }),
    ).toBeAttached();
    await expectSameLine(page, retryAnchor);

    releasePage.resolve();
    await expect(watch(1)).toBeAttached();
    await expect(earlier).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await expectSameLine(page, retryAnchor);
    await expect(generating).toBeVisible();

    await page.mouse.wheel(0, -20_000);
    await expect(watch(1)).toBeInViewport();
    const oldestAnchor = await storyLine(page);
    finish.resolve();
    await expect(generating).toHaveCount(0);
    await expectSameLine(page, oldestAnchor);
    expect(reads).toBe(4);
  } finally {
    releasePage.resolve();
    nextChunk.resolve();
    finish.resolve();
  }
});

interface StoryLine {
  text: string;
  top: number;
  visible: boolean;
}

async function storyLine(page: Page, text?: string): Promise<StoryLine> {
  const line = await page.evaluate((wanted) => {
    const header = document.querySelector(".world-floating-title")!;
    const composer = document.querySelector(".world-composer-dock")!;
    const clipTop = header.getBoundingClientRect().bottom;
    const clipBottom = composer.getBoundingClientRect().top;
    const paragraphs = document.querySelectorAll(
      ".call-chain-player article > p, .call-chain-assistant.is-narrative article p",
    );
    for (const paragraph of paragraphs) {
      const text = paragraph.textContent;
      const node = paragraph.firstChild;
      if (
        node?.nodeType !== Node.TEXT_NODE ||
        !text ||
        (wanted && text !== wanted)
      )
        continue;
      const character = document.createRange();
      character.setStart(node, 0);
      character.setEnd(node, 1);
      const { top, bottom, left } = character.getBoundingClientRect();
      const hit = document.elementFromPoint(left + 1, (top + bottom) / 2);
      const visible =
        top >= clipTop && bottom <= clipBottom && paragraph.contains(hit);
      if (wanted || visible) return { text, top, visible };
    }
    return null;
  }, text);
  expect(line, "a story line to track").not.toBeNull();
  return line!;
}

async function expectSameLine(page: Page, before: StoryLine): Promise<void> {
  const after = await storyLine(page, before.text);
  expect(Math.abs(after.top - before.top), before.text).toBeLessThanOrEqual(2);
  expect(after.visible, before.text).toBe(true);
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
