import { uiText } from "./i18n.ts";
import { useEffect, useMemo, useState } from "react";

import type {
  ModelConnectionLibraryView,
  ModelConnectionView,
  ModelProviderKind,
  ModelProviderPresetId,
} from "../protocol/modelConnections.ts";
import type { RuntimeClient } from "./runtimeClient.ts";

interface ConnectionForm {
  connectionId: string | null;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
}

function emptyConnectionForm(): ConnectionForm {
  return {
    connectionId: null,
    name: uiText("默认模型"),
    presetId: "custom",
    provider: "chat_completions",
    baseUrl: "",
    apiKey: "",
    modelId: "",
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
}: {
  client: RuntimeClient;
  library: ModelConnectionLibraryView;
  onLibraryChange: (library: ModelConnectionLibraryView) => void;
  onNotice: (notice: string) => void;
  onDirtyChange: (dirty: boolean) => void;
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
  const [pending, setPending] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const active = library.connections.find(
    ({ id }) => id === library.activeConnectionId,
  );
  const selectedPreset = useMemo(
    () => library.presets.find(({ id }) => id === form.presetId),
    [form.presetId, library.presets],
  );
  const editedConnection = library.connections.find(
    ({ id }) => id === form.connectionId,
  );
  const credentialsMustBeEntered =
    form.connectionId === null ||
    editedConnection?.provider !== form.provider ||
    comparableUrl(editedConnection?.baseUrl ?? "") !==
      comparableUrl(form.baseUrl);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  function change(
    next: Partial<ConnectionForm>,
    invalidateModels = false,
  ): void {
    setForm((current) => ({ ...current, ...next }));
    setDirty(true);
    if (invalidateModels) setModels([]);
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
      const next = await client.request<ModelConnectionLibraryView>({
        type: "model.save",
        connection: {
          ...(form.connectionId === null
            ? {}
            : { connectionId: form.connectionId }),
          name: form.name,
          presetId: form.presetId,
          provider: form.provider,
          baseUrl: form.baseUrl,
          ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
          modelId: form.modelId,
          contextWindowTokens: Number(form.contextWindowTokens),
          maxOutputTokens: Number(form.maxOutputTokens),
        },
      });
      onLibraryChange(next);
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
      const next = await client.request<ModelConnectionLibraryView>({
        type: "model.select",
        connectionId,
      });
      onLibraryChange(next);
      onNotice(uiText("已切换当前模型配置；Runtime 不会自动故障转移。"));
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
      const next = await client.request<ModelConnectionLibraryView>({
        type: "model.delete",
        connectionId,
      });
      onLibraryChange(next);
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
      const result = await client.request<{ models: string[] }>({
        type: "model.models",
        ...(form.connectionId === null
          ? {}
          : { connectionId: form.connectionId }),
        provider: form.provider,
        baseUrl: form.baseUrl,
        ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
      });
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
          <p className="eyebrow">WORKSPACE SETTING</p>
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

      <div className="config-layout">
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
          </select>

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
                  ? uiText("端点或协议已改变，必须重新填写")
                  : uiText("留空以保留当前端点的现有凭据")
            }
            onChange={(event) => change({ apiKey: event.target.value }, true)}
          />
          <p className="field-note">
            {uiText("旧凭据只会为同一协议和端点保留，不会静默转发到新端点。")}
          </p>

          <div className="model-picker-row">
            <div>
              <label htmlFor="model-id">{uiText("模型 ID")}</label>
              <input
                id="model-id"
                aria-label={uiText("模型 ID")}
                list="provider-models"
                maxLength={512}
                required
                value={form.modelId}
                onChange={(event) => change({ modelId: event.target.value })}
              />
              <datalist id="provider-models">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
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
          {models.length > 0 && (
            <p className="field-note">
              {uiText("可在模型 ID 输入框中选择已拉取结果。")}
            </p>
          )}

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
                    <dt>{uiText("凭据")}</dt>
                    <dd>
                      {connection.hasApiKey
                        ? uiText("已保存在本机")
                        : uiText("未配置")}
                    </dd>
                  </div>
                </dl>
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
      </div>
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
  }
}

function formFor(connection: ModelConnectionView): ConnectionForm {
  return {
    connectionId: connection.id,
    name: connection.name,
    presetId: connection.presetId,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    apiKey: "",
    modelId: connection.modelId,
    contextWindowTokens: String(connection.contextWindowTokens),
    maxOutputTokens: String(connection.maxOutputTokens),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : uiText("模型配置操作失败");
}

function comparableUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
