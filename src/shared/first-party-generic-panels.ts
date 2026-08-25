import { defaultNarrationPrompt } from "./default-play-prompts.ts";
import { defaultPresetHostFiles } from "./default-preset-host.ts";

/**
 * Ordinary copyable examples for the generic artifact seam.  Nothing in the
 * Runtime treats these output names or channels as privileged; authors can
 * remove, rename, or replace every file after copying the preset.
 */
export const firstPartyGenericPanelsPresetFiles: Record<string, string> = {
  "preset.yaml": `format: narraeon.play-preset/v1
name: generic-panels-recommended
callChain: call-chain.yaml
mounts:
  generic.markdown: story
  generic.html: sidebar
  generic.debug: debug
extensions:
  - renderers/generic-html.html
  - scripts/generic-html.js
  - assets/generic-html.css
`,
  "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: publish_panels
    displayName: 发布通用面板
    prompt:
      role: author_instruction
      markdown: prompts/panels.md
    maxArtifactBytes: 65536
    artifacts:
      - name: markdown_panel
        channel: generic.markdown
        strategy: replace
        contentType: text/markdown
        save: commit
        invalidation: new_operation
        required: false
        maxEmits: 1
      - name: html_panel
        channel: generic.html
        strategy: replace
        contentType: text/html
        renderer: renderers/generic-html.html
        rendererRevision: v1
        rendererMode: app
        scripts:
          - scripts/generic-html.js
        assets:
          - assets/generic-html.css
        save: commit
        invalidation: new_operation
        required: false
        maxEmits: 1
      - name: debug_panel
        channel: generic.debug
        strategy: append
        contentType: text/markdown
        save: operation
        invalidation: operation_end
        required: false
        maxEmits: 8
`,
  ...defaultPresetHostFiles,
  "prompts/narrate.md": defaultNarrationPrompt,
  "prompts/panels.md": `# 通用面板

核心叙事已经提交。只有面板能为当前局面提供额外价值时才生成它；没有合适内容时可以不生成。

面板只能整理已经成立且适合玩家看见的信息，不得发明世界事实、替玩家作决定、偷偷保存状态，或把未向玩家揭示的信息当作提示。它是非权威的界面补充，不应复制或改写由玩家视图负责的固定状态展示。各输出的格式、保存方式和提交方法服从当前后置请求的 Runtime 产物说明。
`,
  "renderers/generic-html.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>通用 HTML 面板</title></head><body>
<main id="generic-html-root" aria-label="通用 HTML 面板"></main>
</body></html>
`,
  "scripts/generic-html.js": `(function () {
  var root = document.getElementById("generic-html-root");
  window.addEventListener("message", function (event) {
    if (!event.data || event.data.namespace !== "narraeon.extension.v1") return;
    if (event.data.type !== "render.update") return;
    var payload = event.data.payload || {};
    root.innerHTML = typeof payload.content === "string" ? payload.content : "";
  });
}());
`,
  "assets/generic-html.css": `body { margin: 0; font: 14px/1.45 system-ui, sans-serif; color: #202020; }
#generic-html-root { padding: .75rem; }
`,
};
