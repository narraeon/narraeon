import { expect, type Page, type Request, type Route } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { test } from "../support/isolatedRuntimeTest.ts";
import type { V1PlayCallChainView, V1Request } from "../../src/protocol/v1.ts";

test.use({ runtimeScope: "play-sync-recovery" });
let provider: Server;
let providerUrl = "";
let heldResponse: ServerResponse | null = null;
let hold = false;
let rejectModel = false;
let providerCalls = 0;

function finish(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "The committed reply is visible." } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
  );
}

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
      } else if (hold) heldResponse = response;
      else finish(response);
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing provider port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  heldResponse?.destroy();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(async ({ page }) => {
  hold = false;
  rejectModel = false;
  providerCalls = 0;
  heldResponse = null;
  await page.addInitScript(() => {
    const sources: EventSource[] = [];
    const opened = new WeakSet<EventSource>();
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, configuration?: EventSourceInit) {
        super(url, configuration);
        sources.push(this);
        this.addEventListener("open", () => opened.add(this));
      }
    };
    Object.assign(window, {
      isPlayObservationReady: () =>
        sources.some(
          (source) =>
            source.url.includes("kind=play") &&
            source.readyState === EventSource.OPEN &&
            opened.has(source),
        ),
      interruptPlayObservation: (terminal: boolean) => {
        for (const source of sources) {
          if (
            !source.url.includes("kind=play") ||
            source.readyState === EventSource.CLOSED
          )
            continue;
          if (terminal) source.close();
          for (let index = 0; index < 3; index++)
            source.dispatchEvent(new Event("error"));
        }
      },
    });
  });
});

test("a committed action survives a lost response without a second write", async ({
  page,
}) => {
  const worldId = await prepareWorld(page, "Lost play receipt");
  let writes = 0;
  let committedExchange = "";
  await page.route("**/api/runtime/v1", async (route) => {
    const input = runtimeInput(route);
    if (input?.type !== "play.chain.start") return route.continue();
    writes++;
    const response = await route.fetch();
    const body = (await response.json()) as { result: V1PlayCallChainView };
    expect(body.result.status).toBe("ready");
    const player = body.result.events.find((event) => event.kind === "player");
    expect(player?.committedHead).toBeTruthy();
    committedExchange = input.exchangeId;
    expect(player?.kind === "player" && player.exchangeId).toBe(
      committedExchange,
    );
    await route.abort("failed");
  });
  const input = page.getByLabel("Your action", { exact: true });
  await input.fill("I open the door.");
  await page
    .getByRole("button", {
      name: "Send action from a fresh context",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("The committed reply is visible.", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(
    page.locator(".call-chain-failure, .play-call-failure"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
  expect(providerCalls).toBe(1);
  const chain = await runtime<V1PlayCallChainView>(page, {
    type: "play.chain.inspect",
    worldId,
  });
  expect(
    chain.events.filter(
      (event) =>
        event.kind === "player" && event.exchangeId === committedExchange,
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByText("The committed reply is visible.", { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test("a terminal observation failure offers a read and reconnect while generation is still running", async ({
  page,
}) => {
  const worldId = await prepareWorld(page, "Closed play observation");
  hold = true;
  const run = runtime(page, {
    type: "play.chain.start",
    worldId,
    chainId: "closed-observer",
    exchangeId: "closed-exchange",
    playerText: "Wait beside the door.",
  });
  await expect.poll(() => heldResponse !== null).toBe(true);
  await expect(
    page.getByRole("button", { name: "Cancel generation", exact: true }),
  ).toBeVisible();
  const reads = watchWorldReads(page);
  await interruptObservation(page, true);
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => reads.count).toBe(1);
  await expect(
    page.getByRole("button", { name: "Cancel generation", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".call-chain-failure, .play-call-failure"),
  ).toHaveCount(0);
  finish(heldResponse!);
  heldResponse = null;
  await run;
  await page.getByRole("button", { name: "Read again", exact: true }).click();
  await expect(
    page.getByText("The committed reply is visible.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toHaveCount(0);
  expect(providerCalls).toBe(1);
});

for (const late of ["success", "failure"] as const)
  test(`a late ${late} from an outage read cannot overwrite a newer observation`, async ({
    page,
  }) => {
    const worldId = await prepareWorld(page, `Late play ${late}`);
    hold = true;
    const run = runtime(page, {
      type: "play.chain.start",
      worldId,
      chainId: `late-${late}`,
      exchangeId: `late-${late}-exchange`,
      playerText: "Wait for the answer.",
    });
    await expect.poll(() => heldResponse !== null).toBe(true);
    await expect(
      page.getByRole("button", { name: "Cancel generation", exact: true }),
    ).toBeVisible();
    let release!: () => void;
    let captured = false;
    await page.route("**/api/runtime/v1", async (route) => {
      if (runtimeInput(route)?.type !== "world.read") return route.continue();
      if (captured) return route.continue();
      const stale = await route.fetch();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (late === "success") await route.fulfill({ response: stale });
      else await route.abort("failed");
    });
    await interruptObservation(page, false);
    await expect.poll(() => captured).toBe(true);
    finish(heldResponse!);
    heldResponse = null;
    await run;
    await expect(
      page.getByText("The committed reply is visible.", { exact: true }),
    ).toBeVisible();
    const deliveryFilter = (request: Request) =>
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request?: V1Request } | null)?.request
        ?.type === "world.read";
    const delivered =
      late === "success"
        ? page.waitForEvent("requestfinished", { predicate: deliveryFilter })
        : page.waitForEvent("requestfailed", { predicate: deliveryFilter });
    release();
    await delivered;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("button", { name: "Append action", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText("Temporarily unable to sync", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel generation", exact: true }),
    ).toHaveCount(0);
    // Stream hydration and post-fault freshness reads can overlap here.
    // The stable-stream case below separately asserts one recovery per outage.
    expect(providerCalls).toBe(1);
  });

test("repeated disconnect notices schedule one recovery while the world and stream stay unchanged", async ({
  page,
}) => {
  await prepareWorld(page, "Stable play recovery count");
  const input = page.getByLabel("Your action", { exact: true });
  await input.fill("Keep this action draft.");
  let reads = 0;
  let release!: () => void;
  let captured = false;
  await page.route("**/api/runtime/v1", async (route) => {
    if (runtimeInput(route)?.type !== "world.read") return route.continue();
    reads++;
    if (captured) return route.continue();
    const response = await route.fetch();
    captured = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await interruptObservation(page, false);
  await expect.poll(() => captured).toBe(true);
  await interruptObservation(page, false);
  const delivered = page.waitForEvent("requestfinished", {
    predicate: (request) =>
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request?: V1Request } | null)?.request
        ?.type === "world.read",
  });
  release();
  await delivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(reads).toBe(1);
  expect(providerCalls).toBe(0);
  await expect(input).toHaveValue("Keep this action draft.");
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toHaveCount(0);
});

test("initial world read failure retries once and manual recovery only reads", async ({
  page,
}) => {
  await prepareWorld(page, "Initial play read", false);
  let offline = true;
  let reads = 0;
  let writes = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const input = runtimeInput(route);
    if (input?.type === "world.read") {
      reads++;
      if (offline) return route.abort("failed");
    }
    if (
      input?.type === "play.chain.start" ||
      input?.type === "play.chain.append"
    )
      writes++;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Open world: Initial play read", exact: true })
    .click();
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(2);
  offline = false;
  await page.getByRole("button", { name: "Read again", exact: true }).click();
  await expect(page.getByLabel("Your action", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Temporarily unable to sync", { exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(3);
  expect(writes).toBe(0);
});

test("a confirmed Runtime interruption retains its supported resend action", async ({
  page,
}) => {
  await prepareWorld(page, "Interrupted play recovery");
  rejectModel = true;
  let writes = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    if (runtimeInput(route)?.type !== "play.chain.start")
      return route.continue();
    writes++;
    const response = await route.fetch();
    expect(
      ((await response.json()) as { result: V1PlayCallChainView }).result
        .status,
    ).toBe("interrupted");
    await route.abort("failed");
  });
  await page.getByLabel("Your action", { exact: true }).fill("I knock.");
  await page
    .getByRole("button", {
      name: "Send action from a fresh context",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Resend request", exact: true }),
  ).toBeEnabled();

  expect(writes).toBe(1);
  expect(providerCalls).toBe(1);
});

for (const late of ["success", "failure"] as const)
  test(`switching worlds discards a late ${late} from the previous world's recovery`, async ({
    page,
  }) => {
    const oldTitle = `Switch play ${late} old`;
    const nextTitle = `Switch play ${late} next`;
    const oldId = await prepareWorld(page, oldTitle, false);
    await prepareWorld(page, nextTitle, false);
    await page
      .getByRole("button", { name: `Open world: ${oldTitle}`, exact: true })
      .click();
    await expect(page.getByLabel("Your action", { exact: true })).toBeVisible();
    let release!: () => void;
    let captured = false;
    await page.route("**/api/runtime/v1", async (route) => {
      const request = runtimeInput(route);
      if (request?.type !== "world.read" || request.worldId !== oldId)
        return route.continue();
      const stale = await route.fetch();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (late === "success") await route.fulfill({ response: stale });
      else await route.abort("failed");
    });
    await interruptObservation(page, false);
    await expect.poll(() => captured).toBe(true);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page
      .getByRole("button", { name: `Open world: ${nextTitle}`, exact: true })
      .click();
    const input = page.getByLabel("Your action", { exact: true });
    await input.fill("Keep the new world's draft.");
    const deliveryFilter = (request: Request) => {
      if (!request.url().endsWith("/api/runtime/v1")) return false;
      const input = (request.postDataJSON() as { request?: V1Request } | null)
        ?.request;
      return input?.type === "world.read" && input.worldId === oldId;
    };
    const delivered =
      late === "success"
        ? page.waitForEvent("requestfinished", { predicate: deliveryFilter })
        : page.waitForEvent("requestfailed", { predicate: deliveryFilter });
    release();
    await delivered;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("heading", { name: nextTitle, exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("Keep the new world's draft.");
    await expect(
      page.getByText("Temporarily unable to sync", { exact: true }),
    ).toHaveCount(0);
  });

test("a recovery read cancels a newer same-chain invocation while SSE remains unavailable", async ({
  page,
}) => {
  const worldId = await prepareWorld(page, "Authoritative play cancellation");
  hold = true;
  const first = runtime(page, {
    type: "play.chain.start",
    worldId,
    chainId: "shared-running-context",
    exchangeId: "first-invocation",
    playerText: "Wait beside the door.",
  });
  await expect.poll(() => heldResponse !== null).toBe(true);
  await expect(
    page.getByRole("button", { name: "Cancel generation", exact: true }),
  ).toBeVisible();
  await interruptObservation(page, true);
  await expect(
    page.getByRole("button", { name: "Read again", exact: true }),
  ).toBeVisible();
  finish(heldResponse!);
  heldResponse = null;
  await first;
  const next = runtime(page, {
    type: "play.chain.append",
    worldId,
    chainId: "shared-running-context",
    exchangeId: "peer-invocation",
    playerText: "A newer action from another page.",
  });
  await expect.poll(() => heldResponse !== null).toBe(true);
  await page.route("**/api/runtime/v1/events?**", (route) =>
    route.abort("failed"),
  );
  let cancelledExchange = "";
  await page.route("**/api/runtime/v1", async (route) => {
    const input = runtimeInput(route);
    if (input?.type === "play.chain.cancel") {
      cancelledExchange = input.exchangeId;
      const response = await route.fetch();
      expect(
        ((await response.json()) as { result: { outcome: string } }).result
          .outcome,
      ).toBe("cancellation_requested");
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Read again", exact: true }).click();
  await expect(
    page.getByText("A newer action from another page.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel generation", exact: true })
    .click();
  await next;
  expect(cancelledExchange).toBe("peer-invocation");
  expect(providerCalls).toBe(2);
  heldResponse = null;
});

function runtimeInput(route: Route): V1Request | undefined {
  return (route.request().postDataJSON() as { request?: V1Request } | null)
    ?.request;
}

async function interruptObservation(
  page: Page,
  terminal: boolean,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { isPlayObservationReady(): boolean }
        ).isPlayObservationReady(),
      ),
    )
    .toBe(true);
  await page.evaluate((closed) => {
    (
      window as unknown as { interruptPlayObservation(terminal: boolean): void }
    ).interruptPlayObservation(closed);
  }, terminal);
}

function watchWorldReads(page: Page) {
  const reads = { count: 0 };
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request?: V1Request } | null)?.request
        ?.type === "world.read"
    )
      reads.count++;
  });
  return reads;
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

async function prepareWorld(
  page: Page,
  title: string,
  open = true,
): Promise<string> {
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Play sync fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-secret",
      modelId: "sync-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const package_ = await runtime<{ localId: string; treeRevision: string }>(
    page,
    { type: "content.create" },
  );
  await runtime(page, {
    type: "content.rename",
    packageId: package_.localId,
    name: title,
  });
  const current = await runtime<{ treeRevision: string }>(page, {
    type: "content.read",
    packageId: package_.localId,
  });
  await runtime(page, {
    type: "content.replace",
    packageId: package_.localId,
    baseTreeRevision: current.treeRevision,
    files: [
      { path: "opening.md", contents: "Alex waits beside the closed door.\n" },
      {
        path: "world/current-situation.yaml",
        contents:
          "$document:\n  id: situation.current\n  ref: current-situation\n  title: Current Situation\n  summary: The door.\n  aliases: []\nSituation: Alex waits.\n",
      },
      {
        path: "control/frame.yaml",
        contents:
          "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
      },
      { path: "control/blocks/world.md", contents: "Keep facts consistent.\n" },
      {
        path: "control/player-views.yaml",
        contents: "format: narraeon.player-views/v1\nviews: []\n",
      },
    ],
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: `create-${title.toLowerCase().replaceAll(" ", "-")}`,
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "sync-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  await page.reload();
  if (open)
    await page
      .getByRole("button", { name: `Open world: ${title}`, exact: true })
      .click();
  return created.world.worldId;
}
