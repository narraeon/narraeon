import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { WorldExtensionsView } from "../../protocol/worldExtensions.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../../protocol/playerViews.ts";
import {
  projectArtifactForFrontend,
  projectDebugArtifactForFrontend,
  type FrontendBundleFailure,
  type FrontendArtifactDebugRecord,
} from "../extension/FrontendExtensionBundle.ts";
import {
  projectPlayerViewPanels,
  type FrontendPlayerViewPanelProjection,
} from "../extension/PlayerViewPanelProjector.ts";
import { PackageScriptPermissions } from "../extension/PackageScriptPermissions.ts";
import type { FileNativeArtifactStore } from "../artifact/FileNativeArtifactStore.ts";
import type { WorldArchives } from "../archive/WorldArchives.ts";
import type { ContentWorkspace } from "../content/ContentWorkspace.ts";
import type { PlayCallChain } from "../play/PlayCallChain.ts";
import type { ModelConnectionStore } from "../model/ModelConnectionStore.ts";
import { FileNativeModelHost } from "../model/FileNativeModelAdapters.ts";
import {
  FileNativePlayPresetError,
  presetHostBinding,
  type FileNativePlayPresetStore,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import { type FileNativeWorldStore } from "../world/FileNativeWorldStore.ts";
import type { WorldRevisionSession } from "../world-revision/WorldRevisionSession.ts";
import { readPlayTimeline, readingCurrentEndpoint } from "./CommandQueries.ts";
import type { CommandFor } from "./Command.ts";

interface WorldCommandsServices {
  worlds: FileNativeWorldStore;
  worldArchives: WorldArchives;
  content: ContentWorkspace;
  models: ModelConnectionStore;
  playPresets: FileNativePlayPresetStore;
  playCallChains: PlayCallChain;
  worldRevisions: WorldRevisionSession;
  artifacts: FileNativeArtifactStore;
  locale: () => AppLocale;
}

export class WorldCommands {
  readonly #services: WorldCommandsServices;

  constructor(services: WorldCommandsServices) {
    this.#services = services;
  }

  async handle(
    request: Exclude<
      CommandFor<"world" | "artifacts">,
      CommandFor<"world.revision" | "world.play-context">
    >,
  ): Promise<unknown> {
    switch (request.type) {
      case "world.package-scripts.read":
        return this.#services.worlds.packageScriptPermissions(request.worldId);
      case "world.package-scripts.set":
        return this.#services.worlds.packageScriptPermissions(
          request.worldId,
          request.enabled,
        );
      case "world.create": {
        const [package_, packageScriptGrants, connection] = await Promise.all([
          this.#services.content.readCurrentTreeContentPackage(
            request.packageId,
          ),
          this.#services.content.readPackageScriptGrants(request.packageId),
          request.model === undefined
            ? null
            : this.#services.models.bindActiveIfPresent(),
        ]);
        return this.#services.worlds.createFromContentPackage({
          operationId: request.operationId,
          sourcePackageId: request.packageId,
          sourcePackageTitle: package_.title,
          packageScriptGrants,
          packageFiles: package_.files,
          ...(connection === null
            ? {}
            : {
                prompt: {
                  hostBinding: presetHostBinding(
                    await this.#services.playPresets.bindCurrent(),
                  ),
                  modelBinding: new FileNativeModelHost(connection).binding(),
                },
              }),
        });
      }
      case "world.creation-outcome":
        return this.#services.worlds.getCreationOutcome(request.operationId);
      case "world.rename":
        return this.#services.worlds.renameWorld(request.worldId, request.name);
      case "world.story.export":
        return this.#services.worlds.exportStory(
          request.worldId,
          request.format,
          this.#services.locale(),
        );
      case "world.delete":
        return this.#services.worlds.deleteWorld(request.worldId, async () => {
          await this.#services.worlds.assertWorldRevisionUnlocked(
            request.worldId,
          );
          await this.#services.playCallChains.abortWorld(request.worldId);
          this.#services.playCallChains.forgetWorld(request.worldId);
        });
      case "world.archive.export":
        return this.#services.worldArchives.exportWorld(request);
      case "world.archive.import":
        return this.#services.worldArchives.importWorld(request);
      case "world.read":
        return readingCurrentEndpoint(async () => {
          const head = await this.#services.worlds.currentHead(request.worldId);
          const playerViews =
            await this.#services.worlds.renderPlayerViewsAtHead(
              request.worldId,
              head,
            );
          const extensionControls = await this.#currentExtensionControls(
            request.worldId,
          );
          const [playerViewPanels, playTimeline, revisionEpoch] =
            await Promise.all([
              this.#frontendPlayerViewPanels(
                request.worldId,
                head,
                playerViews,
                extensionControls,
              ),
              readPlayTimeline(
                this.#services.worlds,
                this.#services.playCallChains,
                request.worldId,
                40,
              ),
              this.#services.worldRevisions.activeEpoch(request.worldId),
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
            extensionControls,
            suppressedPlayerViewIds:
              await this.#suppressedPlayerViewIds(extensionControls),
            artifactDebug: [],
            playCallChain: null,
            playTimeline,
            worldRevision: revisionEpoch,
            archiveNeedsFreshContext:
              await this.#services.worlds.archiveNeedsFreshContext(
                request.worldId,
              ),
          };
        });
      case "world.surface.read":
        return request.surface === "runtime"
          ? this.#services.worlds.readSurface(
              request.worldId,
              "runtime",
              request.head,
            )
          : this.#services.worlds.readSurface(
              request.worldId,
              request.surface,
              request.head,
            );
      case "world.extensions.read":
        return this.#services.worlds.extensionControls(
          request.worldId,
          await this.#services.playPresets.bindCurrent(),
          this.#services.locale(),
        );
      case "world.extensions.set": {
        const result = await this.#services.worlds.extensionControls(
          request.worldId,
          await this.#services.playPresets.bindCurrent(),
          this.#services.locale(),
          request,
        );
        return result;
      }
      case "world.play-decorations.read":
        return readingCurrentEndpoint(async () => {
          for (;;) {
            const extensionControls = await this.#currentExtensionControls(
              request.worldId,
            );
            const head = await this.reconcileArtifacts(request.worldId);
            const [projection, artifactDebug] = await Promise.all([
              this.#frontendDecorations(request.worldId),
              this.#frontendDebug(request.worldId),
            ]);
            const playerViews =
              await this.#services.worlds.renderPlayerViewsAtHead(
                request.worldId,
                head,
              );
            const playerViewPanels = await this.#frontendPlayerViewPanels(
              request.worldId,
              head,
              playerViews,
              extensionControls,
            );
            const suppressedPlayerViewIds =
              await this.#suppressedPlayerViewIds(extensionControls);
            // Never attach a newer controls revision to a projection read before
            // that choice was accepted. Concurrent toggles restart this read.
            if (
              (await this.#services.worlds.extensionControlsRevision(
                request.worldId,
              )) !== extensionControls.revision
            )
              continue;
            return {
              head,
              ...projection,
              artifactDebug,
              playerViews,
              playerViewPanels,
              extensionControls,
              suppressedPlayerViewIds,
            };
          }
        });
      case "artifacts.read":
        await this.reconcileArtifacts(request.worldId);
        return (
          await this.#frontendDecorations(request.worldId, request.channel)
        ).artifacts;
      case "artifacts.debug":
        await this.reconcileArtifacts(request.worldId);
        return this.#frontendDebug(request.worldId, request.operationId);
      case "world.control-draft.save":
        await this.#services.worlds.assertWorldRevisionUnlocked(
          request.worldId,
        );
        return this.#services.worlds.saveControlDraft(
          request.worldId,
          request.files,
        );
      case "world.control-draft.preview": {
        const prompt = {
          ...(await this.#promptBinding()),
          playerInput:
            this.#services.locale() === "zh-CN"
              ? "预览世界控制。"
              : "Preview world control.",
        };
        return this.#services.worlds.previewControlDraft(
          request.worldId,
          prompt,
          request.expectedFingerprint,
        );
      }
      case "world.control-draft.apply": {
        const prompt = {
          ...(await this.#promptBinding()),
          playerInput:
            this.#services.locale() === "zh-CN"
              ? "预览世界控制。"
              : "Preview world control.",
        };
        return this.#services.worlds.applyControlDraft(
          request.worldId,
          prompt,
          request.expectedFingerprint,
        );
      }
      case "world.derive": {
        const locale = this.#services.locale();
        const preset = await this.#services.playPresets.bindCurrent();
        const result = await this.#services.playCallChains.deriveWorld({
          operationId: request.operationId,
          sourceWorldId: request.sourceWorldId,
          sourceHead: request.sourceHead,
          hostPresetId: preset.id,
          locale,
        });
        await this.#reconcileResultArtifacts(result);
        return { outcome: result.outcome, world: result.world };
      }
    }
  }
  async reconcileArtifacts(worldId: string): Promise<string> {
    const { head, operationId } =
      await this.#services.worlds.currentEndpoint(worldId);
    await this.#services.artifacts.reconcileHead(
      worldId,
      head,
      operationId ?? undefined,
    );
    return head;
  }

  async #frontendDecorations(worldId: string, channel?: string) {
    await this.#currentExtensionControls(worldId);
    const summaries =
      await this.#services.artifacts.readExtensionSummaries(worldId);
    const targets = await this.#services.worlds.playTimeline.resolveReplies(
      worldId,
      summaries.flatMap((item) =>
        item.attachment === undefined ? [] : [item.attachment],
      ),
    );
    const matches = (attachment: {
      contextId: string;
      eventId: number;
      head: string;
    }) =>
      targets.find(
        (target) =>
          target.contextId === attachment.contextId &&
          target.eventId === attachment.eventId &&
          target.head === attachment.head,
      );
    const extensions = summaries
      .filter(
        (item) =>
          item.attachment === undefined ||
          matches(item.attachment) !== undefined,
      )
      .sort(
        (left, right) =>
          Number(left.head?.replace("commit:", "") ?? 0) -
          Number(right.head?.replace("commit:", "") ?? 0),
      );
    const artifacts = await this.#services.artifacts.readActiveProjection(
      worldId,
      channel,
      targets,
    );
    const projected = (
      await Promise.all(
        artifacts.map(async (artifact) => {
          const { renderer, ...safeArtifact } = artifact;
          void renderer;
          const resolved = await this.#frontendBinding(
            artifact.playPresetId,
            artifact.playPresetRevision,
          );
          return {
            ...safeArtifact,
            ...(artifact.attachment === undefined
              ? {}
              : {
                  reply: matches(artifact.attachment)!,
                }),
            frontend: projectArtifactForFrontend(
              artifact,
              resolved.binding,
              resolved.failure,
              artifact.requestId.startsWith("package:") &&
                artifact.frozenPresentation !== undefined &&
                (
                  await this.#services.worlds.readPackageScriptGrants(worldId)
                ).includes(
                  PackageScriptPermissions.fingerprint(
                    artifact.frozenPresentation.files,
                  ),
                ),
            ),
          };
        }),
      )
    ).filter(
      (artifact) =>
        artifact.frontend.mount !== "story" || artifact.reply !== undefined,
    );
    return { artifacts: projected, extensions };
  }

  async #currentExtensionControls(
    worldId: string,
  ): Promise<WorldExtensionsView> {
    try {
      return await this.#services.worlds.extensionControls(
        worldId,
        await this.#services.playPresets.bindCurrent(),
        this.#services.locale(),
      );
    } catch (error) {
      if (!(error instanceof FileNativePlayPresetError)) throw error;
      return {
        revision:
          await this.#services.worlds.extensionControlsRevision(worldId),
        items: [],
      };
    }
  }

  async #suppressedPlayerViewIds(
    controls: WorldExtensionsView,
  ): Promise<string[]> {
    let binding: PlayPresetBinding;
    try {
      binding = await this.#services.playPresets.bindCurrent();
    } catch (error) {
      if (error instanceof FileNativePlayPresetError) return [];
      throw error;
    }
    // Every declared panel owns its view's fallback even while hidden.
    return [
      ...new Set([
        ...binding.definition.playerViewPanels.map(
          (panel) => panel.source.view,
        ),
        ...controls.items
          .filter((item) => item.kind === "view" && !item.enabled)
          .map((item) => item.id),
      ]),
    ];
  }

  async #frontendPlayerViewPanels(
    worldId: string,
    head: string,
    playerViews: {
      views: RenderedPlayerView[];
      diagnostics: PlayerViewDiagnostic[];
    },
    controls: WorldExtensionsView,
  ): Promise<FrontendPlayerViewPanelProjection[]> {
    try {
      const binding = await this.#services.playPresets.bindCurrent();
      return projectPlayerViewPanels({
        worldId,
        head,
        playerViews,
        binding,
      }).filter((panel) =>
        controls.items.some(
          (item) =>
            item.kind === "panel" && item.id === panel.panelId && item.enabled,
        ),
      );
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
    const records = await this.#services.artifacts.readDebug(
      worldId,
      operationId,
    );
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
            record.requestId.startsWith("package:") &&
              record.frozenPresentation !== undefined &&
              (
                await this.#services.worlds.readPackageScriptGrants(worldId)
              ).includes(
                PackageScriptPermissions.fingerprint(
                  record.frozenPresentation.files,
                ),
              ),
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
        binding: await this.#services.playPresets.bindRevision(id, revision),
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
    await this.reconcileArtifacts(worldId);
  }

  async #promptBinding() {
    const [preset, connection] = await Promise.all([
      this.#services.playPresets.bindCurrent(),
      this.#services.models.bind(),
    ]);
    const modelHost = new FileNativeModelHost(connection);
    return {
      hostBinding: presetHostBinding(preset),
      modelBinding: modelHost.binding(),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
