export type ModelProviderKind =
  "chat_completions" | "openai_responses" | "anthropic_messages";

/**
 * The wire dialect is explicit because an OpenAI-shaped proxy can expose
 * continuation and reasoning extensions that are not part of the OpenAI API.
 */
export type ModelProviderDialect = "standard" | "cliproxyapi";

export type ModelReasoningEffort =
  | "provider_default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelReasoningSummary =
  "provider_default" | "auto" | "concise" | "detailed" | "none";

export type ModelPromptCacheStrategy =
  | "explicit_anthropic_blocks"
  | "explicit_cliproxyapi_message"
  | "provider_managed";

/** CLIProxyAPI gives these model-name suffixes priority over body effort. */
export function hasCLIProxyThinkingSuffix(modelId: string): boolean {
  return /\((?:-1|none|auto|minimal|low|medium|high|xhigh|max|\d+)\)$/iu.test(
    modelId,
  );
}

/** One validation authority shared by storage and the wire adapter boundary. */
export function modelReasoningPolicyIssue(input: {
  provider: ModelProviderKind;
  dialect: ModelProviderDialect;
  modelId: string;
  effort: ModelReasoningEffort;
  summary: ModelReasoningSummary;
}): string | null {
  if (input.provider === "anthropic_messages" && input.effort === "minimal")
    return "Anthropic Messages does not define minimal effort; choose low or provider default";
  if (
    input.provider === "anthropic_messages" &&
    input.effort === "none" &&
    input.summary === "auto"
  )
    return "Anthropic Messages cannot return a reasoning summary while thinking is disabled";
  if (
    input.provider !== "openai_responses" &&
    (input.summary === "concise" || input.summary === "detailed")
  )
    return "Concise and detailed reasoning summaries are defined only by OpenAI Responses";
  if (
    input.provider === "chat_completions" &&
    input.dialect === "standard" &&
    input.summary !== "provider_default"
  )
    return "Standard Chat Completions has no reasoning-summary parameter; use provider default or select the CLIProxyAPI dialect";
  if (
    input.dialect === "cliproxyapi" &&
    input.effort !== "provider_default" &&
    hasCLIProxyThinkingSuffix(input.modelId)
  )
    return "CLIProxyAPI model thinking suffixes override request effort; use either the model suffix with provider default or the explicit reasoning-effort field, not both";
  return null;
}

export interface ModelProviderPreset {
  id: string;
  name: string;
  provider: ModelProviderKind;
  baseUrl: string;
}

export const modelProviderPresets = [
  {
    id: "custom",
    name: "Custom endpoint",
    provider: "chat_completions",
    baseUrl: "",
  },
  {
    id: "openai",
    name: "OpenAI · Responses API",
    provider: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "openai-chat",
    name: "OpenAI · Chat Completions",
    provider: "chat_completions",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    provider: "anthropic_messages",
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    provider: "chat_completions",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    provider: "chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "kimi-code",
    name: "Kimi Coding",
    provider: "chat_completions",
    baseUrl: "https://api.kimi.com/coding/v1",
  },
  {
    id: "glm",
    name: "Zhipu GLM",
    provider: "chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "glm-code",
    name: "Zhipu GLM Coding",
    provider: "chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    provider: "chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "qwen-plan",
    name: "Alibaba Qwen Token Plan",
    provider: "chat_completions",
    baseUrl:
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "xai",
    name: "xAI",
    provider: "chat_completions",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    id: "mistral",
    name: "Mistral",
    provider: "chat_completions",
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    id: "volcengine",
    name: "Volcano Engine Ark",
    provider: "chat_completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    provider: "chat_completions",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    provider: "chat_completions",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    provider: "chat_completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "groq",
    name: "Groq",
    provider: "chat_completions",
    baseUrl: "https://api.groq.com/openai/v1",
  },
] as const satisfies readonly ModelProviderPreset[];

export type ModelProviderPresetId = (typeof modelProviderPresets)[number]["id"];

export interface ModelConnectionView {
  id: string;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  dialect: ModelProviderDialect;
  baseUrl: string;
  modelId: string;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  contextWindowTokens: number;
  maxOutputTokens: number;
  hasApiKey: true;
}

export interface ModelConnectionLibraryView {
  configured: boolean;
  activeConnectionId: string | null;
  connections: ModelConnectionView[];
  presets: readonly ModelProviderPreset[];
}

export interface SaveModelConnectionInput {
  connectionId?: string;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  dialect?: ModelProviderDialect;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: ModelReasoningEffort;
  reasoningSummary?: ModelReasoningSummary;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ListProviderModelsInput {
  connectionId?: string;
  provider: ModelProviderKind;
  baseUrl: string;
  apiKey?: string;
}
