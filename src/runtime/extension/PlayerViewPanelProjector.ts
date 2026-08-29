import type { ArtifactPayload } from "../artifact/FileNativeArtifactStore.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../../protocol/playerViews.ts";
import {
  projectPlayerViewPanelForFrontend,
  type FrontendExtensionBundle,
} from "./FrontendExtensionBundle.ts";
import type {
  PlayPresetBinding,
  PlayPresetPlayerViewPanel,
} from "../play/FileNativePlayPresetStore.ts";

export interface FrontendPlayerViewPanelProjection {
  panelId: string;
  worldId: string;
  preset: { id: string; revision: string };
  lifecycle: "current_preset";
  source: { kind: "player_view"; viewId: string; itemIds?: string[] };
  authority: "committed_player_view_projection";
  head: string;
  channel: string;
  key: string;
  contentType: "application/json";
  payload: ArtifactPayload;
  projection: "upsert";
  diagnostics: PlayerViewDiagnostic[];
  frontend: FrontendExtensionBundle;
}

export interface PlayerViewPanelProjectionInput {
  worldId: string;
  head: string;
  playerViews: {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  };
  binding: PlayPresetBinding;
}

/**
 * Deep projection seam for author-declared panels backed by committed player
 * views.  The projector only receives the already-safe view result; it never
 * opens world files or guesses a selector.  The selected preset is explicit
 * current-preset state, unlike operation-frozen artifact bundles.
 */
export function projectPlayerViewPanels(
  input: PlayerViewPanelProjectionInput,
): FrontendPlayerViewPanelProjection[] {
  return input.binding.definition.playerViewPanels.map((panel) =>
    projectPanel(panel, input),
  );
}

function projectPanel(
  panel: PlayPresetPlayerViewPanel,
  input: PlayerViewPanelProjectionInput,
): FrontendPlayerViewPanelProjection {
  const view = input.playerViews.views.find(
    (candidate) => candidate.id === panel.source.view,
  );
  const diagnostics = input.playerViews.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.viewId === undefined ||
        diagnostic.viewId === panel.source.view,
    )
    .map((diagnostic) => ({ ...diagnostic }));
  const items = selectItems(view, panel);
  const addUnresolved = (itemId: string | undefined, message: string) => {
    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unresolved_selector" &&
          diagnostic.viewId === panel.source.view &&
          diagnostic.itemId === itemId,
      )
    )
      return;
    diagnostics.push({
      code: "unresolved_selector",
      viewId: panel.source.view,
      ...(itemId === undefined ? {} : { itemId }),
      message,
    });
  };
  if (view === undefined)
    addUnresolved(
      undefined,
      `The exact player view cannot currently be resolved: ${panel.source.view}`,
    );
  const selectedItemIds = new Set(items.map(({ id }) => id));
  for (const itemId of panel.source.itemIds ?? [])
    if (!selectedItemIds.has(itemId))
      addUnresolved(
        itemId,
        `The exact selector cannot currently be resolved: ${panel.source.view}/${itemId}`,
      );
  for (const group of panel.config.groups)
    for (const itemId of group.itemIds)
      if (!selectedItemIds.has(itemId))
        addUnresolved(
          itemId,
          `An item referenced by the player-view group cannot currently be resolved: ${panel.source.view}/${itemId}`,
        );
  const frontend = projectPlayerViewPanelForFrontend(panel, input.binding);
  const payload: ArtifactPayload = {
    panelId: panel.id,
    title: panel.config.title ?? view?.title ?? panel.source.view,
    viewId: panel.source.view,
    items: items.map(({ id, label, value }) => ({
      id,
      label,
      value: toArtifactPayload(value),
    })),
    config: {
      layout: panel.config.layout,
      theme: panel.config.theme,
      empty: panel.config.empty,
      emptyMessage: panel.config.emptyMessage,
      groups: panel.config.groups.map((group) => ({
        id: group.id,
        label: group.label,
        itemIds: [...group.itemIds],
      })),
    },
    diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    provenance: {
      kind: "committed_player_view_projection",
      lifecycle: "current_preset",
      head: input.head,
    },
  };
  return {
    panelId: panel.id,
    worldId: input.worldId,
    preset: { id: input.binding.id, revision: input.binding.revision },
    lifecycle: "current_preset",
    source: {
      kind: "player_view",
      viewId: panel.source.view,
      ...(panel.source.itemIds === undefined
        ? {}
        : { itemIds: [...panel.source.itemIds] }),
    },
    authority: "committed_player_view_projection",
    head: input.head,
    channel: panel.channel,
    key: panel.key,
    contentType: "application/json",
    payload,
    projection: "upsert",
    diagnostics,
    frontend,
  };
}

function selectItems(
  view: RenderedPlayerView | undefined,
  panel: PlayPresetPlayerViewPanel,
): RenderedPlayerView["items"] {
  if (view === undefined) return [];
  if (panel.source.itemIds === undefined) return view.items;
  const byId = new Map(view.items.map((item) => [item.id, item]));
  return panel.source.itemIds.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
}

function toArtifactPayload(value: unknown, depth = 0): ArtifactPayload {
  if (depth > 16) return "[UI depth limit reached]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value.map((entry) => toArtifactPayload(entry, depth + 1));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        toArtifactPayload(child, depth + 1),
      ]),
    );
  return "[Unable to display]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
