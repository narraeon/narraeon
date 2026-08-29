import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";

import {
  defaultPortableContentTreeLimits,
  portableContentTreePathKey,
  type PortableContentTreeLimits,
} from "../../protocol/contentTree.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";
import { defaultNarrationPromptForLocale } from "../../shared/default-play-prompts.ts";
import { defaultPresetHostFilesForLocale } from "../../shared/default-preset-host.ts";
import {
  defaultSettingImprovementPromptForLocale,
  defaultSettingImprovementPromptPath,
} from "../../shared/default-setting-improvement-prompt.ts";
import {
  isPlayPresetPromptRole,
  type PlayPresetPromptRole,
} from "../../shared/play-preset-prompt-roles.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
export type PlayPresetArtifactStrategy =
  "append" | "replace" | "upsert" | "transient" | "hidden";

export type PlayPresetArtifactInvalidation =
  | "new_operation"
  | "head_change"
  | "operation_end"
  | "explicit_clear"
  | "never";

export type PlayPresetRegexScope =
  "raw_text" | "markdown_html" | "structured_payload";

export type PlayPresetRegexErrorPolicy = "fallback" | "skip" | "fail";

export interface PlayPresetRegexRule {
  order: number;
  scope: PlayPresetRegexScope;
  pattern: string;
  flags: string;
  replace: string;
  maxMatches: number;
  errorPolicy: PlayPresetRegexErrorPolicy;
}

export type PlayPresetRendererMode = "document" | "app";

/**
 * A deliberately small, author-editable JSON contract.  It describes the
 * shape of an artifact payload without exposing Runtime tool schemas or
 * provider protocol details to the preset.
 */
export interface PlayPresetArtifactPayloadContract {
  type:
    "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, PlayPresetArtifactPayloadContract>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PlayPresetArtifactPayloadContract;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  uniqueBy?: string;
  maxBytes?: number;
}

export interface PlayPresetPromptBlock {
  role: PlayPresetPromptRole;
  path: string;
}

export interface PlayPresetArtifactDeclaration {
  /** Stable model-facing output name; the model never chooses the rest. */
  name: string;
  channel: string;
  strategy: PlayPresetArtifactStrategy;
  key?: string;
  contentType:
    "text/plain" | "text/markdown" | "application/json" | "text/html";
  renderer?: string;
  rendererRevision?: string;
  rendererMode?: PlayPresetRendererMode;
  regex?: string;
  scripts?: string[];
  assets?: string[];
  save: "none" | "operation" | "commit";
  invalidation: PlayPresetArtifactInvalidation;
  required: boolean;
  maxEmits: number;
  payloadContract?: PlayPresetArtifactPayloadContract;
}

/**
 * One derived request dispatched after the main call chain settles. Follow-ups
 * have no order relative to each other, no terminal tool, and no place in the
 * chain transcript. Each is sent once against the frozen main-chain prefix and
 * may only emit the artifacts it declares.
 */
export interface PlayPresetFollowupDefinition {
  id: string;
  displayName: string;
  prompt: PlayPresetPromptBlock;
  artifacts: PlayPresetArtifactDeclaration[];
  maxArtifactBytes: number;
}

export interface PlayPresetMount {
  channel: string;
  mount:
    | "story"
    | "sidebar"
    | "composer_above"
    | "composer_below"
    | "overlay"
    | "debug";
}

export interface PlayPresetPlayerViewPanelSource {
  kind: "player_view";
  view: string;
  itemIds?: string[];
}

export interface PlayPresetPlayerViewPanelGroup {
  id: string;
  label: string;
  itemIds: string[];
}

export interface PlayPresetPlayerViewPanelConfig {
  title?: string;
  layout: "stack" | "grid";
  theme: string;
  empty: "hide" | "message" | "show";
  emptyMessage: string;
  groups: PlayPresetPlayerViewPanelGroup[];
}

/**
 * A regular author asset that projects an already committed player view.
 * It has no write authority and is deliberately separate from follow-up
 * artifacts, whose lifecycle is tied to a model operation.
 */
export interface PlayPresetPlayerViewPanel {
  id: string;
  source: PlayPresetPlayerViewPanelSource;
  channel: string;
  key: string;
  mount: PlayPresetMount["mount"];
  renderer?: string;
  rendererRevision?: string;
  rendererMode: PlayPresetRendererMode;
  regex?: string;
  scripts?: string[];
  assets?: string[];
  config: PlayPresetPlayerViewPanelConfig;
}

export interface PlayPresetDefinition {
  format: "narraeon.play-preset/v1";
  name: string;
  callChainPath: string;
  /** Optional only so pre-feature v1 presets retain their prior semantics. */
  settingImprovementPrompt?: PlayPresetPromptBlock;
  mounts: PlayPresetMount[];
  playerViewPanels: PlayPresetPlayerViewPanel[];
  extensionRefs: string[];
  /** Author prompt blocks that govern every player-visible narrative. */
  narrativePrompts: PlayPresetPromptBlock[];
  followups: PlayPresetFollowupDefinition[];
  files: Record<string, string>;
}

/**
 * The frame plus its block library, projected in the shape the prompt compiler
 * already consumes. A preset owns both halves now: `frame.yaml` decides which
 * blocks are enabled and in what order, while unlisted blocks stay in the tree
 * as an editable library.
 */
export function presetHostBinding(binding: PlayPresetBinding): {
  hostPresetId: string;
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  for (const [path, contents] of Object.entries(binding.definition.files))
    if (path === "frame.yaml" || path.startsWith("blocks/"))
      files[path] = contents;
  return { hostPresetId: binding.id, files };
}

/**
 * Structured workbench projection.  It is derived from the same parsed
 * play-preset codec as runtime execution; it is not a second call-chain model.
 * `availableTools` is informational and is never accepted as an executable
 * definition without the normal parser/validator pass.
 */
export interface PlayPresetStructuredEditor {
  name: string;
  callChainPath: string;
  settingImprovementPrompt?: PlayPresetPromptBlock;
  mounts: PlayPresetMount[];
  playerViewPanels: PlayPresetPlayerViewPanel[];
  extensionRefs: string[];
  narrativePrompts: PlayPresetPromptBlock[];
  followups: PlayPresetFollowupDefinition[];
}

export interface PlayPresetBinding {
  id: string;
  name: string;
  revision: string;
  definition: PlayPresetDefinition;
  files: Record<string, string>;
  /** Local UI execution switch; not part of the portable revision. */
  scriptsEnabled: boolean;
}

/** Strict persisted-binding guard shared by every durable play operation. */
export function isPlayPresetBinding(
  value: unknown,
): value is PlayPresetBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "name",
      "revision",
      "definition",
      "files",
      "scriptsEnabled",
    ]) ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    value.id !== value.id.trim() ||
    value.id.includes("\0") ||
    typeof value.name !== "string" ||
    !/^[^\r\n]{1,160}$/u.test(value.name) ||
    value.name !== value.name.trim() ||
    value.name.includes("\0") ||
    typeof value.revision !== "string" ||
    !isRecord(value.definition) ||
    !isRecord(value.files) ||
    Object.keys(value.files).length === 0 ||
    !Object.values(value.files).every(
      (contents) => typeof contents === "string",
    ) ||
    typeof value.scriptsEnabled !== "boolean"
  )
    return false;
  const files = value.files as Record<string, string>;
  const parsed = parsePlayPresetFiles(files);
  const builtInDefault =
    value.id === "builtin-default" &&
    value.name === "default" &&
    value.revision === "builtin-default-v1" &&
    value.scriptsEnabled === true &&
    (isDeepStrictEqual(files, defaultPlayPresetFilesForLocale("en")) ||
      isDeepStrictEqual(files, defaultPlayPresetFilesForLocale("zh-CN")));
  return (
    parsed.kind === "valid" &&
    isDeepStrictEqual(value.definition, parsed.definition) &&
    (builtInDefault || value.revision === revisionForPlayPresetFiles(files))
  );
}

export type PlayPresetValidation =
  | { status: "valid" }
  | { status: "invalid"; code: string; message: string; location: string };

export interface FileNativePlayPresetView {
  id: string;
  name: string;
  revision: string;
  files: Record<string, string>;
  validation: PlayPresetValidation;
  enabled: boolean;
  scriptsEnabled: boolean;
  structure?: PlayPresetStructuredEditor;
  draft?: {
    revision: string;
    files: Record<string, string>;
    validation: PlayPresetValidation;
    structure?: PlayPresetStructuredEditor;
  };
}

export interface FileNativePlayPresetLibrary {
  schemaVersion: 1;
  currentPresetId: string;
  presets: FileNativePlayPresetView[];
}

export class FileNativePlayPresetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FileNativePlayPresetError";
  }
}

export function defaultPlayPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  return {
    "preset.yaml": `format: narraeon.play-preset/v1
name: ${locale === "zh-CN" ? "系统推荐" : "System recommended"}
callChain: call-chain.yaml
settingImprovement:
  markdown: prompts/setting-improvement.md
mounts: []
extensions: []
`,
    "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups: []
`,
    ...defaultPresetHostFilesForLocale(locale),
    "prompts/narrate.md": defaultNarrationPromptForLocale(locale),
    [defaultSettingImprovementPromptPath]:
      defaultSettingImprovementPromptForLocale(locale),
  };
}

export const defaultPlayPresetFiles =
  defaultPlayPresetFilesForLocale(defaultAppLocale);

/**
 * Resolve the author-owned part of setting improvement from a frozen preset.
 * Older v1 presets had no declaration; they keep the shipped behavior without
 * their persisted file tree being silently rewritten.
 */
export function settingImprovementPromptForBinding(
  binding: PlayPresetBinding,
  locale: AppLocale = defaultAppLocale,
): string {
  const reference = binding.definition.settingImprovementPrompt;
  if (reference === undefined)
    return defaultSettingImprovementPromptForLocale(locale);
  const prompt = binding.files[reference.path];
  if (prompt === undefined || prompt.trim() === "")
    throw new FileNativePlayPresetError(
      "setting_improvement_prompt_missing",
      `Setting-improvement prompt block does not exist: ${reference.path}`,
    );
  return prompt;
}

/** Stable built-in binding for direct Runtime seams without a local library. */
export function builtinDefaultPlayPresetBinding(
  locale: AppLocale = defaultAppLocale,
): PlayPresetBinding {
  const files = cloneFiles(defaultPlayPresetFilesForLocale(locale));
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "builtin-default",
    name: "default",
    revision: "builtin-default-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

interface StoredPreset {
  id: string;
  name: string;
  currentRevision: string;
  revisions: Record<string, Record<string, string>>;
  draftRevision?: string;
  enabled: boolean;
  scriptsEnabled: boolean;
  /** Runtime-owned seed that may track the selected application locale. */
  builtinDefault?: true;
}

interface StoredDocument {
  schemaVersion: 1;
  currentPresetId: string;
  presets: StoredPreset[];
}

const defaultLimits: PortableContentTreeLimits =
  defaultPortableContentTreeLimits;
const revisionPattern = /^rev-[0-9a-f]{64}$/u;
const namePattern = /^[^\r\n]{1,160}$/u;
export const maxPlayPresetFollowups = 16;
const defaultMaxArtifactBytes = 32_768;
const maxArtifactBytesCeiling = 1_048_576;

/**
 * File-native local library for play presets. Revisions are retained in the
 * local store, while portable files contain only author assets and no local
 * identity or runtime state.
 */
export class FileNativePlayPresetStore {
  readonly #path: string;
  readonly #root: string;
  readonly #limits: PortableContentTreeLimits;
  readonly #locale: () => AppLocale;
  #tail: Promise<void> = Promise.resolve();
  /**
   * Set when an unreadable library was moved aside on load. Surfaced as a
   * workspace diagnostic so the recovery is never silent.
   */
  recovery: { quarantinedPath: string; message: string } | null = null;

  constructor(
    root: string,
    options: {
      limits?: Partial<PortableContentTreeLimits>;
      locale?: () => AppLocale;
    } = {},
  ) {
    this.#root = root;
    this.#path = join(root, "file-native-play-presets.json");
    this.#limits = {
      ...defaultLimits,
      ...options.limits,
    };
    this.#locale = options.locale ?? (() => defaultAppLocale);
  }

  async initialize(): Promise<void> {
    await this.#change(async () => {
      const document = await this.#read();
      const migrated = this.#markLegacyBuiltinDefault(document);
      const synchronized = this.#synchronizeBuiltinDefault(document);
      if (migrated || synchronized) await this.#write(document);
    });
  }

  /**
   * Update only the Runtime-owned seed preset. User-created, copied, imported,
   * renamed, or edited presets remain byte-for-byte unchanged.
   */
  async syncBuiltinDefaultLocale(): Promise<void> {
    await this.#change(async () => {
      const document = await this.#read();
      if (this.#synchronizeBuiltinDefault(document))
        await this.#write(document);
    });
  }

  async list(): Promise<FileNativePlayPresetLibrary> {
    await this.#tail;
    const document = await this.#read();
    return {
      schemaVersion: 1,
      currentPresetId: document.currentPresetId,
      presets: document.presets.map((preset) => this.#view(preset)),
    };
  }

  async create(
    name: string,
    files?: Record<string, string>,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = this.#stored(
        randomUUID(),
        name,
        files ?? defaultPlayPresetFilesForLocale(this.#locale()),
      );
      document.presets.push(stored);
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async copy(
    id: string,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const source = findStored(document, id);
      const files = source.revisions[source.currentRevision];
      if (files === undefined)
        throw new FileNativePlayPresetError(
          "store_invalid",
          "Play-preset revision is missing",
        );
      const stored = this.#stored(randomUUID(), source.name, files);
      stored.scriptsEnabled = source.scriptsEnabled;
      document.presets.push(stored);
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  /** Save a draft. Invalid drafts remain inspectable but cannot be selected. */
  async save(input: {
    presetId: string;
    name: string;
    files: Record<string, string>;
    structure?: unknown;
  }): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = findStored(document, input.presetId);
      delete stored.builtinDefault;
      let files = cloneFiles(input.files);
      if (input.structure !== undefined) {
        files = applyPlayPresetStructuredEditor(
          input.files,
          parsePlayPresetStructuredEditor(input.structure),
        );
      }
      const revision = revisionForFiles(files, this.#limits);
      stored.name = normalizeName(input.name);
      stored.revisions[revision] = cloneFiles(files);
      if (revision === stored.currentRevision) delete stored.draftRevision;
      else stored.draftRevision = revision;
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async select(
    id: string,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = findStored(document, id);
      if (!stored.enabled)
        throw new FileNativePlayPresetError(
          "preset_disabled",
          "A disabled play preset cannot become the current selection",
        );
      const preset = this.#view(stored);
      const candidateValidation = preset.draft?.validation ?? preset.validation;
      if (candidateValidation.status === "invalid")
        throw new FileNativePlayPresetError(
          "invalid_play_preset",
          `Draft cannot be applied: ${candidateValidation.message}`,
        );
      if (stored.draftRevision !== undefined) {
        stored.currentRevision = stored.draftRevision;
        delete stored.draftRevision;
      }
      document.currentPresetId = id;
      await this.#write(document);
      return { currentPresetId: id, preset: this.#view(stored) };
    });
  }

  async bindCurrent(): Promise<PlayPresetBinding> {
    await this.#tail;
    const document = await this.#read();
    const stored = findStored(document, document.currentPresetId);
    if (!stored.enabled)
      throw new FileNativePlayPresetError(
        "preset_disabled",
        "The current play preset is disabled; enable it or choose another preset",
      );
    return this.bindRevision(document.currentPresetId);
  }

  async bindCurrentFiles(): Promise<PlayPresetBinding> {
    return this.bindCurrent();
  }

  async bindRevision(
    id: string,
    revision?: string,
  ): Promise<PlayPresetBinding> {
    await this.#tail;
    const document = await this.#read();
    const stored = findStored(document, id);
    const selectedRevision = revision ?? stored.currentRevision;
    const files = stored.revisions[selectedRevision];
    if (files === undefined)
      throw new FileNativePlayPresetError(
        "revision_not_found",
        "The requested play-preset revision was not found",
      );
    const parsed = parsePlayPresetFiles(files, this.#limits);
    if (parsed.kind === "invalid")
      throw new FileNativePlayPresetError(
        parsed.error.code,
        parsed.error.message,
      );
    return {
      id: stored.id,
      name: stored.name,
      revision: selectedRevision,
      definition: parsed.definition,
      files: cloneFiles(files),
      scriptsEnabled: stored.scriptsEnabled,
    };
  }

  async rename(
    id: string,
    name: string,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = findStored(document, id);
      delete stored.builtinDefault;
      stored.name = normalizeName(name);
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = findStored(document, id);
      stored.enabled = enabled;
      if (!enabled && document.currentPresetId === id) {
        const fallback = document.presets.find(
          (candidate) => candidate.id !== id && candidate.enabled,
        );
        if (fallback === undefined) {
          throw new FileNativePlayPresetError(
            "cannot_disable_current_preset",
            "The only current play preset cannot be disabled; select another enabled preset first",
          );
        }
        document.currentPresetId = fallback.id;
      }
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async setScriptsEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    return this.#change(async () => {
      const document = await this.#read();
      const stored = findStored(document, id);
      stored.scriptsEnabled = enabled;
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async delete(
    id: string,
  ): Promise<{ currentPresetId: string; deleted: true }> {
    return this.#change(async () => {
      const document = await this.#read();
      findStored(document, id);
      document.presets = document.presets.filter((preset) => preset.id !== id);
      // Deleting the last preset — or the last enabled one — rebuilds the
      // default rather than refusing. Nothing a user deletes should leave the
      // library in a state they cannot get out of.
      const restored = document.presets.some(({ enabled }) => enabled)
        ? document
        : this.#defaultDocument();
      if (
        restored.presets.every(
          ({ id: kept }) => kept !== restored.currentPresetId,
        )
      )
        restored.currentPresetId = restored.presets.find(
          ({ enabled }) => enabled,
        )!.id;
      await this.#write(restored);
      return { currentPresetId: restored.currentPresetId, deleted: true };
    });
  }

  async readRevision(id: string, revision: string): Promise<PlayPresetBinding> {
    return this.bindRevision(id, revision);
  }

  /** Freeze a revision for a model operation; later drafts cannot alter it. */
  async freeze(
    input: { presetId?: string; revision?: string } = {},
  ): Promise<PlayPresetBinding> {
    await this.#tail;
    const document = await this.#read();
    return this.bindRevision(
      input.presetId ?? document.currentPresetId,
      input.revision,
    );
  }

  async freezeRevision(
    input: {
      presetId?: string;
      revision?: string;
    } = {},
  ): Promise<PlayPresetBinding> {
    return this.freeze(input);
  }

  /** Portable export deliberately contains no id, revision, world, operation or provider state. */
  async exportPortable(id: string): Promise<ContentTreeFile[]> {
    const binding = await this.bindRevision(id);
    return Object.keys(binding.files)
      .sort()
      .map((path) => ({ path, contents: binding.files[path]! }));
  }

  async importPortable(input: {
    name: string;
    files: readonly ContentTreeFile[] | Record<string, string>;
  }): Promise<{ currentPresetId: string; preset: FileNativePlayPresetView }> {
    const files = toFileMap(input.files, this.#limits);
    return this.#change(async () => {
      const document = await this.#read();
      const stored = this.#stored(randomUUID(), input.name, files);
      // Portable assets are untrusted until the local user explicitly opts
      // in. Executable code may be embedded in renderer HTML as well as under
      // scripts/, so every imported identity starts with code disabled.
      stored.scriptsEnabled = false;
      document.presets.push(stored);
      await this.#write(document);
      return {
        currentPresetId: document.currentPresetId,
        preset: this.#view(stored),
      };
    });
  }

  async #change<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.#tail;
    let done!: () => void;
    this.#tail = new Promise((resolve) => {
      done = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      done();
    }
  }

  /**
   * Read the library, or recover from one that cannot be parsed at all.
   *
   * A preset the current schema rejects is an ordinary invalid preset: it
   * loads, reports why, and can be deleted from the UI. But a library file
   * that will not parse — bad JSON, a mismatched content hash, a hand-edited
   * record — used to fail startup outright, which left the user with no
   * surface to fix it from. The damaged file is preserved under a new name
   * instead, so nothing is lost and the workspace can still open.
   */
  async #read(): Promise<StoredDocument> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const document = this.#defaultDocument();
      await this.#write(document);
      return document;
    }
    try {
      return parseStoredDocument(JSON.parse(raw), this.#limits);
    } catch (error: unknown) {
      const quarantined = await this.#quarantine();
      this.recovery = {
        quarantinedPath: quarantined,
        message:
          error instanceof Error
            ? error.message
            : "The play-preset library could not be parsed",
      };
      const document = this.#defaultDocument();
      await this.#write(document);
      return document;
    }
  }

  /**
   * Move the unreadable library aside rather than overwriting it. The user
   * keeps the original bytes and can hand-repair or discard them.
   */
  async #quarantine(): Promise<string> {
    const target = join(
      this.#root,
      `file-native-play-presets.unreadable-${Date.now()}.json`,
    );
    await rename(this.#path, target);
    return target;
  }

  #defaultDocument(): StoredDocument {
    const stored = this.#stored(
      randomUUID(),
      "default",
      defaultPlayPresetFilesForLocale(this.#locale()),
    );
    stored.builtinDefault = true;
    return {
      schemaVersion: 1,
      currentPresetId: stored.id,
      presets: [stored],
    };
  }

  #markLegacyBuiltinDefault(document: StoredDocument): boolean {
    if (document.presets.length !== 1) return false;
    const [preset] = document.presets;
    if (
      preset === undefined ||
      preset.builtinDefault === true ||
      preset.name !== "default" ||
      preset.draftRevision !== undefined
    )
      return false;
    const files = preset.revisions[preset.currentRevision];
    if (
      files === undefined ||
      (!isDeepStrictEqual(files, defaultPlayPresetFilesForLocale("en")) &&
        !isDeepStrictEqual(files, defaultPlayPresetFilesForLocale("zh-CN")))
    )
      return false;
    preset.builtinDefault = true;
    return true;
  }

  #synchronizeBuiltinDefault(document: StoredDocument): boolean {
    const preset = document.presets.find(
      ({ builtinDefault }) => builtinDefault === true,
    );
    if (preset === undefined || preset.draftRevision !== undefined)
      return false;
    const current = preset.revisions[preset.currentRevision];
    if (
      current === undefined ||
      (!isDeepStrictEqual(current, defaultPlayPresetFilesForLocale("en")) &&
        !isDeepStrictEqual(current, defaultPlayPresetFilesForLocale("zh-CN")))
    ) {
      delete preset.builtinDefault;
      return true;
    }
    const desired = defaultPlayPresetFilesForLocale(this.#locale());
    const revision = revisionForFiles(desired, this.#limits);
    if (preset.currentRevision === revision) return false;
    preset.revisions[revision] = cloneFiles(desired);
    preset.currentRevision = revision;
    return true;
  }

  #stored(
    id: string,
    rawName: string,
    rawFiles: Record<string, string>,
  ): StoredPreset {
    const name = normalizeName(rawName);
    const files = cloneFiles(rawFiles);
    const revision = revisionForFiles(files, this.#limits);
    return {
      id,
      name,
      currentRevision: revision,
      revisions: { [revision]: files },
      enabled: true,
      scriptsEnabled: true,
    };
  }

  #view(stored: StoredPreset): FileNativePlayPresetView {
    const files = stored.revisions[stored.currentRevision];
    if (files === undefined)
      throw new FileNativePlayPresetError(
        "store_invalid",
        "The current play-preset revision does not exist",
      );
    const validation = validatePlayPresetFiles(files, this.#limits);
    const view: FileNativePlayPresetView = {
      id: stored.id,
      name: stored.name,
      revision: stored.currentRevision,
      files: cloneFiles(files),
      validation,
      enabled: stored.enabled,
      scriptsEnabled: stored.scriptsEnabled,
    };
    if (validation.status === "valid") {
      const parsed = parsePlayPresetFiles(files, this.#limits);
      if (parsed.kind === "valid")
        view.structure = toPlayPresetStructuredEditor(parsed.definition);
    }
    if (stored.draftRevision !== undefined) {
      const draftFiles = stored.revisions[stored.draftRevision];
      if (draftFiles === undefined)
        throw new FileNativePlayPresetError(
          "store_invalid",
          "The play-preset draft revision does not exist",
        );
      view.draft = {
        revision: stored.draftRevision,
        files: cloneFiles(draftFiles),
        validation: validatePlayPresetFiles(draftFiles, this.#limits),
      };
      if (view.draft.validation.status === "valid") {
        const parsedDraft = parsePlayPresetFiles(draftFiles, this.#limits);
        if (parsedDraft.kind === "valid")
          view.draft.structure = toPlayPresetStructuredEditor(
            parsedDraft.definition,
          );
      }
    }
    return view;
  }

  async #write(document: StoredDocument): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}

export function validatePlayPresetFiles(
  files: Record<string, string>,
  limits: Partial<PortableContentTreeLimits> = {},
): PlayPresetValidation {
  try {
    const parsed = parsePlayPresetFiles(files, { ...defaultLimits, ...limits });
    if (parsed.kind === "invalid") throw parsed.error;
    return { status: "valid" };
  } catch (error: unknown) {
    if (error instanceof FileNativePlayPresetError)
      return {
        status: "invalid",
        code: error.code,
        message: error.message,
        location: locatePlayPresetError(error.message),
      };
    return {
      status: "invalid",
      code: "play_preset_invalid",
      message:
        error instanceof Error ? error.message : "Play preset is invalid",
      location: "preset.yaml",
    };
  }
}

export function toPlayPresetStructuredEditor(
  definition: PlayPresetDefinition,
): PlayPresetStructuredEditor {
  return {
    name: definition.name,
    callChainPath: definition.callChainPath,
    ...(definition.settingImprovementPrompt === undefined
      ? {}
      : {
          settingImprovementPrompt: structuredClone(
            definition.settingImprovementPrompt,
          ),
        }),
    mounts: structuredClone(definition.mounts),
    playerViewPanels: structuredClone(definition.playerViewPanels),
    extensionRefs: [...definition.extensionRefs],
    narrativePrompts: structuredClone(definition.narrativePrompts),
    followups: structuredClone(definition.followups),
  };
}

/**
 * Apply a structured workbench edit to the portable file tree.  The result
 * still has to pass `parsePlayPresetFiles`; this function only serializes the
 * public structure and never bypasses the normal codec.
 */
export function applyPlayPresetStructuredEditor(
  files: Record<string, string>,
  input: PlayPresetStructuredEditor,
): Record<string, string> {
  const next = cloneFiles(files);
  const presetSource = next["preset.yaml"];
  const callChainSource = next[input.callChainPath];
  if (presetSource === undefined || callChainSource === undefined)
    throw new FileNativePlayPresetError(
      "structured_editor_missing_file",
      "Structured editing could not find preset.yaml or call-chain.yaml",
    );
  const preset = parseDocument(presetSource, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  const callChain = parseDocument(callChainSource, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (preset.errors.length > 0 || callChain.errors.length > 0)
    throw new FileNativePlayPresetError(
      "structured_editor_yaml_invalid",
      "Structured editing can be applied only to parseable preset/call-chain YAML",
    );
  preset.set("name", input.name);
  preset.set("callChain", input.callChainPath);
  if (input.settingImprovementPrompt === undefined)
    preset.delete("settingImprovement");
  else
    preset.set("settingImprovement", {
      role: input.settingImprovementPrompt.role,
      markdown: input.settingImprovementPrompt.path,
    });
  preset.set(
    "mounts",
    input.mounts.map(({ channel, mount }) => ({ channel, mount })),
  );
  preset.set("extensions", [...input.extensionRefs]);
  preset.set(
    "playerViewPanels",
    input.playerViewPanels.map((panel) => structuredClone(panel)),
  );
  callChain.set(
    "narrative",
    input.narrativePrompts.map(({ role, path }) => ({
      role,
      markdown: path,
    })),
  );
  callChain.set(
    "followups",
    input.followups.map((followup) => ({
      id: followup.id,
      displayName: followup.displayName,
      prompt: {
        role: followup.prompt.role,
        markdown: followup.prompt.path,
      },
      artifacts: structuredClone(followup.artifacts),
      maxArtifactBytes: followup.maxArtifactBytes,
    })),
  );
  next["preset.yaml"] = String(preset);
  next[input.callChainPath] = String(callChain);
  return next;
}

export function parsePlayPresetStructuredEditor(
  value: unknown,
): PlayPresetStructuredEditor {
  if (!isRecord(value))
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play editing must be a map",
    );
  const strings = (key: string): string[] => {
    const entries = value[key];
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry !== "string")
    )
      throw new FileNativePlayPresetError(
        "structured_editor_invalid",
        `Structured play field ${key} must be an array of strings`,
      );
    return (entries as string[]).map((entry) => entry.trim());
  };
  const rawNarrative = value.narrativePrompts;
  const rawFollowups = value.followups ?? [];
  const rawMounts = value.mounts;
  if (
    !Array.isArray(rawNarrative) ||
    !Array.isArray(rawFollowups) ||
    !Array.isArray(rawMounts)
  )
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play editing must include narrativePrompts, followups, and mounts arrays",
    );
  if (typeof value.name !== "string" || typeof value.callChainPath !== "string")
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play name/callChainPath is invalid",
    );
  if (
    !namePattern.test(value.name.trim()) ||
    value.name.includes(String.fromCharCode(0)) ||
    value.callChainPath !== "call-chain.yaml"
  )
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play name/callChainPath is invalid",
    );
  const mounts = rawMounts.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.channel !== "string" ||
      !/^[a-z][a-z0-9._/-]{1,127}$/u.test(entry.channel.trim()) ||
      ![
        "story",
        "sidebar",
        "composer_above",
        "composer_below",
        "overlay",
        "debug",
      ].includes(String(entry.mount))
    )
      throw new FileNativePlayPresetError(
        "structured_editor_invalid",
        "Structured play mount is invalid",
      );
    return {
      channel: entry.channel.trim(),
      mount: entry.mount as PlayPresetMount["mount"],
    };
  });
  if (new Set(mounts.map(({ channel }) => channel)).size !== mounts.length)
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play mount channels cannot be duplicated",
    );
  const promptBlock = (entry: unknown): { role: unknown; path: unknown } =>
    isRecord(entry)
      ? { role: entry.role, path: entry.path }
      : {
          role: "invalid",
          path: "",
        };
  const narrativePrompts = rawNarrative.map(promptBlock);
  const settingImprovementPrompt =
    value.settingImprovementPrompt === undefined
      ? undefined
      : promptBlock(value.settingImprovementPrompt);
  const followups = rawFollowups.map((entry) => {
    if (!isRecord(entry))
      throw new FileNativePlayPresetError(
        "structured_editor_invalid",
        "Structured play followup is invalid",
      );
    return {
      ...entry,
      prompt: promptBlock(entry.prompt),
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
    } as unknown as PlayPresetFollowupDefinition;
  });
  if (
    new Set(followups.map(({ id }) => id)).size !== followups.length ||
    followups.some(({ id }) => typeof id !== "string")
  )
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play follow-up id is invalid or duplicated",
    );
  if (
    value.playerViewPanels !== undefined &&
    (!Array.isArray(value.playerViewPanels) ||
      value.playerViewPanels.some((panel) => !isRecord(panel)))
  )
    throw new FileNativePlayPresetError(
      "structured_editor_invalid",
      "Structured play playerViewPanels must be an array of maps",
    );
  return {
    name: value.name,
    callChainPath: value.callChainPath,
    ...(settingImprovementPrompt === undefined
      ? {}
      : {
          settingImprovementPrompt:
            settingImprovementPrompt as PlayPresetPromptBlock,
        }),
    mounts,
    playerViewPanels: (value.playerViewPanels ??
      []) as PlayPresetPlayerViewPanel[],
    extensionRefs: strings("extensionRefs"),
    narrativePrompts: narrativePrompts as PlayPresetPromptBlock[],
    followups,
  };
}

export function parsePlayPresetFiles(
  files: Record<string, string>,
  limits: Partial<PortableContentTreeLimits> = {},
):
  | { kind: "valid"; definition: PlayPresetDefinition }
  | { kind: "invalid"; error: FileNativePlayPresetError } {
  try {
    const normalizedLimits = { ...defaultLimits, ...limits };
    validateFileTree(files, normalizedLimits);
    assertRequiredPresetFiles(files);
    const preset = readYaml(files, "preset.yaml", "preset.yaml");
    assertNoEditableMechanics(preset, "preset.yaml");
    assertKnownKeys(
      preset,
      [
        "format",
        "name",
        "callChain",
        "settingImprovement",
        "mounts",
        "playerViewPanels",
        "extensions",
      ],
      "preset.yaml",
    );
    const callChainPath = stringValue(preset.callChain);
    if (callChainPath !== "call-chain.yaml")
      invalid(
        "call_chain_path_invalid",
        "Entry callChain must be call-chain.yaml",
        "preset.yaml",
      );
    if (preset.format !== "narraeon.play-preset/v1")
      invalid(
        "preset_format_invalid",
        "preset.yaml format must be narraeon.play-preset/v1",
        "preset.yaml",
      );
    const name = stringValue(preset.name);
    if (!namePattern.test(name.trim()) || name.includes(String.fromCharCode(0)))
      invalid(
        "invalid_name",
        "Play-preset name must contain 1 to 160 characters",
        "preset.yaml",
      );
    const callChain = readYaml(files, callChainPath, "call-chain.yaml");
    assertNoEditableMechanics(callChain, callChainPath);
    assertKnownKeys(
      callChain,
      ["format", "narrative", "followups"],
      callChainPath,
    );
    if (callChain.format !== "narraeon.play-call-chain/v1")
      invalid(
        "call_chain_format_invalid",
        "call-chain.yaml format must be narraeon.play-call-chain/v1",
        callChainPath,
      );
    // The host preset already carries the general narrative criteria, so a
    // preset that adds nothing of its own is legitimate.
    const narrativePrompts = parsePromptBlocks(
      callChain.narrative,
      files,
      "call-chain.yaml#narrative",
      true,
    );
    const settingImprovementPrompt =
      preset.settingImprovement === undefined
        ? undefined
        : parsePromptBlocks(
            [preset.settingImprovement],
            files,
            "preset.yaml#settingImprovement",
          )[0];
    const followups = parseFollowups(callChain.followups, files);
    const mounts = parseMounts(preset.mounts);
    const playerViewPanels = parsePlayerViewPanels(
      preset.playerViewPanels,
      files,
    );
    validatePanelChannels(followups, playerViewPanels);
    const extensionRefs = validatePresetReferences(preset, files);
    validateArtifactExtensionReferences(followups, extensionRefs);
    return {
      kind: "valid",
      definition: {
        format: "narraeon.play-preset/v1",
        name: name.trim(),
        callChainPath,
        ...(settingImprovementPrompt === undefined
          ? {}
          : { settingImprovementPrompt }),
        mounts,
        playerViewPanels,
        extensionRefs,
        narrativePrompts,
        followups,
        files: cloneFiles(files),
      },
    };
  } catch (error: unknown) {
    if (error instanceof FileNativePlayPresetError)
      return { kind: "invalid", error };
    return {
      kind: "invalid",
      error: new FileNativePlayPresetError(
        "play_preset_invalid",
        error instanceof Error ? error.message : "Play preset is invalid",
      ),
    };
  }
}

function parsePromptBlocks(
  value: unknown,
  files: Record<string, string>,
  location: string,
  allowEmpty = false,
): PlayPresetPromptBlock[] {
  if (allowEmpty && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || (value.length === 0 && !allowEmpty))
    invalid(
      "prompts_missing",
      "At least one Markdown prompt block is required",
      location,
    );
  return (value as unknown[]).map((raw, index) => {
    const promptLocation = `${location}#prompts[${index}]`;
    if (!isRecord(raw))
      invalid(
        "prompt_ref_invalid",
        "A prompt-block reference must be a map containing markdown",
        promptLocation,
      );
    const entry = raw;
    assertKnownKeys(entry, ["role", "markdown"], promptLocation);
    // author_instruction is the only role a preset may contribute, so an
    // omitted role is the normal spelling rather than a missing field.
    const role = entry.role ?? "author_instruction";
    if (!isPlayPresetPromptRole(role))
      invalid(
        "prompt_role_invalid",
        "A play prompt block may use only the author_instruction role",
        promptLocation,
      );
    const path = stringValue(entry.markdown).trim();
    if (!/^prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(path))
      invalid(
        "prompt_path_invalid",
        "A prompt block must reference prompts/*.md",
        promptLocation,
      );
    const body = files[path];
    if (body === undefined || body.trim() === "")
      invalid("prompt_missing", `Prompt block does not exist: ${path}`, path);
    return { role, path };
  });
}

/**
 * Follow-ups have no ordering contract. The parser needs only each request's
 * identity, its single author prompt, and the artifacts it may emit.
 */
function parseFollowups(
  value: unknown,
  files: Record<string, string>,
): PlayPresetFollowupDefinition[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    invalid(
      "followups_invalid",
      "callChain.followups must be an array",
      "call-chain.yaml",
    );
  if (value.length > maxPlayPresetFollowups)
    invalid(
      "followups_invalid",
      `callChain.followups cannot exceed ${maxPlayPresetFollowups} items`,
      "call-chain.yaml",
    );
  const followups = (value as unknown[]).map((raw, index) => {
    const location = `call-chain.yaml#followups[${index}]`;
    if (!isRecord(raw))
      invalid(
        "followup_invalid",
        "A follow-up request must be a map",
        location,
      );
    const id = stringValue(raw.id).trim();
    assertKnownKeys(
      raw,
      ["id", "displayName", "prompt", "artifacts", "maxArtifactBytes"],
      location,
    );
    const displayName = stringValue(raw.displayName).trim();
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(id))
      invalid(
        "followup_id_invalid",
        "A follow-up request id must be a stable lowercase ASCII identifier",
        location,
      );
    if (!namePattern.test(displayName))
      invalid(
        "followup_name_invalid",
        "Follow-up request display name is invalid",
        location,
      );
    const prompts = parsePromptBlocks([raw.prompt], files, location);
    if (prompts.length !== 1)
      invalid(
        "followup_prompt_invalid",
        "A follow-up request must declare exactly one prompt block",
        location,
      );
    const artifacts = parseArtifacts(raw.artifacts ?? [], files, location);
    if (artifacts.length === 0)
      invalid(
        "followup_artifact_missing",
        "A follow-up request must declare at least one artifact",
        location,
      );
    if (
      artifacts.some(
        (artifact) =>
          artifact.strategy === "upsert" && artifact.key === undefined,
      )
    )
      invalid(
        "upsert_key_missing",
        "An upsert channel must declare a key",
        location,
      );
    return {
      id,
      displayName,
      prompt: prompts[0]!,
      artifacts,
      maxArtifactBytes: parseMaxArtifactBytes(raw.maxArtifactBytes, location),
    } satisfies PlayPresetFollowupDefinition;
  });
  if (new Set(followups.map(({ id }) => id)).size !== followups.length)
    invalid(
      "duplicate_followup_id",
      "Follow-up request id is duplicated",
      "call-chain.yaml",
    );
  // One channel has one projection meaning. Two followups writing the same
  // channel with different strategies would make the visible set depend on
  // dispatch order, which followups deliberately do not have.
  const strategies = new Map<string, string>();
  for (const { artifacts } of followups)
    for (const { channel, strategy } of artifacts) {
      const known = strategies.get(channel);
      if (known !== undefined && known !== strategy)
        invalid(
          "channel_strategy_conflict",
          `One channel cannot declare conflicting projection policies: ${channel}`,
          "call-chain.yaml",
        );
      strategies.set(channel, strategy);
    }
  return followups;
}

function parseMaxArtifactBytes(value: unknown, location: string): number {
  if (value === undefined) return defaultMaxArtifactBytes;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maxArtifactBytesCeiling
  )
    invalid(
      "followup_bytes_invalid",
      `maxArtifactBytes must be an integer from 1 to ${maxArtifactBytesCeiling}`,
      location,
    );
  return value;
}

function parseArtifacts(
  value: unknown,
  files: Record<string, string>,
  location: string,
): PlayPresetArtifactDeclaration[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    invalid(
      "artifacts_invalid",
      "Follow-up request artifacts must be an array",
      location,
    );
  const names = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const artifactLocation = `${location}#artifacts[${index}]`;
    if (!isRecord(raw))
      invalid(
        "artifact_invalid",
        "An artifact declaration must be a map",
        artifactLocation,
      );
    assertKnownKeys(
      raw,
      [
        "name",
        "channel",
        "strategy",
        "key",
        "contentType",
        "renderer",
        "rendererRevision",
        "rendererMode",
        "regex",
        "scripts",
        "assets",
        "save",
        "invalidation",
        "required",
        "maxEmits",
        "payloadContract",
      ],
      artifactLocation,
    );
    const name = stringValue(raw.name).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(name))
      invalid(
        "artifact_output_name_invalid",
        "An artifact must declare a stable lowercase output name",
        artifactLocation,
      );
    if (names.has(name))
      invalid(
        "duplicate_artifact_output_name",
        `Artifact name is duplicated: ${name}`,
        artifactLocation,
      );
    names.add(name);
    const channel = stringValue(raw.channel).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(channel))
      invalid(
        "channel_invalid",
        "Artifact channel must be a stable lowercase address",
        artifactLocation,
      );
    const strategy = raw.strategy;
    if (
      !["append", "replace", "upsert", "transient", "hidden"].includes(
        String(strategy),
      )
    )
      invalid(
        "channel_strategy_invalid",
        "Artifact channel policy is invalid",
        artifactLocation,
      );
    const contentType = raw.contentType ?? "text/plain";
    if (
      typeof contentType !== "string" ||
      ![
        "text/plain",
        "text/markdown",
        "application/json",
        "text/html",
      ].includes(contentType)
    )
      invalid(
        "artifact_content_type_invalid",
        "Artifact contentType is invalid",
        artifactLocation,
      );
    const save = raw.save ?? "operation";
    if (
      typeof save !== "string" ||
      !["none", "operation", "commit"].includes(save)
    )
      invalid(
        "artifact_save_invalid",
        "Artifact retention policy is invalid",
        artifactLocation,
      );
    const renderer =
      raw.renderer === undefined ? undefined : stringValue(raw.renderer).trim();
    if (
      renderer !== undefined &&
      !/^renderers\/[A-Za-z0-9][A-Za-z0-9._-]*\.html$/u.test(renderer)
    )
      invalid(
        "renderer_path_invalid",
        "renderer must reference renderers/*.html",
        artifactLocation,
      );
    if (renderer !== undefined && files[renderer] === undefined)
      invalid(
        "renderer_missing",
        `Renderer does not exist: ${renderer}`,
        renderer,
      );
    const rendererRevision =
      raw.rendererRevision === undefined
        ? undefined
        : stringValue(raw.rendererRevision).trim();
    if (renderer !== undefined && !rendererRevision)
      invalid(
        "renderer_revision_missing",
        "renderer must also declare a content revision",
        artifactLocation,
      );
    if (renderer === undefined && rendererRevision !== undefined)
      invalid(
        "renderer_revision_without_path",
        "rendererRevision cannot be declared without a renderer path",
        artifactLocation,
      );
    const rendererModeValue = raw.rendererMode ?? "document";
    if (rendererModeValue !== "document" && rendererModeValue !== "app")
      invalid(
        "renderer_mode_invalid",
        "rendererMode must be document or app",
        artifactLocation,
      );
    if (rendererModeValue === "app" && renderer === undefined)
      invalid(
        "renderer_mode_renderer_missing",
        "An app renderer must declare a custom renderer",
        artifactLocation,
      );
    const regex =
      raw.regex === undefined ? undefined : stringValue(raw.regex).trim();
    if (
      regex !== undefined &&
      !/^regex\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/u.test(regex)
    )
      invalid(
        "regex_path_invalid",
        "regex must reference regex/*.yaml",
        artifactLocation,
      );
    if (regex !== undefined && files[regex] === undefined)
      invalid(
        "regex_missing",
        `Regex resource does not exist: ${regex}`,
        regex,
      );
    const scripts = parseExtensionPaths(
      raw.scripts,
      /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u,
      "script",
      artifactLocation,
      files,
      16,
    );
    const assets = parseExtensionPaths(
      raw.assets,
      /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
      "asset",
      artifactLocation,
      files,
      64,
    );
    const key = raw.key === undefined ? undefined : stringValue(raw.key).trim();
    if (key !== undefined && !/^[a-z][a-z0-9._/-]{0,127}$/u.test(key))
      invalid(
        "artifact_key_invalid",
        "Artifact key is invalid",
        artifactLocation,
      );
    const invalidationValue =
      raw.invalidation ??
      (save === "commit"
        ? "head_change"
        : save === "operation"
          ? "operation_end"
          : "explicit_clear");
    if (
      typeof invalidationValue !== "string" ||
      ![
        "new_operation",
        "head_change",
        "operation_end",
        "explicit_clear",
        "never",
      ].includes(invalidationValue)
    )
      invalid(
        "artifact_invalidation_invalid",
        "Artifact invalidation policy is invalid",
        artifactLocation,
      );
    const required = raw.required ?? false;
    if (typeof required !== "boolean")
      invalid(
        "artifact_required_invalid",
        "Artifact required must be a boolean",
        artifactLocation,
      );
    const maxEmits = finiteInteger(raw.maxEmits ?? 1);
    if (maxEmits === null || maxEmits < 1 || maxEmits > 128)
      invalid(
        "artifact_emit_budget_invalid",
        "Artifact maxEmits must be a bounded integer from 1 to 128",
        artifactLocation,
      );
    const payloadContract = parseArtifactPayloadContract(
      raw.payloadContract,
      `${artifactLocation}#payloadContract`,
    );
    if (payloadContract !== undefined && contentType !== "application/json")
      invalid(
        "artifact_payload_contract_type_invalid",
        "A structured payload contract can be used only with an application/json artifact",
        artifactLocation,
      );
    return {
      name,
      channel,
      strategy: strategy as PlayPresetArtifactStrategy,
      ...(key === undefined ? {} : { key }),
      contentType: contentType as PlayPresetArtifactDeclaration["contentType"],
      ...(renderer === undefined ? {} : { renderer }),
      ...(rendererRevision === undefined ? {} : { rendererRevision }),
      rendererMode: rendererModeValue === "app" ? "app" : "document",
      ...(regex === undefined ? {} : { regex }),
      ...(scripts === undefined ? {} : { scripts }),
      ...(assets === undefined ? {} : { assets }),
      save: save as PlayPresetArtifactDeclaration["save"],
      invalidation: invalidationValue as PlayPresetArtifactInvalidation,
      required,
      maxEmits,
      ...(payloadContract === undefined ? {} : { payloadContract }),
    };
  });
}

function parseArtifactPayloadContract(
  value: unknown,
  location: string,
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
): PlayPresetArtifactPayloadContract | undefined {
  if (value === undefined) return undefined;
  state.nodes += 1;
  if (depth > 32)
    invalid(
      "artifact_payload_contract_too_deep",
      "payloadContract nesting exceeds 32 levels",
      location,
    );
  if (state.nodes > 512)
    invalid(
      "artifact_payload_contract_too_complex",
      "payloadContract contains more than 512 nodes",
      location,
    );
  if (!isRecord(value))
    invalid(
      "artifact_payload_contract_invalid",
      "payloadContract must be a map",
      location,
    );
  const type = value.type;
  if (
    type !== "object" &&
    type !== "array" &&
    type !== "string" &&
    type !== "number" &&
    type !== "integer" &&
    type !== "boolean" &&
    type !== "null"
  )
    invalid(
      "artifact_payload_contract_type_invalid",
      "payloadContract.type is invalid",
      location,
    );
  const propertiesValue = value.properties;
  let properties: Record<string, PlayPresetArtifactPayloadContract> | undefined;
  if (propertiesValue !== undefined) {
    if (!isRecord(propertiesValue))
      invalid(
        "artifact_payload_contract_properties_invalid",
        "payloadContract.properties must be a map",
        location,
      );
    properties = {};
    for (const [key, child] of Object.entries(propertiesValue)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(key))
        invalid(
          "artifact_payload_contract_property_invalid",
          `payloadContract property name is invalid: ${key}`,
          location,
        );
      properties[key] = parseArtifactPayloadContract(
        child,
        `${location}.properties.${key}`,
        state,
        depth + 1,
      )!;
    }
  }
  const requiredValue = value.required;
  let required: string[] | undefined;
  if (requiredValue !== undefined) {
    if (
      !Array.isArray(requiredValue) ||
      requiredValue.some((entry) => typeof entry !== "string")
    )
      invalid(
        "artifact_payload_contract_required_invalid",
        "payloadContract.required must be an array of strings",
        location,
      );
    required = (requiredValue as string[]).map((entry) => entry.trim());
    if (
      required.some((entry) => entry === "") ||
      new Set(required).size !== required.length
    )
      invalid(
        "artifact_payload_contract_required_invalid",
        "payloadContract.required cannot contain empty or duplicate fields",
        location,
      );
    if (
      properties !== undefined &&
      required.some((entry) => properties?.[entry] === undefined)
    )
      invalid(
        "artifact_payload_contract_required_invalid",
        "payloadContract.required must reference fields in properties",
        location,
      );
  }
  const itemsValue = value.items;
  const items =
    itemsValue === undefined
      ? undefined
      : parseArtifactPayloadContract(
          itemsValue,
          `${location}.items`,
          state,
          depth + 1,
        );
  if (type === "object" && properties === undefined)
    invalid(
      "artifact_payload_contract_properties_invalid",
      "An object payloadContract must declare properties",
      location,
    );
  if (type === "array" && items === undefined)
    invalid(
      "artifact_payload_contract_items_invalid",
      "An array payloadContract must declare items",
      location,
    );
  if (type !== "object" && (properties !== undefined || required !== undefined))
    invalid(
      "artifact_payload_contract_shape_invalid",
      "Only an object payloadContract may declare properties/required",
      location,
    );
  if (
    type !== "array" &&
    (items !== undefined ||
      value.minItems !== undefined ||
      value.maxItems !== undefined ||
      value.uniqueBy !== undefined)
  )
    invalid(
      "artifact_payload_contract_shape_invalid",
      "Only an array payloadContract may declare items/minItems/maxItems/uniqueBy",
      location,
    );
  const minItems = boundedContractInteger(value.minItems, location, "minItems");
  const maxItems = boundedContractInteger(value.maxItems, location, "maxItems");
  const minLength = boundedContractInteger(
    value.minLength,
    location,
    "minLength",
  );
  const maxLength = boundedContractInteger(
    value.maxLength,
    location,
    "maxLength",
  );
  const maxBytes = boundedContractInteger(value.maxBytes, location, "maxBytes");
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
    invalid(
      "artifact_payload_contract_bounds_invalid",
      "payloadContract.minItems cannot exceed maxItems",
      location,
    );
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  )
    invalid(
      "artifact_payload_contract_bounds_invalid",
      "payloadContract.minLength cannot exceed maxLength",
      location,
    );
  if (type !== "string" && (minLength !== undefined || maxLength !== undefined))
    invalid(
      "artifact_payload_contract_shape_invalid",
      "Only a string payloadContract may declare length bounds",
      location,
    );
  if (value.uniqueBy !== undefined) {
    if (typeof value.uniqueBy !== "string" || value.uniqueBy.trim() === "")
      invalid(
        "artifact_payload_contract_unique_invalid",
        "payloadContract.uniqueBy must be a non-empty field name",
        location,
      );
    if (type !== "array" || items?.type !== "object")
      invalid(
        "artifact_payload_contract_unique_invalid",
        "payloadContract.uniqueBy can be used only for an array of object items",
        location,
      );
    if (items.properties?.[value.uniqueBy.trim()] === undefined)
      invalid(
        "artifact_payload_contract_unique_invalid",
        "payloadContract.uniqueBy must reference an item properties field",
        location,
      );
  }
  if (value.additionalProperties !== undefined && type !== "object")
    invalid(
      "artifact_payload_contract_shape_invalid",
      "Only an object payloadContract may declare additionalProperties",
      location,
    );
  return {
    type,
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
    ...(value.additionalProperties === undefined
      ? {}
      : {
          additionalProperties: booleanValue(
            value.additionalProperties,
            location,
          ),
        }),
    ...(items === undefined ? {} : { items }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(value.uniqueBy === undefined
      ? {}
      : { uniqueBy: value.uniqueBy.trim() }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function boundedContractInteger(
  value: unknown,
  location: string,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 4 * 1024 * 1024
  )
    invalid(
      "artifact_payload_contract_bounds_invalid",
      `payloadContract.${field} must be a bounded non-negative integer`,
      location,
    );
  return value as number;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean")
    invalid(
      "artifact_payload_contract_boolean_invalid",
      "payloadContract.additionalProperties must be a boolean",
      location,
    );
  return value;
}

function parseMounts(value: unknown): PlayPresetMount[] {
  if (value === undefined || value === null) return [];
  const entries: { channel: unknown; mount: unknown }[] = Array.isArray(value)
    ? (value as unknown[]).map((entry) =>
        isRecord(entry)
          ? { channel: entry.channel, mount: entry.mount }
          : { channel: undefined, mount: undefined },
      )
    : isRecord(value)
      ? Object.entries(value).map(([channel, mount]) => ({ channel, mount }))
      : [];
  if (!Array.isArray(value) && !isRecord(value))
    invalid(
      "mounts_invalid",
      "preset.mounts must be a map or array",
      "preset.yaml",
    );
  const channels = new Set<string>();
  return entries.map(({ channel, mount }, index) => {
    const location = `preset.yaml#mounts[${index}]`;
    const normalizedChannel = stringValue(channel).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(normalizedChannel))
      invalid(
        "mount_channel_invalid",
        "Channel mount channel is invalid",
        location,
      );
    if (channels.has(normalizedChannel))
      invalid(
        "duplicate_mount_channel",
        `Channel mount is duplicated: ${normalizedChannel}`,
        location,
      );
    channels.add(normalizedChannel);
    if (
      ![
        "story",
        "sidebar",
        "composer_above",
        "composer_below",
        "overlay",
        "debug",
      ].includes(String(mount))
    )
      invalid(
        "mount_invalid",
        "A channel mount must use a supported standard mount point",
        location,
      );
    return {
      channel: normalizedChannel,
      mount: mount as PlayPresetMount["mount"],
    };
  });
}

function parsePlayerViewPanels(
  value: unknown,
  files: Record<string, string>,
): PlayPresetPlayerViewPanel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    invalid(
      "player_view_panels_invalid",
      "preset.playerViewPanels must be an array",
      "preset.yaml",
    );
  const ids = new Set<string>();
  const channelKeys = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const location = `preset.yaml#playerViewPanels[${index}]`;
    if (!isRecord(raw))
      invalid(
        "player_view_panel_invalid",
        "A player-view panel must be a map",
        location,
      );
    assertKnownKeys(
      raw,
      [
        "id",
        "source",
        "channel",
        "key",
        "mount",
        "renderer",
        "rendererRevision",
        "rendererMode",
        "regex",
        "scripts",
        "assets",
        "config",
      ],
      location,
    );
    const id = stringValue(raw.id).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(id))
      invalid(
        "player_view_panel_id_invalid",
        "A player-view panel id must be a stable lowercase identifier",
        location,
      );
    if (ids.has(id))
      invalid(
        "duplicate_player_view_panel_id",
        `Player-view panel id is duplicated: ${id}`,
        location,
      );
    ids.add(id);

    const sourceValue = raw.source;
    if (!isRecord(sourceValue) || sourceValue.kind !== "player_view")
      invalid(
        "player_view_panel_source_invalid",
        "A player-view panel source must declare kind: player_view",
        location,
      );
    assertKnownKeys(sourceValue, ["kind", "view", "itemIds"], location);
    const view = stringValue(sourceValue.view).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(view))
      invalid(
        "player_view_panel_view_invalid",
        "A player-view panel must reference a stable view id",
        location,
      );
    const rawItemIds = sourceValue.itemIds;
    let itemIds: string[] | undefined;
    if (rawItemIds !== undefined) {
      if (
        !Array.isArray(rawItemIds) ||
        rawItemIds.length > 128 ||
        rawItemIds.some(
          (item) =>
            typeof item !== "string" ||
            !/^[a-z][a-z0-9._/-]{0,127}$/u.test(item.trim()),
        )
      )
        invalid(
          "player_view_panel_items_invalid",
          "Player-view panel itemIds must be a bounded array of stable ids",
          location,
        );
      itemIds = (rawItemIds as string[]).map((item) => item.trim());
      if (new Set(itemIds).size !== itemIds.length)
        invalid(
          "duplicate_player_view_panel_item",
          "Player-view panel itemIds cannot be duplicated",
          location,
        );
    }

    const channel = stringValue(raw.channel).trim();
    if (!/^[a-z][a-z0-9._/-]{1,127}$/u.test(channel))
      invalid(
        "player_view_panel_channel_invalid",
        "A player-view panel channel must be a stable lowercase address",
        location,
      );
    const key = stringValue(raw.key).trim();
    if (!/^[a-z][a-z0-9._/-]{0,127}$/u.test(key))
      invalid(
        "player_view_panel_key_invalid",
        "A player-view panel upsert must declare a stable key",
        location,
      );
    const channelKey = `${channel}\0${key}`;
    if (channelKeys.has(channelKey))
      invalid(
        "duplicate_player_view_panel_key",
        `Player-view panel channel/key cannot be duplicated: ${channel}/${key}`,
        location,
      );
    channelKeys.add(channelKey);
    const mount = raw.mount;
    if (
      ![
        "story",
        "sidebar",
        "composer_above",
        "composer_below",
        "overlay",
        "debug",
      ].includes(String(mount))
    )
      invalid(
        "player_view_panel_mount_invalid",
        "A player-view panel mount must use a supported standard mount point",
        location,
      );

    const renderer =
      raw.renderer === undefined ? undefined : stringValue(raw.renderer).trim();
    if (
      renderer !== undefined &&
      !/^renderers\/[A-Za-z0-9][A-Za-z0-9._-]*\.html$/u.test(renderer)
    )
      invalid(
        "player_view_panel_renderer_invalid",
        "A player-view panel renderer must reference renderers/*.html",
        location,
      );
    if (renderer !== undefined && files[renderer] === undefined)
      invalid(
        "player_view_panel_renderer_missing",
        `Renderer does not exist: ${renderer}`,
        renderer,
      );
    const rendererRevision =
      raw.rendererRevision === undefined
        ? undefined
        : stringValue(raw.rendererRevision).trim();
    if (renderer !== undefined && !rendererRevision)
      invalid(
        "player_view_panel_renderer_revision_missing",
        "A player-view panel renderer must also declare a content revision",
        location,
      );
    if (renderer === undefined && rendererRevision !== undefined)
      invalid(
        "player_view_panel_renderer_revision_without_path",
        "rendererRevision cannot be declared without a renderer path",
        location,
      );
    const rendererModeValue =
      raw.rendererMode ?? (renderer === undefined ? "document" : "app");
    if (rendererModeValue !== "document" && rendererModeValue !== "app")
      invalid(
        "player_view_panel_renderer_mode_invalid",
        "Player-view panel rendererMode must be document or app",
        location,
      );
    if (rendererModeValue === "app" && renderer === undefined)
      invalid(
        "player_view_panel_renderer_missing",
        "An app player-view panel must declare a renderer",
        location,
      );
    const regex =
      raw.regex === undefined ? undefined : stringValue(raw.regex).trim();
    if (
      regex !== undefined &&
      !/^regex\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/u.test(regex)
    )
      invalid(
        "player_view_panel_regex_invalid",
        "Player-view panel regex must reference regex/*.yaml",
        location,
      );
    if (regex !== undefined && files[regex] === undefined)
      invalid(
        "player_view_panel_regex_missing",
        `Regex does not exist: ${regex}`,
        regex,
      );
    const scripts = parseExtensionPaths(
      raw.scripts,
      /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u,
      "script",
      location,
      files,
      16,
    );
    const assets = parseExtensionPaths(
      raw.assets,
      /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
      "asset",
      location,
      files,
      64,
    );
    const config = parsePlayerViewPanelConfig(raw.config, location);
    if (itemIds !== undefined) {
      const sourceItemIds = new Set(itemIds);
      for (const group of config.groups)
        if (group.itemIds.some((itemId) => !sourceItemIds.has(itemId)))
          invalid(
            "player_view_panel_group_outside_source",
            "Player-view panel group itemIds must be within source.itemIds",
            location,
          );
    }
    return {
      id,
      source: {
        kind: "player_view",
        view,
        ...(itemIds === undefined ? {} : { itemIds }),
      },
      channel,
      key,
      mount: mount as PlayPresetMount["mount"],
      ...(renderer === undefined ? {} : { renderer }),
      ...(rendererRevision === undefined ? {} : { rendererRevision }),
      rendererMode: rendererModeValue === "app" ? "app" : "document",
      ...(regex === undefined ? {} : { regex }),
      ...(scripts === undefined ? {} : { scripts }),
      ...(assets === undefined ? {} : { assets }),
      config,
    };
  });
}

function parsePlayerViewPanelConfig(
  value: unknown,
  location: string,
): PlayPresetPlayerViewPanelConfig {
  if (value !== undefined && !isRecord(value))
    invalid(
      "player_view_panel_config_invalid",
      "Player-view panel config must be a map",
      location,
    );
  const config = value ?? {};
  assertKnownKeys(
    config,
    ["title", "layout", "theme", "empty", "emptyMessage", "groups"],
    location,
  );
  const title =
    config.title === undefined ? undefined : stringValue(config.title).trim();
  if (title !== undefined && !namePattern.test(title))
    invalid(
      "player_view_panel_title_invalid",
      "Player-view panel title is invalid",
      location,
    );
  const layout = config.layout ?? "stack";
  if (layout !== "stack" && layout !== "grid")
    invalid(
      "player_view_panel_layout_invalid",
      "Player-view panel layout must be stack or grid",
      location,
    );
  const theme =
    config.theme === undefined ? "default" : stringValue(config.theme).trim();
  if (!/^[a-z][a-z0-9._/-]{0,63}$/u.test(theme))
    invalid(
      "player_view_panel_theme_invalid",
      "Player-view panel theme must be a stable identifier",
      location,
    );
  const empty = config.empty ?? "message";
  if (empty !== "hide" && empty !== "message" && empty !== "show")
    invalid(
      "player_view_panel_empty_invalid",
      "Player-view panel empty must be hide, message, or show",
      location,
    );
  const emptyMessage =
    config.emptyMessage === undefined
      ? "There is no content to display."
      : stringValue(config.emptyMessage);
  if (emptyMessage.length > 256)
    invalid(
      "player_view_panel_empty_message_invalid",
      "Player-view panel emptyMessage is too long",
      location,
    );
  const rawGroups = config.groups;
  if (rawGroups !== undefined && !Array.isArray(rawGroups))
    invalid(
      "player_view_panel_groups_invalid",
      "Player-view panel groups must be an array",
      location,
    );
  const groups: PlayPresetPlayerViewPanelGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, rawGroup] of (rawGroups ?? []).entries()) {
    const groupLocation = `${location}#config.groups[${index}]`;
    if (!isRecord(rawGroup))
      invalid(
        "player_view_panel_group_invalid",
        "A player-view panel group must be a map",
        groupLocation,
      );
    assertKnownKeys(rawGroup, ["id", "label", "itemIds"], groupLocation);
    const id = stringValue(rawGroup.id).trim();
    const label = stringValue(rawGroup.label).trim();
    if (!/^[a-z][a-z0-9._/-]{1,63}$/u.test(id) || !namePattern.test(label))
      invalid(
        "player_view_panel_group_invalid",
        "Player-view panel group id/label is invalid",
        groupLocation,
      );
    if (groupIds.has(id))
      invalid(
        "duplicate_player_view_panel_group",
        `Player-view panel group is duplicated: ${id}`,
        groupLocation,
      );
    groupIds.add(id);
    const rawItems = rawGroup.itemIds ?? [];
    if (
      !Array.isArray(rawItems) ||
      rawItems.length > 128 ||
      rawItems.some(
        (item) =>
          typeof item !== "string" ||
          !/^[a-z][a-z0-9._/-]{0,127}$/u.test(item.trim()),
      )
    )
      invalid(
        "player_view_panel_group_items_invalid",
        "Player-view panel group itemIds are invalid",
        groupLocation,
      );
    const itemIds = (rawItems as string[]).map((item) => item.trim());
    if (new Set(itemIds).size !== itemIds.length)
      invalid(
        "duplicate_player_view_panel_group_item",
        "Player-view panel group itemIds cannot be duplicated",
        groupLocation,
      );
    groups.push({ id, label, itemIds });
  }
  return {
    ...(title === undefined ? {} : { title }),
    layout,
    theme,
    empty,
    emptyMessage,
    groups,
  };
}

function validatePanelChannels(
  followups: PlayPresetFollowupDefinition[],
  panels: PlayPresetPlayerViewPanel[],
): void {
  const artifactChannels = new Set(
    followups.flatMap(({ artifacts }) =>
      artifacts.map(({ channel }) => channel),
    ),
  );
  for (const panel of panels)
    if (artifactChannels.has(panel.channel))
      invalid(
        "player_view_panel_channel_conflict",
        `A player-view panel channel cannot be shared with a follow-up artifact: ${panel.channel}`,
        "preset.yaml",
      );
}

function parseExtensionPaths(
  value: unknown,
  pattern: RegExp,
  kind: "script" | "asset",
  location: string,
  files: Record<string, string>,
  max: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    invalid(
      `${kind}_refs_invalid`,
      `${kind} must be an array of resource paths`,
      location,
    );
  if (value.length > max)
    invalid(
      `${kind}_refs_too_many`,
      `${kind} count exceeds the limit of ${max}`,
      location,
    );
  const paths = (value as unknown[]).map((raw, index) => {
    const path = stringValue(raw).trim();
    const itemLocation = `${location}#${kind}s[${index}]`;
    if (!pattern.test(path))
      invalid(`${kind}_path_invalid`, `${kind} path is invalid`, itemLocation);
    if (files[path] === undefined)
      invalid(
        `${kind}_missing`,
        `${kind} resource does not exist: ${path}`,
        path,
      );
    return path;
  });
  if (new Set(paths).size !== paths.length)
    invalid(
      `${kind}_duplicate`,
      `${kind} resources cannot be duplicated`,
      location,
    );
  return paths;
}

function validatePresetReferences(
  preset: Record<string, unknown>,
  files: Record<string, string>,
): string[] {
  const extensions = preset.extensions;
  if (extensions === undefined) return [];
  if (!Array.isArray(extensions))
    invalid(
      "extensions_invalid",
      "preset.extensions must be an array of references",
      "preset.yaml",
    );
  const paths: string[] = [];
  for (const raw of extensions as unknown[]) {
    const path = raw;
    if (
      typeof path !== "string" ||
      !/^(?:regex\/[^/]+\.yaml|renderers\/[^/]+\.html|scripts\/[^/]+\.js|assets\/.+)$/u.test(
        path,
      )
    )
      invalid(
        "extension_ref_invalid",
        "An extension reference must be a regex, renderer, script, or asset path",
        "preset.yaml",
      );
    if (files[path] === undefined)
      invalid(
        "extension_ref_missing",
        `Extension resource does not exist: ${path}`,
        path,
      );
    if (paths.includes(path))
      invalid(
        "duplicate_extension_ref",
        `Extension resource reference is duplicated: ${path}`,
        path,
      );
    paths.push(path);
    if (path.startsWith("regex/")) validateRegexAsset(files[path], path);
  }
  return paths;
}

export function parsePlayPresetRegexAsset(
  source: string,
  path = "regex/inline.yaml",
): PlayPresetRegexRule[] {
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    invalid(
      "regex_asset_invalid",
      `Regex-resource YAML is invalid: ${path}`,
      path,
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const rules = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.rules)
      ? value.rules
      : null;
  if (rules === null || rules.length > 256)
    invalid(
      "regex_rules_invalid",
      `A regex resource may contain at most 256 rules: ${path}`,
      path,
    );
  const orders = new Set<number>();
  const parsed = rules.map((raw, index): PlayPresetRegexRule => {
    const location = `${path}#rules[${index}]`;
    if (!isRecord(raw))
      invalid("regex_rule_invalid", "A regex rule must be a map", location);
    assertKnownKeys(
      raw,
      [
        "order",
        "scope",
        "pattern",
        "flags",
        "replace",
        "maxMatches",
        "errorPolicy",
      ],
      location,
    );
    const order = raw.order;
    if (!Number.isSafeInteger(order) || (order as number) < 0)
      invalid(
        "regex_order_invalid",
        "A regex rule must declare a non-negative integer order",
        location,
      );
    if (orders.has(order as number))
      invalid(
        "regex_order_duplicate",
        "Regex rule order cannot be duplicated",
        location,
      );
    orders.add(order as number);
    const scope = raw.scope;
    if (
      scope !== "raw_text" &&
      scope !== "markdown_html" &&
      scope !== "structured_payload"
    )
      invalid(
        "regex_scope_invalid",
        "A regex rule must declare raw_text, markdown_html, or structured_payload scope",
        location,
      );
    const pattern = raw.pattern;
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.length > 4_096
    )
      invalid(
        "regex_pattern_invalid",
        "Regex pattern must be a bounded non-empty string",
        location,
      );
    const flags = raw.flags === undefined ? "" : raw.flags;
    if (typeof flags !== "string" || flags.length > 16)
      invalid("regex_flags_invalid", "Regex flags are invalid", location);
    try {
      new RegExp(pattern, flags);
    } catch {
      invalid(
        "regex_pattern_invalid",
        "Regex pattern could not be compiled",
        location,
      );
    }
    if (typeof raw.replace !== "string")
      invalid("regex_replace_invalid", "Regex replace must be text", location);
    const maxMatches = raw.maxMatches ?? 1;
    if (
      !Number.isSafeInteger(maxMatches) ||
      (maxMatches as number) < 1 ||
      (maxMatches as number) > 1_024
    )
      invalid(
        "regex_limit_invalid",
        "Regex replacement count must be a bounded positive integer",
        location,
      );
    const errorPolicy = raw.errorPolicy;
    if (
      errorPolicy !== "fallback" &&
      errorPolicy !== "skip" &&
      errorPolicy !== "fail"
    )
      invalid(
        "regex_error_policy_invalid",
        "A regex rule must declare fallback, skip, or fail errorPolicy",
        location,
      );
    return {
      order: order as number,
      scope,
      pattern,
      flags,
      replace: raw.replace,
      maxMatches: maxMatches as number,
      errorPolicy,
    };
  });
  return parsed.sort((left, right) => left.order - right.order);
}

function validateRegexAsset(source: string, path: string): void {
  parsePlayPresetRegexAsset(source, path);
}

function validateArtifactExtensionReferences(
  followups: PlayPresetFollowupDefinition[],
  extensionRefs: string[],
): void {
  const refs = new Set(extensionRefs);
  for (const followup of followups)
    for (const artifact of followup.artifacts) {
      const paths = [
        artifact.regex,
        artifact.renderer,
        ...(artifact.scripts ?? []),
        ...(artifact.assets ?? []),
      ].filter((path): path is string => path !== undefined);
      for (const path of paths)
        if (!refs.has(path))
          invalid(
            "artifact_extension_ref_missing",
            `Artifact resource must also be listed in preset.extensions: ${path}`,
            path,
          );
    }
}

function assertNoEditableMechanics(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoEditableMechanics(entry, `${location}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:inputSchema|toolSchema|toolDefinitions|toolResults|providerState|cacheKey|cache|operation|operationId|worldId|worldState|modelId|hostPresetId|currentPresetId|machinePath|localPath)$/u.test(
        key,
      )
    )
      invalid(
        "editable_mechanics_forbidden",
        `A play preset cannot store Runtime tool schemas or results: ${key}`,
        location,
      );
    assertNoEditableMechanics(child, `${location}.${key}`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown !== undefined)
    invalid(
      "unsupported_field",
      `The current play format does not support field: ${unknown}`,
      location,
    );
}

function validateFileTree(
  files: Record<string, string>,
  limits: PortableContentTreeLimits,
): void {
  const entries = Object.entries(files);
  if (entries.length > limits.maxFiles)
    invalid(
      "too_many_files",
      "Play-preset file count exceeds the safety limit",
      "preset.yaml",
    );
  let total = 0;
  const keys = new Set<string>();
  for (const [path, contents] of entries) {
    validatePath(path);
    if (typeof contents !== "string")
      invalid(
        "text_encoding_invalid",
        `A play-preset file must be UTF-8 text: ${path}`,
        path,
      );
    if (Buffer.from(contents, "utf8").toString("utf8") !== contents)
      invalid(
        "text_encoding_invalid",
        `A play-preset file is not valid UTF-8 text: ${path}`,
        path,
      );
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > limits.maxFileBytes)
      invalid("file_too_large", `Play-preset file is too large: ${path}`, path);
    total += bytes;
    if (total > limits.maxTotalBytes)
      invalid(
        "total_too_large",
        "Total play-preset size exceeds the safety limit",
        "preset.yaml",
      );
    const key = portableContentTreePathKey(path);
    if (keys.has(key))
      invalid(
        "duplicate_path",
        `Play-preset path is duplicated: ${path}`,
        path,
      );
    keys.add(key);
  }
}

/**
 * Schema completeness, checked only when a tree is parsed as a preset.
 *
 * This is deliberately not part of `validateFileTree`: a revision id is a
 * content hash, and hashing a tree must not depend on whether the current
 * schema accepts it. Invalid revisions remain inspectable so the user can
 * delete them through the library surface.
 */
function assertRequiredPresetFiles(files: Record<string, string>): void {
  if (files["preset.yaml"] === undefined)
    invalid(
      "preset_missing",
      "Play preset is missing preset.yaml",
      "preset.yaml",
    );
  if (files["call-chain.yaml"] === undefined)
    invalid(
      "call_chain_missing",
      "Play preset is missing call-chain.yaml",
      "call-chain.yaml",
    );
  if (files["frame.yaml"] === undefined)
    invalid("frame_missing", "Preset is missing frame.yaml", "frame.yaml");
}

function validatePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  )
    invalid(
      "path_invalid",
      `Play-preset path is unsafe: ${path}`,
      path || "preset.yaml",
    );
  if (
    path !== "preset.yaml" &&
    path !== "call-chain.yaml" &&
    path !== "frame.yaml" &&
    !/^(?:blocks\/[^/]+\.md|prompts\/[^/]+\.md|regex\/[^/]+\.yaml|renderers\/[^/]+\.html|scripts\/[^/]+\.js|assets\/[^/]+(?:\/[^/]+)*)$/u.test(
      path,
    )
  )
    invalid("path_invalid", `Preset does not support file path: ${path}`, path);
}

function readYaml(
  files: Record<string, string>,
  path: string,
  location: string,
): Record<string, unknown> {
  const source = files[path];
  if (source === undefined || source.trim() === "")
    invalid(
      "required_file_missing",
      `Play-preset file does not exist: ${path}`,
      location,
    );
  if (
    /(^|\s)[&*!][^\s,\]}]+/mu.test(source) ||
    /^\s*<<\s*:/mu.test(source) ||
    /^---\s*$/mu.test(source) ||
    /^\.\.\.\s*$/mu.test(source)
  )
    invalid(
      "unsafe_yaml",
      `Play-preset YAML uses syntax forbidden by the restricted codec: ${path}`,
      location,
    );
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    invalid("unsafe_yaml", `Play-preset YAML is invalid: ${path}`, location);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value))
    invalid(
      "yaml_shape_invalid",
      `Top-level play-preset YAML must be a map: ${path}`,
      location,
    );
  return value;
}

function revisionForFiles(
  files: Record<string, string>,
  limits: PortableContentTreeLimits,
): string {
  validateFileTree(files, limits);
  const canonical = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((path) => [path, files[path]]),
  );
  return `rev-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function revisionForPlayPresetFiles(
  files: Record<string, string>,
): string {
  return revisionForFiles(files, defaultLimits);
}

function toFileMap(
  input: readonly ContentTreeFile[] | Record<string, string>,
  limits: PortableContentTreeLimits,
): Record<string, string> {
  if (!Array.isArray(input)) return cloneFiles(input as Record<string, string>);
  const files: Record<string, string> = {};
  for (const file of input as readonly ContentTreeFile[]) {
    if (file.encoding !== undefined)
      invalid(
        "text_encoding_invalid",
        `Play presets accept only UTF-8 text: ${file.path}`,
        file.path,
      );
    if (files[file.path] !== undefined)
      invalid(
        "duplicate_path",
        `Play-preset path is duplicated: ${file.path}`,
        file.path,
      );
    files[file.path] = file.contents;
  }
  validateFileTree(files, limits);
  return files;
}

function parseStoredDocument(
  value: unknown,
  limits: PortableContentTreeLimits = defaultLimits,
): StoredDocument {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "currentPresetId", "presets"]) ||
    value.schemaVersion !== 1 ||
    typeof value.currentPresetId !== "string" ||
    value.currentPresetId.trim() === "" ||
    !Array.isArray(value.presets) ||
    value.presets.length === 0
  )
    throw new FileNativePlayPresetError(
      "store_invalid",
      "File-native play-preset library is invalid",
    );
  const ids = new Set<string>();
  const presets = value.presets.map((raw) => {
    if (
      !isRecord(raw) ||
      !hasExactKeys(
        raw,
        [
          "id",
          "name",
          "currentRevision",
          "revisions",
          "enabled",
          "scriptsEnabled",
        ],
        ["draftRevision", "builtinDefault"],
      ) ||
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.currentRevision !== "string" ||
      !isRecord(raw.revisions) ||
      raw.id.trim() === "" ||
      raw.id !== raw.id.trim() ||
      raw.id.includes(String.fromCharCode(0)) ||
      !namePattern.test(raw.name) ||
      raw.name !== raw.name.trim() ||
      raw.name.includes(String.fromCharCode(0)) ||
      typeof raw.enabled !== "boolean" ||
      typeof raw.scriptsEnabled !== "boolean" ||
      (raw.builtinDefault !== undefined && raw.builtinDefault !== true)
    )
      throw new FileNativePlayPresetError(
        "store_invalid",
        "File-native play-preset record is invalid",
      );
    if (ids.has(raw.id))
      throw new FileNativePlayPresetError(
        "store_invalid",
        "File-native play-preset identity is duplicated",
      );
    ids.add(raw.id);
    const revisions: Record<string, Record<string, string>> = {};
    if (Object.keys(raw.revisions).length === 0)
      throw new FileNativePlayPresetError(
        "store_invalid",
        "Play preset has no revision snapshot",
      );
    for (const [revision, files] of Object.entries(raw.revisions)) {
      if (
        !revisionPattern.test(revision) ||
        !isRecord(files) ||
        Object.keys(files).length === 0 ||
        Object.values(files).some((contents) => typeof contents !== "string")
      )
        throw new FileNativePlayPresetError(
          "store_invalid",
          "Play-preset revision snapshot is invalid",
        );
      const clone = cloneFiles(files as Record<string, string>);
      let expectedRevision: string;
      try {
        expectedRevision = revisionForFiles(clone, limits);
      } catch {
        throw new FileNativePlayPresetError(
          "store_invalid",
          "Play-preset revision file tree is invalid",
        );
      }
      if (expectedRevision !== revision)
        throw new FileNativePlayPresetError(
          "store_invalid",
          "Play-preset revision content hash does not match",
        );
      if (
        revision !== raw.draftRevision &&
        validatePlayPresetFiles(clone, limits).status !== "valid"
      )
        throw new FileNativePlayPresetError(
          "store_invalid",
          "Play-preset revision does not match the current format",
        );
      revisions[revision] = clone;
    }
    if (revisions[raw.currentRevision] === undefined)
      throw new FileNativePlayPresetError(
        "store_invalid",
        "Current play-preset revision is missing",
      );
    if (
      raw.draftRevision !== undefined &&
      (typeof raw.draftRevision !== "string" ||
        !revisionPattern.test(raw.draftRevision) ||
        revisions[raw.draftRevision] === undefined ||
        raw.draftRevision === raw.currentRevision)
    )
      throw new FileNativePlayPresetError(
        "store_invalid",
        "Play-preset draft revision is invalid",
      );
    return {
      id: raw.id,
      name: raw.name,
      currentRevision: raw.currentRevision,
      revisions,
      enabled: raw.enabled,
      scriptsEnabled: raw.scriptsEnabled,
      ...(raw.builtinDefault === true ? { builtinDefault: true as const } : {}),
      ...(raw.draftRevision === undefined
        ? {}
        : { draftRevision: raw.draftRevision }),
    };
  });
  const current = presets.find(({ id }) => id === value.currentPresetId);
  if (current === undefined)
    throw new FileNativePlayPresetError(
      "store_invalid",
      "Current play preset does not exist",
    );
  if (!current.enabled)
    throw new FileNativePlayPresetError(
      "store_invalid",
      "Current play preset cannot be a disabled identity",
    );
  return { schemaVersion: 1, currentPresetId: value.currentPresetId, presets };
}

function findStored(document: StoredDocument, id: string): StoredPreset {
  const preset = document.presets.find(({ id: candidate }) => candidate === id);
  if (preset === undefined)
    throw new FileNativePlayPresetError(
      "not_found",
      "Requested play preset was not found",
    );
  return preset;
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!namePattern.test(name) || name.includes(String.fromCharCode(0)))
    throw new FileNativePlayPresetError(
      "invalid_name",
      "Play-preset name must contain 1 to 160 characters",
    );
  return name;
}

function locatePlayPresetError(message: string): string {
  const match =
    /(?:blocks|prompts|regex|renderers|scripts|assets)\/[^：\s]+|call-chain\.yaml|preset\.yaml|frame\.yaml/u.exec(
      message,
    );
  return match?.[0] ?? "call-chain.yaml";
}

function finiteInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cloneFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [path, contents]),
  );
}

export function validatePlayPresetArtifactPayload(
  contract: PlayPresetArtifactPayloadContract | undefined,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  if (contract === undefined) return { ok: true };
  if (!isJsonValueValue(value))
    return {
      ok: false,
      message: "JSON artifact payload must be a valid JSON value",
    };
  return validatePayloadNode(contract, value, "$", 0);
}

function validatePayloadNode(
  contract: PlayPresetArtifactPayloadContract,
  value: unknown,
  path: string,
  depth: number,
): { ok: true } | { ok: false; message: string } {
  if (depth > 32)
    return { ok: false, message: `${path} payload nesting exceeds 32 levels` };
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeMatches =
    contract.type === actual ||
    (contract.type === "number" && actual === "number") ||
    (contract.type === "integer" &&
      actual === "number" &&
      Number.isInteger(value));
  if (!typeMatches)
    return {
      ok: false,
      message: `${path} payload type must be ${contract.type}; received ${actual}`,
    };
  if (contract.maxBytes !== undefined) {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, "utf8") > contract.maxBytes
    )
      return {
        ok: false,
        message: `${path} payload exceeds its declared ${contract.maxBytes}-byte limit`,
      };
  }
  if (contract.type === "string") {
    const text = value as string;
    if (
      contract.minLength !== undefined &&
      [...text].length < contract.minLength
    )
      return {
        ok: false,
        message: `${path} text length is less than ${contract.minLength}`,
      };
    if (
      contract.maxLength !== undefined &&
      [...text].length > contract.maxLength
    )
      return {
        ok: false,
        message: `${path} text length exceeds ${contract.maxLength}`,
      };
  }
  if (contract.type === "array") {
    const entries = value as unknown[];
    if (contract.minItems !== undefined && entries.length < contract.minItems)
      return {
        ok: false,
        message: `${path} has fewer than ${contract.minItems} items`,
      };
    if (contract.maxItems !== undefined && entries.length > contract.maxItems)
      return {
        ok: false,
        message: `${path} has more than ${contract.maxItems} items`,
      };
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (contract.items !== undefined) {
        const result = validatePayloadNode(
          contract.items,
          entry,
          `${path}[${index}]`,
          depth + 1,
        );
        if (!result.ok) return result;
      }
      if (contract.uniqueBy !== undefined && isRecordValue(entry)) {
        const unique = entry[contract.uniqueBy];
        if (
          typeof unique !== "string" &&
          typeof unique !== "number" &&
          typeof unique !== "boolean"
        )
          return {
            ok: false,
            message: `${path}[${index}].${contract.uniqueBy} must be a uniquely comparable scalar`,
          };
        const key = JSON.stringify(unique);
        if (seen.has(key))
          return {
            ok: false,
            message: `${path} ${contract.uniqueBy} values cannot be duplicated`,
          };
        seen.add(key);
      }
    }
  }
  if (contract.type === "object") {
    const object = value as Record<string, unknown>;
    const properties = contract.properties ?? {};
    for (const required of contract.required ?? [])
      if (!(required in object))
        return { ok: false, message: `${path}.${required} is required` };
    if (contract.additionalProperties === false)
      for (const key of Object.keys(object))
        if (!(key in properties))
          return {
            ok: false,
            message: `${path}.${key} is not a declared field`,
          };
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in object)) continue;
      const result = validatePayloadNode(
        child,
        object[key],
        `${path}.${key}`,
        depth + 1,
      );
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function isJsonValueValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValueValue);
  if (!isRecordValue(value)) return false;
  return Object.values(value).every(isJsonValueValue);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string, location: string): never {
  void location;
  throw new FileNativePlayPresetError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
