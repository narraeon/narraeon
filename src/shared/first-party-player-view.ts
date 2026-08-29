import type { AppLocale } from "../protocol/appPreferences.ts";
import { defaultNarrationPromptForLocale } from "./default-play-prompts.ts";
import { defaultPresetHostFilesForLocale } from "./default-preset-host.ts";
import {
  defaultSettingImprovementPromptForLocale,
  defaultSettingImprovementPromptPath,
} from "./default-setting-improvement-prompt.ts";

/**
 * Ordinary, copyable player-view panel assets. Runtime understands only the
 * generic playerViewPanels contract; this is not a privileged status system.
 */
export function firstPartyStatusPanelPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  const currentStatus = locale === "zh-CN" ? "当前状态" : "Current status";
  const playerView = locale === "zh-CN" ? "玩家视图" : "Player view";
  const emptyMessage =
    locale === "zh-CN" ? "当前没有可显示内容。" : "Nothing to display yet.";
  const emptyPrefix = locale === "zh-CN" ? "暂无项目：" : "No items: ";
  const diagnosticsSuffix =
    locale === "zh-CN" ? " 项视图诊断" : " player-view diagnostics";
  return {
    "preset.yaml": `format: narraeon.play-preset/v1
name: status-panel-recommended
callChain: call-chain.yaml
settingImprovement:
  markdown: prompts/setting-improvement.md
mounts: []
playerViewPanels:
  - id: current_view
    source:
      kind: player_view
      view: status
    channel: player.view.current
    key: current
    mount: sidebar
    renderer: renderers/player-view-status.html
    rendererRevision: v1
    rendererMode: app
    scripts:
      - scripts/player-view-status.js
    assets:
      - assets/player-view-status.css
    config:
      title: ${currentStatus}
      layout: stack
      theme: parchment
      empty: message
      emptyMessage: ${emptyMessage}
      groups: []
extensions:
  - renderers/player-view-status.html
  - scripts/player-view-status.js
  - assets/player-view-status.css
`,
    "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups: []
`,
    ...defaultPresetHostFilesForLocale(locale),
    "prompts/narrate.md": defaultNarrationPromptForLocale(locale),
    [defaultSettingImprovementPromptPath]:
      defaultSettingImprovementPromptForLocale(locale),
    "renderers/player-view-status.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>${currentStatus}</title></head><body>
<main id="player-view-panel-root" aria-label="${currentStatus}"></main>
</body></html>
`,
    "scripts/player-view-status.js": `(function () {
  var root = document.getElementById("player-view-panel-root");
  var styleSource = window.__NARRAEON_ASSETS__ && window.__NARRAEON_ASSETS__["assets/player-view-status.css"];
  if (typeof styleSource === "string") {
    var style = document.createElement("style");
    style.textContent = styleSource;
    document.head.append(style);
  }
  function valueNode(value) {
    if (value === null || value === undefined) return document.createTextNode("—");
    if (typeof value === "object") {
      var wrapper = document.createElement(Array.isArray(value) ? "ul" : "dl");
      Object.keys(value).forEach(function (key, index) {
        var entry = document.createElement(Array.isArray(value) ? "li" : "div");
        if (!Array.isArray(value)) {
          var term = document.createElement("dt");
          term.textContent = key;
          entry.append(term);
        }
        entry.append(valueNode(Array.isArray(value) ? value[index] : value[key]));
        wrapper.append(entry);
      });
      return wrapper;
    }
    return document.createTextNode(String(value));
  }
  function draw(raw) {
    root.replaceChildren();
    var payload;
    try { payload = JSON.parse(raw || "{}"); } catch (_) { return; }
    var config = payload.config || {};
    root.dataset.theme = config.theme || "default";
    root.dataset.layout = config.layout || "stack";
    root.dataset.emptyState = config.empty || "message";
    var heading = document.createElement("h3");
    heading.textContent = payload.title || payload.viewId || ${JSON.stringify(playerView)};
    root.append(heading);
    var items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) {
      if (config.empty === "message" || config.empty === "show") {
        var empty = document.createElement("p");
        empty.className = config.empty === "show"
          ? "player-view-empty player-view-empty-value"
          : "player-view-empty player-view-empty-message";
        empty.textContent = config.empty === "show"
          ? ${JSON.stringify(emptyPrefix)} + (config.emptyMessage || ${JSON.stringify(emptyMessage)})
          : (config.emptyMessage || ${JSON.stringify(emptyMessage)});
        root.append(empty);
      }
    } else {
      var byId = new Map(items.map(function (item) { return [item.id, item]; }));
      var groups = Array.isArray(config.groups) ? config.groups : [];
      var renderItems = function (list, selected) {
        selected.forEach(function (item) {
          var row = document.createElement("div");
          var label = document.createElement("dt");
          label.textContent = item.label || item.id;
          var value = document.createElement("dd");
          value.append(valueNode(item.value));
          row.append(label, value);
          list.append(row);
        });
      };
      if (groups.length === 0) {
        var list = document.createElement("dl");
        renderItems(list, items);
        root.append(list);
      } else {
        groups.forEach(function (group) {
          var selected = (Array.isArray(group.itemIds) ? group.itemIds : [])
            .map(function (id) { return byId.get(id); })
            .filter(Boolean);
          if (selected.length === 0) return;
          var section = document.createElement("section");
          var groupHeading = document.createElement("h4");
          groupHeading.textContent = group.label || group.id;
          var groupList = document.createElement("dl");
          renderItems(groupList, selected);
          section.append(groupHeading, groupList);
          root.append(section);
        });
      }
    }
    var diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    if (diagnostics.length > 0) {
      var details = document.createElement("details");
      var summary = document.createElement("summary");
      summary.textContent = diagnostics.length + ${JSON.stringify(diagnosticsSuffix)};
      details.append(summary);
      var diagnosticList = document.createElement("ul");
      diagnostics.forEach(function (diagnostic) {
        var item = document.createElement("li");
        item.textContent = diagnostic.message;
        diagnosticList.append(item);
      });
      details.append(diagnosticList);
      root.append(details);
    }
  }
  window.addEventListener("message", function (event) {
    if (!event.data || event.data.namespace !== "narraeon.extension.v1") return;
    if (event.data.type === "render.update") draw(event.data.payload && event.data.payload.content);
  });
}());
`,
    "assets/player-view-status.css": `body { margin: 0; font: 14px/1.45 system-ui, sans-serif; color: #202020; }
#player-view-panel-root { display: grid; gap: .5rem; }
#player-view-panel-root[data-theme="parchment"] { color: #4a382b; background: #fffaf1; padding: .75rem; border-radius: .65rem; }
#player-view-panel-root dl { display: grid; gap: .45rem; margin: 0; }
#player-view-panel-root[data-layout="grid"] dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
#player-view-panel-root dl > div { display: grid; gap: .15rem; }
#player-view-panel-root dt { font-weight: 650; }
#player-view-panel-root dd { margin: 0; }
#player-view-panel-root ul, #player-view-panel-root dl dl { margin: .25rem 0 0 1rem; padding-left: 1rem; }
.player-view-empty { color: #6c6259; }
`,
  };
}

export const firstPartyStatusPanelPresetFiles =
  firstPartyStatusPanelPresetFilesForLocale("en");
