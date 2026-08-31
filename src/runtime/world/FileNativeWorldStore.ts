import { createHash, randomUUID } from "node:crypto";
import {
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
import { FileNativeWorldStorageMigrator } from "./FileNativeWorldStorageMigrator.ts";
import {
  FileNativeAuthorityV3,
  FileNativeAuthorityV3Error,
  type FileNativeAuthorityCommitV3,
  type FileNativeAuthorityHeadV3,
  type FileNativeAuthorityRecoveredEndpoint as AuthorityRecoveredEndpoint,
  type FileNativeAuthorityTimelineRevision,
} from "./FileNativeAuthorityV3.ts";
import {
  FileNativeWorldOperationCoordinator,
  WorldOperationBusyError,
  type ContinuityCorrectionWorldClaimHandle,
} from "./WorldOperationCoordinator.ts";
import {
  fileNativeHistoryMessageIdFromProjectionPath,
  projectFileNativeHistorySurface,
} from "./FileNativeHistoryProjection.ts";

const publicationFile = "publication.json";
const localMetadataFile = "local.json";

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

export type FileNativePlayCommit = FileNativeAuthorityCommitV3;

interface FileNativeMaterializedCheckpoint {
  schemaVersion: 3;
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
  stageTarget?: (input: {
    targetWorldRoot: string;
    targetWorldId: string;
    binding: FileNativePlayBinding;
  }) => Promise<void>;
}

export class FileNativeWorldStore {
  readonly #worldsRoot: string;
  readonly #operationsRoot: string;
  readonly #promptCompiler: FileNativePromptCompiler;
  readonly #activeControlUsers = new Map<string, Set<string>>();
  readonly operations: FileNativeWorldOperationCoordinator;
  readonly playTimeline: FileNativePlayTimelineStore;
  readonly playAdvances: FileNativePlayAdvanceStore;
  readonly #storageMigrator: FileNativeWorldStorageMigrator;
  readonly #storageMigrations = new Map<string, Promise<void>>();
  readonly #currentStorage = new Set<string>();

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
    this.#storageMigrator = new FileNativeWorldStorageMigrator(
      root,
      this.playTimeline,
    );
  }

  /**
   * Upgrade a formally released cumulative layout before current Authority or
   * play-timeline behavior crosses its seam. Concurrent callers share one
   * in-process promise; the durable world lock serializes processes.
   */
  async ensureCurrentStorage(worldId: string): Promise<void> {
    assertIdentity(worldId, "World ID");
    if (this.#currentStorage.has(worldId)) return;
    const existing = this.#storageMigrations.get(worldId);
    if (existing !== undefined) return existing;
    const migration = this.#ensureCurrentStorageSerialized(worldId);
    this.#storageMigrations.set(worldId, migration);
    try {
      await migration;
    } finally {
      if (this.#storageMigrations.get(worldId) === migration)
        this.#storageMigrations.delete(worldId);
    }
  }

  async #ensureCurrentStorageSerialized(worldId: string): Promise<void> {
    try {
      const root = join(this.#worldsRoot, worldId);
      const authority = new FileNativeAuthorityV3(root);
      if (await authority.exists()) {
        await authority.readHead();
        this.#currentStorage.add(worldId);
        return;
      }
      await this.operations.withWorldAuthorityLock(worldId, async () => {
        await this.#storageMigrator.migrate(worldId);
      });
      this.#currentStorage.add(worldId);
    } catch (error: unknown) {
      if (error instanceof FileNativeWorldCreationError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") {
        const root = await stat(join(this.#worldsRoot, worldId)).catch(
          (statError: unknown) => {
            if (isNodeError(statError) && statError.code === "ENOENT")
              return null;
            throw statError;
          },
        );
        if (root === null)
          throw new FileNativeWorldNotFoundError({ cause: error });
      }
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World storage is being upgraded by another durable operation",
          { cause: error },
        );
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "Released world storage could not be migrated to the current format",
        error instanceof Error ? { cause: error } : undefined,
      );
    }
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
        this.#currentStorage.delete(worldId);
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
      const openingMessage = genesisOpeningMessage(openingText(packageFiles));
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
          historySurfaceFiles([openingMessage])[0]!.path,
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
      await new FileNativeAuthorityV3(stagingRoot).initialize({
        operationId: input.operationId,
        state,
        history: [openingMessage],
        additionalMaterials: initialMaterials,
      });
      await writeJson(join(stagingRoot, "runtime", "materialized-head.json"), {
        schemaVersion: 3,
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
    await this.ensureCurrentStorage(worldId);
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
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return (await new FileNativeAuthorityV3(root).readHead()).head;
  }

  async currentHeadOperationId(worldId: string): Promise<string | null> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return new FileNativeAuthorityV3(root).currentOperationId();
  }

  async saveControlDraft(
    worldId: string,
    files: readonly ContentTreeFile[],
  ): Promise<{ fingerprint: string }> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
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
    await this.ensureCurrentStorage(worldId);
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
    await this.ensureCurrentStorage(worldId);
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
        const authorityStore = new FileNativeAuthorityV3(root);
        const authority = await authorityStore.readHead();
        const checkpoint = await readMaterializedCheckpoint(root);
        if (!sameMaterializedEndpoint(checkpoint, authority)) {
          const recovered = await authorityStore.recover();
          let operation: Extract<
            FileNativeOperationOutcome,
            {
              outcome: "committed" | "committed_materialization_pending";
            }
          > | null = null;
          if (authority.operationId !== null && authority.sequence > 0) {
            const candidate = await this.getOperationOutcome(
              authority.operationId,
            );
            if (isCommittedOutcome(candidate)) {
              if (
                candidate.worldId !== worldId ||
                candidate.head !== authority.head ||
                candidate.commitDigest !== authority.commitDigest
              )
                throw new FileNativeWorldCreationError(
                  "world_corrupt",
                  "Current Authority head is bound to a different operation receipt",
                );
              operation = candidate;
            } else if (candidate.outcome !== "not_started") {
              throw new FileNativeWorldCreationError(
                "world_corrupt",
                "Current Authority head has no recoverable acceptance receipt",
              );
            }
          }
          await materializeRecoveredEndpoint(root, authority, recovered);
          if (operation !== null)
            await publishJson(
              this.#operationOutcomePath(authority.operationId!),
              { ...operation, outcome: "committed" },
            );
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
          history: materializedHistoryRecord(history),
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
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    try {
      const recovered = await new FileNativeAuthorityV3(root).recover(head);
      return {
        worldId,
        head: recovered.head,
        state: recovered.state,
        history: recovered.history,
        additionalMaterials: recovered.additionalMaterials,
      };
    } catch (error: unknown) {
      if (error instanceof FileNativeWorldCreationError) throw error;
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Cannot recover immutable Authority endpoint${head === undefined ? "" : `: ${head}`}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async repairMaterialization(
    worldId: string,
  ): Promise<FileNativeOperationOutcome> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    try {
      const operationId = await this.operations.withExclusiveWorldStateMutation(
        worldId,
        async () => {
          await this.bindPlayCallChain(worldId);
          const root = join(this.#worldsRoot, worldId);
          return (await new FileNativeAuthorityV3(root).readHead()).operationId;
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
      await this.ensureCurrentStorage(previous.worldId);
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
      await this.ensureCurrentStorage(alreadyPublished.worldId);
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

    await this.ensureCurrentStorage(input.sourceWorldId);
    const retainSourceSnapshot = async (): Promise<{
      outcome: "derived";
      world: FileNativeWorldSummary;
    }> => {
      const sourceRoot = join(this.#worldsRoot, input.sourceWorldId);
      const sourcePublication = await readPublicationAt(sourceRoot);
      const sourceSummary = await readWorldSummaryAt(
        sourceRoot,
        sourcePublication,
      );
      const sourceAuthority = new FileNativeAuthorityV3(sourceRoot);
      const [sourceGenesis, control] = await Promise.all([
        readGenesisForFork(sourceRoot, input.sourceWorldId),
        readTree(join(sourceRoot, "control")),
      ]);
      const staging = join(
        this.#worldsRoot,
        `.staging-${worldId}-${randomUUID()}`,
      );
      await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
      try {
        await mkdir(join(staging, "runtime"), { recursive: true });
        const clonedHead = await sourceAuthority.clonePrefixTo({
          targetWorldRoot: staging,
          selectedHead: input.sourceHead,
          operationId: input.operationId,
        });
        const selected = await new FileNativeAuthorityV3(
          staging,
        ).recoverHeadResult();
        await writeSurface(staging, "state", selected.state);
        await writeSurface(staging, "control", control);
        await mkdir(join(staging, "history"), { recursive: true });
        for (const file of historySurfaceFiles(selected.history))
          await writeIdempotentText(
            join(staging, "history", file.path),
            file.contents,
          );
        const genesis: Genesis = {
          schemaVersion: 1,
          type: "file_native_genesis",
          worldId,
          operationId: input.operationId,
          parentEndpoint: "genesis",
          state: structuredClone(sourceGenesis.state),
          control: immutableFiles(control),
          history: structuredClone(sourceGenesis.history),
          additionalMaterials: structuredClone(
            sourceGenesis.additionalMaterials,
          ),
        };
        await writeJson(join(staging, "runtime", "genesis.json"), genesis);
        await writeJson(
          join(staging, "runtime", "play-genesis-timeline.json"),
          {
            schemaVersion: 1,
            worldId,
            history: genesis.history,
          },
        );
        await writeJson(join(staging, "runtime", "additional-materials.json"), {
          head: input.sourceHead,
          items: selected.additionalMaterials,
        });
        await writeJson(join(staging, "runtime", "materialized-head.json"), {
          schemaVersion: 3,
          head: input.sourceHead,
          sequence: clonedHead.sequence,
          commitDigest: clonedHead.commitDigest,
        } satisfies FileNativeMaterializedCheckpoint);
        await input.stageTarget?.({
          targetWorldRoot: staging,
          targetWorldId: worldId,
          binding: {
            worldId,
            parentHead: input.sourceHead,
            files: [...selected.state, ...control].reduce<
              Record<string, string>
            >((files, { path, contents }, index) => {
              files[
                `${index < selected.state.length ? "state" : "control"}/${path}`
              ] = contents;
              return files;
            }, {}),
            additionalMaterials: structuredClone(selected.additionalMaterials),
            history: Object.fromEntries(
              selected.history.map(({ messageId, exactText }) => [
                messageId,
                exactText,
              ]),
            ),
          },
        });
        crashAtFileNativeAuthorityEdge("derivation_after_target_staging");
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
    };
    try {
      return await this.operations.withExclusiveWorldStateMutation(
        input.sourceWorldId,
        async () =>
          this.operations.withWorldAuthorityLock(
            input.sourceWorldId,
            retainSourceSnapshot,
          ),
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The source world is changing and cannot provide one stable fork snapshot",
          { cause: error },
        );
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
      let value = await readOptionalJson<unknown>(
        this.#operationOutcomePath(operationId),
      );
      if (
        isRecord(value) &&
        (value.outcome === "acceptance_prepared" ||
          value.outcome === "committed" ||
          value.outcome === "committed_materialization_pending") &&
        typeof value.worldId === "string"
      ) {
        await this.ensureCurrentStorage(value.worldId);
        value = await readOptionalJson<unknown>(
          this.#operationOutcomePath(operationId),
        );
      }
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
        direct,
      );
      const materialized = await readMaterializedCheckpoint(worldRoot);
      if (materialized !== null && materialized.sequence >= commit.sequence)
        return { ...direct, outcome: "committed" };
      await assertPendingMaterializationCompatible(worldRoot, direct);
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
    await this.ensureCurrentStorage(input.worldId);

    const existing = await this.getOperationOutcome(input.operationId);
    if (isCommittedOutcome(existing)) {
      const fact = await new FileNativeAuthorityV3(
        join(this.#worldsRoot, existing.worldId),
      ).authorityFactAt(existing.head);
      const commit = fact.commit;
      if (
        existing.worldId !== input.worldId ||
        fact.digest !== existing.commitDigest ||
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
    const authorityStore = new FileNativeAuthorityV3(root);
    const [replaced, replacementMaterials] = await Promise.all([
      authorityStore.commitAt(input.replacesHead),
      authorityStore.recoverMaterials(input.restoresHead),
    ]);
    const logicalParent = replaced?.timelineParent.head;
    if (
      replaced === null ||
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
      nextMaterials: worldNeutralMaterials(input.worldId, replacementMaterials),
      stateChanges: [],
      mode: "timeline_revision",
      timelineRevision: {
        restoresHead: input.restoresHead,
        replacesHead: input.replacesHead,
        requestFingerprint: input.requestFingerprint,
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
    await this.ensureCurrentStorage(input.worldId);
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
          nextMaterials: worldNeutralMaterials(
            input.worldId,
            input.nextMaterials,
          ),
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
    await this.ensureCurrentStorage(input.worldId);
    if (input.historyAppend.length === 0 && input.stateChanges.length === 0)
      throw new TypeError(
        "A call-chain commit cannot omit both narrative and state changes",
      );
    return this.#commitHistoryChange({
      ...input,
      nextMaterials: worldNeutralMaterials(input.worldId, input.nextMaterials),
      mode: "play",
    });
  }

  async #commitHistoryChange(input: {
    operationId: string;
    worldId: string;
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    mode: "play" | "correction" | "timeline_revision";
    timelineRevision?: FileNativeAuthorityTimelineRevision;
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
      const authority = new FileNativeAuthorityV3(
        join(this.#worldsRoot, existing.worldId),
      );
      const fact = await authority.authorityFactAt(existing.head);
      if (
        fact.digest !== existing.commitDigest ||
        !authorityCommitMatchesInput(fact.commit, input)
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
    if (prepared !== null) {
      const comparable = {
        ...structuredClone(prepared),
        outcome: "committed_materialization_pending" as const,
      };
      assertSameOperationOutcome(comparable, input);
    }
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
            const known = await new FileNativeAuthorityV3(
              join(this.#worldsRoot, concurrent.worldId),
            ).authorityFactAt(concurrent.head);
            if (
              known.digest !== concurrent.commitDigest ||
              !authorityCommitMatchesInput(known.commit, input)
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
            assertSameOperationOutcome(
              {
                ...structuredClone(concurrentPrepared),
                outcome: "committed_materialization_pending",
              },
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
          const authorityStore = new FileNativeAuthorityV3(root);
          const authority = await authorityStore.readHead();
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
          const [basisState, currentControl] = await Promise.all([
            authorityStore.recoverState(
              input.timelineRevision?.restoresHead ?? authority.head,
            ),
            readTree(join(root, "control")),
          ]);
          const candidateState = new Map(
            basisState.map((file) => [file.path, file.contents]),
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
          if (concurrentPrepared === null)
            await authorityStore.discardUnacceptedNextEpoch();
          crashAtFileNativeAuthorityEdge("before_commit_acceptance");
          const preparedAppend = await authorityStore.prepareAppend({
            operationId: input.operationId,
            parentHead: input.parentHead,
            ...(input.timelineRevision === undefined
              ? {}
              : { timelineParentHead: input.timelineRevision.restoresHead }),
            mode: input.mode,
            historyAppend: input.historyAppend,
            stateChanges: structuredClone(input.stateChanges),
            nextMaterials: input.nextMaterials,
            ...(input.mode === "correction"
              ? {
                  correctionTargets: input.stateChanges.map(
                    ({ documentId }) => documentId,
                  ),
                  corrects: input.parentHead,
                }
              : {}),
            ...(input.timelineRevision === undefined
              ? {}
              : { timelineRevision: input.timelineRevision }),
          });
          crashAtFileNativeAuthorityEdge("after_authority_objects");
          const acceptedPreparation = concurrentPrepared ?? prepared;
          if (
            acceptedPreparation !== null &&
            acceptedPreparation.commitDigest !== preparedAppend.commitDigest
          )
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The prepared Authority fact does not match the reserved operation",
            );
          const { commit } = preparedAppend;
          const pending = {
            outcome: "committed_materialization_pending" as const,
            worldId: input.worldId,
            parentHead: input.parentHead,
            head: commit.head,
            commitDigest: preparedAppend.commitDigest,
            historyAppend: structuredClone(input.historyAppend),
            nextAdditionalMaterials: structuredClone(input.nextMaterials),
            mode: input.mode,
          };
          await publishJson(this.#operationOutcomePath(input.operationId), {
            ...pending,
            outcome: "acceptance_prepared",
          });
          crashAtFileNativeAuthorityEdge("after_acceptance_prepared");
          await authorityStore.publishPrepared(preparedAppend);
          crashAtFileNativeAuthorityEdge("after_commit_acceptance");
          await publishJson(
            this.#operationOutcomePath(input.operationId),
            pending,
          );
          try {
            const recovered = await authorityStore.recover(commit.head);
            await assertPendingMaterializationCompatible(root, pending);
            await materializeRecoveredEndpoint(
              root,
              preparedAppend.nextHead,
              recovered,
            );
            crashAtFileNativeAuthorityEdge("after_materialization");
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
      if (error instanceof FileNativeAuthorityV3Error)
        throw new FileNativeWorldCreationError(
          error.code === "corrupt" ? "world_corrupt" : "operation_conflict",
          error.message,
          { cause: error },
        );
      throw error;
    }
  }

  async readAuthorityHistory(
    worldId: string,
  ): Promise<{ head: string; commits: FileNativeAuthorityCommitV3[] }> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const authority = await new FileNativeAuthorityV3(root).readHistory();
    return structuredClone(authority);
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

function genesisOpeningMessage(exactText: string) {
  return {
    messageId: "message.genesis.narrator",
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
  const authorityStore = new FileNativeAuthorityV3(worldRoot);
  const authority = await authorityStore.readHead();
  if (authority.head === prepared.parentHead) return { outcome: "in_progress" };
  if (authority.operationId !== operationId) throw corruptOperationOutcome();
  const commit = await assertCommittedAuthorityOutcomeMatches(
    worldRoot,
    prepared,
  );
  if (authority.sequence < commit.sequence) throw corruptOperationOutcome();
  const materialized = await readMaterializedCheckpoint(worldRoot);
  const outcome: "committed" | "committed_materialization_pending" =
    materialized !== null && materialized.sequence >= commit.sequence
      ? "committed"
      : "committed_materialization_pending";
  const resolved = { ...structuredClone(prepared), outcome };
  if (outcome === "committed_materialization_pending")
    await assertPendingMaterializationCompatible(worldRoot, resolved);
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
  outcome: Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
): Promise<FileNativeAuthorityCommitV3> {
  const fact = await new FileNativeAuthorityV3(worldRoot).authorityFactAt(
    outcome.head,
  );
  const { commit } = fact;
  if (
    fact.digest !== outcome.commitDigest ||
    commit.auditParent.head !== outcome.parentHead ||
    commit.head !== outcome.head ||
    commit.mode !== outcome.mode ||
    !isDeepStrictEqual(
      commit.historyAppend.map(({ role, exactText }) => ({ role, exactText })),
      outcome.historyAppend,
    ) ||
    !isDeepStrictEqual(
      commit.nextAdditionalMaterials,
      outcome.nextAdditionalMaterials,
    )
  )
    throw corruptOperationOutcome();
  return commit;
}

async function assertPendingMaterializationCompatible(
  worldRoot: string,
  outcome: Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
): Promise<void> {
  const authority = new FileNativeAuthorityV3(worldRoot);
  await assertCommittedAuthorityOutcomeMatches(worldRoot, outcome);
  const [parent, target, state, history] = await Promise.all([
    authority.recover(outcome.parentHead),
    authority.recover(outcome.head),
    readTree(join(worldRoot, "state")),
    readTree(join(worldRoot, "history")),
  ]);
  assertProjectionBetweenEndpoints("state", state, parent.state, target.state);
  assertHistoryProjectionBetweenEndpoints(
    history,
    historySurfaceFiles(parent.history),
    historySurfaceFiles(target.history),
  );
  const existingMaterials = await readOptionalJson<{
    head: string;
    items: MaterialSelection[];
  }>(join(worldRoot, "runtime", "additional-materials.json"));
  if (
    existingMaterials !== null &&
    !(
      (existingMaterials.head === parent.head &&
        isDeepStrictEqual(
          existingMaterials.items,
          parent.additionalMaterials,
        )) ||
      (existingMaterials.head === target.head &&
        isDeepStrictEqual(existingMaterials.items, target.additionalMaterials))
    )
  )
    throw new FileNativeWorldCreationError(
      "inconsistent_materialization",
      "Additional-material list content conflicts at the same endpoint",
    );
}

function assertProjectionBetweenEndpoints(
  surface: string,
  current: readonly ContentTreeFile[],
  parent: readonly ContentTreeFile[],
  target: readonly ContentTreeFile[],
): void {
  const parentFiles = new Map(parent.map((file) => [file.path, file.contents]));
  const targetFiles = new Map(target.map((file) => [file.path, file.contents]));
  for (const file of current) {
    if (
      file.contents !== parentFiles.get(file.path) &&
      file.contents !== targetFiles.get(file.path)
    )
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        `World ${surface} projection conflicts with both accepted endpoints: ${file.path}`,
      );
  }
}

function assertHistoryProjectionBetweenEndpoints(
  current: readonly ContentTreeFile[],
  parent: readonly ContentTreeFile[],
  target: readonly ContentTreeFile[],
): void {
  const byMessageId = (files: readonly ContentTreeFile[]) =>
    new Map(
      files.map((file) => [
        fileNativeHistoryMessageIdFromProjectionPath(file.path),
        file.contents,
      ]),
    );
  const parentFiles = byMessageId(parent);
  const targetFiles = byMessageId(target);
  const seen = new Set<string>();
  for (const file of current) {
    const messageId = fileNativeHistoryMessageIdFromProjectionPath(file.path);
    if (
      messageId === null ||
      seen.has(messageId) ||
      (file.contents !== parentFiles.get(messageId) &&
        file.contents !== targetFiles.get(messageId))
    )
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        `World history projection conflicts with both accepted endpoints: ${file.path}`,
      );
    seen.add(messageId);
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
    value.schemaVersion !== 3 ||
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
  authority: FileNativeAuthorityHeadV3,
): boolean {
  return (
    checkpoint !== null &&
    checkpoint.head === authority.head &&
    checkpoint.sequence === authority.sequence &&
    checkpoint.commitDigest === authority.commitDigest
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

async function materializeRecoveredEndpoint(
  root: string,
  authority: FileNativeAuthorityHeadV3,
  endpoint: AuthorityRecoveredEndpoint,
): Promise<void> {
  if (authority.head !== endpoint.head)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Recovered endpoint does not match the Authority head to materialize",
    );
  await replaceMaterializedTree(join(root, "state"), endpoint.state);
  crashAtFileNativeAuthorityEdge("after_state_materialization");
  await replaceMaterializedTree(
    join(root, "history"),
    historySurfaceFiles(endpoint.history),
  );
  await publishJson(join(root, "runtime", "additional-materials.json"), {
    head: authority.head,
    items: endpoint.additionalMaterials,
  });
  await publishJson(join(root, "runtime", "materialized-head.json"), {
    schemaVersion: 3,
    head: authority.head,
    sequence: authority.sequence,
    commitDigest: authority.commitDigest,
  } satisfies FileNativeMaterializedCheckpoint);
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
  return projectFileNativeHistorySurface(messages, (messageId) => {
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      `History-message identity cannot form a materialization path: ${messageId}`,
    );
  });
}

function materializedHistoryRecord(
  files: readonly ContentTreeFile[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) {
    const messageId = fileNativeHistoryMessageIdFromProjectionPath(file.path);
    if (messageId === null)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        `Materialized history path is invalid: ${file.path}`,
      );
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

function worldNeutralMaterials(
  worldId: string,
  materials: readonly MaterialSelection[],
): MaterialSelection[] {
  const prefix = `${worldId}.`;
  return materials.map((material) => {
    if (material.kind === "history_message") {
      const message = material.message.startsWith(prefix)
        ? material.message.slice(prefix.length)
        : material.message;
      if (
        !/^message\.(?:genesis(?:\.[1-9][0-9]*)?\.(?:player|narrator)|[1-9][0-9]*\.[1-9][0-9]*\.(?:player|narrator))$/u.test(
          message,
        )
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "History material does not name a local immutable message",
        );
      return { ...material, message };
    }
    if (material.kind === "history_commit") {
      const commit = material.commit.startsWith(prefix)
        ? material.commit.slice(prefix.length)
        : material.commit;
      if (!/^(?:genesis|commit:[1-9][0-9]*)$/u.test(commit))
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "History material does not name a local immutable Authority endpoint",
        );
      return { ...material, commit };
    }
    return structuredClone(material);
  });
}

function authorityCommitMatchesInput(
  commit: FileNativeAuthorityCommitV3,
  input: {
    parentHead: string;
    historyAppend: { role: "player" | "narrator"; exactText: string }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    mode: "play" | "correction" | "timeline_revision";
    timelineRevision?: FileNativeAuthorityTimelineRevision;
  },
): boolean {
  const stateChangesMatch =
    commit.stateChanges.length === input.stateChanges.length &&
    commit.stateChanges.every((stored, index) => {
      const candidate = input.stateChanges[index];
      if (candidate === undefined) return false;
      const { nextBlob, ...metadata } = stored;
      const expected = {
        kind: candidate.kind,
        documentId: candidate.documentId,
        stableShortRef: candidate.stableShortRef,
        relativePath: candidate.relativePath,
        codec: candidate.codec,
        expectedPreviousHash: candidate.expectedPreviousHash,
        nextHash: candidate.nextHash,
      };
      return (
        nextBlob.epoch === commit.sequence &&
        `sha256:${nextBlob.digest}` === candidate.nextHash &&
        isDeepStrictEqual(metadata, expected)
      );
    });
  const expectedCorrection =
    input.mode === "correction"
      ? input.stateChanges.map(({ documentId }) => documentId)
      : undefined;
  return (
    commit.mode === input.mode &&
    commit.auditParent.head === input.parentHead &&
    commit.timelineParent.head ===
      (input.timelineRevision?.restoresHead ?? input.parentHead) &&
    isDeepStrictEqual(
      commit.historyAppend.map(({ role, exactText }) => ({ role, exactText })),
      input.historyAppend,
    ) &&
    stateChangesMatch &&
    isDeepStrictEqual(commit.nextAdditionalMaterials, input.nextMaterials) &&
    isDeepStrictEqual(commit.timelineRevision, input.timelineRevision) &&
    isDeepStrictEqual(commit.correctionTargets, expectedCorrection) &&
    commit.corrects ===
      (input.mode === "correction" ? input.parentHead : undefined)
  );
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

async function readGenesisForFork(
  worldRoot: string,
  worldId: string,
): Promise<Pick<Genesis, "state" | "history" | "additionalMaterials">> {
  const value = await readJson<unknown>(
    join(worldRoot, "runtime", "genesis.json"),
  );
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.type !== "file_native_genesis" ||
    value.worldId !== worldId ||
    !Array.isArray(value.state) ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.additionalMaterials)
  )
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "World genesis projection has an invalid shape",
    );
  const state = value.state.map((file) => {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["path", "sha256", "canonicalBytes"]) ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      typeof file.canonicalBytes !== "string" ||
      sha256(file.canonicalBytes) !== file.sha256
    )
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "World genesis state projection is corrupt",
      );
    try {
      assertRelativePath(file.path);
    } catch (error: unknown) {
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "World genesis state path is invalid",
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    return {
      path: file.path,
      sha256: file.sha256,
      canonicalBytes: file.canonicalBytes,
    };
  });
  const prefix = `${worldId}.`;
  const history = value.history.map((message, index) => {
    if (
      !isRecord(message) ||
      !hasExactKeys(message, ["messageId", "role", "exactText"]) ||
      typeof message.messageId !== "string" ||
      (message.role !== "player" && message.role !== "narrator") ||
      typeof message.exactText !== "string"
    )
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "World genesis history projection is corrupt",
      );
    const messageId = message.messageId.startsWith(prefix)
      ? message.messageId.slice(prefix.length)
      : message.messageId;
    const role: "player" | "narrator" =
      message.role === "player" ? "player" : "narrator";
    const expected =
      index === 0 && role === "narrator"
        ? "message.genesis.narrator"
        : `message.genesis.${index + 1}.${role}`;
    if (messageId !== expected)
      throw new FileNativeWorldCreationError(
        "world_corrupt",
        "World genesis history identity is invalid",
      );
    return {
      messageId,
      role,
      exactText: message.exactText,
    };
  });
  let additionalMaterials: MaterialSelection[];
  try {
    additionalMaterials = worldNeutralMaterials(
      worldId,
      value.additionalMaterials as MaterialSelection[],
    );
  } catch (error: unknown) {
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "World genesis material projection is invalid",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return { state, history, additionalMaterials };
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
