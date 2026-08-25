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
  nextPromptMarkdown: string;
}

export function FileNativeCorrectionPanel({
  preview,
  pending = false,
  onApply,
  onCancel,
}: {
  preview: CorrectionPreviewView;
  pending?: boolean;
  onApply: () => void;
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
          <h4 id="continuity-correction-title">确认修正内容</h4>
        </div>
        <span>{preview.diffs.length} 份文档会变化</span>
      </header>
      {preview.diffs.map((diff) => (
        <article className="correction-diff" key={diff.documentId}>
          <h3>{diff.path}</h3>
          <div className="correction-diff-columns">
            <section>
              <h4>修正前</h4>
              <pre>{diff.before}</pre>
            </section>
            <section>
              <h4>修正后</h4>
              <pre>{diff.after}</pre>
            </section>
          </div>
          <details className="technical-details">
            <summary>查看内容 hash</summary>
            <p>
              {diff.beforeHash} → {diff.afterHash}
            </p>
          </details>
        </article>
      ))}
      <details className="technical-details">
        <summary>查看端点、附加材料和下一次提示词</summary>
        <dl className="correction-technical-summary">
          <div>
            <dt>父端点</dt>
            <dd>{preview.parentHead}</dd>
          </div>
          <div>
            <dt>候选版本</dt>
            <dd>{preview.candidateVersion}</dd>
          </div>
        </dl>
        <h4>完整附加材料清单差异</h4>
        <pre>{JSON.stringify(preview.materials, null, 2)}</pre>
        <h4>下一次真实 Prompt Preview</h4>
        <pre>{preview.nextPromptMarkdown}</pre>
      </details>
      <div className="button-row correction-preview-actions">
        <button disabled={pending} onClick={onApply} type="button">
          应用这笔修正
        </button>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          放弃修正草稿
        </button>
      </div>
    </section>
  );
}
