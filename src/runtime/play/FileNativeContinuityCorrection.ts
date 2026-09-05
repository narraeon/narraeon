import type { WorldDocumentMaintenance } from "../../protocol/worldMaintenance.ts";
import type { NarrativeCheckpoint } from "./PlayContinuity.ts";
import { readDeclaredWorldClock } from "../prompt/WorldMaintenanceReport.ts";
import { createHash, randomUUID } from "node:crypto";

import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
  type MaterialSelection,
  type PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import type { PlayPresetBinding } from "./FileNativePlayPresetStore.ts";
import { validateMaterialList } from "../prompt/MaterialSelection.ts";
import {
  FileNativeWorldCreationError,
  type FileNativeOperationOutcome,
  type FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";
import {
  WorldOperationBusyError,
  type ContinuityCorrectionWorldClaimHandle,
} from "../world/WorldOperationCoordinator.ts";
import type {
  WorldDocumentDescriptor,
  WorldDocumentRevisionCommand,
  WorldDocumentRevisionEdit,
  WorldDocumentSelector,
  WorldDocumentStore,
} from "../world/WorldDocumentStore.ts";
import {
  beginWorldStateRevision,
  fileNativeStateChanges,
  reviseWorldState,
  worldDocumentRevisionFailureMessage,
  worldStateRevisionChanges,
  type WorldStateRevision,
} from "../world/WorldStateRevision.ts";

type CorrectionMode = "documents" | "materials";

interface Candidate extends WorldStateRevision {
  id: string;
  operationId: string;
  worldId: string;
  parentHead: string;
  mode: CorrectionMode;
  version: number;
  materials: MaterialSelection[];
  originalMaterials: MaterialSelection[];
  history: Record<string, string>;
  documentMaintenance: Record<string, WorldDocumentMaintenance>;
  narrativeCheckpoint: NarrativeCheckpoint | undefined;
  reads: Map<string, { snapshotId: string; hash: string }>;
  previewedVersion: number | null;
  stateOperationClaim: ContinuityCorrectionWorldClaimHandle;
  claimHeartbeat: ReturnType<typeof setInterval>;
}

const claimHeartbeatIntervalMilliseconds = 20_000;

export class FileNativeContinuityCorrection {
  readonly #worlds: FileNativeWorldStore;
  readonly #compiler: FileNativePromptCompiler;
  readonly #candidates = new Map<string, Candidate>();

  constructor(
    worlds: FileNativeWorldStore,
    options: { compiler?: FileNativePromptCompiler } = {},
  ) {
    this.#worlds = worlds;
    this.#compiler = options.compiler ?? new FileNativePromptCompiler();
  }

  async begin(input: {
    worldId: string;
    operationId: string;
    mode: CorrectionMode;
  }): Promise<{ candidateId: string; version: number; parentHead: string }> {
    let claimed:
      | {
          kind: "claimed";
          handle: ContinuityCorrectionWorldClaimHandle;
          value: Awaited<
            ReturnType<FileNativeWorldStore["bindPlayCallChain"]>
          > | null;
        }
      | { kind: "busy" };
    try {
      claimed = await this.#worlds.operations.claimCorrectionWorld(
        input.worldId,
        input.operationId,
        async () => {
          if (!(await this.#worlds.reserveOperation(input.operationId)))
            return null;
          try {
            const frozen = await this.#worlds.bindPlayCallChain(input.worldId);
            this.#worlds.freezeControl(input.worldId, input.operationId);
            return frozen;
          } catch (error: unknown) {
            this.#worlds.releaseControl(input.worldId, input.operationId);
            await this.#worlds.releaseOperationReservation(input.operationId);
            throw error;
          }
        },
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "A durable-state operation is already running for this world",
        );
      throw error;
    }
    if (claimed.kind === "busy")
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "A durable-state operation is already running for this world",
      );
    const binding = claimed.value;
    if (binding === null) {
      await this.#worlds.operations.releaseCorrectionWorld(claimed.handle);
      const previous = await this.#worlds.getOperationOutcome(
        input.operationId,
      );
      throw new Error(
        `The correction operation already exists and cannot be reused: ${previous.outcome}`,
      );
    }
    let revision: ReturnType<typeof beginWorldStateRevision>;
    try {
      revision = beginWorldStateRevision(binding.files);
    } catch (error: unknown) {
      this.#worlds.releaseControl(input.worldId, input.operationId);
      await Promise.allSettled([
        this.#worlds.releaseOperationReservation(input.operationId),
        this.#worlds.operations.releaseCorrectionWorld(claimed.handle),
      ]);
      throw error;
    }
    if (revision.snapshot.status !== "usable") {
      this.#worlds.releaseControl(input.worldId, input.operationId);
      await this.#worlds.failOperation(input.operationId, "failed");
      await this.#worlds.operations.releaseCorrectionWorld(claimed.handle);
      throw new Error(
        "The correction candidate's world-state snapshot is unavailable",
      );
    }
    const claimHeartbeat = setInterval(() => {
      void this.#worlds.operations
        .renewCorrectionWorld(claimed.handle)
        .catch(() => undefined);
    }, claimHeartbeatIntervalMilliseconds);
    claimHeartbeat.unref();
    const candidate: Candidate = {
      ...revision,
      documentMaintenance: await this.#worlds.readDocumentMaintenance(
        input.worldId,
        binding.parentHead,
      ),
      narrativeCheckpoint: binding.narrativeCheckpoint,
      id: `correction-${randomUUID()}`,
      operationId: input.operationId,
      worldId: input.worldId,
      parentHead: binding.parentHead,
      mode: input.mode,
      version: 1,
      materials: structuredClone(binding.additionalMaterials),
      originalMaterials: structuredClone(binding.additionalMaterials),
      history: structuredClone(binding.history),
      reads: new Map(),
      previewedVersion: null,
      stateOperationClaim: claimed.handle,
      claimHeartbeat,
    };
    this.#candidates.set(candidate.id, candidate);
    return {
      candidateId: candidate.id,
      version: candidate.version,
      parentHead: candidate.parentHead,
    };
  }

  readDocument(candidateId: string, handle: string) {
    const candidate = this.#candidate(candidateId);
    const document = readCompleteDocument(candidate.snapshot, handle);
    const contents = candidate.files[document.logicalPath];
    if (contents === undefined)
      throw new Error(
        `Correction document ${handle} has no corresponding candidate source`,
      );
    const hash = sha256(contents);
    candidate.reads.set(document.documentId, {
      snapshotId: candidate.snapshot.id,
      hash,
    });
    return {
      documentId: document.documentId,
      ref: document.shortRef,
      path: document.logicalPath,
      codec: document.codec,
      hash,
      contents,
    };
  }

  patchDocument(input: {
    candidateId: string;
    expectedVersion: number;
    target: string;
    expectedHash: string;
    edits: unknown[];
  }): { version: number } {
    const candidate = this.#atVersion(input.candidateId, input.expectedVersion);
    if (candidate.mode !== "documents")
      throw new Error(
        "A material-list-only correction cannot modify world documents",
      );
    const target = this.#writableDocument(
      candidate,
      input.target,
      input.expectedHash,
    );
    this.#reviseDocument(candidate, {
      kind: "patch",
      document: { documentId: target.documentId },
      edits: input.edits as readonly WorldDocumentRevisionEdit[],
    });
    return this.#advance(candidate);
  }

  replaceDocument(input: {
    candidateId: string;
    expectedVersion: number;
    target: string;
    expectedHash: string;
    contents: string;
  }): { version: number } {
    const candidate = this.#atVersion(input.candidateId, input.expectedVersion);
    if (candidate.mode !== "documents")
      throw new Error(
        "A material-list-only correction cannot modify world documents",
      );
    const target = this.#writableDocument(
      candidate,
      input.target,
      input.expectedHash,
    );
    this.#reviseDocument(candidate, {
      kind: "replace",
      document: { documentId: target.documentId },
      contents: input.contents,
    });
    return this.#advance(candidate);
  }

  replaceMaterials(input: {
    candidateId: string;
    expectedVersion: number;
    nextMaterials: MaterialSelection[];
    prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding">;
  }): { version: number } {
    const candidate = this.#atVersion(input.candidateId, input.expectedVersion);
    if (candidate.mode !== "materials")
      throw new Error(
        "A document correction cannot also replace the additional-materials list",
      );
    const nextMaterials = validateMaterialList(input.nextMaterials);
    this.#compile(candidate, input.prompt, nextMaterials);
    candidate.materials = structuredClone(nextMaterials);
    return this.#advance(candidate);
  }

  preview(input: {
    candidateId: string;
    expectedVersion: number;
    prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
      playPreset?: PlayPresetBinding;
    };
  }): {
    parentHead: string;
    candidateVersion: number;
    diffs: {
      documentId: string;
      path: string;
      beforeHash: string;
      afterHash: string;
      before: string;
      after: string;
    }[];
    materials: { before: MaterialSelection[]; after: MaterialSelection[] };
    nextPrompt: PromptPreview;
  } {
    const candidate = this.#atVersion(input.candidateId, input.expectedVersion);
    const nextPrompt = this.#compile(
      candidate,
      input.prompt,
      candidate.materials,
    );
    candidate.previewedVersion = candidate.version;
    return {
      parentHead: candidate.parentHead,
      candidateVersion: candidate.version,
      diffs: worldStateRevisionChanges(candidate).map((change) => ({
        documentId: change.documentId,
        path: change.after.logicalPath.slice("state/".length),
        beforeHash: change.before?.mechanicalHash ?? "missing",
        afterHash: change.after.mechanicalHash,
        before: change.before?.contents ?? "missing",
        after: change.after.contents,
      })),
      materials: {
        before: structuredClone(candidate.originalMaterials),
        after: structuredClone(candidate.materials),
      },
      nextPrompt,
    };
  }

  async apply(input: {
    candidateId: string;
    expectedVersion: number;
  }): Promise<
    Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >
  > {
    const candidate = this.#atVersion(input.candidateId, input.expectedVersion);
    if (candidate.previewedVersion !== candidate.version)
      throw new Error(
        "Preview the current candidate version before applying a correction",
      );
    if (candidate.snapshot.status !== "usable")
      throw new Error("Only a usable revision can commit a correction");
    try {
      const worldClock = readDeclaredWorldClock(candidate.snapshot);
      return await this.#worlds.commitCorrection({
        ...(worldClock === undefined ? {} : { worldClock }),
        operationId: candidate.operationId,
        worldId: candidate.worldId,
        parentHead: candidate.parentHead,
        nextMaterials: candidate.materials,
        stateChanges: fileNativeStateChanges(candidate),
        stateOperationClaim: candidate.stateOperationClaim,
      });
    } catch (error: unknown) {
      await this.#worlds.failOperation(candidate.operationId, "failed");
      throw error;
    } finally {
      clearInterval(candidate.claimHeartbeat);
      this.#worlds.releaseControl(candidate.worldId, candidate.operationId);
      this.#candidates.delete(candidate.id);
      await this.#worlds.operations
        .releaseCorrectionWorld(candidate.stateOperationClaim)
        .catch(() => undefined);
    }
  }

  async cancel(candidateId: string, expectedVersion: number): Promise<void> {
    const candidate = this.#atVersion(candidateId, expectedVersion);
    clearInterval(candidate.claimHeartbeat);
    this.#candidates.delete(candidateId);
    this.#worlds.releaseControl(candidate.worldId, candidate.operationId);
    try {
      await this.#worlds.failOperation(candidate.operationId, "cancelled");
    } finally {
      await this.#worlds.operations.releaseCorrectionWorld(
        candidate.stateOperationClaim,
      );
    }
  }

  #compile(
    candidate: Candidate,
    prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
      playPreset?: PlayPresetBinding;
    },
    materials: MaterialSelection[],
  ): PromptPreview {
    return this.#compiler.preview(
      {
        endpoint: {
          id: `${candidate.worldId}:${candidate.parentHead}`,
          commit: candidate.parentHead,
          operationId: candidate.operationId,
        },
        hostBinding: structuredClone(prompt.hostBinding),
        world: {
          controlFingerprint: fingerprintControl(candidate.files),
          documentSnapshot: candidate.snapshot,
          additionalMaterials: materials,
          history: candidate.history,
          documentMaintenance: candidate.documentMaintenance,
          narrativeCheckpoint: candidate.narrativeCheckpoint,
        },
        playerInputPlacement: "append",
        playerInput: "",
        modelBinding: prompt.modelBinding,
      },
      prompt.playPreset,
    );
  }

  #candidate(id: string): Candidate {
    const candidate = this.#candidates.get(id);
    if (candidate === undefined)
      throw new Error("The correction candidate does not exist or has ended");
    return candidate;
  }

  #atVersion(id: string, expected: number): Candidate {
    const candidate = this.#candidate(id);
    if (candidate.version !== expected)
      throw new Error("The correction candidate version has changed");
    return candidate;
  }

  #writableDocument(
    candidate: Candidate,
    handle: string,
    expectedHash: string,
  ): WorldDocumentDescriptor {
    const document = readCompleteDocument(candidate.snapshot, handle);
    const read = candidate.reads.get(document.documentId);
    if (
      read?.snapshotId !== candidate.snapshot.id ||
      read.hash !== expectedHash
    )
      throw new Error(
        "A correction document must be read in full first and carry the same pre-write hash",
      );
    const contents = candidate.files[document.logicalPath];
    if (contents === undefined || sha256(contents) !== expectedHash)
      throw new Error("The correction document's pre-write hash has changed");
    return document;
  }

  #reviseDocument(
    candidate: Candidate,
    command: WorldDocumentRevisionCommand,
  ): void {
    const revised = reviseWorldState(candidate, { commands: [command] });
    if (!revised.ok || revised.snapshotStatus !== "usable")
      throw new Error(worldDocumentRevisionFailureMessage(revised.diagnostics));
    candidate.reads.clear();
  }

  #advance(candidate: Candidate): { version: number } {
    candidate.version += 1;
    candidate.previewedVersion = null;
    return { version: candidate.version };
  }
}

function readCompleteDocument(
  snapshot: WorldDocumentStore,
  handle: string,
): WorldDocumentDescriptor {
  const requested = handle.replace(/^@/u, "");
  const selectors: readonly WorldDocumentSelector[] = handle.startsWith("@")
    ? [{ shortRef: requested }]
    : [{ documentId: requested }, { shortRef: requested }];
  for (const selector of selectors) {
    const result = snapshot.query({
      kind: "read_document",
      document: selector,
    });
    if (result.kind === "error") {
      if (result.diagnostics.every(({ code }) => code === "document_not_found"))
        continue;
      throw new Error(worldDocumentRevisionFailureMessage(result.diagnostics));
    }
    if (result.kind !== "read_document")
      throw new Error(
        "The correction document's exact read returned the wrong query result",
      );
    return result.document;
  }
  throw new Error(`Correction document ${handle} does not exist`);
}

function fingerprintControl(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, contents] of Object.entries(files)
    .filter(([path]) => path.startsWith("control/"))
    .sort(([left], [right]) => left.localeCompare(right)))
    hash.update(path).update("\0").update(contents).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
