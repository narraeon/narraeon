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
import {
  FileNativeWorldOperationCoordinator,
  WorldOperationBusyError,
  type ContinuityCorrectionWorldClaimHandle,
} from "./WorldOperationCoordinator.ts";

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
    super("世界不存在", options);
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

export interface FileNativePlayCommit {
  schemaVersion: 1;
  operationId: string;
  parentHead: string;
  head: string;
  mode: "play" | "correction";
  historyAppend: {
    messageId: string;
    role: "player" | "narrator";
    exactText: string;
  }[];
  stateChanges: FileNativeStateChange[];
  nextAdditionalMaterials: MaterialSelection[];
  correctionTargets?: string[];
  corrects?: string;
}

interface FileNativePlayAuthority {
  schemaVersion: 1;
  head: string;
  commits: FileNativePlayCommit[];
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
      historyAppend: { role: "player" | "narrator"; exactText: string }[];
      nextAdditionalMaterials: MaterialSelection[];
      mode: "play" | "correction";
    };

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

export class FileNativeWorldStore {
  readonly #worldsRoot: string;
  readonly #operationsRoot: string;
  readonly #promptCompiler: FileNativePromptCompiler;
  readonly #activeControlUsers = new Map<string, Set<string>>();
  readonly operations: FileNativeWorldOperationCoordinator;

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
    assertIdentity(worldId, "世界 ID");
    const trimmed = name.trim();
    if (!validWorldName(trimmed))
      throw new TypeError("世界名称必须是 1 到 160 个字符，且不含换行");
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
    assertIdentity(worldId, "世界 ID");
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
    assertIdentity(input.sourcePackageId, "内容包本地身份");
    const inspection = inspectContentPackageCurrentTree(input.packageFiles);
    if (inspection.status !== "usable") {
      throw new FileNativeWorldCreationError(
        "content_package_needs_repair",
        `只有校验完整通过的内容包可以创建世界：${inspection.issues
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
          "同一 operation ID 已绑定另一份创建载荷",
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
      await writeJson(join(stagingRoot, "runtime", "materialized-head.json"), {
        head: "genesis",
      });
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
          "同一 operation ID 已绑定另一份创建载荷",
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
    assertIdentity(worldId, "世界 ID");
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
    const endpoint = await this.recoverEndpoint(worldId, head);
    const control = await this.readSurface(worldId, "control");
    const source = control.find(({ path }) => path === "player-views.yaml");
    return new PlayerViewRenderer().render({
      snapshot: openWorldDocumentSnapshot(endpoint.state),
      control: source?.contents ?? "",
    });
  }

  async currentHead(worldId: string): Promise<string> {
    assertIdentity(worldId, "世界 ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return (await readAcceptedAuthority(root))?.head ?? "genesis";
  }

  async currentHeadOperationId(worldId: string): Promise<string | null> {
    assertIdentity(worldId, "世界 ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    return (
      (await readAcceptedAuthority(root))?.commits.at(-1)?.operationId ?? null
    );
  }

  async saveControlDraft(
    worldId: string,
    files: readonly ContentTreeFile[],
  ): Promise<{ fingerprint: string }> {
    assertIdentity(worldId, "世界 ID");
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
        `控制草稿中的玩家视图无法应用：${rendered.diagnostics.map(({ message }) => message).join("；")}`,
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
      playerInput: prompt.playerInput ?? "预览世界控制。",
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
              "该世界控制已被运行中的 attempt 冻结",
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
          "该世界控制已被运行中的游玩调用链冻结",
        );
      throw error;
    }
  }

  freezeControl(worldId: string, operationId: string): void {
    assertIdentity(worldId, "世界 ID");
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
    assertIdentity(worldId, "世界 ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const [state, draft] = await Promise.all([
      readTree(join(root, "state")),
      readTree(join(root, "runtime/control-draft")),
    ]);
    if (draft.length === 0)
      throw new FileNativeWorldCreationError(
        "content_package_needs_repair",
        "尚未保存世界控制草稿",
      );
    return { state, draft };
  }

  /** Bind the current Authority endpoint for a model-directed play call chain. */
  async bindPlayCallChain(worldId: string): Promise<FileNativePlayBinding> {
    assertIdentity(worldId, "世界 ID");
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
            ? "世界 publication 缺失"
            : "世界存储根不是目录",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return await this.operations.withWorldAuthorityLock(worldId, async () => {
        const publishedAuthority = await readAcceptedAuthority(root);
        if (publishedAuthority !== null) {
          const materialized = await readOptionalJson<{ head: string }>(
            join(root, "runtime", "materialized-head.json"),
          );
          let materializedIndex = 0;
          if (materialized !== null && materialized.head !== "genesis") {
            const found = publishedAuthority.commits.findIndex(
              ({ head }) => head === materialized.head,
            );
            if (found < 0)
              throw new FileNativeWorldCreationError(
                "world_corrupt",
                "世界 materialized head 不属于权威提交链",
              );
            materializedIndex = found + 1;
          }
          for (
            let index = materializedIndex;
            index < publishedAuthority.commits.length;
            index += 1
          ) {
            const commit = publishedAuthority.commits[index]!;
            await materializePlayCommit(root, index + 1, {
              historyAppend: commit.historyAppend,
              nextMaterials: commit.nextAdditionalMaterials,
              stateChanges: commit.stateChanges ?? [],
            });
            await publishJson(this.#operationOutcomePath(commit.operationId), {
              outcome: "committed",
              worldId,
              parentHead: commit.parentHead,
              head: commit.head,
              historyAppend: commit.historyAppend.map(
                ({ role, exactText }) => ({ role, exactText }),
              ),
              nextAdditionalMaterials: commit.nextAdditionalMaterials,
              mode: commit.mode,
            } satisfies FileNativeOperationOutcome);
          }
          await publishJson(join(root, "runtime", "materialized-head.json"), {
            head: publishedAuthority.head,
          });
        }
        const [state, control, authority, materials, recovered] =
          await Promise.all([
            readTree(join(root, "state")),
            readTree(join(root, "control")),
            readAcceptedAuthority(root),
            readOptionalJson<{ items: MaterialSelection[] }>(
              join(root, "runtime", "additional-materials.json"),
            ),
            this.recoverEndpoint(worldId),
          ]);
        return {
          worldId,
          parentHead: authority?.head ?? "genesis",
          files: [...state, ...control].reduce<Record<string, string>>(
            (files, { path, contents }, index) => {
              files[`${index < state.length ? "state" : "control"}/${path}`] =
                contents;
              return files;
            },
            {},
          ),
          additionalMaterials: materials?.items ?? [],
          history: Object.fromEntries(
            recovered.history.map(({ messageId, exactText }) => [
              messageId,
              exactText,
            ]),
          ),
        };
      });
    } catch (error: unknown) {
      if (error instanceof WorldOperationBusyError)
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "世界 Authority 正在由另一项持久操作更新",
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
        "待释放的 operation reservation 外形无效",
      );
    await rm(path, { force: true });
    await syncDirectory(this.#operationsRoot);
  }

  async recoverEndpoint(
    worldId: string,
    head?: string,
  ): Promise<FileNativeRecoveredEndpoint> {
    assertIdentity(worldId, "世界 ID");
    const root = join(this.#worldsRoot, worldId);
    await readPublicationAt(root);
    const genesis = await readJson<Genesis>(
      join(root, "runtime", "genesis.json"),
    );
    for (const file of [...genesis.state, ...genesis.control])
      if (sha256(file.canonicalBytes) !== file.sha256)
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `genesis 文件 hash 不一致：${file.path}`,
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
        `无法从不可变权威链重建端点：${target}`,
      );
    const state = new Map(
      genesis.state.map((file) => [file.path, file.canonicalBytes]),
    );
    const history: FileNativeRecoveredEndpoint["history"] = structuredClone(
      genesis.history,
    );
    let additionalMaterials: MaterialSelection[] = genesis.additionalMaterials;
    for (const commit of commits.slice(0, end)) {
      for (const change of commit.stateChanges) {
        const existing = state.get(change.relativePath);
        const existingHash = existing === undefined ? null : sha256(existing);
        if (existingHash !== change.expectedPreviousHash)
          throw new FileNativeWorldCreationError(
            "world_corrupt",
            `不可变提交链前置 hash 不一致：${change.relativePath}`,
          );
        if (sha256(change.canonicalNextBytes) !== change.nextHash)
          throw new FileNativeWorldCreationError(
            "world_corrupt",
            `不可变提交链 next hash 不一致：${change.relativePath}`,
          );
        state.set(change.relativePath, change.canonicalNextBytes);
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
    assertIdentity(worldId, "世界 ID");
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
          "该世界已有持久状态 operation，暂不能修复物化",
        );
      throw error;
    }
  }

  async deriveWorld(input: {
    operationId: string;
    sourceWorldId: string;
    sourceHead: string;
    hostPresetId: string;
  }): Promise<{ outcome: "derived"; world: FileNativeWorldSummary }> {
    assertIdentity(input.operationId, "派生 operation ID");
    assertIdentity(input.sourceWorldId, "来源世界 ID");
    assertIdentity(input.hostPresetId, "主持预设 ID");
    if (
      input.sourceHead !== "genesis" &&
      !/^commit:[1-9][0-9]*$/u.test(input.sourceHead)
    )
      throw new TypeError("来源端点无效");
    const operationPath = this.#derivationOperationPath(input.operationId);
    const previous = await readOptionalJson<Publication>(operationPath);
    if (previous !== null) {
      const genesis = await readJson<Genesis>(
        join(this.#worldsRoot, previous.worldId, "runtime", "genesis.json"),
      );
      if (
        genesis.derivedFrom?.worldId !== input.sourceWorldId ||
        genesis.derivedFrom.head !== input.sourceHead ||
        genesis.hostPresetId !== input.hostPresetId
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "同一派生 operation ID 已绑定另一份派生载荷",
        );
      return {
        outcome: "derived",
        world: await this.#currentSummary(previous),
      };
    }
    const sourceRoot = join(this.#worldsRoot, input.sourceWorldId);
    const sourcePublication = await readPublicationAt(sourceRoot);
    const sourceSummary = await readWorldSummaryAt(
      sourceRoot,
      sourcePublication,
    );
    const recovered = await this.recoverEndpoint(
      input.sourceWorldId,
      input.sourceHead,
    );
    const control = await readTree(join(sourceRoot, "control"));
    const worldId = `world-${operationDigest(`derive:${input.operationId}`).slice(0, 24)}`;
    const staging = join(
      this.#worldsRoot,
      `.staging-${worldId}-${randomUUID()}`,
    );
    const finalRoot = join(this.#worldsRoot, worldId);
    await mkdir(this.#worldsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    const messageIds = new Map(
      recovered.history.map(({ messageId }, index) => [
        messageId,
        `${worldId}.message.${index + 1}`,
      ]),
    );
    const rewrittenHistory = recovered.history.map((message) => ({
      ...message,
      messageId: messageIds.get(message.messageId)!,
    }));
    const materials = rewriteMaterials(
      recovered.additionalMaterials,
      messageIds,
      worldId,
    );
    try {
      await writeSurface(staging, "state", recovered.state);
      await writeSurface(staging, "control", control);
      await mkdir(join(staging, "history"), { recursive: true });
      await mkdir(join(staging, "runtime"), { recursive: true });
      for (const [index, message] of rewrittenHistory.entries())
        await writeIdempotentText(
          join(staging, "history", historyFileName(index + 1, message)),
          message.exactText,
        );
      const genesis: Genesis = {
        schemaVersion: 1,
        type: "file_native_genesis",
        worldId,
        operationId: input.operationId,
        parentEndpoint: "genesis",
        state: immutableFiles(recovered.state),
        control: immutableFiles(control),
        history: rewrittenHistory,
        additionalMaterials: materials,
        derivedFrom: { worldId: input.sourceWorldId, head: input.sourceHead },
        hostPresetId: input.hostPresetId,
      };
      await writeJson(join(staging, "runtime", "genesis.json"), genesis);
      await publishJson(join(staging, "runtime", "materialized-head.json"), {
        head: "genesis",
      });
      await publishJson(join(staging, "runtime", "additional-materials.json"), {
        head: "genesis",
        items: materials,
      });
      await publishJson(join(staging, "runtime", "derived-history.json"), {
        messages: rewrittenHistory,
      });
      const publication: Publication = {
        schemaVersion: 1,
        worldId,
        title: derivedWorldName(sourceSummary.title),
        parentEndpoint: "genesis",
        operationId: input.operationId,
        sourceFingerprint: fingerprint([
          ...recovered.state,
          ...control.map((file) => ({ ...file, path: `control/${file.path}` })),
        ]),
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
        const genesis = await readJson<Genesis>(
          join(finalRoot, "runtime", "genesis.json"),
        );
        if (
          genesis.derivedFrom?.worldId !== input.sourceWorldId ||
          genesis.derivedFrom.head !== input.sourceHead ||
          genesis.hostPresetId !== input.hostPresetId
        )
          throw new FileNativeWorldCreationError(
            "operation_conflict",
            "已发布派生世界与 operation 载荷不一致",
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
        "Authority operation outcome 结构无效",
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    const direct =
      directRecord === null ? null : projectOperationOutcome(directRecord);
    if (
      direct?.outcome === "committed" ||
      direct?.outcome === "committed_materialization_pending"
    ) {
      if (direct.outcome === "committed") {
        await assertCommittedAuthorityOutcomeMatches(
          join(this.#worldsRoot, direct.worldId),
          operationId,
          direct,
        );
        const materialized = await readOptionalJson<{ head: string }>(
          join(
            this.#worldsRoot,
            direct.worldId,
            "runtime",
            "materialized-head.json",
          ),
        );
        if (materialized?.head !== direct.head)
          return { ...direct, outcome: "committed_materialization_pending" };
      } else {
        await assertCommittedAuthorityOutcomeMatches(
          join(this.#worldsRoot, direct.worldId),
          operationId,
          direct,
        );
        await assertPendingMaterializationCompatible(
          join(this.#worldsRoot, direct.worldId),
          operationId,
        );
      }
      return direct;
    }
    const worlds = await readDirectoryNames(this.#worldsRoot);
    for (const worldId of worlds) {
      const authority = await readAcceptedAuthority(
        join(this.#worldsRoot, worldId),
      );
      const commitIndex =
        authority?.commits.findIndex(
          (candidate) => candidate.operationId === operationId,
        ) ?? -1;
      const commit = authority?.commits[commitIndex];
      if (commit !== undefined) {
        const materialized = await readOptionalJson<{ head: string }>(
          join(this.#worldsRoot, worldId, "runtime", "materialized-head.json"),
        );
        const materializedIndex =
          materialized?.head === "genesis"
            ? -1
            : (authority?.commits.findIndex(
                ({ head }) => head === materialized?.head,
              ) ?? -1);
        return {
          outcome:
            materializedIndex >= commitIndex
              ? "committed"
              : "committed_materialization_pending",
          worldId,
          parentHead: commit.parentHead,
          head: commit.head,
          historyAppend: commit.historyAppend.map(({ role, exactText }) => ({
            role,
            exactText,
          })),
          nextAdditionalMaterials: commit.nextAdditionalMaterials,
          mode: commit.mode,
        };
      }
    }
    return direct?.outcome === "in_progress"
      ? { outcome: "in_progress" }
      : (direct ?? { outcome: "not_started" });
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
          "该世界已有持久状态 operation 正在执行",
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
      throw new TypeError("调用链提交不能同时缺少叙事与状态变化");
    return this.#commitHistoryChange({
      ...input,
      mode: "play",
    });
  }

  async readPlayCallChain<T>(worldId: string): Promise<T | null> {
    assertIdentity(worldId, "世界 ID");
    return readOptionalJson<T>(
      join(this.#worldsRoot, worldId, "runtime", "play-call-chain.json"),
    );
  }

  async writePlayCallChain(worldId: string, value: unknown): Promise<void> {
    assertIdentity(worldId, "世界 ID");
    await publishJson(
      join(this.#worldsRoot, worldId, "runtime", "play-call-chain.json"),
      value,
    );
  }

  async removePlayCallChain(worldId: string): Promise<void> {
    assertIdentity(worldId, "世界 ID");
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
    mode: "play" | "correction";
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
      const accepted = await readAcceptedAuthority(
        join(this.#worldsRoot, existing.worldId),
      );
      const commit = accepted?.commits.find(
        ({ operationId }) => operationId === input.operationId,
      );
      if (
        commit?.mode !== input.mode ||
        JSON.stringify(commit?.stateChanges) !==
          JSON.stringify(input.stateChanges)
      )
        throw new FileNativeWorldCreationError(
          "operation_conflict",
          "同一 play operation ID 已绑定另一份完整提交载荷",
        );
      return existing;
    }
    if (
      existing.outcome !== "not_started" &&
      !(input.operationReserved === true && existing.outcome === "in_progress")
    )
      throw new FileNativeWorldCreationError(
        "operation_conflict",
        "同一 play operation ID 已由另一项持久操作占用",
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
            const accepted = await readAcceptedAuthority(
              join(this.#worldsRoot, concurrent.worldId),
            );
            const knownCommit = accepted?.commits.find(
              ({ operationId }) => operationId === input.operationId,
            );
            if (
              knownCommit?.mode !== input.mode ||
              !isDeepStrictEqual(knownCommit.stateChanges, input.stateChanges)
            )
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                "同一 play operation ID 已绑定另一份完整提交载荷",
              );
            return concurrent;
          }
          const authorityPath = join(root, "runtime", "play-authority.json");
          const authority = (await readAcceptedAuthority(root)) ?? {
            schemaVersion: 1,
            head: "genesis",
            commits: [],
          };
          if (authority.head !== input.parentHead) {
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "游玩操作的父端点已变化",
            );
          }
          const materialized = await readOptionalJson<{ head: string }>(
            join(root, "runtime", "materialized-head.json"),
          );
          if ((materialized?.head ?? "genesis") !== authority.head)
            throw new FileNativeWorldCreationError(
              "operation_conflict",
              "世界存在已接受但尚未修复的物化，禁止新的竞争写操作",
            );
          const [currentState, currentControl] = await Promise.all([
            readTree(join(root, "state")),
            readTree(join(root, "control")),
          ]);
          const candidateState = new Map(
            currentState.map((file) => [file.path, file.contents]),
          );
          for (const change of input.stateChanges) {
            assertRelativePath(change.relativePath);
            const previous = candidateState.get(change.relativePath);
            const previousHash =
              previous === undefined
                ? null
                : `sha256:${createHash("sha256").update(previous).digest("hex")}`;
            if (
              previousHash !== change.expectedPreviousHash ||
              `sha256:${createHash("sha256").update(change.canonicalNextBytes).digest("hex")}` !==
                change.nextHash
            )
              throw new FileNativeWorldCreationError(
                "operation_conflict",
                `状态变化 hash 冲突：${change.relativePath}`,
              );
            candidateState.set(change.relativePath, change.canonicalNextBytes);
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
              `候选世界未通过机械校验：${inspection.issues.map(({ message }) => message).join("；")}`,
            );
          const sequence = authority.commits.length + 1;
          const head = `commit:${sequence}`;
          const commit = {
            schemaVersion: 1,
            operationId: input.operationId,
            parentHead: input.parentHead,
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
          } satisfies FileNativePlayCommit;
          crashAtFileNativeAuthorityEdge("before_commit_acceptance");
          await publishImmutableJson(
            join(
              root,
              "runtime",
              "play-commits",
              `${createHash("sha256").update(JSON.stringify(commit)).digest("hex")}.json`,
            ),
            commit,
          );
          await publishJson(authorityPath, {
            schemaVersion: 1,
            head,
            commits: [...authority.commits, commit],
          } satisfies FileNativePlayAuthority);
          crashAtFileNativeAuthorityEdge("after_commit_acceptance");
          const pending = {
            outcome: "committed_materialization_pending" as const,
            worldId: input.worldId,
            parentHead: input.parentHead,
            head,
            historyAppend: structuredClone(input.historyAppend),
            nextAdditionalMaterials: structuredClone(input.nextMaterials),
            mode: input.mode,
          };
          await publishJson(
            this.#operationOutcomePath(input.operationId),
            pending,
          );
          try {
            await materializePlayCommit(root, sequence, {
              historyAppend: commit.historyAppend,
              nextMaterials: input.nextMaterials,
              stateChanges: input.stateChanges,
            });
            crashAtFileNativeAuthorityEdge("after_materialization");
            await publishJson(join(root, "runtime", "materialized-head.json"), {
              head,
            });
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
          "世界 Authority 提交正在由另一进程串行化",
        );
      throw error;
    }
  }

  async readAuthorityHistory(
    worldId: string,
  ): Promise<{ head: string; commits: FileNativePlayCommit[] }> {
    assertIdentity(worldId, "世界 ID");
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
        `历史端点不存在：${endpoint}`,
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
            "确定性世界身份已被另一创建 operation 占用",
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
        "创建 operation 与世界发布记录不一致",
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
        "（预览占位：玩家创建世界后的第一条真实行动）",
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
      "内容包缺少可用的 opening.md",
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
      `复制后的 state 世界文档快照未通过校验：${worldState.diagnostics
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
      "复制后的 state 世界文档身份、短引用或 codec 与内容包快照不一致",
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

async function readDirectoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
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
    value.outcome === "committed" ||
    value.outcome === "committed_materialization_pending"
  ) {
    if (
      !hasExactKeys(value, [
        "outcome",
        "worldId",
        "parentHead",
        "head",
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
      !Array.isArray(value.historyAppend) ||
      !value.historyAppend.every(isPlayHistoryAppendInput) ||
      !Array.isArray(value.nextAdditionalMaterials) ||
      !value.nextAdditionalMaterials.every(isAuthorityMaterialSelection) ||
      !(value.mode === "play" || value.mode === "correction")
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

function corruptOperationOutcome(): FileNativeWorldCreationError {
  return new FileNativeWorldCreationError(
    "world_corrupt",
    "Authority operation outcome 结构或 operation 身份无效",
  );
}

async function assertCommittedAuthorityOutcomeMatches(
  worldRoot: string,
  operationId: string,
  outcome: Extract<
    FileNativeOperationOutcome,
    { outcome: "committed" | "committed_materialization_pending" }
  >,
): Promise<void> {
  const authority = await readAcceptedAuthority(worldRoot);
  const commit = authority?.commits.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (
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
}

async function assertPendingMaterializationCompatible(
  worldRoot: string,
  operationId: string,
): Promise<void> {
  const authority = await readAcceptedAuthority(worldRoot);
  const sequence =
    authority?.commits.findIndex(
      (candidate) => candidate.operationId === operationId,
    ) ?? -1;
  const commit = sequence < 0 ? undefined : authority?.commits[sequence];
  if (commit === undefined) throw corruptOperationOutcome();
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
        `世界状态物化冲突：${change.relativePath}`,
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
        "历史消息物化内容冲突",
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
      "同一端点的附加材料清单内容冲突",
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
          "不可变 play commit 文件发生冲突",
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
    const published = await readOptionalJson<unknown>(
      join(root, "runtime", "play-authority.json"),
    );
    if (published === null) {
      const commitRoot = join(root, "runtime", "play-commits");
      const names = await readDirectoryFileNames(commitRoot);
      if (names.length === 0) return null;
      const remaining = await Promise.all(
        names.map(async (name) => {
          const commit = await readJson<unknown>(join(commitRoot, name));
          assertFileNativePlayCommit(commit);
          const canonicalName = `${createHash("sha256")
            .update(JSON.stringify(commit))
            .digest("hex")}.json`;
          if (name !== canonicalName)
            throw new FileNativeWorldCreationError(
              "world_corrupt",
              "不可变 commit 与持久路径身份不匹配",
            );
          return commit;
        }),
      );
      const commits: FileNativePlayCommit[] = [];
      let parent = "genesis";
      while (remaining.length > 0) {
        const matches = remaining.filter(
          (commit) => commit.parentHead === parent,
        );
        if (matches.length !== 1)
          throw new FileNativeWorldCreationError(
            "world_corrupt",
            "不可变 commit 无法重建唯一权威链",
          );
        const next = matches[0]!;
        commits.push(next);
        remaining.splice(remaining.indexOf(next), 1);
        parent = next.head;
      }
      assertFileNativePlayAuthority({
        schemaVersion: 1,
        head: parent,
        commits,
      });
      return { schemaVersion: 1, head: parent, commits };
    }
    assertFileNativePlayAuthority(published);
    const commits: FileNativePlayCommit[] = [];
    for (const recorded of published.commits) {
      const digest = createHash("sha256")
        .update(JSON.stringify(recorded))
        .digest("hex");
      const immutable = await readJson<unknown>(
        join(root, "runtime", "play-commits", `${digest}.json`),
      ).catch((error: unknown) => {
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `已接受端点缺少不可变 commit：${recorded.head}`,
          { cause: error },
        );
      });
      assertFileNativePlayCommit(immutable);
      if (JSON.stringify(immutable) !== JSON.stringify(recorded))
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `已接受端点与不可变 commit 不一致：${recorded.head}`,
        );
      commits.push(immutable);
    }
    return { ...published, commits };
  } catch (error: unknown) {
    if (error instanceof FileNativeWorldCreationError) throw error;
    throw new FileNativeWorldCreationError(
      "world_corrupt",
      "play Authority 持久数据损坏",
      { cause: error },
    );
  }
}

function assertFileNativePlayAuthority(
  value: unknown,
): asserts value is FileNativePlayAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "head", "commits"]) ||
    value.schemaVersion !== 1 ||
    typeof value.head !== "string" ||
    !Array.isArray(value.commits)
  )
    throw new Error("play Authority 外形无效");
  const operationIds = new Set<string>();
  const heads = new Set<string>();
  let parent = "genesis";
  for (const [index, commit] of value.commits.entries()) {
    assertFileNativePlayCommit(commit);
    if (
      commit.parentHead !== parent ||
      commit.head !== `commit:${index + 1}` ||
      operationIds.has(commit.operationId) ||
      heads.has(commit.head)
    )
      throw new Error("play Authority commit 链无效");
    operationIds.add(commit.operationId);
    heads.add(commit.head);
    parent = commit.head;
  }
  if (value.head !== parent) throw new Error("play Authority head 无效");
}

function assertFileNativePlayCommit(
  value: unknown,
): asserts value is FileNativePlayCommit {
  if (!isRecord(value)) throw new Error("play commit 外形无效");
  const correction = value.mode === "correction";
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "operationId",
      "parentHead",
      "head",
      "mode",
      "historyAppend",
      "stateChanges",
      "nextAdditionalMaterials",
      ...(correction ? ["correctionTargets", "corrects"] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.trim() === "" ||
    typeof value.parentHead !== "string" ||
    !/^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.parentHead) ||
    typeof value.head !== "string" ||
    !/^commit:[1-9][0-9]*$/u.test(value.head) ||
    (value.mode !== "play" && value.mode !== "correction") ||
    !Array.isArray(value.historyAppend) ||
    (correction
      ? value.historyAppend.length !== 0
      : value.historyAppend.length === 0 &&
        (!Array.isArray(value.stateChanges) ||
          value.stateChanges.length === 0)) ||
    !value.historyAppend.every(isFileNativeHistoryMessage) ||
    !Array.isArray(value.stateChanges) ||
    !value.stateChanges.every(isFileNativeStateChange) ||
    !Array.isArray(value.nextAdditionalMaterials) ||
    !value.nextAdditionalMaterials.every(isAuthorityMaterialSelection)
  )
    throw new Error("play commit 外形无效");
  if (
    correction &&
    (!Array.isArray(value.correctionTargets) ||
      !value.correctionTargets.every(
        (target) => typeof target === "string" && target.trim() !== "",
      ) ||
      typeof value.corrects !== "string" ||
      value.corrects !== value.parentHead)
  )
    throw new Error("correction commit 外形无效");
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

async function readDirectoryFileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function materializePlayCommit(
  root: string,
  sequence: number,
  input: {
    historyAppend: FileNativePlayCommit["historyAppend"];
    nextMaterials: MaterialSelection[];
    stateChanges: FileNativeStateChange[];
  },
): Promise<void> {
  for (const change of input.stateChanges) {
    assertRelativePath(change.relativePath);
    const path = join(root, "state", change.relativePath);
    let existing: string | null = null;
    try {
      existing = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const existingHash =
      existing === null
        ? null
        : `sha256:${createHash("sha256").update(existing).digest("hex")}`;
    if (existingHash === change.nextHash) continue;
    if (existingHash !== change.expectedPreviousHash)
      throw new FileNativeWorldCreationError(
        "inconsistent_materialization",
        `世界状态物化冲突：${change.relativePath}`,
      );
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, change.canonicalNextBytes, "utf8");
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  }
  crashAtFileNativeAuthorityEdge("after_state_materialization");
  const historyRoot = join(root, "history");
  await mkdir(historyRoot, { recursive: true });
  for (const [index, message] of input.historyAppend.entries())
    await writeIdempotentText(
      join(
        historyRoot,
        `${String(sequence).padStart(8, "0")}-${historyFileName(index + 1, message)}`,
      ),
      message.exactText,
    );
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
      "同一端点的附加材料清单内容冲突",
    );
  if (JSON.stringify(existingMaterials) !== JSON.stringify(nextMaterials))
    await publishJson(materialsPath, nextMaterials);
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
        "历史消息物化内容冲突",
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

function rewriteMaterials(
  materials: readonly MaterialSelection[],
  messageIds: ReadonlyMap<string, string>,
  worldId: string,
): MaterialSelection[] {
  return materials.map((material) => {
    if (material.kind === "history_message") {
      const message = messageIds.get(material.message);
      if (message === undefined)
        throw new FileNativeWorldCreationError(
          "world_corrupt",
          `派生材料引用了无法重写的历史消息：${material.message}`,
        );
      return { ...material, message };
    }
    if (material.kind === "history_commit")
      return { ...material, commit: `${worldId}.${material.commit}` };
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
      "同一 play operation ID 已绑定另一份提交载荷",
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
    throw new FileNativeWorldCreationError("world_corrupt", "世界本地外壳损坏");
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
  const suffix = "（派生）";
  return `${Array.from(sourceName)
    .slice(0, 160 - Array.from(suffix).length)
    .join("")}${suffix}`;
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
    throw new TypeError(`${label} 无效`);
  }
}

function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError("世界文件路径无效");
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
