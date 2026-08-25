import type { FileNativeStateChange } from "./FileNativeWorldStore.ts";
import {
  WorldDocumentStore,
  type WorldDocumentRevisionChange,
  type WorldDocumentRevisionRequest,
  type WorldDocumentRevisionResult,
} from "./WorldDocumentStore.ts";

export interface WorldStateRevision {
  snapshot: WorldDocumentStore;
  files: Record<string, string>;
  readonly changes: Map<string, WorldDocumentRevisionChange>;
}

export function beginWorldStateRevision(
  files: Readonly<Record<string, string>>,
): WorldStateRevision {
  const snapshot = WorldDocumentStore.open({
    layout: "world_state",
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      contents,
    })),
  });
  return {
    snapshot,
    files: revisionFileRecord(snapshot),
    changes: new Map(),
  };
}

export function reviseWorldState(
  candidate: WorldStateRevision,
  request: WorldDocumentRevisionRequest,
): WorldDocumentRevisionResult {
  const revised = candidate.snapshot.revise(request);
  return acceptWorldStateRevision(candidate, revised);
}

export function acceptWorldStateRevision(
  candidate: WorldStateRevision,
  revised: WorldDocumentRevisionResult,
): WorldDocumentRevisionResult {
  if (!revised.ok || revised.snapshotStatus !== "usable") return revised;
  if (revised.sourceSnapshotId !== candidate.snapshot.id)
    throw new Error("revision 结果不属于当前候选快照");

  candidate.snapshot = revised.snapshot;
  candidate.files = revisionFileRecord(revised.snapshot);
  for (const change of revised.changes) {
    const previous = candidate.changes.get(change.documentId);
    const accumulated: WorldDocumentRevisionChange = {
      ...change,
      before: previous === undefined ? change.before : previous.before,
    };
    if (
      accumulated.before !== null &&
      accumulated.before.logicalPath === accumulated.after.logicalPath &&
      accumulated.before.mechanicalHash === accumulated.after.mechanicalHash &&
      accumulated.before.contents === accumulated.after.contents
    )
      candidate.changes.delete(change.documentId);
    else candidate.changes.set(change.documentId, Object.freeze(accumulated));
  }
  return revised;
}

export function worldStateRevisionChanges(
  candidate: WorldStateRevision,
): readonly WorldDocumentRevisionChange[] {
  return [...candidate.changes.values()].sort((left, right) =>
    left.after.logicalPath.localeCompare(right.after.logicalPath),
  );
}

export function fileNativeStateChanges(
  candidate: WorldStateRevision,
): FileNativeStateChange[] {
  if (candidate.snapshot.status !== "usable")
    throw new Error("只有 usable world state revision 可以形成提交载荷");
  return worldStateRevisionChanges(candidate).map((change) => {
    const prefix = "state/";
    if (!change.after.logicalPath.startsWith(prefix))
      throw new Error("世界 state revision 返回了布局外路径");
    return {
      kind: change.before === null ? "create" : "replace",
      documentId: change.documentId,
      stableShortRef: change.shortRef,
      relativePath: change.after.logicalPath.slice(prefix.length),
      codec: change.codec,
      expectedPreviousHash: change.before?.mechanicalHash ?? null,
      nextHash: change.after.mechanicalHash,
      canonicalNextBytes: change.after.contents,
    };
  });
}

export function worldDocumentRevisionFailureMessage(
  diagnostics: readonly { readonly message: string }[],
): string {
  return (
    diagnostics.map(({ message }) => message).join("；") || "revision 无效"
  );
}

function revisionFileRecord(
  snapshot: WorldDocumentStore,
): Record<string, string> {
  return Object.fromEntries(
    snapshot.files.map((file) => {
      if (file.encoding !== undefined)
        throw new Error("世界 state revision 不接受二进制候选文件");
      return [file.path, file.contents];
    }),
  );
}
