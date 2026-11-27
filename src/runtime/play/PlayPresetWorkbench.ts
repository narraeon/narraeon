import { resolveArtifactRenderer } from "../extension/FrontendExtensionBundle.ts";
import {
  builtinFollowupExample,
  isBuiltinExtensionFollowupId,
} from "../../shared/ordered-followups.ts";
import {
  builtinExtensionFollowup,
  trustedBuiltinFollowupCode,
} from "../extension/BuiltinExtensions.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  projectPlayerViewPanels,
  type PlayerViewPanelProjectionInput,
  type FrontendPlayerViewPanelProjection,
} from "../extension/PlayerViewPanelProjector.ts";
import {
  parsePlayPresetRegexAsset,
  applyPlayPresetStructuredEditor,
  parsePlayPresetStructuredEditor,
  parsePlayPresetFiles,
  revisionForPlayPresetFiles,
  toPlayPresetStructuredEditor,
  type PlayPresetArtifactDeclaration,
  type PlayPresetArtifactPayloadContract,
  type PlayPresetBinding,
  type PlayPresetFollowupDefinition,
  type PlayPresetMount,
  type FrozenArtifactPresentation,
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
  mount?: PlayPresetMount["mount"];
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
  playerViewPreview?: Omit<PlayerViewPanelProjectionInput, "binding"> & {
    panels: FrontendPlayerViewPanelProjection[];
  };
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
  playerViewContext?: Omit<PlayerViewPanelProjectionInput, "binding">,
  draft?: { files: Record<string, string>; structure?: unknown },
  locale: AppLocale = "en",
): PlayPresetWorkbenchSnapshot {
  if (draft !== undefined) {
    const files =
      draft.structure === undefined
        ? structuredClone(draft.files)
        : applyPlayPresetStructuredEditor(
            draft.files,
            parsePlayPresetStructuredEditor(draft.structure),
          );
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind === "invalid") throw parsed.error;
    binding = {
      ...binding,
      files,
      definition: parsed.definition,
      revision: revisionForPlayPresetFiles(files),
    };
  }
  const scriptsEnabled = binding.scriptsEnabled !== false;
  const structure = toPlayPresetStructuredEditor(binding.definition);
  const staticErrors: PlayPresetWorkbenchSnapshot["staticErrors"] = [];
  const artifactPreviews: PlayPresetWorkbenchArtifactPreview[] = [];
  const previewFollowups: {
    definition: PlayPresetFollowupDefinition;
    frozenPresentations?: Record<string, FrozenArtifactPresentation>;
  }[] = [
    ...binding.definition.followups.map((definition) => ({ definition })),
    ...(binding.definition.followupItems === undefined
      ? []
      : [builtinFollowupExample(locale)]),
    ...(binding.definition.followupItems ?? []).flatMap((item) =>
      item.enabled && isBuiltinExtensionFollowupId(item.id)
        ? [builtinExtensionFollowup(item.id, locale)]
        : [],
    ),
  ];
  for (const { definition: followup, frozenPresentations } of previewFollowups)
    for (const declaration of followup.artifacts) {
      const presentation = frozenPresentations?.[declaration.name];
      const rendererBinding =
        presentation === undefined
          ? binding
          : {
              files: presentation.files,
              scriptsEnabled:
                isBuiltinExtensionFollowupId(followup.id) &&
                trustedBuiltinFollowupCode(followup.id, presentation),
            };
      const diagnostics: string[] = [];
      let regex: PlayPresetRegexRule[] = [];
      if (declaration.regex !== undefined) {
        try {
          const source = rendererBinding.files[declaration.regex];
          if (source === undefined)
            throw new Error("The regex resource does not exist");
          regex = parsePlayPresetRegexAsset(source, declaration.regex);
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : "The regex resource is invalid";
          diagnostics.push(message);
          staticErrors.push({
            code: "regex_invalid",
            message,
            location: declaration.regex,
          });
        }
      }
      const rawPayload =
        followup.id === "builtin:action-choices"
          ? Array.from({ length: 4 }, (_, index) => ({
              id: `example-${index + 1}`,
              label:
                locale === "zh-CN"
                  ? `示例选项 ${index + 1}`
                  : `Example choice ${index + 1}`,
              prompt:
                locale === "zh-CN"
                  ? `示例行动 ${index + 1}`
                  : `Example action ${index + 1}`,
            }))
          : samplePayload(declaration.payloadContract, declaration.contentType);
      const rawText =
        declaration.contentType === "application/json"
          ? JSON.stringify(rawPayload, null, 2)
          : declaration.contentType === "text/markdown"
            ? "# Example follow-up artifact\n\nThis is a local workbench preview sample."
            : declaration.contentType === "text/html"
              ? "<p>This is a local HTML workbench sample.</p>"
              : "This is a local text workbench sample.";
      let renderer: PlayPresetWorkbenchRendererPreview | undefined;
      try {
        renderer = resolveArtifactRenderer(declaration, rendererBinding);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Invalid renderer resources";
        diagnostics.push(message);
        staticErrors.push({
          code: "renderer_invalid",
          message,
          location: declaration.renderer ?? followup.id,
        });
      }
      artifactPreviews.push({
        requestId: followup.id,
        output: declaration.name,
        declaration: structuredClone(declaration),
        rawPayload,
        rawText,
        regex,
        ...(presentation === undefined ? {} : { mount: presentation.mount }),
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
              ? "Declared as never; the preview displays the policy without clearing automatically."
              : "clear is an explicit projection event and does not modify the raw payload.",
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
    ...(playerViewContext === undefined
      ? {}
      : {
          playerViewPreview: {
            ...playerViewContext,
            panels: projectPlayerViewPanels(
              { ...playerViewContext, binding },
              binding.definition.statusPanelEnabled ? { locale } : undefined,
            ),
          },
        }),
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
          ? "never: no automatic invalidation event; remains active after emit."
          : invalidation === "explicit_clear"
            ? "explicit_clear: becomes cleared after a clear event."
            : `${invalidation}: becomes superseded after the lifecycle event.`,
    },
  };
}

function samplePayload(
  contract: PlayPresetArtifactPayloadContract | undefined,
  contentType?: PlayPresetArtifactDeclaration["contentType"],
): unknown {
  if (contract === undefined) {
    if (contentType === "text/html")
      return "<p>This is a local HTML workbench sample.</p>";
    if (contentType === "text/markdown")
      return "# Example follow-up artifact\n\nThis is a local workbench preview sample.";
    if (contentType === "text/plain")
      return "This is a local text workbench sample.";
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
      return "Example text";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
  }
}
