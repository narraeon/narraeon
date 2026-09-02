import { memo, useMemo } from "react";

import { uiText } from "./i18n.ts";
import { buildUnifiedDiffRows } from "./UnifiedTextDiffModel.ts";

export const UnifiedTextDiff = memo(function UnifiedTextDiff({
  before,
  after,
  label,
}: {
  before: string | null;
  after: string | null;
  label: string;
}): React.JSX.Element {
  const rows = useMemo(
    () => buildUnifiedDiffRows(before, after),
    [before, after],
  );
  return (
    <div className="unified-diff" role="table" aria-label={label}>
      <div className="visually-hidden" role="row">
        <span role="columnheader">{uiText("原文件行号")}</span>
        <span role="columnheader">{uiText("新文件行号")}</span>
        <span role="columnheader">{uiText("改动标记")}</span>
        <span role="columnheader">{uiText("行内容")}</span>
      </div>
      {rows.map((row, index) =>
        row.kind === "skip" ? (
          <div className="unified-diff-skip" role="row" key={`skip-${index}`}>
            <span aria-hidden="true">···</span>
            <span role="cell" aria-colspan={4}>
              {uiText("{count} 行未变化", { count: row.count })}
            </span>
          </div>
        ) : (
          <div
            className={`unified-diff-line unified-diff-${row.kind}`}
            role="row"
            key={`${row.kind}-${row.oldLine ?? ""}-${row.newLine ?? ""}-${index}`}
          >
            <span
              className="unified-diff-line-number"
              role="cell"
              aria-label={
                row.oldLine === null
                  ? uiText("原文件无对应行")
                  : uiText("原文件第 {line} 行", { line: row.oldLine })
              }
            >
              {row.oldLine ?? ""}
            </span>
            <span
              className="unified-diff-line-number"
              role="cell"
              aria-label={
                row.newLine === null
                  ? uiText("新文件无对应行")
                  : uiText("新文件第 {line} 行", { line: row.newLine })
              }
            >
              {row.newLine ?? ""}
            </span>
            <span className="unified-diff-marker" role="cell">
              <span className="visually-hidden">
                {row.kind === "remove"
                  ? uiText("删除行")
                  : row.kind === "add"
                    ? uiText("新增行")
                    : uiText("未变行")}
              </span>
              <span aria-hidden="true">{row.marker}</span>
            </span>
            <code role="cell">{row.text.length === 0 ? " " : row.text}</code>
          </div>
        ),
      )}
    </div>
  );
});
