import { isDeepStrictEqual } from "node:util";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { RenderedPlayerView } from "../../protocol/playerViews.ts";
import {
  builtinExtensionLabel,
  builtinExtensionTemplateForLocale,
  builtinStatusPanelId,
} from "../../shared/first-party-play-preset-templates.ts";
import type { BuiltinExtensionFollowupId } from "../../shared/ordered-followups.ts";
import {
  parsePlayPresetFiles,
  revisionForPlayPresetFiles,
  type FrozenArtifactPresentation,
  type PlayPresetBinding,
  type PlayPresetDefinition,
} from "../play/FileNativePlayPresetStore.ts";

const catalog = new Map<
  string,
  { definition: PlayPresetDefinition; entryId: string }
>();

// Keep released renderer fingerprints so a later template update can render
// historical frozen output with the exact reviewed code it shipped with.
const trustedActionRendererRevisions = new Set([
  "rev-39e4dd3fc00a95434c024dc502a73ba646cdf57771dab41887379f20d293abb2", // en
  "rev-7bc2f4c0f7ed35a7abe34dade3c8eba4e9e862e65526e516bc93513794a194a6", // zh-CN
]);

function shippedDefinition(
  id: BuiltinExtensionFollowupId | typeof builtinStatusPanelId,
  locale: AppLocale,
) {
  const key = `${id}:${locale}`;
  const loaded = catalog.get(key);
  if (loaded !== undefined) return loaded;
  const { files, entryId } = builtinExtensionTemplateForLocale(id, locale);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  const entry = { definition: parsed.definition, entryId };
  catalog.set(key, entry);
  return entry;
}

export function builtinExtensionFollowup(
  id: BuiltinExtensionFollowupId,
  locale: AppLocale,
) {
  const { definition, entryId } = shippedDefinition(id, locale);
  const request = definition.followups.find((entry) => entry.id === entryId)!;
  const artifacts = request.artifacts.map((artifact) => ({
    ...artifact,
    channel: `${id}:${artifact.channel}`,
  }));
  const frozenPresentations = Object.fromEntries(
    artifacts.map(
      (declaration, index): [string, FrozenArtifactPresentation] => {
        const mount = definition.mounts.find(
          (entry) => entry.channel === request.artifacts[index]!.channel,
        )!.mount;
        const paths = [
          declaration.renderer,
          declaration.regex,
          ...(declaration.scripts ?? []),
          ...(declaration.assets ?? []),
        ];
        const files = Object.fromEntries(
          paths.flatMap((path) =>
            path === undefined ? [] : [[path, definition.files[path]!]],
          ),
        );
        return [declaration.name, { declaration, files, mount }];
      },
    ),
  );
  return {
    definition: {
      ...request,
      id,
      displayName: builtinExtensionLabel(id, locale),
      artifacts,
    },
    body: definition.files[request.prompt.path],
    frozenPresentations,
  };
}

/** Archive input and authored files cannot make themselves application code. */
export function trustedBuiltinFollowupCode(
  id: BuiltinExtensionFollowupId,
  presentation: FrozenArtifactPresentation | undefined,
): boolean {
  if (id !== "builtin:action-choices" || presentation === undefined)
    return false;
  const declaration = presentation.declaration;
  return (
    declaration.name === "player_options" &&
    declaration.rendererMode === "app" &&
    declaration.renderer === "renderers/player-options.html" &&
    isDeepStrictEqual(declaration.scripts, ["scripts/player-options.js"]) &&
    isDeepStrictEqual(declaration.assets, ["assets/player-options.css"]) &&
    trustedActionRendererRevisions.has(
      revisionForPlayPresetFiles(presentation.files),
    )
  );
}

/** Existing author panels retain ownership of their exact selectors. */
export function builtinStatusPanelView(
  binding: PlayPresetBinding,
  views: readonly RenderedPlayerView[],
): RenderedPlayerView | undefined {
  const covered = new Set(
    binding.definition.playerViewPanels.map((panel) => panel.source.view),
  );
  const available = views.filter((view) => !covered.has(view.id));
  return (
    available.find((view) => view.id === "status") ??
    available.find((view) => view.id === "scene-status") ??
    available[0]
  );
}

export function builtinStatusPanel(
  binding: PlayPresetBinding,
  viewId: string,
  locale: AppLocale,
) {
  const { definition, entryId } = shippedDefinition(
    builtinStatusPanelId,
    locale,
  );
  const panel = definition.playerViewPanels.find(
    (entry) => entry.id === entryId,
  )!;
  return {
    panel: {
      ...panel,
      id: builtinStatusPanelId,
      channel: builtinStatusPanelId,
      source: { ...panel.source, view: viewId },
    },
    binding: { ...binding, files: definition.files, scriptsEnabled: true },
  };
}
