// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  act,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { InterfaceExtensionPreview } from "../../src/web/InterfaceExtensionPreview.tsx";
import type { V1Request } from "../../src/protocol/v1.ts";
import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  type FrontendPlayerViewPanelProjection,
} from "../../src/web/ArtifactExtensionHost.tsx";

afterEach(() => cleanup());

function panel(
  value: string,
  overrides: Partial<FrontendPlayerViewPanelProjection> = {},
): FrontendPlayerViewPanelProjection {
  return {
    panelId: "current",
    worldId: "world-1",
    preset: { id: "preset-1", revision: "rev-1" },
    lifecycle: "current_preset",
    source: { kind: "player_view", viewId: "status" },
    authority: "committed_player_view_projection",
    head: "head-1",
    channel: "panel.current",
    key: "current",
    contentType: "application/json",
    payload: {
      panelId: "current",
      title: "当前信息",
      viewId: "status",
      items: [{ id: "value", label: "值", value }],
      config: {
        layout: "stack",
        theme: "calm",
        empty: "message",
        emptyMessage: "暂无",
        groups: [],
      },
      diagnostics: [],
      provenance: {
        kind: "committed_player_view_projection",
        lifecycle: "current_preset",
        head: "head-1",
      },
    },
    projection: "upsert",
    diagnostics: [],
    frontend: {
      status: "ready",
      source: "player_view",
      authority: "committed_player_view_projection",
      lifecycle: "current_preset",
      preset: { id: "preset-1", revision: "rev-1" },
      mount: "sidebar",
      declaration: {
        outputName: "current",
        channel: "panel.current",
        key: "current",
        contentType: "application/json",
        projection: "upsert",
        save: "none",
        invalidation: "never",
        required: false,
        maxEmits: 1,
        rendererMode: "app",
      },
      regex: [],
      renderer: {
        mode: "app",
        revision: "v1",
        document: "<main id='root'></main>",
        scripts: [],
        assets: [],
        trustedLocalCode: true,
      },
      trustedLocalCode: true,
      fallback: "none",
    },
    ...overrides,
  };
}

function host(panels: FrontendPlayerViewPanelProjection[]) {
  return createElement(
    ArtifactExtensionHost,
    {
      worldId: "world-1",
      artifacts: [],
      playerViewPanels: panels,
      playerViews: { views: [{ id: "status" }] },
      onSetComposerDraft: () => undefined,
      onRefresh: () => undefined,
    },
    createElement(ArtifactExtensionMount, { mount: "sidebar" }),
  );
}

describe("player-view panel frontend seam", () => {
  test("停用脚本会卸载旧预览，重新启用也不接受停用前的在途结果", async () => {
    const snapshot = {
      playerViewPreview: {
        worldId: "world-1",
        head: "head-1",
        panels: [panel("value")],
        playerViews: { views: [], diagnostics: [] },
      },
    };
    let release: ((value: typeof snapshot) => void) | undefined;
    let defer = false;
    const client = {
      request: (request: V1Request) =>
        request.type === "workspace.read"
          ? Promise.resolve({ worlds: [{ worldId: "world-1", title: "世界" }] })
          : defer
            ? new Promise<typeof snapshot>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(snapshot),
    } as unknown as { request<T>(request: V1Request): Promise<T> };
    const component = (scriptsEnabled: boolean) =>
      createElement(InterfaceExtensionPreview, {
        client,
        presetId: "preset-1",
        revision: "rev-1",
        files: {},
        structure: undefined,
        conflict: false,
        scriptsEnabled,
      });
    const view = render(component(true));
    await screen.findByRole("option", { name: "世界" });
    fireEvent.change(screen.getByLabelText("预览世界"), {
      target: { value: "world-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览界面" }));
    await screen.findByTitle("current");
    view.rerender(component(false));
    expect(screen.queryByTitle("current")).toBeNull();
    view.rerender(component(true));
    expect(screen.queryByTitle("current")).toBeNull();
    defer = true;
    fireEvent.click(screen.getByRole("button", { name: "预览界面" }));
    view.rerender(component(false));
    view.rerender(component(true));
    await act(() => {
      release?.(snapshot);
      return Promise.resolve();
    });
    expect(screen.queryByTitle("current")).toBeNull();
  });

  test("未选资源的玩家视图用内置面板显示原值、布局和空值策略", () => {
    const plain = panel("白色背心");
    delete plain.frontend.renderer;
    plain.payload = {
      title: "内置状态栏",
      items: [{ id: "clothes", label: "衣着", value: "白色背心" }],
      config: { layout: "grid", empty: "hide", groups: [] },
    };
    const view = render(host([plain]));
    expect(screen.getByRole("heading", { name: "内置状态栏" })).toBeTruthy();
    expect(screen.getByText("白色背心")).toBeTruthy();
    expect(
      view.container.querySelector('[data-player-view-layout="grid"]'),
    ).toBeTruthy();
    expect(view.container.querySelector("pre")).toBeNull();
    view.rerender(
      host([
        {
          ...plain,
          payload: { title: "空面板", items: [], config: { empty: "hide" } },
        },
      ]),
    );
    expect(screen.queryByText("空面板")).toBeNull();
  });

  test("初始投影显示在通用 mount，同 key 更新复用同一 app iframe", () => {
    const view = render(host([panel("白色背心")]));
    const frame = screen.getByTitle("current");
    expect(frame).toBeTruthy();
    expect(
      view.container.querySelector('[data-extension-mount="sidebar"]'),
    ).toBeTruthy();
    view.rerender(host([panel("蓝色外套")]));
    expect(screen.getByTitle("current")).toBe(frame);
  });

  test("panel revision 变化才重建实例", () => {
    const first = panel("one");
    const view = render(host([first]));
    const frame = screen.getByTitle("current");
    view.rerender(
      host([
        panel("two", {
          frontend: {
            ...first.frontend,
            renderer: { ...first.frontend.renderer!, revision: "v2" },
          },
        }),
      ]),
    );
    expect(screen.getByTitle("current")).not.toBe(frame);
  });
});
