import type { PlayPresetArtifactDefinition } from "./PlayPresetScreen.tsx";
import { getWebLocale } from "./i18n.ts";

/** Creates ordinary editable files, with no permission or model side effects. */
export function createPresetScriptExample(
  kind: "actions" | "card",
  requestId: string,
) {
  const id = `example_${crypto.randomUUID().replaceAll("-", "")}`;
  const zh = getWebLocale() === "zh-CN";
  const renderer = `renderers/${id}.html`;
  const script = `scripts/${id}.js`;
  const css = `assets/${id}.css`;
  const sample =
    kind === "actions"
      ? [
          {
            label: zh ? "询问船夫" : "Ask the ferryman",
            prompt: zh
              ? "我问船夫：这封信是谁交给你的？"
              : "I ask the ferryman who gave him the letter.",
          },
        ]
      : {
          title: zh ? "雾港" : "Mist harbour",
          body: zh ? "灯塔在暮色中亮起。" : "The lighthouse shines at dusk.",
        };
  const artifact: PlayPresetArtifactDefinition = {
    name: id,
    displayName:
      kind === "actions"
        ? zh
          ? "行动建议按钮"
          : "Action buttons"
        : zh
          ? "结构化场景卡片"
          : "Scene card",
    purpose:
      kind === "actions"
        ? zh
          ? "提供下一步行动草稿，不自动发送。"
          : "Offer draft actions without sending them."
        : zh
          ? "回顾已发生的场景。"
          : "Recap the established scene.",
    channel: `${requestId}.${id}`,
    strategy: "replace",
    contentType: "application/json",
    renderer,
    rendererRevision: "v1",
    rendererMode: "app",
    scripts: [script],
    assets: [css],
    save: "commit",
    invalidation: "new_operation",
    required: false,
    maxEmits: 1,
    payloadContract:
      kind === "actions"
        ? {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "prompt"],
              properties: {
                label: { type: "string", minLength: 1, maxLength: 80 },
                prompt: { type: "string", minLength: 1, maxLength: 1000 },
              },
            },
          }
        : {
            type: "object",
            additionalProperties: false,
            required: ["title", "body"],
            properties: {
              title: { type: "string", minLength: 1, maxLength: 80 },
              body: { type: "string", maxLength: 4000 },
            },
          },
  };
  const files: Record<string, string> = {
    [renderer]:
      '<!doctype html><html><body><main id="content"></main><p id="feedback" role="status"></p></body></html>',
    [css]:
      "body { margin: 0; padding: 16px; color: #27333c; background: #f7f4eb; font: 14px/1.7 system-ui; } #content { display: grid; gap: 8px; } button { padding: 12px; border: 1px solid #b9ad95; background: white; text-align: left; cursor: pointer; } button:disabled { opacity: .5; cursor: default; }",
    [script]: `// request and fromHost are helpers defined by this example, not a built-in SDK.
(function () {
  var pending = new Map();
  var instanceId = document.documentElement.dataset.narraeonInstance;
  var nonce = document.documentElement.dataset.narraeonNonce;
  var feedback = document.getElementById("feedback");
  function fromHost(event) {
    var message = event.data;
    return event.source === parent && message && message.namespace === "narraeon.extension.v1" && message.instanceId === instanceId && message.nonce === nonce;
  }
  function request(command, payload) {
    var requestId = crypto.randomUUID();
    pending.set(requestId, command);
    parent.postMessage({namespace: "narraeon.extension.v1", instanceId: instanceId, nonce: nonce, requestId: requestId, command: command, payload: payload}, "*");
  }
  window.addEventListener("message", function (event) {
    if (!fromHost(event)) return;
    var message = event.data;
    if (message.type === "bridge.response" && pending.has(message.requestId)) {
      pending.delete(message.requestId);
      feedback.textContent = message.ok ? ${JSON.stringify(zh ? "已填写草稿，尚未发送。" : "Draft filled, not sent.")} : ${JSON.stringify(zh ? "操作失败：" : "Action failed: ")} + JSON.stringify(message.error || message.payload);
      return;
    }
    if (message.type !== "render.update") return;
    var root = document.getElementById("content");
    root.replaceChildren();
    try {
      // payload.content is the STRING after display processing.
      var data = JSON.parse(message.payload.content);
      feedback.textContent = message.payload.interactionDisabled ? ${JSON.stringify(zh ? "当前禁止交互。" : "Interactions are currently disabled.")} : "";
      ${
        kind === "actions"
          ? `data.forEach(function (item) {
        var button = document.createElement("button");
        button.textContent = item.label;
        button.disabled = Boolean(message.payload.interactionDisabled);
        button.addEventListener("click", function () { request("composer.set_draft", {text: item.prompt}); });
        root.append(button);
      });`
          : `var title = document.createElement("h3");
      title.textContent = data.title;
      var body = document.createElement("p");
      body.textContent = data.body;
      root.append(title, body);`
      }
    } catch (error) { feedback.textContent = String(error); }
  });
}());
`,
  };
  return { artifact, files, sample };
}
