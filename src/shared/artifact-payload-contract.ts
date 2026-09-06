export interface PlayPresetArtifactPayloadContract {
  type:
    "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, PlayPresetArtifactPayloadContract>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PlayPresetArtifactPayloadContract;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  uniqueBy?: string;
  maxBytes?: number;
}

export function validatePlayPresetArtifactPayload(
  contract: PlayPresetArtifactPayloadContract | undefined,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  if (contract === undefined) return { ok: true };
  if (!isJsonValueValue(value))
    return {
      ok: false,
      message: "JSON artifact payload must be a valid JSON value",
    };
  return validatePayloadNode(contract, value, "$", 0);
}

function validatePayloadNode(
  contract: PlayPresetArtifactPayloadContract,
  value: unknown,
  path: string,
  depth: number,
): { ok: true } | { ok: false; message: string } {
  if (depth > 32)
    return { ok: false, message: `${path} payload nesting exceeds 32 levels` };
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeMatches =
    contract.type === actual ||
    (contract.type === "number" && actual === "number") ||
    (contract.type === "integer" &&
      actual === "number" &&
      Number.isInteger(value));
  if (!typeMatches)
    return {
      ok: false,
      message: `${path} payload type must be ${contract.type}; received ${actual}`,
    };
  if (contract.maxBytes !== undefined) {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).byteLength > contract.maxBytes
    )
      return {
        ok: false,
        message: `${path} payload exceeds its declared ${contract.maxBytes}-byte limit`,
      };
  }
  if (contract.type === "string") {
    const text = value as string;
    if (
      contract.minLength !== undefined &&
      [...text].length < contract.minLength
    )
      return {
        ok: false,
        message: `${path} text length is less than ${contract.minLength}`,
      };
    if (
      contract.maxLength !== undefined &&
      [...text].length > contract.maxLength
    )
      return {
        ok: false,
        message: `${path} text length exceeds ${contract.maxLength}`,
      };
  }
  if (contract.type === "array") {
    const entries = value as unknown[];
    if (contract.minItems !== undefined && entries.length < contract.minItems)
      return {
        ok: false,
        message: `${path} has fewer than ${contract.minItems} items`,
      };
    if (contract.maxItems !== undefined && entries.length > contract.maxItems)
      return {
        ok: false,
        message: `${path} has more than ${contract.maxItems} items`,
      };
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (contract.items !== undefined) {
        const result = validatePayloadNode(
          contract.items,
          entry,
          `${path}[${index}]`,
          depth + 1,
        );
        if (!result.ok) return result;
      }
      if (contract.uniqueBy !== undefined && isRecordValue(entry)) {
        const unique = entry[contract.uniqueBy];
        if (
          typeof unique !== "string" &&
          typeof unique !== "number" &&
          typeof unique !== "boolean"
        )
          return {
            ok: false,
            message: `${path}[${index}].${contract.uniqueBy} must be a uniquely comparable scalar`,
          };
        const key = JSON.stringify(unique);
        if (seen.has(key))
          return {
            ok: false,
            message: `${path} ${contract.uniqueBy} values cannot be duplicated`,
          };
        seen.add(key);
      }
    }
  }
  if (contract.type === "object") {
    const object = value as Record<string, unknown>;
    const properties = contract.properties ?? {};
    for (const required of contract.required ?? [])
      if (!(required in object))
        return { ok: false, message: `${path}.${required} is required` };
    if (contract.additionalProperties === false)
      for (const key of Object.keys(object))
        if (!(key in properties))
          return {
            ok: false,
            message: `${path}.${key} is not a declared field`,
          };
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in object)) continue;
      const result = validatePayloadNode(
        child,
        object[key],
        `${path}.${key}`,
        depth + 1,
      );
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function isJsonValueValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValueValue);
  if (!isRecordValue(value)) return false;
  return Object.values(value).every(isJsonValueValue);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
