import { getWebLocale, uiText } from "./i18n.ts";
import { useRef, useState } from "react";

import type {
  ModelConnectionLibraryView,
  ModelProviderKind,
} from "../protocol/modelConnections.ts";
import type { ModelBinding, V1Request } from "../protocol/v1.ts";

type LogicalRole =
  "runtime_system" | "author_instruction" | "world_context" | "player_input";

interface PromptPreviewClient {
  request<T = unknown>(request: V1Request): Promise<T>;
}

export interface PromptPreviewPackage {
  localId: string;
  title: string;
  status: "usable" | "needs_repair";
}

export interface PlayPresetLibrary {
  currentPresetId: string;
  presets: {
    id: string;
    name: string;
    revision: string;
    validation: { status: "valid" } | { status: "invalid"; message: string };
  }[];
}

export interface PromptPreviewData {
  diagnosticBinding: {
    endpoint: string;
    commit: string;
    hostPresetId: string;
    controlFingerprint: string;
    modelId: string;
    playPresetId?: string;
    playPresetRevision?: string;
  };
  compilation: {
    logicalMessages: {
      role: LogicalRole;
      markdown: string;
      blocks: { source: string; markdown: string }[];
    }[];
    provider: {
      protocol: ModelProviderKind;
      system?: {
        type: "text";
        text: string;
        cache_control?: { type: "ephemeral" };
      }[];
      messages: { role: "system" | "user"; content: unknown }[];
    };
    tools: { name: string; description: string; inputSchema: object }[];
    toolUniverse?: {
      name: string;
      description: string;
      inputSchema: object;
    }[];
    toolStrategy?: "native_allowed_subset" | "runtime_gate";
    coverage: {
      slot: string;
      source: string;
      status: "resolved" | "optional_missing" | "paged_catalog";
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
      strategy:
        | "explicit_anthropic_blocks"
        | "explicit_cliproxyapi_message"
        | "provider_managed";
      stablePrefixFingerprint: string;
      breakpoints: LogicalRole[];
      estimatedCacheableBytes: number;
      firstDynamicByte: number;
    };
  };
  initialAppend?: {
    logical: { kind: "player"; text: string };
    provider: { role: "user"; content: string };
    beforePlayer?: {
      logical: unknown;
      provider: { role: "user"; content: string };
    };
  };
  wireRequest?: {
    provider: ModelProviderKind;
    method: "POST";
    endpointPath: string;
    headerNames: string[];
    body: unknown;
  };
  playPreset?: {
    id: string;
    name: string;
    revision: string;
    callChainPath: string;
    mounts: { channel: string; mount: string }[];
    extensionRefs: string[];
    toolStrategy?: "native_allowed_subset" | "runtime_gate";
    toolUniverse: {
      name: string;
      description: string;
      inputSchema: object;
    }[];
    bootstrap: PromptPreviewData["compilation"];
    followups: {
      id: string;
      displayName: string;
      logicalMessages: PromptPreviewData["compilation"]["logicalMessages"];
      tools: {
        name: string;
        description: string;
        inputSchema: object;
      }[];
      allowedTools: string[];
      maxArtifactBytes: number;
      artifacts: {
        name: string;
        channel: string;
        strategy: string;
        key?: string;
        contentType: string;
        renderer?: string;
        save: string;
        payloadContract?: object;
      }[];
    }[];
    cache: {
      stablePrefixFingerprint: string;
      toolDefinitionBoundary?: "stable";
    };
  };
  leakage: { status: "clean"; checkedFields: string[] };
}

type ResultSection =
  "messages" | "callChain" | "materials" | "provider" | "diagnostics";

const roleDescriptions: Record<
  LogicalRole,
  { title: string; description: string }
> = {
  runtime_system: {
    title: "Runtime 系统",
    description: "权威、真实工具与提交边界，由 Runtime 固定提供。",
  },
  author_instruction: {
    title: "创作指令",
    description: "当前主持预设、世界专属创作政策与玩法叙事规则。",
  },
  world_context: {
    title: "世界上下文",
    description: "真实 slot 展开、材料覆盖和当前世界正文。",
  },
  player_input: {
    title: "玩家原文",
    description: "本次预览显式使用的动态玩家输入。",
  },
};

const providerLabels: Record<ModelProviderKind, string> = {
  chat_completions: "Chat Completions",
  openai_responses: "OpenAI Responses",
  anthropic_messages: "Anthropic Messages",
};

const coverageLabels = {
  resolved: "已提供",
  optional_missing: "可选未证明完整",
  paged_catalog: "分页目录",
} as const;

const slotLabels: Record<string, string> = {
  current_situation: "当前情境",
  additional_materials: "附加材料",
  catalog: "材料目录",
  reference_targets: "引用目标",
  history: "最近叙事",
};

export function PromptPreviewScreen({
  client,
  packages,
  initialPackageId,
  playPresets,
  model,
  onPackageSelect,
  playPresetTarget,
  embedded = false,
}: {
  client: PromptPreviewClient;
  packages: PromptPreviewPackage[];
  initialPackageId: string;
  playPresets?: PlayPresetLibrary;
  model: ModelConnectionLibraryView;
  onPackageSelect: (packageId: string) => void;
  playPresetTarget?: { presetId: string; revision: string };
  embedded?: boolean;
}): React.JSX.Element {
  const initialPackage =
    packages.find(({ localId }) => localId === initialPackageId) ??
    packages.find(({ status }) => status === "usable") ??
    packages[0];
  const [packageId, setPackageId] = useState(initialPackage?.localId ?? "");
  const [playerInput, setPlayerInput] = useState(uiText("我观察当前场景。"));
  const [preview, setPreview] = useState<PromptPreviewData | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "status" | "error";
    text: string;
  } | null>(null);
  const requestVersion = useRef(0);

  const selectedPackage = packages.find(
    (package_) => package_.localId === packageId,
  );
  // One preset now carries both the host frame/blocks and the play layer.
  const currentPreset = playPresets?.presets.find(
    ({ id }) =>
      id === (playPresetTarget?.presetId ?? playPresets.currentPresetId),
  );
  const currentPlayPreset = currentPreset;
  const activeConnection = model.connections.find(
    ({ id }) => id === model.activeConnectionId,
  );
  const ready =
    selectedPackage?.status === "usable" &&
    currentPreset?.validation.status === "valid" &&
    activeConnection !== undefined &&
    playerInput.trim().length > 0;

  function invalidatePreview(): void {
    requestVersion.current += 1;
    setPending(false);
    setPreview(null);
    setFeedback(null);
  }

  async function compilePreview(): Promise<void> {
    if (!ready || activeConnection === undefined) return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setPending(true);
    setFeedback(null);
    try {
      const result = await client.request<PromptPreviewData>({
        type: "prompt.preview",
        packageId,
        playerInput: playerInput.trim(),
        model: modelBinding(activeConnection),
        ...(playPresets === undefined
          ? {}
          : {
              playPresetId:
                playPresetTarget?.presetId ?? playPresets.currentPresetId,
              ...(playPresetTarget === undefined
                ? {}
                : { playPresetRevision: playPresetTarget.revision }),
            }),
      });
      if (requestVersion.current !== version) return;
      setPreview(result);
      setFeedback({
        kind: "status",
        text: uiText("真实编译已完成；没有调用模型，也没有改变内容或世界。"),
      });
    } catch (error: unknown) {
      if (requestVersion.current !== version) return;
      setPreview(null);
      setFeedback({ kind: "error", text: errorText(error) });
    } finally {
      if (requestVersion.current === version) setPending(false);
    }
  }

  return (
    <section
      className={`prompt-preview-screen${embedded ? " embedded" : ""}`}
      aria-labelledby="prompt-preview-title"
    >
      {embedded ? (
        <header className="prompt-preview-embedded-header">
          <div>
            <p className="eyebrow">READ ONLY · REAL COMPILER</p>
            <h4 id="prompt-preview-title">{uiText("全新上下文会发送什么")}</h4>
          </div>
          <p>
            {uiText("真实编译，0 次模型调用，不会创建对话或写入权威状态。")}
          </p>
        </header>
      ) : (
        <header className="prompt-preview-header">
          <div>
            <p className="eyebrow">READ ONLY · REAL COMPILER</p>
            <h2 id="prompt-preview-title">{uiText("提示词预览")}</h2>
            <p className="prompt-preview-lede">
              {uiText(
                "用真实编译器检查全新上下文会发送什么：逻辑 role、Markdown、材料、工具、预算与 Provider 映射。",
              )}
            </p>
          </div>
          <div
            className="prompt-preview-readonly"
            aria-label={uiText("预览性质")}
          >
            <span>{uiText("只读检查")}</span>
            <strong>{uiText("0 次模型调用")}</strong>
            <small>{uiText("不会创建对话或写入权威状态")}</small>
          </div>
        </header>
      )}

      <div className="prompt-preview-setup">
        <section
          className="panel-card prompt-preview-input-card"
          aria-labelledby="prompt-preview-input-title"
        >
          <div className="prompt-preview-section-heading">
            <div>
              <p className="prompt-preview-kicker">PREVIEW INPUT</p>
              <h3 id="prompt-preview-input-title">
                {uiText("决定这次检查什么")}
              </h3>
            </div>
            <span className="prompt-preview-mode">
              {uiText("内容包首轮 · 全新上下文")}
            </span>
          </div>

          {packages.length === 0 ? (
            <p className="prompt-preview-empty" role="status">
              {uiText(
                "还没有内容包。先新建并修好一份内容包，才能编译真实提示词。",
              )}
            </p>
          ) : (
            <>
              <label>
                {uiText("内容包")}
                <select
                  aria-label={uiText("预览内容包")}
                  value={packageId}
                  onChange={(event) => {
                    const nextPackageId = event.currentTarget.value;
                    setPackageId(nextPackageId);
                    onPackageSelect(nextPackageId);
                    invalidatePreview();
                  }}
                >
                  {packages.map((package_) => (
                    <option key={package_.localId} value={package_.localId}>
                      {package_.title}
                      {package_.status === "usable"
                        ? ""
                        : uiText(" · 需要修复")}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {uiText("预览玩家输入")}
                <textarea
                  aria-label={uiText("预览玩家输入")}
                  value={playerInput}
                  onChange={(event) => {
                    setPlayerInput(event.currentTarget.value);
                    invalidatePreview();
                  }}
                />
                <span className="field-note">
                  {uiText(
                    "这段原文只进入本次预览，不会写入历史，也不会成为真实玩家行动。",
                  )}
                </span>
              </label>

              {selectedPackage?.status === "needs_repair" ? (
                <p className="prompt-preview-blocker" role="status">
                  {uiText(
                    "这份内容包仍需修复；真实首轮预览要求有效的 opening.md、世界文档和控制框架。",
                  )}
                </p>
              ) : null}

              <button
                disabled={!ready || pending}
                onClick={() => void compilePreview()}
                type="button"
              >
                {pending
                  ? uiText("正在编译真实预览…")
                  : preview === null
                    ? uiText("生成真实预览")
                    : uiText("重新生成真实预览")}
              </button>
            </>
          )}

          {feedback === null ? null : (
            <p role={feedback.kind === "error" ? "alert" : "status"}>
              {feedback.text}
            </p>
          )}
        </section>

        <section
          className="panel-card prompt-preview-binding-card"
          aria-labelledby="prompt-preview-binding-title"
        >
          <p className="prompt-preview-kicker">FIXED BINDING</p>
          <h3 id="prompt-preview-binding-title">{uiText("本次固定绑定")}</h3>
          <dl>
            <div>
              <dt>{uiText("主持预设")}</dt>
              <dd>
                <strong>{currentPreset?.name ?? uiText("没有当前预设")}</strong>
                <span>{uiText("工作区当前选择")}</span>
              </dd>
            </div>
            <div>
              <dt>{uiText("模型连接")}</dt>
              <dd>
                <strong>
                  {activeConnection?.name ?? uiText("没有当前模型")}
                </strong>
                <span>
                  {activeConnection === undefined
                    ? uiText("请先配置并启用模型")
                    : `${activeConnection.modelId} · ${providerLabels[activeConnection.provider]}`}
                </span>
              </dd>
            </div>
            <div>
              <dt>{uiText("模型窗口")}</dt>
              <dd>
                <strong>
                  {activeConnection === undefined
                    ? "—"
                    : `${formatNumber(activeConnection.contextWindowTokens)} tokens`}
                </strong>
                <span>
                  {activeConnection === undefined
                    ? "—"
                    : uiText("最大输出 {count}", {
                        count: formatNumber(activeConnection.maxOutputTokens),
                      })}
                </span>
              </dd>
            </div>
            <div>
              <dt>{uiText("开场白边界")}</dt>
              <dd>
                <strong>{uiText("不作为模型历史注入")}</strong>
                <span>
                  {uiText("opening.md 只保留为玩家可见的 genesis 叙事")}
                </span>
              </dd>
            </div>
            <div>
              <dt>{uiText("玩法预设")}</dt>
              <dd>
                <strong>{currentPlayPreset?.name ?? "default"}</strong>
                <span>
                  {currentPlayPreset === undefined
                    ? uiText("使用内置玩法的完整工具集合")
                    : `revision ${playPresetTarget?.revision ?? currentPlayPreset.revision}`}
                </span>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {preview === null ? (
        <section
          className="prompt-preview-waiting"
          aria-label={uiText("等待生成预览")}
        >
          <span aria-hidden="true">01 — 04</span>
          <div>
            <strong>{uiText("生成后按四个视角检查")}</strong>
            <p>{uiText("逻辑消息、材料与工具、Provider 映射、预算与诊断。")}</p>
          </div>
        </section>
      ) : (
        <PromptPreviewResult
          preview={preview}
          packageName={selectedPackage?.title ?? packageId}
          hostName={currentPreset?.name ?? uiText("未知预设")}
          modelName={
            activeConnection?.name ?? preview.diagnosticBinding.modelId
          }
        />
      )}
    </section>
  );
}

function PromptPreviewResult({
  preview,
  packageName,
  hostName,
  modelName,
}: {
  preview: PromptPreviewData;
  packageName: string;
  hostName: string;
  modelName: string;
}): React.JSX.Element {
  const [section, setSection] = useState<ResultSection>("messages");
  const { compilation } = preview;
  const contextAdmissionDisabled =
    compilation.budget.estimator === "disabled" ||
    compilation.budget.status === "not_checked";
  const budgetPercent = Math.min(
    100,
    Math.round(
      (compilation.budget.requiredTokens /
        compilation.budget.contextWindowTokens) *
        100,
    ),
  );

  return (
    <div className="prompt-preview-result">
      <section
        className="panel-card prompt-preview-overview"
        aria-labelledby="prompt-preview-result-title"
      >
        <div className="prompt-preview-result-heading">
          <div>
            <p className="prompt-preview-kicker">COMPILED REQUEST</p>
            <h3 id="prompt-preview-result-title">{uiText("编译通过")}</h3>
            <p>
              {packageName} · {hostName} · {modelName}
            </p>
          </div>
          <div
            className="prompt-preview-pass-badges"
            aria-label={uiText("编译检查结果")}
          >
            <span>
              {contextAdmissionDisabled
                ? uiText("Runtime 不预估上下文")
                : uiText("预算可容纳")}
            </span>
            <span>{uiText("内部字段无泄漏")}</span>
            <span>{uiText("权威状态未改变")}</span>
          </div>
        </div>

        <dl className="prompt-preview-summary">
          <div>
            <dt>{uiText("逻辑消息")}</dt>
            <dd>{compilation.logicalMessages.length}</dd>
            <small>
              {uiText("稳定 bootstrap")}
              {preview.initialAppend === undefined
                ? ""
                : uiText("；另有 1 条玩家追加")}
            </small>
          </div>
          <div>
            <dt>{uiText("真实工具")}</dt>
            <dd>{compilation.tools.length}</dd>
            <small>{uiText("生产调用链全集")}</small>
          </div>
          <div>
            <dt>
              {contextAdmissionDisabled
                ? uiText("上下文检查")
                : uiText("所需上下文")}
            </dt>
            <dd>
              {contextAdmissionDisabled
                ? uiText("由 Provider 判断")
                : formatNumber(compilation.budget.requiredTokens)}
            </dd>
            <small>
              {contextAdmissionDisabled
                ? uiText("Runtime 不据此拦截请求")
                : `/ ${formatNumber(compilation.budget.contextWindowTokens)} tokens`}
            </small>
          </div>
          <div>
            <dt>
              {contextAdmissionDisabled
                ? uiText("窗口配置")
                : uiText("窗口占用")}
            </dt>
            <dd>
              {contextAdmissionDisabled
                ? formatNumber(compilation.budget.contextWindowTokens)
                : `${budgetPercent}%`}
            </dd>
            {contextAdmissionDisabled ? (
              <small>tokens · Provider binding</small>
            ) : (
              <progress
                aria-label={uiText("上下文窗口占用")}
                max={compilation.budget.contextWindowTokens}
                value={compilation.budget.requiredTokens}
              />
            )}
          </div>
        </dl>
      </section>

      <nav className="prompt-preview-nav" aria-label={uiText("预览结果分区")}>
        <ResultButton
          active={section === "messages"}
          count={compilation.logicalMessages.length}
          label={uiText("逻辑消息")}
          onClick={() => setSection("messages")}
        />
        {preview.playPreset === undefined ? null : (
          <ResultButton
            active={section === "callChain"}
            count={preview.playPreset.toolUniverse.length}
            label={uiText("玩法绑定")}
            onClick={() => setSection("callChain")}
          />
        )}
        <ResultButton
          active={section === "materials"}
          count={compilation.coverage.length + compilation.tools.length}
          label={uiText("材料与工具")}
          onClick={() => setSection("materials")}
        />
        <ResultButton
          active={section === "provider"}
          count={
            compilation.provider.messages.length +
            (preview.initialAppend === undefined ? 0 : 1)
          }
          label={uiText("Provider 映射")}
          onClick={() => setSection("provider")}
        />
        <ResultButton
          active={section === "diagnostics"}
          count={4}
          label={uiText("预算与诊断")}
          onClick={() => setSection("diagnostics")}
        />
      </nav>

      {section === "messages" ? (
        <>
          <LogicalMessages messages={compilation.logicalMessages} />
          {preview.initialAppend === undefined ? null : (
            <InitialPlayerAppend append={preview.initialAppend} />
          )}
        </>
      ) : null}
      {section === "callChain" && preview.playPreset !== undefined ? (
        <PlayPresetCallChain callChain={preview.playPreset} />
      ) : null}
      {section === "materials" ? (
        <MaterialsAndTools
          coverage={compilation.coverage}
          tools={compilation.tools}
        />
      ) : null}
      {section === "provider" ? (
        <ProviderMapping
          provider={compilation.provider}
          initialAppend={preview.initialAppend}
          wireRequest={preview.wireRequest}
        />
      ) : null}
      {section === "diagnostics" ? (
        <BudgetAndDiagnostics preview={preview} />
      ) : null}
    </div>
  );
}

function InitialPlayerAppend({
  append,
}: {
  append: NonNullable<PromptPreviewData["initialAppend"]>;
}): React.JSX.Element {
  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="initial-player-append-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">FIRST DYNAMIC APPEND</p>
          <h3 id="initial-player-append-title">{uiText("首条玩家追加")}</h3>
        </div>
        <p>
          {uiText("稳定 bootstrap 之后，玩家原文作为普通 user 消息原样追加。")}
        </p>
      </div>
      <div className="provider-message-list">
        <ol>
          {append.beforePlayer === undefined ? null : (
            <li>
              <header>
                <strong>{uiText("玩家输入前的回合提示")}</strong>
                <span>{append.beforePlayer.provider.role}</span>
              </header>
              <pre>{append.beforePlayer.provider.content}</pre>
            </li>
          )}
          <li>
            <header>
              <span>{append.logical.kind}</span>
              <strong>{append.provider.role}</strong>
            </header>
            <pre>{append.provider.content}</pre>
          </li>
        </ol>
      </div>
    </section>
  );
}

function PlayPresetCallChain({
  callChain,
}: {
  callChain: NonNullable<PromptPreviewData["playPreset"]>;
}): React.JSX.Element {
  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="play-preset-call-chain-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">PLAY PRESET · FROZEN REVISION</p>
          <h3 id="play-preset-call-chain-title">
            {uiText("玩法绑定与调用链工具")}
          </h3>
        </div>
        <p>
          {callChain.name} · {callChain.revision}{" "}
          {uiText(
            "· 叙事规则进入稳定 bootstrap， 后置请求在主调用链完成后独立派发。",
          )}
        </p>
      </div>
      <dl className="prompt-binding-details">
        <div>
          <dt>{uiText("玩法文件")}</dt>
          <dd>
            <code>{callChain.callChainPath}</code>
            <span>{uiText("冻结工具、叙事规则与后置产物契约")}</span>
          </dd>
        </div>
        <div>
          <dt>{uiText("工具全集")}</dt>
          <dd>
            <code>
              {callChain.toolUniverse.map(({ name }) => name).join(" / ")}
            </code>
          </dd>
        </div>
        <div>
          <dt>{uiText("Provider 工具策略")}</dt>
          <dd>
            <code>{callChain.toolStrategy ?? "runtime_gate"}</code>
            <span>{uiText("definitions：稳定全集")}</span>
          </dd>
        </div>
        <div>
          <dt>{uiText("稳定前缀")}</dt>
          <dd>
            <code>{callChain.cache.stablePrefixFingerprint}</code>
          </dd>
        </div>
        <div>
          <dt>{uiText("频道挂载")}</dt>
          <dd>
            <code>
              {callChain.mounts.length === 0
                ? uiText("无")
                : callChain.mounts
                    .map(({ channel, mount }) => `${channel} → ${mount}`)
                    .join(" · ")}
            </code>
          </dd>
        </div>
      </dl>
      <div className="prompt-preview-subsection-heading">
        <div>
          <h4>{uiText("稳定 bootstrap")}</h4>
          <p>
            {uiText(
              "全新上下文发送这份稳定前缀；玩家原文随后作为普通消息追加。Runtime 不再插入裁决、叙事或结算 delta。",
            )}
          </p>
        </div>
        <span>
          {callChain.bootstrap.logicalMessages.length} {uiText("条逻辑消息")}
        </span>
      </div>
      <p className="prompt-preview-cache-line">
        fingerprint：
        <code>{callChain.bootstrap.cache.stablePrefixFingerprint}</code>
      </p>
      <p className="prompt-preview-cache-line">
        {uiText("调用链可用工具：")}
        <strong>{callChain.toolUniverse.length}</strong>{" "}
        {uiText("· 后置请求：")}
        <strong>{callChain.followups.length}</strong>
      </p>
    </section>
  );
}

function ResultButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={active ? "active" : ""}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <small>{count}</small>
    </button>
  );
}

function LogicalMessages({
  messages,
}: {
  messages: PromptPreviewData["compilation"]["logicalMessages"];
}): React.JSX.Element {
  const [selectedRole, setSelectedRole] = useState<LogicalRole>(
    messages[0]?.role ?? "runtime_system",
  );
  const selected =
    messages.find(({ role }) => role === selectedRole) ?? messages[0];

  if (selected === undefined)
    return (
      <p className="prompt-preview-empty">{uiText("这次编译没有逻辑消息。")}</p>
    );

  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="logical-messages-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">PROVIDER-NEUTRAL</p>
          <h3 id="logical-messages-title">
            {uiText("逻辑消息与最终 Markdown")}
          </h3>
        </div>
        <p>
          {uiText(
            "这里先保留产品逻辑 role；Provider 如何映射在下一分区单独展示。",
          )}
        </p>
      </div>

      <div className="prompt-message-layout">
        <ol
          className="prompt-message-index"
          aria-label={uiText("逻辑消息顺序")}
        >
          {messages.map((message, index) => {
            const label = roleDescriptions[message.role];
            return (
              <li key={message.role}>
                <button
                  aria-label={uiText("打开第 {index} 条逻辑消息：{title}", {
                    index: index + 1,
                    title: uiText(label.title),
                  })}
                  aria-pressed={message.role === selected.role}
                  onClick={() => setSelectedRole(message.role)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{uiText(label.title)}</strong>
                    <code>{message.role}</code>
                  </span>
                  <small>
                    {message.blocks.length} {uiText("块")}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>

        <article className="prompt-message-reader">
          <header>
            <div>
              <p className="prompt-preview-kicker">{selected.role}</p>
              <h4>{uiText(roleDescriptions[selected.role].title)}</h4>
              <p>{uiText(roleDescriptions[selected.role].description)}</p>
            </div>
            <span>
              {formatNumber(selected.markdown.length)} {uiText("字符")}
            </span>
          </header>

          <div
            className="prompt-message-sources"
            aria-label={uiText("消息块来源")}
          >
            {selected.blocks.map((block, index) => (
              <div key={`${block.source}:${index}`}>
                <span>
                  {uiText("块")}
                  {String(index + 1).padStart(2, "0")}
                </span>
                <code>{block.source}</code>
                <small>
                  {formatNumber(block.markdown.length)} {uiText("字符")}
                </small>
              </div>
            ))}
          </div>

          <div className="prompt-message-body">
            <div>
              <strong>{uiText("最终 Markdown 正文")}</strong>
              <span>{uiText("块之间已按真实编译顺序合并")}</span>
            </div>
            <pre>{selected.markdown}</pre>
          </div>
        </article>
      </div>
    </section>
  );
}

function MaterialsAndTools({
  coverage,
  tools,
}: {
  coverage: PromptPreviewData["compilation"]["coverage"];
  tools: PromptPreviewData["compilation"]["tools"];
}): React.JSX.Element {
  const readTools = tools.filter(({ name }) => name.startsWith("context_"));
  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="materials-tools-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">SOURCES & CAPABILITIES</p>
          <h3 id="materials-tools-title">{uiText("材料覆盖与调用链工具")}</h3>
        </div>
        <p>
          {uiText(
            "来源由真实 slot 展开；未提供边界和可继续读取入口不会被隐藏。",
          )}
        </p>
      </div>

      <div className="prompt-preview-subsection-heading">
        <h4>{uiText("Slot 覆盖")}</h4>
        <span>
          {coverage.length} {uiText("项")}
        </span>
      </div>
      <ol className="prompt-coverage-list">
        {coverage.map((entry, index) => (
          <li key={`${entry.slot}:${entry.source}:${index}`}>
            <header>
              <span className={`coverage-status coverage-${entry.status}`}>
                {uiText(coverageLabels[entry.status])}
              </span>
              <strong>{uiText(slotLabels[entry.slot] ?? entry.slot)}</strong>
              <code>{entry.slot}</code>
            </header>
            <p>{entry.source}</p>
            <footer>
              <span>
                {entry.complete ? uiText("来源完整") : uiText("来源尚未完整")}
              </span>
              <span>
                {entry.continuation === null
                  ? uiText("无需继续读取")
                  : uiText("可继续：{continuation}", {
                      continuation: entry.continuation,
                    })}
              </span>
            </footer>
          </li>
        ))}
      </ol>

      <div className="prompt-preview-subsection-heading prompt-tools-heading">
        <div>
          <h4>{uiText("本次真实工具")}</h4>
          <p>
            {readTools.length > 0
              ? uiText("按需读取入口：{tools}", {
                  tools: readTools.map(({ name }) => name).join(" / "),
                })
              : uiText("本次没有按需读取工具。")}
          </p>
        </div>
        <span>
          {tools.length} {uiText("个")}
        </span>
      </div>
      <ol className="prompt-tool-list">
        {tools.map((tool, index) => (
          <li key={tool.name}>
            <details>
              <summary>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <code>{tool.name}</code>
                <small>{uiText("查看说明与 input schema")}</small>
              </summary>
              <p>{tool.description}</p>
              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProviderMapping({
  provider,
  initialAppend,
  wireRequest,
}: {
  provider: PromptPreviewData["compilation"]["provider"];
  initialAppend: PromptPreviewData["initialAppend"];
  wireRequest: PromptPreviewData["wireRequest"];
}): React.JSX.Element {
  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="provider-mapping-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">FINAL ROLE MAPPING</p>
          <h3 id="provider-mapping-title">
            {uiText("Provider 映射 · {provider}", {
              provider: providerLabels[provider.protocol],
            })}
          </h3>
        </div>
        <p>
          {uiText("展示编译器交给当前 Adapter 的真实 system 块和消息顺序。")}
        </p>
      </div>

      {provider.system === undefined ? null : (
        <div className="provider-system-blocks">
          <div className="prompt-preview-subsection-heading">
            <h4>System blocks</h4>
            <span>
              {provider.system.length} {uiText("块")}
            </span>
          </div>
          <ol>
            {provider.system.map((block, index) => (
              <li key={index}>
                <header>
                  <span>system · {String(index + 1).padStart(2, "0")}</span>
                  {block.cache_control === undefined ? null : (
                    <small>cache_control: {block.cache_control.type}</small>
                  )}
                </header>
                <pre>{block.text}</pre>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="provider-message-list">
        <div className="prompt-preview-subsection-heading">
          <h4>{uiText("消息角色与顺序")}</h4>
          <span>
            {provider.messages.length} {uiText("条 bootstrap")}
            {initialAppend === undefined ? "" : uiText(" + 1 条玩家追加")}
            {initialAppend?.beforePlayer === undefined
              ? ""
              : uiText(" + 1 条回合提示")}
          </span>
        </div>
        <ol>
          {provider.messages.map((message, index) => (
            <li key={index}>
              <header>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{message.role}</strong>
              </header>
              <ProviderContent content={message.content} />
            </li>
          ))}
        </ol>
        {initialAppend?.beforePlayer === undefined ? null : (
          <div className="provider-message">
            <strong>{uiText("玩家输入前的回合提示")}</strong>
            <ProviderContent
              content={initialAppend.beforePlayer.provider.content}
            />
          </div>
        )}
        {initialAppend === undefined ? null : (
          <>
            <div className="prompt-preview-subsection-heading">
              <h4>{uiText("紧随 bootstrap 的首条追加")}</h4>
              <span>{uiText("原样发送")}</span>
            </div>
            <ol>
              <li>
                <header>
                  <span>append</span>
                  <strong>{initialAppend.provider.role}</strong>
                </header>
                <ProviderContent content={initialAppend.provider.content} />
              </li>
            </ol>
          </>
        )}
      </div>

      <details className="prompt-preview-raw">
        <summary>{uiText("查看 Provider 映射原始结构")}</summary>
        <pre>{JSON.stringify(provider, null, 2)}</pre>
      </details>
      {wireRequest === undefined ? null : (
        <details className="prompt-preview-raw">
          <summary>{uiText("查看实际 HTTP 请求（凭据已省略）")}</summary>
          <pre>{JSON.stringify(wireRequest, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

function ProviderContent({ content }: { content: unknown }): React.JSX.Element {
  if (typeof content === "string") return <pre>{content}</pre>;
  if (Array.isArray(content))
    return (
      <ol className="provider-content-blocks">
        {content.map((block, index) => (
          <li key={index}>
            <header>
              <span>content block · {String(index + 1).padStart(2, "0")}</span>
              <code>{contentBlockType(block)}</code>
            </header>
            <pre>
              {isTextBlock(block) ? block.text : JSON.stringify(block, null, 2)}
            </pre>
          </li>
        ))}
      </ol>
    );
  return <pre>{JSON.stringify(content, null, 2)}</pre>;
}

function BudgetAndDiagnostics({
  preview,
}: {
  preview: PromptPreviewData;
}): React.JSX.Element {
  const { budget, cache } = preview.compilation;
  const contextAdmissionDisabled =
    budget.estimator === "disabled" || budget.status === "not_checked";
  const budgetRows = [
    [uiText("消息正文"), budget.messageTokens],
    [uiText("工具定义"), budget.toolTokens],
    [uiText("本地输出预留"), budget.outputReserveTokens],
    [uiText("本地尾部预留"), budget.forcedTailReserveTokens],
    [uiText("安全余量"), budget.safetyMarginTokens],
  ] as const;
  return (
    <section
      className="panel-card prompt-preview-detail"
      aria-labelledby="budget-diagnostics-title"
    >
      <div className="prompt-preview-detail-heading">
        <div>
          <p className="prompt-preview-kicker">BUDGET, CACHE & LEAKAGE</p>
          <h3 id="budget-diagnostics-title">{uiText("预算与诊断")}</h3>
        </div>
        <p>
          {contextAdmissionDisabled
            ? uiText("Runtime 不估算上下文，也不会据此拒绝 Provider 请求。")
            : uiText("所有数值来自本次真实编译结果，不由 Web 重新估算。")}
        </p>
      </div>

      <div className="prompt-diagnostics-grid">
        <section aria-labelledby="prompt-budget-title">
          <div className="prompt-preview-subsection-heading">
            <h4 id="prompt-budget-title">{uiText("上下文预算")}</h4>
            <span>
              {contextAdmissionDisabled
                ? uiText("由 Provider 判断")
                : budget.status === "fits"
                  ? uiText("可容纳")
                  : budget.status}
            </span>
          </div>
          {contextAdmissionDisabled ? (
            <dl className="prompt-budget-breakdown">
              <div className="prompt-budget-total">
                <dt>{uiText("Provider 窗口配置")}</dt>
                <dd>{formatNumber(budget.contextWindowTokens)} tokens</dd>
              </div>
            </dl>
          ) : (
            <>
              <dl className="prompt-budget-breakdown">
                {budgetRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{formatNumber(value)} tokens</dd>
                  </div>
                ))}
                <div className="prompt-budget-total">
                  <dt>{uiText("合计 / 模型窗口")}</dt>
                  <dd>
                    {formatNumber(budget.requiredTokens)} /{" "}
                    {formatNumber(budget.contextWindowTokens)} tokens
                  </dd>
                </div>
              </dl>
              <p className="field-note">
                {uiText("估算器：")}
                {budget.estimator}
              </p>
            </>
          )}
        </section>

        <section aria-labelledby="prompt-cache-title">
          <div className="prompt-preview-subsection-heading">
            <h4 id="prompt-cache-title">{uiText("稳定前缀与缓存")}</h4>
            <span>
              {formatNumber(cache.estimatedCacheableBytes)} {uiText("字节")}
            </span>
          </div>
          <dl className="prompt-cache-report">
            <div>
              <dt>{uiText("稳定前缀 fingerprint")}</dt>
              <dd>
                <code>{cache.stablePrefixFingerprint}</code>
              </dd>
            </div>
            <div>
              <dt>{uiText("缓存策略")}</dt>
              <dd>
                <code>{cache.strategy}</code>
              </dd>
            </div>
            <div>
              <dt>{uiText("缓存断点")}</dt>
              <dd className="prompt-cache-breakpoints">
                {cache.breakpoints.length === 0
                  ? uiText("由 Provider 管理，无显式断点")
                  : cache.breakpoints.map((role) => (
                      <code key={role}>{role}</code>
                    ))}
              </dd>
            </div>
            <div>
              <dt>{uiText("首个动态边界")}</dt>
              <dd>{formatNumber(cache.firstDynamicByte)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section
        className="prompt-leakage-report"
        aria-labelledby="prompt-leakage-title"
      >
        <div>
          <span aria-hidden="true">✓</span>
          <div>
            <h4 id="prompt-leakage-title">{uiText("内部字段泄漏扫描通过")}</h4>
            <p>{uiText("Runtime 生成正文未发现以下内部字段。")}</p>
          </div>
        </div>
        <div className="prompt-leakage-fields">
          {preview.leakage.checkedFields.map((field) => (
            <code key={field}>{field}</code>
          ))}
        </div>
      </section>

      <details className="prompt-preview-raw">
        <summary>{uiText("查看固定诊断绑定与完整原始结果")}</summary>
        <dl className="prompt-binding-details">
          {Object.entries(preview.diagnosticBinding).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
        <pre>{JSON.stringify(preview, null, 2)}</pre>
      </details>
    </section>
  );
}

function modelBinding(connection: {
  provider: ModelProviderKind;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}): ModelBinding {
  return {
    provider: connection.provider,
    modelId: connection.modelId,
    contextWindowTokens: connection.contextWindowTokens,
    maxOutputTokens: connection.maxOutputTokens,
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(getWebLocale()).format(value);
}

function isTextBlock(value: unknown): value is { type: string; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function contentBlockType(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
    ? value.type
    : "raw";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : uiText("真实提示词编译失败");
}
