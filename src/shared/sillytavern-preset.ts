import { stringify } from "yaml";
import type { AppLocale } from "../protocol/appPreferences.ts";
import { applicationPresetFilesForLocale } from "./application-preset-files.ts";
import {
  builtinPlayPrompts,
  type OrderedPlayPrompt,
} from "./ordered-play-prompts.ts";
import { customizePromptArrangement } from "./prompt-arrangement.ts";

export type SillyTavernReason =
  | "missing_builtin"
  | "marker"
  | "unsupported_macro"
  | "depth_injection"
  | "trigger"
  | "overrides"
  | "unsupported_fields"
  | "unplaced";
export type SillyTavernDiagnosticCode =
  | SillyTavernReason
  | "ignored_setting"
  | "prompt_selection"
  | "unsupported_field";
export type SillyTavernDiagnosticResult =
  "ignored" | "enabled" | "disabled" | "not_selected" | "not_imported";
export type SillyTavernSettingCategory =
  "connection" | "sampling" | "model" | "extension" | "generation";
export interface SillyTavernPrompt {
  id: string;
  path: string;
  name: string;
  role?: string | undefined;
  content?: string | undefined;
  enabled?: boolean | undefined;
  ordered: boolean;
  marker: boolean;
  missing: boolean;
  injectionPosition?: number | undefined;
  injectionDepth?: number | undefined;
  injectionOrder?: number | undefined;
  triggers?: string[] | undefined;
  macros: string[];
  forbidOverrides?: boolean | undefined;
  reasons: SillyTavernReason[];
  unsupportedPaths: string[];
  systemPrompt?: boolean | undefined;
  extension?: boolean | undefined;
  position?: string | number | undefined;
}
export interface SillyTavernInspection {
  groups: { id: string; label: string }[];
  selectedGroupId?: string | undefined;
  prompts: SillyTavernPrompt[];
  settings: {
    path: string;
    category: SillyTavernSettingCategory;
    value?: number;
  }[];
}
export interface SillyTavernDiagnostic {
  code: SillyTavernDiagnosticCode;
  path: string;
  name?: string;
  result: SillyTavernDiagnosticResult;
}
export interface SillyTavernConversion {
  files: Record<string, string>;
  report: SillyTavernDiagnostic[];
  target: { name: string; kind: OrderedPlayPrompt["kind"]; enabled: boolean }[];
}
type ObjectValue = Record<string, unknown>;
const builtins = new Set([
  "main",
  "nsfw",
  "jailbreak",
  "dialogueExamples",
  "chatHistory",
  "worldInfoAfter",
  "worldInfoBefore",
  "enhanceDefinitions",
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription",
]);
const fields = new Set([
  "identifier",
  "name",
  "role",
  "content",
  "system_prompt",
  "marker",
  "injection_position",
  "injection_depth",
  "injection_order",
  "injection_trigger",
  "forbid_overrides",
  "extension",
  "position",
  "enabled",
]);
const structuralErrorCodes = {
  "expected object": "st_expected_object",
  "expected array": "st_expected_array",
  "expected string": "st_expected_string",
  "expected boolean": "st_expected_boolean",
  "expected number": "st_expected_number",
  "invalid JSON": "st_invalid_json",
  "legacy prompt format is unsupported":
    "st_legacy_prompt_format_is_unsupported",
  "unsupported preset format": "st_unsupported_preset_format",
  "expected nonempty string": "st_expected_nonempty_string",
  "duplicate identifier": "st_duplicate_identifier",
  "expected string or number": "st_expected_string_or_number",
  "expected string array": "st_expected_string_array",
  "expected prompt content": "st_expected_prompt_content",
  "unsupported role": "st_unsupported_role",
  "unknown order field": "st_unknown_order_field",
  "duplicate order identifier": "st_duplicate_order_identifier",
  "unknown prompt reference": "st_unknown_prompt_reference",
  "unknown group field": "st_unknown_group_field",
  "expected character identifier": "st_expected_character_identifier",
  "duplicate character group": "st_duplicate_character_group",
  "unknown group": "st_unknown_group",
  "choose a character group": "st_choose_a_character_group",
  "invalid selection": "st_invalid_selection",
} as const;
function fail(path: string, message: keyof typeof structuralErrorCodes): never {
  throw new Error(`${path}: ${message} [${structuralErrorCodes[message]}]`);
}
function object(value: unknown, path: string): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "expected object");
  return value as ObjectValue;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
  return value;
}
function optional(
  value: unknown,
  type: "string" | "boolean" | "number",
  path: string,
): void {
  if (
    value !== undefined &&
    (typeof value !== type || (type === "number" && !Number.isFinite(value)))
  )
    fail(path, `expected ${type}`);
}
function parse(
  raw: string,
  groupId?: string,
): { inspection: SillyTavernInspection; selected: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail("$", "invalid JSON");
  }
  const root = object(parsed, "$");
  if (
    "main_prompt" in root ||
    "nsfw_prompt" in root ||
    "jailbreak_prompt" in root
  )
    fail("$", "legacy prompt format is unsupported");
  const manager =
    root.version === 1 && (root.type === "full" || root.type === "character");
  const data = manager ? object(root.data, "$.data") : root;
  if (
    !manager &&
    ("version" in root ||
      "type" in root ||
      !Array.isArray(root.prompts) ||
      !Array.isArray(root.prompt_order))
  )
    fail("$", "unsupported preset format");
  const prefix = manager ? "$.data" : "$";
  const prompts = array(data.prompts, `${prefix}.prompts`);
  const byId = new Map<string, { value: ObjectValue; path: string }>();
  prompts.forEach((entry, index) => {
    const path = `${prefix}.prompts[${index}]`;
    const value = object(entry, path);
    if (typeof value.identifier !== "string" || !value.identifier)
      fail(`${path}.identifier`, "expected nonempty string");
    if (byId.has(value.identifier))
      fail(`${path}.identifier`, "duplicate identifier");
    for (const key of ["name", "role", "content"])
      optional(value[key], "string", `${path}.${key}`);
    for (const key of [
      "system_prompt",
      "marker",
      "forbid_overrides",
      "extension",
      "enabled",
    ])
      optional(value[key], "boolean", `${path}.${key}`);
    for (const key of [
      "injection_position",
      "injection_depth",
      "injection_order",
    ])
      optional(value[key], "number", `${path}.${key}`);
    if (
      value.position !== undefined &&
      typeof value.position !== "number" &&
      typeof value.position !== "string"
    )
      fail(`${path}.position`, "expected string or number");
    if (
      value.injection_trigger !== undefined &&
      (!Array.isArray(value.injection_trigger) ||
        value.injection_trigger.some((v) => typeof v !== "string"))
    )
      fail(`${path}.injection_trigger`, "expected string array");
    if (value.marker !== true && typeof value.content !== "string")
      fail(`${path}.content`, "expected prompt content");
    if (
      value.role !== undefined &&
      !["system", "user", "assistant"].includes(value.role as string)
    )
      fail(`${path}.role`, "unsupported role");
    byId.set(value.identifier, { value, path });
  });
  type Order = { id: string; enabled: boolean; path: string }[];
  function order(value: unknown, path: string): Order {
    const seen = new Set<string>();
    return array(value, path).map((entry, index) => {
      const itemPath = `${path}[${index}]`;
      const item = object(entry, itemPath);
      if (
        Object.keys(item).some(
          (key) => !["identifier", "enabled"].includes(key),
        )
      )
        fail(itemPath, "unknown order field");
      if (typeof item.identifier !== "string" || !item.identifier)
        fail(`${itemPath}.identifier`, "expected nonempty string");
      if (typeof item.enabled !== "boolean")
        fail(`${itemPath}.enabled`, "expected boolean");
      if (seen.has(item.identifier))
        fail(`${itemPath}.identifier`, "duplicate order identifier");
      seen.add(item.identifier);
      if (!byId.has(item.identifier) && !builtins.has(item.identifier))
        fail(`${itemPath}.identifier`, "unknown prompt reference");
      return { id: item.identifier, enabled: item.enabled, path: itemPath };
    });
  }
  const groups: { id: string; label: string }[] = [];
  const orders = new Map<string, Order>();
  if (manager)
    orders.set("manager", order(data.prompt_order, `${prefix}.prompt_order`));
  else
    array(data.prompt_order, "$.prompt_order").forEach((entry, index) => {
      const path = `$.prompt_order[${index}]`;
      const value = object(entry, path);
      if (
        Object.keys(value).some(
          (key) => !["character_id", "order"].includes(key),
        )
      )
        fail(path, "unknown group field");
      if (
        (typeof value.character_id !== "string" &&
          typeof value.character_id !== "number") ||
        String(value.character_id).length === 0
      )
        fail(`${path}.character_id`, "expected character identifier");
      const id = String(value.character_id);
      if (orders.has(id))
        fail(`${path}.character_id`, "duplicate character group");
      groups.push({ id, label: id });
      orders.set(id, order(value.order, `${path}.order`));
    });
  const selectedId = manager
    ? "manager"
    : (groupId ??
      (orders.has("100001")
        ? "100001"
        : groups.length === 1
          ? groups[0]!.id
          : undefined));
  if (groupId !== undefined && (!orders.has(groupId) || manager))
    fail("$.prompt_order", "unknown group");
  const selectedOrder =
    selectedId === undefined ? undefined : orders.get(selectedId);
  const result: SillyTavernPrompt[] = [];
  const seen = new Set<string>();
  function add(
    id: string,
    ordered: boolean,
    enabled: boolean | undefined,
    orderPath?: string,
  ): void {
    seen.add(id);
    const found = byId.get(id);
    if (!found) {
      result.push({
        id,
        path: orderPath!,
        name: id,
        enabled,
        ordered,
        marker: false,
        missing: true,
        macros: [],
        reasons: ["missing_builtin"],
        unsupportedPaths: [],
      });
      return;
    }
    const { value, path } = found;
    const content = value.content as string | undefined;
    const macros = [
      ...new Set(
        content?.match(
          /\{\{[^{}]*\}\}|<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/giu,
        ) ?? [],
      ),
    ];
    const reasons: SillyTavernReason[] = [];
    const unsupportedPaths = Object.keys(value)
      .filter((key) => !fields.has(key))
      .map((key) => `${path}.${key}`);
    if (value.marker === true) reasons.push("marker");
    if (macros.length) reasons.push("unsupported_macro");
    if (
      value.injection_position !== undefined &&
      value.injection_position !== 0
    )
      reasons.push("depth_injection");
    if (
      Array.isArray(value.injection_trigger) &&
      value.injection_trigger.length
    )
      reasons.push("trigger");
    if (
      (id === "main" || id === "jailbreak") &&
      value.forbid_overrides !== true
    )
      reasons.push("overrides");
    if (value.extension === true || unsupportedPaths.length > 0)
      reasons.push("unsupported_fields");
    if (!ordered) reasons.push("unplaced");
    result.push({
      id,
      path,
      name: (value.name as string | undefined) ?? id,
      role: value.role as string | undefined,
      content,
      enabled,
      ordered,
      marker: value.marker === true,
      missing: false,
      injectionPosition: value.injection_position as number | undefined,
      injectionDepth: value.injection_depth as number | undefined,
      injectionOrder: value.injection_order as number | undefined,
      triggers: value.injection_trigger as string[] | undefined,
      macros,
      forbidOverrides: value.forbid_overrides as boolean | undefined,
      reasons,
      unsupportedPaths,
      systemPrompt: value.system_prompt as boolean | undefined,
      extension: value.extension as boolean | undefined,
      position: value.position as string | number | undefined,
    });
  }
  selectedOrder?.forEach((entry) =>
    add(entry.id, true, entry.enabled, entry.path),
  );
  if (selectedOrder)
    for (const id of byId.keys()) if (!seen.has(id)) add(id, false, undefined);
  function settingsCategory(key: string): SillyTavernSettingCategory {
    if (
      /password|key|token|proxy|url|endpoint|header|auth/iu.test(key) &&
      !/max_tokens/iu.test(key)
    )
      return "connection";
    if (
      /temperature|penalty|top_|min_p|repetition|context|tokens|sampl/iu.test(
        key,
      )
    )
      return "sampling";
    if (/model|source|api/iu.test(key)) return "model";
    if (/extension|regex|script/iu.test(key)) return "extension";
    return "generation";
  }
  const safeNumericSettings = new Set([
    "temperature",
    "top_p",
    "top_k",
    "top_a",
    "min_p",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "openai_max_context",
    "openai_max_tokens",
  ]);
  const setting = (key: string, path: string, value: unknown) => ({
    path,
    category: settingsCategory(key),
    ...(safeNumericSettings.has(key) &&
    typeof value === "number" &&
    Number.isFinite(value)
      ? { value }
      : {}),
  });
  const settings = [
    ...Object.keys(root)
      .filter((key) =>
        manager
          ? !["version", "type", "data"].includes(key)
          : !["prompts", "prompt_order"].includes(key),
      )
      .map((key) => setting(key, `$.${key}`, root[key])),
    ...(manager
      ? Object.keys(data)
          .filter((key) => !["prompts", "prompt_order"].includes(key))
          .map((key) => setting(key, `$.data.${key}`, data[key]))
      : []),
  ];
  return {
    inspection: {
      groups,
      selectedGroupId: manager ? undefined : selectedId,
      prompts: result,
      settings,
    },
    selected: selectedOrder !== undefined,
  };
}

export function inspectSillyTavernPreset(
  raw: string,
  groupId?: string,
): SillyTavernInspection {
  return parse(raw, groupId).inspection;
}

export function convertSillyTavernPreset(
  raw: string,
  options: {
    groupId?: string | undefined;
    selected: string[];
    name: string;
    locale: AppLocale;
  },
): SillyTavernConversion {
  const { inspection, selected } = parse(raw, options.groupId);
  if (!selected) fail("$.prompt_order", "choose a character group");
  if (
    new Set(options.selected).size !== options.selected.length ||
    options.selected.some(
      (id) => !inspection.prompts.some((item) => item.id === id),
    )
  )
    fail("selection", "invalid selection");
  const catalog = builtinPlayPrompts(options.locale);
  const entries: OrderedPlayPrompt[] = catalog
    .filter((item) => item.required)
    .map((item) => ({
      id: item.id,
      kind: "builtin",
      builtin: item.id,
      enabled: true,
    }));
  const report: SillyTavernDiagnostic[] = inspection.settings.map(
    (setting) => ({
      code: "ignored_setting",
      path: setting.path,
      result: "ignored",
    }),
  );
  const targetIds = new Map<string, string>();
  for (const item of inspection.prompts) {
    const chosen = options.selected.includes(item.id);
    report.push({
      code: "prompt_selection",
      path: item.path,
      name: item.name,
      result: !chosen
        ? "not_selected"
        : item.marker || item.missing
          ? "not_imported"
          : item.enabled === true && item.reasons.length === 0
            ? "enabled"
            : "disabled",
    });
    for (const code of item.reasons)
      report.push({
        code,
        path: item.path,
        name: item.name,
        result:
          chosen && !item.marker && !item.missing ? "disabled" : "not_imported",
      });
    for (const path of item.unsupportedPaths)
      report.push({
        code: "unsupported_field",
        path,
        name: item.name,
        result: chosen ? "disabled" : "not_imported",
      });
    if (!chosen || item.marker || item.missing) continue;
    const targetId = `st-${entries.length}`;
    targetIds.set(item.id, targetId);
    entries.push({
      id: targetId,
      kind: "user",
      name: item.name,
      body: item.content!,
      messageRole: (item.role ?? "system") as "system" | "user" | "assistant",
      enabled: item.enabled === true && item.reasons.length === 0,
    });
  }
  entries.push({ id: "world", kind: "world" });
  entries.push(
    ...catalog
      .filter((item) => !item.required)
      .map((item): OrderedPlayPrompt => ({
        id: item.id,
        kind: "builtin",
        builtin: item.id,
        enabled: false,
      })),
  );
  const arrangement = customizePromptArrangement(entries, catalog);
  const files = applicationPresetFilesForLocale(options.locale);
  files["preset.yaml"] = stringify({
    format: "narraeon.play-preset/v3",
    name: options.name,
    callChain: "call-chain.yaml",
    playPrompts: arrangement,
    authorPrompts: {},
    mergeConsecutiveMessages: false,
    mounts: [],
    extensions: [],
  });
  files["assets/sillytavern-import-report.json"] = JSON.stringify(
    {
      format: "narraeon.sillytavern-import/v1",
      sourceGroupId: inspection.selectedGroupId,
      prompts: inspection.prompts.flatMap((item, index) =>
        options.selected.includes(item.id)
          ? [
              {
                sourceId: item.id,
                path: item.path,
                name: item.name,
                role: item.role,
                sourceEnabled: item.enabled,
                ordered: item.ordered,
                orderIndex: item.ordered ? index : undefined,
                marker: item.marker,
                missing: item.missing,
                injectionPosition: item.injectionPosition,
                injectionDepth: item.injectionDepth,
                injectionOrder: item.injectionOrder,
                triggers: item.triggers,
                macros: item.macros,
                forbidOverrides: item.forbidOverrides,
                systemPrompt: item.systemPrompt,
                extension: item.extension,
                position: item.position,
                unsupportedPaths: item.unsupportedPaths,
                targetId: targetIds.get(item.id),
              },
            ]
          : [],
      ),
      report: report.filter(
        (item) =>
          item.code === "ignored_setting" ||
          (item.name !== undefined &&
            inspection.prompts.some(
              (prompt) =>
                options.selected.includes(prompt.id) &&
                (item.path === prompt.path ||
                  item.path.startsWith(`${prompt.path}.`)),
            )),
      ),
    },
    null,
    2,
  );
  return {
    files,
    report,
    target: entries.map((entry) => ({
      name:
        entry.kind === "user"
          ? entry.name
          : entry.kind === "builtin"
            ? catalog.find((item) => item.id === entry.builtin)!.name
            : "World",
      kind: entry.kind,
      enabled: entry.kind === "world" || entry.enabled,
    })),
  };
}
