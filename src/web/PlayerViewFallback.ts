import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../protocol/playerViews.ts";
import type { FrontendPlayerViewPanelProjection } from "./ArtifactExtensionHost.tsx";

export function projectUncoveredPlayerViews(
  playerViews: {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  },
  panels: readonly Pick<FrontendPlayerViewPanelProjection, "source">[],
  suppressedViewIds: readonly string[] = [],
): {
  coveredViewIds: Set<string>;
  views: RenderedPlayerView[];
  diagnostics: PlayerViewDiagnostic[];
} {
  const coveredViewIds = new Set([
    ...panels.map(({ source }) => source.viewId),
    ...suppressedViewIds,
  ]);
  return {
    coveredViewIds,
    views: playerViews.views.filter(({ id }) => !coveredViewIds.has(id)),
    diagnostics: playerViews.diagnostics.filter(
      ({ viewId }) => viewId === undefined || !coveredViewIds.has(viewId),
    ),
  };
}
