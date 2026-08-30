import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ContentTreeFile } from "../content/ContentWorkspace.ts";
import type { MaterialSelection } from "../prompt/MaterialSelection.ts";

export const continuityHeadFile = "continuity-head.json";
export const authorityV3Directory = "authority-v3";

export interface FileNativeAuthorityObjectRef {
  epoch: number;
  digest: string;
}

export interface FileNativeAuthorityHistoryMessage {
  messageId: string;
  role: "player" | "narrator";
  exactText: string;
}

export interface FileNativeAuthorityStateChangeInput {
  kind: "create" | "replace";
  documentId: string;
  stableShortRef: string;
  relativePath: string;
  codec: "yaml" | "markdown";
  expectedPreviousHash: string | null;
  nextHash: string;
  canonicalNextBytes: string;
}

export interface FileNativeAuthorityStoredStateChange extends Omit<
  FileNativeAuthorityStateChangeInput,
  "canonicalNextBytes"
> {
  nextBlob: FileNativeAuthorityBlobRef;
}

export interface FileNativeAuthorityTimelineRevision {
  restoresHead: string;
  replacesHead: string;
  requestFingerprint: string;
}

export interface FileNativeAuthorityCommitV3 {
  schemaVersion: 3;
  type: "file_native_authority_commit";
  sequence: number;
  head: string;
  auditParent: { head: string; digest: string };
  timelineParent: { head: string; digest: string };
  mode: "play" | "correction" | "timeline_revision";
  historyAppend: readonly FileNativeAuthorityHistoryMessage[];
  stateChanges: readonly FileNativeAuthorityStoredStateChange[];
  nextAdditionalMaterials: readonly MaterialSelection[];
  result: FileNativeAuthorityObjectRef;
  correctionTargets?: readonly string[];
  corrects?: string;
  timelineRevision?: FileNativeAuthorityTimelineRevision;
}

export interface FileNativeAuthorityHeadV3 {
  schemaVersion: 3;
  type: "file_native_continuity_head";
  head: string;
  sequence: number;
  genesisDigest: string;
  commitDigest: string | null;
  result: FileNativeAuthorityObjectRef;
  operationId: string | null;
}

interface FileNativeAuthorityGenesisV3 {
  schemaVersion: 3;
  type: "file_native_authority_genesis";
  result: FileNativeAuthorityObjectRef;
}

export interface FileNativeAuthorityBlobRef extends FileNativeAuthorityObjectRef {
  sha256: string;
}

interface FileNativeAuthorityStateManifestV3 {
  schemaVersion: 3;
  type: "file_native_state_manifest";
  files: readonly {
    path: string;
    sha256: string;
    blob: FileNativeAuthorityBlobRef;
  }[];
}

interface FileNativeAuthorityHistorySegmentV3 {
  schemaVersion: 3;
  type: "file_native_history_segment";
  previous: FileNativeAuthorityObjectRef | null;
  messages: readonly FileNativeAuthorityHistoryMessage[];
}

interface FileNativeAuthorityMaterialSetV3 {
  schemaVersion: 3;
  type: "file_native_material_set";
  items: readonly MaterialSelection[];
}

interface FileNativeAuthorityEndpointV3 {
  schemaVersion: 3;
  type: "file_native_authority_endpoint";
  state: FileNativeAuthorityObjectRef;
  history: FileNativeAuthorityObjectRef | null;
  historyLength: number;
  materials: FileNativeAuthorityObjectRef;
}

export interface FileNativeAuthorityRecoveredEndpoint {
  head: string;
  state: ContentTreeFile[];
  history: FileNativeAuthorityHistoryMessage[];
  additionalMaterials: MaterialSelection[];
  result: FileNativeAuthorityObjectRef;
}

export interface FileNativeAuthorityPreparedAppend {
  commit: FileNativeAuthorityCommitV3;
  commitDigest: string;
  nextHead: FileNativeAuthorityHeadV3;
  stateChanges: readonly FileNativeAuthorityStateChangeInput[];
}

export class FileNativeAuthorityV3Error extends Error {
  readonly code: "corrupt" | "stale" | "conflict";

  constructor(code: FileNativeAuthorityV3Error["code"], message: string) {
    super(message);
    this.name = "FileNativeAuthorityV3Error";
    this.code = code;
  }
}

/**
 * World-neutral immutable Authority facts with one target-local mutable head.
 *
 * Every sequence owns an immutable epoch directory. A fork can therefore
 * retain a prefix by cloning directory entries without parsing or rewriting
 * ancestor facts. Object references include their creation epoch so unchanged
 * state/history/material objects remain directly addressable after a fork.
 */
export class FileNativeAuthorityV3 {
  readonly #runtimeRoot: string;
  readonly #authorityRoot: string;

  constructor(worldRoot: string) {
    this.#runtimeRoot = join(worldRoot, "runtime");
    this.#authorityRoot = join(this.#runtimeRoot, authorityV3Directory);
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(join(this.#runtimeRoot, continuityHeadFile), "utf8");
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async initialize(input: {
    operationId: string | null;
    state: readonly ContentTreeFile[];
    history: readonly FileNativeAuthorityHistoryMessage[];
    additionalMaterials: readonly MaterialSelection[];
  }): Promise<FileNativeAuthorityHeadV3> {
    const epoch = 0;
    const state = await this.#writeStateManifest(epoch, input.state);
    const historySegment: FileNativeAuthorityHistorySegmentV3 = {
      schemaVersion: 3,
      type: "file_native_history_segment",
      previous: null,
      messages: structuredClone(input.history),
    };
    assertHistorySegment(historySegment);
    assertGenesisHistory(historySegment.messages);
    const history =
      input.history.length === 0
        ? null
        : await this.#writeObject<FileNativeAuthorityHistorySegmentV3>(
            epoch,
            "history.json",
            historySegment,
          );
    const materialSet: FileNativeAuthorityMaterialSetV3 = {
      schemaVersion: 3,
      type: "file_native_material_set",
      items: structuredClone(input.additionalMaterials),
    };
    assertMaterialSet(materialSet);
    const materials = await this.#writeObject<FileNativeAuthorityMaterialSetV3>(
      epoch,
      "materials.json",
      materialSet,
    );
    const endpointValue: FileNativeAuthorityEndpointV3 = {
      schemaVersion: 3,
      type: "file_native_authority_endpoint",
      state,
      history,
      historyLength: input.history.length,
      materials,
    };
    assertEndpoint(endpointValue);
    const endpoint = await this.#writeObject<FileNativeAuthorityEndpointV3>(
      epoch,
      "endpoint.json",
      endpointValue,
    );
    const genesisValue: FileNativeAuthorityGenesisV3 = {
      schemaVersion: 3,
      type: "file_native_authority_genesis",
      result: endpoint,
    };
    assertGenesis(genesisValue);
    const genesis = await this.#writeObject<FileNativeAuthorityGenesisV3>(
      epoch,
      "authority.json",
      genesisValue,
    );
    const head: FileNativeAuthorityHeadV3 = {
      schemaVersion: 3,
      type: "file_native_continuity_head",
      head: "genesis",
      sequence: 0,
      genesisDigest: genesis.digest,
      commitDigest: null,
      result: endpoint,
      operationId: input.operationId,
    };
    await publishJson(join(this.#runtimeRoot, continuityHeadFile), head);
    return head;
  }

  async readHead(): Promise<FileNativeAuthorityHeadV3> {
    const value = await readJson<unknown>(
      join(this.#runtimeRoot, continuityHeadFile),
    );
    assertHead(value);
    return value;
  }

  async currentOperationId(): Promise<string | null> {
    return (await this.readHead()).operationId;
  }

  async discardUnacceptedNextEpoch(): Promise<void> {
    const current = await this.readHead();
    const epochsRoot = join(this.#authorityRoot, "epochs");
    await rm(this.#epochRoot(current.sequence + 1), {
      recursive: true,
      force: true,
    });
    await syncDirectory(epochsRoot);
  }

  async prepareAppend(input: {
    operationId: string;
    parentHead: string;
    timelineParentHead?: string;
    mode: FileNativeAuthorityCommitV3["mode"];
    historyAppend: readonly {
      role: "player" | "narrator";
      exactText: string;
    }[];
    stateChanges: readonly FileNativeAuthorityStateChangeInput[];
    nextMaterials: readonly MaterialSelection[];
    correctionTargets?: readonly string[];
    corrects?: string;
    timelineRevision?: FileNativeAuthorityTimelineRevision;
  }): Promise<FileNativeAuthorityPreparedAppend> {
    const current = await this.readHead();
    if (current.head !== input.parentHead)
      throw new FileNativeAuthorityV3Error(
        "stale",
        "The parent endpoint of the Authority operation has changed",
      );
    const sequence = current.sequence + 1;
    const head = `commit:${sequence}`;
    const basisHead = input.timelineParentHead ?? input.parentHead;
    const basisResult = await this.#resultRefAt(basisHead);
    const basis = await this.#readEndpoint(basisResult);
    const state = await this.#nextState(
      sequence,
      basis.state,
      input.stateChanges,
    );
    const historyAppend = input.historyAppend.map((message, index) => ({
      messageId: `message.${sequence}.${index + 1}.${message.role}`,
      ...structuredClone(message),
    }));
    const history =
      historyAppend.length === 0
        ? basis.history
        : await this.#writeHistorySegment(sequence, {
            schemaVersion: 3,
            type: "file_native_history_segment",
            previous: basis.history,
            messages: historyAppend,
          });
    const basisMaterials = await this.#readMaterials(basis.materials);
    const nextMaterialSet: FileNativeAuthorityMaterialSetV3 = {
      schemaVersion: 3,
      type: "file_native_material_set",
      items: structuredClone(input.nextMaterials),
    };
    assertMaterialSet(nextMaterialSet);
    const materials = isDeepStrictEqual(
      basisMaterials.items,
      input.nextMaterials,
    )
      ? basis.materials
      : await this.#writeObject<FileNativeAuthorityMaterialSetV3>(
          sequence,
          "materials.json",
          nextMaterialSet,
        );
    const endpointValue: FileNativeAuthorityEndpointV3 = {
      schemaVersion: 3,
      type: "file_native_authority_endpoint",
      state,
      history,
      historyLength: basis.historyLength + historyAppend.length,
      materials,
    };
    assertEndpoint(endpointValue);
    const endpoint = await this.#writeObject<FileNativeAuthorityEndpointV3>(
      sequence,
      "endpoint.json",
      endpointValue,
    );
    const storedChanges: FileNativeAuthorityStoredStateChange[] = [];
    for (const change of input.stateChanges) {
      const blob = await this.#writeBlob(sequence, change.canonicalNextBytes);
      storedChanges.push({
        kind: change.kind,
        documentId: change.documentId,
        stableShortRef: change.stableShortRef,
        relativePath: change.relativePath,
        codec: change.codec,
        expectedPreviousHash: change.expectedPreviousHash,
        nextHash: change.nextHash,
        nextBlob: blob,
      });
    }
    const auditParent = {
      head: current.head,
      digest: current.commitDigest ?? current.genesisDigest,
    };
    const timelineParent = await this.#authorityRefAt(basisHead);
    const commit: FileNativeAuthorityCommitV3 = {
      schemaVersion: 3,
      type: "file_native_authority_commit",
      sequence,
      head,
      auditParent,
      timelineParent,
      mode: input.mode,
      historyAppend,
      stateChanges: storedChanges,
      nextAdditionalMaterials: structuredClone(input.nextMaterials),
      result: endpoint,
      ...(input.correctionTargets === undefined
        ? {}
        : { correctionTargets: structuredClone(input.correctionTargets) }),
      ...(input.corrects === undefined ? {} : { corrects: input.corrects }),
      ...(input.timelineRevision === undefined
        ? {}
        : { timelineRevision: structuredClone(input.timelineRevision) }),
    };
    assertCommit(commit);
    const authority = await this.#writeObject<FileNativeAuthorityCommitV3>(
      sequence,
      "authority.json",
      commit,
    );
    return {
      commit,
      commitDigest: authority.digest,
      nextHead: {
        schemaVersion: 3,
        type: "file_native_continuity_head",
        head,
        sequence,
        genesisDigest: current.genesisDigest,
        commitDigest: authority.digest,
        result: endpoint,
        operationId: input.operationId,
      },
      stateChanges: structuredClone(input.stateChanges),
    };
  }

  async publishPrepared(
    prepared: FileNativeAuthorityPreparedAppend,
  ): Promise<void> {
    const current = await this.readHead();
    if (
      current.sequence + 1 !== prepared.nextHead.sequence ||
      current.head !== prepared.commit.auditParent.head ||
      (current.commitDigest ?? current.genesisDigest) !==
        prepared.commit.auditParent.digest
    )
      throw new FileNativeAuthorityV3Error(
        "stale",
        "The prepared Authority fact no longer extends the current endpoint",
      );
    await publishJson(
      join(this.#runtimeRoot, continuityHeadFile),
      prepared.nextHead,
    );
  }

  async recover(
    requestedHead?: string,
  ): Promise<FileNativeAuthorityRecoveredEndpoint> {
    const current = await this.readHead();
    const head = requestedHead ?? current.head;
    const result = await this.#resultRefAt(head);
    return this.#recoverResult(head, result);
  }

  /**
   * Recover the endpoint directly from the accepted small root. Fork staging
   * uses this path so adopting the current head never decodes or rehashes its
   * Authority fact; full audit remains available through readHistory().
   */
  async recoverHeadResult(): Promise<FileNativeAuthorityRecoveredEndpoint> {
    const current = await this.readHead();
    return this.#recoverResult(current.head, current.result);
  }

  async #recoverResult(
    head: string,
    result: FileNativeAuthorityObjectRef,
  ): Promise<FileNativeAuthorityRecoveredEndpoint> {
    const endpoint = await this.#readEndpoint(result);
    const state = await this.#recoverState(endpoint.state);
    const history = await this.#recoverHistory(
      endpoint.history,
      endpoint.historyLength,
    );
    const materials = await this.#readMaterials(endpoint.materials);
    return {
      head,
      state,
      history,
      additionalMaterials: structuredClone([...materials.items]),
      result,
    };
  }

  async recoverState(head?: string): Promise<ContentTreeFile[]> {
    const current = await this.readHead();
    const selected = head ?? current.head;
    const result = await this.#resultRefAt(selected);
    const endpoint = await this.#readEndpoint(result);
    return this.#recoverState(endpoint.state);
  }

  async recoverMaterials(head?: string): Promise<MaterialSelection[]> {
    const current = await this.readHead();
    const selected = head ?? current.head;
    const result = await this.#resultRefAt(selected);
    const endpoint = await this.#readEndpoint(result);
    const materials = await this.#readMaterials(endpoint.materials);
    return structuredClone([...materials.items]);
  }

  async readHistory(): Promise<{
    head: string;
    commits: FileNativeAuthorityCommitV3[];
  }> {
    const head = await this.readHead();
    const genesis = await this.#readObject<FileNativeAuthorityGenesisV3>(
      { epoch: 0, digest: head.genesisDigest },
      "authority.json",
      "file_native_authority_genesis",
    );
    assertGenesis(genesis);
    await this.#assertAcceptedGenesis(head);
    const commits: FileNativeAuthorityCommitV3[] = [];
    let expectedHead = "genesis";
    let expectedDigest = head.genesisDigest;
    for (let sequence = 1; sequence <= head.sequence; sequence += 1) {
      const { value: commit, digest } =
        await this.#readAuthorityCommit(sequence);
      if (
        commit.sequence !== sequence ||
        commit.head !== `commit:${sequence}` ||
        commit.auditParent.head !== expectedHead ||
        commit.auditParent.digest !== expectedDigest
      )
        throw new FileNativeAuthorityV3Error(
          "corrupt",
          `Authority fact ${sequence} does not extend the immutable audit chain`,
        );
      commits.push(commit);
      expectedHead = commit.head;
      expectedDigest = digest;
    }
    if (
      expectedHead !== head.head ||
      (head.sequence === 0 ? null : expectedDigest) !== head.commitDigest ||
      !isDeepStrictEqual(head.result, commits.at(-1)?.result ?? genesis.result)
    )
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        "Continuity head does not match the immutable Authority chain",
      );
    return { head: head.head, commits };
  }

  async commitAt(head: string): Promise<FileNativeAuthorityCommitV3 | null> {
    if (head === "genesis") return null;
    const sequence = parseHeadSequence(head);
    const current = await this.readHead();
    const { value, digest } = await this.#readAuthorityCommit(sequence);
    if (value.head !== head)
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Authority endpoint does not exist: ${head}`,
      );
    await this.#assertAcceptedAuthorityRef(current, sequence, head, digest);
    return value;
  }

  async authorityFactAt(head: string): Promise<{
    commit: FileNativeAuthorityCommitV3;
    digest: string;
  }> {
    if (head === "genesis")
      throw new FileNativeAuthorityV3Error(
        "conflict",
        "Genesis is not an Authority commit",
      );
    const sequence = parseHeadSequence(head);
    const current = await this.readHead();
    const { value, digest } = await this.#readAuthorityCommit(sequence);
    if (value.head !== head)
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Authority endpoint identity is invalid: ${head}`,
      );
    await this.#assertAcceptedAuthorityRef(current, sequence, head, digest);
    return { commit: value, digest };
  }

  async clonePrefixTo(input: {
    targetWorldRoot: string;
    selectedHead: string;
    operationId: string;
  }): Promise<FileNativeAuthorityHeadV3> {
    const sourceHead = await this.readHead();
    const selectedSequence =
      input.selectedHead === "genesis"
        ? 0
        : parseHeadSequence(input.selectedHead);
    if (selectedSequence > sourceHead.sequence)
      throw new FileNativeAuthorityV3Error(
        "conflict",
        `Cannot fork a nonexistent Authority endpoint: ${input.selectedHead}`,
      );
    const selected =
      input.selectedHead === sourceHead.head
        ? { ...structuredClone(sourceHead), operationId: input.operationId }
        : selectedSequence === 0
          ? await this.#headAtGenesis(sourceHead, input.operationId)
          : await this.#headAtCommit(
              sourceHead,
              selectedSequence,
              input.operationId,
            );
    const targetRuntime = join(input.targetWorldRoot, "runtime");
    const targetAuthority = join(targetRuntime, authorityV3Directory);
    for (let epoch = 0; epoch <= selectedSequence; epoch += 1)
      await cloneImmutableTree(
        this.#epochRoot(epoch),
        join(targetAuthority, "epochs", epochName(epoch)),
      );
    await publishJson(join(targetRuntime, continuityHeadFile), selected);
    return selected;
  }

  async #headAtGenesis(
    current: FileNativeAuthorityHeadV3,
    operationId: string,
  ): Promise<FileNativeAuthorityHeadV3> {
    const genesis = await this.#readObject<FileNativeAuthorityGenesisV3>(
      { epoch: 0, digest: current.genesisDigest },
      "authority.json",
      "file_native_authority_genesis",
    );
    assertGenesis(genesis);
    await this.#assertAcceptedGenesis(current);
    return {
      schemaVersion: 3,
      type: "file_native_continuity_head",
      head: "genesis",
      sequence: 0,
      genesisDigest: current.genesisDigest,
      commitDigest: null,
      result: genesis.result,
      operationId,
    };
  }

  async #headAtCommit(
    current: FileNativeAuthorityHeadV3,
    sequence: number,
    operationId: string,
  ): Promise<FileNativeAuthorityHeadV3> {
    const { value, digest } = await this.#readAuthorityCommit(sequence);
    await this.#assertAcceptedAuthorityRef(
      current,
      sequence,
      value.head,
      digest,
    );
    return {
      schemaVersion: 3,
      type: "file_native_continuity_head",
      head: value.head,
      sequence,
      genesisDigest: current.genesisDigest,
      commitDigest: digest,
      result: value.result,
      operationId,
    };
  }

  async #resultRefAt(head: string): Promise<FileNativeAuthorityObjectRef> {
    const current = await this.readHead();
    if (head === current.head) {
      if (current.sequence === 0) {
        const genesis = await this.#readObject<FileNativeAuthorityGenesisV3>(
          { epoch: 0, digest: current.genesisDigest },
          "authority.json",
          "file_native_authority_genesis",
        );
        assertGenesis(genesis);
        if (!isDeepStrictEqual(genesis.result, current.result))
          throw new FileNativeAuthorityV3Error(
            "corrupt",
            "Continuity head result does not match Authority genesis",
          );
      } else {
        const { value, digest } = await this.#readAuthorityCommit(
          current.sequence,
        );
        if (
          value.head !== current.head ||
          digest !== current.commitDigest ||
          !isDeepStrictEqual(value.result, current.result)
        )
          throw new FileNativeAuthorityV3Error(
            "corrupt",
            "Continuity head result does not match its Authority fact",
          );
      }
      return current.result;
    }
    if (head === "genesis") {
      const genesis = await this.#readObject<FileNativeAuthorityGenesisV3>(
        { epoch: 0, digest: current.genesisDigest },
        "authority.json",
        "file_native_authority_genesis",
      );
      assertGenesis(genesis);
      await this.#assertAcceptedGenesis(current);
      return genesis.result;
    }
    const sequence = parseHeadSequence(head);
    if (sequence > current.sequence)
      throw new FileNativeAuthorityV3Error(
        "conflict",
        `Authority endpoint does not exist: ${head}`,
      );
    const { value, digest } = await this.#readAuthorityCommit(sequence);
    if (value.head !== head)
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Authority endpoint identity is invalid: ${head}`,
      );
    await this.#assertAcceptedAuthorityRef(current, sequence, head, digest);
    return value.result;
  }

  async #authorityRefAt(
    head: string,
  ): Promise<{ head: string; digest: string }> {
    const current = await this.readHead();
    if (head === "genesis") {
      await this.#assertAcceptedGenesis(current);
      return { head, digest: current.genesisDigest };
    }
    const sequence = parseHeadSequence(head);
    const { value, digest } = await this.#readAuthorityCommit(sequence);
    if (value.head !== head || sequence > current.sequence)
      throw new FileNativeAuthorityV3Error(
        "conflict",
        `Authority endpoint does not exist: ${head}`,
      );
    await this.#assertAcceptedAuthorityRef(current, sequence, head, digest);
    return { head, digest };
  }

  async #assertAcceptedAuthorityRef(
    current: FileNativeAuthorityHeadV3,
    sequence: number,
    head: string,
    digest: string,
  ): Promise<void> {
    if (sequence > current.sequence)
      throw new FileNativeAuthorityV3Error(
        "conflict",
        `Authority endpoint does not exist: ${head}`,
      );
    if (sequence === current.sequence) {
      if (current.head !== head || current.commitDigest !== digest)
        throw new FileNativeAuthorityV3Error(
          "corrupt",
          `Authority endpoint is not the accepted head: ${head}`,
        );
      return;
    }
    const { value: child } = await this.#readAuthorityCommit(sequence + 1);
    if (child.auditParent.head !== head || child.auditParent.digest !== digest)
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Authority endpoint is not in the accepted audit chain: ${head}`,
      );
  }

  async #assertAcceptedGenesis(
    current: FileNativeAuthorityHeadV3,
  ): Promise<void> {
    if (current.sequence === 0) return;
    const { value: first } = await this.#readAuthorityCommit(1);
    if (
      first.auditParent.head !== "genesis" ||
      first.auditParent.digest !== current.genesisDigest
    )
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        "Authority audit chain does not extend its genesis anchor",
      );
  }

  async #nextState(
    epoch: number,
    basisRef: FileNativeAuthorityObjectRef,
    changes: readonly FileNativeAuthorityStateChangeInput[],
  ): Promise<FileNativeAuthorityObjectRef> {
    if (changes.length === 0) return basisRef;
    const basis = await this.#readStateManifest(basisRef);
    const files = new Map(basis.files.map((file) => [file.path, file]));
    for (const change of changes) {
      const previous = files.get(change.relativePath);
      if ((previous?.sha256 ?? null) !== change.expectedPreviousHash)
        throw new FileNativeAuthorityV3Error(
          "conflict",
          `State-change previous hash conflicts: ${change.relativePath}`,
        );
      if (hashWithPrefix(change.canonicalNextBytes) !== change.nextHash)
        throw new FileNativeAuthorityV3Error(
          "conflict",
          `State-change next hash conflicts: ${change.relativePath}`,
        );
      const blob = await this.#writeBlob(epoch, change.canonicalNextBytes);
      files.set(change.relativePath, {
        path: change.relativePath,
        sha256: change.nextHash,
        blob,
      });
    }
    const manifest: FileNativeAuthorityStateManifestV3 = {
      schemaVersion: 3,
      type: "file_native_state_manifest",
      files: [...files.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    };
    assertStateManifest(manifest);
    return this.#writeObject<FileNativeAuthorityStateManifestV3>(
      epoch,
      "state.json",
      manifest,
    );
  }

  async #writeStateManifest(
    epoch: number,
    files: readonly ContentTreeFile[],
  ): Promise<FileNativeAuthorityObjectRef> {
    const entries: FileNativeAuthorityStateManifestV3["files"][number][] = [];
    for (const file of files) {
      const blob = await this.#writeBlob(epoch, file.contents);
      entries.push({
        path: file.path,
        sha256: hashWithPrefix(file.contents),
        blob,
      });
    }
    const manifest: FileNativeAuthorityStateManifestV3 = {
      schemaVersion: 3,
      type: "file_native_state_manifest",
      files: entries.sort((left, right) => left.path.localeCompare(right.path)),
    };
    assertStateManifest(manifest);
    return this.#writeObject<FileNativeAuthorityStateManifestV3>(
      epoch,
      "state.json",
      manifest,
    );
  }

  async #writeHistorySegment(
    epoch: number,
    segment: FileNativeAuthorityHistorySegmentV3,
  ): Promise<FileNativeAuthorityObjectRef> {
    assertHistorySegment(segment);
    return this.#writeObject<FileNativeAuthorityHistorySegmentV3>(
      epoch,
      "history.json",
      segment,
    );
  }

  async #writeBlob(
    epoch: number,
    contents: string,
  ): Promise<FileNativeAuthorityBlobRef> {
    const digest = hashHex(contents);
    const path = join(this.#epochRoot(epoch), "blobs", `${digest}.txt`);
    await publishImmutableText(path, contents);
    return { epoch, digest, sha256: `sha256:${digest}` };
  }

  async #recoverState(
    ref: FileNativeAuthorityObjectRef,
  ): Promise<ContentTreeFile[]> {
    const manifest = await this.#readStateManifest(ref);
    const state: ContentTreeFile[] = [];
    for (const file of manifest.files) {
      const contents = await readFile(
        join(
          this.#epochRoot(file.blob.epoch),
          "blobs",
          `${file.blob.digest}.txt`,
        ),
        "utf8",
      );
      if (
        hashHex(contents) !== file.blob.digest ||
        hashWithPrefix(contents) !== file.sha256 ||
        file.blob.sha256 !== file.sha256
      )
        throw new FileNativeAuthorityV3Error(
          "corrupt",
          `State blob digest does not match: ${file.path}`,
        );
      state.push({ path: file.path, contents });
    }
    return state;
  }

  async #recoverHistory(
    tail: FileNativeAuthorityObjectRef | null,
    expectedLength: number,
  ): Promise<FileNativeAuthorityHistoryMessage[]> {
    const segments: FileNativeAuthorityHistorySegmentV3[] = [];
    const seen = new Set<string>();
    let current = tail;
    while (current !== null) {
      const key = `${current.epoch}:${current.digest}`;
      if (seen.has(key))
        throw new FileNativeAuthorityV3Error(
          "corrupt",
          "History segment chain contains a cycle",
        );
      seen.add(key);
      const segment =
        await this.#readObject<FileNativeAuthorityHistorySegmentV3>(
          current,
          "history.json",
          "file_native_history_segment",
        );
      assertHistorySegment(segment);
      segments.push(segment);
      current = segment.previous;
    }
    const history = segments
      .reverse()
      .flatMap(({ messages }) => structuredClone(messages));
    if (history.length !== expectedLength)
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        "History endpoint length does not match its immutable segment chain",
      );
    return history;
  }

  async #readEndpoint(
    ref: FileNativeAuthorityObjectRef,
  ): Promise<FileNativeAuthorityEndpointV3> {
    const value = await this.#readObject<FileNativeAuthorityEndpointV3>(
      ref,
      "endpoint.json",
      "file_native_authority_endpoint",
    );
    assertEndpoint(value);
    return value;
  }

  async #readStateManifest(
    ref: FileNativeAuthorityObjectRef,
  ): Promise<FileNativeAuthorityStateManifestV3> {
    const value = await this.#readObject<FileNativeAuthorityStateManifestV3>(
      ref,
      "state.json",
      "file_native_state_manifest",
    );
    assertStateManifest(value);
    return value;
  }

  async #readMaterials(
    ref: FileNativeAuthorityObjectRef,
  ): Promise<FileNativeAuthorityMaterialSetV3> {
    const value = await this.#readObject<FileNativeAuthorityMaterialSetV3>(
      ref,
      "materials.json",
      "file_native_material_set",
    );
    assertMaterialSet(value);
    return value;
  }

  async #readAuthorityCommit(sequence: number): Promise<{
    value: FileNativeAuthorityCommitV3;
    digest: string;
  }> {
    forbidAuthorityFactDecodeForTest();
    const path = join(this.#epochRoot(sequence), "authority.json");
    const value = await readJson<unknown>(path);
    if (
      !isRecord(value) ||
      value.schemaVersion !== 3 ||
      value.type !== "file_native_authority_commit"
    )
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Authority fact ${sequence} has an invalid shape`,
      );
    assertCommit(value);
    const commit = value;
    return { value: commit, digest: objectDigest(commit) };
  }

  async #writeObject<Value>(
    epoch: number,
    name: string,
    value: Value,
  ): Promise<FileNativeAuthorityObjectRef> {
    const digest = objectDigest(value);
    await publishImmutableJson(join(this.#epochRoot(epoch), name), value);
    return { epoch, digest };
  }

  async #readObject<Value extends { type: string }>(
    ref: FileNativeAuthorityObjectRef,
    name: string,
    type: Value["type"],
  ): Promise<Value> {
    if (name === "authority.json") forbidAuthorityFactDecodeForTest();
    const value = await readJson<unknown>(
      join(this.#epochRoot(ref.epoch), name),
    );
    if (
      !isRecord(value) ||
      value.schemaVersion !== 3 ||
      value.type !== type ||
      objectDigest(value) !== ref.digest
    )
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Immutable ${type} object does not match its reference`,
      );
    return value as unknown as Value;
  }

  #epochRoot(epoch: number): string {
    return join(this.#authorityRoot, "epochs", epochName(epoch));
  }
}

function assertGenesis(
  value: unknown,
): asserts value is FileNativeAuthorityGenesisV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "result"]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_authority_genesis" ||
    !isObjectRef(value.result) ||
    value.result.epoch !== 0
  )
    throw corruptShape("Authority genesis");
}

function assertEndpoint(
  value: unknown,
): asserts value is FileNativeAuthorityEndpointV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "type",
      "state",
      "history",
      "historyLength",
      "materials",
    ]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_authority_endpoint" ||
    !isObjectRef(value.state) ||
    (value.history !== null && !isObjectRef(value.history)) ||
    !Number.isSafeInteger(value.historyLength) ||
    Number(value.historyLength) < 0 ||
    !isObjectRef(value.materials)
  )
    throw corruptShape("Authority endpoint");
}

function assertStateManifest(
  value: unknown,
): asserts value is FileNativeAuthorityStateManifestV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "files"]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_state_manifest" ||
    !Array.isArray(value.files)
  )
    throw corruptShape("Authority state manifest");
  const paths = new Set<string>();
  let previousPath: string | null = null;
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["path", "sha256", "blob"]) ||
      typeof file.path !== "string" ||
      !validRelativePath(file.path) ||
      paths.has(file.path) ||
      (previousPath !== null && previousPath.localeCompare(file.path) >= 0) ||
      typeof file.sha256 !== "string" ||
      !isSha256(file.sha256) ||
      !isBlobRef(file.blob) ||
      file.blob.sha256 !== file.sha256
    )
      throw corruptShape("Authority state manifest entry");
    paths.add(file.path);
    previousPath = file.path;
  }
}

function assertHistorySegment(
  value: unknown,
): asserts value is FileNativeAuthorityHistorySegmentV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "previous", "messages"]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_history_segment" ||
    (value.previous !== null && !isObjectRef(value.previous)) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isHistoryMessage)
  )
    throw corruptShape("Authority history segment");
}

function assertGenesisHistory(
  messages: readonly FileNativeAuthorityHistoryMessage[],
): void {
  for (const [index, message] of messages.entries()) {
    const expected =
      index === 0 && message.role === "narrator"
        ? "message.genesis.narrator"
        : `message.genesis.${index + 1}.${message.role}`;
    if (message.messageId !== expected)
      throw corruptShape("Authority genesis history-message identity");
  }
}

function assertMaterialSet(
  value: unknown,
): asserts value is FileNativeAuthorityMaterialSetV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "items"]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_material_set" ||
    !Array.isArray(value.items) ||
    !value.items.every(isMaterialSelection)
  )
    throw corruptShape("Authority material set");
}

function assertCommit(
  value: unknown,
): asserts value is FileNativeAuthorityCommitV3 {
  if (!isRecord(value)) throw corruptShape("Authority commit");
  const correction = value.mode === "correction";
  const revision = value.mode === "timeline_revision";
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "type",
      "sequence",
      "head",
      "auditParent",
      "timelineParent",
      "mode",
      "historyAppend",
      "stateChanges",
      "nextAdditionalMaterials",
      "result",
      ...(correction ? ["correctionTargets", "corrects"] : []),
      ...(revision ? ["timelineRevision"] : []),
    ]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_authority_commit" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    value.head !== `commit:${String(value.sequence)}` ||
    !isAuthorityParent(value.auditParent) ||
    !isAuthorityParent(value.timelineParent) ||
    (value.mode !== "play" && !correction && !revision) ||
    !Array.isArray(value.historyAppend) ||
    !value.historyAppend.every(isHistoryMessage) ||
    !Array.isArray(value.stateChanges) ||
    !value.stateChanges.every(isStoredStateChange) ||
    !Array.isArray(value.nextAdditionalMaterials) ||
    !value.nextAdditionalMaterials.every(isMaterialSelection) ||
    !isObjectRef(value.result) ||
    value.result.epoch !== value.sequence
  )
    throw corruptShape("Authority commit");
  for (const [index, message] of value.historyAppend.entries())
    if (
      message.messageId !==
      `message.${value.sequence}.${index + 1}.${message.role}`
    )
      throw corruptShape("Authority history-message identity");
  if (
    value.stateChanges.some(
      (change) =>
        change.nextBlob.epoch !== value.sequence ||
        `sha256:${change.nextBlob.digest}` !== change.nextHash,
    )
  )
    throw corruptShape("Authority state-change blob");
  if (
    correction &&
    (!Array.isArray(value.correctionTargets) ||
      !value.correctionTargets.every(
        (target) => typeof target === "string" && target.trim() !== "",
      ) ||
      typeof value.corrects !== "string" ||
      value.corrects !== value.auditParent.head ||
      value.historyAppend.length !== 0)
  )
    throw corruptShape("Authority correction");
  if (
    revision &&
    (value.stateChanges.length !== 0 ||
      value.historyAppend.length !== 1 ||
      value.historyAppend[0]?.role !== "player" ||
      !isTimelineRevision(value.timelineRevision) ||
      value.timelineParent.head !== value.timelineRevision.restoresHead)
  )
    throw corruptShape("Authority timeline revision");
  if (
    value.mode === "play" &&
    value.historyAppend.length === 0 &&
    value.stateChanges.length === 0
  )
    throw corruptShape("Authority play commit");
}

function assertHead(
  value: unknown,
): asserts value is FileNativeAuthorityHeadV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "type",
      "head",
      "sequence",
      "genesisDigest",
      "commitDigest",
      "result",
      "operationId",
    ]) ||
    value.schemaVersion !== 3 ||
    value.type !== "file_native_continuity_head" ||
    typeof value.head !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    typeof value.genesisDigest !== "string" ||
    !isDigest(value.genesisDigest) ||
    (value.commitDigest !== null &&
      (typeof value.commitDigest !== "string" ||
        !isDigest(value.commitDigest))) ||
    !isObjectRef(value.result) ||
    value.result.epoch !== value.sequence ||
    (value.operationId !== null && typeof value.operationId !== "string") ||
    (value.sequence === 0
      ? value.head !== "genesis" || value.commitDigest !== null
      : value.head !== `commit:${String(value.sequence)}` ||
        value.commitDigest === null)
  )
    throw new FileNativeAuthorityV3Error(
      "corrupt",
      "Continuity head has an invalid shape",
    );
}

function isHistoryMessage(
  value: unknown,
): value is FileNativeAuthorityHistoryMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["messageId", "role", "exactText"]) ||
    typeof value.messageId !== "string" ||
    (value.role !== "player" && value.role !== "narrator") ||
    typeof value.exactText !== "string"
  )
    return false;
  const match =
    /^message\.(?:genesis(?:\.([1-9][0-9]*))?|([1-9][0-9]*)\.([1-9][0-9]*))\.(player|narrator)$/u.exec(
      value.messageId,
    );
  return match !== null && match[4] === value.role;
}

function isStoredStateChange(
  value: unknown,
): value is FileNativeAuthorityStoredStateChange {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "kind",
      "documentId",
      "stableShortRef",
      "relativePath",
      "codec",
      "expectedPreviousHash",
      "nextHash",
      "nextBlob",
    ]) &&
    (value.kind === "create" || value.kind === "replace") &&
    typeof value.documentId === "string" &&
    value.documentId.trim() !== "" &&
    typeof value.stableShortRef === "string" &&
    value.stableShortRef.trim() !== "" &&
    typeof value.relativePath === "string" &&
    validRelativePath(value.relativePath) &&
    (value.codec === "yaml" || value.codec === "markdown") &&
    (value.expectedPreviousHash === null ||
      (typeof value.expectedPreviousHash === "string" &&
        isSha256(value.expectedPreviousHash))) &&
    typeof value.nextHash === "string" &&
    isSha256(value.nextHash) &&
    isBlobRef(value.nextBlob)
  );
}

function isTimelineRevision(
  value: unknown,
): value is FileNativeAuthorityTimelineRevision {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "restoresHead",
      "replacesHead",
      "requestFingerprint",
    ]) &&
    typeof value.restoresHead === "string" &&
    isHeadAlias(value.restoresHead) &&
    typeof value.replacesHead === "string" &&
    /^commit:[1-9][0-9]*$/u.test(value.replacesHead) &&
    typeof value.requestFingerprint === "string" &&
    isSha256(value.requestFingerprint)
  );
}

function isAuthorityParent(
  value: unknown,
): value is { head: string; digest: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["head", "digest"]) &&
    typeof value.head === "string" &&
    isHeadAlias(value.head) &&
    typeof value.digest === "string" &&
    isDigest(value.digest)
  );
}

function isMaterialSelection(value: unknown): value is MaterialSelection {
  if (!isRecord(value)) return false;
  if (value.kind === "document")
    return (
      hasExactKeys(value, ["kind", "document"]) &&
      typeof value.document === "string"
    );
  if (value.kind === "node")
    return (
      hasExactKeys(value, ["kind", "document", "locator"]) &&
      typeof value.document === "string" &&
      isMaterialLocator(value.locator)
    );
  if (value.kind === "history_message")
    return (
      hasExactKeys(value, ["kind", "message"]) &&
      typeof value.message === "string" &&
      /^message\.(?:genesis(?:\.[1-9][0-9]*)?\.(?:player|narrator)|[1-9][0-9]*\.[1-9][0-9]*\.(?:player|narrator))$/u.test(
        value.message,
      )
    );
  return (
    value.kind === "history_commit" &&
    hasExactKeys(value, ["kind", "commit"]) &&
    typeof value.commit === "string" &&
    isHeadAlias(value.commit)
  );
}

function isMaterialLocator(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === "yaml" || key === "markdown") &&
    (value.yaml === undefined ||
      (Array.isArray(value.yaml) &&
        value.yaml.every(
          (segment) =>
            typeof segment === "string" || Number.isSafeInteger(segment),
        ))) &&
    (value.markdown === undefined ||
      (Array.isArray(value.markdown) &&
        value.markdown.every((segment) => typeof segment === "string")))
  );
}

function isBlobRef(value: unknown): value is FileNativeAuthorityBlobRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["epoch", "digest", "sha256"]) &&
    Number.isSafeInteger(value.epoch) &&
    Number(value.epoch) >= 0 &&
    typeof value.digest === "string" &&
    isDigest(value.digest) &&
    typeof value.sha256 === "string" &&
    isSha256(value.sha256) &&
    value.sha256 === `sha256:${value.digest}`
  );
}

function isHeadAlias(value: string): boolean {
  return /^(?:genesis|commit:[1-9][0-9]*)$/u.test(value);
}

function isSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function corruptShape(label: string): FileNativeAuthorityV3Error {
  return new FileNativeAuthorityV3Error(
    "corrupt",
    `${label} has an invalid shape`,
  );
}

function isObjectRef(value: unknown): value is FileNativeAuthorityObjectRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["epoch", "digest"]) &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0 &&
    typeof value.digest === "string" &&
    isDigest(value.digest)
  );
}

function parseHeadSequence(head: string): number {
  const match = /^commit:([1-9][0-9]*)$/u.exec(head);
  const sequence = Number(match?.[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new FileNativeAuthorityV3Error(
      "conflict",
      `Authority endpoint identity is invalid: ${head}`,
    );
  return sequence;
}

function epochName(epoch: number): string {
  return String(epoch).padStart(8, "0");
}

function objectDigest(value: unknown): string {
  return hashHex(JSON.stringify(value));
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashWithPrefix(value: string): string {
  return `sha256:${hashHex(value)}`;
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

async function cloneImmutableTree(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await cloneImmutableTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile())
      throw new FileNativeAuthorityV3Error(
        "corrupt",
        `Immutable Authority closure contains a non-file entry: ${entry.name}`,
      );
    await cloneImmutableFile(sourcePath, targetPath);
  }
}

async function cloneImmutableFile(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const strategy = process.env.NARRAEON_INTERNAL_TEST_CLONE_STRATEGY;
  if (strategy !== "reflink" && strategy !== "copy") {
    try {
      await link(source, target);
      return;
    } catch (error: unknown) {
      if (
        !isNodeError(error) ||
        ![
          "EXDEV",
          "EPERM",
          "EACCES",
          "EMLINK",
          "ENOTSUP",
          "EOPNOTSUPP",
        ].includes(error.code ?? "")
      )
        throw error;
    }
  }
  if (strategy !== "copy") {
    try {
      await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
      return;
    } catch (error: unknown) {
      if (
        !isNodeError(error) ||
        ![
          "EXDEV",
          "EPERM",
          "EACCES",
          "ENOTSUP",
          "EOPNOTSUPP",
          "EINVAL",
        ].includes(error.code ?? "")
      )
        throw error;
    }
  }
  await copyFile(source, target, constants.COPYFILE_EXCL);
}

async function publishImmutableJson(
  path: string,
  value: unknown,
): Promise<void> {
  await publishImmutableText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function publishImmutableText(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(temporary);
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== contents)
        throw new FileNativeAuthorityV3Error(
          "corrupt",
          `Immutable Authority object conflicts: ${path}`,
        );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson<Value>(path: string): Promise<Value> {
  return JSON.parse(await readFile(path, "utf8")) as Value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function forbidAuthorityFactDecodeForTest(): void {
  if (process.env.NARRAEON_INTERNAL_TEST_FORBID_AUTHORITY_FACT_DECODE === "1")
    throw new Error("Authority fact decoding is forbidden by this test");
}
