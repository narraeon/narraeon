import type {
  ArtifactDebugRecord,
  ArtifactProjectionItem,
} from "../artifact/FileNativeArtifactStore.ts";
import {
  parsePlayPresetRegexAsset,
  type PlayPresetArtifactDeclaration,
  type PlayPresetArtifactPayloadContract,
  type PlayPresetBinding,
  type PlayPresetMount,
  type PlayPresetPlayerViewPanel,
  type PlayPresetRegexRule,
} from "../play/FileNativePlayPresetStore.ts";

/**
 * The only Runtime-to-Web description of an artifact extension. It contains
 * frozen, renderable resources, never a preset path, prompt, provider state,
 * transcript, Authority object, or filesystem capability.
 */
export type FrontendExtensionBundleStatus =
  "ready" | "missing_revision" | "invalid_revision" | "missing_declaration";

export interface FrontendExtensionRenderer {
  mode: "document" | "app";
  revision?: string;
  document?: string;
  scripts: string[];
  assets: { id: string; source: string }[];
  trustedLocalCode: boolean;
}

export interface FrontendExtensionDeclaration {
  outputName: string;
  channel: string;
  key?: string;
  contentType: PlayPresetArtifactDeclaration["contentType"];
  projection: PlayPresetArtifactDeclaration["strategy"];
  save: PlayPresetArtifactDeclaration["save"];
  invalidation: PlayPresetArtifactDeclaration["invalidation"];
  required: boolean;
  maxEmits: number;
  payloadContract?: PlayPresetArtifactPayloadContract;
  rendererMode: "document" | "app";
}

export interface FrontendExtensionBundle {
  status: FrontendExtensionBundleStatus;
  preset: { id: string; revision: string };
  /** The source namespace is part of the safe projection contract. */
  source?: "artifact" | "player_view";
  authority?: "non_authoritative_artifact" | "committed_player_view_projection";
  lifecycle?: "operation_frozen" | "current_preset";
  mount?: PlayPresetMount["mount"];
  declaration?: FrontendExtensionDeclaration;
  regex: PlayPresetRegexRule[];
  renderer?: FrontendExtensionRenderer;
  trustedLocalCode: boolean;
  fallback: "none" | "raw";
  diagnostic?: string;
}

export interface FrontendArtifactProjection extends ArtifactProjectionItem {
  frontend: FrontendExtensionBundle;
}

export interface FrontendArtifactDebugRecord extends ArtifactDebugRecord {
  frontend: FrontendExtensionBundle;
}

export type FrontendBundleFailure = "missing_revision" | "invalid_revision";

export function projectArtifactForFrontend(
  artifact: ArtifactProjectionItem | ArtifactDebugRecord,
  binding: PlayPresetBinding | null,
  failure: FrontendBundleFailure = "missing_revision",
): FrontendExtensionBundle {
  const preset = {
    id: artifact.playPresetId,
    revision: artifact.playPresetRevision,
  };
  if (binding === null)
    return missingBundle(
      preset,
      "The frozen play-preset revision is unavailable and cannot be replaced with the current revision",
      failure,
    );
  if (
    binding.id !== artifact.playPresetId ||
    binding.revision !== artifact.playPresetRevision
  )
    return missingBundle(
      preset,
      "The play-preset binding does not match the artifact's frozen identity",
      "invalid_revision",
    );

  const followup = binding.definition.followups.find(
    ({ id }) => id === artifact.requestId,
  );
  const declaration = followup?.artifacts.find(
    ({ name }) => name === artifact.output,
  );
  if (declaration === undefined)
    return {
      ...missingBundle(
        preset,
        "The artifact declaration is missing from the frozen revision",
      ),
      status: "missing_declaration",
    };

  if (!artifactMatchesDeclaration(artifact, declaration))
    return {
      ...missingBundle(
        preset,
        "The raw artifact contract does not match the frozen declaration",
        "invalid_revision",
      ),
      status: "invalid_revision",
    };

  try {
    const frozenBinding: PlayPresetBinding = {
      ...binding,
      scriptsEnabled: artifact.playPresetScriptsEnabled,
    };
    const regex = declaration.regex
      ? parsePlayPresetRegexAsset(
          frozenBinding.files[declaration.regex] ??
            (() => {
              throw new Error("The frozen regex resource does not exist");
            })(),
          declaration.regex,
        )
      : [];
    const renderer = resolveRenderer(declaration, frozenBinding);
    const mount = frozenBinding.definition.mounts.find(
      ({ channel }) => channel === declaration.channel,
    )?.mount;
    return {
      status: "ready",
      preset,
      source: "artifact",
      authority: "non_authoritative_artifact",
      lifecycle: "operation_frozen",
      ...(mount === undefined ? {} : { mount }),
      declaration: declarationView(declaration),
      regex,
      ...(renderer === undefined ? {} : { renderer }),
      trustedLocalCode: artifact.playPresetScriptsEnabled,
      fallback: "none",
    };
  } catch {
    return {
      ...missingBundle(
        preset,
        "The frozen extension resource is invalid",
        "invalid_revision",
      ),
      status: "invalid_revision",
    };
  }
}

/**
 * Project a current-preset player-view panel through the same frozen-resource
 * bundle seam as follow-up artifacts. Its lifecycle is explicit: it follows the
 * currently selected preset, while historical artifacts continue to use their
 * own operation-frozen revision.
 */
export function projectPlayerViewPanelForFrontend(
  panel: PlayPresetPlayerViewPanel,
  binding: PlayPresetBinding | null,
  failure: FrontendBundleFailure = "missing_revision",
): FrontendExtensionBundle {
  const preset =
    binding === null
      ? { id: "unknown", revision: "unknown" }
      : { id: binding.id, revision: binding.revision };
  if (binding === null)
    return {
      ...missingBundle(
        preset,
        "The current play-preset revision is unavailable, and player-view panels cannot use another revision",
        failure,
      ),
      source: "player_view",
      lifecycle: "current_preset",
    };
  try {
    const regex = panel.regex
      ? parsePlayPresetRegexAsset(
          binding.files[panel.regex] ??
            (() => {
              throw new Error("The frozen regex resource does not exist");
            })(),
          panel.regex,
        )
      : [];
    const renderer = resolvePlayerViewRenderer(panel, binding);
    return {
      status: "ready",
      preset,
      source: "player_view",
      authority: "committed_player_view_projection",
      lifecycle: "current_preset",
      mount: panel.mount,
      declaration: {
        outputName: panel.id,
        channel: panel.channel,
        key: panel.key,
        contentType: "application/json",
        projection: "upsert",
        save: "none",
        invalidation: "never",
        required: false,
        maxEmits: 1,
        rendererMode: panel.rendererMode,
      },
      regex,
      ...(renderer === undefined ? {} : { renderer }),
      trustedLocalCode: renderer?.trustedLocalCode ?? false,
      fallback: "none",
    };
  } catch (error: unknown) {
    return {
      ...missingBundle(
        preset,
        error instanceof Error
          ? error.message
          : "The frozen player-view panel resource is invalid",
        "invalid_revision",
      ),
      source: "player_view",
      lifecycle: "current_preset",
    };
  }
}

function artifactMatchesDeclaration(
  artifact: ArtifactProjectionItem | ArtifactDebugRecord,
  declaration: PlayPresetArtifactDeclaration,
): boolean {
  return (
    artifact.output === declaration.name &&
    artifact.channel === declaration.channel &&
    (artifact.key ?? undefined) === (declaration.key ?? undefined) &&
    artifact.contentType === declaration.contentType &&
    artifact.projection === declaration.strategy &&
    artifact.save === declaration.save &&
    (artifact.renderer ?? undefined) === (declaration.renderer ?? undefined) &&
    (artifact.rendererRevision ?? undefined) ===
      (declaration.rendererRevision ?? undefined)
  );
}

export function projectDebugArtifactForFrontend(
  artifact: ArtifactDebugRecord,
  binding: PlayPresetBinding | null,
  failure: FrontendBundleFailure = "missing_revision",
): FrontendExtensionBundle {
  return projectArtifactForFrontend(artifact, binding, failure);
}

function declarationView(
  declaration: PlayPresetArtifactDeclaration,
): FrontendExtensionDeclaration {
  return {
    outputName: declaration.name,
    channel: declaration.channel,
    ...(declaration.key === undefined ? {} : { key: declaration.key }),
    contentType: declaration.contentType,
    projection: declaration.strategy,
    save: declaration.save,
    invalidation: declaration.invalidation,
    required: declaration.required,
    maxEmits: declaration.maxEmits,
    ...(declaration.payloadContract === undefined
      ? {}
      : { payloadContract: structuredClone(declaration.payloadContract) }),
    rendererMode: declaration.rendererMode ?? "document",
  };
}

function resolveRenderer(
  declaration: PlayPresetArtifactDeclaration,
  binding: PlayPresetBinding,
): FrontendExtensionRenderer | undefined {
  const mode = declaration.rendererMode ?? "document";
  const rendererSource = declaration.renderer
    ? binding.files[declaration.renderer]
    : undefined;
  if (declaration.renderer !== undefined && rendererSource === undefined)
    throw new Error("The frozen renderer resource does not exist");
  const scriptSources = (declaration.scripts ?? []).map((path) => {
    const source = binding.files[path];
    if (source === undefined)
      throw new Error("The frozen script resource does not exist");
    return source;
  });
  const scripts = binding.scriptsEnabled ? scriptSources : [];
  const assets = (declaration.assets ?? []).map((path) => {
    const source = binding.files[path];
    if (source === undefined)
      throw new Error("The frozen asset resource does not exist");
    // This is a frozen, author-visible logical asset id, not a machine path.
    // Keeping the preset-relative declaration key stable lets app renderers
    // refer to `window.__NARRAEON_ASSETS__[id]` across exchanges/revisions.
    return { id: path, source };
  });
  if (
    rendererSource === undefined &&
    scripts.length === 0 &&
    assets.length === 0
  )
    return undefined;
  return {
    mode,
    ...(declaration.rendererRevision === undefined
      ? {}
      : { revision: declaration.rendererRevision }),
    ...(rendererSource === undefined ? {} : { document: rendererSource }),
    scripts,
    assets,
    trustedLocalCode: binding.scriptsEnabled,
  };
}

function resolvePlayerViewRenderer(
  panel: PlayPresetPlayerViewPanel,
  binding: PlayPresetBinding,
): FrontendExtensionRenderer | undefined {
  const rendererSource = panel.renderer
    ? binding.files[panel.renderer]
    : undefined;
  if (panel.renderer !== undefined && rendererSource === undefined)
    throw new Error("The frozen player-view renderer resource does not exist");
  const scriptSources = (panel.scripts ?? []).map((path) => {
    const source = binding.files[path];
    if (source === undefined)
      throw new Error("The frozen player-view script resource does not exist");
    return source;
  });
  const scripts = binding.scriptsEnabled ? scriptSources : [];
  const assets = (panel.assets ?? []).map((path) => {
    const source = binding.files[path];
    if (source === undefined)
      throw new Error("The frozen player-view asset resource does not exist");
    return { id: path, source };
  });
  if (
    rendererSource === undefined &&
    scripts.length === 0 &&
    assets.length === 0
  )
    return undefined;
  return {
    mode: panel.rendererMode,
    ...(panel.rendererRevision === undefined
      ? {}
      : { revision: panel.rendererRevision }),
    ...(rendererSource === undefined ? {} : { document: rendererSource }),
    scripts,
    assets,
    trustedLocalCode: binding.scriptsEnabled,
  };
}

function missingBundle(
  preset: { id: string; revision: string },
  diagnostic: string,
  status: FrontendBundleFailure = "missing_revision",
): FrontendExtensionBundle {
  return {
    status,
    preset,
    regex: [],
    trustedLocalCode: false,
    fallback: "raw",
    diagnostic,
  };
}
