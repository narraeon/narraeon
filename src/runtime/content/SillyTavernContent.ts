import { inflateSync } from "node:zlib";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import { parseDocument, stringify } from "yaml";
import type { ContentTreeFile } from "./ContentTreeFile.ts";

import type {
  ContentInspection,
  ContentSelection,
  ContentSourceEntry,
} from "../../protocol/sillyTavernContent.ts";
const limit = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
function fail(code: string, path: string): never {
  throw new Error(`${path}: ${code}`);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected_object", path);
  return value as Record<string, unknown>;
}
function pngJson(bytes: Buffer): { bytes: Buffer; key: string } {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail("invalid_png", "$ ");
  let offset = 8,
    ended = false,
    sawHeader = false,
    sawImage = false,
    imageEnded = false;
  let width = 0,
    height = 0,
    depth = 0,
    color = 0,
    interlace = 0;
  const imageChunks: Buffer[] = [];
  let sawPalette = false;
  const chunks = new Map<string, Buffer>();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("invalid_png_chunk", "$ ");
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length || length > limit) fail("invalid_png_chunk", "$ ");
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== bytes.readUInt32BE(offset + 8 + length))
      fail("invalid_png_crc", "$ ");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/u.test(type) ||
      (/^[A-Z]/u.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))
    )
      fail("invalid_png_chunk", "$");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) fail("invalid_png_header", "$");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      depth = bytes[offset + 16]!;
      color = bytes[offset + 17]!;
      interlace = bytes[offset + 20]!;
      const allowedDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !allowedDepths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        ![0, 1].includes(interlace)
      )
        fail("invalid_png_header", "$");
      if (
        !width ||
        !height ||
        width > 16384 ||
        height > 16384 ||
        width * height > 64000000
      )
        fail("invalid_png_dimensions", "$");
      sawHeader = true;
    } else if (type === "IHDR") fail("invalid_png_header", "$");
    if (type === "PLTE") {
      if (
        sawPalette ||
        sawImage ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        color === 0 ||
        color === 4
      )
        fail("invalid_png_chunk", "$");
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (color === 3 && !sawPalette) fail("invalid_png_chunk", "$");
      if (imageEnded) fail("invalid_png_chunk", "$");
      sawImage = true;
      imageChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (sawImage) imageEnded = true;
    if (type === "IEND" && (length !== 0 || !sawImage))
      fail("invalid_png", "$");
    if (type === "tEXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + length),
        sep = data.indexOf(0);
      const key = data.subarray(0, sep).toString("latin1").toLowerCase();
      if ((key === "chara" || key === "ccv3") && sep >= 0) {
        if (chunks.has(key)) fail("duplicate_metadata", key);
        chunks.set(key, data.subarray(sep + 1));
      }
    }
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) fail("invalid_png", "$ ");
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const rows: number[] = [];
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x!) / dx!)),
      h = Math.max(0, Math.ceil((height - y!) / dy!));
    if (w && h)
      for (let row = 0; row < h; row++)
        rows.push(1 + Math.ceil((w * depth * channels[color]!) / 8));
  }
  const expected = rows.reduce((sum, size) => sum + size, 0);
  if (expected > 64 * 1024 * 1024) fail("invalid_png_dimensions", "$");
  let pixels: Buffer;
  try {
    const compressed = Buffer.concat(imageChunks);
    const result = inflateSync(compressed, {
      maxOutputLength: expected + 1,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (result.engine.bytesWritten !== compressed.length)
      fail("invalid_png_image", "$");
    pixels = result.buffer;
  } catch {
    return fail("invalid_png_image", "$");
  }
  if (pixels.length !== expected) fail("invalid_png_image", "$");
  let cursor = 0;
  for (const size of rows) {
    if (pixels[cursor]! > 4) fail("invalid_png_image", "$");
    cursor += size;
  }
  const encoded = chunks.get("ccv3") ?? chunks.get("chara");
  if (!encoded) fail("missing_card_metadata", "$ ");
  const text = encoded.toString("latin1");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      text,
    )
  )
    fail("invalid_base64", "$ ");
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) fail("invalid_base64", "$ ");
  return { bytes: decoded, key: chunks.has("ccv3") ? "ccv3" : "chara" };
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const ruleKeys = new Set([
  "id",
  "uid",
  "key",
  "keys",
  "keysecondary",
  "secondary_keys",
  "enabled",
  "disable",
  "constant",
  "selective",
  "selectiveLogic",
  "insertion_order",
  "order",
  "displayIndex",
  "position",
  "depth",
  "role",
  "sticky",
  "cooldown",
  "delay",
  "probability",
  "useProbability",
  "group",
  "group_weight",
  "groupWeight",
  "groupOverride",
  "exclude_recursion",
  "prevent_recursion",
  "delay_until_recursion",
  "excludeRecursion",
  "preventRecursion",
  "delayUntilRecursion",
  "scanDepth",
  "caseSensitive",
  "matchWholeWords",
  "useGroupScoring",
  "automationId",
  "vectorized",
  "triggers",
  "ignoreBudget",
  "outletName",
  "addMemo",
  "characterFilterNames",
  "characterFilterTags",
  "characterFilterExclude",
  "use_regex",
  "display_index",
  "outlet_name",
  "group_override",
  "scan_depth",
  "case_sensitive",
  "match_whole_words",
  "use_group_scoring",
  "automation_id",
  "match_persona_description",
  "match_character_description",
  "match_character_personality",
  "match_character_depth_prompt",
  "match_scenario",
  "match_creator_notes",
  "ignore_budget",
  "matchPersonaDescription",
  "matchCharacterDescription",
  "matchCharacterPersonality",
  "matchCharacterDepthPrompt",
  "matchScenario",
  "matchCreatorNotes",
]);
const numericRules = new Set([
  "order",
  "insertion_order",
  "displayIndex",
  "display_index",
  "depth",
  "probability",
  "groupWeight",
  "group_weight",
  "scanDepth",
  "scan_depth",
  "sticky",
  "cooldown",
  "delay",
]);
const booleanRules = new Set([
  "enabled",
  "disable",
  "constant",
  "selective",
  "useProbability",
  "groupOverride",
  "group_override",
  "excludeRecursion",
  "exclude_recursion",
  "preventRecursion",
  "prevent_recursion",
  "caseSensitive",
  "case_sensitive",
  "matchWholeWords",
  "match_whole_words",
  "useGroupScoring",
  "use_group_scoring",
  "vectorized",
  "ignoreBudget",
  "ignore_budget",
  "addMemo",
  "use_regex",
  "characterFilterExclude",
  "matchPersonaDescription",
  "matchCharacterDescription",
  "matchCharacterPersonality",
  "matchCharacterDepthPrompt",
  "matchScenario",
  "matchCreatorNotes",
  "match_persona_description",
  "match_character_description",
  "match_character_personality",
  "match_character_depth_prompt",
  "match_scenario",
  "match_creator_notes",
]);
const arrayRules = new Set([
  "key",
  "keys",
  "keysecondary",
  "secondary_keys",
  "triggers",
  "characterFilterNames",
  "characterFilterTags",
]);
function safeRules(
  entry: Record<string, unknown>,
  path: string,
  diagnostics: ContentInspection["diagnostics"],
): Record<string, unknown> {
  const rules: Record<string, unknown> = {};
  const visit = (
    source: Record<string, unknown>,
    target: Record<string, unknown>,
    prefix: string,
  ) => {
    for (const [key, value] of Object.entries(source)) {
      if (["content", "comment", "name"].includes(key)) continue;
      if (key === "extensions" && prefix === path) {
        const nested = record(value, `${prefix}.extensions`),
          safe: Record<string, unknown> = {};
        visit(nested, safe, `${prefix}.extensions`);
        target.extensions = safe;
        continue;
      }
      if (key === "characterFilter" && prefix === path) {
        if (value === null) {
          target.characterFilter = null;
          continue;
        }
        const filter = record(value, `${prefix}.characterFilter`),
          safe: Record<string, unknown> = {};
        for (const [field, item] of Object.entries(filter)) {
          if (
            ["names", "tags"].includes(field) &&
            Array.isArray(item) &&
            item.every((x) => typeof x === "string")
          )
            safe[field] = item;
          else if (field === "isExclude" && typeof item === "boolean")
            safe[field] = item;
          else fail("invalid_rule_type", `${prefix}.characterFilter.${field}`);
        }
        target.characterFilter = safe;
        continue;
      }
      if (!ruleKeys.has(key)) {
        diagnostics.push({
          code: "unsupported_field",
          path: `${prefix}.${key}`,
        });
        continue;
      }
      const nullable = new Set([
        "scanDepth",
        "scan_depth",
        "caseSensitive",
        "case_sensitive",
        "matchWholeWords",
        "match_whole_words",
        "useGroupScoring",
        "use_group_scoring",
        "sticky",
        "cooldown",
        "delay",
        "group_weight",
        "probability",
      ]);
      if (
        value === null &&
        (numericRules.has(key) || booleanRules.has(key)) &&
        !nullable.has(key)
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        value !== null &&
        numericRules.has(key) &&
        (typeof value !== "number" || !Number.isFinite(value))
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (value !== null && booleanRules.has(key) && typeof value !== "boolean")
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        arrayRules.has(key) &&
        (!Array.isArray(value) ||
          !value.every((item) => typeof item === "string"))
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        [
          "group",
          "automationId",
          "automation_id",
          "outletName",
          "outlet_name",
        ].includes(key) &&
        typeof value !== "string"
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        key === "selectiveLogic" &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 3)
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        ["position", "role"].includes(key) &&
        typeof value !== "number" &&
        typeof value !== "string"
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        ["delayUntilRecursion", "delay_until_recursion"].includes(key) &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      )
        fail("invalid_rule_type", `${prefix}.${key}`);
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
      )
        target[key] = value;
      else fail("invalid_rule_type", `${prefix}.${key}`);
    }
  };
  visit(entry, rules, path);
  return rules;
}
export function inspectSillyTavernContent(source: Buffer): ContentInspection {
  if (source.length > limit) fail("source_too_large", "$");
  const png = source[0] === 137 ? pngJson(source) : undefined;
  const bytes = png?.bytes ?? source;
  let root: Record<string, unknown>;
  try {
    const text = decoder.decode(bytes);
    root = record(JSON.parse(text) as unknown, "$");
    const document = parseDocument(text, { uniqueKeys: true, strict: true });
    if (document.errors.length > 0) fail("ambiguous_json", "$");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("expected_object") ||
        error.message.includes("ambiguous_json"))
    )
      throw error;
    return fail("invalid_json_or_utf8", "$");
  }
  if (png?.key === "ccv3" && root.spec !== "chara_card_v3")
    fail("invalid_png_metadata", "$.spec");
  if (png && root.spec === undefined && root.entries !== undefined)
    fail("invalid_png_metadata", "$");
  let kind: ContentInspection["kind"] = "character",
    version = "v1",
    data = root;
  if (root.spec !== undefined) {
    if (root.spec !== "chara_card_v2" && root.spec !== "chara_card_v3")
      fail("unknown_version", "$.spec");
    const expected = root.spec === "chara_card_v2" ? "2" : "3";
    if (
      typeof root.spec_version !== "string" ||
      !(expected === "2"
        ? root.spec_version === "2.0"
        : /^3\.\d+(?:\.\d+)?$/u.test(root.spec_version))
    )
      fail("unknown_version", "$.spec_version");
    version = String(root.spec);
    data = record(root.data, "$.data");
  } else if (root.entries !== undefined) {
    kind = "worldbook";
    version = "world_info";
  } else if (
    ![
      "name",
      "description",
      "personality",
      "scenario",
      "first_mes",
      "mes_example",
    ].every((key) => typeof root[key] === "string")
  )
    fail("unsupported_format", "$");
  const diagnostics: ContentInspection["diagnostics"] = [];
  if (data !== root)
    for (const key of [
      "name",
      "description",
      "personality",
      "scenario",
      "first_mes",
      "mes_example",
    ])
      if (root[key] !== undefined && root[key] !== data[key])
        diagnostics.push({ code: "legacy_field_conflict", path: `$.${key}` });
  if (
    kind === "character" &&
    (typeof data.name !== "string" || !data.name.trim())
  )
    fail("missing_character_name", "$.data.name");
  for (const key of [
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "system_prompt",
    "post_history_instructions",
    "creator_notes",
    "creator",
    "character_version",
  ])
    if (data[key] !== undefined && typeof data[key] !== "string")
      fail("expected_string", `$.data.${key}`);
  if (
    data.alternate_greetings !== undefined &&
    (!Array.isArray(data.alternate_greetings) ||
      !data.alternate_greetings.every((x) => typeof x === "string"))
  )
    fail("expected_string_array", "$.data.alternate_greetings");
  if (
    data.tags !== undefined &&
    (!Array.isArray(data.tags) ||
      !data.tags.every((item) => typeof item === "string"))
  )
    fail("expected_string_array", "$.data.tags");
  if (data.extensions !== undefined) {
    const extensions = record(data.extensions, "$.data.extensions");
    if (extensions.world !== undefined && typeof extensions.world !== "string")
      fail("expected_string", "$.data.extensions.world");
    if (extensions.depth_prompt !== undefined) {
      const depth = record(
        extensions.depth_prompt,
        "$.data.extensions.depth_prompt",
      );
      if (
        (depth.prompt !== undefined && typeof depth.prompt !== "string") ||
        (depth.depth !== undefined && typeof depth.depth !== "number") ||
        (depth.role !== undefined &&
          typeof depth.role !== "number" &&
          typeof depth.role !== "string")
      )
        fail("invalid_depth_prompt", "$.data.extensions.depth_prompt");
    }
  }
  const book =
    kind === "worldbook"
      ? root
      : data.character_book === undefined
        ? undefined
        : record(data.character_book, "$.data.character_book");
  if (kind === "character") {
    const knownFields = new Set([
      "name",
      "description",
      "personality",
      "scenario",
      "first_mes",
      "alternate_greetings",
      "mes_example",
      "system_prompt",
      "post_history_instructions",
      "creator_notes",
      "creator",
      "character_version",
      "tags",
      "extensions",
      "character_book",
    ]);
    for (const key of Object.keys(data))
      if (!knownFields.has(key))
        diagnostics.push({ code: "unsupported_field", path: `$.data.${key}` });
  }
  const entries: ContentSourceEntry[] = [];
  if (book) {
    const embedded = kind === "character",
      collection = book.entries;
    if (
      embedded
        ? !Array.isArray(collection)
        : !collection ||
          typeof collection !== "object" ||
          Array.isArray(collection)
    )
      fail("invalid_entries", "$.entries");
    const items = embedded
      ? (collection as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(collection as Record<string, unknown>);
    const identities = new Set<string>();
    for (const [key, value] of items) {
      const path = `${embedded ? "$.data.character_book" : "$"}.entries.${key}`,
        entry = record(value, path);
      const providedIdentity = embedded ? entry.id : entry.uid;
      const rawIdentity =
        providedIdentity === undefined ? key : providedIdentity;
      if (
        (typeof rawIdentity !== "string" && typeof rawIdentity !== "number") ||
        (typeof rawIdentity === "number" && !Number.isFinite(rawIdentity))
      )
        fail("invalid_identity", path);
      const identity = String(rawIdentity);
      if (entry.comment !== undefined && typeof entry.comment !== "string")
        fail("expected_string", `${path}.comment`);
      if (entry.name !== undefined && typeof entry.name !== "string")
        fail("expected_string", `${path}.name`);
      if (identities.has(identity)) fail("duplicate_identity", path);
      identities.add(identity);
      if (typeof entry.content !== "string")
        fail("expected_string", `${path}.content`);
      const flag = embedded ? entry.enabled : entry.disable;
      if (flag !== undefined && typeof flag !== "boolean")
        fail("expected_boolean", path);
      for (const k of embedded
        ? ["keys", "secondary_keys"]
        : ["key", "keysecondary"])
        if (
          entry[k] !== undefined &&
          (!Array.isArray(entry[k]) ||
            !(entry[k] as unknown[]).every((x) => typeof x === "string"))
        )
          fail("expected_string_array", `${path}.${k}`);
      entries.push({
        id: `entry-${entries.length}`,
        path,
        name: String(entry.comment ?? entry.name ?? identity),
        content: entry.content,
        enabled: embedded ? flag === true : flag !== true,
        rules: safeRules(entry, path, diagnostics),
      });
    }
  }
  if (recordOrEmpty(data.extensions).world)
    diagnostics.push({
      code: book
        ? "external_worldbook_reference"
        : "external_worldbook_unavailable",
      path: "$.data.extensions.world",
    });
  if (source[0] === 137)
    diagnostics.push({ code: "image_not_migrated", path: "$" });
  const legacyFields =
    data === root
      ? {}
      : Object.fromEntries(
          [
            "name",
            "description",
            "personality",
            "scenario",
            "first_mes",
            "mes_example",
          ]
            .filter((key) => root[key] !== undefined)
            .map((key) => [key, root[key]]),
        );
  return { kind, version, fields: data, legacyFields, entries, diagnostics };
}
function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function hasMacro(text: string): boolean {
  return /\{\{[^{}]+\}\}|<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/iu.test(text);
}
export function convertSillyTavernContent(
  source: Buffer,
  selection: ContentSelection,
  locale: AppLocale = "en",
): { files: ContentTreeFile[]; diagnostics: ContentInspection["diagnostics"] } {
  const view = inspectSillyTavernContent(source),
    files: ContentTreeFile[] = [],
    diagnostics = [...view.diagnostics];
  if (
    !selection?.entries ||
    typeof selection.entries !== "object" ||
    Array.isArray(selection.entries)
  )
    fail("invalid_selection", "$.selection");
  const allowedSelection = [
    "character",
    "scenario",
    "opening",
    "example",
    "systemPrompt",
    "attachments",
    "entries",
  ];
  if (
    Object.keys(selection).some((key) => !allowedSelection.includes(key)) ||
    [
      selection.character,
      selection.scenario,
      selection.example,
      selection.systemPrompt,
    ].some((value) => value !== undefined && typeof value !== "boolean") ||
    (selection.opening !== undefined && typeof selection.opening !== "string")
  )
    fail("invalid_selection", "$.selection");
  const attachmentFields = [
    "creator_notes",
    "creator",
    "character_version",
    "tags",
    "post_history_instructions",
    "depth_prompt",
  ];
  if (
    selection.attachments !== undefined &&
    (!Array.isArray(selection.attachments) ||
      selection.attachments.some((key) => !attachmentFields.includes(key)))
  )
    fail("invalid_selection", "$.selection.attachments");
  const preservedFields: Record<string, unknown> = {};
  for (const key of selection.attachments ?? []) {
    const value =
      key === "depth_prompt"
        ? recordOrEmpty(view.fields.extensions).depth_prompt
        : view.fields[key];
    if (
      typeof value === "string" ||
      (key === "tags" &&
        Array.isArray(value) &&
        value.every((item) => typeof item === "string"))
    )
      preservedFields[key] = value;
    else if (key === "depth_prompt" && value !== undefined) {
      const depth = record(value, "$.data.extensions.depth_prompt");
      preservedFields[key] = Object.fromEntries(
        Object.entries(depth).filter(
          ([field, item]) =>
            ["prompt", "depth", "role"].includes(field) &&
            (typeof item === "string" || typeof item === "number"),
        ),
      );
    }
  }
  const known = new Set(view.entries.map((e) => e.id));
  for (const [id, target] of Object.entries(selection.entries))
    if (!known.has(id) || !["world", "attachment"].includes(target))
      fail("invalid_selection", `$.selection.entries.${id}`);
  const field = (key: string) =>
    typeof view.fields[key] === "string" ? view.fields[key] : "";
  const addDocument = (
    path: string,
    id: string,
    title: string,
    content: string | Record<string, string>,
  ) =>
    files.push({
      path,
      contents: stringify({
        $document: {
          id,
          ref: id.replaceAll(".", "-"),
          title: title || id,
          summary: title || id,
          aliases: [],
        },
        content,
      }),
    });
  if (selection.character && view.kind === "character") {
    const content = {
      description: field("description"),
      personality: field("personality"),
    };
    if (
      hasMacro(Object.values(content).join("\n")) ||
      hasMacro(field("name"))
    ) {
      diagnostics.push({ code: "unbound_macro", path: "$.data.description" });
      preservedFields.character = { name: field("name"), ...content };
    } else if (content.description || content.personality)
      addDocument(
        "world/characters/character.yaml",
        "character.imported",
        field("name"),
        content,
      );
  }
  if (selection.scenario && field("scenario") && !hasMacro(field("scenario")))
    addDocument(
      "world/current-situation.yaml",
      "current.situation",
      locale === "zh-CN" ? "当前情境" : "Current situation",
      field("scenario"),
    );
  else if (selection.scenario && hasMacro(field("scenario"))) {
    diagnostics.push({ code: "unbound_macro", path: "$.data.scenario" });
    preservedFields.scenario = field("scenario");
  }
  const openings = [
    field("first_mes"),
    ...(Array.isArray(view.fields.alternate_greetings)
      ? (view.fields.alternate_greetings as string[])
      : []),
  ];
  if (selection.opening !== undefined) {
    if (
      !/^\d+$/u.test(selection.opening) ||
      !openings[Number(selection.opening)]
    )
      fail("invalid_opening_selection", "$.selection.opening");
    const remaining = openings
      .map((text, index) => ({ index, text }))
      .filter((item) => item.index !== Number(selection.opening) && item.text);
    if (remaining.length) preservedFields.other_openings = remaining;
    const opening = openings[Number(selection.opening)]!;
    if (hasMacro(opening)) {
      diagnostics.push({ code: "unbound_macro", path: "$.data.first_mes" });
      preservedFields.opening = opening;
    } else files.push({ path: "opening.md", contents: opening });
  }
  const blocks: string[] = [];
  if (selection.example && hasMacro(field("mes_example"))) {
    diagnostics.push({ code: "unbound_macro", path: "$.data.mes_example" });
    preservedFields.mes_example = field("mes_example");
  }
  if (selection.systemPrompt && hasMacro(field("system_prompt"))) {
    diagnostics.push({ code: "unbound_macro", path: "$.data.system_prompt" });
    preservedFields.system_prompt = field("system_prompt");
  }
  if (
    selection.example &&
    field("mes_example") &&
    !hasMacro(field("mes_example"))
  )
    blocks.push(
      `# ${locale === "zh-CN" ? "虚构对话示例" : "Fictional dialogue example"}\n\n${field("mes_example")}`,
    );
  if (
    selection.systemPrompt &&
    field("system_prompt") &&
    !hasMacro(field("system_prompt"))
  )
    blocks.push(
      `# ${locale === "zh-CN" ? "角色专属提示" : "Character system prompt"}\n\n${field("system_prompt")}`,
    );
  files.push({
    path: "control/blocks/world.md",
    contents:
      blocks.join("\n\n") || "<!-- No imported control instructions. -->\n",
  });
  files.push({
    path: "control/frame.yaml",
    contents:
      'format: narraeon.world-frame/v1\nbindings:\n  currentSituation: "@current-situation"\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: catalog, directory: characters, maxEntries: 24, required: false }\n  - slot: { kind: catalog, directory: lore, maxEntries: 100, required: false }\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 2 }\n  - slot: { kind: additional_materials }\n',
  });
  files.push({
    path: "control/player-views.yaml",
    contents: "format: narraeon.player-views/v1\nviews: []\n",
  });
  const attachments: unknown[] = [];
  for (const entry of view.entries) {
    const target = selection.entries[entry.id];
    if (!target) continue;
    if (
      target === "world" &&
      entry.enabled &&
      !hasMacro(entry.content) &&
      !hasMacro(entry.name)
    )
      addDocument(
        `world/lore/${entry.id}.yaml`,
        `lore.${entry.id}`,
        entry.name,
        entry.content,
      );
    {
      attachments.push({
        id: entry.id,
        path: entry.path,
        name: entry.name,
        content: entry.content,
        enabled: entry.enabled,
        rules: entry.rules,
      });
      if (
        target === "world" &&
        (!entry.enabled || hasMacro(entry.content) || hasMacro(entry.name))
      )
        diagnostics.push({
          code: entry.enabled ? "unbound_macro" : "disabled_entry",
          path: entry.path,
        });
    }
  }
  if (diagnostics.some((item) => item.code === "unbound_macro")) {
    const openingIndex = files.findIndex((file) => file.path === "opening.md");
    if (openingIndex >= 0) {
      preservedFields.opening = files[openingIndex]!.contents;
      files.splice(openingIndex, 1);
    }
  }
  files.push({
    path: "assets/sillytavern-migration.yaml",
    contents: stringify({
      selectedFields: preservedFields,
      selectedAttachments: attachments,
      diagnostics,
    }),
  });
  return { files, diagnostics };
}
