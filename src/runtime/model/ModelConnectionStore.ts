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
  modelReasoningPolicyIssue,
  modelProviderPresets,
  type ListProviderModelsInput,
  type ModelConnectionLibraryView,
  type ModelConnectionView,
  type ModelProviderDialect,
  type ModelProviderKind,
  type ModelProviderPresetId,
  type ModelReasoningEffort,
  type ModelReasoningSummary,
  type SaveModelConnectionInput,
} from "../../protocol/modelConnections.ts";
import type { FileNativeModelConnection } from "./FileNativeModelAdapters.ts";

const libraryFileName = "model-connections-v1.json";
const maxModelListBytes = 1024 * 1024;

interface StoredModelConnection extends FileNativeModelConnection {
  id: string;
  name: string;
  presetId: ModelProviderPresetId;
  dialect: ModelProviderDialect;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
}

interface ModelConnectionDocument {
  schemaVersion: 1;
  activeConnectionId: string | null;
  connections: StoredModelConnection[];
}

export class ModelConnectionUnavailableError extends Error {
  constructor() {
    super("No V1 model connection is enabled");
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
        throw new Error("The model configuration to edit was not found");
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
        throw new Error("The model configuration to enable was not found");
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
      if (index < 0)
        throw new Error("The model configuration to delete was not found");
      if (
        document.activeConnectionId === connectionId &&
        document.connections.length > 1
      )
        throw new Error(
          "Switch to another model configuration before deleting the current one",
        );
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
      if (stored === undefined)
        throw new Error("Model configuration not found");
      if (stored.provider !== provider || stored.baseUrl !== baseUrl)
        throw new Error(
          "The endpoint or protocol changed; enter the API key again before fetching models",
        );
      apiKey = stored.apiKey;
    }
    if (apiKey === undefined)
      throw new Error("Fetching the model list requires an API key");

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
      throw new Error("Provider model-list response exceeds the 1 MiB limit");
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > maxModelListBytes)
      throw new Error("Provider model-list response exceeds the 1 MiB limit");
    let payload: unknown;
    try {
      payload = JSON.parse(source) as unknown;
    } catch {
      throw new Error("Provider model-list response is not valid JSON");
    }
    if (!isRecord(payload) || !Array.isArray(payload.data))
      throw new Error("Provider model-list response is missing the data array");
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
      throw new Error("Provider model list has no usable model IDs");
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
      if (!info.isFile())
        throw new Error(
          "Model-connection configuration path is not a regular file",
        );
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
  const name = requiredTrimmed(input.name, "Configuration name", 160);
  const presetId = validatePresetId(input.presetId);
  const provider = validateProvider(input.provider);
  const baseUrl = normalizeBaseUrl(
    requiredTrimmed(input.baseUrl, "Base URL", 4096),
  );
  const modelId = requiredTrimmed(input.modelId, "Model ID", 512);
  const dialect = validateDialect(input.dialect ?? existing?.dialect);
  const reasoningEffort = validateReasoningEffort(
    input.reasoningEffort ?? existing?.reasoningEffort,
  );
  const reasoningSummary = validateReasoningSummary(
    input.reasoningSummary ?? existing?.reasoningSummary,
  );
  validateReasoningPolicy({
    provider,
    dialect,
    modelId,
    effort: reasoningEffort,
    summary: reasoningSummary,
  });
  const explicitApiKey = normalizeOptionalApiKey(input.apiKey);
  const apiKey =
    explicitApiKey ??
    (existing?.provider === provider && existing.baseUrl === baseUrl
      ? existing.apiKey
      : undefined);
  if (apiKey === undefined)
    throw new Error(
      existing === undefined
        ? "A new model configuration requires an API key"
        : "The endpoint or protocol changed; enter the API key again because old credentials are never forwarded to a new endpoint",
    );
  validateTokenLimits(input.contextWindowTokens, input.maxOutputTokens);
  validatePresetBinding(presetId, provider, baseUrl);
  return {
    name,
    presetId,
    provider,
    dialect,
    baseUrl,
    apiKey,
    modelId,
    reasoningEffort,
    reasoningSummary,
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
    throw new Error(
      "Model-connection configuration file does not match its fixed schema",
    );
  const connections = value.connections.map(validateStoredConnection);
  if (new Set(connections.map(({ id }) => id)).size !== connections.length)
    throw new Error("Model-connection configuration contains duplicate IDs");
  if (
    value.activeConnectionId !== null &&
    !connections.some(({ id }) => id === value.activeConnectionId)
  )
    throw new Error("The enabled model connection does not exist");
  return {
    schemaVersion: 1,
    activeConnectionId: value.activeConnectionId,
    connections,
  };
}

function validateStoredConnection(value: unknown): StoredModelConnection {
  if (!isRecord(value)) throw new Error("Model connection must be an object");
  const id = requiredTrimmed(value.id, "Model connection ID", 160);
  const name = requiredTrimmed(value.name, "Configuration name", 160);
  const presetId = validatePresetId(value.presetId);
  const provider = validateProvider(value.provider);
  const dialect = validateDialect(value.dialect);
  const baseUrl = normalizeBaseUrl(requiredTrimmed(value.baseUrl, "Base URL"));
  const apiKey = requiredTrimmed(value.apiKey, "API Key", 16_384);
  const modelId = requiredTrimmed(value.modelId, "Model ID", 512);
  const reasoningEffort = validateReasoningEffort(value.reasoningEffort);
  const reasoningSummary = validateReasoningSummary(value.reasoningSummary);
  validateReasoningPolicy({
    provider,
    dialect,
    modelId,
    effort: reasoningEffort,
    summary: reasoningSummary,
  });
  validateTokenLimits(value.contextWindowTokens, value.maxOutputTokens);
  validatePresetBinding(presetId, provider, baseUrl);
  return {
    id,
    name,
    presetId,
    provider,
    dialect,
    baseUrl,
    apiKey,
    modelId,
    reasoningEffort,
    reasoningSummary,
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
    dialect: connection.dialect,
    baseUrl: connection.baseUrl,
    modelId: connection.modelId,
    reasoningEffort: connection.reasoningEffort,
    reasoningSummary: connection.reasoningSummary,
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
    dialect: connection.dialect,
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    modelId: connection.modelId,
    reasoningEffort: connection.reasoningEffort,
    reasoningSummary: connection.reasoningSummary,
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
    throw new Error("Model-connection protocol is invalid");
  return value;
}

function validateDialect(value: unknown): ModelProviderDialect {
  if (value === undefined) return "standard";
  if (value !== "standard" && value !== "cliproxyapi")
    throw new Error("Model-provider dialect is invalid");
  return value;
}

function validateReasoningEffort(value: unknown): ModelReasoningEffort {
  if (value === undefined) return "provider_default";
  if (
    value !== "provider_default" &&
    value !== "none" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  )
    throw new Error("Model reasoning effort is invalid");
  return value;
}

function validateReasoningSummary(value: unknown): ModelReasoningSummary {
  if (value === undefined) return "provider_default";
  if (
    value !== "provider_default" &&
    value !== "auto" &&
    value !== "concise" &&
    value !== "detailed" &&
    value !== "none"
  )
    throw new Error("Model reasoning-summary policy is invalid");
  return value;
}

function validateReasoningPolicy(
  input: Parameters<typeof modelReasoningPolicyIssue>[0],
): void {
  const issue = modelReasoningPolicyIssue(input);
  if (issue !== null) throw new Error(issue);
}

function validatePresetId(value: unknown): ModelProviderPresetId {
  if (
    typeof value !== "string" ||
    !modelProviderPresets.some(({ id }) => id === value)
  )
    throw new Error("Model-provider preset is invalid");
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
    throw new Error(
      "The endpoint or protocol does not match the built-in provider; select Custom endpoint for a custom configuration",
    );
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL must be absolute");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  )
    throw new Error(
      "Base URL must be an HTTP(S) address without credentials, query, or fragment",
    );
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function normalizeOptionalApiKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredTrimmed(value, "API Key", 16_384);
}

function requiredTrimmed(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  )
    throw new Error(`${label} is invalid`);
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
    throw new Error("Actual model context window or maximum output is invalid");
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
  return new Error(`Failed to fetch model list: ${response.status} ${text}`);
}

function verifyPrivateMode(mode: number): void {
  if ((mode & 0o077) !== 0)
    throw new Error(
      "Model-connection configuration permissions are too broad; only the current user may read it",
    );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
