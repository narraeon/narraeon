export type ModelProviderKind =
  "chat_completions" | "openai_responses" | "anthropic_messages";

export interface ModelProviderPreset {
  id: string;
  name: string;
  provider: ModelProviderKind;
  baseUrl: string;
}

export const modelProviderPresets = [
  {
    id: "custom",
    name: "自定义端点",
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
    name: "智谱 GLM",
    provider: "chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "glm-code",
    name: "智谱 GLM Coding",
    provider: "chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  },
  {
    id: "qwen",
    name: "通义千问",
    provider: "chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "qwen-plan",
    name: "通义千问 Token Plan",
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
    name: "火山方舟",
    provider: "chat_completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    provider: "chat_completions",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
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
  baseUrl: string;
  modelId: string;
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
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ListProviderModelsInput {
  connectionId?: string;
  provider: ModelProviderKind;
  baseUrl: string;
  apiKey?: string;
}
