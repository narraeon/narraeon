import { join } from "node:path";
import {
  requestControlKey,
  type WorldExtensionControl,
} from "../../protocol/worldExtensions.ts";
import { WorldExtensionControls } from "./WorldExtensionControls.ts";

/** Cancellation is best effort; persisted generations remain the visibility authority. */
export class WorldExtensionRequests {
  readonly #root: string;
  readonly #active = new Set<{
    worldId: string;
    control: WorldExtensionControl;
    controller: AbortController;
  }>();
  constructor(worldsRoot: string) {
    this.#root = worldsRoot;
  }
  async visible(
    worldId: string,
    record: {
      playPresetId: string;
      requestId: string;
      extensionControl?: WorldExtensionControl;
    },
  ): Promise<boolean> {
    const control = record.extensionControl ?? {
      key: requestControlKey(record.playPresetId, record.requestId),
      generation: 0,
    };
    const state = await WorldExtensionControls.read(join(this.#root, worldId));
    const current = state.entries[control.key];
    return current === undefined
      ? control.generation === 0
      : current.enabled && current.generation === control.generation;
  }
  async changed(worldId: string): Promise<void> {
    for (const active of this.#active) {
      if (active.worldId !== worldId) continue;
      if (
        !(await this.visible(worldId, {
          playPresetId: "",
          requestId: "",
          extensionControl: active.control,
        }))
      )
        active.controller.abort();
    }
  }
  async acquire(
    worldId: string,
    record: {
      playPresetId: string;
      requestId: string;
      extensionControl?: WorldExtensionControl;
    },
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const entry = {
      worldId,
      control: record.extensionControl ?? {
        key: requestControlKey(record.playPresetId, record.requestId),
        generation: 0,
      },
      controller,
    };
    this.#active.add(entry);
    // Register before reading, so a concurrent accepted change cannot slip between
    // the persisted check and dispatch registration.
    try {
      if (!(await this.visible(worldId, record))) controller.abort();
      return {
        signal:
          signal === undefined
            ? controller.signal
            : AbortSignal.any([signal, controller.signal]),
        release: () => {
          this.#active.delete(entry);
        },
      };
    } catch (error) {
      this.#active.delete(entry);
      throw error;
    }
  }
}
