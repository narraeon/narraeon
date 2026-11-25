import {
  initialWorldPreloadNotice,
  renderPromptDeltaMessage,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  defaultRuntimeToolDefinitionStrategy,
  portableRuntimeToolInputSchema,
  type RuntimeToolDefinitionStrategy,
} from "../prompt/FileNativeToolRegistry.ts";
import { continuationPrompt } from "./AssistantPrefill.ts";
import type { FileNativeModelConnection } from "./FileNativeModelConnection.ts";
import {
  ModelHostContinuationError,
  type ModelHostAppendItem,
  type ModelHostExchange,
} from "./ModelHost.ts";

type FrozenModelHostExchange = ModelHostExchange & {
  toolUniverse: NonNullable<ModelHostExchange["toolUniverse"]>;
};

export function isProperToolSubset(
  allowedTools: readonly string[],
  tools: readonly { name: string }[],
): boolean {
  const allowedNames = new Set(allowedTools);
  const toolNames = new Set(tools.map((tool) => tool.name));
  return (
    allowedNames.size > 0 &&
    allowedNames.size < toolNames.size &&
    [...allowedNames].every((name) => toolNames.has(name))
  );
}

/**
 * A frozen policy is present when the caller supplies the logical operation's
 * complete tool universe. All play lifecycles share this one ModelHost seam.
 */
export function hasFrozenToolPolicy(request: ModelHostExchange): boolean {
  return frozenToolPolicy(request) !== null;
}

function frozenToolPolicy(
  request: ModelHostExchange,
): FrozenModelHostExchange | null {
  if (!("toolUniverse" in request && request.toolUniverse !== undefined))
    return null;
  return request as FrozenModelHostExchange;
}

export function providerToolDefinitions(
  request: ModelHostExchange,
): PromptCompilation["tools"] {
  const policy = frozenToolPolicy(request);
  return (policy?.toolUniverse ?? request.tools).map((tool) => {
    if (!hasUnsupportedProviderToolSchemaRoot(tool.inputSchema)) return tool;
    const portableInputSchema = portableRuntimeToolInputSchema(tool.name);
    if (portableInputSchema === null)
      throw new Error(
        `Provider tool ${tool.name} uses oneOf, allOf, or anyOf at the input schema root`,
      );
    if (hasUnsupportedProviderToolSchemaRoot(portableInputSchema))
      throw new Error(
        `Provider tool ${tool.name} has no portable root-object input schema`,
      );
    // Released play contexts freeze their logical tool universe. Migrate only
    // the Provider wire projection of the old root-union schema; Runtime keeps
    // validating the original source-specific contract and the persisted
    // transcript remains untouched.
    return {
      ...tool,
      inputSchema: portableInputSchema,
    };
  });
}

function hasUnsupportedProviderToolSchemaRoot(schema: object): boolean {
  return ["oneOf", "allOf", "anyOf"].some((keyword) =>
    Object.prototype.hasOwnProperty.call(schema, keyword),
  );
}

export function providerAllowedTools(request: ModelHostExchange): string[] {
  const policy = frozenToolPolicy(request);
  if (policy !== null) return [...(policy.allowedTools ?? [])];
  return request.tools.map((tool) => tool.name);
}

export function providerToolStrategy(
  request: ModelHostExchange,
  provider: FileNativeModelConnection["provider"],
): RuntimeToolDefinitionStrategy {
  const policy = frozenToolPolicy(request);
  if (policy?.toolStrategy !== undefined) return policy.toolStrategy;
  return defaultRuntimeToolDefinitionStrategy(provider);
}

/** Synthetic bootstrap only: never manufacture a provider continuation or a story event. */
export function initialWorldContext(request: ModelHostExchange) {
  const preload = request.bootstrap.provider.preload;
  if (preload === undefined) return undefined;
  return {
    ...preload,
    name: "runtime_load_context",
    notice: {
      role: "user",
      content:
        preload.notice ??
        initialWorldPreloadNotice("en", request.bootstrap.provider.protocol),
    },
  };
}

/** Replay the instruction that preceded the untouched native suffix. */
export function continuationInput(
  item: Extract<ModelHostAppendItem, { kind: "assistant" }>,
) {
  const length = item.providerState?.continuedPrefixLength;
  if (length === undefined) return [];
  if (!Number.isSafeInteger(length) || length <= 0 || length > item.text.length)
    throw continuationError("Invalid saved partial response");
  return [
    {
      role: "user",
      content: continuationPrompt(
        item.text.slice(0, length),
        item.providerState?.continuedPrefixInstruction,
      ),
    },
  ];
}

export function continuationError(
  protocol: string,
): ModelHostContinuationError {
  return new ModelHostContinuationError(
    `${protocol} continuation payload is missing or incompatible; start a fresh model context instead of rebuilding it from parsed text, reasoning, or tool calls`,
  );
}

export function promptDeltaProviderMessages(
  messages: PromptCompilation["logicalMessages"],
) {
  return messages.map((message) => ({
    role: "user" as const,
    content: renderPromptDeltaMessage(message.role, message.markdown),
  }));
}
