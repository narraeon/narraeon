// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Gameplay } from "../../src/protocol/gameplay.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { CreateWorldScreen } from "../../src/web/CreateWorldScreen.tsx";
import { HomeScreen } from "../../src/web/HomeScreen.tsx";
import { PromptPreviewScreen } from "../../src/web/PromptPreviewScreen.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

const tabletopD20: Gameplay = { mode: "tabletop", scheme: "d20" };
const tabletopBag: Gameplay = { mode: "tabletop", scheme: "bag" };
const fiction: Gameplay = { mode: "interactive-fiction" };

describe("玩法标签", () => {
  test("主页的内容包卡片与世界卡片显示玩法标签", () => {
    render(
      createElement(HomeScreen, {
        contentPackages: [
          {
            localId: "package-tabletop",
            title: "雾港来信",
            status: "usable" as const,
            gameplay: tabletopD20,
          },
          {
            localId: "package-fiction",
            title: "旧塔草稿",
            status: "usable" as const,
            gameplay: fiction,
          },
        ],
        worlds: [
          { worldId: "world-1", title: "雾港第一夜", gameplay: tabletopBag },
        ],
        selectedPackageId: "package-tabletop",
        modelConfigured: true,
        activeModelName: null,
        currentPresetName: null,
        importArchive: null,
        importPending: false,
        onImportArchiveChange: vi.fn(),
        onCreateWorld: vi.fn(),
        onCreatePackage: vi.fn(),
        onImportPackage: vi.fn(),
        onOpenPackage: vi.fn(),
        onRenamePackage: vi.fn(),
        onDeletePackage: vi.fn(),
        onOpenWorld: vi.fn(),
        onRenameWorld: vi.fn(),
        onDeleteWorld: vi.fn(),
      }),
    );

    expect(
      within(
        screen.getByRole("button", { name: "打开内容包：雾港来信" }),
      ).getByText("跑团 · d20"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("button", { name: "打开内容包：旧塔草稿" }),
      ).getByText("互动式小说"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("button", { name: "打开世界：雾港第一夜" }),
      ).getByText("跑团 · 混乱袋"),
    ).toBeTruthy();
  });

  test("新建世界的内容包选项与开场预览都显示玩法标签", async () => {
    const client = {
      request: <T = unknown>() =>
        Promise.resolve({
          files: [{ path: "opening.md", contents: "雾起" }],
        } as T),
    };
    render(
      createElement(CreateWorldScreen, {
        client,
        packages: [
          {
            localId: "package-tabletop",
            title: "雾港来信",
            status: "usable" as const,
            gameplay: tabletopD20,
          },
          {
            localId: "package-fiction",
            title: "旧塔草稿",
            status: "usable" as const,
            gameplay: fiction,
          },
        ],
        selectedId: "package-tabletop",
        pending: false,
        modelConfigured: true,
        onSelect: vi.fn(),
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onConfigureModel: vi.fn(),
      }),
    );

    const select = screen.getByRole("combobox", { name: "创建世界的内容包" });
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["雾港来信 · 跑团 · d20", "旧塔草稿 · 互动式小说"]);
    await waitFor(() => expect(screen.getByText("雾起")).toBeTruthy());
    const preview = screen.getByRole("article", { name: "开场白预览" });
    expect(within(preview).getByText("跑团 · d20")).toBeTruthy();
  });

  test("提示词预览在所选内容包旁显示它的玩法", () => {
    const requests: V1Request[] = [];
    render(
      createElement(PromptPreviewScreen, {
        client: {
          request<T = unknown>(request: V1Request): Promise<T> {
            requests.push(request);
            return Promise.resolve({} as T);
          },
        },
        packages: [
          {
            localId: "package-tabletop",
            title: "雾港来信",
            status: "usable" as const,
            gameplay: tabletopD20,
          },
          {
            localId: "package-fiction",
            title: "旧塔草稿",
            status: "usable" as const,
            gameplay: fiction,
          },
        ],
        initialPackageId: "package-tabletop",
        model: {
          configured: false,
          activeConnectionId: null,
          connections: [],
          presets: [],
        },
        onPackageSelect: vi.fn(),
      }),
    );

    expect(screen.getByText("跑团 · d20")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("预览内容包"), {
      target: { value: "package-fiction" },
    });
    expect(screen.getByText("互动式小说")).toBeTruthy();
    expect(screen.queryByText("跑团 · d20")).toBeNull();
    expect(requests).toEqual([]);
  });
});
