import { expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import type {
  ContentTreeFile,
  V1PlayTimelinePage,
  V1Request,
  V1SettingImprovementOverview,
} from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "original-content-package" });

const idea =
  "Create a playable package about a night tram apprentice offered a ticket dated tomorrow.";
const offer = "Will you take the ticket to the closed North Gate?";
const opening = `You are the night tram apprentice at the last stop. Inspector Mara holds out a punched ticket dated tomorrow. “${offer}”`;
const editedOpening = `${opening}\n\nShe keeps the ticket pinched between two fingers.`;
const clue = "The reverse carries a watermark of a three-toothed key.";
const action = "Yes, but let me see the reverse of the ticket first.";
const reply =
  "Mara turns the ticket without letting go. A three-toothed key shows against the tram lamp.";
const authorReply = "The opening, immediate situation, and ticket are ready.";
const ticketPath = "world/items/tomorrow-ticket.yaml";
const ticketRef = "@tomorrow-ticket";
const situationPath = "world/current-situation.yaml";
const hostRulesPath = "control/blocks/world.md";

interface ProviderMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
}

interface ProviderRequest {
  messages: ProviderMessage[];
}

const tool = (name: string, arguments_: object) => ({ name, arguments_ });
function toolResponse(tools: ReturnType<typeof tool>[], step: number) {
  return [
    {
      tool_calls: tools.map(({ name, arguments_ }, index) => ({
        index,
        id: `fixture-${step}-${index}`,
        type: "function",
        function: { name, arguments: JSON.stringify(arguments_) },
      })),
    },
    "tool_calls",
  ] as const;
}

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

test("a one-sentence idea becomes an editable package and a first played turn after a retry", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const responses = [
    toolResponse(
      [
        tool("setting_read", { path: "opening.md" }),
        tool("setting_read", { path: situationPath }),
        tool("setting_read", { path: hostRulesPath }),
      ],
      1,
    ),
    toolResponse(
      [
        tool("setting_write_file", { path: "opening.md", contents: opening }),
        tool("setting_create", {
          path: ticketPath,
          ref: ticketRef.slice(1),
          title: "Tomorrow's punched ticket",
          summary: "A physical ticket offered to the night tram apprentice.",
          aliases: [],
          body: `date: tomorrow\nheld_by: Inspector Mara\nclue: ${clue}\n`,
        }),
        tool("setting_write_file", {
          path: situationPath,
          contents: [
            "location: The last stop of the night tram",
            "present: [The night tram apprentice, Inspector Mara]",
            "pending_offer:",
            "  speaker: Inspector Mara",
            `  words: "${offer}"`,
            `  offered_ticket: { $ref: "${ticketRef}" }`,
            "",
          ].join("\n"),
        }),
        tool("setting_write_file", {
          path: hostRulesPath,
          contents:
            "# The night tram\n\nLet the apprentice question tram workers, examine objects, and decide which errands to accept. Play the city's mysteries through those choices.",
        }),
      ],
      2,
    ),
    null,
    [{ content: authorReply }, "stop"],
    toolResponse([tool("context_read", { ref: ticketRef })], 5),
    [{ content: reply }, "stop"],
  ] as const;
  const requests: string[] = [];
  const provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const next = responses[requests.length];
      requests.push(body);
      if (next === undefined || next === null) {
        response
          .writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Fixture unavailable" } }));
        return;
      }
      const [delta, finishReason] = next;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
            "data: [DONE]\n\n",
        );
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  try {
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing Provider port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const workspace = () =>
      runtime<{
        contentPackages: { localId: string }[];
        worlds: { worldId: string }[];
        model: { configured: boolean };
      }>(page, { type: "workspace.read" });
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await expect(workspace()).resolves.toMatchObject({
      contentPackages: [],
      worlds: [],
      model: { configured: false },
    });

    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption("en");
    await button("Create content package").click();
    await page
      .getByRole("dialog", { name: "Create content package" })
      .getByRole("button", { name: "Create", exact: true })
      .click();
    const freshInput = page.getByLabel("Message the model in a fresh context");
    await expect(freshInput).toBeDisabled();
    const packageUrl = page.url();
    const packageId = (await workspace()).contentPackages[0]!.localId;
    expect(new URL(packageUrl).hash).toBe(`#/content/${packageId}`);
    const readPackage = () =>
      runtime<{
        status: string;
        issues: unknown[];
        treeRevision: string;
        files: ContentTreeFile[];
      }>(page, { type: "content.read", packageId });
    const conversation = () =>
      runtime<V1SettingImprovementOverview>(page, {
        type: "setting-improvement.overview",
        packageId,
      });

    await button("Configure model").click();
    await expect(page).toHaveURL(/#\/models$/u);
    await page
      .getByLabel("Configuration name", { exact: true })
      .fill("Seed fixture");
    await page.getByLabel("Base URL", { exact: true }).fill(baseUrl);
    await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
    await page.getByLabel("Model ID", { exact: true }).fill("fixture-model");
    await button("Save and enable model connection").click();
    await expect
      .poll(async () => (await workspace()).model.configured)
      .toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(packageUrl);
    await expect(
      page.getByRole("heading", {
        name: "You can start with a one-sentence story idea",
      }),
    ).toBeVisible();
    await expect(freshInput).toBeEnabled();
    expect(requests).toHaveLength(0);

    await freshInput.fill(idea);
    await button("Send").click();
    const retry = button("Resend request");
    await expect(retry).toBeEnabled();
    expect(requests).toHaveLength(3);
    const authoring = JSON.parse(requests[0]!) as ProviderRequest;
    expect(authoring.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: idea }),
    );
    const interrupted = (await conversation()).latest;
    expect(interrupted).toMatchObject({
      runStatus: "interrupted",
      turns: [{ user: { text: idea } }],
    });
    const beforeRetry = await readPackage();
    expect(beforeRetry).toMatchObject({ status: "usable", issues: [] });
    expect(beforeRetry.files).toEqual(
      expect.arrayContaining([
        { path: "opening.md", contents: opening },
        {
          path: ticketPath,
          contents: expect.stringContaining(
            `date: tomorrow\nheld_by: Inspector Mara\nclue: ${clue}`,
          ),
        },
        { path: situationPath, contents: expect.stringContaining(offer) },
      ]),
    );

    await page.reload();
    await expect(page).toHaveURL(packageUrl);
    await expect(retry).toBeEnabled();
    expect(requests).toHaveLength(3);
    await retry.click();
    await expect(page.getByText(authorReply, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(4);
    expect(requests[3]).toBe(requests[2]);
    const { latest, history } = await conversation();
    expect(history).toHaveLength(1);
    expect(latest).toMatchObject({
      sessionId: interrupted?.sessionId,
      runStatus: "ready",
      turns: [{ user: { text: idea } }],
    });
    const calls = latest?.turns.flatMap(({ exchanges }) =>
      exchanges.flatMap(({ toolCalls }) => toolCalls),
    );
    expect(calls).toHaveLength(7);
    for (const call of calls ?? []) expect(call.result?.isError).toBe(false);
    expect(await readPackage()).toEqual(beforeRetry);

    const tools = page.getByRole("navigation", {
      name: "Setting-improvement tools",
    });
    await tools.getByRole("button", { name: "Files", exact: true }).click();
    const preview = page.getByRole("complementary", {
      name: "Content-package file preview",
    });
    await preview
      .getByRole("button", { name: "opening.md", exact: false })
      .click();
    await expect(preview.getByText(opening, { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Edit this file" }).click();
    const editor = page.getByRole("textbox", {
      name: "Edit opening.md",
      exact: true,
    });
    await expect(editor).toHaveValue(opening);
    await editor.fill(editedOpening);
    const createWorld = tools.getByRole("button", {
      name: "Create world",
      exact: true,
    });
    await expect(createWorld).toBeDisabled();
    await button("Save all changes").click();
    await expect(
      page.getByText("Current tree saved", { exact: true }),
    ).toBeVisible();
    await button("Close file panel").click();
    await createWorld.click();

    const story = page.getByRole("article", { name: "Story timeline" });
    await expect(story.getByText(opening, { exact: true })).toBeVisible();
    await expect(
      story.getByText("She keeps the ticket pinched between two fingers.", {
        exact: true,
      }),
    ).toBeVisible();
    const { contentPackages, worlds } = await workspace();
    expect(contentPackages.map(({ localId }) => localId)).toEqual([packageId]);
    expect(worlds).toHaveLength(1);
    const worldId = worlds[0]!.worldId;
    expect(new URL(page.url()).hash).toBe(`#/world/${worldId}`);
    const readWorld = () =>
      runtime<{ head: string; playTimeline: V1PlayTimelinePage }>(page, {
        type: "world.read",
        worldId,
      });
    const firstView = await readWorld();
    expect(firstView.head).toBe("genesis");
    expect(firstView.playTimeline.items).toMatchObject([
      { kind: "genesis", exactText: editedOpening },
    ]);
    expect(requests).toHaveLength(4);

    await page.getByLabel("Your action").fill(action);
    await button("Send action from a fresh context").click();
    await expect(story.getByText(reply, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(6);
    const { messages } = JSON.parse(requests[4]!) as ProviderRequest;
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining(action),
      }),
    );
    const materials = messages.map(({ content }) => content ?? "").join("\n");
    expect(materials).toContain("Opening already seen by the player");
    expect(materials.split(editedOpening)).toHaveLength(2);
    expect(materials).toMatch(
      /pending_offer:[\s\S]*speaker: Inspector Mara[\s\S]*offered_ticket:/u,
    );
    expect(materials).toContain(ticketRef);
    const continuation = JSON.parse(requests[5]!) as ProviderRequest;
    expect(continuation.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "fixture-5-0",
        content: expect.stringContaining(clue),
      }),
    );

    await page.reload();
    await expect(story.getByText(reply, { exact: true })).toBeVisible();
    const { playTimeline } = await readWorld();
    expect(
      playTimeline.items.filter(
        (item) => item.kind === "event" && item.event.kind === "player",
      ),
    ).toMatchObject([{ event: { text: action } }]);
    expect(
      playTimeline.items.filter(
        (item) =>
          item.kind === "event" &&
          item.event.kind === "assistant" &&
          item.event.responseKind === "narrative",
      ),
    ).toMatchObject([{ event: { text: reply, status: "completed" } }]);
    expect((await workspace()).worlds.map((world) => world.worldId)).toEqual([
      worldId,
    ]);
    expect(requests).toHaveLength(6);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
