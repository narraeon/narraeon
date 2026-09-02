import { uiText } from "./i18n.ts";
import type { V1SettingPromptPreview } from "../protocol/v1.ts";
type CorrectionMaterial =
  | { kind: "document"; document: string }
  | {
      kind: "node";
      document: string;
      locator: { yaml: (string | number)[] } | { markdown: string[] };
    }
  | { kind: "history_message"; message: string }
  | { kind: "history_commit"; commit: string };

export interface CorrectionPreviewView {
  parentHead: string;
  candidateVersion: number;
  diffs: {
    documentId: string;
    path: string;
    beforeHash: string;
    afterHash: string;
    before: string;
    after: string;
  }[];
  materials: {
    before: readonly CorrectionMaterial[];
    after: readonly CorrectionMaterial[];
  };
  nextPrompt: V1SettingPromptPreview;
}

export function FileNativeCorrectionPanel({
  preview,
  pending = false,
  onApply,
  onBack,
  onCancel,
}: {
  preview: CorrectionPreviewView;
  pending?: boolean;
  onApply: () => void;
  onBack?: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <section
      className="correction-preview-panel"
      aria-labelledby="continuity-correction-title"
    >
      <header>
        <div>
          <p className="eyebrow">REVIEW BEFORE APPLY</p>
          <h4 id="continuity-correction-title">{uiText("确认修正内容")}</h4>
        </div>
        <span>
          {preview.diffs.length} {uiText("份文档会变化")}
        </span>
      </header>
      {preview.diffs.map((diff) => (
        <article className="correction-diff" key={diff.documentId}>
          <h3>{diff.path}</h3>
          <div className="correction-diff-columns">
            <section>
              <h4>{uiText("修正前")}</h4>
              <pre>{diff.before}</pre>
            </section>
            <section>
              <h4>{uiText("修正后")}</h4>
              <pre>{diff.after}</pre>
            </section>
          </div>
          <details className="technical-details">
            <summary>{uiText("查看内容 hash")}</summary>
            <p>
              {diff.beforeHash} → {diff.afterHash}
            </p>
          </details>
        </article>
      ))}
      <details className="technical-details">
        <summary>{uiText("查看端点、附加材料和下一次提示词")}</summary>
        <dl className="correction-technical-summary">
          <div>
            <dt>{uiText("父端点")}</dt>
            <dd>{preview.parentHead}</dd>
          </div>
          <div>
            <dt>{uiText("候选版本")}</dt>
            <dd>{preview.candidateVersion}</dd>
          </div>
        </dl>
        <h4>{uiText("完整附加材料清单差异")}</h4>
        <pre>{JSON.stringify(preview.materials, null, 2)}</pre>
        <h4>{uiText("下一次真实 Prompt Preview")}</h4>
        <ul>
          {preview.nextPrompt.compilation.coverage.map((entry, index) => (
            <li key={entry.slot + "-" + entry.source + "-" + index}>
              <code>{entry.slot}</code> · {entry.source} · {entry.status} ·{" "}
              {entry.complete ? uiText("完整") : uiText("不完整")}
            </li>
          ))}
        </ul>
        <details>
          <summary>{uiText("查看下一次上下文的完整文本块")}</summary>
          <pre>
            {preview.nextPrompt.compilation.logicalMessages
              .map(({ role, markdown }) => `## ${role}\n\n${markdown}`)
              .join("\n\n---\n\n")}
          </pre>
        </details>
      </details>
      <div className="button-row correction-preview-actions">
        <button disabled={pending} onClick={onApply} type="button">
          {uiText("应用这笔修正")}
        </button>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={onBack}
          type="button"
          hidden={onBack === undefined}
        >
          {uiText("返回编辑")}
        </button>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          {uiText("放弃修正草稿")}
        </button>
      </div>
    </section>
  );
}
