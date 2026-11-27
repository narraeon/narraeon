import styles from "./DocumentWorkbench.module.css";
import { useMemo, useRef, useState } from "react";

import { gameplayPath } from "../protocol/gameplay.ts";
import type {
  ContentTreeFile,
  V1SettingAuthoringDiff,
} from "../protocol/v1.ts";
import { documentCodec } from "../shared/world-document-format.ts";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";
import { FileEditorMode, FileSourceEditor } from "./FileSourceEditor.tsx";
import { PlayerViewEditor } from "./PlayerViewEditor.tsx";
import { getWebLocale, uiText } from "./i18n.ts";
import { playerViewControlPath } from "./player-view-control-draft.ts";
import {
  newFileContents,
  revisionBaseDocumentIds,
} from "./world-document-draft.ts";
import { WorldDocumentMetadataForm } from "./WorldDocumentMetadataForm.tsx";
import { WorldFrameEditor } from "./WorldFrameEditor.tsx";
import type {
  AuthoringFileTarget,
  AuthoringFileView,
} from "./authoring-file-list.ts";

export interface DocumentWorkbenchIssue {
  code: string;
  path: string;
  message: string;
  documentId?: string;
}

export interface RevisionDocumentBase {
  files: readonly ContentTreeFile[];
  diff?: readonly V1SettingAuthoringDiff[];
}

interface DocumentWorkspace {
  kind: AuthoringFileTarget;
  files: readonly ContentTreeFile[];
  dirty: boolean;
  saving: boolean;
  issues: readonly DocumentWorkbenchIssue[];
  onFilesChange: (files: ContentTreeFile[]) => void;
  onSave: () => void;
}

type DocumentWorkspaceKind = AuthoringFileTarget;

export function DocumentWorkbench({
  workspace,
  fileView,
  revisionBase,
}: {
  workspace: DocumentWorkspace;
  fileView: AuthoringFileView;
  revisionBase?: RevisionDocumentBase;
}): React.JSX.Element {
  const { files } = workspace;
  const [pathEdit, setPathEdit] = useState({ sourcePath: "", value: "" });
  const [newPath, setNewPath] = useState("");
  const [newPathTouched, setNewPathTouched] = useState(false);
  const [deletion, setDeletion] = useState<ConfirmationRequest<string> | null>(
    null,
  );
  const editorRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const {
    ordered: orderedFiles,
    visible: visibleFiles,
    selected: selectedFile,
    query,
    titles,
    onQueryChange,
    onSelect: select,
  } = fileView;
  const selectedPath = selectedFile?.path ?? "";
  const selectedTitle = titles.get(selectedPath);
  const pathDraft =
    pathEdit.sourcePath === selectedPath ? pathEdit.value : selectedPath;
  const { issues } = workspace;
  const groups = groupsFor(workspace.kind, visibleFiles);
  const selectedIssues = issues.filter(({ path }) => path === selectedPath);
  const pathError =
    selectedFile !== undefined
      ? validateDraftPath(pathDraft, selectedFile.path, files, workspace.kind)
      : "";
  const documentRoot =
    workspace.kind === "content-package" ? "world/" : "state/";
  const documentLayout =
    workspace.kind === "content-package" ? "content_package" : "world_revision";
  const selectedCodec = selectedFile?.path.startsWith(documentRoot)
    ? documentCodec(selectedFile.path)
    : null;
  const baseFiles = revisionBase?.files;
  const baseDiff = revisionBase?.diff;
  const fixedRefIds = useMemo(
    () =>
      baseFiles === undefined
        ? undefined
        : revisionBaseDocumentIds(baseFiles, baseDiff),
    [baseFiles, baseDiff],
  );
  const newPathError = validateDraftPath(
    newPath,
    undefined,
    files,
    workspace.kind,
  );

  function replaceSelected(contents: string): void {
    if (selectedFile === undefined) return;
    workspace.onFilesChange(
      files.map((file) =>
        file.path === selectedFile.path ? { ...file, contents } : file,
      ),
    );
  }

  function renameSelected(): void {
    if (selectedFile === undefined || pathError.length > 0) return;
    const nextPath = pathDraft.trim();
    if (nextPath === selectedFile.path) return;
    workspace.onFilesChange(
      files.map((file) =>
        file.path === selectedFile.path
          ? { ...file, path: nextPath }
          : { ...file },
      ),
    );
    select(nextPath);
    setPathEdit({ sourcePath: nextPath, value: nextPath });
  }

  function addFile(): void {
    setNewPathTouched(true);
    if (newPathError.length > 0) return;
    const path = newPath.trim();
    workspace.onFilesChange([
      ...files.map((file) => ({ ...file })),
      { path, contents: newFileContents(path, documentRoot, files) },
    ]);
    select(path);
    setNewPath("");
    setNewPathTouched(false);
  }

  function removeFile(path: string): void {
    if (workspace.saving || !files.some((file) => file.path === path)) return;
    if (path === selectedPath) {
      const previousIndex = orderedFiles.findIndex(
        (file) => file.path === path,
      );
      select(
        orderedFiles[previousIndex + 1]?.path ??
          orderedFiles[previousIndex - 1]?.path ??
          "",
      );
    }
    workspace.onFilesChange(files.filter((file) => file.path !== path));
  }

  function saveShortcut(): void {
    if (workspace.dirty && !workspace.saving) workspace.onSave();
  }

  function writeBody(): void {
    const source = sourceRef.current;
    if (source === null) return;
    source.focus({ preventScroll: true });
    source.setSelectionRange(source.value.length, source.value.length);
    source.scrollIntoView({ block: "start" });
    source.scrollTop = source.scrollHeight;
  }

  const filter = (
    <label className="content-file-filter">
      <span>{uiText("筛选文件")}</span>
      <input
        type="search"
        value={query}
        placeholder={uiText("标题、短引用或路径")}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
    </label>
  );
  const mobileFiles = useMemo(() => {
    if (selectedFile === undefined || visibleFiles.includes(selectedFile))
      return visibleFiles;
    const matches = new Set(visibleFiles);
    return orderedFiles.filter(
      (file) => matches.has(file) || file === selectedFile,
    );
  }, [orderedFiles, visibleFiles, selectedFile]);

  return (
    <div
      className={`content-file-workspace document-workbench document-workbench-${workspace.kind} ${styles.workspace} ${styles.workbench}`}
    >
      <div className="content-mobile-file-picker">
        {filter}
        {visibleFiles.length === 0 && (
          <p className="field-note">{uiText("没有匹配的文件。")}</p>
        )}
        <label>
          {uiText("当前文件")}
          <select
            aria-label={uiText("选择编辑文件")}
            value={selectedPath}
            onChange={(event) => select(event.currentTarget.value)}
          >
            {mobileFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {titles.has(file.path)
                  ? `${titles.get(file.path)} · ${file.path}`
                  : file.path}
              </option>
            ))}
          </select>
        </label>
      </div>
      <aside
        className={`content-file-sidebar ${styles.sidebar}`}
        aria-label={
          workspace.kind === "content-package"
            ? uiText("内容包文件")
            : uiText("世界修订文件")
        }
      >
        <header>
          <div>
            <span className="content-editor-kicker">
              {workspace.kind === "content-package"
                ? uiText("当前草稿")
                : uiText("修订工作树")}
            </span>
            <h4>{uiText("文件")}</h4>
          </div>
          <span>
            {visibleFiles.length} / {files.length}
          </span>
        </header>
        {filter}
        <details className="content-new-file">
          <summary>{uiText("新建文件")}</summary>
          <div>
            <label>
              {uiText("新文件路径")}
              <input
                value={newPath}
                placeholder={
                  workspace.kind === "world-revision"
                    ? "state/characters/name.yaml"
                    : "world/characters/name.yaml"
                }
                onChange={(event) => {
                  setNewPath(event.target.value);
                  setNewPathTouched(true);
                }}
              />
            </label>
            {newPathTouched && newPathError.length > 0 && (
              <p role="alert">{newPathError}</p>
            )}
            <p>
              {uiText(
                "新文件先加入本地草稿；Runtime 会在整批保存时检查路径与内容。",
              )}
            </p>
            {newPathError.length === 0 &&
              newPath.trim().startsWith(documentRoot) &&
              documentCodec(newPath.trim()) === "markdown" && (
                <p>
                  {uiText(
                    "修改 Markdown 文档标题时，文件头的 title 和正文的一级标题须一致。",
                  )}
                </p>
              )}
            <button
              type="button"
              disabled={newPathError.length > 0}
              onClick={addFile}
            >
              {uiText("加入草稿")}
            </button>
          </div>
        </details>
        <nav
          className="content-file-list"
          aria-label={
            workspace.kind === "content-package"
              ? uiText("内容包文件树")
              : uiText("世界修订文件树")
          }
        >
          {visibleFiles.length === 0 ? (
            <p>{uiText("没有匹配的文件。")}</p>
          ) : (
            groups.map((group) => (
              <section
                key={group.id}
                aria-labelledby={`document-group-${workspace.kind}-${group.id}`}
              >
                <h5 id={`document-group-${workspace.kind}-${group.id}`}>
                  {uiText(group.label)}
                  <span>{group.files.length}</span>
                </h5>
                <ul>
                  {group.files.map((file) => {
                    const title = titles.get(file.path);
                    const issueCount = issues.filter(
                      ({ path }) => path === file.path,
                    ).length;
                    return (
                      <li key={file.path}>
                        <button
                          type="button"
                          className={
                            file.path === selectedPath
                              ? "selected-content-file"
                              : ""
                          }
                          aria-label={uiText("打开 {path}", {
                            path: file.path,
                          })}
                          aria-pressed={file.path === selectedPath}
                          aria-description={title}
                          title={file.path}
                          onClick={() => select(file.path)}
                        >
                          <span
                            className="content-file-kind"
                            aria-hidden="true"
                          >
                            {fileKind(file)}
                          </span>
                          <span className={styles.fileName}>
                            {title !== undefined && <strong>{title}</strong>}
                            <code>{file.path}</code>
                          </span>
                          {issueCount > 0 && (
                            <span className="content-file-issue-count">
                              {issueCount}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </nav>
      </aside>

      <section
        ref={editorRef}
        tabIndex={-1}
        className={`content-file-editor ${styles.editor}`}
        aria-label={
          selectedFile === undefined
            ? uiText("文件编辑器")
            : uiText("文件编辑器：{path}", { path: selectedFile.path })
        }
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            saveShortcut();
          }
        }}
      >
        {selectedFile === undefined ? (
          <div className="content-editor-empty">
            <span aria-hidden="true">＋</span>
            <h4>{uiText("当前草稿没有文件")}</h4>
            <p>
              {workspace.kind === "content-package"
                ? uiText("从左侧新建第一份文件，或返回工作区导入已有内容包。")
                : uiText("从左侧新建状态或控制文件。")}
            </p>
          </div>
        ) : (
          <>
            <header className="content-file-editor-header">
              <div>
                <span className="content-editor-kicker">
                  {describeFile(selectedFile, workspace.kind)}
                </span>
                <h4>{selectedTitle ?? leafName(selectedFile.path)}</h4>
                <code className={styles.editorPath}>{selectedFile.path}</code>
              </div>
              <button
                type="button"
                key={selectedFile.path}
                className="danger-button content-remove-file"
                disabled={workspace.saving}
                onClick={(event) =>
                  setDeletion({
                    action: selectedFile.path,
                    message: uiText("从当前草稿删除 {path}？", {
                      path: selectedFile.path,
                    }),
                    confirmLabel: uiText("删除文件"),
                    opener: event.currentTarget,
                    fallback: editorRef.current,
                  })
                }
              >
                {uiText("删除文件")}
              </button>
            </header>
            <details className="content-rename-file" key={selectedFile.path}>
              <summary>{uiText("重命名文件")}</summary>
              <div className="content-path-editor">
                <label>
                  {uiText("文件路径")}
                  <input
                    value={pathDraft}
                    onChange={(event) =>
                      setPathEdit({
                        sourcePath: selectedFile.path,
                        value: event.target.value,
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    pathError.length > 0 ||
                    pathDraft.trim() === selectedFile.path
                  }
                  onClick={renameSelected}
                >
                  {uiText("应用新路径")}
                </button>
              </div>
              {pathError.length > 0 ? <p role="alert">{pathError}</p> : null}
            </details>
            {selectedFile.encoding === "base64" ? (
              <div className="content-binary-note" role="note">
                <strong>{uiText("二进制资源不在文本编辑器展开")}</strong>
                <span>
                  {uiText(
                    "当前 Base64 内容会原样保留；如需替换资源，请重新导入内容包。",
                  )}
                </span>
              </div>
            ) : selectedFile.path === playerViewControlPath ? (
              <PlayerViewEditor
                contents={selectedFile.contents}
                files={files}
                layout={documentLayout}
                onChange={replaceSelected}
                onSave={saveShortcut}
              />
            ) : selectedFile.path === "control/frame.yaml" ? (
              <WorldFrameEditor
                contents={selectedFile.contents}
                files={files}
                layout={documentLayout}
                dirty={workspace.dirty}
                onChange={replaceSelected}
                onSave={saveShortcut}
              />
            ) : (
              <>
                <FileEditorMode
                  showSource
                  onSource={() => sourceRef.current?.focus()}
                />
                {selectedCodec !== null && (
                  <WorldDocumentMetadataForm
                    key={`metadata:${selectedFile.path}`}
                    file={selectedFile}
                    files={files}
                    codec={selectedCodec}
                    root={documentRoot}
                    fixedRefIds={fixedRefIds}
                    onChange={replaceSelected}
                    onWriteBody={writeBody}
                  />
                )}
                <FileSourceEditor
                  key={`source:${selectedFile.path}`}
                  path={selectedFile.path}
                  contents={selectedFile.contents}
                  sourceRef={sourceRef}
                  readOnly={isRevisionGameplayFile(
                    selectedFile,
                    workspace.kind,
                  )}
                  placeholder={editorPlaceholder(selectedFile.path)}
                  shortcut={
                    workspace.kind === "content-package"
                      ? uiText("Ctrl / ⌘ + S 整批保存")
                      : uiText("Ctrl / ⌘ + S 保存到修订工作树")
                  }
                  onChange={replaceSelected}
                />
              </>
            )}
            <footer className="content-source-meta">
              <span>{fileKind(selectedFile)}</span>
              {selectedFile.encoding === undefined && (
                <>
                  <span>
                    {lineCount(selectedFile.contents)} {uiText("行")}
                  </span>
                  <span>
                    {selectedFile.contents.length.toLocaleString(
                      getWebLocale(),
                    )}{" "}
                    {uiText("字符")}
                  </span>
                </>
              )}
            </footer>
            {selectedIssues.length > 0 && (
              <section
                className="content-selected-diagnostics"
                aria-labelledby="selected-file-diagnostics-title"
              >
                <h5 id="selected-file-diagnostics-title">
                  {uiText("已保存版本诊断")}
                </h5>
                <ul>
                  {selectedIssues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.path}-${index}`}>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
      {deletion !== null && (
        <ConfirmationDialog
          request={deletion}
          onDecision={(confirmed) => {
            setDeletion(null);
            if (confirmed) removeFile(deletion.action);
          }}
        />
      )}
    </div>
  );
}

function groupsFor(
  kind: DocumentWorkspaceKind,
  files: readonly ContentTreeFile[],
): { id: string; label: string; files: ContentTreeFile[] }[] {
  const definitions =
    kind === "content-package"
      ? [
          ["opening", "开场"],
          ["world", "世界内容"],
          ["control", "控制"],
          ["other", "其他资源"],
        ]
      : [
          ["state", "世界状态"],
          ["control", "控制"],
          ["other", "其他"],
        ];
  return definitions.flatMap(([id, label]) => {
    const selected = files.filter(({ path }) => groupFor(kind, path) === id);
    return selected.length === 0
      ? []
      : [{ id: id!, label: label!, files: selected }];
  });
}

function groupFor(kind: DocumentWorkspaceKind, path: string): string {
  if (kind === "content-package") {
    if (path === "opening.md") return "opening";
    if (path.startsWith("world/")) return "world";
    if (path.startsWith("control/")) return "control";
    return "other";
  }
  if (path.startsWith("state/")) return "state";
  if (path.startsWith("control/")) return "control";
  return "other";
}

function validateDraftPath(
  rawPath: string,
  currentPath: string | undefined,
  files: readonly ContentTreeFile[],
  kind: DocumentWorkspaceKind,
): string {
  const path = rawPath.trim();
  if (path.length === 0) return uiText("请输入文件路径。");
  if (
    path.startsWith("/") ||
    /^[a-z]:[\\/]/iu.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return uiText("路径必须是使用 / 的内容包相对路径。");
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    return uiText("路径不能包含空目录、. 或 ..。");
  // control/gameplay.json is the gameplay identity, not an unsupported JSON file.
  // A world revision may keep the existing file, but cannot create or move it.
  const gameplayFileAllowed =
    path === gameplayPath &&
    (kind === "content-package" || currentPath === gameplayPath);
  if (/\.json$/iu.test(path) && path !== gameplayPath)
    return uiText("当前文件原生 V1 不接受 manifest 或 JSON 内容文件。");
  if (
    kind === "world-revision" &&
    !gameplayFileAllowed &&
    !/^state\/.+\.(?:ya?ml|md)$/u.test(path) &&
    path !== "control/frame.yaml" &&
    path !== "control/player-views.yaml" &&
    !/^control\/blocks\/.+\.md$/u.test(path)
  )
    return uiText(
      "世界修订只接受 state 下的 YAML／Markdown，以及受支持的 control 文件。",
    );
  const portablePath = path.normalize("NFC").toLocaleLowerCase("en-US");
  const duplicate = files.some(
    (file) =>
      file.path !== currentPath &&
      file.path.normalize("NFC").toLocaleLowerCase("en-US") === portablePath,
  );
  if (duplicate) return uiText("当前草稿中已经存在同一路径。");
  return "";
}

function leafName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function fileKind(file: ContentTreeFile): string {
  if (file.encoding === "base64") return "BIN";
  if (/\.ya?ml$/iu.test(file.path)) return "YAML";
  if (/\.md$/iu.test(file.path)) return "MD";
  if (file.path === gameplayPath) return "JSON";
  return "TEXT";
}

/** A world's gameplay identity is fixed, so a revision shows it without an editable source. */
function isRevisionGameplayFile(
  file: ContentTreeFile,
  kind: DocumentWorkspaceKind,
): boolean {
  return kind === "world-revision" && file.path === gameplayPath;
}

function describeFile(
  file: ContentTreeFile,
  kind: DocumentWorkspaceKind,
): string {
  if (file.encoding === "base64") return uiText("二进制资源");
  if (file.path === gameplayPath)
    return kind === "world-revision"
      ? uiText("世界玩法身份，修订中保持不变")
      : uiText("内容包玩法身份，只能修改跑团判定方案");
  if (file.path === "opening.md") return uiText("玩家首次行动前看到的开场白");
  if (file.path.startsWith("world/"))
    return uiText("会复制为世界状态的设定文档");
  if (file.path.startsWith("control/"))
    return uiText("会复制为世界控制的作者资产");
  return uiText("内容包文本资源");
}

function editorPlaceholder(path: string): string {
  if (path === "opening.md")
    return uiText("写下玩家首次行动前立即看到的局面……");
  return uiText("输入 UTF-8 文本内容……");
}

function lineCount(contents: string): number {
  return contents.length === 0 ? 0 : contents.split("\n").length;
}
