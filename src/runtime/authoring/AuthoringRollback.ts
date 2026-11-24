import type { V1SettingAuthoringDiff } from "../../protocol/v1.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";

/** Plans one before-image restore. The target validates and publishes the candidate. */
export function planAuthoringRollback(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): { files: ContentTreeFile[]; diff: V1SettingAuthoringDiff } | null {
  const restored = new Map(files.map((file) => [file.path, file] as const));
  const current = restored.get(change.path);
  const after = change.before;
  if (
    after === null
      ? current === undefined
      : current?.contents === after && current.encoding === undefined
  )
    return null;
  if (after === null) restored.delete(change.path);
  else restored.set(change.path, { path: change.path, contents: after });
  const before = current?.contents ?? null;
  return {
    files: [...restored.values()]
      .map((file) => structuredClone(file))
      .sort((left, right) => left.path.localeCompare(right.path)),
    diff: {
      path: change.path,
      kind: before === null ? "create" : after === null ? "delete" : "modify",
      before,
      after,
    },
  };
}
