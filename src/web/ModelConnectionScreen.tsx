import { uiText } from "./i18n.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";

import {
  hasCLIProxyThinkingSuffix,
  isGoogleThinkingLevel,
  isSameModelServiceOrigin,
  responsesConnectionCapabilities,
  googleThinkingLevels,
  type CopyModelConnectionResult,
  type ModelConnectionLibraryView,
  type ModelConnectionView,
  type ModelAssistantPrefillMode,
  type ModelProviderDialect,
  type ModelProviderKind,
  type ModelProviderPresetId,
  type ModelReasoningEffort,
  type ModelReasoningSummary,
  type ModelThinkingMode,
} from "../protocol/modelConnections.ts";
import type { RuntimeClient } from "./runtimeClient.ts";

interface ConnectionForm {
  connectionId: string | null;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  dialect: ModelProviderDialect;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelPrompt: string;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  thinkingMode: ModelThinkingMode;
  thinkingBudgetTokens: string;
  responsesTurnInstructions: boolean;
  responsesCacheControl: boolean;
  supportsAllowedTools: boolean;
  assistantPrefillMode: ModelAssistantPrefillMode;
  contextWindowTokens: string;
  maxOutputTokens: string;
}

function emptyConnectionForm(): ConnectionForm {
  return {
    connectionId: null,
    name: uiText("默认模型"),
    presetId: "custom",
    provider: "chat_completions",
    dialect: "standard",
    baseUrl: "",
    apiKey: "",
    modelId: "",
    modelPrompt: "",
    reasoningEffort: "provider_default",
    reasoningSummary: "provider_default",
    thinkingMode: "provider_default",
    thinkingBudgetTokens: "",
    responsesTurnInstructions: false,
    responsesCacheControl: false,
    supportsAllowedTools: true,
    assistantPrefillMode: "disabled",
    contextWindowTokens: "128000",
    maxOutputTokens: "16000",
  };
}

export function ModelConnectionScreen({
  client,
  library,
  onLibraryChange,
  onNotice,
  onDirtyChange,
  pendingState,
}: {
  client: RuntimeClient;
  library: ModelConnectionLibraryView;
  onLibraryChange: (library: ModelConnectionLibraryView) => void;
  onNotice: (notice: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  pendingState?: [string | null, (next: string | null) => void];
}): React.JSX.Element {
  const initiallyActive = library.connections.find(
    ({ id }) => id === library.activeConnectionId,
  );
  const [form, setForm] = useState<ConnectionForm>(() =>
    initiallyActive === undefined
      ? emptyConnectionForm()
      : formFor(initiallyActive),
  );
  const [models, setModels] = useState<string[]>([]);
  const localPending = useState<string | null>(null);
  const [pending, setPending] = pendingState ?? localPending;
  const [dirty, setDirty] = useState(false);
  const editing = useRef({ dirty, form, onLibraryChange });
  useEffect(() => {
    editing.current = { dirty, form, onLibraryChange };
  });
  const refreshForm = useCallback((next: ModelConnectionLibraryView) => {
    const current = editing.current;
    if (current.dirty) return;
    const selected = next.connections.find(
      ({ id }) => id === current.form.connectionId,
    );
    if (selected !== undefined) {
      if (
        selected.baseUrl !== current.form.baseUrl ||
        selected.provider !== current.form.provider
      )
        setModels([]);
      setForm(formFor(selected));
    } else if (current.form.connectionId !== null)
      setForm(emptyConnectionForm());
  }, []);
  const { target, syncFailed } = useReadTarget(
    useCallback(
      () => client.request<ModelConnectionLibraryView>({ type: "model.read" }),
      [client],
    ),
    useCallback(
      (next: ModelConnectionLibraryView) => {
        editing.current.onLibraryChange(next);
        refreshForm(next);
      },
      [refreshForm],
    ),
  );
  const previousLibrary = useRef(library);
  useEffect(() => {
    if (previousLibrary.current === library) return;
    previousLibrary.current = library;
    target.accept();
    refreshForm(library);
  }, [library, target, refreshForm]);
  const active = library.connections.find(
    ({ id }) => id === library.activeConnectionId,
  );
  const selectedPreset = useMemo(
    () => library.presets.find(({ id }) => id === form.presetId),
    [form.presetId, library.presets],
  );
  const google = form.provider === "google_interactions";
  const savedConnection = library.connections.find(
    ({ id }) => id === form.connectionId,
  );
  const credentialsMustBeEntered =
    savedConnection === undefined ||
    !isSameModelServiceOrigin(savedConnection.baseUrl, form.baseUrl);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  function acceptLibrary(next: ModelConnectionLibraryView): void {
    target.accept();
    onLibraryChange(next);
  }

  function change(
    next: Partial<ConnectionForm>,
    invalidateModels = false,
  ): void {
    setForm((current) => {
      const updated = { ...current, ...next };
      if (
        updated.baseUrl !== current.baseUrl &&
        !isSameModelServiceOrigin(current.baseUrl, updated.baseUrl)
      )
        updated.apiKey = "";
      if (updated.provider !== "openai_responses")
        updated.responsesTurnInstructions = false;
      if (
        updated.provider !== "openai_responses" ||
        updated.dialect !== "cliproxyapi"
      )
        updated.responsesCacheControl = false;
      return updated;
    });
    setDirty(true);
    if (invalidateModels) setModels([]);
  }

  function changeModelId(modelId: string): void {
    change({
      modelId,
      ...(form.provider === "anthropic_messages" &&
      form.thinkingMode === "provider_default" &&
      !cliProxySuffixControlsThinking({ ...form, modelId })
        ? { reasoningSummary: "provider_default" as const }
        : {}),
    });
  }

  function choosePreset(presetId: ModelProviderPresetId): void {
    const preset = library.presets.find(({ id }) => id === presetId);
    if (preset === undefined) return;
    change(
      preset.id === "custom"
        ? { presetId }
        : {
            presetId,
            provider: preset.provider,
            dialect: "standard",
            assistantPrefillMode: "disabled",
            ...reasoningForProvider(form, preset.provider, "standard"),
            baseUrl: preset.baseUrl,
            name:
              form.connectionId === null || form.name === uiText("默认模型")
                ? preset.name
                : form.name,
          },
      true,
    );
  }

  function edit(connection: ModelConnectionView): void {
    setForm(formFor(connection));
    setModels([]);
    setDirty(false);
    onNotice("");
  }

  function startNew(): void {
    setForm(emptyConnectionForm());
    setModels([]);
    setDirty(false);
    onNotice("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending !== null) return;
    setPending("save");
    try {
      const next = await target.command(() =>
        client.request<ModelConnectionLibraryView>({
          type: "model.save",
          connection: {
            ...(form.connectionId === null
              ? {}
              : { connectionId: form.connectionId }),
            name: form.name,
            presetId: form.presetId,
            provider: form.provider,
            dialect: form.dialect,
            baseUrl: form.baseUrl,
            ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
            modelId: form.modelId,
            modelPrompt: form.modelPrompt,
            reasoningEffort: form.reasoningEffort,
            reasoningSummary: form.reasoningSummary,
            thinkingMode: form.thinkingMode,
            ...responsesConnectionCapabilities(
              form.provider,
              form.dialect,
              form,
            ),
            supportsAllowedTools: form.supportsAllowedTools,
            assistantPrefillMode: form.assistantPrefillMode,
            thinkingBudgetTokens:
              form.thinkingMode === "enabled"
                ? Number(form.thinkingBudgetTokens)
                : null,
            contextWindowTokens: Number(form.contextWindowTokens),
            maxOutputTokens: Number(form.maxOutputTokens),
          },
        }),
      );
      acceptLibrary(next);
      setDirty(false);
      const saved = next.connections.find(
        ({ id }) => id === next.activeConnectionId,
      );
      if (saved !== undefined) edit(saved);
      onNotice(uiText("模型连接已保存并启用；后续请求只使用当前配置。"));
    } catch (error: unknown) {
      onNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function select(connectionId: string): Promise<void> {
    if (pending !== null) return;
    setPending(connectionId);
    try {
      const next = await target.command(() =>
        client.request<ModelConnectionLibraryView>({
          type: "model.select",
          connectionId,
        }),
      );
      acceptLibrary(next);
      onNotice(uiText("已切换当前模型配置；Runtime 不会自动故障转移。"));
    } catch (error: unknown) {
      onNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function copy(connection: ModelConnectionView): Promise<void> {
    if (pending !== null) return;
    setPending(`copy:${connection.id}`);
    try {
      const name = copyName(connection.name, library.connections);
      const result = await target.command(() =>
        client.request<CopyModelConnectionResult>({
          type: "model.copy",
          connectionId: connection.id,
          name,
        }),
      );
      const copied = result.library.connections.find(
        ({ id }) => id === result.copiedConnectionId,
      );
      if (copied === undefined)
        throw new Error(uiText("Runtime 没有返回已克隆的模型配置"));
      acceptLibrary(result.library);
      edit(copied);
      onNotice(
        uiText("已克隆为「{name}」。副本保留本机凭据，但不会切换当前配置。", {
          name: copied.name,
        }),
      );
    } catch (error: unknown) {
      onNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function remove(connectionId: string): Promise<void> {
    if (pending !== null) return;
    setPending(`delete:${connectionId}`);
    try {
      const next = await target.command(() =>
        client.request<ModelConnectionLibraryView>({
          type: "model.delete",
          connectionId,
        }),
      );
      acceptLibrary(next);
      if (form.connectionId === connectionId) startNew();
      onNotice(uiText("模型配置已从本机删除。"));
    } catch (error: unknown) {
      onNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function pullModels(): Promise<void> {
    if (pending !== null) return;
    setPending("models");
    try {
      const result = await target.command(() =>
        client.request<{ models: string[] }>({
          type: "model.models",
          ...(form.connectionId === null
            ? {}
            : { connectionId: form.connectionId }),
          provider: form.provider,
          baseUrl: form.baseUrl,
          ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
        }),
      );
      setModels(result.models);
      onNotice(
        uiText("已从当前端点拉取 {count} 个模型 ID。", {
          count: result.models.length,
        }),
      );
    } catch (error: unknown) {
      onNotice(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="model-connection-screen" aria-labelledby="model-title">
      <header className="config-header">
        <div>
          <p className="eyebrow">{uiText("工作区设置")}</p>
          <h2 id="model-title">{uiText("模型连接")}</h2>
          <p className="field-note">
            {uiText(
              "保存多份本机配置并明确切换。API Key 不会返回浏览器；切换失败时 Runtime 不会悄悄改用另一份配置。",
            )}
          </p>
        </div>
        <div className="model-active-summary">
          <span>{uiText("当前配置")}</span>
          <strong>{active?.name ?? uiText("尚未启用")}</strong>
          <small>{active?.modelId ?? uiText("先保存一份可用连接")}</small>
        </div>
      </header>

      <SyncNotice failed={syncFailed} onRead={() => void target.recover()} />

      <fieldset disabled={pending !== null} className="config-layout">
        <form
          className="config-form panel-card"
          onSubmit={(event) => void save(event)}
        >
          <div className="section-heading-row">
            <h3>
              {form.connectionId === null
                ? uiText("新建配置")
                : uiText("编辑配置")}
            </h3>
            {form.connectionId !== null && (
              <button
                className="secondary-button"
                disabled={dirty}
                onClick={startNew}
                type="button"
              >
                {uiText("新建另一份")}
              </button>
            )}
          </div>

          <label htmlFor="model-preset">{uiText("提供商")}</label>
          <select
            id="model-preset"
            value={form.presetId}
            onChange={(event) =>
              choosePreset(event.target.value as ModelProviderPresetId)
            }
          >
            {library.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>

          <label htmlFor="model-name">{uiText("配置名称")}</label>
          <input
            id="model-name"
            maxLength={160}
            required
            value={form.name}
            onChange={(event) => change({ name: event.target.value })}
          />

          <label htmlFor="model-provider">{uiText("协议适配器")}</label>
          <select
            id="model-provider"
            value={form.provider}
            onChange={(event) =>
              change(
                {
                  presetId: "custom",
                  provider: event.target.value as ModelProviderKind,
                  assistantPrefillMode: "disabled",
                  ...reasoningForProvider(
                    form,
                    event.target.value as ModelProviderKind,
                    form.dialect,
                  ),
                },
                true,
              )
            }
          >
            <option value="chat_completions">
              OpenAI-compatible Chat Completions
            </option>
            <option value="openai_responses">OpenAI Responses API</option>
            <option value="anthropic_messages">Anthropic Messages</option>
            <option value="google_interactions">
              Google Gemini · Interactions
            </option>
          </select>

          <label htmlFor="model-dialect">{uiText("端点方言")}</label>
          <select
            id="model-dialect"
            value={form.dialect}
            onChange={(event) => {
              const dialect = event.target.value as ModelProviderDialect;
              change({
                dialect,
                ...reasoningForProvider(form, form.provider, dialect),
              });
            }}
          >
            <option value="standard">{uiText("协议标准")}</option>
            <option value="cliproxyapi">CLIProxyAPI</option>
          </select>
          <details className="parameter-help">
            <summary>{uiText("参数说明")}</summary>
            <p className="field-note">
              {uiText(
                "CLIProxyAPI 方言只启用代理明确支持的兼容参数；响应仍按所选协议解析，不从可见文本猜测思考块。Claude 的签名 thinking 请选 Responses 或 Anthropic Messages；Chat Completions 通常只有 reasoning_content，不能承诺无损续传签名。模型名的 (high) 等 thinking 后缀会覆盖请求参数，因此 Effort 与 Thinking 都必须保留“Provider 默认”。",
              )}
            </p>
          </details>

          <div className="model-reasoning-fields">
            <label htmlFor="model-reasoning-effort">
              {uiText("Effort（推理强度）")}
              <select
                id="model-reasoning-effort"
                value={form.reasoningEffort}
                onChange={(event) =>
                  change({
                    reasoningEffort: event.target.value as ModelReasoningEffort,
                    ...(google && event.target.value !== "provider_default"
                      ? {
                          thinkingMode: "provider_default",
                          thinkingBudgetTokens: "",
                        }
                      : {}),
                  })
                }
              >
                <option value="provider_default">
                  {uiText("Provider 默认")}
                </option>
                {google ? (
                  googleThinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))
                ) : (
                  <>
                    {form.provider === "anthropic_messages" ? null : (
                      <>
                        <option value="none">none</option>
                        <option value="minimal">minimal</option>
                      </>
                    )}
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </>
                )}
              </select>
            </label>
            <label htmlFor="model-thinking-mode">
              {uiText(
                google ? "Thinking（兼容预算模式）" : "Thinking（思考模式）",
              )}
              <select
                id="model-thinking-mode"
                disabled={!google && form.provider !== "anthropic_messages"}
                value={form.thinkingMode}
                onChange={(event) => {
                  const thinkingMode = event.target.value as ModelThinkingMode;
                  change({
                    thinkingMode,
                    ...(google && thinkingMode !== "provider_default"
                      ? { reasoningEffort: "provider_default" }
                      : {}),
                    thinkingBudgetTokens:
                      thinkingMode === "enabled"
                        ? form.thinkingBudgetTokens ||
                          defaultThinkingBudget(form.maxOutputTokens)
                        : "",
                    reasoningSummary:
                      !google &&
                      (thinkingMode === "provider_default" ||
                        thinkingMode === "disabled")
                        ? thinkingMode === "provider_default" &&
                          cliProxySuffixControlsThinking({
                            ...form,
                            thinkingMode,
                          })
                          ? form.reasoningSummary
                          : "provider_default"
                        : form.reasoningSummary,
                  });
                }}
              >
                <option value="provider_default">
                  {uiText("Provider 默认")}
                </option>
                <option value="adaptive">adaptive</option>
                <option value="enabled">{uiText("手动 token 预算")}</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label htmlFor="model-reasoning-summary">
              {uiText("Thinking 返回内容")}
              <select
                id="model-reasoning-summary"
                disabled={
                  (form.provider === "chat_completions" &&
                    form.dialect === "standard") ||
                  (form.provider === "anthropic_messages" &&
                    (form.thinkingMode === "provider_default" ||
                      form.thinkingMode === "disabled") &&
                    !cliProxySuffixControlsThinking(form))
                }
                value={form.reasoningSummary}
                onChange={(event) =>
                  change({
                    reasoningSummary: event.target
                      .value as ModelReasoningSummary,
                  })
                }
              >
                <option value="provider_default">
                  {uiText("Provider 默认")}
                </option>
                <option value="auto">auto</option>
                {form.provider === "openai_responses" ? (
                  <>
                    <option value="concise">concise</option>
                    <option value="detailed">detailed</option>
                  </>
                ) : null}
                <option value="none">none</option>
              </select>
            </label>
          </div>
          {(google || form.provider === "anthropic_messages") &&
          form.thinkingMode === "enabled" ? (
            <label htmlFor="model-thinking-budget">
              {uiText("Thinking budget tokens")}
              <input
                id="model-thinking-budget"
                min={google ? 0 : 1024}
                max={
                  google
                    ? undefined
                    : Math.max(1024, Number(form.maxOutputTokens) - 1)
                }
                required
                step={1}
                type="number"
                value={form.thinkingBudgetTokens}
                onChange={(event) =>
                  change({ thinkingBudgetTokens: event.target.value })
                }
              />
            </label>
          ) : null}
          <details className="parameter-help">
            <summary>{uiText("参数说明")}</summary>
            <p className="field-note">
              {uiText(
                google
                  ? "Google 推理强度发送 thinking_level，摘要发送 thinking_summaries。兼容预算模式改用 thinking_budget：adaptive 为 -1，disabled 为 0，手动模式发送填写的整数。具体支持取决于端点和模型。"
                  : "Effort 控制整份响应投入；Anthropic Thinking 独立控制思考块，手动预算必须小于最大输出。Thinking 返回内容只进入模型诊断；原生续传块仍会原样保存。",
              )}
            </p>
          </details>

          {!google && (
            <details className="parameter-help">
              <summary>{uiText("高级选项")}</summary>
              {form.provider === "openai_responses" ? (
                <>
                  <label htmlFor="model-responses-turn-instructions">
                    {uiText("GPT-6.2 本轮提示")}
                  </label>
                  <select
                    id="model-responses-turn-instructions"
                    value={String(form.responsesTurnInstructions)}
                    onChange={(event) =>
                      change({
                        responsesTurnInstructions:
                          event.target.value === "true",
                      })
                    }
                  >
                    <option value="false">
                      {uiText("玩家本轮临时要求放在 input 末尾（默认）")}
                    </option>
                    <option value="true">
                      {uiText("玩家本轮临时要求放入 instructions")}
                    </option>
                  </select>
                  <p className="field-note">
                    {uiText(
                      "编排方案和世界的固定本轮提示始终放入 instructions。GPT-6.2 在 input 之后读取该字段。开启后，玩家的临时要求和后置请求各自的任务说明也通过该字段发送。",
                    )}
                  </p>
                  {form.dialect === "cliproxyapi" && (
                    <>
                      <label htmlFor="model-responses-cache-control">
                        {uiText("CLIProxyAPI 转 Claude 的显式缓存标记")}
                      </label>
                      <select
                        id="model-responses-cache-control"
                        value={String(form.responsesCacheControl)}
                        onChange={(event) =>
                          change({
                            responsesCacheControl:
                              event.target.value === "true",
                          })
                        }
                      >
                        <option value="false">{uiText("否")}</option>
                        <option value="true">{uiText("是")}</option>
                      </select>
                      <p className="field-note">
                        {uiText(
                          "仅当此路由将 Responses 转为支持 cache_control 的 Anthropic Messages 时开启。Codex 路由请保持关闭。",
                        )}
                      </p>
                    </>
                  )}
                  <label htmlFor="model-allowed-tools">
                    {uiText("支持工具子集选择（allowed_tools）")}
                  </label>
                  <select
                    id="model-allowed-tools"
                    value={String(form.supportsAllowedTools)}
                    onChange={(event) =>
                      change({
                        supportsAllowedTools: event.target.value === "true",
                      })
                    }
                  >
                    <option value="true">{uiText("是")}</option>
                    <option value="false">{uiText("否")}</option>
                  </select>
                </>
              ) : null}
              <>
                <label htmlFor="model-assistant-prefill">
                  {uiText("中断回复的续写方式")}
                </label>
                <select
                  id="model-assistant-prefill"
                  value={form.assistantPrefillMode}
                  onChange={(event) =>
                    change({
                      assistantPrefillMode: event.target
                        .value as ModelAssistantPrefillMode,
                    })
                  }
                >
                  <option value="disabled">{uiText("通用续写指令")}</option>
                  <option value="assistant">
                    {uiText("普通 assistant 预填充")}
                  </option>
                  {form.provider === "openai_responses" && (
                    <option value="partial">
                      {uiText("partial: true（火山方舟）")}
                    </option>
                  )}
                  {form.provider === "chat_completions" && (
                    <>
                      <option value="prefix">
                        {uiText("prefix: true（DeepSeek）")}
                      </option>
                      <option value="mistral_prefix">
                        {uiText("prefix: true（Mistral，响应包含前缀）")}
                      </option>
                      <option value="partial">
                        {uiText("partial: true（Kimi / 千问）")}
                      </option>
                    </>
                  )}
                </select>
                <p className="field-note">
                  {uiText(
                    "默认随原请求发送已收到的正文，并要求模型只返回后文。服务和模型支持原生预填充时，可以选择对应的格式。",
                  )}
                </p>
                {form.assistantPrefillMode === "assistant" && (
                  <p className="field-note">
                    {uiText(
                      "普通预填充依赖具体端点；标准 OpenAI 不支持，OpenRouter 等兼容端点须确认模型支持。Anthropic 仅限受支持的旧模型，并须关闭 Thinking；Claude 4.6 及后续模型不支持。",
                    )}
                  </p>
                )}
                {form.assistantPrefillMode === "prefix" && (
                  <p className="field-note">
                    {uiText(
                      "DeepSeek 前缀补全须使用支持此能力的 /beta 端点；响应按新增正文拼接。",
                    )}
                  </p>
                )}
                {form.assistantPrefillMode === "mistral_prefix" && (
                  <p className="field-note">
                    {uiText("Mistral 返回包含已发前缀的完整正文，不重复拼接。")}
                  </p>
                )}
                {form.assistantPrefillMode === "partial" && (
                  <p className="field-note">
                    {uiText(
                      form.provider === "openai_responses"
                        ? "火山方舟 Responses 仅限支持 partial 的模型；标准 OpenAI Responses 不支持。"
                        : "Kimi / 千问的模型与思考模式须支持 partial。",
                    )}
                  </p>
                )}
              </>
            </details>
          )}
          <label htmlFor="model-base-url">Base URL</label>
          <input
            id="model-base-url"
            aria-label="Base URL"
            required
            type="url"
            value={form.baseUrl}
            onChange={(event) =>
              change({ presetId: "custom", baseUrl: event.target.value }, true)
            }
          />
          {selectedPreset?.id !== "custom" && (
            <p className="field-note">
              {uiText("已填入")}
              {selectedPreset?.name}{" "}
              {uiText("的内置端点；手动修改后按自定义端点保存。")}
            </p>
          )}

          <label htmlFor="model-api-key">API Key</label>
          <input
            autoComplete="off"
            id="model-api-key"
            aria-label="API Key"
            required={credentialsMustBeEntered}
            type="password"
            value={form.apiKey}
            placeholder={
              form.connectionId === null
                ? uiText("新配置必填")
                : credentialsMustBeEntered
                  ? uiText("更换服务来源时必填")
                  : uiText("留空以沿用本机保存的现有凭据")
            }
            onChange={(event) => change({ apiKey: event.target.value }, true)}
          />
          <p className="field-note">
            {uiText(
              "地址的协议方案、主机和端口相同时，可留空沿用本机凭据。更换服务来源须填写对应的 API Key。",
            )}
          </p>

          <div className="model-picker-row">
            <div>
              <label htmlFor="model-id">{uiText("模型 ID")}</label>
              <input
                id="model-id"
                aria-label={uiText("模型 ID")}
                maxLength={512}
                required
                value={form.modelId}
                onChange={(event) => changeModelId(event.target.value)}
              />
            </div>
            <button
              className="secondary-button"
              disabled={
                pending !== null ||
                form.baseUrl.length === 0 ||
                (credentialsMustBeEntered && form.apiKey.length === 0)
              }
              onClick={() => void pullModels()}
              type="button"
            >
              {pending === "models"
                ? uiText("正在拉取…")
                : uiText("从端点拉取模型")}
            </button>
          </div>
          {form.provider === "google_interactions" && (
            <p className="field-note">
              {uiText("端点列出的模型能否用于 Interactions，取决于所选模型。")}
            </p>
          )}
          {models.length > 0 && (
            <div>
              <label htmlFor="fetched-model-id">{uiText("已拉取的模型")}</label>
              <select
                id="fetched-model-id"
                value={models.includes(form.modelId) ? form.modelId : ""}
                disabled={pending !== null}
                onChange={(event) => changeModelId(event.target.value)}
              >
                <option value="" disabled>
                  {uiText("选择模型")}
                </option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <p className="field-note">
                {uiText("选择后会填入模型 ID，也可以手动输入。")}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="model-prompt">{uiText("模型提示词（可选）")}</label>
            <textarea
              id="model-prompt"
              rows={5}
              value={form.modelPrompt}
              onChange={(event) => change({ modelPrompt: event.target.value })}
            />
          </div>

          <div className="two-column-fields">
            <label>
              {uiText("真实 context window")}
              <input
                min={4096}
                max={16_777_216}
                required
                step={1}
                type="number"
                value={form.contextWindowTokens}
                onChange={(event) =>
                  change({ contextWindowTokens: event.target.value })
                }
              />
            </label>
            <label>
              {uiText("最大输出 tokens")}
              <input
                min={256}
                max={16_777_215}
                required
                step={1}
                type="number"
                value={form.maxOutputTokens}
                onChange={(event) =>
                  change({ maxOutputTokens: event.target.value })
                }
              />
            </label>
          </div>

          <div className="form-actions">
            <button disabled={pending !== null} type="submit">
              {pending === "save"
                ? uiText("正在保存…")
                : uiText("保存模型连接并启用")}
            </button>
            {dirty && form.connectionId !== null && (
              <button
                className="secondary-button"
                disabled={pending !== null}
                onClick={() => {
                  const original = library.connections.find(
                    ({ id }) => id === form.connectionId,
                  );
                  if (original !== undefined) edit(original);
                }}
                type="button"
              >
                {uiText("放弃修改")}
              </button>
            )}
            {dirty && form.connectionId === null && (
              <button
                className="secondary-button"
                disabled={pending !== null}
                onClick={startNew}
                type="button"
              >
                {uiText("重置新配置")}
              </button>
            )}
          </div>
        </form>

        <section className="config-list" aria-label={uiText("已保存模型配置")}>
          <div className="section-heading-row">
            <h3>{uiText("已保存配置")}</h3>
            <span>
              {library.connections.length} {uiText("份")}
            </span>
          </div>
          {library.connections.length === 0 && (
            <p className="panel-card">{uiText("尚未保存模型配置。")}</p>
          )}
          {library.connections.map((connection) => {
            const isActive = connection.id === library.activeConnectionId;
            return (
              <article
                className={`config-card panel-card${isActive ? " active-model-config" : ""}`}
                key={connection.id}
              >
                <div className="section-heading-row">
                  <div>
                    <p className="eyebrow">
                      {providerLabel(connection.provider)}
                    </p>
                    <h3>{connection.name}</h3>
                  </div>
                  {isActive && (
                    <span className="active-config">{uiText("当前使用")}</span>
                  )}
                </div>
                <details className="model-connection-details">
                  <summary>{connection.modelId}</summary>
                  <dl>
                    <div>
                      <dt>{uiText("模型")}</dt>
                      <dd>{connection.modelId}</dd>
                    </div>
                    <div>
                      <dt>{uiText("端点")}</dt>
                      <dd>{connection.baseUrl}</dd>
                    </div>
                    <div>
                      <dt>{uiText("窗口 / 输出")}</dt>
                      <dd>
                        {connection.contextWindowTokens.toLocaleString()} /{" "}
                        {connection.maxOutputTokens.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>{uiText("方言 / Effort / Thinking")}</dt>
                      <dd>
                        {connection.dialect} / {connection.reasoningEffort} /{" "}
                        {connection.thinkingMode}
                        {connection.thinkingBudgetTokens === null
                          ? ""
                          : ` (${connection.thinkingBudgetTokens.toLocaleString()} tokens)`}{" "}
                        / {connection.reasoningSummary}
                      </dd>
                    </div>
                    <div>
                      <dt>{uiText("凭据")}</dt>
                      <dd>
                        {connection.hasApiKey
                          ? uiText("已保存在本机")
                          : uiText("未配置")}
                      </dd>
                    </div>
                  </dl>
                </details>
                <div className="form-actions">
                  {!isActive && (
                    <button
                      disabled={pending !== null}
                      onClick={() => void select(connection.id)}
                      type="button"
                    >
                      {pending === connection.id
                        ? uiText("正在切换…")
                        : uiText("切换到此配置")}
                    </button>
                  )}
                  <button
                    className="secondary-button"
                    disabled={pending !== null || dirty}
                    onClick={() => void copy(connection)}
                    type="button"
                  >
                    {pending === `copy:${connection.id}`
                      ? uiText("正在克隆…")
                      : uiText("克隆配置")}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      pending !== null ||
                      dirty ||
                      form.connectionId === connection.id
                    }
                    onClick={() => edit(connection)}
                    type="button"
                  >
                    {form.connectionId === connection.id
                      ? uiText("正在编辑")
                      : uiText("编辑")}
                  </button>
                  <button
                    className="danger-button"
                    disabled={
                      pending !== null ||
                      dirty ||
                      (isActive && library.connections.length > 1)
                    }
                    onClick={() => void remove(connection.id)}
                    type="button"
                  >
                    {pending === `delete:${connection.id}`
                      ? uiText("正在删除…")
                      : uiText("删除")}
                  </button>
                </div>
                {isActive && library.connections.length > 1 && (
                  <p className="field-note">
                    {uiText("先切换到另一份配置，才能删除当前配置。")}
                  </p>
                )}
              </article>
            );
          })}
        </section>
      </fieldset>
    </section>
  );
}

function providerLabel(provider: ModelProviderKind): string {
  switch (provider) {
    case "chat_completions":
      return "Chat Completions";
    case "openai_responses":
      return "OpenAI Responses";
    case "anthropic_messages":
      return "Anthropic Messages";
    case "google_interactions":
      return "Google Gemini · Interactions";
  }
}

function formFor(connection: ModelConnectionView): ConnectionForm {
  return {
    connectionId: connection.id,
    name: connection.name,
    presetId: connection.presetId,
    provider: connection.provider,
    dialect: connection.dialect,
    baseUrl: connection.baseUrl,
    apiKey: "",
    modelId: connection.modelId,
    modelPrompt: connection.modelPrompt ?? "",
    reasoningEffort: connection.reasoningEffort,
    reasoningSummary: connection.reasoningSummary,
    thinkingMode: connection.thinkingMode,
    responsesTurnInstructions: connection.responsesTurnInstructions ?? false,
    responsesCacheControl: connection.responsesCacheControl ?? false,
    supportsAllowedTools: connection.supportsAllowedTools,
    assistantPrefillMode: connection.assistantPrefillMode,
    thinkingBudgetTokens:
      connection.thinkingBudgetTokens === null
        ? ""
        : String(connection.thinkingBudgetTokens),
    contextWindowTokens: String(connection.contextWindowTokens),
    maxOutputTokens: String(connection.maxOutputTokens),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : uiText("模型配置操作失败");
}

function copyName(
  sourceName: string,
  connections: readonly ModelConnectionView[],
): string {
  const names = new Set(connections.map(({ name }) => name));
  for (
    let copyNumber = 1;
    copyNumber <= connections.length + 1;
    copyNumber += 1
  ) {
    const suffix =
      copyNumber === 1
        ? uiText("（副本）")
        : uiText("（副本 {number}）", { number: copyNumber });
    const candidate = `${sourceName.slice(0, Math.max(0, 160 - suffix.length))}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(uiText("无法生成不重复的副本名称"));
}

function reasoningForProvider(
  form: ConnectionForm,
  provider: ModelProviderKind,
  dialect: ModelProviderDialect,
): Pick<
  ConnectionForm,
  | "reasoningEffort"
  | "reasoningSummary"
  | "thinkingMode"
  | "thinkingBudgetTokens"
> {
  const reasoningEffort =
    (provider === "google_interactions" &&
      !isGoogleThinkingLevel(form.reasoningEffort)) ||
    (provider === "anthropic_messages" &&
      (form.reasoningEffort === "none" || form.reasoningEffort === "minimal"))
      ? "provider_default"
      : form.reasoningEffort;
  const thinkingMode =
    provider === form.provider &&
    (provider === "anthropic_messages" || provider === "google_interactions")
      ? form.thinkingMode
      : "provider_default";
  const suffixControlsThinking = cliProxySuffixControlsThinking({
    ...form,
    provider,
    dialect,
    thinkingMode,
  });
  const reasoningSummary =
    (provider !== "openai_responses" &&
      (form.reasoningSummary === "concise" ||
        form.reasoningSummary === "detailed")) ||
    (provider === "chat_completions" && dialect === "standard") ||
    (provider === "anthropic_messages" &&
      (thinkingMode === "provider_default" || thinkingMode === "disabled") &&
      !suffixControlsThinking)
      ? "provider_default"
      : form.reasoningSummary;
  return {
    reasoningEffort,
    reasoningSummary,
    thinkingMode,
    thinkingBudgetTokens:
      thinkingMode === "enabled" ? form.thinkingBudgetTokens : "",
  };
}

function cliProxySuffixControlsThinking(
  form: Pick<
    ConnectionForm,
    "provider" | "dialect" | "modelId" | "thinkingMode"
  >,
): boolean {
  return (
    form.provider === "anthropic_messages" &&
    form.dialect === "cliproxyapi" &&
    form.thinkingMode === "provider_default" &&
    hasCLIProxyThinkingSuffix(form.modelId)
  );
}

function defaultThinkingBudget(maxOutputTokens: string): string {
  const output = Number(maxOutputTokens);
  if (!Number.isSafeInteger(output) || output <= 1_024) return "1024";
  return String(Math.min(8_192, output - 1));
}
