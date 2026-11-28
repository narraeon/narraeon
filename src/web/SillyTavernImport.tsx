import type { PlayPresetReceipt } from "./PlayPresetScreen.tsx";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { V1Request } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";
import { scanVariables } from "../shared/sillytavern-variables.ts";
import { readScripts } from "./sillytavern-scripts.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { RuntimeRequestError } from "./RuntimeResponse.ts";
import { browserUUID } from "./browser-uuid.ts";
import { useModalDialog } from "./useModalDialog.ts";
import {
  explainSillyTavernDiagnostic,
  sillyTavernErrorMessage,
} from "./sillytavern-labels.ts";

import type {
  SillyTavernInspection,
  SillyTavernConversion,
} from "../shared/sillytavern-preset.ts";

function settingPurpose(path: string): string {
  const purposes: Record<string, string> = {
    temperature: uiText("控制采样随机性"),
    top_p: uiText("控制采样概率范围"),
    openai_max_context: uiText("上下文长度上限"),
    openai_max_tokens: uiText("生成长度上限"),
    frequency_penalty: uiText("降低重复频率"),
    presence_penalty: uiText("调整重复内容倾向"),
  };
  return purposes[path.split(".").at(-1) ?? ""] ?? "";
}

function markerMeaning(id: string): string {
  const labels: Record<string, string> = {
    main: uiText("主提示"),
    nsfw: uiText("成人内容提示"),
    jailbreak: uiText("越狱提示"),
    enhanceDefinitions: uiText("定义增强"),
    charDescription: uiText("角色描述"),
    charPersonality: uiText("角色性格"),
    scenario: uiText("场景"),
    personaDescription: uiText("玩家身份描述"),
    worldInfoBefore: uiText("世界书（之前）"),
    worldInfoAfter: uiText("世界书（之后）"),
    dialogueExamples: uiText("示例对话"),
    chatHistory: uiText("聊天历史"),
  };
  return labels[id] ?? id;
}

export function SillyTavernImport({
  client,
  disabled,
  onImported,
  canStartAiEditing,
  onFailure,
  librarySync,
}: {
  client: { request<T = unknown>(request: V1Request): Promise<T> };
  disabled: boolean;
  onImported: (receipt: PlayPresetReceipt, startAiEditing: boolean) => void;
  canStartAiEditing: boolean;
  onFailure?: () => Promise<unknown>;
  librarySync?: { failed: boolean; onRead: () => void };
}): React.JSX.Element {
  const [source, setSource] = useState<string>();
  const [name, setName] = useState("");
  const [inspection, setInspection] = useState<SillyTavernInspection>();
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const [activeScript, setActiveScript] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [preview, setPreview] = useState<SillyTavernConversion>();
  const [commandBusy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [fileReadFailed, setFileReadFailed] = useState(false);
  const busy = commandBusy || reading || readingFile;
  const open = readingFile || source !== undefined;
  const [inspectionQuery, setInspectionQuery] = useState<string | null>(null);
  const [openReference, setOpenReference] = useState<number>();
  const [openDeclaration, setOpenDeclaration] = useState<string>();
  const [visibleDeclarations, setVisibleDeclarations] = useState(100);
  const [visibleScripts, setVisibleScripts] = useState(100);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const fileErrorId = useId();
  const dialog = useModalDialog({
    open,
    busy,
    opener: picker,
    initialFocus: title,
    onDismiss: () => {
      if (openReference !== undefined) setOpenReference(undefined);
      else cancel();
    },
  });
  const operation = useRef<{ query: string; id: string } | undefined>(
    undefined,
  );

  async function readFile(file: File): Promise<void> {
    setFileReadFailed(false);
    setReadingFile(true);
    try {
      const text = await file.text();
      setSource(text);
      setName(file.name.replace(/\.json$/iu, "") || "SillyTavern");
      inspect(text);
    } catch {
      setFileReadFailed(true);
    } finally {
      setReadingFile(false);
    }
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      await onFailure?.();
      setError(
        cause instanceof Error
          ? sillyTavernErrorMessage(cause.message)
          : uiText("导入失败"),
      );
    } finally {
      setBusy(false);
    }
  }
  const {
    target: inspectionTarget,
    syncFailed: inspectionSyncFailed,
    syncError: inspectionSyncError,
  } = useReadTarget(
    useCallback(
      () =>
        client.request<SillyTavernInspection>(
          JSON.parse(inspectionQuery ?? "{}") as V1Request,
        ),
      [client, inspectionQuery],
    ),
    useCallback((result: SillyTavernInspection) => {
      setInspection(result);
      setActive(result.prompts[0]?.id);
      setActiveScript(undefined);
      setShowSettings(false);
      setShowResult(false);
      setSelected(sourceEnabledSelection(result));
      setPreview(undefined);
    }, []),
  );
  useEffect(() => {
    if (inspectionQuery === null) return;
    let active = true;
    void inspectionTarget.read().finally(() => {
      if (active) setReading(false);
    });
    return () => {
      active = false;
    };
  }, [inspectionTarget, inspectionQuery]);
  function inspect(input: string, groupId?: string): void {
    setReading(true);
    setPreview(undefined);
    setShowResult(false);
    const next = JSON.stringify({
      type: "play.sillytavern.inspect",
      source: input,
      ...(groupId === undefined ? {} : { groupId }),
    });
    if (next === inspectionQuery)
      void inspectionTarget.read().finally(() => setReading(false));
    else setInspectionQuery(next);
  }
  function cancel(): void {
    operation.current = undefined;
    setActive(undefined);
    setShowResult(false);
    setSource(undefined);
    setInspectionQuery(null);
    setInspection(undefined);
    setPreview(undefined);
    setSelected([]);
    setOpenReference(undefined);
    setOpenDeclaration(undefined);
    setError("");
  }
  const scripts = useMemo(
    () => (source === undefined ? [] : readScripts(source)),
    [source],
  );
  const selectedScript = scripts.find((script) => script.id === activeScript);
  const scans = useMemo(
    () =>
      inspection?.prompts
        .filter((prompt) => selected.includes(prompt.id))
        .map((prompt) => ({
          prompt,
          scan: scanVariables(prompt.content ?? ""),
        })) ?? [],
    [inspection, selected],
  );
  const activeContent = inspection?.prompts.find(
    (prompt) => prompt.id === active,
  )?.content;
  const activeGets = useMemo(
    () =>
      scanVariables(activeContent ?? "").tokens.filter(
        (token) => token.kind === "get",
      ),
    [activeContent],
  );
  const declarations = scans.flatMap(({ prompt, scan }) =>
    scan.tokens
      .filter((token) => token.kind === "set")
      .map((token) => ({ prompt, token, uncertain: scan.uncertain })),
  );
  const hasUncertainty = scans.some(({ scan }) => scan.uncertain);
  const scanWarning = uiText("扫描不完整或包含无法解析的宏。");
  const byName = new Map<string, typeof declarations>();
  for (const declaration of declarations) {
    const group = byName.get(declaration.token.name) ?? [];
    group.push(declaration);
    byName.set(declaration.token.name, group);
  }
  function uncertainName(name: string): boolean {
    const matches = byName.get(name) ?? [];
    return (
      hasUncertainty ||
      matches.length !== 1 ||
      matches.some(({ token }) => token.uncertain)
    );
  }
  function variableDescription(name: string): string {
    const matches = byName.get(name) ?? [];
    if (!matches.length)
      return (
        uiText("未找到选中的声明；运行时值未知。") +
        (hasUncertainty ? ` ${uiText("扫描不完整或包含无法解析的宏。")}` : "")
      );
    const uncertain = uncertainName(name);
    return `${uncertain ? uiText("候选不确定：可能受重复、控制流、动态宏或外部变量影响。") : uiText("静态候选（运行时值可能不同）：")} ${matches
      .slice(0, 5)
      .map(
        ({ prompt, token }) =>
          `${prompt.name}${prompt.enabled === false ? ` (${uiText("源停用")})` : ""}: ${token.value === undefined ? uiText("待解析") : token.value === "" ? uiText("空值") : token.value.slice(0, 300)}`,
      )
      .join("; ")}${matches.length > 5 ? ` … (${matches.length})` : ""}`;
  }
  function renderContent(content: string): React.JSX.Element {
    const gets = activeGets;
    let offset = 0;
    return (
      <pre>
        {gets.map((token) => {
          const before = content.slice(offset, token.start);
          offset = token.end;
          return (
            <span key={token.start}>
              {before}
              <span className="st-variable-anchor">
                <button
                  type="button"
                  className="st-variable-reference"
                  aria-describedby={
                    openReference === token.start
                      ? `st-ref-${token.start}`
                      : undefined
                  }
                  onMouseEnter={() => setOpenReference(token.start)}
                  onMouseLeave={() => setOpenReference(undefined)}
                  onFocus={() => setOpenReference(token.start)}
                  onBlur={() => setOpenReference(undefined)}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setOpenReference(token.start);
                  }}
                >
                  {token.raw}
                </button>
                {openReference === token.start && (
                  <span
                    id={`st-ref-${token.start}`}
                    className="st-variable-popover"
                    role="tooltip"
                  >
                    {variableDescription(token.name)}
                  </span>
                )}
              </span>
            </span>
          );
        })}
        {content.slice(offset)}
      </pre>
    );
  }
  const request = () => ({
    source: source!,
    ...(inspection?.selectedGroupId === undefined
      ? {}
      : { groupId: inspection.selectedGroupId }),
    selected,
    name: name.trim(),
  });
  const conversionQuery = JSON.stringify({
    type: "play.sillytavern.preview",
    ...request(),
  });
  const {
    target: conversionTarget,
    syncFailed: conversionSyncFailed,
    syncError: conversionSyncError,
  } = useReadTarget(
    useCallback(
      () =>
        client.request<SillyTavernConversion>(
          JSON.parse(conversionQuery) as V1Request,
        ),
      [client, conversionQuery],
    ),
    useCallback((result: SillyTavernConversion) => {
      setPreview(result);
      setShowResult(true);
    }, []),
  );
  async function convert(): Promise<void> {
    setReading(true);
    try {
      await conversionTarget.read();
    } finally {
      setReading(false);
    }
  }
  function importCopy(startAiEditing: boolean): void {
    const operationId =
      operation.current?.query === conversionQuery
        ? operation.current.id
        : browserUUID();
    operation.current = { query: conversionQuery, id: operationId };
    void run(async () => {
      const result = await client.request<PlayPresetReceipt>({
        type: "play.sillytavern.import",
        ...request(),
        operationId,
      });
      cancel();
      onImported(result, startAiEditing);
    });
  }
  return (
    <>
      <label className="play-preset-import-control">
        {uiText("导入 SillyTavern 预设")}
        <input
          ref={picker}
          aria-label={uiText("选择 SillyTavern JSON 文件")}
          aria-describedby={fileReadFailed ? fileErrorId : undefined}
          type="file"
          accept=".json,application/json"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void readFile(file);
          }}
        />
      </label>
      {fileReadFailed && (
        <p id={fileErrorId} role="alert">
          {uiText("无法读取 SillyTavern JSON 文件，请重新选择。")}
        </p>
      )}
      {open &&
        createPortal(
          <dialog
            {...dialog}
            className="sillytavern-import"
            aria-label={uiText("SillyTavern 导入向导")}
          >
            <header className="sillytavern-import-header">
              <h2 ref={title} tabIndex={-1}>
                {uiText("SillyTavern 导入向导")}
              </h2>
              <button
                type="button"
                disabled={busy}
                onClick={cancel}
                aria-label={uiText("关闭导入向导")}
              >
                ×
              </button>
            </header>
            <p>
              {uiText(
                "逐项选择要导入的内容；源启用状态与选择独立。动态占位由 Narraeon 自身机制处理，不保证等价。",
              )}
            </p>
            {error && <p role="alert">{error}</p>}
            {librarySync && (
              <SyncNotice
                failed={librarySync.failed}
                onRead={librarySync.onRead}
              />
            )}
            <SyncNotice
              failed={inspectionSyncFailed}
              onRead={() => void inspectionTarget.recover()}
            />
            <SyncNotice
              failed={conversionSyncFailed}
              onRead={() => void conversionTarget.recover()}
            />
            {[inspectionSyncError, conversionSyncError].map((reason, index) =>
              reason instanceof RuntimeRequestError &&
              reason.kind === "runtime" ? (
                <p key={index} role="alert">
                  {sillyTavernErrorMessage(reason.message)}
                </p>
              ) : null,
            )}
            {source !== undefined && inspection && (
              <>
                <div className="st-import-fields">
                  <label>
                    {uiText("新编排方案名称")}
                    <input
                      disabled={busy}
                      value={name}
                      onChange={(event) => {
                        setName(event.currentTarget.value);
                        setPreview(undefined);
                        setShowResult(false);
                      }}
                    />
                  </label>
                  {inspection.groups.length > 0 && (
                    <label>
                      {uiText("源顺序组")}
                      <select
                        aria-label={uiText("源顺序组")}
                        value={inspection.selectedGroupId ?? ""}
                        disabled={busy}
                        onChange={(event) => {
                          const id = event.currentTarget.value;
                          if (id) inspect(source, id);
                        }}
                      >
                        <option value="" disabled>
                          {uiText("请选择顺序组")}
                        </option>
                        {inspection.groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {!showResult && (
                  <div className="import-browser">
                    <nav
                      className="import-browser-list"
                      aria-label={uiText("来源目录")}
                    >
                      <div className="st-selection-actions">
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !inspection.prompts.some(({ ordered }) => ordered)
                          }
                          onClick={() => {
                            setSelected(sourceEnabledSelection(inspection));
                            setPreview(undefined);
                          }}
                        >
                          {uiText("选择源中已启用项")}
                        </button>
                        <button
                          type="button"
                          disabled={busy || selected.length === 0}
                          onClick={() => {
                            setSelected([]);
                            setPreview(undefined);
                          }}
                        >
                          {uiText("清空选择")}
                        </button>
                      </div>
                      {[true, false].map((ordered) => (
                        <section key={String(ordered)}>
                          <h3>
                            {ordered ? uiText("源顺序") : uiText("未编排提示")}
                          </h3>
                          {inspection.prompts
                            .filter((prompt) => prompt.ordered === ordered)
                            .map((prompt) => (
                              <div
                                className={`import-browser-row ${!showSettings && !activeScript && active === prompt.id ? "active" : ""}`}
                                key={prompt.id}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={prompt.name}
                                  checked={selected.includes(prompt.id)}
                                  disabled={busy}
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    setSelected((current) =>
                                      checked
                                        ? [...current, prompt.id]
                                        : current.filter(
                                            (id) => id !== prompt.id,
                                          ),
                                    );
                                    setPreview(undefined);
                                  }}
                                />
                                <button
                                  type="button"
                                  aria-label={prompt.name}
                                  aria-pressed={
                                    !showSettings &&
                                    !activeScript &&
                                    active === prompt.id
                                  }
                                  onClick={() => {
                                    setActive(prompt.id);
                                    setActiveScript(undefined);
                                    setShowSettings(false);
                                  }}
                                >
                                  {prompt.name}
                                  <small>
                                    {prompt.role ?? "—"} ·{" "}
                                    {prompt.enabled === undefined
                                      ? "—"
                                      : prompt.enabled
                                        ? uiText("启用")
                                        : uiText("停用")}
                                  </small>
                                  {(prompt.marker || prompt.missing) && (
                                    <small>
                                      {prompt.marker
                                        ? uiText("动态占位")
                                        : uiText("缺失定义")}
                                    </small>
                                  )}
                                </button>
                              </div>
                            ))}
                        </section>
                      ))}
                      <section className="st-script-list">
                        <h3>{uiText("脚本（仅查看）")}</h3>
                        <p>
                          {uiText(
                            "仅识别酒馆助手脚本和正则规则，不加载外部文件；其他结构未解析。",
                          )}
                        </p>
                        {scripts.slice(0, visibleScripts).map((script) => (
                          <button
                            type="button"
                            key={script.id}
                            aria-pressed={activeScript === script.id}
                            onClick={() => {
                              setActiveScript(script.id);
                              setShowSettings(false);
                            }}
                          >
                            {script.name}
                          </button>
                        ))}
                        {visibleScripts < scripts.length && (
                          <button
                            type="button"
                            onClick={() =>
                              setVisibleScripts((count) => count + 100)
                            }
                          >
                            {uiText("显示更多脚本")}
                          </button>
                        )}
                      </section>
                      <button
                        type="button"
                        aria-pressed={showSettings}
                        onClick={() => {
                          setActiveScript(undefined);
                          setShowSettings(true);
                        }}
                      >
                        {uiText("未迁移的设置")}
                      </button>
                    </nav>
                    <div className="import-browser-detail">
                      {declarations.length === 0 && (
                        <p className="st-variable-empty">
                          {uiText("尚无选中的声明")}
                          {hasUncertainty && <> · {scanWarning}</>}
                        </p>
                      )}
                      {inspection.prompts
                        .filter(
                          (prompt) =>
                            !showSettings &&
                            !activeScript &&
                            prompt.id === active,
                        )
                        .map((prompt) => (
                          <article
                            key={prompt.id}
                            className="sillytavern-prompt"
                          >
                            <h3>{prompt.name}</h3>
                            {prompt.content !== undefined && (
                              <>
                                <h4>{uiText("提示词正文")}</h4>
                                {renderContent(prompt.content)}
                              </>
                            )}
                            <details className="st-metadata">
                              <summary>{uiText("来源字段详情")}</summary>
                              <p>
                                {prompt.path} · ID: {prompt.id} ·{" "}
                                {uiText("发送角色")}: {prompt.role ?? "—"} ·{" "}
                                {uiText("源启用状态")}:{" "}
                                {prompt.enabled === undefined
                                  ? "—"
                                  : prompt.enabled
                                    ? uiText("启用")
                                    : uiText("停用")}
                              </p>
                              <p>
                                {uiText("插入位置")}:{" "}
                                {prompt.injectionPosition === undefined ||
                                prompt.injectionPosition === 0
                                  ? uiText("提示顺序")
                                  : prompt.injectionPosition === 1
                                    ? uiText("历史深度")
                                    : prompt.injectionPosition}{" "}
                                · {uiText("深度")}:{" "}
                                {prompt.injectionDepth ?? "—"} ·{" "}
                                {uiText("优先级")}:{" "}
                                {prompt.injectionOrder ?? "—"}
                              </p>
                              <p>
                                {uiText("触发条件")}:{" "}
                                {prompt.triggers?.length
                                  ? prompt.triggers.join(", ")
                                  : uiText("全部生成类型")}{" "}
                                · {uiText("宏")}:{" "}
                                {prompt.macros.length
                                  ? prompt.macros.join(", ")
                                  : "—"}{" "}
                                · {uiText("禁止覆盖")}:{" "}
                                {prompt.forbidOverrides === undefined
                                  ? "—"
                                  : prompt.forbidOverrides
                                    ? uiText("是")
                                    : uiText("否")}
                              </p>
                              <p>
                                {uiText("系统管理提示")}:{" "}
                                {prompt.systemPrompt === undefined
                                  ? "—"
                                  : prompt.systemPrompt
                                    ? uiText("是")
                                    : uiText("否")}{" "}
                                · {uiText("扩展提示")}:{" "}
                                {prompt.extension === undefined
                                  ? "—"
                                  : prompt.extension
                                    ? uiText("是")
                                    : uiText("否")}{" "}
                                · {uiText("源 position 字段")}:{" "}
                                {prompt.position ?? "—"}
                              </p>
                              {prompt.unsupportedPaths.length > 0 && (
                                <p>
                                  {uiText("不支持的字段路径")}:{" "}
                                  {prompt.unsupportedPaths.join(", ")}
                                </p>
                              )}
                              {prompt.marker && (
                                <p>
                                  {uiText("动态材料占位，无静态正文。")}{" "}
                                  {markerMeaning(prompt.id)}
                                </p>
                              )}
                              {prompt.missing && (
                                <p>
                                  {uiText("源文件未携带此内建定义。")}{" "}
                                  {markerMeaning(prompt.id)} ·{" "}
                                  {uiText("无法迁移动态或缺失的内建内容。")}
                                </p>
                              )}
                              {prompt.reasons.map((reason) => (
                                <p key={reason}>
                                  {explainSillyTavernDiagnostic(reason)}
                                </p>
                              ))}
                            </details>
                          </article>
                        ))}
                      {selectedScript && (
                        <article>
                          <h3>{selectedScript.name}</h3>
                          <p>
                            {selectedScript.id} ·{" "}
                            {selectedScript.kind === "regex"
                              ? uiText("正则规则")
                              : uiText("脚本")}{" "}
                            · {uiText("源启用状态")}:{" "}
                            {selectedScript.enabled === undefined
                              ? "—"
                              : selectedScript.enabled
                                ? uiText("启用")
                                : uiText("停用")}
                          </p>
                          {selectedScript.kind === "script" ? (
                            selectedScript.content === undefined ? (
                              <p>
                                {uiText("未携带源码")}
                                {selectedScript.reference &&
                                  `: ${selectedScript.reference}`}
                              </p>
                            ) : (
                              <>
                                <h4>{uiText("源码")}</h4>
                                <pre>{selectedScript.content}</pre>
                              </>
                            )
                          ) : (
                            <>
                              <h4>findRegex</h4>
                              {selectedScript.findRegex === undefined ? (
                                <p>{uiText("未携带内容")}</p>
                              ) : (
                                <pre>{selectedScript.findRegex}</pre>
                              )}
                              <h4>replaceString</h4>
                              {selectedScript.replaceString === undefined ? (
                                <p>{uiText("未携带内容")}</p>
                              ) : (
                                <pre>{selectedScript.replaceString}</pre>
                              )}
                              <h4>{uiText("规则")}</h4>
                              <pre>{selectedScript.rules.join("\n")}</pre>
                            </>
                          )}
                        </article>
                      )}
                      {showSettings && (
                        <div>
                          <h3>{uiText("未迁移的设置")}</h3>
                          <p>
                            {uiText(
                              "模型、端点、采样与扩展设置不会应用；凭据值不会显示或保存。",
                            )}
                          </p>
                          <ul>
                            {inspection.settings.map((setting) => (
                              <li key={setting.path}>
                                {setting.path} —{" "}
                                {explainSillyTavernDiagnostic(setting.category)}
                                {setting.value !== undefined && (
                                  <>
                                    {" "}
                                    — {setting.value}{" "}
                                    {settingPurpose(setting.path)}
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    {declarations.length > 0 && (
                      <details className="st-variables" open>
                        <summary>{uiText("选中提示中的变量声明")}</summary>
                        <p>
                          {uiText(
                            "仅静态阅读：按来源顺序列出，不代表运行顺序或运行时值；外部聊天变量不可知。",
                          )}
                        </p>
                        {hasUncertainty && <p>{scanWarning}</p>}
                        <ul>
                          {declarations
                            .slice(0, visibleDeclarations)
                            .map(({ prompt, token }, index) => (
                              <li key={`${prompt.id}-${token.start}-${index}`}>
                                <strong>
                                  {token.name || uiText("动态名称")}
                                </strong>{" "}
                                — {prompt.name}{" "}
                                {prompt.enabled === false &&
                                  `(${uiText("源停用")})`}{" "}
                                ·{" "}
                                {uncertainName(token.name)
                                  ? uiText("候选不确定")
                                  : uiText("静态候选")}
                                :{" "}
                                {token.value === undefined
                                  ? uiText("待解析")
                                  : token.value === ""
                                    ? uiText("空值")
                                    : token.value.slice(0, 150)}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setOpenDeclaration(
                                      openDeclaration ===
                                        `${prompt.id}-${token.start}`
                                        ? undefined
                                        : `${prompt.id}-${token.start}`,
                                    )
                                  }
                                >
                                  {token.scoped
                                    ? uiText("声明开头（待解析）")
                                    : uiText("声明原文")}
                                </button>
                                {openDeclaration ===
                                  `${prompt.id}-${token.start}` && (
                                  <pre>{token.raw}</pre>
                                )}
                              </li>
                            ))}
                        </ul>
                        {visibleDeclarations < declarations.length && (
                          <button
                            type="button"
                            onClick={() =>
                              setVisibleDeclarations((count) => count + 100)
                            }
                          >
                            {uiText("显示更多声明")}
                          </button>
                        )}
                      </details>
                    )}
                  </div>
                )}
                {showResult && preview && (
                  <section
                    className="import-result"
                    aria-label={uiText("转换预览")}
                  >
                    <button type="button" onClick={() => setShowResult(false)}>
                      {uiText("返回来源")}
                    </button>
                    <details>
                      <summary>{uiText("来源选择")}</summary>
                      <ol aria-label={uiText("源顺序")}>
                        {inspection.prompts.map((prompt) => (
                          <li key={prompt.id}>
                            {prompt.name} · {uiText("源启用状态")}{" "}
                            {prompt.enabled === undefined
                              ? "—"
                              : uiText(
                                  prompt.enabled ? "已启用" : "已停用",
                                )}{" "}
                            ·{" "}
                            {uiText(
                              selected.includes(prompt.id)
                                ? "已选择"
                                : "未选择",
                            )}
                            {!prompt.ordered && ` · ${uiText("未编排提示")}`}
                          </li>
                        ))}
                      </ol>
                    </details>
                    <h3>{uiText("目标编排方案")}</h3>
                    <ul>
                      {preview.target.map((item, index) => (
                        <li key={index}>
                          {item.name} —{" "}
                          {explainSillyTavernDiagnostic(item.kind)} —{" "}
                          {item.enabled ? uiText("启用") : uiText("停用")}
                        </li>
                      ))}
                    </ul>
                    <h3>{uiText("兼容报告")}</h3>
                    <ul>
                      {preview.report.map((item, index) => (
                        <li key={index}>
                          {item.code} · {item.path} {item.name} —{" "}
                          {explainSillyTavernDiagnostic(item.code)} —{" "}
                          {explainSillyTavernDiagnostic(item.result)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <footer className="st-import-footer">
                  <p>
                    {uiText("已选择")}: {selected.length}
                  </p>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !name.trim() ||
                      (inspection.groups.length > 0 &&
                        !inspection.selectedGroupId)
                    }
                    onClick={() => void convert()}
                  >
                    {uiText("转换预览")}
                  </button>
                  {showResult && preview && (
                    <>
                      <button
                        type="button"
                        disabled={busy || disabled}
                        onClick={() => importCopy(false)}
                      >
                        {uiText("导入独立副本")}
                      </button>
                      {canStartAiEditing && (
                        <button
                          type="button"
                          disabled={busy || disabled}
                          onClick={() => importCopy(true)}
                        >
                          {uiText("导入并用 AI 整理")}
                        </button>
                      )}
                    </>
                  )}
                  <button type="button" disabled={busy} onClick={cancel}>
                    {uiText("取消")}
                  </button>
                </footer>
              </>
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}

function sourceEnabledSelection(inspection: SillyTavernInspection): string[] {
  return inspection.prompts
    .filter(({ ordered, enabled }) => ordered && enabled === true)
    .map(({ id }) => id);
}
