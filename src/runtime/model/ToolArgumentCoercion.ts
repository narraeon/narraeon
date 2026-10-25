import type { AppLocale } from "../../protocol/appPreferences.ts";

/**
 * Repairs a model that sends an array or object argument as a JSON string.
 *
 * Only a position whose schema names exactly one type, `array` or `object`,
 * is parsed. Anything looser (`{}`, `["string", "null"]`, a oneOf whose
 * branches disagree) is left as the model sent it, because a string may be a
 * legitimate value there.
 */
export interface CoercedToolArguments {
  arguments: unknown;
  /** Paths of parsed positions, such as `edits` or `edits[0]`. */
  coerced: string[];
}

/** Root arguments are depth 0; parsing and descent stop after two levels. */
const maxCoercionDepth = 2;

type JsonSchema = Record<string, unknown>;

export function coerceToolArguments(
  schema: object,
  args: unknown,
): CoercedToolArguments {
  const coerced: string[] = [];
  const value = coerceValue(schema as JsonSchema, args, "", 0, coerced);
  return { arguments: value, coerced };
}

/**
 * Renders the Runtime note appended to a tool result whose arguments were
 * parsed. It tells the model its arguments were repaired, so the next call
 * can send native JSON values.
 */
export function renderCoercionNote(
  paths: readonly string[],
  locale: AppLocale,
) {
  const names = paths.map((path) => `"${path}"`).join(", ");
  return locale === "zh-CN"
    ? `Runtime 说明：以下参数以 JSON 字符串到达，本次已解析后执行：${names}。请以 JSON 数组或对象的原生值发送，不要用字符串。`
    : `Runtime note: these arguments arrived as JSON strings and were parsed for this call: ${names}. Send array and object arguments as native JSON values, not strings.`;
}

function coerceValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  depth: number,
  coerced: string[],
): unknown {
  const type = definiteType(schema);
  let current = value;
  if (
    (type === "array" || type === "object") &&
    typeof current === "string" &&
    depth > 0 &&
    depth <= maxCoercionDepth
  ) {
    const parsed = parseJson(current);
    if (matchesType(type, parsed)) {
      current = parsed;
      coerced.push(path);
    }
  }
  if (depth >= maxCoercionDepth) return current;
  if (type === "array" && isArray(current)) {
    const items = itemsSchema(schema);
    if (items === undefined) return current;
    let next: unknown[] = current;
    current.forEach((element, index) => {
      const repaired = coerceValue(
        items,
        element,
        `${path}[${index}]`,
        depth + 1,
        coerced,
      );
      if (repaired !== element) {
        if (next === current) next = [...current];
        next[index] = repaired;
      }
    });
    return next;
  }
  if (type === "object" && isRecord(current)) {
    let next: Record<string, unknown> = current;
    for (const key of Object.keys(current)) {
      const property = propertySchema(schema, key);
      if (property === undefined) continue;
      const repaired = coerceValue(
        property,
        current[key],
        path === "" ? key : `${path}.${key}`,
        depth + 1,
        coerced,
      );
      if (repaired !== current[key]) {
        if (next === current) next = { ...current };
        next[key] = repaired;
      }
    }
    return next;
  }
  return current;
}

/** The single type a schema position admits, or undefined when it is not definite. */
function definiteType(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (schema.type !== undefined) {
    if (typeof schema.type === "string") return schema.type;
    if (
      Array.isArray(schema.type) &&
      schema.type.length === 1 &&
      typeof schema.type[0] === "string"
    )
      return schema.type[0];
    return undefined;
  }
  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (branches === undefined || branches.length === 0) return undefined;
  const types = branches.map(definiteType);
  const first = types[0];
  return first !== undefined && types.every((type) => type === first)
    ? first
    : undefined;
}

function itemsSchema(schema: JsonSchema): JsonSchema | undefined {
  return isRecord(schema.items) && !Array.isArray(schema.items)
    ? schema.items
    : undefined;
}

/**
 * A property schema is taken directly from `properties`, or from oneOf/anyOf
 * branches only when every branch that declares the key declares it the same.
 */
function propertySchema(schema: JsonSchema, key: string) {
  if (isRecord(schema.properties) && isRecord(schema.properties[key]))
    return schema.properties[key] as JsonSchema;
  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [];
  const declared = branches
    .map((branch) =>
      isRecord(branch) && isRecord(branch.properties)
        ? branch.properties[key]
        : undefined,
    )
    .filter((property) => property !== undefined);
  if (declared.length === 0) return undefined;
  const serialized = declared.map((property) => JSON.stringify(property));
  return serialized.every((text) => text === serialized[0]) &&
    isRecord(declared[0])
    ? (declared[0] as JsonSchema)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function matchesType(type: string, value: unknown): boolean {
  return type === "array" ? Array.isArray(value) : isRecord(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
