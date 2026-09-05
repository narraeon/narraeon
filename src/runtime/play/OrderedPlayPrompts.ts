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
  const frame = parseDocument(files["frame.yaml"] ?? "").toJS() as {
    roles?: Record<string, { markdown?: string; include?: string }[]>;
  };
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
      name:
        /^#\s+(.+)$/mu.exec(body)?.[1] ??
        path.replace(/^.*\//u, "").replace(/\.md$/u, ""),
      enabled,
      body,
    });
  };
  for (const role of [
    "runtime_system",
    "author_instruction",
    "world_context",
  ]) {
    for (const item of frame.roles?.[role] ?? []) {
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
