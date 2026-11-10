import { expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { test } from "../support/isolatedRuntimeTest.ts";
import type { V1PlayCallChainView, V1Request } from "../../src/protocol/v1.ts";

type ProviderStep =
  | { kind: "reject" | "disconnect" | "context_limit" }
  | { kind: "text"; text: string };
let provider: Server;
let providerUrl = "";
const steps: ProviderStep[] = [];
const providerRequests: string[] = [];
test.use({ runtimeScope: "failure-recovery" });
test.setTimeout(120_000);
const recoveryExpect = expect.configure({ timeout: 30_000 });

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push(body);
      const step = steps.shift();
      if (step?.kind === "disconnect") {
        response.destroy();
      } else if (step?.kind === "text") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      } else {
        response.writeHead(
          step?.kind === "reject"
            ? 429
            : step?.kind === "context_limit"
              ? 400
              : 500,
          {
            "content-type": "application/json",
          },
        );
        response.end(
          JSON.stringify({
            error: {
              message:
                step?.kind === "context_limit"
                  ? "Maximum context length exceeded"
                  : "Fixture rejection before generation",
              code:
                step?.kind === "context_limit"
                  ? "context_length_exceeded"
                  : "rate_limit_exceeded",
            },
          }),
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
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

for (const locale of ["zh-CN", "en"] as const)
  test(`${locale}: wrap-up shortcut and interrupted requests preserve frozen retries`, async ({
    page,
  }) => {
    steps.length = 0;
    providerRequests.length = 0;
    const english = locale === "en";
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption(locale);
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Failure recovery fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: providerUrl,
        apiKey: "fixture-secret",
        modelId: "failure-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const package_ = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const title = `Recovery ${locale}`;
    await runtime(page, {
      type: "content.rename",
      packageId: package_.localId,
      name: title,
    });
    await runtime(page, {
      type: "content.replace",
      packageId: package_.localId,
      baseTreeRevision: (
        await runtime<{ treeRevision: string }>(page, {
          type: "content.read",
          packageId: package_.localId,
        })
      ).treeRevision,
      files: contentFiles(),
    });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: `create-recovery-${locale}`,
      packageId: package_.localId,
      model: {
        provider: "chat_completions",
        modelId: "failure-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const reopenWorld = async (): Promise<void> => {
      await page.reload();
      const open = page.getByRole("button", {
        name: english ? `Open world: ${title}` : `打开世界：${title}`,
        exact: true,
      });
      const heading = page.getByRole("heading", { name: title, exact: true });
      await recoveryExpect(open.or(heading)).toBeVisible();
      if (await open.isVisible()) await open.click();
    };
    await reopenWorld();
    const input = page.getByLabel(english ? "Your action" : "你的行动", {
      exact: true,
    });
    const shortcut = page.getByRole("button", {
      name: english ? "Wrap up here" : "在此收尾",
      exact: true,
    });
    const note = page.getByLabel(
      english ? "One-turn request text" : "本轮临时要求内容",
      { exact: true },
    );
    const wrapUp = english
      ? "Wrap up this part here, save what is needed for later, and register a checkpoint."
      : "这段就在这里收尾，保存后续需要的信息，并登记检查点。";
    await expect(note).toHaveCount(0);
    await shortcut.focus();
    await page.keyboard.press("Enter");
    await expect(note).toBeFocused();
    await expect(note).toHaveValue(wrapUp);
    expect(providerRequests).toHaveLength(0);
    await note.fill(english ? "Keep the quiet mood." : "保留安静的氛围。");
    await note.press("Escape");
    await shortcut.click();
    await shortcut.click();
    const combined = `${english ? "Keep the quiet mood." : "保留安静的氛围。"} ${wrapUp}`;
    await expect(note).toHaveValue(combined);
    await expect(note).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath(`wrap-up-${locale}-desktop.png`),
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await shortcut.focus();
    await page.keyboard.press("Space");
    await expect(note).toHaveValue(combined);
    const dock = page.locator(".world-composer-dock");
    const dockBounds = await dock.boundingBox();
    expect(dockBounds).not.toBeNull();
    expect(dockBounds!.x).toBeGreaterThanOrEqual(0);
    expect(dockBounds!.x + dockBounds!.width).toBeLessThanOrEqual(375);
    const inputBounds = await input.boundingBox();
    const shortcutBounds = await shortcut.boundingBox();
    expect(inputBounds!.width).toBeGreaterThan(80);
    expect(shortcutBounds!.x + shortcutBounds!.width).toBeLessThanOrEqual(
      inputBounds!.x,
    );
    await page.screenshot({
      path: test.info().outputPath(`wrap-up-${locale}-mobile.png`),
    });
    await page
      .getByRole("button", {
        name: english
          ? "Clear and close the one-turn request"
          : "清空并收起本轮临时要求",
      })
      .click();
    await expect(note).toHaveCount(0);
    await shortcut.click();
    await note.fill(`${wrapUp} ${english ? "End quietly." : "安静收尾。"}`);
    const sentNote = await note.inputValue();
    expect(providerRequests).toHaveLength(0);
    steps.push({ kind: "reject" });
    await input.fill("我闭上眼睛睡着了");
    await page
      .getByRole("button", {
        name: english
          ? "Send action from a fresh context"
          : "从全新上下文发送行动",
        exact: true,
      })
      .click();
    const resend = page.getByRole("button", {
      name: english ? "Resend request" : "重新发送",
      exact: true,
    });
    await recoveryExpect(resend).toBeEnabled();
    const rejectionCard = page.locator(".call-chain-failure").last();
    await recoveryExpect(rejectionCard.locator("strong")).toHaveText(
      english ? "Model request can be resent" : "模型请求可以重新发送",
    );
    await recoveryExpect(rejectionCard.locator("details")).not.toHaveAttribute(
      "open",
    );
    await recoveryExpect(rejectionCard.locator("pre")).toBeHidden();
    expect(providerRequests).toHaveLength(1);
    await expect(note).toHaveValue(sentNote);
    const wire = JSON.parse(providerRequests[0]!) as {
      messages: { role: string; content: string | null }[];
    };
    const inputTag = english ? "current_player_input" : "本轮玩家输入";
    const playerContent = `<${inputTag}>\n我闭上眼睛睡着了\n</${inputTag}>`;
    expect(
      wire.messages.filter(
        ({ role, content }) => role === "user" && content === playerContent,
      ),
    ).toHaveLength(1);
    expect(wire.messages.at(-1)!.content).toContain(
      `${english ? "Player's request for this turn: " : "玩家本轮要求："}${sentNote}`,
    );
    expect(
      wire.messages.filter((message) => message.content?.includes(wrapUp)),
    ).toHaveLength(1);
    await reopenWorld();
    await page
      .getByRole("button", {
        name: english ? "One-turn request" : "本轮临时要求",
        exact: true,
      })
      .click();
    await note.fill("This edited draft must not replace the frozen request.");
    const chainBefore = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    });
    expect(chainBefore.lastFailureKind).toBe("retryable");
    await recoveryExpect(resend).toBeEnabled();
    await input.fill("Keep this draft for later.");
    steps.push({ kind: "text", text: "Alex opens the door after the retry." });
    await resend.click();
    await recoveryExpect(
      page.getByText("Alex opens the door after the retry.", { exact: true }),
    ).toBeVisible();
    await recoveryExpect(input).toHaveValue("Keep this draft for later.");
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]).toBe(providerRequests[0]);
    await expect(note).toHaveCount(0);
    await page
      .getByRole("button", {
        name: english ? "One-turn request" : "本轮临时要求",
        exact: true,
      })
      .click();
    await expect(note).toHaveValue("");
    await note.press("Escape");
    await recoveryExpect(
      page.getByText("我闭上眼睛睡着了", { exact: true }),
    ).toHaveCount(1);
    await recoveryExpect(resend).toHaveCount(0);

    steps.push({ kind: "disconnect" });
    await input.fill("I ask what is outside.");
    await page
      .getByRole("button", {
        name: english ? "Append action" : "追加行动",
        exact: true,
      })
      .click();
    const unknownCard = page.locator(".call-chain-failure").last();
    await recoveryExpect(unknownCard.locator("strong")).toHaveText(
      english ? "Model request outcome unknown" : "模型请求结果未知",
    );
    await recoveryExpect(resend).toBeEnabled();
    await recoveryExpect(unknownCard.locator("pre")).toBeHidden();
    const unknown = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    });
    expect(unknown).toMatchObject({
      canRetry: true,
      lastFailureKind: "outcome_unknown",
    });
    await reopenWorld();
    await recoveryExpect(resend).toBeEnabled();
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests[2]).not.toContain(wrapUp);
    steps.push({ kind: "text", text: "Alex leads you into the corridor." });
    await resend.click();
    await recoveryExpect(
      page.getByText("Alex leads you into the corridor.", { exact: true }),
    ).toBeVisible();
    expect(providerRequests).toHaveLength(4);
    expect(providerRequests[3]).toBe(providerRequests[2]);
    await recoveryExpect(
      page.getByText("I ask what is outside.", { exact: true }),
    ).toHaveCount(1);
    const continued = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    });
    expect(continued.chainId).toBe(unknown.chainId);
    expect(continued.lastFailure).toBeNull();
    expect(continued.lastFailureKind).toBeUndefined();

    steps.push({ kind: "context_limit" });
    await input.fill("I ask about the corridor.");
    await page
      .getByRole("button", {
        name: english ? "Append action" : "追加行动",
        exact: true,
      })
      .click();
    const fresh = page.getByRole("button", {
      name: english ? "Continue with a fresh context" : "从全新上下文继续",
      exact: true,
    });
    await recoveryExpect(fresh).toBeEnabled();
    await recoveryExpect(resend).toHaveCount(0);
    const blocked = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    });
    expect(blocked).toMatchObject({
      canRetry: false,
      lastFailureKind: "context_limit",
    });
    await reopenWorld();
    await recoveryExpect(fresh).toBeEnabled();
    await fresh.click();
    await recoveryExpect(input).toBeFocused();
    await input.fill("I continue from the current world.");
    steps.push({ kind: "text", text: "The corridor opens into a garden." });
    await page
      .getByRole("button", {
        name: english
          ? "Send action from a fresh context"
          : "从全新上下文发送行动",
        exact: true,
      })
      .click();
    await recoveryExpect(
      page.getByText("The corridor opens into a garden.", { exact: true }),
    ).toBeVisible();
    const freshChain = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    });
    expect(freshChain.chainId).not.toBe(blocked.chainId);
    await recoveryExpect(
      page.getByText("I ask about the corridor.", { exact: true }),
    ).toHaveCount(1);
  });

test("protocol switch is temporary and restored protocol accepts changed model settings", async ({
  page,
}) => {
  steps.length = 0;
  providerRequests.length = 0;
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  const configure = (
    provider: "chat_completions" | "anthropic_messages",
    modelId: string,
  ) =>
    runtime(page, {
      type: "model.save",
      connection: {
        name: "Protocol switch fixture",
        presetId: "custom",
        provider,
        baseUrl: providerUrl,
        apiKey: "fixture-secret",
        modelId,
        reasoningEffort: "low",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
  await configure("chat_completions", "original-model");
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: package_.localId,
    name: "Protocol restoration",
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    baseTreeRevision: (
      await runtime<{ treeRevision: string }>(page, {
        type: "content.read",
        packageId: package_.localId,
      })
    ).treeRevision,
    files: contentFiles(),
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: "create-protocol-restoration",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "original-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  steps.push({
    kind: "text",
    text: "The original response remains in context.",
  });
  const initial = await runtime<V1PlayCallChainView>(page, {
    type: "play.chain.start",
    worldId: created.world.worldId,
    chainId: "protocol-restoration",
    exchangeId: "initial",
    playerText: "Begin.",
  });
  await configure("anthropic_messages", "different-protocol-model");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Open world: Protocol restoration",
      exact: true,
    })
    .click();
  const input = page.getByLabel("Your action", { exact: true });
  await input.fill("Continue with the original protocol.");
  const append = page.getByRole("button", {
    name: "Append action",
    exact: true,
  });
  await append.click();
  await recoveryExpect(
    page.getByText(
      "The selected model protocol differs from this context. Switch back to the original protocol to continue, or start a fresh context with the new protocol.",
      { exact: true },
    ),
  ).toBeVisible();
  await recoveryExpect(input).toHaveValue(
    "Continue with the original protocol.",
  );
  expect(providerRequests).toHaveLength(1);
  expect(
    await runtime(page, {
      type: "play.chain.inspect",
      worldId: created.world.worldId,
    }),
  ).toMatchObject({
    status: "ready",
    chainId: initial.chainId,
    lastFailure: null,
  });
  await configure("chat_completions", "replacement-model");
  steps.push({ kind: "text", text: "Continued after restoring the protocol." });
  await append.click();
  await recoveryExpect(
    page.getByText("Continued after restoring the protocol.", { exact: true }),
  ).toBeVisible();
  expect(providerRequests).toHaveLength(2);
  const body = JSON.parse(providerRequests[1]!) as {
    model: string;
    messages: unknown[];
  };
  expect(body.model).toBe("replacement-model");
  expect(JSON.stringify(body.messages)).toContain(
    "The original response remains in context.",
  );
  await recoveryExpect
    .poll(() =>
      runtime(page, {
        type: "play.chain.inspect",
        worldId: created.world.worldId,
      }),
    )
    .toMatchObject({ status: "ready", chainId: initial.chainId });
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  return page.evaluate(
    async ({ request: nextRequest }) => {
      const response = await fetch("/api/runtime/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "narraeon.runtime/v1",
          request: nextRequest,
        }),
      });
      const body = (await response.json()) as { result?: T; error?: unknown };
      if (!response.ok) throw new Error(JSON.stringify(body.error));
      return body.result as T;
    },
    { request },
  );
}

function contentFiles() {
  return [
    { path: "opening.md", contents: "Alex waits beside the closed door.\n" },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: Current Situation\n  summary: The dormitory door.\n  aliases: []\nSituation: Alex waits beside the door.\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents: "Keep facts consistent and do not act for the player.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
