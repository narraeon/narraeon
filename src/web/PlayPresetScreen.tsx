import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

type PlayPresetArtifactStrategy =
  "append" | "replace" | "upsert" | "transient" | "hidden";

type PlayPresetArtifactInvalidation =
  | "new_operation"
  | "head_change"
  | "operation_end"
  | "explicit_clear"
  | "never";

interface PlayPresetArtifactDefinition {
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

interface PlayPresetFollowupDefinition {
  id: string;
  displayName: string;
  prompt: PlayPresetPromptRef;
  artifacts: PlayPresetArtifactDefinition[];
  maxArtifactBytes: number;
}

interface PlayPresetPlayerViewPanelGroup {
  id: string;
  label: string;
  itemIds: string[];
}

interface PlayPresetPlayerViewPanel {
  id: string;
  source: {
    kind: "player_view";
    view: string;
    itemIds?: string[];
  };
  channel: string;
  key: string;
  mount: PlayPresetMount["mount"];
  renderer?: string;
  rendererRevision?: string;
  rendererMode: "document" | "app";
  regex?: string;
  scripts?: string[];
  assets?: string[];
  config: {
    title?: string;
    layout: "stack" | "grid";
    theme: string;
    empty: "hide" | "message" | "show";
    emptyMessage: string;
    groups: PlayPresetPlayerViewPanelGroup[];
  };
}

interface PlayPresetStructuredEditor {
  name: string;
  callChainPath: string;
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

type PlayPresetWorkspaceView =
  "call_chain" | "extensions" | "blocks" | "files" | "preview";

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
    label: "提示内容",
    description: "阅读、编辑并排序主持规则块",
  },
  {
    id: "files",
    label: "高级文件",
    description: "带用途说明的完整源文件",
  },
  {
    id: "preview",
    label: "产物预览",
    description: "冻结 contract 与 renderer 的真实预览",
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
      editable === null ? "" : preferredPresetFilePath(editable.files),
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
    setFilePath(preferredPresetFilePath(editable.files));
    setWorkbench(null);
    setStructuredError(null);
    setFeedback(null);
    setWorkspaceView("call_chain");
  }

  function resetDraft(): void {
    if (saved === undefined) return;
    const editable = toEditablePreset(saved);
    setDraft(editable);
    setFilePath(preferredPresetFilePath(editable.files));
    setStructuredError(null);
    setFeedback({ kind: "status", text: "已撤销当前未保存修改。" });
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
            <section
              className="play-preset-library-actions"
              aria-label="新建与导入玩法预设"
            >
              <h4>新建或导入</h4>
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
                    setFeedback({
                      kind: "status",
                      text: "已新建普通玩法预设。",
                    });
                  })
                }
              >
                新建空白预设
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
            </section>
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

              <details className="play-preset-operations">
                <summary>预设操作</summary>
                <div
                  className="play-preset-management"
                  aria-label="玩法预设身份管理"
                >
                  <p>
                    这些操作只管理这份本地预设；内容编辑和保存仍在页面底部完成。
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
                    复制为新预设
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
              </details>

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

              {draft.structure === undefined ||
              (workspaceView !== "call_chain" &&
                workspaceView !== "extensions") ? null : (
                <PlayPresetStructuredEditorPanel
                  view={workspaceView}
                  structure={draft.structure}
                  files={draft.files}
                  workbench={visibleWorkbench}
                  workbenchPending={visibleWorkbenchPending}
                  structuredError={structuredError}
                  onChange={updateStructure}
                  onFileChange={updateFileAtPath}
                  onCreateFile={(path, contents) =>
                    updateFiles((files) => ({ ...files, [path]: contents }))
                  }
                  onError={setStructuredError}
                />
              )}
              {workspaceView === "blocks" && (
                <PresetBlockLibrary
                  files={draft.files}
                  pending={pending}
                  onChange={(files) =>
                    updateFiles(() => structuredClone(files))
                  }
                  onFeedback={setFeedback}
                />
              )}
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
                        text: "该玩法文件路径已经存在。",
                      });
                      return;
                    }
                    updateFiles((files) => ({ ...files, [path]: "" }));
                    setFilePath(path);
                    setNewFilePath("");
                    setFeedback({
                      kind: "status",
                      text: "已加入普通文件草稿；保存时会通过 codec 校验。",
                    });
                  }}
                />
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
                    当前草稿无法生成结构投影。请到“高级文件”修复 preset.yaml 或
                    call-chain.yaml，保存后再回来。
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setWorkspaceView("files")}
                  >
                    前往高级文件
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
                      <h4>预览当前预设</h4>
                    </div>
                    <p>
                      产物外观与真实调用链提示词都留在这里检查，不会调用模型或离开当前预设。
                    </p>
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
                  <section
                    className="play-preset-prompt-preview"
                    aria-label="当前预设的真实提示词预览"
                  >
                    <h3>真实调用链预览</h3>
                    {dirty ? (
                      <p className="field-note">
                        请先保存当前修改；真实预览只编译已冻结的有效 revision。
                      </p>
                    ) : draft.validation.status !== "valid" ? (
                      <p className="field-note">
                        当前 revision 需要修复，暂时不能编译真实调用链。
                      </p>
                    ) : renderPromptPreview === undefined ? (
                      <p className="field-note">
                        当前宿主没有提供提示词预览面板。
                      </p>
                    ) : (
                      renderPromptPreview({
                        presetId: draft.id,
                        revision: draft.revision,
                      })
                    )}
                  </section>
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
                    保存修改
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
  files: Record<string, string>;
  workbench: PlayPresetWorkbenchSnapshot | null;
  workbenchPending: boolean;
  structuredError: string | null;
  onChange: (
    update: (
      structure: PlayPresetStructuredEditor,
    ) => PlayPresetStructuredEditor,
  ) => void;
  onFileChange: (path: string, contents: string) => void;
  onCreateFile: (path: string, contents: string) => void;
  onError: (message: string | null) => void;
}

function PlayPresetStructuredEditorPanel({
  view,
  structure,
  files,
  workbench,
  workbenchPending,
  structuredError,
  onChange,
  onFileChange,
  onCreateFile,
  onError,
}: PlayPresetStructuredEditorPanelProps): React.JSX.Element {
  void onError;
  const promptPaths = promptFilePaths(files);
  const artifactOutputs = structure.followups.flatMap(
    (followup, followupIndex) =>
      followup.artifacts.map((artifact, artifactIndex) => ({
        followup,
        followupIndex,
        artifact,
        artifactIndex,
      })),
  );
  const artifactChannels = new Set(
    artifactOutputs.map(({ artifact }) => artifact.channel),
  );
  const unmatchedMounts = structure.mounts.filter(
    ({ channel }) => !artifactChannels.has(channel),
  );

  function addNarrativePrompt(): void {
    const path = uniquePresetPath(
      files,
      `prompts/narrative-${structure.narrativePrompts.length + 1}.md`,
    );
    onCreateFile(
      path,
      "# 叙事规则\n\n说明 AI 每次写玩家可见正文时都应遵守的规则。\n",
    );
    onChange((current) => ({
      ...current,
      narrativePrompts: [
        ...current.narrativePrompts,
        { role: "author_instruction", path },
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
    const path = uniquePresetPath(files, `prompts/${id}.md`);
    const artifactName = `${id}_output`;
    const channel = `${id}.output`;
    onCreateFile(
      path,
      "# 新后置请求\n\n说明主调用链完成后，需要额外整理成什么界面内容。\n",
    );
    onChange((current) => ({
      ...current,
      mounts: [...current.mounts, { channel, mount: "story" }],
      followups: [
        ...current.followups,
        {
          id,
          displayName: "新后置请求",
          prompt: { role: "author_instruction", path },
          artifacts: [defaultArtifact(artifactName, channel)],
          maxArtifactBytes: 32_768,
        },
      ],
    }));
  }

  function updateFollowup(
    followupIndex: number,
    update: (
      followup: PlayPresetFollowupDefinition,
    ) => PlayPresetFollowupDefinition,
  ): void {
    onChange((current) => ({
      ...current,
      followups: current.followups.map((followup, index) =>
        index === followupIndex ? update(followup) : followup,
      ),
    }));
  }

  function updateArtifact(
    followupIndex: number,
    artifactIndex: number,
    update: (
      artifact: PlayPresetArtifactDefinition,
    ) => PlayPresetArtifactDefinition,
  ): void {
    onChange((current) => {
      const followup = current.followups[followupIndex];
      const artifact = followup?.artifacts[artifactIndex];
      if (followup === undefined || artifact === undefined) return current;
      const nextArtifact = update(artifact);
      return {
        ...current,
        mounts:
          nextArtifact.channel === artifact.channel
            ? current.mounts
            : current.mounts.map((mount) =>
                mount.channel === artifact.channel
                  ? { ...mount, channel: nextArtifact.channel }
                  : mount,
              ),
        followups: current.followups.map((entry, index) =>
          index === followupIndex
            ? {
                ...entry,
                artifacts: entry.artifacts.map((candidate, index) =>
                  index === artifactIndex ? nextArtifact : candidate,
                ),
              }
            : entry,
        ),
      };
    });
  }

  function setChannelMount(
    channel: string,
    mount: PlayPresetMount["mount"] | "",
  ): void {
    onChange((current) => ({
      ...current,
      mounts: [
        ...current.mounts.filter((entry) => entry.channel !== channel),
        ...(mount === "" ? [] : [{ channel, mount }]),
      ],
    }));
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
            ? "先编辑 AI 主响应要遵守的文字规则，再按需添加主响应结束后的界面产物。提示内容直接显示，不需要填写文件路径。"
            : "选择产物显示在哪里，并用普通表单配置玩家视图和扩展文件；无需手写 JSON。"}
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
          <div className="play-preset-concept-note">
            <strong>频道是什么？</strong>
            <p>
              频道只是“产物送到哪里”的内部连线：后置请求产出内容，页面按同名频道把它放到你选择的位置。普通编辑只需选显示位置，技术地址会自动保留。
            </p>
          </div>

          <div className="play-preset-structured-section">
            <div className="play-preset-section-header">
              <div>
                <h4>产物显示位置</h4>
                <p>每项都来自“调用链”中的一个真实产物输出。</p>
              </div>
            </div>
            {artifactOutputs.length === 0 ? (
              <p className="play-preset-empty-copy">
                当前没有后置产物。先在“调用链”新增后置请求，这里才会出现可放置的内容。
              </p>
            ) : (
              <div className="play-preset-placement-list">
                {artifactOutputs.map(({ followup, artifact }) => (
                  <article
                    className="play-preset-placement-card"
                    key={`${followup.id}:${artifact.name}`}
                  >
                    <div>
                      <strong>{artifact.name}</strong>
                      <span>{followup.displayName}</span>
                      <code>{artifact.channel}</code>
                    </div>
                    <label>
                      显示位置
                      <MountSelect
                        ariaLabel={`${artifact.name} 显示位置`}
                        value={
                          structure.mounts.find(
                            ({ channel }) => channel === artifact.channel,
                          )?.mount ?? ""
                        }
                        allowNone
                        onChange={(mount) =>
                          setChannelMount(artifact.channel, mount)
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>
            )}
            {unmatchedMounts.length === 0 ? null : (
              <details className="play-preset-advanced-card">
                <summary>未连接到当前产物的旧频道</summary>
                {unmatchedMounts.map((mount) => (
                  <div
                    className="play-preset-inline-editor"
                    key={mount.channel}
                  >
                    <code>{mount.channel}</code>
                    <MountSelect
                      ariaLabel={`${mount.channel} 显示位置`}
                      value={mount.mount}
                      allowNone
                      onChange={(next) => setChannelMount(mount.channel, next)}
                    />
                  </div>
                ))}
              </details>
            )}
          </div>

          <PlayerViewPanelsEditor
            panels={structure.playerViewPanels}
            files={files}
            onChange={(playerViewPanels) =>
              onChange((current) => ({ ...current, playerViewPanels }))
            }
          />

          <div className="play-preset-structured-section">
            <h4>随预设加载的界面文件</h4>
            <p>
              勾选
              renderer、脚本和样式等前端资源。这里只选择已有文件，不需要写数组格式。
            </p>
            <PathChecklist
              ariaLabel="界面扩展文件"
              paths={extensionAssetPaths(files)}
              selected={structure.extensionRefs}
              emptyText="当前还没有 renderer、脚本或样式文件。"
              onChange={(extensionRefs) =>
                onChange((current) => ({ ...current, extensionRefs }))
              }
            />
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
            这些文字和主持规则一起进入稳定
            bootstrap，约束调用链中的玩家可见正文。下方直接显示真实内容。
          </p>
          {structure.narrativePrompts.length === 0 ? (
            <p>尚未声明叙事提示块；通用文风仍由主持块提供。</p>
          ) : null}
          <ol aria-label="叙事提示块">
            {structure.narrativePrompts.map((prompt, index) => (
              <li key={`narrative-${index}`}>
                <PromptReferenceEditor
                  label={`叙事规则 ${index + 1}`}
                  path={prompt.path}
                  paths={promptPaths}
                  files={files}
                  onPathChange={(path) =>
                    onChange((current) => ({
                      ...current,
                      narrativePrompts: current.narrativePrompts.map(
                        (entry, entryIndex) =>
                          entryIndex === index ? { ...entry, path } : entry,
                      ),
                    }))
                  }
                  onContentsChange={(contents) =>
                    onFileChange(prompt.path, contents)
                  }
                />
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
            看不见对方，也不会进入之后的模型上下文。请求提示、产物格式和显示位置都可在当前页面编辑。
          </p>
          {structure.followups.length === 0 ? (
            <p>没有后置请求；主调用链完成后不会再派发额外请求。</p>
          ) : null}
          <ol aria-label="后置请求">
            {structure.followups.map((followup, index) => (
              <li
                className="play-preset-followup-card"
                key={`followup-${followup.id}-${index}`}
              >
                <label>
                  显示名
                  <input
                    aria-label={`后置请求 ${index + 1} 显示名`}
                    value={followup.displayName}
                    onChange={(event) => {
                      const displayName = event.currentTarget.value;
                      updateFollowup(index, (current) => ({
                        ...current,
                        displayName,
                      }));
                    }}
                  />
                </label>
                <PromptReferenceEditor
                  label="这次额外请求要做什么"
                  path={followup.prompt.path}
                  paths={promptPaths}
                  files={files}
                  onPathChange={(path) =>
                    updateFollowup(index, (current) => ({
                      ...current,
                      prompt: { ...current.prompt, path },
                    }))
                  }
                  onContentsChange={(contents) =>
                    onFileChange(followup.prompt.path, contents)
                  }
                />
                <div className="play-preset-section-header">
                  <div>
                    <h5>输出到界面的产物</h5>
                    <p>产物不是世界事实；它只是这次额外请求生成的界面内容。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const name = uniqueArtifactName(followup.artifacts);
                      const channel = `${followup.id}.${name}`;
                      onChange((current) => ({
                        ...current,
                        mounts: [
                          ...current.mounts,
                          { channel, mount: "story" },
                        ],
                        followups: current.followups.map((entry, entryIndex) =>
                          entryIndex === index
                            ? {
                                ...entry,
                                artifacts: [
                                  ...entry.artifacts,
                                  defaultArtifact(name, channel),
                                ],
                              }
                            : entry,
                        ),
                      }));
                    }}
                  >
                    新增产物
                  </button>
                </div>
                {followup.artifacts.length === 0 ? (
                  <p role="alert">
                    后置请求至少需要一项产物才能保存为有效预设。
                  </p>
                ) : (
                  <ol className="play-preset-artifact-editor-list">
                    {followup.artifacts.map((artifact, artifactIndex) => (
                      <li key={`${artifact.name}-${artifactIndex}`}>
                        <ArtifactDefinitionEditor
                          artifact={artifact}
                          files={files}
                          mount={
                            structure.mounts.find(
                              ({ channel }) => channel === artifact.channel,
                            )?.mount
                          }
                          onChange={(update) =>
                            updateArtifact(index, artifactIndex, update)
                          }
                          onRemove={() =>
                            onChange((current) => {
                              const removing =
                                current.followups[index]?.artifacts[
                                  artifactIndex
                                ];
                              if (removing === undefined) return current;
                              const followups = current.followups.map(
                                (entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        artifacts: entry.artifacts.filter(
                                          (_, candidateIndex) =>
                                            candidateIndex !== artifactIndex,
                                        ),
                                      }
                                    : entry,
                              );
                              const channelStillUsed = followups.some((entry) =>
                                entry.artifacts.some(
                                  ({ channel }) => channel === removing.channel,
                                ),
                              );
                              return {
                                ...current,
                                followups,
                                mounts: channelStillUsed
                                  ? current.mounts
                                  : current.mounts.filter(
                                      ({ channel }) =>
                                        channel !== removing.channel,
                                    ),
                              };
                            })
                          }
                        />
                      </li>
                    ))}
                  </ol>
                )}
                <details className="play-preset-advanced-card">
                  <summary>高级请求设置</summary>
                  <div className="play-preset-form-grid">
                    <label>
                      稳定标识
                      <input
                        aria-label={`后置请求 ${index + 1} 标识`}
                        value={followup.id}
                        onChange={(event) => {
                          const id = event.currentTarget.value;
                          updateFollowup(index, (current) => ({
                            ...current,
                            id,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      本次所有产物合计上限（bytes）
                      <input
                        type="number"
                        min={1}
                        max={1_048_576}
                        value={followup.maxArtifactBytes}
                        onChange={(event) => {
                          const maxArtifactBytes = Number(
                            event.currentTarget.value,
                          );
                          updateFollowup(index, (current) => ({
                            ...current,
                            maxArtifactBytes,
                          }));
                        }}
                      />
                    </label>
                  </div>
                </details>
                <button
                  type="button"
                  aria-label={`删除后置请求 ${followup.id}`}
                  onClick={() =>
                    onChange((current) => {
                      const removingChannels = new Set(
                        current.followups[index]?.artifacts.map(
                          ({ channel }) => channel,
                        ) ?? [],
                      );
                      const followups = current.followups.filter(
                        (_, entryIndex) => entryIndex !== index,
                      );
                      const channelsStillUsed = new Set(
                        followups.flatMap(({ artifacts }) =>
                          artifacts.map(({ channel }) => channel),
                        ),
                      );
                      return {
                        ...current,
                        followups,
                        mounts: current.mounts.filter(
                          ({ channel }) =>
                            !removingChannels.has(channel) ||
                            channelsStillUsed.has(channel),
                        ),
                      };
                    })
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

const mountChoices: {
  value: PlayPresetMount["mount"];
  label: string;
  description: string;
}[] = [
  { value: "story", label: "剧情内容区", description: "跟随剧情正文显示" },
  { value: "sidebar", label: "右侧栏", description: "适合持续状态面板" },
  {
    value: "composer_above",
    label: "输入框上方",
    description: "适合行动建议或临时提示",
  },
  {
    value: "composer_below",
    label: "输入框下方",
    description: "适合不打断输入的辅助内容",
  },
  { value: "overlay", label: "浮层", description: "覆盖在游玩页面上方" },
  { value: "debug", label: "调试区", description: "只用于检查原始产物" },
];

function MountSelect({
  ariaLabel,
  value,
  allowNone = false,
  onChange,
}: {
  ariaLabel: string;
  value: PlayPresetMount["mount"] | "";
  allowNone?: boolean;
  onChange: (value: PlayPresetMount["mount"] | "") => void;
}): React.JSX.Element {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) =>
        onChange(event.currentTarget.value as PlayPresetMount["mount"] | "")
      }
    >
      {allowNone ? <option value="">不在页面显示</option> : null}
      {mountChoices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label} — {choice.description}
        </option>
      ))}
    </select>
  );
}

function PromptReferenceEditor({
  label,
  path,
  paths,
  files,
  onPathChange,
  onContentsChange,
}: {
  label: string;
  path: string;
  paths: string[];
  files: Record<string, string>;
  onPathChange: (path: string) => void;
  onContentsChange: (contents: string) => void;
}): React.JSX.Element {
  const available = [...new Set([...paths, path])].sort();
  const contents = files[path];
  return (
    <article className="play-preset-prompt-card">
      <header>
        <div>
          <strong>{label}</strong>
          <span>{markdownTitle(contents ?? "")}</span>
        </div>
        <label>
          使用哪份内容
          <select
            aria-label={`${label} 内容`}
            value={path}
            onChange={(event) => onPathChange(event.currentTarget.value)}
          >
            {available.map((candidate) => (
              <option key={candidate} value={candidate}>
                {markdownTitle(files[candidate] ?? "") || candidate}
              </option>
            ))}
          </select>
        </label>
      </header>
      <code>{path}</code>
      {contents === undefined ? (
        <p role="alert">这份提示文件不存在；请改选已有内容或到高级文件修复。</p>
      ) : (
        <textarea
          aria-label={`编辑提示内容 ${path}`}
          value={contents}
          onChange={(event) => onContentsChange(event.currentTarget.value)}
          spellCheck={false}
        />
      )}
    </article>
  );
}

function PathChecklist({
  ariaLabel,
  paths,
  selected,
  emptyText,
  onChange,
}: {
  ariaLabel: string;
  paths: string[];
  selected: string[];
  emptyText: string;
  onChange: (paths: string[]) => void;
}): React.JSX.Element {
  const available = [...new Set([...paths, ...selected])].sort();
  if (available.length === 0)
    return <p className="play-preset-empty-copy">{emptyText}</p>;
  return (
    <ul className="play-preset-path-checklist" aria-label={ariaLabel}>
      {available.map((path) => (
        <li key={path}>
          <label>
            <input
              type="checkbox"
              checked={selected.includes(path)}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...new Set([...selected, path])].sort()
                    : selected.filter((candidate) => candidate !== path),
                )
              }
            />
            <span>{describePresetFile(path, "").title}</span>
            <code>{path}</code>
          </label>
        </li>
      ))}
    </ul>
  );
}

function ArtifactDefinitionEditor({
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
            {mount === undefined ? " 不在页面显示" : ` ${mountLabel(mount)}`}
          </span>
        </div>
        <button type="button" className="danger-button" onClick={onRemove}>
          删除产物
        </button>
      </header>
      <div className="play-preset-form-grid">
        <label>
          产物标识
          <input
            aria-label={`${artifact.name} 产物标识`}
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
          内容格式
          <select
            aria-label={`${artifact.name} 内容格式`}
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
            <option value="text/markdown">Markdown 文本</option>
            <option value="text/plain">纯文本</option>
            <option value="application/json">结构化数据</option>
            <option value="text/html">HTML</option>
          </select>
        </label>
        <label>
          同频道已有内容时
          <select
            aria-label={`${artifact.name} 更新方式`}
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
            <option value="replace">替换上一份</option>
            <option value="append">追加一份</option>
            <option value="upsert">按 key 更新</option>
            <option value="transient">仅短暂显示</option>
            <option value="hidden">保存但不显示</option>
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
          AI 必须生成这项产物
        </label>
      </div>
      <details className="play-preset-advanced-card">
        <summary>高级产物设置</summary>
        <div className="play-preset-form-grid">
          <label>
            技术频道地址
            <input
              aria-label={`${artifact.name} 技术频道`}
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
              更新 key
              <input
                value={artifact.key ?? ""}
                onChange={(event) =>
                  setOptional("key", event.currentTarget.value)
                }
              />
            </label>
          ) : null}
          <label>
            保存到
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
              <option value="commit">随权威提交保留</option>
              <option value="operation">只保留到本次操作结束</option>
              <option value="none">不持久保存</option>
            </select>
          </label>
          <label>
            何时失效
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
              <option value="new_operation">下一次操作开始</option>
              <option value="head_change">世界端点变化</option>
              <option value="operation_end">本次操作结束</option>
              <option value="explicit_clear">显式清除</option>
              <option value="never">永不自动失效</option>
            </select>
          </label>
          <label>
            单次最多输出次数
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
            界面模板
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
              <option value="">使用内置显示</option>
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
                模板 revision
                <input
                  value={artifact.rendererRevision ?? ""}
                  onChange={(event) =>
                    setOptional("rendererRevision", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                模板模式
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
                  <option value="document">静态文档</option>
                  <option value="app">可交互 app</option>
                </select>
              </label>
            </>
          )}
          <label>
            正则处理规则
            <select
              value={artifact.regex ?? ""}
              onChange={(event) =>
                setOptional("regex", event.currentTarget.value)
              }
            >
              <option value="">不使用</option>
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
            <h6>脚本</h6>
            <PathChecklist
              ariaLabel={`${artifact.name} 脚本`}
              paths={scriptPaths}
              selected={artifact.scripts ?? []}
              emptyText="没有脚本文件。"
              onChange={(paths) => setPaths("scripts", paths)}
            />
          </div>
          <div>
            <h6>样式与资源</h6>
            <PathChecklist
              ariaLabel={`${artifact.name} 资源`}
              paths={assetPaths}
              selected={artifact.assets ?? []}
              emptyText="没有资源文件。"
              onChange={(paths) => setPaths("assets", paths)}
            />
          </div>
        </div>
        {artifact.payloadContract === undefined ? null : (
          <details>
            <summary>当前严格数据格式（只读）</summary>
            <p className="field-note">
              常用设置无需改它；需要重写完整 contract 时再到高级文件编辑
              call-chain.yaml。
            </p>
            <pre>{JSON.stringify(artifact.payloadContract, null, 2)}</pre>
          </details>
        )}
      </details>
    </article>
  );
}

function defaultArtifact(
  name: string,
  channel: string,
): PlayPresetArtifactDefinition {
  return {
    name,
    channel,
    strategy: "replace",
    contentType: "text/markdown",
    save: "commit",
    invalidation: "new_operation",
    required: false,
    maxEmits: 1,
  };
}

function uniqueArtifactName(artifacts: PlayPresetArtifactDefinition[]): string {
  const used = new Set(artifacts.map(({ name }) => name));
  let suffix = artifacts.length + 1;
  let name = `output_${suffix}`;
  while (used.has(name)) name = `output_${++suffix}`;
  return name;
}

function mountLabel(mount: PlayPresetMount["mount"]): string {
  return mountChoices.find(({ value }) => value === mount)?.label ?? mount;
}

function contentTypeLabel(
  contentType: PlayPresetArtifactDefinition["contentType"],
): string {
  return (
    {
      "text/plain": "纯文本",
      "text/markdown": "Markdown",
      "application/json": "结构化数据",
      "text/html": "HTML",
    } as const
  )[contentType];
}

function withCurrentPath(paths: string[], current?: string): string[] {
  return [
    ...new Set([...paths, ...(current === undefined ? [] : [current])]),
  ].sort();
}

function promptFilePaths(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((path) => path.endsWith(".md") && !path.startsWith("blocks/"))
    .sort();
}

function extensionAssetPaths(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter(
      (path) =>
        path.startsWith("renderers/") ||
        path.startsWith("scripts/") ||
        path.startsWith("assets/") ||
        path.startsWith("regex/"),
    )
    .sort();
}

function uniquePresetPath(
  files: Record<string, string>,
  preferred: string,
): string {
  if (files[preferred] === undefined) return preferred;
  const dot = preferred.lastIndexOf(".");
  const base = dot < 0 ? preferred : preferred.slice(0, dot);
  const extension = dot < 0 ? "" : preferred.slice(dot);
  let suffix = 2;
  while (files[`${base}-${suffix}${extension}`] !== undefined) suffix += 1;
  return `${base}-${suffix}${extension}`;
}

function markdownTitle(contents: string): string {
  return /^#\s+(.+)$/mu.exec(contents)?.[1]?.trim() ?? "未命名提示内容";
}

function markdownExcerpt(contents: string): string {
  const excerpt = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join(" ");
  return excerpt.length > 88 ? `${excerpt.slice(0, 88)}…` : excerpt;
}

function PlayerViewPanelsEditor({
  panels,
  files,
  onChange,
}: {
  panels: PlayPresetPlayerViewPanel[];
  files: Record<string, string>;
  onChange: (panels: PlayPresetPlayerViewPanel[]) => void;
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

  function updatePanel(
    index: number,
    update: (panel: PlayPresetPlayerViewPanel) => PlayPresetPlayerViewPanel,
  ): void {
    onChange(
      panels.map((panel, candidateIndex) =>
        candidateIndex === index ? update(panel) : panel,
      ),
    );
  }

  function addPanel(): void {
    const used = new Set(panels.map(({ id }) => id));
    let suffix = panels.length + 1;
    let id = `panel_${suffix}`;
    while (used.has(id)) id = `panel_${++suffix}`;
    onChange([
      ...panels,
      {
        id,
        source: { kind: "player_view", view: "status" },
        channel: `player.view.${id}`,
        key: "current",
        mount: "sidebar",
        rendererMode: "document",
        config: {
          title: "玩家状态",
          layout: "stack",
          theme: "default",
          empty: "message",
          emptyMessage: "当前没有可显示内容。",
          groups: [],
        },
      },
    ]);
  }

  return (
    <div className="play-preset-structured-section">
      <div className="play-preset-section-header">
        <div>
          <h4>玩家视图面板</h4>
          <p>
            把世界控制里已经定义好的玩家视图，持续显示在游玩页面。它不调用模型，也不改世界。
          </p>
        </div>
        <button type="button" onClick={addPanel}>
          新增玩家视图面板
        </button>
      </div>
      {panels.length === 0 ? (
        <p className="play-preset-empty-copy">当前没有玩家视图面板。</p>
      ) : (
        <ol className="play-preset-panel-editor-list" aria-label="玩家视图面板">
          {panels.map((panel, index) => (
            <li key={`${panel.id}-${index}`}>
              <article className="play-preset-player-panel-card">
                <header>
                  <div>
                    <strong>{panel.config.title ?? panel.id}</strong>
                    <span>
                      玩家视图 {panel.source.view} · {mountLabel(panel.mount)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() =>
                      onChange(
                        panels.filter(
                          (_, candidateIndex) => candidateIndex !== index,
                        ),
                      )
                    }
                  >
                    删除面板
                  </button>
                </header>
                <div className="play-preset-form-grid">
                  <label>
                    面板标题
                    <input
                      aria-label={`玩家视图面板 ${index + 1} 标题`}
                      value={panel.config.title ?? ""}
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        updatePanel(index, (current) => {
                          const config = { ...current.config };
                          if (title === "") delete config.title;
                          else config.title = title;
                          return { ...current, config };
                        });
                      }}
                    />
                  </label>
                  <label>
                    读取哪个玩家视图
                    <input
                      aria-label={`玩家视图面板 ${index + 1} 视图`}
                      value={panel.source.view}
                      onChange={(event) => {
                        const view = event.currentTarget.value;
                        updatePanel(index, (current) => ({
                          ...current,
                          source: {
                            ...current.source,
                            view,
                          },
                        }));
                      }}
                    />
                  </label>
                  <label>
                    显示位置
                    <MountSelect
                      ariaLabel={`玩家视图面板 ${index + 1} 显示位置`}
                      value={panel.mount}
                      onChange={(mount) => {
                        if (mount !== "")
                          updatePanel(index, (current) => ({
                            ...current,
                            mount,
                          }));
                      }}
                    />
                  </label>
                  <label>
                    排列方式
                    <select
                      value={panel.config.layout}
                      onChange={(event) => {
                        const layout = event.currentTarget.value as
                          "stack" | "grid";
                        updatePanel(index, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            layout,
                          },
                        }));
                      }}
                    >
                      <option value="stack">纵向排列</option>
                      <option value="grid">网格排列</option>
                    </select>
                  </label>
                  <label>
                    没有内容时
                    <select
                      value={panel.config.empty}
                      onChange={(event) => {
                        const empty = event.currentTarget.value as
                          "hide" | "message" | "show";
                        updatePanel(index, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            empty,
                          },
                        }));
                      }}
                    >
                      <option value="hide">隐藏面板</option>
                      <option value="message">显示说明</option>
                      <option value="show">显示空值</option>
                    </select>
                  </label>
                  {panel.config.empty === "hide" ? null : (
                    <label>
                      空内容说明
                      <input
                        value={panel.config.emptyMessage}
                        onChange={(event) => {
                          const emptyMessage = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            config: {
                              ...current.config,
                              emptyMessage,
                            },
                          }));
                        }}
                      />
                    </label>
                  )}
                </div>
                <details className="play-preset-advanced-card">
                  <summary>高级面板设置</summary>
                  <div className="play-preset-form-grid">
                    <label>
                      面板稳定标识
                      <input
                        value={panel.id}
                        onChange={(event) => {
                          const id = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            id,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      技术频道
                      <input
                        value={panel.channel}
                        onChange={(event) => {
                          const channel = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            channel,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      更新 key
                      <input
                        value={panel.key}
                        onChange={(event) => {
                          const key = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            key,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      主题标识
                      <input
                        value={panel.config.theme}
                        onChange={(event) => {
                          const theme = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            config: {
                              ...current.config,
                              theme,
                            },
                          }));
                        }}
                      />
                    </label>
                    <label>
                      只显示这些项目（每行一个，可留空）
                      <textarea
                        value={(panel.source.itemIds ?? []).join("\n")}
                        onChange={(event) => {
                          const itemIds = splitLines(event.currentTarget.value);
                          updatePanel(index, (current) => {
                            const source = { ...current.source };
                            if (itemIds.length === 0) delete source.itemIds;
                            else source.itemIds = itemIds;
                            return { ...current, source };
                          });
                        }}
                      />
                    </label>
                    <label>
                      界面模板
                      <select
                        value={panel.renderer ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (value === "") {
                              delete next.renderer;
                              delete next.rendererRevision;
                              next.rendererMode = "document";
                            } else {
                              next.renderer = value;
                              next.rendererRevision ??= "v1";
                              next.rendererMode = "app";
                            }
                            return next;
                          });
                        }}
                      >
                        <option value="">使用内置显示</option>
                        {withCurrentPath(rendererPaths, panel.renderer).map(
                          (path) => (
                            <option key={path} value={path}>
                              {path}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    {panel.renderer === undefined ? null : (
                      <>
                        <label>
                          模板 revision
                          <input
                            value={panel.rendererRevision ?? ""}
                            onChange={(event) => {
                              const rendererRevision =
                                event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                rendererRevision,
                              }));
                            }}
                          />
                        </label>
                        <label>
                          模板模式
                          <select
                            value={panel.rendererMode}
                            onChange={(event) => {
                              const rendererMode = event.currentTarget.value as
                                "document" | "app";
                              updatePanel(index, (current) => ({
                                ...current,
                                rendererMode,
                              }));
                            }}
                          >
                            <option value="document">静态文档</option>
                            <option value="app">可交互 app</option>
                          </select>
                        </label>
                      </>
                    )}
                    <label>
                      正则处理规则
                      <select
                        value={panel.regex ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (value === "") delete next.regex;
                            else next.regex = value;
                            return next;
                          });
                        }}
                      >
                        <option value="">不使用</option>
                        {withCurrentPath(regexPaths, panel.regex).map(
                          (path) => (
                            <option key={path} value={path}>
                              {path}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </div>
                  <div className="play-preset-resource-columns">
                    <div>
                      <h6>脚本</h6>
                      <PathChecklist
                        ariaLabel={`玩家视图面板 ${index + 1} 脚本`}
                        paths={scriptPaths}
                        selected={panel.scripts ?? []}
                        emptyText="没有脚本文件。"
                        onChange={(scripts) =>
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (scripts.length === 0) delete next.scripts;
                            else next.scripts = scripts;
                            return next;
                          })
                        }
                      />
                    </div>
                    <div>
                      <h6>样式与资源</h6>
                      <PathChecklist
                        ariaLabel={`玩家视图面板 ${index + 1} 资源`}
                        paths={assetPaths}
                        selected={panel.assets ?? []}
                        emptyText="没有资源文件。"
                        onChange={(assets) =>
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (assets.length === 0) delete next.assets;
                            else next.assets = assets;
                            return next;
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="play-preset-section-header">
                    <div>
                      <h6>分组</h6>
                      <p>把已选项目按组显示；每个项目 ID 单独一行。</p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        updatePanel(index, (current) => {
                          const used = new Set(
                            current.config.groups.map(({ id }) => id),
                          );
                          let suffix = current.config.groups.length + 1;
                          let id = `group_${suffix}`;
                          while (used.has(id)) id = `group_${++suffix}`;
                          return {
                            ...current,
                            config: {
                              ...current.config,
                              groups: [
                                ...current.config.groups,
                                { id, label: "新分组", itemIds: [] },
                              ],
                            },
                          };
                        })
                      }
                    >
                      新增分组
                    </button>
                  </div>
                  <ol className="play-preset-group-list">
                    {panel.config.groups.map((group, groupIndex) => (
                      <li key={`${group.id}-${groupIndex}`}>
                        <label>
                          分组标题
                          <input
                            value={group.label}
                            onChange={(event) => {
                              const label = event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            label,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <label>
                          分组标识
                          <input
                            value={group.id}
                            onChange={(event) => {
                              const id = event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            id,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <label>
                          项目 ID（每行一个）
                          <textarea
                            value={group.itemIds.join("\n")}
                            onChange={(event) => {
                              const itemIds = splitLines(
                                event.currentTarget.value,
                              );
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            itemIds,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            updatePanel(index, (current) => ({
                              ...current,
                              config: {
                                ...current.config,
                                groups: current.config.groups.filter(
                                  (_, candidateIndex) =>
                                    candidateIndex !== groupIndex,
                                ),
                              },
                            }))
                          }
                        >
                          删除分组
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
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
          <h4 id="play-preset-files-title">完整预设文件</h4>
        </div>
        <p>
          常用设置应在前面的表单完成。这里保留完整
          YAML、Markdown、HTML、脚本和样式，并说明每份文件负责什么。
        </p>
      </header>
      <div
        className="play-preset-yaml-guide"
        aria-label="三个核心 YAML 文件的用途"
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
        快速跳转文件
        <select
          aria-label="玩法预设文件"
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
        <aside aria-label="玩法预设文件列表">
          <ul>
            {paths.map((path) => {
              const info = describePresetFile(path, files[path] ?? "");
              return (
                <li key={path}>
                  <button
                    type="button"
                    className={path === selectedPath ? "selected" : ""}
                    aria-pressed={path === selectedPath}
                    aria-label={`打开玩法文件 ${path}`}
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
            <span>完整文件内容</span>
            <textarea
              aria-label={`编辑玩法文件 ${selectedPath}`}
              wrap="soft"
              value={files[selectedPath] ?? ""}
              onChange={(event) => onFileChange(event.currentTarget.value)}
              spellCheck={false}
            />
          </label>
        </section>
      </div>
      <details className="play-preset-file-create">
        <summary>新增高级文件</summary>
        <div className="play-preset-file-add">
          <label>
            新文件路径（prompt/regex/renderer/script/asset）
            <input
              aria-label="新增玩法文件路径"
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
            加入文件草稿
          </button>
        </div>
      </details>
    </section>
  );
}

interface PresetFileDescription {
  path: string;
  title: string;
  kind: string;
  description: string;
}

function describePresetFile(
  path: string,
  contents: string,
): PresetFileDescription {
  if (path === "preset.yaml")
    return {
      path,
      title: "预设入口",
      kind: "核心 YAML",
      description:
        "连接调用链、界面显示位置、玩家视图面板和扩展资源；它回答“这份玩法由哪些部分组成”。",
    };
  if (path === "call-chain.yaml")
    return {
      path,
      title: "调用链与产物",
      kind: "核心 YAML",
      description:
        "声明主响应使用哪些叙事提示、结束后有哪些后置请求，以及每个请求可以生成什么产物。",
    };
  if (path === "frame.yaml")
    return {
      path,
      title: "主持规则顺序",
      kind: "核心 YAML",
      description:
        "决定 Runtime 机械说明、主持规则块和世界指令以什么顺序进入稳定 bootstrap。",
    };
  if (path.startsWith("blocks/") && path.endsWith(".md"))
    return {
      path,
      title: markdownTitle(contents),
      kind: "主持规则",
      description:
        "跨世界成立的主持语义；是否发送给模型以及发送顺序由“提示内容”页控制。",
    };
  if (path.startsWith("prompts/") && path.endsWith(".md"))
    return {
      path,
      title: markdownTitle(contents),
      kind: "调用链提示",
      description:
        "主响应或某个后置请求实际读取的 Markdown 指令；普通编辑可在“调用链”直接修改。",
    };
  if (path.startsWith("renderers/"))
    return {
      path,
      title: "界面模板",
      kind: "HTML renderer",
      description: "把产物内容或玩家视图变成页面上的 HTML 结构。",
    };
  if (path.startsWith("scripts/"))
    return {
      path,
      title: "界面交互脚本",
      kind: "JavaScript",
      description:
        "为 renderer 添加本地交互；导入预设后默认停用，只有显式信任后才执行。",
    };
  if (path.startsWith("assets/"))
    return {
      path,
      title: "界面样式或资源",
      kind: "扩展资源",
      description: "供 renderer 或脚本读取的样式、文字或其他普通资源。",
    };
  if (path.startsWith("regex/"))
    return {
      path,
      title: "产物文本处理规则",
      kind: "Regex YAML",
      description: "在显示前对产物正文执行有界、可预览的正则处理。",
    };
  return {
    path,
    title: path.split("/").at(-1) ?? "未命名文件",
    kind: "普通文件",
    description: "随玩法预设保存和导出的普通业务文件。",
  };
}

function splitLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
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
        这是当前样例实际显示在游戏页面上的效果；不会调用模型或写入世界。
      </p>
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
      <section
        className="play-preset-artifact-rendered-preview"
        aria-label="页面上的效果"
      >
        <h5>页面上的效果</h5>
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
            无自定义 renderer；使用内置文本/Markdown/HTML renderer。
          </p>
        ) : (
          <pre role="alert">
            renderer fallback：{rendererError ?? "无法生成预览"}\n
            {preview.rawText}
          </pre>
        )}
      </section>
      <details className="play-preset-artifact-technical-details">
        <summary>技术细节：频道、处理规则与产物协议</summary>
        <p className="field-note">
          channel={preview.declaration.channel} · strategy=
          {preview.declaration.strategy} · save={preview.declaration.save} ·
          invalidation={preview.declaration.invalidation}
        </p>
        <details>
          <summary>raw payload 与 emit schema</summary>
          <pre>{JSON.stringify(preview.rawPayload, null, 2)}</pre>
          <pre>{JSON.stringify(preview.declaration, null, 2)}</pre>
        </details>
        <details>
          <summary>regex pipeline / 最终内容</summary>
          {pipeline.steps.map((step) => (
            <div key={`${step.order}:${step.scope}`} className="field-note">
              #{step.order} {step.scope} · {step.status} · matches=
              {step.matches}
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
          <details>
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
      </details>
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
}: {
  files: Record<string, string>;
  pending: boolean;
  onChange: (files: Record<string, string>) => void;
  onFeedback: (feedback: Feedback) => void;
}): React.JSX.Element {
  const frameSource = files["frame.yaml"] ?? "";
  const enabled = useMemo(() => readEnabledBlocks(frameSource), [frameSource]);
  const library = Object.keys(files)
    .filter((path) => path.startsWith("blocks/") && path.endsWith(".md"))
    .sort();
  const unlisted = library.filter((path) => !enabled.includes(path));
  const missing = enabled.filter((path) => files[path] === undefined);
  const orderedLibrary = [
    ...enabled.filter((path) => files[path] !== undefined),
    ...unlisted,
  ];
  const [selectedPath, setSelectedPath] = useState(orderedLibrary[0] ?? "");
  const selected = library.includes(selectedPath)
    ? selectedPath
    : (orderedLibrary[0] ?? "");

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
          <h4 id="play-preset-blocks-title">主持规则内容</h4>
        </div>
        <p>
          直接阅读和编辑每条跨世界主持规则。启用的规则按顺序进入模型；停用只是不发送，内容仍会随预设保存和导出。
        </p>
      </header>

      <div className="play-preset-concept-note">
        <strong>frame.yaml 在这里做什么？</strong>
        <p>
          它只保存“哪些主持规则已启用、按什么顺序发送”。你在下方勾选或排序时，页面会同步更新它，不必手写路径。
        </p>
      </div>

      {missing.length > 0 && (
        <p role="alert">frame.yaml 引用了不存在的块：{missing.join("、")}</p>
      )}

      {orderedLibrary.length === 0 ? (
        <p className="play-preset-empty-copy">当前预设还没有主持规则内容。</p>
      ) : (
        <div className="play-preset-block-browser">
          <aside aria-label="主持规则列表">
            <ol>
              {orderedLibrary.map((path) => {
                const order = enabled.indexOf(path);
                const contents = files[path] ?? "";
                return (
                  <li key={path}>
                    <button
                      type="button"
                      className={path === selected ? "selected" : ""}
                      aria-pressed={path === selected}
                      onClick={() => setSelectedPath(path)}
                    >
                      <strong>{markdownTitle(contents)}</strong>
                      <span>
                        {order < 0 ? "未启用" : `启用顺序 ${order + 1}`}
                      </span>
                      <small>{markdownExcerpt(contents)}</small>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>
          <section className="play-preset-block-editor">
            <header>
              <div>
                <span>{enabled.includes(selected) ? "已启用" : "未启用"}</span>
                <h5>{markdownTitle(files[selected] ?? "")}</h5>
                <code>{selected}</code>
              </div>
              <div className="play-preset-block-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={enabled.includes(selected)}
                    disabled={pending}
                    aria-label={
                      enabled.includes(selected)
                        ? `停用 ${selected}`
                        : `启用 ${selected}`
                    }
                    onChange={(event) =>
                      writeEnabled(
                        event.currentTarget.checked
                          ? [...enabled, selected]
                          : enabled.filter((path) => path !== selected),
                      )
                    }
                  />
                  发送给模型
                </label>
                <button
                  type="button"
                  disabled={pending || enabled.indexOf(selected) <= 0}
                  aria-label={`上移 ${selected}`}
                  onClick={() =>
                    writeEnabled(
                      moveBlock(enabled, enabled.indexOf(selected), -1),
                    )
                  }
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={
                    pending ||
                    !enabled.includes(selected) ||
                    enabled.indexOf(selected) === enabled.length - 1
                  }
                  aria-label={`下移 ${selected}`}
                  onClick={() =>
                    writeEnabled(
                      moveBlock(enabled, enabled.indexOf(selected), 1),
                    )
                  }
                >
                  下移
                </button>
              </div>
            </header>
            <label>
              完整规则内容
              <textarea
                aria-label={`编辑提示块内容 ${selected}`}
                value={files[selected] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...files,
                    [selected]: event.currentTarget.value,
                  })
                }
                spellCheck={false}
              />
            </label>
          </section>
        </div>
      )}
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
