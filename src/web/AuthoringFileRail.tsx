import {
  ContentTreeEditor,
  type ContentTreeEditorProps,
} from "./ContentTreeEditor.tsx";
import {
  useAuthoringFileView,
  type AuthoringFileTarget,
  type AuthoringFileView,
} from "./authoring-file-list.ts";
import { uiText } from "./i18n.ts";
import type { Ref } from "react";

export function AuthoringFileRail({
  target,
  mode,
  open,
  onModeChange,
  onClose,
  closeButtonRef,
  contentEditor,
  editDisabled,
}: {
  target: AuthoringFileTarget;
  mode: "preview" | "edit";
  open: boolean;
  onModeChange: (mode: "preview" | "edit") => void;
  onClose: () => void;
  closeButtonRef: Ref<HTMLButtonElement>;
  contentEditor: ContentTreeEditorProps;
  editDisabled: boolean;
}): React.JSX.Element {
  const revisingWorld = target === "world-revision";
  const fileView = useAuthoringFileView(
    contentEditor.files,
    target,
    contentEditor.selectedPath,
  );
  return (
    <aside
      className={`setting-overlay-rail setting-overlay-rail-right ${
        mode === "edit" ? "is-editing" : ""
      } ${open ? "is-open" : ""}`}
      aria-hidden={!open}
      aria-label={
        mode === "edit"
          ? uiText(revisingWorld ? "世界修订文件编辑" : "内容包文件编辑")
          : uiText(revisingWorld ? "世界修订文件预览" : "内容包文件预览")
      }
    >
      <header>
        <div>
          <strong>
            {mode === "edit" ? uiText("编辑文件") : uiText("预览文件")}
          </strong>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label={uiText("收起文件面板")}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <nav
        aria-label={uiText(
          revisingWorld ? "世界修订文件视图" : "内容包文件视图",
        )}
      >
        <button
          type="button"
          className={mode === "preview" ? "is-current" : ""}
          onClick={() => onModeChange("preview")}
        >
          {uiText("预览")}
        </button>
        <button
          type="button"
          className={mode === "edit" ? "is-current" : ""}
          disabled={editDisabled}
          onClick={() => onModeChange("edit")}
        >
          {uiText("编辑")}
        </button>
      </nav>
      <div className="setting-overlay-rail-body">
        {mode === "preview" ? (
          <SettingContentPreview
            target={target}
            fileView={fileView}
            dirty={contentEditor.dirty}
            onEdit={() => onModeChange("edit")}
            editDisabled={editDisabled}
          />
        ) : (
          <fieldset disabled={editDisabled} style={{ display: "contents" }}>
            <ContentTreeEditor
              {...contentEditor}
              fileView={fileView}
              embedded
            />
          </fieldset>
        )}
      </div>
    </aside>
  );
}

function SettingContentPreview({
  target,
  fileView,
  dirty,
  onEdit,
  editDisabled,
}: {
  target: "content-package" | "world-revision";
  fileView: AuthoringFileView;
  dirty: boolean;
  onEdit: () => void;
  editDisabled: boolean;
}): React.JSX.Element {
  const revisingWorld = target === "world-revision";
  const { ordered, visible, selected, query, onQueryChange, onSelect } =
    fileView;

  return (
    <div className="setting-content-preview">
      <header>
        <div>
          <strong>
            {uiText(revisingWorld ? "世界修订工作树" : "内容包当前树")}
          </strong>
          <small>
            {dirty
              ? uiText("正在预览未保存的文件草稿")
              : uiText(
                  revisingWorld
                    ? "正在预览已保存的修订工作树"
                    : "正在预览已保存的当前树",
                )}
          </small>
        </div>
        <span>{uiText("{count} 份文件", { count: ordered.length })}</span>
      </header>
      <label>
        <span>{uiText("筛选文件")}</span>
        <input
          type="search"
          value={query}
          placeholder={uiText("标题、短引用或路径")}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>
      <nav
        aria-label={uiText(revisingWorld ? "世界修订文件树" : "内容包文件树")}
      >
        {visible.length === 0 ? (
          <p>{uiText("没有匹配的文件。")}</p>
        ) : (
          visible.map((file) => (
            <button
              type="button"
              key={file.path}
              className={file.path === selected?.path ? "is-current" : ""}
              aria-pressed={file.path === selected?.path}
              onClick={() => onSelect(file.path)}
            >
              <code>{file.path}</code>
            </button>
          ))
        )}
      </nav>
      {selected === undefined ? (
        <div className="setting-content-preview-empty">
          <p>
            {uiText(
              revisingWorld
                ? "当前修订工作树还没有文件。"
                : "当前内容包还没有文件。",
            )}
          </p>
          <button type="button" disabled={editDisabled} onClick={onEdit}>
            {uiText("新建第一份文件")}
          </button>
        </div>
      ) : (
        <article>
          <header>
            <code>{selected.path}</code>
            <button type="button" disabled={editDisabled} onClick={onEdit}>
              {uiText("编辑这份文件")}
            </button>
          </header>
          {selected.encoding === "base64" ? (
            <p>{uiText("二进制资源不在文本预览中展开。")}</p>
          ) : (
            <pre>{selected.contents}</pre>
          )}
        </article>
      )}
    </div>
  );
}
