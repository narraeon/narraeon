import { createHash } from "node:crypto";

import type { V1SettingAuthoringDiff } from "../../protocol/v1.ts";
import type { V1WorldRevisionSealedEpochView } from "../../protocol/v1.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { contentTreeFingerprint } from "../content/ContentTreeFingerprint.ts";
import type {
  FileNativeOperationOutcome,
  FileNativeStateChange,
  FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";
import type { WorldRevisionLockHandle } from "../world/WorldOperationCoordinator.ts";
import { WorldOperationClaimLostError } from "../world/WorldOperationCoordinator.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import type {
  FileNativeWorldRevisionStore,
  StoredWorldRevisionChangeSet,
  StoredWorldRevisionEpoch,
  StoredWorldRevisionToolResult,
} from "./FileNativeWorldRevisionStore.ts";
import {
  assertUsableWorldRevisionFiles,
  inspectWorldRevisionFiles,
} from "./WorldRevisionAuthoringTransaction.ts";

export class WorldRevisionWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorldRevisionWorkspaceError";
  }
}

export interface WorldRevisionEpochView {
  epochId: string;
  worldId: string;
  lifecycle: StoredWorldRevisionEpoch["lifecycle"];
  locked: boolean;
  baseHead: string;
  revision: string;
  files: ContentTreeFile[];
  diff: V1SettingAuthoringDiff[];
  diagnostics: { code: string; path: string; message: string }[];
  changes: StoredWorldRevisionChangeSet[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  appliedHead: string | null;
}

/** Owns the one persistent state/control worktree for a locked world. */
export class WorldRevisionWorkspace {
  readonly #store: FileNativeWorldRevisionStore;
  readonly #worlds: FileNativeWorldStore;

  constructor(input: {
    store: FileNativeWorldRevisionStore;
    worlds: FileNativeWorldStore;
  }) {
    this.#store = input.store;
    this.#worlds = input.worlds;
  }

  async open(worldId: string): Promise<StoredWorldRevisionEpoch> {
    const locked = await this.#worlds.readWorldRevisionLock(worldId);
    if (locked !== null) {
      const resumed = await this.#resumeLocked(locked);
      return resumed.lifecycle === "active" ? resumed : this.open(worldId);
    }

    const epochId = this.#store.createEpochId();
    const acquired = await this.#worlds.acquireWorldRevisionLock(
      worldId,
      epochId,
    );
    if (acquired.kind === "busy") {
      const current = await this.#worlds.readWorldRevisionLock(worldId);
      if (current === null)
        throw new WorldRevisionWorkspaceError(
          "Another world operation is still finishing; retry opening the revision",
        );
      const resumed = await this.#resumeLocked(current);
      return resumed.lifecycle === "active" ? resumed : this.open(worldId);
    }
    try {
      return await this.#resumeLocked(acquired.handle);
    } catch (error: unknown) {
      await this.#worlds.releaseWorldRevisionLock(acquired.handle);
      throw error;
    }
  }

  async active(worldId: string): Promise<StoredWorldRevisionEpoch | null> {
    const handle = await this.#worlds.readWorldRevisionLock(worldId);
    if (handle === null) return null;
    const resumed = await this.#resumeLocked(handle);
    return resumed.lifecycle === "active" ? resumed : null;
  }

  async latest(worldId: string): Promise<StoredWorldRevisionEpoch | null> {
    return (await this.#store.listEpochs(worldId))[0] ?? null;
  }

  async sealed(worldId: string): Promise<V1WorldRevisionSealedEpochView[]> {
    return (await this.#store.listEpochs(worldId)).flatMap((epoch) => {
      if (
        (epoch.lifecycle !== "applied" && epoch.lifecycle !== "discarded") ||
        epoch.finishedAt === null
      )
        return [];
      return [
        {
          epochId: epoch.epochId,
          worldId: epoch.worldId,
          lifecycle: epoch.lifecycle,
          baseHead: epoch.baseHead,
          diff: fileDiff(epoch.baseFiles, epoch.files),
          changes: structuredClone(epoch.changes),
          createdAt: epoch.createdAt,
          finishedAt: epoch.finishedAt,
          appliedHead: epoch.apply?.committedHead ?? null,
        },
      ];
    });
  }

  async replace(input: {
    worldId: string;
    epochId: string;
    expectedRevision: string;
    files: readonly ContentTreeFile[];
  }): Promise<StoredWorldRevisionEpoch> {
    const handle = revisionHandle(input);
    return this.#withMutableEpoch(handle, async (epoch) => {
      assertExpectedRevision(epoch, input.expectedRevision);
      const files = cloneFiles(input.files);
      assertUsableWorldRevisionFiles(files, epoch.baseFiles);
      const changes = fileDiff(epoch.files, files);
      if (changes.length === 0) return epoch;
      epoch.files = files;
      epoch.revision = contentTreeFingerprint(files);
      epoch.changes.push({
        changeSetId: this.#store.createChangeSetId(),
        source: "manual",
        createdAt: Date.now(),
        changes,
      });
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async publishAi(input: {
    worldId: string;
    epochId: string;
    expectedRevision: string;
    afterRevision: string;
    files: readonly ContentTreeFile[];
    toolResults: readonly StoredWorldRevisionToolResult[];
  }): Promise<StoredWorldRevisionEpoch> {
    const handle = revisionHandle(input);
    return this.#withMutableEpoch(handle, async (epoch) => {
      if (epoch.revision === input.afterRevision) {
        const ids = input.toolResults.flatMap(({ changeSetId }) =>
          changeSetId === null ? [] : [changeSetId],
        );
        if (
          ids.every((id) =>
            epoch.changes.some(({ changeSetId }) => changeSetId === id),
          )
        )
          return epoch;
      }
      assertExpectedRevision(epoch, input.expectedRevision);
      const files = cloneFiles(input.files);
      assertUsableWorldRevisionFiles(files, epoch.baseFiles);
      if (contentTreeFingerprint(files) !== input.afterRevision)
        throw new WorldRevisionWorkspaceError(
          "Prepared AI publication does not match its revision fingerprint",
        );
      for (const result of input.toolResults) {
        if (
          result.isError ||
          result.changeSetId === null ||
          result.changes.length === 0
        )
          continue;
        epoch.changes.push({
          changeSetId: result.changeSetId,
          source: "ai",
          createdAt: Date.now(),
          changes: structuredClone(result.changes),
        });
      }
      epoch.files = files;
      epoch.revision = input.afterRevision;
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async rollback(input: {
    worldId: string;
    epochId: string;
    changeSetId: string;
    path: string;
  }): Promise<{
    status: "rolled_back" | "already_rolled_back";
    changeSetId: string;
    path: string;
    changes: V1SettingAuthoringDiff[];
    epoch: StoredWorldRevisionEpoch;
  }> {
    const handle = revisionHandle(input);
    return this.#withMutableEpoch(handle, async (epoch) => {
      const set = epoch.changes.find(
        ({ changeSetId }) => changeSetId === input.changeSetId,
      );
      const matches = set?.changes.filter(({ path }) => path === input.path);
      const change = matches?.[0];
      if (set === undefined || matches?.length !== 1 || change === undefined)
        throw new WorldRevisionWorkspaceError(
          "The requested file change does not exist in this revision epoch",
        );
      if (fileMatchesBefore(epoch.files, change))
        return {
          status: "already_rolled_back",
          changeSetId: input.changeSetId,
          path: input.path,
          changes: [],
          epoch,
        };
      const inverse = inverseDiff(epoch.files, change);
      const files = restoreBefore(epoch.files, change);
      assertUsableWorldRevisionFiles(files, epoch.baseFiles);
      epoch.files = files;
      epoch.revision = contentTreeFingerprint(files);
      epoch.changes.push({
        changeSetId: this.#store.createChangeSetId(),
        source: "rollback",
        createdAt: Date.now(),
        changes: [inverse],
      });
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return {
        status: "rolled_back",
        changeSetId: input.changeSetId,
        path: input.path,
        changes: [inverse],
        epoch,
      };
    });
  }

  async discard(input: {
    worldId: string;
    epochId: string;
  }): Promise<StoredWorldRevisionEpoch> {
    const handle = revisionHandle(input);
    const epoch = await this.#withMutableEpoch(handle, async (current) => {
      current.lifecycle = "discarded";
      current.finishedAt = Date.now();
      current.updatedAt = current.finishedAt;
      await this.#store.saveEpoch(current);
      return current;
    });
    await this.#worlds.releaseWorldRevisionLock(handle);
    return epoch;
  }

  async apply(input: {
    worldId: string;
    epochId: string;
    expectedRevision: string;
  }): Promise<StoredWorldRevisionEpoch> {
    const handle = revisionHandle(input);
    let epoch = await this.#prepareApply(handle, input.expectedRevision);
    const overallDiff = fileDiff(epoch.baseFiles, epoch.files);
    if (overallDiff.length === 0) {
      epoch = await this.#finishEmptyApply(handle);
      await this.#worlds.releaseWorldRevisionLock(handle);
      return epoch;
    }

    if (epoch.apply?.phase === "prepared") {
      const binding = await this.#worlds.bindWorldRevision(handle);
      const outcome = await this.#worlds.commitCorrection({
        operationId: epoch.apply.operationId,
        worldId: epoch.worldId,
        parentHead: epoch.baseHead,
        nextMaterials: binding.additionalMaterials,
        stateChanges: stateChanges(epoch.baseFiles, epoch.files),
        worldRevisionLock: handle,
        validationControl: controlFiles(epoch.files),
      });
      epoch = await this.#recordStateCommit(handle, outcome);
    }

    if (epoch.apply?.phase === "state_committed") {
      await this.#worlds.replaceWorldRevisionControl({
        handle,
        expectedFingerprint: epoch.baseControlFingerprint,
        files: controlFiles(epoch.files),
      });
      await this.#recordControlPublication(handle);
    }

    epoch = await this.#finishApply(handle);
    await this.#worlds.releaseWorldRevisionLock(handle);
    return epoch;
  }

  view(
    epoch: StoredWorldRevisionEpoch,
    locked: boolean,
  ): WorldRevisionEpochView {
    const inspection = inspectWorldRevisionFiles(epoch.files, epoch.baseFiles);
    return {
      epochId: epoch.epochId,
      worldId: epoch.worldId,
      lifecycle: epoch.lifecycle,
      locked,
      baseHead: epoch.baseHead,
      revision: epoch.revision,
      files: cloneFiles(epoch.files),
      diff: fileDiff(epoch.baseFiles, epoch.files),
      diagnostics: structuredClone(inspection.diagnostics),
      changes: structuredClone(epoch.changes),
      createdAt: epoch.createdAt,
      updatedAt: epoch.updatedAt,
      finishedAt: epoch.finishedAt,
      appliedHead: epoch.apply?.committedHead ?? null,
    };
  }

  async #resumeLocked(
    handle: WorldRevisionLockHandle,
  ): Promise<StoredWorldRevisionEpoch> {
    let epoch = await this.#store.readEpochIfPresent(handle.epochId);
    if (epoch === null) {
      const binding = await this.#worlds.bindWorldRevision(handle);
      const files = Object.entries(binding.files)
        .map(([path, contents]) => ({ path, contents }))
        .sort((left, right) => left.path.localeCompare(right.path));
      assertUsableWorldRevisionFiles(files, files);
      const now = Date.now();
      epoch = {
        schemaVersion: 1,
        epochId: handle.epochId,
        worldId: handle.worldId,
        lifecycle: "active",
        baseHead: binding.parentHead,
        baseControlFingerprint: controlFingerprint(controlFiles(files)),
        baseFiles: cloneFiles(files),
        files: cloneFiles(files),
        revision: contentTreeFingerprint(files),
        changes: [],
        apply: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      await this.#store.saveEpoch(epoch);
    }
    if (epoch.worldId !== handle.worldId)
      throw new WorldRevisionWorkspaceError(
        "World-revision lock points to another world's epoch",
      );
    if (epoch.lifecycle === "applying")
      return this.apply({
        worldId: epoch.worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.apply?.expectedRevision ?? epoch.revision,
      });
    if (epoch.lifecycle !== "active") {
      await this.#worlds.releaseWorldRevisionLock(handle);
      return epoch;
    }
    return epoch;
  }

  async #withMutableEpoch<Value>(
    handle: WorldRevisionLockHandle,
    action: (epoch: StoredWorldRevisionEpoch) => Promise<Value>,
  ): Promise<Value> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (epoch.worldId !== handle.worldId || epoch.lifecycle !== "active")
        throw new WorldRevisionWorkspaceError(
          "World-revision epoch is no longer editable",
        );
      return action(epoch);
    });
  }

  async #prepareApply(
    handle: WorldRevisionLockHandle,
    expectedRevision: string,
  ): Promise<StoredWorldRevisionEpoch> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (epoch.lifecycle === "applying") return epoch;
      if (epoch.lifecycle !== "active")
        throw new WorldRevisionWorkspaceError(
          "World-revision epoch is no longer applicable",
        );
      assertExpectedRevision(epoch, expectedRevision);
      assertUsableWorldRevisionFiles(epoch.files, epoch.baseFiles);
      epoch.lifecycle = "applying";
      epoch.apply = {
        operationId: `world-revision-${epoch.epochId}`,
        expectedRevision,
        phase: "prepared",
        committedHead: null,
      };
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async #finishEmptyApply(
    handle: WorldRevisionLockHandle,
  ): Promise<StoredWorldRevisionEpoch> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (epoch.lifecycle !== "applying" || epoch.apply === null)
        throw new WorldRevisionWorkspaceError(
          "Apply recovery state is damaged",
        );
      epoch.lifecycle = "applied";
      epoch.apply.phase = "control_published";
      epoch.apply.committedHead = epoch.baseHead;
      epoch.finishedAt = Date.now();
      epoch.updatedAt = epoch.finishedAt;
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async #recordStateCommit(
    handle: WorldRevisionLockHandle,
    outcome: Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >,
  ): Promise<StoredWorldRevisionEpoch> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (epoch.lifecycle !== "applying" || epoch.apply === null)
        throw new WorldRevisionWorkspaceError(
          "Apply recovery state is damaged",
        );
      epoch.apply.phase = "state_committed";
      epoch.apply.committedHead = outcome.head;
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async #recordControlPublication(
    handle: WorldRevisionLockHandle,
  ): Promise<StoredWorldRevisionEpoch> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (epoch.lifecycle !== "applying" || epoch.apply === null)
        throw new WorldRevisionWorkspaceError(
          "Apply recovery state is damaged",
        );
      epoch.apply.phase = "control_published";
      epoch.updatedAt = Date.now();
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async #finishApply(
    handle: WorldRevisionLockHandle,
  ): Promise<StoredWorldRevisionEpoch> {
    return this.#withRevisionOwnership(handle, async () => {
      const epoch = await this.#store.readEpoch(handle.epochId);
      if (
        epoch.lifecycle !== "applying" ||
        epoch.apply?.phase !== "control_published"
      )
        throw new WorldRevisionWorkspaceError(
          "Apply recovery state is damaged",
        );
      epoch.lifecycle = "applied";
      epoch.finishedAt = Date.now();
      epoch.updatedAt = epoch.finishedAt;
      await this.#store.saveEpoch(epoch);
      return epoch;
    });
  }

  async #withRevisionOwnership<Value>(
    handle: WorldRevisionLockHandle,
    action: () => Promise<Value>,
  ): Promise<Value> {
    try {
      return await this.#worlds.operations.withWorldRevisionLock(
        handle,
        action,
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationClaimLostError)
        throw new WorldRevisionWorkspaceError(
          "The world-revision epoch no longer owns this world's lock",
          { cause: error },
        );
      throw error;
    }
  }
}

function revisionHandle(input: {
  worldId: string;
  epochId: string;
}): WorldRevisionLockHandle {
  return { worldId: input.worldId, epochId: input.epochId };
}

function assertExpectedRevision(
  epoch: StoredWorldRevisionEpoch,
  expected: string,
): void {
  if (epoch.revision !== expected)
    throw new WorldRevisionWorkspaceError(
      "The world-revision worktree changed; refresh it before writing",
    );
}

function stateChanges(
  baseFiles: readonly ContentTreeFile[],
  files: readonly ContentTreeFile[],
): FileNativeStateChange[] {
  const base = new Map(
    baseFiles
      .filter(({ path }) => path.startsWith("state/"))
      .map((file) => [file.path, file] as const),
  );
  const snapshot = WorldDocumentStore.open({
    layout: "world_state",
    files: files.filter(({ path }) => path.startsWith("state/")),
  });
  if (snapshot.status !== "usable")
    throw new WorldRevisionWorkspaceError(
      "Only a usable world-state snapshot can be applied",
    );
  return files
    .filter(({ path }) => path.startsWith("state/"))
    .flatMap((file): FileNativeStateChange[] => {
      const previous = base.get(file.path);
      if (previous?.contents === file.contents) return [];
      const result = snapshot.query({
        kind: "read_document",
        document: { logicalPath: file.path },
      });
      if (result.kind !== "read_document" || !result.ok)
        throw new WorldRevisionWorkspaceError(
          `Cannot resolve changed world document: ${file.path}`,
        );
      if (previous !== undefined) {
        const baseSnapshot = WorldDocumentStore.open({
          layout: "world_state",
          files: baseFiles.filter(({ path }) => path.startsWith("state/")),
        });
        const before = baseSnapshot.query({
          kind: "read_document",
          document: { logicalPath: file.path },
        });
        if (
          before.kind !== "read_document" ||
          !before.ok ||
          before.document.documentId !== result.document.documentId
        )
          throw new WorldRevisionWorkspaceError(
            `Existing world-document identity changed: ${file.path}`,
          );
      }
      return [
        {
          kind: previous === undefined ? "create" : "replace",
          documentId: result.document.documentId,
          stableShortRef: result.document.shortRef,
          relativePath: file.path.slice("state/".length),
          codec: result.document.codec,
          expectedPreviousHash:
            previous === undefined ? null : sha256(previous.contents),
          nextHash: sha256(file.contents),
          canonicalNextBytes: file.contents,
        },
      ];
    });
}

function controlFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files
    .filter(({ path }) => path.startsWith("control/"))
    .map(({ path, contents, encoding }) => ({
      path: path.slice("control/".length),
      contents,
      ...(encoding === undefined ? {} : { encoding }),
    }));
}

function controlFingerprint(files: readonly ContentTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  ))
    hash.update(file.path).update("\0").update(file.contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function fileDiff(
  beforeFiles: readonly ContentTreeFile[],
  afterFiles: readonly ContentTreeFile[],
): V1SettingAuthoringDiff[] {
  const before = new Map(beforeFiles.map((file) => [file.path, file] as const));
  const after = new Map(afterFiles.map((file) => [file.path, file] as const));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path): V1SettingAuthoringDiff[] => {
      const left = before.get(path);
      const right = after.get(path);
      if (
        left?.contents === right?.contents &&
        left?.encoding === right?.encoding
      )
        return [];
      return [
        {
          path,
          kind:
            left === undefined
              ? "create"
              : right === undefined
                ? "delete"
                : "modify",
          before: left?.contents ?? null,
          after: right?.contents ?? null,
        },
      ];
    });
}

function fileMatchesBefore(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): boolean {
  const current = files.find(({ path }) => path === change.path);
  return change.before === null
    ? current === undefined
    : current?.contents === change.before && current.encoding === undefined;
}

function restoreBefore(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): ContentTreeFile[] {
  const restored = new Map(
    files.map((file) => [file.path, structuredClone(file)] as const),
  );
  if (change.before === null) restored.delete(change.path);
  else
    restored.set(change.path, { path: change.path, contents: change.before });
  return [...restored.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function inverseDiff(
  files: readonly ContentTreeFile[],
  change: V1SettingAuthoringDiff,
): V1SettingAuthoringDiff {
  const before =
    files.find(({ path }) => path === change.path)?.contents ?? null;
  return {
    path: change.path,
    kind:
      before === null ? "create" : change.before === null ? "delete" : "modify",
    before,
    after: change.before,
  };
}

function cloneFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files
    .map((file) => structuredClone(file))
    .sort((left, right) => left.path.localeCompare(right.path));
}
