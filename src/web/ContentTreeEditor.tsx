import { useMemo, useState } from "react";

import type { ContentTreeFile } from "../protocol/v1.ts";
import { WorldFrameEditor } from "./WorldFrameEditor.tsx";

export interface ContentTreeIssue {
  code: string;
  path: string;
  message: string;
  documentId?: string;
}

interface ContentTreeEditorProps {
  files: readonly ContentTreeFile[];
  status: "usable" | "needs_repair";
  issues: readonly ContentTreeIssue[];
  dirty: boolean;
  onFilesChange: (files: ContentTreeFile[]) => void;
  onSave: () => void;
  onReset: () => void;
  onCopy: () => void;
  onExport: () => void;
  onDelete: () => void;
  displayName: string;
  onRename: (name: string) => void;
}

type FileGroup = "opening" | "world" | "control" | "other";

const fileGroups: readonly { id: FileGroup; label: string }[] = [
  { id: "opening", label: "开场" },
  { id: "world", label: "世界内容" },
  { id: "control", label: "控制" },
  { id: "other", label: "其他资源" },
];

export function ContentTreeEditor({
  files,
  status,
  issues,
  dirty,
  onFilesChange,
  onSave,
  onReset,
  onCopy,
  onExport,
  onDelete,
  displayName,
  onRename,
}: ContentTreeEditorProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(displayName);
  // Switching packages, or a rename landing, replaces the name from outside;
  // adjust the draft during render rather than through an effect.
  const [lastDisplayName, setLastDisplayName] = useState(displayName);
  if (lastDisplayName !== displayName) {
    setLastDisplayName(displayName);
    setNameDraft(displayName);
  }
  const [requestedPath, setRequestedPath] = useState("");
  const [pathEdit, setPathEdit] = useState({ sourcePath: "", value: "" });
  const [newPath, setNewPath] = useState("");
  const [newPathTouched, setNewPathTouched] = useState(false);

  const orderedFiles = useMemo(
    () => [...files].sort(compareContentPaths),
    [files],
  );
  const preferredPath =
    orderedFiles.find(({ path }) => path === "opening.md")?.path ??
    orderedFiles.find(({ path }) => path === "world/current-situation.yaml")
      ?.path ??
    orderedFiles[0]?.path ??
    "";
  const selectedPath = files.some(({ path }) => path === requestedPath)
    ? requestedPath
    : preferredPath;
  const selectedFile = files.find(({ path }) => path === selectedPath);

  const pathDraft =
    pathEdit.sourcePath === selectedPath ? pathEdit.value : selectedPath;

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleFiles =
    normalizedQuery.length === 0
      ? orderedFiles
      : orderedFiles.filter(({ path }) =>
          path.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
        );
  const groupedFiles = new Map<FileGroup, ContentTreeFile[]>();
  for (const group of fileGroups) groupedFiles.set(group.id, []);
  for (const file of visibleFiles)
    groupedFiles.get(groupFor(file.path))?.push(file);

  const pathError = selectedFile
    ? validateDraftPath(pathDraft, selectedFile.path, files)
    : "";
  const newPathError = validateDraftPath(newPath, undefined, files);
  const selectedIssues = issues.filter(({ path }) => path === selectedPath);
  const worldCount = files.filter(({ path }) =>
    path.startsWith("world/"),
  ).length;
  const controlCount = files.filter(({ path }) =>
    path.startsWith("control/"),
  ).length;
  const openingCount = files.filter(({ path }) => path === "opening.md").length;

  const replaceSelected = (contents: string): void => {
    if (selectedFile === undefined) return;
    onFilesChange(
      files.map((file) =>
        file.path === selectedFile.path ? { ...file, contents } : { ...file },
      ),
    );
  };

  const renameSelected = (): void => {
    if (selectedFile === undefined || pathError.length > 0) return;
    const nextPath = pathDraft.trim();
    if (nextPath === selectedFile.path) return;
    onFilesChange(
      files.map((file) =>
        file.path === selectedFile.path
          ? { ...file, path: nextPath }
          : { ...file },
      ),
    );
    setRequestedPath(nextPath);
    setPathEdit({ sourcePath: nextPath, value: nextPath });
  };

  const addFile = (): void => {
    setNewPathTouched(true);
    if (newPathError.length > 0) return;
    const path = newPath.trim();
    onFilesChange([
      ...files.map((file) => ({ ...file })),
      { path, contents: "" },
    ]);
    setRequestedPath(path);
    setNewPath("");
    setNewPathTouched(false);
  };

  const removeSelected = (): void => {
    if (selectedFile === undefined) return;
    const remaining = files
      .filter(({ path }) => path !== selectedFile.path)
      .map((file) => ({ ...file }));
    setRequestedPath(nextSelectedPath(remaining, selectedFile.path));
    onFilesChange(remaining);
  };

  return (
    <section className="panel-card content-tree-editor">
      <header className="section-heading-row content-tree-heading">
        <div>
          <h3>内容包当前树</h3>
          <p className="field-note">
            逐份编辑 YAML／Markdown；整批保存时才原子替换已保存版本。
          </p>
        </div>
        <div className="content-tree-state" aria-label="内容包编辑状态">
          <span className={`package-status ${status}`}>
            已保存版本：{status === "usable" ? "可用" : "需要修复"}
          </span>
          <span className={dirty ? "draft-state dirty" : "draft-state"}>
            {dirty ? "有未保存修改" : "草稿与已保存版本一致"}
          </span>
        </div>
      </header>

      <dl className="content-tree-counts" aria-label="内容包文件统计">
        <div>
          <dt>全部文件</dt>
          <dd>{files.length}</dd>
        </div>
        <div>
          <dt>开场白</dt>
          <dd>{openingCount}</dd>
        </div>
        <div>
          <dt>世界内容</dt>
          <dd>{worldCount}</dd>
        </div>
        <div>
          <dt>控制文件</dt>
          <dd>{controlCount}</dd>
        </div>
      </dl>

      <div className="content-file-workspace">
        <aside className="content-file-sidebar" aria-label="内容包文件">
          <header>
            <div>
              <span className="content-editor-kicker">当前草稿</span>
              <h4>文件</h4>
            </div>
            <span>
              {visibleFiles.length} / {files.length}
            </span>
          </header>
          <label className="content-file-filter">
            筛选文件
            <input
              type="search"
              value={query}
              placeholder="人物、地点或文件名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav className="content-file-list" aria-label="内容包文件树">
            {visibleFiles.length === 0 ? (
              <p>没有匹配的文件。</p>
            ) : (
              fileGroups.map(({ id, label }) => {
                const groupFiles = groupedFiles.get(id) ?? [];
                if (groupFiles.length === 0) return null;
                return (
                  <section key={id} aria-labelledby={`content-group-${id}`}>
                    <h5 id={`content-group-${id}`}>
                      {label}
                      <span>{groupFiles.length}</span>
                    </h5>
                    <ul>
                      {groupFiles.map((file) => {
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
                              aria-label={`打开 ${file.path}`}
                              aria-pressed={file.path === selectedPath}
                              title={file.path}
                              onClick={() => setRequestedPath(file.path)}
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
                );
              })
            )}
          </nav>
          <details className="content-new-file">
            <summary>新建文件</summary>
            <div>
              <label>
                新文件路径
                <input
                  value={newPath}
                  placeholder="world/characters/name.yaml"
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
                新文件先加入本地草稿；Runtime 会在整批保存时检查路径与内容。
              </p>
              <button
                type="button"
                disabled={newPathError.length > 0}
                onClick={addFile}
              >
                加入草稿
              </button>
            </div>
          </details>
        </aside>

        <section
          className="content-file-editor"
          aria-label={
            selectedFile === undefined
              ? "文件编辑器"
              : `文件编辑器：${selectedFile.path}`
          }
        >
          {selectedFile === undefined ? (
            <div className="content-editor-empty">
              <span aria-hidden="true">＋</span>
              <h4>当前草稿没有文件</h4>
              <p>从左侧新建第一份文件，或返回工作区导入已有内容包。</p>
            </div>
          ) : (
            <>
              <header className="content-file-editor-header">
                <div>
                  <span className="content-editor-kicker">
                    {describeFile(selectedFile)}
                  </span>
                  <h4>{leafName(selectedFile.path)}</h4>
                </div>
                <button
                  type="button"
                  className="danger-button content-remove-file"
                  onClick={removeSelected}
                >
                  从草稿移除
                </button>
              </header>
              <div className="content-path-editor">
                <label>
                  文件路径
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
                  应用新路径
                </button>
              </div>
              {pathError.length > 0 && <p role="alert">{pathError}</p>}
              {selectedFile.encoding === "base64" ? (
                <div className="content-binary-note" role="note">
                  <strong>二进制资源不在文本编辑器展开</strong>
                  <span>
                    当前 Base64 内容会原样保留；如需替换资源，请重新导入内容包。
                  </span>
                </div>
              ) : selectedFile.path === "control/frame.yaml" ? (
                <WorldFrameEditor
                  contents={selectedFile.contents}
                  files={files}
                  dirty={dirty}
                  onChange={replaceSelected}
                  onSave={onSave}
                />
              ) : (
                <label className="content-source-editor">
                  <span>
                    文件内容
                    <small>Ctrl / ⌘ + S 整批保存</small>
                  </span>
                  <textarea
                    rows={27}
                    spellCheck={false}
                    value={selectedFile.contents}
                    placeholder={editorPlaceholder(selectedFile.path)}
                    aria-label={`编辑 ${selectedFile.path}`}
                    onChange={(event) => replaceSelected(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLocaleLowerCase("en-US") === "s"
                      ) {
                        event.preventDefault();
                        if (dirty) onSave();
                      }
                    }}
                  />
                </label>
              )}
              <footer className="content-source-meta">
                <span>{fileKind(selectedFile)}</span>
                {selectedFile.encoding === undefined && (
                  <>
                    <span>{lineCount(selectedFile.contents)} 行</span>
                    <span>
                      {selectedFile.contents.length.toLocaleString()} 字符
                    </span>
                  </>
                )}
              </footer>
              {selectedIssues.length > 0 && (
                <section
                  className="content-selected-diagnostics"
                  aria-labelledby="selected-file-diagnostics-title"
                >
                  <h5 id="selected-file-diagnostics-title">已保存版本诊断</h5>
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

      {issues.length > 0 && (
        <details className="content-package-diagnostics" open={!dirty}>
          <summary>已保存版本有 {issues.length} 项需要修复</summary>
          {dirty && <p>诊断对应上一次保存；整批保存后会按新草稿重新检查。</p>}
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.path}-${index}`}>
                <code>{issue.path}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="content-tree-actions">
        <div className="content-save-boundary">
          <div>
            <strong>{dirty ? "草稿尚未保存" : "当前树已保存"}</strong>
            <span>保存会把整棵草稿作为一个候选原子替换，不会逐文件提交。</span>
          </div>
          <div className="button-row">
            <button type="button" disabled={!dirty} onClick={onSave}>
              整批保存
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!dirty}
              onClick={onReset}
            >
              放弃未保存修改
            </button>
          </div>
        </div>
        <details className="content-package-actions">
          <summary>内容包操作</summary>
          {dirty && <p>请先整批保存或放弃当前草稿，再操作已保存内容包。</p>}
          <label className="content-package-rename">
            <span>内容包名称</span>
            <input
              value={nameDraft}
              disabled={dirty}
              maxLength={160}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              disabled={
                dirty ||
                nameDraft.trim() === "" ||
                nameDraft.trim() === displayName
              }
              onClick={() => onRename(nameDraft.trim())}
            >
              重命名
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={dirty}
              onClick={onCopy}
            >
              复制为新本地身份
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={dirty}
              onClick={onExport}
            >
              导出 ZIP
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={dirty}
              onClick={onDelete}
            >
              删除内容包
            </button>
          </div>
        </details>
      </footer>
    </section>
  );
}

function validateDraftPath(
  rawPath: string,
  currentPath: string | undefined,
  files: readonly ContentTreeFile[],
): string {
  const path = rawPath.trim();
  if (path.length === 0) return "请输入文件路径。";
  if (
    path.startsWith("/") ||
    /^[a-z]:[\\/]/iu.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return "路径必须是使用 / 的内容包相对路径。";
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    return "路径不能包含空目录、. 或 ..。";
  if (/\.json$/iu.test(path))
    return "当前文件原生 V1 不接受 manifest 或 JSON 内容文件。";
  const portablePath = path.normalize("NFC").toLocaleLowerCase("en-US");
  const duplicate = files.some(
    (file) =>
      file.path !== currentPath &&
      file.path.normalize("NFC").toLocaleLowerCase("en-US") === portablePath,
  );
  if (duplicate) return "当前草稿中已经存在同一路径。";
  return "";
}

function groupFor(path: string): FileGroup {
  if (path === "opening.md") return "opening";
  if (path.startsWith("world/")) return "world";
  if (path.startsWith("control/")) return "control";
  return "other";
}

function compareContentPaths(
  left: ContentTreeFile,
  right: ContentTreeFile,
): number {
  const rank = (path: string): number => {
    if (path === "opening.md") return 0;
    if (path === "world/current-situation.yaml") return 1;
    if (path.startsWith("world/")) return 2;
    if (path === "control/frame.yaml") return 3;
    if (path.startsWith("control/")) return 4;
    return 5;
  };
  return (
    rank(left.path) - rank(right.path) || left.path.localeCompare(right.path)
  );
}

function nextSelectedPath(
  remaining: readonly ContentTreeFile[],
  removedPath: string,
): string {
  const ordered = [...remaining].sort(compareContentPaths);
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
  return "TEXT";
}

function describeFile(file: ContentTreeFile): string {
  if (file.encoding === "base64") return "二进制资源";
  if (file.path === "opening.md") return "玩家首次行动前看到的开场白";
  if (file.path.startsWith("world/")) return "会复制为世界状态的设定文档";
  if (file.path.startsWith("control/")) return "会复制为世界控制的作者资产";
  return "内容包文本资源";
}

function editorPlaceholder(path: string): string {
  if (path === "opening.md") return "写下玩家首次行动前立即看到的局面……";
  if (path.startsWith("world/") && /\.ya?ml$/iu.test(path))
    return "$document:\n  id: character.example\n  ref: example\n  title: 示例人物\n  summary: 一句话稳定简介。\n  aliases: []\n";
  if (path.startsWith("world/") && /\.md$/iu.test(path))
    return "---\n$document:\n  id: rule.example\n  ref: example\n  title: 示例规则\n  summary: 一句话稳定简介。\n  aliases: []\n---\n\n# 示例规则\n";
  return "输入 UTF-8 文本内容……";
}

function lineCount(contents: string): number {
  return contents.length === 0 ? 0 : contents.split("\n").length;
}
