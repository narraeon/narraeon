import { useMemo, useState } from "react";

import type { ContentTreeFile } from "../protocol/v1.ts";
import { maxShortRefLength } from "../shared/world-document-format.ts";
import { shortRefPattern } from "../shared/world-documents/WorldDocumentSource.ts";
import { uiText } from "./i18n.ts";
import {
  readDraftIdentity,
  type WorldDocumentRoot,
} from "./world-document-draft.ts";
import {
  readWorldDocumentMetadata,
  type MetadataEdit,
} from "./world-document-metadata.ts";
import styles from "./WorldDocumentMetadataForm.module.css";

export function WorldDocumentMetadataForm({
  file,
  files,
  codec,
  root,
  fixedRefIds,
  onChange,
  onWriteBody,
}: {
  file: ContentTreeFile;
  files: readonly ContentTreeFile[];
  codec: "yaml" | "markdown";
  root: WorldDocumentRoot;
  fixedRefIds: ReadonlySet<string> | undefined;
  onChange: (contents: string) => void;
  onWriteBody: () => void;
}): React.JSX.Element {
  const metadata = useMemo(
    () => readWorldDocumentMetadata(file.contents, codec),
    [file.contents, codec],
  );
  const [failedEdit, setFailedEdit] = useState<string | null>(null);
  const [checkedRef, setCheckedRef] = useState<{
    value: string;
    path: string | undefined;
  } | null>(null);
  if (metadata === null)
    return (
      <p className={styles.repair}>
        {uiText("无法读取文档元数据。请在下方编辑源码修复。")}
      </p>
    );

  const fixedRef = fixedRefIds?.has(metadata.id) ?? false;
  const titleInvalid =
    [...metadata.title].length < 1 ||
    [...metadata.title].length > 120 ||
    (codec === "markdown" &&
      (metadata.title.trim() !== metadata.title || metadata.title === ""));
  const summaryInvalid =
    [...metadata.summary].length < 1 || [...metadata.summary].length > 240;
  const refInvalid =
    metadata.ref.length < 2 ||
    metadata.ref.length > maxShortRefLength ||
    !shortRefPattern.test(metadata.ref);
  const conflictingPath =
    checkedRef?.value === metadata.ref ? checkedRef.path : undefined;
  const refHint = fixedRef
    ? uiText("已应用的世界文档须保留原短引用。")
    : refInvalid
      ? uiText("请输入 2–32 个小写英文字母、数字或连字符，以字母开头。")
      : conflictingPath === undefined
        ? undefined
        : uiText("此短引用已用于 {path}。", { path: conflictingPath });

  const update = (change: MetadataEdit): void => {
    const next = metadata.edit(change);
    setFailedEdit(next === null ? file.contents : null);
    if (next !== null && next !== file.contents) onChange(next);
  };
  const checkRef = (value: string): void => {
    const match =
      value.length >= 2 &&
      value.length <= maxShortRefLength &&
      shortRefPattern.test(value)
        ? files.find(
            (other) =>
              other.path !== file.path &&
              readDraftIdentity(other, root)?.ref === value,
          )
        : undefined;
    setCheckedRef({ value, path: match?.path });
  };

  const title = (
    <>
      <span>{uiText("文档标题")}</span>
      {codec === "markdown" ? (
        <input
          aria-label={uiText("文档标题")}
          value={metadata.title}
          aria-invalid={titleInvalid}
          onChange={(event) =>
            update({ field: "title", value: event.target.value })
          }
        />
      ) : (
        <textarea
          rows={1}
          aria-label={uiText("文档标题")}
          value={metadata.title}
          aria-invalid={titleInvalid}
          onChange={(event) =>
            update({ field: "title", value: event.target.value })
          }
        />
      )}
      {titleInvalid && (
        <small>
          {uiText(
            codec === "markdown"
              ? "标题须为 1–120 个字符，首尾不能有空白。"
              : "标题须为 1–120 个字符。",
          )}
        </small>
      )}
    </>
  );
  return (
    <details className="file-metadata-disclosure">
      <summary>{uiText("编辑文档元数据")}</summary>
      <fieldset className={styles.form}>
        <legend>{uiText("文档元数据")}</legend>
        <button
          type="button"
          className={`secondary-button ${styles.writeBody}`}
          onClick={onWriteBody}
        >
          {uiText("继续写正文")}
        </button>
        <div className={styles.headingFields}>
          <label>{title}</label>
          <label>
            <span>{uiText("公开短引用")}</span>
            <span className={styles.reference}>
              <span aria-hidden="true">@</span>
              <input
                aria-label={uiText("公开短引用")}
                value={metadata.ref}
                readOnly={fixedRef}
                aria-invalid={refInvalid || conflictingPath !== undefined}
                spellCheck={false}
                autoCapitalize="none"
                onBlur={(event) => {
                  if (!fixedRef) checkRef(event.target.value);
                }}
                onChange={(event) => {
                  update({ field: "ref", value: event.target.value });
                }}
              />
            </span>
            {refHint !== undefined && <small>{refHint}</small>}
          </label>
        </div>
        <label>
          <span>{uiText("文档摘要")}</span>
          <textarea
            rows={2}
            aria-label={uiText("文档摘要")}
            value={metadata.summary}
            aria-invalid={summaryInvalid}
            onChange={(event) =>
              update({ field: "summary", value: event.target.value })
            }
          />
          {summaryInvalid && <small>{uiText("摘要须为 1–240 个字符。")}</small>}
        </label>
        <fieldset className={styles.aliases}>
          <legend>{uiText("文档别名")}</legend>
          {metadata.aliases.map((value, index) => {
            const invalid = [...value].length < 1 || [...value].length > 64;
            const label = { number: index + 1 };
            return (
              <div className={styles.aliasRow} key={index}>
                <label>
                  <span className="visually-hidden">
                    {uiText("别名 {number}", label)}
                  </span>
                  <textarea
                    rows={1}
                    aria-label={uiText("别名 {number}", label)}
                    value={value}
                    aria-invalid={invalid}
                    onChange={(event) =>
                      update({
                        field: "alias",
                        index,
                        value: event.target.value,
                      })
                    }
                  />
                  {invalid && <small>{uiText("别名须为 1–64 个字符。")}</small>}
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={uiText("移除别名 {number}", label)}
                  onClick={() => update({ field: "removeAlias", index })}
                >
                  {uiText("移除")}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="secondary-button"
            disabled={metadata.aliases.length >= 16}
            onClick={() => update({ field: "appendAlias" })}
          >
            {uiText("添加别名")}
          </button>
          {metadata.aliases.length > 16 && (
            <p>{uiText("最多可填写 16 个别名。")}</p>
          )}
        </fieldset>
        {failedEdit === file.contents && (
          <p role="alert">{uiText("无法用表单修改此处。请在下方编辑源码。")}</p>
        )}
      </fieldset>
    </details>
  );
}
