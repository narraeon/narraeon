import { parse } from "yaml";
import { orchestrationManifest } from "../shared/application-preset-files.ts";
import {
  builtinExtensionTemplateForLocale,
  builtinStatusPanelId,
} from "../shared/first-party-play-preset-templates.ts";
import { browserUUID } from "./browser-uuid.ts";
import {
  builtinFollowupExample,
  defaultFollowupItems,
  isBuiltinExtensionFollowupId,
} from "../shared/ordered-followups.ts";
import { getWebLocale } from "./i18n.ts";
import type {
  PlayPresetArtifactDefinition,
  PlayPresetFollowupDefinition,
  PlayPresetStructuredEditor,
} from "./PlayPresetScreen.tsx";
import type { DisplayDefinition } from "./PresetDisplayEditor.tsx";
import type { PlayPresetPlayerViewPanel } from "./PlayerViewPanelsEditor.tsx";

export interface PresetResourceDraft {
  files: Record<string, string>;
  structure: PlayPresetStructuredEditor;
}
export type PresetDisplayTarget =
  | { kind: "artifact"; requestId: string; output: string }
  | { kind: "panel"; id: string };
type ResourceKind = "renderer" | "regex" | "scripts" | "assets";
export type PresetDisplayEdit =
  | { type: "bind" | "unbind"; kind: ResourceKind; path: string }
  | {
      type: "create";
      kind: ResourceKind;
      name: string;
      suffix: string;
      body: string;
    }
  | { type: "mode"; mode: "document" | "app" };
export type PresetResourceEdit =
  | {
      type: "display";
      target: PresetDisplayTarget;
      edit: PresetDisplayEdit;
    }
  | { type: "delete-resource"; path: string }
  | { type: "create-panel"; id: string; title: string; emptyMessage: string }
  | { type: "clone-status-panel"; id: string }
  | { type: "remove-panel"; id: string }
  | { type: "remove-followup"; id: string }
  | { type: "remove-artifact"; requestId: string; output: string }
  | {
      type: "clone-followup";
      source: string;
      id: string;
    }
  | { type: "create-followup"; id: string; displayName: string; body: string }
  | {
      type: "add-artifact";
      requestId: string;
      artifact: PlayPresetArtifactDefinition;
      files?: Record<string, string>;
      mount?: PlayPresetStructuredEditor["mounts"][number]["mount"];
    };

interface BuiltinFollowupSource {
  body: string;
  definition: PlayPresetFollowupDefinition;
  files: Record<string, string>;
  mounts: PlayPresetStructuredEditor["mounts"];
}

/** Read the same application-owned template files used for Runtime compilation. */
export function builtinFollowupSource(
  id: string,
): BuiltinFollowupSource | undefined {
  const locale = getWebLocale();
  if (id === "builtin:summary") {
    const recap = builtinFollowupExample(locale);
    return {
      ...recap,
      files: {},
      mounts: [{ channel: "builtin:summary", mount: "story" }],
    };
  }
  if (!isBuiltinExtensionFollowupId(id)) return undefined;
  const { files, entryId, label } = builtinExtensionTemplateForLocale(
    id,
    locale,
  );
  type PortableFollowup = Omit<PlayPresetFollowupDefinition, "prompt"> & {
    prompt: { role: string; markdown: string };
  };
  const manifest = parse(files[orchestrationManifest]!) as {
    callChain: string;
    mounts?: Record<
      string,
      PlayPresetStructuredEditor["mounts"][number]["mount"]
    >;
  };
  const { followups } = parse(files[manifest.callChain]!) as {
    followups: PortableFollowup[];
  };
  const { prompt, ...definition } = followups.find(
    (entry) => entry.id === entryId,
  )!;
  return {
    definition: {
      ...definition,
      id,
      displayName: label,
      prompt: { role: prompt.role, path: prompt.markdown },
    },
    body: files[prompt.markdown]!,
    files,
    mounts: Object.entries(manifest.mounts ?? {}).map(([channel, mount]) => ({
      channel,
      mount,
    })),
  };
}

/** Returns a complete new draft; the caller applies files and structure together. */
export function editPresetResources(
  draft: PresetResourceDraft,
  action: PresetResourceEdit,
): PresetResourceDraft {
  if (action.type === "delete-resource") {
    const usage = presetResourceUsage(draft).get(action.path) ?? {
      declared: false,
      sources: [],
    };
    if (usage.declared || usage.sources.length)
      throw new Error(
        `Resource is referenced: ${action.path}${usage.sources.length ? ` (${usage.sources.join(", ")})` : ""}`,
      );
    const next = structuredClone(draft);
    delete next.files[action.path];
    next.structure.extensionRefs = next.structure.extensionRefs.filter(
      (path) => path !== action.path,
    );
    return next;
  }
  if (action.type === "create-followup" || action.type === "clone-followup") {
    if (
      draft.structure.followups.some((request) => request.id === action.id) ||
      draft.structure.followupItems?.some((item) => item.id === action.id) ||
      draft.files[`prompts/${action.id}.md`] !== undefined
    )
      throw new Error(`Request or prompt already exists: ${action.id}`);
  }
  const next = structuredClone(draft);
  if (action.type === "create-panel") {
    next.structure.playerViewPanels.push({
      id: action.id,
      source: { kind: "player_view", view: "status" },
      channel: `player.view.${action.id}`,
      key: "current",
      mount: "sidebar",
      rendererMode: "document",
      config: {
        title: action.title,
        layout: "stack",
        theme: "default",
        empty: "message",
        emptyMessage: action.emptyMessage,
        groups: [],
      },
    });
    return next;
  }
  if (action.type === "clone-status-panel") {
    const { files, entryId } = builtinExtensionTemplateForLocale(
      builtinStatusPanelId,
      getWebLocale(),
    );
    const { playerViewPanels } = parse(files[orchestrationManifest]!) as {
      playerViewPanels: PlayPresetPlayerViewPanel[];
    };
    const source = playerViewPanels.find((panel) => panel.id === entryId)!;
    const { refs } = copyResourceClosure(next, files, displayPaths(source));
    next.structure.playerViewPanels.push({
      ...rewriteDisplayResources(source, refs),
      id: action.id,
      channel: `player.view.${action.id}`,
    });
    return next;
  }
  if (action.type === "remove-panel") {
    next.structure.playerViewPanels = next.structure.playerViewPanels.filter(
      (panel) => panel.id !== action.id,
    );
    return next;
  }
  if (action.type === "remove-followup" || action.type === "remove-artifact") {
    const id = action.type === "remove-followup" ? action.id : action.requestId;
    const request = next.structure.followups.find(
      (request) => request.id === id,
    );
    if (!request) throw new Error(`Request does not exist: ${id}`);
    const removed =
      action.type === "remove-followup"
        ? request.artifacts
        : request.artifacts.filter(
            (artifact) => artifact.name === action.output,
          );
    const channels = new Set(removed.map((artifact) => artifact.channel));
    if (action.type === "remove-followup") {
      next.structure.followupItems = (
        next.structure.followupItems ??
        defaultFollowupItems(next.structure.followups)
      ).filter((item) => item.id !== id);
      next.structure.followups = next.structure.followups.filter(
        (request) => request.id !== id,
      );
    } else
      request.artifacts = request.artifacts.filter(
        (artifact) => artifact.name !== action.output,
      );
    const used = new Set([
      ...next.structure.followups.flatMap((request) =>
        request.artifacts.map((artifact) => artifact.channel),
      ),
      ...next.structure.playerViewPanels.map((panel) => panel.channel),
    ]);
    next.structure.mounts = next.structure.mounts.filter(
      (mount) => !channels.has(mount.channel) || used.has(mount.channel),
    );
    return next;
  }
  if (action.type === "create-followup") {
    const path = `prompts/${action.id}.md`;
    const artifact = newPresetArtifact(`${action.id}.output_1`, "output_1");
    next.files[path] = action.body;
    next.structure.followupItems = [
      ...(next.structure.followupItems ??
        defaultFollowupItems(next.structure.followups)),
      { id: action.id, kind: "user", enabled: true },
    ];
    next.structure.followups.push({
      id: action.id,
      displayName: action.displayName,
      prompt: { role: "author_instruction", path },
      artifacts: [artifact],
      maxArtifactBytes: 32768,
    });
    next.structure.mounts.push({ channel: artifact.channel, mount: "story" });
    return next;
  }
  if (action.type === "add-artifact") {
    const request = next.structure.followups.find(
      (request) => request.id === action.requestId,
    );
    if (!request)
      throw new Error(`Request does not exist: ${action.requestId}`);
    for (const [path, body] of Object.entries(action.files ?? {})) {
      if (next.files[path] !== undefined)
        throw new Error(`Resource already exists: ${path}`);
      next.files[path] = body;
    }
    const refs = displayPaths(action.artifact);
    for (const path of refs)
      if (next.files[path] === undefined)
        throw new Error(`Resource does not exist: ${path}`);
    request.artifacts.push(structuredClone(action.artifact));
    if (
      !next.structure.mounts.some(
        (mount) => mount.channel === action.artifact.channel,
      )
    )
      next.structure.mounts.push({
        channel: action.artifact.channel,
        mount: action.mount ?? "story",
      });
    next.structure.extensionRefs = [
      ...new Set([
        ...next.structure.extensionRefs,
        ...refs,
        ...Object.keys(action.files ?? {}),
      ]),
    ];
    return next;
  }
  if (action.type === "clone-followup") {
    const builtin = builtinFollowupSource(action.source);
    const original: PlayPresetFollowupDefinition | undefined =
      builtin?.definition ??
      next.structure.followups.find((request) => request.id === action.source);
    if (!original) throw new Error("Clone source does not exist");
    const clone = structuredClone(original);
    clone.id = action.id;
    clone.displayName += getWebLocale() === "zh-CN" ? " 副本" : " copy";
    const sourceFiles = builtin?.files ?? draft.files;
    const promptBody = builtin?.body ?? sourceFiles[original.prompt.path];
    if (promptBody === undefined)
      throw new Error(`Resource does not exist: ${original.prompt.path}`);
    const { refs, rewrite } = copyResourceClosure(next, sourceFiles, [
      ...original.artifacts.flatMap(displayPaths),
      ...localResourceReferences(promptBody),
    ]);
    clone.prompt.path = `prompts/${action.id}.md`;
    next.files[clone.prompt.path] = rewrite(promptBody);
    const channels = new Map<string, string>();
    clone.artifacts = clone.artifacts.map((artifact) => {
      let channel = channels.get(artifact.channel);
      if (!channel) {
        channel = `${action.id}.output_${channels.size + 1}`;
        channels.set(artifact.channel, channel);
      }
      return { ...rewriteDisplayResources(artifact, refs), channel };
    });
    next.structure.followupItems = [
      ...(next.structure.followupItems ??
        defaultFollowupItems(next.structure.followups)),
      { id: clone.id, kind: "user", enabled: true },
    ];
    next.structure.followups.push(clone);
    next.structure.mounts.push(
      ...(builtin?.mounts ?? draft.structure.mounts)
        .filter((mount) => channels.has(mount.channel))
        .map((mount) => ({ ...mount, channel: channels.get(mount.channel)! })),
    );
    return next;
  }
  const target = action.target;
  const display: DisplayDefinition | undefined =
    target.kind === "panel"
      ? next.structure.playerViewPanels.find((panel) => panel.id === target.id)
      : next.structure.followups
          .find((request) => request.id === target.requestId)
          ?.artifacts.find((artifact) => artifact.name === target.output);
  if (!display) throw new Error("Display declaration does not exist");
  const edit = action.edit;
  if (edit.type === "mode") {
    display.rendererMode = edit.mode;
    return next;
  }
  const { kind } = edit;
  if (edit.type === "unbind") {
    if (kind === "assets" || kind === "scripts")
      display[kind] = (display[kind] ?? []).filter(
        (path) => path !== edit.path,
      );
    else if (display[kind] === edit.path) {
      delete display[kind];
      if (kind === "renderer") {
        delete display.rendererRevision;
        display.rendererMode = "document";
      }
    }
    return next;
  }
  const path = edit.type === "create" ? resourcePath(edit) : edit.path;
  if (edit.type === "create") next.files[path] = edit.body;
  if (next.files[path] === undefined)
    throw new Error(`Resource does not exist: ${path}`);
  if (kind === "assets" || kind === "scripts")
    display[kind] = [...new Set([...(display[kind] ?? []), path])];
  else {
    display[kind] = path;
    if (kind === "renderer") display.rendererRevision = browserUUID();
  }
  next.structure.extensionRefs = [
    ...new Set([...next.structure.extensionRefs, path]),
  ];
  return next;
}

function copyResourceClosure(
  next: PresetResourceDraft,
  files: Record<string, string>,
  queue: string[],
) {
  const refs = new Map<string, string>();
  for (const path of queue) {
    if (refs.has(path)) continue;
    if (files[path] === undefined)
      throw new Error(`Resource does not exist: ${path}`);
    const slash = path.lastIndexOf("/");
    refs.set(
      path,
      `${path.slice(0, slash)}/${browserUUID()}-${path.slice(slash + 1)}`,
    );
    queue.push(...localResourceReferences(files[path]));
  }
  const rewrite = (body: string) =>
    body.replace(localResourcePattern(), (path) => refs.get(path) ?? path);
  for (const [source, target] of refs)
    next.files[target] = rewrite(files[source]!);
  next.structure.extensionRefs = [
    ...new Set([...next.structure.extensionRefs, ...refs.values()]),
  ];
  return { refs, rewrite };
}

function rewriteDisplayResources<Display extends DisplayDefinition>(
  display: Display,
  refs: ReadonlyMap<string, string>,
): Display {
  return {
    ...display,
    ...(display.renderer && { renderer: refs.get(display.renderer)! }),
    ...(display.regex && { regex: refs.get(display.regex)! }),
    ...(display.scripts && {
      scripts: display.scripts.map((path) => refs.get(path)!),
    }),
    ...(display.assets && {
      assets: display.assets.map((path) => refs.get(path)!),
    }),
  };
}

function resourcePath(
  edit: Extract<PresetDisplayEdit, { type: "create" }>,
): string {
  const directory = {
    renderer: "renderers",
    regex: "regex",
    scripts: "scripts",
    assets: "assets",
  }[edit.kind];
  // Display names can contain Unicode; declaration paths use the ASCII codec.
  const name = edit.name.trim()
    ? "named-" +
      Array.from(edit.name.trim().slice(0, 24))
        .map((char) =>
          /[A-Za-z0-9.-]/u.test(char)
            ? char
            : `_u${char.codePointAt(0)!.toString(16)}_`,
        )
        .join("")
    : "resource";
  return `${directory}/${name}.${browserUUID()}.${edit.suffix}`;
}

/** Builds one index for the UI; deletion rebuilds it from the latest draft. */
export function presetResourceUsage(
  draft: PresetResourceDraft,
): Map<string, { declared: boolean; sources: string[] }> {
  const usage = new Map<string, { declared: boolean; sources: string[] }>();
  function entry(path: string) {
    let value = usage.get(path);
    if (!value) {
      value = { declared: false, sources: [] };
      usage.set(path, value);
    }
    return value;
  }
  const structure = draft.structure;
  const declared = [
    structure.settingImprovementPrompt?.path,
    ...structure.narrativePrompts.map((prompt) => prompt.path),
    ...structure.followups.flatMap((request) => [
      request.prompt.path,
      ...request.artifacts.flatMap(displayPaths),
    ]),
    ...structure.playerViewPanels.flatMap(displayPaths),
  ];
  for (const path of declared)
    if (path !== undefined) entry(path).declared = true;
  for (const [sourcePath, body] of Object.entries(draft.files)) {
    if (
      sourcePath === orchestrationManifest ||
      sourcePath === "preset.yaml" ||
      sourcePath === structure.callChainPath
    )
      continue;
    for (const path of new Set(localResourceReferences(body)))
      if (path !== sourcePath) entry(path).sources.push(sourcePath);
  }
  return usage;
}

function displayPaths(display: DisplayDefinition): string[] {
  return [
    display.renderer,
    display.regex,
    ...(display.scripts ?? []),
    ...(display.assets ?? []),
  ].filter((path): path is string => path !== undefined);
}

// Lexical full paths in source text, using the declaration codec's ASCII alphabet.
// Delimiters prevent matching remote/absolute URLs, longer paths and template prefixes.
// This does not evaluate JS, decode escaped strings or resolve relative paths.
function localResourceReferences(source: string): string[] {
  return [...source.matchAll(localResourcePattern())].map((match) => match[0]);
}

function localResourcePattern(): RegExp {
  return /(?:(?<![A-Za-z0-9_./:@%?=#\\-])|(?<=\s[A-Za-z_:][A-Za-z0-9_:.-]*[\t\n\f\r ]*=))(?:renderers\/[A-Za-z0-9][A-Za-z0-9._-]*\.html|regex\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml|scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.js|assets\/[A-Za-z0-9][A-Za-z0-9._/-]*)(?![A-Za-z0-9_./$?%#=\\-])/gu;
}

export function newPresetArtifact(
  channel: string,
  name: string,
): PlayPresetArtifactDefinition {
  return {
    name,
    displayName: getWebLocale() === "zh-CN" ? "新产物" : "New output",
    channel,
    strategy: "replace",
    contentType: "text/markdown",
    rendererMode: "document",
    save: "commit",
    invalidation: "explicit_clear",
    required: false,
    maxEmits: 1,
  };
}
