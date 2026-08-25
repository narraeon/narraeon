import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  modelProviderPresets,
  type ListProviderModelsInput,
  type ModelConnectionLibraryView,
  type ModelConnectionView,
  type ModelProviderKind,
  type ModelProviderPresetId,
  type SaveModelConnectionInput,
} from "../../protocol/modelConnections.ts";
import type { FileNativeModelConnection } from "./FileNativeModelAdapters.ts";

const libraryFileName = "model-connections-v1.json";
const maxModelListBytes = 1024 * 1024;

interface StoredModelConnection extends FileNativeModelConnection {
  id: string;
  name: string;
  presetId: ModelProviderPresetId;
}

interface ModelConnectionDocument {
  schemaVersion: 1;
  activeConnectionId: string | null;
  connections: StoredModelConnection[];
}

export class ModelConnectionUnavailableError extends Error {
  constructor() {
    super("尚未启用 V1 模型连接");
    this.name = "ModelConnectionUnavailableError";
  }
}

export class ModelConnectionStore {
  readonly #configRoot: string;
  readonly #path: string;
  readonly #fetch: typeof fetch;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(configRoot: string, fetchImplementation: typeof fetch = fetch) {
    this.#configRoot = configRoot;
    this.#path = join(configRoot, libraryFileName);
    this.#fetch = fetchImplementation;
  }

  async view(): Promise<ModelConnectionLibraryView> {
    await this.#mutationTail;
    const document = await this.#readDocument();
    return this.#viewDocument(document);
  }

  save(input: SaveModelConnectionInput): Promise<ModelConnectionLibraryView> {
    return this.#mutate(async () => {
      const document = await this.#readDocument();
      const index =
        input.connectionId === undefined
          ? -1
          : document.connections.findIndex(
              ({ id }) => id === input.connectionId,
            );
      if (input.connectionId !== undefined && index < 0)
        throw new Error("没有找到要编辑的模型配置");
      const existing = index < 0 ? undefined : document.connections[index];
      const saved: StoredModelConnection = {
        id: existing?.id ?? randomUUID(),
        ...normalizeSaveInput(input, existing),
      };
      if (index < 0) document.connections.push(saved);
      else document.connections[index] = saved;
      document.activeConnectionId = saved.id;
      await this.#writeDocument(document);
      return this.#viewDocument(document);
    });
  }

  select(connectionId: string): Promise<ModelConnectionLibraryView> {
    return this.#mutate(async () => {
      const document = await this.#readDocument();
      if (!document.connections.some(({ id }) => id === connectionId))
        throw new Error("没有找到要启用的模型配置");
      document.activeConnectionId = connectionId;
      await this.#writeDocument(document);
      return this.#viewDocument(document);
    });
  }

  delete(connectionId: string): Promise<ModelConnectionLibraryView> {
    return this.#mutate(async () => {
      const document = await this.#readDocument();
      const index = document.connections.findIndex(
        ({ id }) => id === connectionId,
      );
      if (index < 0) throw new Error("没有找到要删除的模型配置");
      if (
        document.activeConnectionId === connectionId &&
        document.connections.length > 1
      )
        throw new Error("请先切换到另一份模型配置，再删除当前配置");
      document.connections.splice(index, 1);
      if (document.activeConnectionId === connectionId)
        document.activeConnectionId = null;
      await this.#writeDocument(document);
      return this.#viewDocument(document);
    });
  }

  async bind(): Promise<FileNativeModelConnection> {
    await this.#mutationTail;
    const document = await this.#readDocument();
    const connection = document.connections.find(
      ({ id }) => id === document.activeConnectionId,
    );
    if (connection === undefined) throw new ModelConnectionUnavailableError();
    return toBinding(connection);
  }

  async listModels(
    input: ListProviderModelsInput,
  ): Promise<{ models: string[] }> {
    await this.#mutationTail;
    const provider = validateProvider(input.provider);
    const baseUrl = normalizeBaseUrl(
      requiredTrimmed(input.baseUrl, "Base URL", 4096),
    );
    let apiKey = normalizeOptionalApiKey(input.apiKey);
    if (apiKey === undefined && input.connectionId !== undefined) {
      const stored = (await this.#readDocument()).connections.find(
        ({ id }) => id === input.connectionId,
      );
      if (stored === undefined) throw new Error("没有找到模型配置");
      if (stored.provider !== provider || stored.baseUrl !== baseUrl)
        throw new Error("端点或协议已改变；请重新填写 API Key 后再拉取模型");
      apiKey = stored.apiKey;
    }
    if (apiKey === undefined) throw new Error("拉取模型列表需要 API Key");

    const url = providerUrl(baseUrl, "models");
    if (provider === "anthropic_messages")
      url.searchParams.set("limit", "1000");
    const response = await this.#fetch(url, {
      method: "GET",
      headers:
        provider === "anthropic_messages"
          ? {
              "anthropic-version": "2023-06-01",
              "x-api-key": apiKey,
            }
          : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await providerListError(response);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxModelListBytes)
      throw new Error("Provider 模型列表响应超过 1 MiB 上限");
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > maxModelListBytes)
      throw new Error("Provider 模型列表响应超过 1 MiB 上限");
    let payload: unknown;
    try {
      payload = JSON.parse(source) as unknown;
    } catch {
      throw new Error("Provider 模型列表不是合法 JSON");
    }
    if (!isRecord(payload) || !Array.isArray(payload.data))
      throw new Error("Provider 模型列表缺少 data 数组");
    const models = [
      ...new Set(
        payload.data.flatMap((item) => {
          if (!isRecord(item) || typeof item.id !== "string") return [];
          const id = item.id.trim();
          return id.length > 0 && id.length <= 512 ? [id] : [];
        }),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 2_000);
    if (models.length === 0)
      throw new Error("Provider 模型列表没有可用的模型 ID");
    return { models };
  }

  #viewDocument(document: ModelConnectionDocument): ModelConnectionLibraryView {
    return {
      configured: document.activeConnectionId !== null,
      activeConnectionId: document.activeConnectionId,
      connections: document.connections.map(toView),
      presets: structuredClone(modelProviderPresets),
    };
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #readDocument(): Promise<ModelConnectionDocument> {
    try {
      const info = await stat(this.#path);
      if (!info.isFile()) throw new Error("模型连接配置路径不是普通文件");
      verifyPrivateMode(info.mode);
      return validateDocument(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
    }
    return { schemaVersion: 1, activeConnectionId: null, connections: [] };
  }

  async #writeDocument(document: ModelConnectionDocument): Promise<void> {
    await mkdir(this.#configRoot, { recursive: true, mode: 0o700 });
    const temporary = join(
      this.#configRoot,
      `.${libraryFileName}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
      verifyPrivateMode((await stat(this.#path)).mode);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function normalizeSaveInput(
  input: SaveModelConnectionInput,
  existing: StoredModelConnection | undefined,
): Omit<StoredModelConnection, "id"> {
  const name = requiredTrimmed(input.name, "配置名称", 160);
  const presetId = validatePresetId(input.presetId);
  const provider = validateProvider(input.provider);
  const baseUrl = normalizeBaseUrl(
    requiredTrimmed(input.baseUrl, "Base URL", 4096),
  );
  const modelId = requiredTrimmed(input.modelId, "模型 ID", 512);
  const explicitApiKey = normalizeOptionalApiKey(input.apiKey);
  const apiKey =
    explicitApiKey ??
    (existing?.provider === provider && existing.baseUrl === baseUrl
      ? existing.apiKey
      : undefined);
  if (apiKey === undefined)
    throw new Error(
      existing === undefined
        ? "新模型配置必须填写 API Key"
        : "端点或协议已改变；必须重新填写 API Key，旧凭据不会转发到新端点",
    );
  validateTokenLimits(input.contextWindowTokens, input.maxOutputTokens);
  validatePresetBinding(presetId, provider, baseUrl);
  return {
    name,
    presetId,
    provider,
    baseUrl,
    apiKey,
    modelId,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
  };
}

function validateDocument(value: unknown): ModelConnectionDocument {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.activeConnectionId !== null &&
      typeof value.activeConnectionId !== "string") ||
    !Array.isArray(value.connections) ||
    value.connections.length > 64
  )
    throw new Error("模型连接配置文件不符合固定数据格式");
  const connections = value.connections.map(validateStoredConnection);
  if (new Set(connections.map(({ id }) => id)).size !== connections.length)
    throw new Error("模型连接配置含有重复 ID");
  if (
    value.activeConnectionId !== null &&
    !connections.some(({ id }) => id === value.activeConnectionId)
  )
    throw new Error("启用的模型连接不存在");
  return {
    schemaVersion: 1,
    activeConnectionId: value.activeConnectionId,
    connections,
  };
}

function validateStoredConnection(value: unknown): StoredModelConnection {
  if (!isRecord(value)) throw new Error("模型连接必须是对象");
  const id = requiredTrimmed(value.id, "模型连接 ID", 160);
  const name = requiredTrimmed(value.name, "配置名称", 160);
  const presetId = validatePresetId(value.presetId);
  const provider = validateProvider(value.provider);
  const baseUrl = normalizeBaseUrl(requiredTrimmed(value.baseUrl, "Base URL"));
  const apiKey = requiredTrimmed(value.apiKey, "API Key", 16_384);
  const modelId = requiredTrimmed(value.modelId, "模型 ID", 512);
  validateTokenLimits(value.contextWindowTokens, value.maxOutputTokens);
  validatePresetBinding(presetId, provider, baseUrl);
  return {
    id,
    name,
    presetId,
    provider,
    baseUrl,
    apiKey,
    modelId,
    contextWindowTokens: value.contextWindowTokens as number,
    maxOutputTokens: value.maxOutputTokens as number,
  };
}

function toView(connection: StoredModelConnection): ModelConnectionView {
  return structuredClone({
    id: connection.id,
    name: connection.name,
    presetId: connection.presetId,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    modelId: connection.modelId,
    contextWindowTokens: connection.contextWindowTokens,
    maxOutputTokens: connection.maxOutputTokens,
    hasApiKey: true,
  });
}

function toBinding(
  connection: StoredModelConnection,
): FileNativeModelConnection {
  return structuredClone({
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    modelId: connection.modelId,
    contextWindowTokens: connection.contextWindowTokens,
    maxOutputTokens: connection.maxOutputTokens,
  });
}

function validateProvider(value: unknown): ModelProviderKind {
  if (
    value !== "chat_completions" &&
    value !== "openai_responses" &&
    value !== "anthropic_messages"
  )
    throw new Error("模型连接协议无效");
  return value;
}

function validatePresetId(value: unknown): ModelProviderPresetId {
  if (
    typeof value !== "string" ||
    !modelProviderPresets.some(({ id }) => id === value)
  )
    throw new Error("模型提供商预设无效");
  return value as ModelProviderPresetId;
}

function validatePresetBinding(
  presetId: ModelProviderPresetId,
  provider: ModelProviderKind,
  baseUrl: string,
): void {
  const preset = modelProviderPresets.find(({ id }) => id === presetId)!;
  if (
    preset.id !== "custom" &&
    (preset.provider !== provider ||
      normalizeBaseUrl(preset.baseUrl) !== baseUrl)
  )
    throw new Error("内置提供商的端点或协议不匹配；自定义时请选择“自定义端点”");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL 必须是绝对 URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  )
    throw new Error("Base URL 只允许无凭据、query 和 fragment 的 HTTP(S) 地址");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function normalizeOptionalApiKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredTrimmed(value, "API Key", 16_384);
}

function requiredTrimmed(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  )
    throw new Error(`${label} 无效`);
  return normalized;
}

function validateTokenLimits(context: unknown, output: unknown): void {
  if (
    !Number.isSafeInteger(context) ||
    (context as number) < 4_096 ||
    (context as number) > 16_777_216 ||
    !Number.isSafeInteger(output) ||
    (output as number) < 256 ||
    (output as number) >= (context as number)
  )
    throw new Error("模型真实 context window 或最大输出无效");
}

function providerUrl(baseUrl: string, resource: "models"): URL {
  const url = new URL(baseUrl);
  const suffix = `/${resource}`;
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

async function providerListError(response: Response): Promise<Error> {
  const text = (await response.text()).slice(0, 4096);
  return new Error(`拉取模型列表失败：${response.status} ${text}`);
}

function verifyPrivateMode(mode: number): void {
  if ((mode & 0o077) !== 0)
    throw new Error("模型连接配置文件权限过宽，必须只允许当前用户读取");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
