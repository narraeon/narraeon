import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { projectPlayerViewPanels } from "../../src/runtime/extension/PlayerViewPanelProjector.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";

function binding() {
  const files = structuredClone(defaultPlayPresetFiles);
  files["preset.yaml"] = `format: narraeon.play-preset/v1
name: player-view-panel
callChain: call-chain.yaml
mounts: []
playerViewPanels:
  - id: current
    source:
      kind: player_view
      view: status
      itemIds: [clothes, stats]
    channel: panel.current
    key: current
    mount: sidebar
    config:
      title: 当前信息
      layout: grid
      theme: calm
      empty: message
      emptyMessage: 暂无信息
      groups:
        - id: primary
          label: 主要
          itemIds: [clothes]
    renderer: renderers/panel.html
    rendererRevision: v1
    rendererMode: app
    scripts: [scripts/panel.js]
    assets: [assets/panel.css]
extensions:
  - renderers/panel.html
  - scripts/panel.js
  - assets/panel.css
`;
  files["renderers/panel.html"] = "<!doctype html><main></main>";
  files["scripts/panel.js"] = "window.panelReady = true;";
  files["assets/panel.css"] = "body { color: red; }";
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  return {
    id: "preset-1",
    name: "panel",
    revision: "rev-1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

describe("player-view-backed panel projector", () => {
  test("只投影已提交安全 view 值，保留精确诊断与 current preset provenance", () => {
    const panelBinding = binding();
    const result = projectPlayerViewPanels({
      worldId: "world-1",
      head: "head-2",
      binding: panelBinding,
      playerViews: {
        views: [
          {
            id: "status",
            title: "当前信息",
            items: [
              { id: "clothes", label: "衣着", value: "白色背心" },
              {
                id: "stats",
                label: "属性",
                value: { stamina: 3, tags: ["quiet"] },
              },
              { id: "secret", label: "秘密", value: "不应被读取" },
            ],
          },
        ],
        diagnostics: [
          {
            code: "unresolved_selector",
            viewId: "status",
            itemId: "missing",
            message: "精确 selector 当前无法解析",
          },
        ],
      },
    });
    expect(result).toHaveLength(1);
    const panel = result[0]!;
    expect(panel.channel).toBe("panel.current");
    expect(panel.key).toBe("current");
    expect(panel.lifecycle).toBe("current_preset");
    expect(panel.authority).toBe("committed_player_view_projection");
    expect(panel.frontend.source).toBe("player_view");
    expect(panel.frontend.authority).toBe("committed_player_view_projection");
    expect(panel.payload).toMatchObject({
      title: "当前信息",
      viewId: "status",
      items: [
        { id: "clothes", value: "白色背心" },
        { id: "stats", value: { stamina: 3, tags: ["quiet"] } },
      ],
      diagnostics: [{ itemId: "missing" }],
    });
    expect(JSON.stringify(panel.payload)).not.toContain("不应被读取");
  });

  test("同 key 更新只改变 payload，保持 upsert instance contract 与 renderer revision", () => {
    const panelBinding = binding();
    const make = (value: string) =>
      projectPlayerViewPanels({
        worldId: "world-1",
        head: "head-2",
        binding: panelBinding,
        playerViews: {
          views: [
            {
              id: "status",
              title: "当前信息",
              items: [{ id: "clothes", label: "衣着", value }],
            },
          ],
          diagnostics: [],
        },
      })[0]!;
    const first = make("白色背心");
    const second = make("蓝色外套");
    expect(first.channel).toBe(second.channel);
    expect(first.key).toBe(second.key);
    expect(first.projection).toBe("upsert");
    expect(first.frontend.preset).toEqual(second.frontend.preset);
    expect(first.payload).not.toEqual(second.payload);
  });

  test("缺失 view、精确 item 和越界 group 都生成稳定 unresolved diagnostics", () => {
    const panelBinding = binding();
    const panel = panelBinding.definition.playerViewPanels[0]!;
    panel.source = {
      kind: "player_view",
      view: "missing_view",
      itemIds: ["missing_item"],
    };
    panel.config.groups = [
      { id: "missing_group", label: "缺失分组", itemIds: ["group_item"] },
    ];
    const [projected] = projectPlayerViewPanels({
      worldId: "world-1",
      head: "head-2",
      binding: panelBinding,
      playerViews: {
        views: [],
        diagnostics: [],
      },
    });
    expect(projected?.diagnostics).toEqual([
      expect.objectContaining({
        code: "unresolved_selector",
        viewId: "missing_view",
        message: "精确 player view 当前无法解析：missing_view",
      }),
      expect.objectContaining({
        code: "unresolved_selector",
        viewId: "missing_view",
        itemId: "missing_item",
        message: "精确 selector 当前无法解析：missing_view/missing_item",
      }),
      expect.objectContaining({
        code: "unresolved_selector",
        viewId: "missing_view",
        itemId: "group_item",
        message:
          "玩家视图分组引用的 item 当前无法解析：missing_view/group_item",
      }),
    ]);
  });

  test("缺少 playerViewPanels 时不生成空面板，资源声明错误静态拒绝", () => {
    const base = structuredClone(defaultPlayPresetFiles);
    const parsed = parsePlayPresetFiles(base);
    expect(parsed.kind).toBe("valid");
    base["preset.yaml"] = `format: narraeon.play-preset/v1
name: invalid-panel
callChain: call-chain.yaml
playerViewPanels:
  - id: panel
    source: { kind: player_view, view: status }
    channel: panel
    key: current
    mount: sidebar
    renderer: renderers/panel.html
    rendererMode: app
    config: {}
extensions: []
`;
    expect(parsePlayPresetFiles(base)).toMatchObject({
      kind: "invalid",
      error: { code: "player_view_panel_renderer_missing" },
    });
  });

  test("移除第一方状态／通用模板后，Runtime 仍走无面板公共路径", async () => {
    const parsed = parsePlayPresetFiles(defaultPlayPresetFiles);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind === "valid")
      expect(parsed.definition.playerViewPanels).toEqual([]);
    const sources = await Promise.all(
      [
        "src/runtime/V1Runtime.ts",
        "src/runtime/extension/FrontendExtensionBundle.ts",
        "src/runtime/extension/PlayerViewPanelProjector.ts",
        "src/web/ArtifactExtensionHost.tsx",
      ].map((path) => readFile(path, "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(
      /first-party-(?:player-view|generic-panels)/u,
    );
  });
});
