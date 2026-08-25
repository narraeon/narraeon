import {
  parsePlayPresetRegexAsset,
  toPlayPresetStructuredEditor,
  type PlayPresetArtifactDeclaration,
  type PlayPresetArtifactPayloadContract,
  type PlayPresetBinding,
  type PlayPresetRegexRule,
  type PlayPresetStructuredEditor,
} from "./FileNativePlayPresetStore.ts";

export interface PlayPresetWorkbenchRendererPreview {
  mode: "document" | "app";
  revision?: string;
  document?: string;
  scripts: string[];
  assets: { id: string; source: string }[];
  trustedLocalCode: boolean;
}

export interface PlayPresetWorkbenchArtifactPreview {
  requestId: string;
  output: string;
  declaration: PlayPresetArtifactDeclaration;
  rawPayload: unknown;
  rawText: string;
  regex: PlayPresetRegexRule[];
  renderer?: PlayPresetWorkbenchRendererPreview;
  activeProjection: {
    status: "active";
    channel: string;
    key?: string;
    strategy: PlayPresetArtifactDeclaration["strategy"];
    save: PlayPresetArtifactDeclaration["save"];
  };
  clear: {
    supported: true;
    invalidation: PlayPresetArtifactDeclaration["invalidation"];
    description: string;
  };
  simulation: {
    emitted: { status: "active"; identity: string };
    explicitClear: { status: "cleared"; identity: string };
    invalidation: {
      policy: PlayPresetArtifactDeclaration["invalidation"];
      status: "active" | "cleared" | "superseded";
      reason: string;
    };
  };
  diagnostics: string[];
}

export interface PlayPresetWorkbenchSnapshot {
  id: string;
  name: string;
  revision: string;
  structure: PlayPresetStructuredEditor;
  artifactPreviews: PlayPresetWorkbenchArtifactPreview[];
  staticErrors: { code: string; message: string; location: string }[];
  trustedLocalCode: boolean;
  scriptsEnabled: boolean;
}

/**
 * Read-only workbench seam. It resolves the same frozen file-native binding
 * used by PromptCompiler and FrontendExtensionBundle, but never calls a model,
 * writes a world, or executes author JavaScript.
 */
export function buildPlayPresetWorkbenchSnapshot(
  binding: PlayPresetBinding,
): PlayPresetWorkbenchSnapshot {
  const scriptsEnabled = binding.scriptsEnabled !== false;
  const structure = toPlayPresetStructuredEditor(binding.definition);
  const staticErrors: PlayPresetWorkbenchSnapshot["staticErrors"] = [];
  const artifactPreviews: PlayPresetWorkbenchArtifactPreview[] = [];
  for (const followup of binding.definition.followups)
    for (const declaration of followup.artifacts) {
      const diagnostics: string[] = [];
      let regex: PlayPresetRegexRule[] = [];
      if (declaration.regex !== undefined) {
        try {
          const source = binding.files[declaration.regex];
          if (source === undefined) throw new Error("regex 资源不存在");
          regex = parsePlayPresetRegexAsset(source, declaration.regex);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : "regex 资源无效";
          diagnostics.push(message);
          staticErrors.push({
            code: "regex_invalid",
            message,
            location: declaration.regex,
          });
        }
      }
      const rawPayload = samplePayload(
        declaration.payloadContract,
        declaration.contentType,
      );
      const rawText =
        declaration.contentType === "application/json"
          ? JSON.stringify(rawPayload, null, 2)
          : declaration.contentType === "text/markdown"
            ? "# 示例后置请求产物\n\n这是工作台的本地预览样例。"
            : declaration.contentType === "text/html"
              ? "<p>这是工作台的本地 HTML 样例。</p>"
              : "这是工作台的本地文本样例。";
      let renderer: PlayPresetWorkbenchRendererPreview | undefined;
      if (declaration.renderer !== undefined) {
        const source = binding.files[declaration.renderer];
        if (source === undefined) {
          const message = `renderer 资源不存在：${declaration.renderer}`;
          diagnostics.push(message);
          staticErrors.push({
            code: "renderer_missing",
            message,
            location: declaration.renderer,
          });
        } else {
          const scriptSources = (declaration.scripts ?? []).flatMap((path) => {
            const script = binding.files[path];
            if (script === undefined) {
              diagnostics.push(`script 资源不存在：${path}`);
              staticErrors.push({
                code: "script_missing",
                message: `script 资源不存在：${path}`,
                location: path,
              });
              return [];
            }
            return [script];
          });
          const assetSources = (declaration.assets ?? []).flatMap((path) => {
            const asset = binding.files[path];
            if (asset === undefined) {
              diagnostics.push(`asset 资源不存在：${path}`);
              staticErrors.push({
                code: "asset_missing",
                message: `asset 资源不存在：${path}`,
                location: path,
              });
              return [];
            }
            return [{ id: path, source: asset }];
          });
          renderer = {
            mode: declaration.rendererMode ?? "document",
            ...(declaration.rendererRevision === undefined
              ? {}
              : { revision: declaration.rendererRevision }),
            document: source,
            scripts: scriptsEnabled ? scriptSources : [],
            assets: assetSources,
            trustedLocalCode:
              scriptsEnabled &&
              (declaration.contentType === "text/html" ||
                (declaration.scripts?.length ?? 0) > 0),
          };
        }
      }
      artifactPreviews.push({
        requestId: followup.id,
        output: declaration.name,
        declaration: structuredClone(declaration),
        rawPayload,
        rawText,
        regex,
        ...(renderer === undefined ? {} : { renderer }),
        activeProjection: {
          status: "active",
          channel: declaration.channel,
          ...(declaration.key === undefined ? {} : { key: declaration.key }),
          strategy: declaration.strategy,
          save: declaration.save,
        },
        clear: {
          supported: true,
          invalidation: declaration.invalidation,
          description:
            declaration.invalidation === "never"
              ? "声明为 never；预览只展示策略，不自动清除。"
              : "clear 是显式投影事件，不会修改 raw payload。",
        },
        simulation: simulateArtifactProjection(declaration),
        diagnostics,
      });
    }
  return {
    id: binding.id,
    name: binding.name,
    revision: binding.revision,
    structure,
    artifactPreviews,
    staticErrors,
    trustedLocalCode: artifactPreviews.some(
      ({ renderer }) => renderer?.trustedLocalCode === true,
    ),
    scriptsEnabled,
  };
}

/**
 * Deterministic, local-only projection preview. It mirrors the production
 * lifecycle vocabulary without touching a world or artifact store.
 */
export function simulateArtifactProjection(
  declaration: PlayPresetArtifactDeclaration,
): PlayPresetWorkbenchArtifactPreview["simulation"] {
  const identity = `${declaration.name} → ${declaration.channel}${declaration.key === undefined ? "" : `/${declaration.key}`}`;
  const invalidation = declaration.invalidation;
  return {
    emitted: { status: "active", identity },
    explicitClear: { status: "cleared", identity },
    invalidation: {
      policy: invalidation,
      status:
        invalidation === "never"
          ? "active"
          : invalidation === "explicit_clear"
            ? "cleared"
            : "superseded",
      reason:
        invalidation === "never"
          ? "never：没有自动失效事件，emit 后保持 active。"
          : invalidation === "explicit_clear"
            ? "explicit_clear：触发 clear 后变为 cleared。"
            : `${invalidation}：触发生命周期事件后变为 superseded。`,
    },
  };
}

function samplePayload(
  contract: PlayPresetArtifactPayloadContract | undefined,
  contentType?: PlayPresetArtifactDeclaration["contentType"],
): unknown {
  if (contract === undefined) {
    if (contentType === "text/html")
      return "<p>这是工作台的本地 HTML 样例。</p>";
    if (contentType === "text/markdown")
      return "# 示例后置请求产物\n\n这是工作台的本地预览样例。";
    if (contentType === "text/plain") return "这是工作台的本地文本样例。";
    return { sample: "workbench" };
  }
  switch (contract.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(contract.properties ?? {})
          .filter(([key]) => contract.required?.includes(key) ?? true)
          .map(([key, child]) => [key, samplePayload(child)]),
      );
    case "array":
      return [samplePayload(contract.items)];
    case "string":
      return "示例文本";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
  }
}
