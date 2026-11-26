import {
  idleWorkspaceNavigation,
  type WorkspaceNavigationProtection,
} from "./WorkspaceLocation.ts";
import type { ModelConnectionView } from "../protocol/modelConnections.ts";
import { orchestrationManifest } from "../shared/application-preset-files.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import {
  editPresetResources,
  presetResourceUsage,
  type PresetResourceEdit,
} from "./preset-resource-editor.ts";
import { resourceTitle } from "./preset-resource-names.ts";
import "./preset-workbench.css";
import { PresetWorkbenchEditor } from "./PresetWorkbenchEditor.tsx";
import { OrchestrationPreviewPanel } from "./OrchestrationPreviewPanel.tsx";
import { PresetDraftPreview } from "./PresetDraftPreview.tsx";
import { SillyTavernImport } from "./SillyTavernImport.tsx";
import { DismissibleNotice } from "./DismissibleNotice.tsx";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";
import { type FollowupItem } from "../shared/ordered-followups.ts";
import { type PlayPresetPlayerViewPanel } from "./PlayerViewPanelsEditor.tsx";
import { InterfaceExtensionPreview } from "./InterfaceExtensionPreview.tsx";
import { PathChecklist } from "./PlayPresetEditorControls.tsx";
import {
  artifactOptionLabel,
  mountLabel,
  withCurrentPath,
  describePresetFile,
} from "./playPresetEditorLabels.ts";
import type { OrderedPlayPrompt } from "../shared/ordered-play-prompts.ts";
import { saveFile, useAndroidBack } from "./androidBridge.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { V1Request } from "../protocol/v1.ts";

interface PlayPresetMount {
  channel: string;
  mount:
    | "story"
    | "sidebar"
    | "composer_above"
    | "composer_below"
    | "overlay"
    | "debug";
}

interface PlayPresetWorkbenchRenderer {
  mode: "document" | "app";
  revision?: string;
  document?: string;
  scripts: string[];
  assets: { id: string; source: string }[];
  trustedLocalCode: boolean;
}

interface PlayPresetWorkbenchArtifact {
  requestId: string;
  output: string;
  declaration: {
    name: string;
    channel: string;
    strategy: "append" | "replace" | "upsert" | "transient" | "hidden";
    key?: string;
    contentType:
      "text/plain" | "text/markdown" | "application/json" | "text/html";
    renderer?: string;
    rendererRevision?: string;
    rendererMode?: "document" | "app";
    regex?: string;
    scripts?: string[];
    assets?: string[];
    save: "none" | "operation" | "commit";
    invalidation:
      | "new_operation"
      | "head_change"
      | "operation_end"
      | "explicit_clear"
      | "never";
    required: boolean;
    maxEmits: number;
    payloadContract?: Record<string, unknown>;
  };
  rawPayload: unknown;
  rawText: string;
  regex: {
    order: number;
    scope: "raw_text" | "markdown_html" | "structured_payload";
    pattern: string;
    flags: string;
    replace: string;
    maxMatches: number;
    errorPolicy: "fallback" | "skip" | "fail";
  }[];
  renderer?: PlayPresetWorkbenchRenderer;
  activeProjection: {
    status: "active";
    channel: string;
    key?: string;
    strategy: PlayPresetWorkbenchArtifact["declaration"]["strategy"];
    save: PlayPresetWorkbenchArtifact["declaration"]["save"];
  };
  clear: {
    supported: true;
    invalidation: PlayPresetWorkbenchArtifact["declaration"]["invalidation"];
    description: string;
  };
  simulation: {
    emitted: { status: "active"; identity: string };
    explicitClear: { status: "cleared"; identity: string };
    invalidation: {
      policy: PlayPresetWorkbenchArtifact["declaration"]["invalidation"];
      status: "active" | "cleared" | "superseded";
      reason: string;
    };
  };
  diagnostics: string[];
}

export interface PlayPresetWorkbenchSnapshot {
  id: string;
  name: string;
  revision: string;
  structure: PlayPresetStructuredEditor;
  artifactPreviews: PlayPresetWorkbenchArtifact[];
  staticErrors: { code: string; message: string; location: string }[];
  trustedLocalCode: boolean;
  scriptsEnabled?: boolean;
}

interface PlayPresetPromptRef {
  role: string;
  path: string;
}

type PlayPresetArtifactStrategy =
  "append" | "replace" | "upsert" | "transient" | "hidden";

type PlayPresetArtifactInvalidation =
  | "new_operation"
  | "head_change"
  | "operation_end"
  | "explicit_clear"
  | "never";

export interface PlayPresetArtifactDefinition {
  displayName?: string;
  purpose?: string;
  name: string;
  channel: string;
  strategy: PlayPresetArtifactStrategy;
  key?: string;
  contentType:
    "text/plain" | "text/markdown" | "application/json" | "text/html";
  renderer?: string;
  rendererRevision?: string;
  rendererMode?: "document" | "app";
  regex?: string;
  scripts?: string[];
  assets?: string[];
  save: "none" | "operation" | "commit";
  invalidation: PlayPresetArtifactInvalidation;
  required: boolean;
  maxEmits: number;
  payloadContract?: Record<string, unknown>;
}

export interface PlayPresetFollowupDefinition {
  id: string;
  displayName: string;
  prompt: PlayPresetPromptRef;
  artifacts: PlayPresetArtifactDefinition[];
  maxArtifactBytes: number;
}

export interface PlayPresetStructuredEditor {
  followupItems?: FollowupItem[];
  playPrompts?: OrderedPlayPrompt[];
  authorPrompts?: OrderedPlayPrompt[];
  mergeConsecutiveMessages?: boolean;
  migrationNotice?: string;
  name: string;
  callChainPath: string;
  settingImprovementPrompt?: PlayPresetPromptRef;
  mounts: PlayPresetMount[];
  playerViewPanels: PlayPresetPlayerViewPanel[];
  extensionRefs: string[];
  narrativePrompts: PlayPresetPromptRef[];
  followups: PlayPresetFollowupDefinition[];
}

export interface PlayPresetScreenPreset {
  id: string;
  name: string;
  revision: string;
  files: Record<string, string>;
  validation:
    | { status: "valid" }
    | { status: "invalid"; code?: string; message: string; location?: string };
  enabled?: boolean;
  scriptsEnabled?: boolean;
  structure?: PlayPresetStructuredEditor;
  draft?: {
    revision: string;
    files: Record<string, string>;
    validation:
      | { status: "valid" }
      | {
          status: "invalid";
          code?: string;
          message: string;
          location?: string;
        };
    structure?: PlayPresetStructuredEditor;
  };
}

export interface PlayPresetScreenLibrary {
  currentPresetId: string;
  presets: PlayPresetScreenPreset[];
}

export interface PlayPresetReceipt {
  currentPresetId: string;
  preset: PlayPresetScreenPreset;
}

export interface RecommendedPlayPresetTemplate {
  id: string;
  label: string;
  name: string;
  files: Record<string, string>;
}

interface PlayPresetClient {
  request<T = unknown>(request: V1Request): Promise<T>;
}

interface Feedback {
  kind: "status" | "error";
  text: string;
}

type PlayPresetWorkspaceView = "call_chain" | "setting_improvement" | "files";

const playPresetWorkspaceViews: {
  id: PlayPresetWorkspaceView;
  label: string;
  description: string;
}[] = [
  {
    id: "call_chain",
    label: "游玩",
    description: "叙事规则、后置请求与工具契约",
  },
  {
    id: "setting_improvement",
    label: "设定完善",
    description: "AI 创作方法；工具契约保持内置",
  },
];

function toEditablePreset(
  preset: PlayPresetScreenPreset,
): PlayPresetScreenPreset {
  const copy = structuredClone(preset);
  if (copy.draft === undefined) return copy;
  const editable: PlayPresetScreenPreset = {
    ...copy,
    revision: copy.draft.revision,
    files: structuredClone(copy.draft.files),
    validation: structuredClone(copy.draft.validation),
  };
  if (copy.draft.structure === undefined) delete editable.structure;
  else editable.structure = structuredClone(copy.draft.structure);
  return editable;
}

function preferredPresetFilePath(files: Record<string, string>): string {
  if (Object.hasOwn(files, orchestrationManifest)) return orchestrationManifest;
  if (Object.prototype.hasOwnProperty.call(files, "preset.yaml"))
    return "preset.yaml";
  if (Object.prototype.hasOwnProperty.call(files, "call-chain.yaml"))
    return "call-chain.yaml";
  return Object.keys(files).sort()[0] ?? "";
}

// The library and operations menus are <details>; Escape, an outside press and
// Android Back close them.
const openPresetMenus =
  ".play-preset-operations[open], .play-preset-library > details[open]";

export function PlayPresetScreen({
  client,
  initialLibrary,
  recommendedTemplates = [],
  onLibraryChange,
  onNavigationProtectionChange,
  initialSelectedId,
  onSelectionChange,
  modelConnection,
  onEditModelConnection,
}: {
  client: PlayPresetClient;
  initialLibrary: PlayPresetScreenLibrary;
  recommendedTemplates?: RecommendedPlayPresetTemplate[];
  onLibraryChange: (library: PlayPresetScreenLibrary) => void;
  onNavigationProtectionChange: (
    protection: WorkspaceNavigationProtection,
  ) => void;
  initialSelectedId?: string;
  onSelectionChange?: (presetId: string) => void;
  modelConnection?: ModelConnectionView | undefined;
  onEditModelConnection?: () => void;
}): React.JSX.Element {
  const [library, setLibrary] = useState(initialLibrary);
  const libraryMenu = useRef<HTMLDetailsElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  useAndroidBack(true, () => {
    const menus =
      screenRef.current?.querySelectorAll<HTMLDetailsElement>(
        openPresetMenus,
      ) ?? [];
    for (const menu of menus) menu.open = false;
    return menus.length > 0;
  });
  const initial =
    initialLibrary.presets.find(({ id }) => id === initialSelectedId) ??
    initialLibrary.presets.find(
      ({ id }) => id === initialLibrary.currentPresetId,
    ) ??
    initialLibrary.presets[0];
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const [draft, setDraft] = useState<
    (PlayPresetScreenPreset & { resourceError?: string | undefined }) | null
  >(() => (initial === undefined ? null : toEditablePreset(initial)));
  const [filePath, setFilePath] = useState(
    initial?.files === undefined
      ? ""
      : preferredPresetFilePath(initial.draft?.files ?? initial.files),
  );
  const [draftBase, setDraftBase] = useState(draft);
  const [newName, setNewName] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [workspaceView, setWorkspaceView] =
    useState<PlayPresetWorkspaceView>("call_chain");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletion, setDeletion] = useState<ConfirmationRequest<
    Pick<PlayPresetScreenPreset, "id" | "name">
  > | null>(null);

  const saved = useMemo(
    () => library.presets.find(({ id }) => id === draft?.id),
    [draft?.id, library.presets],
  );
  const savedEditable = draftBase;
  const contentDirty =
    draft !== null &&
    savedEditable !== null &&
    (JSON.stringify(draft.files) !== JSON.stringify(savedEditable.files) ||
      JSON.stringify(draft.structure) !==
        JSON.stringify(savedEditable.structure));
  const nameDirty =
    draft !== null && draftBase !== null && draft.name !== draftBase.name;
  const dirty = draft !== null && (nameDirty || contentDirty);
  const structuralPaths = useMemo(() => {
    const callChainPath =
      draft?.structure?.callChainPath ??
      savedEditable?.structure?.callChainPath ??
      "call-chain.yaml";
    return new Set([orchestrationManifest, "preset.yaml", callChainPath]);
  }, [
    draft?.structure?.callChainPath,
    savedEditable?.structure?.callChainPath,
  ]);
  const resourceUsage = useMemo(
    () =>
      draft?.structure
        ? presetResourceUsage({
            files: draft.files,
            structure: draft.structure,
          })
        : undefined,
    [draft?.files, draft?.structure],
  );
  const rawStructuralDirty =
    draft !== null &&
    savedEditable !== null &&
    [...structuralPaths].some(
      (path) => draft.files[path] !== savedEditable.files[path],
    );
  const structuredDirty =
    draft !== null &&
    savedEditable !== null &&
    JSON.stringify(draft.structure) !== JSON.stringify(savedEditable.structure);
  const structuralConflict = rawStructuralDirty && structuredDirty;
  const currentPreset = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  );
  const selectedIsCurrent = draft?.id === library.currentPresetId;
  const nextSend = !selectedIsCurrent
    ? uiText("应用为当前编排方案后，下一次正常发送才会使用它。")
    : saved?.draft === undefined
      ? uiText("下一次正常发送将使用此编排方案的已应用修订。")
      : saved.draft.validation.status === "valid"
        ? uiText(
            "下一次正常发送仍使用已应用的修订。请应用已保存的草稿以使其生效。",
          )
        : uiText("下一次正常发送仍使用已应用的修订。请修复草稿后再应用。");
  const applyRead = useRef<
    ((next: PlayPresetScreenLibrary) => void) | undefined
  >(undefined);
  const previousLibrary = useRef(initialLibrary);
  useEffect(() => {
    applyRead.current = (next) => applyLibrary(next, undefined, true);
  });
  const { target, syncFailed } = useReadTarget(
    useCallback(
      () => client.request<PlayPresetScreenLibrary>({ type: "play.read" }),
      [client],
    ),
    useCallback(
      (next: PlayPresetScreenLibrary) => applyRead.current?.(next),
      [],
    ),
  );
  useEffect(() => {
    if (initialLibrary !== previousLibrary.current) {
      previousLibrary.current = initialLibrary;
      target.accept();
      applyRead.current?.(initialLibrary);
    }
  }, [initialLibrary, target]);

  useLayoutEffect(() => {
    onNavigationProtectionChange({ dirty, busy: dirty && pending });
  }, [dirty, pending, onNavigationProtectionChange]);

  useLayoutEffect(
    () => () => onNavigationProtectionChange(idleWorkspaceNavigation),
    [onNavigationProtectionChange],
  );

  function acceptPreset({ currentPresetId, preset }: PlayPresetReceipt): void {
    target.accept({ complete: false });
    const exists = library.presets.some(({ id }) => id === preset.id);
    applyLibrary(
      {
        currentPresetId,
        presets: exists
          ? library.presets.map((item) =>
              item.id === preset.id ? preset : item,
            )
          : [...library.presets, preset],
      },
      preset.id,
    );
  }

  function applyLibrary(
    next: PlayPresetScreenLibrary,
    preferredId?: string,
    preserveDraft = false,
  ): void {
    const selected =
      next.presets.find(({ id }) => id === preferredId) ??
      next.presets.find(({ id }) => id === selectedId) ??
      next.presets.find(({ id }) => id === next.currentPresetId) ??
      next.presets[0];
    if (!preserveDraft && libraryMenu.current) libraryMenu.current.open = false;
    setLibrary(next);
    onLibraryChange(next);
    if (preserveDraft && dirty) {
      const updated = next.presets.find(({ id }) => id === draft?.id);
      if (updated !== undefined)
        setDraft((current) =>
          current === null
            ? null
            : {
                ...current,
                revision: updated.draft?.revision ?? updated.revision,
                enabled: updated.enabled !== false,
                scriptsEnabled: updated.scriptsEnabled === true,
              },
        );
      return;
    }
    setSelectedId(selected?.id ?? "");
    if ((selected?.id ?? "") !== selectedId)
      onSelectionChange?.(selected?.id ?? "");
    const editable = selected === undefined ? null : toEditablePreset(selected);
    setDraft(editable);
    setDraftBase(editable);
    setFilePath((path) =>
      editable === null
        ? ""
        : preserveDraft && path in editable.files
          ? path
          : preferredPresetFilePath(editable.files),
    );
  }

  function request<T>(input: V1Request): Promise<T> {
    return target.command(() => client.request<T>(input));
  }

  async function run(work: () => Promise<void>): Promise<void> {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await work();
    } catch (error: unknown) {
      setFeedback({
        kind: "error",
        text:
          error instanceof Error ? error.message : uiText("编排方案操作失败"),
      });
    } finally {
      setPending(false);
    }
  }

  function selectDraft(id: string): void {
    if (id === selectedId) return;
    if (dirty && id !== selectedId) {
      setFeedback({
        kind: "error",
        text: uiText(
          "当前编排方案有未保存修改；请先保存或撤销，再切换编排方案。",
        ),
      });
      return;
    }
    const next = library.presets.find(({ id: candidate }) => candidate === id);
    if (next === undefined) return;
    setSelectedId(id);
    onSelectionChange?.(id);
    const editable = toEditablePreset(next);
    setDraft(editable);
    setDraftBase(editable);
    setFilePath(preferredPresetFilePath(editable.files));
    setFeedback(null);
    setWorkspaceView("call_chain");
  }

  function resetDraft(): void {
    if (saved === undefined) return;
    const editable = toEditablePreset(saved);
    setDraft(editable);
    setDraftBase(editable);
    setFilePath(preferredPresetFilePath(editable.files));
    setFeedback({ kind: "status", text: uiText("已撤销当前未保存修改。") });
  }

  function updateFile(contents: string): void {
    if (draft === null || filePath === "") return;
    updateFileAtPath(filePath, contents);
  }

  function updateFileAtPath(path: string, contents: string): void {
    setDraft((current) =>
      current === null
        ? null
        : { ...current, files: { ...current.files, [path]: contents } },
    );
  }

  function updateFiles(
    update: (files: Record<string, string>) => Record<string, string>,
  ): void {
    setDraft((current) =>
      current === null
        ? null
        : { ...current, files: update(structuredClone(current.files)) },
    );
  }

  function updateStructure(
    update: (
      structure: PlayPresetStructuredEditor,
    ) => PlayPresetStructuredEditor,
  ): void {
    setDraft((current) =>
      current?.structure === undefined
        ? current
        : {
            ...current,
            structure: update(structuredClone(current.structure)),
          },
    );
  }

  function updateResources(action: PresetResourceEdit): void {
    setDraft((current) => {
      if (!current?.structure) return current;
      try {
        return {
          ...current,
          ...editPresetResources(
            { files: current.files, structure: current.structure },
            action,
          ),
          resourceError: undefined,
        };
      } catch (error) {
        return {
          ...current,
          resourceError:
            error instanceof Error ? error.message : uiText("编排方案操作失败"),
        };
      }
    });
  }

  async function saveDraft(): Promise<void> {
    if (draft === null) return;
    if (structuralConflict) {
      setFeedback({
        kind: "error",
        text: uiText(
          "编排方案原文与表单均有修改，请先保留一种编辑结果再保存，以免覆盖当前修改。",
        ),
      });
      return;
    }
    await run(async () => {
      const receipt = await request<PlayPresetReceipt>({
        type: "play.save",
        presetId: draft.id,
        name: draft.name,
        files: draft.files,
        ...(draft.structure === undefined ||
        rawStructuralDirty ||
        (!structuredDirty && draft.structure.migrationNotice === undefined)
          ? {}
          : {
              structure: draft.structure as unknown as Record<string, unknown>,
            }),
      });
      acceptPreset(receipt);
      setFeedback({
        kind: "status",
        text: uiText("编排方案已保存。"),
      });
    });
  }

  async function exportPreset(): Promise<void> {
    if (saved === undefined) return;
    await run(async () => {
      const result = await request<{
        files: { path: string; contents: string }[];
      }>({ type: "play.export", presetId: saved.id });
      const blob = new Blob([JSON.stringify(result.files, null, 2)], {
        type: "application/json",
      });
      const outcome = await target.command(() =>
        saveFile(`${saved.name}.orchestration.json`, {
          blob,
        }),
      );
      if (outcome !== "cancelled")
        setFeedback({ kind: "status", text: uiText("编排方案已导出。") });
    });
  }

  async function importPreset(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    await run(async () => {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (entry) =>
            typeof entry !== "object" ||
            entry === null ||
            typeof (entry as { path?: unknown }).path !== "string" ||
            typeof (entry as { contents?: unknown }).contents !== "string",
        )
      )
        throw new Error(
          uiText("无法识别此编排方案。请选择通过“导出编排方案”生成的文件。"),
        );
      const result = await request<PlayPresetReceipt>({
        type: "play.import",
        name:
          file.name.replace(/\.(?:orchestration|play-preset)\.json$/iu, "") ||
          uiText("导入的编排方案"),
        files: parsed as { path: string; contents: string }[],
      });
      acceptPreset(result);
      setFeedback({
        kind: "status",
        text: uiText(
          "编排方案已导入为独立副本，JavaScript 默认关闭；信任其内容后可在编排方案操作中启用。",
        ),
      });
    });
  }

  function requestDeletion(
    { id, name }: PlayPresetScreenPreset,
    opener: HTMLButtonElement,
  ): void {
    setDeletion({
      action: { id, name },
      opener,
      fallback: opener.closest("details")?.querySelector("summary") ?? null,
      message: uiText(
        "删除编排方案“{name}”？它的修订和草稿都会从编排方案库移除，且无法撤销。",
        { name },
      ),
      confirmLabel: uiText("删除"),
    });
  }

  function decideDeletion(confirmed: boolean): void {
    setDeletion(null);
    if (!confirmed || dirty || deletion === null) return;
    const { id, name } = deletion.action;
    if (saved?.id !== id || saved.name !== name) return;

    void run(async () => {
      const receipt = await request<{ currentPresetId: string }>({
        type: "play.delete",
        presetId: id,
      });
      const remaining = library.presets.filter((preset) => preset.id !== id);
      const currentStillPresent = remaining.some(
        (preset) =>
          preset.enabled !== false && preset.id === receipt.currentPresetId,
      );
      target.accept({ complete: false });
      applyLibrary({
        currentPresetId: receipt.currentPresetId,
        presets: currentStillPresent ? remaining : [],
      });
      // Runtime rebuilds the default library after deletion of the last enabled preset.
      if (!currentStillPresent) await target.read();
      setFeedback({
        kind: "status",
        text: uiText("编排方案已删除；删空后会自动重建默认编排方案。"),
      });
    });
  }

  return (
    <section
      ref={screenRef}
      className="play-preset-screen"
      aria-labelledby="play-preset-title"
      onPointerDownCapture={(event) => {
        if (deletion !== null) return;
        for (const menu of event.currentTarget.querySelectorAll<HTMLDetailsElement>(
          openPresetMenus,
        ))
          if (event.target instanceof Node && !menu.contains(event.target))
            menu.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && deletion === null)
          for (const menu of event.currentTarget.querySelectorAll<HTMLDetailsElement>(
            openPresetMenus,
          ))
            menu.open = false;
      }}
    >
      <header className="play-preset-header">
        <div>
          <p className="eyebrow">{uiText("提示词编排")}</p>
          <h2 id="play-preset-title">{uiText("编排方案工作台")}</h2>
          <p className="play-preset-lede">
            {uiText("在同一处编辑设定完善方法、主持规则、后置请求与界面展示。")}
          </p>
        </div>
        <div className="play-preset-header-fact">
          <span>{uiText("当前使用的编排方案")}</span>
          <strong>{currentPreset?.name ?? uiText("未选择")}</strong>
          <small>
            {uiText(
              "正常游玩发送使用当前方案的已应用修订，原样重试保留旧请求。",
            )}
          </small>
        </div>
      </header>

      {draft?.resourceError && (
        <DismissibleNotice
          role="alert"
          className="play-preset-feedback error"
          text={draft.resourceError}
          onDismiss={() =>
            setDraft((current) =>
              current ? { ...current, resourceError: undefined } : current,
            )
          }
        />
      )}
      {feedback === null ? null : (
        <DismissibleNotice
          className={`play-preset-feedback ${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      <SyncNotice failed={syncFailed} onRead={() => void target.recover()} />
      <fieldset disabled={pending} className="play-preset-workspace">
        <legend className="visually-hidden">{uiText("编排方案工作区")}</legend>
        <div className="play-preset-layout">
          <div className="play-preset-toolbar">
            <aside
              className="panel-card play-preset-library"
              aria-label={uiText("编排方案列表")}
            >
              <label>
                <span className="visually-hidden">{uiText("编排方案")}</span>
                <select
                  aria-label={uiText("切换编排方案")}
                  value={selectedId ?? ""}
                  disabled={pending || dirty}
                  onChange={(event) => selectDraft(event.target.value)}
                >
                  {library.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <details ref={libraryMenu}>
                <summary>{uiText("编排方案管理")}</summary>

                <section
                  className="play-preset-library-actions"
                  aria-label={uiText("新建与导入编排方案")}
                >
                  <h4>{uiText("新建或导入")}</h4>
                  <input
                    aria-label={uiText("新编排方案名称")}
                    placeholder={uiText("新编排方案名称")}
                    value={newName}
                    onChange={(event) => setNewName(event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    disabled={pending || dirty || newName.trim() === ""}
                    onClick={() =>
                      void run(async () => {
                        const result = await request<PlayPresetReceipt>({
                          type: "play.create",
                          name: newName.trim(),
                        });
                        setNewName("");
                        acceptPreset(result);
                        setFeedback({
                          kind: "status",
                          text: uiText("已新建普通编排方案。"),
                        });
                      })
                    }
                  >
                    {uiText("新建空白编排方案")}
                  </button>
                  {recommendedTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="secondary-button"
                      disabled={pending || dirty}
                      onClick={() =>
                        void run(async () => {
                          const result = await request<PlayPresetReceipt>({
                            type: "play.create",
                            name: template.name,
                            files: structuredClone(template.files),
                          });
                          acceptPreset(result);
                          setFeedback({
                            kind: "status",
                            text: uiText("已复制推荐{name}，可独立编辑。", {
                              name: template.label,
                            }),
                          });
                        })
                      }
                    >
                      {uiText("复制推荐")}
                      {template.label}
                    </button>
                  ))}
                  <SillyTavernImport
                    client={client}
                    disabled={pending || dirty}
                    onFailure={() => target.recover()}
                    librarySync={{
                      failed: syncFailed,
                      onRead: () => void target.recover(),
                    }}
                    onImported={(receipt) => {
                      acceptPreset(receipt);
                      setFeedback({
                        kind: "status",
                        text: uiText(
                          "已从 SillyTavern 预设导入独立编排方案，JavaScript 默认关闭。",
                        ),
                      });
                    }}
                  />
                  <label className="play-preset-import-control">
                    {uiText("导入编排方案")}
                    <input
                      aria-label={uiText("选择要导入的编排方案")}
                      type="file"
                      accept=".json,application/json"
                      disabled={pending || dirty}
                      onChange={(event) => {
                        void importPreset(event.currentTarget.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </section>
              </details>
            </aside>
            {draft !== null && (
              <>
                <nav
                  className="play-preset-workspace-nav"
                  role="tablist"
                  aria-label={uiText("编排方案编辑区域")}
                >
                  {playPresetWorkspaceViews
                    .filter(
                      (view) =>
                        view.id === "call_chain" ||
                        view.id === "setting_improvement",
                    )
                    .map((view) => (
                      <button
                        key={view.id}
                        id={`play-preset-tab-${view.id}`}
                        type="button"
                        role="tab"
                        aria-controls={`play-preset-panel-${view.id}`}
                        aria-selected={workspaceView === view.id}
                        className={workspaceView === view.id ? "selected" : ""}
                        onClick={() => setWorkspaceView(view.id)}
                      >
                        <strong>{uiText(view.label)}</strong>
                        <span>{uiText(view.description)}</span>
                      </button>
                    ))}
                </nav>
                <details className="play-preset-operations">
                  <summary>{uiText("编排方案操作")}</summary>
                  <div className="play-preset-operations-content">
                    <label className="play-preset-name-field">
                      {uiText("编排方案名称")}
                      <input
                        aria-label={uiText("编排方案名称")}
                        maxLength={160}
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            name: event.currentTarget.value,
                          })
                        }
                      />
                    </label>

                    <div
                      className="play-preset-management"
                      aria-label={uiText("编排方案操作")}
                    >
                      <p>
                        {uiText(
                          "这些操作只管理这份本地编排方案；内容编辑和保存仍在页面底部完成。",
                        )}
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            const receipt = await request<PlayPresetReceipt>({
                              type: "play.enable",
                              presetId: draft.id,
                              enabled: draft.enabled === false,
                            });
                            acceptPreset(receipt);
                            setFeedback({
                              kind: "status",
                              text: uiText("编排方案状态已更新。"),
                            });
                          })
                        }
                      >
                        {draft.enabled === false
                          ? uiText("启用编排方案")
                          : uiText("停用编排方案")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            const receipt = await request<PlayPresetReceipt>({
                              type: "play.scripts",
                              presetId: draft.id,
                              enabled: draft.scriptsEnabled !== true,
                            });
                            acceptPreset(receipt);
                            setFeedback({
                              kind: "status",
                              text:
                                draft.scriptsEnabled === true
                                  ? uiText(
                                      "JavaScript 已关闭；文本、HTML 和样式仍可预览。",
                                    )
                                  : uiText(
                                      "JavaScript 已显式启用（本地可信代码）。",
                                    ),
                            });
                          })
                        }
                      >
                        {draft.scriptsEnabled === true
                          ? uiText("停用 JavaScript")
                          : uiText("启用 JavaScript（本地可信代码）")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            const copied = await request<PlayPresetReceipt>({
                              type: "play.copy",
                              presetId: draft.id,
                            });
                            acceptPreset(copied);
                            setFeedback({
                              kind: "status",
                              text: uiText("已复制为独立编排方案。"),
                            });
                          })
                        }
                      >
                        {uiText("复制为新编排方案")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() => void exportPreset()}
                      >
                        {uiText("导出编排方案")}
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={pending || dirty}
                        onClick={(event) =>
                          requestDeletion(draft, event.currentTarget)
                        }
                      >
                        {uiText("删除编排方案")}
                      </button>
                    </div>
                    <p className="field-note">
                      {uiText(
                        "导入的 JavaScript 默认停用；启用表示你信任这些本地文件，而不是获得安全沙箱保证。",
                      )}
                    </p>
                    <details>
                      <summary>{uiText("保留的资源")}</summary>
                      <p>
                        {uiText(
                          "未绑定资源仍随编排方案保存；可在模板编辑器重新引用。",
                        )}
                      </p>
                      {Object.keys(draft.files)
                        .filter(
                          (path) =>
                            !structuralPaths.has(path) &&
                            !resourceUsage?.get(path)?.declared,
                        )
                        .map((path) => (
                          <details key={path}>
                            <summary>
                              {/^(assets|scripts|renderers|regex)\//u.test(path)
                                ? resourceTitle(path)
                                : (describePresetFile(
                                    path,
                                    draft.files[path] ?? "",
                                  ).title ?? path.split("/").at(-1))}
                            </summary>
                            {/^(assets|scripts|renderers|regex)\//u.test(
                              path,
                            ) && (
                              <button
                                type="button"
                                disabled={
                                  !draft.structure ||
                                  resourceUsage?.get(path)?.declared === true ||
                                  (resourceUsage?.get(path)?.sources.length ??
                                    0) > 0
                                }
                                onClick={() =>
                                  updateResources({
                                    type: "delete-resource",
                                    path,
                                  })
                                }
                              >
                                {getWebLocale() === "zh-CN"
                                  ? "删除未引用资源"
                                  : "Delete unused resource"}
                              </button>
                            )}
                            <textarea
                              aria-label={path.split("/").at(-1)}
                              value={draft.files[path]}
                              onChange={(event) =>
                                updateFileAtPath(path, event.target.value)
                              }
                            />
                          </details>
                        ))}
                    </details>
                  </div>
                </details>
              </>
            )}
          </div>

          {draft === null ? (
            <section className="panel-card" role="status">
              {uiText("还没有编排方案。")}
            </section>
          ) : (
            <section
              className="panel-card play-preset-editor"
              aria-label={uiText("编排方案编辑器")}
            >
              <header className="play-preset-editor-header">
                <h3>{draft.name}</h3>
                <div className="play-preset-editor-badges">
                  <span
                    className={`play-preset-draft-state${dirty ? " dirty" : ""}`}
                  >
                    {dirty ? uiText("未保存修改") : uiText("已保存")}
                  </span>
                  {selectedIsCurrent ? (
                    <span className="play-preset-badge current">
                      {uiText("当前编排方案")}
                    </span>
                  ) : null}
                  {draft.enabled === false ? (
                    <span className="play-preset-badge disabled">
                      {uiText("已停用")}
                    </span>
                  ) : null}
                  <span className="play-preset-badge">
                    {draft.scriptsEnabled === true
                      ? uiText("JavaScript 已启用")
                      : uiText("JavaScript 已停用")}
                  </span>
                </div>
              </header>

              {saved?.structure?.migrationNotice && (
                <p className="workspace-feedback" role="status">
                  {saved.structure.migrationNotice}
                </p>
              )}
              {draft.structure &&
              (workspaceView === "call_chain" ||
                workspaceView === "setting_improvement") ? (
                <div
                  id={`play-preset-panel-${workspaceView}`}
                  role="tabpanel"
                  aria-labelledby={`play-preset-tab-${workspaceView}`}
                >
                  <PresetWorkbenchEditor
                    key={`${draft.id}:${workspaceView}`}
                    structure={draft.structure}
                    files={draft.files}
                    authoring={workspaceView === "setting_improvement"}
                    modelConnection={modelConnection}
                    onEditModelConnection={onEditModelConnection}
                    onChange={updateStructure}
                    onWrite={updateFileAtPath}
                    onResourceEdit={updateResources}
                    promptPreview={
                      saved && (
                        <OrchestrationPreviewPanel
                          key={draft.id}
                          client={client}
                          presetId={draft.id}
                          currentRevision={saved.revision}
                          draftRevision={saved.draft?.revision}
                          candidateBaseRevision={draft.revision}
                          candidate={
                            contentDirty && !structuralConflict
                              ? {
                                  files: draft.files,
                                  ...(!rawStructuralDirty &&
                                  structuredDirty &&
                                  draft.structure !== undefined
                                    ? {
                                        structure:
                                          draft.structure as unknown as Record<
                                            string,
                                            unknown
                                          >,
                                      }
                                    : {}),
                                }
                              : undefined
                          }
                          candidateConflict={structuralConflict}
                          surface={
                            workspaceView === "setting_improvement"
                              ? "author"
                              : "play"
                          }
                          connection={modelConnection}
                        />
                      )
                    }
                    preview={(requestId, output) =>
                      requestId && output ? (
                        <PresetDraftPreview
                          key={`${requestId}:${output}`}
                          client={client}
                          presetId={draft.id}
                          revision={draft.revision}
                          files={draft.files}
                          structure={
                            draft.structure as unknown as Record<
                              string,
                              unknown
                            >
                          }
                          scriptsEnabled={draft.scriptsEnabled === true}
                          requestId={requestId}
                          output={output}
                        />
                      ) : (
                        <InterfaceExtensionPreview
                          client={client}
                          presetId={draft.id}
                          revision={draft.revision}
                          files={draft.files}
                          structure={
                            draft.structure as unknown as Record<
                              string,
                              unknown
                            >
                          }
                          conflict={structuralConflict}
                          scriptsEnabled={draft.scriptsEnabled === true}
                        />
                      )
                    }
                  />
                </div>
              ) : null}
              {workspaceView === "files" ? (
                <PresetFileWorkspace
                  files={draft.files}
                  filePath={filePath}
                  newFilePath={newFilePath}
                  pending={pending}
                  onFilePathChange={setFilePath}
                  onNewFilePathChange={setNewFilePath}
                  onFileChange={updateFile}
                  onCreateFile={() => {
                    const path = newFilePath.trim();
                    if (draft.files[path] !== undefined) {
                      setFeedback({
                        kind: "error",
                        text: uiText("该编排方案文件路径已经存在。"),
                      });
                      return;
                    }
                    updateFiles((files) => ({ ...files, [path]: "" }));
                    setFilePath(path);
                    setNewFilePath("");
                    setFeedback({
                      kind: "status",
                      text: uiText(
                        "已加入修复草稿，保存时将检查编排方案格式。",
                      ),
                    });
                  }}
                />
              ) : null}
              {draft.structure === undefined &&
              (workspaceView === "call_chain" ||
                workspaceView === "setting_improvement") ? (
                <section
                  id={`play-preset-panel-${workspaceView}`}
                  className="play-preset-empty-view"
                  role="tabpanel"
                  aria-labelledby={`play-preset-tab-${workspaceView}`}
                >
                  <strong>{uiText("结构化编辑暂不可用")}</strong>
                  <p>
                    {uiText(
                      "导入内容无法解析；原文完整保留，可导出或打开原文修复。",
                    )}
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setWorkspaceView("files")}
                  >
                    {uiText("修复导入原文")}
                  </button>
                </section>
              ) : null}
              <footer className="play-preset-editor-actions">
                {structuralConflict ? (
                  <p role="alert" className="workspace-feedback">
                    {uiText(
                      "编排方案原文与表单均有修改，请先保留一种编辑结果再保存，以免覆盖当前修改。",
                    )}
                  </p>
                ) : null}
                <div className="play-preset-save-state">
                  <strong>
                    {dirty
                      ? uiText("草稿尚未保存")
                      : draft.validation.status === "valid"
                        ? uiText("编排方案检查通过")
                        : uiText("草稿需要修复")}
                  </strong>
                  <p>{nextSend}</p>
                  {draft.validation.status === "invalid" && (
                    <span>
                      {`[${draft.validation.code ?? "play_preset_invalid"}] ${draft.validation.location ?? "call-chain.yaml"}：${draft.validation.message}`}
                    </span>
                  )}
                </div>
                <div className="play-preset-primary-actions">
                  {dirty ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pending}
                      onClick={resetDraft}
                    >
                      {uiText("撤销未保存修改")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={
                      pending ||
                      (!dirty &&
                        draft.structure?.migrationNotice === undefined) ||
                      structuralConflict
                    }
                    onClick={() => void saveDraft()}
                  >
                    {uiText("保存修改")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      pending || dirty || draft.validation.status !== "valid"
                    }
                    onClick={() =>
                      void run(async () => {
                        const receipt = await request<PlayPresetReceipt>({
                          type: "play.select",
                          presetId: draft.id,
                        });
                        acceptPreset(receipt);
                        setFeedback({
                          kind: "status",
                          text: uiText(
                            "已应用此编排方案；游玩修改将在下一次正常发送时生效。",
                          ),
                        });
                      })
                    }
                  >
                    {uiText("应用为当前编排方案")}
                  </button>
                </div>
              </footer>
            </section>
          )}
        </div>
      </fieldset>
      {deletion !== null && (
        <ConfirmationDialog request={deletion} onDecision={decideDeletion} />
      )}
    </section>
  );
}

export function ArtifactDefinitionEditor({
  artifact,
  files,
  mount,
  onChange,
  onRemove,
}: {
  artifact: PlayPresetArtifactDefinition;
  files: Record<string, string>;
  mount: PlayPresetMount["mount"] | undefined;
  onChange: (
    update: (
      artifact: PlayPresetArtifactDefinition,
    ) => PlayPresetArtifactDefinition,
  ) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const rendererPaths = Object.keys(files)
    .filter((path) => /^renderers\/.+\.html$/u.test(path))
    .sort();
  const regexPaths = Object.keys(files)
    .filter((path) => /^regex\/.+\.yaml$/u.test(path))
    .sort();
  const scriptPaths = Object.keys(files)
    .filter((path) => /^scripts\/.+\.js$/u.test(path))
    .sort();
  const assetPaths = Object.keys(files)
    .filter((path) => path.startsWith("assets/"))
    .sort();

  function setOptional(
    field: "renderer" | "rendererRevision" | "regex" | "key",
    value: string,
  ): void {
    onChange((current) => {
      const next = { ...current };
      if (value === "") delete next[field];
      else next[field] = value;
      return next;
    });
  }

  function setPaths(field: "scripts" | "assets", paths: string[]): void {
    onChange((current) => {
      const next = { ...current };
      if (paths.length === 0) delete next[field];
      else next[field] = paths;
      return next;
    });
  }

  return (
    <article className="play-preset-artifact-definition">
      <header>
        <div>
          <strong>{artifact.name}</strong>
          <span>
            {contentTypeLabel(artifact.contentType)} ·
            {mount === undefined
              ? uiText(" 不在页面显示")
              : ` ${mountLabel(mount)}`}
          </span>
        </div>
        <button type="button" className="danger-button" onClick={onRemove}>
          {uiText("删除产物")}
        </button>
      </header>
      <div className="play-preset-form-grid">
        <label>
          {uiText("产物标识")}
          <input
            aria-label={uiText("{name} 产物标识", { name: artifact.name })}
            value={artifact.name}
            onChange={(event) => {
              const name = event.currentTarget.value;
              onChange((current) => ({
                ...current,
                name,
              }));
            }}
          />
        </label>
        <label>
          {uiText("内容格式")}
          <select
            aria-label={uiText("{name} 内容格式", { name: artifact.name })}
            value={artifact.contentType}
            onChange={(event) => {
              const contentType = event.currentTarget
                .value as PlayPresetArtifactDefinition["contentType"];
              onChange((current) => ({
                ...current,
                contentType,
              }));
            }}
          >
            <option value="text/markdown">{uiText("Markdown 文本")}</option>
            <option value="text/plain">{uiText("纯文本")}</option>
            <option value="application/json">{uiText("结构化数据")}</option>
            <option value="text/html">HTML</option>
          </select>
        </label>
        <label>
          {uiText("同频道已有内容时")}
          <select
            aria-label={uiText("{name} 更新方式", { name: artifact.name })}
            value={artifact.strategy}
            onChange={(event) => {
              const strategy = event.currentTarget
                .value as PlayPresetArtifactStrategy;
              onChange((current) => {
                return {
                  ...current,
                  strategy,
                  ...(strategy === "upsert" && current.key === undefined
                    ? { key: "current" }
                    : {}),
                };
              });
            }}
          >
            <option value="replace">{artifactOptionLabel("replace")}</option>
            <option value="append">{artifactOptionLabel("append")}</option>
            <option value="upsert">{artifactOptionLabel("upsert")}</option>
            <option value="transient">
              {artifactOptionLabel("transient")}
            </option>
            <option value="hidden">{artifactOptionLabel("hidden")}</option>
          </select>
        </label>
        <label className="play-preset-checkbox-field">
          <input
            type="checkbox"
            checked={artifact.required}
            onChange={(event) => {
              const required = event.currentTarget.checked;
              onChange((current) => ({
                ...current,
                required,
              }));
            }}
          />
          {uiText("AI 必须生成这项产物")}
        </label>
      </div>
      <details className="play-preset-advanced-card">
        <summary>{uiText("高级产物设置")}</summary>
        <div className="play-preset-form-grid">
          <label>
            {uiText("技术频道地址")}
            <input
              aria-label={uiText("{name} 技术频道", {
                name: artifact.name,
              })}
              value={artifact.channel}
              onChange={(event) => {
                const channel = event.currentTarget.value;
                onChange((current) => ({
                  ...current,
                  channel,
                }));
              }}
            />
          </label>
          {artifact.strategy === "upsert" ? (
            <label>
              {uiText("更新 key")}
              <input
                value={artifact.key ?? ""}
                onChange={(event) =>
                  setOptional("key", event.currentTarget.value)
                }
              />
            </label>
          ) : null}
          <label>
            {uiText("保存到")}
            <select
              value={artifact.save}
              onChange={(event) => {
                const save = event.currentTarget
                  .value as PlayPresetArtifactDefinition["save"];
                onChange((current) => ({
                  ...current,
                  save,
                }));
              }}
            >
              <option value="commit">{artifactOptionLabel("commit")}</option>
              <option value="operation">
                {artifactOptionLabel("operation")}
              </option>
              <option value="none">{artifactOptionLabel("none")}</option>
            </select>
          </label>
          <label>
            {uiText("何时失效")}
            <select
              value={artifact.invalidation}
              onChange={(event) => {
                const invalidation = event.currentTarget
                  .value as PlayPresetArtifactInvalidation;
                onChange((current) => ({
                  ...current,
                  invalidation,
                }));
              }}
            >
              <option value="new_operation">
                {artifactOptionLabel("new_operation")}
              </option>
              <option value="head_change">
                {artifactOptionLabel("head_change")}
              </option>
              <option value="operation_end">
                {artifactOptionLabel("operation_end")}
              </option>
              <option value="explicit_clear">
                {artifactOptionLabel("explicit_clear")}
              </option>
              <option value="never">{artifactOptionLabel("never")}</option>
            </select>
          </label>
          <label>
            {uiText("单次最多输出次数")}
            <input
              type="number"
              min={1}
              value={artifact.maxEmits}
              onChange={(event) => {
                const maxEmits = Number(event.currentTarget.value);
                onChange((current) => ({
                  ...current,
                  maxEmits,
                }));
              }}
            />
          </label>
          <label>
            {uiText("界面模板")}
            <select
              value={artifact.renderer ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onChange((current) => {
                  const next = { ...current };
                  if (value === "") {
                    delete next.renderer;
                    delete next.rendererRevision;
                  } else {
                    next.renderer = value;
                    next.rendererRevision ??= "v1";
                  }
                  return next;
                });
              }}
            >
              <option value="">{uiText("使用内置显示")}</option>
              {withCurrentPath(rendererPaths, artifact.renderer).map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          {artifact.renderer === undefined ? null : (
            <>
              <label>
                {uiText("模板版本标记")}
                <input
                  value={artifact.rendererRevision ?? ""}
                  onChange={(event) =>
                    setOptional("rendererRevision", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                {uiText("模板模式")}
                <select
                  value={artifact.rendererMode ?? "document"}
                  onChange={(event) => {
                    const rendererMode = event.currentTarget.value as
                      "document" | "app";
                    onChange((current) => ({
                      ...current,
                      rendererMode,
                    }));
                  }}
                >
                  <option value="document">{uiText("静态文档")}</option>
                  <option value="app">{uiText("可交互 app")}</option>
                </select>
              </label>
            </>
          )}
          <label>
            {uiText("正则处理规则")}
            <select
              value={artifact.regex ?? ""}
              onChange={(event) =>
                setOptional("regex", event.currentTarget.value)
              }
            >
              <option value="">{uiText("不使用")}</option>
              {withCurrentPath(regexPaths, artifact.regex).map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="play-preset-resource-columns">
          <div>
            <h6>{uiText("脚本文件")}</h6>
            <PathChecklist
              ariaLabel={uiText("{name} 脚本", { name: artifact.name })}
              paths={scriptPaths}
              selected={artifact.scripts ?? []}
              emptyText={uiText("没有脚本文件。")}
              onChange={(paths) => setPaths("scripts", paths)}
            />
          </div>
          <div>
            <h6>{uiText("样式与资源")}</h6>
            <PathChecklist
              ariaLabel={uiText("{name} 资源", { name: artifact.name })}
              paths={assetPaths}
              selected={artifact.assets ?? []}
              emptyText={uiText("没有资源文件。")}
              onChange={(paths) => setPaths("assets", paths)}
            />
          </div>
        </div>
        {artifact.payloadContract === undefined ? null : (
          <details>
            <summary>{uiText("当前严格数据格式（只读）")}</summary>
            <p className="field-note">
              {uiText(
                "这里显示此产物的数据要求。需要修改时，请在当前内容包或世界修订的文件编辑中修改 control/followups.yaml 的对应产物声明。",
              )}
            </p>
            <pre>{JSON.stringify(artifact.payloadContract, null, 2)}</pre>
          </details>
        )}
      </details>
    </article>
  );
}

function contentTypeLabel(
  contentType: PlayPresetArtifactDefinition["contentType"],
): string {
  return (
    {
      "text/plain": uiText("纯文本"),
      "text/markdown": "Markdown",
      "application/json": uiText("结构化数据"),
      "text/html": "HTML",
    } as const
  )[contentType];
}

function PresetFileWorkspace({
  files,
  filePath,
  newFilePath,
  pending,
  onFilePathChange,
  onNewFilePathChange,
  onFileChange,
  onCreateFile,
}: {
  files: Record<string, string>;
  filePath: string;
  newFilePath: string;
  pending: boolean;
  onFilePathChange: (path: string) => void;
  onNewFilePathChange: (path: string) => void;
  onFileChange: (contents: string) => void;
  onCreateFile: () => void;
}): React.JSX.Element {
  const paths = Object.keys(files).sort();
  const selectedPath =
    files[filePath] === undefined ? (paths[0] ?? "") : filePath;
  const selectedInfo = describePresetFile(
    selectedPath,
    files[selectedPath] ?? "",
  );
  return (
    <section
      id="play-preset-panel-files"
      className="play-preset-file-workspace"
      role="tabpanel"
      aria-labelledby="play-preset-files-title"
    >
      <header className="play-preset-workspace-heading">
        <div>
          <p className="play-preset-section-kicker">ADVANCED FILES</p>
          <h4 id="play-preset-files-title">{uiText("完整编排方案文件")}</h4>
        </div>
        <p>
          {uiText(
            "常用设置应在前面的表单完成。这里保留完整 YAML、Markdown、HTML、脚本和样式，并说明每份文件负责什么。",
          )}
        </p>
      </header>
      <div
        className="play-preset-yaml-guide"
        aria-label={uiText("三个核心 YAML 文件的用途")}
      >
        {[
          describePresetFile(
            Object.hasOwn(files, "preset.yaml")
              ? "preset.yaml"
              : orchestrationManifest,
            files[orchestrationManifest] ?? files["preset.yaml"] ?? "",
          ),
          describePresetFile("call-chain.yaml", files["call-chain.yaml"] ?? ""),
          describePresetFile("frame.yaml", files["frame.yaml"] ?? ""),
        ].map((info) => (
          <article key={info.path}>
            <strong>{info.title}</strong>
            <code>{info.path}</code>
            <p>{info.description}</p>
          </article>
        ))}
      </div>
      <label className="play-preset-file-jump">
        {uiText("快速跳转文件")}
        <select
          aria-label={uiText("编排方案文件")}
          value={selectedPath}
          onChange={(event) => onFilePathChange(event.currentTarget.value)}
        >
          {paths.map((path) => (
            <option key={path} value={path}>
              {describePresetFile(path, files[path] ?? "").title} · {path}
            </option>
          ))}
        </select>
      </label>
      <div className="play-preset-file-browser">
        <aside aria-label={uiText("编排方案文件列表")}>
          <ul>
            {paths.map((path) => {
              const info = describePresetFile(path, files[path] ?? "");
              return (
                <li key={path}>
                  <button
                    type="button"
                    className={path === selectedPath ? "selected" : ""}
                    aria-pressed={path === selectedPath}
                    aria-label={uiText("打开编排方案文件 {path}", { path })}
                    onClick={() => onFilePathChange(path)}
                  >
                    <strong>{info.title}</strong>
                    <span>{info.kind}</span>
                    <code>{path}</code>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <section className="play-preset-file-editor-pane">
          <header>
            <div>
              <span>{selectedInfo.kind}</span>
              <h5>{selectedInfo.title}</h5>
              <code>{selectedPath}</code>
            </div>
            <p>{selectedInfo.description}</p>
          </header>
          <label className="play-preset-source-editor">
            <span>{uiText("完整文件内容")}</span>
            <textarea
              aria-label={uiText("编辑编排方案文件 {path}", {
                path: selectedPath,
              })}
              wrap="soft"
              value={files[selectedPath] ?? ""}
              onChange={(event) => onFileChange(event.currentTarget.value)}
              spellCheck={false}
            />
          </label>
        </section>
      </div>
      <details className="play-preset-file-create">
        <summary>{uiText("新增修复文件")}</summary>
        <div className="play-preset-file-add">
          <label>
            {uiText("新文件路径（prompt/regex/renderer/script/asset）")}
            <input
              aria-label={uiText("新增编排方案文件路径")}
              placeholder="renderers/my-panel.html"
              value={newFilePath}
              onChange={(event) =>
                onNewFilePathChange(event.currentTarget.value)
              }
            />
          </label>
          <button
            type="button"
            disabled={pending || newFilePath.trim() === ""}
            onClick={onCreateFile}
          >
            {uiText("加入文件草稿")}
          </button>
        </div>
      </details>
    </section>
  );
}
