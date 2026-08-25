import { useMemo, useState, type ReactNode } from "react";

import type {
  ContentTreeFile,
  SettingImprovementStartMode,
} from "../protocol/v1.ts";

export type SettingImprovementPhase =
  | "idle"
  | "planning"
  | "planned"
  | "generating"
  | "ready"
  | "applying"
  | "discarding";

export interface SettingImprovementPlanResult {
  kind: "plan";
  markdown: string;
}

interface SettingCandidateDiff {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

interface SettingCandidateDiagnostic {
  code: string;
  path: string;
  message: string;
}

interface SettingPromptPreview {
  diagnosticBinding: {
    endpoint: string;
    commit: string;
    hostPresetId: string;
    controlFingerprint: string;
    modelId: string;
  };
  compilation: {
    logicalMessages: {
      role: string;
      markdown: string;
      blocks: { source: string; markdown: string }[];
    }[];
    provider: unknown;
    tools: { name: string; description: string; inputSchema: object }[];
    coverage: {
      slot: string;
      source: string;
      status: string;
      complete: boolean;
      continuation: string | null;
    }[];
    budget: {
      estimator: "conservative_utf8_bytes" | "disabled";
      messageTokens: number;
      toolTokens: number;
      outputReserveTokens: number;
      forcedTailReserveTokens: number;
      safetyMarginTokens: number;
      requiredTokens: number;
      contextWindowTokens: number;
      status: "fits" | "over_budget" | "not_checked";
    };
    cache: {
      stablePrefixFingerprint: string;
      breakpoints: string[];
      estimatedCacheableTokens: number;
      firstDynamicByte: number;
    };
  };
  leakage: { status: "clean"; checkedFields: string[] };
}

export interface SettingImprovementCandidateResult {
  kind: "candidate";
  review: {
    status: "usable" | "needs_repair";
    diff: SettingCandidateDiff[];
    diagnostics: SettingCandidateDiagnostic[];
    preview: SettingPromptPreview;
  };
}

export interface SettingImprovementProgress {
  phase: "idle" | "planning" | "generating" | "settled";
  round: number;
  maxRounds: number;
  toolCalls: number;
  repairs: number;
  failedChecks: number;
  usage: { inputTokens: number; outputTokens: number };
  writing: string | null;
  recentActions: { tool: string; target: string | null; ok: boolean }[];
  lastCheck: string | null;
  failure: string | null;
  streaming: {
    reasoningChars: number;
    textChars: number;
    toolChars: number;
    tail: string;
    receivedAt: number;
  } | null;
  updatedAt: number;
}

interface SettingImprovementPanelProps {
  packageName: string;
  packageStatus: "usable" | "needs_repair";
  modelConfigured: boolean;
  currentFiles: readonly ContentTreeFile[];
  hasUnsavedFileDraft: boolean;
  contextPaths: readonly string[];
  contextLocked: boolean;
  phase: SettingImprovementPhase;
  goal: string;
  plan: SettingImprovementPlanResult | null;
  candidate: SettingImprovementCandidateResult | null;
  progress: SettingImprovementProgress | null;
  progressNow: number;
  onGoalChange: (goal: string) => void;
  onContextPathsChange: (paths: string[]) => void;
  onStart: (mode: SettingImprovementStartMode) => void;
  onConfirm: () => void;
  onRevisePlan: (feedback: string) => void;
  onReviseCandidate: (feedback: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  onConfigureModel: () => void;
}

/**
 * Lets the author keep the session and say what to change, instead of forcing
 * accept-all or discard-all over a single disagreement.
 */
function SettingReviseBox({
  label,
  hint,
  action,
  busy,
  onRevise,
}: {
  label: string;
  hint: string;
  action: string;
  busy: boolean;
  onRevise: (feedback: string) => void;
}): React.JSX.Element {
  const [feedback, setFeedback] = useState("");
  const id = `setting-revise-${label}`;
  return (
    <div className="setting-revise">
      <label htmlFor={id}>{label}</label>
      <p className="field-note">{hint}</p>
      <textarea
        id={id}
        rows={3}
        value={feedback}
        disabled={busy}
        placeholder="例如：秦龙的动机再具体一点，别改开场白。"
        onChange={(event) => setFeedback(event.target.value)}
      />
      <button
        type="button"
        className="secondary-button"
        disabled={busy || feedback.trim().length === 0}
        onClick={() => {
          onRevise(feedback.trim());
          setFeedback("");
        }}
      >
        {action}
      </button>
    </div>
  );
}

const settingToolLabels: Record<string, string> = {
  setting_list: "列目录",
  setting_search: "搜索",
  setting_read: "读取",
  setting_write_file: "写入",
  setting_patch: "改节点",
  setting_move: "移动",
  setting_preview_candidate: "自检",
  setting_finish_candidate: "结束候选",
};

function SettingRunProgress({
  phase,
  progress,
  now,
}: {
  phase: SettingImprovementPhase;
  progress: SettingImprovementProgress | null;
  now: number;
}): React.JSX.Element {
  const age =
    progress === null || progress.updatedAt === 0 || now === 0
      ? null
      : Math.max(0, Math.round((now - progress.updatedAt) / 1000));
  const streaming = progress?.streaming ?? null;
  // Silence is what matters, not elapsed time: a model emitting reasoning for
  // two minutes is working, while thirty seconds of nothing is not. Only the
  // gap since the last received fragment can tell those apart.
  const silence =
    streaming === null || now === 0
      ? age
      : Math.max(0, Math.round((now - streaming.receivedAt) / 1000));
  const stalled = silence !== null && silence >= 90;
  const streamedChars =
    streaming === null
      ? 0
      : streaming.reasoningChars + streaming.textChars + streaming.toolChars;
  return (
    <section
      className="setting-run-progress"
      aria-live="polite"
      aria-label="本次生成进度"
    >
      <div className="setting-run-headline">
        <strong>
          {phase === "planning" ? "正在生成创作计划" : "正在生成候选"}
        </strong>
        <span className="setting-run-round">
          第 {progress?.round ?? 0} / {progress?.maxRounds ?? 64} 轮
        </span>
        <span
          className={`setting-run-age${stalled ? " setting-run-age-stalled" : ""}`}
        >
          {age === null
            ? "正在建立连接…"
            : streaming !== null
              ? `正在输出 ${formatTokens(streamedChars)} 字`
              : `${age} 秒前更新`}
        </span>
      </div>
      <dl className="setting-run-counters">
        <div>
          <dt>工具调用</dt>
          <dd>{progress?.toolCalls ?? 0}</dd>
        </div>
        <div>
          <dt>自检未通过</dt>
          <dd>{progress?.failedChecks ?? 0}</dd>
        </div>
        <div>
          <dt>协议错误</dt>
          <dd>{progress?.repairs ?? 0}</dd>
        </div>
        <div>
          <dt>token</dt>
          <dd>
            ↑{formatTokens(progress?.usage.inputTokens ?? 0)} ↓
            {formatTokens(progress?.usage.outputTokens ?? 0)}
          </dd>
        </div>
      </dl>
      {progress?.writing != null && (
        <p className="setting-run-writing">
          正在写 <code>{progress.writing}</code>
        </p>
      )}
      {progress != null && progress.recentActions.length > 0 && (
        <ol className="setting-run-actions">
          {progress.recentActions
            .slice(-5)
            .reverse()
            .map((action, index) => (
              <li
                key={`${String(index)}-${action.tool}-${action.target ?? ""}`}
                className={action.ok ? undefined : "setting-run-action-failed"}
              >
                <span>{settingToolLabels[action.tool] ?? action.tool}</span>
                {action.target != null && <code>{action.target}</code>}
                <span aria-hidden="true">{action.ok ? "✓" : "✗"}</span>
              </li>
            ))}
        </ol>
      )}
      {streaming !== null && streaming.tail !== "" && (
        <p className="setting-run-tail">
          <span className="setting-run-tail-kicker">
            {streaming.textChars === 0 ? "思考中" : "正文"}
          </span>
          {streaming.tail}
        </p>
      )}
      {progress?.lastCheck != null && (
        <p className="setting-run-check">最近自检：{progress.lastCheck}</p>
      )}
      {stalled && (
        <p className="setting-run-stalled-note" role="note">
          已有 {silence} 秒没有收到任何输出，模型调用可能已经卡住。
        </p>
      )}
    </section>
  );
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const goalExamples = [
  "补足人物动机、关系与可持续冲突，让角色更容易推动故事。",
  "强化可以反复游玩的行动循环，同时保持节奏和信息披露边界。",
  "检查现有设定的缺口，并补齐当前情境、主持原则与玩家视图。",
];

export function SettingImprovementPanel({
  packageName,
  packageStatus,
  modelConfigured,
  currentFiles,
  hasUnsavedFileDraft,
  contextPaths,
  contextLocked,
  phase,
  goal,
  plan,
  candidate,
  progress,
  progressNow,
  onGoalChange,
  onContextPathsChange,
  onStart,
  onConfirm,
  onRevisePlan,
  onReviseCandidate,
  onApply,
  onDiscard,
  onConfigureModel,
}: SettingImprovementPanelProps): React.JSX.Element {
  const busy = ["planning", "generating", "applying", "discarding"].includes(
    phase,
  );
  const activeStep =
    candidate !== null || (plan === null && phase === "generating")
      ? 3
      : plan !== null
        ? 2
        : 1;

  return (
    <section
      className="setting-improvement-workspace"
      aria-labelledby="setting-improvement-title"
      aria-busy={busy}
    >
      <header className="setting-improvement-header">
        <div>
          <p className="eyebrow">CONTENT PACKAGE · AI AUTHORING</p>
          <h2 id="setting-improvement-title">AI 设定完善</h2>
          <p className="setting-improvement-intro">
            AI
            会基于当前树完善设定：可以先只读现有文件并确认计划，也可以直接生成隔离候选。
            只有最后整批应用才会替换当前内容包；已有世界不会改变。
          </p>
        </div>
        <div className="setting-package-context" aria-label="当前内容包">
          <span>正在完善</span>
          <strong>{packageName}</strong>
          <span className={`package-status ${packageStatus}`}>
            {packageStatus === "usable" ? "可用于创建世界" : "需要修复"}
          </span>
        </div>
      </header>

      <div className="setting-authoring-layout">
        <CurrentSettingBrowser
          files={currentFiles}
          hasUnsavedFileDraft={hasUnsavedFileDraft}
          contextPaths={contextPaths}
          contextLocked={contextLocked}
          onContextPathsChange={onContextPathsChange}
        />
        <div className="setting-authoring-flow">
          <ol className="setting-stepper" aria-label="设定完善进度">
            {[
              [1, "描述目标", "说清想获得的体验"],
              [2, "可选计划", "只读现有设定后确认方向"],
              [3, "审阅并应用", "核对完整差异与提示词"],
            ].map(([number, title, description]) => {
              const step = Number(number);
              const state =
                step < activeStep
                  ? "done"
                  : step === activeStep
                    ? "active"
                    : "later";
              return (
                <li
                  key={step}
                  className={`setting-step setting-step-${state}`}
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <span className="setting-step-number" aria-hidden="true">
                    {state === "done" ? "✓" : step}
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                </li>
              );
            })}
          </ol>

          {(phase === "planning" || phase === "generating") && (
            <SettingRunProgress
              phase={phase}
              progress={progress}
              now={progressNow}
            />
          )}

          {contextLocked && (
            <p className="setting-session-lock" role="note">
              当前创作会话及直接注入文件已固定。应用或放弃前，手动编辑、上下文选择和内容包切换会暂时停用。
            </p>
          )}

          {!modelConfigured && (
            <div className="setting-callout" role="note">
              <div>
                <strong>需要先连接模型</strong>
                <p>创作计划和候选文件都由当前模型生成。</p>
              </div>
              <button
                type="button"
                disabled={hasUnsavedFileDraft}
                onClick={onConfigureModel}
              >
                配置模型连接
              </button>
            </div>
          )}

          {plan === null && candidate === null ? (
            <section
              className="setting-step-card"
              aria-labelledby="setting-goal-title"
            >
              <div className="setting-step-heading">
                <div>
                  <span className="setting-step-kicker">第 1 步</span>
                  <h3 id="setting-goal-title">这次想把设定完善成什么样？</h3>
                </div>
              </div>
              <p
                id="setting-goal-help"
                className="field-note setting-goal-help"
              >
                写玩家最终会感受到什么、哪里薄弱、哪些内容不要改。无需描述文件名或技术格式。
              </p>
              <textarea
                aria-label="设定完善目标"
                aria-describedby="setting-goal-help"
                rows={7}
                value={goal}
                readOnly={busy}
                placeholder="例如：我想让学院生活更有日常节奏。补足室友之间的目标与矛盾，保留轻松基调，不增加数值化好感度，也不要预写未来剧情。"
                onChange={(event) => onGoalChange(event.target.value)}
              />
              {!busy && (
                <div className="setting-goal-examples" aria-label="目标示例">
                  <span>可以这样写：</span>
                  {goalExamples.map((example) => (
                    <button
                      type="button"
                      className="setting-example-button"
                      key={example}
                      onClick={() => onGoalChange(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              )}
              <div className="setting-primary-action">
                <div className="setting-decision-row">
                  <button
                    type="button"
                    disabled={
                      !modelConfigured ||
                      hasUnsavedFileDraft ||
                      goal.trim().length === 0 ||
                      busy
                    }
                    onClick={() => onStart("plan_first")}
                  >
                    {phase === "planning"
                      ? "正在生成创作计划…"
                      : "生成可见创作计划"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      !modelConfigured ||
                      hasUnsavedFileDraft ||
                      goal.trim().length === 0 ||
                      busy
                    }
                    onClick={() => onStart("direct_candidate")}
                  >
                    {phase === "generating"
                      ? "正在直接生成候选…"
                      : "跳过计划，直接生成候选"}
                  </button>
                </div>
                <span>
                  计划阶段只能读取；直接生成也仍需在最后审阅并整批应用。
                </span>
              </div>
            </section>
          ) : (
            <details className="setting-completed-step">
              <summary>
                <span>
                  <span className="setting-step-kicker">第 1 步</span>
                  <strong>创作目标已提交</strong>
                </span>
                <span className="state-label state-label-latest">
                  方向已提交
                </span>
              </summary>
              <p className="setting-completed-copy">{goal}</p>
            </details>
          )}

          {plan !== null && candidate === null && (
            <section
              className="setting-step-card"
              aria-labelledby="setting-plan-title"
            >
              <div className="setting-step-heading">
                <div>
                  <span className="setting-step-kicker">第 2 步</span>
                  <h3 id="setting-plan-title">确认 AI 理解的创作方向</h3>
                </div>
              </div>
              <p className="field-note">
                这里仍然只是计划。AI
                已可只读当前树，但确认前不能修改；若方向不对，放弃后修改目标。
              </p>
              <PlanDocument markdown={plan.markdown} />
              <div className="setting-decision-row">
                <button type="button" disabled={busy} onClick={onConfirm}>
                  {phase === "generating"
                    ? "正在生成并检查候选…"
                    : "确认计划并生成候选"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={onDiscard}
                >
                  放弃整批候选
                </button>
              </div>
              <SettingReviseBox
                label="让 AI 调整计划"
                hint="方向不对时不必放弃重来：写下要改什么，AI 会在同一次会话里重出完整计划。"
                action={
                  phase === "planning" ? "正在重新规划…" : "按意见重出计划"
                }
                busy={busy}
                onRevise={onRevisePlan}
              />
            </section>
          )}

          {plan !== null && candidate !== null && (
            <details className="setting-completed-step">
              <summary>
                <span>
                  <span className="setting-step-kicker">第 2 步</span>
                  <strong>创作计划已确认</strong>
                </span>
                <span className="state-label state-label-latest">已确认</span>
              </summary>
              <PlanDocument markdown={plan.markdown} />
            </details>
          )}

          {plan === null && candidate !== null && (
            <div className="setting-skipped-plan" role="note">
              <span className="setting-step-kicker">第 2 步 · 可选</span>
              <strong>已跳过可见计划</strong>
              <span>
                本次按你的目标直接生成候选，仍需审阅完整差异后才能应用。
              </span>
            </div>
          )}

          {candidate !== null && (
            <CandidateReview
              candidate={candidate}
              phase={phase}
              onApply={onApply}
              onReviseCandidate={onReviseCandidate}
              onDiscard={onDiscard}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function CurrentSettingBrowser({
  files,
  hasUnsavedFileDraft,
  contextPaths,
  contextLocked,
  onContextPathsChange,
}: {
  files: readonly ContentTreeFile[];
  hasUnsavedFileDraft: boolean;
  contextPaths: readonly string[];
  contextLocked: boolean;
  onContextPathsChange: (paths: string[]) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [requestedPath, setRequestedPath] = useState("");
  const orderedFiles = useMemo(
    () => [...files].sort(compareSettingPaths),
    [files],
  );
  const preferredPath =
    orderedFiles.find(({ path }) => path === "opening.md")?.path ??
    orderedFiles.find(({ path }) => path === "world/current-situation.yaml")
      ?.path ??
    orderedFiles.find(({ path }) => path.startsWith("world/"))?.path ??
    orderedFiles[0]?.path ??
    "";
  const selectedPath = files.some(({ path }) => path === requestedPath)
    ? requestedPath
    : preferredPath;
  const selectedFile = files.find(({ path }) => path === selectedPath);
  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return orderedFiles;
    return orderedFiles.filter(({ path }) =>
      path.toLowerCase().includes(normalized),
    );
  }, [orderedFiles, query]);
  const worldFiles = files.filter(({ path }) =>
    path.startsWith("world/"),
  ).length;
  const controlFiles = files.filter(({ path }) =>
    path.startsWith("control/"),
  ).length;
  const openingFiles = files.filter(({ path }) => path === "opening.md").length;
  const injectablePaths = orderedFiles
    .filter(({ encoding }) => encoding !== "base64")
    .map(({ path }) => path);
  const selectedContextPaths = new Set(contextPaths);
  const updateContextPath = (path: string, selected: boolean): void => {
    const next = selected
      ? [...new Set([...contextPaths, path])]
      : contextPaths.filter((candidate) => candidate !== path);
    onContextPathsChange(next.sort());
  };

  return (
    <aside
      className="setting-current-browser"
      aria-labelledby="setting-current-title"
    >
      <header>
        <div>
          <span className="setting-step-kicker">AI 的起点</span>
          <h3 id="setting-current-title">当前设定</h3>
        </div>
        <span className="state-label">{files.length} 个文件</span>
      </header>
      <p className="setting-current-intro">
        计划阶段可通过只读工具查看整棵已保存当前树；勾选的文本文件会额外完整注入首个模型请求。
      </p>
      {hasUnsavedFileDraft && (
        <div className="setting-unsaved-warning" role="note">
          <strong>手动编辑尚未保存</strong>
          <span>这些修改不会进入 AI 候选；请先返回手动编辑并整批保存。</span>
        </div>
      )}
      <dl className="setting-current-counts" aria-label="当前设定文件统计">
        <div>
          <dt>开场白</dt>
          <dd>{openingFiles}</dd>
        </div>
        <div>
          <dt>世界内容</dt>
          <dd>{worldFiles}</dd>
        </div>
        <div>
          <dt>控制文件</dt>
          <dd>{controlFiles}</dd>
        </div>
      </dl>
      <section
        className="setting-context-selection"
        aria-labelledby="setting-context-selection-title"
      >
        <div>
          <h4 id="setting-context-selection-title">直接注入给 AI</h4>
          <span>{contextPaths.length} 个文件</span>
        </div>
        <p>适合指定本次完善必须先看到的核心人物、规则或当前情境。</p>
        <div className="setting-context-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={contextLocked || injectablePaths.length === 0}
            onClick={() => onContextPathsChange(injectablePaths)}
          >
            全选文本文件
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={contextLocked || contextPaths.length === 0}
            onClick={() => onContextPathsChange([])}
          >
            清空注入
          </button>
        </div>
      </section>
      {files.length === 0 ? (
        <p className="setting-empty-state">当前内容包还没有文件。</p>
      ) : (
        <>
          <label className="setting-file-filter">
            筛选文件
            <input
              type="search"
              value={query}
              placeholder="例如 characters 或 frame"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav className="setting-current-file-list" aria-label="当前设定文件">
            {filteredFiles.length === 0 ? (
              <p>没有匹配的文件。</p>
            ) : (
              <ul>
                {filteredFiles.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={
                        file.path === selectedPath
                          ? "selected-setting-file"
                          : ""
                      }
                      aria-pressed={file.path === selectedPath}
                      title={file.path}
                      onClick={() => setRequestedPath(file.path)}
                    >
                      <span aria-hidden="true">
                        {file.path === "opening.md"
                          ? "开场"
                          : file.path.startsWith("world/")
                            ? "世界"
                            : "控制"}
                      </span>
                      <code>{file.path}</code>
                    </button>
                    <label className="setting-context-checkbox">
                      <input
                        type="checkbox"
                        aria-label={`注入 ${file.path}`}
                        checked={selectedContextPaths.has(file.path)}
                        disabled={contextLocked || file.encoding === "base64"}
                        onChange={(event) =>
                          updateContextPath(file.path, event.target.checked)
                        }
                      />
                      <span>
                        {file.encoding === "base64" ? "二进制" : "注入"}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          {selectedFile !== undefined && (
            <section
              className="setting-current-file-preview"
              aria-labelledby="setting-current-file-title"
            >
              <h4 id="setting-current-file-title">{selectedFile.path}</h4>
              {selectedFile.encoding === "base64" ? (
                <p>这是二进制资源，内容不在此处展开。</p>
              ) : (
                <pre>{selectedFile.contents}</pre>
              )}
            </section>
          )}
        </>
      )}
    </aside>
  );
}

function compareSettingPaths(
  left: ContentTreeFile,
  right: ContentTreeFile,
): number {
  const rank = (path: string): number => {
    if (path === "opening.md") return 0;
    if (path === "world/current-situation.yaml") return 1;
    if (path.startsWith("world/")) return 2;
    if (path.startsWith("control/")) return 3;
    return 4;
  };
  return (
    rank(left.path) - rank(right.path) || left.path.localeCompare(right.path)
  );
}

function PlanDocument({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <article className="setting-plan-document">{parsePlan(markdown)}</article>
  );
}

function parsePlan(markdown: string): ReactNode[] {
  const lines = markdown.trim().split(/\r?\n/u);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`paragraph-${blocks.length}`}>{paragraph.join(" ")}</p>,
    );
    paragraph = [];
  };
  const flushBullets = (): void => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {bullets.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushBullets();
      const text = heading[2] ?? "";
      const depth = heading[1]?.length ?? 1;
      if (depth === 1)
        blocks.push(<h3 key={`heading-${blocks.length}`}>{text}</h3>);
      else if (depth === 2)
        blocks.push(<h4 key={`heading-${blocks.length}`}>{text}</h4>);
      else blocks.push(<h5 key={`heading-${blocks.length}`}>{text}</h5>);
    } else if (bullet !== null) {
      flushParagraph();
      bullets.push(bullet[1] ?? "");
    } else if (line.trim().length === 0) {
      flushParagraph();
      flushBullets();
    } else {
      flushBullets();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushBullets();
  return blocks;
}

function CandidateReview({
  candidate,
  phase,
  onApply,
  onReviseCandidate,
  onDiscard,
}: {
  candidate: SettingImprovementCandidateResult;
  phase: SettingImprovementPhase;
  onApply: () => void;
  onReviseCandidate: (feedback: string) => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const { review } = candidate;
  const counts = {
    create: review.diff.filter(({ kind }) => kind === "create").length,
    modify: review.diff.filter(({ kind }) => kind === "modify").length,
    delete: review.diff.filter(({ kind }) => kind === "delete").length,
  };
  const busy = phase === "applying" || phase === "discarding";

  return (
    <section
      className="setting-step-card setting-review"
      aria-labelledby="setting-review-title"
    >
      <div className="setting-step-heading">
        <div>
          <span className="setting-step-kicker">第 3 步</span>
          <h3 id="setting-review-title">审阅候选，再决定是否应用</h3>
        </div>
        <span className={`review-status review-status-${review.status}`}>
          {review.status === "usable" ? "机械检查通过" : "候选需要修复"}
        </span>
      </div>

      <dl className="setting-review-summary" aria-label="候选摘要">
        <div>
          <dt>文件变化</dt>
          <dd>{review.diff.length}</dd>
        </div>
        <div>
          <dt>新建</dt>
          <dd>{counts.create}</dd>
        </div>
        <div>
          <dt>修改</dt>
          <dd>{counts.modify}</dd>
        </div>
        <div>
          <dt>删除</dt>
          <dd>{counts.delete}</dd>
        </div>
      </dl>

      {review.diagnostics.length > 0 && (
        <section
          className="setting-diagnostics"
          aria-labelledby="setting-diagnostics-title"
        >
          <h4 id="setting-diagnostics-title">机械检查诊断</h4>
          <ul>
            {review.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}-${diagnostic.path}`}>
                <strong>{diagnostic.path}</strong>
                <span>{diagnostic.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className="setting-diff-list"
        aria-labelledby="setting-diff-title"
      >
        <div className="setting-subsection-heading">
          <div>
            <h4 id="setting-diff-title">完整文件差异</h4>
            <p>逐个展开检查；这里显示的就是整批应用将替换的内容。</p>
          </div>
        </div>
        {review.diff.length === 0 ? (
          <p className="setting-empty-state">AI 没有改动任何文件。</p>
        ) : (
          review.diff.map((diff, index) => (
            <details
              className="setting-diff"
              key={diff.path}
              open={review.diff.length === 1 || index === 0}
            >
              <summary>
                <span className={`diff-kind diff-kind-${diff.kind}`}>
                  {diffLabel(diff.kind)}
                </span>
                <code>{diff.path}</code>
              </summary>
              <div className="setting-diff-columns">
                {diff.before !== null && (
                  <section>
                    <h5>应用前</h5>
                    <pre>{diff.before}</pre>
                  </section>
                )}
                {diff.after !== null && (
                  <section>
                    <h5>应用后</h5>
                    <pre>{diff.after}</pre>
                  </section>
                )}
              </div>
            </details>
          ))
        )}
      </section>

      <PromptPreview preview={review.preview} />

      <div className="setting-apply-boundary">
        <div>
          <strong>这是一次整批替换</strong>
          <p>
            不能只勾选部分文件。放弃会丢弃整个隔离候选，当前内容包保持不变。
          </p>
        </div>
        <div className="setting-decision-row">
          <button
            type="button"
            disabled={busy || review.status !== "usable"}
            onClick={onApply}
          >
            {phase === "applying" ? "正在整批应用…" : "整批应用候选"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onDiscard}
          >
            {phase === "discarding" ? "正在放弃…" : "放弃整批候选"}
          </button>
        </div>
        <SettingReviseBox
          label="让 AI 继续改这份候选"
          hint="只有一两处不满意时不必整批放弃：写下要改什么，AI 会在当前候选上接着改，已经对的部分保留。"
          action={phase === "generating" ? "正在修改候选…" : "按意见继续修改"}
          busy={busy}
          onRevise={onReviseCandidate}
        />
      </div>
    </section>
  );
}

function PromptPreview({
  preview,
}: {
  preview: SettingPromptPreview;
}): React.JSX.Element {
  const { budget } = preview.compilation;
  return (
    <section
      className="setting-prompt-preview"
      aria-labelledby="setting-preview-title"
    >
      <div className="setting-subsection-heading">
        <div>
          <h4 id="setting-preview-title">真实提示词预览</h4>
          <p>候选已通过和真实请求同源的编译检查。</p>
        </div>
        <span className="review-status review-status-usable">
          无内部字段泄漏
        </span>
      </div>
      <dl className="setting-preview-summary">
        <div>
          <dt>模型</dt>
          <dd>{preview.diagnosticBinding.modelId}</dd>
        </div>
        <div>
          <dt>逻辑消息</dt>
          <dd>{preview.compilation.logicalMessages.length}</dd>
        </div>
        <div>
          <dt>工具</dt>
          <dd>{preview.compilation.tools.length}</dd>
        </div>
        <div>
          <dt>{budget.estimator === "disabled" ? "上下文检查" : "预算"}</dt>
          <dd>
            {budget.estimator === "disabled"
              ? "由 Provider 判断"
              : `${formatNumber(budget.requiredTokens)} / ${formatNumber(budget.contextWindowTokens)} tokens`}
          </dd>
        </div>
      </dl>

      <div className="setting-preview-details">
        <details>
          <summary>查看逻辑消息正文</summary>
          <ol className="setting-message-list">
            {preview.compilation.logicalMessages.map((message, index) => (
              <li key={`${message.role}-${index}`}>
                <header>
                  <strong>{message.role}</strong>
                  <span>
                    {message.blocks.map(({ source }) => source).join(" · ")}
                  </span>
                </header>
                <pre>{message.markdown}</pre>
              </li>
            ))}
          </ol>
        </details>
        <details>
          <summary>查看材料覆盖与预算</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>来源</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {preview.compilation.coverage.map((coverage) => (
                  <tr key={`${coverage.slot}-${coverage.source}`}>
                    <td>{coverage.slot}</td>
                    <td>{coverage.source}</td>
                    <td>{coverage.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <pre>
            {JSON.stringify(
              { budget, cache: preview.compilation.cache },
              null,
              2,
            )}
          </pre>
        </details>
        <details>
          <summary>查看真实工具定义</summary>
          <pre>{JSON.stringify(preview.compilation.tools, null, 2)}</pre>
        </details>
        <details>
          <summary>查看最终 Provider 请求结构</summary>
          <pre>{JSON.stringify(preview.compilation.provider, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}

function diffLabel(kind: SettingCandidateDiff["kind"]): string {
  if (kind === "create") return "新建";
  if (kind === "delete") return "删除";
  return "修改";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}
