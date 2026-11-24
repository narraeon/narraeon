import styles from "./DocumentWorkbench.module.css";
import { useMemo, useState } from "react";

import { gameplayPath } from "../protocol/gameplay.ts";
import type { ContentTreeFile } from "../protocol/v1.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { WorldFrameEditor } from "./WorldFrameEditor.tsx";

export interface DocumentWorkbenchIssue {
  code: string;
  path: string;
  message: string;
  documentId?: string;
}

interface ContentPackageWorkspace {
  kind: "content-package";
  files: readonly ContentTreeFile[];
  dirty: boolean;
  issues: readonly DocumentWorkbenchIssue[];
  onFilesChange: (files: ContentTreeFile[]) => void;
  onSave: () => void;
}

interface WorldRevisionWorkspace {
  kind: "world-revision";
  files: readonly ContentTreeFile[];
  dirty: boolean;
  pending: boolean;
  issues: readonly DocumentWorkbenchIssue[];
  onFilesChange: (files: ContentTreeFile[]) => void;
  onSave: () => void;
}

type DocumentWorkspace = ContentPackageWorkspace | WorldRevisionWorkspace;
type DocumentWorkspaceKind = DocumentWorkspace["kind"];

export function DocumentWorkbench({
  workspace,
  selectedPath: controlledPath,
  onSelectedPathChange,
}: {
  workspace: DocumentWorkspace;
  selectedPath?: string;
  onSelectedPathChange?: (path: string) => void;
}): React.JSX.Element {
  const { files } = workspace;
  const [query, setQuery] = useState("");
  const [requestedPath, setRequestedPath] = useState("");
  const [pathEdit, setPathEdit] = useState({ sourcePath: "", value: "" });
  const [newPath, setNewPath] = useState("");
  const [newPathTouched, setNewPathTouched] = useState(false);
  const orderedFiles = useMemo(
    () =>
      [...files].sort((left, right) =>
        comparePaths(workspace.kind, left, right),
      ),
    [files, workspace.kind],
  );
  const preferredPath =
    (workspace.kind === "content-package"
      ? (orderedFiles.find(({ path }) => path === "opening.md")?.path ??
        orderedFiles.find(({ path }) => path === "world/current-situation.yaml")
          ?.path)
      : orderedFiles.find(({ path }) => path === "state/current-situation.yaml")
          ?.path) ??
    orderedFiles[0]?.path ??
    "";
  const requested = controlledPath ?? requestedPath;
  const selectedPath = files.some(({ path }) => path === requested)
    ? requested
    : preferredPath;
  const selectedFile = files.find(({ path }) => path === selectedPath);
  const pathDraft =
    pathEdit.sourcePath === selectedPath ? pathEdit.value : selectedPath;
  const { issues } = workspace;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleFiles =
    normalizedQuery.length === 0
      ? orderedFiles
      : orderedFiles.filter((file) =>
          file.path.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
        );
  const groups = groupsFor(workspace.kind, visibleFiles);
  const selectedIssues = issues.filter(({ path }) => path === selectedPath);
  const pathError =
    selectedFile !== undefined
      ? validateDraftPath(pathDraft, selectedFile.path, files, workspace.kind)
      : "";
  const newPathError = validateDraftPath(
    newPath,
    undefined,
    files,
    workspace.kind,
  );

  function select(path: string): void {
    if (controlledPath === undefined) setRequestedPath(path);
    onSelectedPathChange?.(path);
  }

  function replaceSelected(contents: string): void {
    if (selectedFile === undefined) return;
    workspace.onFilesChange(
      files.map((file) =>
        file.path === selectedFile.path ? { ...file, contents } : { ...file },
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
      { path, contents: "" },
    ]);
    select(path);
    setNewPath("");
    setNewPathTouched(false);
  }

  function removeSelected(): void {
    if (selectedFile === undefined) return;
    const remaining = files
      .filter(({ path }) => path !== selectedFile.path)
      .map((file) => ({ ...file }));
    select(nextSelectedPath(remaining, selectedFile.path, workspace.kind));
    workspace.onFilesChange(remaining);
  }

  function saveShortcut(): void {
    if (!workspace.dirty) return;
    if (workspace.kind === "content-package" || !workspace.pending)
      workspace.onSave();
  }

  return (
    <div
      className={`content-file-workspace document-workbench document-workbench-${workspace.kind} ${styles.workspace} ${styles.workbench}`}
    >
      <label className="content-mobile-file-picker">
        {uiText("当前文件")}
        <select
          aria-label={uiText("选择编辑文件")}
          value={selectedPath}
          onChange={(event) => select(event.currentTarget.value)}
        >
          {orderedFiles.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
            </option>
          ))}
        </select>
      </label>
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
        <label className="content-file-filter">
          <span>{uiText("筛选文件")}</span>
          <input
            type="search"
            value={query}
            placeholder={
              workspace.kind === "content-package"
                ? uiText("人物、地点或文件名")
                : uiText("查找人物、地点、规则…")
            }
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
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
                          title={file.path}
                          onClick={() => select(file.path)}
                        >
                          <span
                            className="content-file-kind"
                            aria-hidden="true"
                          >
                            {fileKind(file)}
                          </span>
                          <code>{file.path}</code>
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
            <button
              type="button"
              disabled={newPathError.length > 0}
              onClick={addFile}
            >
              {uiText("加入草稿")}
            </button>
          </div>
        </details>
      </aside>

      <section
        className={`content-file-editor ${styles.editor}`}
        aria-label={
          selectedFile === undefined
            ? uiText("文件编辑器")
            : uiText("文件编辑器：{path}", { path: selectedFile.path })
        }
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
                <h4>{leafName(selectedFile.path)}</h4>
              </div>
              <button
                type="button"
                className="danger-button content-remove-file"
                onClick={removeSelected}
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
            ) : selectedFile.path === "control/frame.yaml" ? (
              <WorldFrameEditor
                contents={selectedFile.contents}
                files={files}
                dirty={workspace.dirty}
                onChange={replaceSelected}
                onSave={workspace.onSave}
              />
            ) : (
              <label className="content-source-editor">
                <span>
                  {uiText("文件内容")}
                  <small>
                    {workspace.kind === "content-package"
                      ? uiText("Ctrl / ⌘ + S 整批保存")
                      : workspace.kind === "world-revision"
                        ? uiText("Ctrl / ⌘ + S 保存到修订工作树")
                        : uiText("Ctrl / ⌘ + S 预览整笔修订")}
                  </small>
                </span>
                <textarea
                  rows={27}
                  spellCheck={false}
                  readOnly={isRevisionGameplayFile(
                    selectedFile,
                    workspace.kind,
                  )}
                  value={selectedFile.contents}
                  placeholder={editorPlaceholder(selectedFile.path)}
                  aria-label={uiText("编辑 {path}", {
                    path: selectedFile.path,
                  })}
                  onChange={(event) => replaceSelected(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key.toLocaleLowerCase("en-US") === "s"
                    ) {
                      event.preventDefault();
                      saveShortcut();
                    }
                  }}
                />
              </label>
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

function comparePaths(
  kind: DocumentWorkspaceKind,
  left: ContentTreeFile,
  right: ContentTreeFile,
): number {
  const rank = (path: string): number => {
    if (kind === "content-package") {
      if (path === "opening.md") return 0;
      if (path === "world/current-situation.yaml") return 1;
      if (path.startsWith("world/")) return 2;
      if (path === "control/frame.yaml") return 3;
      if (path.startsWith("control/")) return 4;
      return 5;
    }
    if (path === "state/current-situation.yaml") return 0;
    if (path.startsWith("state/")) return 1;
    if (path === "control/frame.yaml") return 2;
    if (path.startsWith("control/")) return 3;
    return 4;
  };
  return (
    rank(left.path) - rank(right.path) || left.path.localeCompare(right.path)
  );
}

function nextSelectedPath(
  remaining: readonly ContentTreeFile[],
  removedPath: string,
  kind: DocumentWorkspaceKind,
): string {
  const ordered = [...remaining].sort((left, right) =>
    comparePaths(kind, left, right),
  );
  const following = ordered.find(
    ({ path }) => path.localeCompare(removedPath) > 0,
  );
  return following?.path ?? ordered.at(-1)?.path ?? "";
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
  if (
    (path.startsWith("world/") || path.startsWith("state/")) &&
    /\.ya?ml$/iu.test(path)
  )
    return uiText(
      "$document:\n  id: character.example\n  ref: example\n  title: 示例人物\n  summary: 一句话稳定简介。\n  aliases: []\n",
    );
  if (
    (path.startsWith("world/") || path.startsWith("state/")) &&
    /\.md$/iu.test(path)
  )
    return uiText(
      "---\n$document:\n  id: rule.example\n  ref: example\n  title: 示例规则\n  summary: 一句话稳定简介。\n  aliases: []\n---\n\n# 示例规则\n",
    );
  return uiText("输入 UTF-8 文本内容……");
}

function lineCount(contents: string): number {
  return contents.length === 0 ? 0 : contents.split("\n").length;
}
