import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import { defaultAppReadingPreferences } from "../../src/protocol/appPreferences.ts";
import type {
  V1PlayCallChainView,
  V1PlayContextReadingView,
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "next-play-preview" });

for (const locale of ["zh-CN", "en"] as const) {
  test(`${locale}: next play preview distinguishes a fork's conversation from a fresh context after revision`, async ({
    page,
  }) => {
    const t = (zh: string, en: string) => (locale === "en" ? en : zh);
    const originalAction = "I place the numbered lantern beside the door.";
    const appendedAction = "I take a closer look at the lantern.";
    const revisionText = "The lantern now stands on a bronze tray.";
    const requests: string[] = [];
    const replyText = (index: number) =>
      `Fixture reply about lantern ${index}.`;
    const provider = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.once("end", () => {
        requests.push(body);
        const delta = { content: replyText(requests.length) };
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
          );
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = provider.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing local fixture port");
      await runtime(page, {
        type: "preferences.save",
        locale,
        reading: { ...defaultAppReadingPreferences, showTechnicalInfo: true },
      });
      await runtime(page, {
        type: "model.save",
        connection: {
          name: "Lantern fixture",
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture-secret",
          modelId: "lantern-fixture",
          contextWindowTokens: 64_000,
          maxOutputTokens: 4_096,
        },
      });
      const pack = await runtime<{ localId: string }>(page, {
        type: "content.create-sample",
        locale,
      });
      const { world } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId: pack.localId,
      });
      const first = await runtime<V1PlayCallChainView>(page, {
        type: "play.chain.start",
        worldId: world.worldId,
        chainId: crypto.randomUUID(),
        exchangeId: crypto.randomUUID(),
        playerText: originalAction,
      });
      const fork = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.derive",
        operationId: crypto.randomUUID(),
        sourceWorldId: world.worldId,
        sourceHead: first.parentHead,
      });
      const { worldId } = fork.world;
      expect(requests).toHaveLength(1);

      const historicalReads: V1Request[] = [];
      page.on("request", (request) => {
        if (
          !request.url().endsWith("/api/runtime/v1") ||
          request.method() !== "POST"
        )
          return;
        const payload = request.postDataJSON() as { request: V1Request };
        if (payload.request.type === "play.timeline.context")
          historicalReads.push(payload.request);
      });
      const openPreview = async () => {
        await page.goto(`/#/world/${worldId}`);
        await page
          .getByRole("button", {
            name: t("AI 读取", "Model reads"),
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name: t("展开完整读取记录", "Open the complete read record"),
          })
          .click();
        const dialog = page.getByRole("dialog", {
          name: t("AI 如何读取", "How the model reads"),
        });
        const section = dialog.locator("details.ai-reading-raw").last();
        await section.locator("summary").click();
        return section;
      };
      const readPreview = () =>
        runtime<V1PlayContextReadingView>(page, {
          type: "world.play-context.read",
          worldId,
        });
      const append = await readPreview();
      expect(append.nextFreshContext).toMatchObject({
        contextMode: "append",
        head: append.worldHead,
        previewScope: "compiled_materials",
      });
      expect(append.currentContext?.stale).toBe(false);
      expect(JSON.stringify(append)).not.toContain(originalAction);
      expect(JSON.stringify(append)).not.toContain(replyText(1));

      const appendPreview = await openPreview();
      await expect(appendPreview.locator("summary")).toHaveText(
        t(
          "查看下次编译材料：沿用现有对话",
          "View next compiled materials: continue the current conversation",
        ),
      );
      await expect(appendPreview.locator("p").first()).toContainText(
        t(
          "已有对话会在发送时沿用，包括先前的消息和工具往返。",
          "The send carries forward the existing conversation, including earlier messages and tool exchanges.",
        ),
      );
      await expect(appendPreview).not.toContainText(originalAction);
      await expect(appendPreview).not.toContainText(replyText(1));
      const dispatchGuide = appendPreview.locator(":scope > p").last();
      for (const label of [
        t("阅读设置", "Reading settings"),
        t("显示技术信息", "Show technical information"),
        t("本段调用详情", "Call details"),
        t("本次上下文", "Context for this call"),
      ])
        await expect(dispatchGuide).toContainText(label);
      expect(requests).toHaveLength(1);
      expect(historicalReads).toHaveLength(0);

      const second = await runtime<V1PlayCallChainView>(page, {
        type: "play.chain.append",
        worldId,
        chainId: append.currentContext!.chainId,
        exchangeId: crypto.randomUUID(),
        playerText: appendedAction,
      });
      expect(second.status).toBe("ready");
      expect(requests).toHaveLength(2);
      expect(requests[1]!.split(originalAction)).toHaveLength(2);
      expect(requests[1]!.split(replyText(1))).toHaveLength(2);
      await page.reload();
      const timeline = page.getByLabel(t("故事时间线", "Story timeline"));
      await expect(
        timeline.getByText(replyText(2), { exact: true }),
      ).toBeVisible();
      await timeline
        .locator(".model-call-details > summary")
        .filter({ hasText: t("本段调用详情", "Call details") })
        .last()
        .click();
      expect(historicalReads).toHaveLength(0);
      const call = timeline
        .locator("summary")
        .filter({
          hasText: new RegExp(
            `^${t("本次上下文", "Context for this call")}$`,
            "u",
          ),
        })
        .last();
      await call.click();
      await expect(call.locator("..")).toContainText(originalAction);
      expect(historicalReads).toHaveLength(1);
      expect(requests).toHaveLength(2);

      const opened = await runtime<V1WorldRevisionOverview>(page, {
        type: "world.revision.open",
        worldId,
      });
      const epoch = opened.epoch!;
      const worldRules = "control/blocks/world.md";
      expect(epoch.files.some(({ path }) => path === worldRules)).toBe(true);
      const edited = await runtime<V1WorldRevisionOverview>(page, {
        type: "world.revision.files.replace",
        worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
        files: epoch.files.map((file) =>
          file.path === worldRules
            ? { ...file, contents: `${file.contents}\n${revisionText}\n` }
            : file,
        ),
      });
      await runtime(page, {
        type: "world.revision.apply",
        worldId,
        epochId: epoch.epochId,
        expectedRevision: edited.epoch!.revision,
      });
      const fresh = await readPreview();
      expect(fresh.nextFreshContext).toMatchObject({
        contextMode: "fresh",
        head: fresh.worldHead,
        previewScope: "compiled_materials",
      });
      for (const original of [
        originalAction,
        replyText(1),
        appendedAction,
        replyText(2),
      ]) {
        expect(compiledText(fresh).split(original)).toHaveLength(2);
      }
      const freshPreview = await openPreview();
      await expect(freshPreview.locator("summary")).toHaveText(
        t(
          "查看下次编译材料：全新上下文",
          "View next compiled materials: fresh context",
        ),
      );
      await expect(freshPreview.locator("p").first()).toContainText(
        t("适用的已提交故事原文", "applicable committed story text"),
      );
      await expect(freshPreview).toContainText(originalAction);
      await expect(freshPreview).toContainText(appendedAction);
      await expect(freshPreview).toContainText(revisionText);
      expect(requests).toHaveLength(2);
      expect(historicalReads).toHaveLength(1);

      await runtime<V1PlayCallChainView>(page, {
        type: "play.chain.start",
        worldId,
        chainId: crypto.randomUUID(),
        exchangeId: crypto.randomUUID(),
        playerText: "I turn toward the window.",
      });
      expect(requests).toHaveLength(3);
      for (const original of [
        originalAction,
        replyText(1),
        appendedAction,
        replyText(2),
      ]) {
        expect(requests[2]!.split(original)).toHaveLength(2);
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
}

function compiledText(reading: V1PlayContextReadingView): string {
  return (
    reading.nextFreshContext?.preview.compilation.logicalMessages.map(
      ({ markdown }) => markdown,
    ) ?? []
  ).join("\n");
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
