export function isSameModelServiceOrigin(left: string, right: string): boolean {
  try {
    const source = new URL(left);
    const target = new URL(right);
    return (
      (source.protocol === "http:" || source.protocol === "https:") &&
      source.protocol === target.protocol &&
      source.origin === target.origin
    );
  } catch {
    return false;
  }
}

export type ModelProviderKind =
  | "chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "google_interactions";

export type ModelConnectionAuthMode = "api_key" | "none";

export function supportsUnauthenticatedModelConnection(
  provider: ModelProviderKind,
  baseUrl: string,
): boolean {
  if (provider !== "chat_completions") return false;
  try {
    const url = new URL(baseUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * The wire dialect is explicit because an OpenAI-shaped proxy can expose
 * continuation and reasoning extensions that are not part of the OpenAI API.
 */
export type ModelProviderDialect = "standard" | "cliproxyapi";

/** Explicit endpoint capability; OpenAI-compatible shape alone is insufficient. */
export type ModelAssistantPrefillMode =
  "disabled" | "assistant" | "prefix" | "mistral_prefix" | "partial";

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

/**
 * Anthropic exposes thinking as a control independent from output effort.
 * Google CLIProxyAPI budget modes select the alternative to a thinking level.
 * OpenAI-shaped protocols do not have an equivalent request field, so their
 * only valid value is provider_default.
 */
export type ModelThinkingMode =
  "provider_default" | "adaptive" | "enabled" | "disabled";

export type ModelPromptCacheStrategy =
  | "explicit_anthropic_blocks"
  | "explicit_cliproxyapi_message"
  | "provider_managed";

export type AnthropicPromptCacheTtl = "5m" | "1h";

export interface AnthropicConnectionCacheSettings {
  anthropicPromptCacheTtl?: AnthropicPromptCacheTtl;
}

export function isAnthropicPromptCacheTtl(
  value: unknown,
): value is AnthropicPromptCacheTtl {
  return value === "5m" || value === "1h";
}

export function anthropicConnectionCacheSettings(
  provider: ModelProviderKind,
  value: unknown,
): AnthropicConnectionCacheSettings {
  if (provider !== "anthropic_messages") {
    if (value !== undefined)
      throw new Error(
        "Prompt cache duration requires the Anthropic Messages protocol",
      );
    return {};
  }
  const ttl = value === undefined ? "5m" : value;
  if (!isAnthropicPromptCacheTtl(ttl))
    throw new Error("Anthropic prompt cache duration must be 5m or 1h");
  return { anthropicPromptCacheTtl: ttl };
}

/** CLIProxyAPI gives these model-name suffixes priority over body effort. */
export function hasCLIProxyThinkingSuffix(modelId: string): boolean {
  return /\((?:-1|none|auto|minimal|low|medium|high|xhigh|max|\d+)\)$/iu.test(
    modelId,
  );
}

const googleThinkingLevels = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export function isGoogleThinkingLevel(
  value: unknown,
): value is (typeof googleThinkingLevels)[number] {
  return googleThinkingLevels.some((level) => level === value);
}

export function googleThinkingLevelsFor(
  dialect: ModelProviderDialect,
  modelId: string,
) {
  // https://aistudio.google.com/docs/thinking#thinking-levels
  const supportsXHigh =
    dialect === "standard" &&
    /^(?:models\/)?gemini-4-(?:neon|hydrogen)$/u.test(modelId.trim());
  return googleThinkingLevels.filter(
    (level) => level !== (supportsXHigh ? "minimal" : "xhigh"),
  );
}

/** One validation authority shared by storage and the wire adapter boundary. */
export function modelReasoningPolicyIssue(
  input: {
    provider: ModelProviderKind;
    dialect: ModelProviderDialect;
    modelId: string;
    effort: ModelReasoningEffort;
    summary: ModelReasoningSummary;
    thinking?: ModelThinkingMode;
    thinkingBudgetTokens?: number | null;
    maxOutputTokens?: number;
  },
  { allowLegacyGoogleSettings = false } = {},
): string | null {
  const thinking = input.thinking ?? "provider_default";
  const thinkingBudgetTokens = input.thinkingBudgetTokens ?? null;
  if (
    input.dialect === "cliproxyapi" &&
    (input.effort !== "provider_default" || thinking !== "provider_default") &&
    hasCLIProxyThinkingSuffix(input.modelId)
  )
    return "CLIProxyAPI model thinking suffixes override request effort and thinking; use either the model suffix with provider defaults or explicit request fields, not both";
  if (input.provider === "google_interactions") {
    if (
      !allowLegacyGoogleSettings &&
      input.dialect === "standard" &&
      thinking !== "provider_default"
    )
      return "Standard Google Interactions does not support thinking budgets. In Model Connections, choose Provider default or a thinking level supported by the model. Use the CLIProxyAPI dialect only with a compatible proxy.";
    const { effort } = input;
    if (effort !== "provider_default") {
      if (!isGoogleThinkingLevel(effort))
        return "Google thinking level must be minimal, low, medium, high, or xhigh on supported models";
      if (
        !googleThinkingLevelsFor(input.dialect, input.modelId).includes(effort)
      ) {
        if (effort === "xhigh")
          return "Google Interactions xhigh is available for Gemini 4 Neon and Gemini 4 Hydrogen on the standard dialect. Choose Provider default or a thinking level supported by the model.";
        if (!allowLegacyGoogleSettings)
          return "Google Interactions minimal is unavailable for Gemini 4 Neon and Gemini 4 Hydrogen on the standard dialect. In Model Connections, choose Provider default, low, medium, high, or xhigh.";
      }
    }
    if (
      input.summary !== "provider_default" &&
      input.summary !== "auto" &&
      input.summary !== "none"
    )
      return "Google thinking summaries must be auto or none";
    if (input.effort !== "provider_default" && thinking !== "provider_default")
      return "Choose a Google thinking level or a thinking budget mode";
    if (thinking === "enabled") {
      if (
        thinkingBudgetTokens === null ||
        !Number.isSafeInteger(thinkingBudgetTokens) ||
        thinkingBudgetTokens < 0
      )
        return "Google manual thinking requires a non-negative integer budget";
    } else if (thinkingBudgetTokens !== null) {
      return "A Google thinking budget requires manual budget mode";
    }
    return null;
  }
  const thinkingControlledByCLIProxySuffix =
    input.provider === "anthropic_messages" &&
    input.dialect === "cliproxyapi" &&
    hasCLIProxyThinkingSuffix(input.modelId);
  if (
    input.provider === "anthropic_messages" &&
    (input.effort === "none" || input.effort === "minimal")
  )
    return "Anthropic Messages effort supports low, medium, high, xhigh, and max; use Thinking disabled instead of effort none";
  if (
    input.provider !== "anthropic_messages" &&
    thinking !== "provider_default"
  )
    return "OpenAI-shaped protocols control reasoning through effort";
  if (input.provider !== "anthropic_messages" && thinkingBudgetTokens !== null)
    return "OpenAI-shaped protocols do not accept a thinking token budget";
  if (thinking === "enabled") {
    if (
      thinkingBudgetTokens === null ||
      !Number.isSafeInteger(thinkingBudgetTokens) ||
      thinkingBudgetTokens < 1_024
    )
      return "Anthropic manual thinking requires an integer budget of at least 1024 tokens";
    if (
      input.maxOutputTokens !== undefined &&
      thinkingBudgetTokens >= input.maxOutputTokens
    )
      return "Anthropic thinking budget must be lower than maximum output tokens";
  } else if (thinkingBudgetTokens !== null) {
    return "A thinking token budget is valid only when Anthropic Thinking is set to manual enabled";
  }
  if (
    input.provider === "anthropic_messages" &&
    (thinking === "provider_default" || thinking === "disabled") &&
    input.summary !== "provider_default" &&
    !(thinking === "provider_default" && thinkingControlledByCLIProxySuffix)
  )
    return "Anthropic returned thinking can be configured only when Thinking is adaptive or manual enabled, or when a CLIProxyAPI model suffix controls Thinking";
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
    id: "google-interactions",
    name: "Google Gemini · Interactions",
    provider: "google_interactions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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

export interface ResponsesConnectionCapabilities {
  /** Route the player's turn-specific guidance through GPT-6.2 instructions. */
  responsesTurnInstructions?: boolean;
  /** Enable message-level cache_control for a CLIProxyAPI route to Claude. */
  responsesCacheControl?: boolean;
}

export function responsesConnectionCapabilities(
  provider: ModelProviderKind,
  dialect: ModelProviderDialect,
  input: {
    responsesTurnInstructions?: unknown;
    responsesCacheControl?: unknown;
  },
  previous?: ResponsesConnectionCapabilities,
): ResponsesConnectionCapabilities {
  const responses = provider === "openai_responses";
  const proxy = responses && dialect === "cliproxyapi";
  const {
    responsesTurnInstructions = responses &&
      previous?.responsesTurnInstructions === true,
    responsesCacheControl = proxy && previous?.responsesCacheControl === true,
  } = input;
  if (
    typeof responsesTurnInstructions !== "boolean" ||
    typeof responsesCacheControl !== "boolean"
  )
    throw new Error("Responses connection capabilities must be booleans");
  if (responsesTurnInstructions && !responses)
    throw new Error("Turn instructions require the Responses protocol");
  if (responsesCacheControl && !proxy)
    throw new Error(
      "Responses cache_control requires the CLIProxyAPI Responses dialect",
    );
  return {
    ...(responses ? { responsesTurnInstructions } : {}),
    ...(proxy ? { responsesCacheControl } : {}),
  };
}

export interface ModelConnectionView
  extends ResponsesConnectionCapabilities, AnthropicConnectionCacheSettings {
  id: string;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  dialect: ModelProviderDialect;
  baseUrl: string;
  modelId: string;
  modelPrompt?: string;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  thinkingMode: ModelThinkingMode;
  thinkingBudgetTokens: number | null;
  supportsAllowedTools: boolean;
  assistantPrefillMode: ModelAssistantPrefillMode;
  contextWindowTokens: number;
  maxOutputTokens: number;
  hasApiKey: boolean;
}

export interface ModelConnectionLibraryView {
  configured: boolean;
  activeConnectionId: string | null;
  connections: ModelConnectionView[];
  presets: readonly ModelProviderPreset[];
}

export interface CopyModelConnectionResult {
  library: ModelConnectionLibraryView;
  copiedConnectionId: string;
}

export interface SaveModelConnectionInput
  extends ResponsesConnectionCapabilities, AnthropicConnectionCacheSettings {
  connectionId?: string;
  name: string;
  presetId: ModelProviderPresetId;
  provider: ModelProviderKind;
  dialect?: ModelProviderDialect;
  baseUrl: string;
  authMode?: ModelConnectionAuthMode;
  apiKey?: string;
  modelId: string;
  modelPrompt?: string;
  reasoningEffort?: ModelReasoningEffort;
  reasoningSummary?: ModelReasoningSummary;
  thinkingMode?: ModelThinkingMode;
  thinkingBudgetTokens?: number | null;
  supportsAllowedTools?: boolean;
  assistantPrefillMode?: ModelAssistantPrefillMode;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ListProviderModelsInput {
  connectionId?: string;
  provider: ModelProviderKind;
  baseUrl: string;
  authMode?: ModelConnectionAuthMode;
  apiKey?: string;
}
