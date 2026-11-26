import { RuntimeDomainError } from "./RuntimeDomainError.ts";
import { AuthoringCommands } from "./commands/AuthoringCommands.ts";
import { hasCommandPrefix } from "./commands/Command.ts";
import { handleContentCommand } from "./commands/ContentCommands.ts";
import { handleModelCommand } from "./commands/ModelCommands.ts";
import { PlayCommands, previewWorld } from "./commands/PlayCommands.ts";
import { WorldCommands } from "./commands/WorldCommands.ts";
import type { GenerationActivity } from "./GenerationActivity.ts";
import { mayChangeUserState } from "../protocol/requestEffect.ts";
import type { ArchiveUploadPolicy } from "./archive/ArchiveUploads.ts";
import { WorldArchives } from "./archive/WorldArchives.ts";
import { join } from "node:path";

import {
  assertV1RequestType,
  v1Protocol,
  type V1PlayCallChainView,
  type V1Request,
  type V1Response,
} from "../protocol/v1.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../protocol/appPreferences.ts";
import { ContentWorkspace } from "./content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "./content/ContentTreeFingerprint.ts";
import { FileNativeModelHost } from "./model/FileNativeModelAdapters.ts";
import { type ModelHostBinding } from "./model/ModelHost.ts";
import { ModelConnectionStore } from "./model/ModelConnectionStore.ts";
import { fingerprintControl } from "./play/PlayDocumentTools.ts";
import {
  PlayCallChain,
  type PlayCallChainObserver,
} from "./play/PlayCallChain.ts";
import {
  FileNativePlayPresetStore,
  presetHostBinding,
} from "./play/FileNativePlayPresetStore.ts";
import { FileNativeArtifactStore } from "./artifact/FileNativeArtifactStore.ts";
import { FileNativePromptCompiler } from "./prompt/FileNativePromptCompiler.ts";
import { FileNativeSettingImprovementStore } from "./setting/FileNativeSettingImprovementStore.ts";
import { SettingImprovementSession } from "./setting/SettingImprovementSession.ts";
import { FileNativeWorldStore } from "./world/FileNativeWorldStore.ts";
import { FileNativeAiFailureLog } from "./model/AiFailureLog.ts";
import { FileNativeRuntimeErrorLog } from "./RuntimeErrorLog.ts";
import { ProtagonistTemplateStore } from "./config/ProtagonistTemplateStore.ts";
import { AppPreferencesStore } from "./config/AppPreferencesStore.ts";
import { FileNativeWorldRevisionStore } from "./world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionSession } from "./world-revision/WorldRevisionSession.ts";
import { WorldRevisionWorkspace } from "./world-revision/WorldRevisionWorkspace.ts";

import { EditorSessionStore } from "./orchestration/EditorSessionStore.ts";
import { OrchestrationEditorSession } from "./orchestration/OrchestrationEditorSession.ts";
import type { OrchestrationEditorExtension } from "./orchestration/EditorTools.ts";

import { ConversationChanges } from "./ConversationChanges.ts";
import type {
  ConversationTarget,
  ConversationState,
} from "../protocol/conversationObservation.ts";

export class V1Runtime {
  readonly worldArchives: WorldArchives;
  readonly #conversationChanges = new ConversationChanges();
  readonly #content: ContentWorkspace;
  readonly #playPresets: FileNativePlayPresetStore;
  readonly #worlds: FileNativeWorldStore;
  readonly #artifacts: FileNativeArtifactStore;
  readonly #models: ModelConnectionStore;
  readonly #playCallChains: PlayCallChain;
  readonly #failureLog: FileNativeAiFailureLog | undefined;
  readonly #errorLog: FileNativeRuntimeErrorLog | undefined;
  readonly #preferences: AppPreferencesStore;
  readonly #protagonistTemplates: ProtagonistTemplateStore;
  readonly #orchestration: OrchestrationEditorSession;
  readonly #settingImprovements: SettingImprovementSession;
  readonly #worldRevisions: WorldRevisionSession;
  readonly #authoringCommands: AuthoringCommands;
  readonly #worldCommands: WorldCommands;
  readonly #playCommands: PlayCommands;
  readonly #compiler = new FileNativePromptCompiler();
  #locale: AppLocale = defaultAppLocale;

  constructor(input: {
    dataRoot: string;
    configRoot: string;
    logRoot?: string;
    archiveUploadPolicy?: ArchiveUploadPolicy;
    generationActivity?: GenerationActivity;
    orchestrationEditorExtension?: OrchestrationEditorExtension;
  }) {
    this.#preferences = new AppPreferencesStore(input.configRoot);
    this.#protagonistTemplates = new ProtagonistTemplateStore(input.configRoot);
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
    this.#errorLog =
      input.logRoot === undefined
        ? undefined
        : new FileNativeRuntimeErrorLog(join(input.logRoot, "runtime-errors"));
    this.#playCallChains = new PlayCallChain(
      this.#worlds,
      this.#compiler,
      this.#artifacts,
      this.#failureLog,
      (id) => this.#conversationChanges.publish(`play:${id}`),
      input.generationActivity,
    );
    this.worldArchives = new WorldArchives({
      dataRoot: input.dataRoot,
      worlds: this.#worlds,
      chains: this.#playCallChains,
      ...(input.archiveUploadPolicy === undefined
        ? {}
        : { uploadPolicy: input.archiveUploadPolicy }),
    });
    this.#models = new ModelConnectionStore(input.configRoot);
    const generation =
      input.generationActivity === undefined
        ? {}
        : { generationActivity: input.generationActivity };
    this.#orchestration = new OrchestrationEditorSession({
      ...generation,
      changed: (presetId, durable) =>
        this.#conversationChanges.publish(`orchestration:${presetId}`, durable),
      store: new EditorSessionStore(join(input.configRoot, "orchestration-sessions")),
      drafts: this.#playPresets,
      locale: () => this.#locale,
      bindModelHost: () => this.#modelHost(),
      bindExistingModelHost: (binding) => this.#matchingModelHost(binding),
      ...(input.orchestrationEditorExtension === undefined
        ? {}
        : { extension: input.orchestrationEditorExtension }),
    });
    this.#settingImprovements = new SettingImprovementSession({
      ...generation,
      changed: (id, durable) =>
        this.#conversationChanges.publish(`setting:${id}`, durable),
      store: new FileNativeSettingImprovementStore(input.dataRoot, {
        content: this.#content,
      }),
      content: this.#content,
      compiler: this.#compiler,
      locale: () => this.#locale,
      bindModelHost: () => this.#modelHost(),
      bindExistingModelHost: (binding) => this.#matchingModelHost(binding),
      bindPlayPreset: () => this.#playPresets.freeze(),
      preview: (snapshot, modelBinding, playPreset, modelPrompt) =>
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
            modelPrompt,
          },
          playPreset,
        ),
    });
    const worldRevisionStore = new FileNativeWorldRevisionStore(input.dataRoot);
    const worldRevisionWorkspace = new WorldRevisionWorkspace({
      store: worldRevisionStore,
      worlds: this.#worlds,
    });
    this.#worldRevisions = new WorldRevisionSession({
      ...generation,
      changed: (id, durable) =>
        this.#conversationChanges.publish(`revision:${id}`, durable),
      store: worldRevisionStore,
      workspace: worldRevisionWorkspace,
      worlds: this.#worlds,
      compiler: this.#compiler,
      locale: () => this.#locale,
      bindModelHost: () => this.#modelHost(),
      bindExistingModelHost: (binding) => this.#matchingModelHost(binding),
      bindPlayPreset: () => this.#playPresets.freeze(),
      preview: ({
        snapshot,
        modelBinding,
        modelPrompt,
        playPreset,
        binding,
        epoch,
        maintenance,
      }) =>
        this.#compiler.preview(
          {
            endpoint: {
              id: `${epoch.worldId}:${epoch.baseHead}:revision`,
              commit: `worktree:${contentTreeFingerprint(snapshot.files)}`,
              operationId: epoch.epochId,
            },
            hostBinding: presetHostBinding(playPreset),
            world: {
              controlFingerprint: fingerprintControl(
                Object.fromEntries(
                  snapshot.files.map(({ path, contents }) => [path, contents]),
                ),
              ),
              documentSnapshot: snapshot,
              history: structuredClone(binding.history),
              historyBackgrounds: structuredClone(
                binding.historyBackgrounds ?? {},
              ),
              narrativeCheckpoint: binding.narrativeCheckpoint,
              ...maintenance,
              additionalMaterials: structuredClone(binding.additionalMaterials),
            },
            playerInputPlacement: "append",
            playerInput:
              this.#locale === "zh-CN"
                ? "检查世界修订工作树。"
                : "Inspect the world-revision worktree.",
            modelBinding,
            modelPrompt,
          },
          playPreset,
        ),
    });
    this.#worldCommands = new WorldCommands({
      worlds: this.#worlds,
      worldArchives: this.worldArchives,
      content: this.#content,
      models: this.#models,
      playPresets: this.#playPresets,
      playCallChains: this.#playCallChains,
      worldRevisions: this.#worldRevisions,
      artifacts: this.#artifacts,
      locale: () => this.#locale,
    });
    this.#playCommands = new PlayCommands({
      worlds: this.#worlds,
      content: this.#content,
      models: this.#models,
      playPresets: this.#playPresets,
      playCallChains: this.#playCallChains,
      compiler: this.#compiler,
      locale: () => this.#locale,
      modelHost: () => this.#modelHost(),
      reconcileArtifacts: (worldId) =>
        this.#worldCommands.reconcileArtifacts(worldId),
    });
    this.#authoringCommands = new AuthoringCommands({
      settingImprovements: this.#settingImprovements,
      worldRevisions: this.#worldRevisions,
      reconcileArtifacts: (worldId) =>
        this.#worldCommands.reconcileArtifacts(worldId),
    });
  }

  async initialize(): Promise<void> {
    this.#locale = (await this.#preferences.view()).locale;
    this.#compiler.setLocale(this.#locale);
    await this.#playPresets.initialize();
    await this.#orchestration.initialize();
    await this.worldArchives.initialize();
  }

  async handle(
    request: V1Request,
    playCallChainObserver?: PlayCallChainObserver,
  ): Promise<V1Response> {
    assertV1RequestType(request.type);
    try {
      const result = await this.#dispatch(request, playCallChainObserver);
      await this.#recordPlayInterruption(request, result);
      return { protocol: v1Protocol, result };
    } catch (error) {
      await this.#errorLog?.recordRequestFailure(request, error);
      throw error instanceof RuntimeDomainError
        ? (error.toProtocolError(request.type) ?? error)
        : error;
    } finally {
      // Explicit commands may partially settle before failing. Readers recover
      // through the same Runtime projection, never infer success from this signal.
      if (mayChangeUserState(request.type)) {
        if ("packageId" in request)
          this.#conversationChanges.publish(`setting:${request.packageId}`);
        if ("presetId" in request && typeof request.presetId === "string" &&
            (request.type.startsWith("orchestration.") || request.type.startsWith("play.")))
          this.#conversationChanges.publish(`orchestration:${request.presetId}`);
        if ("worldId" in request) {
          this.#conversationChanges.publish(`play:${request.worldId}`);
          this.#conversationChanges.publish(`revision:${request.worldId}`);
        }
      }
    }
  }

  async #recordPlayInterruption(
    request: V1Request,
    result: unknown,
  ): Promise<void> {
    if (
      this.#errorLog === undefined ||
      (request.type !== "play.chain.start" &&
        request.type !== "play.chain.append")
    )
      return;
    const chain = result as Partial<V1PlayCallChainView> | null;
    if (
      chain?.status !== "interrupted" ||
      typeof chain.lastFailure !== "string" ||
      chain.lastCancelled === true
    )
      return;
    await this.#errorLog.recordPlayInterruption(request, {
      message: chain.lastFailure,
      ...(chain.lastFailureKind === undefined
        ? {}
        : { kind: chain.lastFailureKind }),
    });
  }

  async recordConversationFailure(
    target: ConversationTarget,
    error: unknown,
  ): Promise<void> {
    await this.#errorLog?.recordRequestFailure(
      {
        type: `${target.kind}.observe`,
        targetId: target.id,
        ...("sessionId" in target && target.sessionId !== undefined
          ? { sessionId: target.sessionId }
          : {}),
      },
      error,
    );
  }

  /** Archive routes sit outside `handle`, so they record their own failures. */
  async recordArchiveFailure(
    target: {
      type: "world.archive.download" | "world.archive.upload";
      archiveId?: string;
    },
    error: unknown,
  ): Promise<void> {
    await this.#errorLog?.recordRequestFailure(target, error);
  }

  subscribeConversation(
    target: ConversationTarget,
    changed: (durable: boolean) => void,
  ): () => void {
    return this.#conversationChanges.subscribe(
      `${target.kind}:${target.id}`,
      changed,
    );
  }

  async readConversation(
    target: ConversationTarget,
    previous?: ConversationState,
  ): Promise<ConversationState> {
    switch (target.kind) {
      case "play":
        return {
          kind: "play",
          value: await this.#playCallChains.observeWorld(target.id),
          extensionsRevision: await this.#worlds.extensionControlsRevision(
            target.id,
          ),
        };
      case "setting": {
        if (previous?.kind === "setting")
          return {
            kind: "setting",
            value: this.#settingImprovements.observeProgress(previous.value),
          };
        const status = await this.#settingImprovements.status(
          target.id,
          target.sessionId,
        );
        const content = await this.#content.readCurrentTreeContentPackage(
          target.id,
        );
        return {
          kind: "setting",
          value: {
            ...status,
            revision: `${status.revision}:${content.treeRevision}`,
          },
        };
      }
      case "orchestration":
        return {
          kind: "orchestration",
          value: previous?.kind === "orchestration"
            ? this.#orchestration.observeProgress(previous.value)
            : await this.#orchestration.status(target.id, target.sessionId),
        };
      case "revision":
        return {
          kind: "revision",
          value:
            previous?.kind === "revision"
              ? this.#worldRevisions.observeProgress(previous.value)
              : await this.#worldRevisions.status(target.id, target.sessionId),
        };
    }
  }

  async #dispatch(
    request: V1Request,
    playCallChainObserver?: PlayCallChainObserver,
  ): Promise<unknown> {
    if (hasCommandPrefix(request, "orchestration"))
      return this.#orchestration.handle(request);
    if (request.type === "play.draft.discard")
      return this.#orchestration.discardDraft(request.presetId, request.expectedRevision);
    if (request.type === "play.delete")
      return this.#orchestration.deletePreset(request.presetId);
    if (
      hasCommandPrefix(request, "setting-improvement") ||
      hasCommandPrefix(request, "world.revision")
    )
      return this.#authoringCommands.handle(request);
    if (
      hasCommandPrefix(request, "play") ||
      hasCommandPrefix(request, "prompt") ||
      hasCommandPrefix(request, "world.play-context")
    )
      return this.#playCommands.handle(request, playCallChainObserver);
    if (
      hasCommandPrefix(request, "world") ||
      hasCommandPrefix(request, "artifacts")
    )
      return this.#worldCommands.handle(request);
    if (hasCommandPrefix(request, "content"))
      return handleContentCommand(request, this.#content, this.#locale);
    if (hasCommandPrefix(request, "model"))
      return handleModelCommand(request, this.#models);
    switch (request.type) {
      case "workspace.read":
        return {
          ...(request.scope === "orchestration"
            ? { scope: request.scope }
            : {}),
          preferences: await this.#preferences.view(),
          contentPackages:
            request.scope === "orchestration"
              ? []
              : await this.#content.listCurrentTreeContentPackages(),
          playPresets: await this.#playPresets.list(),
          model: await this.#models.view(),
          worlds:
            request.scope === "orchestration"
              ? []
              : await this.#worlds.listWorlds(),
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
      case "protagonist-templates.read":
        return this.#protagonistTemplates.view();
      case "protagonist-templates.save":
        return this.#protagonistTemplates.save(request);
      case "protagonist-templates.copy":
        return this.#protagonistTemplates.copy(request.id);
      case "protagonist-templates.delete":
        return this.#protagonistTemplates.delete(request.id);
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

  #storageNotices(): { surface: string; message: string }[] {
    const notices = [];
    const recovery = this.#playPresets.recovery;
    if (recovery !== null)
      notices.push({
        surface:
          this.#locale === "zh-CN" ? "编排方案库" : "Orchestration library",
        message:
          this.#locale === "zh-CN"
            ? `无法读取编排方案库。已重建默认库，原始文件备份在 ${recovery.quarantinedPath}（${recovery.message}）。`
            : `The orchestration library could not be read (${recovery.message}). A default library was rebuilt. The original file is backed up at ${recovery.quarantinedPath}.`,
      });
    return notices;
  }
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
