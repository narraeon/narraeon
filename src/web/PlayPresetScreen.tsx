import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parse as parseYaml, parseDocument } from "yaml";

import type { V1Request } from "../protocol/v1.ts";
import {
  applyRegexPipeline,
  buildAppSrcDoc,
  buildDocumentSrcDoc,
  extensionBridgeNamespace,
  type ArtifactPayload,
} from "./ArtifactExtensionHost.tsx";

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

interface PlayPresetWorkbenchSnapshot {
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

interface PlayPresetFollowupDefinition {
  id: string;
  displayName: string;
  prompt: PlayPresetPromptRef;
  artifacts: { name: string }[];
  maxArtifactBytes: number;
}

interface PlayPresetStructuredEditor {
  name: string;
  callChainPath: string;
  mounts: PlayPresetMount[];
  playerViewPanels: Record<string, unknown>[];
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

type PlayPresetWorkspaceView =
  "call_chain" | "extensions" | "blocks" | "files" | "preview" | "settings";

const playPresetWorkspaceViews: {
  id: PlayPresetWorkspaceView;
  label: string;
  description: string;
}[] = [
  {
    id: "call_chain",
    label: "调用链",
    description: "叙事规则、后置请求与工具契约",
  },
  {
    id: "extensions",
    label: "界面扩展",
    description: "频道挂载、面板与扩展引用",
  },
  {
    id: "blocks",
    label: "提示块",
    description: "块库与启用清单，未启用的块保留在树里",
  },
  {
    id: "files",
    label: "预设文件",
    description: "Prompt、YAML、HTML、脚本与样式",
  },
  {
    id: "preview",
    label: "产物预览",
    description: "冻结 contract 与 renderer 的真实预览",
  },
  {
    id: "settings",
    label: "管理",
    description: "启用状态、可信脚本与本地身份",
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

export function PlayPresetScreen({
  client,
  initialLibrary,
  recommendedTemplates = [],
  onLibraryChange,
  onDirtyChange,
  onOpenPromptPreview,
}: {
  client: PlayPresetClient;
  initialLibrary: PlayPresetScreenLibrary;
  recommendedTemplates?: RecommendedPlayPresetTemplate[];
  onLibraryChange: (library: PlayPresetScreenLibrary) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenPromptPreview?: (target: {
    presetId: string;
    revision: string;
  }) => void;
}): React.JSX.Element {
  const [library, setLibrary] = useState(initialLibrary);
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
      : (Object.keys(initial.files).sort()[0] ?? ""),
  );
  const [newName, setNewName] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [workspaceView, setWorkspaceView] =
    useState<PlayPresetWorkspaceView>("call_chain");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [workbench, setWorkbench] =
    useState<PlayPresetWorkbenchSnapshot | null>(null);
  const [workbenchPending, setWorkbenchPending] = useState(false);
  const [structuredError, setStructuredError] = useState<string | null>(null);
  const workbenchRequest = useRef(0);

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
  const onlyNameDirty = nameDirty && !contentDirty;
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
  const followupCount = draft?.structure?.followups.length ?? 0;
  const artifactCount =
    draft?.structure?.followups.reduce(
      (total, followup) => total + followup.artifacts.length,
      0,
    ) ?? 0;
  const mountCount = draft?.structure?.mounts.length ?? 0;
  const fileCount = draft === null ? 0 : Object.keys(draft.files).length;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    const selected = draft;
    const requestId = ++workbenchRequest.current;
    if (
      selected?.validation.status !== "valid" ||
      selected?.id !== selectedId ||
      dirty
    ) {
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (active && requestId === workbenchRequest.current)
        setWorkbenchPending(true);
    });
    void Promise.resolve(
      client.request<PlayPresetWorkbenchSnapshot>({
        type: "play.workbench.read",
        presetId: selected.id,
        revision: selected.revision,
      }),
    )
      .then((snapshot) => {
        if (
          snapshot !== undefined &&
          active &&
          requestId === workbenchRequest.current &&
          snapshot.id === selected.id &&
          snapshot.revision === selected.revision
        )
          setWorkbench(snapshot);
      })
      .catch(() => {
        if (active && requestId === workbenchRequest.current)
          setWorkbench(null);
      })
      .finally(() => {
        if (active && requestId === workbenchRequest.current)
          setWorkbenchPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, dirty, draft, selectedId]);

  const visibleWorkbench =
    draft !== null &&
    draft.validation.status === "valid" &&
    draft.id === selectedId &&
    !dirty &&
    workbench?.id === draft.id &&
    workbench.revision === draft.revision
      ? workbench
      : null;
  const visibleWorkbenchPending =
    draft !== null &&
    draft.validation.status === "valid" &&
    draft.id === selectedId &&
    !dirty &&
    workbenchPending;

  async function refresh(preferredId?: string): Promise<void> {
    const next = await client.request<PlayPresetScreenLibrary>({
      type: "play.read",
    });
    const selected =
      next.presets.find(({ id }) => id === preferredId) ??
      next.presets.find(({ id }) => id === selectedId) ??
      next.presets.find(({ id }) => id === next.currentPresetId) ??
      next.presets[0];
    setLibrary(next);
    onLibraryChange(next);
    setSelectedId(selected?.id ?? "");
    const editable = selected === undefined ? null : toEditablePreset(selected);
    setDraft(editable);
    setFilePath(
      editable === null ? "" : (Object.keys(editable.files).sort()[0] ?? ""),
    );
    setStructuredError(null);
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
        text: error instanceof Error ? error.message : "玩法预设操作失败",
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
        text: "当前玩法有未保存修改；请先保存或撤销，再切换预设。",
      });
      return;
    }
    const next = library.presets.find(({ id: candidate }) => candidate === id);
    if (next === undefined) return;
    setSelectedId(id);
    const editable = toEditablePreset(next);
    setDraft(editable);
    setFilePath(Object.keys(editable.files).sort()[0] ?? "");
    setWorkbench(null);
    setStructuredError(null);
    setFeedback(null);
    setWorkspaceView("call_chain");
  }

  function resetDraft(): void {
    if (saved === undefined) return;
    const editable = toEditablePreset(saved);
    setDraft(editable);
    setFilePath(Object.keys(editable.files).sort()[0] ?? "");
    setStructuredError(null);
    setFeedback({ kind: "status", text: "已撤销当前未保存修改。" });
  }

  function openPromptPreview(): void {
    if (draft?.validation.status !== "valid") {
      setFeedback({
        kind: "error",
        text: "当前玩法 revision 无效，修复并保存后才能生成真实 Prompt Preview。",
      });
      return;
    }
    if (dirty) {
      setFeedback({
        kind: "error",
        text: "当前玩法有未保存草稿；请先保存有效 revision，再打开真实 Prompt Preview。",
      });
      return;
    }
    onOpenPromptPreview?.({
      presetId: draft.id,
      revision: draft.revision,
    });
  }

  function updateFile(contents: string): void {
    if (draft === null || filePath === "") return;
    setDraft({
      ...draft,
      files: { ...draft.files, [filePath]: contents },
    });
  }

  function updateStructure(
    update: (
      structure: PlayPresetStructuredEditor,
    ) => PlayPresetStructuredEditor,
  ): void {
    if (draft?.structure === undefined) return;
    setDraft({
      ...draft,
      structure: update(structuredClone(draft.structure)),
    });
    setStructuredError(null);
  }

  async function saveDraft(): Promise<void> {
    if (draft === null) return;
    if (structuralConflict) {
      setFeedback({
        kind: "error",
        text: "preset.yaml/call-chain.yaml 与结构化编辑同时修改；请保留一种编辑方式后再保存，避免静默覆盖。",
      });
      return;
    }
    await run(async () => {
      await client.request({
        type: "play.save",
        presetId: draft.id,
        name: draft.name,
        files: draft.files,
        ...(draft.structure === undefined || !structuredDirty
          ? {}
          : {
              structure: draft.structure as unknown as Record<string, unknown>,
            }),
      });
      await refresh(draft.id);
      setFeedback({ kind: "status", text: "玩法文件与结构化草稿已保存。" });
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
      setFeedback({ kind: "status", text: "玩法预设业务文件已导出。" });
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
        throw new Error("导入文件必须是 UTF-8 玩法业务文件数组");
      const result = await client.request<{
        preset: PlayPresetScreenPreset;
      }>({
        type: "play.import",
        name: file.name.replace(/\.play-preset\.json$/iu, "") || "导入玩法",
        files: parsed as { path: string; contents: string }[],
      });
      await refresh(result.preset.id);
      setFeedback({
        kind: "status",
        text: "玩法预设已导入为新的本地身份；请显式启用其中的 JavaScript。",
      });
    });
  }

  return (
    <section className="play-preset-screen" aria-labelledby="play-preset-title">
      <header className="play-preset-header">
        <div>
          <p className="eyebrow">PLAY WORKBENCH · FILE NATIVE</p>
          <h2 id="play-preset-title">玩法预设</h2>
          <p className="play-preset-lede">
            在同一处管理调用链的叙事规则、后置请求、界面产物与可信本地代码。
          </p>
        </div>
        <div className="play-preset-header-fact">
          <span>新调用链当前使用</span>
          <strong>{currentPreset?.name ?? "未选择"}</strong>
          <small>已经开始的调用链继续使用冻结 revision</small>
        </div>
        <div className="play-preset-actions" aria-label="新建与导入玩法预设">
          <input
            aria-label="新玩法预设名称"
            placeholder="新玩法预设名称"
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
                setFeedback({ kind: "status", text: "已新建普通玩法预设。" });
              })
            }
          >
            新建空白预设
          </button>
          {recommendedTemplates.length === 0 ? null : (
            <button
              type="button"
              className="secondary-button"
              disabled={pending || dirty}
              onClick={() =>
                void run(async () => {
                  const template = recommendedTemplates[0];
                  if (template === undefined) return;
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
                    text: `已复制推荐${template.label}；所有文件均可编辑。`,
                  });
                })
              }
            >
              复制推荐{recommendedTemplates[0]!.label}
            </button>
          )}
          {recommendedTemplates.slice(1).map((template) => (
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
                    text: `已复制推荐${template.label}；所有文件均可编辑。`,
                  });
                })
              }
            >
              复制推荐{template.label}
            </button>
          ))}
          <label className="play-preset-import-control">
            导入玩法文件
            <input
              aria-label="导入玩法预设文件"
              type="file"
              accept=".json,application/json"
              disabled={pending || dirty}
              onChange={(event) => {
                void importPreset(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          {onOpenPromptPreview === undefined ? null : (
            <button
              type="button"
              className="secondary-button"
              onClick={openPromptPreview}
            >
              打开真实 Prompt Preview
            </button>
          )}
        </div>
      </header>

      {feedback === null ? null : (
        <div
          className={`play-preset-feedback ${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </div>
      )}

      <fieldset disabled={pending} className="play-preset-workspace">
        <legend className="visually-hidden">玩法预设工作区</legend>
        <div className="play-preset-layout">
          <aside
            className="panel-card play-preset-library"
            aria-label="玩法预设列表"
          >
            <div>
              <p className="play-preset-section-kicker">PRESET LIBRARY</p>
              <h3>本地预设</h3>
              <p className="field-note">选择一个本地身份开始编辑。</p>
            </div>
            <ul className="play-preset-list">
              {library.presets.map((preset) => {
                const selected = preset.id === selectedId;
                return (
                  <li key={preset.id}>
                    <button
                      className={`play-preset-list-button${selected ? " selected" : ""}`}
                      type="button"
                      aria-pressed={selected}
                      disabled={pending || (dirty && !selected)}
                      onClick={() => selectDraft(preset.id)}
                    >
                      <span className="play-preset-list-name">
                        {preset.name}
                      </span>
                      <span className="play-preset-list-badges">
                        {preset.id === library.currentPresetId ? (
                          <span className="play-preset-badge current">
                            当前玩法
                          </span>
                        ) : null}
                        <span
                          className={`play-preset-badge ${preset.validation.status}`}
                        >
                          {preset.validation.status === "valid"
                            ? "结构有效"
                            : "需要修复"}
                        </span>
                        {preset.enabled === false ? (
                          <span className="play-preset-badge disabled">
                            已停用
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {draft === null ? (
            <section className="panel-card" role="status">
              还没有玩法预设。
            </section>
          ) : (
            <section
              className="panel-card play-preset-editor"
              aria-label="玩法预设文件编辑器"
            >
              <header className="play-preset-editor-header">
                <div>
                  <p className="play-preset-section-kicker">EDIT PRESET</p>
                  <h3>{draft.name}</h3>
                  <p className="field-note">
                    revision {draft.revision} · 修改只影响之后开始的全新上下文
                  </p>
                </div>
                <div className="play-preset-editor-badges">
                  <span
                    className={`play-preset-draft-state${dirty ? " dirty" : ""}`}
                  >
                    {dirty ? "未保存修改" : "已保存"}
                  </span>
                  {draft.id === library.currentPresetId ? (
                    <span className="play-preset-badge current">当前玩法</span>
                  ) : null}
                  {draft.enabled === false ? (
                    <span className="play-preset-badge disabled">已停用</span>
                  ) : null}
                  <span className="play-preset-badge">
                    {draft.scriptsEnabled === true
                      ? "JavaScript 已启用"
                      : "JavaScript 已停用"}
                  </span>
                </div>
              </header>

              <label className="play-preset-name-field">
                预设名称
                <input
                  aria-label="玩法预设名称"
                  maxLength={160}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.currentTarget.value })
                  }
                />
              </label>

              <div className="play-preset-overview" aria-label="玩法预设摘要">
                <div>
                  <span>后置请求</span>
                  <strong>{followupCount}</strong>
                </div>
                <div>
                  <span>产物输出</span>
                  <strong>{artifactCount}</strong>
                </div>
                <div>
                  <span>界面挂载</span>
                  <strong>{mountCount}</strong>
                </div>
                <div>
                  <span>普通文件</span>
                  <strong>{fileCount}</strong>
                </div>
              </div>

              <nav
                className="play-preset-workspace-nav"
                role="tablist"
                aria-label="玩法预设编辑区域"
              >
                {playPresetWorkspaceViews.map((view) => (
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
                    <strong>{view.label}</strong>
                    <span>{view.description}</span>
                  </button>
                ))}
              </nav>

              {workspaceView === "settings" ? (
                <section
                  id="play-preset-panel-settings"
                  className="play-preset-settings"
                  role="tabpanel"
                  aria-labelledby="play-preset-tab-settings play-preset-settings-title"
                >
                  <header className="play-preset-workspace-heading">
                    <div>
                      <p className="play-preset-section-kicker">
                        LOCAL IDENTITY
                      </p>
                      <h4 id="play-preset-settings-title">玩法与本地身份</h4>
                    </div>
                    <p>
                      管理全新上下文可用性、可信脚本和便携文件。已经开始的调用链不会跟随这些开关变化。
                    </p>
                  </header>
                  <div
                    className="play-preset-management"
                    aria-label="玩法预设身份管理"
                  >
                    <span>
                      {draft.enabled === false ? "已停用" : "可用于全新上下文"}·
                      revision {draft.revision}
                    </span>
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
                            text: "玩法预设状态已更新。",
                          });
                        })
                      }
                    >
                      {draft.enabled === false ? "启用预设" : "停用预设"}
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
                                ? "JavaScript 已停用；raw/document 仍可预览。"
                                : "JavaScript 已显式启用（本地可信代码）。",
                          });
                        })
                      }
                    >
                      {draft.scriptsEnabled === true
                        ? "停用 JavaScript"
                        : "启用 JavaScript（本地可信代码）"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pending || dirty}
                      onClick={() => void exportPreset()}
                    >
                      导出业务文件
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        pending || draft.name.trim() === "" || !onlyNameDirty
                      }
                      onClick={() =>
                        void run(async () => {
                          await client.request({
                            type: "play.rename",
                            presetId: draft.id,
                            name: draft.name,
                          });
                          await refresh(draft.id);
                          setFeedback({
                            kind: "status",
                            text: "玩法预设已重命名；同名本地身份仍可并存。",
                          });
                        })
                      }
                    >
                      重命名
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
                            text: "玩法预设已删除；删空后会自动重建默认预设。",
                          });
                        })
                      }
                    >
                      删除预设
                    </button>
                  </div>
                  <p className="field-note">
                    导入的 JavaScript
                    默认停用；启用表示你信任这些本地文件，而不是获得安全沙箱保证。
                  </p>
                </section>
              ) : null}
              {draft.structure === undefined ||
              (workspaceView !== "call_chain" &&
                workspaceView !== "extensions") ? null : (
                <PlayPresetStructuredEditorPanel
                  view={workspaceView}
                  structure={draft.structure}
                  workbench={visibleWorkbench}
                  workbenchPending={visibleWorkbenchPending}
                  structuredError={structuredError}
                  onChange={updateStructure}
                  onError={setStructuredError}
                />
              )}
              {workspaceView === "blocks" && (
                <PresetBlockLibrary
                  files={draft.files}
                  pending={pending}
                  onChange={(files) => setDraft({ ...draft, files })}
                  onFeedback={setFeedback}
                  onOpenFile={(path) => {
                    setFilePath(path);
                    setWorkspaceView("files");
                  }}
                />
              )}
              {workspaceView === "files" ? (
                <section
                  id="play-preset-panel-files"
                  className="play-preset-file-workspace"
                  role="tabpanel"
                  aria-labelledby="play-preset-tab-files play-preset-files-title"
                >
                  <header className="play-preset-workspace-heading">
                    <div>
                      <p className="play-preset-section-kicker">SOURCE FILES</p>
                      <h4 id="play-preset-files-title">玩法文件</h4>
                    </div>
                    <p>
                      结构化编辑适合常用字段；这里保留完整
                      YAML、Prompt、renderer、脚本与样式编辑能力。
                    </p>
                  </header>
                  <div className="play-preset-file-toolbar">
                    <label>
                      当前文件
                      <select
                        aria-label="玩法预设文件"
                        value={filePath}
                        onChange={(event) =>
                          setFilePath(event.currentTarget.value)
                        }
                      >
                        {Object.keys(draft.files)
                          .sort()
                          .map((path) => (
                            <option key={path} value={path}>
                              {path}
                            </option>
                          ))}
                      </select>
                    </label>
                    <details className="play-preset-file-create">
                      <summary>新增文件</summary>
                      <div className="play-preset-file-add">
                        <label>
                          新增普通文件（prompt/regex/renderer/script/asset）
                          <input
                            aria-label="新增玩法文件路径"
                            placeholder="renderers/my-panel.html"
                            value={newFilePath}
                            onChange={(event) =>
                              setNewFilePath(event.currentTarget.value)
                            }
                          />
                        </label>
                        <button
                          type="button"
                          disabled={pending || newFilePath.trim() === ""}
                          onClick={() => {
                            const path = newFilePath.trim();
                            if (draft.files[path] !== undefined) {
                              setFeedback({
                                kind: "error",
                                text: "该玩法文件路径已经存在。",
                              });
                              return;
                            }
                            setDraft({
                              ...draft,
                              files: { ...draft.files, [path]: "" },
                            });
                            setFilePath(path);
                            setNewFilePath("");
                            setFeedback({
                              kind: "status",
                              text: "已加入普通文件草稿；保存时会通过 codec 校验。",
                            });
                          }}
                        >
                          新增普通文件
                        </button>
                      </div>
                    </details>
                  </div>
                  <label className="play-preset-source-editor">
                    <span>{filePath || "未选择文件"}</span>
                    <textarea
                      aria-label={`编辑玩法文件 ${filePath}`}
                      wrap="soft"
                      value={draft.files[filePath] ?? ""}
                      onChange={(event) =>
                        updateFile(event.currentTarget.value)
                      }
                      spellCheck={false}
                    />
                  </label>
                </section>
              ) : null}
              {draft.structure === undefined &&
              (workspaceView === "call_chain" ||
                workspaceView === "extensions") ? (
                <section
                  id={`play-preset-panel-${workspaceView}`}
                  className="play-preset-empty-view"
                  role="tabpanel"
                  aria-labelledby={`play-preset-tab-${workspaceView}`}
                >
                  <strong>结构化编辑暂不可用</strong>
                  <p>
                    当前草稿无法生成结构投影。请到“玩法文件”修复 preset.yaml 或
                    call-chain.yaml，保存后再回来。
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setWorkspaceView("files")}
                  >
                    前往玩法文件
                  </button>
                </section>
              ) : null}
              {workspaceView === "preview" ? (
                <section
                  id="play-preset-panel-preview"
                  className="play-preset-preview-workspace"
                  role="tabpanel"
                  aria-labelledby="play-preset-tab-preview"
                >
                  <header className="play-preset-workspace-heading">
                    <div>
                      <p className="play-preset-section-kicker">
                        FROZEN REVISION
                      </p>
                      <h4>真实产物预览</h4>
                    </div>
                    {onOpenPromptPreview === undefined ? null : (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={openPromptPreview}
                      >
                        打开真实 Prompt Preview
                      </button>
                    )}
                  </header>
                  {visibleWorkbenchPending ? (
                    <p role="status">正在生成真实编译/产物预览…</p>
                  ) : null}
                  {visibleWorkbench?.staticErrors.length ? (
                    <ul aria-label="工作台静态错误">
                      {visibleWorkbench.staticErrors.map((error) => (
                        <li key={`${error.location}:${error.code}`}>
                          {error.location} · {error.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <PlayPresetArtifactPreviewPanel
                    workbench={visibleWorkbench}
                  />
                </section>
              ) : null}

              <footer className="play-preset-editor-actions">
                {structuralConflict ? (
                  <p role="alert" className="workspace-feedback">
                    preset.yaml/call-chain.yaml
                    与结构化字段均有未保存修改；请撤销其中一侧后再保存，避免
                    stale structure 覆盖 raw YAML。
                  </p>
                ) : null}
                <div className="play-preset-save-state">
                  <strong>
                    {dirty
                      ? "草稿尚未保存"
                      : draft.validation.status === "valid"
                        ? "结构校验通过"
                        : "草稿需要修复"}
                  </strong>
                  <span>
                    {draft.validation.status === "valid"
                      ? `revision ${draft.revision}`
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
                      撤销未保存修改
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending || !dirty || structuralConflict}
                    onClick={() => void saveDraft()}
                  >
                    保存结构化/文件草稿
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
                          text: "已将该冻结 revision 设为当前玩法。",
                        });
                      })
                    }
                  >
                    应用为当前玩法
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
                          text: "已复制为独立本地身份。",
                        });
                      })
                    }
                  >
                    复制当前预设
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

interface PlayPresetStructuredEditorPanelProps {
  view: "call_chain" | "extensions";
  structure: PlayPresetStructuredEditor;
  workbench: PlayPresetWorkbenchSnapshot | null;
  workbenchPending: boolean;
  structuredError: string | null;
  onChange: (
    update: (
      structure: PlayPresetStructuredEditor,
    ) => PlayPresetStructuredEditor,
  ) => void;
  onError: (message: string | null) => void;
}

function PlayPresetStructuredEditorPanel({
  view,
  structure,
  workbench,
  workbenchPending,
  structuredError,
  onChange,
  onError,
}: PlayPresetStructuredEditorPanelProps): React.JSX.Element {
  function addNarrativePrompt(): void {
    onChange((current) => ({
      ...current,
      narrativePrompts: [
        ...current.narrativePrompts,
        { role: "author_instruction", path: "prompts/narrate.md" },
      ],
    }));
  }

  function addFollowup(): void {
    const used = new Set(structure.followups.map(({ id }) => id));
    let suffix = structure.followups.length + 1;
    let id = `followup_${suffix}`;
    while (used.has(id)) {
      suffix += 1;
      id = `followup_${suffix}`;
    }
    onChange((current) => ({
      ...current,
      followups: [
        ...current.followups,
        {
          id,
          displayName: "新后置请求",
          prompt: { role: "author_instruction", path: "prompts/narrate.md" },
          artifacts: [],
          maxArtifactBytes: 32_768,
        },
      ],
    }));
  }

  function parseJsonField(
    location: string,
    text: string,
    apply: (value: unknown) => void,
  ): void {
    try {
      apply(JSON.parse(text) as unknown);
      onError(null);
    } catch (error: unknown) {
      onError(
        `${location} JSON 无效：${
          error instanceof Error ? error.message : "无法解析"
        }`,
      );
    }
  }

  return (
    <section
      id={`play-preset-panel-${view}`}
      className="play-preset-structured-editor"
      role="tabpanel"
      aria-labelledby={`play-preset-tab-${view}`}
    >
      <header className="play-preset-workspace-heading">
        <div>
          <p className="play-preset-section-kicker">
            {view === "call_chain" ? "PLAY CALL CHAIN" : "PRESENTATION"}
          </p>
          <h3>{view === "call_chain" ? "调用链" : "界面扩展"}</h3>
        </div>
        <p>
          {view === "call_chain"
            ? "编辑进入稳定 bootstrap 的叙事规则，以及主调用链完成后独立派发的后置请求。"
            : "把后置请求产物挂载到稳定界面位置，并声明玩家视图与普通扩展文件。"}
        </p>
        {workbenchPending ? (
          <p role="status">正在生成真实编译/产物预览…</p>
        ) : null}
        {workbench === null && !workbenchPending ? (
          <p className="field-note">保存有效 revision 后生成真实预览。</p>
        ) : null}
        {structuredError === null ? null : (
          <p role="alert" className="workspace-feedback">
            {structuredError}
          </p>
        )}
        {workbench?.staticErrors.length ? (
          <ul aria-label="工作台静态错误">
            {workbench.staticErrors.map((error) => (
              <li key={`${error.location}:${error.code}`}>
                {error.location} · {error.message}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      {view === "extensions" ? (
        <>
          <div className="play-preset-structured-section">
            <h4>频道挂载</h4>
            {structure.mounts.map((mount, index) => (
              <div
                className="play-preset-inline-editor"
                key={`${mount.channel}-${index}`}
              >
                <label>
                  频道 {index + 1}
                  <input
                    aria-label={`频道挂载 ${index + 1} 名称`}
                    value={mount.channel}
                    onChange={(event) =>
                      onChange((current) => ({
                        ...current,
                        mounts: current.mounts.map(
                          (candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  channel: event.currentTarget.value,
                                }
                              : candidate,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  位置
                  <select
                    aria-label={`频道挂载 ${index + 1} 位置`}
                    value={mount.mount}
                    onChange={(event) =>
                      onChange((current) => ({
                        ...current,
                        mounts: current.mounts.map(
                          (candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  mount: event.currentTarget
                                    .value as PlayPresetMount["mount"],
                                }
                              : candidate,
                        ),
                      }))
                    }
                  >
                    <option value="story">story</option>
                    <option value="sidebar">sidebar</option>
                    <option value="composer_above">composer_above</option>
                    <option value="composer_below">composer_below</option>
                    <option value="overlay">overlay</option>
                    <option value="debug">debug</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    onChange((current) => ({
                      ...current,
                      mounts: current.mounts.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ),
                    }))
                  }
                >
                  删除挂载
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  mounts: [
                    ...current.mounts,
                    { channel: "custom.channel", mount: "story" },
                  ],
                }))
              }
            >
              新增频道挂载
            </button>
          </div>

          <div className="play-preset-structured-section">
            <h4>玩家视图面板与扩展引用</h4>
            <label>
              玩家视图面板（JSON）
              <textarea
                aria-label="玩家视图面板 JSON"
                value={JSON.stringify(structure.playerViewPanels, null, 2)}
                onChange={(event) =>
                  parseJsonField(
                    "玩家视图面板",
                    event.currentTarget.value,
                    (value) => {
                      if (!Array.isArray(value)) throw new Error("必须是数组");
                      onChange((current) => ({
                        ...current,
                        playerViewPanels: value.filter(isRecordValue),
                      }));
                    },
                  )
                }
                spellCheck={false}
              />
            </label>
            <label>
              扩展引用（JSON）
              <input
                aria-label="扩展引用 JSON"
                value={JSON.stringify(structure.extensionRefs)}
                onChange={(event) =>
                  parseJsonField(
                    "扩展引用",
                    event.currentTarget.value,
                    (value) => {
                      if (
                        !Array.isArray(value) ||
                        value.some((entry) => typeof entry !== "string")
                      )
                        throw new Error("必须是字符串数组");
                      onChange((current) => ({
                        ...current,
                        extensionRefs: value as string[],
                      }));
                    },
                  )
                }
              />
            </label>
          </div>
        </>
      ) : null}

      {view === "call_chain" ? (
        <div className="play-preset-structured-section">
          <div className="play-preset-section-header">
            <h4>叙事提示块</h4>
            <button type="button" onClick={addNarrativePrompt}>
              新增叙事提示块
            </button>
          </div>
          <p>
            这些块和主持块一起进入稳定 bootstrap，约束调用链中的玩家可见正文。
          </p>
          {structure.narrativePrompts.length === 0 ? (
            <p>尚未声明叙事提示块；通用文风仍由主持块提供。</p>
          ) : null}
          <ol aria-label="叙事提示块">
            {structure.narrativePrompts.map((prompt, index) => (
              <li key={`narrative-${index}`}>
                <label>
                  提示块路径
                  <input
                    aria-label={`叙事提示块 ${index + 1} 路径`}
                    value={prompt.path}
                    onChange={(event) => {
                      const path = event.currentTarget.value;
                      onChange((current) => ({
                        ...current,
                        narrativePrompts: current.narrativePrompts.map(
                          (entry, entryIndex) =>
                            entryIndex === index ? { ...entry, path } : entry,
                        ),
                      }));
                    }}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`删除叙事提示块 ${index + 1}`}
                  onClick={() =>
                    onChange((current) => ({
                      ...current,
                      narrativePrompts: current.narrativePrompts.filter(
                        (_, entryIndex) => entryIndex !== index,
                      ),
                    }))
                  }
                >
                  删除
                </button>
              </li>
            ))}
          </ol>

          <div className="play-preset-section-header">
            <h4>后置请求</h4>
            <button type="button" onClick={addFollowup}>
              新增后置请求
            </button>
          </div>
          <p>
            每个后置请求在主调用链完成后单独派发一次，共用同一段冻结前缀，彼此
            看不见对方，也不会进入之后的模型上下文。产物字段在「预设文件」里编辑
            call-chain.yaml。
          </p>
          {structure.followups.length === 0 ? (
            <p>没有后置请求；主调用链完成后不会再派发额外请求。</p>
          ) : null}
          <ol aria-label="后置请求">
            {structure.followups.map((followup, index) => (
              <li key={`followup-${followup.id}-${index}`}>
                <label>
                  标识
                  <input
                    aria-label={`后置请求 ${index + 1} 标识`}
                    value={followup.id}
                    onChange={(event) => {
                      const id = event.currentTarget.value;
                      onChange((current) => ({
                        ...current,
                        followups: current.followups.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, id } : entry,
                        ),
                      }));
                    }}
                  />
                </label>
                <label>
                  显示名
                  <input
                    aria-label={`后置请求 ${index + 1} 显示名`}
                    value={followup.displayName}
                    onChange={(event) => {
                      const displayName = event.currentTarget.value;
                      onChange((current) => ({
                        ...current,
                        followups: current.followups.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, displayName }
                            : entry,
                        ),
                      }));
                    }}
                  />
                </label>
                <label>
                  提示块路径
                  <input
                    aria-label={`后置请求 ${index + 1} 提示块路径`}
                    value={followup.prompt.path}
                    onChange={(event) => {
                      const path = event.currentTarget.value;
                      onChange((current) => ({
                        ...current,
                        followups: current.followups.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, prompt: { ...entry.prompt, path } }
                            : entry,
                        ),
                      }));
                    }}
                  />
                </label>
                <p>
                  产物 {followup.artifacts.length} 项
                  {followup.artifacts.length > 0
                    ? `：${followup.artifacts.map(({ name }) => name).join("、")}`
                    : ""}
                </p>
                <button
                  type="button"
                  aria-label={`删除后置请求 ${followup.id}`}
                  onClick={() =>
                    onChange((current) => ({
                      ...current,
                      followups: current.followups.filter(
                        (_, entryIndex) => entryIndex !== index,
                      ),
                    }))
                  }
                >
                  删除
                </button>
              </li>
            ))}
          </ol>
          {workbenchPending ? <p>正在读取产物预览……</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function PlayPresetArtifactPreviewPanel({
  workbench,
}: {
  workbench: PlayPresetWorkbenchSnapshot | null;
}): React.JSX.Element {
  if (workbench === null)
    return (
      <section
        className="play-preset-artifact-preview"
        aria-label="真实产物预览"
      >
        <h3>真实产物预览</h3>
        <p className="field-note">
          保存有效 revision 后可预览产物 contract、regex 与冻结 renderer。
        </p>
      </section>
    );
  return (
    <section className="play-preset-artifact-preview" aria-label="真实产物预览">
      <h3>真实产物预览（只读）</h3>
      <p className="field-note">
        样例由当前冻结文件生成；此处不调用模型、不写入世界，只复用生产
        regex/renderer 编码。
      </p>
      {workbench.artifactPreviews.length === 0 ? (
        <p className="field-note">当前预设没有 artifact output contract。</p>
      ) : (
        workbench.artifactPreviews.map((preview) => (
          <PlayPresetArtifactPreview
            key={`${preview.requestId}:${preview.output}`}
            preview={preview}
            scriptsEnabled={workbench.scriptsEnabled !== false}
          />
        ))
      )}
    </section>
  );
}

function PlayPresetArtifactPreview({
  preview,
  scriptsEnabled,
}: {
  preview: PlayPresetWorkbenchArtifact;
  scriptsEnabled: boolean;
}): React.JSX.Element {
  const payload = toArtifactPayload(preview.rawPayload);
  const pipeline = applyRegexPipeline({
    payload,
    contentType: preview.declaration.contentType,
    rules: preview.regex,
  });
  let srcDoc: string | null = null;
  let rendererError: string | null = null;
  const appPreviewEnabled = preview.renderer?.mode === "app" && scriptsEnabled;
  if (preview.renderer?.mode === "app" && !scriptsEnabled) {
    try {
      srcDoc = buildDocumentSrcDoc(
        pipeline.final,
        preview.declaration.contentType,
        undefined,
        payload,
      );
    } catch (error: unknown) {
      rendererError =
        error instanceof Error ? error.message : "raw/document fallback 失败";
    }
  } else if (preview.renderer !== undefined) {
    try {
      srcDoc =
        preview.renderer.mode === "app"
          ? buildAppSrcDoc({
              renderer: preview.renderer,
              instanceId: `workbench-${preview.requestId}-${preview.output}`,
              nonce: "workbench-preview",
            })
          : buildDocumentSrcDoc(
              pipeline.final,
              preview.declaration.contentType,
              preview.renderer,
              payload,
            );
    } catch (error: unknown) {
      rendererError =
        error instanceof Error ? error.message : "renderer 预览失败";
    }
  } else {
    try {
      srcDoc = buildDocumentSrcDoc(
        pipeline.final,
        preview.declaration.contentType,
        undefined,
        payload,
      );
    } catch (error: unknown) {
      rendererError =
        error instanceof Error ? error.message : "内置 renderer 预览失败";
    }
  }
  return (
    <article className="play-preset-artifact-card">
      <h4>
        {preview.requestId} / {preview.output}
      </h4>
      <p className="field-note">
        channel={preview.declaration.channel} · strategy=
        {preview.declaration.strategy} · save={preview.declaration.save} ·
        invalidation={preview.declaration.invalidation}
      </p>
      <details open>
        <summary>raw payload 与 emit schema</summary>
        <pre>{JSON.stringify(preview.rawPayload, null, 2)}</pre>
        <pre>{JSON.stringify(preview.declaration, null, 2)}</pre>
      </details>
      <details open>
        <summary>regex pipeline / 最终内容</summary>
        {pipeline.steps.map((step) => (
          <div key={`${step.order}:${step.scope}`} className="field-note">
            #{step.order} {step.scope} · {step.status} · matches={step.matches}
            {step.error === undefined ? null : ` · ${step.error}`}
          </div>
        ))}
        <pre>{pipeline.final}</pre>
      </details>
      <p className="field-note">
        active projection：{preview.activeProjection.status} ·{" "}
        {preview.activeProjection.channel}
        {preview.activeProjection.key === undefined
          ? ""
          : `/${preview.activeProjection.key}`}{" "}
        · clear：{preview.clear.description}
      </p>
      <div className="field-note">
        emit 后：{preview.simulation.emitted.status}（
        {preview.simulation.emitted.identity}）；explicit clear 后：
        {preview.simulation.explicitClear.status}；
        {preview.simulation.invalidation.policy} 触发后：
        {preview.simulation.invalidation.status}（
        {preview.simulation.invalidation.reason}）
      </div>
      {preview.renderer?.mode === "app" ? (
        <details open>
          <summary>app 初始消息（只读协议预览）</summary>
          <pre>
            {JSON.stringify(
              {
                namespace: "narraeon.extension.v1",
                type: "render.update",
                instanceId: `workbench-${preview.requestId}-${preview.output}`,
                payload: {
                  content: pipeline.final,
                  interactionDisabled: false,
                },
              },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
      {preview.diagnostics.map((diagnostic) => (
        <p role="alert" key={diagnostic}>
          {diagnostic}
        </p>
      ))}
      {preview.renderer?.mode === "app" && !scriptsEnabled ? (
        <p className="field-note">
          JavaScript 已停用；app 样例仅以 raw/document fallback
          显示，不执行作者脚本。
        </p>
      ) : null}
      {rendererError === null && srcDoc !== null ? (
        appPreviewEnabled ? (
          <WorkbenchAppPreview
            renderer={preview.renderer!}
            content={pipeline.final}
            rawPayload={payload}
            instanceId={`workbench-${preview.requestId}-${preview.output}`}
          />
        ) : (
          <iframe
            title={`产物预览 ${preview.requestId}/${preview.output}`}
            sandbox=""
            srcDoc={srcDoc}
          />
        )
      ) : preview.renderer === undefined ? (
        <p className="field-note">
          无自定义 renderer；上方 iframe 使用内置文本/Markdown/HTML renderer。
        </p>
      ) : (
        <pre role="alert">
          renderer fallback：{rendererError ?? "无法生成预览"}\n
          {preview.rawText}
        </pre>
      )}
    </article>
  );
}

function WorkbenchAppPreview({
  renderer,
  content,
  rawPayload,
  instanceId,
}: {
  renderer: PlayPresetWorkbenchRenderer;
  content: string;
  rawPayload: ArtifactPayload;
  instanceId: string;
}): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce] = useState(
    () => `workbench-${Math.random().toString(36).slice(2)}`,
  );
  const [ready, setReady] = useState(false);
  const srcDoc = buildAppSrcDoc({ renderer, instanceId, nonce });
  const sendUpdate = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        namespace: extensionBridgeNamespace,
        type: "render.update",
        instanceId,
        nonce,
        payload: {
          content,
          rawPayload,
          interactionDisabled: false,
        },
      },
      "*",
    );
  }, [content, instanceId, nonce, rawPayload]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        event.source !== iframeRef.current?.contentWindow ||
        typeof value !== "object" ||
        value === null ||
        (value as { namespace?: unknown }).namespace !==
          extensionBridgeNamespace ||
        (value as { type?: unknown }).type !== "bridge.ready" ||
        (value as { instanceId?: unknown }).instanceId !== instanceId ||
        (value as { nonce?: unknown }).nonce !== nonce
      )
        return;
      setReady(true);
      sendUpdate();
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [instanceId, nonce, sendUpdate]);

  useEffect(() => {
    if (ready) sendUpdate();
  }, [ready, sendUpdate]);

  return (
    <>
      <iframe
        ref={iframeRef}
        title={`产物预览 ${instanceId}`}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={sendUpdate}
      />
      <p className="field-note" role="status">
        {ready
          ? "app preview ready；已发送 render.update。"
          : "等待 app preview ready…"}
      </p>
    </>
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArtifactPayload(value: unknown): ArtifactPayload {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value.map((entry) => toArtifactPayload(entry));
  if (isRecordValue(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toArtifactPayload(entry),
      ]),
    );
  return null;
}

/**
 * The block library and its enable list.
 *
 * `frame.yaml` is the enable list: a block listed under `author_instruction`
 * reaches the model in the order shown, and a block that stays in the tree
 * without being listed remains fully editable but is simply not sent. Enabling
 * several blocks of the same kind is allowed on purpose — nothing here forces
 * them to be mutually exclusive.
 */
function PresetBlockLibrary({
  files,
  pending,
  onChange,
  onFeedback,
  onOpenFile,
}: {
  files: Record<string, string>;
  pending: boolean;
  onChange: (files: Record<string, string>) => void;
  onFeedback: (feedback: Feedback) => void;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const frameSource = files["frame.yaml"] ?? "";
  const enabled = useMemo(() => readEnabledBlocks(frameSource), [frameSource]);
  const library = Object.keys(files)
    .filter((path) => path.startsWith("blocks/") && path.endsWith(".md"))
    .sort();
  const unlisted = library.filter((path) => !enabled.includes(path));
  const missing = enabled.filter((path) => files[path] === undefined);

  function writeEnabled(next: string[]): void {
    try {
      onChange({
        ...files,
        "frame.yaml": writeEnabledBlocks(frameSource, next),
      });
    } catch (error: unknown) {
      onFeedback({
        kind: "error",
        text:
          error instanceof Error
            ? `frame.yaml 无法更新：${error.message}`
            : "frame.yaml 无法更新。",
      });
    }
  }

  return (
    <section
      id="play-preset-panel-blocks"
      className="play-preset-block-workspace"
      role="tabpanel"
      aria-labelledby="play-preset-tab-blocks play-preset-blocks-title"
    >
      <header className="play-preset-workspace-heading">
        <div>
          <p className="play-preset-section-kicker">BLOCK LIBRARY</p>
          <h4 id="play-preset-blocks-title">提示块</h4>
        </div>
        <p>
          勾选的块按下面的顺序进入模型。取消勾选只是不再发送它，文件仍然留在预设里可以继续编辑，也会随导出一起带走。
        </p>
      </header>

      {missing.length > 0 && (
        <p role="alert">frame.yaml 引用了不存在的块：{missing.join("、")}</p>
      )}

      <ol className="play-preset-block-enabled" aria-label="已启用的提示块">
        {enabled.map((path, index) => (
          <li key={path}>
            <label>
              <input
                type="checkbox"
                checked
                disabled={pending}
                aria-label={`停用 ${path}`}
                onChange={() =>
                  writeEnabled(enabled.filter((entry) => entry !== path))
                }
              />
              <span>{path}</span>
            </label>
            <span className="play-preset-block-actions">
              <button
                type="button"
                disabled={pending || index === 0}
                aria-label={`上移 ${path}`}
                onClick={() => writeEnabled(moveBlock(enabled, index, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={pending || index === enabled.length - 1}
                aria-label={`下移 ${path}`}
                onClick={() => writeEnabled(moveBlock(enabled, index, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => onOpenFile(path)}
              >
                编辑
              </button>
            </span>
          </li>
        ))}
        {enabled.length === 0 && <li>当前没有启用任何提示块。</li>}
      </ol>

      <h5>未启用</h5>
      <ul className="play-preset-block-unlisted" aria-label="未启用的提示块">
        {unlisted.map((path) => (
          <li key={path}>
            <label>
              <input
                type="checkbox"
                checked={false}
                disabled={pending}
                aria-label={`启用 ${path}`}
                onChange={() => writeEnabled([...enabled, path])}
              />
              <span>{path}</span>
            </label>
            <button
              type="button"
              disabled={pending}
              onClick={() => onOpenFile(path)}
            >
              编辑
            </button>
          </li>
        ))}
        {unlisted.length === 0 && <li>块库里的每一块都已启用。</li>}
      </ul>
    </section>
  );
}

function moveBlock(paths: string[], index: number, delta: number): string[] {
  const next = [...paths];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Author blocks listed under `roles.author_instruction`, in frame order. */
function readEnabledBlocks(frameSource: string): string[] {
  try {
    const frame = parseYaml(frameSource) as {
      roles?: { author_instruction?: unknown };
    } | null;
    const entries = frame?.roles?.author_instruction;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? (entry as { markdown?: unknown }).markdown
          : undefined,
      )
      .filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

/**
 * Rewrite only the markdown entries, keeping every other frame entry — the
 * Runtime builtins and the `world.instructions` include — exactly where the
 * author put it.
 */
function writeEnabledBlocks(frameSource: string, blocks: string[]): string {
  const document = parseDocument(frameSource);
  const entries = document.getIn(["roles", "author_instruction"], true);
  if (!isYamlSeq(entries))
    throw new Error("roles.author_instruction 必须是数组");
  const preserved = entries.items.filter(
    (item) => !isMarkdownEntry(document, item),
  );
  const rebuilt = [
    ...blocks.map((markdown) => ({ markdown })),
    ...preserved.map((item) => (item as { toJSON: () => unknown }).toJSON()),
  ];
  document.setIn(["roles", "author_instruction"], rebuilt);
  return String(document);
}

function isMarkdownEntry(document: unknown, item: unknown): boolean {
  void document;
  const value = (item as { toJSON?: () => unknown }).toJSON?.();
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { markdown?: unknown }).markdown === "string"
  );
}

function isYamlSeq(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  );
}
