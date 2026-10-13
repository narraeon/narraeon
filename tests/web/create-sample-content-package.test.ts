// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  appLocales,
  defaultAppReadingPreferences,
} from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";
import { App } from "../../src/web/App.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(cleanup);

test.each(appLocales)(
  "sample entry uses the current UI locale (%s), blocks duplicates and selects the new package",
  async (locale) => {
    const sample = sampleContentPackageForLocale(locale);
    const pending = Promise.withResolvers<{ localId: string }>();
    const packages = [
      { localId: "existing", title: "Other package", status: "usable" },
    ];
    const request = vi.fn(async (input: V1Request): Promise<unknown> => {
      await Promise.resolve();
      if (input.type === "workspace.read")
        return {
          preferences: { locale, reading: defaultAppReadingPreferences },
          contentPackages: [...packages],
          playPresets: { currentPresetId: "", presets: [] },
          worlds: [],
          storageNotices: [],
          model: {
            configured: false,
            activeConnectionId: null,
            connections: [],
            presets: [],
          },
        };
      if (input.type === "content.create-sample") {
        const created = await pending.promise;
        packages.push({
          localId: created.localId,
          title: sample.title,
          status: "usable",
        });
        return created;
      }
      if (input.type === "content.read") {
        expect(input.packageId).toBe("sample-new");
        return { files: sample.files };
      }
      throw new Error(`Unexpected request: ${input.type}`);
    });
    const { container } = render(
      createElement(App, { client: { request } as unknown as RuntimeClient }),
    );
    const button = await screen.findByRole("button", {
      name: locale === "zh-CN" ? "从示例新建" : "Create from sample",
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(
      request.mock.calls.filter(
        ([input]) => input.type === "content.create-sample",
      ),
    ).toEqual([[{ type: "content.create-sample", locale }]]);
    expect(
      screen
        .getByRole("button", {
          name: locale === "zh-CN" ? "返回工作区" : "Back to workspace",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    pending.resolve({ localId: "sample-new" });
    await waitFor(() =>
      expect(
        container
          .querySelector(".workspace-shell")
          ?.getAttribute("data-screen"),
      ).toBe("create"),
    );
    const select = screen.getByLabelText<HTMLSelectElement>(
      locale === "zh-CN"
        ? "创建世界的内容包"
        : "Content package for the new world",
    );
    expect(select.value).toBe("sample-new");
    await waitFor(() =>
      expect(
        screen.getByLabelText(
          locale === "zh-CN" ? "开场白预览" : "Opening preview",
        ).textContent,
      ).toContain(
        sample.files.find(({ path }) => path === "opening.md")!.contents.trim(),
      ),
    );
  },
);

test("a failed sample request reports the error and lets the player retry from the empty workspace", async () => {
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    await Promise.resolve();
    if (input.type === "workspace.read")
      return {
        preferences: { locale: "zh-CN", reading: defaultAppReadingPreferences },
        contentPackages: [],
        worlds: [],
        playPresets: { currentPresetId: "", presets: [] },
        storageNotices: [],
        model: {
          configured: false,
          activeConnectionId: null,
          connections: [],
          presets: [],
        },
      };
    throw new Error("Could not save sample");
  });
  render(
    createElement(App, { client: { request } as unknown as RuntimeClient }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "从示例开始" }));
  expect(await screen.findByText("Could not save sample")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "从示例开始" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "从示例开始" }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(
        ([input]) => input.type === "content.create-sample",
      ),
    ).toHaveLength(2),
  );
});
