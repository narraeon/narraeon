import { useMemo, useState } from "react";

import type { ContentTreeFile } from "../protocol/v1.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { WorldFrameEditor } from "./WorldFrameEditor.tsx";
import { worldDocumentPresentation } from "./worldDocumentPresentation.ts";

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

interface WorldCorrectionWorkspace {
  kind: "world-correction";
  files: readonly ContentTreeFile[];
  dirty: boolean;
  pending: boolean;
  onFilesChange: (files: ContentTreeFile[]) => void;
  onPreview: () => void;
}

export function DocumentWorkbench({
  workspace,
  selectedPath: controlledPath,
  onSelectedPathChange,
}: {
  workspace: ContentPackageWorkspace | WorldCorrectionWorkspace;
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
    workspace.kind === "content-package"
      ? (orderedFiles.find(({ path }) => path === "opening.md")?.path ??
        orderedFiles.find(({ path }) => path === "world/current-situation.yaml")
          ?.path ??
        orderedFiles[0]?.path ??
        "")
      : (orderedFiles.find(({ path }) => path === "current-situation.yaml")
          ?.path ??
        orderedFiles[0]?.path ??
        "");
  const requested = controlledPath ?? requestedPath;
  const selectedPath = files.some(({ path }) => path === requested)
    ? requested
    : preferredPath;
  const selectedFile = files.find(({ path }) => path === selectedPath);
  const pathDraft =
    pathEdit.sourcePath === selectedPath ? pathEdit.value : selectedPath;
  const issues = workspace.kind === "content-package" ? workspace.issues : [];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleFiles =
    normalizedQuery.length === 0
      ? orderedFiles
      : orderedFiles.filter((file) =>
          searchableText(workspace.kind, file)
            .toLocaleLowerCase("zh-CN")
            .includes(normalizedQuery),
        );
  const groups = groupsFor(workspace.kind, visibleFiles);
  const selectedIssues = issues.filter(({ path }) => path === selectedPath);
  const pathError =
    workspace.kind === "content-package" && selectedFile !== undefined
      ? validateDraftPath(pathDraft, selectedFile.path, files)
      : "";
  const newPathError =
    workspace.kind === "content-package"
      ? validateDraftPath(newPath, undefined, files)
      : "";

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
    if (
      workspace.kind !== "content-package" ||
      selectedFile === undefined ||
      pathError.length > 0
    )
      return;
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
    if (workspace.kind !== "content-package") return;
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
    if (workspace.kind !== "content-package" || selectedFile === undefined)
      return;
    const remaining = files
      .filter(({ path }) => path !== selectedFile.path)
      .map((file) => ({ ...file }));
    select(nextSelectedPath(remaining, selectedFile.path, workspace.kind));
    workspace.onFilesChange(remaining);
  }

  function saveShortcut(): void {
    if (!workspace.dirty) return;
    if (workspace.kind === "content-package") workspace.onSave();
    else if (!workspace.pending) workspace.onPreview();
  }

  return (
    <div
      className={`content-file-workspace document-workbench document-workbench-${workspace.kind}`}
    >
      <aside
        className="content-file-sidebar"
        aria-label={
          workspace.kind === "content-package"
            ? uiText("内容包文件")
            : uiText("当前世界文档")
        }
      >
        <header>
          <div>
            <span className="content-editor-kicker">
              {workspace.kind === "content-package"
                ? uiText("当前草稿")
                : uiText("当前世界")}
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
              : uiText("当前世界文档")
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
                    const presentation = worldDocumentPresentation(file);
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
                          {workspace.kind === "world-correction" ? (
                            <span className="world-document-list-copy">
                              <span className="world-document-list-heading">
                                <strong>{presentation.title}</strong>
                                <code>{file.path}</code>
                              </span>
                              <small>{presentation.summary}</small>
                            </span>
                          ) : (
                            <code>{file.path}</code>
                          )}
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
        {workspace.kind === "content-package" ? (
          <details className="content-new-file">
            <summary>{uiText("新建文件")}</summary>
            <div>
              <label>
                {uiText("新文件路径")}
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
        ) : (
          <p className="world-correction-scope-note">
            {uiText("只修订已有世界文档；临时出现的地点不需要先建立档案。")}
          </p>
        )}
      </aside>

      <section
        className="content-file-editor"
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
                : uiText("当前世界没有可修订的状态文档。")}
            </p>
          </div>
        ) : (
          <>
            <header className="content-file-editor-header">
              <div>
                <span className="content-editor-kicker">
                  {workspace.kind === "content-package"
                    ? describeFile(selectedFile)
                    : uiText("全文编辑")}
                </span>
                <h4>
                  {workspace.kind === "content-package"
                    ? leafName(selectedFile.path)
                    : worldDocumentPresentation(selectedFile).title}
                </h4>
                {workspace.kind === "world-correction" ? (
                  <small>{selectedFile.path}</small>
                ) : null}
              </div>
              {workspace.kind === "content-package" ? (
                <button
                  type="button"
                  className="danger-button content-remove-file"
                  onClick={removeSelected}
                >
                  {uiText("从草稿移除")}
                </button>
              ) : (
                <span
                  className={
                    workspace.dirty
                      ? "document-workbench-dirty is-dirty"
                      : "document-workbench-dirty"
                  }
                >
                  {workspace.dirty
                    ? uiText("已修改 · 未预览")
                    : uiText("无本地修改")}
                </span>
              )}
            </header>
            {workspace.kind === "content-package" ? (
              <>
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
                {pathError.length > 0 && <p role="alert">{pathError}</p>}
              </>
            ) : null}
            {selectedFile.encoding === "base64" ? (
              <div className="content-binary-note" role="note">
                <strong>{uiText("二进制资源不在文本编辑器展开")}</strong>
                <span>
                  {uiText(
                    "当前 Base64 内容会原样保留；如需替换资源，请重新导入内容包。",
                  )}
                </span>
              </div>
            ) : workspace.kind === "content-package" &&
              selectedFile.path === "control/frame.yaml" ? (
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
                      : uiText("Ctrl / ⌘ + S 预览整笔修订")}
                  </small>
                </span>
                <textarea
                  rows={27}
                  spellCheck={false}
                  value={selectedFile.contents}
                  placeholder={editorPlaceholder(
                    selectedFile.path,
                    workspace.kind,
                  )}
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
            {workspace.kind === "world-correction" ? (
              <footer className="document-workbench-review">
                <div>
                  <strong>{uiText("应用前先审阅")}</strong>
                  <span>
                    {uiText(
                      "完整差异 · 真实 Prompt Preview · 一笔 Authority 修订",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!workspace.dirty || workspace.pending}
                  onClick={workspace.onPreview}
                >
                  {uiText("预览修订")}
                </button>
              </footer>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function searchableText(
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
  file: ContentTreeFile,
): string {
  if (kind === "content-package") return file.path;
  const presentation = worldDocumentPresentation(file);
  return `${file.path}\n${presentation.title}\n${presentation.summary}\n${presentation.ref}`;
}

function groupsFor(
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
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
          ["current", "当前情境"],
          ["characters", "人物"],
          ["locations", "地点"],
          ["relationships", "关系"],
          ["items", "物品"],
          ["rules", "规则"],
          ["other", "其他"],
        ];
  return definitions.flatMap(([id, label]) => {
    const selected = files.filter(({ path }) => groupFor(kind, path) === id);
    return selected.length === 0
      ? []
      : [{ id: id!, label: label!, files: selected }];
  });
}

function groupFor(
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
  path: string,
): string {
  if (kind === "content-package") {
    if (path === "opening.md") return "opening";
    if (path.startsWith("world/")) return "world";
    if (path.startsWith("control/")) return "control";
    return "other";
  }
  if (path === "current-situation.yaml" || path === "current-situation.md")
    return "current";
  const group = path.split("/")[0];
  return group === "characters" ||
    group === "locations" ||
    group === "relationships" ||
    group === "items" ||
    group === "rules"
    ? group
    : "other";
}

function validateDraftPath(
  rawPath: string,
  currentPath: string | undefined,
  files: readonly ContentTreeFile[],
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
  if (/\.json$/iu.test(path))
    return uiText("当前文件原生 V1 不接受 manifest 或 JSON 内容文件。");
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
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
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
    const groups = [
      "current",
      "characters",
      "locations",
      "relationships",
      "items",
      "rules",
      "other",
    ];
    return groups.indexOf(groupFor(kind, path));
  };
  return (
    rank(left.path) - rank(right.path) || left.path.localeCompare(right.path)
  );
}

function nextSelectedPath(
  remaining: readonly ContentTreeFile[],
  removedPath: string,
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
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
  return "TEXT";
}

function describeFile(file: ContentTreeFile): string {
  if (file.encoding === "base64") return uiText("二进制资源");
  if (file.path === "opening.md") return uiText("玩家首次行动前看到的开场白");
  if (file.path.startsWith("world/"))
    return uiText("会复制为世界状态的设定文档");
  if (file.path.startsWith("control/"))
    return uiText("会复制为世界控制的作者资产");
  return uiText("内容包文本资源");
}

function editorPlaceholder(
  path: string,
  kind: ContentPackageWorkspace["kind"] | WorldCorrectionWorkspace["kind"],
): string {
  if (kind === "world-correction") return uiText("输入完整 UTF-8 文档内容……");
  if (path === "opening.md")
    return uiText("写下玩家首次行动前立即看到的局面……");
  if (path.startsWith("world/") && /\.ya?ml$/iu.test(path))
    return uiText(
      "$document:\n  id: character.example\n  ref: example\n  title: 示例人物\n  summary: 一句话稳定简介。\n  aliases: []\n",
    );
  if (path.startsWith("world/") && /\.md$/iu.test(path))
    return uiText(
      "---\n$document:\n  id: rule.example\n  ref: example\n  title: 示例规则\n  summary: 一句话稳定简介。\n  aliases: []\n---\n\n# 示例规则\n",
    );
  return uiText("输入 UTF-8 文本内容……");
}

function lineCount(contents: string): number {
  return contents.length === 0 ? 0 : contents.split("\n").length;
}
