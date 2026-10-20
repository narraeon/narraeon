import {
  captureNarrativeOrigin,
  snapshotBackground,
  isHistoryBackground,
  type HistoryBackground,
} from "../history/HistoryBackground.ts";
import { FileNativeArtifactStore } from "../artifact/FileNativeArtifactStore.ts";
import { WorldExtensionRequests } from "../extension/WorldExtensionRequests.ts";
import {
  WorldExtensionControls,
  extensionDefinitions,
} from "../extension/WorldExtensionControls.ts";
import type { WorldExtensionChoice } from "../../protocol/worldExtensions.ts";
import type { PlayPresetBinding } from "../play/FileNativePlayPresetStore.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  assertSameGameplay,
  readGameplay,
  type Gameplay,
} from "../../protocol/gameplay.ts";
import type { V1StoryExport, V1StoryExportFormat } from "../../protocol/v1.ts";
import { HistoryQuery } from "../history/HistoryQuery.ts";
import { exportStory } from "../history/StoryExport.ts";
import { PackageScriptPermissions } from "../extension/PackageScriptPermissions.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
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
import {
  readWorldActivity,
  updateWorldActivity,
  type WorldActivity,
  type WorldActivitySummary,
} from "./WorldActivity.ts";
import { FileNativePlayTimelineStore } from "../play/FileNativePlayTimelineStore.ts";
import { FileNativePlayAdvanceStore } from "../play/FileNativePlayAdvanceStore.ts";
import { FileNativeWorldStorageMigrator } from "./FileNativeWorldStorageMigrator.ts";
import {
  WorldAuthorityError,
  WorldLedgerAuthority,
  type WorldTurnCommit,
} from "./WorldLedgerAuthority.ts";
import { rewindTo } from "./WorldTurnLedger.ts";
import {
  FileNativeWorldOperationCoordinator,
  WorldOperationBusyError,
  type ContinuityCorrectionWorldClaimHandle,
  type WorldRevisionLockHandle,
} from "./WorldOperationCoordinator.ts";
import {
  projectFileNativeHistorySurface,
  projectHistoryBackgrounds,
  historyBackgroundRecord,
} from "./FileNativeHistoryProjection.ts";

const publicationFile = "publication.json";
const localMetadataFile = "local.json";

export class FileNativeWorldCreationError extends Error {
  readonly code:
    | "content_package_needs_repair"
    | "content_package_title_invalid"
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
  packageScriptGrants?: string[];
  operationId: string;
  sourcePackageId: string;
  sourcePackageTitle: string;
  packageFiles: readonly ContentTreeFile[];
  prompt: Pick<FileNativePromptInput, "hostBinding" | "modelBinding"> & {
    playerInput?: string;
  };
}

export interface FileNativeWorldSummary extends WorldActivitySummary {
  worldId: string;
  title: string;
  parentEndpoint: "genesis";
  gameplay: Gameplay;
}

interface Publication extends Pick<
  FileNativeWorldSummary,
  "worldId" | "title" | "parentEndpoint"
> {
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
    background?: HistoryBackground;
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
  historyBackgrounds?: Record<string, HistoryBackground>;
  narrativeCheckpoint?: NarrativeCheckpoint | undefined;
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

export type FileNativePlayCommit = WorldTurnCommit;

export type FileNativeOperationOutcome =
  | { outcome: "not_started" | "in_progress" }
  | {
      outcome: "committed";
      worldId: string;
      parentHead: string;
      head: string;
      commitDigest: string;
      historyAppend: {
        role: "player" | "narrator";
        exactText: string;
        background?: HistoryBackground;
      }[];
      nextAdditionalMaterials: MaterialSelection[];
      mode: "play" | "correction";
    };

type CommittedOperationOutcome = Extract<
  FileNativeOperationOutcome,
  { outcome: "committed" }
>;

type OperationEntry =
  | { phase: "in_progress" }
  | { phase: "done"; outcome: CommittedOperationOutcome };

export interface FileNativeRecoveredEndpoint {
  worldId: string;
  head: string;
  state: ContentTreeFile[];
  history: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
    background?: HistoryBackground;
  }[];
  additionalMaterials: MaterialSelection[];
  narrativeCheckpoint?: NarrativeCheckpoint | undefined;
}

export type FileNativeDerivationOutcome =
  | { outcome: "derived"; world: FileNativeWorldSummary }
  | { outcome: "not_derived" | "in_progress" };

export interface FileNativeWorldDerivationInput {
  operationId: string;
  sourceWorldId: string;
  sourceHead: string;
  hostPresetId: string;
  targetDataRoot?: string;
  targetName?: string;
  /** An unpublished closure, outside the world's library. */
  publish?: false;
  targetWorldRoot?: string;
  identityPrefix?: "import";
  resetPackageScriptPermissions?: boolean;
  retainCompleteTimeline?: true;
  /** Additional idempotency identity for a higher-level branch request. */
  requestDiscriminator?: string;
  stageTarget?: (input: {
    targetWorldRoot: string;
    targetWorldId: string;
    binding: FileNativePlayBinding;
    sourceHead: string;
  }) => Promise<void>;
}

export class FileNativeWorldStore {
  readonly extensionRequests: WorldExtensionRequests;
  readonly #documentMaintenanceCache = new Map<
    string,
    Map<string, DocumentMaintenanceState>
  >();
  readonly #worldsRoot: string;
  // Process-local duplicate guard keyed by operation ID (ADR-0044): entries are
  // not persisted, so a restart forgets them and a repeated operation redoes.
  readonly #operationOutcomes = new Map<string, OperationEntry>();
  readonly #promptCompiler: FileNativePromptCompiler;
  readonly #activeControlUsers = new Map<string, Set<string>>();
  readonly #openingWorldRevisions = new Set<string>();
  readonly #archiveExports = new Set<string>();
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
    this.extensionRequests = new WorldExtensionRequests(this.#worldsRoot);
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
    // A shared migration may be queued behind this caller; when the caller
    // already holds the world, run the migration inline instead of awaiting it.
    if (this.operations.isWorldHeld(worldId))
      return this.#ensureCurrentStorageSerialized(worldId);
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
      const authority = new WorldLedgerAuthority(root);
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

  async gameplay(worldId: string): Promise<Gameplay> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return readWorldGameplayAt(root);
  }

  async readWorldSummary(worldId: string): Promise<FileNativeWorldSummary> {
    assertIdentity(worldId, "World ID");
    return readWorldSummaryAt(join(this.#worldsRoot, worldId));
  }

  async listWorlds(): Promise<FileNativeWorldSummary[]> {
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    const entries = (
      await readdir(this.#worldsRoot, { withFileTypes: true })
    ).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    const worlds: FileNativeWorldSummary[] = [];
    // Bound concurrent shell/head/cache reads even in a large workspace.
    for (let offset = 0; offset < entries.length; offset += 16) {
      worlds.push(
        ...(await Promise.all(
          entries
            .slice(offset, offset + 16)
            .map((entry) =>
              readWorldSummaryAt(
                join(this.#worldsRoot, entry.name),
                undefined,
                (rebuild) =>
                  this.operations.withWorldAuthorityLock(entry.name, rebuild),
              ),
            ),
        )),
      );
    }
    return worlds.sort(
      (left, right) =>
        (right.lastActivityAt ?? -1) - (left.lastActivityAt ?? -1) ||
        left.title.localeCompare(right.title) ||
        left.worldId.localeCompare(right.worldId),
    );
  }

  /** Explicit full-history read; independent of page and model projections. */
  async exportStory(
    worldId: string,
    format: V1StoryExportFormat,
    locale: AppLocale,
  ): Promise<V1StoryExport> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    return this.operations.withWorldAuthorityLock(worldId, async () => {
      const root = join(this.#worldsRoot, worldId);
      const publication = await readPublicationAt(root);
      const title = await readWorldTitleAt(root, publication);
      const endpoint = await new WorldLedgerAuthority(root).recoverHeadResult();
      const history = new HistoryQuery(
        worldId,
        endpoint.history.map(({ messageId, role, exactText }) => ({
          id: messageId,
          role,
          text: exactText,
        })),
      );
      return exportStory(title, history.messages, format, locale);
    });
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
      return readWorldSummaryAt(root, publication);
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
    return this.operations.withExclusiveWorldStateMutation(worldId, () =>
      this.operations.withWorldAuthorityLock(worldId, async () => {
        await rm(root, { recursive: true, force: true });
        this.#currentStorage.delete(worldId);
        return { deleted: true } as const;
      }),
    );
  }

  async extensionControls(
    worldId: string,
    binding: PlayPresetBinding,
    locale: AppLocale,
    change?: { key: string; value: WorldExtensionChoice },
  ) {
    assertIdentity(worldId, "World ID");
    const head = await this.currentHead(worldId);
    const [control, playerViews] = await Promise.all([
      this.readSurface(worldId, "control"),
      this.renderPlayerViewsAtHead(worldId, head),
    ]);
    const definitions = extensionDefinitions(
      binding,
      control.map((file) => ({ ...file, path: `control/${file.path}` })),
      playerViews.views,
      locale,
    );
    return this.operations.withWorldAuthorityLock(worldId, () =>
      FileNativeArtifactStore.withWorldControlsMutation(
        dirname(this.#worldsRoot),
        worldId,
        async () => {
          // Definitions were loaded before taking the lock; deletion may have
          // completed while this reader was waiting. Never recreate its shell.
          await readPublicationAt(join(this.#worldsRoot, worldId));
          const view = await WorldExtensionControls.resolve(
            join(this.#worldsRoot, worldId),
            definitions,
            binding.id,
            change,
          );
          await this.extensionRequests.changed(worldId);
          return view;
        },
      ),
    );
  }
  async extensionControlsRevision(worldId: string): Promise<number> {
    assertIdentity(worldId, "World ID");
    return (await WorldExtensionControls.read(join(this.#worldsRoot, worldId)))
      .revision;
  }

  async readPackageScriptGrants(worldId: string): Promise<string[]> {
    assertIdentity(worldId, "World ID");
    await this.currentHead(worldId);
    return PackageScriptPermissions.read(join(this.#worldsRoot, worldId));
  }

  async packageScriptPermissions(
    worldId: string,
    enabled?: boolean,
  ): Promise<{ enabled: boolean }> {
    assertIdentity(worldId, "World ID");
    const files = (await this.readSurface(worldId, "control")).map((file) => ({
      ...file,
      path: `control/${file.path}`,
    }));
    const root = join(this.#worldsRoot, worldId);
    if (enabled !== undefined)
      await PackageScriptPermissions.write(
        root,
        enabled ? PackageScriptPermissions.currentGrants(files) : [],
      );
    return PackageScriptPermissions.status(
      files,
      await PackageScriptPermissions.read(root),
    );
  }

  async createFromContentPackage(input: FileNativeWorldCreationInput): Promise<{
    outcome: "created";
    world: FileNativeWorldSummary;
    preview: PromptPreview;
  }> {
    assertIdentity(input.operationId, "operation ID");
    assertIdentity(input.sourcePackageId, "Content-package local identity");
    if (
      input.sourcePackageTitle !== input.sourcePackageTitle.trim() ||
      !validWorldName(input.sourcePackageTitle)
    )
      throw new FileNativeWorldCreationError(
        "content_package_title_invalid",
        "The source content package has no valid standalone title",
      );
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

    const legacySourceFingerprint = fingerprint(packageFiles);
    const sourceFingerprint = contentPackageCreationFingerprint(
      input.sourcePackageTitle,
      packageFiles,
    );
    const previous = await this.#readPublication(input.operationId);
    if (previous !== null) {
      if (
        previous.sourceFingerprint !== sourceFingerprint &&
        previous.sourceFingerprint !== legacySourceFingerprint
      ) {
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
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    await rm(stagingRoot, { recursive: true, force: true });
    try {
      const openingMessage = {
        ...genesisOpeningMessage(openingText(packageFiles)),
        ...backgroundField(
          snapshotBackground(
            captureNarrativeOrigin(inspection.worldDocumentSnapshot, 1).value,
          ),
        ),
      };
      const initialMaterials: MaterialSelection[] = [
        { kind: "history_message", message: openingMessage.messageId },
      ];
      await writeSurface(stagingRoot, "state", state);
      await writeSurface(stagingRoot, "control", control);
      await PackageScriptPermissions.write(
        stagingRoot,
        (input.packageScriptGrants ?? []).filter((grant) =>
          PackageScriptPermissions.currentGrants(packageFiles).includes(grant),
        ),
      );
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
      await replaceMaterializedTree(
        join(stagingRoot, "runtime", "history-backgrounds"),
        projectHistoryBackgrounds([openingMessage]),
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
      await new WorldLedgerAuthority(stagingRoot).initialize();
      await writeJson(
        join(stagingRoot, "runtime", "additional-materials.json"),
        { head: "genesis", items: initialMaterials },
      );
      const publication: Publication = {
        schemaVersion: 1,
        worldId,
        title: input.sourcePackageTitle,
        parentEndpoint: "genesis",
        operationId: input.operationId,
        sourceFingerprint,
      };
      await writeJson(join(stagingRoot, publicationFile), publication);
      await updateWorldActivity(
        stagingRoot,
        "genesis",
        [openingMessage],
        Date.now(),
      );
      await rename(stagingRoot, finalRoot);
      return {
        outcome: "created",
        world: await this.#currentSummary(publication),
        preview,
      };
    } catch (error: unknown) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      const recovered = await this.#readPublication(input.operationId);
      if (recovered !== null) {
        if (
          recovered.sourceFingerprint === sourceFingerprint ||
          recovered.sourceFingerprint === legacySourceFingerprint
        ) {
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
    const [state, control] = await Promise.all([
      this.recoverEndpoint(worldId, head).then(({ state }) => state),
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
    return (await new WorldLedgerAuthority(root).readHead()).head;
  }

  async withArchiveExport<T>(
    worldId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    assertIdentity(worldId, "World ID");
    if (
      (this.#activeControlUsers.get(worldId)?.size ?? 0) > 0 ||
      this.#archiveExports.has(worldId) ||
      this.#openingWorldRevisions.has(worldId)
    )
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "Wait for the current generation or world operation before exporting a backup",
      );
    this.#archiveExports.add(worldId);
    try {
      if (await this.readWorldRevisionLock(worldId))
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "Please apply or discard the world revision before exporting a backup",
        );
      return await action();
    } finally {
      this.#archiveExports.delete(worldId);
    }
  }

  async archiveNeedsFreshContext(worldId: string): Promise<boolean> {
    assertIdentity(worldId, "World ID");
    return (
      (await readOptionalJson(
        join(this.#worldsRoot, worldId, "runtime", "archive-import.json"),
      )) !== null ||
      (await this.playTimeline.currentContextRequiresFreshContext(worldId))
    );
  }

  async completeArchiveFreshContext(worldId: string): Promise<void> {
    assertIdentity(worldId, "World ID");
    await rm(
      join(this.#worldsRoot, worldId, "runtime", "archive-import.json"),
      { force: true },
    );
  }

  async currentHeadOperationId(worldId: string): Promise<string | null> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return new WorldLedgerAuthority(root).currentOperationId();
  }

  async saveControlDraft(
    worldId: string,
    files: readonly ContentTreeFile[],
  ): Promise<{ fingerprint: string }> {
    assertIdentity(worldId, "World ID");
    for (const file of files) assertRelativePath(file.path);
    try {
      return await this.operations.withExclusiveWorldStateMutation(
        worldId,
        async () => {
          await this.ensureCurrentStorage(worldId);
          const root = join(this.#worldsRoot, worldId);
          await readPublicationAt(root);
          assertControlGameplayUnchanged(
            await readTree(join(root, "control")),
            files,
          );
          const staging = join(root, `runtime/.control-draft-${randomUUID()}`);
          await writeSurface(staging, "control", files);
          const final = join(root, "runtime/control-draft");
          await rm(final, { recursive: true, force: true });
          await rename(join(staging, "control"), final);
          await rm(staging, { recursive: true, force: true });
          return { fingerprint: fingerprint(files) };
        },
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World control drafts are locked while a world revision is open",
        );
      throw error;
    }
  }

  async acquireWorldRevisionLock(worldId: string, epochId: string) {
    if (
      (this.#activeControlUsers.get(worldId)?.size ?? 0) > 0 ||
      this.#openingWorldRevisions.has(worldId) ||
      this.#archiveExports.has(worldId)
    )
      return { kind: "busy" } as const;
    this.#openingWorldRevisions.add(worldId);
    try {
      return await this.operations.acquireWorldRevision(worldId, epochId);
    } finally {
      this.#openingWorldRevisions.delete(worldId);
    }
  }

  readWorldRevisionLock(worldId: string) {
    return this.operations.readWorldRevisionLock(worldId);
  }

  releaseWorldRevisionLock(handle: WorldRevisionLockHandle): Promise<void> {
    return this.operations.releaseWorldRevision(handle);
  }

  async assertWorldRevisionUnlocked(worldId: string): Promise<void> {
    try {
      await this.operations.assertWorldRevisionUnlocked(worldId);
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World play and other changes are locked while a world revision is open",
        );
      throw error;
    }
  }

  async bindWorldRevision(
    handle: WorldRevisionLockHandle,
  ): Promise<FileNativePlayBinding> {
    return this.operations.withWorldRevisionLock(handle, () =>
      this.bindPlayCallChain(handle.worldId),
    );
  }

  /** Replace control while the matching revision epoch retains exclusive ownership. */
  async replaceWorldRevisionControl(input: {
    handle: WorldRevisionLockHandle;
    expectedFingerprint: string;
    files: readonly ContentTreeFile[];
  }): Promise<{ fingerprint: string }> {
    for (const file of input.files) assertRelativePath(file.path);
    return this.operations.withWorldRevisionLock(input.handle, async () => {
      if ((this.#activeControlUsers.get(input.handle.worldId)?.size ?? 0) > 0)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World control is frozen by another operation",
        );
      const root = join(this.#worldsRoot, input.handle.worldId);
      const currentPath = join(root, "control");
      const runtimeRoot = join(root, "runtime");
      const stagingRoot = join(
        runtimeRoot,
        `.revision-control-${input.handle.epochId}-next`,
      );
      const stagedPath = join(stagingRoot, "control");
      const previousPath = join(
        runtimeRoot,
        `.revision-control-${input.handle.epochId}-previous`,
      );
      let current = await readTree(currentPath);
      let currentFingerprint = fingerprint(current);
      const nextFingerprint = fingerprint(input.files);
      if (currentFingerprint === nextFingerprint) {
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(previousPath, { recursive: true, force: true });
        return { fingerprint: nextFingerprint };
      }
      const previous = await readTree(previousPath);
      const staged = await readTree(stagedPath);
      if (
        current.length === 0 &&
        fingerprint(previous) === input.expectedFingerprint
      ) {
        if (fingerprint(staged) === nextFingerprint) {
          await rename(stagedPath, currentPath);
          await rm(previousPath, { recursive: true, force: true });
          await rm(stagingRoot, { recursive: true, force: true });
          return { fingerprint: nextFingerprint };
        }
        await rename(previousPath, currentPath);
        current = await readTree(currentPath);
        currentFingerprint = fingerprint(current);
      }
      if (currentFingerprint !== input.expectedFingerprint)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World control changed after this revision epoch opened",
        );
      assertControlGameplayUnchanged(current, input.files);
      await rm(stagingRoot, { recursive: true, force: true });
      await rm(previousPath, { recursive: true, force: true });
      await writeSurface(stagingRoot, "control", input.files);
      await rename(currentPath, previousPath);
      await rename(stagedPath, currentPath);
      await rm(previousPath, { recursive: true, force: true });
      await rm(stagingRoot, { recursive: true, force: true });
      return { fingerprint: nextFingerprint };
    });
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
          assertControlGameplayUnchanged(
            await readTree(join(root, "control")),
            await readTree(join(root, "runtime/control-draft")),
          );
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
    if (this.#archiveExports.has(worldId))
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "A world backup is being exported; wait for it to finish",
      );
    if (this.#openingWorldRevisions.has(worldId))
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "World control is locked while a world revision opens",
      );
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
        const recovered = await new WorldLedgerAuthority(root).recover();
        const control = await readTree(join(root, "control"));
        return {
          worldId,
          parentHead: recovered.head,
          files: [...recovered.state, ...control].reduce<
            Record<string, string>
          >((files, { path, contents }, index) => {
            files[
              `${index < recovered.state.length ? "state" : "control"}/${path}`
            ] = contents;
            return files;
          }, {}),
          additionalMaterials: recovered.additionalMaterials,
          history: Object.fromEntries(
            recovered.history.map(({ messageId, exactText }) => [
              messageId,
              exactText,
            ]),
          ),
          historyBackgrounds: historyBackgroundRecord(recovered.history),
          narrativeCheckpoint: recovered.narrativeCheckpoint,
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

  /**
   * Bind an immutable historical endpoint with the world's current control
   * surface. This is the same semantic input as a fresh context started while
   * that endpoint was current, without rewinding today's head.
   */
  async bindPlayCallChainAt(
    worldId: string,
    head: string,
  ): Promise<FileNativePlayBinding> {
    assertIdentity(worldId, "World ID");
    const [endpoint, control] = await Promise.all([
      this.recoverEndpoint(worldId, head),
      this.readSurface(worldId, "control"),
    ]);
    return {
      worldId,
      parentHead: endpoint.head,
      files: [...endpoint.state, ...control].reduce<Record<string, string>>(
        (files, { path, contents }, index) => {
          files[
            `${index < endpoint.state.length ? "state" : "control"}/${path}`
          ] = contents;
          return files;
        },
        {},
      ),
      additionalMaterials: structuredClone(endpoint.additionalMaterials),
      narrativeCheckpoint: endpoint.narrativeCheckpoint,
      historyBackgrounds: historyBackgroundRecord(endpoint.history),
      history: Object.fromEntries(
        endpoint.history.map(({ messageId, exactText }) => [
          messageId,
          exactText,
        ]),
      ),
    };
  }

  reserveOperation(operationId: string): Promise<boolean> {
    assertIdentity(operationId, "operation ID");
    if (this.#operationOutcomes.has(operationId)) return Promise.resolve(false);
    this.#operationOutcomes.set(operationId, { phase: "in_progress" });
    return Promise.resolve(true);
  }

  releaseOperationReservation(operationId: string): Promise<void> {
    assertIdentity(operationId, "operation ID");
    if (this.#operationOutcomes.get(operationId)?.phase === "in_progress")
      this.#operationOutcomes.delete(operationId);
    return Promise.resolve();
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
      const recovered = await new WorldLedgerAuthority(root).recover(head);
      return {
        worldId,
        head: recovered.head,
        state: recovered.state,
        history: recovered.history,
        additionalMaterials: recovered.additionalMaterials,
        narrativeCheckpoint: recovered.narrativeCheckpoint,
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

  async deriveWorld(input: FileNativeWorldDerivationInput): Promise<{
    outcome: "derived";
    world: FileNativeWorldSummary;
    worldRoot: string;
  }> {
    assertIdentity(input.operationId, "Fork operation ID");
    assertIdentity(input.sourceWorldId, "Source world ID");
    assertIdentity(input.hostPresetId, "Host-preset ID");
    if (input.requestDiscriminator !== undefined)
      assertIdentity(input.requestDiscriminator, "Fork request discriminator");
    if (
      input.sourceHead !== "genesis" &&
      input.sourceHead !== "current" &&
      !/^commit:[1-9][0-9]*$/u.test(input.sourceHead)
    )
      throw new TypeError("Source endpoint is invalid");
    if (input.targetName !== undefined && !validWorldName(input.targetName))
      throw new TypeError("Target world name is invalid");
    if (input.publish === false && input.targetWorldRoot === undefined)
      throw new TypeError("An unpublished closure requires a target directory");
    const target =
      input.targetDataRoot === undefined
        ? this
        : new FileNativeWorldStore(input.targetDataRoot);
    const requestFingerprint = derivationRequestFingerprint(input);
    const worldId = `world-${operationDigest(`${input.identityPrefix ?? "derive"}:${input.operationId}`).slice(0, 24)}`;
    const finalRoot =
      input.publish === false
        ? resolve(input.targetWorldRoot!)
        : join(target.#worldsRoot, worldId);
    const alreadyPublished = await readOptionalJson<Publication>(
      join(finalRoot, publicationFile),
    );
    if (alreadyPublished !== null) {
      if (input.publish !== false)
        await target.ensureCurrentStorage(alreadyPublished.worldId);
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
      return {
        outcome: "derived",
        world: await readWorldSummaryAt(finalRoot, alreadyPublished),
        worldRoot: finalRoot,
      };
    }

    await this.ensureCurrentStorage(input.sourceWorldId);
    const retainSourceSnapshot = async (): Promise<{
      outcome: "derived";
      world: FileNativeWorldSummary;
      worldRoot: string;
    }> => {
      const sourceRoot = join(this.#worldsRoot, input.sourceWorldId);
      const sourcePublication = await readPublicationAt(sourceRoot);
      const sourceSummary = await readWorldSummaryAt(
        sourceRoot,
        sourcePublication,
      );
      const sourceAuthority = new WorldLedgerAuthority(sourceRoot);
      const sourceHead =
        input.sourceHead === "current"
          ? (await sourceAuthority.readHead()).head
          : input.sourceHead;
      const [sourceGenesis, control] = await Promise.all([
        readGenesisForFork(sourceRoot, input.sourceWorldId),
        readTree(join(sourceRoot, "control")),
      ]);
      const staging = join(
        dirname(finalRoot),
        `.staging-${worldId}-${randomUUID()}`,
      );
      await mkdir(dirname(finalRoot), { recursive: true, mode: 0o700 });
      try {
        await copyForkClosure(sourceRoot, staging);
        await rewindTo(staging, headPosition(sourceHead));
        // 分叉不信任来源的投影文件：当前文件由副本上的账本端点重建。
        await new WorldLedgerAuthority(staging).materializeCurrentFiles();
        const selected = await new WorldLedgerAuthority(staging).recover();
        await PackageScriptPermissions.write(
          staging,
          input.resetPackageScriptPermissions
            ? []
            : await PackageScriptPermissions.read(sourceRoot),
        );
        await WorldExtensionControls.copy(sourceRoot, staging);
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
        await input.stageTarget?.({
          sourceHead,
          targetWorldRoot: staging,
          targetWorldId: worldId,
          binding: {
            worldId,
            parentHead: sourceHead,
            files: [...selected.state, ...control].reduce<
              Record<string, string>
            >((files, { path, contents }, index) => {
              files[
                `${index < selected.state.length ? "state" : "control"}/${path}`
              ] = contents;
              return files;
            }, {}),
            additionalMaterials: structuredClone(selected.additionalMaterials),
            historyBackgrounds: historyBackgroundRecord(selected.history),
            history: Object.fromEntries(
              selected.history.map(({ messageId, exactText }) => [
                messageId,
                exactText,
              ]),
            ),
          },
        });
        if (
          input.identityPrefix === "import" ||
          (await this.archiveNeedsFreshContext(input.sourceWorldId))
        )
          await writeJson(join(staging, "runtime", "archive-import.json"), {
            schemaVersion: 1,
          });
        const publication: Publication = {
          schemaVersion: 1,
          worldId,
          title: input.targetName ?? derivedWorldName(sourceSummary.title),
          parentEndpoint: "genesis",
          operationId: input.operationId,
          sourceFingerprint: requestFingerprint,
        };
        await writeJson(join(staging, publicationFile), publication);
        await updateWorldActivity(
          staging,
          sourceHead,
          selected.history,
          Date.now(),
        );
        await rename(staging, finalRoot);
        return {
          outcome: "derived",
          world: await readWorldSummaryAt(finalRoot, publication),
          worldRoot: finalRoot,
        };
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
          return {
            outcome: "derived",
            world: await readWorldSummaryAt(finalRoot, published),
            worldRoot: finalRoot,
          };
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

  async getOperationOutcome(
    operationId: string,
  ): Promise<FileNativeOperationOutcome> {
    assertIdentity(operationId, "operation ID");
    const entry = this.#operationOutcomes.get(operationId);
    if (entry === undefined) return { outcome: "not_started" };
    if (entry.phase === "in_progress") return { outcome: "in_progress" };
    const outcome = structuredClone(entry.outcome);
    await assertCommittedAuthorityOutcomeMatches(
      join(this.#worldsRoot, outcome.worldId),
      outcome,
    );
    return outcome;
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
  }): Promise<Extract<FileNativeOperationOutcome, { outcome: "committed" }>> {
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
    await this.ensureCurrentStorage(input.worldId);

    try {
      return await this.operations.withExclusiveWorldStateMutation(
        input.worldId,
        () => this.#reviseTimelineUnlocked(input),
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "Timeline editing is locked while a world revision is open",
        );
      throw error;
    }
  }

  async #reviseTimelineUnlocked(input: {
    operationId: string;
    worldId: string;
    expectedCurrentHead: string;
    restoresHead: string;
    replacesHead: string;
    replacementText: string;
  }): Promise<Extract<FileNativeOperationOutcome, { outcome: "committed" }>> {
    const existing = await this.getOperationOutcome(input.operationId);
    if (isCommittedOutcome(existing)) {
      if (
        existing.worldId !== input.worldId ||
        !isDeepStrictEqual(
          existing.historyAppend.map(({ role, exactText }) => ({
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
    const authorityStore = new WorldLedgerAuthority(root);
    const current = await authorityStore.readHead();
    if (current.head !== input.expectedCurrentHead)
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "The parent endpoint of the timeline revision has changed",
      );
    const replaced = await authorityStore.commitAt(input.replacesHead);
    if (
      replaced === null ||
      !replaced.historyAppend.some(({ role }) => role === "player") ||
      replaced.parentHead !== input.restoresHead
    )
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "Selected player message does not match the logical parent endpoint to restore",
      );

    const replacementMaterials = await authorityStore.recoverMaterials(
      input.restoresHead,
    );
    const binding = await this.bindPlayCallChainAt(
      input.worldId,
      input.restoresHead,
    );
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: Object.entries(binding.files).map(([path, contents]) => ({
        path,
        contents,
      })),
    });
    const background = snapshotBackground(
      captureNarrativeOrigin(snapshot, 1).value,
    );
    // ADR-0045: 回退到被替换消息的逻辑父端点，再作为一次普通游玩提交追加修改稿。
    await rewindTo(root, headPosition(input.restoresHead));
    return this.#commitHistoryChange({
      operationId: input.operationId,
      worldId: input.worldId,
      parentHead: input.restoresHead,
      historyAppend: [
        {
          role: "player",
          exactText: input.replacementText,
          ...backgroundField(background),
        },
      ],
      nextMaterials: worldNeutralMaterials(input.worldId, replacementMaterials),
      stateChanges: [],
      mode: "play",
    });
  }

  async commitCorrection(input: {
    worldClock?: string;
    operationId: string;
    worldId: string;
    parentHead: string;
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    stateOperationClaim?: ContinuityCorrectionWorldClaimHandle;
    worldRevisionLock?: WorldRevisionLockHandle;
    validationControl?: readonly ContentTreeFile[];
  }): Promise<Extract<FileNativeOperationOutcome, { outcome: "committed" }>> {
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
          ...(input.worldClock === undefined
            ? {}
            : { worldClock: input.worldClock }),
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
          ...(input.validationControl === undefined
            ? {}
            : { validationControl: input.validationControl }),
        });
      };
      if (
        input.stateOperationClaim !== undefined &&
        input.worldRevisionLock !== undefined
      )
        throw new TypeError(
          "A correction cannot use two world-operation claims",
        );
      if (input.worldRevisionLock !== undefined)
        return await this.operations.withWorldRevisionLock(
          input.worldRevisionLock,
          commit,
        );
      if (input.stateOperationClaim !== undefined)
        return await this.operations.withCorrectionWorldClaim(
          input.stateOperationClaim,
          commit,
        );
      return await this.operations.withExclusiveWorldStateMutation(
        input.worldId,
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
    playContext?: string;
    worldClock?: string;
    operationId: string;
    worldId: string;
    parentHead: string;
    historyAppend: {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    narrativeCheckpoint?: NarrativeCheckpointDeclaration;
  }): Promise<Extract<FileNativeOperationOutcome, { outcome: "committed" }>> {
    await this.ensureCurrentStorage(input.worldId);
    if (input.historyAppend.length === 0 && input.stateChanges.length === 0)
      throw new TypeError(
        "A call-chain commit cannot omit both narrative and state changes",
      );
    try {
      return await this.operations.withExclusiveWorldStateMutation(
        input.worldId,
        () =>
          this.#commitHistoryChange({
            ...input,
            nextMaterials: worldNeutralMaterials(
              input.worldId,
              input.nextMaterials,
            ),
            mode: "play",
          }),
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "Play is locked while a world revision is open",
        );
      throw error;
    }
  }

  async #commitHistoryChange(input: {
    playContext?: string;
    worldClock?: string;
    operationId: string;
    worldId: string;
    parentHead: string;
    historyAppend: {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    narrativeCheckpoint?: NarrativeCheckpointDeclaration;
    mode: "play" | "correction";
    operationReserved?: boolean;
    validationControl?: readonly ContentTreeFile[];
  }): Promise<CommittedOperationOutcome> {
    const existing = this.#operationOutcomes.get(input.operationId);
    if (existing?.phase === "done") {
      const outcome = existing.outcome;
      assertSameOperationOutcome(outcome, input);
      const fact = await new WorldLedgerAuthority(
        join(this.#worldsRoot, outcome.worldId),
      ).authorityFactAt(outcome.head);
      if (
        fact.digest !== outcome.commitDigest ||
        !authorityCommitMatchesInput(fact.commit, input)
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "The same play operation ID is bound to a different complete commit payload",
        );
      return outcome;
    }
    if (existing?.phase === "in_progress" && input.operationReserved !== true)
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "The same play operation ID is occupied by another durable operation",
      );
    const root = join(this.#worldsRoot, input.worldId);
    try {
      return await this.operations.withWorldAuthorityLock(
        input.worldId,
        async () => {
          const concurrent = this.#operationOutcomes.get(input.operationId);
          if (concurrent?.phase === "done") {
            const outcome = concurrent.outcome;
            assertSameOperationOutcome(outcome, input);
            const known = await new WorldLedgerAuthority(
              join(this.#worldsRoot, outcome.worldId),
            ).authorityFactAt(outcome.head);
            if (
              known.digest !== outcome.commitDigest ||
              !authorityCommitMatchesInput(known.commit, input)
            )
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                "The same play operation ID is bound to a different complete commit payload",
              );
            return outcome;
          }
          if (
            concurrent?.phase === "in_progress" &&
            input.operationReserved !== true
          )
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The same play operation ID is occupied by another durable operation",
            );
          const authorityStore = new WorldLedgerAuthority(root);
          const authority = await authorityStore.readHead();
          if (authority.head !== input.parentHead)
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "The parent endpoint of the play operation has changed",
            );
          const [basisState, storedControl] = await Promise.all([
            authorityStore.recoverState(authority.head),
            readTree(join(root, "control")),
          ]);
          const candidateState = new Map(
            basisState.map((file) => [file.path, file.contents]),
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
            candidateState.set(change.relativePath, change.canonicalNextBytes);
          }
          const inspection = inspectContentPackageCurrentTree(
            [
              ...[...candidateState].map(([path, contents]) => ({
                path: `world/${path}`,
                contents,
              })),
              ...(input.validationControl ?? storedControl).map(
                ({ path, contents }) => ({
                  path: `control/${path}`,
                  contents,
                }),
              ),
            ],
            { requireOpening: false },
          );
          if (inspection.status !== "usable")
            throw new FileNativeWorldCreationError(
              "candidate_validation_failed",
              `Candidate world failed mechanical validation: ${inspection.issues.map(({ message }) => message).join("; ")}`,
            );
          const { commit, commitDigest } = await authorityStore.appendCommit({
            ...(input.playContext === undefined
              ? {}
              : { playContext: input.playContext }),
            ...(input.worldClock === undefined
              ? {}
              : { worldClock: input.worldClock }),
            operationId: input.operationId,
            parentHead: input.parentHead,
            mode: input.mode,
            historyAppend: input.historyAppend,
            stateChanges: input.stateChanges,
            nextMaterials: input.nextMaterials,
            ...(input.narrativeCheckpoint === undefined
              ? {}
              : { narrativeCheckpoint: input.narrativeCheckpoint }),
            ...(input.mode === "correction"
              ? {
                  correctionTargets: input.stateChanges.map(
                    ({ documentId }) => documentId,
                  ),
                  corrects: input.parentHead,
                }
              : {}),
          });
          const outcome: CommittedOperationOutcome = {
            outcome: "committed",
            worldId: input.worldId,
            parentHead: input.parentHead,
            head: commit.head,
            commitDigest,
            historyAppend: structuredClone(input.historyAppend),
            nextAdditionalMaterials: structuredClone(input.nextMaterials),
            mode: input.mode,
          };
          this.#operationOutcomes.set(input.operationId, {
            phase: "done",
            outcome,
          });
          const recovered = await authorityStore.recover(commit.head);
          await updateWorldActivity(
            root,
            commit.head,
            recovered.history,
            Date.now(),
          );
          return outcome;
        },
      );
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "World Authority commit is being serialized by another process",
        );
      if (error instanceof WorldAuthorityError)
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
  ): Promise<{ head: string; commits: WorldTurnCommit[] }> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const authority = await new WorldLedgerAuthority(root).readHistory();
    return structuredClone(authority);
  }

  async inspectDocumentMaintenance(
    worldId: string,
    head?: string,
  ): Promise<{
    documentMaintenance: Record<string, WorldDocumentMaintenance>;
    documentMaintenanceUnavailableReason?: string;
  }> {
    try {
      return {
        documentMaintenance: await this.readDocumentMaintenance(worldId, head),
      };
    } catch (error: unknown) {
      return {
        documentMaintenance: {},
        documentMaintenanceUnavailableReason:
          error instanceof Error
            ? error.message
            : "Document diagnostics unavailable",
      };
    }
  }

  async readDocumentMaintenance(
    worldId: string,
    head?: string,
  ): Promise<Record<string, WorldDocumentMaintenance>> {
    assertIdentity(worldId, "World ID");
    await this.ensureCurrentStorage(worldId);
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const authority = new WorldLedgerAuthority(root);
    const selectedHead = head ?? (await authority.readHead()).head;
    let cache = this.#documentMaintenanceCache.get(worldId);
    if (cache === undefined) {
      cache = new Map();
      if (this.#documentMaintenanceCache.size >= 8)
        this.#documentMaintenanceCache.delete(
          this.#documentMaintenanceCache.keys().next().value!,
        );
      this.#documentMaintenanceCache.set(worldId, cache);
    }
    return readDocumentMaintenanceFacts(authority, selectedHead, cache);
  }

  async readAuthorityEndpoint(
    worldId: string,
    endpoint: string,
  ): Promise<{
    endpoint: string;
    state: ContentTreeFile[];
    history: {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
    additionalMaterials: MaterialSelection[];
  }> {
    const recovered = await this.recoverEndpoint(worldId, endpoint);
    return {
      endpoint: recovered.head,
      state: recovered.state,
      history: recovered.history.map(({ role, exactText, background }) => ({
        role,
        exactText,
        ...backgroundField(background),
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
    // The world root's own publication record is the only creation receipt.
    const worldId = `world-${operationDigest(operationId).slice(0, 24)}`;
    let publication: Publication;
    try {
      publication = await readPublicationAt(join(this.#worldsRoot, worldId));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (publication.operationId !== operationId) {
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "Deterministic world identity is occupied by another creation operation",
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

function contentPackageCreationFingerprint(
  title: string,
  files: readonly ContentTreeFile[],
): string {
  const hash = createHash("sha256");
  hash
    .update("narraeon.file-native-world-creation/v2")
    .update("\0")
    .update(title)
    .update("\0")
    .update(fingerprint(files));
  return `sha256:${hash.digest("hex")}`;
}

function operationDigest(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
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

function corruptOperationOutcome(): FileNativeWorldCreationError {
  return new FileNativeWorldCreationError(
    "world_corrupt",
    "Authority operation outcome structure or operation identity is invalid",
  );
}

async function assertCommittedAuthorityOutcomeMatches(
  worldRoot: string,
  outcome: Extract<FileNativeOperationOutcome, { outcome: "committed" }>,
): Promise<WorldTurnCommit> {
  const fact = await new WorldLedgerAuthority(worldRoot).authorityFactAt(
    outcome.head,
  );
  const { commit } = fact;
  if (
    fact.digest !== outcome.commitDigest ||
    commit.parentHead !== outcome.parentHead ||
    commit.head !== outcome.head ||
    commit.mode !== outcome.mode ||
    !isDeepStrictEqual(
      commit.historyAppend.map(({ role, exactText, background }) => ({
        role,
        exactText,
        ...backgroundField(background),
      })),
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
  }
}

async function publishText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
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
    await rename(temporary, path);
  }
}

function isCommittedOutcome(
  outcome: FileNativeOperationOutcome,
): outcome is Extract<FileNativeOperationOutcome, { outcome: "committed" }> {
  return outcome.outcome === "committed";
}

function assertSameOperationOutcome(
  outcome: Extract<FileNativeOperationOutcome, { outcome: "committed" }>,
  input: {
    worldId: string;
    parentHead: string;
    historyAppend: {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
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
  commit: WorldTurnCommit,
  input: {
    playContext?: string;
    worldClock?: string;
    parentHead: string;
    historyAppend: {
      role: "player" | "narrator";
      exactText: string;
      background?: HistoryBackground;
    }[];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
    mode: "play" | "correction";
    narrativeCheckpoint?: NarrativeCheckpointDeclaration;
  },
): boolean {
  const stateChangesMatch =
    commit.stateChanges.length === input.stateChanges.length &&
    commit.stateChanges.every((stored, index) => {
      const candidate = input.stateChanges[index];
      if (candidate === undefined) return false;
      return isDeepStrictEqual(stored, {
        kind: candidate.kind,
        documentId: candidate.documentId,
        stableShortRef: candidate.stableShortRef,
        relativePath: candidate.relativePath,
        codec: candidate.codec,
        expectedPreviousHash: candidate.expectedPreviousHash,
        nextHash: candidate.nextHash,
      });
    });
  const expectedCorrection =
    input.mode === "correction"
      ? input.stateChanges.map(({ documentId }) => documentId)
      : undefined;
  return (
    commit.mode === input.mode &&
    commit.playContext === input.playContext &&
    commit.worldClock === input.worldClock &&
    commit.parentHead === input.parentHead &&
    isDeepStrictEqual(
      commit.historyAppend.map(({ role, exactText, background }) => ({
        role,
        exactText,
        ...backgroundField(background),
      })),
      input.historyAppend,
    ) &&
    stateChangesMatch &&
    isDeepStrictEqual(commit.nextAdditionalMaterials, input.nextMaterials) &&
    isDeepStrictEqual(commit.narrativeCheckpoint, input.narrativeCheckpoint) &&
    isDeepStrictEqual(commit.correctionTargets, expectedCorrection) &&
    commit.corrects ===
      (input.mode === "correction" ? input.parentHead : undefined)
  );
}

function headPosition(head: string): number {
  if (head === "genesis") return 0;
  const match = /^commit:([1-9][0-9]*)$/u.exec(head);
  if (match === null) throw new TypeError(`Endpoint is invalid: ${head}`);
  return Number.parseInt(match[1]!, 10);
}

// 分叉只复制一个世界的闭包；回退与身份重分配由调用方在副本上完成。
const forkClosureEntries = [
  "state",
  "control",
  "history",
  join("runtime", "head.json"),
  join("runtime", "turns"),
  join("runtime", "history-backgrounds"),
  join("runtime", "additional-materials.json"),
  join("runtime", "genesis.json"),
  join("runtime", "play-genesis-timeline.json"),
];

async function copyForkClosure(
  sourceRoot: string,
  target: string,
): Promise<void> {
  await mkdir(join(target, "runtime"), { recursive: true, mode: 0o700 });
  for (const entry of forkClosureEntries) {
    const source = join(sourceRoot, entry);
    try {
      await stat(source);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    await mkdir(dirname(join(target, entry)), { recursive: true, mode: 0o700 });
    await cp(source, join(target, entry), { recursive: true });
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
}

async function publishJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
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
      !hasRequiredAndOptionalKeys(
        message,
        ["messageId", "role", "exactText"],
        ["background"],
      ) ||
      (message.background !== undefined &&
        !isHistoryBackground(message.background)) ||
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
      ...backgroundField(message.background),
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
  serializeRebuild?: (
    rebuild: () => Promise<WorldActivity>,
  ) => Promise<WorldActivity>,
): Promise<FileNativeWorldSummary> {
  const published = publication ?? (await readPublicationAt(root));
  const gameplay = await readWorldGameplayAt(root);
  const { lastActivityAt, excerpt, playerTurns } = await readWorldActivity(
    root,
    serializeRebuild,
  );
  const summary = {
    ...toSummary(published, gameplay),
    title: await readWorldTitleAt(root, published),
    lastActivityAt,
    excerpt,
    playerTurns,
  };
  return summary;
}

async function readWorldTitleAt(
  root: string,
  published: Publication,
): Promise<string> {
  const metadata = await readOptionalJson<unknown>(
    join(root, localMetadataFile),
  );
  if (metadata === null) return published.title;
  if (!isWorldLocalMetadata(metadata) || metadata.worldId !== published.worldId)
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "Local world shell is corrupt",
    );
  return metadata.name;
}

/** Worlds copy the package's gameplay identity with control; its absence means interactive fiction. */
async function readWorldGameplayAt(root: string): Promise<Gameplay> {
  try {
    return readGameplay(
      controlGameplayFiles(await readTree(join(root, "control"))),
    );
  } catch (error: unknown) {
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "World gameplay identity is corrupt",
      { cause: error },
    );
  }
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

function toSummary(
  publication: Publication,
  gameplay: Gameplay,
): Pick<
  FileNativeWorldSummary,
  "worldId" | "title" | "parentEndpoint" | "gameplay"
> {
  return {
    worldId: publication.worldId,
    title: publication.title,
    parentEndpoint: publication.parentEndpoint,
    gameplay,
  };
}

/** World control is a fixed mode and scheme: drafts, revisions and applies may not change either. */
function assertControlGameplayUnchanged(
  current: readonly ContentTreeFile[],
  next: readonly ContentTreeFile[],
): void {
  try {
    assertSameGameplay(
      controlGameplayFiles(current),
      controlGameplayFiles(next),
    );
  } catch (error: unknown) {
    throw new FileNativeWorldCreationError(
      "candidate_validation_failed",
      error instanceof Error ? error.message : "World gameplay is fixed",
      { cause: error },
    );
  }
}

function controlGameplayFiles(
  files: readonly ContentTreeFile[],
): ContentTreeFile[] {
  return files.map((file) => ({ ...file, path: `control/${file.path}` }));
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
      ...(input.retainCompleteTimeline ? { retainCompleteTimeline: true } : {}),
      ...(input.targetName === undefined &&
      input.identityPrefix === undefined &&
      !input.resetPackageScriptPermissions
        ? {}
        : {
            targetName: input.targetName ?? null,
            identityPrefix: input.identityPrefix ?? "derive",
            resetPackageScriptPermissions:
              input.resetPackageScriptPermissions ?? false,
          }),
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

import type {
  NarrativeCheckpoint,
  NarrativeCheckpointDeclaration,
} from "../play/PlayContinuity.ts";
import type { WorldDocumentMaintenance } from "../../protocol/worldMaintenance.ts";
import {
  readDocumentMaintenanceFacts,
  type DocumentMaintenanceState,
} from "./WorldDocumentMaintenance.ts";

function backgroundField(background: HistoryBackground | undefined): {
  background?: HistoryBackground;
} {
  return background === undefined ? {} : { background };
}
