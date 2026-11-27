import { expect, type Page } from "@playwright/test";

import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "file-workspace-audit" });

const pierPath = "locations/pier.yaml";
const otherPierPath = "locations/other-pier.yaml";
const markdownPath = "rules/gates.md";
const pierTitle = 'Pier: "Lantern"';
const pierSource = `$document:
  id: locations.pier
  ref: lantern-pier
  title: 'Pier: "Lantern"' # private title comment
  summary: >-
    A two-line
    summary.
  aliases: [Lantern Landing]
conditions:
  sky: clear
  tide: null
crew:
  - name: Jo
    duty: |-
      Watch the gate
      until dusk.
  - name: Min
empty: []
`;
const markdownSource = `---
$document: {id: rules.gates, ref: guild-gates, title: Guild Gates, summary: A short description, aliases: []}
---
# Guild Gates

## Hours

The **doors** close at dusk.
`;
const damagedPath = "locations/damaged.yaml";
const damagedSource = "$document: [incomplete\r\n  open: [";
const legacySource = "# Old Charter\r\n\r\nLegacy rules.  \r\n";
const framePath = "control/frame.yaml";

test("world documents show the body and preserve the exact source on demand (#433)", async ({
  page,
}) => {
  const { worldId } = await seed(page);
  let stateReads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type !== "world.surface.read" || request.surface !== "state") {
      await route.continue();
      return;
    }
    stateReads++;
    const response = await route.fetch();
    const body = (await response.json()) as { result: ContentTreeFile[] };
    body.result.push(
      { path: damagedPath, contents: damagedSource },
      { path: "rules/old-charter.md", contents: legacySource },
    );
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/#/world/${worldId}`);
  await expect(page.getByLabel("Your action")).toBeVisible();
  expect(stateReads).toBe(0);
  await page.getByRole("button", { name: "Worlds", exact: true }).click();
  const rail = page.locator(".world-overlay-rail-right");
  const chooser = rail.getByRole("button", { name: /^Choose document/u });
  const choose = async (query: string, path: string) => {
    await chooser.click();
    await rail.getByRole("searchbox").fill(query);
    const option = rail.getByRole("option").filter({ hasText: path });
    await expect(option).toBeVisible();
    await option.click();
  };
  await expect.poll(() => stateReads).toBe(1);
  await choose("A two-line summary.", pierPath);
  const card = rail.locator("article");
  await expect(card).toContainText("conditions");
  await expect(card).toContainText("tide");
  await expect(card).toContainText("null");
  await expect(card).toContainText("until dusk.");
  await expect(card.locator(".world-document-details pre")).toHaveCount(0);
  await card.getByText("Document identity", { exact: true }).click();
  await expect(card.getByText("@lantern-pier", { exact: true })).toBeVisible();
  await card.getByText("Original source", { exact: true }).click();
  expect(await card.locator(".world-document-details pre").textContent()).toBe(
    pierSource,
  );
  await choose("@guild-gates", markdownPath);
  await expect(card.getByRole("heading", { name: "Hours" })).toBeVisible();
  await expect(card.locator("strong", { hasText: /^doors$/u })).toBeVisible();
  await expect(card.getByText("$document:", { exact: false })).toBeHidden();
  await choose("damaged", damagedPath);
  expect(await card.locator("pre").textContent()).toBe(damagedSource);
  await choose("old-charter", "rules/old-charter.md");
  expect(await card.locator("pre").textContent()).toBe(legacySource);
  await choose("@lantern-pier", pierPath);
  await chooser.press("Enter");
  await page.keyboard.press("Escape");
  await expect(chooser).toBeFocused();
  await expect(rail).toHaveAttribute("aria-hidden", "false");
  await card.getByRole("button", { name: "Revise", exact: true }).click();
  await page
    .getByRole("navigation", { name: "World-revision tools" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: `Edit state/${pierPath}` }),
  ).toHaveValue(pierSource);
});

test("the file workbench shows titles and protects single-file deletion (#436)", async ({
  page,
}) => {
  const { packageId, worldId } = await seed(page);
  await page.goto(`/#/content/${packageId}`);
  const panel = await openPackageFiles(page);
  const file = (path: string) =>
    panel.getByRole("button", { name: `Open ${path}`, exact: true });
  const source = (path: string) =>
    panel.getByRole("textbox", { name: `Edit ${path}`, exact: true });
  const first = `world/${pierPath}`;
  const second = `world/${otherPierPath}`;
  await expect(file(first)).toContainText(pierTitle);
  await expect(file(second)).toContainText(pierTitle);
  await expect(file(first)).toContainText(first);
  await expect(file(second)).toContainText(second);
  await file(first).click();
  await expect(
    panel.getByRole("heading", { name: pierTitle, exact: true }),
  ).toBeVisible();
  const metadata = panel.getByRole("group", {
    name: "Document metadata",
    exact: true,
  });
  await expect(metadata).toBeHidden();
  const changed = pierSource.replace("sky: clear", "sky: overcast");
  await panel.getByRole("button", { name: "Source", exact: true }).click();
  await expect(source(first)).toBeFocused();
  await source(first).fill(changed);
  await file(second).click();
  await source(second).fill("incomplete: [");
  await expect(
    panel.getByRole("heading", { name: "other-pier.yaml", exact: true }),
  ).toBeVisible();
  const remove = panel.getByRole("button", {
    name: "Delete file",
    exact: true,
  });
  await remove.click();
  const confirm = page.getByRole("dialog", { name: /other-pier\.yaml/u });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(source(second)).toHaveValue("incomplete: [");
  await expect(remove).toBeFocused();
  await remove.click();
  await confirm
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await expect(file(second)).toHaveCount(0);
  await file(first).click();
  await expect(source(first)).toHaveValue(changed);
  const save = panel.getByRole("button", {
    name: "Save all changes",
    exact: true,
  });
  await source(first).scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await save.click();
  await expect(
    panel.getByText("Current tree saved", { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/world/${worldId}`);
  await page.getByRole("button", { name: "Worlds", exact: true }).click();
  await page
    .getByRole("button", { name: "Revise current world", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "World-revision tools" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const revision = page.getByRole("complementary", {
    name: "Edit world-revision files",
  });
  const picker = revision.getByRole("combobox", {
    name: "Choose a file to edit",
  });
  const revisionSource = revision.getByRole("textbox", {
    name: `Edit state/${pierPath}`,
  });
  await picker.selectOption(`state/${pierPath}`);
  await expect(picker.locator("option:checked")).toHaveText(
    `${pierTitle} · state/${pierPath}`,
  );
  await revisionSource.fill(changed);
  await picker.selectOption(`state/${otherPierPath}`);
  await revision
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /other-pier\.yaml/u })
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await picker.selectOption(`state/${pierPath}`);
  await expect(revisionSource).toHaveValue(changed);
  const saveRevision = revision.getByRole("button", {
    name: "Save to revision",
    exact: true,
  });
  await revisionSource.scrollIntoViewIfNeeded();
  await expect(saveRevision).toBeInViewport();
  await saveRevision.click();
  await expect(
    revision.getByText("Revision worktree saved", { exact: true }),
  ).toBeVisible();
  const beforeApply = await runtime<ContentTreeFile[]>(page, {
    type: "world.surface.read",
    worldId,
    surface: "state",
  });
  expect(beforeApply).toContainEqual({ path: pierPath, contents: pierSource });
  expect(beforeApply.some(({ path }) => path === otherPierPath)).toBe(true);
  await revision
    .getByRole("button", { name: "Close file panel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply and unlock", exact: true })
    .click();
  await expect(page.locator(".world-feedback.status")).toContainText(
    "The world revision was applied and unlocked",
  );
  const applied = await runtime<ContentTreeFile[]>(page, {
    type: "world.surface.read",
    worldId,
    surface: "state",
  });
  expect(applied).toContainEqual({ path: pierPath, contents: changed });
  expect(applied.some(({ path }) => path === otherPierPath)).toBe(false);
});

test("frame materials lead with their source and explain limits and roles on demand (#437)", async ({
  page,
}) => {
  const { packageId } = await seed(page);
  await page.goto(`/#/content/${packageId}`);
  const panel = await openPackageFiles(page);
  await panel
    .getByRole("button", { name: `Open ${framePath}`, exact: true })
    .click();
  const form = panel.getByRole("region", { name: "World prompt frame" });
  const slot = form.locator(".world-frame-slot-card").filter({
    has: page.getByRole("combobox", { name: "Document 2", exact: true }),
  });
  await expect(
    slot.getByRole("combobox", { name: "Document 2", exact: true }),
  ).toHaveValue("@lantern-pier");
  await expect(
    slot.getByRole("combobox", { name: "Choose YAML node (slot 2)" }),
  ).toBeVisible();
  const limit = slot.getByRole("spinbutton", {
    name: "Advisory size (UTF-8 bytes, optional)",
  });
  await expect(limit).toBeHidden();
  await slot.getByText("Advisory size · 420 bytes", { exact: true }).click();
  await expect(limit).toHaveValue("420");
  await limit.fill("777");
  const help = form.getByText("Compilation roles and ordering", {
    exact: true,
  });
  await expect(
    form.getByText("author_instruction", { exact: true }),
  ).toBeHidden();
  await help.click();
  await expect(
    form.getByText("author_instruction", { exact: true }),
  ).toBeVisible();
  await expect(form.getByText("world_context", { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    form.getByRole("textbox", { name: `Edit ${framePath}`, exact: true }),
  ).toHaveValue(/advisoryBytes: 777/u);
  await form.getByRole("button", { name: "Form", exact: true }).click();
  await expect(
    slot.getByText("Advisory size · 777 bytes", { exact: true }),
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: "Remove material 1", exact: true }),
  ).toBeDisabled();
  await expect(
    form.getByRole("button", { name: "Remove material 3", exact: true }),
  ).toBeDisabled();
  await slot
    .getByRole("button", { name: "Move material 2 down", exact: true })
    .press("Enter");
  const moved = form.getByRole("combobox", { name: "Document 3", exact: true });
  await expect(moved).toHaveValue("@lantern-pier");
  await expect(
    form.getByText("Advisory size · 777 bytes", { exact: true }),
  ).toBeVisible();
  await form.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    form.getByRole("textbox", { name: `Edit ${framePath}`, exact: true }),
  ).toHaveValue(
    /kind: additional_materials[\s\S]+kind: node[\s\S]+advisoryBytes: 777/u,
  );
});

async function openPackageFiles(page: Page) {
  await page
    .getByRole("navigation", { name: "Setting-improvement tools" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  return page.getByRole("complementary", {
    name: "Content-package file editing",
  });
}

async function seed(page: Page) {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "File audit",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "audit-fixture",
      modelId: "audit-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { files, treeRevision } = await runtime<{
    files: ContentTreeFile[];
    treeRevision: string;
  }>(page, { type: "content.read", packageId: localId });
  const { status } = await runtime<{ status: string }>(page, {
    type: "content.replace",
    packageId: localId,
    baseTreeRevision: treeRevision,
    files: [
      ...files.filter(({ path }) => path !== framePath),
      { path: `world/${pierPath}`, contents: pierSource },
      {
        path: `world/${otherPierPath}`,
        contents: pierSource
          .replace("locations.pier", "locations.other-pier")
          .replace("lantern-pier", "second-pier"),
      },
      { path: `world/${markdownPath}`, contents: markdownSource },
      {
        path: framePath,
        contents: `format: narraeon.world-frame/v1
bindings: { currentSituation: "@current-situation" }
instructions: []
context:
  - slot: { kind: current_situation }
  - slot:
      kind: node
      id: sky-slot
      document: "@lantern-pier"
      locator: { yaml: [conditions, sky] }
      advisoryBytes: 420
  - slot: { kind: additional_materials }
`,
      },
    ],
  });
  expect(status).toBe("usable");
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: `audit-${localId}`,
    packageId: localId,
  });
  return { packageId: localId, worldId: world.worldId };
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
