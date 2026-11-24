import { type SettingImprovementSession } from "../setting/SettingImprovementSession.ts";
import { type WorldRevisionSession } from "../world-revision/WorldRevisionSession.ts";
import type { CommandFor } from "./Command.ts";

interface AuthoringCommandsServices {
  settingImprovements: SettingImprovementSession;
  worldRevisions: WorldRevisionSession;
  reconcileArtifacts: (worldId: string) => Promise<string>;
}

export class AuthoringCommands {
  readonly #services: AuthoringCommandsServices;

  constructor(services: AuthoringCommandsServices) {
    this.#services = services;
  }

  async handle(
    request: CommandFor<"setting-improvement" | "world.revision">,
  ): Promise<unknown> {
    switch (request.type) {
      case "setting-improvement.preview":
        return this.#services.settingImprovements.preview(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.call.context":
        return this.#services.settingImprovements.readCallContext(
          request.packageId,
          request.sessionId,
          request.callId,
        );
      case "setting-improvement.request.preview":
        return (
          (
            await this.#services.settingImprovements.readRequestPreviews(
              request.packageId,
              request.sessionId,
            )
          ).find(({ requestId }) => requestId === request.requestId) ?? null
        );
      case "setting-improvement.read":
        return this.#services.settingImprovements.read(request.packageId);
      case "setting-improvement.status":
        return this.#services.settingImprovements.status(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.overview":
        return this.#services.settingImprovements.overview(request.packageId);
      case "setting-improvement.session.read":
        return this.#services.settingImprovements.readSession(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.session.delete":
        return this.#services.settingImprovements.deleteSession(
          request.packageId,
          request.sessionId,
        );
      case "setting-improvement.rollback":
        return this.#services.settingImprovements.rollback(request);
      case "setting-improvement.message":
        return this.#services.settingImprovements.send(request);
      case "setting-improvement.message.edit":
        return this.#services.settingImprovements.editMessage(request);
      case "setting-improvement.cancel":
        return this.#services.settingImprovements.cancel(request.sessionId);
      case "setting-improvement.resume":
        return this.#services.settingImprovements.resume(request);
      case "world.revision.open":
        return this.#services.worldRevisions.open(request.worldId);
      case "world.revision.overview":
        return this.#services.worldRevisions.overview(request.worldId);
      case "world.revision.preview":
        return this.#services.worldRevisions.preview(
          request.worldId,
          request.sessionId,
        );
      case "world.revision.call.context":
        return this.#services.worldRevisions.readCallContext(
          request.worldId,
          request.sessionId,
          request.callId,
        );
      case "world.revision.request.preview":
        return (
          (
            await this.#services.worldRevisions.readRequestPreviews(
              request.worldId,
              request.sessionId,
            )
          ).find(({ requestId }) => requestId === request.requestId) ?? null
        );
      case "world.revision.status":
        return this.#services.worldRevisions.status(
          request.worldId,
          request.sessionId,
        );
      case "world.revision.session.read":
        return this.#services.worldRevisions.readSession(
          request.worldId,
          request.sessionId,
        );
      case "world.revision.session.delete":
        return this.#services.worldRevisions.deleteSession(
          request.worldId,
          request.sessionId,
        );
      case "world.revision.message":
        return this.#services.worldRevisions.send(request);
      case "world.revision.message.edit":
        return this.#services.worldRevisions.editMessage(request);
      case "world.revision.cancel":
        return this.#services.worldRevisions.cancel(request.sessionId);
      case "world.revision.resume":
        return this.#services.worldRevisions.resume(request);
      case "world.revision.files.replace":
        return this.#services.worldRevisions.replaceFiles(request);
      case "world.revision.rollback":
        return this.#services.worldRevisions.rollback(request);
      case "world.revision.apply": {
        const result = await this.#services.worldRevisions.apply(request);
        await this.#services.reconcileArtifacts(request.worldId);
        return result;
      }
      case "world.revision.discard":
        return this.#services.worldRevisions.discard(request);
    }
  }
}
