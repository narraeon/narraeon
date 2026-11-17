import { expect, type Page, type Request, type Route } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AuthoringConversationView } from "../../src/web/AuthoringTarget.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "authoring-sync" });
type Kind = "setting" | "revision";
let provider: Server;
let providerUrl = "";
let providerCalls = 0;
let rejectModel = false;

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      providerCalls++;
      if (rejectModel) {
        response.writeHead(429, { "content-type": "application/json" });
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
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
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
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
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
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
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
      .getByRole("button", { name: "重新读取", exact: true })
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

  test(`${kind} lost file-save receipt rereads without replay and retains the draft`, async ({
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
    await page
      .getByRole("button", {
        name: kind === "setting" ? "整批保存" : "保存到修订",
        exact: true,
      })
      .click();
    await expect(page.getByRole("alert")).toContainText("无法连接");
    await expect(editor).toHaveValue(
      "Saved authoring file with a lost receipt.\n",
    );
    const saved = await target.files();
    expect(
      saved.find((file) => file.path === "control/blocks/world.md")?.contents,
    ).toBe("Saved authoring file with a lost receipt.\n");
    await page
      .getByRole("button", { name: "放弃未保存修改", exact: true })
      .click();
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
    await silenceObservation(page);
    let deletes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type !== `${target.prefix}.session.delete`)
        return route.continue();
      deletes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "历史", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator("li")
      .filter({
        has: page.locator(".setting-history-select[aria-pressed=true]"),
      })
      .locator(".setting-history-delete")
      .click();
    await expect(
      userText(page, "Conversation retained after deletion."),
    ).toHaveCount(1);
    await expect(
      userText(page, "Conversation selected for deletion."),
    ).toHaveCount(0);
    await expect(syncNotice(page)).toHaveCount(0);
    expect(deletes).toBe(1);
    expect(providerCalls).toBe(2);
  });

  test(`${kind} actual Provider interruption keeps Runtime's supported recovery action`, async ({
    page,
  }) => {
    const target = await prepare(page, kind);
    rejectModel = true;
    let writes = 0;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type !== `${target.prefix}.message`)
        return route.continue();
      writes++;
      const response = await route.fetch();
      expect(
        ((await response.json()) as { result: AuthoringConversationView })
          .result.runStatus,
      ).toBe("interrupted");
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
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
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
async function openEditor(page: Page, kind: Kind) {
  await page
    .getByRole("navigation", {
      name: kind === "setting" ? "设定完善工具" : "世界修订工具",
    })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const rail = page.getByRole("complementary", {
    name: kind === "setting" ? "内容包文件编辑" : "世界修订文件编辑",
  });
  await rail
    .getByRole("button", { name: "打开 control/blocks/world.md", exact: true })
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
async function prepare(page: Page, kind: Kind, open = true) {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
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
    prefix,
    open: async () => {
      await page.goto(`/#/${kind === "setting" ? "content" : "world"}/${id}`);
      if (kind === "revision") {
        await page.getByRole("button", { name: "世界", exact: true }).click();
        await page
          .getByRole("button", { name: "修订当前世界", exact: true })
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
