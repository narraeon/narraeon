import { WorldControlFilesEditor } from "./WorldControlFilesEditor.tsx";
import { WorldPromptDiagnosticsPanel } from "./WorldPromptDiagnosticsPanel.tsx";
import { WorldMaintenancePanel } from "./WorldMaintenancePanel.tsx";
import {
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";

import {
  defaultAppReadingPreferences,
  type AppReadingPreferences,
} from "../protocol/appPreferences.ts";
import type {
  ContentTreeFile,
  V1PlayContextReadingView,
} from "../protocol/v1.ts";
import { useAndroidBack } from "./androidBridge.ts";
import { StoryMarkdown } from "./StoryMarkdown.tsx";
import {
  readWorldDocumentBody,
  worldDocumentPresentation,
} from "./worldDocumentPresentation.ts";
import { uiText } from "./i18n.ts";

export function WorldDocumentRail({
  documents,
  selectedPath,
  onSelect,
  onRevise,
  revisionDisabled = false,
}: {
  documents: readonly ContentTreeFile[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onRevise: (path: string) => void;
  revisionDisabled?: boolean;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const switcherRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  function closeMenu(): void {
    setMenuOpen(false);
    menuTrigger.current?.focus({ preventScroll: true });
  }
  useAndroidBack(menuOpen, closeMenu);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    function dismissOutside(event: PointerEvent): void {
      if (
        event.target instanceof Node &&
        !switcherRef.current?.contains(event.target)
      )
        setMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside, true);
    return () =>
      document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menuOpen]);
  const selected =
    documents.find(({ path }) => path === selectedPath) ?? documents[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible = useMemo(
    () =>
      normalizedQuery.length === 0
        ? documents
        : documents.filter((document) => {
            const metadata = worldDocumentPresentation(document);
            return `${metadata.title}\n${metadata.summary ?? ""}\n${metadata.ref === null ? "" : `@${metadata.ref}`}\n${document.path}`
              .toLocaleLowerCase("zh-CN")
              .includes(normalizedQuery);
          }),
    [documents, normalizedQuery],
  );

  return (
    <div className="world-document-rail">
      <div
        ref={switcherRef}
        className="world-document-switcher"
        onBlur={(event) => {
          if (
            menuOpen &&
            event.relatedTarget !== null &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setMenuOpen(false);
        }}
        onKeyDown={(event) => {
          if (!menuOpen || event.key !== "Escape" || event.defaultPrevented)
            return;
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }}
      >
        <button
          ref={menuTrigger}
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
                        closeMenu();
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
        <WorldDocumentCard
          key={selected.path}
          file={selected}
          onRevise={onRevise}
          revisionDisabled={revisionDisabled}
        />
      )}
    </div>
  );
}

function WorldDocumentCard({
  file,
  onRevise,
  revisionDisabled,
}: {
  file: ContentTreeFile;
  onRevise: (path: string) => void;
  revisionDisabled: boolean;
}): React.JSX.Element {
  const [sourceOpen, setSourceOpen] = useState(false);
  const reading = useMemo(() => readWorldDocumentBody(file), [file]);
  const { identity } = reading;
  return (
    <article className="world-document-card">
      <header>
        <div className="world-document-details">
          <details>
            <summary>{uiText("文档身份")}</summary>
            <dl>
              <dt>{uiText("文件路径")}</dt>
              <dd>
                <code>{file.path}</code>
              </dd>
              {identity !== undefined && (
                <>
                  <dt>{uiText("公开短引用")}</dt>
                  <dd>
                    <code>@{identity.shortRef}</code>
                  </dd>
                  <dt>{uiText("文档 ID")}</dt>
                  <dd>
                    <code>{identity.documentId}</code>
                  </dd>
                  <dt>{uiText("文档摘要")}</dt>
                  <dd>{identity.summary}</dd>
                  {identity.aliases.length > 0 && (
                    <>
                      <dt>{uiText("文档别名")}</dt>
                      <dd>{identity.aliases.join(" · ")}</dd>
                    </>
                  )}
                </>
              )}
            </dl>
          </details>
          {reading.kind !== "source" && (
            <details
              onToggle={(event) => setSourceOpen(event.currentTarget.open)}
            >
              <summary>{uiText("原始源码")}</summary>
              {sourceOpen && <pre>{file.contents}</pre>}
            </details>
          )}
        </div>
        <button
          type="button"
          disabled={revisionDisabled}
          onClick={() => onRevise(file.path)}
        >
          {uiText("修订")}
        </button>
      </header>
      {reading.kind === "markdown" ? (
        <StoryMarkdown
          className="world-document-markdown"
          text={reading.text}
        />
      ) : reading.kind === "yaml" && reading.text === "" ? (
        <p className="world-document-empty">{uiText("正文为空。")}</p>
      ) : (
        <pre>{reading.text}</pre>
      )}
    </article>
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
  onOpenFull: MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element {
  if (loading && reading === null)
    return <p role="status">{uiText("正在检查 AI 读过的世界文档…")}</p>;
  if (reading === null) return <p>{uiText("暂时无法加载 AI 读取记录。")}</p>;
  const rows = documentEvidence(reading, documents, "cumulative");
  return (
    <div className="ai-reading-rail">
      {reading.currentContext === null ? (
        <section className="ai-reading-context-card">
          <span>{uiText("暂无当前对话记录")}</span>
          <strong>{uiText("下一次行动将开启新对话")}</strong>
        </section>
      ) : (
        <section
          className={
            reading.currentContext.stale
              ? "ai-reading-context-card is-stale"
              : "ai-reading-context-card"
          }
        >
          <span>{uiText("最近一次请求材料")}</span>
          <strong>
            {reading.currentContext.requestHead ??
              reading.currentContext.baselineHead}
          </strong>
          <p>
            {reading.currentContext.stale
              ? uiText("当前世界已推进；这条追加上下文不能再继续。")
              : reading.nextFreshContext?.contextMode === "append"
                ? uiText("沿用现有对话时会重新编译提示。")
                : reading.nextFreshContext?.contextMode === "fresh"
                  ? uiText("当前发送预览采用全新上下文。")
                  : uiText("每次正常发送重新编译，工具往返使用本轮快照")}
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
          "记录显示实际发给模型的内容和工具返回的结果，无法确认模型记住了什么或会怎么做。",
        )}
      </p>
      <button type="button" onClick={onOpenFull}>
        {uiText("展开完整读取记录")}
      </button>
    </div>
  );
}

export function AiReadingDialog({
  syncNotice,
  reading,
  documents,
  feedback,
  onClose,
}: {
  syncNotice?: ReactNode;
  reading: V1PlayContextReadingView | null;
  documents: readonly ContentTreeFile[];
  feedback: ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <WorldPlayDialog
      className="world-workbench-dialog"
      titleId="ai-reading-audit-title"
      heading={
        <>
          <span>{uiText("发送与读取记录")}</span>
          <h2 id="ai-reading-audit-title">{uiText("AI 如何读取")}</h2>
          <p>{uiText("这里只查看上下文证据，不会开启修订或锁定世界。")}</p>
        </>
      }
      feedback={feedback}
      onClose={onClose}
    >
      {syncNotice}
      <AiReadingAudit reading={reading} documents={documents} />
    </WorldPlayDialog>
  );
}

function WorldPlayDialog({
  children,
  className,
  titleId,
  heading,
  feedback,
  onClose,
}: {
  children: ReactNode;
  className: string;
  titleId: string;
  heading: ReactNode;
  feedback: ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const tabBoundary = useRef<HTMLSpanElement>(null);
  const movingBackward = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  useAndroidBack(true, onClose);

  return (
    <dialog
      ref={dialogRef}
      className="world-dialog-scrim"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget || event.defaultPrevented)
          return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Tab" &&
          event.shiftKey &&
          event.target === closeButton.current &&
          !event.defaultPrevented
        ) {
          // Start the browser's backward Tab at the end so it can find the
          // last available control, including inside expanded disclosures.
          movingBackward.current = true;
          tabBoundary.current?.focus({ preventScroll: true });
          movingBackward.current = false;
        }
      }}
    >
      <div className={className}>
        <header>
          <div>{heading}</div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label={uiText("关闭")}
          >
            ×
          </button>
        </header>
        {children}
      </div>
      {feedback}
      <span
        ref={tabBoundary}
        className="visually-hidden"
        tabIndex={0}
        onFocus={() => {
          if (!movingBackward.current) closeButton.current?.focus();
        }}
      />
    </dialog>
  );
}

export function ReadingPreferencesPopover({
  id,
  triggerRef,
  value,
  saving,
  syncNotice,
  onChange,
  onClose,
  onDismissOutside,
}: {
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  value: AppReadingPreferences;
  saving: boolean;
  syncNotice: ReactNode;
  onChange: (value: AppReadingPreferences) => void;
  onClose: () => void;
  onDismissOutside: () => void;
}): React.JSX.Element {
  useAndroidBack(true, onClose);
  const close = useEffectEvent(onClose);
  const dismiss = useEffectEvent(onDismissOutside);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    function dismissOutside(event: MouseEvent): void {
      if (
        !(event.target instanceof Element) ||
        panelRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target)
      )
        return;
      const active = document.activeElement;
      const clickedControl = event.target.closest(
        "button, input, textarea, select, label, a[href], summary, [tabindex], [contenteditable]",
      );
      if (
        clickedControl === null &&
        (active === document.body || panelRef.current?.contains(active))
      )
        close();
      else dismiss();
    }
    function dismissEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    }
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [triggerRef]);

  const widthDescription = uiText(
    value.measure <= 40 ? "较窄" : value.measure >= 58 ? "较宽" : "适中",
  );
  return (
    <aside
      id={id}
      ref={panelRef}
      className="world-reading-popover"
      aria-label={uiText("阅读设置")}
    >
      <header>
        <strong>{uiText("阅读设置")}</strong>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={uiText("关闭")}
        >
          ×
        </button>
      </header>
      {syncNotice}
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
        output={widthDescription}
        valueText={widthDescription}
        min={32}
        max={72}
        step={2}
        onChange={(measure) => onChange({ ...value, measure })}
      />
      <div className="world-density-picker">
        <span>{uiText("排版密度")}</span>
        <div role="group" aria-label={uiText("排版密度")}>
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
              aria-pressed={value.density === density}
              onClick={() => onChange({ ...value, density })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="world-reading-technical-toggle">
        <input
          type="checkbox"
          checked={value.showTechnicalInfo}
          onChange={(event) =>
            onChange({ ...value, showTechnicalInfo: event.target.checked })
          }
        />
        <span>{uiText("显示技术信息")}</span>
      </label>
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
  valueText,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  output: string;
  valueText?: string;
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
        aria-valuetext={valueText}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function AiReadingAudit({
  reading,
  documents,
}: {
  syncNotice?: ReactNode;
  reading: V1PlayContextReadingView | null;
  documents: readonly ContentTreeFile[];
}): React.JSX.Element {
  if (reading === null)
    return (
      <div className="ai-reading-audit">
        <p role="status">{uiText("请先从侧栏加载 AI 读取记录。")}</p>
      </div>
    );
  const currentRows = documentEvidence(reading, documents, "current");
  const nextRows = documentEvidence(reading, documents, "next");
  const nextContext = reading.nextFreshContext;
  const nextCompilation = nextContext?.preview.compilation;
  const nextMode = nextContext?.contextMode;
  return (
    <div className="ai-reading-audit">
      <header>
        <div>
          <strong>{uiText("AI 读取记录与发送预览")}</strong>
          <p>
            {uiText(
              "这里可以查看最近一次请求、这段对话各轮读过的内容，以及下一次可能发送的材料。",
            )}
          </p>
        </div>
      </header>
      <div className="ai-reading-flow">
        <article>
          <span>{uiText("最近一次请求材料")}</span>
          <strong>
            {reading.currentContext?.requestHead ??
              reading.currentContext?.baselineHead ??
              uiText("暂无当前对话记录")}
          </strong>
          <p>{uiText("每次正常发送重新编译，工具往返使用本轮快照")}</p>
        </article>
        <span aria-hidden="true">→</span>
        <article>
          <span>{uiText("按需读取")}</span>
          <strong>
            {reading.currentContext?.reads.filter(({ ok }) => ok).length ?? 0}{" "}
            {uiText("次成功记录")}
          </strong>
          <p>{uiText("AI 在这段对话中读过")}</p>
        </article>
        <span aria-hidden="true">→</span>
        <article>
          <span>{uiText("下次发送的世界内容预览")}</span>
          <strong>{nextContext?.head ?? uiText("模型未配置")}</strong>
        </article>
      </div>
      <WorldPromptDiagnosticsPanel
        report={reading.currentContext?.prefixDiagnostics}
      />
      <WorldPromptDiagnosticsPanel
        report={nextContext?.prefixDiagnostics}
        preview
      />
      <EvidenceTable title={uiText("最近一次请求材料")} rows={currentRows} />
      <EvidenceTable title={uiText("下次发送的世界内容预览")} rows={nextRows} />
      <EvidenceTable
        title={uiText("AI 在这段对话中读过")}
        rows={documentEvidence(reading, documents, "cumulative")}
      />
      <WorldMaintenancePanel report={nextCompilation?.maintenance} />
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
        <summary>{uiText("查看各次请求保存的提示材料")}</summary>
        {reading.currentContext?.promptHistory?.map((request) => (
          <section key={request.exchange}>
            <h3>
              {request.playPreset.name} · {request.head} · {request.exchange}
            </h3>
            {request.bootstrap.logicalMessages.map((message, index) => (
              <pre key={index}>{message.markdown}</pre>
            ))}
          </section>
        ))}
      </details>
      <details className="ai-reading-raw">
        <summary>{uiText("查看最近一次请求保存的提示材料")}</summary>
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
        )) ?? <p>{uiText("暂无当前对话记录")}</p>}
      </details>
      <details className="ai-reading-raw">
        <summary>
          {nextMode === "append"
            ? uiText("查看下次编译材料：沿用现有对话")
            : nextMode === "fresh"
              ? uiText("查看下次编译材料：全新上下文")
              : uiText("查看下次编译材料")}
        </summary>
        {nextCompilation === undefined ? (
          <p>{uiText("配置模型后可查看下次发送的预览。")}</p>
        ) : (
          <>
            <p>
              {nextMode === "append"
                ? uiText(
                    "这里展示重新编译的提示和沿用的预载世界材料。已有对话会在发送时沿用，包括先前的消息和工具往返。",
                  )
                : nextMode === "fresh"
                  ? uiText(
                      "这里展示重新编译的提示和当前世界材料，也包含适用的已提交故事原文。发送时会开启新的模型对话。",
                    )
                  : uiText("这里展示下次正常发送的编译材料。")}
            </p>
            {nextCompilation.logicalMessages.map((message, index) => (
              <section key={index}>
                <h3>{message.role}</h3>
                <pre>{message.markdown}</pre>
              </section>
            ))}
            {nextCompilation.turnGuide === undefined ? null : (
              <section>
                <h3>{uiText("本轮提示")}</h3>
                <pre>{nextCompilation.turnGuide.text}</pre>
              </section>
            )}
          </>
        )}
        <p>
          {uiText(
            "要看某次实际派发的上下文，请在故事页的「阅读设置」开启「显示技术信息」，再在对应正文下展开「本段调用详情」和该步骤的「本次上下文」。",
          )}
        </p>
      </details>
      <p className="ai-reading-caveat">
        {uiText(
          "记录显示实际发给模型的内容和工具返回的结果，无法确认模型记住了什么或会怎么做。",
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
  target: "current" | "next" | "cumulative",
): DocumentEvidence[] {
  const context =
    target !== "next"
      ? reading.currentContext?.bootstrap
      : reading.nextFreshContext?.preview.compilation;
  const reads =
    target === "cumulative" ? (reading.currentContext?.reads ?? []) : [];
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
        detail: uiText("这是读取时的内容，可能与当前值不同"),
        tone: directRead.complete ? "good" : "warning",
      };
    const coverage =
      target === "cumulative"
        ? (reading.currentContext?.promptHistory?.flatMap(
            (request) => request.bootstrap.coverage,
          ) ?? context?.coverage)
        : context?.coverage;
    const direct = coverage?.find(
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
          target === "cumulative"
            ? uiText("这是读取时的内容，可能与当前值不同")
            : target === "current"
              ? uiText("列在最近一次请求的材料中")
              : uiText("列在下次发送的预览材料中"),
        tone: direct.complete ? "good" : "warning",
      };
    const catalog = coverage?.find(
      ({ catalogEntries }) =>
        metadata.ref !== null && catalogEntries?.includes(metadata.ref),
    );
    if (catalog !== undefined)
      return {
        path: document.path,
        title: metadata.title,
        label: uiText("标题 + 摘要"),
        detail: uiText("材料目录；正文没有因此进入上下文"),
        tone: "warning",
      };
    if (context === undefined)
      return {
        path: document.path,
        title: metadata.title,
        label: uiText("暂无记录"),
        detail:
          target === "next" ? uiText("模型未配置") : uiText("暂无当前对话记录"),
        tone: "muted",
      };
    return {
      path: document.path,
      title: metadata.title,
      label: uiText("未列出"),
      detail:
        target === "current"
          ? uiText("最近一次请求的材料未列出这份文档")
          : target === "cumulative"
            ? uiText("这段对话的请求材料未列出这份文档，也没有成功读取记录")
            : uiText("下次发送的预览未列出这份文档"),
      tone: "muted",
    };
  });
}

function baseRef(handle: string): string {
  return handle.replace(/^@/u, "").split("#/", 1)[0] ?? "";
}

export function WorldManagementDialog({
  syncNotice,
  worldBackupExport,
  packageScriptPermission,
  feedback,
  world,
  worldTitle,
  worldNameDraft,
  setWorldNameDraft,
  pending,
  activeStatus,
  controlEditorOpen,
  onControlEditorOpenChange,
  controlFiles,
  controlState,
  controlDirty,
  controlPreview,
  onControlFiles,
  onResetControl,
  onRename,
  onExportStory,
  onDerive,
  onPreviewControl,
  onApplyControl,
  onClose,
  modelConfigured,
  revisionLocked,
}: {
  syncNotice?: ReactNode;
  worldBackupExport?: ReactNode;
  packageScriptPermission?: ReactNode;
  feedback: ReactNode;
  world: { worldId: string; head: string; runtime: unknown };
  worldTitle: string;
  worldNameDraft: string;
  setWorldNameDraft: (value: string) => void;
  pending: string | null;
  activeStatus: string | null | undefined;
  controlEditorOpen: boolean;
  onControlEditorOpenChange: (open: boolean) => void;
  controlFiles: readonly ContentTreeFile[] | null;
  controlState: readonly ContentTreeFile[] | null;
  controlDirty: boolean;
  controlPreview: unknown;
  onControlFiles: (value: ContentTreeFile[]) => void;
  onResetControl: (() => void) | undefined;
  onRename: () => void;
  onExportStory: (format: "markdown" | "text") => void;
  onDerive: () => void;
  onPreviewControl: () => void;
  onApplyControl: () => void;
  onClose: () => void;
  modelConfigured: boolean;
  revisionLocked: boolean;
}): React.JSX.Element {
  const editingDisabled = revisionLocked || pending !== null;
  const canPreview =
    !editingDisabled && modelConfigured && controlFiles !== null;
  const preview = () => {
    if (canPreview) onPreviewControl();
  };
  return (
    <WorldPlayDialog
      className="world-management-dialog"
      titleId="world-management-title"
      heading={
        <>
          <h2 id="world-management-title">{uiText("世界管理")}</h2>
          <p>{uiText("管理名称、分叉、控制文件与 Runtime 诊断。")}</p>
        </>
      }
      feedback={feedback}
      onClose={onClose}
    >
      <div className="world-management-body">
        {syncNotice}
        <details className="world-permission-disclosure">
          <summary>{uiText("内容包脚本权限")}</summary>
          {packageScriptPermission}
        </details>
        {revisionLocked ? (
          <p className="setting-improvement-warning" role="status">
            {uiText(
              "世界修订期间，分叉和控制变更已锁定；本地显示名称仍可修改。",
            )}
          </p>
        ) : null}
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
              <span className="visually-hidden">{uiText("世界显示名称")}</span>
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
        <article className="manage-card">
          <div className="manage-card-copy">
            <h3>{uiText("导出故事")}</h3>
            <p>{uiText("下载当前时间线的开场白、玩家原文与主持正文。")}</p>
          </div>
          <div className="button-row">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => onExportStory("markdown")}
            >
              {uiText("导出 Markdown")}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => onExportStory("text")}
            >
              {uiText("导出纯文本")}
            </button>
          </div>
        </article>
        <article className="manage-card derive-card">
          <div>
            <h3>{uiText("从这里开新分支")}</h3>
            <p>{uiText("创建一个拥有独立状态与时间线的新世界。")}</p>
          </div>
          <button
            type="button"
            disabled={
              pending !== null || activeStatus === "running" || revisionLocked
            }
            onClick={onDerive}
          >
            {uiText("创建分叉")}
          </button>
        </article>
        {worldBackupExport}
        <details
          className="manage-disclosure"
          open={controlEditorOpen}
          onToggle={(event) =>
            onControlEditorOpenChange(event.currentTarget.open)
          }
        >
          <summary>{uiText("世界控制 · 高级编辑")}</summary>
          {controlEditorOpen && (
            <article className="manage-card control-card">
              <div className="manage-card-copy">
                <h3>{uiText("世界控制")}</h3>
                <p>{uiText("世界控制修改需先预览，再一次性应用。")}</p>
              </div>
              <span className="control-draft-state">
                {controlDirty
                  ? uiText("有尚未应用的修改")
                  : uiText("当前已应用控制")}
              </span>
              {controlFiles === null ? (
                <p className="field-note" role="status">
                  {uiText("正在读取世界控制文件…")}
                </p>
              ) : (
                <WorldControlFilesEditor
                  files={controlFiles}
                  state={controlState}
                  editingDisabled={editingDisabled}
                  dirty={controlDirty}
                  onChange={onControlFiles}
                  onPreview={preview}
                />
              )}
              <div className="button-row">
                <button type="button" disabled={!canPreview} onClick={preview}>
                  {uiText("预览世界控制")}
                </button>
                <button
                  type="button"
                  disabled={
                    pending !== null ||
                    controlPreview === null ||
                    activeStatus === "running" ||
                    revisionLocked
                  }
                  onClick={onApplyControl}
                >
                  {uiText("整批应用世界控制")}
                </button>
                {controlDirty && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending !== null || onResetControl === undefined}
                    onClick={onResetControl}
                  >
                    {uiText("放弃控制修改")}
                  </button>
                )}
              </div>
              {controlPreview === null ? null : (
                <details className="technical-details">
                  <summary>{uiText("查看真实提示词预览结果")}</summary>
                  <pre>{JSON.stringify(controlPreview, null, 2)}</pre>
                </details>
              )}
            </article>
          )}
        </details>
        <details className="manage-disclosure">
          <summary>{uiText("运行详情")}</summary>
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
        </details>
      </div>
    </WorldPlayDialog>
  );
}
