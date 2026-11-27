import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AuthoringConversationView } from "../../src/web/AuthoringTarget.ts";
import type {
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "authoring-sync" });
type Kind = "setting" | "revision";
let provider: Server;
let providerUrl = "";
let providerCalls = 0;
let rejectModel = false;
let toolBatches: { name: string; arguments: object }[][] = [];

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      providerCalls++;
      if (rejectModel) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Fixture rate limit",
              code: "rate_limit_exceeded",
            },
          }),
        );
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const tools = toolBatches.shift();
        if (tools !== undefined) {
          const toolCalls = tools.map((tool, index) => ({
            index,
            id: `authoring-tool-${providerCalls}-${index}`,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          }));
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
              "data: [DONE]\n\n",
          );
          return;
        }
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "The authoring reply is visible." } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing Provider port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(async ({ page }) => {
  providerCalls = 0;
  rejectModel = false;
  toolBatches = [];
  await page.addInitScript(() => {
    const sources: EventSource[] = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        sources.push(this);
      }
    };
    const authoringSources = () =>
      sources.filter(
        (source) =>
          /kind=(setting|revision)/u.test(source.url) &&
          source.readyState !== EventSource.CLOSED,
      );
    Object.assign(window, {
      authoringObservationReady: () =>
        authoringSources().some(
          (source) => source.readyState === EventSource.OPEN,
        ),
      silenceAuthoringObservation: () =>
        authoringSources().forEach((source) => source.close()),
      interruptAuthoringObservation: (terminal: boolean) =>
        authoringSources().forEach((source) => {
          if (terminal) source.close();
          for (let index = 0; index < 3; index++)
            source.dispatchEvent(new Event("error"));
        }),
    });
  });
});

for (const kind of ["setting", "revision"] as const) {
  test(`${kind} keeps the workbench header above the scrolling conversation`, async ({
    page,
  }) => {
    await prepare(page, kind);
    const title = page.getByRole("heading", { level: 1 });
    const scroll = page.locator(".setting-reader-scroll");
    const intro = scroll.locator(".setting-conversation-intro");
    for (const width of [980, 656, 400]) {
      await page.setViewportSize({ width, height: 420 });
      await scroll.evaluate((element) => (element.scrollTop = 0));
      await expect(title).toBeVisible();
      const titleBox = (await title.boundingBox())!;
      const introBox = (await intro.boundingBox())!;
      expect(introBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      await scroll.evaluate((element) => (element.scrollTop = 22));
      expect(await scroll.evaluate((element) => element.scrollTop)).toBe(22);
      expect((await scroll.boundingBox())!.y).toBeGreaterThanOrEqual(
        titleBox.y + titleBox.height,
      );
      expect((await title.boundingBox())!.y).toBe(titleBox.y);
    }
  });

  test(`${kind} patches one Markdown section and restores its exact before-image`, async ({
    page,
  }) => {
    const relativePath = "rules/section-rules.md";
    const path = `${kind === "setting" ? "world" : "state"}/${relativePath}`;
    const oldBody = "The harbor bell sounds at dusk.";
    const newBody =
      "The harbor bell sounds at dawn. " +
      "The watch records each passing vessel in the harbor log. "
        .repeat(7)
        .trimEnd();
    const longBody = Array.from(
      { length: 240 },
      (_, index) => `Archive entry ${index + 1} stays exactly as written.`,
    ).join("\n\n");
    const source = `---\n$document:\n  id: doc.section-rules\n  ref: section-rules\n  title: Harbor rules\n  summary: Exact sections of a long text.\n  aliases: [Bell rules]\n---\n\n# Harbor rules\n\nPreamble stays.\n\n## Harbor\n\n### Watch\n\n${oldBody}\n\n## Market\n\n### Watch\n\nThe market watch stays.\n\n## Archive\n\n${longBody}  \n\n`;
    const target = await prepare(page, kind, true, "zh-CN", {
      path: `world/${relativePath}`,
      contents: source,
    });
    const prefix = kind === "setting" ? "setting" : "world_revision";
    const patch = (args: {
      op: string;
      locator: string[];
      markdown?: string;
      title?: string;
    }) => ({
      name: `${prefix}_patch`,
      arguments: { document: "@section-rules", ...args },
    });
    const exact = patch({
      op: "replace_section",
      locator: ["Harbor", "Watch"],
      markdown: `### Watch\n\n${newBody}`,
    });
    const read = { name: `${prefix}_read`, arguments: { path } };
    const draftPath = "control/blocks/world.md";
    const initialFiles =
      kind === "setting"
        ? await target.files()
        : await runtime<{ path: string; contents: string }[]>(page, {
            type: "world.surface.read",
            worldId: target.id,
            surface: "revision",
          });
    const originalControl = initialFiles.find(
      (file) => file.path === draftPath,
    )!.contents;
    const updatedControl = `${originalControl}\n\nThe harbor archives record watches.\n`;
    const after = source.replace(oldBody, newBody);
    const readCommitted = async () =>
      (
        await runtime<{ path: string; contents: string }[]>(page, {
          type: "world.surface.read",
          worldId: target.id,
          surface: "state",
        })
      ).find((file) => file.path === relativePath)?.contents;
    toolBatches.push([
      exact,
      read,
      patch({
        op: "add_section",
        locator: ["Harbor"],
        markdown: "### Watch\n\nThis would duplicate the existing heading.",
      }),
      exact,
      { name: `${prefix}_read`, arguments: { path: draftPath } },
      {
        name: `${prefix}_write_file`,
        arguments: { path: draftPath, contents: updatedControl },
      },
    ]);
    const requestText = "Change just the harbor watch rule.";
    const view = await sendFreshConversation(page, target.prefix, requestText);
    const calls = view.turns[0]!.exchanges[0]!.toolCalls;
    expect(calls[3]?.result, calls[3]?.result?.markdown).toMatchObject({
      isError: false,
      changes: [{ path, before: source, after }],
    });
    expect(calls[0]?.result?.markdown).toContain("必须完整读取");
    expect(calls[2]?.result?.markdown).toContain("locator_ambiguous");
    expect(calls[2]?.result?.markdown).toContain("Harbor > Watch");
    expect(calls[2]?.result?.markdown).toContain("唯一");
    expect(calls[2]?.result?.changes).toEqual([]);
    expect(calls[5]?.result, calls[5]?.result?.markdown).toMatchObject({
      isError: false,
      changes: [
        { path: draftPath, before: originalControl, after: updatedControl },
      ],
    });
    expect(
      (await target.files()).find((file) => file.path === path)?.contents,
    ).toBe(after);
    if (kind === "revision") expect(await readCommitted()).toBe(source);

    await page.reload();
    if (kind === "revision") await target.open();
    await expect(userText(page, requestText)).toBeVisible();
    const turn = page
      .locator(".setting-conversation-turn")
      .filter({ hasText: requestText });
    const turnChanges = turn.getByRole("region", { name: "本轮已改文件" });
    const fileChanges = turnChanges.locator(".setting-change-diff");
    await expect(fileChanges).toHaveCount(2);
    const turnDiff = fileChanges.filter({ hasText: path });
    const otherDiff = fileChanges.filter({ hasText: draftPath });
    await expect(turnDiff).toContainText(
      kind === "setting" ? "内容包当前树" : "修订工作树",
    );
    await expect(otherDiff).toContainText(
      kind === "setting" ? "内容包当前树" : "修订工作树",
    );
    await turnDiff.locator("summary").click();
    await page.setViewportSize({ width: 400, height: 650 });
    const diffTable = turnDiff.getByRole("table");
    await expect(diffTable).toBeVisible();
    const longLine = diffTable
      .locator(".unified-diff-add")
      .filter({ hasText: newBody });
    await expect(
      longLine.getByRole("cell", { name: /新文件第/u }),
    ).toBeVisible();
    const sizes = await diffTable.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.width + 1);
    const lineSizes = await longLine.evaluate((line) => ({
      height: line.getBoundingClientRect().height,
      textLineHeight: parseFloat(
        getComputedStyle(line.querySelector("code")!).lineHeight,
      ),
    }));
    expect(lineSizes.height).toBeGreaterThan(lineSizes.textLineHeight * 2);
    await page.setViewportSize({ width: 1280, height: 720 });
    const accepted = page.locator(".setting-exchange-tool.is-ok").filter({
      hasText: `${prefix}_patch`,
    });
    const diff = accepted.locator(".setting-change-diff");
    const revealDiff = async () => {
      await openDetails(page.locator(".model-call-details > summary"));
      await openDetails(accepted.locator("xpath=ancestor::details[1]/summary"));
      await openDetails(accepted.locator(":scope > summary"));
      await openDetails(diff.locator(":scope > summary"));
    };
    await revealDiff();
    await expect(diff.locator(".unified-diff-add")).toContainText(newBody);
    await expect(diff.locator(".unified-diff-remove")).toContainText(oldBody);
    const editor = await openEditor(page, kind);
    const draft = `${await editor.inputValue()}\nKeep this editor draft.\n`;
    await editor.fill(draft);
    await page
      .getByRole("button", { name: "收起文件面板", exact: true })
      .click();
    const rollback = diff.getByRole("button", { name: "回滚这个文件" });
    await expect(rollback).toBeDisabled();
    await expect(await openEditor(page, kind)).toHaveValue(draft);
    await page
      .getByRole("button", { name: "收起文件面板", exact: true })
      .click();
    await fileDraftActions(page, kind).save.click();
    await expect(page.locator(".setting-workspace-feedback")).toContainText(
      kind === "setting"
        ? "内容包当前树已整批保存"
        : "手动修改已保存到修订工作树",
    );
    await revealDiff();
    await expect(rollback).toBeEnabled();
    await expect(otherDiff).toContainText("历史改动");
    await openDetails(turnDiff.locator(":scope > summary"));
    const providerRequestsBeforeRollback = providerCalls;
    let rollbackRequests = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type === `${target.prefix}.rollback`)
        rollbackRequests++;
      await route.continue();
    });
    await turnDiff.getByRole("button", { name: "回滚这个文件" }).click();
    await expect(accepted).toContainText("当前文件已是修改前版本");
    await expect(turnDiff).toContainText("当前文件已是修改前版本");
    expect(providerCalls).toBe(providerRequestsBeforeRollback);
    expect(rollbackRequests).toBe(1);
    await page.reload();
    if (kind === "revision") await target.open();
    await expect(userText(page, requestText)).toBeVisible();
    expect(
      (await target.files()).find((file) => file.path === path)?.contents,
    ).toBe(source);
    expect(
      (await target.files()).find((file) => file.path === draftPath)?.contents,
    ).toBe(draft);

    toolBatches.push([
      exact,
      read,
      patch({
        op: "add_section",
        locator: [],
        markdown: "## Pier\n\nPier access changes daily.",
      }),
      patch({ op: "rename_section", locator: ["Pier"], title: "Dock" }),
      patch({ op: "remove_section", locator: ["Market", "Watch"] }),
      exact,
    ]);
    const followUp = "Update the harbor and dock.";
    const updated = await target.message(
      followUp,
      "section-followup",
      view.sessionId,
    );
    const followUpCalls = updated.turns.at(-1)?.exchanges[0]?.toolCalls ?? [];
    expect(followUpCalls[0]?.result?.markdown).toContain("必须完整读取");
    expect(followUpCalls.slice(1).map((call) => call.result?.isError)).toEqual(
      Array.from({ length: 5 }, () => false),
    );
    const finished =
      after.replace("### Watch\n\nThe market watch stays.\n\n", "") +
      "## Dock\n\nPier access changes daily.\n";
    expect(
      (await target.files()).find((file) => file.path === path)?.contents,
    ).toBe(finished);
    if (kind === "revision") {
      expect(await readCommitted()).toBe(source);
      await expect(userText(page, followUp)).toBeVisible();
      await page
        .getByRole("button", { name: "应用并解锁", exact: true })
        .click();
      await expect(page.locator(".world-feedback.status")).toContainText(
        "世界修订已应用并解锁",
      );
      await page.reload();
      expect(await readCommitted()).toBe(finished);
      await target.open();
      const historicalDiff = page
        .locator(".setting-conversation-turn")
        .filter({ hasText: followUp })
        .getByRole("region", { name: "本轮已改文件" })
        .locator(".setting-change-diff")
        .first();
      await expect(historicalDiff).toContainText("已封存修订");
      await historicalDiff.locator("summary").click();
      await expect(historicalDiff.getByRole("table")).toBeVisible();
      await expect(
        historicalDiff.getByRole("button", { name: "回滚这个文件" }),
      ).toHaveCount(0);
    }
  });

  for (const locale of ["zh-CN", "en"] as const) {
    test(`${kind} resolves a file draft beside the conversation with the drawer closed (${locale})`, async ({
      page,
    }) => {
      const target = await prepare(page, kind, true, locale);
      const chinese = locale === "zh-CN";
      const draftMessage = "Continue with this conversation draft.";
      await composer(page).fill(draftMessage);

      const editor = await openEditor(page, kind, locale);
      const saved = "Saved from the conversation.\n";
      await editor.fill(saved);
      const closeFiles = page.getByRole("button", {
        name: chinese ? "收起文件面板" : "Close file panel",
        exact: true,
      });
      await closeFiles.click();
      await expect(editor).not.toBeVisible();

      const { warning, save, discard } = fileDraftActions(page, kind, locale);
      await expect(composer(page)).toBeDisabled();
      await expect(warning).toBeVisible();

      let saves = 0;
      let revisionDiscards = 0;
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route("**/api/runtime/v1", async (route) => {
        const type = runtimeInput(route)?.type;
        if (
          type ===
          (kind === "setting"
            ? "content.replace"
            : "world.revision.files.replace")
        ) {
          saves++;
          await saveGate;
        }
        if (type === "world.revision.discard") revisionDiscards++;
        await route.continue();
      });

      try {
        await expect(discard).toBeEnabled();
        await expect(save).toBeInViewport();
        await discard.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(save).toBeFocused();
        await page.keyboard.press("Enter");
        await expect.poll(() => saves).toBe(1);
        await expect(save).toBeDisabled();
        await expect(discard).toBeDisabled();
        await expect(composer(page)).toBeDisabled();
        await page.keyboard.press("Enter");
        await openEditor(page, kind, locale);
        const drawer = page
          .getByRole("complementary")
          .filter({ has: page.locator(".content-source-editor textarea") });
        const drawerActions = fileDraftActions(page, kind, locale, drawer);
        await expect(drawerActions.save).toBeDisabled();
        await expect(drawerActions.discard).toBeDisabled();
        await closeFiles.click();
      } finally {
        releaseSave();
      }

      await expect(composer(page)).toBeEnabled();
      await expect(composer(page)).toHaveValue(draftMessage);
      await expect(warning).toHaveCount(0);
      const savedFiles = await target.files();
      expect(
        savedFiles.find((file) => file.path === "control/blocks/world.md")
          ?.contents,
      ).toBe(saved);

      await openEditor(page, kind, locale);
      await editor.fill("Discard this local draft.");
      await closeFiles.click();
      await expect(composer(page)).toBeDisabled();
      await save.focus();
      await page.keyboard.press("Tab");
      await expect(discard).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(composer(page)).toBeEnabled();
      await expect(composer(page)).toHaveValue(draftMessage);
      await expect(warning).toHaveCount(0);
      expect(await target.files()).toEqual(savedFiles);
      expect(saves).toBe(1);
      expect(revisionDiscards).toBe(0);
      await openEditor(page, kind, locale);
      await expect(editor).toHaveValue(saved);
      await closeFiles.click();
      await composer(page).press("Enter");
      await expect(userText(page, draftMessage)).toBeVisible();
      await expect(composer(page)).toBeEnabled();
      expect(providerCalls).toBe(1);
    });
  }

  test(`${kind} in-page Back protects active requests and confirms leaving a file draft`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    const back = page.getByRole("button", {
      name: kind === "setting" ? "返回工作区" : "返回游玩",
      exact: true,
    });
    const modelSettings = page.getByRole("button", {
      name: "模型设置",
      exact: true,
    });
    const confirmation = page.getByRole("dialog", {
      name: "此页有未保存的修改。要放弃修改并离开吗？",
    });
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type === `${target.prefix}.message`)
        await responseGate;
      await route.continue();
    });
    try {
      await composer(page).fill("Please consider this location.");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(back).toBeDisabled();
      await expect(modelSettings).toBeDisabled();
    } finally {
      release();
    }
    await expect(
      page.getByText("The authoring reply is visible.", { exact: true }),
    ).toBeVisible();
    await expect(back).toBeEnabled();

    let editor = await openEditor(page, kind);
    const original = await editor.inputValue();
    await editor.fill(`${original}\nLocal file changes.`);
    await page
      .getByRole("button", { name: "收起文件面板", exact: true })
      .click();
    const originalAddress = page.url();
    await expect(back).toBeEnabled();
    await back.click();
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(back).toBeFocused();
    await expect(page).toHaveURL(originalAddress);
    editor = await openEditor(page, kind);
    await expect(editor).toHaveValue(`${original}\nLocal file changes.`);
    await page
      .getByRole("button", { name: "收起文件面板", exact: true })
      .click();

    await back.click();
    await confirmation
      .getByRole("button", { name: "放弃并离开", exact: true })
      .click();
    if (kind === "setting") {
      await expect(page).toHaveURL(/#\/$/u);
      await page.goBack();
      await expect(confirmation).toHaveCount(0);
    } else {
      await expect(page).toHaveURL(originalAddress);
      await expect(page.getByLabel("故事时间线")).toBeVisible();
      await modelSettings.click();
      await expect(page).toHaveURL(/#\/models$/u);
      await page.goBack();
      await target.open();
    }
    await expect(await openEditor(page, kind)).toHaveValue(original);
  });

  test(`${kind} first-load failures retry once and offer a read-only recovery`, async ({
    page,
  }) => {
    const target = await prepare(page, kind, false);
    let reads = 0;
    let offline = true;
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (input?.type === `${target.prefix}.overview`) {
        reads++;
        if (offline) return route.abort("failed");
      }
      if (
        input?.type === `${target.prefix}.message` ||
        input?.type === "world.revision.open"
      )
        writes++;
      await route.continue();
    });
    await target.open();
    await expect(syncNotice(page)).toBeVisible();
    expect(reads).toBe(2);
    offline = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(composer(page)).toBeEnabled();
    await expect(syncNotice(page)).toHaveCount(0);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(writes).toBe(0);
  });

  test(`${kind} accepted sends and edits survive lost receipts with one model dispatch each`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    let sends = 0;
    let edits = 0;
    const requestIds: string[] = [];
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (
        input?.type !== `${target.prefix}.message` &&
        input?.type !== `${target.prefix}.message.edit`
      )
        return route.continue();
      if (input.type.endsWith(".edit")) edits++;
      else sends++;
      if (!("requestId" in input)) throw new Error("Missing request identity");
      requestIds.push(input.requestId);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as {
        result: AuthoringConversationView;
      };
      expect(
        body.result.requestPreviews?.some(
          (item) => item.requestId === input.requestId,
        ),
      ).toBe(true);
      await route.abort("failed");
    });
    await send(page, "A single accepted author message.");
    await expect(
      userText(page, "A single accepted author message."),
    ).toHaveCount(1);
    await expect(composer(page)).toHaveValue("");
    await expect(
      page
        .locator(".setting-conversation-assistant p")
        .filter({ hasText: /^The authoring reply is visible\.$/u }),
    ).toHaveCount(1);
    expect(providerCalls).toBe(1);
    await page.getByRole("button", { name: "修改消息", exact: true }).click();
    await page
      .locator(".setting-message-edit textarea")
      .fill("The edited author message.");
    await page
      .getByRole("button", { name: "保留文件改动并继续", exact: true })
      .click();
    await expect(userText(page, "The edited author message.")).toHaveCount(1);
    await expect(
      userText(page, "A single accepted author message."),
    ).toHaveCount(0);
    await expect(page.locator(".setting-message-edit textarea")).toHaveCount(0);
    await expect(syncNotice(page)).toHaveCount(0);
    const latest = (await target.overview()).latest!;
    expect(latest.turns).toHaveLength(1);
    expect(latest.turns[0]!.user.text).toBe("The edited author message.");
    expect(
      latest.requestPreviews?.filter(
        (item) => item.requestId === requestIds[1],
      ),
    ).toHaveLength(1);
    expect(sends).toBe(1);
    expect(edits).toBe(1);
    expect(providerCalls).toBe(2);
  });

  for (const stale of ["old-request", "another-session"] as const)
    test(`${kind} ${stale} readback renders its records and retains unconfirmed text`, async ({
      page,
    }) => {
      const target = await prepare(page, kind);
      const text = "Identical text is not a request identity.";
      await send(page, text);
      await expect(composer(page)).toBeEnabled();
      const old = await target.overview();
      if (stale === "another-session")
        await page
          .getByRole("button", { name: "全新上下文", exact: true })
          .click();
      await silenceObservation(page);
      let writes = 0;
      await page.route("**/api/runtime/v1", async (route) => {
        const input = runtimeInput(route);
        if (input?.type === `${target.prefix}.message`) {
          writes++;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
        } else if (input?.type === `${target.prefix}.overview`) {
          await route.fulfill({
            json: { protocol: "narraeon.runtime/v1", result: old },
          });
        } else await route.continue();
      });
      await send(page, text);
      await expect(composer(page)).toHaveValue(text);
      await expect(userText(page, text)).toHaveCount(1);
      expect(writes).toBe(1);
      expect(providerCalls).toBe(2);
    });

  test(`${kind} observation recovery preserves the conversation and file draft and clears its notice`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Keep the accepted conversation.");
    const editor = await openEditor(page, kind);
    await editor.fill("An unsaved file draft.");
    await expectObservation(page);
    let offline = true;
    let reads = 0;
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (input?.type === `${target.prefix}.overview`) {
        reads++;
        if (offline) return route.abort("failed");
      }
      if (
        input?.type === "world.revision.open" ||
        input?.type === `${target.prefix}.message`
      )
        writes++;
      await route.continue();
    });
    await interruptObservation(page);
    await expect(syncNotice(page)).toBeVisible();
    expect(reads).toBe(1);
    await expect(editor).toHaveValue("An unsaved file draft.");
    await expect(
      userText(page, "Keep the accepted conversation."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "收起文件面板", exact: true })
      .click();
    offline = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(syncNotice(page)).toHaveCount(0);
    await openEditor(page, kind);
    await expect(editor).toHaveValue("An unsaved file draft.");
    expect(reads).toBe(2);
    expect(writes).toBe(0);
    expect(providerCalls).toBe(1);
  });

  test(`${kind} a terminal observation failure keeps manual recovery when reconnect cannot open`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Conversation before a terminal disconnect.");
    await expectObservation(page);
    await page.route("**/api/runtime/v1/events?**", (route) =>
      route.abort("failed"),
    );
    let reads = 0;
    page.on("request", (request) => {
      if (
        request.url().endsWith("/api/runtime/v1") &&
        (request.postDataJSON() as { request?: V1Request }).request?.type ===
          `${target.prefix}.overview`
      )
        reads++;
    });
    await interruptObservation(page, true);
    await expect(syncNotice(page)).toBeVisible();
    expect(reads).toBe(1);
    await page.unroute("**/api/runtime/v1/events?**");
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expectObservation(page);
    await expect(syncNotice(page)).toHaveCount(0);
    await expect(
      userText(page, "Conversation before a terminal disconnect."),
    ).toHaveCount(1);
    expect(providerCalls).toBe(1);
  });

  test(`${kind} a newer observed revision is read after an older hydration finishes`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Before the held hydration.");
    const sessionId = (await target.overview()).latest!.sessionId;
    await expectObservation(page);
    let reads = 0;
    let captured = false;
    let release!: () => void;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type !== `${target.prefix}.overview`)
        return route.continue();
      reads++;
      if (captured) return route.continue();
      const response = await route.fetch();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    await interruptObservation(page);
    await expect.poll(() => captured).toBe(true);
    await target.message(
      "The newer observed revision.",
      "peer-newer-request",
      sessionId,
    );
    // The observation delivery must keep consuming revisions while HTTP is held.
    await settlePaint(page);
    release();
    await expect(userText(page, "The newer observed revision.")).toHaveCount(1);
    expect(reads).toBeGreaterThanOrEqual(2);
    await expect(syncNotice(page)).toHaveCount(0);
    expect(providerCalls).toBe(2);
  });

  test(`${kind} a Runtime refusal keeps the submitted text and its reason`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type !== `${target.prefix}.message`)
        return route.continue();
      writes++;
      await route.fulfill({
        status: 409,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "invalid_state",
            message: "Fixture authoring explicitly refused.",
          },
        },
      });
    });
    await send(page, "Keep the explicitly rejected message.");
    await expect(composer(page)).toHaveValue(
      "Keep the explicitly rejected message.",
    );
    await expect(page.getByRole("alert")).toContainText(
      "Fixture authoring explicitly refused.",
    );
    expect(writes).toBe(1);
    expect(providerCalls).toBe(0);
  });

  test(`${kind} an unconfirmed message edit retains its draft after reading an older request`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Original message before an unconfirmed edit.");
    const old = await target.overview();
    await silenceObservation(page);
    let edits = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (input?.type === `${target.prefix}.message.edit`) {
        edits++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort("failed");
      } else if (input?.type === `${target.prefix}.overview`) {
        await route.fulfill({
          json: { protocol: "narraeon.runtime/v1", result: old },
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "修改消息", exact: true }).click();
    const draft = page.locator(".setting-message-edit textarea");
    await draft.fill("Keep this unconfirmed edit draft.");
    await page
      .getByRole("button", { name: "保留文件改动并继续", exact: true })
      .click();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue("Keep this unconfirmed edit draft.");
    expect(edits).toBe(1);
    expect(providerCalls).toBe(2);
  });

  test(`${kind} candidate preview retries and preserves its last valid display`, async ({
    page,
  }) => {
    await prepare(page, kind);
    const preview = page.locator(".authoring-prompt-preview");
    await preview
      .getByRole("button", { name: "预览下一条请求", exact: true })
      .click();
    await expect(
      preview.getByText("下一次发送候选（未发送）", { exact: true }),
    ).toBeVisible();
    let reads = 0;
    let offline = true;
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (
        input?.type ===
        `${kind === "setting" ? "setting-improvement" : "world.revision"}.preview`
      ) {
        reads++;
        if (offline) return route.abort("failed");
      }
      if (
        input?.type === "world.revision.open" ||
        input?.type.endsWith(".message")
      )
        writes++;
      await route.continue();
    });
    await preview
      .getByRole("button", { name: "预览下一条请求", exact: true })
      .click();
    await expect(
      preview.getByText("暂时无法同步", { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByText("下一次发送候选（未发送）", { exact: true }),
    ).toBeVisible();
    expect(reads).toBe(2);
    offline = false;
    await preview
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await expect(
      preview.getByText("暂时无法同步", { exact: true }),
    ).toHaveCount(0);
    expect(reads).toBe(3);
    expect(writes).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test(`${kind} candidate-preview refusal retains Runtime's diagnostic`, async ({
    page,
  }) => {
    await prepare(page, kind);
    await page.route("**/api/runtime/v1", async (route) => {
      if (
        runtimeInput(route)?.type !==
        `${kind === "setting" ? "setting-improvement" : "world.revision"}.preview`
      )
        return route.continue();
      await route.fulfill({
        status: 400,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "invalid_state",
            message: "Fixture preview requires a compatible model.",
          },
        },
      });
    });
    await page
      .getByRole("button", { name: "预览下一条请求", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Fixture preview requires a compatible model.",
    );
    expect(providerCalls).toBe(0);
  });

  test(`${kind} a late candidate-preview failure cannot affect a fresh conversation`, async ({
    page,
  }) => {
    await prepare(page, kind);
    await send(page, "Conversation owning the pending preview.");
    let captured = false;
    let release!: () => void;
    await page.route("**/api/runtime/v1", async (route) => {
      if (
        runtimeInput(route)?.type !==
        `${kind === "setting" ? "setting-improvement" : "world.revision"}.preview`
      )
        return route.continue();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.abort("failed");
    });
    await page
      .getByRole("button", { name: "预览下一条请求", exact: true })
      .click();
    await expect.poll(() => captured).toBe(true);
    await page.getByRole("button", { name: "全新上下文", exact: true }).click();
    await composer(page).fill("Keep the fresh conversation draft.");
    release();
    await settlePaint(page);
    await expect(composer(page)).toHaveValue(
      "Keep the fresh conversation draft.",
    );
    await expect(syncNotice(page)).toHaveCount(0);
    expect(providerCalls).toBe(1);
  });

  test(`${kind} a rejected file draft stays editable after saving from the conversation`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Keep this conversation through rejected validation.");
    const baseline = await target.files();
    const editor = await openEditor(page, kind);
    const invalidPath =
      kind === "setting" ? "control/gameplay.json" : "state/invalid.yaml";
    const invalid = "This is not a valid document.\n";
    await page.getByText("新建文件", { exact: true }).click();
    await page.getByLabel("新文件路径", { exact: true }).fill(invalidPath);
    await page.getByRole("button", { name: "加入草稿", exact: true }).click();
    await editor.fill(invalid);
    const closeFiles = page.getByRole("button", {
      name: "收起文件面板",
      exact: true,
    });
    await closeFiles.click();

    const { save, discard } = fileDraftActions(page, kind);
    await save.click();
    await expect(page.getByRole("alert")).toContainText(
      kind === "setting" ? "玩法文件必须是合法 JSON" : invalidPath,
    );
    await expect(composer(page)).toBeDisabled();
    await expect(save).toBeEnabled();
    expect(await target.files()).toEqual(baseline);
    await openEditor(page, kind);
    await page
      .getByRole("button", { name: `打开 ${invalidPath}`, exact: true })
      .click();
    await expect(editor).toHaveValue(invalid);
    await closeFiles.click();
    await discard.click();
    await expect(composer(page)).toBeEnabled();
    expect(await target.files()).toEqual(baseline);
    await expect(
      userText(page, "Keep this conversation through rejected validation."),
    ).toBeVisible();
  });

  test(`${kind} lost file-save receipt from the conversation rereads without replay and retains the draft`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    const editor = await openEditor(page, kind);
    await editor.fill("Saved authoring file with a lost receipt.\n");
    if (kind === "revision")
      await expect(
        page.getByText("世界已锁定到这份修订；关闭页面也会保留工作树。", {
          exact: true,
        }),
      ).toBeVisible();
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (
        input?.type !==
        (kind === "setting"
          ? "content.replace"
          : "world.revision.files.replace")
      )
        return route.continue();
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    const closeFiles = page.getByRole("button", {
      name: "收起文件面板",
      exact: true,
    });
    await closeFiles.click();
    const { save, discard } = fileDraftActions(page, kind);
    await save.click();
    await expect(page.getByRole("alert")).toContainText("无法连接");
    await expect(composer(page)).toBeDisabled();
    await expect(save).toBeEnabled();
    await openEditor(page, kind);
    await expect(editor).toHaveValue(
      "Saved authoring file with a lost receipt.\n",
    );
    const saved = await target.files();
    expect(
      saved.find((file) => file.path === "control/blocks/world.md")?.contents,
    ).toBe("Saved authoring file with a lost receipt.\n");
    await closeFiles.click();
    await discard.click();
    await expect(composer(page)).toBeEnabled();
    await openEditor(page, kind);
    await expect(editor).toHaveValue(
      "Saved authoring file with a lost receipt.\n",
    );
    expect(writes).toBe(1);
    expect(providerCalls).toBe(0);
  });

  test(`${kind} deleting the selected session with a lost receipt recovers the remaining conversation`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    await send(page, "Conversation retained after deletion.");
    await page.getByRole("button", { name: "全新上下文", exact: true }).click();
    await send(page, "Conversation selected for deletion.");
    const selected = (await target.overview()).latest?.sessionId;
    expect(selected).toBeDefined();
    await silenceObservation(page);
    const deletes: string[] = [];
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (
        input?.type !== "setting-improvement.session.delete" &&
        input?.type !== "world.revision.session.delete"
      )
        return route.continue();
      expect(input.type).toBe(`${target.prefix}.session.delete`);
      deletes.push(input.sessionId);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "历史", exact: true }).click();
    const opener = page
      .locator("li")
      .filter({
        has: page.locator(".setting-history-select[aria-pressed=true]"),
      })
      .locator(".setting-history-delete");
    const dialog = page.getByRole("dialog", {
      name:
        kind === "setting"
          ? /删除对话“Conversation selected for deletion.”.*内容包当前树的改动不会回滚/
          : /删除对话“Conversation selected for deletion.”.*修订工作树中的改动不会回滚/,
    });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const confirm = dialog.getByRole("button", { name: "删除", exact: true });
    await opener.click();
    await expect(cancel).toBeFocused();
    await expect(confirm).toHaveClass(/danger-button/);
    expect(
      await page.evaluate(() =>
        (
          window as { narraeonAndroidBack?: () => boolean }
        ).narraeonAndroidBack?.(),
      ),
    ).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(deletes).toEqual([]);
    await opener.click();
    await confirm.dblclick();
    await expect(
      userText(page, "Conversation retained after deletion."),
    ).toHaveCount(1);
    await expect(
      userText(page, "Conversation selected for deletion."),
    ).toHaveCount(0);
    await expect(syncNotice(page)).toHaveCount(0);
    expect(deletes).toEqual([selected]);
    expect(providerCalls).toBe(2);
  });

  test(`${kind} actual Provider interruption keeps Runtime's supported recovery action`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    rejectModel = true;
    let writes = 0;
    let firstCallId = "";
    const contexts: string[] = [];
    await page.route("**/api/runtime/v1", async (route) => {
      const input = runtimeInput(route);
      if (
        input?.type === "setting-improvement.call.context" ||
        input?.type === "world.revision.call.context"
      )
        contexts.push(input.callId);
      if (input?.type !== `${target.prefix}.message`) return route.continue();
      writes++;
      const response = await route.fetch();
      const result = (
        (await response.json()) as { result: AuthoringConversationView }
      ).result;
      expect(result.runStatus).toBe("interrupted");
      firstCallId = result.turns[0]!.exchanges[0]!.id;
      await route.abort("failed");
    });
    await send(page, "An interrupted authoring request.");
    await expect(
      page.getByRole("button", { name: "重新发送", exact: true }),
    ).toBeEnabled();
    await expect(
      userText(page, "An interrupted authoring request."),
    ).toHaveCount(1);
    expect(writes).toBe(1);
    expect(providerCalls).toBe(1);

    const trace = page.locator(".model-call-details");
    await trace.locator(":scope > summary").click();
    for (let retry = 0; retry < 2; retry++) {
      await page.getByRole("button", { name: "重新发送", exact: true }).click();
      await expect.poll(() => providerCalls).toBe(retry + 2);
      await expect(
        page.getByRole("button", { name: "重新发送", exact: true }),
      ).toBeEnabled();
      await expect(trace.locator(".model-call")).toHaveCount(1);
      await expect(trace.locator(".model-call > header")).not.toContainText(
        "第 ",
      );
    }
    rejectModel = false;
    await page.getByRole("button", { name: "重新发送", exact: true }).click();
    await expect(
      page.getByText("The authoring reply is visible.", { exact: true }),
    ).toBeVisible();
    await expect(trace.locator(".model-call")).toHaveCount(1);
    await expect(trace.locator(".model-call")).toContainText("已完成");
    await expect(trace.locator(".model-call-attempt-history")).toHaveCount(0);
    await expect(trace.getByText("历史尝试", { exact: false })).toHaveCount(0);
    expect(contexts).toHaveLength(0);
    const current = await target.overview();
    expect(current.latest!.turns[0]!.exchanges).toHaveLength(1);
    expect(current.latest!.turns[0]!.exchanges[0]!.id).not.toBe(firstCallId);
    await trace
      .locator(".model-call .technical-details")
      .first()
      .locator(":scope > summary")
      .click();
    await expect
      .poll(() => contexts)
      .toEqual([current.latest!.turns[0]!.exchanges[0]!.id]);
    expect(providerCalls).toBe(4);
    await page.reload();
    if (kind === "revision") await target.open();
    await page.locator(".model-call-details > summary").click();
    await expect(page.locator(".model-call-details .model-call")).toHaveCount(
      1,
    );
    await expect(page.locator(".model-call-details .model-call")).toContainText(
      "已完成",
    );
  });

  for (const late of ["success", "failure"] as const)
    test(`${kind} selecting another session discards a late recovery ${late}`, async ({
      page,
    }) => {
      const target = await prepare(page, kind);
      const first = await sendFreshConversation(
        page,
        target.prefix,
        "First independent conversation.",
      );
      const firstId = first.sessionId;
      expect(providerCalls).toBe(1);
      await page
        .getByRole("button", { name: "全新上下文", exact: true })
        .click();
      const second = await sendFreshConversation(
        page,
        target.prefix,
        "Second independent conversation.",
      );
      expect(second.sessionId).not.toBe(firstId);
      expect(providerCalls).toBe(2);
      await expectObservation(page);
      let captured = false;
      let release!: () => void;
      await page.route("**/api/runtime/v1", async (route) => {
        if (
          runtimeInput(route)?.type !== `${target.prefix}.overview` ||
          captured
        )
          return route.continue();
        const response = await route.fetch();
        captured = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (late === "success") await route.fulfill({ response });
        else await route.abort("failed");
      });
      await interruptObservation(page);
      await expect.poll(() => captured).toBe(true);
      await page.getByRole("button", { name: "历史", exact: true }).click();
      await page
        .locator(".setting-history-select")
        .filter({ hasText: "First independent conversation." })
        .click();
      await expect(
        userText(page, "First independent conversation."),
      ).toBeVisible();
      await composer(page).fill("Keep the newly selected session's draft.");
      const predicate = (request: Request) =>
        request.url().endsWith("/api/runtime/v1") &&
        (request.postDataJSON() as { request: V1Request }).request.type ===
          `${target.prefix}.overview`;
      const delivery =
        late === "success"
          ? page.waitForEvent("requestfinished", { predicate })
          : page.waitForEvent("requestfailed", { predicate });
      release();
      await delivery;
      await settlePaint(page);
      await expect(composer(page)).toHaveValue(
        "Keep the newly selected session's draft.",
      );
      await expect(
        userText(page, "Second independent conversation."),
      ).toHaveCount(0);
      await expect(syncNotice(page)).toHaveCount(0);
      const previewIds = (await target.readSession(firstId)).requestPreviews;
      expect(previewIds).toHaveLength(1);
      expect(providerCalls).toBe(2);
    });
}

test("a conflicting content-package save explains the rejection with the drawer closed", async ({
  page,
}) => {
  const target = await prepare(page, "setting");
  const path = "control/blocks/world.md";
  const { files, treeRevision } = await runtime<{
    files: { path: string; contents: string }[];
    treeRevision: string;
  }>(page, { type: "content.read", packageId: target.id });
  const editor = await openEditor(page, "setting");
  const localEdit = "Keep this local file draft.\n";
  const laterEdit = "Saved from another editor.\n";
  await editor.fill(localEdit);
  const closeFiles = page.getByRole("button", {
    name: "收起文件面板",
    exact: true,
  });
  await closeFiles.click();
  await runtime(page, {
    type: "content.replace",
    packageId: target.id,
    baseTreeRevision: treeRevision,
    files: files.map((file) =>
      file.path === path ? { ...file, contents: laterEdit } : file,
    ),
  });

  const { save, discard } = fileDraftActions(page, "setting");
  await save.click();
  await expect(page.getByRole("alert")).toHaveText(
    "内容包已被其他操作修改，草稿已保留，尚未保存。",
  );
  await expect(composer(page)).toBeDisabled();
  await openEditor(page, "setting");
  await expect(editor).toHaveValue(localEdit);
  await closeFiles.click();
  await discard.click();
  await expect(composer(page)).toBeEnabled();
  await openEditor(page, "setting");
  await expect(editor).toHaveValue(laterEdit);
});

test("world revision reflects the lock before and after a discarded epoch", async ({
  page,
}) => {
  const target = await prepare(page, "revision");
  const overview = () =>
    runtime<V1WorldRevisionOverview>(page, {
      type: "world.revision.overview",
      worldId: target.id,
    });
  const commands: V1Request["type"][] = [];
  await page.route("**/api/runtime/v1", async (route) => {
    const input = runtimeInput(route);
    if (input !== undefined) commands.push(input.type);
    await route.continue();
  });
  const tools = page.getByRole("navigation", { name: "世界修订工具" });
  const locked = page.getByText("世界游玩已锁定", { exact: true });
  const unlocked = page.getByText("世界游玩未锁定", { exact: true });
  const history = page.getByText("已封存修订", { exact: true });
  await expect(unlocked).toBeVisible();
  await expect(locked).toHaveCount(0);
  await expect(history).toHaveCount(0);
  await expect(
    tools.getByRole("button", { name: "放弃", exact: true }),
  ).toHaveCount(0);
  expect(await overview()).toMatchObject({ epoch: null, sealedEpochs: [] });

  const editor = await openEditor(page, "revision");
  expect((await overview()).epoch).toBeNull();
  await editor.fill(
    `${await editor.inputValue()}\n\nA draft started the epoch.\n`,
  );
  await expect(locked).toBeVisible();
  await expect(unlocked).toHaveCount(0);
  expect((await overview()).epoch?.locked).toBe(true);
  await page.getByRole("button", { name: "保存到修订", exact: true }).click();
  await expect(
    page.getByText("修订工作树已保存", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收起文件面板", exact: true }).click();
  await tools.getByRole("button", { name: "放弃", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "放弃", exact: true })
    .click();
  await expect(
    page.getByText("这次世界修订已放弃，原世界保持不变并已解锁。"),
  ).toBeVisible();
  const sealed = await overview();
  expect(sealed.epoch?.locked ?? false).toBe(false);
  expect(sealed.sealedEpochs).toMatchObject([{ lifecycle: "discarded" }]);

  commands.length = 0;
  await target.open();
  await expect(unlocked).toBeVisible();
  await expect(locked).toHaveCount(0);
  await expect(
    tools.getByRole("button", { name: "应用并解锁", exact: true }),
  ).toHaveCount(0);
  await history.click();
  await expect(page.getByText("已放弃修订", { exact: true })).toBeVisible();
  await tools.getByRole("button", { name: "文件", exact: true }).click();
  const preview = page.getByRole("complementary", { name: "世界修订文件预览" });
  await expect(
    preview.getByText("世界当前文件", { exact: true }),
  ).toBeVisible();
  expect(await overview()).toEqual(sealed);
  expect(commands.filter((type) => type.startsWith("world.revision."))).toEqual(
    expect.arrayContaining(["world.revision.overview"]),
  );
  expect(commands.filter((type) => type.startsWith("world.revision."))).toEqual(
    commands.filter((type) =>
      [
        "world.revision.overview",
        "world.revision.session.read",
        "world.revision.status",
      ].includes(type),
    ),
  );
  expect(providerCalls).toBe(0);
});

test("world revision first-edit lock receipt is never replayed during read recovery", async ({
  page,
}) => {
  const target = await prepare(page, "revision");
  await silenceObservation(page);
  let opens = 0;
  let reads = 0;
  let offline = false;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = runtimeInput(route);
    if (input?.type === "world.revision.open") {
      opens++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      offline = true;
      await route.abort("failed");
    } else if (input?.type === "world.revision.overview" && opens > 0) {
      reads++;
      if (offline) return route.abort("failed");
      await route.continue();
    } else await route.continue();
  });
  const editor = await openEditor(page, "revision");
  await editor.fill("Preserve the draft while its lock receipt is lost.");
  await expect(syncNotice(page)).toBeVisible();
  await expect(editor).toHaveValue(
    "Preserve the draft while its lock receipt is lost.",
  );
  await page.getByRole("button", { name: "收起文件面板", exact: true }).click();
  offline = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(syncNotice(page)).toHaveCount(0);
  await openEditor(page, "revision");
  await expect(editor).toHaveValue(
    "Preserve the draft while its lock receipt is lost.",
  );
  expect(opens).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(
    (await target.files()).find(
      (file) => file.path === "control/blocks/world.md",
    )?.contents,
  ).not.toBe("Preserve the draft while its lock receipt is lost.");
  expect(providerCalls).toBe(0);
});

test("a lost package gameplay receipt refreshes authoring metadata before drafts unlock", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const pack = await runtime<{ localId: string }>(page, {
    type: "content.create",
    gameplay: { mode: "tabletop", scheme: "d20" },
  });
  await page.goto(`/#/content/${pack.localId}`);
  await openDetails(
    page.getByRole("region", { name: "玩法" }).locator("summary"),
  );
  await expect(
    page.getByRole("radio", { name: "d20", exact: true }),
  ).toBeChecked();
  let writes = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    if (runtimeInput(route)?.type !== "content.gameplay.set")
      return route.continue();
    writes++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await page.getByRole("radio", { name: "d100", exact: true }).check();
  await expect(
    page.getByRole("radio", { name: "d100", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("radio", { name: "d100", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("navigation", { name: "设定完善工具" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "内容包文件编辑" }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(providerCalls).toBe(0);
});

async function openDetails(summary: Locator): Promise<void> {
  if (
    !(await summary.evaluate((element) =>
      element.parentElement?.hasAttribute("open"),
    ))
  ) {
    await summary.click();
  }
}

function runtimeInput(route: Route): V1Request | undefined {
  return (route.request().postDataJSON() as { request?: V1Request } | null)
    ?.request;
}
function userText(page: Page, text: string) {
  return page.locator(".setting-conversation-user p").filter({
    hasText: new RegExp(
      `^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "u",
    ),
  });
}
function composer(page: Page) {
  return page.locator("#setting-conversation-input");
}
function fileDraftActions(
  page: Page,
  kind: Kind,
  locale: "zh-CN" | "en" = "zh-CN",
  controls = page.locator(".setting-conversation-composer"),
) {
  const chinese = locale === "zh-CN";
  const saveLabel =
    kind === "setting"
      ? chinese
        ? "整批保存"
        : "Save all changes"
      : chinese
        ? "保存到修订"
        : "Save to revision";
  return {
    warning: controls.getByText(
      chinese
        ? "请先保存或放弃文件编辑中的未保存修改。"
        : "Save or discard the unsaved manual file edits first.",
      { exact: true },
    ),
    save: controls.getByRole("button", { name: saveLabel, exact: true }),
    discard: controls.getByRole("button", {
      name: chinese ? "放弃未保存修改" : "Discard unsaved changes",
      exact: true,
    }),
  };
}
function syncNotice(page: Page) {
  return page.getByText("暂时无法同步", { exact: true });
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer(page)).toBeEnabled();
}
async function sendFreshConversation(page: Page, prefix: string, text: string) {
  const responsePending = page.waitForResponse((response) => {
    if (
      !response.url().endsWith("/api/runtime/v1") ||
      response.request().method() !== "POST"
    )
      return false;
    const input = (response.request().postDataJSON() as { request: V1Request })
      .request;
    return (
      input.type === `${prefix}.message` &&
      "message" in input &&
      input.message === text
    );
  });
  await send(page, text);
  const response = await responsePending;
  const body = (await response.json()) as {
    result: AuthoringConversationView;
    error?: unknown;
  };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  const input = (response.request().postDataJSON() as { request: V1Request })
    .request;
  if (!("requestId" in input) || !("continuation" in input))
    throw new Error("Missing authoring request identity");
  expect(input.continuation).toEqual({ kind: "fresh_context" });
  expect(body.result.runStatus, body.result.lastFailure ?? undefined).toBe(
    "ready",
  );
  expect(body.result.turns).toHaveLength(1);
  expect(body.result.turns[0]!.user.text).toBe(text);
  expect(
    body.result.requestPreviews?.filter(
      (item) => item.requestId === input.requestId,
    ),
  ).toHaveLength(1);
  return body.result;
}

async function settlePaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function expectObservation(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { authoringObservationReady(): boolean }
        ).authoringObservationReady(),
      ),
    )
    .toBe(true);
  await settlePaint(page);
}
async function silenceObservation(page: Page) {
  await expectObservation(page);
  await page.evaluate(() =>
    (
      window as unknown as { silenceAuthoringObservation(): void }
    ).silenceAuthoringObservation(),
  );
}
async function interruptObservation(page: Page, terminal = false) {
  await page.evaluate(
    (closed) =>
      (
        window as unknown as {
          interruptAuthoringObservation(terminal: boolean): void;
        }
      ).interruptAuthoringObservation(closed),
    terminal,
  );
}
async function openEditor(
  page: Page,
  kind: Kind,
  locale: "zh-CN" | "en" = "zh-CN",
) {
  const chinese = locale === "zh-CN";
  await page
    .getByRole("navigation", {
      name:
        kind === "setting"
          ? chinese
            ? "设定完善工具"
            : "Setting-improvement tools"
          : chinese
            ? "世界修订工具"
            : "World-revision tools",
    })
    .getByRole("button", { name: chinese ? "编辑" : "Edit", exact: true })
    .click();
  const rail = page.getByRole("complementary", {
    name:
      kind === "setting"
        ? chinese
          ? "内容包文件编辑"
          : "Content-package file editing"
        : chinese
          ? "世界修订文件编辑"
          : "Edit world-revision files",
  });
  await rail
    .getByRole("button", {
      name: chinese
        ? "打开 control/blocks/world.md"
        : "Open control/blocks/world.md",
      exact: true,
    })
    .click();
  return rail.locator(".content-source-editor textarea");
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
async function prepare(
  page: Page,
  kind: Kind,
  open = true,
  locale: "zh-CN" | "en" = "zh-CN",
  addedFile?: { path: string; contents: string },
) {
  const chinese = locale === "zh-CN";
  await runtime(page, { type: "preferences.save", locale });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Authoring fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "sync-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const pack = await runtime<{ localId: string }>(page, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
  if (addedFile !== undefined) {
    const current = await runtime<{
      treeRevision: string;
      files: { path: string; contents: string }[];
    }>(page, { type: "content.read", packageId: pack.localId });
    await runtime(page, {
      type: "content.replace",
      packageId: pack.localId,
      baseTreeRevision: current.treeRevision,
      files: [...current.files, addedFile],
    });
  }
  let id = pack.localId;
  if (kind === "revision") {
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: `create-${pack.localId}`,
      packageId: pack.localId,
      model: {
        provider: "chat_completions",
        modelId: "sync-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    id = created.world.worldId;
  }
  const prefix =
    kind === "setting"
      ? ("setting-improvement" as const)
      : ("world.revision" as const);
  const target = {
    id,
    prefix,
    open: async () => {
      await page.goto(`/#/${kind === "setting" ? "content" : "world"}/${id}`);
      if (kind === "revision") {
        await page
          .getByRole("button", {
            name: chinese ? "世界" : "Worlds",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name: chinese ? "修订当前世界" : "Revise current world",
            exact: true,
          })
          .click();
      }
    },
    overview: () =>
      runtime<{ latest: AuthoringConversationView | null }>(
        page,
        kind === "setting"
          ? { type: "setting-improvement.overview", packageId: id }
          : { type: "world.revision.overview", worldId: id },
      ),
    readSession: (sessionId: string) =>
      runtime<AuthoringConversationView>(
        page,
        kind === "setting"
          ? {
              type: "setting-improvement.session.read",
              packageId: id,
              sessionId,
            }
          : { type: "world.revision.session.read", worldId: id, sessionId },
      ),
    message: (message: string, requestId: string, sessionId: string) =>
      runtime<AuthoringConversationView>(
        page,
        kind === "setting"
          ? {
              type: "setting-improvement.message",
              packageId: id,
              message,
              requestId,
              continuation: { kind: "continue_context", sessionId },
            }
          : {
              type: "world.revision.message",
              worldId: id,
              message,
              requestId,
              continuation: { kind: "continue_context", sessionId },
            },
      ),
    files: async () =>
      kind === "setting"
        ? (
            await runtime<{ files: { path: string; contents: string }[] }>(
              page,
              { type: "content.read", packageId: id },
            )
          ).files
        : (
            await runtime<{
              epoch: { files: { path: string; contents: string }[] };
            }>(page, { type: "world.revision.overview", worldId: id })
          ).epoch.files,
  };
  if (open) {
    await target.open();
    await expect(composer(page)).toBeEnabled();
    await expectObservation(page);
  }
  return target;
}
