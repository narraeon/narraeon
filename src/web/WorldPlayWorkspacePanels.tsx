import { useMemo, useState } from "react";

import {
  defaultAppReadingPreferences,
  type AppReadingPreferences,
} from "../protocol/appPreferences.ts";
import type {
  ContentTreeFile,
  V1PlayContextReadingView,
} from "../protocol/v1.ts";
import { DocumentWorkbench } from "./DocumentWorkbench.tsx";
import { worldDocumentPresentation } from "./worldDocumentPresentation.ts";
import {
  FileNativeCorrectionPanel,
  type CorrectionPreviewView,
} from "./FileNativeCorrectionPanel.tsx";
import { uiText } from "./i18n.ts";

export function WorldDocumentRail({
  documents,
  selectedPath,
  onSelect,
  onRevise,
}: {
  documents: readonly ContentTreeFile[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onRevise: (path: string) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected =
    documents.find(({ path }) => path === selectedPath) ?? documents[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible = useMemo(
    () =>
      normalizedQuery.length === 0
        ? documents
        : documents.filter((document) => {
            const metadata = worldDocumentPresentation(document);
            return `${metadata.title}\n${metadata.summary}\n${metadata.ref}\n${document.path}`
              .toLocaleLowerCase("zh-CN")
              .includes(normalizedQuery);
          }),
    [documents, normalizedQuery],
  );

  return (
    <div className="world-document-rail">
      <div className="world-document-switcher">
        <button
          type="button"
          className="world-document-switcher-trigger"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span>
            <small>{uiText("选择文档")}</small>
            <strong>
              {selected === undefined
                ? uiText("当前世界")
                : worldDocumentPresentation(selected).title}
            </strong>
          </span>
          <span>
            {documents.length} {uiText("份")} {menuOpen ? "▴" : "▾"}
          </span>
        </button>
        {menuOpen ? (
          <div className="world-document-menu">
            <label>
              <span className="visually-hidden">{uiText("查找当前文档")}</span>
              <input
                autoFocus
                type="search"
                value={query}
                placeholder={uiText("查找人物、地点、规则…")}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div role="listbox" aria-label={uiText("当前世界文档")}>
              {visible.length === 0 ? (
                <p>{uiText("没有匹配的文档")}</p>
              ) : (
                visible.map((document) => {
                  const metadata = worldDocumentPresentation(document);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected?.path === document.path}
                      key={document.path}
                      className={
                        selected?.path === document.path ? "is-current" : ""
                      }
                      onClick={() => {
                        onSelect(document.path);
                        setMenuOpen(false);
                        setQuery("");
                      }}
                    >
                      <strong>{metadata.title}</strong>
                      <small>{document.path}</small>
                    </button>
                  );
                })
              )}
            </div>
            <footer>
              {normalizedQuery.length === 0
                ? uiText("全部 {count} 份文档", { count: documents.length })
                : uiText("找到 {visible} / {total} 份", {
                    visible: visible.length,
                    total: documents.length,
                  })}
            </footer>
          </div>
        ) : null}
      </div>

      {selected === undefined ? (
        <p className="world-document-empty">
          {uiText("当前世界没有状态文档。")}
        </p>
      ) : (
        <article className="world-document-card">
          <header>
            <div>
              <strong>{worldDocumentPresentation(selected).title}</strong>
              <small>{worldDocumentPresentation(selected).summary}</small>
            </div>
            <button type="button" onClick={() => onRevise(selected.path)}>
              {uiText("修订")}
            </button>
          </header>
          <pre>{selected.contents}</pre>
        </article>
      )}
    </div>
  );
}

export function AiReadingRail({
  reading,
  loading,
  documents,
  onOpenFull,
}: {
  reading: V1PlayContextReadingView | null;
  loading: boolean;
  documents: readonly ContentTreeFile[];
  onOpenFull: () => void;
}): React.JSX.Element {
  if (loading && reading === null)
    return <p role="status">{uiText("正在核对 Runtime 读取记录…")}</p>;
  if (reading === null) return <p>{uiText("暂时无法读取上下文证据。")}</p>;
  const rows = documentEvidence(reading, documents, "current");
  return (
    <div className="ai-reading-rail">
      {reading.currentContext === null ? (
        <section className="ai-reading-context-card">
          <span>{uiText("当前没有追加上下文")}</span>
          <strong>{uiText("下一次行动将建立全新上下文")}</strong>
        </section>
      ) : (
        <section
          className={
            reading.currentContext.stale
              ? "ai-reading-context-card is-stale"
              : "ai-reading-context-card"
          }
        >
          <span>{uiText("当前冻结上下文")}</span>
          <strong>{reading.currentContext.baselineHead}</strong>
          <p>
            {reading.currentContext.stale
              ? uiText("当前世界已推进；这条追加上下文不能再继续。")
              : uiText("追加不会重新编译世界材料。")}
          </p>
        </section>
      )}
      <ol className="ai-reading-document-list">
        {rows.map((row) => (
          <li key={row.path} className={`is-${row.tone}`}>
            <span>{row.label}</span>
            <div>
              <strong>{row.title}</strong>
              <small>{row.detail}</small>
            </div>
          </li>
        ))}
      </ol>
      <p className="ai-reading-caveat">
        {uiText(
          "这里只证明 Runtime 发送或返回了什么，不声称 AI 理解、记住或正确使用。",
        )}
      </p>
      <button type="button" onClick={onOpenFull}>
        {uiText("展开完整读取记录")}
      </button>
    </div>
  );
}

export function ReadingPreferencesPopover({
  value,
  saving,
  onChange,
  onClose,
}: {
  value: AppReadingPreferences;
  saving: boolean;
  onChange: (value: AppReadingPreferences) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="world-reading-popover" aria-label={uiText("阅读设置")}>
      <header>
        <strong>{uiText("阅读设置")}</strong>
        <button type="button" onClick={onClose} aria-label={uiText("关闭")}>
          ×
        </button>
      </header>
      <div className="world-density-picker">
        <span>{uiText("排版密度")}</span>
        <div>
          {(
            [
              ["compact", uiText("紧凑")],
              ["standard", uiText("标准")],
              ["relaxed", uiText("舒展")],
            ] as const
          ).map(([density, label]) => (
            <button
              key={density}
              type="button"
              className={value.density === density ? "is-current" : ""}
              onClick={() => onChange({ ...value, density })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ReadingRange
        label={uiText("字号")}
        value={value.fontSize}
        output={value.fontSize + "px"}
        min={15}
        max={24}
        step={1}
        onChange={(fontSize) => onChange({ ...value, fontSize })}
      />
      <ReadingRange
        label={uiText("行距")}
        value={value.lineHeight}
        output={value.lineHeight.toFixed(1)}
        min={1.4}
        max={2.4}
        step={0.1}
        onChange={(lineHeight) => onChange({ ...value, lineHeight })}
      />
      <ReadingRange
        label={uiText("字间距")}
        value={value.letterSpacing}
        output={value.letterSpacing.toFixed(2) + "em"}
        min={0}
        max={0.12}
        step={0.01}
        onChange={(letterSpacing) => onChange({ ...value, letterSpacing })}
      />
      <ReadingRange
        label={uiText("正文宽度")}
        value={value.measure}
        output={value.measure + "rem"}
        min={32}
        max={72}
        step={2}
        onChange={(measure) => onChange({ ...value, measure })}
      />
      <button
        type="button"
        className="secondary-button world-reading-reset"
        onClick={() => onChange({ ...defaultAppReadingPreferences })}
      >
        {uiText("恢复默认")}
      </button>
      <small role="status">
        {saving ? uiText("正在保存…") : uiText("阅读设置保存在本机")}
      </small>
    </aside>
  );
}

function ReadingRange({
  label,
  value,
  output,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  output: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="world-reading-range">
      <span>{label}</span>
      <output>{output}</output>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

export function WorldRevisionDialog({
  files,
  selectedPath,
  dirty,
  preview,
  reading,
  tab,
  pending,
  onFilesChange,
  onSelectedPathChange,
  onTab,
  onPreview,
  onApply,
  onBack,
  onDiscard,
  onClose,
}: {
  files: readonly ContentTreeFile[];
  selectedPath: string;
  dirty: boolean;
  preview: CorrectionPreviewView | null;
  reading: V1PlayContextReadingView | null;
  tab: "manual" | "ai-reading";
  pending: boolean;
  onFilesChange: (files: ContentTreeFile[]) => void;
  onSelectedPathChange: (path: string) => void;
  onTab: (tab: "manual" | "ai-reading") => void;
  onPreview: () => void;
  onApply: () => void;
  onBack: () => void;
  onDiscard: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="world-dialog-scrim">
      <section
        className="world-workbench-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-revision-title"
      >
        <header>
          <div>
            <span>{uiText("故事之外")}</span>
            <h2 id="world-revision-title">{uiText("修订当前世界")}</h2>
            <p>{uiText("只改变从现在起成立的事实；旧叙事保持原样。")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={uiText("关闭")}>
            ×
          </button>
        </header>
        <nav aria-label={uiText("修订工作台")}>
          <button
            type="button"
            className={tab === "manual" ? "is-current" : ""}
            onClick={() => onTab("manual")}
          >
            {uiText("手动修正")}
          </button>
          <button
            type="button"
            className={tab === "ai-reading" ? "is-current" : ""}
            onClick={() => onTab("ai-reading")}
          >
            {uiText("AI 如何读取")}
          </button>
        </nav>
        {tab === "ai-reading" ? (
          <AiReadingAudit reading={reading} documents={files} />
        ) : preview === null ? (
          <div className="world-manual-revision">
            {dirty ? (
              <div className="world-revision-dirty-bar">
                <span>{uiText("有尚未预览的修改")}</span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={onDiscard}
                >
                  {uiText("放弃本地修改")}
                </button>
              </div>
            ) : null}
            <DocumentWorkbench
              selectedPath={selectedPath}
              onSelectedPathChange={onSelectedPathChange}
              workspace={{
                kind: "world-correction",
                files,
                dirty,
                pending,
                onFilesChange,
                onPreview,
              }}
            />
          </div>
        ) : (
          <div className="world-correction-review">
            <FileNativeCorrectionPanel
              preview={preview}
              pending={pending}
              onApply={onApply}
              onBack={onBack}
              onCancel={onDiscard}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function AiReadingAudit({
  reading,
  documents,
}: {
  reading: V1PlayContextReadingView | null;
  documents: readonly ContentTreeFile[];
}): React.JSX.Element {
  if (reading === null)
    return (
      <div className="ai-reading-audit">
        <p role="status">{uiText("请先从右侧 AI 读取页加载 Runtime 证据。")}</p>
      </div>
    );
  const currentRows = documentEvidence(reading, documents, "current");
  const nextRows = documentEvidence(reading, documents, "next");
  return (
    <div className="ai-reading-audit">
      <header>
        <div>
          <strong>{uiText("AI 实际收到了哪些世界内容")}</strong>
          <p>
            {uiText(
              "依据冻结 bootstrap 与已提交工具读取记录；不会把“世界里有这份文档”误写成“AI 已读”。",
            )}
          </p>
        </div>
      </header>
      <div className="ai-reading-flow">
        <article>
          <span>{uiText("当前上下文")}</span>
          <strong>
            {reading.currentContext?.baselineHead ?? uiText("尚未建立")}
          </strong>
          <p>{uiText("建立后追加不重新注入世界材料")}</p>
        </article>
        <span aria-hidden="true">→</span>
        <article>
          <span>{uiText("按需读取")}</span>
          <strong>
            {reading.currentContext?.reads.filter(({ ok }) => ok).length ?? 0}{" "}
            {uiText("次成功记录")}
          </strong>
          <p>{uiText("来自当前链已结算的 context_read")}</p>
        </article>
        <span aria-hidden="true">→</span>
        <article>
          <span>{uiText("下一次全新上下文")}</span>
          <strong>
            {reading.nextFreshContext?.head ?? uiText("模型未配置")}
          </strong>
          <p>{uiText("按当前世界重新运行真实 Prompt 编译")}</p>
        </article>
      </div>
      <EvidenceTable title={uiText("当前冻结上下文")} rows={currentRows} />
      <EvidenceTable title={uiText("下一次全新上下文")} rows={nextRows} />
      {reading.currentContext?.reads.length ? (
        <details className="ai-reading-raw">
          <summary>{uiText("查看按需读取返回的完整记录")}</summary>
          {reading.currentContext.reads.map((read) => (
            <section key={read.eventId}>
              <h3>{read.ref}</h3>
              <p>
                {read.ok
                  ? read.complete
                    ? uiText("读取成功 · 完整文档")
                    : uiText("读取成功 · 文档片段")
                  : uiText("读取失败")}
              </p>
              {read.markdown === null ? null : <pre>{read.markdown}</pre>}
            </section>
          ))}
        </details>
      ) : null}
      <details className="ai-reading-raw">
        <summary>{uiText("查看当前上下文的完整 Runtime 文本块")}</summary>
        {reading.currentContext?.bootstrap.logicalMessages.map((message) => (
          <section key={message.role}>
            <h3>{message.role}</h3>
            {message.blocks.map((block, index) => (
              <details key={block.source + "-" + index}>
                <summary>{block.source}</summary>
                <pre>{block.markdown}</pre>
              </details>
            ))}
          </section>
        )) ?? <p>{uiText("当前还没有冻结上下文。")}</p>}
      </details>
      <details className="ai-reading-raw">
        <summary>{uiText("查看下一次全新上下文的完整 Prompt Preview")}</summary>
        {reading.nextFreshContext?.preview.compilation.logicalMessages.map(
          (message) => (
            <section key={message.role}>
              <h3>{message.role}</h3>
              <pre>{message.markdown}</pre>
            </section>
          ),
        ) ?? <p>{uiText("配置模型后才能编译下一次上下文。")}</p>}
      </details>
      <p className="ai-reading-caveat">
        {uiText(
          "这些证据只能证明 Runtime 发出了哪些文本、工具返回了哪些内容；无法证明模型理解或记住。",
        )}
      </p>
    </div>
  );
}

function EvidenceTable({
  title,
  rows,
}: {
  title: string;
  rows: DocumentEvidence[];
}): React.JSX.Element {
  return (
    <section className="ai-reading-table">
      <h3>{title}</h3>
      <header>
        <span>{uiText("世界内容")}</span>
        <span>{uiText("进入方式")}</span>
        <span>{uiText("可核验依据")}</span>
      </header>
      {rows.map((row) => (
        <div key={row.path}>
          <span>{row.title}</span>
          <span className={`is-${row.tone}`}>{row.label}</span>
          <span>{row.detail}</span>
        </div>
      ))}
    </section>
  );
}

interface DocumentEvidence {
  path: string;
  title: string;
  label: string;
  detail: string;
  tone: "good" | "warning" | "muted";
}

function documentEvidence(
  reading: V1PlayContextReadingView,
  documents: readonly ContentTreeFile[],
  target: "current" | "next",
): DocumentEvidence[] {
  const context =
    target === "current"
      ? reading.currentContext?.bootstrap
      : reading.nextFreshContext?.preview.compilation;
  const reads =
    target === "current" ? (reading.currentContext?.reads ?? []) : [];
  return documents.map((document) => {
    const metadata = worldDocumentPresentation(document);
    const directRead = reads.find(
      ({ ref, ok }) => ok && baseRef(ref) === metadata.ref,
    );
    if (directRead !== undefined)
      return {
        path: document.path,
        title: metadata.title,
        label:
          directRead.locator === null
            ? directRead.complete
              ? uiText("精确全文")
              : uiText("全文片段")
            : directRead.complete
              ? uiText("精确节点")
              : uiText("节点片段"),
        detail: uiText("当前链已结算的 context_read 记录"),
        tone: directRead.complete ? "good" : "warning",
      };
    const direct = context?.coverage.find(
      ({ readAuthorization }) => readAuthorization?.shortRef === metadata.ref,
    );
    if (direct !== undefined)
      return {
        path: document.path,
        title: metadata.title,
        label:
          direct.complete && direct.readAuthorization?.locator === null
            ? uiText("全文")
            : uiText("节点"),
        detail:
          target === "current"
            ? uiText("冻结 bootstrap 的真实 coverage")
            : uiText("下一次 Prompt Preview 的真实 coverage"),
        tone: direct.complete ? "good" : "warning",
      };
    const catalog = context?.coverage.find(({ catalogEntries }) =>
      catalogEntries?.includes(metadata.ref),
    );
    if (catalog !== undefined)
      return {
        path: document.path,
        title: metadata.title,
        label: uiText("标题 + 摘要"),
        detail: uiText("材料目录；正文没有因此进入上下文"),
        tone: "warning",
      };
    return {
      path: document.path,
      title: metadata.title,
      label: uiText("未进入"),
      detail:
        target === "current"
          ? uiText("没有 bootstrap 注入或成功读取记录")
          : uiText("下一次 Prompt Preview 未选择这份文档"),
      tone: "muted",
    };
  });
}

function baseRef(handle: string): string {
  return handle.replace(/^@/u, "").split("#/", 1)[0] ?? "";
}

export function WorldManagementDialog({
  world,
  worldTitle,
  worldNameDraft,
  setWorldNameDraft,
  pending,
  activeStatus,
  controlFiles,
  controlDirty,
  controlPreview,
  onControlFiles,
  onRename,
  onDerive,
  onPreviewControl,
  onApplyControl,
  onClose,
  modelConfigured,
}: {
  world: { worldId: string; head: string; runtime: unknown };
  worldTitle: string;
  worldNameDraft: string;
  setWorldNameDraft: (value: string) => void;
  pending: string | null;
  activeStatus: string | null | undefined;
  controlFiles: string;
  controlDirty: boolean;
  controlPreview: unknown;
  onControlFiles: (value: string) => void;
  onRename: () => void;
  onDerive: () => void;
  onPreviewControl: () => void;
  onApplyControl: () => void;
  onClose: () => void;
  modelConfigured: boolean;
}): React.JSX.Element {
  return (
    <div className="world-dialog-scrim">
      <section
        className="world-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-management-title"
      >
        <header>
          <div>
            <span>{uiText("故事之外")}</span>
            <h2 id="world-management-title">{uiText("世界管理")}</h2>
            <p>{uiText("管理名称、分叉、控制文件与 Runtime 诊断。")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={uiText("关闭")}>
            ×
          </button>
        </header>
        <div className="world-management-body">
          <article className="manage-card world-name-card">
            <div className="manage-card-copy">
              <h3>{uiText("世界名称")}</h3>
              <p>{uiText("只改变工作区显示名称，不改变故事与状态。")}</p>
            </div>
            <form
              className="world-name-editor"
              onSubmit={(event) => {
                event.preventDefault();
                onRename();
              }}
            >
              <label>
                {uiText("世界显示名称")}
                <input
                  maxLength={160}
                  value={worldNameDraft}
                  onChange={(event) =>
                    setWorldNameDraft(event.currentTarget.value)
                  }
                />
              </label>
              <button
                type="submit"
                disabled={
                  pending !== null ||
                  worldNameDraft.trim() === "" ||
                  worldNameDraft.trim() === worldTitle
                }
              >
                {uiText("保存名称")}
              </button>
            </form>
          </article>
          <article className="manage-card derive-card">
            <div>
              <h3>{uiText("从当前端点创建分叉")}</h3>
              <p>{uiText("创建一个拥有独立状态与时间线的新世界。")}</p>
            </div>
            <button
              type="button"
              disabled={pending !== null || activeStatus === "running"}
              onClick={onDerive}
            >
              {uiText("创建分叉")}
            </button>
          </article>
          <article className="manage-card control-card">
            <div className="manage-card-copy">
              <h3>{uiText("世界控制")}</h3>
              <p>
                {uiText("控制草稿必须经过真实 Prompt Preview 后整批应用。")}
              </p>
            </div>
            <span className="control-draft-state">
              {controlDirty
                ? uiText("有尚未预览的修改")
                : uiText("当前已应用控制")}
            </span>
            <label>
              {uiText("世界控制文件（JSON）")}
              <textarea
                rows={18}
                value={controlFiles}
                onChange={(event) => onControlFiles(event.currentTarget.value)}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                disabled={pending !== null || !modelConfigured}
                onClick={onPreviewControl}
              >
                {uiText("预览世界控制")}
              </button>
              <button
                type="button"
                disabled={
                  pending !== null ||
                  controlPreview === null ||
                  activeStatus === "running"
                }
                onClick={onApplyControl}
              >
                {uiText("整批应用世界控制")}
              </button>
            </div>
            {controlPreview === null ? null : (
              <details className="technical-details">
                <summary>{uiText("查看真实提示词预览结果")}</summary>
                <pre>{JSON.stringify(controlPreview, null, 2)}</pre>
              </details>
            )}
          </article>
          <article className="manage-card runtime-card">
            <h3>{uiText("运行详情")}</h3>
            <dl className="runtime-summary">
              <div>
                <dt>{uiText("当前端点")}</dt>
                <dd>{world.head}</dd>
              </div>
              <div>
                <dt>{uiText("世界 ID")}</dt>
                <dd>{world.worldId}</dd>
              </div>
            </dl>
            <details className="technical-details">
              <summary>{uiText("查看 Runtime 原始诊断")}</summary>
              <pre>{JSON.stringify(world.runtime, null, 2)}</pre>
            </details>
          </article>
        </div>
      </section>
    </div>
  );
}
