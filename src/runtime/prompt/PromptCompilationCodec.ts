import type { PromptCompilation } from "./FileNativePromptCompiler.ts";
import { isWorldPromptMaintenance } from "../../protocol/worldMaintenance.ts";

/** Canonical validators for saved compiler output. Validate without projecting or rebuilding it. */
export function validPlayFollowup(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "displayName",
        "logicalMessages",
        "tools",
        "allowedTools",
        "artifacts",
        "maxArtifactBytes",
      ],
      ["frozenResources"],
    ) &&
    (value.frozenResources === undefined ||
      (isRecord(value.frozenResources) &&
        hasExactKeys(value.frozenResources, ["files", "mount"]) &&
        isRecord(value.frozenResources.files) &&
        Object.values(value.frozenResources.files).every(
          (body) => typeof body === "string",
        ) &&
        typeof value.frozenResources.mount === "string" &&
        [
          "story",
          "sidebar",
          "composer_above",
          "composer_below",
          "overlay",
          "debug",
        ].includes(String(value.frozenResources.mount)))) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    validLogicalMessages(value.logicalMessages) &&
    validPromptTools(value.tools) &&
    validStringArray(value.allowedTools) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(validPlayArtifact) &&
    validCount(value.maxArtifactBytes)
  );
}

function validPlayArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "name",
        "channel",
        "strategy",
        "contentType",
        "save",
        "invalidation",
        "required",
        "maxEmits",
      ],
      [
        "key",
        "renderer",
        "rendererRevision",
        "rendererMode",
        "regex",
        "scripts",
        "assets",
        "payloadContract",
      ],
    ) &&
    typeof value.name === "string" &&
    typeof value.channel === "string" &&
    ["append", "replace", "upsert", "transient", "hidden"].includes(
      String(value.strategy),
    ) &&
    ["text/plain", "text/markdown", "application/json", "text/html"].includes(
      String(value.contentType),
    ) &&
    (value.key === undefined || typeof value.key === "string") &&
    (value.renderer === undefined || typeof value.renderer === "string") &&
    (value.rendererRevision === undefined ||
      typeof value.rendererRevision === "string") &&
    (value.rendererMode === undefined ||
      value.rendererMode === "document" ||
      value.rendererMode === "app") &&
    (value.regex === undefined || typeof value.regex === "string") &&
    (value.scripts === undefined || validStringArray(value.scripts)) &&
    (value.assets === undefined || validStringArray(value.assets)) &&
    ["none", "operation", "commit"].includes(String(value.save)) &&
    [
      "new_operation",
      "head_change",
      "operation_end",
      "explicit_clear",
      "never",
    ].includes(String(value.invalidation)) &&
    typeof value.required === "boolean" &&
    validCount(value.maxEmits) &&
    (value.payloadContract === undefined ||
      validArtifactPayloadContract(value.payloadContract))
  );
}

function validArtifactPayloadContract(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["type"],
      [
        "properties",
        "required",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "uniqueBy",
        "maxBytes",
      ],
    ) ||
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(String(value.type)) ||
    (value.required !== undefined && !validStringArray(value.required)) ||
    (value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== "boolean") ||
    (value.items !== undefined && !validArtifactPayloadContract(value.items)) ||
    (value.uniqueBy !== undefined && typeof value.uniqueBy !== "string")
  )
    return false;
  for (const key of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "maxBytes",
  ])
    if (value[key] !== undefined && !validCount(value[key])) return false;
  if (value.properties === undefined) return true;
  return (
    isRecord(value.properties) &&
    Object.values(value.properties).every(validArtifactPayloadContract)
  );
}

export function validPromptCompilation(
  value: unknown,
): value is PromptCompilation {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "logicalMessages",
        "provider",
        "tools",
        "toolUniverse",
        "toolStrategy",
        "coverage",
        "budget",
        "cache",
      ],
      ["maintenance"],
    ) &&
    (value.maintenance === undefined ||
      isWorldPromptMaintenance(value.maintenance)) &&
    validLogicalMessages(value.logicalMessages) &&
    validPromptProvider(value.provider) &&
    validPromptTools(value.tools) &&
    validPromptTools(value.toolUniverse) &&
    validToolStrategy(value.toolStrategy) &&
    Array.isArray(value.coverage) &&
    value.coverage.every(validPromptCoverage) &&
    validPromptBudget(value.budget) &&
    validPromptCache(value.cache)
  );
}

export function validLogicalMessages(value: unknown): boolean {
  return Array.isArray(value) && value.every(validLogicalMessage);
}

function validLogicalMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "markdown", "blocks"]) &&
    [
      "runtime_system",
      "author_instruction",
      "world_context",
      "player_input",
      "assistant",
      "tool",
    ].includes(String(value.role)) &&
    typeof value.markdown === "string" &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) =>
        isRecord(block) &&
        hasExactKeys(block, ["source", "markdown"]) &&
        typeof block.source === "string" &&
        typeof block.markdown === "string",
    )
  );
}

function validPromptProvider(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["protocol", "messages"], ["system"]) &&
    validProviderKind(value.protocol) &&
    (value.system === undefined ||
      (Array.isArray(value.system) && value.system.every(validSystemBlock))) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        hasExactKeys(message, ["role", "content"]) &&
        (message.role === "system" || message.role === "user") &&
        Object.hasOwn(message, "content"),
    )
  );
}

function validSystemBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "text"], ["cache_control"]) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    (value.cache_control === undefined ||
      (isRecord(value.cache_control) &&
        hasExactKeys(value.cache_control, ["type"]) &&
        value.cache_control.type === "ephemeral"))
  );
}

export function validPromptTools(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        hasExactKeys(tool, ["name", "description", "inputSchema"]) &&
        typeof tool.name === "string" &&
        typeof tool.description === "string" &&
        isRecord(tool.inputSchema),
    )
  );
}

function validPromptCoverage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["slot", "source", "status", "complete", "continuation"],
      ["readAuthorization", "catalogEntries"],
    ) &&
    typeof value.slot === "string" &&
    typeof value.source === "string" &&
    ["resolved", "optional_missing", "paged_catalog"].includes(
      String(value.status),
    ) &&
    typeof value.complete === "boolean" &&
    (value.continuation === null || typeof value.continuation === "string") &&
    (value.readAuthorization === undefined ||
      validPromptReadAuthorization(value.readAuthorization)) &&
    (value.catalogEntries === undefined ||
      validStringArray(value.catalogEntries))
  );
}

function validPromptReadAuthorization(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["shortRef", "locator"]) ||
    typeof value.shortRef !== "string"
  )
    return false;
  if (value.locator === null) return true;
  if (!isRecord(value.locator)) return false;
  if (hasExactKeys(value.locator, ["yaml"]))
    return (
      Array.isArray(value.locator.yaml) &&
      value.locator.yaml.every(
        (part) => typeof part === "string" || validFiniteNumber(part),
      )
    );
  return (
    hasExactKeys(value.locator, ["markdown"]) &&
    validStringArray(value.locator.markdown)
  );
}

function validPromptBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "estimator",
      "messageTokens",
      "toolTokens",
      "outputReserveTokens",
      "forcedTailReserveTokens",
      "safetyMarginTokens",
      "requiredTokens",
      "contextWindowTokens",
      "status",
    ]) &&
    (value.estimator === "conservative_utf8_bytes" ||
      value.estimator === "disabled") &&
    [
      value.messageTokens,
      value.toolTokens,
      value.outputReserveTokens,
      value.forcedTailReserveTokens,
      value.safetyMarginTokens,
      value.requiredTokens,
      value.contextWindowTokens,
    ].every(validCount) &&
    ["fits", "over_budget", "not_checked"].includes(String(value.status))
  );
}

function validPromptCache(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "strategy",
      "stablePrefixFingerprint",
      "breakpoints",
      "estimatedCacheableBytes",
      "firstDynamicByte",
    ]) &&
    validCacheStrategy(value.strategy) &&
    typeof value.stablePrefixFingerprint === "string" &&
    Array.isArray(value.breakpoints) &&
    value.breakpoints.every((role) =>
      [
        "runtime_system",
        "author_instruction",
        "world_context",
        "player_input",
        "assistant",
        "tool",
      ].includes(String(role)),
    ) &&
    validCount(value.estimatedCacheableBytes) &&
    validCount(value.firstDynamicByte)
  );
}

export function validProviderKind(value: unknown): boolean {
  return (
    value === "chat_completions" ||
    value === "openai_responses" ||
    value === "anthropic_messages"
  );
}

export function validCacheStrategy(value: unknown): boolean {
  return (
    value === "explicit_anthropic_blocks" ||
    value === "explicit_cliproxyapi_message" ||
    value === "provider_managed"
  );
}

export function validToolStrategy(value: unknown): boolean {
  return value === "native_allowed_subset" || value === "runtime_gate";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
