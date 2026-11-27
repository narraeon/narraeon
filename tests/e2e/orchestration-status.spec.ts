import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "orchestration-status" });

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

test("clean current orchestration leaves room for both prompt editors", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/#/orchestrations");
    for (const name of ["Play", "Setting improvement"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      const panel = page.getByRole("tabpanel", { name, exact: true });
      const prompt = panel.getByLabel("Prompt text", { exact: true });
      const status = page.locator(".play-preset-editor-actions details");
      const summary = status.locator("summary");
      await expect(summary).toHaveText("Orchestration validated");
      await expect(status).not.toHaveAttribute("open", "");
      await expect
        .poll(async () => (await status.boundingBox())?.height)
        .toBeLessThan(46);
      await expect(prompt).toBeInViewport({ ratio: 0.15 });
      const visiblePromptHeight = await prompt.evaluate((element) => {
        const body = element.getBoundingClientRect();
        const footer = document.querySelector(".play-preset-editor-actions")!;
        return footer.getBoundingClientRect().top - body.top;
      });
      expect(visiblePromptHeight).toBeGreaterThan(44);
      await expect(
        page.getByRole("button", { name: "Save changes" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Use as current orchestration" }),
      ).toHaveCount(0);
      await summary.press("Enter");
      await expect(status).toHaveAttribute("open", "");
      await expect(status).toContainText(
        "The next normal send uses this orchestration’s applied revision.",
      );
      await summary.press("Enter");
      await expect(status).not.toHaveAttribute("open", "");
      await expect(summary).toBeFocused();
    }
  }
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`next play send uses the applied orchestration revision (${locale})`, async ({
    page,
  }) => {
    const cn = locale === "zh-CN";
    const requests: string[] = [];
    const provider = createServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            choices: [
              { delta: { content: `Orchestration reply ${requests.length}` } },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    try {
      await runtime(page, { type: "preferences.save", locale });
      const model = {
        provider: "chat_completions" as const,
        modelId: "orchestration-status",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      };
      await runtime(page, {
        type: "model.save",
        connection: {
          ...model,
          name: "Status fixture",
          presetId: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
        },
      });
      const { localId: packageId } = await runtime<{ localId: string }>(page, {
        type: "content.create",
      });
      const {
        world: { worldId },
      } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId,
        model,
      });
      const create = (name: string) =>
        runtime<{ preset: { id: string } }>(page, {
          type: "play.create",
          name,
        });
      const { preset: a } = await create("Preset A");
      const { preset: b } = await create("Preset B");
      await runtime(page, { type: "play.select", presetId: a.id });

      const open = (id: string) => page.goto(`/#/orchestrations/${id}`);
      const editor = page.getByRole("region", {
        name: cn ? "编排方案编辑器" : "Orchestration editor",
      });
      const inactiveHint = cn
        ? "应用为当前编排方案后，下一次正常发送才会使用它。"
        : "Apply this orchestration to use it on the next normal send.";
      const activeHint = cn
        ? "下一次正常发送将使用此编排方案的已应用修订。"
        : "The next normal send uses this orchestration’s applied revision.";
      const savedDraftHint = cn
        ? "下一次正常发送仍使用已应用的修订。请应用已保存的草稿以使其生效。"
        : "The next normal send still uses the applied revision. Apply the saved draft to use it.";
      const save = editor.getByRole("button", {
        name: cn ? "保存修改" : "Save changes",
        exact: true,
      });
      const apply = editor.getByRole("button", {
        name: cn ? "应用为当前编排方案" : "Use as current orchestration",
        exact: true,
      });
      const expectApplied = async () => {
        const status = editor.locator(".play-preset-editor-actions details");
        const summary = status.locator("summary");
        await expect(summary).toBeFocused();
        await summary.press("Enter");
        await expect(
          status.getByText(activeHint, { exact: true }),
        ).toBeVisible();
      };
      const addPrompt = async (body: string) => {
        await editor
          .getByRole("button", {
            name: cn ? "新增提示词" : "Add prompt",
            exact: true,
          })
          .click();
        await editor
          .getByRole("textbox", {
            name: cn ? "提示词正文" : "Prompt text",
            exact: true,
          })
          .fill(body);
        await save.click();
        await expect(save).toBeDisabled();
        await expect(apply).toBeEnabled();
      };
      const send = async (turn: number) => {
        await page.goto(`/#/world/${worldId}`);
        const input = page.getByRole("textbox", {
          name: cn ? "你的行动" : "Your action",
          exact: true,
        });
        await input.fill(`Orchestration status turn ${turn}`);
        await page.getByLabel(cn ? "更多" : "More", { exact: true }).click();
        await page
          .getByRole("button", {
            name: cn
              ? "用新对话继续（保留故事进度）"
              : "Continue in a new chat (keep story progress)",
            exact: true,
          })
          .click();
        await expect(
          page.getByText(`Orchestration reply ${turn}`, { exact: true }),
        ).toBeVisible();
        await expect(input).toBeEnabled();
        return requests[turn - 1];
      };

      await open(a.id);
      const aPrompt = "A applied revision marker.";
      await addPrompt(aPrompt);
      await apply.press("Enter");
      await expectApplied();

      await open(b.id);
      await expect(
        editor.getByText(inactiveHint, { exact: true }),
      ).toBeVisible();
      const appliedPrompt = "B applied revision marker.";
      await addPrompt(appliedPrompt);
      await expect(
        editor.getByText(inactiveHint, { exact: true }),
      ).toBeVisible();
      const aRequest = await send(1);
      expect(aRequest).toContain(aPrompt);
      expect(aRequest).not.toContain(appliedPrompt);

      await open(b.id);
      await apply.press("Enter");
      await expectApplied();
      const bRequest = await send(2);
      expect(bRequest).toContain(appliedPrompt);
      expect(bRequest).not.toContain(aPrompt);

      await open(b.id);
      const draftPrompt = "B newer revision marker.";
      await addPrompt(draftPrompt);
      await expect(
        editor.getByText(savedDraftHint, { exact: true }),
      ).toBeVisible();
      const previousRevision = await send(3);
      expect(previousRevision).toContain(appliedPrompt);
      expect(previousRevision).not.toContain(draftPrompt);

      await open(b.id);
      await apply.press("Enter");
      await expectApplied();
      expect(await send(4)).toContain(draftPrompt);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
}
