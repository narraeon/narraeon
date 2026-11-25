import { useMemo, useState } from "react";

import { gameplayPath } from "../protocol/gameplay.ts";
import type { ContentTreeFile } from "../protocol/v1.ts";
import { validRelativePath } from "../shared/world-documents/WorldDocumentSource.ts";
import { PlayerViewEditor } from "./PlayerViewEditor.tsx";
import { WorldFrameEditor } from "./WorldFrameEditor.tsx";
import { uiText } from "./i18n.ts";
import { playerViewControlPath } from "./player-view-control-draft.ts";

const controlPrefix = "control/";
const framePath = "control/frame.yaml";
const fullControlPath = (path: string): string => `${controlPrefix}${path}`;

export function WorldControlFilesEditor({
  files,
  state,
  editingDisabled,
  dirty,
  onChange,
  onPreview,
}: {
  files: readonly ContentTreeFile[];
  state: readonly ContentTreeFile[] | null;
  editingDisabled: boolean;
  dirty: boolean;
  onChange: (files: ContentTreeFile[]) => void;
  onPreview: () => void;
}): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState("");
  const [newPath, setNewPath] = useState("");
  const orderedFiles = useMemo(
    () => [...files].sort((left, right) => left.path.localeCompare(right.path)),
    [files],
  );
  const selected =
    orderedFiles.find(({ path }) => path === selectedPath) ??
    orderedFiles.find(({ path }) => fullControlPath(path) === framePath) ??
    orderedFiles[0];
  const path = selected === undefined ? "" : fullControlPath(selected.path);
  const gameplay = path.toLowerCase() === gameplayPath;
  const binary = selected?.encoding === "base64";
  const formFile = path === framePath || path === playerViewControlPath;
  const stateInputs = useMemo(
    () => state?.map((file) => ({ ...file, path: `state/${file.path}` })),
    [state],
  );
  const formInputs = useMemo(
    () =>
      stateInputs === undefined || !formFile
        ? undefined
        : [
            ...stateInputs,
            ...files.map((file) => ({
              ...file,
              path: fullControlPath(file.path),
            })),
          ],
    [files, formFile, stateInputs],
  );
  const newFile = newPath.trim();
  const relativeNewPath = newFile.startsWith(controlPrefix)
    ? newFile.slice(controlPrefix.length)
    : newFile;
  const pathError = validateNewControlPath(relativeNewPath, files);

  function replaceSelected(contents: string): void {
    if (selected === undefined || editingDisabled || gameplay || binary) return;
    onChange(
      files.map((file) => (file === selected ? { ...file, contents } : file)),
    );
  }

  function addFile(): void {
    if (editingDisabled || pathError !== null) return;
    onChange([...files, { path: relativeNewPath, contents: "" }]);
    setSelectedPath(relativeNewPath);
    setNewPath("");
  }

  function removeSelected(): void {
    if (selected === undefined || editingDisabled || gameplay || binary) return;
    onChange(files.filter((file) => file !== selected));
    setSelectedPath("");
  }

  return (
    <div className="world-control-files">
      <label className="world-control-file-picker">
        {uiText("选择控制文件")}
        <select
          value={path}
          disabled={orderedFiles.length === 0}
          onChange={(event) =>
            setSelectedPath(
              event.currentTarget.value.slice(controlPrefix.length),
            )
          }
        >
          {orderedFiles.map((file) => (
            <option key={file.path} value={fullControlPath(file.path)}>
              {fullControlPath(file.path)}
            </option>
          ))}
        </select>
      </label>
      <details className="content-new-file">
        <summary>{uiText("新建文件")}</summary>
        <fieldset
          className="world-control-file-fields"
          disabled={editingDisabled}
        >
          <label>
            {uiText("新文件路径")}
            <input
              value={newPath}
              placeholder="control/blocks/notes.md"
              onChange={(event) => setNewPath(event.currentTarget.value)}
            />
          </label>
          {newFile !== "" && pathError !== null && (
            <p role="alert">{pathError}</p>
          )}
          <button type="button" disabled={pathError !== null} onClick={addFile}>
            {uiText("加入草稿")}
          </button>
        </fieldset>
      </details>
      {selected === undefined ? null : (
        <>
          {!gameplay && !binary && (
            <button
              type="button"
              className="danger-button world-control-remove"
              disabled={editingDisabled}
              onClick={removeSelected}
            >
              {uiText("删除文件")}
            </button>
          )}
          {gameplay && (
            <p className="field-note">{uiText("世界的玩法在创建后固定。")}</p>
          )}
          {binary ? (
            <p className="field-note">
              {uiText("二进制资源不在文本预览中展开。")}
            </p>
          ) : formFile && formInputs === undefined ? (
            <p className="field-note" role="status">
              {uiText("正在读取当前世界文档…")}
            </p>
          ) : (
            <fieldset
              className="world-control-file-fields"
              disabled={editingDisabled}
            >
              {formInputs !== undefined && path === framePath ? (
                <WorldFrameEditor
                  key={path}
                  contents={selected.contents}
                  files={formInputs}
                  layout="world_revision"
                  dirty={dirty}
                  onChange={replaceSelected}
                  onSave={onPreview}
                />
              ) : formInputs !== undefined && path === playerViewControlPath ? (
                <PlayerViewEditor
                  key={path}
                  contents={selected.contents}
                  files={formInputs}
                  layout="world_revision"
                  onChange={replaceSelected}
                  onSave={onPreview}
                />
              ) : (
                <label className="content-source-editor">
                  <span>{uiText("文件内容")}</span>
                  <textarea
                    key={path}
                    rows={gameplay ? 5 : 14}
                    spellCheck={false}
                    readOnly={gameplay}
                    aria-label={uiText("编辑 {path}", { path })}
                    value={selected.contents}
                    onChange={(event) =>
                      replaceSelected(event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === "s"
                      ) {
                        event.preventDefault();
                        if (dirty) onPreview();
                      }
                    }}
                  />
                </label>
              )}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}

function validateNewControlPath(
  path: string,
  files: readonly ContentTreeFile[],
): string | null {
  if (!validRelativePath(path) || path.includes("\0"))
    return uiText("请输入有效的控制文件路径。");
  const normalized = path.toLowerCase();
  const fullPath = fullControlPath(normalized);
  if (fullPath === gameplayPath || fullPath.startsWith(`${gameplayPath}/`))
    return uiText("世界的玩法在创建后固定。");
  if (
    files.some((file) => {
      const current = file.path.toLowerCase();
      return (
        current === normalized ||
        current.startsWith(`${normalized}/`) ||
        normalized.startsWith(`${current}/`)
      );
    })
  )
    return uiText("路径与现有控制文件冲突。");
  return null;
}
