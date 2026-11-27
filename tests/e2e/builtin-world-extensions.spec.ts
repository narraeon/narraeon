import { expect, test, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appLocales,
  type AppLocale,
} from "../../src/protocol/appPreferences.ts";
import type { V1PlayCallChainView, V1Request } from "../../src/protocol/v1.ts";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { WorldArchiveDownload } from "../../src/protocol/worldArchives.ts";
import type { WorldExtensionsView } from "../../src/protocol/worldExtensions.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import {
  legacyDefaultPlayPresetFilesForLocale,
  parsePlayPresetFiles,
  presetHostBinding,
  revisionForPlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";
import { archiveModelBinding } from "../support/worldArchiveFixture.ts";

const oldNarrative = "The innkeeper has left a lantern on the counter.";
const draft = "I carry the lantern to the rain-soaked doorway.";
const optionLabel = "Carry the lantern";
const markdownNote = "目前只核对信息，尚未发送通知。";
const markdownText = `| 已核实项目 | 204 教室 | 活动室 |
|---|---|---|
| 报名人数 | 共 46 人报名 | 共 46 人报名 |
| 座位／空间 | 28 个座位，不够全员同时入座 | 共用空间，须给用餐和学习的人留桌子；尚未核实可容纳人数 |
| 时间 | 六点前领钥匙；借用至七点，只够放一场 | 尚未核实可用于放映的时段 |
| 放映限制 | 无法在现有预约内分两轮放完 | 不能大声放音，放片须戴耳机 |

${markdownNote}`;
const htmlText = "HTML fixture: the lantern is lit";
const debugText = "Debug fixture: the innkeeper moved the lantern.";
const requestsByPrompt = [
  {
    kind: "choices",
    headings: ["# 提交后下一步建议", "# Next-step ideas after the commit"],
  },
  { kind: "panels", headings: ["# 通用面板", "# Generic panels"] },
  { kind: "debug", headings: ["# 调试频道示例", "# Debug channel example"] },
] as const;

for (const locale of appLocales) {
  test(`an existing world combines built-in extensions and keeps its own choices (${locale})`, async ({
    page,
  }) => {
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    const root = await mkdtemp(join(tmpdir(), "narraeon-builtin-worlds-"));
    const servers = new RuntimeServerPool();
    const fixture = await startProvider();
    try {
      const [worldId, otherId] = await seedWorlds(join(root, "data"), locale);
      const port = await availableRuntimePort();
      const origin = `http://127.0.0.1:${port}`;
      const worldUrl = (id: string) => `${origin}/#/world/${id}`;
      const rpc = <T = unknown>(request: V1Request) =>
        runtime<T>(page, origin, request);
      const server = await servers.start(root, port);
      await rpc({ type: "preferences.save", locale });
      await page.goto(worldUrl(worldId));
      await expect(page.getByText(oldNarrative, { exact: true })).toBeVisible();
      const menu = page.locator(".world-extension-menu");
      const toggleMenu = () => menu.locator("summary").click();
      const field = (zh: string, en: string) =>
        menu.getByRole("checkbox", { name: t(zh, en), exact: true });
      const choices = field("行动选项", "Action choices");
      const panels = field("Markdown / HTML 面板", "Markdown / HTML panels");
      const debug = field("调试示例输出", "Debug example output");
      const status = field("状态栏样式", "Status panel style");
      const allToggles = [choices, panels, debug, status];
      const action = page.getByLabel(t("你的行动", "Your action"));
      const timeline = page.getByLabel(t("故事时间线", "Story timeline"));
      const rail = page.locator(".world-overlay-rail-left");
      const baseCard = rail.locator(".player-view-card");
      const place = t(
        "溪桥镇，雨灯旅店大厅",
        "Rain Lantern Inn lobby, Brookbridge",
      );
      const statusCard = rail.frameLocator(
        'iframe[title="builtin:status-panel"]',
      );
      const optionsMount = page.locator(
        '[data-extension-mount="composer_above"]',
      );
      const optionsFrame = optionsMount.frameLocator(
        'iframe[title="player_options"]',
      );
      const lanternButton = optionsFrame.getByRole("button", {
        name: optionLabel,
        exact: true,
      });
      const markdownFrame = page.frameLocator('iframe[title="markdown_panel"]');
      const markdownTable = markdownFrame.getByRole("table");
      const openRail = () =>
        page
          .getByRole("button", { name: t("此刻", "Now"), exact: true })
          .click();
      const closeRail = () =>
        page
          .getByRole("button", {
            name: t("收起状态栏", "Close status panel"),
            exact: true,
          })
          .click();
      const requestKinds = () => fixture.calls.map(({ kind }) => kind);
      const readHead = async () =>
        (await rpc<{ head: string }>({ type: "world.read", worldId })).head;

      const originalHead = await readHead();
      await toggleMenu();
      for (const item of allToggles) {
        await expect(item).toBeVisible();
        await expect(item).not.toBeChecked();
      }
      expect(await rpc({ type: "model.read" })).toMatchObject({
        configured: false,
      });
      await openRail();
      await expect(baseCard).toContainText(place);
      await closeRail();
      await setChecked(status, true);
      await openRail();
      await expect(statusCard.getByText(place, { exact: true })).toBeVisible();
      await expect(baseCard).toHaveCount(0);
      await closeRail();
      await setChecked(status, false);
      await openRail();
      await expect(baseCard).toContainText(place);
      await expect(
        rail.locator('iframe[title="builtin:status-panel"]'),
      ).toHaveCount(0);
      await closeRail();
      expect(fixture.calls).toHaveLength(0);
      expect(await readHead()).toBe(originalHead);

      await rpc({
        type: "model.save",
        connection: {
          name: "Built-in extension fixture",
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: fixture.baseUrl,
          apiKey: "local-test-only",
          modelId: "extensions-fixture",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8192,
        },
      });
      await page.reload();
      await toggleMenu();
      for (const item of allToggles) await setChecked(item, true);
      await toggleMenu();
      expect(fixture.calls).toHaveLength(0);
      expect(await readHead()).toBe(originalHead);

      const freshSend = page.getByRole("button", {
        name: t("从全新上下文发送行动", "Send action from a fresh context"),
        exact: true,
      });
      const appendSend = page.getByRole("button", {
        name: t("追加行动", "Append action"),
        exact: true,
      });
      await action.fill("I ask whether I may borrow the lantern.");
      await page.getByLabel(t("更多", "More"), { exact: true }).click();
      await page
        .getByRole("button", {
          name: t(
            "用新对话继续（保留故事进度）",
            "Continue in a new chat (keep story progress)",
          ),
          exact: true,
        })
        .click();
      await expect(
        page.getByText("Fixture narrative 1", { exact: true }),
      ).toBeVisible();
      await composerPanelToggle(page, "player_options").click();
      await expect(lanternButton).toBeVisible();
      const firstChoices = optionsFrame.getByRole("button");
      await expect(firstChoices).toHaveCount(4);
      await expect(firstChoices.last()).toBeInViewport();
      await expect
        .poll(() =>
          firstChoices.evaluateAll((choices) => ({
            buttons: choices.length,
            rows: new Set(
              choices.map((choice) => choice.getBoundingClientRect().top),
            ).size,
          })),
        )
        .toEqual({ buttons: 4, rows: 2 });
      await expect(timeline).toHaveAttribute("aria-busy", "false");
      expect(requestKinds()).toEqual(["main", "choices", "panels", "debug"]);
      const settled = await rpc<V1PlayCallChainView>({
        type: "play.chain.inspect",
        worldId,
      });
      const followups = settled.events.filter(
        (event) => event.kind === "followup",
      );
      expect(
        followups.map(({ toolCalls, failure }) => ({
          accepted: toolCalls.filter(({ ok }) => ok).length,
          failure,
        })),
      ).toEqual([
        { accepted: 1, failure: undefined },
        { accepted: 2, failure: undefined },
        { accepted: 1, failure: undefined },
      ]);

      await expect(markdownTable.getByRole("columnheader")).toHaveText([
        "已核实项目",
        "204 教室",
        "活动室",
      ]);
      await expect(markdownTable.locator("tbody tr")).toHaveCount(4);
      await expect(
        markdownTable.locator("tbody tr").last().getByRole("cell"),
      ).toHaveText([
        "放映限制",
        "无法在现有预约内分两轮放完",
        "不能大声放音，放片须戴耳机",
      ]);
      await expect(
        markdownFrame.getByText(markdownNote, { exact: true }),
      ).toBeVisible();
      await openRail();
      await expect(statusCard.getByText(place, { exact: true })).toBeVisible();
      const htmlFrame = rail.locator('iframe[title="html_panel"]');
      await expect(htmlFrame).toHaveAttribute("sandbox", "");
      await expect(
        htmlFrame.contentFrame().getByText(htmlText, { exact: true }),
      ).toBeVisible();
      await closeRail();

      await page.goto("about:blank");
      await servers.stop(server);
      await servers.start(root, port);
      await page.goto(worldUrl(worldId));
      await composerPanelToggle(page, "player_options").click();
      await expect(lanternButton).toBeVisible();
      await expect(markdownTable.locator("tbody tr")).toHaveCount(4);
      const initialViewport = page.viewportSize();
      if (locale === "zh-CN" && initialViewport !== null) {
        await page.setViewportSize({ width: 390, height: 844 });
        const narrowChoices = optionsFrame.getByRole("button");
        expect(
          await narrowChoices.evaluateAll(
            (choices) =>
              new Set(
                choices.map((choice) => choice.getBoundingClientRect().left),
              ).size,
          ),
        ).toBe(1);
        await narrowChoices.last().focus();
        await expect(narrowChoices.last()).toBeInViewport();
        await expect(
          markdownFrame.getByText(markdownNote, { exact: true }),
        ).toBeVisible();
        expect(
          await markdownTable.evaluate((table) => {
            const document = table.ownerDocument.documentElement;
            return (
              document.scrollWidth === document.clientWidth &&
              table.getBoundingClientRect().right <= document.clientWidth
            );
          }),
        ).toBe(true);
        await page.setViewportSize(initialViewport);
      }
      await toggleMenu();
      for (const item of allToggles) await expect(item).toBeChecked();
      const completedHead = await readHead();
      await setChecked(panels, false);
      await toggleMenu();
      await expect(page.locator('iframe[title="markdown_panel"]')).toHaveCount(
        0,
      );
      await expect(composerPanelToggle(page, "player_options")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await lanternButton.click();
      await expect(action).toHaveValue(draft);
      await expect(timeline.getByText(draft, { exact: true })).toHaveCount(0);
      expect(await readHead()).toBe(completedHead);
      expect(fixture.calls).toHaveLength(4);
      await appendSend.click();
      await expect(
        page.getByText("Fixture narrative 2", { exact: true }),
      ).toBeVisible();
      await expect(timeline).toHaveAttribute("aria-busy", "false");
      expect(requestKinds().slice(4)).toEqual(["main", "choices", "debug"]);
      expect(fixture.calls[4]?.body).toContain(draft);

      await page.goto(worldUrl(otherId));
      await expect(
        page.getByRole("heading", { name: "Other inn" }),
      ).toBeVisible();
      await toggleMenu();
      for (const item of allToggles) await expect(item).not.toBeChecked();
      await toggleMenu();
      await action.fill("I wait by the window in the other world.");
      await freshSend.click();
      await expect(
        page.getByText("Fixture narrative 3", { exact: true }),
      ).toBeVisible();
      await expect(timeline).toHaveAttribute("aria-busy", "false");
      expect(requestKinds().slice(7)).toEqual(["main"]);

      await page.goto(worldUrl(worldId));
      await expect(
        page.getByRole("heading", { name: "Existing inn" }),
      ).toBeVisible();
      await toggleMenu();
      for (const item of [choices, debug, status])
        await expect(item).toBeChecked();
      await expect(panels).not.toBeChecked();
      expect(fixture.calls).toHaveLength(8);
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      await servers.stopAll();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an imported story keeps its latest reply, action choices and composer accessible", async ({
  browser,
  page,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-imported-play-panels-"));
  const servers = new RuntimeServerPool();
  const latest = "Mae saw two green flashes and heard the bell three times.";
  const fixture = await startProvider(
    `I set my notebook on the counter and ask the innkeeper about the light.\n\n${latest}`,
  );
  try {
    const [sourceId, otherId] = await seedWorlds(join(root, "data"), "en");
    const port = await availableRuntimePort();
    const origin = `http://127.0.0.1:${port}`;
    const rpc = <T = unknown>(request: V1Request) =>
      runtime<T>(page, origin, request);
    await servers.start(root, port);
    await rpc({ type: "preferences.save", locale: "en" });
    await rpc({
      type: "model.save",
      connection: {
        name: "Archive choices fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: fixture.baseUrl,
        apiKey: "local-test-only",
        modelId: "extensions-fixture",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8192,
      },
    });
    const extensions = await rpc<WorldExtensionsView>({
      type: "world.extensions.read",
      worldId: sourceId,
    });
    const optionsId = "builtin:action-choices";
    const options = extensions.items.find(({ id }) => id === optionsId);
    if (options === undefined)
      throw new Error("Missing action choices fixture");
    await rpc({
      type: "world.extensions.set",
      worldId: sourceId,
      key: options.key,
      value: "on",
    });
    await rpc({
      type: "play.chain.start",
      worldId: sourceId,
      chainId: crypto.randomUUID(),
      exchangeId: crypto.randomUUID(),
      playerText: "I ask about the lighthouse.",
    });
    expect(fixture.calls.map(({ kind }) => kind)).toEqual(["main", "choices"]);
    const archive = await rpc<WorldArchiveDownload>({
      type: "world.archive.export",
      operationId: crypto.randomUUID(),
      worldId: sourceId,
    });
    const download = await page.request.get(
      `${origin}/api/runtime/v1/world-archives/${archive.archiveId}`,
    );
    expect(download.ok()).toBe(true);
    const model = await rpc<ModelConnectionLibraryView>({ type: "model.read" });
    await rpc({
      type: "model.delete",
      connectionId: model.activeConnectionId!,
    });
    await page.goto(origin);
    await page.getByLabel("World backup ZIP file").setInputFiles({
      name: archive.fileName,
      mimeType: "application/zip",
      buffer: await download.body(),
    });
    await expect(
      page.getByText(
        "World backup imported. The new world is now in your list.",
      ),
    ).toBeVisible();
    const home = await rpc<{ worlds: { worldId: string }[] }>({
      type: "workspace.read",
    });
    const worldId = home.worlds.find(
      ({ worldId }) => worldId !== sourceId && worldId !== otherId,
    )!.worldId;
    const worldUrl = `${origin}/#/world/${worldId}`;
    const decorations = await rpc<{
      artifacts: { output: string; frontend: { mount: string } }[];
    }>({ type: "world.play-decorations.read", worldId });
    const optionsMount = decorations.artifacts.find(
      ({ output }) => output === "player_options",
    )?.frontend.mount;
    expect(["composer_above", "composer_below"]).toContain(optionsMount);
    const checkLayout = async (target: Page) => {
      await target.goto(worldUrl);
      await expect(
        target.getByRole("button", { name: "Configure model", exact: true }),
      ).toBeInViewport();
      await expect(
        target.getByText(
          "World imported from backup; your next action will start a fresh context",
        ),
      ).toBeInViewport();
      await expect(target.getByText(latest, { exact: true })).toBeInViewport({
        ratio: 1,
      });
      await expect(
        composerPanelToggle(target, "player_options"),
      ).toBeInViewport();
      const size = await playLayout(target);
      expect(size.overlap).toBeLessThanOrEqual(1);
      expect(size.readerHeight).toBeGreaterThan(size.dockHeight * 2);
    };
    const checkPanelPosition = async (target: Page, minReaderHeight = 250) => {
      const action = target.getByLabel("Your action", { exact: true });
      const content = target.locator(
        `.world-composer-dock [data-extension-mount="${optionsMount}"]`,
      );
      const panelBox = (await content.boundingBox())!;
      const actionBox = (await action.boundingBox())!;
      if (optionsMount === "composer_above")
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(actionBox.y);
      else
        expect(panelBox.y).toBeGreaterThanOrEqual(
          actionBox.y + actionBox.height,
        );
      const size = await playLayout(target);
      expect(size.overlap).toBeLessThanOrEqual(1);
      expect(size.readerHeight).toBeGreaterThan(minReaderHeight);
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await checkLayout(page);
    const summary = composerPanelToggle(page, "player_options");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect(summary).toBeFocused();
    const option = page
      .frameLocator('iframe[title="player_options"]')
      .getByRole("button", { name: optionLabel });
    await expect(option).toBeInViewport();
    await expect(page.getByText(latest, { exact: true })).toBeInViewport();
    await checkPanelPosition(page);
    await page.keyboard.press("Space");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator('iframe[title="player_options"]'),
    ).not.toBeInViewport();
    await expect(page.getByText(latest, { exact: true })).toBeInViewport();
    await summary.click();
    await expect(option).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("archive-story-and-choices-desktop.png"),
    });

    await page.getByRole("button", { name: "Now", exact: true }).click();
    const rail = page.locator(".world-overlay-rail-left");
    const railBottom = async () => {
      const bounds = (await rail.boundingBox())!;
      return bounds.y + bounds.height;
    };
    const initialRailBottom = await railBottom();
    expect(initialRailBottom).toBeGreaterThanOrEqual(900 - 32);
    await page.getByLabel("More", { exact: true }).click();
    await page
      .getByRole("button", { name: "One-turn request", exact: true })
      .click();
    await expect(page.getByLabel("One-turn request text")).toBeFocused();
    expect(await railBottom()).toBe(initialRailBottom);
    const resize = rail.getByRole("separator", {
      name: "Resize the current scene panel",
    });
    const railWidth = (await rail.boundingBox())!.width;
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    expect((await rail.boundingBox())!.width).toBeGreaterThan(railWidth);

    const touch = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await checkLayout(touch);
      await composerPanelToggle(touch, "player_options").tap();
      const touchOption = touch
        .frameLocator('iframe[title="player_options"]')
        .getByRole("button", { name: optionLabel });
      await expect(touchOption).toBeInViewport();
      await expect(touch.getByText(latest, { exact: true })).toBeInViewport();
      await checkPanelPosition(touch);
      await touch.screenshot({
        path: testInfo.outputPath("archive-story-and-choices-touch.png"),
      });
      await touchOption.tap();
      const action = touch.getByLabel("Your action", { exact: true });
      await expect(action).toHaveValue(draft);
      await action.fill(`${draft} I keep my notebook open.`);
      await expect(
        touch.getByRole("button", { name: "Send action from a fresh context" }),
      ).toBeDisabled();
      await touch.setViewportSize({ width: 844, height: 390 });
      await expect(action).toBeInViewport();
      await expect(touch.getByText(latest, { exact: true })).toBeInViewport();
      await checkPanelPosition(touch, 125);
      const playStatus = touch.getByRole("button", { name: /Play status/ });
      await expect(playStatus).toHaveAttribute("aria-expanded", "false");
      await playStatus.tap();
      await expect(playStatus).toHaveAttribute("aria-expanded", "true");
      await expect(
        touch.getByRole("button", { name: "Configure model", exact: true }),
      ).toBeInViewport();
      await touch.screenshot({
        path: testInfo.outputPath("archive-story-short-touch.png"),
      });
      expect(fixture.calls).toHaveLength(2);
    } finally {
      await touch.close();
    }
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await servers.stopAll();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

function composerPanelToggle(page: Page, title: string) {
  return page
    .locator(".world-composer-dock [data-extension-mount]")
    .filter({ has: page.locator(`iframe[title="${title}"]`) })
    .locator(":scope > .artifact-extension-group-toggle");
}

async function playLayout(page: Page) {
  return page.evaluate(() => {
    const reader = document
      .querySelector(".world-reader-scroll")!
      .getBoundingClientRect();
    const dock = document
      .querySelector(".world-composer-dock")!
      .getBoundingClientRect();
    return {
      overlap: reader.bottom - dock.top,
      readerHeight: reader.height,
      dockHeight: dock.height,
    };
  });
}

async function seedWorlds(dataRoot: string, locale: AppLocale) {
  const worlds = new FileNativeWorldStore(dataRoot);
  const files = legacyDefaultPlayPresetFilesForLocale(locale);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  const preset = {
    id: "builtin-default",
    name: "default",
    revision: revisionForPlayPresetFiles(files),
    files,
    definition: parsed.definition,
    scriptsEnabled: true,
  };
  const sample = sampleContentPackageForLocale(locale);
  async function create(id: string, name: string) {
    const result = await worlds.createFromContentPackage({
      operationId: `seed-${id}`,
      sourcePackageId: "rainy-inn-fixture",
      sourcePackageTitle: name,
      packageFiles: sample.files,
    });
    if (result.outcome !== "created") throw new Error(`Could not seed ${name}`);
    return result.world.worldId;
  }

  const worldId = await create("existing-inn", "Existing inn");
  const oldChain = await new PlayCallChain(
    worlds,
    undefined,
    new FileNativeArtifactStore(dataRoot),
  ).start({
    worldId,
    chainId: "existing-inn",
    exchangeId: "historical-turn",
    playerText: "I take a seat by the counter.",
    hostBinding: presetHostBinding(preset),
    playPreset: preset,
    modelBinding: archiveModelBinding,
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: oldNarrative }],
    }),
  });
  expect(oldChain.status).toBe("ready");
  return [worldId, await create("other-inn", "Other inn")] as const;
}

async function startProvider(narrativeOverride?: string) {
  const calls: { kind: string; body: string }[] = [];
  let narrative = 0;
  const payloads = {
    choices: [
      [
        "player_options",
        [
          { id: "lantern", label: optionLabel, prompt: draft },
          { id: "rest", label: "Ask for a room", prompt: "I ask for a room." },
          {
            id: "talk",
            label: "Start a conversation",
            description: "Ask about the travellers who passed through the inn.",
            prompt: "I ask the innkeeper what they know.",
          },
          {
            id: "wait",
            label: "Wait out the rain",
            prompt: "I wait for the storm to pass.",
          },
        ],
      ],
    ],
    panels: [
      ["markdown_panel", markdownText],
      ["html_panel", `<p>${htmlText}</p>`],
    ],
    debug: [["debug_example", debugText]],
  };
  const provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const followup = requestsByPrompt.find(({ headings }) =>
        headings.some((heading) => body.includes(heading)),
      );
      calls.push({ kind: followup?.kind ?? "main", body });
      const delta =
        followup === undefined
          ? { content: narrativeOverride ?? `Fixture narrative ${++narrative}` }
          : {
              tool_calls: payloads[followup.kind].map(
                ([output, payload], index) => ({
                  index,
                  id: `fixture-output-${calls.length}-${index}`,
                  type: "function",
                  function: {
                    name: "artifact_emit",
                    arguments: JSON.stringify({ output, payload }),
                  },
                }),
              ),
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("No provider port");
  return {
    calls,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      const closed = once(provider, "close");
      provider.closeAllConnections();
      provider.close();
      await closed;
    },
  };
}

async function setChecked(locator: Locator, checked: boolean) {
  await locator.click();
  await expect(locator).toBeChecked({ checked });
  await expect(locator).toBeEnabled();
}

async function runtime<T>(
  page: Page,
  origin: string,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post(`${origin}/api/runtime/v1`, {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
