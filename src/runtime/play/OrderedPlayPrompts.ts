import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  builtinPlayPrompts,
  type OrderedPlayPrompt,
} from "../../shared/ordered-play-prompts.ts";

/** The same strict permission gate is used by portable imports and structured saves. */
export function parseOrderedPlayPrompts(value: unknown): OrderedPlayPrompt[] {
  const fail = (): never => {
    throw new Error(
      "Invalid ordered play prompts: unique identities, current builtins, enabled mechanics and one world placeholder are required",
    );
  };
  if (!Array.isArray(value) || value.length > 256) return fail();
  const ids = new Set<string>();
  const builtins = new Set<string>();
  let worlds = 0;
  const entries = value.map((raw): OrderedPlayPrompt => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return fail();
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,128}$/u.test(item.id) ||
      ids.has(item.id)
    )
      return fail();
    ids.add(item.id);
    const exact = (keys: string[]) =>
      Object.keys(item).length === keys.length &&
      keys.every((key) => Object.hasOwn(item, key));
    if (item.kind === "world" && exact(["id", "kind"])) {
      worlds++;
      return { id: item.id, kind: "world" };
    }
    if (
      item.kind === "user" &&
      exact(["id", "kind", "name", "enabled", "body"]) &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      /^[^\r\n\0]{1,160}$/u.test(item.name) &&
      typeof item.body === "string" &&
      typeof item.enabled === "boolean"
    )
      return {
        id: item.id,
        kind: "user",
        name: item.name,
        enabled: item.enabled,
        body: item.body,
      };
    const builtin = builtinPlayPrompts("en").find(
      (entry) => entry.id === item.builtin,
    );
    if (
      item.kind !== "builtin" ||
      !exact(["id", "kind", "builtin", "enabled"]) ||
      !builtin ||
      builtins.has(builtin.id) ||
      typeof item.enabled !== "boolean" ||
      (builtin.required && !item.enabled)
    )
      return fail();
    builtins.add(builtin.id);
    return {
      id: item.id,
      kind: "builtin",
      builtin: builtin.id,
      enabled: item.enabled,
    };
  });
  if (worlds !== 1 || !builtins.has("play.mechanics")) return fail();
  return entries;
}

/** Recognized v1 content becomes user text, never a locked builtin inferred from a path. */
export function migrateLegacyPlayPrompts(
  files: Record<string, string>,
  narrative: { path: string }[],
  excludedPaths: string[] = [],
): OrderedPlayPrompt[] {
  const document = parseDocument(files["frame.yaml"] ?? "", {
    uniqueKeys: true,
    strict: true,
  });
  const frame: unknown = document.toJS({ maxAliasCount: 0 });
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const roles = ["runtime_system", "author_instruction", "world_context"];
  if (
    document.errors.length ||
    document.warnings.length ||
    !record(frame) ||
    frame.format !== "narraeon.host-frame/v1" ||
    !record(frame.roles) ||
    Object.keys(frame.roles).length !== 3
  )
    throw new Error("Legacy host frame is invalid; repair it before migrating");
  const items: Record<string, { markdown?: string; include?: string }[]> = {};
  const runtime = new Set<string>();
  let worldInstructions = 0;
  let worldContext = 0;
  let coverage = 0;
  for (const role of roles) {
    items[role] = [];
    const roleItems: unknown = frame.roles[role];
    if (!Array.isArray(roleItems))
      throw new Error("Legacy host role must be an array");
    for (const item of roleItems as unknown[]) {
      if (!record(item) || Object.keys(item).length !== 1)
        throw new Error("Legacy host entry is invalid");
      if (role === "author_instruction" && typeof item.markdown === "string")
        items[role].push({ markdown: item.markdown });
      else if (
        role === "author_instruction" &&
        item.include === "world.instructions"
      ) {
        worldInstructions++;
        items[role].push({ include: item.include });
      } else if (role === "world_context" && item.include === "world.context") {
        worldContext++;
        items[role].push({ include: item.include });
      } else if (
        role === "world_context" &&
        item.builtin === "runtime.coverage"
      )
        coverage++;
      else if (
        role === "runtime_system" &&
        typeof item.builtin === "string" &&
        [
          "runtime.play-contract",
          "runtime.tool-contract",
          "runtime.operation-contract",
        ].includes(item.builtin) &&
        !runtime.has(item.builtin)
      )
        runtime.add(item.builtin);
      else throw new Error("Legacy host entry is unknown or misplaced");
    }
  }
  if (
    runtime.size !== 3 ||
    coverage !== 1 ||
    worldInstructions !== 1 ||
    worldContext !== 1
  )
    throw new Error(
      "Legacy host frame is missing or duplicates required includes",
    );
  const entries: OrderedPlayPrompt[] = [
    {
      id: "play.mechanics",
      kind: "builtin",
      builtin: "play.mechanics",
      enabled: true,
    },
  ];
  const used = new Set<string>(excludedPaths);
  const occurrences = new Map<string, number>();
  let world = false;
  const add = (path: string, enabled: boolean) => {
    if (!enabled && used.has(path)) return;
    const occurrence = occurrences.get(path) ?? 0;
    occurrences.set(path, occurrence + 1);
    used.add(path);
    const body = files[path];
    if (body === undefined) throw new Error(`Missing legacy prompt: ${path}`);
    entries.push({
      id: `legacy-${createHash("sha256").update(path).digest("hex").slice(0, 32)}-${occurrence}`,
      kind: "user",
      name: (
        /^#[ \t]+([^\r\n]+)$/mu.exec(body)?.[1]?.trim() ||
        path.replace(/^.*\//u, "").replace(/\.md$/u, "") ||
        "Prompt"
      ).slice(0, 160),
      enabled,
      body,
    });
  };
  for (const role of [
    "runtime_system",
    "author_instruction",
    "world_context",
  ]) {
    for (const item of items[role] ?? []) {
      if (item.markdown) add(item.markdown, true);
      if (item.include?.startsWith("world.") && !world) {
        entries.push({ id: "world", kind: "world" });
        world = true;
      }
    }
    if (role === "author_instruction")
      for (const prompt of narrative) add(prompt.path, true);
  }
  if (!world) entries.push({ id: "world", kind: "world" });
  for (const path of Object.keys(files).sort())
    if (
      (path.startsWith("blocks/") || path.startsWith("prompts/")) &&
      path.endsWith(".md")
    )
      add(path, false);
  return entries;
}
