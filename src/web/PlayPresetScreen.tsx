import { resourceTitle } from "./preset-resource-names.ts";
import "./preset-workbench.css";
import { PresetWorkbenchEditor } from "./PresetWorkbenchEditor.tsx";
import { PresetDraftPreview } from "./PresetDraftPreview.tsx";
import { DismissibleNotice } from "./DismissibleNotice.tsx";
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
import { getWebLocale, uiText } from "./i18n.ts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  if (Object.prototype.hasOwnProperty.call(files, "preset.yaml"))
    return "preset.yaml";
  if (Object.prototype.hasOwnProperty.call(files, "call-chain.yaml"))
    return "call-chain.yaml";
  return Object.keys(files).sort()[0] ?? "";
}

export function PlayPresetScreen({
  client,
  initialLibrary,
  recommendedTemplates = [],
  onLibraryChange,
  onDirtyChange,
  renderPromptPreview,
}: {
  client: PlayPresetClient;
  initialLibrary: PlayPresetScreenLibrary;
  recommendedTemplates?: RecommendedPlayPresetTemplate[];
  onLibraryChange: (library: PlayPresetScreenLibrary) => void;
  onDirtyChange: (dirty: boolean) => void;
  renderPromptPreview?: (target: {
    presetId: string;
    revision: string;
  }) => ReactNode;
}): React.JSX.Element {
  const [library, setLibrary] = useState(initialLibrary);
  const libraryMenu = useRef<HTMLDetailsElement>(null);
  const initial =
    initialLibrary.presets.find(
      ({ id }) => id === initialLibrary.currentPresetId,
    ) ?? initialLibrary.presets[0];
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const [draft, setDraft] = useState<PlayPresetScreenPreset | null>(() =>
    initial === undefined ? null : toEditablePreset(initial),
  );
  const [filePath, setFilePath] = useState(
    initial?.files === undefined
      ? ""
      : preferredPresetFilePath(initial.draft?.files ?? initial.files),
  );
  const [newName, setNewName] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [workspaceView, setWorkspaceView] =
    useState<PlayPresetWorkspaceView>("call_chain");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const saved = useMemo(
    () => library.presets.find(({ id }) => id === draft?.id),
    [draft?.id, library.presets],
  );
  const savedEditable = saved?.draft ?? saved;
  const contentDirty =
    draft !== null &&
    savedEditable !== undefined &&
    (JSON.stringify(draft.files) !== JSON.stringify(savedEditable.files) ||
      JSON.stringify(draft.structure) !==
        JSON.stringify(savedEditable.structure));
  const nameDirty =
    draft !== null && saved !== undefined && draft.name !== saved.name;
  const dirty =
    draft !== null && saved !== undefined && (nameDirty || contentDirty);
  const structuralPaths = useMemo(() => {
    const callChainPath =
      draft?.structure?.callChainPath ??
      savedEditable?.structure?.callChainPath ??
      "call-chain.yaml";
    return new Set(["preset.yaml", callChainPath]);
  }, [
    draft?.structure?.callChainPath,
    savedEditable?.structure?.callChainPath,
  ]);
  const boundPaths = new Set([
    ...(draft?.structure?.followups.flatMap((f) => [
      f.prompt.path,
      ...f.artifacts.flatMap((a) => [
        a.renderer,
        a.regex,
        ...(a.scripts ?? []),
        ...(a.assets ?? []),
      ]),
    ]) ?? []),
    ...(draft?.structure?.playerViewPanels.flatMap((p) => [
      p.renderer,
      p.regex,
      ...(p.scripts ?? []),
      ...(p.assets ?? []),
    ]) ?? []),
  ]);
  const rawStructuralDirty =
    draft !== null &&
    savedEditable !== undefined &&
    [...structuralPaths].some(
      (path) => draft.files[path] !== savedEditable.files[path],
    );
  const structuredDirty =
    draft !== null &&
    savedEditable !== undefined &&
    JSON.stringify(draft.structure) !== JSON.stringify(savedEditable.structure);
  const structuralConflict = rawStructuralDirty && structuredDirty;
  const currentPreset = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  );

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function refresh(preferredId?: string): Promise<void> {
    const next = await client.request<PlayPresetScreenLibrary>({
      type: "play.read",
    });
    const selected =
      next.presets.find(({ id }) => id === preferredId) ??
      next.presets.find(({ id }) => id === selectedId) ??
      next.presets.find(({ id }) => id === next.currentPresetId) ??
      next.presets[0];
    if (libraryMenu.current) libraryMenu.current.open = false;
    setLibrary(next);
    onLibraryChange(next);
    setSelectedId(selected?.id ?? "");
    const editable = selected === undefined ? null : toEditablePreset(selected);
    setDraft(editable);
    setFilePath(
      editable === null ? "" : preferredPresetFilePath(editable.files),
    );
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
          error instanceof Error ? error.message : uiText("玩法预设操作失败"),
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
        text: uiText("当前玩法有未保存修改；请先保存或撤销，再切换预设。"),
      });
      return;
    }
    const next = library.presets.find(({ id: candidate }) => candidate === id);
    if (next === undefined) return;
    setSelectedId(id);
    const editable = toEditablePreset(next);
    setDraft(editable);
    setFilePath(preferredPresetFilePath(editable.files));
    setFeedback(null);
    setWorkspaceView("call_chain");
  }

  function resetDraft(): void {
    if (saved === undefined) return;
    const editable = toEditablePreset(saved);
    setDraft(editable);
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

  async function saveDraft(): Promise<void> {
    if (draft === null) return;
    if (structuralConflict) {
      setFeedback({
        kind: "error",
        text: uiText(
          "预设原文与表单均有修改，请先保留一种编辑结果再保存，以免覆盖当前修改。",
        ),
      });
      return;
    }
    await run(async () => {
      await client.request({
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
      await refresh(draft.id);
      setFeedback({
        kind: "status",
        text: uiText("预设已保存。"),
      });
    });
  }

  async function exportPreset(): Promise<void> {
    if (draft === null) return;
    await run(async () => {
      const result = await client.request<{
        files: { path: string; contents: string }[];
      }>({ type: "play.export", presetId: draft.id });
      const blob = new Blob([JSON.stringify(result.files, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${draft.name}.play-preset.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback({ kind: "status", text: uiText("预设已导出。") });
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
          uiText("无法识别此预设。请选择通过“导出预设”生成的文件。"),
        );
      const result = await client.request<{
        preset: PlayPresetScreenPreset;
      }>({
        type: "play.import",
        name:
          file.name.replace(/\.play-preset\.json$/iu, "") || uiText("导入玩法"),
        files: parsed as { path: string; contents: string }[],
      });
      await refresh(result.preset.id);
      setFeedback({
        kind: "status",
        text: uiText(
          "预设已导入为独立副本，JavaScript 默认关闭；信任其内容后可在预设操作中启用。",
        ),
      });
    });
  }

  return (
    <section
      className="play-preset-screen"
      aria-labelledby="play-preset-title"
      onPointerDownCapture={(event) => {
        for (const menu of event.currentTarget.querySelectorAll<HTMLDetailsElement>(
          ".play-preset-operations[open], .play-preset-library > details[open]",
        ))
          if (event.target instanceof Node && !menu.contains(event.target))
            menu.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape")
          for (const menu of event.currentTarget.querySelectorAll<HTMLDetailsElement>(
            ".play-preset-operations[open], .play-preset-library > details[open]",
          ))
            menu.open = false;
      }}
    >
      <header className="play-preset-header">
        <div>
          <p className="eyebrow">PLAY WORKBENCH · FILE NATIVE</p>
          <h2 id="play-preset-title">{uiText("玩法预设")}</h2>
          <p className="play-preset-lede">
            {uiText("在同一处编辑设定完善方法、主持规则、后置请求与界面展示。")}
          </p>
        </div>
        <div className="play-preset-header-fact">
          <span>{uiText("当前使用的预设")}</span>
          <strong>{currentPreset?.name ?? uiText("未选择")}</strong>
          <small>
            {uiText("游玩在下一次正常发送生效，原样重试保留旧请求")}
          </small>
        </div>
      </header>

      {feedback === null ? null : (
        <DismissibleNotice
          className={`play-preset-feedback ${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      <fieldset disabled={pending} className="play-preset-workspace">
        <legend className="visually-hidden">{uiText("玩法预设工作区")}</legend>
        <div className="play-preset-layout">
          <div className="play-preset-toolbar">
            <aside
              className="panel-card play-preset-library"
              aria-label={uiText("玩法预设列表")}
            >
              <label>
                <span className="visually-hidden">{uiText("玩法预设")}</span>
                <select
                  aria-label={uiText("切换预设")}
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
                <summary>{uiText("预设管理")}</summary>

                <section
                  className="play-preset-library-actions"
                  aria-label={uiText("新建与导入玩法预设")}
                >
                  <h4>{uiText("新建或导入")}</h4>
                  <input
                    aria-label={uiText("新玩法预设名称")}
                    placeholder={uiText("新玩法预设名称")}
                    value={newName}
                    onChange={(event) => setNewName(event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    disabled={pending || dirty || newName.trim() === ""}
                    onClick={() =>
                      void run(async () => {
                        const result = await client.request<{
                          currentPresetId: string;
                          preset: PlayPresetScreenPreset;
                        }>({
                          type: "play.create",
                          name: newName.trim(),
                        });
                        setNewName("");
                        await refresh(result.preset.id);
                        setFeedback({
                          kind: "status",
                          text: uiText("已新建普通玩法预设。"),
                        });
                      })
                    }
                  >
                    {uiText("新建空白预设")}
                  </button>
                  {recommendedTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="secondary-button"
                      disabled={pending || dirty}
                      onClick={() =>
                        void run(async () => {
                          const result = await client.request<{
                            currentPresetId: string;
                            preset: PlayPresetScreenPreset;
                          }>({
                            type: "play.create",
                            name: template.name,
                            files: structuredClone(template.files),
                          });
                          await refresh(result.preset.id);
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
                  <label className="play-preset-import-control">
                    {uiText("导入预设")}
                    <input
                      aria-label={uiText("选择要导入的预设")}
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
                  aria-label={uiText("玩法预设编辑区域")}
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
                  <summary>{uiText("预设操作")}</summary>
                  <div className="play-preset-operations-content">
                    <label className="play-preset-name-field">
                      {uiText("预设名称")}
                      <input
                        aria-label={uiText("玩法预设名称")}
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
                      aria-label={uiText("预设操作")}
                    >
                      <p>
                        {uiText(
                          "这些操作只管理这份本地预设；内容编辑和保存仍在页面底部完成。",
                        )}
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            await client.request({
                              type: "play.enable",
                              presetId: draft.id,
                              enabled: draft.enabled === false,
                            });
                            await refresh(draft.id);
                            setFeedback({
                              kind: "status",
                              text: uiText("玩法预设状态已更新。"),
                            });
                          })
                        }
                      >
                        {draft.enabled === false
                          ? uiText("启用预设")
                          : uiText("停用预设")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            await client.request({
                              type: "play.scripts",
                              presetId: draft.id,
                              enabled: draft.scriptsEnabled !== true,
                            });
                            await refresh(draft.id);
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
                            const copied = await client.request<{
                              preset: PlayPresetScreenPreset;
                            }>({ type: "play.copy", presetId: draft.id });
                            await refresh(copied.preset.id);
                            setFeedback({
                              kind: "status",
                              text: uiText("已复制为独立预设。"),
                            });
                          })
                        }
                      >
                        {uiText("复制为新预设")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || dirty}
                        onClick={() => void exportPreset()}
                      >
                        {uiText("导出预设")}
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={pending || dirty}
                        onClick={() =>
                          void run(async () => {
                            await client.request({
                              type: "play.delete",
                              presetId: draft.id,
                            });
                            await refresh();
                            setFeedback({
                              kind: "status",
                              text: uiText(
                                "玩法预设已删除；删空后会自动重建默认预设。",
                              ),
                            });
                          })
                        }
                      >
                        {uiText("删除预设")}
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
                          "未绑定资源仍随预设保存；可在模板编辑器重新引用。",
                        )}
                      </p>
                      {Object.keys(draft.files)
                        .filter(
                          (path) =>
                            !structuralPaths.has(path) && !boundPaths.has(path),
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
                                disabled={Object.entries(draft.files).some(
                                  ([other, body]) =>
                                    other !== path &&
                                    !structuralPaths.has(other) &&
                                    body.includes(path),
                                )}
                                onClick={() =>
                                  setDraft((current) => {
                                    if (
                                      !current?.structure ||
                                      boundPaths.has(path)
                                    )
                                      return current;
                                    const files = { ...current.files };
                                    delete files[path];
                                    return {
                                      ...current,
                                      files,
                                      structure: {
                                        ...current.structure,
                                        extensionRefs:
                                          current.structure.extensionRefs.filter(
                                            (ref) => ref !== path,
                                          ),
                                      },
                                    };
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
              {uiText("还没有玩法预设。")}
            </section>
          ) : (
            <section
              className="panel-card play-preset-editor"
              aria-label={uiText("预设编辑器")}
            >
              <header className="play-preset-editor-header">
                <div>
                  <p className="play-preset-section-kicker">EDIT PRESET</p>
                  <h3>{draft.name}</h3>
                  <p className="field-note">
                    {uiText("· 游玩修改在下一次正常发送生效")}
                  </p>
                </div>
                <div className="play-preset-editor-badges">
                  <span
                    className={`play-preset-draft-state${dirty ? " dirty" : ""}`}
                  >
                    {dirty ? uiText("未保存修改") : uiText("已保存")}
                  </span>
                  {draft.id === library.currentPresetId ? (
                    <span className="play-preset-badge current">
                      {uiText("当前玩法")}
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

              {draft.structure &&
              (workspaceView === "call_chain" ||
                workspaceView === "setting_improvement") ? (
                <PresetWorkbenchEditor
                  key={`${draft.id}:${workspaceView}`}
                  structure={draft.structure}
                  files={draft.files}
                  authoring={workspaceView === "setting_improvement"}
                  onChange={updateStructure}
                  onWrite={updateFileAtPath}
                  promptPreview={
                    <details className="preset-draft-preview">
                      <summary>{uiText("发送给 AI 的内容预览")}</summary>
                      {dirty ? (
                        <p>
                          {uiText(
                            "请先保存当前修改；这里预览的是已保存且校验通过的预设，不包含未保存修改。",
                          )}
                        </p>
                      ) : (
                        renderPromptPreview?.({
                          presetId: draft.id,
                          revision: draft.revision,
                        })
                      )}
                    </details>
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
                          draft.structure as unknown as Record<string, unknown>
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
                          draft.structure as unknown as Record<string, unknown>
                        }
                        conflict={structuralConflict}
                        scriptsEnabled={draft.scriptsEnabled === true}
                      />
                    )
                  }
                />
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
                        text: uiText("该玩法文件路径已经存在。"),
                      });
                      return;
                    }
                    updateFiles((files) => ({ ...files, [path]: "" }));
                    setFilePath(path);
                    setNewFilePath("");
                    setFeedback({
                      kind: "status",
                      text: uiText("已加入修复草稿，保存时将检查预设格式。"),
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
                      "预设原文与表单均有修改，请先保留一种编辑结果再保存，以免覆盖当前修改。",
                    )}
                  </p>
                ) : null}
                <div className="play-preset-save-state">
                  <strong>
                    {dirty
                      ? uiText("草稿尚未保存")
                      : draft.validation.status === "valid"
                        ? uiText("预设检查通过")
                        : uiText("草稿需要修复")}
                  </strong>
                  <span>
                    {draft.validation.status === "valid"
                      ? uiText("· 游玩修改在下一次正常发送生效")
                      : `[${draft.validation.code ?? "play_preset_invalid"}] ${draft.validation.location ?? "call-chain.yaml"}：${draft.validation.message}`}
                  </span>
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
                        await client.request({
                          type: "play.select",
                          presetId: draft.id,
                        });
                        await refresh(draft.id);
                        setFeedback({
                          kind: "status",
                          text: uiText(
                            "已应用此预设；游玩修改将在下一次正常发送时生效。",
                          ),
                        });
                      })
                    }
                  >
                    {uiText("应用为当前玩法")}
                  </button>
                </div>
              </footer>
            </section>
          )}
        </div>
      </fieldset>
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
            <h6>{uiText("脚本")}</h6>
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
      aria-labelledby="play-preset-tab-files play-preset-files-title"
    >
      <header className="play-preset-workspace-heading">
        <div>
          <p className="play-preset-section-kicker">ADVANCED FILES</p>
          <h4 id="play-preset-files-title">{uiText("完整预设文件")}</h4>
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
          describePresetFile("preset.yaml", files["preset.yaml"] ?? ""),
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
          aria-label={uiText("玩法预设文件")}
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
        <aside aria-label={uiText("玩法预设文件列表")}>
          <ul>
            {paths.map((path) => {
              const info = describePresetFile(path, files[path] ?? "");
              return (
                <li key={path}>
                  <button
                    type="button"
                    className={path === selectedPath ? "selected" : ""}
                    aria-pressed={path === selectedPath}
                    aria-label={uiText("打开玩法文件 {path}", { path })}
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
              aria-label={uiText("编辑玩法文件 {path}", {
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
              aria-label={uiText("新增玩法文件路径")}
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
