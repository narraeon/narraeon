import type { OrchestrationEditorSession } from "../orchestration/OrchestrationEditorSession.ts";
import { previewOrchestration } from "../play/OrchestrationPreview.ts";
import { V1ProtocolError } from "../../protocol/v1.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  prepareSillyTavernPresetImport,
  inspectSillyTavernPreset,
} from "../../shared/sillytavern-preset.ts";
import type { ContentWorkspace } from "../content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../content/FileNativeContentTree.ts";
import { FileNativeModelHost } from "../model/FileNativeModelAdapters.ts";
import {
  ModelConnectionUnavailableError,
  type ModelConnectionStore,
} from "../model/ModelConnectionStore.ts";
import { PlayCallChainError } from "../play/PlayCallChainError.ts";
import type { ModelHostBinding } from "../model/ModelHost.ts";
import type {
  PlayCallChain,
  PlayCallChainObserver,
} from "../play/PlayCallChain.ts";
import {
  parsePlayPresetFiles,
  presetHostBinding,
  toPlayPresetStructuredEditor,
  type FileNativePlayPresetStore,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import { buildPlayPresetWorkbenchSnapshot } from "../play/PlayPresetWorkbench.ts";
import { fingerprintControl } from "../play/PlayDocumentTools.ts";
import type { FileNativePromptCompiler } from "../prompt/FileNativePromptCompiler.ts";
import { comparePromptPrefixes } from "../prompt/WorldPromptDiagnostics.ts";
import type { FileNativeWorldStore } from "../world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";
import { readPlayTimeline, readingCurrentEndpoint } from "./CommandQueries.ts";
import type { CommandFor } from "./Command.ts";

interface PlayCommandsServices {
  orchestrationSessions: Pick<
    OrchestrationEditorSession,
    "discardDraft" | "deletePreset"
  >;
  worlds: FileNativeWorldStore;
  content: ContentWorkspace;
  models: ModelConnectionStore;
  playPresets: FileNativePlayPresetStore;
  playCallChains: PlayCallChain;
  compiler: FileNativePromptCompiler;
  locale: () => AppLocale;
  modelHost: () => Promise<FileNativeModelHost>;
  reconcileArtifacts: (worldId: string) => Promise<string>;
}

export class PlayCommands {
  readonly #services: PlayCommandsServices;

  constructor(services: PlayCommandsServices) {
    this.#services = services;
  }

  async handle(
    request: CommandFor<"play" | "prompt" | "world.play-context">,
    playCallChainObserver?: PlayCallChainObserver,
  ): Promise<unknown> {
    switch (request.type) {
      case "play.read":
        return this.#services.playPresets.list();
      case "play.create":
        return this.#services.playPresets.create(request.name, request.files);
      case "play.copy":
        return this.#services.playPresets.copy(request.presetId);
      case "play.save":
        return this.#services.playPresets.save(request);
      case "play.draft.discard":
        return this.#services.orchestrationSessions.discardDraft(
          request.presetId,
          request.expectedRevision,
        );
      case "play.rename":
        return this.#services.playPresets.rename(
          request.presetId,
          request.name,
        );
      case "play.delete":
        return this.#services.orchestrationSessions.deletePreset(
          request.presetId,
        );
      case "play.enable":
        return this.#services.playPresets.setEnabled(
          request.presetId,
          request.enabled,
        );
      case "play.scripts":
        return this.#services.playPresets.setScriptsEnabled(
          request.presetId,
          request.enabled,
        );
      case "play.select":
        return this.#services.playPresets.select(request.presetId);
      case "play.export":
        return {
          files: await this.#services.playPresets.exportPortable(
            request.presetId,
          ),
        };
      case "play.import":
        return this.#services.playPresets.importPortable(request);
      case "play.sillytavern.source.read":
        return this.#services.playPresets.readSillyTavernSource(
          request.presetId,
        );
      case "play.sillytavern.inspect":
      case "play.sillytavern.preview":
      case "play.sillytavern.import":
      case "play.sillytavern.source.associate": {
        // Do not trust the browser to enforce the import limit or supply
        // already-converted files. Preview and import both parse from source.
        if (Buffer.byteLength(request.source, "utf8") > 2 * 1024 * 1024)
          throw new V1ProtocolError(
            "invalid_request",
            "SillyTavern source exceeds the size limit",
          );
        if (
          (request.type === "play.sillytavern.preview" ||
            request.type === "play.sillytavern.import") &&
          (request.selected.length > 4096 ||
            request.selected.reduce(
              (bytes, id) => bytes + Buffer.byteLength(id, "utf8"),
              0,
            ) >
              2 * 1024 * 1024)
        )
          throw new V1ProtocolError(
            "invalid_request",
            "SillyTavern selection exceeds the size limit",
          );
        try {
          if (request.type === "play.sillytavern.inspect")
            return inspectSillyTavernPreset(request.source, request.groupId);
          if (request.type === "play.sillytavern.source.associate")
            return await this.#services.playPresets.associateSillyTavernSource(
              request.presetId,
              request.source,
            );
          const { conversion, snapshot } = prepareSillyTavernPresetImport(
            request.source,
            {
              groupId: request.groupId,
              selected: request.selected,
              name: request.name,
              locale: this.#services.locale(),
            },
          );
          if (request.type === "play.sillytavern.preview") {
            const parsed = parsePlayPresetFiles(conversion.files);
            if (parsed.kind === "invalid") throw parsed.error;
            toPlayPresetStructuredEditor(parsed.definition);
            return conversion;
          }
          return await this.#services.playPresets.importSillyTavern({
            name: request.name,
            files: conversion.files,
            snapshot,
            ...(request.operationId === undefined
              ? {}
              : { operationId: request.operationId }),
          });
        } catch (error) {
          if (error instanceof V1ProtocolError) throw error;
          throw new V1ProtocolError(
            "invalid_request",
            error instanceof Error
              ? error.message
              : "Invalid SillyTavern preset",
          );
        }
      }
      case "play.orchestration.provenance.read":
        return (
          (
            await this.#services.playPresets.readOrchestrationProvenance(
              request.presetId,
              request.revision,
              request.target,
            )
          ).find(
            ({ surface, entryId }) =>
              surface === request.surface && entryId === request.entryId,
          ) ?? null
        );
      case "play.orchestration.preview":
        return previewOrchestration(
          {
            playPresets: this.#services.playPresets,
            models: this.#services.models,
            locale: this.#services.locale(),
          },
          request,
        );
      case "play.workbench.read": {
        const binding =
          request.presetId === undefined
            ? await this.#services.playPresets.bindCurrent()
            : await this.#services.playPresets.bindRevision(
                request.presetId,
                request.revision,
              );
        if (request.worldId === undefined)
          return buildPlayPresetWorkbenchSnapshot(
            binding,
            undefined,
            request.draft,
          );
        const { worldId } = request;
        return readingCurrentEndpoint(async () => {
          const head = await this.#services.worlds.currentHead(worldId);
          const playerViews =
            await this.#services.worlds.renderPlayerViewsAtHead(worldId, head);
          return buildPlayPresetWorkbenchSnapshot(
            binding,
            { worldId, head, playerViews },
            request.draft,
          );
        });
      }
      case "prompt.preview": {
        const [package_, connection, playPreset] = await Promise.all([
          this.#services.content.readCurrentTreeContentPackage(
            request.packageId,
          ),
          this.#services.models.bind(),
          request.playPresetId === undefined
            ? this.#services.playPresets.bindCurrent()
            : this.#services.playPresets.bindRevision(
                request.playPresetId,
                request.playPresetRevision,
              ),
        ]);
        const hostBinding = presetHostBinding(playPreset);
        const modelHost = new FileNativeModelHost(connection);
        const preview = this.#services.compiler.preview(
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
            ...(request.turnNote === undefined
              ? {}
              : { turnNote: request.turnNote }),
            modelBinding: modelHost.binding(),
            modelPrompt: modelHost.modelPrompt(),
          },
          playPreset,
        );
        const tools = structuredClone(preview.compilation.tools);
        return {
          ...preview,
          wireRequest: modelHost.previewRequest({
            bootstrap: structuredClone(preview.compilation),
            tools: structuredClone(tools),
            toolUniverse: structuredClone(
              preview.compilation.toolUniverse ?? tools,
            ),
            allowedTools: tools.map(({ name }) => name),
            toolStrategy: preview.compilation.toolStrategy,
            appended:
              preview.initialAppend === undefined
                ? []
                : [
                    ...(preview.initialAppend.beforePlayer === undefined
                      ? []
                      : [preview.initialAppend.beforePlayer.logical]),
                    preview.initialAppend.logical,
                    ...(preview.initialAppend.afterPlayer === undefined
                      ? []
                      : [preview.initialAppend.afterPlayer.logical]),
                  ],
            requestId: "play_call_chain",
            operationId: "prompt-preview",
            requestAttempt: 1,
            exchange: 1,
            maxOutputTokens: modelHost.binding().maxOutputTokens,
          }),
        };
      }
      case "play.chain.revise-player": {
        const base = {
          operationId: request.operationId,
          worldId: request.worldId,
          chainId: request.chainId,
          eventId: request.eventId,
          replacementExchangeId: request.replacementExchangeId,
          replacementText: request.replacementText,
          ...(request.turnNote === undefined
            ? {}
            : { turnNote: request.turnNote }),
        };
        await this.#services.worlds.assertWorldRevisionUnlocked(
          request.worldId,
        );
        const automatic = request.continuation === "auto";
        const automaticModel = automatic
          ? await this.#services.modelHost().catch((error: unknown) => {
              if (error instanceof ModelConnectionUnavailableError)
                return undefined;
              throw error;
            })
          : undefined;
        const continuation =
          request.continuation === "auto"
            ? await this.#services.playCallChains.automaticPlayerRevisionMode({
                ...base,
                ...(automaticModel === undefined
                  ? {}
                  : { modelHost: automaticModel }),
              })
            : request.continuation;
        if (
          automatic &&
          automaticModel === undefined &&
          continuation === "fresh_context"
        )
          throw PlayCallChainError.requiresFreshContext(
            this.#services.locale() === "en"
              ? "This edit needs a new conversation. Configure a model before saving the edit."
              : "这次修改需要开启新对话。请先配置模型，再保存修改。",
          );
        const needsBinding =
          continuation === "fresh_context" ||
          (request.sendAfterRevision === true &&
            (!automatic || automaticModel !== undefined));
        const binding = needsBinding
          ? await this.#continuousBinding(automaticModel)
          : null;
        const modelHost =
          automaticModel ??
          binding?.modelHost ??
          (!automatic && request.requireCompatible === true
            ? await this.#services.modelHost()
            : undefined);
        const revision =
          binding !== null && continuation === "fresh_context"
            ? ({
                ...base,
                continuation,
                freshContext: {
                  hostBinding: binding.hostBinding,
                  playPreset: binding.playPreset,
                  modelBinding: binding.modelBinding,
                  modelPrompt: binding.modelHost.modelPrompt(),
                },
              } as const)
            : ({
                ...base,
                continuation: "continue_context",
                ...(modelHost === undefined ? {} : { modelHost }),
              } as const);
        const revised =
          request.sendAfterRevision === true && binding !== null
            ? await this.#services.playCallChains.reviseAndAppend(
                revision,
                binding.modelHost,
                () => Promise.resolve(binding),
              )
            : await this.#services.playCallChains.revisePlayer(revision);
        await this.#services.reconcileArtifacts(request.worldId);
        return { ...revised, continuation: revision.continuation };
      }
      case "play.chain.regenerate-narrative": {
        await this.#services.worlds.assertWorldRevisionUnlocked(
          request.worldId,
        );
        return this.#services.playCallChains.regenerateNarrative({
          ...request,
          modelHost: await this.#services.modelHost(),
        });
      }
      case "play.chain.start": {
        await this.#services.worlds.assertWorldRevisionUnlocked(
          request.worldId,
        );
        const { modelHost, hostBinding, playPreset, modelBinding } =
          await this.#continuousBinding();
        return this.#services.playCallChains.start({
          worldId: request.worldId,
          chainId: request.chainId,
          exchangeId: request.exchangeId,
          playerText: request.playerText,
          ...(request.turnNote === undefined
            ? {}
            : { turnNote: request.turnNote }),
          hostBinding,
          playPreset,
          modelBinding,
          modelHost,
          ...(playCallChainObserver === undefined
            ? {}
            : { observer: playCallChainObserver }),
        });
      }
      case "play.chain.append": {
        await this.#services.worlds.assertWorldRevisionUnlocked(
          request.worldId,
        );
        return this.#services.playCallChains.append({
          worldId: request.worldId,
          chainId: request.chainId,
          exchangeId: request.exchangeId,
          playerText: request.playerText,
          ...(request.recovery === undefined
            ? {}
            : { recovery: request.recovery }),
          ...(request.turnNote === undefined
            ? {}
            : { turnNote: request.turnNote }),
          modelHost: await this.#services.modelHost(),
          resolvePrompt: () => this.#playPromptBinding(),
          ...(playCallChainObserver === undefined
            ? {}
            : { observer: playCallChainObserver }),
        });
      }
      case "play.chain.cancel":
        return this.#services.playCallChains.cancel({
          worldId: request.worldId,
          chainId: request.chainId,
          exchangeId: request.exchangeId,
        });
      case "play.chain.inspect":
        return this.#services.playCallChains.inspectWorld(request.worldId);
      case "play.timeline.page":
        await this.#services.worlds.ensureCurrentStorage(request.worldId);
        return readPlayTimeline(
          this.#services.worlds,
          this.#services.playCallChains,
          request.worldId,
          request.limit,
          request.cursor,
        );
      case "play.timeline.detail":
        await this.#services.worlds.ensureCurrentStorage(request.worldId);
        return this.#services.worlds.playTimeline.readDetail(
          request.worldId,
          request.chainId,
          request.eventId,
        );
      case "play.timeline.context":
        await this.#services.worlds.ensureCurrentStorage(request.worldId);
        return this.#services.worlds.playTimeline.readRequestContext(
          request.worldId,
          request.chainId,
          request.eventId,
        );
      case "world.play-context.read": {
        const binding = await this.#services.worlds.bindPlayCallChain(
          request.worldId,
        );
        const currentContext =
          await this.#services.playCallChains.inspectReading(
            request.worldId,
            binding.parentHead,
          );
        const model = await this.#services.models.view();
        if (!model.configured)
          return {
            worldId: request.worldId,
            worldHead: binding.parentHead,
            currentContext,
            nextFreshContext: null,
          };
        const { modelHost, hostBinding, playPreset, modelBinding } =
          await this.#continuousBinding();
        const live =
          currentContext === null
            ? null
            : await this.#services.playCallChains.currentContinuation(
                request.worldId,
              );
        const frozenBinding = live?.modelBinding;
        const continueContext =
          currentContext !== null &&
          !currentContext.stale &&
          frozenBinding?.provider === modelBinding.provider;
        const baseline = continueContext
          ? await this.#services.worlds.bindPlayCallChainAt(
              request.worldId,
              currentContext.baselineHead,
            )
          : binding;
        const preview = this.#services.compiler.preview(
          {
            ...(continueContext && live !== null
              ? { frozenWorldContext: live.bootstrap }
              : {}),
            extensionControls: await this.#services.worlds.extensionControls(
              request.worldId,
              playPreset,
              this.#services.locale(),
            ),
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
              historyBackgrounds: structuredClone(
                binding.historyBackgrounds ?? {},
              ),
              narrativeCheckpoint: baseline.narrativeCheckpoint,
              historyAlreadyAppended: Object.keys(binding.history).filter(
                (key) => !(key in baseline.history),
              ),
              ...(await this.#services.worlds.inspectDocumentMaintenance(
                request.worldId,
                binding.parentHead,
              )),
            },
            playerInputPlacement: "append",
            playerInput: "",
            modelBinding,
            modelPrompt: modelHost.modelPrompt(),
          },
          playPreset,
        );
        const tools = preview.compilation.tools;
        const nextEncoding = modelHost.previewRequest({
          bootstrap: preview.compilation,
          tools,
          toolUniverse: preview.compilation.toolUniverse,
          allowedTools: tools.map(({ name }) => name),
          toolStrategy: preview.compilation.toolStrategy,
          appended: continueContext ? (live?.transcript ?? []) : [],
          operationId: continueContext
            ? currentContext.chainId
            : "next-fresh-context-preview",
          maxOutputTokens: modelBinding.maxOutputTokens,
        });
        const currentEncoding =
          currentContext === null
            ? null
            : await this.#services.worlds.playTimeline
                .readInitialEncoding(
                  request.worldId,
                  currentContext.chainId,
                  currentContext.requestExchange,
                )
                .catch(() => null);
        const prefixDiagnostics = comparePromptPrefixes(
          currentContext === null
            ? null
            : {
                bootstrap: currentContext.bootstrap,
                encoding: currentEncoding,
              },
          { bootstrap: preview.compilation, encoding: nextEncoding },
        );
        return {
          worldId: request.worldId,
          worldHead: binding.parentHead,
          currentContext,
          nextFreshContext: {
            contextMode: continueContext ? "append" : "fresh",
            head: binding.parentHead,
            preview,
            prefixDiagnostics,
          },
        };
      }
    }
  }
  async #playPromptBinding() {
    const playPreset = await this.#services.playPresets.freeze();
    return { hostBinding: presetHostBinding(playPreset), playPreset };
  }

  async #continuousBinding(model?: FileNativeModelHost): Promise<{
    modelHost: FileNativeModelHost;
    hostBinding: { hostPresetId: string; files: Record<string, string> };
    playPreset: PlayPresetBinding;
    modelBinding: ModelHostBinding;
  }> {
    const [modelHost, prompt] = await Promise.all([
      model ?? this.#services.modelHost(),
      this.#playPromptBinding(),
    ]);
    return {
      modelHost,
      ...prompt,
      modelBinding: modelHost.binding(),
    };
  }
}

export function previewWorld(
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
