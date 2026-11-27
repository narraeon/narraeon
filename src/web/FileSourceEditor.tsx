import type { ReactNode, Ref } from "react";

import { uiText } from "./i18n.ts";

export function FileEditorMode({
  showSource,
  onSource,
  form,
}: {
  showSource: boolean;
  onSource: () => void;
  form?: { disabled: boolean; show: () => void };
}): React.JSX.Element {
  return (
    <div
      className="file-editor-mode"
      role="group"
      aria-label={uiText("文件编辑方式")}
    >
      {form !== undefined && (
        <button
          type="button"
          className="secondary-button"
          aria-pressed={!showSource}
          disabled={form.disabled}
          onClick={form.show}
        >
          {uiText("表单")}
        </button>
      )}
      <button
        type="button"
        className="secondary-button"
        aria-pressed={form === undefined ? undefined : showSource}
        onClick={onSource}
      >
        {uiText("源码")}
      </button>
    </div>
  );
}

export function FileSourceEditor({
  path,
  contents,
  rows = 27,
  readOnly = false,
  placeholder,
  shortcut,
  sourceRef,
  onChange,
}: {
  path: string;
  contents: string;
  rows?: number;
  readOnly?: boolean;
  placeholder?: string;
  shortcut?: ReactNode;
  sourceRef?: Ref<HTMLTextAreaElement>;
  onChange: (contents: string) => void;
}): React.JSX.Element {
  return (
    <label className="content-source-editor">
      <span>
        {uiText("文件源码")}
        {shortcut !== undefined && <small>{shortcut}</small>}
      </span>
      <textarea
        ref={sourceRef}
        rows={rows}
        spellCheck={false}
        readOnly={readOnly}
        value={contents}
        placeholder={placeholder}
        aria-label={uiText("编辑 {path}", { path })}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}
