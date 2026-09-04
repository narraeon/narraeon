import { useState } from "react";

import type { ContentTreeFile } from "../protocol/v1.ts";
import {
  DocumentWorkbench,
  type DocumentWorkbenchIssue,
} from "./DocumentWorkbench.tsx";
import { uiText } from "./i18n.ts";

export type ContentTreeIssue = DocumentWorkbenchIssue;

export interface ContentTreeEditorProps {
  mode?: "content-package" | "world-revision";
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
  title: string;
  onRename: (title: string) => void;
  selectedPath?: string;
  onSelectedPathChange?: (path: string) => void;
  embedded?: boolean;
  immutablePaths?: readonly string[];
}

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
  title,
  onRename,
  selectedPath,
  onSelectedPathChange,
  embedded = false,
  mode = "content-package",
  immutablePaths = [],
}: ContentTreeEditorProps): React.JSX.Element {
  const [titleDraft, setTitleDraft] = useState(title);
  const [lastTitle, setLastTitle] = useState(title);
  if (lastTitle !== title) {
    setLastTitle(title);
    setTitleDraft(title);
  }
  const worldCount = files.filter(({ path }) =>
    path.startsWith(mode === "world-revision" ? "state/" : "world/"),
  ).length;
  const controlCount = files.filter(({ path }) =>
    path.startsWith("control/"),
  ).length;
  const openingCount = files.filter(({ path }) => path === "opening.md").length;

  return (
    <section
      className={
        embedded
          ? "panel-card content-tree-editor is-embedded"
          : "panel-card content-tree-editor"
      }
    >
      <header className="section-heading-row content-tree-heading">
        <div>
          <h3>
            {mode === "world-revision"
              ? uiText("世界修订工作树")
              : uiText("内容包当前树")}
          </h3>
          <p className="field-note">
            {mode === "world-revision"
              ? uiText(
                  "手动编辑与 AI 共用这棵 state／control 工作树；保存后仍可逐次回滚，应用才会提交世界。",
                )
              : uiText(
                  "逐份编辑 YAML／Markdown；整批保存时才原子替换已保存版本。",
                )}
          </p>
        </div>
        <div
          className="content-tree-state"
          aria-label={uiText(
            mode === "world-revision" ? "世界修订状态" : "内容包编辑状态",
          )}
        >
          <span className={`package-status ${status}`}>
            {mode === "world-revision"
              ? uiText("工作树：")
              : uiText("已保存版本：")}
            {status === "usable" ? uiText("可用") : uiText("需要修复")}
          </span>
          <span className={dirty ? "draft-state dirty" : "draft-state"}>
            {dirty
              ? uiText("有未保存修改")
              : mode === "world-revision"
                ? uiText("没有未保存修改")
                : uiText("草稿与已保存版本一致")}
          </span>
        </div>
      </header>

      <dl
        className="content-tree-counts"
        aria-label={uiText(
          mode === "world-revision" ? "世界修订文件统计" : "内容包文件统计",
        )}
      >
        <div>
          <dt>{uiText("全部文件")}</dt>
          <dd>{files.length}</dd>
        </div>
        {mode === "content-package" ? (
          <div>
            <dt>{uiText("开场白")}</dt>
            <dd>{openingCount}</dd>
          </div>
        ) : null}
        <div>
          <dt>{uiText("世界内容")}</dt>
          <dd>{worldCount}</dd>
        </div>
        <div>
          <dt>{uiText("控制文件")}</dt>
          <dd>{controlCount}</dd>
        </div>
      </dl>

      <DocumentWorkbench
        {...(selectedPath === undefined ? {} : { selectedPath })}
        {...(onSelectedPathChange === undefined
          ? {}
          : { onSelectedPathChange })}
        workspace={
          mode === "world-revision"
            ? {
                kind: "world-revision",
                files,
                dirty,
                pending: false,
                issues,
                immutablePaths,
                onFilesChange,
                onSave,
              }
            : {
                kind: "content-package",
                files,
                dirty,
                issues,
                onFilesChange,
                onSave,
              }
        }
      />

      {issues.length > 0 && (
        <details className="content-package-diagnostics" open={!dirty}>
          <summary>
            {uiText("已保存版本有 {count} 项需要修复", {
              count: issues.length,
            })}
          </summary>
          {dirty && (
            <p>
              {uiText("诊断对应上一次保存；整批保存后会按新草稿重新检查。")}
            </p>
          )}
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
            <strong>
              {dirty
                ? uiText("草稿尚未保存")
                : mode === "world-revision"
                  ? uiText("修订工作树已保存")
                  : uiText("当前树已保存")}
            </strong>
            <span>
              {mode === "world-revision"
                ? uiText("保存只更新锁定工作树并留下可回滚记录，不会提交世界。")
                : uiText(
                    "保存会把整棵草稿作为一个候选原子替换，不会逐文件提交。",
                  )}
            </span>
          </div>
          <div className="button-row">
            <button type="button" disabled={!dirty} onClick={onSave}>
              {mode === "world-revision"
                ? uiText("保存到修订")
                : uiText("整批保存")}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!dirty}
              onClick={onReset}
            >
              {uiText("放弃未保存修改")}
            </button>
          </div>
        </div>
        {mode === "content-package" ? (
          <details className="content-package-actions">
            <summary>{uiText("内容包操作")}</summary>
            {dirty && (
              <p>
                {uiText("请先整批保存或放弃当前草稿，再操作已保存内容包。")}
              </p>
            )}
            <label className="content-package-rename">
              <span>{uiText("内容包标题")}</span>
              <input
                value={titleDraft}
                disabled={dirty}
                maxLength={160}
                onChange={(event) => setTitleDraft(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={
                  dirty ||
                  titleDraft.trim() === "" ||
                  titleDraft.trim() === title
                }
                onClick={() => onRename(titleDraft.trim())}
              >
                {uiText("重命名")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={dirty}
                onClick={onCopy}
              >
                {uiText("复制为新本地身份")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={dirty}
                onClick={onExport}
              >
                {uiText("导出 ZIP")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={dirty}
                onClick={onDelete}
              >
                {uiText("删除内容包")}
              </button>
            </div>
          </details>
        ) : null}
      </footer>
    </section>
  );
}
