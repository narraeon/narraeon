import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorldExtensionChoice,
  WorldExtensionItem,
  WorldExtensionsView,
} from "../../protocol/worldExtensions.ts";
import { requestControlKey } from "../../protocol/worldExtensions.ts";
import type { PlayPresetBinding } from "../play/FileNativePlayPresetStore.ts";
import {
  builtinFollowupExample,
  defaultFollowupItems,
} from "../../shared/ordered-followups.ts";
import { readPackageFollowups } from "../content/PackageFollowups.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import type { RenderedPlayerView } from "../../protocol/playerViews.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";

type Definition = Omit<
  WorldExtensionItem,
  "selected" | "enabled" | "overridden" | "generation"
>;
interface Entry {
  generation: number;
  override?: boolean;
  enabled: boolean;
}
interface State {
  schemaVersion: 1;
  revision: number;
  entries: Record<string, Entry>;
}
const fileName = "extension-controls.json";

/** Caller serializes mutations with the existing world lock; no Authority facts are changed. */
export class WorldExtensionControls {
  static async read(root: string): Promise<State> {
    try {
      const state: unknown = JSON.parse(
        await readFile(join(root, fileName), "utf8"),
      );
      if (!isState(state)) throw new Error("Invalid world extension controls");
      return state;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { schemaVersion: 1, revision: 0, entries: {} };
      throw error;
    }
  }
  static async write(root: string, state: State): Promise<void> {
    const path = join(root, fileName);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  static async copy(sourceRoot: string, targetRoot: string): Promise<void> {
    await this.write(targetRoot, await this.read(sourceRoot));
  }
  static async resolve(
    root: string,
    definitions: Definition[],
    _presetId: string,
    change?: { key: string; value: WorldExtensionChoice },
  ): Promise<WorldExtensionsView> {
    const state = await this.read(root);
    const before = JSON.stringify(state.entries);
    for (const definition of definitions)
      if (!Object.hasOwn(state.entries, definition.key)) {
        const group = definitions.find((item) => item.key === definition.group);
        const enabled =
          definition.defaultEnabled &&
          (group === undefined ||
            (state.entries[group.key]?.override ?? group.defaultEnabled));
        state.entries[definition.key] = {
          generation: enabled ? 0 : 1,
          // Defaults select the next run; only world commands revoke frozen runs.
          enabled:
            group === undefined || state.entries[group.key]?.enabled !== false,
        };
      }
    if (change) {
      if (!definitions.some((item) => item.key === change.key))
        throw new Error("The extension definition no longer exists");
      const entry = state.entries[change.key] ?? {
        generation: 0,
        enabled: false,
      };
      if (change.value === "default") delete entry.override;
      else entry.override = change.value === "on";
      state.entries[change.key] = entry;
    }
    const selected = (definition: Definition) =>
      state.entries[definition.key]?.override ?? definition.defaultEnabled;
    const items = definitions.map((definition) => {
      const group = definitions.find((item) => item.key === definition.group);
      const enabled =
        selected(definition) && (group === undefined || selected(group));
      const previous = state.entries[definition.key];
      const affected =
        change !== undefined &&
        (definition.key === change.key || definition.group === change.key);
      const gateEnabled = affected
        ? enabled
        : enabled || (previous?.enabled ?? true);
      const entry: Entry = {
        generation:
          (previous?.generation ?? 0) +
          (previous?.enabled === true && !gateEnabled ? 1 : 0),
        enabled: gateEnabled,
        ...(previous?.override === undefined
          ? {}
          : { override: previous.override }),
      };
      state.entries[definition.key] = entry;
      return {
        ...definition,
        selected: selected(definition),
        enabled,
        overridden: entry.override !== undefined,
        generation: entry.generation,
      };
    });
    // Removing a source definition also belongs to the next run. Retain its
    // frozen generation; an explicit package-group close still revokes all children.
    if (
      change?.key === "group:package" &&
      state.entries[change.key]?.enabled === false
    )
      for (const [key, entry] of Object.entries(state.entries))
        if (key.startsWith("package:") && entry.enabled) {
          entry.enabled = false;
          entry.generation++;
        }
    if (before !== JSON.stringify(state.entries)) {
      state.revision++;
      await this.write(root, state);
    }
    return { revision: state.revision, items };
  }
}

export function extensionDefinitions(
  binding: PlayPresetBinding,
  files: readonly ContentTreeFile[],
  views: readonly RenderedPlayerView[],
  locale: AppLocale,
): Definition[] {
  const items: Definition[] = [];
  for (const item of binding.definition.followupItems ??
    defaultFollowupItems(binding.definition.followups)) {
    const group = item.kind === "content-package";
    const request = binding.definition.followups.find(
      (def) => def.id === item.id,
    );
    items.push({
      key: group ? "group:package" : requestControlKey(binding.id, item.id),
      id: item.id,
      name: group
        ? locale === "zh-CN"
          ? "内容包后置请求"
          : "Content package requests"
        : item.kind === "builtin"
          ? builtinFollowupExample(locale).definition.displayName
          : request!.displayName,
      kind: group ? "group" : "request",
      source: group
        ? "package"
        : item.kind === "builtin"
          ? "builtin"
          : "preset",
      defaultEnabled: item.enabled,
    });
    if (group)
      for (const child of readPackageFollowups(files).followups)
        items.push({
          key: `package:${child.definition.id}`,
          id: `package:${child.definition.id}`,
          name: child.definition.displayName,
          kind: "request",
          source: "package",
          group: "group:package",
          defaultEnabled: child.enabled,
        });
  }
  for (const panel of binding.definition.playerViewPanels)
    items.push({
      key: `preset:${binding.id}:panel:${panel.id}`,
      id: panel.id,
      name:
        panel.config.title ??
        views.find((view) => view.id === panel.source.view)?.title ??
        panel.source.view,
      kind: "panel",
      source: "preset",
      defaultEnabled: true,
    });
  const covered = new Set(
    binding.definition.playerViewPanels.map((panel) => panel.source.view),
  );
  for (const view of views)
    if (!covered.has(view.id))
      items.push({
        key: `view:${view.id}`,
        id: view.id,
        name: view.title,
        kind: "view",
        source: "world",
        defaultEnabled: true,
      });
  return items;
}
function isState(value: unknown): value is State {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !("entries" in value) ||
    typeof value.entries !== "object" ||
    value.entries === null ||
    Array.isArray(value.entries) ||
    Object.keys(value).length !== 3
  )
    return false;
  return Object.values(value.entries).every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "generation" in entry &&
      Number.isSafeInteger(entry.generation) &&
      Number(entry.generation) >= 0 &&
      "enabled" in entry &&
      typeof entry.enabled === "boolean" &&
      (!("override" in entry) || typeof entry.override === "boolean") &&
      Object.keys(entry).every((key) =>
        ["generation", "enabled", "override"].includes(key),
      ),
  );
}
