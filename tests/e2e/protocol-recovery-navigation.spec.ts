import { createServer } from "node:http";
import { expect, type Page, type Request } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type {
  ContentTreeFile,
  V1PlayTimelinePage,
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import type {
  FileNativePlayPresetLibrary,
  FileNativePlayPresetView,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "protocol-recovery-navigation" });

type Surface = "play" | "revision" | "setting";
const surfaces: Surface[] = ["play", "revision", "setting"];
const orderRule =
  "当前协议要求所有 System 提示排在第一条 User 或 Assistant 提示之前。";
const authorMismatch =
  "当前模型协议与此对话不同。切回兼容连接即可继续，或开启新对话并保留已保存的创作工作。";
const playMismatch =
  "当前模型协议与此上下文不同。切回原协议即可继续；使用新协议请开启全新上下文。";
const savedWorkMarker = "Keep the saved harbor ledger.";
const savedWorkPath = "control/blocks/world.md";

let provider: ReturnType<typeof createServer>;
let providerUrl: string;
const providerCalls: string[] = [];
let rejectAtProvider = false;

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      providerCalls.push(request.url ?? "");
      const text = reply(providerCalls.length);
      if (rejectAtProvider) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "Provider rejection: place all System prompts before User/Assistant prompts.",
            },
          }),
        );
      } else if (request.url === "/v1/messages") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
          }),
        );
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
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
    throw new Error("Fixture Provider did not receive a port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(async ({ page }) => {
  providerCalls.length = 0;
  rejectAtProvider = false;
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const { preset } = await createScheme(page, "Compatible fixture scheme");
  await runtime(page, { type: "play.select", presetId: preset.id });
});

for (const surface of surfaces) {
  test(`${surface}: shows recovery for an actual protocol mismatch and keeps saved work`, async ({
    page,
  }) => {
    const replacement = await configure(page, "anthropic_messages");
    const original = await configure(page, "chat_completions");
    const target = await openSurface(page, surface);
    if (surface !== "play") await saveWork(page, surface);
    const initialText = "Begin with the harbor ledger.";
    const initial = await send(page, surface, initialText, true);
    expect(initial.ok(), await initial.text()).toBe(true);
    await expect(page.getByText(reply(1), { exact: true })).toBeVisible();
    const initialResult = (await initial.json()) as {
      result: { chainId?: string; sessionId?: string };
    };

    // A second workspace updates the active connection as this browser sends.
    // Forward the browser request unchanged to the production Runtime.
    const attempt = "Read the next entry.";
    const repeatedAttempt = "Start a new discussion of the ledger.";
    await page.route("**/api/runtime/v1", async (route) => {
      const command = browserCommand(route.request());
      if (
        [attempt, repeatedAttempt].some((text) =>
          isSend(command, surface, text),
        )
      )
        await selectConnection(page, replacement);
      await route.continue();
    });
    const rejected = await send(page, surface, attempt, false);
    expect(await rejected.json()).toMatchObject({
      error: { code: "model_protocol_mismatch" },
    });
    expect(new URL(page.url()).hash).toBe(target.hash);
    await expect(
      page.getByText(surface === "play" ? playMismatch : authorMismatch, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(viewOrchestration(page)).toHaveCount(0);
    expect(providerCalls).toEqual(["/v1/chat/completions"]);

    await selectConnection(page, original);
    const continuation = await send(
      page,
      surface,
      "Continue on the compatible connection.",
      false,
    );
    expect(continuation.ok(), await continuation.text()).toBe(true);
    await expect(page.getByText(reply(2), { exact: true })).toBeVisible();
    const continued = (await continuation.json()) as {
      result: { chainId?: string; sessionId?: string };
    };
    expect(continued.result.chainId ?? continued.result.sessionId).toBe(
      initialResult.result.chainId ?? initialResult.result.sessionId,
    );
    await send(page, surface, repeatedAttempt, false);
    const chooseFresh = page.getByRole("button", {
      name:
        surface === "play"
          ? "选择新对话（保留故事进度）"
          : "选择新对话（保留已保存的创作工作）",
      exact: true,
    });
    await expect(chooseFresh).toBeVisible();
    await chooseFresh.click();
    await expect(input(page, surface)).toBeFocused();
    expect(providerCalls).toHaveLength(2);

    await expect(input(page, surface)).toHaveValue(repeatedAttempt);
    if (surface === "play") {
      await expect(page.getByText(reply(1), { exact: true })).toBeVisible();
      await expect(page.getByText(reply(2), { exact: true })).toBeVisible();
    }

    const after = await send(page, surface, "Use a fresh context.", true);
    expect(after.ok(), await after.text()).toBe(true);
    await expect(page.getByText(reply(3), { exact: true })).toBeVisible();
    expect(providerCalls).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
    ]);

    if (surface === "play") {
      await expect(page.getByText(reply(1), { exact: true })).toBeVisible();
      const story = await runtime<V1PlayTimelinePage>(page, {
        type: "play.timeline.page",
        worldId: target.worldId,
        limit: 40,
      });
      expect(JSON.stringify(story.items)).not.toContain(attempt);
      expect(JSON.stringify(story.items)).not.toContain(repeatedAttempt);
    } else {
      const refreshed = (await after.json()) as {
        result: { sessionId: string };
      };
      expect(refreshed.result.sessionId).not.toBe(
        initialResult.result.sessionId,
      );
      expect(
        (await readFiles(page, surface, target)).find(
          ({ path }) => path === savedWorkPath,
        )?.contents,
      ).toContain(savedWorkMarker);
    }
  });

  test(`${surface}: opens the scheme and prompt list identified by an actual role-order rejection`, async ({
    page,
  }) => {
    await configure(
      page,
      surface === "play" ? "google_interactions" : "anthropic_messages",
    );
    const { preset: decoy } = await createScheme(page, "Other scheme");
    const scheme = await createOrderConflict(page, surface);
    const target = await openSurface(page, surface);
    const rejected = await send(page, surface, "Read the harbor ledger.", true);
    const receipt: unknown = await rejected.json();
    expect(providerCalls).toEqual([]);
    expect(new URL(page.url()).hash).toBe(target.hash);
    await test.info().attach("runtime-role-order-receipt", {
      body: JSON.stringify(receipt),
      contentType: "application/json",
    });
    await expect(page.getByText(orderRule, { exact: true })).toBeVisible();
    const orchestration = {
      id: scheme.id,
      revision: scheme.revision,
      surface: surface === "play" ? "playPrompts" : "authorPrompts",
    };
    expect(receipt).toMatchObject({
      error: {
        code: "prompt_role_order_unsupported",
        details: { orchestration },
      },
    });
    if (surface !== "revision") {
      expect(receipt).toMatchObject({
        error: { details: { orchestration: { entryId: "late-system" } } },
      });
    } else {
      expect(receipt).not.toMatchObject({
        error: { details: { orchestration: { entryId: expect.anything() } } },
      });
    }

    // The failure points to the scheme used for the request even after the
    // workspace applies a different scheme.
    await runtime(page, { type: "play.select", presetId: decoy.id });
    await viewOrchestration(page).click();
    await expect(page).toHaveURL(
      new RegExp(`/#/orchestrations/${scheme.id}(?:[/?#]|$)`, "u"),
    );
    await expect(
      page.getByRole("tab", {
        name: surface === "play" ? "游玩" : "设定完善",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    const list = page.getByRole("list", { name: "提示词顺序", exact: true });
    await expect(list).toBeVisible();
    await expect(page.getByText(orderRule, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "AI 编辑", exact: true }),
    ).toBeVisible();
    if (surface === "revision") {
      await expect(list.getByRole("button", { pressed: true })).toHaveCount(0);
    } else {
      const late = list.getByRole("button", {
        name: "Late harbor rule",
        exact: true,
      });
      await expect(late).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("textbox", { name: "提示词正文", exact: true }),
      ).toHaveValue("The harbor keeper writes in the ledger.");
      await late.press("Alt+ArrowUp");
      await expect(list.getByRole("button").nth(-2)).toHaveText(
        "Late harbor rule",
      );
      if (surface === "play") {
        await page
          .locator("summary")
          .filter({ hasText: /^发送给 AI 的内容预览$/u })
          .click();
        const preview = page.getByRole("region", {
          name: "编排预览",
          exact: true,
        });
        await expect(preview.getByRole("status")).toHaveText(
          "协议顺序检查 · 顺序检查通过 · google_interactions",
        );
        const button = (name: string) =>
          page.getByRole("button", { name, exact: true });
        await button("保存修改").click();
        await expect(button("保存修改")).toBeDisabled();
        await button("应用为当前编排方案").click();
        await expect(
          page.getByText(
            "已应用此编排方案；游玩修改将在下一次正常发送时生效。",
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        expect(
          (
            await runtime<FileNativePlayPresetLibrary>(page, {
              type: "play.read",
            })
          ).currentPresetId,
        ).toBe(scheme.id);
      }
    }
    expect(providerCalls).toEqual([]);
  });

  test(`${surface}: provider error text alone cannot route to orchestration`, async ({
    page,
  }) => {
    rejectAtProvider = true;
    await configure(page, "chat_completions");
    const target = await openSurface(page, surface);
    await send(page, surface, "Read the harbor ledger.", true);
    await expect(
      page
        .getByText(
          surface === "play" ? "模型请求可以重新发送" : "上一次操作未完成",
        )
        .first(),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe(target.hash);
    expect(providerCalls).toEqual(["/v1/chat/completions"]);
    await expect(viewOrchestration(page)).toHaveCount(0);
    await expect(page.getByText(orderRule, { exact: true })).toHaveCount(0);
  });
}

function reply(call: number) {
  return `Fixture settled response ${call}.`;
}

function viewOrchestration(page: Page) {
  return page.getByRole("button", { name: "查看编排", exact: true });
}

function browserCommand(request: Request): V1Request | undefined {
  if (request.method() !== "POST" || !request.url().endsWith("/api/runtime/v1"))
    return undefined;
  return (request.postDataJSON() as { request?: V1Request } | null)?.request;
}

function isSend(
  command: V1Request | undefined,
  surface: Surface,
  text: string,
) {
  if (surface === "play")
    return (
      (command?.type === "play.chain.start" ||
        command?.type === "play.chain.append") &&
      command.playerText === text
    );
  const commandType =
    surface === "revision"
      ? "world.revision.message"
      : "setting-improvement.message";
  return command?.type === commandType && command.message === text;
}

function input(page: Page, surface: Surface) {
  return surface === "play"
    ? page.getByLabel("你的行动", { exact: true })
    : page.locator("#setting-conversation-input");
}

async function send(
  page: Page,
  surface: Surface,
  text: string,
  fresh: boolean,
) {
  const pending = page.waitForResponse((response) =>
    isSend(browserCommand(response.request()), surface, text),
  );
  await input(page, surface).fill(text);
  await page
    .getByRole("button", {
      name:
        surface === "play"
          ? fresh
            ? "从全新上下文发送行动"
            : "追加行动"
          : "发送",
      exact: true,
    })
    .click();
  const response = await pending;
  const command = browserCommand(response.request());
  expect(command).toMatchObject(
    surface === "play"
      ? { type: fresh ? "play.chain.start" : "play.chain.append" }
      : {
          continuation: { kind: fresh ? "fresh_context" : "continue_context" },
        },
  );
  await expect(input(page, surface)).toBeEnabled();
  return response;
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

async function configure(
  page: Page,
  model: "chat_completions" | "anthropic_messages" | "google_interactions",
) {
  const { activeConnectionId } = await runtime<ModelConnectionLibraryView>(
    page,
    {
      type: "model.save",
      connection: {
        name: model,
        presetId: "custom",
        provider: model,
        baseUrl: providerUrl,
        apiKey: "fixture",
        modelId: model,
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    },
  );
  if (activeConnectionId === null) throw new Error("Missing active connection");
  return activeConnectionId;
}

async function selectConnection(page: Page, connectionId: string) {
  await runtime(page, { type: "model.select", connectionId });
}

function createScheme(page: Page, name: string) {
  return runtime<{ preset: FileNativePlayPresetView }>(page, {
    type: "play.create",
    name,
  });
}

async function createOrderConflict(page: Page, surface: Surface) {
  const { preset } = await createScheme(page, "Scheme used by the request");
  const key = surface === "play" ? "playPrompts" : "authorPrompts";
  const prompts = preset.structure?.[key];
  if (!prompts) throw new Error(`Missing ${key}`);
  const reader = {
    id: "harbor-reader",
    kind: "user",
    name: "Harbor reader",
    enabled: true,
    messageRole: "user",
    body: "Read the harbor ledger.",
  };
  const lateSystem = {
    id: "late-system",
    kind: "user",
    name: "Late harbor rule",
    enabled: true,
    messageRole: "system",
    body: "The harbor keeper writes in the ledger.",
  };
  await runtime(page, {
    type: "play.save",
    presetId: preset.id,
    name: preset.name,
    files: preset.files,
    structure: {
      ...preset.structure,
      [key]: [
        ...prompts,
        reader,
        ...(surface === "revision" ? [] : [lateSystem]),
      ],
    },
  });
  await runtime(page, { type: "play.select", presetId: preset.id });
  const { presets } = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const applied = presets.find(({ id }) => id === preset.id);
  if (applied === undefined) throw new Error("Missing applied scheme");
  return applied;
}

interface SurfaceTarget {
  hash: string;
  packageId: string;
  worldId: string;
}

async function openSurface(
  page: Page,
  surface: Surface,
): Promise<SurfaceTarget> {
  const { localId: packageId } = await runtime<{ localId: string }>(page, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
  const {
    world: { worldId },
  } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    packageId,
    operationId: crypto.randomUUID(),
  });
  const hash =
    surface === "setting" ? `#/content/${packageId}` : `#/world/${worldId}`;
  await page.goto(`/${hash}`);
  if (surface === "revision") {
    await page.getByRole("button", { name: "世界", exact: true }).click();
    await page
      .getByRole("button", { name: "修订当前世界", exact: true })
      .click();
  }
  await expect(input(page, surface)).toBeEnabled();
  return { hash, packageId, worldId };
}

async function readFiles(
  page: Page,
  surface: Exclude<Surface, "play">,
  { packageId, worldId }: SurfaceTarget,
) {
  if (surface === "setting")
    return (
      await runtime<{ files: ContentTreeFile[] }>(page, {
        type: "content.read",
        packageId,
      })
    ).files;
  return (
    await runtime<V1WorldRevisionOverview>(page, {
      type: "world.revision.overview",
      worldId,
    })
  ).epoch!.files;
}

async function saveWork(page: Page, surface: Exclude<Surface, "play">) {
  const controls = page.getByRole("navigation", {
    name: surface === "setting" ? "设定完善工具" : "世界修订工具",
  });
  await controls.getByRole("button", { name: "编辑", exact: true }).click();
  const rail = page.getByRole("complementary", {
    name: surface === "setting" ? "内容包文件编辑" : "世界修订文件编辑",
  });
  await rail
    .getByRole("button", { name: `打开 ${savedWorkPath}`, exact: true })
    .click();
  const editor = rail.locator(".content-source-editor textarea");
  await editor.fill(`${await editor.inputValue()}\n\n${savedWorkMarker}\n`);
  await rail
    .getByRole("button", {
      name: surface === "setting" ? "整批保存" : "保存到修订",
      exact: true,
    })
    .click();
  await expect(page.locator(".setting-workspace-feedback")).toContainText(
    surface === "setting"
      ? "内容包当前树已整批保存"
      : "手动修改已保存到修订工作树",
  );
  await page.getByRole("button", { name: "收起文件面板", exact: true }).click();
}
