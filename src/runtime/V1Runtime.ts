import { join } from "node:path";

import {
  maxPortableContentArchiveBase64Characters,
  maxPortableContentArchiveBytes,
} from "../protocol/contentTree.ts";
import {
  V1ProtocolError,
  v1Protocol,
  type V1Request,
  type V1Response,
} from "../protocol/v1.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../protocol/appPreferences.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../protocol/playerViews.ts";
import {
  ContentPackageImportError,
  ContentWorkspace,
  InvalidContentTreeError,
} from "./content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "./content/FileNativeContentTree.ts";
import { FileNativeModelHost } from "./model/FileNativeModelAdapters.ts";
import { type ModelHostBinding } from "./model/ModelHost.ts";
import { ModelConnectionStore } from "./model/ModelConnectionStore.ts";
import { FileNativeContinuityCorrection } from "./play/FileNativeContinuityCorrection.ts";
import { fingerprintControl } from "./play/PlayDocumentTools.ts";
import {
  PlayCallChain,
  PlayCallChainError,
  type PlayCallChainObserver,
} from "./play/PlayCallChain.ts";
import {
  FileNativePlayPresetError,
  FileNativePlayPresetStore,
  presetHostBinding,
  type PlayPresetBinding,
} from "./play/FileNativePlayPresetStore.ts";
import { buildPlayPresetWorkbenchSnapshot } from "./play/PlayPresetWorkbench.ts";
import { FileNativeArtifactStore } from "./artifact/FileNativeArtifactStore.ts";
import {
  projectArtifactForFrontend,
  projectDebugArtifactForFrontend,
  type FrontendBundleFailure,
  type FrontendArtifactDebugRecord,
  type FrontendArtifactProjection,
} from "./extension/FrontendExtensionBundle.ts";
import {
  projectPlayerViewPanels,
  type FrontendPlayerViewPanelProjection,
} from "./extension/PlayerViewPanelProjector.ts";
import { FileNativePromptCompiler } from "./prompt/FileNativePromptCompiler.ts";
import { FileNativeSettingImprovementStore } from "./setting/FileNativeSettingImprovementStore.ts";
import {
  SettingImprovementRollbackError,
  SettingImprovementSession,
} from "./setting/SettingImprovementSession.ts";
import { FileNativeWorldStore } from "./world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "./world/WorldDocumentStore.ts";
import { FileNativeAiFailureLog } from "./model/AiFailureLog.ts";
import { AppPreferencesStore } from "./config/AppPreferencesStore.ts";

export class V1Runtime {
  readonly #content: ContentWorkspace;
  readonly #playPresets: FileNativePlayPresetStore;
  readonly #worlds: FileNativeWorldStore;
  readonly #artifacts: FileNativeArtifactStore;
  readonly #models: ModelConnectionStore;
  readonly #corrections: FileNativeContinuityCorrection;
  readonly #playCallChains: PlayCallChain;
  readonly #failureLog: FileNativeAiFailureLog | undefined;
  readonly #preferences: AppPreferencesStore;
  readonly #settingImprovements: SettingImprovementSession;
  readonly #compiler = new FileNativePromptCompiler();
  #locale: AppLocale = defaultAppLocale;

  constructor(input: {
    dataRoot: string;
    configRoot: string;
    logRoot?: string;
  }) {
    this.#preferences = new AppPreferencesStore(input.configRoot);
    this.#content = new ContentWorkspace(input.dataRoot, {
      locale: () => this.#locale,
    });
    this.#playPresets = new FileNativePlayPresetStore(input.configRoot, {
      locale: () => this.#locale,
    });
    this.#worlds = new FileNativeWorldStore(input.dataRoot);
    this.#artifacts = new FileNativeArtifactStore(input.dataRoot);
    this.#failureLog =
      input.logRoot === undefined
        ? undefined
        : new FileNativeAiFailureLog(join(input.logRoot, "ai-failures"));
    this.#playCallChains = new PlayCallChain(
      this.#worlds,
      this.#compiler,
      this.#artifacts,
      this.#failureLog,
    );
    this.#models = new ModelConnectionStore(input.configRoot);
    this.#corrections = new FileNativeContinuityCorrection(this.#worlds, {
      compiler: this.#compiler,
    });
    this.#settingImprovements = new SettingImprovementSession({
      store: new FileNativeSettingImprovementStore(input.dataRoot, {
        content: this.#content,
      }),
      content: this.#content,
      compiler: this.#compiler,
      locale: () => this.#locale,
      bindModelHost: () => this.#modelHost(),
      bindExistingModelHost: (binding) => this.#matchingModelHost(binding),
      bindPlayPreset: () => this.#playPresets.freeze(),
      preview: (snapshot, modelBinding, playPreset) =>
        this.#compiler.preview(
          {
            endpoint: { id: "setting-authoring", commit: "current-tree" },
            hostBinding:
              playPreset === undefined
                ? {
                    hostPresetId: "legacy-setting-authoring",
                    files: defaultSettingPreviewHost(),
                  }
                : presetHostBinding(playPreset),
            world: previewWorld(
              snapshot,
              "setting-authoring.message.genesis.narrator",
              "setting-authoring",
            ),
            playerInputPlacement: "append",
            playerInput:
              this.#locale === "zh-CN"
                ? "检查内容包当前树。"
                : "Inspect the content package current tree.",
            modelBinding,
          },
          playPreset,
        ),
    });
  }

  async initialize(): Promise<void> {
    this.#locale = (await this.#preferences.view()).locale;
    this.#compiler.setLocale(this.#locale);
    await this.#playPresets.initialize();
  }

  async handle(
    request: V1Request,
    playCallChainObserver?: PlayCallChainObserver,
  ): Promise<V1Response> {
    const result = await this.#dispatch(request, playCallChainObserver);
    return { protocol: v1Protocol, result };
  }

  async #dispatch(
    request: V1Request,
    playCallChainObserver?: PlayCallChainObserver,
  ): Promise<unknown> {
    switch (request.type) {
      case "workspace.read":
        return {
          preferences: await this.#preferences.view(),
          contentPackages: await this.#content.listCurrentTreeContentPackages(),
          playPresets: await this.#playPresets.list(),
          model: await this.#models.view(),
          worlds: await this.#worlds.listWorlds(),
          storageNotices: this.#storageNotices(),
        };
      case "preferences.read":
        return this.#preferences.view();
      case "preferences.save": {
        const preferences = await this.#preferences.save({
          ...(request.locale === undefined ? {} : { locale: request.locale }),
          ...(request.reading === undefined
            ? {}
            : { reading: request.reading }),
        });
        this.#locale = preferences.locale;
        this.#compiler.setLocale(this.#locale);
        await this.#playPresets.syncBuiltinDefaultLocale();
        return preferences;
      }
      case "model.read":
        return this.#models.view();
      case "model.save":
        return this.#models.save(request.connection);
      case "model.copy":
        return this.#models.copy(request.connectionId, request.name);
      case "model.select":
        return this.#models.select(request.connectionId);
      case "model.delete":
        return this.#models.delete(request.connectionId);
      case "model.models":
        return this.#models.listModels(request);
      case "content.create":
        return this.#content.createCurrentTreeContentPackage();
      case "content.read":
        return this.#content.readCurrentTreeContentPackage(request.packageId);
      case "content.replace":
        return this.#content.replaceCurrentTreeContentPackage(
          request.packageId,
          request.files,
        );
      case "content.copy":
        return this.#content.copyCurrentTreeContentPackage(request.packageId);
      case "content.delete":
        await this.#content.deleteCurrentTreeContentPackage(request.packageId);
        return { deleted: true };
      case "content.rename":
        return this.#content.renameCurrentTreeContentPackage(
          request.packageId,
          request.name,
        );
      case "content.import": {
        const archive = decodePortableContentArchive(request.archiveBase64);
        try {
          return await this.#content.importPortableContentPackageArchive(
            archive,
            request.title === undefined ? {} : { title: request.title },
          );
        } catch (error: unknown) {
          if (
            error instanceof ContentPackageImportError ||
            error instanceof InvalidContentTreeError
          )
            throw new V1ProtocolError("invalid_request", error.message, {
              cause: error,
            });
          throw error;
        }
      }
      case "content.export": {
        const exported = await this.#content.exportCurrentTreeContentPackage(
          request.packageId,
        );
        return {
          fileName: exported.fileName,
          base64: exported.archive.toString("base64"),
        };
      }
      case "setting-improvement.read":
        return this.#settingImprovements.read(request.packageId);
      case "setting-improvement.status":
        return this.#settingImprovements.status(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.overview":
        return this.#settingImprovements.overview(request.packageId);
      case "setting-improvement.session.read":
        return this.#settingImprovements.readSession(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.session.delete":
        return this.#settingImprovements.deleteSession(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.rollback":
        try {
          return await this.#settingImprovements.rollback(request);
        } catch (error: unknown) {
          if (error instanceof SettingImprovementRollbackError)
            throw new V1ProtocolError("invalid_request", error.message, {
              cause: error,
            });
          throw error;
        }
      case "setting-improvement.message":
        return this.#settingImprovements.send(request);
      case "setting-improvement.cancel":
        return this.#settingImprovements.cancel(request.sessionId);
      case "play.read":
        return this.#playPresets.list();
      case "play.create":
        return this.#playPresets.create(request.name, request.files);
      case "play.copy":
        return this.#playPresets.copy(request.presetId);
      case "play.save":
        return this.#playPresets.save(request);
      case "play.rename":
        return this.#playPresets.rename(request.presetId, request.name);
      case "play.delete":
        return this.#playPresets.delete(request.presetId);
      case "play.enable":
        return this.#playPresets.setEnabled(request.presetId, request.enabled);
      case "play.scripts":
        return this.#playPresets.setScriptsEnabled(
          request.presetId,
          request.enabled,
        );
      case "play.select":
        return this.#playPresets.select(request.presetId);
      case "play.export":
        return {
          files: await this.#playPresets.exportPortable(request.presetId),
        };
      case "play.import":
        return this.#playPresets.importPortable(request);
      case "play.workbench.read": {
        const binding =
          request.presetId === undefined
            ? await this.#playPresets.bindCurrent()
            : await this.#playPresets.bindRevision(
                request.presetId,
                request.revision,
              );
        return buildPlayPresetWorkbenchSnapshot(binding);
      }
      case "prompt.preview": {
        const [package_, connection, playPreset] = await Promise.all([
          this.#content.readCurrentTreeContentPackage(request.packageId),
          this.#models.bind(),
          request.playPresetId === undefined
            ? this.#playPresets.bindCurrent()
            : this.#playPresets.bindRevision(
                request.playPresetId,
                request.playPresetRevision,
              ),
        ]);
        const hostBinding = presetHostBinding(playPreset);
        const modelHost = new FileNativeModelHost(connection);
        const preview = this.#compiler.preview(
          {
            endpoint: {
              id: `content:${request.packageId}`,
              commit: "current",
            },
            hostBinding,
            world: previewWorld(
              WorldDocumentStore.open({
                layout: "content_package",
                files: package_.files,
              }),
              `content:${request.packageId}.message.genesis.narrator`,
              "content-preview",
            ),
            playerInputPlacement: "append",
            playerInput: request.playerInput,
            modelBinding: modelHost.binding(),
          },
          playPreset,
        );
        const tools = structuredClone(
          preview.compilation.toolUniverse ?? preview.compilation.tools,
        );
        return {
          ...preview,
          wireRequest: modelHost.previewRequest({
            bootstrap: structuredClone(preview.compilation),
            tools: structuredClone(tools),
            toolUniverse: structuredClone(tools),
            allowedTools: tools.map(({ name }) => name),
            toolStrategy: preview.compilation.toolStrategy,
            appended:
              preview.initialAppend === undefined
                ? []
                : [
                    ...(preview.initialAppend.beforePlayer === undefined
                      ? []
                      : [preview.initialAppend.beforePlayer.logical]),
                    {
                      kind: "player" as const,
                      text: preview.initialAppend.logical.text,
                    },
                  ],
            requestId: "play_call_chain",
            operationId: "prompt-preview",
            requestAttempt: 1,
            exchange: 1,
            maxOutputTokens: modelHost.binding().maxOutputTokens,
          }),
        };
      }
      case "world.create": {
        const [package_, connection, preset] = await Promise.all([
          this.#content.readCurrentTreeContentPackage(request.packageId),
          this.#models.bind(),
          this.#playPresets.bindCurrent(),
        ]);
        return this.#worlds.createFromContentPackage({
          operationId: request.operationId,
          sourcePackageId: request.packageId,
          sourcePackageTitle: package_.title,
          packageFiles: package_.files,
          prompt: {
            hostBinding: presetHostBinding(preset),
            modelBinding: new FileNativeModelHost(connection).binding(),
          },
        });
      }
      case "world.creation-outcome":
        return this.#worlds.getCreationOutcome(request.operationId);
      case "world.rename":
        return this.#worlds.renameWorld(request.worldId, request.name);
      case "world.delete":
        return playCall(async () => {
          this.#playCallChains.forgetWorld(request.worldId);
          return this.#worlds.deleteWorld(request.worldId);
        });
      case "world.read": {
        const head = await this.#worlds.currentHead(request.worldId);
        const playerViews = await this.#worlds.renderPlayerViewsAtHead(
          request.worldId,
          head,
        );
        const [playerViewPanels, playTimeline] = await Promise.all([
          this.#frontendPlayerViewPanels(request.worldId, head, playerViews),
          this.#worlds.playTimeline.readPage(request.worldId, 40),
        ]);
        return {
          worldId: request.worldId,
          head,
          state: [],
          control: [],
          history: [],
          runtime: { head, surfaces: "lazy" },
          playerViews,
          committedMessages: [],
          artifacts: [],
          extensions: [],
          playerViewPanels,
          artifactDebug: [],
          playCallChain: null,
          playTimeline,
        };
      }
      case "world.surface.read":
        return request.surface === "runtime"
          ? this.#worlds.readSurface(request.worldId, "runtime")
          : this.#worlds.readSurface(request.worldId, request.surface);
      case "world.play-decorations.read": {
        const head = await this.#reconcileArtifacts(request.worldId);
        const [artifacts, extensions, artifactDebug] = await Promise.all([
          this.#frontendProjection(request.worldId),
          this.#artifacts.readExtensionSummaries(request.worldId),
          this.#frontendDebug(request.worldId),
        ]);
        return { head, artifacts, extensions, artifactDebug };
      }
      case "artifacts.read":
        await this.#reconcileArtifacts(request.worldId);
        return this.#frontendProjection(request.worldId, request.channel);
      case "artifacts.debug":
        await this.#reconcileArtifacts(request.worldId);
        return this.#frontendDebug(request.worldId, request.operationId);
      case "world.repair-materialization": {
        const result = await this.#worlds.repairMaterialization(
          request.worldId,
        );
        await this.#reconcileArtifacts(request.worldId);
        return result;
      }
      case "world.control-draft.save":
        return this.#worlds.saveControlDraft(request.worldId, request.files);
      case "world.control-draft.preview": {
        const prompt = {
          ...(await this.#promptBinding()),
          playerInput:
            this.#locale === "zh-CN"
              ? "预览世界控制。"
              : "Preview world control.",
        };
        return this.#worlds.previewControlDraft(request.worldId, prompt);
      }
      case "world.control-draft.apply": {
        const prompt = {
          ...(await this.#promptBinding()),
          playerInput:
            this.#locale === "zh-CN"
              ? "预览世界控制。"
              : "Preview world control.",
        };
        return this.#worlds.applyControlDraft(request.worldId, prompt);
      }
      case "world.derive": {
        const preset = await this.#playPresets.bindCurrent();
        const result = await this.#playCallChains.deriveWorld({
          operationId: request.operationId,
          sourceWorldId: request.sourceWorldId,
          sourceHead: request.sourceHead,
          hostPresetId: preset.id,
        });
        await this.#reconcileResultArtifacts(result);
        return result;
      }
      case "play.chain.revise-player": {
        const base = {
          operationId: request.operationId,
          worldId: request.worldId,
          chainId: request.chainId,
          eventId: request.eventId,
          replacementExchangeId: request.replacementExchangeId,
          replacementText: request.replacementText,
        };
        const result = await playCall(async () => {
          if (request.continuation === "continue_context")
            return this.#playCallChains.revisePlayer({
              ...base,
              continuation: request.continuation,
            });
          const { hostBinding, playPreset, modelBinding } =
            await this.#continuousBinding();
          return this.#playCallChains.revisePlayer({
            ...base,
            continuation: request.continuation,
            freshContext: { hostBinding, playPreset, modelBinding },
          });
        });
        await this.#reconcileArtifacts(request.worldId);
        return result;
      }
      case "play.chain.start": {
        const { modelHost, hostBinding, playPreset, modelBinding } =
          await this.#continuousBinding();
        return playCall(() =>
          this.#playCallChains.start({
            worldId: request.worldId,
            chainId: request.chainId,
            exchangeId: request.exchangeId,
            playerText: request.playerText,
            hostBinding,
            playPreset,
            modelBinding,
            modelHost,
            ...(playCallChainObserver === undefined
              ? {}
              : { observer: playCallChainObserver }),
          }),
        );
      }
      case "play.chain.append":
        return playCall(async () =>
          this.#playCallChains.append({
            worldId: request.worldId,
            chainId: request.chainId,
            exchangeId: request.exchangeId,
            playerText: request.playerText,
            modelHost: await this.#modelHost(),
            ...(playCallChainObserver === undefined
              ? {}
              : { observer: playCallChainObserver }),
          }),
        );
      case "play.chain.cancel":
        return playCall(() =>
          this.#playCallChains.cancel({
            worldId: request.worldId,
            chainId: request.chainId,
            exchangeId: request.exchangeId,
          }),
        );
      case "play.chain.inspect":
        return this.#playCallChains.inspectWorld(request.worldId);
      case "play.timeline.page":
        await this.#worlds.ensureCurrentStorage(request.worldId);
        return this.#worlds.playTimeline.readPage(
          request.worldId,
          request.limit,
          request.cursor,
        );
      case "play.timeline.detail":
        await this.#worlds.ensureCurrentStorage(request.worldId);
        return this.#worlds.playTimeline.readDetail(
          request.worldId,
          request.chainId,
          request.eventId,
        );
      case "world.play-context.read": {
        const binding = await this.#worlds.bindPlayCallChain(request.worldId);
        const currentContext = await this.#playCallChains.inspectReading(
          request.worldId,
          binding.parentHead,
        );
        const model = await this.#models.view();
        if (!model.configured)
          return {
            worldId: request.worldId,
            worldHead: binding.parentHead,
            currentContext,
            nextFreshContext: null,
          };
        const { hostBinding, playPreset, modelBinding } =
          await this.#continuousBinding();
        const preview = this.#compiler.preview(
          {
            endpoint: {
              id: `${request.worldId}:${binding.parentHead}`,
              commit: binding.parentHead,
            },
            hostBinding,
            world: {
              controlFingerprint: fingerprintControl(binding.files),
              documentSnapshot: WorldDocumentStore.open({
                layout: "world_state",
                files: Object.entries(binding.files).map(
                  ([path, contents]) => ({ path, contents }),
                ),
              }),
              additionalMaterials: structuredClone(binding.additionalMaterials),
              history: structuredClone(binding.history),
              narrativeCheckpoint: binding.narrativeCheckpoint,
            },
            playerInputPlacement: "append",
            playerInput: "",
            modelBinding,
          },
          playPreset,
        );
        return {
          worldId: request.worldId,
          worldHead: binding.parentHead,
          currentContext,
          nextFreshContext: { head: binding.parentHead, preview },
        };
      }
      case "correction.begin":
        return this.#corrections.begin({
          worldId: request.worldId,
          operationId: request.operationId,
          mode: "documents",
        });
      case "correction.read":
        return this.#corrections.readDocument(
          request.candidateId,
          request.document,
        );
      case "correction.patch":
        return this.#corrections.patchDocument(request);
      case "correction.replace":
        return this.#corrections.replaceDocument(request);
      case "correction.preview": {
        const { hostBinding, modelBinding, playPreset } =
          await this.#continuousBinding();
        return this.#corrections.preview({
          candidateId: request.candidateId,
          expectedVersion: request.expectedVersion,
          prompt: { hostBinding, modelBinding, playPreset },
        });
      }
      case "correction.apply": {
        const result = await this.#corrections.apply(request);
        await this.#reconcileResultArtifacts(result);
        return result;
      }
      case "correction.cancel":
        await this.#corrections.cancel(
          request.candidateId,
          request.expectedVersion,
        );
        return { cancelled: true };
    }
  }

  async #modelHost(): Promise<FileNativeModelHost> {
    return new FileNativeModelHost(
      await this.#models.bind(),
      fetch,
      this.#failureLog,
    );
  }

  async #matchingModelHost(
    binding: ModelHostBinding,
  ): Promise<FileNativeModelHost> {
    return new FileNativeModelHost(
      await this.#models.bindMatching(binding),
      fetch,
      this.#failureLog,
    );
  }

  async #reconcileArtifacts(worldId: string): Promise<string> {
    const [head, currentOperationId] = await Promise.all([
      this.#worlds.currentHead(worldId),
      this.#worlds.currentHeadOperationId(worldId),
    ]);
    await this.#artifacts.reconcileHead(
      worldId,
      head,
      currentOperationId ?? undefined,
    );
    return head;
  }

  async #frontendProjection(
    worldId: string,
    channel?: string,
  ): Promise<FrontendArtifactProjection[]> {
    const artifacts = await this.#artifacts.readActiveProjection(
      worldId,
      channel,
    );
    return Promise.all(
      artifacts.map(async (artifact) => {
        const { renderer, ...safeArtifact } = artifact;
        void renderer;
        const resolved = await this.#frontendBinding(
          artifact.playPresetId,
          artifact.playPresetRevision,
        );
        return {
          ...safeArtifact,
          frontend: projectArtifactForFrontend(
            artifact,
            resolved.binding,
            resolved.failure,
          ),
        };
      }),
    );
  }

  async #frontendPlayerViewPanels(
    worldId: string,
    head: string,
    playerViews: {
      views: RenderedPlayerView[];
      diagnostics: PlayerViewDiagnostic[];
    },
  ): Promise<FrontendPlayerViewPanelProjection[]> {
    try {
      const binding = await this.#playPresets.bindCurrent();
      return projectPlayerViewPanels({
        worldId,
        head,
        playerViews,
        binding,
      });
    } catch (error: unknown) {
      // Panels are decoration on top of a world read. Any unusable preset —
      // disabled, deleted, or written by an older build and now missing a
      // required file — costs the panels, never the world itself.
      if (error instanceof FileNativePlayPresetError) return [];
      throw error;
    }
  }

  async #frontendDebug(
    worldId: string,
    operationId?: string,
  ): Promise<FrontendArtifactDebugRecord[]> {
    const records = await this.#artifacts.readDebug(worldId, operationId);
    return Promise.all(
      records.map(async (record) => {
        const { renderer, ...safeRecord } = record;
        void renderer;
        const resolved = await this.#frontendBinding(
          record.playPresetId,
          record.playPresetRevision,
        );
        return {
          ...safeRecord,
          frontend: projectDebugArtifactForFrontend(
            record,
            resolved.binding,
            resolved.failure,
          ),
        };
      }),
    );
  }

  async #frontendBinding(
    id: string,
    revision: string,
  ): Promise<{
    binding: PlayPresetBinding | null;
    failure: FrontendBundleFailure;
  }> {
    try {
      return {
        binding: await this.#playPresets.bindRevision(id, revision),
        failure: "missing_revision",
      };
    } catch (error: unknown) {
      // A historical revision is intentionally not replaced with current.
      if (
        !(error instanceof FileNativePlayPresetError) ||
        error.code === "store_invalid"
      )
        throw error;
      return {
        binding: null,
        failure:
          error.code === "revision_not_found" || error.code === "not_found"
            ? "missing_revision"
            : "invalid_revision",
      };
    }
  }

  async #reconcileResultArtifacts(
    result: unknown,
    fallbackWorldId?: string,
  ): Promise<void> {
    const candidate = isRecord(result) ? result : undefined;
    const nestedWorld =
      candidate !== undefined && isRecord(candidate.world)
        ? candidate.world
        : undefined;
    const worldId =
      (candidate !== undefined && typeof candidate.worldId === "string"
        ? candidate.worldId
        : undefined) ??
      (nestedWorld !== undefined && typeof nestedWorld.worldId === "string"
        ? nestedWorld.worldId
        : undefined) ??
      fallbackWorldId;
    if (worldId === undefined) return;
    await this.#reconcileArtifacts(worldId);
  }

  async #promptBinding() {
    const [preset, connection] = await Promise.all([
      this.#playPresets.bindCurrent(),
      this.#models.bind(),
    ]);
    const modelHost = new FileNativeModelHost(connection);
    return {
      hostBinding: presetHostBinding(preset),
      modelBinding: modelHost.binding(),
    };
  }

  async #continuousBinding(): Promise<{
    modelHost: FileNativeModelHost;
    hostBinding: { hostPresetId: string; files: Record<string, string> };
    playPreset: PlayPresetBinding;
    modelBinding: ModelHostBinding;
  }> {
    const [modelHost, playPreset] = await Promise.all([
      this.#modelHost(),
      this.#playPresets.freeze(),
    ]);
    return {
      modelHost,
      hostBinding: presetHostBinding(playPreset),
      playPreset,
      modelBinding: modelHost.binding(),
    };
  }

  #storageNotices(): { surface: string; message: string }[] {
    const notices = [];
    const recovery = this.#playPresets.recovery;
    if (recovery !== null)
      notices.push({
        surface: "Play-preset library",
        message: `The play-preset library could not be read (${recovery.message}). A default library was rebuilt; the original file remains at ${recovery.quarantinedPath}`,
      });
    return notices;
  }
}

async function playCall<Value>(
  operation: () => Value | Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof PlayCallChainError)
      throw new V1ProtocolError("invalid_request", error.message, {
        cause: error,
      });
    throw error;
  }
}

function decodePortableContentArchive(archiveBase64: string): Buffer {
  if (
    archiveBase64.length === 0 ||
    archiveBase64.length > maxPortableContentArchiveBase64Characters ||
    archiveBase64.length % 4 !== 0
  )
    throw invalidContentArchiveUpload();
  const archive = Buffer.from(archiveBase64, "base64");
  if (
    archive.byteLength > maxPortableContentArchiveBytes ||
    archive.toString("base64") !== archiveBase64
  )
    throw invalidContentArchiveUpload();
  return archive;
}

function invalidContentArchiveUpload(): V1ProtocolError {
  return new V1ProtocolError(
    "invalid_request",
    "content.import.archiveBase64 is not a supported content-package ZIP",
  );
}

function previewWorld(
  snapshot: WorldDocumentStore,
  openingMessageId: string,
  controlFingerprint: string,
) {
  const inspection = inspectContentPackageCurrentTree(snapshot.files, {
    worldDocumentSnapshot: snapshot,
  });
  if (inspection.opening !== "valid")
    throw new Error(
      `A real first-turn Prompt Preview requires a usable opening.md: ${inspection.issues
        .filter(
          ({ code }) =>
            code === "missing_opening" || code === "invalid_opening",
        )
        .map(({ message }) => message)
        .join("；")}`,
    );
  const opening = snapshot.files.find(
    ({ path, encoding }) => path === "opening.md" && encoding === undefined,
  );
  if (opening === undefined)
    throw new Error(
      "A real first-turn Prompt Preview could not read opening.md",
    );
  return {
    controlFingerprint,
    documentSnapshot: snapshot,
    history: { [openingMessageId]: opening.contents },
    additionalMaterials: [
      { kind: "history_message" as const, message: openingMessageId },
    ],
  };
}

function defaultSettingPreviewHost(): Record<string, string> {
  return {
    "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
