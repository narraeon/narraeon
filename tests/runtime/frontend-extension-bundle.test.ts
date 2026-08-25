import { describe, expect, test } from "vitest";

import { type ArtifactProjectionItem } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { projectArtifactForFrontend } from "../../src/runtime/extension/FrontendExtensionBundle.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";

function binding(): PlayPresetBinding {
  const files = {
    ...defaultPlayPresetFiles,
    "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: panels
    displayName: 面板
    prompt:
      markdown: prompts/panels.md
    artifacts:
      - name: panel
        channel: panel
        strategy: replace
        contentType: text/markdown
        save: commit
        invalidation: new_operation
        required: false
        maxEmits: 1
`,
    "prompts/panels.md": "# 面板\n\n生成面板。\n",
    "regex/panel.yaml": `rules:
  - order: 1
    scope: raw_text
    pattern: secret
    flags: gi
    replace: hidden
    maxMatches: 1
    errorPolicy: fallback
`,
    "renderers/panel.html": "<main id=panel></main>",
    "scripts/panel.js": "document.body.dataset.ready = 'true';",
    "assets/icon.txt": "icon",
  };
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  const definition = structuredClone(parsed.definition);
  definition.mounts = [{ channel: "panel", mount: "sidebar" }];
  definition.extensionRefs = [
    "regex/panel.yaml",
    "renderers/panel.html",
    "scripts/panel.js",
    "assets/icon.txt",
  ];
  const followup = definition.followups.find(({ id }) => id === "panels");
  if (followup === undefined) throw new Error("panels followup missing");
  followup.artifacts = [
    {
      name: "panel",
      channel: "panel",
      strategy: "replace",
      contentType: "text/markdown",
      renderer: "renderers/panel.html",
      rendererRevision: "panel-v1",
      rendererMode: "app",
      regex: "regex/panel.yaml",
      scripts: ["scripts/panel.js"],
      assets: ["assets/icon.txt"],
      save: "commit",
      invalidation: "head_change",
      required: false,
      maxEmits: 1,
    },
  ];
  return {
    id: "preset-1",
    name: definition.name,
    revision: "rev-1",
    definition,
    files,
    scriptsEnabled: true,
  };
}

function artifact(): ArtifactProjectionItem {
  return {
    recordId: "record-1",
    worldId: "world-1",
    operationId: "operation-1",
    playPresetId: "preset-1",
    playPresetRevision: "rev-1",
    playPresetScriptsEnabled: true,
    requestId: "panels",
    requestAttempt: 1,
    output: "panel",
    channel: "panel",
    contentType: "text/markdown",
    renderer: "renderers/panel.html",
    rendererRevision: "panel-v1",
    payload: "hello",
    projection: "replace",
    save: "commit",
    sequence: 1,
    head: "head-1",
  };
}

describe("frontend extension bundle", () => {
  test("只从 exact frozen revision 生成安全 bundle", () => {
    const result = projectArtifactForFrontend(artifact(), binding());
    expect(result.status).toBe("ready");
    expect(result.source).toBe("artifact");
    expect(result.authority).toBe("non_authoritative_artifact");
    expect(result.mount).toBe("sidebar");
    expect(result.renderer?.mode).toBe("app");
    expect(result.renderer?.document).toContain("id=panel");
    expect(result.renderer?.scripts[0]).toContain("dataset.ready");
    expect(result.renderer?.assets[0]).toEqual({
      id: "assets/icon.txt",
      source: "icon",
    });
    expect(result.regex[0]?.scope).toBe("raw_text");
    expect(result).not.toHaveProperty("prompts");
    expect(result).not.toHaveProperty("providerState");
    expect(result).not.toHaveProperty("transcript");
  });

  test("历史 revision 缺失时只返回 raw fallback，不拿 current 冒充", () => {
    const result = projectArtifactForFrontend(artifact(), null);
    expect(result.status).toBe("missing_revision");
    expect(result.fallback).toBe("raw");
    expect(result.preset).toEqual({ id: "preset-1", revision: "rev-1" });
    expect(result.mount).toBeUndefined();
    expect(result.renderer).toBeUndefined();
  });

  test("raw artifact contract 与冻结 declaration 不一致时拒绝解释", () => {
    const result = projectArtifactForFrontend(
      { ...artifact(), channel: "other-channel" },
      binding(),
    );
    expect(result.status).toBe("invalid_revision");
    expect(result.fallback).toBe("raw");
    expect(result.diagnostic).toContain("contract");
    expect(result.renderer).toBeUndefined();
  });

  test("脚本停用只过滤执行资源，仍保留冻结 renderer/asset 的可诊断投影", () => {
    const disabled = binding();
    disabled.files["renderers/panel.html"] =
      "<main>safe layout</main><script>parent.__escaped = true</script>";
    const result = projectArtifactForFrontend(
      { ...artifact(), playPresetScriptsEnabled: false },
      {
        ...disabled,
        scriptsEnabled: false,
      },
    );
    expect(result.status).toBe("ready");
    expect(result.renderer?.scripts).toEqual([]);
    expect(result.renderer?.document).toContain("parent.__escaped");
    expect(result.renderer?.assets).toHaveLength(1);
    expect(result.trustedLocalCode).toBe(false);
  });

  test("脚本停用的 raw HTML 也不取得本地代码信任", () => {
    const disabled = binding();
    const followup = disabled.definition.followups.find(
      ({ id }) => id === "panels",
    );
    if (followup === undefined) throw new Error("panels followup missing");
    const rawDeclaration = structuredClone(followup.artifacts[0]!);
    delete rawDeclaration.renderer;
    delete rawDeclaration.rendererRevision;
    delete rawDeclaration.scripts;
    delete rawDeclaration.assets;
    delete rawDeclaration.regex;
    followup.artifacts = [
      {
        ...rawDeclaration,
        contentType: "text/html",
      },
    ];
    disabled.scriptsEnabled = false;
    const rawArtifact = artifact();
    delete rawArtifact.renderer;
    delete rawArtifact.rendererRevision;
    const result = projectArtifactForFrontend(
      {
        ...rawArtifact,
        contentType: "text/html",
        payload: "<script>parent.__escaped = true</script>",
        playPresetScriptsEnabled: false,
      },
      disabled,
    );
    expect(result.status).toBe("ready");
    expect(result.trustedLocalCode).toBe(false);
  });

  test("artifact 自己冻结的脚本策略优先于当前 preset local flag", () => {
    const result = projectArtifactForFrontend(
      { ...artifact(), playPresetScriptsEnabled: false },
      { ...binding(), scriptsEnabled: true },
    );
    expect(result.status).toBe("ready");
    expect(result.renderer?.scripts).toEqual([]);
    expect(result.renderer?.assets).toHaveLength(1);
  });
});
