import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ContentTreeFile } from "../content/ContentWorkspace.ts";
import {
  inspectContentPackageCurrentTree,
  isContentPackageWorldDocumentPath,
  type FileNativeContentDocument,
} from "../content/FileNativeContentTree.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
  type MaterialSelection,
  type PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import { PlayerViewRenderer } from "./PlayerViewRenderer.ts";
import { WorldDocumentStore } from "./WorldDocumentStore.ts";
import { FileNativePlayTimelineStore } from "../play/FileNativePlayTimelineStore.ts";
import { FileNativePlayAdvanceStore } from "../play/FileNativePlayAdvanceStore.ts";
import {
  FileNativeWorldOperationCoordinator,
  WorldOperationBusyError,
  type ContinuityCorrectionWorldClaimHandle,
} from "./WorldOperationCoordinator.ts";

const publicationFile = "publication.json";
const localMetadataFile = "local.json";
const playAuthorityHeadFile = "play-authority-head.json";

export class FileNativeWorldCreationError extends Error {
  readonly code:
    | "content_package_needs_repair"
    | "candidate_validation_failed"
    | "operation_conflict"
    | "world_corrupt"
    | "inconsistent_materialization";

  constructor(
    code: FileNativeWorldCreationError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileNativeWorldCreationError";
    this.code = code;
  }
}

export class FileNativeWorldNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super("World does not exist", options);
    this.name = "FileNativeWorldNotFoundError";
  }
}

export interface FileNativeWorldCreationInput {
  operationId: string;
  sourcePackageId: string;
  packageFiles: readonly ContentTreeFile[];
  prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
    playerInput?: string;
  };
}

export interface FileNativeWorldSummary {
  worldId: string;
  title: string;
  parentEndpoint: "genesis";
}

interface Publication extends FileNativeWorldSummary {
  schemaVersion: 1;
  operationId: string;
  sourceFingerprint: string;
}

interface WorldLocalMetadata {
  schemaVersion: 1;
  worldId: string;
  name: string;
}

interface Genesis {
  schemaVersion: 1;
  type: "file_native_genesis";
  worldId: string;
  operationId: string;
  parentEndpoint: "genesis";
  state: { path: string; sha256: string; canonicalBytes: string }[];
  control: { path: string; sha256: string; canonicalBytes: string }[];
  history: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
  }[];
  additionalMaterials: MaterialSelection[];
}

interface LegacyDerivationGenesis extends Genesis {
  derivedFrom?: { worldId: string; head: string };
  hostPresetId?: string;
}

export type FileNativeWorldCreationOutcome =
  | { outcome: "created"; world: FileNativeWorldSummary }
  | { outcome: "not_created" | "in_progress" };

export interface FileNativePlayBinding {
  worldId: string;
  parentHead: string;
  files: Record<string, string>;
  additionalMaterials: MaterialSelection[];
  history: Record<string, string>;
}

export interface FileNativeStateChange {
  kind: "create" | "replace";
  documentId: string;
  stableShortRef: string;
  relativePath: string;
  codec: "yaml" | "markdown";
  expectedPreviousHash: string | null;
  nextHash: string;
  canonicalNextBytes: string;
}

interface FileNativeImmutableStateFile {
  path: string;
  sha256: string;
  canonicalBytes: string;
}

interface FileNativeTimelineRevision {
  restoresHead: string;
  replacesHead: string;
  requestFingerprint: string;
  replacementState: FileNativeImmutableStateFile[];
  replacementHistory: Genesis["history"];
}

export interface FileNativePlayCommit {
  schemaVersion: 2;
  sequence: number;
  operationId: string;
  parentHead: string;
  parentCommitDigest: string | null;
  head: string;
  mode: "play" | "correction" | "timeline_revision";
  historyAppend: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
  }[];
  stateChanges: FileNativeStateChange[];
  nextAdditionalMaterials: MaterialSelection[];
  correctionTargets?: string[];
  corrects?: string;
  timelineRevision?: FileNativeTimelineRevision;
}

interface FileNativePlayAuthority {
  schemaVersion: 2;
  head: string;
  commits: FileNativePlayCommit[];
}

interface FileNativePlayAuthorityHead {
  schemaVersion: 2;
  head: string;
  sequence: number;
  commitDigest: string | null;
  operationId: string | null;
}

interface FileNativeMaterializedCheckpoint {
  schemaVersion: 2;
  head: string;
  sequence: number;
  commitDigest: string | null;
}

export type FileNativeOperationOutcome =
  | { outcome: "not_started" | "in_progress" }
  | { outcome: "failed"; operationId?: string }
  | { outcome: "cancelled"; operationId?: string }
  | {
      outcome: "committed" | "committed_materialization_pending";
      worldId: string;
      parentHead: string;
      head: string;
      commitDigest: string;
      historyAppend: { role: "player" | "narrator"; exactText: string }[];
      nextAdditionalMaterials: MaterialSelection[];
      mode: "play" | "correction" | "timeline_revision";
    };

type FileNativeAcceptancePreparedOutcome = Omit<
  Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
  "outcome"
> & { outcome: "acceptance_prepared" };

export interface FileNativeRecoveredEndpoint {
  worldId: string;
  head: string;
  state: ContentTreeFile[];
  history: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
  }[];
  additionalMaterials: MaterialSelection[];
}

export type FileNativeDerivationOutcome =
  | { outcome: "derived"; world: FileNativeWorldSummary }
  | { outcome: "not_derived" | "in_progress" };

interface FileNativeWorldDerivationInput {
  operationId: string;
  sourceWorldId: string;
  sourceHead: string;
  hostPresetId: string;
  /** Additional idempotency identity for a higher-level branch request. */
  requestDiscriminator?: string;
}

export class FileNativeWorldStore {
  readonly #worldsRoot: string;
  readonly #operationsRoot: string;
  readonly #promptCompiler: FileNativePromptCompiler;
  readonly #activeControlUsers = new Map<string, Set<string>>();
  readonly operations: FileNativeWorldOperationCoordinator;
  readonly playTimeline: FileNativePlayTimelineStore;
  readonly playAdvances: FileNativePlayAdvanceStore;

  constructor(
    dataRoot: string,
    options: { promptCompiler?: FileNativePromptCompiler } = {},
  ) {
    const root = resolve(dataRoot);
    this.#worldsRoot = join(root, "worlds-file-native");
    this.#operationsRoot = join(root, "operations");
    this.#promptCompiler =
      options.promptCompiler ?? new FileNativePromptCompiler();
    this.operations = new FileNativeWorldOperationCoordinator(root);
    this.playTimeline = new FileNativePlayTimelineStore(root);
    this.playAdvances = new FileNativePlayAdvanceStore(root);
  }

  async listWorlds(): Promise<FileNativeWorldSummary[]> {
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#worldsRoot, { withFileTypes: true });
    const worlds: FileNativeWorldSummary[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      worlds.push(await readWorldSummaryAt(join(this.#worldsRoot, entry.name)));
    }
    return worlds;
  }

  async renameWorld(
    worldId: string,
    name: string,
  ): Promise<FileNativeWorldSummary> {
    assertIdentity(worldId, "World ID");
    const trimmed = name.trim();
    if (!validWorldName(trimmed))
      throw new TypeError(
        "World name must contain 1 to 160 characters and no line breaks",
      );
    return this.operations.withWorldLocalMetadataMutation(worldId, async () => {
      const root = join(this.#worldsRoot, worldId);
      let publication: Publication;
      try {
        publication = await readPublicationAt(root);
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT")
          throw new FileNativeWorldNotFoundError({ cause: error });
        throw error;
      }
      await publishJson(join(root, localMetadataFile), {
        schemaVersion: 1,
        worldId,
        name: trimmed,
      } satisfies WorldLocalMetadata);
      return { ...toSummary(publication), title: trimmed };
    });
  }

  /**
   * Delete a world and everything the runtime keeps under it. The exclusive
   * world-state mutation prevents deletion from racing an active play or
   * correction operation. Expired claims do not block cleanup.
   */
  async deleteWorld(worldId: string): Promise<{ deleted: true }> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    try {
      await readPublicationAt(root);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        throw new FileNativeWorldNotFoundError({ cause: error });
      throw error;
    }
    return this.operations.withExclusiveWorldStateMutation(
      worldId,
      async () => {
        await rm(root, { recursive: true, force: true });
        return { deleted: true } as const;
      },
    );
  }

  async createFromContentPackage(input: FileNativeWorldCreationInput): Promise<{
    outcome: "created";
    world: FileNativeWorldSummary;
    preview: PromptPreview;
  }> {
    assertIdentity(input.operationId, "operation ID");
    assertIdentity(input.sourcePackageId, "Content-package local identity");
    const inspection = inspectContentPackageCurrentTree(input.packageFiles);
    if (inspection.status !== "usable") {
      throw new FileNativeWorldCreationError(
        "content_package_needs_repair",
        `Only a content package that passes all validation can create a world: ${inspection.issues
          .map(({ message }) => message)
          .join("；")}`,
      );
    }
    const packageFiles = inspection.worldDocumentSnapshot.files.map(
      ({ path, contents, encoding }) => ({
        path,
        contents,
        ...(encoding === undefined ? {} : { encoding }),
      }),
    );
    const stateSnapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: packageFiles
        .filter(({ path }) => isContentPackageWorldDocumentPath(path))
        .map(({ path, contents, encoding }) => ({
          path: toWorldStatePath(path),
          contents,
          ...(encoding === undefined ? {} : { encoding }),
        })),
    });
    assertEquivalentWorldDocumentSnapshots(inspection.documents, stateSnapshot);
    const state = selectSurface(stateSnapshot.files, "state/");
    const control = selectSurface(packageFiles, "control/");
    const boundInput: FileNativeWorldCreationInput = {
      ...input,
      packageFiles,
    };

    const sourceFingerprint = fingerprint(packageFiles);
    const previous = await this.#readPublication(input.operationId);
    if (previous !== null) {
      if (previous.sourceFingerprint !== sourceFingerprint) {
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same operation ID is bound to a different creation payload",
        );
      }
      const preview = this.#preview(boundInput, previous.worldId);
      return {
        outcome: "created",
        world: await this.#currentSummary(previous),
        preview,
      };
    }

    // Preview happens before any staging write, so a slot/overlap/budget failure
    // cannot leave a partially published world.
    const worldId = `world-${operationDigest(input.operationId).slice(0, 24)}`;
    const preview = this.#preview(boundInput, worldId);
    const finalRoot = join(this.#worldsRoot, worldId);
    const stagingRoot = join(
      this.#worldsRoot,
      `.staging-${worldId}-${randomUUID()}`,
    );
    const operationPath = this.#operationPath(input.operationId);
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    await rm(stagingRoot, { recursive: true, force: true });
    try {
      const openingMessage = genesisOpeningMessage(
        worldId,
        openingText(packageFiles),
      );
      const initialMaterials: MaterialSelection[] = [
        { kind: "history_message", message: openingMessage.messageId },
      ];
      await writeSurface(stagingRoot, "state", state);
      await writeSurface(stagingRoot, "control", control);
      await mkdir(join(stagingRoot, "history"), { recursive: true });
      await mkdir(join(stagingRoot, "runtime"), { recursive: true });
      await writeIdempotentText(
        join(
          stagingRoot,
          "history",
          `00000000-${historyFileName(1, openingMessage)}`,
        ),
        openingMessage.exactText,
      );
      const genesis: Genesis = {
        schemaVersion: 1,
        type: "file_native_genesis",
        worldId,
        operationId: input.operationId,
        parentEndpoint: "genesis",
        state: immutableFiles(state),
        control: immutableFiles(control),
        history: [openingMessage],
        additionalMaterials: initialMaterials,
      };
      await writeJson(join(stagingRoot, "runtime", "genesis.json"), genesis);
      await writeJson(
        join(stagingRoot, "runtime", "play-genesis-timeline.json"),
        {
          schemaVersion: 1,
          worldId,
          history: genesis.history,
        },
      );
      await writeJson(
        join(stagingRoot, "runtime", playAuthorityHeadFile),
        genesisAuthorityHead(),
      );
      await writeJson(join(stagingRoot, "runtime", "materialized-head.json"), {
        schemaVersion: 2,
        head: "genesis",
        sequence: 0,
        commitDigest: null,
      } satisfies FileNativeMaterializedCheckpoint);
      await writeJson(
        join(stagingRoot, "runtime", "additional-materials.json"),
        { head: "genesis", items: initialMaterials },
      );
      const publication: Publication = {
        schemaVersion: 1,
        worldId,
        title: inspection.displayName,
        parentEndpoint: "genesis",
        operationId: input.operationId,
        sourceFingerprint,
      };
      await writeJson(join(stagingRoot, publicationFile), publication);
      await durableTree(stagingRoot);
      crashAtFileNativeWorldCreationEdge("after_staging");
      await rename(stagingRoot, finalRoot);
      await syncDirectory(this.#worldsRoot);
      crashAtFileNativeWorldCreationEdge("after_atomic_publish");
      await publishOperation(operationPath, publication);
      return { outcome: "created", world: toSummary(publication), preview };
    } catch (error: unknown) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      const recovered = await this.#readPublication(input.operationId);
      if (recovered !== null) {
        if (recovered.sourceFingerprint === sourceFingerprint) {
          return {
            outcome: "created",
            world: await this.#currentSummary(recovered),
            preview,
          };
        }
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same operation ID is bound to a different creation payload",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getCreationOutcome(
    operationId: string,
  ): Promise<FileNativeWorldCreationOutcome> {
    assertIdentity(operationId, "operation ID");
    const publication = await this.#readPublication(operationId);
    return publication === null
      ? { outcome: "not_created" }
      : { outcome: "created", world: await this.#currentSummary(publication) };
  }

  async readSurface(
    worldId: string,
    surface: "state" | "control" | "history",
  ): Promise<ContentTreeFile[]>;
  async readSurface(
    worldId: string,
    surface: "runtime",
  ): Promise<Genesis & { historyEntries: number }>;
  async readSurface(
    worldId: string,
    surface: "state" | "control" | "history" | "runtime",
  ): Promise<ContentTreeFile[] | (Genesis & { historyEntries: number })> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    if (surface === "runtime") {
      const genesis = await readJson<Genesis>(
        join(root, "runtime", "genesis.json"),
      );
      return {
        ...genesis,
        historyEntries: (await readTree(join(root, "history"))).length,
      };
    }
    return readTree(join(root, surface));
  }

  async renderPlayerViews(worldId: string) {
    const head = await this.currentHead(worldId);
    return this.renderPlayerViewsAtHead(worldId, head);
  }

  /**
   * Render only from the immutable Authority endpoint named by `head`.
   * Materialized files may lag an accepted commit, so player-view projections
   * must never pair a mutable state tree with a different response head.
   */
  async renderPlayerViewsAtHead(worldId: string, head: string) {
    const root = join(this.#worldsRoot, worldId);
    const materialized = await readOptionalJson<{ head: string }>(
      join(root, "runtime", "materialized-head.json"),
    );
    const [state, control] = await Promise.all([
      materialized?.head === head
        ? readTree(join(root, "state"))
        : this.recoverEndpoint(worldId, head).then(({ state }) => state),
      this.readSurface(worldId, "control"),
    ]);
    const source = control.find(({ path }) => path === "player-views.yaml");
    return new PlayerViewRenderer().render({
      snapshot: openWorldDocumentSnapshot(state),
      control: source?.contents ?? "",
    });
  }

  async currentHead(worldId: string): Promise<string> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return (await readAuthorityHead(root)).head;
  }

  async currentHeadOperationId(worldId: string): Promise<string | null> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return (await readAuthorityHead(root)).operationId;
  }

  async saveControlDraft(
    worldId: string,
    files: readonly ContentTreeFile[],
  ): Promise<{ fingerprint: string }> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    for (const file of files) assertRelativePath(file.path);
    const staging = join(root, `runtime/.control-draft-${randomUUID()}`);
    await writeSurface(staging, "control", files);
    const final = join(root, "runtime/control-draft");
    await rm(final, { recursive: true, force: true });
    await rename(join(staging, "control"), final);
    await rm(staging, { recursive: true, force: true });
    return { fingerprint: fingerprint(files) };
  }

  async previewControlDraft(
    worldId: string,
    prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
      playerInput?: string;
    },
  ): Promise<PromptPreview> {
    const { state, draft } = await this.#readControlDraft(worldId);
    const rendered = new PlayerViewRenderer().render({
      snapshot: openWorldDocumentSnapshot(state),
      control:
        draft.find(({ path }) => path === "player-views.yaml")?.contents ?? "",
    });
    if (rendered.diagnostics.length > 0)
      throw new FileNativeWorldCreationError(
        "content_package_needs_repair",
        `Player views in the control draft cannot be applied: ${rendered.diagnostics.map(({ message }) => message).join("; ")}`,
      );
    return this.#promptCompiler.preview({
      endpoint: { id: `${worldId}:current`, commit: "current" },
      hostBinding: prompt.hostBinding,
      world: {
        controlFingerprint: fingerprint(draft),
        documentSnapshot: WorldDocumentStore.open({
          layout: "world_state",
          files: [
            ...state.map(({ path, contents }) => ({
              path: `state/${path}`,
              contents,
            })),
            ...draft.map(({ path, contents }) => ({
              path: `control/${path}`,
              contents,
            })),
          ],
        }),
        additionalMaterials: [],
      },
      playerInputPlacement: "bootstrap",
      playerInput: prompt.playerInput ?? "Preview world control.",
      modelBinding: prompt.modelBinding,
    });
  }

  async applyControlDraft(
    worldId: string,
    prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
      playerInput?: string;
    },
  ): Promise<{ controlFingerprint: string; preview: PromptPreview }> {
    try {
      return await this.operations.withExclusiveWorldStateMutation(
        worldId,
        async () => {
          if ((this.#activeControlUsers.get(worldId)?.size ?? 0) > 0)
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "World control is frozen by a running attempt",
            );
          const preview = await this.previewControlDraft(worldId, prompt);
          const root = join(this.#worldsRoot, worldId);
          const draft = join(root, "runtime/control-draft");
          const replacement = join(
            root,
            `runtime/.control-apply-${randomUUID()}`,
          );
          await rename(draft, replacement);
          const old = join(root, `runtime/.control-old-${randomUUID()}`);
          await rename(join(root, "control"), old);
          try {
            await rename(replacement, join(root, "control"));
            await rm(old, { recursive: true, force: true }).catch(
              () => undefined,
            );
          } catch (error: unknown) {
            await rename(old, join(root, "control")).catch(() => undefined);
            throw error;
          }
          return {
            controlFingerprint: preview.diagnosticBinding.controlFingerprint,
            preview,
          };
        },
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World control is frozen by a running play call chain",
        );
      throw error;
    }
  }

  freezeControl(worldId: string, operationId: string): void {
    assertIdentity(worldId, "World ID");
    assertIdentity(operationId, "operation ID");
    const users = this.#activeControlUsers.get(worldId) ?? new Set<string>();
    users.add(operationId);
    this.#activeControlUsers.set(worldId, users);
  }

  releaseControl(worldId: string, operationId: string): void {
    const users = this.#activeControlUsers.get(worldId);
    users?.delete(operationId);
    if (users?.size === 0) this.#activeControlUsers.delete(worldId);
  }

  async #readControlDraft(
    worldId: string,
  ): Promise<{ state: ContentTreeFile[]; draft: ContentTreeFile[] }> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const [state, draft] = await Promise.all([
      readTree(join(root, "state")),
      readTree(join(root, "runtime/control-draft")),
    ]);
    if (draft.length === 0)
      throw new FileNativeWorldCreationError(
        "content_package_needs_repair",
        "World-control draft has not been saved",
      );
    return { state, draft };
  }

  /** Bind the current Authority endpoint for a model-directed play call chain. */
  async bindPlayCallChain(worldId: string): Promise<FileNativePlayBinding> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    try {
      await readPublicationAt(root);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const worldRoot = await stat(root).catch((rootError: unknown) => {
          if (isNodeError(rootError) && rootError.code === "ENOENT")
            return null;
          throw rootError;
        });
        if (worldRoot === null)
          throw new FileNativeWorldNotFoundError({ cause: error });
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          worldRoot.isDirectory()
            ? "World publication is missing"
            : "World storage root is not a directory",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return await this.operations.withWorldAuthorityLock(worldId, async () => {
        const authority = await readAuthorityHead(root);
        const checkpoint = await readMaterializedCheckpoint(root);
        if (!sameMaterializedEndpoint(checkpoint, authority)) {
          const missing = await readAuthorityTail(root, authority, checkpoint);
          for (const commit of missing) {
            await materializePlayCommit(root, commit.sequence, {
              mode: commit.mode,
              historyAppend: commit.historyAppend,
              nextMaterials: commit.nextAdditionalMaterials,
              stateChanges: commit.stateChanges,
              ...(commit.timelineRevision === undefined
                ? {}
                : { timelineRevision: commit.timelineRevision }),
            });
            await publishJson(this.#operationOutcomePath(commit.operationId), {
              outcome: "committed",
              worldId,
              parentHead: commit.parentHead,
              head: commit.head,
              commitDigest: playCommitDigest(commit),
              historyAppend: commit.historyAppend.map(
                ({ role, exactText }) => ({ role, exactText }),
              ),
              nextAdditionalMaterials: commit.nextAdditionalMaterials,
              mode: commit.mode,
            } satisfies FileNativeOperationOutcome);
          }
          await publishJson(join(root, "runtime", "materialized-head.json"), {
            schemaVersion: 2,
            head: authority.head,
            sequence: authority.sequence,
            commitDigest: authority.commitDigest,
          } satisfies FileNativeMaterializedCheckpoint);
        }
        const [state, control, history, materials] = await Promise.all([
          readTree(join(root, "state")),
          readTree(join(root, "control")),
          readTree(join(root, "history")),
          readOptionalJson<{ head: string; items: MaterialSelection[] }>(
            join(root, "runtime", "additional-materials.json"),
          ),
        ]);
        if ((materials?.head ?? "genesis") !== authority.head)
          throw new FileNativeWorldCreationError(
            "inconsistent_materialization",
            "Materialized additional materials do not match the current Authority endpoint",
          );
        return {
          worldId,
          parentHead: authority.head,
          files: [...state, ...control].reduce<Record<string, string>>(
            (files, { path, contents }, index) => {
              files[`${index < state.length ? "state" : "control"}/${path}`] =
                contents;
              return files;
            },
            {},
          ),
          additionalMaterials: materials?.items ?? [],
          history: materializedHistoryRecord(worldId, history),
        };
      });
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World Authority is being updated by another durable operation",
        );
      throw error;
    }
  }

  async reserveOperation(operationId: string): Promise<boolean> {
    assertIdentity(operationId, "operation ID");
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    const path = this.#operationOutcomePath(operationId);
    try {
      await writeFile(
        path,
        `${JSON.stringify({ outcome: "in_progress" }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await syncFile(path);
      await syncDirectory(this.#operationsRoot);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EEXIST") return false;
      throw error;
    }
  }

  async releaseOperationReservation(operationId: string): Promise<void> {
    assertIdentity(operationId, "operation ID");
    const path = this.#operationOutcomePath(operationId);
    const current = await readOptionalJson<unknown>(path);
    if (current === null) return;
    if (
      !isRecord(current) ||
      !hasExactKeys(current, ["outcome"]) ||
      current.outcome !== "in_progress"
    )
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Operation reservation to release has an invalid shape",
      );
    await rm(path, { force: true });
    await syncDirectory(this.#operationsRoot);
  }

  async recoverEndpoint(
    worldId: string,
    head?: string,
  ): Promise<FileNativeRecoveredEndpoint> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const genesis = await readJson<Genesis>(
      join(root, "runtime", "genesis.json"),
    );
    for (const file of [...genesis.state, ...genesis.control])
      if (sha256(file.canonicalBytes) !== file.sha256)
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `Genesis file hash does not match: ${file.path}`,
        );
    const authority = await readAcceptedAuthority(root);
    const target = head ?? authority?.head ?? "genesis";
    const commits = authority?.commits ?? [];
    const end =
      target === "genesis"
        ? 0
        : commits.findIndex((commit) => commit.head === target) + 1;
    if (target !== "genesis" && end === 0)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Cannot rebuild endpoint from immutable authority chain: ${target}`,
      );
    const state = new Map(
      genesis.state.map((file) => [file.path, file.canonicalBytes]),
    );
    const history: FileNativeRecoveredEndpoint["history"] = structuredClone(
      genesis.history,
    );
    let additionalMaterials: MaterialSelection[] = genesis.additionalMaterials;
    for (const commit of commits.slice(0, end)) {
      if (commit.mode === "timeline_revision") {
        const revision = commit.timelineRevision;
        if (revision === undefined)
          throw new FileNativeWorldCreationError(
            "world_corrupt",
            "Timeline-revision commit is missing its recovery snapshot",
          );
        const restored = await this.recoverEndpoint(
          worldId,
          revision.restoresHead,
        );
        if (
          !isDeepStrictEqual(
            revision.replacementState,
            immutableFiles(restored.state),
          ) ||
          !isDeepStrictEqual(revision.replacementHistory, restored.history) ||
          !isDeepStrictEqual(
            commit.nextAdditionalMaterials,
            restored.additionalMaterials,
          )
        )
          throw new FileNativeWorldCreationError(
            "world_corrupt",
            "Timeline-revision recovery snapshot does not match its logical parent endpoint",
          );
        state.clear();
        for (const file of revision.replacementState) {
          if (sha256(file.canonicalBytes) !== file.sha256)
            throw new FileNativeWorldCreationError(
              "world_corrupt",
              `Timeline-revision state hash does not match: ${file.path}`,
            );
          state.set(file.path, file.canonicalBytes);
        }
        history.splice(
          0,
          history.length,
          ...structuredClone(revision.replacementHistory),
        );
      } else {
        for (const change of commit.stateChanges) {
          const existing = state.get(change.relativePath);
          const existingHash = existing === undefined ? null : sha256(existing);
          if (existingHash !== change.expectedPreviousHash)
            throw new FileNativeWorldCreationError(
              "world_corrupt",
              `Immutable commit-chain previous hash does not match: ${change.relativePath}`,
            );
          if (sha256(change.canonicalNextBytes) !== change.nextHash)
            throw new FileNativeWorldCreationError(
              "world_corrupt",
              `Immutable commit-chain next hash does not match: ${change.relativePath}`,
            );
          state.set(change.relativePath, change.canonicalNextBytes);
        }
      }
      history.push(...structuredClone(commit.historyAppend));
      additionalMaterials = structuredClone(commit.nextAdditionalMaterials);
    }
    return {
      worldId,
      head: target,
      state: [...state]
        .map(([path, contents]) => ({ path, contents }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      history,
      additionalMaterials,
    };
  }

  async repairMaterialization(
    worldId: string,
  ): Promise<FileNativeOperationOutcome> {
    assertIdentity(worldId, "World ID");
    try {
      const operationId = await this.operations.withExclusiveWorldStateMutation(
        worldId,
        async () => {
          await this.bindPlayCallChain(worldId);
          const root = join(this.#worldsRoot, worldId);
          const authority = await readAcceptedAuthority(root);
          return authority?.commits.at(-1)?.operationId ?? null;
        },
      );
      return operationId === null
        ? { outcome: "not_started" }
        : this.getOperationOutcome(operationId);
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "This world has a durable state operation and cannot repair materialization yet",
        );
      throw error;
    }
  }

  async deriveWorld(
    input: FileNativeWorldDerivationInput,
  ): Promise<{ outcome: "derived"; world: FileNativeWorldSummary }> {
    assertIdentity(input.operationId, "Fork operation ID");
    assertIdentity(input.sourceWorldId, "Source world ID");
    assertIdentity(input.hostPresetId, "Host-preset ID");
    if (input.requestDiscriminator !== undefined)
      assertIdentity(input.requestDiscriminator, "Fork request discriminator");
    if (
      input.sourceHead !== "genesis" &&
      !/^commit:[1-9][0-9]*$/u.test(input.sourceHead)
    )
      throw new TypeError("Source endpoint is invalid");
    const operationPath = this.#derivationOperationPath(input.operationId);
    const requestFingerprint = derivationRequestFingerprint(input);
    const worldId = `world-${operationDigest(`derive:${input.operationId}`).slice(0, 24)}`;
    const finalRoot = join(this.#worldsRoot, worldId);
    const previous = await readOptionalJson<Publication>(operationPath);
    if (previous !== null) {
      if (
        !(await derivationPublicationMatches(
          join(this.#worldsRoot, previous.worldId),
          previous,
          input,
          requestFingerprint,
        ))
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same fork operation ID is bound to a different fork payload",
        );
      return {
        outcome: "derived",
        world: await this.#currentSummary(previous),
      };
    }

    const alreadyPublished = await readOptionalJson<Publication>(
      join(finalRoot, publicationFile),
    );
    if (alreadyPublished !== null) {
      if (
        !(await derivationPublicationMatches(
          finalRoot,
          alreadyPublished,
          input,
          requestFingerprint,
        ))
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "Published fork world does not match the operation payload",
        );
      await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
      await publishJson(operationPath, alreadyPublished);
      return {
        outcome: "derived",
        world: await this.#currentSummary(alreadyPublished),
      };
    }

    const sourceRoot = join(this.#worldsRoot, input.sourceWorldId);
    const sourcePublication = await readPublicationAt(sourceRoot);
    const sourceSummary = await readWorldSummaryAt(
      sourceRoot,
      sourcePublication,
    );
    const [sourceGenesis, selected, sourceAuthority, control] =
      await Promise.all([
        this.recoverEndpoint(input.sourceWorldId, "genesis"),
        this.recoverEndpoint(input.sourceWorldId, input.sourceHead),
        readAcceptedAuthority(sourceRoot),
        readTree(join(sourceRoot, "control")),
      ]);
    const cloned = cloneAuthorityPrefix({
      sourceWorldId: input.sourceWorldId,
      sourceHead: input.sourceHead,
      targetWorldId: worldId,
      sourceGenesis,
      sourceAuthority,
    });
    const staging = join(
      this.#worldsRoot,
      `.staging-${worldId}-${randomUUID()}`,
    );
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    try {
      await writeSurface(staging, "state", sourceGenesis.state);
      await writeSurface(staging, "control", control);
      await mkdir(join(staging, "history"), { recursive: true });
      await mkdir(join(staging, "runtime"), { recursive: true });
      for (const [index, message] of cloned.genesisHistory.entries())
        await writeIdempotentText(
          join(
            staging,
            "history",
            `00000000-${historyFileName(index + 1, message)}`,
          ),
          message.exactText,
        );
      const genesis: Genesis = {
        schemaVersion: 1,
        type: "file_native_genesis",
        worldId,
        operationId: input.operationId,
        parentEndpoint: "genesis",
        state: immutableFiles(sourceGenesis.state),
        control: immutableFiles(control),
        history: cloned.genesisHistory,
        additionalMaterials: cloned.genesisMaterials,
      };
      await writeJson(join(staging, "runtime", "genesis.json"), genesis);
      await writeJson(join(staging, "runtime", "play-genesis-timeline.json"), {
        schemaVersion: 1,
        worldId,
        history: genesis.history,
      });
      await writeJson(join(staging, "runtime", "additional-materials.json"), {
        head: "genesis",
        items: cloned.genesisMaterials,
      });
      for (const [index, commit] of cloned.commits.entries()) {
        const digest = playCommitDigest(commit);
        await publishImmutableJson(
          join(staging, "runtime", "play-commits", `${digest}.json`),
          commit,
        );
        await materializePlayCommit(staging, index + 1, {
          mode: commit.mode,
          historyAppend: commit.historyAppend,
          nextMaterials: commit.nextAdditionalMaterials,
          stateChanges: commit.stateChanges,
          ...(commit.timelineRevision === undefined
            ? {}
            : { timelineRevision: commit.timelineRevision }),
        });
      }
      const clonedHead = cloned.commits.at(-1);
      await writeJson(
        join(staging, "runtime", playAuthorityHeadFile),
        clonedHead === undefined
          ? genesisAuthorityHead()
          : ({
              schemaVersion: 2,
              head: clonedHead.head,
              sequence: clonedHead.sequence,
              commitDigest: playCommitDigest(clonedHead),
              operationId: clonedHead.operationId,
            } satisfies FileNativePlayAuthorityHead),
      );
      await writeJson(join(staging, "runtime", "materialized-head.json"), {
        schemaVersion: 2,
        head: input.sourceHead,
        sequence: clonedHead?.sequence ?? 0,
        commitDigest:
          clonedHead === undefined ? null : playCommitDigest(clonedHead),
      } satisfies FileNativeMaterializedCheckpoint);
      const materializedState = await readTree(join(staging, "state"));
      if (!isDeepStrictEqual(materializedState, selected.state))
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          "Fork Authority prefix cannot rebuild the source endpoint state",
        );
      const publication: Publication = {
        schemaVersion: 1,
        worldId,
        title: derivedWorldName(sourceSummary.title),
        parentEndpoint: "genesis",
        operationId: input.operationId,
        sourceFingerprint: requestFingerprint,
      };
      await writeJson(join(staging, publicationFile), publication);
      await durableTree(staging);
      crashAtFileNativeAuthorityEdge("derivation_before_publish");
      await rename(staging, finalRoot);
      await syncDirectory(this.#worldsRoot);
      crashAtFileNativeAuthorityEdge("derivation_after_publish");
      await publishJson(operationPath, publication);
      return { outcome: "derived", world: toSummary(publication) };
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
      const published = await readOptionalJson<Publication>(
        join(finalRoot, publicationFile),
      );
      if (published !== null) {
        if (
          !(await derivationPublicationMatches(
            finalRoot,
            published,
            input,
            requestFingerprint,
          ))
        )
          throw new FileNativeWorldCreationError(
            "operation_conflict",
            "Published fork world does not match the operation payload",
          );
        await publishJson(operationPath, published);
        return { outcome: "derived", world: toSummary(published) };
      }
      throw error;
    }
  }

  async failOperation(
    operationId: string,
    outcome: "failed" | "cancelled" = "failed",
  ): Promise<void> {
    const current = await this.getOperationOutcome(operationId);
    if (isCommittedOutcome(current)) return;
    await writeJson(this.#operationOutcomePath(operationId), { outcome });
  }

  async getOperationOutcome(
    operationId: string,
  ): Promise<FileNativeOperationOutcome> {
    return this.#readOperationOutcome(operationId);
  }

  async #readOperationOutcome(
    operationId: string,
  ): Promise<FileNativeOperationOutcome> {
    assertIdentity(operationId, "operation ID");
    let directRecord: Record<string, unknown> | null;
    try {
      const value = await readOptionalJson<unknown>(
        this.#operationOutcomePath(operationId),
      );
      if (value === null) directRecord = null;
      else {
        assertOperationOutcomeIntegrity(value);
        directRecord = value;
      }
    } catch (error: unknown) {
      if (error instanceof FileNativeWorldCreationError) throw error;
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Authority operation outcome has an invalid structure",
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (directRecord?.outcome === "acceptance_prepared")
      return resolvePreparedOperationOutcome(
        this.#worldsRoot,
        operationId,
        directRecord,
      );
    const direct =
      directRecord === null ? null : projectOperationOutcome(directRecord);
    if (
      direct?.outcome === "committed" ||
      direct?.outcome === "committed_materialization_pending"
    ) {
      const worldRoot = join(this.#worldsRoot, direct.worldId);
      const commit = await assertCommittedAuthorityOutcomeMatches(
        worldRoot,
        operationId,
        direct,
      );
      const materialized = await readMaterializedCheckpoint(worldRoot);
      if (materialized !== null && materialized.sequence >= commit.sequence)
        return { ...direct, outcome: "committed" };
      await assertPendingMaterializationCompatible(
        worldRoot,
        operationId,
        direct.commitDigest,
      );
      return { ...direct, outcome: "committed_materialization_pending" };
    }
    return direct?.outcome === "in_progress"
      ? { outcome: "in_progress" }
      : (direct ?? { outcome: "not_started" });
  }

  /**
   * Replace one committed player message on the world's active timeline
   * without changing world identity or destructively rewriting Authority.
   * The new immutable commit restores the selected player's logical parent
   * snapshot and appends the replacement player text in one acceptance step.
   */
  async reviseTimeline(input: {
    operationId: string;
    worldId: string;
    expectedCurrentHead: string;
    restoresHead: string;
    replacesHead: string;
    replacementText: string;
    requestFingerprint: string;
  }): Promise<
    Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >
  > {
    assertIdentity(input.operationId, "Timeline-revision operation ID");
    assertIdentity(input.worldId, "World ID");
    if (
      !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(input.expectedCurrentHead) ||
      !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(input.restoresHead) ||
      !/^commit:[1-9][0-9]*$/u.test(input.replacesHead)
    )
      throw new TypeError("Timeline-revision endpoint is invalid");
    if (input.replacementText.trim() === "")
      throw new TypeError("Edited player message cannot be empty");
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.requestFingerprint))
      throw new TypeError("Timeline-revision request fingerprint is invalid");

    const existing = await this.getOperationOutcome(input.operationId);
    if (isCommittedOutcome(existing)) {
      const authority = await readAcceptedAuthority(
        join(this.#worldsRoot, existing.worldId),
      );
      const commit = authority?.commits.find(
        ({ operationId }) => operationId === input.operationId,
      );
      if (
        existing.worldId !== input.worldId ||
        commit?.mode !== "timeline_revision" ||
        commit.timelineRevision?.restoresHead !== input.restoresHead ||
        commit.timelineRevision.replacesHead !== input.replacesHead ||
        commit.timelineRevision.requestFingerprint !==
          input.requestFingerprint ||
        !isDeepStrictEqual(
          commit.historyAppend.map(({ role, exactText }) => ({
            role,
            exactText,
          })),
          [{ role: "player", exactText: input.replacementText }],
        )
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same timeline-revision operation ID is bound to a different request",
        );
      return existing;
    }

    const root = join(this.#worldsRoot, input.worldId);
    const [authority, replacement] = await Promise.all([
      readAcceptedAuthority(root),
      this.recoverEndpoint(input.worldId, input.restoresHead),
    ]);
    const replaced = authority?.commits.find(
      ({ head }) => head === input.replacesHead,
    );
    const logicalParent =
      replaced?.mode === "timeline_revision"
        ? replaced.timelineRevision?.restoresHead
        : replaced?.parentHead;
    if (
      replaced === undefined ||
      !replaced.historyAppend.some(({ role }) => role === "player") ||
      logicalParent !== input.restoresHead
    )
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "Selected player message does not match the logical parent endpoint to restore",
      );

    return this.#commitHistoryChange({
      operationId: input.operationId,
      worldId: input.worldId,
      parentHead: input.expectedCurrentHead,
      historyAppend: [{ role: "player", exactText: input.replacementText }],
      nextMaterials: structuredClone(replacement.additionalMaterials),
      stateChanges: [],
      mode: "timeline_revision",
      timelineRevision: {
        restoresHead: input.restoresHead,
        replacesHead: input.replacesHead,
        requestFingerprint: input.requestFingerprint,
        replacementState: immutableFiles(replacement.state),
        replacementHistory: structuredClone(replacement.history),
      },
    });
  }

  async commitCorrection(input: {
    operationId: string;
    worldId: string;
    parentHead: string;
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    stateOperationClaim?: ContinuityCorrectionWorldClaimHandle;
  }): Promise<
    Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >
  > {
    try {
      const commit = async () => {
        let operationReserved = input.stateOperationClaim !== undefined;
        if (!operationReserved) {
          const existing = await this.getOperationOutcome(input.operationId);
          if (existing.outcome === "not_started")
            operationReserved = await this.reserveOperation(input.operationId);
        }
        return this.#commitHistoryChange({
          operationId: input.operationId,
          worldId: input.worldId,
          parentHead: input.parentHead,
          nextMaterials: input.nextMaterials,
          stateChanges: input.stateChanges,
          mode: "correction",
          historyAppend: [],
          operationReserved,
        });
      };
      return input.stateOperationClaim === undefined
        ? await this.operations.withExclusiveWorldStateMutation(
            input.worldId,
            commit,
          )
        : await this.operations.withCorrectionWorldClaim(
            input.stateOperationClaim,
            commit,
          );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "This world already has a durable state operation in progress",
        );
      throw error;
    }
  }

  /**
   * Persist one already-visible step of the model-directed play call chain.
   * Player text, assistant text and world changes deliberately arrive in
   * separate commits; there is no synthetic call-chain-wide settlement boundary.
   */
  async commitPlayStep(input: {
    operationId: string;
    worldId: string;
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
  }): Promise<
    Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >
  > {
    if (input.historyAppend.length === 0 && input.stateChanges.length === 0)
      throw new TypeError(
        "A call-chain commit cannot omit both narrative and state changes",
      );
    return this.#commitHistoryChange({
      ...input,
      mode: "play",
    });
  }

  async readPlayCallChain<T>(worldId: string): Promise<T | null> {
    assertIdentity(worldId, "World ID");
    return readOptionalJson<T>(
      join(this.#worldsRoot, worldId, "runtime", "play-call-chain.json"),
    );
  }

  async writePlayCallChain(worldId: string, value: unknown): Promise<void> {
    assertIdentity(worldId, "World ID");
    await publishJson(
      join(this.#worldsRoot, worldId, "runtime", "play-call-chain.json"),
      value,
    );
  }

  async removePlayCallChain(worldId: string): Promise<void> {
    assertIdentity(worldId, "World ID");
    await rm(
      join(this.#worldsRoot, worldId, "runtime", "play-call-chain.json"),
      { force: true },
    );
  }

  async #commitHistoryChange(input: {
    operationId: string;
    worldId: string;
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    mode: "play" | "correction" | "timeline_revision";
    timelineRevision?: FileNativeTimelineRevision;
    operationReserved?: boolean;
  }): Promise<
    Extract<
      FileNativeOperationOutcome,
      { outcome: "committed" | "committed_materialization_pending" }
    >
  > {
    const existing = await this.getOperationOutcome(input.operationId);
    if (isCommittedOutcome(existing)) {
      assertSameOperationOutcome(existing, input);
      const commit = await readPlayCommitByDigest(
        join(this.#worldsRoot, existing.worldId),
        existing.commitDigest,
      );
      if (
        commit?.mode !== input.mode ||
        JSON.stringify(commit?.stateChanges) !==
          JSON.stringify(input.stateChanges) ||
        !isDeepStrictEqual(commit?.timelineRevision, input.timelineRevision)
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same play operation ID is bound to a different complete commit payload",
        );
      return existing;
    }
    const prepared =
      existing.outcome === "in_progress"
        ? await readAcceptancePreparedOutcome(
            this.#operationOutcomePath(input.operationId),
          )
        : null;
    if (prepared !== null)
      await assertPreparedOperationMatches(
        this.#worldsRoot,
        input.operationId,
        prepared,
        input,
      );
    if (
      existing.outcome !== "not_started" &&
      !(
        existing.outcome === "in_progress" &&
        (input.operationReserved === true || prepared !== null)
      )
    )
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "The same play operation ID is occupied by another durable operation",
      );
    const root = join(this.#worldsRoot, input.worldId);
    try {
      return await this.operations.withWorldAuthorityLock(
        input.worldId,
        async () => {
          const concurrent = await this.#readOperationOutcome(
            input.operationId,
          );
          if (isCommittedOutcome(concurrent)) {
            assertSameOperationOutcome(concurrent, input);
            const knownCommit = await readPlayCommitByDigest(
              join(this.#worldsRoot, concurrent.worldId),
              concurrent.commitDigest,
            );
            if (
              knownCommit?.mode !== input.mode ||
              !isDeepStrictEqual(
                knownCommit.stateChanges,
                input.stateChanges,
              ) ||
              !isDeepStrictEqual(
                knownCommit.timelineRevision,
                input.timelineRevision,
              )
            )
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                "The same play operation ID is bound to a different complete commit payload",
              );
            return concurrent;
          }
          const concurrentPrepared =
            concurrent.outcome === "in_progress"
              ? await readAcceptancePreparedOutcome(
                  this.#operationOutcomePath(input.operationId),
                )
              : null;
          if (concurrentPrepared !== null)
            await assertPreparedOperationMatches(
              this.#worldsRoot,
              input.operationId,
              concurrentPrepared,
              input,
            );
          else if (
            concurrent.outcome === "in_progress" &&
            input.operationReserved !== true
          )
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The same play operation ID is occupied by another durable operation",
            );
          const authorityPath = join(root, "runtime", playAuthorityHeadFile);
          const authority = await readAuthorityHead(root);
          if (authority.head !== input.parentHead) {
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The parent endpoint of the play operation has changed",
            );
          }
          const materialized = await readOptionalJson<{ head: string }>(
            join(root, "runtime", "materialized-head.json"),
          );
          if ((materialized?.head ?? "genesis") !== authority.head)
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The world has accepted but unrepaired materialization; new competing writes are forbidden",
            );
          const [currentState, currentControl] = await Promise.all([
            readTree(join(root, "state")),
            readTree(join(root, "control")),
          ]);
          const candidateState = new Map(
            currentState.map((file) => [file.path, file.contents]),
          );
          if (input.mode === "timeline_revision") {
            if (
              input.timelineRevision === undefined ||
              input.stateChanges.length !== 0
            )
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                "Timeline-revision commit payload is invalid",
              );
            candidateState.clear();
            for (const file of input.timelineRevision.replacementState) {
              assertRelativePath(file.path);
              if (sha256(file.canonicalBytes) !== file.sha256)
                throw new FileNativeWorldCreationError(
                  "operation_conflict",
                  `Timeline-revision state hash conflicts: ${file.path}`,
                );
              candidateState.set(file.path, file.canonicalBytes);
            }
          } else {
            if (input.timelineRevision !== undefined)
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                "A regular commit cannot carry a timeline-revision payload",
              );
            for (const change of input.stateChanges) {
              assertRelativePath(change.relativePath);
              const previous = candidateState.get(change.relativePath);
              const previousHash =
                previous === undefined ? null : sha256(previous);
              if (
                previousHash !== change.expectedPreviousHash ||
                sha256(change.canonicalNextBytes) !== change.nextHash
              )
                throw new FileNativeWorldCreationError(
                  "operation_conflict",
                  `State-change hash conflicts: ${change.relativePath}`,
                );
              candidateState.set(
                change.relativePath,
                change.canonicalNextBytes,
              );
            }
          }
          const inspection = inspectContentPackageCurrentTree(
            [
              ...[...candidateState].map(([path, contents]) => ({
                path: `world/${path}`,
                contents,
              })),
              ...currentControl.map(({ path, contents }) => ({
                path: `control/${path}`,
                contents,
              })),
            ],
            { requireOpening: false },
          );
          if (inspection.status !== "usable")
            throw new FileNativeWorldCreationError(
              "candidate_validation_failed",
              `Candidate world failed mechanical validation: ${inspection.issues.map(({ message }) => message).join("; ")}`,
            );
          const sequence = authority.sequence + 1;
          const head = `commit:${sequence}`;
          const commit = {
            schemaVersion: 2,
            sequence,
            operationId: input.operationId,
            parentHead: input.parentHead,
            parentCommitDigest: authority.commitDigest,
            head,
            mode: input.mode,
            historyAppend: input.historyAppend.map((message, index) => ({
              messageId: `${input.worldId}.message.${sequence}.${index + 1}.${message.role}`,
              ...structuredClone(message),
            })),
            stateChanges: structuredClone(input.stateChanges),
            nextAdditionalMaterials: input.nextMaterials,
            ...(input.mode === "correction"
              ? {
                  correctionTargets: input.stateChanges.map(
                    ({ documentId }) => documentId,
                  ),
                  corrects: input.parentHead,
                }
              : {}),
            ...(input.mode === "timeline_revision"
              ? {
                  timelineRevision: structuredClone(input.timelineRevision!),
                }
              : {}),
          } satisfies FileNativePlayCommit;
          const digest = playCommitDigest(commit);
          crashAtFileNativeAuthorityEdge("before_commit_acceptance");
          await publishImmutableJson(
            join(root, "runtime", "play-commits", `${digest}.json`),
            commit,
          );
          const pending = {
            outcome: "committed_materialization_pending" as const,
            worldId: input.worldId,
            parentHead: input.parentHead,
            head,
            commitDigest: digest,
            historyAppend: structuredClone(input.historyAppend),
            nextAdditionalMaterials: structuredClone(input.nextMaterials),
            mode: input.mode,
          };
          await publishJson(this.#operationOutcomePath(input.operationId), {
            ...pending,
            outcome: "acceptance_prepared",
          });
          crashAtFileNativeAuthorityEdge("after_acceptance_prepared");
          await publishJson(authorityPath, {
            schemaVersion: 2,
            head,
            sequence,
            commitDigest: digest,
            operationId: input.operationId,
          } satisfies FileNativePlayAuthorityHead);
          crashAtFileNativeAuthorityEdge("after_commit_acceptance");
          await publishJson(
            this.#operationOutcomePath(input.operationId),
            pending,
          );
          try {
            await materializePlayCommit(root, sequence, {
              mode: commit.mode,
              historyAppend: commit.historyAppend,
              nextMaterials: input.nextMaterials,
              stateChanges: input.stateChanges,
              ...(commit.timelineRevision === undefined
                ? {}
                : { timelineRevision: commit.timelineRevision }),
            });
            crashAtFileNativeAuthorityEdge("after_materialization");
            await publishJson(join(root, "runtime", "materialized-head.json"), {
              schemaVersion: 2,
              head,
              sequence,
              commitDigest: digest,
            } satisfies FileNativeMaterializedCheckpoint);
            const outcome = { ...pending, outcome: "committed" as const };
            await publishJson(
              this.#operationOutcomePath(input.operationId),
              outcome,
            );
            return outcome;
          } catch (error: unknown) {
            if (
              error instanceof FileNativeWorldCreationError &&
              (error.code === "world_corrupt" ||
                error.code === "inconsistent_materialization")
            )
              throw error;
            return pending;
          }
        },
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World Authority commit is being serialized by another process",
        );
      throw error;
    }
  }

  async readAuthorityHistory(
    worldId: string,
  ): Promise<{ head: string; commits: FileNativePlayCommit[] }> {
    assertIdentity(worldId, "World ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const authority = await readAcceptedAuthority(root);
    return authority === null
      ? { head: "genesis", commits: [] }
      : { head: authority.head, commits: structuredClone(authority.commits) };
  }

  async readAuthorityEndpoint(
    worldId: string,
    endpoint: string,
  ): Promise<{
    endpoint: string;
    state: ContentTreeFile[];
    history: { role: "player" | "narrator"; exactText: string }[];
    additionalMaterials: MaterialSelection[];
  }> {
    const recovered = await this.recoverEndpoint(worldId, endpoint);
    return {
      endpoint: recovered.head,
      state: recovered.state,
      history: recovered.history.map(({ role, exactText }) => ({
        role,
        exactText,
      })),
      additionalMaterials: recovered.additionalMaterials,
    };
  }

  async traceCorrections(
    worldId: string,
    endpoint: string,
  ): Promise<{
    endpoint: string;
    corrects: string | null;
    correctedBy: string[];
  }> {
    const { commits } = await this.readAuthorityHistory(worldId);
    const commit = commits.find(({ head }) => head === endpoint);
    if (endpoint !== "genesis" && commit === undefined)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Historical endpoint does not exist: ${endpoint}`,
      );
    return {
      endpoint,
      corrects:
        commit?.mode === "correction" ? (commit.corrects ?? null) : null,
      correctedBy: commits
        .filter(
          (candidate) =>
            candidate.mode === "correction" && candidate.corrects === endpoint,
        )
        .map(({ head }) => head),
    };
  }

  async #readPublication(operationId: string): Promise<Publication | null> {
    let publication: Publication;
    try {
      publication = await readJson<Publication>(
        this.#operationPath(operationId),
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const worldId = `world-${operationDigest(operationId).slice(0, 24)}`;
        try {
          publication = await readPublicationAt(
            join(this.#worldsRoot, worldId),
          );
        } catch (worldError: unknown) {
          if (isNodeError(worldError) && worldError.code === "ENOENT")
            return null;
          throw worldError;
        }
        if (publication.operationId !== operationId) {
          throw new FileNativeWorldCreationError(
            "operation_conflict",
            "Deterministic world identity is occupied by another creation operation",
          );
        }
        await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
        await publishOperation(this.#operationPath(operationId), publication);
      } else {
        throw error;
      }
    }
    const worldPublication = await readPublicationAt(
      join(this.#worldsRoot, publication.worldId),
    );
    if (JSON.stringify(worldPublication) !== JSON.stringify(publication)) {
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Creation operation does not match the world publication record",
      );
    }
    return publication;
  }

  #currentSummary(publication: Publication): Promise<FileNativeWorldSummary> {
    return readWorldSummaryAt(
      join(this.#worldsRoot, publication.worldId),
      publication,
    );
  }

  #operationPath(operationId: string): string {
    return join(this.#operationsRoot, `${operationDigest(operationId)}.json`);
  }

  #operationOutcomePath(operationId: string): string {
    return join(
      this.#operationsRoot,
      `outcome-${operationDigest(operationId)}.json`,
    );
  }

  #derivationOperationPath(operationId: string): string {
    return join(
      this.#operationsRoot,
      `derive-${operationDigest(operationId)}.json`,
    );
  }

  #preview(
    input: FileNativeWorldCreationInput,
    worldId: string,
  ): PromptPreview {
    const openingMessage = genesisOpeningMessage(
      worldId,
      openingText(input.packageFiles),
    );
    return this.#promptCompiler.preview({
      endpoint: { id: `${worldId}:genesis`, commit: "genesis" },
      hostBinding: input.prompt.hostBinding,
      world: {
        controlFingerprint: fingerprint(
          input.packageFiles.filter(({ path }) => path.startsWith("control/")),
        ),
        documentSnapshot: WorldDocumentStore.open({
          layout: "content_package",
          files: input.packageFiles,
        }),
        history: { [openingMessage.messageId]: openingMessage.exactText },
        additionalMaterials: [
          { kind: "history_message", message: openingMessage.messageId },
        ],
      },
      playerInputPlacement: "bootstrap",
      playerInput:
        input.prompt.playerInput ??
        "(Preview placeholder: the player's first real action after creating the world)",
      modelBinding: input.prompt.modelBinding,
    });
  }
}

function toWorldStatePath(path: string): string {
  return path.startsWith("world/")
    ? `state/${path.slice("world/".length)}`
    : path;
}

function openingText(files: readonly ContentTreeFile[]): string {
  const opening = files.find(
    ({ path, encoding }) => path === "opening.md" && encoding === undefined,
  );
  if (opening === undefined)
    throw new FileNativeWorldCreationError(
      "content_package_needs_repair",
      "Content package is missing a usable opening.md",
    );
  return opening.contents;
}

function genesisOpeningMessage(worldId: string, exactText: string) {
  return {
    messageId: `${worldId}.message.genesis.narrator`,
    role: "narrator" as const,
    exactText,
  };
}

function selectSurface(
  files: readonly ContentTreeFile[],
  prefix: "state/" | "control/",
): ContentTreeFile[] {
  return files
    .filter(({ path }) => path.startsWith(prefix))
    .map(({ path, contents, encoding }) => ({
      path: path.slice(prefix.length),
      contents,
      ...(encoding === undefined ? {} : { encoding }),
    }));
}

function assertEquivalentWorldDocumentSnapshots(
  contentDocuments: readonly FileNativeContentDocument[],
  worldState: WorldDocumentStore,
): void {
  if (worldState.status !== "usable") {
    throw new FileNativeWorldCreationError(
      "content_package_needs_repair",
      `Copied state world-document snapshot failed validation: ${worldState.diagnostics
        .map(({ message }) => message)
        .join("；")}`,
    );
  }
  const stateFiles = worldState.files.filter(({ path }) =>
    path.startsWith("state/"),
  );
  const mismatch =
    stateFiles.length !== contentDocuments.length ||
    contentDocuments.some((document) => {
      if (!document.path.startsWith("world/")) return true;
      const result = worldState.query({
        kind: "read_document",
        document: {
          logicalPath: `state/${document.path.slice("world/".length)}`,
        },
        maxBytes: 4,
      });
      return (
        !result.ok ||
        result.kind !== "read_document" ||
        result.document.documentId !== document.id ||
        result.document.shortRef !== document.ref ||
        result.document.codec !== document.codec
      );
    });
  if (mismatch) {
    throw new FileNativeWorldCreationError(
      "content_package_needs_repair",
      "Copied state world-document identity, short reference, or codec does not match the content-package snapshot",
    );
  }
}

async function writeSurface(
  root: string,
  surface: "state" | "control",
  files: readonly ContentTreeFile[],
): Promise<void> {
  for (const file of files) {
    assertRelativePath(file.path);
    const path = join(root, surface, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      file.encoding === "base64"
        ? Buffer.from(file.contents, "base64")
        : file.contents,
    );
  }
}

async function readTree(root: string, prefix = ""): Promise<ContentTreeFile[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files: ContentTreeFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await readTree(root, path)));
    else if (entry.isFile())
      files.push({ path, contents: await readFile(join(root, path), "utf8") });
  }
  return files;
}

function immutableFiles(files: readonly ContentTreeFile[]) {
  return files.map(({ path, contents }) => ({
    path,
    sha256: sha256(contents),
    canonicalBytes: contents,
  }));
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function fingerprint(files: readonly ContentTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(file.contents).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function operationDigest(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

async function publishOperation(
  path: string,
  value: Publication,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function assertOperationOutcomeIntegrity(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.outcome !== "string")
    throw corruptOperationOutcome();
  if (value.outcome === "in_progress") {
    if (!hasExactKeys(value, ["outcome"])) throw corruptOperationOutcome();
    return;
  }
  if (value.outcome === "failed" || value.outcome === "cancelled") {
    if (!hasExactKeys(value, ["outcome"])) throw corruptOperationOutcome();
    return;
  }
  if (
    value.outcome === "acceptance_prepared" ||
    value.outcome === "committed" ||
    value.outcome === "committed_materialization_pending"
  ) {
    if (
      !hasExactKeys(value, [
        "outcome",
        "worldId",
        "parentHead",
        "head",
        "commitDigest",
        "historyAppend",
        "nextAdditionalMaterials",
        "mode",
      ]) ||
      typeof value.worldId !== "string" ||
      value.worldId.length === 0 ||
      typeof value.parentHead !== "string" ||
      !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.parentHead) ||
      typeof value.head !== "string" ||
      !/^commit:[1-9][0-9]*$/u.test(value.head) ||
      typeof value.commitDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.commitDigest) ||
      !Array.isArray(value.historyAppend) ||
      !value.historyAppend.every(isPlayHistoryAppendInput) ||
      !Array.isArray(value.nextAdditionalMaterials) ||
      !value.nextAdditionalMaterials.every(isAuthorityMaterialSelection) ||
      !(
        value.mode === "play" ||
        value.mode === "correction" ||
        value.mode === "timeline_revision"
      )
    )
      throw corruptOperationOutcome();
    return;
  }
  throw corruptOperationOutcome();
}

function projectOperationOutcome(
  value: Record<string, unknown>,
): FileNativeOperationOutcome {
  return structuredClone(value) as FileNativeOperationOutcome;
}

async function readAcceptancePreparedOutcome(
  path: string,
): Promise<FileNativeAcceptancePreparedOutcome | null> {
  const value = await readOptionalJson<unknown>(path);
  if (value === null) return null;
  assertOperationOutcomeIntegrity(value);
  if (value.outcome !== "acceptance_prepared") return null;
  return structuredClone(
    value,
  ) as unknown as FileNativeAcceptancePreparedOutcome;
}

async function assertPreparedOperationMatches(
  worldsRoot: string,
  operationId: string,
  prepared: FileNativeAcceptancePreparedOutcome,
  input: {
    worldId: string;
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    mode: "play" | "correction" | "timeline_revision";
    timelineRevision?: FileNativeTimelineRevision;
  },
): Promise<void> {
  const comparable = {
    ...structuredClone(prepared),
    outcome: "committed_materialization_pending" as const,
  };
  assertSameOperationOutcome(comparable, input);
  const commit = await readPlayCommitByDigest(
    join(worldsRoot, prepared.worldId),
    prepared.commitDigest,
  );
  if (
    commit.operationId !== operationId ||
    commit.mode !== input.mode ||
    !isDeepStrictEqual(commit.stateChanges, input.stateChanges) ||
    !isDeepStrictEqual(commit.timelineRevision, input.timelineRevision)
  )
    throw new FileNativeWorldCreationError(
      "operation_conflict",
      "The same play operation ID is bound to a different prepared commit payload",
    );
}

async function resolvePreparedOperationOutcome(
  worldsRoot: string,
  operationId: string,
  value: Record<string, unknown>,
): Promise<FileNativeOperationOutcome> {
  const prepared = value as unknown as Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >;
  const worldRoot = join(worldsRoot, prepared.worldId);
  const authority = await readAuthorityHead(worldRoot);
  if (authority.head === prepared.parentHead) return { outcome: "in_progress" };
  const commit = await assertCommittedAuthorityOutcomeMatches(
    worldRoot,
    operationId,
    prepared,
  );
  if (authority.sequence < commit.sequence) throw corruptOperationOutcome();
  await readAuthorityTail(worldRoot, authority, {
    schemaVersion: 2,
    head: commit.head,
    sequence: commit.sequence,
    commitDigest: prepared.commitDigest,
  }).catch(() => {
    throw corruptOperationOutcome();
  });
  const materialized = await readMaterializedCheckpoint(worldRoot);
  const outcome: "committed" | "committed_materialization_pending" =
    materialized !== null && materialized.sequence >= commit.sequence
      ? "committed"
      : "committed_materialization_pending";
  const resolved = { ...structuredClone(prepared), outcome };
  if (outcome === "committed_materialization_pending")
    await assertPendingMaterializationCompatible(
      worldRoot,
      operationId,
      prepared.commitDigest,
    );
  return resolved;
}

function corruptOperationOutcome(): FileNativeWorldCreationError {
  return new FileNativeWorldCreationError(
    "world_corrupt",
    "Authority operation outcome structure or operation identity is invalid",
  );
}

async function assertCommittedAuthorityOutcomeMatches(
  worldRoot: string,
  operationId: string,
  outcome: Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
): Promise<FileNativePlayCommit> {
  const commit = await readPlayCommitByDigest(worldRoot, outcome.commitDigest);
  if (
    commit.operationId !== operationId ||
    commit?.parentHead !== outcome.parentHead ||
    commit?.head !== outcome.head ||
    commit?.mode !== outcome.mode ||
    !isDeepStrictEqual(
      commit?.historyAppend.map(({ role, exactText }) => ({ role, exactText })),
      outcome.historyAppend,
    ) ||
    !isDeepStrictEqual(
      commit?.nextAdditionalMaterials,
      outcome.nextAdditionalMaterials,
    )
  )
    throw corruptOperationOutcome();
  return commit;
}

async function assertPendingMaterializationCompatible(
  worldRoot: string,
  operationId: string,
  commitDigest?: string,
): Promise<void> {
  const commit =
    commitDigest === undefined
      ? (await readAcceptedAuthority(worldRoot))?.commits.find(
          (candidate) => candidate.operationId === operationId,
        )
      : await readPlayCommitByDigest(worldRoot, commitDigest);
  if (commit?.operationId !== operationId) throw corruptOperationOutcome();
  const sequence = commit.sequence - 1;
  for (const change of commit.stateChanges) {
    const path = join(worldRoot, "state", change.relativePath);
    const existing = await readOptionalText(path);
    const existingHash =
      existing === null
        ? null
        : `sha256:${createHash("sha256").update(existing).digest("hex")}`;
    if (
      existingHash !== change.expectedPreviousHash &&
      existingHash !== change.nextHash
    )
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        `World-state materialization conflict: ${change.relativePath}`,
      );
  }
  for (const [index, message] of commit.historyAppend.entries()) {
    const existing = await readOptionalText(
      join(
        worldRoot,
        "history",
        `${String(sequence + 1).padStart(8, "0")}-${historyFileName(index + 1, message)}`,
      ),
    );
    if (existing !== null && existing !== message.exactText)
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        "History-message materialization content conflict",
      );
  }
  const existingMaterials = await readOptionalJson<{
    head: string;
    items: MaterialSelection[];
  }>(join(worldRoot, "runtime", "additional-materials.json"));
  if (
    existingMaterials?.head === commit.head &&
    !isDeepStrictEqual(existingMaterials.items, commit.nextAdditionalMaterials)
  )
    throw new FileNativeWorldCreationError(
      "inconsistent_materialization",
      "Additional-material list content conflicts at the same endpoint",
    );
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isAuthorityMaterialSelection(value: unknown): boolean {
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
      isAuthorityMaterialLocator(value.locator)
    );
  if (value.kind === "history_message")
    return (
      hasExactKeys(value, ["kind", "message"]) &&
      typeof value.message === "string"
    );
  return (
    value.kind === "history_commit" &&
    hasExactKeys(value, ["kind", "commit"]) &&
    typeof value.commit === "string"
  );
}

function isAuthorityMaterialLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasRequiredAndOptionalKeys(value, [], ["yaml", "markdown"]) &&
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

async function publishJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function publishImmutableJson(
  path: string,
  value: unknown,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
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
      return true;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== contents)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "Immutable play-commit file conflicts",
        );
      return false;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readAcceptedAuthority(
  root: string,
): Promise<FileNativePlayAuthority | null> {
  try {
    const published = await readAuthorityHead(root);
    if (published.sequence === 0) return null;
    const reverse: FileNativePlayCommit[] = [];
    let digest = published.commitDigest;
    let expectedHead = published.head;
    let expectedSequence = published.sequence;
    while (digest !== null) {
      const immutable = await readJson<unknown>(
        join(root, "runtime", "play-commits", `${digest}.json`),
      ).catch((error: unknown) => {
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `Accepted endpoint is missing an immutable commit: ${expectedHead}`,
          { cause: error },
        );
      });
      assertFileNativePlayCommit(immutable);
      if (
        playCommitDigest(immutable) !== digest ||
        immutable.head !== expectedHead ||
        immutable.sequence !== expectedSequence
      )
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `Accepted endpoint does not match its immutable commit: ${expectedHead}`,
        );
      reverse.push(immutable);
      digest = immutable.parentCommitDigest;
      expectedHead = immutable.parentHead;
      expectedSequence -= 1;
    }
    if (expectedSequence !== 0 || expectedHead !== "genesis")
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Accepted Authority chain does not terminate at genesis",
      );
    const authority: FileNativePlayAuthority = {
      schemaVersion: 2,
      head: published.head,
      commits: reverse.reverse(),
    };
    assertFileNativePlayAuthority(authority);
    return authority;
  } catch (error: unknown) {
    if (error instanceof FileNativeWorldCreationError) throw error;
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Play Authority durable data is corrupt",
      { cause: error },
    );
  }
}

async function readMaterializedCheckpoint(
  root: string,
): Promise<FileNativeMaterializedCheckpoint | null> {
  const value = await readOptionalJson<unknown>(
    join(root, "runtime", "materialized-head.json"),
  );
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "head",
      "sequence",
      "commitDigest",
    ]) ||
    value.schemaVersion !== 2 ||
    typeof value.head !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.commitDigest !== null &&
      (typeof value.commitDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.commitDigest))) ||
    (Number(value.sequence) === 0
      ? value.head !== "genesis" || value.commitDigest !== null
      : value.head !== `commit:${String(value.sequence)}` ||
        value.commitDigest === null)
  )
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Materialized world checkpoint has an invalid shape",
    );
  return value as unknown as FileNativeMaterializedCheckpoint;
}

function sameMaterializedEndpoint(
  checkpoint: FileNativeMaterializedCheckpoint | null,
  authority: FileNativePlayAuthorityHead,
): boolean {
  return (
    checkpoint !== null &&
    checkpoint.head === authority.head &&
    checkpoint.sequence === authority.sequence &&
    checkpoint.commitDigest === authority.commitDigest
  );
}

async function readAuthorityTail(
  root: string,
  authority: FileNativePlayAuthorityHead,
  checkpoint: FileNativeMaterializedCheckpoint | null,
): Promise<FileNativePlayCommit[]> {
  const targetDigest = checkpoint?.commitDigest ?? null;
  const targetHead = checkpoint?.head ?? "genesis";
  const targetSequence = checkpoint?.sequence ?? 0;
  if (targetSequence > authority.sequence)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Materialized checkpoint is ahead of Authority",
    );
  const reverse: FileNativePlayCommit[] = [];
  let digest = authority.commitDigest;
  let expectedHead = authority.head;
  let expectedSequence = authority.sequence;
  while (digest !== targetDigest) {
    if (digest === null)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Materialized checkpoint is not an ancestor of Authority",
      );
    const commit = await readPlayCommitByDigest(root, digest);
    if (commit.head !== expectedHead || commit.sequence !== expectedSequence)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Authority tail does not match its immutable commit chain",
      );
    reverse.push(commit);
    digest = commit.parentCommitDigest;
    expectedHead = commit.parentHead;
    expectedSequence -= 1;
  }
  if (expectedHead !== targetHead || expectedSequence !== targetSequence)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Materialized checkpoint identity does not match Authority ancestry",
    );
  return reverse.reverse();
}

function genesisAuthorityHead(): FileNativePlayAuthorityHead {
  return {
    schemaVersion: 2,
    head: "genesis",
    sequence: 0,
    commitDigest: null,
    operationId: null,
  };
}

async function readAuthorityHead(
  root: string,
): Promise<FileNativePlayAuthorityHead> {
  const value = await readJson<unknown>(
    join(root, "runtime", playAuthorityHeadFile),
  );
  assertFileNativePlayAuthorityHead(value);
  return value;
}

function assertFileNativePlayAuthorityHead(
  value: unknown,
): asserts value is FileNativePlayAuthorityHead {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "head",
      "sequence",
      "commitDigest",
      "operationId",
    ]) ||
    value.schemaVersion !== 2 ||
    typeof value.head !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.commitDigest !== null &&
      (typeof value.commitDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.commitDigest))) ||
    (value.operationId !== null && typeof value.operationId !== "string") ||
    (Number(value.sequence) === 0
      ? value.head !== "genesis" ||
        value.commitDigest !== null ||
        value.operationId !== null
      : value.head !== `commit:${String(value.sequence)}` ||
        value.commitDigest === null ||
        value.operationId === null)
  )
    throw new Error("Play Authority head has an invalid shape");
}

function playCommitDigest(commit: FileNativePlayCommit): string {
  return createHash("sha256").update(JSON.stringify(commit)).digest("hex");
}

async function readPlayCommitByDigest(
  root: string,
  digest: string,
): Promise<FileNativePlayCommit> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw corruptOperationOutcome();
  const value = await readJson<unknown>(
    join(root, "runtime", "play-commits", `${digest}.json`),
  );
  assertFileNativePlayCommit(value);
  if (playCommitDigest(value) !== digest)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Immutable play commit does not match its durable identity",
    );
  return value;
}

function assertFileNativePlayAuthority(
  value: unknown,
): asserts value is FileNativePlayAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "head", "commits"]) ||
    value.schemaVersion !== 2 ||
    typeof value.head !== "string" ||
    !Array.isArray(value.commits)
  )
    throw new Error("Play Authority has an invalid shape");
  const operationIds = new Set<string>();
  const heads = new Set<string>();
  const commitsByHead = new Map<string, FileNativePlayCommit>();
  let parent = "genesis";
  let parentDigest: string | null = null;
  for (const [index, commit] of value.commits.entries()) {
    assertFileNativePlayCommit(commit);
    const revision = commit.timelineRevision;
    const replaced =
      revision === undefined
        ? undefined
        : commitsByHead.get(revision.replacesHead);
    const replacedLogicalParent =
      replaced?.mode === "timeline_revision"
        ? replaced.timelineRevision!.restoresHead
        : replaced?.parentHead;
    if (
      commit.parentHead !== parent ||
      commit.parentCommitDigest !== parentDigest ||
      commit.sequence !== index + 1 ||
      commit.head !== `commit:${index + 1}` ||
      operationIds.has(commit.operationId) ||
      heads.has(commit.head) ||
      (commit.mode === "timeline_revision" &&
        ((revision!.restoresHead !== "genesis" &&
          !heads.has(revision!.restoresHead)) ||
          replaced === undefined ||
          !replaced.historyAppend.some(({ role }) => role === "player") ||
          replacedLogicalParent !== revision!.restoresHead))
    )
      throw new Error("Play Authority commit chain is invalid");
    operationIds.add(commit.operationId);
    heads.add(commit.head);
    commitsByHead.set(commit.head, commit);
    parent = commit.head;
    parentDigest = playCommitDigest(commit);
  }
  if (value.head !== parent) throw new Error("Play Authority head is invalid");
}

function assertFileNativePlayCommit(
  value: unknown,
): asserts value is FileNativePlayCommit {
  if (!isRecord(value)) throw new Error("Play commit has an invalid shape");
  const correction = value.mode === "correction";
  const timelineRevision = value.mode === "timeline_revision";
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "sequence",
      "operationId",
      "parentHead",
      "parentCommitDigest",
      "head",
      "mode",
      "historyAppend",
      "stateChanges",
      "nextAdditionalMaterials",
      ...(correction ? ["correctionTargets", "corrects"] : []),
      ...(timelineRevision ? ["timelineRevision"] : []),
    ]) ||
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.trim() === "" ||
    typeof value.parentHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.parentHead) ||
    (value.parentCommitDigest !== null &&
      (typeof value.parentCommitDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.parentCommitDigest))) ||
    (value.parentHead === "genesis") !== (value.parentCommitDigest === null) ||
    typeof value.head !== "string" ||
    !/^commit:[1-9][0-9]*$/u.test(value.head) ||
    value.head !== `commit:${String(value.sequence)}` ||
    (value.mode !== "play" &&
      value.mode !== "correction" &&
      value.mode !== "timeline_revision") ||
    !Array.isArray(value.historyAppend) ||
    (correction
      ? value.historyAppend.length !== 0
      : timelineRevision
        ? value.historyAppend.length !== 1 ||
          !isRecord(value.historyAppend[0]) ||
          value.historyAppend[0].role !== "player"
        : value.historyAppend.length === 0 &&
          (!Array.isArray(value.stateChanges) ||
            value.stateChanges.length === 0)) ||
    !value.historyAppend.every(isFileNativeHistoryMessage) ||
    !Array.isArray(value.stateChanges) ||
    !value.stateChanges.every(isFileNativeStateChange) ||
    !Array.isArray(value.nextAdditionalMaterials) ||
    !value.nextAdditionalMaterials.every(isAuthorityMaterialSelection)
  )
    throw new Error("Play commit has an invalid shape");
  if (
    correction &&
    (!Array.isArray(value.correctionTargets) ||
      !value.correctionTargets.every(
        (target) => typeof target === "string" && target.trim() !== "",
      ) ||
      typeof value.corrects !== "string" ||
      value.corrects !== value.parentHead)
  )
    throw new Error("Correction commit has an invalid shape");
  if (
    timelineRevision &&
    (value.stateChanges.length !== 0 ||
      !isFileNativeTimelineRevision(value.timelineRevision))
  )
    throw new Error("Timeline-revision commit has an invalid shape");
}

function isFileNativeTimelineRevision(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "restoresHead",
      "replacesHead",
      "requestFingerprint",
      "replacementState",
      "replacementHistory",
    ]) ||
    typeof value.restoresHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.restoresHead) ||
    typeof value.replacesHead !== "string" ||
    !/^commit:[1-9][0-9]*$/u.test(value.replacesHead) ||
    typeof value.requestFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.requestFingerprint) ||
    !Array.isArray(value.replacementState) ||
    !Array.isArray(value.replacementHistory) ||
    !value.replacementHistory.every(isFileNativeHistoryMessage)
  )
    return false;
  for (const file of value.replacementState) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["path", "sha256", "canonicalBytes"]) ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      typeof file.canonicalBytes !== "string" ||
      sha256(file.canonicalBytes) !== file.sha256
    )
      return false;
    try {
      assertRelativePath(file.path);
    } catch {
      return false;
    }
  }
  return true;
}

function isFileNativeHistoryMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["messageId", "role", "exactText"]) &&
    typeof value.messageId === "string" &&
    value.messageId.trim() !== "" &&
    (value.role === "player" || value.role === "narrator") &&
    typeof value.exactText === "string"
  );
}

function isPlayHistoryAppendInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "exactText"]) &&
    (value.role === "player" || value.role === "narrator") &&
    typeof value.exactText === "string"
  );
}

function isFileNativeStateChange(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "documentId",
      "stableShortRef",
      "relativePath",
      "codec",
      "expectedPreviousHash",
      "nextHash",
      "canonicalNextBytes",
    ]) ||
    (value.kind !== "create" && value.kind !== "replace") ||
    typeof value.documentId !== "string" ||
    value.documentId.trim() === "" ||
    typeof value.stableShortRef !== "string" ||
    value.stableShortRef.trim() === "" ||
    typeof value.relativePath !== "string" ||
    (value.codec !== "yaml" && value.codec !== "markdown") ||
    (value.expectedPreviousHash !== null &&
      (typeof value.expectedPreviousHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.expectedPreviousHash))) ||
    typeof value.nextHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.nextHash) ||
    typeof value.canonicalNextBytes !== "string" ||
    `sha256:${createHash("sha256")
      .update(value.canonicalNextBytes)
      .digest("hex")}` !== value.nextHash
  )
    return false;
  try {
    assertRelativePath(value.relativePath);
  } catch {
    return false;
  }
  return true;
}

async function materializePlayCommit(
  root: string,
  sequence: number,
  input: {
    mode: FileNativePlayCommit["mode"];
    historyAppend: FileNativePlayCommit["historyAppend"];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    timelineRevision?: FileNativeTimelineRevision;
  },
): Promise<void> {
  if (input.mode === "timeline_revision") {
    if (input.timelineRevision === undefined)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Timeline-revision commit is missing its materialization snapshot",
      );
    await replaceMaterializedTree(
      join(root, "state"),
      input.timelineRevision.replacementState.map(
        ({ path, canonicalBytes }) => ({ path, contents: canonicalBytes }),
      ),
    );
  } else {
    for (const change of input.stateChanges) {
      assertRelativePath(change.relativePath);
      const path = join(root, "state", change.relativePath);
      let existing: string | null = null;
      try {
        existing = await readFile(path, "utf8");
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      const existingHash = existing === null ? null : sha256(existing);
      if (existingHash === change.nextHash) continue;
      if (existingHash !== change.expectedPreviousHash)
        throw new FileNativeWorldCreationError(
          "inconsistent_materialization",
          `World-state materialization conflict: ${change.relativePath}`,
        );
      await publishText(path, change.canonicalNextBytes);
    }
  }
  crashAtFileNativeAuthorityEdge("after_state_materialization");
  const historyRoot = join(root, "history");
  await mkdir(historyRoot, { recursive: true });
  if (input.mode === "timeline_revision") {
    await replaceMaterializedTree(
      historyRoot,
      historySurfaceFiles([
        ...input.timelineRevision!.replacementHistory,
        ...input.historyAppend,
      ]),
    );
  } else {
    for (const [index, message] of input.historyAppend.entries())
      await writeIdempotentText(
        join(
          historyRoot,
          `${String(sequence).padStart(8, "0")}-${historyFileName(index + 1, message)}`,
        ),
        message.exactText,
      );
  }
  const materialsPath = join(root, "runtime", "additional-materials.json");
  const nextMaterials = {
    head: `commit:${sequence}`,
    items: input.nextMaterials,
  };
  const existingMaterials =
    await readOptionalJson<typeof nextMaterials>(materialsPath);
  if (
    existingMaterials?.head === nextMaterials.head &&
    JSON.stringify(existingMaterials.items) !==
      JSON.stringify(nextMaterials.items)
  )
    throw new FileNativeWorldCreationError(
      "inconsistent_materialization",
      "Additional-material list content conflicts at the same endpoint",
    );
  if (JSON.stringify(existingMaterials) !== JSON.stringify(nextMaterials))
    await publishJson(materialsPath, nextMaterials);
}

async function replaceMaterializedTree(
  root: string,
  files: readonly ContentTreeFile[],
): Promise<void> {
  const next = new Map<string, string>();
  for (const file of files) {
    assertRelativePath(file.path);
    if (next.has(file.path))
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Timeline-revision materialization contains a duplicate path: ${file.path}`,
      );
    next.set(file.path, file.contents);
  }
  const current = await readTree(root);
  for (const [path, contents] of next) {
    const existing = current.find((file) => file.path === path)?.contents;
    if (existing !== contents) await publishText(join(root, path), contents);
  }
  for (const file of current) {
    if (next.has(file.path)) continue;
    const path = join(root, file.path);
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
  }
}

async function publishText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function historySurfaceFiles(
  messages: readonly Genesis["history"][number][],
): ContentTreeFile[] {
  return messages.map((message) => {
    const genesis =
      /\.message\.genesis(?:\.([1-9][0-9]*))?\.(player|narrator)$/u.exec(
        message.messageId,
      );
    const committed =
      /\.message\.([1-9][0-9]*)\.([1-9][0-9]*)\.(player|narrator)$/u.exec(
        message.messageId,
      );
    const sequence =
      genesis !== null ? 0 : Number.parseInt(committed?.[1] ?? "", 10);
    const index =
      genesis !== null
        ? Number.parseInt(genesis[1] ?? "1", 10)
        : Number.parseInt(committed?.[2] ?? "", 10);
    const role = genesis?.[2] ?? committed?.[3];
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(index) ||
      index < 1 ||
      role !== message.role
    )
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `History-message identity cannot form a materialization path: ${message.messageId}`,
      );
    return {
      path: `${String(sequence).padStart(8, "0")}-${historyFileName(index, message)}`,
      contents: message.exactText,
    };
  });
}

function materializedHistoryRecord(
  worldId: string,
  files: readonly ContentTreeFile[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) {
    const match = /^(\d{8})-(\d+)-(player|narrator)-[a-f0-9]{12}\.md$/u.exec(
      file.path,
    );
    if (match === null)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Materialized history path is invalid: ${file.path}`,
      );
    const sequence = Number.parseInt(match[1]!, 10);
    const index = Number.parseInt(match[2]!, 10);
    const role = match[3]!;
    const messageId =
      sequence === 0
        ? index === 1 && role === "narrator"
          ? `${worldId}.message.genesis.narrator`
          : `${worldId}.message.genesis.${index}.${role}`
        : `${worldId}.message.${sequence}.${index}.${role}`;
    if (messageId in result)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Materialized history contains a duplicate message: ${messageId}`,
      );
    result[messageId] = file.contents;
  }
  return result;
}

async function writeIdempotentText(
  path: string,
  contents: string,
): Promise<void> {
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== contents)
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        "History-message materialization content conflict",
      );
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  }
}

function historyFileName(
  index: number,
  message: { messageId: string; role: "player" | "narrator" },
): string {
  return `${String(index).padStart(2, "0")}-${message.role}-${operationDigest(message.messageId).slice(0, 12)}.md`;
}

function cloneAuthorityPrefix(input: {
  sourceWorldId: string;
  sourceHead: string;
  targetWorldId: string;
  sourceGenesis: FileNativeRecoveredEndpoint;
  sourceAuthority: FileNativePlayAuthority | null;
}): {
  genesisHistory: Genesis["history"];
  genesisMaterials: MaterialSelection[];
  commits: FileNativePlayCommit[];
} {
  const end =
    input.sourceHead === "genesis"
      ? 0
      : (input.sourceAuthority?.commits.findIndex(
          ({ head }) => head === input.sourceHead,
        ) ?? -1) + 1;
  if (input.sourceHead !== "genesis" && end === 0)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      `Cannot copy a nonexistent source Authority endpoint: ${input.sourceHead}`,
    );
  const sourceCommits = input.sourceAuthority?.commits.slice(0, end) ?? [];
  const messageIds = new Map<string, string>();
  const bindMessageId = (source: string, target: string) => {
    if (messageIds.has(source))
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Source Authority contains a duplicate history-message identity: ${source}`,
      );
    messageIds.set(source, target);
  };
  for (const [index, message] of input.sourceGenesis.history.entries())
    bindMessageId(
      message.messageId,
      index === 0 && message.role === "narrator"
        ? `${input.targetWorldId}.message.genesis.narrator`
        : `${input.targetWorldId}.message.genesis.${index + 1}.${message.role}`,
    );
  for (const [commitIndex, commit] of sourceCommits.entries())
    for (const [messageIndex, message] of commit.historyAppend.entries())
      bindMessageId(
        message.messageId,
        `${input.targetWorldId}.message.${commitIndex + 1}.${messageIndex + 1}.${message.role}`,
      );

  const rewriteHistory = (
    history: readonly Genesis["history"][number][],
  ): Genesis["history"] =>
    history.map((message) => ({
      ...structuredClone(message),
      messageId: messageIds.get(message.messageId)!,
    }));
  const clonedCommits: FileNativePlayCommit[] = [];
  let parentCommitDigest: string | null = null;
  for (const commit of sourceCommits) {
    const cloned: FileNativePlayCommit = {
      ...structuredClone(commit),
      schemaVersion: 2,
      parentCommitDigest,
      operationId: `clone-${operationDigest(`${input.targetWorldId}\0${commit.head}`).slice(0, 56)}`,
      historyAppend: rewriteHistory(commit.historyAppend),
      nextAdditionalMaterials: rewriteMaterials(
        commit.nextAdditionalMaterials,
        messageIds,
        input.sourceWorldId,
        input.targetWorldId,
      ),
      ...(commit.timelineRevision === undefined
        ? {}
        : {
            timelineRevision: {
              ...structuredClone(commit.timelineRevision),
              replacementHistory: rewriteHistory(
                commit.timelineRevision.replacementHistory,
              ),
            },
          }),
    };
    clonedCommits.push(cloned);
    parentCommitDigest = playCommitDigest(cloned);
  }
  return {
    genesisHistory: rewriteHistory(input.sourceGenesis.history),
    genesisMaterials: rewriteMaterials(
      input.sourceGenesis.additionalMaterials,
      messageIds,
      input.sourceWorldId,
      input.targetWorldId,
    ),
    commits: clonedCommits,
  };
}

function rewriteMaterials(
  materials: readonly MaterialSelection[],
  messageIds: ReadonlyMap<string, string>,
  sourceWorldId: string,
  targetWorldId: string,
): MaterialSelection[] {
  return materials.map((material) => {
    if (material.kind === "history_message") {
      const message = messageIds.get(material.message);
      if (message === undefined)
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `Fork material references a history message that cannot be remapped: ${material.message}`,
        );
      return { ...material, message };
    }
    if (material.kind === "history_commit") {
      const sourcePrefix = `${sourceWorldId}.`;
      return {
        ...material,
        commit: material.commit.startsWith(sourcePrefix)
          ? `${targetWorldId}.${material.commit.slice(sourcePrefix.length)}`
          : material.commit,
      };
    }
    return structuredClone(material);
  });
}

function isCommittedOutcome(
  outcome: FileNativeOperationOutcome,
): outcome is Extract<
  FileNativeOperationOutcome,
  { outcome: "committed" | "committed_materialization_pending" }
> {
  return (
    outcome.outcome === "committed" ||
    outcome.outcome === "committed_materialization_pending"
  );
}

function assertSameOperationOutcome(
  outcome: Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
  input: {
    worldId: string;
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
  },
): void {
  if (
    outcome.worldId !== input.worldId ||
    outcome.parentHead !== input.parentHead ||
    !isDeepStrictEqual(outcome.historyAppend, input.historyAppend) ||
    !isDeepStrictEqual(outcome.nextAdditionalMaterials, input.nextMaterials)
  ) {
    throw new FileNativeWorldCreationError(
      "operation_conflict",
      "The same play operation ID is bound to a different commit payload",
    );
  }
}

function openWorldDocumentSnapshot(
  files: readonly ContentTreeFile[],
): WorldDocumentStore {
  return WorldDocumentStore.open({
    layout: "world_state",
    files: files.map((file) => ({
      path: `state/${file.path}`,
      contents: file.contents,
      ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
    })),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(path);
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

async function durableTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await durableTree(path);
    else if (entry.isFile()) await syncFile(path);
  }
  await syncDirectory(root);
}

async function readPublicationAt(root: string): Promise<Publication> {
  return readJson<Publication>(join(root, publicationFile));
}

async function readWorldSummaryAt(
  root: string,
  publication?: Publication,
): Promise<FileNativeWorldSummary> {
  const published = publication ?? (await readPublicationAt(root));
  const metadata = await readOptionalJson<unknown>(
    join(root, localMetadataFile),
  );
  if (metadata === null) return toSummary(published);
  if (!isWorldLocalMetadata(metadata) || metadata.worldId !== published.worldId)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Local world shell is corrupt",
    );
  return { ...toSummary(published), title: metadata.name };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function toSummary(publication: Publication): FileNativeWorldSummary {
  return {
    worldId: publication.worldId,
    title: publication.title,
    parentEndpoint: publication.parentEndpoint,
  };
}

const worldNamePattern = /^[^\r\n]{1,160}$/u;

function validWorldName(name: string): boolean {
  return worldNamePattern.test(name);
}

function derivedWorldName(sourceName: string): string {
  const suffix = " (fork)";
  return `${Array.from(sourceName)
    .slice(0, 160 - Array.from(suffix).length)
    .join("")}${suffix}`;
}

function derivationRequestFingerprint(
  input: FileNativeWorldDerivationInput,
): string {
  return sha256(
    JSON.stringify({
      schema: "narraeon.file-native-derivation-request/v2",
      sourceWorldId: input.sourceWorldId,
      sourceHead: input.sourceHead,
      hostPresetId: input.hostPresetId,
      requestDiscriminator: input.requestDiscriminator ?? null,
    }),
  );
}

async function derivationPublicationMatches(
  worldRoot: string,
  publication: Publication,
  input: FileNativeWorldDerivationInput,
  requestFingerprint: string,
): Promise<boolean> {
  if (publication.operationId !== input.operationId) return false;
  if (publication.sourceFingerprint === requestFingerprint) return true;

  // V1 briefly persisted raw provenance inside genesis. It remains readable
  // only so a previously published operation can finish an idempotent retry;
  // newly derived worlds never write or consult this relationship.
  const legacy = await readOptionalJson<LegacyDerivationGenesis>(
    join(worldRoot, "runtime", "genesis.json"),
  );
  return (
    legacy?.derivedFrom?.worldId === input.sourceWorldId &&
    legacy.derivedFrom.head === input.sourceHead &&
    legacy.hostPresetId === input.hostPresetId &&
    input.requestDiscriminator === undefined
  );
}

function isWorldLocalMetadata(value: unknown): value is WorldLocalMetadata {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "worldId", "name"]) &&
    value.schemaVersion === 1 &&
    typeof value.worldId === "string" &&
    typeof value.name === "string" &&
    validWorldName(value.name)
  );
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError("World file path is invalid");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function crashAtFileNativeWorldCreationEdge(edge: string): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env
      .NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_WORLD_CREATION_EDGE === edge
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function crashAtFileNativeAuthorityEdge(edge: string): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_AUTHORITY_EDGE ===
      edge
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}
