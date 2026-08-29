import type { AppLocale } from "../protocol/appPreferences.ts";
import { defaultNarrationPromptForLocale } from "./default-play-prompts.ts";
import { defaultPresetHostFilesForLocale } from "./default-preset-host.ts";
import {
  defaultSettingImprovementPromptForLocale,
  defaultSettingImprovementPromptPath,
} from "./default-setting-improvement-prompt.ts";

/**
 * An ordinary, portable play-preset asset. Runtime treats this exactly like
 * any author-supplied file map. The export is only a convenient workbench
 * starting point and may be copied, edited, exported, or deleted.
 */
export function firstPartyActionChoicesPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  const displayName = locale === "zh-CN" ? "下一步建议" : "Next-step ideas";
  return {
    "preset.yaml": `format: narraeon.play-preset/v1
name: action-choices-recommended
callChain: call-chain.yaml
settingImprovement:
  markdown: prompts/setting-improvement.md
mounts:
  player.options: composer_below
extensions:
  - renderers/player-options.html
  - scripts/player-options.js
  - assets/player-options.css
`,
    "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: player_options
    displayName: ${displayName}
    prompt:
      role: author_instruction
      markdown: prompts/options.md
    maxArtifactBytes: 32768
    artifacts:
      - name: player_options
        channel: player.options
        strategy: replace
        contentType: application/json
        renderer: renderers/player-options.html
        rendererRevision: v1
        rendererMode: app
        scripts:
          - scripts/player-options.js
        assets:
          - assets/player-options.css
        save: commit
        invalidation: new_operation
        required: true
        maxEmits: 1
        payloadContract:
          type: array
          minItems: 4
          maxItems: 4
          uniqueBy: id
          items:
            type: object
            additionalProperties: false
            required:
              - id
              - label
              - prompt
            properties:
              id:
                type: string
                minLength: 1
                maxLength: 64
              label:
                type: string
                minLength: 1
                maxLength: 80
              description:
                type: string
                maxLength: 240
              prompt:
                type: string
                minLength: 1
                maxLength: 1000
`,
    ...defaultPresetHostFilesForLocale(locale),
    "prompts/narrate.md": defaultNarrationPromptForLocale(locale),
    [defaultSettingImprovementPromptPath]:
      defaultSettingImprovementPromptForLocale(locale),
    "prompts/options.md":
      locale === "zh-CN"
        ? `# 提交后下一步建议

根据玩家刚刚看到的决策点，给出四种短而具体、彼此有实质差异的下一步建议。差异应体现在目标、方法、风险或态度上，而不是只替换近义词。

建议只能使用玩家已经能够知道的信息，并且必须是玩家角色此刻有条件尝试的行动。每项建议只是可以填入输入框的草稿：表达玩家准备做什么，不宣称行动已经发生，不预先写定结果，也不替玩家选择或发送。字段、数量和提交方式服从当前后置请求的 Runtime 产物说明。
`
        : `# Next-step ideas after the commit

At the decision point the player has just seen, provide four short, concrete next-step ideas that differ meaningfully from one another. Vary the goal, method, risk, or attitude rather than swapping synonyms.

Use only information the player can already know, and suggest only actions the player character could attempt now. Each idea is a draft that may be placed in the input box: it expresses what the player is preparing to do, never claims the action has happened, predetermines an outcome, chooses for the player, or sends the input. Follow the current follow-up request's Runtime artifact contract for fields, count, and submission.
`,
    "renderers/player-options.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>${displayName}</title></head><body>
<main id="player-options-root" aria-label="${displayName}"></main>
</body></html>
`,
    "scripts/player-options.js": `(function () {
  var root = document.getElementById("player-options-root");
  var pending = new Map();
  var styleSource = window.__NARRAEON_ASSETS__ && window.__NARRAEON_ASSETS__["assets/player-options.css"];
  if (typeof styleSource === "string") {
    var style = document.createElement("style");
    style.textContent = styleSource;
    document.head.append(style);
  }
  function post(command, payload) {
    var requestId = "draft-" + Math.random().toString(36).slice(2);
    parent.postMessage({
      namespace: "narraeon.extension.v1",
      command: command,
      instanceId: document.documentElement.dataset.narraeonInstance,
      nonce: document.documentElement.dataset.narraeonNonce,
      requestId: requestId,
      payload: payload
    }, "*");
    pending.set(requestId, true);
  }
  function draw(raw, disabled) {
    root.replaceChildren();
    var options;
    try { options = JSON.parse(raw); } catch (_) { return; }
    if (!Array.isArray(options)) return;
    options.forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "player-option";
      button.dataset.optionId = option.id;
      button.disabled = Boolean(disabled);
      var label = document.createElement("strong");
      label.textContent = option.label;
      button.append(label);
      if (option.description) {
        var detail = document.createElement("small");
        detail.textContent = option.description;
        button.append(detail);
      }
      button.addEventListener("click", function () {
        post("composer.set_draft", { text: option.prompt });
      });
      root.append(button);
    });
  }
  window.addEventListener("message", function (event) {
    if (!event.data || event.data.namespace !== "narraeon.extension.v1") return;
    if (event.data.type === "render.update") {
      draw(event.data.payload && event.data.payload.content, event.data.payload && event.data.payload.interactionDisabled);
      return;
    }
    if (event.data.type === "bridge.response") pending.delete(event.data.requestId);
  });
}());
`,
    "assets/player-options.css": `body { margin: 0; font: 14px/1.45 system-ui, sans-serif; color: #202020; }
#player-options-root { display: grid; gap: .5rem; }
.player-option { display: grid; gap: .15rem; padding: .65rem .75rem; border: 1px solid #c9c0b1; border-radius: .65rem; background: #fffaf1; color: inherit; text-align: left; cursor: pointer; }
.player-option:hover { border-color: #a66a42; }
.player-option small { color: #6c6259; }
`,
  };
}

export const firstPartyActionChoicesPresetFiles =
  firstPartyActionChoicesPresetFilesForLocale("en");
