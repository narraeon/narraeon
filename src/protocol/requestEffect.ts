import type { V1Request } from "./v1.ts";

// Reads and disposable previews/exports can be repeated without changing the user's records.
const reads = new Set<V1Request["type"]>([
  "workspace.read",
  "preferences.read",
  "protagonist-templates.read",
  "model.read",
  "model.models",
  "content.read",
  "content.scripts.read",
  "content.export",
  "content.sillytavern.inspect",
  "content.sillytavern.preview",
  "setting-improvement.read",
  "setting-improvement.status",
  "setting-improvement.overview",
  "setting-improvement.preview",
  "setting-improvement.session.read",
  "play.read",
  "play.export",
  "play.workbench.read",
  "play.sillytavern.inspect",
  "play.sillytavern.preview",
  "prompt.preview",
  "world.read",
  "world.package-scripts.read",
  "world.archive.export",
  "world.story.export",
  "world.creation-outcome",
  "world.extensions.read",
  "world.play-decorations.read",
  "world.surface.read",
  "world.control-draft.preview",
  "world.revision.overview",
  "world.revision.preview",
  "world.revision.status",
  "world.revision.session.read",
  "world.play-context.read",
  "play.chain.inspect",
  "play.timeline.page",
  "play.timeline.context",
  "play.timeline.detail",
  "artifacts.read",
  "artifacts.debug",
  "correction.read",
  "correction.preview",
]);

/** An unclassified command may have changed user records even when its response was lost. */
export function mayChangeUserState(type: V1Request["type"]): boolean {
  return !reads.has(type);
}
