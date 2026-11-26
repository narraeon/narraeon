import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import type { V1OrchestrationOverview } from "../../src/protocol/orchestrationSession.ts";
import { test } from "../support/isolatedRuntimeTest.ts";
import { sillyTavernSnapshotFingerprint } from "../../src/runtime/play/SillyTavernSourceStore.ts";
import type { SillyTavernSource } from "../../src/shared/sillytavern-source.ts";

test.use({ runtimeScope: "orchestration-conversation" });

test("orchestration chat retains concurrent local edits and restores durable batches across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const seed = await library(page);
  const preset = seed.presets.find(({ id }) => id === seed.currentPresetId)!;
  let editingHeld = false;
  const releaseEditing = Promise.withResolvers<void>();
  const requests: Wire[] = [];
  const provider = await fixtureProvider(async (wire) => {
    requests.push(wire);
    const last = wire.messages.at(-1);
    if (last?.role === "tool") return { content: "已保存测试改动。" };
    if (JSON.stringify(last?.content)?.includes("请添加测试块")) {
      editingHeld = true;
      await releaseEditing.promise;
      return toolCall("edit-1", "orchestration_edit", {
        surface: "playPrompts",
        expectedRevision: preset.revision,
        operations: [
          {
            operationId: "create-1",
            op: "create",
            entryId: "browser-ai-fixture",
            kind: "user",
            name: "AI 测试块",
            body: "这段正文通过工具保存。",
            enabled: true,
            messageRole: "system",
          },
        ],
      });
    }
    return { content: "请在编排中调整文风，并检查未来游玩参考。" };
  });
  try {
    await configure(page, provider.url);
    const browserCommands: V1Request[] = [];
    let brokenSse = 0;
    await page.route("**/api/runtime/v1/events?*", async (route) => {
      if (brokenSse++ === 0) await route.abort("failed");
      else await route.continue();
    });
    await page.route("**/api/runtime/v1", async (route) => {
      const message = route.request().postDataJSON() as { request: V1Request };
      browserCommands.push(message.request);
      if (
        message.request.type === "orchestration.message" &&
        message.request.message === "普通咨询"
      ) {
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/#/orchestrations/${preset.id}`);
    await page.getByRole("button", { name: "AI 编辑", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "编排方案 AI 编辑",
      exact: true,
    });
    const message = panel.getByRole("textbox", { name: "给编排助手的消息" });
    const send = panel.getByRole("button", { name: "发送给编排助手" });

    await message.fill("普通咨询");
    await send.click();
    await expect(
      panel.getByText("请在编排中调整文风，并检查未来游玩参考。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(message).toHaveValue("");
    await expect(
      panel.getByText("此对话还没有草稿改动。", { exact: true }),
    ).toBeVisible();
    expect((await library(page)).presets[0]?.draft).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("未来游玩参考");

    const peer = await page.context().newPage();
    await peer.goto(`/#/orchestrations/${preset.id}`);
    await peer.getByRole("button", { name: "新增提示词", exact: true }).click();
    await peer
      .getByLabel("提示词正文", { exact: true })
      .fill("另一标签页的本地草稿");

    await message.fill("请添加测试块");
    await send.click();
    await expect.poll(() => editingHeld).toBe(true);
    await page.getByRole("button", { name: "新增提示词", exact: true }).click();
    await page
      .getByLabel("提示词正文", { exact: true })
      .fill("本地并发草稿必须保留");
    await message.fill("保存或放弃后继续发送的文字");
    releaseEditing.resolve();

    await expect(
      panel.getByText("已保存测试改动。", { exact: true }),
    ).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(page.getByLabel("提示词正文", { exact: true })).toHaveValue(
      "本地并发草稿必须保留",
    );
    await expect(
      panel.getByText("编排草稿已在别处更新。你的本地修改仍保留。", {
        exact: true,
      }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "保存本地修改" }).click();
    await expect(
      page.getByText("编排草稿已更新。请核对最新草稿后再试。", { exact: true }),
    ).toBeVisible();
    await expect(message).toHaveValue("保存或放弃后继续发送的文字");
    await panel.getByRole("button", { name: "放弃本地修改" }).click();
    await expect(send).toBeEnabled();
    await expect(message).toHaveValue("保存或放弃后继续发送的文字");
    await expect(
      page.getByRole("button", { name: /AI 测试块/u }),
    ).toBeVisible();

    await peer.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      peer.getByText("编排草稿已更新。请核对最新草稿后再试。", { exact: true }),
    ).toBeVisible();
    await expect(peer.getByLabel("提示词正文", { exact: true })).toHaveValue(
      "另一标签页的本地草稿",
    );
    await peer.close();

    const [drafted] = (await library(page)).presets;
    expect(drafted?.id).toBe(preset.id);
    expect(drafted?.revision).toBe(preset.revision);
    expect(drafted?.draft).toBeDefined();
    const edits = panel.getByRole("region", { name: "草稿改动", exact: true });
    await edits
      .locator("summary")
      .filter({ hasText: /^1 项编排改动$/u })
      .click();
    await edits
      .locator("summary")
      .filter({ hasText: /AI 测试块/u })
      .click();
    await expect(
      edits.getByText("这段正文通过工具保存。", { exact: true }),
    ).toBeVisible();
    await expect(edits.getByText("发送角色", { exact: true })).toBeVisible();

    // A forced SSE disconnect and lost request receipt must not duplicate the first send.
    expect(
      browserCommands.filter(({ type }) => type === "orchestration.message"),
    ).toHaveLength(2);
    expect(
      browserCommands.filter(
        ({ type }) => type.startsWith("content.") || type.startsWith("world."),
      ),
    ).toEqual([]);
    expect(
      browserCommands.every(
        (item) =>
          item.type !== "workspace.read" || item.scope === "orchestration",
      ),
    ).toBe(true);
    await page
      .locator("summary")
      .filter({ hasText: /^编排方案操作$/u })
      .click();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出已保存草稿", exact: true })
      .click();
    expect(await readFile(await (await downloaded).path(), "utf8")).toContain(
      "browser-ai-fixture",
    );
    await page
      .getByRole("button", { name: "从已保存草稿复制", exact: true })
      .click();
    await expect
      .poll(async () => (await library(page)).presets.length)
      .toBeGreaterThan(1);
    const copied = (await library(page)).presets.find(
      ({ id }) => id !== preset.id,
    )!;
    expect(
      copied.structure?.playPrompts?.some(
        ({ id }) => id === "browser-ai-fixture",
      ),
    ).toBe(true);
    expect((await library(page)).currentPresetId).toBe(preset.id);
    await page
      .getByRole("combobox", { name: "切换编排方案" })
      .selectOption(preset.id);

    await page.reload();
    await expect(
      panel.getByText("已保存测试改动。", { exact: true }),
    ).toBeVisible();
    await expect(message).toHaveValue("保存或放弃后继续发送的文字");
    await edits
      .locator("summary")
      .filter({ hasText: /^1 项编排改动$/u })
      .click();
    await edits.getByRole("button", { name: "撤销此批改动" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "撤销此批改动" })
      .click();
    await expect(edits.getByText("已撤销", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /AI 测试块/u })).toHaveCount(
      0,
    );
    expect((await library(page)).presets[0]?.draft).toBeUndefined();

    await page.getByRole("button", { name: "新增提示词", exact: true }).click();
    await page.getByLabel("提示词正文", { exact: true }).fill("放弃的持久草稿");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "放弃已保存草稿", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "放弃已保存草稿", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "放弃已保存草稿", exact: true }),
    ).toHaveCount(0);
    expect(
      (await library(page)).presets.find(({ id }) => id === preset.id),
    ).toMatchObject({ revision: preset.revision });
  } finally {
    releaseEditing.resolve();
    await provider.close();
  }
});

test("AI editing switches to the author surface on mobile and opens saved request details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runtime(page, { type: "preferences.save", locale: "en" });
  const sent: Wire[] = [];
  const provider = await fixtureProvider((wire) => {
    sent.push(wire);
    return { content: "Inspect both surfaces before changing prose style." };
  });
  try {
    await configure(page, provider.url);
    const { preset } = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: "Isolated author surface",
    });
    const currentPresetId = preset.id;
    await page.goto(`/#/orchestrations/${currentPresetId}`);
    await page.getByRole("tab", { name: /Setting improvement/ }).click();
    await page.getByRole("button", { name: "AI editing", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "AI orchestration editing",
      exact: true,
    });
    await expect(panel.getByText(/Setting improvement/)).toBeVisible();
    const composer = panel.getByRole("textbox", {
      name: "Message to the orchestration assistant",
    });
    await composer.fill("Where does style belong?");
    await panel
      .getByRole("button", { name: "Send to the orchestration assistant" })
      .click();
    await expect(
      panel.getByText("Inspect both surfaces before changing prose style.", {
        exact: true,
      }),
    ).toBeVisible();
    const { latest } = await runtime<V1OrchestrationOverview>(page, {
      type: "orchestration.overview",
      presetId: currentPresetId,
    });
    expect(latest?.requestPreviews).toHaveLength(1);
    expect(
      sent[0]?.messages.some(
        ({ content }) =>
          typeof content === "string" &&
          content.includes('"surface":"authorPrompts"'),
      ),
    ).toBe(true);
    await panel
      .locator("summary")
      .filter({ hasText: /Call details|Model calls/i })
      .first()
      .click();
    await panel
      .locator("summary")
      .filter({ hasText: /^Context for this call$/i })
      .click();
    await expect(panel.getByText(/Historical logical context/i)).toBeVisible();

    const preview = await runtime(page, {
      type: "orchestration.request.preview",
      presetId: currentPresetId,
      sessionId: latest!.sessionId,
      requestId: latest!.requestPreviews![0]!.requestId,
    });
    expect(preview).toMatchObject({
      compilation: { provider: { protocol: "chat_completions" } },
    });
    const display = page.getByRole("navigation", {
      name: "Orchestration editing views",
    });
    await display.getByRole("button", { name: "Changes" }).click();
    await expect(
      panel.getByText("This conversation has no draft changes yet."),
    ).toBeVisible();
    await display.getByRole("button", { name: "Orchestration" }).click();
    await expect(
      page.getByRole("button", { name: "Add prompt", exact: true }),
    ).toBeVisible();
  } finally {
    await provider.close();
  }
});

test("the 64-step pause resumes and a cancelled dispatch can replay the frozen request", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await runtime(page, { type: "preferences.save", locale: "en" });
  let calls = 0;
  const cancelledRequests: string[] = [];
  const release = Promise.withResolvers<void>();
  const provider = await fixtureProvider(async (wire, raw) => {
    const user = JSON.stringify(
      wire.messages.findLast(({ role }) => role === "user")?.content,
    );
    if (user?.includes("Pause at the runtime limit")) {
      calls++;
      if (calls <= 64)
        return toolCall(`info-${calls}`, "orchestration_list", {
          surface: "playPrompts",
        });
      return { content: "The paused edit resumed." };
    }
    cancelledRequests.push(raw);
    if (cancelledRequests.length === 1) await release.promise;
    return { content: "The frozen request was replayed." };
  });
  try {
    await configure(page, provider.url);
    const { preset } = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: "Recovery cases",
    });
    await page.goto(`/#/orchestrations/${preset.id}`);
    await page.getByRole("button", { name: "AI editing", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "AI orchestration editing",
      exact: true,
    });
    const message = panel.getByRole("textbox", {
      name: "Message to the orchestration assistant",
    });
    const send = panel.getByRole("button", {
      name: "Send to the orchestration assistant",
    });
    await message.fill("Pause at the runtime limit");
    await send.click();
    const resume = panel.getByRole("button", {
      name: "Continue this edit",
      exact: true,
    });
    await expect(resume).toBeEnabled({ timeout: 30_000 });
    expect(calls).toBe(64);
    await resume.click();
    await expect(
      panel.getByText("The paused edit resumed.", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(65);

    await panel
      .getByRole("button", { name: "Start a new conversation", exact: true })
      .click();
    await message.fill("Cancel and replay this frozen request");
    await send.click();
    await expect.poll(() => cancelledRequests.length).toBe(1);
    await panel
      .getByRole("button", { name: "Cancel generation", exact: true })
      .click();
    const retry = panel.getByRole("button", {
      name: "Retry original request",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    release.resolve();
    await retry.click();
    await expect(
      panel.getByText("The frozen request was replayed.", { exact: true }),
    ).toBeVisible();
    expect(cancelledRequests).toHaveLength(2);
    expect(cancelledRequests[1]).toBe(cancelledRequests[0]);
  } finally {
    release.resolve();
    await provider.close();
  }
});

test("source conditions appear in the AI batch and on the exact saved prompt revision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await runtime(page, { type: "preferences.save", locale: "en" });
  const source = await readFile(
    new URL("../fixtures/sillytavern-complex-374.json", import.meta.url),
    "utf8",
  );
  const { preset } = await runtime<{
    preset: { id: string; revision: string };
  }>(page, {
    type: "play.sillytavern.import",
    source,
    name: "Provenance browser test",
    selected: ["schedule"],
    operationId: "provenance-browser-test",
  });
  const snapshot = await runtime<SillyTavernSource>(page, {
    type: "play.sillytavern.source.read",
    presetId: preset.id,
  });
  if (snapshot.kind !== "snapshot")
    throw new Error("No imported source snapshot");
  const snapshotId = sillyTavernSnapshotFingerprint(snapshot.snapshot);
  const end = snapshot.snapshot.entries.find(({ id }) => id === "schedule")!
    .content!.length;
  let calls = 0;
  const provider = await fixtureProvider(() => {
    calls++;
    if (calls === 1)
      return toolCall("read-source", "sillytavern_source_read", {
        snapshotId,
        entryId: "schedule",
      });
    if (calls === 2)
      return toolCall("extract-source", "orchestration_edit", {
        surface: "playPrompts",
        expectedRevision: preset.revision,
        operations: [
          {
            operationId: "create-cited-review",
            op: "create",
            entryId: "cited-review",
            kind: "user",
            name: "Cited review guidance",
            body: "Review clue clarity.",
            enabled: false,
            provenance: {
              snapshotId,
              fragments: [{ entryId: "schedule", offset: 0, end }],
              rationale: "Extract the standalone intent for author review.",
              droppedConditions: [
                "Every three turns",
                "Conditional mood",
                "History depth 4",
              ],
            },
          },
        ],
      });
    return { content: "The cited block is ready for review." };
  });
  try {
    await configure(page, provider.url);
    await page.goto(`/#/orchestrations/${preset.id}`);
    await page.getByRole("button", { name: "AI editing", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "AI orchestration editing",
      exact: true,
    });
    await panel
      .getByRole("textbox", { name: "Message to the orchestration assistant" })
      .fill(
        "Extract the source condition as a disabled choice for author review.",
      );
    await panel
      .getByRole("button", { name: "Send to the orchestration assistant" })
      .click();
    await expect(
      panel.getByText("The cited block is ready for review.", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(3);
    const changes = panel.getByRole("region", {
      name: "Draft changes",
      exact: true,
    });
    await changes
      .locator("summary")
      .filter({ hasText: /^1 orchestration changes$/u })
      .click();
    await changes
      .locator("summary")
      .filter({ hasText: /Cited review guidance/u })
      .click();
    await changes.locator(".orchestration-provenance > summary").click();
    await expect(
      changes.getByText("Every three turns", { exact: true }),
    ).toBeVisible();
    await expect(changes.getByText(snapshotId, { exact: true })).toBeVisible();

    const workspace = page.getByRole("tabpanel", { name: "Play", exact: true });
    await workspace
      .getByRole("button", { name: /Cited review guidance/u })
      .click();
    const sourceDetails = workspace.locator(".orchestration-provenance");
    await sourceDetails.locator("summary").click();
    await expect(
      sourceDetails.getByText("Every three turns", { exact: true }),
    ).toBeVisible();
    await workspace
      .getByRole("textbox", { name: "Prompt text", exact: true })
      .fill("Review clue clarity and consistency.");
    await page
      .getByRole("button", { name: "Save local changes", exact: true })
      .click();
    await expect(sourceDetails.locator("summary")).toContainText(
      /Manually edited after extraction/i,
    );
  } finally {
    await provider.close();
  }
});

interface Wire {
  messages: { role: string; content?: unknown }[];
}

function toolCall(id: string, name: string, args: object) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function fixtureProvider(
  reply: (wire: Wire, raw: string) => object | Promise<object>,
) {
  const server = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const delta = await reply(JSON.parse(body) as Wire, body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => {
      response.writeHead(500);
      response.end("Fixture provider failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture port unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function configure(page: Page, url: string): Promise<void> {
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Orchestration browser fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: url,
      apiKey: "fixture",
      modelId: "orchestration-browser",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
}

function library(page: Page) {
  return runtime<FileNativePlayPresetLibrary>(page, { type: "play.read" });
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
