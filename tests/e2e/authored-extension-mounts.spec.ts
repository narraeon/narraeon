import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { V1Request } from "../../src/protocol/v1.ts";
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

const mounts = [
  "story",
  "sidebar",
  "composer_above",
  "composer_below",
  "overlay",
  "debug",
] as const;
const replyText = "The innkeeper points to the road on the map.";
const laterReplyText = "The innkeeper adds a warning about the bridge.";
const lastOverlayLine = "The far end of the mountain road";

for (const locale of ["en", "zh-CN"] as const) {
  test(`authored HTML folds by item and location without moving story attachments (${locale})`, async ({
    browser,
  }) => {
    const narrow = locale === "zh-CN";
    const context = await browser.newContext({
      hasTouch: narrow,
      viewport: narrow
        ? { width: 320, height: 844 }
        : { width: 1280, height: 760 },
    });
    const page = await context.newPage();
    const activate = async (control: Locator) => {
      if (narrow) await control.tap();
      else {
        await control.focus();
        await control.press("Enter");
      }
    };
    page.setDefaultTimeout(6_000);
    const t = (en: string, zh: string) => (narrow ? zh : en);
    const root = await mkdtemp(join(tmpdir(), "narraeon-authored-mounts-"));
    const servers = new RuntimeServerPool();
    try {
      const worldId = await seedWorld(join(root, "data"));
      const port = await availableRuntimePort();
      const origin = `http://127.0.0.1:${port}`;
      await servers.start(root, port);
      await rpc(page, origin, { type: "preferences.save", locale });
      await page.goto(`${origin}/#/world/${worldId}`);

      const timeline = page.getByLabel(t("Story timeline", "故事时间线"));
      const action = page.getByLabel(t("Your action", "你的行动"));
      const atMount = (mount: (typeof mounts)[number]) =>
        page.locator(`[data-extension-mount="${mount}"]`);
      const debug = atMount("debug");
      const story = atMount("story");
      const storyGroup = groupToggle(story);
      const itemFrames = (mount: (typeof mounts)[number]) =>
        atMount(mount).locator(`iframe[title="authored_${mount}"]`);
      const before = (await rpc(page, origin, {
        type: "world.read",
        worldId,
      })) as { head: string };
      const trigger = page.getByRole("button", {
        name: t("Overlay", "浮层"),
        exact: true,
      });
      const popup = page.getByRole("dialog", { name: t("Overlay", "浮层") });
      const overlayFrame = itemFrames("overlay").first().contentFrame();
      const close = popup.getByRole("button", {
        name: t("Close", "关闭"),
        exact: true,
      });

      await expect(
        timeline.getByText(replyText, { exact: true }),
      ).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(popup).toHaveCount(0);
      await expect(
        page.locator('iframe[title="authored_overlay"]'),
      ).toHaveCount(0);
      await expect(debug).toHaveCount(0);

      const storyReply = timeline
        .locator(".call-chain-assistant")
        .filter({ hasText: replyText });
      await expect(
        storyReply
          .frameLocator('iframe[title="authored_story"]')
          .getByText("Authored story"),
      ).toHaveCount(1);
      const laterReply = timeline
        .locator(".call-chain-assistant")
        .filter({ hasText: laterReplyText });
      const storyFirst = storyReply.locator('iframe[title="authored_story"]');
      const storySecond = laterReply.locator('iframe[title="authored_story"]');
      await expect(storyGroup).toHaveCount(1);
      const controlledStories = await storyGroup.getAttribute("aria-controls");
      expect(controlledStories?.split(" ")).toHaveLength(2);
      const attachedDocument = storyFirst
        .contentFrame()
        .getByText("Authored story");
      await attachedDocument.evaluate((node) => {
        node.setAttribute("data-fold-probe", "retained");
      });
      await verifyFold(
        storyGroup,
        storyFirst,
        storySecond,
        itemToggle(laterReply),
        activate,
        async () => {
          await expect(
            storyReply.getByText(replyText, { exact: true }),
          ).toBeVisible();
          await expect(
            laterReply.getByText(laterReplyText, { exact: true }),
          ).toBeVisible();
        },
      );
      await expect(attachedDocument).toHaveAttribute(
        "data-fold-probe",
        "retained",
      );
      await expect(storyFirst).toHaveCount(1);
      await expect(storySecond).toHaveCount(1);

      const now = page.getByRole("button", {
        name: t("Now", "此刻"),
        exact: true,
      });
      await now.click();
      const sidebar = page.locator(
        '.world-overlay-rail-left [data-extension-mount="sidebar"]',
      );
      const sidebarFrames = itemFrames("sidebar");
      await expect(
        sidebar
          .locator('iframe[title="authored_sidebar"]')
          .first()
          .contentFrame()
          .getByText("Authored sidebar"),
      ).toHaveCount(1);
      await verifyFold(
        groupToggle(sidebar),
        sidebarFrames.first(),
        sidebarFrames.last(),
        itemToggle(sidebar).last(),
        activate,
        () =>
          expect(
            page.locator(".world-overlay-rail-left .player-view-card").first(),
          ).toBeVisible(),
      );
      await expect(itemToggle(laterReply)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await page
        .getByRole("button", {
          name: t("Close status panel", "收起状态栏"),
          exact: true,
        })
        .click();

      await action.fill("Mark the route in my notebook.");
      for (const mount of ["composer_above", "composer_below"] as const) {
        const group = groupToggle(atMount(mount));
        await expect(group).toHaveAttribute("aria-expanded", "false");
        await activate(group);
        const frames = itemFrames(mount);
        await verifyFold(
          group,
          frames.first(),
          frames.last(),
          itemToggle(atMount(mount)).last(),
          activate,
          async () => {
            await expect(action).toHaveValue("Mark the route in my notebook.");
            if (mount === "composer_below") {
              await expect(
                groupToggle(atMount("composer_above")),
              ).toHaveAttribute("aria-expanded", "true");
            }
          },
        );
      }
      for (const mount of ["composer_above", "composer_below"] as const) {
        await expect(groupToggle(atMount(mount))).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        await activate(groupToggle(atMount(mount)));
      }

      if (narrow) await trigger.tap();
      else {
        await trigger.focus();
        await trigger.press("Enter");
      }
      await expect(popup).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(close).toBeFocused();
      const overlayBounds = await popup.boundingBox();
      const viewport = page.viewportSize()!;
      expect(overlayBounds!.x).toBeGreaterThanOrEqual(0);
      expect(overlayBounds!.x + overlayBounds!.width).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(overlayBounds!.y + overlayBounds!.height).toBeLessThanOrEqual(
        viewport.height,
      );

      const overlayStart = overlayFrame.getByRole("button", {
        name: "Read the map",
      });
      const overlayEnd = overlayFrame.getByText(lastOverlayLine, {
        exact: true,
      });
      await expect(overlayStart).toBeInViewport();
      await expect(overlayEnd).not.toBeInViewport();
      if (narrow) {
        await overlayEnd.scrollIntoViewIfNeeded();
        await expect(overlayEnd).toBeInViewport();
        await close.tap();
      } else {
        await overlayStart.focus();
        await page.keyboard.press("PageDown");
        await expect
          .poll(() =>
            overlayEnd.evaluate(
              (node) => node.ownerDocument.documentElement.scrollTop,
            ),
          )
          .toBeGreaterThan(0);
        await page.keyboard.press("Shift+Tab");
        await expect(itemToggle(atMount("overlay")).first()).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(close).toBeFocused();
        await page.keyboard.press("Escape");
      }
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(
        page.locator('iframe[title="authored_overlay"]'),
      ).toHaveCount(2);

      await trigger.click();
      await verifyFold(
        trigger,
        itemFrames("overlay").first(),
        itemFrames("overlay").last(),
        itemToggle(atMount("overlay")).last(),
        activate,
      );
      await expect(popup).toBeVisible();
      await action.click();
      await expect(action).toBeFocused();
      await expect(popup).toHaveCount(0);
      await action.fill("Mark the route in my notebook.");
      await trigger.click();
      await expect(popup).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as Window & { narraeonAndroidBack?: () => boolean }
            ).narraeonAndroidBack?.(),
          ),
        )
        .toBe(true);
      await expect(popup).toHaveCount(0);
      await expect(action).toHaveValue("Mark the route in my notebook.");

      const readingSettings = page.getByRole("button", {
        name: t("Reading settings", "阅读设置"),
        exact: true,
      });
      const technical = page.getByRole("checkbox", {
        name: t("Show technical information", "显示技术信息"),
        exact: true,
      });
      await readingSettings.click();
      await technical.check();
      await expect(
        timeline
          .locator('[data-extension-mount="debug"]')
          .locator('iframe[title="authored_debug"]')
          .first()
          .contentFrame()
          .getByText("Authored debug"),
      ).toHaveCount(1);
      await expect(
        timeline.getByRole("region", {
          name: t("Artifact debugger", "产物调试器"),
        }),
      ).toBeVisible();
      await readingSettings.click();
      const artifactDebugger = timeline.getByRole("region", {
        name: t("Artifact debugger", "产物调试器"),
      });
      await verifyFold(
        groupToggle(debug),
        itemFrames("debug").first(),
        itemFrames("debug").last(),
        itemToggle(debug).last(),
        activate,
        () => expect(artifactDebugger).toBeVisible(),
      );
      await readingSettings.click();
      await technical.uncheck();
      await expect(debug).toHaveCount(0);
      await expect(
        timeline.getByRole("region", {
          name: t("Artifact debugger", "产物调试器"),
        }),
      ).toHaveCount(0);
      expect(
        await rpc(page, origin, { type: "world.read", worldId }),
      ).toMatchObject({ head: before.head });
    } finally {
      await context.close();
      await servers.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function groupToggle(mount: Locator) {
  return mount.locator(":scope > .artifact-extension-group-toggle");
}

function itemToggle(mount: Locator) {
  return mount.locator(".artifact-extension-item-toggle");
}

async function verifyFold(
  group: Locator,
  first: Locator,
  second: Locator,
  secondToggle: Locator,
  activate: (control: Locator) => Promise<void>,
  verifyUnrelatedContent?: () => Promise<void>,
): Promise<void> {
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await activate(secondToggle);
  await expect(secondToggle).toHaveAttribute("aria-expanded", "false");
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
  await activate(group);
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(first).toBeHidden();
  await expect(second).toBeHidden();
  await verifyUnrelatedContent?.();
  await activate(group);
  await expect(first).toBeVisible();
  await expect(secondToggle).toHaveAttribute("aria-expanded", "false");
  await expect(second).toBeHidden();
}

async function seedWorld(dataRoot: string) {
  const worlds = new FileNativeWorldStore(dataRoot);
  const sample = sampleContentPackageForLocale("en");
  const files = legacyDefaultPlayPresetFilesForLocale("en");
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
  const { world } = await worlds.createFromContentPackage({
    operationId: "seed-authored-mounts",
    sourcePackageId: "authored-mounts",
    sourcePackageTitle: "Authored mounts",
    packageFiles: [
      ...sample.files.filter(({ path }) => path !== "control/followups.yaml"),
      {
        path: "control/prompts/authored-mount.md",
        contents: "Fill the configured panel.",
      },
      {
        path: "control/followups.yaml",
        contents: stringify({
          format: "narraeon.package-followups/v1",
          followups: mounts.map((mount) => ({
            id: `authored-${mount}`,
            displayName: `Authored ${mount}`,
            enabled: true,
            mount,
            prompt: {
              role: "author_instruction",
              markdown: "prompts/authored-mount.md",
            },
            artifacts: [
              {
                name: `authored_${mount}`,
                channel: `authored.${mount}`,
                strategy: "append",
                displayName: `Authored panel ${mount}`,
                contentType: "text/html",
                save: "commit",
                invalidation: "explicit_clear",
              },
            ],
            maxArtifactBytes: 32768,
          })),
        }),
      },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    undefined,
    new FileNativeArtifactStore(dataRoot),
  );
  for (const [index, narration] of [replyText, laterReplyText].entries()) {
    const chain = await chains.start({
      worldId: world.worldId,
      chainId: `authored-mounts-${index}`,
      exchangeId: `authored-turn-${index}`,
      playerText: "I ask how to reach the mountain road.",
      hostBinding: presetHostBinding(preset),
      playPreset: preset,
      modelBinding: archiveModelBinding,
      modelHost: new ScriptedModelHost({
        binding: archiveModelBinding,
        steps: [
          { outcome: "response", text: narration },
          ...mounts.map((mount) => ({
            outcome: "response" as const,
            toolCalls: [
              {
                id: `emit-${mount}`,
                name: "artifact_emit",
                arguments: {
                  output: `authored_${mount}`,
                  payload:
                    mount === "overlay" && index === 0
                      ? `<button type="button">Read the map</button>${Array.from({ length: 36 }, (_, index) => `<p>Landmark ${index + 1}</p>`).join("")}<p>${lastOverlayLine}</p>`
                      : `<p>Authored ${mount}</p>`,
                },
              },
            ],
          })),
        ],
      }),
    });
    expect(chain.status).toBe("ready");
  }
  return world.worldId;
}

async function rpc(
  page: Page,
  origin: string,
  request: V1Request,
): Promise<unknown> {
  const response = await page.request.post(`${origin}/api/runtime/v1`, {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: unknown }).result;
}
