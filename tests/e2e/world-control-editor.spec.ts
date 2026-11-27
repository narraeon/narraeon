import { createServer } from "node:http";
import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { parse } from "yaml";
import { appLocales } from "../../src/protocol/appPreferences.ts";
import { gameplayFile, gameplayPath } from "../../src/protocol/gameplay.ts";
import type {
  ContentTreeFile,
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";
import {
  rawControlFile,
  selectControlFile,
} from "../support/worldControlEditor.ts";

const framePath = "control/frame.yaml";
const viewPath = "control/player-views.yaml";
const keptPath = "control/blocks/kept.md";
const removedPath = "control/blocks/retired.md";
const addedPath = "control/blocks/new-note.md";
const gameplay = { mode: "tabletop", scheme: "d20" } as const;
const files = [
  { path: "opening.md", contents: "The ferry waits at the quay.\n" },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: scene.harbor
  ref: current-situation
  title: Harbor
  summary: The scene at the harbor.
  aliases: []
background: The ferry is waiting.
`,
  },
  {
    path: "world/ledger.yaml",
    contents: `$document:
  id: ledger.harbor
  ref: ledger
  title: Ledger
  summary: Conditions at the harbor.
  aliases: []
conditions:
  weather: World rain
  harbor: World gate open
`,
  },
  {
    path: "world/almanac.md",
    contents: `---
$document:
  id: notes.almanac
  ref: almanac
  title: Almanac
  summary: Notes for the crossing.
  aliases: []
---

# Almanac

## Crossing

Under the old arch.

### Landing

Use the far steps.

## Beyond

Neighboring paragraph stays hidden.
`,
  },
  {
    path: framePath,
    contents: `# Keep this frame comment
format: narraeon.world-frame/v1
bindings: { currentSituation: "@current-situation" }
instructions: []
context:
  - slot: { kind: current_situation }
  - slot: { kind: node, document: "@ledger", locator: { yaml: [conditions, weather] } }
  - slot: { kind: additional_materials }
`,
  },
  {
    path: viewPath,
    contents: `# Keep this player view comment
format: narraeon.player-views/v1
views:
  - id: harbor
    title: Harbor board
    items:
      - id: conditions
        label: Conditions
        select:
          document: "@ledger"
          locator: { yaml: [conditions, weather] }
`,
  },
  gameplayFile(gameplay),
  { path: keptPath, contents: "# Keep these exact contents\n\n  \n" },
  { path: removedPath, contents: "# No longer needed\n" },
];

test.use({ runtimeScope: "world-control-editor", actionTimeout: 10_000 });

for (const locale of appLocales) {
  test(`advanced world control edits both forms against the current state (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const mobile = locale === "zh-CN";
    const width = mobile ? 390 : 1280;
    const t = (zh: string, en: string) => (mobile ? zh : en);
    const button = (scope: Locator | Page, zh: string, en: string) =>
      scope.getByRole("button", { name: t(zh, en), exact: true });
    const requests: V1Request[] = [];
    const providerBodies: string[] = [];
    const releaseModel = Promise.withResolvers<void>();
    const provider = createServer((request, response) => {
      request.setEncoding("utf8");
      let text = "";
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        providerBodies.push(text);
        void releaseModel.promise.then(() => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "The ferry comes alongside." } }] })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("The test model has no HTTP port");

    try {
      await runtime(page, { type: "preferences.save", locale });
      await runtime(page, {
        type: "model.save",
        connection: {
          name: "World control fixture",
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "control-editor-fixture",
          modelId: "control-editor-fixture",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8_192,
        },
      });
      const { localId } = await runtime<{ localId: string }>(page, {
        type: "content.create",
        gameplay,
      });
      const replacePackage = async (next: ContentTreeFile[]) => {
        const { treeRevision } = await runtime<{ treeRevision: string }>(page, {
          type: "content.read",
          packageId: localId,
        });
        await runtime(page, {
          type: "content.replace",
          packageId: localId,
          baseTreeRevision: treeRevision,
          files: next,
        });
      };
      await replacePackage(files);
      const {
        world: { worldId },
      } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId: localId,
      });
      await replacePackage(
        files.map((file) => ({
          ...file,
          contents: file.contents
            .replace("World rain", "Package snow")
            .replace("Use the far steps.", "Package steps moved."),
        })),
      );

      const readHead = async () =>
        (await runtime<{ head: string }>(page, { type: "world.read", worldId }))
          .head;
      const readSurface = (surface: "control" | "state") =>
        runtime<ContentTreeFile[]>(page, {
          type: "world.surface.read",
          worldId,
          surface,
        });
      const baseState = await readSurface("state");
      const baseControl = await readSurface("control");
      const worldUrl = `/#/world/${worldId}`;
      await page.setViewportSize({ width, height: mobile ? 844 : 950 });
      page.on("request", (request) => {
        const payload = runtimeRequest(request);
        if (payload !== undefined) requests.push(payload);
      });
      await page.goto(worldUrl);
      const story = page.getByLabel(t("故事时间线", "Story timeline"));
      await expect(story).toContainText("The ferry waits at the quay.");
      await button(page, "世界管理", "World management").click();
      const dialog = page.getByRole("dialog", {
        name: t("世界管理", "World management"),
      });
      const advanced = dialog.getByText(
        t("世界控制 · 高级编辑", "World control · Advanced editor"),
        { exact: true },
      );
      const controlPicker = dialog.getByRole("combobox", {
        name: t("选择控制文件", "Choose control file"),
      });
      await expect(advanced).toBeVisible();
      await expect(controlPicker).toBeHidden();
      const surfaces = () =>
        requests.flatMap((request) =>
          request.type === "world.surface.read" ? [request.surface] : [],
        );
      await expect.poll(surfaces).toContain("runtime");
      expect(surfaces()).not.toContain("state");
      expect(surfaces()).not.toContain("control");
      await advanced.click();

      await selectControlFile(dialog, framePath, locale);
      const frame = dialog.getByRole("region", {
        name: t("世界提示框架", "World prompt frame"),
      });
      const frameDocument = frame.getByRole("combobox", {
        name: t("文档 2", "Document 2"),
        exact: true,
      });
      const yamlNode = frame.getByRole("combobox", {
        name: t("选择 YAML 节点（插槽 2）", "Choose YAML node (slot 2)"),
      });
      await expect(yamlNode.locator("option:checked")).toHaveText(
        "conditions › weather · World rain",
      );
      expect(surfaces()).toEqual(expect.arrayContaining(["state", "control"]));
      await frameDocument.selectOption("@almanac");
      const landing = { markdown: ["Crossing", "Landing"] };
      const heading = frame.getByRole("combobox", {
        name: t(
          "选择 Markdown 标题（插槽 2）",
          "Choose Markdown heading (slot 2)",
        ),
      });
      await heading.selectOption(JSON.stringify(landing));
      await expect(heading.locator("option:checked")).toHaveText(
        "Crossing › Landing",
      );

      await selectControlFile(dialog, viewPath, locale);
      const view = dialog.getByRole("region", {
        name: t("玩家视图编辑", "Player view editor"),
      });
      const draftPreview = dialog.getByRole("region", {
        name: t("玩家视图草稿预览", "Player view draft preview"),
      });
      await expect(draftPreview).toContainText("World rain");
      const items = view
        .getByRole("list", {
          name: t("显示项", "Display items"),
        })
        .getByRole("listitem");
      const scope = (item: Locator) =>
        item.getByRole("combobox", { name: t("显示范围", "Show") });
      await scope(items.first()).selectOption(
        JSON.stringify({ yaml: ["conditions", "harbor"] }),
      );
      await button(view, "新增显示项", "Add display item").click();
      const newItem = items.last();
      await newItem
        .getByRole("textbox", {
          name: t("显示名称", "Display label"),
        })
        .fill("Landing note");
      await newItem
        .getByRole("combobox", {
          name: t("来源文档", "Source document"),
        })
        .selectOption("@almanac");
      await scope(newItem).selectOption(JSON.stringify(landing));
      await expect(draftPreview).toContainText("World gate open");
      await expect(draftPreview).toContainText("Use the far steps.");
      await expect(draftPreview).not.toContainText("Neighboring paragraph");
      if (mobile) {
        await expect
          .poll(async () => {
            const bounds = await draftPreview.boundingBox();
            return bounds === null
              ? Infinity
              : Math.max(-bounds.x, bounds.x + bounds.width - width);
          })
          .toBeLessThanOrEqual(0);
      }

      await button(view, "源码", "Source").click();
      const viewSource = rawControlFile(view, viewPath, locale);
      const repaired = await viewSource.inputValue();
      expect(repaired).toContain("# Keep this player view comment");
      await viewSource.fill("views: [broken\n");
      await expect(button(view, "表单", "Form")).toBeDisabled();
      await viewSource.fill(repaired);
      await button(view, "表单", "Form").click();
      await expect(draftPreview).toContainText("Landing note");

      await selectControlFile(dialog, gameplayPath, locale);
      await expect(
        rawControlFile(dialog, gameplayPath, locale),
      ).toHaveJSProperty("readOnly", true);
      await expect(rawControlFile(dialog, gameplayPath, locale)).toHaveValue(
        gameplayFile(gameplay).contents,
      );
      const enabledDelete = dialog.getByRole("button", {
        name: t("删除文件", "Delete file"),
        exact: true,
        disabled: false,
      });
      await expect(enabledDelete).toHaveCount(0);
      await selectControlFile(dialog, removedPath, locale);
      await enabledDelete.click();
      const removeDialog = page.getByRole("dialog", {
        name: t(
          `从当前草稿删除 ${removedPath}？`,
          `Delete ${removedPath} from the current draft?`,
        ),
      });
      await expect(removeDialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(enabledDelete).toBeFocused();
      await expect(
        controlPicker.locator(`option[value="${removedPath}"]`),
      ).toHaveCount(1);
      await enabledDelete.click();
      await button(removeDialog, "删除文件", "Delete file").click();
      await expect(
        controlPicker.locator(`option[value="${removedPath}"]`),
      ).toHaveCount(0);
      await dialog
        .getByText(t("新建文件", "Create file"), { exact: true })
        .click();
      await dialog.getByLabel(t("新文件路径", "New file path")).fill(addedPath);
      await button(dialog, "加入草稿", "Add to draft").click();
      await selectControlFile(dialog, addedPath, locale);
      await rawControlFile(dialog, addedPath, locale).fill(
        "# Added from the world editor\n",
      );

      const apply = button(
        dialog,
        "整批应用世界控制",
        "Apply all world-control changes",
      );
      const preview = button(dialog, "预览世界控制", "Preview world control");
      await expect(apply).toBeDisabled();
      expect(controlWrites(requests)).toEqual([]);
      expect(providerBodies).toHaveLength(0);
      expect(await readHead()).toBe("genesis");
      expect(await readSurface("control")).toEqual(baseControl);

      const previewResult = page.waitForResponse(
        (response) =>
          runtimeRequest(response.request())?.type ===
          "world.control-draft.preview",
      );
      await preview.click();
      const response = await previewResult;
      expect(response.ok(), await response.text()).toBe(true);
      expect(await response.text()).toContain("Use the far steps.");
      await expect(apply).toBeEnabled();
      expect(await readHead()).toBe("genesis");
      expect(await readSurface("control")).toEqual(baseControl);
      expect(providerBodies).toHaveLength(0);

      // A saved control draft allows normal play in another tab.
      const player = await page.context().newPage();
      await player.goto(worldUrl);
      await player
        .getByLabel(t("你的行动", "Your action"))
        .fill("I step onto the ferry.");
      await button(
        player,
        "从全新上下文发送行动",
        "Send action from a fresh context",
      ).click();
      await expect.poll(() => providerBodies.length).toBe(1);
      await expect(apply).toBeDisabled();
      expect(providerBodies[0]).not.toContain("Landing");
      releaseModel.resolve();
      await expect(story).toContainText("The ferry comes alongside.");

      await preview.click();
      await expect(apply).toBeEnabled();
      await apply.click();
      await expect(
        dialog.getByText(
          t("世界控制已整批应用。", "World control was applied as a whole."),
          { exact: true },
        ),
      ).toBeVisible();
      const applied = await readSurface("control");
      const readFile = (tree: ContentTreeFile[], path: string) =>
        tree.find((file) => `control/${file.path}` === path);
      expect(readFile(applied, gameplayPath)).toEqual(
        readFile(baseControl, gameplayPath),
      );
      expect(readFile(applied, keptPath)).toEqual(
        readFile(baseControl, keptPath),
      );
      expect(readFile(applied, removedPath)).toBeUndefined();
      expect(readFile(applied, addedPath)?.contents).toBe(
        "# Added from the world editor\n",
      );
      const savedFrame = readFile(applied, framePath)?.contents ?? "";
      const savedViews = readFile(applied, viewPath)?.contents ?? "";
      expect(savedFrame).toContain("# Keep this frame comment");
      expect(parse(savedFrame)).toMatchObject({
        context: [
          { slot: { kind: "current_situation" } },
          { slot: { kind: "node", document: "@almanac", locator: landing } },
          { slot: { kind: "additional_materials" } },
        ],
      });
      expect(parse(savedViews)).toMatchObject({
        views: [
          {
            items: [
              {
                select: {
                  document: "@ledger",
                  locator: { yaml: ["conditions", "harbor"] },
                },
              },
              {
                label: "Landing note",
                select: { document: "@almanac", locator: landing },
              },
            ],
          },
        ],
      });
      expect(await readSurface("state")).toEqual(baseState);
      const revision = await runtime<V1WorldRevisionOverview>(page, {
        type: "world.revision.overview",
        worldId,
      });
      expect(revision.epoch).toBeNull();
      expect(revision.sealedEpochs).toEqual([]);
      expect(
        requests.filter(({ type }) => type.startsWith("world.revision.")),
      ).toEqual([]);
      expect(providerBodies).toHaveLength(1);
      const applies = requests.filter(
        (request) => request.type === "world.control-draft.apply",
      );
      const previews = requests.filter(
        (request) => request.type === "world.control-draft.preview",
      );
      expect(applies).toHaveLength(1);
      expect(applies[0]?.expectedFingerprint).toBeTruthy();
      expect(applies[0]?.expectedFingerprint).toBe(
        previews.at(-1)?.expectedFingerprint,
      );
    } finally {
      releaseModel.resolve();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
}

function controlWrites(requests: V1Request[]): V1Request[] {
  return requests.filter(({ type }) => type.startsWith("world.control-draft."));
}

function runtimeRequest(request: Request): V1Request | undefined {
  if (request.method() !== "POST" || !request.url().endsWith("/api/runtime/v1"))
    return undefined;
  return (request.postDataJSON() as { request: V1Request }).request;
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
