// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

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
