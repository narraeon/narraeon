import { expect } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "prompt-preview-inputs" });

test("prompt preview labels and inputs are clickable at desktop, compact and mobile widths", async ({
  page,
}) => {
  async function runtime<T = unknown>(request: V1Request): Promise<T> {
    const response = await page.request.post("/api/runtime/v1", {
      data: { protocol: "narraeon.runtime/v1", request },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { result: T }).result;
  }

  await runtime({ type: "preferences.save", locale: "en" });
  const first = await runtime<{ localId: string }>({ type: "content.create" });
  const second = await runtime<{ localId: string }>({ type: "content.create" });
  for (const index of [1, 2]) {
    await runtime({
      type: "model.save",
      connection: {
        name: `Preview connection ${index}`,
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        authMode: "none",
        modelId: `preview-model-${index}`,
        contextWindowTokens: 64_000,
        maxOutputTokens: 4_096,
      },
    });
  }

  await page.goto("/#/preview");
  const player = page.getByRole("textbox", {
    name: "Preview player input",
    exact: true,
  });
  const note = page.getByRole("textbox", {
    name: "One-turn request",
    exact: true,
  });
  const packageSelect = page.getByRole("combobox", {
    name: "Content package to preview",
  });
  const result = page.getByRole("heading", { name: "Compilation passed" });
  await packageSelect.selectOption(first.localId);

  async function compile(expectedRequest: Record<string, unknown>) {
    const [request] = await Promise.all([
      page.waitForRequest((request) => {
        if (!request.url().endsWith("/api/runtime/v1")) return false;
        const payload = request.postDataJSON() as { request: V1Request } | null;
        return payload?.request.type === "prompt.preview";
      }),
      page.getByRole("button", { name: "Generate real preview" }).click(),
    ]);
    const payload = request.postDataJSON() as { request: V1Request };
    expect(payload.request).toMatchObject(expectedRequest);
    await expect(result).toBeVisible();
  }

  for (const width of [1440, 960, 640]) {
    await page.setViewportSize({ width, height: 900 });
    const playerBox = await player.boundingBox();
    const noteBox = await note.boundingBox();
    expect(playerBox).not.toBeNull();
    expect(noteBox!.y).toBeGreaterThan(playerBox!.y + playerBox!.height);

    await player.locator("..").click({ position: { x: 8, y: 8 } });
    await expect(player).toBeFocused();
    await player.click({ position: { x: 12, y: 10 } });
    const playerInput = `I inspect the lamp at ${width}.`;
    await player.fill(playerInput);
    await expect(result).toHaveCount(0);

    await note.locator("..").click({ position: { x: 8, y: 8 } });
    await expect(note).toBeFocused();
    await note.click();
    const turnNote = `Use the color blue at ${width}.`;
    await note.fill(turnNote);
    await expect(player).toHaveValue(playerInput);
    await expect(note).toHaveValue(turnNote);
    await compile({
      packageId: first.localId,
      playerInput,
      turnNote,
      model: { modelId: "preview-model-2" },
    });
    await expect(page.getByText(playerInput, { exact: true })).toBeVisible();
  }

  await note.fill("Ask only one question.");
  await expect(result).toHaveCount(0);
  await compile({ turnNote: "Ask only one question." });
  await packageSelect.selectOption(second.localId);
  await expect(result).toHaveCount(0);
  await compile({ packageId: second.localId });
  await page
    .getByRole("button", { name: "Quick switch model connection" })
    .click();
  await page
    .getByRole("menuitemradio", { name: /Preview connection 1/u })
    .click();
  await expect(result).toHaveCount(0);
  await compile({
    packageId: second.localId,
    model: { modelId: "preview-model-1" },
  });
});
